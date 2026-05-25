# FrogTalk Node

This folder is the **federated server**: FastAPI app, web client static assets,
deploy templates, Docker build, operator scripts, and tests. Self-hosting
starts here.

## Quick start (Linux)

```bash
sudo apt install -y git python3 python3-venv python3-pip curl nginx
sudo adduser --disabled-password --gecos "" deploy
sudo mkdir -p /opt/frogtalk && sudo chown deploy:deploy /opt/frogtalk

sudo -u deploy git clone https://github.com/deadinternetfox/frogtalk.git /opt/frogtalk
cd /opt/frogtalk

export PUBLIC_URL="http://YOUR_VPS_IP_OR_DOMAIN"
export FROGTALK_SERVER_NAME="My FrogTalk Node"

# Interactive installer (setup · federation · updates · systemd · status)
bash node/scripts/install.sh

# Or non-interactive (recommended on VPS):
bash node/scripts/install.sh setup -y --public-url "$PUBLIC_URL"
bash node/scripts/install.sh federation -y --public-url "$PUBLIC_URL"
sudo bash node/scripts/install.sh systemd -y
journalctl -u frogtalk -f
```

Full VPS walkthrough: [docs/NODE_INSTALL.md](../docs/NODE_INSTALL.md).

**Tor-only:** set `FROGTALK_TOR_ENABLED=1` and `FROGTALK_ONION_URL=http://….onion` in `.env` (or use the wizard), then run federation-join again.

**Updates** (git fast-forward + venv refresh + service restart):

```bash
bash node/scripts/install.sh update              # check only
bash node/scripts/install.sh update-apply -y     # pull, pip, restart
# or directly:
bash node/scripts/node_update_check.sh --install-dir /opt/frogtalk --apply
```

Shows incoming commits, warns on dirty trees, re-checks runtime symlinks, and pings `/api/ping` after restart. Signed release feed (`FROGTALK_RELEASE_SIGNERS`) is separate — in-app auto-update when configured.

The wizard creates `venv/`, writes `.env`, and symlinks `data/`, `secrets/`, and `.env` into the tree so the unit (`WorkingDirectory=/opt/frogtalk/node`) finds runtime state.

**Docs:** [VPS install guide](../docs/NODE_INSTALL.md) · [Node guide](static/docs-node.html) (`/docs/node`) · [Deploy](deploy/README.md) (mesh JSON, nginx tunnel, board peers) · [API](static/docs-api.html) (`/docs/api`)

**Federation mesh:** optional `FROGTALK_FEDERATION_MESH_FILE` — see `deploy/federation-mesh.example.json` and `federation_mesh.py` (no hardcoded peer list in `routers/federation.py`).

## Layout

```
node/
├── main.py                # FastAPI entrypoint
├── database.py            # SQLite schema + migrations
├── crypto_fed.py          # Ed25519 federation signing
├── ws_manager.py          # WebSocket fan-out
├── routers/               # auth, rooms, dms, ws, federation, social, wall…
├── static/                # web client + docs pages
├── board/                 # Frog Channel imageboard → /board/
├── deploy/                # systemd, nginx, env.example
├── scripts/
│   ├── install.sh               # unified menu (recommended entry)
│   ├── lib/cli.sh               # shared colored CLI helpers
│   ├── node_setup_wizard.sh
│   ├── node_federation_join.sh
│   ├── node_update_check.sh
│   ├── deploy.sh                # rsync full node/ to one host (.env in scripts/)
│   ├── install_board_nginx.sh   # nginx + php-fpm for /board/ (wizard calls this)
│   ├── configure_board_identity.sh
│   └── migrations/
├── tests/
├── requirements.txt
└── Dockerfile
```

## Runtime paths

| Path | Purpose |
|------|---------|
| `/opt/frogtalk/.env` | Secrets and config (not overwritten by deploy) |
| `/opt/frogtalk/data/` | SQLite database and uploads |
| `/opt/frogtalk/secrets/` | Federation keys, release signer pubkeys |
| `/opt/frogtalk/venv/` | Python virtualenv |
| `/opt/frogtalk/node/` | Application code (replaced on deploy) |
| `/opt/frogtalk/node/data` | Symlink → `../data` |
| `/opt/frogtalk/node/.env` | Symlink → `../.env` |
| `/opt/frogtalk/node/secrets` | Symlink → `../secrets` |

## Recommended environment defaults

| Variable | Default intent |
|----------|----------------|
| `FROGTALK_AUTO_UPDATE_ENABLED=0` | Updates are opt-in |
| `FROGTALK_FEDERATION_REQUIRE_SIGS=1` | Unsigned federation events rejected |
| `FROGTALK_FEDERATION_CALLS_ENABLED=1` | Federated `call.*` / `voice.*` + `GET /api/network/ice-config` |
| `FROGTALK_TURN_URLS` + username/credential | STUN/TURN for cross-node WebRTC (coturn on relay nodes) |
| `FROGTALK_FEDERATION_*_IDLE_SEC` / `*_BUSY_SEC` | Inbox/outbox processor poll (defaults 8 / 2) |
| `FROGTALK_RELEASE_SIGNERS=` | Trusted Ed25519 hex pubkeys required to apply updates |
| `FROGTALK_TOR_ENABLED=1` + `FROGTALK_ONION_URL=…` | Hidden-service mode without clearnet leak |
| `FROGTALK_TOR_SOCKS_PROXY=…` | Outbound fetch to `.onion` peers from clearnet hubs |

**FrogSocial across nodes:** only plaintext posts with `privacy` `public` or `followers` replicate to peers. Friends-only or private audiences use encrypted wall posts (`POST /api/wall/posts/encrypted`); peers receive targeted `social.post.created.encrypted` and `social.post.keys.extended` events. Details: `/docs/api` (Federation section).

**Account sync on foreign nodes:** when users visit another node, **Settings → Network → Re-sync from home** pulls channels (themes, slowmode, forwarding lock, DJ-only), DM prefs, graph, profile theme/CSS/client prefs, and FrogSocial posts from their home server (paginated, 300 per page). Details: [SECURITY_MODEL.md](../docs/SECURITY_MODEL.md) (Account sync) and [docs/api](static/docs-api.html).

| `FROGTALK_SYNC_*` flag | Default | Purpose |
|----------------------|---------|---------|
| `FROGTALK_SYNC_PERSIST` | `1` | SQLite sync progress across restarts |
| `FROGTALK_SYNC_BIND_HOME` | `1` | Resume only from pinned home URL |
| `FROGTALK_SYNC_VERIFY_EXPORT` | `1` | Reject mismatched export identity |
| `FROGTALK_SYNC_SIGN_EXPORT` | `1` | Home signs exports; foreign verifies |
| `FROGTALK_SYNC_REQUIRE_EXPORT_SIG` | `1` | Reject unsigned exports when home pubkey pinned |
| `FROGTALK_SYNC_LOGIN_RESUME` | `1` | Auto-resume incomplete sync on login |
| `FROGTALK_SYNC_PAGINATION` | `1` | Social posts beyond 300 per import |
| `FROGTALK_SYNC_STALE_HOURS` | `0` | Optional re-sync TTL (e.g. `24`) |

## Operator scripts

| Script | Purpose |
|--------|---------|
| **`install.sh`** | **Menu:** setup, federation, update, systemd, status |
| `node_setup_wizard.sh` | First-time venv, `.env`, symlinks (also via `install.sh setup`) |
| `node_federation_join.sh` | Mesh join: directory sync, hub announce, pubkey pin, board nav |
| `node_update_check.sh` | Git update check / `--apply` (commits preview, symlinks, pip, restart) |
| `install_board_nginx.sh` | nginx + php-fpm routes for `/board/` (`install.sh board-nginx`) |
| `configure_board_identity.sh` | Board title/subtitle from `FROGTALK_HOME_PAGE` / env |
| `tor_vanity_onion.sh` | Generate `frogtalk*.onion` v3 hostname + optional tor install ([docs/TOR_VANITY_ONION.md](../docs/TOR_VANITY_ONION.md)) |
| `deploy.sh` | Full rsync deploy to one server (see `node/scripts/.env`) |

- **Idempotent** — safe to re-run; missing symlinks are created.
- **Non-fatal skips** — edge cases are reported, not rolled back silently.
- **No silent `.env` edits** — only values you confirm in the wizard.

Peer Ed25519 keys are pinned from each peer’s `/api/network/status` (the official directory listing does not include pubkeys). See `deploy/README.md` (Federation chat delivery).

## Tests

```bash
cd node && python -m pytest tests/ -q
```

Covers sanitizers, federation/Tor behaviour, media proxy guards, and related security regressions.

## See also

- [Repository README](../README.md) — product overview, encryption model, downloads
- [frogtalk.app](https://frogtalk.app) — public node
- [API docs](https://frogtalk.app/docs/api) · [Node docs](https://frogtalk.app/docs/node)
