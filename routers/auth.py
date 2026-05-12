"""Auth routes: register, login, logout, me."""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
import urllib.error
import urllib.request
import uuid
from typing import Optional

_log = logging.getLogger(__name__)
from fastapi import APIRouter, Request, Depends, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from slowapi import Limiter

import database as db
import geoip
from deps import get_current_user, client_ip, invalidate_token_cache
from ws_manager import manager

router = APIRouter(prefix="/auth", tags=["auth"])
limiter = Limiter(key_func=client_ip)

NICKNAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{2,32}$")

MAX_AVATAR_BYTES = 2 * 1024 * 1024  # 2 MB in base64
FED_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 FrogTalkFederation/1.0"


def _norm_base(url: str) -> str:
    raw = (url or "").strip()
    if not raw:
        return ""
    if not raw.startswith("http://") and not raw.startswith("https://"):
        raw = f"https://{raw}"
    return raw.rstrip("/")


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
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


def _get_json(url: str, headers: dict | None = None, timeout: float = 3.5):
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": FED_UA,
            **(headers or {}),
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


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


def _tor_mode_enabled() -> bool:
    return (os.getenv("FROGTALK_TOR_ENABLED", "0") or "0").strip().lower() in ("1", "true", "yes", "on")


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
            }
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError):
            continue
        except Exception:
            continue
    return None


class RegisterRequest(BaseModel):
    nickname: str
    # Cap the password length so we don't feed multi-megabyte strings
    # into bcrypt (each hash is O(n) in the input length and bcrypt is
    # intentionally slow). 128 bytes is comfortably more than any real
    # password and matches OWASP guidance.
    password: str = Field(min_length=1, max_length=128)


class LoginRequest(BaseModel):
    nickname: str
    password: str = Field(min_length=1, max_length=128)


class FederationTicketRequest(BaseModel):
    target_base_url: str | None = None
    target_url: str | None = None


class FederationTicketLoginRequest(BaseModel):
    ticket: str


class ProfileUpdateRequest(BaseModel):
    avatar: str | None = None
    banner: str | None = None
    bio: str | None = None
    new_password: str | None = None
    current_password: str | None = None
    status_msg: str | None = None
    presence: str | None = None
    profile_public: bool | None = None
    allow_friend_requests: bool | None = None
    # New settings fields
    theme: str | None = None
    notify_sounds: bool | None = None
    notify_desktop: bool | None = None
    notify_dms: bool | None = None
    notify_mentions: bool | None = None
    allow_dms_from: str | None = None
    show_last_seen: str | None = None
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
@limiter.limit("10/hour")
async def register(
    request: Request,
    body: RegisterRequest,
    x_federation_relay: str | None = Header(default=None),
):
    # Gate the legacy plaintext-password registration route. Default mode
    # "secure" forces clients to use /register-secure (CAPTCHA-protected) and
    # blocks bot account farming. Federation relays bypass this gate because
    # they replicate accounts that were already validated on the issuing node.
    is_relay = (x_federation_relay or "").strip() == "1"
    if not is_relay and _signups_mode() != "open":
        return JSONResponse(status_code=403, content={"error": "Registration is closed; use /api/auth/register-secure"})
    if not NICKNAME_RE.match(body.nickname):
        return JSONResponse(status_code=400, content={
            "error": "Nickname must be 2-32 characters: letters, numbers, _ or -"
        })
    if len(body.password) < 6:
        return JSONResponse(status_code=400, content={"error": "Password must be at least 6 characters"})
    user_id = db.create_user(body.nickname, body.password)
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
    return {"token": token, "nickname": body.nickname, "user_id": user_id, "is_admin": False}


@router.post("/login")
@limiter.limit("20/hour")
async def login(request: Request, body: LoginRequest):
    # bcrypt.checkpw is CPU-bound (50–300 ms). Running it directly inside an
    # async route blocks the single uvicorn event loop for that whole window,
    # which is what made the very first /api/auth/me + /api/auth/login feel
    # like the server was "hanging" right after page load. Push it into a
    # worker thread so other requests keep flowing while bcrypt runs.
    user = await asyncio.to_thread(db.verify_user, body.nickname, body.password)
    if not user:
        # Optional federated bootstrap: if credentials are valid on a known
        # peer server, create the local account/profile so server switches feel
        # seamless while each node keeps independent encrypted storage.
        # Disabled by default (FEDERATION_LEGACY_PLAINTEXT=0) to avoid
        # forwarding plaintext passwords across the federation network.
        boot = None
        if _federation_legacy_plaintext_enabled():
            boot = await _try_federated_login_bootstrap(request, body.nickname, body.password)
        if not boot:
            return JSONResponse(status_code=401, content={"error": "Invalid nickname or password"})
        user = boot["user"]
    token = _create_session_with_meta(request, user["id"])
    return {
        "token": token,
        "nickname": user["nickname"],
        "display_name": user.get("display_name"),
        "username_change_remaining_seconds": int(db.username_change_remaining_seconds(user["id"])),
        "user_id": user["id"],
        "is_admin": bool(user["is_admin"]),
        "avatar": user["avatar"],
        "bio": user["bio"],
    }


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

    token = _create_session_with_meta(request, user["id"])
    return {
        "token": token,
        "nickname": user["nickname"],
        "display_name": user.get("display_name"),
        "username_change_remaining_seconds": int(db.username_change_remaining_seconds(user["id"])),
        "user_id": user["id"],
        "is_admin": bool(user.get("is_admin")),
        "avatar": user.get("avatar"),
        "bio": user.get("bio"),
    }


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
    x_session_token: str = Header(None, alias="X-Session-Token"),
    current_user: dict = Depends(get_current_user),
):
    """Revoke the caller's current session token and drop it from the
    auth cache so subsequent requests can't ride the 15 s TTL window."""
    token = (x_session_token or "").strip()
    if token:
        await asyncio.to_thread(db.delete_session, token)
        invalidate_token_cache(token)
    return {"ok": True}


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
    nickname: str
    password: str


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
    display_name: Optional[str] = None  # None or "" clears it


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
    return out


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

    try:
        ident = db.get_user_by_id(current_user["id"]) or {}
        db.insert_federation_outbox_event({
            "event_id": f"evt_{int(time.time() * 1000):016x}_{uuid.uuid4().hex[:8]}",
            "event_type": "user.profile.updated",
            "payload": {
                "global_user_id": ident.get("global_user_id") or "",
                "nickname": ident.get("nickname") or current_user.get("nickname") or "",
                "display_name": ident.get("display_name") or "",
                "avatar": ident.get("avatar") or "",
                "bio": ident.get("bio") or "",
                "status_msg": ident.get("status_msg") or "",
                "presence": ident.get("presence") or "online",
                "mood": ident.get("mood") or "",
                "identity_pubkey": ident.get("identity_pubkey") or "",
            },
        })
    except Exception:
        pass
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
    return {"ok": True}


class DeleteAccountRequest(BaseModel):
    password: str


@router.delete("/account")
async def delete_account(body: DeleteAccountRequest, current_user: dict = Depends(get_current_user)):
    """Permanently delete user account. Requires password confirmation."""
    # Verify password
    if not db.verify_user(current_user["nickname"], body.password):
        return JSONResponse(status_code=401, content={"error": "Incorrect password"})
    
    # Prevent admin account deletion
    if current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Admin accounts cannot be deleted"})
    
    # Delete the account
    ok = db.delete_user_account(current_user["id"])
    if not ok:
        return JSONResponse(status_code=500, content={"error": "Failed to delete account"})
    
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
@limiter.limit("10/hour")
async def register_with_captcha(
    request: Request,
    body: RegisterWithCaptchaRequest,
    x_federation_relay: str | None = Header(default=None),
):
    """Register with CAPTCHA verification (bot-proof)."""
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
    
    user_id = db.create_user(body.nickname, body.password)
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
    
    # Generate recovery key
    raw_key = secrets.token_urlsafe(32)
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    
    db.create_recovery_key(current_user["id"], key_hash)
    
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
    
    key_hash = hashlib.sha256(body.recovery_key.encode()).hexdigest()
    user_id = db.use_recovery_key(key_hash)
    
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
    key_hash = hashlib.sha256(body.recovery_key.encode()).hexdigest()
    
    with db._conn() as con:
        row = con.execute("""
            SELECT rk.id, u.nickname FROM recovery_keys rk
            JOIN users u ON rk.user_id = u.id
            WHERE rk.key_hash=? AND rk.used_at IS NULL
        """, (key_hash,)).fetchone()
    
    if row:
        return {"valid": True, "username": row["nickname"]}
    return {"valid": False}
