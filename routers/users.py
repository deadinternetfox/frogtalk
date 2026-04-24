"""User profile routes."""
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

import database as db
from deps import get_current_user

router = APIRouter(prefix="/users", tags=["users"])


@router.get("")
async def list_users(_: dict = Depends(get_current_user)):
    users = db.get_all_users()
    # Never expose password hashes
    return {"users": [{"id": u["id"], "nickname": u["nickname"],
                       "avatar": u["avatar"], "bio": u["bio"],
                       "is_admin": bool(u["is_admin"])} for u in users]}


@router.get("/{user_id}")
async def get_user(user_id: int, _: dict = Depends(get_current_user)):
    user = db.get_user_by_id(user_id)
    if not user:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    return {"id": user["id"], "nickname": user["nickname"],
            "avatar": user["avatar"], "bio": user["bio"],
            "is_admin": bool(user["is_admin"])}


# ─── User blocks ──────────────────────────────────────────────────────────────

@router.post("/{user_id}/block")
async def block_user(user_id: int, current_user: dict = Depends(get_current_user)):
    """Block a user."""
    if user_id == current_user["id"]:
        return JSONResponse(status_code=400, content={"error": "Cannot block yourself"})
    
    target = db.get_user_by_id(user_id)
    if not target:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    
    ok = db.block_user(current_user["id"], user_id)
    if not ok:
        return JSONResponse(status_code=409, content={"error": "User already blocked"})
    return {"ok": True}


@router.delete("/{user_id}/block")
async def unblock_user(user_id: int, current_user: dict = Depends(get_current_user)):
    """Unblock a user."""
    ok = db.unblock_user(current_user["id"], user_id)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "User not blocked"})
    return {"ok": True}


@router.get("/me/blocked")
async def get_blocked_users(current_user: dict = Depends(get_current_user)):
    """Get list of blocked users."""
    return {"blocked": db.get_blocked_users(current_user["id"])}


@router.get("/me/bans")
async def get_my_room_bans(current_user: dict = Depends(get_current_user)):
    """List channels the current user is currently banned from (read-only, self only)."""
    return {"bans": db.get_user_room_bans(current_user["id"])}


@router.get("/{user_id}/aliases")
async def get_user_aliases(user_id: int, current_user: dict = Depends(get_current_user)):
    """Get nickname history for a user (visible to self or admin only)."""
    if user_id != current_user["id"] and not current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Cannot view other users' nickname history"})
    
    history = db.get_nickname_history(user_id)
    return {"aliases": history}
