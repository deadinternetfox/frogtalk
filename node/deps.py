"""Auth dependency for FrogChat routes."""
import time
from fastapi import Header, HTTPException, Request, status
from slowapi.util import get_remote_address
import database as db


# ── Token → user in-memory cache ────────────────────────────────────────
# Every authed request used to do a sync SQLite lookup inside a worker
# thread (FastAPI runs sync `def` deps in the threadpool). Under a tab-
# switch storm in Frog Social that meant 4-8 threadpool tokens just for
# the auth check on each click, plus a context-switch + DB hit each time
# — perceptibly slower than channel chat, which holds an in-memory user
# on its WebSocket.
#
# A short-TTL in-memory cache short-circuits the lookup. The dependency
# becomes `async def`, so a cache hit doesn't burn a threadpool token at
# all — it returns straight from the event loop. Sessions are 30 days
# long, so a 15 s window can't outlive a real revocation in any way that
# matters; logout currently doesn't revoke sessions anyway.
_TOKEN_CACHE_TTL = 15.0
_TOKEN_CACHE_MAX = 4096
_token_cache: dict[str, tuple[float, dict]] = {}


def _token_cache_get(token: str):
    entry = _token_cache.get(token)
    if not entry:
        return None
    ts, user = entry
    if (time.monotonic() - ts) >= _TOKEN_CACHE_TTL:
        _token_cache.pop(token, None)
        return None
    return user


def _token_cache_put(token: str, user: dict) -> None:
    _token_cache[token] = (time.monotonic(), user)
    if len(_token_cache) > _TOKEN_CACHE_MAX:
        # Drop the oldest half — cheap and bounded.
        for k in sorted(_token_cache, key=lambda k: _token_cache[k][0])[: _TOKEN_CACHE_MAX // 2]:
            _token_cache.pop(k, None)


def invalidate_token_cache(token: str | None = None) -> None:
    """Drop a single token (or the whole cache) from the auth cache.
    Called by handlers that mutate the user (nickname change, logout
    if it ever actually revokes) so stale data doesn't linger for the
    TTL window."""
    if token is None:
        _token_cache.clear()
    else:
        _token_cache.pop(token, None)


def client_ip(request: Request) -> str:
    """Real client IP key for slowapi limiters.

    Order: Cloudflare's CF-Connecting-IP (most trusted when fronted by CF),
    then the first hop in X-Forwarded-For, then the socket peer.
    Falls back to slowapi's default if everything is missing.
    """
    try:
        cf = (request.headers.get("cf-connecting-ip") or "").strip()
        if cf:
            return cf
        xff = (request.headers.get("x-forwarded-for") or "").strip()
        if xff:
            # First entry is the originating client (per RFC 7239 / common proxies).
            first = xff.split(",")[0].strip()
            if first:
                return first
    except Exception:
        pass
    return get_remote_address(request)


async def get_current_user(request: Request = None, x_session_token: str = Header(None, alias="X-Session-Token")):
    # Auth source priority:
    #   1. X-Session-Token header (legacy SPA, bots, native clients)
    #   2. HttpOnly `ft_session` cookie (HIGH-2: not reachable to JS;
    #      prevents XSS-stolen tokens from logging in elsewhere)
    #   3. `Authorization: Bearer …` (federated bots, REST clients)
    #   4. `?token=…` query string (only kept for <img>/<video> src=
    #      that browsers won't decorate with custom headers; this path
    #      stays for now but the long-term plan is to move to signed
    #      short-lived media URLs)
    if not x_session_token and request is not None:
        try:
            # 2. Cookie — preferred for browser SPA sessions.
            cookie_tok = (request.cookies.get("ft_session") or "").strip()
            if cookie_tok:
                x_session_token = cookie_tok
            else:
                # 3. Bearer.
                auth = (request.headers.get("authorization") or "").strip()
                if auth.lower().startswith("bearer "):
                    x_session_token = auth[7:].strip()
                if not x_session_token:
                    # 4. Query — last resort.
                    qtok = (request.query_params.get("token") or "").strip()
                    if qtok:
                        x_session_token = qtok
        except Exception:
            pass
    if not x_session_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    cached = _token_cache_get(x_session_token)
    if cached is not None:
        # Opportunistic backfill: if the session row predates v300 (no UA/IP),
        # capture them now from this live request and kick off a geo lookup.
        # Single-shot per token via the cache flag below.
        if request is not None:
            _maybe_backfill_session(request, x_session_token)
        return cached
    # Cache miss: run the sync DB lookup off the event loop so we never
    # block other requests on it.
    from starlette.concurrency import run_in_threadpool
    user = await run_in_threadpool(db.get_user_by_token, x_session_token)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")
    _token_cache_put(x_session_token, user)
    if request is not None:
        _maybe_backfill_session(request, x_session_token)
    return user


# Tokens we've already attempted to backfill this process — keeps us from
# re-running the SQLite + GeoIP path on every request from old clients.
_backfilled: set[str] = set()


def _maybe_backfill_session(request: Request, token: str) -> None:
    if not token or token in _backfilled:
        return
    _backfilled.add(token)
    try:
        ua = (request.headers.get("user-agent") or "")[:512]
    except Exception:
        ua = ""
    try:
        ip = client_ip(request) or ""
    except Exception:
        ip = ""
    if not (ua or ip):
        return
    try:
        import asyncio as _asyncio

        async def _do():
            try:
                from starlette.concurrency import run_in_threadpool as _rt
                # Only patch rows that are currently empty so we don't clobber
                # accurate metadata captured at login time.
                def _patch():
                    try:
                        # Match either the hashed-at-rest token (current
                        # storage format) or the legacy plaintext for any
                        # session row issued before the hash migration.
                        hashed = db._hash_session_token(token)
                        with db._conn() as con:
                            con.execute(
                                "UPDATE sessions SET user_agent=COALESCE(NULLIF(user_agent,''), ?), "
                                "ip_address=COALESCE(NULLIF(ip_address,''), ?), last_active=datetime('now') "
                                "WHERE token IN (?, ?)",
                                (ua, ip, hashed, token),
                            )
                            con.commit()
                    except Exception:
                        pass
                await _rt(_patch)
                if ip:
                    try:
                        import geoip
                        info = await _rt(geoip.lookup, ip)
                        if info and (info.get("country_code") or info.get("country") or info.get("city")):
                            await _rt(
                                db.update_session_geo,
                                token,
                                info.get("country_code", ""),
                                info.get("country", ""),
                                info.get("city", ""),
                            )
                    except Exception:
                        pass
            except Exception:
                pass

        _asyncio.create_task(_do())
    except RuntimeError:
        # No running loop (rare in FastAPI request path) — nothing to do.
        pass


async def get_admin_user(request: Request = None, x_session_token: str = Header(None, alias="X-Session-Token")):
    user = await get_current_user(request, x_session_token)
    if not user.get("is_admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user


async def resolve_current_user(request: Request) -> dict:
    """Load the session user when calling outside FastAPI Depends (e.g. /server)."""
    token = session_token_from_request(request)
    return await get_current_user(request, token or None)


async def resolve_admin_user(request: Request) -> dict:
    """Admin check for hand-rolled request handlers."""
    token = session_token_from_request(request)
    return await get_admin_user(request, token or None)


# ── Server-side PIN lock enforcement ────────────────────────────────────
# Until this pass the PIN was a *client* lock only: an attacker holding a
# valid session token could just bypass the overlay and call the API
# directly. The state below promotes the PIN into a real server-side
# gate that sits on top of the session token.
#
# Model:
#   * Each session token has an in-memory entry { unlocked_at, last_active }.
#     Process restart = everyone re-locked (intentional; defence in depth).
#   * Login / register / federation-ticket-login / pin.verify all call
#     pin_mark_unlocked(token) — fresh authentication grants entry to the
#     gated endpoints because either (a) the user just typed the PIN or
#     (b) they just typed the password, which is strictly stronger than
#     the PIN.
#   * Logout / pin.disable call pin_clear_for_token(token) so the next
#     access has to re-verify.
#   * pin_gate dep raises HTTP 423 with {pin_required: true} when the
#     user has has_pin & pin_require_on_unlock and either was never
#     unlocked this process or has been idle past pin_idle_timeout_sec.
#   * On every successful gated request we bump last_active so an
#     actively-using session doesn't get re-locked mid-action.
#   * Token storage key is the bcrypt-friendly hashed-at-rest form
#     (db._hash_session_token) so a memory dump never reveals raw tokens.
import threading

_pin_state_lock = threading.Lock()
_pin_state: dict[str, dict] = {}
_PIN_STATE_MAX = 8192


def _pin_key(token: str) -> str:
    raw = (token or "").strip()
    if not raw:
        return ""
    try:
        return db._hash_session_token(raw)
    except Exception:
        return raw


def pin_mark_unlocked(token: str) -> None:
    """Record a fresh unlock for `token`. Idempotent."""
    k = _pin_key(token)
    if not k:
        return
    now = time.time()
    with _pin_state_lock:
        _pin_state[k] = {"unlocked_at": now, "last_active": now}
        if len(_pin_state) > _PIN_STATE_MAX:
            # Evict stalest half — cheap O(n), bounded by _PIN_STATE_MAX.
            stale = sorted(_pin_state.items(), key=lambda kv: kv[1].get("last_active", 0))
            for ks, _ in stale[: _PIN_STATE_MAX // 2]:
                _pin_state.pop(ks, None)


def pin_clear_for_token(token: str) -> None:
    """Drop unlock state for `token`. Called on logout and PIN disable."""
    k = _pin_key(token)
    if not k:
        return
    with _pin_state_lock:
        _pin_state.pop(k, None)


def _pin_session_is_locked(user: dict, token: str) -> bool:
    """True iff the session must re-verify the PIN before serving."""
    if not user or not token:
        return False
    if not int(user.get("has_pin") or 0):
        return False
    if not int(user.get("pin_require_on_unlock") or 0):
        return False
    idle_limit = int(user.get("pin_idle_timeout_sec") or 300)
    # idle_limit == 0 means "lock immediately on blur" — server treats
    # that as a 5 s grace so a single in-flight request doesn't trip.
    if idle_limit <= 0:
        idle_limit = 5
    k = _pin_key(token)
    now = time.time()
    with _pin_state_lock:
        st = _pin_state.get(k)
        if not st:
            return True
        if (now - float(st.get("last_active", 0))) > idle_limit:
            # Expired — purge so we don't keep stale entries around.
            _pin_state.pop(k, None)
            return True
        # Bump activity so an active user stays unlocked.
        st["last_active"] = now
    return False


async def pin_gate(
    request: Request = None,
    x_session_token: str = Header(None, alias="X-Session-Token"),
):
    """FastAPI dependency that combines `get_current_user` with the
    server-side PIN gate. Apply via
        app.include_router(router, dependencies=[Depends(pin_gate)])
    for any router serving sensitive data (messages, DMs, social, …).
    """
    user = await get_current_user(request, x_session_token)
    token = session_token_from_request(request) or (x_session_token or "").strip()
    if _pin_session_is_locked(user, token):
        # 423 Locked is the natural code here (WebDAV repurposed). The
        # body deliberately contains no user info — only the signal the
        # client needs to pop its PIN prompt.
        raise HTTPException(
            status_code=423,
            detail={"pin_required": True, "error": "PIN required"},
        )
    return user


# ── Admin-area PIN gate ─────────────────────────────────────────────────
# HIGH-1: ``pin_require_for_admin`` used to be enforced only in the
# browser via ``static/js/pin.js`` ``gateAdmin()``. The actual admin
# routes (``routers/admin.py``, the server-admin mount, etc.) were only
# behind ``pin_gate`` which checks ``pin_require_on_unlock``. A stolen
# bearer token + ``pin_require_on_unlock=0`` was enough to call
# ``POST /api/admin/ban/{nick}`` directly without ever facing the PIN
# prompt the user had explicitly enabled. ``admin_pin_gate`` closes that
# gap: any user who enabled "Require PIN for admin areas" must have
# re-typed the PIN within ``_ADMIN_PIN_TTL`` seconds before the request
# is served, regardless of the unlock-on-resume setting.

_ADMIN_PIN_TTL = 300  # seconds; matches the client-side `gateAdmin()` default

# Per-session "admin grace" tracker, separate from `_pin_state` so that
# unlocking the lock screen does NOT also satisfy the admin re-prompt.
_admin_pin_state_lock = threading.Lock()
_admin_pin_state: dict[str, float] = {}
_ADMIN_PIN_STATE_MAX = 4096


def admin_pin_mark_unlocked(token: str) -> None:
    """Record a fresh admin-area unlock. Called by ``/api/auth/pin/verify``
    after a successful PIN check so the next admin call goes through."""
    k = _pin_key(token)
    if not k:
        return
    now = time.time()
    with _admin_pin_state_lock:
        _admin_pin_state[k] = now
        if len(_admin_pin_state) > _ADMIN_PIN_STATE_MAX:
            stale = sorted(_admin_pin_state.items(), key=lambda kv: kv[1])
            for ks, _ in stale[: _ADMIN_PIN_STATE_MAX // 2]:
                _admin_pin_state.pop(ks, None)


def admin_pin_clear_for_token(token: str) -> None:
    k = _pin_key(token)
    if not k:
        return
    with _admin_pin_state_lock:
        _admin_pin_state.pop(k, None)


def _admin_pin_required(user: dict, token: str) -> bool:
    if not user or not token:
        return False
    if not int(user.get("has_pin") or 0):
        return False
    if not int(user.get("pin_require_for_admin") or 0):
        return False
    k = _pin_key(token)
    now = time.time()
    with _admin_pin_state_lock:
        ts = _admin_pin_state.get(k)
        if ts is not None and (now - ts) <= _ADMIN_PIN_TTL:
            # Bump so an active admin session doesn't lock mid-action.
            _admin_pin_state[k] = now
            return False
    return True


def admin_area_access_status(user: dict | None, token: str) -> dict:
    """Return whether this session may access operator areas (/server, /board/admin).

    Used by bootstrap endpoints and PHP gate checks. Does not raise — callers
    map ``allowed`` to HTTP status codes.
    """
    if not user:
        return {
            "allowed": False,
            "authenticated": False,
            "is_admin": False,
            "pin_required": False,
        }
    if not user.get("is_admin"):
        return {
            "allowed": False,
            "authenticated": True,
            "is_admin": False,
            "pin_required": False,
            "nickname": user.get("nickname") or "",
        }
    pin_unlock = _pin_session_is_locked(user, token)
    pin_admin = _admin_pin_required(user, token)
    pin_required = pin_unlock or pin_admin
    return {
        "allowed": not pin_required,
        "authenticated": True,
        "is_admin": True,
        "pin_required": pin_required,
        "has_pin": bool(int(user.get("has_pin") or 0)),
        "pin_require_for_admin": bool(int(user.get("pin_require_for_admin") or 0)),
        "nickname": user.get("nickname") or "",
    }


def session_token_from_request(request: Request | None) -> str:
    """Extract the active session token from header or ``ft_session`` cookie."""
    if request is None:
        return ""
    tok = (request.headers.get("x-session-token") or request.headers.get("X-Session-Token") or "").strip()
    if tok:
        return tok
    return (request.cookies.get("ft_session") or "").strip()


def invalidate_request_session_cache(request: Request | None) -> None:
    """Drop the cached user row for the session on this HTTP request."""
    tok = session_token_from_request(request)
    if tok:
        invalidate_token_cache(tok)
    else:
        invalidate_token_cache(None)


async def admin_pin_gate(
    request: Request = None,
    x_session_token: str = Header(None, alias="X-Session-Token"),
):
    """Strict version of ``pin_gate`` for admin areas.

    Mount with::

        app.include_router(admin_mod.router, prefix="/api",
                           dependencies=_PIN_GATED + [Depends(admin_pin_gate)])
    """
    user = await get_current_user(request, x_session_token)
    token = session_token_from_request(request) or (x_session_token or "").strip()
    if _pin_session_is_locked(user, token) or _admin_pin_required(user, token):
        raise HTTPException(
            status_code=423,
            detail={
                "pin_required": True,
                "admin": True,
                "error": "PIN required for admin actions",
            },
        )
    return user
