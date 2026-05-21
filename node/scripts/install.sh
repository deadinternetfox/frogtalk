#!/usr/bin/env bash
# FrogTalk Node — unified installer menu
#
#   bash node/scripts/install.sh              # interactive menu
#   bash node/scripts/install.sh setup        # first-time wizard
#   bash node/scripts/install.sh federation   # join mesh (directory + board)
#   bash node/scripts/install.sh update       # check for git updates
#   bash node/scripts/install.sh update-apply # pull + restart
#   bash node/scripts/install.sh status       # quick health check
#
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/cli.sh
source "$SCRIPT_DIR/lib/cli.sh"

INSTALL_DIR_DEFAULT="/opt/frogtalk"
INSTALL_DIR=""
ASSUME_YES=0
CMD=""
PUBLIC_URL_ARG=""
ONION_URL_ARG=""

usage() {
  ft_banner "FrogTalk Node Installer" "Self-host setup · federation · updates"
  cat <<EOF
${C_BOLD}Usage:${C_RESET}
  bash node/scripts/install.sh                 Interactive menu
  bash node/scripts/install.sh <command>     Run one step

${C_BOLD}Commands:${C_RESET}
  setup          First-time install (venv, .env, symlinks)
  federation     Join official mesh (chat + board nav)
  update         Check for git updates
  update-apply   Pull latest + deps + restart
  systemd        Install/enable frogtalk.service
  status         API ping + federation peers
  help           This help

${C_BOLD}Options:${C_RESET}
  --install-dir PATH   Install root (default: ${INSTALL_DIR_DEFAULT})
  --public-url URL     Clearnet URL (federation / setup; or PUBLIC_URL env)
  --onion-url URL      Onion URL (federation join)
  -y, --yes            Non-interactive defaults
  -h, --help
EOF
}

parse_global_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      -y|--yes) ASSUME_YES=1; export FT_ASSUME_YES=1; shift ;;
      --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
      --public-url) PUBLIC_URL_ARG="${2:-}"; shift 2 ;;
      --onion-url) ONION_URL_ARG="${2:-}"; shift 2 ;;
      setup|federation|update|update-apply|systemd|status|help|menu)
        [[ -n "$CMD" ]] && ft_die "Multiple commands: $CMD and $1"
        CMD="$1"; shift ;;
      *)
        ft_die "Unknown argument: $1 (try: bash node/scripts/install.sh help)"
        ;;
    esac
  done
}

resolve_install() {
  if [[ -n "$INSTALL_DIR" ]]; then
    INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)" || ft_die "Bad install dir: $INSTALL_DIR"
  elif [[ -d "$INSTALL_DIR_DEFAULT" ]]; then
    INSTALL_DIR="$(cd "$INSTALL_DIR_DEFAULT" && pwd)"
  elif [[ -f "$SCRIPT_DIR/../main.py" ]]; then
    INSTALL_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
  else
    INSTALL_DIR="$(ft_ask "Install directory" "$INSTALL_DIR_DEFAULT")"
    INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)" || ft_die "Cannot use $INSTALL_DIR"
  fi
  export FT_INSTALL_DIR="$INSTALL_DIR"
}

run_setup() {
  local args=()
  [[ -n "$INSTALL_DIR" ]] && args+=(--install-dir "$INSTALL_DIR")
  [[ "$ASSUME_YES" -eq 1 ]] && args+=(-y)
  [[ -n "$PUBLIC_URL_ARG" ]] && args+=(--public-url "$PUBLIC_URL_ARG")
  exec bash "$SCRIPT_DIR/node_setup_wizard.sh" "${args[@]}"
}

run_federation() {
  local args=(--install-dir "$INSTALL_DIR")
  [[ "$ASSUME_YES" -eq 1 ]] && args+=(-y)
  [[ -n "$PUBLIC_URL_ARG" ]] && args+=(--public-url "$PUBLIC_URL_ARG")
  [[ -n "$ONION_URL_ARG" ]] && args+=(--onion-url "$ONION_URL_ARG")
  exec bash "$SCRIPT_DIR/node_federation_join.sh" "${args[@]}"
}

run_update() {
  local args=(--install-dir "$INSTALL_DIR")
  [[ "$ASSUME_YES" -eq 1 ]] && args+=(-y)
  exec bash "$SCRIPT_DIR/node_update_check.sh" "${args[@]}"
}

run_systemd() {
  ft_banner "Install systemd unit" "$INSTALL_DIR"
  local unit_src="$INSTALL_DIR/node/deploy/frogtalk.service"
  [[ -f "$unit_src" ]] || ft_die "Missing $unit_src — run setup first."
  ft_require_cmd systemctl
  local cp_cmd=(cp) systemctl_cmd=(systemctl)
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    ft_require_cmd sudo
    cp_cmd=(sudo cp)
    systemctl_cmd=(sudo systemctl)
  fi
  if [[ "$ASSUME_YES" -eq 0 ]] && ! ft_ask_yes_no "Install unit to /etc/systemd/system/frogtalk.service?" "y"; then
    exit 0
  fi
  "${cp_cmd[@]}" "$unit_src" /etc/systemd/system/frogtalk.service
  "${systemctl_cmd[@]}" daemon-reload
  "${systemctl_cmd[@]}" enable frogtalk
  if ft_ask_yes_no "Start frogtalk now?" "y"; then
    "${systemctl_cmd[@]}" restart frogtalk
    sleep 2
    "${systemctl_cmd[@]}" is-active frogtalk >/dev/null && ft_ok "frogtalk.service active" \
      || ft_warn "Not active — journalctl -u frogtalk -n 40"
  else
    ft_ok "Unit enabled (not started)"
  fi
}

run_status() {
  ft_banner "Node status" "$INSTALL_DIR"
  ft_load_env_file "$INSTALL_DIR/.env"
  local port
  port="$(ft_detect_api_port "$INSTALL_DIR")"
  if curl -sf -m 5 "http://127.0.0.1:${port}/api/ping" >/dev/null 2>&1; then
    ft_ok "API http://127.0.0.1:${port}/api/ping"
  else
    ft_warn "API not responding (port ${port})"
  fi
  [[ -f "$INSTALL_DIR/venv/bin/python" && -f "$INSTALL_DIR/node/main.py" ]] \
    && ft_ok "Install layout OK" || ft_warn "Run: bash node/scripts/install.sh setup"
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active frogtalk >/dev/null 2>&1; then
    ft_ok "systemd: frogtalk active"
  fi
  ft_step "Federation peers"
  if [[ -f "$INSTALL_DIR/data/frogtalk.db" ]]; then
    sqlite3 "$INSTALL_DIR/data/frogtalk.db" \
      "SELECT server_id||' enabled='||enabled||' pubkey='||length(COALESCE(server_pubkey,'')) FROM federation_servers;" 2>/dev/null \
      | while read -r line; do [[ -n "$line" ]] && ft_detail "$line"; done
  else
    ft_skip "No DB yet"
  fi
  ft_detail "Re-sync: bash node/scripts/install.sh federation -y"
  ft_step "Git updates"
  if command -v git >/dev/null 2>&1 && [[ -d "$INSTALL_DIR/.git" ]]; then
    local behind
    behind="$(ft_git_behind_upstream "$INSTALL_DIR" 2>/dev/null || echo 0)"
    if [[ "${behind:-0}" -eq 0 ]]; then
      ft_ok "Git: up to date with upstream"
    else
      ft_warn "Git: ${behind} commit(s) behind — bash node/scripts/install.sh update-apply"
    fi
  else
    ft_skip "Not a git checkout"
  fi
}

show_menu() {
  resolve_install
  clear 2>/dev/null || true
  ft_banner "FrogTalk Node Installer" "$INSTALL_DIR"
  ft_say "  ${C_CYAN}1)${C_RESET}  Setup        — venv, .env, symlinks"
  ft_say "  ${C_CYAN}2)${C_RESET}  Federation   — join frogtalk.xyz mesh"
  ft_say "  ${C_CYAN}3)${C_RESET}  Update       — check for new commits"
  ft_say "  ${C_CYAN}4)${C_RESET}  Apply update — git pull + restart"
  ft_say "  ${C_CYAN}5)${C_RESET}  systemd      — install service unit"
  ft_say "  ${C_CYAN}6)${C_RESET}  Status       — health check"
  ft_say "  ${C_CYAN}q)${C_RESET}  Quit"
  ft_blank
  case "$(ft_ask "Choice" "1")" in
    1) run_setup ;;
    2) run_federation ;;
    3) run_update ;;
    4) run_update --apply ;;
    5) run_systemd ;;
    6) run_status ;;
    q|Q) exit 0 ;;
    *) ft_warn "Invalid choice"; show_menu ;;
  esac
}

main() {
  parse_global_args "$@"
  [[ "$ASSUME_YES" -eq 1 ]] && ft_guard_noninteractive_stdin
  case "${CMD:-}" in
    ""|menu) show_menu ;;
    help) usage ;;
    setup)
      [[ -n "$INSTALL_DIR" ]] && resolve_install || INSTALL_DIR=""
      run_setup
      ;;
    federation)
      resolve_install
      run_federation "$@"
      ;;
    update|update-apply)
      resolve_install
      if [[ "$CMD" == "update-apply" ]]; then
        run_update --apply
      else
        run_update
      fi
      ;;
    systemd)
      resolve_install
      run_systemd
      ;;
    status)
      resolve_install
      run_status
      ;;
    *)
      ft_die "Unknown command: $CMD"
      ;;
  esac
}

main "$@"
