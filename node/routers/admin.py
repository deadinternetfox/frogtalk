"""Admin routes for ban, kick, mute operations."""
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

import database as db
from deps import get_current_user
from ws_manager import manager

router = APIRouter(prefix="/admin", tags=["admin"])


class BanBody(BaseModel):
    reason: str = ""
    duration_minutes: Optional[int] = None  # None = permanent


class MuteBody(BaseModel):
    reason: str = ""
    duration_minutes: int = 60  # Default 1 hour


def require_admin(user: dict):
    """Check if user is admin."""
    if not user.get("is_admin"):
        return False
    return True


@router.post("/ban/{nickname}")
async def ban_user(nickname: str, body: BanBody, current_user: dict = Depends(get_current_user)):
    """Globally ban a user. Admin only."""
    if not require_admin(current_user):
        return JSONResponse(status_code=403, content={"error": "Admin only"})
    
    target_id = db.get_user_id_by_nickname(nickname)
    if not target_id:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    
    if target_id == current_user["id"]:
        return JSONResponse(status_code=400, content={"error": "Cannot ban yourself"})
    
    ok = db.global_ban_user(target_id, current_user["id"], body.reason, body.duration_minutes)
    if ok:
        # Disconnect all their sessions
        await manager.disconnect_user(target_id)
        return {"ok": True, "message": f"User {nickname} has been banned"}
    return JSONResponse(status_code=500, content={"error": "Failed to ban user"})


@router.post("/unban/{nickname}")
async def unban_user(nickname: str, current_user: dict = Depends(get_current_user)):
    """Remove global ban from a user. Admin only."""
    if not require_admin(current_user):
        return JSONResponse(status_code=403, content={"error": "Admin only"})
    
    target_id = db.get_user_id_by_nickname(nickname)
    if not target_id:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    
    ok = db.global_unban_user(target_id)
    if ok:
        return {"ok": True, "message": f"User {nickname} has been unbanned"}
    return JSONResponse(status_code=404, content={"error": "User was not banned"})


@router.post("/kick/{nickname}")
async def kick_user(nickname: str, current_user: dict = Depends(get_current_user)):
    """Kick a user (disconnect all their WebSocket sessions). Admin only."""
    if not require_admin(current_user):
        return JSONResponse(status_code=403, content={"error": "Admin only"})
    
    target_id = db.get_user_id_by_nickname(nickname)
    if not target_id:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    
    if target_id == current_user["id"]:
        return JSONResponse(status_code=400, content={"error": "Cannot kick yourself"})
    
    # Disconnect all their sessions
    count = await manager.disconnect_user(target_id)
    return {"ok": True, "message": f"Kicked {nickname} ({count} session(s) disconnected)"}


@router.post("/mute/{nickname}")
async def mute_user(nickname: str, body: MuteBody, current_user: dict = Depends(get_current_user)):
    """Globally mute a user. Admin only."""
    if not require_admin(current_user):
        return JSONResponse(status_code=403, content={"error": "Admin only"})
    
    target_id = db.get_user_id_by_nickname(nickname)
    if not target_id:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    
    if target_id == current_user["id"]:
        return JSONResponse(status_code=400, content={"error": "Cannot mute yourself"})
    
    ok = db.global_mute_user(target_id, current_user["id"], body.reason, body.duration_minutes)
    if ok:
        # Notify the user they've been muted
        await manager.send_to_user(target_id, {
            "type": "system",
            "content": f"You have been muted for {body.duration_minutes} minutes."
        })
        return {"ok": True, "message": f"User {nickname} has been muted for {body.duration_minutes} minutes"}
    return JSONResponse(status_code=500, content={"error": "Failed to mute user"})


@router.post("/unmute/{nickname}")
async def unmute_user(nickname: str, current_user: dict = Depends(get_current_user)):
    """Remove mute from a user. Admin only."""
    if not require_admin(current_user):
        return JSONResponse(status_code=403, content={"error": "Admin only"})
    
    target_id = db.get_user_id_by_nickname(nickname)
    if not target_id:
        return JSONResponse(status_code=404, content={"error": "User not found"})
    
    ok = db.global_unmute_user(target_id)
    if ok:
        return {"ok": True, "message": f"User {nickname} has been unmuted"}
    return JSONResponse(status_code=404, content={"error": "User was not muted"})
