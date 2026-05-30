# FrogTalk Build Mirror

Mirrored Android release artifacts for FrogTalk **v1.6.43-alpha** (Android `versionCode` **249**).

Default home node: **frogtalk.app** (`client/official-node.json` on `master`).

This folder carries only the current Android build (it backs each node's
`/download/android` fallback). **Desktop builds** (Windows / AppImage / .deb) and
older versions live on the [GitHub Releases](https://github.com/deadinternetfox/frogtalk/releases) page.

## Download artifacts

### Android (v1.6.43-alpha / 249)

| Artifact | File | Use |
|----------|------|-----|
| **APK (sideload)** | [frogtalk-v249-alpha.apk](./frogtalk-v249-alpha.apk) | Direct install, `/download/android` |
| **AAB (Play Store)** | [FrogTalk-1.6.43-alpha-249.aab](./FrogTalk-1.6.43-alpha-249.aab) | Google Play Console upload |

### Verify integrity

```bash
sha256sum -c SHA256SUMS.txt
```

## Website download endpoints

- https://frogtalk.app/download/android
- https://frogtalk.app/download/linux
- https://frogtalk.app/download/deb
- https://frogtalk.app/download/windows
