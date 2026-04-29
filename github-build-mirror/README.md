# FrogTalk Build Mirror

This folder is a GitHub-hosted mirror source for desktop & android downloads.

## Artifacts

- `FrogTalk-1.4.1.AppImage` (Linux AppImage, desktop)
- `FrogTalk-1.4.1-win-x64-portable.exe` (Windows portable, x64 — single-file, just run it)
- `FrogTalk-1.4.1-win-x64.zip` (Windows portable archive, x64 — unzip & run FrogTalk.exe)
- `frogtalk-v205.apk` (Android, versionCode 205 / versionName 1.6.1)

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
