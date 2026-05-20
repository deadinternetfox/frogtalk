"""FrogTalk media storage abstraction.

SECURITY-PASS-2 — replaces the historic pattern of stuffing base64
image/audio/video blobs directly into the ``messages.media_data``,
``dm_messages.media_data``, ``wall_posts.media_data`` etc. columns.

Why this is needed
------------------
- SQLite + 100 MB base64 strings per row destroys the page cache: every
  query that *doesn't* SELECT media_data still has to walk pages
  containing it because rows are stored together.
- WAL grows unboundedly during bulk insert (Discord bridge importing a
  photo album = tens of MB committed in one transaction).
- ``VACUUM`` on a 4 GB DB takes >5 min and blocks writes.
- Backups blow up.

What this module does
---------------------
- One shared module, used by message + DM + wall + story + sticker
  inserts going forward.
- Bytes land on disk under ``data/media/<aa>/<bb>/<full_sha256>.bin``.
  The two-level fan-out keeps directory sizes manageable even at
  millions of blobs.
- Reference returned to callers is opaque: ``ref:<sha256>`` (NOT a
  URL — callers can map the ref to whatever serving scheme they
  prefer; the FastAPI endpoint at ``/api/media/blob/{ref}`` is
  the supported public path).
- Content-addressed: identical blobs dedupe to one disk file.
- Refs are validated with a strict regex before any filesystem access
  so user-supplied data can never escape the storage root.
- The storage root is created with mode 0700, never world-readable.

Migration / backfill
--------------------
The companion script ``scripts/migrate_media_to_disk.py`` walks the
existing ``messages`` / ``dm_messages`` / ``wall_posts`` tables, moves
each oversized inline blob onto disk, and rewrites the column to the
ref. It is idempotent and safe to run incrementally during a window
when writes can be paused (or with the WAL checkpoint flag).

Environment toggles
-------------------
``FROGTALK_MEDIA_DIR``
    Override the storage root. Default: ``<repo>/data/media``.

``FROGTALK_MEDIA_OFFLOAD_ENABLED``
    When ``1``, ``maybe_offload()`` actually writes to disk and
    returns the ref. When ``0`` (default), it's a no-op that
    returns the input unchanged. This lets operators stage the
    change behind a single flip-able flag.

``FROGTALK_MEDIA_INLINE_THRESHOLD_BYTES``
    Max inline blob size to keep in SQLite. Anything larger than this
    when ``maybe_offload()`` is called will be migrated to disk.
    Default: ``32_768`` (32 KB).

``FROGTALK_MEDIA_MAX_BYTES``
    Hard cap on a single stored blob, in bytes. Default: 100 MB.
    Anything larger raises ``MediaTooLarge`` rather than silently
    truncating.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import mimetypes
import os
import re
from pathlib import Path
from typing import Optional

_log = logging.getLogger(__name__)

_REF_PREFIX = "ref:"
# 64 hex chars (sha256). Strict regex so a maliciously crafted ref
# can't traverse out of the storage root or hit a special filename.
_REF_RE = re.compile(r"^ref:([a-f0-9]{64})$")

_DEFAULT_INLINE_THRESHOLD = 32 * 1024          # 32 KB
_DEFAULT_MAX_BYTES = 100 * 1024 * 1024         # 100 MB hard cap

# Subset of safe MIME types we actually serve back inline. Anything
# outside this set still stores fine but is served as
# ``application/octet-stream`` with ``Content-Disposition: attachment``
# so a polyglot upload cannot be rendered as HTML/script.
_SAFE_INLINE_MIME = frozenset({
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
    "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/mp4", "audio/aac",
    "video/mp4", "video/webm", "video/ogg",
})


class MediaTooLarge(ValueError):
    """Raised when a blob exceeds FROGTALK_MEDIA_MAX_BYTES."""


class InvalidMediaRef(ValueError):
    """Raised when a ref string doesn't match the strict pattern."""


def _root() -> Path:
    root = os.getenv("FROGTALK_MEDIA_DIR")
    if not root:
        root = str(Path(__file__).parent / "data" / "media")
    p = Path(root)
    p.mkdir(parents=True, exist_ok=True)
    try:
        # Restrict permissions on first create; idempotent chmod
        # on subsequent calls is cheap.
        os.chmod(p, 0o700)
    except Exception:
        pass
    return p


def _inline_threshold() -> int:
    raw = os.getenv("FROGTALK_MEDIA_INLINE_THRESHOLD_BYTES", "")
    try:
        return int(raw) if raw else _DEFAULT_INLINE_THRESHOLD
    except ValueError:
        return _DEFAULT_INLINE_THRESHOLD


def _max_bytes() -> int:
    raw = os.getenv("FROGTALK_MEDIA_MAX_BYTES", "")
    try:
        return int(raw) if raw else _DEFAULT_MAX_BYTES
    except ValueError:
        return _DEFAULT_MAX_BYTES


def is_ref(value: Optional[str]) -> bool:
    """Quick check for the ref sentinel."""
    return isinstance(value, str) and value.startswith(_REF_PREFIX) and bool(_REF_RE.match(value))


def _path_for_ref(ref: str) -> Path:
    m = _REF_RE.match(ref)
    if not m:
        raise InvalidMediaRef(f"invalid media ref: {ref!r}")
    digest = m.group(1)
    return _root() / digest[:2] / digest[2:4] / f"{digest}.bin"


def store_bytes(payload: bytes, *, mime: str | None = None) -> str:
    """Write `payload` to disk under its sha256 and return the ref.

    Idempotent: if a file with this sha256 already exists, no rewrite.
    Refuses payloads larger than ``FROGTALK_MEDIA_MAX_BYTES``.
    """
    if not isinstance(payload, (bytes, bytearray)):
        raise TypeError("store_bytes: payload must be bytes")
    size = len(payload)
    cap = _max_bytes()
    if size > cap:
        raise MediaTooLarge(f"blob {size} > max {cap}")
    digest = hashlib.sha256(payload).hexdigest()
    target = _path_for_ref(f"{_REF_PREFIX}{digest}")
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        # Write to tmp + rename so a crash mid-write doesn't leave a
        # partial file that looks valid (sha256 check would fail).
        tmp = target.with_suffix(".tmp")
        with open(tmp, "wb") as f:
            f.write(payload)
        os.replace(tmp, target)
        try:
            os.chmod(target, 0o600)
        except Exception:
            pass
        # Sidecar with mime + size for the serve endpoint; tiny JSON
        # next to the blob keeps DB-only reads possible (no separate
        # lookup table needed).
        sidecar = target.with_suffix(".meta")
        try:
            import json
            sidecar.write_text(
                json.dumps({"mime": mime or "application/octet-stream", "size": size}),
                encoding="utf-8",
            )
            os.chmod(sidecar, 0o600)
        except Exception:
            _log.exception("media_storage: sidecar write failed for %s", digest[:12])
    return f"{_REF_PREFIX}{digest}"


def read_bytes(ref: str) -> tuple[bytes, str]:
    """Return (bytes, mime) for an existing ref.

    Raises ``FileNotFoundError`` if the ref does not exist on disk.
    Raises ``InvalidMediaRef`` for malformed refs.
    """
    p = _path_for_ref(ref)
    if not p.exists():
        raise FileNotFoundError(f"media ref not found: {ref}")
    data = p.read_bytes()
    mime = "application/octet-stream"
    sidecar = p.with_suffix(".meta")
    if sidecar.exists():
        try:
            import json
            meta = json.loads(sidecar.read_text(encoding="utf-8") or "{}")
            mime = str(meta.get("mime") or mime)
        except Exception:
            pass
    return data, mime


def exists(ref: str) -> bool:
    try:
        return _path_for_ref(ref).exists()
    except InvalidMediaRef:
        return False


def delete(ref: str) -> bool:
    """Best-effort delete. Returns True if a file was removed."""
    try:
        p = _path_for_ref(ref)
    except InvalidMediaRef:
        return False
    removed = False
    try:
        if p.exists():
            p.unlink()
            removed = True
        sidecar = p.with_suffix(".meta")
        if sidecar.exists():
            sidecar.unlink()
    except Exception:
        _log.exception("media_storage.delete failed for %s", ref[:20])
    return removed


def is_safe_inline_mime(mime: str | None) -> bool:
    return isinstance(mime, str) and mime.lower() in _SAFE_INLINE_MIME


def guess_mime_from_extension(name: str | None) -> str | None:
    if not name:
        return None
    guess, _ = mimetypes.guess_type(name)
    return guess


def offload_enabled() -> bool:
    return (os.getenv("FROGTALK_MEDIA_OFFLOAD_ENABLED") or "0").strip().lower() in ("1", "true", "yes", "on")


# ── Convenience helpers used by save paths ─────────────────────────────────
def _parse_data_url(value: str) -> tuple[bytes, str] | None:
    """If `value` looks like a data: URL, return (bytes, mime). Else None."""
    if not isinstance(value, str) or not value.startswith("data:"):
        return None
    try:
        header, b64 = value.split(",", 1)
    except ValueError:
        return None
    mime = "application/octet-stream"
    if header.endswith(";base64"):
        spec = header[len("data:"):-len(";base64")]
        if spec:
            mime = spec
    else:
        # Non-base64 data URLs are rare in our flows and harder to
        # store safely (URL encoding) — leave them alone.
        return None
    try:
        data = base64.b64decode(b64, validate=True)
    except Exception:
        return None
    return data, mime


_BLOB_URL_PREFIX = "/api/media/blob/"


def ref_to_blob_url(ref: str) -> str:
    """Convert a ``ref:<sha256>`` to the serving URL.
    Inverse of `blob_url_to_ref`.
    """
    if not is_ref(ref):
        raise InvalidMediaRef(ref)
    return _BLOB_URL_PREFIX + ref[len(_REF_PREFIX):]


def blob_url_to_ref(value: str | None) -> str | None:
    """If `value` is a `/api/media/blob/<sha>` URL, return the canonical
    `ref:<sha>` string. Otherwise return None.
    """
    if not isinstance(value, str):
        return None
    if not value.startswith(_BLOB_URL_PREFIX):
        return None
    tail = value[len(_BLOB_URL_PREFIX):]
    # Strip any cache-buster query string the frontend may add.
    tail = tail.split("?", 1)[0].split("#", 1)[0]
    if not re.match(r"^[a-f0-9]{64}$", tail):
        return None
    return _REF_PREFIX + tail


def maybe_offload(media_data: str | None) -> str | None:
    """Decide whether to keep a ``media_data`` value inline or move it to disk.

    Returns:
        * the input unchanged when offloading is disabled, the value is
          too small, the value is already an offloaded URL, the value is
          non-data: text (e.g. encrypted ``ftenc:`` payload or a URL),
          OR offload is disabled by env;
        * a ``/api/media/blob/<sha256>`` URL when the value was
          successfully moved to disk. The URL form is what gets stored
          in the column so existing read paths can hand it directly to
          ``<img src>`` / ``<video src>`` etc. — the browser
          authenticates the GET via the session cookie/header just
          like any other API call.

    This function is called from inside save paths AFTER all server-side
    validation (size cap, MIME whitelist) has already accepted the
    payload. Failures are logged and the original value is returned —
    we never want to fail a message insert because of a disk hiccup.
    """
    if media_data is None or not isinstance(media_data, str):
        return media_data
    # Already migrated (either form): leave alone.
    if is_ref(media_data) or blob_url_to_ref(media_data):
        return media_data
    if not offload_enabled():
        return media_data
    # Quick size gate: don't even parse data URLs that are below the
    # inline threshold (e.g. tiny emoji icons, sticker pack thumbnails).
    if len(media_data) < _inline_threshold():
        return media_data
    parsed = _parse_data_url(media_data)
    if not parsed:
        # Encrypted ciphertext (ftenc:…) and plain URL refs go through
        # unchanged — they're not raw bytes we own.
        return media_data
    data, mime = parsed
    if len(data) < _inline_threshold():
        return media_data
    try:
        ref = store_bytes(data, mime=mime)
        return ref_to_blob_url(ref)
    except MediaTooLarge:
        # Bubble the size cap up to the caller — they should already
        # have enforced their own limit but if we got here the row
        # would violate the global max.
        raise
    except Exception:
        _log.exception("media_storage.maybe_offload failed; keeping inline")
        return media_data
