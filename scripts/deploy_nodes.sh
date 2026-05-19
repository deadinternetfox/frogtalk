#!/usr/bin/env bash
# FrogTalk node deploy with auto-port-detection.
#
# Probes each host on candidate SSH ports until one answers, then SCPs the
# requested files in parallel and restarts the service. Run from repo root:
#
#   scripts/deploy_nodes.sh                     # uses default file list
#   scripts/deploy_nodes.sh file1 file2 ...     # custom file list (paths
#                                                 relative to repo root)
#
# Hosts and candidate ports are hard-coded below — change them in one place.

set -euo pipefail

HOSTS=("161.97.182.73" "31.220.92.120")
CANDIDATE_PORTS=(22 2222)
SSH_USER=root
REMOTE_BASE=/opt/frogtalk
SSH_KEY="${HOME}/.ssh/id_ed25519"
SSH_OPTS=(-o StrictHostKeyChecking=no
          -o ConnectTimeout=5
          -o ServerAliveInterval=10
          -o BatchMode=yes
          -i "$SSH_KEY")

# Default file set if caller passed nothing. Each entry is
#   "<local_path>:<remote_path>"
# Remote paths are relative to REMOTE_BASE.
DEFAULT_FILES=(
  "static/index.html:static/index.html"
  "static/sw.js:sw.js"
  "static/js/media.js:static/js/media.js"
  "static/js/messages.js:static/js/messages.js"
  "static/js/notifications.js:static/js/notifications.js"
  "static/js/dms.js:static/js/dms.js"
  "static/js/pin.js:static/js/pin.js"
  "static/js/state.js:static/js/state.js"
  "static/js/rooms.js:static/js/rooms.js"
  "static/js/ui.js:static/js/ui.js"
)

if [[ $# -gt 0 ]]; then
  FILES=()
  for f in "$@"; do
    if [[ "$f" == *:* ]]; then
      FILES+=("$f")
    else
      # local path == remote path under REMOTE_BASE
      FILES+=("$f:$f")
    fi
  done
else
  FILES=("${DEFAULT_FILES[@]}")
fi

probe_port() {
  local host="$1" port="$2"
  # Quick handshake check — `ssh -G` doesn't connect, so use a real probe
  # that exits non-zero on connection failure but succeeds on auth too.
  ssh -p "$port" "${SSH_OPTS[@]}" "${SSH_USER}@${host}" true 2>/dev/null
}

detect_port() {
  local host="$1"
  for p in "${CANDIDATE_PORTS[@]}"; do
    if probe_port "$host" "$p"; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

deploy_to() {
  local host="$1" port="$2"
  echo "=== [$host:$port] starting deploy ($(date +%H:%M:%S)) ==="

  # SCP every file. Skip missing local paths with a warning instead of
  # aborting the whole node so a stale file list doesn't block a deploy.
  local pair local_path remote_path uploaded=0 failed=()
  for pair in "${FILES[@]}"; do
    local_path="${pair%%:*}"
    remote_path="${pair##*:}"
    if [[ ! -f "$local_path" ]]; then
      echo "[$host:$port] skip (missing): $local_path"
      continue
    fi
    if scp -q -P "$port" "${SSH_OPTS[@]}" \
        "$local_path" \
        "${SSH_USER}@${host}:${REMOTE_BASE}/${remote_path}"; then
      uploaded=$((uploaded + 1))
      echo "[$host:$port] uploaded $local_path"
    else
      failed+=("$local_path")
      echo "[$host:$port] FAILED $local_path" >&2
    fi
  done

  if (( ${#failed[@]} > 0 )); then
    echo "[$host:$port] ${#failed[@]} file(s) failed: ${failed[*]}" >&2
    return 1
  fi

  echo "[$host:$port] restarting frogtalk.service ($uploaded files synced)"
  if ssh -p "$port" "${SSH_OPTS[@]}" "${SSH_USER}@${host}" \
      'systemctl restart frogtalk && systemctl is-active frogtalk'; then
    echo "=== [$host:$port] OK ==="
    return 0
  else
    echo "=== [$host:$port] RESTART FAILED ==="
    return 1
  fi
}

main() {
  local failures=0
  declare -A PORT_FOR

  echo "--- Probing SSH ports ---"
  for host in "${HOSTS[@]}"; do
    if port=$(detect_port "$host"); then
      echo "  $host -> port $port"
      PORT_FOR["$host"]=$port
    else
      echo "  $host -> NO ANSWER on ports ${CANDIDATE_PORTS[*]}" >&2
      failures=$((failures + 1))
    fi
  done

  if (( failures > 0 )); then
    echo "Aborting: ${failures} host(s) unreachable." >&2
    exit 2
  fi

  echo
  echo "--- Deploying (sequential per host, restart at end) ---"
  for host in "${HOSTS[@]}"; do
    port="${PORT_FOR[$host]}"
    if ! deploy_to "$host" "$port"; then
      failures=$((failures + 1))
    fi
    echo
  done

  if (( failures > 0 )); then
    echo "Deploy completed with ${failures} failure(s)." >&2
    exit 1
  fi
  echo "All hosts deployed successfully."
}

main "$@"
