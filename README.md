<!--
       _____             _____     _ _
      |  ___| __ ___    |_   _|_ _| | | __
      | |_ | '__/ _ \  _  | |/ _` | | |/ /
      |  _|| | | (_) || |_| | (_| | |   <
      |_|  |_|  \___/  \___/ \__,_|_|_|\_\

      A federated, end-to-end encrypted chat platform
-->

<div align="center">

```
              .--.        .--.
             ( oo|        |oo )
              \__/         \__/
            .-"""-.       .-"""-.
           /       \     /       \
          | F R O G | _ |  T A L K |
           \       /     \       /
            '-...-'       '-...-'
                  ribbit ✦ ribbit
```

# 🐸 FrogTalk

**A federated, end-to-end encrypted chat platform.**
Self-host your own node and join the swamp — or run it completely standalone.

[![Release](https://img.shields.io/github/v/release/deadinternetfox/frogtalk?include_prereleases&label=release&color=4caf50)](https://github.com/deadinternetfox/frogtalk/releases)
[![License](https://img.shields.io/github/license/deadinternetfox/frogtalk?color=4caf50)](LICENSE)
[![Docker](https://img.shields.io/badge/ghcr.io-frogtalk-4caf50?logo=docker&logoColor=white)](https://github.com/deadinternetfox/frogtalk/pkgs/container/frogtalk)
[![Stars](https://img.shields.io/github/stars/deadinternetfox/frogtalk?style=flat&color=4caf50)](https://github.com/deadinternetfox/frogtalk/stargazers)

[🌐 frogtalk.net](https://frogtalk.net) ·
[📥 Downloads](https://github.com/deadinternetfox/frogtalk/releases/latest) ·
[📚 Node Docs](https://frogtalk.xyz/docs/node) ·
[🔌 API Docs](https://frogtalk.xyz/docs/api)

</div>

---

## ✨ Why FrogTalk?

> **Your chat, your server, your keys.** No company in the middle, no plaintext on disk, no telemetry tax.

- 🔐 **Real E2E** — AES-256-GCM in the browser. The server stores ciphertext and nothing else.
- 🌐 **Federated** — your node talks to other nodes; users, profiles, posts, rooms and DMs replicate across the swamp.
- 🧅 **Tor-native** — flip a flag and your node lives behind a `.onion`; clearnet IP never leaks.
- 📱 **Everywhere** — Web, Android (APK), iOS (TestFlight), Windows portable, Linux AppImage / `.deb`, and Electron desktop.
- 🎵 **More than chat** — DMs, group calls (WebRTC), reels, friend wall, music rooms (YT/Spotify/SoundCloud), imageboard, GIF picker, custom emojis.
- 🛠 **Full API** — REST + WebSocket for bots, bridges and custom clients. Discord and Telegram bridges ship in-tree.

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
| 🎞 **Reels** | Vertical short-video feed with hot/new/top sorting, reactions, reposts, and comments |
| 📎 **File Sharing** | Images, video, and file attachments up to 8 MB |
| 🤖 **Discord & Telegram Bridges** | Mirror rooms to/from Discord channels or Telegram chats |
| 🔔 **Push Notifications** | Web push for mobile and desktop |
| 🛡️ **Admin Dashboard** | Moderation tools, live server stats, user management |
| 🧩 **Bot API** | Full REST + WebSocket API for building bots and integrations |
| 🧅 **Tor / Onion Routing** | Nodes can advertise a `.onion` address; federation traffic and client connections route through Tor when onion mode is enabled. Onion handoff links target `/app`, and clearnet address is never leaked for onion-only nodes |

---

## Download

| Platform | Latest | Notes |
|----------|--------|-------|
| 🌐 **Web** | [Open in browser](https://frogtalk.xyz) | No install needed |
| 🤖 **Android** | [Latest APK](https://frogtalk.xyz/download/android) | Sideload — enable "Unknown Sources" |
| 🐧 **Linux AppImage** | [Latest AppImage](https://frogtalk.xyz/download/linux) | `chmod +x` then run |
| 📦 **Linux .deb** | [Latest .deb](https://frogtalk.xyz/download/deb) | `sudo dpkg -i <downloaded_file>.deb` |
| 🪟 **Windows (Portable .exe)** | [Latest portable .exe](https://frogtalk.xyz/download/windows) | Portable single-file — just run |
| 🪟 **Windows (.zip)** | [Latest .zip](https://frogtalk.xyz/download/windows-zip) | Unzip, then run `FrogTalk.exe` |
| 🍎 **macOS** | [Open in browser](https://frogtalk.xyz) | Native macOS build not published yet |

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

Node Control also includes a per-node easter-egg editor: upload images/audio/video, format rich text, and set the hidden popup that appears after seven taps on the frog trigger for that node.

### Tor / Onion Hidden Service

To run your node as a Tor hidden service (`.onion` only, no clearnet exposure):

```bash
export FROGTALK_TOR_ENABLED=1
export FROGTALK_ONION_URL=http://youronionaddress.onion
# Leave FROGTALK_BASE_URL unset or empty to be onion-only
```

Use the onion app surface for user links and server switching:

```text
http://youronionaddress.onion/app
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
