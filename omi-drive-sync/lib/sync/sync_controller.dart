import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../audio/recording_splitter.dart';
import '../drive/drive_uploader.dart';
import '../omi/omi_pendant.dart';
import '../omi/protocol.dart';

enum SyncPhase { idle, connecting, downloading, uploading }

class UploadedRecording {
  final String name;
  final int bytes;
  final DateTime uploadedAt;

  const UploadedRecording({required this.name, required this.bytes, required this.uploadedAt});

  Map<String, Object> toJson() => {'name': name, 'bytes': bytes, 'at': uploadedAt.millisecondsSinceEpoch};

  factory UploadedRecording.fromJson(Map<String, dynamic> j) => UploadedRecording(
        name: j['name'] as String,
        bytes: j['bytes'] as int,
        uploadedAt: DateTime.fromMillisecondsSinceEpoch(j['at'] as int),
      );
}

/// Pulls offline audio from the pendant into local .ogg files, then uploads
/// every finished file to Google Drive. Local files are the hand-off point:
/// audio is only removed from the phone after Drive confirms the upload, so
/// a failed upload is simply retried on the next sync.
class SyncController extends ChangeNotifier {
  static const _kPendantId = 'pendant_id';
  static const _kPendantName = 'pendant_name';
  static const _kFolderName = 'drive_folder_name';
  static const _kFolderId = 'drive_folder_id';
  static const _kKeepLocal = 'keep_local_copy';
  static const _kHistory = 'upload_history';

  final DriveUploader drive = DriveUploader();
  late final SharedPreferences _prefs;
  late final Directory _pendingDir;
  late final Directory _keptDir;

  SyncPhase phase = SyncPhase.idle;
  String status = 'Ready';
  double? progress;
  String? pendantId;
  String? pendantName;
  String? firmwareVersion;
  int? batteryLevel;
  String folderName = 'Omi Recordings';
  bool keepLocalCopy = false;
  List<File> pending = [];
  List<UploadedRecording> history = [];
  final List<String> log = [];

  bool get busy => phase != SyncPhase.idle;
  GoogleSignInAccount? get account => drive.account;

  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    final docs = await getApplicationDocumentsDirectory();
    _pendingDir = Directory(p.join(docs.path, 'pending'));
    _keptDir = Directory(p.join(docs.path, 'uploaded'));
    await _pendingDir.create(recursive: true);
    await recoverPartialRecordings(_pendingDir);

    pendantId = _prefs.getString(_kPendantId);
    pendantName = _prefs.getString(_kPendantName);
    folderName = _prefs.getString(_kFolderName) ?? folderName;
    keepLocalCopy = _prefs.getBool(_kKeepLocal) ?? false;
    history = (_prefs.getStringList(_kHistory) ?? [])
        .map((s) => UploadedRecording.fromJson(jsonDecode(s) as Map<String, dynamic>))
        .toList();
    await _refreshPending();
    try {
      await drive.restoreSession();
    } catch (e) {
      _log('Google sign-in could not be restored: $e');
    }
    notifyListeners();
  }

  // ---- Settings ----

  Future<void> choosePendant(BluetoothDevice device, String name) async {
    pendantId = device.remoteId.str;
    pendantName = name.isEmpty ? 'Omi' : name;
    await _prefs.setString(_kPendantId, pendantId!);
    await _prefs.setString(_kPendantName, pendantName!);
    _log('Paired with $pendantName');
    notifyListeners();
  }

  Future<void> forgetPendant() async {
    pendantId = pendantName = firmwareVersion = batteryLevel = null;
    await _prefs.remove(_kPendantId);
    await _prefs.remove(_kPendantName);
    notifyListeners();
  }

  Future<void> setFolderName(String name) async {
    name = name.trim();
    if (name.isEmpty || name == folderName) return;
    folderName = name;
    await _prefs.setString(_kFolderName, name);
    await _prefs.remove(_kFolderId);
    notifyListeners();
  }

  Future<void> setKeepLocalCopy(bool keep) async {
    keepLocalCopy = keep;
    await _prefs.setBool(_kKeepLocal, keep);
    notifyListeners();
  }

  Future<void> signIn() async {
    try {
      final user = await drive.signIn();
      if (user != null) _log('Signed in to Google as ${user.email}');
    } catch (e) {
      _log('Google sign-in failed: $e');
    }
    notifyListeners();
  }

  Future<void> signOut() async {
    await drive.signOut();
    await _prefs.remove(_kFolderId);
    notifyListeners();
  }

  // ---- Sync ----

  /// Downloads new audio from the pendant, then uploads everything pending.
  Future<void> syncNow() async {
    if (busy) return;
    try {
      if (pendantId != null) await _downloadFromPendant();
      if (account != null) await _uploadPending();
      if (pendantId == null && account == null) _setStatus('Pair a pendant and sign in to Google to start.');
    } finally {
      phase = SyncPhase.idle;
      progress = null;
      notifyListeners();
    }
  }

  Future<void> uploadNow() async {
    if (busy) return;
    try {
      await _uploadPending();
    } finally {
      phase = SyncPhase.idle;
      progress = null;
      notifyListeners();
    }
  }

  Future<void> _downloadFromPendant() async {
    phase = SyncPhase.connecting;
    progress = null;
    _setStatus('Connecting to $pendantName…');

    if (FlutterBluePlus.adapterStateNow != BluetoothAdapterState.on) {
      if (Platform.isAndroid) {
        try {
          await FlutterBluePlus.turnOn();
        } catch (_) {}
      }
      // The adapter state is "unknown" for a moment after launch.
      await FlutterBluePlus.adapterState
          .firstWhere((s) => s == BluetoothAdapterState.on)
          .timeout(const Duration(seconds: 5), onTimeout: () => BluetoothAdapterState.off);
      if (FlutterBluePlus.adapterStateNow != BluetoothAdapterState.on) {
        _setStatus('Turn on Bluetooth to sync the pendant.');
        return;
      }
    }

    final pendant = OmiPendant.fromId(pendantId!);
    try {
      await pendant.connect();
      firmwareVersion = await pendant.readFirmwareVersion();
      batteryLevel = await pendant.readBatteryLevel();
      if (firmwareVersion != null && !RingProtocol.isSupportedFirmware(firmwareVersion)) {
        _setStatus('Firmware $firmwareVersion is too old. Update the pendant to 3.0.20+ in the Omi app.');
        return;
      }

      // Read the clock state before setting it: it describes the stored audio.
      final status = await pendant.readStatus();
      if (await pendant.syncClock() && status?.rtcValid == false) {
        _log('Set the pendant clock; new recordings will have exact times.');
      }
      final info = await pendant.readInfo();
      if (info.droppedPackets > 0) {
        _log('Note: the pendant overwrote ${info.droppedPackets} old packets before they were synced.');
      }
      if (info.unreadPackets <= 0) {
        _setStatus('No new audio on the pendant.');
        return;
      }

      phase = SyncPhase.downloading;
      progress = 0;
      _setStatus('Downloading ${info.unreadPackets} packets…');
      final rtcValid = status?.rtcValid ?? false;
      final splitter = RecordingSplitter(
        directory: _pendingDir,
        clockValid: rtcValid,
        // Without a clock, assume the audio ends now: ~5 Opus frames of 10 ms per record.
        fallbackStart: DateTime.now().subtract(Duration(milliseconds: info.unreadPackets * 50)),
      );

      final started = DateTime.now();
      DownloadResult result;
      try {
        result = await pendant.download(
          info,
          onRecord: splitter.add,
          onProgress: (done, total) {
            final p = total == 0 ? 1.0 : done / total;
            if (progress == null || p - progress! >= 0.005 || done == total) {
              progress = p.clamp(0.0, 1.0);
              notifyListeners();
            }
          },
        );
      } finally {
        await splitter.finish();
      }

      if (result.complete) {
        try {
          await pendant.advance(result.nextSeq!);
        } catch (e) {
          _log('Could not confirm storage release: $e');
        }
      }
      final files = splitter.finished;
      final secs = DateTime.now().difference(started).inSeconds;
      final summary = 'Downloaded ${files.length} recording(s) in ${secs}s';
      _setStatus(result.error == null ? summary : '$summary; stopped early: ${result.error}');
    } on OmiException catch (e) {
      _setStatus(e.message);
    } on FlutterBluePlusException catch (e) {
      _setStatus('Bluetooth error: ${e.description ?? e.code}. Is the pendant nearby and charged?');
    } catch (e) {
      _setStatus('Pendant sync failed: $e');
    } finally {
      await pendant.disconnect();
      await _refreshPending();
    }
  }

  Future<void> _uploadPending() async {
    await _refreshPending();
    if (pending.isEmpty) return;
    if (account == null) {
      _setStatus('Sign in to Google to upload ${pending.length} recording(s).');
      return;
    }
    phase = SyncPhase.uploading;
    try {
      final folderId = _prefs.getString(_kFolderId) ?? await drive.ensureFolder(folderName);
      await _prefs.setString(_kFolderId, folderId);

      final files = List.of(pending);
      for (var i = 0; i < files.length; i++) {
        final file = files[i];
        progress = i / files.length;
        _setStatus('Uploading ${i + 1} of ${files.length}: ${p.basename(file.path)}');
        final bytes = await file.length();
        try {
          await drive.upload(file, folderId);
        } on DriveException catch (e) {
          if (e.message.contains('(404)')) {
            // Folder was deleted in Drive; recreate it once.
            await _prefs.remove(_kFolderId);
            final fresh = await drive.ensureFolder(folderName);
            await _prefs.setString(_kFolderId, fresh);
            await drive.upload(file, fresh);
          } else {
            rethrow;
          }
        }
        await _afterUpload(file, bytes);
      }
      progress = 1;
      _setStatus('Uploaded ${files.length} recording(s) to “$folderName”.');
    } catch (e) {
      _setStatus('Upload failed, will retry next sync: $e');
    } finally {
      await _refreshPending();
    }
  }

  Future<void> _afterUpload(File file, int bytes) async {
    final name = p.basename(file.path);
    if (keepLocalCopy) {
      await _keptDir.create(recursive: true);
      await file.rename(p.join(_keptDir.path, name));
    } else {
      await file.delete();
    }
    history.insert(0, UploadedRecording(name: name, bytes: bytes, uploadedAt: DateTime.now()));
    if (history.length > 100) history.removeRange(100, history.length);
    await _prefs.setStringList(_kHistory, history.map((h) => jsonEncode(h.toJson())).toList());
    notifyListeners();
  }

  Future<void> _refreshPending() async {
    final files = await _pendingDir
        .list()
        .where((e) => e is File && e.path.endsWith('.ogg'))
        .cast<File>()
        .toList();
    files.sort((a, b) => a.path.compareTo(b.path));
    pending = files;
    notifyListeners();
  }

  void _setStatus(String message) {
    status = message;
    _log(message);
  }

  void _log(String message) {
    final t = DateTime.now();
    String two(int v) => v.toString().padLeft(2, '0');
    log.insert(0, '${two(t.hour)}:${two(t.minute)}:${two(t.second)}  $message');
    if (log.length > 200) log.removeLast();
    debugPrint(message);
    notifyListeners();
  }
}
