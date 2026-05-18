# Security scan triage — 2026-05-18

Findings from the automated security scanner, triaged. Three buckets:

- **REAL** — actionable, fix in this pass.
- **FALSE POSITIVE** — pattern-match mistake, no action needed (kept here as a
  paper trail so the next run doesn't surprise us).
- **DEFER** — real-ish but needs tooling we don't want to run from this
  conversation (e.g. gradle lockfiles in CI).

---

## REAL (fix in this pass)

### R1 — `pillow` CVE (Critical)
`requirements.txt` pins `Pillow>=10.0.0`. CVE-2024-28219 (buffer overflow in
`_imagingcms`) is patched in **10.3.0**; further memory-corruption fixes land
in 11.x. Bump floor to `>=11.0.0`.

### R2 — `cryptography` advisory (Medium)
`>=42.0.0` is below recent GHSA-h4gh-qq45-vh27 patch. Bump to `>=44.0.1`.

### R3 — `python-multipart` DoS (Low)
`>=0.0.9` predates GHSA-59g5-xgcq-4qw3. Bump to `>=0.0.18`.

### R4 — Hardcoded Android signing password (High)
`android/app/build.gradle.kts` lines 14/16: `storePassword = "frogtalk123"`,
`keyPassword = "frogtalk123"`. Switch to gradle properties /
environment variables so the secret doesn't live in the repo.

### R5 — `tempfile.mktemp` in `routers/federation.py` (Medium)
`routers/federation.py:486` uses `tempfile.mktemp(...)` which has a
TOCTOU race (path is generated but not exclusively created — an attacker on
the same host can pre-create it as a symlink). Replace with
`NamedTemporaryFile(delete=False, ...)`.

### R6 — Docker runs as root (Medium)
`Dockerfile` has no `USER` directive. Add a non-root `app` user and
`USER app` near the bottom.

### R7 — Android `allowBackup="true"` (Medium)
`AndroidManifest.xml`: change to `android:allowBackup="false"`. Our app
stores session tokens, PIN hashes, and signal keys in app-private storage;
those must not be exfiltrable via `adb backup`.

### R8 — Defence-in-depth: SSRF guard in `routers/auth.py` (Medium)
`_post_json`/`_get_json` are used for federated login. Peer URLs come from
admin-controlled config, but add a small allowlist guard that rejects
loopback / link-local / RFC 1918 / IPv6 ULA so a compromised admin
account can't probe internal infra.

### R9 — Defence-in-depth: friend-sound path resolve (Medium)
`routers/friends.py` serves `FileResponse(fp)` where `fp` is read from a
DB row. Today the path is written only by our own upload handler so it's
clean — but adding a `fp.resolve().is_relative_to(_SOUND_ROOT.resolve())`
check is cheap and protects against future bugs.

---

## FALSE POSITIVE (documented, no change)

### F1 — "GCP API key in `routers/gifs.py`" (Medium)
The scanner flagged `"key": TENOR_API_KEY` as a hardcoded key. `TENOR_API_KEY`
is a module-level variable loaded from `os.getenv("TENOR_API_KEY")`. No
secret in the repo.

### F2 — "`document.write` in `static/js/calls.js`" (High)
No `document.write` or `document.writeln` exists in `calls.js`. The
scanner appears to confuse a template literal or `innerHTML` assignment.

### F3 — "Insecure jQuery sinks in `static/js/pin.js`" (Medium)
The only `innerHTML` references in `pin.js` are inside the file-level
comment block explaining that `pin.js` deliberately avoids `innerHTML`.
We use `textContent` / DOM APIs throughout.

### F4 — "Overly broad GitHub Actions permissions" (Medium)
`.github/workflows/docker-publish.yml` already declares
`permissions: { contents: read, packages: write }` at the top level — the
minimum required to push to GHCR. This is the least-privilege configuration.

### F5 — "SQL injection in `database.py`" (High)
Every f-string `execute(f"... SET {fields} WHERE id=?", values)` builds
column names from an internally hardcoded whitelist (e.g. `pin_require_for_admin`,
`profile_public`); user-supplied **values** are bound with placeholders.
No user input reaches the f-string interpolation.

### F6 — "Android `MainActivity` exported=true" (Medium)
`MainActivity` MUST be `exported=true` — it carries the `MAIN`/`LAUNCHER`
intent filter. Targeted at the launcher (Play Store, Pixel Launcher, etc.).
All other components (`CallService`, `MusicService`, FCM service,
`CallDeclineReceiver`) are already `exported=false`.

### F7 — "iOS `WKWebView` JavaScript enabled" (Low)
The iOS app is a thin `WKWebView` wrapper that ships our own SPA from
`frogtalk.xyz`. Disabling JS would brick the whole client. We restrict
navigation to our origin in `webView:decidePolicyForNavigationAction` and
inject the `NativeBridge` user script at document-start.

### F8 — "Path traversal in `board/board_preview.php`" (Medium)
The cache filename is built from `preg_replace('/[^a-zA-Z0-9]/', '', $threadId)`
— alphanumerics only, no `.` or `/`. The `$boardMode` branch uses the
hardcoded literal `'board_index'`. No traversal vector.

### F9 — "File inclusion in `routers/server_admin.py`" (Medium)
Every `open(...)` in `server_admin.py` resolves to a hardcoded module
constant or `os.path.join(<absolute-module-dir>, "board", "board_data", "<literal>.json")`.
No user-controlled segment.

---

## DEFER (not in this pass)

### D1 — Gradle lockfiles missing
Generating lockfiles needs `./gradlew dependencies --write-locks` to run
inside `android/` with a working JDK 17 + Android SDK. Worth doing, but
out of scope for a security-fix pass on the server. Tracked as a separate
task.

---

## Cache-buster / commit plan

This pass only touches:
- `requirements.txt` (R1, R2, R3) — server reinstall needed.
- `android/app/build.gradle.kts` (R4) — no server impact.
- `routers/federation.py` (R5) — server restart.
- `Dockerfile` (R6) — image rebuild only.
- `android/app/src/main/AndroidManifest.xml` (R7) — no server impact.
- `routers/auth.py` (R8) — server restart.
- `routers/friends.py` (R9) — server restart.

No static JS / HTML changes, so no cache-buster bumps required.
