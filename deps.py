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


async def get_current_user(x_session_token: str = Header(None, alias="X-Session-Token")):
    if not x_session_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    cached = _token_cache_get(x_session_token)
    if cached is not None:
        return cached
    # Cache miss: run the sync DB lookup off the event loop so we never
    # block other requests on it.
    from starlette.concurrency import run_in_threadpool
    user = await run_in_threadpool(db.get_user_by_token, x_session_token)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")
    _token_cache_put(x_session_token, user)
    return user


async def get_admin_user(x_session_token: str = Header(None, alias="X-Session-Token")):
    user = await get_current_user(x_session_token)
    if not user.get("is_admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user
