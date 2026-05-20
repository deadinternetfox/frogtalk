#!/usr/bin/env python3
"""SECURITY-PASS-2 — migrate base64 media blobs out of SQLite.

Walks the tables that historically stored ``data:image/...`` URLs in
their ``media_data`` column, writes the bytes to disk via
``media_storage.store_bytes``, and rewrites the column to a
``ref:<sha256>`` reference. Safe to run incrementally and re-run
(idempotent; already-migrated rows are skipped).

USAGE:

    # Dry run — count affected rows, no writes.
    python3 scripts/migrate_media_to_disk.py --dry-run

    # Migrate up to 500 rows from each table this pass.
    python3 scripts/migrate_media_to_disk.py --limit 500

    # Migrate everything (no limit).
    python3 scripts/migrate_media_to_disk.py

After migration, set ``FROGTALK_MEDIA_OFFLOAD_ENABLED=1`` in the
server env so newly-inserted blobs go straight to disk via
``media_storage.maybe_offload()`` instead of accumulating in SQLite
again.

ROLLBACK:

The original column value (``data:...`` URL) is irrecoverable from
the ref alone after migration — the disk file IS the source of truth.
To roll back, restore SQLite from a backup taken before the migration
window. Always snapshot ``data/frogtalk.db`` before running.

BACKUP:

    cp data/frogtalk.db data/frogtalk.db.pre-media-migrate

CLEANUP:

Orphaned disk blobs (where the referencing row was later deleted) are
not collected by this script. The companion ``--gc`` mode walks the
storage root and removes blobs whose ref is not referenced anywhere
in the message/wall/dm tables. Run it manually during a quiet window.

    python3 scripts/migrate_media_to_disk.py --gc

PARTIAL FAILURE:

If a single row's bytes can't be parsed (corrupt base64, etc.) the
script logs the row id and continues. Use the printed list to
investigate by hand.
"""

import argparse
import logging
import sqlite3
import sys
from pathlib import Path

# Make the repo importable when run from anywhere.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import media_storage  # noqa: E402

_log = logging.getLogger("migrate_media")

# Tables that historically dumped base64 into ``media_data``. Keep the
# list explicit so an accidentally-added column elsewhere isn't
# trampled.
_TABLES = (
    ("messages", "id", "media_data"),
    ("dm_messages", "id", "media_data"),
    ("wall_posts", "id", "media_data"),
)


def _db_path() -> Path:
    repo = Path(__file__).resolve().parent.parent
    p = repo / "data" / "frogtalk.db"
    return p


def _migrate_table(con: sqlite3.Connection, table: str, idcol: str, mcol: str,
                   *, limit: int | None, dry_run: bool) -> dict:
    """Migrate one table; returns a small stats dict."""
    stats = {"scanned": 0, "skipped_small": 0, "skipped_non_data": 0,
             "skipped_ref": 0, "migrated": 0, "errors": 0}
    cur = con.cursor()
    # Only rows whose value is a string starting with 'data:' — bytes
    # we own, base64-encoded. Encrypted ftenc:/refs/URLs are left alone.
    q = f"SELECT {idcol}, {mcol} FROM {table} WHERE {mcol} IS NOT NULL " \
        f"AND length({mcol}) > 0 AND {mcol} LIKE 'data:%'"
    if limit:
        q += f" LIMIT {int(limit)}"
    rows = cur.execute(q).fetchall()
    for rid, val in rows:
        stats["scanned"] += 1
        if not isinstance(val, str):
            stats["skipped_non_data"] += 1
            continue
        if media_storage.is_ref(val):
            stats["skipped_ref"] += 1
            continue
        try:
            ref = media_storage._parse_data_url(val)  # noqa: SLF001
            if not ref:
                stats["skipped_non_data"] += 1
                continue
            data, mime = ref
            if len(data) < media_storage._inline_threshold():  # noqa: SLF001
                stats["skipped_small"] += 1
                continue
            if dry_run:
                stats["migrated"] += 1
                continue
            new_ref = media_storage.store_bytes(data, mime=mime)
            # Store the URL form so existing read paths Just Work
            # (frontend gets a regular src URL, browser sends cookies,
            # serve endpoint auth-checks then returns bytes).
            new_value = media_storage.ref_to_blob_url(new_ref)
            con.execute(
                f"UPDATE {table} SET {mcol}=? WHERE {idcol}=?",
                (new_value, rid),
            )
            stats["migrated"] += 1
        except Exception:
            _log.exception("migrate failed for %s.%s=%s", table, idcol, rid)
            stats["errors"] += 1
    if not dry_run:
        con.commit()
    return stats


def _gc(con: sqlite3.Connection) -> dict:
    """Walk the on-disk storage root and remove any ``.bin`` whose sha256
    is not referenced by any media_data ref:<sha> in the DB.
    Returns counts."""
    referenced: set[str] = set()
    for table, _, mcol in _TABLES:
        # Two forms in the column: legacy `ref:<sha>` and the URL form
        # `/api/media/blob/<sha>` we store going forward.
        for like in ("ref:%", "/api/media/blob/%"):
            cur = con.execute(
                f"SELECT {mcol} FROM {table} WHERE {mcol} LIKE ?",
                (like,),
            )
            for (val,) in cur.fetchall():
                if media_storage.is_ref(val):
                    referenced.add(val[len("ref:"):])
                else:
                    rref = media_storage.blob_url_to_ref(val)
                    if rref:
                        referenced.add(rref[len("ref:"):])
    root = media_storage._root()  # noqa: SLF001
    scanned = 0
    removed = 0
    for path in root.rglob("*.bin"):
        scanned += 1
        digest = path.stem
        if digest not in referenced:
            try:
                path.unlink()
                meta = path.with_suffix(".meta")
                if meta.exists():
                    meta.unlink()
                removed += 1
            except Exception:
                _log.exception("gc failed for %s", path)
    return {"scanned": scanned, "removed": removed, "referenced": len(referenced)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=str(_db_path()), help="Path to frogtalk.db")
    ap.add_argument("--dry-run", action="store_true", help="Count only, no writes")
    ap.add_argument("--limit", type=int, default=0,
                    help="Max rows per table (0 = unlimited)")
    ap.add_argument("--gc", action="store_true",
                    help="Garbage-collect orphan disk blobs after migration")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    if not Path(args.db).exists():
        _log.error("DB not found: %s", args.db)
        return 2
    con = sqlite3.connect(args.db, timeout=30.0)
    con.row_factory = None
    # WAL keeps the migration non-blocking for readers.
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
    except Exception:
        pass
    total = {"migrated": 0, "errors": 0}
    for table, idcol, mcol in _TABLES:
        stats = _migrate_table(
            con, table, idcol, mcol,
            limit=args.limit or None,
            dry_run=args.dry_run,
        )
        total["migrated"] += stats["migrated"]
        total["errors"] += stats["errors"]
        _log.info("table=%s stats=%s", table, stats)
    if args.gc:
        gc_stats = _gc(con)
        _log.info("gc stats=%s", gc_stats)
    _log.info("done. migrated=%s errors=%s dry_run=%s",
              total["migrated"], total["errors"], args.dry_run)
    return 0 if total["errors"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
