"""Direct message routes."""
from datetime import datetime
import logging
import time
import uuid
from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from slowapi import Limiter
from typing import Optional

import database as db
from deps import get_current_user, client_ip
from ws_manager import manager

_log = logging.getLogger(__name__)
limiter = Limiter(key_func=client_ip)
router = APIRouter(prefix="/dms", tags=["dms"])

MAX_MEDIA_BYTES = 20 * 1024 * 1024
ALLOWED_MEDIA = (
    'data:image/', 'data:video/', 'data:audio/',
    'data:application/pdf', 'data:application/octet-stream',
)
ENCRYPTED_MEDIA_PREFIX = 'ftenc:'


def _is_allowed_media_payload(payload: Optional[str]) -> bool:
    if not payload:
        return False
    return payload.startswith(ENCRYPTED_MEDIA_PREFIX) or any(payload.startswith(p) for p in ALLOWED_MEDIA)


class DMMessageBody(BaseModel):
    content: str = ""
    media_data: Optional[str] = None
    media_type: Optional[str] = None
    media_name: Optional[str] = None
    reply_to: Optional[int] = None
    media_blur: int = 0
    view_once: int = 0
    # Forwarded-message metadata (JSON string). Same shape as room version:
    # {nick, source_label, kind:'room'|'dm', source_name?, source_id?, original_id?}.
    forwarded_from: Optional[str] = None


class EditDMBody(BaseModel):
    content: str


@router.post("/open/{nickname}")
@limiter.limit("60/hour")
async def open_dm(request: Request, nickname: str, current_user: dict = Depends(get_current_user)):
    """Get or create DM channel with another user."""
    profile = db.get_user_profile(nickname)
    if not profile:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    is_self = profile["id"] == current_user["id"]

    # Hard block: either party has blocked the other — vague 404 to avoid
    # leaking that the block exists.
    if not is_self and db.is_blocked_either_way(current_user["id"], profile["id"]):
        return JSONResponse(status_code=404, content={"error": "User not found"})

    # Check DM policy unless channel already exists or self-DM
    existing = db.dm_channel_exists(current_user["id"], profile["id"])
    if not existing and not is_self:
        policy = db.get_user_dm_policy(profile["id"])
        if policy == "nobody":
            return JSONResponse(status_code=403, content={"error": "This user has restricted DMs"})
        elif policy == "friends":
            if not db.are_friends(current_user["id"], profile["id"]):
                return JSONResponse(status_code=403, content={"error": "This user only accepts DMs from friends"})
    
    channel_id = db.get_or_create_dm(current_user["id"], profile["id"])
    return {
        "channel_id": channel_id,
        "other_user": {
            "id": profile["id"],
            "nickname": profile["nickname"],
            "avatar": profile.get("avatar"),
            "presence": profile.get("presence", "online"),
            "status_msg": profile.get("status_msg", ""),
            "last_seen": db.get_privacy_last_seen(profile["id"], current_user["id"]),
            "show_read_receipts": bool(profile.get("show_read_receipts", 1)),
        }
    }


@router.get("")
async def list_dms(current_user: dict = Depends(get_current_user)):
    viewer_id = current_user["id"]

    def _build():
        channels = db.get_dm_channels(viewer_id)
        # Apply privacy: mask peer_last_read when peer has read receipts off,
        # and mask other_last_seen when privacy forbids.
        for ch in channels:
            if not ch.get("other_show_read_receipts", 1):
                ch["peer_last_read"] = 0
            pref = ch.get("other_show_last_seen", "everyone") or "everyone"
            if pref == "nobody":
                ch["other_last_seen"] = None
            elif pref == "friends":
                if not db.are_friends(viewer_id, ch["other_id"]):
                    ch["other_last_seen"] = None
            ch.pop("other_show_last_seen", None)
        return channels

    return {"channels": await run_in_threadpool(_build)}


@router.post("/{channel_id}/read")
async def mark_read(channel_id: int, body: dict = None,
                    current_user: dict = Depends(get_current_user)):
    """Mark DM channel as read up to message id. Respects read-receipt privacy."""
    up_to = 0
    if isinstance(body, dict):
        try:
            up_to = int(body.get("up_to") or body.get("last_msg_id") or 0)
        except (TypeError, ValueError):
            up_to = 0
    if up_to <= 0:
        # Auto-detect latest message id in channel
        with db._conn() as con:
            row = con.execute(
                "SELECT MAX(id) AS m FROM dm_messages WHERE channel_id=? AND deleted=0",
                (channel_id,)
            ).fetchone()
        up_to = (row["m"] or 0) if row else 0
    if up_to <= 0:
        return {"ok": True, "last_read": 0}

    ok, peer_id, new_read = db.mark_dm_read(channel_id, current_user["id"], up_to)
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Not a member of this channel"})
    # Only notify peer if user allows read-receipts
    if peer_id and db.get_privacy_read_receipts(current_user["id"]):
        try:
            await manager.send_to_user(peer_id, {
                "type": "dm_read",
                "channel_id": channel_id,
                "reader_id": current_user["id"],
                "last_read": new_read,
            })
        except Exception:
            pass
    return {"ok": True, "last_read": new_read}


@router.get("/{channel_id}/messages")
async def get_messages(channel_id: int, before: Optional[int] = None,
                       after: Optional[int] = None, limit: int = 50,
                       current_user: dict = Depends(get_current_user)):
    limit = min(limit, 100)
    viewer_id = current_user["id"]

    def _build():
        msgs, ok = db.get_dm_messages(channel_id, viewer_id, limit, before, after)
        if not ok:
            return (False, None)
        msg_ids = [int(m.get("id") or 0) for m in msgs if m.get("id")]
        try:
            viewed_map = db.get_dm_view_once_viewed_map(msg_ids, viewer_id)
        except Exception:
            viewed_map = {}
        try:
            reactions_map = db.get_dm_reactions_bulk(msg_ids)
        except Exception:
            reactions_map = {}
        for msg in msgs:
            msg["channel_id"] = channel_id
            msg["has_media"] = bool(msg.get("has_media"))
            msg["reactions"] = reactions_map.get(int(msg.get("id") or 0), {})
            if msg.get("view_once"):
                msg["viewed_by_me"] = 1 if viewed_map.get(int(msg.get("id") or 0)) else 0
        return (True, msgs)

    ok, msgs = await run_in_threadpool(_build)
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Not a member of this channel"})
    return {"messages": msgs}


@router.get("/{channel_id}/messages/{msg_id}/media")
async def get_dm_media(channel_id: int, msg_id: int,
                       current_user: dict = Depends(get_current_user)):
    """Fetch media_data for a single DM message (lazy load)."""
    # Verify membership (cheap PK lookup)
    if not db.is_dm_member(channel_id, current_user["id"]):
        return JSONResponse(status_code=403, content={"error": "Not a member of this channel"})
    with db._conn() as con:
        row = con.execute(
            "SELECT media_data, media_type, view_once FROM dm_messages WHERE id=? AND channel_id=?",
            (msg_id, channel_id)
        ).fetchone()
    if row and row["view_once"] and db.has_dm_view_once_been_viewed(msg_id, current_user["id"]):
        return JSONResponse(status_code=410, content={"error": "View once already consumed", "viewed_by_me": 1})
    if not row or not row["media_data"]:
        return JSONResponse(status_code=404, content={"error": "No media"})
    return {"media_data": row["media_data"], "media_type": row["media_type"]}


@router.post("/{channel_id}/messages")
@limiter.limit("120/minute")
async def send_message(request: Request, channel_id: int, body: DMMessageBody,
                       current_user: dict = Depends(get_current_user)):
    if not body.content and not body.media_data:
        return JSONResponse(status_code=400, content={"error": "Empty message"})
    if body.media_data:
        if len(body.media_data) > MAX_MEDIA_BYTES:
            return JSONResponse(status_code=413, content={"error": "Media too large (max 20MB)"})
        if not _is_allowed_media_payload(body.media_data):
            return JSONResponse(status_code=400, content={"error": "Unsupported media type"})
    # Verify membership (cheap PK lookup)
    if not db.is_dm_member(channel_id, current_user["id"]):
        return JSONResponse(status_code=403, content={"error": "Not a member of this channel"})
    # Resolve the other participant and block-guard before writing
    try:
        with db._conn() as con:
            ch = con.execute(
                "SELECT user_a, user_b FROM dm_channels WHERE id=?", (channel_id,)
            ).fetchone()
    except Exception:
        ch = None
    peer_id = None
    if ch:
        peer_id = ch["user_b"] if ch["user_a"] == current_user["id"] else ch["user_a"]
        if peer_id and peer_id != current_user["id"] \
                and db.is_blocked_either_way(current_user["id"], peer_id):
            return JSONResponse(status_code=403, content={"error": "You can no longer message this user"})
    # Source-side forwarding-disabled enforcement.
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
    msg_id = db.send_dm_message(
        channel_id, current_user["id"],
        body.content, body.media_data, body.media_type, body.media_name, body.reply_to,
        media_blur=1 if body.media_blur else 0,
        view_once=1 if body.view_once else 0,
        forwarded_from=(body.forwarded_from if fwd_meta else None),
    )

    # Resolve reply preview for broadcast
    _reply_nick = None
    _reply_content = None
    if body.reply_to:
        try:
            with db._conn() as _rc:
                _rrow = _rc.execute(
                    """SELECT u.nickname, substr(dm.content,1,120) AS content
                       FROM dm_messages dm JOIN users u ON u.id=dm.sender_id
                       WHERE dm.id=?""",
                    (body.reply_to,)
                ).fetchone()
            if _rrow:
                _reply_nick = _rrow["nickname"]
                _reply_content = _rrow["content"]
        except Exception:
            pass

    # Build broadcast payload (strip heavy media_data)
    dm_broadcast = {
        "type": "dm_message",
        "id": msg_id,
        "channel_id": channel_id,
        "sender_id": current_user["id"],
        "sender_nick": current_user["nickname"],
        "sender_display_name": current_user.get("display_name"),
        "sender_is_admin": bool(current_user.get("is_admin")),
        "sender_avatar": current_user.get("avatar"),
        "content": body.content or "",
        "media_type": body.media_type,
        "media_name": body.media_name,
        "has_media": bool(body.media_data),
        "media_blur": 1 if body.media_blur else 0,
        "view_once": 1 if body.view_once else 0,
        "viewed_by_me": 0,
        "reply_to": body.reply_to,
        "reply_nick": _reply_nick,
        "reply_content": _reply_content,
        "forwarded_from": (body.forwarded_from if fwd_meta else None),
        "edited": False,
        "deleted": False,
        "reactions": {},
        "created_at": datetime.utcnow().isoformat() + "Z",
    }
    # Notify recipient via WS
    try:
        if ch and peer_id and peer_id != current_user["id"]:
            await manager.send_to_user(peer_id, dm_broadcast)
    except Exception:
        pass

    # Federation phase-2: replicate DM envelopes so cross-node switch keeps history.
    try:
        peer_nick = ""
        if peer_id:
            peer = db.get_user_by_id(peer_id) or {}
            peer_nick = str(peer.get("nickname") or "").strip()
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "dm.message.created",
            "payload": {
                "channel_id": channel_id,
                "sender_nickname": current_user["nickname"],
                "peer_nickname": peer_nick,
                "content": body.content or "",
                "media_data": body.media_data,
                "media_type": body.media_type,
                "media_name": body.media_name,
                "reply_to": body.reply_to,
                "media_blur": int(body.media_blur or 0),
                "view_once": int(body.view_once or 0),
                "created_at": datetime.utcnow().isoformat() + "Z",
            },
        })
    except Exception:
        pass

    return {"id": msg_id, "ok": True, **dm_broadcast}


@router.post("/{channel_id}/messages/{msg_id}/view")
async def mark_dm_viewed(channel_id: int, msg_id: int,
                         current_user: dict = Depends(get_current_user)):
    """Consume view-once DM media for current user only. Notify sender if receiver views."""
    # Verify membership (cheap PK lookup)
    if not db.is_dm_member(channel_id, current_user["id"]):
        return JSONResponse(status_code=403, content={"error": "Not a member of this channel"})
    with db._conn() as con:
        row = con.execute(
            "SELECT id, view_once, sender_id FROM dm_messages WHERE id=? AND channel_id=?",
            (msg_id, channel_id)
        ).fetchone()
    if not row:
        return JSONResponse(status_code=404, content={"error": "Message not found"})
    if not row["view_once"]:
        return JSONResponse(status_code=400, content={"error": "Not a view-once message"})
    sender_id = row["sender_id"]
    viewer_id = current_user["id"]
    is_sender = (sender_id == viewer_id)
    
    # Only mark as consumed if the viewer is NOT the sender
    if not is_sender:
        db.mark_dm_view_once_viewed(msg_id, viewer_id)
    
    # Sync state: always notify the viewer, and if receiver viewed, notify sender
    try:
        await manager.send_to_user(viewer_id, {
            "type": "dm_view_once_viewed",
            "channel_id": channel_id,
            "msg_id": msg_id,
            "user_id": viewer_id,
            "is_sender": is_sender,
        })
        if not is_sender and sender_id:
            await manager.send_to_user(sender_id, {
                "type": "dm_view_once_viewed_by_peer",
                "channel_id": channel_id,
                "msg_id": msg_id,
                "viewer_id": viewer_id,
            })
    except Exception:
        pass
    return {"ok": True, "viewed_by_me": 1 if not is_sender else 0}


@router.put("/{channel_id}/messages/{msg_id}")
async def edit_message(channel_id: int, msg_id: int, body: EditDMBody,
                       current_user: dict = Depends(get_current_user)):
    if not body.content.strip():
        return JSONResponse(status_code=400, content={"error": "Empty content"})
    ok = db.edit_dm_message(msg_id, current_user["id"], body.content.strip())
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Cannot edit this message"})
    return {"ok": True}


@router.delete("/{channel_id}/messages/{msg_id}")
async def delete_message(channel_id: int, msg_id: int,
                         current_user: dict = Depends(get_current_user)):
    ok = db.delete_dm_message(msg_id, current_user["id"])
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Cannot delete this message"})
    return {"ok": True}


@router.post("/{channel_id}/messages/{msg_id}/react")
async def react(channel_id: int, msg_id: int, body: dict,
                current_user: dict = Depends(get_current_user)):
    emoji = str(body.get("emoji", ""))[:10]
    if not emoji:
        return JSONResponse(status_code=400, content={"error": "No emoji"})
    counts = db.toggle_dm_reaction(msg_id, current_user["id"], emoji)
    return {"reactions": counts}


@router.post("/{channel_id}/messages/{msg_id}/preview-suppress")
async def suppress_dm_preview(channel_id: int, msg_id: int,
                              current_user: dict = Depends(get_current_user)):
    """Discord-style \"X\" on a DM link preview. Sender-only."""
    cid = db.set_dm_preview_suppressed(msg_id, current_user["id"])
    if cid is None:
        return JSONResponse(status_code=403, content={"error": "Cannot suppress this preview"})
    # Notify both sides so the embed disappears for the recipient too.
    try:
        with db._conn() as con:
            ch = con.execute(
                "SELECT user_a, user_b FROM dm_channels WHERE id=?", (cid,)
            ).fetchone()
        if ch:
            peer_id = ch["user_b"] if ch["user_a"] == current_user["id"] else ch["user_a"]
            payload = {
                "type": "dm_preview_suppress",
                "id": msg_id,
                "channel_id": cid,
            }
            if peer_id and peer_id != current_user["id"]:
                await manager.send_to_user(peer_id, payload)
            await manager.send_to_user(current_user["id"], payload)
    except Exception:
        pass
    return {"ok": True}


# ─── Disappearing messages ────────────────────────────────────────────────────

class DisappearTimerBody(BaseModel):
    seconds: int  # 0 = off, or seconds like 3600, 86400, 604800


@router.get("/{channel_id}/disappear")
async def get_disappear_timer(channel_id: int, current_user: dict = Depends(get_current_user)):
    """Get the disappearing message timer for a DM channel."""
    timer = db.get_dm_disappear_timer(channel_id)
    return {"seconds": timer}


@router.post("/{channel_id}/disappear")
async def set_disappear_timer(channel_id: int, body: DisappearTimerBody,
                              current_user: dict = Depends(get_current_user)):
    """Set the disappearing message timer for a DM channel."""
    # Validate seconds (0, 1h, 24h, 7d, 30d)
    allowed = {0, 3600, 86400, 604800, 2592000}
    if body.seconds not in allowed:
        return JSONResponse(status_code=400, content={
            "error": "Invalid timer value. Use 0 (off), 3600 (1h), 86400 (24h), 604800 (7d), or 2592000 (30d)"
        })
    
    ok = db.set_dm_disappear_timer(channel_id, current_user["id"], body.seconds)
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Cannot set timer for this channel"})
    return {"ok": True, "seconds": body.seconds}


# ─── Forwarding controls ──────────────────────────────────────────────────────

class ForwardingBody(BaseModel):
    disabled: int  # 0 or 1


@router.post("/{channel_id}/forwarding")
async def set_dm_forwarding(channel_id: int, body: ForwardingBody,
                            current_user: dict = Depends(get_current_user)):
    """Toggle whether messages in this DM may be forwarded."""
    if body.disabled not in (0, 1):
        return JSONResponse(status_code=400, content={"error": "disabled must be 0 or 1"})
    if not db.is_dm_member(channel_id, current_user["id"]):
        return JSONResponse(status_code=403, content={"error": "Not a member of this channel"})
    with db._conn() as con:
        con.execute(
            "UPDATE dm_channels SET forwarding_disabled=? WHERE id=?",
            (body.disabled, channel_id),
        )
        con.commit()
    # Notify the peer so their UI updates live.
    try:
        with db._conn() as con:
            ch = con.execute(
                "SELECT user_a, user_b FROM dm_channels WHERE id=?", (channel_id,)
            ).fetchone()
        if ch:
            peer_id = ch["user_b"] if ch["user_a"] == current_user["id"] else ch["user_a"]
            if peer_id:
                await manager.send_to_user(peer_id, {
                    "type": "dm_forwarding",
                    "channel_id": channel_id,
                    "disabled": int(body.disabled),
                })
    except Exception:
        pass
    return {"ok": True, "disabled": int(body.disabled)}


# ─── Hide DM channel ───────────────────────────────────────────────────────────

@router.post("/{channel_id}/hide")
async def hide_dm_channel(channel_id: int, current_user: dict = Depends(get_current_user)):
    """Hide a DM channel from the user's sidebar. Re-appears when new message arrives."""
    ok = db.hide_dm_channel(channel_id, current_user["id"])
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Cannot hide this channel"})
    return {"ok": True}


@router.post("/{channel_id}/unhide")
async def unhide_dm_channel(channel_id: int, current_user: dict = Depends(get_current_user)):
    """Unhide a previously hidden DM channel."""
    ok = db.unhide_dm_channel(channel_id, current_user["id"])
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Cannot unhide this channel"})
    return {"ok": True}


# ─── Wipe DM messages ──────────────────────────────────────────────────────────

@router.delete("/{channel_id}/messages")
async def wipe_dm_messages(channel_id: int, current_user: dict = Depends(get_current_user)):
    """Wipe all messages in a DM channel (for both users)."""
    ok = db.wipe_dm_messages(channel_id, current_user["id"])
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Not a member of this channel"})
    return {"ok": True}
