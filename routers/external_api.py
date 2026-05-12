"""
External API for bots and developers.
Requires API key authentication. Rate limited per key.
"""
import hashlib
from functools import wraps
from typing import Optional, List
from datetime import datetime, timedelta

from fastapi import APIRouter, Header, HTTPException, Request, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

import database as db

router = APIRouter(prefix="/external", tags=["external-api"])

# Rate limit by API key
def get_api_key_identifier(request: Request):
    """Extract API key for rate limiting."""
    key = request.headers.get("X-API-Key", request.headers.get("Authorization", ""))
    if key.startswith("Bearer "):
        key = key[7:]
    return f"api:{hashlib.sha256(key.encode()).hexdigest()[:16]}" if key else get_remote_address(request)

limiter = Limiter(key_func=get_api_key_identifier)


def hash_key(key: str) -> str:
    """Hash API key for lookup."""
    return hashlib.sha256(key.encode()).hexdigest()


def require_api_key(permissions: List[str] = None):
    """Dependency for API key authentication."""
    async def validator(
        request: Request,
        x_api_key: str = Header(None, alias="X-API-Key"),
        authorization: str = Header(None),
    ):
        # Extract key from either header
        api_key = x_api_key
        if not api_key and authorization:
            if authorization.startswith("Bearer "):
                api_key = authorization[7:]
            else:
                api_key = authorization
        
        if not api_key:
            raise HTTPException(
                status_code=401,
                detail="API key required. Use X-API-Key header or Authorization: Bearer <key>"
            )
        
        # Validate key format
        if not api_key.startswith(("frog_", "bot_")):
            raise HTTPException(
                status_code=401,
                detail="Invalid API key format"
            )
        
        # Look up key
        key_hash = hash_key(api_key)
        key_info = db.get_api_key_by_hash(key_hash)
        
        if not key_info:
            raise HTTPException(status_code=401, detail="Invalid API key")
        
        # Check permissions. Only "admin" acts as a wildcard. Bot keys
        # are issued with an explicit permission list (read/write/dm/bot)
        # at creation time, so treating "bot" as a wildcard would mean
        # any compromised bot key could call admin-tagged routes too.
        if permissions:
            key_perms = key_info.get("permissions", [])
            if isinstance(key_perms, str):
                import json
                key_perms = json.loads(key_perms)

            wildcards = {"admin"}
            has_wildcard = any(w in key_perms for w in wildcards)

            if not has_wildcard:
                for p in permissions:
                    if p not in key_perms:
                        raise HTTPException(
                            status_code=403,
                            detail=f"Missing permission: {p}"
                        )
        
        # Update last_used
        db.update_api_key_last_used(key_info["id"])
        
        # Get owner info
        owner = db.get_user_by_id(key_info["user_id"])
        
        return {
            "key": key_info,
            "owner": owner,
            "is_bot": api_key.startswith("bot_"),
        }
    
    return validator


# ---------------------------------------------------------------------------
# API Documentation
# ---------------------------------------------------------------------------

@router.get("/docs")
async def api_documentation():
    """Get API documentation."""
    return {
        "name": "FrogTalk External API",
        "version": "1.0",
        "base_url": "https://frogtalk.xyz/api/external",
        "authentication": {
            "type": "API Key",
            "header": "X-API-Key",
            "alternative": "Authorization: Bearer <key>",
            "obtain": "Create keys at Settings > Developer > API Keys"
        },
        "rate_limits": {
            "default": "60 requests/minute",
            "messages": "30 messages/minute",
            "media": "10 uploads/minute"
        },
        "endpoints": {
            "GET /me": "Get authenticated user/bot info",
            "GET /channels": "List accessible channels",
            "GET /channels/{name}/messages": "Get channel messages",
            "POST /channels/{name}/messages": "Send message to channel",
            "GET /users/{id}": "Get user info",
            "POST /dms/{user_id}": "Send DM (bots only with permission)",
            "GET /health": "API health check"
        }
    }


# ---------------------------------------------------------------------------
# Health Check (no auth required)
# ---------------------------------------------------------------------------

@router.get("/health")
@limiter.limit("120/minute")
async def health_check(request: Request):
    """Check API health - no authentication required."""
    return {
        "status": "healthy",
        "service": "FrogTalk API",
        "timestamp": datetime.utcnow().isoformat()
    }


# ---------------------------------------------------------------------------
# Authenticated Endpoints
# ---------------------------------------------------------------------------

@router.get("/me")
@limiter.limit("60/minute")
async def get_me(
    request: Request,
    auth: dict = Depends(require_api_key())
):
    """Get info about authenticated key/user."""
    owner = auth["owner"]
    return {
        "authenticated": True,
        "key_name": auth["key"]["name"],
        "is_bot": auth["is_bot"],
        "user": {
            "id": owner["id"],
            "nickname": owner["nickname"],
            "avatar": owner["avatar"],
        },
        "permissions": auth["key"]["permissions"],
        "created_at": auth["key"]["created_at"],
    }


# ---------------------------------------------------------------------------
# Channels
# ---------------------------------------------------------------------------

@router.get("/channels")
@limiter.limit("60/minute")
async def list_channels(
    request: Request,
    auth: dict = Depends(require_api_key(["read"]))
):
    """List all public channels + channels user is member of."""
    rooms = db.get_all_rooms()
    return {
        "channels": [
            {
                "name": r["name"],
                "description": r.get("description", ""),
                "icon": r.get("icon", "💬"),
                "is_public": bool(r.get("is_public", 0)),
                "category": r.get("category", "other"),
                "member_count": r.get("member_count", 0),
            }
            for r in rooms
        ]
    }


class SendMessageRequest(BaseModel):
    content: str
    reply_to: Optional[int] = None


@router.get("/channels/{name}/messages")
@limiter.limit("60/minute")
async def get_channel_messages(
    request: Request,
    name: str,
    limit: int = 50,
    before: Optional[int] = None,
    auth: dict = Depends(require_api_key(["read"]))
):
    """Get messages from a channel."""
    room = db.get_room(name)
    if not room:
        raise HTTPException(status_code=404, detail="Channel not found")

    # NOTE: room lookup keys are the room *name*, not id. db.get_messages
    # already left-joins the bots table so is_bot/bot_id come through
    # for free.
    messages = db.get_messages(name, limit=min(limit, 100), before_id=before)

    return {
        "channel": name,
        "messages": [
            {
                "id": m["id"],
                "content": m.get("content"),
                "nickname": m["nickname"],
                "user_id": m["user_id"],
                "avatar": m.get("avatar"),
                "display_name": m.get("display_name"),
                "is_admin": bool(m.get("is_admin")),
                "is_bot": bool(m.get("is_bot")),
                "bot_id": m.get("bot_id"),
                "reply_to": m.get("reply_to"),
                "reply_nickname": m.get("reply_nickname"),
                "reply_content": m.get("reply_content"),
                "created_at": m["created_at"],
                "edited": bool(m.get("edited")),
                "reactions": m.get("reactions"),
            }
            for m in messages
        ]
    }


@router.post("/channels/{name}/messages")
@limiter.limit("30/minute")
async def send_channel_message(
    request: Request,
    name: str,
    body: SendMessageRequest,
    auth: dict = Depends(require_api_key(["write"]))
):
    """Send a message to a channel.

    For bot keys this stores the message with the bot's display name as
    the nickname and broadcasts it with `is_bot:true` + `bot_id` so the
    client renders the BOT pill next to the author. The owning user's
    id is still on the row for FK integrity (same pattern the bridge
    routers use for cross-platform attribution)."""
    room = db.get_room(name)
    if not room:
        raise HTTPException(status_code=404, detail="Channel not found")

    if len(body.content) > 4000:
        raise HTTPException(status_code=400, detail="Message too long (max 4000)")

    if len(body.content.strip()) == 0:
        raise HTTPException(status_code=400, detail="Empty message")

    owner = auth["owner"]
    bot = db.get_bot_by_api_key_id(auth["key"]["id"]) if auth["is_bot"] else None

    # Per-node bot ban: refuse messages from bots an admin has banned
    # on this node. Returned as 403 so the bot author sees a clear
    # signal rather than a silent drop.
    if bot and db.is_bot_banned(int(bot["id"])):
        raise HTTPException(status_code=403, detail="Bot is banned on this server")

    # Bot must be an explicit member of the channel before it can post.
    # Channels have an opt-in install flow (`add_bot_to_channel`); this
    # prevents a bot key with the global `write` permission from spraying
    # messages into rooms its owner never installed it into.
    if bot and not db.bot_in_channel(int(bot["id"]), int(room["id"])):
        raise HTTPException(status_code=403, detail="Bot is not a member of this channel")

    nickname = bot["name"] if bot else owner["nickname"]
    avatar = (bot.get("avatar") if bot else None) or owner.get("avatar")
    display_name = bot["name"] if bot else owner.get("display_name")

    msg_id = db.save_message(
        room_name=name,
        user_id=owner["id"],
        nickname=nickname,
        content=body.content,
        reply_to=body.reply_to,
    )

    # Hydrate reply context for the broadcast payload so clients can
    # render the quoted snippet immediately without a refetch.
    reply_nickname = None
    reply_content = None
    if body.reply_to:
        rrow = db.get_message(body.reply_to)
        if rrow:
            reply_nickname = rrow.get("nickname")
            reply_content = (rrow.get("content") or "")[:120]

    payload = {
        "type": "message",
        "id": msg_id,
        "room": name,
        "nickname": nickname,
        "user_id": owner["id"],
        "avatar": avatar,
        "display_name": display_name,
        "is_admin": False,
        "is_bot": bool(bot),
        "bot_id": bot["id"] if bot else None,
        "content": body.content,
        "media_data": None,
        "media_type": None,
        "media_blur": 0,
        "view_once": 0,
        "reply_to": body.reply_to,
        "reply_nickname": reply_nickname,
        "reply_content": reply_content,
        "edited": False,
        "reactions": {},
        "created_at": datetime.utcnow().isoformat() + "Z",
    }

    from ws_manager import manager
    import asyncio
    asyncio.create_task(manager.broadcast_room(name, payload))

    return {
        "ok": True,
        "message_id": msg_id,
        "channel": name,
        "is_bot": bool(bot),
    }


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

@router.get("/users/{user_id}")
@limiter.limit("60/minute")
async def get_user(
    request: Request,
    user_id: int,
    auth: dict = Depends(require_api_key(["read"]))
):
    """Get public user information."""
    user = db.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    return {
        "id": user["id"],
        "nickname": user["nickname"],
        "avatar": user.get("avatar"),
        "bio": user.get("bio", ""),
        "status": user.get("status", "online"),
        "mood": user.get("mood"),
        "created_at": user.get("created_at"),
    }


# ---------------------------------------------------------------------------
# DMs (restricted)
# ---------------------------------------------------------------------------

class SendDMRequest(BaseModel):
    content: str


@router.post("/dms/{user_id}")
@limiter.limit("20/minute")
async def send_dm(
    request: Request,
    user_id: int,
    body: SendDMRequest,
    auth: dict = Depends(require_api_key(["write", "dm"]))
):
    """Send a DM to a user. Requires 'dm' permission."""
    target = db.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    owner = auth["owner"]

    if len(body.content) > 4000:
        raise HTTPException(status_code=400, detail="Message too long")

    # Resolve or create the 1-on-1 DM channel. db returns the channel
    # id directly (not a row), so we pass it straight into send.
    channel_id = db.get_or_create_dm(owner["id"], user_id)

    msg_id = db.send_dm_message(
        channel_id=channel_id,
        sender_id=owner["id"],
        content=body.content,
    )

    return {
        "ok": True,
        "message_id": msg_id,
        "dm_channel": channel_id,
    }


# ---------------------------------------------------------------------------
# Webhooks (future)
# ---------------------------------------------------------------------------

class WebhookConfig(BaseModel):
    url: str
    events: List[str]  # ["message", "join", "leave"]
    channel: Optional[str] = None


@router.post("/webhooks")
@limiter.limit("10/minute")
async def create_webhook(
    request: Request,
    body: WebhookConfig,
    auth: dict = Depends(require_api_key(["admin"]))
):
    """Create a webhook (requires admin permission).

    Storage + delivery not yet implemented; intentionally returns 501 so
    callers see a stable contract instead of a silent success.
    """
    return JSONResponse(
        status_code=501,
        content={"error": "Webhooks not yet implemented"}
    )
