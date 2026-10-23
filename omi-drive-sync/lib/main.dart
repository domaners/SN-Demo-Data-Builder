import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

import 'omi/omi_pendant.dart';
import 'sync/sync_controller.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const OmiDriveSyncApp());
}

class OmiDriveSyncApp extends StatelessWidget {
  const OmiDriveSyncApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Omi Drive Sync',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      darkTheme: ThemeData(colorSchemeSeed: Colors.indigo, brightness: Brightness.dark, useMaterial3: true),
      home: const HomePage(),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final SyncController _sync = SyncController();
  late final AppLifecycleListener _lifecycle;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _sync.addListener(_onChange);
    // Sync whenever the app comes to the foreground.
    _lifecycle = AppLifecycleListener(onResume: () => _sync.syncNow());
    _sync.init().then((_) {
      setState(() => _ready = true);
      _sync.syncNow();
    });
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    _sync.removeListener(_onChange);
    super.dispose();
  }

  void _onChange() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    if (!_ready) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    return Scaffold(
      appBar: AppBar(
        title: const Text('Omi Drive Sync'),
        actions: [IconButton(icon: const Icon(Icons.settings), onPressed: _openSettings)],
      ),
      body: RefreshIndicator(
        onRefresh: _sync.syncNow,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _pendantCard(),
            const SizedBox(height: 12),
            _driveCard(),
            const SizedBox(height: 12),
            _syncCard(),
            const SizedBox(height: 12),
            _historyCard(),
            const SizedBox(height: 12),
            _logCard(),
          ],
        ),
      ),
    );
  }

  Widget _pendantCard() {
    final paired = _sync.pendantId != null;
    final details = [
      if (_sync.firmwareVersion != null) 'Firmware ${_sync.firmwareVersion}',
      if (_sync.batteryLevel != null) 'Battery ${_sync.batteryLevel}%',
    ].join(' · ');
    return Card(
      child: ListTile(
        leading: const Icon(Icons.mic),
        title: Text(paired ? _sync.pendantName! : 'No pendant paired'),
        subtitle: Text(paired ? (details.isEmpty ? _sync.pendantId! : details) : 'Find your Omi pendant over Bluetooth'),
        trailing: paired
            ? TextButton(onPressed: _sync.busy ? null : _sync.forgetPendant, child: const Text('Forget'))
            : FilledButton(onPressed: _choosePendant, child: const Text('Find')),
      ),
    );
  }

  Widget _driveCard() {
    final account = _sync.account;
    return Card(
      child: ListTile(
        leading: const Icon(Icons.add_to_drive),
        title: Text(account?.email ?? 'Not signed in'),
        subtitle: Text(account == null ? 'Sign in to save recordings to Google Drive' : 'Saving to “${_sync.folderName}”'),
        trailing: account == null
            ? FilledButton(onPressed: _sync.signIn, child: const Text('Sign in'))
            : TextButton(onPressed: _sync.busy ? null : _sync.signOut, child: const Text('Sign out')),
      ),
    );
  }

  Widget _syncCard() {
    final pendingCount = _sync.pending.length;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(_sync.status, style: Theme.of(context).textTheme.bodyLarge),
            if (_sync.busy) ...[
              const SizedBox(height: 12),
              LinearProgressIndicator(value: _sync.progress),
            ],
            const SizedBox(height: 12),
            Text('$pendingCount recording(s) waiting to upload',
                style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    onPressed: _sync.busy ? null : _sync.syncNow,
                    icon: const Icon(Icons.sync),
                    label: const Text('Sync now'),
                  ),
                ),
                if (pendingCount > 0) ...[
                  const SizedBox(width: 8),
                  OutlinedButton(
                    onPressed: _sync.busy || _sync.account == null ? null : _sync.uploadNow,
                    child: const Text('Upload only'),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _historyCard() {
    final items = _sync.history.take(20).toList();
    return Card(
      child: ExpansionTile(
        leading: const Icon(Icons.cloud_done),
        title: Text('Uploaded (${_sync.history.length})'),
        children: [
          if (items.isEmpty) const ListTile(title: Text('Nothing uploaded yet')),
          for (final h in items)
            ListTile(
              dense: true,
              title: Text(h.name),
              subtitle: Text('${(h.bytes / 1024).toStringAsFixed(0)} KB · uploaded ${_formatTime(h.uploadedAt)}'),
            ),
        ],
      ),
    );
  }

  Widget _logCard() {
    return Card(
      child: ExpansionTile(
        leading: const Icon(Icons.list_alt),
        title: const Text('Activity log'),
        children: [
          for (final line in _sync.log.take(50))
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(line, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
              ),
            ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }

  Future<void> _choosePendant() async {
    final chosen = await showModalBottomSheet<ScanResult>(context: context, builder: (_) => const _ScanSheet());
    if (chosen == null) return;
    final name = chosen.device.advName.isNotEmpty ? chosen.device.advName : chosen.device.platformName;
    await _sync.choosePendant(chosen.device, name);
    unawaited(_sync.syncNow());
  }

  Future<void> _openSettings() async {
    final folder = TextEditingController(text: _sync.folderName);
    await showDialog<void>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Settings'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: folder,
                decoration: const InputDecoration(labelText: 'Google Drive folder'),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Keep a copy on this phone'),
                value: _sync.keepLocalCopy,
                onChanged: (v) async {
                  await _sync.setKeepLocalCopy(v);
                  setDialogState(() {});
                },
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () {
                _sync.setFolderName(folder.text);
                Navigator.pop(context);
              },
              child: const Text('Done'),
            ),
          ],
        ),
      ),
    );
    folder.dispose();
  }

  static String _formatTime(DateTime t) {
    String two(int v) => v.toString().padLeft(2, '0');
    return '${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}';
  }
}

class _ScanSheet extends StatefulWidget {
  const _ScanSheet();

  @override
  State<_ScanSheet> createState() => _ScanSheetState();
}

class _ScanSheetState extends State<_ScanSheet> {
  StreamSubscription<List<ScanResult>>? _results;
  List<ScanResult> _found = [];
  String? _error;

  @override
  void initState() {
    super.initState();
    _results = FlutterBluePlus.scanResults.listen((r) => setState(() => _found = r));
    OmiPendant.startScan().catchError((Object e) => setState(() => _error = '$e'));
  }

  @override
  void dispose() {
    _results?.cancel();
    FlutterBluePlus.stopScan();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const ListTile(
            title: Text('Nearby pendants'),
            subtitle: Text('Close the official Omi app first: a pendant talks to one phone app at a time.'),
          ),
          StreamBuilder<bool>(
            stream: FlutterBluePlus.isScanning,
            builder: (context, snap) => snap.data == true ? const LinearProgressIndicator() : const SizedBox(height: 4),
          ),
          if (_error != null) ListTile(title: Text(_error!, style: const TextStyle(color: Colors.red))),
          if (_found.isEmpty && _error == null) const ListTile(title: Text('Searching…')),
          for (final r in _found)
            ListTile(
              leading: const Icon(Icons.bluetooth),
              title: Text(r.device.advName.isNotEmpty ? r.device.advName : r.device.remoteId.str),
              subtitle: Text('Signal ${r.rssi} dBm'),
              onTap: () => Navigator.pop(context, r),
            ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}
