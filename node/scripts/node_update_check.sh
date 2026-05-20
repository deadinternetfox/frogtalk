#!/usr/bin/env bash
# FrogTalk node update helper — git fast-forward, venv refresh, service restart.
#
#   bash node/scripts/node_update_check.sh
#   bash node/scripts/node_update_check.sh --install-dir /opt/frogtalk --apply
#   bash node/scripts/install.sh update-apply -y
#
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/cli.sh
source "$SCRIPT_DIR/lib/cli.sh"

APPLY=0
ASSUME_YES=0
INSTALL_DIR=""
SKIP_RESTART=0
SKIP_FED_HINT=0

usage() {
  ft_banner "Node update" "git fast-forward · deps · restart"
  cat <<EOF
${C_BOLD}Usage:${C_RESET}
  bash node/scripts/node_update_check.sh [options]

${C_BOLD}Options:${C_RESET}
  --install-dir PATH   Git repo root (default: /opt/frogtalk or this checkout)
  --apply              Pull, refresh venv deps, restart frogtalk (if installed)
  -y, --yes            With --apply: skip confirmation when updates are available
  --skip-restart       Pull + pip only; do not restart systemd
  --skip-federation-hint  Omit post-update federation re-sync reminder
  -h, --help

${C_BOLD}Also via menu:${C_RESET}
  bash node/scripts/install.sh update
  bash node/scripts/install.sh update-apply -y
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --apply) APPLY=1; shift ;;
      -y|--yes) ASSUME_YES=1; export FT_ASSUME_YES=1; shift ;;
      --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
      --skip-restart) SKIP_RESTART=1; shift ;;
      --skip-federation-hint) SKIP_FED_HINT=1; shift ;;
      *) ft_die "Unknown argument: $1" ;;
    esac
  done
}

resolve_repo() {
  local hint=""
  if [[ -n "$INSTALL_DIR" ]]; then
    hint="$INSTALL_DIR"
  elif [[ -d "/opt/frogtalk/.git" ]]; then
    hint="/opt/frogtalk"
  elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    hint="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  fi
  INSTALL_DIR="$(ft_resolve_install_dir "/opt/frogtalk" "$hint")"
  cd "$INSTALL_DIR" || ft_die "Cannot enter install dir: $INSTALL_DIR"
  INSTALL_DIR="$(pwd)"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || ft_die "Not a git repo: $INSTALL_DIR"
}

detect_upstream() {
  UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [[ -z "$UPSTREAM" ]]; then
    local rb
    rb="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "")"
    [[ -n "$rb" ]] || rb="$(git remote show origin 2>/dev/null | awk '/HEAD branch/ {print $NF}')"
    [[ -n "$rb" ]] || rb="master"
    UPSTREAM="origin/${rb}"
  fi
  REMOTE_BRANCH="${UPSTREAM#origin/}"
}

warn_dirty_tree() {
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    ft_warn "Working tree has uncommitted changes — stash or commit before --apply."
    [[ "$APPLY" -eq 1 && "$ASSUME_YES" -eq 0 ]] && ft_die "Aborting apply (dirty tree)."
  fi
}

show_incoming_commits() {
  local n="${1:-5}"
  ft_step "Incoming commits (latest ${n})"
  git log --oneline -n "$n" "HEAD..${UPSTREAM}" 2>/dev/null \
    | while read -r line; do [[ -n "$line" ]] && ft_detail "$line"; done
}

apply_update() {
  ft_step "Applying update"
  git pull --ff-only origin "$REMOTE_BRANCH" || ft_die "Fast-forward pull failed — resolve manually."

  ft_ensure_runtime_symlinks "$INSTALL_DIR" && ft_ok "Runtime symlinks OK" \
    || ft_warn "Symlink check failed — run: bash node/scripts/install.sh setup"

  local req="node/requirements.txt"
  [[ -f "$req" ]] || req="requirements.txt"
  if [[ -f venv/bin/python && -f "$req" ]]; then
    ft_info "Refreshing Python dependencies…"
    if venv/bin/python -m pip install -q -r "$req"; then
      ft_ok "Dependencies updated"
    else
      ft_warn "pip install failed — check venv and network"
    fi
  else
    ft_skip "No venv or requirements.txt — skipped pip"
  fi

  if [[ "$SKIP_RESTART" -eq 0 ]] \
    && command -v systemctl >/dev/null 2>&1 \
    && systemctl list-unit-files 2>/dev/null | grep -q '^frogtalk\.service'; then
    ft_info "Restarting frogtalk.service…"
    if systemctl restart frogtalk; then
      sleep 2
      if systemctl is-active frogtalk >/dev/null 2>&1; then
        ft_ok "Service active"
        local port
        port="$(ft_detect_api_port "$INSTALL_DIR")"
        if curl -sf -m 5 "http://127.0.0.1:${port}/api/ping" >/dev/null 2>&1; then
          ft_ok "API ping http://127.0.0.1:${port}/api/ping"
        else
          ft_warn "Service up but API not responding on port ${port}"
        fi
      else
        ft_warn "Not active — journalctl -u frogtalk -n 40"
      fi
    else
      ft_warn "systemctl restart failed"
    fi
  elif [[ "$SKIP_RESTART" -eq 1 ]]; then
    ft_skip "Restart skipped (--skip-restart)"
  else
    ft_skip "frogtalk.service not installed — restart manually if needed"
  fi
}

main() {
  parse_args "$@"
  ft_require_cmd git
  resolve_repo
  detect_upstream

  ft_banner "Update check" "$INSTALL_DIR"

  local branch local_sha ahead_count behind_count
  branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo "HEAD")"
  local_sha="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"

  ft_info "Branch ${branch} @ ${local_sha}"
  ft_info "Tracking ${UPSTREAM}"
  ft_info "Fetching…"
  git fetch origin "$REMOTE_BRANCH" --quiet || ft_die "git fetch failed."

  ahead_count="$(git rev-list --count "${UPSTREAM}..HEAD" 2>/dev/null || echo 0)"
  behind_count="$(git rev-list --count "HEAD..${UPSTREAM}" 2>/dev/null || echo 0)"

  warn_dirty_tree

  if [[ "$behind_count" -eq 0 ]]; then
    ft_ok "Up to date with ${UPSTREAM}."
    exit 0
  fi

  ft_warn "Behind by ${behind_count} commit(s)."
  [[ "$ahead_count" -gt 0 ]] && ft_warn "Also ahead by ${ahead_count} — fast-forward may fail."
  show_incoming_commits 8

  if [[ "$APPLY" -ne 1 ]]; then
    ft_blank
    ft_info "To apply:"
    ft_detail "bash node/scripts/node_update_check.sh --install-dir ${INSTALL_DIR} --apply"
    ft_detail "bash node/scripts/install.sh update-apply --install-dir ${INSTALL_DIR}"
    exit 0
  fi

  if [[ "$ASSUME_YES" -eq 0 ]] && ! ft_ask_yes_no "Apply ${behind_count} commit(s) now?" "y"; then
    ft_info "Skipped."
    exit 0
  fi

  apply_update

  local new_sha
  new_sha="$(git rev-parse --short HEAD 2>/dev/null || echo "?")"
  ft_success_banner "Update applied @ ${new_sha}."
  ft_say "  ${C_BOLD}Install:${C_RESET}  ${INSTALL_DIR}"
  if [[ "$SKIP_FED_HINT" -eq 0 ]]; then
    ft_say "  ${C_BOLD}Mesh:${C_RESET}    bash node/scripts/install.sh federation -y --install-dir ${INSTALL_DIR}"
  fi
  ft_blank
}

main "$@"
