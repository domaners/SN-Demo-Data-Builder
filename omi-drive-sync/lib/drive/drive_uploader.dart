import 'dart:convert';
import 'dart:io';

import 'package:google_sign_in/google_sign_in.dart';
import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;

class DriveException implements Exception {
  final String message;
  DriveException(this.message);

  @override
  String toString() => message;
}

/// Google sign-in plus the two Drive calls the app needs: find-or-create the
/// destination folder, and upload a file into it.
///
/// Uses the `drive.file` scope, which only grants access to files this app
/// creates, so it never sees the rest of the user's Drive.
class DriveUploader {
  static const _scope = 'https://www.googleapis.com/auth/drive.file';
  static const _folderMime = 'application/vnd.google-apps.folder';

  final GoogleSignIn _signIn = GoogleSignIn(scopes: const [_scope]);
  final http.Client _http = http.Client();

  GoogleSignInAccount? get account => _signIn.currentUser;

  Future<GoogleSignInAccount?> restoreSession() => _signIn.signInSilently();

  Future<GoogleSignInAccount?> signIn() => _signIn.signIn();

  Future<void> signOut() => _signIn.disconnect().catchError((_) => _signIn.signOut());

  /// Returns the id of the folder called [name] at the top of My Drive,
  /// creating it if this app has not made one yet.
  Future<String> ensureFolder(String name) async {
    final query = "name = '${name.replaceAll(r'\', r'\\').replaceAll("'", r"\'")}' "
        "and mimeType = '$_folderMime' and 'root' in parents and trashed = false";
    final found = await _send(() => http.Request(
          'GET',
          Uri.https('www.googleapis.com', '/drive/v3/files', {'q': query, 'fields': 'files(id)', 'spaces': 'drive'}),
        ));
    final files = (jsonDecode(found.body)['files'] as List);
    if (files.isNotEmpty) return files.first['id'] as String;

    final created = await _send(() => http.Request('POST', Uri.https('www.googleapis.com', '/drive/v3/files'))
      ..headers['Content-Type'] = 'application/json; charset=UTF-8'
      ..body = jsonEncode({'name': name, 'mimeType': _folderMime}));
    return jsonDecode(created.body)['id'] as String;
  }

  /// Uploads [file] into [folderId] with a resumable upload session and
  /// returns the new Drive file id.
  Future<String> upload(File file, String folderId, {String mimeType = 'audio/ogg'}) async {
    final length = await file.length();
    final session = await _send(() => http.Request(
          'POST',
          Uri.https('www.googleapis.com', '/upload/drive/v3/files', {'uploadType': 'resumable', 'fields': 'id'}),
        )
          ..headers['Content-Type'] = 'application/json; charset=UTF-8'
          ..headers['X-Upload-Content-Type'] = mimeType
          ..headers['X-Upload-Content-Length'] = '$length'
          ..body = jsonEncode({
            'name': p.basename(file.path),
            'parents': [folderId],
            'mimeType': mimeType,
          }));
    final location = session.headers['location'];
    if (location == null) throw DriveException('Drive did not return an upload URL.');

    final put = http.StreamedRequest('PUT', Uri.parse(location))
      ..headers.addAll(await _signIn.currentUser!.authHeaders)
      ..headers['Content-Type'] = mimeType
      ..contentLength = length;
    final responseFuture = _http.send(put);
    await put.sink.addStream(file.openRead());
    await put.sink.close();
    final response = await http.Response.fromStream(await responseFuture);
    if (response.statusCode != 200 && response.statusCode != 201) {
      throw DriveException('Upload failed (${response.statusCode}): ${_errorMessage(response)}');
    }
    return jsonDecode(response.body)['id'] as String;
  }

  /// Sends an authorized request, refreshing the token once on a 401.
  Future<http.Response> _send(http.Request Function() build) async {
    for (var attempt = 0; attempt < 2; attempt++) {
      final user = _signIn.currentUser ?? await _signIn.signInSilently();
      if (user == null) throw DriveException('Sign in to Google first.');
      final request = build()..headers.addAll(await user.authHeaders);
      final response = await http.Response.fromStream(await _http.send(request));
      if (response.statusCode == 401 && attempt == 0) {
        await user.clearAuthCache();
        continue;
      }
      if (response.statusCode >= 300) {
        throw DriveException('Google Drive error (${response.statusCode}): ${_errorMessage(response)}');
      }
      return response;
    }
    throw DriveException('Google rejected the sign-in. Sign out and sign in again.');
  }

  static String _errorMessage(http.Response response) {
    try {
      return jsonDecode(response.body)['error']['message'] as String;
    } catch (_) {
      return response.reasonPhrase ?? 'unknown error';
    }
  }
}
