# Client Surface

This folder documents the frontend/client boundary for FrogTalk.

Current source-of-truth paths:

- `client/desktop/app/` - Electron desktop shell (moved from root `desktop/`)
- `client/desktop/builds/` - desktop artifact output folder
- `client/mobile/android/` - Android app source (moved from root `android/`)
- `client/mobile/ios/` - iOS app source/docs (moved from root `ios/`)
- `static/` - web client app and marketing pages (kept stable for backend runtime)

Compatibility links (for existing tooling):

- `desktop -> client/desktop/app`
- `android -> client/mobile/android`
- `ios -> client/mobile/ios`

Migration rule:

- Keep backend/runtime entry paths stable while we progressively move remaining web assets in smaller PRs.
