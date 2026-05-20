# Node Operations

This folder documents the operator/self-host boundary for FrogTalk nodes.

Current source-of-truth paths:

- `deploy/` - systemd/nginx/env templates
- `scripts/node_setup_wizard.sh` - guided first-time setup
- `scripts/node_update_check.sh` - update check and safe apply
- `docs-node.html` - public node docs page

Planned direction:

- Keep self-host scripts and release/operator workflows grouped in `node/`.
- Prioritize idempotent scripts and clear failure handling for edge cases.
