# FrogTalk Build Mirror

This folder is a GitHub-hosted mirror source for desktop & android downloads.

## Artifacts

- `FrogTalk-1.4.1.AppImage` (Linux AppImage, desktop)
- `frogtalk_1.4.1_amd64.deb` (Linux Debian/Ubuntu package, desktop)
- `FrogTalk-1.4.1-win-x64-portable.exe` (Windows portable, x64 — single-file, just run it)
- `FrogTalk-1.4.1-win-x64.zip` (Windows portable archive, x64 — unzip & run FrogTalk.exe)
- `frogtalk-v223.apk` (Android, versionCode 223 / versionName 1.6.19)

## Integrity

Checksums are stored in `SHA256SUMS.txt`.

## Site Download Endpoints

The website serves latest builds via:

- `/download/android`
- `/download/linux`
- `/download/deb`
- `/download/windows` (serves portable .exe)
- `/download/windows-zip` (serves .zip)

These endpoints pick the latest matching artifact from `static/` on the server.
