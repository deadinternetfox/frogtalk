"""Message REST routes (history, edit, delete, reactions)."""
import asyncio
import logging
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
_log = logging.getLogger(__name__)

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
    # Forwarded-message metadata: JSON string
    # {nick, source_label, kind:'room'|'dm', original_id?}.
    # When set the server (a) refuses if the SOURCE conversation has
    # forwarding_disabled=1, and (b) persists it so future renders show
    # the "↪ Forwarded from" badge.
    forwarded_from: Optional[str] = None


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

    # Forwarding source-side check: if the message is being forwarded, make
    # sure the SOURCE conversation hasn't disabled forwarding. Defence in
    # depth — the client also hides the button, but a tampered request
    # would still be rejected here.
    fwd_meta = None
    if body.forwarded_from:
        try:
            import json as _json
            fwd_meta = _json.loads(body.forwarded_from)
            if not isinstance(fwd_meta, dict):
                fwd_meta = None
        except Exception:
            fwd_meta = None
        if fwd_meta:
            kind = fwd_meta.get("kind")
            if kind == "room":
                src = db.get_room_by_name(str(fwd_meta.get("source_name") or ""))
                if src and int(src.get("forwarding_disabled") or 0):
                    return JSONResponse(status_code=403, content={"error": "Forwarding disabled in source channel"})
            elif kind == "dm":
                try:
                    src_cid = int(fwd_meta.get("source_id") or 0)
                except Exception:
                    src_cid = 0
                if src_cid:
                    with db._conn() as _c:
                        _r = _c.execute(
                            "SELECT COALESCE(forwarding_disabled,0) AS f FROM dm_channels WHERE id=?",
                            (src_cid,)).fetchone()
                    if _r and int(_r["f"]):
                        return JSONResponse(status_code=403, content={"error": "Forwarding disabled in source DM"})

    msg_id = db.save_message(
        room_name, current_user["id"], current_user["nickname"],
        content, body.media_data, body.media_type,
        body.media_blur, body.view_once,
        forwarded_from=(body.forwarded_from if fwd_meta else None),
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
        "forwarded_from": (body.forwarded_from if fwd_meta else None),
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
        # Mark forwarded messages on bridges so Telegram / Discord users see
        # the same "↪ Forwarded from X" indicator as in-app users.
        if fwd_meta:
            src_nick = str(fwd_meta.get("source_nick") or "").strip()
            label = f"↪ Forwarded from {src_nick}" if src_nick else "↪ Forwarded message"
            outbound_text = f"{label}\n{outbound_text}" if outbound_text else label
        bridge_outbound.forward_user_message(
            room_name, current_user["nickname"], outbound_text, body.media_data,
            sender_avatar=current_user.get("avatar"),
            sender_user_id=current_user.get("id"),
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
async def get_media(msg_id: int, current_user: dict = Depends(get_current_user)):
    """Fetch media_data for a single message (lazy load)."""
    msg = db.get_message(msg_id)
    if not msg:
        return JSONResponse(status_code=404, content={"error": "No media"})
    if not db.user_can_access_room(
        current_user["id"], msg.get("room_name") or "",
        is_admin=bool(current_user.get("is_admin")),
    ):
        return JSONResponse(status_code=403, content={"error": "Not a member of this room"})
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
    current_user: dict = Depends(get_current_user),
):
    if not db.user_can_access_room(
        current_user["id"], room_name,
        is_admin=bool(current_user.get("is_admin")),
    ):
        return JSONResponse(status_code=403, content={"error": "Not a member of this room"})
    msgs = await asyncio.to_thread(db.get_messages, room_name, limit, before_id)
    # has_media is now returned directly from SQL as 0/1; coerce to bool so
    # the client gets a stable shape. media_data is no longer selected for
    # history requests \u2014 clients fetch via /messages/<id>/media on demand.
    for msg in msgs:
        msg["has_media"] = bool(msg.get("has_media"))
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
    # Broadcast the edit + mirror it onto every linked bridge so the
    # change shows up everywhere it was originally posted.
    try:
        msg = db.get_message(msg_id) if hasattr(db, "get_message") else None
        room_name = (msg or {}).get("room_name")
        if room_name:
            await manager.broadcast_room(room_name, {
                "type": "edit", "id": msg_id,
                "content": body.content, "room": room_name,
            })
            try:
                import bridge_outbound
                bridge_outbound.forward_user_edit(
                    room_name, msg_id, body.content,
                    nickname=current_user.get("nickname"),
                )
            except Exception:
                pass
    except Exception:
        pass
    return {"ok": True}


@router.delete("/{msg_id}")
async def delete_message(msg_id: int, current_user: dict = Depends(get_current_user)):
    # Allow room owners and moderators to delete messages in rooms they manage
    is_room_owner = False
    room_name = None
    try:
        msg = db.get_message(msg_id) if hasattr(db, "get_message") else None
        if msg and msg.get("room_name"):
            room_name = msg["room_name"]
            is_room_owner = db.can_moderate_room(
                msg["room_name"], current_user["id"], bool(current_user.get("is_admin"))
            )
    except Exception:
        is_room_owner = False
    ok = db.delete_message(msg_id, current_user["id"], bool(current_user.get("is_admin")), is_room_owner)
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Cannot delete this message"})
    if room_name:
        try:
            await manager.broadcast_room(room_name, {
                "type": "delete", "id": msg_id, "room": room_name,
            })
        except Exception:
            pass
        try:
            import bridge_outbound
            bridge_outbound.forward_user_delete(room_name, msg_id)
        except Exception:
            pass
    return {"ok": True}


@router.post("/{msg_id}/react")
@limiter.limit("60/minute")
async def toggle_reaction(request: Request, msg_id: int, body: ReactionRequest,
                          current_user: dict = Depends(get_current_user)):
    if len(body.emoji) > 10:
        return JSONResponse(status_code=400, content={"error": "Invalid emoji"})
    msg = db.get_message(msg_id)
    if not msg:
        return JSONResponse(status_code=404, content={"error": "Message not found"})
    if not db.user_can_access_room(
        current_user["id"], msg.get("room_name") or "",
        is_admin=bool(current_user.get("is_admin")),
    ):
        return JSONResponse(status_code=403, content={"error": "Not a member of this room"})
    counts = db.toggle_reaction(msg_id, current_user["id"], body.emoji)
    try:
        if msg and msg.get("room_name"):
            import bridge_outbound
            bridge_outbound.forward_user_reaction(msg["room_name"], msg_id, body.emoji, counts)
    except Exception:
        _log.exception("bridge reaction forward failed")
    return {"message_id": msg_id, "reactions": counts}


@router.post("/{msg_id}/view")
async def mark_viewed(msg_id: int, current_user: dict = Depends(get_current_user)):
    """Consume view-once media — nulls out media_data after first reveal."""
    msg = db.get_message(msg_id)
    if not msg:
        return JSONResponse(status_code=404, content={"error": "Message not found"})
    if not db.user_can_access_room(
        current_user["id"], msg.get("room_name") or "",
        is_admin=bool(current_user.get("is_admin")),
    ):
        return JSONResponse(status_code=403, content={"error": "Not a member of this room"})
    db.consume_view_once_media(msg_id)
    return {"ok": True}


@router.get("/search/global")
async def search_all(
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(50, le=100),
    current_user: dict = Depends(get_current_user),
):
    """Global search across messages the user can access."""
    results = await asyncio.to_thread(
        db.search_all_messages, current_user["id"], q, limit
    )
    return {"results": results, "query": q}


@router.get("/{room_name}/search")
async def search_messages(
    room_name: str,
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(50, le=100),
    current_user: dict = Depends(get_current_user),
):
    """Search messages in a room."""
    if not db.user_can_access_room(
        current_user["id"], room_name,
        is_admin=bool(current_user.get("is_admin")),
    ):
        return JSONResponse(status_code=403, content={"error": "Not a member of this room"})
    results = db.search_room_messages(room_name, q, limit)
    return {"results": results, "query": q, "room": room_name}


@router.get("/users/mentionable")
async def get_mentionable_users(
    room_name: Optional[str] = Query(default=None),
    current_user: dict = Depends(get_current_user),
):
    """Get all users for @mention autocomplete.

    The DB `presence` column is best-effort and frequently stale (e.g. when
    a client disconnects without cleanly setting offline). For the @mention
    dropdown we want a live answer, so we override each user's presence with
    the current websocket connection state. A user is considered online iff
    they currently have at least one active websocket.
    """
    room_id = None
    if room_name:
        room = db.get_room(room_name)
        if not room:
            return {"users": []}
        if not db.user_can_access_room(
            current_user["id"], room_name,
            is_admin=bool(current_user.get("is_admin")),
        ):
            return {"users": []}
        room_id = room["id"]

    users = db.get_room_members(room_id)
    for u in users:
        try:
            uid = u.get("id")
            if uid is not None:
                u["presence"] = "online" if manager.is_user_online(int(uid)) else "offline"
        except Exception:
            # Fall back to whatever the DB reported on any error.
            pass
    return {"users": users}
