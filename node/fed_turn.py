"""Per-node TURN/STUN publication for federated WebRTC."""
from __future__ import annotations

import json
import os
from typing import Any


def _split_urls(raw: str) -> list[str]:
    out: list[str] = []
    for part in (raw or "").split(","):
        u = part.strip()
        if u:
            out.append(u)
    return out


def local_turn_urls() -> list[str]:
    return _split_urls(os.getenv("FROGTALK_TURN_URLS", ""))


def local_turn_username() -> str:
    return (os.getenv("FROGTALK_TURN_USERNAME", "") or "").strip()


def local_turn_credential() -> str:
    return (os.getenv("FROGTALK_TURN_CREDENTIAL", "") or "").strip()


def federation_calls_enabled() -> bool:
    """Cross-node DM voice/video signaling.

    Explicit ``FROGTALK_FEDERATION_CALLS_ENABLED`` wins. When unset, calls
    follow ``FROGTALK_FEDERATION_ENABLED`` so a federated mesh rings across
    nodes without a separate operator toggle (set CALLS=0 to disable).
    """
    explicit = (os.getenv("FROGTALK_FEDERATION_CALLS_ENABLED") or "").strip().lower()
    if explicit in ("0", "false", "no"):
        return False
    if explicit in ("1", "true", "yes"):
        return True
    fed_on = (os.getenv("FROGTALK_FEDERATION_ENABLED") or "").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    return fed_on


def voice_sfu_enabled() -> bool:
    return os.getenv("FROGTALK_VOICE_SFU", "0").strip().lower() in ("1", "true", "yes")


def turn_ice_servers(
    urls: list[str],
    *,
    username: str = "",
    credential: str = "",
) -> list[dict[str, Any]]:
    """Build RTCIceServer dicts for JSON API responses."""
    servers: list[dict[str, Any]] = []
    stun: list[str] = []
    turn: list[str] = []
    for u in urls:
        low = u.lower()
        if low.startswith("stun:"):
            stun.append(u)
        elif low.startswith("turn:") or low.startswith("turns:"):
            turn.append(u)
        else:
            turn.append(u)
    if stun:
        servers.append({"urls": stun if len(stun) > 1 else stun[0]})
    for tu in turn:
        entry: dict[str, Any] = {"urls": tu}
        if username:
            entry["username"] = username
        if credential:
            entry["credential"] = credential
        servers.append(entry)
    return servers


def merge_ice_servers(local_view: dict, peer_view: dict | None) -> list[dict[str, Any]]:
    """Merge local + peer TURN into WebRTC iceServers with per-server credentials."""
    servers: list[dict[str, Any]] = []
    local = local_view or {}
    peer = peer_view or {}
    local_urls = list(local.get("turn_urls") or [])
    peer_urls = list(peer.get("turn_urls") or [])
    if local_urls:
        servers.extend(
            turn_ice_servers(
                local_urls,
                username=str(local.get("turn_username") or ""),
                credential=str(local.get("turn_credential") or ""),
            )
        )
    if peer_urls:
        servers.extend(
            turn_ice_servers(
                peer_urls,
                username=str(peer.get("turn_username") or ""),
                credential=str(peer.get("turn_credential") or ""),
            )
        )
    return servers


def local_turn_public_view() -> dict:
    urls = local_turn_urls()
    return {
        "turn_urls": urls,
        "turn_username": local_turn_username() if urls else "",
        "turn_credential": local_turn_credential() if urls else "",
        "ice_servers": turn_ice_servers(
            urls,
            username=local_turn_username(),
            credential=local_turn_credential(),
        ),
    }


def parse_server_turn_json(raw: str | None) -> dict:
    if not raw:
        return {"turn_urls": [], "turn_username": "", "turn_credential": ""}
    try:
        data = json.loads(raw)
    except Exception:
        return {"turn_urls": [], "turn_username": "", "turn_credential": ""}
    if not isinstance(data, dict):
        return {"turn_urls": [], "turn_username": "", "turn_credential": ""}
    urls = data.get("turn_urls") or []
    if not isinstance(urls, list):
        urls = []
    return {
        "turn_urls": [str(u).strip() for u in urls if str(u).strip()],
        "turn_username": str(data.get("turn_username") or "").strip(),
        "turn_credential": str(data.get("turn_credential") or "").strip(),
    }
