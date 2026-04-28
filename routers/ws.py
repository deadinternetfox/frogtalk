"""WebSocket route - real-time messaging, DM delivery, WebRTC signaling."""
import json
import time
import uuid
from datetime import datetime
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

import database as db
from ws_manager import manager, voice_manager

router = APIRouter(tags=["websocket"])

MAX_MSG_LEN = 10_000
MAX_MEDIA_BYTES = 20 * 1024 * 1024
ALLOWED_MEDIA = (
    'data:image/', 'data:video/', 'data:audio/',
    'data:application/pdf', 'data:application/octet-stream',
)

# Slowmode tracking: (user_id, room_name) -> last_message_timestamp
_slowmode_tracker: dict = {}


def _resolve_to_id(data: dict) -> int:
    """Get target user_id from to_id or to_nickname field.
    Nickname lookup is case-insensitive."""
    uid = int(data.get("to_id", 0) or 0)
    if not uid:
        nick = (data.get("to_nickname") or data.get("to_nick") or "").strip()
        if nick:
            with db._conn() as con:
                row = con.execute(
                    "SELECT id FROM users WHERE LOWER(nickname)=LOWER(?)",
                    (nick,),
                ).fetchone()
                if row:
                    uid = row["id"]
    return uid


def _push(user_id: int, title: str, body: str, url: str = "/app", **extra):
    """Fire-and-forget web push when user is not online via WS."""
    if manager.is_user_online(user_id):
        return  # already connected, no need for push
    try:
        from routers.push import send_push
        send_push(user_id, title, body, url, **extra)
    except Exception:
        pass


def _push_always(user_id: int, title: str, body: str, url: str = "/app", **extra):
    """Push even if the user appears online — used for calls so locked phones /
    backgrounded browsers still wake up and ring."""
    try:
        from routers.push import send_push
        send_push(user_id, title, body, url, **extra)
    except Exception:
        pass


def _call_log_content(title: str, subtitle: str, icon: str = "📞",
                      kind: str = "info", call_type: str = "voice") -> str:
    payload = {
        "title": str(title or "Call"),
        "subtitle": str(subtitle or ""),
        "icon": str(icon or "📞"),
        "kind": str(kind or "info"),
        "call_type": str(call_type or "voice"),
    }
    return "[[CALLLOG]]" + json.dumps(payload, separators=(",", ":"))


def _format_duration(started_at: str | None, ended_at: str | None) -> str | None:
    """Return M:SS or H:MM:SS string from two ISO-formatted UTC timestamps."""
    if not started_at or not ended_at:
        return None
    try:
        def _parse(s: str) -> datetime | None:
            for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
                try:
                    return datetime.strptime(s, fmt)
                except ValueError:
                    pass
            return None
        st = _parse(started_at)
        et = _parse(ended_at)
        if not st or not et:
            return None
        secs = max(0, int((et - st).total_seconds()))
        m, s = divmod(secs, 60)
        h, m = divmod(m, 60)
        if h:
            return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"
    except Exception:
        return None


def _format_duration_secs(total_secs: int | None) -> str | None:
    if total_secs is None:
        return None
    try:
        secs = max(0, int(total_secs))
        m, s = divmod(secs, 60)
        h, m = divmod(m, 60)
        if h:
            return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"
    except Exception:
        return None

@router.websocket("/ws/{room_name}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_name: str,
    token: str = Query(...),
):
    user = db.get_user_by_token(token)
    if not user:
        await websocket.close(code=4001)
        return

    # Authoritative room access check. DM pseudo-rooms (dm-*) are handled by
    # the dedicated DM endpoints/manager and don't live in the rooms table.
    if not room_name.startswith("dm-"):
        if not db.user_can_access_room(
            user["id"], room_name, is_admin=bool(user.get("is_admin"))
        ):
            await websocket.close(code=4003)
            return

    accepted = await manager.connect(
        websocket, room_name, user["nickname"], user["id"],
        avatar=user.get("avatar"), is_admin=user.get("is_admin", False)
    )
    if accepted is False:
        # Per-IP cap reached; manager.connect already closed with 4008.
        return
    db.update_last_seen(user["id"])

    # Auto-add to room_members on connect so they appear in the offline list
    # when they're not connected. Skip DM channels (prefixed with "dm-").
    if not room_name.startswith("dm-"):
        try:
            _room_data = db.get_room_by_name(room_name)
            if _room_data:
                db.join_room(user["id"], _room_data["id"])
        except Exception:
            pass

    async def _emit_dm_call_log(caller_id: int, callee_id: int, call_type: str,
                                title: str, subtitle: str, icon: str = "📵",
                                kind: str = "missed"):
        """Persist and fan out a call-log entry into the DM thread."""
        try:
            channel_id = db.get_or_create_dm(caller_id, callee_id)
            content = _call_log_content(title, subtitle, icon, kind, call_type)
            msg_id = db.send_dm_message(channel_id, caller_id, content)
            caller = db.get_user_by_id(caller_id) or {}
            payload = {
                "type": "dm_message",
                "id": msg_id,
                "channel_id": channel_id,
                "sender_id": caller_id,
                "sender_nick": caller.get("nickname") or "",
                "sender_avatar": caller.get("avatar") or "",
                "content": content,
                "media_type": None,
                "media_name": None,
                "reply_to": None,
                "edited": False,
                "deleted": False,
                "reactions": {},
                "created_at": datetime.utcnow().isoformat(),
            }
            await manager.send_to_user(caller_id, payload)
            if callee_id != caller_id:
                await manager.send_to_user(callee_id, payload)
        except Exception:
            pass

    # Send recent history on connect (strip media_data to keep payload small)
    history = db.get_messages(room_name, limit=50)
    for msg in history:
        if msg.get("media_data"):
            msg["has_media"] = True
            del msg["media_data"]
    await manager.send_personal(websocket, {
        "type": "history",
        "messages": history,
        "online": manager.online_nicknames(room_name),
    })

    # Broadcast updated user list
    await manager.broadcast_room(room_name, {
        "type": "online_users",
        "room": room_name,
        "users": manager.online_nicknames(room_name),
    })

    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except RuntimeError:
                break
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            try:
                db.update_last_seen(user["id"])
            except Exception:
                pass
            msg_type = data.get("type")

            # ── Keepalive ping ────────────────────────────────────────
            if msg_type == "ping":
                await manager.send_personal(websocket, {"type": "pong"})
                continue

            if msg_type == "message":
                # Check if user is muted
                if db.is_user_globally_muted(user["id"]):
                    await manager.send_personal(websocket, {
                        "type": "error",
                        "text": "You are muted and cannot send messages"
                    })
                    continue

                content = str(data.get("content", "")).strip()
                media_data = data.get("media_data")
                media_type = data.get("media_type")
                reply_to = data.get("reply_to")

                if not content and not media_data:
                    continue
                if content and len(content) > MAX_MSG_LEN:
                    await manager.send_personal(websocket, {"type": "error", "text": "Message too long"})
                    continue
                if media_data:
                    if len(media_data) > MAX_MEDIA_BYTES:
                        await manager.send_personal(websocket, {"type": "error", "text": "File too large (max 20MB)"})
                        continue
                    if not any(media_data.startswith(p) for p in ALLOWED_MEDIA):
                        await manager.send_personal(websocket, {"type": "error", "text": "Unsupported file type"})
                        continue

                # Slowmode enforcement
                room_data = None
                try:
                    room_data = db.get_room_by_name(room_name)
                except Exception:
                    pass
                slowmode = (room_data or {}).get("slowmode", 0) or 0
                if slowmode > 0 and not user.get("is_admin"):
                    tracker_key = (user["id"], room_name)
                    now = time.time()
                    last_msg = _slowmode_tracker.get(tracker_key, 0)
                    remaining = slowmode - (now - last_msg)
                    if remaining > 0:
                        await manager.send_personal(websocket, {
                            "type": "error",
                            "text": f"Slowmode active — wait {int(remaining)+1}s"
                        })
                        continue
                    _slowmode_tracker[tracker_key] = now

                media_blur = 1 if data.get("media_blur") else 0
                view_once = 1 if data.get("view_once") else 0
                # View-once is a DM-only feature. Strip it silently in public
                # channels so a misbehaving client can't burn media for others.
                if view_once and not room_name.startswith("dm:"):
                    view_once = 0

                msg_id = db.save_message(
                    room_name, user["id"], user["nickname"],
                    content, media_data, media_type,
                    media_blur, view_once
                )
                # Store reply linkage if provided
                reply_nickname = None
                reply_content = None
                if reply_to:
                    with db._conn() as con:
                        con.execute("UPDATE messages SET reply_to=? WHERE id=?", (reply_to, msg_id))
                        con.commit()
                        row = con.execute("SELECT nickname, substr(content,1,120) AS content FROM messages WHERE id=?", (reply_to,)).fetchone()
                        if row:
                            reply_nickname = row["nickname"]
                            reply_content = row["content"]

                payload = {
                    "type": "message",
                    "id": msg_id,
                    "room": room_name,
                    "client_nonce": data.get("client_nonce"),
                    "nickname": user["nickname"],
                    "user_id": user["id"],
                    "avatar": user.get("avatar"),
                    "content": content,
                    "media_data": media_data,
                    "media_type": media_type,
                    "media_blur": media_blur,
                    "view_once": view_once,
                    "reply_to": reply_to,
                    "reply_nickname": reply_nickname,
                    "reply_content": reply_content,
                    "edited": False,
                    "reactions": {},
                    "created_at": datetime.utcnow().isoformat(),
                }
                # Strip heavy media_data from broadcast; clients lazy-load via REST
                broadcast_payload = dict(payload)
                if broadcast_payload.get("media_data"):
                    broadcast_payload["has_media"] = True
                    del broadcast_payload["media_data"]
                await manager.broadcast_room(room_name, broadcast_payload)

                # Forward to linked Telegram / Discord bridges (direction-aware).
                # For E2EE rooms the client attaches `bridge_plain` so the
                # remote side receives readable text; the server never stores
                # or broadcasts this plaintext.
                try:
                    import bridge_outbound
                    plain = str(data.get("bridge_plain") or "").strip()
                    outbound_text = plain or content
                    bridge_outbound.forward_user_message(
                        room_name, user["nickname"], outbound_text, media_data,
                        sender_avatar=user.get("avatar"),
                        sender_user_id=user.get("id"),
                        ft_msg_id=msg_id,
                        reply_to_ft_id=reply_to or None,
                        media_blur=bool(media_blur),
                    )
                except Exception:
                    pass

            # ── Typing indicator ──────────────────────────────────────
            elif msg_type == "typing":
                await manager.broadcast_room(room_name, {
                    "type": "typing",
                    "nickname": user["nickname"],
                    "room": room_name,
                }, exclude=websocket)

            # ── Delete message ────────────────────────────────────────
            elif msg_type == "delete":
                msg_id = int(data.get("id", 0))
                # Check if user is room owner
                room_info = db.get_room_by_name(room_name)
                is_room_owner = room_info and room_info.get("owner_id") == user["id"]
                ok = db.delete_message(msg_id, user["id"], bool(user.get("is_admin")), is_room_owner)
                if ok:
                    await manager.broadcast_room(room_name, {
                        "type": "delete", "id": msg_id, "room": room_name,
                    })

            # ── Edit message ──────────────────────────────────────────
            elif msg_type == "edit":
                msg_id = int(data.get("id", 0))
                new_content = str(data.get("content", "")).strip()
                if not new_content or len(new_content) > MAX_MSG_LEN:
                    continue
                # Check if user is room owner
                room_info = db.get_room_by_name(room_name)
                is_room_owner = room_info and room_info.get("owner_id") == user["id"]
                ok = db.edit_message(msg_id, user["id"], new_content, bool(user.get("is_admin")), is_room_owner)
                if ok:
                    await manager.broadcast_room(room_name, {
                        "type": "edit", "id": msg_id,
                        "content": new_content, "room": room_name,
                    })

            # ── Reaction ──────────────────────────────────────────────
            elif msg_type == "react":
                msg_id = int(data.get("id", 0))
                emoji = str(data.get("emoji", ""))[:10]
                if not emoji:
                    continue
                counts = db.toggle_reaction(msg_id, user["id"], emoji)
                await manager.broadcast_room(room_name, {
                    "type": "reaction", "id": msg_id,
                    "reactions": counts, "room": room_name,
                })
                try:
                    import bridge_outbound
                    bridge_outbound.forward_user_reaction(room_name, msg_id, emoji, counts)
                except Exception:
                    pass

            # ── Pin message ───────────────────────────────────────────
            elif msg_type == "pin":
                msg_id = int(data.get("id", 0))
                if user.get("is_admin") or True:  # room owners can pin too
                    ok = db.pin_message(room_name, msg_id, user["id"])
                    if ok:
                        await manager.broadcast_room(room_name, {
                            "type": "pin", "id": msg_id, "room": room_name,
                            "by": user["nickname"],
                        })

            # ── DM message (real-time relay) ──────────────────────────
            elif msg_type == "dm_message":
                channel_id = int(data.get("channel_id", 0))
                content = str(data.get("content", "")).strip()
                media_data = data.get("media_data")
                media_type_dm = data.get("media_type")
                media_name = data.get("media_name")
                reply_to_dm = data.get("reply_to")

                if not content and not media_data:
                    continue

                # Verify membership
                _, ok = db.get_dm_messages(channel_id, user["id"], 1)
                if not ok:
                    continue

                if media_data and len(media_data) > MAX_MEDIA_BYTES:
                    continue

                msg_id = db.send_dm_message(
                    channel_id, user["id"], content,
                    media_data, media_type_dm, media_name, reply_to_dm
                )

                payload = {
                    "type": "dm_message",
                    "id": msg_id,
                    "channel_id": channel_id,
                    "sender_id": user["id"],
                    "sender_nick": user["nickname"],
                    "sender_avatar": user.get("avatar"),
                    "content": content,
                    "media_data": media_data,
                    "media_type": media_type_dm,
                    "media_name": media_name,
                    "reply_to": reply_to_dm,
                    "edited": False,
                    "deleted": False,
                    "reactions": {},
                    "created_at": datetime.utcnow().isoformat(),
                    "client_nonce": data.get("client_nonce"),
                }
                # Strip heavy media_data from WS payload; clients lazy-load via REST
                dm_broadcast = dict(payload)
                if dm_broadcast.get("media_data"):
                    dm_broadcast["has_media"] = True
                    del dm_broadcast["media_data"]
                # Send to sender (confirmation) and recipient
                await manager.send_personal(websocket, dm_broadcast)

                # Find the other user in this channel
                with db._conn() as con:
                    ch = con.execute(
                        "SELECT user_a, user_b FROM dm_channels WHERE id=?", (channel_id,)
                    ).fetchone()
                if ch:
                    other_id = ch["user_b"] if ch["user_a"] == user["id"] else ch["user_a"]
                    # Don't double-send if DMing yourself
                    if other_id != user["id"]:
                        await manager.send_to_user(other_id, dm_broadcast)
                    # Push notification if recipient is offline
                    preview = (content or "📎 Media")[:80]
                    _push(other_id, f"💬 {user['nickname']}", preview, "/app")

                    # Federation phase-2: mirror DM message to peer nodes.
                    try:
                        peer = db.get_user_by_id(other_id) or {}
                        db.insert_federation_outbox_event({
                            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
                            "event_type": "dm.message.created",
                            "payload": {
                                "channel_id": channel_id,
                                "sender_nickname": user["nickname"],
                                "peer_nickname": str(peer.get("nickname") or "").strip(),
                                "content": content,
                                "media_data": media_data,
                                "media_type": media_type_dm,
                                "media_name": media_name,
                                "reply_to": reply_to_dm,
                                "media_blur": int(data.get("media_blur") or 0),
                                "view_once": int(data.get("view_once") or 0),
                                "created_at": datetime.utcnow().isoformat() + "Z",
                            },
                        })
                    except Exception:
                        pass

            # ── DM typing indicator ───────────────────────────────────
            elif msg_type == "dm_typing":
                channel_id = int(data.get("channel_id", 0))
                with db._conn() as con:
                    ch = con.execute(
                        "SELECT user_a, user_b FROM dm_channels WHERE id=?", (channel_id,)
                    ).fetchone()
                if ch:
                    other_id = ch["user_b"] if ch["user_a"] == user["id"] else ch["user_a"]
                    await manager.send_to_user(other_id, {
                        "type": "dm_typing",
                        "channel_id": channel_id,
                        "sender_nick": user["nickname"],
                        "nickname": user["nickname"],
                    })

            # ── DM read receipt ───────────────────────────────────────
            elif msg_type == "dm_read":
                channel_id = int(data.get("channel_id", 0))
                try:
                    up_to = int(data.get("up_to") or data.get("last_msg_id") or 0)
                except (TypeError, ValueError):
                    up_to = 0
                if channel_id <= 0:
                    continue
                if up_to <= 0:
                    with db._conn() as con:
                        row = con.execute(
                            "SELECT MAX(id) AS m FROM dm_messages WHERE channel_id=? AND deleted=0",
                            (channel_id,)
                        ).fetchone()
                    up_to = (row["m"] or 0) if row else 0
                if up_to <= 0:
                    continue
                ok, peer_id, new_read = db.mark_dm_read(channel_id, user["id"], up_to)
                if ok and peer_id and peer_id != user["id"] and db.get_privacy_read_receipts(user["id"]):
                    await manager.send_to_user(peer_id, {
                        "type": "dm_read",
                        "channel_id": channel_id,
                        "reader_id": user["id"],
                        "last_read": new_read,
                    })

            # ── DM react ─────────────────────────────────────────────
            elif msg_type == "dm_react":
                msg_id = int(data.get("id", 0))
                emoji = str(data.get("emoji", ""))[:10]
                channel_id = int(data.get("channel_id", 0))
                if not emoji:
                    continue
                counts = db.toggle_dm_reaction(msg_id, user["id"], emoji)
                payload = {
                    "type": "dm_reaction", "id": msg_id,
                    "channel_id": channel_id, "reactions": counts,
                }
                await manager.send_personal(websocket, payload)
                with db._conn() as con:
                    ch = con.execute(
                        "SELECT user_a, user_b FROM dm_channels WHERE id=?", (channel_id,)
                    ).fetchone()
                if ch:
                    other_id = ch["user_b"] if ch["user_a"] == user["id"] else ch["user_a"]
                    await manager.send_to_user(other_id, payload)

            # ── WebRTC call signaling ─────────────────────────────────
            elif msg_type == "call_offer":
                to_id = _resolve_to_id(data)
                if not to_id:
                    # Tell caller so they don't sit on an endless "Calling…" screen.
                    await manager.send_personal(websocket, {
                        "type": "call_error",
                        "reason": "user_not_found",
                        "to_nickname": data.get("to_nickname") or data.get("to_nick"),
                    })
                    continue
                call_type = data.get("call_type", "voice")
                is_renegotiate = bool(data.get("renegotiate"))
                if is_renegotiate:
                    # Don't create a new call row; just forward the SDP to the peer.
                    await manager.send_to_user(to_id, {
                        "type": "call_offer",
                        "from_id": user["id"],
                        "from_nickname": user["nickname"],
                        "call_type": call_type,
                        "sdp": data.get("sdp"),
                        "renegotiate": True,
                    })
                    continue
                call_id_db = db.create_call(user["id"], to_id, call_type)
                payload_offer = {
                    "type": "call_offer",
                    "from_id": user["id"],
                    "from_nickname": user["nickname"],
                    "from_avatar": user.get("avatar"),
                    "call_type": call_type,
                    "call_id": call_id_db,
                    "sdp": data.get("sdp"),
                }
                db.save_pending_call_offer(
                    call_id_db,
                    user["id"],
                    to_id,
                    user["nickname"],
                    user.get("avatar"),
                    call_type,
                    data.get("sdp") or "",
                )
                delivered = await manager.send_to_user(to_id, payload_offer)
                # Tell caller their call_id so call_end can reference it even
                # if the callee never answers.
                await manager.send_personal(websocket, {
                    "type": "call_created",
                    "call_id": call_id_db,
                })
                call_label = "📹 Video" if call_type == "video" else "📞 Voice"
                # Always fire a *high-priority* call push, even if the user appears
                # online via WS — locked phones and backgrounded browsers need this
                # to actually ring.
                _push_always(
                    to_id,
                    f"{call_label} call",
                    f"{user['nickname']} is calling…",
                    "/app",
                    kind="call",
                    tag=f"ft-call-{call_id_db}",
                    require_interaction=True,
                    extra={
                        "call_id":       call_id_db,
                        "from_nickname": user["nickname"],
                        "from_avatar":   user.get("avatar") or "",
                        "call_type":     call_type,
                    },
                )
                # No hard "peer_offline" error here: push ringing + pending-offer
                # recovery allows the callee to answer after cold-start.

            elif msg_type == "call_answer":
                to_id = _resolve_to_id(data)
                if not to_id:
                    continue
                call_id = int(data.get("call_id", 0))
                is_renegotiate = bool(data.get("renegotiate"))
                print(f"[CALLDBG] call_answer from uid={user['id']} call_id={call_id} is_renegotiate={is_renegotiate}", flush=True)
                if call_id and not is_renegotiate:
                    db.update_call_status(call_id, "active",
                                          started_at=datetime.utcnow().isoformat())
                    db.delete_pending_call_offer(call_id)
                await manager.send_to_user(to_id, {
                    "type": "call_answer",
                    "from_id": user["id"],
                    "from_nickname": user["nickname"],
                    "call_id": call_id,
                    "sdp": data.get("sdp"),
                    "renegotiate": is_renegotiate,
                })

            elif msg_type == "call_reject":
                to_id = _resolve_to_id(data)
                if not to_id:
                    continue
                call_id = int(data.get("call_id", 0))
                call_row = None
                if call_id:
                    db.delete_pending_call_offer(call_id)
                    with db._conn() as con:
                        call_row = con.execute(
                            "SELECT id, caller_id, callee_id, call_type FROM calls WHERE id=?",
                            (call_id,)
                        ).fetchone()
                    db.update_call_status(call_id, "rejected",
                                          ended_at=datetime.utcnow().isoformat())
                # Emit "Declined" DM call log for both parties.
                caller_id = to_id
                callee_id = user["id"]
                call_type_val = "voice"
                if call_row:
                    caller_id = int(call_row["caller_id"])
                    callee_id = int(call_row["callee_id"])
                    call_type_val = call_row["call_type"] or "voice"
                decliner = db.get_user_by_id(callee_id) or {}
                decliner_nick = decliner.get("nickname") or "Someone"
                await _emit_dm_call_log(
                    caller_id,
                    callee_id,
                    call_type_val,
                    "Declined",
                    f"{decliner_nick} declined",
                    "📵",
                    "declined",
                )
                await manager.send_to_user(to_id, {
                    "type": "call_reject",
                    "from_id": user["id"],
                    "from_nickname": user["nickname"],
                    "call_id": call_id,
                })

            elif msg_type == "call_end":
                to_id = _resolve_to_id(data)
                if not to_id:
                    continue
                call_id = int(data.get("call_id", 0))
                was_connected = bool(data.get("was_connected"))
                print(f"[CALLDBG] call_end from uid={user['id']} call_id={call_id} was_connected={was_connected} raw_was_connected={data.get('was_connected')!r} duration={data.get('duration_seconds')!r}", flush=True)
                duration_hint_secs = None
                try:
                    if data.get("duration_seconds") is not None:
                        duration_hint_secs = int(data.get("duration_seconds"))
                except Exception:
                    duration_hint_secs = None
                call_row = None
                with db._conn() as con:
                    if call_id:
                        call_row = con.execute(
                            "SELECT id, caller_id, callee_id, call_type, status, started_at FROM calls WHERE id=?",
                            (call_id,)
                        ).fetchone()
                    if not call_row:
                        call_row = con.execute(
                            """
                            SELECT id, caller_id, callee_id, call_type, status, started_at
                            FROM calls
                            WHERE ((caller_id=? AND callee_id=?) OR (caller_id=? AND callee_id=?))
                            ORDER BY id DESC LIMIT 1
                            """,
                            (user["id"], to_id, to_id, user["id"])
                        ).fetchone()
                if call_row:
                    call_id = int(call_row["id"])
                    status = str(call_row["status"] or "")
                    db.delete_pending_call_offer(call_id)
                    print(f"[CALLDBG] call_end lookup: call_id={call_id} status={status!r} was_connected={was_connected}", flush=True)
                    if status == "ringing" and not was_connected:
                        db.update_call_status(call_id, "missed",
                                              ended_at=datetime.utcnow().isoformat())
                        caller_id = int(call_row["caller_id"])
                        callee_id = int(call_row["callee_id"])
                        caller = db.get_user_by_id(caller_id) or {}
                        call_label = "video" if call_row["call_type"] == "video" else "voice"
                        await _emit_dm_call_log(
                            caller_id,
                            callee_id,
                            call_row["call_type"],
                            "Missed call",
                            f"Missed a {call_label} call from {caller.get('nickname') or 'someone'}",
                            "📵",
                            "missed",
                        )
                        _push_always(
                            callee_id,
                            "📵 Missed call",
                            f"Missed a {call_label} call from {caller.get('nickname') or 'someone'}",
                            "/app",
                            kind="missed_call",
                            tag=f"ft-missed-{call_id}",
                            require_interaction=False,
                        )
                    elif status in ("active", "ringing"):
                        ended_at = datetime.utcnow().isoformat()
                        db.update_call_status(call_id, "ended", ended_at=ended_at)
                        caller_id = int(call_row["caller_id"])
                        callee_id = int(call_row["callee_id"])
                        call_label = "video" if call_row["call_type"] == "video" else "voice"
                        duration_str = _format_duration(call_row["started_at"], ended_at)
                        if not duration_str:
                            duration_str = _format_duration_secs(duration_hint_secs)
                        title = f"{call_label.capitalize()} call" + (f" · {duration_str}" if duration_str else "")
                        await _emit_dm_call_log(
                            caller_id,
                            callee_id,
                            call_row["call_type"],
                            title,
                            "",
                            "📞",
                            "ended",
                        )
                    else:
                        # rejected, ended, or unknown — just mark ended, log already written
                        db.update_call_status(call_id, "ended",
                                              ended_at=datetime.utcnow().isoformat())
                await manager.send_to_user(to_id, {
                    "type": "call_end",
                    "from_id": user["id"],
                    "from_nickname": user["nickname"],
                    "call_id": call_id,
                })

            elif msg_type == "ice_candidate":
                to_id = _resolve_to_id(data)
                if not to_id:
                    continue
                await manager.send_to_user(to_id, {
                    "type": "ice_candidate",
                    "from_id": user["id"],
                    "from_nickname": user["nickname"],
                    "call_id": data.get("call_id"),
                    "candidate": data.get("candidate"),
                })

            # ── Group voice channel signaling ─────────────────────────
            elif msg_type == "voice_join":
                # User wants to join voice channel in current room
                existing = voice_manager.join(
                    room_name, user["id"], user["nickname"], user.get("avatar")
                )
                if existing is None:
                    await manager.send_personal(websocket, {
                        "type": "voice_error",
                        "error": "Voice channel is full (max 8 users)"
                    })
                    continue
                
                # Notify existing participants about new joiner
                await manager.broadcast_room(room_name, {
                    "type": "voice_user_joined",
                    "room": room_name,
                    "user_id": user["id"],
                    "nickname": user["nickname"],
                    "avatar": user.get("avatar"),
                    "participants": voice_manager.participants(room_name)
                }, exclude=websocket)
                
                # Send joiner the list of existing participants to connect to
                await manager.send_personal(websocket, {
                    "type": "voice_joined",
                    "participants": [
                        {"user_id": p[0], "nickname": p[1], "avatar": p[2]}
                        for p in existing
                    ]
                })

            elif msg_type == "voice_leave":
                # User leaves voice channel
                voice_manager.leave(room_name, user["id"])
                await manager.broadcast_room(room_name, {
                    "type": "voice_user_left",
                    "room": room_name,
                    "user_id": user["id"],
                    "nickname": user["nickname"],
                    "participants": voice_manager.participants(room_name)
                })

            elif msg_type == "voice_offer":
                # WebRTC offer to specific participant in voice channel
                to_id = int(data.get("to_id", 0))
                if not to_id or not voice_manager.is_in_voice(room_name, to_id):
                    continue
                await manager.send_to_user(to_id, {
                    "type": "voice_offer",
                    "from_id": user["id"],
                    "from_nickname": user["nickname"],
                    "sdp": data.get("sdp"),
                    "room": room_name
                })

            elif msg_type == "voice_answer":
                # WebRTC answer to specific participant
                to_id = int(data.get("to_id", 0))
                if not to_id or not voice_manager.is_in_voice(room_name, to_id):
                    continue
                await manager.send_to_user(to_id, {
                    "type": "voice_answer",
                    "from_id": user["id"],
                    "from_nickname": user["nickname"],
                    "sdp": data.get("sdp"),
                    "room": room_name
                })

            elif msg_type == "voice_ice":
                # ICE candidate for specific participant
                to_id = int(data.get("to_id", 0))
                if not to_id or not voice_manager.is_in_voice(room_name, to_id):
                    continue
                await manager.send_to_user(to_id, {
                    "type": "voice_ice",
                    "from_id": user["id"],
                    "candidate": data.get("candidate"),
                    "room": room_name
                })

            elif msg_type == "voice_mute":
                # Broadcast mic-mute state so other clients can render a
                # muted indicator next to the participant's name. No server
                # state needed — purely cosmetic signal.
                muted = bool(data.get("muted"))
                await manager.broadcast_room(room_name, {
                    "type": "voice_mute",
                    "room": room_name,
                    "user_id": user["id"],
                    "nickname": user["nickname"],
                    "muted": muted,
                }, exclude=websocket)

            # ── Friend request notification ───────────────────────────
            elif msg_type == "friend_notify":
                to_id = _resolve_to_id(data)
                if not to_id:
                    continue
                payload_fn = {
                    "type": "friend_notify",
                    "action": data.get("action", "request"),
                    "from": user["nickname"],
                    "from_avatar": user.get("avatar"),
                }
                await manager.send_to_user(to_id, payload_fn)
                _push(to_id, "👥 Friend Request",
                      f"{user['nickname']} wants to be friends", "/app")


    except (WebSocketDisconnect, Exception) as exc:
        if not isinstance(exc, WebSocketDisconnect):
            import traceback
            traceback.print_exc()
        # Clean up voice channels first
        rooms_left = voice_manager.leave_all(user["id"])
        for vc_room in rooms_left:
            await manager.broadcast_room(vc_room, {
                "type": "voice_user_left",
                "room": vc_room,
                "user_id": user["id"],
                "nickname": user["nickname"],
                "participants": voice_manager.participants(vc_room)
            })
        
        result = manager.disconnect(websocket)
        if result:
            room, nickname = result
            await manager.broadcast_room(room, {
                "type": "presence",
                "event": "leave",
                "nickname": nickname,
                "room": room,
                "users": manager.online_nicknames(room),
            })
            await manager.broadcast_room(room, {
                "type": "online_users",
                "room": room,
                "users": manager.online_nicknames(room),
            })
