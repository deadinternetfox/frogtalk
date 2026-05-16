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

    _cached_priv = priv
    _cached_pub_pem = pub_pem
    return priv, pub_pem


def get_local_public_key_pem() -> str:
    """Return the local node's PEM-encoded ed25519 public key.

    Safe to call from network status / discovery endpoints. The
    private key never leaves this process.
    """
    _, pub_pem = _load_or_create_local_keypair()
    return pub_pem


def get_local_public_key_fingerprint() -> str:
    """SHA-256 fingerprint of the local public key in hex.

    Useful as a short identifier in signature metadata so verifiers
    can fast-reject a wrong-key signature without parsing the full PEM.
    """
    _, pub_pem = _load_or_create_local_keypair()
    return hashlib.sha256(pub_pem.encode("ascii")).hexdigest()[:32]


def fingerprint_for_pem(pem: str) -> str:
    """Compute the same 32-hex fingerprint for an arbitrary PEM.

    Used by inbox verification to check that an event's claimed
    ``signer_pubkey_fingerprint`` matches the pinned peer key before
    we even attempt the Ed25519 verification. Catches accidental key
    rotation as well as deliberate cross-peer signature replay.
    """
    return hashlib.sha256(pem.encode("ascii")).hexdigest()[:32]


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
