# Client Surface

This folder documents the frontend/client boundary for FrogTalk.

## Source-of-truth paths

- `client/desktop/app/` — Electron desktop shell (source)
- `client/desktop/builds/` — desktop artifact output folder (gitignored binaries)
- `client/mobile/android/` — Android app source
- `client/mobile/ios/` — iOS app source / docs
- `static/` — web client app and marketing pages (kept at root so the backend runtime path stays stable)

## Build entrypoints

- Desktop (Electron): `client/desktop/app/package.json`
- Android: `client/mobile/android/build.gradle.kts`
- iOS: `client/mobile/ios/FrogTalk.xcodeproj`

## Migration rule

- Keep backend/runtime entry paths stable while we progressively move remaining web assets in smaller PRs.
