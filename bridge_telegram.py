"""
Telegram ↔ FrogTalk Bridge Bot

Bridges messages between Telegram groups/channels and FrogTalk rooms.
Run alongside main.py or as a background task.

Usage:
  Set TELEGRAM_BOT_TOKEN env var, then:
  python bridge_telegram.py
  
Or import and call start_telegram_bridge() from main.py
"""

import os
import asyncio
import logging
import json
from typing import Optional
import httpx

log = logging.getLogger("bridge.telegram")

# Will be set from env or config
TELEGRAM_TOKEN: Optional[str] = None
FROGTALK_API = os.getenv(
    "FROGTALK_INTERNAL_URL",
    f"http://127.0.0.1:{os.getenv('PORT', '8080')}",
)
_bridges: dict = {}  # telegram_chat_id -> {room, token, bot_name, enabled, direction}
_running = False
_offset = 0
_bot_id: int = 0  # set by start_telegram_bridge once getMe succeeds
_bot_privacy_on: bool = True  # getMe.can_read_all_group_messages == False

# Avatar cache keyed by telegram user id. Values are data: URLs. A failure
# short-circuits subsequent lookups for an hour to avoid hammering the API
# for users with no profile photo.
_avatar_cache: dict = {}
_avatar_fail_ts: dict = {}


def _tg_url(method: str) -> str:
    return f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/{method}"


async def tg_request(method: str, **params) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(_tg_url(method), json=params)
        data = r.json()
        if not data.get("ok"):
            log.error("Telegram API error: %s %s", method, data)
        return data


async def _check_bot_can_read(chat_id: int) -> bool:
    """Return True if the bot will actually see every message in this group.

    A bot reads all messages when either (a) Privacy Mode is off globally
    (getMe.can_read_all_group_messages == True) or (b) it's an admin in the
    specific chat. Otherwise Telegram hides regular messages from it and
    only /commands + @mentions reach us.
    """
    if not _bot_privacy_on:
        return True  # privacy mode is off globally — always see everything
    try:
        r = await tg_request("getChatMember", chat_id=chat_id, user_id=_bot_id)
        status = (r.get("result") or {}).get("status", "")
        return status in ("administrator", "creator")
    except Exception:
        return False


def _decode_data_url(data_url: str):
    """Split a data: URL into (mime, bytes). Returns (None, None) on error."""
    try:
        import base64
        head, b64 = data_url.split(",", 1)
        mime = "application/octet-stream"
        if head.startswith("data:") and ";" in head:
            mime = head[5:].split(";", 1)[0] or mime
        return mime, base64.b64decode(b64)
    except Exception:
        return None, None


async def _tg_upload(method: str, chat_id: int, field: str, filename: str,
                     mime: str, data: bytes, caption: str = "",
                     extra: dict = None, *, has_spoiler: bool = False) -> dict:
    """Multipart upload to Telegram (sendPhoto/sendVideo/sendAnimation/sendDocument).

    When `has_spoiler` is set and the target method supports it
    (sendPhoto/sendVideo/sendAnimation), Telegram renders the media behind
    a tap-to-reveal overlay — matching the FrogTalk spoiler UX.
    """
    extra = extra or {}
    form = {
        "chat_id": (None, str(chat_id)),
        field: (filename, data, mime),
        "caption": (None, caption or ""),
        "parse_mode": (None, "HTML"),
    }
    if has_spoiler and method in ("sendPhoto", "sendVideo", "sendAnimation"):
        form["has_spoiler"] = (None, "true")
    # reply_parameters / other extras must be JSON-stringified for multipart
    for k, v in (extra or {}).items():
        form[k] = (None, json.dumps(v) if isinstance(v, (dict, list)) else str(v))
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(_tg_url(method), files=form)
        try:
            return r.json()
        except Exception:
            return {}


async def send_to_telegram(chat_id: int, text: str, media_url: str = None,
                           reply_to_message_id: int = None,
                           *, has_spoiler: bool = False) -> Optional[int]:
    """Send a message from FrogTalk to Telegram.

    `text` MUST already be HTML-escaped by the caller where needed — the
    rich-header prefix (nickname / channel) is assembled in
    `forward_to_telegram` and passed through here verbatim.

    When `reply_to_message_id` is supplied, Telegram renders the outgoing
    message as a native reply to that earlier message in the same chat.

    Returns the Telegram message_id of the sent message (so the caller can
    persist a FrogTalk↔Telegram mapping), or None on failure.
    """
    resp: dict = {}
    extra: dict = {}
    if reply_to_message_id:
        # `allow_sending_without_reply` makes Telegram silently drop the
        # reply pointer if the original was deleted, instead of 400-ing.
        extra["reply_parameters"] = {
            "message_id": int(reply_to_message_id),
            "allow_sending_without_reply": True,
        }

    # data: URL → decode and upload via multipart so recipients actually
    # see the photo/video/gif, not just a "[image]" placeholder.
    if media_url and media_url.startswith("data:"):
        mime, data = _decode_data_url(media_url)
        if mime and data:
            try:
                # MIME→extension map for the cases where the subtype
                # alone is wrong (e.g. audio/mpeg → .mp3, not .mpeg).
                # Telegram's clients pick a player based on extension,
                # so audio/voice clips with the wrong extension may not
                # get an inline waveform.
                _ext_map = {
                    "audio/mpeg": "mp3",
                    "audio/mp4": "m4a",
                    "audio/x-wav": "wav",
                    "audio/wave": "wav",
                    "audio/webm": "weba",
                    "video/quicktime": "mov",
                    "video/x-matroska": "mkv",
                    "image/jpeg": "jpg",
                    "image/svg+xml": "svg",
                }
                def _ext(m: str, fallback: str) -> str:
                    if m in _ext_map:
                        return _ext_map[m]
                    sub = m.split("/", 1)[-1].split("+")[0] if "/" in m else ""
                    return sub or fallback

                if mime == "image/gif":
                    resp = await _tg_upload("sendAnimation", chat_id, "animation",
                                            "clip.gif", mime, data, text or "", extra,
                                            has_spoiler=has_spoiler)
                elif mime.startswith("image/"):
                    resp = await _tg_upload("sendPhoto", chat_id, "photo",
                                            f"photo.{_ext(mime, 'jpg')}", mime, data, text or "", extra,
                                            has_spoiler=has_spoiler)
                elif mime.startswith("video/"):
                    resp = await _tg_upload("sendVideo", chat_id, "video",
                                            f"video.{_ext(mime, 'mp4')}", mime, data, text or "", extra,
                                            has_spoiler=has_spoiler)
                elif mime.startswith("audio/"):
                    # Use sendVoice for OGG/Opus so Telegram renders the
                    # tap-to-play waveform UI like a real voice note.
                    if mime in ("audio/ogg", "audio/opus"):
                        resp = await _tg_upload("sendVoice", chat_id, "voice",
                                                "voice.ogg", "audio/ogg", data, text or "", extra)
                    else:
                        resp = await _tg_upload("sendAudio", chat_id, "audio",
                                                f"audio.{_ext(mime, 'mp3')}", mime, data, text or "", extra)
                else:
                    resp = await _tg_upload("sendDocument", chat_id, "document",
                                            "file.bin", mime, data, text or "", extra)
            except Exception as e:
                log.error("TG media upload failed: %s — falling back to text", e)
                resp = await tg_request("sendMessage", chat_id=chat_id,
                                        text=text or "[media]", parse_mode="HTML", **extra)
        else:
            resp = await tg_request("sendMessage", chat_id=chat_id,
                                    text=text or "[media]", parse_mode="HTML", **extra)
    elif media_url and media_url.startswith("http"):
        lower = media_url.lower()
        spoiler_kw = {"has_spoiler": True} if has_spoiler else {}
        if any(lower.endswith(ext) for ext in (".mp4", ".webm", ".mov")):
            resp = await tg_request("sendVideo", chat_id=chat_id, video=media_url,
                                    caption=text or "", parse_mode="HTML",
                                    **spoiler_kw, **extra)
        elif lower.endswith(".gif"):
            resp = await tg_request("sendAnimation", chat_id=chat_id, animation=media_url,
                                    caption=text or "", parse_mode="HTML",
                                    **spoiler_kw, **extra)
        elif any(lower.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp")) \
                or "image" in media_url[:60]:
            resp = await tg_request("sendPhoto", chat_id=chat_id, photo=media_url,
                                    caption=text or "", parse_mode="HTML",
                                    **spoiler_kw, **extra)
        else:
            resp = await tg_request("sendMessage", chat_id=chat_id,
                                    text=(text + "\n" + media_url) if text else media_url,
                                    parse_mode="HTML", **extra)
    else:
        if text:
            # Enable Telegram link preview when the text contains a URL so
            # YouTube / web links get a rich embed. Without a URL we keep
            # previews disabled to avoid Telegram trying to preview the
            # bridged "via FrogTalk" footer or other noise.
            import re as _re
            _url_in_text = bool(_re.search(r'https?://\S+', text))
            if _url_in_text:
                # prefer_large_media gives YouTube/article links a full-size
                # card instead of a tiny thumbnail.
                resp = await tg_request("sendMessage", chat_id=chat_id, text=text,
                                        parse_mode="HTML",
                                        link_preview_options={
                                            "is_disabled": False,
                                            "prefer_large_media": True,
                                        },
                                        **extra)
            else:
                resp = await tg_request("sendMessage", chat_id=chat_id, text=text,
                                        parse_mode="HTML",
                                        link_preview_options={"is_disabled": True},
                                        **extra)
    try:
        return int((resp.get("result") or {}).get("message_id"))
    except Exception:
        return None


async def send_to_frogtalk(room: str, token: str, content: str,
                           sender_name: str = "Telegram",
                           sender_avatar: Optional[str] = None,
                           media_url: Optional[str] = None,
                           remote_chat_id: Optional[int] = None,
                           remote_msg_id: Optional[int] = None,
                           reply_to_remote_id: Optional[int] = None,
                           source_name: Optional[str] = None,
                           source_id: Optional[str] = None,
                           source_parent: Optional[str] = None):
    """Send a message from Telegram to FrogTalk via REST."""
    payload = {
        "room_name": room, "content": content,
        "sender_name": sender_name, "bridge_token": token,
        "platform": "telegram",
    }
    if sender_avatar:
        payload["sender_avatar"] = sender_avatar
    if media_url:
        payload["media_url"] = media_url
    if remote_chat_id is not None:
        payload["remote_chat_id"] = str(remote_chat_id)
    if remote_msg_id is not None:
        payload["remote_msg_id"] = str(remote_msg_id)
    if reply_to_remote_id is not None:
        payload["reply_to_remote_id"] = str(reply_to_remote_id)
    if source_name:
        payload["source_name"] = str(source_name)
    if source_id:
        payload["source_id"] = str(source_id)
    if source_parent:
        payload["source_parent"] = str(source_parent)
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{FROGTALK_API}/api/bridge/message", json=payload
        )
        if r.status_code != 200:
            log.error("FrogTalk bridge send failed: %s", r.text)


async def send_edit_to_frogtalk(room: str, token: str, content: str,
                                remote_chat_id: int, remote_msg_id: int) -> None:
    """Notify FrogTalk that a previously-bridged Telegram message was edited."""
    payload = {
        "room_name": room, "bridge_token": token, "platform": "telegram",
        "remote_chat_id": str(remote_chat_id),
        "remote_msg_id": str(remote_msg_id),
        "content": content or "",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(f"{FROGTALK_API}/api/bridge/edit", json=payload)
            if r.status_code != 200:
                log.debug("FrogTalk bridge edit failed: %s", r.text)
    except Exception as e:
        log.debug("FrogTalk bridge edit request failed: %s", e)


async def send_delete_to_frogtalk(room: str, token: str,
                                  remote_chat_id: int, remote_msg_id: int) -> None:
    """Notify FrogTalk that a previously-bridged Telegram message was deleted.

    NOTE: Telegram's Bot API does NOT push delete notifications for normal
    user messages — this helper is kept for symmetry / future use. It is
    safe to call but will currently never be triggered by the polling loop.
    """
    payload = {
        "room_name": room, "bridge_token": token, "platform": "telegram",
        "remote_chat_id": str(remote_chat_id),
        "remote_msg_id": str(remote_msg_id),
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(f"{FROGTALK_API}/api/bridge/delete", json=payload)
            if r.status_code != 200:
                log.debug("FrogTalk bridge delete failed: %s", r.text)
    except Exception as e:
        log.debug("FrogTalk bridge delete request failed: %s", e)


async def _fetch_user_avatar(user_id: int) -> Optional[str]:
    """Fetch a Telegram user's profile photo and return it as a data: URL.

    Results are cached in-process. Users with no photo or repeated failures
    are blacklisted for an hour so we don't spam `getUserProfilePhotos`.
    """
    if not user_id:
        return None
    cached = _avatar_cache.get(user_id)
    if cached is not None:
        return cached or None  # empty string = known-missing
    import time as _time
    last_fail = _avatar_fail_ts.get(user_id, 0)
    if last_fail and _time.time() - last_fail < 3600:
        return None
    try:
        r = await tg_request("getUserProfilePhotos", user_id=user_id, limit=1)
        photos = (r.get("result") or {}).get("photos") or []
        if not photos:
            _avatar_cache[user_id] = ""
            _avatar_fail_ts[user_id] = _time.time()
            return None
        # photos[0] is a list of size variants (smallest→largest). The smallest
        # is typically <10KB which is perfect for a 38px avatar.
        sizes = photos[0]
        file_id = sizes[0]["file_id"]
        r2 = await tg_request("getFile", file_id=file_id)
        file_path = (r2.get("result") or {}).get("file_path")
        if not file_path:
            _avatar_fail_ts[user_id] = _time.time()
            return None
        url = f"https://api.telegram.org/file/bot{TELEGRAM_TOKEN}/{file_path}"
        async with httpx.AsyncClient(timeout=15) as c:
            resp = await c.get(url)
        if resp.status_code != 200 or not resp.content:
            _avatar_fail_ts[user_id] = _time.time()
            return None
        import base64
        mime = "image/jpeg"
        if file_path.lower().endswith(".png"):
            mime = "image/png"
        b64 = base64.b64encode(resp.content).decode("ascii")
        data_url = f"data:{mime};base64,{b64}"
        _avatar_cache[user_id] = data_url
        return data_url
    except Exception as e:
        log.debug("avatar fetch failed for %s: %s", user_id, e)
        _avatar_fail_ts[user_id] = _time.time()
        return None


async def _fetch_tg_file_as_data_url(file_id: str, mime_hint: str = None,
                                     max_bytes: int = 8 * 1024 * 1024) -> Optional[str]:
    """Download a Telegram file by file_id and return it as a data: URL.

    Returns None on failure or if the file is too large (default 8 MB cap).
    We encode inline so the FrogTalk bridge token stays private (we never
    leak Telegram's api.telegram.org/file/bot<TOKEN>/… URL to end users).
    """
    if not file_id:
        return None
    try:
        r = await tg_request("getFile", file_id=file_id)
        res = r.get("result") or {}
        file_path = res.get("file_path")
        size = int(res.get("file_size") or 0)
        if not file_path or (size and size > max_bytes):
            return None
        url = f"https://api.telegram.org/file/bot{TELEGRAM_TOKEN}/{file_path}"
        async with httpx.AsyncClient(timeout=30) as c:
            resp = await c.get(url)
        if resp.status_code != 200 or not resp.content:
            return None
        if len(resp.content) > max_bytes:
            return None
        import base64
        mime = mime_hint
        if not mime:
            lower = file_path.lower()
            if lower.endswith(".jpg") or lower.endswith(".jpeg"):
                mime = "image/jpeg"
            elif lower.endswith(".png"):
                mime = "image/png"
            elif lower.endswith(".gif"):
                mime = "image/gif"
            elif lower.endswith(".webp"):
                mime = "image/webp"
            elif lower.endswith(".mp4"):
                mime = "video/mp4"
            elif lower.endswith(".webm"):
                mime = "video/webm"
            elif lower.endswith(".ogg") or lower.endswith(".oga"):
                mime = "audio/ogg"
            elif lower.endswith(".mp3"):
                mime = "audio/mpeg"
            elif lower.endswith(".tgs"):
                mime = "application/gzip"
            else:
                mime = "application/octet-stream"
        b64 = base64.b64encode(resp.content).decode("ascii")
        return f"data:{mime};base64,{b64}"
    except Exception as e:
        log.debug("tg file fetch failed %s: %s", file_id, e)
        return None


async def _handle_my_chat_member(mcm: dict):
    """React to the bot's own status changing in a chat.

    If the user just promoted us to admin in a chat that's already linked
    to FrogTalk, confirm that the bridge is now fully live — this is what
    flips the Privacy Mode limitation off on a per-chat basis.
    """
    chat = mcm.get("chat") or {}
    chat_id = chat.get("id")
    if not chat_id:
        return
    old = (mcm.get("old_chat_member") or {}).get("status", "")
    new = (mcm.get("new_chat_member") or {}).get("status", "")
    became_admin = (
        old not in ("administrator", "creator")
        and new in ("administrator", "creator")
    )
    if became_admin and chat_id in _bridges:
        room = _bridges[chat_id]["room"]
        await tg_request(
            "sendMessage", chat_id=chat_id,
            text=(
                f"🎉 Admin promotion detected — bridge to FrogTalk "
                f"<b>{room}</b> is now fully live. Every message here "
                f"will mirror to FrogTalk, and vice versa."
            ),
            parse_mode="HTML",
        )


async def process_update(update: dict):
    """Process a single Telegram update."""
    # Handle bot-status changes (added to group, promoted to admin, kicked, …).
    # When the user promotes us to admin, we can finally read every message —
    # confirm that back so they know the link is live without guessing.
    mcm = update.get("my_chat_member")
    if mcm:
        await _handle_my_chat_member(mcm)
        return

    # Telegram delivers edited messages on a separate key. Mirror the new
    # text onto FrogTalk so the bridged copy stays in sync.
    edited = update.get("edited_message") or update.get("edited_channel_post")
    if edited:
        chat_id = edited["chat"]["id"]
        bridge = _bridges.get(chat_id)
        if bridge and bridge.get("enabled") and (bridge.get("direction") or "both").lower() != "out":
            new_text = edited.get("text") or edited.get("caption") or ""
            await send_edit_to_frogtalk(
                bridge["room"], bridge["token"], new_text,
                chat_id, edited.get("message_id"),
            )
        return

    msg = update.get("message") or update.get("channel_post")
    if not msg:
        return

    chat_id = msg["chat"]["id"]
    text = (msg.get("text") or "").strip()

    # Handle `/claim CODE` — easy bridge-setup flow.
    # User added the bot to their group and sends this to link it to a FrogTalk room.
    if text.startswith("/claim"):
        parts = text.split(maxsplit=1)
        if len(parts) < 2:
            await tg_request("sendMessage", chat_id=chat_id,
                             text="Usage: /claim CODE\n\nGet a code from FrogTalk → Channel Settings → Bridges.")
            return
        code = parts[1].strip().split()[0].upper()
        chat_title = msg.get("chat", {}).get("title", "")
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.post(
                    f"{FROGTALK_API}/api/bridges/claim-code",
                    json={"code": code, "telegram_chat_id": chat_id,
                          "telegram_chat_title": chat_title}
                )
            if r.status_code == 200:
                data = r.json()
                room = data.get("room_name", "?")
                # Probe whether Telegram will actually hand us every message
                # in this chat. If not, the link is technically done but the
                # user needs one more step — tell them exactly what to do.
                can_read = await _check_bot_can_read(chat_id)
                if can_read:
                    await tg_request(
                        "sendMessage", chat_id=chat_id,
                        text=(
                            f"✅ Linked to FrogTalk channel <b>{room}</b>.\n"
                            f"Messages will now mirror both ways. 🐸"
                        ),
                        parse_mode="HTML",
                    )
                else:
                    await tg_request(
                        "sendMessage", chat_id=chat_id,
                        text=(
                            f"✅ Linked to FrogTalk channel <b>{room}</b> — "
                            f"<b>one more step</b> needed.\n\n"
                            f"⚠️ I can't read regular messages in this group yet. "
                            f"Telegram hides them from bots unless I'm an admin.\n\n"
                            f"<b>Fix:</b> tap the group name → <b>Administrators</b> "
                            f"→ <b>Add Admin</b> → pick <b>@{os.environ.get('TELEGRAM_BOT_USERNAME', 'FrogTalkBridgeBot')}</b>. "
                            f"Every toggle can stay off — being admin at all is what matters.\n\n"
                            f"Until then, only <code>/commands</code> and @-mentions will reach FrogTalk."
                        ),
                        parse_mode="HTML",
                    )
            elif r.status_code == 404:
                await tg_request("sendMessage", chat_id=chat_id,
                                 text="❌ That code is invalid or has expired. Generate a new one in FrogTalk.")
            else:
                await tg_request("sendMessage", chat_id=chat_id,
                                 text=f"❌ Could not link ({r.status_code}). Try again.")
        except Exception as e:
            log.error("claim-code failed: %s", e)
            await tg_request("sendMessage", chat_id=chat_id,
                             text="❌ FrogTalk server unreachable. Try again shortly.")
        return

    bridge = _bridges.get(chat_id)
    if not bridge or not bridge.get("enabled"):
        # Check for setup commands
        if text.startswith("/bridge") or text.startswith("/start"):
            await tg_request("sendMessage", chat_id=chat_id,
                             text="🐸 FrogTalk Bridge\n\n"
                                  "This chat is not linked to a FrogTalk channel yet.\n"
                                  "In FrogTalk: Channel Settings → Bridges → Generate code,\n"
                                  "then send <code>/claim CODE</code> here.",
                             parse_mode="HTML")
        return

    # Honor direction setting: 'out' means FrogTalk→Telegram only, drop inbound.
    direction = (bridge.get("direction") or "both").lower()
    if direction == "out":
        return

    # Extract message content
    sender = msg.get("from", {})
    chat = msg.get("chat", {})
    sender_name = sender.get("first_name", "Unknown")
    if sender.get("last_name"):
        sender_name += " " + sender["last_name"]
    sender_id = sender.get("id") or 0
    chat_type = str(chat.get("type") or "").strip().lower()
    chat_title = (chat.get("title") or "").strip()
    chat_username = (chat.get("username") or "").strip()
    source_name = chat_title or (("@" + chat_username) if chat_username else "Telegram chat")
    source_parent = {
        "supergroup": "Telegram supergroup",
        "group": "Telegram group",
        "channel": "Telegram channel",
        "private": "Telegram private chat",
    }.get(chat_type, "Telegram chat")

    content = msg.get("text") or msg.get("caption") or ""

    # Extract media file_id across the various Telegram attachment shapes.
    # `photo` is an array of size variants (largest last). `video` / `document`
    # / `animation` / `voice` / `audio` / `sticker` are objects with file_id.
    media_url = None
    media_hint = None
    if msg.get("photo"):
        try:
            # Use the largest variant under our size cap. Telegram returns
            # sizes small→large; pick the largest with file_size <= 8MB.
            variants = msg["photo"]
            picked = None
            for v in reversed(variants):
                if int(v.get("file_size") or 0) <= 8 * 1024 * 1024:
                    picked = v
                    break
            picked = picked or variants[-1]
            media_url = await _fetch_tg_file_as_data_url(picked.get("file_id"),
                                                        mime_hint="image/jpeg")
        except Exception:
            pass
    elif msg.get("animation"):
        anim = msg["animation"]
        media_url = await _fetch_tg_file_as_data_url(anim.get("file_id"),
                                                    mime_hint=anim.get("mime_type") or "video/mp4")
    elif msg.get("video"):
        vid = msg["video"]
        media_url = await _fetch_tg_file_as_data_url(vid.get("file_id"),
                                                    mime_hint=vid.get("mime_type") or "video/mp4")
    elif msg.get("video_note"):
        # Round video clips ("video messages"). Bot API exposes them
        # as a separate type — treat as a regular video for FrogTalk.
        vn = msg["video_note"]
        media_url = await _fetch_tg_file_as_data_url(vn.get("file_id"),
                                                    mime_hint="video/mp4")
        if media_url and not content:
            content = "🎬 video message"
    elif msg.get("voice"):
        v = msg["voice"]
        media_url = await _fetch_tg_file_as_data_url(v.get("file_id"),
                                                    mime_hint=v.get("mime_type") or "audio/ogg")
        if media_url and not content:
            content = "🎤 voice message"
    elif msg.get("audio"):
        a = msg["audio"]
        media_url = await _fetch_tg_file_as_data_url(a.get("file_id"),
                                                    mime_hint=a.get("mime_type") or "audio/mpeg")
        if media_url and not content:
            title = (a.get("title") or "").strip()
            performer = (a.get("performer") or "").strip()
            if title and performer:
                content = f"🎵 {performer} – {title}"
            elif title:
                content = f"🎵 {title}"
            else:
                content = "🎵 audio"
    elif msg.get("sticker"):
        s = msg["sticker"]
        # Animated (.tgs) and video (.webm) stickers don't render nicely in
        # browsers — only forward static image stickers.
        if not s.get("is_animated") and not s.get("is_video"):
            media_url = await _fetch_tg_file_as_data_url(s.get("file_id"),
                                                        mime_hint="image/webp")
        elif not content:
            content = f"[sticker {s.get('emoji', '')}]".strip()
    elif msg.get("document"):
        d = msg["document"]
        mime = (d.get("mime_type") or "application/octet-stream").lower()
        # Only inline images/videos — bigger documents fall back to a caption.
        if mime.startswith("image/") or mime.startswith("video/"):
            media_url = await _fetch_tg_file_as_data_url(d.get("file_id"), mime_hint=mime)
        if not media_url and not content:
            content = f"[{d.get('file_name') or 'document'}]"

    # Handle replies: pass the parent's remote msg_id to the server so it can
    # resolve it to a FrogTalk msg id via bridge_msg_map and render a native
    # reply-card instead of a plaintext "↩ Name:" prefix.
    reply = msg.get("reply_to_message")
    reply_to_remote_id = None
    if reply:
        reply_to_remote_id = reply.get("message_id")

    if content or msg.get("photo") or msg.get("video") or msg.get("document") \
            or msg.get("animation") or msg.get("sticker") or msg.get("voice") \
            or msg.get("audio") or msg.get("video_note") or media_url:
        avatar = await _fetch_user_avatar(sender_id)
        await send_to_frogtalk(
            bridge["room"], bridge["token"], content, sender_name,
            sender_avatar=avatar,
            media_url=media_url,
            remote_chat_id=chat_id,
            remote_msg_id=msg.get("message_id"),
            reply_to_remote_id=reply_to_remote_id,
            source_name=source_name,
            source_id=str(chat_id),
            source_parent=source_parent,
        )


async def poll_loop():
    """Long-poll Telegram for updates."""
    global _offset, _running
    _running = True
    log.info("poll loop active — waiting for /claim commands and messages.")

    # allowed_updates must explicitly include "my_chat_member" to receive
    # promotion-to-admin / removal events. Telegram omits these by default.
    allowed = ["message", "channel_post", "edited_message", "my_chat_member"]

    while _running:
        try:
            data = await tg_request(
                "getUpdates", offset=_offset, timeout=30, allowed_updates=allowed,
            )
            updates = data.get("result", [])
            for u in updates:
                _offset = u["update_id"] + 1
                try:
                    await process_update(u)
                except Exception:
                    log.exception("process_update error")
        except Exception as e:
            log.warning("poll error (retrying in 5s): %s: %r", type(e).__name__, e)
            await asyncio.sleep(5)


def load_bridges():
    """Load bridge configs from database."""
    global _bridges
    try:
        import database as db
        with db._conn() as con:
            rows = con.execute("""
                SELECT telegram_chat_id, room_name, bot_token, bot_name, enabled,
                       COALESCE(direction, 'both') AS direction
                FROM telegram_bridges WHERE enabled=1
            """).fetchall()
        _bridges = {
            row["telegram_chat_id"]: {
                "room": row["room_name"],
                "token": row["bot_token"],
                "bot_name": row["bot_name"],
                "enabled": bool(row["enabled"]),
                "direction": row["direction"] or "both",
            }
            for row in rows
        }
        log.info("Loaded %d Telegram bridges", len(_bridges))
    except Exception as e:
        log.warning("Could not load bridges: %s", e)


async def start_telegram_bridge():
    """Start the Telegram bridge (call from main app)."""
    global TELEGRAM_TOKEN, _bot_id, _bot_privacy_on
    TELEGRAM_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not TELEGRAM_TOKEN:
        log.warning("TELEGRAM_BOT_TOKEN not set — /claim CODE disabled.")
        return

    load_bridges()

    # Verify bot — failure here means a wrong/revoked token, make it loud.
    me = await tg_request("getMe")
    if not me.get("ok"):
        log.error("getMe failed: %s — bridge NOT started.", me)
        return
    result = me["result"]
    uname = result.get("username", "")
    _bot_id = int(result.get("id") or 0)
    # can_read_all_group_messages == True means Privacy Mode is OFF (bot
    # sees everything). We only need to nag users to promote the bot to
    # admin when this flag is False.
    _bot_privacy_on = not bool(result.get("can_read_all_group_messages"))
    log.info(
        "started — polling as @%s (id=%d), privacy_mode=%s, %d linked chat(s).",
        uname, _bot_id, "on" if _bot_privacy_on else "off", len(_bridges),
    )
    if uname and not os.environ.get("TELEGRAM_BOT_USERNAME"):
        os.environ["TELEGRAM_BOT_USERNAME"] = uname

    asyncio.create_task(poll_loop())


def stop_telegram_bridge():
    global _running
    _running = False


# ─── FrogTalk → Telegram forwarding ──────────────────────────────────────────
# Called by ws_manager when a message is sent in a bridged room

async def forward_to_telegram(room: str, nickname: str, content: str,
                              media_data: str = None,
                              *, ft_msg_id: int | None = None,
                              reply_to_ft_id: int | None = None,
                              media_blur: bool = False,
                              display_name: str | None = None):
    """Forward a FrogTalk message to all linked Telegram chats.

    Formats the message with a rich HTML header so Telegram readers can
    tell at a glance who sent it and which FrogTalk channel it came from:

        🐸 <b>Nickname</b> · <i>#room</i>
        <message body>

    If the FrogTalk user has a public http(s) avatar, the nickname links
    to it — Telegram renders that as a tiny thumbnail link-preview, which
    is the closest thing the platform offers to an inline avatar.
    """
    import html as _html
    if not _bridges:
        return
    # Any bridge for this room? bail early before hitting the DB.
    if not any(b["room"] == room and b["enabled"] for b in _bridges.values()):
        return

    # Look up the sender's avatar once per forward (cheap — users table row).
    sender_avatar = None
    try:
        import database as db
        u = db.get_user_by_nick(nickname)
        if u:
            av = (u.get("avatar") or "").strip()
            if av.startswith("http://") or av.startswith("https://"):
                sender_avatar = av
    except Exception:
        pass

    safe_nick = _html.escape(nickname)
    safe_room = _html.escape(room)
    _display = (display_name or "").strip() or None
    if _display and _display != nickname:
        safe_display = _html.escape(_display)
        label_text = f"{safe_display} @{safe_nick}"
    else:
        label_text = safe_nick
    if sender_avatar:
        nick_html = f'<a href="{_html.escape(sender_avatar, quote=True)}">{label_text}</a>'
    else:
        nick_html = label_text
    # Plain, compact header. No frog emoji (users find it noisy); the
    # "via FrogTalk #room" tail makes the source unambiguous without
    # competing with the message body for attention.
    header = f"<b>{nick_html}</b> <i>· via FrogTalk #{safe_room}</i>"

    safe_body = _html.escape(content) if content else ""
    has_media = bool(media_data)
    if safe_body:
        text = f"{header}\n{safe_body}"
    elif has_media:
        # Real media is attached — Telegram renders the photo/video on its own,
        # an extra "[media]" placeholder caption just adds noise. Caption is
        # the FrogTalk header alone so the reader still sees who posted it.
        text = header
    else:
        text = f"{header}\n<i>[media]</i>"

    for chat_id, bridge in _bridges.items():
        if bridge["room"] != room or not bridge["enabled"]:
            continue
        direction = (bridge.get("direction") or "both").lower()
        if direction == "in":
            continue  # one-way remote→FrogTalk only
        # If this FrogTalk message is a reply, try to resolve the parent
        # into the Telegram message_id we previously sent for that parent
        # in this same chat so the outgoing message renders as a native
        # Telegram reply with the quote bubble.
        reply_tg_id = None
        if reply_to_ft_id:
            try:
                import database as _db
                rid = _db.lookup_bridge_remote_id("telegram", chat_id, reply_to_ft_id)
                if rid:
                    reply_tg_id = int(rid)
            except Exception:
                reply_tg_id = None
        try:
            tg_msg_id = await send_to_telegram(
                chat_id, text, media_data, reply_to_message_id=reply_tg_id,
                has_spoiler=bool(media_blur),
            )
            # Persist the mapping so a Telegram-side reply can be rendered
            # as a native FrogTalk reply on the next inbound hop.
            if tg_msg_id and ft_msg_id:
                try:
                    import database as _db
                    _db.save_bridge_msg_map(
                        "telegram", chat_id, tg_msg_id, ft_msg_id
                    )
                except Exception:
                    pass
        except Exception as e:
            log.error("Forward to Telegram %s failed: %s", chat_id, e)


async def apply_reaction_to_telegram(chat_id: int, ft_msg_id: int,
                                     emoji: str, counts: dict) -> None:
    """Best-effort mirror of FrogTalk reactions onto the bridged Telegram post.

    Mirrors aggregate presence of an emoji using Telegram's setMessageReaction
    when the bot/API supports it. Failures are logged at debug level only.
    """
    if not ft_msg_id or not emoji:
        return
    try:
        import database as db
        remote_id = db.lookup_bridge_remote_id("telegram", chat_id, ft_msg_id)
        if not remote_id:
            return
        desired_on = int((counts or {}).get(emoji, 0) or 0) > 0
        reaction = [{"type": "emoji", "emoji": emoji}] if desired_on else []
        await tg_request(
            "setMessageReaction",
            chat_id=chat_id,
            message_id=int(remote_id),
            reaction=reaction,
            is_big=False,
        )
    except Exception as e:
        log.debug("telegram reaction mirror failed for chat %s: %s", chat_id, e)


async def forward_reaction_to_telegram(room: str, ft_msg_id: int,
                                       emoji: str, counts: dict) -> None:
    if not _bridges or not ft_msg_id or not emoji:
        return
    for chat_id, bridge in _bridges.items():
        if bridge["room"] != room or not bridge["enabled"]:
            continue
        direction = (bridge.get("direction") or "both").lower()
        if direction == "in":
            continue
        await apply_reaction_to_telegram(chat_id, ft_msg_id, emoji, counts)


async def forward_delete_to_telegram(room: str, ft_msg_id: int) -> None:
    """Delete the Telegram-side mirror of a FrogTalk message that was just
    deleted on FrogTalk. Best-effort: bots can only delete messages they
    sent (which is exactly the FT→TG mirror) so this is the common case."""
    if not _bridges or not ft_msg_id:
        return
    import database as db
    for chat_id, bridge in _bridges.items():
        if bridge["room"] != room or not bridge["enabled"]:
            continue
        if (bridge.get("direction") or "both").lower() == "in":
            continue
        try:
            remote_id = db.lookup_bridge_remote_id("telegram", chat_id, ft_msg_id)
            if not remote_id:
                continue
            await tg_request("deleteMessage", chat_id=chat_id, message_id=int(remote_id))
        except Exception as e:
            log.debug("telegram delete mirror failed for chat %s: %s", chat_id, e)


async def forward_edit_to_telegram(room: str, ft_msg_id: int, new_content: str,
                                   *, nickname: str | None = None) -> None:
    """Edit the Telegram-side mirror of a FrogTalk message. Tries
    editMessageCaption first (works for media-bearing messages) and falls
    back to editMessageText for plain-text messages."""
    if not _bridges or not ft_msg_id:
        return
    import html as _html
    import database as db

    nick = nickname
    if not nick:
        try:
            with db._conn() as con:
                row = con.execute(
                    "SELECT nickname FROM messages WHERE id=?", (ft_msg_id,)
                ).fetchone()
            nick = (row["nickname"] if row else "") or ""
        except Exception:
            nick = ""

    safe_nick = _html.escape(nick or "")
    safe_room = _html.escape(room)
    safe_body = _html.escape(new_content or "")
    header = f"<b>{safe_nick}</b> <i>· via FrogTalk #{safe_room}</i>"
    text = f"{header}\n{safe_body} <i>(edited)</i>" if safe_body else f"{header} <i>(edited)</i>"

    for chat_id, bridge in _bridges.items():
        if bridge["room"] != room or not bridge["enabled"]:
            continue
        if (bridge.get("direction") or "both").lower() == "in":
            continue
        try:
            remote_id = db.lookup_bridge_remote_id("telegram", chat_id, ft_msg_id)
            if not remote_id:
                continue
            # Try caption edit first (media messages); on "no caption" /
            # "message can't be edited" errors fall through to text edit.
            resp = await tg_request(
                "editMessageCaption", chat_id=chat_id,
                message_id=int(remote_id), caption=text, parse_mode="HTML",
            )
            if not resp.get("ok"):
                await tg_request(
                    "editMessageText", chat_id=chat_id,
                    message_id=int(remote_id), text=text, parse_mode="HTML",
                )
        except Exception as e:
            log.debug("telegram edit mirror failed for chat %s: %s", chat_id, e)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    TELEGRAM_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not TELEGRAM_TOKEN:
        print("Set TELEGRAM_BOT_TOKEN environment variable")
        exit(1)
    
    load_bridges()
    asyncio.run(poll_loop())
