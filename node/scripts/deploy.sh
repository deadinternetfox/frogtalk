#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# FrogTalk Deploy Script — full rsync of node/ to one remote host
# Usage: bash node/scripts/deploy.sh
#
# Reads SSH_HOST, SSH_PORT, SSH_USER, SSH_KEY_PATH, REMOTE_DIR
# from node/scripts/.env (copy from deploy/env.example SSH section).
#
# Fleet hot deploy (two production nodes): node/scripts/deploy_nodes.sh
# Board PHP only: node/scripts/deploy_board.sh
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌  .env not found. Copy .env.example → .env and fill in your values."
  exit 1
fi

# Load .env (ignore comments and blank lines)
export $(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | xargs)

SSH_OPTS=(-p "${SSH_PORT:-22}" -i "${SSH_KEY_PATH:-$HOME/.ssh/id_rsa}" -o StrictHostKeyChecking=no)
REMOTE="${SSH_USER:-deploy}@${SSH_HOST:?SSH_HOST not set}"
REMOTE_DIR="${REMOTE_DIR:-/opt/frogtalk}"

START_TS=$(date +%s)
echo "🚀  Deploying FrogTalk node/ to ${REMOTE}:${REMOTE_DIR}"
echo "────────────────────────────────────────────────────────"

# ── 0. Quick pre-flight summary ────────────────────────────────
APK_COUNT=$(ls -1 "$NODE_DIR/static/"frogtalk-v*.apk 2>/dev/null | wc -l || echo 0)
LATEST_APK=$(ls -1 "$NODE_DIR/static/"frogtalk-v*.apk 2>/dev/null | sort | tail -n1 || true)
JS_COUNT=$(find "$NODE_DIR/static/js" -name '*.js' 2>/dev/null | wc -l)
PY_COUNT=$(find "$NODE_DIR" -maxdepth 2 -name '*.py' -not -path '*/.venv/*' -not -path '*/venv/*' 2>/dev/null | wc -l)
echo "📊  Local snapshot:"
echo "    • Python files  : ${PY_COUNT}"
echo "    • JS modules    : ${JS_COUNT}"
echo "    • APK bundles   : ${APK_COUNT}${LATEST_APK:+ (latest: $(basename "$LATEST_APK"))}"
echo ""

# ── 1. Sync files (exclude .env, data/, __pycache__, .git) ─────
echo "📤  [1/3] Syncing files to remote…"
rsync -avz --delete --human-readable --stats \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='secrets/' \
  --exclude='venv/' \
  --exclude='.venv/' \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='scripts/.env' \
  --exclude='scripts/deploy_nodes.sh' \
  "$NODE_DIR/" \
  "${REMOTE}:${REMOTE_DIR}/node/" | awk '
    /^sending incremental/ { print "    " $0; next }
    /^Number of files:/    { print "    📂 " $0; next }
    /^Number of regular files transferred:/ { print "    ✨ " $0; next }
    /^Total file size:/    { print "    💾 " $0; next }
    /^Total transferred file size:/ { print "    📡 " $0; next }
    /^Total bytes sent:/   { print "    ⬆️  " $0; next }
    /^sent .* received/    { print "    🔄 " $0; next }
    /^deleting /           { print "    🗑️  " $0; next }
    /\/$/                  { next }   # skip directory-only lines
    /^$/                   { next }
    { if (NR < 200) print "    + " $0 }
  '

echo "✅  [1/3] Files synced"

# ── 2. Remote setup ────────────────────────────────────────────
echo ""
echo "🛠️   [2/3] Running remote setup…"
ssh "${SSH_OPTS[@]}" "$REMOTE" bash <<REMOTE_SCRIPT
set -euo pipefail
cd "${REMOTE_DIR}"

# Create virtualenv if it doesn't exist
if [[ ! -d venv ]]; then
  echo "    📦 Creating virtualenv…"
  python3 -m venv venv
  echo "    ✅ Virtualenv created"
else
  echo "    ✅ Virtualenv already present"
fi

source venv/bin/activate
echo "    ⬆️  Upgrading pip…"
pip install --quiet --upgrade pip
echo "    📥 Installing/updating Python dependencies…"
pip install --quiet -r node/requirements.txt
PKG_COUNT=\$(pip list --format=freeze 2>/dev/null | wc -l)
echo "    ✅ Dependencies up to date (\$PKG_COUNT packages)"

# Ensure data + runtime symlinks (post-2026-05 restructure)
mkdir -p data
[ -L node/data ]    || ln -sfn /opt/frogtalk/data    node/data
[ -L node/.env ]    || ln -sfn /opt/frogtalk/.env    node/.env
[ -d secrets ] && { [ -L node/secrets ] || ln -sfn /opt/frogtalk/secrets node/secrets; } || true

# Reload / start service
echo ""
echo "🔁  [3/3] Restarting service…"
if systemctl is-active --quiet frogtalk 2>/dev/null; then
  systemctl restart frogtalk
  sleep 1
  if systemctl is-active --quiet frogtalk; then
    echo "    ♻️   frogtalk service restarted (active)"
    systemctl status frogtalk --no-pager -n 3 2>/dev/null | sed 's/^/       /' || true
  else
    echo "    ❌ frogtalk failed to come back up!"
    systemctl status frogtalk --no-pager -n 10 2>/dev/null | sed 's/^/       /' || true
    exit 1
  fi
else
  echo "    ⚠️   systemd service 'frogtalk' not found — start manually:"
  echo "         cd ${REMOTE_DIR} && source venv/bin/activate && python main.py"
fi
REMOTE_SCRIPT

# ── 4. Notify search engines (sitemap + IndexNow) ─────────────
SITE_URL="${FROGTALK_SITE_URL:-${PUBLIC_URL:-}}"
SITE_URL="${SITE_URL%/}"
if [[ -n "$SITE_URL" ]]; then
  echo ""
  echo "📣  [4/4] Pinging search engines for ${SITE_URL}…"
  # Bing/Yandex deprecated their classic sitemap-ping endpoints in 2023, but
  # Google still accepts pings, and IndexNow covers Bing+Yandex+Seznam+Naver+Yep.
  curl -fsS --max-time 10 -o /dev/null \
    "https://www.google.com/ping?sitemap=${SITE_URL}/sitemap.xml" \
    && echo "    ✅ Google sitemap ping OK" \
    || echo "    ⚠️  Google sitemap ping failed (non-fatal)"

  if [[ -n "${FROGTALK_INDEXNOW_KEY:-}" ]]; then
    INDEXNOW_PAYLOAD=$(cat <<JSON
{"host":"$(echo "$SITE_URL" | sed -E 's#^https?://##')","key":"${FROGTALK_INDEXNOW_KEY}","keyLocation":"${SITE_URL}/${FROGTALK_INDEXNOW_KEY}.txt","urlList":["${SITE_URL}/","${SITE_URL}/ios","${SITE_URL}/download/android","${SITE_URL}/docs/api","${SITE_URL}/docs/node","${SITE_URL}/board","${SITE_URL}/sitemap.xml","${SITE_URL}/sitemap-static.xml","${SITE_URL}/sitemap-users.xml","${SITE_URL}/sitemap-rooms.xml","${SITE_URL}/sitemap-board.xml","${SITE_URL}/llms.txt"]}
JSON
)
    HTTP_CODE=$(curl -sS --max-time 15 -o /tmp/indexnow.out -w '%{http_code}' \
      -H 'Content-Type: application/json; charset=utf-8' \
      -X POST 'https://api.indexnow.org/indexnow' \
      --data "$INDEXNOW_PAYLOAD" || echo 000)
    if [[ "$HTTP_CODE" =~ ^2 ]]; then
      echo "    ✅ IndexNow accepted (HTTP $HTTP_CODE) — Bing/Yandex/Seznam/Naver notified"
    else
      echo "    ⚠️  IndexNow returned HTTP $HTTP_CODE (non-fatal)"
      [[ -s /tmp/indexnow.out ]] && sed 's/^/        /' /tmp/indexnow.out
    fi
  else
    echo "    ℹ️  FROGTALK_INDEXNOW_KEY not set — skipping IndexNow ping"
  fi
fi

END_TS=$(date +%s)
DURATION=$(( END_TS - START_TS ))
echo ""
echo "────────────────────────────────────────────────────────"
echo "🐸  Deployment complete in ${DURATION}s!"
