# Contributing to FrogTalk

FrogTalk is **pre-alpha** software: features ship quickly, APIs may change, and not every path has been audited. We still welcome issues, security reports, and pull requests — especially if you help us harden the code before wider release.

---

## Branches

| Branch | Live host | Client default (`official-node.json`) | Purpose |
|--------|-----------|--------------------------------------|---------|
| **`dev`** | [frogtalk.xyz](https://frogtalk.xyz) | `https://frogtalk.xyz` | **Active development** — features and docs land here first; expect breakage |
| **`master`** | [frogtalk.app](https://frogtalk.app) | `https://frogtalk.app` | Pre-alpha **production hub** — directory API and stable operator line |

**Workflow:** fork, branch from **`dev`**, open PRs into **`dev`**. Test against [frogtalk.xyz](https://frogtalk.xyz) when your change touches the live stack. Maintainers merge **`dev` → `master`** for production deploys on [frogtalk.app](https://frogtalk.app). Hotfixes may branch from `master` and be back-merged into `dev`.

**Federation / board ops:** application code no longer embeds FrogTalk server IDs. Operators use env-driven mesh and board canonical files — see [node/deploy/README.md](node/deploy/README.md) and example JSON under `node/deploy/`. Do not commit `*.local.json` or production tokens.

**Docs:** API and node guides are served at `/docs/api` and `/docs/node` on both hosts (mobile-friendly CSS). Update `node/static/docs-*.html` when you change public API behaviour.

---

## How to file an issue

Use a GitHub issue template when it fits:

- **Bug report** — something is broken or behaves wrong.
- **Feature idea** — half-formed ideas are welcome.
- **Security vulnerability** — use the dedicated process below, not a public issue for unfixed exploits.

Good issues have a specific title, repro steps when behavioural, and file/line links when you have them. Do not paste session tokens, recovery keys, or other users' messages.

---

## Security vulnerabilities

1. **Web form (most issues):** [frogtalk.app/security](https://frogtalk.app/security) — anonymous OK.
2. **Sensitive disclosures:** `security@frogtalk.app` — account takeover, E2EE bypass, RCE, etc.
3. **Do not** open public GitHub issues for unfixed security bugs.

See [SECURITY.md](SECURITY.md) and the live [security page](https://frogtalk.app/security) for scope and safe testing guidance.

---

## Pull requests

1. Fork, branch from **`dev`** (or `master` if `dev` is unavailable).
2. Keep PRs focused — one logical change when possible.
3. Fill in the PR template honestly.
4. Run sanity checks before pushing:
   - `node --check node/static/js/<file>.js` for every JS file you touched
   - `python3 -m py_compile node/<file>.py` for every Python file you touched
5. Exercise the changed path locally (web app, API, or node as relevant).
6. No secrets, tokens, or credentials in the diff.
7. New dependencies need justification in the PR. Prefer existing stack (FastAPI, vanilla JS, SQLite).

### Review checklist (human review)

Reviewers should verify:

- **Security** — auth on new endpoints, input validation, no XSS/HTML injection, CSRF on state-changing routes where applicable, no secrets logged or committed.
- **Crypto** — E2EE paths stay client-side; no plaintext DMs/private rooms on disk; bridge rules respected for private rooms.
- **Federation** — signed events, pubkey pinning, no trust bypass for convenience.
- **Correctness** — edge cases, error handling, no silent swallow of failures that leave UI stuck.
- **Scope** — diff matches the stated goal; no drive-by refactors.
- **Ops** — migrations idempotent; env vars documented when new toggles are added.

Follow-up gaps can ship as separate PRs — note them in the template.

---

## Credit

Add yourself to [CONTRIBUTORS.md](CONTRIBUTORS.md) in the same PR if you want repo credit. Security researchers are also listed on the [Hall of Fame](https://frogtalk.app/security#hall-of-fame).

---

## Code of conduct

Be direct, be kind, assume good intent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
