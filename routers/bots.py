"""Bot & API key management routes."""
import secrets
import hashlib
import logging
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import List, Optional

import database as db
from deps import get_current_user

router = APIRouter(prefix="/developer", tags=["developer"])
_log = logging.getLogger("frogtalk.bots")


def _emit_bot_event(bot_id: int, action: str) -> None:
    """Federate public-bot catalog changes. Local-only bots and federated
    mirrors never re-emit (so we don't broadcast events back to the
    origin server and create a loop).

    action: 'upsert' | 'delete'.
    """
    try:
        from routers import federation as _fed
        bot = db.get_bot_by_id(bot_id)
        if not bot:
            return
        # Skip federated mirrors — they originated elsewhere.
        if bot.get("origin_server_id"):
            return
        if action == "upsert" and not bot.get("is_public"):
            return
        owner_nick = None
        try:
            row = db.get_user_by_id(int(bot.get("owner_id") or 0))
            if row:
                owner_nick = row.get("nickname")
        except Exception:
            owner_nick = None
        payload = {
            "bot_id": int(bot["id"]),
            "name": bot.get("name") or "",
            "avatar": bot.get("avatar") or "",
            "description": bot.get("description") or "",
            "is_public": int(bot.get("is_public") or 0),
            "owner_nickname": owner_nick or "",
        }
        _fed.enqueue_server_event(f"bot.{action}", payload)
    except Exception:
        _log.exception("bot federation emit failed (bot=%s action=%s)", bot_id, action)


def hash_key(key: str) -> str:
    """Hash an API key for storage."""
    return hashlib.sha256(key.encode()).hexdigest()


# ---------------------------------------------------------------------------
# API Keys
# ---------------------------------------------------------------------------

class CreateApiKeyRequest(BaseModel):
    name: str
    permissions: List[str] = ["read", "write"]


@router.post("/keys")
async def create_api_key(body: CreateApiKeyRequest, current_user: dict = Depends(get_current_user)):
    """Create a new API key."""
    if len(body.name) < 1 or len(body.name) > 64:
        return JSONResponse(status_code=400, content={"error": "Key name must be 1-64 characters"})
    
    # Generate secure key
    raw_key = f"frog_{secrets.token_urlsafe(32)}"
    key_hash = hash_key(raw_key)
    
    key_id = db.create_api_key(
        current_user["id"],
        body.name,
        key_hash,
        body.permissions
    )
    
    # Return raw key only once!
    return {
        "id": key_id,
        "key": raw_key,
        "name": body.name,
        "permissions": body.permissions,
        "message": "Save this key! It won't be shown again."
    }


@router.get("/keys")
async def list_api_keys(current_user: dict = Depends(get_current_user)):
    """List all API keys for the current user."""
    keys = db.get_user_api_keys(current_user["id"])
    return {"keys": keys}


@router.delete("/keys/{key_id}")
async def delete_api_key(key_id: int, current_user: dict = Depends(get_current_user)):
    """Revoke an API key."""
    if db.delete_api_key(key_id, current_user["id"]):
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Key not found"})


# ---------------------------------------------------------------------------
# Bots
# ---------------------------------------------------------------------------

class CreateBotRequest(BaseModel):
    name: str = Field(max_length=64)
    description: str = Field(default="", max_length=2_000)
    avatar: Optional[str] = Field(default=None, max_length=10_000_000)
    is_public: bool = False


class UpdateBotRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=64)
    description: Optional[str] = Field(default=None, max_length=2_000)
    avatar: Optional[str] = Field(default=None, max_length=10_000_000)
    is_public: Optional[bool] = None


@router.post("/bots")
async def create_bot(body: CreateBotRequest, current_user: dict = Depends(get_current_user)):
    """Create a new bot."""
    if len(body.name) < 2 or len(body.name) > 32:
        return JSONResponse(status_code=400, content={"error": "Bot name must be 2-32 characters"})
    
    # Create a dedicated API key for the bot
    raw_key = f"bot_{secrets.token_urlsafe(32)}"
    key_hash = hash_key(raw_key)
    # Bot keys get the full read/write/dm permission set in addition to
    # the "bot" tag so they can use every /api/external/* endpoint a
    # human developer key could (the "bot" tag lets server-side render
    # paths distinguish bot traffic). Without read+write here, the
    # require_api_key() gate at routers/external_api.py would reject
    # every bot call with a 403 Missing permission error.
    key_id = db.create_api_key(
        current_user["id"],
        f"Bot: {body.name}",
        key_hash,
        ["read", "write", "dm", "bot"]
    )
    
    bot_id = db.create_bot(
        owner_id=current_user["id"],
        name=body.name,
        api_key_id=key_id,
        avatar=body.avatar,
        description=body.description,
        is_public=1 if body.is_public else 0
    )
    
    if bot_id is None:
        # Clean up the API key
        db.delete_api_key(key_id, current_user["id"])
        return JSONResponse(status_code=409, content={"error": "Bot name already taken"})

    # If created public, immediately federate the catalog row so peer
    # nodes can list + install this bot in their channels.
    if body.is_public:
        _emit_bot_event(bot_id, "upsert")

    return {
        "id": bot_id,
        "name": body.name,
        "api_key": raw_key,
        "message": "Save the bot API key! It won't be shown again."
    }


@router.get("/bots")
async def list_bots(current_user: dict = Depends(get_current_user)):
    """List all bots owned by the current user."""
    bots = db.get_user_bots(current_user["id"])
    return {"bots": bots}


# NOTE: this MUST be declared before the `/bots/{bot_id}` route below,
# otherwise FastAPI greedily matches "public" against the int-typed
# {bot_id} and returns 422 — which is exactly the regression that left
# the Bot Directory showing "No bots match".
@router.get("/bots/public")
async def list_public_bots(current_user: dict = Depends(get_current_user)):
    """List all public bots — local + federated.

    Auth-gated so the directory isn't a free unauthenticated enumeration
    surface for scrapers. The federation `origin_server_id` is only
    revealed to admins; regular users see local+federated mixed without
    knowing which peer a bot originated on. Federated rows from peers
    that the local admin has blocked are filtered out here so a
    blocklist applied on this node hides their bots too — they're
    typically tied to the peer's identity (channel/board)."""
    bots = db.get_public_bots() or []
    blocked = set(db.get_blocked_peer_server_ids()) if hasattr(db, "get_blocked_peer_server_ids") else set()
    if blocked:
        bots = [b for b in bots if not b.get("origin_server_id") or b.get("origin_server_id") not in blocked]
    if not current_user.get("is_admin"):
        bots = [
            {k: v for k, v in b.items() if k != "origin_server_id"}
            for b in bots
        ]
    return {"bots": bots}


@router.get("/bots/{bot_id}")
async def get_bot(bot_id: int, current_user: dict = Depends(get_current_user)):
    """Get a single bot's details (must be the owner)."""
    bot = db.get_bot_by_id(bot_id)
    if not bot or bot["owner_id"] != current_user["id"]:
        return JSONResponse(status_code=404, content={"error": "Bot not found"})
    # Strip internal-only columns before returning.
    return {
        "id": bot["id"],
        "name": bot["name"],
        "avatar": bot.get("avatar"),
        "description": bot.get("description") or "",
        "is_public": bool(bot.get("is_public")),
        "created_at": bot.get("created_at"),
    }


@router.put("/bots/{bot_id}")
async def update_bot(bot_id: int, body: UpdateBotRequest, current_user: dict = Depends(get_current_user)):
    """Update a bot."""
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if "is_public" in updates:
        updates["is_public"] = 1 if updates["is_public"] else 0

    # Capture pre-state so we can pick the right federation action when
    # the public flag flips on or off in the same PUT.
    before = db.get_bot_by_id(bot_id) or {}
    was_public = int(before.get("is_public") or 0) == 1

    if db.update_bot(bot_id, current_user["id"], **updates):
        after = db.get_bot_by_id(bot_id) or {}
        is_public = int(after.get("is_public") or 0) == 1
        if is_public:
            _emit_bot_event(bot_id, "upsert")
        elif was_public and not is_public:
            # Was federated, now private — tell peers to drop the mirror.
            _emit_bot_event_raw("delete", before)
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Bot not found or not owned by you"})


def _emit_bot_event_raw(action: str, bot: dict) -> None:
    """Same as _emit_bot_event but works from an already-fetched bot row.
    Used when the row may no longer exist (e.g. just-deleted)."""
    try:
        if not bot:
            return
        if bot.get("origin_server_id"):
            return
        from routers import federation as _fed
        owner_nick = None
        try:
            row = db.get_user_by_id(int(bot.get("owner_id") or 0))
            if row:
                owner_nick = row.get("nickname")
        except Exception:
            owner_nick = None
        payload = {
            "bot_id": int(bot.get("id") or 0),
            "name": bot.get("name") or "",
            "avatar": bot.get("avatar") or "",
            "description": bot.get("description") or "",
            "is_public": int(bot.get("is_public") or 0),
            "owner_nickname": owner_nick or "",
        }
        _fed.enqueue_server_event(f"bot.{action}", payload)
    except Exception:
        _log.exception("bot federation emit (raw) failed bot=%s action=%s", bot.get("id"), action)


@router.delete("/bots/{bot_id}")
async def delete_bot(bot_id: int, current_user: dict = Depends(get_current_user)):
    """Delete a bot."""
    before = db.get_bot_by_id(bot_id) or {}
    if db.delete_bot(bot_id, current_user["id"]):
        # Only federate the takedown if it was public when it died.
        if int(before.get("is_public") or 0) == 1 and not before.get("origin_server_id"):
            _emit_bot_event_raw("delete", before)
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Bot not found"})


@router.post("/bots/{bot_id}/regenerate-key")
async def regenerate_bot_key(bot_id: int, current_user: dict = Depends(get_current_user)):
    """Rotate the API token attached to a bot.

    The previous token is invalidated immediately — any running
    integration using it will start getting 401s and must be restarted
    with the new token. We surface the new raw key exactly once so the
    user can copy it to their bot runtime; we only ever store the hash.
    """
    bot = db.get_bot_by_id(bot_id)
    if not bot or bot.get("owner_id") != current_user["id"]:
        return JSONResponse(status_code=404, content={"error": "Bot not found"})
    if bot.get("origin_server_id"):
        # Federated mirror rows have no local key; the owning node owns
        # the secret. Refuse rather than silently no-op.
        return JSONResponse(
            status_code=400,
            content={"error": "This bot is federated from another node; rotate the key on its home node."},
        )
    raw_key = f"bot_{secrets.token_urlsafe(32)}"
    new_key_id = db.rotate_bot_api_key(bot_id, current_user["id"], hash_key(raw_key))
    if new_key_id is None:
        return JSONResponse(status_code=500, content={"error": "Failed to rotate key"})
    return {
        "ok": True,
        "api_key": raw_key,
        "message": "Save the new bot token! The previous token has been revoked.",
    }


# ---------------------------------------------------------------------------
# Bot Channel Management
# ---------------------------------------------------------------------------

@router.post("/channels/{room_name}/bots/{bot_id}")
async def add_bot_to_channel(room_name: str, bot_id: int, current_user: dict = Depends(get_current_user)):
    """Add a bot to a channel (must be channel owner/mod)."""
    room = db.get_room(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    
    # Check if user is owner or mod
    is_owner = room["owner_id"] == current_user["id"]
    is_mod = db.is_room_moderator(room_name, current_user["id"])
    if not is_owner and not is_mod and not current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Not authorized"})
    
    bot = db.get_bot_by_id(bot_id)
    if not bot:
        return JSONResponse(status_code=404, content={"error": "Bot not found"})
    
    if db.add_bot_to_channel(bot_id, room["id"], current_user["id"]):
        return {"ok": True, "bot": bot["name"]}
    return JSONResponse(status_code=409, content={"error": "Bot already in channel"})


@router.delete("/channels/{room_name}/bots/{bot_id}")
async def remove_bot_from_channel(room_name: str, bot_id: int, current_user: dict = Depends(get_current_user)):
    """Remove a bot from a channel."""
    room = db.get_room(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    
    is_owner = room["owner_id"] == current_user["id"]
    is_mod = db.is_room_moderator(room_name, current_user["id"])
    if not is_owner and not is_mod and not current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Not authorized"})
    
    if db.remove_bot_from_channel(bot_id, room["id"]):
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Bot not in channel"})


@router.get("/channels/{room_name}/bots")
async def get_channel_bots(room_name: str, current_user: dict = Depends(get_current_user)):
    """Get all bots in a channel."""
    room = db.get_room(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    
    bots = db.get_channel_bots(room["id"])
    return {"bots": bots}


# (Public bot directory route is registered above, before `/bots/{bot_id}`,
# to avoid the int-coercion 422 trap.)
