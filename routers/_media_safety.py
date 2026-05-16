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
    "reencode_data_url",
    "safe_reencode",
]


# ─────────────────────────────────────────────────────────────────────
# Pillow re-encode + EXIF strip pipeline (9th-pass hardening, item #12)
# ─────────────────────────────────────────────────────────────────────
# Every user-supplied image (avatar, banner, story, wall, DM attachment)
# can be passed through reencode_data_url() before storage. The pass:
#  - Decodes the data URL.
#  - Forces a Pillow decode so polyglot SVG/HTML payloads dressed up as
#    "image/png" fail loudly instead of silently round-tripping.
#  - Drops EXIF / IPTC / XMP / ICC by re-saving without the `info` dict.
#  - Caps dimensions so a 50000x50000 PNG bomb can't blow up the client.
#  - Re-encodes to the original codec (PNG/JPEG/WEBP/GIF), animated
#    GIF/WEBP frames are walked individually so per-frame metadata is
#    also dropped.
# Pillow is the only new dep; if it's missing we degrade to passthrough.
import base64 as _b64
import io as _io
import logging as _logging

_log = _logging.getLogger("frogtalk.media")
try:
    from PIL import Image as _Image, ImageSequence as _ImageSequence
    _PIL_OK = True
except Exception:                            # pragma: no cover
    _Image = None                            # type: ignore[assignment]
    _ImageSequence = None                    # type: ignore[assignment]
    _PIL_OK = False

_RE_MAX_PIXELS = 25_000_000                  # ~5000x5000
_RE_MAX_EDGE   = 4096
_RE_FORMAT_BY_MIME = {
    "image/png":  "PNG",
    "image/jpeg": "JPEG",
    "image/jpg":  "JPEG",
    "image/webp": "WEBP",
    "image/gif":  "GIF",
}
_RE_MIME_BY_FORMAT = {v: k for k, v in _RE_FORMAT_BY_MIME.items()}


def _re_split_data_url(data_url: str):
    if not isinstance(data_url, str) or not data_url.startswith("data:"):
        return None
    try:
        header, _, payload = data_url.partition(",")
        if not header or not payload or ";base64" not in header:
            return None
        mime = header[5:].split(";", 1)[0].strip().lower()
        if not mime.startswith("image/"):
            return None
        return mime, _b64.b64decode(payload, validate=True)
    except Exception:
        return None


def _re_resize(im):
    w, h = im.size
    if w <= _RE_MAX_EDGE and h <= _RE_MAX_EDGE:
        return im
    scale = _RE_MAX_EDGE / float(max(w, h))
    return im.resize((max(1, int(w * scale)), max(1, int(h * scale))), _Image.LANCZOS)


def reencode_data_url(data_url):
    """Return a sanitised copy of *data_url*. Empty / non-image inputs
    pass through unchanged (so callers can hand us http(s):// URLs and
    None without special-casing). Raises ValueError when the bytes
    claim image/* but Pillow refuses to decode — caller turns that into
    HTTP 400.

    GIF/WEBP that re-encode to a non-animated codec (rare) still keep
    the original mime in the data URL header.
    """
    if not data_url or not _PIL_OK:
        return data_url
    parts = _re_split_data_url(data_url)
    if parts is None:
        return data_url
    mime, raw = parts
    if not raw:
        raise ValueError("empty image payload")
    fmt = _RE_FORMAT_BY_MIME.get(mime, "PNG")
    try:
        im = _Image.open(_io.BytesIO(raw))
        im.load()
    except Exception as e:
        raise ValueError(f"invalid image: {e}") from e
    w, h = im.size
    if w * h > _RE_MAX_PIXELS:
        raise ValueError("image dimensions exceed safety cap")
    out = _io.BytesIO()
    save_kwargs: dict = {}
    is_animated = bool(getattr(im, "is_animated", False))
    if is_animated and fmt in ("GIF", "WEBP"):
        frames, durations = [], []
        for fr in _ImageSequence.Iterator(im):
            f = fr.convert("RGBA" if fmt == "WEBP" else "P")
            f = _re_resize(f)
            frames.append(f.copy())
            durations.append(fr.info.get("duration", 100))
        if not frames:
            raise ValueError("empty animated image")
        save_kwargs.update({
            "save_all": True,
            "append_images": frames[1:],
            "duration": durations,
            "loop": im.info.get("loop", 0),
            "disposal": 2,
        })
        frames[0].save(out, format=fmt, **save_kwargs)
    else:
        if fmt == "JPEG" and im.mode in ("RGBA", "LA", "P"):
            bg = _Image.new("RGB", im.size, (255, 255, 255))
            try:
                rgba = im.convert("RGBA")
                bg.paste(rgba, mask=rgba.split()[-1])
            except Exception:
                bg.paste(im.convert("RGB"))
            im = bg
        elif im.mode == "P":
            im = im.convert("RGBA")
        im = _re_resize(im)
        if fmt == "JPEG":
            save_kwargs.update({"quality": 85, "optimize": True, "progressive": True})
        elif fmt == "PNG":
            save_kwargs.update({"optimize": True})
        elif fmt == "WEBP":
            save_kwargs.update({"quality": 85, "method": 4})
        # NB: we deliberately do not forward `exif=` or `icc_profile=`
        # — that's the metadata strip step.
        im.save(out, format=fmt, **save_kwargs)
    encoded = _b64.b64encode(out.getvalue()).decode("ascii")
    return f"data:{_RE_MIME_BY_FORMAT.get(fmt, mime)};base64,{encoded}"


def safe_reencode(data_url):
    """Best-effort wrapper that never raises. Used on legacy paths
    where rejecting a bad image would be more disruptive than letting
    it through. New endpoints should call reencode_data_url() and
    convert ValueError to HTTP 400."""
    try:
        return reencode_data_url(data_url)
    except Exception as e:
        _log.warning("image re-encode failed, passing through: %s", e)
        return data_url
