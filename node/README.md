# Node Operations

This folder documents the operator/self-host boundary for FrogTalk nodes.
The actual scripts and templates live at canonical paths under the repo root so
existing deploy paths keep working.

## Self-host quickstart

```bash
git clone https://github.com/deadinternetfox/frogtalk.git /opt/frogtalk
cd /opt/frogtalk
bash scripts/node_setup_wizard.sh        # interactive setup with safe defaults

# later, check for updates
bash scripts/node_update_check.sh        # check only
bash scripts/node_update_check.sh --apply # signature-verified, fast-forward apply
```

Full walkthrough: [`static/docs-node.html`](../static/docs-node.html) (served at `/docs/node`).

## Source-of-truth paths

- `deploy/` — systemd / nginx / env templates
- `scripts/node_setup_wizard.sh` — guided first-time setup, writes `.env`, installs deps, prints next steps
- `scripts/node_update_check.sh` — update feed check + signature-verified safe apply
- `static/docs-node.html` — public-facing node docs page

## Defaults (post 2026-05 hardening)

- `FROGTALK_AUTO_UPDATE_ENABLED=0` — operators opt in to auto-apply explicitly
- `FROGTALK_FEDERATION_REQUIRE_SIGS=1` — unsigned federation events are rejected
- `FROGTALK_RELEASE_SIGNERS=` — must be set to the Ed25519 pubkey hex(s) you trust before any update apply succeeds

## Design rules

- Idempotent scripts. Re-runs must be safe.
- Edge-case skip-on-error, not abort-on-error. The wizard prints what was skipped so the operator can fix it.
- Never silently mutate `.env`. Show a diff and confirm.
