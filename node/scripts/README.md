# Node admin scripts

These scripts are intended for **server operators** (SSH access) and run against the FrogTalk SQLite DB on a node.

All scripts accept `--db` (default `data/frogtalk.db`, resolved under `/opt/frogtalk/` if relative).

## Safety notes

- These are **dangerous** and can delete data. Always run with `--backup` unless you have an external snapshot.
- Prefer testing on a staging copy of the DB first.
- `VACUUM` can lock the DB; run during low traffic.

## Scripts

### `admin_audit_cleanup_production.py`

Production-safe auditing + conservative cleanup.

- Audits counts and prints a small “weird nickname” sample.
- Deletes expired sessions (older than 60 days).
- Deletes expired DM messages (based on `expires_at` if present).
- Optional: `--delete-unused-users` deletes only **provably unused** accounts (no sessions/messages/rooms/friends/wall/DMs).
- Optional: `--vacuum` runs `VACUUM` after cleanup.

Example:

```bash
python3 node/scripts/admin_audit_cleanup_production.py --backup --delete-unused-users --vacuum
```

### `admin_wipe_dms.py`

Deletes all DM channels + DM messages (preserves wall/social).

Example:

```bash
python3 node/scripts/admin_wipe_dms.py --backup
```

### `admin_wipe_rooms.py`

Room + message wipe helper.

- `--delete-room ROOMNAME` (repeatable) deletes rooms (and any table with `room_name` column referencing them).
- `--wipe-messages` deletes all room messages (and tries to clear `reactions`).
- `--wipe-music-queue` clears the music queue.

Example:

```bash
python3 node/scripts/admin_wipe_rooms.py --backup --delete-room "frog-social" --wipe-music-queue
```

