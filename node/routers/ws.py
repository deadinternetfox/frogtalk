"""WebSocket route - real-time messaging, DM delivery, WebRTC signaling."""
import asyncio
import json
import logging
import time
import uuid
from datetime import datetime
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

import database as db
from ws_manager import manager, voice_manager

logger = logging.getLogger(__name__)
router = APIRouter(tags=["websocket"])

# HIGH-4: cap the number of concurrent worker threads we'll burn on
# best-effort push notifications. Without a cap a sudden 1000-message
# burst would spawn 1000 simultaneous FCM/APNs/web-push attempts and
# starve the threadpool for legitimate request work.
_PUSH_CONCURRENCY = 32
_push_semaphore = asyncio.Semaphore(_PUSH_CONCURRENCY)

MAX_MSG_LEN = 10_000
MAX_MEDIA_BYTES = 20 * 1024 * 1024
ALLOWED_MEDIA = (
    'data:image/', 'data:video/', 'data:audio/',
    'data:application/pdf', 'data:application/octet-stream',
)

# Slowmode tracking: (user_id, room_name) -> last_message_timestamp
_slowmode_tracker: dict = {}

# Per-user call.offer rate limiter: bounded ring rate so a malicious or
# compromised account can't ring-bomb their friends list (or pump
# federation outbox capacity) by enqueueing thousands of call.offer
# events. ``_call_offer_window`` is the sliding window size in seconds;
# ``_call_offer_max`` is the number of permitted offers in that window.
_CALL_OFFER_WINDOW_S = 30
_CALL_OFFER_MAX = 8
_call_offer_tracker: dict[int, list[float]] = {}


def _call_offer_allowed(user_id: int) -> bool:
    """Sliding-window throttle for outbound call_offer per caller."""
    try:
        uid = int(user_id)
    except Exception:
        return False
    if uid <= 0:
        return False
    now = time.monotonic()
    bucket = _call_offer_tracker.get(uid)
    if bucket is None:
        bucket = []
        _call_offer_tracker[uid] = bucket
    cutoff = now - _CALL_OFFER_WINDOW_S
    while bucket and bucket[0] < cutoff:
        bucket.pop(0)
    if len(bucket) >= _CALL_OFFER_MAX:
        return False
    bucket.append(now)
    return True


def _ws_origin_allowed(websocket: WebSocket) -> bool:
    """Block cross-site WebSocket hijacking (CSWSH).

    Browsers do not enforce the Same-Origin Policy on WS upgrades the way
    they do on XHR/fetch — a malicious page at https://evil.example can
    open `new WebSocket('wss://frogtalk.xyz/ws/general?token=…')` and, if
    the victim's auth token has leaked via any other vector, drive their
    session. The defence is to reject upgrades whose `Origin` header is
    not one of our own front-ends.

    Allowed: same host as the Host header, or any entry from the
    `FROGTALK_ALLOWED_ORIGINS` env var (comma-separated). Native mobile
    clients (iOS/Android WebSocket libraries, Electron desktop) typically
    omit the Origin header — we accept those because there is no
    browser-driven cross-site risk.
    """
    import os as _os
    origin = (websocket.headers.get("origin") or "").strip()
    if not origin:
        # Non-browser client — no cross-site risk in the CSWSH sense.
        return True
    host = (websocket.headers.get("host") or "").strip().lower()
    try:
        from urllib.parse import urlparse as _urlparse
        oh = (_urlparse(origin).hostname or "").lower()
    except Exception:
        return False
    if not oh:
        return False
    # Strip any :port from Host for the comparison.
    host_only = host.split(":", 1)[0]
    if oh == host_only:
        return True
    extra = [s.strip().lower() for s in (_os.getenv("FROGTALK_ALLOWED_ORIGINS") or "").split(",") if s.strip()]
    for e in extra:
        try:
            eh = (_urlparse(e if "://" in e else f"https://{e}").hostname or "").lower()
        except Exception:
            continue
        if eh and eh == oh:
            return True
    return False


def _validate_call_participant(call_id: int, sender_id: int, to_id: int) -> bool:
    """Reject WebRTC signaling messages whose ``call_id`` doesn't actually
    bind the sender and the recipient.

    HIGH-6: ``ice_candidate`` / ``call_answer`` / call_offer-renegotiate
    used to forward any ``(call_id, to_id)`` pair the sender claimed —
    so an authenticated attacker could spray ICE/SDP at any user by
    guessing/observing a ``call_id`` and forging the ``from_*`` fields
    the recipient renders in their incoming-call UI.

    Returns False (drop the message) when:

    * ``call_id`` is missing or doesn't exist;
    * the sender isn't the caller or callee on the row;
    * the recipient isn't the *other* participant; or
    * the call is already closed (``rejected`` / ``ended`` / ``missed``).
    """
    if not call_id or not sender_id or not to_id:
        return False
    try:
        with db._conn() as con:
            row = con.execute(
                "SELECT caller_id, callee_id, status FROM calls WHERE id=?",
                (int(call_id),),
            ).fetchone()
    except Exception:
        return False
    if not row:
        return False
    caller_id = int(row["caller_id"] or 0)
    callee_id = int(row["callee_id"] or 0)
    status = (row["status"] or "").lower()
    if status in {"rejected", "ended", "missed", "declined", "cancelled"}:
        return False
    if sender_id == caller_id and to_id == callee_id:
        return True
    if sender_id == callee_id and to_id == caller_id:
        return True
    return False


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


async def _push_bg(user_id: int, title: str, body: str, url: str, extra: dict) -> None:
    """Worker coroutine: bounded by ``_push_semaphore`` so a message burst
    can't spawn unlimited threads. ``send_push`` is synchronous (httpx
    + FCM + APNs + web-push) so it must run off the event loop."""
    async with _push_semaphore:
        try:
            from routers.push import send_push
            await asyncio.to_thread(send_push, user_id, title, body, url, **extra)
        except Exception:
            logger.exception("background push failed for user=%s", user_id)


def _push(user_id: int, title: str, body: str, url: str = "/app", **extra):
    """Fire-and-forget web push when user is not online via WS.

    HIGH-4: scheduled on the event loop and run in a worker thread. The
    old implementation called ``send_push`` synchronously inside the
    WebSocket coroutine, which blocked the entire loop for the duration
    of the FCM/APNs round-trips (often 300–1500 ms).
    """
    if manager.is_user_online(user_id):
        return  # already connected, no need for push
    try:
        asyncio.create_task(_push_bg(user_id, title, body, url, extra))
    except RuntimeError:
        # No running loop (shouldn't happen in a WS context) — fall back
        # to a direct sync call so we still attempt delivery.
        try:
            from routers.push import send_push
            send_push(user_id, title, body, url, **extra)
        except Exception:
            pass


def _push_always(user_id: int, title: str, body: str, url: str = "/app", **extra):
    """Push even if the user appears online — used for calls so locked phones /
    backgrounded browsers still wake up and ring."""
    try:
        asyncio.create_task(_push_bg(user_id, title, body, url, extra))
    except RuntimeError:
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
    # CSWSH defence: refuse browser upgrades that didn't come from one of
    # our own origins. Non-browser clients (mobile, Electron) generally
    # omit Origin and are allowed through.
    if not _ws_origin_allowed(websocket):
        await websocket.close(code=4007)
        return
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
        avatar=user.get("avatar"), is_admin=user.get("is_admin", False),
        display_name=user.get("display_name")
    )
    if accepted is False:
        # Per-IP cap reached; manager.connect already closed with 4008.
        return
    db.update_last_seen(user["id"])

    # Drain any ICE candidates that the other side trickled while this user
    # was still cold-booting from a push-wake. Without this drain, ICE often
    # can't complete with only the late candidates and the call sticks on
    # "Connecting…".
    try:
        pending_ice = db.drain_pending_ice_candidates(user["id"])
        for row in pending_ice:
            try:
                await manager.send_personal(websocket, {
                    "type": "ice_candidate",
                    "from_id": int(row.get("from_id") or 0),
                    "from_nickname": str(row.get("from_nick") or ""),
                    "call_id": row.get("call_id"),
                    "candidate": row.get("candidate"),
                })
            except Exception:
                pass
    except Exception:
        logger.exception("drain_pending_ice_candidates failed")

    # Drain queued call control signals (call_end / call_reject) that the
    # other side sent while this user was off-WS. Without this, hangup races
    # against the callee's WS-flap window and the callee gets stuck on a
    # zombie "Connecting…" overlay forever.
    try:
        pending_sigs = db.drain_pending_call_signals(user["id"])
        for row in pending_sigs:
            try:
                kind = str(row.get("kind") or "")
                payload_str = row.get("payload") or "{}"
                try:
                    payload = json.loads(payload_str)
                except Exception:
                    payload = {}
                if not isinstance(payload, dict):
                    payload = {}
                payload.setdefault("type", kind or "call_end")
                payload.setdefault("from_id", int(row.get("from_id") or 0))
                payload.setdefault("from_nickname", str(row.get("from_nick") or ""))
                if row.get("call_id"):
                    payload.setdefault("call_id", row.get("call_id"))
                await manager.send_personal(websocket, payload)
            except Exception:
                pass
    except Exception:
        logger.exception("drain_pending_call_signals failed")

    # Drain queued room-key envelopes from any rotations that happened
    # while this user was offline. Without this drain the user would see
    # opaque ciphertext for every message encrypted under a newer key
    # version until a mod manually re-shares the secret.
    try:
        pending_envs = db.drain_pending_room_key_envelopes(user["id"])
        for row in pending_envs:
            try:
                await manager.send_personal(websocket, {
                    "type": "room_key_envelope",
                    "room": row.get("room_name"),
                    "version": int(row.get("version") or 0),
                    "env": row.get("env"),
                    "from_user_id": int(row.get("from_user_id") or 0),
                    "from_nickname": row.get("from_nick") or "",
                    "reason": row.get("reason") or "manual",
                })
            except Exception:
                pass
    except Exception:
        logger.exception("drain_pending_room_key_envelopes failed")

    # Auto-add to room_members on connect so they appear in the offline list
    # when they're not connected. Skip DM channels (prefixed with "dm-").
    if not room_name.startswith("dm-"):
        try:
            _room_data = db.get_room_by_name(room_name)
            if _room_data:
                # Detect "first time joining" so we can broadcast a
                # member_joined to everyone else's sidebar — without this
                # the right-hand member list would only update on their
                # next reload of the channel.
                _was_member = False
                try:
                    _was_member = bool(db.is_room_member(user["id"], _room_data["id"]))
                except Exception:
                    _was_member = False
                db.join_room(user["id"], _room_data["id"])
                if not _was_member:
                    try:
                        await manager.broadcast_room(room_name, {
                            "type": "member_joined",
                            "room": room_name,
                            "user_id": user["id"],
                            "nickname": user["nickname"],
                            "avatar": user.get("avatar"),
                        })
                    except Exception:
                        pass
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
                "sender_display_name": caller.get("display_name"),
                "sender_avatar": caller.get("avatar") or "",
                "sender_is_admin": bool(caller.get("is_admin")),
                "content": content,
                "media_type": None,
                "media_name": None,
                "reply_to": None,
                "edited": False,
                "deleted": False,
                "reactions": {},
                "created_at": datetime.utcnow().isoformat() + "Z",
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

    # Hard cap on per-frame size BEFORE json.loads so a peer can't burn
    # CPU/RAM by streaming a multi-megabyte JSON object. Anything legitimate
    # (message text, reactions, typing, presence) fits comfortably under
    # 256 KB; encrypted media goes through the HTTP /api/messages path.
    _WS_MAX_FRAME = 262_144  # 256 KB
    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except RuntimeError:
                break
            if len(raw) > _WS_MAX_FRAME:
                # Drop oversize frames silently; logging the body would
                # itself be a memory amplifier under flood.
                try:
                    await manager.send_personal(websocket, {
                        "type": "error", "text": "Frame too large",
                    })
                except Exception:
                    pass
                continue
            try:
                data = json.loads(raw)
            except json.JSONDecodeError as _je:
                # Previously this silently dropped malformed frames,
                # which made the client look like it was sending into
                # the void when a JSON serializer messed up an escape.
                # Surface a short error frame so the client (or a
                # logging proxy) can see what happened.
                try:
                    await manager.send_personal(websocket, {
                        "type": "error",
                        "error": "invalid_json",
                        "detail": str(_je)[:200],
                    })
                except Exception:
                    pass
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

                # Authoritative per-message access check. The connect-time
                # check above is necessary but NOT sufficient: a mod can
                # ban a user mid-session, and without this check the
                # banned user could keep sending until their WS drops on
                # its own (could be minutes or until reload). Re-check
                # on every send so a fresh `room_bans` row takes effect
                # immediately. DM pseudo-rooms (`dm-*`) live outside the
                # rooms table and are handled by the DM endpoints.
                if not room_name.startswith("dm-"):
                    if not db.user_can_access_room(
                        user["id"], room_name, is_admin=bool(user.get("is_admin"))
                    ):
                        await manager.send_personal(websocket, {
                            "type": "error",
                            "text": "You can't send messages in this channel",
                        })
                        # Close the socket so the client falls back to the
                        # banned-screen path on reconnect.
                        try:
                            await websocket.close(code=4003)
                        except Exception:
                            pass
                        break

                # Preserve internal whitespace so multi-line messages
                # and pasted code-blocks aren't corrupted; only the
                # empty-check uses `.strip()`.
                content = str(data.get("content", ""))
                media_data = data.get("media_data")
                media_type = data.get("media_type")
                reply_to = data.get("reply_to")

                if not content.strip() and not media_data:
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
                    # Fall back to a DB lookup so a server restart does
                    # not reset the user's slowmode window.
                    if last_msg <= 0:
                        try:
                            last_msg = db.get_user_last_message_epoch(room_name, user["id"]) or 0
                        except Exception:
                            last_msg = 0
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
                    media_blur, view_once,
                    key_version=int(data.get("key_version") or 0),
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
                    "display_name": user.get("display_name"),
                    "is_admin": bool(user.get("is_admin")),
                    "content": content,
                    "key_version": int(data.get("key_version") or 0),
                    "media_data": media_data,
                    "media_type": media_type,
                    "media_blur": media_blur,
                    "view_once": view_once,
                    "reply_to": reply_to,
                    "reply_nickname": reply_nickname,
                    "reply_content": reply_content,
                    "edited": False,
                    "reactions": {},
                    "created_at": datetime.utcnow().isoformat() + "Z",
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
                        display_name=user.get("display_name"),
                    )
                except Exception:
                    pass

                # Federation: room chat is sent over WebSocket in the app;
                # REST /messages also enqueues — without this, peers never
                # see cross-node history for the same channel.
                if not room_name.startswith("dm-"):
                    try:
                        from routers import federation as federation_mod
                        federation_mod.enqueue_room_message_created(
                            user,
                            room_name=room_name,
                            content=content,
                            media_data=media_data,
                            media_type=media_type,
                            media_blur=media_blur,
                            view_once=view_once,
                            created_at=payload["created_at"],
                        )
                    except Exception:
                        logger.exception("federation: failed to enqueue room message")

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
                    # Mirror the deletion onto every linked bridge so a
                    # delete in FrogTalk also removes the message in
                    # Telegram / Discord. Best-effort, fire-and-forget.
                    try:
                        import bridge_outbound
                        bridge_outbound.forward_user_delete(room_name, msg_id)
                    except Exception:
                        pass

            # ── Edit message ──────────────────────────────────────────
            elif msg_type == "edit":
                msg_id = int(data.get("id", 0))
                # Keep internal whitespace; only the empty-check trims.
                new_content = str(data.get("content", ""))
                if not new_content.strip() or len(new_content) > MAX_MSG_LEN:
                    continue
                # Check if user is room owner
                room_info = db.get_room_by_name(room_name)
                is_room_owner = room_info and room_info.get("owner_id") == user["id"]
                kv = data.get("key_version")
                ok = db.edit_message(
                    msg_id, user["id"], new_content,
                    bool(user.get("is_admin")), is_room_owner,
                    key_version=(int(kv) if kv is not None else None),
                )
                if ok:
                    await manager.broadcast_room(room_name, {
                        "type": "edit", "id": msg_id,
                        "content": new_content, "room": room_name,
                        "key_version": int(kv) if kv is not None else 0,
                    })
                    # For E2EE rooms the client sends the bridge-safe
                    # plaintext version of the edit alongside the
                    # ciphertext, mirroring the original-send code path.
                    try:
                        import bridge_outbound
                        plain = str(data.get("bridge_plain") or "").strip()
                        outbound_text = plain or new_content
                        bridge_outbound.forward_user_edit(
                            room_name, msg_id, outbound_text,
                            nickname=user["nickname"],
                        )
                    except Exception:
                        pass

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
                # Only owners, mods, or global admins may pin. Previous
                # logic was an `or True` no-op that let anyone pin.
                if db.can_moderate_room(room_name, user["id"], bool(user.get("is_admin"))):
                    ok = db.pin_message(room_name, msg_id, user["id"])
                    if ok:
                        await manager.broadcast_room(room_name, {
                            "type": "pin", "id": msg_id, "room": room_name,
                            "by": user["nickname"],
                        })

            # ── Unpin message ─────────────────────────────────────────
            elif msg_type == "unpin":
                msg_id = int(data.get("id", 0))
                if db.can_moderate_room(room_name, user["id"], bool(user.get("is_admin"))):
                    db.unpin_message(room_name, msg_id)
                    await manager.broadcast_room(room_name, {
                        "type": "unpin", "id": msg_id, "room": room_name,
                        "by": user["nickname"],
                    })

            # ── DM message (real-time relay) ──────────────────────────
            elif msg_type == "dm_message":
                channel_id = int(data.get("channel_id", 0))
                # Preserve original bytes so Signal envelopes and
                # multi-line plaintext both round-trip cleanly.
                content = str(data.get("content", ""))
                media_data = data.get("media_data")
                media_type_dm = data.get("media_type")
                media_name = data.get("media_name")
                reply_to_dm = data.get("reply_to")

                if not content.strip() and not media_data:
                    continue

                # Verify membership
                _, ok = db.get_dm_messages(channel_id, user["id"], 1)
                if not ok:
                    continue

                # ── Block enforcement (WS fast path) ───────────────────
                # The HTTP send route already gates on is_blocked_either_way;
                # the WS path was missing the same guard so a blocked user
                # could still spam DMs over the live socket. Resolve the
                # peer here and reject silently with a typed error frame so
                # the sender's client can render "blocked by @peer".
                try:
                    with db._conn() as con:
                        _ch = con.execute(
                            "SELECT user_a, user_b FROM dm_channels WHERE id=?",
                            (channel_id,),
                        ).fetchone()
                except Exception:
                    _ch = None
                if _ch:
                    _peer_id = _ch["user_b"] if _ch["user_a"] == user["id"] else _ch["user_a"]
                    if _peer_id and _peer_id != user["id"] \
                            and db.is_blocked_either_way(user["id"], _peer_id):
                        # Tell the client which direction the block goes so
                        # the UI can show the right message. We deliberately
                        # only expose direction inside an EXISTING DM channel
                        # (where the parties already know each other) — the
                        # /api/dms/open path still returns a vague 404.
                        i_blocked = db.is_blocked(user["id"], _peer_id)
                        peer_blocked_me = db.is_blocked(_peer_id, user["id"])
                        peer_row = db.get_user_by_id(_peer_id) or {}
                        await manager.send_personal(websocket, {
                            "type": "dm_send_error",
                            "channel_id": channel_id,
                            "client_nonce": data.get("client_nonce"),
                            "code": "blocked",
                            "i_blocked": bool(i_blocked),
                            "blocked_by_them": bool(peer_blocked_me),
                            "peer_nickname": peer_row.get("nickname") or "",
                        })
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
                    "sender_display_name": user.get("display_name"),
                    "sender_avatar": user.get("avatar"),
                    "sender_is_admin": bool(user.get("is_admin")),
                    "content": content,
                    "media_data": media_data,
                    "media_type": media_type_dm,
                    "media_name": media_name,
                    "reply_to": reply_to_dm,
                    "edited": False,
                    "deleted": False,
                    "reactions": {},
                    "created_at": datetime.utcnow().isoformat() + "Z",
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
                    # ALWAYS push, even if the recipient is online via WS:
                    # otherwise the only path to a tray notification is the
                    # JS bridge (window.Android.showNotification) and on
                    # Samsung One UI / MIUI that bridge call sometimes
                    # produces no visible heads-up when the WebView is
                    # paused — user heard the in-app "tink" but nothing
                    # appeared in the tray. With _push_always the FCM
                    # service is the single source of truth for tray
                    # notifications; it skips itself when the activity is
                    # currently visible (MainActivity.isAppVisible == true)
                    # so we don't double-alert the user when they're
                    # actively using the app. sender_name plumbs the raw
                    # nickname into dm_nick so the tap PendingIntent opens
                    # the correct DM thread.
                    #
                    # PRIVACY: never put the message body into the push
                    # payload. E2E is opt-in and per-device — phones
                    # without a passphrase set send DMs in cleartext, and
                    # forwarding that here ends up rendering in the
                    # system tray on whatever device(s) the recipient
                    # has the app installed on. Generic body only; the
                    # in-app fetch on tap loads the real message.
                    _push_always(
                        other_id,
                        "FrogTalk",
                        f"💬 New message from {user['nickname']}",
                        "/app",
                        extra={
                            "sender_name": user["nickname"],
                            "conversation_id": str(channel_id),
                            "conversation_name": user["nickname"],
                        },
                    )

                    # Federation: mirror DM to peer nodes (signed outbox).
                    try:
                        from routers import federation as federation_mod
                        peer = db.get_user_by_id(other_id) or {}
                        federation_mod.enqueue_dm_message_created(
                            user,
                            peer,
                            channel_id=channel_id,
                            content=content,
                            media_data=media_data,
                            media_type=media_type_dm,
                            media_name=media_name,
                            reply_to=reply_to_dm,
                            media_blur=int(data.get("media_blur") or 0),
                            view_once=int(data.get("view_once") or 0),
                            created_at=payload["created_at"],
                        )
                    except Exception:
                        logger.exception("federation: failed to enqueue DM message")

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
                    # HIGH-6: a renegotiate must reference an active call
                    # the sender is actually a participant in.
                    if not _validate_call_participant(int(data.get("call_id") or 0), user["id"], to_id):
                        continue
                    # Don't create a new call row; just forward the SDP to the peer.
                    reneg_payload = {
                        "type": "call_offer",
                        "from_id": user["id"],
                        "from_nickname": user["nickname"],
                        "call_type": call_type,
                        "sdp": data.get("sdp"),
                        # Track E: signed DTLS fingerprint envelope. Server
                        # is opaque transport — it never inspects or
                        # mutates this field, just forwards verbatim.
                        "fp_sig": data.get("fp_sig") or "",
                        "renegotiate": True,
                        "force_relay": bool(data.get("force_relay")),
                        "call_id": int(data.get("call_id") or 0),
                    }
                    delivered_reneg = await manager.send_to_user(to_id, reneg_payload)
                    if not delivered_reneg:
                        try:
                            db.queue_call_signal(
                                call_id=int(data.get("call_id") or 0),
                                target_id=to_id,
                                from_id=user["id"],
                                from_nick=user["nickname"],
                                kind="call_offer",
                                payload=json.dumps(reneg_payload),
                            )
                        except Exception:
                            logger.exception("queue_call_signal(call_offer renegotiate) failed")
                    continue
                # Rate-limit new (non-renegotiate) call_offer per caller so
                # one user can't ring-bomb their friend list or pump
                # outbound federation queue.
                if not _call_offer_allowed(user["id"]):
                    await manager.send_personal(websocket, {
                        "type": "call_error",
                        "reason": "rate_limited",
                    })
                    continue
                callee_user = db.get_user_by_id(to_id) or {}
                try:
                    import federation_calls as _fc
                    if _fc.is_remote_peer(callee_user):
                        block_err = _fc.can_call_user(user["id"], to_id)
                        if block_err:
                            await manager.send_personal(websocket, {
                                "type": "call_error",
                                "reason": block_err,
                            })
                            continue
                        gid = _fc.new_global_call_id()
                        call_id_db = db.create_call(
                            user["id"], to_id, call_type, global_call_id=gid,
                        )
                        ident = db.get_or_create_local_server_identity() or {}
                        local_sid = str(ident.get("server_id") or "").strip()
                        db.map_federation_call(gid, local_sid, call_id_db, "caller")
                        _fc.enqueue_call_offer(
                            user,
                            callee_user,
                            global_call_id=gid,
                            local_call_id=call_id_db,
                            call_type=call_type,
                            sdp=data.get("sdp") or "",
                            fp_sig=data.get("fp_sig") or "",
                        )
                        await manager.send_personal(websocket, {
                            "type": "call_created",
                            "call_id": call_id_db,
                            "global_call_id": gid,
                            "federated": True,
                        })
                        continue
                except Exception:
                    logger.exception("federated call_offer routing failed")
                call_id_db = db.create_call(user["id"], to_id, call_type)
                payload_offer = {
                    "type": "call_offer",
                    "from_id": user["id"],
                    "from_nickname": user["nickname"],
                    "from_avatar": user.get("avatar"),
                    "call_type": call_type,
                    "call_id": call_id_db,
                    "sdp": data.get("sdp"),
                    # Track E: signed DTLS fingerprint envelope (opaque).
                    "fp_sig": data.get("fp_sig") or "",
                }
                db.save_pending_call_offer(
                    call_id_db,
                    user["id"],
                    to_id,
                    user["nickname"],
                    user.get("avatar"),
                    call_type,
                    data.get("sdp") or "",
                    fp_sig=(data.get("fp_sig") or ""),
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
                logger.info(
                    "call push: caller=%s(%d) callee=%d call_id=%s type=%s online=%s",
                    user["nickname"], user["id"], to_id, call_id_db, call_type,
                    manager.is_user_online(to_id),
                )
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

                # If callee is fully unreachable (not on WS AND no FCM/APNs/web-push
                # subscriptions registered), tell the caller immediately so the UI
                # can stop spinning instead of ringing into the void.
                if not manager.is_user_online(to_id):
                    try:
                        # Use the stricter "fresh mobile token" test rather
                        # than has_any_push_target: stale web-push subs from
                        # uninstalled browsers linger forever and would keep
                        # the caller spinning on "Calling…" indefinitely.
                        reachable = db.has_recent_mobile_token(to_id, max_age_days=30)
                        if not reachable:
                            # Fall back to any-target so we don't hard-fail a
                            # desktop-only callee with a live web-push sub.
                            from routers.push import has_any_push_target
                            reachable = has_any_push_target(to_id)
                    except Exception:
                        reachable = True  # fail open
                    if not reachable:
                        logger.info(
                            "call unreachable: callee=%d call_id=%s no push targets",
                            to_id, call_id_db,
                        )
                        await manager.send_personal(websocket, {
                            "type": "call_unreachable",
                            "call_id": call_id_db,
                            "reason": "offline",
                        })
                # No hard "peer_offline" error here: push ringing + pending-offer
                # recovery allows the callee to answer after cold-start.

            elif msg_type == "call_answer":
                to_id = _resolve_to_id(data)
                if not to_id:
                    continue
                call_id = int(data.get("call_id", 0))
                is_renegotiate = bool(data.get("renegotiate"))
                # HIGH-6: refuse to relay an answer for a call the sender
                # isn't a participant in.
                if not _validate_call_participant(call_id, user["id"], to_id):
                    continue
                print(f"[CALLDBG] call_answer from uid={user['id']} call_id={call_id} is_renegotiate={is_renegotiate}", flush=True)
                if call_id and not is_renegotiate:
                    db.update_call_status(call_id, "active",
                                          started_at=datetime.utcnow().isoformat())
                    db.delete_pending_call_offer(call_id)
                answer_payload = {
                    "type": "call_answer",
                    "from_id": user["id"],
                    "from_nickname": user["nickname"],
                    "call_id": call_id,
                    "sdp": data.get("sdp"),
                    # Track E: callee's signed DTLS fingerprint envelope.
                    "fp_sig": data.get("fp_sig") or "",
                    "renegotiate": is_renegotiate,
                }
                try:
                    import federation_calls as _fc
                    with db._conn() as con:
                        crow = con.execute(
                            "SELECT global_call_id, caller_id, callee_id FROM calls WHERE id=?",
                            (call_id,),
                        ).fetchone()
                    if crow and crow["global_call_id"]:
                        peer = db.get_user_by_id(to_id) or {}
                        if _fc.user_home_is_remote(peer):
                            caller_u = db.get_user_by_id(int(crow["caller_id"])) or {}
                            caller_gid = str(caller_u.get("global_user_id") or "")
                            if caller_gid:
                                _fc.enqueue_call_answer(
                                    user,
                                    caller_gid,
                                    global_call_id=str(crow["global_call_id"]),
                                    sdp=data.get("sdp") or "",
                                    fp_sig=data.get("fp_sig") or "",
                                    renegotiate=is_renegotiate,
                                )
                except Exception:
                    logger.exception("federated call_answer enqueue failed")
                delivered_ans = await manager.send_to_user(to_id, answer_payload)
                if not delivered_ans:
                    # Caller's WS is in flap window — buffer the SDP so they
                    # transition out of "Calling…" the moment they reconnect.
                    # Without this the call is permanently dead even though
                    # the callee already accepted.
                    try:
                        db.queue_call_signal(
                            call_id=call_id or 0,
                            target_id=to_id,
                            from_id=user["id"],
                            from_nick=user["nickname"],
                            kind="call_answer",
                            payload=json.dumps(answer_payload),
                        )
                    except Exception:
                        logger.exception("queue_call_signal(call_answer) failed")

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
                            "SELECT id, caller_id, callee_id, call_type, global_call_id FROM calls WHERE id=?",
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
                reject_payload = {
                    "type": "call_reject",
                    "from_id": user["id"],
                    "from_nickname": user["nickname"],
                    "call_id": call_id,
                }
                try:
                    import federation_calls as _fc
                    peer = db.get_user_by_id(to_id) or {}
                    if call_row and call_row["global_call_id"] and _fc.user_home_is_remote(peer):
                        caller_gid = str(peer.get("global_user_id") or "")
                        if caller_gid:
                            _fc.enqueue_call_reject(
                                user,
                                caller_gid,
                                global_call_id=str(call_row["global_call_id"]),
                            )
                except Exception:
                    logger.exception("federated call_reject enqueue failed")
                delivered = await manager.send_to_user(to_id, reject_payload)
                if not delivered:
                    try:
                        db.queue_call_signal(
                            call_id=call_id or 0,
                            target_id=to_id,
                            from_id=user["id"],
                            from_nick=user["nickname"],
                            kind="call_reject",
                            payload=json.dumps(reject_payload),
                        )
                    except Exception:
                        logger.exception("queue_call_signal(call_reject) failed")

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
                            "SELECT id, caller_id, callee_id, call_type, status, started_at, global_call_id FROM calls WHERE id=?",
                            (call_id,)
                        ).fetchone()
                    if not call_row:
                        call_row = con.execute(
                            """
                            SELECT id, caller_id, callee_id, call_type, status, started_at, global_call_id
                            FROM calls
                            WHERE ((caller_id=? AND callee_id=?) OR (caller_id=? AND callee_id=?))
                            ORDER BY id DESC LIMIT 1
                            """,
                            (user["id"], to_id, to_id, user["id"])
                        ).fetchone()
                if call_row:
                    call_id = int(call_row["id"])
                    status = str(call_row["status"] or "")
                    federated_end_status = "ended"
                    db.delete_pending_call_offer(call_id)
                    print(f"[CALLDBG] call_end lookup: call_id={call_id} status={status!r} was_connected={was_connected}", flush=True)
                    if status == "ringing" and not was_connected:
                        federated_end_status = "missed"
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
                    try:
                        import federation_calls as _fc
                        peer = db.get_user_by_id(to_id) or {}
                        if call_row["global_call_id"] and _fc.user_home_is_remote(peer):
                            peer_gid = str(peer.get("global_user_id") or "")
                            if peer_gid:
                                _fc.enqueue_call_end(
                                    user,
                                    peer_gid,
                                    global_call_id=str(call_row["global_call_id"]),
                                    status=federated_end_status,
                                )
                    except Exception:
                        logger.exception("federated call_end enqueue failed")
                end_payload = {
                    "type": "call_end",
                    "from_id": user["id"],
                    "from_nickname": user["nickname"],
                    "call_id": call_id,
                }
                delivered = await manager.send_to_user(to_id, end_payload)
                if not delivered:
                    try:
                        db.queue_call_signal(
                            call_id=call_id or 0,
                            target_id=to_id,
                            from_id=user["id"],
                            from_nick=user["nickname"],
                            kind="call_end",
                            payload=json.dumps(end_payload),
                        )
                    except Exception:
                        logger.exception("queue_call_signal(call_end) failed")

            elif msg_type == "ice_candidate":
                to_id = _resolve_to_id(data)
                if not to_id:
                    continue
                # HIGH-6: ICE candidates can leak the recipient's WAN IP /
                # NAT topology, and a flood of forged ones can exhaust
                # their TURN budget. Refuse unless sender + recipient
                # match the call row.
                if not _validate_call_participant(int(data.get("call_id") or 0), user["id"], to_id):
                    continue
                cand = data.get("candidate")
                ice_payload = {
                    "type": "ice_candidate",
                    "from_id": user["id"],
                    "from_nickname": user["nickname"],
                    "call_id": data.get("call_id"),
                    "candidate": cand,
                }
                try:
                    import federation_calls as _fc
                    with db._conn() as con:
                        crow = con.execute(
                            "SELECT global_call_id FROM calls WHERE id=?",
                            (int(data.get("call_id") or 0),),
                        ).fetchone()
                    peer = db.get_user_by_id(to_id) or {}
                    if crow and crow["global_call_id"] and _fc.user_home_is_remote(peer):
                        pgid = str(peer.get("global_user_id") or "")
                        if pgid:
                            _fc.enqueue_call_ice(
                                user,
                                pgid,
                                global_call_id=str(crow["global_call_id"]),
                                candidate=str(cand) if cand else "",
                            )
                except Exception:
                    logger.exception("federated call.ice enqueue failed")
                delivered = await manager.send_to_user(to_id, ice_payload)
                # Cold-start callees (push-wake) take 1–3 s to reconnect, during
                # which the caller has already trickled the first half of its
                # candidates. Buffer them so they survive that gap; the WS
                # connect handler drains them as soon as the peer joins.
                if not delivered and cand:
                    try:
                        db.queue_ice_candidate(
                            int(data.get("call_id") or 0),
                            int(to_id),
                            int(user["id"]),
                            str(user["nickname"]),
                            str(cand),
                        )
                    except Exception:
                        logger.exception("queue_ice_candidate failed")

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
                try:
                    import federation_voice as _fv
                    if _fv.federation_calls_enabled() and not _fv.voice_sfu_enabled():
                        sid = _fv.federated_voice_registry.session_for_room(room_name)
                        anchor = _fv.room_anchor_server_id(room_name)
                        _fv.enqueue_voice_session_join(
                            user, room_name, session_id=sid, anchor_server_id=anchor,
                        )
                except Exception:
                    logger.exception("federated voice_join enqueue failed")

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
                try:
                    import federation_voice as _fv
                    remote = _fv.federated_voice_registry.remotes_for_room(room_name)
                except Exception:
                    remote = []
                local_parts = [
                    {"user_id": p[0], "nickname": p[1], "avatar": p[2]}
                    for p in (existing or [])
                ]
                await manager.send_personal(websocket, {
                    "type": "voice_joined",
                    "participants": local_parts + remote,
                })

            elif msg_type == "voice_leave":
                # User leaves voice channel
                try:
                    import federation_voice as _fv
                    if _fv.federation_calls_enabled():
                        sid = _fv.federated_voice_registry.session_for_room(room_name)
                        _fv.enqueue_voice_session_leave(user, room_name, session_id=sid)
                        # Don't ``clear_room`` here: the remote roster only
                        # updates from inbound ``voice.session.leave`` events
                        # signed by each remote peer's home server. Wiping it
                        # locally would let one user drop the cross-node
                        # roster for everyone in the room.
                except Exception:
                    logger.exception("federated voice_leave enqueue failed")
                voice_manager.leave(room_name, user["id"])
                await manager.broadcast_room(room_name, {
                    "type": "voice_user_left",
                    "room": room_name,
                    "user_id": user["id"],
                    "nickname": user["nickname"],
                    "participants": voice_manager.participants(room_name)
                })

            elif msg_type == "voice_offer":
                # Sender must currently be in voice for the room; otherwise
                # they have no business signalling SDP to anyone.
                if not voice_manager.is_in_voice(room_name, user["id"]):
                    continue
                to_id = int(data.get("to_id", 0))
                to_gid = str(data.get("to_global_user_id") or "").strip()
                if not to_id and to_gid:
                    with db._conn() as con:
                        r = con.execute(
                            "SELECT id FROM users WHERE global_user_id=? LIMIT 1",
                            (to_gid,),
                        ).fetchone()
                    to_id = int(r["id"]) if r else 0
                in_voice = to_id and voice_manager.is_in_voice(room_name, to_id)
                if not in_voice and not to_gid:
                    continue
                payload_vo = {
                    "type": "voice_offer",
                    "from_id": user["id"],
                    "from_global_user_id": str(user.get("global_user_id") or ""),
                    "from_nickname": user["nickname"],
                    "sdp": data.get("sdp"),
                    "room": room_name,
                }
                if in_voice:
                    await manager.send_to_user(to_id, payload_vo)
                if to_gid:
                    try:
                        import federation_voice as _fv
                        import federation_calls as _fc
                        peer = db.get_user_by_id(to_id) if to_id else {}
                        if not to_id or _fc.user_home_is_remote(peer or {"global_user_id": to_gid}):
                            sid = _fv.federated_voice_registry.session_for_room(room_name)
                            _fv.enqueue_voice_signal(
                                user, to_gid, session_id=sid, room_name=room_name,
                                kind="offer", sdp=data.get("sdp") or "",
                            )
                    except Exception:
                        logger.exception("federated voice_offer failed")

            elif msg_type == "voice_answer":
                if not voice_manager.is_in_voice(room_name, user["id"]):
                    continue
                to_id = int(data.get("to_id", 0))
                to_gid = str(data.get("to_global_user_id") or "").strip()
                if not to_id and to_gid:
                    with db._conn() as con:
                        r = con.execute(
                            "SELECT id FROM users WHERE global_user_id=? LIMIT 1",
                            (to_gid,),
                        ).fetchone()
                    to_id = int(r["id"]) if r else 0
                in_voice = to_id and voice_manager.is_in_voice(room_name, to_id)
                if not in_voice and not to_gid:
                    continue
                payload_va = {
                    "type": "voice_answer",
                    "from_id": user["id"],
                    "from_global_user_id": str(user.get("global_user_id") or ""),
                    "from_nickname": user["nickname"],
                    "sdp": data.get("sdp"),
                    "room": room_name,
                }
                if in_voice:
                    await manager.send_to_user(to_id, payload_va)
                if to_gid:
                    try:
                        import federation_voice as _fv
                        sid = _fv.federated_voice_registry.session_for_room(room_name)
                        _fv.enqueue_voice_signal(
                            user, to_gid, session_id=sid, room_name=room_name,
                            kind="answer", sdp=data.get("sdp") or "",
                        )
                    except Exception:
                        logger.exception("federated voice_answer failed")

            elif msg_type == "voice_ice":
                if not voice_manager.is_in_voice(room_name, user["id"]):
                    continue
                to_id = int(data.get("to_id", 0))
                to_gid = str(data.get("to_global_user_id") or "").strip()
                if not to_id and to_gid:
                    with db._conn() as con:
                        r = con.execute(
                            "SELECT id FROM users WHERE global_user_id=? LIMIT 1",
                            (to_gid,),
                        ).fetchone()
                    to_id = int(r["id"]) if r else 0
                in_voice = to_id and voice_manager.is_in_voice(room_name, to_id)
                if not in_voice and not to_gid:
                    continue
                payload_vi = {
                    "type": "voice_ice",
                    "from_id": user["id"],
                    "from_global_user_id": str(user.get("global_user_id") or ""),
                    "candidate": data.get("candidate"),
                    "room": room_name,
                }
                if in_voice:
                    await manager.send_to_user(to_id, payload_vi)
                if to_gid:
                    try:
                        import federation_voice as _fv
                        sid = _fv.federated_voice_registry.session_for_room(room_name)
                        _fv.enqueue_voice_signal(
                            user, to_gid, session_id=sid, room_name=room_name,
                            kind="ice", candidate=str(data.get("candidate") or ""),
                        )
                    except Exception:
                        logger.exception("federated voice_ice failed")

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
                      f"{user['nickname']} wants to be friends", "/app",
                      kind="friend_request",
                      extra={"from_nickname": ""})


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
