#!/usr/bin/env python3
"""
Production DB audit + conservative cleanup.

- Creates a timestamped backup by default.
- Prunes expired/old rows (sessions, DM expiries, etc.) via database helpers when available.
- Optionally deletes *truly unused* user accounts (no sessions/messages/rooms/friends/social).
"""

import argparse
import os
import shutil
import sqlite3
import time


def _abs_db_path(db_path: str) -> str:
    p = str(db_path or "").strip() or "data/frogtalk.db"
    if p.startswith("/"):
        return p
    return "/opt/frogtalk/" + p.lstrip("/")


def _table_exists(con: sqlite3.Connection, name: str) -> bool:
    row = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone()
    return bool(row)


def _col_exists(con: sqlite3.Connection, table: str, col: str) -> bool:
    try:
        cols = [r["name"] for r in con.execute(f"PRAGMA table_info({table})").fetchall()]
        return col in cols
    except Exception:
        return False


def audit(con: sqlite3.Connection) -> dict:
    out: dict = {}
    cur = con.cursor()

    def count(table: str) -> int:
        if not _table_exists(con, table):
            return 0
        return int(cur.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"])

    out["counts"] = {
        "users": count("users"),
        "sessions": count("sessions"),
        "rooms": count("rooms"),
        "messages": count("messages"),
        "dm_channels": count("dm_channels"),
        "dm_messages": count("dm_messages"),
        "music_queue": count("music_queue"),
        "wall_posts": count("wall_posts"),
        "federation_channel_index": count("federation_channel_index"),
    }

    # Quick “weird” nicknames (non [a-z0-9_-]) — should be rare in prod.
    weird = []
    try:
        for row in cur.execute("SELECT id, nickname, is_admin, created_at FROM users ORDER BY id ASC"):
            nick = str(row["nickname"] or "")
            ok = all(ch.isalnum() or ch in {"_", "-"} for ch in nick)
            if not ok:
                weird.append(
                    {
                        "id": int(row["id"]),
                        "nickname": nick,
                        "is_admin": int(row["is_admin"] or 0),
                        "created_at": str(row["created_at"] or ""),
                    }
                )
                if len(weird) >= 50:
                    break
    except Exception:
        weird = []
    out["weird_nicknames"] = weird

    return out


def cleanup(con: sqlite3.Connection, *, delete_unused_users: bool) -> dict:
    cur = con.cursor()
    changed: dict = {"deleted_users": 0, "expired_sessions_deleted": 0, "expired_dm_deleted": 0}

    # 1) Expired/old sessions (safe).
    if _table_exists(con, "sessions"):
        # Prefer last_active if exists, else created_at; else expires_at.
        if _col_exists(con, "sessions", "last_active") and _col_exists(con, "sessions", "created_at"):
            cur.execute(
                "DELETE FROM sessions WHERE datetime(COALESCE(last_active, created_at)) < datetime('now','-60 days')"
            )
        else:
            cur.execute("DELETE FROM sessions WHERE expires_at < datetime('now','-60 days')")
        changed["expired_sessions_deleted"] = int(cur.rowcount or 0)

    # 2) Expired DM messages (safe, respects per-message expires_at column/index).
    if _table_exists(con, "dm_messages") and _col_exists(con, "dm_messages", "expires_at"):
        cur.execute("DELETE FROM dm_messages WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')")
        changed["expired_dm_deleted"] = int(cur.rowcount or 0)

    # 3) Delete “truly unused” user accounts (conservative).
    # Criteria:
    # - not admin
    # - nickname not in ('frog','admin','federation_sync')
    # - no active sessions
    # - owns no rooms
    # - authored no room messages
    # - has no friends rows
    # - has no wall posts
    # - has no dm channels
    if delete_unused_users and _table_exists(con, "users"):
        # Rowcount is unreliable for DELETE with CTEs; compute delta.
        before_users = 0
        try:
            before_users = int(cur.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"])
        except Exception:
            before_users = 0
        dm_user_select = None
        if _table_exists(con, "dm_channels"):
            if _col_exists(con, "dm_channels", "user_id"):
                dm_user_select = "SELECT DISTINCT user_id FROM dm_channels"
            elif _col_exists(con, "dm_channels", "user_a") and _col_exists(con, "dm_channels", "user_b"):
                dm_user_select = "SELECT DISTINCT user_a AS user_id FROM dm_channels UNION SELECT DISTINCT user_b AS user_id FROM dm_channels"
        if not dm_user_select:
            dm_user_select = "SELECT -1 AS user_id WHERE 0"

        cur.execute(
            """
            WITH active_sessions AS (
              SELECT DISTINCT user_id FROM sessions
              WHERE expires_at > datetime('now')
            ),
            owns_rooms AS (
              SELECT DISTINCT owner_id AS user_id FROM rooms WHERE owner_id IS NOT NULL
            ),
            has_msgs AS (
              SELECT DISTINCT user_id FROM messages
            ),
            has_friends AS (
              SELECT DISTINCT user_id FROM friends
              UNION
              SELECT DISTINCT friend_id FROM friends
            ),
            has_wall AS (
              SELECT DISTINCT user_id FROM wall_posts
            ),
            has_dm AS (
              {dm_users}
            )
            DELETE FROM users
            WHERE is_admin=0
              AND lower(nickname) NOT IN ('frog','admin','federation_sync')
              AND id NOT IN (SELECT user_id FROM active_sessions)
              AND id NOT IN (SELECT user_id FROM owns_rooms)
              AND id NOT IN (SELECT user_id FROM has_msgs)
              AND id NOT IN (SELECT user_id FROM has_friends)
              AND id NOT IN (SELECT user_id FROM has_wall)
              AND id NOT IN (SELECT user_id FROM has_dm)
            """
            .format(dm_users=dm_user_select)
        )
        after_users = before_users
        try:
            after_users = int(cur.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"])
        except Exception:
            after_users = before_users
        changed["deleted_users"] = max(0, int(before_users - after_users))

    return changed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("DB_PATH", "data/frogtalk.db"))
    ap.add_argument("--backup", action="store_true", default=True)
    ap.add_argument("--no-backup", dest="backup", action="store_false")
    ap.add_argument("--delete-unused-users", action="store_true", help="Conservative: delete provably unused users")
    ap.add_argument("--vacuum", action="store_true", help="Run VACUUM after cleanup (locks DB)")
    args = ap.parse_args()

    db = _abs_db_path(args.db)
    if args.backup:
        backup = f"{db}.bak-audit-{int(time.time())}"
        shutil.copy2(db, backup)
        print("backup", backup)

    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")

    before = audit(con)
    print("before", before)

    ch = cleanup(con, delete_unused_users=bool(args.delete_unused_users))
    con.commit()

    if args.vacuum:
        try:
            con.execute("VACUUM")
        except Exception as e:
            print("vacuum_error", str(e))
    try:
        con.execute("ANALYZE")
    except Exception:
        pass

    after = audit(con)
    print("changes", ch)
    print("after", after)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

