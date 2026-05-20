#!/usr/bin/env bash
# FrogTalk node update helper.
#
# Default: check only.
# Apply:   bash scripts/node_update_check.sh --apply

set -u
set -o pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: bash scripts/node_update_check.sh [--apply]"
      exit 1
      ;;
  esac
done

info() { printf "[info] %s\n" "$*"; }
ok()   { printf "[ok] %s\n" "$*"; }
warn() { printf "[warn] %s\n" "$*"; }
err()  { printf "[err] %s\n" "$*" >&2; }

if ! command -v git >/dev/null 2>&1; then
  err "git is required"
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  err "Run this script from inside the FrogTalk repository."
  exit 1
fi

branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo "HEAD")"
local_sha="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
default_remote_ref="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || true)"
remote_branch="${default_remote_ref#refs/remotes/origin/}"
remote_branch="${remote_branch:-master}"

info "Current branch: $branch ($local_sha)"
info "Fetching origin/$remote_branch ..."
if ! git fetch origin "$remote_branch" --quiet; then
  err "Failed to fetch remote branch."
  exit 1
fi

ahead_count="$(git rev-list --count "origin/$remote_branch..HEAD" 2>/dev/null || echo 0)"
behind_count="$(git rev-list --count "HEAD..origin/$remote_branch" 2>/dev/null || echo 0)"

if [[ "$behind_count" -eq 0 ]]; then
  ok "Node repo is up to date with origin/$remote_branch."
  exit 0
fi

warn "Update available: behind by $behind_count commit(s)."
if [[ "$ahead_count" -gt 0 ]]; then
  warn "Local branch is also ahead by $ahead_count commit(s). A fast-forward pull may fail."
fi

if [[ "$APPLY" -ne 1 ]]; then
  echo
  echo "Dry run only. To apply updates:"
  echo "  bash scripts/node_update_check.sh --apply"
  exit 0
fi

info "Applying update with fast-forward pull."
if ! git pull --ff-only origin "$remote_branch"; then
  err "Fast-forward pull failed. Resolve manually to avoid accidental merges."
  exit 1
fi
ok "Code updated."

REQ_PATH=""
[[ -f node/requirements.txt ]] && REQ_PATH=node/requirements.txt
[[ -z "$REQ_PATH" && -f requirements.txt ]] && REQ_PATH=requirements.txt

if [[ -n "$REQ_PATH" ]]; then
  if [[ -f venv/bin/python ]]; then
    info "Installing Python dependency updates into ./venv from $REQ_PATH"
    if ! venv/bin/python -m pip install -r "$REQ_PATH"; then
      warn "Dependency install failed; skipping."
    else
      ok "Dependencies updated."
    fi
  else
    warn "No local virtualenv found at ./venv; skipping dependency install."
  fi
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files 2>/dev/null | grep -q "^frogtalk\.service"; then
    info "Restarting frogtalk.service"
    if systemctl restart frogtalk.service; then
      ok "Service restarted."
    else
      warn "Service restart failed; inspect: sudo systemctl status frogtalk --no-pager"
    fi
  else
    warn "frogtalk.service not installed; skipping service restart."
  fi
fi

ok "Update flow complete."
