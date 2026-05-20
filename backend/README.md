# Backend Surface

This folder documents the backend/API boundary for FrogTalk. The runtime
itself still lives at canonical root paths so deploy targets, imports, and
existing operator scripts continue to work unchanged.

## Source-of-truth paths

- `main.py` — FastAPI app entrypoint
- `routers/` — API route modules (auth, rooms, messages, dms, external/bots, federation, admin, …)
- `database.py` + sibling modules — persistence/runtime services
- `static/` — served as `/static` and `/app` shell; also hosts marketing + docs pages
- `bot-examples/` — standalone reference bots for `/api/external/*`

## Public API surface

The active set of endpoint prefixes:

```
/api/auth/*
/api/rooms/*
/api/messages/*
/api/dms/*
/api/external/*     # bot/user API (key auth, channel-scoped)
/api/network/*      # federation / status / updates
/api/federation/*   # signed federation events inbox/outbox
/api/admin/*        # server-side admin (PIN gate)
/api/server-admin/* # server-admin login + config
/api/identity/*     # signed identity claims
/api/developer/*    # API keys + bot management
/api/bridges/*      # Discord/Telegram bridge management (public rooms only)
```

Full machine-readable docs ship at [`/docs/api`](../static/docs-api.html).

## Security boundary

- All cross-server federation traffic must carry valid Ed25519 signatures by default
  (`FROGTALK_FEDERATION_REQUIRE_SIGS=1`).
- Update apply will not run without a signed manifest matching `FROGTALK_RELEASE_SIGNERS`.
- Bot API keys are constrained to `{read, write, dm, bot}` and are channel-scoped via
  `bot_in_channel`.

See [`docs/SECURITY_HARDENING_PLAN.md`](../docs/SECURITY_HARDENING_PLAN.md) for the
threat-by-threat plan and [`docs/SECURITY_MODEL.md`](../docs/SECURITY_MODEL.md) for
the high-level model.

## Design rules

- Keep API paths stable; structural moves go behind boundary docs first, then aliases, then files.
- Sensitive endpoints fail closed (admin PIN gate, member checks, private-room invariant).
- Long-lived work moves off the event loop (push, bridge fan-out).
