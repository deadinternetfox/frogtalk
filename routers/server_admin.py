"""Secure server management WebUI routes and APIs."""
import os
import time
import secrets
import shutil
from typing import Optional

from fastapi import APIRouter, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

import database as db
from ws_manager import manager
from routers import federation as federation_router

router = APIRouter(tags=["server-admin"])

_COOKIE_NAME = "ft_server_admin"
_SESSIONS: dict[str, float] = {}


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


@router.get("/server")
async def server_webui_page():
    disabled = _require_enabled()
    if disabled:
        return disabled
    return FileResponse("static/server_admin.html")


@router.get("/api/server-admin/config")
async def server_webui_config():
    disabled = _require_enabled()
    if disabled:
        return disabled
    return {
        "enabled": True,
        "username_hint": _webui_username(),
    }


@router.post("/api/server-admin/login")
async def server_webui_login(body: LoginBody, response: Response):
    disabled = _require_enabled()
    if disabled:
        return disabled

    expected_user = _webui_username()
    expected_password = _webui_password()
    if not expected_password:
        return JSONResponse(status_code=500, content={"error": "Server WebUI password not configured"})

    if body.username.strip() != expected_user or body.password != expected_password:
        return JSONResponse(status_code=401, content={"error": "Invalid credentials"})

    token = secrets.token_urlsafe(32)
    _SESSIONS[token] = time.time() + _session_ttl_sec()
    response.set_cookie(
        key=_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=_is_true(os.getenv("FROGTALK_SERVER_WEBUI_COOKIE_SECURE", "0")),
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

    nodes = db.list_federation_servers_admin(include_disabled=bool(include_disabled))
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

    target = federation_router._select_peer_target(node)
    result = federation_router._probe_url(target, timeout_s=1.6)
    return {
        "ok": True,
        "server_id": sid,
        "target": target,
        "healthy": bool(result.get("ok")),
        "latency_ms": result.get("latency_ms"),
        "error": result.get("error"),
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
