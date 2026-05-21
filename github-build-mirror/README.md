# FrogTalk Build Mirror

Mirrored release artifacts for FrogTalk **v1.6.27** (Android `versionCode` **232**).

## Download Artifacts

### Android (v1.6.27 / 232)

| Artifact | File | Use |
|----------|------|-----|
| **APK (sideload)** | [frogtalk-v232.apk](./frogtalk-v232.apk) | Direct install, `/download/android` on nodes |
| **AAB (Play Store)** | [frogtalk-v232.aab](./frogtalk-v232.aab) | Google Play Console upload |

**Call/FCM fixes in this build:** warm notification tap recovers Accept/Decline UI without WebView reload; FCM uses configured server URL; background ring dedupe. See [docs/ANDROID_CALLS_SECURITY.md](../docs/ANDROID_CALLS_SECURITY.md).

### Verify integrity

```bash
sha256sum -c SHA256SUMS-v232.txt
```

Checksums: [SHA256SUMS-v232.txt](./SHA256SUMS-v232.txt)

### GitHub Releases

**Release:** [v1.6.27 on GitHub](https://github.com/deadinternetfox/frogtalk/releases/tag/v1.6.27) (APK + AAB attached).

## Website download endpoints

Each node serves the newest `node/static/frogtalk-v*.apk` automatically:

- https://frogtalk.xyz/download/android
- Your self-hosted node: `https://<your-host>/download/android`

## Older desktop builds

See git history for v1.4.1 desktop mirror entries (AppImage, deb, Windows portable).
