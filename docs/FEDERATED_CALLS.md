# Federated calls and voice

Cross-node WebRTC signaling for FrogTalk. Media stays peer-to-peer (or via TURN); only signaling crosses the federation inbox.

See also: [SECURITY_MODEL.md](SECURITY_MODEL.md), [VOICE_SFU_EVAL.md](VOICE_SFU_EVAL.md).

## Global identifiers

| ID | Format | Used for |
|----|--------|----------|
| `global_call_id` | UUID v4 | 1:1 DM voice/video calls |
| `global_voice_session_id` | UUID v4 | Channel voice session (mesh v1) |

## Authority

- **1:1 calls:** Callee **home server** (`resolve_global_user_home_server_id`) receives `call.offer` and rings the local user. Caller home originates offers and receives `call.answer` / `call.ice` targeted to caller home.
- **Channel voice:** **Anchor server** = room owner’s `server_id` (fallback: node where session started). Roster and `voice.session.*` events fan out to homes of members present in that room.

## Federation event types (signed, prefix `call.` / `voice.`)

### 1:1 (`call.*` — sensitive prefix)

| Type | Direction | Payload highlights |
|------|-----------|-------------------|
| `call.offer` | Caller home → callee home | `global_call_id`, `caller_global_user_id`, `callee_global_user_id`, `call_type`, `sdp`, `fp_sig`, `caller_nickname`, `caller_avatar` |
| `call.answer` | Callee home → caller home | `global_call_id`, `sdp`, `fp_sig`, `renegotiate` |
| `call.ice` | Either home → other home | `global_call_id`, `candidate`, `from_global_user_id`, `to_global_user_id` |
| `call.end` | Either → other | `global_call_id`, `status` |
| `call.reject` | Callee → caller | `global_call_id` |

Outbox uses **targeted** `target_server_ids` (one row per peer). Per-peer `event_id` suffix `@<peer_server_id>` when needed.

### Channel voice (`voice.*` — sensitive prefix)

| Type | Purpose |
|------|---------|
| `voice.session.join` | User joined voice in `room_name` on anchor |
| `voice.session.leave` | User left |
| `voice.signal` | Mesh SDP/ICE: `session_id`, `from_gid`, `to_gid`, `kind` (`offer`/`answer`/`ice`), `sdp` or `candidate` |

Global cap: **8** participants per `global_voice_session_id` (enforced on anchor).

## Local mapping

- `federation_call_map(global_call_id, origin_server_id, local_call_id, role)`
- `calls.global_call_id` column on originating rows

## Preconditions

- `FROGTALK_FEDERATION_CALLS_ENABLED=1` on both nodes (capability `federation-calls-v1` in directory).
- Callee exists locally — `call.offer` apply uses **strict lookup** of the callee's `global_user_id` and refuses to auto-create stub users. The caller side may be materialized from a signed `call.offer` (same path as `dm.message.created`).
- `is_blocked_either_way` on both parties.
- Optional `FROGTALK_FEDERATION_CALLS_REQUIRE_FRIEND=1` (default on) — federated ringing requires a friendship edge so random strangers from federated peers can't ring your users. Flip to `0` for open ringing.
- DM `fp_sig` verification remains **client-side** (Signal identity).
- Origin binding on every `call.*` apply: when a GID's home is already pinned locally, the event's `origin_server_id` must equal that home or the event is dropped.
- Participant binding on `call.answer` / `call.ice` / `call.end` / `call.reject`: the acting GID must resolve to a participant of the local call row (`get_call_participants_by_global_for_local`). Stops third-party peers from spraying signalling at unrelated users by guessing a `global_call_id`.
- Channel voice: `voice.session.join` only accepts the actor's GID when (a) origin binds the GID's home and (b) the GID is a member of the room (or the room is `private=0`). `voice.signal` requires the sender to be a registered remote voice participant **and** the recipient to be a local user currently in voice for the room.

## Limits

- SDP ≤ 32 KiB per event; `fp_sig` ≤ 16 KiB; ICE candidate ≤ 8 KiB; avatar ≤ 200 KiB and restricted to `data:image/*` or `http(s)://` schemes server- and client-side.
- `call_type` allowlist: `voice` / `video` only; anything else collapses to `voice` server-side.
- Inbound `call.offer` is throttled per `(origin_server_id, callee_gid)` (4 / 60 s) on top of the shared federation inbox bucket (600 / 60 s per origin).
- Outbound `call_offer` from a user is throttled to 8 / 30 s — one user cannot ring-bomb their friend list or pump outbound federation queue.
- `FederatedVoiceRegistry` caps remote roster to 64 participants / session and 256 participants / origin.
- `voice.session.*` is ignored for rooms that don't exist locally.

## TURN

Each node publishes `turn_urls` (+ optional username/credential) on `GET /api/network/status` and directory rows. Clients build `RTCPeerConnection` ICE from **local** + **remote home** server entries via `buildIceServers()` in `calls.js`.

`GET /api/network/ice-config` requires authentication (login session). TURN credentials are valuable (relay capacity, bandwidth) and are never published to anonymous callers. Peer TURN entries are only merged into the response for federation rows where `enabled = 1`.

## Channel topology

- **v1 (shipped):** Federated mesh — extend `VoiceManager` + `FederatedVoiceRegistry`.
- **v2 (optional):** SFU on anchor — see [VOICE_SFU_EVAL.md](VOICE_SFU_EVAL.md), flag `FROGTALK_VOICE_SFU=1`.

## Client surfaces

- **Web:** `node/static/js/calls.js` — `buildIceServers()`, `global_call_id`, `to_global_user_id` on WS frames.
- **Android / iOS / desktop:** should mirror the same WS fields and `GET /api/network/ice-config` (not yet wired in native clients).

## Operator checklist

1. Set `FROGTALK_FEDERATION_CALLS_ENABLED=1` on all participating nodes.
2. Publish `FROGTALK_TURN_URLS` (+ credentials) per node.
3. Pin peer pubkeys; keep `FROGTALK_FEDERATION_REQUIRE_SIGS=1`.
4. Ensure friends/DM graph exists before expecting cross-node rings.
