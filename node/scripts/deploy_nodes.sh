#!/usr/bin/env bash
# FrogTalk node deploy with auto-port-detection.
#
# Probes each host on candidate SSH ports until one answers, then SCPs the
# requested files in parallel and restarts the service. Run from repo root:
#
#   node/scripts/deploy_nodes.sh                    # uses default file list
#   node/scripts/deploy_nodes.sh path1 path2 ...    # custom file list
#                                                   # (paths relative to repo root)
#
# Related maintainer scripts:
#   deploy.sh       — full rsync of node/ to one host (node/scripts/.env)
#   deploy_board.sh — PHP imageboard hotfix to the same fleet
#
# Production fleet (3 nodes) — change hosts/ports in one place.
#
# Post 2026-05 restructure: local paths live under node/, and the remote
# runtime tree is /opt/frogtalk/node/. The script transparently rewrites
# bare `static/...` arguments to `node/static/...` so old muscle memory keeps
# working.

set -euo pipefail

# Always operate from repo root so relative paths resolve.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# FrogTalk Main (clearnet), Tor/EU mirror, AUS clearnet test node.
HOSTS=("161.97.182.73" "31.220.92.120" "46.250.244.184")
declare -A HOST_LABEL=(
  ["161.97.182.73"]="FrogTalk Main"
  ["31.220.92.120"]="FrogTalk Tor / EU"
  ["46.250.244.184"]="FrogTalk AUS"
)
# Per-host SSH ports. Probes CANDIDATE_PORTS only when a host is not listed here.
declare -A HOST_PORT=(
  ["161.97.182.73"]=2222
  ["31.220.92.120"]=22
  ["46.250.244.184"]=22
)
CANDIDATE_PORTS=(22 2222)
SSH_USER=root
REMOTE_BASE=/opt/frogtalk
SSH_KEY="${HOME}/.ssh/id_ed25519"
# LOW-G6: `StrictHostKeyChecking=accept-new` records the host key the
# first time we see it and refuses to connect afterwards if the server's
# key changes (the actual MITM signal). `no` would silently accept *any*
# new key on every connect, defeating the protection entirely.
SSH_OPTS=(-o StrictHostKeyChecking=accept-new
          -o UserKnownHostsFile="${HOME}/.ssh/known_hosts"
          -o ConnectTimeout=5
          -o ServerAliveInterval=10
          -o BatchMode=yes
          -i "$SSH_KEY")

# Default file set if caller passed nothing. Each entry is
#   "<local_path>:<remote_path>"
# Remote paths are relative to REMOTE_BASE.
DEFAULT_FILES=(
  "node/static/index.html:node/static/index.html"
  "node/static/css/channel-settings.css:node/static/css/channel-settings.css"
  "node/static/sw.js:node/static/sw.js"
  "node/static/js/media.js:node/static/js/media.js"
  "node/static/js/messages.js:node/static/js/messages.js"
  "node/static/js/notifications.js:node/static/js/notifications.js"
  "node/static/js/dms.js:node/static/js/dms.js"
  "node/static/js/calls.js:node/static/js/calls.js"
  "node/static/js/app.js:node/static/js/app.js"
  "node/static/js/mobile_wizard.js:node/static/js/mobile_wizard.js"
  "node/static/js/ws.js:node/static/js/ws.js"
  "node/static/js/pin.js:node/static/js/pin.js"
  "node/static/js/state.js:node/static/js/state.js"
  "node/static/js/rooms.js:node/static/js/rooms.js"
  "node/static/js/ui.js:node/static/js/ui.js"
  "node/static/js/text_format.js:node/static/js/text_format.js"
  "node/static/js/format_toolbar.js:node/static/js/format_toolbar.js"
  "node/static/frogtalk-v237.apk:node/static/frogtalk-v237.apk"
  "node/static/github-build-mirror/frogtalk-v237.apk:node/static/github-build-mirror/frogtalk-v237.apk"
  "node/main.py:node/main.py"
  "node/static/partials/site-nav.html:node/static/partials/site-nav.html"
  "node/static/home.html:node/static/home.html"
  "node/static/css/downloads-picker.css:node/static/css/downloads-picker.css"
  "node/static/js/downloads-picker.js:node/static/js/downloads-picker.js"
  "node/static/FrogTalk-1.5.3.AppImage:node/static/FrogTalk-1.5.3.AppImage"
  "node/static/frogtalk_1.5.3_amd64.deb:node/static/frogtalk_1.5.3_amd64.deb"
  "node/static/FrogTalk-1.5.3-win-x64-portable.exe:node/static/FrogTalk-1.5.3-win-x64-portable.exe"
  "node/static/FrogTalk-1.5.3-win-x64.zip:node/static/FrogTalk-1.5.3-win-x64.zip"
)

# Rewrite bare `static/...`, `routers/...`, etc. → `node/...` so muscle
# memory keeps working post-restructure.
rewrite_path() {
  local p="$1"
  case "$p" in
    node/*|client/*|bot-examples/*|docs/*|github-build-mirror/*|flatpak/*)
      printf "%s" "$p" ;;
    static/*|routers/*|deploy/*|main.py|database.py|deps.py|crypto_fed.py|requirements.txt|Dockerfile|geoip.py|media_storage.py|log_redaction.py|ws_manager.py|bridge_*.py|telegram_bridge.py)
      printf "node/%s" "$p" ;;
    *)
      printf "%s" "$p" ;;
  esac
}

if [[ $# -gt 0 ]]; then
  FILES=()
  for f in "$@"; do
    if [[ "$f" == *:* ]]; then
      local_part="${f%%:*}"
      remote_part="${f##*:}"
      FILES+=("$(rewrite_path "$local_part"):$(rewrite_path "$remote_part")")
    else
      rw="$(rewrite_path "$f")"
      FILES+=("$rw:$rw")
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
  if [[ -n "${HOST_PORT[$host]:-}" ]]; then
    local pinned="${HOST_PORT[$host]}"
    if probe_port "$host" "$pinned"; then
      echo "$pinned"
      return 0
    fi
    echo "pinned port $pinned unreachable for $host" >&2
    return 1
  fi
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
  local label="${HOST_LABEL[$host]:-$host}"
  echo "=== [$label $host:$port] starting deploy ($(date +%H:%M:%S)) ==="

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
    remote_dir="${REMOTE_BASE}/$(dirname "$remote_path")"
    ssh -p "$port" "${SSH_OPTS[@]}" "${SSH_USER}@${host}" "mkdir -p '${remote_dir}'" 2>/dev/null || true
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
      echo "  ${HOST_LABEL[$host]:-$host} ($host) -> port $port"
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
