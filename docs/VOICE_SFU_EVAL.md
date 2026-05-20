# Voice SFU evaluation (channel voice v2)

Mesh federated channel voice (v1) does not scale past a few cross-node participants: ICE volume grows as O(n²) across homes. v2 replaces pairwise federated `voice.signal` with a selective forwarding unit (SFU) on the **anchor** node.

## Candidates

| Option | Pros | Cons |
|--------|------|------|
| **mediasoup** | Node.js; common in WebRTC apps | Separate worker process; ops complexity |
| **Janus** | Mature plugins | C core; harder to embed in FastAPI lifecycle |
| **LiveKit** | Hosted or self-host SDK | Heavier dependency; license for scale |

## Recommendation (spike outcome)

1. **Short term:** Ship federated **mesh** v1 (`voice.session.*` / `voice.signal`) behind `FROGTALK_FEDERATION_CALLS_ENABLED`.
2. **v2 spike:** PoC **mediasoup** sidecar on anchor node; FrogTalk FastAPI issues room tokens; federation carries only `voice.sfu.join` + roster (no ICE across mesh).
3. **Cutover:** `FROGTALK_VOICE_SFU=1` on anchor disables mesh fan-out for that room; clients connect to `wss://anchor/sfu` (exact URL TBD in PoC).

## Federation protocol (v2 draft)

- `voice.sfu.session` — anchor advertises SFU endpoint + session id.
- `voice.sfu.join` — member home notifies client to attach to SFU with short-lived JWT.
- No `voice.signal` ICE between nodes when SFU active.

## Ops

- TURN still required for clients behind symmetric NAT.
- Anchor CPU/bandwidth becomes bottleneck; monitor per-room bitrate caps.

## Status

Evaluation document only — PoC not required for mesh v1 release. Implement SFU when cross-node channel voice exceeds ~4 participants routinely.
