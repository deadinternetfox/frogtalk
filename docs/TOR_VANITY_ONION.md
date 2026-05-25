# Tor vanity hidden service (`frogtalk*.onion`)

FrogTalk’s Tor node should advertise a **v3 onion** hostname. A vanity prefix (e.g. `frogtalk`) makes the address recognizable but can take a long time to compute.

## Quick start (Tor VPS)

```bash
# Search only (shows progress; may take hours for "frogtalk")
sudo bash node/scripts/tor_vanity_onion.sh --prefix frogtalk --threads "$(nproc)"

# Faster fallback prefixes
sudo bash node/scripts/tor_vanity_onion.sh --prefix frogta --threads "$(nproc)" --apply
sudo bash node/scripts/tor_vanity_onion.sh --prefix frog --threads "$(nproc)" --apply

# After a match: install tor service + FrogTalk .env
sudo bash node/scripts/tor_vanity_onion.sh --apply --onion http://YOURHOST.onion
```

`--apply` will:

1. Install hidden-service keys under `/var/lib/tor/frogtalk_hs/`
2. Write `/etc/tor/torrc.d/frogtalk-frogtalk.conf` → `127.0.0.1:8080`
3. Set `FROGTALK_TOR_ENABLED=1`, `FROGTALK_ONION_URL`, `FROGTALK_HOME_PAGE=tor`
4. Run `configure_board_identity.sh` (board topic **Privacy**, title **🐸 Frog General**)
5. Restart `tor` and `frogtalk.service`

Then publish to federation:

```bash
bash node/scripts/node_federation_join.sh --install-dir /opt/frogtalk --onion-url http://YOURHOST.onion
```

## Branch / client defaults

| Branch | Default home node (`client/official-node.json`) |
|--------|--------------------------------------------------|
| `master` | `frogtalk.app` |
| `dev` | `frogtalk.xyz` |

Tor users connect via `.onion` in the app **Network** settings, not `official-node.json`.

## Expectations

| Prefix length | Rough difficulty |
|---------------|------------------|
| `frog` (4) | minutes–hours |
| `frogta` (6) | hours–days |
| `frogtalk` (8) | days–weeks (CPU) |

Run under `screen` or `tmux`. Partial matches (e.g. `frogtalk7k…onion`) are still useful.

## Manual torrc (without script)

```tor
HiddenServiceDir /var/lib/tor/frogtalk_hs/
HiddenServiceVersion 3
HiddenServicePort 80 127.0.0.1:8080
```

Copy `hostname`, `hs_ed25519_*` from mkp224o output into `HiddenServiceDir`, `chown debian-tor:debian-tor`, `chmod 700`.
