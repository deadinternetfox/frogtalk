# Client Surfaces

Everything end-users install lives in this folder. The node server (FastAPI +
web client + ops scripts) lives in `../node/`.

## Linux quick start (desktop)

| Method | Command |
|--------|---------|
| **AppImage** | Download from [Releases](https://github.com/deadinternetfox/frogtalk/releases/latest) → `chmod +x FrogTalk-*.AppImage` → `./FrogTalk-*.AppImage` |
| **.deb** | `sudo dpkg -i frogtalk_*_amd64.deb` then run `frogtalk` |
| **Arch AUR** | `yay -S frogtalk-bin` ([package](https://aur.archlinux.org/packages/frogtalk-bin)) |
| **Build here** | `bash client/desktop/scripts/build-linux-release.sh` |

The app loads the same web UI as the node (`node/static/`). Point **Settings →
Network** at your node (`https://frogtalk.xyz` or your self-hosted URL / `.onion`).

Packaging for AUR / Snap / Homebrew: [`../packaging/README.md`](../packaging/README.md).

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
# Linux AppImage + .deb (recommended)
bash client/desktop/scripts/build-linux-release.sh

# Or manually:
cd client/desktop/app
npm ci
npm run build-all          # AppImage + deb + Windows zip/portable
# npm run build-deb        # deb only
# npm run build-appimage   # AppImage only
```

Output lands in `client/desktop/builds/` (gitignored). Upload `frogtalk_*_amd64.deb`
and `FrogTalk-*.AppImage` to [GitHub Releases](https://github.com/deadinternetfox/frogtalk/releases)
before bumping [AUR `frogtalk-bin`](https://aur.archlinux.org/packages/frogtalk-bin).

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
