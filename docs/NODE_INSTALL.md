# FrogTalk node — VPS install guide

This guide walks through running a **FrogTalk federation node** on a clean Linux VPS: clone the repo, run the **CLI setup wizard**, join the public mesh, put **nginx + HTTPS** in front, and verify sync with the official directory.

- **Public reference node:** [https://frogtalk.xyz](https://frogtalk.xyz)
- **Live operator page (same content, shorter):** [https://frogtalk.xyz/docs/node](https://frogtalk.xyz/docs/node)
- **Typical install root:** `/opt/frogtalk`

> **Security:** Never commit `.env`, SSH passwords, federation tokens, or private keys. Use SSH keys for login; store secrets only on the server. This document uses placeholders like `<YOUR_DOMAIN>` and `<SSH_USER>`.

---

## What you are installing

A FrogTalk **node** is a self-contained stack:

| Piece | Role |
|-------|------|
| **FastAPI app** (`node/main.py`) | REST + WebSocket API, web client, admin |
| **SQLite** (`data/frogtalk.db`) | Users, rooms, federation inbox/outbox |
| **Vanilla JS UI** (`node/static/`) | Browser app at `/app` |
| **Optional PHP board** (`node/board/`) | Frog Channel imageboard at `/board/` |
| **Federation** | Ed25519-signed events; directory sync from `frogtalk.xyz` |

The **install wizard** is a **bash CLI** (`node/scripts/node_setup_wizard.sh` via `install.sh setup`) — not a browser page. After the node is up, users register at `/app` and admins use the `admin` account from `.env`.

---

## Recommended VPS specs

| Size | vCPU | RAM | Disk | Notes |
|------|------|-----|------|-------|
| **Small** (friends / family) | 1 | 2 GB | 20 GB | SQLite + light traffic |
| **Medium** (community) | 2 | 4 GB | 40 GB | Board uploads, federation |
| **Busy** | 4+ | 8 GB+ | 80 GB+ | Many peers, media, coturn for calls |

**OS:** Debian 12, Ubuntu 22.04/24.04 LTS, or similar systemd-based Linux. **Python:** 3.10+ (3.11+ recommended; Docker image uses 3.12).

---

## Overview (happy path)

```bash
# On the VPS as a sudo-capable user (SSH key auth — see below)
sudo apt update && sudo apt install -y git python3 python3-venv python3-pip \
  curl nginx certbot python3-certbot-nginx ufw

sudo mkdir -p /opt && sudo chown "$USER":"$USER" /opt
cd /opt
git clone https://github.com/deadinternetfox/frogtalk.git
cd frogtalk

# Interactive: venv, .env, symlinks, optional federation + systemd
bash node/scripts/install.sh

# Or non-interactive defaults:
bash node/scripts/install.sh setup -y
bash node/scripts/install.sh federation -y
bash node/scripts/install.sh systemd -y
```

Then point DNS at the VPS, configure nginx + TLS, open the firewall, and verify federation (sections below).

---

## 1) Bootstrap the VPS (SSH, user, firewall)

### SSH access

Prefer **SSH keys**, not passwords, for day-to-day access:

```bash
# On your laptop
ssh-keygen -t ed25519 -f ~/.ssh/frogtalk_vps -C "frogtalk-ops"
ssh-copy-id -i ~/.ssh/frogtalk_vps.pub <SSH_USER>@<YOUR_VPS_IP>
ssh -i ~/.ssh/frogtalk_vps <SSH_USER>@<YOUR_VPS_IP>
```

If the provider gave a one-time root password, use it only for first login, create an unprivileged user, install your key, then **disable password authentication** in `sshd_config` when you are sure key login works.

Do **not** store provider passwords in git, wiki, or ticket comments.

### Dedicated service user (recommended)

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG sudo deploy   # optional: sudo for systemd/nginx
sudo mkdir -p /opt/frogtalk
sudo chown deploy:deploy /opt/frogtalk
```

The shipped unit file runs as `User=deploy` ([`node/deploy/frogtalk.service`](../node/deploy/frogtalk.service)). Clone and run the wizard as `deploy` (or adjust `User=` in the unit).

### Firewall (UFW example)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp    # HTTP (certbot + redirect)
sudo ufw allow 443/tcp   # HTTPS
# Do NOT expose uvicorn 8080 publicly if nginx terminates TLS
sudo ufw enable
sudo ufw status
```

Federation uses **outbound HTTPS** from your node to peers. Inbound federation push hits your **public HTTPS URL** (nginx → `127.0.0.1:8080`).

---

## 2) DNS

Create records pointing at your VPS:

| Type | Name | Value |
|------|------|--------|
| **A** | `chat` (or `@`) | `<YOUR_VPS_IPV4>` |
| **AAAA** | same | `<YOUR_VPS_IPV6>` (optional) |

Example hostname: `chat.yourdomain.com` → use this as `PUBLIC_URL=https://chat.yourdomain.com`.

Propagation can take minutes to hours. Test:

```bash
dig +short chat.yourdomain.com A
curl -sI "http://chat.yourdomain.com" | head -5
```

---

## 3) Clone repo and run the install wizard

```bash
cd /opt
git clone https://github.com/deadinternetfox/frogtalk.git
cd frogtalk

bash node/scripts/install.sh
```

Menu commands:

| Command | Purpose |
|---------|---------|
| `setup` | First-time: `venv`, `.env`, runtime symlinks |
| `federation` | Join mesh: directory sync, pubkey pin, board nav |
| `systemd` | Install `frogtalk.service` |
| `update` / `update-apply` | Git fast-forward + pip + restart |
| `status` | Ping API + list federation peers |

Non-interactive:

```bash
bash node/scripts/install.sh setup -y --install-dir /opt/frogtalk
bash node/scripts/install.sh federation -y --install-dir /opt/frogtalk
```

### What the wizard does

- Creates `/opt/frogtalk/venv/` and installs `node/requirements.txt`
- Copies `node/deploy/env.example` → `.env` (if missing)
- Sets `PUBLIC_URL`, `ADMIN_PASSWORD`, federation defaults
- Symlinks `node/data` → `../data`, `node/.env` → `../.env`, `node/secrets` → `../secrets`
- Optionally runs `node_federation_join.sh`

### Manual equivalent (no wizard)

```bash
cd /opt/frogtalk
python3 -m venv venv && source venv/bin/activate
pip install -r node/requirements.txt
cp node/deploy/env.example .env
# Edit .env — see node/deploy/env.example
mkdir -p data secrets
ln -sfn /opt/frogtalk/data    node/data
ln -sfn /opt/frogtalk/.env    node/.env
ln -sfn /opt/frogtalk/secrets node/secrets
cd node && python main.py   # http://127.0.0.1:8080
```

### Admin account

On first boot the app creates user **`admin`**. If `ADMIN_PASSWORD` in `.env` is empty, a **one-time random password** is generated and logged — copy it from `journalctl`, log in at `/app`, and rotate immediately.

---

## 4) Configure `.env` (essentials)

```bash
nano /opt/frogtalk/.env
```

| Variable | Purpose |
|----------|---------|
| `HOST` / `PORT` | Bind address (default `0.0.0.0:8080` — keep behind nginx) |
| `PUBLIC_URL` | Clearnet URL peers and clients use |
| `ALLOWED_ORIGINS` | CORS — include your `https://chat.yourdomain.com` |
| `ADMIN_PASSWORD` | Bootstrap admin (or leave empty for one-shot generated) |
| `FROGTALK_FEDERATION_ENABLED=1` | Enable federation |
| `FROGTALK_FEDERATION_REQUIRE_SIGS=1` | Reject unsigned inbox events (recommended) |
| `FROGTALK_OFFICIAL_DIRECTORY_URL` | Default `https://frogtalk.xyz/api/network/servers` |
| `FROGTALK_AUTO_UPDATE_ENABLED=0` | Opt-in updates only |

Generate a federation shared secret for nodes you control:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Set `FROGTALK_FEDERATION_TOKEN` only when pairing trusted peers — see [`node/deploy/README.md`](../node/deploy/README.md).

---

## 5) Federation join (sync into the mesh)

```bash
bash node/scripts/node_federation_join.sh --install-dir /opt/frogtalk -y \
  --public-url https://chat.yourdomain.com
```

This script:

1. Ensures `node/data` is a **symlink** (not an empty real folder)
2. Enables federation keys in `.env`
3. Pulls the [official directory](https://frogtalk.xyz/api/network/servers)
4. **TOFU-pins** peer Ed25519 keys from each peer’s `GET /api/network/status`
5. Links Frog Channel peer nav pills (unless `--skip-board`)

If the directory is unreachable, a built-in fallback seeds two **verified production** peers:

| Display name | Role |
|--------------|------|
| **FrogTalk Main** | `https://frogtalk.xyz` |
| **FrogTalk Tor Mirror** | `.onion` mirror (see directory / network UI) |

Re-run safely after changing `PUBLIC_URL` or onion settings:

```bash
bash node/scripts/install.sh federation -y
sudo systemctl restart frogtalk
```

### Verify federation

```bash
bash node/scripts/install.sh status
curl -sS "https://chat.yourdomain.com/api/network/status" | python3 -m json.tool
sqlite3 /opt/frogtalk/data/frogtalk.db \
  "SELECT display_name, enabled, length(COALESCE(server_pubkey,'')) FROM federation_servers;"
```

Expect multiple peers with **non-zero** pubkey length after pinning.

---

## 6) systemd service

```bash
sudo cp /opt/frogtalk/node/deploy/frogtalk.service /etc/systemd/system/frogtalk.service
# Edit User= if not using `deploy`
sudo systemctl daemon-reload
sudo systemctl enable --now frogtalk
sudo systemctl status frogtalk --no-pager
journalctl -u frogtalk -f
```

---

## 7) nginx reverse proxy + HTTPS

Keep uvicorn on **localhost** only. Example site (`/etc/nginx/sites-available/frogtalk`):

```nginx
server {
    listen 80;
    server_name chat.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/frogtalk /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d chat.yourdomain.com
```

Align ports: default app `PORT=8080` in `.env` must match `proxy_pass`. The template in `node/deploy/nginx.conf` may reference port **8000** — change upstream or `.env` so they match. The imageboard’s internal API default also assumes **8000** when unset; keep board and app aligned.

Reference: [`node/deploy/nginx.conf`](../node/deploy/nginx.conf), [`node/deploy/README.md`](../node/deploy/README.md).

---

## 8) Optional: Frog Channel (PHP)

If you serve `/board/` via php-fpm:

```bash
sudo apt install -y php-fpm
sudo chown -R www-data:www-data /opt/frogtalk/node/board/board_data \
  /opt/frogtalk/node/board/board_uploads \
  /opt/frogtalk/node/board/board_previews
```

Configure nginx to pass `*.php` under `/board/` to php-fpm (see board README).

---

## 9) Health checks

```bash
curl -sS "https://chat.yourdomain.com/api/ping"
curl -sS "https://chat.yourdomain.com/api/network/status"
curl -sS "https://chat.yourdomain.com/api/network/build/local"
```

Open `https://chat.yourdomain.com/app` — register a test user, join a room, confirm WebSocket connectivity.

In the app: **Settings → Network** — probe peers, compare build hash with [frogtalk.xyz](https://frogtalk.xyz) when federating.

---

## 10) Backup and upgrades

### Backup

```bash
sudo systemctl stop frogtalk
tar -czf frogtalk-backup-$(date +%F).tar.gz \
  /opt/frogtalk/.env \
  /opt/frogtalk/data/frogtalk.db \
  /opt/frogtalk/data/uploads \
  /opt/frogtalk/secrets
sudo systemctl start frogtalk
```

### Upgrade

```bash
bash node/scripts/install.sh update          # preview
bash node/scripts/install.sh update-apply -y # pull, pip, restart
bash node/scripts/install.sh federation -y     # refresh peers after major releases
```

Hot SCP deploy (`node/scripts/deploy_nodes.sh`) does **not** run DB migrations — prefer `update-apply` when `database.py` changes.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|----------------|-----|
| Empty DB / `no such table` | `node/data` is a real directory | Wizard symlink repair or `node_federation_join.sh` |
| API works on `:8080` but not via domain | nginx upstream port mismatch | Match `PORT` in `.env` and `proxy_pass` |
| Federation peers, no delivery | Missing pubkey pin | Re-run `federation -y`; check `FROGTALK_FEDERATION_REQUIRE_SIGS` |
| Directory sync fails | Outbound firewall / DNS | Check `curl` to `frogtalk.xyz`; fallback peers still seed mesh |
| CORS errors in browser | `ALLOWED_ORIGINS` | Add your `https://` origin |
| Board peer pills empty | `board_data` not writable | `chown www-data` on board dirs |
| WebRTC calls fail cross-node | No TURN | Set `FROGTALK_FEDERATION_CALLS_ENABLED=1` + coturn — [`FEDERATED_CALLS.md`](FEDERATED_CALLS.md) |

Logs: `journalctl -u frogtalk -n 100 --no-pager`, nginx `error.log`.

---

## Security checklist

- [ ] SSH key auth; disable root password login when stable
- [ ] UFW: only 22, 80, 443 (or your SSH port)
- [ ] Strong `ADMIN_PASSWORD`; rotate after first login
- [ ] `FROGTALK_FEDERATION_REQUIRE_SIGS=1`
- [ ] `FROGTALK_AUTO_UPDATE_ENABLED=0` unless you trust release signers
- [ ] Set `FROGTALK_RELEASE_SIGNERS` before enabling auto-apply
- [ ] `.env` mode `600`, owned by service user
- [ ] Do not expose uvicorn directly on the public internet

Report issues: [frogtalk.xyz/security](https://frogtalk.xyz/security)

---

## See also

- [Repository README](../README.md)
- [Node README](../node/README.md)
- [Deploy templates](../node/deploy/README.md)
- [API docs](https://frogtalk.xyz/docs/api)
- [Security model](SECURITY_MODEL.md)
- [Federated calls](FEDERATED_CALLS.md)
