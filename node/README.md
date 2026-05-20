# FrogTalk Node

This folder is the **federated server**: FastAPI app, web client static assets,
deploy templates, Docker build, operator scripts, and tests. Self-hosting
starts here.

## Quick start (Linux)

```bash
git clone https://github.com/deadinternetfox/frogtalk.git /opt/frogtalk
cd /opt/frogtalk

# 1) Wizard: venv, .env, symlinks (node/data → ../data)
bash node/scripts/node_setup_wizard.sh

# 2) Join federation: official directory + board peer nav
bash node/scripts/node_federation_join.sh --install-dir /opt/frogtalk -y

# 3) systemd (production)
sudo cp node/deploy/frogtalk.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now frogtalk
journalctl -u frogtalk -f
```

**Tor-only:** set `FROGTALK_TOR_ENABLED=1` and `FROGTALK_ONION_URL=http://….onion` in `.env` (or use the wizard), then run federation-join again.

**Updates** (signature-verified when signers are configured):

```bash
bash node/scripts/node_update_check.sh
bash node/scripts/node_update_check.sh --apply
```

The wizard creates `venv/`, writes `.env`, and symlinks `data/`, `secrets/`, and `.env` into the tree so the unit (`WorkingDirectory=/opt/frogtalk/node`) finds runtime state.

**Docs:** [Node guide](static/docs-node.html) (`/docs/node` on a live server) · [Deploy](deploy/README.md) · [API reference](static/docs-api.html) (`/docs/api`)

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
│   ├── node_setup_wizard.sh
│   ├── node_federation_join.sh
│   ├── node_update_check.sh
│   ├── deploy_nodes.sh          # SCP hot deploy to production fleet
│   ├── deploy.sh                # rsync full node/ to one host (.env in scripts/)
│   ├── deploy_board.sh          # imageboard PHP hotfix
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

## Operator scripts

| Script | Purpose |
|--------|---------|
| `node_setup_wizard.sh` | First-time venv, `.env`, symlinks |
| `node_federation_join.sh` | Mesh join: directory sync (retries), pubkey pin, board nav, resilient fallback |
| `node_update_check.sh` | Signed update check / `--apply` |
| `deploy_nodes.sh` | Maintainer SCP to production peers (see `deploy/README.md`) |
| `deploy.sh` | Full rsync deploy to one server |
| `deploy_board.sh` | Board PHP-only hotfix |

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
- [frogtalk.xyz](https://frogtalk.xyz) — public node
- [API docs](https://frogtalk.xyz/docs/api) · [Node docs](https://frogtalk.xyz/docs/node)
