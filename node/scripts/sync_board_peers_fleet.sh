#!/usr/bin/env bash
# Refresh federated board nav pills on every fleet host (fetch /board/api/info).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/cli.sh
source "$SCRIPT_DIR/lib/cli.sh"

FLEET_FILE="$SCRIPT_DIR/deploy_fleet.local.sh"
LOCAL_FILE="$SCRIPT_DIR/deploy_nodes.local.sh"
[[ -f "$FLEET_FILE" ]] || ft_die "Missing deploy_fleet.local.sh"
[[ -f "$LOCAL_FILE" ]] && source "$LOCAL_FILE"
# shellcheck source=deploy_fleet.local.sh
source "$FLEET_FILE"

# Optional: comma-separated extra board URLs (e.g. Tor mirror from your mesh config).
TOR_EXTRA_BOARD_URLS="${FROGTALK_BOARD_SYNC_EXTRA_URLS:-}"

sync_host() {
  local host="$1" port="$2" urls="$3"
  local pass="${FLEET_SSH_PASS[$host]:-}"
  ft_step "${host}:${port} board peers"
  local -a ssh_base=(-T -p "$port" -o StrictHostKeyChecking=accept-new)
  if [[ -n "$pass" ]] && command -v sshpass >/dev/null; then
    SSHPASS="$pass" sshpass -e ssh "${ssh_base[@]}" "root@${host}" \
      "BOARD_URLS='$urls' bash -s" <"$SCRIPT_DIR/sync_board_peers_remote.sh"
  else
    ssh "${ssh_base[@]}" -o BatchMode=yes "root@${host}" \
      "BOARD_URLS='$urls' bash -s" <"$SCRIPT_DIR/sync_board_peers_remote.sh"
  fi
}

for spec in "${FLEET_HOSTS[@]:-}"; do
  [[ -n "$spec" ]] || continue
  host="${spec%%:*}"
  port="${spec##*:}"
  [[ "$host" != "$port" ]] || port=22
  case "$host" in
    31.220.92.120) urls="https://frogtalk.xyz/board/" ;;
    46.250.244.184) urls="https://frogtalk.app/board/" ;;
    161.97.182.73) urls="https://frogtalk.app/board/,https://frogtalk.xyz/board/" ;;
    *) urls="" ;;
  esac
  if [[ -n "$TOR_EXTRA_BOARD_URLS" ]]; then
    if [[ -n "$urls" ]]; then urls="${urls},${TOR_EXTRA_BOARD_URLS}"; else urls="$TOR_EXTRA_BOARD_URLS"; fi
  fi
  [[ -n "$urls" ]] || { ft_skip "${host}: set FROGTALK_BOARD_SYNC_EXTRA_URLS or edit sync_board_peers_fleet.sh"; continue; }
  sync_host "$host" "$port" "$urls" || ft_warn "${host} sync failed"
done
ft_ok "Fleet board peers synced"
