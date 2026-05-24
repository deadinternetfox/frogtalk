"""Helpers for clearnet URL / TLS / IP-host detection (server admin, federation, board)."""
from __future__ import annotations

import ipaddress
import os
import urllib.parse
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from starlette.requests import Request

OFFICIAL_HUB_URL_DEFAULT = "https://frogtalk.xyz"
SITE_PUBLIC_URL_CONFIG_KEY = "site.public_url"
_LEGACY_KNOWN_HOSTS = frozenset({"frogtalk.xyz", "www.frogtalk.xyz", "frogtalk.app", "www.frogtalk.app"})


def hostname_from_url(url: str) -> str:
    target = (url or "").strip()
    if not target:
        return ""
    try:
        return (urllib.parse.urlparse(target).hostname or "").strip().lower()
    except Exception:
        return ""


def hostname_is_ip(host: str) -> bool:
    h = (host or "").strip()
    if not h:
        return False
    try:
        ipaddress.ip_address(h)
        return True
    except ValueError:
        return False


def url_uses_onion(url: str) -> bool:
    host = hostname_from_url(url)
    return host.endswith(".onion") or ".onion" in host


def url_is_https(url: str) -> bool:
    target = (url or "").strip()
    if not target:
        return False
    try:
        return urllib.parse.urlparse(target).scheme.lower() == "https"
    except Exception:
        return False


def url_is_http_only_clearnet(url: str) -> bool:
    """True for clearnet http:// targets (not .onion, not https://)."""
    target = (url or "").strip()
    if not target or url_uses_onion(target):
        return False
    try:
        return urllib.parse.urlparse(target).scheme.lower() == "http"
    except Exception:
        return False


def normalize_public_url(url: str) -> str:
    """Canonical https/http origin with no trailing slash."""
    raw = (url or "").strip()
    if not raw:
        return ""
    if not raw.startswith(("http://", "https://")):
        raw = f"https://{raw}"
    try:
        p = urllib.parse.urlparse(raw)
        if not p.scheme or not p.hostname:
            return ""
        host = p.hostname.lower()
        if p.port and p.port not in (80, 443):
            host = f"{host}:{p.port}"
        return f"{p.scheme.lower()}://{host}"
    except Exception:
        return ""


def _request_base_url(request: Request | None) -> str:
    if request is None:
        return ""
    try:
        return normalize_public_url(str(request.base_url))
    except Exception:
        return ""


def _env_public_url(*keys: str) -> str:
    for key in keys:
        raw = (os.getenv(key) or "").strip()
        norm = normalize_public_url(raw)
        if norm:
            return norm
    return ""


def resolve_public_site_url(*, request: Request | None = None) -> str:
    """Canonical public URL for share links, OG tags, and invites on this node."""
    try:
        import database as db

        cfg = (db.get_config(SITE_PUBLIC_URL_CONFIG_KEY) or "").strip()
        norm = normalize_public_url(cfg)
        if norm:
            return norm
    except Exception:
        pass

    for candidate in (
        _env_public_url("PUBLIC_URL", "FROGTALK_PUBLIC_URL"),
        _env_public_url("FROGTALK_SITE_URL", "SITE_URL"),
        _env_public_url("FROGTALK_BASE_URL"),
    ):
        if candidate:
            return candidate

    try:
        import database as db

        ident = db.get_or_create_local_server_identity() or {}
        norm = normalize_public_url(str(ident.get("base_url") or ""))
        if norm:
            return norm
    except Exception:
        pass

    req_base = _request_base_url(request)
    if req_base:
        return req_base

    return OFFICIAL_HUB_URL_DEFAULT


def resolve_public_site_host(*, request: Request | None = None) -> str:
    return hostname_from_url(resolve_public_site_url(request=request))


def official_hub_url() -> str:
    return normalize_public_url(
        os.getenv("FROGTALK_OFFICIAL_DIRECTORY_URL", OFFICIAL_HUB_URL_DEFAULT)
    ) or OFFICIAL_HUB_URL_DEFAULT


def public_invite_url(code: str, *, request: Request | None = None) -> str:
    base = resolve_public_site_url(request=request)
    safe = (code or "").strip()
    return f"{base}/i/{urllib.parse.quote(safe, safe='')}"


def public_profile_url(nickname: str, *, request: Request | None = None) -> str:
    base = resolve_public_site_url(request=request)
    nick = (nickname or "").strip()
    return f"{base}/u/{urllib.parse.quote(nick, safe='')}"


def public_channel_url(room_name: str, *, request: Request | None = None) -> str:
    base = resolve_public_site_url(request=request)
    name = (room_name or "").strip()
    return f"{base}/c/{urllib.parse.quote(name, safe='')}"


def public_post_url(post_id: int | str, *, request: Request | None = None) -> str:
    base = resolve_public_site_url(request=request)
    return f"{base}/p/{int(post_id)}"


def public_reel_url(post_id: int | str, *, request: Request | None = None) -> str:
    base = resolve_public_site_url(request=request)
    return f"{base}/r/{int(post_id)}"


def public_static_url(path: str, *, request: Request | None = None) -> str:
    """Absolute URL for a site-relative static asset path."""
    base = resolve_public_site_url(request=request)
    p = (path or "").strip()
    if not p.startswith("/"):
        p = f"/{p}"
    return f"{base}{p}"


def public_og_image_url(kind: str, ident: str, *, request: Request | None = None) -> str:
    base = resolve_public_site_url(request=request)
    safe_kind = (kind or "").strip().lower()
    safe_id = urllib.parse.quote((ident or "").strip(), safe="")
    return f"{base}/og/{safe_kind}/{safe_id}.img"


def local_public_url() -> str:
    """Env-only public URL (used before DB is ready). Prefer resolve_public_site_url()."""
    for key in ("PUBLIC_URL", "FROGTALK_BASE_URL", "FROGTALK_SITE_URL", "SITE_URL"):
        norm = normalize_public_url(os.getenv(key, ""))
        if norm:
            return norm
    return ""


def analyze_public_url(url: str | None = None) -> dict:
    """Metadata for operator warnings (board, server admin, docs)."""
    u = (
        normalize_public_url(url)
        if url is not None
        else resolve_public_site_url()
    )
    host = hostname_from_url(u)
    is_ip = hostname_is_ip(host)
    is_https = url_is_https(u) if u else False
    is_onion = url_uses_onion(u) if u else False
    is_http_only = url_is_http_only_clearnet(u) if u else False
    env_url = local_public_url()
    return {
        "public_url": u,
        "host": host,
        "is_ip_host": is_ip,
        "has_domain": bool(host) and not is_ip and not is_onion,
        "is_https": is_https,
        "is_http_only_clearnet": is_http_only,
        "is_onion": is_onion,
        "show_board_ip_warning": is_ip and not is_onion,
        "recommend_redact_clearnet_ips": is_ip,
        "env_public_url": env_url,
        "configured_in_db": bool(
            _db_site_public_url_raw()
        ),
    }


def _db_site_public_url_raw() -> str:
    try:
        import database as db

        return (db.get_config(SITE_PUBLIC_URL_CONFIG_KEY) or "").strip()
    except Exception:
        return ""


def is_known_frog_host(hostname: str) -> bool:
    host = (hostname or "").strip().lower()
    if not host:
        return False
    if host in _LEGACY_KNOWN_HOSTS:
        return True
    if host.endswith(".frogtalk.xyz") or host.endswith(".frogtalk.app"):
        return True
    local = resolve_public_site_host()
    if local and (host == local or host.endswith(f".{local}")):
        return True
    return False


def substitute_site_url_in_text(text: str, *, request: Request | None = None) -> str:
    """Replace official-hub URLs in static HTML with this node's public URL."""
    base = resolve_public_site_url(request=request)
    if not base or base.rstrip("/") == OFFICIAL_HUB_URL_DEFAULT.rstrip("/"):
        return text
    official = OFFICIAL_HUB_URL_DEFAULT.rstrip("/")
    return text.replace(official, base.rstrip("/")).replace(
        f"{official}/", f"{base.rstrip('/')}/"
    )
