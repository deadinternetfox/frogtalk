"""Custom emoji routes."""
import base64
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
import re

import database as db
from deps import get_current_user

router = APIRouter(prefix="/emojis", tags=["emojis"])

EMOJI_NAME_RE = re.compile(r"^[a-z0-9_]{2,32}$")
MAX_EMOJI_SIZE = 256 * 1024  # 256KB max


class AddEmojiRequest(BaseModel):
    name: str
    image_data: str  # Base64 data URL
    is_global: bool = False


@router.get("")
async def list_emojis(_: dict = Depends(get_current_user)):
    """Get all custom emojis."""
    emojis = db.get_custom_emojis()
    return {"emojis": emojis}


@router.post("")
async def add_emoji(body: AddEmojiRequest, current_user: dict = Depends(get_current_user)):
    """Add a custom emoji. Only admins can add global emojis."""
    # Validate name
    name = body.name.lower()
    if not EMOJI_NAME_RE.match(name):
        return JSONResponse(status_code=400, content={
            "error": "Emoji name must be 2-32 lowercase letters, numbers, or underscores"
        })
    
    # Validate image data is a data URL. Allow only raster formats — SVG
    # (image/svg+xml) is rejected because an attacker can embed <script>
    # inside an SVG and trigger stored XSS the moment the emoji renders
    # in a message. PNG/JPEG/WebP/GIF cannot carry executable content.
    if not body.image_data.startswith("data:image/"):
        return JSONResponse(status_code=400, content={"error": "Invalid image format"})
    _allowed_emoji_prefixes = (
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/jpg;base64,",
        "data:image/webp;base64,",
        "data:image/gif;base64,",
    )
    if not any(body.image_data.startswith(p) for p in _allowed_emoji_prefixes):
        return JSONResponse(status_code=400, content={"error": "Only PNG, JPEG, WebP, or GIF emojis are allowed"})
    # Magic-byte sanity check on the decoded payload so a forged
    # data:image/png header containing SVG/XML can't slip through.
    try:
        _comma = body.image_data.find(",")
        _raw = base64.b64decode(body.image_data[_comma + 1:], validate=True)
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid base64 image data"})
    if len(_raw) < 8:
        return JSONResponse(status_code=400, content={"error": "Image too small"})
    _is_png = _raw[:8] == b"\x89PNG\r\n\x1a\n"
    _is_jpeg = _raw[:3] == b"\xff\xd8\xff"
    _is_gif = _raw[:6] in (b"GIF87a", b"GIF89a")
    _is_webp = _raw[:4] == b"RIFF" and _raw[8:12] == b"WEBP"
    if not (_is_png or _is_jpeg or _is_gif or _is_webp):
        return JSONResponse(status_code=400, content={"error": "Image bytes don't match a supported raster format"})
    
    # Check size (rough estimate from base64)
    if len(body.image_data) > MAX_EMOJI_SIZE * 1.4:  # Base64 overhead
        return JSONResponse(status_code=400, content={"error": "Image too large (max 256KB)"})
    
    # Only admin can add global emojis
    is_global = body.is_global and bool(current_user.get("is_admin"))
    
    emoji_id = db.add_custom_emoji(name, body.image_data, current_user["id"], is_global)
    if emoji_id is None:
        return JSONResponse(status_code=409, content={"error": "Emoji name already exists"})
    
    return {"ok": True, "id": emoji_id, "name": name}


@router.delete("/{emoji_id}")
async def delete_emoji(emoji_id: int, current_user: dict = Depends(get_current_user)):
    """Delete a custom emoji. Only uploader or admin can delete."""
    ok = db.delete_custom_emoji(emoji_id, current_user["id"], bool(current_user.get("is_admin")))
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Not found or not authorized"})
    return {"ok": True}
