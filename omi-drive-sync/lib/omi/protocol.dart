import 'dart:typed_data';

/// Wire format of the Omi pendant's offline-storage service, ring-buffer
/// protocol (firmware 3.0.20+). Mirrors the official Omi app
/// (app/lib/services/devices/ring_protocol.dart) and firmware
/// (omi/firmware/omi/src/lib/core/storage.c).
///
/// Status read (storage read-control characteristic), 4 x u32 LE:
///   [used_bytes][unread_packets][free_bytes][rtc_valid]
///
/// Notifications on the storage data characteristic, one opcode byte + payload
/// (multi-byte fields big-endian):
///   0x01 ACK         [status]
///   0x02 INFO        [read_seq:u64][write_seq:u64][capacity:u32][dropped:u64][packet_size:u16]...
///   0x03 DATA        [raw bytes]  (not aligned to record boundaries)
///   0x04 DONE        [status][next_seq:u64]
///   0x05 READ_BEGIN  [start_seq:u64][packet_count:u32]
///
/// Each stored record is 444 bytes: [timestamp:u32 BE][440 bytes audio], where
/// the audio is packed Opus frames [size:1][frame:size]... with zero padding.
class OmiUuids {
  static const omiService = '19b10000-e8f2-537e-4f6c-d104768a1214';
  static const audioCodec = '19b10002-e8f2-537e-4f6c-d104768a1214';

  static const storageService = '30295780-4301-eabd-2904-2849adfeae43';
  static const storageData = '30295781-4301-eabd-2904-2849adfeae43';
  static const storageReadControl = '30295782-4301-eabd-2904-2849adfeae43';

  static const batteryService = '0000180f-0000-1000-8000-00805f9b34fb';
  static const batteryLevel = '00002a19-0000-1000-8000-00805f9b34fb';

  static const timeSyncService = '19b10030-e8f2-537e-4f6c-d104768a1214';
  static const timeSyncWrite = '19b10031-e8f2-537e-4f6c-d104768a1214';

  static const deviceInfoService = '0000180a-0000-1000-8000-00805f9b34fb';
  static const firmwareRevision = '00002a26-0000-1000-8000-00805f9b34fb';
}

class RingProtocol {
  static const int recordSize = 444;
  static const int timestampBytes = 4;

  static const int notifyAck = 0x01;
  static const int notifyInfo = 0x02;
  static const int notifyData = 0x03;
  static const int notifyDone = 0x04;
  static const int notifyReadBegin = 0x05;

  static const int cmdStop = 0x03;
  static const int cmdInfo = 0x10;
  static const int cmdRead = 0x11;
  static const int cmdAdvance = 0x12;

  /// Bit 31 of a record timestamp marks seconds since boot rather than epoch.
  static const int uptimeFlag = 0x80000000;

  /// True for firmware versions that speak the ring-buffer protocol.
  static bool isSupportedFirmware(String? version) {
    if (version == null) return false;
    final match = RegExp(r'(\d+)\.(\d+)\.(\d+)').firstMatch(version);
    if (match == null) return false;
    final parts = [for (var i = 1; i <= 3; i++) int.parse(match.group(i)!)];
    if (parts[0] != 3) return parts[0] > 3;
    if (parts[1] != 0) return parts[1] > 0;
    return parts[2] >= 20;
  }

  static RingStatus? parseStatus(List<int> value) {
    if (value.length < 16) return null;
    final bd = _view(value);
    return RingStatus(
      usedBytes: bd.getUint32(0, Endian.little),
      unreadPackets: bd.getUint32(4, Endian.little),
      freeBytes: bd.getUint32(8, Endian.little),
      rtcValid: bd.getUint32(12, Endian.little) != 0,
    );
  }

  static RingInfo? parseInfo(List<int> value) {
    if (value.length < 31 || value[0] != notifyInfo) return null;
    final bd = _view(value);
    return RingInfo(
      readSeq: bd.getUint64(1, Endian.big),
      writeSeq: bd.getUint64(9, Endian.big),
      capacityPackets: bd.getUint32(17, Endian.big),
      droppedPackets: bd.getUint64(21, Endian.big),
      packetSize: bd.getUint16(29, Endian.big),
    );
  }

  static DoneNotification? parseDone(List<int> value) {
    if (value.length < 10 || value[0] != notifyDone) return null;
    final bd = _view(value);
    return DoneNotification(status: value[1], nextSeq: bd.getUint64(2, Endian.big));
  }

  static ReadBegin? parseReadBegin(List<int> value) {
    if (value.length < 13 || value[0] != notifyReadBegin) return null;
    final bd = _view(value);
    return ReadBegin(startSeq: bd.getUint64(1, Endian.big), packetCount: bd.getUint32(9, Endian.big));
  }

  static Uint8List encodeRead(int startSeq) {
    final bd = ByteData(9)
      ..setUint8(0, cmdRead)
      ..setUint64(1, startSeq, Endian.big);
    return bd.buffer.asUint8List();
  }

  static Uint8List encodeAdvance(int newReadSeq) {
    final bd = ByteData(9)
      ..setUint8(0, cmdAdvance)
      ..setUint64(1, newReadSeq, Endian.big);
    return bd.buffer.asUint8List();
  }

  /// Splits a 444-byte record into its timestamp and Opus frames.
  static RingRecord parseRecord(List<int> record) {
    final raw = (record[0] << 24) | (record[1] << 16) | (record[2] << 8) | record[3];
    final epochSeconds = raw & uptimeFlag != 0 ? 0 : raw;
    return RingRecord(epochSeconds: epochSeconds, frames: parseAudioPayload(record.sublist(timestampBytes)));
  }

  /// Parses [size:1][frame:size]... with zero bytes as padding. At the end of
  /// a block the firmware may write a trailing size byte whose frame continues
  /// in the next record; that byte and anything after it are dropped (same
  /// `>=` boundary rule as the official app).
  static List<Uint8List> parseAudioPayload(List<int> audio) {
    final frames = <Uint8List>[];
    var offset = 0;
    while (offset < audio.length - 1) {
      final size = audio[offset];
      if (size == 0) {
        offset += 1;
        continue;
      }
      if (offset + 1 + size >= audio.length) break;
      frames.add(Uint8List.fromList(audio.sublist(offset + 1, offset + 1 + size)));
      offset += size + 1;
    }
    return frames;
  }

  static ByteData _view(List<int> value) => ByteData.sublistView(Uint8List.fromList(value));
}

class RingStatus {
  final int usedBytes;
  final int unreadPackets;
  final int freeBytes;
  final bool rtcValid;

  const RingStatus({
    required this.usedBytes,
    required this.unreadPackets,
    required this.freeBytes,
    required this.rtcValid,
  });
}

class RingInfo {
  final int readSeq;
  final int writeSeq;
  final int capacityPackets;
  final int droppedPackets;
  final int packetSize;

  const RingInfo({
    required this.readSeq,
    required this.writeSeq,
    required this.capacityPackets,
    required this.droppedPackets,
    required this.packetSize,
  });

  int get unreadPackets => writeSeq - readSeq;
}

class DoneNotification {
  final int status;
  final int nextSeq;

  const DoneNotification({required this.status, required this.nextSeq});

  bool get isOk => status == 0;
}

class ReadBegin {
  final int startSeq;
  final int packetCount;

  const ReadBegin({required this.startSeq, required this.packetCount});
}

class RingRecord {
  /// Epoch seconds, or 0 when the pendant's clock was not set.
  final int epochSeconds;
  final List<Uint8List> frames;

  const RingRecord({required this.epochSeconds, required this.frames});
}

/// Reassembles unaligned DATA payloads into whole 444-byte records.
class RecordReassembler {
  final BytesBuilder _buffer = BytesBuilder(copy: false);

  void append(List<int> bytes) => _buffer.add(bytes);

  List<Uint8List> drain() {
    if (_buffer.length < RingProtocol.recordSize) return const [];
    final bytes = _buffer.takeBytes();
    final count = bytes.length ~/ RingProtocol.recordSize;
    final records = [
      for (var i = 0; i < count; i++)
        Uint8List.sublistView(bytes, i * RingProtocol.recordSize, (i + 1) * RingProtocol.recordSize),
    ];
    final rest = count * RingProtocol.recordSize;
    if (rest < bytes.length) _buffer.add(Uint8List.sublistView(bytes, rest));
    return records;
  }

  int get pendingBytes => _buffer.length;
}
