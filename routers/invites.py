"""Invite link management routes."""
import secrets
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, HTMLResponse
from pydantic import BaseModel
from typing import Optional

import database as db
from deps import get_current_user

router = APIRouter(prefix="/invites", tags=["invites"])


def generate_invite_code() -> str:
    """Generate a short readable invite code."""
    return secrets.token_urlsafe(8).replace('-', '').replace('_', '')[:8]


class CreateInviteRequest(BaseModel):
    max_uses: int = 0  # 0 = unlimited
    expires_hours: Optional[int] = None  # None = never expires


@router.post("/channels/{room_name}")
async def create_invite(room_name: str, body: CreateInviteRequest, current_user: dict = Depends(get_current_user)):
    """Create an invite link for a channel."""
    room = db.get_room_by_name(room_name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel not found"})
    
    # Check who_can_invite permission
    is_owner = room["owner_id"] == current_user["id"]
    is_mod = db.is_room_moderator(room_name, current_user["id"])
    is_admin = bool(current_user.get("is_admin"))
    who = room.get("who_can_invite", "everyone")
    
    if who == "owner" and not is_owner and not is_admin:
        return JSONResponse(status_code=403, content={"error": "Only the channel owner can create invites"})
    elif who == "mods" and not is_owner and not is_mod and not is_admin:
        return JSONResponse(status_code=403, content={"error": "Only moderators and the owner can create invites"})
    # 'everyone' — any authenticated user can create invites
    
    code = generate_invite_code()
    if db.create_invite(room["id"], current_user["id"], code, body.max_uses, body.expires_hours):
        return {
            "code": code,
            "url": f"https://frogtalk.xyz/invite/{code}",
            "max_uses": body.max_uses,
            "expires_hours": body.expires_hours
        }
    return JSONResponse(status_code=500, content={"error": "Failed to create invite"})


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
    
    invites = db.get_channel_invites(room["id"])
    return {"invites": invites}


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
    """Get public info about an invite (for landing page)."""
    invite = db.get_invite(code)
    if not invite:
        return JSONResponse(status_code=404, content={"error": "Invite not found or expired"})
    
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
        "valid": True
    }


@router.post("/{code}/join")
async def join_via_invite(code: str, current_user: dict = Depends(get_current_user)):
    """Join a channel via invite link."""
    room_id = db.use_invite(code)
    if not room_id:
        return JSONResponse(status_code=410, content={"error": "Invite invalid or expired"})
    
    # Get room info
    with db._conn() as con:
        room = con.execute("SELECT name FROM rooms WHERE id=?", (room_id,)).fetchone()
    
    if not room:
        return JSONResponse(status_code=404, content={"error": "Channel no longer exists"})
    
    # Actually add the user as a member (was missing — invite was accepted but
    # user was never inserted into room_members, so the sidebar never updated).
    db.join_room(current_user["id"], room_id)
    
    return {
        "ok": True,
        "room": room["name"],
        "message": f"Successfully joined #{room['name']}"
    }


# Landing page for invite links (served as HTML for unauthenticated users)
@router.get("/{code}/landing", response_class=HTMLResponse)
async def invite_landing_page(code: str):
    """Show invite landing page with login/join options."""
    invite = db.get_invite(code)
    if not invite:
        html = """<!DOCTYPE html>
<html><head><title>Invalid Invite - FrogTalk</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#0f0f0f;color:#e0e0e0;font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{background:#1a1a1a;padding:40px;border-radius:16px;text-align:center;max-width:400px}
h1{color:#4caf50}a{color:#4caf50}</style>
</head><body><div class="card">
<h1>🐸 Invalid Invite</h1>
<p>This invite link is invalid or has expired.</p>
<a href="/app">Go to FrogTalk</a>
</div></body></html>"""
        return HTMLResponse(content=html, status_code=404)

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
            f'style="width:96px;height:96px;border-radius:20px;object-fit:cover;'
            f'display:block;margin:0 auto 16px;box-shadow:0 4px 16px rgba(0,0,0,.4)">'
        )
        # For Discord/Telegram previews: data: URLs aren't scrapable, so route
        # through /og/invite/{code}.img which decodes the base64 server-side.
        # Absolute paths and external URLs can be used directly.
        if raw_icon.startswith('/'):
            og_image = f'https://frogtalk.xyz{raw_icon}'
        elif raw_icon.startswith(('http://', 'https://')):
            og_image = raw_icon
        else:
            og_image = f'https://frogtalk.xyz/og/invite/{code}.img'
    else:
        icon_html = f'<div class="icon">{_html_mod.escape(raw_icon)}</div>'
        # For emoji icons, fall back to the app's branded OG image so the
        # Telegram/Discord preview still shows the FrogTalk logo + name.
        og_image = 'https://frogtalk.xyz/static/icons/og-image.png'

    room_name_safe = _html_mod.escape(invite['room_name'])
    room_desc_safe = _html_mod.escape(invite.get('room_desc') or 'A FrogTalk channel')
    created_by_safe = _html_mod.escape(invite.get('created_by_name') or 'someone')
    # Richer preview description: include inviter + channel purpose so the
    # message preview actually tells you what you're joining.
    raw_bio = (invite.get('room_desc') or 'Join the conversation — end-to-end encrypted chat, voice & video calls.').strip()
    og_desc_full = (
        f"{invite.get('created_by_name') or 'A friend'} invited you to #{invite['room_name']} on FrogTalk. "
        f"{raw_bio}"
    )
    og_desc_safe = _html_mod.escape(og_desc_full[:200])
    canonical = f"https://frogtalk.xyz/invite/{code}"

    html = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
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
body{{background:#0f0f0f;color:#e0e0e0;font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}}
.card{{background:#1a1a1a;padding:40px;border-radius:16px;text-align:center;max-width:400px;border:1px solid #2a2a2a}}
.icon{{font-size:64px;margin-bottom:16px}}
h1{{color:#4caf50;margin:0 0 8px}}
.desc{{color:#888;margin-bottom:24px}}
.invited-by{{color:#666;font-size:13px;margin-bottom:24px}}
.btn{{display:block;width:100%;padding:14px;margin:8px 0;border:none;border-radius:8px;font-size:16px;cursor:pointer;text-decoration:none;box-sizing:border-box}}
.btn-primary{{background:#4caf50;color:#fff;font-weight:700;text-shadow:0 1px 2px rgba(0,0,0,.25)}}
.btn-secondary{{background:#2a2a2a;color:#e0e0e0}}
.btn:hover{{opacity:0.9}}
</style>
</head><body>
<div class="card">
{icon_html}
<h1>#{room_name_safe}</h1>
<p class="desc">{room_desc_safe}</p>
<p class="invited-by">Invited by {created_by_safe}</p>
<a id="btn-primary" href="/app?invite={code}" class="btn btn-primary">Join</a>
<a id="btn-secondary" href="/app?invite={code}&amp;register=1" class="btn btn-secondary">Create a new account</a>
<p id="note" style="color:#555;font-size:12px;margin-top:14px;margin-bottom:0">You'll join <b>#{room_name_safe}</b> after signing in.</p>
</div>
<script>
// Upgrade the CTAs based on whether the visitor is already signed in.
// We only check localStorage for a session token — no network call — so this
// stays a static landing page for crawlers / preview bots.
(function() {{
  var tok = null;
  try {{ tok = localStorage.getItem('token') || localStorage.getItem('ft_token'); }} catch (e) {{}}
  var primary = document.getElementById('btn-primary');
  var secondary = document.getElementById('btn-secondary');
  var note = document.getElementById('note');
  if (tok) {{
    // Already signed in — one clear action: open the app with the invite applied.
    if (primary) primary.textContent = 'Open in FrogTalk';
    if (secondary) secondary.style.display = 'none';
    if (note) note.textContent = "You're signed in — tap Open to join #{room_name_safe}.";
    // Best-effort auto-redirect after a beat (gives users time to read the card).
    setTimeout(function() {{ window.location.href = '/app?invite={code}'; }}, 600);
  }}
}})();
</script>
</body></html>"""
    return HTMLResponse(content=html)
