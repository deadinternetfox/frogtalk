"""Custom emoji routes — personal account + per-channel collections."""
import base64
import re
from typing import List, Optional, Tuple

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import database as db
from deps import get_current_user
from routers._media_safety import is_safe_data_url

router = APIRouter(prefix="/emojis", tags=["emojis"])

EMOJI_NAME_RE = re.compile(r"^[a-z0-9_]{2,32}$")
_EMOJI_DATA_URL_RE = re.compile(
    r"^data:image/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$",
    re.IGNORECASE,
)
MAX_EMOJI_SIZE = 256 * 1024  # 256KB max


class AddEmojiRequest(BaseModel):
    name: str
    image_data: str
    room_id: Optional[int] = None
    is_global: bool = False  # legacy; channel emojis use room_id


class ImportEmojiRequest(BaseModel):
    emoji_id: int


class ResolveEmojiRequest(BaseModel):
    names: List[str]
    room_id: Optional[int] = None


def _validate_emoji_image_data(image_data: str) -> Tuple[Optional[str], Optional[str]]:
    """Return (normalized_data_url, error_message). Rejects SVG/HTML polyglots."""
    raw_in = str(image_data or "").strip()
    if not raw_in.startswith("data:image/"):
        return None, "Invalid image format"
    if not is_safe_data_url(raw_in):
        return None, "Only PNG, JPEG, WebP, or GIF emojis are allowed"
    if not _EMOJI_DATA_URL_RE.fullmatch(raw_in):
        return None, "Invalid image data URL"
    try:
        comma = raw_in.find(",")
        payload = base64.b64decode(raw_in[comma + 1 :], validate=True)
    except Exception:
        return None, "Invalid base64 image data"
    if len(payload) < 8:
        return None, "Image too small"
    if len(payload) > MAX_EMOJI_SIZE:
        return None, "Image too large (max 256KB)"
    is_png = payload[:8] == b"\x89PNG\r\n\x1a\n"
    is_jpeg = payload[:3] == b"\xff\xd8\xff"
    is_gif = payload[:6] in (b"GIF87a", b"GIF89a")
    is_webp = payload[:4] == b"RIFF" and len(payload) >= 12 and payload[8:12] == b"WEBP"
    if not (is_png or is_jpeg or is_gif or is_webp):
        return None, "Image bytes don't match a supported raster format"
    return raw_in, None


def _sanitize_rows(rows: list) -> list:
    safe = []
    for row in rows:
        data, err = _validate_emoji_image_data(row.get("image_data") or "")
        if err or not data:
            continue
        out = dict(row)
        out["image_data"] = data
        safe.append(out)
    return safe


def _room_mod_ok(room_id: int, user: dict) -> bool:
    if bool(user.get("is_admin")):
        return True
    with db._conn() as con:
        room = con.execute("SELECT name FROM rooms WHERE id=?", (int(room_id),)).fetchone()
    if not room:
        return False
    return db.can_moderate_room(room["name"], user["id"], False)


@router.get("")
async def list_emojis_legacy(current_user: dict = Depends(get_current_user)):
    """Legacy list — returns personal emojis only (not other users')."""
    emojis = db.get_user_custom_emojis(current_user["id"])
    return {"emojis": _sanitize_rows(emojis)}


@router.get("/mine")
async def list_my_emojis(current_user: dict = Depends(get_current_user)):
    emojis = db.get_user_custom_emojis(current_user["id"])
    return {"emojis": _sanitize_rows(emojis)}


@router.get("/room/{room_id}")
async def list_room_emojis(room_id: int, current_user: dict = Depends(get_current_user)):
    if not db.is_room_member(current_user["id"], room_id):
        return JSONResponse(status_code=403, content={"error": "Not a member of this channel"})
    emojis = db.get_room_custom_emojis(room_id)
    return {"emojis": _sanitize_rows(emojis)}


@router.get("/render")
async def list_render_emojis(
    room_id: Optional[int] = Query(None),
    current_user: dict = Depends(get_current_user),
):
    """Emojis available to render :name: in the current channel view."""
    if room_id is not None and not db.is_room_member(current_user["id"], room_id):
        return JSONResponse(status_code=403, content={"error": "Not a member of this channel"})
    emojis = db.get_custom_emojis_for_render(current_user["id"], room_id)
    return {"emojis": _sanitize_rows(emojis)}


@router.post("/resolve")
async def resolve_emojis(body: ResolveEmojiRequest, current_user: dict = Depends(get_current_user)):
    names = [str(n).lower().strip() for n in (body.names or []) if EMOJI_NAME_RE.match(str(n).lower())]
    if not names:
        return {"emojis": []}
    rid = body.room_id
    if rid is not None and not db.is_room_member(current_user["id"], rid):
        return JSONResponse(status_code=403, content={"error": "Not a member of this channel"})
    found = {}
    for row in db.get_custom_emojis_for_render(current_user["id"], rid):
        if row["name"] in names:
            found[row["name"]] = row
    out = _sanitize_rows(list(found.values()))
    return {"emojis": out}


@router.post("")
async def add_emoji(body: AddEmojiRequest, current_user: dict = Depends(get_current_user)):
    name = body.name.lower()
    if not EMOJI_NAME_RE.match(name):
        return JSONResponse(
            status_code=400,
            content={"error": "Emoji name must be 2-32 lowercase letters, numbers, or underscores"},
        )

    image_data, img_err = _validate_emoji_image_data(body.image_data)
    if img_err:
        return JSONResponse(status_code=400, content={"error": img_err})

    room_id = body.room_id
    if room_id is not None:
        if not _room_mod_ok(int(room_id), current_user):
            return JSONResponse(status_code=403, content={"error": "Only channel mods can add channel emojis"})
    elif body.is_global and bool(current_user.get("is_admin")):
        pass  # legacy server flag — prefer room_id

    emoji_id = db.add_custom_emoji(
        name,
        image_data,
        current_user["id"],
        room_id=int(room_id) if room_id is not None else None,
        is_global=bool(body.is_global) and room_id is None,
    )
    if emoji_id is None:
        return JSONResponse(status_code=409, content={"error": "Emoji name already exists in this collection"})

    return {"ok": True, "id": emoji_id, "name": name}


@router.post("/import")
async def import_emoji(body: ImportEmojiRequest, current_user: dict = Depends(get_current_user)):
    result = db.import_custom_emoji_to_user(current_user["id"], int(body.emoji_id))
    if not result.get("ok"):
        err = result.get("error") or "import_failed"
        code = 404 if err == "not_found" else 409
        return JSONResponse(status_code=code, content={"error": err})
    row = db.get_custom_emoji_by_id(int(result["id"])) if result.get("id") else None
    safe = _sanitize_rows([row]) if row else []
    return {
        "ok": True,
        "skipped": bool(result.get("skipped")),
        "id": result.get("id"),
        "name": result.get("name"),
        "emoji": safe[0] if safe else None,
    }


@router.delete("/{emoji_id}")
async def delete_emoji(emoji_id: int, current_user: dict = Depends(get_current_user)):
    ok = db.delete_custom_emoji(emoji_id, current_user["id"], bool(current_user.get("is_admin")))
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Not found or not authorized"})
    return {"ok": True}
