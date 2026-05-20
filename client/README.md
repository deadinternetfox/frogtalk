# Client Surfaces

Everything end-users install lives in this folder. The node server (FastAPI +
web client + ops scripts) lives in `../node/`.

## Layout

```
client/
├── desktop/
│   ├── app/              # Electron source (main.js, preload.js, package.json)
│   └── builds/           # electron-builder output (gitignored)
└── mobile/
    ├── android/          # Android Studio + Capacitor project
    └── ios/              # Xcode project
```

## Build entrypoints

| Target          | Entry file                                          |
|-----------------|-----------------------------------------------------|
| Desktop (Electron) | `client/desktop/app/package.json`                |
| Android         | `client/mobile/android/build.gradle.kts`            |
| iOS             | `client/mobile/ios/FrogTalk.xcodeproj`              |

## How the desktop client talks to the node

The Electron renderer is the same web client served by the node at
`node/static/`. The desktop shell points at an installed node (default
`https://frogtalk.xyz`) but can be flipped to any node, including a Tor onion
address, via the in-app Network Settings panel.

## Building the desktop client

```bash
cd client/desktop/app
npm ci
npx electron-builder --linux dir   # or --win / --mac
```

Output lands in `client/desktop/builds/` (gitignored).

## Building Android

```bash
cd client/mobile/android
./gradlew assembleRelease
```

Signed APKs are mirrored to `github-build-mirror/` for release publishing.

## Migration rule

When the web client at `node/static/` changes, bump asset versions
(`?v=N` query strings in HTML) and run `node --check node/static/js/<file>.js`
on every JS file you touched. The desktop client picks up the new bundle on
restart because it loads the same `static/` tree as the web client.
