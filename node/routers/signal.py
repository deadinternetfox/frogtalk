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
import json
import os
import urllib.parse
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
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


def bundle_api_dict(user_id: int, bundle: dict) -> dict:
    """Wire format shared by local fetch and federation bundle proxy."""
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


def _local_server_id() -> str:
    return str((db.get_or_create_local_server_identity() or {}).get("server_id") or "").strip()


def _peer_home_candidates(peer_user_id: int, gid: str, local_sid: str) -> list[str]:
    """Ordered remote server_ids that may host this peer's Signal keys."""
    uid = int(peer_user_id or 0)
    out: list[str] = []
    seen: set[str] = set()

    def _add(sid: str) -> None:
        s = str(sid or "").strip()
        if not s or s == local_sid or s in seen:
            return
        seen.add(s)
        out.append(s)

    # Profile origin / global resolve before account_home: mirrors often pin
    # account_home to the viewing node while Signal keys live on origin.
    if gid:
        _add(db.get_federation_profile_origin(gid))
        _add(db.resolve_global_user_home_server_id(gid))
    if uid > 0:
        _add(db.get_user_account_home_server_id(uid))
    return out


def _peer_home_and_gid(peer_user_id: int) -> tuple[str, str]:
    """Return (clearnet-reachable home_server_id, global_user_id) for Signal fetch."""
    from routers.auth import resolve_server_base_url
    from routers.federation import _select_peer_push_target, _server_advertises_onion_only

    uid = int(peer_user_id or 0)
    if uid <= 0:
        return "", ""
    peer = db.get_user_by_id(uid) or {}
    gid = str(peer.get("global_user_id") or "").strip()
    local_sid = _local_server_id()
    for sid in _peer_home_candidates(uid, gid, local_sid):
        row = db.get_federation_server_row(sid)
        if not row:
            continue
        if _server_advertises_onion_only(row):
            continue
        if _select_peer_push_target(row) and resolve_server_base_url(sid):
            return sid, gid
    # Last resort: any configured base (may be slow/unreachable).
    for sid in _peer_home_candidates(uid, gid, local_sid):
        if resolve_server_base_url(sid):
            return sid, gid
    return "", gid


def _peer_signal_bundle_is_remote(peer_user_id: int) -> bool:
    """True when this peer's Signal keys should be loaded from another node.

    Do not treat a user as remote merely because a federation profile row
    pins a foreign ``origin_server_id`` — local accounts on this node often
    keep that metadata while publishing bundles here. Prefer the local bundle
    when one exists unless ``account_home`` explicitly points elsewhere.
    """
    local_sid = _local_server_id()
    if not local_sid:
        return False
    uid = int(peer_user_id or 0)
    if uid <= 0:
        return False
    peer = db.get_user_by_id(uid) or {}
    gid = str(peer.get("global_user_id") or "").strip()
    account_home = db.get_user_account_home_server_id(uid) if uid else ""
    if account_home == local_sid:
        return False
    if account_home and account_home != local_sid:
        return True
    if db.signal_fetch_bundle(uid) is not None:
        # Keys published on this node — same-node DMs must use them.
        return False
    if gid:
        origin = db.get_federation_profile_origin(gid)
        if origin and origin != local_sid:
            return True
    home_sid, _gid = _peer_home_and_gid(uid)
    return bool(home_sid and home_sid != local_sid)


def fetch_peer_bundle_from_home_sync(peer_user_id: int) -> dict:
    """Pull a peer's prekey bundle from their federation home node."""
    from routers.auth import resolve_server_base_url
    from routers.federation import _fetch_url_bytes

    local_sid = _local_server_id()
    gid = str((db.get_user_by_id(int(peer_user_id or 0)) or {}).get("global_user_id") or "").strip()
    if not gid:
        raise ValueError("peer_no_global_id")
    home_sid, _gid = _peer_home_and_gid(peer_user_id)
    if not home_sid:
        raise ValueError("peer_home_unreachable")
    base = resolve_server_base_url(home_sid)
    if not base:
        raise ValueError("peer_home_unreachable")
    tok = (os.getenv("FROGTALK_FEDERATION_TOKEN") or "").strip()
    if not tok:
        raise ValueError("federation_token_missing")
    gid_q = urllib.parse.quote(gid, safe="")
    url = f"{base}/api/federation/signal/bundle/{gid_q}"
    try:
        raw = _fetch_url_bytes(
            url,
            timeout_s=20.0,
            method="GET",
            headers={
                "Accept": "application/json",
                "User-Agent": "FrogTalk-SignalFederation/1.0",
                "x-federation-token": tok,
            },
        )
    except Exception as exc:
        raise ValueError(f"peer_bundle_fetch_failed:{home_sid}:{exc}") from exc
    data = json.loads(raw.decode("utf-8", errors="replace") or "{}")
    if not isinstance(data, dict) or not data.get("identity_pub"):
        raise ValueError("peer_bundle_bad_response")
    return data


def fetch_peer_identity_from_home_sync(peer_user_id: int) -> str | None:
    """Identity pub only (no OTPK consume) from peer home."""
    from routers.auth import resolve_server_base_url
    from routers.federation import _fetch_url_bytes

    home_sid, gid = _peer_home_and_gid(peer_user_id)
    local_sid = _local_server_id()
    if not home_sid or not gid or (local_sid and home_sid == local_sid):
        ident = db.signal_get_identity_pub(int(peer_user_id))
        return _b64_encode(ident) if ident else None
    base = resolve_server_base_url(home_sid)
    tok = (os.getenv("FROGTALK_FEDERATION_TOKEN") or "").strip()
    if not base or not tok:
        return None
    gid_q = urllib.parse.quote(gid, safe="")
    url = f"{base}/api/federation/signal/identity/{gid_q}"
    try:
        raw = _fetch_url_bytes(
            url,
            timeout_s=12.0,
            method="GET",
            headers={
                "Accept": "application/json",
                "User-Agent": "FrogTalk-SignalFederation/1.0",
                "x-federation-token": tok,
            },
        )
        data = json.loads(raw.decode("utf-8", errors="replace") or "{}")
        b64 = str((data or {}).get("identity_pub") or "").strip()
        return b64 or None
    except Exception:
        return None


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
    del user
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="bad_user_id")

    if await run_in_threadpool(_peer_signal_bundle_is_remote, int(user_id)):
        try:
            data = await run_in_threadpool(fetch_peer_bundle_from_home_sync, int(user_id))
            return data
        except ValueError as e:
            code = str(e).split(":", 1)[0]
            if code == "federation_token_missing":
                raise HTTPException(status_code=503, detail="federation_not_configured")
            raise HTTPException(status_code=404, detail=code)

    bundle = await run_in_threadpool(db.signal_fetch_bundle, int(user_id))
    if bundle is None:
        raise HTTPException(status_code=404, detail="no_bundle")

    return bundle_api_dict(int(user_id), bundle)


@router.get("/identity/{user_id}")
@limiter.limit("120/minute")
async def fetch_identity(
    request: Request,
    user_id: int,
    user: dict = Depends(get_current_user),
):
    """Return only `identity_pub` for `user_id` (does not consume OTPK).

    Senders use this to detect peer-identity drift before encrypting
    against a stale local Signal session. Cheap to call.
    """
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="bad_user_id")
    if await run_in_threadpool(_peer_signal_bundle_is_remote, int(user_id)):
        ident_b64 = await run_in_threadpool(fetch_peer_identity_from_home_sync, int(user_id))
        if not ident_b64:
            raise HTTPException(status_code=404, detail="no_identity")
        return {"user_id": int(user_id), "identity_pub": ident_b64}
    ident = await run_in_threadpool(db.signal_get_identity_pub, int(user_id))
    if ident is None:
        raise HTTPException(status_code=404, detail="no_identity")
    return {"user_id": int(user_id), "identity_pub": _b64_encode(ident)}


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


