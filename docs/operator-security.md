# Operator security & scaling notes

Practical guidance for anyone self-hosting a FrogTalk node. See `.env.example` for the
variables referenced here.

## Secrets to set

- **`FROGTALK_CSRF_SECRET`** (and/or `FROGTALK_SESSION_SECRET`) — the CSRF/session HMAC
  secret. If unset, the node now auto-generates a random secret to `data/.csrf_secret`
  (mode 0600) and reuses it across restarts, so a default install is no longer pinned to a
  shipped constant. **Set it explicitly** if you run multiple nodes or multiple worker
  processes, so every process computes the same CSRF tokens. Treat it as a secret; do not
  share it across nodes that don't trust each other.
- **`FROGTALK_FEDERATION_TOKEN`** — the shared federation bearer. Keep it secret. Prefer
  signed (`FROGTALK_FEDERATION_AUTH_MODE=signed`) over the shared bearer where you can.
- **`ADMIN_PASSWORD`** — if unset or a known-weak default, the node generates a random
  bootstrap password to `data/.bootstrap_admin_password` (0600). Set a real one and remove
  the file.

## Federation trust

- Keep **`FROGTALK_FEDERATION_REQUIRE_SIGS=1`** in production. Sensitive event types
  (`user.*`, `dm.*`, `social.*`, `call.*`, …) are always signature-checked; the `=0` "soak
  mode" additionally accepts *unsigned* non-sensitive events from any holder of the shared
  token — that's for migrations only.
- Peer public keys are pinned **TOFU** (trust-on-first-contact). At small node counts that's
  fine; for a sensitive deployment, verify a new peer's key out of band before first sync.

## Scaling: one node = one SQLite writer

- The backend is a **single uvicorn process** over **SQLite (WAL)**. WAL gives concurrent
  reads, but there is exactly **one writer at a time**. Scale **vertically** first (fast SSD,
  RAM for page cache); watch SQLite `busy`/lock-wait under load.
- You generally **cannot** add uvicorn workers — multiple processes writing one SQLite file
  contend on the write lock. The horizontal-scale path is migrating the data layer to
  Postgres; plan for it before you outgrow one node.
- Hot-path WebSocket DB **writes** now run off the event loop (worker threads), so a write
  lock-wait no longer stalls every connected client. Watch event-loop lag as a health metric.

## Confidentiality caveats (tell your users honestly)

- **Public rooms are not confidential.** Their AES key is derived from the public room name
  (`frogtalk-public-<roomName>`), so anyone — including any federated node — can derive it.
  Treat public-room content as plaintext-equivalent. (DMs and **private** rooms are real
  E2EE: Signal Protocol for DMs, random 256-bit per-room keys with rotation-on-ban.)
- **Bridges put plaintext on Discord/Telegram by design.** Only public rooms can be bridged
  (E2EE private rooms are blocked from bridging); bridged messages leave the E2EE boundary.

## WebRTC / TURN

- TURN credentials are currently static and shared to every call peer — anyone who joins a
  call can reuse them as a free relay. Prefer **ephemeral TURN REST credentials** (coturn
  `use-auth-secret`, time-limited HMAC) when you can. TURN relay traffic is your bandwidth
  cost; budget for it if you expect many video calls.
- 1:1 calls are peer-to-peer, so call peers learn each other's IP (inherent to WebRTC). Offer
  a relay-only (TURN-forced) option for users who need IP privacy.

## CSP migration

- A strict `script-src` policy now ships in **report-only** mode
  (`FROGTALK_CSP_STRICT_REPORT=1`) and posts violations to `/api/csp-report`. This is
  telemetry for tightening the policy; it never blocks anything. Leave it on so violations
  are collected, and review the `frogtalk.csp` log channel periodically.

## Privacy-respecting monitoring

Monitor metrics, never content: SQLite busy/lock-waits + WAL size; event-loop lag; WS
connection + throttle counts; federation signature-failure counts; TURN bandwidth; media
disk/egress; 5xx rate. Never log message bodies or DM metadata; hash IPs.
