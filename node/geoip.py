"""Best-effort GeoIP lookup for session metadata and federation region labels.

Uses ipwho.is (free, HTTPS, no auth, generous quota) with a strict timeout
and an in-memory cache. Failures are silent — geo info is purely cosmetic
on the "other device logged in" popup and network server list. We never fail
a login because the geo service is slow or unreachable.

Tor / private / loopback addresses skip the lookup entirely.
"""
from __future__ import annotations

import ipaddress
import json
import logging
import os
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional, Dict

_log = logging.getLogger("geoip")

# 6 h cache so a busy device doesn't hammer the upstream service.
_CACHE_TTL_SECONDS = 6 * 60 * 60
_CACHE_MAX = 2048
_cache: Dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()

_TIMEOUT_SECONDS = 2.5
_DISABLED = (os.getenv("FROGTALK_GEOIP_DISABLED", "0") or "0").strip() in ("1", "true", "yes")


def _is_private_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
        return (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_multicast
            or addr.is_reserved
            or addr.is_unspecified
        )
    except Exception:
        return True


def _cache_get(ip: str) -> Optional[dict]:
    now = time.time()
    with _cache_lock:
        entry = _cache.get(ip)
        if not entry:
            return None
        ts, data = entry
        if now - ts > _CACHE_TTL_SECONDS:
            _cache.pop(ip, None)
            return None
        return data


def _cache_put(ip: str, data: dict) -> None:
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            # Drop the oldest 10% to keep memory bounded.
            items = sorted(_cache.items(), key=lambda kv: kv[1][0])
            for k, _ in items[: max(1, _CACHE_MAX // 10)]:
                _cache.pop(k, None)
        _cache[ip] = (time.time(), data)


def _empty() -> dict:
    return {"country_code": "", "country": "", "city": "", "region": ""}


def format_region_label(info: dict | None) -> str:
    """Human label for network UI, e.g. ``Sydney, Australia``."""
    if not info:
        return ""
    city = str(info.get("city") or "").strip()
    admin = str(info.get("region") or "").strip()
    country = str(info.get("country") or "").strip()
    code = str(info.get("country_code") or "").strip().upper()
    parts: list[str] = []
    if city:
        parts.append(city)
    elif admin:
        parts.append(admin)
    if country:
        parts.append(country)
    elif code:
        parts.append(code)
    return ", ".join(parts)[:120]


def _resolve_host_to_ip(host: str, *, timeout_s: float | None = None) -> str:
    """Resolve hostname to a public IP for GeoIP (ipwho.is requires an IP)."""
    host = (host or "").strip().lower()
    if not host or host.endswith(".onion"):
        return ""
    try:
        ipaddress.ip_address(host)
        return host
    except ValueError:
        pass
    if _is_private_ip(host):
        return ""
    timeout = timeout_s if timeout_s is not None else _TIMEOUT_SECONDS
    prev = socket.getdefaulttimeout()
    try:
        socket.setdefaulttimeout(timeout)
        for _, _, _, _, sockaddr in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM):
            addr = sockaddr[0]
            if isinstance(addr, str) and addr.startswith("::ffff:"):
                addr = addr.rsplit(":", 1)[-1]
            try:
                ip = ipaddress.ip_address(addr)
            except ValueError:
                continue
            if not (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_multicast
                or ip.is_reserved
            ):
                return str(ip)
    except OSError as e:
        _log.debug("dns resolve failed for %s: %s", host, e)
    finally:
        socket.setdefaulttimeout(prev)
    return ""


def lookup(ip_or_host: str) -> dict:
    """Return ``{country_code, country, city, region}``. Empty strings on failure.

    Synchronous and time-boxed; callers should run from a thread when on the
    request hot path.

    HIGH-14: Tor-mode nodes skip GeoIP entirely. Any outbound clearnet
    call from a hidden service ruins the anonymity guarantee, and a
    third-party GeoIP service watching ``frogtalk.xyz`` correlate session
    IPs is exactly the metadata leak Tor mode exists to prevent.
    """
    empty = _empty()
    if _DISABLED or not ip_or_host:
        return empty
    if (os.getenv("FROGTALK_TOR_MODE", "").strip().lower() in ("1", "true", "yes", "on")
            or os.getenv("FROGTALK_TOR_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")):
        return empty
    host = (ip_or_host or "").strip()
    if not host or host.endswith(".onion"):
        return empty
    query_ip = _resolve_host_to_ip(host)
    if not query_ip or _is_private_ip(query_ip):
        return empty
    cached = _cache_get(query_ip)
    if cached is not None:
        return cached
    try:
        req = urllib.request.Request(
            f"https://ipwho.is/{query_ip}?fields=success,country,country_code,city,region",
            headers={"User-Agent": "FrogTalk/1.0 (+geo)"},
        )
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace") or "{}")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        _log.debug("geo lookup failed for %s: %s", query_ip, e)
        _cache_put(query_ip, empty)
        return empty
    if not isinstance(payload, dict) or not payload.get("success"):
        _cache_put(query_ip, empty)
        return empty
    out = {
        "country_code": str(payload.get("country_code") or "").upper()[:4],
        "country": str(payload.get("country") or "")[:96],
        "city": str(payload.get("city") or "")[:96],
        "region": str(payload.get("region") or "")[:96],
    }
    _cache_put(query_ip, out)
    return out


def lookup_base_url(base_url: str) -> dict:
    """GeoIP lookup from a clearnet ``http(s)://`` base URL."""
    empty = _empty()
    url = (base_url or "").strip()
    if not url.startswith(("http://", "https://")):
        return empty
    try:
        host = (urllib.parse.urlparse(url).hostname or "").strip()
    except Exception:
        return empty
    if not host:
        return empty
    return lookup(host)


if __name__ == "__main__":
    import sys

    for arg in sys.argv[1:]:
        info = lookup_base_url(arg) if "://" in arg else lookup(arg)
        print(format_region_label(info) or "(unknown)")
