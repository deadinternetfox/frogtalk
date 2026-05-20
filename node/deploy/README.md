# FrogTalk Node Deploy Templates

Full documentation: **<https://frogtalk.xyz/docs/node>**

This folder ships the production deploy templates the setup wizard installs:

- `frogtalk.service` — systemd unit. Defaults to `WorkingDirectory=/opt/frogtalk/node`,
  `EnvironmentFile=/opt/frogtalk/.env`, runs as user `deploy`.
- `nginx.conf` — reverse-proxy example with WebSocket upgrade headers.
  It is intentionally template-style: set your own `server_name`, cert paths,
  and app upstream port.
- `env.example` — annotated template; copy to `/opt/frogtalk/.env` and fill in
  secrets, base URL, federation token, release signers.

## Quickstart (the easy path)

```bash
git clone https://github.com/deadinternetfox/frogtalk.git /opt/frogtalk
cd /opt/frogtalk
bash node/scripts/node_setup_wizard.sh
```

The wizard installs deps into `/opt/frogtalk/venv/`, writes `.env` with safe
defaults, and wires the runtime symlinks (`node/data`, `node/.env`,
`node/secrets`) so the systemd unit can run with `WorkingDirectory=/opt/frogtalk/node`.

## Manual install (if you don't trust the wizard)

```bash
git clone https://github.com/deadinternetfox/frogtalk.git /opt/frogtalk
cd /opt/frogtalk
python3 -m venv venv && source venv/bin/activate
pip install -r node/requirements.txt
cp node/deploy/env.example .env
$EDITOR .env                       # ADMIN_PASSWORD, PUBLIC_URL, federation token, etc.

# Runtime symlinks (the wizard would do this for you):
mkdir -p data
# IMPORTANT: node/data must be a symlink, not a real directory. If deploy
# creates node/data/ as a folder, uvicorn will open an empty frogtalk.db and
# every API call fails with "no such table: sessions".
ln -sfn /opt/frogtalk/data    node/data
ln -sfn /opt/frogtalk/.env    node/.env
[ -d secrets ] && ln -sfn /opt/frogtalk/secrets node/secrets

# Imageboard JSON state lives under node/board/board_data/ — php-fpm must
# be able to write settings.json (peer pills, federation). Typical fix:
#   sudo chown -R www-data:www-data node/board/board_data node/board/board_uploads

# Try it locally:
cd node && python main.py          # http://localhost:8080
```

## systemd

```bash
sudo cp node/deploy/frogtalk.service /etc/systemd/system/frogtalk.service
# Edit `User=` if you're not running as `deploy`; nothing else needs changing.
sudo systemctl daemon-reload
sudo systemctl enable --now frogtalk
sudo systemctl status frogtalk
journalctl -u frogtalk -f
```

## Docker

Build from the repo root, pointed at `node/Dockerfile`:

```bash
docker build -f node/Dockerfile -t frogtalk .
docker run -d -p 8080:8080 \
  -e ADMIN_PASSWORD=your_password \
  -v $(pwd)/data:/app/data \
  --name frogtalk frogtalk
```

## Cloudflare Tunnel

Production nodes terminate TLS at Cloudflare and run `cloudflared` locally.
The tunnel should forward to **nginx on port 8080** (not uvicorn directly).

1. Install `cloudflared` from the [official .deb release](https://github.com/cloudflare/cloudflared/releases).
2. In **Cloudflare Zero Trust → Networks → Tunnels**, create or open your tunnel
   and set the public hostname origin to `http://localhost:8080`.
3. Run the connector with your tunnel token (store the token outside git):

```bash
sudo cloudflared service install <TUNNEL_TOKEN>
sudo systemctl enable --now cloudflared
```

Or run manually: `cloudflared tunnel run --token <TUNNEL_TOKEN>`

**nginx:** enable only the live `frogtalk` site under `/etc/nginx/sites-enabled/`.
Do not leave stale `frogtalk.bak.*` copies there — duplicate vhosts can send
`Host: frogtalk.xyz` traffic to the wrong upstream port and cause 502s.

**Upgrade:** use the same package manager that installed `cloudflared`
(`dpkg -i` for the .deb, then `systemctl restart cloudflared`). Expect a brief
tunnel reconnect.

## Nginx reverse proxy (HTTPS)

A complete reference config ships at `node/deploy/nginx.conf`. Minimal version:

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

## Join the federation mesh

After install, run the colored operator CLI (fixes `node/data` symlink,
enables federation in `.env`, syncs the official directory, links board nav
pills):

```bash
bash node/scripts/node_federation_join.sh --install-dir /opt/frogtalk -y
sudo systemctl restart frogtalk   # if not restarted by the script
```

Dry-run first: add `--dry-run`. Tor nodes: pass `--onion-url http://….onion`.

## Federation, API, and ops details

- Federation setup, directory registration, signed update flow:
  <https://frogtalk.xyz/docs/node>
- REST + WebSocket API reference for bots/clients:
  <https://frogtalk.xyz/docs/api>
