#!/usr/bin/env bash
# TLS for clearnet nodes: self-signed (IP / no DNS) or certbot (real domain).
# Usage: sudo bash node/scripts/install_node_ssl.sh --install-dir /opt/frogtalk
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/cli.sh
source "$SCRIPT_DIR/lib/cli.sh"

INSTALL_DIR="${FT_INSTALL_DIR:-/opt/frogtalk}"
ASSUME_YES=0
MODE="" # auto | self-signed | certbot | skip

usage() {
  cat <<EOF
Usage: sudo bash node/scripts/install_node_ssl.sh [--install-dir PATH] [-y]

  -y / --yes     Non-interactive: self-signed for http://IP, certbot for https://domain when possible
  --self-signed  Force self-signed (10y, IP/DNS SAN)
  --certbot      Force Let's Encrypt (needs a public DNS name, not a bare IP)
  --skip         No-op

Run after install_board_nginx.sh. Updates PUBLIC_URL to https:// when TLS is enabled.
For DNS names, this script prefers Let's Encrypt via certbot.
If certbot is unavailable/fails, it prints free CLI CA alternatives
(ZeroSSL/Buypass via acme.sh) before falling back to self-signed.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --self-signed) MODE=self-signed; shift ;;
    --certbot) MODE=certbot; shift ;;
    --skip) MODE=skip; shift ;;
    -h|--help) usage; exit 0 ;;
    *) ft_die "Unknown option: $1" ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || ft_die "Run as root: sudo bash node/scripts/install_node_ssl.sh"
[[ -d "$INSTALL_DIR" ]] || ft_die "Missing install dir: $INSTALL_DIR"

ENV_FILE="$INSTALL_DIR/.env"
NGINX_SITE="/etc/nginx/sites-available/frogtalk"
REDIRECT_SITE="/etc/nginx/sites-available/frogtalk-http-redirect"
SSL_DIR="/etc/frogtalk/ssl"
SSL_CERT="${SSL_DIR}/node.pem"
SSL_KEY="${SSL_DIR}/node.key"

[[ -f "$NGINX_SITE" ]] || ft_die "nginx site missing — run install_board_nginx.sh first"

[[ -f "$ENV_FILE" ]] && ft_load_env_file "$ENV_FILE"

_public="${PUBLIC_URL:-}"
_host=""
_is_ip=0
if [[ -n "$_public" ]]; then
  _host="$(python3 - <<PY
from urllib.parse import urlparse
u = urlparse("""${_public}""")
print((u.hostname or "").strip())
PY
)"
fi
[[ -n "$_host" ]] || ft_die "Set PUBLIC_URL in ${ENV_FILE} first (e.g. http://YOUR_VPS_IP)"

if python3 - <<PY
import ipaddress
try:
    ipaddress.ip_address("""${_host}""")
    raise SystemExit(0)
except ValueError:
    raise SystemExit(1)
PY
then
  _is_ip=1
fi

if [[ -z "$MODE" ]]; then
  if [[ "$_public" == https://* ]] && [[ "$_is_ip" -eq 0 ]]; then
    MODE=certbot
  elif [[ "$_public" == http://* ]]; then
    MODE=self-signed
  else
    MODE=self-signed
  fi
fi

[[ "$MODE" != skip ]] || { ft_info "SSL install skipped."; exit 0; }

ft_require_cmd nginx
ft_require_cmd openssl
mkdir -p "$SSL_DIR"
chmod 750 "$SSL_DIR"

_nginx_reload() {
  nginx -t
  systemctl reload nginx
}

_strip_hsts_from_site() {
  sed -i '/Strict-Transport-Security/d' "$NGINX_SITE" 2>/dev/null || true
}

_enable_redirect_vhost() {
  cat >"$REDIRECT_SITE" <<'EOF'
# HTTP → HTTPS (installed by install_node_ssl.sh)
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 301 https://$host$request_uri;
}
EOF
  ln -sf "$REDIRECT_SITE" /etc/nginx/sites-enabled/frogtalk-http-redirect
}

_remove_plain_http_listeners() {
  sed -i '/listen 80 default_server;/d; /listen \[::\]:80 default_server;/d' "$NGINX_SITE" 2>/dev/null || true
  sed -i '/^[[:space:]]*listen 80;$/d; /^[[:space:]]*listen \[::\]:80;$/d' "$NGINX_SITE" 2>/dev/null || true
}

_add_ssl_to_site() {
  local cert="$1" key="$2"
  if grep -q 'listen 443 ssl' "$NGINX_SITE" 2>/dev/null; then
    sed -i "s|ssl_certificate .*|ssl_certificate ${cert};|" "$NGINX_SITE" 2>/dev/null || true
    sed -i "s|ssl_certificate_key .*|ssl_certificate_key ${key};|" "$NGINX_SITE" 2>/dev/null || true
    return 0
  fi
  sed -i "s|server_name _;|server_name _;\\n\\n    listen 443 ssl default_server;\\n    listen [::]:443 ssl default_server;\\n    ssl_certificate ${cert};\\n    ssl_certificate_key ${key};\\n    ssl_protocols TLSv1.2 TLSv1.3;|" "$NGINX_SITE"
  sed -i 's/fastcgi_param HTTPS off;/fastcgi_param HTTPS on;/g' "$NGINX_SITE" 2>/dev/null || true
  sed -i 's/fastcgi_param HTTP_X_FORWARDED_PROTO \$scheme;/fastcgi_param HTTP_X_FORWARDED_PROTO https;/g' "$NGINX_SITE" 2>/dev/null || true
  sed -i 's/proxy_set_header X-Forwarded-Proto \$scheme;/proxy_set_header X-Forwarded-Proto https;/g' "$NGINX_SITE" 2>/dev/null || true
}

_gen_self_signed() {
  local cn="$1" san="$2"
  ft_info "Generating self-signed certificate (10 years) for ${cn}"
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "$SSL_KEY" -out "$SSL_CERT" \
    -subj "/CN=${cn}/O=FrogTalk Node/C=XX" \
    -addext "subjectAltName=${san}" 2>/dev/null \
    || openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
         -keyout "$SSL_KEY" -out "$SSL_CERT" \
         -subj "/CN=${cn}/O=FrogTalk Node/C=XX"
  chmod 640 "$SSL_KEY" "$SSL_CERT"
}

_apply_https_env() {
  local new_url="https://${_host}"
  ft_set_env_value "$ENV_FILE" "PUBLIC_URL" "$new_url"
  ft_set_env_value "$ENV_FILE" "ALLOWED_ORIGINS" "$new_url"
  ft_set_env_value "$ENV_FILE" "FROGTALK_SERVER_WEBUI_COOKIE_SECURE" "1"
  ft_ok "Updated PUBLIC_URL → ${new_url}"
}

_print_free_ca_alternatives() {
  ft_step "Free certificate providers (CLI-friendly)"
  ft_detail "1) Let's Encrypt (certbot) — default path in this script."
  ft_detail "2) ZeroSSL (via acme.sh): curl https://get.acme.sh | sh"
  ft_detail "3) Buypass Go SSL (via acme.sh): acme.sh --set-default-ca --server buypass"
  ft_detail "Example (acme.sh webroot with nginx):"
  ft_detail "  ~/.acme.sh/acme.sh --issue -d ${_host} --webroot /var/www/html"
  ft_detail "  ~/.acme.sh/acme.sh --install-cert -d ${_host} \\"
  ft_detail "    --key-file ${SSL_KEY} --fullchain-file ${SSL_CERT} --reloadcmd 'systemctl reload nginx'"
}

case "$MODE" in
  self-signed)
    if [[ "$_is_ip" -eq 1 ]]; then
      _san="IP:${_host}"
    else
      _san="DNS:${_host}"
    fi
    _gen_self_signed "$_host" "$_san"
    _strip_hsts_from_site
    _remove_plain_http_listeners
    _add_ssl_to_site "$SSL_CERT" "$SSL_KEY"
    _enable_redirect_vhost
    if command -v ufw >/dev/null 2>&1; then
      ufw allow 443/tcp 2>/dev/null || true
    fi
    _nginx_reload
    _apply_https_env
    ft_ok "HTTPS enabled (self-signed) — https://${_host}/"
    ft_warn "Browsers show a one-time trust prompt for IP/self-signed certs."
    ft_warn "For a green padlock without warnings, point a domain here and re-run with --certbot."
    ;;
  certbot)
    if [[ "$_is_ip" -eq 1 ]]; then
      ft_die "Let's Encrypt needs a DNS name — use --self-signed for bare IPs."
    fi
    _print_free_ca_alternatives
    if ! command -v certbot >/dev/null 2>&1; then
      ft_info "Installing certbot…"
      apt-get update -qq
      apt-get install -y certbot python3-certbot-nginx
    fi
    _strip_hsts_from_site
    _nginx_reload || true
    if certbot --nginx -d "$_host" --non-interactive --agree-tos \
         --register-unsafely-without-email --redirect; then
      _apply_https_env
      ft_ok "Let's Encrypt certificate installed for ${_host}"
    else
      ft_warn "certbot failed — falling back to self-signed"
      _print_free_ca_alternatives
      bash "$SCRIPT_DIR/install_node_ssl.sh" --install-dir "$INSTALL_DIR" --self-signed
      exit $?
    fi
    ;;
  *)
    ft_die "Unknown mode: $MODE"
    ;;
esac

if systemctl is-active --quiet frogtalk 2>/dev/null; then
  systemctl restart frogtalk || true
fi
