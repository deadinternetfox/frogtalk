# FrogTalk Build Mirror

Mirrored release artifacts for FrogTalk **v1.6.28** (Android `versionCode` **233**).

## Download Artifacts

### Android (v1.6.28 / 233)

| Artifact | File | Use |
|----------|------|-----|
| **APK (sideload)** | [frogtalk-v233.apk](./frogtalk-v233.apk) | Direct install, `/download/android` on nodes |
| **AAB (Play Store)** | [frogtalk-v233.aab](./frogtalk-v233.aab) | Google Play Console upload |

**This build:** polished in-app node setup wizard (replaces old AlertDialog), incoming-call recovery when the app is foregrounded, WebView cache bust for latest call UI JS.

### Verify integrity

```bash
sha256sum -c SHA256SUMS-v233.txt
```

Checksums: [SHA256SUMS-v233.txt](./SHA256SUMS-v233.txt)

### GitHub Releases

**Release:** [v1.6.28 on GitHub](https://github.com/deadinternetfox/frogtalk/releases/tag/v1.6.28) (APK + AAB attached).

## Website download endpoints

Each node serves the newest `node/static/frogtalk-v*.apk` (or falls back to `static/github-build-mirror/` then GitHub releases):

- https://frogtalk.xyz/download/android
- Your self-hosted node: `https://<your-host>/download/android`

Desktop builds (AppImage, .deb, Windows) are listed in the download picker with GitHub mirror fallback when not hosted on a given node.
