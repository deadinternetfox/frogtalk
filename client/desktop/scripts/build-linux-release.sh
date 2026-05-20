#!/usr/bin/env bash
# Build Linux desktop artifacts for GitHub Releases + AUR frogtalk-bin.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/../app" && pwd)"
cd "$APP_DIR"
echo "Building FrogTalk $(node -p "require('./package.json').version")…"
npm ci
npm run build-all
echo "Artifacts in $(cd ../builds && pwd):"
ls -la ../builds/*.{deb,AppImage} 2>/dev/null || ls -la ../builds/
