"""User profile routes."""
import base64
import re
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, Response

import database as db
from deps import get_current_user

router = APIRouter(prefix="/users", tags=["users"])


# ─── Public avatar bytes ──────────────────────────────────────────────
# Discord webhooks (and any external embed) need a public http(s) URL
# that resolves to image bytes. FrogTalk stores avatars as base64
# `data:` URLs in the user row, so we expose a tiny public endpoint
# that decodes and serves them. Avatars are already broadcast in the
# users API and inside every message — this just gives them a stable
# external URL so other platforms can render them.
_DATA_URL_RE = re.compile(
    r"^data:(?P<mime>[\w./+-]+)(?:;[\w=-]+)*?;base64,(?P<b64>[A-Za-z0-9+/=]+)$"
)


# Default frog avatar served when a user has no avatar set so external
# embeds (Discord webhooks, link previews) display the FrogTalk logo
# instead of their platform's grey-default identicon.
_DEFAULT_FROG_AVATAR = "/static/icons/icon-192.png"


@router.get("/{user_id}/avatar.png")
async def get_user_avatar_image(user_id: int):
    """Return the user's avatar bytes as a real image response.

    Public on purpose — avatars are already broadcast inside every
    message payload. Falls back to the default frog icon when the user
    has no avatar (or the stored value isn't a recognized data: URL) so
    Discord and other embed clients show the FrogTalk logo rather than
    their own platform default.
    """
    def _frog_redirect():
        return Response(
            status_code=302,
            headers={
                "Location": _DEFAULT_FROG_AVATAR,
                # Short cache: keeps Discord pulling the latest if the
                # user later sets a real avatar.
                "Cache-Control": "public, max-age=300",
            },
        )

    user = db.get_user_by_id(user_id)
    if not user:
        return _frog_redirect()
    raw = (user.get("avatar") or "").strip()
    if not raw:
        return _frog_redirect()
    m = _DATA_URL_RE.match(raw)
    if not m:
        # Already an http(s) URL — redirect so callers can cache the
        # original CDN-hosted image directly.
        if raw.startswith("http://") or raw.startswith("https://"):
            return Response(status_code=302, headers={"Location": raw})
        # Try a tolerant fallback: split on the first ',' and treat the
        # tail as base64 (some encoders add whitespace/newlines that
        # break the strict regex above).
        if raw.startswith("data:") and "," in raw:
            try:
                head, tail = raw.split(",", 1)
                mime = "image/png"
                if head.startswith("data:") and ";" in head:
                    mime = head[5:].split(";", 1)[0] or mime
                cleaned = "".join(tail.split())
                data = base64.b64decode(cleaned, validate=False)
                return Response(
                    content=data,
                    media_type=mime,
                    headers={"Cache-Control": "public, max-age=86400, immutable"},
                )
            except Exception:
                pass
        return _frog_redirect()
    try:
        data = base64.b64decode(m.group("b64"), validate=False)
    except Exception:
        return _frog_redirect()
    mime = m.group("mime") or "image/png"
    return Response(
        content=data,
        media_type=mime,
        headers={
            # Long cache so Discord and other clients don't hammer us.
            # Avatars get a fresh URL when the user changes them via
            # the cache-bust query param the bridge appends.
            "Cache-Control": "public, max-age=86400, immutable",
        },
    )


@router.get("")
async def list_users(_: dict = Depends(get_current_user)):
    users = db.get_all_users()
    # Never expose password hashes
    return {"users": [{"id": u["id"], "nickname": u["nickname"],
                       "avatar": u["avatar"], "bio": u["bio"],
                       "is_admin": bool(u["is_admin"])} for u in users]}


@router.get("/{user_id}")
async def get_user(user_id: int, _: dict = Depends(get_current_user)):
    user = db.get_user_by_id(user_id)
    if not user:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    return {"id": user["id"], "nickname": user["nickname"],
            "avatar": user["avatar"], "bio": user["bio"],
            "is_admin": bool(user["is_admin"])}


# ─── User blocks ──────────────────────────────────────────────────────────────

@router.post("/{user_id}/block")
async def block_user(user_id: int, current_user: dict = Depends(get_current_user)):
    """Block a user."""
    if user_id == current_user["id"]:
        return JSONResponse(status_code=400, content={"error": "Cannot block yourself"})
    
    target = db.get_user_by_id(user_id)
    if not target:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    
    ok = db.block_user(current_user["id"], user_id)
    if not ok:
        return JSONResponse(status_code=409, content={"error": "User already blocked"})
    return {"ok": True}


@router.delete("/{user_id}/block")
async def unblock_user(user_id: int, current_user: dict = Depends(get_current_user)):
    """Unblock a user."""
    ok = db.unblock_user(current_user["id"], user_id)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "User not blocked"})
    return {"ok": True}


@router.get("/me/blocked")
async def get_blocked_users(current_user: dict = Depends(get_current_user)):
    """Get list of blocked users."""
    return {"blocked": db.get_blocked_users(current_user["id"])}


@router.get("/me/bans")
async def get_my_room_bans(current_user: dict = Depends(get_current_user)):
    """List channels the current user is currently banned from (read-only, self only)."""
    return {"bans": db.get_user_room_bans(current_user["id"])}


@router.get("/{user_id}/aliases")
async def get_user_aliases(user_id: int, current_user: dict = Depends(get_current_user)):
    """Get nickname history for a user (visible to self or admin only)."""
    if user_id != current_user["id"] and not current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Cannot view other users' nickname history"})
    
    history = db.get_nickname_history(user_id)
    return {"aliases": history}
