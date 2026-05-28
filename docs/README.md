# FrogTalk documentation

Operator and security documentation published with the repository.

**Project status:** Pre-alpha — expect breaking changes; see [security](https://frogtalk.app/security) before production use.

| Document | Audience |
| -------- | -------- |
| [NODE_INSTALL.md](NODE_INSTALL.md) | VPS install, nginx, Cloudflare tunnel, federation join |
| [SECURITY_MODEL.md](SECURITY_MODEL.md) | Encryption, federation trust, account sync, content warnings |

**Branches**

| Branch | Host | Notes |
|--------|------|--------|
| `dev` | [frogtalk.xyz](https://frogtalk.xyz) | Active development instance; board `@frogtalk-support` |
| `master` | [frogtalk.app](https://frogtalk.app) | Production hub; federation directory; board `@frog-general` |

**Live docs (same paths on both hosts)**

| Page | Production | Development |
|------|------------|-------------|
| Node operator guide | [frogtalk.app/docs/node](https://frogtalk.app/docs/node) | [frogtalk.xyz/docs/node](https://frogtalk.xyz/docs/node) |
| HTTP API reference | [frogtalk.app/docs/api](https://frogtalk.app/docs/api) | [frogtalk.xyz/docs/api](https://frogtalk.xyz/docs/api) |
| Security | [frogtalk.app/security](https://frogtalk.app/security) | [frogtalk.xyz/security](https://frogtalk.xyz/security) |

Deploy copies static docs from `node/static/` with the node release — edit HTML/CSS there when documenting new endpoints (e.g. `PATCH /api/auth/client-prefs`).
