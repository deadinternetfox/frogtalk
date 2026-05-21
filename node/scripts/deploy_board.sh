#!/usr/bin/env bash
# Maintainer tool: SCP board PHP to hosts listed in deploy_fleet.local.sh (gitignored).
# Normal installs use the setup wizard (install_board_nginx.sh + configure_board_identity.sh).
#
#   cp node/scripts/deploy_fleet.local.example.sh node/scripts/deploy_fleet.local.sh
#   bash node/scripts/deploy_board.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

FLEET_FILE="$SCRIPT_DIR/deploy_fleet.local.sh"
if [[ ! -f "$FLEET_FILE" ]]; then
  echo "Maintainer fleet config missing." >&2
  echo "  cp node/scripts/deploy_fleet.local.example.sh node/scripts/deploy_fleet.local.sh" >&2
  echo "  Edit FLEET_HOSTS=() with your SSH targets (never commit passwords)." >&2
  exit 1
fi
# shellcheck source=deploy_fleet.local.sh
source "$FLEET_FILE"

HOSTS=("${FLEET_HOSTS[@]:-}")
[[ ${#HOSTS[@]} -gt 0 ]] || { echo "FLEET_HOSTS is empty in deploy_fleet.local.sh" >&2; exit 1; }

SSH_USER="${FLEET_SSH_USER:-root}"
SSH_KEY="${FLEET_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new
          -o UserKnownHostsFile="${HOME}/.ssh/known_hosts"
          -o ConnectTimeout=30
          -o ServerAliveInterval=15
          -o ServerAliveCountMax=6
          -o BatchMode=yes
          -i "$SSH_KEY")

FILES=(
  node/board/router.php
  node/board/board.php
  node/board/board_config.php
  node/board/board_admin.php
  node/board/board_chat.php
  node/board/board_likes.php
  node/board/telegram_bot.php
  node/board/.htaccess
  node/board/board_data/.htaccess
  node/board/board_previews/.htaccess
  node/board/board_uploads/.htaccess
)

host_uses_password() {
  [[ -n "${FLEET_SSH_PASS[$1]:-}" ]]
}

remote_ssh() {
  local port="$1" host="$2"
  shift 2
  if host_uses_password "$host"; then
    command -v sshpass >/dev/null 2>&1 || { echo "sshpass required for $host" >&2; return 1; }
    SSHPASS="${FLEET_SSH_PASS[$host]}" sshpass -e ssh -p "$port" \
      -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 \
      -o ServerAliveInterval=15 "${SSH_USER}@${host}" "$@"
  else
    ssh -p "$port" "${SSH_OPTS[@]}" "${SSH_USER}@${host}" "$@"
  fi
}

remote_scp() {
  local port="$1" host="$2" local="$3" remote="$4"
  if host_uses_password "$host"; then
    command -v sshpass >/dev/null 2>&1 || return 1
    SSHPASS="${FLEET_SSH_PASS[$host]}" sshpass -e scp -P "$port" \
      -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 \
      "$local" "${SSH_USER}@${host}:${remote}"
  else
    scp -P "$port" "${SSH_OPTS[@]}" "$local" "${SSH_USER}@${host}:${remote}"
  fi
}

scp_with_retry() {
  local port="$1" host="$2" local="$3" remote="$4"
  local attempt
  for attempt in 1 2 3; do
    if remote_scp "$port" "$host" "$local" "$remote"; then
      return 0
    fi
    echo "  retry $local -> $host (attempt $attempt)" >&2
    sleep 5
  done
  return 1
}

deploy_node() {
  local spec="$1"
  local host="${spec%%:*}"
  local port="${spec##*:}"
  echo "=== Deploy board -> ${host}:${port} ==="
  local f remote rdir
  for f in "${FILES[@]}"; do
    remote="/opt/frogtalk/node/${f#node/}"
    rdir="$(dirname "$remote")"
    remote_ssh "$port" "$host" "mkdir -p '${rdir}'" || return 1
    scp_with_retry "$port" "$host" "$f" "$remote" || return 1
    echo "  uploaded $f"
  done
  echo "=== PHP lint on ${host} ==="
  remote_ssh "$port" "$host" bash <<'REMOTE'
set -euo pipefail
cd /opt/frogtalk/node/board
for f in board.php board_config.php board_admin.php board_chat.php board_likes.php telegram_bot.php router.php; do
  echo -n "$f: "
  php -l "$f"
done
REMOTE
  echo "=== ${host} OK ==="
}

failures=0
for spec in "${HOSTS[@]}"; do
  if ! deploy_node "$spec"; then
    failures=$((failures + 1))
    echo "=== FAILED: $spec ===" >&2
  fi
  echo
done

if (( failures > 0 )); then
  echo "Board deploy finished with ${failures} host failure(s)." >&2
  exit 1
fi
echo "Board deploy: all hosts OK."
