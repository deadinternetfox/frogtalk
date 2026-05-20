"""FrogTalk - Secure Social Chat Platform."""
import hashlib
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from urllib.parse import quote as url_quote, urlparse

_LOG_LEVEL = (os.getenv("LOG_LEVEL") or "INFO").strip().upper()
logging.basicConfig(
    level=getattr(logging, _LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
_log = logging.getLogger("frogtalk.main")

# 9th-pass: scrub tokens / passwords / PINs / bot tokens / raw IPs from
# every log line before they reach disk or journalctl. Filter is attached
# at the root logger plus a few uvicorn/slowapi loggers that sometimes
# bypass propagation. Idempotent + cheap (compiled regexes).
try:
    import log_redaction as _log_redaction
    _log_redaction.install()
except Exception as _e:                      # pragma: no cover
    _log.warning("log redaction filter not installed: %s", _e)

_PUBLIC_HTML_NO_CACHE = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}

from fastapi import FastAPI, Request, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from database import init_db
from routers import auth, rooms, messages, users, ws, media as media_mod
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
from routers import bug_reports as bug_reports_mod
from routers import proxy as proxy_mod
# Track A — Signal Protocol prekey bundle endpoints (X3DH + Double
# Ratchet identity / signed-prekey / OTPK pool).
from routers import signal as signal_mod

import asyncio
from database import cleanup_expired_dm_messages, cleanup_expired_captchas, cleanup_expired_stories, cleanup_inactive_public_rooms, cleanup_expired_sessions, wal_checkpoint_truncate

from deps import client_ip, pin_gate, admin_pin_gate
limiter = Limiter(key_func=client_ip)


async def cleanup_task():
    """Background task to clean up expiring content and inactive public rooms.

    DB calls are wrapped in `asyncio.to_thread` so the SQLite work never blocks
    the single uvicorn event loop while the 60s tick runs.
    """
    while True:
        await asyncio.sleep(60)  # Run every minute
        try:
            deleted = await asyncio.to_thread(cleanup_expired_dm_messages)
            if deleted > 0:
                _log.info("Cleanup deleted %d expired DM messages", deleted)
            await asyncio.to_thread(cleanup_expired_captchas)
            try:
                # MED-F1: prune sessions that haven't been used in 60+ days.
                # Sessions get inserted on every login but are rarely
                # actively revoked; this keeps the table (and the
                # rate-limit / PIN-state hashes derived from it) bounded.
                pruned_sessions = await asyncio.to_thread(cleanup_expired_sessions, 60)
                if pruned_sessions:
                    _log.info("Cleanup deleted %d expired sessions", pruned_sessions)
            except Exception:
                _log.exception("session cleanup error")
            try:
                await asyncio.to_thread(cleanup_expired_stories)
            except Exception:
                _log.exception("story cleanup error")
            try:
                # Trim sent / failed / oversized federation outbox rows so the
                # push worker isn't dragged down by hundreds of MB of dead
                # payload_json (those overflow pages would otherwise evict
                # SQLite's page cache and slow every other query).
                from database import prune_federation_outbox
                pruned = await asyncio.to_thread(prune_federation_outbox)
                if any(int(v or 0) for v in (pruned or {}).values()):
                    _log.info("Federation outbox prune: %s", pruned)
            except Exception:
                _log.exception("federation outbox prune error")
            try:
                stale = await asyncio.to_thread(cleanup_inactive_public_rooms)
                deleted_rooms = int((stale or {}).get("deleted") or 0)
                if deleted_rooms > 0:
                    _log.info("Auto-deleted %d inactive public rooms", deleted_rooms)
                    room_names = (stale or {}).get("rooms") or []
                    room_names = room_names if isinstance(room_names, list) else []
                    report = {
                        "deleted_count": deleted_rooms,
                        "deleted_rooms": room_names[:25],
                        "deleted_rooms_truncated": len(room_names) > 25,
                        "directory_active_days": int((stale or {}).get("directory_active_days") or 30),
                        "auto_delete_days": int((stale or {}).get("auto_delete_days") or 0),
                        "pruned_at": int(time.time()),
                    }
                    outbox = federation_mod.enqueue_server_event("server.channel_retention.pruned", report)
                    if not bool((outbox or {}).get("ok")):
                        _log.warning("Failed to enqueue prune report event: %s", (outbox or {}).get("error"))
            except Exception:
                _log.exception("inactive room cleanup error")
        except Exception:
            _log.exception("Cleanup task error")


async def wal_checkpoint_task():
    """Periodically TRUNCATE-checkpoint the SQLite WAL.

    SQLite's automatic checkpoints are PASSIVE and skip pages held by
    any active reader, so under sustained load (long-lived async
    generators, slow http clients) the WAL grows unbounded \u2014 we've
    observed it hit ~400 MB, at which point every transaction has to
    walk the whole file and the API feels uniformly slow. Running a
    TRUNCATE checkpoint every few minutes keeps the WAL bounded.
    """
    interval = int(os.getenv("FROGTALK_WAL_CHECKPOINT_INTERVAL_SEC", "300"))
    interval = max(60, interval)
    while True:
        await asyncio.sleep(interval)
        try:
            r = await asyncio.to_thread(wal_checkpoint_truncate)
            if r.get("busy"):
                _log.info("WAL checkpoint busy=%s log=%s checkpointed=%s",
                          r.get("busy"), r.get("log"), r.get("checkpointed"))
        except Exception:
            _log.exception("WAL checkpoint task error")


async def official_directory_sync_task():
    """Background task to sync official federation directory into local registry."""
    interval = int(os.getenv("FROGTALK_OFFICIAL_DIRECTORY_SYNC_INTERVAL_SEC", "900"))
    interval = max(60, interval)
    while True:
        await asyncio.sleep(interval)
        try:
            result = await federation_mod.sync_official_directory_once()
            if result.get("ok"):
                _log.info("Federation directory sync imported=%s skipped=%s", result.get("imported", 0), result.get("skipped", 0))
            elif result.get("error") != "directory_url_not_set":
                _log.warning("Federation directory sync failed: %s", result.get("error"))
        except Exception:
            _log.exception("Federation sync task error")


async def federation_inbox_processor_task():
    """Background task to process incoming federation events with idempotency."""
    idle_sleep = 30
    busy_sleep = 5
    delay = busy_sleep
    while True:
        await asyncio.sleep(delay)
        try:
            processed = await federation_mod.federation_inbox_processor()
            delay = busy_sleep if processed else idle_sleep
        except asyncio.CancelledError:
            break
        except Exception:
            _log.exception("Federation inbox processor error")
            delay = idle_sleep


async def federation_outbox_processor_task():
    """Background task to push local federation outbox events to peers."""
    idle_sleep = 30
    busy_sleep = 5
    delay = busy_sleep
    while True:
        await asyncio.sleep(delay)
        try:
            sent = await federation_mod.federation_outbox_processor()
            delay = busy_sleep if sent else idle_sleep
        except asyncio.CancelledError:
            break
        except Exception:
            _log.exception("Federation outbox processor error")
            delay = idle_sleep


async def federation_update_check_task():
    """Background task to keep this node aligned with main-site release feed."""
    interval = int(os.getenv("FROGTALK_UPDATE_CHECK_INTERVAL_SEC", "300"))
    interval = max(60, interval)
    while True:
        await asyncio.sleep(interval)
        try:
            # Run the blocking HTTP fetch in a thread so it never stalls the
            # single uvicorn event loop. Cap the total wait so a slow/hung
            # upstream cannot freeze background processing.
            result = await asyncio.wait_for(
                asyncio.to_thread(federation_mod.run_update_check_background),
                timeout=20,
            )
            if not result.get("ok"):
                _log.warning("Federation update check failed: %s", result.get("error"))
            elif result.get("update_available"):
                _log.info("Federation update available from main-site feed")
        except asyncio.TimeoutError:
            _log.warning("Federation update check task timed out; will retry next interval")
        except Exception:
            _log.exception("Federation update check task error")


async def _run_boot_sync_nonblocking():
    """Run one-time directory sync without blocking app startup."""
    try:
        boot_sync = await asyncio.wait_for(
            federation_mod.sync_official_directory_once(), timeout=10
        )
        if boot_sync.get("ok"):
            _log.info("Federation boot sync imported=%s skipped=%s", boot_sync.get("imported", 0), boot_sync.get("skipped", 0))
    except asyncio.TimeoutError:
        _log.warning("Federation boot sync timed out; continuing startup")
    except Exception:
        _log.exception("Federation boot sync error")


async def _start_discord_bridge_nonblocking():
    """Start Discord bridge with timeout guard so startup cannot deadlock."""
    try:
        # CRIT-1: rotate any historical bridges that still carry the
        # well-known literal `"discord"` token before the bot reloads
        # bridge state, so the new per-bridge secret is what gets sent
        # on the first inbound message after restart.
        try:
            from database import rotate_legacy_discord_bridge_tokens
            rotated = await asyncio.to_thread(rotate_legacy_discord_bridge_tokens)
            if rotated:
                _log.info("Discord bridge: rotated %d legacy bridge token(s)", rotated)
        except Exception:
            _log.exception("Discord bridge: legacy token rotation failed")
        from bridge_discord import start_discord_bridge
        await asyncio.wait_for(start_discord_bridge(), timeout=10)
    except asyncio.TimeoutError:
        _log.warning("Discord bridge startup timed out; continuing without blocking")
    except Exception:
        _log.exception("Discord bridge could not start")


async def _start_telegram_bridge_nonblocking():
    """Start Telegram bridge with timeout guard so startup cannot deadlock."""
    try:
        from bridge_telegram import start_telegram_bridge
        await asyncio.wait_for(start_telegram_bridge(), timeout=12)
    except asyncio.TimeoutError:
        _log.warning("Telegram bridge startup timed out; continuing without blocking")
    except Exception:
        _log.exception("Telegram bridge could not start")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # Bump anyio's default thread-pool from 40 → 200 tokens. FastAPI runs
    # every sync dependency (e.g. get_current_user → SQLite session lookup)
    # AND every run_in_threadpool() call against this pool. With 40 tokens
    # a handful of concurrent /api/social/posts/{id}/media base64 decodes
    # for multi-MB videos can pin the entire pool, so /auth/login and
    # every other authenticated request queues behind them — looks like
    # the whole server is hung when really we're just thread-starved.
    # 200 is a safe ceiling: each worker thread is ~8 KiB stack + a single
    # idle SQLite connection (cached thread-local), so even fully saturated
    # we add at most ~2 MiB RSS and have plenty of headroom.
    try:
        import anyio
        limiter = anyio.to_thread.current_default_thread_limiter()
        limiter.total_tokens = 200
        _log.info("anyio threadpool limiter raised to %d", int(limiter.total_tokens))
    except Exception:
        _log.exception("Failed to raise anyio threadpool limiter; using default")
    # Start background tasks
    tasks = [
        asyncio.create_task(cleanup_task()),
        asyncio.create_task(wal_checkpoint_task()),
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

# ── ASGI-level HEAD→GET shim ──────────────────────────────────────────────────
# Starlette/FastAPI only auto-promotes HEAD for a narrow set of response
# types and the behaviour varies by version.  Wrapping at the raw ASGI
# level (before Starlette routing) is the only version-agnostic fix.
# Google Search Console, Bing, and other crawlers probe sitemaps /
# robots.txt via HEAD; a 405 there means 0 discovered pages in GSC.
from starlette.types import ASGIApp as _ASGIApp, Scope as _Scope, Receive as _Receive, Send as _Send

class _HeadAsGetMiddleware:
    """Convert HEAD requests to GET at ASGI scope level, suppress body."""
    __slots__ = ("app",)
    def __init__(self, _app: _ASGIApp) -> None:
        self.app = _app

    async def __call__(self, scope: _Scope, receive: _Receive, send: _Send) -> None:
        if scope.get("type") == "http" and scope.get("method") == "HEAD":
            scope = {**scope, "method": "GET"}
            _body_sent = False

            async def _suppress_body(message: dict) -> None:
                nonlocal _body_sent
                if message.get("type") == "http.response.body":
                    if not _body_sent:
                        _body_sent = True
                        await send({**message, "body": b"", "more_body": False})
                    return
                await send(message)

            await self.app(scope, receive, _suppress_body)
        else:
            await self.app(scope, receive, send)

# Wrap the FastAPI app so the shim sits outside all other middlewares and
# intercepts HEAD before Starlette routing returns 405.
app.router.on_startup   # touch to trigger any deferred setup
_raw_app = app
app.middleware_stack = None  # force rebuild with new outermost wrapper
# We store the raw asgi app reference so we can wrap it after build.
_head_shim_installed = False

_original_build = app.build_middleware_stack
def _patched_build():
    stack = _original_build()
    return _HeadAsGetMiddleware(stack)
app.build_middleware_stack = _patched_build

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


import logging
from http import HTTPStatus as _HTTPStatus2
from fastapi import HTTPException
from fastapi.responses import JSONResponse as _JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

_log = logging.getLogger("frogtalk")
if not _log.handlers:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")


# ── Content-negotiated error responses ──────────────────────────────────────

def _wants_json_error(request: Request) -> bool:
    """Return True for API/AJAX callers that should receive JSON errors."""
    path = (request.url.path or "").lower()
    if path.startswith("/api") or path.startswith("/ws"):
        return True
    accept = (request.headers.get("accept") or "").lower()
    if "application/json" in accept and "text/html" not in accept:
        return True
    if (request.headers.get("x-requested-with") or "").lower() == "xmlhttprequest":
        return True
    return False


def _err_status_text(code: int) -> str:
    try:
        return _HTTPStatus2(code).phrase
    except Exception:
        return "Error"


def _he(s: str) -> str:
    """Minimal HTML escape for inline text."""
    return (
        (s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


_ERROR_THEME = {
    401: ("\U0001f512", "#7dd3fc", "125,211,252"),
    403: ("\U0001f6ab", "#fca5a5", "252,165,165"),
    404: ("\U0001f438", "#4caf50", "76,175,80"),
    429: ("\u23f3",     "#fcd34d", "252,211,77"),
    500: ("\U0001f4a5", "#f87171", "248,113,113"),
    503: ("\U0001f527", "#fb923c", "251,146,60"),
}


def _render_error_page(status_code: int, title: str, message: str, request: Request) -> str:
    safe_title = _he(title)
    safe_msg   = _he(message)
    code_label = _he(f"{status_code} {_err_status_text(status_code)}")
    req_path   = _he(request.url.path or "/")
    is_auth    = status_code in (401, 403)
    cta_href   = "/app?login=1" if is_auth else "/app"
    cta_text   = "Sign in" if is_auth else "Open FrogTalk"
    emoji, accent, glow = _ERROR_THEME.get(status_code, ("\u26a0\ufe0f", "#4caf50", "76,175,80"))
    return f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0d0d0d">
<meta name="robots" content="noindex">
<title>{safe_title} \u2014 FrogTalk</title>
<link rel="icon" href="/static/icons/icon-96.png" type="image/png">
<style>
  *{{box-sizing:border-box;margin:0;padding:0}}
  :root{{
    --bg:#0a0f0a;--surface:#131a13;--surface2:#192319;
    --border:rgba(76,175,80,.16);--text:#dff5e8;--muted:#8db89b;
    --accent:{accent};
    --glow:rgba({glow},.4);--glow-med:rgba({glow},.22);--glow-soft:rgba({glow},.1);
  }}
  html,body{{
    height:100%;background:var(--bg);color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;overflow-x:hidden;
  }}
  body{{
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    min-height:100dvh;padding:clamp(16px,4vw,32px);
  }}

  /* ── animated background ── */
  .bg{{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}}
  .bg::before{{
    content:'';position:absolute;inset:0;
    background-image:radial-gradient(circle at 1px 1px,rgba(76,175,80,.11) 1px,transparent 0);
    background-size:28px 28px;
    -webkit-mask-image:radial-gradient(ellipse 90% 90% at 50% 50%,#000 20%,transparent 100%);
    mask-image:radial-gradient(ellipse 90% 90% at 50% 50%,#000 20%,transparent 100%);
  }}
  .orb{{position:absolute;border-radius:50%;filter:blur(90px);will-change:transform;animation:drift linear infinite}}
  .orb1{{
    width:520px;height:520px;top:-18%;left:-12%;animation-duration:24s;
    background:radial-gradient(circle,rgba({glow},.16) 0%,transparent 68%);
  }}
  .orb2{{
    width:420px;height:420px;bottom:-12%;right:-10%;animation-duration:30s;animation-delay:-11s;
    background:radial-gradient(circle,rgba(40,120,65,.11) 0%,transparent 68%);
  }}
  .orb3{{
    width:280px;height:280px;top:38%;left:55%;animation-duration:19s;animation-delay:-5s;
    background:radial-gradient(circle,rgba({glow},.09) 0%,transparent 68%);
  }}
  @keyframes drift{{
    0%{{transform:translate(0,0) scale(1)}}
    30%{{transform:translate(38px,-28px) scale(1.04)}}
    65%{{transform:translate(-18px,36px) scale(.97)}}
    100%{{transform:translate(0,0) scale(1)}}
  }}

  /* ── page wrapper ── */
  .wrap{{
    position:relative;z-index:1;
    display:flex;flex-direction:column;align-items:center;
    width:100%;max-width:520px;
    animation:rise .5s cubic-bezier(.22,1,.36,1) both;
  }}
  @keyframes rise{{
    from{{opacity:0;transform:translateY(22px)}}
    to{{opacity:1;transform:translateY(0)}}
  }}

  /* ── brand ── */
  .brand{{
    display:flex;align-items:center;gap:10px;margin-bottom:26px;
    text-decoration:none;color:inherit;
  }}
  .brand-icon{{
    width:38px;height:38px;border-radius:11px;
    background:linear-gradient(145deg,#2e6e36,#1d4625);
    border:1px solid rgba(76,175,80,.4);
    display:flex;align-items:center;justify-content:center;font-size:21px;
    box-shadow:0 4px 18px rgba(0,0,0,.55),0 0 0 3px rgba({glow},.1);
  }}
  .brand-name{{
    font-size:17px;font-weight:700;letter-spacing:-.2px;
    background:linear-gradient(155deg,#c8f0d0 0%,#7fd2a7 100%);
    -webkit-background-clip:text;background-clip:text;color:transparent;
  }}

  /* ── card ── */
  .card{{
    position:relative;width:100%;overflow:hidden;text-align:center;
    padding:clamp(22px,5vw,38px) clamp(18px,5vw,34px) clamp(22px,4vw,30px);
    border-radius:22px;
    background:linear-gradient(175deg,rgba(25,35,25,.97) 0%,rgba(19,26,19,.99) 100%);
    border:1px solid var(--border);
    box-shadow:
      0 40px 80px rgba(0,0,0,.7),
      0 0 0 1px rgba(76,175,80,.03),
      inset 0 1px 0 rgba(255,255,255,.045),
      0 0 64px var(--glow-soft);
    backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  }}
  /* top-edge highlight */
  .card::before{{
    content:'';position:absolute;top:0;left:0;right:0;height:1px;
    background:linear-gradient(90deg,transparent 0%,rgba({glow},.55) 50%,transparent 100%);
  }}
  /* inner radial glow */
  .card::after{{
    content:'';position:absolute;inset:0;pointer-events:none;border-radius:22px;
    background:radial-gradient(ellipse 65% 45% at 50% 0%,rgba({glow},.07) 0%,transparent 70%);
  }}

  /* ── emoji badge ── */
  .emoji-badge{{
    display:inline-flex;align-items:center;justify-content:center;
    width:62px;height:62px;border-radius:18px;
    background:rgba({glow},.09);border:1px solid rgba({glow},.2);
    font-size:30px;line-height:1;margin-bottom:14px;
    box-shadow:0 0 28px rgba({glow},.18),inset 0 1px 0 rgba(255,255,255,.05);
    animation:badge-pulse 3.5s ease-in-out infinite;
  }}
  @keyframes badge-pulse{{
    0%,100%{{box-shadow:0 0 22px rgba({glow},.18),inset 0 1px 0 rgba(255,255,255,.05)}}
    50%{{box-shadow:0 0 40px rgba({glow},.34),inset 0 1px 0 rgba(255,255,255,.05)}}
  }}

  /* ── pill ── */
  .pill{{
    display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;
    margin-bottom:11px;background:rgba({glow},.08);border:1px solid rgba({glow},.22);
    color:var(--accent);font-size:11px;font-weight:700;letter-spacing:.55px;text-transform:uppercase;
  }}

  /* ── big code number ── */
  .code{{
    font-size:clamp(58px,14vw,82px);font-weight:900;line-height:1;
    letter-spacing:-4px;margin-bottom:10px;
    background:linear-gradient(170deg,var(--accent) 0%,rgba({glow},.45) 120%);
    -webkit-background-clip:text;background-clip:text;color:transparent;
    filter:drop-shadow(0 0 28px var(--glow-med));
  }}

  h1{{font-size:clamp(18px,4vw,21px);font-weight:700;line-height:1.25;margin-bottom:9px;color:var(--text)}}
  .desc{{font-size:14px;line-height:1.65;color:var(--muted)}}

  /* ── path label ── */
  .path{{
    display:inline-flex;align-items:center;gap:7px;margin-top:15px;padding:7px 12px;
    border-radius:9px;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.055);
    font-size:12px;color:#7a9e87;max-width:100%;word-break:break-all;
    font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;
  }}
  .path-lbl{{
    color:#3e6044;flex-shrink:0;font-size:10px;text-transform:uppercase;
    letter-spacing:.55px;font-weight:700;
  }}

  .divider{{
    height:1px;margin:20px 0;
    background:linear-gradient(90deg,transparent,rgba({glow},.22),rgba(76,175,80,.1),transparent);
  }}

  /* ── buttons ── */
    .actions{{display:flex;flex-wrap:wrap;gap:9px;justify-content:center}}
  .btn{{
    display:inline-flex;align-items:center;justify-content:center;
    padding:10px 20px;border-radius:12px;font-size:13.5px;font-weight:600;
    text-decoration:none;border:1px solid transparent;position:relative;overflow:hidden;
    transition:transform .15s ease,box-shadow .2s ease,opacity .15s ease;
  }}
  .btn::after{{
    content:'';position:absolute;inset:0;
    background:linear-gradient(180deg,rgba(255,255,255,.07) 0%,transparent 55%);
    opacity:0;transition:opacity .2s ease;
  }}
  .btn:hover::after{{opacity:1}}
  .btn:hover{{transform:translateY(-2px)}}
  .btn:active{{transform:translateY(0);opacity:.82}}
  .btn-primary{{
    background:linear-gradient(180deg,#5dc264 0%,#4caf50 55%,#3c9245 100%);
    border-color:rgba(108,218,118,.32);color:#fff;
    text-shadow:0 1px 2px rgba(0,0,0,.28);
    box-shadow:0 5px 22px rgba(76,175,80,.4),inset 0 1px 0 rgba(255,255,255,.18);
  }}
  .btn-primary:hover{{box-shadow:0 9px 32px rgba(76,175,80,.58),inset 0 1px 0 rgba(255,255,255,.18)}}
  .btn-ghost{{
    background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.09);color:var(--muted);
  }}
  .btn-ghost:hover{{
    background:rgba(255,255,255,.075);border-color:rgba(255,255,255,.14);
    color:var(--text);box-shadow:0 4px 18px rgba(0,0,0,.32);
  }}

  /* ── footer ── */
  .foot{{margin-top:22px;font-size:12px;color:#3a5242;text-align:center;position:relative;z-index:1}}
  .foot a{{color:#4c6a56;text-decoration:none;transition:color .15s}}
  .foot a:hover{{color:var(--accent)}}

  /* ── responsive ── */
  @media(max-width:360px){{
    .emoji-badge{{width:52px;height:52px;font-size:26px;border-radius:14px}}
    .actions{{flex-direction:column}}
    .btn{{width:100%;justify-content:center}}
  }}
</style>
</head><body>
<div class="bg">
  <div class="orb orb1"></div>
  <div class="orb orb2"></div>
  <div class="orb orb3"></div>
</div>
<div class="wrap">
  <a class="brand" href="/"><div class="brand-icon">\U0001f438</div><span class="brand-name">FrogTalk</span></a>
  <main class="card" role="main">
    <div class="emoji-badge">{emoji}</div>
    <div class="pill">{code_label}</div>
    <div class="code">{status_code}</div>
    <h1>{safe_title}</h1>
    <p class="desc">{safe_msg}</p>
    <div class="path"><span class="path-lbl">path</span>&ensp;{req_path}</div>
    <div class="divider"></div>
    <div class="actions">
      <a class="btn btn-primary" href="{cta_href}">{cta_text}</a>
      <a class="btn btn-ghost" href="javascript:history.back()">\u2190 Go back</a>
      <a class="btn btn-ghost" href="/">Home</a>
    </div>
  </main>
  <footer class="foot">
    <a href="https://frogtalk.xyz">frogtalk.xyz</a> &nbsp;\u00b7&nbsp; <a href="/static/privacy.html">Privacy</a>
  </footer>
</div>
</body></html>"""


def _json_http_error(status_code: int, detail=None) -> _JSONResponse:
    phrase = _err_status_text(status_code)
    return _JSONResponse(status_code=status_code, content={"error": detail or phrase})


async def _handle_http_exc(request: Request, exc: StarletteHTTPException) -> HTMLResponse:
    """Shared content-negotiated handler for HTTP errors."""
    status_code = int(exc.status_code or 500)
    detail = str(exc.detail or _err_status_text(status_code))
    if _wants_json_error(request):
        return _json_http_error(status_code, detail)
    _TITLES = {
        400: ("Bad request",           "The request was malformed or missing required data."),
        401: ("Sign in required",      "You need an active FrogTalk session to view this page."),
        403: ("Access denied",         "You do not have permission to view this page."),
        404: ("Page not found",        "This link does not exist or may have been moved."),
        405: ("Method not allowed",    "That action is not supported here."),
        429: ("Slow down",             "Too many requests \u2014 please wait a moment and try again."),
        503: ("Service unavailable",   "FrogTalk is temporarily down for maintenance. Check back soon."),
    }
    title, msg = _TITLES.get(status_code, (_err_status_text(status_code), detail))
    headers = dict(_PUBLIC_HTML_NO_CACHE)
    if getattr(exc, "headers", None):
        headers.update(exc.headers)
    return HTMLResponse(
        content=_render_error_page(status_code, title, msg, request),
        status_code=status_code,
        headers=headers,
    )


# FastAPI >= 0.111 uses a subclass of starlette HTTPException that is a
# distinct class object. FastAPI registers its own JSON handler for that
# subclass at app init, which beats our StarletteHTTPException handler in
# the MRO walk. Register for BOTH to intercept all HTTP errors.
@app.exception_handler(StarletteHTTPException)
async def starlette_http_exception_handler(request: Request, exc: StarletteHTTPException):
    return await _handle_http_exc(request, exc)


@app.exception_handler(HTTPException)
async def fastapi_http_exception_handler(request: Request, exc: HTTPException):
    return await _handle_http_exc(request, exc)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Return JSON for API callers and themed HTML for page requests."""
    if isinstance(exc, (HTTPException, StarletteHTTPException, RateLimitExceeded)):
        return await _handle_http_exc(request, exc)
    _log.exception("Unhandled error on %s %s", request.method, request.url.path)
    if _wants_json_error(request):
        return _JSONResponse(status_code=500, content={"error": "Internal server error"})
    return HTMLResponse(
        content=_render_error_page(
            500,
            "Something went wrong",
            "An unexpected server error occurred. Please try again in a moment.",
            request,
        ),
        status_code=500,
        headers=_PUBLIC_HTML_NO_CACHE,
    )


# ── CORS ────────────────────────────────────────────────────────────────────
# `*` + credentials is invalid per the CORS spec and silently breaks
# credentialed cross-origin in modern browsers. Default to the canonical
# domain; operators override via ALLOWED_ORIGINS env (comma-separated).
_default_origins = "https://frogtalk.xyz,https://www.frogtalk.xyz"
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", _default_origins).split(",") if o.strip()]
_cors_credentials = "*" not in ALLOWED_ORIGINS
# Tightened from the wildcard defaults so a misbehaving extension or
# rogue page can't slip exotic headers/methods into a credentialed
# request. CONNECT and TRACE in particular are never used by the SPA.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=_cors_credentials,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-Session-Token",
        "X-Api-Key",
        "X-Federation-Token",
        "X-CSRF-Token",
        "X-Requested-With",
    ],
    expose_headers=["Content-Disposition"],
    max_age=600,
)

# Gzip JSON / HTML responses ≥1KB. Skips already-compressed media.
app.add_middleware(GZipMiddleware, minimum_size=1024)


# ── Security headers ────────────────────────────────────────────────────────
# HSTS is conditional: only emitted on HTTPS requests so local http://
# dev doesn't get pinned.
#
# CSP is now ENFORCED by default (HIGH-7).
#
# Migration path:
#   Phase A (SHIPPED): ENFORCE the policy, KEEP `'unsafe-inline'` for
#     script-src + style-src so the ~337 inline onclick= handlers and
#     ~794 inline `style="..."` attributes in static/index.html keep
#     working. Everything else (connect-src, img-src, object-src, base-uri,
#     form-action, frame-ancestors) is enforced strictly, which still
#     blocks the highest-impact XSS exploitation paths (data exfil to
#     attacker domains, `<object>`/Flash injection, base-href hijack,
#     form-action hijack, clickjacking via iframe).
#
#   Phase B (TODO, tracked in docs/SECURITY_PASS_2.md):
#     - Migrate inline handlers to addEventListener.
#     - Migrate inline styles to CSS classes or `el.style.X = …`.
#     - Drop `'unsafe-inline'` from script-src + style-src.
#     - Switch to `'strict-dynamic' 'nonce-…'` for script-src.
#
# A per-request nonce is generated below and exposed via
# `request.state.csp_nonce`. Future inline <script nonce="…"> /
# <style nonce="…"> tags emitted by templates can use it; the nonce
# is INCLUDED in script-src / style-src today so it Just Works as we
# migrate, without needing another CSP rev.
#
# Set FROGTALK_CSP_ENFORCE=0 to temporarily roll back to report-only if a
# regression is found in production.
_CSP_ENFORCE = os.getenv("FROGTALK_CSP_ENFORCE", "1").strip().lower() in ("1", "true", "yes", "on")
_CSP_HEADER_NAME = (
    "Content-Security-Policy" if _CSP_ENFORCE else "Content-Security-Policy-Report-Only"
)


def _build_csp_header(nonce: str) -> str:
    """Single source of truth for the CSP policy.

    `nonce` is embedded into script-src / style-src so any future
    template-emitted <script nonce="…"> works without a directive
    rewrite. The presence of the nonce source list activates CSP3
    behaviour on modern browsers; however, because `'unsafe-inline'`
    is still listed (Phase A migration), modern browsers fall back
    to allowing inline content for back-compat with the legacy
    handlers. When we drop `'unsafe-inline'` in Phase B, modern
    browsers will switch to nonce-only enforcement automatically.
    """
    return (
        "default-src 'self'; "
        f"script-src 'self' 'unsafe-inline' 'nonce-{nonce}' https://frogtalk.xyz; "
        f"style-src 'self' 'unsafe-inline' 'nonce-{nonce}' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; "
        "img-src 'self' data: blob: https:; "
        "media-src 'self' data: blob: https:; "
        # WebSockets to same origin + KLIPY (primary GIF/sticker CDN) +
        # Tenor (legacy fallback until 2026-06-30 sunset). frame-src is
        # narrow on purpose: blocks attacker pages from being iframed
        # inside FrogTalk via stored-XSS injected <iframe>.
        "connect-src 'self' wss: https://api.klipy.com https://media.klipy.com https://cdn.klipy.com https://tenor.googleapis.com https://media.tenor.com; "
        "frame-src 'self' https://www.youtube.com https://open.spotify.com https://platform.twitter.com; "
        # Hard locks (no inline-handler dependency, so safe to enforce today).
        "frame-ancestors 'self'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "object-src 'none'; "
        "worker-src 'self' blob:"
    )


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    # Per-request CSP nonce (24 url-safe chars = 144 bits entropy). Stored
    # on request.state so any future template/handler can echo it into
    # `<script nonce="…">` / `<style nonce="…">` tags. Inline content
    # without the nonce remains allowed under Phase A (`'unsafe-inline'`).
    nonce = secrets.token_urlsafe(18)
    request.state.csp_nonce = nonce
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    # SAMEORIGIN (not DENY) so the imageboard mini-widget at /board can iframe
    # /app on the same origin. Cross-origin framing is still blocked.
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Permissions-Policy",
        "geolocation=(self), microphone=(self), camera=(self), payment=(), usb=()",
    )
    response.headers.setdefault(_CSP_HEADER_NAME, _build_csp_header(nonce))
    if request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https":
        response.headers.setdefault(
            "Strict-Transport-Security",
            "max-age=63072000; includeSubDomains; preload",
        )
    # When the request arrives on a Tor hidden service (or the operator
    # has opted the entire node into Tor mode), append a noindex header
    # to every response so the .onion never gets cross-correlated with
    # the clearnet host on Google/Bing/etc.
    try:
        host_hdr = (request.headers.get("host") or "").lower()
        fwd_host = (request.headers.get("x-forwarded-host") or "").lower()
        is_onion = host_hdr.endswith(".onion") or fwd_host.endswith(".onion")
        # HIGH-14: treat TOR_MODE and TOR_ENABLED as equivalent.
        is_tor_node = (
            os.getenv("FROGTALK_TOR_MODE", "").strip().lower() in ("1", "true", "yes", "on")
            or os.getenv("FROGTALK_TOR_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
        )
        if is_onion or is_tor_node:
            response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    except Exception:
        pass
    return response


# ── HIGH-2: CSRF middleware for cookie-authenticated mutating requests ──
# Browser cookie sessions are vulnerable to CSRF: a malicious cross-origin
# page can issue same-site POSTs that ride the cookie. SameSite=Lax blocks
# top-level POST navigation but is bypassed by, e.g., a victim clicking
# on a malicious link that opens a same-site form, or by a sibling
# vulnerability that lets the attacker open a top-level POST.
#
# Defense: double-submit token. On login we set TWO cookies — the
# HttpOnly `ft_session` cookie (the actual auth token) and a sibling
# JS-readable `ft_csrf` cookie (HMAC of the session token under a
# server-only secret). The SPA reads the CSRF cookie and echoes it in
# the `X-CSRF-Token` header on every mutating request.
#
# Enforcement rules:
#   * Skip safe methods (GET/HEAD/OPTIONS).
#   * Skip routes carrying X-Session-Token or Authorization headers —
#     those auth paths are header-only and cannot be triggered by an
#     attacker page (custom headers trip CORS preflight).
#   * Skip the federation routes — peer-to-peer signed traffic.
#   * Skip WebSocket upgrades (handled by the WS handshake auth).
#   * If a request HAS the `ft_session` cookie set, require the
#     X-CSRF-Token header AND its value to match the HMAC of the
#     session token. Mismatch / missing → 403.
import hmac as _csrf_hmac
import hashlib as _csrf_hashlib

_CSRF_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
# Routes that legitimately mutate without a session cookie present
# (federation peer traffic, healthcheck pings, public registration).
# The middleware is keyed on "did the request have a session cookie",
# so federation endpoints called without a cookie skip naturally.
_CSRF_EXEMPT_PATH_PREFIXES = (
    "/api/federation/",   # peer-to-peer; peer auth (signed) does the work
    "/api/bridge/inbound/",  # bridge tokens are bearer auth
    "/api/external/",     # API-key bots
    "/api/server-admin/", # has its own admin webui auth path
    "/api/csp-report",    # browser CSP violation reports
    "/api/auth/login",    # login itself sets the cookie; no token yet
    "/api/auth/register",
    "/api/auth/federation-ticket-login",
    "/api/auth/federation-provision",
    "/api/auth/recover",  # password recovery, no session yet
)


def _expected_csrf_for_token(token: str) -> str:
    secret = (os.getenv("FROGTALK_CSRF_SECRET") or os.getenv("FROGTALK_SESSION_SECRET") or "frogtalk-csrf-derive-v1").encode("utf-8")
    return _csrf_hmac.new(secret, token.encode("utf-8"), _csrf_hashlib.sha256).hexdigest()


@app.middleware("http")
async def _csrf_guard(request: Request, call_next):
    try:
        method = (request.method or "GET").upper()
        if method in _CSRF_SAFE_METHODS:
            return await call_next(request)
        path = request.url.path or ""
        if any(path.startswith(p) for p in _CSRF_EXEMPT_PATH_PREFIXES):
            return await call_next(request)
        # If the request authenticated via header-only paths, skip CSRF.
        if (request.headers.get("x-session-token") or "").strip():
            return await call_next(request)
        if (request.headers.get("authorization") or "").lower().startswith("bearer "):
            return await call_next(request)
        if (request.headers.get("x-api-key") or "").strip():
            return await call_next(request)
        # If there's no session cookie, this isn't a cookie-auth path —
        # let the route's own auth dependency decide (it'll 401).
        sess = (request.cookies.get("ft_session") or "").strip()
        if not sess:
            return await call_next(request)
        # We have a cookie session and a mutating method on a non-exempt
        # path. CSRF token is required.
        provided = (request.headers.get("x-csrf-token") or "").strip()
        if not provided:
            return JSONResponse(
                status_code=403,
                content={"error": "Missing CSRF token", "code": "csrf_missing"},
            )
        expected = _expected_csrf_for_token(sess)
        if not _csrf_hmac.compare_digest(provided, expected):
            return JSONResponse(
                status_code=403,
                content={"error": "Invalid CSRF token", "code": "csrf_invalid"},
            )
    except Exception:
        # Never let CSRF middleware crash the response — fail open is
        # bad for security but failing entirely would brick login. Log
        # and proceed; the underlying auth check still gates access.
        _log.exception("csrf middleware error")
    return await call_next(request)


app.include_router(auth.router, prefix="/api")
app.include_router(users.public_router, prefix="/api")
# Sensitive routers — server-side PIN gate sits in front. When the user
# has has_pin && pin_require_on_unlock and the session hasn't verified
# the PIN this process (or has been idle past their timeout), every
# request through these routers returns 423 with {pin_required: true}.
# The client (`apiFetch`) catches that, pops the lock screen, then
# retries after the user enters the PIN. Routers that must work pre-
# unlock (auth itself, anonymous public/directory/preview/external_api,
# WebSocket, server-admin which has its own admin gate) deliberately
# stay outside.
_PIN_GATED = [Depends(pin_gate)]
app.include_router(rooms.router, prefix="/api", dependencies=_PIN_GATED)
app.include_router(messages.router, prefix="/api", dependencies=_PIN_GATED)
# SECURITY-PASS-2: off-SQLite media blob serving (gated by session auth).
# Endpoints are GET-only so PIN gating doesn't apply; auth is enforced
# inside the router via `Depends(get_current_user)`.
app.include_router(media_mod.router, prefix="/api")
# NOTE: friends_mod.users_router exposes /users/search. It MUST be registered
# BEFORE users.router (which has /users/{user_id}) so "search" isn't parsed
# as an int user_id and returned as 422.
app.include_router(friends_mod.users_router, prefix="/api", dependencies=_PIN_GATED)
app.include_router(users.router, prefix="/api", dependencies=_PIN_GATED)
app.include_router(friends_mod.router, prefix="/api", dependencies=_PIN_GATED)
app.include_router(dms.router, prefix="/api", dependencies=_PIN_GATED)
# Signal Protocol prekey bundles. PIN-gated like DMs — these endpoints
# only matter to a logged-in user managing their own key material.
app.include_router(signal_mod.router, prefix="/api", dependencies=_PIN_GATED)
app.include_router(push_mod.router, prefix="/api", dependencies=_PIN_GATED)
app.include_router(emojis.router, prefix="/api", dependencies=_PIN_GATED)
app.include_router(preview_mod.router, prefix="/api")
app.include_router(bots_mod.router, prefix="/api", dependencies=_PIN_GATED)
app.include_router(invites_mod.router, prefix="/api", dependencies=_PIN_GATED)
app.include_router(directory_mod.router, prefix="/api")
app.include_router(wall_mod.router, prefix="/api", dependencies=_PIN_GATED)
app.include_router(location_mod.router, prefix="/api", dependencies=_PIN_GATED)
app.include_router(gifs_mod.router, prefix="/api", dependencies=_PIN_GATED)
app.include_router(external_api_mod.router, prefix="/api")
# Image proxy for channel-theme backgrounds — gates the request through
# `get_current_user` and an SSRF allowlist so external URLs can't be
# used to dox viewers via direct browser fetches.
app.include_router(proxy_mod.router, prefix="/api", dependencies=_PIN_GATED)
app.include_router(social_mod.router, prefix="/api", dependencies=_PIN_GATED)
# NOTE: bridge_mod intentionally does NOT use _PIN_GATED. Its bot-facing
# endpoints (`/api/bridge/message`, `/api/bridge/edit`, `/api/bridge/delete`)
# authenticate via a shared `bridge_token` in the request body — they have
# no session cookie, so a router-level pin_gate would 401 every inbound
# Telegram/Discord message. User-facing endpoints in this router declare
# their own `Depends(get_current_user)` per-route.
app.include_router(bridge_mod.router, prefix="/api")
app.include_router(calls_mod.router, prefix="/api", dependencies=_PIN_GATED)
# HIGH-1: admin moderation endpoints get the stricter `admin_pin_gate`
# *in addition to* the regular PIN gate. The stricter gate honors
# `pin_require_for_admin`, which was previously enforced only in the
# browser via `static/js/pin.js` `gateAdmin()`. A stolen session token
# can no longer call `POST /api/admin/ban/{nick}` without a recent PIN
# verification when the user has opted into admin re-prompting.
app.include_router(admin_mod.router, prefix="/api", dependencies=_PIN_GATED + [Depends(admin_pin_gate)])
app.include_router(federation_mod.router, prefix="/api")
app.include_router(server_admin_mod.router)
app.include_router(bug_reports_mod.router, prefix="/api")
app.include_router(ws.router)

app.mount("/static", StaticFiles(directory="static"), name="static")


# Legacy stale-service-worker shim: very old PWA installs cached `/app.js`
# at the root path and keep firing 404s on every load, polluting logs and
# adding request latency. Redirect once to the real /static/js/* path so
# those clients self-heal on the next load.
from fastapi.responses import RedirectResponse as _RedirectResponse

@app.get("/app.js", include_in_schema=False)
async def _legacy_app_js():
    return _RedirectResponse(url="/static/js/app.js", status_code=308)



_APP_HTML_PATH = "static/index.html"
_APP_JS_PATH = "static/js/app.js"
_MESSAGES_JS_PATH = "static/js/messages.js"
_UI_JS_PATH = "static/js/ui.js"
_FRIENDS_JS_PATH = "static/js/friends.js"
_DMS_JS_PATH = "static/js/dms.js"
_MEDIA_JS_PATH = "static/js/media.js"
_ROOMS_JS_PATH = "static/js/rooms.js"
_STATE_JS_PATH = "static/js/state.js"
_WS_JS_PATH = "static/js/ws.js"
_CALLS_JS_PATH = "static/js/calls.js"
_SOCIAL_JS_PATH = "static/js/social.js"
_NOTIFICATIONS_JS_PATH = "static/js/notifications.js"
_MUSIC_JS_PATH = "static/js/music.js"

# Cached app shell. The shell is ~300 KB and was previously read from disk
# on every page load. Caching it in memory cuts the cold-path overhead and
# eliminates 7 stat() syscalls per request. We invalidate on index.html
# mtime change so live edits still apply without a restart.
_SHELL_CACHE: dict = {"mtime": 0.0, "asset_version": "", "html": ""}

def _shell_asset_paths() -> tuple:
    return (
        _APP_JS_PATH, _MESSAGES_JS_PATH, _UI_JS_PATH,
        _FRIENDS_JS_PATH, _DMS_JS_PATH, _MEDIA_JS_PATH,
        _ROOMS_JS_PATH, _STATE_JS_PATH, _WS_JS_PATH,
        _CALLS_JS_PATH, _SOCIAL_JS_PATH, _NOTIFICATIONS_JS_PATH,
        _MUSIC_JS_PATH,
    )


def _serve_app_shell_response() -> HTMLResponse:
    try:
        html_mtime = os.path.getmtime(_APP_HTML_PATH)
    except Exception:
        html_mtime = 0.0
    try:
        # Use a stable fingerprint over shell assets so any file change
        # always bumps the versioned script URLs.
        parts = []
        for p in _shell_asset_paths():
            st = os.stat(p)
            parts.append(f"{p}:{st.st_mtime_ns}:{st.st_size}")
        asset_version = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:12]
    except Exception:
        asset_version = str(int(time.time()))
    cached = _SHELL_CACHE
    if (cached["html"]
            and cached["mtime"] == html_mtime
            and cached["asset_version"] == asset_version):
        html = cached["html"]
    else:
        with open(_APP_HTML_PATH, "r", encoding="utf-8") as fh:
            raw = fh.read()
        html = raw.replace("__APP_ASSET_VERSION__", asset_version)
        cached["html"] = html
        cached["mtime"] = html_mtime
        cached["asset_version"] = asset_version
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


@app.get("/i/{ident}")
async def serve_short_invite_landing(ident: str):
    """Short-link form: /i/<code-or-vanity>.

    Resolves either a real invite code OR a channel vanity slug. The
    landing-page builder transparently handles both shapes.
    """
    from routers.invites import invite_landing_page
    return await invite_landing_page(ident)


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
<meta property=\"og:site_name\" content=\"FrogTalk\">
<meta property=\"og:description\" content=\"This FrogTalk profile is private. Sign in to view it.\">
<meta property=\"og:image\" content=\"https://frogtalk.xyz/static/icons/og-image.png\">
<meta property=\"og:image:secure_url\" content=\"https://frogtalk.xyz/static/icons/og-image.png\">
<meta property=\"og:image:type\" content=\"image/png\">
<meta property=\"og:image:width\" content=\"1200\">
<meta property=\"og:image:height\" content=\"630\">
<meta property=\"og:image:alt\" content=\"FrogTalk private profile\">
<meta property=\"og:locale\" content=\"en_US\">
<meta property=\"og:url\" content=\"https://frogtalk.xyz/u/{nick}\">
<meta name=\"twitter:card\" content=\"summary_large_image\">
<meta name=\"twitter:site\" content=\"@frogtalk\">
<meta name=\"twitter:title\" content=\"FrogTalk — Private profile\">
<meta name=\"twitter:description\" content=\"This FrogTalk profile is private. Sign in to view it.\">
<meta name=\"twitter:image\" content=\"https://frogtalk.xyz/static/icons/og-image.png\">
<meta name=\"twitter:image:alt\" content=\"FrogTalk private profile\">
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
</div>
<script>try{{if(localStorage.getItem('token')){{window.location.replace('/app?profile={_og_escape(nick)}');}}}}catch(e){{}}</script>
</body></html>"""
        return HTMLResponse(content=priv_html)

    bio = (user.get("bio") or user.get("status_msg") or "").strip()
    display_name = (user.get("display_name") or "").strip()
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
<meta property=\"og:image:secure_url\" content=\"{_og_escape(og_image)}\">
<meta property=\"og:image:type\" content=\"image/png\">
<meta property=\"og:image:width\" content=\"1200\">
<meta property=\"og:image:height\" content=\"630\">
<meta property=\"og:image:alt\" content=\"@{_og_escape(nick)} on FrogTalk\">
<meta property=\"og:locale\" content=\"en_US\">
<meta property=\"og:url\" content=\"{canonical}\">
<meta property=\"profile:username\" content=\"{_og_escape(nick)}\">
<meta name=\"twitter:card\" content=\"summary_large_image\">
<meta name=\"twitter:site\" content=\"@frogtalk\">
<meta name=\"twitter:title\" content=\"@{_og_escape(nick)} on FrogTalk\">
<meta name=\"twitter:description\" content=\"{_og_escape(desc)}\">
<meta name=\"twitter:image\" content=\"{_og_escape(og_image)}\">
<meta name=\"twitter:image:alt\" content=\"@{_og_escape(nick)} on FrogTalk\">
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
  {f'<h1>{_og_escape(display_name)}</h1>' if display_name else f'<h1>@{_og_escape(nick)}</h1>'}
  <div class=\"handle\">{f'@{_og_escape(nick)} · FrogTalk' if display_name else 'FrogTalk · secure encrypted chat'}</div>
  {f'<div class="bio">{_og_escape(bio)}</div>' if bio else ''}
  <a href=\"/app?profile={_og_escape(nick)}\" class=\"btn btn-primary\">View profile</a>
  <a href=\"/app?dm={_og_escape(nick)}\" class=\"btn btn-secondary\">💬 Send a message</a>
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
<meta property=\"og:image:secure_url\" content=\"{og_image}\">
<meta property=\"og:image:type\" content=\"image/png\">
<meta property=\"og:image:width\" content=\"1200\">
<meta property=\"og:image:height\" content=\"630\">
<meta property=\"og:image:alt\" content=\"FrogTalk channel #{_og_escape(room_name)}\">
<meta property=\"og:locale\" content=\"en_US\">
<meta property=\"og:url\" content=\"{canonical}\">
<meta name=\"twitter:card\" content=\"summary_large_image\">
<meta name=\"twitter:site\" content=\"@frogtalk\">
<meta name=\"twitter:title\" content=\"{_og_escape(title)}\">
<meta name=\"twitter:description\" content=\"{_og_escape(desc)}\">
<meta name=\"twitter:image\" content=\"{og_image}\">
<meta name=\"twitter:image:alt\" content=\"FrogTalk channel #{_og_escape(room_name)}\">
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


@app.get("/p/{post_id}", response_class=HTMLResponse)
async def serve_post_landing(post_id: int):
    """Public post share page with OG card metadata.

    Public posts are visible to logged-out users; non-public posts return a
    generic not-found style page so privacy is not leaked.
    """
    import database as db
    post = db.get_wall_post(post_id)
    if (not post
            or (post.get("privacy") or "public") != "public"
            or int(post.get("share_enabled", 1) or 0) != 1):
        html = (
            "<!DOCTYPE html><html><head><title>Post not found — FrogTalk</title>"
            "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
            "<meta name=theme-color content=\"#4caf50\">"
            "<link rel=icon href=\"/static/favicon.ico\">"
            "<style>*{box-sizing:border-box}html,body{height:100%}"
            "body{margin:0;color:#dff5e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
            "background:radial-gradient(70% 45% at 50% 0%,rgba(127,210,167,.12),transparent 72%),"
            "radial-gradient(60% 40% at 50% 100%,rgba(46,138,74,.10),transparent 75%),"
            "linear-gradient(135deg,#0d0d0d,#0d1611);"
            "display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}"
            ".card{position:relative;background:linear-gradient(180deg,#173027 0%,#13271f 56%,#0f1f17 100%);"
            "border:1px solid #3b6c59;border-radius:18px;padding:36px 32px;width:100%;max-width:430px;text-align:center;"
            "box-shadow:0 24px 64px rgba(0,0,0,.55),0 0 0 1px rgba(127,210,167,.06),inset 0 1px 0 rgba(255,255,255,.04)}"
            ".card::after{content:\"\";position:absolute;left:18px;right:18px;top:0;height:1px;"
            "background:linear-gradient(90deg,transparent,rgba(127,210,167,.5),transparent);pointer-events:none}"
            "h1{font-size:24px;font-weight:800;margin:0 0 10px;"
            "background:linear-gradient(180deg,#bff0d0,#7fd2a7 70%,#4caf50);"
            "-webkit-background-clip:text;background-clip:text;color:transparent}"
            "p{color:#bcd6c8;margin:0 0 18px;font-size:14px;line-height:1.45}"
            "a{display:inline-block;padding:11px 20px;border-radius:10px;text-decoration:none;font-weight:600;"
            "background:linear-gradient(180deg,#5cc163 0%,#4caf50 55%,#3e8c43 100%);color:#fff;border:1px solid #6cd870;"
            "text-shadow:0 1px 2px rgba(0,0,0,.25);box-shadow:0 6px 18px rgba(76,175,80,.35),inset 0 1px 0 rgba(255,255,255,.18)}"
            "a:hover{background:linear-gradient(180deg,#6cd870 0%,#56bd5a 55%,#479e4d 100%)}</style></head>"
            "<body><div class=card><h1>🐸 Post not found</h1>"
            "<p>This post is unavailable or not public.</p>"
            "<a href=\"/app\">Go to FrogTalk</a></div></body></html>"
        )
        return HTMLResponse(content=html, status_code=404, headers=_PUBLIC_HTML_NO_CACHE)

    nick = post.get("nickname") or "frog"
    display_name = (post.get("display_name") or "").strip()
    content = (post.get("content") or "").strip()
    desc = content.replace("\n", " ").strip()[:180] or f"A public post by @{nick} on FrogTalk."
    title_snippet = content.replace("\n", " ").strip()[:72]
    title = f"{title_snippet} - @{nick} on FrogTalk" if title_snippet else f"Post by @{nick} on FrogTalk"
    media_data = post.get("media_data") or ""
    media_type = (post.get("media_type") or "").lower()
    og_image = "https://frogtalk.xyz/static/icons/og-image.png"
    og_image_type = "image/png"
    if media_type.startswith("image/") and media_data.startswith(("http://", "https://")):
        og_image = media_data
        og_image_type = media_type
    elif media_type.startswith("image/") and media_data.startswith("data:image/"):
        og_image = f"https://frogtalk.xyz/og/post/{post_id}.img"
        og_image_type = media_type

    canonical = f"https://frogtalk.xyz/p/{post_id}"
    avatar = post.get("avatar") or ""
    avatar_html = (
        f"<img class=\"author-avatar\" src=\"{_og_escape(avatar)}\" alt=\"\">"
        if avatar.startswith(("http://", "https://", "data:image/", "/"))
        else "<div class=\"author-avatar author-fallback\">🐸</div>"
    )
    profile_href = f"/u/{url_quote(nick, safe='')}"
    if display_name:
        author_block = (
            f'<div><div class="author-name">{_og_escape(display_name)}</div>'
            f'<a class="author-handle" href="{profile_href}">@{_og_escape(nick)}</a></div>'
        )
    else:
        author_block = (
            f'<div><a class="author-name author-name-link" href="{profile_href}">@{_og_escape(nick)}</a></div>'
        )
    media_html = ""
    if media_type.startswith("image/") and media_data:
        media_html = f"<img class=\"post-media\" src=\"{_og_escape(media_data)}\" alt=\"Post media\">"
    elif media_type.startswith("video/") and media_data:
        media_html = f"<video class=\"post-media\" controls playsinline preload=\"metadata\" src=\"{_og_escape(media_data)}\"></video>"
    elif media_type.startswith("music/") and media_data:
        # Music share posts: embed the same provider-specific player the
        # social feed uses so guests can listen without leaving the page.
        # media_type is "music/<provider>", media_data is the track URL.
        import re as _re
        provider = media_type.split("/", 1)[1] if "/" in media_type else ""
        embed_url = ""
        thumb_url = ""
        if provider == "youtube":
            m = _re.search(r"(?:youtube\.com/(?:watch\?v=|shorts/|embed/|v/)|youtu\.be/)([A-Za-z0-9_-]{6,})", media_data)
            if not m:
                m = _re.search(r"[?&]v=([A-Za-z0-9_-]{6,})", media_data)
            if m:
                vid = m.group(1)
                embed_url = f"https://www.youtube-nocookie.com/embed/{vid}"
                thumb_url = f"https://img.youtube.com/vi/{vid}/hqdefault.jpg"
                # Upgrade OG image to the YouTube thumbnail so the
                # share preview shows the actual track artwork.
                og_image = thumb_url
                og_image_type = "image/jpeg"
        elif provider == "spotify":
            m = _re.search(r"open\.spotify\.com/(track|playlist|album|episode)/([A-Za-z0-9]+)", media_data)
            if m:
                embed_url = f"https://open.spotify.com/embed/{m.group(1)}/{m.group(2)}"
        elif provider == "soundcloud" and "soundcloud.com" in media_data:
            from urllib.parse import quote as _q
            embed_url = (
                "https://w.soundcloud.com/player/?url="
                + _q(media_data, safe="")
                + "&color=%234caf50&auto_play=false&hide_related=true&show_comments=false&show_user=true"
            )
        if embed_url:
            # Spotify embeds use 152px height for compact track player; SoundCloud
            # widget is 166px; YouTube needs a 16:9 wrapper. Frame everything
            # consistently inside the same green-bordered card so it matches
            # the rest of the surface.
            if provider == "youtube":
                media_html = (
                    f"<div class=\"music-embed music-embed-yt\">"
                    f"<iframe src=\"{_og_escape(embed_url)}\" allow=\"accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share\" allowfullscreen loading=\"lazy\" referrerpolicy=\"strict-origin-when-cross-origin\"></iframe>"
                    f"</div>"
                )
            elif provider == "spotify":
                media_html = (
                    f"<iframe class=\"music-embed music-embed-sp\" src=\"{_og_escape(embed_url)}\" "
                    f"allow=\"autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture\" "
                    f"loading=\"lazy\" referrerpolicy=\"strict-origin-when-cross-origin\"></iframe>"
                )
            else:  # soundcloud
                media_html = (
                    f"<iframe class=\"music-embed music-embed-sc\" src=\"{_og_escape(embed_url)}\" "
                    f"allow=\"autoplay\" loading=\"lazy\" "
                    f"referrerpolicy=\"strict-origin-when-cross-origin\"></iframe>"
                )
        else:
            # Unknown / unparseable music link — render a styled link card so
            # guests still see something tappable.
            media_html = (
                f"<a class=\"music-link-fallback\" href=\"{_og_escape(media_data)}\" "
                f"target=\"_blank\" rel=\"noopener noreferrer\">"
                f"<span class=\"music-icon\">\U0001F3B5</span>"
                f"<span class=\"music-link-text\">Open track</span>"
                f"</a>"
            )

    html = f"""<!DOCTYPE html>
<html><head>
<meta charset=\"utf-8\">
<title>{_og_escape(title)}</title>
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
<meta name=\"description\" content=\"{_og_escape(desc)}\">
<link rel=\"canonical\" href=\"{canonical}\">
<meta property=\"og:type\" content=\"article\">
<meta property=\"og:site_name\" content=\"FrogTalk\">
<meta property=\"og:title\" content=\"{_og_escape(title)}\">
<meta property=\"og:description\" content=\"{_og_escape(desc)}\">
<meta property=\"og:image\" content=\"{_og_escape(og_image)}\">
<meta property=\"og:image:secure_url\" content=\"{_og_escape(og_image)}\">
<meta property=\"og:image:type\" content=\"{_og_escape(og_image_type)}\">
<meta property=\"og:image:width\" content=\"1200\">
<meta property=\"og:image:height\" content=\"630\">
<meta property=\"og:image:alt\" content=\"Post by @{_og_escape(nick)} on FrogTalk\">
<meta property=\"og:locale\" content=\"en_US\">
<meta property=\"og:url\" content=\"{canonical}\">
<meta name=\"twitter:card\" content=\"summary_large_image\">
<meta name=\"twitter:site\" content=\"@frogtalk\">
<meta name=\"twitter:title\" content=\"{_og_escape(title)}\">
<meta name=\"twitter:description\" content=\"{_og_escape(desc)}\">
<meta name=\"twitter:image\" content=\"{_og_escape(og_image)}\">
<meta name=\"twitter:image:alt\" content=\"Post by @{_og_escape(nick)} on FrogTalk\">
<meta name=\"theme-color\" content=\"#4caf50\">
<style>
*{{box-sizing:border-box}}
html,body{{height:100%}}
body{{margin:0;color:#dff5e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  background:
    radial-gradient(70% 45% at 50% 0%, rgba(127,210,167,.12), transparent 72%),
    radial-gradient(60% 40% at 50% 100%, rgba(46,138,74,.10), transparent 75%),
    linear-gradient(135deg,#0d0d0d,#0d1611);
  display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:32px 20px}}
.card{{position:relative;background:linear-gradient(180deg,#173027 0%,#13271f 56%,#0f1f17 100%);
  border:1px solid #3b6c59;border-radius:20px;padding:22px;max-width:540px;width:100%;
  box-shadow:0 24px 64px rgba(0,0,0,.55),0 0 0 1px rgba(127,210,167,.06),inset 0 1px 0 rgba(255,255,255,.04)}}
.card::after{{content:"";position:absolute;left:18px;right:18px;top:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(127,210,167,.5),transparent);pointer-events:none}}
.author{{display:flex;align-items:center;gap:10px;margin-bottom:14px}}
.author-avatar{{width:44px;height:44px;border-radius:50%;object-fit:cover;
  border:2px solid rgba(127,210,167,.55);background:#0f1f17;
  box-shadow:0 4px 12px rgba(0,0,0,.4)}}
.author-fallback{{display:flex;align-items:center;justify-content:center;font-size:22px;color:#bff0d0}}
.author-name{{font-weight:700;letter-spacing:-.01em;
  background:linear-gradient(180deg,#bff0d0,#7fd2a7 70%,#4caf50);
  -webkit-background-clip:text;background-clip:text;color:transparent}}
.author-name-link{{text-decoration:none;color:inherit;display:inline-block}}
.author-handle{{display:inline-block;margin-top:2px;color:#cfeadb;font-size:13px;text-decoration:none}}
.caption{{white-space:pre-wrap;line-height:1.5;color:#dff5e8;margin-bottom:14px;word-wrap:break-word;font-size:15px}}
.post-media{{width:100%;max-height:70vh;object-fit:contain;border-radius:14px;
  border:1px solid rgba(127,210,167,.18);background:#0a1410;
  box-shadow:0 10px 32px rgba(0,0,0,.45)}}
/* Music share embeds — match the post-media frame so YouTube/Spotify/
   SoundCloud all sit in the same green-rimmed card. */
.music-embed{{display:block;width:100%;border:1px solid rgba(127,210,167,.18);
  border-radius:14px;background:#0a1410;box-shadow:0 10px 32px rgba(0,0,0,.45);overflow:hidden}}
.music-embed-yt{{position:relative;padding-top:56.25%;height:0}}
.music-embed-yt iframe{{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}}
.music-embed-sp{{height:152px}}
.music-embed-sc{{height:166px}}
.music-link-fallback{{display:flex;align-items:center;gap:10px;padding:14px 16px;
  background:linear-gradient(135deg,rgba(127,210,167,.08),rgba(46,138,74,.04));
  border:1px solid rgba(127,210,167,.25);border-radius:14px;color:#dff5e8;
  text-decoration:none;font-weight:600;transition:background .15s ease,border-color .15s ease}}
.music-link-fallback:hover{{background:linear-gradient(135deg,rgba(127,210,167,.14),rgba(46,138,74,.08));
  border-color:rgba(127,210,167,.4)}}
.music-icon{{font-size:22px;line-height:1;filter:drop-shadow(0 2px 6px rgba(76,175,80,.4))}}
.guest-banner{{display:flex;align-items:center;gap:10px;
  background:linear-gradient(135deg,rgba(127,210,167,.12),rgba(46,138,74,.06));
  border:1px solid rgba(127,210,167,.3);color:#cfeadb;
  padding:10px 14px;border-radius:12px;font-size:13px;line-height:1.4;margin-bottom:14px}}
.guest-banner .gb-dot{{width:8px;height:8px;border-radius:50%;flex-shrink:0;
  background:radial-gradient(circle at 30% 30%,#bff0d0,#4caf50);
  box-shadow:0 0 0 2px rgba(127,210,167,.18),0 0 12px rgba(76,175,80,.4)}}
.guest-banner b{{color:#dff5e8;font-weight:700}}
.guest-banner .gb-link{{color:#bff0d0;font-weight:700;text-decoration:none;
  text-shadow:0 0 0 rgba(127,210,167,0);
  transition:color .2s ease,text-shadow .25s ease,filter .25s ease}}
.guest-banner .gb-link:hover{{color:#fff;
  text-shadow:0 0 8px rgba(127,210,167,.85),0 0 18px rgba(76,175,80,.55);
  filter:drop-shadow(0 0 6px rgba(76,175,80,.4))}}
.actions{{display:flex;gap:10px;margin-top:18px}}
.btn{{display:block;flex:1;text-align:center;padding:13px 16px;border-radius:10px;
  text-decoration:none;font-weight:600;font-size:15px;border:1px solid transparent;
  transition:transform .08s ease, box-shadow .15s ease, background .15s ease}}
.btn-primary{{background:linear-gradient(180deg,#5cc163 0%,#4caf50 55%,#3e8c43 100%);
  border-color:#6cd870;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.25);
  box-shadow:0 6px 18px rgba(76,175,80,.35),inset 0 1px 0 rgba(255,255,255,.18)}}
.btn-primary:hover{{background:linear-gradient(180deg,#6cd870 0%,#56bd5a 55%,#479e4d 100%);
  box-shadow:0 8px 22px rgba(76,175,80,.45),inset 0 1px 0 rgba(255,255,255,.22);transform:translateY(-1px)}}
.btn-secondary{{background:rgba(127,210,167,.06);border-color:rgba(127,210,167,.25);color:#dff5e8}}
.btn-secondary:hover{{background:rgba(127,210,167,.12);border-color:rgba(127,210,167,.4)}}
</style></head><body>
<div class=\"card\">
  <div class=\"guest-banner\"><span class=\"gb-dot\"></span><span>Viewing as guest \u2014 <a class=\"gb-link\" href=\"/app?register=1&amp;post={post_id}\">join FrogTalk</a> to like, comment and reply.</span></div>
    <div class=\"author\">{avatar_html}{author_block}</div>
  {f'<div class="caption">{_og_escape(content)}</div>' if content else ''}
  {media_html}
  <div class=\"actions\">
    <a href=\"/app?post={post_id}\" class=\"btn btn-primary\">Open in FrogTalk</a>
    <a href=\"/\" class=\"btn btn-secondary\">Home</a>
  </div>
</div>
<script>
try {{
    if (localStorage.getItem('token') || localStorage.getItem('fc_token')) {{
    window.location.replace('/app?post={post_id}');
  }}
}} catch (e) {{}}
</script>
</body></html>"""
    return HTMLResponse(content=html, headers=_PUBLIC_HTML_NO_CACHE)


@app.get("/r/{post_id}/media")
async def serve_public_reel_media(post_id: int):
    """Public media endpoint for share-enabled public reels."""
    import base64
    import database as db

    post = db.get_wall_post(post_id)
    if (not post
            or (post.get("privacy") or "public") != "public"
            or int(post.get("share_enabled", 1) or 0) != 1
            or not str(post.get("media_type") or "").lower().startswith("video/")):
        return _JSONResponse(status_code=404, content={"error": "Not found"})

    media_data = str(post.get("media_data") or "").strip()
    media_type = str(post.get("media_type") or "application/octet-stream")
    if not media_data:
        return _JSONResponse(status_code=404, content={"error": "Not found"})

    if media_data.startswith("data:"):
        try:
            header, _, b64 = media_data.partition(",")
            if ";base64" not in header:
                return _JSONResponse(status_code=404, content={"error": "Not found"})
            raw = base64.b64decode(b64, validate=False)
            ct = header[5:].split(";", 1)[0] or media_type
            return Response(
                content=raw,
                media_type=ct,
                headers={
                    "Cache-Control": "public, max-age=86400, immutable",
                    "Content-Length": str(len(raw)),
                    "X-Content-Type-Options": "nosniff",
                },
            )
        except Exception:
            return _JSONResponse(status_code=500, content={"error": "Decode failed"})

    if media_data.startswith("/"):
        safe_target = media_data
    else:
        parsed = urlparse(media_data)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return _JSONResponse(status_code=404, content={"error": "Not found"})
        safe_target = media_data

    return Response(
        status_code=302,
        headers={
            "Location": safe_target,
            "Cache-Control": "public, max-age=3600",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/r/{post_id}", response_class=HTMLResponse)
async def serve_reel_landing(post_id: int):
    """Public reel share page. Guests can watch; logged-in users open in-app."""
    import database as db

    post = db.get_wall_post(post_id)
    if (not post
            or (post.get("privacy") or "public") != "public"
            or int(post.get("share_enabled", 1) or 0) != 1
            or not str(post.get("media_type") or "").lower().startswith("video/")):
        html = (
            "<!DOCTYPE html><html><head><title>Reel not found — FrogTalk</title>"
            "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
            "<meta name=theme-color content=\"#4caf50\">"
            "<link rel=icon href=\"/static/favicon.ico\">"
            "<style>*{box-sizing:border-box}html,body{height:100%}"
            "body{margin:0;color:#dff5e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
            "background:radial-gradient(70% 45% at 50% 0%,rgba(127,210,167,.12),transparent 72%),"
            "radial-gradient(60% 40% at 50% 100%,rgba(46,138,74,.10),transparent 75%),"
            "linear-gradient(135deg,#0d0d0d,#0d1611);"
            "display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}"
            ".card{position:relative;background:linear-gradient(180deg,#173027 0%,#13271f 56%,#0f1f17 100%);"
            "border:1px solid #3b6c59;border-radius:18px;padding:36px 32px;width:100%;max-width:430px;text-align:center;"
            "box-shadow:0 24px 64px rgba(0,0,0,.55),0 0 0 1px rgba(127,210,167,.06),inset 0 1px 0 rgba(255,255,255,.04)}"
            ".card::after{content:\"\";position:absolute;left:18px;right:18px;top:0;height:1px;"
            "background:linear-gradient(90deg,transparent,rgba(127,210,167,.5),transparent);pointer-events:none}"
            "h1{font-size:24px;font-weight:800;margin:0 0 10px;"
            "background:linear-gradient(180deg,#bff0d0,#7fd2a7 70%,#4caf50);"
            "-webkit-background-clip:text;background-clip:text;color:transparent}"
            "p{color:#bcd6c8;margin:0 0 18px;font-size:14px;line-height:1.45}"
            "a{display:inline-block;padding:11px 20px;border-radius:10px;text-decoration:none;font-weight:600;"
            "background:linear-gradient(180deg,#5cc163 0%,#4caf50 55%,#3e8c43 100%);color:#fff;border:1px solid #6cd870;"
            "text-shadow:0 1px 2px rgba(0,0,0,.25);box-shadow:0 6px 18px rgba(76,175,80,.35),inset 0 1px 0 rgba(255,255,255,.18)}"
            "a:hover{background:linear-gradient(180deg,#6cd870 0%,#56bd5a 55%,#479e4d 100%)}</style></head>"
            "<body><div class=card><h1>🐸 Reel not found</h1>"
            "<p>This reel is unavailable or not public.</p>"
            "<a href=\"/app\">Go to FrogTalk</a></div></body></html>"
        )
        return HTMLResponse(content=html, status_code=404, headers=_PUBLIC_HTML_NO_CACHE)

    nick = post.get("nickname") or "frog"
    display_name = (post.get("display_name") or "").strip()
    content = (post.get("content") or "").strip()
    desc = content.replace("\n", " ").strip()[:180] or f"A public reel by @{nick} on FrogTalk."
    title_snippet = content.replace("\n", " ").strip()[:72]
    title = f"{title_snippet} - @{nick} on FrogTalk" if title_snippet else f"Reel by @{nick} on FrogTalk"
    canonical = f"https://frogtalk.xyz/r/{post_id}"
    media_url = f"https://frogtalk.xyz/r/{post_id}/media"
    avatar = post.get("avatar") or ""
    avatar_html = (
        f"<img class=\"author-avatar\" src=\"{_og_escape(avatar)}\" alt=\"\">"
        if avatar.startswith(("http://", "https://", "data:image/", "/"))
        else "<div class=\"author-avatar author-fallback\">🐸</div>"
    )
    profile_href = f"/u/{url_quote(nick, safe='')}"
    if display_name:
        author_block = (
            f'<div><div class="author-name">{_og_escape(display_name)}</div>'
            f'<a class="author-handle" href="{profile_href}">@{_og_escape(nick)}</a></div>'
        )
    else:
        author_block = (
            f'<div><a class="author-name author-name-link" href="{profile_href}">@{_og_escape(nick)}</a></div>'
        )

    html = f"""<!DOCTYPE html>
<html><head>
<meta charset=\"utf-8\">
<title>{_og_escape(title)}</title>
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
<meta name=\"description\" content=\"{_og_escape(desc)}\">
<link rel=\"canonical\" href=\"{canonical}\">
<meta property=\"og:type\" content=\"video.other\">
<meta property=\"og:site_name\" content=\"FrogTalk\">
<meta property=\"og:title\" content=\"{_og_escape(title)}\">
<meta property=\"og:description\" content=\"{_og_escape(desc)}\">
<meta property=\"og:image\" content=\"https://frogtalk.xyz/static/icons/og-image.png\">
<meta property=\"og:image:secure_url\" content=\"https://frogtalk.xyz/static/icons/og-image.png\">
<meta property=\"og:image:type\" content=\"image/png\">
<meta property=\"og:image:width\" content=\"1200\">
<meta property=\"og:image:height\" content=\"630\">
<meta property=\"og:image:alt\" content=\"Reel by @{_og_escape(nick)} on FrogTalk\">
<meta property=\"og:video\" content=\"{_og_escape(media_url)}\">
<meta property=\"og:video:secure_url\" content=\"{_og_escape(media_url)}\">
<meta property=\"og:video:type\" content=\"{_og_escape(str(post.get('media_type') or 'video/mp4'))}\">
<meta property=\"og:locale\" content=\"en_US\">
<meta property=\"og:url\" content=\"{canonical}\">
<meta name=\"twitter:card\" content=\"summary_large_image\">
<meta name=\"twitter:site\" content=\"@frogtalk\">
<meta name=\"twitter:title\" content=\"{_og_escape(title)}\">
<meta name=\"twitter:description\" content=\"{_og_escape(desc)}\">
<meta name=\"twitter:image\" content=\"https://frogtalk.xyz/static/icons/og-image.png\">
<meta name=\"twitter:image:alt\" content=\"Reel by @{_og_escape(nick)} on FrogTalk\">
<meta name=\"theme-color\" content=\"#4caf50\">
<style>
*{{box-sizing:border-box}}
html,body{{height:100%}}
body{{margin:0;color:#dff5e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  background:
    radial-gradient(70% 45% at 50% 0%, rgba(127,210,167,.12), transparent 72%),
    radial-gradient(60% 40% at 50% 100%, rgba(46,138,74,.10), transparent 75%),
    linear-gradient(135deg,#0d0d0d,#0d1611);
  display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:32px 20px}}
.card{{position:relative;background:linear-gradient(180deg,#173027 0%,#13271f 56%,#0f1f17 100%);
  border:1px solid #3b6c59;border-radius:20px;padding:20px;max-width:540px;width:100%;
  box-shadow:0 24px 64px rgba(0,0,0,.55),0 0 0 1px rgba(127,210,167,.06),inset 0 1px 0 rgba(255,255,255,.04)}}
.card::after{{content:"";position:absolute;left:18px;right:18px;top:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(127,210,167,.5),transparent);pointer-events:none}}
.guest-banner{{display:flex;align-items:center;gap:10px;
  background:linear-gradient(135deg,rgba(127,210,167,.12),rgba(46,138,74,.06));
  border:1px solid rgba(127,210,167,.3);color:#cfeadb;
  padding:10px 14px;border-radius:12px;font-size:13px;line-height:1.4;margin-bottom:14px}}
.guest-banner .gb-dot{{width:8px;height:8px;border-radius:50%;flex-shrink:0;
  background:radial-gradient(circle at 30% 30%,#bff0d0,#4caf50);
  box-shadow:0 0 0 2px rgba(127,210,167,.18),0 0 12px rgba(76,175,80,.4)}}
.guest-banner b{{color:#dff5e8;font-weight:700}}
.guest-banner .gb-link{{color:#bff0d0;font-weight:700;text-decoration:none;
  text-shadow:0 0 0 rgba(127,210,167,0);
  transition:color .2s ease,text-shadow .25s ease,filter .25s ease}}
.guest-banner .gb-link:hover{{color:#fff;
  text-shadow:0 0 8px rgba(127,210,167,.85),0 0 18px rgba(76,175,80,.55);
  filter:drop-shadow(0 0 6px rgba(76,175,80,.4))}}
.author{{display:flex;align-items:center;gap:10px;margin-bottom:12px}}
.author-avatar{{width:42px;height:42px;border-radius:50%;object-fit:cover;
  border:2px solid rgba(127,210,167,.55);background:#0f1f17;
  box-shadow:0 4px 12px rgba(0,0,0,.4)}}
.author-fallback{{display:flex;align-items:center;justify-content:center;font-size:20px;color:#bff0d0}}
.author-name{{font-weight:700;letter-spacing:-.01em;
  background:linear-gradient(180deg,#bff0d0,#7fd2a7 70%,#4caf50);
  -webkit-background-clip:text;background-clip:text;color:transparent}}
.author-name-link{{text-decoration:none;color:inherit;display:inline-block}}
.author-handle{{display:inline-block;margin-top:2px;color:#cfeadb;font-size:13px;text-decoration:none}}
.caption{{white-space:pre-wrap;line-height:1.5;color:#dff5e8;margin-bottom:12px;word-wrap:break-word;font-size:15px}}
.reel-video{{width:100%;max-height:76vh;object-fit:contain;border-radius:14px;
  border:1px solid rgba(127,210,167,.18);background:#0a1410;
  box-shadow:0 10px 32px rgba(0,0,0,.45)}}
.actions{{display:flex;gap:10px;margin-top:16px}}
.btn{{display:block;flex:1;text-align:center;padding:13px 16px;border-radius:10px;
  text-decoration:none;font-weight:600;font-size:15px;border:1px solid transparent;
  transition:transform .08s ease, box-shadow .15s ease, background .15s ease}}
.btn-primary{{background:linear-gradient(180deg,#5cc163 0%,#4caf50 55%,#3e8c43 100%);
  border-color:#6cd870;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.25);
  box-shadow:0 6px 18px rgba(76,175,80,.35),inset 0 1px 0 rgba(255,255,255,.18)}}
.btn-primary:hover{{background:linear-gradient(180deg,#6cd870 0%,#56bd5a 55%,#479e4d 100%);
  box-shadow:0 8px 22px rgba(76,175,80,.45),inset 0 1px 0 rgba(255,255,255,.22);transform:translateY(-1px)}}
.btn-secondary{{background:rgba(127,210,167,.06);border-color:rgba(127,210,167,.25);color:#dff5e8}}
.btn-secondary:hover{{background:rgba(127,210,167,.12);border-color:rgba(127,210,167,.4)}}
</style></head><body>
<div class=\"card\">
  <div class=\"guest-banner\"><span class=\"gb-dot\"></span><span>Watching as guest \u2014 <a class=\"gb-link\" href=\"/app?register=1&amp;reel={post_id}\">join FrogTalk</a> to like, comment, repost and chat with friends.</span></div>
    <div class=\"author\">{avatar_html}{author_block}</div>
  {f'<div class="caption">{_og_escape(content)}</div>' if content else ''}
  <video class=\"reel-video\" controls playsinline preload=\"metadata\" src=\"/r/{post_id}/media\"></video>
  <div class=\"actions\">
    <a href=\"/?reel={post_id}\" class=\"btn btn-primary\">Join FrogTalk</a>
    <a href=\"/\" class=\"btn btn-secondary\">Home</a>
  </div>
</div>
<script>
try {{
  if (localStorage.getItem('token') || localStorage.getItem('fc_token')) {{
        window.location.replace('/app?reel={post_id}');
  }}
}} catch (e) {{}}
</script>
</body></html>"""
    return HTMLResponse(content=html, headers=_PUBLIC_HTML_NO_CACHE)


@app.get("/api/ping")
async def api_ping():
    """Lightweight health probe used by the client connection-lost overlay."""
    from fastapi.responses import JSONResponse
    return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})


# ── Public share-info JSON endpoints ─────────────────────────────────────
# Used by chat (DMs/channels) to render rich link cards for FrogTalk share
# URLs without requiring follow/friend privacy checks. Only return data
# for public + share_enabled posts/profiles. Heavily cacheable.

def _public_share_post_payload(post: dict, kind: str) -> dict:
    """Build a public-safe JSON payload for a share-enabled public post.

    Strips sensitive fields (full media data, private flags). Includes a
    public media URL when applicable so chat clients can play video inline.
    """
    pid = int(post.get("id") or 0)
    media_type = str(post.get("media_type") or "").lower()
    has_media = bool(post.get("media_data"))
    media_url = None
    if has_media:
        if media_type.startswith("video/"):
            media_url = f"/r/{pid}/media"
        elif media_type.startswith("image/"):
            # Reuse the OG proxy as a public image fetch (already public).
            media_url = f"/og/post/{pid}.img"
        elif media_type.startswith("music/"):
            # Music posts store the (already-public) provider URL directly
            # in media_data (validated to be http/https in routers/wall.py).
            # Surface it so chat can build an inline mini player without
            # an authed wall lookup.
            md = str(post.get("media_data") or "").strip()
            if md.startswith(("http://", "https://")):
                media_url = md
    return {
        "id": pid,
        "kind": kind,  # "post" or "reel"
        "nickname": post.get("nickname") or "frog",
        "display_name": post.get("display_name") or None,
        "avatar": post.get("avatar") or None,
        "content": (post.get("content") or "")[:280],
        "media_type": media_type or None,
        "has_media": has_media,
        "media_url": media_url,
        "created_at": post.get("created_at"),
    }


@app.get("/api/share/post/{post_id}")
async def share_post_info(post_id: int):
    """Public JSON for a share-enabled public post. 404 otherwise."""
    from fastapi.responses import JSONResponse
    import database as db
    post = db.get_wall_post(post_id)
    if (not post
            or (post.get("privacy") or "public") != "public"
            or int(post.get("share_enabled", 1) or 0) != 1):
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return JSONResponse(
        _public_share_post_payload(post, "post"),
        headers={"Cache-Control": "public, max-age=120"},
    )


@app.get("/api/share/reel/{post_id}")
async def share_reel_info(post_id: int):
    """Public JSON for a share-enabled public reel. 404 if not a public video."""
    from fastapi.responses import JSONResponse
    import database as db
    post = db.get_wall_post(post_id)
    if (not post
            or (post.get("privacy") or "public") != "public"
            or int(post.get("share_enabled", 1) or 0) != 1
            or not str(post.get("media_type") or "").lower().startswith("video/")):
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return JSONResponse(
        _public_share_post_payload(post, "reel"),
        headers={"Cache-Control": "public, max-age=120"},
    )


@app.get("/api/share/profile/{nickname}")
async def share_profile_info(nickname: str):
    """Public JSON for a profile that opted into a public profile page."""
    from fastapi.responses import JSONResponse
    import database as db
    user = db.get_user_profile(nickname)
    if not user or not bool(user.get("profile_public", 1)):
        return JSONResponse(status_code=404, content={"error": "Not found"})
    avatar = user.get("avatar") or None
    # Strip private fields; only expose what the OG/share page already shows.
    return JSONResponse(
        {
            "nickname": user.get("nickname") or nickname,
            "display_name": user.get("display_name") or None,
            "avatar": avatar,
            "bio": (user.get("bio") or "")[:200],
            "status_msg": (user.get("status_msg") or "")[:120],
        },
        headers={"Cache-Control": "public, max-age=120"},
    )


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


@app.get("/og/post/{post_id}.img")
async def og_post_image(post_id: int):
    """Binary proxy for a public post image for OG previews."""
    from fastapi.responses import Response
    import database as db
    post = db.get_wall_post(post_id)
    if (not post
            or (post.get("privacy") or "public") != "public"
            or int(post.get("share_enabled", 1) or 0) != 1):
        return _fallback_og_image()
    if not (post.get("media_type") or "").startswith("image/"):
        return _fallback_og_image()
    md = post.get("media_data") or ""
    if md.startswith(("http://", "https://")):
        return Response(status_code=302, headers={"Location": md})
    raw, mime = _decode_data_url_to_bytes(md)
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


# ── SEO: robots.txt + sitemap ─────────────────────────────────────────────────
from datetime import datetime as _sitemap_dt
from xml.sax.saxutils import escape as _xml_escape

SITE_URL = os.getenv("FROGTALK_SITE_URL", "https://frogtalk.xyz").rstrip("/")


@app.get("/robots.txt", include_in_schema=False)
async def serve_robots(request: Request):
    # Tor / onion mode: refuse all indexing so the hidden service URL
    # doesn't end up cross-correlated with the clearnet host on
    # Google/Bing/etc. We treat any of the following as "this request
    # came in over a hidden service":
    #   - FROGTALK_TOR_MODE=1 in env (operator opted the whole node in)
    #   - the Host header is a .onion address
    #   - the X-Forwarded-Host header is a .onion address (nginx proxy)
    host_hdr = (request.headers.get("host") or "").lower()
    fwd_host = (request.headers.get("x-forwarded-host") or "").lower()
    is_onion = host_hdr.endswith(".onion") or fwd_host.endswith(".onion")
    is_tor_node = (
        os.getenv("FROGTALK_TOR_MODE", "").strip().lower() in ("1", "true", "yes", "on")
        or os.getenv("FROGTALK_TOR_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
    )
    if is_onion or is_tor_node:
        from fastapi.responses import Response
        body = (
            "# Tor hidden service — no crawl, no archive.\n"
            "User-agent: *\n"
            "Disallow: /\n"
            "Noindex: /\n"
        )
        return Response(
            content=body,
            media_type="text/plain; charset=utf-8",
            headers={"X-Robots-Tag": "noindex, nofollow, noarchive"},
        )
    # Default crawl policy: index public marketing/docs/profile/room pages,
    # but keep API, app shell, OG images and invite landings out of search.
    default_block = (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /api/\n"
        "Disallow: /app$\n"
        "Disallow: /app/\n"
        "Disallow: /og/\n"
        "Disallow: /invite/\n"
    )
    # Explicitly opt-in to AI / LLM crawlers so FrogTalk shows up in
    # ChatGPT, Claude, Perplexity, Gemini, Apple Intelligence, Common Crawl,
    # etc. Each gets its own block (the spec is per-user-agent).
    ai_bots = [
        "GPTBot",            # OpenAI / ChatGPT training
        "OAI-SearchBot",     # ChatGPT Search
        "ChatGPT-User",      # ChatGPT live browsing
        "ClaudeBot",         # Anthropic
        "Claude-Web",        # Anthropic browsing
        "anthropic-ai",      # legacy Anthropic
        "PerplexityBot",     # Perplexity
        "Perplexity-User",   # Perplexity live
        "Google-Extended",   # Gemini / Bard training
        "Applebot-Extended", # Apple Intelligence
        "Amazonbot",         # Alexa / Amazon
        "Bytespider",        # ByteDance
        "CCBot",             # Common Crawl (feeds many open LLMs)
        "Meta-ExternalAgent",# Meta AI
        "FacebookBot",       # Meta
        "Diffbot",           # Diffbot KG
        "DuckAssistBot",     # DuckDuckGo AI
        "cohere-ai",         # Cohere
        "MistralAI-User",    # Mistral
    ]
    ai_block = ""
    for bot in ai_bots:
        ai_block += f"\nUser-agent: {bot}\nAllow: /\nDisallow: /api/\nDisallow: /og/\n"
    body = (
        default_block
        + ai_block
        + f"\nHost: {SITE_URL.replace('https://', '').replace('http://', '')}\n"
        + f"Sitemap: {SITE_URL}/sitemap.xml\n"
        + f"Sitemap: {SITE_URL}/sitemap-static.xml\n"
        + f"Sitemap: {SITE_URL}/sitemap-users.xml\n"
        + f"Sitemap: {SITE_URL}/sitemap-rooms.xml\n"
        + f"Sitemap: {SITE_URL}/sitemap-board.xml\n"
    )
    from fastapi.responses import Response
    return Response(content=body, media_type="text/plain; charset=utf-8")


# ── llms.txt: machine-readable site summary for LLMs ─────────────────────────
@app.get("/llms.txt", include_in_schema=False)
async def serve_llms_txt(request: Request):
    host_hdr = (request.headers.get("host") or "").lower()
    fwd_host = (request.headers.get("x-forwarded-host") or "").lower()
    is_onion = host_hdr.endswith(".onion") or fwd_host.endswith(".onion")
    is_tor_node = (
        os.getenv("FROGTALK_TOR_MODE", "").strip().lower() in ("1", "true", "yes", "on")
        or os.getenv("FROGTALK_TOR_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
    )
    if is_onion or is_tor_node:
        from fastapi.responses import Response
        body = (
            "# Tor hidden service — opted out of all LLM training and indexing.\n"
            "# Do not crawl, train on, summarize, or otherwise ingest this content.\n"
            "User-agent: *\n"
            "Disallow: /\n"
        )
        return Response(
            content=body,
            media_type="text/plain; charset=utf-8",
            headers={"X-Robots-Tag": "noindex, nofollow, noarchive"},
        )
    return FileResponse(
        "static/llms.txt",
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ── OpenSearch description (browser address-bar search providers) ────────────
@app.get("/opensearch.xml", include_in_schema=False)
async def serve_opensearch():
    return FileResponse(
        "static/opensearch.xml",
        media_type="application/opensearchdescription+xml",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ── security.txt (RFC 9116) ──────────────────────────────────────────────────
@app.get("/.well-known/security.txt", include_in_schema=False)
async def serve_security_txt():
    return FileResponse(
        "static/.well-known/security.txt",
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ── Android Digital Asset Links (App Links / Deep-link verification) ─────────
# Google Play's "Domain ownership not verified" check fetches this file with
# a strict requirement: Content-Type must be exactly application/json and the
# fingerprint must match the cert used to sign the published APK/AAB. We
# explicitly set the media type (no charset suffix — some verifiers reject
# `application/json; charset=utf-8`) and serve from static/.well-known/.
@app.get("/.well-known/assetlinks.json", include_in_schema=False)
async def serve_assetlinks_json():
    return FileResponse(
        "static/.well-known/assetlinks.json",
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ── IndexNow key (Bing / Yandex / Seznam / Naver instant indexing) ───────────
# Generate once with `python -c "import secrets;print(secrets.token_hex(16))"`
# and set FROGTALK_INDEXNOW_KEY in the environment. The file at
# /<key>.txt must contain the key as its only content for ownership proof.
INDEXNOW_KEY = os.getenv("FROGTALK_INDEXNOW_KEY", "").strip()

if INDEXNOW_KEY and all(c in "0123456789abcdefABCDEF" for c in INDEXNOW_KEY):
    @app.get("/" + INDEXNOW_KEY + ".txt", include_in_schema=False)
    async def serve_indexnow_key():
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse(INDEXNOW_KEY, media_type="text/plain; charset=utf-8")


def _sitemap_url(loc: str, lastmod: str = "", changefreq: str = "weekly", priority: str = "0.5") -> str:
    parts = [f"<url><loc>{loc}</loc>"]
    if lastmod:
        parts.append(f"<lastmod>{lastmod}</lastmod>")
    parts.append(f"<changefreq>{changefreq}</changefreq>")
    parts.append(f"<priority>{priority}</priority></url>")
    return "".join(parts)


# Path to the imageboard's threads.json; configurable via env so dev/prod can differ
BOARD_DATA_PATH = os.getenv(
    "FROGTALK_BOARD_DATA_PATH",
    "/opt/frogtalk/board/board_data/threads.json",
)


def _board_thread_urls(today: str) -> str:
    """Return sitemap <url> blocks for all non-hidden board threads."""
    import json as _json
    try:
        with open(BOARD_DATA_PATH, "r", encoding="utf-8") as _f:
            threads = _json.load(_f)
    except Exception as e:
        _log.warning("sitemap-board could not read threads.json: %s", e)
        return ""
    out = []
    for t in threads:
        tid = t.get("id")
        if not tid or t.get("hidden"):
            continue
        out.append(_sitemap_url(f"{SITE_URL}/board?thread={_xml_escape(str(tid))}", today, "daily", "0.7"))
    return "".join(out)


@app.get("/sitemap.xml", include_in_schema=False)
async def serve_sitemap_index():
    """Combined flat sitemap (static pages + user profiles + rooms)."""
    from fastapi.responses import Response
    import database as db
    today = _sitemap_dt.utcnow().strftime("%Y-%m-%d")

    # Static pages
    pages = [
        ("/",             "daily",   "1.0"),
        ("/docs/api",     "monthly", "0.6"),
        ("/docs/node",    "monthly", "0.6"),
        ("/privacy",      "yearly",  "0.4"),
        ("/ios", "weekly", "0.7"),
        ("/download/android", "weekly", "0.7"),
        ("/download/linux", "weekly", "0.7"),
        ("/download/deb", "weekly", "0.7"),
        ("/download/windows", "weekly", "0.7"),
        ("/download/windows-zip", "weekly", "0.7"),
        ("/board", "hourly", "0.8"),
    ]
    urls = "".join(_sitemap_url(SITE_URL + p, today, cf, pr) for p, cf, pr in pages)

    # Board threads
    urls += _board_thread_urls(today)

    # User profiles
    try:
        with db._conn() as con:
            user_rows = con.execute(
                "SELECT nickname FROM users "
                "WHERE COALESCE(profile_public,1)=1 "
                "AND LENGTH(nickname) >= 2 "
                "AND nickname NOT IN ('federation_sync','admin') "
                "AND nickname NOT LIKE '%1777%' "
                "ORDER BY id DESC LIMIT 5000"
            ).fetchall()
        urls += "".join(
            _sitemap_url(f"{SITE_URL}/u/{_xml_escape(r['nickname'])}", today, "weekly", "0.6")
            for r in user_rows if r["nickname"]
        )
    except Exception as e:
        _log.warning("sitemap users query error: %s", e)

    # Public rooms
    try:
        with db._conn() as con:
            room_rows = con.execute(
                "SELECT name FROM rooms "
                "WHERE COALESCE(type,'public')='public' "
                "AND name NOT LIKE 'phase2-%' "
                "AND name NOT LIKE '%sync%' "
                "AND name NOT LIKE '%1777%' "
                "AND LENGTH(name) >= 2 "
                "ORDER BY id DESC LIMIT 5000"
            ).fetchall()
        urls += "".join(
            _sitemap_url(f"{SITE_URL}/c/{_xml_escape(r['name'])}", today, "weekly", "0.6")
            for r in room_rows if r["name"]
        )
    except Exception as e:
        _log.warning("sitemap rooms query error: %s", e)

    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + urls + '</urlset>'
    )
    return Response(content=body, media_type="application/xml; charset=utf-8")


@app.get("/sitemap-static.xml", include_in_schema=False)
async def serve_sitemap_static():
    from fastapi.responses import Response
    today = _sitemap_dt.utcnow().strftime("%Y-%m-%d")
    pages = [
        ("/",             "daily",   "1.0"),
        ("/docs/api",     "monthly", "0.6"),
        ("/docs/node",    "monthly", "0.6"),
        ("/privacy",      "yearly",  "0.4"),
        ("/ios", "weekly", "0.7"),
        ("/download/android", "weekly", "0.7"),
        ("/download/linux", "weekly", "0.7"),
        ("/download/deb", "weekly", "0.7"),
        ("/download/windows", "weekly", "0.7"),
        ("/download/windows-zip", "weekly", "0.7"),
        ("/board", "hourly", "0.8"),
    ]
    urls = "".join(_sitemap_url(SITE_URL + p, today, cf, pr) for p, cf, pr in pages)
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + urls + '</urlset>'
    )
    return Response(content=body, media_type="application/xml; charset=utf-8")


@app.get("/sitemap-users.xml", include_in_schema=False)
async def serve_sitemap_users():
    """Public user profiles."""
    from fastapi.responses import Response
    import database as db
    rows = []
    # Exclude internal system/bridge accounts. All auto-generated accounts embed
    # the Unix-ms timestamp (starting with 1777...) in their username, so a single
    # LIKE filter covers sync*, probe*, soc*, autosw*, global*, p2*, music* variants.
    # Also exclude the two permanently reserved names.
    try:
        with db._conn() as con:
            rows = con.execute(
                "SELECT nickname FROM users "
                "WHERE COALESCE(profile_public,1)=1 "
                "AND LENGTH(nickname) >= 2 "
                "AND nickname NOT IN ('federation_sync','admin') "
                "AND nickname NOT LIKE '%1777%' "
                "ORDER BY id DESC LIMIT 5000"
            ).fetchall()
    except Exception as e:
        _log.warning("sitemap-users error: %s", e)
    today = _sitemap_dt.utcnow().strftime("%Y-%m-%d")
    urls = "".join(
        _sitemap_url(f"{SITE_URL}/u/{_xml_escape(r['nickname'])}", today, "weekly", "0.6")
        for r in rows if r["nickname"]
    )
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + urls + '</urlset>'
    )
    return Response(content=body, media_type="application/xml; charset=utf-8")


@app.get("/sitemap-rooms.xml", include_in_schema=False)
async def serve_sitemap_rooms():
    """Public chat rooms / channels."""
    from fastapi.responses import Response
    import database as db
    rows = []
    try:
        with db._conn() as con:
            rows = con.execute(
                "SELECT name FROM rooms "
                "WHERE COALESCE(type,'public')='public' "
                "AND name NOT LIKE 'phase2-%' "
                "AND name NOT LIKE '%sync%' "
                "AND name NOT LIKE '%1777%' "
                "AND LENGTH(name) >= 2 "
                "ORDER BY id DESC LIMIT 5000"
            ).fetchall()
    except Exception as e:
        _log.warning("sitemap-rooms error: %s", e)
    today = _sitemap_dt.utcnow().strftime("%Y-%m-%d")
    urls = "".join(
        _sitemap_url(f"{SITE_URL}/c/{_xml_escape(r['name'])}", today, "weekly", "0.6")
        for r in rows if r["name"]
    )
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + urls + '</urlset>'
    )
    return Response(content=body, media_type="application/xml; charset=utf-8")


@app.get("/sitemap-board.xml", include_in_schema=False)
async def serve_sitemap_board():
    """Frog Channel imageboard: index page + individual thread URLs."""
    from fastapi.responses import Response
    today = _sitemap_dt.utcnow().strftime("%Y-%m-%d")
    urls = _sitemap_url(f"{SITE_URL}/board", today, "hourly", "0.8")
    urls += _board_thread_urls(today)
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + urls + '</urlset>'
    )
    return Response(content=body, media_type="application/xml; charset=utf-8")


@app.get("/download/android")
async def download_android():
    """Always serves the latest Android APK with correct MIME + Content-Disposition."""
    import glob
    import re

    candidates = glob.glob("static/frogtalk-v*.apk") + glob.glob("static/FrogTalk-v*.apk")

    def _apk_version(path: str) -> int:
        name = os.path.basename(path)
        m = re.search(r"frogtalk-v(\d+)\.apk$", name, flags=re.IGNORECASE)
        return int(m.group(1)) if m else -1

    path = max(candidates, key=lambda p: (_apk_version(p), os.path.getmtime(p))) if candidates else ""
    if not os.path.exists(path):
        return JSONResponse(status_code=404, content={"error": "Android APK not available"})
    size = os.path.getsize(path)
    # APKs are already zip-compressed; running them through GZipMiddleware
    # wastes CPU AND switches the response to chunked transfer, which
    # strips Content-Length so Android's Download Manager / browsers can't
    # show real progress (they just display the bytes received so far as
    # the "total"). Setting Content-Encoding: identity makes Starlette's
    # gzip layer pass the body through unchanged, preserving Content-Length.
    # Cache-Control: no-transform asks Cloudflare / proxies to do the same.
    return FileResponse(
        path,
        media_type="application/vnd.android.package-archive",
        filename=os.path.basename(path),
        headers={
            "Content-Encoding": "identity",
            "Content-Length": str(size),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=300, no-transform",
        },
    )


@app.get("/download/ios")
async def download_ios():
    """Redirect to TestFlight/App Store, or serve local iOS landing page.

    iOS has no APK-style sideload for unmodified phones. The closest analogue
    to the Android `/download/android` flow is a TestFlight public link, which
    serves up to 10k testers and stays valid for 90 days per build. Once the
    app is approved on the App Store, point IOS_DOWNLOAD_URL at the App Store
    URL instead.
    """
    target = os.getenv("IOS_DOWNLOAD_URL", "").strip()
    if target and target not in {"/ios", "https://frogtalk.xyz/ios"}:
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url=target, status_code=302)
    return FileResponse(
        "static/ios.html",
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "public, max-age=300"},
    )


@app.get("/ios", include_in_schema=False)
async def ios_landing_page():
    """Public iOS coming-soon page with SEO/social metadata."""
    target = os.getenv("IOS_DOWNLOAD_URL", "").strip()
    if target and target not in {"/ios", "https://frogtalk.xyz/ios"}:
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url=target, status_code=302)
    return FileResponse(
        "static/ios.html",
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "public, max-age=300"},
    )


@app.get("/download/ios/", include_in_schema=False)
async def download_ios_trailing_slash():
    return await download_ios()


@app.get("/ios/", include_in_schema=False)
async def ios_landing_page_trailing_slash():
    return await ios_landing_page()


@app.get("/.well-known/apple-app-site-association", include_in_schema=False)
async def apple_app_site_association():
    """Universal Links manifest for iOS.

    Apple fetches this over HTTPS (no redirect, application/json). Replace
    `TEAMID` with the real 10-char Apple Developer team prefix once enrolled —
    it can also be supplied via APPLE_TEAM_ID without redeploying code.
    """
    team_id = os.getenv("APPLE_TEAM_ID", "TEAMID").strip() or "TEAMID"
    bundle  = os.getenv("APNS_BUNDLE_ID", "xyz.frogtalk.app").strip()
    payload = {
        "applinks": {
            "apps": [],
            "details": [
                {
                    "appID": f"{team_id}.{bundle}",
                    "paths": [
                        "/app",
                        "/app/*",
                        "/dm/*",
                        "/room/*",
                        "/u/*",
                        "/p/*",
                        "/c/*",
                        "/invite/*",
                    ],
                }
            ],
        },
        "webcredentials": {
            "apps": [f"{team_id}.{bundle}"],
        },
    }
    import json as _json_mod
    from fastapi.responses import Response as _Response
    return _Response(
        content=_json_mod.dumps(payload),
        media_type="application/json",
    )


@app.get("/download/linux")
async def download_linux():
    """Always serves the latest Linux AppImage."""
    import glob
    import re
    candidates = glob.glob("static/FrogTalk-*.AppImage")

    def _appimage_version(path: str):
        name = os.path.basename(path)
        m = re.search(r"FrogTalk-(\d+)\.(\d+)\.(\d+)\.AppImage$", name, flags=re.IGNORECASE)
        if not m:
            return (-1, -1, -1, os.path.getmtime(path))
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)), os.path.getmtime(path))

    path = max(candidates, key=_appimage_version) if candidates else ""
    if not path or not os.path.exists(path):
        return JSONResponse(status_code=404, content={"error": "Linux AppImage not available"})
    size = os.path.getsize(path)
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=os.path.basename(path),
        headers={
            "Content-Encoding": "identity",
            "Content-Length": str(size),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=300, no-transform",
        },
    )


@app.get("/download/deb")
async def download_deb():
    """Always serves the latest Debian/Ubuntu .deb package."""
    import glob
    import re
    candidates = (
        glob.glob("static/frogtalk_*_amd64.deb")
        + glob.glob("static/FrogTalk_*_amd64.deb")
    )

    def _deb_version(path: str):
        name = os.path.basename(path)
        m = re.search(r"frogtalk_(\d+)\.(\d+)\.(\d+)_amd64\.deb$", name, flags=re.IGNORECASE)
        if not m:
            return (-1, -1, -1, os.path.getmtime(path))
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)), os.path.getmtime(path))

    path = max(candidates, key=_deb_version) if candidates else ""
    if not path or not os.path.exists(path):
        return JSONResponse(status_code=404, content={"error": "Debian package not available"})
    size = os.path.getsize(path)
    return FileResponse(
        path,
        media_type="application/vnd.debian.binary-package",
        filename=os.path.basename(path),
        headers={
            "Content-Encoding": "identity",
            "Content-Length": str(size),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=300, no-transform",
        },
    )


@app.get("/download/windows")
async def download_windows():
    """Serves the latest Windows portable .exe (preferred), falling back to .zip."""
    import glob
    import re
    # Prefer portable .exe (single-file, just run it). Fall back to zip / installer.
    candidates = (
        glob.glob("static/FrogTalk-*-win-x64-portable.exe")
        + glob.glob("static/FrogTalk-*-portable.exe")
        + glob.glob("static/FrogTalk-*-Setup.exe")
        + glob.glob("static/FrogTalk-*-win-x64.zip")
        + glob.glob("static/FrogTalk-*-win.zip")
    )

    def _win_ver(path: str):
        name = os.path.basename(path)
        m = re.search(r"FrogTalk-(\d+)\.(\d+)\.(\d+)-", name, flags=re.IGNORECASE)
        if not m:
            return (-1, -1, -1, os.path.getmtime(path))
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)), os.path.getmtime(path))

    portable = [p for p in candidates if p.lower().endswith(".exe") and "portable" in p.lower()]
    setups = [p for p in candidates if p.lower().endswith(".exe") and "portable" not in p.lower()]
    zips = [p for p in candidates if p.lower().endswith(".zip")]
    if portable:
        path = max(portable, key=_win_ver)
    elif setups:
        path = max(setups, key=_win_ver)
    elif zips:
        path = max(zips, key=_win_ver)
    else:
        path = ""
    if not path or not os.path.exists(path):
        return JSONResponse(status_code=404, content={"error": "Windows package not available"})
    media = (
        "application/zip"
        if path.lower().endswith(".zip")
        else "application/vnd.microsoft.portable-executable"
    )
    size = os.path.getsize(path)
    return FileResponse(
        path,
        media_type=media,
        filename=os.path.basename(path),
        headers={
            "Content-Encoding": "identity",
            "Content-Length": str(size),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=300, no-transform",
        },
    )


@app.get("/download/windows-zip")
async def download_windows_zip():
    """Serves the latest Windows .zip build (extract & run)."""
    import glob
    import re
    candidates = (
        glob.glob("static/FrogTalk-*-win-x64.zip")
        + glob.glob("static/FrogTalk-*-win.zip")
    )

    def _zip_ver(path: str):
        name = os.path.basename(path)
        m = re.search(r"FrogTalk-(\d+)\.(\d+)\.(\d+)-", name, flags=re.IGNORECASE)
        if not m:
            return (-1, -1, -1, os.path.getmtime(path))
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)), os.path.getmtime(path))

    path = max(candidates, key=_zip_ver) if candidates else ""
    if not path or not os.path.exists(path):
        return JSONResponse(status_code=404, content={"error": "Windows ZIP package not available"})
    size = os.path.getsize(path)
    return FileResponse(
        path,
        media_type="application/zip",
        filename=os.path.basename(path),
        headers={
            "Content-Encoding": "identity",
            "Content-Length": str(size),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=300, no-transform",
        },
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


@app.get("/privacy")
async def privacy_page():
    page = "static/privacy.html"
    if os.path.exists(page):
        return FileResponse(page)
    return FileResponse("static/home.html")


@app.get("/security")
async def security_page():
    """Vulnerability disclosure + community-contribution page.

    FrogTalk is "vibe-coded but open source" — this page invites the
    community to report flaws via the bug-report API and to send PRs.
    """
    page = "static/security.html"
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
    post = (qp.get("post") or qp.get("p") or "").strip()
    if post.isdigit() and int(post) > 0:
        return await serve_post_landing(int(post))
    reel = (qp.get("reel") or qp.get("r") or "").strip()
    if reel.isdigit() and int(reel) > 0:
        return await serve_reel_landing(int(reel))
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
