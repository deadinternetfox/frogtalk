#!/usr/bin/env bash
# Smoke-check that doc-referenced install paths exist and key scripts parse.
# Run from repo root: bash node/scripts/test_doc_install_smoke.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

fail=0
check() {
  if [[ -e "$1" ]]; then
    echo "  ok  $1"
  else
    echo "  MISSING  $1" >&2
    fail=1
  fi
}

echo "=== Doc install smoke (${ROOT}) ==="
for f in \
  docs/NODE_INSTALL.md \
  node/static/docs-node.html \
  node/scripts/install.sh \
  node/scripts/node_setup_wizard.sh \
  node/scripts/install_board_nginx.sh \
  node/scripts/install_node_ssl.sh \
  node/scripts/node_federation_join.sh \
  node/deploy/nginx.conf \
  node/deploy/env.example; do
  check "$f"
done

echo "=== bash -n ==="
for s in node/scripts/install.sh \
  node/scripts/node_setup_wizard.sh \
  node/scripts/install_board_nginx.sh \
  node/scripts/install_node_ssl.sh \
  node/scripts/node_federation_join.sh \
  node/scripts/deploy_nodes.sh; do
  bash -n "$s" && echo "  ok  $s"
done

echo "=== install.sh help ==="
bash node/scripts/install.sh help | grep -q ssl && echo "  ok  install.sh lists ssl command"

if [[ "$fail" -ne 0 ]]; then
  echo "Smoke check FAILED" >&2
  exit 1
fi
echo "Smoke check passed."
