# FrogTalk Security & Encryption Model

_Last updated: 2026-05-20_

This document describes FrogTalk's current security and encryption architecture
as it actually ships, after the Track-C (libsignal Sender Keys for rooms)
revert and the fresh-start message wipe of 2026-05-20.

If something in this doc disagrees with the code, the code wins — please open
a PR.

---

## TL;DR

| Surface              | Crypto                                                  | Server can read? |
| -------------------- | ------------------------------------------------------- | :--------------: |
| Direct messages      | Signal Protocol (X3DH + Double Ratchet)                 | No               |
| Private channels     | Per-room AES-256-GCM (HKDF-derived from shared secret)  | No               |
| Public channels      | Plaintext (intentionally world-readable)                | Yes              |
| Voice / video calls  | WebRTC DTLS-SRTP, fingerprint signed by Signal identity | No               |
| Wall posts           | Per-post AES-256-GCM, key wrapped via Signal to followers | No             |
| Bridged channels     | Plaintext on the FrogTalk side (bridge needs to read)   | Yes              |
| Linked devices       | Per-device Signal sub-identities (Phase 1)              | No               |

The server stores only ciphertext for everything in the "No" column above. We
have no master key, no key escrow, no recovery key — losing all your devices
loses your DM history.

---

## 1. Identity

Every account has a long-term **Curve25519 identity key** generated on first
login. The private half lives in:

- **Web / desktop:** IndexedDB, in the origin-isolated Signal store.
- **Android:** Android Keystore (hardware-backed when available).
- **iOS:** iOS Keychain.

Only the public half is uploaded. It's published in your **prekey bundle**
alongside a signed prekey and a refillable batch of one-time prekeys, all
served by `/api/signal/bundle/{user_id}`.

The in-app **🔒 Encryption info** modal shows the SHA-256 fingerprint of your
public identity ("This device") and, for DMs, the **Safety Number** derived
from both parties' identities. Compare it out-of-band with your peer to
detect a MITM.

---

## 2. Direct messages — Signal Protocol

DMs use a textbook **X3DH + Double Ratchet** session:

1. **X3DH key agreement.** First message to a peer fetches their published
   bundle and runs X3DH against (identity, signed prekey, one-time prekey).
   The session root key falls out of the multi-DH.
2. **Double Ratchet.** Every subsequent message advances a symmetric chain
   ratchet, and every reply rotates the asymmetric DH ratchet. Compromising
   your private key tomorrow does **not** decrypt yesterday's DMs (forward
   secrecy) and won't decrypt the next message after the next ratchet step
   (post-compromise security / "break-in recovery").
3. **AEAD.** Each message is sealed with AES-256-GCM keyed by the ratchet,
   with the envelope JSON `{v:2, t:'pre'|'msg', b:'<base64>'}` as the
   on-wire format.

The server stores the envelope verbatim. It never sees the plaintext, the
ratchet state, or the message keys.

**Verification.** The Safety Number is a 60-digit fingerprint over both
identity keys, exposed in the 🔒 panel. If a peer's identity ever changes
(reinstall, key reset), a system toast warns you and the safety number
changes.

---

## 3. Channel messages — per-channel AES-256-GCM

Channels (a.k.a. rooms) use a simpler model than DMs because the trust set
is "anyone the channel admin let in", not 1:1.

- **Private channel.** Membership share a 32-byte AES-256-GCM key, derived
  via **HKDF-SHA-256** from a channel shared secret. New members receive the
  shared secret over their **Signal DM session** with the inviter — the
  server never sees it in plaintext.
- **Public channel.** Has no shared key by design — public channels are
  meant to be world-readable (think IRC). Messages are stored in plaintext
  in the DB and broadcast unencrypted.
- **Wire format.** Each message is `Crypto.encrypt(text, roomKey)` →
  `{"iv":"…","ct":"…"}` JSON. Server stores that string verbatim.

### Why we don't use libsignal Sender Keys for channels

We shipped a libsignal Sender-Keys implementation as "Track C" in early 2026
and **reverted it on 2026-05-20** (commit `24490ab`). The architectural
issue was that libsignal's `GroupCipher` cannot decrypt messages produced
by its own sending chain — by design — which is incompatible with our
"show your own bubble immediately" UX. The workarounds (per-message
plaintext caches keyed by ciphertext) created a fragile dance of caches,
SKDM rekey requests, and own-message diagnostics that pulled in more bugs
than they solved. We kept the simpler AES path rather than re-introducing
Sender Keys until we can satisfy the own-message decrypt constraint.

The simpler legacy AES path:

- Is the same primitive (AES-256-GCM) that libsignal uses under the
  Sender-Keys ratchet — we just don't ratchet per-message.
- Doesn't have forward secrecy per-message within a channel, but **does**
  bound the blast radius of a single key compromise to "that one channel",
  not the user's whole identity.
- Lets the user see their own messages without round-tripping the server.

If/when we revisit per-channel forward secrecy, it'll be designed around
the constraint that own-messages must decrypt locally.

---

## 4. Voice & video calls — DTLS-fingerprint signing

Calls use **WebRTC**:

- Media is encrypted end-to-end with **DTLS-SRTP** by WebRTC itself.
- The risk is that a hostile signalling server swaps DTLS fingerprints
  during SDP exchange and MITMs the media. We close that gap by having
  each side sign their SDP's DTLS fingerprint with their **Signal identity
  key** (XEdDSA). The receiver verifies the signature against the pinned
  identity before answering. A mismatch refuses the call.
- The same Safety Number that applies to your DM with this peer also
  applies to the call.

Group calls extend the same model pairwise across the participant mesh.

---

## 5. Wall posts — per-post AEAD wrapped to followers

The social wall is a "limited audience" surface (followers, mutuals,
public). Each post is sealed with a fresh **AES-256-GCM** per-post key.
That key is then wrapped to each follower over the existing Signal DM
session and stored as an opaque blob alongside the ciphertext. Public
posts skip wrapping and live in plaintext.

---

## 6. Linked devices — Track F Phase 1

Each user may link up to **5 secondary devices** + the primary. Each
device has its own **per-device Curve25519 identity** signed by the
primary's identity (XEdDSA). On DM send, the client encrypts to every
active device of the recipient (and every active device of the sender for
self-sync), so a new device picks up the conversation as soon as it's
linked. Revoking a device blacklists its identity at the bundle layer.

Phase 1 ships the dark backend storage + management endpoints. The full
multi-device fanout-on-send is Phase 2.

---

## 7. Bridges — explicit plaintext

Discord and Telegram bridges have to forward the **plaintext** of every
message to the third-party platform, by definition. Channels with an
outbound bridge therefore store plaintext on the FrogTalk side too — there
is no point pretending otherwise. The channel header surfaces a bridge
badge so members can see this at a glance, and DMs are **never** bridged.

---

## 8. Transport, sanitization, and other defences

- **HTTPS-only** in production; HSTS preload eligible; secure cookies.
- **Tor onion** mirror with a separate Hidden Service Descriptor; nodes
  prefer onion when reaching peers that publish one.
- **CSP** locks down inline scripts; vendored libsignal/sodium served
  from same-origin.
- **CSS sanitizer.** User-supplied CSS (themes, channel branding) is run
  through an allow-list sanitizer that strips `expression()`,
  `@import`-from-network, `url(javascript:…)` etc. See
  [node/routers/_css_inline.py](../node/routers/_css_inline.py) and the unit tests
  under [node/tests/](../node/tests/).
- **Media safety.** Uploads are reprocessed: images stripped of EXIF and
  recompressed, video transcoded to a safe profile, MIME re-detected
  server-side rather than trusted from the client.
- **Rate limits** on every public endpoint (slowapi).
- **Push tokens** stored only as a server-side fanout target; payloads
  carry no plaintext message content.

---

## 9. What the server can see

It's worth being explicit about what isn't end-to-end encrypted:

- **Metadata:** who messaged whom, when, in which channel/DM, message
  sizes, presence (online / typing).
- **Public channels:** message contents (by design).
- **Bridged channels:** message contents on the FrogTalk side (by design).
- **Wall posts marked public:** post contents (by design).
- **Nicknames, avatars, channel descriptions, friend lists:** stored
  server-side in plaintext so they can be displayed to others.

A court order or a server breach can reveal any of the above. It cannot
reveal the content of DMs, private channels, calls, or audience-limited
wall posts, because we don't have the keys.

---

## 10. Threat model boundaries

We protect against:

- A hostile or compromised FrogTalk server reading message content.
- A hostile signalling server MITM'ing call media.
- Passive network observers (including a hostile ISP or transit AS).
- Future device compromise revealing past content (forward secrecy in
  DMs; per-channel key rotation on membership change for channels).

We do **not** protect against:

- A compromised endpoint (malware on your device with your unlocked
  Signal store). Nothing in our model can.
- A coerced device unlock at a border / under duress. Use the in-app
  panic-wipe if you need to.
- Traffic analysis at the level of "did A and B talk this week".
- A bad actor in a channel re-sharing your message. Channels are
  E2E-encrypted in transit, not DRM.

---

## 11. Platform hardening (May 2026)

A focused server-side pass shipped alongside the repo restructure (`node/`
runtime tree). Highlights:

- **Federation:** per-request Ed25519 signing; `FROGTALK_FEDERATION_REQUIRE_SIGS=1`
  by default; inbox idempotency on `(origin_server_id, event_id)`; no auto-creation
  of shadow users/rooms from foreign events.
- **Updates:** `FROGTALK_AUTO_UPDATE_ENABLED=0` by default; release manifests must
  verify against `FROGTALK_RELEASE_SIGNERS` before apply.
- **Auth:** per-account login lockout, bcrypt recovery keys, dummy-hash on missing
  user, server-admin login rate-limited; empty default `ADMIN_PASSWORD` (bootstrap).
- **Admin:** server-side `admin_pin_gate` on admin + server-admin routes.
- **Bots / API:** permission allowlist on user keys, 20-key cap, channel membership
  required for room access; bot DMs respect blocks.
- **Bridges:** per-bridge random tokens (no shared `"discord"` literal); private
  rooms cannot be bridged; inbound `data:` URLs capped at 8 MB.
- **WebRTC:** `ice_candidate` / offer / answer bound to open calls and participants.
- **Tor:** outbound HTTP via SOCKS when enabled; geoip skipped on onion-only nodes.
- **Transport:** CSP enforce + nonce middleware; HttpOnly session cookies; CSRF
  double-submit on state-changing routes.

Live summary also on [frogtalk.xyz/security](https://frogtalk.xyz/security).

---

## Change history

- **2026-05-20** — Repo restructure: server runtime under `node/`; docs trimmed to
  this file only. Track C (libsignal Sender Keys for rooms) reverted.
  Channels back on legacy per-room AES-256-GCM. Full message/DM data
  wipe on all nodes. All Track-C scaffolding (SKDM relay, sender-key
  IndexedDB store, per-room sender-keys card) removed from the codebase.
- **2026-05-xx** — Wall posts switched to per-post AEAD + Signal-wrapped
  key per follower.
- **2026-04-xx** — Track F Phase 1 (linked devices, dark backend).
- **2026-03-xx** — Track A Phase 3 Safety Numbers exposed in 🔒 panel.
- **2026-02-xx** — DM v2 envelope (Signal Protocol) becomes the only
  supported DM crypto path; v1 legacy AES DMs removed.

