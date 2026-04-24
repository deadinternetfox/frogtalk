from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import database as db
from deps import get_current_user
from ws_manager import manager


router = APIRouter(prefix="/calls", tags=["calls"])


class DeclineCallRequest(BaseModel):
    call_id: Optional[int] = None
    peer_nick: Optional[str] = None


@router.get("/{call_id}/pending")
async def get_pending_call(call_id: int, current_user: dict = Depends(get_current_user)):
    row = db.get_pending_call_offer(call_id, current_user["id"])
    if not row:
        raise HTTPException(status_code=404, detail="Pending call not found")
    if row.get("status") != "ringing":
        raise HTTPException(status_code=409, detail="Call is no longer ringing")
    return {
        "type": "call_offer",
        "call_id": row["call_id"],
        "from_id": row["caller_id"],
        "from_nickname": row["from_nickname"],
        "from_avatar": row.get("from_avatar") or "",
        "call_type": row["call_type"],
        "sdp": row["sdp"],
    }


@router.get("/pending-latest")
async def get_latest_pending_call(current_user: dict = Depends(get_current_user)):
    row = db.get_latest_pending_call_offer(current_user["id"])
    if not row:
        raise HTTPException(status_code=404, detail="No pending call")
    if row.get("status") != "ringing":
        raise HTTPException(status_code=409, detail="Call is no longer ringing")
    return {
        "type": "call_offer",
        "call_id": row["call_id"],
        "from_id": row["caller_id"],
        "from_nickname": row["from_nickname"],
        "from_avatar": row.get("from_avatar") or "",
        "call_type": row["call_type"],
        "sdp": row["sdp"],
    }


@router.post("/{call_id}/decline")
async def decline_pending_call(call_id: int, current_user: dict = Depends(get_current_user)):
    row = db.get_pending_call_offer(call_id, current_user["id"])
    if not row:
        return {"ok": False, "error": "Pending call not found"}
    if row.get("status") != "ringing":
        return {"ok": False, "error": "Call is no longer ringing"}

    db.update_call_status(call_id, "rejected", ended_at=datetime.utcnow().isoformat())
    db.delete_pending_call_offer(call_id)

    await manager.send_to_user(int(row["caller_id"]), {
        "type": "call_reject",
        "from_id": current_user["id"],
        "from_nickname": current_user.get("nickname") or "Someone",
        "call_id": call_id,
    })
    return {"ok": True}


@router.post("/decline")
async def decline_call(payload: DeclineCallRequest, current_user: dict = Depends(get_current_user)):
    row = None
    if payload.call_id:
        row = db.get_pending_call_offer(int(payload.call_id), current_user["id"])

    # Fallback: if call_id was missing/stale, decline the latest ringing call
    # for this callee (optionally scoped to a caller nickname).
    if not row:
        with db._conn() as con:
            if payload.peer_nick:
                row_db = con.execute(
                    """
                    SELECT c.id AS call_id, c.caller_id, u.nickname AS from_nickname
                    FROM calls c
                    JOIN users u ON u.id = c.caller_id
                    WHERE c.callee_id=? AND c.status='ringing' AND lower(u.nickname)=lower(?)
                    ORDER BY c.id DESC LIMIT 1
                    """,
                    (current_user["id"], str(payload.peer_nick).strip()),
                ).fetchone()
            else:
                row_db = con.execute(
                    """
                    SELECT c.id AS call_id, c.caller_id, u.nickname AS from_nickname
                    FROM calls c
                    JOIN users u ON u.id = c.caller_id
                    WHERE c.callee_id=? AND c.status='ringing'
                    ORDER BY c.id DESC LIMIT 1
                    """,
                    (current_user["id"],),
                ).fetchone()
        row = dict(row_db) if row_db else None

    if not row:
        return {"ok": False, "error": "No ringing call to decline"}

    call_id = int(row["call_id"])
    db.update_call_status(call_id, "rejected", ended_at=datetime.utcnow().isoformat())
    db.delete_pending_call_offer(call_id)
    await manager.send_to_user(int(row["caller_id"]), {
        "type": "call_reject",
        "from_id": current_user["id"],
        "from_nickname": current_user.get("nickname") or "Someone",
        "call_id": call_id,
    })
    return {"ok": True, "call_id": call_id}