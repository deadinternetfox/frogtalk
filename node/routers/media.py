"""Auth-gated media blob serving.

SECURITY-PASS-2 — companion to ``media_storage.py``. Returns the bytes
behind a ``ref:<sha256>`` reference to authenticated users, with strict
Content-Type/Content-Disposition handling so a stored polyglot cannot
be rendered as active content on the site origin.

Authentication
--------------
Every read requires a valid session (`get_current_user`). There is no
"public media" path — operators who want public link unfurls/avatars
should serve those from /static/ or from the imageboard's separately-
hardened /board_uploads/ location.

Authorization
-------------
The current minimal cut grants read to ANY authenticated user. This
endpoint may later be extended to verify that the caller is a
participant of the room/DM/wall post referencing this ref. The
``ref:<sha256>`` value is content-addressed and not enumerable, so
the gap until then only matters if a token is stolen.
"""

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status

import media_storage
from deps import get_current_user

_log = logging.getLogger(__name__)
router = APIRouter(prefix="/media")


@router.get("/blob/{ref}")
async def get_blob(
    ref: str,
    _current_user: dict = Depends(get_current_user),
    if_none_match: str | None = Header(default=None, alias="If-None-Match"),
):
    """Stream the bytes behind `ref:<sha256>` to an authenticated caller.

    Returns:
        * 200 + body with the original MIME if it's in the safe inline
          set, otherwise application/octet-stream + attachment disposition.
        * 304 if the client sends a matching If-None-Match.
        * 400 if the ref is malformed.
        * 401 if not authenticated (handled by Depends).
        * 404 if the ref doesn't exist on disk.
    """
    if not media_storage.is_ref(ref if ref.startswith("ref:") else f"ref:{ref}"):
        # We accept the caller passing either "ref:<sha>" or just "<sha>"
        # so URLs stay short. Validate either form.
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid media ref")
    canonical = ref if ref.startswith("ref:") else f"ref:{ref}"
    digest = canonical[len("ref:"):]
    etag = f'"{digest[:32]}"'
    if if_none_match and if_none_match.strip() == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED)
    try:
        data, mime = media_storage.read_bytes(canonical)
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media not found")
    except media_storage.InvalidMediaRef:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid media ref")
    safe_inline = media_storage.is_safe_inline_mime(mime)
    response_mime = mime if safe_inline else "application/octet-stream"
    headers = {
        "Cache-Control": "private, max-age=86400, immutable",
        "ETag": etag,
        # nosniff so polyglots can't be reinterpreted as HTML by the
        # browser regardless of what mime we set.
        "X-Content-Type-Options": "nosniff",
        # Tight CSP on the response so even if mime is image/svg+xml
        # and our safe-set check lets it through (it doesn't, see
        # `_SAFE_INLINE_MIME`), the SVG cannot script the origin.
        "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
        "Referrer-Policy": "no-referrer",
    }
    if not safe_inline:
        headers["Content-Disposition"] = f'attachment; filename="{digest[:12]}.bin"'
    return Response(content=data, media_type=response_mime, headers=headers)
