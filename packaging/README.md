# FrogTalk distribution packaging

Templates for third-party stores. **Publishing requires maintainer accounts** on each platform.

| Channel | Path | Submit |
|---------|------|--------|
| [AUR `frogtalk-bin`](https://aur.archlinux.org/packages/frogtalk-bin) | `aur/frogtalk-bin/` | SSH git push to `aur` (see below) |
| Snap Store | `snap/` | `snapcraft upload --release=stable *.snap` |
| Homebrew | `homebrew/frogtalk.rb` | PR to `homebrew-cask` or `linuxbrew` |

## Prerequisite: GitHub release assets

Desktop version is **`client/desktop/app/package.json` → `version`**.

Build Linux artifacts before bumping store metadata:

```bash
cd client/desktop/app
npm ci
npm run build-all
# Upload from client/desktop/builds/ to GitHub Releases vX.Y.Z:
#   frogtalk_X.Y.Z_amd64.deb
#   FrogTalk-X.Y.Z.AppImage
```

Refresh AUR checksums after the `.deb` is on GitHub:

```bash
bash packaging/aur/update-frogtalk-bin.sh
```

## AUR (frogtalk-bin)

```bash
# One-time: clone your AUR remote
git clone ssh://aur@aur.archlinux.org/frogtalk-bin.git
cp packaging/aur/frogtalk-bin/* frogtalk-bin/
cd frogtalk-bin
bash ../packaging/aur/update-frogtalk-bin.sh   # from repo root, fixes sha256sums
makepkg -si
git add PKGBUILD .SRCINFO frogtalk.sh
git commit -m "upg: frogtalk-bin 1.5.3"
git push
```

Depends on **`electron41`** in Arch repos (matches app `package.json`).

## Snap Store

```bash
cd packaging/snap
snapcraft          # or snapcraft --use-lxd
snapcraft upload --release=stable frogtalk_*.snap
```

First-time: register at [snapcraft.io](https://snapcraft.io/) and `snapcraft login`.

## Homebrew

1. Replace `REPLACE_AFTER_RELEASE` sha256 in `homebrew/frogtalk.rb` after uploading release assets.
2. For official Homebrew: open a PR adding the cask/formula; follow [Acceptable Formulae](https://docs.brew.sh/Acceptable-Formulae).

```bash
brew install --build-from-source ./packaging/homebrew/frogtalk.rb
```

## Node operators (not stores)

Server mesh join (chat + board nav):

```bash
bash node/scripts/node_federation_join.sh --install-dir /opt/frogtalk -y
```
