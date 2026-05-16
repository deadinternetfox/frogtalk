"""Secure server management WebUI routes and APIs."""
import base64
import ipaddress
import os
import re
import time
import secrets
import shutil
import urllib.parse
from typing import Optional

import bleach
from fastapi import APIRouter, Request, Response, UploadFile, File
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel

import database as db
from ws_manager import manager
from routers import federation as federation_router

router = APIRouter(tags=["server-admin"])

_SERVER_ADMIN_HTML_PATH = "static/server_admin.html"
_SERVER_ADMIN_JS_PATH = "static/js/server_admin.js"

_COOKIE_NAME = "ft_server_admin"
_CSRF_COOKIE_NAME = "frogtalk_admin_csrf"
# value: (expires_at: float, csrf_token: str)
_SESSIONS: dict[str, tuple[float, str]] = {}
_EASTER_EGG_HTML_MAX = 512_000
_EASTER_EGG_UPLOAD_MAX = 16 * 1024 * 1024
_ALLOWED_EASTER_MEDIA = (
    "image/",
    "video/",
    "audio/",
)

# ── Bleach allowlist for the easter-egg HTML editor ──────────────────────
# Keep this tight: only formatting tags + media. No <script>, no <iframe>,
# no inline event handlers. ``bleach.clean(..., strip=True)`` removes
# anything outside this allowlist instead of escaping it, so the editor
# stays readable while attacker-controlled markup gets dropped silently.
_EASTER_ALLOWED_TAGS = [
    "p", "br", "strong", "b", "em", "i", "u", "h2", "h3",
    "blockquote", "ul", "ol", "li", "a", "img", "video",
    "audio", "source", "figure", "figcaption", "span", "div",
]
_EASTER_ALLOWED_ATTRS = {
    "a": ["href", "title", "rel", "target"],
    "img": ["src", "alt", "title"],
    "video": ["src", "controls", "poster", "preload", "loop", "muted"],
    "audio": ["src", "controls", "preload", "loop"],
    "source": ["src", "type"],
    "span": ["style"],
    "div": ["style"],
}
_EASTER_ALLOWED_PROTOCOLS = ["http", "https", "mailto", "data"]


def _is_true(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


def _webui_enabled() -> bool:
    cfg = db.get_config("server.webui.enabled")
    if cfg is not None:
        return _is_true(cfg)
    return _is_true(os.getenv("FROGTALK_SERVER_WEBUI_ENABLED", "0"))


def _webui_username() -> str:
    return os.getenv("FROGTALK_SERVER_WEBUI_USER", "serveradmin").strip() or "serveradmin"


def _webui_password() -> str:
    # Fallback keeps first-time setup simple, but dedicated password is preferred.
    return os.getenv("FROGTALK_SERVER_WEBUI_PASSWORD", "") or os.getenv("ADMIN_PASSWORD", "")


def _session_ttl_sec() -> int:
    try:
        ttl = int(os.getenv("FROGTALK_SERVER_WEBUI_SESSION_TTL_SEC", "3600"))
    except Exception:
        ttl = 3600
    return max(300, min(ttl, 86400))


def _actor_user_id() -> int:
    """Use a stable existing admin id for moderation audit fields."""
    uid = db.get_user_id_by_nickname(_webui_username())
    if uid:
        return int(uid)
    uid = db.get_user_id_by_nickname("admin")
    if uid:
        return int(uid)
    return 1


def _read_meminfo() -> dict:
    out = {}
    try:
        with open("/proc/meminfo", "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if ":" not in line:
                    continue
                k, v = line.split(":", 1)
                parts = v.strip().split()
                if not parts:
                    continue
                try:
                    out[k.strip()] = int(parts[0]) * 1024
                except Exception:
                    continue
    except Exception:
        return {}
    return out


def _resource_snapshot() -> dict:
    now = int(time.time())
    cpu_count = os.cpu_count() or 1
    load1 = load5 = load15 = None
    cpu_pct_1m = None
    try:
        load1, load5, load15 = os.getloadavg()
        cpu_pct_1m = round((float(load1) / max(1, cpu_count)) * 100.0, 1)
    except Exception:
        pass

    mem = _read_meminfo()
    mem_total = int(mem.get("MemTotal") or 0)
    mem_available = int(mem.get("MemAvailable") or 0)
    mem_used = max(0, mem_total - mem_available) if mem_total else 0
    mem_pct = round((mem_used / mem_total) * 100.0, 1) if mem_total else None

    disk = shutil.disk_usage("/")
    disk_used = int(disk.used)
    disk_total = int(disk.total)
    disk_pct = round((disk_used / disk_total) * 100.0, 1) if disk_total else None

    uptime_s = None
    try:
        with open("/proc/uptime", "r", encoding="utf-8", errors="ignore") as f:
            uptime_s = int(float(f.read().split()[0]))
    except Exception:
        pass

    return {
        "timestamp": now,
        "cpu": {
            "cores": cpu_count,
            "load1": load1,
            "load5": load5,
            "load15": load15,
            "usage_pct_1m": cpu_pct_1m,
        },
        "memory": {
            "total": mem_total,
            "used": mem_used,
            "available": mem_available,
            "used_pct": mem_pct,
        },
        "disk": {
            "path": "/",
            "total": disk_total,
            "used": disk_used,
            "free": int(disk.free),
            "used_pct": disk_pct,
        },
        "uptime_sec": uptime_s,
    }


def _safe_host_label(url: str) -> str:
    target = (url or "").strip()
    if not target:
        return ""
    try:
        host = (urllib.parse.urlparse(target).hostname or "").strip().lower()
    except Exception:
        host = ""
    if not host:
        return "hidden endpoint"
    if federation_router._url_uses_tor(target):
        if len(host) <= 28:
            return host
        return f"{host[:14]}...{host[-10:]}"
    try:
        ipaddress.ip_address(host)
        return "hidden clearnet ip"
    except Exception:
        pass
    if len(host) <= 36:
        return host
    return f"{host[:18]}...{host[-10:]}"


def _admin_node_view(node: dict) -> dict:
    raw = dict(node or {})
    try:
        target = federation_router._select_peer_target(raw)
    except Exception:
        target = str(raw.get("onion_url") or raw.get("base_url") or "").strip()
    onion_url = str(raw.get("onion_url") or "").strip()
    route_mode = "tor" if federation_router._url_uses_tor(target) else "clearnet"
    display_endpoint = _safe_host_label(onion_url if route_mode == "tor" and onion_url else target)
    transport_preference = str(raw.get("transport_preference") or "auto").strip().lower() or "auto"
    return {
        "server_id": raw.get("server_id"),
        "display_name": raw.get("display_name"),
        "region": raw.get("region") or "",
        "official": bool(raw.get("official")),
        "trust_tier": raw.get("trust_tier") or "community",
        "enabled": bool(raw.get("enabled", True)),
        "last_seen": raw.get("last_seen"),
        "capabilities": raw.get("capabilities") or [],
        "onion_available": bool(onion_url),
        "route_mode": route_mode,
        "transport_preference": transport_preference,
        "display_endpoint": display_endpoint,
        "transport_label": "Tor onion route" if route_mode == "tor" else "Direct clearnet route",
        "privacy_label": "IP hidden" if route_mode == "tor" or display_endpoint == "hidden clearnet ip" else "Public host",
    }


def _local_admin_server_view() -> dict:
    local = db.get_or_create_local_server_identity() or {}
    public = federation_router._public_server_view(local, onion_only=federation_router._tor_mode_enabled())
    endpoint = federation_router._public_server_target(public)
    tor_enabled = bool(federation_router._tor_mode_enabled())
    return {
        "server_id": public.get("server_id") or "",
        "display_name": public.get("display_name") or "FrogTalk Node",
        "tor_enabled": tor_enabled,
        "public_endpoint": _safe_host_label(endpoint),
        "privacy_mode": "tor" if tor_enabled else "standard",
        "directory_last_sync": db.get_config("federation.official_directory_last_sync") or "",
    }


def _local_server_id() -> str:
    local = db.get_or_create_local_server_identity() or {}
    return str(local.get("server_id") or "").strip()


def _cleanup_sessions() -> None:
    now = time.time()
    dead = [token for token, entry in _SESSIONS.items() if entry[0] <= now]
    for token in dead:
        _SESSIONS.pop(token, None)


def _is_authenticated(request: Request) -> bool:
    _cleanup_sessions()
    token = request.cookies.get(_COOKIE_NAME, "")
    entry = _SESSIONS.get(token)
    if not entry:
        return False
    exp, csrf = entry
    if exp <= time.time():
        _SESSIONS.pop(token, None)
        return False
    # Sliding expiration.
    _SESSIONS[token] = (time.time() + _session_ttl_sec(), csrf)
    return True


def _require_csrf(request: Request) -> Optional[JSONResponse]:
    """Enforce double-submit CSRF on every state-changing admin route.

    Frontend reads the ``frogtalk_admin_csrf`` cookie (non-HttpOnly so JS
    can see it) and echoes the value back in ``X-CSRF-Token``. We then
    constant-time compare that against the per-session token stored
    server-side. A cross-origin attacker can't read the cookie thanks
    to SameSite=Strict and the host scope, so they can't forge the
    header.
    """
    token = request.cookies.get(_COOKIE_NAME, "")
    entry = _SESSIONS.get(token)
    if not entry:
        return JSONResponse(status_code=403, content={"error": "CSRF: no session"})
    _, expected_csrf = entry
    supplied = request.headers.get("x-csrf-token", "") or request.headers.get("X-CSRF-Token", "")
    if not supplied or not secrets.compare_digest(supplied, expected_csrf):
        return JSONResponse(status_code=403, content={"error": "CSRF token missing or invalid"})
    return None


def _require_enabled() -> Optional[JSONResponse]:
    if _webui_enabled():
        return None
    return JSONResponse(status_code=404, content={"error": "Server WebUI disabled"})


def _require_auth(request: Request) -> Optional[JSONResponse]:
    if not _is_authenticated(request):
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
    # Enforce CSRF on every state-changing method. GET/HEAD/OPTIONS are
    # safe by definition. The /login endpoint is exempt because it has
    # no session yet \u2014 it gets its own brute-force throttle elsewhere.
    method = (request.method or "").upper()
    if method not in ("GET", "HEAD", "OPTIONS"):
        if not request.url.path.endswith("/api/server-admin/login"):
            csrf_err = _require_csrf(request)
            if csrf_err:
                return csrf_err
    return None


class LoginBody(BaseModel):
    username: str
    password: str


class ModerationBody(BaseModel):
    nickname: str
    reason: str = ""
    duration_minutes: int = 60


class EasterEggBody(BaseModel):
    enabled: bool = False
    title: str = ""
    html: str = ""


class ChannelRetentionBody(BaseModel):
    directory_active_days: int = 30
    auto_delete_days: int = 0


def _cfg_easter_enabled() -> bool:
    return _is_true(db.get_config("server.webui.easter_egg.enabled") or "0")


def _cfg_easter_title() -> str:
    return (db.get_config("server.webui.easter_egg.title") or "Frog signal").strip() or "Frog signal"


def _cfg_easter_html() -> str:
    return db.get_config("server.webui.easter_egg.html") or ""


def _sanitize_easter_html(html: str) -> str:
    raw = str(html or "")[:_EASTER_EGG_HTML_MAX]
    # bleach handles every category the old regex pile was approximating
    # (open tags, attribute injection, javascript:/data:text/html URLs,
    # inline event handlers) with a proper HTML5 parser instead of
    # regex-guessing on a markup grammar.
    cleaned = bleach.clean(
        raw,
        tags=_EASTER_ALLOWED_TAGS,
        attributes=_EASTER_ALLOWED_ATTRS,
        protocols=_EASTER_ALLOWED_PROTOCOLS,
        strip=True,
        strip_comments=True,
    )
    # Belt + braces: forbid data: URLs that aren't image/audio/video
    # (bleach allows the whole ``data:`` scheme once you allowlist it).
    cleaned = re.sub(
        r'(?i)(src|href)\s*=\s*(["\'])\s*data:(?!(?:image|audio|video)/)[^"\']*\2',
        r'\1=\2#\2',
        cleaned,
    )
    return cleaned.strip()


def _current_easter_egg_payload() -> dict:
    raw_html = _cfg_easter_html()
    safe_html = _sanitize_easter_html(raw_html)
    if safe_html != raw_html:
        db.set_config("server.webui.easter_egg.html", safe_html)
    return {
        "enabled": _cfg_easter_enabled(),
        "title": _cfg_easter_title(),
        "html": safe_html,
        "updated_at": db.get_config("server.webui.easter_egg.updated_at") or "",
    }


def _save_easter_egg(enabled: bool, title: str, html: str) -> dict:
    safe_title = (title or "").strip()[:120] or "Frog signal"
    safe_html = _sanitize_easter_html(html)
    db.set_config("server.webui.easter_egg.enabled", "1" if enabled else "0")
    db.set_config("server.webui.easter_egg.title", safe_title)
    db.set_config("server.webui.easter_egg.html", safe_html)
    db.set_config("server.webui.easter_egg.updated_at", str(int(time.time())))
    return _current_easter_egg_payload()


@router.get("/server")
async def server_webui_page():
    disabled = _require_enabled()
    if disabled:
        return disabled
    with open(_SERVER_ADMIN_HTML_PATH, "r", encoding="utf-8") as fh:
        html = fh.read()
    try:
        asset_version = str(int(os.path.getmtime(_SERVER_ADMIN_JS_PATH)))
    except Exception:
        asset_version = str(int(time.time()))
    html = html.replace("__SERVER_ADMIN_ASSET_VERSION__", asset_version)
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@router.get("/api/server-admin/config")
async def server_webui_config():
    disabled = _require_enabled()
    if disabled:
        return disabled
    return {
        "enabled": True,
        "username_hint": _webui_username(),
        "channel_retention": db.get_channel_retention_settings(),
        "easter_egg": _current_easter_egg_payload(),
    }


@router.put("/api/server-admin/channel-retention")
async def server_admin_put_channel_retention(body: ChannelRetentionBody, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth

    settings = db.set_channel_retention_settings(body.directory_active_days, body.auto_delete_days)
    return {
        "ok": True,
        "channel_retention": settings,
        "local_policy": True,
    }


@router.get("/api/server-admin/easter-egg")
async def server_admin_get_easter_egg(request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth
    return _current_easter_egg_payload()


@router.put("/api/server-admin/easter-egg")
async def server_admin_put_easter_egg(body: EasterEggBody, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth
    return _save_easter_egg(bool(body.enabled), body.title, body.html)


@router.post("/api/server-admin/easter-egg/upload")
async def server_admin_upload_easter_egg_asset(request: Request, media: UploadFile = File(...)):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth
    if not media:
        return JSONResponse(status_code=400, content={"error": "Media required"})
    content_type = str(media.content_type or "application/octet-stream").strip().lower()
    if not any(content_type.startswith(prefix) for prefix in _ALLOWED_EASTER_MEDIA):
        return JSONResponse(status_code=400, content={"error": "Only image, video, and audio files are allowed"})
    raw = await media.read()
    if not raw:
        return JSONResponse(status_code=400, content={"error": "Empty upload"})
    if len(raw) > _EASTER_EGG_UPLOAD_MAX:
        return JSONResponse(status_code=413, content={"error": "Upload too large (max 16MB)"})
    media_data = f"data:{content_type};base64,{base64.b64encode(raw).decode('ascii')}"
    tag = "img" if content_type.startswith("image/") else ("video" if content_type.startswith("video/") else "audio")
    return {
        "ok": True,
        "content_type": content_type,
        "media_data": media_data,
        "tag": tag,
        "filename": str(media.filename or "asset"),
    }


@router.get("/api/server/easter-egg")
async def public_server_easter_egg():
    payload = _current_easter_egg_payload()
    if not payload.get("enabled") or not payload.get("html"):
        return JSONResponse(status_code=404, content={"error": "Not configured"})
    return payload


@router.post("/api/server-admin/login")
async def server_webui_login(request: Request, body: LoginBody, response: Response):
    disabled = _require_enabled()
    if disabled:
        return disabled

    expected_user = _webui_username()
    expected_password = _webui_password()
    if not expected_password:
        return JSONResponse(status_code=500, content={"error": "Server WebUI password not configured"})

    if body.username.strip() != expected_user or not secrets.compare_digest(
        body.password.encode("utf-8"), expected_password.encode("utf-8")
    ):
        return JSONResponse(status_code=401, content={"error": "Invalid credentials"})

    token = secrets.token_urlsafe(32)
    csrf_token = secrets.token_urlsafe(32)
    _SESSIONS[token] = (time.time() + _session_ttl_sec(), csrf_token)
    # Auto-enable Secure on https. The env override stays for local http
    # development where setting Secure would prevent the cookie from being
    # stored at all.
    is_https = (
        request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto", "").lower() == "https"
    )
    cookie_secure = is_https or _is_true(os.getenv("FROGTALK_SERVER_WEBUI_COOKIE_SECURE", "0"))
    response.set_cookie(
        key=_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=cookie_secure,
        samesite="strict",
        max_age=_session_ttl_sec(),
        path="/",
    )
    # CSRF cookie is intentionally NOT HttpOnly — the frontend reads it
    # with document.cookie to populate the X-CSRF-Token header. SameSite
    # + Secure prevent cross-origin theft.
    response.set_cookie(
        key=_CSRF_COOKIE_NAME,
        value=csrf_token,
        httponly=False,
        secure=cookie_secure,
        samesite="strict",
        max_age=_session_ttl_sec(),
        path="/",
    )
    return {"ok": True, "csrf_token": csrf_token}


@router.post("/api/server-admin/logout")
async def server_webui_logout(request: Request, response: Response):
    disabled = _require_enabled()
    if disabled:
        return disabled

    token = request.cookies.get(_COOKIE_NAME, "")
    if token:
        _SESSIONS.pop(token, None)
    response.delete_cookie(_COOKIE_NAME, path="/")
    response.delete_cookie(_CSRF_COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/api/server-admin/me")
async def server_webui_me(request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth
    return {"ok": True, "username": _webui_username()}


@router.get("/api/server-admin/stats")
async def server_admin_stats(request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth

    db_stats = db.get_server_admin_stats()
    ws_stats = manager.metrics_snapshot()
    return {
        "db": db_stats,
        "ws": ws_stats,
        "resources": _resource_snapshot(),
        "server": _local_admin_server_view(),
        "timestamp": int(time.time()),
    }


def _imageboard_root() -> str:
    """Locate the imageboard board_data directory.

    Honours FROGTALK_BOARD_DATA_DIR, otherwise probes a few common locations.
    """
    env = os.getenv("FROGTALK_BOARD_DATA_DIR", "").strip()
    if env:
        return env
    candidates = [
        "/opt/frogtalk/board/board_data",
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "board", "board_data"),
        os.path.join(os.getcwd(), "board", "board_data"),
    ]
    for c in candidates:
        if os.path.isdir(c):
            return c
    return candidates[0]


def _load_board_json(path: str, default):
    import json as _json
    try:
        with open(path, "r", encoding="utf-8") as f:
            v = _json.load(f)
            return v if v is not None else default
    except FileNotFoundError:
        return default
    except Exception:
        return default


@router.get("/api/server-admin/imageboard-stats")
async def server_admin_imageboard_stats(request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled
    auth = _require_auth(request)
    if auth:
        return auth

    root = _imageboard_root()
    available = os.path.isdir(root)

    threads = _load_board_json(os.path.join(root, "threads.json"), [])
    settings = _load_board_json(os.path.join(root, "settings.json"), {})
    bans = _load_board_json(os.path.join(root, "bans.json"), [])
    approval = _load_board_json(os.path.join(root, "approval_queue.json"), [])
    chat = _load_board_json(os.path.join(root, "chat.json"), [])

    if not isinstance(threads, list): threads = []
    if not isinstance(bans, list): bans = []
    if not isinstance(approval, list): approval = []
    if not isinstance(chat, list): chat = []
    if not isinstance(settings, dict): settings = {}

    now = int(time.time())
    day_ago = now - 86400
    week_ago = now - 7 * 86400

    total_posts = 0
    total_views = int(settings.get("views_lifetime") or 0)
    threads_24h = 0
    posts_24h = 0
    last_post_ts = 0
    media_count = 0
    pending_media = 0
    locked_threads = 0
    sticky_threads = 0

    for t in threads:
        if not isinstance(t, dict):
            continue
        total_posts += 1
        ts = int(t.get("timestamp") or t.get("time") or 0)
        if ts >= day_ago:
            threads_24h += 1
            posts_24h += 1
        if ts > last_post_ts:
            last_post_ts = ts
        total_views += int(t.get("views") or 0)
        if t.get("locked"): locked_threads += 1
        if t.get("sticky"): sticky_threads += 1
        m = t.get("media")
        if isinstance(m, dict):
            media_count += 1
            if not m.get("approved", True):
                pending_media += 1
        for r in (t.get("replies") or []):
            if not isinstance(r, dict):
                continue
            total_posts += 1
            rts = int(r.get("timestamp") or r.get("time") or 0)
            if rts >= day_ago:
                posts_24h += 1
            if rts > last_post_ts:
                last_post_ts = rts
            rm = r.get("media")
            if isinstance(rm, dict):
                media_count += 1
                if not rm.get("approved", True):
                    pending_media += 1

    active_bans = 0
    for b in bans:
        if not isinstance(b, dict):
            continue
        exp = int(b.get("expires") or 0)
        if exp == 0 or exp > now:
            active_bans += 1

    # Federated peer list — surfaces both/all boards in the server admin
    # panel so the operator can see e.g. "Frog General + SpyCraft" without
    # bouncing through /board/admin on each node.
    raw_peers = settings.get("federated_peers") or []
    blocked_nodes = settings.get("blocked_peer_nodes") or []
    if not isinstance(blocked_nodes, list):
        blocked_nodes = []
    blocked_set = {str(x) for x in blocked_nodes if x}
    peers = []
    if isinstance(raw_peers, list):
        for p in raw_peers:
            if not isinstance(p, dict): continue
            nid = str(p.get("node_id") or "")
            peers.append({
                "node_id":       nid,
                "title":         str(p.get("title") or ""),
                "subtitle":      str(p.get("subtitle") or ""),
                "topic":         str(p.get("topic") or ""),
                "url":           str(p.get("url") or ""),
                "tor_only":      bool(p.get("tor_only") or False),
                "tor_onion_url": str(p.get("tor_onion_url") or ""),
                "last_seen":     int(p.get("last_seen") or 0),
                "blocked":       bool(nid and nid in blocked_set),
            })

    return {
        "available": available,
        "data_dir": root,
        "identity": {
            "title": settings.get("board_title") or "/board/",
            "subtitle": settings.get("board_subtitle") or "",
            "topic": settings.get("board_topic") or "",
            "node_id": settings.get("node_id") or "",
            "tor_only": bool(settings.get("tor_only") or False),
            "tor_onion_url": settings.get("tor_onion_url") or "",
            "federation_enabled": bool(settings.get("federation_enabled", True)),
            "board_locked": bool(settings.get("board_locked") or False),
            "chat_enabled": bool(settings.get("chat_enabled", True)),
            "announcement": settings.get("announcement") or "",
        },
        "peers": peers,
        "stats": {
            "threads": len(threads),
            "posts": total_posts,
            "views": total_views,
            "threads_24h": threads_24h,
            "posts_24h": posts_24h,
            "media": media_count,
            "pending_media": pending_media,
            "approval_queue": len(approval),
            "active_bans": active_bans,
            "chat_messages": len(chat),
            "locked_threads": locked_threads,
            "sticky_threads": sticky_threads,
            "last_post_ts": last_post_ts,
            "federated_peers": len(settings.get("federated_peers") or []),
        },
        "admin_url": "/board/admin",
        "board_url": "/board/",
        "timestamp": now,
    }


@router.put("/api/server-admin/imageboard-identity")
async def server_admin_imageboard_identity(request: Request):
    """Update this node's board identity (title / subtitle / topic / node_id).

    Writes directly to ``board_data/settings.json`` so the change takes
    effect on the next request without needing to touch /board/admin. We
    deliberately limit the editable fields here — ban lists, federation
    peers, retention, etc. still live in the dedicated board admin UI.
    """
    import json as _json
    disabled = _require_enabled()
    if disabled:
        return disabled
    auth = _require_auth(request)
    if auth:
        return auth
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Invalid body"})

    root = _imageboard_root()
    if not os.path.isdir(root):
        return JSONResponse(status_code=404, content={"error": f"Board data dir not found: {root}"})
    path = os.path.join(root, "settings.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            settings = _json.load(f) or {}
    except FileNotFoundError:
        settings = {}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to read settings: {e}"})
    if not isinstance(settings, dict):
        settings = {}

    import re as _re
    # Only allow the identity-related fields through.
    if "board_title" in body:
        settings["board_title"] = str(body.get("board_title") or "")[:64]
    if "board_subtitle" in body:
        settings["board_subtitle"] = str(body.get("board_subtitle") or "")[:200]
    if "board_topic" in body:
        # Mirrors imageboard/board_admin.php sanitisation (A-Z0-9_- + space, ≤32 chars).
        raw = str(body.get("board_topic") or "")
        settings["board_topic"] = _re.sub(r"[^A-Za-z0-9_\- ]", "", raw)[:32]
    if "node_id" in body:
        raw = str(body.get("node_id") or "").strip().lower()
        # node_id is a slug — lowercased a-z0-9- only, max 40 chars.
        slug = _re.sub(r"[^a-z0-9\-]", "", raw)[:40]
        if slug:
            settings["node_id"] = slug

    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            _json.dump(settings, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to write settings: {e}"})

    return {
        "ok": True,
        "identity": {
            "title": settings.get("board_title") or "",
            "subtitle": settings.get("board_subtitle") or "",
            "topic": settings.get("board_topic") or "",
            "node_id": settings.get("node_id") or "",
        },
    }


@router.put("/api/server-admin/imageboard-peer-block")
async def server_admin_imageboard_peer_block(request: Request):
    """Toggle whether a federated board peer is hidden from this node's
    public /board/ navigation. Stored as ``blocked_peer_nodes`` in
    settings.json (a flat list of node_id strings). Body: {node_id, blocked}."""
    import json as _json
    disabled = _require_enabled()
    if disabled:
        return disabled
    auth = _require_auth(request)
    if auth:
        return auth
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Invalid body"})
    node_id = str(body.get("node_id") or "").strip().lower()
    if not node_id or len(node_id) > 64:
        return JSONResponse(status_code=400, content={"error": "node_id required"})
    block = bool(body.get("blocked"))

    root = _imageboard_root()
    if not os.path.isdir(root):
        return JSONResponse(status_code=404, content={"error": f"Board data dir not found: {root}"})
    path = os.path.join(root, "settings.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            settings = _json.load(f) or {}
    except FileNotFoundError:
        settings = {}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to read settings: {e}"})
    if not isinstance(settings, dict):
        settings = {}
    blocked = settings.get("blocked_peer_nodes") or []
    if not isinstance(blocked, list):
        blocked = []
    blocked = [str(x) for x in blocked if x]
    if block:
        if node_id not in blocked:
            blocked.append(node_id)
    else:
        blocked = [x for x in blocked if x != node_id]
    settings["blocked_peer_nodes"] = blocked

    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            _json.dump(settings, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to write settings: {e}"})
    return {"ok": True, "node_id": node_id, "blocked": block, "blocked_peer_nodes": blocked}


@router.get("/api/server-admin/nodes")
async def server_admin_nodes(request: Request, include_disabled: int = 1):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth

    local_sid = _local_server_id()
    nodes = []
    for node in db.list_federation_servers_admin(include_disabled=bool(include_disabled)):
        view = _admin_node_view(node)
        view["is_local"] = bool(local_sid and (view.get("server_id") or "") == local_sid)
        nodes.append(view)
    return {"nodes": nodes, "count": len(nodes)}


@router.get("/api/server-admin/nodes/{server_id}/probe")
async def server_admin_probe_node(server_id: str, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth

    sid = (server_id or "").strip()
    if not sid:
        return JSONResponse(status_code=400, content={"error": "server_id required"})

    node = next((n for n in db.list_federation_servers_admin(include_disabled=True) if (n.get("server_id") or "") == sid), None)
    if not node:
        return JSONResponse(status_code=404, content={"error": "Node not found"})

    local_sid = _local_server_id()
    if local_sid and sid == local_sid:
        return {
            "ok": True,
            "server_id": sid,
            "display_target": "local process",
            "route_mode": "local",
            "transport_label": "Local self-check",
            "healthy": True,
            "latency_ms": 0,
            "error": None,
            "is_local": True,
        }

    target = federation_router._select_peer_target(node)
    result = federation_router._probe_url(target, timeout_s=1.6)
    route_mode = "tor" if federation_router._url_uses_tor(target) else "clearnet"
    return {
        "ok": True,
        "server_id": sid,
        "display_target": _safe_host_label(target),
        "route_mode": route_mode,
        "transport_label": "Tor onion route" if route_mode == "tor" else "Direct clearnet route",
        "healthy": bool(result.get("ok")),
        "latency_ms": result.get("latency_ms"),
        "error": result.get("error"),
        "is_local": False,
    }


@router.post("/api/server-admin/nodes/{server_id}/block")
async def server_admin_block_node(server_id: str, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth

    ok = db.set_federation_server_enabled(server_id, False)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Node not found"})
    return {"ok": True, "server_id": server_id, "blocked": True}


@router.post("/api/server-admin/nodes/{server_id}/unblock")
async def server_admin_unblock_node(server_id: str, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth

    ok = db.set_federation_server_enabled(server_id, True)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Node not found"})
    return {"ok": True, "server_id": server_id, "blocked": False}


# ---------------------------------------------------------------------------
# Bot moderation (per-node ban list)
# ---------------------------------------------------------------------------

@router.get("/api/server-admin/bots")
async def server_admin_list_bots(request: Request):
    """Return every bot this node knows about (local catalog rows +
    federated mirrors) annotated with a `banned` flag. Used by the
    admin Bot Moderation panel."""
    disabled = _require_enabled()
    if disabled:
        return disabled
    auth = _require_auth(request)
    if auth:
        return auth
    try:
        bots = db.list_all_bots_admin()
    except Exception:
        bots = []
    return {"bots": bots}


@router.post("/api/server-admin/bots/{bot_id}/ban")
async def server_admin_ban_bot(bot_id: int, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled
    auth = _require_auth(request)
    if auth:
        return auth

    reason = ""
    try:
        body = await request.json()
        if isinstance(body, dict):
            reason = str(body.get("reason") or "")[:280]
    except Exception:
        pass

    bot = db.get_bot_by_id(int(bot_id))
    if not bot:
        return JSONResponse(status_code=404, content={"error": "Bot not found"})

    db.ban_bot(int(bot_id), reason=reason, banned_by=_actor_user_id())
    return {
        "ok": True,
        "bot_id": int(bot_id),
        "name": bot.get("name"),
        "banned": True,
        "reason": reason,
    }


@router.post("/api/server-admin/bots/{bot_id}/unban")
async def server_admin_unban_bot(bot_id: int, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled
    auth = _require_auth(request)
    if auth:
        return auth

    ok = db.unban_bot(int(bot_id))
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Bot was not banned"})
    return {"ok": True, "bot_id": int(bot_id), "banned": False}


@router.get("/api/server-admin/online-users")
async def server_admin_online_users(request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth

    return {"users": manager.online_users_snapshot()}


@router.post("/api/server-admin/control/sync-official-directory")
async def server_admin_sync_official_directory(request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth

    result = await federation_router.sync_official_directory_once()
    if not result.get("ok"):
        return JSONResponse(status_code=400, content=result)
    return result


@router.post("/api/server-admin/control/kick")
async def server_admin_kick(body: ModerationBody, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth

    target_id = db.get_user_id_by_nickname(body.nickname)
    if not target_id:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    count = await manager.disconnect_user(target_id)
    return {"ok": True, "disconnected": count}


@router.post("/api/server-admin/control/ban")
async def server_admin_ban(body: ModerationBody, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth

    target_id = db.get_user_id_by_nickname(body.nickname)
    if not target_id:
        return JSONResponse(status_code=404, content={"error": "User not found"})

    ok = db.global_ban_user(target_id, _actor_user_id(), body.reason, body.duration_minutes)
    if not ok:
        return JSONResponse(status_code=500, content={"error": "Failed to ban user"})
    await manager.disconnect_user(target_id)
    return {"ok": True}


@router.post("/api/server-admin/control/unban")
async def server_admin_unban(body: ModerationBody, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth

    target_id = db.get_user_id_by_nickname(body.nickname)
    if not target_id:
        return JSONResponse(status_code=404, content={"error": "User not found"})

    ok = db.global_unban_user(target_id)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "User was not banned"})
    return {"ok": True}


@router.post("/api/server-admin/control/mute")
async def server_admin_mute(body: ModerationBody, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth

    target_id = db.get_user_id_by_nickname(body.nickname)
    if not target_id:
        return JSONResponse(status_code=404, content={"error": "User not found"})

    ok = db.global_mute_user(target_id, _actor_user_id(), body.reason, body.duration_minutes)
    if not ok:
        return JSONResponse(status_code=500, content={"error": "Failed to mute user"})
    return {"ok": True}


@router.post("/api/server-admin/control/unmute")
async def server_admin_unmute(body: ModerationBody, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    auth = _require_auth(request)
    if auth:
        return auth

    target_id = db.get_user_id_by_nickname(body.nickname)
    if not target_id:
        return JSONResponse(status_code=404, content={"error": "User not found"})

    ok = db.global_unmute_user(target_id)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "User was not muted"})
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────
# Bug & vulnerability report queue (admin views)
# ─────────────────────────────────────────────────────────────────────────
#
# The public POST endpoint lives in routers/bug_reports.py so that anyone —
# including unauthenticated visitors of /security — can file a report. The
# admin-side list/triage endpoints belong here because they need to share
# the server-admin session + CSRF model that the rest of the dashboard uses
# (cookie-based auth, double-submit CSRF token in X-CSRF-Token).

_BUG_VALID_SEVERITY = {"low", "medium", "high", "critical"}
_BUG_VALID_STATUS = {"open", "triage", "in_progress", "fixed", "wontfix", "duplicate"}


class BugReportUpdateBody(BaseModel):
    status: Optional[str] = None
    severity: Optional[str] = None
    admin_notes: Optional[str] = None


@router.get("/api/server-admin/bug-reports")
async def server_admin_list_bug_reports(
    request: Request,
    status: Optional[str] = None,
    severity: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    disabled = _require_enabled()
    if disabled:
        return disabled
    auth = _require_auth(request)
    if auth:
        return auth

    limit = max(1, min(int(limit or 100), 500))
    offset = max(0, int(offset or 0))
    rows = db.list_bug_reports(
        status=status, severity=severity, limit=limit, offset=offset,
    )
    return {"reports": rows, "stats": db.bug_report_stats()}


@router.get("/api/server-admin/bug-reports/{report_id}")
async def server_admin_get_bug_report(report_id: int, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled
    auth = _require_auth(request)
    if auth:
        return auth
    row = db.get_bug_report(int(report_id))
    if not row:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return row


@router.patch("/api/server-admin/bug-reports/{report_id}")
async def server_admin_update_bug_report(
    report_id: int, body: BugReportUpdateBody, request: Request,
):
    disabled = _require_enabled()
    if disabled:
        return disabled
    auth = _require_auth(request)
    if auth:
        return auth

    if body.status is not None and body.status not in _BUG_VALID_STATUS:
        return JSONResponse(status_code=400, content={"error": "Invalid status"})
    if body.severity is not None and body.severity not in _BUG_VALID_SEVERITY:
        return JSONResponse(status_code=400, content={"error": "Invalid severity"})

    ok = db.update_bug_report(
        int(report_id),
        status=body.status,
        severity=body.severity,
        admin_notes=body.admin_notes,
    )
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Not found or no changes"})
    return {"ok": True, "report": db.get_bug_report(int(report_id))}


@router.delete("/api/server-admin/bug-reports/{report_id}")
async def server_admin_delete_bug_report(report_id: int, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled
    auth = _require_auth(request)
    if auth:
        return auth
    ok = db.delete_bug_report(int(report_id))
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return {"ok": True}
