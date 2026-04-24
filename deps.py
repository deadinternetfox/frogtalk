"""Auth dependency for FrogChat routes."""
from fastapi import Header, HTTPException, status
import database as db


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
