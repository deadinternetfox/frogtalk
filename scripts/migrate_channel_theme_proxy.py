#!/usr/bin/env python3
"""Rewrite existing channel_theme.bgImage values to flow through the
new `/api/proxy/image?u=...` endpoint, instead of being fetched
directly from the viewer's browser.

Idempotent: rows whose bgImage is already a same-origin path or already
goes through /api/proxy/image are left untouched.

Run on each node as:

    python3 scripts/migrate_channel_theme_proxy.py

A dry-run mode (no DB writes) is available with --dry-run.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote_plus

# Default to the path used by the systemd unit; override with --db.
DEFAULT_DB = "data/frogtalk.db"


def rewrite_bg(bg: str) -> str | None:
    """Return the new bgImage value, or None if no rewrite needed."""
    if not bg or not isinstance(bg, str):
        return None
    bg = bg.strip()
    if bg.startswith("/api/proxy/image?"):
        return None  # already proxied
    if re.match(r"^https?://", bg, re.IGNORECASE):
        return f"/api/proxy/image?u={quote_plus(bg)}"
    return None  # same-origin / absolute path — leave alone


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=DEFAULT_DB, help="Path to the SQLite DB")
    p.add_argument("--dry-run", action="store_true",
                   help="Print what would change without writing")
    args = p.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"Database not found: {db_path}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute("SELECT id, name, channel_theme FROM rooms "
                "WHERE channel_theme IS NOT NULL AND channel_theme != ''")
    rows = cur.fetchall()
    rewrites = 0
    skipped = 0
    errors = 0
    for row in rows:
        raw = row["channel_theme"]
        try:
            data = json.loads(raw)
        except Exception:
            errors += 1
            print(f"  [#{row['id']}] {row['name']}: JSON parse error", file=sys.stderr)
            continue
        if not isinstance(data, dict):
            skipped += 1
            continue
        bg = data.get("bgImage")
        new_bg = rewrite_bg(bg) if bg else None
        if not new_bg:
            skipped += 1
            continue

        data["bgImage"] = new_bg
        new_json = json.dumps(data, separators=(",", ":"))
        print(f"  [#{row['id']}] {row['name']}:\n      {bg!s:.80}\n   -> {new_bg!s:.80}")
        if not args.dry_run:
            cur.execute("UPDATE rooms SET channel_theme = ? WHERE id = ?",
                        (new_json, row["id"]))
        rewrites += 1

    if not args.dry_run:
        conn.commit()
    conn.close()

    print(f"\nTotal: {len(rows)}  rewrote: {rewrites}  skipped: {skipped}  errors: {errors}")
    if args.dry_run:
        print("(dry-run — no changes written)")
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
