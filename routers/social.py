"""Social feed, followers, explore — Instagram-style features."""
import base64

from fastapi import APIRouter, Depends, Query, UploadFile, File, Form
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

import database as db
from deps import get_current_user

router = APIRouter(prefix="/social", tags=["social"])


class CreateStoryRequest(BaseModel):
    media_data: str
    media_type: str
    caption: str = ""
    privacy: str = "public"


@router.post("/follow/{nickname}")
async def follow_user(nickname: str, current_user: dict = Depends(get_current_user)):
    target = db.get_user_by_nick(nickname)
    if not target:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    if target["id"] == current_user["id"]:
        return JSONResponse(status_code=400, content={"error": "Cannot follow yourself"})
    ok = db.follow_user(current_user["id"], target["id"])
    return {
        "ok": True,
        "following": True,
        "follower_count": db.get_follower_count(target["id"]),
    }


@router.delete("/follow/{nickname}")
async def unfollow_user(nickname: str, current_user: dict = Depends(get_current_user)):
    target = db.get_user_by_nick(nickname)
    if not target:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    db.unfollow_user(current_user["id"], target["id"])
    return {
        "ok": True,
        "following": False,
        "follower_count": db.get_follower_count(target["id"]),
    }


@router.get("/profile/{nickname}")
async def social_profile(nickname: str, current_user: dict = Depends(get_current_user)):
    """Full social profile with stats."""
    user = db.get_user_profile(nickname)
    if not user:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    uid = user["id"]
    is_self = current_user["id"] == uid
    # Honor the owner's profile-public setting. If the profile is marked
    # private and the viewer is neither the owner nor a friend, return a
    # minimal response so the client can render a "This profile is private"
    # screen instead of leaking posts / counts / channel info.
    profile_public = bool(user.get("profile_public", 1))
    is_friend = db.are_friends(current_user["id"], uid)
    if not profile_public and not is_self and not is_friend:
        return {
            "id": uid,
            "nickname": user["nickname"],
            "avatar": user.get("avatar"),
            "is_self": False,
            "profile_public": False,
            "private": True,
            "friend_status": db.friend_request_status(current_user["id"], uid),
            "is_following": False,
            "is_friend": False,
        }
    return {
        "id": uid,
        "nickname": user["nickname"],
        "avatar": user.get("avatar"),
        "banner": user.get("banner"),
        "bio": user.get("bio", ""),
        "status_msg": user.get("status_msg", ""),
        "mood": user.get("mood", ""),
        "presence": user.get("presence", "online"),
        "custom_css": user.get("custom_css", ""),
        "tags": user.get("tags", []),
        "created_at": user.get("created_at"),
        "is_admin": bool(user.get("is_admin")),
        "profile_public": profile_public,
        "private": False,
        "post_count": db.get_post_count(uid),
        "follower_count": db.get_follower_count(uid),
        "following_count": db.get_following_count(uid),
        "is_following": db.is_following(current_user["id"], uid),
        "is_friend": is_friend,
        "friend_status": db.friend_request_status(current_user["id"], uid),
        "is_self": is_self,
        "last_seen": db.get_privacy_last_seen(uid, current_user["id"]),
        "story_status": db.user_active_story_status(uid, current_user["id"]),
    }


# ── helper: block non-friend access to a private profile ────────────────
def _private_blocked(user: dict, viewer_id: int) -> bool:
    """True when the target profile has profile_public=0 and the viewer is
    neither the owner nor a confirmed friend. Used to gate posts / media /
    channels / followers so a private profile leaks nothing beyond the
    /profile endpoint's minimal summary."""
    if bool(user.get("profile_public", 1)):
        return False
    if user["id"] == viewer_id:
        return False
    try:
        return not db.are_friends(viewer_id, user["id"])
    except Exception:
        return True


@router.get("/profile/{nickname}/posts")
async def profile_posts(
    nickname: str,
    limit: int = Query(30, le=50),
    offset: int = Query(0),
    current_user: dict = Depends(get_current_user),
):
    user = db.get_user_by_nick(nickname)
    if not user:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    if _private_blocked(user, current_user["id"]):
        return {"posts": [], "private": True}
    posts = db.get_wall_posts(user["id"], current_user["id"], limit, offset)
    for p in posts:
        p["reactions"] = db.get_post_reactions(p["id"])
    return {"posts": posts}


@router.get("/profile/{nickname}/followers")
async def list_followers(nickname: str, current_user: dict = Depends(get_current_user)):
    user = db.get_user_by_nick(nickname)
    if not user:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    if _private_blocked(user, current_user["id"]):
        return {"users": [], "private": True}
    followers = db.get_followers_list(user["id"])
    for f in followers:
        f["is_following"] = db.is_following(current_user["id"], f["id"])
    return {"users": followers}


@router.get("/profile/{nickname}/channels")
async def profile_channels(nickname: str, current_user: dict = Depends(get_current_user)):
    """Channels created/owned by this user."""
    user = db.get_user_by_nick(nickname)
    if not user:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    if _private_blocked(user, current_user["id"]):
        return {"channels": [], "private": True}
    # Respect the owner's privacy toggle — if they've hidden their active
    # channels from profile viewers, only they themselves see the list.
    if (user.get("hide_active_channels") and user["id"] != current_user["id"]):
        return {"channels": [], "hidden": True}
    channels = db.get_user_channels(user["id"])
    return {"channels": channels}


@router.get("/profile/{nickname}/following")
async def list_following(nickname: str, current_user: dict = Depends(get_current_user)):
    user = db.get_user_by_nick(nickname)
    if not user:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    if _private_blocked(user, current_user["id"]):
        return {"users": [], "private": True}
    following = db.get_following_list(user["id"])
    for f in following:
        f["is_following"] = db.is_following(current_user["id"], f["id"])
    return {"users": following}


@router.get("/feed")
async def get_feed(
    limit: int = Query(30, le=100),
    offset: int = Query(0),
    mood: str = Query(""),
    current_user: dict = Depends(get_current_user),
):
    """Posts from users you follow."""
    posts = db.get_feed_posts(current_user["id"], limit, offset, mood)
    for p in posts:
        p["reactions"] = db.get_post_reactions(p["id"])
    return {"posts": posts}


@router.get("/explore")
async def get_explore(
    limit: int = Query(30, le=100),
    offset: int = Query(0),
    sort: str = Query("trending"),
    mood: str = Query(""),
    current_user: dict = Depends(get_current_user),
):
    """All public posts — discover new people."""
    posts = db.get_explore_posts(current_user["id"], limit, offset, sort, mood)
    for p in posts:
        p["reactions"] = db.get_post_reactions(p["id"])
    return {"posts": posts}


@router.get("/suggested")
async def suggested_users(current_user: dict = Depends(get_current_user)):
    """Users you might want to follow."""
    return {"users": db.get_suggested_users(current_user["id"])}


@router.get("/profile/{nickname}/media")
async def profile_media(
    nickname: str,
    limit: int = Query(50, le=100),
    offset: int = Query(0),
    current_user: dict = Depends(get_current_user),
):
    """All media this user posted in channels (thumbnails only, no data)."""
    user = db.get_user_by_nick(nickname)
    if not user:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    if _private_blocked(user, current_user["id"]):
        return {"media": [], "is_self": False, "private": True}
    items = db.get_user_channel_media(user["id"], limit, offset)
    return {"media": items, "is_self": current_user["id"] == user["id"]}


@router.post("/profile/media/{msg_id}/to-wall")
async def media_to_wall(msg_id: int, current_user: dict = Depends(get_current_user)):
    """Promote a channel-media message to the user's public wall.

    This MOVES the media out of Private Media (it no longer appears there
    on future loads) by flipping `messages.posted_to_wall` to 1 after the
    wall post is created. The channel message itself is untouched, so
    history in the source room is preserved.
    """
    # Fetch the original message
    msg = db.get_message(msg_id)
    if not msg:
        return JSONResponse(status_code=404, content={"error": "Message not found"})
    if msg["user_id"] != current_user["id"]:
        return JSONResponse(status_code=403, content={"error": "Not your media"})
    if not msg.get("media_data"):
        return JSONResponse(status_code=400, content={"error": "No media on this message"})
    # Create a wall post with the same media
    post_id = db.create_wall_post(
        user_id=current_user["id"],
        content=f"📸 From #{msg['room_name']}",
        media_data=msg["media_data"],
        media_type=msg.get("media_type"),
        privacy="public",
    )
    # Flag the source message so it no longer appears in Private Media.
    try:
        with db._conn() as con:
            con.execute(
                "UPDATE messages SET posted_to_wall = 1 WHERE id = ?",
                (msg_id,),
            )
            con.commit()
    except Exception:
        # Non-fatal: the wall post already exists. Worst case, the tile
        # shows up once more until the next explicit flag.
        pass
    return {"ok": True, "post_id": post_id}


# ===========================================================================
# Stories
# ===========================================================================

@router.get("/stories")
async def get_stories(current_user: dict = Depends(get_current_user)):
    """Get stories feed grouped by user."""
    db.cleanup_expired_stories()
    raw = db.get_stories_feed(current_user["id"])
    # Group by user
    grouped: dict = {}
    for s in raw:
        uid = s["user_id"]
        if uid not in grouped:
            grouped[uid] = {
                "user_id": uid,
                "nickname": s["nickname"],
                "avatar": s.get("avatar"),
                "stories": [],
                "has_unviewed": False,
            }
        grouped[uid]["stories"].append({
            "id": s["id"],
            "media_data": s["media_data"],
            "media_type": s["media_type"],
            "caption": s.get("caption", ""),
            "created_at": s["created_at"],
            "viewed": bool(s["viewed"]),
        })
        if not s["viewed"]:
            grouped[uid]["has_unviewed"] = True
    # Put current user first, then unviewed, then viewed
    users = list(grouped.values())
    users.sort(key=lambda u: (u["user_id"] != current_user["id"], not u["has_unviewed"]))
    return {"users": users}


@router.post("/stories")
async def create_story(body: CreateStoryRequest, current_user: dict = Depends(get_current_user)):
    """Create a new story (24h expiry)."""
    if not body.media_data:
        return JSONResponse(status_code=400, content={"error": "Media required"})
    if len(body.media_data) > 100 * 1024 * 1024:
        return JSONResponse(status_code=413, content={"error": "Media too large (max 100MB)"})
    privacy = body.privacy if body.privacy in ("public", "followers") else "public"
    story_id = db.create_story(current_user["id"], body.media_data, body.media_type, body.caption, privacy)
    return {"ok": True, "id": story_id, "privacy": privacy}


@router.post("/stories/upload")
async def create_story_upload(
    media: UploadFile = File(...),
    caption: str = Form(""),
    privacy: str = Form("public"),
    current_user: dict = Depends(get_current_user),
):
    """Create a story from multipart file upload (mobile-safe path)."""
    if not media:
        return JSONResponse(status_code=400, content={"error": "Media required"})

    raw = await media.read()
    media_type = media.content_type or "application/octet-stream"
    max_bytes = 100 * 1024 * 1024
    if len(raw) > max_bytes:
        return JSONResponse(
            status_code=413,
            content={"error": "Media too large (max 100MB)"},
        )

    media_data = f"data:{media_type};base64,{base64.b64encode(raw).decode('ascii')}"
    safe_privacy = privacy if privacy in ("public", "followers") else "public"
    story_id = db.create_story(current_user["id"], media_data, media_type, caption or "", safe_privacy)
    return {"ok": True, "id": story_id, "privacy": safe_privacy}


@router.post("/stories/{story_id}/view")
async def view_story(story_id: int, current_user: dict = Depends(get_current_user)):
    """Mark a story as viewed."""
    db.mark_story_viewed(story_id, current_user["id"])
    return {"ok": True}


@router.delete("/stories/{story_id}")
async def delete_story(story_id: int, current_user: dict = Depends(get_current_user)):
    ok = db.delete_story(story_id, current_user["id"])
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Story not found or not yours"})
    return {"ok": True}


@router.get("/stories/{story_id}/viewers")
async def story_viewers(story_id: int, current_user: dict = Depends(get_current_user)):
    return {"viewers": db.get_story_viewers(story_id)}
