#!/usr/bin/env bash
# Deploy board PHP + .htaccess to both FrogTalk production nodes.
# Usage (from repo root):  bash node/scripts/deploy_board.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

HOSTS=("161.97.182.73:2222" "31.220.92.120:22")
SSH_OPTS=(-o StrictHostKeyChecking=accept-new
          -o UserKnownHostsFile="${HOME}/.ssh/known_hosts"
          -o ConnectTimeout=30
          -o ServerAliveInterval=15
          -o ServerAliveCountMax=6
          -o BatchMode=yes
          -i "${HOME}/.ssh/id_ed25519")

FILES=(
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

scp_with_retry() {
  local port="$1" host="$2" local="$3" remote="$4"
  local attempt
  for attempt in 1 2 3; do
    if scp -P "$port" "${SSH_OPTS[@]}" "$local" "root@${host}:${remote}"; then
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
    ssh -p "$port" "${SSH_OPTS[@]}" "root@${host}" "mkdir -p '${rdir}'" || return 1
    scp_with_retry "$port" "$host" "$f" "$remote" || return 1
    echo "  uploaded $f"
  done
  echo "=== PHP lint on ${host} ==="
  ssh -p "$port" "${SSH_OPTS[@]}" "root@${host}" bash <<'REMOTE'
set -euo pipefail
cd /opt/frogtalk/node/board
for f in board.php board_config.php board_admin.php board_chat.php board_likes.php telegram_bot.php; do
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
  echo "Board deploy finished with ${failures} node failure(s)." >&2
  exit 1
fi
echo "Board deploy: all nodes OK."
