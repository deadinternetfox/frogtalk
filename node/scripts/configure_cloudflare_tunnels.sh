#!/usr/bin/env bash
# Configure Cloudflare Tunnel public hostnames (requires CF API token).
#
#   export CF_API_TOKEN='...'   # Zero Trust / Account — Cloudflare One Connect Write
#   bash node/scripts/configure_cloudflare_tunnels.sh
#
# Account + tunnel IDs from existing fleet (token decode). Override via env if needed.

set -euo pipefail

CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-c8082f205c65bef98502a370c650f051}"
CF_TUNNEL_MAIN_ID="${CF_TUNNEL_MAIN_ID:-395f4216-e4b7-409b-9847-64293b5616c1}"
CF_TUNNEL_DEV_NAME="${CF_TUNNEL_DEV_NAME:-frogtalk-dev}"

if [[ -z "${CF_API_TOKEN:-}" ]]; then
  echo "Set CF_API_TOKEN (Cloudflare One Connect Write) then re-run." >&2
  echo "Dashboard fallback:" >&2
  echo "  1. Zero Trust → Networks → Tunnels → Main tunnel" >&2
  echo "     Public Hostname: frogtalk.app + www → http://localhost:8080" >&2
  echo "     Remove frogtalk.xyz from this tunnel when dev tunnel is live." >&2
  echo "  2. Create tunnel '$CF_TUNNEL_DEV_NAME' → frogtalk.xyz + www → http://localhost:8080" >&2
  echo "     Install token on the dev VPS." >&2
  exit 1
fi

api() {
  curl -fsS -X "$1" "https://api.cloudflare.com/client/v4$2" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "${@:3}"
}

echo "Updating main tunnel ($CF_TUNNEL_MAIN_ID) → frogtalk.app …"
api PUT "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_MAIN_ID}/configurations" \
  --data "$(cat <<'JSON'
{
  "config": {
    "ingress": [
      {"hostname": "frogtalk.app", "service": "http://localhost:8080"},
      {"hostname": "www.frogtalk.app", "service": "http://localhost:8080"},
      {"service": "http_status:404"}
    ]
  }
}
JSON
)" | python3 -c "import sys,json; r=json.load(sys.stdin); print('ok' if r.get('success') else r)"

echo "Looking for dev tunnel '$CF_TUNNEL_DEV_NAME' …"
DEV_TUNNEL_ID="$(api GET "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel" | python3 -c "
import json,sys,os
name=os.environ.get('CF_TUNNEL_DEV_NAME','frogtalk-dev')
data=json.load(sys.stdin)
for t in data.get('result',[]) or []:
    if t.get('name')==name:
        print(t.get('id',''))
        break
" CF_TUNNEL_DEV_NAME="$CF_TUNNEL_DEV_NAME")"

if [[ -z "$DEV_TUNNEL_ID" ]]; then
  echo "Creating dev tunnel '$CF_TUNNEL_DEV_NAME' …"
  DEV_TUNNEL_ID="$(api POST "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel" \
    --data "{\"name\":\"${CF_TUNNEL_DEV_NAME}\",\"tunnel_secret\":\"$(openssl rand -base64 32)\"}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['id'])")"
fi

echo "Dev tunnel id: $DEV_TUNNEL_ID"
api PUT "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${DEV_TUNNEL_ID}/configurations" \
  --data "$(cat <<'JSON'
{
  "config": {
    "ingress": [
      {"hostname": "frogtalk.xyz", "service": "http://localhost:8080"},
      {"hostname": "www.frogtalk.xyz", "service": "http://localhost:8080"},
      {"service": "http_status:404"}
    ]
  }
}
JSON
)" | python3 -c "import sys,json; r=json.load(sys.stdin); print('ok' if r.get('success') else r)"

echo "Fetch dev install token:"
api GET "/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${DEV_TUNNEL_ID}/token" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['result'])"

echo "Install on AU: cloudflared service install <token above>"
