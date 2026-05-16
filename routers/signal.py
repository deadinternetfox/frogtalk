"""Signal Protocol (X3DH + Double Ratchet) prekey bundle endpoints.

Track A, Phase 1 of the security refactor (see
docs/SECURITY_REFACTOR_PLAN.md). These endpoints are gated behind the
`FROGTALK_DM_ENC_V2` env flag — when the flag is off (default) the
router refuses publish/fetch with 503. The schema (signal_identity_keys,
signal_signed_prekeys, signal_one_time_prekeys) is created
unconditionally so a later flag flip needs no further migration.

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
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from slowapi import Limiter
from starlette.concurrency import run_in_threadpool

import database as db
from deps import client_ip, get_current_user

router = APIRouter(prefix="/signal", tags=["signal"])
limiter = Limiter(key_func=client_ip)


def _flag_enabled() -> bool:
    return os.getenv("FROGTALK_DM_ENC_V2", "").strip().lower() in ("1", "true", "yes", "on")


def _require_flag() -> None:
    if not _flag_enabled():
        # 503 (not 404) so clients can distinguish "endpoint not deployed"
        # from "feature off on this node" and decide whether to retry.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="signal_v2_disabled",
        )


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
    _require_flag()

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
    _require_flag()
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
    _require_flag()
    n = await run_in_threadpool(db.signal_otpk_count, int(user["id"]))
    return {"available": int(n)}


def _room_v2_flag_enabled() -> bool:
    return os.getenv("FROGTALK_ROOM_ENC_V2", "").strip().lower() in (
        "1", "true", "yes", "on",
    )


@router.get("/config")
async def signal_config():
    """Public capability advertisement.

    Lets the client know whether DM v2 and Room v2 (Sender Keys) are
    enabled on this node so it can decide whether to publish bundles
    and emit v2 envelopes. Unauthenticated and cheap to call.
    """
    return {
        "dm_v2_enabled":    _flag_enabled(),
        "room_v2_enabled":  _room_v2_flag_enabled(),
    }
