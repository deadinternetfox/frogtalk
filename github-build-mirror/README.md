# FrogTalk Build Mirror

Build artifacts for FrogTalk **v1.6.44-alpha** (Android `versionCode` **250**).

Default home node: **frogtalk.app** (`client/official-node.json` on `master`).

## Downloads

The **Android APK is too large for free GitHub storage**, so it is served
directly from the nodes — it is **not** kept in git:

- **APK (sideload):** <https://frogtalk.app/download/android>
- **Desktop** (Windows / AppImage / .deb): <https://frogtalk.app/#downloads>
- **Run a node (Docker):** `docker compose up -d` — see [/docs/run-a-node](https://frogtalk.app/docs/node)

Only the smaller **AAB** (Google Play Console upload) is mirrored here:

| Artifact | File | Use |
|----------|------|-----|
| **AAB (Play Store)** | [FrogTalk-1.6.44-alpha-250.aab](./FrogTalk-1.6.44-alpha-250.aab) | Google Play Console upload |

### Verify integrity

```bash
sha256sum -c SHA256SUMS.txt
```
