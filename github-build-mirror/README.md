# FrogTalk Build Mirror

Mirrored release artifacts for FrogTalk **v1.6.36** (Android `versionCode` **241**).

## Download Artifacts

### Android (v1.6.36 / 241)

| Artifact | File | Use |
|----------|------|-----|
| **APK (sideload)** | [frogtalk-v241.apk](./frogtalk-v241.apk) | Direct install, `/download/android` on nodes |
| **AAB (Play Store)** | [FrogTalk-1.6.36-241.aab](./FrogTalk-1.6.36-241.aab) | Google Play Console upload |

**This build:** federation account sync fixes (FrogSocial, DMs, encrypted room history), mobile cache bump.

### Verify integrity

```bash
sha256sum -c SHA256SUMS-v241.txt
```

Checksums: [SHA256SUMS-v241.txt](./SHA256SUMS-v241.txt)

### GitHub Releases

**Release:** [v1.6.36 on GitHub](https://github.com/deadinternetfox/frogtalk/releases/tag/v1.6.36) (APK + AAB attached).

## Website download endpoints

- https://frogtalk.xyz/download/android
- Your node: `https://<host>/download/android`
