#!/usr/bin/env bash
# Background ship script for FrogTalk v1.4.3
# Logs go to .tmp_ship_v143.log. User will check back later.
set -u
cd "$(dirname "$0")"
LOG=.tmp_ship_v143.log
exec >"$LOG" 2>&1
set -x

VER=1.4.3
OLD=1.4.2
DIST=desktop/dist

APPIMAGE_SRC="$DIST/FrogTalk-${VER}.AppImage"
DEB_SRC="$DIST/FrogTalk_${VER}_amd64.deb"
WIN_ZIP_SRC="$DIST/FrogTalk-${VER}-win-x64.zip"
WIN_EXE_SRC="$DIST/FrogTalk-${VER}-win-x64-portable.exe"

for f in "$APPIMAGE_SRC" "$DEB_SRC" "$WIN_ZIP_SRC" "$WIN_EXE_SRC"; do
  [ -f "$f" ] || { echo "MISSING $f"; exit 1; }
done

# 1) Refresh static/ for in-app download links
rm -f static/FrogTalk-${OLD}* static/frogtalk_${OLD}*
cp "$APPIMAGE_SRC"  "static/FrogTalk-${VER}.AppImage"
cp "$DEB_SRC"       "static/frogtalk_${VER}_amd64.deb"   # lowercase to match glob in main.py
cp "$WIN_ZIP_SRC"   "static/FrogTalk-${VER}-win-x64.zip"
cp "$WIN_EXE_SRC"   "static/FrogTalk-${VER}-win-x64-portable.exe"

# 2) Refresh github-build-mirror/ + regen SHA256SUMS.txt
rm -f github-build-mirror/FrogTalk-${OLD}* github-build-mirror/frogtalk_${OLD}*
cp "$APPIMAGE_SRC"  "github-build-mirror/FrogTalk-${VER}.AppImage"
cp "$DEB_SRC"       "github-build-mirror/frogtalk_${VER}_amd64.deb"
cp "$WIN_ZIP_SRC"   "github-build-mirror/FrogTalk-${VER}-win-x64.zip"
cp "$WIN_EXE_SRC"   "github-build-mirror/FrogTalk-${VER}-win-x64-portable.exe"
(
  cd github-build-mirror
  : > SHA256SUMS.txt
  for f in FrogTalk-${VER}.AppImage FrogTalk-${VER}-win-x64-portable.exe FrogTalk-${VER}-win-x64.zip frogtalk_${VER}_amd64.deb; do
    sha256sum "$f" >> SHA256SUMS.txt
  done
  cat SHA256SUMS.txt
)

# 3) Ship to both nodes (large file uploads happen here)
SSH_OPTS="-o StrictHostKeyChecking=no -i $HOME/.ssh/id_ed25519"
for target in "root@161.97.182.73 2222" "root@31.220.92.120 22"; do
  set -- $target
  HOST=$1; PORT=$2
  echo "=== Shipping to $HOST:$PORT ==="
  scp $SSH_OPTS -P $PORT \
    "static/FrogTalk-${VER}.AppImage" \
    "static/frogtalk_${VER}_amd64.deb" \
    "static/FrogTalk-${VER}-win-x64.zip" \
    "static/FrogTalk-${VER}-win-x64-portable.exe" \
    "$HOST":/opt/frogtalk/static/ || { echo "SCP FAILED to $HOST"; exit 2; }
  ssh $SSH_OPTS -p $PORT "$HOST" "cd /opt/frogtalk/static && rm -f FrogTalk-${OLD}* frogtalk_${OLD}* && ls -la FrogTalk-${VER}* frogtalk_${VER}*"
done

# 4) Commit + push frontend + version bump + mirror artifacts
git add -A
git commit -m "release(v1.4.3): theme banner fix, Run-at-startup checkbox, console.log cleanup, ship desktop artifacts

- Frog theme preview banner now uses dark surface tone instead of bright lime
- New per-platform 'Run FrogTalk when my computer starts' toggle in
  Application tab (Win/macOS via app.setLoginItemSettings, Linux via
  ~/.config/autostart/frogtalk.desktop)
- Bump SW cache key v501 -> v502
- Strip noisy console.log calls from ws.js / social.js / notifications.js
- Bump desktop version 1.4.2 -> 1.4.3, rebuild AppImage + .deb + Win zip/portable
- Refresh github-build-mirror/ + SHA256SUMS.txt"
git push origin main || { echo "GIT PUSH FAILED"; exit 3; }

# 5) GitHub release: delete v1.4.2 (and its assets) then create v1.4.3
if command -v gh >/dev/null 2>&1; then
  gh release delete "v${OLD}" --yes --cleanup-tag 2>/dev/null || true
  gh release create "v${VER}" \
    --title "FrogTalk ${VER}" \
    --notes "Desktop ${VER} — theme polish, autostart toggle, console cleanup.

**Linux**
- \`FrogTalk-${VER}.AppImage\`
- \`frogtalk_${VER}_amd64.deb\`

**Windows (x64)**
- \`FrogTalk-${VER}-win-x64-portable.exe\` (single-file, just run)
- \`FrogTalk-${VER}-win-x64.zip\` (unzip and run)

SHA256 sums in \`github-build-mirror/SHA256SUMS.txt\`." \
    "github-build-mirror/FrogTalk-${VER}.AppImage" \
    "github-build-mirror/frogtalk_${VER}_amd64.deb" \
    "github-build-mirror/FrogTalk-${VER}-win-x64.zip" \
    "github-build-mirror/FrogTalk-${VER}-win-x64-portable.exe" \
    "github-build-mirror/SHA256SUMS.txt" || { echo "GH RELEASE FAILED"; exit 4; }
else
  echo "gh CLI not installed; skipping GitHub release upload"
fi

echo "=== ALL DONE v${VER} ==="
