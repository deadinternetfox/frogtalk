# FrogTalk iOS App

WKWebView wrapper for FrogTalk with full feature parity to the Android app:

- **WebRTC** voice & video calls (camera + microphone)
- **APNs push notifications** (via Firebase Cloud Messaging iOS SDK)
- **CallKit + PushKit** for cold-launch incoming-call ringing (Snapchat/WhatsApp-style)
- **Background audio** for the music player
- **Universal Links** so `https://frogtalk.xyz/*` opens in the app
- **Native bridge** mirroring the Android `window.Android.*` API so the existing
  `static/js/` codebase needs no per-platform forks

## Building

### Prerequisites

- macOS 13+ (required — Xcode is macOS-only)
- Xcode 15+
- An Apple Developer account ($99/yr) for signing, push, and CallKit
- CocoaPods or Swift Package Manager (project uses SPM)

### Open the project

```bash
cd ios
open FrogTalk.xcodeproj
```

Or generate fresh:

```bash
cd ios
xcodebuild -project FrogTalk.xcodeproj -scheme FrogTalk -configuration Release \
  -archivePath build/FrogTalk.xcarchive archive
xcodebuild -exportArchive -archivePath build/FrogTalk.xcarchive \
  -exportPath build/ -exportOptionsPlist ExportOptions.plist
```

### Required Apple developer setup

1. **Apple Developer enrollment** ($99/yr individual or organization). Create
   the app at <https://developer.apple.com> with bundle id `xyz.frogtalk.app`.
2. **APNs auth key** (`.p8`): Certificates → Keys → "+" → enable
   "Apple Push Notifications service (APNs)". Download the `.p8` and note
   the Key ID + Team ID.
3. **Capabilities** to enable on the app id:
   - Push Notifications
   - Background Modes: Audio, AirPlay, Picture in Picture; Voice over IP;
     Background fetch; Remote notifications
   - Associated Domains: `applinks:frogtalk.xyz`
4. **Firebase Cloud Messaging** (optional but recommended, since we already
   use it for Android):
   - Add an iOS app to the existing Firebase project, bundle id
     `xyz.frogtalk.app`.
   - Download `GoogleService-Info.plist` into `ios/FrogTalk/`.
   - Upload the APNs `.p8` to Firebase → Project Settings → Cloud Messaging.

VoIP push (cold-launch incoming calls) does **not** go through FCM. The
backend sends VoIP pushes directly to APNs HTTP/2 with `apns-push-type: voip`.
See [routers/push.py](../routers/push.py) `_send_apns_voip()`.

## Distribution

iOS has no `.apk`-equivalent free sideload path. Distribution channels:

| Channel | Reach | Notes |
|---|---|---|
| **App Store** | All iPhones | Required for general public; 1–7 day first review |
| **TestFlight** | Up to 10,000 testers via public link | Closest analog to the APK download — post link on frogtalk.xyz |
| Ad-Hoc `.ipa` | 100 pre-registered UDIDs | Not "download from website" — user must pre-register |
| Enterprise | Internal only | Apple revokes for public distribution; do NOT use |

**Pre-launch flow**: TestFlight public link, served via `/download/ios` on the
site. The route is configured by the `IOS_DOWNLOAD_URL` env var (defaults to
this README). After App Store approval, point the env var at the App Store URL.

## Development

To point at a local server while developing, edit `ViewController.swift`:

```swift
private let APP_URL = "http://localhost:8000/app"
```

## Architecture

Mirrors the Android wrapper file-for-file:

| Android | iOS counterpart |
|---|---|
| `MainActivity.kt` | `ViewController.swift` |
| `CallService.kt` + `CallDeclineReceiver.kt` | `CallManager.swift` (CallKit) |
| `FcmBridge.kt` | `PushHandler.swift` (FCM + VoIP) |
| `FrogTalkFirebaseMessagingService.kt` | `AppDelegate.swift` + `PushHandler.swift` |
| `MusicService.kt` | `AudioSessionController.swift` |
| `AndroidManifest.xml` | `Info.plist` + entitlements |

The injected `window.Android` polyfill (`NativeBridge.swift`) means the existing
JS code under `static/js/` runs unchanged.
