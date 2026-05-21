# FrogTalk Build Mirror

Mirrored release artifacts for FrogTalk **v1.6.32** (Android `versionCode` **237**).

## Download Artifacts

### Android (v1.6.32 / 237)

| Artifact | File | Use |
|----------|------|-----|
| **APK (sideload)** | [frogtalk-v237.apk](./frogtalk-v237.apk) | Direct install, `/download/android` on nodes |
| **AAB (Play Store)** | [FrogTalk-1.6.32-237.aab](./FrogTalk-1.6.32-237.aab) | Google Play Console upload |

**This build:** cold-boot incoming-call answer fixes (WS bootstrap, launch order), in-app HTML permissions wizard (replaces native AlertDialogs), WebView cache rev `wizard-v237`.

### Verify integrity

```bash
sha256sum -c SHA256SUMS-v237.txt
```

Checksums: [SHA256SUMS-v237.txt](./SHA256SUMS-v237.txt)

### GitHub Releases

**Release:** [v1.6.32 on GitHub](https://github.com/deadinternetfox/frogtalk/releases/tag/v1.6.32) (APK + AAB attached).

## Website download endpoints

Each node serves the newest `node/static/frogtalk-v*.apk` (or falls back to `static/github-build-mirror/` then GitHub releases):

- https://frogtalk.xyz/download/android
- Your self-hosted node: `https://<your-host>/download/android`

Desktop builds (AppImage, .deb, Windows) are listed in the download picker with GitHub mirror fallback when not hosted on a given node.
