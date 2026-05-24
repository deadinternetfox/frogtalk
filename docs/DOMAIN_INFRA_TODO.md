# Domain & infrastructure TODO

Canonical plan for **frogtalk.app** (main) vs **frogtalk.xyz** (dev) and node homepage variants.

## Host map (target)

| Host | VPS | Branch | `FROGTALK_HOME_PAGE` | Role |
|------|-----|--------|----------------------|------|
| frogtalk.app | 31.220.92.120 | `master` | `main` | Public production |
| frogtalk.xyz | 46.250.244.184 (AU) | `dev` | `dev` | Contributor / dev testbed |
| (travel) | 161.97.182.73 | — | `main` | Federation travel tests |

## Done in repo

- [x] Markdown docs default to `frogtalk.app`; README/CONTRIBUTING document dev on `.xyz`
- [x] `OFFICIAL_HUB_URL_DEFAULT` → `https://frogtalk.app`
- [x] Substitution replaces legacy `.xyz` and `.app` official URLs
- [x] App shell (`/app`) gets `substitute_operator_content()`
- [x] Static HTML templates use `.app`; emails default `@frogtalk.app`
- [x] `home-dev.html`, `home-tor.html`, `FROGTALK_HOME_PAGE`, `/tor` route
- [x] `client/tor/TOR_TODO.md` spec
- [x] `Node Pages/` gitignored (local operator variants)

## Operator — DNS & VPS (manual)

- [x] Main `.env`: `PUBLIC_URL=https://frogtalk.app`, `FROGTALK_HOME_PAGE=main` (31.220.92.120)
- [x] AU `.env`: `PUBLIC_URL=https://frogtalk.xyz`, `FROGTALK_HOME_PAGE=dev` (46.250.244.184)
- [x] Stop duplicate `cloudflared` on 161.97.182.73
- [ ] **Cloudflare:** add `frogtalk.app` + `www` to **main** tunnel → `http://localhost:8080`
- [ ] **Cloudflare:** create **dev** tunnel for `frogtalk.xyz` + `www` → install token on AU
- [ ] Run `CF_API_TOKEN=… bash node/scripts/configure_cloudflare_tunnels.sh` (or dashboard)
- [ ] Admin `/server`: confirm public URL + contacts on each node
- [ ] Federation directory: label dev node display name “FrogTalk Dev”
- [ ] Mobile: update `assetlinks.json` / iOS entitlements for `.app` if production moves

## Code follow-ups

- [ ] Rename `master` → `main` on GitHub (optional)
- [ ] Serve footer partial through substitution route
- [ ] Dynamic `llms.txt` / `opensearch.xml` per node
- [ ] Implement `client/tor/` M0–M1 (see TOR_TODO.md)
- [ ] CI: grep guard for new hardcoded `frogtalk.xyz` in static (allow dev docs)

## Local `Node Pages/` (gitignored)

Copy variants into `node/static/` before deploy, or set `FROGTALK_HOME_PAGE`:

```
Node Pages/
├── main/home.html   → node/static/home.html
├── dev/home.html    → node/static/home-dev.html
└── tor/home.html    → node/static/home-tor.html
```

## Deploy commands

```bash
# Production (master → main node)
FT_DEPLOY_BASE=HEAD~1 node/scripts/deploy_nodes.sh

# After DNS cutover, deploy dev branch to AU only (custom fleet slice — local config)
```
