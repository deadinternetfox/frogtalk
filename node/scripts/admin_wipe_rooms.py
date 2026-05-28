#!/usr/bin/env python3
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


def main() -> int:
    ap = argparse.ArgumentParser(description="Dangerous admin wipe helper (rooms + messages).")
    ap.add_argument("--db", default=os.environ.get("DB_PATH", "data/frogtalk.db"))
    ap.add_argument("--delete-room", action="append", default=[], help="Room name to delete (repeatable)")
    ap.add_argument("--wipe-messages", action="store_true", help="Delete all room messages + reactions")
    ap.add_argument("--wipe-music-queue", action="store_true", help="Delete all music_queue rows")
    ap.add_argument("--backup", action="store_true", help="Create a timestamped DB backup copy first")
    args = ap.parse_args()

    db = _abs_db_path(args.db)
    if args.backup:
        backup = f"{db}.bak-admin-wipe-{int(time.time())}"
        shutil.copy2(db, backup)
        print("backup", backup)

    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    cur = con.cursor()

    rooms_total = int(cur.execute("SELECT COUNT(*) AS c FROM rooms").fetchone()["c"])
    msg_total = int(cur.execute("SELECT COUNT(*) AS c FROM messages").fetchone()["c"])
    print("rooms_total", rooms_total, "messages_total", msg_total)

    delete_set = tuple(sorted({str(r or "").strip().lower() for r in (args.delete_room or []) if str(r or "").strip()}))
    if delete_set:
        # Any table with a room_name column gets cleaned for those rooms.
        tables = [r["name"] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        roomname_tables = []
        for t in tables:
            if not t or t.startswith("sqlite_"):
                continue
            cols = [c["name"] for c in con.execute(f"PRAGMA table_info({t})")]
            if "room_name" in cols:
                roomname_tables.append(t)
        q = ",".join(["?"] * len(delete_set))
        for t in roomname_tables:
            con.execute(f"DELETE FROM {t} WHERE lower(room_name) IN ({q})", delete_set)
        deleted = con.execute(f"DELETE FROM rooms WHERE lower(name) IN ({q})", delete_set).rowcount
        print("rooms_deleted", int(deleted))

    wiped_msgs = 0
    if args.wipe_messages:
        # reactions table is FK-cascaded by message_id, but delete both anyway.
        try:
            con.execute("DELETE FROM reactions")
        except Exception:
            pass
        wiped_msgs = con.execute("DELETE FROM messages").rowcount
        print("messages_wiped", int(wiped_msgs))

    if args.wipe_music_queue:
        try:
            wiped = con.execute("DELETE FROM music_queue").rowcount
            print("music_queue_wiped", int(wiped))
        except Exception as e:
            print("music_queue_wipe_skip", str(e))

    con.commit()
    rooms_after = int(con.execute("SELECT COUNT(*) AS c FROM rooms").fetchone()["c"])
    msgs_after = int(con.execute("SELECT COUNT(*) AS c FROM messages").fetchone()["c"])
    print("rooms_after", rooms_after, "messages_after", msgs_after)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

