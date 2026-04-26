"""FrogTalk - Secure Social Chat Platform."""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from database import init_db
from routers import auth, rooms, messages, users, ws
from routers import friends as friends_mod
from routers import dms
from routers import push as push_mod
from routers import emojis
from routers import preview as preview_mod
from routers import bots as bots_mod
from routers import invites as invites_mod
from routers import directory as directory_mod
from routers import wall as wall_mod
from routers import location as location_mod
from routers import gifs as gifs_mod
from routers import external_api as external_api_mod
from routers import social as social_mod
from routers import bridge as bridge_mod
from routers import calls as calls_mod
from routers import admin as admin_mod
from routers import federation as federation_mod
from routers import server_admin as server_admin_mod

import asyncio
from database import cleanup_expired_dm_messages, cleanup_expired_captchas

limiter = Limiter(key_func=get_remote_address)


async def cleanup_task():
    """Background task to clean up expired DM messages and CAPTCHAs."""
    while True:
        await asyncio.sleep(60)  # Run every minute
        try:
            deleted = cleanup_expired_dm_messages()
            if deleted > 0:
                print(f"[Cleanup] Deleted {deleted} expired DM messages")
            cleanup_expired_captchas()
        except Exception as e:
            print(f"[Cleanup] Error: {e}")


async def official_directory_sync_task():
    """Background task to sync official federation directory into local registry."""
    interval = int(os.getenv("FROGTALK_OFFICIAL_DIRECTORY_SYNC_INTERVAL_SEC", "900"))
    interval = max(60, interval)
    while True:
        await asyncio.sleep(interval)
        try:
            result = await federation_mod.sync_official_directory_once()
            if result.get("ok"):
                print(f"[Federation] Official directory sync imported={result.get('imported', 0)} skipped={result.get('skipped', 0)}")
            elif result.get("error") != "directory_url_not_set":
                print(f"[Federation] Official directory sync failed: {result.get('error')}")
        except Exception as e:
            print(f"[Federation] Sync task error: {e}")


async def federation_inbox_processor_task():
    """Background task to process incoming federation events with idempotency."""
    while True:
        await asyncio.sleep(5)
        try:
            await federation_mod.federation_inbox_processor()
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[Federation] Inbox processor error: {e}")


async def federation_outbox_processor_task():
    """Background task to push local federation outbox events to peers."""
    while True:
        await asyncio.sleep(5)
        try:
            await federation_mod.federation_outbox_processor()
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[Federation] Outbox processor error: {e}")


async def federation_update_check_task():
    """Background task to keep this node aligned with main-site release feed."""
    interval = int(os.getenv("FROGTALK_UPDATE_CHECK_INTERVAL_SEC", "300"))
    interval = max(60, interval)
    while True:
        await asyncio.sleep(interval)
        try:
            result = federation_mod.run_update_check_background()
            if not result.get("ok"):
                print(f"[Federation] Update check failed: {result.get('error')}")
            elif result.get("update_available"):
                print("[Federation] Update available from main-site feed")
        except Exception as e:
            print(f"[Federation] Update check task error: {e}")


async def _run_boot_sync_nonblocking():
    """Run one-time directory sync without blocking app startup."""
    try:
        boot_sync = await asyncio.wait_for(
            federation_mod.sync_official_directory_once(), timeout=10
        )
        if boot_sync.get("ok"):
            print(f"[Federation] Boot sync imported={boot_sync.get('imported', 0)} skipped={boot_sync.get('skipped', 0)}")
    except asyncio.TimeoutError:
        print("[Federation] Boot sync timed out; continuing startup")
    except Exception as e:
        print(f"[Federation] Boot sync error: {e}")


async def _start_discord_bridge_nonblocking():
    """Start Discord bridge with timeout guard so startup cannot deadlock."""
    try:
        from bridge_discord import start_discord_bridge
        await asyncio.wait_for(start_discord_bridge(), timeout=10)
    except asyncio.TimeoutError:
        print("[Discord Bridge] Startup timed out; continuing without blocking")
    except Exception as e:
        print(f"[Discord Bridge] Could not start: {e}")


async def _start_telegram_bridge_nonblocking():
    """Start Telegram bridge with timeout guard so startup cannot deadlock."""
    try:
        from bridge_telegram import start_telegram_bridge
        await asyncio.wait_for(start_telegram_bridge(), timeout=12)
    except asyncio.TimeoutError:
        print("[Telegram Bridge] Startup timed out; continuing without blocking")
    except Exception as e:
        print(f"[Telegram Bridge] Could not start: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # Start background tasks
    tasks = [
        asyncio.create_task(cleanup_task()),
        asyncio.create_task(official_directory_sync_task()),
        asyncio.create_task(federation_inbox_processor_task()),
        asyncio.create_task(federation_outbox_processor_task()),
        asyncio.create_task(federation_update_check_task()),
        asyncio.create_task(_run_boot_sync_nonblocking()),
        asyncio.create_task(_start_discord_bridge_nonblocking()),
        asyncio.create_task(_start_telegram_bridge_nonblocking()),
    ]
    yield
    # Cancel background tasks on shutdown
    for t in tasks:
        t.cancel()
    for t in tasks:
        try:
            await t
        except asyncio.CancelledError:
            pass


app = FastAPI(title="FrogTalk", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Always return JSON even for unhandled exceptions."""
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=500, content={"error": "Internal server error"})

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api")
app.include_router(rooms.router, prefix="/api")
app.include_router(messages.router, prefix="/api")
# NOTE: friends_mod.users_router exposes /users/search. It MUST be registered
# BEFORE users.router (which has /users/{user_id}) so "search" isn't parsed
# as an int user_id and returned as 422.
app.include_router(friends_mod.users_router, prefix="/api")
app.include_router(users.router, prefix="/api")
app.include_router(friends_mod.router, prefix="/api")
app.include_router(dms.router, prefix="/api")
app.include_router(push_mod.router, prefix="/api")
app.include_router(emojis.router, prefix="/api")
app.include_router(preview_mod.router, prefix="/api")
app.include_router(bots_mod.router, prefix="/api")
app.include_router(invites_mod.router, prefix="/api")
app.include_router(directory_mod.router, prefix="/api")
app.include_router(wall_mod.router, prefix="/api")
app.include_router(location_mod.router, prefix="/api")
app.include_router(gifs_mod.router, prefix="/api")
app.include_router(external_api_mod.router, prefix="/api")
app.include_router(social_mod.router, prefix="/api")
app.include_router(bridge_mod.router, prefix="/api")
app.include_router(calls_mod.router, prefix="/api")
app.include_router(admin_mod.router, prefix="/api")
app.include_router(federation_mod.router, prefix="/api")
app.include_router(server_admin_mod.router)
app.include_router(ws.router)

app.mount("/static", StaticFiles(directory="static"), name="static")


_APP_HTML_PATH = "static/index.html"
_APP_JS_PATH = "static/js/app.js"
_MESSAGES_JS_PATH = "static/js/messages.js"
_UI_JS_PATH = "static/js/ui.js"
_FRIENDS_JS_PATH = "static/js/friends.js"
_DMS_JS_PATH = "static/js/dms.js"
_MEDIA_JS_PATH = "static/js/media.js"


def _serve_app_shell_response() -> HTMLResponse:
    with open(_APP_HTML_PATH, "r", encoding="utf-8") as fh:
        html = fh.read()
    try:
        app_asset_version = str(int(max(
            os.path.getmtime(_APP_JS_PATH),
            os.path.getmtime(_MESSAGES_JS_PATH),
            os.path.getmtime(_UI_JS_PATH),
            os.path.getmtime(_FRIENDS_JS_PATH),
            os.path.getmtime(_DMS_JS_PATH),
            os.path.getmtime(_MEDIA_JS_PATH),
        )))
    except Exception:
        app_asset_version = str(int(time.time()))
    html = html.replace("__APP_ASSET_VERSION__", app_asset_version)
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/invite/{code}")
async def serve_invite_landing(code: str):
    """Serve invite landing page."""
    from routers.invites import invite_landing_page
    return await invite_landing_page(code)


def _og_escape(s: str) -> str:
    """Minimal HTML attribute escape for OG tags."""
    return (
        (s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _og_is_public_avatar(avatar: str | None) -> bool:
    """OG scrapers can't resolve data: URLs — only use http(s) avatars."""
    return bool(avatar) and (avatar.startswith("http://") or avatar.startswith("https://"))


@app.get("/u/{nickname}", response_class=HTMLResponse)
async def serve_profile_landing(nickname: str):
    """Public profile share page with Open Graph / Twitter card metadata.

    Logged-in clients are redirected into the app; scrapers (Telegram,
    Discord, Twitter, Facebook) get a preview card.
    """
    import database as db
    user = db.get_user_by_nick(nickname)
    if not user:
        html = (
            "<!DOCTYPE html><html><head><title>User not found — FrogTalk</title>"
            "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
            "<style>body{background:#0f0f0f;color:#e0e0e0;font-family:system-ui;"
            "display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}"
            ".card{background:#1a1a1a;padding:40px;border-radius:16px;text-align:center;max-width:400px}"
            "h1{color:#4caf50}a{color:#4caf50}</style></head>"
            "<body><div class=card><h1>🐸 Not found</h1>"
            f"<p>No FrogTalk user named <b>{_og_escape(nickname)}</b>.</p>"
            "<a href=\"/app\">Go to FrogTalk</a></div></body></html>"
        )
        return HTMLResponse(content=html, status_code=404)

    nick = user["nickname"]
    # Respect the user's privacy toggle: profile_public=0 means anonymous
    # viewers (and scrapers) get a minimal "this profile is private" page
    # with no bio / avatar / follower counts exposed.
    is_public_profile = bool(user.get("profile_public", 1))
    if not is_public_profile:
        priv_html = f"""<!DOCTYPE html>
<html><head><meta charset=\"utf-8\">
<title>@{_og_escape(nick)} — FrogTalk</title>
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
<meta name=\"description\" content=\"This FrogTalk profile is private.\">
<meta name=\"robots\" content=\"noindex\">
<meta property=\"og:title\" content=\"FrogTalk — Private profile\">
<meta property=\"og:description\" content=\"This FrogTalk profile is private. Sign in to view it.\">
<meta property=\"og:image\" content=\"https://frogtalk.xyz/static/icons/og-image.png\">
<meta property=\"og:url\" content=\"https://frogtalk.xyz/u/{nick}\">
<meta name=\"theme-color\" content=\"#4caf50\">
<style>
body{{background:#0f0f0f;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;
 display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}}
.card{{background:#1a1a1a;padding:36px 28px;border-radius:20px;text-align:center;
 max-width:420px;width:100%;border:1px solid #2a4a2a;box-shadow:0 20px 60px rgba(0,0,0,0.5)}}
.lock{{font-size:54px;margin-bottom:10px;line-height:1}}
h1{{color:#4caf50;margin:0 0 6px;font-size:22px}}
p{{color:#aaa;font-size:14px;line-height:1.5;margin:6px 0 22px}}
.btn{{display:block;width:100%;padding:13px;margin:8px 0;border:none;border-radius:10px;
 font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;box-sizing:border-box}}
.btn-primary{{background:#4caf50;color:#000}}
.btn-secondary{{background:#2a2a2a;color:#e0e0e0;border:1px solid #3a3a3a}}
.foot{{margin-top:18px;color:#555;font-size:12px}}.foot a{{color:#4caf50;text-decoration:none}}
</style></head><body>
<div class=\"card\">
  <div class=\"lock\">🔒</div>
  <h1>This profile is private</h1>
  <p>@{_og_escape(nick)} has chosen to keep their profile hidden from public view. Sign in to send a friend request.</p>
  <a href=\"/app?dm={_og_escape(nick)}\" class=\"btn btn-primary\">Sign in to FrogTalk</a>
  <a href=\"/\" class=\"btn btn-secondary\">← Back to frogtalk.xyz</a>
  <div class=\"foot\">🐸 <a href=\"/\">frogtalk.xyz</a></div>
</div>
<script>try{{if(localStorage.getItem('token')){{window.location.replace('/app?profile={_og_escape(nick)}');}}}}catch(e){{}}</script>
</body></html>"""
        return HTMLResponse(content=priv_html)

    bio = (user.get("bio") or user.get("status_msg") or "").strip()
    # Clamp + strip newlines for meta attributes.
    desc = bio.replace("\n", " ").strip()[:180] or f"@{nick} on FrogTalk — secure encrypted chat."
    avatar = user.get("avatar") or ""
    # For OG scrapers (Discord/Telegram): use http(s) avatar directly; for
    # data: URL avatars route through the binary proxy so the display pic
    # still appears in share previews. Emoji/empty → proxy serves branded.
    if _og_is_public_avatar(avatar):
        og_image = avatar
    elif avatar.startswith("data:image/"):
        og_image = f"https://frogtalk.xyz/og/user/{nick}.img"
    else:
        og_image = "https://frogtalk.xyz/static/icons/icon-512.png"
    canonical = f"https://frogtalk.xyz/u/{nick}"

    # For the visible card, prefer the raw avatar (browsers support data: URLs
    # natively — avoids an extra proxy hop). og_image is used for scrapers.
    card_avatar = avatar if avatar else og_image
    html = f"""<!DOCTYPE html>
<html><head>
<meta charset=\"utf-8\">
<title>@{_og_escape(nick)} on FrogTalk</title>
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
<meta name=\"description\" content=\"{_og_escape(desc)}\">
<link rel=\"canonical\" href=\"{canonical}\">
<meta property=\"og:type\" content=\"profile\">
<meta property=\"og:site_name\" content=\"FrogTalk\">
<meta property=\"og:title\" content=\"@{_og_escape(nick)} on FrogTalk\">
<meta property=\"og:description\" content=\"{_og_escape(desc)}\">
<meta property=\"og:image\" content=\"{_og_escape(og_image)}\">
<meta property=\"og:url\" content=\"{canonical}\">
<meta property=\"profile:username\" content=\"{_og_escape(nick)}\">
<meta name=\"twitter:card\" content=\"summary_large_image\">
<meta name=\"twitter:title\" content=\"@{_og_escape(nick)} on FrogTalk\">
<meta name=\"twitter:description\" content=\"{_og_escape(desc)}\">
<meta name=\"twitter:image\" content=\"{_og_escape(og_image)}\">
<meta name=\"theme-color\" content=\"#4caf50\">
<style>
body{{background:#0f0f0f;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;
 display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}}
.card{{background:#1a1a1a;padding:32px 28px;border-radius:20px;text-align:center;
 max-width:420px;width:100%;border:1px solid #2a4a2a;box-shadow:0 20px 60px rgba(0,0,0,0.5)}}
.avatar{{width:96px;height:96px;border-radius:50%;margin:0 auto 14px;
 background:#222 center/cover no-repeat;border:3px solid #4caf50;box-shadow:0 4px 20px rgba(76,175,80,0.3)}}
h1{{color:#4caf50;margin:0 0 6px;font-size:26px}}
.handle{{color:#888;font-size:14px;margin-bottom:14px}}
.bio{{color:#d0d0d0;font-size:15px;line-height:1.4;margin:14px 0 22px;word-wrap:break-word}}
.btn{{display:block;width:100%;padding:14px;margin:8px 0;border:none;border-radius:10px;
 font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;box-sizing:border-box;
 transition:transform .1s,opacity .15s}}
.btn:hover{{opacity:0.92;transform:translateY(-1px)}}
.btn-primary{{background:#4caf50;color:#000}}
.btn-secondary{{background:#2a2a2a;color:#e0e0e0;border:1px solid #3a3a3a}}
.foot{{margin-top:18px;color:#555;font-size:12px}}
.foot a{{color:#4caf50;text-decoration:none}}
</style></head><body>
<div class=\"card\">
  <div class=\"avatar\" style=\"background-image:url('{_og_escape(card_avatar)}')\"></div>
  <h1>@{_og_escape(nick)}</h1>
  <div class=\"handle\">FrogTalk · secure encrypted chat</div>
  {f'<div class="bio">{_og_escape(bio)}</div>' if bio else ''}
  <a href=\"/app?profile={_og_escape(nick)}\" class=\"btn btn-primary\">View profile</a>
  <a href=\"/app?dm={_og_escape(nick)}\" class=\"btn btn-secondary\">💬 Send a message</a>
  <div class=\"foot\">🐸 <a href=\"/\">frogtalk.xyz</a></div>
</div>
<script>
// Already logged in? Jump straight into the app.
try {{
  if (localStorage.getItem('token')) {{
    window.location.replace('/app?profile={_og_escape(nick)}');
  }}
}} catch (e) {{}}
</script>
</body></html>"""
    return HTMLResponse(content=html)


@app.get("/c/{room_name}", response_class=HTMLResponse)
async def serve_channel_landing(room_name: str):
    """Public channel share page with Open Graph card.

    Only reveals info for public rooms; private rooms show a generic join
    prompt so we don't leak descriptions / member counts.
    """
    import database as db
    room = db.get_room_by_name(room_name)
    is_public = bool(room) and not bool(room.get("is_private"))
    if not room:
        html = (
            "<!DOCTYPE html><html><head><title>Channel not found — FrogTalk</title>"
            "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
            "<style>body{background:#0f0f0f;color:#e0e0e0;font-family:system-ui;"
            "display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}"
            ".card{background:#1a1a1a;padding:40px;border-radius:16px;text-align:center;max-width:400px}"
            "h1{color:#4caf50}a{color:#4caf50}</style></head>"
            "<body><div class=card><h1>🐸 Channel not found</h1>"
            "<p>This channel doesn't exist or has been removed.</p>"
            "<a href=\"/app\">Go to FrogTalk</a></div></body></html>"
        )
        return HTMLResponse(content=html, status_code=404)

    icon = (room.get("icon") or "💬") if is_public else "🔒"
    desc_raw = (room.get("description") or "").strip() if is_public else "This is a private FrogTalk channel."
    desc = desc_raw.replace("\n", " ")[:180] or "A FrogTalk channel."
    title = f"#{room_name} on FrogTalk" if is_public else "Private channel on FrogTalk"
    canonical = f"https://frogtalk.xyz/c/{room_name}"
    # OG image: proxy the room icon if it's a data: URL so Discord/Telegram
    # can render it; otherwise use http(s) directly, or branded fallback.
    raw_icon = (room.get("icon") or "") if is_public else ""
    if raw_icon.startswith(("http://", "https://")):
        og_image = raw_icon
    elif raw_icon.startswith("data:image/"):
        og_image = f"https://frogtalk.xyz/og/room/{room_name}.img"
    else:
        og_image = "https://frogtalk.xyz/static/icons/icon-512.png"
    # Render emoji icons in the card, or <img> for uploaded icons.
    is_img_icon = raw_icon.startswith(("http://", "https://", "data:image/", "/"))
    icon_block = (
        f'<img class=\"icon-img\" src=\"{_og_escape(raw_icon)}\" alt=\"\">'
        if is_img_icon else f'<div class=\"icon\">{_og_escape(icon)}</div>'
    )
    member_count = int(room.get("member_count") or 0)

    html = f"""<!DOCTYPE html>
<html><head>
<meta charset=\"utf-8\">
<title>{_og_escape(title)}</title>
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
<meta name=\"description\" content=\"{_og_escape(desc)}\">
<link rel=\"canonical\" href=\"{canonical}\">
<meta property=\"og:type\" content=\"website\">
<meta property=\"og:site_name\" content=\"FrogTalk\">
<meta property=\"og:title\" content=\"{_og_escape(title)}\">
<meta property=\"og:description\" content=\"{_og_escape(desc)}\">
<meta property=\"og:image\" content=\"{og_image}\">
<meta property=\"og:url\" content=\"{canonical}\">
<meta name=\"twitter:card\" content=\"summary_large_image\">
<meta name=\"twitter:title\" content=\"{_og_escape(title)}\">
<meta name=\"twitter:description\" content=\"{_og_escape(desc)}\">
<meta name=\"twitter:image\" content=\"{og_image}\">
<meta name=\"theme-color\" content=\"#4caf50\">
<style>
body{{background:#0f0f0f;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;
 display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}}
.card{{background:#1a1a1a;padding:36px 28px;border-radius:20px;text-align:center;
 max-width:420px;width:100%;border:1px solid #2a4a2a;box-shadow:0 20px 60px rgba(0,0,0,0.5)}}
.icon{{font-size:64px;margin-bottom:12px;line-height:1}}
.icon-img{{width:96px;height:96px;border-radius:20px;object-fit:cover;display:block;margin:0 auto 12px;box-shadow:0 4px 16px rgba(0,0,0,.4)}}
h1{{color:#4caf50;margin:0 0 6px;font-size:24px;word-break:break-word}}
.meta{{color:#888;font-size:13px;margin-bottom:16px}}
.desc{{color:#d0d0d0;font-size:15px;line-height:1.45;margin:16px 0 22px;word-wrap:break-word}}
.btn{{display:block;width:100%;padding:14px;margin:8px 0;border:none;border-radius:10px;
 font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;box-sizing:border-box;transition:opacity .15s}}
.btn:hover{{opacity:0.92}}
.btn-primary{{background:#4caf50;color:#000}}
.btn-secondary{{background:#2a2a2a;color:#e0e0e0;border:1px solid #3a3a3a}}
.foot{{margin-top:18px;color:#555;font-size:12px}}
.foot a{{color:#4caf50;text-decoration:none}}
</style></head><body>
<div class=\"card\">
  {icon_block}
  <h1>#{_og_escape(room_name)}</h1>
  <div class=\"meta\">{('🌐 Public · ' + str(member_count) + ' member' + ('s' if member_count != 1 else '')) if is_public else '🔒 Private channel'}</div>
  <div class=\"desc\">{_og_escape(desc)}</div>
  <a href=\"/app?room={_og_escape(room_name)}\" class=\"btn btn-primary\">Open channel</a>
  <a href=\"/app\" class=\"btn btn-secondary\">Sign in to FrogTalk</a>
  <div class=\"foot\">🐸 <a href=\"/\">frogtalk.xyz</a></div>
</div>
<script>
try {{
  if (localStorage.getItem('token')) {{
    window.location.replace('/app?room={_og_escape(room_name)}');
  }}
}} catch (e) {{}}
</script>
</body></html>"""
    return HTMLResponse(content=html)


@app.get("/api/ping")
async def api_ping():
    """Lightweight health probe used by the client connection-lost overlay."""
    from fastapi.responses import JSONResponse
    return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})


def _decode_data_url_to_bytes(data_url: str):
    """Convert a data:image/...;base64,... URL into (bytes, mime).

    Returns (None, None) if the input isn't a valid base64 image data URL.
    """
    import base64
    if not data_url or not data_url.startswith("data:image/"):
        return None, None
    try:
        header, _, payload = data_url.partition(",")
        if ";base64" not in header or not payload:
            return None, None
        mime = header.split(";", 1)[0][5:] or "image/png"
        raw = base64.b64decode(payload, validate=False)
        return raw, mime
    except Exception:
        return None, None


def _fallback_og_image() -> "FileResponse":
    """Branded OG image fallback used when a source image can't be proxied."""
    from fastapi.responses import FileResponse, Response
    try:
        return FileResponse(
            "static/icons/og-image.png",
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=3600"},
        )
    except Exception:
        return Response(status_code=404)


@app.get("/og/invite/{code}.img")
async def og_invite_image(code: str):
    """Binary proxy for an invite's channel icon so Discord/Telegram previews
    can render uploaded (data:) images. Falls back to the branded OG image."""
    from fastapi.responses import Response
    import database as db
    invite = db.get_invite(code)
    if not invite:
        return _fallback_og_image()
    icon = invite.get("room_icon") or ""
    raw, mime = _decode_data_url_to_bytes(icon)
    if raw:
        return Response(content=raw, media_type=mime or "image/png",
                        headers={"Cache-Control": "public, max-age=86400"})
    return _fallback_og_image()


@app.get("/og/user/{nickname}.img")
async def og_user_image(nickname: str):
    """Binary proxy for a user's avatar for OG previews."""
    from fastapi.responses import Response
    import database as db
    u = db.get_user_by_nick(nickname)
    if not u:
        return _fallback_og_image()
    # Respect the private-profile toggle: don't leak avatar to scrapers.
    if not bool(u.get("profile_public", 1)):
        return _fallback_og_image()
    av = u.get("avatar") or ""
    raw, mime = _decode_data_url_to_bytes(av)
    if raw:
        return Response(content=raw, media_type=mime or "image/png",
                        headers={"Cache-Control": "public, max-age=86400"})
    return _fallback_og_image()


@app.get("/og/room/{room_name}.img")
async def og_room_image(room_name: str):
    """Binary proxy for a public channel's icon for OG previews."""
    from fastapi.responses import Response
    import database as db
    room = db.get_room_by_name(room_name)
    if not room or room.get("is_private"):
        return _fallback_og_image()
    icon = room.get("icon") or ""
    raw, mime = _decode_data_url_to_bytes(icon)
    if raw:
        return Response(content=raw, media_type=mime or "image/png",
                        headers={"Cache-Control": "public, max-age=86400"})
    return _fallback_og_image()


@app.get("/app")
@app.get("/app/{path:path}")
async def serve_app(path: str = ""):
    return _serve_app_shell_response()


@app.get("/favicon.ico")
async def serve_favicon():
    return FileResponse("static/favicon.ico", media_type="image/x-icon")


@app.get("/manifest.json")
async def serve_manifest():
    return FileResponse("static/manifest.json", media_type="application/manifest+json")


@app.get("/sw.js")
async def serve_sw():
    return FileResponse(
        "static/sw.js",
        media_type="application/javascript",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/download/android")
async def download_android():
    """Always serves the latest Android APK with correct MIME + Content-Disposition."""
    import glob
    import re

    candidates = glob.glob("static/frogtalk-v*.apk")

    def _apk_version(path: str) -> int:
        name = os.path.basename(path)
        m = re.search(r"frogtalk-v(\d+)\.apk$", name, flags=re.IGNORECASE)
        return int(m.group(1)) if m else -1

    path = max(candidates, key=_apk_version) if candidates else "static/frogtalk.apk"
    if not os.path.exists(path):
        return FileResponse("static/index.html")
    return FileResponse(
        path,
        media_type="application/vnd.android.package-archive",
        filename=os.path.basename(path),
    )


@app.get("/download/linux")
async def download_linux():
    """Always serves the latest Linux AppImage."""
    import glob
    candidates = sorted(glob.glob("static/FrogTalk-*.AppImage"))
    path = candidates[-1] if candidates else ""
    if not path or not os.path.exists(path):
        return FileResponse("static/index.html")
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=os.path.basename(path),
    )


@app.get("/download/deb")
async def download_deb():
    """Always serves the latest Debian/Ubuntu .deb package."""
    import glob
    candidates = sorted(glob.glob("static/frogtalk_*_amd64.deb"))
    path = candidates[-1] if candidates else ""
    if not path or not os.path.exists(path):
        return FileResponse("static/index.html")
    return FileResponse(
        path,
        media_type="application/vnd.debian.binary-package",
        filename=os.path.basename(path),
    )


@app.get("/download/windows")
async def download_windows():
    """Always serves the latest Windows installer/exe build."""
    import glob
    candidates = sorted(glob.glob("static/FrogTalk-*-Setup.exe") + glob.glob("static/FrogTalk-*.exe"))
    path = candidates[-1] if candidates else ""
    if not path or not os.path.exists(path):
        return FileResponse("static/index.html")
    return FileResponse(
        path,
        media_type="application/vnd.microsoft.portable-executable",
        filename=os.path.basename(path),
    )


@app.get("/docs/api")
async def docs_api_page():
    page = "static/docs-api.html"
    if os.path.exists(page):
        return FileResponse(page)
    return FileResponse("static/home.html")


@app.get("/docs/node")
async def docs_node_page():
    page = "static/docs-node.html"
    if os.path.exists(page):
        return FileResponse(page)
    return FileResponse("static/home.html")


@app.get("/")
async def serve_home(request: Request):
    # Users often share deep links like /?profile=Alice, /?room=general, or
    # /?invite=XYZ. Those query params are only read by client JS — scrapers
    # (Telegram, Discord, iMessage, Twitter) see the plain home page and
    # display generic meta. Route those through the OG-enabled landing pages
    # so share cards show the real avatar / room / inviter.
    qp = request.query_params
    nick = (qp.get("profile") or qp.get("u") or "").strip()
    if nick:
        return await serve_profile_landing(nick)
    room = (qp.get("room") or qp.get("channel") or qp.get("c") or "").strip()
    if room:
        return await serve_channel_landing(room)
    code = (qp.get("invite") or qp.get("i") or "").strip()
    if code:
        return await serve_invite_landing(code)
    home = "static/home.html"
    if os.path.exists(home):
        return FileResponse(home)
    return FileResponse("static/index.html")


if __name__ == "__main__":
    import uvicorn
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8080"))
    uvicorn.run("main:app", host=host, port=port, reload=False,
                ws_max_size=50 * 1024 * 1024)  # 50 MB to handle large base64 uploads
