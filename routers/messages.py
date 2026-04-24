"""Message REST routes (history, edit, delete, reactions)."""
from datetime import datetime
import time
import uuid
from fastapi import APIRouter, Request, Depends, Path, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from typing import Optional

import database as db
from deps import get_current_user
from ws_manager import manager

router = APIRouter(prefix="/messages", tags=["messages"])
limiter = Limiter(key_func=get_remote_address)

MAX_MEDIA_BYTES = 20 * 1024 * 1024  # 20 MB
ALLOWED_MEDIA = (
    'data:image/', 'data:video/', 'data:audio/',
    'data:application/pdf', 'data:application/octet-stream',
)
ENCRYPTED_MEDIA_PREFIX = 'ftenc:'


def _is_allowed_media_payload(payload: Optional[str]) -> bool:
    if not payload:
        return False
    return payload.startswith(ENCRYPTED_MEDIA_PREFIX) or any(payload.startswith(p) for p in ALLOWED_MEDIA)


class EditRequest(BaseModel):
    content: str


class ReactionRequest(BaseModel):
    emoji: str


class SendMessageRequest(BaseModel):
    content: str = ""
    media_data: Optional[str] = None
    media_type: Optional[str] = None
    media_blur: int = 0
    view_once: int = 0
    reply_to: Optional[int] = None
    # Optional plaintext for outbound bridge forwarding. The client sends this
    # ONLY for rooms that have an active outbound bridge — the server never
    # stores it, only forwards it to Telegram / Discord.
    bridge_plain: Optional[str] = None


@router.post("/{room_name}/send")
@limiter.limit("30/minute")
async def send_message(request: Request, room_name: str, body: SendMessageRequest,
                       current_user: dict = Depends(get_current_user)):
    """Send a message to a room via REST (reliable for media uploads)."""
    content = body.content.strip()
    if not content and not body.media_data:
        return JSONResponse(status_code=400, content={"error": "Empty message"})
    if content and len(content) > 10_000:
        return JSONResponse(status_code=413, content={"error": "Message too long"})
    if body.media_data:
        if len(body.media_data) > MAX_MEDIA_BYTES:
            return JSONResponse(status_code=413, content={"error": "File too large (max 20MB)"})
        if not _is_allowed_media_payload(body.media_data):
            return JSONResponse(status_code=400, content={"error": "Unsupported file type"})

    msg_id = db.save_message(
        room_name, current_user["id"], current_user["nickname"],
        content, body.media_data, body.media_type,
        body.media_blur, body.view_once
    )

    reply_nickname = None
    reply_content = None
    if body.reply_to:
        with db._conn() as con:
            con.execute("UPDATE messages SET reply_to=? WHERE id=?", (body.reply_to, msg_id))
            con.commit()
            row = con.execute("SELECT nickname, substr(content,1,120) AS content FROM messages WHERE id=?",
                              (body.reply_to,)).fetchone()
            if row:
                reply_nickname = row["nickname"]
                reply_content = row["content"]

    broadcast_payload = {
        "type": "message",
        "id": msg_id,
        "room": room_name,
        "nickname": current_user["nickname"],
        "user_id": current_user["id"],
        "avatar": current_user.get("avatar"),
        "content": content,
        "media_type": body.media_type,
        "media_blur": body.media_blur,
        "view_once": body.view_once,
        "has_media": bool(body.media_data),
        "reply_to": body.reply_to,
        "reply_nickname": reply_nickname,
        "reply_content": reply_content,
        "edited": False,
        "reactions": {},
        "created_at": datetime.utcnow().isoformat(),
    }
    await manager.broadcast_room(room_name, broadcast_payload)

    # Forward to linked Telegram / Discord bridges (direction-aware).
    # Prefer the client-supplied plaintext for encrypted rooms; otherwise
    # fall back to the stored content (unencrypted rooms).
    try:
        import bridge_outbound
        outbound_text = (body.bridge_plain or "").strip() or content
        bridge_outbound.forward_user_message(
            room_name, current_user["nickname"], outbound_text, body.media_data,
            sender_avatar=current_user.get("avatar"),
            ft_msg_id=msg_id,
            reply_to_ft_id=body.reply_to,
            media_blur=bool(body.media_blur),
        )
    except Exception:
        pass

    # Federation phase-2: replicate message envelope to peer nodes.
    try:
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "message.created",
            "payload": {
                "room_name": room_name,
                "nickname": current_user["nickname"],
                "content": content,
                "media_data": body.media_data,
                "media_type": body.media_type,
                "media_blur": int(body.media_blur or 0),
                "view_once": int(body.view_once or 0),
                "created_at": datetime.utcnow().isoformat() + "Z",
            },
        })
    except Exception:
        pass

    return {"id": msg_id, "ok": True}


@router.get("/media/{msg_id}")
async def get_media(msg_id: int, _: dict = Depends(get_current_user)):
    """Fetch media_data for a single message (lazy load)."""
    with db._conn() as con:
        row = con.execute("SELECT media_data, media_type FROM messages WHERE id=?", (msg_id,)).fetchone()
    if not row or not row["media_data"]:
        return JSONResponse(status_code=404, content={"error": "No media"})
    return {"media_data": row["media_data"], "media_type": row["media_type"]}


@router.get("/{room_name}")
async def get_history(
    room_name: str,
    limit: int = Query(50, le=200),
    before_id: Optional[int] = Query(None),
    _: dict = Depends(get_current_user),
):
    msgs = db.get_messages(room_name, limit=limit, before_id=before_id)
    # Strip heavy media_data from history; client fetches via /media endpoint
    for msg in msgs:
        if msg.get("media_data"):
            msg["has_media"] = True
            del msg["media_data"]
    return {"messages": msgs}


@router.patch("/{msg_id}")
async def edit_message(msg_id: int, body: EditRequest,
                       current_user: dict = Depends(get_current_user)):
    if not body.content.strip():
        return JSONResponse(status_code=400, content={"error": "Message cannot be empty"})
    if len(body.content) > 10000:
        return JSONResponse(status_code=413, content={"error": "Message too long"})
    ok = db.edit_message(msg_id, current_user["id"], body.content, bool(current_user.get("is_admin")))
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Cannot edit this message"})
    return {"ok": True}


@router.delete("/{msg_id}")
async def delete_message(msg_id: int, current_user: dict = Depends(get_current_user)):
    # Allow room owners and moderators to delete messages in rooms they manage
    is_room_owner = False
    try:
        msg = db.get_message(msg_id) if hasattr(db, "get_message") else None
        if msg and msg.get("room_name"):
            is_room_owner = db.can_moderate_room(
                msg["room_name"], current_user["id"], bool(current_user.get("is_admin"))
            )
    except Exception:
        is_room_owner = False
    ok = db.delete_message(msg_id, current_user["id"], bool(current_user.get("is_admin")), is_room_owner)
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Cannot delete this message"})
    return {"ok": True}


@router.post("/{msg_id}/react")
@limiter.limit("60/minute")
async def toggle_reaction(request: Request, msg_id: int, body: ReactionRequest,
                          current_user: dict = Depends(get_current_user)):
    if len(body.emoji) > 10:
        return JSONResponse(status_code=400, content={"error": "Invalid emoji"})
    counts = db.toggle_reaction(msg_id, current_user["id"], body.emoji)
    try:
        msg = db.get_message(msg_id)
        if msg and msg.get("room_name"):
            import bridge_outbound
            bridge_outbound.forward_user_reaction(msg["room_name"], msg_id, body.emoji, counts)
    except Exception:
        pass
    return {"message_id": msg_id, "reactions": counts}


@router.post("/{msg_id}/view")
async def mark_viewed(msg_id: int, current_user: dict = Depends(get_current_user)):
    """Consume view-once media — nulls out media_data after first reveal."""
    db.consume_view_once_media(msg_id)
    return {"ok": True}


@router.get("/search/global")
async def search_all(
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(50, le=100),
    current_user: dict = Depends(get_current_user),
):
    """Global search across all accessible messages."""
    results = db.search_all_messages(current_user["id"], q, limit)
    return {"results": results, "query": q}


@router.get("/{room_name}/search")
async def search_messages(
    room_name: str,
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(50, le=100),
    current_user: dict = Depends(get_current_user),
):
    """Search messages in a room."""
    results = db.search_room_messages(room_name, q, limit)
    return {"results": results, "query": q, "room": room_name}


@router.get("/users/mentionable")
async def get_mentionable_users(current_user: dict = Depends(get_current_user)):
    """Get all users for @mention autocomplete."""
    users = db.get_room_members()
    return {"users": users}
