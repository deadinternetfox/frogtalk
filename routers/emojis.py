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
    
    # Validate image data is a data URL
    if not body.image_data.startswith("data:image/"):
        return JSONResponse(status_code=400, content={"error": "Invalid image format"})
    
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
