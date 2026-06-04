#!/usr/bin/env python3
"""Run the one-time data backfills/repairs that used to live in database._migrate().

These were pulled out of the boot path so production code no longer runs data
migrations at startup. Every step is idempotent — safe to run any time, and a
no-op once applied. Run this once after deploying/upgrading a node:

    cd /opt/frogtalk/node && /opt/frogtalk/venv/bin/python scripts/run_data_migrations.py            # dry-run (default)
    cd /opt/frogtalk/node && /opt/frogtalk/venv/bin/python scripts/run_data_migrations.py --apply    # execute (snapshots the DB first)

Covers (each previously auto-ran inside database._migrate()):
  * users.theme                                  default 'frog' palette for rows with no theme set
  * users.global_user_id                         assign a UUID to any user missing one
  * rooms.vanity                                 strip vanity slugs from private rooms (invite-only)
  * wall_posts.{reaction,comment,repost}_count   recompute the denormalized engagement counters
  * users.custom_style                           derive from custom_css (delegates to db.backfill_custom_style)
  * custom_emojis.image_hash                     recompute the content hash for rows missing one

Schema setup (CREATE/ALTER/INDEX/TRIGGER, plus the custom_emojis table rebuild) stays in
database._migrate(); only the data backfills moved here. The .app/@frog ownership
consolidation is a separate concern handled by migrate_consolidate_to_app_and_frog.py.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import uuid  # noqa: E402  (path bootstrap must run first)

import database as db  # noqa: E402


def _main_db_file(con) -> str:
    for row in con.execute("PRAGMA database_list").fetchall():
        name = row["name"] if isinstance(row, sqlite3.Row) else row[1]
        if name == "main":
            return (row["file"] if isinstance(row, sqlite3.Row) else row[2]) or ""
    return ""


def _snapshot(db_file: str) -> str:
    ts = time.strftime("%Y%m%d-%H%M%S")
    dest = f"{db_file}.datamig-bak-{ts}"
    src = sqlite3.connect(db_file)
    try:
        out = sqlite3.connect(dest)
        try:
            src.backup(out)
        finally:
            out.close()
    finally:
        src.close()
    return dest


def _count(con, sql, params=()):
    row = con.execute(sql, params).fetchone()
    return int(row[0]) if row else 0


def _has_table(con, name: str) -> bool:
    return bool(
        con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
    )


def _has_col(con, table: str, col: str) -> bool:
    try:
        return col in {r["name"] for r in con.execute(f"PRAGMA table_info({table})").fetchall()}
    except Exception:
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Run one-time data backfills/repairs (idempotent).")
    ap.add_argument("--apply", action="store_true", help="execute changes (default is a dry-run)")
    args = ap.parse_args()

    with db._conn() as con:
        db_file = _main_db_file(con)

        users = _has_table(con, "users")
        rooms = _has_table(con, "rooms")
        walls = _has_table(con, "wall_posts")
        emojis = _has_table(con, "custom_emojis")

        theme_n = _count(con, "SELECT COUNT(*) FROM users WHERE theme IS NULL OR theme=''") if users and _has_col(con, "users", "theme") else 0
        gid_n = _count(con, "SELECT COUNT(*) FROM users WHERE global_user_id IS NULL OR global_user_id=''") if users and _has_col(con, "users", "global_user_id") else 0
        vanity_n = _count(con, "SELECT COUNT(*) FROM rooms WHERE type='private' AND vanity IS NOT NULL") if rooms and _has_col(con, "rooms", "vanity") else 0
        wall_n = _count(con, "SELECT COUNT(*) FROM wall_posts") if walls else 0
        style_n = _count(con, "SELECT COUNT(*) FROM users WHERE COALESCE(custom_style,'')='' AND COALESCE(custom_css,'')<>''") if users and _has_col(con, "users", "custom_style") and _has_col(con, "users", "custom_css") else 0
        emoji_n = _count(con, "SELECT COUNT(*) FROM custom_emojis WHERE COALESCE(image_hash,'')=''") if emojis and _has_col(con, "custom_emojis", "image_hash") else 0

        print("== run_data_migrations ==")
        print(f"  DB file                  : {db_file}")
        print("  --- rows needing work ---")
        print(f"  users missing theme      : {theme_n}")
        print(f"  users missing global id  : {gid_n}")
        print(f"  private rooms w/ vanity  : {vanity_n}")
        print(f"  wall_posts to recount    : {wall_n}")
        print(f"  users custom_style derive: {style_n}")
        print(f"  emojis missing hash      : {emoji_n}")

        if not args.apply:
            print("\n[dry-run] no changes written. Re-run with --apply to execute.")
            return 0

        backup = _snapshot(db_file)
        print(f"\n[apply] DB snapshot: {backup}")

        con.execute("BEGIN IMMEDIATE")
        try:
            if users and _has_col(con, "users", "theme"):
                con.execute("UPDATE users SET theme='frog' WHERE theme IS NULL OR theme=''")
            if users and _has_col(con, "users", "global_user_id"):
                for row in con.execute(
                    "SELECT id FROM users WHERE global_user_id IS NULL OR global_user_id=''"
                ).fetchall():
                    con.execute(
                        "UPDATE users SET global_user_id=? WHERE id=?", (str(uuid.uuid4()), row["id"])
                    )
            if rooms and _has_col(con, "rooms", "vanity"):
                con.execute("UPDATE rooms SET vanity=NULL WHERE type='private' AND vanity IS NOT NULL")
            if walls:
                con.execute(
                    "UPDATE wall_posts SET reaction_count = COALESCE("
                    "(SELECT COUNT(*) FROM wall_post_reactions WHERE post_id = wall_posts.id), 0)"
                )
                con.execute(
                    "UPDATE wall_posts SET comment_count = COALESCE("
                    "(SELECT COUNT(*) FROM wall_comments WHERE post_id = wall_posts.id), 0)"
                )
                con.execute(
                    "UPDATE wall_posts SET repost_count = COALESCE("
                    "(SELECT COUNT(*) FROM wall_reposts WHERE post_id = wall_posts.id), 0)"
                )
            if emojis and _has_col(con, "custom_emojis", "image_hash"):
                for row in con.execute(
                    "SELECT id, image_data FROM custom_emojis WHERE COALESCE(image_hash,'')=''"
                ).fetchall():
                    con.execute(
                        "UPDATE custom_emojis SET image_hash=? WHERE id=?",
                        (db._hash_data_url(row["image_data"] or ""), row["id"]),
                    )
            con.commit()
        except Exception:
            try:
                con.execute("ROLLBACK")
            except Exception:
                pass
            raise
        print("[apply] inline backfills committed.")

    # custom_style derivation uses its own connection/helper.
    try:
        n = db.backfill_custom_style()
        print(f"[apply] custom_style backfilled for {n} users")
    except Exception as exc:
        print(f"[apply] custom_style backfill skipped: {exc!r}")

    print("[apply] data migrations complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
