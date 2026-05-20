"""Profile wall/posts routes - Facebook-style social features."""
import logging
import re
import time
import uuid
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from slowapi import Limiter
from typing import Optional

import database as db
from deps import get_current_user, client_ip
from ws_manager import manager
# Track B — declaration-list inline sanitiser. The old
# `_css_safety.sanitize_scoped_css` (selector-aware <style> sanitiser)
# is no longer used: we never emit a <style> block from user data.
from routers._css_inline import sanitize_inline_style
from routers.rooms import ROOM_NAME_RE

_log = logging.getLogger(__name__)


def _sanitize_track_room(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip().lower()
    if not s or not ROOM_NAME_RE.match(s):
        return None
    return s
limiter = Limiter(key_func=client_ip)
router = APIRouter(prefix="/wall", tags=["wall"])


async def _push_social_notif(recipient_id: int, payload: dict) -> None:
    """Best-effort WS push for a social-activity event. Never raises."""
    try:
        await manager.send_to_user(recipient_id, payload)
    except Exception:
        _log.debug("social notif WS push failed", exc_info=True)

MAX_POST_CONTENT = 5000
MAX_MEDIA_BYTES  = 10  * 1024 * 1024   # images
MAX_VIDEO_BYTES  = 150 * 1024 * 1024   # videos (base64 of ~100 MB raw)


class CreatePostRequest(BaseModel):
    content: str = Field(default="", max_length=10_000)
    media_data: Optional[str] = Field(default=None, max_length=140_000_000)
    media_type: Optional[str] = Field(default=None, max_length=128)
    # public | followers | friends | private (default: private — only me)
    privacy: str = Field(default="private", max_length=32)
    share_enabled: bool = True
    allow_comments: bool = True
    # Optional track metadata for music/* posts — surfaced on the FrogSocial
    # music card so the title renders instead of a generic "YouTube track".
    track_title: Optional[str] = Field(default=None, max_length=200)
    track_room: Optional[str] = Field(default=None, max_length=128)
    # Vibe tag for music shares ("chill", "hype", "focus", …). Purely
    # cosmetic on the card but also drives the mood filter chips on
    # the Music tab.
    track_mood: Optional[str] = Field(default=None, max_length=32)


# Track D — encrypted (enc_v=2) wall posts. The client encrypts the
# payload (content + media descriptors) under a random AES-256-GCM
# payload key, then wraps that key once per audience member using its
# Signal session to them. Server stores opaque blobs only.
class WrappedKeyEntry(BaseModel):
    recipient_id: int
    wrapped_b64: str = Field(min_length=1, max_length=8192)


class CreateEncryptedPostRequest(BaseModel):
    # 'followers' | 'friends' | 'list:<id>'   (public posts stay plaintext)
    audience: str = Field(min_length=1, max_length=64)
    ciphertext_b64: str = Field(min_length=1, max_length=8_000_000)
    wrapped_keys: list[WrappedKeyEntry] = Field(default_factory=list, max_length=5000)
    # Media stays plaintext for now — Track D Phase 3 will move to a
    # content-addressed encrypted blob store. Until then encrypted
    # posts CAN carry plaintext images/video/music (so the
    # writer-side experience matches the public composer) and only
    # the caption + track metadata is hidden from the server.
    media_data: Optional[str] = Field(default=None, max_length=140_000_000)
    media_type: Optional[str] = Field(default=None, max_length=128)
    share_enabled: bool = True
    allow_comments: bool = True
    track_title: Optional[str] = Field(default=None, max_length=200)
    track_room: Optional[str] = Field(default=None, max_length=128)
    track_mood: Optional[str] = Field(default=None, max_length=32)


class UpdatePostRequest(BaseModel):
    content: Optional[str] = Field(default=None, max_length=10_000)
    privacy: Optional[str] = Field(default=None, max_length=32)
    share_enabled: Optional[bool] = None
    allow_comments: Optional[bool] = None


class AddCommentRequest(BaseModel):
    content: str = Field(min_length=1, max_length=4_000)


class AddReactionRequest(BaseModel):
    emoji: str = Field(min_length=1, max_length=16)


ALLOWED_WALL_REACTION_EMOJIS = {
    "❤️", "👍", "😂", "😮", "😢", "🔥", "🐸", "👏", "💯", "✨",
    "🎉", "💪", "😍",
}


class ToggleRepostRequest(BaseModel):
    quote: Optional[str] = Field(default=None, max_length=4_000)


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
    
    # Bulk-fetch reactions to avoid N+1
    _rmap = db.get_post_reactions_bulk([p["id"] for p in posts])
    for post in posts:
        post["reactions"] = _rmap.get(post["id"], [])
    
    return {
        "posts": posts,
        "user": {
            "id": user["id"],
            "nickname": user["nickname"],
            "avatar": user.get("avatar"),
            "mood": user.get("mood", ""),
            # `custom_css` is the raw user input (for the editor on
            # "my own profile" only — never used by the renderer).
            # `custom_style` is the sanitised inline declaration list
            # the front-end applies via el.style.setProperty().
            "custom_css": user.get("custom_css", ""),
            "custom_style": user.get("custom_style", "") or "",
        }
    }


@router.post("/posts")
@limiter.limit("60/hour")
async def create_wall_post(request: Request, body: CreatePostRequest, current_user: dict = Depends(get_current_user)):
    """Create a new wall post."""
    # `.strip()` only for the empty-check — store original whitespace so
    # multi-paragraph posts keep their formatting.
    if not (body.content or "").strip() and not body.media_data:
        return JSONResponse(status_code=400, content={"error": "Post content or media required"})

    if len(body.content) > MAX_POST_CONTENT:
        return JSONResponse(status_code=400, content={"error": f"Post too long (max {MAX_POST_CONTENT} chars)"})
    
    if body.media_data:
        media_type = (body.media_type or '').strip().lower()
        if not (media_type.startswith('image/') or media_type.startswith('video/') or media_type.startswith('music/')):
            return JSONResponse(status_code=400, content={"error": "Unsupported media type"})
        # Tighten the image/video allow-list to the safe whitelist so
        # SVG, HTML-as-image, PDF-as-image, etc. are refused at upload
        # time instead of relying solely on the serve-time guard.
        if media_type.startswith('image/') or media_type.startswith('video/'):
            from routers._media_safety import safe_media_type as _safe_mt
            if _safe_mt(media_type) == "application/octet-stream":
                return JSONResponse(status_code=400, content={"error": "Unsupported media type"})
        if (media_type.startswith('image/') or media_type.startswith('video/')) and not str(body.media_data).startswith('data:'):
            return JSONResponse(status_code=400, content={"error": "Media payload must be a data URI"})
        if media_type.startswith('music/') and not re.match(r'^https?://', str(body.media_data), flags=re.IGNORECASE):
            return JSONResponse(status_code=400, content={"error": "Music media must be a valid URL"})
        is_video = (body.media_type or '').startswith('video/')
        limit = MAX_VIDEO_BYTES if is_video else MAX_MEDIA_BYTES
        if len(body.media_data) > limit:
            label = "100MB" if is_video else "10MB"
            return JSONResponse(status_code=413, content={"error": f"Media too large (max {label})"})
        # 9th-pass: strip EXIF / IPTC / XMP and reject polyglot payloads
        # for image uploads. Video / music URLs are left untouched.
        if media_type.startswith('image/') and media_type != 'image/svg+xml':
            from routers._media_safety import safe_reencode as _media_reencode
            import asyncio as _asyncio
            body.media_data = await _asyncio.to_thread(_media_reencode, body.media_data)
    
    if body.privacy not in ("public", "followers", "friends", "private"):
        return JSONResponse(status_code=400, content={"error": "Invalid privacy setting"})
    
    track_room = _sanitize_track_room(body.track_room)
    post_id = db.create_wall_post(
        current_user["id"],
        body.content.strip(),
        body.media_data,
        body.media_type,
        body.privacy,
        1 if body.share_enabled else 0,
        1 if body.allow_comments else 0,
        (body.track_title or None),
        track_room,
        (body.track_mood or None),
    )

    try:
        if body.privacy in ("public", "followers"):
            from routers import federation as federation_mod
            global_post_id, _origin = db.register_local_wall_post_global_id(int(post_id))
            federation_mod.enqueue_social_post_created(
                current_user,
                global_post_id=global_post_id,
                content=body.content.strip(),
                media_data=body.media_data,
                media_type=body.media_type,
                privacy=body.privacy,
                share_enabled=bool(body.share_enabled),
                allow_comments=bool(body.allow_comments),
                track_title=body.track_title,
                track_room=track_room,
                track_mood=body.track_mood,
            )
    except Exception:
        pass
    
    return {
        "id": post_id,
        "content": body.content,
        "privacy": body.privacy,
        "share_enabled": bool(body.share_enabled),
        "created_at": "just now"
    }


@router.get("/audience-recipients")
@limiter.limit("60/minute")
async def audience_recipients(request: Request,
                              audience: str,
                              current_user: dict = Depends(get_current_user)):
    """Return the list of user_ids the client must wrap a payload key
    to in order to publish an encrypted post for `audience`.

    The server is the source of truth for the social graph so the
    client can't fan out to people it shouldn't (and won't miss
    people it should). The same audience check is re-applied inside
    `POST /api/wall/posts/encrypted` so a stale list is rejected.
    """
    aud = (audience or "").strip().lower()
    if aud == "public":
        return JSONResponse(status_code=400,
            content={"error": "Public audiences are unencrypted"})
    if aud not in ("followers", "friends") and not aud.startswith("list:"):
        return JSONResponse(status_code=400, content={"error": "Invalid audience"})

    uid = current_user["id"]
    if aud == "followers":
        rows = db.get_followers_list(uid, limit=5000)
    elif aud == "friends":
        rows = db.get_friends(uid)
    else:
        # list:<id> — Phase 3 will add named friend lists. For now,
        # the union of followers + friends (same as the create handler).
        f1 = db.get_followers_list(uid, limit=5000)
        f2 = db.get_friends(uid)
        seen = set()
        rows = []
        for r in (f1 + f2):
            rid = r.get("id") or r.get("user_id")
            if rid and rid not in seen:
                seen.add(rid)
                rows.append({"id": rid, "nickname": r.get("nickname")})

    out = []
    for r in rows:
        rid = r.get("id") or r.get("user_id")
        nick = r.get("nickname")
        if rid and nick and int(rid) != uid:
            out.append({"user_id": int(rid), "nickname": nick})
    return {"audience": aud, "recipients": out, "count": len(out)}


@router.post("/posts/encrypted")
@limiter.limit("60/hour")
async def create_wall_post_encrypted(request: Request,
                                     body: CreateEncryptedPostRequest,
                                     current_user: dict = Depends(get_current_user)):
    """Create an encrypted wall post (Track D / enc_v=2).

    The client supplies opaque ciphertext + per-recipient wrapped keys.
    The server validates the audience matches the social graph (so a
    malicious client can't fan-out wraps to non-followers / non-friends
    behind their back), persists the row + wraps in one transaction,
    and emits a federation event with the same opaque bytes.
    """
    import base64 as _b64

    aud = (body.audience or "").strip().lower()
    if aud == "public":
        return JSONResponse(status_code=400,
            content={"error": "Public posts must use the plaintext endpoint."})
    if aud not in ("followers", "friends") and not aud.startswith("list:"):
        return JSONResponse(status_code=400, content={"error": "Invalid audience"})

    # Decode + bounds-check the ciphertext.
    try:
        ct = _b64.b64decode(body.ciphertext_b64, validate=True)
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Bad ciphertext encoding"})
    if not ct or len(ct) > 4 * 1024 * 1024:
        return JSONResponse(status_code=400, content={"error": "Ciphertext out of bounds"})

    # Pre-decode wraps + de-dup.
    if not body.wrapped_keys:
        return JSONResponse(status_code=400, content={"error": "No recipients"})
    wraps_decoded = []
    seen = set()
    for w in body.wrapped_keys:
        rid = int(w.recipient_id or 0)
        if rid <= 0 or rid in seen or rid == current_user["id"]:
            continue
        seen.add(rid)
        try:
            blob = _b64.b64decode(w.wrapped_b64, validate=True)
        except Exception:
            return JSONResponse(status_code=400, content={"error": "Bad wrap encoding"})
        if not blob or len(blob) > 4096:
            return JSONResponse(status_code=400, content={"error": "Wrap out of bounds"})
        wraps_decoded.append((rid, blob))
    if not wraps_decoded:
        return JSONResponse(status_code=400, content={"error": "No valid recipients"})

    # Audience-graph check: every recipient must actually be in the
    # claimed audience set. Stops a malicious client from leaking to
    # arbitrary users by hand-crafting wraps.
    author_id = current_user["id"]
    if aud == "followers":
        allowed_ids = {r["follower_id"] for r in db._conn().execute(
            "SELECT follower_id FROM followers WHERE following_id=?", (author_id,)
        ).fetchall()}
    elif aud == "friends":
        rows = db._conn().execute(
            "SELECT user_id, friend_id FROM friends "
            "WHERE (user_id=? OR friend_id=?) AND status='accepted'",
            (author_id, author_id),
        ).fetchall()
        allowed_ids = set()
        for r in rows:
            allowed_ids.add(r["user_id"] if r["user_id"] != author_id else r["friend_id"])
    else:
        # list:<id> — Phase 3 will wire to a user_lists table. For now,
        # accept any recipient who's also a friend OR follower of the
        # author. Conservative default.
        rows = db._conn().execute(
            "SELECT follower_id AS uid FROM followers WHERE following_id=? "
            "UNION SELECT user_id FROM friends WHERE friend_id=? AND status='accepted' "
            "UNION SELECT friend_id FROM friends WHERE user_id=? AND status='accepted'",
            (author_id, author_id, author_id),
        ).fetchall()
        allowed_ids = {int(r["uid"]) for r in rows}

    bad = [rid for rid, _ in wraps_decoded if rid not in allowed_ids]
    if bad:
        return JSONResponse(status_code=403,
            content={"error": "Recipient not in audience", "recipient_ids": bad[:10]})

    enc_track_room = _sanitize_track_room(body.track_room)
    try:
        post_id = db.create_wall_post_encrypted(
            user_id=author_id,
            audience=aud,
            ciphertext=ct,
            wrapped_keys=wraps_decoded,
            media_data=body.media_data,
            media_type=body.media_type,
            share_enabled=1 if body.share_enabled else 0,
            allow_comments=1 if body.allow_comments else 0,
            track_title=(body.track_title or None),
            track_room=enc_track_room,
            track_mood=(body.track_mood or None),
        )
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

    # Federation: opaque ciphertext + wraps keyed by global_user_id per recipient.
    try:
        from routers import federation as federation_mod
        global_post_id, _origin = db.register_local_wall_post_global_id(int(post_id))
        fed_wraps = []
        for rid, blob in wraps_decoded:
            recip = db.get_user_by_id(int(rid)) or {}
            fed_wraps.append({
                "recipient_global_user_id": str(recip.get("global_user_id") or "").strip(),
                "recipient_nickname": str(recip.get("nickname") or "").strip(),
                "wrapped_b64": _b64.b64encode(blob).decode("ascii"),
            })
        federation_mod.enqueue_social_post_created_encrypted(
            current_user,
            global_post_id=global_post_id,
            audience=aud,
            ciphertext_b64=body.ciphertext_b64,
            wrapped_keys=fed_wraps,
            media_data=body.media_data,
            media_type=body.media_type,
            share_enabled=bool(body.share_enabled),
            allow_comments=bool(body.allow_comments),
            track_title=body.track_title,
            track_room=enc_track_room,
            track_mood=body.track_mood,
        )
    except Exception:
        pass

    return {
        "id": post_id,
        "enc_v": 2,
        "audience": aud,
        "recipients": len(wraps_decoded),
        "created_at": "just now",
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
    # Encrypted (enc_v=2) rows additionally need the viewer's wrapped
    # payload key inlined. Re-fetch with viewer scope so the client gets
    # `ciphertext_b64` + `wrapped_key_b64`.
    if post.get("enc_v") == 2:
        post = db.get_wall_post(post_id, viewer_id=viewer_id) or post
        if viewer_id != author_id and not post.get("wrapped_key_b64"):
            # Audience-mismatch: visible by legacy privacy but no wrap.
            # Refuse rather than send unreadable data.
            return JSONResponse(status_code=403,
                content={"error": "Not in audience"})
    post["reactions"] = db.get_post_reactions(post_id)
    post["i_reposted"] = 1 if db.has_wall_reposted(post_id, viewer_id) else 0
    # repost_count is already populated by get_wall_post via the
    # materialized counter column on wall_posts.
    return post


@router.get("/posts/{post_id}/media")
async def get_wall_post_media(post_id: int, current_user: dict = Depends(get_current_user)):
    """Lazy-load full media for a single wall post (privacy enforced)."""
    post = db.get_wall_post(post_id)
    if not post or not post.get("media_data"):
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    privacy = post.get("privacy") or "public"
    author_id = post.get("user_id")
    viewer_id = current_user["id"]
    if author_id and db.is_blocked_either_way(viewer_id, author_id):
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    allowed = (
        privacy == "public"
        or viewer_id == author_id
        or (privacy == "followers" and db.is_following(viewer_id, author_id))
        or (privacy == "friends" and db.are_friends(viewer_id, author_id))
    )
    if not allowed:
        return JSONResponse(status_code=403, content={"error": "Not allowed"})
    headers = {"Cache-Control": "private, max-age=86400"}
    return JSONResponse(
        content={"media_data": post["media_data"], "media_type": post.get("media_type")},
        headers=headers,
    )


@router.get("/posts/{post_id}/media-inline")
async def get_wall_post_media_inline(post_id: int, current_user: dict = Depends(get_current_user)):
    """Stream raw media bytes (decoded data URI) so <img>/<video> can use a
    URL src instead of a multi-MB JSON payload in feeds."""
    post = db.get_wall_post(post_id)
    if not post or not post.get("media_data"):
        return Response(status_code=404)
    privacy = post.get("privacy") or "public"
    author_id = post.get("user_id")
    viewer_id = current_user["id"]
    if author_id and db.is_blocked_either_way(viewer_id, author_id):
        return Response(status_code=404)
    allowed = (
        privacy == "public"
        or viewer_id == author_id
        or (privacy == "followers" and db.is_following(viewer_id, author_id))
        or (privacy == "friends" and db.are_friends(viewer_id, author_id))
    )
    if not allowed:
        return Response(status_code=403)
    md = post["media_data"]
    return _decode_data_uri_response(md, post.get("media_type"))


def _decode_data_uri_response(data_uri: str, fallback_mime: Optional[str] = None) -> Response:
    """Convert `data:<mime>;base64,<b64>` to a Response of raw bytes.
    For non-data values, redirects so the browser fetches the URL directly.

    SECURITY: the served Content-Type is forced through the media-safety
    whitelist so an attacker cannot upload `data:text/html;base64,...`
    or `data:image/svg+xml,...` and have us echo it back with the
    original mime — anything outside the image/audio/video allow-list
    becomes `application/octet-stream` + `Content-Disposition: attachment`.
    The response also carries `X-Content-Type-Options: nosniff` and a
    sandbox CSP so even a future bug serving HTML cannot run script."""
    import base64 as _b64
    from routers._media_safety import safe_media_type, media_response_headers
    s = data_uri or ""
    if not s.startswith("data:"):
        # Music URL or other plain URL — redirect
        return Response(status_code=302, headers={"Location": s})
    try:
        header, _, payload = s[5:].partition(",")
        mime, _, params = header.partition(";")
        is_b64 = "base64" in params.lower()
        raw = _b64.b64decode(payload) if is_b64 else payload.encode()
    except Exception:
        return Response(status_code=415)
    ct = safe_media_type(mime or fallback_mime)
    headers = media_response_headers(ct, filename="wall-media")
    headers["Content-Length"] = str(len(raw))
    return Response(content=raw, media_type=ct, headers=headers)


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
    if body.share_enabled is not None:
        updates["share_enabled"] = 1 if body.share_enabled else 0
    if body.allow_comments is not None:
        updates["allow_comments"] = 1 if body.allow_comments else 0
    
    if not updates:
        return JSONResponse(status_code=400, content={"error": "Nothing to update"})
    
    if db.update_wall_post(post_id, current_user["id"], **updates):
        try:
            meta = db.get_wall_post_meta(post_id)
            priv = str((meta or {}).get("privacy") or "public").lower()
            if priv in ("public", "followers"):
                from routers import federation as federation_mod
                gpid, _ = db.ensure_federation_wall_post_global_id(int(post_id))
                if gpid:
                    federation_mod.enqueue_social_post_updated(
                        current_user, global_post_id=gpid, updates=updates,
                    )
        except Exception:
            pass
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Post not found or not yours"})


@router.delete("/posts/{post_id}")
async def delete_wall_post(post_id: int, current_user: dict = Depends(get_current_user)):
    """Delete a wall post. Admins can delete any post."""
    force = bool(current_user.get("is_admin"))
    if db.delete_wall_post(post_id, current_user["id"], force=force):
        try:
            from routers import federation as federation_mod
            gpid, _ = db.ensure_federation_wall_post_global_id(int(post_id))
            if gpid:
                federation_mod.enqueue_social_post_deleted(
                    current_user,
                    global_post_id=gpid,
                    force_delete=force,
                )
        except Exception:
            pass
        # Bust the social /feed and /explore micro-caches so the deleted
        # post doesn't briefly resurface in the next 1.5s window.
        try:
            from routers import social as _social
            _social._hot_cache.clear()
        except Exception:
            pass
        # Drop the cached thumbnail so a re-uploaded video at the same
        # post id wouldn't serve the old frame.
        try:
            from routers.social import _thumb_path
            p = _thumb_path(post_id)
            if p.exists():
                p.unlink()
        except Exception:
            pass
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Post not found or not yours"})


@router.delete("/posts/{post_id}/media")
async def delete_wall_post_media(post_id: int, current_user: dict = Depends(get_current_user)):
    """Delete only the media attachment from a wall post.

    For media-only posts, require deleting the entire post instead so we don't
    leave an empty post shell behind.
    """
    # Use the lean meta fetch (no multi-MB media_data) — we only need to
    # check ownership + the has_media flag.
    post = db.get_wall_post_meta(post_id)
    if not post or int(post.get("user_id") or 0) != int(current_user["id"]):
        return JSONResponse(status_code=404, content={"error": "Post not found or not yours"})
    if not post.get("has_media"):
        return JSONResponse(status_code=400, content={"error": "Post has no media"})

    has_text = bool(str(post.get("content") or "").strip())
    has_extra = bool(str(post.get("track_title") or "").strip() or str(post.get("track_room") or "").strip())
    if not has_text and not has_extra:
        return JSONResponse(
            status_code=400,
            content={"error": "This is a media-only post. Delete the full post instead.", "code": "media_only_post"},
        )

    if db.clear_wall_post_media(post_id, current_user["id"]):
        return {"ok": True}
    return JSONResponse(status_code=400, content={"error": "Could not remove media"})


# ---------------------------------------------------------------------------
# Reactions
# ---------------------------------------------------------------------------

@router.post("/posts/{post_id}/reactions")
@limiter.limit("300/hour")
async def add_post_reaction(request: Request, post_id: int, body: AddReactionRequest, current_user: dict = Depends(get_current_user)):
    """Add/toggle a reaction to a post."""
    if not body.emoji or len(body.emoji) > 8:
        return JSONResponse(status_code=400, content={"error": "Invalid emoji"})
    if body.emoji not in ALLOWED_WALL_REACTION_EMOJIS:
        return JSONResponse(status_code=400, content={"error": "Unsupported reaction"})
    
    # Lean meta fetch — pulling the full row (with media_data) used to
    # drag a 45 MB video blob through the event loop on every like.
    post = db.get_wall_post_meta(post_id)
    if not post:
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    if post.get("user_id") and db.is_blocked_either_way(current_user["id"], post["user_id"]):
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    # Track D — non-audience accounts must not fan engagement on a post
    # they can't decrypt.
    if int(post.get("enc_v") or 0) == 2 and not db.wall_post_viewer_in_audience(post_id, current_user["id"]):
        return JSONResponse(status_code=403, content={"error": "Not in audience"})

    added = db.add_wall_reaction(post_id, current_user["id"], body.emoji)
    reactions = db.get_post_reactions(post_id)

    # Notify the post owner about the like (or remove the unread row on unlike).
    owner_id = post.get("user_id")
    if owner_id and owner_id != current_user["id"]:
        if added:
            notif_id = db.add_social_notification(
                user_id=owner_id,
                actor_id=current_user["id"],
                kind="like",
                post_id=post_id,
                emoji=body.emoji,
            )
            if notif_id is not None:
                unread = db.get_social_notification_unread_count(owner_id)
                await _push_social_notif(owner_id, {
                    "type": "social_notification",
                    "event": "like",
                    "id": notif_id,
                    "actor": current_user["nickname"],
                    "actor_avatar": current_user.get("avatar"),
                    "post_id": post_id,
                    "emoji": body.emoji,
                    "unread": unread,
                })
        else:
            removed = db.remove_social_like_notification(
                owner_id, current_user["id"], post_id
            )
            if removed:
                unread = db.get_social_notification_unread_count(owner_id)
                await _push_social_notif(owner_id, {
                    "type": "social_notification",
                    "event": "unlike",
                    "actor": current_user["nickname"],
                    "post_id": post_id,
                    "unread": unread,
                })

        try:
            from routers import federation as federation_mod
            gpid, _ = db.ensure_federation_wall_post_global_id(int(post_id))
            if gpid:
                federation_mod.enqueue_social_reaction_changed(
                    current_user,
                    global_post_id=gpid,
                    owner_nickname=post.get("nickname") or "",
                    emoji=body.emoji,
                    active=bool(added),
                )
        except Exception:
            _log.debug("reaction federation emit failed", exc_info=True)

    return {"added": added, "reactions": reactions}


@router.get("/posts/{post_id}/reactions/detail")
@limiter.limit("600/hour")
async def get_post_reactions_detail(request: Request, post_id: int, current_user: dict = Depends(get_current_user)):
    """Get per-user reaction rows for the reaction detail modal."""
    post = db.get_wall_post_meta(post_id)
    if not post:
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    if post.get("user_id") and db.is_blocked_either_way(current_user["id"], post["user_id"]):
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    rows = db.get_post_reactions_detail(post_id, limit=500)
    return {"reactions": rows, "viewer": current_user["nickname"]}


@router.get("/posts/{post_id}/reactions")
async def get_post_reactions_list(post_id: int):
    """Get all reactions for a post."""
    reactions = db.get_post_reactions(post_id)
    return {"reactions": reactions}


# ---------------------------------------------------------------------------
# Reposts
# ---------------------------------------------------------------------------

@router.post("/posts/{post_id}/repost")
@limiter.limit("180/hour")
async def toggle_post_repost(
    request: Request,
    post_id: int,
    body: Optional[ToggleRepostRequest] = None,
    current_user: dict = Depends(get_current_user),
):
    """Toggle repost on a wall post.

    Repost is only allowed for posts that are share-enabled and visible to the
    current viewer under existing privacy rules.
    """
    post = db.get_wall_post_meta(post_id)
    if not post:
        return JSONResponse(status_code=404, content={"error": "Post not found"})

    viewer_id = current_user["id"]
    owner_id = int(post.get("user_id") or 0)
    privacy = (post.get("privacy") or "public").lower()
    share_enabled = bool(int(post.get("share_enabled") or 0))

    if owner_id and db.is_blocked_either_way(viewer_id, owner_id):
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    if not share_enabled:
        return JSONResponse(status_code=403, content={"error": "Repost is disabled for this post"})
    if privacy in ("friends", "private"):
        return JSONResponse(status_code=403, content={"error": "This post cannot be reposted"})

    allowed = (
        privacy == "public"
        or viewer_id == owner_id
        or (privacy == "followers" and (db.is_following(viewer_id, owner_id) or db.are_friends(viewer_id, owner_id)))
    )
    if not allowed:
        return JSONResponse(status_code=403, content={"error": "Not allowed to repost this post"})

    quote = ((body.quote or "").strip() if body else "") or None
    if quote and len(quote) > 1000:
        return JSONResponse(status_code=400, content={"error": "Quote too long (max 1000 chars)"})

    reposted = db.toggle_wall_repost(post_id, viewer_id, quote_text=quote)
    repost_count = db.get_wall_repost_count(post_id)

    if reposted and owner_id and owner_id != viewer_id:
        try:
            notif_id = db.add_social_notification(
                user_id=owner_id,
                actor_id=viewer_id,
                kind="repost",
                post_id=post_id,
                preview=(quote[:140] if quote else None),
            )
            if notif_id is not None:
                unread = db.get_social_notification_unread_count(owner_id)
                await _push_social_notif(owner_id, {
                    "type": "social_notification",
                    "event": "repost",
                    "id": notif_id,
                    "actor": current_user["nickname"],
                    "actor_avatar": current_user.get("avatar"),
                    "post_id": post_id,
                    "preview": (quote[:140] if quote else None),
                    "unread": unread,
                })
        except Exception:
            _log.debug("repost notif failed", exc_info=True)

        try:
            from routers import federation as federation_mod
            gpid, _ = db.ensure_federation_wall_post_global_id(int(post_id))
            if gpid:
                federation_mod.enqueue_social_repost_created(
                    current_user,
                    global_post_id=gpid,
                    owner_nickname=post.get("nickname") or "",
                    quote=quote,
                    active=True,
                )
        except Exception:
            _log.debug("repost federation emit failed", exc_info=True)
    elif not reposted:
        try:
            from routers import federation as federation_mod
            gpid, _ = db.ensure_federation_wall_post_global_id(int(post_id))
            if gpid:
                federation_mod.enqueue_social_repost_created(
                    current_user,
                    global_post_id=gpid,
                    owner_nickname=post.get("nickname") or "",
                    quote=None,
                    active=False,
                )
        except Exception:
            pass

    return {
        "ok": True,
        "reposted": reposted,
        "repost_count": repost_count,
    }


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------

@router.get("/posts/{post_id}/comments")
async def get_post_comments(post_id: int, limit: int = Query(50, le=100),
                            current_user: dict = Depends(get_current_user)):
    """Get comments for a post."""
    post = db.get_wall_post_meta(post_id)
    if not post:
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    if int(post.get("enc_v") or 0) == 2 and not db.wall_post_viewer_in_audience(post_id, current_user["id"]):
        return JSONResponse(status_code=403, content={"error": "Not in audience"})

    comments = db.get_post_comments(post_id, limit, viewer_id=current_user["id"])
    return {"comments": comments, "allow_comments": bool(post.get("allow_comments", 1))}


@router.post("/posts/{post_id}/comments")
@limiter.limit("120/hour")
async def add_post_comment(request: Request, post_id: int, body: AddCommentRequest, current_user: dict = Depends(get_current_user)):
    """Add a comment to a post."""
    # `.strip()` only for the empty-check; the original content is stored
    # so newlines / leading whitespace are not silently dropped.
    if not body.content or not body.content.strip():
        return JSONResponse(status_code=400, content={"error": "Comment cannot be empty"})

    if len(body.content) > 1000:
        return JSONResponse(status_code=400, content={"error": "Comment too long (max 1000 chars)"})

    # Block guard: author blocked commenter (or vice versa) => hide post
    post = db.get_wall_post_meta(post_id)
    if not post:
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    if post.get("user_id") and db.is_blocked_either_way(current_user["id"], post["user_id"]):
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    if int(post.get("enc_v") or 0) == 2 and not db.wall_post_viewer_in_audience(post_id, current_user["id"]):
        return JSONResponse(status_code=403, content={"error": "Not in audience"})

    comment_id = db.add_wall_comment(post_id, current_user["id"], body.content)
    if comment_id is None:
        return JSONResponse(status_code=403, content={"error": "Comments disabled on this post"})

    # Notify the post owner about the new comment.
    owner_id = post.get("user_id")
    if owner_id and owner_id != current_user["id"]:
        preview = body.content.strip()
        notif_id = db.add_social_notification(
            user_id=owner_id,
            actor_id=current_user["id"],
            kind="comment",
            post_id=post_id,
            comment_id=comment_id,
            preview=preview,
        )
        if notif_id is not None:
            unread = db.get_social_notification_unread_count(owner_id)
            await _push_social_notif(owner_id, {
                "type": "social_notification",
                "event": "comment",
                "id": notif_id,
                "actor": current_user["nickname"],
                "actor_avatar": current_user.get("avatar"),
                "post_id": post_id,
                "comment_id": comment_id,
                "preview": preview[:140],
                "unread": unread,
            })

        try:
            from routers import federation as federation_mod
            gpid, _ = db.ensure_federation_wall_post_global_id(int(post_id))
            gcid, _ = db.register_local_wall_comment_global_id(int(comment_id))
            if gpid:
                federation_mod.enqueue_social_comment_created(
                    current_user,
                    global_post_id=gpid,
                    global_comment_id=gcid,
                    owner_nickname=post.get("nickname") or "",
                    content=body.content.strip(),
                )
        except Exception:
            _log.debug("comment federation emit failed", exc_info=True)

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


class CommentVoteRequest(BaseModel):
    value: int


@router.post("/posts/{post_id}/comments/{comment_id}/vote")
@limiter.limit("60/minute")
async def vote_wall_comment(
    request: Request,
    post_id: int,
    comment_id: int,
    body: CommentVoteRequest,
    current_user: dict = Depends(get_current_user)
):
    """YouTube-style 👍/👎 on a wall-post comment.

    body.value is -1, 0 (clear), or 1. Idempotent.
    """
    if body.value not in (-1, 0, 1):
        return JSONResponse(status_code=400, content={"error": "Invalid vote value"})
    post = db.get_wall_post_meta(post_id)
    if not post:
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    author_id = post.get("user_id")
    viewer_id = current_user["id"]
    if author_id and db.is_blocked_either_way(viewer_id, author_id):
        return JSONResponse(status_code=404, content={"error": "Post not found"})
    privacy = post.get("privacy") or "public"
    allowed = (
        privacy == "public"
        or viewer_id == author_id
        or (privacy == "followers" and db.is_following(viewer_id, author_id))
        or (privacy == "friends" and db.are_friends(viewer_id, author_id))
    )
    if not allowed:
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    comment = db.get_wall_comment(comment_id)
    # Cross-check the comment belongs to this post (anti-IDOR).
    if not comment or int(comment.get("post_id") or 0) != int(post_id):
        return JSONResponse(status_code=404, content={"error": "Comment not found"})
    # Block guard: don't let blocked users vote on each other's comments.
    if comment.get("user_id") and db.is_blocked_either_way(viewer_id, comment["user_id"]):
        return JSONResponse(status_code=404, content={"error": "Comment not found"})
    res = db.set_comment_vote("wall_comment", comment_id, viewer_id, body.value)
    return {
        "ok": True,
        "like_count": res["up"],
        "dislike_count": res["down"],
        "my_vote": res["my_vote"],
    }


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
            # Track B: store the raw input verbatim (capped) so the
            # editor can round-trip exactly what the user typed; also
            # compute and store the sanitised declaration list in
            # `custom_style`, which is the ONLY column the renderer
            # reads. The sanitiser is total — bad input becomes an
            # empty style, never an error — so we don't 400 on CSS.
            raw_css = body.custom_css or ""
            if len(raw_css) > 10240:
                raw_css = raw_css[:10240]
            sanitised = sanitize_inline_style(raw_css)
            updates.append("custom_css=?")
            params.append(raw_css)
            updates.append("custom_style=?")
            params.append(sanitised)
        
        if not updates:
            return JSONResponse(status_code=400, content={"error": "Nothing to update"})
        
        params.append(current_user["id"])
        con.execute(f"UPDATE users SET {', '.join(updates)} WHERE id=?", params)
        row = con.execute("""
            SELECT wall_enabled, wall_comments_enabled, mood, custom_css, custom_style,
                   global_user_id, nickname, display_name, avatar, bio, status_msg, presence, identity_pubkey
            FROM users WHERE id=?
        """, (current_user["id"],)).fetchone()

    try:
        if row:
            db.insert_federation_outbox_event({
                "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
                "event_type": "user.profile.updated",
                "payload": {
                    "global_user_id": row["global_user_id"] or "",
                    "nickname": row["nickname"] or current_user.get("nickname") or "",
                    "display_name": row["display_name"] or "",
                    "avatar": row["avatar"] or "",
                    "bio": row["bio"] or "",
                    "status_msg": row["status_msg"] or "",
                    "presence": row["presence"] or "online",
                    "mood": row["mood"] or "",
                    # Federation carries only the sanitised inline-style
                    # declaration list. Raw `custom_css` stays local —
                    # the peer has no editor UI that needs it, and we
                    # don't want to ship un-validated bytes between
                    # nodes.
                    "custom_style": row["custom_style"] or "",
                    "identity_pubkey": row["identity_pubkey"] or "",
                },
            })
    except Exception:
        pass
    
    return dict(row) if row else {"ok": True}


@router.get("/settings")
async def get_wall_settings(current_user: dict = Depends(get_current_user)):
    """Get user's wall settings."""
    with db._conn() as con:
        row = con.execute("""
            SELECT wall_enabled, wall_comments_enabled, mood, custom_css, custom_style
            FROM users WHERE id=?
        """, (current_user["id"],)).fetchone()
    
    return dict(row) if row else {}
