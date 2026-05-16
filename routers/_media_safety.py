"""Centralised safety helpers for any endpoint that serves user-uploaded
binary content back to the browser.

The threat model is straightforward: a user uploads a `data:` URL whose
claimed mime is renderable by the browser as active content (e.g.
`text/html`, `image/svg+xml`, `application/xhtml+xml`,
`application/xml`). Nothing in the upload pipeline transcodes the bytes,
so without a serve-time guard the same bytes come back out with the
attacker-controlled Content-Type and the browser executes script in our
origin — stored XSS that survives any client-side escaping.

`safe_media_type()` collapses any non-whitelisted mime down to
`application/octet-stream`, and `media_response_headers()` adds the
defence-in-depth headers (`X-Content-Type-Options: nosniff`,
`Content-Disposition: inline; filename="…"`, plus a sandbox CSP that
disables script execution even if a future bug serves HTML by mistake).

The whitelist is intentionally narrow — only image/audio/video formats
the FrogTalk client actually renders inline. Everything else is forced
to download as an opaque blob.
"""
from __future__ import annotations

import re
from typing import Optional

# Renderable formats the FrogTalk client UI actually uses. Anything not
# in this set is collapsed to application/octet-stream so the browser
# treats it as a download instead of executing it.
_SAFE_IMAGE_MIMES = frozenset({
    "image/jpeg", "image/jpg", "image/png", "image/gif",
    "image/webp", "image/avif", "image/heic", "image/heif",
})
_SAFE_VIDEO_MIMES = frozenset({
    "video/mp4", "video/webm", "video/ogg", "video/quicktime",
    "video/x-matroska",
})
_SAFE_AUDIO_MIMES = frozenset({
    "audio/mpeg", "audio/mp3", "audio/mp4", "audio/aac",
    "audio/ogg", "audio/webm", "audio/wav", "audio/x-wav",
    "audio/flac",
})
SAFE_MEDIA_MIMES = _SAFE_IMAGE_MIMES | _SAFE_VIDEO_MIMES | _SAFE_AUDIO_MIMES

# Explicit deny-list of dangerous mimes the browser would render as
# active content even with nosniff. Listed for documentation; anything
# not in SAFE_MEDIA_MIMES is already collapsed by safe_media_type().
_DANGEROUS_MIMES = frozenset({
    "image/svg+xml",         # SVG can host <script>
    "text/html", "text/xml",
    "application/xhtml+xml", "application/xml",
    "application/javascript", "application/ecmascript", "text/javascript",
    "application/pdf",       # JS-in-PDF execution in some readers
    "application/x-shockwave-flash",
})

_DATA_URL_RE = re.compile(
    r"^data:(?P<mime>[\w./+-]+)(?:;[\w=-]+)*?(?P<b64>;base64)?,",
    re.IGNORECASE,
)

# Strip bidirectional override + invisible direction-control characters
# from any user-supplied filename before display. Without this, an
# attacker could name a file `evil.exe\u202epng.txt` and have it render
# in the chat bubble as `evil.txtgnp.exe` — the classic RTLO trick.
_BIDI_CONTROLS = re.compile(r"[\u202a-\u202e\u2066-\u2069\u200e\u200f]")
_NULL_AND_CTRL = re.compile(r"[\x00-\x1f\x7f]")


def safe_media_type(claimed: Optional[str]) -> str:
    """Return `claimed` if it's in the safe whitelist, else
    `application/octet-stream`.

    The check is case-insensitive and ignores any `;parameters` suffix
    (e.g. `image/jpeg; charset=binary` → `image/jpeg`).
    """
    if not claimed:
        return "application/octet-stream"
    s = str(claimed).strip().lower()
    if ";" in s:
        s = s.split(";", 1)[0].strip()
    if s in SAFE_MEDIA_MIMES:
        return s
    return "application/octet-stream"


def safe_filename(name: Optional[str], default: str = "file") -> str:
    """Strip control characters, bidi overrides, path separators and
    trim length so the filename is safe for both Content-Disposition
    headers and any client-side render."""
    if not name:
        return default
    s = str(name)
    s = _BIDI_CONTROLS.sub("", s)
    s = _NULL_AND_CTRL.sub("", s)
    # Take the leaf only — refuse to serve a filename containing a path.
    for sep in ("/", "\\"):
        if sep in s:
            s = s.rsplit(sep, 1)[-1]
    s = s.strip().strip(".")
    if not s:
        return default
    return s[:120]


def media_response_headers(
    safe_mime: str,
    *,
    filename: Optional[str] = None,
    cache_control: str = "private, max-age=86400, immutable",
    inline: bool = True,
) -> dict:
    """Build the response headers used by every endpoint that serves
    raw user-uploaded bytes.

    `safe_mime` MUST already have been passed through `safe_media_type()`
    — this helper does not re-validate it.

    `inline=True` lets the browser render images/audio/video inline
    (the normal case for chat attachments). When the mime collapsed to
    `application/octet-stream` we force `attachment` so the browser
    downloads the blob instead of trying to interpret it.
    """
    is_safe = safe_mime in SAFE_MEDIA_MIMES
    disposition_kind = "inline" if (inline and is_safe) else "attachment"
    fname = safe_filename(filename, default="file")
    headers = {
        "Cache-Control": cache_control,
        # Even with a known-safe mime, never let a sniffer downgrade us
        # to text/html.
        "X-Content-Type-Options": "nosniff",
        # Defence-in-depth: if a bug ever serves HTML/SVG with this
        # header set, the sandbox CSP forbids script execution.
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'unsafe-inline'",
        "Content-Disposition": f'{disposition_kind}; filename="{fname}"',
    }
    return headers


def is_safe_data_url(data_url: Optional[str]) -> bool:
    """Return True iff `data_url` is a `data:<mime>;base64,...` URL whose
    claimed mime is in the safe whitelist. Used at upload-validation
    time to refuse SVG/HTML/PDF/etc. before they reach the database.

    Note: this only checks the CLAIMED mime — magic-byte verification
    is a separate layer, applied in `routers/emojis.py` for the few
    endpoints where it's affordable (small payloads). Most multi-MB
    upload paths can't decode at the edge, so the serve-time guard in
    `safe_media_type()` is the load-bearing defence.
    """
    if not data_url:
        return False
    m = _DATA_URL_RE.match(str(data_url))
    if not m:
        return False
    mime = (m.group("mime") or "").strip().lower()
    return mime in SAFE_MEDIA_MIMES


__all__ = [
    "SAFE_MEDIA_MIMES",
    "safe_media_type",
    "safe_filename",
    "media_response_headers",
    "is_safe_data_url",
]
