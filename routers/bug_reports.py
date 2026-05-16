"""Bug & security vulnerability report queue.

Public endpoints:
  POST   /api/bug-reports                  Submit a report (auth optional).

Admin endpoints (require is_admin):
  GET    /api/bug-reports                  List reports, newest first.
  GET    /api/bug-reports/stats            Counts by status + severity.
  GET    /api/bug-reports/{id}             Full body of a single report.
  PATCH  /api/bug-reports/{id}             Update status/severity/admin_notes.
  DELETE /api/bug-reports/{id}             Hard-delete a report.

Design notes:
  * Anonymous submissions are allowed (privacy / Tor users) but rate-limited
    by IP through both slowapi (5/hour) and an in-DB sliding window
    (count_recent_bug_reports_from_ip).
  * Reporter_ip is stored hashed-by-design? No: stored raw so abuse can be
    triaged, but it's only ever surfaced to admins. Strip x-forwarded-for
    parsing happens in deps.client_ip.
  * Severity / status / category are whitelisted in database.py to avoid
    state-machine drift.
  * Body is capped at 8000 chars at the SQL helper layer.
"""
from typing import Optional

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from slowapi import Limiter

import database as db
from deps import get_current_user, client_ip

limiter = Limiter(key_func=client_ip)
router = APIRouter(prefix="/bug-reports", tags=["bug-reports"])


async def _optional_user(
    request: Request,
    x_session_token: Optional[str] = Header(default=None, alias="X-Session-Token"),
) -> Optional[dict]:
    """Like get_current_user() but returns None instead of raising 401.

    Bug reports accept anonymous submissions (security researchers / Tor
    users shouldn't have to register just to disclose a flaw), so the POST
    handler can't use the strict dependency directly.
    """
    if not x_session_token:
        return None
    try:
        return await get_current_user(request, x_session_token)
    except Exception:
        return None


_VALID_SEVERITY = {"low", "medium", "high", "critical"}
_VALID_STATUS   = {"open", "triage", "in_progress", "fixed", "wontfix", "duplicate"}
_VALID_CATEGORY = {"bug", "security", "feature", "ux", "other"}

# Per-IP soft cap on top of slowapi: if you've already filed N reports in the
# last hour we refuse with 429. Stops a single client (or a tor exit) from
# flooding the queue while still leaving room for a legitimate user who hits
# multiple bugs in one session.
_HOURLY_PER_IP_CAP = 8


class SubmitReportBody(BaseModel):
    title:    str = Field(..., min_length=3,  max_length=200)
    body:     str = Field(..., min_length=10, max_length=8000)
    severity: str = "medium"
    category: str = "bug"
    contact:  str = Field(default="", max_length=200)


class UpdateReportBody(BaseModel):
    status:      Optional[str] = None
    severity:    Optional[str] = None
    admin_notes: Optional[str] = None


def _require_admin(user: dict) -> bool:
    return bool(user and user.get("is_admin"))


# ---------------------------------------------------------------------------
# Public submit
# ---------------------------------------------------------------------------

@router.post("")
@limiter.limit("5/hour")
async def submit_bug_report(
    request: Request,
    body: SubmitReportBody,
    current_user: Optional[dict] = Depends(_optional_user),
):
    """Submit a bug or security report. Auth is OPTIONAL.

    We accept anonymous reports because security researchers and Tor users
    should not be required to register an account just to disclose a flaw.
    The slowapi limiter + per-IP DB cap below keep this from being abused.
    """
    sev = body.severity.lower().strip()
    cat = body.category.lower().strip()
    if sev not in _VALID_SEVERITY:
        return JSONResponse(status_code=400, content={"error": "Invalid severity"})
    if cat not in _VALID_CATEGORY:
        return JSONResponse(status_code=400, content={"error": "Invalid category"})

    ip = client_ip(request) or ""
    if db.count_recent_bug_reports_from_ip(ip, minutes=60) >= _HOURLY_PER_IP_CAP:
        return JSONResponse(
            status_code=429,
            content={"error": "Too many reports from this address. Try again later."},
        )

    reporter_id = (current_user or {}).get("id")
    try:
        report_id = db.create_bug_report(
            reporter_id=reporter_id,
            reporter_ip=ip,
            title=body.title,
            body=body.body,
            severity=sev,
            category=cat,
            contact=body.contact,
        )
    except Exception as exc:  # noqa: BLE001 - last-resort surface
        return JSONResponse(status_code=500, content={"error": f"Failed to record report: {exc}"})

    return {"ok": True, "id": report_id, "message": "Thanks — report received."}


# ---------------------------------------------------------------------------
# Get one's own submitted reports (lightweight; for "your reports" view)
# ---------------------------------------------------------------------------

@router.get("/mine")
async def list_my_reports(current_user: dict = Depends(get_current_user)):
    if not current_user:
        return JSONResponse(status_code=401, content={"error": "Login required"})
    # Reuse list_bug_reports but filter client-side; tiny per-user lists, no
    # need for a separate SQL helper.
    rows = [r for r in db.list_bug_reports(limit=200)
            if r.get("reporter_id") == current_user["id"]]
    for r in rows:
        # Don't leak admin_notes or other reporters' IPs to non-admins.
        r.pop("reporter_ip", None)
        r.pop("admin_notes", None)
    return {"reports": rows}


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------

@router.get("")
async def list_reports(
    status: Optional[str] = None,
    severity: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    current_user: dict = Depends(get_current_user),
):
    if not _require_admin(current_user):
        return JSONResponse(status_code=403, content={"error": "Admin only"})
    limit  = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    rows = db.list_bug_reports(
        status=status, severity=severity, limit=limit, offset=offset,
    )
    return {"reports": rows, "stats": db.bug_report_stats()}


@router.get("/stats")
async def get_stats(current_user: dict = Depends(get_current_user)):
    if not _require_admin(current_user):
        return JSONResponse(status_code=403, content={"error": "Admin only"})
    return db.bug_report_stats()


@router.get("/{report_id}")
async def get_report(report_id: int, current_user: dict = Depends(get_current_user)):
    if not _require_admin(current_user):
        return JSONResponse(status_code=403, content={"error": "Admin only"})
    row = db.get_bug_report(report_id)
    if not row:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return row


@router.patch("/{report_id}")
async def update_report(
    report_id: int,
    body: UpdateReportBody,
    current_user: dict = Depends(get_current_user),
):
    if not _require_admin(current_user):
        return JSONResponse(status_code=403, content={"error": "Admin only"})
    if body.status is not None and body.status not in _VALID_STATUS:
        return JSONResponse(status_code=400, content={"error": "Invalid status"})
    if body.severity is not None and body.severity not in _VALID_SEVERITY:
        return JSONResponse(status_code=400, content={"error": "Invalid severity"})
    ok = db.update_bug_report(
        report_id,
        status=body.status,
        severity=body.severity,
        admin_notes=body.admin_notes,
    )
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Not found or no changes"})
    return {"ok": True, "report": db.get_bug_report(report_id)}


@router.delete("/{report_id}")
async def delete_report(report_id: int, current_user: dict = Depends(get_current_user)):
    if not _require_admin(current_user):
        return JSONResponse(status_code=403, content={"error": "Admin only"})
    ok = db.delete_bug_report(report_id)
    if not ok:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return {"ok": True}
