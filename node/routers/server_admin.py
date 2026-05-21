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
from public_url_policy import analyze_public_url, url_is_http_only_clearnet, url_is_https
from ws_manager import manager
from routers import federation as federation_router
from deps import (
    client_ip,
    resolve_current_user,
    resolve_admin_user,
    admin_area_access_status,
    session_token_from_request,
)
from slowapi import Limiter
from fastapi import HTTPException

router = APIRouter(tags=["server-admin"])
limiter = Limiter(key_func=client_ip)

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
    """Return the server-admin WebUI password.

    HIGH-5: the historical fallback to ``ADMIN_PASSWORD`` is gone. That
    env var seeds the application *user* admin account and shipped with a
    weak default in ``deploy/env.example``; treating it as the WebUI
    bootstrap password meant a single leaked value unlocked both layers.
    Operators must now set ``FROGTALK_SERVER_WEBUI_PASSWORD`` explicitly.
    """
    return os.getenv("FROGTALK_SERVER_WEBUI_PASSWORD", "")


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


def _safe_host_label(url: str, *, redact_clearnet_ips: bool = False) -> str:
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
        ip = ipaddress.ip_address(host)
        if not redact_clearnet_ips:
            return host
        if isinstance(ip, ipaddress.IPv4Address):
            octets = str(ip).split(".")
            return f"{octets[0]}.{octets[1]}.*.*"
        compact = str(ip)
        if len(compact) > 20:
            return f"{compact[:8]}…{compact[-6:]}"
        return compact
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
    _policy = db.get_federation_policy_settings()
    _redact_ips = False
    display_endpoint = _safe_host_label(
        onion_url if route_mode == "tor" and onion_url else target,
        redact_clearnet_ips=_redact_ips,
    )
    transport_preference = str(raw.get("transport_preference") or "auto").strip().lower() or "auto"
    base_url = str(raw.get("base_url") or "").strip()
    tls_insecure = bool(base_url) and url_is_http_only_clearnet(base_url)
    tls_secure = bool(base_url) and url_is_https(base_url)
    tor_policy = bool(_policy.get("block_tor_peers"))
    http_policy = bool(_policy.get("block_http_only_peers"))
    enabled = bool(raw.get("enabled", True))
    policy_tor_blocked = tor_policy and route_mode == "tor" and not enabled
    policy_http_blocked = http_policy and tls_insecure and not enabled
    return {
        "server_id": raw.get("server_id"),
        "display_name": raw.get("display_name"),
        "region": federation_router._resolved_server_region(raw) or raw.get("region") or "",
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
        "privacy_label": (
            "IP hidden (Tor)"
            if route_mode == "tor"
            else "Public host"
        ),
        "policy_tor_blocked": policy_tor_blocked,
        "policy_http_blocked": policy_http_blocked,
        "tls_insecure": tls_insecure,
        "tls_secure": tls_secure,
    }


def _local_admin_server_view() -> dict:
    local = db.get_or_create_local_server_identity() or {}
    public = federation_router._public_server_view(local, onion_only=federation_router._tor_mode_enabled())
    endpoint = federation_router._public_server_target(public)
    tor_enabled = bool(federation_router._tor_mode_enabled())
    url_meta = analyze_public_url()
    _redact = False
    return {
        "server_id": public.get("server_id") or "",
        "display_name": public.get("display_name") or "FrogTalk Node",
        "tor_enabled": tor_enabled,
        "public_endpoint": _safe_host_label(endpoint, redact_clearnet_ips=_redact),
        "privacy_mode": "tor" if tor_enabled else "standard",
        "directory_last_sync": db.get_config("federation.official_directory_last_sync") or "",
        "public_url_meta": url_meta,
    }


def _local_server_id() -> str:
    local = db.get_or_create_local_server_identity() or {}
    return str(local.get("server_id") or "").strip()


_SERVER_ID_RE = re.compile(r"^srv_[a-f0-9]{8,40}$", re.IGNORECASE)


def _normalize_federation_server_id(server_id: str) -> tuple[str | None, JSONResponse | None]:
    """Validate federation server_id before admin mutations (block/unblock/delete/probe)."""
    sid = (server_id or "").strip()
    if not sid or len(sid) > 64:
        return None, JSONResponse(status_code=400, content={"error": "Invalid server_id"})
    if not _SERVER_ID_RE.fullmatch(sid):
        return None, JSONResponse(status_code=400, content={"error": "Invalid server_id format"})
    return sid, None


def _parse_last_seen_ts(value) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _clearnet_host_key(url: str) -> str:
    raw = str(url or "").strip()
    if not raw:
        return ""
    try:
        p = urllib.parse.urlparse(raw)
    except Exception:
        return ""
    if (p.scheme or "").lower() not in ("http", "https"):
        return ""
    host = (p.hostname or "").strip().lower()
    if not host or host.endswith(".onion"):
        return ""
    return host


def _node_canonical_score(node: dict) -> tuple[int, int, int, int, int]:
    """Higher tuple wins as the canonical row for duplicate host entries."""
    base = str((node or {}).get("base_url") or "").strip().lower()
    trust = str((node or {}).get("trust_tier") or "").strip().lower()
    return (
        1 if base.startswith("https://") else 0,
        1 if bool((node or {}).get("official")) else 0,
        1 if bool((node or {}).get("enabled", True)) else 0,
        2 if trust == "official" else (1 if trust == "community" else 0),
        _parse_last_seen_ts((node or {}).get("last_seen")),
    )


def _stale_node_reasons(rows: list[dict], local_sid: str) -> dict[str, str]:
    """Detect likely stale/duplicate rows that operators can safely purge."""
    host_groups: dict[str, list[dict]] = {}
    for row in rows or []:
        sid = str((row or {}).get("server_id") or "").strip()
        if not sid or (local_sid and sid == local_sid):
            continue
        key = _clearnet_host_key((row or {}).get("base_url") or "")
        if not key:
            continue
        host_groups.setdefault(key, []).append(row)

    out: dict[str, str] = {}
    for _host, group in host_groups.items():
        if len(group) <= 1:
            continue
        ordered = sorted(group, key=_node_canonical_score, reverse=True)
        keep = ordered[0]
        keep_sid = str((keep or {}).get("server_id") or "").strip()
        keep_base = str((keep or {}).get("base_url") or "").strip()
        for cand in ordered[1:]:
            sid = str((cand or {}).get("server_id") or "").strip()
            if not sid:
                continue
            base = str((cand or {}).get("base_url") or "").strip()
            reason = f"Duplicate endpoint; preferred row is {keep_sid} ({keep_base or 'no base_url'})"
            if base.lower().startswith("http://") and keep_base.lower().startswith("https://"):
                reason = f"HTTP duplicate; canonical HTTPS row is {keep_sid} ({keep_base})"
            out[sid] = reason
    return out


def _cleanup_sessions() -> None:
    now = time.time()
    dead = [token for token, entry in _SESSIONS.items() if entry[0] <= now]
    for token in dead:
        _SESSIONS.pop(token, None)


def _client_ip_for_admin(request: Request) -> str:
    """Best-effort client IP for the admin allowlist. Honours
    X-Forwarded-For *only* when an upstream proxy is expected (we sit
    behind nginx + Cloudflare in prod), otherwise falls back to the
    socket peer."""
    fwd = (request.headers.get("x-forwarded-for") or "").strip()
    if fwd:
        # Left-most entry is the original client per RFC 7239.
        return fwd.split(",")[0].strip()
    return (request.client.host if request.client else "") or ""


def _admin_ip_allowed(request: Request) -> bool:
    """Optional IP allowlist for the admin panel.

    Set ``FROGTALK_ADMIN_IP_ALLOWLIST`` to a comma-separated list of IPs
    or CIDRs (e.g. ``"203.0.113.4,2001:db8::/32"``). When unset, all
    IPs are allowed (current behaviour). When set, requests from
    addresses outside the allowlist are rejected before the password /
    CSRF check, so an attacker who steals admin credentials still
    can't sign in from outside the operator's network.
    """
    raw = (os.getenv("FROGTALK_ADMIN_IP_ALLOWLIST", "") or "").strip()
    if not raw:
        return True
    import ipaddress as _ipa
    peer = _client_ip_for_admin(request)
    if not peer:
        return False
    try:
        peer_ip = _ipa.ip_address(peer)
    except ValueError:
        return False
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            if "/" in entry:
                if peer_ip in _ipa.ip_network(entry, strict=False):
                    return True
            else:
                if peer_ip == _ipa.ip_address(entry):
                    return True
        except ValueError:
            continue
    return False


def _is_authenticated(request: Request) -> bool:
    _cleanup_sessions()
    if not _admin_ip_allowed(request):
        return False
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


def _legacy_webui_login_enabled() -> bool:
    return _is_true(os.getenv("FROGTALK_SERVER_WEBUI_LEGACY_LOGIN", "0"))


async def _require_frogtalk_admin(request: Request) -> tuple[dict | None, JSONResponse | None]:
    """Require FrogTalk session, node admin role, and admin PIN grace if enabled."""
    try:
        user = await resolve_admin_user(request)
    except HTTPException as exc:
        if exc.status_code == 401:
            return None, JSONResponse(
                status_code=401,
                content={"error": "Not authenticated", "login_required": True},
            )
        if exc.status_code == 403:
            return None, JSONResponse(
                status_code=403,
                content={"error": "Admin access required", "admin_required": True},
            )
        return None, JSONResponse(status_code=exc.status_code, content={"error": str(exc.detail)})
    token = session_token_from_request(request)
    status = admin_area_access_status(user, token)
    if not status.get("allowed"):
        return None, JSONResponse(
            status_code=423,
            content={
                "error": "PIN required for admin actions",
                "pin_required": True,
                "admin": True,
            },
        )
    return user, None


def _require_auth(request: Request) -> Optional[JSONResponse]:
    """Sync wrapper kept for legacy webui cookie auth (emergency ops only)."""
    if not _legacy_webui_login_enabled():
        return JSONResponse(
            status_code=401,
            content={"error": "Use FrogTalk login", "login_required": True},
        )
    if not _is_authenticated(request):
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
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


class FederationPolicyBody(BaseModel):
    block_tor_peers: bool = False
    block_http_only_peers: bool = False
    redact_clearnet_ips: bool = False


class PurgeStaleNodesBody(BaseModel):
    dry_run: bool = False


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
async def server_webui_config(request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled
    token = session_token_from_request(request)
    user = None
    try:
        user = await resolve_current_user(request)
    except HTTPException:
        user = None
    gate = admin_area_access_status(user, token)
    return {
        "enabled": True,
        "auth_mode": "frogtalk",
        "legacy_webui_login": _legacy_webui_login_enabled(),
        "gate": gate,
        "channel_retention": db.get_channel_retention_settings(),
        "federation_policy": db.get_federation_policy_settings(),
        "public_url_meta": analyze_public_url(),
        "easter_egg": _current_easter_egg_payload(),
    }


@router.get("/api/server-admin/session")
async def server_admin_session(request: Request):
    """Bootstrap auth state for direct /server visits (no legacy cookie)."""
    disabled = _require_enabled()
    if disabled:
        return disabled
    user = None
    try:
        user = await resolve_current_user(request)
    except HTTPException:
        user = None
    token = session_token_from_request(request)
    gate = admin_area_access_status(user, token)
    return {"ok": gate.get("allowed", False), **gate}


@router.put("/api/server-admin/federation-policy")
async def server_admin_put_federation_policy(body: FederationPolicyBody, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    _user, auth = await _require_frogtalk_admin(request)
    if auth:
        return auth

    policy = db.set_federation_policy_settings(
        bool(body.block_tor_peers),
        block_http_only_peers=bool(body.block_http_only_peers),
        redact_clearnet_ips=bool(body.redact_clearnet_ips),
    )
    tor_disabled = 0
    http_disabled = 0
    if policy.get("block_tor_peers"):
        tor_disabled = federation_router.apply_tor_peer_blocks_if_enabled()
    if policy.get("block_http_only_peers"):
        http_disabled = federation_router.apply_http_only_peer_blocks_if_enabled()
    url_meta = analyze_public_url()
    policy_notes: list[str] = []
    if bool(body.redact_clearnet_ips) and url_meta.get("is_ip_host"):
        policy_notes.append(
            "Redact clearnet IPs only masks addresses in Server Admin. Visitors still see this node's IP in the browser bar and on /board/ until you use a domain with trusted TLS."
        )
    return {
        "ok": True,
        "federation_policy": policy,
        "tor_peers_disabled": tor_disabled,
        "http_peers_disabled": http_disabled,
        "policy_notes": policy_notes,
        "public_url_meta": url_meta,
    }


@router.put("/api/server-admin/channel-retention")
async def server_admin_put_channel_retention(body: ChannelRetentionBody, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    _user, auth = await _require_frogtalk_admin(request)
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

    _user, auth = await _require_frogtalk_admin(request)
    if auth:
        return auth
    return _current_easter_egg_payload()


@router.put("/api/server-admin/easter-egg")
async def server_admin_put_easter_egg(body: EasterEggBody, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    _user, auth = await _require_frogtalk_admin(request)
    if auth:
        return auth
    return _save_easter_egg(bool(body.enabled), body.title, body.html)


@router.post("/api/server-admin/easter-egg/upload")
async def server_admin_upload_easter_egg_asset(request: Request, media: UploadFile = File(...)):
    disabled = _require_enabled()
    if disabled:
        return disabled

    _user, auth = await _require_frogtalk_admin(request)
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
@limiter.limit("10/minute;30/hour")
async def server_webui_login(request: Request, body: LoginBody, response: Response):
    """Legacy env-only operator login. Production uses FrogTalk session + PIN."""
    disabled = _require_enabled()
    if disabled:
        return disabled
    if not _legacy_webui_login_enabled():
        return JSONResponse(
            status_code=403,
            content={"error": "Sign in with your FrogTalk admin account at /app first"},
        )

    # Enforce IP allowlist BEFORE the credential check so a brute-force
    # from outside the allowlist can't even tell whether the username is
    # valid (and can't poke the password-compare timing channel either).
    if not _admin_ip_allowed(request):
        return JSONResponse(status_code=403, content={"error": "Forbidden"})

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

    _user, auth = await _require_frogtalk_admin(request)
    if auth:
        return auth
    return {
        "ok": True,
        "username": _user.get("nickname") or _user.get("display_name") or "",
        "user_id": _user.get("id"),
    }


@router.get("/api/server-admin/stats")
async def server_admin_stats(request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    _user, auth = await _require_frogtalk_admin(request)
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
        "/opt/frogtalk/node/board/board_data",
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "board", "board_data"),
        os.path.join(os.getcwd(), "board", "board_data"),
        "/opt/frogtalk/board/board_data",  # legacy install (pre node/board move)
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
    _user, auth = await _require_frogtalk_admin(request)
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
            peer_url = str(p.get("url") or "")
            peers.append({
                "node_id":       nid,
                "title":         str(p.get("title") or ""),
                "subtitle":      str(p.get("subtitle") or ""),
                "topic":         str(p.get("topic") or ""),
                "url":           peer_url,
                "tor_only":      bool(p.get("tor_only") or False),
                "tor_onion_url": str(p.get("tor_onion_url") or ""),
                "last_seen":     int(p.get("last_seen") or 0),
                "blocked":       bool(nid and nid in blocked_set),
                "tls_insecure":  url_is_http_only_clearnet(peer_url),
                "tls_secure":    url_is_https(peer_url) if peer_url else False,
            })

    url_meta = analyze_public_url()
    return {
        "available": available,
        "data_dir": root,
        "public_url_meta": url_meta,
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
    _user, auth = await _require_frogtalk_admin(request)
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
    _user, auth = await _require_frogtalk_admin(request)
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

    _user, auth = await _require_frogtalk_admin(request)
    if auth:
        return auth

    local_sid = _local_server_id()
    raw_nodes = db.list_federation_servers_admin(include_disabled=bool(include_disabled))
    stale_reasons = _stale_node_reasons(raw_nodes, local_sid)
    nodes = []
    for node in raw_nodes:
        view = _admin_node_view(node)
        sid = str(view.get("server_id") or "").strip()
        view["is_local"] = bool(local_sid and (view.get("server_id") or "") == local_sid)
        view["stale_candidate"] = sid in stale_reasons
        view["stale_reason"] = stale_reasons.get(sid, "")
        nodes.append(view)
    return {"nodes": nodes, "count": len(nodes), "stale_candidates": len(stale_reasons)}


@router.get("/api/server-admin/nodes/{server_id}/probe")
async def server_admin_probe_node(server_id: str, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    _user, auth = await _require_frogtalk_admin(request)
    if auth:
        return auth

    sid, sid_err = _normalize_federation_server_id(server_id)
    if sid_err:
        return sid_err

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
    _redact_ips = False
    err = str(result.get("error") or "")
    stale_hint = ""
    if "redirects not allowed" in err and "301 -> https://" in err and route_mode == "clearnet":
        stale_hint = "HTTP listing redirects to HTTPS; this is usually a stale duplicate row."
    return {
        "ok": True,
        "server_id": sid,
        "display_target": _safe_host_label(target, redact_clearnet_ips=_redact_ips),
        "route_mode": route_mode,
        "transport_label": "Tor onion route" if route_mode == "tor" else "Direct clearnet route",
        "healthy": bool(result.get("ok")),
        "latency_ms": result.get("latency_ms"),
        "error": result.get("error"),
        "stale_hint": stale_hint,
        "is_local": False,
    }


@router.post("/api/server-admin/nodes/{server_id}/block")
async def server_admin_block_node(server_id: str, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    _user, auth = await _require_frogtalk_admin(request)
    if auth:
        return auth

    sid, sid_err = _normalize_federation_server_id(server_id)
    if sid_err:
        return sid_err

    ok = db.set_federation_server_enabled(sid, False)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Node not found"})
    return {"ok": True, "server_id": sid, "blocked": True}


@router.post("/api/server-admin/nodes/{server_id}/unblock")
async def server_admin_unblock_node(server_id: str, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    _user, auth = await _require_frogtalk_admin(request)
    if auth:
        return auth

    sid, sid_err = _normalize_federation_server_id(server_id)
    if sid_err:
        return sid_err

    ok = db.set_federation_server_enabled(sid, True)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Node not found"})
    return {"ok": True, "server_id": sid, "blocked": False}


@router.delete("/api/server-admin/nodes/{server_id}")
@limiter.limit("10/minute")
async def server_admin_delete_node(request: Request, server_id: str):
    disabled = _require_enabled()
    if disabled:
        return disabled

    _user, auth = await _require_frogtalk_admin(request)
    if auth:
        return auth

    sid, sid_err = _normalize_federation_server_id(server_id)
    if sid_err:
        return sid_err

    node = next((n for n in db.list_federation_servers_admin(include_disabled=True) if (n.get("server_id") or "") == sid), None)
    if not node:
        return JSONResponse(status_code=404, content={"error": "Node not found"})

    local_sid = _local_server_id()
    if local_sid and sid == local_sid:
        return JSONResponse(status_code=400, content={"error": "Cannot delete local node"})

    ok = db.delete_federation_server(sid)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Node not found"})
    return {"ok": True, "server_id": sid, "deleted": True}


@router.post("/api/server-admin/nodes/purge-stale")
@limiter.limit("6/minute")
async def server_admin_purge_stale_nodes(body: PurgeStaleNodesBody, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    _user, auth = await _require_frogtalk_admin(request)
    if auth:
        return auth

    local_sid = _local_server_id()
    rows = db.list_federation_servers_admin(include_disabled=True)
    stale = _stale_node_reasons(rows, local_sid)
    candidates = [{"server_id": sid, "reason": reason} for sid, reason in sorted(stale.items())]
    if body.dry_run:
        return {"ok": True, "dry_run": True, "candidates": candidates, "deleted_count": 0}

    deleted: list[str] = []
    for sid in stale.keys():
        try:
            if db.delete_federation_server(sid):
                deleted.append(sid)
        except Exception:
            continue
    return {
        "ok": True,
        "dry_run": False,
        "candidates": candidates,
        "deleted": deleted,
        "deleted_count": len(deleted),
    }


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
    _user, auth = await _require_frogtalk_admin(request)
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
    _user, auth = await _require_frogtalk_admin(request)
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
    _user, auth = await _require_frogtalk_admin(request)
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

    _user, auth = await _require_frogtalk_admin(request)
    if auth:
        return auth

    return {"users": manager.online_users_snapshot()}


@router.post("/api/server-admin/control/sync-official-directory")
async def server_admin_sync_official_directory(request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    _user, auth = await _require_frogtalk_admin(request)
    if auth:
        return auth

    result = await federation_router.sync_official_directory_once()
    if result.get("ok"):
        _pol = db.get_federation_policy_settings()
        if _pol.get("block_tor_peers"):
            result["tor_peers_disabled"] = federation_router.apply_tor_peer_blocks_if_enabled()
        if _pol.get("block_http_only_peers"):
            result["http_peers_disabled"] = federation_router.apply_http_only_peer_blocks_if_enabled()
    if not result.get("ok"):
        return JSONResponse(status_code=400, content=result)
    return result


@router.post("/api/server-admin/control/kick")
async def server_admin_kick(body: ModerationBody, request: Request):
    disabled = _require_enabled()
    if disabled:
        return disabled

    _user, auth = await _require_frogtalk_admin(request)
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

    _user, auth = await _require_frogtalk_admin(request)
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

    _user, auth = await _require_frogtalk_admin(request)
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

    _user, auth = await _require_frogtalk_admin(request)
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

    _user, auth = await _require_frogtalk_admin(request)
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
    _user, auth = await _require_frogtalk_admin(request)
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
    _user, auth = await _require_frogtalk_admin(request)
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
    _user, auth = await _require_frogtalk_admin(request)
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
    _user, auth = await _require_frogtalk_admin(request)
    if auth:
        return auth
    ok = db.delete_bug_report(int(report_id))
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return {"ok": True}
