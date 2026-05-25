#!/usr/bin/env bash
# Apply configure_board_identity.sh on each fleet host (main / dev / tor).
# Requires deploy_fleet.local.sh + deploy_nodes.local.sh (gitignored).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=lib/cli.sh
source "$SCRIPT_DIR/lib/cli.sh"

FLEET_FILE="$SCRIPT_DIR/deploy_fleet.local.sh"
LOCAL_FILE="$SCRIPT_DIR/deploy_nodes.local.sh"
[[ -f "$FLEET_FILE" ]] || ft_die "Missing deploy_fleet.local.sh"
[[ -f "$LOCAL_FILE" ]] && source "$LOCAL_FILE"
# shellcheck source=deploy_fleet.local.sh
source "$FLEET_FILE"

CFG="$REPO_ROOT/node/scripts/configure_board_identity.sh"
[[ -f "$CFG" ]] || ft_die "Missing configure_board_identity.sh"

declare -A HOME_PAGE=(
  ["31.220.92.120"]="main"
  ["46.250.244.184"]="dev"
  ["161.97.182.73"]="tor"
)

for spec in "${FLEET_HOSTS[@]:-}"; do
  host="${spec%%:*}"
  port="${spec##*:}"
  [[ "$host" != "$port" ]] || port=22
  home="${HOME_PAGE[$host]:-main}"
  ft_step "${host}:${port} → FROGTALK_HOME_PAGE=${home}"
  pass="${FLEET_SSH_PASS[$host]:-}"
  if [[ -n "$pass" ]]; then
    sshpass -p "$pass" scp -P "$port" -o StrictHostKeyChecking=accept-new "$CFG" "root@${host}:/opt/frogtalk/node/scripts/configure_board_identity.sh"
    sshpass -p "$pass" ssh -T -p "$port" -o StrictHostKeyChecking=accept-new "root@${host}" \
      "grep -q '^FROGTALK_HOME_PAGE=' /opt/frogtalk/.env 2>/dev/null && sed -i 's/^FROGTALK_HOME_PAGE=.*/FROGTALK_HOME_PAGE=${home}/' /opt/frogtalk/.env || echo FROGTALK_HOME_PAGE=${home} >> /opt/frogtalk/.env; export FROGTALK_HOME_PAGE=${home}; bash /opt/frogtalk/node/scripts/configure_board_identity.sh --install-dir /opt/frogtalk"
  else
    scp -P "$port" -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$CFG" "root@${host}:/opt/frogtalk/node/scripts/configure_board_identity.sh"
    ssh -T -p "$port" -o StrictHostKeyChecking=accept-new -o BatchMode=yes "root@${host}" \
      "grep -q '^FROGTALK_HOME_PAGE=' /opt/frogtalk/.env 2>/dev/null && sed -i 's/^FROGTALK_HOME_PAGE=.*/FROGTALK_HOME_PAGE=${home}/' /opt/frogtalk/.env || echo FROGTALK_HOME_PAGE=${home} >> /opt/frogtalk/.env; export FROGTALK_HOME_PAGE=${home}; bash /opt/frogtalk/node/scripts/configure_board_identity.sh --install-dir /opt/frogtalk"
  fi
done
ft_ok "Fleet board identity applied"
