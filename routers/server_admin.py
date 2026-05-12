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
_SESSIONS: dict[str, float] = {}
_EASTER_EGG_HTML_MAX = 512_000
_EASTER_EGG_UPLOAD_MAX = 16 * 1024 * 1024
_ALLOWED_EASTER_MEDIA = (
    "image/",
    "video/",
    "audio/",
)


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
    dead = [token for token, exp in _SESSIONS.items() if exp <= now]
    for token in dead:
        _SESSIONS.pop(token, None)


def _is_authenticated(request: Request) -> bool:
    _cleanup_sessions()
    token = request.cookies.get(_COOKIE_NAME, "")
    exp = _SESSIONS.get(token)
    if not exp:
        return False
    if exp <= time.time():
        _SESSIONS.pop(token, None)
        return False
    # Sliding expiration.
    _SESSIONS[token] = time.time() + _session_ttl_sec()
    return True


def _require_enabled() -> Optional[JSONResponse]:
    if _webui_enabled():
        return None
    return JSONResponse(status_code=404, content={"error": "Server WebUI disabled"})


def _require_auth(request: Request) -> Optional[JSONResponse]:
    if not _is_authenticated(request):
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
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
    out = str(html or "")[:_EASTER_EGG_HTML_MAX]
    out = re.sub(r"<\s*(script|style|object|embed)\b[^>]*>.*?<\s*/\s*\1\s*>", "", out, flags=re.I | re.S)
    out = re.sub(r"on[a-zA-Z]+\s*=\s*(['\"]).*?\1", "", out, flags=re.I | re.S)
    out = re.sub(r"on[a-zA-Z]+\s*=\s*[^\s>]+", "", out, flags=re.I)
    out = re.sub(r"(href|src)\s*=\s*(['\"])\s*javascript:[^\2]*\2", r"\1=\2#\2", out, flags=re.I)
    out = re.sub(r"(href|src)\s*=\s*(['\"])\s*data:text/html[^\2]*\2", r"\1=\2#\2", out, flags=re.I)
    return out.strip()


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
    _SESSIONS[token] = time.time() + _session_ttl_sec()
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
    return {"ok": True}


@router.post("/api/server-admin/logout")
async def server_webui_logout(request: Request, response: Response):
    disabled = _require_enabled()
    if disabled:
        return disabled

    token = request.cookies.get(_COOKIE_NAME, "")
    if token:
        _SESSIONS.pop(token, None)
    response.delete_cookie(_COOKIE_NAME, path="/")
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
