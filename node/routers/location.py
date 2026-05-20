"""Location sharing routes for DMs."""
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

import database as db
from deps import get_current_user

router = APIRouter(prefix="/location", tags=["location"])


class ShareLocationRequest(BaseModel):
    dm_channel_id: int
    latitude: float
    longitude: float
    accuracy: Optional[float] = None
    expires_hours: int = 1  # Default 1 hour


@router.post("/share")
async def share_location(body: ShareLocationRequest, current_user: dict = Depends(get_current_user)):
    """Share live location in a DM channel."""
    # Verify user is part of the DM channel
    with db._conn() as con:
        channel = con.execute("""
            SELECT id, user_a, user_b FROM dm_channels
            WHERE id=? AND (user_a=? OR user_b=?)
        """, (body.dm_channel_id, current_user["id"], current_user["id"])).fetchone()
    
    if not channel:
        return JSONResponse(status_code=404, content={"error": "DM channel not found"})
    
    # Validate coordinates
    if not (-90 <= body.latitude <= 90 and -180 <= body.longitude <= 180):
        return JSONResponse(status_code=400, content={"error": "Invalid coordinates"})
    
    if body.expires_hours < 1 or body.expires_hours > 24:
        return JSONResponse(status_code=400, content={"error": "Expires must be 1-24 hours"})
    
    db.share_location(
        body.dm_channel_id,
        current_user["id"],
        body.latitude,
        body.longitude,
        body.accuracy,
        body.expires_hours
    )
    
    return {
        "ok": True,
        "expires_hours": body.expires_hours,
        "message": f"Location shared for {body.expires_hours} hour(s)"
    }


@router.get("/dm/{channel_id}")
async def get_dm_locations(channel_id: int, current_user: dict = Depends(get_current_user)):
    """Get active location shares in a DM channel."""
    # Verify user is part of the DM channel
    with db._conn() as con:
        channel = con.execute("""
            SELECT id FROM dm_channels
            WHERE id=? AND (user_a=? OR user_b=?)
        """, (channel_id, current_user["id"], current_user["id"])).fetchone()
    
    if not channel:
        return JSONResponse(status_code=404, content={"error": "DM channel not found"})
    
    locations = db.get_shared_locations(channel_id)
    return {"locations": locations}


@router.delete("/dm/{channel_id}")
async def stop_sharing_location(channel_id: int, current_user: dict = Depends(get_current_user)):
    """Stop sharing location in a DM channel."""
    if db.stop_location_share(channel_id, current_user["id"]):
        return {"ok": True, "message": "Location sharing stopped"}
    return JSONResponse(status_code=404, content={"error": "No active location share"})


@router.patch("/settings")
async def update_location_settings(current_user: dict = Depends(get_current_user)):
    """Toggle location sharing permission."""
    with db._conn() as con:
        current = con.execute(
            "SELECT location_sharing_enabled FROM users WHERE id=?",
            (current_user["id"],)
        ).fetchone()
        new_val = 0 if current and current[0] else 1
        con.execute(
            "UPDATE users SET location_sharing_enabled=? WHERE id=?",
            (new_val, current_user["id"])
        )
    
    return {"location_sharing_enabled": bool(new_val)}
