# FrogTalk API routers

FastAPI route modules for the FrogTalk node. Each file owns one product surface;
`main.py` mounts them under `/api` (or at the app root for WebSocket and server
admin). Business logic and SQL live in `database.py`; real-time delivery uses
`ws_manager.py`.

Full endpoint lists: [API reference](../static/docs-api.html) (`/docs/api` on a
running server).

## How routes are mounted

| Mount | Module(s) | Notes |
|-------|-----------|--------|
| `/api/*` | Most routers below | Session via `X-Session-Token` / cookie |
| `/api` + PIN gate | Rooms, messages, DMs, social, wall, calls, … | Returns `423` until PIN verified when enabled |
| `/api` (open) | `auth`, `directory`, `preview`, `external`, `federation`, `media` (auth inside) | Usable before unlock or without PIN |
| `/api` (bridge token) | `bridge` | Bot ingress uses `bridge_token`, not session PIN |
| App root | `ws` | `WS /ws/{room_name}` |
| App root | `server_admin` | `/server` WebUI + `/api/server-admin/*` (separate admin session) |

Registration order matters in `main.py` (e.g. `friends.users_router` before
`users.router` so `/users/search` is not captured as `/users/{id}`).

## Module map

### Core chat

| File | Prefix | Responsibility |
|------|--------|----------------|
| `auth.py` | `/auth` | Register, login, logout, sessions, captcha, federation ticket login, PIN unlock |
| `rooms.py` | `/rooms` | Create/join/list rooms, members, bans, keys, slowmode, themes |
| `messages.py` | `/messages` | Room message REST fallback, history, edits, reactions |
| `ws.py` | — | WebSocket rooms, DMs, typing, calls signaling, social notifications, federation-driven events |
| `dms.py` | `/dms` | DM channels, send/history, federation enqueue on send |
| `signal.py` | `/signal` | Signal Protocol prekey bundles (X3DH / Double Ratchet) |

### Social & wall

| File | Prefix | Responsibility |
|------|--------|----------------|
| `social.py` | `/social` | Feed, explore, reels, follow, stories, profile surfaces |
| `wall.py` | `/wall` | Posts, encrypted posts, reactions, comments, reposts, settings |
| `friends.py` | `/friends`, `/users` | Friend requests, search (`users_router`), blocks |
| `users.py` | `/users` | Profiles, privacy, avatars, search (after friends router) |

### Discovery & media

| File | Prefix | Responsibility |
|------|--------|----------------|
| `directory.py` | `/directory` | Public channel directory, featured, likes, listings |
| `invites.py` | `/invites` | Channel invite codes and landing pages |
| `media.py` | `/media` | Authenticated media blob serving (off-SQLite) |
| `gifs.py` | `/media` | GIF search proxy (Tenor) |
| `emojis.py` | `/emojis` | Custom emoji packs |
| `preview.py` | `/preview` | Link preview fetch (sanitized) |
| `proxy.py` | `/proxy` | SSRF-guarded image proxy for themes |
| `location.py` | `/location` | Geolocation helpers |

### Integrations

| File | Prefix | Responsibility |
|------|--------|----------------|
| `bridge.py` | `/bridges`, `/discord-bridges`, … | Discord/Telegram bridges, outbound room relay |
| `bots.py` | `/developer` | API keys, bot accounts, channel install |
| `external_api.py` | `/external` | Token-authenticated bot REST API |
| `calls.py` | `/calls` | WebRTC call setup, fingerprint verification |
| `push.py` | `/push` | Web push subscription endpoints |

### Federation & operations

| File | Prefix | Responsibility |
|------|--------|----------------|
| `federation.py` | `/network`, `/federation`, `/identity` | Peer directory, signed inbox/outbox, updates, identity claims, FrogSocial federation handlers |
| `server_admin.py` | `/server`, `/api/server-admin` | Operator dashboard, node probe/block, moderation controls |
| `admin.py` | `/admin` | In-app admin ban/kick/mute (requires admin + optional admin PIN) |

### Other

| File | Prefix | Responsibility |
|------|--------|----------------|
| `bug_reports.py` | `/bug-reports` | User-submitted bug reports |

### Internal helpers (not mounted)

| File | Role |
|------|------|
| `_css_inline.py` | Sanitize federated profile inline CSS |
| `_media_safety.py` | Image re-encode / polyglot rejection for uploads |

## Federation (`federation.py`)

Largest router: network discovery, Ed25519-signed replication, and inbound
event application.

**Outbound:** `enqueue_server_event()` signs and writes `federation_outbox_events`.
Background `federation_outbox_processor()` pushes batches to peers. Encrypted wall
events use **targeted** rows (`target_server_id`) and per-peer scoped wraps.

**Inbound:** `POST /api/federation/events/inbox` validates signatures (when
`FROGTALK_FEDERATION_REQUIRE_SIGS=1`), rate limits, clock skew, then dispatches:

| Prefix / type | Examples |
|---------------|----------|
| `user.` | Profile updates |
| `dm.` | `dm.message.created` |
| `friend.` | Request, accept, custom sounds |
| `social.` | Posts, encrypted posts, comments, reactions, reposts, follows, stories |
| `message.` | Federated room messages |
| Room / bot / sticker | Moderation, bot upsert, sticker packs |

Sensitive types require a **pinned peer pubkey**; actors on `social.*` events must
match **home server** for their `global_user_id`. Payloads pass `_fed_*` validators
(size caps, media type whitelist, UUID checks).

Wall helpers used from handlers live in `database.py` (`apply_federated_wall_*`,
`federation_wall_map`).

## WebSocket (`ws.py`)

Single entry: `GET /ws/{room_name}?token=…`. Handles room chat, DM frames, call
signaling, typing, and server-pushed events (`social_notification`, `story_posted`,
`wall_rewrap_needed`, etc.). Room messages from REST also fan out via
`enqueue_room_message_created` in federation + `broadcast_room` where applicable.

## Security conventions

- **Session:** `deps.get_current_user` / `get_current_user` on protected routes.
- **Rate limits:** `slowapi` `Limiter` on hot paths (auth, social, wall, federation inbox).
- **PIN gate:** Router-level `pin_gate` dependency from `main.py` on sensitive surfaces.
- **Admin PIN:** `admin.py` adds `admin_pin_gate` when users enable admin re-prompt.
- **Federation:** No nickname auto-create on apply (unless legacy env override);
  encrypted recipient wraps only attach to existing local users.
- **Bridges:** Plaintext only; private E2EE rooms rejected at bridge create.

## Adding a new router

1. Create `routers/my_feature.py` with `router = APIRouter(prefix="/my-feature", tags=[…])`.
2. Import and `app.include_router(..., prefix="/api")` in `main.py`.
3. Decide PIN gating: add to `_PIN_GATED` if the surface should lock with the app PIN.
4. Document endpoints in `static/docs-api.html`.
5. If data must replicate to peers, enqueue via `federation.enqueue_server_event`
   (signed) — never raw `insert_federation_outbox_event` for user-visible events.

## See also

- [Node README](../README.md) — deploy paths, env defaults, quick start
- [Repository README](../../README.md) — encryption model and product overview
