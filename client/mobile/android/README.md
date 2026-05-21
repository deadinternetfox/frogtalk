# FrogTalk Android App

Android WebView wrapper for FrogTalk with full feature support:

- **WebRTC** voice & video calls (camera + microphone permissions)
- **Push notifications** (POST_NOTIFICATIONS permission for Android 13+)
- **File uploads** (photos, documents)
- **Deep linking** (https://frogtalk.xyz/* URLs open in app)
- **Offline error handling** with retry button
- **Edge-to-edge** dark UI matching the web app

## Building

### Prerequisites
- JDK 17+
- Android SDK (API 34)
- Android Studio (optional, for icon generation)

### Command Line Build
```bash
cd client/mobile/android
./gradlew assembleRelease
```

Signed APK: `app/build/outputs/apk/release/app-release.apk`  
Play bundle: `app/build/outputs/bundle/release/app-release.aab`

Copy to the fleet:

```bash
cp app/build/outputs/apk/release/app-release.apk ../../../node/static/frogtalk-v232.apk
cp app/build/outputs/apk/release/app-release.apk ../../../github-build-mirror/frogtalk-v232.apk
cp app/build/outputs/bundle/release/app-release.aab ../../../github-build-mirror/frogtalk-v232.aab
```

### Signing for Release
Create a keystore:
```bash
keytool -genkey -v -keystore frogtalk.keystore -keyalg RSA -keysize 2048 -validity 10000 -alias frogtalk
```

Sign the APK:
```bash
jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 \
  -keystore frogtalk.keystore app/build/outputs/apk/release/app-release-unsigned.apk frogtalk
zipalign -v 4 app-release-unsigned.apk frogtalk.apk
```

Or use Android Studio's Build > Generate Signed APK.

## Incoming calls (FCM + in-app Accept/Decline)

The APK ships `FrogTalkFirebaseMessagingService` (data-only `kind=call` pushes)
and `FcmBridge` (token sync + notification Decline). **Tapping the notification
opens the app** — Accept/Decline live only in the web `#incoming-call` overlay
(not on the tray). Warm taps run `App.recoverIncomingCallFromNative()` via
`MainActivity` without reloading the WebView (avoids tearing down WebRTC).

After changing Kotlin under `app/src/main/java/`, rebuild and reinstall the APK.
Web-only deploys (`node/static/js/app.js`, `calls.js`) help cold-start URL
recovery but **warm notification taps require a new APK**.

Requirements: `google-services.json`, Firebase Messaging dependency, and server
`FIREBASE_SERVICE_ACCOUNT_JSON` (see `node/deploy/env.example`).

## Icon Generation

Replace the placeholder icons in `app/src/main/res/mipmap-*/` with your frog logo.

Use Android Studio's Image Asset Studio:
1. Right-click `res` folder → New → Image Asset
2. Select Launcher Icons
3. Upload the SVG from `static/icons/icon.svg`

## Development

Point to local server in `MainActivity.kt`:
```kotlin
val url = "http://10.0.2.2:8080/app"  // 10.0.2.2 = host machine from emulator
```
