# FrogTalk Project Structure

This document defines a clean split between user-facing client surfaces, backend services, and node-operator tooling while keeping runtime behavior stable.

## Top-level layout

```
frogtalk/
├── client/                        # client surfaces
│   ├── desktop/
│   │   ├── app/                   # Electron source (moved from root desktop/)
│   │   └── builds/                # Electron build outputs (gitignored)
│   └── mobile/
│       ├── android/               # Android app source (moved from root android/)
│       └── ios/                   # iOS app source / docs (moved from root ios/)
├── backend/                       # backend boundary docs (API/runtime surface)
│   └── README.md
├── node/                          # node-operator boundary docs
│   └── README.md
├── static/                        # web client + marketing pages (live runtime)
├── routers/                       # FastAPI route modules
├── main.py                        # backend entrypoint
├── deploy/                        # systemd / nginx / env templates
├── scripts/
│   ├── node_setup_wizard.sh       # interactive self-host setup
│   ├── node_update_check.sh       # update check / safe apply (fast-forward only)
│   └── deploy_nodes.sh            # operator multi-node deploy
├── bot-examples/                  # standalone reference bots + bot dev docs
├── docs/                          # design / security / structure docs
├── desktop -> client/desktop/app  # compatibility symlink (existing tools)
├── android -> client/mobile/android
└── ios    -> client/mobile/ios
```

## Why this split

| Folder    | Audience                  | What lives here                                                          |
|-----------|---------------------------|--------------------------------------------------------------------------|
| `client/` | App users / packagers     | Desktop (Electron) + mobile sources and platform-specific build outputs. |
| `backend/`| Backend devs              | Boundary doc pointing at the active runtime tree (`main.py`, `routers/`, `static/`). |
| `node/`   | Self-host operators       | Boundary doc pointing at `scripts/` + `deploy/` for running a node.       |
| `static/` | Runtime                   | The actual web client served by the FastAPI app. Kept at root so deploy paths stay stable. |

## Safe migration rules

1. Prefer "document + alias + migrate" over big-bang file moves.
2. Keep entrypoints (`main.py`, `static/`) stable until imports/routes are fully updated.
3. Any move must preserve:
   - deployment paths in `deploy/`
   - docs links and URLs
   - CI and release scripts
4. Update this file and `README.md` in the same PR when structure changes.

## Operator scripts

- `scripts/node_setup_wizard.sh` — interactive self-host setup with safe defaults (`FROGTALK_AUTO_UPDATE_ENABLED=0`, `FROGTALK_FEDERATION_REQUIRE_SIGS=1`).
- `scripts/node_update_check.sh` — checks the official feed and, with `--apply`, fast-forwards only if the signed manifest verifies against `FROGTALK_RELEASE_SIGNERS`.
- `scripts/deploy_nodes.sh` — operator-side multi-node deploy (lives outside the repo's gitignored shape).

## Compatibility

The three root symlinks (`desktop/`, `android/`, `ios/`) preserve existing tooling and external scripts that expected the old layout. New code should reference the canonical paths under `client/`.
