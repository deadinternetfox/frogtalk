# Cross-node status report (DMs, calls, secret groups)

_Last updated: 2026-05-23_

Goal: **DMs, 1:1 calls, and encrypted (private) groups work reliably across federation nodes**, including when a user’s **home node is down** but they are online on a travel/community node.

This is a living report — not a promise that everything below is finished.

---

## Executive summary

| Area | Cross-node status | Notes |
|------|-------------------|--------|
| **Live DMs (new messages)** | **Mostly working** | Node-local keys first; federation delivers ciphertext; old home ciphertext stays locked on travel |
| **DM history on travel** | **By design locked** | `fresh_keys` — sync copies blobs, not keys; do not regress into trying to decrypt |
| **Same-node false warnings** | **Fixed (deploy pending)** | “no federation route” when peer already on WS — see §7 |
| **1:1 calls** | **Partial** | Federation signalling exists; connect quality depends on TURN/home routing; missed-call dedupe fixed |
| **Private / “secret” rooms** | **Partial** | Per-room AES-GCM is local to room membership; federation mirrors **messages** for rooms that exist on both nodes — not full automatic cross-node room key transfer |
| **Home node down** | **Partial** | Travel node + WS works if user is connected there; home unreachable blocks home-originated bundle proxy until circuit/backoff |

---

## Architecture we moved to (do not regress)

### 1. Keys are per physical node (browser origin)

- Signal identity + prekeys live in **IndexedDB per origin** (e.g. `frogtalk.xyz` vs AU nip.io).
- Default travel policy: **`fresh_keys`** (`device_crypto.js`) — new keys on travel; **no** DM key export in sync.
- Server stores ciphertext only; it **cannot** decrypt.

### 2. Stop pinning keys from federated DM metadata

- **Removed:** setting `signal_keys_server_id` from every `dm.message.created` origin (was forcing home → AU proxy and same-node timeouts).
- **Kept:** `user.signal.keys_updated` when a user actually publishes a bundle on a node.

### 3. Bundle fetch: local node first

- If peer has published on **this** node → serve **local** bundle (no federation HTTP).
- Remote proxy only when this node has **no** published bundle for that user.
- **Guardrails:** max concurrent remote fetches, in-flight coalescing, circuit breaker, client backoff (prevents 502 “bundle storms”).

### 4. DM history vs live lane

- **History** from another node: show locked (`🔒 From home node` / travel skip decrypt) — **expected**.
- **Live** messages after both parties use keys on the **current** node: should encrypt/decrypt — **working in recent tests**.
- **Planned (Phase 1):** explicit in-thread “crypto lane” divider + `crypto_lane` on messages so UI never mixes old locked blobs with new session in one decrypt path.

### 5. Federation is for delivery, not crypto portability

- `dm.message.created` copies **ciphertext** to peer nodes.
- Decrypt always uses **this node’s** Signal session with peer’s **this-node** bundle (or one-time remote fetch if they’ve never published here).

---

## What works today

### DMs

- **Same node:** WS delivery; encrypt/decrypt with local bundles after P0 routing fix.
- **Node A → node B (live):** Federated DM insert + WS on receiving node; decrypt works when both have published keys on the relevant nodes.
- **Auto nudge:** Missing peer bundle → WS `signal_publish_keys` + server retry before failing.
- **Auto resync:** `dm_crypto_resync` on decrypt failure (rate-limited).
- **Encrypt timeouts:** Client retry + server bundle guards.

### Calls

- Federation events: `call.offer`, `call.answer`, `call.ice`, `call.end`, `call.reject` (see [FEDERATED_CALLS.md](FEDERATED_CALLS.md)).
- **Co-located travelers:** Callee on same node as caller → local WS ring (no home round-trip).
- Missed-call DM log: single copy via origin node (duplicate federated log removed on apply).
- TURN/ICE merged from local + peer home in `calls.js`.

### Private rooms (“secret groups”)

- **On one node:** Room secret + AES-GCM message encryption (`wall_crypto` / room crypto path in SECURITY_MODEL).
- **Federation:** Room messages and member index can sync to nodes that **already have the room**; clients must already share the room secret out-of-band or via prior join on that node.
- **Not yet a product guarantee:** “Create on home, auto-decrypt same room on travel without manual secret transfer.”

### Account sync

- **Home → visit:** profiles, friends, room lists, **DM ciphertext history** (for UI continuity).
- **Visit → home (merge):** channels you create or join on a travel node are pushed to your home node (signed federation merge); the next home→visit import spreads them to other peers.
- Travel: historical DM ciphertext is **display-only locked**, not decrypted.
- **Private channel secrets** stay in the browser (`localStorage` / Key Manager export) — merge copies channel metadata and hints, not the shared secret itself.

### Network picker visibility (Settings → Network)

| This node type | Sees in picker |
|----------------|----------------|
| **Clearnet-only** (e.g. AU) | Other clearnet nodes + official hub (HTTPS) |
| **Hybrid** (`FROGTALK_HYBRID_NODE=1`, frogtalk.xyz) | Clearnet + Tor mirror (.onion) |
| **Tor-only** | Tor mirror + hybrid hub (not clearnet-only community nodes) |

Server Admin **Block Tor federation peers** toggle appears only on **hybrid** hubs (not on clearnet-only or Tor-only nodes).

---

## Known issues / edge cases

| Symptom | Cause | Mitigation |
|---------|--------|------------|
| `peer_bundle_timeout` | Remote keys node slow/unreachable; or stale pin (fixed server-side) | Hard refresh; publish keys on **this** origin; wait for circuit cooldown |
| `no federation route` warning | Federation enqueue ran while peer already on local WS, but outbox had no targets | **Fixed:** skip federate when peer online locally; suppress warning if WS delivered |
| `🔒 Couldn't show your sent message on this device` | Outgoing ciphertext echoed back; local decrypt of own send | Plaintext cache should handle; if missing, cosmetic only |
| `🔒 From home node` on travel | `fresh_keys` + synced history | Expected; new messages after keys on travel work |
| Home node down | Bundle proxy to home fails; calls anchored to home may not ring | User must use **travel node** where they have WS + published keys |
| Site 502 | Too many concurrent federation bundle HTTP calls | Bundle storm guards deployed |

---

## Home node down — behaviour matrix

| User state | DMs | Calls |
|------------|-----|-------|
| Online on **travel** only, keys published on travel | Send/receive via travel + federation to other nodes | Local WS if callee on same node; else federated to callee **home** (fails if home down) |
| Online on travel, never opened app on travel | No bundle on travel until first open | Nudge + publish on connect |
| Peer only on home, home **down** | Messages queue on sending node; peer offline everywhere | No ring until peer connects somewhere |
| Both on same travel node | **Local WS** — should not need federation route | Local signalling |

**Takeaway:** “Home down” is survivable when users **actually use the travel node** (session + keys there). Federation does not magically read home’s encrypted DB.

---

## Code map (quick reference)

| Concern | Primary files |
|---------|----------------|
| DM encrypt/decrypt UI | `node/static/js/dms.js`, `signal.js` |
| Travel / skip history decrypt | `dms.js` (`_dmSkipHistoricalDecrypt`, `_isTravelNode`) |
| Bundle routing + guards | `node/routers/signal.py` |
| Federation DM delivery | `node/federation_dms.py`, `routers/federation.py` (`dm.message.created`) |
| WS send + warnings | `node/routers/ws.py` |
| Calls federation | `node/federation_calls.py`, `static/js/calls.js` |
| Room crypto | `SECURITY_MODEL.md` §3, room message path |
| Sync export/import | `node/routers/auth.py` (DM histories in sync payload) |

---

## Recent fixes (preserve — regression checklist)

1. **No `signal_keys_server_id` pin from `dm.message.created`.**
2. **`signal_has_published_bundle()` before remote proxy** (never use `signal_fetch_bundle()` for routing — it burns OTPKs).
3. **Bundle storm:** semaphore, coalescing, circuit breaker, client backoff.
4. **Decrypt:** do not clear Signal session on `pre` / live permafail; `refreshPeerForDecrypt` without session wipe.
5. **Missed-call log:** no duplicate insert on federated `call.end`.
6. **Same-node DM warning:** `should_federate_dm` false when peer on local WS.

---

## Recommended next steps (priority)

### P1 — DM crypto lanes (UX, no second channel row)

- Add `dm_messages.crypto_lane` or `keys_origin_server_id`.
- UI divider: “Messages below use encryption on this node.”
- Never attempt decrypt across lane boundaries.

### P2 — Sync policy

- Stop exporting DM ciphertext in travel sync (or mark `sync_only_display=1`).
- Keeps sidebar previews without implying decrypt.

### P3 — Calls with home down

- Prefer **push targets** = all nodes where callee has recent session, not only `account_home`.
- Audit `call_signal_target_servers()` vs `resolve_federation_push_targets_for_recipient_gids`.

### P4 — Private rooms across nodes

- Document: room secret must be established per node (or explicit DCT-style room secret transfer).
- Optional: federated `room.secret.offer` event (larger scope).

---

## Operator checklist (debugging)

1. Same `FROGTALK_FEDERATION_TOKEN` on all nodes.
2. Federation directory: each node enabled, reachable `base_url`.
3. Both users hard-refresh after deploy (`signal.js` / `dms.js` version query params).
4. DevTools: `await Signal.peerKeysDiagnostics(peerLocalId)` → `bundle_is_remote`, `bundle_source_server`.
5. Server logs: `signal: remote bundle ok/fail`, `federation: DM enqueue failed`.

---

## Test matrix (manual)

| Scenario | Expected |
|----------|----------|
| Frog + Testy both on xyz | Fast local bundle; no “no federation route” if WS delivered |
| Frog AU → Testy xyz (live) | Federated DM; Testy decrypts with Frog bundle from AU or local after Frog publishes on AU |
| Travel open DM from sync history | Old bubbles locked; new send works |
| Home down, both on AU | DMs work on AU; calls to “home only” user may fail |
| Reset keys one side | Other side gets `pre` message; lane divider (when P1 ships) |

---

## Related docs

- [SECURITY_MODEL.md](SECURITY_MODEL.md) — crypto surfaces
- [FEDERATED_CALLS.md](FEDERATED_CALLS.md) — call signalling
- [internal/FEDERATION_SYNC_AUDIT_REPORT.md](internal/FEDERATION_SYNC_AUDIT_REPORT.md) — account sync scope
