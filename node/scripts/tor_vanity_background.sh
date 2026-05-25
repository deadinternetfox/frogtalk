#!/usr/bin/env bash
# Run tor_vanity_onion.sh in the background on a FrogTalk Tor VPS.
#
#   sudo bash node/scripts/tor_vanity_background.sh --prefix frogtalk --auto-apply
#   tail -f /var/lib/frogtalk/tor-vanity/vanity-search.log
#   sudo bash node/scripts/tor_vanity_background.sh --status
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VANITY_SCRIPT="$SCRIPT_DIR/tor_vanity_onion.sh"
INSTALL_DIR="${FT_INSTALL_DIR:-/opt/frogtalk}"
PREFIX="frogtalk"
THREADS="${FT_VANITY_THREADS:-$(nproc 2>/dev/null || echo 2)}"
WORK_DIR="${FT_VANITY_WORK_DIR:-/var/lib/frogtalk/tor-vanity}"
LOG_FILE="${WORK_DIR}/vanity-search.log"
PID_FILE="${WORK_DIR}/vanity-search.pid"
RESULT_FILE="${WORK_DIR}/FOUND.onion"
RUNNER="${WORK_DIR}/run_search.sh"
AUTO_APPLY=0
FG=0

usage() {
  cat <<'EOF'
Usage: tor_vanity_background.sh [options]

  --prefix PREFIX   Vanity prefix (default: frogtalk)
  --threads N       mkp224o threads (default: nproc)
  --auto-apply      After a match, run tor_vanity_onion.sh --apply
  --foreground      Run in foreground (log to stdout + file)
  --status          Show pid / log tail hint
  --stop            Stop background search (SIGTERM)
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --threads) THREADS="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --auto-apply) AUTO_APPLY=1; shift ;;
    --foreground) FG=1; shift ;;
    --status)
      if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "running pid=$(cat "$PID_FILE") log=$LOG_FILE"
        tail -8 "$LOG_FILE" 2>/dev/null || true
      else
        echo "not running"
        if [[ -f "$RESULT_FILE" ]]; then
          echo "last result: $(cat "$RESULT_FILE")"
        fi
      fi
      exit 0
      ;;
    --stop)
      if [[ -f "$PID_FILE" ]]; then
        kill "$(cat "$PID_FILE")" 2>/dev/null && echo "stopped $(cat "$PID_FILE")" || echo "already stopped"
        rm -f "$PID_FILE" "$RUNNER"
      else
        echo "no pid file"
      fi
      exit 0
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -x "$VANITY_SCRIPT" ]] || { echo "Missing $VANITY_SCRIPT" >&2; exit 1; }
mkdir -p "$WORK_DIR"

write_runner() {
  cat >"$RUNNER" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${LOG_FILE}"
RESULT_FILE="${RESULT_FILE}"
VANITY_SCRIPT="${VANITY_SCRIPT}"
INSTALL_DIR="${INSTALL_DIR}"
PREFIX="${PREFIX}"
THREADS="${THREADS}"
AUTO_APPLY="${AUTO_APPLY}"

exec >>"\$LOG_FILE" 2>&1
echo "=== FrogTalk vanity search started \$(date -Is) ==="
echo "prefix=\$PREFIX threads=\$THREADS auto_apply=\$AUTO_APPLY"

if ! command -v git >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1; then
  echo "Installing build deps..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq git build-essential tor libsodium-dev libssl-dev autoconf automake libtool pkg-config >/dev/null
fi

set +e
FT_INSTALL_DIR="\$INSTALL_DIR" \\
FT_VANITY_WORK_DIR="${WORK_DIR}" \\
FT_VANITY_THREADS="\$THREADS" \\
NO_COLOR=1 \\
bash "\$VANITY_SCRIPT" --prefix "\$PREFIX" --threads "\$THREADS" --install-dir "\$INSTALL_DIR" >>"\$LOG_FILE" 2>&1
rc=\$?
set -e

hostfile="\$(find "${WORK_DIR}" -maxdepth 2 -name hostname -type f 2>/dev/null | head -1)"
onion=""
if [[ -n "\$hostfile" ]]; then
  onion="\$(tr -d '[:space:]' < "\$hostfile")"
fi

if [[ "\$rc" -ne 0 ]] || [[ -z "\$onion" ]] || [[ "\$onion" != *.onion ]]; then
  echo "=== search ended \$(date -Is) rc=\$rc (no hostname file) ==="
  exit "\${rc:-1}"
fi

echo "\$onion" > "\$RESULT_FILE"
echo "=== MATCH \$(date -Is): \$onion ==="

if [[ "\$AUTO_APPLY" == "1" ]]; then
  echo "=== applying hidden service ==="
  FT_INSTALL_DIR="\$INSTALL_DIR" bash "\$VANITY_SCRIPT" \\
    --apply --onion "http://\${onion}" --install-dir "\$INSTALL_DIR"
  echo "=== apply complete \$(date -Is) ==="
fi
RUNNER
  chmod +x "$RUNNER"
}

write_runner

if [[ "$FG" -eq 1 ]]; then
  bash "$RUNNER"
  exit 0
fi

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Vanity search already running (pid $(cat "$PID_FILE"))."
  echo "  tail -f $LOG_FILE"
  exit 0
fi

nohup bash "$RUNNER" >/dev/null 2>&1 &
echo $! >"$PID_FILE"
echo "Vanity search started in background."
echo "  pid:  $(cat "$PID_FILE")"
echo "  log:  $LOG_FILE"
echo "  tail -f $LOG_FILE"
