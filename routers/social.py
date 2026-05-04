"""Social feed, followers, explore — Instagram-style features."""
import base64
import logging
import time
import uuid
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Query, Request, UploadFile, File, Form, Header
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from slowapi import Limiter
from typing import Optional

import database as db
from deps import get_current_user, client_ip
from ws_manager import manager

_log = logging.getLogger(__name__)
limiter = Limiter(key_func=client_ip)
router = APIRouter(prefix="/social", tags=["social"])


async def _push_social_notif(recipient_id: int, payload: dict) -> None:
    """Best-effort WS push for a social-activity event. Never raises."""
    try:
        await manager.send_to_user(recipient_id, payload)
    except Exception:
        _log.debug("social notif WS push failed", exc_info=True)


class CreateStoryRequest(BaseModel):
    media_data: str
    media_type: str
    caption: str = ""
    privacy: str = "public"


@router.post("/follow/{nickname}")
@limiter.limit("120/hour")
async def follow_user(request: Request, nickname: str, current_user: dict = Depends(get_current_user)):
    target = db.get_user_by_nick(nickname)
    if not target:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    if target["id"] == current_user["id"]:
        return JSONResponse(status_code=400, content={"error": "Cannot follow yourself"})
    ok = db.follow_user(current_user["id"], target["id"])
    if ok:
        try:
            db.insert_federation_outbox_event({
                "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
                "event_type": "social.follow.changed",
                "payload": {
                    "action": "follow",
                    "follower_nickname": current_user["nickname"],
                    "following_nickname": target["nickname"],
                },
            })
        except Exception:
            pass
        # Notify the target that they have a new follower.
        try:
            notif_id = db.add_social_notification(
                user_id=target["id"],
                actor_id=current_user["id"],
                kind="follow",
            )
            if notif_id is not None:
                unread = db.get_social_notification_unread_count(target["id"])
                await _push_social_notif(target["id"], {
                    "type": "social_notification",
                    "event": "follow",
                    "id": notif_id,
                    "actor": current_user["nickname"],
                    "actor_avatar": current_user.get("avatar"),
                    "unread": unread,
                })
        except Exception:
            _log.debug("follow notif failed", exc_info=True)
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
    try:
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "social.follow.changed",
            "payload": {
                "action": "unfollow",
                "follower_nickname": current_user["nickname"],
                "following_nickname": target["nickname"],
            },
        })
    except Exception:
        pass
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
    _rmap = db.get_post_reactions_bulk([p["id"] for p in posts])
    for p in posts:
        p["reactions"] = _rmap.get(p["id"], [])
    return {"posts": posts}


@router.get("/profile/{nickname}/reposts")
async def profile_reposts(
    nickname: str,
    limit: int = Query(30, le=50),
    offset: int = Query(0),
    current_user: dict = Depends(get_current_user),
):
    """Posts that this user has reposted. Visible only if viewer can see the profile."""
    user = db.get_user_by_nick(nickname)
    if not user:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    if _private_blocked(user, current_user["id"]):
        return {"posts": [], "private": True}
    posts = db.get_user_reposts(user["id"], current_user["id"], limit, offset)
    _rmap = db.get_post_reactions_bulk([p["id"] for p in posts])
    for p in posts:
        p["reactions"] = _rmap.get(p["id"], [])
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
    lite: int = Query(0),
    current_user: dict = Depends(get_current_user),
):
    """Posts from users you follow.

    `lite=1` skips inlining base64 media in the row — instead the client
    receives `media_data = '/api/social/posts/{id}/media'` per post and the
    browser fetches each image/video lazily. Drops feed payloads from MBs
    to KBs and lets `loading="lazy"` only request what scrolls into view.
    """
    use_lite = bool(lite)
    posts = await run_in_threadpool(
        db.get_feed_posts, current_user["id"], limit, offset, mood, lite=use_lite
    )
    _rmap = await run_in_threadpool(db.get_post_reactions_bulk, [p["id"] for p in posts])
    for p in posts:
        p["reactions"] = _rmap.get(p["id"], [])
        # Only construct a lazy-load URL if media_data is missing.
        # If database already returned media_data (e.g., for images/videos in lite mode),
        # use it directly—the frontend will render it or fetch as needed.
        if use_lite and p.get("has_media") and not p.get("media_data"):
            p["media_data"] = f"/api/social/posts/{p['id']}/media"
    return {"posts": posts}


@router.get("/explore")
async def get_explore(
    limit: int = Query(30, le=100),
    offset: int = Query(0),
    sort: str = Query("trending"),
    mood: str = Query(""),
    lite: int = Query(0),
    current_user: dict = Depends(get_current_user),
):
    """All public posts — discover new people.

    See `get_feed` for the `lite` flag.
    """
    use_lite = bool(lite)
    posts = await run_in_threadpool(
        db.get_explore_posts, current_user["id"], limit, offset, sort, mood, lite=use_lite
    )
    _rmap = await run_in_threadpool(db.get_post_reactions_bulk, [p["id"] for p in posts])
    for p in posts:
        p["reactions"] = _rmap.get(p["id"], [])
        # Only construct a lazy-load URL if media_data is missing.
        # If database already returned media_data (e.g., for images/videos in lite mode),
        # use it directly—the frontend will render it or fetch as needed.
        if use_lite and p.get("has_media") and not p.get("media_data"):
            p["media_data"] = f"/api/social/posts/{p['id']}/media"
    return {"posts": posts}


@router.get("/suggested")
async def suggested_users(current_user: dict = Depends(get_current_user)):
    """Users you might want to follow."""
    return {"users": db.get_suggested_users(current_user["id"])}


@router.get("/posts/{post_id}/media")
async def get_post_media(
    post_id: int,
    request: Request,
    token: Optional[str] = Query(None),
    x_session_token: Optional[str] = Header(None, alias="X-Session-Token"),
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    """Lazy-load endpoint for wall-post media. Used by feed/explore in
    `lite=1` mode so each post body only carries this URL instead of the
    multi-MB inlined base64 payload. Decodes the stored data URI and
    streams raw bytes with the proper Content-Type, plus an immutable
    private cache header so the browser only re-fetches on scroll-back
    once before caching it locally.

    Privacy mirrors `get_wall_posts`: owner sees own; friends see
    `friends/followers/public`; followers see `followers/public`; everyone
    else only `public`. Either-side block hides the media entirely.
    """
    session_token = (x_session_token or token or "").strip()
    if not session_token and authorization:
        auth = authorization.strip()
        if auth.lower().startswith("bearer "):
            session_token = auth[7:].strip()
    current_user = db.get_user_by_token(session_token) if session_token else None
    if not current_user:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})

    row = db.get_wall_post_media(post_id)
    if not row or not row.get("media_data"):
        return JSONResponse(status_code=404, content={"error": "Not found"})
    owner_id = int(row["user_id"])
    viewer_id = int(current_user["id"])
    privacy = (row.get("privacy") or "public").lower()
    if owner_id != viewer_id:
        if db.is_blocked_either_way(viewer_id, owner_id):
            return JSONResponse(status_code=404, content={"error": "Not found"})
        if privacy == "friends":
            if not db.are_friends(viewer_id, owner_id):
                return JSONResponse(status_code=403, content={"error": "Forbidden"})
        elif privacy == "followers":
            if not (db.are_friends(viewer_id, owner_id) or db.is_following(viewer_id, owner_id)):
                return JSONResponse(status_code=403, content={"error": "Forbidden"})
        elif privacy != "public":
            return JSONResponse(status_code=403, content={"error": "Forbidden"})

    media_data = row["media_data"]
    media_type = row.get("media_type") or "application/octet-stream"

    # If stored as a data URI, decode to raw bytes so the browser can
    # cache + range-request properly. Anything else (e.g. a /api/... URL
    # stored on the row) is returned as a redirect to that location.
    if isinstance(media_data, str) and media_data.startswith("data:"):
        try:
            header, _, b64 = media_data.partition(",")
            # header looks like "data:image/jpeg;base64"
            if ";base64" in header:
                raw = base64.b64decode(b64, validate=False)
                ct = header[5:].split(";", 1)[0] or media_type
                total = len(raw)
                base_headers = {
                    "Cache-Control": "private, max-age=86400, immutable",
                    "Accept-Ranges": "bytes",
                    "X-Content-Type-Options": "nosniff",
                    "Vary": "X-Session-Token, Authorization",
                }
                range_header = (request.headers.get("range") or "").strip()
                if range_header.lower().startswith("bytes=") and total > 0:
                    try:
                        spec = range_header[6:].split(",", 1)[0].strip()
                        start_s, end_s = spec.split("-", 1)
                        if start_s == "":
                            # Suffix range: bytes=-N
                            suffix = int(end_s)
                            if suffix <= 0:
                                raise ValueError("invalid suffix range")
                            start = max(total - suffix, 0)
                            end = total - 1
                        else:
                            start = int(start_s)
                            end = int(end_s) if end_s else (total - 1)

                        if start < 0 or end < start:
                            raise ValueError("invalid range bounds")
                        if start >= total:
                            return Response(
                                status_code=416,
                                headers={
                                    **base_headers,
                                    "Content-Range": f"bytes */{total}",
                                    "Content-Length": "0",
                                },
                            )

                        end = min(end, total - 1)
                        chunk = raw[start:end + 1]
                        return Response(
                            content=chunk,
                            status_code=206,
                            media_type=ct,
                            headers={
                                **base_headers,
                                "Content-Range": f"bytes {start}-{end}/{total}",
                                "Content-Length": str(len(chunk)),
                            },
                        )
                    except Exception:
                        # Malformed Range header; serve full content.
                        pass
                return Response(
                    content=raw,
                    media_type=ct,
                    headers={**base_headers, "Content-Length": str(total)},
                )
        except Exception:
            _log.debug("post media decode failed pid=%s", post_id, exc_info=True)
            return JSONResponse(status_code=500, content={"error": "Decode failed"})

    # Fallback: media_data isn't a base64 data URI.
    # Return an HTTP redirect so <img>/<video src="/api/social/posts/{id}/media">
    # still resolves to actual media bytes instead of JSON.
    target = str(media_data or "").strip()
    if not target:
        return JSONResponse(status_code=404, content={"error": "Not found"})

    # Prevent unsafe redirect schemes. Allow same-origin absolute paths,
    # and external http(s) links for legacy media URLs.
    if target.startswith("/"):
        safe_target = target
    else:
        parsed = urlparse(target)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return JSONResponse(status_code=404, content={"error": "Not found"})
        safe_target = target

    return Response(
        status_code=302,
        headers={
            "Location": safe_target,
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
            "Vary": "X-Session-Token, Authorization",
        },
    )


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
    # Note: cleanup is done in background task; do not block requests.
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
            "has_media": bool(s.get("has_media")),
            "media_data": s.get("media_data"),
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
@limiter.limit("30/hour")
async def create_story(request: Request, body: CreateStoryRequest, current_user: dict = Depends(get_current_user)):
    """Create a new story (24h expiry)."""
    if not body.media_data:
        return JSONResponse(status_code=400, content={"error": "Media required"})
    if len(body.media_data) > 100 * 1024 * 1024:
        return JSONResponse(status_code=413, content={"error": "Media too large (max 100MB)"})
    privacy = body.privacy if body.privacy in ("public", "followers") else "public"
    story_id = db.create_story(current_user["id"], body.media_data, body.media_type, body.caption, privacy)
    try:
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "social.story.created",
            "payload": {
                "nickname": current_user["nickname"],
                "media_data": body.media_data,
                "media_type": body.media_type,
                "caption": body.caption,
                "privacy": privacy,
            },
        })
    except Exception:
        pass
    return {"ok": True, "id": story_id, "privacy": privacy}


@router.post("/stories/upload")
@limiter.limit("30/hour")
async def create_story_upload(
    request: Request,
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
    try:
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "social.story.created",
            "payload": {
                "nickname": current_user["nickname"],
                "media_data": media_data,
                "media_type": media_type,
                "caption": caption or "",
                "privacy": safe_privacy,
            },
        })
    except Exception:
        pass
    return {"ok": True, "id": story_id, "privacy": safe_privacy}


@router.post("/stories/{story_id}/view")
async def view_story(story_id: int, current_user: dict = Depends(get_current_user)):
    """Mark a story as viewed."""
    db.mark_story_viewed(story_id, current_user["id"])
    return {"ok": True}


@router.get("/stories/{story_id}/media")
async def get_story_media(story_id: int, current_user: dict = Depends(get_current_user)):
    """Lazy-load full media payload for a single story (privacy enforced)."""
    with db._conn() as con:
        row = con.execute(
            """SELECT s.user_id, s.media_data, s.media_type,
                      COALESCE(s.privacy,'public') AS privacy, s.expires_at
                 FROM stories s WHERE s.id=?""",
            (story_id,)
        ).fetchone()
    if not row or not row["media_data"]:
        return JSONResponse(status_code=404, content={"error": "Story not found"})
    owner_id = row["user_id"]
    if owner_id != current_user["id"]:
        # Block guard
        if db.is_blocked_either_way(current_user["id"], owner_id):
            return JSONResponse(status_code=404, content={"error": "Story not found"})
        privacy = (row["privacy"] or "public").lower()
        if privacy == "private":
            return JSONResponse(status_code=403, content={"error": "Private"})
        # followers-only requires viewer to follow owner
        if privacy == "followers" and not db.is_following(current_user["id"], owner_id):
            return JSONResponse(status_code=403, content={"error": "Followers only"})
    headers = {"Cache-Control": "private, max-age=86400"}
    return JSONResponse(
        content={"media_data": row["media_data"], "media_type": row["media_type"]},
        headers=headers,
    )


@router.delete("/stories/{story_id}")
async def delete_story(story_id: int, current_user: dict = Depends(get_current_user)):
    ok = db.delete_story(story_id, current_user["id"])
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Story not found or not yours"})
    try:
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "social.story.deleted",
            "payload": {
                "nickname": current_user["nickname"],
                "story_id": int(story_id),
            },
        })
    except Exception:
        pass
    return {"ok": True}


@router.get("/stories/{story_id}/viewers")
async def story_viewers(story_id: int, current_user: dict = Depends(get_current_user)):
    return {"viewers": db.get_story_viewers(story_id)}


# ---------------------------------------------------------------------------
# Activity notifications (likes / comments / follows)
# ---------------------------------------------------------------------------


class MarkNotifsReadRequest(BaseModel):
    ids: Optional[list] = None  # None or [] => mark all unread as read


@router.get("/reels")
@limiter.limit("300/hour")
async def get_reels(
    request: Request,
    scope: str = Query("all"),
    sort: str = Query("hot"),
    limit: int = Query(20, le=50),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(get_current_user),
):
    """Video posts for the Reels tab.

    scope: 'all' = all public videos, 'friends' = videos posted/reposted/liked by friends.
    sort:  'hot' = ❤️-driven ranking, 'new' = newest, 'top' = all-time hearts.
    """
    if scope not in ("all", "friends"):
        scope = "all"
    if sort not in ("hot", "new", "top"):
        sort = "hot"
    posts = await run_in_threadpool(
        db.get_reels_posts, current_user["id"], scope=scope, sort=sort,
        limit=limit, offset=offset,
    )
    _rmap = await run_in_threadpool(db.get_post_reactions_bulk, [p["id"] for p in posts])
    for p in posts:
        # Serve media lazily through the authenticated media endpoint so we
        # never ship multi-MB base64 blobs in the reels listing payload.
        p["media_data"] = f"/api/social/posts/{p['id']}/media"
        p["reactions"] = _rmap.get(p["id"], [])
    return {"posts": posts}


@router.get("/notifications")
@limiter.limit("600/hour")
async def list_social_notifications(
    request: Request,
    limit: int = Query(40, le=100),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(get_current_user),
):
    """List recent like/comment/follow notifications for the current user."""
    items = db.get_social_notifications(current_user["id"], limit=limit, offset=offset)
    unread = db.get_social_notification_unread_count(current_user["id"])
    return {"notifications": items, "unread": unread}


@router.get("/notifications/unread-count")
@limiter.limit("1200/hour")
async def social_notifications_unread_count(
    request: Request, current_user: dict = Depends(get_current_user)
):
    return {"unread": db.get_social_notification_unread_count(current_user["id"])}


@router.post("/notifications/read")
@limiter.limit("600/hour")
async def mark_social_notifications_read_endpoint(
    request: Request,
    body: MarkNotifsReadRequest,
    current_user: dict = Depends(get_current_user),
):
    """Mark a list of notifications as read. Empty list / null => mark all."""
    ids = body.ids if (body.ids and isinstance(body.ids, list)) else None
    # Cap batch size to prevent oversized IN-clauses
    if ids is not None:
        ids = [
            int(i) for i in ids[:200]
            if isinstance(i, (int, float, str)) and str(i).lstrip("-").isdigit()
        ]
    affected = db.mark_social_notifications_read(current_user["id"], ids=ids)
    unread = db.get_social_notification_unread_count(current_user["id"])
    return {"ok": True, "marked": affected, "unread": unread}
