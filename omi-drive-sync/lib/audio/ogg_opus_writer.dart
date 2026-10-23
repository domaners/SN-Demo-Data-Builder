import 'dart:io';
import 'dart:typed_data';

/// Streams raw Opus packets into an Ogg Opus file (RFC 7845) without
/// re-encoding, so the pendant's audio is saved bit-for-bit and plays in any
/// player that supports .ogg/.opus.
class OggOpusWriter {
  static const int _maxSegmentsPerPage = 255;

  /// Packets per page; ~1 s of audio at the pendant's 10 ms frames.
  static const int _packetsPerPage = 100;

  final RandomAccessFile _file;
  final int _serial;
  int _pageSequence = 0;
  int _granule = 0;
  final List<Uint8List> _pending = [];
  int _pendingSegments = 0;
  bool _closed = false;

  /// Total audio written so far, in 48 kHz samples (Ogg Opus granule units).
  int get samples48k => _granule + _pending.fold(0, (sum, p) => sum + opusPacketSamples48k(p));

  Duration get duration => Duration(microseconds: samples48k * 1000000 ~/ 48000);

  OggOpusWriter._(this._file, this._serial);

  static Future<OggOpusWriter> create(
    File file, {
    int inputSampleRate = 16000,
    int channels = 1,
    Map<String, String> tags = const {},
  }) async {
    final raf = await file.open(mode: FileMode.write);
    final writer = OggOpusWriter._(raf, DateTime.now().microsecondsSinceEpoch & 0x7fffffff);
    writer._writePage([_opusHead(inputSampleRate, channels)], granule: 0, headerType: 0x02);
    writer._writePage([_opusTags(tags)], granule: 0, headerType: 0x00);
    return writer;
  }

  void addPacket(Uint8List packet) {
    if (_closed) throw StateError('writer is closed');
    if (packet.isEmpty) return;
    final segments = packet.length ~/ 255 + 1;
    if (_pendingSegments + segments > _maxSegmentsPerPage) _flushPage();
    _pending.add(packet);
    _pendingSegments += segments;
    if (_pending.length >= _packetsPerPage) _flushPage();
  }

  /// Writes buffered packets to disk so a crash loses at most one page.
  void flush() {
    if (_pending.isNotEmpty) _flushPage();
    _file.flushSync();
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    // The end-of-stream flag goes on the final page; an empty stream still
    // gets one so the file is well-formed.
    _flushPage(endOfStream: true);
    await _file.flush();
    await _file.close();
  }

  void _flushPage({bool endOfStream = false}) {
    for (final p in _pending) {
      _granule += opusPacketSamples48k(p);
    }
    _writePage(_pending, granule: _granule, headerType: endOfStream ? 0x04 : 0x00);
    _pending.clear();
    _pendingSegments = 0;
  }

  void _writePage(List<Uint8List> packets, {required int granule, required int headerType}) {
    final lacing = <int>[];
    for (final p in packets) {
      for (var n = p.length; ; n -= 255) {
        if (n < 255) {
          lacing.add(n);
          break;
        }
        lacing.add(255);
      }
    }
    final bodyLength = packets.fold(0, (sum, p) => sum + p.length);
    final page = Uint8List(27 + lacing.length + bodyLength);
    final bd = ByteData.sublistView(page);
    page.setAll(0, 'OggS'.codeUnits);
    bd.setUint8(4, 0);
    bd.setUint8(5, headerType);
    bd.setInt64(6, granule, Endian.little);
    bd.setUint32(14, _serial, Endian.little);
    bd.setUint32(18, _pageSequence++, Endian.little);
    bd.setUint8(26, lacing.length);
    page.setAll(27, lacing);
    var offset = 27 + lacing.length;
    for (final p in packets) {
      page.setAll(offset, p);
      offset += p.length;
    }
    bd.setUint32(22, oggCrc(page), Endian.little);
    _file.writeFromSync(page);
  }

  static Uint8List _opusHead(int inputSampleRate, int channels) {
    final bd = ByteData(19);
    final bytes = bd.buffer.asUint8List()..setAll(0, 'OpusHead'.codeUnits);
    bd.setUint8(8, 1); // version
    bd.setUint8(9, channels);
    bd.setUint16(10, 0, Endian.little); // pre-skip
    bd.setUint32(12, inputSampleRate, Endian.little);
    bd.setInt16(16, 0, Endian.little); // output gain
    bd.setUint8(18, 0); // channel mapping family
    return bytes;
  }

  static Uint8List _opusTags(Map<String, String> tags) {
    final builder = BytesBuilder();
    void u32(int v) => builder.add((ByteData(4)..setUint32(0, v, Endian.little)).buffer.asUint8List());
    void str(String s) {
      final b = Uint8List.fromList(s.codeUnits);
      u32(b.length);
      builder.add(b);
    }

    builder.add('OpusTags'.codeUnits);
    str('omi-drive-sync');
    u32(tags.length);
    tags.forEach((k, v) => str('$k=$v'));
    return builder.toBytes();
  }
}

/// Number of 48 kHz samples in an Opus packet, from its TOC byte (RFC 6716 §3.1).
int opusPacketSamples48k(Uint8List packet) {
  if (packet.isEmpty) return 0;
  final toc = packet[0];
  final config = toc >> 3;
  final int frameSamples;
  if (config < 12) {
    frameSamples = const [480, 960, 1920, 2880][config % 4]; // SILK 10/20/40/60 ms
  } else if (config < 16) {
    frameSamples = const [480, 960][config % 2]; // Hybrid 10/20 ms
  } else {
    frameSamples = const [120, 240, 480, 960][config % 4]; // CELT 2.5/5/10/20 ms
  }
  final int frameCount;
  switch (toc & 0x03) {
    case 0:
      frameCount = 1;
    case 1:
    case 2:
      frameCount = 2;
    default:
      frameCount = packet.length > 1 ? packet[1] & 0x3f : 0;
  }
  return frameSamples * frameCount;
}

final Uint32List _crcTable = () {
  final table = Uint32List(256);
  for (var i = 0; i < 256; i++) {
    var r = i << 24;
    for (var j = 0; j < 8; j++) {
      r = (r & 0x80000000) != 0 ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    }
    table[i] = r & 0xffffffff;
  }
  return table;
}();

/// Ogg page checksum: CRC-32, polynomial 0x04c11db7, no reflection, init 0.
int oggCrc(Uint8List data) {
  var crc = 0;
  for (final b in data) {
    crc = ((crc << 8) & 0xffffffff) ^ _crcTable[((crc >> 24) & 0xff) ^ b];
  }
  return crc;
}
