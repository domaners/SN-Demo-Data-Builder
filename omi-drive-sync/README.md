# Omi Drive Sync

A Flutter app for Android and iOS. It downloads the audio your [Omi](https://www.omi.me) pendant has stored
offline and saves each recording to a folder in your Google Drive.

```
Omi pendant ──BLE──▶ phone: .ogg files in app storage ──HTTPS──▶ Google Drive / "Omi Recordings"
```

1. **Download.** The app connects to the pendant and reads its offline storage using the same ring-buffer
   protocol as the official Omi app (firmware 3.0.20 or newer).
2. **Save.** It wraps the pendant's Opus frames in a standard Ogg Opus file without re-encoding, so the
   audio is bit-for-bit what the pendant recorded. A new file starts when the pendant's timestamps show a
   pause of more than 60 seconds, or when a file reaches 60 minutes. Files are named by start time, for
   example `omi_2026-10-23_14-05-33.ogg`. They are 16 kHz mono, about 30 MB per hour, and play in VLC,
   Chrome, Android and most other players.
3. **Upload.** It uploads every finished file to Drive and deletes the phone's copy only after Drive
   confirms the upload. A failed upload is retried on the next sync.

The app syncs when it opens, when it returns to the foreground, when you pull to refresh, and when you tap
**Sync now**.

> **The Omi app and this app compete for the same audio.** The pendant frees its storage as it sends audio
> to a phone, so whichever app syncs first gets those recordings and the other never sees them. Recordings
> that this app downloads will not be transcribed by Omi. Also, the pendant connects to one app at a time,
> so close the Omi app, or turn off its device connection, before you sync with this one.

## What you need

- An Omi pendant on firmware **3.0.20 or newer**. Update it from the Omi app if needed. The app shows
  the firmware version after it connects.
- [Flutter](https://docs.flutter.dev/get-started/install) 3.47 or newer, plus Android Studio (for Android)
  or Xcode (for iOS).
- A Google account and a Google Cloud project (free). The project supplies the OAuth client the app uses
  to sign you in.

## 1. Set up Google Drive access (one time)

The app requests only the `drive.file` scope, so it can see only the files and folder it creates. It never
sees anything else in your Drive.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project.
2. Open **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.
3. Open **APIs & Services → OAuth consent screen** (on newer consoles: **Google Auth Platform**).
   - User type: **External**. Enter an app name and your email.
   - Scopes: add `.../auth/drive.file`.
   - Test users: add your own Google account. While the app stays in *Testing* mode, only test users can
     sign in, which suits personal use.
4. Open **APIs & Services → Credentials → Create credentials → OAuth client ID** and create a client for
   each platform you build:
   - **Android**: package name `com.domaners.omi_drive_sync`, plus the SHA-1 of your signing key. For
     debug builds, get the SHA-1 with:
     ```sh
     keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android
     ```
     No file needs downloading. Google matches the package name and SHA-1 at sign-in.
   - **iOS**: bundle ID `com.domaners.omiDriveSync`. Then edit `ios/Runner/Info.plist`: put the client ID in
     `GIDClientID`, and put the **iOS URL scheme** shown on the client page (it starts with
     `com.googleusercontent.apps.`) under `CFBundleURLSchemes`.

If you change the package name or bundle ID, use the new value in these steps.

## 2. Build and run

```sh
cd omi-drive-sync
flutter pub get
flutter run            # with a phone connected over USB; Bluetooth does not work in emulators
```

For iOS, run `cd ios && pod install` once, open `ios/Runner.xcworkspace` in Xcode, and choose your signing
team.

To build a release APK, run `flutter build apk --release`. Release builds are signed with a different key,
so add that key's SHA-1 to the Android OAuth client too.

## 3. Use it

1. Tap **Find** and choose your pendant. Hold it near the phone; Android asks for the Nearby devices
   permission and iOS asks for Bluetooth.
2. Tap **Sign in** and choose your Google account.
3. Tap **Sync now**. The status line shows progress. Recordings appear in **My Drive → Omi Recordings**.

In **Settings** (the gear icon) you can rename the Drive folder and choose to keep a copy of each recording
on the phone after upload.

## Project layout

| Path | Contents |
|---|---|
| `lib/omi/protocol.dart` | Omi BLE UUIDs and the storage protocol: commands, notifications, 444-byte records |
| `lib/omi/omi_pendant.dart` | BLE connection, built on `flutter_blue_plus`: connect, read info, stream records, release storage |
| `lib/audio/ogg_opus_writer.dart` | Streaming Ogg Opus muxer (RFC 7845); needs no native codec |
| `lib/audio/recording_splitter.dart` | Splits records into recordings by timestamp gaps; recovers interrupted files |
| `lib/drive/drive_uploader.dart` | Google Sign-In, find or create the folder, resumable upload |
| `lib/sync/sync_controller.dart` | Runs a sync: pendant → local files → Drive, plus settings and history |
| `lib/main.dart` | UI |
| `test/` | Protocol unit tests, plus an end-to-end test that runs real Opus audio through the whole pipeline and decodes the output with ffmpeg |

Run the tests with `flutter test`. The end-to-end test is skipped if `ffmpeg` is not installed.

## Notes and limitations

- **Not yet tested against a real pendant.** The protocol follows the official Omi app and firmware
  source (`app/lib/services/devices/ring_protocol.dart` and `omi/firmware/omi/src/lib/core/storage.c` in
  [BasedHardware/omi](https://github.com/BasedHardware/omi)). The audio pipeline is tested end to end with
  real Opus data. If a sync fails, open the **Activity log** on the main screen to see where it stopped.
- **Firmware older than 3.0.20 is not supported.** Older firmware used other storage protocols, and the app
  says so when it connects.
- **Syncs run only while the app is open.** Background Bluetooth syncing on iOS needs extra entitlements and
  is not implemented.
- **Pendant clock.** The app sets the pendant's clock each time it syncs. Audio recorded while the clock was
  unset (for example, after the battery ran flat) carries no real time. The app saves that audio as one file
  with an estimated start time, and tags the file to say so.
- **Dependency license.** `flutter_blue_plus` is free for personal and nonprofit use, which is how the app
  declares it (`License.nonprofit` in `omi_pendant.dart`). Commercial use needs a paid license from its
  author.
