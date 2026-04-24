# FrogTalk

> **Live network: [frogtalk.xyz](https://frogtalk.xyz)**

A federated, end-to-end encrypted chat platform. Self-host your own node and connect to the FrogTalk network — or run it standalone with no external dependencies.

---

## Features

- **End-to-end encryption** — AES-256-GCM, client-side only. The server never sees plaintext.
- **Federated network** — your server joins the global FrogTalk directory and can communicate with other nodes
- **Real-time messaging** — WebSocket-based with auto-reconnect, typing indicators, reactions
- **Public & private rooms** — passphrase-protected rooms with E2E encryption
- **Direct messages** — fully encrypted DMs between users
- **File sharing** — images, video, and file attachments (up to 8 MB)
- **Discord & Telegram bridges** — bridge your rooms to Discord channels or Telegram chats
- **Push notifications** — web push for mobile and desktop
- **Mobile & desktop clients** — Android APK, Linux AppImage/deb, and Electron desktop app
- **Admin dashboard** — moderation tools, live stats, user management
- **Bot API** — REST + WebSocket API for building bots and integrations

---

## Get the App

| Platform | Download |
|----------|----------|
| Web | [frogtalk.xyz](https://frogtalk.xyz) |
| Android | [frogtalk.xyz](https://frogtalk.xyz) |
| Linux (AppImage) | [frogtalk.xyz](https://frogtalk.xyz) |
| Desktop (Electron) | [frogtalk.xyz](https://frogtalk.xyz) |

---

## Self-Host

### Quick start (local dev)

```bash
git clone https://github.com/your-org/frogtalk.git
cd frogtalk
cp deploy/env.example .env    # fill in your settings
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python main.py                # → http://localhost:8080
```

Default admin login: `admin` / the value of `ADMIN_PASSWORD` in your `.env`.

### Production deployment

See [deploy/README.md](deploy/README.md) for full instructions including systemd service setup, Docker, and Nginx reverse proxy config.

Full node documentation: **[frogtalk.xyz/docs/node](https://frogtalk.xyz/docs/node)**

### Docker

```bash
docker build -t frogtalk .
docker run -d -p 8080:8080 \
  -e ADMIN_PASSWORD=your_password \
  -v $(pwd)/data:/app/data \
  --name frogtalk frogtalk
```

---

## API & Bots

FrogTalk exposes a REST + WebSocket API for bots and integrations.

API documentation: **[frogtalk.xyz/docs/api](https://frogtalk.xyz/docs/api)**

---

## Encryption

- All messages are encrypted with **AES-256-GCM** before leaving the browser
- Public rooms share a key derived from the room name
- Private rooms use a key derived from a passphrase you set — only members with the passphrase can decrypt
- DMs use a key derived from both participants' identifiers
- The server stores only ciphertext

---

## License

MIT
