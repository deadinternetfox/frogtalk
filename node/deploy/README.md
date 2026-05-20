# FrogTalk Node Deploy Templates

Full documentation: **<https://frogtalk.xyz/docs/node>**

This folder ships the production deploy templates the setup wizard installs:

- `frogtalk.service` — systemd unit. Defaults to `WorkingDirectory=/opt/frogtalk/node`,
  `EnvironmentFile=/opt/frogtalk/.env`, runs as user `deploy`.
- `nginx.conf` — reverse-proxy example with WebSocket upgrade headers.
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
ln -sfn /opt/frogtalk/data    node/data
ln -sfn /opt/frogtalk/.env    node/.env
[ -d secrets ] && ln -sfn /opt/frogtalk/secrets node/secrets

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

## Federation, API, and ops details

- Federation setup, directory registration, signed update flow:
  <https://frogtalk.xyz/docs/node>
- REST + WebSocket API reference for bots/clients:
  <https://frogtalk.xyz/docs/api>
