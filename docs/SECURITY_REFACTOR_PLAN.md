# FrogTalk Security Refactor — Plan & Execution Doc

Author: engineering
Last updated: 2026-05-16
Status: IN PROGRESS — Phase 1, 2, 3, and 4 shipped (Track A scaffold + Track B grep guard + Track E Phase 1 signed DTLS fp passthrough)

## Status snapshot

| Track | Phase | Status | Commit |
|---|---|---|---|
| A — DM crypto (Signal) | 1: dark backend (tables, endpoints, federation events, flag OFF) | ✅ shipped | `5ea7378` |
| A — DM crypto (Signal) | 2: vendor libsignal (pure-JS bundle), write `signal_store.js` + `signal.js`, wire `dms.js` receive path | ✅ shipped (sends still v1) | `1854ea8` |
| A — DM crypto (Signal) | 3: flip per-DM v2 send + Signal safety number in encryption modal; FROGTALK_DM_ENC_V2=1 on both nodes; v1 fallback retained for 2-week soak | ✅ shipped | `48ad904` |
| B — Custom CSS | 1: `_css_inline.py` sanitiser + tests + `custom_style` column | ✅ shipped | `5ea7378` |
| B — Custom CSS | 2: wire sanitiser through writers, federation, renderer; backfill | ✅ shipped | `310e8ec` |
| B — Custom CSS | 3: delete `_css_safety.py`, add grep CI guard | ✅ shipped | `1854ea8` |
| C — Rooms (Sender Keys) | not started | — | — |
| D — Wall posts + media at rest | not started | — | — |
| E — Voice/video integrity | 1: dark backend (fp_sig column on `pending_call_offers`, WS payload passthrough, REST cold-resume), `Signal.signCallFingerprint` / `verifyCallFingerprint` helpers | ✅ shipped (not yet wired into calls.js) | `13e4ced` |
| E — Voice/video integrity | 2: wire calls.js to sign on offer/answer + verify on receive + Safety Numbers UI | ✅ shipped | `fb3175a` |
| E — Voice/video integrity | 2b: Safety Number panel + identity-rotation toast | ✅ shipped | `2af34e6` |
| F — Linked devices | not started | — | — |
| G — Sealed Sender + metadata | not started | — | — |

This document is the single source of truth for the hardening tracks
raised by an external pentester. All tracks are in scope; they are
landed in dependency order — Track A unlocks C, D, E, F, G because
those all reuse the Signal identity keys, sessions, and ratchet that
Track A puts in place.

- **Track A — DM crypto.** Replace the homegrown static-ECDH + AES-GCM
  scheme with the Signal Protocol (X3DH + Double Ratchet) via libsignal.
- **Track B — Custom CSS.** Keep the feature, but remove every
  `<style>` block from the user-data path. Single inline `style`
  attribute, property-allowlist, applied via `el.style.setProperty`.
- **Track C — Room (multi-party) encryption.** Signal Sender Keys for
  group chats and channels.
- **Track D — Wall posts + at-rest media encryption.** Per-post AEAD;
  follower-visibility posts use a sender-key-style group key; media
  blobs encrypted with the message's payload key.
- **Track E — E2E voice / video integrity.** Bind WebRTC DTLS
  fingerprints to the user's Signal identity key so the signalling
  server can't MITM by substitution. Adds Safety-Number UI.
- **Track F — Linked devices.** Multi-device Signal model: per-device
  sub-identities, bundle lists all active devices, messages fanned out
  to every device key.
- **Track G — Sealed Sender + metadata minimisation.** Strip
  sender-identity from the outer envelope the server sees; cut
  per-request logging of participant graph and IP.

Both nodes (MAIN `31.220.92.120`, Tor `161.97.182.73`) are operated by
the same team, so federation can treat the peer as fully trusted for
key-material transit purposes. That simplifies the X3DH bundle
distribution path materially. Track G is still worth doing because of
log-subpoena and DB-compromise threat models even when the server is us.

---

## Track A — Signal Protocol for DMs

### Current state (what we're replacing)

| Aspect | Today | Problem |
|---|---|---|
| Key agreement | P-256 ECDH, **static long-term keys** on both sides | No forward secrecy. Compromise of `ecdh_pub_key`'s private half = decrypt every past DM. |
| Symmetric cipher | AES-256-GCM with a single derived key per peer pair | Same key reused for the entire history. Nonce reuse risk if RNG ever fails. |
| Pubkey distribution | `POST/GET /api/users/pubkey` | TOFU only; no signed prekey; no out-of-band verification. |
| Storage | `users.ecdh_pub_key`, IndexedDB private key | Private key is `extractable:false` (good), but the *protocol* around it has no ratchet. |
| Surface | `static/js/crypto.js` (~444 LoC), ~8 call sites in `dms.js` and `messages.js` | Homegrown; the recent `_looksEncryptedBlob` UI false positive showed how easily a custom path breaks. |

### Target state

- **libsignal (Rust → WASM)** — the same library Signal Desktop uses.
  We do **not** re-implement X3DH or Double Ratchet ourselves. We call
  `processPreKeyBundle`, `SessionCipher.encrypt`, `SessionCipher.decrypt`.
- Per-message symmetric keys (Double Ratchet chain keys).
- Forward secrecy + post-compromise security.
- Wire format on the server changes from "base64(iv|ct)" to a typed
  envelope `{v:2, type:"prekey"|"whisper", body:"<base64>"}` stored in
  the existing `dm_messages.content` column. The server still sees only
  ciphertext.

### Library choice

- **First choice:** `@signalapp/libsignal-client` (official, Rust+WASM).
  Bundle ≈ 600 KB compressed. Has TypeScript types. Maintained by Signal.
- **Fallback:** `@privacyresearch/libsignal-protocol-typescript` — older
  pure-JS port, unmaintained, **only** use if WASM proves blocked in
  some target runtime (e.g. low-end iOS PWA). Document the gap if so.

Vendor the WASM file under `static/vendor/libsignal/` and pin the SHA256
in a `static/vendor/libsignal/SHA256SUMS` file. Reload of `index.html`
checks the integrity attribute on `<script>` (SRI).

### Data model changes

New tables (SQLite):

```sql
CREATE TABLE signal_identity_keys (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    registration_id INTEGER NOT NULL,
    identity_pub    BLOB    NOT NULL,    -- Curve25519 32-byte raw public key
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE signal_signed_prekeys (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prekey_id   INTEGER NOT NULL,
    public_key  BLOB    NOT NULL,
    signature   BLOB    NOT NULL,        -- signed by identity_pub
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, prekey_id)
);

CREATE TABLE signal_one_time_prekeys (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prekey_id   INTEGER NOT NULL,
    public_key  BLOB    NOT NULL,
    consumed_at INTEGER,                 -- NULL until handed out
    PRIMARY KEY (user_id, prekey_id)
);

CREATE INDEX idx_otpk_avail ON signal_one_time_prekeys(user_id, consumed_at);
```

Per-message column on `dm_messages` (already nullable text — no schema
change needed):

```
content = '{"v":2,"t":"pre","b":"<base64>"}'   -- PREKEY_MESSAGE
content = '{"v":2,"t":"msg","b":"<base64>"}'   -- WHISPER_MESSAGE
```

Old AES-GCM messages stay readable on their original device. They are
never re-encoded; the client picks the decode path off `JSON.parse` →
`v`-field presence. Cold history that fails both paths still renders the
"older message — re-key needed" placeholder (which now is actually true).

### New endpoints (server)

All authed via `X-Session-Token`, rate-limited like the existing pubkey
endpoints.

```
POST /api/signal/bundle
  body: { registration_id, identity_pub, signed_prekey: {id, pub, sig},
          one_time_prekeys: [{id, pub}, ...]   # batch upload, ≤100 per call }
  Replaces signed prekey for this user; appends OTPKs.

GET  /api/signal/bundle/{user_id}
  Returns ONE bundle and atomically deletes the OTPK it returned.
  Response: { registration_id, identity_pub, signed_prekey: {...},
              one_time_prekey: {id, pub} | null }
  When OTPK pool empty, client must accept null and proceed without it
  (Signal protocol allows this; security degrades to X3DH-without-OTPK).

GET  /api/signal/otpk-count
  Returns { available: N } — client tops up when N < 10.
```

OTPK atomic consume (the only subtle bit):

```sql
BEGIN IMMEDIATE;
SELECT prekey_id, public_key FROM signal_one_time_prekeys
  WHERE user_id=? AND consumed_at IS NULL
  ORDER BY prekey_id LIMIT 1;
DELETE FROM signal_one_time_prekeys WHERE user_id=? AND prekey_id=?;
COMMIT;
```

Since the app is single-process uvicorn + SQLite, `BEGIN IMMEDIATE`
gives us the exclusive write lock we need — no further locking layer.

### Federation

Both nodes are ours and both speak the existing
`POST /federation/events/inbox` protocol with pinned Ed25519 peer keys
and per-event signatures. We add two event types:

```
signal.bundle.published    body: full bundle row (registration_id, identity_pub, signed_prekey, otpks[])
signal.otpk.consumed       body: {user_id, prekey_id}   -- so the home node can drop it
```

A user's **home node** owns their OTPK pool. The other node forwards
`GET /api/signal/bundle/{user_id}` requests to the home node when the
user is non-local. This keeps OTPK consumption atomic at exactly one
SQL row in exactly one DB. Both nodes are mutually trusted, so we don't
need cryptographic OTPK consumption tokens.

### Frontend changes

Replace `static/js/crypto.js` Crypto.encrypt/decrypt **for DM paths
only**. Rooms, media, and wall posts keep the existing AES-GCM scheme
(rooms are multi-party; Signal's Sender Key protocol is a separate
future track).

Files touched:

- `static/js/signal.js` (NEW) — wrapper around libsignal exposing:
  - `Signal.init()` — load WASM, open IndexedDB store.
  - `Signal.ensureMyBundleFresh()` — rotate signed prekey weekly,
     top up OTPKs when low, call `POST /api/signal/bundle`.
  - `Signal.encryptDM(peerUserId, plaintext) → envelope`
  - `Signal.decryptDM(peerUserId, envelope) → plaintext`
- `static/js/signal_store.js` (NEW) — IndexedDB `SignalProtocolStore`
  implementing the interface libsignal expects (identity, sessions,
  prekeys, signed prekeys). ≈250 LoC, mostly mechanical.
- `static/js/dms.js` — at every Crypto.encrypt/decrypt call site,
  branch on `enc_v`:
  - Outgoing: if peer has a Signal bundle → `Signal.encryptDM`,
     otherwise fall through to legacy AES-GCM and log a one-time
     migration nudge.
  - Incoming: `JSON.parse` first → if `v===2` → `Signal.decryptDM`,
     else legacy path.
- `static/js/crypto.js` — keep but mark DM-specific helpers
  `@deprecated`. Room/media helpers stay.

The existing `_looksEncryptedBlob` heuristic becomes obsolete for v2
messages (JSON envelope is unambiguous). Keep it only as a fallback
detector for legacy bare-base64 v1 content.

### Migration & rollout

Behind a single feature flag `FROGTALK_DM_ENC_V2` (env var, default off).

1. **Schema migration:** add the three new tables on next deploy. Idle
   until enabled.
2. **Backend endpoints:** ship dark — clients can publish/fetch bundles
   but no one uses them yet.
3. **Client bundle generation:** when the flag is on, every client
   generates a Signal identity + 100 OTPKs on first launch and uploads.
   Idempotent. Old `ecdh_pub_key` column stays populated for legacy
   peers.
4. **Sender preference:** when sending a DM, prefer v2 if the peer has
   a bundle, else v1. Both nodes flip the flag at the same time.
5. **Soak:** 2 weeks both schemes in flight, log v1-vs-v2 ratio.
6. **Sunset v1 sends:** clients stop emitting v1 once 100% of active
   peers have a bundle. v1 *decrypt* path stays forever (history).
7. **Optional later:** "Reset DM session" UX (rotate identity key) for
   post-compromise healing on demand.

### Rollback plan

Flag-flip back to v1-only. Existing v2 envelopes remain readable as long
as the IndexedDB session store is intact on the receiving device.
Server-side, the new tables are inert.

### Scoping estimate

| Block | Effort |
|---|---|
| New SQLite tables + helpers | small |
| Bundle endpoints + atomic OTPK consume | small |
| Federation forwarding for non-local users | small (both nodes trusted) |
| `signal_store.js` IndexedDB impl | medium |
| `signal.js` wrapper + libsignal WASM load + SRI | medium |
| DM send/receive call-site branching | small |
| Migration nudge UI + bundle health UI in Settings | small |
| Soak + sunset | calendar time, not code |

Skipped (explicit non-goals for this track): rooms, wall posts, calls,
group DMs, Sealed Sender, sender keys, MLS.

### Acceptance criteria

- A DM round-trip between two test accounts produces a `{v:2,t:"pre",b:…}`
  envelope on first message and `{v:2,t:"msg",b:…}` on subsequent ones.
- Deleting a peer's IndexedDB session and re-sending triggers a fresh
  PREKEY exchange — no manual user step.
- Disabling `FROGTALK_DM_ENC_V2` server-side still lets clients read all
  prior history.
- Legacy v1 history remains readable on devices that originally
  decrypted it.

---

## Track B — Custom CSS hardening (inline-style-only)

### Current state

| Aspect | Today |
|---|---|
| Storage | `users.custom_css` TEXT, 10 KB cap |
| Sanitizer | `routers/_css_safety.py` `sanitize_scoped_css` |
| Render path | injected as **scoped `<style>` block** on profile/wall pages |
| Forbidden tokens today | `javascript:`, `expression(`, `url(`, `@import`, `position:fixed`, `</style`, broad selectors |

### Threat model (from pentest)

Direct quote: **"`<style>` is unsalvageable. Only `<element style="…">`
is barely viable."** Concretely:

- **`</style>` escape:** any path that lets an attacker close the style
  block early lands them straight in HTML parsing context with the
  remaining bytes. Our current sanitiser blocks the literal `</style`,
  but the parser is permissive — e.g. `</STYLE\u00ff>` variants,
  comment-eating quirks, and CDATA tricks have all worked in past
  browser bugs.
- **Selector abuse:** a scoped `<style>` block still owns *selectors*.
  Anything that can write a selector can write `:has()`, `:host`,
  attribute selectors that exfiltrate via background-image timing,
  scroll-timeline-driven side channels.
- **Browser drift:** every CSS spec update adds new property:value
  combinations whose security implications we haven't audited (recent
  examples: container `style()` queries, anchor positioning, view
  transitions). A `<style>`-shaped sanitiser owns a perpetual chase.

`<element style="…">` is materially safer because:

- No selectors, no at-rules, no nested rules — there is exactly one
  rule, attached to exactly one DOM node.
- No way to express "close the style attribute and start running JS" —
  the HTML parser tokenises quoted attribute values; HTML-escaping the
  payload before insertion (or, better, using `el.style.setProperty`)
  closes that door.
- The blast radius is bounded to the element + its descendants via
  CSS inheritance, and inherited properties are a *short* list we can
  reason about.

We keep the user-facing feature ("My profile looks like My profile")
by changing the render path from `<style>` to a single sanitised inline
`style` attribute on one container element.

### Target state

| Aspect | Target |
|---|---|
| Storage | `users.custom_css` TEXT kept (history-compat). New canonical store: `users.custom_style` TEXT — pre-sanitised, ready-to-emit declaration list. |
| Sanitiser | New `routers/_css_inline.py` — **property-allowlist** parser. No selectors accepted at all (input is `prop: value; prop: value;` only). Output is a normalised `prop: value;` string of allowed pairs. |
| Render path | One inline `style` attribute on one container DOM node per profile/wall, applied via `el.style.setProperty(prop, val)` in JS (never string-concatenated into HTML). |
| `<style>` blocks | **Zero** emitted from user data anywhere on the site. |
| Selectors | Not user-controllable, ever. |

### Property allowlist (initial set)

Conservative. Each property has a value-validator. **Anything outside
this table is rejected and stripped.**

| Property | Value rule |
|---|---|
| `color`, `background-color`, `border-color`, `outline-color`, `text-decoration-color` | hex `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`; `rgb()`/`rgba()`/`hsl()`/`hsla()` with numeric args only; named colours from a 148-entry allowlist |
| `background` | shorthand of `background-color` only — no images, no `url()`, no gradients in v1 |
| `border`, `border-top`, `border-right`, `border-bottom`, `border-left` | shorthand of width(1-8px) + style(`solid/dashed/dotted/double/none`) + colour |
| `border-radius`, `border-*-radius` | 0-64 px or 0-50 % |
| `border-width`, `border-*-width` | 0-8 px |
| `border-style` | enum: `solid/dashed/dotted/double/none` |
| `padding`, `padding-*` | 0-64 px |
| `margin`, `margin-*` | -32-64 px (some negative tolerated for layout tweaks) |
| `font-family` | from a curated 12-entry allowlist (system stack aliases) |
| `font-size` | 8-48 px |
| `font-weight` | 100/200/.../900 or `normal/bold` |
| `font-style` | `normal/italic/oblique` |
| `line-height` | 0.8-3.0 unitless, or 8-64 px |
| `letter-spacing`, `word-spacing` | -2-8 px |
| `text-align` | `left/right/center/justify` |
| `text-decoration` | `none/underline/line-through/overline` + optional `solid/dashed/dotted/wavy` + optional colour |
| `text-transform` | `none/uppercase/lowercase/capitalize` |
| `text-shadow` | up to 4 numeric args + colour, no `inset`, no nested commas escape |
| `box-shadow` | up to 4 numeric args + colour, no `inset` initially |
| `opacity` | 0.0-1.0 |
| `transform` | only `rotate(<deg>) / scale(<num>) / translate(<px>, <px>)` — explicit function allowlist; reject `matrix()`, `perspective()`, `skew()`, `translate3d()` |
| `transition` | property/duration/timing-function only; max-duration 2 s; reject `all`, reject delays |

### Properties **explicitly rejected** (denylist for clarity, not for safety)

Safety comes from the allowlist; this list is documentation of why we
left things out, so future contributors don't add them naïvely.

- `position` — any value. Removes overlay/phish/clickjack vectors.
- `z-index` — out of context anyway with no `position`.
- `pointer-events` — would break click handling on platform UI.
- `display` — could `display:none` adjacent controls if inheritance
  flowed wrong. Lock it via our own CSS, not user CSS.
- `visibility`, `opacity` together with `pointer-events` denied → no
  invisible click trap.
- `overflow`, `clip`, `clip-path`, `mask`, `mask-image`, `-webkit-mask*`
- `filter`, `backdrop-filter`, `mix-blend-mode`, `isolation`
- `content` — `::before`/`::after` literally cannot apply (we have no
  selectors) but reject anyway as defence-in-depth.
- `all`, `contain`, `container`, `container-type`, `container-name`
- `anchor-name`, `anchor-default`, `position-anchor`, `position-area`
- `view-transition-name`, `view-timeline-*`, `scroll-timeline-*`, `animation-*`
- `cursor` (custom cursors can be phishing aids on desktop)
- Any property whose name contains `--` (CSS custom properties — let
  *us* set those from a fixed namespace; user-set vars are an
  unbounded surface).
- Any vendor-prefixed property (`-webkit-*`, `-moz-*`, `-o-*`, `-ms-*`).
- Any property containing `:`, `;`, `{`, `}`, `<`, `>` characters
  outside its normal grammar.

### Value-level forbidden tokens (regardless of property)

After per-property validation, the **final** declaration list is also
scanned for these substrings (case-insensitive, after Unicode NFC
normalisation, after stripping CSS comments):

```
url(   image(   image-set(   cross-fade(   element(
var(   env(    attr(   counter(   counters(
calc(   min(   max(   clamp(
expression(   behavior(   @
javascript:   data:text   data:application
\  (any backslash — used to construct hex-escaped tokens)
&#   &lt   &gt   /*   */   //
<   >   ;   (   )   "   '   `
```

The grammar after allowlist validation has no legitimate need for any
of these tokens in any value — colour/length/keyword values don't
include them. Anything that *could* produce one of these is an
attempted escape and the whole declaration is dropped.

### Implementation

#### Sanitiser (`routers/_css_inline.py`)

Pure-Python, no regex-for-grammar (regex tokenises lines; we parse
declarations as `prop:value` after splitting on top-level `;`):

```python
ALLOWED_PROPS: dict[str, Callable[[str], str | None]] = {
    "color": _v_color,
    "background-color": _v_color,
    ...
    "transform": _v_transform,
}

_FORBIDDEN_SUBSTR = ("url(", "var(", "env(", "attr(", "calc(",
                     "expression(", "behavior(", "image(", "image-set(",
                     "cross-fade(", "element(", "@", "javascript:",
                     "data:text", "data:application", "\\",
                     "/*", "*/", "//", "<", ">")

def sanitize_inline_style(raw: str, max_len: int = 4_096) -> str:
    if not isinstance(raw, str): return ""
    s = unicodedata.normalize("NFC", raw)
    if len(s) > max_len * 2: return ""    # generous pre-trim
    out: list[str] = []
    for decl in _split_top_level(s, ";"):
        decl = decl.strip()
        if not decl or ":" not in decl: continue
        prop, _, val = decl.partition(":")
        prop = prop.strip().lower()
        val = val.strip()
        if prop not in ALLOWED_PROPS: continue
        low = val.lower()
        if any(tok in low for tok in _FORBIDDEN_SUBSTR): continue
        norm = ALLOWED_PROPS[prop](val)
        if norm is None: continue
        out.append(f"{prop}: {norm}")
        if sum(len(x) + 2 for x in out) > max_len: break
    return "; ".join(out)
```

Notable choices:
- We parse top-level declarations only; nested grammar is impossible
  because every value validator is per-property and doesn't recurse.
- Each `_v_*` validator returns the *canonicalised* value (e.g.
  `#FFAA00` → `#ffaa00`, `15px` → `15px`, `rotate( 45 deg )` →
  `rotate(45deg)`). Bytes that come out are bytes we wrote; no part
  of the user's raw input is concatenated into the final string.
- Length cap is **4 KB** of validated output. The 10 KB raw input cap
  stays so users can write commented CSS in the editor; the comment
  stripper and validator throw most of it away.

#### Render path

Frontend never inserts user CSS as HTML. The profile/wall renderer:

```js
function applyUserStyle(el, declList) {
  if (!el || typeof declList !== 'string') return;
  el.removeAttribute('style');
  for (const decl of declList.split(';')) {
    const [prop, ...rest] = decl.split(':');
    if (!prop || !rest.length) continue;
    const p = prop.trim();
    const v = rest.join(':').trim();
    if (!p || !v) continue;
    try { el.style.setProperty(p, v); } catch {}
  }
}
```

`el.style.setProperty(p, v)` is the safe API: the browser parses `v`
in *property-value* context (never *HTML* context), and silently drops
malformed values. Even if a future browser bug made some property
unsafe, the value would still have to survive our allowlist + validator
first.

The current `<style id="user-css-…">` injection sites in
`static/js/social.js`, `static/js/wall.js`, and `static/js/ui.js`
(profile preview) are all replaced with calls to `applyUserStyle()`
against the container `<div>`. **Grep CI rule:** the new
`tests/test_no_user_style_tag.py` greps the codebase to ensure no JS
file inserts a string containing the substring `<style` near
`custom_css` or `user_css`.

#### Inheritance audit

Inline `style` on the container inherits to descendants for inheritable
properties only. The inheritable subset of our allowlist is small:
`color`, `font-family`, `font-size`, `font-weight`, `font-style`,
`line-height`, `letter-spacing`, `word-spacing`, `text-align`,
`text-transform`, `text-decoration` (partially), `visibility`.

None of these enable escape; the worst case is "my whole card is
30 px Comic Sans bold red", which is the *feature*, not the bug.

#### Storage migration

```sql
ALTER TABLE users ADD COLUMN custom_style TEXT;       -- new, sanitised
-- existing custom_css TEXT column stays as raw user input (for edit-
-- box round-trips). It's NEVER emitted into the DOM.
```

On every PATCH /api/auth/profile that includes `custom_css`:

1. Store the raw input in `custom_css` (capped 10 KB) — used only to
   repopulate the editor on next visit.
2. Run `sanitize_inline_style(raw)` and store the result in
   `custom_style`.
3. API responses return both fields: `custom_css` for the editor,
   `custom_style` for the renderer.

One-shot back-fill: on next deploy, walk every `users` row with a
non-NULL `custom_css`, run the sanitiser, write `custom_style`. Idempotent.

### Federation

`user.profile.updated` outbound event currently carries `custom_css`
(verify in `routers/federation.py` outbox builder). After Track B it
carries **only `custom_style`** (already sanitised by the origin node).
The inbound handler **re-runs `sanitize_inline_style` on the received
value before storing** — never trust a peer's sanitisation, even when
the peer is us.

### Acceptance criteria

- `grep -rn '<style' static/js/ | grep -v 'docstring\|//.*<style'` shows
  no string that injects user data into a style tag.
- `routers/_css_safety.py` is deleted; `routers/_css_inline.py`
  replaces it.
- Federation `user.profile.updated` event schema no longer carries
  `custom_css`; carries `custom_style` only.
- Fuzz suite (`tests/test_css_inline_sanitizer.py`) covers: `</style>`
  variants, Unicode bidi tricks, URL/var/calc/expression/data-URI
  injection, escape-sequence (`\3c`), nested parentheses, oversize
  inputs, every property's value validator with both valid and
  malicious inputs.
- DOMPurify-equivalent grep: no occurrence of `innerHTML = ` near
  `custom_css` or `custom_style` anywhere in `static/js/`.

### Scoping estimate

| Block | Effort |
|---|---|
| `routers/_css_inline.py` allowlist parser + per-property validators | medium |
| Replace `<style>` injection sites with `applyUserStyle()` | small |
| Schema migration + dual-store (raw + sanitised) | small |
| Federation event re-sanitisation hook | small |
| Fuzz / regression test suite for the sanitiser | medium |
| One-shot back-fill of existing rows | small |

### Things we are explicitly **not** doing

- We are **not** sandboxing the chat window in an iframe/shadow DOM
  with a different origin. The pentester floated this and dismissed it
  themselves; the engineering cost is huge and the gain over "no
  `<style>` tags + property allowlist + value validator" is marginal
  for our threat model.
- We are **not** allowing `url()`, `background-image`, gradients, or
  any external fetch from user CSS in v1. If users ask, we add a
  separate `background_image_id` column referencing a server-hosted,
  re-encoded asset — same path as avatars. The value never lands in
  user CSS.
- We are **not** allowing `@`-rules, selectors, pseudo-classes,
  pseudo-elements, or any form of "two declarations from one input".
  One input → one inline style attribute → one DOM node.

---

## Track C — Room (multi-party) encryption: Sender Keys

### Current state

Rooms today use a *static* per-room symmetric key derived from
`room.id + room.name + a user-held room passphrase`, AES-256-GCM. Same
weaknesses as Track A's pre-state, multiplied by N members: if any
member's local store leaks, every past and future message in the room
is readable. Membership changes (kicks, bans, leaves) do **not**
trigger key rotation.

### Target: Signal Sender Keys

Sender Keys is the protocol Signal Desktop uses for group chats. It is
*not* an MLS replacement — MLS gives you tree-rooted forward secrecy
and continuous group key agreement at the cost of substantially more
bookkeeping. For a chat app with rooms in the tens of members, Sender
Keys is the right cost/benefit point and lives in the same libsignal
binary we are already shipping for Track A.

Protocol summary:

1. Every member, on first send to a room, generates a **sender key**:
   a fresh chain key + signing keypair.
2. The sender encrypts a `SenderKeyDistributionMessage` (SKDM) containing
   its sender key state, and ships it to every *other* room member
   over their 1:1 Signal session (which Track A guarantees exists).
3. Subsequent room messages are encrypted with the sender's sender key.
   The chain key ratchets forward on every send, so each message has a
   distinct symmetric key.
4. Other members decrypt with the sender-key state they received via
   the SKDM.
5. **Membership change → key rotation.** On any leave/kick/ban, every
   remaining member rotates their sender key and re-distributes a new
   SKDM. Joins do not require rotation by default but we rotate anyway
   on adds — see threat-model note below.

Why rotate on adds too: a member who *just* joined should not, by
design, be able to decrypt history they were not present for. With
static-key rooms today they can if they ever had the room passphrase.
Rotation on add cleanly closes this.

### Data model

No new server-visible message structure — room messages reuse the
same v2 envelope as Track A:

```
messages.content = '{"v":2,"t":"sk","b":"<base64>"}'   -- normal sender-key message
messages.content = '{"v":2,"t":"skdm","b":"<base64>"}' -- SKDM (delivered as room msg, hidden in UI)
```

New client-side IndexedDB stores (no DB schema changes server-side):

```
sender_keys:       (room_id, sender_user_id, sender_device_id) → state blob
incoming_skdm_log: (room_id, sender_user_id, msg_id)           → seen flag (replay guard)
```

Server-side, the only addition is a per-room **epoch counter** for
debuggability and a join-fence:

```sql
ALTER TABLE rooms ADD COLUMN sender_key_epoch INTEGER NOT NULL DEFAULT 0;
```

Every time a member processes a membership change they bump the epoch
locally; the server epoch is informational only ("did everyone rotate
for this membership change?" diagnostics).

### New events on the existing room channel

No new HTTP endpoints. The existing WS room channel carries SKDMs as a
message type that the UI hides. The room-message broadcast already
fans out to every member, so an SKDM sent by a joining client reaches
all existing members for free.

### Membership-change flow

On `member_left` / `member_kicked` / `member_banned` WS event:

```
  for each remaining member, locally:
    1. delete the leaver's sender-key state from local store
    2. generate a new sender key for *self* in this room
    3. build SKDM, fan out one DM SKDM message per remaining member
       over their 1:1 Signal session
    4. bump local epoch
```

On `member_added`:

```
  for each existing member, locally:
    1. generate a new sender key for *self* in this room
    2. fan out SKDM to ALL members (incl. the new one)
    3. bump local epoch
```

Fanout cost: O(N) DM sessions per membership event per member, so a
20-member room churning by one member costs ≈ 20 × 19 = 380 DM
ciphertexts. At our message rate this is negligible.

### Frontend changes

- `static/js/signal_room.js` (NEW) — thin wrapper that:
  - `Room.encryptMessage(roomId, plaintext)` → envelope
  - `Room.decryptMessage(roomId, senderId, envelope)` → plaintext
  - `Room.handleMembershipChange(roomId, kind, userId)` — drives the
     rotation/fanout sequence above.
- `static/js/messages.js` — replace `Crypto.encrypt`/`Crypto.decrypt`
  call sites for **room** messages with `Room.encryptMessage` /
  `Room.decryptMessage`. Mirrors the Track A surgery on `dms.js`.
- WS handler in `static/js/ws.js` — recognises `{t:"skdm"}`
  type=room-message envelopes and routes them to
  `Room.handleIncomingSKDM` instead of rendering.

### Migration & rollout

Feature flag `FROGTALK_ROOM_ENC_V2`.

1. Ship dark — clients understand v2 room envelopes but never emit
   them.
2. **Per-room flip:** the first member of a room to upgrade past flag
   on rotates the room into v2 by emitting an SKDM that all members
   process. Members not yet on v2 just see an undecryptable message
   (renders as the existing "Older message" placeholder, which is now
   *truthful*). When everyone is on v2 the room is fully readable.
3. v1 decrypt path remains in `Crypto.js` indefinitely (history).

### Federation

Rooms today federate via the existing `room.*` events. Add:

- `room.skdm.received` is **not** a thing — SKDMs go peer-to-peer as
  DM messages, so they ride the Track A federation path automatically.
  No room-event schema change.

### Acceptance criteria

- Joining a room as a new member produces N inbound SKDMs (one from
  each existing member) over 1:1 sessions.
- Kicking a member → every remaining member's next room message is
  encrypted under a new sender key. The kicked member's local store
  cannot decrypt any post-kick message.
- Browser DevTools never shows room plaintext on the wire.

### Scoping estimate

| Block | Effort |
|---|---|
| `signal_room.js` Sender-Key wrapper | medium |
| IndexedDB sender-key store extension | small |
| Membership-change rotation/fanout glue | medium |
| `messages.js` / `ws.js` call-site branching | small |
| Rollout + soak | calendar time |

---

## Track D — Wall posts + media at rest

### Current state

- **DM media:** sent as data-URL inside the (currently AES-GCM
  v1, post-Track-A Signal v2) message body. Already E2E.
- **Room media:** ditto with the room key.
- **Wall posts:** stored server-side as plaintext (`wall_posts.content`),
  visibility controlled by `public / followers / friends` enum. Media
  attachments are plaintext blobs in `wall_media/`.
- **Profile media (avatar, banner):** intentionally public — no change
  needed.

The gap is wall posts and their media. A DB compromise reveals every
followers-only or friends-only post.

### Target

Wall posts have an **audience set** (public / followers / friends /
custom-list). For each non-public audience, the post is encrypted with
a per-post AES-256-GCM payload key, and the payload key is wrapped to
every member of the audience set using the same sender-key trick as
rooms.

Public posts stay plaintext — the server is the audience.

### Data model

```sql
ALTER TABLE wall_posts ADD COLUMN enc_v       INTEGER NOT NULL DEFAULT 0;   -- 0 = plaintext, 2 = v2
ALTER TABLE wall_posts ADD COLUMN audience    TEXT;                          -- 'public'|'followers'|'friends'|'list:<id>'
ALTER TABLE wall_posts ADD COLUMN ciphertext  BLOB;                          -- AEAD blob, NULL if plaintext

CREATE TABLE wall_post_keys (
    post_id     INTEGER NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wrapped_key BLOB    NOT NULL,                  -- AEAD-wrapped payload key
    PRIMARY KEY (post_id, recipient_id)
);
CREATE INDEX idx_wpk_recipient ON wall_post_keys(recipient_id);
```

Wrap path: `wrapped_key = SessionCipher(recipient).encrypt(payload_key)`
using the recipient's current Signal session. New followers added
*after* the post was made do **not** retroactively gain access — they
see a "this post was made before you followed" placeholder. Closing
the historical-access door is deliberate and the right default.

Media blobs in `wall_media/` are written **encrypted** with the same
payload key, AEAD nonce = `SHA-256(post_id || media_idx)[0..12]`. The
file on disk is opaque; the server can serve it untouched. Decryption
happens client-side after the wall feed JSON delivers the per-post key.

### Endpoints

```
POST /api/wall/posts
  body: { audience, ciphertext_b64, media_blobs:[{nonce, blob_id}],
          wrapped_keys: [{recipient_id, wrapped_b64}, ...] }

GET  /api/wall/feed
  Returns posts the viewer is an audience member of, with that viewer's
  wrapped_key inlined. Other recipients' wrapped_keys are NOT exposed —
  the row-level filter is `wall_post_keys.recipient_id = :viewer`.
```

The author's client computes the audience list at post time, walks it,
calls `Signal.encryptDM(recipient, payload_key)` for each, and
uploads the bundle. Audiences in the hundreds need to be handled in
batches but our scale doesn't require it.

### Media-at-rest for DMs and rooms

DM media already piggybacks on the message ciphertext. Once Track A
is in place the DM media path is automatically E2E. Same for room
media under Track C. The only outstanding piece for D is **wall
media**, covered above, and **uploaded media that lives in a separate
blob store** (currently `data/thumbs/` etc.):

- Migrate to a content-addressed blob store keyed by
  `SHA-256(ciphertext)`. Plaintext never lands in the blob store.
- A separate `media_blobs` table maps `blob_id → (size, nonce_prefix,
  uploader_id, created_at)`. No content metadata. Thumbnails are also
  encrypted; the server returns thumbnails as opaque blobs and the
  client AEAD-decrypts to render.

### Federation

`wall.post.created` event schema grows `audience`, `ciphertext`,
`wrapped_keys` (only the wrapped keys for recipients on the receiving
node). The receiving node persists; recipients on that node load their
wrapped_key from `wall_post_keys` as normal.

Media blob distribution: blob bytes are opaque. We add
`media.blob.uploaded` federation event carrying `{blob_id, bytes}` and
the peer stores it under the same content-address.

### Acceptance criteria

- A followers-only wall post stored on disk shows no plaintext under
  any column or any file in `wall_media/`.
- A user who follows the author **after** the post still cannot read
  the post. Their UI says so explicitly.
- A user who is unfollowed loses access to future posts but retains
  what they've already locally decrypted (server cannot reach into
  their local cache).
- Media thumbnails round-trip via the encrypted blob store with
  visible perceptual loss bounded the same as the current pipeline.

### Scoping estimate

| Block | Effort |
|---|---|
| Schema migration (`enc_v`, `audience`, `ciphertext`, `wall_post_keys`) | small |
| Author client: audience walk + per-recipient wrap | medium |
| Viewer client: wrapped_key lookup + AEAD decrypt | small |
| Content-addressed encrypted blob store | medium |
| Federation event schema updates | small |
| Backfill plan for old plaintext rows | calendar time (see below) |

Backfill: existing followers-only and friends-only posts cannot be
retroactively encrypted (we'd need every audience member's *future*
Signal session). Two options:

1. **Best (default):** leave old posts plaintext, mark each row
   `enc_v=0`, surface a one-time settings prompt to the author:
   "Older posts are not yet protected. Re-publish?".
2. **Mass-rotate:** the author's client opts in to walk every post,
   re-encrypt under each current follower's session, replace the row.
   Optional.

---

## Track E — E2E voice / video integrity

### Current state

FrogTalk calls use WebRTC. Once peers connect, SRTP-DTLS makes the
media stream itself E2E between browsers — the server cannot decrypt.
The weak point is **call setup**: the SDP offer/answer flows through
our signalling server, and the DTLS fingerprint is just embedded in
the SDP. A compromised or malicious signalling node could substitute
its own fingerprints (`a=fingerprint:sha-256 …`) and complete the
DTLS handshake with each peer, bridging the media in plaintext.

This is the well-known WebRTC MITM-via-signalling issue. Signal,
WhatsApp, FaceTime, and Wire all close it the same way:

### Target: signed DTLS fingerprints + Safety Numbers

1. Caller, before sending offer, computes its DTLS fingerprint via
   `RTCPeerConnection.getConfiguration()` after createOffer. Signs
   `{call_id, callee_user_id, fingerprint_sha256, ts}` with their
   Signal **identity** key (Curve25519 → Ed25519 via libsignal helper).
2. Signed blob travels alongside the SDP in the signalling channel.
3. Callee receives the offer, looks up the caller's identity key from
   the cached Signal bundle (already trusted via Track A's verification
   surface), verifies the signature, **and** verifies
   `fingerprint_sha256` matches what's actually in the received SDP.
   Mismatch → reject the call with "signalling tampering detected"
   error.
4. Symmetrically: callee returns the signed answer.

No signalling-server change required — the signed blob is just an
additional opaque field in the existing signalling envelope.

### Safety Numbers UI

Derive a Signal-style numeric Safety Number from the two participants'
identity keys: `numeric = base10(SHA-512_5x(sort(idA || idB)))[:60]`,
formatted in 5-digit groups. Show in the call UI's "…" menu plus a QR
code for in-person verification. A change in the safety number
between two known peers is a strong signal of identity-key rotation
(legitimate device re-link OR attempted MITM).

### TURN-relayed calls

When the call relays via TURN (about 15% of our calls, per stats),
the media still rides SRTP-DTLS between the actual endpoints — TURN
relays opaque UDP. The fingerprint binding above suffices.

### Acceptance criteria

- Replacing the signalling-relayed SDP `a=fingerprint` line
  programmatically causes the call to refuse to connect on the
  recipient side with "signalling tampering detected".
- A device-relink (Track F) emits a UI event "safety number changed"
  on the next call between those users.
- Existing v1 calls (peer without Signal identity yet) downgrade with
  a visible "unverified call" warning in the call header.

### Scoping estimate

| Block | Effort |
|---|---|
| Identity-key signature/verify helper around libsignal | small |
| Plumb signed fingerprint into call signalling | small |
| Safety-number compute + UI panel + QR | medium |
| Downgrade UX for unverified peers | small |

---

## Track F — Linked devices

### Current state

No device concept. A user logs in on a second device → fresh keypair
→ peers see a new ECDH key for the same user and existing DM history
on the other device cannot be decrypted (this is exactly the source of
the current "Older message — encrypted on a previous device" UI).

### Target: Signal-style linked devices

The Signal model:

- One **primary** device holds the master identity key.
- Up to **N secondaries** (we cap at 5) each have their own per-device
  identity, signed by the primary.
- A sender encrypting a DM encrypts it once per *device key* of the
  recipient. The bundle returned by `GET /api/signal/bundle/{user_id}`
  becomes a list, one entry per active device.
- On each device, libsignal manages its own session per (peer\_user, peer\_device).
- A new device cannot read history from before it was linked. This is
  the correct privacy default and matches Signal.

### Data model

```sql
CREATE TABLE user_devices (
    device_id     TEXT PRIMARY KEY,                  -- UUID, generated client-side at link time
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT,                              -- 'iPhone', 'Desktop', user-editable
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER,
    primary_sig   BLOB    NOT NULL,                  -- primary identity_pub signs (device_id || device_identity_pub)
    revoked_at    INTEGER
);

-- Existing signal_identity_keys / signal_signed_prekeys /
-- signal_one_time_prekeys all gain a device_id column instead of being
-- user-keyed:
ALTER TABLE signal_identity_keys     ADD COLUMN device_id TEXT;
ALTER TABLE signal_signed_prekeys    ADD COLUMN device_id TEXT;
ALTER TABLE signal_one_time_prekeys  ADD COLUMN device_id TEXT;
-- Backfill: existing rows get device_id = '<user>-legacy-1' which is
-- treated as the primary.
```

`GET /api/signal/bundle/{user_id}` becomes:

```
{
  devices: [
    { device_id, registration_id, identity_pub, signed_prekey, one_time_prekey, primary_sig },
    ...
  ]
}
```

Caller iterates `devices`, runs `processPreKeyBundle` per device,
encrypts the same plaintext once per device, sends each ciphertext as
a separate `dm_messages` row with the same `client_msg_id` but a new
`recipient_device_id` column for the fanout. The recipient's UI
deduplicates by `client_msg_id`.

### Linking flow

QR-based, mirrored on Signal Desktop's flow:

1. Secondary launches "link a device" → generates its own identity
   keypair, shows a QR containing `{secondary_pub, nonce, server_url}`.
2. Primary scans QR (existing camera flow we use for friend-add).
3. Primary signs `{secondary_pub, device_id, ts}` with its identity
   key, posts to `POST /api/signal/devices/link`. Body:

   ```
   { device_id, secondary_pub, name, primary_sig }
   ```
4. Server inserts a row in `user_devices`, marks as active, broadcasts
   `user.device.linked` to federation.
5. Secondary polls `GET /api/signal/devices/me` and on seeing itself
   approved, runs `Signal.ensureMyBundleFresh()` to publish its own
   bundle. From that moment all peers' next DM encrypts a copy to it.

### Revocation

`POST /api/signal/devices/{device_id}/revoke` (from primary only).
Sets `revoked_at`, broadcasts `user.device.revoked`. Other clients
drop sessions to that device on next bundle refresh.

Lost-primary recovery: if the user lost their primary, a designated
**recovery secondary** can be promoted by signing a recovery payload
with its own identity key + the account password. Documenting only —
not in v1.

### Federation

New events:

```
user.device.linked     { user_id, device_id, identity_pub, primary_sig, name }
user.device.revoked    { user_id, device_id }
user.bundle.updated    { user_id, device_id, signed_prekey, otpks }
```

All three are signed by the **user's primary identity key** so the
receiving node verifies the chain (peer pin → primary identity →
signing of device). This is the same trust-pinning model Track A
establishes.

### Acceptance criteria

- Linking a second device → next inbound DM is decryptable on both
  primary and secondary.
- Revoking a device → that device's local store still has its private
  key but the peer's *next* DM no longer encrypts to that device (next
  bundle refresh removes it).
- A user with 3 devices receiving one DM sees the message exactly
  once on each device, with consistent `client_msg_id`.
- A device that was offline during a kick still cannot decrypt
  messages from after its revocation, because peers stopped encrypting
  to it on first bundle refresh.

### Scoping estimate

| Block | Effort |
|---|---|
| `user_devices` schema + endpoints + federation events | medium |
| Bundle-list response shape change | small |
| Client fanout (encrypt once per peer device) | medium |
| QR link flow + primary-signed enrolment | medium |
| Device-management UI in Settings | medium |
| Lost-primary recovery (deferred to F.1) | medium — separate later release |

---

## Track G — Sealed Sender + metadata minimisation

### Current state

The server sees every `(sender_user_id, recipient_user_id, ts)` tuple
for every DM. Log retention is currently 30 days. IP + UA are captured
per session row in `sessions` and per request in nginx access logs.
A subpoena or DB compromise reveals the full social graph.

### Target

#### G.1 Sealed Sender

Signal's Sealed Sender lets the sender encrypt their identity inside
the outer envelope. The server only sees `(recipient_user_id,
ciphertext)`. Recipient decrypts to reveal both sender identity and
payload.

Mechanism:

- Server issues each user a **sender certificate**: signed binding of
  `{ user_id, primary_device_id, primary_identity_pub, expiry }`,
  signed by a long-lived **server signing key** (Ed25519, rotated
  yearly, public key bundled in the client).
- Sender wraps message in an outer envelope:
  `Encrypt(recipient_identity_pub, { sender_cert, inner_ct })`.
- Outer encryption uses a one-shot ECDHE ephemeral on the sender side
  (libsignal `SealedSenderEncrypt` helper).
- Server-side, the message inserts with `sender_id = NULL` and a
  `sealed = 1` flag.
- Recipient decrypts, verifies sender certificate against the bundled
  server signing key, then trusts the asserted sender identity.

#### G.2 Logging discipline

- Drop `messages.sender_id` for `sealed=1` rows; replace with NULL.
- Strip IP from `sessions` row after first auth verifies the country
  for ratelimit purposes; persist only `country_code`.
- Nginx logs: ship the existing `client_max_body_size` etc. config
  with an explicit `access_log off;` for `/api/dms/*` and
  `/api/signal/*` endpoints. Error logs only.
- Rotate session tokens daily on active sessions (already happens for
  password change; extend to a daily floor).
- Federation events for DMs drop the `sender_user_id` field from the
  inbox payload; only `recipient_user_id + ciphertext` cross the wire.

#### G.3 Padding

Uniform-size envelope padding to break length-based traffic analysis:
every DM ciphertext is padded to the next 256-byte boundary before
encryption. Server sees only padded length buckets, not real content
length. Cost: roughly 5% size overhead.

#### G.4 Read receipts

Move read-receipt events to the same sealed-sender path. Currently a
read receipt reveals `(reader_id, dm_id, ts)` to the server; under G
it reveals `(recipient_id, opaque_blob)`.

### Data model

```sql
ALTER TABLE dm_messages    ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dm_messages    ADD COLUMN sender_id_legacy INTEGER;   -- existing sender_id renamed; sealed rows leave it NULL

CREATE TABLE server_signing_keys (
    kid          INTEGER PRIMARY KEY,
    pubkey       BLOB NOT NULL,
    privkey      BLOB NOT NULL,            -- encrypted at rest with the systemd-loaded master secret
    issued_at    INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    revoked_at   INTEGER
);

CREATE TABLE sender_certificates (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT    NOT NULL,
    cert      BLOB    NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id)
);
```

### Endpoints

```
GET /api/signal/sender-cert      → returns this user's current cert,
                                   issuing a fresh one if expired.
GET /api/signal/server-keys      → published server-signing-key history
                                   so old certs still verify.
```

DM ingestion endpoint accepts a `sealed: true` flag; when present the
server does **not** consult `sender_user_id` from the headers and
does not write it to the row.

### Abuse-prevention guard

Sealed Sender breaks our existing per-sender DM rate limit. Replace it
with a **per-recipient** rate limit: "recipient X received N DMs in
the last hour from sealed senders combined." Crosses the spam-throttle
use case without re-revealing senders. Tunable separately from the
identified-sender limit.

### Federation

Federation peers are mutually trusted, so they receive *unsealed*
relay copies internally for ratelimit/abuse purposes — but the
plaintext sender identity never leaves the trusted pair. From the
client's perspective the path looks the same as a single-node sealed
sender.

### Acceptance criteria

- `dm_messages.sender_id` is NULL for every row inserted after G
  rollout where the client opted in (default on).
- DB dump → grep for any user's nickname / id alongside a DM row of
  someone else returns zero hits.
- Nginx access logs contain no entries for `/api/dms/*`.
- Padding histogram: 99% of DM ciphertexts fall on a 256-byte
  boundary.
- A clock-skewed expired sender cert is rejected with a clear UI
  error and an automatic cert refresh.

### Scoping estimate

| Block | Effort |
|---|---|
| Server signing key + rotation cron | small |
| Sender certificate issuance endpoint | small |
| Sealed-sender encrypt/decrypt wrapper (libsignal helper exists) | small |
| DB column changes + ingestion-path branching | small |
| Per-recipient rate limit replacing per-sender | small |
| Read-receipt sealed channel | small |
| Padding + length-bucket audit | small |
| Log-discipline nginx config + IP-strip cron | small |

---

## Execution order

Dependencies: A → C → F → G; D depends on A; E depends on A (uses
identity key). B is independent and can land in parallel.

1. **Phase 1.** Track A schema + endpoints behind flag, dark deploy.
2. **Phase 1.** Track B sanitiser + render-path replacement; backfill.
3. **Phase 2.** Track A `signal_store.js` + `signal.js` + WASM
   vendoring + soak; flip flag.
4. **Phase 2.** Track A sunset v1 sends.
5. **Phase 3.** Track C Sender Keys; per-room v2 flip on first send.
6. **Phase 3.** Track E signed DTLS fingerprints + Safety Numbers UI.
7. **Phase 4.** Track D wall-post AEAD + encrypted blob store.
8. **Phase 4.** Track F linked devices + bundle-list shape change.
9. **Phase 5.** Track G Sealed Sender + metadata-minimisation pass.

Each tracked deploy follows the standing checklist:

- `node --check static/js/*.js` for any frontend JS touched.
- `scp` to both nodes, `systemctl restart frogtalk`, `systemctl is-active`.
- Bump `static/sw.js` CACHE_NAME and `?v=` on any changed JS.
- Commit with a single-purpose message, push to master.

---

## Out of scope (genuinely deferred)

These are deliberately *not* tackled here. They are either separate
product surfaces, would require MLS-grade scale work we don't need
yet, or live outside the FrogTalk codebase entirely:

- **MLS migration of group chats** — Sender Keys (Track C) is the
  right fit for our member counts. Revisit if rooms ever exceed a few
  hundred members.
- **Post-quantum hybrid handshake** — Signal is rolling out PQXDH;
  follow `@signalapp/libsignal-client` updates and adopt when stable.
- **Out-of-band identity verification via DNS / Keybase / matrix** —
  Safety Numbers (Track E) plus QR is enough for our user base.
- **Per-message disappearing-message ratchet** — useful, but separate
  feature work, not a security gap.
- **Hardware-key-bound device identities (TPM / Secure Enclave)** — a
  desktop-platform extension to Track F; nice-to-have, not blocking.
- **Bridge encryption (Telegram/Discord/Matrix bridges)** — bridges
  by design exfiltrate plaintext to a third-party server, so they will
  always be the weakest link in their thread. Document this clearly
  in the bridge UI; do not pretend bridged DMs are E2E.
