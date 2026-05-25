#!/usr/bin/env bash
# Apply board title/subtitle/node_id from .env (FROGTALK_SERVER_NAME, optional board overrides).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/cli.sh
source "$SCRIPT_DIR/lib/cli.sh"

INSTALL_DIR="${FT_INSTALL_DIR:-/opt/frogtalk}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: bash node/scripts/configure_board_identity.sh [--install-dir /opt/frogtalk]"
      exit 0
      ;;
    *) ft_die "Unknown option: $1" ;;
  esac
done

SETTINGS="$INSTALL_DIR/node/board/board_data/settings.json"
[[ -f "$INSTALL_DIR/.env" ]] && ft_load_env_file "$INSTALL_DIR/.env"
[[ -f "$SETTINGS" ]] || { ft_skip "No board settings yet — run setup first"; exit 0; }

export FT_INSTALL_DIR="$INSTALL_DIR"
PY_BIN="python3"
[[ -x "$INSTALL_DIR/venv/bin/python3" ]] && PY_BIN="$INSTALL_DIR/venv/bin/python3"
py_out="$("$PY_BIN" -I - <<'PY'
import json, os, re, sys

install = os.environ.get("FT_INSTALL_DIR", "/opt/frogtalk")
path = os.path.join(install, "node", "board", "board_data", "settings.json")
try:
    with open(path, encoding="utf-8") as f:
        s = json.load(f)
except Exception:
    sys.exit(1)

name = (os.getenv("FROGTALK_SERVER_NAME") or "").strip()
region = (os.getenv("FROGTALK_SERVER_REGION") or "").strip()
home_page = (os.getenv("FROGTALK_HOME_PAGE") or "main").strip().lower()
title = (os.getenv("FROGTALK_BOARD_TITLE") or "").strip()
subtitle = (os.getenv("FROGTALK_BOARD_SUBTITLE") or "").strip()
topic = (os.getenv("FROGTALK_BOARD_TOPIC") or "").strip()

# Per-node homepage presets (override anytime via FROGTALK_BOARD_* env).
if not title:
    if home_page == "dev":
        title = "🔧 FrogTalk Development & support"
    elif home_page == "tor":
        title = "🐸 Frog General"
    elif name:
        title = name
    else:
        title = "🐸 Frog General"

if not topic:
    if home_page == "tor":
        topic = "Privacy"
    elif home_page == "dev":
        topic = "dev"
    else:
        topic = "general"

# Light regional / role presets (operators can override via env).
# Dev/tor home pages use fixed role copy — never regionalize the dev board as "Australian".
nl = name.lower()
if not subtitle:
    if home_page == "dev":
        subtitle = "Development & support — test builds, bugs, and federation; stable hub: frogtalk.app"
    elif home_page == "tor":
        subtitle = "Tor hidden-service imageboard · privacy-first discussion"
    elif home_page not in ("dev", "tor") and ("aus" in nl or region.upper() in ("AU", "AUSTRALIA")):
        subtitle = "G'day — Australian FrogTalk node"
        if "🐸" not in title and "australia" not in title.lower():
            title = f"🐸 {title}" if title.startswith("FrogTalk") else f"🐸 FrogTalk Australia"
    elif "tor" in nl and "mirror" in nl:
        subtitle = "Tor hidden-service mirror"
    elif name.startswith("FrogTalk"):
        subtitle = f"{name} — federated imageboard"

if topic:
    s["board_topic"] = topic[:32]
if subtitle:
    s["board_subtitle"] = subtitle[:120]
s["board_title"] = title[:80]
onion_env = (os.getenv("FROGTALK_ONION_URL") or "").strip().rstrip("/")
if home_page == "tor" and onion_env.startswith("http"):
    s["tor_onion_url"] = onion_env + "/board/"
    s["tor_only"] = True
s["federation_enabled"] = True
nid = (s.get("node_id") or "").strip()
if not nid or nid == "frogtalk-node":
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:32] or "frogtalk-node"
    s["node_id"] = slug

with open(path, "w", encoding="utf-8") as f:
    json.dump(s, f, indent=2)
    f.write("\n")
print(f"BOARD_IDENTITY_OK|{s['board_title']}|{s.get('board_subtitle', '')}")
PY
)"
while IFS='|' read -r tag title sub; do
  [[ "$tag" == "BOARD_IDENTITY_OK" ]] && ft_ok "Board: ${title}${sub:+ · ${sub}}"
done <<<"$py_out"
