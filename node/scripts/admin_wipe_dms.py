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


def _table_exists(con: sqlite3.Connection, name: str) -> bool:
    row = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone()
    return bool(row)


def main() -> int:
    ap = argparse.ArgumentParser(description="Dangerous admin DM wipe (preserves wall/social).")
    ap.add_argument("--db", default=os.environ.get("DB_PATH", "data/frogtalk.db"))
    ap.add_argument("--backup", action="store_true", help="Create timestamped DB backup")
    args = ap.parse_args()

    db = _abs_db_path(args.db)
    if args.backup:
        backup = f"{db}.bak-dm-wipe-{int(time.time())}"
        shutil.copy2(db, backup)
        print("backup", backup)

    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    cur = con.cursor()

    targets = ["dm_reactions", "dm_view_once_views", "dm_messages", "dm_channels"]
    before = {}
    for t in targets:
        if not _table_exists(con, t):
            before[t] = None
            continue
        before[t] = int(cur.execute(f"SELECT COUNT(*) AS c FROM {t}").fetchone()["c"])
    print("before", before)

    for t in targets:
        if not _table_exists(con, t):
            print("skip", t, "missing_table")
            continue
        cur.execute(f"DELETE FROM {t}")
        print("deleted", t, int(cur.rowcount or 0))

    con.commit()
    after = {}
    for t in targets:
        if not _table_exists(con, t):
            after[t] = None
            continue
        after[t] = int(cur.execute(f"SELECT COUNT(*) AS c FROM {t}").fetchone()["c"])
    print("after", after)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

