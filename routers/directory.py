"""Public channel directory routes."""
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from slowapi import Limiter
from typing import Optional, List
import json

import database as db
from deps import get_current_user, client_ip

limiter = Limiter(key_func=client_ip)
router = APIRouter(prefix="/directory", tags=["directory"])


CHANNEL_CATEGORIES = [
    "gaming",
    "music", 
    "art",
    "tech",
    "social",
    "education",
    "memes",
    "crypto",
    "sports",
    "other"
]


@router.get("/channels")
async def browse_public_channels(
    category: Optional[str] = Query(None),
    q: Optional[str] = Query(None, alias="search"),
    limit: int = Query(50, le=100),
    offset: int = Query(0)
):
    """Browse public channels in the directory."""
    channels = db.get_public_channels(category, q, limit, offset)
    return {
        "channels": channels,
        "categories": CHANNEL_CATEGORIES
    }


@router.get("/channels/search")
@limiter.limit("120/hour")
async def search_public_channels(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, le=50)
):
    """Search public channels by name/description."""
    channels = db.get_public_channels(search=q, limit=limit)
    return {"channels": channels, "query": q}


@router.get("/categories")
async def get_categories():
    """Get available channel categories."""
    return {"categories": CHANNEL_CATEGORIES}


class UpdateChannelVisibilityRequest(BaseModel):
    is_public: bool
    category: str = ""
    directory_description: str = ""
    tags: List[str] = []


@router.patch("/channels/{room_name}/visibility")
async def update_channel_visibility(
    room_name: str,
    body: UpdateChannelVisibilityRequest,
    current_user: dict = Depends(get_current_user)
):
    """Set channel public/private status (owner only)."""
    room = db.get_room(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    
    if room["owner_id"] != current_user["id"] and not current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Only the owner can change visibility"})
    
    if body.category and body.category not in CHANNEL_CATEGORIES:
        return JSONResponse(status_code=400, content={"error": f"Invalid category. Choose from: {', '.join(CHANNEL_CATEGORIES)}"})
    
    tags_json = json.dumps(body.tags[:10])  # max 10 tags
    dir_desc = body.directory_description[:2000] if body.directory_description else ""
    
    if db.set_room_public(room_name, 1 if body.is_public else 0, body.category, dir_desc, tags_json):
        return {"ok": True, "is_public": body.is_public, "category": body.category}
    return JSONResponse(status_code=500, content={"error": "Failed to update"})


@router.get("/featured")
async def get_featured_channels():
    """Get featured/popular public channels."""
    channels = db.get_public_channels(limit=10)
    return {"featured": channels}


@router.get("/suggested")
async def get_suggested_channels(current_user: dict = Depends(get_current_user)):
    """Get suggested public channels the user hasn't joined."""
    channels = db.get_suggested_channels(current_user["id"])
    return {"channels": channels}


@router.get("/users/search")
@limiter.limit("120/hour")
async def search_users_directory(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, le=50),
    current_user: dict = Depends(get_current_user)
):
    """Search users by nickname."""
    users = db.search_users(q, limit, current_user["id"])
    return {"users": users, "query": q}


@router.get("/channels/{room_name}/profile")
async def channel_profile(room_name: str, current_user: dict = Depends(get_current_user)):
    """Get full channel profile for directory listing."""
    room = db.get_room(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    owner = db.get_user_by_id(room["owner_id"])
    tags = []
    try:
        tags = json.loads(room.get("tags") or "[]")
    except Exception:
        pass
    return {
        "name": room["name"],
        "description": room.get("description", ""),
        "directory_description": room.get("directory_description", ""),
        "about": room.get("about", ""),
        "banner": room.get("banner", ""),
        "icon": room.get("icon"),
        "category": room.get("category", ""),
        "tags": tags,
        "member_count": room.get("member_count", 0),
        "channel_type": room.get("channel_type", "text"),
        "is_public": bool(room.get("is_public")),
        "created_at": room.get("created_at"),
        "owner_name": owner["nickname"] if owner else None,
        "owner_avatar": owner.get("avatar") if owner else None,
        "is_owner": room["owner_id"] == current_user["id"],
        "like_count": db.get_channel_like_count(room["id"]),
        "liked_by_me": db.user_liked_channel(room["id"], current_user["id"]),
        "recent_comments": db.get_channel_comments(
            room["id"], limit=10, offset=0, viewer_id=current_user["id"]
        ),
    }


# ── Likes ────────────────────────────────────────────────────────────────

@router.post("/channels/{room_name}/like")
async def like_channel_endpoint(room_name: str, current_user: dict = Depends(get_current_user)):
    room = db.get_room(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    db.like_channel(room["id"], current_user["id"])
    return {"ok": True, "like_count": db.get_channel_like_count(room["id"]), "liked": True}


@router.delete("/channels/{room_name}/like")
async def unlike_channel_endpoint(room_name: str, current_user: dict = Depends(get_current_user)):
    room = db.get_room(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    db.unlike_channel(room["id"], current_user["id"])
    return {"ok": True, "like_count": db.get_channel_like_count(room["id"]), "liked": False}


# ── Comments ─────────────────────────────────────────────────────────────

class ChannelCommentRequest(BaseModel):
    content: str


@router.get("/channels/{room_name}/comments")
async def list_channel_comments(
    room_name: str,
    limit: int = Query(50, le=100),
    offset: int = Query(0),
    current_user: dict = Depends(get_current_user)
):
    room = db.get_room(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    return {"comments": db.get_channel_comments(
        room["id"], limit, offset, viewer_id=current_user["id"]
    )}


@router.post("/channels/{room_name}/comments")
async def post_channel_comment(
    room_name: str,
    body: ChannelCommentRequest,
    current_user: dict = Depends(get_current_user)
):
    room = db.get_room(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    content = (body.content or "").strip()
    if not content:
        return JSONResponse(status_code=400, content={"error": "Comment cannot be empty"})
    cid = db.add_channel_comment(room["id"], current_user["id"], content)
    if not cid:
        return JSONResponse(status_code=500, content={"error": "Failed to add comment"})
    return {"ok": True, "id": cid}


@router.delete("/channels/{room_name}/comments/{comment_id}")
async def delete_channel_comment_endpoint(
    room_name: str,
    comment_id: int,
    current_user: dict = Depends(get_current_user)
):
    ok = db.delete_channel_comment(comment_id, current_user["id"], bool(current_user.get("is_admin")))
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    return {"ok": True}


class CommentVoteRequest(BaseModel):
    value: int


@router.post("/channels/{room_name}/comments/{comment_id}/vote")
@limiter.limit("60/minute")
async def vote_channel_comment(
    request: Request,
    room_name: str,
    comment_id: int,
    body: CommentVoteRequest,
    current_user: dict = Depends(get_current_user)
):
    """YouTube-style 👍/👎 on a channel directory comment.

    body.value is -1, 0 (clear), or 1. Idempotent.
    Returns updated counts and the caller's vote state.
    """
    if body.value not in (-1, 0, 1):
        return JSONResponse(status_code=400, content={"error": "Invalid vote value"})
    room = db.get_room(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    # Authoritative read access (covers invite-only channels + bans)
    if not db.user_can_access_room(
        current_user["id"], room_name, is_admin=bool(current_user.get("is_admin"))
    ):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    comment = db.get_channel_comment(comment_id)
    # Cross-check the comment belongs to this room (anti-IDOR).
    if not comment or int(comment.get("room_id") or 0) != int(room["id"]):
        return JSONResponse(status_code=404, content={"error": "Comment not found"})
    res = db.set_comment_vote(
        "channel_comment", comment_id, current_user["id"], body.value
    )
    return {
        "ok": True,
        "like_count": res["up"],
        "dislike_count": res["down"],
        "my_vote": res["my_vote"],
    }


class UpdateChannelListingRequest(BaseModel):
    directory_description: str = ""
    category: str = ""
    tags: List[str] = []


@router.put("/channels/{room_name}/listing")
async def update_channel_listing(
    room_name: str,
    body: UpdateChannelListingRequest,
    current_user: dict = Depends(get_current_user)
):
    """Update channel directory listing / ad (owner only)."""
    room = db.get_room(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    if room["owner_id"] != current_user["id"] and not current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Only the owner can edit the listing"})
    if body.category and body.category not in CHANNEL_CATEGORIES:
        return JSONResponse(status_code=400, content={"error": f"Invalid category"})
    tags_json = json.dumps(body.tags[:10])
    dir_desc = body.directory_description[:2000] if body.directory_description else ""
    is_public = 1 if room.get("is_public") else 0
    if db.set_room_public(room_name, is_public, body.category, dir_desc, tags_json):
        return {"ok": True}
    return JSONResponse(status_code=500, content={"error": "Failed to update"})


@router.get("/suggest")
async def suggest_channels(
    q: str = Query(..., min_length=1),
    limit: int = Query(8, le=20)
):
    """Auto-suggest channels as user types (lightweight)."""
    channels = db.get_public_channels(search=q, limit=limit)
    return {"suggestions": [{"name": c["name"], "icon": c.get("icon"), "category": c.get("category"), "member_count": c.get("member_count", 0)} for c in channels]}


@router.get("/new")
async def get_new_channels(limit: int = Query(10, le=30)):
    """Get newest public channels for explore."""
    channels = db.get_new_public_channels(limit)
    return {"channels": channels}
