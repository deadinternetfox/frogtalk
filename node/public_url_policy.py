"""Helpers for clearnet URL / TLS / IP-host detection (server admin, federation, board)."""
from __future__ import annotations

import ipaddress
import os
import urllib.parse


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


def local_public_url() -> str:
    for key in ("PUBLIC_URL", "FROGTALK_BASE_URL"):
        raw = (os.getenv(key) or "").strip().rstrip("/")
        if raw:
            return raw
    return ""


def analyze_public_url(url: str | None = None) -> dict:
    """Metadata for operator warnings (board, server admin, docs)."""
    u = (url if url is not None else local_public_url()).strip().rstrip("/")
    host = hostname_from_url(u)
    is_ip = hostname_is_ip(host)
    is_https = url_is_https(u) if u else False
    is_onion = url_uses_onion(u) if u else False
    is_http_only = url_is_http_only_clearnet(u) if u else False
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
    }
