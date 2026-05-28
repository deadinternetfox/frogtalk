#!/usr/bin/env python3
"""Remove public sticker catalog rows (federated mirrors, @federated, all public).

Run on each node after deploying sticker federation fixes:

  cd /opt/frogtalk/node && python3 scripts/cleanup_public_stickers.py

Emits sticker.pack.delete for native public packs so peers drop mirrors.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import database as db


def main() -> int:
    deleted_native: list[int] = []
    deleted_other = 0

    with db._conn() as con:
        rows = con.execute(
            """
            SELECT sp.id, sp.origin_server_id, sp.foreign_pack_id, sp.owner_id,
                   u.nickname AS owner_user_nick
            FROM sticker_packs sp
            LEFT JOIN users u ON sp.owner_id = u.id
            WHERE sp.is_public = 1 AND (sp.room_id IS NULL OR sp.room_id = '')
            """
        ).fetchall()

        for row in rows:
            pid = int(row["id"])
            origin = str(row["origin_server_id"] or "").strip()
            owner_id = int(row["owner_id"] or 0)

            if not origin and owner_id > 0:
                deleted_native.append(pid)

            con.execute("DELETE FROM stickers WHERE pack_id=?", (pid,))
            con.execute("DELETE FROM user_sticker_packs WHERE pack_id=?", (pid,))
            con.execute("DELETE FROM sticker_packs WHERE id=?", (pid,))
            deleted_other += 1

    try:
        from routers import federation as fed

        for pack_id in deleted_native:
            fed.enqueue_server_event("sticker.pack.delete", {"pack_id": pack_id})
    except Exception as exc:
        print(f"warning: federation delete emit failed: {exc}", file=sys.stderr)

    print(
        f"Removed {deleted_other} public pack(s); "
        f"emitted federation delete for {len(deleted_native)} native pack(s)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
