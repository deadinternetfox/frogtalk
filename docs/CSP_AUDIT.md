# FrogTalk CSP Audit

_Last audited: 2026-05-21_

## Source of truth

| Layer | File | Role |
| ----- | ---- | ---- |
| App HTML/JS | `node/main.py` → `_build_csp_header()` | Single CSP for `/app` and API HTML shells |
| Static assets | `node/deploy/nginx.conf` `location /static/` | Tight CSP on versioned JS/CSS (no inline) |
| User media | `node/routers/_media_safety.py`, nginx `/media/` | `default-src 'none'; sandbox` |
| Board (PHP) | `node/board/board_config.php` | Separate legacy CSP (not unified with FastAPI) |

Nginx must **not** duplicate `Content-Security-Policy` on app routes (see `node/deploy/README.md`).

## Enforced policy (Phase A)

```
default-src 'self';
script-src 'self' 'unsafe-inline' https://frogtalk.xyz;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com data:;
img-src 'self' data: blob: https:;
media-src 'self' data: blob: https:;
connect-src 'self' wss: https://api.klipy.com … https://tenor.googleapis.com …;
frame-src 'self' https://www.youtube.com https://open.spotify.com https://platform.twitter.com;
frame-ancestors 'self';
base-uri 'self';
form-action 'self';
object-src 'none';
worker-src 'self' blob:
```

Toggle: `FROGTALK_CSP_ENFORCE=0` → report-only. Tests: `node/tests/test_security_pass_2.py` (`CSPTests`).

## What is already strong

- **`object-src 'none'`** — blocks Flash/plugin gadgets.
- **`base-uri 'self'`** — blocks base-tag hijack of relative URLs.
- **`form-action 'self'`** — limits form exfiltration targets.
- **`frame-ancestors 'self'`** — clickjacking protection (paired with `X-Frame-Options: SAMEORIGIN`).
- **Narrow `frame-src`** — embeds limited to YouTube / Spotify / Twitter widgets.
- **Per-request nonce** generated (`request.state.csp_nonce`) but **not yet emitted** in directives (correct for Phase A — adding nonce without tagging every inline block would break the site).
- **Static `/static/`** served with script-src `'self'` only (no inline) — XSS in app shell cannot weaken cached JS CSP.

## Residual risk (Phase A)

| Risk | Severity | Notes |
| ---- | -------- | ----- |
| `'unsafe-inline'` on script-src / style-src | **High** for XSS | ~hundreds of inline handlers and inline styles in `index.html`. Any stored/reflected XSS can run script. Mitigation today is input sanitization, DOM APIs on sensitive UI (invites), and escHtml on dynamic HTML. |
| `img-src https:` | Medium | Any HTTPS image host can be loaded (tracking pixels, exfil via image URLs). |
| `connect-src` third-party GIF CDNs | Low | Klipy + Tenor only; no arbitrary `connect-src *`. |
| Duplicate CSP if nginx misconfigured | Medium | Documented; ops must keep app routes on FastAPI-only CSP. |
| Board PHP CSP separate | Medium | Still allows `unsafe-inline`; not in scope of FastAPI middleware. |

## Phase B roadmap (recommended)

1. Migrate inline `onclick=` / `on*` to `addEventListener` (or delegated listeners).
2. Move inline `style="…"` to CSS classes.
3. Emit `nonce` on remaining inline `<script>` / `<style>` and switch to:
   - `script-src 'self' 'strict-dynamic' 'nonce-{nonce}'`
   - `style-src 'self' 'nonce-{nonce}'` (drop `'unsafe-inline'` once all blocks are tagged).
4. Add `report-uri` / `report-to` → `/api/csp-report` (endpoint already allowlisted in `main.py`).
5. Consider tightening `img-src` to `'self' data: blob:` plus an allowlist host if product needs it.

## Related headers (same middleware)

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` (mic/camera/geo scoped to self)
- HSTS on HTTPS / `x-forwarded-proto: https`

## Verdict

CSP is **enforced and materially helpful** for non-inline attack paths, but **not a full XSS barrier** until Phase B removes `'unsafe-inline'`. Room secrets and E2EE keys remain client-side; CSP does not replace secret hygiene or localStorage wrapping (see `docs/SECURITY_MODEL.md`).
