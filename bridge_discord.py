"""
Discord ↔ FrogTalk Bridge Bot

Bridges messages between Discord channels and FrogTalk rooms.
Run alongside main.py as a background task.

Usage:
  Set DISCORD_BOT_TOKEN env var, then:
  python bridge_discord.py

Or import and call start_discord_bridge() from main.py
"""

import os
import asyncio
import logging
import threading
import re
from typing import Optional, Dict
import httpx

log = logging.getLogger("bridge.discord")

DISCORD_TOKEN: Optional[str] = None
FROGTALK_API = os.getenv(
    "FROGTALK_INTERNAL_URL",
    f"http://127.0.0.1:{os.getenv('PORT', '8080')}",
)
_bridges: Dict[int, dict] = {}  # discord_channel_id -> {room, token, bot_name, enabled, direction}
_client = None  # discord.Client instance
_message_content_available = True  # False when bot lacks Message Content privileged intent

# Cache of per-channel webhooks used to render bridged messages with the
# original sender's name + avatar. Populated lazily; entries set to False
# mean we tried and failed (missing Manage Webhooks permission) so we
# don't retry on every message.
_webhook_cache: Dict[int, object] = {}
_WEBHOOK_NAME = "FrogTalk Bridge"

# MIME → file-extension map. Discord (and most browsers) infer the
# media player from the extension, not the content-type header, so a
# voice clip uploaded as `audio.mpeg` won't get an inline player —
# it has to be `audio.mp3`. This map covers the cases where the MIME
# subtype differs from the conventional extension.
_MIME_EXT = {
    "image/jpeg": "jpg",
    "image/svg+xml": "svg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/webm": "weba",
    "video/quicktime": "mov",
    "video/x-matroska": "mkv",
}


def _ext_for_mime(mime: str, fallback: str) -> str:
    """Return a sensible file extension for a given MIME type."""
    mime = (mime or "").lower().strip()
    if mime in _MIME_EXT:
        return _MIME_EXT[mime]
    sub = mime.split("/", 1)[-1].split("+")[0] if "/" in mime else ""
    return sub or fallback


def get_channel_access_snapshot(channel_id: int) -> Optional[dict]:
    """Return live access details for a Discord text channel if cached by the bot."""
    if not _client or not _client.is_ready():
        return None
    try:
        channel = _client.get_channel(int(channel_id))
        if not channel or not getattr(channel, "guild", None):
            return None
        guild = channel.guild
        me = getattr(guild, "me", None)
        perms = channel.permissions_for(me) if me else None
        return {
            "channel_id": int(channel.id),
            "channel_name": getattr(channel, "name", "channel") or "channel",
            "guild_id": int(getattr(guild, "id", 0) or 0),
            "guild_name": getattr(guild, "name", "Discord Server") or "Discord Server",
            "can_view": bool(getattr(perms, "view_channel", False)) if perms else True,
            "can_send": bool(getattr(perms, "send_messages", False)) if perms else True,
            "can_history": bool(getattr(perms, "read_message_history", False)) if perms else True,
        }
    except Exception:
        return None


def list_accessible_text_channels() -> list[dict]:
    """Return the text channels the live Discord bot can currently access."""
    if not _client or not _client.is_ready():
        return []
    rows: list[dict] = []
    try:
        for guild in sorted(_client.guilds, key=lambda item: (item.name or "").lower()):
            me = getattr(guild, "me", None)
            for channel in getattr(guild, "text_channels", []) or []:
                try:
                    perms = channel.permissions_for(me) if me else None
                    can_view = bool(getattr(perms, "view_channel", False)) if perms else True
                    if not can_view:
                        continue
                    rows.append({
                        "guild_id": int(getattr(guild, "id", 0) or 0),
                        "guild_name": getattr(guild, "name", "Discord Server") or "Discord Server",
                        "channel_id": int(getattr(channel, "id", 0) or 0),
                        "channel_name": getattr(channel, "name", "channel") or "channel",
                        "can_send": bool(getattr(perms, "send_messages", False)) if perms else True,
                        "can_history": bool(getattr(perms, "read_message_history", False)) if perms else True,
                    })
                except Exception:
                    continue
    except Exception:
        return []
    return rows


def _import_discord():
    """Import discord.py lazily so it doesn't break if not installed."""
    try:
        import discord
        return discord
    except ImportError:
        log.warning("discord.py not installed — run: pip install discord.py")
        return None


async def send_to_frogtalk(room: str, token: str, content: str,
                           sender_name: str = "Discord", media_url: str = None,
                           sender_avatar: str = None,
                           remote_chat_id: int | None = None,
                           remote_msg_id: int | None = None,
                           reply_to_remote_id: str | None = None,
                           source_name: str | None = None,
                           source_id: str | None = None,
                           source_parent: str | None = None):
    """Send a message from Discord to FrogTalk via REST."""
    async with httpx.AsyncClient(timeout=10) as client:
        payload = {
            "room_name": room,
            "content": content,
            "sender_name": sender_name,
            "bridge_token": token,
            "platform": "discord",
        }
        if media_url:
            payload["media_url"] = media_url
        if sender_avatar:
            payload["sender_avatar"] = sender_avatar
        if remote_chat_id is not None:
            # API model expects string IDs; Discord gives us integers.
            payload["remote_chat_id"] = str(remote_chat_id)
        if remote_msg_id is not None:
            payload["remote_msg_id"] = str(remote_msg_id)
        if reply_to_remote_id:
            payload["reply_to_remote_id"] = reply_to_remote_id
        if source_name:
            payload["source_name"] = str(source_name)
        if source_id:
            payload["source_id"] = str(source_id)
        if source_parent:
            payload["source_parent"] = str(source_parent)
        r = await client.post(
            f"{FROGTALK_API}/api/bridge/message",
            json=payload
        )
        if r.status_code != 200:
            log.error("FrogTalk bridge send failed: %s", r.text)


async def send_edit_to_frogtalk(room: str, token: str, content: str,
                                remote_chat_id: int, remote_msg_id: int) -> None:
    """Notify FrogTalk that a previously-bridged Discord message was edited."""
    payload = {
        "room_name": room, "bridge_token": token, "platform": "discord",
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
    """Notify FrogTalk that a previously-bridged Discord message was deleted."""
    payload = {
        "room_name": room, "bridge_token": token, "platform": "discord",
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


async def _run_on_discord_loop(coro):
    if not _client or not getattr(_client, "loop", None):
        return None
    try:
        current_loop = asyncio.get_running_loop()
    except RuntimeError:
        current_loop = None
    client_loop = _client.loop
    if current_loop is client_loop:
        return await coro
    future = asyncio.run_coroutine_threadsafe(coro, client_loop)
    return await asyncio.wrap_future(future)


async def _get_or_create_webhook(channel):
    """Return a cached/managed webhook for ``channel`` or None.

    Webhooks let us render each bridged message with the FrogTalk user's
    own name + avatar (instead of "BotName · embed"). We reuse a single
    webhook named ``FrogTalk Bridge`` per channel; if the bot lacks
    ``Manage Webhooks`` we cache the failure so we silently fall back to
    the embed path.
    """
    if channel is None:
        return None
    cid = int(getattr(channel, "id", 0) or 0)
    if not cid:
        return None
    cached = _webhook_cache.get(cid)
    if cached is False:
        return None
    if cached is not None:
        return cached
    try:
        # Look for an existing bridge webhook first to avoid duplicates.
        for wh in await channel.webhooks():
            if (getattr(wh, "name", "") or "") == _WEBHOOK_NAME:
                _webhook_cache[cid] = wh
                return wh
        wh = await channel.create_webhook(name=_WEBHOOK_NAME, reason="FrogTalk bridge")
        _webhook_cache[cid] = wh
        return wh
    except Exception as e:
        # Most commonly: missing Manage Webhooks. Cache the negative so
        # we don't probe the API for every message.
        log.debug("webhook setup failed for channel %s: %s", cid, e)
        _webhook_cache[cid] = False
        return None


async def _send_to_discord_inner(channel_id: int, text: str, media_url: str = None,
                                 *, nickname: str = None, avatar: str = None,
                                 room: str = None, has_spoiler: bool = False,
                                 reply_to_message_id: int | None = None) -> Optional[int]:
    """Send a message from FrogTalk to Discord.

    When `nickname` / `room` are supplied we render a rich embed so the
    reader sees the FrogTalk user's name + avatar and the source channel
    (`via #room · FrogTalk`). Falls back to plaintext when embeds aren't
    usable (e.g. the caller only supplied `text`).
    """
    if not _client or not _client.is_ready():
        log.warning("Discord client not ready, can't send message")
        return None
    discord = _import_discord()
    try:
        channel = _client.get_channel(channel_id)
        if not channel:
            channel = await _client.fetch_channel(channel_id)
        if not channel:
            return None
        reference = None
        if reply_to_message_id:
            try:
                reference = channel.get_partial_message(int(reply_to_message_id)).to_reference(
                    fail_if_not_exists=False
                )
            except Exception:
                reference = None

        # Data-URL media → decode + upload as a real Discord attachment so
        # images/videos actually render instead of leaving a "[image]" hole.
        file_obj = None
        if discord and media_url and media_url.startswith("data:"):
            try:
                import base64, io
                head, b64 = media_url.split(",", 1)
                mime = "application/octet-stream"
                if head.startswith("data:") and ";" in head:
                    mime = head[5:].split(";", 1)[0] or mime
                data = base64.b64decode(b64)
                # Discord free-tier upload limit is 25 MB — be conservative.
                if len(data) <= 24 * 1024 * 1024:
                    if mime.startswith("image/"):
                        fname = f"image.{_ext_for_mime(mime, 'png')}"
                    elif mime.startswith("video/"):
                        fname = f"video.{_ext_for_mime(mime, 'mp4')}"
                    elif mime.startswith("audio/"):
                        fname = f"audio.{_ext_for_mime(mime, 'ogg')}"
                    else:
                        fname = "file.bin"
                    # `spoiler=True` asks discord.py to rename the upload
                    # with the `SPOILER_` prefix, which makes the Discord
                    # client render a tap-to-reveal overlay — matching the
                    # FrogTalk spoiler UX.
                    file_obj = discord.File(
                        io.BytesIO(data), filename=fname,
                        spoiler=bool(has_spoiler),
                    )
            except Exception as e:
                log.debug("discord data-url decode failed: %s", e)
                file_obj = None

        # ── Webhook path (preferred) ───────────────────────────────────
        # When we have a nickname, try sending via a per-channel webhook
        # so the message renders with the FrogTalk user's own name +
        # avatar instead of being wrapped in a bot embed. Webhooks don't
        # support native message references, so reply context is
        # rendered as a quote line at the top of the message.
        if discord and nickname:
            webhook = await _get_or_create_webhook(channel)
            if webhook is not None:
                # Avatar must be a public http(s) URL; data: URLs are
                # not supported by Discord webhooks. Fall back to the
                # bot's default avatar in that case.
                wh_avatar = None
                if avatar and (avatar.startswith("http://") or avatar.startswith("https://")):
                    wh_avatar = avatar

                # Render reply context as a Discord quote block.
                quote_prefix = ""
                if reply_to_message_id:
                    try:
                        ref_msg = await channel.fetch_message(int(reply_to_message_id))
                        ref_author = (
                            getattr(ref_msg, "author", None)
                            and (getattr(ref_msg.author, "display_name", None)
                                 or getattr(ref_msg.author, "name", None))
                        ) or "user"
                        ref_text = (ref_msg.content or "").splitlines()[0] if ref_msg else ""
                        if len(ref_text) > 80:
                            ref_text = ref_text[:80] + "…"
                        if ref_text:
                            quote_prefix = f"> **{ref_author}**: {ref_text}\n"
                        else:
                            quote_prefix = f"> ↪ replying to **{ref_author}**\n"
                    except Exception:
                        quote_prefix = ""

                wh_text = (quote_prefix + (text or "")).strip() or None

                # Discord usernames must be 1-80 chars and can't contain
                # "discord" / "clyde" or "@everyone" / "@here" mentions.
                # Build a polished suffix mirroring the Telegram bridge:
                #   "Nick · via FrogTalk #room"
                # Falls back to "Nick · via FrogTalk" if the room name
                # would push us over Discord's 80-char username cap.
                _raw_nick = (nickname or "FrogTalk").strip() or "FrogTalk"
                _safe_room = re.sub(r"[^A-Za-z0-9_\-]+", "-", str(room or "").strip()).strip("-")
                _suffix_full = f" · via FrogTalk #{_safe_room}" if _safe_room else " · via FrogTalk"
                _suffix_short = " · via FrogTalk"
                _suffix = _suffix_full
                _max_nick = 80 - len(_suffix)
                if _max_nick < 3:
                    # Room makes the suffix too long — drop the room.
                    _suffix = _suffix_short
                    _max_nick = 80 - len(_suffix)
                if len(_raw_nick) > _max_nick:
                    _raw_nick = _raw_nick[: max(1, _max_nick - 1)].rstrip() + "\u2026"
                wh_name = (_raw_nick + _suffix)[:80]
                # Discord rejects webhook usernames containing these
                # substrings (case-insensitive); soften them so the send
                # doesn't 400 out and fall back to the embed path.
                _low = wh_name.lower()
                if "discord" in _low or "clyde" in _low:
                    wh_name = re.sub(r"(?i)discord", "disc\u200ford", wh_name)
                    wh_name = re.sub(r"(?i)clyde", "cly\u200fde", wh_name)
                    wh_name = wh_name[:80]

                try:
                    send_kwargs = dict(
                        username=wh_name,
                        avatar_url=wh_avatar,
                        wait=True,
                        allowed_mentions=discord.AllowedMentions.none(),
                    )
                    if file_obj:
                        sent = await webhook.send(content=wh_text, file=file_obj, **send_kwargs)
                    elif media_url and media_url.startswith("http"):
                        if has_spoiler:
                            body = (wh_text or "")
                            body = (body + f"\n||{media_url}||").strip()
                            sent = await webhook.send(content=body, **send_kwargs)
                        else:
                            body = (wh_text or "")
                            body = (body + f"\n{media_url}").strip()
                            sent = await webhook.send(content=body, **send_kwargs)
                    else:
                        sent = await webhook.send(content=wh_text or "\u200b", **send_kwargs)
                    return int(getattr(sent, "id", 0) or 0) or None
                except Exception as e:
                    # Fall through to the embed path on transient failure;
                    # if it's a permanent permission issue subsequent
                    # lookups will be cached as False.
                    log.debug("webhook send failed (falling back to embed): %s", e)
                    if "Unknown Webhook" in str(e) or "Invalid Webhook" in str(e):
                        _webhook_cache.pop(int(getattr(channel, "id", 0) or 0), None)

        if discord and nickname:
            # Detect URLs in the user's text. Discord auto-resolves URLs
            # (YouTube, X, articles, etc.) into rich embeds ONLY when they
            # appear in the message `content` — never inside an embed
            # description. So when text contains a URL we route the text
            # to `content` and use the embed as a small author chip,
            # letting Discord auto-generate the link preview alongside it.
            _has_url = bool(text and re.search(r'https?://\S+', text))
            embed = discord.Embed(
                description=None if _has_url else (text or None),
                color=0x2E7D32,  # frog green
            )
            # author icon_url must be http(s); skip data: URLs silently.
            icon = None
            if avatar and (avatar.startswith("http://") or avatar.startswith("https://")):
                icon = avatar
            embed.set_author(name=nickname, icon_url=icon)
            if room:
                embed.set_footer(text=f"via FrogTalk · #{room}")
            if file_obj:
                # Attaching the file + pointing the embed image at
                # attachment://<name> lets Discord inline-render the image
                # inside the rich card.
                if (media_url or "").startswith("data:image/"):
                    embed.set_image(url=f"attachment://{file_obj.filename}")
                _content = text if _has_url else None
                sent = await channel.send(content=_content, embed=embed, file=file_obj, reference=reference)
            elif media_url and media_url.startswith("http"):
                # Best-effort image preview — Discord ignores non-image URLs.
                # Wrap the URL in `||` spoiler markdown so the client hides
                # it behind a tap-to-reveal when the message was flagged.
                if has_spoiler:
                    suffix = f"\n||{media_url}||"
                    embed.description = ((text or "") + suffix).strip() or None
                    sent = await channel.send(embed=embed, reference=reference)
                else:
                    embed.set_image(url=media_url)
                    _content = text if _has_url else None
                    sent = await channel.send(content=_content, embed=embed, reference=reference)
            else:
                _content = text if _has_url else None
                sent = await channel.send(content=_content, embed=embed, reference=reference)
        else:
            if file_obj:
                sent = await channel.send(content=text or None, file=file_obj, reference=reference)
            elif media_url and media_url.startswith("http"):
                if has_spoiler:
                    sent = await channel.send(f"{text}\n||{media_url}||" if text else f"||{media_url}||", reference=reference)
                else:
                    sent = await channel.send(f"{text}\n{media_url}" if text else media_url, reference=reference)
            else:
                sent = await channel.send(text, reference=reference)
        return int(getattr(sent, "id", 0) or 0) or None
    except Exception as e:
        log.error("Failed to send to Discord channel %s: %s", channel_id, e)
        return None


async def send_to_discord(channel_id: int, text: str, media_url: str = None,
                          *, nickname: str = None, avatar: str = None,
                          room: str = None, has_spoiler: bool = False,
                          reply_to_message_id: int | None = None) -> Optional[int]:
    return await _run_on_discord_loop(_send_to_discord_inner(
        channel_id, text, media_url,
        nickname=nickname, avatar=avatar, room=room,
        has_spoiler=has_spoiler,
        reply_to_message_id=reply_to_message_id,
    ))


async def _apply_reaction_to_discord_inner(channel_id: int, ft_msg_id: int,
                                           emoji: str, counts: dict) -> None:
    """Best-effort mirror of FrogTalk reactions onto the bridged Discord post.

    Because the Discord side is represented by a single hosted bot, we mirror
    aggregate presence per emoji: if the FrogTalk message has at least one of a
    given emoji we ensure the bot has that reaction on the Discord message;
    when the count drops to zero we remove the bot's reaction.
    """
    if not _client or not _client.is_ready() or not ft_msg_id or not emoji:
        return
    try:
        import database as db
        remote_id = db.lookup_bridge_remote_id("discord", channel_id, ft_msg_id)
        if not remote_id:
            return
        channel = _client.get_channel(channel_id)
        if not channel:
            channel = await _client.fetch_channel(channel_id)
        if not channel:
            return
        message = await channel.fetch_message(int(remote_id))
        desired_on = int((counts or {}).get(emoji, 0) or 0) > 0
        me = _client.user
        mine_present = False
        for reaction in getattr(message, "reactions", []) or []:
            if str(getattr(reaction, "emoji", "")) == str(emoji):
                try:
                    mine_present = bool(getattr(reaction, "me", False))
                except Exception:
                    mine_present = False
                break
        if desired_on and not mine_present:
            await message.add_reaction(emoji)
        elif not desired_on and me and mine_present:
            await message.remove_reaction(emoji, me)
    except Exception as e:
        log.debug("discord reaction mirror failed for channel %s: %s", channel_id, e)


async def apply_reaction_to_discord(channel_id: int, ft_msg_id: int,
                                    emoji: str, counts: dict) -> None:
    await _run_on_discord_loop(_apply_reaction_to_discord_inner(channel_id, ft_msg_id, emoji, counts))


def load_bridges():
    """Load bridge configs from database."""
    global _bridges
    try:
        import database as db
        with db._conn() as con:
            rows = con.execute("""
                SELECT discord_channel_id, room_name, bot_token, bot_name, enabled,
                       COALESCE(direction, 'both') AS direction
                FROM discord_bridges WHERE enabled=1
            """).fetchall()
        _bridges = {
            row["discord_channel_id"]: {
                "room": row["room_name"],
                "token": row["bot_token"],
                "bot_name": row["bot_name"],
                "enabled": bool(row["enabled"]),
                "direction": row["direction"] or "both",
            }
            for row in rows
        }
        log.info("Loaded %d Discord bridges", len(_bridges))
    except Exception as e:
        log.warning("Could not load Discord bridges: %s", e)


def _run_bot_in_thread(token: str):
    """Run the Discord bot in a separate thread with its own event loop."""
    discord = _import_discord()
    if not discord:
        return

    global _client

    def _make_client(with_message_content: bool):
        intents = discord.Intents.default()
        intents.guilds = True
        if with_message_content:
            intents.message_content = True
        return discord.Client(intents=intents)

    # ── Shared claim logic ────────────────────────────────────────────────
    async def _do_claim(channel_id: int, guild_id: int,
                        channel_name: str, guild_name: str,
                        code: str) -> tuple[bool, str]:
        """Call FrogTalk's local claim endpoint.  Returns (ok, reply_text)."""
        code = re.sub(r"[^A-Z0-9]", "", (code or "").upper())
        if not code:
            return False, "🐸 That doesn't look like a valid claim code."
        payload = {
            "code": code,
            "discord_channel_id": int(channel_id),
            "discord_guild_id": int(guild_id or 0),
            "discord_channel_name": channel_name or "channel",
            "discord_guild_name": guild_name or "Discord Server",
        }
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    f"{FROGTALK_API}/api/discord-bridges/claim-code", json=payload
                )
            if resp.status_code == 200:
                info = (resp.json() if resp.content else {}) or {}
                room = info.get("room_name") or "your FrogTalk room"
                load_bridges()
                return True, (
                    "✅ **Bridge confirmed**\n"
                    f"Discord channel: **#{channel_name or 'channel'}**\n"
                    f"FrogTalk room: **#{room}**\n"
                    "Messages will now mirror both ways automatically."
                )
            detail = ""
            try:
                detail = ((resp.json() or {}).get("detail")
                          or (resp.json() or {}).get("error") or "")
            except Exception:
                detail = (resp.text or "").strip()
            return False, (
                f"🐸 Could not claim that code. "
                f"{detail or 'Check the code is still valid (15 min window) and try again.'}"
            )
        except Exception as e:
            log.error("Discord bridge claim failed for channel %s: %s", channel_id, e)
            return False, "🐸 Could not reach FrogTalk right now. Try again in a moment."

    # ── Register events on a client ───────────────────────────────────────
    def _register_events(c, message_content_ok: bool = True):
        @c.event
        async def on_ready():
            log.info("Discord bridge bot ready: %s (ID: %s)", c.user.name, c.user.id)
            log.info("Connected to %d guilds", len(c.guilds))

        @c.event
        async def on_message(message):
            if message.author == c.user or message.author.bot:
                return

            channel_id = message.channel.id
            bridge = _bridges.get(channel_id)
            bridge_enabled = bool(bridge and bridge.get("enabled"))

            # Parse bridge commands first (even in already-linked channels) so
            # users get explicit feedback instead of silent forwarding.
            content_raw = (message.content or "").strip()
            if content_raw:
                # Strip mention prefix: "@Bot bridge CODE" → "bridge CODE"
                for pfx in (f"<@{c.user.id}>", f"<@!{c.user.id}>"):
                    if content_raw.lower().startswith(pfx.lower()):
                        content_raw = content_raw[len(pfx):].strip()
                        break

                m = re.match(r"^bridge\s+([A-Z0-9]{4,})\s*$", content_raw, re.IGNORECASE)
                if m:
                    if bridge_enabled:
                        room = bridge.get("room") or "this FrogTalk room"
                        await message.channel.send(
                            f"🐸 This Discord channel is already linked to **#{room}**. "
                            "Remove the existing bridge first if you want to relink it."
                        )
                        return
                    code = re.sub(r"[^A-Z0-9]", "", m.group(1).upper())
                    guild = getattr(message, "guild", None)
                    ok, reply = await _do_claim(
                        channel_id=channel_id,
                        guild_id=int(getattr(guild, "id", 0) or 0),
                        channel_name=getattr(message.channel, "name", "channel") or "channel",
                        guild_name=getattr(guild, "name", "Discord Server") or "Discord Server",
                        code=code,
                    )
                    await message.channel.send(reply)
                    return

                if content_raw.lower() in ("!bridge", "bridge"):
                    await message.channel.send(
                        "🐸 **FrogTalk Bridge**\n\n"
                        "Generate a claim code in FrogTalk settings, then type:\n"
                        "• **bridge CODE**"
                    )
                    return

            if not bridge_enabled:
                # ── Text-command claim path ───────────────────────────────
                if not content_raw:
                    # Bot cannot read this message (no Message Content intent).
                    # Respond only if directly mentioned so we don't spam.
                    if c.user in (message.mentions or []):
                        await message.channel.send(
                            "🐸 Use **bridge CODE** to link this channel. If I still cannot "
                            "read your message, enable **Message Content Intent** for this bot "
                            "in the Discord Developer Portal and restart the service."
                        )
                    return
                return

            # ── Forward inbound Discord messages to FrogTalk ─────────────
            direction = (bridge.get("direction") or "both").lower()
            if direction == "out":
                return

            sender_name = message.author.display_name or message.author.name
            sender_avatar = None
            try:
                if message.author.display_avatar:
                    sender_avatar = str(message.author.display_avatar.url)
            except Exception:
                pass
            content = message.content or ""

            reply_to_remote_id = None
            try:
                if message.reference and getattr(message.reference, "message_id", None):
                    reply_to_remote_id = str(message.reference.message_id)
            except Exception:
                reply_to_remote_id = None

            media_url = None
            media_exts = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4",
                          ".webm", ".mov", ".mp3", ".ogg", ".wav", ".apng")
            # Discord voice messages set MessageFlags.IS_VOICE_MESSAGE
            # (bit 13). Detect so we can label them in the bridged message.
            is_voice_message = False
            try:
                flags_val = int(getattr(getattr(message, "flags", None), "value", 0) or 0)
                is_voice_message = bool(flags_val & (1 << 13))
            except Exception:
                is_voice_message = False
            if message.attachments:
                att = message.attachments[0]
                ctype = (att.content_type or "").lower()
                if ctype.startswith(("image/", "video/", "audio/")):
                    media_url = att.url
                elif att.url and any(att.url.lower().split("?")[0].endswith(ext)
                                     for ext in media_exts):
                    media_url = att.url
                elif att.url:
                    content += f"\n📎 {att.url}"
                for extra in message.attachments[1:]:
                    if extra.url:
                        content += f"\n📎 {extra.url}"
                # Label voice / video clips when the user didn't add text
                # so the receiving side has context (otherwise FrogTalk
                # just shows a bare audio/video player with no caption).
                if not content.strip() and media_url:
                    if is_voice_message or ctype.startswith("audio/"):
                        content = "🎤 voice message" if is_voice_message else "🎵 audio"
                    elif ctype.startswith("video/"):
                        content = "🎬 video"

            # ── Discord embeds (Tenor / Giphy / image links auto-embedded) ──
            # When a user posts a Tenor / Giphy GIF link, Discord turns it
            # into an embed of type "gifv" / "image" / "video" with the
            # actual media URL on embed.image.url / embed.video.url /
            # embed.thumbnail.url. The message.content is just the page URL,
            # which is useless to FrogTalk — extract the real GIF/MP4 here.
            if not media_url and message.embeds:
                for embed in message.embeds:
                    etype = (getattr(embed, "type", "") or "").lower()
                    cand = None
                    # Prefer animated video (mp4) for gifv embeds when present.
                    for src in ("video", "image", "thumbnail"):
                        obj = getattr(embed, src, None)
                        url = getattr(obj, "url", None) if obj else None
                        if url and any(url.lower().split("?")[0].endswith(ext)
                                       for ext in media_exts):
                            cand = url
                            break
                    if not cand and etype in ("image", "gifv", "video") and getattr(embed, "url", None):
                        # Some embed shapes only expose the page URL on .url.
                        if any(embed.url.lower().split("?")[0].endswith(ext)
                               for ext in media_exts):
                            cand = embed.url
                    if cand:
                        media_url = cand
                        # Strip the bare embed link from content if that's
                        # all the user typed — avoids sending a useless
                        # tenor.com link alongside the actual GIF.
                        page_url = getattr(embed, "url", None)
                        stripped = content.strip()
                        if page_url and (stripped == page_url or stripped == cand):
                            content = ""
                        break

            # ── Discord stickers (static PNG/APNG only) ─────────────────
            if not media_url:
                stickers = getattr(message, "stickers", None) or []
                for st in stickers:
                    try:
                        st_url = str(getattr(st, "url", "") or "")
                        # Skip Lottie (.json) — not renderable on FrogTalk.
                        if st_url and not st_url.lower().split("?")[0].endswith(".json"):
                            media_url = st_url
                            break
                    except Exception:
                        pass

            # ── Plain media URL pasted in text ──────────────────────────
            # If the message is just a direct media URL (raw .gif / .mp4),
            # promote it to media_url so it renders inline on FrogTalk.
            if not media_url and content:
                stripped = content.strip()
                if re.match(r"^https?://\S+$", stripped):
                    base = stripped.lower().split("?")[0]
                    if any(base.endswith(ext) for ext in media_exts):
                        media_url = stripped
                        content = ""

            if message.embeds and not content and not media_url:
                embed = message.embeds[0]
                if getattr(embed, "title", None):
                    content = f"[{embed.title}]({embed.url})" if getattr(embed, "url", None) else embed.title

            if content or media_url:
                await send_to_frogtalk(
                    bridge["room"], bridge["token"], content, sender_name, media_url,
                    sender_avatar=sender_avatar,
                    remote_chat_id=channel_id,
                    remote_msg_id=message.id,
                    reply_to_remote_id=reply_to_remote_id,
                    source_name=("#" + (getattr(message.channel, "name", "channel") or "channel")),
                    source_id=str(channel_id),
                    source_parent=(getattr(getattr(message, "guild", None), "name", "Discord server") or "Discord server"),
                )

        # ── Mirror inbound edits ──────────────────────────────────────────
        @c.event
        async def on_message_edit(before, after):
            try:
                # Skip our own bot's messages and webhook-relay messages we
                # ourselves posted (those are FT→DC mirrors; their "edit"
                # came from FrogTalk via forward_edit_to_discord, not from
                # a Discord user — re-mirroring would loop).
                if after.author == c.user or getattr(after, "webhook_id", None):
                    return
                if getattr(after.author, "bot", False):
                    return
                # Discord fires this even when only embeds change (link
                # unfurls). Skip when content didn't actually change.
                if (before.content or "") == (after.content or ""):
                    return
                channel_id = after.channel.id
                bridge = _bridges.get(channel_id)
                if not bridge or not bridge.get("enabled"):
                    return
                if (bridge.get("direction") or "both").lower() == "out":
                    return
                await send_edit_to_frogtalk(
                    bridge["room"], bridge["token"],
                    after.content or "", channel_id, after.id,
                )
            except Exception as e:
                log.debug("on_message_edit failed: %s", e)

        # ── Mirror inbound deletions ──────────────────────────────────────
        @c.event
        async def on_message_delete(message):
            try:
                # Same loop-protection as edits: skip our own bridge posts.
                if message.author == c.user or getattr(message, "webhook_id", None):
                    return
                if getattr(message.author, "bot", False):
                    return
                channel_id = message.channel.id
                bridge = _bridges.get(channel_id)
                if not bridge or not bridge.get("enabled"):
                    return
                if (bridge.get("direction") or "both").lower() == "out":
                    return
                await send_delete_to_frogtalk(
                    bridge["room"], bridge["token"],
                    channel_id, message.id,
                )
            except Exception as e:
                log.debug("on_message_delete failed: %s", e)

        # Raw delete fires even for messages not in the cache (e.g. older
        # than the bot's session memory). Use it as a fallback.
        @c.event
        async def on_raw_message_delete(payload):
            try:
                channel_id = payload.channel_id
                msg_id = payload.message_id
                # If the cached message is present, on_message_delete
                # already handled it — avoid double-fire.
                if getattr(payload, "cached_message", None):
                    return
                bridge = _bridges.get(channel_id)
                if not bridge or not bridge.get("enabled"):
                    return
                if (bridge.get("direction") or "both").lower() == "out":
                    return
                await send_delete_to_frogtalk(
                    bridge["room"], bridge["token"], channel_id, msg_id,
                )
            except Exception as e:
                log.debug("on_raw_message_delete failed: %s", e)

    # ── Start the bot ─────────────────────────────────────────────────────
    client = _make_client(with_message_content=True)
    _client = client
    _register_events(client, message_content_ok=True)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(client.start(token))
    except discord.PrivilegedIntentsRequired:
        log.warning(
            "Discord bot: Message Content privileged intent is NOT enabled. "
            "Text 'bridge CODE' will not work until this intent is enabled. "
            "To enable: https://discord.com/developers/applications → your bot → Bot → "
            "Privileged Gateway Intents → Message Content."
        )
        global _message_content_available
        _message_content_available = False
        # Rebuild client without the privileged intent so the bot still connects,
        # but bridge claim commands in text channels cannot be read.
        client = _make_client(with_message_content=False)
        _client = client
        _register_events(client, message_content_ok=False)
        try:
            loop.run_until_complete(client.start(token))
        except Exception as e:
            log.error("Discord bot error (fallback): %s", e)
    except Exception as e:
        log.error("Discord bot error: %s", e)
    finally:
        loop.close()


async def start_discord_bridge():
    """Start the Discord bridge (call from main app)."""
    global DISCORD_TOKEN
    DISCORD_TOKEN = os.environ.get("DISCORD_BOT_TOKEN")
    if not DISCORD_TOKEN:
        log.info("No DISCORD_BOT_TOKEN set, Discord bridge disabled")
        return

    load_bridges()

    # Run the Discord bot in a background thread
    # (discord.py has its own event loop that conflicts with asyncio)
    thread = threading.Thread(
        target=_run_bot_in_thread,
        args=(DISCORD_TOKEN,),
        daemon=True,
        name="discord-bridge"
    )
    thread.start()
    log.info("Discord bridge started in background thread")


def stop_discord_bridge():
    global _client
    if _client and not _client.is_closed:
        asyncio.run_coroutine_threadsafe(_client.close(), _client.loop)
    _client = None


# ─── FrogTalk → Discord forwarding ───────────────────────────────────────────
# Called by ws_manager when a message is sent in a bridged room

async def forward_to_discord(room: str, nickname: str, content: str,
                             media_data: str = None,
                             sender_avatar: str | None = None,
                             *, ft_msg_id: int | None = None,
                             reply_to_ft_id: int | None = None,
                             media_blur: bool = False,
                             sender_user_id: int | None = None,
                             display_name: str | None = None):
    """Forward a FrogTalk message to all linked Discord channels as a
    rich embed (nickname + avatar + source-channel footer)."""
    if not _bridges:
        return
    if not any(b["room"] == room and b["enabled"] for b in _bridges.values()):
        return

    # Resolve a *publicly-reachable* avatar URL. Discord webhooks fetch
    # the avatar by URL on send, so data: URLs and 127.0.0.1 hosts won't
    # work — they need to live behind the site's public origin so the
    # Discord CDN can reach them.
    resolved_avatar = (sender_avatar or "").strip() or None
    public_base = (
        os.getenv("FROGTALK_PUBLIC_URL")
        or os.getenv("PUBLIC_URL")
        or os.getenv("FROGTALK_BASE_URL")
        or "https://frogtalk.xyz"
    ).rstrip("/")

    # If we know the FrogTalk user id, always prefer the public avatar
    # endpoint — it serves whatever bytes are in the user row, which
    # also covers users whose avatar is a relative path or data: URL.
    if sender_user_id:
        # Cache-bust per ft_msg_id so Discord re-fetches when avatar
        # changes; this is cheap and per-message.
        bust = f"?v={ft_msg_id}" if ft_msg_id else ""
        resolved_avatar = f"{public_base}/api/users/{int(sender_user_id)}/avatar.png{bust}"
    elif resolved_avatar and not (
        resolved_avatar.startswith("http://") or resolved_avatar.startswith("https://")
    ):
        # Fall back to the users-table lookup when the caller didn't
        # supply an id (e.g. legacy code paths).
        resolved_avatar = None
        try:
            import database as db
            u = db.get_user_by_nick(nickname)
            if u:
                uid = u.get("id")
                if uid:
                    resolved_avatar = f"{public_base}/api/users/{int(uid)}/avatar.png"
                else:
                    av = (u.get("avatar") or "").strip()
                    if av.startswith("http://") or av.startswith("https://"):
                        resolved_avatar = av
        except Exception:
            pass

    body = content or "[media]"
    for channel_id, bridge in _bridges.items():
        if bridge["room"] != room or not bridge["enabled"]:
            continue
        direction = (bridge.get("direction") or "both").lower()
        if direction == "in":
            continue
        reply_dc_id = None
        if reply_to_ft_id:
            try:
                import database as _db
                rid = _db.lookup_bridge_remote_id("discord", channel_id, reply_to_ft_id)
                if rid:
                    reply_dc_id = int(rid)
            except Exception:
                reply_dc_id = None
        try:
            _dn = (display_name or "").strip() or None
            _bridge_nick = f"{_dn} (@{nickname})" if (_dn and _dn != nickname) else nickname
            dc_msg_id = await send_to_discord(
                channel_id, body, media_data,
                nickname=_bridge_nick, avatar=resolved_avatar, room=room,
                has_spoiler=bool(media_blur),
                reply_to_message_id=reply_dc_id,
            )
            if dc_msg_id and ft_msg_id:
                try:
                    import database as _db
                    _db.save_bridge_msg_map("discord", channel_id, dc_msg_id, ft_msg_id)
                except Exception:
                    pass
        except Exception as e:
            log.error("Forward to Discord %s failed: %s", channel_id, e)


async def forward_reaction_to_discord(room: str, ft_msg_id: int,
                                      emoji: str, counts: dict) -> None:
    if not _bridges or not ft_msg_id or not emoji:
        return
    for channel_id, bridge in _bridges.items():
        if bridge["room"] != room or not bridge["enabled"]:
            continue
        direction = (bridge.get("direction") or "both").lower()
        if direction == "in":
            continue
        await apply_reaction_to_discord(channel_id, ft_msg_id, emoji, counts)


async def _delete_discord_message_inner(channel_id: int, remote_id: int) -> None:
    """Delete a previously-bridged Discord message. Tries the per-channel
    webhook first (since that's how FT→Discord messages are normally sent),
    then falls back to a direct channel.fetch_message().delete()."""
    if not _client or not _client.is_ready():
        return
    try:
        channel = _client.get_channel(channel_id) or await _client.fetch_channel(channel_id)
        if not channel:
            return
        # Webhook delete path: messages we send via the bridge webhook can
        # only be deleted through the same webhook handle.
        webhook = await _get_or_create_webhook(channel)
        if webhook is not None:
            try:
                await webhook.delete_message(int(remote_id))
                return
            except Exception as e:
                # Not a webhook-owned message → fall through to bot path.
                log.debug("discord webhook delete failed (falling back): %s", e)
        try:
            msg = await channel.fetch_message(int(remote_id))
            await msg.delete()
        except Exception as e:
            log.debug("discord channel delete failed: %s", e)
    except Exception as e:
        log.debug("discord delete inner failed: %s", e)


async def _edit_discord_message_inner(channel_id: int, remote_id: int,
                                      new_content: str, nickname: str | None,
                                      room: str | None) -> None:
    if not _client or not _client.is_ready():
        return
    try:
        channel = _client.get_channel(channel_id) or await _client.fetch_channel(channel_id)
        if not channel:
            return
        body = (new_content or "")
        edited_marker = "  *(edited)*"
        new_text = (body + edited_marker) if body else edited_marker.strip()
        webhook = await _get_or_create_webhook(channel)
        if webhook is not None:
            try:
                await webhook.edit_message(int(remote_id), content=new_text)
                return
            except Exception as e:
                log.debug("discord webhook edit failed (falling back): %s", e)
        try:
            msg = await channel.fetch_message(int(remote_id))
            # If message was sent as an embed (not webhook), update the
            # embed description to match the new body.
            if getattr(msg, "embeds", None):
                discord = _import_discord()
                if discord:
                    embed = msg.embeds[0]
                    new_embed = discord.Embed(
                        description=new_text or None,
                        color=getattr(embed, "color", None) or 0x2E7D32,
                    )
                    if getattr(embed, "author", None) and getattr(embed.author, "name", None):
                        new_embed.set_author(
                            name=embed.author.name,
                            icon_url=getattr(embed.author, "icon_url", None),
                        )
                    if getattr(embed, "footer", None) and getattr(embed.footer, "text", None):
                        new_embed.set_footer(text=embed.footer.text)
                    if getattr(embed, "image", None) and getattr(embed.image, "url", None):
                        new_embed.set_image(url=embed.image.url)
                    await msg.edit(embed=new_embed)
                    return
            await msg.edit(content=new_text)
        except Exception as e:
            log.debug("discord channel edit failed: %s", e)
    except Exception as e:
        log.debug("discord edit inner failed: %s", e)


async def forward_delete_to_discord(room: str, ft_msg_id: int) -> None:
    if not _bridges or not ft_msg_id:
        return
    import database as db
    for channel_id, bridge in _bridges.items():
        if bridge["room"] != room or not bridge["enabled"]:
            continue
        if (bridge.get("direction") or "both").lower() == "in":
            continue
        try:
            remote_id = db.lookup_bridge_remote_id("discord", channel_id, ft_msg_id)
            if not remote_id:
                continue
            await _run_on_discord_loop(_delete_discord_message_inner(channel_id, int(remote_id)))
        except Exception as e:
            log.debug("discord delete mirror failed for channel %s: %s", channel_id, e)


async def forward_edit_to_discord(room: str, ft_msg_id: int, new_content: str,
                                  *, nickname: str | None = None) -> None:
    if not _bridges or not ft_msg_id:
        return
    import database as db
    for channel_id, bridge in _bridges.items():
        if bridge["room"] != room or not bridge["enabled"]:
            continue
        if (bridge.get("direction") or "both").lower() == "in":
            continue
        try:
            remote_id = db.lookup_bridge_remote_id("discord", channel_id, ft_msg_id)
            if not remote_id:
                continue
            await _run_on_discord_loop(_edit_discord_message_inner(
                channel_id, int(remote_id), new_content, nickname, room,
            ))
        except Exception as e:
            log.debug("discord edit mirror failed for channel %s: %s", channel_id, e)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    DISCORD_TOKEN = os.environ.get("DISCORD_BOT_TOKEN")
    if not DISCORD_TOKEN:
        print("Set DISCORD_BOT_TOKEN environment variable")
        exit(1)

    load_bridges()
    _run_bot_in_thread(DISCORD_TOKEN)
