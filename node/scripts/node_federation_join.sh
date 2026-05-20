#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  FrogTalk — Federation Join CLI
#
#  One-shot operator tool: wire a node into the public FrogTalk mesh.
#    • Fix common deploy footguns (data symlink, board_data perms)
#    • Enable chat federation + official directory sync in .env
#    • Pull known servers from the official directory into SQLite
#    • Discover peer imageboards (/board/api/info) and link nav pills
#
#  Run (from repo root or anywhere):
#    bash node/scripts/node_federation_join.sh
#    bash node/scripts/node_federation_join.sh --install-dir /opt/frogtalk -y
#    bash node/scripts/node_federation_join.sh --dry-run
# ─────────────────────────────────────────────────────────────────────────────
set -u
set -o pipefail

INSTALL_DIR_DEFAULT="/opt/frogtalk"
OFFICIAL_DIRECTORY_DEFAULT="https://frogtalk.xyz/api/network/servers"
ENV_FILE_NAME=".env"
# ── Colors (disabled when not a TTY or NO_COLOR set) ─────────────────────────
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_MAGENTA=$'\033[35m'
  C_CYAN=$'\033[36m'
  C_RED=$'\033[31m'
  C_WHITE=$'\033[97m'
  C_BG_GREEN=$'\033[42m'
  C_BG_BLUE=$'\033[44m'
else
  C_RESET= C_BOLD= C_DIM= C_GREEN= C_YELLOW= C_BLUE= C_MAGENTA= C_CYAN= C_RED= C_WHITE= C_BG_GREEN= C_BG_BLUE=
fi

INSTALL_DIR=""
ASSUME_YES=0
DRY_RUN=0
SKIP_BOARD=0
SKIP_RESTART=0
PUBLIC_URL_OVERRIDE=""
ONION_URL_OVERRIDE=""

# ── UI helpers ───────────────────────────────────────────────────────────────
say()     { printf "%b\n" "$*"; }
blank()   { say ""; }

banner() {
  blank
  say "${C_CYAN}${C_BOLD}  ╔═══════════════════════════════════════════════════════════╗${C_RESET}"
  say "${C_CYAN}${C_BOLD}  ║${C_RESET}  ${C_GREEN}🐸 FrogTalk${C_RESET} ${C_WHITE}Federation Join${C_RESET}                              ${C_CYAN}${C_BOLD}║${C_RESET}"
  say "${C_CYAN}${C_BOLD}  ║${C_RESET}  ${C_DIM}Connect your node to the mesh — chat + board nav${C_RESET}         ${C_CYAN}${C_BOLD}║${C_RESET}"
  say "${C_CYAN}${C_BOLD}  ╚═══════════════════════════════════════════════════════════╝${C_RESET}"
  blank
}

step_head() {
  local n="$1" title="$2"
  say "${C_MAGENTA}${C_BOLD}  ▸ Step ${n}${C_RESET} ${C_BOLD}${title}${C_RESET}"
  say "${C_DIM}  ─────────────────────────────────────────────────────────${C_RESET}"
}

info()  { say "    ${C_BLUE}ℹ${C_RESET}  $*"; }
ok()    { say "    ${C_GREEN}✔${C_RESET}  $*"; }
warn()  { say "    ${C_YELLOW}⚠${C_RESET}  $*"; }
err()   { say "    ${C_RED}✖${C_RESET}  $*"; }
die()   { err "$*"; exit 1; }
skip()  { say "    ${C_DIM}○  $*${C_RESET}"; }
detail(){ say "       ${C_DIM}$*${C_RESET}"; }
badge() { say "    ${C_BG_BLUE}${C_WHITE} $* ${C_RESET}"; }
success_banner() {
  blank
  say "${C_GREEN}${C_BOLD}  ╭─────────────────────────────────────────────────────────╮${C_RESET}"
  say "${C_GREEN}${C_BOLD}  │${C_RESET}  ${C_BG_GREEN}${C_WHITE} DONE ${C_RESET}  Node is wired into the FrogTalk federation.   ${C_GREEN}${C_BOLD}│${C_RESET}"
  say "${C_GREEN}${C_BOLD}  ╰─────────────────────────────────────────────────────────╯${C_RESET}"
  blank
}

spinner_msg() {
  say "    ${C_CYAN}…${C_RESET}  $*"
}

usage() {
  cat <<EOF
${C_BOLD}FrogTalk Federation Join${C_RESET}

${C_DIM}Usage:${C_RESET}
  bash node/scripts/node_federation_join.sh [options]

${C_DIM}Options:${C_RESET}
  --install-dir PATH   Install root (default: ${INSTALL_DIR_DEFAULT})
  --public-url URL     Set PUBLIC_URL / federation.base_url
  --onion-url URL      Set FROGTALK_ONION_URL (enables Tor mode)
  --directory-url URL  Official directory feed (default: frogtalk.xyz)
  -y, --yes            Non-interactive; accept defaults
  --dry-run            Show planned changes only
  --skip-board         Skip imageboard peer linking
  --skip-restart       Do not restart frogtalk systemd unit
  -h, --help           This help

${C_DIM}Examples:${C_RESET}
  bash node/scripts/node_federation_join.sh
  bash node/scripts/node_federation_join.sh --install-dir /opt/frogtalk -y
  PUBLIC_URL=https://chat.example.com bash node/scripts/node_federation_join.sh -y
EOF
}

parse_args() {
  DIRECTORY_URL_OVERRIDE=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --install-dir)    INSTALL_DIR="${2:-}"; shift 2 ;;
      --public-url)     PUBLIC_URL_OVERRIDE="${2:-}"; shift 2 ;;
      --onion-url)      ONION_URL_OVERRIDE="${2:-}"; shift 2 ;;
      --directory-url)  DIRECTORY_URL_OVERRIDE="${2:-}"; shift 2 ;;
      -y|--yes)         ASSUME_YES=1; shift ;;
      --dry-run)        DRY_RUN=1; shift ;;
      --skip-board)     SKIP_BOARD=1; shift ;;
      --skip-restart)   SKIP_RESTART=1; shift ;;
      -h|--help)        usage; exit 0 ;;
      *) die "Unknown option: $1 (try --help)" ;;
    esac
  done
}

ask() {
  local prompt="$1" default="${2:-}"
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    printf "%s" "${default}"
    return 0
  fi
  local answer=""
  if [[ -n "$default" ]]; then
    read -r -p "    ${C_CYAN}?${C_RESET} ${prompt} [${C_DIM}${default}${C_RESET}]: " answer
    printf "%s" "${answer:-$default}"
  else
    read -r -p "    ${C_CYAN}?${C_RESET} ${prompt}: " answer
    printf "%s" "$answer"
  fi
}

ask_yes_no() {
  local prompt="$1" default="${2:-y}"
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    [[ "$default" =~ ^[Yy]$ ]]
    return
  fi
  local answer
  if [[ "$default" == "y" ]]; then
    answer="$(ask "$prompt (Y/n)" "y")"
  else
    answer="$(ask "$prompt (y/N)" "n")"
  fi
  [[ "$answer" =~ ^[Yy]$ ]]
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

set_env_value() {
  local file="$1" key="$2" value="$3"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    detail "[dry-run] ${key}=${value}"
    return 0
  fi
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf "\n%s=%s\n" "$key" "$value" >>"$file"
  fi
}

load_env_file() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    [[ "$line" != *=* ]] && continue
    export "$line" 2>/dev/null || true
  done <"$f"
}

run_py() {
  load_env_file "$INSTALL_DIR/$ENV_FILE_NAME"
  export FT_INSTALL_DIR="$INSTALL_DIR"
  export FT_NODE_DIR="$INSTALL_DIR/node"
  local py="$INSTALL_DIR/venv/bin/python3"
  [[ -x "$py" ]] || py="python3"
  # Run from /tmp with -I so /opt/frogtalk/signal.py and node/signal.py never
  # shadow the stdlib signal module (asyncio/import chain breaks otherwise).
  (cd /tmp && "$py" -I "$@")
}

curl_retry() {
  local url="$1" max="${2:-3}" attempt=1 out=""
  while [[ "$attempt" -le "$max" ]]; do
    if out="$(curl -sf -m 12 "$url" 2>/dev/null)"; then
      printf '%s' "$out"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep "$attempt"
  done
  return 1
}

fix_data_symlink() {
  step_head "1" "Runtime paths"
  local data_link="$INSTALL_DIR/node/data"
  mkdir -p "$INSTALL_DIR/data"

  if [[ -d "$data_link" && ! -L "$data_link" ]]; then
    warn "node/data is a real directory — the app may use an empty database."
    if [[ "$DRY_RUN" -eq 1 ]]; then
      detail "[dry-run] would mv node/data → node/data.misplaced-* && ln -sfn $INSTALL_DIR/data node/data"
    elif ask_yes_no "Replace node/data with symlink to $INSTALL_DIR/data?" "y"; then
      local ts
      ts="$(date +%Y%m%d-%H%M%S)"
      mv "$data_link" "$INSTALL_DIR/node/data.misplaced-${ts}"
      ok "Moved aside → node/data.misplaced-${ts}"
    else
      warn "Leaving node/data as-is (chat may stay broken)."
      return 0
    fi
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    detail "[dry-run] ln -sfn $INSTALL_DIR/data $data_link"
  else
    ln -sfn "$INSTALL_DIR/data" "$data_link"
    ok "node/data → $(readlink -f "$data_link" 2>/dev/null || echo "$INSTALL_DIR/data")"
  fi

  if [[ ! -L "$INSTALL_DIR/node/.env" && -f "$INSTALL_DIR/$ENV_FILE_NAME" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      detail "[dry-run] ln -sfn $INSTALL_DIR/.env node/.env"
    else
      ln -sfn "$INSTALL_DIR/$ENV_FILE_NAME" "$INSTALL_DIR/node/.env"
      ok "node/.env → $INSTALL_DIR/.env"
    fi
  fi

  if [[ -d "$INSTALL_DIR/secrets" && ! -L "$INSTALL_DIR/node/secrets" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      detail "[dry-run] ln -sfn $INSTALL_DIR/secrets node/secrets"
    else
      ln -sfn "$INSTALL_DIR/secrets" "$INSTALL_DIR/node/secrets"
      ok "node/secrets → $INSTALL_DIR/secrets"
    fi
  fi

  if [[ -d "$INSTALL_DIR/node/board/board_data" ]] && id www-data >/dev/null 2>&1; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      detail "[dry-run] chown www-data board_data board_uploads board_previews"
    else
      chown -R www-data:www-data \
        "$INSTALL_DIR/node/board/board_data" \
        "$INSTALL_DIR/node/board/board_uploads" \
        "$INSTALL_DIR/node/board/board_previews" 2>/dev/null || true
      ok "board_data writable by php-fpm (www-data)"
    fi
  fi
}

configure_env() {
  step_head "2" "Federation environment"
  local env_path="$INSTALL_DIR/$ENV_FILE_NAME"
  [[ -f "$env_path" ]] || die "No $env_path — run node_setup_wizard.sh first."

  local pub="${PUBLIC_URL_OVERRIDE:-${PUBLIC_URL:-}}"
  if [[ -z "$pub" ]] && [[ "$ASSUME_YES" -eq 0 ]]; then
    pub="$(ask "Public clearnet URL (https://…, empty if onion-only)" "")"
  fi
  pub="${pub%/}"

  local dir_url="${DIRECTORY_URL_OVERRIDE:-${FROGTALK_OFFICIAL_DIRECTORY_URL:-$OFFICIAL_DIRECTORY_DEFAULT}}"

  badge "CHAT FEDERATION"
  set_env_value "$env_path" "FROGTALK_FEDERATION_ENABLED" "1"
  if ! grep -qE '^FROGTALK_FEDERATION_REQUIRE_SIGS=' "$env_path" 2>/dev/null; then
    set_env_value "$env_path" "FROGTALK_FEDERATION_REQUIRE_SIGS" "1"
  fi
  if [[ -n "$pub" ]]; then
    set_env_value "$env_path" "PUBLIC_URL" "$pub"
    set_env_value "$env_path" "FROGTALK_BASE_URL" "$pub"
  fi
  set_env_value "$env_path" "FROGTALK_OFFICIAL_DIRECTORY_URL" "$dir_url"
  if ! grep -qE '^FROGTALK_OFFICIAL_DIRECTORY_SYNC_INTERVAL_SEC=' "$env_path" 2>/dev/null; then
    set_env_value "$env_path" "FROGTALK_OFFICIAL_DIRECTORY_SYNC_INTERVAL_SEC" "900"
  fi
  ok "Federation enabled · directory → ${C_DIM}${dir_url}${C_RESET}"

  local onion="${ONION_URL_OVERRIDE:-${FROGTALK_ONION_URL:-}}"
  if [[ -z "$onion" ]] && [[ "$ASSUME_YES" -eq 0 ]]; then
    if ask_yes_no "Configure Tor / onion URL for this node?" "n"; then
      onion="$(ask "Onion base URL (http://….onion)" "")"
    fi
  fi
  if [[ -n "$onion" ]]; then
    onion="${onion%/}"
    badge "TOR MODE"
    set_env_value "$env_path" "FROGTALK_TOR_ENABLED" "1"
    set_env_value "$env_path" "FROGTALK_ONION_URL" "$onion"
    if ! grep -qE '^FROGTALK_TOR_SOCKS_PROXY=' "$env_path" 2>/dev/null; then
      set_env_value "$env_path" "FROGTALK_TOR_SOCKS_PROXY" "socks5://127.0.0.1:9050"
    fi
    ok "Tor mode · ${C_DIM}${onion}${C_RESET}"
  elif ! grep -qE '^FROGTALK_TOR_SOCKS_PROXY=' "$env_path" 2>/dev/null; then
    set_env_value "$env_path" "FROGTALK_TOR_SOCKS_PROXY" "socks5://127.0.0.1:9050"
  fi

  load_env_file "$env_path"
}

sync_chat_federation() {
  step_head "3" "Chat mesh — official directory"
  spinner_msg "Importing known servers from directory…"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    skip "[dry-run] would run sync_official_directory_once + list federation_servers"
    CHAT_IMPORTED=0
    CHAT_TOTAL=0
    BOARD_PEER_URLS='[]'
    return 0
  fi

  local py_out
  py_out="$(run_py - 2>/dev/null <<'PY'
import asyncio, json, os, sys

_node_dir = os.path.abspath(os.environ.get("FT_NODE_DIR", ""))
if not _node_dir or not os.path.isdir(_node_dir):
    raise SystemExit("FT_NODE_DIR missing or not a directory")
sys.path.insert(0, _node_dir)
os.chdir(_node_dir)

import database as db
from database import init_db
from routers import federation as fed

init_db()

# Last-resort mesh rows when directory HTTP is down (frogtalk.xyz production pair).
FALLBACK_PEERS = [
    {
        "server_id": "srv_ee3f0ff0c6e74fadb542",
        "display_name": "FrogTalk Main",
        "base_url": "https://frogtalk.xyz",
        "onion_url": "",
        "capabilities": ["federation-v1"],
    },
    {
        "server_id": "srv_c93cf598b239402c8452",
        "display_name": "FrogTalk Tor Mirror",
        "base_url": "",
        "onion_url": "http://icn3a43nb6byhdmon4rqzeqswkskk2bnvf54l6at3iskmqlture3blqd.onion",
        "capabilities": ["federation-v1"],
    },
]

async def main():
    dir_url = (os.getenv("FROGTALK_OFFICIAL_DIRECTORY_URL") or "").strip()
    result = await fed.sync_official_directory_once(dir_url or None)
    if not result.get("ok") and FALLBACK_PEERS:
        imported = skipped = 0
        for item in FALLBACK_PEERS:
            row = fed._coerce_server_row(item)
            if not row:
                skipped += 1
                continue
            db.upsert_federation_server(
                server_id=row["server_id"],
                display_name=row["display_name"],
                base_url=row["base_url"],
                onion_url=row["onion_url"],
                official=True,
                trust_tier="official",
                capabilities=row["capabilities"],
            )
            imported += 1
        try:
            pinned = await asyncio.to_thread(fed.ensure_peer_pubkeys_pinned)
        except Exception:
            pinned = 0
        result = {
            "ok": True,
            "imported": imported,
            "skipped": skipped,
            "total": len(FALLBACK_PEERS),
            "fallback": True,
            "pinned": pinned,
            "error": result.get("error"),
        }
    else:
        try:
            pinned = await asyncio.to_thread(fed.ensure_peer_pubkeys_pinned)
        except Exception:
            pinned = 0
        result["pinned"] = pinned

    local = db.get_or_create_local_server_identity()
    local_sid = (local or {}).get("server_id") or ""
    pub = (os.getenv("PUBLIC_URL") or os.getenv("FROGTALK_BASE_URL") or "").strip()
    if pub:
        db.set_config("federation.base_url", pub)
    onion = (os.getenv("FROGTALK_ONION_URL") or "").strip()
    if onion:
        db.set_config("federation.onion_url", onion)
    display = os.getenv("FROGTALK_SERVER_NAME", "").strip() or db.get_config("federation.display_name") or "FrogTalk Node"
    db.set_config("federation.display_name", display)

    board_urls = []
    seen = set()
    rows = db.list_federation_servers(official_only=False)
    tor_local = fed._tor_mode_enabled()
    for row in rows:
        sid = row.get("server_id") or ""
        if sid == local_sid or not row.get("enabled"):
            continue
        targets = []
        base = (row.get("base_url") or "").strip().rstrip("/")
        onion_u = (row.get("onion_url") or "").strip().rstrip("/")
        if base.startswith("http"):
            targets.append(base)
        if onion_u.startswith("http"):
            targets.append(onion_u)
        if tor_local and onion_u.startswith("http"):
            targets = [onion_u] + [t for t in targets if t != onion_u]
        elif not tor_local and base.startswith("http"):
            targets = [base] + [t for t in targets if t != base]
        for raw in targets:
            board = raw + "/board/"
            if board in seen:
                continue
            seen.add(board)
            board_urls.append(board)

    peers = []
    for row in rows:
        sid = row.get("server_id") or ""
        if not sid or sid == local_sid:
            continue
        peers.append({
            "server_id": sid,
            "display_name": row.get("display_name") or sid,
            "enabled": bool(row.get("enabled")),
            "has_pubkey": bool((db.get_federation_server_pubkey(sid) or "").strip()),
            "base_url": row.get("base_url") or "",
            "onion_url": row.get("onion_url") or "",
        })

    out = {
        "sync": result,
        "local_server_id": local_sid,
        "peer_count": len(rows),
        "board_urls": board_urls,
        "peers": peers,
    }
    print(json.dumps(out))

asyncio.run(main())
PY
)" || die "Python federation sync failed (is venv + requirements installed?)"

  # Python may log to stderr; JSON result is the last line of stdout.
  py_json="$(printf '%s\n' "$py_out" | awk 'NF' | tail -n1)"

  local sync_ok imported total
  sync_ok="$(printf '%s' "$py_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print('1' if d.get('sync',{}).get('ok') else '0')")"
  imported="$(printf '%s' "$py_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sync',{}).get('imported',0))")"
  total="$(printf '%s' "$py_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sync',{}).get('total',0))")"
  BOARD_PEER_URLS="$(printf '%s' "$py_json" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('board_urls',[])))")"

  local used_fallback pinned_n
  used_fallback="$(printf '%s' "$py_json" | python3 -c "import sys,json; print('1' if json.load(sys.stdin).get('sync',{}).get('fallback') else '0')")"
  pinned_n="$(printf '%s' "$py_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sync',{}).get('pinned',0))")"

  if [[ "$sync_ok" != "1" ]]; then
    warn "Directory sync returned an error (check FROGTALK_OFFICIAL_DIRECTORY_URL / network)."
    detail "$(printf '%s' "$py_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sync',{}).get('error',''))")"
  elif [[ "$used_fallback" == "1" ]]; then
    warn "Directory unreachable — applied built-in FrogTalk mesh fallback (${imported} peer(s))."
    detail "$(printf '%s' "$py_json" | python3 -c "import sys,json; e=json.load(sys.stdin).get('sync',{}).get('error',''); print(e if e else '')")"
  else
    ok "Imported ${C_BOLD}${imported}${C_RESET} server(s) from directory (${total} listed)"
  fi
  if [[ "${pinned_n:-0}" -gt 0 ]]; then
    ok "Pinned ${C_BOLD}${pinned_n}${C_RESET} peer Ed25519 key(s) from /api/network/status"
  fi

  local local_sid peer_n board_n
  local_sid="$(printf '%s' "$py_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('local_server_id',''))")"
  peer_n="$(printf '%s' "$py_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('peer_count',0))")"
  board_n="$(printf '%s' "$BOARD_PEER_URLS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")"
  detail "Local server_id: ${C_DIM}${local_sid}${C_RESET} · registry rows: ${peer_n} · board candidates: ${board_n}"
  while IFS= read -r line; do
    [[ -n "$line" ]] && detail "$line"
  done < <(printf '%s' "$py_json" | python3 -c "
import sys, json
for p in json.load(sys.stdin).get('peers', []):
    pk = 'pinned' if p.get('has_pubkey') else 'no-pubkey'
    en = 'on' if p.get('enabled') else 'off'
    urls = p.get('base_url') or p.get('onion_url') or '(no url)'
    print(f\"peer {p.get('server_id','?')[:12]}… {en} {pk} — {p.get('display_name','')} — {urls}\")
")
  CHAT_IMPORTED="$imported"
  CHAT_TOTAL="$total"
}

sync_board_peers() {
  step_head "4" "Board mesh — nav pills"
  if [[ "$SKIP_BOARD" -eq 1 ]]; then
    skip "Board peer linking skipped (--skip-board)"
    BOARD_ADDED=0
    BOARD_FAILED=0
    return 0
  fi

  if [[ ! -d "$INSTALL_DIR/node/board" ]]; then
    skip "No node/board/ directory — skipping imageboard federation"
    BOARD_ADDED=0
    BOARD_FAILED=0
    return 0
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    skip "[dry-run] would upsert board peers via PHP"
    BOARD_ADDED=0
    BOARD_FAILED=0
    return 0
  fi

  require_cmd php
  spinner_msg "Linking federated boards (fetching /board/api/info)…"

  local php_result
  php_result="$(BOARD_PEER_URLS="$BOARD_PEER_URLS" FT_INSTALL_DIR="$INSTALL_DIR" php -d display_errors=0 <<'PHP'
<?php
$raw = getenv('BOARD_PEER_URLS') ?: '[]';
$urls = json_decode($raw, true);
if (!is_array($urls)) $urls = [];

$install = rtrim(getenv('FT_INSTALL_DIR') ?: '/opt/frogtalk', '/');
chdir($install . '/node/board');
require $install . '/node/board/board_config.php';

$added = 0;
$failed = 0;
$lines = [];

$s = loadSettings();
$s['federation_enabled'] = true;
saveSettings($s);

foreach ($urls as $u) {
    if (!is_string($u) || $u === '') continue;
    [$ok, $msg] = upsertFederatedPeer($u);
    if ($ok) { $added++; $lines[] = 'OK   ' . $u; }
    else { $failed++; $lines[] = 'FAIL ' . $u . ' — ' . $msg; }
}
try {
    $n = refreshFederatedPeers();
    $lines[] = "REFRESH {$n}";
} catch (Throwable $e) {
    $lines[] = 'REFRESH err: ' . $e->getMessage();
}
echo json_encode(['added' => $added, 'failed' => $failed, 'log' => $lines], JSON_UNESCAPED_SLASHES);
PHP
)"

  BOARD_ADDED="$(printf '%s' "$php_result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('added',0))" 2>/dev/null || echo 0)"
  BOARD_FAILED="$(printf '%s' "$php_result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('failed',0))" 2>/dev/null || echo 0)"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if [[ "$line" == OK* ]]; then
      ok "${line#OK   }"
    elif [[ "$line" == FAIL* ]]; then
      warn "${line#FAIL }"
    else
      detail "$line"
    fi
  done < <(printf '%s' "$php_result" | python3 -c "import sys,json; [print(x) for x in json.load(sys.stdin).get('log',[])]" 2>/dev/null)

  if [[ "${BOARD_ADDED:-0}" -gt 0 ]]; then
    ok "Board nav: ${C_BOLD}${BOARD_ADDED}${C_RESET} peer pill(s) linked"
  fi
  if [[ "${BOARD_FAILED:-0}" -gt 0 ]]; then
    warn "${BOARD_FAILED} peer(s) unreachable — ensure Tor SOCKS (FROGTALK_TOR_SOCKS_PROXY) for .onion boards"
  fi
}

verify_and_restart() {
  step_head "5" "Verify & apply"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    skip "[dry-run] would restart frogtalk + curl /api/network/status"
    return 0
  fi

  if [[ "$SKIP_RESTART" -eq 0 ]] && command -v systemctl >/dev/null 2>&1; then
    if systemctl is-enabled frogtalk >/dev/null 2>&1 || systemctl is-active frogtalk >/dev/null 2>&1; then
      spinner_msg "Restarting frogtalk.service…"
      if systemctl restart frogtalk 2>/dev/null; then
        sleep 2
        if systemctl is-active frogtalk >/dev/null 2>&1; then
          ok "Service active"
        else
          warn "Service did not stay active — check: journalctl -u frogtalk -n 40"
        fi
      else
        warn "Could not restart frogtalk (run manually: sudo systemctl restart frogtalk)"
      fi
    else
      skip "frogtalk systemd unit not installed"
    fi
  fi

  local port="${PORT:-8080}"
  local ping_ok=0
  for try_port in "$port" 8080 8000; do
    if curl -sf -m 5 "http://127.0.0.1:${try_port}/api/ping" >/dev/null 2>&1; then
      port="$try_port"
      ping_ok=1
      break
    fi
  done
  if [[ "$ping_ok" -eq 1 ]]; then
    ok "API ping http://127.0.0.1:${port}/api/ping"
  else
    warn "API not responding on PORT/8080/8000 (start frogtalk or check nginx upstream)"
  fi

  local status_line
  status_line="$(curl -sf -m 8 "http://127.0.0.1:${port}/api/network/status" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    s=d.get('server',{})
    fed=s.get('federation_enabled')
    sid=s.get('server_id','?')
    name=s.get('display_name','?')
    print(f'federation_enabled={fed} server_id={sid} name={name}')
except Exception:
    print('unavailable')
" 2>/dev/null || echo "unavailable")"
  detail "Network status: ${C_DIM}${status_line}${C_RESET}"

  if command -v curl >/dev/null 2>&1 && [[ -d "$INSTALL_DIR/node/board" ]]; then
    local board_info board_host
    board_host="$(python3 -c "from urllib.parse import urlparse; u='${PUBLIC_URL:-}'; print(urlparse(u).hostname or 'localhost')" 2>/dev/null || echo localhost)"
    board_info="$(curl -sf -m 5 -H "Host: ${board_host}" \
      "http://127.0.0.1/board/api/info" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(d.get('node_id','?') + ' · ' + (d.get('title') or '?'))
except Exception:
    print('unavailable')
" 2>/dev/null || echo "unavailable (nginx/php)")"
    detail "Local board: ${C_DIM}${board_info}${C_RESET}"
  fi
}

print_summary() {
  success_banner
  say "  ${C_BOLD}Summary${C_RESET}"
  say "    ${C_GREEN}Chat${C_RESET}   directory import: ${CHAT_IMPORTED:-0} / ${CHAT_TOTAL:-0} servers"
  say "    ${C_GREEN}Board${C_RESET}  peer pills linked:  ${BOARD_ADDED:-0}  (${BOARD_FAILED:-0} failed)"
  say ""
  say "  ${C_BOLD}Next steps${C_RESET}"
  say "    ${C_DIM}1.${C_RESET} Open ${C_CYAN}/app → Settings → Network${C_RESET} — probe & pick a node"
  say "    ${C_DIM}2.${C_RESET} Visit ${C_CYAN}/board/${C_RESET} — federated pills should appear at the top"
  say "    ${C_DIM}3.${C_RESET} Tune identity in ${C_CYAN}/board/admin${C_RESET} (title, node_id, topic)"
  say "    ${C_DIM}4.${C_RESET} Re-sync anytime: ${C_CYAN}bash node/scripts/node_federation_join.sh --install-dir ${INSTALL_DIR} -y${C_RESET}"
  say ""
  if [[ "$DRY_RUN" -eq 1 ]]; then
    warn "Dry-run only — re-run without --dry-run to apply."
  fi
}

main() {
  parse_args "$@"
  require_cmd python3
  require_cmd curl

  BOARD_PEER_URLS='[]'
  CHAT_IMPORTED=0
  CHAT_TOTAL=0
  BOARD_ADDED=0
  BOARD_FAILED=0

  if [[ -z "$INSTALL_DIR" ]]; then
    if [[ -d "$INSTALL_DIR_DEFAULT" ]]; then
      INSTALL_DIR="$INSTALL_DIR_DEFAULT"
    elif [[ -f "$(dirname "$0")/../main.py" ]]; then
      INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
    else
      INSTALL_DIR="$(ask "Install directory" "$INSTALL_DIR_DEFAULT")"
    fi
  fi
  INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"

  clear 2>/dev/null || true
  banner
  info "Install dir: ${C_BOLD}${INSTALL_DIR}${C_RESET}"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    badge "DRY RUN"
  fi
  blank

  fix_data_symlink
  blank
  configure_env
  blank
  sync_chat_federation
  blank
  sync_board_peers
  blank
  verify_and_restart
  print_summary
}

main "$@"
