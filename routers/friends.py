"""Friends, tags, user search routes."""
import base64
import logging
import os
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, Depends, Request, UploadFile, File
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
from slowapi import Limiter
from typing import Optional

import database as db
from deps import get_current_user, client_ip
from ws_manager import manager

_log = logging.getLogger(__name__)
limiter = Limiter(key_func=client_ip)
router = APIRouter(prefix="/friends", tags=["friends"])
users_router = APIRouter(prefix="/users", tags=["users_ext"])

_SOUND_MAX_BYTES = int(os.getenv("FROGTALK_FRIEND_SOUND_MAX_BYTES", str(10 * 1024 * 1024)))
_SOUND_ROOT = Path(os.getenv("FROGTALK_FRIEND_SOUND_DIR", "data/friend_sounds"))
_ALLOWED_SOUND_MIME_PREFIXES = ("audio/",)
_ALLOWED_SOUND_EXTS = {
    ".mp3", ".wav", ".ogg", ".m4a", ".aac", ".opus", ".flac", ".weba", ".mp4", ".webm"
}
_SOUND_MIME_BY_EXT = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".weba": "audio/webm",
    ".mp4": "audio/mp4",
    ".webm": "audio/webm",
}


def _normalize_sound_content_type(content_type: str, ext: str) -> str:
    ct = (content_type or "").strip().lower()
    e = (ext or "").strip().lower()
    guessed = _SOUND_MIME_BY_EXT.get(e, "")
    if not ct or ct in {"application/octet-stream", "binary/octet-stream"}:
        return guessed or "application/octet-stream"
    if not ct.startswith("audio/") and guessed:
        return guessed
    return ct


def _friend_push(user_id: int, title: str, body: str,
                 kind: str = "friend_request", from_nickname: str = ""):
    """Send push notification for friend events (silent fail).

    Passes an explicit (possibly empty) ``from_nickname`` so the on-device
    FCM service does not fall back to the notification *title* as a DM
    target — that fallback is what produced the "user not found" toast
    when tapping a friend-request heads-up (it tried to open a DM with
    "👥 Friend Request")."""
    try:
        from routers.push import send_push
        send_push(
            user_id, title, body, "/app",
            kind=kind,
            extra={"from_nickname": from_nickname or ""},
        )
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
                "display_name": ident.get("display_name") or "",
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
@limiter.limit("120/hour")
async def search_users(request: Request, q: str = "", current_user: dict = Depends(get_current_user)):
    if not q or len(q) < 1:
        return {"users": []}
    results = db.search_users(q, limit=20, requester_id=current_user["id"])
    return {"users": [
        {"id": u["id"], "nickname": u["nickname"], "display_name": u.get("display_name"), "avatar": u["avatar"],
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
    # Push notification to recipient as backup. Pass from_nickname="" so the
    # Android FCM service does not synthesize a "?dm=..." tap target from the
    # title (which would otherwise produce a "User not found" toast).
    _friend_push(profile["id"], "\ud83d\udc65 Friend Request",
                 f"{current_user['nickname']} wants to be friends",
                 kind="friend_request",
                 from_nickname="")
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
    # Push notification to requester as backup. from_nickname="" prevents the
    # heads-up tap from being mis-routed to a non-existent DM thread.
    _friend_push(profile["id"], "\ud83d\udc65 Friend Accepted",
                 f"{current_user['nickname']} accepted your friend request",
                 kind="friend_accepted",
                 from_nickname="")
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


def _sound_kind_or_none(kind: str) -> Optional[str]:
    k = (kind or "").strip().lower()
    return k if k in {"msg", "ring"} else None


def _friend_sound_payload(asset: dict) -> dict:
    return {
        "id": asset.get("id"),
        "friend_user_id": asset.get("friend_user_id"),
        "kind": asset.get("kind"),
        "filename": asset.get("filename"),
        "content_type": asset.get("content_type"),
        "file_size": asset.get("file_size"),
        "is_active": bool(asset.get("is_active")),
        "created_at": asset.get("created_at"),
        "updated_at": asset.get("updated_at"),
        "url": f"/api/friends/sounds/file/{asset.get('id')}",
    }


@router.post("/sounds/upload/{nickname}/{kind}")
@limiter.limit("120/hour")
async def upload_friend_sound(
    request: Request,
    nickname: str,
    kind: str,
    media: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
):
    safe_kind = _sound_kind_or_none(kind)
    if not safe_kind:
        return JSONResponse(status_code=400, content={"error": "kind must be msg or ring"})
    friend = db.get_user_profile(nickname)
    if not friend:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    if not db.are_friends(current_user["id"], friend["id"]):
        return JSONResponse(status_code=403, content={"error": "You can only set sounds for friends"})
    if not media:
        return JSONResponse(status_code=400, content={"error": "Media required"})

    content_type = (media.content_type or "application/octet-stream").strip().lower()
    name = (media.filename or "sound.bin").strip()
    ext = Path(name).suffix.lower()
    if not any(content_type.startswith(p) for p in _ALLOWED_SOUND_MIME_PREFIXES):
        if ext not in _ALLOWED_SOUND_EXTS:
            return JSONResponse(status_code=400, content={"error": "Unsupported audio file type"})
    raw = await media.read()
    if not raw:
        return JSONResponse(status_code=400, content={"error": "Empty upload"})
    if len(raw) > _SOUND_MAX_BYTES:
        return JSONResponse(status_code=413, content={"error": f"Upload too large (max {_SOUND_MAX_BYTES // (1024 * 1024)}MB)"})

    if ext not in _ALLOWED_SOUND_EXTS:
        ext = ".bin"
    safe_content_type = _normalize_sound_content_type(content_type, ext)
    target_dir = _SOUND_ROOT / str(current_user["id"]) / str(friend["id"]) / safe_kind
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"{uuid.uuid4().hex}{ext}"
    with open(target_path, "wb") as fh:
        fh.write(raw)

    asset = db.add_friend_sound_asset(
        owner_user_id=current_user["id"],
        friend_user_id=friend["id"],
        kind=safe_kind,
        filename=name or target_path.name,
        content_type=safe_content_type,
        file_path=str(target_path),
        file_size=len(raw),
        is_active=1,
    )
    # Replicate to peer nodes via federation so any node can serve the file.
    try:
        _emit_friend_event("friend.sound.created", {
            "owner_nick": current_user.get("nickname", ""),
            "friend_nick": nickname,
            "kind": safe_kind,
            "filename": name or target_path.name,
            "content_type": safe_content_type,
            "file_ext": Path(target_path).suffix.lower(),
            "file_data_b64": base64.b64encode(raw).decode("ascii"),
        })
    except Exception:
        pass
    return {"ok": True, "asset": _friend_sound_payload(asset)}


@router.get("/sounds/file/{asset_id}")
async def get_friend_sound_file(asset_id: int, request: Request, token: Optional[str] = None):
    session_token = (token or "").strip() or (request.headers.get("X-Session-Token", "").strip())
    if not session_token:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
    user = db.get_user_by_token(session_token)
    if not user:
        return JSONResponse(status_code=401, content={"error": "Invalid or expired session"})
    asset = db.get_friend_sound_asset(user["id"], asset_id)
    if not asset:
        return JSONResponse(status_code=404, content={"error": "Sound not found"})
    fp = Path(str(asset.get("file_path") or ""))
    if not fp.exists() or not fp.is_file():
        return JSONResponse(status_code=404, content={"error": "Sound file missing"})
    media_type = _normalize_sound_content_type(asset.get("content_type") or "", fp.suffix)
    return FileResponse(
        str(fp),
        media_type=media_type,
        filename=asset.get("filename") or fp.name,
        content_disposition_type="inline",
        headers={"Cache-Control": "private, max-age=300"},
    )


@router.get("/sounds/{nickname}/{kind}")
async def list_friend_sounds(nickname: str, kind: str, current_user: dict = Depends(get_current_user)):
    safe_kind = _sound_kind_or_none(kind)
    if not safe_kind:
        return JSONResponse(status_code=400, content={"error": "kind must be msg or ring"})
    friend = db.get_user_profile(nickname)
    if not friend:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    if not db.are_friends(current_user["id"], friend["id"]):
        return JSONResponse(status_code=403, content={"error": "You can only view sounds for friends"})
    assets = db.list_friend_sound_assets(current_user["id"], friend["id"], safe_kind)
    active = db.get_active_friend_sound_asset(current_user["id"], friend["id"], safe_kind)
    return {
        "ok": True,
        "assets": [_friend_sound_payload(a) for a in assets],
        "active": _friend_sound_payload(active) if active else None,
    }


@router.post("/sounds/activate/{asset_id}")
async def activate_friend_sound(asset_id: int, current_user: dict = Depends(get_current_user)):
    asset = db.set_active_friend_sound_asset(current_user["id"], asset_id)
    if not asset:
        return JSONResponse(status_code=404, content={"error": "Sound not found"})
    return {"ok": True, "asset": _friend_sound_payload(asset)}


@router.delete("/sounds/{asset_id}")
async def delete_friend_sound(asset_id: int, current_user: dict = Depends(get_current_user)):
    deleted = db.delete_friend_sound_asset(current_user["id"], asset_id)
    if not deleted:
        return JSONResponse(status_code=404, content={"error": "Sound not found"})
    try:
        fp = Path(str(deleted.get("file_path") or ""))
        if fp.exists() and fp.is_file():
            fp.unlink()
    except Exception:
        pass
    # Keep one active asset if any remain for the same friend+kind.
    remaining = db.list_friend_sound_assets(current_user["id"], deleted["friend_user_id"], deleted["kind"])
    if remaining and not any(bool(x.get("is_active")) for x in remaining):
        db.set_active_friend_sound_asset(current_user["id"], remaining[0]["id"])
    # Replicate deletion to peer nodes.
    try:
        friend_row = db.get_user_by_id(deleted["friend_user_id"])
        _emit_friend_event("friend.sound.deleted", {
            "owner_nick": current_user.get("nickname", ""),
            "friend_nick": (friend_row or {}).get("nickname", ""),
            "kind": deleted.get("kind", ""),
        })
    except Exception:
        pass
    return {"ok": True}
