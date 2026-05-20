# FrogTalk security hardening plan (2026-05)

Tracking doc for the post-audit hardening pass. Every item lists: severity,
the file the audit pointed at, what we verified, and what we shipped.

Status legend: `[ ]` pending, `[x]` done, `[~]` partially done / deferred.

---

## CRITICAL  *(all shipped this pass)*

### CRIT-1 — Discord bridge accepts the literal token `"discord"`  `[x]`
- Files: `routers/bridge.py:696, 780`, `bridge_discord.py`.
- Verified: confirmed via grep — `bot_token="discord"` is hardcoded in **both**
  Discord-bridge create paths and `db.bridge_token_matches` does a plain
  `compare_digest`, so any caller who knows the room name can forge inbound
  messages.
- Fix:
  - Generate `secrets.token_urlsafe(32)` per bridge on create.
  - Auto-rotate any existing `bot_token IN ('discord','')` row on boot.
  - Discord bridge process posts to `/api/bridge/message` using the
    per-bridge secret it looks up in the DB; the inbound auth keeps the
    existing `bridge_token_matches` path.

### CRIT-2 — Federation accepts unsigned events by default + global UNIQUE on `event_id`  `[x]`
- Files: `routers/federation.py:1097-1136`, `database.py:1898-1906`.
- Verified: `FROGTALK_FEDERATION_REQUIRE_SIGS` defaults to `0`; non-sensitive
  events from origins with no pinned pubkey are accepted unsigned.
  Idempotency on inbox uses a global `event_id UNIQUE` so two peers can
  collide.
- Fix:
  - Default `FROGTALK_FEDERATION_REQUIRE_SIGS=1`.
  - Reject events from origins with no `server_pubkey` pinned.
  - Add composite UNIQUE `(origin_server_id, event_id)` and drop the
    legacy index after backfill.

### CRIT-3 — Auto-update is on by default + release feed is not signed  `[x]`
- Files: `routers/federation.py:828, 875, 365-511`.
- Verified: `FROGTALK_AUTO_UPDATE_ENABLED` defaults to `"1"`; apply path runs
  `rsync` + `systemctl restart`. Manifest only carries `package_sha256`,
  not a signature.
- Fix:
  - Default to `0` for `FROGTALK_AUTO_UPDATE_ENABLED`.
  - Require `FROGTALK_RELEASE_SIGNERS` (Ed25519) and verify the manifest
    signature before downloading/applying.
  - Enforce version monotonicity.

### CRIT-4 — Federation auto-creates local users/rooms  `[x]`
- Files: `routers/federation.py:1814-1837, 2247-2257`.
- Verified: `_ensure_local_user_by_nickname` calls `db.create_user(...)`
  with a random password; the inbox-applier creates rooms with a system
  owner if a federated `room.member.joined` references an unknown room.
- Fix:
  - `_ensure_local_user_by_nickname` returns `None` for unknown nicks; the
    inbox applier drops the event instead of creating shadow users.
  - Same for unknown rooms (no auto-create).

---

## HIGH

### HIGH-1 — `pin_require_for_admin` is client-only  `[x]`
- Files: `static/js/pin.js:633`, `routers/admin.py`, `deps.py:262`.
- Verified: only `pin_gate` is wired; `pin_require_for_admin` lives in the DB
  but is never read on the server.
- Fix: add `admin_pin_gate` dependency, apply it to `routers/admin.py` and
  to the server-admin mount. Track per-session "admin grace" separately.

### HIGH-3 — External API leaks rooms/messages to any `read` key  `[x]`
- Files: `routers/external_api.py:219-238, 247-287, 442-475`.
- Verified: `GET /channels` returns `db.get_all_rooms()`; `GET /channels/{name}/messages`
  only checks `read` permission; `POST /dm` doesn't check blocks.
- Fix: require `bot_in_channel` for bot keys, `user_can_access_room` for
  user keys; honor blocks on bot DMs.

### HIGH-5 — Auth hygiene gaps  `[x]`
- Files:
  - `routers/auth.py:646-665` (login rate limited only per IP).
  - `routers/auth.py:1570` (recovery key stored as SHA-256).
  - `routers/server_admin.py:557-611` (no `@limiter` on login).
  - `routers/server_admin.py:75-77` (server-admin password compared from env in plaintext).
  - `deploy/env.example:22`, `.env.example` (weak default admin password).
- Verified all of the above.
- Fix:
  - Add per-account login lockout (counter + `locked_until`).
  - Rate-limit `/api/server-admin/login`.
  - Run bcrypt against a dummy hash on missing-user login to kill the
    timing oracle.
  - bcrypt the recovery key at rest; fallback to legacy SHA-256 for old rows.
  - Remove the `ADMIN_PASSWORD=change_me_now_123!` default; ship empty
    so the random-bootstrap path runs.

### HIGH-6 — WebRTC ICE/SDP not bound to call participants  `[x]`
- Files: `routers/ws.py:880-922, 1006-1043, 1202-1228`.
- Verified: `ice_candidate`, `call_offer`, `call_answer` forwarded by sender
  intent without checking the `calls` row.
- Fix: validate `call_id` exists, sender is caller/callee, and the call is
  not closed before relay.

### HIGH-9 — API key permissions self-grant + no creation cap + no pepper  `[~]`

Permission allowlist + per-user cap shipped. Storage-pepper deferred —
needs a co-ordinated rollout (existing keys are SHA-256 only, so peppering
inline would invalidate every live token).
- Files: `routers/bots.py:54-92`, `database.py:5881-5909`.
- Verified.
- Fix: allowlist permissions to `{read, write, dm, bot}`; cap keys per user
  to 20; pepper the SHA-256 with `FROGTALK_API_KEY_PEPPER` (fallback to
  unpeppered lookup for legacy rows for a grace period).

### HIGH-10 — Bridge edit/delete unrate-limited; inbound `data:` size unbounded  `[x]`
- Files: `routers/bridge.py:809 vs 1059-1191`, `routers/bridge.py:854-855`.
- Verified.
- Fix: add `@limiter.limit("120/minute")` to edit/delete; cap any inbound
  `data:` URL at 8 MB.

### HIGH-11 — `register_network_server` lets any token holder set `official=True`  `[x]`
- Files: `routers/federation.py:912-933`.
- Verified.
- Fix: strip `official`/`trust_tier` from the request body in the
  federation-token path; only the local server-admin UI can set them.

### HIGH-12 — Federation HTTP responses unbounded in memory  `[x]`
- Files: `routers/federation.py:200-223, 335-345, 543-549`.
- Verified.
- Fix: stream with a hard byte cap; reject responses larger than the limit
  before parsing JSON. Tighter cap for JSON, looser cap for update packages.

### HIGH-13 — `type=private` not enforced; `invite_only` is the only real gate  `[x]`
- Files: `database.py:5273-5307`, `routers/rooms.py:588-615`.
- Verified.
- Fix: server-side invariant — `type='private' ⇒ invite_only=1` on create
  and update; `user_can_access_room` fails closed on private for
  non-members.

### HIGH-14 — Tor mode env split + clearnet leaks on Tor nodes  `[x]`
- Files: `main.py:806`, `routers/federation.py:246-247`, `geoip.py:88-93`,
  `routers/proxy.py`, `routers/preview.py`.
- Verified.
- Fix: route all outbound httpx through SOCKS when Tor mode is on; skip
  geoip on Tor mode; treat `FROGTALK_TOR_MODE` and `FROGTALK_TOR_ENABLED`
  as equivalent fall-throughs so legacy configs Just Work.

### HIGH-15 — `register_build_manifest` stores signatures but never verifies them  `[x]`
- Files: `routers/federation.py:1285-1314`, `database.py:9248-9283`.
- Verified.
- Fix: require an Ed25519 signature pinned via `FROGTALK_RELEASE_SIGNERS`
  before insert; refuse `official=True` from federation-token holders.

### HIGH-4 — WebSocket handler runs SQLite + push on the event loop  `[~]`

Push notifications now run on a bounded thread pool (32 concurrent),
which was the worst offender — FCM/APNs round-trips of 300–1500 ms used
to freeze the event loop. The remaining sync `db.*` calls inside the
WS message loop are scoped follow-up: they're a few ms each and need a
careful audit pass before wrapping them with `asyncio.to_thread`, since
some return values are mutated in place.
- Files: `routers/ws.py:87-105` and the message-loop call sites.
- Verified.
- Fix:
  - Wrap every `db.*` call inside `routers/ws.py` with `asyncio.to_thread`.
  - `_push(...)` becomes `asyncio.create_task(asyncio.to_thread(send_push, ...))`
    bounded by a semaphore.

### HIGH-2 — Session token in `localStorage`/URL; no `HttpOnly` cookie  *(deferred)*
- Migration risk: every existing client carries an `fc_token` in
  `localStorage`. Cookie cutover requires UX work + grace period.
- Plan: open a follow-up issue; do not ship in this pass.

### HIGH-7 — CSP report-only + `'unsafe-inline'`  *(deferred)*
- Same logic as HIGH-2: enforcing CSP without first migrating inline
  handlers will break the SPA. Open a follow-up issue.

---

## MEDIUM (this pass)

- `[x]` MED-A1: bcrypt dummy hash on missing user in `verify_user`.
- `[x]` MED-E1: DM reactions emoji allowlist (mirror `messages` / `wall`).
- `[x]` MED-A8: revoke sessions by ≥16-char id scoped to `user_id`.
- `[x]` MED-D1: composite idempotency index on federation inbox
  (`origin_server_id, event_id`) + status/received_at perf indexes.
- `[x]` MED-F1: prune sessions older than 60 days in the cleanup tick.
- `[ ]` MED-F4: in-memory cache for GIF search responses (deferred).
- `[x]` LOW-G1: `.dockerignore`.
- `[x]` LOW-G3: nginx upstream aligned with the env `PORT` default (8080).
- `[~]` LOW-G4: HSTS still hardcoded because production runs behind
  Cloudflare (origin is HTTP and `$scheme` would mis-classify). nginx
  comment now spells this out.
- `[x]` LOW-G6: SSH `accept-new` (records the first key, refuses
  changes) plus explicit `UserKnownHostsFile` in deploy scripts.
- `[x]` LOW-I1: `details` now fetched before
  `create_discord_bridge_endpoint` uses it.

---

## PHP imageboard (`board/`) — SECURITY-PASS-3  *(2026-05-20)*

Commit `af98fcd` + `.htaccess` defense-in-depth. Deploy with
`bash scripts/deploy_board.sh` (not `scripts/deploy_nodes.sh`, which
only syncs static assets).

### CRITICAL  `[x]`

- **BOARD-CRIT-1 — Free GOYIM bump inflation:** `goyim_bump` now requires
  CSRF, valid Solana pubkey, on-chain SPL transfer verification
  (`verifyGoyimSplTransfer`), tx-hash dedupe ledger, and server-side
  holder re-check.
- **BOARD-CRIT-2 — Tor gateway bypass via spoofed headers:** `isTorRequest()`
  trusts `X-Tor-Client` / `X-Onion-Host` only when `REMOTE_ADDR` is a
  trusted proxy and `BOARD_TOR_HEADER_TRUSTED=1` in `/board/.env`.
- **BOARD-CRIT-3 — Hardcoded admin password:** `BOARD_ADMIN_USER` /
  `BOARD_ADMIN_PASS_HASH` from env; `boardIsDefaultAdminPass()` warns on
  factory hash.

### HIGH  `[x]`

- CSRF on `like`, `link_wallet`, `board_likes.php`, `goyim_bump`,
  `check_goyim_holder` (JS passes meta token).
- `check_goyim_holder` rate-limited + 60s per-wallet RPC cache.
- Federation peer fetch via `boardFetchPeerJson()` (public IP only,
  redirect cap, size cap, curl protocol lock).
- Trusted-proxy gating for `CF-Connecting-IP` / `X-Forwarded-For`.
- Subject + wallet escape-at-render; live-reply wallet JS escaped.
- Admin media deletes use `boardSafeUnlinkUpload()`.
- Removed legacy **Katsa** OSINT widget builders (separate project).

### MEDIUM  `[x]` / `[~]`

- `[x]` `formatPostText` autolink: `htmlspecialchars` on `href`, `rel=ugc`.
- `[x]` `createThumbnail` refuses undecodable images (no raw `copy()` fallback).
- `[~]` `temp_upload`: MIME-derived extensions, 10-minute GC TTL; still
  served under `/board_uploads/temp/` (move outside webroot deferred).
- `[x]` Chat voice: audio MIME only (dropped `video/webm` from voice allowlist).
- `[x]` Admin logout: POST + CSRF (was GET `?action=logout`).
- `[x]` Chat fetch strips `ip_hash` for non-admins.
- `[x]` Likes/views: `boardWithJsonLock()`; bump thread only on net-new like.
- `[x]` `boardValidSolanaAddress()` base58 check.
- `[x]` `telegram_bot.php` uses shared `boardLoadEnv()`.
- `[x]` `board_data/` created `0750`; upload/preview/data `.htaccess` deny rules.

### Deploy / verify (board)

1. `bash scripts/deploy_board.sh` — SCP all board PHP + `.htaccess` to
   `161.97.182.73:2222` and `31.220.92.120:22`, then `php -l` each entry file.
2. Smoke: `/board` loads; admin logout is a form POST; liking a thread
   requires CSRF; `goyim_bump` without `tx_hash` returns error for non-admin.

---

## DEFERRED to a later cycle

- HIGH-2: HttpOnly cookie session migration.
- HIGH-7: CSP enforce + nonces.
- Federation per-peer auth (replace shared bearer).
- Media off SQLite (data migration).
- Replace nickname "emoji fingerprint" UI with Signal safety number only.
- PHP imageboard isolation / replacement.

---

## Deploy steps for this pass

1. Run `pytest`.
2. Commit in logical chunks (CRIT/HIGH/MED/ops).
3. `git push origin master`.
4. App/static: `bash scripts/deploy_nodes.sh` (or rsync via `deploy.sh`).
   Board PHP: `bash scripts/deploy_board.sh`.
5. After deploy, verify:
   - `/api/network/status` reports `update_available=false`.
   - Posting `{platform:"discord",bridge_token:"discord",...}` against
     `/api/bridge/message` returns 401.
   - Server-admin login: 6th attempt within 15 min returns 429.

