# FrogTalk Node

This folder is the **entire federated server**: the FastAPI app, its static
assets, deploy templates, container build, operator scripts, and tests. If you
want to self-host FrogTalk, everything you touch lives here.

## Self-host quickstart

```bash
git clone https://github.com/deadinternetfox/frogtalk.git /opt/frogtalk
cd /opt/frogtalk
bash node/scripts/node_setup_wizard.sh

# join the public mesh (chat directory + board nav pills):
bash node/scripts/node_federation_join.sh --install-dir /opt/frogtalk -y

# later, check for updates (signature-verified):
bash node/scripts/node_update_check.sh           # check only
bash node/scripts/node_update_check.sh --apply   # fast-forward apply
```

The wizard creates `venv/`, writes a safe `.env`, and links runtime state
(`data/`, `secrets/`, `.env`) into the source tree so the systemd unit
(`WorkingDirectory=/opt/frogtalk/node`) keeps finding them.

Full walkthrough: [`static/docs-node.html`](static/docs-node.html) (served at
`/docs/node`).

## Layout

```
node/
├── main.py                # FastAPI entrypoint
├── database.py            # SQLite schema + migrations (DB_PATH respected)
├── routers/               # one module per surface (auth, dms, ws, federation…)
├── static/                # web client + marketing pages
├── board/                 # Frog Channel PHP imageboard (public URL /board/)
├── deploy/
│   ├── frogtalk.service   # systemd unit (WorkingDirectory=/opt/frogtalk/node)
│   ├── nginx.conf
│   └── env.example
├── scripts/
│   ├── node_setup_wizard.sh
│   ├── node_federation_join.sh   # colored CLI: mesh chat + board peers
│   ├── node_update_check.sh
│   ├── deploy.sh
│   ├── deploy_board.sh
│   ├── build_server_release.sh
│   └── migrations/        # one-shot historical migrations
├── tests/                 # pytest suite (sanitizers, proxy, security pass)
├── requirements.txt
├── Dockerfile             # docker build -f node/Dockerfile -t frogtalk .
└── builds/                # release tarballs (gitignored)
```

## Runtime contract

| Path on disk                  | Owner            | Notes                                  |
|-------------------------------|------------------|----------------------------------------|
| `/opt/frogtalk/.env`          | operator         | secrets, never overwritten by deploy   |
| `/opt/frogtalk/data/`         | operator         | SQLite DB + upload bookkeeping         |
| `/opt/frogtalk/secrets/`      | operator         | release signer pubkeys, federation keys |
| `/opt/frogtalk/venv/`         | operator         | Python virtualenv                      |
| `/opt/frogtalk/node/`         | rsync target     | matches this folder, replaced on deploy|
| `/opt/frogtalk/node/data`     | symlink          | → `/opt/frogtalk/data`                 |
| `/opt/frogtalk/node/.env`     | symlink          | → `/opt/frogtalk/.env`                 |
| `/opt/frogtalk/node/secrets`  | symlink          | → `/opt/frogtalk/secrets`              |

## Safe defaults (post 2026-05 hardening)

- `FROGTALK_AUTO_UPDATE_ENABLED=0` — operators opt in explicitly.
- `FROGTALK_FEDERATION_REQUIRE_SIGS=1` — unsigned federation events rejected.
- `FROGTALK_RELEASE_SIGNERS=` — must be set to trusted Ed25519 pubkey hex
  before any update will apply.
- `FROGTALK_TOR_ENABLED=1` plus `FROGTALK_ONION_URL=…` runs the node as a
  hidden service with no clearnet leak.

## Design rules for ops scripts

- **Idempotent.** Re-runs are safe; a missing symlink is created, an existing
  one is left alone.
- **Skip on error, never abort.** Edge cases print what was skipped so the
  operator can fix it without rolling back.
- **No silent `.env` mutation.** The wizard sets keys you confirmed; everything
  else is left alone.

## Tests

```bash
cd node && python -m pytest tests/ -q
```

The suite covers HTML/CSS sanitizers, image proxy guards, Tor-mode behaviour,
and the 2026-05 security pass.
