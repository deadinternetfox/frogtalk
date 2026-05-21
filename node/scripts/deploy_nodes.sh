#!/usr/bin/env bash
# Maintainer tool: SCP hotfixes to hosts in deploy_fleet.local.sh (gitignored).
# Normal installs use install.sh setup + federation — not this script.
#
#   cp node/scripts/deploy_fleet.local.example.sh node/scripts/deploy_fleet.local.sh
#   node/scripts/deploy_nodes.sh                    # default file bundle
#   node/scripts/deploy_nodes.sh node/routers/federation.py
#
# Local paths live under node/; remote tree is /opt/frogtalk/node/.
# Bare static/... or routers/... args are rewritten to node/... automatically.
#
# Related: deploy.sh (single-host rsync), deploy_board.sh (PHP board only)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

FLEET_FILE="$SCRIPT_DIR/deploy_fleet.local.sh"
if [[ ! -f "$FLEET_FILE" ]]; then
  echo "Maintainer fleet config missing." >&2
  echo "  cp node/scripts/deploy_fleet.local.example.sh node/scripts/deploy_fleet.local.sh" >&2
  echo "  Edit FLEET_HOSTS=( \"host:port\" … ) — never commit IPs or passwords." >&2
  exit 1
fi
# shellcheck source=deploy_fleet.local.sh
source "$FLEET_FILE"
[[ -f "$SCRIPT_DIR/deploy_nodes.local.sh" ]] && source "$SCRIPT_DIR/deploy_nodes.local.sh"

HOSTS=()
declare -A HOST_PORT HOST_SSH_PASS HOST_LABEL
for spec in "${FLEET_HOSTS[@]:-}"; do
  [[ -n "$spec" ]] || continue
  host="${spec%%:*}"
  port="${spec##*:}"
  [[ "$host" != "$port" ]] || port=22
  HOSTS+=("$host")
  HOST_PORT["$host"]="$port"
  if [[ -n "${FLEET_SSH_PASS["$host"]:-}" ]]; then
    HOST_SSH_PASS["$host"]="${FLEET_SSH_PASS["$host"]}"
  fi
  HOST_LABEL["$host"]="$host"
  if declare -p FLEET_HOST_LABEL &>/dev/null; then
    for _lk in "${!FLEET_HOST_LABEL[@]}"; do
      if [[ "$_lk" == "$host" ]]; then
        HOST_LABEL["$host"]="${FLEET_HOST_LABEL[$_lk]}"
        break
      fi
    done
  fi
done
[[ ${#HOSTS[@]} -gt 0 ]] || { echo "FLEET_HOSTS is empty in deploy_fleet.local.sh" >&2; exit 1; }

CANDIDATE_PORTS=(22 2222)
SSH_USER="${FLEET_SSH_USER:-root}"
REMOTE_BASE=/opt/frogtalk
SSH_KEY="${FLEET_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_BASE_OPTS=(-o StrictHostKeyChecking=accept-new
              -o UserKnownHostsFile="${HOME}/.ssh/known_hosts"
              -o ConnectTimeout=5
              -o ServerAliveInterval=10)
SSH_OPTS=("${SSH_BASE_OPTS[@]}" -o BatchMode=yes -i "$SSH_KEY")

host_uses_password() {
  [[ -n "${HOST_SSH_PASS[$1]:-}" ]]
}

require_sshpass() {
  command -v sshpass >/dev/null 2>&1 || {
    echo "sshpass required for password SSH (e.g. FrogTalk AUS). Install: apt install sshpass" >&2
    return 1
  }
}

remote_ssh() {
  local host="$1" port="$2"
  shift 2
  if host_uses_password "$host"; then
    require_sshpass || return 1
    SSHPASS="${HOST_SSH_PASS[$host]}" sshpass -e ssh -p "$port" "${SSH_BASE_OPTS[@]}" \
      "${SSH_USER}@${host}" "$@"
  else
    ssh -p "$port" "${SSH_OPTS[@]}" "${SSH_USER}@${host}" "$@"
  fi
}

remote_scp() {
  local host="$1" port="$2" src="$3" dest="$4"
  if host_uses_password "$host"; then
    require_sshpass || return 1
    SSHPASS="${HOST_SSH_PASS[$host]}" sshpass -e scp -q -P "$port" "${SSH_BASE_OPTS[@]}" \
      "$src" "${SSH_USER}@${host}:${dest}"
  else
    scp -q -P "$port" "${SSH_OPTS[@]}" "$src" "${SSH_USER}@${host}:${dest}"
  fi
}

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
  "node/geoip.py:node/geoip.py"
  "node/database.py:node/database.py"
  "node/routers/federation.py:node/routers/federation.py"
  "node/routers/server_admin.py:node/routers/server_admin.py"
  "node/static/js/server_admin.js:node/static/js/server_admin.js"
  "node/scripts/install.sh:node/scripts/install.sh"
  "node/scripts/install_board_nginx.sh:node/scripts/install_board_nginx.sh"
  "node/scripts/install_node_ssl.sh:node/scripts/install_node_ssl.sh"
  "node/scripts/node_setup_wizard.sh:node/scripts/node_setup_wizard.sh"
  "node/scripts/node_federation_join.sh:node/scripts/node_federation_join.sh"
  "node/scripts/configure_board_identity.sh:node/scripts/configure_board_identity.sh"
  "node/scripts/lib/cli.sh:node/scripts/lib/cli.sh"
  "node/static/partials/site-nav.html:node/static/partials/site-nav.html"
  "node/static/home.html:node/static/home.html"
  "node/static/css/home.css:node/static/css/home.css"
  "node/static/js/home-vibe-banner.js:node/static/js/home-vibe-banner.js"
  "node/static/docs-api.html:node/static/docs-api.html"
  "node/static/css/docs-api.css:node/static/css/docs-api.css"
  "node/static/docs-node.html:node/static/docs-node.html"
  "node/static/css/docs-node.css:node/static/css/docs-node.css"
  "node/static/privacy.html:node/static/privacy.html"
  "node/static/css/privacy.css:node/static/css/privacy.css"
  "node/static/security.html:node/static/security.html"
  "node/static/css/security.css:node/static/css/security.css"
  "node/static/js/security.js:node/static/js/security.js"
  "node/static/ios.html:node/static/ios.html"
  "node/static/css/ios.css:node/static/css/ios.css"
  "node/static/js/ios.js:node/static/js/ios.js"
  "node/static/css/site-nav.css:node/static/css/site-nav.css"
  "node/static/js/site-nav.js:node/static/js/site-nav.js"
  "node/static/css/site-footer.css:node/static/css/site-footer.css"
  "node/static/js/site-footer.js:node/static/js/site-footer.js"
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
  remote_ssh "$host" "$port" true 2>/dev/null
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
    remote_ssh "$host" "$port" "mkdir -p '${remote_dir}'" 2>/dev/null || true
    if remote_scp "$host" "$port" \
        "$local_path" \
        "${REMOTE_BASE}/${remote_path}"; then
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
  if remote_ssh "$host" "$port" \
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
    if [[ "${FT_DEPLOY_SKIP_UNREACHABLE:-0}" == "1" ]]; then
      echo "Warning: ${failures} host(s) unreachable — deploying to reachable hosts only." >&2
    else
      echo "Aborting: ${failures} host(s) unreachable (set FT_DEPLOY_SKIP_UNREACHABLE=1 to skip)." >&2
      exit 2
    fi
  fi

  echo
  echo "--- Deploying (sequential per host, restart at end) ---"
  for host in "${HOSTS[@]}"; do
    if [[ -z "${PORT_FOR[$host]:-}" ]]; then
      echo "Skipping $host (unreachable)."
      continue
    fi
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
