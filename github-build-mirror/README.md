# FrogTalk Build Mirror

This folder is a GitHub-hosted mirror source for desktop app downloads.

## Artifacts

- `FrogTalk-1.3.9.AppImage` (Linux AppImage)
- `frogtalk_1.3.9_amd64.deb` (Debian/Ubuntu package)
- `FrogTalk-1.3.9-Setup.exe` (Windows executable)

## Integrity

Checksums are stored in `SHA256SUMS.txt`.

## Site Download Endpoints

The website serves latest desktop builds via:

- `/download/linux`
- `/download/deb`
- `/download/windows`

These endpoints pick the latest matching artifact from `static/` on the server.
