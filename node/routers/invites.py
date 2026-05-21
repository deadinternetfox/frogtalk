"""Invite link management routes."""
import re
import secrets
import time
import uuid
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, HTMLResponse
from pydantic import BaseModel, Field, field_validator
from typing import Optional
from urllib.parse import quote as _url_quote
from slowapi import Limiter

import database as db
from deps import get_current_user, client_ip
from routers.rooms import request_private_room_rekey
from ws_manager import manager

router = APIRouter(prefix="/invites", tags=["invites"])
limiter = Limiter(key_func=client_ip)

MAX_INVITES_PER_CHANNEL = 50
MAX_INVITES_PER_USER_PER_ROOM_HOUR = 15

_PUBLIC_HTML_NO_CACHE = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}

# Inline auth probe for public HTML landings (invite /i/, /invite/). The SPA
# stores the session in localStorage.fc_token — older landings wrongly checked
# `token` only, so logged-in users still saw "Create a new account".
_LANDING_SESSION_HEAD = """<script>
(function(){
  function ftSessionToken(){
    try{
      return localStorage.getItem('fc_token')
        || localStorage.getItem('token')
        || localStorage.getItem('ft_token')
        || '';
    }catch(e){return '';}
  }
  window.ftSessionToken=ftSessionToken;
  window.ftIsLoggedIn=function(){return !!ftSessionToken();};
  if(window.ftIsLoggedIn()){document.documentElement.classList.add('ft-logged-in');}
})();
</script>"""


def generate_invite_code() -> str:
    """Generate a short readable invite code (lowercase for stable /i/ URLs)."""
    return secrets.token_urlsafe(8).replace('-', '').replace('_', '')[:8].lower()


def _user_can_create_invite(room: dict, current_user: dict) -> bool:
    """True if the user may create invite links for this channel."""
    is_owner = room["owner_id"] == current_user["id"]
    is_admin = bool(current_user.get("is_admin"))
    if is_admin:
        return True
    who = room.get("who_can_invite", "everyone")
    if (room.get("type") or "public").lower() == "private" and who == "everyone":
        who = "mods"
    if who == "owner":
        return is_owner
    if who == "mods":
        return is_owner or db.is_room_moderator(room["name"], current_user["id"])
    return True


# ─── Vanity slug rules ──────────────────────────────────────────────────
# Slug format: 2–32 chars, lowercase letters/digits/hyphen/underscore, must
# start and end with alphanumeric. Reserved words below also block top-level
# path collisions and obvious abuse vectors.
VANITY_RE = re.compile(r"^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$")
VANITY_MIN_LEN = 2
VANITY_MAX_LEN = 32

VANITY_RESERVED = frozenset({
    # App + framework paths
    "api", "app", "admin", "auth", "ws", "static", "assets", "favicon",
    "sitemap", "sitemap.xml", "robots", "robots.txt", "manifest", "sw",
    "service-worker", "opensearch",
    # Existing top-level routes
    "i", "invite", "og", "u", "c", "p", "r", "directory", "channels",
    "rooms", "users", "messages", "dms", "wall", "social", "calls",
    "friends", "gifs", "emojis", "bots", "bridge", "federation",
    "external", "preview", "push", "location", "server-admin",
    # Marketing / legal / docs
    "home", "index", "login", "logout", "signup", "register", "settings",
    "help", "support", "about", "terms", "privacy", "tos", "docs",
    "download", "downloads", "ios", "android", "desktop", "board",
    # Common abuse / impersonation
    "frogtalk", "official", "system", "root", "owner", "moderator", "mod",
    "staff", "team", "null", "undefined", "void",
})


def validate_vanity_slug(slug: str) -> Optional[str]:
    """Return None if valid, else a user-facing error message."""
    if slug is None or not str(slug).strip():
        return "Vanity cannot be empty"
    s = str(slug).strip().lower()
    if len(s) < VANITY_MIN_LEN:
        return f"Too short — minimum {VANITY_MIN_LEN} characters"
    if len(s) > VANITY_MAX_LEN:
        return f"Too long — maximum {VANITY_MAX_LEN} characters"
    if not VANITY_RE.match(s):
        return "Use only lowercase letters, digits, hyphen and underscore (must start/end with a letter or digit)"
    if s in VANITY_RESERVED:
        return "This name is reserved"
    return None


class CreateInviteRequest(BaseModel):
    max_uses: int = Field(default=0, ge=0, le=100)  # 0 = unlimited (public only)
    expires_hours: Optional[int] = Field(default=None, ge=1, le=8760)  # None = never

    @field_validator('expires_hours')
    @classmethod
    def _expires_positive(cls, v):
        if v is not None and v < 1:
            raise ValueError('expires_hours must be at least 1')
        return v


def _user_may_create_invite(room: dict, current_user: dict) -> bool:
    """Policy + must be a member (owner/mod/admin exempt from membership)."""
    if not _user_can_create_invite(room, current_user):
        return False
    uid = current_user['id']
    rid = room['id']
    if current_user.get('is_admin'):
        return True
    if room['owner_id'] == uid:
        return True
    if db.is_room_moderator(room['name'], uid):
        return True
    return db.is_room_member(uid, rid)


@router.post("/channels/{room_name}")
@limiter.limit("60/hour")
async def create_invite(
    request: Request,
    room_name: str,
    body: CreateInviteRequest,
    current_user: dict = Depends(get_current_user),
):
    """Create an invite link for a channel."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    
    # Check who_can_invite permission
    is_owner = room["owner_id"] == current_user["id"]
    is_mod = db.is_room_moderator(room_name, current_user["id"])
    is_admin = bool(current_user.get("is_admin"))
    room_type = (room.get("type") or "public").lower()
    who = room.get("who_can_invite", "everyone")
    if room_type == "private" and who == "everyone":
        who = "mods"

    if who == "owner" and not is_owner and not is_admin:
        return JSONResponse(status_code=403, content={"error": "Only the channel owner can create invites"})
    elif who == "mods" and not is_owner and not is_mod and not is_admin:
        return JSONResponse(status_code=403, content={"error": "Only moderators and the owner can create invites"})
    elif not _user_may_create_invite(room, current_user):
        return JSONResponse(
            status_code=403,
            content={"error": "You must be a member of this channel to create invite links"},
        )

    if db.count_channel_invites(room["id"]) >= MAX_INVITES_PER_CHANNEL:
        return JSONResponse(
            status_code=400,
            content={"error": f"This channel already has the maximum of {MAX_INVITES_PER_CHANNEL} invite links. Revoke unused links first."},
        )
    if db.count_recent_invites_by_user(room["id"], current_user["id"]) >= MAX_INVITES_PER_USER_PER_ROOM_HOUR:
        return JSONResponse(
            status_code=429,
            content={"error": "Too many invite links created recently. Wait a while and try again."},
        )

    if room_type == "private" and body.max_uses < 1:
        return JSONResponse(
            status_code=400,
            content={"error": "Private channels require invite links with a use limit (1–100)"},
        )

    code = generate_invite_code()
    if db.create_invite(room["id"], current_user["id"], code, body.max_uses, body.expires_hours):
        return {
            "code": code,
            "url": f"https://frogtalk.xyz/i/{code}",
            "max_uses": body.max_uses,
            "expires_hours": body.expires_hours
        }
    return JSONResponse(status_code=500, content={"error": "Failed to create invite"})


# ─── Vanity slug management ───────────────────────────────────────────────

class SetVanityRequest(BaseModel):
    vanity: Optional[str] = None  # null/empty string clears the vanity


def _check_vanity_conflicts(slug: str, room_id: int) -> Optional[str]:
    """Return user-facing error string if the slug is taken, else None."""
    if not db.is_vanity_available(slug, exclude_room_id=room_id):
        return "That vanity is already taken by another channel"
    if db.get_invite_code_collides(slug):
        return "That name conflicts with an existing invite code"
    return None


@router.get("/vanity-check")
async def vanity_check(slug: str = "", room: str = "", current_user: dict = Depends(get_current_user)):
    """Live-availability check used by the channel-settings UI.

    Owner-only (the field is only shown to owners). Returns
    {available: bool, error: str|null, normalized: str}.
    """
    target_room = db.get_room_by_name(room) if room else None
    if not target_room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    if target_room["owner_id"] != current_user["id"] and not current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Only the channel owner can manage vanity URLs"})
    if (target_room.get("type") or "public").lower() == "private":
        return JSONResponse(
            status_code=400,
            content={"error": "Private channels cannot use vanity URLs — use direct invite links"},
        )

    normalized = (slug or "").strip().lower()
    err = validate_vanity_slug(normalized)
    if err:
        return {"available": False, "error": err, "normalized": normalized}
    err = _check_vanity_conflicts(normalized, target_room["id"])
    if err:
        return {"available": False, "error": err, "normalized": normalized}
    return {"available": True, "error": None, "normalized": normalized}


@router.put("/channels/{room_name}/vanity")
async def set_channel_vanity(
    room_name: str,
    body: SetVanityRequest,
    current_user: dict = Depends(get_current_user),
):
    """Set or clear a channel's vanity slug. Owner-only (admin can override).

    Body: {"vanity": "frogs"} sets it; {"vanity": null} or {"vanity": ""} clears it.
    """
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})

    is_owner = room["owner_id"] == current_user["id"]
    if not is_owner and not current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Only the channel owner can manage vanity URLs"})
    if (room.get("type") or "public").lower() == "private":
        return JSONResponse(
            status_code=400,
            content={"error": "Private channels cannot use vanity URLs — use direct invite links"},
        )

    raw = (body.vanity or "").strip()
    if raw == "":
        # Clear
        db.set_room_vanity(room["id"], None)
        return {"ok": True, "vanity": None, "url": None}

    normalized = raw.lower()
    err = validate_vanity_slug(normalized)
    if err:
        return JSONResponse(status_code=400, content={"error": err})
    err = _check_vanity_conflicts(normalized, room["id"])
    if err:
        return JSONResponse(status_code=409, content={"error": err})

    if not db.set_room_vanity(room["id"], normalized):
        # Race or DB error — re-check and surface the right message.
        if not db.is_vanity_available(normalized, exclude_room_id=room["id"]):
            return JSONResponse(status_code=409, content={"error": "That vanity was just claimed by another channel"})
        return JSONResponse(status_code=500, content={"error": "Failed to save vanity"})

    return {
        "ok": True,
        "vanity": normalized,
        "url": f"https://frogtalk.xyz/i/{normalized}",
    }


@router.get("/channels/{room_name}")
async def list_channel_invites(room_name: str, current_user: dict = Depends(get_current_user)):
    """List all invites for a channel (owner/mods only)."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    
    is_owner = room["owner_id"] == current_user["id"]
    is_mod = db.is_room_moderator(room_name, current_user["id"])
    if not is_owner and not is_mod and not current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Not authorized"})
    
    invites = db.get_channel_invites(room["id"], include_redemptions=True)
    room_type = (room.get("type") or "public").lower()
    return {
        "invites": invites,
        "vanity": room.get("vanity") if room_type != "private" else None,
        "room_type": room_type,
        "who_can_invite": room.get("who_can_invite", "everyone"),
        "can_create_invite": _user_can_create_invite(room, current_user),
        # Platform admins (the "frog" account) see all owner-only UI
        # affordances — including the vanity URL card — on every channel.
        "is_owner": is_owner or bool(current_user.get("is_admin")),
    }


@router.delete("/channels/{room_name}/{code}")
async def delete_invite(room_name: str, code: str, current_user: dict = Depends(get_current_user)):
    """Revoke an invite link."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    
    is_owner = room["owner_id"] == current_user["id"]
    is_mod = db.is_room_moderator(room_name, current_user["id"])
    if not is_owner and not is_mod and not current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Not authorized"})
    
    if db.delete_invite(code, room["id"]):
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Invite not found"})


@router.get("/{code}")
async def get_invite_info(code: str):
    """Get public info about an invite (for landing page).

    Resolves either a real invite code or a channel vanity slug. The shape
    is the same so chat clients can render an invite card identically.
    """
    invite = db.get_invite(code)
    if invite:
        # Check if expired or max uses reached
        if invite.get("expires_at"):
            with db._conn() as con:
                expired = con.execute(
                    "SELECT datetime('now') > ?", (invite["expires_at"],)
                ).fetchone()[0]
                if expired:
                    return JSONResponse(status_code=410, content={"error": "Invite expired"})

        if invite.get("max_uses", 0) > 0 and invite.get("use_count", 0) >= invite["max_uses"]:
            return JSONResponse(status_code=410, content={"error": "Invite has reached max uses"})

        return {
            "code": code,
            "room_name": invite["room_name"],
            "room_desc": invite.get("room_desc", ""),
            "room_icon": invite.get("room_icon", "💬"),
            "created_by": invite.get("created_by_name"),
            "created_by_handle": (f"@{invite.get('created_by_name')}" if invite.get("created_by_name") else None),
            "is_vanity": False,
            "valid": True,
        }

    # Fall back to vanity slug. Vanities are a per-channel canonical URL,
    # not a per-user invite — credit them to the channel owner.
    room = db.get_room_by_vanity(code)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Invite not found or expired"})

    if int(room.get("invite_only") or 0) or (room.get("type") or "public").lower() == "private":
        return JSONResponse(
            status_code=404,
            content={"error": "Invite not found or expired"},
        )

    return {
        "code": (room.get("vanity") or code).lower(),
        "room_name": room["name"],
        "room_desc": room.get("description", "") or "",
        "room_icon": room.get("icon", "💬") or "💬",
        "created_by": room.get("owner_nickname"),
        "created_by_handle": (f"@{room.get('owner_nickname')}" if room.get("owner_nickname") else None),
        "is_vanity": True,
        "valid": True,
    }


@router.post("/{code}/join")
async def join_via_invite(code: str, current_user: dict = Depends(get_current_user)):
    """Join a channel via invite link. Accepts either a real code or vanity."""
    # Resolve the target room WITHOUT consuming the invite first, so that a
    # banned user trying to use their link doesn't burn a use-count.
    invite_row = db.get_invite(code)
    via_vanity = False
    target_room_id: Optional[int] = None
    if invite_row:
        target_room_id = invite_row.get("room_id")
    else:
        # Try vanity. Vanity does not bypass invite_only — those channels
        # must use a real invite code.
        room = db.get_room_by_vanity(code)
        if not room:
            return JSONResponse(status_code=410, content={"error": "Invite invalid or expired"})
        if int(room.get("invite_only") or 0) or (room.get("type") or "public").lower() == "private":
            return JSONResponse(
                status_code=403,
                content={"error": "This channel is invite-only. Ask the owner for a direct invite link."},
            )
        target_room_id = room["id"]
        via_vanity = True

    if not target_room_id:
        return JSONResponse(status_code=410, content={"error": "Invite invalid or expired"})

    # Pre-flight ban check. We do this BEFORE `use_invite` so a banned user
    # doesn't consume a one-shot link and so the client gets a clear,
    # specific error instead of a successful "join" followed by a WS
    # `room_ban` event that triggers the disconnect/ban modal.
    room_row = db.get_room_by_id(target_room_id) if hasattr(db, "get_room_by_id") else None
    if not room_row:
        with db._conn() as con:
            room_row = con.execute(
                "SELECT id, name FROM rooms WHERE id=?", (target_room_id,)
            ).fetchone()
            room_row = dict(room_row) if room_row else None
    if not room_row:
        return JSONResponse(status_code=404, content={"error": "Channel no longer exists"})

    ban = db.get_active_room_ban(target_room_id, current_user["id"])
    if ban and not bool(current_user.get("is_admin")):
        banner = db.get_user_by_id(ban.get("banned_by")) if ban.get("banned_by") else None
        return JSONResponse(status_code=403, content={
            "error": f"You are banned from #{room_row['name']} and cannot join.",
            "code": "room_banned",
            "room": room_row["name"],
            "reason": (ban.get("reason") or "")[:500],
            "expires_at": ban.get("expires_at"),
            "banned_by": (banner or {}).get("nickname"),
        })

    # Only now consume the invite (if this was a real code, not a vanity).
    if invite_row:
        consumed = db.consume_invite(code, current_user["id"])
        if not consumed:
            return JSONResponse(status_code=410, content={"error": "Invite invalid or expired"})

    room = {"name": room_row["name"]}

    # Actually add the user as a member (was missing — invite was accepted but
    # user was never inserted into room_members, so the sidebar never updated).
    db.join_room(current_user["id"], target_room_id)
    try:
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "room.member.joined",
            "payload": {
                "room_name": room["name"],
                "nickname": current_user["nickname"],
            },
        })
    except Exception:
        pass

    # Broadcast member_joined to existing members so their sidebar updates
    # without a reload, AND so private-room key rotation can be triggered.
    try:
        await manager.broadcast_room(room["name"], {
            "type": "member_joined",
            "room": room["name"],
            "user_id": current_user["id"],
            "nickname": current_user["nickname"],
            "avatar": current_user.get("avatar"),
        })
    except Exception:
        pass

    # Private-room key handoff: the joiner has no current key. Ask the
    # owner/a moderator to rotate so the joiner receives the new secret
    # via the standard Signal-envelope fanout. See routers/rooms.py.
    try:
        full_room = db.get_room_by_name(room["name"])
        if full_room:
            await request_private_room_rekey(full_room, current_user)
    except Exception:
        pass

    full_room = db.get_room_by_name(room["name"]) or {}
    return {
        "ok": True,
        "room": room["name"],
        "room_type": (full_room.get("type") or "public"),
        "via_vanity": via_vanity,
        "message": f"Successfully joined #{room['name']}"
    }


# Landing page for invite links (served as HTML for unauthenticated users)
@router.get("/{code}/landing", response_class=HTMLResponse)
async def invite_landing_page(code: str):
    """Show invite landing page with login/join options.

    Accepts either a real invite code (looked up in channel_invites) or a
    channel vanity slug (looked up in rooms.vanity). Vanity hits get a
    synthesized invite-shape so the rendering stays unified.
    """
    invite = db.get_invite(code)
    if not invite:
        room = db.get_room_by_vanity(code)
        if room:
            if int(room.get("invite_only") or 0) or (room.get("type") or "public").lower() == "private":
                room = None
            else:
                invite = {
                    "room_name": room["name"],
                    "room_desc": room.get("description", "") or "",
                    "room_icon": room.get("icon", "💬") or "💬",
                    "created_by_name": room.get("owner_nickname"),
                    "_is_vanity": True,
                }
                code = (room.get("vanity") or code).lower()
    if not invite:
        html = """<!DOCTYPE html>
<html><head><title>Invalid Invite - FrogTalk</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#4caf50">
<link rel="icon" href="/static/favicon.ico">
<style>
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;color:#dff5e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:
    radial-gradient(70% 45% at 50% 0%, rgba(127,210,167,.12), transparent 72%),
    radial-gradient(60% 40% at 50% 100%, rgba(46,138,74,.10), transparent 75%),
    linear-gradient(135deg,#0d0d0d,#0d1611);
  display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}
.card{position:relative;background:linear-gradient(180deg,#173027 0%,#13271f 56%,#0f1f17 100%);
  border:1px solid #3b6c59;border-radius:18px;padding:36px 32px;width:100%;max-width:400px;text-align:center;
  box-shadow:0 24px 64px rgba(0,0,0,.55),0 0 0 1px rgba(127,210,167,.06),inset 0 1px 0 rgba(255,255,255,.04)}
.card::after{content:"";position:absolute;left:18px;right:18px;top:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(127,210,167,.5),transparent);pointer-events:none}
h1{font-size:24px;font-weight:800;margin:0 0 10px;
  background:linear-gradient(180deg,#bff0d0,#7fd2a7 70%,#4caf50);
  -webkit-background-clip:text;background-clip:text;color:transparent}
p{color:#bcd6c8;margin:0 0 18px;font-size:14px;line-height:1.45}
a{display:inline-block;padding:11px 20px;border-radius:10px;text-decoration:none;font-weight:600;
  background:linear-gradient(180deg,#5cc163 0%,#4caf50 55%,#3e8c43 100%);
  color:#fff;border:1px solid #6cd870;text-shadow:0 1px 2px rgba(0,0,0,.25);
  box-shadow:0 6px 18px rgba(76,175,80,.35),inset 0 1px 0 rgba(255,255,255,.18)}
a:hover{background:linear-gradient(180deg,#6cd870 0%,#56bd5a 55%,#479e4d 100%)}
</style>
</head><body><div class="card">
<h1>🐸 Invalid Invite</h1>
<p>This invite link is invalid or has expired.</p>
<a href="/app">Go to FrogTalk</a>
</div></body></html>"""
        return HTMLResponse(content=html, status_code=404, headers=_PUBLIC_HTML_NO_CACHE)

    # Channel icons can be either an emoji ("💬") or an uploaded image stored
    # as a base64 data URL / http(s) URL. Render the right element or we end up
    # printing the raw "data:image/png;base64,…" string on the landing page.
    import html as _html_mod
    raw_icon = invite.get('room_icon') or '💬'
    is_img = isinstance(raw_icon, str) and (
        raw_icon.startswith('data:image') or
        raw_icon.startswith('http://') or
        raw_icon.startswith('https://') or
        raw_icon.startswith('/')
    )
    if is_img:
        icon_html = (
            f'<img src="{_html_mod.escape(raw_icon, quote=True)}" alt="" '
            f'style="width:96px;height:96px;border-radius:22px;object-fit:cover;'
            f'display:block;margin:0 auto 14px;'
            f'box-shadow:0 6px 18px rgba(0,0,0,.45),0 0 0 1px rgba(127,210,167,.15)">'
        )
        # For Discord/Telegram previews: data: URLs aren't scrapable, so route
        # through /og/invite/{code}.img which decodes the base64 server-side.
        # Absolute paths and external URLs can be used directly. For vanity
        # short-links the og endpoint won't find a matching code, so fall back
        # to the branded image.
        if raw_icon.startswith('/'):
            og_image = f'https://frogtalk.xyz{raw_icon}'
        elif raw_icon.startswith(('http://', 'https://')):
            og_image = raw_icon
        elif invite.get('_is_vanity'):
            og_image = 'https://frogtalk.xyz/static/icons/og-image.png'
        else:
            og_image = f'https://frogtalk.xyz/og/invite/{code}.img'
    else:
        icon_html = f'<div class="icon">{_html_mod.escape(raw_icon)}</div>'
        # For emoji icons, fall back to the app's branded OG image so the
        # Telegram/Discord preview still shows the FrogTalk logo + name.
        og_image = 'https://frogtalk.xyz/static/icons/og-image.png'

    room_name_safe = _html_mod.escape(invite['room_name'])
    room_desc_safe = _html_mod.escape(invite.get('room_desc') or 'A FrogTalk channel')
    _raw_created_by = (invite.get('created_by_name') or '').strip()
    _created_by_with_handle = f"@{_raw_created_by}" if _raw_created_by else '@someone'
    created_by_safe = _html_mod.escape(_created_by_with_handle)
    created_by_html = (
        f'<a class="invited-by-link" href="/u/{_url_quote(_raw_created_by, safe="")}">{created_by_safe}</a>'
        if _raw_created_by else f"<b>{created_by_safe}</b>"
    )
    # Richer preview description: include inviter + channel purpose so the
    # message preview actually tells you what you're joining.
    raw_bio = (invite.get('room_desc') or 'Join the conversation — end-to-end encrypted chat, voice & video calls.').strip()
    og_desc_full = (
        f"{_created_by_with_handle} invited you to #{invite['room_name']} on FrogTalk. "
        f"{raw_bio}"
    )
    og_desc_safe = _html_mod.escape(og_desc_full[:200])
    canonical = f"https://frogtalk.xyz/i/{code}"

    html = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
{_LANDING_SESSION_HEAD}
<title>Join #{room_name_safe} on FrogTalk</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="{og_desc_safe}">
<link rel="canonical" href="{canonical}">
<meta name="theme-color" content="#4caf50">

<!-- Open Graph (Discord, Telegram, Facebook, Slack, iMessage, Signal) -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="FrogTalk">
<meta property="og:url" content="{canonical}">
<meta property="og:title" content="Join #{room_name_safe} on FrogTalk">
<meta property="og:description" content="{og_desc_safe}">
<meta property="og:image" content="{og_image}">
<meta property="og:image:secure_url" content="{og_image}">
<meta property="og:image:alt" content="FrogTalk — #{room_name_safe}">
<meta property="og:locale" content="en_US">

<!-- Twitter / X card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@frogtalk">
<meta name="twitter:title" content="Join #{room_name_safe} on FrogTalk">
<meta name="twitter:description" content="{og_desc_safe}">
<meta name="twitter:image" content="{og_image}">
<meta name="twitter:image:alt" content="FrogTalk — #{room_name_safe}">

<!-- Telegram-specific: color theme + favicon -->
<meta name="telegram:channel" content="@frogtalk">
<link rel="icon" href="/static/favicon.ico">

<style>
:root{{
  --bg:#0d0d0d;
  --accent:#4caf50;
  --accent-soft:#7fd2a7;
  --text:#dff5e8;
  --muted:#9bb3a4;
}}
*{{box-sizing:border-box}}
html,body{{height:100%}}
body{{
  margin:0;color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:
    radial-gradient(70% 45% at 50% 0%, rgba(127,210,167,.12), transparent 72%),
    radial-gradient(60% 40% at 50% 100%, rgba(46,138,74,.10), transparent 75%),
    linear-gradient(135deg,#0d0d0d,#0d1611);
  display:flex;justify-content:center;align-items:center;min-height:100vh;
  padding:20px;
}}
.card{{
  position:relative;
  background:linear-gradient(180deg,#173027 0%,#13271f 56%,#0f1f17 100%);
  border:1px solid #3b6c59;border-radius:18px;
  padding:36px 32px 30px;width:100%;max-width:420px;
  box-shadow:
    0 24px 64px rgba(0,0,0,.55),
    0 0 0 1px rgba(127,210,167,.06),
    inset 0 1px 0 rgba(255,255,255,.04);
  text-align:center;
}}
.card::after{{
  content:"";position:absolute;left:18px;right:18px;top:0;height:1px;
  background:linear-gradient(90deg, transparent, rgba(127,210,167,.5), transparent);
  pointer-events:none;
}}
.icon{{
  font-size:64px;margin:0 0 14px;line-height:1;
  filter:drop-shadow(0 4px 12px rgba(76,175,80,.35));
}}
h1{{
  font-size:26px;font-weight:800;margin:0 0 6px;letter-spacing:-.01em;
  background:linear-gradient(180deg,#bff0d0,#7fd2a7 70%,#4caf50);
  -webkit-background-clip:text;background-clip:text;color:transparent;
}}
.desc{{color:#bcd6c8;margin:0 0 14px;font-size:14px;line-height:1.45}}
.invited-by{{color:var(--muted);font-size:13px;margin:0 0 22px}}
.invited-by b{{color:#cfeadb;font-weight:600}}
.invited-by-link{{color:#cfeadb;font-weight:600;text-decoration:none}}
.btn{{
  display:block;width:100%;padding:13px 16px;margin:10px 0;
  border:1px solid transparent;border-radius:10px;
  font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;
  text-align:center;transition:transform .08s ease, box-shadow .15s ease, background .15s ease;
}}
.btn-primary{{
  background:linear-gradient(180deg,#5cc163 0%,#4caf50 55%,#3e8c43 100%);
  border-color:#6cd870;color:#fff;
  text-shadow:0 1px 2px rgba(0,0,0,.25);
  box-shadow:0 6px 18px rgba(76,175,80,.35),inset 0 1px 0 rgba(255,255,255,.18);
}}
.btn-primary:hover{{
  background:linear-gradient(180deg,#6cd870 0%,#56bd5a 55%,#479e4d 100%);
  box-shadow:0 8px 22px rgba(76,175,80,.45),inset 0 1px 0 rgba(255,255,255,.22);
  transform:translateY(-1px);
}}
.btn-secondary{{
  background:rgba(127,210,167,.06);
  border-color:rgba(127,210,167,.25);
  color:#dff5e8;
}}
.btn-secondary:hover{{
  background:rgba(127,210,167,.12);
  border-color:rgba(127,210,167,.4);
}}
.note{{color:#7e9b8c;font-size:12px;margin:14px 0 0}}
.note b{{color:#bfe0ce;font-weight:600}}
html.ft-logged-in #btn-secondary{{display:none!important}}
</style>
</head><body>
<div class="card">
{icon_html}
<h1>#{room_name_safe}</h1>
<p class="desc">{room_desc_safe}</p>
<p class="invited-by">Invited by {created_by_html}</p>
<a id="btn-primary" href="/app?invite={code}" class="btn btn-primary">Join</a>
<a id="btn-secondary" href="/app?invite={code}&amp;register=1" class="btn btn-secondary">Create a new account</a>
<p id="note" class="note">You'll join <b>#{room_name_safe}</b> after signing in.</p>
</div>
<script>
// Upgrade CTAs when already signed in (fc_token in localStorage).
(function() {{
  var loggedIn = (typeof window.ftIsLoggedIn === 'function') && window.ftIsLoggedIn();
  var primary = document.getElementById('btn-primary');
  var secondary = document.getElementById('btn-secondary');
  var note = document.getElementById('note');
  if (loggedIn) {{
    document.documentElement.classList.add('ft-logged-in');
    if (primary) {{
      primary.textContent = 'Open in FrogTalk';
      primary.href = '/app?invite={code}';
    }}
    if (secondary) secondary.style.display = 'none';
    if (note) note.textContent = "You're signed in — tap Open to join #{room_name_safe}.";
    setTimeout(function() {{ window.location.href = '/app?invite={code}'; }}, 600);
  }}
}})();
</script>
</body></html>"""
    return HTMLResponse(content=html, headers=_PUBLIC_HTML_NO_CACHE)
