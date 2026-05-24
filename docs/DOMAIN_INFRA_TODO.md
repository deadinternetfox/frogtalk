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
- [ ] Mobile: ship builds with `frogtalk.app` app links / asset links verified

Deploy: see [node/deploy/README.md](../node/deploy/README.md).
