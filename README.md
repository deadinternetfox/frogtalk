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

<p>
A censorship-free, federated, end-to-end encrypted chat platform.<br>
<strong>This checkout is the active <code>dev</code> branch</strong> — try the live stack at
<a href="https://frogtalk.xyz">frogtalk.xyz</a> before changes reach <a href="https://frogtalk.app">frogtalk.app</a>.<br>
<strong>Pre-alpha:</strong> expect bugs, breaking changes, and incomplete hardening. Not production-ready.
</p>

[![Branch](https://img.shields.io/badge/branch-dev-2563eb)](https://github.com/deadinternetfox/frogtalk/tree/dev)
[![Pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange)](https://frogtalk.app/security)
[![Release](https://img.shields.io/github/v/release/deadinternetfox/frogtalk?display_name=release&sort=semver&color=4caf50)](https://github.com/deadinternetfox/frogtalk/releases)
[![License](https://img.shields.io/github/license/deadinternetfox/frogtalk?color=4caf50)](LICENSE)
[![Docker](https://img.shields.io/badge/ghcr.io-frogtalk-4caf50?logo=docker&logoColor=white)](https://github.com/deadinternetfox/frogtalk/pkgs/container/frogtalk)
[![Stars](https://img.shields.io/github/stars/deadinternetfox/frogtalk?label=stars&style=flat&color=4caf50)](https://github.com/deadinternetfox/frogtalk/stargazers)

[🧪 frogtalk.xyz — live dev node](https://frogtalk.xyz) ·
[🌐 frogtalk.app — production hub](https://frogtalk.app) ·
[📥 Downloads](https://frogtalk.xyz/#downloads) ·
[📚 Node guide](https://frogtalk.xyz/docs/node) ·
[🔌 API reference](https://frogtalk.xyz/docs/api) ·
[🛡️ Security](https://frogtalk.xyz/security)

</div>

---

## 🔧 Active development branch (`dev`)

You are reading the **contributor default** in git. This branch tracks day-to-day work and deploys to the **development node** at [frogtalk.xyz](https://frogtalk.xyz).

| | **Development (`dev`)** | **Production (`master`)** |
|---|-------------------------|---------------------------|
| **Git branch** | `dev` (this tree) | `master` |
| **Public URL** | [frogtalk.xyz](https://frogtalk.xyz) | [frogtalk.app](https://frogtalk.app) |
| **Client default** | `client/official-node.json` → `https://frogtalk.xyz` | → `https://frogtalk.app` |
| **Board identity** | 🔧 Development & support · `@frogtalk-support` | Frog General · `@frog-general` |
| **Federation directory** | Still published from **frogtalk.app** | Hub (`FROGTALK_FEDERATION_DIRECTORY_HUB=1` on Main) |
| **Stability** | May break without notice | Slightly more stable; still pre-alpha |

**Clone this branch:**

```bash
git clone -b dev https://github.com/deadinternetfox/frogtalk.git
cd frogtalk
```

**Contributing:** open PRs into `dev`. After review and testing on `.xyz`, maintainers promote to `master` for `.app` deploys. See [CONTRIBUTING.md](CONTRIBUTING.md).

**Intentional diff vs `master`:** almost all files match; the usual exception is `client/official-node.json` (home node URL). This README is **dev-only** (not present on `master`).

---

## What is FrogTalk?

FrogTalk is a **self-hostable, federated chat and social node**: FastAPI + SQLite on the server,
vanilla JS in the browser, optional Frog Channel imageboard, Discord/Telegram bridges, WebRTC calls,
and **Ed25519-signed federation** between independent operators. Clients encrypt DMs (Signal Protocol)
and private channels (AES-GCM) before data reaches your disk.

- **Try the dev instance (this branch):** [frogtalk.xyz/app](https://frogtalk.xyz/app) — bleeding edge, may reset or break
- **Use the production hub:** [frogtalk.app/app](https://frogtalk.app/app) — **pre-alpha**, no uptime or data guarantees
- **Run your own:** install under `/opt/frogtalk`, complete the **CLI setup wizard**, join the mesh — **[full VPS guide](docs/NODE_INSTALL.md)** · **[web guide](https://frogtalk.app/docs/node)**

### Branches & public hosts

| Branch | Default client node | Live host | Role |
|--------|---------------------|-----------|------|
| **`master`** | `frogtalk.app` | [frogtalk.app](https://frogtalk.app) | Pre-alpha **production hub** — official directory, stable line for operators |
| **`dev`** | `frogtalk.xyz` | [frogtalk.xyz](https://frogtalk.xyz) | **Active development** — features land here first; may break without notice |
| **Tor** (any branch) | varies | `.onion` | Hidden service; `FROGTALK_HOME_PAGE=tor` — vanity search: [docs/TOR_VANITY_ONION.md](docs/TOR_VANITY_ONION.md) |

**Workflow:** fork and PR into **`dev`**. After testing on [frogtalk.xyz](https://frogtalk.xyz), maintainers merge **`dev` → `master`** for production deploys. The only intentional code diff between branches in git is usually `client/official-node.json` (see [client/README.md](client/README.md)); **`dev`** also carries a contributor-focused root README.

**Official directory:** `https://frogtalk.app/api/network/servers` (hub is always **frogtalk.app**, not `.xyz`).

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
| 🔁 **Cross-node Sync** | Home-signed account import when traveling: profile, themes, client prefs, joined channel settings (slowmode, forwarding lock, themes), DM thread prefs, friends/following, FrogSocial posts — see [SECURITY_MODEL.md](docs/SECURITY_MODEL.md) |
| ⚡ **Real-time** | WebSocket messaging with auto-reconnect, typing indicators, reactions |
| 🔒 **Private Rooms** | Passphrase-protected rooms — only members with the passphrase can decrypt |
| 💬 **Direct Messages** | Fully encrypted DMs between any two users |
| 🖼️ **Frog Channel Imageboard** | Anonymous 4chan-style thread board with replies, likes, image/video/audio posts, greentext, live board chat, and moderator approval tools |
| 🎞️ **Reels** | Vertical short-video feed with hot/new/top sorting, reactions, reposts, and comments |
| 📎 **File Sharing** | Images, video, and file attachments up to 8 MB |
| 🤖 **Discord & Telegram Bridges** | Mirror rooms to/from Discord channels or Telegram chats |
| 🔔 **Push Notifications** | Web push for mobile and desktop |
| 🛡️ **Admin Dashboard** | Moderation tools, live server stats, user management |
| 🔞 **18+ Content Warnings** | Optional moderator labels on public channels; session age gate before history (not message scanning) |
| 🧩 **Bot API** | Full REST + WebSocket API for building bots and integrations |
| 🧅 **Tor / Onion Routing** | Nodes can advertise a `.onion` address; federation traffic and client connections route through Tor when onion mode is enabled. Onion handoff links target `/app`, and clearnet address is never leaked for onion-only nodes |

---

## Download

> **Pre-alpha builds** — for testing only. Expect crashes, breaking API changes, and incomplete security review. Do not rely on these for sensitive communications until we leave pre-alpha.

| Platform | Latest | Notes |
|----------|--------|-------|
| 🌐 **Web** | [Open in browser](https://frogtalk.app) | No install needed |
| 🤖 **Android** | [Latest APK](https://frogtalk.app/download/android) | v1.6.27 (232) — sideload; FCM incoming calls |
| 📦 **Android (Play)** | [AAB in build mirror](github-build-mirror/frogtalk-v232.aab) | Google Play upload bundle |
| 🐧 **Linux AppImage** | [Latest AppImage](https://frogtalk.app/download/linux) | `chmod +x` then run |
| 📦 **Linux .deb** | [Latest .deb](https://frogtalk.app/download/deb) | `sudo dpkg -i <downloaded_file>.deb` |
| 🪟 **Windows (Portable .exe)** | [Latest portable .exe](https://frogtalk.app/download/windows) | Portable single-file — just run |
| 🪟 **Windows (.zip)** | [Latest .zip](https://frogtalk.app/download/windows-zip) | Unzip, then run `FrogTalk.exe` |
| 🍎 **macOS** | [Open in browser](https://frogtalk.app) | Native macOS build not published yet |

---

## Linux quick start (chat client)

Pick one way to run FrogTalk on Linux — all clients talk to a node (default
[`frogtalk.app`](https://frogtalk.app); change server in **Settings → Network**).

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

Or use the buttons on **[GitHub Releases](https://github.com/deadinternetfox/frogtalk/releases/latest)** or [frogtalk.app/download](https://frogtalk.app).

### Build from source (desktop)

```bash
git clone https://github.com/deadinternetfox/frogtalk.git
cd frogtalk
bash client/desktop/scripts/build-linux-release.sh
# Artifacts: client/desktop/builds/*.AppImage and *.deb
```

Details: [`client/README.md`](client/README.md).

### Browser only

Open **[frogtalk.app/app](https://frogtalk.app/app)** — no install; works on Linux mobile and desktop browsers.

---

## Self-Host (run your own node)

**Docs:** [docs/NODE_INSTALL.md](docs/NODE_INSTALL.md) (VPS, DNS, firewall, nginx, HTTPS, backups) ·
[https://frogtalk.app/docs/node](https://frogtalk.app/docs/node) (same flow on the live site)

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

- Directory feed (default): `https://frogtalk.app/api/network/servers`
- **Hub announce:** with the same `FROGTALK_FEDERATION_TOKEN` on Main and your node, federation join POSTs to `…/servers/register` so you appear on [frogtalk.app](https://frogtalk.app/api/network/servers) (verify with curl to Main, not only your local `/api/network/servers`)
- Peer **Ed25519 keys** are pinned from each peer’s `/api/network/status`
- Re-run after changing `PUBLIC_URL`, onion URL, or major upgrades

**Official mesh nodes** (directory + optional `fallback_peers` in your mesh JSON when the directory HTTP fetch fails):

| Node | Clearnet | Notes |
|------|----------|--------|
| FrogTalk Main | `https://frogtalk.app` | Production hub · board `@frog-general` |
| FrogTalk Dev | `https://frogtalk.xyz` | Development instance · board `@frogtalk-support` |
| FrogTalk Tor Mirror | `.onion` only | Listed in **Settings → Network** when configured |

Federation is **not hardcoded** in application source. Hub operators copy
[`node/deploy/federation-mesh.example.json`](node/deploy/federation-mesh.example.json) →
`federation-mesh.local.json` and set `FROGTALK_FEDERATION_MESH_FILE`. The public FrogTalk fleet
layout is documented as an example only:
[`federation-mesh.frogtalk.example.json`](node/deploy/federation-mesh.frogtalk.example.json).
See [node/deploy/README.md](node/deploy/README.md#federation-mesh-config-open-source).

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
- Report issues: [frogtalk.app/security](https://frogtalk.app/security)

### Troubleshooting

| Problem | Fix |
|---------|-----|
| Empty DB / missing tables | `node/data` must symlink to `/opt/frogtalk/data` — run setup or federation join |
| Domain 502, local `:8080` OK | Match `PORT` in `.env` with nginx `proxy_pass`; behind Cloudflare tunnel use `PORT=8000` + `FROGTALK_NGINX_TUNNEL_LISTEN=1` (see deploy README) |
| `/board/` 404 on clearnet | Route tunnel through **nginx on 8080**, not uvicorn directly — `install.sh board-nginx` |
| Wrong board pill URLs | Optional `FROGTALK_BOARD_PEER_CANONICAL_FILE` — see `board-peer-canonical.example.json` |
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

Full node setup: **[docs/NODE_INSTALL.md](docs/NODE_INSTALL.md)** · **[frogtalk.app/docs/node](https://frogtalk.app/docs/node)**

---

## API & Bots

FrogTalk has a full REST + WebSocket API. Build bots, integrations, and custom clients.

```
GET  /api/rooms          # list public rooms
POST /api/messages       # send a message (with bridge_token)
WS   /ws/{room}          # real-time message stream
```

Full reference: **[frogtalk.app/docs/api](https://frogtalk.app/docs/api)** — includes
`PATCH /api/auth/client-prefs` (`preferred_node_url`, `prefer_onion`, notification sounds)
for Settings → Network and federation account sync.

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
│   │   ├── build_server_release.sh
│   │   └── migrations/           # one-shot historical migrations
│   ├── tests/                    # pytest suite (sanitizers, proxy, security)
│   ├── requirements.txt
│   ├── Dockerfile                # docker build -f node/Dockerfile -t frogtalk .
│   └── builds/                   # release tarballs (gitignored)
├── bot-examples/                 # standalone reference bots
├── github-build-mirror/          # release binaries published to GitHub
├── docs/
│   ├── README.md                 # index of public operator docs
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

## Open source & contributing

FrogTalk is **MIT-licensed** and developed in the open. The encryption primitives are well-studied (X3DH + Double Ratchet for DMs, per-room AES-256-GCM for private channels, DTLS-fingerprint signing for calls). We publish the [security model](docs/SECURITY_MODEL.md) and welcome audits.

### Get involved

- 🐛 **Bug or security issue?** Report at **<https://frogtalk.app/security>** — anonymous submissions accepted. For sensitive disclosures: `security@frogtalk.app`.
- 🛠️ **Code contribution?** See **[CONTRIBUTING.md](CONTRIBUTING.md)** for branch workflow and review expectations.
- 🛠️ **Feature idea?** File a [feature request](https://github.com/deadinternetfox/frogtalk/issues/new?template=feature_idea.md).
- 📣 **Run a node.** More nodes = more censorship-resistance. Self-host guide above.
- 💬 **Spread the word.** Community projects need a community.

Researchers who responsibly disclose are credited in the security advisory and on the [Hall of Fame](https://frogtalk.app/security#hall-of-fame).

### Contributing (quick start)

1. Fork the repo and branch from **`dev`** (or `master` if `dev` is not available yet).
2. Run `node --check node/static/js/<file>.js` for any JS you touched.
3. Run `python3 -m py_compile node/<file>.py` for any Python you touched.
4. Open a PR with the template filled in. For security fixes, include a PoC.
5. Add yourself to `CONTRIBUTORS.md` in the same PR if you want repo credit.

See [`/security`](https://frogtalk.app/security) for scope, threat model, and what counts as a vulnerability.

---

## License

MIT
