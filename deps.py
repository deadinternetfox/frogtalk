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
                        with db._conn() as con:
                            con.execute(
                                "UPDATE sessions SET user_agent=COALESCE(NULLIF(user_agent,''), ?), "
                                "ip_address=COALESCE(NULLIF(ip_address,''), ?), last_active=datetime('now') "
                                "WHERE token=?",
                                (ua, ip, token),
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
