#!/usr/bin/env bash
# Install nginx site with FrogTalk imageboard (PHP) + app proxy.
# Usage: sudo bash node/scripts/install_board_nginx.sh --install-dir /opt/frogtalk
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/cli.sh
source "$SCRIPT_DIR/lib/cli.sh"

INSTALL_DIR="${FT_INSTALL_DIR:-/opt/frogtalk}"
APP_PORT="8080"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: sudo bash node/scripts/install_board_nginx.sh [--install-dir /opt/frogtalk]"
      exit 0
      ;;
    *) ft_die "Unknown option: $1" ;;
  esac
done

[[ -d "$INSTALL_DIR" ]] || ft_die "Missing install dir: $INSTALL_DIR"
ENV_FILE="$INSTALL_DIR/.env"
[[ -f "$ENV_FILE" ]] && ft_load_env_file "$ENV_FILE"
APP_PORT="${PORT:-8080}"

ft_require_cmd nginx
ft_require_cmd systemctl
if [[ ! -S /run/php/php8.3-fpm.sock ]] && [[ ! -S /run/php/php-fpm.sock ]]; then
  ft_warn "php-fpm socket not found - install: apt install php-fpm php-curl"
fi

TEMPLATE="$INSTALL_DIR/node/deploy/nginx.conf"
[[ -f "$TEMPLATE" ]] || TEMPLATE="$SCRIPT_DIR/../deploy/nginx.conf"
[[ -f "$TEMPLATE" ]] || ft_die "Missing nginx template (node/deploy/nginx.conf)"

TMP="$(mktemp)"
sed "s/127.0.0.1:8000/127.0.0.1:${APP_PORT}/g" "$TEMPLATE" >"$TMP"

# Clearnet VPS installs: app binds PORT (default 8080). nginx must not also listen
# on that port (template includes 8080 for Cloudflare tunnel origins on Main only).
_tunnel_nginx=0
case "${FROGTALK_NGINX_TUNNEL_LISTEN:-}" in
  1|true|yes|on) _tunnel_nginx=1 ;;
esac
if [[ "$_tunnel_nginx" -eq 0 ]]; then
  sed -i '/listen 8080;/d; /listen \[::\]:8080;/d' "$TMP"
fi

_https_pub=0
case "${PUBLIC_URL:-}" in
  https://*) _https_pub=1 ;;
esac
if [[ "${FROGTALK_SERVER_WEBUI_COOKIE_SECURE:-0}" != "1" && "$_https_pub" -eq 0 ]]; then
  sed -i 's/fastcgi_param HTTPS on;/fastcgi_param HTTPS off;/g' "$TMP" || true
  sed -i 's/fastcgi_param HTTP_X_FORWARDED_PROTO https;/fastcgi_param HTTP_X_FORWARDED_PROTO $scheme;/g' "$TMP" || true
  # HSTS on plain HTTP confuses browsers (forces https without a cert).
  sed -i '/Strict-Transport-Security/d' "$TMP" || true
fi

DEST="/etc/nginx/sites-available/frogtalk"
cp "$TMP" "$DEST"
rm -f "$TMP"
ln -sf "$DEST" /etc/nginx/sites-enabled/frogtalk
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

nginx -t
systemctl enable nginx php8.3-fpm 2>/dev/null || systemctl enable nginx php-fpm 2>/dev/null || systemctl enable nginx
systemctl reload nginx
systemctl restart php8.3-fpm 2>/dev/null || systemctl restart php-fpm 2>/dev/null || true

ft_ok "nginx board + app proxy installed - upstream 127.0.0.1:${APP_PORT}"
if curl -sf -m 5 "http://127.0.0.1/board/api/info" >/dev/null 2>&1; then
  ft_ok "Local board API: http://127.0.0.1/board/api/info"
else
  ft_warn "Board API not responding yet - check php-fpm and board_data permissions"
fi
