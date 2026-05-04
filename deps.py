"""Auth dependency for FrogChat routes."""
from fastapi import Header, HTTPException, Request, status
from slowapi.util import get_remote_address
import database as db


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


def get_current_user(x_session_token: str = Header(None, alias="X-Session-Token")):
    if not x_session_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    user = db.get_user_by_token(x_session_token)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")
    return user


def get_admin_user(x_session_token: str = Header(None, alias="X-Session-Token")):
    user = get_current_user(x_session_token)
    if not user.get("is_admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user
