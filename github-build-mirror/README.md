# FrogTalk Build Mirror

Build artifacts for FrogTalk **v1.6.49-alpha** (Android `versionCode` **255**).

Default home node: **frogtalk.app** (`client/official-node.json` on `master`).

Mirrored here as long as each file fits GitHub's free per-file limit (the APK +
AAB both do). They are also attached to the matching
[GitHub Release](https://github.com/deadinternetfox/frogtalk/releases/latest), and
the APK is served directly from every node at `/download/android`.

## Download artifacts

### Android (v1.6.49-alpha / 255)

| Artifact | File | Use |
|----------|------|-----|
| **APK (sideload)** | [frogtalk-v255-alpha.apk](./frogtalk-v255-alpha.apk) · [download](https://frogtalk.app/download/android) | Direct install |
| **AAB (Play Store)** | [FrogTalk-1.6.49-alpha-255.aab](./FrogTalk-1.6.49-alpha-255.aab) | Google Play Console upload |

**Run a node (Docker):** `docker compose up -d` — see [/docs/run-a-node](https://frogtalk.app/docs/node).

### Verify integrity

```bash
sha256sum -c SHA256SUMS.txt
```
