# Security Policy

FrogTalk is **vibe-coded but open source**. We welcome responsible disclosure from anyone who finds a flaw — anonymous reports are fine, and fixes often ship the same day for critical issues.

Full details, threat model, and the public report form live at **https://frogtalk.xyz/security**.

## Supported versions

We ship continuously from `main`. Only the latest deployed build on [frogtalk.xyz](https://frogtalk.xyz) and self-hosted nodes that have pulled recent updates are supported. There are no long-term release branches.

## How to report a vulnerability

**Preferred (most issues):** use the form at https://frogtalk.xyz/security  
Anonymous submissions are accepted. Include repro steps, a PoC if you have one, and optional contact info for follow-up and credit.

**Sensitive disclosures:** email **security@frogtalk.xyz**  
Use this for issues you would rather not put in the web form (account takeover, E2EE bypass, RCE, etc.). Include:

- A clear description of the issue
- Steps to reproduce (or a minimal PoC)
- Your assessment of impact / severity
- How you would like to be credited (handle, email, or anonymous)

**GitHub issues:** do **not** open public issues for unfixed security vulnerabilities. Use the form or email above instead.

## What we consider in scope

| Impact | Examples |
|--------|----------|
| **Critical / high** | Account takeover, E2EE bypass, message tampering, server-side RCE, SQL injection, authentication bypass |
| **Medium** | Stored or reflected XSS, CSRF on state-changing endpoints, privilege escalation, IDOR, sensitive data leaks |
| **Lower** | Rate-limit bypass, DoS via unbounded inputs, non-sensitive info disclosure |

## Out of scope

- Spamming yourself from your own account
- Missing security headers without a working exploit
- Raw automated scanner output without a PoC
- Social engineering of other users
- Issues in third-party services we do not operate (RunPod, Discord, Telegram, etc.) unless FrogTalk's integration is the root cause

## Safe testing

Please **do not** run destructive exploits against the live production server beyond what is needed to confirm the bug.

For mass-account creation, DoS, or other high-impact tests, run a **local instance**:

```bash
git clone https://github.com/deadinternetfox/frogtalk.git
cd frogtalk
cp node/deploy/env.example .env   # set ADMIN_PASSWORD, etc.
python3 -m venv venv && source venv/bin/activate
pip install -r node/requirements.txt
cd node && python main.py         # → http://localhost:8080
```

Or use Docker — see the README.

## Response & credit

- We aim to acknowledge reports within **48 hours** and ship fixes for critical issues as fast as we can (often same day).
- There is **no paid bug bounty** yet. We offer public credit in advisories and on the [Hall of Fame](https://frogtalk.xyz/security#hall-of-fame), plus honest write-ups of what broke and why.
- Add yourself to `CONTRIBUTORS.md` under **Security researchers** if you want a permanent repo credit, or tell us how to name you in the advisory.

## Threat model (summary)

- **DMs** are end-to-end encrypted (ECDH-P256 → AES-GCM-256). The server stores ciphertext only.
- **Private channels** use per-room AES-GCM with AAD-bound ciphertext and key rotation on ban/kick.
- **Public channels** are not E2EE by design.
- We assume the server *can* be compromised; E2EE exists so that compromise does not expose DM plaintext.
- Bridges to Discord/Telegram are blocked for private rooms.

More detail: [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) and https://frogtalk.xyz/security

## Security researchers we have thanked

See the live Hall of Fame at https://frogtalk.xyz/security#hall-of-fame (e.g. **@frogtalk_is_insecure** — channel CSS / IP-leak audit, May 2026).

---

Thank you for helping keep the swamp safe. 🐸
