#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$ROOT_DIR/dist"
VERSION="$(date +%Y%m%d-%H%M%S)"
NAME="frogtalk-server-${VERSION}"
OUT_DIR="$DIST_DIR/$NAME"
ARCHIVE="$DIST_DIR/${NAME}.tar.gz"

mkdir -p "$DIST_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

rsync -a \
  --exclude '.git' \
  --exclude '.venv' \
  --exclude 'venv' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude 'data' \
  --exclude 'dist' \
  --exclude 'client/mobile/android/app/build' \
  --exclude 'client/mobile/android/.gradle' \
  --exclude 'client/mobile/android/build' \
  --exclude 'client/mobile/android/local.properties' \
  --exclude 'client/mobile/android/signing.properties' \
  --exclude 'client/desktop/app/node_modules' \
  --exclude 'client/desktop/builds' \
  --exclude '.DS_Store' \
  "$ROOT_DIR/" "$OUT_DIR/"

(
  cd "$DIST_DIR"
  tar -czf "$ARCHIVE" "$NAME"
)

sha256sum "$ARCHIVE" > "${ARCHIVE}.sha256"

echo "Built: $ARCHIVE"
echo "Checksum: ${ARCHIVE}.sha256"
