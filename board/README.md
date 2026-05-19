<<<<<<< HEAD
# Imageboard Standalone

This is a standalone copy of the imageboard stack extracted from the main project.
=======
# Frog Channel board

Anonymous imageboard (“Frog Channel”) for [FrogTalk](https://frogtalk.xyz): threads, replies, greentext, media uploads, live board chat, moderation, and optional federation between nodes.
>>>>>>> 262e4f5 (docs(board): document standalone vs FrogTalk-integrated deployment.)

## Standalone or part of FrogTalk?

| Mode | What you run | What works |
|------|----------------|------------|
| **Standalone** | PHP only (`router.php` + this folder) | Full board: post, reply, catalog, admin, board chat, likes, previews |
| **FrogTalk production** | nginx + PHP (`board/`) + Python app (`main.py`) | Everything above, plus FrogTalk mini-widget (DMs/channels in sidebar), sitemaps, and node admin controls over board identity |

The board **does not require** the Python app for core imageboard features. It **does** require the main FrogTalk app on the **same origin** if you want the embedded FrogTalk sidebar (`/app?mini=1` from `board.php`). On a plain PHP dev server that sidebar shows sign-in prompts until FrogTalk is running behind the same host.

In production, only this folder is used:

- **Repo path:** `board/`
- **Server path:** `/opt/frogtalk/board/`
- **Public URL:** `/board/` (see `deploy/nginx.conf`)

The old `imageboard/` directory was removed; it was a duplicate leftover after the rename to `board/`.

## Requirements

- **PHP 8.0+** (8.1+ recommended; uses modern syntax and `match`)
- Extensions: `json`, `session`, `fileinfo`, `gd` (thumbnails)
- Writable directories (created on first run): `board_data/`, `board_uploads/`, `board_previews/`

## Quick start (standalone, local)

```bash
cd board
cp .env.example .env   # optional: Telegram, $GOYIM bump settings
php -S 127.0.0.1:8080 router.php
```

Open:

| URL | Purpose |
|-----|---------|
| http://127.0.0.1:8080/board | Main index / threads |
| http://127.0.0.1:8080/board/admin | Moderation panel |

Default admin username is configured in `board_config.php` (`ADMIN_USER`). Change `ADMIN_PASS_HASH` before any public deployment (generate with `php -r "echo password_hash('your-password', PASSWORD_BCRYPT);"`).

First run creates `board_data/settings.json` with sensible defaults.

## Production (FrogTalk node)

Typical layout on a node:

```text
/opt/frogtalk/
├── main.py              # FastAPI app (/app, API, WS)
├── static/              # Web client
└── board/               # This PHP stack → /board/
    ├── router.php       # nginx fastcgi entry
    ├── board.php
    ├── board_admin.php
    └── board_data/      # threads, bans, settings (JSON)
```

nginx routes `/board` and `/board_uploads` / `/board_previews` to this tree (see `deploy/nginx.conf`). Deploy board files with the rest of the repo; restart `frogtalk` (Python) after app changes; PHP files are picked up on the next request.

The Python app reads `board_data/threads.json` for SEO sitemaps (`FROGTALK_BOARD_THREADS` env, default `/opt/frogtalk/board/board_data/threads.json`). Node operators can edit board title, federation, and Tor settings from **Server Admin** in the main app or from `/board/admin`.

## What's in this folder

| File | Role |
|------|------|
| `router.php` | URL router for PHP built-in server and nginx |
| `board.php` | Main board UI |
| `board_admin.php` | Admin: bans, deletes, approval queue, settings |
| `board_config.php` | Shared config, bans, uploads, federation helpers |
| `board_chat.php` | Live board chat API |
| `board_likes.php` | Like/unlike API |
| `board_preview.php` | OG preview images |
| `board_api.php` | Public federation info (`/board/api/info`, `/board/api/peers`) |
| `board_tor_gateway.php` | Tor-only gateway page |
| `telegram_bot.php` | Optional new-thread notifications |
| `index.php` | Redirects `/` → `/board` |

Runtime data (gitignored): `board_data/`, `board_uploads/`, `board_previews/`.

## Configuration

**`.env`** (optional, copy from `.env.example`):

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — new-thread Telegram alerts
- `GOYIM_*` — optional Solana bump / holder badge integration

**`board_data/settings.json`** — created automatically; toggles images/video/audio, rate limits, federation, Tor-only mode, announcements, etc. Editable in `/board/admin`.

**`board_config.php`** — admin username/password hash, limits (`MAX_THREADS`, `MAX_FILE_SIZE`), paths.

## Features (high level)

- Thread/reply posting with images, audio, video (optional mod approval)
- Catalog view, sticky/locked threads, engagement-based sort (“FrogAlgo”)
- IP bans (uses real client IP when behind Cloudflare / `X-Forwarded-For`)
- Per-board live chat
- Federated peers API for multi-node boards
- Optional Tor-only clearnet gateway

## Security notes

- Change default admin credentials before going public.
- `board_data/` and uploads contain operational data; back them up and restrict filesystem permissions.
- Admin actions require CSRF tokens; session cookies are `HttpOnly` / `SameSite=Strict`.

## Related docs

- Main project: [`../README.md`](../README.md)
- Node deployment: [`../deploy/README.md`](../deploy/README.md)
- Deploy script for both nodes: [`../scripts/deploy_nodes.sh`](../scripts/deploy_nodes.sh)
