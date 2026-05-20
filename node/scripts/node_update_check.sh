#!/usr/bin/env bash
# FrogTalk node update helper
#
#   bash node/scripts/node_update_check.sh
#   bash node/scripts/node_update_check.sh --apply
#   bash node/scripts/node_update_check.sh --install-dir /opt/frogtalk --apply
#
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/cli.sh
source "$SCRIPT_DIR/lib/cli.sh"

APPLY=0
INSTALL_DIR=""

usage() {
  ft_banner "Node update" "Signed feed + git fast-forward"
  cat <<EOF
${C_BOLD}Usage:${C_RESET}
  bash node/scripts/node_update_check.sh [--install-dir PATH] [--apply]

  --apply          Pull origin and refresh venv deps + restart frogtalk
  --install-dir    Git repo root (default: /opt/frogtalk or current repo)
  -h, --help
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --apply) APPLY=1; shift ;;
      --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
      *) ft_die "Unknown argument: $1" ;;
    esac
  done
}

resolve_repo() {
  if [[ -n "$INSTALL_DIR" ]]; then
    cd "$INSTALL_DIR" || ft_die "Cannot cd to $INSTALL_DIR"
  elif [[ -d "/opt/frogtalk/.git" ]]; then
    cd "/opt/frogtalk"
  elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    :
  else
    ft_die "Not a git repo. Use --install-dir /opt/frogtalk"
  fi
  INSTALL_DIR="$(pwd)"
}

main() {
  parse_args "$@"
  ft_require_cmd git
  resolve_repo

  ft_banner "Update check" "$INSTALL_DIR"

  local branch local_sha remote_branch ahead_count behind_count
  branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo "HEAD")"
  local_sha="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
  remote_branch="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "master")"
  [[ -n "$remote_branch" ]] || remote_branch="master"

  ft_info "Branch ${branch} @ ${local_sha}"
  ft_info "Fetching origin/${remote_branch}…"
  git fetch origin "$remote_branch" --quiet || ft_die "git fetch failed."

  ahead_count="$(git rev-list --count "origin/${remote_branch}..HEAD" 2>/dev/null || echo 0)"
  behind_count="$(git rev-list --count "HEAD..origin/${remote_branch}" 2>/dev/null || echo 0)"

  if [[ "$behind_count" -eq 0 ]]; then
    ft_ok "Up to date with origin/${remote_branch}."
    exit 0
  fi

  ft_warn "Behind by ${behind_count} commit(s)."
  [[ "$ahead_count" -gt 0 ]] && ft_warn "Also ahead by ${ahead_count} — fast-forward may fail."

  if [[ "$APPLY" -ne 1 ]]; then
    ft_blank
    ft_info "Dry run. Apply with:"
    ft_detail "bash node/scripts/node_update_check.sh --install-dir ${INSTALL_DIR} --apply"
    ft_detail "bash node/scripts/install.sh update-apply"
    exit 0
  fi

  ft_step "Applying update"
  git pull --ff-only origin "$remote_branch" || ft_die "Fast-forward pull failed — resolve manually."

  local req="node/requirements.txt"
  [[ -f "$req" ]] || req="requirements.txt"
  if [[ -f venv/bin/python && -f "$req" ]]; then
    ft_info "Refreshing Python dependencies…"
    venv/bin/python -m pip install -q -r "$req" && ft_ok "Dependencies updated" \
      || ft_warn "pip install failed"
  else
    ft_skip "No venv or requirements.txt — skipped pip"
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^frogtalk\.service'; then
    ft_info "Restarting frogtalk.service…"
    if systemctl restart frogtalk && systemctl is-active frogtalk >/dev/null 2>&1; then
      ft_ok "Service active"
    else
      ft_warn "Restart issue — journalctl -u frogtalk -n 40"
    fi
  else
    ft_skip "frogtalk.service not installed"
  fi

  ft_success_banner "Update applied."
  ft_info "Re-sync federation: bash node/scripts/install.sh federation -y"
}

main "$@"
