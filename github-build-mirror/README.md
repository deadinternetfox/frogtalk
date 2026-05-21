# FrogTalk Build Mirror

Mirrored release artifacts for FrogTalk **v1.6.33** (Android `versionCode` **238**).

## Download Artifacts

### Android (v1.6.33 / 238)

| Artifact | File | Use |
|----------|------|-----|
| **APK (sideload)** | [frogtalk-v238.apk](./frogtalk-v238.apk) | Direct install, `/download/android` on nodes |
| **AAB (Play Store)** | [FrogTalk-1.6.33-238.aab](./FrogTalk-1.6.33-238.aab) | Google Play Console upload |

**This build:** fixes broken first-run HTML (wizard was inside a `<style>` tag), unified setup wizard in `mobile_node_setup.html` (server + permissions), ConnErr full-screen overlay restored.

### Verify integrity

```bash
sha256sum -c SHA256SUMS-v238.txt
```

Checksums: [SHA256SUMS-v238.txt](./SHA256SUMS-v238.txt)

### GitHub Releases

**Release:** [v1.6.33 on GitHub](https://github.com/deadinternetfox/frogtalk/releases/tag/v1.6.33) (APK + AAB attached).

## Website download endpoints

- https://frogtalk.xyz/download/android
- Your node: `https://<host>/download/android`
