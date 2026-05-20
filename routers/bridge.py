"""Bridge management endpoints (Telegram + Discord)."""

import os
import base64
import hmac
import secrets
import string
import time
import re
from datetime import datetime
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel
from typing import Optional
from urllib.parse import quote_plus
import httpx

import database as db
from deps import get_current_user, client_ip
from slowapi import Limiter

limiter = Limiter(key_func=client_ip)

# 10.5: nickname sanitizers used to scrub bridged sender_name before
# we store / broadcast it. Strips bidirectional / zero-width Unicode
# (commonly used to spoof "Admin" in chat) and ASCII control chars.
_BIDI_ZW_RE = re.compile(r"[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")

router = APIRouter(tags=["bridge"])

# In-memory pending invite codes for the easy bridge-setup flow.
# Maps CODE -> {"room_name", "owner_id", "bot_token", "bot_name", "expires_at"}
_pending_codes: dict = {}
_CODE_TTL = 15 * 60  # 15 minutes

# HIGH-10: hard cap on inbound bridge ``data:`` URLs (covers media_url and
# sender_avatar both). Rendered in base64 so a "10 MB image" is ~13.3 MB
# of URL. 8 MB of URL ≈ 6 MB of binary, which is generous for chat media.
_BRIDGE_DATA_URL_MAX = 8 * 1024 * 1024


def _discord_client_id_from_token(token: str) -> Optional[str]:
    """Best-effort extract Discord bot user/client id from token prefix.

    Discord bot tokens commonly encode the bot user id in the first segment
    (base64url). If extraction fails, return None.
    """
    try:
        if not token or "." not in token:
            return None
        first = token.split(".", 1)[0].strip()
        if not first:
            return None
        padded = first + "=" * ((4 - len(first) % 4) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
        cid = raw.decode("ascii", errors="ignore").strip()
        return cid if cid.isdigit() else None
    except Exception:
        return None


async def _validate_discord_channel_access(channel_id: int) -> tuple[int, int]:
    """Ensure the configured hosted Discord bot can see the target channel.

    Returns `(channel_id, guild_id)` on success. Raises `HTTPException` with a
    user-facing explanation when the id is invalid or the bot cannot access it.
    """
    try:
        import bridge_discord as bdc
        snap = bdc.get_channel_access_snapshot(channel_id)
        if snap:
            if not snap.get("can_view"):
                raise HTTPException(403, "FrogTalk Discord bot cannot view that channel")
            if not snap.get("can_send"):
                raise HTTPException(403, "FrogTalk Discord bot can see that channel but cannot send messages there")
            return int(snap["channel_id"]), int(snap.get("guild_id") or 0)
    except HTTPException:
        raise
    except Exception:
        pass

    token = (os.getenv("DISCORD_BOT_TOKEN") or "").strip()
    if not token:
        raise HTTPException(503, "Discord bridge bot is not configured on this server")

    url = f"https://discord.com/api/v10/channels/{int(channel_id)}"
    headers = {"Authorization": f"Bot {token}"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(url, headers=headers)
    except Exception:
        raise HTTPException(502, "Could not verify Discord channel right now")

    if response.status_code == 200:
        data = response.json()
        guild_id = int(data.get("guild_id") or 0)
        return int(data.get("id") or channel_id), guild_id

    detail = {}
    try:
        detail = response.json() or {}
    except Exception:
        detail = {}
    code = int(detail.get("code") or 0)
    if response.status_code == 404 and code == 10003:
        raise HTTPException(
            400,
            "Discord channel not found for this bot. Check that you copied the channel ID from the target text channel and that the FrogTalk bot was invited to that server with View Channels access.",
        )
    if response.status_code == 403:
        raise HTTPException(
            403,
            "FrogTalk Discord bot does not have permission to access that channel",
        )
    raise HTTPException(400, detail.get("message") or "Failed to verify Discord channel")


async def _fetch_discord_channel_details(channel_id: int) -> dict:
    token = (os.getenv("DISCORD_BOT_TOKEN") or "").strip()
    if not token:
        raise HTTPException(503, "Discord bridge bot is not configured on this server")

    headers = {"Authorization": f"Bot {token}"}
    async with httpx.AsyncClient(timeout=15) as client:
        channel_resp = await client.get(
            f"https://discord.com/api/v10/channels/{int(channel_id)}",
            headers=headers,
        )
        if channel_resp.status_code != 200:
            raise HTTPException(400, "Could not read Discord channel details")
        channel = channel_resp.json() or {}

        guild_id = str(channel.get("guild_id") or "").strip()
        guild_name = "Discord Server"
        if guild_id:
            guild_resp = await client.get(
                f"https://discord.com/api/v10/guilds/{guild_id}",
                headers=headers,
            )
            if guild_resp.status_code == 200:
                guild_name = (guild_resp.json() or {}).get("name") or guild_name

    return {
        "channel_id": int(channel.get("id") or channel_id),
        "channel_name": channel.get("name") or "channel",
        "guild_id": int(guild_id or 0),
        "guild_name": guild_name,
    }

def _gen_code() -> str:
    alphabet = string.ascii_uppercase + string.digits
    # Avoid confusing chars
    alphabet = alphabet.replace("O", "").replace("0", "").replace("I", "").replace("1", "")
    return "".join(secrets.choice(alphabet) for _ in range(6))

def _sweep_codes():
    now = time.time()
    expired = [c for c, v in _pending_codes.items() if v.get("expires_at", 0) < now]
    for c in expired:
        _pending_codes.pop(c, None)


class CreateBridgeRequest(BaseModel):
    room_name: str
    telegram_chat_id: int
    bot_token: str
    bot_name: str = ""


class CreateDiscordBridgeRequest(BaseModel):
    room_name: str
    discord_channel_id: int
    discord_guild_id: int = 0
    bot_name: str = ""


class ValidateDiscordChannelRequest(BaseModel):
    discord_channel_id: int


class ToggleBridgeRequest(BaseModel):
    enabled: bool


class BridgeMessageRequest(BaseModel):
    """Incoming message from bridge bot."""
    room_name: str
    sender_name: str
    content: str = ""
    media_url: Optional[str] = None
    sender_avatar: Optional[str] = None
    bridge_token: str
    platform: str = "telegram"
    # Remote-platform message ids, used to render replies natively.
    # `remote_msg_id` is the id of THIS message on the remote platform.
    # `reply_to_remote_id` is the id of the message being replied to on the
    # remote platform (server resolves it to the FrogTalk msg_id via the
    # bridge_msg_map table).
    remote_chat_id: Optional[str] = None
    remote_msg_id: Optional[str] = None
    reply_to_remote_id: Optional[str] = None
    # Human-readable source context for bridged profile cards.
    source_name: Optional[str] = None
    source_id: Optional[str] = None
    source_parent: Optional[str] = None
    # Remote @handle of the sender on the originating platform (Discord
    # username, Telegram @username). Distinct from sender_name which is
    # the display name. Surfaced on the bridged-user profile card so
    # viewers can see the actual handle, not just the chosen nickname.
    sender_username: Optional[str] = None


class BridgeMutateRequest(BaseModel):
    """Inbound edit / delete signal from a bridge bot.

    `remote_chat_id` + `remote_msg_id` identify the message on the remote
    side; the server resolves it back to the FrogTalk message via
    `bridge_msg_map`. Edits supply `content`; deletes leave it empty.
    """
    room_name: str
    bridge_token: str
    platform: str = "telegram"
    remote_chat_id: str
    remote_msg_id: str
    content: Optional[str] = None


class DirectionRequest(BaseModel):
    direction: str  # 'both' | 'in' | 'out'


@router.get("/bridges")
async def list_bridges(current_user: dict = Depends(get_current_user)):
    bridges = db.get_telegram_bridges(owner_id=current_user["id"])
    return {"bridges": bridges}


@router.get("/rooms/{room_name}/bridge-outbound")
async def room_bridge_outbound(room_name: str, _: dict = Depends(get_current_user)):
    """Return whether the given room has any enabled bridge that mirrors
    FrogTalk → remote (direction in {'both','out'}).

    Used by the client so it can attach a plaintext `bridge_plain` field on
    encrypted messages — the server never stores it, only forwards it to the
    remote platform. For rooms with NO outbound bridge, no plaintext leaves
    the browser and E2EE is preserved.
    """
    outbound = False
    try:
        for b in db.get_telegram_bridges_for_room(room_name):
            if (b.get("direction") or "both").lower() in ("both", "out"):
                outbound = True
                break
        if not outbound:
            for b in db.get_discord_bridges_for_room(room_name):
                if (b.get("direction") or "both").lower() in ("both", "out"):
                    outbound = True
                    break
    except Exception:
        pass
    return {"outbound": outbound}


@router.get("/rooms/{room_name}/bridge-sources")
async def room_bridge_sources(room_name: str, current_user: dict = Depends(get_current_user)):
    """Return active bridge source metadata for a room.

    Unlike owner-only bridge management endpoints, this is safe for any room
    member and is used by the client to render bridged-profile source labels.
    """
    if not db.user_can_access_room(
        current_user["id"], room_name,
        is_admin=bool(current_user.get("is_admin")),
    ):
        raise HTTPException(403, "Not a member of this room")

    sources = []
    try:
        for b in db.get_telegram_bridges_for_room(room_name):
            chat_id = b.get("telegram_chat_id")
            chat_title = str(b.get("telegram_chat_title") or "").strip()
            sources.append({
                "platform": "telegram",
                "name": chat_title or (f"Telegram chat {chat_id}" if chat_id is not None else "Telegram"),
                "id": str(chat_id) if chat_id is not None else "",
                "parent": "Telegram",
            })
    except Exception:
        pass

    try:
        for b in db.get_discord_bridges_for_room(room_name):
            ch_id = b.get("discord_channel_id")
            ch_name = str(b.get("discord_channel_name") or "").strip()
            guild_name = str(b.get("discord_guild_name") or "").strip()
            sources.append({
                "platform": "discord",
                "name": ch_name or (f"#{ch_id}" if ch_id is not None else "Discord channel"),
                "id": str(ch_id) if ch_id is not None else "",
                "parent": guild_name or "Discord server",
            })
    except Exception:
        pass

    return {"sources": sources}


@router.post("/bridges/create")
async def create_bridge_endpoint(body: CreateBridgeRequest, current_user: dict = Depends(get_current_user)):
    # Verify user owns the room
    room = db.get_room_by_name(body.room_name)
    if not room:
        raise HTTPException(404, "Room not found")
    if room["owner_id"] != current_user["id"]:
        raise HTTPException(403, "Only room owner can create bridges")
    # Private rooms cannot be bridged: the bridge bot is a 3rd-party endpoint
    # outside the E2EE trust boundary. Bridging would leak plaintext to the
    # remote platform and defeat the room's encryption + key-rotation model.
    if (room.get("type") or "public") == "private":
        raise HTTPException(403, "Bridges are not available for private (E2EE) rooms")
    if len(body.bot_token) < 20 or ":" not in body.bot_token:
        raise HTTPException(400, "Invalid bot token format")

    bridge_id = db.create_telegram_bridge(
        room_name=body.room_name,
        telegram_chat_id=body.telegram_chat_id,
        bot_token=body.bot_token,
        bot_name=body.bot_name,
        owner_id=current_user["id"],
        telegram_chat_title="",
    )
    if not bridge_id:
        raise HTTPException(409, "Bridge already exists for this room/chat combination")
    return {"id": bridge_id, "ok": True}


# ─── Easy bridge setup: invite-code flow ─────────────────────────────────
# Flow:
#   1. Frontend calls /bridges/prepare-code with room + bot_token → gets CODE + bot username
#   2. User adds @FrogTalkBridgeBot to their Telegram group
#   3. User types "/claim CODE" in the Telegram group
#   4. bridge_telegram.py sees the /claim command, calls /bridges/claim-code
#      (server-side) with {code, telegram_chat_id}; bridge is finalized
#   5. Frontend polls /bridges/check-code until status=claimed (or uses WS later)

class PrepareCodeRequest(BaseModel):
    room_name: str
    bot_token: str  # FrogTalk bot API key, used as bridge_token on /api/bridge/message
    bot_name: str = "Telegram Bridge"


class ClaimCodeRequest(BaseModel):
    code: str
    telegram_chat_id: int
    telegram_chat_title: str = ""


class PrepareDiscordCodeRequest(BaseModel):
    room_name: str
    bot_name: str = "Discord Bridge"


class ClaimDiscordCodeRequest(BaseModel):
    code: str
    discord_channel_id: int
    discord_guild_id: int = 0
    discord_channel_name: str = ""
    discord_guild_name: str = ""


@router.post("/bridges/prepare-code")
async def bridge_prepare_code(body: PrepareCodeRequest, current_user: dict = Depends(get_current_user)):
    """Issue a short-lived invite code that the user sends to the Telegram bot
    via `/claim CODE`. The bot then finalizes the bridge server-side so the
    user never has to find the numeric chat_id themselves."""
    _sweep_codes()
    room = db.get_room_by_name(body.room_name)
    if not room:
        raise HTTPException(404, "Room not found")
    if room["owner_id"] != current_user["id"]:
        raise HTTPException(403, "Only room owner can create bridges")
    if (room.get("type") or "public") == "private":
        raise HTTPException(403, "Bridges are not available for private (E2EE) rooms")
    if len(body.bot_token) < 20 or ":" not in body.bot_token:
        # FrogTalk bot tokens are `bot_xxxxx`; accept those too.
        if not body.bot_token.startswith("bot_"):
            raise HTTPException(400, "Invalid bot token format")

    # Generate a unique code
    for _ in range(10):
        code = _gen_code()
        if code not in _pending_codes:
            break
    else:
        raise HTTPException(500, "Could not allocate code, try again")

    _pending_codes[code] = {
        "room_name": body.room_name,
        "owner_id": current_user["id"],
        "bot_token": body.bot_token,
        "bot_name": body.bot_name or "Telegram Bridge",
        "expires_at": time.time() + _CODE_TTL,
        "status": "pending",
        "bridge_id": None,
    }

    # Report which bot the user should add (from env)
    bot_username = os.environ.get("TELEGRAM_BOT_USERNAME", "")
    return {
        "ok": True,
        "code": code,
        "bot_username": bot_username,
        "expires_in": _CODE_TTL,
        "instructions": (
            f"1. Add @{bot_username or 'FrogTalkBridgeBot'} to your Telegram group\n"
            f"2. In the group, send: /claim {code}\n"
            f"3. This window will update when linked"
        ),
    }


@router.get("/bridges/check-code/{code}")
async def bridge_check_code(code: str, current_user: dict = Depends(get_current_user)):
    """Frontend polls this to learn if the code has been claimed."""
    _sweep_codes()
    entry = _pending_codes.get(code.upper())
    if not entry:
        return {"status": "expired"}
    if entry["owner_id"] != current_user["id"]:
        raise HTTPException(403, "Not your code")
    return {"status": entry.get("status", "pending"), "bridge_id": entry.get("bridge_id")}


def _build_bridge_claim_command(platform: str, code: str) -> str:
    p = (platform or "").lower()
    if p == "discord":
        return f"bridge {code}"
    return f"/claim {code}"


@router.post("/bridges/claim-code")
async def bridge_claim_code(body: ClaimCodeRequest, request: Request):
    """Called server-side by bridge_telegram.py when it sees `/claim CODE`.
    Only accepts loopback / local calls — not meant to be invoked by browsers."""
    # Security: restrict to loopback to prevent random internet calls from
    # hijacking codes. The Telegram bridge runs in-process with us, so
    # 127.0.0.1 is sufficient.
    client_ip = (request.client.host if request.client else "")
    if client_ip not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(403, "Only callable locally")

    _sweep_codes()
    code = body.code.upper().strip()
    entry = _pending_codes.get(code)
    if not entry:
        raise HTTPException(404, "Code not found or expired")
    if entry.get("status") == "claimed":
        return {"ok": True, "already": True, "room_name": entry["room_name"]}

    bridge_id = db.create_telegram_bridge(
        room_name=entry["room_name"],
        telegram_chat_id=body.telegram_chat_id,
        bot_token=entry["bot_token"],
        bot_name=entry["bot_name"],
        owner_id=entry["owner_id"],
        telegram_chat_title=body.telegram_chat_title,
    )
    if not bridge_id:
        # Bridge may already exist for this chat+room — update title best-effort
        try:
            with db._conn() as con:
                con.execute(
                    "UPDATE telegram_bridges SET telegram_chat_title=COALESCE(NULLIF(?, ''), telegram_chat_title) "
                    "WHERE room_name=? AND telegram_chat_id=? AND owner_id=?",
                    (body.telegram_chat_title or "", entry["room_name"], body.telegram_chat_id, entry["owner_id"]),
                )
                con.commit()
        except Exception:
            pass
        return {"ok": True, "already": True, "room_name": entry["room_name"]}

    entry["status"] = "claimed"
    entry["bridge_id"] = bridge_id

    # Register with the live in-memory bridge map so messages flow immediately.
    try:
        import bridge_telegram as btg
        btg._bridges[body.telegram_chat_id] = {
            "room": entry["room_name"],
            "token": entry["bot_token"],
            "bot_name": entry["bot_name"],
            "enabled": True,
            "direction": "both",
        }
    except Exception:
        pass

    return {
        "ok": True,
        "bridge_id": bridge_id,
        "room_name": entry["room_name"],
        "chat_title": body.telegram_chat_title,
    }


@router.delete("/bridges/{bridge_id}")
async def delete_bridge(bridge_id: int, current_user: dict = Depends(get_current_user)):
    # Look up the chat_id BEFORE deleting so we can drop it from the live
    # in-memory bridge map — otherwise the poll loop keeps mirroring until
    # the service restarts.
    chat_id = None
    try:
        for b in db.get_telegram_bridges(owner_id=current_user["id"]):
            if b.get("id") == bridge_id:
                chat_id = b.get("telegram_chat_id")
                break
    except Exception:
        pass
    if not db.delete_telegram_bridge(bridge_id, current_user["id"]):
        raise HTTPException(404, "Bridge not found or not owned by you")
    if chat_id is not None:
        try:
            import bridge_telegram as btg
            btg._bridges.pop(chat_id, None)
        except Exception:
            pass
    return {"ok": True}


@router.post("/bridges/{bridge_id}/toggle")
async def toggle_bridge(bridge_id: int, body: ToggleBridgeRequest, current_user: dict = Depends(get_current_user)):
    # Try Telegram first, then Discord
    if not db.toggle_telegram_bridge(bridge_id, current_user["id"], body.enabled):
        if not db.toggle_discord_bridge(bridge_id, current_user["id"], body.enabled):
            raise HTTPException(404, "Bridge not found or not owned by you")
    return {"ok": True}


@router.post("/bridges/{bridge_id}/direction")
async def set_bridge_direction(bridge_id: int, body: DirectionRequest,
                               current_user: dict = Depends(get_current_user)):
    """Set mirroring direction for a Telegram OR Discord bridge.

    both = two-way, in = remote→FrogTalk only, out = FrogTalk→remote only.
    """
    direction = (body.direction or "both").lower()
    if direction not in ("both", "in", "out"):
        raise HTTPException(400, "direction must be 'both', 'in', or 'out'")
    with db._conn() as con:
        # Only update rows owned by the caller. Try both tables — the id
        # space is separate, but only one will match.
        cur = con.execute(
            "UPDATE telegram_bridges SET direction=? WHERE id=? AND owner_id=?",
            (direction, bridge_id, current_user["id"]),
        )
        touched_tg = cur.rowcount
        cur = con.execute(
            "UPDATE discord_bridges SET direction=? WHERE id=? AND owner_id=?",
            (direction, bridge_id, current_user["id"]),
        )
        touched_dc = cur.rowcount
        con.commit()
    if not (touched_tg or touched_dc):
        raise HTTPException(404, "Bridge not found or not owned by you")
    # Refresh in-memory bridge map so direction changes take effect live.
    try:
        import bridge_telegram as btg
        btg.load_bridges()
    except Exception:
        pass
    try:
        import bridge_discord as bdc
        bdc.load_bridges()
    except Exception:
        pass
    return {"ok": True, "direction": direction}


# ─── Discord bridge endpoints ─────────────────────────────────────────────

@router.get("/discord-bridges")
async def list_discord_bridges(current_user: dict = Depends(get_current_user)):
    bridges = db.get_discord_bridges(owner_id=current_user["id"])
    return {"bridges": bridges}


@router.get("/discord-bridges/invite-meta")
async def discord_bridge_invite_meta(_: dict = Depends(get_current_user)):
    """Return one-click invite metadata for the hosted Discord bridge bot.

    Resolution order:
    1) DISCORD_BOT_INVITE_URL (explicit override)
    2) Build OAuth URL from DISCORD_BOT_CLIENT_ID
    3) Build OAuth URL by decoding DISCORD_BOT_TOKEN prefix
    """
    invite_url = (os.environ.get("DISCORD_BOT_INVITE_URL") or "").strip()
    client_id = (os.environ.get("DISCORD_BOT_CLIENT_ID") or "").strip()
    token = (os.environ.get("DISCORD_BOT_TOKEN") or "").strip()

    # Required for bridge read/write basics.
    permissions_int = 117760
    scopes = "bot applications.commands"

    if not invite_url:
        if not client_id:
            client_id = _discord_client_id_from_token(token) or ""
        if client_id:
            invite_url = (
                "https://discord.com/oauth2/authorize"
                f"?client_id={quote_plus(client_id)}"
                f"&permissions={permissions_int}"
                f"&scope={quote_plus(scopes)}"
            )

    return {
        "ok": bool(invite_url),
        "invite_url": invite_url,
        "client_id": client_id,
        "permissions": {
            "int": permissions_int,
            "recommended": [
                "View Channels",
                "Read Message History",
                "Send Messages",
                "Embed Links",
                "Attach Files",
            ],
        },
    }


@router.post("/discord-bridges/prepare-code")
async def discord_bridge_prepare_code(body: PrepareDiscordCodeRequest,
                                      current_user: dict = Depends(get_current_user)):
    """Issue a short-lived claim code for Discord.

    The bridge is only created after the hosted Discord bot sees `bridge CODE`
    in the target channel, which proves the caller can actually post there.
    """
    _sweep_codes()
    room = db.get_room_by_name(body.room_name)
    if not room:
        raise HTTPException(404, "Room not found")
    if room["owner_id"] != current_user["id"]:
        raise HTTPException(403, "Only room owner can create bridges")
    if (room.get("type") or "public") == "private":
        raise HTTPException(403, "Bridges are not available for private (E2EE) rooms")

    for _ in range(10):
        code = _gen_code()
        if code not in _pending_codes:
            break
    else:
        raise HTTPException(500, "Could not allocate code, try again")

    _pending_codes[code] = {
        "platform": "discord",
        "room_name": body.room_name,
        "owner_id": current_user["id"],
        # Per-bridge random secret so inbound /api/bridge/message can't be
        # forged by anyone who guesses the room name. Stored in the
        # discord_bridges row (Fernet-encrypted if BRIDGE_KEK is set) at
        # claim time and pulled by the Discord bot via load_bridges().
        "bot_token": secrets.token_urlsafe(32),
        "bot_name": body.bot_name or "Discord Bridge",
        "expires_at": time.time() + _CODE_TTL,
        "status": "pending",
        "bridge_id": None,
    }

    command_text = _build_bridge_claim_command("discord", code)
    return {
        "ok": True,
        "platform": "discord",
        "code": code,
        "command": command_text,
        "expires_in": _CODE_TTL,
        "instructions": (
            "1. Open the Discord channel you want to bridge\n"
            f"2. Send exactly: {command_text}\n"
            "3. This window will update automatically when the bridge is linked"
        ),
        "message_content_required": True,
    }


@router.post("/discord-bridges/claim-code")
async def discord_bridge_claim_code(body: ClaimDiscordCodeRequest, request: Request):
    """Called locally by the Discord bridge bot after it sees `bridge CODE`."""
    client_ip = (request.client.host if request.client else "")
    if client_ip not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(403, "Only callable locally")

    _sweep_codes()
    code = re.sub(r"[^A-Z0-9]", "", (body.code or "").upper())
    entry = _pending_codes.get(code)
    if not entry or (entry.get("platform") or "telegram") != "discord":
        raise HTTPException(404, "Code not found or expired")
    if entry.get("status") == "claimed":
        return {"ok": True, "already": True, "room_name": entry["room_name"]}

    bridge_id = db.create_discord_bridge(
        room_name=entry["room_name"],
        discord_channel_id=body.discord_channel_id,
        bot_token=entry.get("bot_token") or secrets.token_urlsafe(32),
        bot_name=entry.get("bot_name") or "Discord Bridge",
        owner_id=entry["owner_id"],
        discord_guild_id=body.discord_guild_id or 0,
        discord_channel_name=body.discord_channel_name,
        discord_guild_name=body.discord_guild_name,
    )
    if not bridge_id:
        existing = None
        try:
            for bridge in db.get_discord_bridges(owner_id=entry["owner_id"]):
                if bridge.get("room_name") == entry["room_name"] and int(bridge.get("discord_channel_id") or 0) == int(body.discord_channel_id):
                    existing = bridge
                    break
        except Exception:
            existing = None
        if existing:
            try:
                with db._conn() as con:
                    con.execute(
                        "UPDATE discord_bridges SET "
                        "discord_channel_name=COALESCE(NULLIF(?, ''), discord_channel_name), "
                        "discord_guild_name=COALESCE(NULLIF(?, ''), discord_guild_name) "
                        "WHERE id=? AND owner_id=?",
                        (body.discord_channel_name or "", body.discord_guild_name or "", existing.get("id"), entry["owner_id"]),
                    )
                    con.commit()
            except Exception:
                pass
            entry["status"] = "claimed"
            entry["bridge_id"] = existing.get("id")
            try:
                import bridge_discord as bdc
                bdc.load_bridges()
            except Exception:
                pass
            return {"ok": True, "already": True, "bridge_id": existing.get("id"), "room_name": entry["room_name"]}
        raise HTTPException(409, "Bridge already exists for this room/channel combination")

    entry["status"] = "claimed"
    entry["bridge_id"] = bridge_id

    try:
        import bridge_discord as bdc
        bdc.load_bridges()
    except Exception:
        pass

    return {
        "ok": True,
        "bridge_id": bridge_id,
        "room_name": entry["room_name"],
        "channel_name": body.discord_channel_name,
        "guild_name": body.discord_guild_name,
    }


@router.post("/discord-bridges/validate-channel")
async def validate_discord_channel_endpoint(body: ValidateDiscordChannelRequest,
                                            _: dict = Depends(get_current_user)):
    channel_id, guild_id = await _validate_discord_channel_access(body.discord_channel_id)
    details = await _fetch_discord_channel_details(channel_id)
    return {
        "ok": True,
        "channel_id": int(channel_id),
        "guild_id": int(guild_id or details.get("guild_id") or 0),
        "channel_name": details.get("channel_name") or "channel",
        "guild_name": details.get("guild_name") or "Discord Server",
    }


@router.post("/discord-bridges/create")
async def create_discord_bridge_endpoint(body: CreateDiscordBridgeRequest, current_user: dict = Depends(get_current_user)):
    room = db.get_room_by_name(body.room_name)
    if not room:
        raise HTTPException(404, "Room not found")
    if room["owner_id"] != current_user["id"]:
        raise HTTPException(403, "Only room owner can create bridges")
    if (room.get("type") or "public") == "private":
        raise HTTPException(403, "Bridges are not available for private (E2EE) rooms")
    channel_id, guild_id = await _validate_discord_channel_access(body.discord_channel_id)
    # LOW-I1: the manual create path previously referenced `details.get(...)`
    # without ever fetching them; fall back to the validate snapshot.
    try:
        details = await _fetch_discord_channel_details(channel_id)
    except Exception:
        details = {}
    bridge_id = db.create_discord_bridge(
        room_name=body.room_name,
        discord_channel_id=channel_id,
        bot_token=secrets.token_urlsafe(32),
        bot_name=body.bot_name or "Discord Bridge",
        owner_id=current_user["id"],
        discord_guild_id=body.discord_guild_id or guild_id,
        discord_channel_name=(details.get("channel_name") or "") if isinstance(details, dict) else "",
        discord_guild_name=(details.get("guild_name") or "") if isinstance(details, dict) else "",
    )
    if not bridge_id:
        raise HTTPException(409, "Bridge already exists for this room/channel combination")
    try:
        import bridge_discord as bdc
        bdc.load_bridges()
    except Exception:
        pass
    return {"id": bridge_id, "ok": True}


@router.delete("/discord-bridges/{bridge_id}")
async def delete_discord_bridge(bridge_id: int, current_user: dict = Depends(get_current_user)):
    if not db.delete_discord_bridge(bridge_id, current_user["id"]):
        raise HTTPException(404, "Bridge not found or not owned by you")
    try:
        import bridge_discord as bdc
        bdc.load_bridges()
    except Exception:
        pass
    return {"ok": True}


@router.post("/bridge/message")
@limiter.limit("120/minute")
async def receive_bridge_message(request: Request, body: BridgeMessageRequest):
    """Receive a message forwarded from a bridge bot (Telegram or Discord)."""
    # Verify bridge token matches a known bridge.
    # 9.5: scope candidates to (platform, room) FIRST so we don't iterate
    # every bridge in the system on each call. Inside the candidate set
    # we still constant-time compare against EVERY row to avoid leaking
    # which row matched via early-return timing.
    platform = body.platform or "telegram"
    if platform == "telegram":
        candidates = db.get_telegram_bridges_for_room(body.room_name)
    elif platform == "discord":
        candidates = db.get_discord_bridges_for_room(body.room_name)
    else:
        candidates = []
    matched_bridge = None
    supplied_token_raw = (body.bridge_token or "").strip()
    # Defence-in-depth against the legacy literal `"discord"` token. Even
    # after the startup migration rotates every existing row, refuse the
    # well-known string outright so a stale node or a forgotten test fixture
    # can't be tricked into accepting forged Discord messages.
    if supplied_token_raw.lower() == "discord" or len(supplied_token_raw) < 16:
        raise HTTPException(403, "Invalid bridge token")
    supplied_token = supplied_token_raw.encode("utf-8")
    for b in candidates:
        stored = (b.get("bot_token") or "").encode("utf-8")
        ok = (
            len(stored) == len(supplied_token)
            and hmac.compare_digest(stored, supplied_token)
            and bool(b.get("enabled", 1))
        )
        if ok and matched_bridge is None:
            matched_bridge = b
        # Deliberately no `break` — keep iterating so total time is
        # constant w.r.t. which row (or no row) matched.

    # Sanitize sender_name once: strip HTML, control chars, RTL/LTR
    # overrides, and zero-width joiners. Keeps logs + UI bubbles safe
    # even if a downstream renderer ever drops escaping. Cap at 64 chars.
    if body.sender_name:
        sn = body.sender_name
        sn = _BIDI_ZW_RE.sub("", sn)
        sn = _CTRL_RE.sub("", sn)
        sn = sn.replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
        body.sender_name = sn.strip()[:64] or "bridge"

    if not matched_bridge:
        raise HTTPException(403, "Invalid bridge token")

    if not body.sender_name or len(body.sender_name) < 1:
        raise HTTPException(400, "sender_name required")
    if body.content and len(body.content) > 10_000:
        raise HTTPException(413, "content too long")

    # Scheme allow-list — reject javascript:/file:/etc. that could be
    # broadcast to clients. media_url may also be a data: URL (we decode
    # those server-side for Discord uploads); sender_avatar must be remote.
    #
    # HIGH-10: cap inbound ``data:`` URLs at _BRIDGE_DATA_URL_MAX bytes.
    # Without this a compromised bridge bot could spam ``data:image/...``
    # blobs that get base64-stored straight into the messages table and
    # rebroadcast to every WebSocket on the room.
    if body.media_url:
        _mu = body.media_url.strip()
        if not (_mu.startswith("http://") or _mu.startswith("https://") or _mu.startswith("data:")):
            raise HTTPException(400, "Unsupported media_url scheme")
        if _mu.startswith("data:") and len(_mu) > _BRIDGE_DATA_URL_MAX:
            raise HTTPException(413, "media_url too large")
    if body.sender_avatar:
        _av = body.sender_avatar.strip()
        if not (_av.startswith("http://") or _av.startswith("https://") or _av.startswith("data:")):
            raise HTTPException(400, "Unsupported sender_avatar scheme")
        if _av.startswith("data:") and len(_av) > _BRIDGE_DATA_URL_MAX:
            raise HTTPException(413, "sender_avatar too large")

    # Honor direction setting: 'out' means FrogTalk→remote only, so we
    # deliberately drop inbound messages. 'both' / 'in' accept them.
    direction = (matched_bridge.get("direction") or "both").lower()
    if direction == "out":
        return {"ok": True, "dropped": "direction=out"}

    media_type = None
    if body.media_url:
        mu = body.media_url.strip()
        # Prefer the explicit MIME prefix on `data:` URLs — that's how
        # bridges (Telegram voice notes, Discord uploads) deliver audio
        # and video. Falling through to the URL-suffix sniffer below
        # would mis-tag `data:audio/ogg;base64,…` as image/jpeg and the
        # client would render a broken <img>.
        if mu.lower().startswith("data:"):
            try:
                # data:<mime>[;params],<payload>
                head = mu.split(",", 1)[0]  # "data:audio/ogg;base64"
                mt = head[5:].split(";", 1)[0].strip().lower()
                if "/" in mt:
                    media_type = mt
            except Exception:
                pass
        if not media_type:
            lower = mu.lower()
            # Strip query/fragment before suffix-matching so URLs like
            # https://cdn/file.mp4?sig=… are still detected.
            path_only = lower.split("?", 1)[0].split("#", 1)[0]
            if path_only.endswith(".gif"):
                media_type = "image/gif"
            elif path_only.endswith(".webp"):
                media_type = "image/webp"
            elif path_only.endswith(".png"):
                media_type = "image/png"
            elif path_only.endswith(".jpg") or path_only.endswith(".jpeg"):
                media_type = "image/jpeg"
            elif path_only.endswith(".mp4") or path_only.endswith(".m4v"):
                media_type = "video/mp4"
            elif path_only.endswith(".webm"):
                media_type = "video/webm"
            elif path_only.endswith(".mov"):
                media_type = "video/quicktime"
            elif path_only.endswith(".ogg") or path_only.endswith(".oga") or path_only.endswith(".opus"):
                media_type = "audio/ogg"
            elif path_only.endswith(".mp3"):
                media_type = "audio/mpeg"
            elif path_only.endswith(".m4a") or path_only.endswith(".aac"):
                media_type = "audio/mp4"
            elif path_only.endswith(".wav"):
                media_type = "audio/wav"
            else:
                # Last-resort default: only image/jpeg if no clue at all.
                # Still better than nothing for HTTP CDN URLs without a
                # recognized extension (Telegram thumbnails, etc.).
                media_type = "image/jpeg"

    # Save to DB as a bridge message. user_id must reference a real user row
    # (FK constraint) — attribute to the bridge owner so history is preserved.
    bridge_owner_id = matched_bridge.get("owner_id") or 1
    source_name = (body.source_name or "").strip()
    source_id = (body.source_id or "").strip()
    source_parent = (body.source_parent or "").strip()
    if not source_name:
        if platform == "telegram":
            source_name = str(matched_bridge.get("telegram_chat_title") or "").strip()
            if not source_name and matched_bridge.get("telegram_chat_id") is not None:
                source_name = "Telegram chat " + str(matched_bridge.get("telegram_chat_id"))
            if not source_id and matched_bridge.get("telegram_chat_id") is not None:
                source_id = str(matched_bridge.get("telegram_chat_id"))
        elif platform == "discord":
            source_name = str(matched_bridge.get("discord_channel_name") or "").strip()
            if not source_name and matched_bridge.get("discord_channel_id") is not None:
                source_name = "#" + str(matched_bridge.get("discord_channel_id"))
            if not source_id and matched_bridge.get("discord_channel_id") is not None:
                source_id = str(matched_bridge.get("discord_channel_id"))
            if not source_parent:
                source_parent = str(matched_bridge.get("discord_guild_name") or "").strip()

    # Resolve an inbound reply: if the remote message is a reply to another
    # remote message that we've previously mirrored, attach it as a native
    # FrogTalk reply. Otherwise the reply just renders as a plain message.
    reply_to_ft_id = None
    reply_nickname = None
    reply_content = None
    if body.reply_to_remote_id and body.remote_chat_id:
        reply_to_ft_id = db.lookup_bridge_msg_map(
            platform, body.remote_chat_id, body.reply_to_remote_id
        )
        if reply_to_ft_id:
            try:
                with db._conn() as _con:
                    row = _con.execute(
                        "SELECT nickname, substr(content,1,120) AS content "
                        "FROM messages WHERE id=?", (reply_to_ft_id,)
                    ).fetchone()
                if row:
                    reply_nickname = row["nickname"]
                    reply_content = row["content"]
            except Exception:
                pass

    msg_id = db.save_message(
        room_name=body.room_name,
        user_id=bridge_owner_id,
        nickname=body.sender_name,
        content=body.content or "",
        media_data=body.media_url,
        media_type=media_type,
        bridge_platform=platform,
        bridge_avatar=body.sender_avatar or None,
        bridge_source_name=(source_name or None),
        bridge_source_id=(source_id or None),
        bridge_source_parent=(source_parent or None),
        bridge_sender_username=((body.sender_username or "").strip()[:64] or None),
        reply_to=reply_to_ft_id,
    )

    # Persist the remote → FrogTalk mapping so future replies on either
    # platform can resolve back to this message.
    if body.remote_msg_id and body.remote_chat_id:
        db.save_bridge_msg_map(
            platform, body.remote_chat_id, body.remote_msg_id, msg_id
        )

    # Broadcast to WebSocket clients in the room
    from ws_manager import manager
    msg_data = {
        "type": "message",
        "id": msg_id,
        "room": body.room_name,
        "nickname": body.sender_name,
        "user_id": 0,
        "content": body.content or "",
        "media_data": body.media_url,
        "media_type": media_type,
        "edited": False,
        "reactions": {},
        "created_at": datetime.utcnow().isoformat() + "Z",
        "bridge": True,
        "platform": platform,
        "bridge_platform": platform,
        "avatar": body.sender_avatar or None,
        "bridge_source_name": source_name,
        "bridge_source_id": source_id,
        "bridge_source_parent": source_parent,
        "bridge_sender_username": ((body.sender_username or "").strip()[:64] or None),
        "reply_to": reply_to_ft_id,
        "reply_nickname": reply_nickname,
        "reply_content": reply_content,
    }
    # Backward-compatible alias for older consumers
    msg_data["sender"] = msg_data["nickname"]
    await manager.broadcast_room(body.room_name, msg_data)

    return {"ok": True, "id": msg_id}


# Hard cap on inbound bridge content length. Telegram caps text at 4096
# and captions at 1024; Discord caps at 4000 (premium) / 2000. Pick a
# generous ceiling that still prevents abuse / DB bloat from a compromised
# bot token.
_BRIDGE_CONTENT_MAX = 8000
_ALLOWED_PLATFORMS = ("telegram", "discord")


def _match_bridge_token(body, platform: str) -> Optional[dict]:
    """Return the bridge row that matches `(bridge_token, room_name, platform)`.

    Constant-time token comparison, scoped to the supplied platform so a
    Telegram token can never authorise a Discord-platform mutation (or
    vice versa). Shared by the edit/delete bridge endpoints.
    """
    if platform == "telegram":
        candidates = db.get_telegram_bridges_for_room(body.room_name)
    elif platform == "discord":
        candidates = db.get_discord_bridges_for_room(body.room_name)
    else:
        return None
    supplied = (body.bridge_token or "").encode("utf-8")
    for b in candidates:
        stored = (b.get("bot_token") or "").encode("utf-8")
        if (
            len(stored) == len(supplied)
            and hmac.compare_digest(stored, supplied)
            and bool(b.get("enabled", 1))
        ):
            return b
    return None


@router.post("/bridge/delete")
@limiter.limit("120/minute")
async def bridge_delete_message(request: Request, body: BridgeMutateRequest):
    """Mirror a remote-platform deletion onto the FrogTalk side.

    Resolves the (platform, remote_chat_id, remote_msg_id) → FT msg_id via
    the bridge map and deletes the row. Authenticated solely by the
    bridge_token; only the matched bridge can affect its own room. We
    deliberately don't fan out to OTHER bridges — the inbound delete
    only needs to clear the FrogTalk-side mirror, not loop back to the
    platform that originated the deletion.
    """
    platform = (body.platform or "telegram").lower()
    if platform not in _ALLOWED_PLATFORMS:
        raise HTTPException(400, "Unsupported platform")
    matched = _match_bridge_token(body, platform)
    if not matched:
        raise HTTPException(403, "Invalid bridge token")
    if (matched.get("direction") or "both").lower() == "out":
        return {"ok": True, "dropped": "direction=out"}

    ft_msg_id = db.lookup_bridge_msg_map(platform, body.remote_chat_id, body.remote_msg_id)
    if not ft_msg_id:
        return {"ok": True, "skipped": "no_mapping"}

    # Ensure the mapped message actually belongs to this bridge's room.
    # Otherwise a compromised bot for room A could submit (chat_id, msg_id)
    # values that resolve to a message in room B.
    msg_row = db.get_message(int(ft_msg_id))
    if not msg_row or msg_row.get("room_name") != body.room_name:
        return {"ok": True, "skipped": "room_mismatch"}

    with db._conn() as con:
        con.execute("DELETE FROM messages WHERE id=?", (int(ft_msg_id),))
        # Drop the now-stale bridge map row so the slot can be reused.
        con.execute("DELETE FROM bridge_msg_map WHERE ft_msg_id=?", (int(ft_msg_id),))
        con.commit()

    from ws_manager import manager
    await manager.broadcast_room(body.room_name, {
        "type": "delete", "id": int(ft_msg_id), "room": body.room_name,
    })

    # Mirror the deletion to OTHER bridges linked to the same room (e.g.
    # Discord delete should also remove the Telegram mirror) but NOT
    # back to the originating platform — that would re-trigger the same
    # event. We achieve this by skipping any bridge whose chat_id matches
    # the inbound source.
    try:
        import bridge_outbound, asyncio as _asyncio
        loop = _asyncio.get_running_loop()
        if platform != "telegram":
            try:
                import bridge_telegram as btg
                loop.create_task(btg.forward_delete_to_telegram(body.room_name, int(ft_msg_id)))
            except Exception:
                pass
        if platform != "discord":
            try:
                import bridge_discord as bdc
                loop.create_task(bdc.forward_delete_to_discord(body.room_name, int(ft_msg_id)))
            except Exception:
                pass
    except Exception:
        pass

    return {"ok": True, "id": int(ft_msg_id)}


@router.post("/bridge/edit")
@limiter.limit("120/minute")
async def bridge_edit_message(request: Request, body: BridgeMutateRequest):
    """Mirror a remote-platform edit onto the FrogTalk side."""
    platform = (body.platform or "telegram").lower()
    if platform not in _ALLOWED_PLATFORMS:
        raise HTTPException(400, "Unsupported platform")
    matched = _match_bridge_token(body, platform)
    if not matched:
        raise HTTPException(403, "Invalid bridge token")
    if (matched.get("direction") or "both").lower() == "out":
        return {"ok": True, "dropped": "direction=out"}

    new_content = (body.content or "").strip()
    if not new_content:
        # Treat empty edits as no-op rather than blanking the message.
        return {"ok": True, "skipped": "empty"}
    if len(new_content) > _BRIDGE_CONTENT_MAX:
        new_content = new_content[:_BRIDGE_CONTENT_MAX]

    ft_msg_id = db.lookup_bridge_msg_map(platform, body.remote_chat_id, body.remote_msg_id)
    if not ft_msg_id:
        return {"ok": True, "skipped": "no_mapping"}

    msg_row = db.get_message(int(ft_msg_id))
    if not msg_row or msg_row.get("room_name") != body.room_name:
        return {"ok": True, "skipped": "room_mismatch"}

    with db._conn() as con:
        con.execute(
            "UPDATE messages SET content=?, edited=1 WHERE id=?",
            (new_content, int(ft_msg_id)),
        )
        con.commit()

    from ws_manager import manager
    await manager.broadcast_room(body.room_name, {
        "type": "edit", "id": int(ft_msg_id),
        "content": new_content, "room": body.room_name,
    })

    # Cross-platform mirror: an edit on one bridge should also update the
    # mirror on the other bridge for the same room (skipping the source).
    try:
        import asyncio as _asyncio
        loop = _asyncio.get_running_loop()
        if platform != "telegram":
            try:
                import bridge_telegram as btg
                loop.create_task(btg.forward_edit_to_telegram(
                    body.room_name, int(ft_msg_id), new_content,
                ))
            except Exception:
                pass
        if platform != "discord":
            try:
                import bridge_discord as bdc
                loop.create_task(bdc.forward_edit_to_discord(
                    body.room_name, int(ft_msg_id), new_content,
                ))
            except Exception:
                pass
    except Exception:
        pass

    return {"ok": True, "id": int(ft_msg_id)}
