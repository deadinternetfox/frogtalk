# FrogTalk Build Mirror

Mirrored release artifacts for FrogTalk **v1.6.34** (Android `versionCode` **239**).

## Download Artifacts

### Android (v1.6.34 / 239)

| Artifact | File | Use |
|----------|------|-----|
| **APK (sideload)** | [frogtalk-v239.apk](./frogtalk-v239.apk) | Direct install, `/download/android` on nodes |
| **AAB (Play Store)** | [FrogTalk-1.6.34-239.aab](./FrogTalk-1.6.34-239.aab) | Google Play Console upload |

**This build:** centers the combined first-run setup wizard vertically on screen.

### Verify integrity

```bash
sha256sum -c SHA256SUMS-v239.txt
```

Checksums: [SHA256SUMS-v239.txt](./SHA256SUMS-v239.txt)

### GitHub Releases

**Release:** [v1.6.34 on GitHub](https://github.com/deadinternetfox/frogtalk/releases/tag/v1.6.34) (APK + AAB attached).

## Website download endpoints

- https://frogtalk.xyz/download/android
- Your node: `https://<host>/download/android`
