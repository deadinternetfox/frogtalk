# Android calls, FCM, and security

_Last updated: 2026-05-21 · APK v1.6.27 (versionCode 232)_

## Background / killed app

- Server sends **data-only** FCM (`kind=call`, `priority=high`, 30s TTL) — no hybrid notification payload.
- `FrogTalkFirebaseMessagingService` builds a high-priority tray notification with `setFullScreenIntent` when the app is not visible.
- Tapping the notification opens `MainActivity` with `incoming_call`, `call_id`, `dm_nick` extras (cold URL query params or warm JS recovery).
- Accept/Decline are **only** in the web `#incoming-call` overlay — not on the tray (avoids auto-accept races).

## Warm tap (app already running)

- `onNewIntent` does **not** reload the WebView (preserves WebRTC/WS).
- `App.recoverIncomingCallFromNative()` fetches `GET /api/calls/{id}/pending`, opens the DM, shows the overlay.

## Security properties

| Item | Status |
|------|--------|
| Room/call secrets on server | Never sent; E2EE unchanged |
| FCM payload | Data-only; oversized fields dropped (>1 KB); no avatar URLs in call push |
| `FcmBridge` API host | Uses `server_base_url` from prefs; http/https only |
| `CallDeclineReceiver` | `exported=false`; decline uses session token from encrypted prefs |
| `FrogTalkFirebaseMessagingService` | `exported=false` |
| JS recovery `call_id` | Digits-only before REST fetch |
| Notification tap JS | Escaped peer nick; bounded length |
| Backup | `allowBackup=false` |
| Cleartext | Blocked for `frogtalk.xyz`; localhost allowed for dev |

## Operator requirements

- `google-services.json` in the Android app module.
- Server: `FIREBASE_SERVICE_ACCOUNT_JSON` (see `node/deploy/env.example`).
- Android 13+: `POST_NOTIFICATIONS` granted.
- Android 14+: user may need to allow **full-screen intents** for lock-screen incoming call UI.
- Battery optimization exemption recommended (prompted in-app).

## Play / sideload artifacts

- **APK:** `frogtalk-v{versionCode}.apk` — `/download/android` on each node.
- **AAB:** `frogtalk-v{versionCode}.aab` — Google Play upload; mirrored under `github-build-mirror/`.
