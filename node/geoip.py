"""Best-effort GeoIP lookup for session metadata.

Uses ipwho.is (free, HTTPS, no auth, generous quota) with a strict timeout
and an in-memory cache. Failures are silent — geo info is purely cosmetic
on the "other device logged in" popup. We never fail a login because the
geo service is slow or unreachable.

Tor / private / loopback addresses skip the lookup entirely.
"""
from __future__ import annotations

import ipaddress
import logging
import os
import threading
import time
import urllib.request
import urllib.error
import json
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


def lookup(ip: str) -> dict:
    """Return ``{country_code, country, city}``. Empty strings on failure.

    Synchronous and time-boxed; callers should run from a thread when on the
    request hot path.

    HIGH-14: Tor-mode nodes skip GeoIP entirely. Any outbound clearnet
    call from a hidden service ruins the anonymity guarantee, and a
    third-party GeoIP service watching ``frogtalk.xyz`` correlate session
    IPs is exactly the metadata leak Tor mode exists to prevent.
    """
    empty = {"country_code": "", "country": "", "city": ""}
    if _DISABLED or not ip:
        return empty
    if (os.getenv("FROGTALK_TOR_MODE", "").strip().lower() in ("1", "true", "yes", "on")
            or os.getenv("FROGTALK_TOR_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")):
        return empty
    ip = (ip or "").strip()
    if not ip or _is_private_ip(ip):
        return empty
    cached = _cache_get(ip)
    if cached is not None:
        return cached
    try:
        # ipwho.is returns: success, country, country_code, city, region, ...
        req = urllib.request.Request(
            f"https://ipwho.is/{ip}?fields=success,country,country_code,city",
            headers={"User-Agent": "FrogTalk/1.0 (+geo)"},
        )
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace") or "{}")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        _log.debug("geo lookup failed for %s: %s", ip, e)
        _cache_put(ip, empty)
        return empty
    if not isinstance(payload, dict) or not payload.get("success"):
        _cache_put(ip, empty)
        return empty
    out = {
        "country_code": str(payload.get("country_code") or "").upper()[:4],
        "country": str(payload.get("country") or "")[:96],
        "city": str(payload.get("city") or "")[:96],
    }
    _cache_put(ip, out)
    return out
