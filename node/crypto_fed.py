"""Ed25519 signing helpers for FrogTalk federation events.

The module owns three things:
- a persistent ed25519 keypair stored in the ``config`` table
  (one row each for ``federation.signing.privkey_pem`` and
  ``federation.signing.pubkey_pem``); generated once on first call.
- a canonical-bytes routine that both sides use so that what gets
  signed is identical regardless of dict-key ordering.
- ``sign_event`` and ``verify_event`` wrappers that hide the
  cryptography library details.

The verifier never trusts a public key that arrives on the wire —
peers must be registered in ``federation_servers`` with a
``server_pubkey`` value before any of their events will be accepted.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
from typing import Optional, Tuple

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

import database as db

_log = logging.getLogger(__name__)

_PRIV_KEY_CFG = "federation.signing.privkey_pem"
_PUB_KEY_CFG = "federation.signing.pubkey_pem"

_cached_priv: Optional[Ed25519PrivateKey] = None
_cached_pub_pem: Optional[str] = None


def _normalize_pubkey_pem(pem: str) -> str:
    """Canonical PEM text for fingerprints and storage.

    Older installs persisted pubkeys with trailing newlines; TOFU pins
    strip whitespace from JSON. Fingerprints must use the same form on
    both sides or inbox verification rejects valid signatures.
    """
    return str(pem or "").strip()


def _load_or_create_local_keypair() -> Tuple[Ed25519PrivateKey, str]:
    """Return (private key, PEM-encoded public key).

    The keypair is generated exactly once and persisted in
    ``config``. Subsequent calls read the stored PEM. The PEM
    representation is portable across Python processes and survives
    sqlite VACUUM, so this is the right place for it.
    """
    global _cached_priv, _cached_pub_pem
    if _cached_priv is not None and _cached_pub_pem is not None:
        return _cached_priv, _cached_pub_pem

    priv_pem = db.get_config(_PRIV_KEY_CFG)
    pub_pem = db.get_config(_PUB_KEY_CFG)

    if not priv_pem or not pub_pem:
        priv = Ed25519PrivateKey.generate()
        priv_pem = priv.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode("ascii")
        pub_pem = priv.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("ascii")
        db.set_config(_PRIV_KEY_CFG, priv_pem)
        db.set_config(_PUB_KEY_CFG, pub_pem)
    else:
        priv = serialization.load_pem_private_key(priv_pem.encode("ascii"), password=None)
        if not isinstance(priv, Ed25519PrivateKey):
            raise RuntimeError("Stored federation signing key is not Ed25519")

    pub_pem = _normalize_pubkey_pem(pub_pem)
    if pub_pem != db.get_config(_PUB_KEY_CFG):
        db.set_config(_PUB_KEY_CFG, pub_pem)

    _cached_priv = priv
    _cached_pub_pem = pub_pem
    return priv, pub_pem


def get_local_public_key_pem() -> str:
    """Return the local node's PEM-encoded ed25519 public key.

    Safe to call from network status / discovery endpoints. The
    private key never leaves this process.
    """
    _, pub_pem = _load_or_create_local_keypair()
    return _normalize_pubkey_pem(pub_pem)


def get_local_public_key_fingerprint() -> str:
    """SHA-256 fingerprint of the local public key in hex.

    Useful as a short identifier in signature metadata so verifiers
    can fast-reject a wrong-key signature without parsing the full PEM.
    """
    return fingerprint_for_pem(get_local_public_key_pem())


def fingerprint_for_pem(pem: str) -> str:
    """Compute the same 32-hex fingerprint for an arbitrary PEM.

    Used by inbox verification to check that an event's claimed
    ``signer_pubkey_fingerprint`` matches the pinned peer key before
    we even attempt the Ed25519 verification. Catches accidental key
    rotation as well as deliberate cross-peer signature replay.
    """
    return hashlib.sha256(_normalize_pubkey_pem(pem).encode("ascii")).hexdigest()[:32]


def canonical_event_bytes(event: dict) -> bytes:
    """Build the byte string that gets signed for a federation event.

    Format: ``event_id|event_type|origin_server_id|origin_time|sha256(payload_json)``
    where ``payload_json`` is JSON with sorted keys and tight separators
    so both ends produce identical bytes regardless of dict order.
    """
    payload = event.get("payload") or {}
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    payload_hash = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
    parts = [
        str(event.get("event_id") or ""),
        str(event.get("event_type") or ""),
        str(event.get("origin_server_id") or ""),
        str(event.get("origin_time") or ""),
        payload_hash,
    ]
    return "|".join(parts).encode("utf-8")


def sign_event(event: dict) -> dict:
    """Stamp ``event["signature"]`` + ``event["signer_pubkey_fingerprint"]``.

    Mutates and returns the same dict for convenience. Signature is
    base64-encoded so it survives JSON serialization on the wire.
    """
    priv, _ = _load_or_create_local_keypair()
    sig = priv.sign(canonical_event_bytes(event))
    event["signature"] = base64.b64encode(sig).decode("ascii")
    event["signer_pubkey_fingerprint"] = get_local_public_key_fingerprint()
    return event


def verify_event(event: dict, peer_pubkey_pem: str) -> bool:
    """Verify a peer's signature on a federation event.

    Returns True only on a valid signature. Any decode/parse error
    returns False without raising.
    """
    sig_b64 = str(event.get("signature") or "").strip()
    if not sig_b64 or not peer_pubkey_pem:
        return False
    try:
        sig = base64.b64decode(sig_b64.encode("ascii"), validate=True)
    except Exception:
        return False
    try:
        pub = serialization.load_pem_public_key(peer_pubkey_pem.encode("ascii"))
    except Exception:
        return False
    if not isinstance(pub, Ed25519PublicKey):
        return False
    try:
        pub.verify(sig, canonical_event_bytes(event))
        return True
    except InvalidSignature:
        return False
    except Exception:
        return False


# ── SECURITY-PASS-2: per-request HTTP signing (replaces shared bearer) ─────
#
# Background: the legacy federation auth path uses a single shared bearer
# token (FROGTALK_FEDERATION_TOKEN) for ALL peer-to-peer requests. Any
# peer that ever sees that token can impersonate any other peer to any
# node that accepts it — there is no notion of "peer A signed this".
#
# New design: every cross-server HTTP request is signed with the sending
# server's Ed25519 private key. The receiving server looks up the
# claimed peer in `federation_servers` (by `server_id`), uses the
# pinned `server_pubkey` PEM, and verifies:
#
#   1. Timestamp is within ±SKEW seconds of now (anti-replay #1).
#   2. (peer_id, nonce) hasn't been seen in the last REPLAY_WINDOW
#      seconds (anti-replay #2; survives clock drift exploits).
#   3. body hash matches sha256(actual body) (anti-tamper).
#   4. method+path+timestamp+nonce+body_hash signature is valid for the
#      pinned peer public key.
#
# Backward compat: the legacy bearer path stays around so nodes can be
# upgraded independently. Operator flag (env `FROGTALK_FEDERATION_AUTH_MODE`):
#   * `dual`   (default): accept either signed or legacy bearer.
#   * `signed`: require signed; reject legacy bearer.
#   * `legacy`: accept only legacy bearer (downgrade switch for
#               emergency rollback). Not recommended in production.
#
# `FROGTALK_FEDERATION_AUTH_MODE` is read live so flipping the env on a
# running deploy takes effect without restart.

_SIGNED_HEADER_PEER_ID = "X-Federation-Peer-Id"
_SIGNED_HEADER_TIMESTAMP = "X-Federation-Timestamp"
_SIGNED_HEADER_NONCE = "X-Federation-Nonce"
_SIGNED_HEADER_BODY_SHA = "X-Federation-Body-Sha256"
_SIGNED_HEADER_SIGNATURE = "X-Federation-Signature"

_REQUEST_SKEW_SECONDS = 300       # ±5 min clock skew tolerated
_REPLAY_WINDOW_SECONDS = 600      # remember nonces for 10 min

# In-process replay cache: (peer_id, nonce) -> seen_at.
# A federation peer can't realistically issue >100 req/s sustained;
# we cap the cache at 50k entries and prune aggressively.
import time as _fed_time
import threading as _fed_threading
_replay_cache: dict[tuple[str, str], float] = {}
_replay_lock = _fed_threading.Lock()
_REPLAY_CACHE_MAX = 50_000


def _body_sha256_hex(body: bytes) -> str:
    return hashlib.sha256(body or b"").hexdigest()


def _signed_request_canonical_bytes(
    method: str,
    path: str,
    timestamp: str,
    nonce: str,
    body_sha256_hex: str,
) -> bytes:
    """Bytes the sender signs and the receiver re-derives.

    Path is URL-decoded already because Starlette gives us
    `request.url.path` (no scheme/host/query). Including the query
    string in the signature is intentionally avoided — many proxies
    rewrite query order — and the body hash already pins the
    semantic content.
    """
    return "|".join([
        method.upper(),
        path,
        str(timestamp),
        str(nonce),
        body_sha256_hex,
    ]).encode("utf-8")


def sign_request_headers(method: str, path: str, body: bytes, peer_id: str) -> dict:
    """Build the set of headers to attach to an outgoing federation request.

    Caller must merge these with whatever transport headers (Host,
    Content-Type, etc.) it sends. `peer_id` is the LOCAL server's own
    server_id — the receiver looks it up in their `federation_servers`
    table to find OUR public key.
    """
    priv, _ = _load_or_create_local_keypair()
    ts = str(int(_fed_time.time()))
    nonce = base64.urlsafe_b64encode(hashlib.sha256(
        f"{peer_id}|{ts}|{_fed_time.time_ns()}".encode("utf-8")
    ).digest())[:32].decode("ascii")
    body_hash = _body_sha256_hex(body)
    sig_bytes = _signed_request_canonical_bytes(method, path, ts, nonce, body_hash)
    sig = priv.sign(sig_bytes)
    return {
        _SIGNED_HEADER_PEER_ID: peer_id,
        _SIGNED_HEADER_TIMESTAMP: ts,
        _SIGNED_HEADER_NONCE: nonce,
        _SIGNED_HEADER_BODY_SHA: body_hash,
        _SIGNED_HEADER_SIGNATURE: base64.b64encode(sig).decode("ascii"),
    }


def _replay_seen_or_record(peer_id: str, nonce: str, now: float) -> bool:
    """Return True if (peer_id, nonce) was seen within the replay window.
    Otherwise records it and returns False. Thread-safe; prunes stale
    entries opportunistically.
    """
    if not peer_id or not nonce:
        return True  # treat missing as "definitely a replay" to fail closed
    key = (peer_id, nonce)
    with _replay_lock:
        seen = _replay_cache.get(key)
        if seen is not None:
            return True
        _replay_cache[key] = now
        # Opportunistic prune so the cache can't unbounded-grow under
        # a heavy fanout. We sweep when we cross the soft cap.
        if len(_replay_cache) > _REPLAY_CACHE_MAX:
            cutoff = now - _REPLAY_WINDOW_SECONDS
            stale = [k for k, t in _replay_cache.items() if t < cutoff]
            for k in stale:
                _replay_cache.pop(k, None)
            # If still oversized, drop the oldest 25%.
            if len(_replay_cache) > _REPLAY_CACHE_MAX:
                order = sorted(_replay_cache.items(), key=lambda kv: kv[1])
                drop = order[: max(1, len(order) // 4)]
                for k, _ in drop:
                    _replay_cache.pop(k, None)
    return False


def verify_signed_request(
    method: str,
    path: str,
    body: bytes,
    headers: dict,
    peer_pubkey_pem_lookup,
) -> tuple[bool, str | None, str | None]:
    """Verify per-request signature headers on an inbound federation request.

    Args:
        method, path, body: the HTTP request being verified.
        headers: mapping of header-name (case-insensitive) to value.
        peer_pubkey_pem_lookup: callable(peer_id) -> PEM str | None.

    Returns:
        (ok, peer_id, reason).
        On success: (True, peer_id, None).
        On failure: (False, claimed_peer_id_or_None, short reason string).
    """
    # Normalise header lookup to lowercase keys.
    h = {str(k).lower(): str(v) for k, v in (headers or {}).items() if v is not None}
    peer_id = (h.get(_SIGNED_HEADER_PEER_ID.lower()) or "").strip()
    ts_str = (h.get(_SIGNED_HEADER_TIMESTAMP.lower()) or "").strip()
    nonce = (h.get(_SIGNED_HEADER_NONCE.lower()) or "").strip()
    body_hash_claimed = (h.get(_SIGNED_HEADER_BODY_SHA.lower()) or "").strip()
    sig_b64 = (h.get(_SIGNED_HEADER_SIGNATURE.lower()) or "").strip()
    if not peer_id or not ts_str or not nonce or not body_hash_claimed or not sig_b64:
        return False, peer_id or None, "missing_headers"
    try:
        ts = int(ts_str)
    except Exception:
        return False, peer_id, "bad_timestamp"
    now = _fed_time.time()
    if abs(now - ts) > _REQUEST_SKEW_SECONDS:
        return False, peer_id, "stale_timestamp"
    # Body integrity: even if we cache the body, recompute the hash
    # ourselves rather than trusting the header.
    body_hash_actual = _body_sha256_hex(body)
    # Constant-time compare since this prevents body-swap attacks.
    import hmac as _hmac
    if not _hmac.compare_digest(body_hash_actual, body_hash_claimed):
        return False, peer_id, "body_hash_mismatch"
    # Public key lookup.
    pem = None
    try:
        pem = peer_pubkey_pem_lookup(peer_id)
    except Exception:
        _log.exception("federation: peer pubkey lookup raised for %s", peer_id)
        return False, peer_id, "lookup_error"
    if not pem:
        return False, peer_id, "unknown_peer"
    # Signature decode + verify.
    try:
        sig = base64.b64decode(sig_b64.encode("ascii"), validate=True)
    except Exception:
        return False, peer_id, "bad_signature_b64"
    try:
        pub = serialization.load_pem_public_key(pem.encode("ascii"))
    except Exception:
        return False, peer_id, "bad_peer_pubkey"
    if not isinstance(pub, Ed25519PublicKey):
        return False, peer_id, "not_ed25519"
    sig_input = _signed_request_canonical_bytes(method, path, ts_str, nonce, body_hash_claimed)
    try:
        pub.verify(sig, sig_input)
    except InvalidSignature:
        return False, peer_id, "bad_signature"
    except Exception:
        return False, peer_id, "verify_error"
    # Replay: only count it once we've validated everything else.
    if _replay_seen_or_record(peer_id, nonce, now):
        return False, peer_id, "replay"
    return True, peer_id, None


def federation_auth_mode() -> str:
    """Return one of: 'dual' (default), 'signed', 'legacy'."""
    import os as _os
    raw = (_os.getenv("FROGTALK_FEDERATION_AUTH_MODE") or "dual").strip().lower()
    return raw if raw in ("dual", "signed", "legacy") else "dual"
