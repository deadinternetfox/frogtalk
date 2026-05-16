"""Signal Protocol (X3DH + Double Ratchet) prekey bundle endpoints.

Track A of the security refactor (see docs/SECURITY_REFACTOR_PLAN.md).
These endpoints are always live — the original FROGTALK_DM_ENC_V2 /
FROGTALK_ROOM_ENC_V2 flags were removed in Track H cleanup once Signal
became the only supported DM and room crypto.

Security notes:
- Keys are validated as raw bytes of the expected length. The server
  cannot verify a Curve25519 point or an Ed25519 signature without
  pulling a crypto dep — we deliberately don't, because doing so on the
  server gains nothing (the *peer* verifies the signed prekey using the
  identity key it already trusts via TOFU/safety-numbers in Track E).
  The server's job is dumb transit and atomic OTPK consumption.
- OTPK consume is a single SQL transaction under BEGIN IMMEDIATE so two
  concurrent fetches for the same recipient cannot hand out the same
  one-time prekey.
- No PII is logged. The endpoints stay outside the request-body access
  log path via FastAPI defaults (we never `print(body)`).
"""

from __future__ import annotations

import base64
import binascii
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from slowapi import Limiter
from starlette.concurrency import run_in_threadpool

import database as db
from deps import client_ip, get_current_user

router = APIRouter(prefix="/signal", tags=["signal"])
limiter = Limiter(key_func=client_ip)


# ---------------------------------------------------------------------------
# Helpers — strict base64 decoding with length checks
# ---------------------------------------------------------------------------

def _b64_decode(value: str, *, expected_len: Optional[int], field: str) -> bytes:
    """Decode standard base64 with strict validation.

    Rejects URL-safe alphabet (matches the wire format the client emits,
    keeps the codepath unambiguous), rejects oversize blobs, and enforces
    the expected raw byte length when given.
    """
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail=f"{field}_not_string")
    if len(value) > 512:  # 64-byte sig encodes to 88 chars; allow headroom.
        raise HTTPException(status_code=400, detail=f"{field}_too_long")
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail=f"{field}_bad_base64")
    if expected_len is not None and len(raw) != expected_len:
        raise HTTPException(status_code=400, detail=f"{field}_bad_length")
    return raw


def _b64_encode(value: bytes) -> str:
    return base64.b64encode(bytes(value)).decode("ascii")


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class SignedPreKeyIn(BaseModel):
    id: int = Field(..., ge=0, le=0x7FFFFFFF)
    pub: str = Field(..., min_length=1, max_length=128)   # base64(32 bytes)
    sig: str = Field(..., min_length=1, max_length=128)   # base64(64 bytes)


class OneTimePreKeyIn(BaseModel):
    id: int = Field(..., ge=0, le=0x7FFFFFFF)
    pub: str = Field(..., min_length=1, max_length=128)   # base64(32 bytes)


class BundlePublish(BaseModel):
    registration_id: int = Field(..., ge=0, le=0x3FFF)
    identity_pub: str = Field(..., min_length=1, max_length=128)   # base64(32 bytes)
    signed_prekey: SignedPreKeyIn
    one_time_prekeys: list[OneTimePreKeyIn] = Field(default_factory=list, max_length=100)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/bundle")
@limiter.limit("12/minute")
async def publish_bundle(
    request: Request,
    body: BundlePublish,
    user: dict = Depends(get_current_user),
):
    """Publish or refresh this user's Signal prekey bundle.

    Replaces the identity key + signed prekey, appends up to 100 OTPKs.
    Idempotent: re-publishing the same key material is a no-op.
    """
    identity_pub = _b64_decode(body.identity_pub, expected_len=32, field="identity_pub")
    spk_pub = _b64_decode(body.signed_prekey.pub, expected_len=32, field="signed_prekey.pub")
    spk_sig = _b64_decode(body.signed_prekey.sig, expected_len=64, field="signed_prekey.sig")

    otpks: list[dict] = []
    seen_ids: set[int] = set()
    for entry in body.one_time_prekeys:
        if entry.id in seen_ids:
            # Caller mistake; ignoring duplicates keeps the request honest.
            continue
        seen_ids.add(entry.id)
        otpks.append({
            "id": entry.id,
            "pub": _b64_decode(entry.pub, expected_len=32, field="one_time_prekeys.pub"),
        })

    result = await run_in_threadpool(
        db.signal_publish_bundle,
        int(user["id"]),
        int(body.registration_id),
        identity_pub,
        int(body.signed_prekey.id),
        spk_pub,
        spk_sig,
        otpks,
    )
    return {
        "ok": True,
        "otpks_added": int(result.get("otpks_added", 0)),
        "otpks_available": await run_in_threadpool(db.signal_otpk_count, int(user["id"])),
    }


@router.get("/bundle/{user_id}")
@limiter.limit("60/minute")
async def fetch_bundle(
    request: Request,
    user_id: int,
    user: dict = Depends(get_current_user),
):
    """Return one prekey bundle for `user_id` and atomically consume one OTPK."""
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="bad_user_id")

    bundle = await run_in_threadpool(db.signal_fetch_bundle, int(user_id))
    if bundle is None:
        raise HTTPException(status_code=404, detail="no_bundle")

    otpk = bundle["one_time_prekey"]
    return {
        "user_id": int(user_id),
        "registration_id": bundle["registration_id"],
        "identity_pub": _b64_encode(bundle["identity_pub"]),
        "signed_prekey": {
            "id": bundle["signed_prekey"]["id"],
            "pub": _b64_encode(bundle["signed_prekey"]["pub"]),
            "sig": _b64_encode(bundle["signed_prekey"]["sig"]),
        },
        "one_time_prekey": None if otpk is None else {
            "id": otpk["id"],
            "pub": _b64_encode(otpk["pub"]),
        },
    }


@router.get("/otpk-count")
@limiter.limit("30/minute")
async def otpk_count(
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Return how many unconsumed OTPKs the current user has on this node.

    Clients top up the pool when this falls below their threshold (typ. 10).
    """
    n = await run_in_threadpool(db.signal_otpk_count, int(user["id"]))
    return {"available": int(n)}


@router.get("/config")
async def signal_config():
    """Public capability advertisement.

    Track H cleanup removed the FROGTALK_DM_ENC_V2 / FROGTALK_ROOM_ENC_V2
    flags — Signal DMs and Sender-Keys rooms are now the only supported
    crypto path. The capability endpoint is kept (clients still poll it)
    and unconditionally reports both features as enabled.
    """
    return {
        "dm_v2_enabled":    True,
        "room_v2_enabled":  True,
    }


# ---------------------------------------------------------------------------
# Sender-Key Distribution Message (SKDM) relay — Track C Phase 3
# ---------------------------------------------------------------------------
#
# Design:
#   • Sender encrypts a JSON SKDM payload as a Track-A v2 DM envelope to
#     the recipient (X3DH+Ratchet, just like any other DM body), then
#     POSTs it here together with the target room id.
#   • Server is OPAQUE to the envelope contents — it cannot read the
#     sender key. It simply hands the envelope to the recipient over WS
#     if online, otherwise spools it in `signal_pending_skdms` for
#     drain on next WS connect.
#   • This is structurally distinct from a real DM: no `dms` row, no
#     conversation listing, no notification, no preview update. The
#     recipient handles it silently inside `Signal.room.processSKDM`.

class SkdmRelayBody(BaseModel):
    room_id:  str = Field(..., min_length=1, max_length=128)
    # The opaque DM-v2 envelope JSON string. We don't parse it — the
    # recipient does. Caps at 16 KiB which is comfortably above a
    # realistic SKDM (≈ 1-2 KiB) but stops obvious abuse.
    envelope: str = Field(..., min_length=8, max_length=16 * 1024)


@router.post("/skdm/{recipient_uid}")
@limiter.limit("120/minute")
async def relay_skdm(
    request: Request,
    recipient_uid: int,
    body: SkdmRelayBody,
    user: dict = Depends(get_current_user),
):
    """Deliver an SKDM envelope to `recipient_uid`.

    Returns ``{"ok": true, "delivered": "live"|"spooled"}``.
    """
    if recipient_uid <= 0:
        raise HTTPException(status_code=400, detail="bad_recipient")
    if int(recipient_uid) == int(user["id"]):
        # An SKDM-to-self is a client bug; cheap to reject.
        raise HTTPException(status_code=400, detail="self_skdm")

    sender_id = int(user["id"])
    room_id   = body.room_id.strip()
    envelope  = body.envelope

    # Lazy import to avoid a circular import at router-registration time
    # (ws_manager pulls from database which pulls from .env which …)
    from ws_manager import manager

    payload = {
        "type":      "skdm",
        "from_id":   sender_id,
        "room_id":   room_id,
        "envelope":  envelope,
    }

    delivered = "spooled"
    if manager.is_user_online(int(recipient_uid)):
        try:
            await manager.send_to_user(int(recipient_uid), payload)
            delivered = "live"
        except Exception:
            # Fall back to spool on any send error so the recipient
            # still picks it up on next connect.
            delivered = "spooled"

    if delivered != "live":
        await run_in_threadpool(
            db.signal_skdm_enqueue,
            int(recipient_uid), sender_id, room_id, envelope,
        )

    return {"ok": True, "delivered": delivered}


# ---------------------------------------------------------------------------
# Linked devices — Track F Phase 1 (dark backend)
# ---------------------------------------------------------------------------
#
# Phase 1 ships only the storage + management endpoints. The bundle-shape
# change (one bundle per device, fanout encrypt on the client) is Phase 2.
# This lets us build and ship the Settings -> Devices UI against a real
# backend without flipping the on-wire DM format. Existing single-device
# Signal sessions keep working exactly as they did before.

class DeviceLinkBody(BaseModel):
    """Primary device enrolling a secondary.

    `device_id` is a client-generated UUID-ish string (8..64 hex/dash
    chars). `identity_pub` is the secondary's Curve25519 identity key
    (base64, 32 bytes). `primary_sig` is the primary's XEdDSA signature
    over the bytes (device_id || identity_pub || created_at) — server
    treats this as opaque, peers verify on read.
    """
    device_id:    str = Field(..., min_length=8, max_length=64)
    name:         str = Field("", max_length=64)
    identity_pub: str = Field(..., min_length=1, max_length=128)
    primary_sig:  str = Field(..., min_length=1, max_length=128)


@router.get("/devices/me")
@limiter.limit("60/minute")
async def devices_me(
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Return this user's own active devices (revoked rows omitted)."""
    rows = await run_in_threadpool(
        db.signal_devices_for_user, int(user["id"]), include_revoked=False,
    )
    return {
        "ok": True,
        "devices": [
            {
                "device_id":     d["device_id"],
                "name":          d["name"],
                "identity_pub":  _b64_encode(d["device_identity_pub"]),
                "primary_sig":   _b64_encode(d["primary_sig"]),
                "created_at":    d["created_at"],
                "last_seen_at":  d["last_seen_at"],
            }
            for d in rows
        ],
    }


@router.post("/devices/link")
@limiter.limit("10/minute")
async def devices_link(
    request: Request,
    body: DeviceLinkBody,
    user: dict = Depends(get_current_user),
):
    """Primary device enrols a new secondary.

    Returns ``{ok, device}`` on success. Errors surface as 400 with a
    short detail string the UI can map to a localized message.
    """
    identity_pub = _b64_decode(body.identity_pub, expected_len=32, field="identity_pub")
    primary_sig  = _b64_decode(body.primary_sig,  expected_len=64, field="primary_sig")

    try:
        row = await run_in_threadpool(
            db.signal_device_link,
            user_id=int(user["id"]),
            device_id=body.device_id,
            name=body.name,
            device_identity_pub=identity_pub,
            primary_sig=primary_sig,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return {
        "ok": True,
        "device": {
            "device_id":    row["device_id"],
            "name":         row["name"],
            "created_at":   row["created_at"],
            "last_seen_at": row["last_seen_at"],
        },
    }


@router.post("/devices/{device_id}/revoke")
@limiter.limit("30/minute")
async def devices_revoke(
    request: Request,
    device_id: str,
    user: dict = Depends(get_current_user),
):
    """Mark one of the caller's devices as revoked.

    Idempotent. Returns ``{ok: true, changed: bool}``. The client should
    refresh its device list after a revoke. Once Phase 2 ships, peers
    will stop encrypting to the revoked device on their next bundle
    refresh; until then the rest of the system is unaffected.
    """
    if not isinstance(device_id, str) or not (8 <= len(device_id) <= 64):
        raise HTTPException(status_code=400, detail="device_id_bad_length")
    changed = await run_in_threadpool(
        db.signal_device_revoke, int(user["id"]), device_id,
    )
    return {"ok": True, "changed": bool(changed)}


# ---------------------------------------------------------------------------
# QR-based device pairing — Track F Phase 2
# ---------------------------------------------------------------------------
#
# Flow:
#   1. Primary device: POST /devices/pairing/start → token (5 min TTL).
#      The UI displays a QR encoding {server, token}.
#   2. Secondary device (logged into the same account): scans QR,
#      generates a local Curve25519 device identity, POSTs
#      /devices/pairing/{token}/claim with its identity_pub + name.
#   3. Primary polls GET /devices/pairing/{token} until status='claimed'.
#      UI shows the secondary's safety-number-style fingerprint for the
#      user to compare against the device on the other screen.
#   4. User confirms → primary signs (device_id || identity_pub) with
#      its primary Signal identity key and POSTs
#      /devices/pairing/{token}/approve. Server links the device.
#   5. Secondary polls GET /devices/pairing/{token}/status (unauth) and
#      sees status='complete' with the assigned device_id → persists the
#      device_id locally and finishes onboarding.
#
# Authorization model:
#   * /start, /claim, /approve, GET /{token}     : require auth, must
#     match the originating user.
#   * /status                                    : no auth — only leaks
#     the status enum + assigned device_id once complete. Token is the
#     capability.


class PairingClaimBody(BaseModel):
    identity_pub: str = Field(..., min_length=1, max_length=128)  # base64(32)
    device_name:  str = Field("", max_length=64)


class PairingApproveBody(BaseModel):
    device_id:   str = Field(..., min_length=8, max_length=64)
    primary_sig: str = Field(..., min_length=1, max_length=128)   # base64(64)
    device_name: Optional[str] = Field(None, max_length=64)


def _pairing_row_to_dict(row: dict) -> dict:
    """Serialise a pairing-lookup row for the primary device."""
    return {
        "status":       row["status"],
        "device_name":  row["device_name"],
        "device_id":    row["device_id"],
        "created_at":   row["created_at"],
        "expires_at":   row["expires_at"],
        "identity_pub": _b64_encode(row["device_identity_pub"]) if row.get("device_identity_pub") else None,
    }


@router.post("/devices/pairing/start")
@limiter.limit("10/minute")
async def pairing_start(
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Primary device creates a fresh pairing token."""
    res = await run_in_threadpool(db.signal_pairing_create, int(user["id"]))
    return {
        "ok":         True,
        "token":      res["token"],
        "expires_at": res["expires_at"],
    }


@router.post("/devices/pairing/{token}/claim")
@limiter.limit("20/minute")
async def pairing_claim(
    request: Request,
    token: str,
    body: PairingClaimBody,
    user: dict = Depends(get_current_user),
):
    """Secondary device claims a pairing token with its device identity."""
    identity_pub = _b64_decode(body.identity_pub, expected_len=32, field="identity_pub")
    try:
        res = await run_in_threadpool(
            db.signal_pairing_claim,
            token=token,
            caller_user_id=int(user["id"]),
            device_identity_pub=identity_pub,
            device_name=body.device_name,
        )
    except ValueError as exc:
        code = str(exc)
        status = 404 if code == "token_not_found" else 400
        if code in ("token_wrong_user",):
            status = 403
        if code in ("token_expired",):
            status = 410
        if code in ("token_already_claimed",):
            status = 409
        raise HTTPException(status_code=status, detail=code)
    return {"ok": True, "expires_at": res["expires_at"]}


@router.get("/devices/pairing/{token}")
@limiter.limit("60/minute")
async def pairing_lookup(
    request: Request,
    token: str,
    user: dict = Depends(get_current_user),
):
    """Primary polls the token to see the secondary's claim."""
    row = await run_in_threadpool(
        db.signal_pairing_lookup, token=token, caller_user_id=int(user["id"]),
    )
    if row is None:
        raise HTTPException(status_code=404, detail="token_not_found")
    return {"ok": True, **_pairing_row_to_dict(row)}


@router.post("/devices/pairing/{token}/approve")
@limiter.limit("10/minute")
async def pairing_approve(
    request: Request,
    token: str,
    body: PairingApproveBody,
    user: dict = Depends(get_current_user),
):
    """Primary approves the secondary's claim and links the device."""
    primary_sig = _b64_decode(body.primary_sig, expected_len=64, field="primary_sig")
    try:
        res = await run_in_threadpool(
            db.signal_pairing_approve,
            token=token,
            caller_user_id=int(user["id"]),
            device_id=body.device_id,
            primary_sig=primary_sig,
            name_override=body.device_name,
        )
    except ValueError as exc:
        code = str(exc)
        status = 400
        if code == "token_not_found":
            status = 404
        elif code == "token_wrong_user":
            status = 403
        elif code == "token_expired":
            status = 410
        elif code in ("token_not_claimed", "device_cap_reached", "token_corrupt"):
            status = 409
        raise HTTPException(status_code=status, detail=code)
    dev = res["device"]
    return {
        "ok":        True,
        "device_id": dev["device_id"],
        "device": {
            "device_id":    dev["device_id"],
            "name":         dev["name"],
            "created_at":   dev["created_at"],
            "last_seen_at": dev["last_seen_at"],
        },
    }


@router.get("/devices/pairing/{token}/status")
@limiter.limit("120/minute")
async def pairing_status(
    request: Request,
    token: str,
):
    """Unauthenticated status poll for the secondary device.

    Returns only ``{status, device_id?}``. Token is the capability — no
    other fields are leaked. Polled while the QR is on screen.
    """
    res = await run_in_threadpool(db.signal_pairing_status, token)
    return {"ok": True, **res}


