# Desktop Build Outputs

Electron build artifacts are generated here for a cleaner repo layout.

Configured in `client/desktop/app/package.json`:

- `build.directories.output = ../builds`

Typical outputs:

- `FrogTalk-<version>.AppImage`
- `frogtalk_<version>_amd64.deb`
- `FrogTalk-<version>-win-x64.zip`
- `FrogTalk-<version>-win-x64-portable.exe`

These binaries are intentionally not committed to git.
