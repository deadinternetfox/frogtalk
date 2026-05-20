#!/usr/bin/env bash
# Smoke tests for operator install/update scripts (syntax + dry-run).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

fail=0
check() {
  if "$@"; then
    printf "  ok  %s\n" "$*"
  else
    printf "  FAIL %s\n" "$*"
    fail=1
  fi
}

printf "install script smoke tests\n"

for f in \
  node/scripts/lib/cli.sh \
  node/scripts/install.sh \
  node/scripts/node_setup_wizard.sh \
  node/scripts/node_update_check.sh \
  node/scripts/node_federation_join.sh
do
  check bash -n "$f"
done

check bash node/scripts/install.sh help
check bash node/scripts/node_update_check.sh --help
check bash node/scripts/node_setup_wizard.sh --help

# Dry-run update check against this checkout (no --apply).
check bash node/scripts/node_update_check.sh --install-dir "$ROOT"

# lib helpers sourced in subshell
check bash -c '
  source node/scripts/lib/cli.sh
  d="$(ft_resolve_install_dir /opt/frogtalk "'"$ROOT"'")"
  [[ -f "$d/node/main.py" ]]
'

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
printf "All install script smoke tests passed.\n"
