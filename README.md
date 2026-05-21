<!--
       _____             _____     _ _
      |  ___| __ ___    |_   _|_ _| | | __
      | |_ | '__/ _ \  _  | |/ _` | | |/ /
      |  _|| | | (_) || |_| | (_| | |   <
      |_|  |_|  \___/  \___/ \__,_|_|_|\_\

      A federated, end-to-end encrypted chat platform
-->

<div align="center">

# 🐸 FrogTalk

**A censorship-free, federated, end-to-end encrypted chat platform.**
Self-host your own node and join the swamp — or run it completely standalone.
No company in the middle. Messages stay private. Built in the open.

[![Release](https://img.shields.io/github/v/release/deadinternetfox/frogtalk?display_name=release&sort=semver&color=4caf50)](https://github.com/deadinternetfox/frogtalk/releases)
[![License](https://img.shields.io/github/license/deadinternetfox/frogtalk?color=4caf50)](LICENSE)
[![Docker](https://img.shields.io/badge/ghcr.io-frogtalk-4caf50?logo=docker&logoColor=white)](https://github.com/deadinternetfox/frogtalk/pkgs/container/frogtalk)
[![Stars](https://img.shields.io/github/stars/deadinternetfox/frogtalk?label=stars&style=flat&color=4caf50)](https://github.com/deadinternetfox/frogtalk/stargazers)

[🌐 frogtalk.xyz](https://frogtalk.xyz) ·
[📥 Downloads](https://github.com/deadinternetfox/frogtalk/releases/latest) ·
[📚 Node Docs](https://frogtalk.xyz/docs/node) ·
[🔌 API Docs](https://frogtalk.xyz/docs/api)

</div>

---

## What is FrogTalk?

FrogTalk is a **self-hostable, federated chat and social node**: FastAPI + SQLite on the server,
vanilla JS in the browser, optional Frog Channel imageboard, Discord/Telegram bridges, WebRTC calls,
and **Ed25519-signed federation** between independent operators. Clients encrypt DMs (Signal Protocol)
and private channels (AES-GCM) before data reaches your disk.

- **Use someone else's node:** [frogtalk.xyz/app](https://frogtalk.xyz/app)
- **Run your own:** install under `/opt/frogtalk`, complete the **CLI setup wizard**, join the mesh — **[full VPS guide](docs/NODE_INSTALL.md)** · **[web guide](https://frogtalk.xyz/docs/node)**

---

## ✨ Why run your own node?

> **Your chat, your server, your keys.** No company in the middle, no plaintext on disk, no telemetry tax.

- **Censorship resistance** — more independent nodes means no single kill switch
- **Policy control** — moderation, federation peers, and bridges on your terms
- **Privacy** — you operate the infrastructure users connect to (still E2E for DMs/private rooms)
- **Federation** — your users can talk to people on other nodes in the same mesh

- 🔐 **Real E2E** — Signal Protocol (X3DH + Double Ratchet) for DMs, per-room AES-256-GCM (AAD-bound, with key rotation on ban/kick) for private channels. The server stores ciphertext and nothing else.
- 🌐 **Federated** — your node talks to other nodes; users, profiles, posts, rooms and DMs replicate across the swamp.
- 🧅 **Tor-native** — flip a flag and your node lives behind a `.onion`; clearnet IP never leaks.
- 📱 **Everywhere** — Web, Android (APK), iOS (TestFlight), Windows portable, Linux AppImage / `.deb`, and Electron desktop.
- 🎵 **More than chat** — DMs, group calls (WebRTC), reels, friend wall, music rooms (YT/Spotify/SoundCloud), Frog Channel imageboard, GIF picker, custom emojis.
- ⚒️ **Full API** — REST + WebSocket for bots, bridges and custom clients. Discord and Telegram bridges ship in-tree.

---

## Features

| | |
|---|---|
| 🔐 **E2E Encryption** | Signal Protocol for DMs (X3DH + Double Ratchet) and per-room AES-256-GCM (AAD-bound v2 wire format, automatic key rotation on ban/kick) for private channels, client-side only — the server never sees plaintext |
| 🌐 **Federated** | Your node joins the global FrogTalk directory and talks to other nodes |
| 🔁 **Cross-node Sync** | Replicates users/profile status, social follows/posts/stories, rooms, and DMs across nodes |
| ⚡ **Real-time** | WebSocket messaging with auto-reconnect, typing indicators, reactions |
| 🔒 **Private Rooms** | Passphrase-protected rooms — only members with the passphrase can decrypt |
| 💬 **Direct Messages** | Fully encrypted DMs between any two users |
| 🖼️ **Frog Channel Imageboard** | Anonymous 4chan-style thread board with replies, likes, image/video/audio posts, greentext, live board chat, and moderator approval tools |
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
| 🤖 **Android** | [Latest APK](https://frogtalk.xyz/download/android) | v1.6.27 (232) — sideload; FCM incoming calls |
| 📦 **Android (Play)** | [AAB in build mirror](github-build-mirror/frogtalk-v232.aab) | Google Play upload bundle |
| 🐧 **Linux AppImage** | [Latest AppImage](https://frogtalk.xyz/download/linux) | `chmod +x` then run |
| 📦 **Linux .deb** | [Latest .deb](https://frogtalk.xyz/download/deb) | `sudo dpkg -i <downloaded_file>.deb` |
| 🪟 **Windows (Portable .exe)** | [Latest portable .exe](https://frogtalk.xyz/download/windows) | Portable single-file — just run |
| 🪟 **Windows (.zip)** | [Latest .zip](https://frogtalk.xyz/download/windows-zip) | Unzip, then run `FrogTalk.exe` |
| 🍎 **macOS** | [Open in browser](https://frogtalk.xyz) | Native macOS build not published yet |

---

## Linux quick start (chat client)

Pick one way to run FrogTalk on Linux — all clients talk to a node (default
[`frogtalk.xyz`](https://frogtalk.xyz); change server in **Settings → Network**).

### Download (fastest)

```bash
# AppImage — no install, any distro
curl -fsSL -o FrogTalk.AppImage "$(curl -fsSL https://api.github.com/repos/deadinternetfox/frogtalk/releases/latest \
  | grep -o 'https://[^"]*AppImage' | head -1)"
chmod +x FrogTalk.AppImage
./FrogTalk.AppImage

# .deb — Debian / Ubuntu / Mint
curl -fsSL -o frogtalk.deb "$(curl -fsSL https://api.github.com/repos/deadinternetfox/frogtalk/releases/latest \
  | grep -o 'https://[^"]*_amd64.deb' | head -1)"
sudo dpkg -i frogtalk.deb
frogtalk
```

Or use the buttons on **[GitHub Releases](https://github.com/deadinternetfox/frogtalk/releases/latest)** or [frogtalk.xyz/download](https://frogtalk.xyz).

### Build from source (desktop)

```bash
git clone https://github.com/deadinternetfox/frogtalk.git
cd frogtalk
bash client/desktop/scripts/build-linux-release.sh
# Artifacts: client/desktop/builds/*.AppImage and *.deb
```

Details: [`client/README.md`](client/README.md).

### Browser only

Open **[frogtalk.xyz/app](https://frogtalk.xyz/app)** — no install; works on Linux mobile and desktop browsers.

---

## Self-Host (run your own node)

**Docs:** [docs/NODE_INSTALL.md](docs/NODE_INSTALL.md) (VPS, DNS, firewall, nginx, HTTPS, backups) ·
[https://frogtalk.xyz/docs/node](https://frogtalk.xyz/docs/node) (same flow on the live site)

### Quick start (fresh Linux VPS)

```bash
cd /opt
git clone https://github.com/deadinternetfox/frogtalk.git
cd frogtalk

# CLI install wizard (venv, .env, symlinks) — not a browser UI
export PUBLIC_URL="https://chat.yourdomain.com"
bash node/scripts/install.sh setup -y --public-url "$PUBLIC_URL"
bash node/scripts/install.sh federation -y --public-url "$PUBLIC_URL"
sudo bash node/scripts/install.sh systemd -y
```

Or use the **interactive menu:** `bash node/scripts/install.sh` → setup · federation · systemd · status. See [docs/NODE_INSTALL.md](docs/NODE_INSTALL.md) for a full copy-paste VPS guide.

Put **nginx + certbot** in front (ports 80/443), keep uvicorn on `127.0.0.1:8080`, set
`PUBLIC_URL=https://chat.yourdomain.com` and matching `ALLOWED_ORIGINS`. See the VPS guide for UFW,
SSH keys, and troubleshooting.

**Admin account:** user `admin` on first boot — password from `ADMIN_PASSWORD` in `.env`, or a
one-time generated value in `journalctl` if left empty (rotate after login).

> Runtime state lives at `/opt/frogtalk/` (`.env`, `data/`, `secrets/`, `venv/`). Code is
> `/opt/frogtalk/node/`. `node/data` and `node/.env` must be **symlinks**, not real folders.

### Install wizard (CLI)

| Entry | What it does |
|-------|----------------|
| `bash node/scripts/install.sh` | Interactive menu |
| `bash node/scripts/install.sh setup` | `node_setup_wizard.sh` — venv, `.env`, symlinks |
| `bash node/scripts/install.sh federation` | Directory sync, hub announce, pubkey pin, board peer pills |
| `bash node/scripts/install.sh systemd` | Install `frogtalk.service` |
| `bash node/scripts/install.sh status` | `/api/ping` + federation peer list |

Wizard source: `node/scripts/node_setup_wizard.sh`. Users register at **`/app`** after the node is up.

### Federation setup

```bash
bash node/scripts/node_federation_join.sh --install-dir /opt/frogtalk -y \
  --public-url https://chat.yourdomain.com
```

- Directory feed (default): `https://frogtalk.xyz/api/network/servers`
- **Hub announce:** with the same `FROGTALK_FEDERATION_TOKEN` on Main and your node, federation join POSTs to `…/servers/register` so you appear on [frogtalk.xyz](https://frogtalk.xyz/api/network/servers) (verify with curl to Main, not only your local `/api/network/servers`)
- Peer **Ed25519 keys** are pinned from each peer’s `/api/network/status`
- Re-run after changing `PUBLIC_URL`, onion URL, or major upgrades

**Official production nodes** (directory + CLI fallback when HTTP is down):

| Node | Clearnet |
|------|----------|
| FrogTalk Main | `https://frogtalk.xyz` |
| FrogTalk Tor Mirror | Onion address in app **Settings → Network** |

### Manual install (no wizard)

```bash
git clone https://github.com/deadinternetfox/frogtalk.git /opt/frogtalk
cd /opt/frogtalk
python3 -m venv venv && source venv/bin/activate
pip install -r node/requirements.txt
cp node/deploy/env.example .env
mkdir -p data secrets
ln -sfn /opt/frogtalk/data node/data && ln -sfn /opt/frogtalk/.env node/.env
cd node && python main.py
```

### Updates

```bash
bash node/scripts/install.sh update
bash node/scripts/install.sh update-apply -y
bash node/scripts/install.sh federation -y   # refresh peers after releases
```

### Security notes (operators)

- Use **SSH keys**; do not commit `.env`, tokens, or passwords to git
- `FROGTALK_FEDERATION_REQUIRE_SIGS=1` (default in wizard) — reject unsigned federation events
- `FROGTALK_AUTO_UPDATE_ENABLED=0` until `FROGTALK_RELEASE_SIGNERS` is set
- Expose **nginx** on 443, not raw uvicorn on the public internet
- Report issues: [frogtalk.xyz/security](https://frogtalk.xyz/security)

### Troubleshooting

| Problem | Fix |
|---------|-----|
| Empty DB / missing tables | `node/data` must symlink to `/opt/frogtalk/data` — run setup or federation join |
| Domain 502, local `:8080` OK | Match `PORT` in `.env` with nginx `proxy_pass` |
| Federation peers, no delivery | Re-run `federation -y`; check pinned pubkey in DB (`install.sh status`) |
| CORS in browser | Add your HTTPS origin to `ALLOWED_ORIGINS` |

More: [docs/NODE_INSTALL.md](docs/NODE_INSTALL.md#troubleshooting)

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

The panel now includes a novice-friendly onboarding checklist with explicit warnings for missing HTTPS, public-IP exposure, and recommended federation safety toggles (Tor auto-block and non-SSL peer auto-block).

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
sudo cp node/deploy/frogtalk.service /etc/systemd/system/frogtalk.service
# Defaults: WorkingDirectory=/opt/frogtalk/node, EnvironmentFile=/opt/frogtalk/.env
# edit User if you're not deploying as `deploy`
sudo systemctl daemon-reload
sudo systemctl enable --now frogtalk
sudo systemctl status frogtalk
```

Logs: `journalctl -u frogtalk -f`

### Docker

```bash
# Build from the repo root, pointed at node/Dockerfile.
docker build -f node/Dockerfile -t frogtalk .
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

Full node setup: **[docs/NODE_INSTALL.md](docs/NODE_INSTALL.md)** · **[frogtalk.xyz/docs/node](https://frogtalk.xyz/docs/node)**

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

FrogTalk's crypto is layered by context so each surface gets the strongest
practical guarantee:

- **Direct messages — Signal Protocol.** X3DH key agreement against the
  recipient's published prekey bundle establishes a Double Ratchet session.
  Every DM advances the ratchet, so forward secrecy is per-message and a
  device compromise tomorrow can't decrypt today's traffic.
- **Room messages — per-channel AES-256-GCM with AAD binding + key rotation.**
  Private channels are sealed with a 256-bit AES-GCM key derived (HKDF-SHA-256)
  from a shared channel secret distributed to new members through their
  already-established Signal DM session. Ciphertext is bound to a specific
  room id and key version via AES-GCM Additional Authenticated Data
  (`room:<id>:v<N>`, v2 wire format `[0x02][iv:12][ct+tag]`), so a captured
  ciphertext cannot be replayed against another room or an older key. When a
  member is banned or kicked, or a moderator presses **Rotate room key now**,
  a fresh key is generated client-side and fanned out to every remaining
  member via their Signal DM session; the rotation is announced in-channel
  as a system message. Public channels intentionally have no key — they are
  designed to be world-readable and are stored encrypted-at-rest only.
- **Voice/video calls — DTLS fingerprint signing.** SDP offers and answers
  carry an XEdDSA signature over the call's DTLS fingerprint so a hostile
  signalling server can't silently MITM the media path. A Safety-Numbers
  panel surfaces the verified peer identity.
- **Wall posts — per-post AEAD wrapped to followers.** Each post is sealed
  with a fresh AES-256-GCM key; that key is then wrapped to each follower
  via their Signal DM session, so only the intended audience can read it.
- **Bridged channels.** Channels with an outbound Discord/Telegram bridge
  intentionally fall back to plaintext so the bridge can forward the
  message text to the third-party platform; this is clearly indicated in
  the channel header. **Bridges are not available for private (E2EE) rooms**
  — forwarding to Discord/Telegram would leak plaintext to a third-party
  service and defeat end-to-end encryption, so all four bridge-create
  endpoints reject private rooms with HTTP 403. DMs are never bridged.
- **Private keys** are generated client-side and never leave the device.
  They live in IndexedDB (web/desktop) or the OS keystore (Android/iOS).

In-app the **🔒 Encryption info** modal exposes the current safety number
for a DM, or the channel's encryption mode for a room.

---

## Repository Structure

```
frogtalk/
├── client/                       # everything end-users install
│   ├── desktop/                  # Electron source + builds
│   │   ├── app/                  # Electron source (main.js / preload.js / renderer)
│   │   └── builds/               # Electron output artifacts (gitignored)
│   └── mobile/
│       ├── android/              # Android Studio project (Capacitor + native shell)
│       └── ios/                  # iOS Xcode project
├── node/                         # the federated server (everything ops cares about)
│   ├── main.py                   # FastAPI app entrypoint
│   ├── database.py               # SQLite schema + migrations
│   ├── routers/                  # FastAPI route modules
│   ├── static/                   # web client + marketing pages served by the node
│   ├── board/                    # Frog Channel PHP imageboard → public /board/
│   ├── deploy/                   # systemd / nginx / env.example
│   ├── scripts/
│   │   ├── install.sh            # unified installer menu (recommended)
│   │   ├── node_setup_wizard.sh  # guided self-host setup
│   │   ├── node_update_check.sh  # safe update check / apply
│   │   ├── deploy.sh             # rsync node/ to one host
│   │   ├── deploy_nodes.sh       # maintainer SCP hotfix (needs deploy_fleet.local.sh)
│   │   ├── deploy_board.sh       # maintainer board PHP hotfix (same fleet config)
│   │   ├── build_server_release.sh
│   │   └── migrations/           # one-shot historical migrations
│   ├── tests/                    # pytest suite (sanitizers, proxy, security)
│   ├── requirements.txt
│   ├── Dockerfile                # docker build -f node/Dockerfile -t frogtalk .
│   └── builds/                   # release tarballs (gitignored)
├── bot-examples/                 # standalone reference bots
├── github-build-mirror/          # release binaries published to GitHub
├── docs/
│   ├── NODE_INSTALL.md           # VPS install + federation (start here for ops)
│   ├── SECURITY_MODEL.md         # encryption + threat model
│   └── FEDERATED_CALLS.md        # cross-node WebRTC / TURN
├── README.md / SECURITY.md / CONTRIBUTING.md / CONTRIBUTORS.md / LICENSE
└── .gitignore / .dockerignore / .fallowrc.json
```

On a running node, operator state (`.env`, `data/`, `secrets/`, `venv/`) lives at
`/opt/frogtalk/` and the runtime source at `/opt/frogtalk/node/`. The setup wizard
wires symlinks (`node/data`, `node/.env`, `node/secrets`) so the FastAPI process
can stay with cwd=`node/` without copying operator secrets into the source tree.

Detailed structure + migration rules: [`node/README.md`](node/README.md) · security model: [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md)

---

## 🐸 Vibe-coded, but open source

FrogTalk is a **censorship-free platform where messages can stay private** — and it's
being built in the open with a process we're openly experimenting with: an AI-in-the-loop
workflow for small, honest software teams.

### Our development process

```
   ┌─────────┐    ┌─────────────┐    ┌──────────────────────┐    ┌────────┐
   │  Idea   │ ─▶ │  AI slop    │ ─▶ │  Deslop (human pass) │ ─▶ │  Ship  │
   └─────────┘    └─────────────┘    └──────────────────────┘    └────────┘
```

- **Idea.** Issue, sketch, "what if we…" — barrier is low on purpose.
- **AI slop.** The first draft of most code is AI-generated. PRs are labelled `vibe-coded` so reviewers know what they're walking into.
- **Deslop.** A human reviewer fixes the security holes, kills dead code, tightens
  the names, rewrites lying comments, and actually exercises the change. Code is
  not considered done until it has been deslopped.
- **Ship.** Trunk-based: merge to `main`, deploy, watch the logs.

The encryption primitives are well-studied (X3DH + Double Ratchet for DMs,
per-room AES-256-GCM for private channels, DTLS-fingerprint signing for calls). The surrounding plumbing — DOM rendering, session handling,
media URLs, federation glue — is the kind of code that benefits from a second set
of eyes. **We'd rather hear from you than pretend it's flawless.**

### We need your help

This project is run by a tiny team. Every kind of contribution matters:

- 🐛 **Found a bug or security issue?** Report it at **<https://frogtalk.xyz/security>**
  — anonymous submissions accepted. For sensitive disclosures: `security@frogtalk.xyz`.
- 🔎 **Spotted AI slop in the codebase?** Open a [slop sighting](https://github.com/deadinternetfox/frogtalk/issues/new?template=slop_sighting.md)
  — file path, what looks wrong, why.
- 🧹 **Want to deslop?** Pick an issue tagged `deslop-needed` and send a PR. After a
  few solid reviews you can get write access. See [CONTRIBUTING.md](CONTRIBUTING.md).
- 🛠️ **New feature idea?** Half-formed is fine — file it as a [feature idea](https://github.com/deadinternetfox/frogtalk/issues/new?template=feature_idea.md).
- 📣 **Run a node.** More nodes = more censorship-resistance. Self-host guide above.
- 💬 **Tell people the project exists.** Community projects need a community.

Researchers who responsibly disclose are credited in the security advisory and on the
[Hall of Fame](https://frogtalk.xyz/security#hall-of-fame).

### Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full deslop process: the review
checklist (Correctness / Security / Operational / Honesty), label conventions
(`vibe-coded`, `deslopped`, `deslop-needed`, `slop-sighting`), and how to become a
deslopper. Quick start:

1. Fork the repo and branch from `main`.
2. If your PR is AI-drafted, label it `vibe-coded` — we'll deslop it together.
3. Run `node --check node/static/js/<file>.js` for any JS you touched — silent parse
   errors break every onclick on the page.
4. Run `python -m py_compile node/<file>.py` for any Python you touched.
5. Open a PR with the template filled in. For security fixes, include a PoC.
6. Add yourself to `CONTRIBUTORS.md` in the same PR.

See [`/security`](https://frogtalk.xyz/security) for scope, threat model, and
what counts as a vulnerability.

---

## License

MIT
