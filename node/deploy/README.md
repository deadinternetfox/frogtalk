# FrogTalk Node Deploy Templates

Full documentation: **[Node operator guide](https://frogtalk.xyz/docs/node)** (`node/static/docs-node.html` in the repo).

This folder ships production templates the setup wizard copies or references:

| File | Purpose |
|------|---------|
| `frogtalk.service` | systemd unit — `WorkingDirectory=/opt/frogtalk/node`, `EnvironmentFile=/opt/frogtalk/.env`, runs as `deploy` |
| `nginx.conf` | Reference reverse proxy (WebSocket upgrades, static caching, tunnel port 8080) |
| `env.example` | Annotated `.env` template — copy to `/opt/frogtalk/.env` and set secrets, `PUBLIC_URL`, federation, push keys |

## Quickstart

```bash
git clone https://github.com/deadinternetfox/frogtalk.git /opt/frogtalk
cd /opt/frogtalk

# 1) Wizard: venv, .env, runtime symlinks
bash node/scripts/node_setup_wizard.sh

# 2) Federation mesh + official directory + board peer nav
bash node/scripts/node_federation_join.sh --install-dir /opt/frogtalk -y

# 3) systemd (production)
sudo cp node/deploy/frogtalk.service /etc/systemd/system/frogtalk.service
sudo systemctl daemon-reload && sudo systemctl enable --now frogtalk
journalctl -u frogtalk -f
```

The wizard installs Python deps into `/opt/frogtalk/venv/`, writes `.env`, and symlinks `node/data`, `node/.env`, and `node/secrets` so the unit can use `WorkingDirectory=/opt/frogtalk/node` without moving operator state.

**Tor-only nodes:** set `FROGTALK_TOR_ENABLED=1` and `FROGTALK_ONION_URL=http://….onion` in `.env` (wizard can set these), then re-run federation join with `--onion-url` if needed.

## Runtime paths

| Path | Purpose |
|------|---------|
| `/opt/frogtalk/.env` | Config and secrets (never overwritten by hot deploy) |
| `/opt/frogtalk/data/` | SQLite (`frogtalk.db`) and uploads |
| `/opt/frogtalk/secrets/` | Federation signing keys, release signer pubkeys, push credentials |
| `/opt/frogtalk/venv/` | Python virtualenv |
| `/opt/frogtalk/node/` | Application code (replaced on `git pull` / file deploy) |
| `/opt/frogtalk/node/data` | **Symlink** → `../data` (must not be a real directory) |
| `/opt/frogtalk/node/.env` | Symlink → `../.env` |
| `/opt/frogtalk/node/secrets` | Symlink → `../secrets` |

If `node/data` is a real folder, uvicorn opens an empty database and APIs fail with `no such table: sessions`. The federation-join script can repair this symlink.

## Manual install

```bash
git clone https://github.com/deadinternetfox/frogtalk.git /opt/frogtalk
cd /opt/frogtalk
python3 -m venv venv && source venv/bin/activate
pip install -r node/requirements.txt
cp node/deploy/env.example .env
$EDITOR .env    # ADMIN_PASSWORD, PUBLIC_URL, federation, KLIPY_API_KEY, etc.

mkdir -p data
ln -sfn /opt/frogtalk/data    node/data
ln -sfn /opt/frogtalk/.env    node/.env
[ -d secrets ] && ln -sfn /opt/frogtalk/secrets node/secrets

# Imageboard JSON: php-fpm must write board_data (peer pills, federation)
#   sudo chown -R www-data:www-data node/board/board_data node/board/board_uploads

cd node && python main.py    # http://localhost:8080 (default PORT)
```

## systemd

```bash
sudo cp node/deploy/frogtalk.service /etc/systemd/system/frogtalk.service
# Edit User= if not using deploy; paths assume /opt/frogtalk layout above.
sudo systemctl daemon-reload
sudo systemctl enable --now frogtalk
sudo systemctl status frogtalk
journalctl -u frogtalk -f
```

`ExecStart` runs `/opt/frogtalk/venv/bin/python main.py` from `/opt/frogtalk/node` (see `frogtalk.service`).

## Signed updates

When `FROGTALK_RELEASE_SIGNERS` lists trusted Ed25519 pubkeys, in-app updates require a valid signature:

```bash
bash node/scripts/node_update_check.sh          # check only
bash node/scripts/node_update_check.sh --apply  # git pull + restart
```

`FROGTALK_AUTO_UPDATE_ENABLED=0` by default — updates stay opt-in.

## Docker

Build from the **repository root** (not `node/` alone):

```bash
docker build -f node/Dockerfile -t frogtalk .
docker run -d -p 8080:8080 \
  -e ADMIN_PASSWORD=your_password \
  -v "$(pwd)/data:/app/data" \
  --name frogtalk frogtalk
```

The image `WORKDIR` is `/app` with `node/` contents copied in; `CMD` is `python main.py`.

## Cloudflare Tunnel

Production clearnet nodes often terminate TLS at Cloudflare and run `cloudflared` locally. Point the tunnel origin at **nginx on port 8080**, not uvicorn directly.

1. Install [cloudflared](https://github.com/cloudflare/cloudflared/releases) (`.deb` on Debian/Ubuntu).
2. In **Cloudflare Zero Trust → Networks → Tunnels**, set the public hostname origin to `http://localhost:8080`.
3. Install the connector (keep the token out of git):

```bash
sudo cloudflared service install <TUNNEL_TOKEN>
sudo systemctl enable --now cloudflared
```

Manual run: `cloudflared tunnel run --token <TUNNEL_TOKEN>`

**nginx:** enable only the live `frogtalk` site under `/etc/nginx/sites-enabled/`. Stale `frogtalk.bak.*` vhosts can route `Host: frogtalk.xyz` to the wrong upstream and cause 502s.

**Upgrade cloudflared:** reinstall the same package (`dpkg -i` …), then `systemctl restart cloudflared` (brief reconnect).

## WebRTC TURN (cross-node calls)

For federated voice/video, set in `.env`:

```bash
FROGTALK_FEDERATION_CALLS_ENABLED=1
FROGTALK_TURN_URLS=stun:stun.l.google.com:19302,turn:turn.yourdomain.com:3478
FROGTALK_TURN_USERNAME=your_turn_user
FROGTALK_TURN_CREDENTIAL=your_turn_secret
```

Clients fetch merged ICE via `GET /api/network/ice-config?peer_server_id=<uuid>`.
Install [coturn](https://github.com/coturn/coturn) on each node that relays media.
Spec: [docs/FEDERATED_CALLS.md](../../docs/FEDERATED_CALLS.md).

## Nginx and app port

Default app port in `env.example` is **`PORT=8080`**.

The bundled `nginx.conf` listens on **80** and **8080** (tunnel) and proxies to upstream `127.0.0.1:8000`. Before going live, either:

- set `PORT=8000` in `.env` to match that upstream, **or**
- change the `upstream frogtalk_app` block to the port you use (e.g. `8080`).

The imageboard’s internal API default (`FROGTALK_INTERNAL_API` in `board_config.php`) assumes `http://127.0.0.1:8000` when unset — keep board and app ports aligned.

Minimal HTTPS vhost (app on 8080, no separate upstream name):

```nginx
server {
    listen 443 ssl;
    server_name chat.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Full reference: `node/deploy/nginx.conf` (CSP is emitted by FastAPI; do not duplicate `Content-Security-Policy` in nginx for app routes).

## Join the federation mesh

```bash
bash node/scripts/node_federation_join.sh --install-dir /opt/frogtalk -y
```

The CLI fixes common footguns (`node/data` symlink, board permissions), enables federation in `.env`, syncs the [official directory](https://frogtalk.xyz/api/network/servers), and links imageboard peer nav pills.

| Flag | Effect |
|------|--------|
| `--dry-run` | Print actions without writing |
| `--onion-url URL` | Set `FROGTALK_ONION_URL` (Tor mode) |
| `--skip-board` | Skip imageboard peer linking |
| `--skip-restart` | Do not restart `frogtalk` |

Restart if the script did not: `sudo systemctl restart frogtalk`.

**FrogSocial replication:** only plaintext posts with `privacy` `public` or `followers` federate to peers. Friends-only audiences use encrypted wall posts and targeted federation events — see [API docs](https://frogtalk.xyz/docs/api) (Federation section).

## Hot deploy (maintainers)

From a dev checkout at repo root, sync specific files to remote nodes and restart:

```bash
node/scripts/deploy_nodes.sh node/routers/federation.py node/static/js/wall_crypto.js
```

Paths under `node/` map to `/opt/frogtalk/node/` on the server. Hosts and SSH ports are defined inside the script — edit there for your fleet. Default invocation without arguments ships a curated static/JS bundle.

Does **not** replace `git pull` for schema migrations; use `node_update_check.sh --apply` or a full deploy when `database.py` migrations change.

## Recommended production defaults

| Variable | Intent |
|----------|--------|
| `FROGTALK_FEDERATION_REQUIRE_SIGS=1` | Reject unsigned federation inbox events |
| `FROGTALK_FEDERATION_AUTH_MODE=dual` | Signed push + legacy token where configured |
| `FROGTALK_AUTO_UPDATE_ENABLED=0` | No silent auto-upgrades |
| `FROGTALK_RELEASE_SIGNERS=` | Comma-separated trusted update signer pubkeys |
| `FROGTALK_SERVER_WEBUI_ENABLED=0` | Enable `/server` operator UI only when needed |
| `ADMIN_PASSWORD=` | Empty → one-time random password logged on first boot |

See `env.example` for GIF (KLIPY), push (APNs/FCM), IndexNow, and federation token notes.

## See also

- [Node README](../README.md) — layout, tests, operator scripts
- [Routers README](../routers/README.md) — API module map
- [Repository README](../../README.md) — encryption model and downloads
- Live: [Node docs](https://frogtalk.xyz/docs/node) · [API reference](https://frogtalk.xyz/docs/api)
