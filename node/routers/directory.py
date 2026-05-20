"""Public channel directory routes."""
import json
import re
from typing import Optional, List

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from slowapi import Limiter

import database as db
from deps import get_current_user, client_ip
from routers.rooms import (
    ROOM_NAME_RE,
    _sanitize_room_text,
    _normalize_room_icon,
    _normalize_room_banner,
)

limiter = Limiter(key_func=client_ip)
router = APIRouter(prefix="/directory", tags=["directory"])

CHANNEL_CATEGORIES = (
    "gaming",
    "music",
    "art",
    "tech",
    "social",
    "education",
    "memes",
    "crypto",
    "sports",
    "other",
)
_CHANNEL_CATEGORIES_SET = frozenset(CHANNEL_CATEGORIES)
_MAX_DIRECTORY_OFFSET = 5000
_LIKE_WILDCARD_RE = re.compile(r"[%_\\]")


def _validate_room_name(room_name: str) -> Optional[str]:
    name = str(room_name or "").strip().lower()
    if not ROOM_NAME_RE.match(name):
        return None
    return name


def _normalize_directory_search(q: Optional[str]) -> Optional[str]:
    if q is None:
        return None
    clean = _sanitize_room_text(q, max_len=80, multiline=False)
    if not clean:
        return None
    clean = _LIKE_WILDCARD_RE.sub("", clean)
    return clean or None


def _normalize_directory_category(category: Optional[str]) -> Optional[str]:
    if not category:
        return None
    cat = str(category).strip().lower()
    return cat if cat in _CHANNEL_CATEGORIES_SET else None


def _safe_directory_icon(icon) -> Optional[str]:
    if icon is None:
        return None
    try:
        return _normalize_room_icon(icon)
    except ValueError:
        return None


def _safe_directory_banner(banner) -> str:
    if not banner:
        return ""
    try:
        return _normalize_room_banner(banner) or ""
    except ValueError:
        return ""


def _sanitize_public_channel_row(row: dict) -> dict:
    """Sanitize media URLs before they reach browsers."""
    out = dict(row)
    out["icon"] = _safe_directory_icon(out.get("icon"))
    owner_avatar = out.get("owner_avatar")
    if owner_avatar:
        try:
            # Reuse icon rules for avatar URLs (http(s) / path / small data URLs).
            out["owner_avatar"] = _normalize_room_icon(str(owner_avatar))
        except ValueError:
            out["owner_avatar"] = None
    return out


def _directory_visible_room(room_name: str, user_id: int, *, is_admin: bool) -> Optional[dict]:
    """Return room row when the user may view it in directory/profile surfaces."""
    room = db.get_room(room_name)
    if not room:
        return None
    if room.get("is_public") and (room.get("type") or "public") == "public":
        return room
    if db.user_can_access_room(user_id, room_name, is_admin=is_admin):
        return room
    return None


def _require_directory_room(room_name: str, current_user: dict) -> dict | JSONResponse:
    name = _validate_room_name(room_name)
    if not name:
        return JSONResponse(status_code=400, content={"error": "Invalid channel name"})
    room = _directory_visible_room(
        name,
        int(current_user["id"]),
        is_admin=bool(current_user.get("is_admin")),
    )
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    return room


def _sanitize_directory_tags(tags: List[str]) -> List[str]:
    clean: List[str] = []
    seen = set()
    for t in tags or []:
        v = _sanitize_room_text(str(t or ""), max_len=24, multiline=False).lower()
        if not v:
            continue
        if not all(ch.isalnum() or ch in {"-", "_"} for ch in v):
            continue
        if v in seen:
            continue
        seen.add(v)
        clean.append(v)
        if len(clean) >= 10:
            break
    return clean


@router.get("/channels")
async def browse_public_channels(
    category: Optional[str] = Query(None),
    q: Optional[str] = Query(None, alias="search"),
    limit: int = Query(50, le=100),
    offset: int = Query(0, ge=0, le=_MAX_DIRECTORY_OFFSET),
):
    """Browse public channels in the directory."""
    clean_cat = _normalize_directory_category(category)
    if category and not clean_cat:
        return JSONResponse(status_code=400, content={"error": "Invalid category"})
    search = _normalize_directory_search(q)
    channels = [
        _sanitize_public_channel_row(row)
        for row in db.get_public_channels(clean_cat, search, limit, offset)
    ]
    return {
        "channels": channels,
        "categories": list(CHANNEL_CATEGORIES),
    }


@router.get("/channels/search")
@limiter.limit("120/hour")
async def search_public_channels(
    request: Request,
    q: str = Query(..., min_length=1, max_length=80),
    limit: int = Query(20, le=50),
):
    """Search public channels by name/description."""
    search = _normalize_directory_search(q)
    if not search:
        return JSONResponse(status_code=400, content={"error": "Invalid search query"})
    channels = [
        _sanitize_public_channel_row(row)
        for row in db.get_public_channels(search=search, limit=limit)
    ]
    return {"channels": channels, "query": search}


@router.get("/categories")
async def get_categories():
    """Get available channel categories."""
    return {"categories": list(CHANNEL_CATEGORIES)}


class UpdateChannelVisibilityRequest(BaseModel):
    is_public: bool
    category: str = ""
    directory_description: str = ""
    tags: List[str] = Field(default_factory=list, max_length=10)


@router.patch("/channels/{room_name}/visibility")
async def update_channel_visibility(
    room_name: str,
    body: UpdateChannelVisibilityRequest,
    current_user: dict = Depends(get_current_user),
):
    """Set channel public/private status (owner only)."""
    name = _validate_room_name(room_name)
    if not name:
        return JSONResponse(status_code=400, content={"error": "Invalid channel name"})
    room = db.get_room(name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})

    if room["owner_id"] != current_user["id"] and not current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Only the owner can change visibility"})

    if room.get("type") == "private" and body.is_public:
        return JSONResponse(
            status_code=400,
            content={"error": "Private channels cannot be listed in directory. Change the channel to public first."},
        )

    clean_cat = _normalize_directory_category(body.category) if body.category else ""
    if body.category and not clean_cat:
        return JSONResponse(
            status_code=400,
            content={"error": f"Invalid category. Choose from: {', '.join(CHANNEL_CATEGORIES)}"},
        )

    clean_tags = _sanitize_directory_tags(body.tags)
    tags_json = json.dumps(clean_tags)
    dir_desc = _sanitize_room_text(body.directory_description, max_len=1200, multiline=True)

    if db.set_room_public(name, 1 if body.is_public else 0, clean_cat, dir_desc, tags_json):
        return {"ok": True, "is_public": body.is_public, "category": clean_cat}
    return JSONResponse(status_code=500, content={"error": "Failed to update"})


@router.get("/featured")
async def get_featured_channels():
    """Get featured/popular public channels."""
    channels = [_sanitize_public_channel_row(row) for row in db.get_public_channels(limit=10)]
    return {"featured": channels}


@router.get("/suggested")
async def get_suggested_channels(current_user: dict = Depends(get_current_user)):
    """Get suggested public channels the user hasn't joined."""
    channels = [
        _sanitize_public_channel_row(row)
        for row in db.get_suggested_channels(current_user["id"])
    ]
    return {"channels": channels}


@router.get("/users/search")
@limiter.limit("120/hour")
async def search_users_directory(
    request: Request,
    q: str = Query(..., min_length=1, max_length=64),
    limit: int = Query(20, le=50),
    current_user: dict = Depends(get_current_user),
):
    """Search users by nickname."""
    clean_q = _sanitize_room_text(q, max_len=64, multiline=False)
    if not clean_q:
        return JSONResponse(status_code=400, content={"error": "Invalid search query"})
    users = db.search_users(clean_q, limit, current_user["id"])
    return {"users": users, "query": clean_q}


@router.get("/channels/{room_name}/profile")
async def channel_profile(room_name: str, current_user: dict = Depends(get_current_user)):
    """Get full channel profile for directory listing."""
    room_or_resp = _require_directory_room(room_name, current_user)
    if isinstance(room_or_resp, JSONResponse):
        return room_or_resp
    room = room_or_resp
    owner = db.get_user_by_id(room["owner_id"])
    tags = []
    try:
        tags = json.loads(room.get("tags") or "[]")
    except Exception:
        tags = []
    if not isinstance(tags, list):
        tags = []
    tags = _sanitize_directory_tags([str(t) for t in tags])
    return {
        "name": room["name"],
        "description": _sanitize_room_text(room.get("description", ""), max_len=256),
        "directory_description": _sanitize_room_text(
            room.get("directory_description", ""), max_len=1200, multiline=True
        ),
        "about": _sanitize_room_text(room.get("about", ""), max_len=2000, multiline=True),
        "banner": _safe_directory_banner(room.get("banner")),
        "icon": _safe_directory_icon(room.get("icon")),
        "category": _normalize_directory_category(room.get("category")) or "",
        "tags": tags,
        "member_count": room.get("member_count", 0),
        "channel_type": room.get("channel_type", "text"),
        "is_public": bool(room.get("is_public")),
        "created_at": room.get("created_at"),
        "owner_name": owner["nickname"] if owner else None,
        "owner_avatar": _safe_directory_icon(owner.get("avatar") if owner else None),
        "is_owner": (room["owner_id"] == current_user["id"]) or bool(current_user.get("is_admin")),
        "like_count": db.get_channel_like_count(room["id"]),
        "liked_by_me": db.user_liked_channel(room["id"], current_user["id"]),
        "recent_comments": db.get_channel_comments(
            room["id"], limit=10, offset=0, viewer_id=current_user["id"]
        ),
    }


@router.post("/channels/{room_name}/like")
async def like_channel_endpoint(room_name: str, current_user: dict = Depends(get_current_user)):
    room_or_resp = _require_directory_room(room_name, current_user)
    if isinstance(room_or_resp, JSONResponse):
        return room_or_resp
    room = room_or_resp
    db.like_channel(room["id"], current_user["id"])
    return {"ok": True, "like_count": db.get_channel_like_count(room["id"]), "liked": True}


@router.delete("/channels/{room_name}/like")
async def unlike_channel_endpoint(room_name: str, current_user: dict = Depends(get_current_user)):
    room_or_resp = _require_directory_room(room_name, current_user)
    if isinstance(room_or_resp, JSONResponse):
        return room_or_resp
    room = room_or_resp
    db.unlike_channel(room["id"], current_user["id"])
    return {"ok": True, "like_count": db.get_channel_like_count(room["id"]), "liked": False}


class ChannelCommentRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=2000)


@router.get("/channels/{room_name}/comments")
async def list_channel_comments(
    room_name: str,
    limit: int = Query(50, le=100),
    offset: int = Query(0, ge=0, le=1000),
    current_user: dict = Depends(get_current_user),
):
    room_or_resp = _require_directory_room(room_name, current_user)
    if isinstance(room_or_resp, JSONResponse):
        return room_or_resp
    room = room_or_resp
    return {"comments": db.get_channel_comments(
        room["id"], limit, offset, viewer_id=current_user["id"]
    )}


@router.post("/channels/{room_name}/comments")
async def post_channel_comment(
    room_name: str,
    body: ChannelCommentRequest,
    current_user: dict = Depends(get_current_user),
):
    room_or_resp = _require_directory_room(room_name, current_user)
    if isinstance(room_or_resp, JSONResponse):
        return room_or_resp
    room = room_or_resp
    content = _sanitize_room_text(body.content, max_len=2000, multiline=True)
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
    current_user: dict = Depends(get_current_user),
):
    room_or_resp = _require_directory_room(room_name, current_user)
    if isinstance(room_or_resp, JSONResponse):
        return room_or_resp
    room = room_or_resp
    comment = db.get_channel_comment(comment_id)
    if not comment or int(comment.get("room_id") or 0) != int(room["id"]):
        return JSONResponse(status_code=404, content={"error": "Comment not found"})
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
    current_user: dict = Depends(get_current_user),
):
    """YouTube-style 👍/👎 on a channel directory comment."""
    if body.value not in (-1, 0, 1):
        return JSONResponse(status_code=400, content={"error": "Invalid vote value"})
    room_or_resp = _require_directory_room(room_name, current_user)
    if isinstance(room_or_resp, JSONResponse):
        return room_or_resp
    room = room_or_resp
    comment = db.get_channel_comment(comment_id)
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
    tags: List[str] = Field(default_factory=list, max_length=10)


@router.put("/channels/{room_name}/listing")
async def update_channel_listing(
    room_name: str,
    body: UpdateChannelListingRequest,
    current_user: dict = Depends(get_current_user),
):
    """Update channel directory listing / ad (owner only)."""
    name = _validate_room_name(room_name)
    if not name:
        return JSONResponse(status_code=400, content={"error": "Invalid channel name"})
    room = db.get_room(name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    if room["owner_id"] != current_user["id"] and not current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Only the owner can edit the listing"})
    if room.get("type") == "private":
        return JSONResponse(
            status_code=400,
            content={"error": "Private channels cannot have a public directory listing."},
        )
    clean_cat = _normalize_directory_category(body.category) if body.category else ""
    if body.category and not clean_cat:
        return JSONResponse(status_code=400, content={"error": "Invalid category"})
    clean_tags = _sanitize_directory_tags(body.tags)
    tags_json = json.dumps(clean_tags)
    dir_desc = _sanitize_room_text(body.directory_description, max_len=1200, multiline=True)
    is_public = 1 if room.get("is_public") else 0
    if db.set_room_public(name, is_public, clean_cat, dir_desc, tags_json):
        return {"ok": True}
    return JSONResponse(status_code=500, content={"error": "Failed to update"})


@router.get("/suggest")
@limiter.limit("120/hour")
async def suggest_channels(
    request: Request,
    q: str = Query(..., min_length=1, max_length=80),
    limit: int = Query(8, le=20),
):
    """Auto-suggest channels as user types (lightweight)."""
    search = _normalize_directory_search(q)
    if not search:
        return JSONResponse(status_code=400, content={"error": "Invalid search query"})
    channels = db.get_public_channels(search=search, limit=limit)
    return {
        "suggestions": [
            {
                "name": c["name"],
                "icon": _safe_directory_icon(c.get("icon")),
                "category": _normalize_directory_category(c.get("category")) or "",
                "member_count": c.get("member_count", 0),
            }
            for c in channels
        ],
    }


@router.get("/new")
async def get_new_channels(limit: int = Query(10, le=30)):
    """Get newest public channels for explore."""
    channels = [_sanitize_public_channel_row(row) for row in db.get_new_public_channels(limit)]
    return {"channels": channels}
