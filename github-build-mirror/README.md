# FrogTalk Build Mirror

This folder mirrors FrogTalk desktop and Android builds for v1.4.1.

## Download Artifacts

### Desktop Builds

| Platform | File | Download | Size |
|----------|------|----------|------|
| **Linux** (AppImage) | FrogTalk-1.4.1.AppImage | [Download](https://github.com/deadinternetfox/frogtalk/releases/download/v1.4.1/FrogTalk-1.4.1.AppImage) | 114MB |
| **Linux** (Debian/Ubuntu) | frogtalk_1.4.1_amd64.deb | [Download](https://github.com/deadinternetfox/frogtalk/releases/download/v1.4.1/frogtalk_1.4.1_amd64.deb) | 79MB |
| **Windows** (Portable EXE) | FrogTalk-1.4.1-win-x64-portable.exe | [Download](https://github.com/deadinternetfox/frogtalk/releases/download/v1.4.1/FrogTalk-1.4.1-win-x64-portable.exe) | 87MB |
| **Windows** (Portable ZIP) | FrogTalk-1.4.1-win-x64.zip | [Download](https://github.com/deadinternetfox/frogtalk/releases/download/v1.4.1/FrogTalk-1.4.1-win-x64.zip) | 132MB |

### Mobile Build

| Platform | File | Download | Version |
|----------|------|----------|---------|
| **Android** | frogtalk-v223.apk | [Download](https://github.com/deadinternetfox/frogtalk/releases/download/v1.4.1/frogtalk-v223.apk) | v1.6.19 (versionCode 223) |

## Installation Instructions

### Linux (AppImage)
```bash
wget https://github.com/deadinternetfox/frogtalk/releases/download/v1.4.1/FrogTalk-1.4.1.AppImage
chmod +x FrogTalk-1.4.1.AppImage
./FrogTalk-1.4.1.AppImage
```

### Linux (Debian/Ubuntu)
```bash
wget https://github.com/deadinternetfox/frogtalk/releases/download/v1.4.1/frogtalk_1.4.1_amd64.deb
sudo dpkg -i frogtalk_1.4.1_amd64.deb
frogtalk
```

### Windows (Portable EXE)
Download `FrogTalk-1.4.1-win-x64-portable.exe` and run it directly — no installation needed.

### Windows (ZIP Archive)
Download and extract `FrogTalk-1.4.1-win-x64.zip`, then run `FrogTalk.exe` from the extracted folder.

### Android
Download `frogtalk-v223.apk` to your Android device and open it to install.

## Verify Integrity

All artifacts are checksummed with SHA256. Verify downloads with:
```bash
sha256sum -c SHA256SUMS.txt
```

Checksums are available in [SHA256SUMS.txt](./SHA256SUMS.txt).

## Website Download Endpoints

The main FrogTalk website serves latest builds via dynamic endpoints:
- `/download/android`
- `/download/linux` (AppImage)
- `/download/deb`
- `/download/windows` (portable EXE)
- `/download/windows-zip`

These endpoints automatically pull the latest matching artifact from the server's `static/` directory.
