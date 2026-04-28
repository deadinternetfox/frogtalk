"""Friends, tags, user search routes."""
import logging
import time
import uuid
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from typing import Optional

import database as db
from deps import get_current_user
from ws_manager import manager

_log = logging.getLogger(__name__)
limiter = Limiter(key_func=get_remote_address)
router = APIRouter(prefix="/friends", tags=["friends"])
users_router = APIRouter(prefix="/users", tags=["users_ext"])


def _friend_push(user_id: int, title: str, body: str):
    """Send push notification for friend events (silent fail)."""
    try:
        from routers.push import send_push
        send_push(user_id, title, body, "/app")
    except Exception:
        pass


def _emit_friend_event(event_type: str, payload: dict) -> None:
    try:
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": event_type,
            "payload": payload,
        })
    except Exception:
        pass


def _emit_profile_update(user_id: int) -> None:
    try:
        ident = db.get_user_by_id(user_id) or {}
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "user.profile.updated",
            "payload": {
                "global_user_id": ident.get("global_user_id") or "",
                "nickname": ident.get("nickname") or "",
                "avatar": ident.get("avatar") or "",
                "bio": ident.get("bio") or "",
                "status_msg": ident.get("status_msg") or "",
                "presence": ident.get("presence") or "online",
                "mood": ident.get("mood") or "",
                "identity_pubkey": ident.get("identity_pubkey") or "",
            },
        })
    except Exception:
        pass


# ── Friends ──────────────────────────────────────────────────────────────────

@users_router.get("/search")
async def search_users(q: str = "", current_user: dict = Depends(get_current_user)):
    if not q or len(q) < 1:
        return {"users": []}
    results = db.search_users(q, limit=20, requester_id=current_user["id"])
    return {"users": [
        {"id": u["id"], "nickname": u["nickname"], "avatar": u["avatar"],
         "presence": u.get("presence", "online"),
         "allow_friend_requests": bool(u.get("allow_friend_requests", 1))}
        for u in results if u["id"] != current_user["id"]
    ]}


@users_router.get("/profile/{nickname}")
async def get_profile(nickname: str, _: dict = Depends(get_current_user)):
    profile = db.get_user_profile(nickname)
    if not profile:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    return {k: v for k, v in profile.items() if k != "ecdh_pub_key"}


@users_router.get("/{user_id}/pubkey")
async def get_pubkey(user_id: int, _: dict = Depends(get_current_user)):
    key = db.get_pubkey(user_id)
    if key is None:
        return JSONResponse(status_code=404, content={"error": "No public key set"})
    return {"pub_key": key, "ecdh_pub_key": key}


@users_router.post("/pubkey")
async def set_pubkey(body: dict, current_user: dict = Depends(get_current_user)):
    key = str(body.get("pub_key") or body.get("ecdh_pub_key") or "")
    if not key:
        return JSONResponse(status_code=400, content={"error": "pub_key required"})
    db.set_ecdh_pub_key(current_user["id"], key)
    return {"ok": True}


# ── Tags ─────────────────────────────────────────────────────────────────────

class TagBody(BaseModel):
    tag: str


@users_router.get("/me/tags")
async def my_tags(current_user: dict = Depends(get_current_user)):
    return {"tags": db.get_tags(current_user["id"])}


@users_router.post("/me/tags")
async def add_tag(body: TagBody, current_user: dict = Depends(get_current_user)):
    tag = body.tag.strip().lower()[:32]
    if not tag:
        return JSONResponse(status_code=400, content={"error": "Empty tag"})
    tags = db.get_tags(current_user["id"])
    if len(tags) >= 10:
        return JSONResponse(status_code=400, content={"error": "Max 10 tags"})
    ok = db.add_tag(current_user["id"], tag)
    return {"ok": ok, "tags": db.get_tags(current_user["id"])}


@users_router.delete("/me/tags/{tag}")
async def remove_tag(tag: str, current_user: dict = Depends(get_current_user)):
    db.remove_tag(current_user["id"], tag)
    return {"tags": db.get_tags(current_user["id"])}


# ── Presence ─────────────────────────────────────────────────────────────────

class PresenceBody(BaseModel):
    presence: str  # online | away | dnd | invisible


@users_router.post("/me/presence")
async def set_presence(body: PresenceBody, current_user: dict = Depends(get_current_user)):
    db.update_presence(current_user["id"], body.presence)
    _emit_profile_update(current_user["id"])
    return {"ok": True}


# ── Friend requests ───────────────────────────────────────────────────────────

@router.post("/request/{nickname}")
@limiter.limit("60/hour")
async def send_request(request: Request, nickname: str, current_user: dict = Depends(get_current_user)):
    profile = db.get_user_profile(nickname)
    if not profile:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    result = db.send_friend_request(current_user["id"], profile["id"])
    if result == "self":
        return JSONResponse(status_code=400, content={"error": "Cannot add yourself"})
    if result == "blocked":
        return JSONResponse(status_code=403, content={"error": "Cannot send request"})
    if result == "already":
        return JSONResponse(status_code=409, content={"error": "Already sent or friends"})
    # Push notification to recipient as backup
    _friend_push(profile["id"], "\ud83d\udc65 Friend Request",
                 f"{current_user['nickname']} wants to be friends")
    _emit_friend_event("friend.requested", {
        "from_nickname": current_user["nickname"],
        "to_nickname": profile["nickname"],
    })
    return {"ok": True}


@router.post("/accept/{nickname}")
@limiter.limit("120/hour")
async def accept_request(request: Request, nickname: str, current_user: dict = Depends(get_current_user)):
    profile = db.get_user_profile(nickname)
    if not profile:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    ok = db.accept_friend_request(profile["id"], current_user["id"])
    if not ok:
        return JSONResponse(status_code=404, content={"error": "No pending request from that user"})
    # Push notification to requester as backup
    _friend_push(profile["id"], "\ud83d\udc65 Friend Accepted",
                 f"{current_user['nickname']} accepted your friend request")
    _emit_friend_event("friend.accepted", {
        "from_nickname": profile["nickname"],
        "to_nickname": current_user["nickname"],
    })
    return {"ok": True}


@router.post("/decline/{nickname}")
async def decline_request(nickname: str, current_user: dict = Depends(get_current_user)):
    profile = db.get_user_profile(nickname)
    if not profile:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    db.decline_friend_request(profile["id"], current_user["id"])
    return {"ok": True}


@router.delete("/{nickname}")
async def remove_friend(nickname: str, current_user: dict = Depends(get_current_user)):
    profile = db.get_user_profile(nickname)
    if not profile:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    db.remove_friend(current_user["id"], profile["id"])
    return {"ok": True}


@router.post("/block/{nickname}")
async def block_user(nickname: str, current_user: dict = Depends(get_current_user)):
    profile = db.get_user_profile(nickname)
    if not profile:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    db.block_user(current_user["id"], profile["id"])
    return {"ok": True}


@router.get("")
async def list_friends(current_user: dict = Depends(get_current_user)):
    friends = db.get_friends(current_user["id"])
    try:
        online_ids = {int(u.get("user_id")) for u in manager.online_users_snapshot() if u.get("user_id") is not None}
    except Exception:
        online_ids = set()

    # Presence in DB can remain stale after abrupt disconnects. Normalize to
    # offline when there is no live websocket session for that friend.
    for f in friends:
        try:
            fid = int(f.get("id"))
        except Exception:
            continue
        if fid not in online_ids:
            f["presence"] = "offline"

    return {
        "friends": friends,
        "requests_in": db.get_friend_requests_in(current_user["id"]),
        "requests_out": db.get_friend_requests_out(current_user["id"]),
    }
