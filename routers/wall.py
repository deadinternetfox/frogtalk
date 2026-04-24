"""Profile wall/posts routes - Facebook-style social features."""
from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

import database as db
from deps import get_current_user

router = APIRouter(prefix="/wall", tags=["wall"])

MAX_POST_CONTENT = 5000
MAX_MEDIA_BYTES = 10 * 1024 * 1024


class CreatePostRequest(BaseModel):
    content: str = ""
    media_data: Optional[str] = None
    media_type: Optional[str] = None
    # public | followers | friends | private (default: private — only me)
    privacy: str = "private"
    allow_comments: bool = True
    # Optional track metadata for music/* posts — surfaced on the FrogSocial
    # music card so the title renders instead of a generic "YouTube track".
    track_title: Optional[str] = None
    track_room: Optional[str] = None
    # Vibe tag for music shares ("chill", "hype", "focus", …). Purely
    # cosmetic on the card but also drives the mood filter chips on
    # the Music tab.
    track_mood: Optional[str] = None


class UpdatePostRequest(BaseModel):
    content: Optional[str] = None
    privacy: Optional[str] = None
    allow_comments: Optional[bool] = None


class AddCommentRequest(BaseModel):
    content: str


class AddReactionRequest(BaseModel):
    emoji: str


# ---------------------------------------------------------------------------
# Wall Posts
# ---------------------------------------------------------------------------

@router.get("/users/{username}")
async def get_user_wall(
    username: str,
    limit: int = Query(20, le=50),
    offset: int = Query(0),
    current_user: dict = Depends(get_current_user)
):
    """Get wall posts for a user."""
    # Look up user
    user = db.get_user_by_nick(username)
    if not user:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    
    # Check if wall is enabled
    if not user.get("wall_enabled", 1):
        return JSONResponse(status_code=403, content={"error": "This user's wall is disabled"})
    
    posts = db.get_wall_posts(user["id"], current_user["id"], limit, offset)
    
    # Get reactions for each post
    for post in posts:
        post["reactions"] = db.get_post_reactions(post["id"])
    
    return {
        "posts": posts,
        "user": {
            "id": user["id"],
            "nickname": user["nickname"],
            "avatar": user.get("avatar"),
            "mood": user.get("mood", ""),
            "custom_css": user.get("custom_css", "")
        }
    }


@router.post("/posts")
async def create_wall_post(body: CreatePostRequest, current_user: dict = Depends(get_current_user)):
    """Create a new wall post."""
    if not body.content.strip() and not body.media_data:
        return JSONResponse(status_code=400, content={"error": "Post content or media required"})
    
    if len(body.content) > MAX_POST_CONTENT:
        return JSONResponse(status_code=400, content={"error": f"Post too long (max {MAX_POST_CONTENT} chars)"})
    
    if body.media_data and len(body.media_data) > MAX_MEDIA_BYTES:
        return JSONResponse(status_code=413, content={"error": "Media too large (max 10MB)"})
    
    if body.privacy not in ("public", "followers", "friends", "private"):
        return JSONResponse(status_code=400, content={"error": "Invalid privacy setting"})
    
    post_id = db.create_wall_post(
        current_user["id"],
        body.content.strip(),
        body.media_data,
        body.media_type,
        body.privacy,
        1 if body.allow_comments else 0,
        (body.track_title or None),
        (body.track_room or None),
        (body.track_mood or None),
    )
    
    return {
        "id": post_id,
        "content": body.content,
        "privacy": body.privacy,
        "created_at": "just now"
    }


@router.get("/posts/{post_id}")
async def get_single_wall_post(post_id: int, current_user: dict = Depends(get_current_user)):
    """Fetch a single wall post by id (used by the Explore grid detail view).

    Enforces the same privacy rules as the wall feed: the viewer must be
    the author, a follower/friend (for those visibilities), or the post
    must be public.
    """
    post = db.get_wall_post(post_id)
    if not post:
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    privacy = post.get("privacy") or "public"
    author_id = post.get("user_id")
    viewer_id = current_user["id"]
    # Hide blocked authors — return 404 to avoid revealing the block
    if author_id and db.is_blocked_either_way(viewer_id, author_id):
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    allowed = (
        privacy == "public"
        or viewer_id == author_id
        or (privacy == "followers" and db.is_following(viewer_id, author_id))
        or (privacy == "friends" and db.are_friends(viewer_id, author_id))
    )
    if not allowed:
        return JSONResponse(status_code=403, content={"error": "Not allowed to view this post"})
    post["reactions"] = db.get_post_reactions(post_id)
    return post


@router.put("/posts/{post_id}")
async def update_wall_post(post_id: int, body: UpdatePostRequest, current_user: dict = Depends(get_current_user)):
    """Edit a wall post."""
    updates = {}
    if body.content is not None:
        if len(body.content) > MAX_POST_CONTENT:
            return JSONResponse(status_code=400, content={"error": "Post too long"})
        updates["content"] = body.content.strip()
    if body.privacy is not None:
        if body.privacy not in ("public", "followers", "friends", "private"):
            return JSONResponse(status_code=400, content={"error": "Invalid privacy"})
        updates["privacy"] = body.privacy
    if body.allow_comments is not None:
        updates["allow_comments"] = 1 if body.allow_comments else 0
    
    if not updates:
        return JSONResponse(status_code=400, content={"error": "Nothing to update"})
    
    if db.update_wall_post(post_id, current_user["id"], **updates):
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Post not found or not yours"})


@router.delete("/posts/{post_id}")
async def delete_wall_post(post_id: int, current_user: dict = Depends(get_current_user)):
    """Delete a wall post."""
    if db.delete_wall_post(post_id, current_user["id"]):
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Post not found or not yours"})


# ---------------------------------------------------------------------------
# Reactions
# ---------------------------------------------------------------------------

@router.post("/posts/{post_id}/reactions")
async def add_post_reaction(post_id: int, body: AddReactionRequest, current_user: dict = Depends(get_current_user)):
    """Add/toggle a reaction to a post."""
    if not body.emoji or len(body.emoji) > 8:
        return JSONResponse(status_code=400, content={"error": "Invalid emoji"})
    
    post = db.get_wall_post(post_id)
    if not post:
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    if post.get("user_id") and db.is_blocked_either_way(current_user["id"], post["user_id"]):
        return JSONResponse(status_code=404, content={"error": "Post not found"})

    added = db.add_wall_reaction(post_id, current_user["id"], body.emoji)
    reactions = db.get_post_reactions(post_id)
    
    return {"added": added, "reactions": reactions}


@router.get("/posts/{post_id}/reactions")
async def get_post_reactions_list(post_id: int):
    """Get all reactions for a post."""
    reactions = db.get_post_reactions(post_id)
    return {"reactions": reactions}


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------

@router.get("/posts/{post_id}/comments")
async def get_post_comments(post_id: int, limit: int = Query(50, le=100),
                            current_user: dict = Depends(get_current_user)):
    """Get comments for a post."""
    post = db.get_wall_post(post_id)
    if not post:
        return JSONResponse(status_code=404, content={"error": "Post not found"})

    comments = db.get_post_comments(post_id, limit, viewer_id=current_user["id"])
    return {"comments": comments, "allow_comments": bool(post.get("allow_comments", 1))}


@router.post("/posts/{post_id}/comments")
async def add_post_comment(post_id: int, body: AddCommentRequest, current_user: dict = Depends(get_current_user)):
    """Add a comment to a post."""
    if not body.content or len(body.content.strip()) == 0:
        return JSONResponse(status_code=400, content={"error": "Comment cannot be empty"})

    if len(body.content) > 1000:
        return JSONResponse(status_code=400, content={"error": "Comment too long (max 1000 chars)"})

    # Block guard: author blocked commenter (or vice versa) => hide post
    post = db.get_wall_post(post_id)
    if not post:
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    if post.get("user_id") and db.is_blocked_either_way(current_user["id"], post["user_id"]):
        return JSONResponse(status_code=404, content={"error": "Post not found"})

    comment_id = db.add_wall_comment(post_id, current_user["id"], body.content.strip())
    if comment_id is None:
        return JSONResponse(status_code=403, content={"error": "Comments disabled on this post"})
    
    return {
        "id": comment_id,
        "content": body.content,
        "nickname": current_user["nickname"],
        "avatar": current_user.get("avatar")
    }


@router.delete("/comments/{comment_id}")
async def delete_comment(comment_id: int, current_user: dict = Depends(get_current_user)):
    """Delete a comment."""
    if db.delete_wall_comment(comment_id, current_user["id"]):
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Comment not found or not authorized"})


# ---------------------------------------------------------------------------
# User profile settings for wall
# ---------------------------------------------------------------------------

class UpdateWallSettingsRequest(BaseModel):
    wall_enabled: Optional[bool] = None
    wall_comments_enabled: Optional[bool] = None
    mood: Optional[str] = None
    custom_css: Optional[str] = None


@router.patch("/settings")
async def update_wall_settings(body: UpdateWallSettingsRequest, current_user: dict = Depends(get_current_user)):
    """Update user's wall settings."""
    with db._conn() as con:
        updates = []
        params = []
        
        if body.wall_enabled is not None:
            updates.append("wall_enabled=?")
            params.append(1 if body.wall_enabled else 0)
        
        if body.wall_comments_enabled is not None:
            updates.append("wall_comments_enabled=?")
            params.append(1 if body.wall_comments_enabled else 0)
        
        if body.mood is not None:
            if len(body.mood) > 100:
                return JSONResponse(status_code=400, content={"error": "Mood too long (max 100 chars)"})
            updates.append("mood=?")
            params.append(body.mood)
        
        if body.custom_css is not None:
            # Limit CSS size and do basic sanitization
            css = body.custom_css[:10240]  # Max 10KB
            # Block potentially dangerous CSS
            dangerous = ["javascript:", "expression(", "url(", "@import"]
            for d in dangerous:
                if d in css.lower():
                    return JSONResponse(status_code=400, content={"error": f"CSS contains forbidden: {d}"})
            updates.append("custom_css=?")
            params.append(css)
        
        if not updates:
            return JSONResponse(status_code=400, content={"error": "Nothing to update"})
        
        params.append(current_user["id"])
        con.execute(f"UPDATE users SET {', '.join(updates)} WHERE id=?", params)
        row = con.execute("""
            SELECT wall_enabled, wall_comments_enabled, mood, custom_css
            FROM users WHERE id=?
        """, (current_user["id"],)).fetchone()
    
    return dict(row) if row else {"ok": True}


@router.get("/settings")
async def get_wall_settings(current_user: dict = Depends(get_current_user)):
    """Get user's wall settings."""
    with db._conn() as con:
        row = con.execute("""
            SELECT wall_enabled, wall_comments_enabled, mood, custom_css
            FROM users WHERE id=?
        """, (current_user["id"],)).fetchone()
    
    return dict(row) if row else {}
