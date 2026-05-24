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


class AbandonCallRequest(BaseModel):
    call_id: Optional[int] = None


async def _notify_call_abandoned(call_row: dict, user_id: int) -> None:
    """Tell the peer this call ended and silence other sessions for ``user_id``."""
    call_id = int(call_row["id"])
    caller_id = int(call_row["caller_id"])
    callee_id = int(call_row["callee_id"])
    peer_id = callee_id if user_id == caller_id else caller_id
    status = str(call_row.get("status") or "")
    was_connected = status == "active"
    end_payload = {
        "type": "call_end",
        "from_id": user_id,
        "call_id": call_id,
        "was_connected": was_connected,
    }
    from_user = db.get_user_by_id(user_id) or {}
    end_payload["from_nickname"] = from_user.get("nickname") or ""
    await manager.send_to_user(peer_id, end_payload)
    await manager.send_to_user(user_id, {
        "type": "call_handled",
        "action": "ended",
        "call_id": call_id,
    })
    try:
        import federation_calls as _fc
        peer = db.get_user_by_id(peer_id) or {}
        gid = str(call_row.get("global_call_id") or "").strip()
        if gid and _fc.is_remote_peer(peer):
            pgid = str(peer.get("global_user_id") or "")
            if pgid:
                _fc.enqueue_call_end(
                    from_user,
                    pgid,
                    global_call_id=gid,
                    status="ended" if was_connected else "missed",
                )
    except Exception:
        pass


@router.post("/abandon")
async def abandon_open_call(
    payload: AbandonCallRequest,
    current_user: dict = Depends(get_current_user),
):
    """Best-effort hangup when the client closes mid-call (fetch keepalive / pagehide)."""
    uid = int(current_user["id"])
    row = db.find_open_call_for_user(uid, call_id=int(payload.call_id or 0))
    if not row:
        return {"ok": True, "cleared": False}
    call_id = int(row["id"])
    status = str(row.get("status") or "")
    ended_at = datetime.utcnow().isoformat()
    db.delete_pending_call_offer(call_id)
    if status == "ringing":
        db.update_call_status(call_id, "missed", ended_at=ended_at)
    else:
        db.update_call_status(call_id, "ended", ended_at=ended_at)
    await _notify_call_abandoned(row, uid)
    return {"ok": True, "cleared": True, "call_id": call_id}


@router.post("/reconcile")
async def reconcile_call_session(current_user: dict = Depends(get_current_user)):
    """On login/boot: expire stale server rows so recovery does not resurrect ghost rings."""
    uid = int(current_user["id"])
    ringing = db.expire_stale_ringing_calls()
    active = db.expire_stale_active_calls()
    open_row = db.find_open_call_for_user(uid)
    pending = db.get_latest_pending_call_offer(uid)
    return {
        "ok": True,
        "expired_ringing": ringing,
        "expired_active": active,
        "open_call_id": int(open_row["id"]) if open_row else None,
        "pending_call_id": int(pending["call_id"]) if pending else None,
    }


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
        "fp_sig": row.get("fp_sig") or "",
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
        "fp_sig": row.get("fp_sig") or "",
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
    # Silence any other device/tab that is still ringing for this callee.
    await manager.send_to_user(int(current_user["id"]), {
        "type": "call_handled",
        "action": "declined",
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
    # Also broadcast to the callee's OTHER sessions (other browser tab, the
    # WebView, the desktop app) so any incoming-call UI still ringing there
    # silences immediately. This handles the case where the user declines via
    # the Android system notification while the WebView/desktop app is still
    # showing the incoming-call card with a ringtone playing.
    await manager.send_to_user(int(current_user["id"]), {
        "type": "call_handled",
        "action": "declined",
        "call_id": call_id,
    })
    return {"ok": True, "call_id": call_id}