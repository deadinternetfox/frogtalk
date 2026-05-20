# Backend Surface

This folder documents the backend/API boundary for FrogTalk.

Current source-of-truth paths:

- `main.py` - FastAPI app entrypoint
- `routers/` - API route modules
- `database.py` and related modules - persistence/runtime services

Planned direction:

- Group backend runtime concerns under `backend/` over time.
- Keep API routes and deployment entrypoints stable during migration.
