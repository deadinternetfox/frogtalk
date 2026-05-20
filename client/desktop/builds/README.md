# Desktop Build Outputs

Electron build artifacts are generated here for a cleaner repo layout.

## Build

```bash
bash client/desktop/scripts/build-linux-release.sh
```

Configured in `client/desktop/app/package.json` → `build.directories.output = ../builds`.

## Typical outputs

| File | Linux install |
|------|----------------|
| `FrogTalk-<version>.AppImage` | `chmod +x` then `./FrogTalk-*.AppImage` |
| `frogtalk_<version>_amd64.deb` | `sudo dpkg -i frogtalk_*.deb` → `frogtalk` |
| `FrogTalk-<version>-win-x64.zip` | Unzip, run `FrogTalk.exe` |
| `FrogTalk-<version>-win-x64-portable.exe` | Single portable exe |

These binaries are intentionally not committed to git. Publish to
[GitHub Releases](https://github.com/deadinternetfox/frogtalk/releases).
