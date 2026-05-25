#!/usr/bin/env bash
# Generate a v3 Tor hidden-service vanity hostname (e.g. frogtalk*.onion) and optionally
# install it for FrogTalk on this VPS.
#
#   bash node/scripts/tor_vanity_onion.sh --prefix frogtalk
#   bash node/scripts/tor_vanity_onion.sh --prefix frogta --threads 4 --apply
#   bash node/scripts/tor_vanity_onion.sh --apply --onion http://frogtalkabc….onion  # skip generation
#
# Requires: tor, build tools for mkp224o (or MKP224O_BIN). Run as root for --apply.
# Vanity search time grows quickly with prefix length; "frogtalk" (8 chars) may take days on CPU.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/cli.sh
source "$SCRIPT_DIR/lib/cli.sh"

INSTALL_DIR="${FT_INSTALL_DIR:-/opt/frogtalk}"
PREFIX="frogtalk"
THREADS="${FT_VANITY_THREADS:-$(nproc 2>/dev/null || echo 2)}"
WORK_DIR="${FT_VANITY_WORK_DIR:-/var/lib/frogtalk/tor-vanity}"
HS_NAME="frogtalk"
HS_DIR="/var/lib/tor/${HS_NAME}_hs"
APP_PORT="${FT_APP_PORT:-8080}"
APPLY=0
ONION_URL=""
MKP224O_BIN="${MKP224O_BIN:-}"

usage() {
  cat <<'EOF'
Usage: tor_vanity_onion.sh [options]

  --prefix PREFIX     Vanity prefix (default: frogtalk). Shorter = faster.
  --threads N         mkp224o worker threads (default: nproc)
  --work-dir DIR      Output directory while searching (default: /var/lib/frogtalk/tor-vanity)
  --install-dir DIR   FrogTalk install (default: /opt/frogtalk)
  --apply             Install keys into tor, set .env, board identity, restart tor
  --onion URL         Skip search; apply existing http://….onion URL
  --app-port PORT     HiddenService backend (default: 8080)
  -h, --help          This help

After --apply, set federation directory / board peers manually or re-run:
  bash node/scripts/node_federation_join.sh --install-dir /opt/frogtalk
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --threads) THREADS="${2:-}"; shift 2 ;;
    --work-dir) WORK_DIR="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --onion) ONION_URL="${2:-}"; shift 2 ;;
    --app-port) APP_PORT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) ft_die "Unknown option: $1 (try --help)" ;;
  esac
done

[[ -n "$PREFIX" ]] || ft_die "--prefix is required"

ensure_mkp224o() {
  if [[ -n "$MKP224O_BIN" && -x "$MKP224O_BIN" ]]; then
    return 0
  fi
  if command -v mkp224o >/dev/null 2>&1; then
    MKP224O_BIN="$(command -v mkp224o)"
    return 0
  fi
  local build_root="${WORK_DIR}/mkp224o-build"
  ft_step "Building mkp224o (one-time)..."
  mkdir -p "$build_root"
  if [[ "$(id -u)" -eq 0 ]] && ! dpkg -s libsodium-dev >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq libsodium-dev libssl-dev gcc make git >/dev/null 2>&1 || true
  fi
  if [[ ! -d "$build_root/mkp224o/.git" ]]; then
    rm -rf "$build_root/mkp224o"
    git clone --depth 1 https://github.com/cathugger/mkp224o.git "$build_root/mkp224o"
  fi
  if [[ ! -x "$build_root/mkp224o/mkp224o" ]]; then
    local mkdir="$build_root/mkp224o"
    if [[ ! -f "$mkdir/GNUmakefile" && ! -f "$mkdir/Makefile" ]]; then
      (cd "$mkdir" && ./autogen.sh && ./configure --enable-amd64-64-24k 2>/dev/null || ./configure)
    fi
    make -C "$mkdir" -j"$THREADS"
  fi
  MKP224O_BIN="$build_root/mkp224o/mkp224o"
  [[ -x "$MKP224O_BIN" ]] || ft_die "mkp224o build failed (need libsodium-dev, gcc, autoconf, automake, libtool)"
}

generate_vanity() {
  ensure_mkp224o
  mkdir -p "$WORK_DIR"
  ft_banner "Tor vanity search" "prefix: ${PREFIX} · threads: ${THREADS}"
  ft_warn "Long prefixes take a long time. Try --prefix frogta or frog if frogtalk is too slow."
  ft_say "${C_DIM}Searching in ${WORK_DIR} … (Ctrl+C to stop)${C_RESET}"
  rm -rf "${WORK_DIR}/${PREFIX}"*
  "$MKP224O_BIN" -d "$WORK_DIR" -t "$THREADS" "$PREFIX"
  local hostfile
  hostfile="$(find "$WORK_DIR" -maxdepth 2 -name hostname -print -quit)"
  [[ -n "$hostfile" ]] || ft_die "No hostname file produced — search may have been interrupted"
  local onion
  onion="$(tr -d '[:space:]' < "$hostfile")"
  [[ "$onion" == *.onion ]] || ft_die "Invalid hostname: $onion"
  printf '%s\n' "$onion"
}

install_hidden_service() {
  local onion="$1"
  local keydir="$2"
  [[ "$(id -u)" -eq 0 ]] || ft_die "--apply requires root (sudo)"
  command -v tor >/dev/null 2>&1 || ft_die "Install tor first: apt install tor"

  mkdir -p "$HS_DIR"
  chown debian-tor:debian-tor "$HS_DIR" 2>/dev/null || chown tor:tor "$HS_DIR" 2>/dev/null || true
  chmod 700 "$HS_DIR"

  if [[ -n "$keydir" && -d "$keydir" ]]; then
    cp -a "$keydir"/hs_ed25519_secret_key "$keydir"/hs_ed25519_public_key "$keydir"/hostname "$HS_DIR"/
    chown debian-tor:debian-tor "$HS_DIR"/* 2>/dev/null || chown tor:tor "$HS_DIR"/* 2>/dev/null || true
    chmod 600 "$HS_DIR"/hs_ed25519_secret_key
    onion="$(tr -d '[:space:]' < "$HS_DIR/hostname")"
  fi

  local frag="/etc/tor/torrc.d/frogtalk-${HS_NAME}.conf"
  mkdir -p /etc/tor/torrc.d
  cat > "$frag" <<EOF
# FrogTalk hidden service (managed by tor_vanity_onion.sh)
HiddenServiceDir ${HS_DIR}
HiddenServiceVersion 3
HiddenServicePort 80 127.0.0.1:${APP_PORT}
EOF
  grep -q '^%include /etc/tor/torrc.d/\*' /etc/tor/torrc 2>/dev/null || \
    echo '%include /etc/tor/torrc.d/*' >> /etc/tor/torrc

  systemctl enable tor
  systemctl restart tor
  sleep 2
  ft_ok "Tor hidden service → http://${onion}/ (→ 127.0.0.1:${APP_PORT})"
  printf '%s' "$onion"
}

apply_frogtalk_env() {
  local onion_host="$1"
  local env_file="${INSTALL_DIR}/.env"
  local onion_url="http://${onion_host}"
  [[ -f "$env_file" ]] || ft_die "Missing ${env_file}"

  ft_load_env_file "$env_file"
  ft_set_env_value "$env_file" "FROGTALK_TOR_ENABLED" "1"
  ft_set_env_value "$env_file" "FROGTALK_ONION_URL" "$onion_url"
  ft_set_env_value "$env_file" "FROGTALK_HOME_PAGE" "tor"
  ft_set_env_value "$env_file" "FROGTALK_SERVER_NAME" "FrogTalk Tor"

  export FROGTALK_HOME_PAGE=tor
  export FROGTALK_ONION_URL="$onion_url"
  bash "$INSTALL_DIR/node/scripts/configure_board_identity.sh" --install-dir "$INSTALL_DIR" || true

  local settings="${INSTALL_DIR}/node/board/board_data/settings.json"
  if [[ -f "$settings" ]]; then
    SETTINGS="$settings" ONION_URL="${onion_url}/board/" python3 - <<'PY'
import json, os
path = os.environ["SETTINGS"]
onion = os.environ["ONION_URL"].rstrip("/")
with open(path, encoding="utf-8") as f:
    s = json.load(f)
s["tor_onion_url"] = onion if onion.endswith("/board/") else onion + "/board/"
s["tor_only"] = True
with open(path, "w", encoding="utf-8") as f:
    json.dump(s, f, indent=2)
    f.write("\n")
PY
  fi

  if systemctl is-active frogtalk.service &>/dev/null; then
    systemctl restart frogtalk.service
    ft_ok "frogtalk.service restarted"
  fi
  ft_ok "FROGTALK_ONION_URL=${onion_url}"
  ft_say "${C_DIM}Re-run federation join to publish onion to directory:${C_RESET}"
  ft_say "  bash ${INSTALL_DIR}/node/scripts/node_federation_join.sh --install-dir ${INSTALL_DIR} --onion-url ${onion_url}"
}

KEYDIR=""
ONION_HOST=""

if [[ -n "$ONION_URL" ]]; then
  ONION_URL="${ONION_URL#http://}"
  ONION_URL="${ONION_URL#https://}"
  ONION_URL="${ONION_URL%%/*}"
  ONION_HOST="$ONION_URL"
else
  ONION_HOST="$(generate_vanity)"
  KEYDIR="$(dirname "$(find "$WORK_DIR" -maxdepth 2 -name hostname -exec grep -l "$ONION_HOST" {} + 2>/dev/null | head -1)")"
  [[ -d "$KEYDIR" ]] || KEYDIR="$(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d | head -1)"
  ft_ok "Found vanity: ${ONION_HOST}"
  ft_say "${C_DIM}Keys: ${KEYDIR}${C_RESET}"
fi

if [[ "$APPLY" -eq 1 ]]; then
  install_hidden_service "$ONION_HOST" "$KEYDIR" >/dev/null
  apply_frogtalk_env "$ONION_HOST"
else
  ft_say ""
  ft_ok "Vanity hostname: ${ONION_HOST}"
  ft_say "Install on this server:"
  ft_say "  sudo bash $0 --apply --onion http://${ONION_HOST}"
  [[ -n "$KEYDIR" ]] && ft_say "${C_DIM}  (keys in ${KEYDIR})${C_RESET}"
fi
