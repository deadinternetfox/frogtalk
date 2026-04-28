"""Room management routes."""
import asyncio
import json
import re
import time
import uuid
from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from typing import Optional

import database as db
from deps import get_current_user
from ws_manager import voice_manager

router = APIRouter(prefix="/rooms", tags=["rooms"])
limiter = Limiter(key_func=get_remote_address)

ROOM_NAME_RE = re.compile(r"^[a-z0-9_\-]{1,32}$")


class CreateRoomRequest(BaseModel):
    name: str
    description: str = ""
    type: str = "public"
    room_key_hint: Optional[str] = None
    icon: Optional[str] = None
    channel_type: str = "text"  # text, music, or voice (legacy)
    invite_only: int = 0  # 0 or 1


class DeleteRoomRequest(BaseModel):
    pass


def _normalize_room_icon(icon: Optional[str]) -> Optional[str]:
    """Validate and normalize room icon value (emoji, URL, or data image)."""
    if icon is None:
        return None

    icon = icon.strip()
    if icon == "":
        return ""

    if icon.startswith("data:image/"):
        allowed_prefixes = (
            "data:image/png;base64,",
            "data:image/jpeg;base64,",
            "data:image/webp;base64,",
            "data:image/gif;base64,",
        )
        if not any(icon.startswith(p) for p in allowed_prefixes):
            raise ValueError("Room image must be PNG, JPEG, WEBP, or GIF")
        if len(icon) > 3_000_000:
            raise ValueError("Room image is too large")
        return icon

    if icon.startswith("https://") or icon.startswith("http://"):
        if len(icon) > 2048:
            raise ValueError("Room image URL is too long")
        return icon

    # Backward compatibility: allow short emoji/text icon values.
    if len(icon) > 8:
        raise ValueError("Emoji icon must be 8 characters or fewer")
    return icon


@router.get("")
async def list_rooms(current_user: dict = Depends(get_current_user)):
    rooms = db.list_rooms()
    joined_ids = db.get_user_joined_room_ids(current_user["id"])
    is_admin = bool(current_user.get("is_admin"))
    visible = []
    for r in rooms:
        r["joined"] = r["id"] in joined_ids
        # Private rooms are invite-only: hide them from listing unless the
        # requesting user is already a member or is a server admin.
        if r.get("type") == "private" and not r["joined"] and not is_admin:
            continue
        visible.append(r)

    # Apply per-user Discord-style drag-to-reorder. Rooms named in the saved
    # order list float to the top in that order; everything else preserves
    # the original server order behind them.
    order_raw = db.get_room_order(current_user["id"])
    if order_raw:
        try:
            order = json.loads(order_raw)
            if isinstance(order, list):
                rank = {n: i for i, n in enumerate(order) if isinstance(n, str)}
                visible.sort(key=lambda r: rank.get(r.get("name"), 10**9))
        except (ValueError, TypeError):
            pass
    return {"rooms": visible}


class ReorderRoomsRequest(BaseModel):
    order: list[str]


@router.post("/reorder")
async def reorder_rooms(body: ReorderRoomsRequest,
                        current_user: dict = Depends(get_current_user)):
    """Persist this user's preferred channel ordering. The body's `order` is
    a list of room names (top-to-bottom). Unknown / duplicate names are
    silently ignored — we only persist a clean, deduped list."""
    seen: set = set()
    cleaned: list = []
    for name in body.order or []:
        if not isinstance(name, str):
            continue
        if not ROOM_NAME_RE.match(name):
            continue
        if name in seen:
            continue
        seen.add(name)
        cleaned.append(name)
        if len(cleaned) >= 500:
            break
    db.set_room_order(current_user["id"], json.dumps(cleaned))
    return {"ok": True}


@router.post("")
@limiter.limit("10/hour")
async def create_room(request: Request, body: CreateRoomRequest,
                      current_user: dict = Depends(get_current_user)):
    if not ROOM_NAME_RE.match(body.name):
        return JSONResponse(status_code=400, content={
            "error": "Room name must be lowercase letters, numbers, _ or - (max 32)"
        })
    if body.type not in ("public", "private"):
        return JSONResponse(status_code=400, content={"error": "Room type must be public or private"})
    # Legacy 'voice' is folded into 'music' at the UI — reject it server-side too.
    if body.channel_type == "voice":
        body.channel_type = "music"
    if body.channel_type not in ("text", "music"):
        return JSONResponse(status_code=400, content={"error": "Channel type must be text or music"})

    try:
        icon = _normalize_room_icon(body.icon)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

    room_id = db.create_room(
        name=body.name,
        description=body.description[:256],
        room_type=body.type,
        owner_id=current_user["id"],
        room_key_hint=body.room_key_hint,
        icon=icon,
        channel_type=body.channel_type
    )
    if room_id is None:
        return JSONResponse(status_code=409, content={"error": "Room name already exists"})
    # Set invite_only if requested
    if body.invite_only:
        db.update_room_settings(body.name, invite_only=1)
    # Auto-join creator
    db.join_room(current_user["id"], room_id)
    try:
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "room.member.joined",
            "payload": {
                "room_name": body.name,
                "nickname": current_user["nickname"],
            },
        })
    except Exception:
        pass
    return {"ok": True, "id": room_id, "name": body.name}


@router.delete("/{room_name}")
async def delete_room(room_name: str, current_user: dict = Depends(get_current_user)):
    ok = db.delete_room(room_name, current_user["id"], bool(current_user.get("is_admin")))
    if not ok:
        return JSONResponse(status_code=403, content={"error": "Not found or not authorised"})
    return {"ok": True}


# ─── Room settings ────────────────────────────────────────────────────────────

class UpdateRoomRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    slowmode: Optional[int] = None
    channel_type: Optional[str] = None  # text, music, or voice (legacy)
    channel_theme: Optional[str] = None  # JSON theme object
    invite_only: Optional[int] = None  # 0 or 1
    who_can_invite: Optional[str] = None  # everyone, mods, owner
    banner: Optional[str] = None  # data URL or image URL
    about: Optional[str] = None  # rich channel about text


@router.get("/{room_name}")
async def get_room(room_name: str, current_user: dict = Depends(get_current_user)):
    """Get room details including settings and moderators."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    
    # Get moderators
    mods = db.get_room_moderators(room["id"])
    
    # Check if current user can edit
    can_edit = db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin")))
    
    return {
        "room": room,
        "moderators": mods,
        "can_edit": can_edit
    }


@router.patch("/{room_name}")
async def update_room(room_name: str, body: UpdateRoomRequest,
                      current_user: dict = Depends(get_current_user)):
    """Update room settings. Only owner, mods, or admin can update."""
    if not db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin"))):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    
    # Validate new name if provided
    if body.name and not ROOM_NAME_RE.match(body.name):
        return JSONResponse(status_code=400, content={
            "error": "Room name must be lowercase letters, numbers, _ or - (max 32)"
        })
    
    # Validate slowmode (0-3600 seconds)
    if body.slowmode is not None and (body.slowmode < 0 or body.slowmode > 3600):
        return JSONResponse(status_code=400, content={"error": "Slowmode must be 0-3600 seconds"})
    
    # Validate channel_type
    if body.channel_type is not None and body.channel_type not in ("text", "music", "voice"):
        return JSONResponse(status_code=400, content={"error": "Channel type must be text or music"})

    # Validate invite_only
    if body.invite_only is not None and body.invite_only not in (0, 1):
        return JSONResponse(status_code=400, content={"error": "invite_only must be 0 or 1"})
    
    # Validate who_can_invite
    if body.who_can_invite is not None and body.who_can_invite not in ("everyone", "mods", "owner"):
        return JSONResponse(status_code=400, content={"error": "who_can_invite must be everyone, mods, or owner"})

    icon: Optional[str] = None
    if body.icon is not None:
        try:
            icon = _normalize_room_icon(body.icon)
        except ValueError as e:
            return JSONResponse(status_code=400, content={"error": str(e)})
    
    ok = db.update_room_settings(
        room_name,
        name=body.name,
        description=body.description[:256] if body.description else None,
        icon=icon,
        slowmode=body.slowmode,
        channel_type=body.channel_type,
        channel_theme=body.channel_theme[:4096] if body.channel_theme else body.channel_theme,
        invite_only=body.invite_only,
        who_can_invite=body.who_can_invite,
        banner=body.banner,
        about=body.about[:4000] if body.about is not None else None
    )
    if not ok:
        return JSONResponse(status_code=409, content={"error": "Update failed (name conflict?)"})
    return {"ok": True}


# ─── Moderators ───────────────────────────────────────────────────────────────

class ModRequest(BaseModel):
    user_id: int


@router.post("/{room_name}/moderators")
async def add_moderator(room_name: str, body: ModRequest,
                        current_user: dict = Depends(get_current_user)):
    """Add a moderator to a room. Only owner or admin can add mods."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    
    # Only owner or admin can add mods
    is_owner = room["owner_id"] == current_user["id"]
    is_admin = bool(current_user.get("is_admin"))
    if not is_owner and not is_admin:
        return JSONResponse(status_code=403, content={"error": "Only room owner or admin can add moderators"})
    
    ok = db.add_room_moderator(room["id"], body.user_id, current_user["id"])
    if not ok:
        return JSONResponse(status_code=409, content={"error": "User is already a moderator"})
    return {"ok": True}


@router.delete("/{room_name}/moderators/{user_id}")
async def remove_moderator(room_name: str, user_id: int,
                           current_user: dict = Depends(get_current_user)):
    """Remove a moderator from a room."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    
    is_owner = room["owner_id"] == current_user["id"]
    is_admin = bool(current_user.get("is_admin"))
    if not is_owner and not is_admin:
        return JSONResponse(status_code=403, content={"error": "Only room owner or admin can remove moderators"})
    
    ok = db.remove_room_moderator(room["id"], user_id)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "User is not a moderator"})
    return {"ok": True}


# ─── Room bans ────────────────────────────────────────────────────────────────

class BanRequest(BaseModel):
    user_id: int
    reason: str = ""
    duration_minutes: Optional[int] = None  # None = permanent


@router.post("/{room_name}/bans")
async def ban_user(room_name: str, body: BanRequest,
                   current_user: dict = Depends(get_current_user)):
    """Ban a user from a room. Mods, owner, or admin can ban."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    
    if not db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin"))):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    
    # Can't ban owner or admin
    target = db.get_user_by_id(body.user_id)
    if not target:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    if target.get("is_admin") or target["id"] == room["owner_id"]:
        return JSONResponse(status_code=403, content={"error": "Cannot ban this user"})
    
    ok = db.ban_user_from_room(room["id"], body.user_id, current_user["id"], 
                                body.reason, body.duration_minutes)
    if not ok:
        return JSONResponse(status_code=500, content={"error": "Ban failed"})

    # Notify the banned user across all their connections so the channel
    # closes Discord-style with a polished modal showing the reason.
    try:
        from ws_manager import manager
        bans = db.get_room_bans(room["id"]) or []
        match = next((b for b in bans if int(b.get("user_id") or 0) == int(body.user_id)), None)
        expires_at = match.get("expires_at") if match else None
        await manager.send_to_user(body.user_id, {
            "type": "room_ban",
            "room": room_name,
            "reason": body.reason or "",
            "banned_by": current_user.get("nickname") or "moderator",
            "expires_at": expires_at,
            "duration_minutes": body.duration_minutes,
        })
        # Also broadcast a presence-style notice to the room so members see
        # the ban land (without leaking the reason).
        await manager.broadcast_room(room_name, {
            "type": "user_banned",
            "room": room_name,
            "user_id": body.user_id,
            "nickname": target.get("nickname"),
            "banned_by": current_user.get("nickname"),
        })
    except Exception:
        pass
    return {"ok": True}


@router.delete("/{room_name}/bans/{user_id}")
async def unban_user(room_name: str, user_id: int,
                     current_user: dict = Depends(get_current_user)):
    """Unban a user from a room."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    
    if not db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin"))):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    
    ok = db.unban_user_from_room(room["id"], user_id)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "User is not banned"})
    return {"ok": True}


@router.get("/{room_name}/bans")
async def get_bans(room_name: str, current_user: dict = Depends(get_current_user)):
    """Get all bans for a room."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    
    if not db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin"))):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    
    return {"bans": db.get_room_bans(room["id"])}


# ─── Pinned messages ──────────────────────────────────────────────────────────

@router.get("/{room_name}/pins")
async def get_pins(room_name: str, current_user: dict = Depends(get_current_user)):
    """Get all pinned messages for a room."""
    return {"pins": db.get_pinned_messages(room_name)}


@router.post("/{room_name}/pins/{msg_id}")
async def pin_message(room_name: str, msg_id: int,
                      current_user: dict = Depends(get_current_user)):
    """Pin a message. Mods, owner, or admin can pin."""
    if not db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin"))):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    
    ok = db.pin_message(room_name, msg_id, current_user["id"])
    if not ok:
        return JSONResponse(status_code=409, content={"error": "Message already pinned"})
    return {"ok": True}


@router.delete("/{room_name}/pins/{msg_id}")
async def unpin_message(room_name: str, msg_id: int,
                        current_user: dict = Depends(get_current_user)):
    """Unpin a message."""
    if not db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin"))):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    
    db.unpin_message(room_name, msg_id)
    return {"ok": True}


@router.post("/{room_name}/join")
async def join_room(room_name: str, current_user: dict = Depends(get_current_user)):
    """Join a channel."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    db.join_room(current_user["id"], room["id"])
    try:
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "room.member.joined",
            "payload": {
                "room_name": room_name,
                "nickname": current_user["nickname"],
            },
        })
    except Exception:
        pass
    return {"ok": True}


@router.get("/{room_name}/members")
async def get_channel_members(room_name: str,
                              current_user: dict = Depends(get_current_user)):
    """Return all joined members of a channel with presence + last_seen.
    Used by the right-hand sidebar to split online vs offline users."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    members = db.get_channel_members(room["id"])
    return {"members": members}


@router.get("/{room_name}/voice-participants")
async def get_voice_participants(room_name: str,
                                 current_user: dict = Depends(get_current_user)):
    """Return who is currently in the voice call of this channel.
    Used to render the Discord-style 'in voice' bar above chat even for users
    who are not (yet) in the call themselves."""
    return {"participants": voice_manager.participants(room_name)}


@router.post("/{room_name}/leave")
async def leave_room(room_name: str, current_user: dict = Depends(get_current_user)):
    """Leave a channel. If the leaver is the owner, ownership transfers to
    the longest-serving moderator. If no moderators exist, the room is deleted."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    was_owner = room.get("owner_id") == current_user["id"]
    db.leave_room(current_user["id"], room["id"])
    try:
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "room.member.left",
            "payload": {
                "room_name": room_name,
                "nickname": current_user["nickname"],
            },
        })
    except Exception:
        pass
    # Determine what happened so the client can react accordingly
    if was_owner:
        after = db.get_room_by_name(room_name)
        if not after:
            return {"ok": True, "owner_action": "deleted"}
        return {"ok": True, "owner_action": "transferred",
                "new_owner_id": after.get("owner_id")}
    return {"ok": True}


# ─── Music channels: queue + DJs ─────────────────────────────────────────────

class AddTrackRequest(BaseModel):
    url: str


class ToggleDJOnlyRequest(BaseModel):
    dj_only: int


# YouTube URL → video id
_YT_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?v=|shorts/|embed/|v/)|youtu\.be/)([A-Za-z0-9_-]{11})"
)
_SPOTIFY_RE = re.compile(r"open\.spotify\.com/(track|episode|playlist)/([A-Za-z0-9]+)")
# SoundCloud: accept soundcloud.com/{user}/{track} and on.soundcloud.com/{slug}
_SOUNDCLOUD_RE = re.compile(
    r"(?:https?://)?(?:(?:www|m|on)\.)?soundcloud\.com/([^\s?#]+)",
    re.IGNORECASE,
)


def _can_queue(room: dict, user_id: int, is_admin: bool) -> bool:
    """Whether the user can submit tracks to this music room."""
    if is_admin:
        return True
    if room.get("owner_id") == user_id:
        return True
    if not room.get("dj_only_queue"):
        return True
    # dj_only — must be DJ
    return db.dj_is(room["name"], user_id)


def _can_control(room_name: str, user_id: int, is_admin: bool) -> bool:
    """Skip/clear/delete permissions: DJs + moderators + owner + admin."""
    if db.can_moderate_room(room_name, user_id, is_admin):
        return True
    return db.dj_is(room_name, user_id)


def _parse_track_url(url: str):
    """Return (provider, video_id, embed_url) or (None, None, None)."""
    url = (url or "").strip()
    if not url:
        return None, None, None
    m = _YT_RE.search(url)
    if m:
        vid = m.group(1)
        return "youtube", vid, f"https://www.youtube.com/embed/{vid}?autoplay=1"
    m = _SPOTIFY_RE.search(url)
    if m:
        kind, vid = m.group(1), m.group(2)
        return "spotify", f"{kind}/{vid}", f"https://open.spotify.com/embed/{kind}/{vid}"
    m = _SOUNDCLOUD_RE.search(url)
    if m:
        # Normalize to canonical URL; the SoundCloud widget resolves slug-based
        # and on.soundcloud.com short links server-side when given the full URL.
        full = url if url.lower().startswith("http") else f"https://{url.lstrip('/')}"
        import urllib.parse as _up
        embed = (
            "https://w.soundcloud.com/player/?url="
            + _up.quote(full, safe="")
            + "&auto_play=true&show_artwork=true&visual=false&hide_related=true"
        )
        return "soundcloud", full, embed
    return None, None, None


async def _fetch_yt_meta(video_id: str):
    """Fetch title + thumbnail via YouTube oEmbed (no API key)."""
    try:
        import urllib.request, urllib.parse, json as _json
        u = "https://www.youtube.com/oembed?" + urllib.parse.urlencode({
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "format": "json"
        })
        req = urllib.request.Request(u, headers={"User-Agent": "FrogTalk/1.0"})
        # Run the blocking urlopen in a worker thread so the event loop
        # is not stalled for up to 4s while we wait on YouTube.
        def _blocking_fetch():
            with urllib.request.urlopen(req, timeout=4) as resp:
                return resp.read().decode("utf-8")
        raw = await asyncio.to_thread(_blocking_fetch)
        data = _json.loads(raw)
        return data.get("title", ""), data.get("thumbnail_url", "")
    except Exception:
        return "", f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


# Track-playback start timestamps so joiners can sync to the current position.
# In-memory only — we don't need persistence for this (on restart the queue will
# just start from the head again, which is acceptable).
import time as _time
_music_head_started: dict = {}  # room_name -> (track_id, unix_seconds)


def set_music_head_anchor(room_name: str, track_id: int, started_unix: float) -> None:
    """Set shared playhead anchor for a room's current head track."""
    try:
        room_key = str(room_name)
        track_num = int(track_id)
        started_num = float(started_unix)
        _music_head_started[room_key] = (track_num, started_num)
        db.set_music_room_anchor(room_key, track_num, started_num)
    except Exception:
        pass


def clear_music_head_anchor(room_name: str) -> None:
    room_key = str(room_name)
    _music_head_started.pop(room_key, None)
    try:
        db.clear_music_room_anchor(room_key)
    except Exception:
        pass


def _emit_federation_room_event(event_type: str, payload: dict) -> None:
    try:
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": event_type,
            "payload": payload,
        })
    except Exception:
        pass


def _music_position_sec(room_name: str, current_track: dict | None) -> int:
    """Return elapsed seconds since the current head track started playing.

    The first time we see a given head track we stamp it with 'now'; subsequent
    joiners compute elapsed from that stamp. When the head changes (skip /
    add-to-empty / clear) the stamp is replaced or cleared.
    """
    if not current_track:
        clear_music_head_anchor(room_name)
        return 0
    tid = current_track.get("id")
    rec = _music_head_started.get(room_name)
    if not rec:
        persisted = db.get_music_room_anchor(room_name)
        if persisted and int(persisted.get("track_id") or 0) == int(tid or 0):
            rec = (int(persisted["track_id"]), float(persisted["started_unix"]))
            _music_head_started[room_name] = rec
    now = _time.time()
    if not rec or rec[0] != tid:
        set_music_head_anchor(room_name, int(tid), now)
        return 0
    return max(0, int(now - rec[1]))


@router.get("/{room_name}/queue")
async def music_get_queue(room_name: str, current_user: dict = Depends(get_current_user)):
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    queue = db.music_get_queue(room_name)
    djs = db.dj_list(room_name)
    is_admin = bool(current_user.get("is_admin"))
    current = queue[0] if queue else None
    position_sec = _music_position_sec(room_name, current)
    return {
        "queue": queue,
        "djs": djs,
        "dj_only": bool(room.get("dj_only_queue")),
        "can_submit": _can_queue(room, current_user["id"], is_admin),
        "can_control": _can_control(room_name, current_user["id"], is_admin),
        "is_dj": db.dj_is(room_name, current_user["id"]) or room.get("owner_id") == current_user["id"],
        "position_sec": position_sec,
    }


@router.post("/{room_name}/queue")
async def music_add_to_queue(room_name: str, body: AddTrackRequest,
                             current_user: dict = Depends(get_current_user)):
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    is_admin = bool(current_user.get("is_admin"))
    if not _can_queue(room, current_user["id"], is_admin):
        return JSONResponse(status_code=403, content={"error": "Only DJs can add tracks in this channel"})

    provider, video_id, _embed = _parse_track_url(body.url)
    if not provider:
        return JSONResponse(status_code=400, content={
            "error": "Unsupported link. Paste a YouTube, Spotify, or SoundCloud URL."
        })
    title, thumb = "", ""
    if provider == "youtube":
        title, thumb = await _fetch_yt_meta(video_id)
    elif provider == "spotify":
        title = body.url.rsplit("/", 1)[-1]
        thumb = ""
    elif provider == "soundcloud":
        # Best-effort title from the slug; widget itself renders full artwork.
        try:
            slug = video_id.rstrip("/").rsplit("/", 1)[-1]
            title = slug.replace("-", " ").strip()[:120] or "SoundCloud track"
        except Exception:
            title = "SoundCloud track"
        thumb = ""

    had_current = db.music_get_current(room_name)
    track_id = db.music_add_track(
        room_name=room_name,
        submitter_id=current_user["id"],
        submitter_nick=current_user["nickname"],
        provider=provider,
        video_id=video_id,
        url=body.url.strip(),
        title=title,
        thumbnail=thumb,
    )
    track = {
        "id": track_id, "room_name": room_name,
        "submitter_id": current_user["id"],
        "submitter_nick": current_user["nickname"],
        "provider": provider, "video_id": video_id,
        "url": body.url.strip(), "title": title, "thumbnail": thumb,
        "played": 0,
    }
    start_unix = None
    if not had_current:
        start_unix = int(time.time())
        set_music_head_anchor(room_name, int(track_id), float(start_unix))

    _emit_federation_room_event("room.music.track.added", {
        "room_name": room_name,
        "submitter_nick": current_user["nickname"],
        "provider": provider,
        "video_id": video_id,
        "url": body.url.strip(),
        "title": title,
        "thumbnail": thumb,
        "duration": 0,
        "make_current": not bool(had_current),
        "start_unix": start_unix,
    })

    # Broadcast to room participants
    try:
        from ws_manager import manager
        await manager.broadcast_room(room_name, {
            "type": "music_track_added", "room": room_name, "track": track
        })
    except Exception:
        pass
    return {"ok": True, "track": track}


@router.delete("/{room_name}/queue/{track_id}")
async def music_delete_track(room_name: str, track_id: int,
                             current_user: dict = Depends(get_current_user)):
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    is_admin = bool(current_user.get("is_admin"))
    # Submitter can delete their own track; controllers can delete anything
    current = db.music_get_current(room_name)
    with db._conn() as con:
        row = con.execute(
            "SELECT * FROM music_queue WHERE id=? AND room_name=?",
            (track_id, room_name)
        ).fetchone()
    if not row:
        return JSONResponse(status_code=404, content={"error": "Track not found"})
    is_submitter = row["submitter_id"] == current_user["id"]
    if not (is_submitter or _can_control(room_name, current_user["id"], is_admin)):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})

    removed_was_head = bool(current and int(current.get("id") or 0) == int(track_id))
    db.music_delete_track(track_id, room_name)
    next_start_unix = None
    if removed_was_head:
        next_current = db.music_get_current(room_name)
        if next_current:
            next_start_unix = int(time.time())
            set_music_head_anchor(room_name, int(next_current["id"]), float(next_start_unix))
        else:
            clear_music_head_anchor(room_name)

    _emit_federation_room_event("room.music.track.removed", {
        "room_name": room_name,
        "provider": str(row["provider"] or ""),
        "video_id": str(row["video_id"] or ""),
        "url": str(row["url"] or ""),
        "removed_was_head": removed_was_head,
        "next_start_unix": next_start_unix,
    })

    try:
        from ws_manager import manager
        await manager.broadcast_room(room_name, {
            "type": "music_track_removed", "room": room_name, "track_id": track_id
        })
    except Exception:
        pass
    return {"ok": True}


@router.post("/{room_name}/queue/skip")
async def music_skip(room_name: str, current_user: dict = Depends(get_current_user)):
    """Mark the current head track as played, advancing the queue."""
    is_admin = bool(current_user.get("is_admin"))
    if not _can_control(room_name, current_user["id"], is_admin):
        return JSONResponse(status_code=403, content={"error": "Only DJs or mods can skip"})
    current = db.music_get_current(room_name)
    if current:
        db.music_mark_played(current["id"], room_name)
    next_current = db.music_get_current(room_name)
    next_start_unix = int(time.time()) if next_current else None
    if next_current:
        set_music_head_anchor(room_name, int(next_current["id"]), float(next_start_unix))
    else:
        clear_music_head_anchor(room_name)

    _emit_federation_room_event("room.music.track.skipped", {
        "room_name": room_name,
        "next_start_unix": next_start_unix,
    })

    try:
        from ws_manager import manager
        await manager.broadcast_room(room_name, {
            "type": "music_track_skipped", "room": room_name,
            "track_id": current["id"] if current else None
        })
    except Exception:
        pass
    return {"ok": True, "skipped": current}


@router.post("/{room_name}/queue/clear")
async def music_clear(room_name: str, current_user: dict = Depends(get_current_user)):
    is_admin = bool(current_user.get("is_admin"))
    if not _can_control(room_name, current_user["id"], is_admin):
        return JSONResponse(status_code=403, content={"error": "Only DJs or mods can clear queue"})
    n = db.music_clear_queue(room_name)
    clear_music_head_anchor(room_name)

    _emit_federation_room_event("room.music.queue.cleared", {
        "room_name": room_name,
    })

    try:
        from ws_manager import manager
        await manager.broadcast_room(room_name, {"type": "music_queue_cleared", "room": room_name})
    except Exception:
        pass
    return {"ok": True, "cleared": n}


@router.post("/{room_name}/dj-only")
async def music_toggle_dj_only(room_name: str, body: ToggleDJOnlyRequest,
                               current_user: dict = Depends(get_current_user)):
    if not db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin"))):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    db.room_set_dj_only(room_name, 1 if body.dj_only else 0)
    _emit_federation_room_event("room.music.dj_only.changed", {
        "room_name": room_name,
        "dj_only": bool(body.dj_only),
    })
    try:
        from ws_manager import manager
        await manager.broadcast_room(room_name, {
            "type": "music_dj_only_changed", "room": room_name, "dj_only": bool(body.dj_only)
        })
    except Exception:
        pass
    return {"ok": True}


class DJRequest(BaseModel):
    user_id: int


@router.post("/{room_name}/djs")
async def grant_dj(room_name: str, body: DJRequest,
                   current_user: dict = Depends(get_current_user)):
    if not db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin"))):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    db.dj_add(room_name, body.user_id, current_user["id"])
    try:
        from ws_manager import manager
        await manager.broadcast_room(room_name, {
            "type": "music_djs_changed", "room": room_name, "djs": db.dj_list(room_name)
        })
    except Exception:
        pass
    return {"ok": True, "djs": db.dj_list(room_name)}


@router.delete("/{room_name}/djs/{user_id}")
async def revoke_dj(room_name: str, user_id: int,
                    current_user: dict = Depends(get_current_user)):
    if not db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin"))):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    db.dj_remove(room_name, user_id)
    try:
        from ws_manager import manager
        await manager.broadcast_room(room_name, {
            "type": "music_djs_changed", "room": room_name, "djs": db.dj_list(room_name)
        })
    except Exception:
        pass
    return {"ok": True, "djs": db.dj_list(room_name)}
