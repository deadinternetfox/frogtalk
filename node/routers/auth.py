"""Auth routes: register, login, logout, me."""
import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Optional

_log = logging.getLogger(__name__)
from fastapi import APIRouter, Request, Depends, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from slowapi import Limiter

import database as db
import geoip
from deps import (
    get_current_user,
    client_ip,
    invalidate_token_cache,
    invalidate_request_session_cache,
    pin_mark_unlocked,
    pin_clear_for_token,
    admin_pin_mark_unlocked,
    admin_pin_clear_for_token,
    admin_area_access_status,
    session_token_from_request,
    _pin_session_is_locked,
)
from routers._media_safety import safe_reencode as _media_reencode
from routers._css_inline import sanitize_inline_style as _sanitize_inline_style
from ws_manager import manager

router = APIRouter(prefix="/auth", tags=["auth"])
limiter = Limiter(key_func=client_ip)

NICKNAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{2,32}$")


# ── Per-account login lockout ────────────────────────────────────────────
# HIGH-5: slowapi's `20/hour` limit on `/api/auth/login` is keyed by IP.
# A botnet with even 50 IPs can run 1000 attempts/hour against a single
# nickname. Track failures *per account*: 10 strikes locks for 15 min.
# In-memory only — process restart clears it; restart-as-bypass is
# acceptable because an attacker doesn't get to restart the server.

_LOGIN_LOCKOUT_THRESHOLD = 10
_LOGIN_LOCKOUT_WINDOW = 15 * 60       # seconds — counter horizon
_LOGIN_LOCKOUT_DURATION = 15 * 60     # seconds — actual lockout
_LOGIN_LOCKOUT_MAX = 8192             # cap memory footprint
_FED_BOOT_LOCKOUT_THRESHOLD = 8
_FED_BOOT_LOCKOUT_WINDOW = 12 * 60
_FED_BOOT_LOCKOUT_DURATION = 10 * 60
_FED_BOOT_LOCKOUT_MAX = 8192

_login_state_lock = threading.Lock() if False else None  # placeholder, replaced below
import threading as _threading
_login_state_lock = _threading.Lock()
_login_state: dict[str, dict] = {}
_fed_boot_lock = _threading.Lock()
_fed_boot_state: dict[str, dict] = {}


def _login_record_failure(nick_key: str) -> None:
    """Record a failed login for ``nick_key`` (already lowercased nickname).

    Counters reset after ``_LOGIN_LOCKOUT_WINDOW`` of no activity. Hitting
    ``_LOGIN_LOCKOUT_THRESHOLD`` flips the entry into a "locked" state for
    ``_LOGIN_LOCKOUT_DURATION``; further failures while locked extend the
    lock so a steady attacker can't grind underneath the threshold.
    """
    if not nick_key:
        return
    now = time.time()
    with _login_state_lock:
        st = _login_state.get(nick_key) or {"count": 0, "first": now, "locked_until": 0.0}
        # Reset counter if the previous failure was outside the window.
        if (now - st.get("first", now)) > _LOGIN_LOCKOUT_WINDOW:
            st = {"count": 0, "first": now, "locked_until": 0.0}
        st["count"] = int(st.get("count", 0)) + 1
        if st["count"] >= _LOGIN_LOCKOUT_THRESHOLD:
            st["locked_until"] = max(st.get("locked_until", 0.0), now + _LOGIN_LOCKOUT_DURATION)
        _login_state[nick_key] = st
        if len(_login_state) > _LOGIN_LOCKOUT_MAX:
            stale = sorted(_login_state.items(), key=lambda kv: kv[1].get("first", 0))
            for k, _ in stale[: _LOGIN_LOCKOUT_MAX // 2]:
                _login_state.pop(k, None)


def _login_locked_until(nick_key: str) -> float:
    """Return the unlock time for ``nick_key`` if currently locked, else 0."""
    if not nick_key:
        return 0.0
    now = time.time()
    with _login_state_lock:
        st = _login_state.get(nick_key)
        if not st:
            return 0.0
        if st.get("locked_until", 0.0) <= now:
            # Expired lock — clear so the next failure starts fresh.
            if st.get("locked_until", 0.0):
                st["locked_until"] = 0.0
                st["count"] = 0
                st["first"] = now
            return 0.0
        return float(st["locked_until"])


def _login_clear_failures(nick_key: str) -> None:
    """Drop the counter on successful login."""
    if not nick_key:
        return
    with _login_state_lock:
        _login_state.pop(nick_key, None)


def _federated_bootstrap_record_failure(nick_key: str) -> None:
    """Record explicit bad-credential failures from remote home-node login."""
    if not nick_key:
        return
    now = time.time()
    with _fed_boot_lock:
        st = _fed_boot_state.get(nick_key) or {"count": 0, "first": now, "locked_until": 0.0}
        if (now - st.get("first", now)) > _FED_BOOT_LOCKOUT_WINDOW:
            st = {"count": 0, "first": now, "locked_until": 0.0}
        st["count"] = int(st.get("count", 0)) + 1
        if st["count"] >= _FED_BOOT_LOCKOUT_THRESHOLD:
            st["locked_until"] = max(st.get("locked_until", 0.0), now + _FED_BOOT_LOCKOUT_DURATION)
        _fed_boot_state[nick_key] = st
        if len(_fed_boot_state) > _FED_BOOT_LOCKOUT_MAX:
            stale = sorted(_fed_boot_state.items(), key=lambda kv: kv[1].get("first", 0))
            for k, _ in stale[: _FED_BOOT_LOCKOUT_MAX // 2]:
                _fed_boot_state.pop(k, None)


def _federated_bootstrap_locked_until(nick_key: str) -> float:
    if not nick_key:
        return 0.0
    now = time.time()
    with _fed_boot_lock:
        st = _fed_boot_state.get(nick_key)
        if not st:
            return 0.0
        if st.get("locked_until", 0.0) <= now:
            if st.get("locked_until", 0.0):
                st["locked_until"] = 0.0
                st["count"] = 0
                st["first"] = now
            return 0.0
        return float(st["locked_until"])


def _federated_bootstrap_clear_failures(nick_key: str) -> None:
    if not nick_key:
        return
    with _fed_boot_lock:
        _fed_boot_state.pop(nick_key, None)


def _local_user_exists(nickname: str) -> bool:
    nick = (nickname or "").strip()
    if not nick:
        return False
    try:
        with db._conn() as con:
            row = con.execute(
                "SELECT 1 AS ok FROM users WHERE nickname=? COLLATE NOCASE LIMIT 1",
                (nick,),
            ).fetchone()
        return bool(row)
    except Exception:
        return False

MAX_AVATAR_BYTES = 2 * 1024 * 1024  # 2 MB in base64
FED_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 FrogTalkFederation/1.0"
_ROOM_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
_GID_RE = re.compile(r"^[A-Za-z0-9._:\-]{6,128}$")
_FCM_TOKEN_RE = re.compile(r"^[A-Za-z0-9:_\-.]{16,512}$")
_SYNC_EXPORT_ROOM_LIMIT = 400
_SYNC_EXPORT_DM_LIMIT = 400
_SYNC_EXPORT_BLOCKED_LIMIT = 400
_SYNC_EXPORT_PUBLIC_ROOM_LIMIT = 800
_SYNC_EXPORT_SOCIAL_POST_LIMIT = 160
_SYNC_EXPORT_SOCIAL_MEDIA_MAX = 1_500_000

_sync_state_lock = _threading.Lock()
_federation_sync_state: dict[int, dict] = {}


def _load_user_sync_row(user_id: int) -> dict:
    uid = int(user_id or 0)
    if uid <= 0:
        return {}
    try:
        with db._conn() as con:
            row = con.execute(
                """
                SELECT display_name, avatar, bio, status_msg, presence,
                       wall_enabled, wall_comments_enabled,
                       profile_public, allow_friend_requests,
                       theme, notify_sounds, notify_desktop,
                       notify_dms, notify_mentions,
                       allow_dms_from, show_last_seen,
                       show_read_receipts, hide_active_channels,
                       mood, custom_style, room_order,
                       location_sharing_enabled,
                       pin_hash, pin_require_on_unlock, pin_require_for_admin,
                       pin_require_after_autologin, pin_idle_timeout_sec,
                       pin_keypad_privacy
                FROM users WHERE id=?
                """,
                (uid,),
            ).fetchone()
        return dict(row) if row else {}
    except Exception:
        return {}


def _sanitize_room_order_json(raw: str) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    try:
        arr = json.loads(text)
    except Exception:
        return ""
    if not isinstance(arr, list):
        return ""
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in arr:
        name = str(item or "").strip().lower()
        if not _ROOM_NAME_RE.match(name):
            continue
        if name in seen:
            continue
        seen.add(name)
        cleaned.append(name)
        if len(cleaned) >= 500:
            break
    if not cleaned:
        return ""
    return json.dumps(cleaned, separators=(",", ":"))


def _sanitize_sync_media(media_data, media_type) -> tuple[str | None, str]:
    mt = str(media_type or "").strip().lower()[:64]
    if mt and not re.match(r"^(image|video|audio|music)/[a-z0-9.+-]{1,48}$", mt):
        mt = ""
    if media_data is None:
        return None, mt
    md = str(media_data)
    if len(md) > _SYNC_EXPORT_SOCIAL_MEDIA_MAX:
        return None, mt
    if md.startswith("data:"):
        # Accept only common media data URLs, never text/html/svg/script.
        if not re.match(r"^data:(image|video|audio)/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\n\r]+$", md, re.IGNORECASE):
            return None, mt
    return md, mt


def _norm_base(url: str) -> str:
    raw = (url or "").strip()
    if not raw:
        return ""
    if not raw.startswith("http://") and not raw.startswith("https://"):
        raw = f"https://{raw}"
    return raw.rstrip("/")


def _ssrf_guard(url: str) -> None:
    """Defence-in-depth check before federated outbound HTTP.

    Federation peer URLs come from admin-controlled config, so an
    attacker would need an already-compromised admin account to point
    us at an internal target. Even so, refuse to dial:
      - non http/https schemes (file://, gopher://, ftp://)
      - hosts that resolve to loopback / link-local / RFC 1918 / ULA
      - the .onion namespace UNLESS we're explicitly running in Tor
        mode (federation over Tor is opt-in via FROGTALK_TOR_MODE).

    Raises ValueError on rejection; callers swallow with their existing
    try/except so a bad peer just shows up as a federation failure.
    """
    try:
        parsed = urllib.parse.urlsplit(url or "")
    except Exception as e:
        raise ValueError(f"bad url: {e}")
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"refusing non-http scheme: {parsed.scheme}")
    host = (parsed.hostname or "").strip().lower()
    if not host:
        raise ValueError("missing host")
    # .onion is fine only when we're explicitly operating as a Tor node
    # (the bundle of socks routing is set up elsewhere).
    if host.endswith(".onion"):
        if os.getenv("FROGTALK_TOR_MODE", "").strip().lower() not in ("1", "true", "yes"):
            raise ValueError("onion host without tor mode")
        return
    # Resolve every A/AAAA record and reject if ANY is private/loopback.
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise ValueError(f"dns failure: {e}")
    for fam, _, _, _, sockaddr in infos:
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if (
            ip.is_loopback
            or ip.is_private
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise ValueError(f"refusing private/loopback host: {host} -> {ip_str}")


def _create_session_with_meta(request: Request, user_id: int) -> str:
    """Wrap db.create_session: capture User-Agent + client IP, then kick off
    a background GeoIP lookup so the session row picks up country/city for
    the "active devices" UI without blocking login latency."""
    ua = ""
    ip = ""
    try:
        ua = (request.headers.get("user-agent") or "")[:512]
    except Exception:
        pass
    try:
        ip = client_ip(request) or ""
    except Exception:
        pass
    token = db.create_session(user_id, user_agent=ua, ip_address=ip)
    # PIN-as-2FA: when the user has a PIN and `pin_require_after_autologin`
    # is set, we treat the PIN as a true second factor — every login
    # (including fresh password sign-in) must clear the PIN gate before
    # the session can read messages. We do that by NOT marking the
    # freshly-issued token as unlocked, so the very first /api call
    # returns 423 and the client pops the lock screen.
    #
    # When the flag is off, the password is strictly stronger than the
    # PIN (the PIN is just an idle / shoulder-surfing lock) so we let
    # the session through to avoid double-prompting.
    try:
        status = db.get_pin_status(user_id) or {}
        as_2fa = bool(int(status.get("has_pin") or 0)) and bool(int(status.get("pin_require_after_autologin") or 0))
        if not as_2fa:
            pin_mark_unlocked(token)
    except Exception:
        # Fail-safe: on any error skip the unlock — the user will be
        # asked for their PIN. Erring toward locked is the right side
        # for a security control.
        pass
    if ip:
        async def _lookup_and_save():
            try:
                info = await asyncio.to_thread(geoip.lookup, ip)
                if info and (info.get("country_code") or info.get("country") or info.get("city")):
                    await asyncio.to_thread(
                        db.update_session_geo,
                        token,
                        info.get("country_code", ""),
                        info.get("country", ""),
                        info.get("city", ""),
                    )
            except Exception:
                _log.debug("geoip background lookup failed", exc_info=True)
        try:
            asyncio.create_task(_lookup_and_save())
        except RuntimeError:
            pass
    return token


def _post_json(url: str, body: dict, headers: dict | None = None, timeout: float = 3.5):
    _ssrf_guard(url)
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": FED_UA,
            **(headers or {}),
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — scheme + host validated by _ssrf_guard
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


def _get_json(url: str, headers: dict | None = None, timeout: float = 3.5):
    _ssrf_guard(url)
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": FED_UA,
            **(headers or {}),
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — scheme + host validated by _ssrf_guard
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


def _fed_token_ok(token: str | None) -> bool:
    expected = (os.getenv("FROGTALK_FEDERATION_TOKEN", "") or "").strip()
    if not expected:
        return False
    return hmac.compare_digest((token or "").strip(), expected)


def _sync_state_set(user_id: int, patch: dict) -> None:
    uid = int(user_id or 0)
    if uid <= 0:
        return
    now = int(time.time())
    with _sync_state_lock:
        cur = dict(_federation_sync_state.get(uid) or {})
        cur.update(patch or {})
        cur["updated_at"] = now
        if "started_at" not in cur:
            cur["started_at"] = now
        _federation_sync_state[uid] = cur


def _sync_state_get(user_id: int) -> dict:
    uid = int(user_id or 0)
    if uid <= 0:
        return {"in_progress": False, "done": False, "progress_pct": 0}
    with _sync_state_lock:
        cur = dict(_federation_sync_state.get(uid) or {})
    if not cur:
        return {"in_progress": False, "done": False, "progress_pct": 0}
    if "progress_pct" not in cur:
        cur["progress_pct"] = 100 if cur.get("done") else (50 if cur.get("in_progress") else 0)
    return cur


def _sync_progress(user_id: int, pct: int, hint: str, phase: str = "") -> None:
    uid = int(user_id or 0)
    if uid <= 0:
        return
    _sync_state_set(uid, {
        "in_progress": True,
        "done": False,
        "progress_pct": max(0, min(100, int(pct))),
        "phase": str(phase or "")[:64],
        "hint": str(hint or "")[:220],
    })


def _build_sync_export_for_user(user_id: int) -> dict:
    uid = int(user_id or 0)
    if uid <= 0:
        return {"rooms": [], "dm_peers": [], "source_server_id": ""}
    joined_ids = db.get_user_joined_room_ids(uid)
    rooms: list[dict] = []
    public_rooms: list[dict] = []
    for room in db.list_rooms():
        name = str(room.get("name") or "").strip().lower()
        if not _ROOM_NAME_RE.match(name):
            continue
        rtype = str(room.get("type") or "public").strip().lower()
        if rtype not in ("public", "private"):
            rtype = "public"
        ctype = str(room.get("channel_type") or "text").strip().lower()
        if ctype not in ("text", "music", "voice"):
            ctype = "text"
        room_payload = {
            "name": name,
            "type": rtype,
            "channel_type": ctype,
            "description": str(room.get("description") or "")[:200],
        }
        if rtype == "public" and len(public_rooms) < _SYNC_EXPORT_PUBLIC_ROOM_LIMIT:
            public_rooms.append(room_payload)
        if room.get("id") in joined_ids:
            rooms.append(room_payload)
            if len(rooms) >= _SYNC_EXPORT_ROOM_LIMIT:
                # Keep collecting public room directory even if joined-room cap reached.
                continue

    dm_peers: list[dict] = []
    for ch in db.get_dm_channels(uid):
        other_id = int(ch.get("other_id") or 0)
        if other_id <= 0:
            continue
        peer = db.get_user_by_id(other_id) or {}
        nick = str(peer.get("nickname") or "").strip()
        gid = str(peer.get("global_user_id") or "").strip()
        if not nick or not _GID_RE.match(gid):
            continue
        dm_peers.append({
            "nickname": nick,
            "global_user_id": gid,
            "avatar": peer.get("avatar") or "",
        })
        if len(dm_peers) >= _SYNC_EXPORT_DM_LIMIT:
            break

    try:
        ident = db.get_or_create_local_server_identity() or {}
        source_server_id = str(ident.get("server_id") or "").strip()
    except Exception:
        source_server_id = ""

    following: list[dict] = []
    for row in db.get_following_list(uid, limit=_SYNC_EXPORT_DM_LIMIT):
        raw_id = int((row or {}).get("id") or 0)
        profile = db.get_user_by_id(raw_id) if raw_id > 0 else {}
        gid = str((profile or {}).get("global_user_id") or "").strip()
        nick = str((profile or {}).get("nickname") or (row or {}).get("nickname") or "").strip()
        if not nick or not _GID_RE.match(gid):
            continue
        following.append({
            "nickname": nick,
            "global_user_id": gid,
            "avatar": (profile or {}).get("avatar") or (row or {}).get("avatar") or "",
        })

    friends: list[dict] = []
    for row in db.get_friends(uid):
        raw_id = int((row or {}).get("id") or 0)
        profile = db.get_user_by_id(raw_id) if raw_id > 0 else {}
        gid = str((profile or {}).get("global_user_id") or "").strip()
        nick = str((profile or {}).get("nickname") or (row or {}).get("nickname") or "").strip()
        if not nick or not _GID_RE.match(gid):
            continue
        friends.append({
            "nickname": nick,
            "global_user_id": gid,
            "avatar": (profile or {}).get("avatar") or (row or {}).get("avatar") or "",
        })
        if len(friends) >= _SYNC_EXPORT_DM_LIMIT:
            break

    me = _load_user_sync_row(uid)
    pin_hash = str(me.get("pin_hash") or "").strip()
    if pin_hash and (not pin_hash.startswith("$2") or len(pin_hash) > 200):
        pin_hash = ""
    self_profile = {
        "display_name": str(me.get("display_name") or "")[:64],
        "avatar": me.get("avatar") or "",
        "bio": str(me.get("bio") or "")[:4000],
        "status_msg": str(me.get("status_msg") or "")[:200],
        "presence": str(me.get("presence") or "online")[:32],
        "wall_enabled": 1 if int(me.get("wall_enabled") or 0) else 0,
        "wall_comments_enabled": 1 if int(me.get("wall_comments_enabled") or 0) else 0,
        "profile_public": 1 if int(me.get("profile_public") or 0) else 0,
        "allow_friend_requests": 1 if int(me.get("allow_friend_requests") or 0) else 0,
        "theme": str(me.get("theme") or "frog")[:64],
        "notify_sounds": 1 if int(me.get("notify_sounds") or 0) else 0,
        "notify_desktop": 1 if int(me.get("notify_desktop") or 0) else 0,
        "notify_dms": 1 if int(me.get("notify_dms") or 0) else 0,
        "notify_mentions": 1 if int(me.get("notify_mentions") or 0) else 0,
        "allow_dms_from": str(me.get("allow_dms_from") or "everyone")[:32],
        "show_last_seen": str(me.get("show_last_seen") or "everyone")[:32],
        "show_read_receipts": 1 if int(me.get("show_read_receipts") or 0) else 0,
        "hide_active_channels": 1 if int(me.get("hide_active_channels") or 0) else 0,
        "mood": str(me.get("mood") or "")[:200],
        "custom_style": _sanitize_inline_style(str(me.get("custom_style") or "")[:12000]),
        "room_order": _sanitize_room_order_json(str(me.get("room_order") or "")[:12000]),
        "location_sharing_enabled": 1 if int(me.get("location_sharing_enabled") or 0) else 0,
        "pin_hash": pin_hash,
        "pin_require_on_unlock": 1 if int(me.get("pin_require_on_unlock") or 0) else 0,
        "pin_require_for_admin": 1 if int(me.get("pin_require_for_admin") or 0) else 0,
        "pin_require_after_autologin": 1 if int(me.get("pin_require_after_autologin") or 0) else 0,
        "pin_idle_timeout_sec": max(0, min(86400, int(me.get("pin_idle_timeout_sec") or 300))),
        "pin_keypad_privacy": 1 if int(me.get("pin_keypad_privacy") or 0) else 0,
    }

    push_tokens: list[dict] = []
    for row in db.get_fcm_tokens(uid):
        token = str((row or {}).get("token") or "").strip()
        platform = str((row or {}).get("platform") or "android").strip().lower()
        if platform not in ("android", "ios", "web"):
            platform = "android"
        if not _FCM_TOKEN_RE.match(token):
            continue
        push_tokens.append({"token": token, "platform": platform})
        if len(push_tokens) >= 24:
            break

    blocked_users: list[dict] = []
    for row in db.get_blocked_users(uid):
        blocked_id = int((row or {}).get("user_id") or 0)
        if blocked_id <= 0:
            continue
        blocked_profile = db.get_user_by_id(blocked_id) or {}
        blocked_gid = str(blocked_profile.get("global_user_id") or "").strip()
        blocked_nick = str(blocked_profile.get("nickname") or (row or {}).get("nickname") or "").strip()
        if not blocked_nick or not _GID_RE.match(blocked_gid):
            continue
        blocked_users.append({
            "global_user_id": blocked_gid,
            "nickname": blocked_nick,
        })
        if len(blocked_users) >= _SYNC_EXPORT_BLOCKED_LIMIT:
            break

    social_posts: list[dict] = []
    try:
        feed_rows = db.get_feed_posts(uid, limit=_SYNC_EXPORT_SOCIAL_POST_LIMIT, offset=0, mood="", lite=False)
    except Exception:
        feed_rows = []
    for post in feed_rows[:_SYNC_EXPORT_SOCIAL_POST_LIMIT]:
        try:
            post_id = int(post.get("id") or 0)
        except Exception:
            post_id = 0
        if post_id <= 0:
            continue
        author_id = int(post.get("user_id") or 0)
        if author_id <= 0:
            continue
        author = db.get_user_by_id(author_id) or {}
        author_gid = str(author.get("global_user_id") or "").strip()
        author_nick = str(author.get("nickname") or post.get("nickname") or "").strip()
        if not author_nick or not _GID_RE.match(author_gid):
            continue
        post_gid, post_origin = db.register_local_wall_post_global_id(post_id)
        post_gid = str(post_gid or "").strip()
        if not post_gid:
            continue
        privacy = str(post.get("privacy") or "public").strip().lower()
        if privacy not in ("public", "followers", "friends"):
            privacy = "public"
        media_data, media_type = _sanitize_sync_media(post.get("media_data"), post.get("media_type"))
        social_posts.append({
            "global_post_id": post_gid,
            "origin_server_id": str(post_origin or source_server_id or "").strip(),
            "author_global_user_id": author_gid,
            "nickname": author_nick,
            "content": str(post.get("content") or "")[:4000],
            "media_data": media_data,
            "media_type": media_type,
            "privacy": privacy,
            "share_enabled": 1 if bool(post.get("share_enabled", True)) else 0,
            "allow_comments": 1 if bool(post.get("allow_comments", True)) else 0,
            "track_title": str(post.get("track_title") or "")[:160],
            "track_room": str(post.get("track_room") or "")[:64],
            "track_mood": str(post.get("track_mood") or "")[:32],
        })

    return {
        "rooms": rooms,
        "public_rooms": public_rooms,
        "dm_peers": dm_peers,
        "following": following,
        "friends": friends,
        "blocked_users": blocked_users,
        "social_posts": social_posts,
        "self_profile": self_profile,
        "push_tokens": push_tokens,
        "source_server_id": source_server_id,
        "exported_at": int(time.time()),
    }


def _apply_sync_export_to_user(user_id: int, export: dict) -> dict:
    uid = int(user_id or 0)
    if uid <= 0:
        return {"rooms_joined": 0, "rooms_missing": 0, "dm_linked": 0}

    payload = export if isinstance(export, dict) else {}
    source_server_id = str(payload.get("source_server_id") or "").strip()
    rooms_in = payload.get("rooms")
    public_rooms_in = payload.get("public_rooms")
    dm_in = payload.get("dm_peers")
    following_in = payload.get("following")
    friends_in = payload.get("friends")
    blocked_in = payload.get("blocked_users")
    social_posts_in = payload.get("social_posts")
    self_profile = payload.get("self_profile")
    push_tokens_in = payload.get("push_tokens")
    rooms = rooms_in if isinstance(rooms_in, list) else []
    public_rooms = public_rooms_in if isinstance(public_rooms_in, list) else []
    dm_peers = dm_in if isinstance(dm_in, list) else []
    following = following_in if isinstance(following_in, list) else []
    friends = friends_in if isinstance(friends_in, list) else []
    blocked_users = blocked_in if isinstance(blocked_in, list) else []
    social_posts = social_posts_in if isinstance(social_posts_in, list) else []
    push_tokens = push_tokens_in if isinstance(push_tokens_in, list) else []

    rooms_joined = 0
    rooms_missing = 0
    dm_linked = 0
    following_linked = 0
    friends_linked = 0
    blocked_linked = 0
    push_tokens_linked = 0
    social_posts_imported = 0
    me = db.get_user_by_id(uid) or {}
    my_gid = str(me.get("global_user_id") or "").strip()

    work_units = (
        len(rooms[:_SYNC_EXPORT_ROOM_LIMIT])
        + len(public_rooms[:_SYNC_EXPORT_PUBLIC_ROOM_LIMIT])
        + len(dm_peers[:_SYNC_EXPORT_DM_LIMIT])
        + len(following[:_SYNC_EXPORT_DM_LIMIT])
        + len(friends[:_SYNC_EXPORT_DM_LIMIT])
        + len(blocked_users[:_SYNC_EXPORT_BLOCKED_LIMIT])
        + len(social_posts[:_SYNC_EXPORT_SOCIAL_POST_LIMIT])
        + 2  # profile + push tokens
    )
    done_units = 0

    def _sync_step(phase: str, hint: str) -> None:
        nonlocal done_units
        done_units += 1
        pct = 12 + int(83 * done_units / max(work_units, 1))
        _sync_progress(uid, pct, hint, phase)

    _sync_progress(uid, 12, "Importing your channels…", "channels")

    for raw in rooms[:_SYNC_EXPORT_ROOM_LIMIT]:
        if isinstance(raw, dict):
            name = str(raw.get("name") or "").strip().lower()
            room_type = str(raw.get("type") or "public").strip().lower()
            channel_type = str(raw.get("channel_type") or "text").strip().lower()
        else:
            name = str(raw or "").strip().lower()
            room_type = "public"
            channel_type = "text"
        if not _ROOM_NAME_RE.match(name):
            continue
        if room_type not in ("public", "private"):
            room_type = "public"
        if channel_type not in ("text", "music", "voice"):
            channel_type = "text"
        room = db.get_room_by_name(name)
        if not room:
            # Auto-materialize missing public rooms so account channel state
            # survives first login on a fresh node. Private rooms still require
            # invite/secret flow and are not auto-created here.
            if room_type == "public":
                try:
                    owner = db.get_or_create_federation_system_user()
                    db.create_room(name, "", "public", owner, None, channel_type=channel_type)
                    room = db.get_room_by_name(name)
                except Exception:
                    room = None
            if not room:
                rooms_missing += 1
                continue
        try:
            db.join_room(uid, int(room["id"]))
            rooms_joined += 1
        except Exception:
            continue
        _sync_step("channels", f"Syncing channels… ({rooms_joined} joined)")

    _sync_progress(uid, max(28, 12 + int(83 * done_units / max(work_units, 1))),
                   "Syncing channel directory…", "directory")

    # Mirror public room directory so the destination node can render channels
    # immediately even before regular federation replication catches up.
    for raw in public_rooms[:_SYNC_EXPORT_PUBLIC_ROOM_LIMIT]:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip().lower()
        room_type = str(raw.get("type") or "public").strip().lower()
        channel_type = str(raw.get("channel_type") or "text").strip().lower()
        desc = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(raw.get("description") or ""))[:200]
        if room_type != "public":
            continue
        if not _ROOM_NAME_RE.match(name):
            continue
        if channel_type not in ("text", "music", "voice"):
            channel_type = "text"
        existing = db.get_room_by_name(name)
        if not existing:
            try:
                owner = db.get_or_create_federation_system_user()
                db.create_room(name, desc, "public", owner, None, channel_type=channel_type)
                existing = db.get_room_by_name(name)
            except Exception:
                existing = None
        if not existing:
            continue
        try:
            db.join_room(uid, int(existing["id"]))
        except Exception:
            continue
        _sync_step("directory", "Syncing public channel directory…")

    _sync_progress(uid, max(42, 12 + int(83 * done_units / max(work_units, 1))),
                   "Syncing direct messages…", "dms")

    for item in dm_peers[:_SYNC_EXPORT_DM_LIMIT]:
        if not isinstance(item, dict):
            continue
        gid = str(item.get("global_user_id") or "").strip()
        nick = str(item.get("nickname") or "").strip()
        if not nick or not _GID_RE.match(gid) or (my_gid and gid == my_gid):
            continue
        try:
            peer = db.ensure_federated_dm_local_user(
                gid,
                nick,
                origin_server_id=source_server_id,
                avatar=(item.get("avatar") or ""),
            )
            if not peer:
                continue
            peer_id = int(peer.get("id") or 0)
            if peer_id <= 0 or peer_id == uid:
                continue
            db.get_or_create_dm(uid, peer_id)
            dm_linked += 1
        except Exception:
            continue
        _sync_step("dms", f"Syncing DMs… ({dm_linked} linked)")

    _sync_progress(uid, max(55, 12 + int(83 * done_units / max(work_units, 1))),
                   "Syncing follows and friends…", "social_graph")

    for item in following[:_SYNC_EXPORT_DM_LIMIT]:
        if not isinstance(item, dict):
            continue
        gid = str(item.get("global_user_id") or "").strip()
        nick = str(item.get("nickname") or "").strip()
        if not nick or not _GID_RE.match(gid) or (my_gid and gid == my_gid):
            continue
        try:
            peer = db.ensure_federated_dm_local_user(
                gid,
                nick,
                origin_server_id=source_server_id,
                avatar=(item.get("avatar") or ""),
            )
            if not peer:
                continue
            peer_id = int(peer.get("id") or 0)
            if peer_id <= 0 or peer_id == uid:
                continue
            if db.follow_user(uid, peer_id):
                following_linked += 1
        except Exception:
            continue
        _sync_step("social_graph", "Syncing follows…")

    for item in friends[:_SYNC_EXPORT_DM_LIMIT]:
        if not isinstance(item, dict):
            continue
        gid = str(item.get("global_user_id") or "").strip()
        nick = str(item.get("nickname") or "").strip()
        if not nick or not _GID_RE.match(gid) or (my_gid and gid == my_gid):
            continue
        try:
            peer = db.ensure_federated_dm_local_user(
                gid,
                nick,
                origin_server_id=source_server_id,
                avatar=(item.get("avatar") or ""),
            )
            if not peer:
                continue
            peer_id = int(peer.get("id") or 0)
            if peer_id <= 0 or peer_id == uid:
                continue
            # Rebuild accepted-friends graph idempotently.
            db.send_friend_request(uid, peer_id)
            if db.accept_friend_request(uid, peer_id):
                friends_linked += 1
            db.get_or_create_dm(uid, peer_id)
        except Exception:
            continue
        _sync_step("social_graph", f"Syncing friends… ({friends_linked} linked)")

    for item in blocked_users[:_SYNC_EXPORT_BLOCKED_LIMIT]:
        if not isinstance(item, dict):
            continue
        gid = str(item.get("global_user_id") or "").strip()
        nick = str(item.get("nickname") or "").strip()
        if not nick or not _GID_RE.match(gid) or (my_gid and gid == my_gid):
            continue
        try:
            peer = db.ensure_federated_dm_local_user(
                gid,
                nick,
                origin_server_id=source_server_id,
                avatar="",
            )
            if not peer:
                continue
            peer_id = int(peer.get("id") or 0)
            if peer_id <= 0 or peer_id == uid:
                continue
            if db.block_user(uid, peer_id):
                blocked_linked += 1
        except Exception:
            continue
        _sync_step("social_graph", "Syncing block list…")

    if isinstance(self_profile, dict):
        try:
            display_name = str(self_profile.get("display_name") or "")[:64]
            avatar = self_profile.get("avatar") or ""
            bio = str(self_profile.get("bio") or "")[:4000]
            status_msg = str(self_profile.get("status_msg") or "")[:200]
            presence = str(self_profile.get("presence") or "online").strip().lower()
            if presence not in ("online", "away", "dnd", "invisible"):
                presence = "online"
            wall_enabled = 1 if int(self_profile.get("wall_enabled") or 0) else 0
            wall_comments_enabled = 1 if int(self_profile.get("wall_comments_enabled") or 0) else 0
            profile_public = 1 if int(self_profile.get("profile_public") or 0) else 0
            allow_friend_requests = 1 if int(self_profile.get("allow_friend_requests") or 0) else 0
            theme = str(self_profile.get("theme") or "frog").strip().lower()
            if theme not in ("frog", "light", "midnight", "forest", "cyberpunk", "ocean", "sunset", "rose", "solarized", "mono", "custom"):
                theme = "frog"
            notify_sounds = 1 if int(self_profile.get("notify_sounds") or 0) else 0
            notify_desktop = 1 if int(self_profile.get("notify_desktop") or 0) else 0
            notify_dms = 1 if int(self_profile.get("notify_dms") or 0) else 0
            notify_mentions = 1 if int(self_profile.get("notify_mentions") or 0) else 0
            allow_dms_from = str(self_profile.get("allow_dms_from") or "everyone").strip().lower()
            if allow_dms_from not in ("everyone", "friends", "nobody"):
                allow_dms_from = "everyone"
            show_last_seen = str(self_profile.get("show_last_seen") or "everyone").strip().lower()
            if show_last_seen not in ("everyone", "friends", "nobody"):
                show_last_seen = "everyone"
            show_read_receipts = 1 if int(self_profile.get("show_read_receipts") or 0) else 0
            hide_active_channels = 1 if int(self_profile.get("hide_active_channels") or 0) else 0
            mood = str(self_profile.get("mood") or "")[:200]
            custom_style = _sanitize_inline_style(str(self_profile.get("custom_style") or "")[:12000])
            room_order = _sanitize_room_order_json(str(self_profile.get("room_order") or "")[:12000])
            location_sharing_enabled = 1 if int(self_profile.get("location_sharing_enabled") or 0) else 0
            pin_hash = str(self_profile.get("pin_hash") or "").strip()
            if pin_hash and (not pin_hash.startswith("$2") or len(pin_hash) > 200):
                pin_hash = ""
            pin_require_on_unlock = 1 if int(self_profile.get("pin_require_on_unlock") or 0) else 0
            pin_require_for_admin = 1 if int(self_profile.get("pin_require_for_admin") or 0) else 0
            pin_require_after_autologin = 1 if int(self_profile.get("pin_require_after_autologin") or 0) else 0
            pin_idle_timeout_sec = max(0, min(86400, int(self_profile.get("pin_idle_timeout_sec") or 300)))
            pin_keypad_privacy = 1 if int(self_profile.get("pin_keypad_privacy") or 0) else 0
            with db._conn() as con:
                con.execute(
                    """
                    UPDATE users
                    SET display_name=?,
                        avatar=?,
                        bio=?,
                        status_msg=?,
                        presence=?,
                        wall_enabled=?,
                        wall_comments_enabled=?,
                        profile_public=?,
                        allow_friend_requests=?,
                        theme=?,
                        notify_sounds=?,
                        notify_desktop=?,
                        notify_dms=?,
                        notify_mentions=?,
                        allow_dms_from=?,
                        show_last_seen=?,
                        show_read_receipts=?,
                        hide_active_channels=?,
                        mood=?,
                        custom_style=?,
                        room_order=?,
                        location_sharing_enabled=?,
                        pin_hash=?,
                        pin_require_on_unlock=?,
                        pin_require_for_admin=?,
                        pin_require_after_autologin=?,
                        pin_idle_timeout_sec=?,
                        pin_keypad_privacy=?,
                        pin_failed_attempts=0,
                        pin_locked_until=NULL
                    WHERE id=?
                    """,
                    (
                        display_name,
                        avatar,
                        bio,
                        status_msg,
                        presence,
                        wall_enabled,
                        wall_comments_enabled,
                        profile_public,
                        allow_friend_requests,
                        theme,
                        notify_sounds,
                        notify_desktop,
                        notify_dms,
                        notify_mentions,
                        allow_dms_from,
                        show_last_seen,
                        show_read_receipts,
                        hide_active_channels,
                        mood,
                        custom_style,
                        room_order,
                        location_sharing_enabled,
                        (pin_hash or None),
                        pin_require_on_unlock,
                        pin_require_for_admin,
                        pin_require_after_autologin,
                        pin_idle_timeout_sec,
                        pin_keypad_privacy,
                        uid,
                    ),
                )
                con.commit()
        except Exception:
            pass
    _sync_step("profile", "Syncing profile settings…")

    _sync_progress(uid, max(78, 12 + int(83 * done_units / max(work_units, 1))),
                   "Syncing FrogSocial posts…", "social_posts")

    for row in push_tokens[:24]:
        if not isinstance(row, dict):
            continue
        token = str(row.get("token") or "").strip()
        platform = str(row.get("platform") or "android").strip().lower()
        if platform not in ("android", "ios", "web"):
            platform = "android"
        if not _FCM_TOKEN_RE.match(token):
            continue
        try:
            db.save_fcm_token(uid, token, platform)
            push_tokens_linked += 1
        except Exception:
            continue
    _sync_step("push", "Syncing push tokens…")

    for row in social_posts[:_SYNC_EXPORT_SOCIAL_POST_LIMIT]:
        if not isinstance(row, dict):
            continue
        payload_post = {
            "global_post_id": str(row.get("global_post_id") or "").strip(),
            "author_global_user_id": str(row.get("author_global_user_id") or "").strip(),
            "nickname": str(row.get("nickname") or "").strip(),
            "content": str(row.get("content") or "")[:4000],
            "media_data": row.get("media_data"),
            "media_type": row.get("media_type"),
            "privacy": str(row.get("privacy") or "public").strip().lower(),
            "share_enabled": 1 if bool(row.get("share_enabled", True)) else 0,
            "allow_comments": 1 if bool(row.get("allow_comments", True)) else 0,
            "track_title": str(row.get("track_title") or "")[:160],
            "track_room": str(row.get("track_room") or "")[:64],
            "track_mood": str(row.get("track_mood") or "")[:32],
        }
        payload_post["media_data"], payload_post["media_type"] = _sanitize_sync_media(
            payload_post.get("media_data"),
            payload_post.get("media_type"),
        )
        post_origin = str(row.get("origin_server_id") or source_server_id or "").strip()
        if not post_origin:
            continue
        if not payload_post["global_post_id"] or not payload_post["author_global_user_id"] or not payload_post["nickname"]:
            continue
        try:
            created = db.apply_federated_wall_post_created(payload_post, post_origin)
            if created:
                social_posts_imported += 1
        except Exception:
            continue
        if social_posts_imported and (social_posts_imported % 5 == 0):
            _sync_step("social_posts", f"Syncing FrogSocial… ({social_posts_imported} posts)")

    _sync_progress(uid, 100, "Sync complete", "done")

    return {
        "rooms_joined": rooms_joined,
        "rooms_missing": rooms_missing,
        "dm_linked": dm_linked,
        "following_linked": following_linked,
        "friends_linked": friends_linked,
        "blocked_linked": blocked_linked,
        "push_tokens_linked": push_tokens_linked,
        "social_posts_imported": social_posts_imported,
    }


def _provision_local_user_from_remote(nickname: str, password: str, remote_login: dict, remote_ident: dict | None = None):
    user_id = db.create_user(nickname, password)
    if user_id is None:
        # Do not overwrite an existing local account with a mismatched password.
        return None

    try:
        avatar = remote_login.get("avatar") if isinstance(remote_login, dict) else None
        bio = remote_login.get("bio") if isinstance(remote_login, dict) else None
        if avatar is not None or bio is not None:
            db.update_profile(user_id, avatar=avatar, bio=bio)
    except Exception:
        pass

    try:
        if isinstance(remote_ident, dict):
            gid = str(remote_ident.get("global_user_id") or "").strip()
            ipk = str(remote_ident.get("identity_pubkey") or "").strip()
            with db._conn() as con:
                if gid:
                    con.execute("UPDATE users SET global_user_id=? WHERE id=?", (gid, user_id))
                if ipk:
                    con.execute("UPDATE users SET identity_pubkey=? WHERE id=?", (ipk, user_id))
                con.commit()
    except Exception:
        pass

    db.auto_join_defaults(user_id)
    return db.get_user_by_id(user_id)


def _federated_login_enabled() -> bool:
    return (os.getenv("FROGTALK_FEDERATED_LOGIN_ENABLED", "1") or "1").strip().lower() in ("1", "true", "yes")


def _federated_register_enabled() -> bool:
    return (os.getenv("FROGTALK_FEDERATED_REGISTER_ENABLED", "1") or "1").strip().lower() in ("1", "true", "yes")


def _signups_mode() -> str:
    """open = legacy /register enabled; secure = require captcha (default); invite = require valid invite code."""
    return (os.getenv("SIGNUPS_OPEN", "secure") or "secure").strip().lower()


def _federation_legacy_plaintext_enabled() -> bool:
    """Rollback flag: when 0 (default), federated-login-bootstrap is disabled
    so plaintext passwords never leave this node during /auth/login."""
    return (os.getenv("FEDERATION_LEGACY_PLAINTEXT", "0") or "0").strip().lower() in ("1", "true", "yes", "on")


def _federated_login_bootstrap_enabled() -> bool:
    """Allow password login to import account from a peer when missing locally.

    This verifies credentials against known federation peers over HTTPS and
    provisions the local account. Disable with FROGTALK_FEDERATED_LOGIN_BOOTSTRAP=0.
    """
    if not _federated_login_enabled():
        return False
    if _federation_legacy_plaintext_enabled():
        return True
    return (os.getenv("FROGTALK_FEDERATED_LOGIN_BOOTSTRAP", "1") or "1").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _tor_mode_enabled() -> bool:
    # HIGH-14: equivalence between TOR_ENABLED and TOR_MODE
    v1 = (os.getenv("FROGTALK_TOR_ENABLED", "") or "").strip().lower()
    v2 = (os.getenv("FROGTALK_TOR_MODE", "") or "").strip().lower()
    return any(v in ("1", "true", "yes", "on") for v in (v1, v2))


def _peer_target(row: dict) -> str:
    base = _norm_base(str(row.get("base_url") or ""))
    onion = _norm_base(str(row.get("onion_url") or ""))
    transport = str(row.get("transport_preference") or "auto").strip().lower()
    if transport == "onion" and onion:
        return onion
    if transport == "clearnet" and base:
        return base
    if _tor_mode_enabled() and onion:
        return onion
    return base or onion


def _local_known_urls(request: Request) -> set[str]:
    urls = {
        _norm_base(str(request.base_url)),
        _norm_base(os.getenv("PUBLIC_URL", "")),
        _norm_base(os.getenv("FROGTALK_BASE_URL", "")),
        _norm_base(os.getenv("FROGTALK_PUBLIC_URL", "")),
    }
    if _tor_mode_enabled():
        urls.add(_norm_base(os.getenv("FROGTALK_ONION_URL", "")))
    return {u for u in urls if u}


def _build_provision_ticket(user_id: int, nickname: str, password_hash: str, ttl_seconds: int = 120) -> str | None:
    """Build an HMAC-signed federation provisioning ticket carrying the bcrypt
    hash so we never transmit a plaintext password between peers."""
    secret = _fed_session_secret()
    if not secret:
        return None
    ident = db.get_user_by_id(user_id) or {}
    now = int(time.time())
    payload = {
        "v": 1,
        "kind": "provision",
        "iat": now,
        "exp": now + max(30, min(int(ttl_seconds or 120), 600)),
        "nickname": str(nickname or "").strip(),
        "password_hash": str(password_hash or ""),
        "global_user_id": str(ident.get("global_user_id") or "").strip(),
        "identity_pubkey": str(ident.get("identity_pubkey") or "").strip(),
        "avatar": ident.get("avatar") or "",
        "bio": ident.get("bio") or "",
    }
    payload_bytes = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    return f"{_b64url_encode(payload_bytes)}.{_b64url_encode(sig)}"


def _verify_provision_ticket(ticket: str) -> dict | None:
    secret = _fed_session_secret()
    if not secret:
        return None
    raw = str(ticket or "").strip()
    if "." not in raw:
        return None
    p_b64, s_b64 = raw.split(".", 1)
    try:
        payload_bytes = _b64url_decode(p_b64)
        sig = _b64url_decode(s_b64)
    except Exception:
        return None
    if not payload_bytes or not sig:
        return None
    expect = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    if not hmac.compare_digest(expect, sig):
        return None
    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except Exception:
        return None
    if str(payload.get("kind") or "") != "provision":
        return None
    if int(payload.get("exp") or 0) < int(time.time()):
        return None
    if not str(payload.get("nickname") or "").strip():
        return None
    if not str(payload.get("password_hash") or "").strip():
        return None
    return payload


async def _fanout_registration_to_peers(request: Request, user_id: int, nickname: str, password: str):
    """Best-effort registration replication so account exists across nodes.

    Default path: HMAC-signed provisioning ticket carrying the bcrypt hash so
    plaintext passwords never leave this node. Legacy plaintext path is gated
    on FEDERATION_LEGACY_PLAINTEXT for emergency rollback only."""
    if not _federated_register_enabled():
        return

    own = _local_known_urls(request)

    peers = []
    for row in db.list_federation_servers(official_only=False):
        base = _peer_target(row)
        if not base or base in own:
            continue
        peers.append((base.endswith(".onion") or ".onion/" in base, base.startswith("https://"), int(row.get("official") or 0), base))
    peers.sort(reverse=True)

    pw_hash = db.get_user_password_hash(user_id) or ""
    ticket = _build_provision_ticket(user_id, nickname, pw_hash) if pw_hash else None
    legacy = _federation_legacy_plaintext_enabled()

    for _, __, ___, base in peers[:12]:
        try:
            if ticket:
                await asyncio.to_thread(
                    _post_json,
                    f"{base}/api/auth/federation-provision",
                    {"ticket": ticket},
                    {"X-Federation-Relay": "1"},
                    4.5,
                )
                continue
            if legacy:
                await asyncio.to_thread(
                    _post_json,
                    f"{base}/api/auth/register",
                    {"nickname": nickname, "password": password},
                    {"X-Federation-Relay": "1"},
                    4.5,
                )
        except urllib.error.HTTPError as e:
            # 409 means account already exists there; keep going.
            if int(getattr(e, "code", 0) or 0) in (400, 401, 403, 404, 409):
                continue
        except Exception:
            continue


def _login_against_peer(base_url: str, nickname: str, password: str):
    login = _post_json(f"{base_url}/api/auth/login", {"nickname": nickname, "password": password})
    token = str(login.get("token") or "")
    if not token:
        return None, None
    ident = None
    try:
        ident = _get_json(f"{base_url}/api/identity/me", headers={"X-Session-Token": token})
    except Exception:
        ident = None
    return login, ident


def _fetch_sync_export_via_session(base_url: str, token: str) -> dict | None:
    tok = str(token or "").strip()
    if not tok:
        return None
    try:
        data = _get_json(f"{base_url}/api/auth/federation-sync-export", headers={"X-Session-Token": tok}, timeout=5.5)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _fetch_sync_export_via_ticket(base_url: str, ticket: str) -> dict | None:
    fed = (os.getenv("FROGTALK_FEDERATION_TOKEN", "") or "").strip()
    if not fed:
        return None
    raw_ticket = str(ticket or "").strip()
    if not raw_ticket:
        return None
    try:
        data = _post_json(
            f"{base_url}/api/auth/federation-sync-export-ticket",
            {"ticket": raw_ticket},
            headers={"X-Federation-Token": fed},
            timeout=5.5,
        )
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _fetch_sync_export_via_federation_gid(base_url: str, global_user_id: str) -> dict | None:
    fed = (os.getenv("FROGTALK_FEDERATION_TOKEN", "") or "").strip()
    gid = str(global_user_id or "").strip()
    if not fed or not gid or not _GID_RE.match(gid):
        return None
    source = _norm_base(base_url)
    if not source:
        return None
    try:
        data = _post_json(
            f"{source}/api/auth/federation-sync-export-gid",
            {"global_user_id": gid},
            headers={"X-Federation-Token": fed},
            timeout=8.0,
        )
    except Exception:
        return None
    return data if isinstance(data, dict) else None


async def _sync_user_from_peer_gid(user_id: int, source_base: str, global_user_id: str) -> None:
    uid = int(user_id or 0)
    source = _norm_base(source_base)
    gid = str(global_user_id or "").strip()
    if uid <= 0 or not source or not gid:
        return
    _sync_state_set(uid, {
        "source_base": source,
        "in_progress": True,
        "done": False,
        "error": "",
        "progress_pct": 3,
        "phase": "fetch",
        "hint": "Fetching account data from your home node…",
    })
    try:
        export = await asyncio.to_thread(_fetch_sync_export_via_federation_gid, source, gid)
        if not isinstance(export, dict):
            raise ValueError("export_unavailable")
        _sync_progress(uid, 8, "Applying synced data…", "apply")
        applied = await asyncio.to_thread(_apply_sync_export_to_user, uid, export)
        _sync_state_set(uid, {
            "in_progress": False,
            "done": True,
            "error": "",
            "progress_pct": 100,
            "phase": "done",
            "hint": "Sync complete",
            "finished_at": int(time.time()),
            **(applied or {}),
        })
    except Exception as e:
        _sync_state_set(uid, {
            "in_progress": False,
            "done": True,
            "error": str(e)[:200],
            "finished_at": int(time.time()),
            "rooms_joined": 0,
            "rooms_missing": 0,
            "dm_linked": 0,
        })


async def _sync_user_from_peer_session(user_id: int, source_base: str, remote_token: str) -> None:
    uid = int(user_id or 0)
    source = _norm_base(source_base)
    tok = str(remote_token or "").strip()
    if uid <= 0 or not source or not tok:
        return
    _sync_state_set(uid, {
        "source_base": source,
        "in_progress": True,
        "done": False,
        "error": "",
        "progress_pct": 3,
        "phase": "fetch",
        "hint": "Fetching account data from your home node…",
    })
    try:
        export = await asyncio.to_thread(_fetch_sync_export_via_session, source, tok)
        if not isinstance(export, dict):
            raise ValueError("export_unavailable")
        _sync_progress(uid, 8, "Applying synced data…", "apply")
        applied = await asyncio.to_thread(_apply_sync_export_to_user, uid, export)
        _sync_state_set(uid, {
            "in_progress": False,
            "done": True,
            "error": "",
            "progress_pct": 100,
            "phase": "done",
            "hint": "Sync complete",
            "finished_at": int(time.time()),
            **(applied or {}),
        })
    except Exception as e:
        _sync_state_set(uid, {
            "in_progress": False,
            "done": True,
            "error": str(e)[:200],
            "finished_at": int(time.time()),
            "rooms_joined": 0,
            "rooms_missing": 0,
            "dm_linked": 0,
        })


async def _sync_user_from_peer_ticket(user_id: int, source_base: str, ticket: str) -> None:
    uid = int(user_id or 0)
    source = _norm_base(source_base)
    raw_ticket = str(ticket or "").strip()
    if uid <= 0 or not source or not raw_ticket:
        return
    _sync_state_set(uid, {
        "source_base": source,
        "in_progress": True,
        "done": False,
        "error": "",
        "progress_pct": 3,
        "phase": "fetch",
        "hint": "Fetching account data from your home node…",
    })
    try:
        export = await asyncio.to_thread(_fetch_sync_export_via_ticket, source, raw_ticket)
        if not isinstance(export, dict):
            raise ValueError("export_unavailable")
        _sync_progress(uid, 8, "Applying synced data…", "apply")
        applied = await asyncio.to_thread(_apply_sync_export_to_user, uid, export)
        _sync_state_set(uid, {
            "in_progress": False,
            "done": True,
            "error": "",
            "progress_pct": 100,
            "phase": "done",
            "hint": "Sync complete",
            "finished_at": int(time.time()),
            **(applied or {}),
        })
    except Exception as e:
        _sync_state_set(uid, {
            "in_progress": False,
            "done": True,
            "error": str(e)[:200],
            "finished_at": int(time.time()),
            "rooms_joined": 0,
            "rooms_missing": 0,
            "dm_linked": 0,
        })


async def _try_federated_login_bootstrap(request: Request, nickname: str, password: str):
    if not _federated_login_enabled():
        return None

    own = _local_known_urls(request)

    candidates = []
    for row in db.list_federation_servers(official_only=False):
        base = _peer_target(row)
        if not base or base in own:
            continue
        candidates.append((base.endswith(".onion") or ".onion/" in base, base.startswith("https://"), int(row.get("official") or 0), base))

    # Prefer the current transport mode, then official entries.
    candidates.sort(reverse=True)

    saw_peer_rate_limit = False
    saw_bad_creds = False
    saw_transport_error = False
    for _, __, ___, base in candidates[:8]:
        try:
            remote_login, remote_ident = await asyncio.to_thread(_login_against_peer, base, nickname, password)
            if not remote_login:
                continue
            local_user = _provision_local_user_from_remote(nickname, password, remote_login, remote_ident)
            if not local_user:
                continue
            return {
                "user": local_user,
                "remote_base": base,
                "remote_token": str(remote_login.get("token") or "").strip(),
                "status": "ok",
            }
        except urllib.error.HTTPError as e:
            code = int(getattr(e, "code", 0) or 0)
            if code == 429:
                saw_peer_rate_limit = True
            elif code in (400, 401, 403):
                saw_bad_creds = True
            else:
                saw_transport_error = True
            continue
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            saw_transport_error = True
            continue
        except Exception:
            saw_transport_error = True
            continue
    if saw_peer_rate_limit:
        return {"status": "rate_limited"}
    if saw_bad_creds:
        return {"status": "invalid_credentials"}
    if saw_transport_error:
        return {"status": "transport_error"}
    return None


class RegisterRequest(BaseModel):
    nickname: str = Field(min_length=1, max_length=64)
    # Cap the password length so we don't feed multi-megabyte strings
    # into bcrypt (each hash is O(n) in the input length and bcrypt is
    # intentionally slow). 128 bytes is comfortably more than any real
    # password and matches OWASP guidance.
    password: str = Field(min_length=1, max_length=128)


class LoginRequest(BaseModel):
    nickname: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class FederationTicketRequest(BaseModel):
    target_base_url: str | None = Field(default=None, max_length=512)
    target_url: str | None = Field(default=None, max_length=512)


class FederationTicketLoginRequest(BaseModel):
    ticket: str = Field(min_length=1, max_length=8192)


class FederationSyncExportTicketRequest(BaseModel):
    ticket: str = Field(min_length=1, max_length=8192)


class FederationSyncExportGidRequest(BaseModel):
    global_user_id: str = Field(min_length=1, max_length=128)


class FederationSyncResumeRequest(BaseModel):
    source_base: str | None = Field(default=None, max_length=512)
    ticket: str | None = Field(default=None, max_length=8192)


class ProfileUpdateRequest(BaseModel):
    # Avatar/banner are accepted as data URLs or http(s) URLs. Cap at a
    # generous ceiling so the request body itself can't be used as a
    # cheap memory-pressure vector before validation runs.
    avatar: str | None = Field(default=None, max_length=10_000_000)
    banner: str | None = Field(default=None, max_length=20_000_000)
    bio: str | None = Field(default=None, max_length=4_000)
    new_password: str | None = Field(default=None, max_length=128)
    current_password: str | None = Field(default=None, max_length=128)
    status_msg: str | None = Field(default=None, max_length=200)
    presence: str | None = Field(default=None, max_length=32)
    profile_public: bool | None = None
    allow_friend_requests: bool | None = None
    # New settings fields
    theme: str | None = Field(default=None, max_length=64)
    notify_sounds: bool | None = None
    notify_desktop: bool | None = None
    notify_dms: bool | None = None
    notify_mentions: bool | None = None
    allow_dms_from: str | None = Field(default=None, max_length=32)
    show_last_seen: str | None = Field(default=None, max_length=32)
    show_read_receipts: bool | None = None
    hide_active_channels: bool | None = None


def _fed_session_secret() -> str:
    return (
        os.getenv("FROGTALK_FEDERATION_TOKEN", "").strip()
        or os.getenv("FROGTALK_SESSION_SECRET", "").strip()
    )


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    raw = str(data or "").strip()
    if not raw:
        return b""
    pad = "=" * ((4 - (len(raw) % 4)) % 4)
    return base64.urlsafe_b64decode((raw + pad).encode("ascii"))


def _build_federation_login_ticket(user: dict, source_base_url: str, target_base_url: str, ttl_seconds: int = 90) -> str | None:
    secret = _fed_session_secret()
    if not secret:
        return None
    now = int(time.time())
    payload = {
        "v": 1,
        "iat": now,
        "exp": now + max(15, min(int(ttl_seconds or 90), 300)),
        "src": _norm_base(source_base_url),
        "dst": _norm_base(target_base_url),
        "nickname": str(user.get("nickname") or "").strip(),
        "global_user_id": str(user.get("global_user_id") or "").strip(),
        "avatar": user.get("avatar") or "",
        "bio": user.get("bio") or "",
    }
    payload_bytes = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    return f"{_b64url_encode(payload_bytes)}.{_b64url_encode(sig)}"


def _verify_federation_login_ticket(ticket: str, this_base_url: str) -> dict | None:
    secret = _fed_session_secret()
    if not secret:
        return None
    raw = str(ticket or "").strip()
    if "." not in raw:
        return None
    p_b64, s_b64 = raw.split(".", 1)
    try:
        payload_bytes = _b64url_decode(p_b64)
        sig = _b64url_decode(s_b64)
    except Exception:
        return None
    if not payload_bytes or not sig:
        return None
    expect = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    if not hmac.compare_digest(expect, sig):
        return None
    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except Exception:
        return None
    now = int(time.time())
    if int(payload.get("exp") or 0) < now:
        return None
    dst = _norm_base(str(payload.get("dst") or ""))
    me = _norm_base(this_base_url)
    if dst and me and dst != me:
        return None
    nick = str(payload.get("nickname") or "").strip()
    if not nick:
        return None
    return payload


def _verify_federation_login_ticket_for_source(ticket: str, this_base_url: str) -> dict | None:
    """Validate a switch ticket on its source node for state export."""
    secret = _fed_session_secret()
    if not secret:
        return None
    raw = str(ticket or "").strip()
    if "." not in raw:
        return None
    p_b64, s_b64 = raw.split(".", 1)
    try:
        payload_bytes = _b64url_decode(p_b64)
        sig = _b64url_decode(s_b64)
    except Exception:
        return None
    if not payload_bytes or not sig:
        return None
    expect = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    if not hmac.compare_digest(expect, sig):
        return None
    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except Exception:
        return None
    now = int(time.time())
    if int(payload.get("exp") or 0) < now:
        return None
    src = _norm_base(str(payload.get("src") or ""))
    me = _norm_base(this_base_url)
    if src and me and src != me:
        return None
    if not str(payload.get("nickname") or "").strip():
        return None
    return payload


def _ensure_local_user_from_ticket(payload: dict) -> dict | None:
    nick = str(payload.get("nickname") or "").strip()
    if not nick:
        return None
    user = db.get_user_by_nick(nick)
    if not user:
        uid = db.create_user(nick, secrets.token_urlsafe(24))
        if uid is None:
            user = db.get_user_by_nick(nick)
        else:
            user = db.get_user_by_id(uid)
            try:
                db.auto_join_defaults(uid)
            except Exception:
                pass
    if not user:
        return None

    try:
        with db._conn() as con:
            gid = str(payload.get("global_user_id") or "").strip()
            avatar = payload.get("avatar")
            bio = payload.get("bio")
            if gid:
                con.execute("UPDATE users SET global_user_id=? WHERE id=?", (gid, user["id"]))
            if avatar is not None:
                con.execute("UPDATE users SET avatar=? WHERE id=?", (avatar, user["id"]))
            if bio is not None:
                con.execute("UPDATE users SET bio=? WHERE id=?", (bio, user["id"]))
            con.commit()
    except Exception:
        pass
    return db.get_user_by_id(user["id"]) or user


@router.post("/register")
@limiter.limit("3/hour")
async def register(
    request: Request,
    body: RegisterRequest,
    x_federation_relay: str | None = Header(default=None),
):
    # Gate the legacy plaintext-password registration route. Default mode
    # "secure" forces clients to use /register-secure (CAPTCHA-protected) and
    # blocks bot account farming.
    #
    # SECURITY: we used to honour `X-Federation-Relay: 1` as a CAPTCHA bypass
    # for "federation peers replicating accounts", but the header was
    # unauthenticated — any bot could set it and farm accounts. Federation
    # replication now MUST use /federation-provision (HMAC-signed ticket);
    # the legacy plaintext-relay path is therefore disabled unless the
    # operator also flips FEDERATION_LEGACY_PLAINTEXT=1 explicitly.
    is_relay = (x_federation_relay or "").strip() == "1" and _federation_legacy_plaintext_enabled()
    if not is_relay and _signups_mode() != "open":
        return JSONResponse(status_code=403, content={"error": "Registration is closed; use /api/auth/register-secure"})
    if not NICKNAME_RE.match(body.nickname):
        return JSONResponse(status_code=400, content={
            "error": "Nickname must be 2-32 characters: letters, numbers, _ or -"
        })
    if len(body.password) < 6:
        return JSONResponse(status_code=400, content={"error": "Password must be at least 6 characters"})
    user_id = db.create_user(body.nickname, body.password, registration_ip=client_ip(request))
    if user_id is None:
        # Username taken (or another integrity error). Surface a few
        # available alternatives so the client can offer one-click
        # accept on the signup form.
        suggestions = db.suggest_available_usernames(body.nickname, count=5)
        return JSONResponse(status_code=409, content={
            "error": "That username is already taken",
            "suggestions": suggestions,
        })
    db.auto_join_defaults(user_id)
    try:
        ident = db.get_user_by_id(user_id) or {}
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "user.created",
            "payload": {
                "global_user_id": ident.get("global_user_id") or "",
                "nickname": ident.get("nickname") or body.nickname,
                "avatar": ident.get("avatar") or "",
                "bio": ident.get("bio") or "",
                "identity_pubkey": ident.get("identity_pubkey") or "",
            },
        })
    except Exception:
        _log.exception("register: federation outbox insert failed")
    if (x_federation_relay or "").strip() != "1":
        try:
            await _fanout_registration_to_peers(request, user_id, body.nickname, body.password)
        except Exception:
            _log.exception("register: peer fanout failed")
    token = _create_session_with_meta(request, user_id)
    payload = _auth_session_response(user_id, token)
    resp = JSONResponse(content=payload)
    _attach_session_cookies(resp, request, token)
    return resp


@router.post("/login")
@limiter.limit("20/hour")
async def login(request: Request, body: LoginRequest):
    # HIGH-5: per-account lockout. The 20/hour slowapi limit is keyed by
    # IP, so a botnet can comfortably grind a single account from 1000
    # different addresses. Track failures per nickname and lock for a
    # cooling-off window after _LOGIN_LOCKOUT_THRESHOLD consecutive bad
    # passwords. Successful login clears the counter.
    nick_key = (body.nickname or "").strip().lower()
    local_exists = _local_user_exists(body.nickname)
    if nick_key:
        locked_until = _login_locked_until(nick_key)
        if locked_until and local_exists:
            wait = int(max(1, locked_until - time.time()))
            return JSONResponse(
                status_code=429,
                content={
                    "error": "Too many failed attempts. Try again later.",
                    "retry_after_seconds": wait,
                },
                headers={"Retry-After": str(wait)},
            )
        fed_locked_until = _federated_bootstrap_locked_until(nick_key)
        if fed_locked_until and not local_exists and _federated_login_bootstrap_enabled():
            wait = int(max(1, fed_locked_until - time.time()))
            return JSONResponse(
                status_code=429,
                content={
                    "error": "Too many cross-node login attempts. Try again shortly.",
                    "code": "federation_login_temporarily_locked",
                    "retry_after_seconds": wait,
                },
                headers={"Retry-After": str(wait)},
            )
    # bcrypt.checkpw is CPU-bound (50–300 ms). Running it directly inside an
    # async route blocks the single uvicorn event loop for that whole window,
    # which is what made the very first /api/auth/me + /api/auth/login feel
    # like the server was "hanging" right after page load. Push it into a
    # worker thread so other requests keep flowing while bcrypt runs.
    user = await asyncio.to_thread(db.verify_user, body.nickname, body.password)
    boot = None
    if not user:
        # Federated bootstrap: if credentials are valid on a known peer,
        # provision the local account so first login on a new node works.
        if (not local_exists) and _federated_login_bootstrap_enabled():
            boot = await _try_federated_login_bootstrap(request, body.nickname, body.password)
        status = str((boot or {}).get("status") or "").strip().lower() if isinstance(boot, dict) else ""
        if status == "rate_limited":
            return JSONResponse(
                status_code=429,
                content={
                    "error": "Home node is rate limiting login right now. Wait a moment and retry.",
                    "code": "federation_home_rate_limited",
                    "hint": "Try again shortly, or sign in directly on your home node and switch back.",
                    "retry_after_seconds": 60,
                },
                headers={"Retry-After": "60"},
            )
        if status == "transport_error":
            return JSONResponse(
                status_code=503,
                content={
                    "error": "Could not reach your home node right now.",
                    "code": "federation_home_unreachable",
                    "hint": "Retry in a moment. This does not count as a failed password attempt.",
                },
            )
        if status == "invalid_credentials":
            if nick_key:
                _federated_bootstrap_record_failure(nick_key)
            return JSONResponse(
                status_code=401,
                content={
                    "error": "Invalid nickname or password.",
                    "code": "invalid_credentials",
                },
            )
        if not boot:
            if nick_key:
                if local_exists:
                    _login_record_failure(nick_key)
            return JSONResponse(
                status_code=401,
                content={
                    "error": "Invalid nickname or password for this node.",
                    "code": "account_not_on_node",
                    "hint": (
                        "Accounts are per-node unless provisioned. Register here, "
                        "or log in on your home node and use Settings → Network to switch."
                    ),
                },
            )
        user = boot["user"]
    # Node-level ban check: reject the login with a polished, informative
    # payload so the client can render a proper "banned from this node"
    # screen instead of dropping the user onto the main app where the
    # WS would just disconnect them. We expose reason + expires_at
    # because the user already knows they were banned (server admin
    # told them); leaking the existence of a ban here is fine and helps
    # them appeal it.
    try:
        ban = db.get_active_global_ban(user["id"])
    except Exception:
        ban = None
    if ban:
        banner = db.get_user_by_id(ban.get("banned_by")) if ban.get("banned_by") else None
        return JSONResponse(status_code=403, content={
            "error": "This account has been banned from this node.",
            "code": "node_banned",
            "reason": (ban.get("reason") or "")[:500],
            "expires_at": ban.get("expires_at"),
            "banned_by": (banner or {}).get("nickname"),
        })
    if nick_key:
        _login_clear_failures(nick_key)
        _federated_bootstrap_clear_failures(nick_key)
    token = _create_session_with_meta(request, user["id"])
    sync_meta = None
    if isinstance(boot, dict):
        source_base = _norm_base(str(boot.get("remote_base") or ""))
        remote_token = str(boot.get("remote_token") or "").strip()
        if source_base and remote_token:
            _sync_state_set(user["id"], {
                "source_base": source_base,
                "in_progress": True,
                "done": False,
                "error": "",
                "progress_pct": 2,
                "phase": "fetch",
                "hint": "Syncing channels and DMs from your home node…",
            })
            try:
                asyncio.create_task(_sync_user_from_peer_session(user["id"], source_base, remote_token))
            except Exception:
                _log.exception("federation sync: failed to start peer-session task")
            sync_meta = {
                "in_progress": True,
                "source_base": source_base,
                "progress_pct": 2,
                "phase": "fetch",
                "hint": "Syncing channels and DMs from your home node…",
            }
    payload = _auth_session_response(user["id"], token, sync_meta=sync_meta)
    resp = JSONResponse(content=payload)
    _attach_session_cookies(resp, request, token)
    return resp


async def _start_federation_sync_for_user(
    user_id: int,
    *,
    source_base: str = "",
    ticket: str = "",
    global_user_id: str = "",
    here_base: str = "",
) -> dict:
    uid = int(user_id or 0)
    if uid <= 0:
        return {"in_progress": False, "done": False, "error": "invalid user"}
    cur = _sync_state_get(uid)
    if cur.get("in_progress"):
        return cur
    source = _norm_base(source_base)
    raw_ticket = str(ticket or "").strip()
    gid = str(global_user_id or "").strip()
    if not gid:
        me = db.get_user_by_id(uid) or {}
        gid = str(me.get("global_user_id") or "").strip()
    if raw_ticket and not source and here_base:
        payload = _verify_federation_login_ticket(raw_ticket, here_base)
        if isinstance(payload, dict):
            source = _norm_base(str(payload.get("src") or ""))
    if not source:
        return {"in_progress": False, "done": False, "error": "missing source node"}
    here = _norm_base(here_base)
    if here and source == here:
        return {"in_progress": False, "done": False, "error": "source is current node"}
    if raw_ticket:
        try:
            asyncio.create_task(_sync_user_from_peer_ticket(uid, source, raw_ticket))
        except Exception:
            _log.exception("federation sync: failed to start peer-ticket task")
    elif gid:
        try:
            asyncio.create_task(_sync_user_from_peer_gid(uid, source, gid))
        except Exception:
            _log.exception("federation sync: failed to start peer-gid task")
    else:
        return {"in_progress": False, "done": False, "error": "missing ticket or global_user_id"}
    return _sync_state_get(uid)


def _auth_session_response(user_id: int, token: str, sync_meta: dict | None = None) -> dict:
    """Login/ticket payload — always include server-stored presence + status."""
    ident = db.get_user_by_id(user_id) or {}
    out = {
        # NOTE: token is still echoed in the JSON body for back-compat with
        #   * existing native/Electron/Android clients that store it
        #   * bots / API consumers
        # The browser SPA now ALSO receives an HttpOnly `ft_session`
        # cookie (set by the route handler via response.set_cookie); the
        # SPA will prefer the cookie path going forward. Once all
        # browser clients have migrated, the json token field can be
        # removed for SPA flows.
        "token": token,
        "nickname": ident.get("nickname") or "",
        "display_name": ident.get("display_name"),
        "username_change_remaining_seconds": int(db.username_change_remaining_seconds(user_id)),
        "user_id": user_id,
        "is_admin": bool(ident.get("is_admin")),
        "avatar": ident.get("avatar"),
        "bio": ident.get("bio") or "",
        "presence": ident.get("presence") or "online",
        "status_msg": ident.get("status_msg") or "",
    }
    if isinstance(sync_meta, dict) and sync_meta:
        out["federation_sync"] = sync_meta
    return out


# ── HIGH-2: HttpOnly session cookie helpers ─────────────────────────────────
# We set the session token in two places:
#   1. The legacy JSON body (`token`) so existing clients keep working.
#   2. A new HttpOnly cookie `ft_session` so XSS cannot read it from JS.
#
# When the SPA stops persisting the JSON token to localStorage (a separate
# frontend change), the cookie alone keeps the session alive. Server-side
# `deps.get_current_user` already accepts both the header and the cookie.
#
# Cookie flags:
#   * HttpOnly       — JS cannot read it (defeats XSS-driven token theft).
#   * Secure         — only sent over HTTPS in production (auto-detected).
#   * SameSite=Lax   — blocks cross-origin POST CSRF for top-level
#                      navigation but still lets in legitimate same-site
#                      mutating requests. We pair this with a CSRF
#                      double-submit token on mutating requests
#                      (X-CSRF-Token) for defense in depth.
#   * Path=/         — covers the whole app.
#   * Max-Age        — matches the DB session TTL (30 days; see
#                      database._SESSION_TTL).
import os as _auth_os  # local import alias to avoid colliding with the top-level
_COOKIE_NAME = "ft_session"
_CSRF_COOKIE_NAME = "ft_csrf"
_COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days


def _cookie_is_secure(request: Request) -> bool:
    """Set `secure` only when the request actually arrived over HTTPS.
    Local http://localhost dev must still receive the cookie; otherwise
    the SPA can't authenticate during local testing. Production behind
    Cloudflare/nginx sets `X-Forwarded-Proto: https`.
    """
    try:
        if request.url.scheme == "https":
            return True
        if (request.headers.get("x-forwarded-proto") or "").lower() == "https":
            return True
    except Exception:
        pass
    return False


def _attach_session_cookies(response, request: Request, token: str) -> None:
    """Set the HttpOnly session cookie AND a sibling CSRF cookie.

    The CSRF cookie is intentionally NOT HttpOnly — JS must be able to
    read it to echo back into the `X-CSRF-Token` header on mutating
    requests (double-submit pattern). The CSRF value is HMAC-derived
    from the session token + a server-only secret so a CSRF cookie
    from a different session can't be reused.
    """
    secure = _cookie_is_secure(request)
    # Session cookie — HttpOnly, locked-down.
    try:
        response.set_cookie(
            key=_COOKIE_NAME,
            value=token,
            max_age=_COOKIE_MAX_AGE,
            httponly=True,
            secure=secure,
            samesite="lax",
            path="/",
        )
    except Exception:
        # Don't break the login response if the framework chokes on a
        # cookie flag combination — the JSON `token` body fallback
        # still gives the client a usable session.
        _log.exception("auth: failed to set ft_session cookie")
    # CSRF cookie — readable by JS, value derived from token via HMAC
    # so it's bound to the session and can be regenerated server-side
    # for comparison without server state.
    try:
        import hmac as _hmac
        import hashlib as _hashlib
        secret = (_auth_os.getenv("FROGTALK_CSRF_SECRET") or _auth_os.getenv("FROGTALK_SESSION_SECRET") or "frogtalk-csrf-derive-v1").encode("utf-8")
        csrf = _hmac.new(secret, token.encode("utf-8"), _hashlib.sha256).hexdigest()
        response.set_cookie(
            key=_CSRF_COOKIE_NAME,
            value=csrf,
            max_age=_COOKIE_MAX_AGE,
            httponly=False,  # JS reads it intentionally
            secure=secure,
            samesite="lax",
            path="/",
        )
    except Exception:
        _log.exception("auth: failed to set ft_csrf cookie")


def _clear_session_cookies(response) -> None:
    try:
        response.delete_cookie(_COOKIE_NAME, path="/")
        response.delete_cookie(_CSRF_COOKIE_NAME, path="/")
    except Exception:
        pass


@router.post("/federation-ticket")
@limiter.limit("60/hour")
async def create_federation_ticket(
    request: Request,
    body: FederationTicketRequest,
    current_user: dict = Depends(get_current_user),
):
    target = _norm_base((body.target_url or body.target_base_url or "").strip())
    if not target:
        return JSONResponse(status_code=400, content={"error": "target_base_url required"})
    source = _norm_base(os.getenv("FROGTALK_ONION_URL", "")) if _tor_mode_enabled() else _norm_base(str(request.base_url))
    full_user = db.get_user_by_id(current_user["id"]) or current_user
    ticket = _build_federation_login_ticket(full_user, source, target, ttl_seconds=90)
    if not ticket:
        return JSONResponse(status_code=503, content={"error": "Federation ticket secret not configured"})
    return {"ticket": ticket, "expires_in": 90}


@router.post("/federation-ticket-login")
@limiter.limit("30/hour")
async def login_with_federation_ticket(
    request: Request,
    body: FederationTicketLoginRequest,
):
    payload = _verify_federation_login_ticket(body.ticket, str(request.base_url))
    if not payload:
        return JSONResponse(status_code=401, content={"error": "Invalid or expired ticket"})

    user = _ensure_local_user_from_ticket(payload)
    if not user:
        return JSONResponse(status_code=409, content={"error": "Could not provision account on this node"})

    # Same node-ban gate as the password login path. A banned user
    # must not be able to sidestep enforcement by hopping in via a
    # federation ticket from a peer where they aren't banned.
    try:
        ban = db.get_active_global_ban(user["id"])
    except Exception:
        ban = None
    if ban:
        banner = db.get_user_by_id(ban.get("banned_by")) if ban.get("banned_by") else None
        return JSONResponse(status_code=403, content={
            "error": "This account has been banned from this node.",
            "code": "node_banned",
            "reason": (ban.get("reason") or "")[:500],
            "expires_at": ban.get("expires_at"),
            "banned_by": (banner or {}).get("nickname"),
        })

    token = _create_session_with_meta(request, user["id"])
    sync_meta = None
    source_base = _norm_base(str(payload.get("src") or ""))
    here = _norm_base(str(request.base_url))
    if source_base and source_base != here:
        _sync_state_set(user["id"], {
            "source_base": source_base,
            "in_progress": True,
            "done": False,
            "error": "",
            "progress_pct": 2,
            "phase": "fetch",
            "hint": "Syncing channels and DMs from your home node…",
        })
        try:
            asyncio.create_task(_sync_user_from_peer_ticket(user["id"], source_base, body.ticket))
        except Exception:
            _log.exception("federation sync: failed to start peer-ticket task")
        sync_meta = {
            "in_progress": True,
            "source_base": source_base,
            "progress_pct": 2,
            "phase": "fetch",
            "hint": "Syncing channels and DMs from your home node…",
        }
    payload_out = _auth_session_response(user["id"], token, sync_meta=sync_meta)
    resp = JSONResponse(content=payload_out)
    _attach_session_cookies(resp, request, token)
    return resp


@router.get("/federation-sync-status")
async def federation_sync_status(current_user: dict = Depends(get_current_user)):
    return _sync_state_get(int(current_user["id"]))


@router.post("/federation-sync-resume")
@limiter.limit("30/hour")
async def federation_sync_resume(
    request: Request,
    body: FederationSyncResumeRequest,
    current_user: dict = Depends(get_current_user),
):
    """Kick off (or return) federation import after a node switch.

    Used when the account already exists locally, ticket auto-login failed,
    or the client loaded stale JS and missed the initial sync kick.
    """
    uid = int(current_user["id"])
    me = db.get_user_by_id(uid) or current_user
    state = await _start_federation_sync_for_user(
        uid,
        source_base=str(body.source_base or ""),
        ticket=str(body.ticket or ""),
        global_user_id=str(me.get("global_user_id") or ""),
        here_base=str(request.base_url),
    )
    if state.get("error") and not state.get("in_progress"):
        return JSONResponse(status_code=400, content=state)
    return state


@router.post("/federation-sync-export-gid")
@limiter.limit("120/hour")
async def federation_sync_export_gid(
    body: FederationSyncExportGidRequest,
    x_federation_token: str | None = Header(default=None),
):
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation token"})
    gid = str(body.global_user_id or "").strip()
    if not _GID_RE.match(gid):
        return JSONResponse(status_code=400, content={"error": "Invalid global_user_id"})
    with db._conn() as con:
        row = con.execute(
            "SELECT id FROM users WHERE global_user_id=? LIMIT 1",
            (gid,),
        ).fetchone()
    if not row:
        return JSONResponse(status_code=404, content={"error": "Account not found on this node"})
    return _build_sync_export_for_user(int(row["id"]))


@router.get("/federation-sync-export")
async def federation_sync_export(current_user: dict = Depends(get_current_user)):
    return _build_sync_export_for_user(int(current_user["id"]))


@router.post("/federation-sync-export-ticket")
@limiter.limit("120/hour")
async def federation_sync_export_ticket(
    request: Request,
    body: FederationSyncExportTicketRequest,
    x_federation_token: str | None = Header(default=None),
):
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation token"})
    payload = _verify_federation_login_ticket_for_source(body.ticket, str(request.base_url))
    if not payload:
        return JSONResponse(status_code=401, content={"error": "Invalid or expired ticket"})
    nick = str(payload.get("nickname") or "").strip()
    if not nick:
        return JSONResponse(status_code=400, content={"error": "Missing nickname"})
    user = db.get_user_by_nick(nick)
    if not user:
        return JSONResponse(status_code=404, content={"error": "Account not found on source node"})
    claim_gid = str(payload.get("global_user_id") or "").strip()
    user_gid = str((user or {}).get("global_user_id") or "").strip()
    if claim_gid and user_gid and claim_gid != user_gid:
        return JSONResponse(status_code=409, content={"error": "Ticket identity mismatch"})
    return _build_sync_export_for_user(int(user["id"]))


class FederationProvisionRequest(BaseModel):
    ticket: str


@router.post("/federation-provision")
@limiter.limit("60/hour")
async def federation_provision(request: Request, body: FederationProvisionRequest):
    """Receive an HMAC-signed provisioning ticket from a peer node and create
    the local account using the bcrypt hash directly. No plaintext password
    crosses the wire."""
    payload = _verify_provision_ticket(body.ticket)
    if not payload:
        return JSONResponse(status_code=401, content={"error": "Invalid or expired ticket"})
    nickname = str(payload.get("nickname") or "").strip()
    if not NICKNAME_RE.match(nickname):
        return JSONResponse(status_code=400, content={"error": "Invalid nickname"})
    pw_hash = str(payload.get("password_hash") or "").strip()
    if not pw_hash.startswith("$2"):
        return JSONResponse(status_code=400, content={"error": "Invalid hash"})
    existing = db.get_user_by_nick(nickname)
    if existing:
        return JSONResponse(status_code=200, content={"ok": True, "existing": True})
    gid = str(payload.get("global_user_id") or "").strip() or None
    user_id = db.create_user_with_hash(nickname, pw_hash, gid)
    if user_id is None:
        return JSONResponse(status_code=409, content={"error": "Could not provision"})
    try:
        avatar = payload.get("avatar")
        bio = payload.get("bio")
        ipk = str(payload.get("identity_pubkey") or "").strip()
        with db._conn() as con:
            if avatar is not None:
                con.execute("UPDATE users SET avatar=? WHERE id=?", (avatar, user_id))
            if bio is not None:
                con.execute("UPDATE users SET bio=? WHERE id=?", (bio, user_id))
            if ipk:
                con.execute("UPDATE users SET identity_pubkey=? WHERE id=?", (ipk, user_id))
            con.commit()
    except Exception:
        pass
    try:
        db.auto_join_defaults(user_id)
    except Exception:
        pass
    return {"ok": True, "user_id": user_id}


@router.post("/logout")
async def logout(
    request: Request,
    x_session_token: str = Header(None, alias="X-Session-Token"),
    current_user: dict = Depends(get_current_user),
):
    """Revoke the caller's current session token and drop it from the
    auth cache so subsequent requests can't ride the 15 s TTL window.

    Also drops the user's FCM/push tokens so a stolen device push token
    can't keep receiving notifications after the user signs out."""
    # Cover both auth paths: a SPA request will have the cookie set but
    # may not echo X-Session-Token (after the SPA migration), and a
    # legacy/native client will only have the header.
    token = (x_session_token or "").strip()
    if not token:
        try:
            token = (request.cookies.get(_COOKIE_NAME) or "").strip()
        except Exception:
            token = ""
    if token:
        await asyncio.to_thread(db.delete_session, token)
        invalidate_token_cache(token)
        try:
            pin_clear_for_token(token)
            admin_pin_clear_for_token(token)
        except Exception:
            pass
    try:
        await asyncio.to_thread(db.delete_user_fcm_tokens, current_user["id"])
    except Exception:
        _log.exception("logout: fcm token purge failed for user_id=%s", current_user.get("id"))
    resp = JSONResponse(content={"ok": True})
    _clear_session_cookies(resp)
    return resp


@router.get("/sessions")
async def list_sessions(
    x_session_token: str = Header(None, alias="X-Session-Token"),
    current_user: dict = Depends(get_current_user),
):
    """Return all active sessions for the current user with device + geo
    metadata. Used by the "Active devices" UI on login + in settings.
    """
    rows = await asyncio.to_thread(db.list_user_sessions, current_user["id"], x_session_token or "")
    return {"sessions": rows}


@router.delete("/sessions/{short_id}")
async def revoke_session(
    short_id: str,
    x_session_token: str = Header(None, alias="X-Session-Token"),
    current_user: dict = Depends(get_current_user),
):
    """Revoke another session of mine by its short id. Refuses to revoke the
    caller's own session (use /logout for that)."""
    short_id = (short_id or "").strip()
    if not short_id:
        return JSONResponse(status_code=400, content={"error": "session id required"})
    # Don't let users brick the session they're currently authenticated with
    # via this endpoint — that would be a confusing footgun.
    if x_session_token and x_session_token.startswith(short_id):
        return JSONResponse(status_code=400, content={"error": "Use /logout to end the current session"})
    ok = await asyncio.to_thread(db.delete_session_by_short_id, current_user["id"], short_id, x_session_token or "")
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Session not found"})
    # We don't know the exact token that was just deleted (we only had a
    # short id prefix), so nuke the whole token cache. This is rare and
    # the cache is just a 15 s memoization layer — refilling is cheap.
    invalidate_token_cache(None)
    return {"ok": True}


@router.post("/sessions/revoke-others")
async def revoke_other_sessions(
    x_session_token: str = Header(None, alias="X-Session-Token"),
    current_user: dict = Depends(get_current_user),
):
    """Log out every device except the caller's current session."""
    if not x_session_token:
        return JSONResponse(status_code=400, content={"error": "current session required"})
    n = await asyncio.to_thread(db.delete_other_sessions, current_user["id"], x_session_token)
    # Same rationale as revoke_session: we don't enumerate the deleted
    # tokens, so flush the whole auth cache.
    invalidate_token_cache(None)
    return {"ok": True, "removed": int(n or 0)}


class NicknameChangeRequest(BaseModel):
    nickname: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


@router.patch("/nickname")
@limiter.limit("5/hour")
async def change_nickname(request: Request, body: NicknameChangeRequest, current_user: dict = Depends(get_current_user)):
    """Change user's username (the unique @handle).

    Note: this endpoint is historically named `/nickname` because the
    underlying column is `users.nickname`, but in the UX it is the
    "Username" — limited to once per 7 days. The freeform display
    name lives at PATCH /api/auth/display-name and has no cooldown.
    """
    if not NICKNAME_RE.match(body.nickname):
        return JSONResponse(status_code=400, content={
            "error": "Username must be 2-32 characters: letters, numbers, _ or -"
        })
    if body.nickname == current_user["nickname"]:
        return JSONResponse(status_code=400, content={"error": "That's already your username"})
    if not db.verify_user(current_user["nickname"], body.password):
        return JSONResponse(status_code=401, content={"error": "Incorrect password"})
    # Once-per-week rate limit (server-enforced; the client also surfaces this).
    remaining = db.username_change_remaining_seconds(current_user["id"])
    if remaining > 0:
        days = remaining // 86400
        hours = (remaining % 86400) // 3600
        when = "in " + (f"{days}d {hours}h" if days else f"{hours}h")
        return JSONResponse(status_code=429, content={
            "error": f"Username can only be changed once a week. Try again {when}.",
            "retry_after_seconds": remaining,
        })
    existing = db.get_user_by_nick(body.nickname)
    if existing and existing["id"] != current_user["id"]:
        return JSONResponse(status_code=409, content={"error": "That username is taken"})
    try:
        db.set_username(current_user["id"], body.nickname, current_user["nickname"])
    except Exception:
        return JSONResponse(status_code=409, content={"error": "Could not change username"})
    return {"ok": True, "nickname": body.nickname, "username": body.nickname}


class DisplayNameUpdateRequest(BaseModel):
    display_name: Optional[str] = Field(default=None, max_length=64)  # None or "" clears it


@router.patch("/display-name")
@limiter.limit("30/hour")
async def change_display_name(
    request: Request,
    body: DisplayNameUpdateRequest,
    x_session_token: str = Header(None, alias="X-Session-Token"),
    current_user: dict = Depends(get_current_user),
):
    """Set or clear the freeform display name (the "nickname" in UI).
    Empty/null clears it and the UI falls back to showing @username.
    """
    raw = body.display_name or ""
    # Strip control chars; keep emoji + unicode letters + spaces.
    cleaned = "".join(ch for ch in raw if ch == " " or ch.isprintable()).strip()
    if len(cleaned) > 32:
        return JSONResponse(status_code=400, content={
            "error": "Nickname must be 32 characters or fewer"
        })
    db.set_display_name(current_user["id"], cleaned or None)
    invalidate_token_cache(x_session_token)
    manager.update_user_meta(current_user["id"], display_name=cleaned or "")
    # Broadcast so all connected clients update their member-list caches
    try:
        await manager.broadcast_all({
            "type": "profile_update",
            "user_id": current_user["id"],
            "nickname": current_user["nickname"],
            "display_name": cleaned or None,
        })
    except Exception:
        pass
    try:
        from routers import federation as federation_mod
        ident = db.get_user_by_id(current_user["id"]) or current_user
        federation_mod.enqueue_user_profile_updated(
            ident,
            extra={"display_name": cleaned or ""},
        )
    except Exception:
        _log.exception("federation: failed to enqueue display_name sync")
    return {"ok": True, "display_name": cleaned or None}



@router.get("/me")
async def me(current_user: dict = Depends(get_current_user)):
    out = dict(current_user)
    # Username/display split: ensure both keys are present and surface
    # the cooldown so Settings can show "next change available" inline.
    out.setdefault("display_name", out.get("display_name"))
    out["username"] = out.get("nickname")
    try:
        out["username_change_remaining_seconds"] = int(
            db.username_change_remaining_seconds(current_user["id"])
        )
    except Exception:
        out["username_change_remaining_seconds"] = 0
    # PIN-lock status: defence-in-depth, surface the live lockout
    # remaining seconds so the client lock screen can show a countdown
    # even if the user reloads mid-lockout.
    try:
        pin_status = db.get_pin_status(current_user["id"])
        out["has_pin"] = int(pin_status.get("has_pin") or 0)
        out["pin_require_on_unlock"] = int(pin_status.get("pin_require_on_unlock") or 0)
        out["pin_require_for_admin"] = int(pin_status.get("pin_require_for_admin") or 0)
        out["pin_require_after_autologin"] = int(pin_status.get("pin_require_after_autologin") or 0)
        out["pin_idle_timeout_sec"] = int(pin_status.get("pin_idle_timeout_sec") or 300)
        out["pin_lock_remaining_sec"] = int(pin_status.get("pin_lock_remaining_sec") or 0)
    except Exception:
        # Never let a PIN-status failure break /me — the user can still
        # use the app without the PIN feature.
        out.setdefault("has_pin", 0)
    return out


# ──────────────────────────────────────────────────────────────────────
# PIN-lock (privacy)
# ──────────────────────────────────────────────────────────────────────
# These endpoints implement the optional app-lock PIN. Security model:
#   * Setting / disabling the PIN requires the account password.
#   * Verifying the PIN is rate-limited per-IP at the slowapi layer
#     AND per-user via the bcrypt-cost + DB-backed lockout in
#     db.verify_user_pin (5 wrong PINs → 15 min lock).
#   * Toggling the *behaviour* flags (auto-lock on idle, admin gate,
#     autologin gate, idle timeout) requires an active PIN — flipping
#     them off without a PIN would just leave them flipped on by
#     default at first set, which is the policy we want.
#   * The PIN hash is never returned by any endpoint.

class PinSetRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    pin: str = Field(min_length=4, max_length=8)


class PinVerifyRequest(BaseModel):
    pin: str = Field(min_length=1, max_length=16)
    # True when unlocking /server, /board/admin, or other operator panels —
    # not for idle-lock / resume gates in the main app.
    admin_gate: bool = False


class PinDisableRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)


class PinOptionsRequest(BaseModel):
    require_on_unlock: bool | None = None
    require_for_admin: bool | None = None
    require_after_autologin: bool | None = None
    # Min 0 (lock immediately on blur), max 86400 (24 h). Anything
    # outside that range is clamped server-side in db.update_pin_options.
    idle_timeout_sec: int | None = Field(default=None, ge=0, le=86400)
    # 10.5: hide digits on the lock keypad (shape-only glyphs).
    keypad_privacy: bool | None = None


@router.get("/pin/status")
@limiter.limit("60/minute")
async def pin_status(request: Request, current_user: dict = Depends(get_current_user)):
    out = await asyncio.to_thread(db.get_pin_status, current_user["id"])
    # Surface is_admin so the client-side PIN options panel can decide
    # whether to render the "Require PIN for admin areas" row even when
    # State.user.is_admin hasn't been hydrated yet (e.g. first paint
    # right after login on a fresh device).
    try:
        out = dict(out or {})
        out["is_admin"] = bool(current_user.get("is_admin"))
    except Exception:
        pass
    return out


@router.get("/admin-gate-status")
@limiter.limit("120/minute")
async def admin_gate_status(
    request: Request,
    x_session_token: str = Header(None, alias="X-Session-Token"),
):
    """Bootstrap for /server and /board/admin — no PIN gate on this route.

    Returns whether the caller is signed in, is a node admin, and must
    re-enter their PIN before operator panels load.
    """
    try:
        user = await get_current_user(request, x_session_token)
    except HTTPException:
        user = None
    token = session_token_from_request(request) or (x_session_token or "").strip()
    status = admin_area_access_status(user, token)
    return {"ok": status.get("allowed", False), **status}


@router.post("/pin/set")
@limiter.limit("10/hour")
async def pin_set(request: Request, body: PinSetRequest,
                  x_session_token: str = Header(None, alias="X-Session-Token"),
                  current_user: dict = Depends(get_current_user)):
    """Set or rotate the user's PIN. Requires the account password."""
    res = await asyncio.to_thread(
        db.set_user_pin, current_user["id"], body.current_password, body.pin
    )
    if not res.get("ok"):
        return JSONResponse(status_code=400, content=res)
    # The act of setting the PIN proves possession of the account
    # password — treat this session as freshly unlocked so the
    # server-side pin_gate doesn't immediately 423-bounce the next
    # request (e.g. "save settings") the user just made.
    token = session_token_from_request(request) or (x_session_token or "").strip()
    try:
        pin_mark_unlocked(token)
    except Exception:
        pass
    return res


@router.post("/pin/verify")
@limiter.limit("20/minute")
async def pin_verify(request: Request, body: PinVerifyRequest,
                     x_session_token: str = Header(None, alias="X-Session-Token"),
                     current_user: dict = Depends(get_current_user)):
    """Verify the user's PIN. Per-user lockout after _PIN_MAX_ATTEMPTS
    consecutive failures; per-IP slowapi limit is the secondary layer.
    On success we record the unlock against the calling session token
    so the server-side pin_gate dep starts admitting requests on this
    session."""
    res = await asyncio.to_thread(
        db.verify_user_pin, current_user["id"], body.pin
    )
    if not res.get("ok"):
        return JSONResponse(status_code=401, content=res)
    token = session_token_from_request(request) or (x_session_token or "").strip()
    try:
        pin_mark_unlocked(token)
        # Admin grace only when the client explicitly requested an admin
        # gate unlock — app idle/resume PIN must not satisfy /server.
        if body.admin_gate:
            admin_pin_mark_unlocked(token)
    except Exception:
        pass
    return res


@router.post("/pin/sync-admin-gate")
@limiter.limit("60/minute")
async def pin_sync_admin_gate(
    request: Request,
    x_session_token: str = Header(None, alias="X-Session-Token"),
    current_user: dict = Depends(get_current_user),
):
    """Stamp server-side admin PIN grace without re-entering the PIN.

    Used when the browser already passed ``gateAdmin()`` (sessionStorage
    grace or a parent-frame unlock) but ``/api/server-admin/session`` still
    reports ``pin_required`` because the unlock was keyed on a different
    transport (header vs cookie).
    """
    if not int(current_user.get("pin_require_for_admin") or 0):
        return {"ok": True, "synced": False}
    token = session_token_from_request(request) or (x_session_token or "").strip()
    if _pin_session_is_locked(current_user, token):
        return JSONResponse(
            status_code=423,
            content={
                "pin_required": True,
                "admin": True,
                "error": "PIN required for admin actions",
            },
        )
    try:
        admin_pin_mark_unlocked(token)
    except Exception:
        pass
    return {"ok": True, "synced": True}


@router.delete("/pin")
@limiter.limit("10/hour")
async def pin_disable(request: Request, body: PinDisableRequest,
                      x_session_token: str = Header(None, alias="X-Session-Token"),
                      current_user: dict = Depends(get_current_user)):
    """Disable PIN protection. Requires the account password."""
    res = await asyncio.to_thread(
        db.disable_user_pin, current_user["id"], body.current_password
    )
    if not res.get("ok"):
        return JSONResponse(status_code=400, content=res)
    # PIN is gone — the gate is a no-op now, but drop the unlock entry
    # too so memory stays clean.
    token = session_token_from_request(request) or (x_session_token or "").strip()
    try:
        pin_clear_for_token(token)
        admin_pin_clear_for_token(token)
    except Exception:
        pass
    return res


@router.patch("/pin/options")
@limiter.limit("30/hour")
async def pin_options(request: Request, body: PinOptionsRequest,
                      current_user: dict = Depends(get_current_user)):
    """Toggle PIN behaviour flags. PIN must already be set (you cannot
    enable auto-lock without a PIN to unlock with)."""
    status = await asyncio.to_thread(db.get_pin_status, current_user["id"])
    if not int(status.get("has_pin") or 0):
        return JSONResponse(status_code=400, content={"error": "PIN not set"})
    await asyncio.to_thread(
        db.update_pin_options,
        current_user["id"],
        body.require_on_unlock,
        body.require_for_admin,
        body.require_after_autologin,
        body.idle_timeout_sec,
        body.keypad_privacy,
    )
    return await asyncio.to_thread(db.get_pin_status, current_user["id"])


@router.patch("/profile")
@limiter.limit("30/hour")
async def update_profile(request: Request, body: ProfileUpdateRequest, current_user: dict = Depends(get_current_user)):
    # Validate avatar size
    if body.avatar and len(body.avatar) > MAX_AVATAR_BYTES:
        return JSONResponse(status_code=413, content={"error": "Avatar too large (max 2MB)"})

    # Validate avatar is a safe data URL
    if body.avatar:
        allowed = ('data:image/png;base64,', 'data:image/jpeg;base64,',
                   'data:image/webp;base64,', 'data:image/gif;base64,')
        if not any(body.avatar.startswith(p) for p in allowed):
            return JSONResponse(status_code=400, content={"error": "Invalid avatar format"})

    # Validate banner
    if body.banner and len(body.banner) > 3 * 1024 * 1024:
        return JSONResponse(status_code=413, content={"error": "Banner too large (max 3MB)"})
    if body.banner:
        allowed_b = ('data:image/png;base64,', 'data:image/jpeg;base64,',
                     'data:image/webp;base64,', 'data:image/gif;base64,')
        if not any(body.banner.startswith(p) for p in allowed_b):
            return JSONResponse(status_code=400, content={"error": "Invalid banner format"})

    # 9th-pass: re-encode through Pillow to strip EXIF / IPTC / XMP /
    # ICC profiles and to refuse polyglot payloads (e.g. SVG/HTML bytes
    # disguised as image/png). safe_reencode degrades to passthrough if
    # Pillow is unavailable rather than rejecting the upload.
    if body.avatar:
        body.avatar = await asyncio.to_thread(_media_reencode, body.avatar)
    if body.banner:
        body.banner = await asyncio.to_thread(_media_reencode, body.banner)

    # Require current password to change password
    if body.new_password:
        if not body.current_password:
            return JSONResponse(status_code=400, content={"error": "Current password required"})
        if not db.verify_user(current_user["nickname"], body.current_password or ""):
            return JSONResponse(status_code=401, content={"error": "Current password incorrect"})
        if len(body.new_password) < 6:
            return JSONResponse(status_code=400, content={"error": "New password must be 6+ characters"})

    db.update_profile(
        current_user["id"],
        avatar=body.avatar,
        bio=body.bio,
        new_password=body.new_password,
        banner=body.banner,
    )
    # When the password actually changed, kick every OTHER active session
    # off this account. The current session (identified by the X-Session-Token
    # header on this request) is kept so the user isn't logged out of the tab
    # they just used. Also flush our in-memory token cache so a revoked
    # session can't keep working for up to 15 s on its old auth lookup.
    if body.new_password:
        try:
            current_token = session_token_from_request(request)
            if current_token:
                db.delete_other_sessions(current_user["id"], current_token)
            invalidate_token_cache(None)
        except Exception:
            pass
    status_or_presence_changed = (body.status_msg is not None or body.presence is not None)
    if status_or_presence_changed:
        with db._conn() as con:
            if body.status_msg is not None:
                con.execute("UPDATE users SET status_msg=? WHERE id=?",
                            (body.status_msg[:128], current_user["id"]))
            if body.presence is not None:
                allowed_p = {"online", "away", "dnd", "invisible"}
                if body.presence in allowed_p:
                    con.execute("UPDATE users SET presence=? WHERE id=?",
                                (body.presence, current_user["id"]))
            con.commit()

    if body.profile_public is not None or body.allow_friend_requests is not None:
        profile_public = body.profile_public if body.profile_public is not None else True
        allow_fr = body.allow_friend_requests if body.allow_friend_requests is not None else True
        db.update_privacy(current_user["id"], profile_public, allow_fr)
    # Update user settings
    with db._conn() as con:
        if body.theme is not None:
            allowed_themes = {"frog", "light", "midnight", "forest", "cyberpunk", "ocean", "sunset", "rose", "solarized", "mono", "custom"}
            # 'dark' is a legacy alias for 'frog' (identical palette). Remap
            # it so the DB never stores the old name again.
            incoming_theme = "frog" if body.theme == "dark" else body.theme
            if incoming_theme in allowed_themes:
                con.execute("UPDATE users SET theme=? WHERE id=?", (incoming_theme, current_user["id"]))
        if body.notify_sounds is not None:
            con.execute("UPDATE users SET notify_sounds=? WHERE id=?", (1 if body.notify_sounds else 0, current_user["id"]))
        if body.notify_desktop is not None:
            con.execute("UPDATE users SET notify_desktop=? WHERE id=?", (1 if body.notify_desktop else 0, current_user["id"]))
        if body.notify_dms is not None:
            con.execute("UPDATE users SET notify_dms=? WHERE id=?", (1 if body.notify_dms else 0, current_user["id"]))
        if body.notify_mentions is not None:
            con.execute("UPDATE users SET notify_mentions=? WHERE id=?", (1 if body.notify_mentions else 0, current_user["id"]))
        if body.allow_dms_from is not None:
            allowed_dm_opts = {"everyone", "friends", "nobody"}
            if body.allow_dms_from in allowed_dm_opts:
                con.execute("UPDATE users SET allow_dms_from=? WHERE id=?", (body.allow_dms_from, current_user["id"]))
        if body.show_last_seen is not None:
            allowed_ls = {"everyone", "friends", "nobody"}
            if body.show_last_seen in allowed_ls:
                con.execute("UPDATE users SET show_last_seen=? WHERE id=?", (body.show_last_seen, current_user["id"]))
        if body.show_read_receipts is not None:
            con.execute("UPDATE users SET show_read_receipts=? WHERE id=?",
                        (1 if body.show_read_receipts else 0, current_user["id"]))
        if body.hide_active_channels is not None:
            con.execute("UPDATE users SET hide_active_channels=? WHERE id=?",
                        (1 if body.hide_active_channels else 0, current_user["id"]))
        con.commit()
    # Broadcast profile update so open clients refresh member-list caches.
    if status_or_presence_changed:
        try:
            await manager.broadcast_all({
                "type": "profile_update",
                "user_id": current_user["id"],
                "nickname": current_user["nickname"],
                **({"presence": body.presence} if body.presence is not None else {}),
                **({"status_msg": body.status_msg[:128]} if body.status_msg is not None else {}),
            })
        except Exception:
            pass
    # Broadcast profile update so open clients refresh avatars / nicknames in member lists
    if body.avatar is not None:
        try:
            manager.update_user_meta(current_user["id"], avatar=body.avatar)
        except Exception:
            pass
        try:
            await manager.broadcast_all({
                "type": "profile_update",
                "user_id": current_user["id"],
                "nickname": current_user["nickname"],
                "avatar": body.avatar,
            })
        except Exception:
            pass
    # Flush cached user (header *or* ft_session cookie — cookie-only browsers
    # never sent X-Session-Token so the old header-only invalidation was a no-op).
    try:
        invalidate_request_session_cache(request)
    except Exception:
        pass
    # Federation: push profile after every local field is committed so peers
    # (and channel member lists) get avatar / display name / status in sync.
    try:
        from routers import federation as federation_mod
        ident = db.get_user_by_id(current_user["id"]) or {}
        prof = db.get_user_profile(ident.get("nickname") or "") or {}
        merged = {**ident, **{k: prof[k] for k in ("status_msg", "presence", "mood", "banner") if k in prof}}
        federation_mod.enqueue_user_profile_updated(merged)
    except Exception:
        _log.exception("federation: failed to enqueue user.profile.updated")
    # Return the fresh row so clients can merge without a follow-up /me that
    # might still race the cache on very fast reopen.
    try:
        tok = session_token_from_request(request)
        if tok:
            fresh = db.get_user_by_token(tok)
            if fresh:
                out = dict(fresh)
                out.setdefault("display_name", out.get("display_name"))
                out["username"] = out.get("nickname")
                out["ok"] = True
                return out
    except Exception:
        pass
    return {"ok": True}


class DeleteAccountRequest(BaseModel):
    password: str = Field(min_length=1, max_length=128)


@router.delete("/account")
async def delete_account(body: DeleteAccountRequest, current_user: dict = Depends(get_current_user)):
    """Permanently delete user account. Requires password confirmation."""
    # Verify password
    if not db.verify_user(current_user["nickname"], body.password):
        return JSONResponse(status_code=401, content={"error": "Incorrect password"})
    
    # Prevent admin account deletion
    if current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Admin accounts cannot be deleted"})

    # Capture the gid BEFORE the row is destroyed so we can broadcast
    # the deletion to federated peers. Without this peers would keep a
    # stale federation_user_profiles row pointing at a user that no
    # longer exists on the origin.
    gid = ""
    nick = current_user.get("nickname") or ""
    try:
        ident = db.get_user_by_id(current_user["id"]) or {}
        gid = str(ident.get("global_user_id") or "").strip()
    except Exception:
        pass

    try:
        ok = db.delete_user_account(current_user["id"])
    except Exception:
        _log.exception("delete_account: db.delete_user_account failed uid=%s", current_user.get("id"))
        return JSONResponse(status_code=500, content={"error": "Account deletion failed"})
    if not ok:
        return JSONResponse(status_code=500, content={"error": "Failed to delete account"})
    try:
        invalidate_request_session_cache(request)
        pin_clear_for_token(session_token_from_request(request))
        admin_pin_clear_for_token(session_token_from_request(request))
    except Exception:
        pass

    # Federation fan-out: peers will purge their federation_user_profiles
    # entry for this gid (with origin-pinning enforced by the inbox).
    # Best-effort — a failure here must not roll back the local delete.
    try:
        if gid:
            db.insert_federation_outbox_event({
                "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
                "event_type": "user.deleted",
                "payload": {
                    "global_user_id": gid,
                    "nickname": nick,
                },
            })
    except Exception:
        _log.exception("federation: failed to enqueue user.deleted for gid=%s", gid)

    return {"ok": True, "message": "Account permanently deleted"}


# ===========================================================================
# CAPTCHA System - Image-based challenge for registration
# ===========================================================================
import secrets
import base64
import io
import hashlib

# Simple CAPTCHA generation without external dependencies
def generate_captcha_image(text: str) -> str:
    """Generate a simple ASCII-art style CAPTCHA as base64 PNG."""
    try:
        from PIL import Image, ImageDraw, ImageFont
        import random
        
        width, height = 200, 80
        img = Image.new('RGB', (width, height), color='#1a1a1a')
        draw = ImageDraw.Draw(img)
        
        # Draw noise lines
        for _ in range(8):
            x1 = random.randint(0, width)
            y1 = random.randint(0, height)
            x2 = random.randint(0, width)
            y2 = random.randint(0, height)
            draw.line([(x1, y1), (x2, y2)], fill='#333333', width=1)
        
        # Draw the text
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 36)
        except:
            font = ImageFont.load_default()
        
        # Calculate text position
        bbox = draw.textbbox((0, 0), text, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]
        x = (width - text_width) // 2
        y = (height - text_height) // 2
        
        # Draw text with slight distortion
        for i, char in enumerate(text):
            char_x = x + i * (text_width // len(text))
            char_y = y + random.randint(-5, 5)
            color = random.choice(['#4caf50', '#66bb6a', '#81c784'])
            draw.text((char_x, char_y), char, font=font, fill=color)
        
        # Add noise dots
        for _ in range(100):
            x = random.randint(0, width - 1)
            y = random.randint(0, height - 1)
            draw.point((x, y), fill='#444444')
        
        # Convert to base64
        buffer = io.BytesIO()
        img.save(buffer, format='PNG')
        return f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode()}"
    except ImportError:
        # Fallback: return simple text-based challenge
        return None


def generate_captcha_text(length: int = 5) -> str:
    """Generate random CAPTCHA text (avoiding confusing chars)."""
    chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(chars) for _ in range(length))


class CaptchaResponse(BaseModel):
    challenge_id: str
    image: str | None = None
    text_challenge: str | None = None  # Fallback if image generation fails


@router.get("/check-username")
@limiter.limit("60/minute")
async def check_username(request: Request, nickname: str = ""):
    """Live username-availability check used by the signup form.

    Returns {available: bool, error: str|null, suggestions: [str]}. When
    the requested nickname is taken or invalid, `suggestions` contains
    up to 5 close-by available alternatives (e.g. name → name2, name3,
    name_xyz). Public endpoint — no auth required.
    """
    nick = (nickname or "").strip()
    if not nick:
        return {"available": False, "error": "Username cannot be empty", "suggestions": []}
    if not NICKNAME_RE.match(nick):
        return {
            "available": False,
            "error": "Username must be 2-32 characters: letters, numbers, _ or -",
            "suggestions": [],
        }
    if db.is_username_available(nick):
        return {"available": True, "error": None, "suggestions": []}
    suggestions = db.suggest_available_usernames(nick, count=5)
    return {
        "available": False,
        "error": "That username is already taken",
        "suggestions": suggestions,
    }


@router.get("/captcha")
@limiter.limit("30/hour")
async def get_captcha(request: Request):
    """Generate a new CAPTCHA challenge."""
    challenge_id = secrets.token_urlsafe(16)
    answer = generate_captcha_text(5)
    
    # Store challenge
    db.create_captcha(challenge_id, answer, expires_minutes=5)
    
    # Try to generate image
    image = generate_captcha_image(answer)
    
    if image:
        return {"challenge_id": challenge_id, "image": image}
    else:
        # Fallback: math challenge
        a, b = secrets.randbelow(20) + 1, secrets.randbelow(20) + 1
        math_answer = str(a + b)
        db.create_captcha(challenge_id, math_answer, expires_minutes=5)
        return {
            "challenge_id": challenge_id,
            "text_challenge": f"What is {a} + {b}?"
        }


class RegisterWithCaptchaRequest(BaseModel):
    nickname: str
    password: str
    captcha_id: str
    captcha_answer: str


@router.post("/register-secure")
@limiter.limit("3/hour")
async def register_with_captcha(
    request: Request,
    body: RegisterWithCaptchaRequest,
    x_federation_relay: str | None = Header(default=None),
):
    """Register with CAPTCHA verification (bot-proof).

    SECURITY: never honour `X-Federation-Relay: 1` here — there is no
    authenticated relay path on this endpoint. Federation peers replicate
    accounts via /federation-provision (HMAC-signed ticket).
    """
    # Verify CAPTCHA first
    if not db.verify_captcha(body.captcha_id, body.captcha_answer):
        return JSONResponse(status_code=400, content={"error": "Invalid or expired CAPTCHA"})
    
    # Normal registration logic
    if not NICKNAME_RE.match(body.nickname):
        return JSONResponse(status_code=400, content={
            "error": "Nickname must be 2-32 characters: letters, numbers, _ or -"
        })
    if len(body.password) < 6:
        return JSONResponse(status_code=400, content={"error": "Password must be at least 6 characters"})
    
    user_id = db.create_user(body.nickname, body.password, registration_ip=client_ip(request))
    if user_id is None:
        suggestions = db.suggest_available_usernames(body.nickname, count=5)
        return JSONResponse(status_code=409, content={
            "error": "That username is already taken",
            "suggestions": suggestions,
        })
    db.auto_join_defaults(user_id)
    try:
        ident = db.get_user_by_id(user_id) or {}
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "user.created",
            "payload": {
                "global_user_id": ident.get("global_user_id") or "",
                "nickname": ident.get("nickname") or body.nickname,
                "display_name": ident.get("display_name") or "",
                "avatar": ident.get("avatar") or "",
                "bio": ident.get("bio") or "",
                "identity_pubkey": ident.get("identity_pubkey") or "",
            },
        })
    except Exception:
        _log.exception("register: federation outbox insert failed")
    if (x_federation_relay or "").strip() != "1":
        try:
            await _fanout_registration_to_peers(request, user_id, body.nickname, body.password)
        except Exception:
            _log.exception("register: peer fanout failed")
    token = _create_session_with_meta(request, user_id)
    return {"token": token, "nickname": body.nickname, "user_id": user_id, "is_admin": False}


# ===========================================================================
# Recovery Key System - Account recovery without email
# ===========================================================================

class GenerateRecoveryKeyRequest(BaseModel):
    password: str  # Verify identity


@router.post("/recovery-key")
@limiter.limit("5/hour")
async def generate_recovery_key(request: Request, body: GenerateRecoveryKeyRequest, current_user: dict = Depends(get_current_user)):
    """Generate a recovery key file for account recovery."""
    # Verify password
    if not db.verify_user(current_user["nickname"], body.password):
        return JSONResponse(status_code=401, content={"error": "Incorrect password"})
    
    # Generate recovery key. Pass the *raw* key to db.create_recovery_key
    # so the bcrypt-at-rest path (HIGH-5) runs. The function detects the
    # legacy hex-digest format too, so older callers keep working.
    raw_key = secrets.token_urlsafe(32)
    db.create_recovery_key(current_user["id"], raw_key)
    
    # Create recovery file content
    recovery_data = {
        "app": "FrogTalk",
        "version": 1,
        "username": current_user["nickname"],
        "user_id": current_user["id"],
        "recovery_key": raw_key,
        "warning": "KEEP THIS FILE SAFE! Anyone with this key can access your account."
    }
    
    import json
    recovery_json = json.dumps(recovery_data, indent=2)
    recovery_b64 = base64.b64encode(recovery_json.encode()).decode()
    
    return {
        "recovery_key": raw_key,
        "file_content": f"data:application/json;base64,{recovery_b64}",
        "filename": f"frogtalk-recovery-{current_user['nickname']}.json",
        "message": "Save this file securely! It's the ONLY way to recover your account."
    }


class RecoverAccountRequest(BaseModel):
    recovery_key: str
    new_password: str


@router.post("/recover")
@limiter.limit("5/hour")
async def recover_account(request: Request, body: RecoverAccountRequest):
    """Recover account using recovery key."""
    if len(body.new_password) < 6:
        return JSONResponse(status_code=400, content={"error": "Password must be at least 6 characters"})
    
    # HIGH-5: pass the raw key so db.use_recovery_key takes the bcrypt
    # path. Legacy SHA-256 rows are still accepted by the same call.
    user_id = db.use_recovery_key(body.recovery_key)
    
    if not user_id:
        return JSONResponse(status_code=401, content={"error": "Invalid or already used recovery key"})
    
    # Reset password
    with db._conn() as con:
        from bcrypt import hashpw, gensalt
        pw_hash = hashpw(body.new_password.encode(), gensalt()).decode()
        con.execute("UPDATE users SET password_hash=? WHERE id=?", (pw_hash, user_id))
        
        # Get user info
        user = con.execute("SELECT nickname FROM users WHERE id=?", (user_id,)).fetchone()
    
    # Create new session
    token = _create_session_with_meta(request, user_id)

    # Security: a recovery means the previous credentials may be compromised.
    # Invalidate every other active session so an attacker who was logged in
    # with the old password is kicked out as soon as the legitimate owner
    # recovers.
    try:
        db.delete_other_sessions(user_id, token)
    except Exception:
        pass

    return {
        "ok": True,
        "token": token,
        "nickname": user["nickname"],
        "message": "Account recovered! Please generate a new recovery key."
    }


class VerifyRecoveryKeyRequest(BaseModel):
    recovery_key: str


@router.post("/verify-recovery-key")
@limiter.limit("20/hour")
async def verify_recovery_key(request: Request, body: VerifyRecoveryKeyRequest):
    """Check if a recovery key is valid (without using it)."""
    raw = (body.recovery_key or "").strip()
    if not raw:
        return {"valid": False}
    # Legacy SHA-256-at-rest rows: O(1) lookup by hash.
    key_hash = hashlib.sha256(raw.encode()).hexdigest()
    with db._conn() as con:
        row = con.execute("""
            SELECT rk.id, u.nickname FROM recovery_keys rk
            JOIN users u ON rk.user_id = u.id
            WHERE rk.key_hash=? AND rk.used_at IS NULL
        """, (key_hash,)).fetchone()
    if row:
        return {"valid": True, "username": row["nickname"]}
    # HIGH-5: bcrypt-at-rest rows — scan only unused bcrypt rows. Small
    # working set because there's at most one active key per user.
    try:
        import bcrypt as _bcrypt_local
    except Exception:
        return {"valid": False}
    with db._conn() as con:
        cands = con.execute("""
            SELECT rk.id, u.nickname, rk.key_hash FROM recovery_keys rk
            JOIN users u ON rk.user_id = u.id
            WHERE rk.used_at IS NULL AND rk.key_hash LIKE 'bcrypt$%'
        """).fetchall()
    for cand in cands:
        try:
            hashed = cand["key_hash"][len("bcrypt$"):]
            if _bcrypt_local.checkpw(raw.encode("utf-8"), hashed.encode("utf-8")):
                return {"valid": True, "username": cand["nickname"]}
        except Exception:
            continue
    return {"valid": False}
