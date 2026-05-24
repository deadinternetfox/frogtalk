# Tor client — build spec (not started)

Track: [FrogTalk repo](https://github.com/deadinternetfox/frogtalk) · `client/tor/`

## Goal

A **stripped, no-JavaScript** FrogTalk client for Tor hidden services:

- Works when JS is disabled or blocked
- Talks to the node REST API over `.onion` only
- No third-party scripts, no analytics, minimal attack surface
- Clearly labeled **pre-alpha / not audited**

## Non-goals (v1)

- Full feature parity with `/app`
- WebRTC voice/video
- Reels, music rooms, rich embeds
- Signal Protocol in the browser without JS (E2E DMs need a later phase or server-assisted model)

## Threat model

- FrogTalk is **pre-alpha** — assume bugs, incomplete hardening, and operator mistakes
- Tor hides network location; it does **not** fix application-layer vulnerabilities
- Users must not treat this client or node as “secure” until independently reviewed

## Milestones

### M0 — Scaffold
- [ ] `client/tor/` static HTML shell + shared CSS
- [ ] Document required env: `FROGTALK_TOR_ENABLED=1`, `FROGTALK_ONION_URL`
- [ ] Link from `node/static/home-tor.html` and `/tor` route

### M1 — Read-only
- [ ] Login form (POST session cookie)
- [ ] Channel list (public rooms)
- [ ] Message history (plaintext public channels only)
- [ ] Logout

### M2 — Write path
- [ ] Post message to public channel (form POST)
- [ ] CSRF token handling per session

### M3 — Account basics
- [ ] Register (if node allows)
- [ ] Profile view (public profiles)

### M4 — Hardening
- [ ] CSP: no `unsafe-inline` where possible
- [ ] Rate-limit friendly error pages
- [ ] Optional `.onion`-only middleware tests

### M5 — E2E (research)
- [ ] Evaluate minimal crypto in WASM vs deferring DMs to “read metadata only” on Tor client
- [ ] Document limitations on `/tor` landing page

## API surface (initial)

Reuse existing node routes (see `/docs/api`):

| Need | Endpoint |
|------|----------|
| Session | `POST /api/auth/login`, `POST /api/auth/logout` |
| Rooms | `GET /api/rooms` |
| Messages | `GET /api/messages/{room}` |
| Send | `POST /api/messages/{room}` (public channels) |

All requests must use relative URLs on the onion origin (no clearnet leaks).

## UX principles

- Plain HTML, semantic labels, works without CSS
- Every page repeats alpha warning + link to `/security`
- No “secure” or “anonymous” marketing language

## Related node work

- `FROGTALK_HOME_PAGE=tor` on onion nodes
- `home-tor.html` landing copy
- Federation: `_builtin_tor_mirror_directory_row()` in `node/routers/federation.py`

## Open questions

1. Server-rendered templates vs static HTML + form POST only?
2. How to surface E2E DM status without JS?
3. Publish as separate path (`/tor/app`) or standalone package?

---

*Last updated: domain migration sprint — client not yet implemented.*
