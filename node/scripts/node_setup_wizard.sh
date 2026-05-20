#!/usr/bin/env bash
# Interactive FrogTalk node setup wizard.
#
# Goals:
# - fast first-time self-host setup
# - defensive defaults
# - non-fatal fallbacks for common edge cases
#
# Run:
#   bash node/scripts/node_setup_wizard.sh

set -u
set -o pipefail
umask 077

PROJECT_REPO_DEFAULT="https://github.com/deadinternetfox/frogtalk.git"
INSTALL_DIR_DEFAULT="/opt/frogtalk"
# Paths are resolved relative to $install_dir/node after clone.
ENV_TEMPLATE="node/deploy/env.example"
ENV_FILE=".env"

C_RESET=$'\033[0m'
C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'
C_BLUE=$'\033[34m'
C_RED=$'\033[31m'

say()  { printf "%s\n" "$*"; }
info() { printf "%s[info]%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf "%s[ok]%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf "%s[warn]%s %s\n" "$C_YELLOW" "$C_RESET" "$*"; }
err()  { printf "%s[err]%s %s\n" "$C_RED" "$C_RESET" "$*"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    return 1
  fi
  return 0
}

ask() {
  local prompt="$1"
  local default="${2:-}"
  local answer=""
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " answer
    printf "%s" "${answer:-$default}"
  else
    read -r -p "$prompt: " answer
    printf "%s" "$answer"
  fi
}

ask_yes_no() {
  local prompt="$1"
  local default="${2:-y}"
  local answer
  if [[ "$default" == "y" ]]; then
    answer="$(ask "$prompt (Y/n)" "y")"
  else
    answer="$(ask "$prompt (y/N)" "n")"
  fi
  [[ "$answer" =~ ^[Yy]$ ]]
}

safe_run() {
  local desc="$1"
  shift
  info "$desc"
  if "$@"; then
    ok "$desc"
    return 0
  fi
  warn "$desc failed, skipping."
  return 1
}

set_env_value() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf "\n%s=%s\n" "$key" "$value" >>"$file"
  fi
}

gen_password() {
  python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(24))
PY
}

main() {
  clear || true
  say "==============================================="
  say "  FrogTalk Node Setup Wizard"
  say "==============================================="
  say

  local missing=0
  require_cmd git || missing=1
  require_cmd python3 || missing=1
  require_cmd sed || missing=1
  if [[ "$missing" -ne 0 ]]; then
    err "Install missing dependencies and run again."
    exit 1
  fi

  local repo_url install_dir public_url admin_password
  repo_url="$(ask "Git repository URL" "$PROJECT_REPO_DEFAULT")"
  install_dir="$(ask "Install directory" "$INSTALL_DIR_DEFAULT")"
  public_url="$(ask "Public URL (https://... or http://...)" "http://localhost:8080")"
  admin_password="$(ask "Admin password (leave blank to auto-generate)" "")"
  if [[ -z "$admin_password" ]]; then
    admin_password="$(gen_password)"
    info "Generated strong admin password."
  fi

  if [[ -d "$install_dir/.git" ]]; then
    info "Existing git repo found in $install_dir"
    if ask_yes_no "Pull latest changes in existing repo?" "y"; then
      safe_run "Pulling latest code" git -C "$install_dir" pull --ff-only
    fi
  else
    safe_run "Cloning repository" git clone "$repo_url" "$install_dir" || {
      err "Clone failed. Exiting."
      exit 1
    }
  fi

  cd "$install_dir" || {
    err "Cannot enter install directory: $install_dir"
    exit 1
  }

  safe_run "Creating Python virtualenv" python3 -m venv venv
  # shellcheck disable=SC1091
  if [[ -f venv/bin/activate ]]; then
    # shellcheck source=/dev/null
    source venv/bin/activate
    ok "Virtualenv activated"
  else
    warn "Virtualenv activation script missing; pip steps may fail."
  fi

  safe_run "Upgrading pip" python3 -m pip install --upgrade pip
  if [[ -f node/requirements.txt ]]; then
    safe_run "Installing Python dependencies" python3 -m pip install -r node/requirements.txt
  else
    warn "node/requirements.txt not found; skipping dependency install."
  fi

  # Symlinks so runtime data/, secrets/, .env live at $install_dir root
  # but the node process (cwd=$install_dir/node) can still reach them.
  mkdir -p data
  if [[ -d node/data && ! -L node/data ]]; then
    warn "node/data is a real directory (not a symlink). Move it aside and link to $install_dir/data or the app will use an empty DB."
    if ask_yes_no "Replace node/data with symlink to $install_dir/data now?" "y"; then
      ts="$(date +%Y%m%d-%H%M%S)"
      mv node/data "node/data.misplaced-${ts}"
      ok "Moved node/data -> node/data.misplaced-${ts}"
    fi
  fi
  ln -sfn "$install_dir/data"    node/data
  ln -sfn "$install_dir/.env"    node/.env 2>/dev/null || true
  [[ -d secrets ]] && ln -sfn "$install_dir/secrets" node/secrets

  # board_data must be writable by php-fpm (usually www-data).
  if [[ -d node/board/board_data ]]; then
    if id www-data >/dev/null 2>&1; then
      chown -R www-data:www-data node/board/board_data node/board/board_uploads node/board/board_previews 2>/dev/null || true
    fi
  fi

  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ -f "$ENV_TEMPLATE" ]]; then
      safe_run "Creating .env from template" cp "$ENV_TEMPLATE" "$ENV_FILE"
    else
      warn "Env template not found; creating blank .env"
      : >"$ENV_FILE"
    fi
  fi

  set_env_value "$ENV_FILE" "ADMIN_PASSWORD" "$admin_password"
  set_env_value "$ENV_FILE" "PUBLIC_URL" "$public_url"
  set_env_value "$ENV_FILE" "FROGTALK_FEDERATION_ENABLED" "1"
  set_env_value "$ENV_FILE" "FROGTALK_FEDERATION_REQUIRE_SIGS" "1"
  set_env_value "$ENV_FILE" "FROGTALK_AUTO_UPDATE_ENABLED" "0"
  set_env_value "$ENV_FILE" "FROGTALK_UPDATE_CHECK_INTERVAL_SEC" "300"
  set_env_value "$ENV_FILE" "FROGTALK_UPDATE_FEED_URL" "https://frogtalk.xyz/api/network/updates/latest"

  if ask_yes_no "Enable onion/Tor mode now?" "n"; then
    local onion_url
    onion_url="$(ask "Onion URL (http://xxxxxxxx.onion)" "")"
    if [[ -n "$onion_url" ]]; then
      set_env_value "$ENV_FILE" "FROGTALK_TOR_ENABLED" "1"
      set_env_value "$ENV_FILE" "FROGTALK_ONION_URL" "$onion_url"
      ok "Tor mode configured in .env"
    else
      warn "No onion URL entered; Tor mode skipped."
    fi
  fi

  if ask_yes_no "Join the FrogTalk federation mesh now (chat + board nav)?" "y"; then
    info "Running federation join CLI…"
  if bash "$install_dir/node/scripts/node_federation_join.sh" --install-dir "$install_dir" -y --skip-restart; then
      ok "Federation join finished"
    else
      warn "Federation join had issues — re-run: bash node/scripts/node_federation_join.sh"
    fi
  fi

  cat <<EOF

===============================================
Setup complete.
===============================================
Install dir: $install_dir
Env file:    $install_dir/$ENV_FILE
Runtime:     $install_dir/node/

Start manually:
  cd "$install_dir"
  source venv/bin/activate
  cd node && python main.py

Join federation (chat directory + board pills):
  bash node/scripts/node_federation_join.sh --install-dir "$install_dir" -y

Optional systemd:
  sudo cp node/deploy/frogtalk.service /etc/systemd/system/frogtalk.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now frogtalk

Node updates:
  bash node/scripts/node_update_check.sh
===============================================
EOF
}

main "$@"
