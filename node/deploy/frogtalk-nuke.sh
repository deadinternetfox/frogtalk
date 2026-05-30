#!/usr/bin/env bash
# frogtalk-nuke.sh — node self-destruct ("nuke this node").
#
# Triggered ONLY by the /server admin panel Danger Zone after a fresh
# PIN/password + typed-confirmation check. The FrogTalk app runs as the
# unprivileged `deploy` user, so this lives at /usr/local/sbin (root:root,
# 0500) and is invoked via a narrow sudoers rule (see frogtalk-nuke.sudoers).
#
# What it does, in order:
#   1. Mark + log the event (logs get wiped at the end).
#   2. Stop every FrogTalk service.
#   3. Securely overwrite (shred) the sensitive data — DB, secrets, keys,
#      uploads, board data, .env — then delete it.
#   4. Remove the whole install (the app itself, "even itself").
#   5. Best-effort wipe of free RAM + page cache, then free disk space.
#   6. Vacuum the journal / logs.
#   7. Power the box off.
#
# Honesty about limits (documented for operators, not hidden):
#   * On SSD/NVMe with wear-levelling, in-place overwrite is NOT guaranteed to
#     hit the original cells. shred/sfill are best-effort; for a guaranteed
#     wipe, also issue an ATA/NVMe secure-erase or destroy the VPS disk via the
#     provider afterwards.
#   * "Shred RAM" can only overwrite *free* RAM (sdmem) + drop caches; RAM in
#     use by the kernel can't be zeroed from userspace. Power-off then removes
#     the charge (cold-boot attacks remain a theoretical edge case).
#
# Flags:
#   --paranoid   also sfill free disk space (slow on large disks; off by default)
#   --no-poweroff  do everything except the final poweroff (for testing on a
#                  throwaway box — NEVER use the trigger on a box you want to keep)

set +e
PARANOID=0
POWEROFF=1
for a in "$@"; do
  case "$a" in
    --paranoid) PARANOID=1 ;;
    --no-poweroff) POWEROFF=0 ;;
  esac
done

INSTALL_DIR="${FROGTALK_INSTALL_DIR:-/opt/frogtalk}"
TOR_HS_DIR="/var/lib/tor/frogtalk_onion"
STATE_DIR="/var/lib/frogtalk"

log() { logger -t frogtalk-nuke "$*" 2>/dev/null; echo "[frogtalk-nuke] $*"; }

log "SELF-DESTRUCT INITIATED at $(date -u 2>/dev/null) on $(hostname 2>/dev/null)"

# 1) Stop services so nothing re-writes files while we shred.
for svc in frogtalk frogtalk-runpod-bot nginx php8.3-fpm coturn cloudflared tor@default; do
  systemctl stop "$svc" 2>/dev/null
done

# 2) Securely overwrite the highest-value secrets first (small, fast, critical):
#    private keys, the session/CSRF secret, the federation token, the DB.
shred_path() {
  local p="$1"
  [ -e "$p" ] || return 0
  # 1 random pass + a final zero pass; multi-pass is pointless on SSD.
  find "$p" -type f -print0 2>/dev/null | xargs -0 -r -P4 shred -f -u -z -n1 2>/dev/null
}

for crit in \
  "$INSTALL_DIR/data" \
  "$INSTALL_DIR/.env" \
  "$INSTALL_DIR/node/.env" \
  "$INSTALL_DIR/node/board/.env" \
  "$INSTALL_DIR/secrets" \
  "$INSTALL_DIR/node/secrets" \
  "$INSTALL_DIR/node/scripts/.env" \
  "$INSTALL_DIR/node/board/board_data" \
  "$INSTALL_DIR/node/static/uploads" \
  "$TOR_HS_DIR" \
  "$STATE_DIR" \
  /root/frogtalk_onion.bak.* \
; do
  shred_path "$crit"
done

# 3) Remove the entire install (the app, the venv, this app's everything).
rm -rf "$INSTALL_DIR" "$TOR_HS_DIR" "$STATE_DIR" /root/frogtalk_onion.bak.* 2>/dev/null

# 4) Best-effort RAM wipe: drop caches now, overwrite free RAM if sdmem exists.
sync
echo 3 > /proc/sys/vm/drop_caches 2>/dev/null
if command -v sdmem >/dev/null 2>&1; then
  log "overwriting free RAM (sdmem, fast mode, time-boxed 120s)"
  timeout 120 sdmem -f -l -l 2>/dev/null
fi

# 5) Optional: overwrite free disk space so shredded data can't be carved back.
if [ "$PARANOID" = "1" ] && command -v sfill >/dev/null 2>&1; then
  log "overwriting free disk space (sfill, paranoid mode — may take a while)"
  sfill -f -l -l / 2>/dev/null
fi

# 6) Wipe logs / journal so the nuke itself leaves minimal trace.
journalctl --rotate 2>/dev/null
journalctl --vacuum-time=1s 2>/dev/null
rm -rf /var/log/frogtalk* /var/log/nginx/*frogtalk* 2>/dev/null

# 7) Remove the helper + its sudoers grant, then power off.
rm -f /etc/sudoers.d/frogtalk-nuke 2>/dev/null
SELF="$(readlink -f "$0" 2>/dev/null)"
[ -n "$SELF" ] && shred -f -u -z -n1 "$SELF" 2>/dev/null

log "wipe complete"
if [ "$POWEROFF" = "1" ]; then
  sync
  systemctl poweroff -f 2>/dev/null || poweroff -f 2>/dev/null || (echo o > /proc/sysrq-trigger 2>/dev/null)
fi
