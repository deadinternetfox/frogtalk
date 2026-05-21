# FrogTalk Security & Encryption Model

_Last updated: 2026-05-21_

This document describes FrogTalk's security and encryption architecture as it
ships in production. If something here disagrees with the code, the code wins —
please open a PR.

---

**Android calls / FCM:** see [ANDROID_CALLS_SECURITY.md](./ANDROID_CALLS_SECURITY.md).

## TL;DR

| Surface | Crypto | Server can read? | Federates to peers? |
| ------- | ------ | :--------------: | :-----------------: |
| Direct messages | Signal Protocol (X3DH + Double Ratchet) | No | Metadata + ciphertext envelope only |
| Private channels | Per-room AES-256-GCM (HKDF from shared secret) | No | Room messages when room exists on peer |
| Public channels | Plaintext (world-readable by design) | Yes | Yes (plaintext) |
| Voice / video calls | WebRTC DTLS-SRTP + signed fingerprint | No | Signalling metadata only |
| Wall — public / followers | Plaintext locally; optional client-side rich media | Yes | **Yes** — `social.post.created` |
| Wall — friends / private | Per-post AES-256-GCM + Signal-wrapped keys | No | **Encrypted path only** — never plaintext private |
| Bridged channels | Plaintext on FrogTalk side | Yes | N/A (bridge-local) |
| Linked devices | Per-device Signal sub-identities (Phase 1) | No | Device records via signed `user.*` |

The server stores ciphertext for every "No" row. There is no master key, no key
escrow, and no recovery key for DM or wall ciphertext — losing all devices loses
that history.

---

## 1. Identity

Every account has a long-term **Curve25519 identity key** generated on first
login. The private half lives in:

- **Web / desktop:** IndexedDB, in the origin-isolated Signal store.
- **Android:** Android Keystore (hardware-backed when available).
- **iOS:** iOS Keychain.

Only the public half is uploaded. It's published in your **prekey bundle**
alongside a signed prekey and a refillable batch of one-time prekeys, served by
`/api/signal/bundle/{user_id}`.

The in-app **🔒 Encryption info** modal shows the SHA-256 fingerprint of your
public identity ("This device") and, for DMs, the **Safety Number** derived from
both parties' identities. Compare it out-of-band with your peer to detect MITM.

Federation uses a separate **server Ed25519 key** (`crypto_fed.py`) for signing
outbox events. Peers pin that pubkey before accepting sensitive event types.

---

## 2. Direct messages — Signal Protocol

DMs use **X3DH + Double Ratchet**:

1. **X3DH** on first message: fetch peer bundle, run multi-DH, derive session root.
2. **Double Ratchet** on every message: forward secrecy and break-in recovery.
3. **AEAD:** AES-256-GCM with envelope `{v:2, t:'pre'|'msg', b:'<base64>'}`.

The server stores the envelope verbatim — never plaintext, ratchet state, or
message keys. Federated DMs replicate as signed `dm.message.created` events;
content remains ciphertext in the payload.

**Verification:** Safety Number in the 🔒 panel; identity change toasts on reinstall.

---

## 3. Channel messages — per-channel AES-256-GCM

Channels use a simpler model than DMs because trust is membership-based, not 1:1.

- **Private channel:** Shared 32-byte AES-256-GCM key via **HKDF-SHA-256** from a
  channel secret. New members receive the secret over a **Signal DM** with the
  inviter — the server never sees plaintext.
- **Public channel:** No shared key; messages stored and broadcast in plaintext.
- **Wire format:** `{"iv":"…","ct":"…"}` JSON stored verbatim.

### Private channel access (invite + secret)

- **Server gate:** Membership requires a valid invite link (`POST /api/invites/{code}/join`).
  The shared secret is **never** sent to the server on join or create.
- **Client gate:** After join, the client prompts for the shared secret. If the user
  cancels, the client calls `POST /api/rooms/{name}/leave` and membership is rolled back.
- **Wrong secret:** The server cannot verify passphrase correctness without storing a
  verifier (which would break E2EE). A member with a wrong secret remains in
  `room_members` but cannot decrypt history; only the correct secret derives the AES key.
- **`room_key_hint`:** Optional human-readable reminder stored on the server (max 512
  chars, sanitized). It must **not** contain the full secret.
- **Local storage:** Remembered room secrets are wrapped with a per-device AES-GCM key
  in IndexedDB (`ftls1:` prefix in localStorage). XSS with full script access can still
  unwrap them; this is defense-in-depth vs extension/localStorage scrapers only.
- **Join probe:** After join, the client samples recent ciphertext; if none decrypt,
  membership is rolled back (wrong secret). Empty channels skip the probe.

### Why not libsignal Sender Keys for channels

Track C (Sender Keys) shipped in early 2026 and was **reverted 2026-05-20**
(commit `24490ab`). libsignal's `GroupCipher` cannot decrypt its own send chain,
which conflicts with immediate local bubble rendering. We kept per-room AES until
own-message decrypt is solvable without fragile plaintext caches.

Trade-off: no per-message forward secrecy inside a channel; compromise of one
room key affects only that channel, not the whole identity.

---

## 4. Voice & video calls — DTLS-fingerprint signing

- Media: **DTLS-SRTP** (WebRTC).
- Signalling MITM closed by signing each SDP DTLS fingerprint with the **Signal
  identity key** (XEdDSA); mismatch aborts the call.
- Group calls: same verification pairwise across participants.

---

## 5. Wall posts — local encryption and federation

### On one node

The wall supports `privacy`: `public`, `followers`, `friends`, `private`.

| Privacy | Stored on origin server | Client crypto |
| ------- | ----------------------- | ------------- |
| `public` | Plaintext | Optional rich media only |
| `followers` | Plaintext | Same |
| `friends` / `private` | Ciphertext + per-recipient wraps | AES-256-GCM per post; keys wrapped via Signal to each recipient |

Friends-only and private posts use `POST /api/wall/posts/encrypted` and
`POST /api/wall/posts/{id}/wrapped-keys`. The server stores `ciphertext_b64` and
opaque `wrapped_keys` blobs — it cannot read post bodies.

When someone new follows or a friend request is accepted, the author client may
extend wraps (`social.post.keys.extended` federation + `wall_rewrap_needed` over
WebSocket) so the peer can decrypt older encrypted posts.

### Across the federation mesh

Replication is **opt-in per event type** and **privacy-aware**:

| Event | What crosses the wire | When |
| ----- | --------------------- | ---- |
| `social.post.created` | Plaintext body + metadata | Only `privacy` `public` or `followers` |
| `social.post.created.encrypted` | `ciphertext_b64` + scoped `wrapped_keys[]` | Friends / private audiences |
| `social.post.keys.extended` | Additional wraps for homed recipients | After follow / friend accept |
| `social.comment.created`, `social.reaction.changed`, `social.repost.created` | Engagement metadata | Only if post is already mapped on peer (`federation_wall_map`) |
| `social.post.deleted` | Tombstone | Author ownership verified on mapped row |

**Never federated:** plaintext `private` posts; remote `force_delete`; full
recipient wrap lists to peers that do not host those users.

**Targeted outbox:** Encrypted posts and key extensions enqueue **one row per peer
`server_id`** that hosts at least one recipient. Each push carries only wraps for
users homed on that node (`event_id` suffix `@<peer_server_id>`). Public posts
still use broadcast outbox rows.

**Origin binding:** `author_global_user_id` / `actor_global_user_id` must be UUID v4;
for `social.*`, the actor's **home server** must match `origin_server_id` unless a
handler explicitly relaxes checks. Inbound apply does **not** create local users from
nicknames in wraps — recipients must already exist (matched by `global_user_id`).

Cross-node friends therefore need: mutual follow/friend graph sync, encrypted post +
wraps, and often a re-wrap after the relationship exists on both sides. Details:
[API reference](https://frogtalk.xyz/docs/api) (Federation section).

### Federated voice and video calls

When `FROGTALK_FEDERATION_CALLS_ENABLED=1`, signed `call.*` events carry WebRTC
signaling (offer/answer/ICE) to a peer’s **home server**; media remains P2P or
TURN. DM calls keep **Signal-signed DTLS fingerprints** (`fp_sig`). Channel voice
uses federated `voice.session.*` / `voice.signal` mesh v1 (no `fp_sig` on group
audio). Per-node TURN is published via `/api/network/ice-config`. Full spec:
[FEDERATED_CALLS.md](FEDERATED_CALLS.md).

---

## 6. Linked devices — Track F Phase 1

Up to **5 secondary devices** + primary. Each device has its own Curve25519 identity
signed by the primary (XEdDSA). DM send encrypts to all active devices of recipient
and sender (self-sync). Revocation blacklists the device at the bundle layer.

Phase 1: backend storage + management endpoints. Phase 2: full multi-device
fanout-on-send in clients.

---

## 7. Bridges — explicit plaintext

Discord and Telegram bridges require **plaintext** on the FrogTalk side. Bridged
channels show a bridge badge; **private rooms cannot be bridged**; DMs are never
bridged. Per-bridge random tokens; inbound `data:` URLs capped at 8 MB.

---

## 8. Transport, sanitization, and other defences

- **HTTPS** in production; HSTS; secure cookies; CSRF double-submit on mutating routes.
- **Tor:** optional onion URL; outbound peer HTTP via SOCKS when enabled.
- **CSP** with per-request nonce from FastAPI (nginx must not duplicate CSP on app routes).
- **CSS sanitizer** for user themes — [node/routers/_css_inline.py](../node/routers/_css_inline.py).
- **Media safety** — re-encode uploads, strip EXIF, server-side MIME sniff.
- **Rate limits** (slowapi), including federation inbox (600 events / 60s per origin).
- **Push** — tokens only; notification payloads avoid message plaintext.

---

## 9. What the server can see

Not end-to-end encrypted (by design or necessity):

- **Metadata:** who talked to whom, when, sizes, presence, typing, federation event types.
- **Public channels** and **bridged channels:** message bodies.
- **Wall `public` / `followers`:** bodies on origin and on any peer that received `social.post.created`.
- **Federated engagement:** comment/reaction text on replicated posts (if plaintext post).
- **Profiles:** nicknames, avatars, bios, friend/follow graph edges needed for UX.
- **Encrypted wall:** ciphertext and wrap blobs (not keys or plaintext).

A breach or lawful access can expose the above. It cannot derive DM plaintext,
private channel bodies, call media, or encrypted wall bodies without endpoint keys.

---

## 10. Threat model boundaries

**We protect against:**

- A hostile FrogTalk server reading E2EE message and encrypted wall content.
- Signalling MITM on calls (fingerprint signing).
- Passive network observers on TLS (and Tor where used).
- Forward secrecy in DMs; channel key scoped to one room.
- Cross-peer impersonation on signed federation events (origin + pinned pubkey).
- Unsigned or wrong-origin `social.*` / `dm.*` / `friend.*` inbox spam when sigs required.

**We do not protect against:**

- Compromised endpoint with unlocked Signal store.
- Coerced unlock — use panic-wipe if needed.
- Traffic analysis ("A and B were active this week").
- Channel member screenshotting or re-sharing.
- A peer server that lies about **its own** signed events (pin pubkeys out-of-band for high assurance).

---

## 11. Platform and federation hardening

Server-side controls (see also [frogtalk.xyz/security](https://frogtalk.xyz/security)):

| Area | Behaviour |
| ---- | --------- |
| **Federation auth** | `FROGTALK_FEDERATION_REQUIRE_SIGS=1` default; sensitive prefixes (`social.`, `dm.`, `friend.`, `user.`, …) need valid Ed25519 + pinned peer pubkey |
| **Inbox** | Idempotent on `(origin_server_id, event_id)`; clock skew window; payload size caps |
| **Social apply** | Sanitized payloads; no remote `force_delete`; engagement handlers verify mapped post author |
| **Encrypted fan-out** | Per-peer outbox rows; `filter_encrypted_wraps_for_peer` before push; empty-wrap deliveries dropped |
| **Updates** | `FROGTALK_AUTO_UPDATE_ENABLED=0`; manifests verified against `FROGTALK_RELEASE_SIGNERS` |
| **Auth** | Login lockout, bcrypt recovery keys, dummy hash on unknown user; empty default `ADMIN_PASSWORD` |
| **Admin** | `admin_pin_gate` on admin routes; separate server-admin session |
| **Bots** | Permission allowlist, key cap, room membership checks |
| **WebRTC** | ICE / SDP bound to open call participants |

Operator setup: [node/deploy/README.md](../node/deploy/README.md),
[node/README.md](../node/README.md).

---

## Change history

- **2026-05-21** — FrogSocial federation: signed `social.*`, plaintext replication
  limited to `public`/`followers`, encrypted cross-node wall with targeted wraps,
  origin binding, no nickname-only user materialization on apply.
- **2026-05-20** — Runtime tree under `node/`; Track C (Sender Keys) reverted;
  channels on per-room AES-256-GCM; full message/DM wipe on nodes.
- **2026-05-xx** — Wall per-post AEAD + Signal-wrapped keys per follower.
- **2026-04-xx** — Track F Phase 1 (linked devices).
- **2026-03-xx** — Safety Numbers in 🔒 panel.
- **2026-02-xx** — DM v2 Signal envelope only; v1 legacy AES removed.
