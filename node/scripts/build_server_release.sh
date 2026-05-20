#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$NODE_DIR/.." && pwd)"
DIST_DIR="$REPO_ROOT/node/builds"
VERSION="$(date +%Y%m%d-%H%M%S)"
NAME="frogtalk-server-${VERSION}"
OUT_DIR="$DIST_DIR/$NAME"
ARCHIVE="$DIST_DIR/${NAME}.tar.gz"

mkdir -p "$DIST_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Bundle only the node runtime: everything in node/ minus dev junk.
rsync -a \
  --exclude '.git' \
  --exclude '.venv' \
  --exclude 'venv' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude 'data' \
  --exclude 'secrets' \
  --exclude '.env' \
  --exclude 'builds' \
  --exclude 'scripts/.env' \
  --exclude 'scripts/deploy_nodes.sh' \
  --exclude '.DS_Store' \
  "$NODE_DIR/" "$OUT_DIR/"

(
  cd "$DIST_DIR"
  tar -czf "$ARCHIVE" "$NAME"
)

sha256sum "$ARCHIVE" > "${ARCHIVE}.sha256"

echo "Built: $ARCHIVE"
echo "Checksum: ${ARCHIVE}.sha256"
