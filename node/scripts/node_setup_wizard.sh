#!/usr/bin/env bash
# FrogTalk Node — first-time setup wizard
#
#   bash node/scripts/node_setup_wizard.sh
#   bash node/scripts/node_setup_wizard.sh --install-dir /opt/frogtalk -y
#
set -u
set -o pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/cli.sh
source "$SCRIPT_DIR/lib/cli.sh"

PROJECT_REPO_DEFAULT="https://github.com/deadinternetfox/frogtalk.git"
INSTALL_DIR_DEFAULT="/opt/frogtalk"
ENV_TEMPLATE="node/deploy/env.example"
ENV_FILE=".env"
ASSUME_YES=0
INSTALL_DIR_ARG=""
PUBLIC_URL_ARG=""

usage() {
  ft_banner "Setup wizard" "venv · .env · federation-ready defaults"
  cat <<EOF
${C_BOLD}Usage:${C_RESET} bash node/scripts/node_setup_wizard.sh [options]

  --install-dir PATH   Target install root (default: ${INSTALL_DIR_DEFAULT})
  --public-url URL     Clearnet URL (or set PUBLIC_URL env before -y)
  -y, --yes             Accept defaults (including federation join)
  -h, --help            This help

${C_BOLD}Or use the menu:${C_RESET} bash node/scripts/install.sh
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      -y|--yes) ASSUME_YES=1; export FT_ASSUME_YES=1; shift ;;
      --install-dir) INSTALL_DIR_ARG="${2:-}"; shift 2 ;;
      --public-url) PUBLIC_URL_ARG="${2:-}"; shift 2 ;;
      *) ft_die "Unknown option: $1" ;;
    esac
  done
}

safe_run() {
  local desc="$1"
  shift
  ft_info "$desc"
  if "$@"; then
    ft_ok "$desc"
    return 0
  fi
  ft_warn "$desc failed — continuing."
  return 1
}

gen_password() {
  python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(24))
PY
}

main() {
  parse_args "$@"
  ft_guard_noninteractive_stdin
  clear 2>/dev/null || true
  ft_banner "Node Setup Wizard" "First-time self-host install"

  local missing=0
  ft_require_cmd git || missing=1
  ft_require_cmd python3 || missing=1
  ft_require_cmd sed || missing=1
  [[ "$missing" -eq 0 ]] || ft_die "Install git, python3, sed and re-run."

  local repo_url install_dir public_url admin_password
  local repo_hint
  repo_hint="$(cd "$SCRIPT_DIR/../.." && pwd)"
  repo_url="$(ft_ask "Git repository URL" "$PROJECT_REPO_DEFAULT")"
  if [[ -n "$INSTALL_DIR_ARG" ]]; then
    install_dir="$INSTALL_DIR_ARG"
  else
    local default_dir
    default_dir="$(ft_resolve_install_dir "$INSTALL_DIR_DEFAULT" "$repo_hint")"
    install_dir="$(ft_ask "Install directory" "$default_dir")"
  fi

  if [[ -d "$install_dir/.git" ]]; then
    ft_info "Existing repo at $install_dir"
    if [[ "$ASSUME_YES" -eq 1 ]]; then
      ft_skip "Git update skipped in -y mode (run: bash node/scripts/install.sh update-apply -y)"
    elif ft_ask_yes_no "Check for git updates and pull (fast-forward)?" "y"; then
      local upd_args=(--install-dir "$install_dir" --apply --skip-federation-hint)
      if bash "$SCRIPT_DIR/node_update_check.sh" "${upd_args[@]}"; then
        ft_ok "Repository up to date or updated"
      else
        ft_warn "Update step had issues — retry: bash node/scripts/install.sh update-apply"
      fi
    fi
  else
    safe_run "git clone" git clone "$repo_url" "$install_dir" || ft_die "Clone failed."
  fi

  cd "$install_dir" || ft_die "Cannot enter $install_dir"

  safe_run "python3 -m venv venv" python3 -m venv venv
  # shellcheck disable=SC1091
  [[ -f venv/bin/activate ]] && source venv/bin/activate

  safe_run "pip upgrade" python3 -m pip install --upgrade pip -q
  [[ -f node/requirements.txt ]] \
    && safe_run "pip install -r node/requirements.txt" python3 -m pip install -r node/requirements.txt -q \
    || ft_warn "node/requirements.txt missing — skipped deps."

  ft_step "Runtime symlinks"
  if [[ -d node/data && ! -L node/data ]]; then
    ft_warn "node/data is a real directory — app may use an empty DB."
    if ft_ask_yes_no "Replace with symlink to $install_dir/data?" "y"; then
      ts="$(date +%Y%m%d-%H%M%S)"
      mv node/data "node/data.misplaced-${ts}"
      ft_ok "Moved aside → node/data.misplaced-${ts}"
    fi
  fi
  ft_ensure_runtime_symlinks "$install_dir" && ft_ok "node/data · node/.env · node/secrets" \
    || ft_warn "Symlink setup incomplete"

  if [[ -d node/board/board_data ]] && id www-data >/dev/null 2>&1; then
    chown -R www-data:www-data node/board/board_data node/board/board_uploads node/board/board_previews 2>/dev/null || true
    ft_ok "board_data owned by www-data (php-fpm)"
  fi

  ft_step "Frog Channel (imageboard)"
  local board_nginx_ok=0
  if [[ "$(id -u)" -eq 0 ]] && command -v nginx >/dev/null 2>&1; then
    if [[ "$ASSUME_YES" -eq 1 ]] || ft_ask_yes_no "Configure nginx + PHP for /board/ (Frog Channel)?" "y"; then
      if command -v apt-get >/dev/null 2>&1; then
        safe_run "apt install php-fpm php-curl nginx" \
          apt-get install -y -qq php-fpm php-curl nginx 2>/dev/null
      fi
      if bash "$install_dir/node/scripts/install_board_nginx.sh" --install-dir "$install_dir"; then
        board_nginx_ok=1
      fi
    fi
  elif [[ "$ASSUME_YES" -eq 1 ]]; then
    ft_warn "Board HTTP needs root once: sudo apt install nginx php-fpm php-curl && sudo bash node/scripts/install_board_nginx.sh --install-dir $install_dir"
  else
    ft_info "Optional: sudo bash node/scripts/install_board_nginx.sh --install-dir $install_dir (nginx + PHP for /board/)"
  fi

  ft_step "Environment (.env)"
  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ -f "$ENV_TEMPLATE" ]]; then
      cp "$ENV_TEMPLATE" "$ENV_FILE"
      ft_ok "Created .env from template"
    else
      : >"$ENV_FILE"
      ft_warn "No template — blank .env"
    fi
  fi

  local default_pub="${PUBLIC_URL_ARG:-${PUBLIC_URL:-http://localhost:8080}}"
  public_url="$(ft_ask "Public URL (https://… or http://YOUR_IP)" "$default_pub")"
  public_url="${public_url%/}"
  admin_password="$(ft_ask "Admin password (blank = auto-generate)" "")"
  [[ -n "$admin_password" ]] || admin_password="$(gen_password)" && ft_info "Generated admin password (saved in .env)."

  local server_name="${FROGTALK_SERVER_NAME:-}"
  if [[ -z "$server_name" ]]; then
    if [[ "$ASSUME_YES" -eq 1 ]]; then
      server_name="FrogTalk Node"
    else
      server_name="$(ft_ask "Node display name (federation directory)" "FrogTalk Node")"
    fi
  fi

  ft_set_env_value "$ENV_FILE" "ADMIN_PASSWORD" "$admin_password"
  ft_set_env_value "$ENV_FILE" "PUBLIC_URL" "$public_url"
  ft_set_env_value "$ENV_FILE" "FROGTALK_BASE_URL" "$public_url"
  ft_set_env_value "$ENV_FILE" "FROGTALK_SERVER_NAME" "$server_name"
  ft_set_env_value "$ENV_FILE" "HOST" "127.0.0.1"
  ft_set_env_value "$ENV_FILE" "PORT" "8080"
  ft_set_env_value "$ENV_FILE" "ALLOWED_ORIGINS" "${public_url},http://localhost:8080"
  ft_set_env_value "$ENV_FILE" "FROGTALK_FEDERATION_ENABLED" "1"
  ft_set_env_value "$ENV_FILE" "FROGTALK_FEDERATION_REQUIRE_SIGS" "1"
  ft_set_env_value "$ENV_FILE" "FROGTALK_OFFICIAL_DIRECTORY_URL" "https://frogtalk.xyz/api/network/servers"
  local fed_token="${FROGTALK_FEDERATION_TOKEN:-}"
  if [[ -z "$fed_token" ]] && [[ "$ASSUME_YES" -eq 0 ]]; then
    ft_info "Hub listing: set the same token on FrogTalk Main and this node (openssl rand -hex 32)."
    fed_token="$(ft_ask "FROGTALK_FEDERATION_TOKEN (blank = skip auto-list on frogtalk.xyz)" "")"
  fi
  if [[ -n "$fed_token" ]]; then
    ft_set_env_value "$ENV_FILE" "FROGTALK_FEDERATION_TOKEN" "$fed_token"
  elif [[ "$ASSUME_YES" -eq 1 ]]; then
    ft_warn "FROGTALK_FEDERATION_TOKEN unset — peers sync locally but this node won't appear on frogtalk.xyz until the token matches Main and you re-run: bash node/scripts/install.sh federation -y"
  fi
  ft_set_env_value "$ENV_FILE" "FROGTALK_AUTO_UPDATE_ENABLED" "0"
  ft_set_env_value "$ENV_FILE" "FROGTALK_UPDATE_CHECK_INTERVAL_SEC" "300"
  ft_set_env_value "$ENV_FILE" "FROGTALK_UPDATE_FEED_URL" "https://frogtalk.xyz/api/network/updates/latest"
  ft_set_env_value "$ENV_FILE" "FROGTALK_TOR_SOCKS_PROXY" "socks5h://127.0.0.1:9050"

  if ft_ask_yes_no "Enable Tor / onion mode?" "n"; then
    local onion_url
    onion_url="$(ft_ask "Onion URL (http://….onion)" "")"
    if [[ -n "$onion_url" ]]; then
      onion_url="${onion_url%/}"
      ft_set_env_value "$ENV_FILE" "FROGTALK_TOR_ENABLED" "1"
      ft_set_env_value "$ENV_FILE" "FROGTALK_ONION_URL" "$onion_url"
      ft_ok "Tor mode configured"
    fi
  fi

  ft_ensure_deploy_ownership "$install_dir"

  if [[ "$board_nginx_ok" -eq 1 ]] && [[ "$(id -u)" -eq 0 ]] && [[ "$public_url" == http://* ]]; then
    if [[ "$ASSUME_YES" -eq 1 ]] || ft_ask_yes_no "Enable HTTPS (self-signed for IP; Let's Encrypt if you use a domain)?" "y"; then
      bash "$install_dir/node/scripts/install_node_ssl.sh" --install-dir "$install_dir" -y \
        && public_url="$(grep -E '^PUBLIC_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")" \
        && ft_ok "HTTPS configured → ${public_url}" \
        || ft_warn "SSL step failed — retry: sudo bash node/scripts/install.sh ssl -y"
    fi
  fi

  if [[ -f "$install_dir/node/board/board_data/settings.json" ]]; then
    FT_INSTALL_DIR="$install_dir" bash "$install_dir/node/scripts/configure_board_identity.sh" --install-dir "$install_dir" \
      && ft_ok "Board title synced from node name" \
      || ft_warn "Board identity step skipped"
  fi

  if ft_ask_yes_no "Join FrogTalk federation mesh now? (recommended)" "y"; then
    ft_info "Running federation join…"
    local fed_args=(--install-dir "$install_dir" -y --public-url "$public_url")
    [[ "$board_nginx_ok" -eq 0 ]] && fed_args+=(--skip-restart)
    if bash "$install_dir/node/scripts/node_federation_join.sh" "${fed_args[@]}"; then
      ft_ok "Federation mesh linked"
    else
      ft_warn "Federation join had issues — retry: bash node/scripts/install.sh federation"
    fi
  fi

  if ft_ask_yes_no "Install systemd unit (frogtalk.service)?" "n"; then
    if bash "$install_dir/node/scripts/install.sh" systemd --install-dir "$install_dir" -y; then
      ft_ok "systemd configured"
    else
      ft_warn "systemd step skipped or failed"
    fi
  fi

  ft_success_banner "Setup complete."
  ft_say "  ${C_BOLD}Install:${C_RESET}  ${install_dir}"
  ft_say "  ${C_BOLD}Config:${C_RESET}   ${install_dir}/${ENV_FILE}"
  ft_say "  ${C_BOLD}Run dev:${C_RESET}   cd ${install_dir} && source venv/bin/activate && cd node && python main.py"
  ft_say "  ${C_BOLD}Menu:${C_RESET}     bash node/scripts/install.sh --install-dir ${install_dir}"
  ft_say "  ${C_BOLD}Updates:${C_RESET}  bash node/scripts/install.sh update-apply --install-dir ${install_dir}"
  ft_blank
}

main "$@"
