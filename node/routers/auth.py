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
_SYNC_EXPORT_SOCIAL_POST_LIMIT = 300
_SYNC_EXPORT_SOCIAL_ID_CAP = 5000
_SYNC_EXPORT_VERSION = 2
_SYNC_EXPORT_EXPLORE_POST_LIMIT = 120
_SYNC_EXPORT_SOCIAL_MEDIA_MAX = 4_000_000
_SYNC_EXPORT_ROOM_ICON_MAX = 400_000
# Recent chat history per joined room — capped because the sync export is
# a single JSON blob. media_data is stripped (clients lazy-load), so each
# message is mostly text + small metadata.
_SYNC_EXPORT_HISTORY_PER_ROOM = 80
_SYNC_EXPORT_HISTORY_TOTAL_ROOMS = 60
# Recent DM ciphertext per DM channel. Ciphertext is opaque on the wire
# so this transports privately-encrypted DMs without leaking plaintext.
_SYNC_EXPORT_DM_HISTORY_PER_CHANNEL = 60
_SYNC_EXPORT_DM_HISTORY_TOTAL_CHANNELS = 40
_SYNC_EXPORT_MEMBER_ROOM_LIMIT = 40
_SYNC_EXPORT_MEMBERS_PER_ROOM = 120

_sync_state_lock = _threading.Lock()
_federation_sync_state: dict[int, dict] = {}


def _sync_persist_enabled() -> bool:
    return os.getenv("FROGTALK_SYNC_PERSIST", "1").strip().lower() not in ("0", "false", "no")


def _sync_bind_home_enabled() -> bool:
    return os.getenv("FROGTALK_SYNC_BIND_HOME", "1").strip().lower() not in ("0", "false", "no")


def _sync_verify_export_enabled() -> bool:
    return os.getenv("FROGTALK_SYNC_VERIFY_EXPORT", "1").strip().lower() not in ("0", "false", "no")


def _sync_login_resume_enabled() -> bool:
    return os.getenv("FROGTALK_SYNC_LOGIN_RESUME", "1").strip().lower() not in ("0", "false", "no")


def _sync_pagination_enabled() -> bool:
    return os.getenv("FROGTALK_SYNC_PAGINATION", "1").strip().lower() not in ("0", "false", "no")


def _sync_sign_export_enabled() -> bool:
    return os.getenv("FROGTALK_SYNC_SIGN_EXPORT", "1").strip().lower() not in ("0", "false", "no")


def _attach_sync_export_signature(payload: dict) -> dict:
    """Sign export on home node when FROGTALK_SYNC_SIGN_EXPORT=1."""
    out = dict(payload or {})
    if not _sync_sign_export_enabled():
        return out
    try:
        import crypto_fed as _cf

        sig_b64, fp = _cf.sign_sync_export(out)
        out["export_sig_b64"] = sig_b64
        out["export_signer_fingerprint"] = fp
    except Exception:
        _log.debug("federation sync: export signing failed", exc_info=True)
    return out


def _clear_federation_sync_state(user_id: int) -> None:
    uid = int(user_id or 0)
    if uid <= 0:
        return
    with _sync_state_lock:
        _federation_sync_state.pop(uid, None)
    if _sync_persist_enabled():
        try:
            db.clear_user_federation_sync_state(uid)
        except Exception:
            pass


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


def _sanitize_sync_room_icon(icon) -> str | None:
    raw = str(icon or "").strip()
    if not raw:
        return None
    if len(raw) > _SYNC_EXPORT_ROOM_ICON_MAX:
        return None
    if raw.startswith("data:"):
        if not re.match(
            r"^data:image/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\n\r]+$",
            raw,
            re.IGNORECASE,
        ):
            return None
        return raw
    if raw.startswith("http://") or raw.startswith("https://") or raw.startswith("/"):
        return raw[:512]
    if len(raw) <= 32:
        return raw
    return None


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


def _peer_home_server_id_for_sync(global_user_id: str, fallback: str = "") -> str:
    """Best-effort home server_id for a peer in account-sync export/import."""
    gid = str(global_user_id or "").strip()
    if not gid:
        return str(fallback or "").strip()
    home = db.resolve_global_user_home_server_id(gid)
    return home or str(fallback or "").strip()


def _sync_item_peer_origin(item: dict, source_server_id: str) -> str:
    """Origin server for ensure_federated_dm_local_user during import."""
    if not isinstance(item, dict):
        return str(source_server_id or "").strip()
    return str(item.get("home_server_id") or source_server_id or "").strip()


def _pin_local_account_home(user_id: int) -> None:
    """Mark this node as the account's federation home (native registration)."""
    uid = int(user_id or 0)
    if uid <= 0:
        return
    ident = db.get_or_create_local_server_identity() or {}
    sid = str(ident.get("server_id") or "").strip()
    if sid:
        db.set_user_account_home_server_id(uid, sid, force=True)


def _upsert_sync_peer_profile_cache(item: dict, source_server_id: str) -> bool:
    """Cache avatar/display for a federated contact from account-sync export."""
    if not isinstance(item, dict):
        return False
    gid = str(item.get("global_user_id") or "").strip()
    nick = str(item.get("nickname") or "").strip()
    if not _GID_RE.match(gid) or not nick:
        return False
    display_name = str(item.get("display_name") or "")[:64]
    avatar = item.get("avatar") or ""
    bio = str(item.get("bio") or "")[:4000]
    status_msg = str(item.get("status_msg") or "")[:200]
    mood = str(item.get("mood") or "")[:200]
    presence = str(item.get("presence") or "offline")[:32]
    custom_style = _sanitize_inline_style(str(item.get("custom_style") or "")[:12000])
    banner = str(item.get("banner") or "")[:500_000]
    if not (display_name or avatar or bio or status_msg or custom_style or mood or presence or banner):
        return False
    origin = _sync_item_peer_origin(item, source_server_id)
    try:
        return bool(
            db.upsert_federation_user_profile(
                gid,
                nick,
                display_name=display_name,
                avatar=avatar or "",
                bio=bio,
                origin_server_id=origin,
                status_msg=status_msg,
                mood=mood,
                presence=presence,
                custom_style=custom_style,
                banner=banner,
            )
        )
    except Exception:
        return False


def _sync_peer_profile_row(user_id: int, nick_hint: str = "") -> dict:
    """Full profile row for sync export (users + federation_user_profiles)."""
    nick = str(nick_hint or "").strip()
    if not nick and int(user_id or 0) > 0:
        brief = db.get_user_by_id(int(user_id)) or {}
        nick = str(brief.get("nickname") or "").strip()
    if nick:
        return db.get_user_profile(nick) or {}
    if int(user_id or 0) > 0:
        return db.get_user_by_id(int(user_id)) or {}
    return {}


def _sanitize_sync_channel_theme(raw, room_type: str = "public") -> str | None:
    """Sanitize channel_theme JSON for federation account-sync export/apply."""
    raw_s = str(raw or "").strip()
    if not raw_s:
        return None
    rtype = str(room_type or "public").strip().lower()
    if rtype not in ("public", "private"):
        rtype = "public"
    try:
        from routers.rooms import _sanitize_channel_theme

        return _sanitize_channel_theme(raw_s, room_type=rtype)
    except Exception:
        return None


def _apply_sync_peer_profile_cache_from_export(payload: dict, source_server_id: str) -> int:
    """Upsert federation_user_profiles for all graph/roster peers in an export."""
    if not isinstance(payload, dict):
        return 0
    src = str(source_server_id or "").strip()
    seen: set[str] = set()
    applied = 0

    def _ingest(item: dict) -> None:
        nonlocal applied
        if not isinstance(item, dict):
            return
        gid = str(item.get("global_user_id") or "").strip()
        if not _GID_RE.match(gid) or gid in seen:
            return
        seen.add(gid)
        if _upsert_sync_peer_profile_cache(item, src):
            applied += 1
        try:
            row = db.find_user_by_global_id(gid) or {}
            uid = int(row.get("id") or 0)
            av = item.get("avatar")
            if uid > 0 and av:
                db.patch_sync_user_profile(
                    uid,
                    display_name=str(item.get("display_name") or ""),
                    avatar=av,
                )
        except Exception:
            pass

    for key in ("dm_peers", "following", "friends", "blocked_users"):
        for item in payload.get(key) or []:
            _ingest(item)
    for entry in payload.get("member_snapshots") or []:
        if not isinstance(entry, dict):
            continue
        for item in entry.get("members") or []:
            _ingest(item)
    return applied


def _sync_state_set(user_id: int, patch: dict) -> None:
    uid = int(user_id or 0)
    if uid <= 0:
        return
    now = int(time.time())
    with _sync_state_lock:
        cur = dict(_federation_sync_state.get(uid) or {})
        if _sync_persist_enabled() and not cur:
            cur = dict(db.get_user_federation_sync_state(uid) or {})
        cur.update(patch or {})
        cur["updated_at"] = now
        if "started_at" not in cur or not int(cur.get("started_at") or 0):
            cur["started_at"] = now
        src = str(cur.get("source_base") or cur.get("source_public_url") or "").strip()
        if src:
            cur["source_base"] = src
            cur["source_public_url"] = src
        _federation_sync_state[uid] = cur
    if _sync_persist_enabled():
        try:
            db.upsert_user_federation_sync_state(uid, cur)
        except Exception:
            pass


_SYNC_PHASES = (
    ("fetch", "Fetching from home node"),
    ("channels", "Channels"),
    ("directory", "Channel directory"),
    ("dms", "Direct messages"),
    ("social_graph", "Friends & follows"),
    ("profile", "Profile & settings"),
    ("social_posts", "FrogSocial posts"),
    ("push", "Notifications"),
    ("done", "Done"),
)


def _sync_state_get(user_id: int) -> dict:
    uid = int(user_id or 0)
    if uid <= 0:
        return {"in_progress": False, "done": False, "progress_pct": 0, "phases": []}
    with _sync_state_lock:
        cur = dict(_federation_sync_state.get(uid) or {})
    if not cur and _sync_persist_enabled():
        try:
            cur = dict(db.get_user_federation_sync_state(uid) or {})
            if cur:
                with _sync_state_lock:
                    _federation_sync_state[uid] = dict(cur)
        except Exception:
            cur = {}
    if not cur:
        return {"in_progress": False, "done": False, "progress_pct": 0, "phases": []}
    if "progress_pct" not in cur:
        cur["progress_pct"] = 100 if cur.get("done") else (50 if cur.get("in_progress") else 0)
    counters = dict(cur.get("counters") or {})
    totals = dict(cur.get("totals") or {})
    current_phase = str(cur.get("phase") or "")
    phases_out = []
    seen_current = False
    for key, label in _SYNC_PHASES:
        if key == current_phase:
            status = "active"
            seen_current = True
        elif cur.get("done"):
            status = "done"
        elif seen_current:
            status = "pending"
        else:
            status = "done"
        done_n = int(counters.get(key) or 0)
        total_n = int(totals.get(key) or 0)
        phases_out.append({
            "key": key,
            "label": label,
            "status": status,
            "done": done_n,
            "total": total_n,
        })
    cur["phases"] = phases_out
    return cur


def _resolve_server_id_for_base(base_url: str) -> str:
    base = _norm_base(base_url)
    if not base:
        return ""
    try:
        ident = db.get_or_create_local_server_identity() or {}
        local_sid = str(ident.get("server_id") or "").strip()
        local_base = _norm_base(str(ident.get("base_url") or ""))
        if local_sid and local_base and local_base == base:
            return local_sid
        for row in db.list_federation_servers(official_only=False):
            for key in ("base_url", "onion_url"):
                if _norm_base(str(row.get(key) or "")) == base:
                    return str(row.get("server_id") or "").strip()
    except Exception:
        pass
    return ""


def resolve_server_base_url(server_id: str) -> str:
    """Directory lookup: federation server_id → normalized base URL."""
    sid = str(server_id or "").strip()
    if not sid:
        return ""
    tor = os.getenv("FROGTALK_TOR_MODE", "").strip().lower() in ("1", "true", "yes")
    try:
        for row in db.list_federation_servers(official_only=False):
            if str(row.get("server_id") or "").strip() != sid:
                continue
            if tor:
                onion = _norm_base(str(row.get("onion_url") or ""))
                if onion:
                    return onion
            base = _norm_base(str(row.get("base_url") or ""))
            if base:
                return base
    except Exception:
        pass
    return ""


def resolve_account_home_base_url(user_id: int) -> tuple[str, str]:
    """Return (home_server_id, normalized_base_url) from pinned home + directory."""
    uid = int(user_id or 0)
    home_sid = db.get_user_account_home_server_id(uid) if uid > 0 else ""
    if not home_sid:
        try:
            st = db.get_user_federation_sync_state(uid) if uid > 0 else {}
            home_sid = str(st.get("source_server_id") or "").strip()
            fallback_url = _norm_base(str(st.get("source_public_url") or st.get("source_base") or ""))
            if home_sid and fallback_url:
                return home_sid, fallback_url
        except Exception:
            pass
        return "", ""
    base = resolve_server_base_url(home_sid)
    return home_sid, base


_profile_fetch_last: dict[str, float] = {}
_PROFILE_FETCH_MIN_INTERVAL = 300.0
_profile_card_fetch_last: dict[str, float] = {}
_PROFILE_CARD_MIN_INTERVAL = 45.0


def _federation_profile_payload_from_user_row(row, gid: str, origin_server_id: str) -> dict:
    """Public profile fields safe to mirror on peer nodes."""
    presence = str(row["presence"] or "offline").strip().lower()
    if presence not in ("online", "away", "dnd", "invisible", "offline"):
        presence = "offline"
    return {
        "global_user_id": gid,
        "nickname": str(row["nickname"] or "")[:64],
        "display_name": str(row["display_name"] or "")[:64],
        "avatar": str(row["avatar"] or "")[:256 * 1024],
        "bio": str(row["bio"] or "")[:500],
        "status_msg": str(row["status_msg"] or "")[:200],
        "mood": str(row["mood"] or "")[:200],
        "presence": presence,
        "custom_style": _sanitize_inline_style(str(row["custom_style"] or "")[:12000]),
        "banner": str(row["banner"] or "")[:500_000],
        "origin_server_id": origin_server_id,
    }


def _lookup_federation_profile_gid_payload(gid: str) -> dict | None:
    """Build federation-sync-profile-gid payload for a user on this node."""
    with db._conn() as con:
        row = con.execute(
            """
            SELECT id, nickname, display_name, avatar, bio, status_msg, mood, presence,
                   custom_style, banner
            FROM users WHERE global_user_id=? LIMIT 1
            """,
            (gid,),
        ).fetchone()
    if row:
        ident = db.get_or_create_local_server_identity() or {}
        origin = str(ident.get("server_id") or "").strip()
        return _federation_profile_payload_from_user_row(row, gid, origin)
    prof = db.get_federation_user_profile_row(gid) or {}
    if not prof:
        return None
    return {
        "global_user_id": gid,
        "nickname": str(prof.get("nickname") or "")[:64],
        "display_name": str(prof.get("display_name") or "")[:64],
        "avatar": str(prof.get("avatar") or "")[:256 * 1024],
        "bio": str(prof.get("bio") or "")[:500],
        "status_msg": str(prof.get("status_msg") or "")[:200],
        "mood": str(prof.get("mood") or "")[:200],
        "presence": str(prof.get("presence") or "offline")[:32],
        "custom_style": str(prof.get("custom_style") or "")[:12000],
        "banner": str(prof.get("banner") or "")[:500_000],
        "origin_server_id": str(prof.get("origin_server_id") or "").strip(),
    }


def _upsert_profile_cache_from_payload(payload: dict) -> None:
    if not isinstance(payload, dict):
        return
    gid = str(payload.get("global_user_id") or "").strip()
    nick = str(payload.get("nickname") or "").strip()
    if not gid or not nick:
        return
    try:
        db.upsert_federation_user_profile(
            gid,
            nick,
            display_name=str(payload.get("display_name") or "")[:64],
            avatar=payload.get("avatar") or "",
            bio=str(payload.get("bio") or "")[:500],
            origin_server_id=str(payload.get("origin_server_id") or "")[:128],
            status_msg=str(payload.get("status_msg") or "")[:200],
            mood=str(payload.get("mood") or "")[:200],
            presence=str(payload.get("presence") or "offline")[:32],
            custom_style=str(payload.get("custom_style") or "")[:12000],
            banner=str(payload.get("banner") or "")[:500_000],
        )
    except Exception:
        pass


def _fetch_home_profile_payload(gid: str, home_server_id: str) -> dict | None:
    home_sid = str(home_server_id or "").strip()
    if not home_sid:
        home_sid = str(db.get_federation_profile_origin(gid) or "").strip()
    if not home_sid:
        home_sid = str(db.resolve_global_user_home_server_id(gid) or "").strip()
    base = resolve_server_base_url(home_sid)
    if not base:
        return None
    fed = (os.getenv("FROGTALK_FEDERATION_TOKEN", "") or "").strip()
    if not fed:
        return None
    try:
        data = _post_json(
            f"{base}/api/auth/federation-sync-profile-gid",
            {"global_user_id": gid},
            headers={"X-Federation-Token": fed},
            timeout=5.0,
        )
    except Exception:
        return None
    return data if isinstance(data, dict) and data.get("nickname") else None


def _profile_cache_is_thin(prof: dict) -> bool:
    if not str(prof.get("nickname") or "").strip():
        return True
    if str(prof.get("avatar") or "").strip():
        return False
    if str(prof.get("status_msg") or "").strip() or str(prof.get("custom_style") or "").strip():
        return False
    return True


def _resolve_federated_subject_home(home_server_id: str, global_user_id: str) -> tuple[str, str]:
    """True home (server_id, base_url) for a federated profile subject.

    Avoids labelling a travel-node mirror as its own home when the local
    ``users`` row exists only for routing/DMs.
    """
    gid = str(global_user_id or "").strip()
    sid = str(home_server_id or "").strip()
    prof = db.get_federation_user_profile_row(gid) if gid else {}
    prof_origin = str((prof or {}).get("origin_server_id") or "").strip()
    if not sid:
        sid = prof_origin
    if not sid and gid:
        sid = str(db.resolve_global_user_home_server_id(gid) or "").strip()
    try:
        ident = db.get_or_create_local_server_identity() or {}
        local_sid = str(ident.get("server_id") or "").strip()
    except Exception:
        local_sid = ""
    if sid and local_sid and sid == local_sid and prof_origin and prof_origin != local_sid:
        sid = prof_origin
    return sid, resolve_server_base_url(sid)


def build_federation_profile_card(
    *,
    global_user_id: str = "",
    nickname: str = "",
    home_server_id: str = "",
    refresh: bool = False,
) -> dict:
    """Session-facing profile card: local user row, cache, or home fetch."""
    gid = str(global_user_id or "").strip()
    nick_hint = str(nickname or "").strip()
    if not _GID_RE.match(gid) and nick_hint:
        local = db.get_user_profile(nick_hint) or {}
        gid = str(local.get("global_user_id") or "").strip()
    if not _GID_RE.match(gid) and nick_hint:
        gid = db.find_federation_profile_gid_by_nickname(nick_hint)
    if not _GID_RE.match(gid):
        return {"error": "Profile not found", "code": "not_found"}

    home_sid = str(home_server_id or "").strip()
    home_unreachable = False
    source = "cache"

    local_row = db.find_user_by_global_id(gid) or {}
    local_uid = int(local_row.get("id") or 0)
    if local_uid > 0:
        with db._conn() as con:
            row = con.execute(
                """
                SELECT id, nickname, display_name, avatar, bio, status_msg, mood, presence,
                       custom_style, banner
                FROM users WHERE id=? LIMIT 1
                """,
                (local_uid,),
            ).fetchone()
        if row:
            ident = db.get_or_create_local_server_identity() or {}
            origin = str(ident.get("server_id") or "").strip()
            payload = _federation_profile_payload_from_user_row(row, gid, origin)
            payload["source"] = "local"
            payload["home_unreachable"] = False
            payload["local_user_id"] = local_uid
            sub_home_sid, sub_home_base = _resolve_federated_subject_home(home_sid, gid)
            payload["home_server_id"] = sub_home_sid
            payload["home_base_url"] = sub_home_base
            payload["wall_available"] = bool(sub_home_sid and sub_home_sid == origin)
            return payload

    cached = db.get_federation_user_profile_row(gid) or {}
    if not home_sid:
        home_sid = str(cached.get("origin_server_id") or "").strip()
    if not home_sid:
        home_sid = str(db.resolve_global_user_home_server_id(gid) or "").strip()

    now = time.time()
    need_fetch = bool(refresh) or _profile_cache_is_thin(cached)
    if need_fetch and (
        refresh or (now - float(_profile_card_fetch_last.get(gid) or 0) >= _PROFILE_CARD_MIN_INTERVAL)
    ):
        live = _fetch_home_profile_payload(gid, home_sid)
        _profile_card_fetch_last[gid] = now
        if live:
            _upsert_profile_cache_from_payload(live)
            cached = db.get_federation_user_profile_row(gid) or cached
            source = "live"
        else:
            home_unreachable = True
            source = "partial" if cached.get("nickname") else "cache"

    nick = str(cached.get("nickname") or nick_hint or "").strip()
    if not nick:
        return {"error": "profile_not_found", "code": "not_found", "home_unreachable": home_unreachable}

    sub_home_sid, sub_home_base = _resolve_federated_subject_home(home_sid, gid)
    return {
        "global_user_id": gid,
        "nickname": nick,
        "display_name": str(cached.get("display_name") or "")[:64],
        "avatar": str(cached.get("avatar") or "")[:256 * 1024],
        "bio": str(cached.get("bio") or "")[:500],
        "status_msg": str(cached.get("status_msg") or "")[:200],
        "mood": str(cached.get("mood") or "")[:200],
        "presence": str(cached.get("presence") or "offline")[:32],
        "custom_style": str(cached.get("custom_style") or "")[:12000],
        "banner": str(cached.get("banner") or "")[:500_000],
        "origin_server_id": str(cached.get("origin_server_id") or home_sid or "")[:128],
        "home_server_id": sub_home_sid,
        "home_base_url": sub_home_base,
        "source": source,
        "home_unreachable": home_unreachable,
        "local_user_id": None,
        "wall_available": False,
    }


def hydrate_federation_profile_from_home(global_user_id: str, home_server_id: str = "") -> bool:
    """Best-effort avatar/display fetch from user's home (rate-limited, SSRF-safe)."""
    gid = str(global_user_id or "").strip()
    if not gid or not _GID_RE.match(gid):
        return False
    home_sid = str(home_server_id or "").strip()
    if not home_sid:
        home_sid = str(db.get_federation_profile_origin(gid) or "").strip()
    if not home_sid:
        return False
    try:
        existing = db.get_federation_user_profile_row(gid) or {}
        if str(existing.get("avatar") or "").strip() and str(existing.get("status_msg") or "").strip():
            return False
    except Exception:
        existing = {}
    now = time.time()
    if now - float(_profile_fetch_last.get(gid) or 0) < _PROFILE_FETCH_MIN_INTERVAL:
        return False
    live = _fetch_home_profile_payload(gid, home_sid)
    _profile_fetch_last[gid] = now
    if not live:
        return False
    _upsert_profile_cache_from_payload(live)
    return True


def _resolve_sync_source_base(
    user_id: int,
    *,
    client_source_base: str = "",
    ticket: str = "",
    here_base: str = "",
) -> str:
    """Pick outbound sync URL: pinned home wins over client hint."""
    uid = int(user_id or 0)
    home_sid, home_base = resolve_account_home_base_url(uid)
    if home_base and _sync_bind_home_enabled():
        client = _norm_base(client_source_base)
        if client and client != home_base:
            _log.warning(
                "federation sync: ignoring client source_base=%s for uid=%s (home=%s)",
                client, uid, home_base,
            )
        return home_base
    raw_ticket = str(ticket or "").strip()
    if raw_ticket and not client_source_base and here_base:
        payload = _verify_federation_login_ticket(raw_ticket, here_base)
        if isinstance(payload, dict):
            return _norm_base(str(payload.get("src") or ""))
    return _norm_base(client_source_base)


def _sync_stale_hours() -> float:
    try:
        return max(0.0, float(os.getenv("FROGTALK_SYNC_STALE_HOURS", "0") or 0))
    except Exception:
        return 0.0


def _sync_stale_for_user(user_id: int) -> bool:
    """True when a previously completed sync is older than FROGTALK_SYNC_STALE_HOURS."""
    ttl_h = _sync_stale_hours()
    if ttl_h <= 0:
        return False
    uid = int(user_id or 0)
    if uid <= 0:
        return False
    st = _sync_state_get(uid)
    if not st.get("done") or str(st.get("error") or "").strip():
        return False
    finished = int(st.get("finished_at") or 0)
    if finished <= 0:
        return False
    return (time.time() - finished) > (ttl_h * 3600.0)


def _sync_incomplete_for_user(user_id: int) -> bool:
    uid = int(user_id or 0)
    if uid <= 0 or _user_at_account_home(uid):
        return False
    if _sync_stale_for_user(uid):
        return True
    st = _sync_state_get(uid)
    if str(st.get("error") or "").strip():
        return True
    if not st.get("done"):
        return True
    if str(st.get("social_posts_cursor") or "").strip():
        return True
    total = int(st.get("social_posts_total") or 0)
    imported = int(st.get("social_posts_imported") or 0)
    if total > imported:
        return True
    return False


def _sync_error_hint_public(err: str) -> str:
    """Map internal sync errors to short user-facing hints."""
    raw = str(err or "").strip().lower()
    if not raw:
        return ""
    if "export_unavailable" in raw or "connection" in raw or "timed out" in raw:
        return "Home node unreachable — check it is online and in your federation directory."
    if "missing source node" in raw or "home not in directory" in raw:
        return "Home node URL unknown — add your home server under Federation settings, then re-sync."
    if "export_source_server_mismatch" in raw or "export_source_url_mismatch" in raw:
        return "Sync rejected: home server identity did not match. Use Re-sync from home."
    if "export_gid_mismatch" in raw:
        return "Sync rejected: account identity mismatch."
    if "invalid federation token" in raw:
        return "Federation token misconfigured on this node — contact the operator."
    return str(err)[:200]


def _verify_sync_export(
    export: dict,
    *,
    user_id: int,
    fetch_origin: str,
) -> None:
    if not _sync_verify_export_enabled():
        return
    payload = export if isinstance(export, dict) else {}
    uid = int(user_id or 0)
    me = db.get_user_by_id(uid) or {}
    gid = str(me.get("global_user_id") or "").strip()
    exp_gid = str(payload.get("global_user_id") or gid).strip()
    if gid and exp_gid and gid != exp_gid:
        raise ValueError("export_gid_mismatch")
    home_sid = db.get_user_account_home_server_id(uid)
    src_sid = str(payload.get("source_server_id") or "").strip()
    if home_sid:
        if src_sid and src_sid != home_sid:
            raise ValueError("export_source_server_mismatch")
    elif src_sid and uid > 0:
        db.set_user_account_home_server_id(uid, src_sid, force=False)
    src_url = _norm_base(str(payload.get("source_public_url") or ""))
    origin = _norm_base(fetch_origin)
    if src_url and origin and src_url != origin:
        raise ValueError("export_source_url_mismatch")
    sig_b64 = str(payload.get("export_sig_b64") or "").strip()
    if sig_b64 and src_sid:
        pem = str(db.get_federation_server_pubkey(src_sid) or "").strip()
        if pem:
            try:
                import crypto_fed as _cf

                if not _cf.verify_sync_export_signature(payload, pem):
                    raise ValueError("export_signature_invalid")
            except ValueError:
                raise
            except Exception:
                raise ValueError("export_signature_invalid") from None


def _account_home_server_id(user_id: int) -> str:
    """Federation home server for account-sync gating (not call routing)."""
    ident = db.get_or_create_local_server_identity() or {}
    local_sid = str(ident.get("server_id") or "").strip()
    uid = int(user_id or 0)
    if uid <= 0:
        return local_sid
    pinned = db.get_user_account_home_server_id(uid)
    if pinned:
        return pinned
    sync = _sync_state_get(uid)
    src = _norm_base(str(sync.get("source_base") or sync.get("source_public_url") or ""))
    if src:
        try:
            for row in db.list_federation_servers(official_only=False):
                for key in ("base_url", "onion_url"):
                    if _norm_base(str(row.get(key) or "")) == src:
                        sid = str(row.get("server_id") or "").strip()
                        if sid:
                            return sid
        except Exception:
            pass
    return local_sid


def _user_at_account_home(user_id: int) -> bool:
    """True when the signed-in user is on the node that owns their account."""
    ident = db.get_or_create_local_server_identity() or {}
    local_sid = str(ident.get("server_id") or "").strip()
    if not local_sid:
        return True
    pinned = db.get_user_account_home_server_id(int(user_id or 0))
    if not pinned:
        return False
    return pinned == local_sid


def _sync_state_for_user(user_id: int) -> dict:
    """Return federation sync state, suppressed when already on home node."""
    uid = int(user_id or 0)
    if uid <= 0:
        return {"in_progress": False, "done": False, "progress_pct": 0, "phases": []}
    if _user_at_account_home(uid):
        _clear_federation_sync_state(uid)
        return {
            "in_progress": False,
            "done": False,
            "progress_pct": 0,
            "phases": [],
            "at_home_node": True,
            "skipped": True,
        }
    return _sync_state_get(uid)


def _sync_progress(user_id: int, pct: int, hint: str, phase: str = "",
                   counters: dict | None = None, totals: dict | None = None) -> None:
    uid = int(user_id or 0)
    if uid <= 0:
        return
    patch = {
        "in_progress": True,
        "done": False,
        "progress_pct": max(0, min(100, int(pct))),
        "phase": str(phase or "")[:64],
        "hint": str(hint or "")[:220],
    }
    if counters:
        with _sync_state_lock:
            cur = dict(_federation_sync_state.get(uid) or {})
            merged = dict(cur.get("counters") or {})
            merged.update({k: int(v or 0) for k, v in (counters or {}).items()})
            patch["counters"] = merged
    if totals:
        with _sync_state_lock:
            cur = dict(_federation_sync_state.get(uid) or {})
            merged = dict(cur.get("totals") or {})
            merged.update({k: int(v or 0) for k, v in (totals or {}).items()})
            patch["totals"] = merged
    _sync_state_set(uid, patch)


def _export_social_post_rows(
    uid: int,
    post_ids: list[int],
    source_server_id: str,
    my_gid: str,
) -> tuple[list[dict], int]:
    import base64 as _b64_sync

    social_posts: list[dict] = []
    social_posts_omitted_at_export = 0
    seen_post_gids: set[str] = set()
    for post_id in post_ids:
        try:
            with db._conn() as con:
                row = con.execute(
                    """
                    SELECT wp.*, u.nickname, u.avatar, u.display_name
                    FROM wall_posts wp
                    JOIN users u ON u.id = wp.user_id
                    WHERE wp.id=?
                    """,
                    (post_id,),
                ).fetchone()
            post = dict(row) if row else None
        except Exception:
            post = None
        if not post:
            continue
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
        if not post_gid or post_gid in seen_post_gids:
            continue
        seen_post_gids.add(post_gid)
        privacy = str(post.get("privacy") or "public").strip().lower()
        if privacy not in ("public", "followers", "friends"):
            privacy = "public"
        enc_v = int(post.get("enc_v") or 0)
        media_data, media_type = _sanitize_sync_media(post.get("media_data"), post.get("media_type"))
        post_origin_sid = str(post_origin or source_server_id or "").strip()
        item: dict = {
            "global_post_id": post_gid,
            "origin_server_id": post_origin_sid,
            "author_home_server_id": _peer_home_server_id_for_sync(author_gid, post_origin_sid),
            "author_global_user_id": author_gid,
            "nickname": author_nick,
            "author_display_name": str(post.get("display_name") or author.get("display_name") or "")[:64],
            "author_avatar": (post.get("avatar") or author.get("avatar") or ""),
            "content": str(post.get("content") or "")[:4000],
            "media_data": media_data,
            "media_type": media_type,
            "privacy": privacy,
            "share_enabled": 1 if bool(post.get("share_enabled", True)) else 0,
            "allow_comments": 1 if bool(post.get("allow_comments", True)) else 0,
            "track_title": str(post.get("track_title") or "")[:160],
            "track_room": str(post.get("track_room") or "")[:64],
            "track_mood": str(post.get("track_mood") or "")[:32],
            "created_at": str(post.get("created_at") or "")[:64],
            "enc_v": enc_v,
        }
        if enc_v == 2:
            item["content"] = ""
            item["audience"] = str(post.get("audience") or privacy or "followers").strip().lower()[:32]
            ct = post.get("ciphertext")
            if ct is not None:
                try:
                    item["ciphertext_b64"] = _b64_sync.b64encode(bytes(ct)).decode("ascii")
                except Exception:
                    continue
            wraps: list[dict] = []
            if my_gid and _GID_RE.match(my_gid):
                try:
                    with db._conn() as con:
                        wk = con.execute(
                            "SELECT wrapped_key FROM wall_post_keys WHERE post_id=? AND recipient_id=?",
                            (post_id, uid),
                        ).fetchone()
                    if wk and wk["wrapped_key"]:
                        wraps.append({
                            "recipient_global_user_id": my_gid,
                            "wrapped_b64": _b64_sync.b64encode(bytes(wk["wrapped_key"])).decode("ascii"),
                        })
                except Exception:
                    pass
            if wraps:
                item["wrapped_keys"] = wraps
            elif author_id != uid:
                social_posts_omitted_at_export += 1
                continue
        social_posts.append(item)
    return social_posts, social_posts_omitted_at_export


def _ordered_sync_social_post_ids(uid: int) -> list[int]:
    """Collect wall post ids for export, newest first."""
    post_ids: list[int] = []

    def _queue_post_id(pid: int) -> None:
        try:
            n = int(pid or 0)
        except Exception:
            return
        if n > 0 and n not in post_ids and len(post_ids) < _SYNC_EXPORT_SOCIAL_ID_CAP:
            post_ids.append(n)

    try:
        with db._conn() as con:
            own_rows = con.execute(
                """
                SELECT wp.id FROM wall_posts wp
                WHERE wp.user_id=?
                ORDER BY wp.created_at DESC
                LIMIT ?
                """,
                (uid, _SYNC_EXPORT_SOCIAL_ID_CAP),
            ).fetchall()
        for r in own_rows:
            _queue_post_id(int(r["id"]))
    except Exception:
        pass
    try:
        for row in db.get_feed_posts(uid, limit=_SYNC_EXPORT_SOCIAL_ID_CAP, offset=0, mood="", lite=False):
            _queue_post_id(int(row.get("id") or 0))
    except Exception:
        pass
    try:
        for row in db.get_explore_posts(
            uid, limit=_SYNC_EXPORT_EXPLORE_POST_LIMIT, offset=0, sort="new", lite=False,
        ):
            _queue_post_id(int(row.get("id") or 0))
    except Exception:
        pass
    try:
        with db._conn() as con:
            reel_rows = con.execute(
                """
                SELECT wp.id FROM wall_posts wp
                WHERE wp.privacy='public'
                  AND wp.media_type LIKE 'video/%'
                ORDER BY wp.created_at DESC
                LIMIT ?
                """,
                (_SYNC_EXPORT_EXPLORE_POST_LIMIT,),
            ).fetchall()
        for r in reel_rows:
            _queue_post_id(int(r["id"]))
    except Exception:
        pass
    if not post_ids:
        return []
    try:
        with db._conn() as con:
            placeholders = ",".join("?" * len(post_ids))
            rows = con.execute(
                f"SELECT id, created_at FROM wall_posts WHERE id IN ({placeholders})",
                post_ids,
            ).fetchall()
        keyed = [(str(r["created_at"] or ""), int(r["id"])) for r in rows]
        keyed.sort(reverse=True)
        return [pid for _, pid in keyed]
    except Exception:
        return post_ids


def _paginate_ordered_post_ids(
    ordered_ids: list[int],
    cursor: str,
    page_size: int,
) -> tuple[list[int], bool, str]:
    start = 0
    cur = str(cursor or "").strip()
    if cur and "|" in cur:
        try:
            cur_id = int(cur.rsplit("|", 1)[1])
            for i, pid in enumerate(ordered_ids):
                if pid == cur_id:
                    start = i + 1
                    break
        except Exception:
            start = 0
    page = ordered_ids[start:start + page_size]
    has_more = (start + page_size) < len(ordered_ids)
    next_cursor = ""
    if has_more and page:
        last_id = int(page[-1])
        created = ""
        try:
            with db._conn() as con:
                row = con.execute(
                    "SELECT created_at FROM wall_posts WHERE id=?",
                    (last_id,),
                ).fetchone()
            if row:
                created = str(row["created_at"] or "")
        except Exception:
            created = ""
        next_cursor = f"{created}|{last_id}" if created else f"|{last_id}"
    return page, has_more, next_cursor


def _build_sync_export_for_user(user_id: int, *, social_posts_cursor: str = "") -> dict:
    uid = int(user_id or 0)
    if uid <= 0:
        return {"rooms": [], "dm_peers": [], "source_server_id": ""}
    try:
        ident = db.get_or_create_local_server_identity() or {}
        source_server_id = str(ident.get("server_id") or "").strip()
    except Exception:
        source_server_id = ""
    me_row = db.get_user_by_id(uid) or {}
    my_gid = str(me_row.get("global_user_id") or "").strip()
    cursor = str(social_posts_cursor or "").strip()
    posts_only = bool(cursor)
    source_public_url = ""
    try:
        import os as _os_sync
        source_public_url = str(_os_sync.environ.get("SITE_URL") or "").strip()[:256]
    except Exception:
        source_public_url = ""
    if not source_public_url:
        try:
            source_public_url = _norm_base(str(ident.get("base_url") or ""))[:256]
        except Exception:
            source_public_url = ""

    ordered_post_ids = _ordered_sync_social_post_ids(uid)
    page_post_ids: list[int] = []
    social_posts_has_more = False
    social_posts_next_cursor = ""
    if ordered_post_ids:
        if _sync_pagination_enabled():
            page_post_ids, social_posts_has_more, social_posts_next_cursor = _paginate_ordered_post_ids(
                ordered_post_ids, cursor, _SYNC_EXPORT_SOCIAL_POST_LIMIT,
            )
        else:
            page_post_ids = ordered_post_ids[:_SYNC_EXPORT_SOCIAL_POST_LIMIT]
            social_posts_has_more = len(ordered_post_ids) > len(page_post_ids)

    if posts_only:
        social_posts, social_posts_omitted_at_export = _export_social_post_rows(
            uid, page_post_ids, source_server_id, my_gid,
        )
        return _attach_sync_export_signature({
            "export_version": _SYNC_EXPORT_VERSION,
            "sync_export_page": "social",
            "global_user_id": my_gid,
            "social_posts": social_posts,
            "social_posts_omitted_at_export": social_posts_omitted_at_export,
            "social_posts_has_more": social_posts_has_more,
            "social_posts_next_cursor": social_posts_next_cursor,
            "social_posts_total": len(ordered_post_ids),
            "source_server_id": source_server_id,
            "source_public_url": source_public_url,
            "issued_at": int(time.time()),
            "exported_at": int(time.time()),
        })

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
        owner_nick = ""
        owner_gid = ""
        try:
            if room.get("owner_id"):
                owner_row = db.get_user_by_id(int(room.get("owner_id"))) or {}
                owner_nick = str(owner_row.get("nickname") or "")[:64]
                owner_gid = str(owner_row.get("global_user_id") or "")[:64]
        except Exception:
            owner_nick = ""
            owner_gid = ""
        vanity = str(room.get("vanity") or "").strip().lower()[:32]
        room_payload = {
            "name": name,
            "type": rtype,
            "channel_type": ctype,
            "description": str(room.get("description") or "")[:200],
            "directory_description": str(room.get("directory_description") or "")[:1200],
            "category": str(room.get("category") or "")[:32],
            "tags": str(room.get("tags") or "[]")[:2000],
            "icon": _sanitize_sync_room_icon(room.get("icon")),
            "member_count": int(room.get("member_count") or 0),
            "owner_nickname": owner_nick,
            "owner_global_user_id": owner_gid,
            "vanity": vanity,
        }
        sync_theme = _sanitize_sync_channel_theme(room.get("channel_theme"), rtype)
        if sync_theme:
            room_payload["channel_theme"] = sync_theme
        if rtype == "public" and len(public_rooms) < _SYNC_EXPORT_PUBLIC_ROOM_LIMIT:
            public_rooms.append(room_payload)
        if room.get("id") in joined_ids:
            rooms.append(room_payload)
            if len(rooms) >= _SYNC_EXPORT_ROOM_LIMIT:
                # Keep collecting public room directory even if joined-room cap reached.
                continue

    dm_peers: list[dict] = []
    for ch in db.get_dm_channels_for_sync(uid):
        other_id = int(ch.get("other_id") or 0)
        if other_id <= 0:
            continue
        peer = _sync_peer_profile_row(other_id)
        nick = str(peer.get("nickname") or "").strip()
        gid = str(peer.get("global_user_id") or "").strip()
        if not nick or not _GID_RE.match(gid):
            continue
        dm_peers.append({
            "nickname": nick,
            "global_user_id": gid,
            "home_server_id": _peer_home_server_id_for_sync(gid, source_server_id),
            "avatar": peer.get("avatar") or "",
            "display_name": str(peer.get("display_name") or "")[:64],
            "status_msg": str(peer.get("status_msg") or "")[:200],
            "mood": str(peer.get("mood") or "")[:200],
            "presence": str(peer.get("presence") or "offline")[:32],
            "custom_style": _sanitize_inline_style(str(peer.get("custom_style") or "")[:12000]),
        })
        if len(dm_peers) >= _SYNC_EXPORT_DM_LIMIT:
            break

    following: list[dict] = []
    for row in db.get_following_list(uid, limit=_SYNC_EXPORT_DM_LIMIT):
        raw_id = int((row or {}).get("id") or 0)
        nick_hint = str((row or {}).get("nickname") or "").strip()
        profile = _sync_peer_profile_row(raw_id, nick_hint)
        gid = str((profile or {}).get("global_user_id") or "").strip()
        nick = str((profile or {}).get("nickname") or nick_hint or "").strip()
        if not nick or not _GID_RE.match(gid):
            continue
        following.append({
            "nickname": nick,
            "global_user_id": gid,
            "home_server_id": _peer_home_server_id_for_sync(gid, source_server_id),
            "avatar": (profile or {}).get("avatar") or (row or {}).get("avatar") or "",
            "display_name": str((profile or {}).get("display_name") or "")[:64],
            "status_msg": str((profile or {}).get("status_msg") or "")[:200],
            "mood": str((profile or {}).get("mood") or "")[:200],
            "presence": str((profile or {}).get("presence") or "offline")[:32],
            "custom_style": _sanitize_inline_style(str((profile or {}).get("custom_style") or "")[:12000]),
            "banner": str((profile or {}).get("banner") or "")[:500_000],
        })

    friends: list[dict] = []
    for row in db.get_friends(uid):
        raw_id = int((row or {}).get("id") or 0)
        nick_hint = str((row or {}).get("nickname") or "").strip()
        profile = _sync_peer_profile_row(raw_id, nick_hint)
        gid = str((profile or {}).get("global_user_id") or "").strip()
        nick = str((profile or {}).get("nickname") or nick_hint or "").strip()
        if not nick or not _GID_RE.match(gid):
            continue
        friends.append({
            "nickname": nick,
            "global_user_id": gid,
            "home_server_id": _peer_home_server_id_for_sync(gid, source_server_id),
            "avatar": (profile or {}).get("avatar") or (row or {}).get("avatar") or "",
            "display_name": str((profile or {}).get("display_name") or "")[:64],
            "status_msg": str((profile or {}).get("status_msg") or "")[:200],
            "mood": str((profile or {}).get("mood") or "")[:200],
            "presence": str((profile or {}).get("presence") or "offline")[:32],
            "custom_style": _sanitize_inline_style(str((profile or {}).get("custom_style") or "")[:12000]),
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
            "home_server_id": _peer_home_server_id_for_sync(blocked_gid, source_server_id),
        })
        if len(blocked_users) >= _SYNC_EXPORT_BLOCKED_LIMIT:
            break

    social_posts, social_posts_omitted_at_export = _export_social_post_rows(
        uid, page_post_ids, source_server_id, my_gid,
    )

    # Recent room history per joined room. We export plain message rows
    # without media_data — the destination node lazy-loads media on demand
    # (and the source node still enforces room access there). Tombstoned
    # rows are skipped because they should already be invisible to peers.
    room_histories: list[dict] = []
    history_rooms_done = 0
    for raw in rooms:
        if history_rooms_done >= _SYNC_EXPORT_HISTORY_TOTAL_ROOMS:
            break
        name = str(raw.get("name") or "").strip().lower()
        if not _ROOM_NAME_RE.match(name):
            continue
        try:
            msgs = db.get_messages(name, limit=_SYNC_EXPORT_HISTORY_PER_ROOM) or []
        except Exception:
            msgs = []
        if not msgs:
            continue
        clean: list[dict] = []
        for m in msgs:
            try:
                mid = int(m.get("id") or 0)
            except Exception:
                mid = 0
            if mid <= 0:
                continue
            nick = str(m.get("nickname") or "").strip()
            if not nick:
                continue
            sender_gid = ""
            try:
                author = db.get_user_by_id(int(m.get("user_id") or 0)) or {}
                sender_gid = str(author.get("global_user_id") or "").strip()
            except Exception:
                sender_gid = ""
            clean.append({
                "id": mid,
                "nickname": nick[:64],
                "sender_global_user_id": sender_gid[:128],
                "display_name": str(m.get("display_name") or "")[:64],
                "content": str(m.get("content") or "")[:10_000],
                "media_type": str(m.get("media_type") or "")[:64] or None,
                "has_media": bool(m.get("has_media")),
                "media_blur": int(m.get("media_blur") or 0),
                "view_once": int(m.get("view_once") or 0),
                "key_version": int(m.get("key_version") or 0),
                "edited": bool(m.get("edited")),
                "created_at": str(m.get("created_at") or ""),
                "system_kind": str(m.get("system_kind") or "")[:32] or None,
                "bridge_platform": str(m.get("bridge_platform") or "")[:32] or None,
                "avatar": str(m.get("avatar") or "")[:200_000],
            })
        if clean:
            room_histories.append({"room_name": name, "messages": clean})
            history_rooms_done += 1

    # Recent DM history per DM channel. DMs are end-to-end encrypted —
    # the content stays as opaque ciphertext on the wire so we never
    # expose plaintext through federation. The destination decrypts with
    # the keys the receiving user already holds (X3DH/identity prekey).
    dm_histories: list[dict] = []
    dm_history_count = 0
    try:
        dm_channels_for_history = db.get_dm_channels_for_sync(uid)
    except Exception:
        dm_channels_for_history = []
    for ch in dm_channels_for_history:
        if dm_history_count >= _SYNC_EXPORT_DM_HISTORY_TOTAL_CHANNELS:
            break
        cid = int(ch.get("id") or 0)
        other_id = int(ch.get("other_id") or 0)
        if cid <= 0 or other_id <= 0:
            continue
        peer = db.get_user_by_id(other_id) or {}
        peer_gid = str(peer.get("global_user_id") or "").strip()
        peer_nick = str(peer.get("nickname") or "").strip()
        if not peer_gid or not _GID_RE.match(peer_gid):
            continue
        try:
            msgs, ok = db.get_dm_messages(cid, uid, _SYNC_EXPORT_DM_HISTORY_PER_CHANNEL)
        except Exception:
            msgs, ok = [], False
        if not ok or not msgs:
            continue
        clean: list[dict] = []
        for m in msgs:
            try:
                mid = int(m.get("id") or 0)
            except Exception:
                mid = 0
            if mid <= 0:
                continue
            sender_id = int(m.get("sender_id") or 0)
            is_self = sender_id == uid
            clean.append({
                "id": mid,
                "from_self": bool(is_self),
                "content": str(m.get("content") or "")[:20_000],
                "media_type": str(m.get("media_type") or "")[:64] or None,
                "media_name": str(m.get("media_name") or "")[:200] or None,
                "has_media": bool(m.get("has_media")),
                "media_blur": int(m.get("media_blur") or 0),
                "view_once": int(m.get("view_once") or 0),
                "edited": bool(m.get("edited")),
                "deleted": bool(m.get("deleted")),
                "created_at": str(m.get("created_at") or ""),
                "key_version": int(m.get("key_version") or 0),
            })
        if clean:
            dm_histories.append({
                "peer_global_user_id": peer_gid,
                "peer_nickname": peer_nick,
                "messages": clean,
            })
            dm_history_count += 1

    room_member_snapshots: list[dict] = []
    member_rooms_done = 0
    for raw in rooms:
        if member_rooms_done >= _SYNC_EXPORT_MEMBER_ROOM_LIMIT:
            break
        name = str(raw.get("name") or "").strip().lower()
        if not _ROOM_NAME_RE.match(name):
            continue
        room = db.get_room_by_name(name)
        if not room:
            continue
        try:
            members = db.get_channel_members(int(room["id"])) or []
        except Exception:
            members = []
        if not members:
            continue
        snap: list[dict] = []
        for m in members[:_SYNC_EXPORT_MEMBERS_PER_ROOM]:
            nick = str(m.get("nickname") or "").strip()
            if not nick:
                continue
            gid = str(m.get("global_user_id") or "").strip()
            if not gid or not _GID_RE.match(gid):
                continue
            role = "member"
            try:
                if int(room.get("owner_id") or 0) == int(m.get("user_id") or 0):
                    role = "owner"
            except Exception:
                role = "member"
            snap.append({
                "global_user_id": gid,
                "nickname": nick[:64],
                "display_name": str(m.get("display_name") or "")[:64],
                "avatar": str(m.get("avatar") or "")[:200_000],
                "role": role,
                "home_server_id": _peer_home_server_id_for_sync(gid, source_server_id),
                "status_msg": str(m.get("status_msg") or "")[:200],
                "mood": str(m.get("mood") or "")[:200],
                "presence": str(m.get("presence") or "offline")[:32],
            })
        if snap:
            room_member_snapshots.append({"room_name": name, "members": snap})
            member_rooms_done += 1

    return _attach_sync_export_signature({
        "export_version": _SYNC_EXPORT_VERSION,
        "sync_export_page": "full",
        "global_user_id": my_gid,
        "rooms": rooms,
        "public_rooms": public_rooms,
        "dm_peers": dm_peers,
        "room_histories": room_histories,
        "dm_histories": dm_histories,
        "room_member_snapshots": room_member_snapshots,
        "following": following,
        "friends": friends,
        "blocked_users": blocked_users,
        "social_posts": social_posts,
        "social_posts_omitted_at_export": social_posts_omitted_at_export,
        "social_posts_has_more": social_posts_has_more,
        "social_posts_next_cursor": social_posts_next_cursor,
        "social_posts_total": len(ordered_post_ids),
        "self_profile": self_profile,
        "push_tokens": push_tokens,
        "source_server_id": source_server_id,
        "source_public_url": source_public_url,
        "issued_at": int(time.time()),
        "exported_at": int(time.time()),
    })


def _apply_sync_social_posts_only(user_id: int, export: dict) -> dict:
    """Import a paginated social-post chunk (rooms/graph already applied)."""
    uid = int(user_id or 0)
    payload = export if isinstance(export, dict) else {}
    source_server_id = str(payload.get("source_server_id") or "").strip()
    social_posts_in = payload.get("social_posts")
    social_posts = social_posts_in if isinstance(social_posts_in, list) else []
    social_posts_imported = 0
    social_posts_skipped = 0
    social_posts_omitted_at_export = int(payload.get("social_posts_omitted_at_export") or 0)
    n_social = len(social_posts[:_SYNC_EXPORT_SOCIAL_POST_LIMIT])
    me = db.get_user_by_id(uid) or {}
    my_gid = str(me.get("global_user_id") or "").strip()

    for row in social_posts[:_SYNC_EXPORT_SOCIAL_POST_LIMIT]:
        if not isinstance(row, dict):
            continue
        payload_post = {
            "global_post_id": str(row.get("global_post_id") or "").strip(),
            "author_global_user_id": str(row.get("author_global_user_id") or "").strip(),
            "nickname": str(row.get("nickname") or "").strip(),
            "author_display_name": str(row.get("author_display_name") or "")[:64],
            "author_avatar": row.get("author_avatar"),
            "content": str(row.get("content") or "")[:4000],
            "media_data": row.get("media_data"),
            "media_type": row.get("media_type"),
            "privacy": str(row.get("privacy") or "public").strip().lower(),
            "share_enabled": 1 if bool(row.get("share_enabled", True)) else 0,
            "allow_comments": 1 if bool(row.get("allow_comments", True)) else 0,
            "track_title": str(row.get("track_title") or "")[:160],
            "track_room": str(row.get("track_room") or "")[:64],
            "track_mood": str(row.get("track_mood") or "")[:32],
            "created_at": str(row.get("created_at") or "")[:64],
            "enc_v": int(row.get("enc_v") or 0),
            "audience": str(row.get("audience") or row.get("privacy") or "")[:32],
            "ciphertext_b64": str(row.get("ciphertext_b64") or ""),
            "wrapped_keys": row.get("wrapped_keys") if isinstance(row.get("wrapped_keys"), list) else [],
        }
        payload_post["media_data"], payload_post["media_type"] = _sanitize_sync_media(
            payload_post.get("media_data"),
            payload_post.get("media_type"),
        )
        post_origin = str(row.get("origin_server_id") or source_server_id or "").strip()
        if not post_origin or not payload_post["global_post_id"] or not payload_post["author_global_user_id"]:
            social_posts_skipped += 1
            continue
        author_home = str(row.get("author_home_server_id") or post_origin or "").strip()
        if author_home:
            try:
                db.upsert_federation_user_profile(
                    payload_post["author_global_user_id"],
                    payload_post["nickname"],
                    display_name=str(payload_post.get("author_display_name") or "")[:64],
                    avatar=payload_post.get("author_avatar") or "",
                    origin_server_id=author_home,
                )
            except Exception:
                pass
        try:
            existed = db.resolve_federation_wall_local_id(
                post_origin, "post", payload_post["global_post_id"],
            )
            created = db.apply_synced_social_post(
                payload_post, post_origin, viewer_user_id=uid,
            )
            if created and not existed:
                social_posts_imported += 1
            elif not created and not existed:
                social_posts_skipped += 1
        except Exception:
            social_posts_skipped += 1
    try:
        db.relink_wall_posts_to_account(uid)
    except Exception:
        pass
    return {
        "social_posts_imported": social_posts_imported,
        "social_posts_skipped": social_posts_skipped,
        "social_posts_omitted_at_export": social_posts_omitted_at_export,
        "social_posts_total": int(payload.get("social_posts_total") or 0),
    }


def _apply_sync_export_to_user(user_id: int, export: dict, *, fetch_origin: str = "") -> dict:
    uid = int(user_id or 0)
    if uid <= 0:
        return {"rooms_joined": 0, "rooms_missing": 0, "dm_linked": 0}

    payload = export if isinstance(export, dict) else {}
    if str(payload.get("sync_export_page") or "").strip().lower() == "social":
        return _apply_sync_social_posts_only(uid, payload)
    if fetch_origin:
        try:
            _verify_sync_export(payload, user_id=uid, fetch_origin=fetch_origin)
        except ValueError as e:
            return {
                "rooms_joined": 0,
                "rooms_missing": 0,
                "dm_linked": 0,
                "error": str(e)[:120],
            }
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
    room_histories_in = payload.get("room_histories")
    dm_histories_in = payload.get("dm_histories")
    member_snaps_in = payload.get("room_member_snapshots")
    rooms = rooms_in if isinstance(rooms_in, list) else []
    public_rooms = public_rooms_in if isinstance(public_rooms_in, list) else []
    dm_peers = dm_in if isinstance(dm_in, list) else []
    following = following_in if isinstance(following_in, list) else []
    friends = friends_in if isinstance(friends_in, list) else []
    blocked_users = blocked_in if isinstance(blocked_in, list) else []
    social_posts = social_posts_in if isinstance(social_posts_in, list) else []
    push_tokens = push_tokens_in if isinstance(push_tokens_in, list) else []
    room_histories = room_histories_in if isinstance(room_histories_in, list) else []
    dm_histories = dm_histories_in if isinstance(dm_histories_in, list) else []
    member_snaps = member_snaps_in if isinstance(member_snaps_in, list) else []

    ident = db.get_or_create_local_server_identity() or {}
    local_sid = str(ident.get("server_id") or "").strip()
    if source_server_id and source_server_id != local_sid:
        pinned = db.get_user_account_home_server_id(uid)
        if not pinned:
            db.set_user_account_home_server_id(uid, source_server_id, force=False)
        elif pinned != source_server_id:
            _log.warning(
                "federation sync: refusing home repin uid=%s from %s to %s",
                uid, pinned, source_server_id,
            )

    source_public_url = str(payload.get("source_public_url") or "").strip()[:256]

    rooms_joined = 0
    rooms_missing = 0
    rooms_name_collisions = 0
    vanity_collisions = 0
    users_nick_collisions = 0
    dm_linked = 0
    following_linked = 0
    friends_linked = 0
    blocked_linked = 0
    push_tokens_linked = 0
    social_posts_imported = 0
    social_posts_skipped = 0
    social_posts_omitted_at_export = int(payload.get("social_posts_omitted_at_export") or 0)
    history_messages_applied = 0
    dm_history_messages_applied = 0
    members_snapshots_applied = 0
    me = db.get_user_by_id(uid) or {}
    my_gid = str(me.get("global_user_id") or "").strip()

    keep_room_names: set[str] = set()
    for raw in rooms[:_SYNC_EXPORT_ROOM_LIMIT]:
        if isinstance(raw, dict):
            nm = str(raw.get("name") or "").strip().lower()
        else:
            nm = str(raw or "").strip().lower()
        if nm and _ROOM_NAME_RE.match(nm):
            keep_room_names.add(nm)

    try:
        db.prune_federation_sync_room_shells(keep_room_names)
    except Exception:
        pass

    rooms_pruned = 0
    try:
        rooms_pruned = int(db.apply_sync_room_allowlist(uid, keep_room_names) or 0)
    except Exception:
        rooms_pruned = 0

    n_rooms = len(rooms[:_SYNC_EXPORT_ROOM_LIMIT])
    n_public = len(public_rooms[:_SYNC_EXPORT_PUBLIC_ROOM_LIMIT])
    n_dms = len(dm_peers[:_SYNC_EXPORT_DM_LIMIT])
    n_follow = len(following[:_SYNC_EXPORT_DM_LIMIT])
    n_friends = len(friends[:_SYNC_EXPORT_DM_LIMIT])
    n_blocked = len(blocked_users[:_SYNC_EXPORT_BLOCKED_LIMIT])
    n_social = len(social_posts[:_SYNC_EXPORT_SOCIAL_POST_LIMIT])
    n_push = len(push_tokens[:24])
    n_history_rooms_cap = len(room_histories[:_SYNC_EXPORT_HISTORY_TOTAL_ROOMS])
    n_dm_history_cap = len(dm_histories[:_SYNC_EXPORT_DM_HISTORY_TOTAL_CHANNELS])
    n_member_snaps = len(member_snaps[:_SYNC_EXPORT_MEMBER_ROOM_LIMIT])
    work_units = (
        n_rooms + n_public + n_dms + n_follow + n_friends + n_blocked + n_social + n_push
        + n_history_rooms_cap + n_dm_history_cap + n_member_snaps + 1
    )
    done_units = 0

    _sync_progress(uid, 12, "Importing your channels…", "channels", totals={
        "channels": n_rooms,
        "directory": n_public,
        "dms": n_dms,
        "social_graph": n_follow + n_friends + n_blocked,
        "profile": 1,
        "social_posts": n_social,
        "push": n_push,
        "messages": n_history_rooms_cap,
        "dm_messages": n_dm_history_cap,
        "members": n_member_snaps,
    })

    def _sync_step(phase: str, hint: str, counter_key: str | None = None, counter_value: int | None = None) -> None:
        nonlocal done_units
        done_units += 1
        pct = 12 + int(83 * done_units / max(work_units, 1))
        counters = {counter_key: counter_value} if counter_key else None
        _sync_progress(uid, pct, hint, phase, counters=counters)

    for raw in rooms[:_SYNC_EXPORT_ROOM_LIMIT]:
        parsed = _parse_sync_channel_raw(raw)
        if not parsed:
            continue
        name = parsed["name"]
        existing_local = db.get_room_by_name(name)
        if db.room_blocks_home_sync_mirror(existing_local):
            try:
                db.leave_room(uid, int(existing_local["id"]))
            except Exception:
                pass
            rooms_name_collisions += 1
            continue
        room = _materialize_federated_channel(raw)
        if not room:
            rooms_missing += 1
            continue
        if _try_apply_sync_room_vanity(room, parsed.get("vanity")):
            pass
        elif parsed.get("vanity"):
            vanity_collisions += 1
        try:
            db.join_room(uid, int(room["id"]))
            rooms_joined += 1
        except Exception:
            continue
        _sync_step("channels", f"Syncing channels… ({rooms_joined}/{n_rooms})", "channels", rooms_joined)

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
        icon = _sanitize_sync_room_icon(raw.get("icon"))
        category = str(raw.get("category") or "").strip().lower()
        directory_description = re.sub(
            r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "",
            str(raw.get("directory_description") or ""),
        )[:1200]
        tags_raw = raw.get("tags") or []
        if isinstance(tags_raw, str):
            tags_json = tags_raw[:2000]
        else:
            try:
                import json as _json
                tags_json = _json.dumps([str(t)[:24] for t in tags_raw if t])[:2000]
            except Exception:
                tags_json = "[]"
        member_count = int(raw.get("member_count") or 0)
        owner_nickname = str(raw.get("owner_nickname") or "")[:64]
        owner_gid = str(raw.get("owner_global_user_id") or "")[:64]
        if room_type != "public":
            continue
        if not _ROOM_NAME_RE.match(name):
            continue
        if channel_type not in ("text", "music", "voice"):
            channel_type = "text"
        # Directory rows are index-only — do NOT materialise a local shell
        # room for every public channel on the home node. Empty local copies
        # hide the federated index entry and make Discover look solo/empty.
        existing = db.get_room_by_name(name) if name in keep_room_names else None
        stale_shell = db.get_room_by_name(name)
        if stale_shell and name not in keep_room_names:
            try:
                fed_uid = int(db.get_or_create_federation_system_user())
                if int(stale_shell.get("owner_id") or 0) == fed_uid and not int(stale_shell.get("is_public") or 0):
                    existing = None
            except Exception:
                pass
        if name in keep_room_names and not existing:
            try:
                owner = db.get_or_create_federation_system_user()
                db.create_room(
                    name, desc, "public", owner, None,
                    icon=icon, channel_type=channel_type,
                )
                existing = db.get_room_by_name(name)
            except Exception:
                existing = None
        if existing or stale_shell:
            try:
                db.set_room_public(
                    name,
                    1,
                    category=category,
                    directory_description=directory_description,
                    tags=tags_json,
                )
            except Exception:
                pass
            if icon or desc:
                try:
                    patch = {}
                    if icon:
                        patch["icon"] = icon
                    if desc:
                        patch["description"] = desc
                    if patch:
                        db.update_room_settings(name, **patch)
                except Exception:
                    pass
        # Always update the federated channel index so the directory
        # shows synced channels with their real home node. Even if the
        # local `rooms` materialisation failed, the index still surfaces
        # the channel as a federated-only listing.
        if source_server_id:
            try:
                db.upsert_federation_channel_index(
                    name, source_server_id,
                    display_name=name,
                    description=desc,
                    directory_description=directory_description,
                    icon=icon,
                    category=category,
                    tags_json=tags_json,
                    channel_type=channel_type,
                    visibility="public",
                    member_count=member_count,
                    owner_nickname=owner_nickname,
                    owner_global_user_id=owner_gid,
                    home_base_url=source_public_url,
                )
            except Exception:
                _log.debug("upsert_federation_channel_index failed name=%s", name, exc_info=True)
        if name in keep_room_names:
            join_room = existing or stale_shell or db.get_room_by_name(name)
            if db.room_blocks_home_sync_mirror(join_room):
                try:
                    db.leave_room(uid, int(join_room["id"]))
                except Exception:
                    pass
                rooms_name_collisions += 1
            elif join_room:
                try:
                    db.join_room(uid, int(join_room["id"]))
                except Exception:
                    pass
        with _sync_state_lock:
            cur = dict(_federation_sync_state.get(uid) or {})
            ctr = dict(cur.get("counters") or {})
            ctr["directory"] = int(ctr.get("directory") or 0) + 1
        _sync_step("directory", f"Syncing channel directory… ({ctr['directory']}/{n_public})", "directory", ctr["directory"])

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
            peer_origin = _sync_item_peer_origin(item, source_server_id)
            peer = db.ensure_federated_dm_local_user(
                gid,
                nick,
                origin_server_id=peer_origin,
                display_name=str(item.get("display_name") or "")[:64],
                avatar=(item.get("avatar") or ""),
            )
            if not peer:
                users_nick_collisions += 1
                continue
            peer_id = int(peer.get("id") or 0)
            if peer_id <= 0 or peer_id == uid:
                continue
            local_nick = str(peer.get("nickname") or "").strip()
            if local_nick and local_nick.lower() != nick.lower():
                users_nick_collisions += 1
            db.patch_sync_user_profile(
                peer_id,
                display_name=str(item.get("display_name") or ""),
                status_msg=str(item.get("status_msg") or ""),
                avatar=(item.get("avatar") or ""),
            )
            db.get_or_create_dm(uid, peer_id)
            dm_linked += 1
        except Exception:
            continue
        _sync_step("dms", f"Syncing DMs… ({dm_linked}/{n_dms})", "dms", dm_linked)

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
            peer_origin = _sync_item_peer_origin(item, source_server_id)
            peer = db.ensure_federated_dm_local_user(
                gid,
                nick,
                origin_server_id=peer_origin,
                display_name=str(item.get("display_name") or "")[:64],
                avatar=(item.get("avatar") or ""),
            )
            if not peer:
                users_nick_collisions += 1
                continue
            peer_id = int(peer.get("id") or 0)
            if peer_id <= 0 or peer_id == uid:
                continue
            if str(peer.get("nickname") or "").strip().lower() != nick.lower():
                users_nick_collisions += 1
            db.patch_sync_user_profile(
                peer_id,
                display_name=str(item.get("display_name") or ""),
                status_msg=str(item.get("status_msg") or ""),
                avatar=(item.get("avatar") or ""),
            )
            if db.follow_user(uid, peer_id):
                following_linked += 1
        except Exception:
            continue
        _sync_step("social_graph", f"Syncing follows… ({following_linked}/{n_follow})", "social_graph", following_linked + friends_linked + blocked_linked)

    for item in friends[:_SYNC_EXPORT_DM_LIMIT]:
        if not isinstance(item, dict):
            continue
        gid = str(item.get("global_user_id") or "").strip()
        nick = str(item.get("nickname") or "").strip()
        if not nick or not _GID_RE.match(gid) or (my_gid and gid == my_gid):
            continue
        try:
            peer_origin = _sync_item_peer_origin(item, source_server_id)
            peer = db.ensure_federated_dm_local_user(
                gid,
                nick,
                origin_server_id=peer_origin,
                display_name=str(item.get("display_name") or "")[:64],
                avatar=(item.get("avatar") or ""),
            )
            if not peer:
                users_nick_collisions += 1
                continue
            peer_id = int(peer.get("id") or 0)
            if peer_id <= 0 or peer_id == uid:
                continue
            if str(peer.get("nickname") or "").strip().lower() != nick.lower():
                users_nick_collisions += 1
            db.patch_sync_user_profile(
                peer_id,
                display_name=str(item.get("display_name") or ""),
                status_msg=str(item.get("status_msg") or ""),
                avatar=(item.get("avatar") or ""),
            )
            if db.sync_import_accepted_friendship(uid, peer_id):
                friends_linked += 1
            try:
                db.follow_user(uid, peer_id)
            except Exception:
                pass
            db.get_or_create_dm(uid, peer_id)
        except Exception:
            continue
        _sync_step("social_graph", f"Syncing friends… ({friends_linked}/{n_friends})", "social_graph", following_linked + friends_linked + blocked_linked)

    for item in blocked_users[:_SYNC_EXPORT_BLOCKED_LIMIT]:
        if not isinstance(item, dict):
            continue
        gid = str(item.get("global_user_id") or "").strip()
        nick = str(item.get("nickname") or "").strip()
        if not nick or not _GID_RE.match(gid) or (my_gid and gid == my_gid):
            continue
        try:
            peer_origin = _sync_item_peer_origin(item, source_server_id)
            peer = db.ensure_federated_dm_local_user(
                gid,
                nick,
                origin_server_id=peer_origin,
                display_name=str(item.get("display_name") or "")[:64],
                avatar=(item.get("avatar") or ""),
            )
            if not peer:
                users_nick_collisions += 1
                continue
            peer_id = int(peer.get("id") or 0)
            if peer_id <= 0 or peer_id == uid:
                continue
            if str(peer.get("nickname") or "").strip().lower() != nick.lower():
                users_nick_collisions += 1
            if db.block_user(uid, peer_id):
                blocked_linked += 1
        except Exception:
            continue
        _sync_step("social_graph", "Syncing block list…", "social_graph", following_linked + friends_linked + blocked_linked)

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
    _sync_step("profile", "Syncing profile & settings…", "profile", 1)

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
    _sync_step("push", f"Syncing notifications… ({push_tokens_linked}/{n_push})", "push", push_tokens_linked)

    for row in social_posts[:_SYNC_EXPORT_SOCIAL_POST_LIMIT]:
        if not isinstance(row, dict):
            continue
        payload_post = {
            "global_post_id": str(row.get("global_post_id") or "").strip(),
            "author_global_user_id": str(row.get("author_global_user_id") or "").strip(),
            "nickname": str(row.get("nickname") or "").strip(),
            "author_display_name": str(row.get("author_display_name") or "")[:64],
            "author_avatar": row.get("author_avatar"),
            "content": str(row.get("content") or "")[:4000],
            "media_data": row.get("media_data"),
            "media_type": row.get("media_type"),
            "privacy": str(row.get("privacy") or "public").strip().lower(),
            "share_enabled": 1 if bool(row.get("share_enabled", True)) else 0,
            "allow_comments": 1 if bool(row.get("allow_comments", True)) else 0,
            "track_title": str(row.get("track_title") or "")[:160],
            "track_room": str(row.get("track_room") or "")[:64],
            "track_mood": str(row.get("track_mood") or "")[:32],
            "created_at": str(row.get("created_at") or "")[:64],
            "enc_v": int(row.get("enc_v") or 0),
            "audience": str(row.get("audience") or row.get("privacy") or "")[:32],
            "ciphertext_b64": str(row.get("ciphertext_b64") or ""),
            "wrapped_keys": row.get("wrapped_keys") if isinstance(row.get("wrapped_keys"), list) else [],
        }
        payload_post["media_data"], payload_post["media_type"] = _sanitize_sync_media(
            payload_post.get("media_data"),
            payload_post.get("media_type"),
        )
        post_origin = str(row.get("origin_server_id") or source_server_id or "").strip()
        if not post_origin:
            social_posts_skipped += 1
            continue
        if not payload_post["global_post_id"] or not payload_post["author_global_user_id"] or not payload_post["nickname"]:
            social_posts_skipped += 1
            continue
        author_home = str(row.get("author_home_server_id") or post_origin or "").strip()
        if author_home:
            try:
                db.upsert_federation_user_profile(
                    payload_post["author_global_user_id"],
                    payload_post["nickname"],
                    display_name=str(payload_post.get("author_display_name") or "")[:64],
                    avatar=payload_post.get("author_avatar") or "",
                    origin_server_id=author_home,
                )
            except Exception:
                pass
        try:
            existed = db.resolve_federation_wall_local_id(
                post_origin, "post", payload_post["global_post_id"],
            )
            created = db.apply_synced_social_post(
                payload_post, post_origin, viewer_user_id=uid,
            )
            if created and not existed:
                social_posts_imported += 1
            elif not created and not existed:
                social_posts_skipped += 1
        except Exception:
            social_posts_skipped += 1
            continue
        if social_posts_imported and (social_posts_imported % 3 == 0):
            _sync_step("social_posts", f"Syncing FrogSocial… ({social_posts_imported}/{n_social})", "social_posts", social_posts_imported)

    try:
        db.relink_wall_posts_to_account(uid)
    except Exception:
        pass

    # ── Recent chat history backfill ──────────────────────────────────
    # Apply room-history snapshots from the source node. We deliberately
    # do this after rooms are joined so user_can_access_room evaluates
    # correctly for any peer-history audit hook downstream.
    n_history_rooms = len(room_histories)
    if n_history_rooms:
        _sync_step("messages", f"Restoring chat history… (0/{n_history_rooms})", "messages", 0)
    history_rooms_done = 0
    for hist in room_histories:
        if not isinstance(hist, dict):
            continue
        rn = str(hist.get("room_name") or "").strip().lower()
        if not _ROOM_NAME_RE.match(rn):
            continue
        msgs = hist.get("messages")
        if not isinstance(msgs, list) or not msgs:
            continue
        if not db.get_room_by_name(rn):
            continue
        applied = 0
        for m in msgs[:_SYNC_EXPORT_HISTORY_PER_ROOM]:
            if not isinstance(m, dict):
                continue
            try:
                origin_msg_id = int(m.get("id") or 0)
            except Exception:
                origin_msg_id = 0
            if origin_msg_id <= 0:
                continue
            ts = str(m.get("created_at") or "")
            content = str(m.get("content") or "")[:10_000]
            nick = str(m.get("nickname") or "")[:64]
            if not nick:
                continue
            media_type = str(m.get("media_type") or "")[:64] or None
            event_id = f"sync_{source_server_id}_{rn}_{origin_msg_id}"
            try:
                ok = db.save_federated_room_message(
                    event_id,
                    {
                        "room_name": rn,
                        "nickname": nick,
                        "display_name": str(m.get("display_name") or "")[:64],
                        "content": content,
                        "media_data": None,
                        "media_type": media_type,
                        "media_blur": int(m.get("media_blur") or 0),
                        "view_once": int(m.get("view_once") or 0),
                        "key_version": int(m.get("key_version") or 0),
                        "edited": bool(m.get("edited")),
                        "avatar": str(m.get("avatar") or "")[:200_000],
                        "created_at": ts,
                        "origin_message_id": str(origin_msg_id),
                    },
                    source_server_id,
                )
                if ok:
                    applied += 1
            except Exception:
                continue
            sgid = str(m.get("sender_global_user_id") or "").strip()
            if sgid and _GID_RE.match(sgid) and nick:
                try:
                    sender_home = _peer_home_server_id_for_sync(sgid, source_server_id)
                    db.ensure_federated_dm_local_user(
                        sgid, nick, origin_server_id=sender_home,
                        display_name=str(m.get("display_name") or "")[:64],
                        avatar=str(m.get("avatar") or "")[:200_000],
                    )
                    db.upsert_federation_room_member(
                        rn, sgid, nick,
                        display_name=str(m.get("display_name") or "")[:64],
                        avatar=str(m.get("avatar") or "")[:200_000],
                        home_server_id=sender_home,
                        role="member",
                    )
                except Exception:
                    pass
        history_messages_applied += applied
        history_rooms_done += 1
        try:
            db.backfill_federation_room_members_from_messages(
                rn,
                home_server_id=source_server_id,
            )
        except Exception:
            pass
        if history_rooms_done % 5 == 0:
            _sync_step(
                "messages",
                f"Restoring chat history… ({history_rooms_done}/{n_history_rooms})",
                "messages", history_rooms_done,
            )

    # ── DM history backfill (ciphertext only) ─────────────────────────
    n_dm_history = len(dm_histories)
    if n_dm_history:
        _sync_step("dm_messages", f"Restoring DM history… (0/{n_dm_history})", "dm_messages", 0)
    dm_history_done = 0
    for entry in dm_histories:
        if not isinstance(entry, dict):
            continue
        peer_gid = str(entry.get("peer_global_user_id") or "").strip()
        if not _GID_RE.match(peer_gid):
            continue
        msgs = entry.get("messages")
        if not isinstance(msgs, list) or not msgs:
            continue
        # The DM channel must exist locally before we can stitch messages
        # into it. The DM-peer pass earlier in this function provisions a
        # stub for every peer in `dm_peers`; if a DM channel is missing
        # we skip rather than create rogue channels here.
        peer_local = db.find_user_by_global_id(peer_gid)
        if not peer_local:
            continue
        peer_uid = int(peer_local.get("id") or 0)
        if peer_uid <= 0 or peer_uid == uid:
            continue
        try:
            cid = int(db.get_or_create_dm(uid, peer_uid) or 0)
        except Exception:
            cid = 0
        if cid <= 0:
            continue
        applied = 0
        for m in msgs[:_SYNC_EXPORT_DM_HISTORY_PER_CHANNEL]:
            if not isinstance(m, dict):
                continue
            try:
                origin_msg_id = int(m.get("id") or 0)
            except Exception:
                origin_msg_id = 0
            if origin_msg_id <= 0:
                continue
            sender_id = uid if bool(m.get("from_self")) else peer_uid
            content_ct = str(m.get("content") or "")[:20_000]
            media_type = str(m.get("media_type") or "")[:64] or None
            media_name = str(m.get("media_name") or "")[:200] or None
            try:
                ok = db.save_synced_dm_message(
                    channel_id=cid,
                    sender_id=sender_id,
                    content=content_ct,
                    media_type=media_type,
                    media_name=media_name,
                    media_blur=int(m.get("media_blur") or 0),
                    view_once=int(m.get("view_once") or 0),
                    edited=bool(m.get("edited")),
                    deleted=bool(m.get("deleted")),
                    created_at=str(m.get("created_at") or ""),
                    source_server_id=source_server_id,
                    origin_message_id=str(origin_msg_id),
                )
                if ok:
                    applied += 1
            except Exception:
                continue
        dm_history_messages_applied += applied
        dm_history_done += 1
        if dm_history_done % 3 == 0:
            _sync_step(
                "dm_messages",
                f"Restoring DM history… ({dm_history_done}/{n_dm_history})",
                "dm_messages", dm_history_done,
            )

    # ── Member roster snapshots (joined rooms) ─────────────────────────
    if n_member_snaps:
        _sync_step("members", f"Syncing member lists… (0/{n_member_snaps})", "members", 0)
    members_done = 0
    for entry in member_snaps[:_SYNC_EXPORT_MEMBER_ROOM_LIMIT]:
        if not isinstance(entry, dict):
            continue
        rn = str(entry.get("room_name") or "").strip().lower()
        if not _ROOM_NAME_RE.match(rn):
            continue
        snap = entry.get("members")
        if not isinstance(snap, list) or not snap:
            continue
        try:
            applied_n = db.replace_federation_room_members(
                rn,
                snap,
                sourced_from_home=True,
            )
            if applied_n > 0:
                members_snapshots_applied += 1
                members_done += 1
            db.backfill_federation_room_members_from_messages(
                rn,
                home_server_id=source_server_id,
            )
        except Exception:
            continue
        if members_done % 3 == 0:
            _sync_step(
                "members",
                f"Syncing member lists… ({members_done}/{n_member_snaps})",
                "members", members_done,
            )

    _sync_progress(uid, 100, "Sync complete", "done", counters={
        "social_posts": social_posts_imported,
        "messages": history_messages_applied,
        "dm_messages": dm_history_messages_applied,
        "members": members_snapshots_applied,
    })

    try:
        pruned_final = int(db.apply_sync_room_allowlist(uid, keep_room_names) or 0)
        rooms_pruned = max(int(rooms_pruned or 0), pruned_final)
    except Exception:
        pass

    peer_profiles_cached = 0
    try:
        peer_profiles_cached = int(
            _apply_sync_peer_profile_cache_from_export(payload, source_server_id) or 0
        )
    except Exception:
        peer_profiles_cached = 0

    return {
        "rooms_joined": rooms_joined,
        "rooms_pruned": rooms_pruned,
        "rooms_missing": rooms_missing,
        "rooms_name_collisions": rooms_name_collisions,
        "vanity_collisions": vanity_collisions,
        "users_nick_collisions": users_nick_collisions,
        "dm_linked": dm_linked,
        "following_linked": following_linked,
        "friends_linked": friends_linked,
        "blocked_linked": blocked_linked,
        "push_tokens_linked": push_tokens_linked,
        "social_posts_imported": social_posts_imported,
        "social_posts_total": n_social,
        "social_posts_skipped": social_posts_skipped,
        "social_posts_omitted_at_export": social_posts_omitted_at_export,
        "history_messages_applied": history_messages_applied,
        "dm_history_messages_applied": dm_history_messages_applied,
        "members_snapshots_applied": members_snapshots_applied,
        "peer_profiles_cached": peer_profiles_cached,
    }


def _provision_local_user_from_remote(nickname: str, password: str, remote_login: dict, remote_ident: dict | None = None):
    nick = str(nickname or "").strip()
    gid = str((remote_ident or {}).get("global_user_id") or "").strip() if isinstance(remote_ident, dict) else ""
    user_id = db.create_user(nick, password)
    if user_id is None and gid:
        try:
            import bcrypt as _bcrypt_prov

            pw_hash = _bcrypt_prov.hashpw(password.encode(), _bcrypt_prov.gensalt()).decode()
        except Exception:
            pw_hash = ""
        alt = db.disambiguate_federated_nickname(nick, gid, "") if pw_hash else ""
        if alt:
            user_id = db.create_user_with_hash(alt, pw_hash, gid)
            nick = alt
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


def _fetch_sync_export_via_session(base_url: str, token: str, cursor: str = "") -> dict | None:
    tok = str(token or "").strip()
    if not tok:
        return None
    source = _norm_base(base_url)
    if not source:
        return None
    url = f"{source}/api/auth/federation-sync-export"
    cur = str(cursor or "").strip()
    if cur:
        url = f"{url}?social_posts_cursor={urllib.parse.quote(cur, safe='')}"
    try:
        data = _get_json(url, headers={"X-Session-Token": tok}, timeout=8.0)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _fetch_sync_export_via_ticket(base_url: str, ticket: str, cursor: str = "") -> dict | None:
    fed = (os.getenv("FROGTALK_FEDERATION_TOKEN", "") or "").strip()
    if not fed:
        return None
    raw_ticket = str(ticket or "").strip()
    if not raw_ticket:
        return None
    body: dict = {"ticket": raw_ticket}
    cur = str(cursor or "").strip()
    if cur:
        body["social_posts_cursor"] = cur
    try:
        data = _post_json(
            f"{base_url}/api/auth/federation-sync-export-ticket",
            body,
            headers={"X-Federation-Token": fed},
            timeout=8.0,
        )
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _fetch_sync_export_via_federation_gid(
    base_url: str,
    global_user_id: str,
    cursor: str = "",
) -> dict | None:
    fed = (os.getenv("FROGTALK_FEDERATION_TOKEN", "") or "").strip()
    gid = str(global_user_id or "").strip()
    if not fed or not gid or not _GID_RE.match(gid):
        return None
    source = _norm_base(base_url)
    if not source:
        return None
    body: dict = {"global_user_id": gid}
    cur = str(cursor or "").strip()
    if cur:
        body["social_posts_cursor"] = cur
    try:
        data = _post_json(
            f"{source}/api/auth/federation-sync-export-gid",
            body,
            headers={"X-Federation-Token": fed},
            timeout=12.0,
        )
    except Exception:
        return None
    return data if isinstance(data, dict) else None


async def _run_sync_export_apply_loop(
    user_id: int,
    source_base: str,
    fetcher,
) -> dict:
    """Fetch export page(s) from home and apply with verification."""
    uid = int(user_id or 0)
    source = _norm_base(source_base)
    if uid <= 0 or not source:
        return {}
    cursor = ""
    first = True
    total_imported = 0
    total_posts = 0
    omitted = 0
    last_applied: dict = {}
    home_sid, _ = resolve_account_home_base_url(uid)
    while True:
        export = await asyncio.to_thread(fetcher, source, cursor)
        if not isinstance(export, dict):
            raise ValueError("export_unavailable")
        _verify_sync_export(export, user_id=uid, fetch_origin=source)
        page = str(export.get("sync_export_page") or "full").strip().lower()
        if page == "social" and not first:
            applied = await asyncio.to_thread(_apply_sync_social_posts_only, uid, export)
        else:
            _sync_progress(uid, 8 if first else 40, "Applying synced data…", "apply")
            applied = await asyncio.to_thread(
                _apply_sync_export_to_user, uid, export, fetch_origin=source,
            )
            first = False
        if isinstance(applied, dict):
            if applied.get("error"):
                raise ValueError(str(applied.get("error")))
            last_applied = applied
        total_imported += int((applied or {}).get("social_posts_imported") or 0)
        total_posts = int(
            export.get("social_posts_total")
            or (applied or {}).get("social_posts_total")
            or total_posts
        )
        omitted = int(
            export.get("social_posts_omitted_at_export")
            or (applied or {}).get("social_posts_omitted_at_export")
            or omitted
        )
        has_more = bool(export.get("social_posts_has_more")) and _sync_pagination_enabled()
        cursor = str(export.get("social_posts_next_cursor") or "").strip() if has_more else ""
        pct = 8
        if total_posts > 0:
            pct = min(95, 8 + int(87 * total_imported / max(total_posts, 1)))
        hint = (
            f"Importing posts ({total_imported}/{total_posts})…"
            if has_more
            else "Applying synced data…"
        )
        _sync_state_set(uid, {
            "source_base": source,
            "source_server_id": str(export.get("source_server_id") or home_sid or ""),
            "in_progress": True,
            "done": False,
            "error": "",
            "progress_pct": pct,
            "phase": "social_posts" if has_more else "apply",
            "hint": hint,
            "social_posts_imported": total_imported,
            "social_posts_total": total_posts,
            "social_posts_cursor": cursor,
            "social_posts_omitted_at_export": omitted,
        })
        if not has_more:
            break
    out = dict(last_applied or {})
    out.update({
        "social_posts_imported": total_imported,
        "social_posts_total": total_posts,
        "social_posts_omitted_at_export": omitted,
    })
    return out


def _room_names_from_sync_export(export: dict) -> set[str]:
    names: set[str] = set()
    for raw in (export or {}).get("rooms") or []:
        if isinstance(raw, dict):
            nm = str(raw.get("name") or "").strip().lower()
        else:
            nm = str(raw or "").strip().lower()
        if nm and _ROOM_NAME_RE.match(nm):
            names.add(nm)
    return names


def _room_names_from_memberships_payload(payload: dict) -> set[str]:
    names: set[str] = set()
    for raw in (payload or {}).get("rooms") or []:
        nm = str(raw or "").strip().lower()
        if nm and _ROOM_NAME_RE.match(nm):
            names.add(nm)
    return names


def _parse_sync_channel_raw(raw) -> dict | None:
    if isinstance(raw, dict):
        name = str(raw.get("name") or "").strip().lower()
        room_type = str(raw.get("type") or "public").strip().lower()
        channel_type = str(raw.get("channel_type") or "text").strip().lower()
        icon = _sanitize_sync_room_icon(raw.get("icon"))
        desc = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(raw.get("description") or ""))[:200]
        vanity = str(raw.get("vanity") or "").strip().lower()[:32]
        channel_theme = _sanitize_sync_channel_theme(raw.get("channel_theme"), room_type)
    else:
        name = str(raw or "").strip().lower()
        room_type = "public"
        channel_type = "text"
        icon = None
        desc = ""
        vanity = ""
        channel_theme = None
    if not _ROOM_NAME_RE.match(name):
        return None
    if room_type not in ("public", "private"):
        room_type = "public"
    if channel_type not in ("text", "music", "voice"):
        channel_type = "text"
    out = {
        "name": name,
        "type": room_type,
        "channel_type": channel_type,
        "icon": icon,
        "description": desc,
        "vanity": vanity,
    }
    if channel_theme:
        out["channel_theme"] = channel_theme
    return out


def _try_apply_sync_room_vanity(room: dict | None, vanity: str) -> bool:
    """Apply home vanity slug to a federation shell room when locally free."""
    if not room or not vanity:
        return False
    try:
        from routers.invites import validate_vanity_slug
    except Exception:
        return False
    normalized = str(vanity or "").strip().lower()
    if validate_vanity_slug(normalized):
        return False
    rid = int(room.get("id") or 0)
    if rid <= 0:
        return False
    if db.room_blocks_home_sync_mirror(room):
        return False
    if not db.is_vanity_available(normalized, exclude_room_id=rid):
        return False
    return bool(db.set_room_vanity(rid, normalized))


def _materialize_federated_channel(raw) -> dict | None:
    """Ensure a joined home-node channel exists locally (mirror shell)."""
    parsed = _parse_sync_channel_raw(raw)
    if not parsed:
        return None
    name = parsed["name"]
    room = db.get_room_by_name(name)
    if db.room_blocks_home_sync_mirror(room):
        return None
    if not room and parsed["type"] in ("public", "private"):
        try:
            owner = db.get_or_create_federation_system_user()
            db.create_room(
                name,
                parsed["description"],
                parsed["type"],
                owner,
                None,
                icon=parsed.get("icon"),
                channel_type=parsed["channel_type"],
            )
            room = db.get_room_by_name(name)
        except Exception:
            room = None
    elif room and parsed.get("icon"):
        try:
            db.update_room_settings(name, icon=parsed["icon"])
        except Exception:
            pass
    if room and parsed.get("channel_theme"):
        try:
            db.update_room_settings(name, channel_theme=parsed["channel_theme"])
        except Exception:
            pass
    if room and parsed.get("vanity"):
        _try_apply_sync_room_vanity(room, parsed["vanity"])
    return room


def materialize_directory_federated_channel(room_name: str) -> tuple[dict | None, str | None]:
    """Create or refresh a local public shell for a federated directory listing.

    Only uses metadata from ``federation_channel_index`` (never client input).
    Returns ``(room, error_code)``. ``error_code`` is one of:
    ``invalid_name``, ``not_in_directory``, ``name_collision``.
    """
    name = str(room_name or "").strip().lower()
    if not _ROOM_NAME_RE.match(name):
        return None, "invalid_name"
    existing = db.get_room_by_name(name)
    if db.room_blocks_home_sync_mirror(existing):
        return None, "name_collision"
    if existing:
        return existing, None
    fed = db.get_federation_channel_index_entry(name)
    if not fed:
        return None, "not_in_directory"
    home_sid = str(fed.get("home_server_id") or "").strip()
    if not home_sid:
        return None, "not_in_directory"
    tags_raw = fed.get("tags_json") or "[]"
    raw = {
        "name": name,
        "type": "public",
        "channel_type": str(fed.get("channel_type") or "text"),
        "description": str(fed.get("description") or "")[:200],
        "icon": fed.get("icon"),
    }
    room = _materialize_federated_channel(raw)
    if not room:
        existing = db.get_room_by_name(name)
        if db.room_blocks_home_sync_mirror(existing):
            return None, "name_collision"
        return None, "not_in_directory"
    try:
        db.set_room_home_server_id_if_empty(name, home_sid)
    except Exception:
        pass
    try:
        db.set_room_public(
            name,
            1,
            category=str(fed.get("category") or "").strip().lower(),
            directory_description=str(fed.get("directory_description") or "")[:1200],
            tags=tags_raw if isinstance(tags_raw, str) else "[]",
        )
    except Exception:
        pass
    return db.get_room_by_name(name) or room, None


def _apply_home_channel_memberships(user_id: int, payload: dict) -> int:
    """Mirror home joined channels locally, then prune anything not on home."""
    uid = int(user_id or 0)
    if uid <= 0 or not isinstance(payload, dict):
        return 0
    channels = payload.get("channels")
    names: set[str] = set()
    if isinstance(channels, list) and channels:
        for raw in channels:
            parsed = _parse_sync_channel_raw(raw)
            if not parsed:
                continue
            names.add(parsed["name"])
            room = _materialize_federated_channel(raw)
            if not room:
                continue
            try:
                db.join_room(uid, int(room["id"]))
            except Exception:
                continue
    else:
        names = _room_names_from_memberships_payload(payload)
        for nm in names:
            room = _materialize_federated_channel({"name": nm, "type": "public", "channel_type": "text"})
            if room:
                try:
                    db.join_room(uid, int(room["id"]))
                except Exception:
                    pass
    return int(db.apply_sync_room_allowlist(uid, names) or 0)


def user_at_account_home(user_id: int) -> bool:
    """Public wrapper for account-home detection (used by rooms router)."""
    return _user_at_account_home(user_id)


def _build_sync_memberships_for_user(user_id: int) -> dict:
    uid = int(user_id or 0)
    if uid <= 0:
        return {"rooms": [], "channels": [], "source_server_id": ""}
    joined_ids = db.get_user_joined_room_ids(uid)
    names: list[str] = []
    channels: list[dict] = []
    for room in db.list_rooms():
        name = str(room.get("name") or "").strip().lower()
        if room.get("id") not in joined_ids or not _ROOM_NAME_RE.match(name):
            continue
        names.append(name)
        rtype = str(room.get("type") or "public").strip().lower()
        if rtype not in ("public", "private"):
            rtype = "public"
        ctype = str(room.get("channel_type") or "text").strip().lower()
        if ctype not in ("text", "music", "voice"):
            ctype = "text"
        channels.append({
            "name": name,
            "type": rtype,
            "channel_type": ctype,
            "description": str(room.get("description") or "")[:200],
            "icon": _sanitize_sync_room_icon(room.get("icon")),
        })
    try:
        ident = db.get_or_create_local_server_identity() or {}
        source_server_id = str(ident.get("server_id") or "").strip()
    except Exception:
        source_server_id = ""
    return {"rooms": sorted(names), "channels": channels, "source_server_id": source_server_id}


def _resolve_home_base_for_user(user_id: int) -> str:
    home_sid = _account_home_server_id(user_id)
    ident = db.get_or_create_local_server_identity() or {}
    local_sid = str(ident.get("server_id") or "").strip()
    if not home_sid or home_sid == local_sid:
        return ""
    try:
        for row in db.list_federation_servers(official_only=False):
            if str(row.get("server_id") or "").strip() == home_sid:
                return _peer_target(row)
    except Exception:
        pass
    return ""


def _fetch_home_memberships_payload(base_url: str, global_user_id: str) -> dict | None:
    fed = (os.getenv("FROGTALK_FEDERATION_TOKEN", "") or "").strip()
    gid = str(global_user_id or "").strip()
    if not fed or not gid or not _GID_RE.match(gid):
        return None
    source = _norm_base(base_url)
    if not source:
        return None
    try:
        data = _post_json(
            f"{source}/api/auth/federation-sync-memberships-gid",
            {"global_user_id": gid},
            headers={"X-Federation-Token": fed},
            timeout=5.0,
        )
    except Exception:
        data = None
    if isinstance(data, dict) and isinstance(data.get("rooms"), list):
        return data
    export = _fetch_sync_export_via_federation_gid(source, gid)
    if not isinstance(export, dict):
        return None
    rooms = export.get("rooms") or []
    names: list[str] = []
    channels: list[dict] = []
    for raw in rooms:
        parsed = _parse_sync_channel_raw(raw)
        if not parsed:
            continue
        names.append(parsed["name"])
        channels.append(parsed)
    try:
        ident_sid = str(export.get("source_server_id") or "").strip()
    except Exception:
        ident_sid = ""
    return {"rooms": sorted(set(names)), "channels": channels, "source_server_id": ident_sid}


def _fetch_memberships_via_federation_gid(base_url: str, global_user_id: str) -> set[str] | None:
    payload = _fetch_home_memberships_payload(base_url, global_user_id)
    if not payload:
        return None
    return _room_names_from_memberships_payload(payload)


_MEMBERSHIP_REFRESH_LOCK = _threading.Lock()
_MEMBERSHIP_REFRESH_AT: dict[int, float] = {}
_MEMBERSHIP_REFRESH_MIN_INTERVAL = 12.0


def ensure_federated_memberships_current(user_id: int, *, force: bool = False) -> int:
    """Align remote-node joins to the authoritative home-node channel list."""
    uid = int(user_id or 0)
    if uid <= 0 or _user_at_account_home(uid):
        return 0

    cached = db.get_user_sync_room_allowlist(uid)
    cached_at = db.get_user_sync_room_allowlist_at(uid)
    now = time.time()
    stale = force or not cached or (now - cached_at) >= _MEMBERSHIP_REFRESH_MIN_INTERVAL

    payload: dict | None = None
    if stale:
        with _MEMBERSHIP_REFRESH_LOCK:
            last = float(_MEMBERSHIP_REFRESH_AT.get(uid) or 0)
            if force or (now - last) >= _MEMBERSHIP_REFRESH_MIN_INTERVAL:
                _MEMBERSHIP_REFRESH_AT[uid] = now
                base = _resolve_home_base_for_user(uid)
                me = db.get_user_by_id(uid) or {}
                gid = str(me.get("global_user_id") or "").strip()
                if base and gid:
                    payload = _fetch_home_memberships_payload(base, gid)

    if payload:
        try:
            return int(_apply_home_channel_memberships(uid, payload) or 0)
        except Exception:
            pass

    if cached:
        try:
            return int(db.apply_sync_room_allowlist(uid, cached) or 0)
        except Exception:
            return 0
    return 0


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
        applied = await _run_sync_export_apply_loop(
            uid,
            source,
            lambda base, cur: _fetch_sync_export_via_federation_gid(base, gid, cur),
        )
        _sync_state_set(uid, {
            "in_progress": False,
            "done": True,
            "error": "",
            "progress_pct": 100,
            "phase": "done",
            "hint": "Sync complete",
            "finished_at": int(time.time()),
            "social_posts_cursor": "",
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
        applied = await _run_sync_export_apply_loop(
            uid,
            source,
            lambda base, cur: _fetch_sync_export_via_session(base, tok, cur),
        )
        _sync_state_set(uid, {
            "in_progress": False,
            "done": True,
            "error": "",
            "progress_pct": 100,
            "phase": "done",
            "hint": "Sync complete",
            "finished_at": int(time.time()),
            "social_posts_cursor": "",
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
        applied = await _run_sync_export_apply_loop(
            uid,
            source,
            lambda base, cur: _fetch_sync_export_via_ticket(base, raw_ticket, cur),
        )
        _sync_state_set(uid, {
            "in_progress": False,
            "done": True,
            "error": "",
            "progress_pct": 100,
            "phase": "done",
            "hint": "Sync complete",
            "finished_at": int(time.time()),
            "social_posts_cursor": "",
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
    social_posts_cursor: str | None = Field(default=None, max_length=256)


class FederationSyncExportGidRequest(BaseModel):
    global_user_id: str = Field(min_length=1, max_length=128)
    social_posts_cursor: str | None = Field(default=None, max_length=256)


class FederationSyncResumeRequest(BaseModel):
    source_base: str | None = Field(default=None, max_length=512)
    ticket: str | None = Field(default=None, max_length=8192)
    force: bool = False


class FederationSyncResetRequest(BaseModel):
    clear_home_pin: bool = False


class RepinAccountHomeRequest(BaseModel):
    source_base: str = Field(min_length=4, max_length=512)
    start_sync: bool = True


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
    _pin_local_account_home(user_id)
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
    uid = int(user["id"])
    if _user_at_account_home(uid):
        _clear_federation_sync_state(uid)
    token = _create_session_with_meta(request, user["id"])
    sync_meta = None
    if isinstance(boot, dict):
        source_base = _norm_base(str(boot.get("remote_base") or ""))
        remote_token = str(boot.get("remote_token") or "").strip()
        if source_base and remote_token:
            remote_sid = _resolve_server_id_for_base(source_base)
            if remote_sid:
                db.set_user_account_home_server_id(int(user["id"]), remote_sid, force=True)
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
    elif (
        local_exists
        and not _user_at_account_home(uid)
        and _sync_login_resume_enabled()
        and _sync_incomplete_for_user(uid)
    ):
        me = db.get_user_by_id(uid) or user
        state = await _start_federation_sync_for_user(
            uid,
            source_base=str(request.headers.get("X-Sync-Source-Base") or ""),
            global_user_id=str(me.get("global_user_id") or ""),
            here_base=str(request.base_url),
            force=False,
        )
        if state.get("in_progress") or state.get("error"):
            sync_meta = {
                k: state[k]
                for k in (
                    "in_progress", "source_base", "progress_pct", "phase", "hint", "error",
                    "social_posts_imported", "social_posts_total",
                )
                if k in state
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
    force: bool = False,
) -> dict:
    uid = int(user_id or 0)
    if uid <= 0:
        return {"in_progress": False, "done": False, "error": "invalid user"}
    if _user_at_account_home(uid):
        _clear_federation_sync_state(uid)
        return {
            "in_progress": False,
            "done": False,
            "at_home_node": True,
            "skipped": True,
        }
    cur = _sync_state_get(uid)
    if cur.get("in_progress"):
        return cur
    if not force and not _sync_incomplete_for_user(uid):
        return cur
    if force:
        _clear_federation_sync_state(uid)
    source = _resolve_sync_source_base(
        uid,
        client_source_base=source_base,
        ticket=ticket,
        here_base=here_base,
    )
    raw_ticket = str(ticket or "").strip()
    gid = str(global_user_id or "").strip()
    if not gid:
        me = db.get_user_by_id(uid) or {}
        gid = str(me.get("global_user_id") or "").strip()
    if not source:
        return {"in_progress": False, "done": False, "error": "missing source node (home not in directory)"}
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
        "at_home_node": _user_at_account_home(user_id),
    }
    if isinstance(sync_meta, dict) and sync_meta and not out["at_home_node"]:
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

    ticket_nick = str(payload.get("nickname") or "").strip()
    had_local_account = bool(db.get_user_by_nick(ticket_nick)) if ticket_nick else False
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
    # Import only when landing on a peer node. Switching *back* to your home
    # node carries `src` = the node you left, not where account data lives.
    uid = int(user["id"])
    should_sync = (
        source_base
        and source_base != here
        and not (had_local_account and _user_at_account_home(uid))
    )
    sync_meta = None
    if should_sync:
        _sync_state_set(uid, {
            "source_base": source_base,
            "in_progress": True,
            "done": False,
            "error": "",
            "progress_pct": 2,
            "phase": "fetch",
            "hint": "Syncing channels and DMs from your home node…",
        })
        try:
            asyncio.create_task(_sync_user_from_peer_ticket(uid, source_base, body.ticket))
        except Exception:
            _log.exception("federation sync: failed to start peer-ticket task")
        sync_meta = {
            "in_progress": True,
            "source_base": source_base,
            "progress_pct": 2,
            "phase": "fetch",
            "hint": "Syncing channels and DMs from your home node…",
        }
    elif (
        had_local_account
        and not _user_at_account_home(uid)
        and _sync_login_resume_enabled()
        and _sync_incomplete_for_user(uid)
    ):
        me = db.get_user_by_id(uid) or user
        state = await _start_federation_sync_for_user(
            uid,
            source_base=source_base,
            ticket=str(body.ticket or ""),
            global_user_id=str(me.get("global_user_id") or ""),
            here_base=str(request.base_url),
            force=False,
        )
        if state.get("in_progress") or state.get("error"):
            sync_meta = {
                k: state[k]
                for k in (
                    "in_progress", "source_base", "progress_pct", "phase", "hint", "error",
                    "social_posts_imported", "social_posts_total",
                )
                if k in state
            }
    payload_out = _auth_session_response(user["id"], token, sync_meta=sync_meta)
    resp = JSONResponse(content=payload_out)
    _attach_session_cookies(resp, request, token)
    return resp


@router.get("/federation-sync-status")
async def federation_sync_status(current_user: dict = Depends(get_current_user)):
    return _sync_state_for_user(int(current_user["id"]))


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
    if _user_at_account_home(uid):
        _clear_federation_sync_state(uid)
        return {
            "in_progress": False,
            "done": False,
            "at_home_node": True,
            "skipped": True,
        }
    me = db.get_user_by_id(uid) or current_user
    state = await _start_federation_sync_for_user(
        uid,
        source_base=str(body.source_base or ""),
        ticket=str(body.ticket or ""),
        global_user_id=str(me.get("global_user_id") or ""),
        here_base=str(request.base_url),
        force=bool(body.force),
    )
    if state.get("error") and not state.get("in_progress"):
        return JSONResponse(status_code=400, content=state)
    return state


@router.post("/clear-account-home-pin")
@limiter.limit("12/hour")
async def clear_account_home_pin(
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """Clear a mistaken home pin (e.g. registered on a travel node by accident)."""
    uid = int(current_user["id"])
    db.clear_user_account_home_server_id(uid)
    _clear_federation_sync_state(uid)
    home_sid, home_base = resolve_account_home_base_url(uid)
    return {
        "ok": True,
        "at_home_node": _user_at_account_home(uid),
        "account_home_server_id": home_sid,
        "account_home_base_url": home_base,
    }


@router.post("/repin-account-home")
@limiter.limit("12/hour")
async def repin_account_home(
    request: Request,
    body: RepinAccountHomeRequest,
    current_user: dict = Depends(get_current_user),
):
    """Pin account home to a federation directory server and optionally start sync."""
    uid = int(current_user["id"])
    source = _norm_base(str(body.source_base or ""))
    if not source:
        return JSONResponse(status_code=400, content={"error": "source_base required"})
    remote_sid = _resolve_server_id_for_base(source)
    if not remote_sid:
        return JSONResponse(
            status_code=400,
            content={"error": "home not in directory", "source_base": source},
        )
    ident = db.get_or_create_local_server_identity() or {}
    local_sid = str(ident.get("server_id") or "").strip()
    db.set_user_account_home_server_id(uid, remote_sid, force=True)
    _clear_federation_sync_state(uid)
    at_home = bool(local_sid and remote_sid == local_sid)
    sync_meta = None
    if body.start_sync and not at_home:
        me = db.get_user_by_id(uid) or current_user
        state = await _start_federation_sync_for_user(
            uid,
            source_base=source,
            global_user_id=str(me.get("global_user_id") or ""),
            here_base=str(request.base_url),
            force=True,
        )
        sync_meta = state
    home_sid, home_base = resolve_account_home_base_url(uid)
    out = {
        "ok": True,
        "at_home_node": at_home,
        "account_home_server_id": home_sid,
        "account_home_base_url": home_base,
        "source_base": source,
    }
    if sync_meta:
        out["federation_sync"] = sync_meta
    return out


@router.post("/federation-sync-reset")
@limiter.limit("12/hour")
async def federation_sync_reset(
    request: Request,
    body: FederationSyncResetRequest | None = None,
    current_user: dict = Depends(get_current_user),
):
    """Clear stale sync state and directory shells so a forced re-sync can run."""
    uid = int(current_user["id"])
    clear_pin = bool(body and body.clear_home_pin)
    if clear_pin:
        db.clear_user_account_home_server_id(uid)
        _clear_federation_sync_state(uid)
        return {
            "ok": True,
            "at_home_node": _user_at_account_home(uid),
            "home_pin_cleared": True,
        }
    if _user_at_account_home(uid):
        _clear_federation_sync_state(uid)
        return {"ok": True, "at_home_node": True, "skipped": True}
    keep: set[str] = set()
    try:
        joined_ids = db.get_user_joined_room_ids(uid)
        with db._conn() as con:
            for rid in joined_ids:
                row = con.execute("SELECT name FROM rooms WHERE id=?", (int(rid),)).fetchone()
                if row:
                    nm = str(row["name"] or "").strip().lower()
                    if nm:
                        keep.add(nm)
    except Exception:
        keep = set()
    pruned = 0
    try:
        pruned = int(db.prune_federation_sync_room_shells(keep) or 0)
    except Exception:
        pruned = 0
    _clear_federation_sync_state(uid)
    return {"ok": True, "shells_pruned": pruned, "keep_rooms": sorted(keep)}


@router.post("/federation-sync-profile-gid")
@limiter.limit("240/hour")
async def federation_sync_profile_gid(
    request: Request,
    body: FederationSyncExportGidRequest,
    x_federation_token: str | None = Header(default=None),
):
    """Federation peers: public profile mirror for visiting nodes."""
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation token"})
    gid = str(body.global_user_id or "").strip()
    if not _GID_RE.match(gid):
        return JSONResponse(status_code=400, content={"error": "Invalid global_user_id"})
    payload = _lookup_federation_profile_gid_payload(gid)
    if not payload:
        return JSONResponse(status_code=404, content={"error": "Profile not found"})
    return payload


@router.get("/federation/profile-card")
@limiter.limit("120/minute")
async def federation_profile_card(
    request: Request,
    global_user_id: str = "",
    nickname: str = "",
    home_server_id: str = "",
    refresh: int = 0,
    current_user: dict = Depends(get_current_user),
):
    """Profile card for federated users (cache + optional home refresh)."""
    del current_user  # gate only — card is public fields
    out = build_federation_profile_card(
        global_user_id=global_user_id,
        nickname=nickname,
        home_server_id=home_server_id,
        refresh=bool(int(refresh or 0)),
    )
    if out.get("error"):
        code = 400 if out.get("code") == "invalid_gid" else 404
        return JSONResponse(status_code=code, content=out)
    return out


@router.post("/federation-sync-export-gid")
@limiter.limit("120/hour")
async def federation_sync_export_gid(
    request: Request,
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
    cursor = str(body.social_posts_cursor or "").strip()
    return _build_sync_export_for_user(int(row["id"]), social_posts_cursor=cursor)


@router.post("/federation-sync-memberships-gid")
@limiter.limit("240/hour")
async def federation_sync_memberships_gid(
    request: Request,
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
    return _build_sync_memberships_for_user(int(row["id"]))


@router.get("/federation-sync-export")
async def federation_sync_export(
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    cursor = str(request.query_params.get("social_posts_cursor") or "").strip()
    return _build_sync_export_for_user(
        int(current_user["id"]),
        social_posts_cursor=cursor,
    )


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
    cursor = str(body.social_posts_cursor or "").strip()
    return _build_sync_export_for_user(int(user["id"]), social_posts_cursor=cursor)


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
    gid = str(payload.get("global_user_id") or "").strip() or None
    nick = nickname
    existing = db.get_user_by_nick(nickname)
    if existing:
        ex_gid = str(existing.get("global_user_id") or "").strip()
        if gid and ex_gid and ex_gid == gid:
            return JSONResponse(status_code=200, content={"ok": True, "existing": True})
        alt = db.disambiguate_federated_nickname(nickname, gid or "", "") if gid else ""
        if not alt:
            return JSONResponse(
                status_code=409,
                content={"error": "Nickname taken by another account on this node"},
            )
        nick = alt
    user_id = db.create_user_with_hash(nick, pw_hash, gid)
    if user_id is None and gid:
        alt = db.disambiguate_federated_nickname(nick, gid, "")
        if alt and alt.lower() != nick.lower():
            user_id = db.create_user_with_hash(alt, pw_hash, gid)
            nick = alt
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
    uid = int(current_user["id"])
    out["at_home_node"] = _user_at_account_home(uid)
    if not out["at_home_node"]:
        home_sid, home_base = resolve_account_home_base_url(uid)
        if home_sid:
            out["account_home_server_id"] = home_sid
        if home_base:
            out["account_home_base_url"] = home_base
        try:
            st = _sync_state_for_user(uid)
            if st and not st.get("skipped"):
                out["federation_sync"] = {
                    k: st[k]
                    for k in (
                        "in_progress", "done", "error", "progress_pct", "phase", "hint",
                        "source_base", "social_posts_imported", "social_posts_total",
                        "social_posts_omitted_at_export", "rooms_joined", "dm_linked",
                    )
                    if k in st
                }
        except Exception:
            pass
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
    _pin_local_account_home(user_id)
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
