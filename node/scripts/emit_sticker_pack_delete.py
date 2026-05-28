#!/usr/bin/env python3
"""Emit sticker.pack.delete for one or more native pack ids (fleet cleanup helper).

  cd /opt/frogtalk/node && /opt/frogtalk/venv/bin/python scripts/emit_sticker_pack_delete.py 3 7
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import database as db


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: emit_sticker_pack_delete.py <pack_id> [pack_id ...]", file=sys.stderr)
        return 1
    pack_ids = []
    for arg in sys.argv[1:]:
        try:
            pack_ids.append(int(arg))
        except ValueError:
            print(f"invalid pack id: {arg}", file=sys.stderr)
            return 1

    from routers import federation as fed

    emitted = 0
    for pack_id in pack_ids:
        res = fed.enqueue_server_event("sticker.pack.delete", {"pack_id": pack_id})
        if res.get("ok"):
            print(f"enqueued delete pack_id={pack_id} event_id={res.get('event_id')}")
            emitted += 1
        else:
            print(f"failed pack_id={pack_id}: {res.get('error')}", file=sys.stderr)

    # Nudge outbox delivery if the worker is idle.
    try:
        with db._conn() as con:
            pending = con.execute(
                "SELECT COUNT(*) FROM federation_outbox WHERE status='pending'"
            ).fetchone()[0]
        print(f"pending outbox rows: {pending}")
    except Exception:
        pass
    return 0 if emitted == len(pack_ids) else 1


if __name__ == "__main__":
    raise SystemExit(main())
