import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:omi_drive_sync/omi/protocol.dart';

void main() {
  test('parses INFO notification', () {
    final bd = ByteData(31)
      ..setUint8(0, RingProtocol.notifyInfo)
      ..setUint64(1, 100, Endian.big)
      ..setUint64(9, 350, Endian.big)
      ..setUint32(17, 9000, Endian.big)
      ..setUint64(21, 3, Endian.big)
      ..setUint16(29, 444, Endian.big);
    final info = RingProtocol.parseInfo(bd.buffer.asUint8List())!;
    expect(info.readSeq, 100);
    expect(info.writeSeq, 350);
    expect(info.unreadPackets, 250);
    expect(info.capacityPackets, 9000);
    expect(info.droppedPackets, 3);
    expect(info.packetSize, 444);
    expect(RingProtocol.parseInfo([RingProtocol.notifyAck, 0]), isNull);
  });

  test('parses DONE, READ_BEGIN and status', () {
    final done = ByteData(10)
      ..setUint8(0, RingProtocol.notifyDone)
      ..setUint8(1, 0)
      ..setUint64(2, 777, Endian.big);
    final d = RingProtocol.parseDone(done.buffer.asUint8List())!;
    expect(d.isOk, isTrue);
    expect(d.nextSeq, 777);

    final begin = ByteData(13)
      ..setUint8(0, RingProtocol.notifyReadBegin)
      ..setUint64(1, 5, Endian.big)
      ..setUint32(9, 42, Endian.big);
    final b = RingProtocol.parseReadBegin(begin.buffer.asUint8List())!;
    expect(b.startSeq, 5);
    expect(b.packetCount, 42);

    final status = ByteData(16)
      ..setUint32(0, 1000, Endian.little)
      ..setUint32(4, 12, Endian.little)
      ..setUint32(8, 5000, Endian.little)
      ..setUint32(12, 1, Endian.little);
    final s = RingProtocol.parseStatus(status.buffer.asUint8List())!;
    expect(s.unreadPackets, 12);
    expect(s.rtcValid, isTrue);
  });

  test('encodes READ and ADVANCE as big-endian u64', () {
    expect(RingProtocol.encodeRead(0x0102030405060708), [0x11, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(RingProtocol.encodeAdvance(258), [0x12, 0, 0, 0, 0, 0, 0, 1, 2]);
  });

  test('audio payload parser skips padding and drops a trailing size byte', () {
    final payload = Uint8List(20);
    payload.setAll(0, [3, 0xa, 0xb, 0xc, 0, 0, 2, 0xd, 0xe]);
    // A size byte near the end whose frame does not fit.
    payload[17] = 5;
    payload[18] = 0x1;
    final frames = RingProtocol.parseAudioPayload(payload);
    expect(frames, [
      [0xa, 0xb, 0xc],
      [0xd, 0xe],
    ]);
  });

  test('record timestamp honours the uptime flag', () {
    final record = Uint8List(RingProtocol.recordSize);
    record.setAll(0, [0x65, 0x00, 0x00, 0x01]);
    expect(RingProtocol.parseRecord(record).epochSeconds, 0x65000001);
    record[0] = 0x80;
    expect(RingProtocol.parseRecord(record).epochSeconds, 0);
  });

  test('reassembler rebuilds records from unaligned chunks', () {
    final stream = Uint8List(RingProtocol.recordSize * 3 + 10);
    for (var i = 0; i < stream.length; i++) {
      stream[i] = i & 0xff;
    }
    final r = RecordReassembler();
    final out = <Uint8List>[];
    for (var i = 0; i < stream.length; i += 97) {
      r.append(stream.sublist(i, i + 97 > stream.length ? stream.length : i + 97));
      out.addAll(r.drain());
    }
    expect(out.length, 3);
    expect(out[1].first, RingProtocol.recordSize & 0xff);
    expect(r.pendingBytes, 10);
  });

  test('firmware version gate', () {
    expect(RingProtocol.isSupportedFirmware('3.0.20'), isTrue);
    expect(RingProtocol.isSupportedFirmware('v3.1.0-beta'), isTrue);
    expect(RingProtocol.isSupportedFirmware('4.0.0'), isTrue);
    expect(RingProtocol.isSupportedFirmware('3.0.19'), isFalse);
    expect(RingProtocol.isSupportedFirmware('2.9.99'), isFalse);
    expect(RingProtocol.isSupportedFirmware('Unknown'), isFalse);
  });
}
