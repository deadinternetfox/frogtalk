#!/usr/bin/env python3
"""One-shot consolidation: everything belongs to the .app node, @frog owns every channel.

Run ON the frogtalk.app node (it edits that node's live DB):

    cd /opt/frogtalk/node && /opt/frogtalk/venv/bin/python scripts/migrate_consolidate_to_app_and_frog.py            # dry-run (default)
    cd /opt/frogtalk/node && /opt/frogtalk/venv/bin/python scripts/migrate_consolidate_to_app_and_frog.py --apply    # execute (snapshots the DB first)

What it does (idempotent — safe to re-run):
  1. Homes every real account on this node:  users.account_home_server_id = <local server_id>
     (skips the `federation_sync` system account).
  2. Repairs display owner of remote *mirror* rooms: backfills rooms.owner_global_user_id
     from the federation directory index when it's blank (carried over from the old in-app
     `migrate.room_owner_fed_sync.v2` block, which this script replaces).
  3. Hands ownership of every *locally-homed* channel to @frog, mirroring
     database.transfer_room_ownership(): @frog is auto-joined as a member, the previous owner
     is demoted to moderator (the system user is never made a moderator), @frog is pulled from
     the mod list, and rooms.owner_id / rooms.owner_global_user_id are set to @frog.
  4. Re-pushes every public locally-homed channel's directory metadata (description, icon,
     category, tags, owner) to federated peers via channel.directory.updated so tags/categories
     converge across the fleet.

Scope decisions (see the plan):
  * Runs on the .app node only — re-homing accounts on other nodes would flip their local users
    to "traveling" and prune room memberships.
  * Only *locally-homed* rooms change ownership. Genuine remote-mirror rooms (authoritatively
    homed on another node) are left to their real home; hijacking them would corrupt federation.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import database as db  # noqa: E402  (path bootstrap must run first)

SYSTEM_NICK = "federation_sync"
FROG_NICK = "frog"

# A room is "local" (this node owns it) when home_server_id is empty by convention, or — being
# defensive — explicitly stamped with our own server_id. Pass the local server_id as the param.
LOCAL = "(r.home_server_id IS NULL OR r.home_server_id='' OR r.home_server_id=?)"
LOCAL_BARE = "(home_server_id IS NULL OR home_server_id='' OR home_server_id=?)"


def _scalar(con, sql, params=()):
    row = con.execute(sql, params).fetchone()
    if not row:
        return None
    return row[0]


def _main_db_file(con) -> str:
    for row in con.execute("PRAGMA database_list").fetchall():
        # row: (seq, name, file)
        if (row[1] if not isinstance(row, sqlite3.Row) else row["name"]) == "main":
            return (row[2] if not isinstance(row, sqlite3.Row) else row["file"]) or ""
    return ""


def _snapshot(db_file: str) -> str:
    ts = time.strftime("%Y%m%d-%H%M%S")
    dest = f"{db_file}.consolidate-bak-{ts}"
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


def main() -> int:
    ap = argparse.ArgumentParser(description="Consolidate all accounts/rooms onto the .app node + @frog")
    ap.add_argument("--apply", action="store_true", help="execute changes (default is a dry-run)")
    ap.add_argument("--force", action="store_true", help="run even if this node's base_url is not frogtalk.app")
    ap.add_argument("--no-repush", action="store_true", help="skip the directory re-push step")
    args = ap.parse_args()

    with db._conn() as con:
        app_sid = (_scalar(con, "SELECT value FROM config WHERE key='federation.server_id'") or "").strip()
        base_url = (_scalar(con, "SELECT value FROM config WHERE key='federation.base_url'") or "").strip()
        db_file = _main_db_file(con)

        if not app_sid:
            print("ABORT: no federation.server_id in config — is this a real node DB?", file=sys.stderr)
            return 2
        if "frogtalk.app" not in base_url.lower() and not args.force:
            print(
                f"ABORT: this node's base_url is {base_url!r}, not the frogtalk.app node.\n"
                f"       Re-run with --force only if you are certain this is the .app node.",
                file=sys.stderr,
            )
            return 2

        frog = con.execute(
            "SELECT id, COALESCE(global_user_id,'') AS gid FROM users WHERE nickname=? COLLATE NOCASE",
            (FROG_NICK,),
        ).fetchone()
        if not frog:
            print(f"ABORT: no user '@{FROG_NICK}' exists on this node — create it first.", file=sys.stderr)
            return 2
        frog_id = int(frog["id"])
        frog_gid = str(frog["gid"] or "")
        fed_uid = _scalar(con, "SELECT id FROM users WHERE nickname=? COLLATE NOCASE", (SYSTEM_NICK,))
        fed_uid = int(fed_uid) if fed_uid is not None else -1

        # ---- Plan counts (what WOULD change) ----
        users_to_rehome = _scalar(
            con,
            "SELECT COUNT(*) FROM users WHERE nickname<>? COLLATE NOCASE "
            "AND COALESCE(account_home_server_id,'')<>?",
            (SYSTEM_NICK, app_sid),
        )
        rooms_local_total = _scalar(con, f"SELECT COUNT(*) FROM rooms r WHERE {LOCAL}", (app_sid,))
        rooms_to_frog = _scalar(
            con, f"SELECT COUNT(*) FROM rooms r WHERE {LOCAL} AND COALESCE(r.owner_id,0)<>?", (app_sid, frog_id)
        )
        rooms_mirror = _scalar(
            con,
            "SELECT COUNT(*) FROM rooms r WHERE NOT (r.home_server_id IS NULL OR r.home_server_id='' "
            "OR r.home_server_id=?)",
            (app_sid,),
        )
        mirror_gid_backfill = _scalar(
            con,
            "SELECT COUNT(*) FROM rooms r WHERE COALESCE(r.owner_global_user_id,'')='' "
            "AND NOT (r.home_server_id IS NULL OR r.home_server_id='' OR r.home_server_id=?) "
            "AND EXISTS (SELECT 1 FROM federation_channel_index f "
            "            WHERE f.room_name=r.name AND f.tombstoned=0 "
            "              AND COALESCE(f.owner_global_user_id,'')<>'')",
            (app_sid,),
        )
        public_local = _scalar(
            con,
            f"SELECT COUNT(*) FROM rooms r WHERE {LOCAL} AND LOWER(COALESCE(r.type,'public'))='public'",
            (app_sid,),
        )
        peers = _scalar(con, "SELECT COUNT(*) FROM federation_servers WHERE enabled=1") or 0

        print("== consolidate-to-app-and-frog ==")
        print(f"  DB file              : {db_file}")
        print(f"  local server_id      : {app_sid}")
        print(f"  base_url             : {base_url}")
        print(f"  @{FROG_NICK}                 : id={frog_id} gid={frog_gid or '(none)'}")
        print(f"  enabled fed peers    : {peers}")
        print("  --- planned changes ---")
        print(f"  users -> home .app   : {users_to_rehome}")
        print(f"  local rooms total    : {rooms_local_total}")
        print(f"  rooms -> @{FROG_NICK} owner   : {rooms_to_frog}")
        print(f"  mirror rooms (kept)  : {rooms_mirror}")
        print(f"  mirror owner backfill: {mirror_gid_backfill}")
        print(f"  public rooms re-push : {0 if args.no_repush else public_local}")
        if not frog_gid:
            print(f"  WARNING: @{FROG_NICK} has no global_user_id — federated owner display may be blank.")
        if peers == 0:
            print("  WARNING: no enabled federation peers — re-push will queue but go nowhere until the mesh is seeded.")

        if not args.apply:
            print("\n[dry-run] no changes written. Re-run with --apply to execute.")
            return 0

        # ---- Apply ----
        backup = _snapshot(db_file)
        print(f"\n[apply] DB snapshot: {backup}")

        con.execute("BEGIN IMMEDIATE")
        try:
            # 1. Home every real account on this node.
            con.execute(
                "UPDATE users SET account_home_server_id=? WHERE nickname<>? COLLATE NOCASE",
                (app_sid, SYSTEM_NICK),
            )
            # 2. Display repair for remote mirror rooms (replaces old migrate.room_owner_fed_sync.v2 part a).
            con.execute(
                """
                UPDATE rooms SET owner_global_user_id = (
                    SELECT f.owner_global_user_id FROM federation_channel_index f
                     WHERE f.room_name=rooms.name AND f.tombstoned=0
                       AND COALESCE(f.owner_global_user_id,'')<>''
                     ORDER BY f.last_seen_at DESC LIMIT 1)
                 WHERE COALESCE(owner_global_user_id,'')=''
                   AND NOT (home_server_id IS NULL OR home_server_id='' OR home_server_id=?)
                   AND EXISTS (SELECT 1 FROM federation_channel_index f2
                               WHERE f2.room_name=rooms.name AND f2.tombstoned=0
                                 AND COALESCE(f2.owner_global_user_id,'')<>'')
                """,
                (app_sid,),
            )
            # 3. @frog owns every locally-homed channel (mirrors transfer_room_ownership in bulk).
            #    3a. ensure @frog is a member of each local room.
            con.execute(
                f"INSERT OR IGNORE INTO room_members (room_id, user_id) "
                f"SELECT r.id, ? FROM rooms r WHERE {LOCAL}",
                (frog_id, app_sid),
            )
            #    3b. demote the previous (real, non-system) owner to moderator so they keep mod powers.
            con.execute(
                f"INSERT OR IGNORE INTO room_moderators (room_id, user_id, added_by) "
                f"SELECT r.id, r.owner_id, r.owner_id FROM rooms r "
                f"WHERE {LOCAL} AND r.owner_id IS NOT NULL AND r.owner_id<>? AND r.owner_id<>?",
                (app_sid, frog_id, fed_uid),
            )
            #    3c. @frog outranks moderator — remove any @frog mod rows on local rooms.
            con.execute(
                f"DELETE FROM room_moderators WHERE user_id=? AND room_id IN "
                f"(SELECT id FROM rooms WHERE {LOCAL_BARE})",
                (frog_id, app_sid),
            )
            #    3d. set ownership.
            con.execute(
                f"UPDATE rooms SET owner_id=?, owner_global_user_id=? WHERE {LOCAL_BARE}",
                (frog_id, frog_gid, app_sid),
            )
            con.commit()
        except Exception:
            try:
                con.execute("ROLLBACK")
            except Exception:
                pass
            raise
        print("[apply] DB consolidation committed.")

        # 4. Re-push public local channels so tags/categories + new owner federate.
        if args.no_repush:
            print("[apply] re-push skipped (--no-repush).")
            return 0
        names = [
            r["name"]
            for r in con.execute(
                f"SELECT name FROM rooms WHERE {LOCAL_BARE} AND LOWER(COALESCE(type,'public'))='public' "
                f"ORDER BY name",
                (app_sid,),
            ).fetchall()
        ]

    # Import + enqueue outside the DB block; enqueue opens its own connections.
    from routers import federation as fed  # noqa: E402

    ok = 0
    skipped = []
    for name in names:
        try:
            res = fed.enqueue_channel_directory_updated(name)
        except Exception as exc:  # keep going; one bad room shouldn't abort the backfill
            skipped.append((name, f"error: {exc}"))
            continue
        if res.get("ok"):
            ok += 1
        else:
            skipped.append((name, str(res.get("error"))))
    print(f"[apply] re-pushed {ok}/{len(names)} public channels to peers.")
    if skipped:
        print(f"[apply] {len(skipped)} not pushed (non-public/non-authoritative is expected):")
        for name, why in skipped[:20]:
            print(f"          {name}: {why}")
        if len(skipped) > 20:
            print(f"          ... and {len(skipped) - 20} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
