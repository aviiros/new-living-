# Living Ideas — Android APK build kit

Turns the Living Ideas reading library into an Android app (Capacitor) with the same UI and features.

> **Honest status:** the web/platform layer was tested in Chromium (the same engine as Android WebView): import, reading, annotations, PDF, audio, backup/restore, storage isolation, phone layout. **The APK itself was never built or run on a real device** (no Android SDK where this was made). If a build or runtime error appears, send me the text and I will fix it.

## Three ways to get the APK
1. **No installs (easiest) — GitHub Actions.** Upload this folder to a new GitHub repo → *Actions* → *Build Android APK* → *Run workflow* → download `Living-Ideas-debug-apk` from Artifacts (~5–10 min).
2. **One command locally.** Needs Node 18+, JDK 17 and Android Studio (for the SDK): `npm install && npm run apk` → `dist/Living-Ideas-debug.apk` (or `build-apk.bat` / `./build-apk.sh`).
3. **Android Studio.** `npm install && npm run sync && npm run open` → *Build ▸ Build APK(s)*, or press ▶ with a phone attached.

## Signed release
Create a keystore (`keytool -genkey -v -keystore android/app/release.keystore -alias living -keyalg RSA -keysize 2048 -validity 10000`), write `android/key.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`), then `npm run apk -- --release`. **Keep the keystore safe — you cannot update the app without it.** For CI add secrets `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.

## Customizing
Edit `web-src/` (UI, reader scripts, i18n, `seed/` starter books) then `npm run sync`. App name/id: `capacitor.config.json` (+ `applicationId` in `android/app/build.gradle` if you change the id). Icons/splash: `android/app/src/main/res/`.

## How it works
`platform/platform-android.js` re-implements the desktop main process behind the same `window.api`: IndexedDB storage, per-book storage namespacing in `srcdoc` iframes, JSZip for EPUB/backup, pdf.js for PDF, blob URLs for audio, Capacitor Share/Filesystem for exports, LocalNotifications for goals/reminders, hardware-back handling.

## Limits
No drag-and-drop or "open with" from other apps; backups are built in memory (very large libraries may be heavy); data lives inside the app (uninstall/clear-data removes it — use backups); minimum Android 5.1, Android 8+ recommended.

See `THIRD_PARTY.md` for third-party licenses.
