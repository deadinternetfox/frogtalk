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

import asyncio
import base64
import binascii
import json
import logging
import os
import threading
import time
import urllib.parse
from typing import Any, Optional

_log = logging.getLogger(__name__)

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


def _enqueue_signal_keys_updated(user: dict, identity_pub: bytes) -> None:
    """Tell peer nodes which server now holds this user's active Signal bundle."""
    gid = str((user or {}).get("global_user_id") or "").strip()
    local_sid = _local_server_id()
    if not gid or not local_sid:
        return
    try:
        import federation_calls as fc
        from routers import federation as fed

        targets = fc._clearnet_federation_peer_ids()
        if not targets:
            return
        fed.enqueue_server_event(
            "user.signal.keys_updated",
            {
                "global_user_id": gid,
                "keys_server_id": local_sid,
                "identity_pub": _b64_encode(identity_pub),
            },
            target_server_ids=targets,
        )
    except Exception:
        pass


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


def _peer_signal_bundle_source_server(peer_user_id: int) -> str:
    """Federation server_id that should serve this peer's active prekey bundle.

    When ``signal_keys_server_id`` points at another node, always proxy there
    even if this mirror still has stale identity rows from an earlier visit.
    Only serve locally when keys are pinned here or no remote pin exists.
    """
    local_sid = _local_server_id()
    uid = int(peer_user_id or 0)
    if uid <= 0 or not local_sid:
        return ""
    keys_sid = db.get_user_signal_keys_server_id(uid)
    if not keys_sid:
        gid = str((db.get_user_by_id(uid) or {}).get("global_user_id") or "").strip()
        if gid:
            keys_sid = db.get_signal_keys_server_for_gid(gid)
    account_home = db.get_user_account_home_server_id(uid)
    # Stale travel-node mirror: OTPKs published here while the account is
    # homed elsewhere — encrypt/decrypt must use canonical home keys so the
    # peer reading on frogtalk.xyz can unlock messages.
    if account_home and account_home != local_sid:
        if keys_sid == local_sid or (not keys_sid and db.signal_has_published_bundle(uid)):
            return account_home
    if keys_sid and keys_sid != local_sid:
        return keys_sid
    if db.signal_has_published_bundle(uid):
        return ""
    if account_home and account_home != local_sid:
        return account_home
    gid = str((db.get_user_by_id(uid) or {}).get("global_user_id") or "").strip()
    if gid:
        origin = db.get_federation_profile_origin(gid)
        if origin and origin != local_sid:
            return origin
    home_sid, _gid = _peer_home_and_gid(uid)
    if home_sid and home_sid != local_sid:
        return home_sid
    return ""


def _peer_signal_bundle_is_remote(peer_user_id: int) -> bool:
    """True when this peer's bundle must be fetched from another federation node."""
    return bool(_peer_signal_bundle_source_server(peer_user_id))


# Cross-node bundle proxy guardrails. Without these, many tabs retrying
# encrypt/decrypt can spawn hundreds of blocking federation HTTP calls
# (each up to ~30s) and stall the single uvicorn worker → site 502.
_REMOTE_BUNDLE_MAX_CONCURRENT = 8
_REMOTE_BUNDLE_SEM = threading.BoundedSemaphore(_REMOTE_BUNDLE_MAX_CONCURRENT)
_REMOTE_BUNDLE_INFLIGHT_LOCK = threading.Lock()
_REMOTE_BUNDLE_INFLIGHT: dict[str, dict[str, Any]] = {}
_CIRCUIT_LOCK = threading.Lock()
_CIRCUIT_FAILS: dict[str, int] = {}
_CIRCUIT_OPEN_UNTIL: dict[str, float] = {}
_CIRCUIT_FAIL_THRESHOLD = 4
_CIRCUIT_OPEN_SEC = 90.0
_CIRCUIT_WAIT_SEC = 22.0


def _remote_bundle_circuit_key(server_id: str, gid: str) -> str:
    return f"{str(server_id or '').strip()}:{str(gid or '').strip()}"


def _remote_bundle_circuit_open(server_id: str, gid: str) -> bool:
    key = _remote_bundle_circuit_key(server_id, gid)
    now = time.monotonic()
    with _CIRCUIT_LOCK:
        until = float(_CIRCUIT_OPEN_UNTIL.get(key) or 0.0)
        return until > now


def _remote_bundle_record_failure(server_id: str, gid: str) -> None:
    key = _remote_bundle_circuit_key(server_id, gid)
    now = time.monotonic()
    with _CIRCUIT_LOCK:
        n = int(_CIRCUIT_FAILS.get(key) or 0) + 1
        _CIRCUIT_FAILS[key] = n
        if n >= _CIRCUIT_FAIL_THRESHOLD:
            _CIRCUIT_OPEN_UNTIL[key] = now + _CIRCUIT_OPEN_SEC
            _CIRCUIT_FAILS[key] = 0
            _log.warning(
                "signal: remote bundle circuit OPEN gid=%s src=%s for %.0fs",
                gid[:8] + "…" if len(gid) > 8 else gid,
                server_id,
                _CIRCUIT_OPEN_SEC,
            )


def _remote_bundle_record_success(server_id: str, gid: str) -> None:
    key = _remote_bundle_circuit_key(server_id, gid)
    with _CIRCUIT_LOCK:
        _CIRCUIT_FAILS.pop(key, None)
        _CIRCUIT_OPEN_UNTIL.pop(key, None)


def _fetch_remote_bundle_http(
    *,
    peer_user_id: int,
    gid: str,
    home_sid: str,
    url: str,
    tok: str,
) -> dict:
    from routers.federation import _fetch_url_bytes

    last_exc: Exception | None = None
    for attempt in range(2):
        t0 = time.monotonic()
        timeout_s = 5.0 if attempt < 1 else 8.0
        try:
            if not _REMOTE_BUNDLE_SEM.acquire(timeout=3.0):
                raise TimeoutError("remote_bundle_slot_busy")
            try:
                raw = _fetch_url_bytes(
                    url,
                    timeout_s=timeout_s,
                    method="GET",
                    headers={
                        "Accept": "application/json",
                        "User-Agent": "FrogTalk-SignalFederation/1.0",
                        "x-federation-token": tok,
                    },
                )
            finally:
                _REMOTE_BUNDLE_SEM.release()
            data = json.loads(raw.decode("utf-8", errors="replace") or "{}")
            if not isinstance(data, dict) or not data.get("identity_pub"):
                raise ValueError("peer_bundle_bad_response")
            ms = int((time.monotonic() - t0) * 1000)
            _log.info(
                "signal: remote bundle ok peer_uid=%s gid=%s src=%s ms=%d attempt=%d",
                int(peer_user_id or 0),
                gid[:8] + "…" if len(gid) > 8 else gid,
                home_sid,
                ms,
                attempt + 1,
            )
            _remote_bundle_record_success(home_sid, gid)
            return data
        except Exception as exc:
            last_exc = exc
            ms = int((time.monotonic() - t0) * 1000)
            _log.warning(
                "signal: remote bundle attempt FAIL peer_uid=%s gid=%s src=%s ms=%d attempt=%d err=%s",
                int(peer_user_id or 0),
                gid[:8] + "…" if len(gid) > 8 else gid,
                home_sid,
                ms,
                attempt + 1,
                type(exc).__name__,
            )
            if attempt < 1:
                time.sleep(0.2)
    _remote_bundle_record_failure(home_sid, gid)
    raise ValueError(f"peer_bundle_fetch_failed:{home_sid}:{last_exc}") from last_exc


def fetch_peer_bundle_from_server_sync(peer_user_id: int, server_id: str) -> dict:
    """Pull a peer's prekey bundle from a specific federation node."""
    from routers.auth import resolve_server_base_url

    gid = str((db.get_user_by_id(int(peer_user_id or 0)) or {}).get("global_user_id") or "").strip()
    if not gid:
        raise ValueError("peer_no_global_id")
    home_sid = str(server_id or "").strip()
    if not home_sid:
        raise ValueError("peer_home_unreachable")
    if _remote_bundle_circuit_open(home_sid, gid):
        raise ValueError("peer_bundle_circuit_open")
    base = resolve_server_base_url(home_sid)
    if not base:
        raise ValueError("peer_home_unreachable")
    tok = (os.getenv("FROGTALK_FEDERATION_TOKEN") or "").strip()
    if not tok:
        raise ValueError("federation_token_missing")
    gid_q = urllib.parse.quote(gid, safe="")
    url = f"{base}/api/federation/signal/bundle/{gid_q}"
    inflight_key = _remote_bundle_circuit_key(home_sid, gid)
    leader = False
    slot: dict[str, Any] | None = None
    with _REMOTE_BUNDLE_INFLIGHT_LOCK:
        slot = _REMOTE_BUNDLE_INFLIGHT.get(inflight_key)
        if slot is None:
            slot = {"event": threading.Event(), "result": None, "error": None}
            _REMOTE_BUNDLE_INFLIGHT[inflight_key] = slot
            leader = True
    if not leader and slot is not None:
        if not slot["event"].wait(timeout=_CIRCUIT_WAIT_SEC):
            raise ValueError("peer_bundle_inflight_timeout")
        if slot["error"] is not None:
            raise slot["error"]
        return slot["result"]
    try:
        result = _fetch_remote_bundle_http(
            peer_user_id=int(peer_user_id or 0),
            gid=gid,
            home_sid=home_sid,
            url=url,
            tok=tok,
        )
        if slot is not None:
            slot["result"] = result
        return result
    except Exception as exc:
        if slot is not None:
            slot["error"] = exc
        raise
    finally:
        if slot is not None:
            slot["event"].set()
            with _REMOTE_BUNDLE_INFLIGHT_LOCK:
                if _REMOTE_BUNDLE_INFLIGHT.get(inflight_key) is slot:
                    _REMOTE_BUNDLE_INFLIGHT.pop(inflight_key, None)


def fetch_peer_bundle_from_home_sync(peer_user_id: int) -> dict:
    """Pull a peer's prekey bundle from their active or home federation node."""
    src = _peer_signal_bundle_source_server(peer_user_id)
    if not src:
        home_sid, _gid = _peer_home_and_gid(peer_user_id)
        src = home_sid
    if not src:
        raise ValueError("peer_home_unreachable")
    return fetch_peer_bundle_from_server_sync(peer_user_id, src)


def fetch_peer_identity_from_home_sync(peer_user_id: int) -> str | None:
    """Identity pub only (no OTPK consume) from peer home."""
    from routers.auth import resolve_server_base_url
    from routers.federation import _fetch_url_bytes

    local_sid = _local_server_id()
    src = _peer_signal_bundle_source_server(peer_user_id)
    if not src:
        ident = db.signal_get_identity_pub(int(peer_user_id))
        return _b64_encode(ident) if ident else None
    gid = str((db.get_user_by_id(int(peer_user_id or 0)) or {}).get("global_user_id") or "").strip()
    if not gid:
        return None
    base = resolve_server_base_url(src)
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


class DmResyncRequest(BaseModel):
    peer_user_id: int = Field(..., ge=1)


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
    try:
        await run_in_threadpool(_enqueue_signal_keys_updated, user, identity_pub)
    except Exception:
        pass
    return {
        "ok": True,
        "otpks_added": int(result.get("otpks_added", 0)),
        "otpks_available": await run_in_threadpool(db.signal_otpk_count, int(user["id"])),
    }


_NUDGE_KEYS_AT: dict[str, float] = {}
_NUDGE_KEYS_LOCK = threading.Lock()
_NUDGE_KEYS_COOLDOWN_SEC = 45.0
_NUDGE_KEYS_RETRY_WAIT_SEC = 2.5
_RESYNC_AT: dict[str, float] = {}
_RESYNC_LOCK = threading.Lock()
_RESYNC_COOLDOWN_SEC = 30.0


def _peer_keys_server_id_for_uid(uid: int) -> str:
    keys_sid = str(db.get_user_signal_keys_server_id(int(uid)) or "").strip()
    if keys_sid:
        return keys_sid
    src = _peer_signal_bundle_source_server(int(uid))
    if src:
        return src
    return _local_server_id()


def _nudge_bundle_retryable(code: str) -> bool:
    return code in (
        "no_bundle",
        "peer_bundle_fetch_failed",
        "peer_bundle_bad_response",
        "user_not_found",
    )


def _nudge_peer_keys_publish_remote_sync(gid: str, keys_sid: str) -> bool:
    from routers.auth import resolve_server_base_url
    from routers.federation import _fetch_url_bytes

    base = resolve_server_base_url(keys_sid)
    tok = (os.getenv("FROGTALK_FEDERATION_TOKEN") or "").strip()
    if not base or not tok or not gid:
        return False
    gid_q = urllib.parse.quote(gid, safe="")
    url = f"{base}/api/federation/signal/nudge-publish/{gid_q}"
    try:
        raw = _fetch_url_bytes(
            url,
            timeout_s=4.0,
            method="POST",
            headers={
                "Accept": "application/json",
                "User-Agent": "FrogTalk-SignalFederation/1.0",
                "x-federation-token": tok,
            },
        )
        data = json.loads(raw.decode("utf-8", errors="replace") or "{}")
        return bool((data or {}).get("delivered"))
    except Exception:
        return False


async def nudge_peer_keys_publish(peer_user_id: int) -> bool:
    """Ask peer's browser (via WS) to publish Signal prekeys — local or federated."""
    uid = int(peer_user_id or 0)
    if uid <= 0:
        return False
    peer = db.get_user_by_id(uid) or {}
    gid = str(peer.get("global_user_id") or "").strip()
    if not gid:
        return False
    now = time.monotonic()
    with _NUDGE_KEYS_LOCK:
        if now - float(_NUDGE_KEYS_AT.get(gid) or 0.0) < _NUDGE_KEYS_COOLDOWN_SEC:
            return False
        _NUDGE_KEYS_AT[gid] = now
    keys_sid = _peer_keys_server_id_for_uid(uid)
    local_sid = _local_server_id()
    payload = {"type": "signal_publish_keys", "reason": "peer_dm"}
    if keys_sid == local_sid:
        from ws_manager import manager

        return bool(await manager.send_to_user(uid, payload))
    return await run_in_threadpool(_nudge_peer_keys_publish_remote_sync, gid, keys_sid)


def _nudge_dm_crypto_signal_remote_sync(gid: str, payload: dict, target_sid: str, path_suffix: str) -> bool:
    from routers.auth import resolve_server_base_url
    from routers.federation import _fetch_url_bytes

    base = resolve_server_base_url(target_sid)
    tok = (os.getenv("FROGTALK_FEDERATION_TOKEN") or "").strip()
    if not base or not tok or not gid:
        return False
    gid_q = urllib.parse.quote(gid, safe="")
    url = f"{base}/api/federation/signal/{path_suffix}/{gid_q}"
    try:
        raw = _fetch_url_bytes(
            url,
            timeout_s=4.0,
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "FrogTalk-SignalFederation/1.0",
                "x-federation-token": tok,
            },
            data=json.dumps(payload or {}).encode("utf-8"),
        )
        data = json.loads(raw.decode("utf-8", errors="replace") or "{}")
        return bool((data or {}).get("delivered"))
    except Exception:
        return False


def _nudge_dm_crypto_resync_remote_sync(gid: str, payload: dict, target_sid: str) -> bool:
    return _nudge_dm_crypto_signal_remote_sync(gid, payload, target_sid, "dm-resync")


async def _deliver_dm_crypto_peer_signal(peer_id: int, from_user: dict, signal_type: str) -> bool:
    """Deliver dm_crypto_resync / dm_crypto_heal to peer WS locally or via federation."""
    uid = int(peer_id or 0)
    if uid <= 0:
        return False
    signal_type = str(signal_type or "").strip()
    if signal_type not in ("dm_crypto_resync", "dm_crypto_heal"):
        return False
    payload = {
        "type": signal_type,
        "from_id": int(from_user.get("id") or 0),
        "from_nickname": str(from_user.get("nickname") or ""),
        "from_global_user_id": str(from_user.get("global_user_id") or "").strip(),
    }
    from ws_manager import manager

    if bool(await manager.send_to_user(uid, payload)):
        return True
    peer = db.get_user_by_id(uid) or {}
    gid = str(peer.get("global_user_id") or "").strip()
    if not gid:
        return False
    now = time.monotonic()
    with _RESYNC_LOCK:
        if now - float(_RESYNC_AT.get(gid) or 0.0) < _RESYNC_COOLDOWN_SEC:
            return False
        _RESYNC_AT[gid] = now
    local_sid = _local_server_id()
    keys_sid = _peer_keys_server_id_for_uid(uid)
    targets = list(db.resolve_federation_push_targets_for_recipient_gids([gid]))
    if keys_sid and keys_sid != local_sid and keys_sid not in targets:
        targets.append(keys_sid)
    path_suffix = "dm-heal" if signal_type == "dm_crypto_heal" else "dm-resync"
    for sid in targets:
        ok = await run_in_threadpool(
            _nudge_dm_crypto_signal_remote_sync, gid, payload, sid, path_suffix,
        )
        if ok:
            return True
    return False


async def deliver_dm_crypto_resync(peer_id: int, from_user: dict) -> bool:
    return await _deliver_dm_crypto_peer_signal(peer_id, from_user, "dm_crypto_resync")


async def deliver_dm_crypto_heal(peer_id: int, from_user: dict) -> bool:
    return await _deliver_dm_crypto_peer_signal(peer_id, from_user, "dm_crypto_heal")


async def _fetch_peer_bundle_payload(uid: int) -> dict:
    if await run_in_threadpool(_peer_signal_bundle_is_remote, uid):
        return await run_in_threadpool(fetch_peer_bundle_from_home_sync, uid)
    bundle = await run_in_threadpool(db.signal_fetch_bundle, uid)
    if bundle is None:
        raise ValueError("no_bundle")
    return bundle_api_dict(uid, bundle)


def _bundle_http_error(exc: ValueError) -> HTTPException:
    code = str(exc).split(":", 1)[0]
    if code == "federation_token_missing":
        return HTTPException(status_code=503, detail="federation_not_configured")
    if code in (
        "peer_bundle_circuit_open",
        "peer_bundle_inflight_timeout",
        "peer_bundle_slot_busy",
    ):
        return HTTPException(
            status_code=503,
            detail=code,
            headers={"Retry-After": "60"},
        )
    return HTTPException(status_code=404, detail=code)


@router.get("/bundle/{user_id}")
@limiter.limit("60/minute")
async def fetch_bundle(
    request: Request,
    user_id: int,
    user: dict = Depends(get_current_user),
):
    """Return one prekey bundle for `user_id` and atomically consume one OTPK."""
    del user
    uid = int(user_id)
    if uid <= 0:
        raise HTTPException(status_code=400, detail="bad_user_id")

    try:
        return await _fetch_peer_bundle_payload(uid)
    except ValueError as e:
        code = str(e).split(":", 1)[0]
        if not _nudge_bundle_retryable(code):
            raise _bundle_http_error(e) from e

    await nudge_peer_keys_publish(uid)
    await asyncio.sleep(_NUDGE_KEYS_RETRY_WAIT_SEC)
    try:
        return await _fetch_peer_bundle_payload(uid)
    except ValueError as e:
        raise _bundle_http_error(e) from e


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
    uid = int(user_id)
    ident_b64 = None
    if await run_in_threadpool(_peer_signal_bundle_is_remote, uid):
        ident_b64 = await run_in_threadpool(fetch_peer_identity_from_home_sync, uid)
    if not ident_b64:
        ident = await run_in_threadpool(db.signal_get_identity_pub, uid)
        if ident is None:
            raise HTTPException(status_code=404, detail="no_identity")
        ident_b64 = _b64_encode(ident)
    keys_sid = await run_in_threadpool(db.get_user_signal_keys_server_id, uid)
    return {
        "user_id": uid,
        "identity_pub": ident_b64,
        "keys_server_id": keys_sid or _local_server_id(),
    }


@router.post("/dm-resync-request")
@limiter.limit("20/minute")
async def dm_resync_request(
    request: Request,
    body: DmResyncRequest,
    user: dict = Depends(get_current_user),
):
    """Ask a DM peer to drop stale Signal state and refresh prekeys (cross-node recovery)."""
    del request
    peer_id = int(body.peer_user_id)
    me_id = int(user["id"])
    if peer_id == me_id:
        raise HTTPException(status_code=400, detail="bad_peer")
    if not await run_in_threadpool(db.dm_channel_exists, me_id, peer_id):
        raise HTTPException(status_code=403, detail="no_dm_channel")

    delivered = await deliver_dm_crypto_resync(peer_id, user)
    return {"ok": True, "delivered": bool(delivered)}


@router.post("/dm-crypto-heal")
@limiter.limit("12/minute")
async def dm_crypto_heal(
    request: Request,
    body: DmResyncRequest,
    user: dict = Depends(get_current_user),
):
    """Bilateral DM crypto reset: wipe stale sessions and force fresh prekeys."""
    del request
    peer_id = int(body.peer_user_id)
    me_id = int(user["id"])
    if peer_id == me_id:
        raise HTTPException(status_code=400, detail="bad_peer")
    if not await run_in_threadpool(db.dm_channel_exists, me_id, peer_id):
        raise HTTPException(status_code=403, detail="no_dm_channel")

    delivered = await deliver_dm_crypto_heal(peer_id, user)
    return {"ok": True, "delivered": bool(delivered)}


@router.get("/peer-keys/{user_id}")
@limiter.limit("60/minute")
async def peer_keys_status(
    request: Request,
    user_id: int,
    user: dict = Depends(get_current_user),
):
    """Diagnostics for cross-node DM encrypt (no OTPK consume)."""
    del user
    uid = int(user_id or 0)
    if uid <= 0:
        raise HTTPException(status_code=400, detail="bad_user_id")
    local_sid = _local_server_id()
    keys_sid = await run_in_threadpool(db.get_user_signal_keys_server_id, uid)
    src = await run_in_threadpool(_peer_signal_bundle_source_server, uid)
    has_local = await run_in_threadpool(db.signal_has_published_bundle, uid)
    return {
        "user_id": uid,
        "keys_server_id": keys_sid or local_sid,
        "bundle_source_server": src or local_sid,
        "bundle_is_remote": bool(src),
        "has_local_bundle": bool(has_local),
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


