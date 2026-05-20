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

APK will be at: `app/build/outputs/apk/release/app-release-unsigned.apk`

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

## Incoming calls when the app is closed (FCM required)

The current build is a plain `WebView` wrapper. Web-push notifications only
wake the embedded service worker while the app process is alive — once
Android kills the process, **no SW can run** and the phone will not ring
for an incoming call. This is a hard Android/WebView limit.

To make the phone ring while the app is fully closed (Snapchat/WhatsApp
style), native Firebase Cloud Messaging is required. The full change set:

1. Create a Firebase project at <https://console.firebase.google.com> and
   add an Android app with package `xyz.frogtalk.app`. Download
   `google-services.json` into `client/mobile/android/app/`.
2. Add to `client/mobile/android/build.gradle.kts`:
   ```kotlin
   plugins { id("com.google.gms.google-services") version "4.4.2" apply false }
   ```
   And in `client/mobile/android/app/build.gradle.kts`:
   ```kotlin
   plugins { id("com.google.gms.google-services") }
   dependencies {
       implementation(platform("com.google.firebase:firebase-bom:33.1.2"))
       implementation("com.google.firebase:firebase-messaging-ktx")
   }
   ```
3. Add a `FirebaseMessagingService` subclass that, on receipt of a
   data-only message with `kind=call`, launches `CallService` with
   `FLAG_RECEIVER_FOREGROUND` and builds a high-priority notification
   with `setFullScreenIntent(..., true)` on a "Calls" channel of
   `IMPORTANCE_HIGH` + `CATEGORY_CALL`. This is what bypasses Doze.
4. On boot / first login, grab the FCM token (`FirebaseMessaging.getInstance()
   .token`) and `POST /api/push/fcm-subscribe` with `{token, platform:"android"}`.
   Store it server-side alongside the existing WebPush subscriptions.
5. In `node/routers/ws.py`'s `_push_always()` call path, if the recipient has an
   Android FCM token registered, also send an HTTP v1 FCM message with
   `android.priority=HIGH`, `data={kind:"call", call_id, from_nickname,
   from_avatar, call_type}` and **no `notification` field** (so the data
   handler runs even when the app is killed).

Until these steps are done, incoming-call notifications only fire while
the app is at least in the background, not force-closed.

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
