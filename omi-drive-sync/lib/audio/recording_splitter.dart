import 'dart:io';

import 'package:path/path.dart' as p;

import '../omi/protocol.dart';
import 'ogg_opus_writer.dart';

/// Turns the pendant's stream of ring records into separate .ogg recordings,
/// starting a new file when the pendant's timestamps show a pause, or when a
/// file reaches [maxLength].
///
/// Files are written as `<name>.ogg.part` and renamed to `<name>.ogg` once
/// closed, so the upload queue only ever sees finished files.
class RecordingSplitter {
  final Directory directory;
  final bool clockValid;
  final DateTime fallbackStart;
  final Duration maxGap;
  final Duration maxLength;

  OggOpusWriter? _writer;
  File? _partFile;
  DateTime? _currentStart;
  int? _lastEpoch;
  final List<File> _finished = [];

  /// Where the next clockless recording starts: right after the previous one.
  DateTime? _fallbackCursor;

  RecordingSplitter({
    required this.directory,
    required this.clockValid,
    required this.fallbackStart,
    this.maxGap = const Duration(seconds: 60),
    this.maxLength = const Duration(minutes: 60),
  });

  List<File> get finished => List.unmodifiable(_finished);

  Future<void> add(RingRecord record) async {
    if (record.frames.isEmpty) return;
    final epoch = clockValid && record.epochSeconds > 0 ? record.epochSeconds : null;

    final writer = _writer;
    if (writer != null) {
      final last = _lastEpoch;
      final paused = epoch != null && last != null && (epoch - last > maxGap.inSeconds || epoch < last - 5);
      if (paused || writer.duration >= maxLength) await _closeCurrent();
    }

    if (_writer == null) {
      await _open(epoch != null
          ? DateTime.fromMillisecondsSinceEpoch(epoch * 1000)
          : _fallbackCursor ?? fallbackStart);
    }

    for (final frame in record.frames) {
      _writer!.addPacket(frame);
    }
    if (epoch != null) _lastEpoch = epoch;
  }

  /// Closes the open recording, if any, and returns every finished file.
  Future<List<File>> finish() async {
    await _closeCurrent();
    return finished;
  }

  Future<void> _open(DateTime start) async {
    await directory.create(recursive: true);
    final base = 'omi_${_stamp(start)}';
    var name = '$base.ogg';
    for (var i = 2; File(p.join(directory.path, name)).existsSync() ||
        File(p.join(directory.path, '$name.part')).existsSync(); i++) {
      name = '${base}_$i.ogg';
    }
    _partFile = File(p.join(directory.path, '$name.part'));
    _currentStart = start;
    _writer = await OggOpusWriter.create(
      _partFile!,
      tags: {
        'TITLE': 'Omi recording ${_stamp(start)}',
        'DATE': start.toUtc().toIso8601String(),
        if (!clockValid) 'COMMENT': 'Start time estimated; the pendant clock was not set',
      },
    );
  }

  Future<void> _closeCurrent() async {
    final writer = _writer;
    final part = _partFile;
    if (writer == null || part == null) return;
    _fallbackCursor = _currentStart!.add(writer.duration);
    await writer.close();
    _finished.add(await part.rename(part.path.substring(0, part.path.length - '.part'.length)));
    _writer = null;
    _partFile = null;
    _currentStart = null;
    _lastEpoch = null;
  }

  static String _stamp(DateTime t) {
    final l = t.toLocal();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${l.year}-${two(l.month)}-${two(l.day)}_${two(l.hour)}-${two(l.minute)}-${two(l.second)}';
  }
}

/// Renames `.part` files left by an interrupted sync so their audio is kept.
/// They lack the end-of-stream page, which players tolerate.
Future<void> recoverPartialRecordings(Directory directory) async {
  if (!await directory.exists()) return;
  await for (final entity in directory.list()) {
    if (entity is File && entity.path.endsWith('.ogg.part')) {
      if (await entity.length() == 0) {
        await entity.delete();
      } else {
        await entity.rename(entity.path.substring(0, entity.path.length - '.part'.length));
      }
    }
  }
}
