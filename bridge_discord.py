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
                           reply_to_remote_id: str | None = None):
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
            payload["remote_chat_id"] = remote_chat_id
        if remote_msg_id is not None:
            payload["remote_msg_id"] = remote_msg_id
        if reply_to_remote_id:
            payload["reply_to_remote_id"] = reply_to_remote_id
        r = await client.post(
            f"{FROGTALK_API}/api/bridge/message",
            json=payload
        )
        if r.status_code != 200:
            log.error("FrogTalk bridge send failed: %s", r.text)


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
                        ext = mime.split("/")[-1].split("+")[0] or "png"
                        fname = f"image.{ext}"
                    elif mime.startswith("video/"):
                        ext = mime.split("/")[-1] or "mp4"
                        fname = f"video.{ext}"
                    elif mime.startswith("audio/"):
                        ext = mime.split("/")[-1] or "ogg"
                        fname = f"audio.{ext}"
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

        if discord and nickname:
            embed = discord.Embed(
                description=text or None,
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
                sent = await channel.send(embed=embed, file=file_obj, reference=reference)
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
                    sent = await channel.send(embed=embed, reference=reference)
            else:
                sent = await channel.send(embed=embed, reference=reference)
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

            if not bridge or not bridge.get("enabled"):
                # ── Text-command claim path ───────────────────────────────
                # Requires Message Content intent to read normal channel text.
                content_raw = (message.content or "").strip()

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

                # Strip mention prefix: "@Bot bridge CODE" → "bridge CODE"
                for pfx in (f"<@{c.user.id}>", f"<@!{c.user.id}>"):
                    if content_raw.lower().startswith(pfx.lower()):
                        content_raw = content_raw[len(pfx):].strip()
                        break

                m = re.match(
                    r"^bridge\s+([A-Z0-9]{4,})\s*$", content_raw, re.IGNORECASE
                )
                if m:
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
            if message.attachments:
                att = message.attachments[0]
                ctype = (att.content_type or "").lower()
                if ctype.startswith(("image/", "video/", "audio/")):
                    media_url = att.url
                elif att.url and any(att.url.lower().endswith(ext)
                                     for ext in (".jpg", ".jpeg", ".png", ".gif",
                                                 ".webp", ".mp4", ".webm", ".mov",
                                                 ".mp3", ".ogg", ".wav")):
                    media_url = att.url
                elif att.url:
                    content += f"\n📎 {att.url}"
                for extra in message.attachments[1:]:
                    if extra.url:
                        content += f"\n📎 {extra.url}"

            if message.embeds and not content:
                embed = message.embeds[0]
                if embed.title:
                    content = f"[{embed.title}]({embed.url})" if embed.url else embed.title

            if content or media_url:
                await send_to_frogtalk(
                    bridge["room"], bridge["token"], content, sender_name, media_url,
                    sender_avatar=sender_avatar,
                    remote_chat_id=channel_id,
                    remote_msg_id=message.id,
                    reply_to_remote_id=reply_to_remote_id,
                )

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
                             *, ft_msg_id: int | None = None,
                             reply_to_ft_id: int | None = None,
                             media_blur: bool = False):
    """Forward a FrogTalk message to all linked Discord channels as a
    rich embed (nickname + avatar + source-channel footer)."""
    if not _bridges:
        return
    if not any(b["room"] == room and b["enabled"] for b in _bridges.values()):
        return

    # Cheap users-table lookup for the sender's avatar.
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
            dc_msg_id = await send_to_discord(
                channel_id, body, media_data,
                nickname=nickname, avatar=sender_avatar, room=room,
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


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    DISCORD_TOKEN = os.environ.get("DISCORD_BOT_TOKEN")
    if not DISCORD_TOKEN:
        print("Set DISCORD_BOT_TOKEN environment variable")
        exit(1)

    load_bridges()
    _run_bot_in_thread(DISCORD_TOKEN)
