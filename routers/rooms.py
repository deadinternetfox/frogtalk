"""Room management routes."""
import asyncio
import io
import json
import os
import re
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, Request, Depends, UploadFile, File
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel, Field
from slowapi import Limiter
from typing import Optional

import database as db
from deps import get_current_user, client_ip
from ws_manager import voice_manager, manager

router = APIRouter(prefix="/rooms", tags=["rooms"])
limiter = Limiter(key_func=client_ip)

ROOM_NAME_RE = re.compile(r"^[a-z0-9_\-]{1,32}$")

# ─── channel_theme sanitiser ─────────────────────────────────────────────────
# channel_theme is a JSON blob with whitelisted keys. The .css field used to
# be passed straight to the client which applied it inside a <style> tag.
# A malicious owner could weaponise that by starting their selector with a
# comma — turning `#main ,*` into a selector list matching every element —
# and inject `body::after { content: "..." }` to deface the page for every
# visitor. This function whitelists known keys, caps sizes, and strips
# anything in the .css field that looks like a CSS-based XSS / phishing
# vector. Mirrors the wall.py custom_css check, but stricter (no commas in
# selectors, no @-rules, no url()).
_CHANNEL_THEME_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")
_CHANNEL_THEME_KEYS = ("bg", "text", "accent", "bgImage", "css")
_CSS_DANGEROUS_TOKENS = (
    "javascript:", "expression(", "url(", "@import", "@charset",
    "@font-face", "behavior:", "-moz-binding", "</style", "<script",
    "\\",
)


def _normalize_css_for_check(s: str) -> str:
    """Decode CSS hex escapes and HTML entities so detection can't be
    bypassed by e.g. ``\\75 rl(`` or ``&#117;rl(``. Returns a lower-cased
    whitespace-stripped string for *detection only*; the raw value is what
    eventually ships if it passes."""
    out = s.lower()
    # CSS hex escape: \X{1,6}[ws]?
    def _hx(m):
        try:
            cp = int(m.group(1), 16)
            return chr(cp) if cp < 0x110000 else ""
        except Exception:
            return ""
    out = re.sub(r"\\([0-9a-f]{1,6})\s?", _hx, out)
    # CSS literal escape: \X -> X
    out = re.sub(r"\\(.)", r"\1", out)
    try:
        import html as _html
        out = _html.unescape(out)
    except Exception:
        pass
    # Strip /* ... */ comments
    out = re.sub(r"/\*.*?\*/", "", out, flags=re.DOTALL)
    # Collapse all whitespace
    out = re.sub(r"\s+", "", out)
    return out


def _sanitize_channel_css(raw: str) -> str:
    """Return safe CSS, or raise ValueError if irrecoverable.

    Rules: no @-rules, no url(), no javascript:, no comma-bridged selectors
    that would escape the #main scope, no parens or quotes in selectors, no
    angle brackets, no </style breakouts. Each rule's selector is parsed
    and rebuilt so the client doesn't have to trust the string.
    """
    if not raw:
        return ""
    css = raw[:10_240]
    # Strip comments first so the regex below sees the real selectors.
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
    normalized_full = _normalize_css_for_check(css)
    for tok in _CSS_DANGEROUS_TOKENS:
        if tok in normalized_full:
            raise ValueError(f"CSS contains forbidden token: {tok}")
    # Rebuild rule-by-rule. Reject any chunk with @-rules / nested braces.
    if css.count("{") != css.count("}"):
        raise ValueError("CSS braces are unbalanced")
    out_rules = []
    for chunk in css.split("}"):
        i = chunk.find("{")
        if i == -1:
            if chunk.strip():
                raise ValueError("CSS contains stray text outside a rule")
            continue
        sel_raw = chunk[:i].strip()
        body_raw = chunk[i + 1:].strip()
        if not sel_raw or not body_raw:
            continue
        if sel_raw.startswith("@") or "{" in body_raw:
            raise ValueError("CSS @-rules and nested rules are not allowed")
        # Reject selectors with chars that would let the attacker break out
        # of the scope wrapper or smuggle expressions.
        if re.search(r"[<>(){}\"'`\\;]", sel_raw):
            raise ValueError("CSS selector contains forbidden characters")
        # Split the selector list and reject any empty / leading-comma
        # part (which is what enabled the original ``,*`` escape).
        parts = [p.strip() for p in sel_raw.split(",")]
        if any(not p for p in parts):
            raise ValueError("CSS selector list has empty part (leading/trailing comma?)")
        # Reject bare universal / root / html / body selectors — they'd
        # still hit everything once they slip past the #main prefix.
        # We strip pseudo-classes/elements first so ``body:defined`` and
        # ``*:defined`` don't sneak past the equality check (the original
        # bypass used by the pentester to render the room blank).
        for p in parts:
            first = re.split(r"[\s>+~]", p, maxsplit=1)[0].lower()
            # Reject broadening pseudo-classes anywhere in the first
            # compound selector — these can match arbitrary elements
            # regardless of the tag prefix.
            if re.search(r":(defined|is|where|has|not|matches|any)\b", first):
                raise ValueError(f"CSS selector '{p}' uses a broadening pseudo-class")
            # Reject root-level pseudo-classes outright (no tag prefix).
            if first.startswith((":root", ":host", ":scope", ":target")):
                raise ValueError(f"CSS selector '{p}' targets the document root")
            # Extract just the leading element/universal token, ignoring
            # any trailing pseudo-class / class / id / attribute selector.
            m = re.match(r"^([*a-z][a-z0-9-]*)", first)
            head_tag = m.group(1) if m else ""
            if head_tag in ("*", "html", "body"):
                raise ValueError(f"CSS selector '{p}' is too broad")
        body_norm = _normalize_css_for_check(body_raw)
        for tok in _CSS_DANGEROUS_TOKENS:
            if tok in body_norm:
                raise ValueError(f"CSS rule body contains forbidden token: {tok}")
        out_rules.append(f"{', '.join(parts)} {{ {body_raw} }}")
    return "\n".join(out_rules)


def _sanitize_channel_theme(raw: Optional[str]) -> Optional[str]:
    """Validate a channel_theme JSON blob. Returns the canonicalised JSON
    string, or '' to clear. Raises ValueError on bad input."""
    if raw is None:
        return None
    raw = raw.strip()
    if not raw:
        return ""
    try:
        data = json.loads(raw)
    except Exception:
        raise ValueError("channel_theme must be valid JSON")
    if not isinstance(data, dict):
        raise ValueError("channel_theme must be a JSON object")
    clean: dict = {}
    for k in ("bg", "text", "accent"):
        v = data.get(k)
        if v is None or v == "":
            continue
        if not isinstance(v, str) or not _CHANNEL_THEME_COLOR_RE.match(v):
            raise ValueError(f"channel_theme.{k} must be a #hex colour")
        clean[k] = v
    bg_image = data.get("bgImage")
    if bg_image:
        if not isinstance(bg_image, str) or len(bg_image) > 2048:
            raise ValueError("channel_theme.bgImage is invalid")
        bg_image = bg_image.strip()
        # Same allowlist the client enforces: http(s) URL or same-origin
        # absolute path. No data:, no javascript:, no quotes or parens.
        if re.search(r"[)\\\s'\"<>]", bg_image):
            raise ValueError("channel_theme.bgImage contains forbidden characters")
        if not (re.match(r"^https?://", bg_image, re.IGNORECASE)
                or re.match(r"^/[A-Za-z0-9._\-/?=&%]+$", bg_image)):
            raise ValueError("channel_theme.bgImage must be http(s) URL or absolute path")
        clean["bgImage"] = bg_image
    css = data.get("css")
    if css:
        if not isinstance(css, str):
            raise ValueError("channel_theme.css must be a string")
        clean["css"] = _sanitize_channel_css(css)
    # Drop unknown keys silently — anything outside the whitelist is gone.
    return json.dumps(clean, separators=(",", ":"))


class CreateRoomRequest(BaseModel):
    name: str = Field(max_length=64)
    description: str = Field(default="", max_length=2_000)
    type: str = Field(default="public", max_length=16)
    room_key_hint: Optional[str] = Field(default=None, max_length=512)
    # Icon may be a data:image/* URL; the body-level cap mirrors
    # ``_normalize_room_icon``'s 3MB ceiling with headroom for base64
    # padding.
    icon: Optional[str] = Field(default=None, max_length=5_000_000)
    channel_type: str = Field(default="text", max_length=16)  # text, music, or voice (legacy)
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


class MusicSkipRequest(BaseModel):
    expected_track_id: Optional[int] = None
    # Set by clients when a track ends naturally (YouTube state 0). Lets
    # any room member request advancement, not just DJs/mods, so radio-style
    # playlists actually progress when the DJ is offline / a listener is
    # the only one watching. Server still validates expected_track_id and
    # a minimum-played-seconds threshold to prevent skip spam.
    auto: Optional[bool] = False


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
    name: Optional[str] = Field(default=None, max_length=64)
    description: Optional[str] = Field(default=None, max_length=2_000)
    icon: Optional[str] = Field(default=None, max_length=5_000_000)
    slowmode: Optional[int] = None
    channel_type: Optional[str] = Field(default=None, max_length=16)  # text, music, or voice (legacy)
    channel_theme: Optional[str] = Field(default=None, max_length=20_000)  # JSON theme object
    invite_only: Optional[int] = None  # 0 or 1
    who_can_invite: Optional[str] = Field(default=None, max_length=16)  # everyone, mods, owner
    banner: Optional[str] = Field(default=None, max_length=10_000_000)  # data URL or image URL
    about: Optional[str] = Field(default=None, max_length=20_000)  # rich channel about text
    forwarding_disabled: Optional[int] = None  # 0 or 1


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
    if body.forwarding_disabled is not None and body.forwarding_disabled not in (0, 1):
        return JSONResponse(status_code=400, content={"error": "forwarding_disabled must be 0 or 1"})
    
    # Validate who_can_invite
    if body.who_can_invite is not None and body.who_can_invite not in ("everyone", "mods", "owner"):
        return JSONResponse(status_code=400, content={"error": "who_can_invite must be everyone, mods, or owner"})

    icon: Optional[str] = None
    if body.icon is not None:
        try:
            icon = _normalize_room_icon(body.icon)
        except ValueError as e:
            return JSONResponse(status_code=400, content={"error": str(e)})

    try:
        sanitized_theme = _sanitize_channel_theme(body.channel_theme)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": f"channel_theme: {e}"})

    ok = db.update_room_settings(
        room_name,
        name=body.name,
        description=body.description[:256] if body.description else None,
        icon=icon,
        slowmode=body.slowmode,
        channel_type=body.channel_type,
        channel_theme=sanitized_theme,
        invite_only=body.invite_only,
        who_can_invite=body.who_can_invite,
        banner=body.banner,
        about=body.about[:4000] if body.about is not None else None,
        forwarding_disabled=body.forwarding_disabled,
    )
    if not ok:
        return JSONResponse(status_code=409, content={"error": "Update failed (name conflict?)"})
    return {"ok": True}


# ─── Channel theme background image upload ───────────────────────────────────
# Stored on disk and served via a dedicated endpoint instead of being
# inlined into the channel_theme JSON (which is capped at 4KB and would
# explode for any real photo). Pillow re-encodes every upload to strip
# EXIF/metadata, decline animated/SVG payloads, and cap dimensions —
# defends against decompression bombs and tracking pixels in one shot.

_CHANNEL_BG_DIR = Path(os.environ.get("FROGTALK_DATA_DIR", "data")) / "channel_bg"
_CHANNEL_BG_DIR.mkdir(parents=True, exist_ok=True)
_CHANNEL_BG_MAX_BYTES = 8 * 1024 * 1024     # 8 MB raw upload cap
_CHANNEL_BG_MAX_DIM = 2560                  # cap longest side after resize
_CHANNEL_BG_EXTS = ("jpg", "webp")


def _channel_bg_path(room_id: int, ext: str) -> Path:
    return _CHANNEL_BG_DIR / f"{int(room_id)}.{ext}"


def _existing_channel_bg(room_id: int) -> Optional[Path]:
    for ext in _CHANNEL_BG_EXTS:
        p = _channel_bg_path(room_id, ext)
        if p.exists():
            return p
    return None


def _purge_channel_bg(room_id: int) -> None:
    for ext in _CHANNEL_BG_EXTS:
        try:
            _channel_bg_path(room_id, ext).unlink(missing_ok=True)
        except Exception:
            pass


@router.post("/{room_name}/theme-bg")
@limiter.limit("20/hour")
async def upload_channel_theme_bg(request: Request, room_name: str,
                                  media: UploadFile = File(...),
                                  current_user: dict = Depends(get_current_user)):
    """Upload a channel theme background image. Owner / mods / admin only.
    Returns a relative URL that the client should drop into the
    channel_theme.bgImage field via the regular PATCH /rooms/{name} call."""
    if not db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin"))):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})

    raw = await media.read()
    if not raw:
        return JSONResponse(status_code=400, content={"error": "Empty upload"})
    if len(raw) > _CHANNEL_BG_MAX_BYTES:
        return JSONResponse(
            status_code=413,
            content={"error": "Image too large (max 8 MB)"},
        )

    # Best-effort content-type sanity check before paying the Pillow cost.
    ct = (media.content_type or "").lower()
    if ct and not ct.startswith("image/"):
        return JSONResponse(status_code=400, content={"error": "Not an image"})

    try:
        from PIL import Image, ImageOps
        # Cap pixel count BEFORE decode — Pillow uses this to short-circuit
        # decompression bombs (e.g. 100,000 × 100,000 PNG that decodes to
        # 40 GB of RAM). 50 MP is comfortably above any photo a user would
        # legitimately use as a chat background.
        Image.MAX_IMAGE_PIXELS = 50_000_000
        # First pass: verify() detects truncated / malformed payloads.
        with Image.open(io.BytesIO(raw)) as probe:
            probe.verify()
            fmt = (probe.format or "").upper()
        if fmt not in ("JPEG", "PNG", "WEBP"):
            # Reject SVG (script execution risk), GIF (animation +
            # potential ImageMagick-style abuse), BMP/TIFF (rarely
            # legitimate, often huge).
            return JSONResponse(
                status_code=400,
                content={"error": "Use JPEG, PNG, or WEBP"},
            )
        # Re-open for actual processing — verify() leaves the image in an
        # unusable state per Pillow docs.
        im = Image.open(io.BytesIO(raw))
        im = ImageOps.exif_transpose(im)    # honour rotation, then drop EXIF
        has_alpha = im.mode in ("RGBA", "LA") or "transparency" in im.info
        if has_alpha:
            im = im.convert("RGBA")
        else:
            im = im.convert("RGB")
        im.thumbnail((_CHANNEL_BG_MAX_DIM, _CHANNEL_BG_MAX_DIM), Image.LANCZOS)
        out_buf = io.BytesIO()
        if has_alpha:
            im.save(out_buf, format="WEBP", quality=85, method=4)
            ext = "webp"
        else:
            im.save(out_buf, format="JPEG", quality=82,
                    optimize=True, progressive=True)
            ext = "jpg"
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid image file"})

    # Atomic-ish write: write to a temp sibling then rename. Avoids serving
    # a half-written file if the process crashes mid-flush.
    _purge_channel_bg(int(room["id"]))
    out_path = _channel_bg_path(int(room["id"]), ext)
    tmp_path = out_path.with_suffix(out_path.suffix + ".part")
    payload = out_buf.getvalue()
    tmp_path.write_bytes(payload)
    os.replace(tmp_path, out_path)
    mtime = int(out_path.stat().st_mtime)
    url = f"/api/rooms/{room_name}/theme-bg?v={mtime}"
    return {"ok": True, "url": url, "size": len(payload)}


@router.get("/{room_name}/theme-bg")
async def get_channel_theme_bg(room_name: str):
    """Serve the channel theme background image. Public so CSS background-image
    can fetch it without bespoke headers; the URL itself contains no
    sensitive data and the room name is already enumerable via /api/rooms."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    p = _existing_channel_bg(int(room["id"]))
    if not p:
        return JSONResponse(status_code=404, content={"error": "No background"})
    media_type = "image/webp" if p.suffix == ".webp" else "image/jpeg"
    # Cache for a day — clients busted via ?v=<mtime> on update.
    # Pillow already re-encoded the bytes during upload (so SVG/PDF
    # cannot land here), but defence-in-depth: nosniff + sandbox CSP
    # mean the response stays inert even if the stored file is later
    # tampered with on disk.
    from routers._media_safety import media_response_headers
    return FileResponse(
        p,
        media_type=media_type,
        headers={
            **media_response_headers(
                media_type,
                filename=f"channel-bg-{room['id']}",
                cache_control="public, max-age=86400, immutable",
            ),
        },
    )


@router.delete("/{room_name}/theme-bg")
async def delete_channel_theme_bg(room_name: str,
                                  current_user: dict = Depends(get_current_user)):
    if not db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin"))):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    _purge_channel_bg(int(room["id"]))
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


# ─── Transfer ownership ───────────────────────────────────────────────────────

class TransferOwnershipRequest(BaseModel):
    user_id: int
    confirm: bool = False


@router.post("/{room_name}/transfer-ownership")
async def transfer_ownership(room_name: str, body: TransferOwnershipRequest,
                             current_user: dict = Depends(get_current_user)):
    """Transfer ownership of a channel to another user.

    Strictly owner-only (admins are NOT allowed to forcibly transfer a
    user-owned channel — that's a different intentional flow). The
    request must include `confirm=true` so a stray button click can't
    fire it accidentally; the UI surfaces a two-step modal.

    The outgoing owner is automatically demoted to moderator so they
    keep delete/ban powers; the new owner is removed from the mods list
    (they outrank that role now) and auto-added as a member if not
    already.
    """
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    if int(room["owner_id"]) != int(current_user["id"]):
        return JSONResponse(status_code=403, content={"error": "Only the current owner can transfer ownership"})
    if not body.confirm:
        return JSONResponse(status_code=400, content={"error": "Confirmation required"})
    if int(body.user_id) == int(current_user["id"]):
        return JSONResponse(status_code=400, content={"error": "You are already the owner"})
    target = db.get_user_by_id(body.user_id)
    if not target:
        return JSONResponse(status_code=404, content={"error": "Target user not found"})

    result = db.transfer_room_ownership(room["id"], current_user["id"], body.user_id)
    if not result.get("ok"):
        # 409 covers the "already owner" / membership race conditions
        # the DB-layer check rejects.
        return JSONResponse(status_code=409, content={"error": result.get("error", "Transfer failed")})

    # Notify everyone subscribed to the room so member-list role badges
    # update without a manual reload, and let the new owner's other
    # devices refresh their permissions cache too.
    try:
        from ws_manager import manager
        await manager.broadcast_room(room_name, {
            "type": "room_owner_changed",
            "room": room_name,
            "previous_owner_id": int(current_user["id"]),
            "previous_owner_nickname": current_user.get("nickname"),
            "new_owner_id": int(body.user_id),
            "new_owner_nickname": target.get("nickname"),
        })
        # Direct ping to the new owner so any client of theirs that's
        # on a different page (DMs, social) still gets the toast.
        await manager.send_to_user(body.user_id, {
            "type": "room_ownership_received",
            "room": room_name,
            "from_nickname": current_user.get("nickname"),
        })
    except Exception:
        pass
    return {"ok": True, "new_owner_id": int(body.user_id)}


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
        # Private-room key rotation: after a ban succeeds, ask the moderator's
        # client to generate a fresh room secret and fan it out to every
        # remaining member via Signal-encrypted envelopes. The banned user
        # keeps their old per-version secret in localStorage (so they can
        # still read history they were part of) but never receives the new
        # one — every message encrypted under key_version > current is
        # opaque to them. Public rooms skip this; they aren't E2EE.
        if (room.get("type") or "public") == "private":
            await manager.send_to_user(current_user["id"], {
                "type": "room_should_rotate",
                "room": room_name,
                "reason": "ban",
                "target_user_id": body.user_id,
                "target_nickname": target.get("nickname"),
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


# ─── Private-room key rotation ────────────────────────────────────────────
# AAD-bound AES-GCM with a server-side `room_key_version` counter. Bumping
# the version invalidates the previous room secret for anyone who doesn't
# receive the new one. The new secret is generated client-side, fanned out
# via Signal-encrypted DMs (so the server never sees plaintext), and
# announced with a system message visible to all current members.
#
# Triggered: (a) manually by owner/mod via the "Rotate room key" button;
# (b) automatically by the banning client after a successful ban (the
# server fires a `room_should_rotate` WS event to the moderator).
#
# Public rooms cannot rotate — they aren't E2EE in the first place.

class RotateKeyRequest(BaseModel):
    reason: str = "manual"                    # 'manual' | 'ban' | 'kick'
    target_user_id: Optional[int] = None      # set when reason='ban'/'kick'
    target_nickname: Optional[str] = None
    envelopes: dict[str, str] = Field(default_factory=dict)  # {user_id: signal_env_json}


@router.post("/{room_name}/rotate")
async def rotate_room_key(room_name: str, body: RotateKeyRequest,
                          current_user: dict = Depends(get_current_user)):
    """Rotate the room secret. Moderator-only, private rooms only.

    The client has already (a) generated a fresh 32-byte secret,
    (b) Signal-encrypted it once per remaining member, and (c) installed
    the new secret locally. This endpoint atomically bumps the server's
    key_version counter, routes each envelope to its recipient as a WS
    `room_key_envelope` frame, inserts a system message into the room so
    every member sees a "🔄 Room key rotated by Alice" notice, and
    broadcasts that system message to currently-connected clients.
    """
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    if (room.get("type") or "public") != "private":
        return JSONResponse(status_code=400, content={"error": "Only private rooms can rotate"})
    if not db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin"))):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})

    reason = (body.reason or "manual").lower()
    if reason not in ("manual", "ban", "kick"):
        reason = "manual"

    new_version = db.room_increment_key_version(room_name)
    if not new_version:
        return JSONResponse(status_code=500, content={"error": "Could not rotate key"})

    # Fan out the Signal envelopes. Each envelope was encrypted client-side
    # so the server never learns the new secret. If a recipient is offline
    # the WS frame is dropped — the client will catch up on next history
    # fetch via the system message + the rotator's persisted envelope queue
    # (future work; for now, offline members must ask for the secret).
    delivered = 0
    for uid_str, env in (body.envelopes or {}).items():
        try:
            uid = int(uid_str)
        except (TypeError, ValueError):
            continue
        if not env or not isinstance(env, str):
            continue
        try:
            await manager.send_to_user(uid, {
                "type": "room_key_envelope",
                "room": room_name,
                "version": new_version,
                "env": env,
                "from_user_id": current_user["id"],
                "from_nickname": current_user.get("nickname") or "",
                "reason": reason,
            })
            delivered += 1
        except Exception:
            pass

    # System message in the channel. nickname='System', user_id=0 so the
    # row doesn't FK-violate (user_id=0 user does not exist, but the FK is
    # ON DELETE CASCADE without NOT NULL enforcement on insert from app
    # context — sqlite does not enforce FKs by default). content is a
    # short JSON payload the client parses to render the pill.
    payload = {
        "kind": "room_key_rotated",
        "actor": current_user.get("nickname") or "",
        "actor_id": current_user["id"],
        "target": body.target_nickname or "",
        "target_id": int(body.target_user_id) if body.target_user_id else 0,
        "reason": reason,
        "version": new_version,
    }
    sys_content = json.dumps(payload, separators=(",", ":"))
    try:
        sys_msg_id = db.save_message(
            room_name=room_name,
            user_id=current_user["id"],
            nickname="System",
            content=sys_content,
            key_version=0,
            system_kind="room_key_rotated",
        )
    except Exception:
        sys_msg_id = 0

    try:
        from datetime import datetime as _dt
        await manager.broadcast_room(room_name, {
            "type": "message",
            "id": sys_msg_id,
            "room": room_name,
            "nickname": "System",
            "user_id": current_user["id"],
            "content": sys_content,
            "system_kind": "room_key_rotated",
            "key_version": 0,
            "has_media": False,
            "edited": False,
            "reactions": {},
            "created_at": _dt.utcnow().isoformat() + "Z",
        })
    except Exception:
        pass

    return {
        "ok": True,
        "version": new_version,
        "delivered": delivered,
        "system_message_id": sys_msg_id,
    }


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
    # Broadcast so every connected client in this room can update their
    # pinned-bar in real time without a page reload (Discord-style).
    try:
        from ws_manager import manager
        await manager.broadcast_room(room_name, {
            "type": "pin", "id": msg_id, "room": room_name,
            "by": current_user["nickname"],
        })
    except Exception:
        pass
    return {"ok": True}


@router.delete("/{room_name}/pins/{msg_id}")
async def unpin_message(room_name: str, msg_id: int,
                        current_user: dict = Depends(get_current_user)):
    """Unpin a message."""
    if not db.can_moderate_room(room_name, current_user["id"], bool(current_user.get("is_admin"))):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    
    db.unpin_message(room_name, msg_id)
    try:
        from ws_manager import manager
        await manager.broadcast_room(room_name, {
            "type": "unpin", "id": msg_id, "room": room_name,
            "by": current_user["nickname"],
        })
    except Exception:
        pass
    return {"ok": True}


@router.post("/{room_name}/join")
async def join_room(room_name: str, current_user: dict = Depends(get_current_user)):
    """Join a channel."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Room not found"})
    if not db.user_can_access_room(
        current_user["id"], room_name, is_admin=bool(current_user.get("is_admin"))
    ):
        return JSONResponse(
            status_code=403,
            content={"error": "You cannot join this channel directly. Ask for an invite link."}
        )
    db.join_room(current_user["id"], room["id"])
    # Notify everyone currently subscribed to this room over WS so their
    # member sidebar picks up the new joiner without a page reload. The
    # old behaviour relied on the joiner eventually opening a WS to the
    # room (which fires online_users), but if they joined via Discover
    # without entering the room, existing members never saw them.
    try:
        from ws_manager import manager
        await manager.broadcast_room(room_name, {
            "type": "member_joined",
            "room": room_name,
            "user_id": current_user["id"],
            "nickname": current_user["nickname"],
            "avatar": current_user.get("avatar"),
        })
    except Exception:
        pass
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
    try:
        online_ids = {
            int(u.get("user_id"))
            for u in manager.online_users_snapshot()
            if u.get("user_id") is not None
        }
    except Exception:
        online_ids = set()

    for m in members:
        uid = int(m.get("user_id") or 0)
        p = str(m.get("presence") or "").strip().lower()

        # The requester is actively authenticated in this room fetch path.
        # Treat self as live to avoid a login/channel-switch race where the
        # WS presence snapshot has not caught up yet.
        if uid and uid == int(current_user.get("id") or 0):
            live_online = True
        else:
            live_online = uid in online_ids if uid else False

        m["live_online"] = live_online
        if live_online:
            if p not in {"away", "dnd", "invisible"}:
                m["presence"] = "online"
        else:
            # Sidebar offline section should always render offline dot/color.
            m["presence"] = "offline"

    # Bots installed in this channel are surfaced in their own section
    # at the bottom of the right-hand sidebar so users can see who can
    # respond + how to @-mention them. We deliberately keep them out of
    # `members` because the frontend's online/offline split, presence
    # rules, and DM affordances are user-only.
    try:
        bots = db.get_channel_bots(room["id"]) or []
    except Exception:
        bots = []
    bots = [{
        "id": b.get("id"),
        "name": b.get("name") or "",
        "avatar": b.get("avatar") or "",
        "description": b.get("description") or "",
    } for b in bots if b.get("name")]
    return {"members": members, "bots": bots}


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
    elapsed = int(now - rec[1])
    # Sanity cap. If the in-memory anchor for this head track has been
    # advancing for more than 4h with nobody DJ'ing a skip (room idle,
    # everyone offline, nobody pressed Resync), the position grows
    # forever and clients that re-join see "Out of sync · 19669s". Reset
    # the anchor to now so playback restarts cleanly from 0 instead of
    # the client trying to seek to a phantom position deep into the past.
    if elapsed > 4 * 3600:
        set_music_head_anchor(room_name, int(tid), now)
        return 0
    return max(0, elapsed)


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
async def music_skip(room_name: str,
                     body: Optional[MusicSkipRequest] = None,
                     current_user: dict = Depends(get_current_user)):
    """Mark the current head track as played, advancing the queue."""
    is_admin = bool(current_user.get("is_admin"))
    is_auto = bool(body and body.auto)
    if not is_auto and not _can_control(room_name, current_user["id"], is_admin):
        return JSONResponse(status_code=403, content={"error": "Only DJs or mods can skip"})
    current = db.music_get_current(room_name)
    # Optional stale guard for client-side auto-advance: only skip when the
    # caller still sees this exact head track. Prevents multi-client races.
    expected_id = None
    if body is not None and body.expected_track_id is not None:
        try:
            expected_id = int(body.expected_track_id)
        except Exception:
            expected_id = None
    if expected_id is not None:
        current_id = int(current["id"]) if current else None
        if current_id != expected_id:
            return {"ok": False, "stale": True, "skipped": None}
    # Auto-advance from a listener requires:
    #   1) expected_track_id supplied (so we know the report is about the
    #      track they were actually watching, not a stale tab)
    #   2) the head track has been playing for at least 10 seconds (anti-spam:
    #      a malicious client can't mash this endpoint to nuke the queue)
    if is_auto:
        if expected_id is None or current is None:
            return {"ok": False, "stale": True, "skipped": None}
        played_sec = _music_position_sec(room_name, current)
        if played_sec < 10:
            return {"ok": False, "too_early": True, "skipped": None}
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
