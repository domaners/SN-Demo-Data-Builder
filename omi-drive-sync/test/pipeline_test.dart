import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:omi_drive_sync/audio/ogg_opus_writer.dart';
import 'package:omi_drive_sync/audio/recording_splitter.dart';
import 'package:omi_drive_sync/omi/protocol.dart';
import 'package:path/path.dart' as p;

/// End-to-end check of the offline-sync pipeline with real Opus audio:
/// ffmpeg encodes a tone the way the pendant does (16 kHz mono, 10 ms
/// frames), the packets are packed into ring records exactly as the firmware
/// stores them, streamed in unaligned BLE-sized chunks, and the resulting
/// .ogg files must decode cleanly in ffmpeg with the right duration.
void main() {
  final hasFfmpeg = Process.runSync('which', ['ffmpeg']).exitCode == 0;

  late Directory tmp;
  setUp(() => tmp = Directory.systemTemp.createTempSync('omi_test'));
  tearDown(() => tmp.deleteSync(recursive: true));

  test('ogg crc matches the reference value', () {
    // CRC of "OggS" with the Ogg polynomial, computed independently.
    expect(oggCrc(Uint8List.fromList('OggS'.codeUnits)), 0x5fb0a94f);
  });

  test('opus TOC durations', () {
    expect(opusPacketSamples48k(Uint8List.fromList([0xf8])), 960); // CELT 20 ms
    expect(opusPacketSamples48k(Uint8List.fromList([0xf0])), 480); // CELT 10 ms
    expect(opusPacketSamples48k(Uint8List.fromList([0x08])), 960); // SILK 20 ms
    expect(opusPacketSamples48k(Uint8List.fromList([0x09])), 960 * 2); // two frames
    expect(opusPacketSamples48k(Uint8List.fromList([0x0b, 0x03])), 960 * 3); // code 3, three frames
  });

  test('pendant records become playable, correctly split .ogg files', () async {
    final source = p.join(tmp.path, 'source.ogg');
    final enc = await Process.run('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=16000',
      '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-frame_duration', '10', '-application', 'voip', source,
    ]);
    expect(enc.exitCode, 0, reason: enc.stderr.toString());
    final packets = _readOggPackets(File(source).readAsBytesSync()).skip(2).toList();
    expect(packets.length, greaterThan(500));

    // Two sessions 10 minutes apart: first half, then second half.
    final start = DateTime.utc(2026, 10, 1, 9, 0, 0).millisecondsSinceEpoch ~/ 1000;
    final half = packets.length ~/ 2;
    final records = [
      ..._packRecords(packets.sublist(0, half), start),
      ..._packRecords(packets.sublist(half), start + 600),
    ];

    final stream = BytesBuilder();
    for (final r in records) {
      stream.add(r);
    }
    final bytes = stream.toBytes();

    final reassembler = RecordReassembler();
    final out = Directory(p.join(tmp.path, 'out'));
    final splitter = RecordingSplitter(directory: out, clockValid: true, fallbackStart: DateTime.now());
    final rng = Random(1);
    var offset = 0;
    var frameCount = 0;
    while (offset < bytes.length) {
      final n = min(1 + rng.nextInt(243), bytes.length - offset); // MTU-sized, unaligned
      reassembler.append(bytes.sublist(offset, offset + n));
      offset += n;
      for (final rec in reassembler.drain()) {
        final parsed = RingProtocol.parseRecord(rec);
        frameCount += parsed.frames.length;
        await splitter.add(parsed);
      }
    }
    final files = await splitter.finish();

    expect(reassembler.pendingBytes, 0);
    expect(frameCount, packets.length, reason: 'every Opus frame survives packing and parsing');
    expect(files.length, 2);
    expect(files.every((f) => f.path.endsWith('.ogg')), isTrue);
    expect(out.listSync().whereType<File>().where((f) => f.path.endsWith('.part')), isEmpty);

    final names = files.map((f) => p.basename(f.path)).toList();
    final local = DateTime.fromMillisecondsSinceEpoch(start * 1000);
    expect(names.first, startsWith('omi_${local.year}-'));
    expect(names.first == names.last, isFalse);

    if (!hasFfmpeg) return;
    for (final f in files) {
      final decode = await Process.run('ffmpeg', ['-v', 'error', '-i', f.path, '-f', 'null', '-']);
      expect(decode.exitCode, 0);
      expect(decode.stderr.toString().trim(), isEmpty, reason: 'ffmpeg reported: ${decode.stderr}');
      final probe = await Process.run('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'default=nw=1', f.path,
      ]);
      final info = probe.stdout.toString();
      expect(info, contains('codec_name=opus'));
      expect(info, contains('channels=1'));
      final duration = double.parse(RegExp(r'duration=([\d.]+)').firstMatch(info)!.group(1)!);
      expect(duration, closeTo(3.0, 0.1), reason: info);
    }
  }, skip: hasFfmpeg ? false : 'ffmpeg with libopus not installed');

  test('without a clock, recordings are one file starting at the fallback time', () async {
    final out = Directory(p.join(tmp.path, 'out'));
    final fallback = DateTime(2026, 1, 2, 3, 4, 5);
    final splitter = RecordingSplitter(directory: out, clockValid: false, fallbackStart: fallback);
    final frame = Uint8List.fromList([0xf0, 1, 2, 3]); // CELT 10 ms
    for (var i = 0; i < 300; i++) {
      await splitter.add(RingRecord(epochSeconds: i * 1000, frames: [frame, frame, frame, frame, frame]));
    }
    final files = await splitter.finish();
    expect(files.map((f) => p.basename(f.path)), ['omi_2026-01-02_03-04-05.ogg']);
  });

  test('interrupted recordings are recovered', () async {
    final dir = Directory(p.join(tmp.path, 'pending'))..createSync();
    File(p.join(dir.path, 'a.ogg.part')).writeAsBytesSync([1, 2, 3]);
    File(p.join(dir.path, 'b.ogg.part')).writeAsBytesSync([]);
    await recoverPartialRecordings(dir);
    expect(dir.listSync().map((e) => p.basename(e.path)), ['a.ogg']);
  });
}

/// Packs Opus frames into 444-byte ring records the way the firmware does:
/// [timestamp:4 BE] then [size][frame]... in 440 bytes, zero padded.
List<Uint8List> _packRecords(List<Uint8List> frames, int epochSeconds) {
  final records = <Uint8List>[];
  var i = 0;
  var elapsedMs = 0;
  while (i < frames.length) {
    final rec = Uint8List(RingProtocol.recordSize);
    final ts = epochSeconds + elapsedMs ~/ 1000;
    rec.setAll(0, [(ts >> 24) & 0xff, (ts >> 16) & 0xff, (ts >> 8) & 0xff, ts & 0xff]);
    var o = RingProtocol.timestampBytes;
    // Strict `<` leaves at least one byte, matching the parser's boundary rule.
    while (i < frames.length && o + 1 + frames[i].length < RingProtocol.recordSize) {
      rec[o] = frames[i].length;
      rec.setAll(o + 1, frames[i]);
      o += 1 + frames[i].length;
      i++;
      elapsedMs += 10;
    }
    records.add(rec);
  }
  return records;
}

/// Minimal Ogg demuxer for the test fixture.
List<Uint8List> _readOggPackets(Uint8List data) {
  final packets = <Uint8List>[];
  final current = BytesBuilder();
  var pos = 0;
  while (pos + 27 <= data.length) {
    expect(String.fromCharCodes(data.sublist(pos, pos + 4)), 'OggS');
    final segments = data[pos + 26];
    final lacing = data.sublist(pos + 27, pos + 27 + segments);
    var body = pos + 27 + segments;
    for (final l in lacing) {
      current.add(data.sublist(body, body + l));
      body += l;
      if (l < 255) packets.add(current.takeBytes());
    }
    pos = body;
  }
  return packets;
}
