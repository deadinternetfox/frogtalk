# FrogTalk

<p align="center">
  <a href="https://frogtalk.xyz"><strong>🌐 frogtalk.xyz</strong></a> &nbsp;·&nbsp;
  <a href="https://frogtalk.xyz/docs/node">Node Docs</a> &nbsp;·&nbsp;
  <a href="https://frogtalk.xyz/docs/api">API Docs</a>
</p>

<p align="center">
  A <strong>federated, end-to-end encrypted</strong> chat platform.<br>
  Self-host your own node and join the network — or run it completely standalone.
</p>

---

## Features

| | |
|---|---|
| 🔐 **E2E Encryption** | AES-256-GCM, client-side only — the server never sees plaintext |
| 🌐 **Federated** | Your node joins the global FrogTalk directory and talks to other nodes |
| 🔁 **Cross-node Sync** | Replicates users/profile status, social follows/posts/stories, rooms, and DMs across nodes |
| ⚡ **Real-time** | WebSocket messaging with auto-reconnect, typing indicators, reactions |
| 🔒 **Private Rooms** | Passphrase-protected rooms — only members with the passphrase can decrypt |
| 💬 **Direct Messages** | Fully encrypted DMs between any two users |
| 📎 **File Sharing** | Images, video, and file attachments up to 8 MB |
| 🤖 **Discord & Telegram Bridges** | Mirror rooms to/from Discord channels or Telegram chats |
| 🔔 **Push Notifications** | Web push for mobile and desktop |
| 🛡️ **Admin Dashboard** | Moderation tools, live server stats, user management |
| 🧩 **Bot API** | Full REST + WebSocket API for building bots and integrations |
| 🧅 **Tor / Onion Routing** | Nodes can advertise a `.onion` address; federation traffic and client connections route through Tor when onion mode is enabled. Clearnet address is never leaked for onion-only nodes |

---

## Download

| Platform | Latest | Notes |
|----------|--------|-------|
| 🌐 **Web** | [Open in browser](https://frogtalk.xyz) | No install needed |
| 🤖 **Android** | [frogtalk-v186.apk](https://frogtalk.xyz/static/frogtalk-v186.apk) | Sideload — enable "Unknown Sources" |
| 🐧 **Linux AppImage** | [FrogTalk-1.3.9.AppImage](https://frogtalk.xyz/static/FrogTalk-1.3.9.AppImage) | `chmod +x` then run |
| 📦 **Linux .deb** | [frogtalk_1.3.9_amd64.deb](https://frogtalk.xyz/static/frogtalk_1.3.9_amd64.deb) | `sudo dpkg -i frogtalk_1.3.9_amd64.deb` |
| 🖥️ **Desktop (Electron)** | [frogtalk.xyz](https://frogtalk.xyz) | Windows / macOS build via the site |

---

## Self-Host

### Quick start

```bash
git clone https://github.com/deadinternetfox/frogtalk.git
cd frogtalk
cp deploy/env.example .env       # set ADMIN_PASSWORD, PORT, ALLOWED_ORIGINS
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python main.py                   # → http://localhost:8080
```

Default admin login: `admin` / the value of `ADMIN_PASSWORD` in your `.env`.

### Server Web Admin (node management)

Enable the secure node management dashboard:

```bash
export FROGTALK_SERVER_WEBUI_ENABLED=1
export FROGTALK_SERVER_WEBUI_USER=serveradmin
export FROGTALK_SERVER_WEBUI_PASSWORD='set-a-strong-password'
```

Then open:

- URL: `https://your-host/server`
- Login: `FROGTALK_SERVER_WEBUI_USER` / `FROGTALK_SERVER_WEBUI_PASSWORD`

Capabilities include live hardware telemetry (CPU/memory/disk/uptime), federation node inventory, node probe, and block/unblock controls.

### Tor / Onion Hidden Service

To run your node as a Tor hidden service (`.onion` only, no clearnet exposure):

```bash
export FROGTALK_TOR_ENABLED=1
export FROGTALK_ONION_URL=http://youronionaddress.onion
# Leave FROGTALK_BASE_URL unset or empty to be onion-only
```

Clients using *Prefer onion endpoints* in Network Settings will automatically route all federation traffic through Tor. The clearnet IP is never shared with the directory or other nodes when `FROGTALK_TOR_ENABLED=1` and no `FROGTALK_BASE_URL` is set.

Onion-capable nodes display a `🧅 ONION` badge in the server list, and the node card shows the `.onion` address with a one-click copy button instead of a clearnet URL.

### Production (systemd)

```bash
sudo cp deploy/frogtalk.service /etc/systemd/system/frogtalk.service
# edit WorkingDirectory and User in the service file as needed
sudo systemctl daemon-reload
sudo systemctl enable --now frogtalk
sudo systemctl status frogtalk
```

Logs: `journalctl -u frogtalk -f`

### Docker

```bash
docker build -t frogtalk .
docker run -d -p 8080:8080 \
  -e ADMIN_PASSWORD=your_password \
  -v $(pwd)/data:/app/data \
  --name frogtalk frogtalk
```

### Nginx + HTTPS

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

Full node setup guide: **[frogtalk.xyz/docs/node](https://frogtalk.xyz/docs/node)**

---

## API & Bots

FrogTalk has a full REST + WebSocket API. Build bots, integrations, and custom clients.

```
GET  /api/rooms          # list public rooms
POST /api/messages       # send a message (with bridge_token)
WS   /ws/{room}          # real-time message stream
```

Full reference: **[frogtalk.xyz/docs/api](https://frogtalk.xyz/docs/api)**

---

## Encryption Model

- Messages are encrypted with **AES-256-GCM** before leaving the browser
- **Public rooms** — key derived from the room name; anyone who knows the name can read
- **Private rooms** — key derived from a passphrase; only members with it can decrypt
- **DMs** — key derived from both participants' identifiers
- The server stores only ciphertext and never holds decryption keys

---

## Repository Structure

```
frogtalk/
├── main.py              # FastAPI app entry point
├── database.py          # SQLite persistence layer
├── routers/             # API route modules
├── static/              # Frontend SPA (HTML + vanilla JS)
│   └── js/              # Client-side modules
├── bridge_discord.py    # Discord ↔ FrogTalk bridge bot
├── bridge_telegram.py   # Telegram ↔ FrogTalk bridge bot
├── deploy/              # Server deployment files
│   ├── frogtalk.service # systemd unit
│   └── env.example      # environment variable template
├── android/             # Android app source
├── desktop/             # Electron desktop app source
├── Dockerfile
└── requirements.txt
```

---

## License

MIT
