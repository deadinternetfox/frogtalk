#!/usr/bin/env bash
# Refresh sha256sums in packaging/aur/frogtalk-bin/PKGBUILD after a GitHub release.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PKGDIR="$ROOT/packaging/aur/frogtalk-bin"
pkgver="$(grep '^pkgver=' "$PKGDIR/PKGBUILD" | cut -d= -f2)"
_ghurl="https://github.com/deadinternetfox/frogtalk"
cd "$PKGDIR"
curl -fsSL -o "frogtalk-${pkgver}.deb" "${_ghurl}/releases/download/v${pkgver}/frogtalk_${pkgver}_amd64.deb"
curl -fsSL -o "LICENSE-${pkgver}" "${_ghurl}/raw/v${pkgver}/LICENSE"
updpkgsums
rm -f "frogtalk-${pkgver}.deb" "LICENSE-${pkgver}"
echo "Updated $PKGDIR/PKGBUILD — review and push to AUR: makepkg -si"
