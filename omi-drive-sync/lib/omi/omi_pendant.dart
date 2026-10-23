import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_blue_plus/flutter_blue_plus.dart';

import 'protocol.dart';

class OmiException implements Exception {
  final String message;
  OmiException(this.message);

  @override
  String toString() => message;
}

/// Result of one pull of the pendant's offline storage.
class DownloadResult {
  final int records;
  final bool complete;
  final String? error;

  /// The storage position after this transfer, when it ran to completion.
  final int? nextSeq;

  const DownloadResult({required this.records, required this.complete, this.error, this.nextSeq});
}

/// BLE connection to an Omi pendant, limited to what offline sync needs.
class OmiPendant {
  final BluetoothDevice device;

  late BluetoothCharacteristic _data;
  late BluetoothCharacteristic _control;
  BluetoothCharacteristic? _battery;
  BluetoothCharacteristic? _firmware;
  BluetoothCharacteristic? _timeSync;

  OmiPendant(this.device);

  factory OmiPendant.fromId(String remoteId) => OmiPendant(BluetoothDevice.fromId(remoteId));

  String get id => device.remoteId.str;

  /// Scans for nearby pendants. Omi advertises its audio service and an
  /// "Omi"/"Friend" name, depending on the firmware.
  static Future<void> startScan({Duration timeout = const Duration(seconds: 10)}) {
    return FlutterBluePlus.startScan(
      withServices: [Guid(OmiUuids.omiService)],
      withKeywords: const ['Omi', 'Friend'],
      timeout: timeout,
    );
  }

  Future<void> connect() async {
    // Personal use falls under the FlutterBluePlus nonprofit license; see README.
    await device.connect(license: License.nonprofit, timeout: const Duration(seconds: 20), mtu: 512);
    if (Platform.isAndroid) {
      try {
        await device.requestConnectionPriority(connectionPriorityRequest: ConnectionPriority.high);
      } catch (_) {
        // Only affects transfer speed.
      }
    }
    final services = await device.discoverServices();
    BluetoothCharacteristic? find(String service, String characteristic) {
      for (final s in services) {
        if (s.uuid != Guid(service)) continue;
        for (final c in s.characteristics) {
          if (c.uuid == Guid(characteristic)) return c;
        }
      }
      return null;
    }

    final data = find(OmiUuids.storageService, OmiUuids.storageData);
    final control = find(OmiUuids.storageService, OmiUuids.storageReadControl);
    if (data == null || control == null) {
      await disconnect();
      throw OmiException('This device has no Omi storage service. Is it an Omi pendant with an SD card?');
    }
    _data = data;
    _control = control;
    _battery = find(OmiUuids.batteryService, OmiUuids.batteryLevel);
    _firmware = find(OmiUuids.deviceInfoService, OmiUuids.firmwareRevision);
    _timeSync = find(OmiUuids.timeSyncService, OmiUuids.timeSyncWrite);
    await _data.setNotifyValue(true);
  }

  Future<void> disconnect() async {
    try {
      await device.disconnect();
    } catch (_) {}
  }

  Future<String?> readFirmwareVersion() async {
    final c = _firmware;
    if (c == null) return null;
    try {
      return String.fromCharCodes(await c.read()).replaceAll('\u0000', '').trim();
    } catch (_) {
      return null;
    }
  }

  Future<int?> readBatteryLevel() async {
    final c = _battery;
    if (c == null) return null;
    try {
      final v = await c.read();
      return v.isEmpty ? null : v[0];
    } catch (_) {
      return null;
    }
  }

  /// Sets the pendant's clock (u32 LE epoch seconds) so new recordings carry
  /// real timestamps. Returns false if the firmware has no time service.
  Future<bool> syncClock() async {
    final c = _timeSync;
    if (c == null) return false;
    final epoch = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    try {
      await c.write((ByteData(4)..setUint32(0, epoch, Endian.little)).buffer.asUint8List());
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<RingStatus?> readStatus() async => RingProtocol.parseStatus(await _control.read());

  Future<RingInfo> readInfo() async {
    final info = _awaitNotification(RingProtocol.parseInfo, const Duration(seconds: 5));
    await _data.write([RingProtocol.cmdInfo]);
    final result = await info;
    if (result == null) {
      throw OmiException('The pendant did not answer the storage info request. '
          'Offline sync needs Omi firmware 3.0.20 or newer.');
    }
    return result;
  }

  /// Tells the pendant it may free storage up to [seq]. The firmware already
  /// frees data as it is delivered; this confirms the final position.
  Future<void> advance(int seq) async {
    final ack = _awaitNotification(
      (v) => v.length >= 2 && v[0] == RingProtocol.notifyAck ? v[1] : null,
      const Duration(seconds: 5),
    );
    await _data.write(RingProtocol.encodeAdvance(seq));
    await ack;
  }

  Future<void> stopTransfer() async {
    try {
      await _data.write([RingProtocol.cmdStop]);
    } catch (_) {}
  }

  /// Streams every unread record from [info.readSeq] to [onRecord], in order.
  ///
  /// The firmware frees records as it delivers them, so [onRecord] must save
  /// each one durably before returning.
  Future<DownloadResult> download(
    RingInfo info, {
    required Future<void> Function(RingRecord record) onRecord,
    void Function(int received, int total)? onProgress,
  }) async {
    final total = info.unreadPackets;
    final reassembler = RecordReassembler();
    final done = Completer<DownloadResult>();
    var received = 0;
    var queue = Future<void>.value();
    Timer? idle;

    void finish(DownloadResult result) {
      idle?.cancel();
      // Let records already queued reach disk before reporting.
      queue.whenComplete(() {
        if (!done.isCompleted) done.complete(result);
      });
    }

    void armIdle() {
      idle?.cancel();
      idle = Timer(const Duration(seconds: 15), () {
        finish(DownloadResult(records: received, complete: false, error: 'The pendant stopped sending data.'));
      });
    }

    final sub = _data.onValueReceived.listen((value) {
      if (value.isEmpty || done.isCompleted) return;
      armIdle();
      switch (value[0]) {
        case RingProtocol.notifyReadBegin:
          final begin = RingProtocol.parseReadBegin(value);
          if (begin != null && begin.startSeq != info.readSeq) {
            finish(DownloadResult(records: received, complete: false, error: 'Transfer started at an unexpected position.'));
          }
        case RingProtocol.notifyAck:
          if (value.length >= 2 && value[1] != 0) {
            finish(DownloadResult(records: received, complete: false, error: 'The pendant refused the read (status ${value[1]}).'));
          }
        case RingProtocol.notifyDone:
          final d = RingProtocol.parseDone(value);
          final consistent = d != null && d.nextSeq == info.readSeq + received && reassembler.pendingBytes == 0;
          finish(DownloadResult(
            records: received,
            complete: d != null && d.isOk && consistent,
            nextSeq: d?.nextSeq,
            error: d == null || d.isOk ? null : 'The pendant ended the transfer with status ${d.status}.',
          ));
        case RingProtocol.notifyData:
          reassembler.append(value.sublist(1));
          for (final record in reassembler.drain()) {
            received++;
            final n = received;
            queue = queue.then((_) async {
              if (done.isCompleted) return;
              try {
                await onRecord(RingProtocol.parseRecord(record));
                onProgress?.call(n, total);
              } catch (e) {
                finish(DownloadResult(records: n - 1, complete: false, error: 'Could not save audio: $e'));
              }
            });
          }
      }
    });

    final connection = device.connectionState.listen((state) {
      if (state == BluetoothConnectionState.disconnected) {
        finish(DownloadResult(records: received, complete: false, error: 'The pendant disconnected.'));
      }
    });

    try {
      armIdle();
      await _data.write(RingProtocol.encodeRead(info.readSeq));
      final result = await done.future;
      if (!result.complete) await stopTransfer();
      return result;
    } finally {
      idle?.cancel();
      await sub.cancel();
      await connection.cancel();
    }
  }

  Future<T?> _awaitNotification<T>(T? Function(List<int>) parse, Duration timeout) async {
    final completer = Completer<T?>();
    final sub = _data.onValueReceived.listen((value) {
      final parsed = parse(value);
      if (parsed != null && !completer.isCompleted) completer.complete(parsed);
    });
    try {
      return await completer.future.timeout(timeout, onTimeout: () => null);
    } finally {
      await sub.cancel();
    }
  }
}
