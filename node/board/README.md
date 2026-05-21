# Frog Channel board

Anonymous imageboard ("Frog Channel") for [FrogTalk](https://frogtalk.xyz): threads, replies, greentext, media uploads, live board chat, moderation, and optional federation between nodes.

This folder lives under **`node/board/`** — it ships with the federated server, not as a separate top-level repo tree.

## Standalone or part of FrogTalk?

| Mode | What you run | What works |
| --- | --- | --- |
| **Standalone** | PHP only (`router.php` + this folder) | Full board: post, reply, catalog, admin, board chat, likes, previews |
| **FrogTalk production** | nginx + PHP (`node/board/`) + FastAPI (`node/main.py`) | Everything above, plus FrogTalk mini-widget (DMs/channels in sidebar), sitemaps, and node admin controls over board identity |

The board does **not** require the Python app for core imageboard features. It **does** require the main FrogTalk app on the **same origin** if you want the embedded FrogTalk sidebar (`/app?mini=1` from `board.php`). On a plain PHP dev server, that sidebar shows sign-in prompts until FrogTalk is running behind the same host.

## Paths

| | |
| --- | --- |
| **Repo path** | `node/board/` |
| **Server path** | `/opt/frogtalk/node/board/` |
| **Public URL** | `/board/` (unchanged — nginx still routes `/board` to this tree) |
| **nginx template** | `node/deploy/nginx.conf` |

## Requirements

- **PHP 8.0+** (8.1+ recommended)
- Extensions: `json`, `session`, `fileinfo`, `gd` (thumbnails)
- Writable directories (created on first run): `board_data/`, `board_uploads/`, `board_previews/`

## Quick start (standalone, local)

```bash
cd node/board
cp .env.example .env   # optional: Telegram, GOYIM bump settings
php -S 127.0.0.1:8080 router.php
```

| URL | Purpose |
| --- | --- |
| `http://127.0.0.1:8080/board` | Main index / threads |
| `http://127.0.0.1:8080/board/admin` | Moderation panel |

Change `ADMIN_PASS_HASH` in `board_config.php` before any public deployment:

```bash
php -r "echo password_hash('your-password', PASSWORD_BCRYPT);"
```

## Production (FrogTalk node)

```text
/opt/frogtalk/
├── .env
├── data/
├── venv/
└── node/
    ├── main.py              # FastAPI (/app, API, WS)
    ├── static/              # web client
    └── board/               # this PHP stack → public /board/
        ├── router.php
        ├── board.php
        ├── board_admin.php
        └── board_data/      # threads, bans, settings (JSON, gitignored)
```

**First install:** the setup wizard runs `install_board_nginx.sh` (clearnet proxy + `/board/` PHP) and `configure_board_identity.sh`. Re-apply nginx with `sudo bash node/scripts/install.sh board-nginx --install-dir /opt/frogtalk`.

**Updates:** deploy board PHP with the rest of the node tree, or `bash node/scripts/deploy_board.sh` for PHP-only hotfixes (maintainers: `deploy_fleet.local.sh`, never commit host IPs). Restart `frogtalk` after Python changes; PHP is picked up on the next request.

The FastAPI app reads `board_data/threads.json` for SEO sitemaps. Default path:

`/opt/frogtalk/node/board/board_data/threads.json`

Override with `FROGTALK_BOARD_DATA_PATH` or `FROGTALK_BOARD_DATA_DIR` in `.env`. Node operators can edit board title, federation, and Tor settings from **Server Admin** in the main app or from `/board/admin`.

## What's in this folder

| File | Role |
| --- | --- |
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
| `index.php` | Redirects `/` to `/board` |

Runtime data (gitignored): `board_data/`, `board_uploads/`, `board_previews/`.

## Configuration

**`.env`** (optional, copy from `.env.example`):

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — new-thread Telegram alerts
- `GOYIM_*` — optional Solana bump / holder badge integration

**`board_data/settings.json`** — created automatically; editable in `/board/admin`.

## Security notes

- Change default admin credentials before going public.
- Back up `board_data/` and uploads; restrict filesystem permissions.
- Admin actions require CSRF tokens; session cookies are `HttpOnly` / `SameSite=Strict`.

## Related docs

- Main project: [../../README.md](../../README.md)
- Node deployment: [../deploy/README.md](../deploy/README.md)
- Security model: [../../docs/SECURITY_MODEL.md](../../docs/SECURITY_MODEL.md)
