# FrogTalk Project Structure

This document defines a clean split between user-facing client surfaces, backend services, and node-operator tooling while keeping runtime behavior stable.

## Current runtime layout

- `static/` - web client pages and browser assets
- `routers/` - FastAPI route modules
- `main.py` - backend entrypoint
- `deploy/` - service/deployment templates
- `scripts/` - maintenance and deploy scripts

## Target logical layout (migration map)

We are aligning the repo around three top-level concerns:

- `client/` - frontend surfaces (`static/`, desktop packaging, mobile docs/builds)
- `backend/` - API/runtime (`main.py`, `routers/`, persistence/services)
- `node/` - self-host/operator workflows (setup, update, release operations)

### Concrete target tree (implemented for desktop/mobile)

```
frogtalk/
├── client/
│   ├── desktop/
│   │   ├── app/            # moved from root desktop/
│   │   └── builds/         # Electron output artifacts
│   └── mobile/
│       ├── android/        # moved from root android/
│       └── ios/            # moved from root ios/
├── desktop -> client/desktop/app      # compatibility symlink
├── android -> client/mobile/android   # compatibility symlink
├── ios -> client/mobile/ios           # compatibility symlink
├── backend/
└── node/
```

## Safe migration rules

1. Prefer "document + alias + migrate" over big-bang file moves.
2. Keep entrypoints (`main.py`, `static/`) stable until imports/routes are fully updated.
3. Any move must preserve:
   - deployment paths in `deploy/`
   - docs links and URLs
   - CI and release scripts
4. Update this file and `README.md` in the same PR when structure changes.

## Operator scripts

- `scripts/node_setup_wizard.sh` - interactive self-host setup
- `scripts/node_update_check.sh` - update check + optional safe apply
