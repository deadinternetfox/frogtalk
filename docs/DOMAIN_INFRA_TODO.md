# Domain & infrastructure

| Host | Role | Branch | `FROGTALK_HOME_PAGE` |
|------|------|--------|----------------------|
| [frogtalk.app](https://frogtalk.app) | Public pre-alpha hub | `master` | `main` |
| [frogtalk.xyz](https://frogtalk.xyz) | Contributor dev node (AU) | `dev` | `dev` |

**Official federation directory:** `https://frogtalk.app/api/network/servers`

## Remaining ops

- [ ] `www.frogtalk.app` DNS + tunnel hostname on Main
- [ ] Dedicated dev Cloudflare tunnel on AU for `frogtalk.xyz` (valid connector token)
- [ ] Admin contacts saved on each node (`/server` → Identity & contacts)
- [x] `/.well-known/assetlinks.json` on **frogtalk.app** and **frogtalk.xyz** (Play credential sharing / App Links)
- [ ] Mobile: Play Console domain verification + credential sharing UI signed off
- [x] AU `/board/` behind nginx tunnel (`PORT=8000`, `FROGTALK_NGINX_TUNNEL_LISTEN=1`) — see deploy README
- [ ] Tor vanity `frogtalk*.onion` — search running on Tor VPS; see [TOR_VANITY_ONION.md](TOR_VANITY_ONION.md)

**Federation mesh (operators):** copy `node/deploy/federation-mesh.example.json` on each VPS; hub sets `FROGTALK_FEDERATION_DIRECTORY_HUB=1`. Reference fleet layout: `federation-mesh.frogtalk.example.json` (not loaded automatically).

Deploy: see [node/deploy/README.md](../node/deploy/README.md).
