"""Federation and network discovery routes (phase-1 scaffold)."""
import base64
import logging
import os
import re
import time
import asyncio
import ipaddress
import json
import hashlib
import secrets
import socket
import urllib.request
import urllib.error
import urllib.parse
import httpx
from pathlib import Path
import tempfile
import shutil
import subprocess
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from deps import get_current_user
from pydantic import BaseModel

import database as db
import geoip
# Track B \u2014 inline-style sanitiser, applied to every federated
# profile update before it reaches the local DB. Replaces the previous
# selector-aware <style> sanitiser; the local renderer no longer emits
# any <style> block from user data.
from routers._css_inline import sanitize_inline_style as _sanitize_inline_style
import crypto_fed
import federation_mesh
from public_url_policy import OFFICIAL_HUB_URL_DEFAULT

router = APIRouter(tags=["federation"])
_log = logging.getLogger(__name__)


class ServerRegisterBody(BaseModel):
    server_id: str
    display_name: str
    base_url: str
    onion_url: str = ""
    region: str = ""
    official: bool = False
    trust_tier: str = "community"
    server_pubkey: str = ""
    capabilities: list[str] = []
    turn_urls: list[str] = []
    turn_username: str = ""
    turn_credential: str = ""


class FederationInboxBody(BaseModel):
    events: list[dict]


class IdentityPubKeyBody(BaseModel):
    identity_pubkey: str


class BuildManifestBody(BaseModel):
    platform: str  # "web" | "desktop" | "android" | "ios"
    version: str
    build_hash: str
    signer: str = ""
    signature: str = ""
    official: bool = False


class FederationOutboxEventBody(BaseModel):
    event_type: str
    payload: dict


class PeerBuildVerifyBody(BaseModel):
    base_urls: list[str] = []


class UpdatePublishBody(BaseModel):
    version: str
    package_url: str
    package_sha256: str
    build_hash: str = ""
    notes: str = ""


class UpdateApplyBody(BaseModel):
    force: bool = False


def _normalize_base_url(url: str) -> str:
    return (url or "").strip().rstrip("/")


def _upgrade_same_host_https_redirect(original_url: str, err_msg: str) -> str | None:
    """When nginx redirects ``http://ip`` → ``https://ip``, retry once over HTTPS."""
    m = re.search(r"->\s*(https?://[^\s)]+)", str(err_msg or ""))
    if not m:
        return None
    new_url = _normalize_base_url(m.group(1))
    try:
        orig = urllib.parse.urlsplit(original_url)
        dest = urllib.parse.urlsplit(new_url)
    except Exception:
        return None
    if (orig.scheme or "").lower() != "http":
        return None
    if (dest.scheme or "").lower() != "https":
        return None
    oh = (orig.hostname or "").strip().lower()
    dh = (dest.hostname or "").strip().lower()
    if not oh or not dh:
        return None
    if oh != dh:
        # Allow bare IP ↔ nip.io for the same host.
        import federation_calls as _fc

        if not (_fc._host_ip_keys(oh) & _fc._host_ip_keys(dh)):
            return None
    try:
        _assert_safe_url(new_url)
    except Exception:
        return None
    return new_url


def enqueue_server_event(
    event_type: str,
    payload: dict,
    *,
    target_server_ids: list[str] | None = None,
    actor_global_user_id: str | None = None,
) -> dict:
    local = db.get_or_create_local_server_identity()
    # Random suffix prevents same-millisecond collisions when multiple
    # events are enqueued in quick succession (e.g. burst of bot upserts
    # or message bridges). Origin+event_id is the idempotency key on
    # the receiving side, so a duplicate id would silently drop the
    # second event.
    event_id = f"evt_{int(time.time() * 1000):016x}_{secrets.token_hex(4)}"
    normalized_type = str(event_type or "").strip()
    if not normalized_type:
        return {"ok": False, "error": "missing_event_type"}

    event = {
        "event_id": event_id,
        "event_type": normalized_type,
        "event_version": 1,
        "origin_server_id": local["server_id"],
        "origin_time": datetime.utcnow().isoformat() + "Z",
        "actor_global_user_id": str(actor_global_user_id or "server-admin").strip() or "server-admin",
        "payload": payload or {},
        "signature": "",
    }
    # Ed25519-sign every event so receivers can prove the origin_server_id
    # claim. Signature failures here are non-fatal (event still gets
    # enqueued unsigned) because we'd rather degrade open than drop
    # legitimate traffic if the local keystore is briefly unreadable;
    # peers with REQUIRE_SIGS=1 will then reject it.
    try:
        crypto_fed.sign_event(event)
    except Exception:
        _log.exception("failed to sign outbox event %s", event_id)
    if db.insert_federation_outbox_event(event, target_server_ids=target_server_ids):
        return {"ok": True, "event_id": event_id}
    return {"ok": False, "error": "enqueue_failed"}


def _encrypted_post_push_targets(wrapped_keys: list[dict]) -> list[str]:
    """Peer server_ids that should receive an encrypted wall event."""
    gids = []
    for w in wrapped_keys or []:
        if not isinstance(w, dict):
            continue
        gid = str(w.get("recipient_global_user_id") or "").strip()
        if gid:
            gids.append(gid)
    return db.resolve_federation_push_targets_for_recipient_gids(gids)


def enqueue_dm_message_created(
    sender: dict,
    peer: dict,
    *,
    channel_id: int = 0,
    content: str = "",
    media_data: str | None = None,
    media_type: str | None = None,
    media_name: str | None = None,
    reply_to: int | None = None,
    media_blur: int = 0,
    view_once: int = 0,
    created_at: str | None = None,
    source_message_id: str | None = None,
) -> dict:
    """Enqueue a signed ``dm.message.created`` for peer nodes.

    Includes ``global_user_id`` for both parties so receivers can match
    federated accounts even when nicknames differ between nodes.

    Uses per-peer outbox rows (same routing as federated calls) so a
    single successful push to one mirror does not mark the event sent
    before slower peers (e.g. Tor) receive it.
    """
    import federation_dms as fed_dm

    targets = fed_dm.dm_message_federation_remote_targets(sender, peer)
    local_sid = fed_dm._local_server_id()
    travel_send = fed_dm.user_session_on_travel_node(sender)
    if not targets:
        if travel_send or fed_dm.should_federate_dm(sender, peer):
            import federation_calls as fc

            targets = [
                sid for sid in fc._clearnet_federation_peer_ids()
                if sid and sid != local_sid
            ]
        if not targets:
            if not fed_dm.should_federate_dm(sender, peer):
                return {"ok": True, "skipped": "peer_online_local"}
            return {"ok": False, "error": "no_dm_route"}
    elif travel_send:
        # Travel-node sends must always reach account-home mirrors (e.g. Frog@AU → testy@home).
        for sid in fed_dm._user_required_mirror_servers(peer):
            if sid and sid != local_sid and sid not in targets:
                targets.append(sid)
        targets = sorted(set(targets))
    ts = created_at or (datetime.utcnow().isoformat() + "Z")
    return enqueue_server_event(
        "dm.message.created",
        {
            "channel_id": int(channel_id or 0),
            "sender_nickname": str(sender.get("nickname") or "").strip(),
            "peer_nickname": str(peer.get("nickname") or "").strip(),
            "sender_global_user_id": str(sender.get("global_user_id") or "").strip(),
            "peer_global_user_id": str(peer.get("global_user_id") or "").strip(),
            "content": content or "",
            "media_data": media_data,
            "media_type": media_type,
            "media_name": media_name,
            "reply_to": reply_to,
            "media_blur": int(media_blur or 0),
            "view_once": int(view_once or 0),
            "created_at": ts,
            "source_message_id": str(source_message_id or "").strip(),
        },
        target_server_ids=targets,
    )


def _dm_lifecycle_targets(sender: dict, peer: dict) -> list[str]:
    """Remote server ids for a DM edit/delete (same routing as created)."""
    import federation_dms as fed_dm
    import federation_calls as fc
    targets = fed_dm.dm_message_federation_remote_targets(sender, peer)
    local_sid = fed_dm._local_server_id()
    if not targets and fed_dm.should_federate_dm(sender, peer):
        targets = [sid for sid in fc._clearnet_federation_peer_ids() if sid and sid != local_sid]
    return targets


def enqueue_dm_message_edited(
    sender: dict,
    peer: dict,
    *,
    channel_id: int = 0,
    source_message_id: str = "",
    content: str = "",
    edited_at: str | None = None,
) -> dict:
    """Enqueue a signed ``dm.message.edited`` so the peer node updates its copy.

    Keyed on ``source_message_id`` (the sender's local row id) which the receiver
    maps to its federated copy via find_dm_message_by_federation_origin.
    """
    targets = _dm_lifecycle_targets(sender, peer)
    if not targets:
        return {"ok": True, "skipped": "no_remote_targets"}
    return enqueue_server_event(
        "dm.message.edited",
        {
            "channel_id": int(channel_id or 0),
            "sender_nickname": str(sender.get("nickname") or "").strip(),
            "peer_nickname": str(peer.get("nickname") or "").strip(),
            "sender_global_user_id": str(sender.get("global_user_id") or "").strip(),
            "peer_global_user_id": str(peer.get("global_user_id") or "").strip(),
            "source_message_id": str(source_message_id or "").strip(),
            "content": content or "",
            "edited_at": edited_at or (datetime.utcnow().isoformat() + "Z"),
        },
        target_server_ids=targets,
    )


def enqueue_dm_message_deleted(
    sender: dict,
    peer: dict,
    *,
    channel_id: int = 0,
    source_message_id: str = "",
) -> dict:
    """Enqueue a signed ``dm.message.deleted`` so the peer node removes its copy."""
    targets = _dm_lifecycle_targets(sender, peer)
    if not targets:
        return {"ok": True, "skipped": "no_remote_targets"}
    return enqueue_server_event(
        "dm.message.deleted",
        {
            "channel_id": int(channel_id or 0),
            "sender_nickname": str(sender.get("nickname") or "").strip(),
            "peer_nickname": str(peer.get("nickname") or "").strip(),
            "sender_global_user_id": str(sender.get("global_user_id") or "").strip(),
            "peer_global_user_id": str(peer.get("global_user_id") or "").strip(),
            "source_message_id": str(source_message_id or "").strip(),
        },
        target_server_ids=targets,
    )


def enqueue_dm_lock_prefs_updated(
    actor: dict,
    peer: dict,
    *,
    channel_id: int = 0,
    enabled: bool = False,
    timeout_sec: int = 0,
) -> dict:
    """Enqueue a signed ``dm.lock_prefs.updated`` for peer nodes."""
    import federation_dms as fed_dm

    targets = fed_dm.federation_mirror_targets(actor, peer)
    if not targets:
        return {"ok": False, "error": "no_dm_route"}
    actor_gid = str(actor.get("global_user_id") or "").strip()
    peer_gid = str(peer.get("global_user_id") or "").strip()
    if not actor_gid or not peer_gid:
        return {"ok": False, "error": "no_global_user_id"}
    return enqueue_server_event(
        "dm.lock_prefs.updated",
        {
            "channel_id": int(channel_id or 0),
            "actor_global_user_id": actor_gid,
            "peer_global_user_id": peer_gid,
            "sender_global_user_id": actor_gid,
            "actor_nickname": str(actor.get("nickname") or "").strip(),
            "peer_nickname": str(peer.get("nickname") or "").strip(),
            "sender_nickname": str(actor.get("nickname") or "").strip(),
            "pin_lock_enabled": 1 if enabled else 0,
            "pin_lock_timeout_sec": int(timeout_sec or 0),
        },
        target_server_ids=targets,
    )


def enqueue_dm_disappear_updated(
    actor: dict,
    peer: dict,
    *,
    channel_id: int = 0,
    seconds: int = 0,
) -> dict:
    """Enqueue a signed ``dm.disappear.updated`` for peer nodes."""
    import federation_dms as fed_dm

    targets = fed_dm.federation_mirror_targets(actor, peer)
    if not targets:
        return {"ok": False, "error": "no_dm_route"}
    actor_gid = str(actor.get("global_user_id") or "").strip()
    peer_gid = str(peer.get("global_user_id") or "").strip()
    if not actor_gid or not peer_gid:
        return {"ok": False, "error": "no_global_user_id"}
    return enqueue_server_event(
        "dm.disappear.updated",
        {
            "channel_id": int(channel_id or 0),
            "actor_global_user_id": actor_gid,
            "peer_global_user_id": peer_gid,
            "sender_global_user_id": actor_gid,
            "actor_nickname": str(actor.get("nickname") or "").strip(),
            "peer_nickname": str(peer.get("nickname") or "").strip(),
            "sender_nickname": str(actor.get("nickname") or "").strip(),
            "seconds": int(seconds or 0),
        },
        target_server_ids=targets,
    )


def enqueue_dm_read_receipt(
    reader: dict,
    peer: dict,
    *,
    channel_id: int = 0,
    up_to: int = 0,
) -> dict:
    """Enqueue a signed ``dm.read.receipt`` event so the sender on another node
    can update their ✓✓ tick when the reader is on a different node."""
    import federation_dms as fed_dm

    # Sender (peer) needs the tick update — route to their home/connection nodes only.
    targets = fed_dm.dm_message_federation_remote_targets(peer)
    if not targets:
        return {"ok": True, "skipped": "no_remote_targets"}
    reader_gid = str(reader.get("global_user_id") or "").strip()
    peer_gid = str(peer.get("global_user_id") or "").strip()
    if not reader_gid or not peer_gid or reader_gid == peer_gid:
        return {"ok": False, "error": "no_global_user_id"}
    up_to_i = max(0, int(up_to or 0))
    if up_to_i <= 0:
        return {"ok": False, "error": "bad_up_to"}
    return enqueue_server_event(
        "dm.read.receipt",
        {
            "channel_id": int(channel_id or 0),
            "reader_global_user_id": reader_gid,
            "peer_global_user_id": peer_gid,
            "reader_nickname": str(reader.get("nickname") or "").strip(),
            "peer_nickname": str(peer.get("nickname") or "").strip(),
            "up_to": up_to_i,
        },
        target_server_ids=targets,
    )


def enqueue_dm_wipe_all(
    actor: dict,
    peer: dict,
    *,
    wipe_id: str = "",
) -> dict:
    """Enqueue a signed ``dm.wipe.all`` for peer nodes."""
    import federation_dms as fed_dm

    targets = fed_dm.federation_mirror_targets(actor, peer)
    if not targets:
        return {"ok": False, "error": "no_dm_route"}
    actor_gid = str(actor.get("global_user_id") or "").strip()
    peer_gid = str(peer.get("global_user_id") or "").strip()
    wid = str(wipe_id or "").strip()[:64]
    if not actor_gid or not peer_gid or not wid:
        return {"ok": False, "error": "bad_payload"}
    return enqueue_server_event(
        "dm.wipe.all",
        {
            "actor_global_user_id": actor_gid,
            "peer_global_user_id": peer_gid,
            "actor_nickname": str(actor.get("nickname") or "").strip(),
            "peer_nickname": str(peer.get("nickname") or "").strip(),
            "wipe_id": wid,
            "requested_at": datetime.utcnow().isoformat() + "Z",
        },
        target_server_ids=targets,
    )


# Keep profile events under the 256 KiB outbox cap (avatar data URLs can be MBs).
_PROFILE_FED_FIELD_MAX_CHARS = 200_000
# Member snapshot cap: 500 members is enough for almost every channel
# we ship today and keeps a single outbox row under the size limit
# even with small avatar URLs attached.
_MAX_FED_MEMBER_SNAPSHOT = 500


def enqueue_user_profile_updated(user: dict, *, extra: dict | None = None) -> dict:
    """Enqueue a signed ``user.profile.updated`` for peer nodes."""
    if not user:
        return {"ok": False, "error": "no_user"}
    gid = str(user.get("global_user_id") or "").strip()
    if not gid:
        return {"ok": False, "error": "no_global_user_id"}
    payload = {
        "global_user_id": gid,
        "nickname": str(user.get("nickname") or "").strip(),
        "display_name": str(user.get("display_name") or ""),
        "avatar": str(user.get("avatar") or ""),
        "bio": str(user.get("bio") or ""),
        "status_msg": str(user.get("status_msg") or ""),
        "presence": str(user.get("presence") or "online"),
        "mood": str(user.get("mood") or ""),
        "identity_pubkey": str(user.get("identity_pubkey") or ""),
        "last_seen": str(user.get("last_seen") or "").strip(),
    }
    if extra:
        for k, v in extra.items():
            if v is not None:
                payload[k] = v
    for key in ("avatar", "banner"):
        val = str(payload.get(key) or "")
        if len(val) > _PROFILE_FED_FIELD_MAX_CHARS:
            payload[key] = ""
            payload[f"{key}_omitted"] = True
    return enqueue_server_event("user.profile.updated", payload)


def _user_block_event_payload(blocker: dict, blocked: dict) -> dict:
    return {
        "blocker_nickname": str(blocker.get("nickname") or "").strip(),
        "blocked_nickname": str(blocked.get("nickname") or "").strip(),
        "blocker_global_user_id": str(blocker.get("global_user_id") or "").strip(),
        "blocked_global_user_id": str(blocked.get("global_user_id") or "").strip(),
    }


def enqueue_user_block_mirror(event_type: str, blocker: dict, blocked: dict) -> dict:
    """Federate a block/unblock from the blocker's home node."""
    payload = _user_block_event_payload(blocker, blocked)
    if not payload["blocker_nickname"] or not payload["blocked_nickname"]:
        return {"ok": False, "error": "missing_nickname"}
    return enqueue_server_event(str(event_type or "").strip(), payload)


def enqueue_user_privacy_updated(user: dict) -> dict:
    """Federate privacy toggles from the user's home node."""
    gid = str(user.get("global_user_id") or "").strip()
    if not gid:
        return {"ok": False, "error": "no_global_user_id"}
    # Read the AUTHORITATIVE privacy flags from the DB (the user is local on the
    # home node, which is the only place this is emitted). Several callers pass a
    # partial dict — notably get_user_by_id(), which omits the privacy columns —
    # which made this fall back to defaults and federate profile_public=0,
    # silently flipping "Public Profile" to private on re-sync/travel. DB values
    # win so the snapshot always reflects what the user actually set.
    src = dict(user or {})
    try:
        snap = db.get_user_privacy_snapshot(gid)
        if snap:
            src.update({k: v for k, v in snap.items() if v is not None})
    except Exception:
        pass
    payload = {
        "global_user_id": gid,
        "nickname": str(src.get("nickname") or "").strip(),
        "profile_public": 1 if int(src.get("profile_public") or 0) else 0,
        "allow_friend_requests": 1 if int(src.get("allow_friend_requests") or 0) else 0,
        "allow_dms_from": str(src.get("allow_dms_from") or "everyone").strip().lower()[:32],
        "show_last_seen": str(src.get("show_last_seen") or "everyone").strip().lower()[:32],
        "show_read_receipts": 1 if int(src.get("show_read_receipts") or 0) else 0,
        "hide_dm_history_notice": 1 if int(src.get("hide_dm_history_notice") or 0) else 0,
    }
    if payload["allow_dms_from"] not in ("everyone", "friends", "nobody"):
        payload["allow_dms_from"] = "everyone"
    if payload["show_last_seen"] not in ("everyone", "friends", "nobody"):
        payload["show_last_seen"] = "everyone"
    return enqueue_server_event("user.privacy.updated", payload)


def emit_local_user_presence(user_id: int, presence: str) -> dict:
    """Persist + federate a user's presence (WS connect/disconnect, manual status)."""
    uid = int(user_id or 0)
    if uid <= 0:
        return {"ok": False, "error": "no_user"}
    p = str(presence or "").strip().lower()
    allowed = {"online", "away", "dnd", "invisible", "offline"}
    if p not in allowed:
        return {"ok": False, "error": "bad_presence"}
    try:
        row = db.get_user_by_id(uid) or {}
    except Exception:
        row = {}
    if not row:
        return {"ok": False, "error": "no_user"}
    cur = str(row.get("presence") or "").strip().lower()
    if cur == p:
        return {"ok": True, "skipped": True}
    try:
        db.set_user_presence(uid, p)
    except Exception:
        pass
    try:
        prof = db.get_user_profile(str(row.get("nickname") or "")) or {}
    except Exception:
        prof = {}
    merged = {**row, **{k: prof[k] for k in ("status_msg", "mood", "banner") if k in prof}}
    merged["presence"] = p
    return enqueue_user_profile_updated(merged)


_FED_ROOM_PRESENCE_TTL_SEC = 120
_ROOM_PRESENCE_FED_INTERVAL_SEC = 45.0
_room_presence_last_fed: dict[tuple[str, int], float] = {}


def _local_user_presence_state(user_id: int) -> str:
    uid = int(user_id or 0)
    if uid <= 0:
        return "offline"
    try:
        row = db.get_user_by_id(uid) or {}
    except Exception:
        row = {}
    p = str(row.get("presence") or "online").strip().lower()
    if p not in {"online", "away", "dnd", "invisible", "offline"}:
        p = "online"
    return p


def emit_room_presence(
    user: dict,
    room_name: str,
    presence: str,
    *,
    force: bool = False,
) -> dict:
    """Publish per-room presence to federation (WS connect/disconnect/heartbeat)."""
    if not isinstance(user, dict):
        return {"ok": False, "error": "no_user"}
    uid = int(user.get("id") or 0)
    gid = str(user.get("global_user_id") or "").strip()
    room = str(room_name or "").strip().lower()
    if uid <= 0 or not gid or not room or room.startswith("dm-") or room.startswith("dm:"):
        return {"ok": False, "skipped": True}
    p = str(presence or "offline").strip().lower()
    if p not in {"online", "away", "dnd", "invisible", "offline"}:
        return {"ok": False, "error": "bad_presence"}
    now = int(time.time())
    try:
        ident = db.get_or_create_local_server_identity() or {}
        origin = str(ident.get("server_id") or "").strip()
    except Exception:
        origin = ""
    db.upsert_federation_room_presence(
        room,
        gid,
        nickname=str(user.get("nickname") or "").strip(),
        origin_server_id=origin,
        presence=p,
        updated_at=now,
    )
    key = (room, uid)
    if not force and p != "offline":
        last = float(_room_presence_last_fed.get(key) or 0)
        if now - last < _ROOM_PRESENCE_FED_INTERVAL_SEC:
            return {"ok": True, "skipped": True, "local": True}
    _room_presence_last_fed[key] = float(now)
    return enqueue_server_event(
        "room.presence.updated",
        {
            "room_name": room,
            "global_user_id": gid,
            "nickname": str(user.get("nickname") or "").strip()[:64],
            "presence": p,
            "updated_at": now,
        },
    )


def touch_room_presence(user: dict, room_name: str) -> None:
    """Refresh room presence lease while WS is active (heartbeat)."""
    if not isinstance(user, dict):
        return
    p = _local_user_presence_state(int(user.get("id") or 0))
    if p == "invisible":
        return
    if p == "offline":
        p = "online"
    emit_room_presence(user, room_name, p, force=False)


_LAST_SEEN_FED_AT: dict[int, float] = {}
_LAST_SEEN_FED_INTERVAL_SEC = 90.0


def emit_user_last_seen(user: dict) -> dict:
    """Throttled federation fan-out of ``users.last_seen`` for cross-node DM headers."""
    if not isinstance(user, dict):
        return {"ok": False, "error": "no_user"}
    uid = int(user.get("id") or 0)
    gid = str(user.get("global_user_id") or "").strip()
    if uid <= 0 or not gid:
        return {"ok": False, "skipped": True}
    now = time.time()
    if now - _LAST_SEEN_FED_AT.get(uid, 0.0) < _LAST_SEEN_FED_INTERVAL_SEC:
        return {"ok": True, "skipped": "throttled"}
    _LAST_SEEN_FED_AT[uid] = now
    try:
        row = db.get_user_by_id(uid) or user
    except Exception:
        row = user
    seen = str((row or {}).get("last_seen") or "").strip()
    if not seen:
        return {"ok": True, "skipped": "empty"}
    return enqueue_user_profile_updated(row, extra={"last_seen": seen})


def emit_user_connection(user: dict, *, online: bool) -> dict:
    """Publish which node this user is actively connected to (WS session)."""
    if not isinstance(user, dict):
        return {"ok": False, "error": "no_user"}
    gid = str(user.get("global_user_id") or "").strip()
    uid = int(user.get("id") or 0)
    if uid <= 0 or not gid:
        return {"ok": False, "skipped": True}
    try:
        ident = db.get_or_create_local_server_identity() or {}
        local_sid = str(ident.get("server_id") or "").strip()
    except Exception:
        local_sid = ""
    if not local_sid:
        return {"ok": False, "error": "no_local_server"}
    now = int(time.time())
    if online:
        db.upsert_federation_user_connection(gid, local_sid, updated_at=now)
    else:
        db.clear_federation_user_connection(gid, local_sid)
    out = enqueue_server_event(
        "user.connection.updated",
        {
            "global_user_id": gid,
            "online": bool(online),
            "connected_server_id": local_sid if online else "",
            "updated_at": now,
            "last_seen": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        },
    )
    if online:
        try:
            emit_user_last_seen(user)
        except Exception:
            pass
    else:
        try:
            db.update_last_seen(uid)
            emit_user_last_seen({**user, "id": uid})
        except Exception:
            pass
    return out


_MUSIC_QUEUE_SNAPSHOT_MAX = 15


def emit_music_queue_snapshot(room_name: str) -> dict:
    """Federate the current unplayed music queue (visit→home / cross-node catch-up)."""
    name = str(room_name or "").strip().lower()
    if not name:
        return {"ok": False, "error": "no_room"}
    payload = _music_queue_snapshot_payload(name)
    if not payload:
        return {"ok": False, "skipped": True}
    return enqueue_server_event("room.music.queue.snapshot", payload)


def _music_queue_snapshot_payload(room_name: str) -> dict | None:
    """Build a portable music-queue snapshot for federation pull/push."""
    name = str(room_name or "").strip().lower()
    if not name:
        return None
    room = db.get_room_by_name(name)
    if not room:
        return None
    ctype = str(room.get("channel_type") or "text").strip().lower()
    if ctype not in ("music", "voice"):
        return None
    tracks = db.music_get_queue(name, limit=_MUSIC_QUEUE_SNAPSHOT_MAX)
    if not tracks:
        return None
    anchor = db.get_music_room_anchor(name) or {}
    safe: list[dict] = []
    for t in tracks:
        if not isinstance(t, dict):
            continue
        provider = str(t.get("provider") or "").strip()
        video_id = str(t.get("video_id") or "").strip()
        url = str(t.get("url") or "").strip()
        if not provider or not video_id or not url:
            continue
        safe.append({
            "submitter_nick": str(t.get("submitter_nick") or "")[:64],
            "provider": provider[:32],
            "video_id": video_id[:256],
            "url": url[:2048],
            "title": str(t.get("title") or "")[:200],
            "thumbnail": str(t.get("thumbnail") or "")[:2048],
            "duration": int(t.get("duration") or 0),
        })
    if not safe:
        return None
    return {
        "room_name": name,
        "tracks": safe,
        "head_track_id": int(anchor.get("track_id") or 0) or None,
        "start_unix": int(float(anchor.get("started_unix") or 0)) or None,
        "snapshot_at": int(time.time()),
    }


def maybe_emit_music_queue_snapshot(room_name: str) -> dict:
    """Push current music queue + playhead to peer nodes (home node only)."""
    name = str(room_name or "").strip().lower()
    if not name:
        return {"ok": False, "error": "no_room"}
    now = time.time()
    last = _music_snapshot_last_sent.get(name, 0.0)
    if now - last < _MUSIC_SNAPSHOT_THROTTLE_SEC:
        return {"ok": False, "error": "throttled"}
    try:
        room = db.get_room_by_name(name)
    except Exception:
        return {"ok": False, "error": "lookup_failed"}
    if not room:
        return {"ok": False, "error": "no_room"}
    if not _room_snapshot_authoritative(room):
        return {"ok": False, "error": "not_authoritative"}
    payload = _music_queue_snapshot_payload(name)
    if not payload:
        return {"ok": False, "error": "empty_queue"}
    _music_snapshot_last_sent[name] = now
    return enqueue_server_event("room.music.queue.snapshot", payload)


def _resolve_room_home_server_id(room_name: str, room: dict | None = None) -> str:
    row = room if isinstance(room, dict) else db.get_room_by_name(room_name)
    home = str((row or {}).get("home_server_id") or "").strip()
    if home:
        return home
    try:
        fed = db.get_federation_channel_index_entry(str(room_name or "").strip().lower())
    except Exception:
        fed = None
    if fed:
        return str(fed.get("home_server_id") or "").strip()
    return ""


def _music_mirror_needs_resync(room_name: str, home_payload: dict | None) -> bool:
    """True when local queue head differs from the home node's snapshot."""
    if not isinstance(home_payload, dict):
        return False
    tracks = home_payload.get("tracks") or []
    if not isinstance(tracks, list) or not tracks:
        return False
    local = db.music_get_queue(room_name, limit=1)
    if not local:
        return True
    home_head = tracks[0] if isinstance(tracks[0], dict) else {}
    loc = local[0] if isinstance(local[0], dict) else {}
    for key in ("video_id", "url", "provider"):
        hv = str(home_head.get(key) or "").strip().lower()
        lv = str(loc.get(key) or "").strip().lower()
        if hv and lv and hv != lv:
            return True
    return False


async def _apply_federated_music_snapshot(
    room_name: str,
    payload: dict,
    *,
    force: bool = False,
) -> bool:
    """Import a federated music queue snapshot into the local room mirror."""
    from routers import rooms as rooms_router

    name = str(room_name or "").strip().lower()
    if not name or not isinstance(payload, dict):
        return False
    if not db.get_room_by_name(name):
        return False
    tracks_in = payload.get("tracks") or []
    if not isinstance(tracks_in, list) or not tracks_in:
        return False
    if db.music_get_queue(name, limit=1) and not force:
        return False
    if force:
        try:
            db.music_clear_queue(name)
            _clear_music_anchor(name)
        except Exception:
            pass
    had_current = db.music_get_current(name)
    head_id = None
    for raw in tracks_in[:_MUSIC_QUEUE_SNAPSHOT_MAX]:
        if not isinstance(raw, dict):
            continue
        url = str(raw.get("url") or "").strip()
        provider, video_id, _embed = rooms_router._parse_track_url(url)
        if not provider:
            continue
        submitter_nick = _fed_nickname(raw.get("submitter_nick")) or "federation_sync"
        submitter = _ensure_local_user_by_nickname(submitter_nick)
        submitter_id = int(submitter["id"]) if submitter else int(db.get_or_create_federation_system_user())
        thumb = rooms_router._sanitize_artwork_url(str(raw.get("thumbnail") or ""))
        tid = db.music_add_track(
            room_name=name,
            submitter_id=submitter_id,
            submitter_nick=submitter_nick,
            provider=provider,
            video_id=video_id,
            url=url[:2048],
            title=str(raw.get("title") or "")[:200],
            thumbnail=thumb or "",
            duration=int(raw.get("duration") or 0),
        )
        if head_id is None:
            head_id = int(tid)
    anchor_id = head_id
    try:
        payload_head = int(payload.get("head_track_id") or 0)
        if payload_head > 0:
            anchor_id = payload_head
    except Exception:
        pass
    if anchor_id and (not had_current or force):
        start_unix = payload.get("start_unix")
        try:
            su = int(float(start_unix)) if start_unix is not None else int(time.time())
        except Exception:
            su = int(time.time())
        _set_music_anchor(name, int(anchor_id), su)
    await _broadcast_music_ws(name, {"type": "music_queue_snapshot", "room": name})
    return True


def _fetch_home_music_queue_sync(base_url: str, room_name: str) -> dict | None:
    """HTTP pull of music queue state from a room's home node."""
    fed = (os.getenv("FROGTALK_FEDERATION_TOKEN", "") or "").strip()
    name = str(room_name or "").strip().lower()
    if not fed or not name:
        return None
    from routers.auth import _norm_base

    source = _norm_base(base_url)
    if not source:
        return None
    path = f"/api/federation/rooms/{urllib.parse.quote(name, safe='')}/music-queue"
    url = f"{source}{path}"
    headers = {
        "Accept": "application/json",
        "User-Agent": "FrogTalk-MusicSync/1.0",
        "X-Federation-Token": fed,
    }
    try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=6.0) as resp:
            raw = resp.read()
        data = json.loads(raw.decode("utf-8", errors="replace"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


async def pull_music_queue_from_home(room_name: str, *, force: bool = False) -> dict:
    """Best-effort: hydrate local music mirror from the room's home node."""
    name = str(room_name or "").strip().lower()
    if not name:
        return {"ok": False, "error": "no_room"}
    room = db.get_room_by_name(name)
    if not room:
        return {"ok": False, "error": "no_room"}
    ctype = str(room.get("channel_type") or "text").strip().lower()
    if ctype not in ("music", "voice"):
        return {"ok": False, "skipped": True, "reason": "not_music_channel"}
    if _room_snapshot_authoritative(room):
        return {"ok": False, "skipped": True, "reason": "authoritative_local"}
    home_sid = _resolve_room_home_server_id(name, room)
    if not home_sid:
        return {"ok": False, "error": "no_home_server"}
    from routers.auth import resolve_server_base_url

    base = resolve_server_base_url(home_sid)
    if not base:
        return {"ok": False, "error": "home_unreachable"}
    payload = await run_in_threadpool(_fetch_home_music_queue_sync, base, name)
    if not payload or not isinstance(payload.get("tracks"), list):
        return {"ok": False, "error": "pull_failed"}
    if db.music_get_queue(name, limit=1) and not force:
        if _music_mirror_needs_resync(name, payload):
            force = True
        else:
            return {"ok": False, "skipped": True, "reason": "local_queue_nonempty"}
    applied = await _apply_federated_music_snapshot(name, payload, force=force)
    return {"ok": bool(applied)}


def schedule_music_sync_from_home(room_name: str, *, force: bool = False) -> None:
    """Fire-and-forget music queue pull for federated room mirrors."""
    name = str(room_name or "").strip().lower()
    if not name:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    async def _run() -> None:
        try:
            await pull_music_queue_from_home(name, force=force)
        except Exception:
            _log.exception("federation: music sync from home failed room=%s", name)

    loop.create_task(_run())


def enqueue_room_message_created(
    sender: dict,
    *,
    room_name: str,
    content: str = "",
    media_data: str | None = None,
    media_type: str | None = None,
    media_blur: int = 0,
    view_once: int = 0,
    created_at: str | None = None,
    origin_message_id: int | str | None = None,
) -> dict:
    """Enqueue a signed ``message.created`` for peer nodes.

    ``origin_message_id`` is the local DB row id of the source message;
    surfaced so peers can keep a history-backfill cursor and present a
    consistent "next message after id N" experience to the user.
    """
    ts = created_at or (datetime.utcnow().isoformat() + "Z")
    avatar = str(sender.get("avatar") or "")
    if len(avatar) > _PROFILE_FED_FIELD_MAX_CHARS:
        avatar = ""
    return enqueue_server_event(
        "message.created",
        {
            "room_name": str(room_name or "").strip(),
            "nickname": str(sender.get("nickname") or "").strip(),
            "display_name": str(sender.get("display_name") or ""),
            "sender_global_user_id": str(sender.get("global_user_id") or "").strip(),
            "avatar": avatar,
            "content": content or "",
            "media_data": media_data,
            "media_type": media_type,
            "media_blur": int(media_blur or 0),
            "view_once": int(view_once or 0),
            "created_at": ts,
            "origin_message_id": str(origin_message_id or "").strip(),
        },
    )


def enqueue_room_message_deleted(
    *,
    room_name: str,
    origin_message_id: int | str,
    actor_global_user_id: str = "",
    actor_nickname: str = "",
) -> dict:
    """Enqueue a signed ``message.deleted`` so peers can tombstone the row.

    Only the channel home or a local moderator should emit this; callers
    must enforce that authority — the federation inbox re-checks moderator
    role against the local copy before tombstoning.
    """
    return enqueue_server_event(
        "message.deleted",
        {
            "room_name": str(room_name or "").strip(),
            "origin_message_id": str(origin_message_id or "").strip(),
            "actor_global_user_id": str(actor_global_user_id or "").strip(),
            "actor_nickname": str(actor_nickname or "").strip(),
            "deleted_at": datetime.utcnow().isoformat() + "Z",
        },
    )


_members_snapshot_last_sent: dict[str, float] = {}
_music_snapshot_last_sent: dict[str, float] = {}
_MEMBERS_SNAPSHOT_THROTTLE_SEC = 60
_MUSIC_SNAPSHOT_THROTTLE_SEC = 45


def _local_server_id() -> str:
    try:
        return str((db.get_or_create_local_server_identity() or {}).get("server_id") or "").strip()
    except Exception:
        return ""


def _room_is_federated_mirror(room: dict | None) -> bool:
    """True for directory mirror shells owned by the federation system user."""
    if not room:
        return False
    try:
        fed_uid = int(db.get_or_create_federation_system_user())
        return int(room.get("owner_id") or 0) == fed_uid
    except Exception:
        return False


def _room_snapshot_authoritative(room: dict | None) -> bool:
    """True when this node may emit authoritative roster/directory events."""
    if not room:
        return False
    local_sid = _local_server_id()
    home = str(room.get("home_server_id") or "").strip()
    if home:
        return bool(local_sid) and home == local_sid
    return not _room_is_federated_mirror(room)


def room_member_event_payload(user: dict, room_name: str) -> dict:
    """Signed federation payload for room.member.joined / room.member.left."""
    gid = str((user or {}).get("global_user_id") or "").strip()
    nick = str((user or {}).get("nickname") or "").strip()
    home = ""
    try:
        if gid:
            home = str(db.resolve_global_user_home_server_id(gid) or "").strip()
    except Exception:
        home = ""
    return {
        "room_name": str(room_name or "").strip().lower(),
        "nickname": nick[:64],
        "global_user_id": gid[:64],
        "home_server_id": home[:64],
    }


def enqueue_channel_directory_updated(room_name: str) -> dict:
    """Push directory metadata to peers (signed ``channel.directory.updated``)."""
    name = str(room_name or "").strip().lower()
    if not name:
        return {"ok": False, "error": "no_room"}
    room = db.get_room_by_name(name)
    if not room:
        return {"ok": False, "error": "no_room"}
    if str(room.get("type") or "public").lower() != "public":
        return {"ok": False, "error": "not_public"}
    if not _room_snapshot_authoritative(room):
        return {"ok": False, "error": "not_authoritative"}
    local_sid = _local_server_id()
    if not local_sid:
        return {"ok": False, "error": "no_server_id"}
    owner = db.get_user_by_id(int(room.get("owner_id") or 0)) or {}
    owner_nick = str(owner.get("nickname") or "")
    owner_gid = str(owner.get("global_user_id") or "")
    if owner_nick.lower() == "federation_sync":
        # Never assert the system user as the owner over the wire — peers would
        # cache "federation_sync" as the displayed owner. Fall back to whatever
        # real owner we already know for this channel.
        fci = db.get_federation_channel_index_entry(name) or {}
        owner_nick = str(fci.get("owner_nickname") or "")
        owner_gid = str(fci.get("owner_global_user_id") or "")
    # Use the live member count — `rooms.member_count` is a stale denormalised
    # column that is never maintained on join/leave, so federating it would push
    # 0 to peers and zero out their directory counts.
    member_count = db.get_room_member_count(int(room.get("id") or 0))
    listed = bool(int(room.get("is_public") or 0))
    return enqueue_server_event(
        "channel.directory.updated",
        {
            "room_name": name,
            "home_server_id": local_sid,
            "is_public": listed,
            "listed": listed,
            "description": str(room.get("description") or "")[:512],
            "directory_description": str(room.get("directory_description") or "")[:1200],
            "icon": str(room.get("icon") or "")[:512] if room.get("icon") else "",
            "category": str(room.get("category") or "")[:32],
            "tags_json": str(room.get("tags") or "[]")[:2000],
            "channel_type": str(room.get("channel_type") or "text")[:16],
            "member_count": member_count,
            "owner_nickname": owner_nick[:64],
            "owner_global_user_id": owner_gid[:64],
            "home_base_url": str((db.get_or_create_local_server_identity() or {}).get("public_url") or "")[:256],
            "tombstone": not listed,
            "channel_theme": str(room.get("channel_theme") or "")[:20000],
            "content_warning_enabled": int(room.get("content_warning_enabled") or 0),
            "content_warning_flags": int(room.get("content_warning_flags") or 0) & db.CW_ALL,
        },
    )


def enqueue_channel_directory_deleted(room_snapshot: dict) -> dict:
    """Announce a public channel deletion so peers tombstone their mirror.

    Takes the room dict captured *before* the local row was deleted, since
    ``enqueue_channel_directory_updated`` can't run once the room is gone.
    Only the authoritative home node emits the tombstone."""
    room = room_snapshot or {}
    name = str(room.get("name") or "").strip().lower()
    if not name:
        return {"ok": False, "error": "no_room"}
    if str(room.get("type") or "public").lower() != "public":
        return {"ok": False, "error": "not_public"}
    if not _room_snapshot_authoritative(room):
        return {"ok": False, "error": "not_authoritative"}
    local_sid = _local_server_id()
    if not local_sid:
        return {"ok": False, "error": "no_server_id"}
    return enqueue_server_event(
        "channel.directory.updated",
        {
            "room_name": name,
            "home_server_id": local_sid,
            "is_public": False,
            "listed": False,
            "tombstone": True,
        },
    )


def maybe_emit_room_members_snapshot(room_name: str) -> dict:
    """Emit a fresh `room.members.snapshot` if we haven't done so recently.

    Designed to be called after any local join/leave/role change. Caller
    is responsible for ensuring this node is authoritative for the room
    (i.e. the room's home server). We throttle to once per minute per
    room so a quick burst of joins doesn't flood peers.
    """
    name = (room_name or "").strip().lower()
    if not name:
        return {"ok": False, "error": "no_room"}
    now = time.time()
    last = _members_snapshot_last_sent.get(name, 0.0)
    if now - last < _MEMBERS_SNAPSHOT_THROTTLE_SEC:
        return {"ok": False, "error": "throttled"}
    try:
        room = db.get_room_by_name(name)
    except Exception:
        return {"ok": False, "error": "lookup_failed"}
    if not room:
        return {"ok": False, "error": "no_room"}
    if not _room_snapshot_authoritative(room):
        return {"ok": False, "error": "not_authoritative"}
    # Private channels never emit a snapshot — the membership is
    # confidential and other peers have no need-to-know.
    if str(room.get("type") or "public").lower() == "private":
        return {"ok": False, "error": "private_room"}
    try:
        local_members = db.get_channel_members(int(room.get("id") or 0)) or []
    except Exception:
        local_members = []
    members_payload: list[dict] = []
    owner_id = int(room.get("owner_id") or 0)
    for m in local_members:
        gid = str(m.get("global_user_id") or "").strip()
        nick = str(m.get("nickname") or "").strip()
        if not gid or not nick:
            continue
        uid = int(m.get("user_id") or 0)
        role = "member"
        if uid and uid == owner_id:
            role = "owner"
        elif int(m.get("is_admin") or 0):
            role = "admin"
        members_payload.append({
            "global_user_id": gid,
            "nickname": nick,
            "display_name": str(m.get("display_name") or ""),
            "avatar": str(m.get("avatar") or ""),
            "role": role,
        })
    _members_snapshot_last_sent[name] = now
    return enqueue_room_members_snapshot(
        room_name=name,
        members=members_payload,
        member_count=len(members_payload),
    )


def enqueue_room_members_snapshot(
    *,
    room_name: str,
    members: list[dict],
    member_count: int,
) -> dict:
    """Enqueue a signed ``room.members.snapshot`` so peers can hydrate rosters.

    Callers MUST be authoritative for the room (room owner/admin on this
    node — i.e. the room's local home). The inbox handler verifies the
    origin matches the room's pinned home_server_id before purging members
    that aren't in the snapshot.

    Member entries are clipped to safe sizes; avatars over the federation
    limit are dropped to avoid blowing outbox row size.
    """
    safe_members: list[dict] = []
    for m in members[:_MAX_FED_MEMBER_SNAPSHOT]:
        if not isinstance(m, dict):
            continue
        gid = str(m.get("global_user_id") or "").strip()
        nick = str(m.get("nickname") or "").strip()
        if not gid or not nick:
            continue
        avatar = str(m.get("avatar") or "")
        if len(avatar) > _PROFILE_FED_FIELD_MAX_CHARS:
            avatar = ""
        safe_members.append({
            "global_user_id": gid[:64],
            "nickname": nick[:64],
            "display_name": str(m.get("display_name") or "")[:64],
            "avatar": avatar,
            "home_server_id": str(m.get("home_server_id") or "")[:64],
            "role": str(m.get("role") or "member")[:16],
        })
    return enqueue_server_event(
        "room.members.snapshot",
        {
            "room_name": str(room_name or "").strip(),
            "members": safe_members,
            "member_count": int(member_count or 0),
            "snapshot_at": datetime.utcnow().isoformat() + "Z",
        },
    )


def _social_user_fields(user: dict) -> dict:
    return {
        "nickname": str(user.get("nickname") or "").strip(),
        "author_global_user_id": str(user.get("global_user_id") or "").strip(),
        "global_user_id": str(user.get("global_user_id") or "").strip(),
    }


def enqueue_social_post_created(
    user: dict,
    *,
    global_post_id: str,
    content: str = "",
    media_data: str | None = None,
    media_type: str | None = None,
    privacy: str = "public",
    share_enabled: bool = True,
    allow_comments: bool = True,
    track_title: str | None = None,
    track_room: str | None = None,
    track_mood: str | None = None,
) -> dict:
    return enqueue_server_event(
        "social.post.created",
        {
            "global_post_id": str(global_post_id or "").strip(),
            **_social_user_fields(user),
            "content": (content or "")[:_FED_SOCIAL_CONTENT_MAX],
            "media_data": media_data,
            "media_type": media_type,
            "privacy": privacy,
            "share_enabled": bool(share_enabled),
            "allow_comments": bool(allow_comments),
            "track_title": track_title,
            "track_room": track_room,
            "track_mood": track_mood,
        },
    )


def enqueue_social_post_created_encrypted(
    user: dict,
    *,
    global_post_id: str,
    audience: str,
    ciphertext_b64: str,
    wrapped_keys: list[dict],
    media_data: str | None = None,
    media_type: str | None = None,
    share_enabled: bool = True,
    allow_comments: bool = True,
    track_title: str | None = None,
    track_room: str | None = None,
    track_mood: str | None = None,
) -> dict:
    return enqueue_server_event(
        "social.post.created.encrypted",
        {
            "global_post_id": str(global_post_id or "").strip(),
            **_social_user_fields(user),
            "audience": audience,
            "ciphertext_b64": ciphertext_b64,
            "wrapped_keys": wrapped_keys,
            "media_data": media_data,
            "media_type": media_type,
            "share_enabled": bool(share_enabled),
            "allow_comments": bool(allow_comments),
            "track_title": track_title,
            "track_room": track_room,
            "track_mood": track_mood,
        },
        target_server_ids=_encrypted_post_push_targets(wrapped_keys),
    )


def enqueue_social_post_keys_extended(
    user: dict,
    *,
    global_post_id: str,
    wrapped_keys: list[dict],
) -> dict:
    """Federate additional wraps when audience grows (e.g. new cross-node follower)."""
    return enqueue_server_event(
        "social.post.keys.extended",
        {
            "global_post_id": str(global_post_id or "").strip(),
            **_social_user_fields(user),
            "wrapped_keys": wrapped_keys,
        },
        target_server_ids=_encrypted_post_push_targets(wrapped_keys),
    )


def enqueue_social_post_updated(
    user: dict,
    *,
    global_post_id: str,
    updates: dict,
) -> dict:
    payload = {"global_post_id": str(global_post_id or "").strip(), **_social_user_fields(user)}
    payload.update(updates or {})
    return enqueue_server_event("social.post.updated", payload)


def enqueue_social_post_deleted(
    user: dict,
    *,
    global_post_id: str,
    force_delete: bool = False,
) -> dict:
    # force_delete is local-admin only; remote peers ignore it by design.
    _ = force_delete
    return enqueue_server_event(
        "social.post.deleted",
        {
            "global_post_id": str(global_post_id or "").strip(),
            **_social_user_fields(user),
        },
    )


def enqueue_social_comment_created(
    actor: dict,
    *,
    global_post_id: str,
    global_comment_id: str,
    owner_nickname: str,
    content: str,
) -> dict:
    return enqueue_server_event(
        "social.comment.created",
        {
            "global_post_id": str(global_post_id or "").strip(),
            "global_comment_id": str(global_comment_id or "").strip(),
            "actor_nickname": str(actor.get("nickname") or "").strip(),
            "actor_global_user_id": str(actor.get("global_user_id") or "").strip(),
            "owner_nickname": str(owner_nickname or "").strip(),
            "content": content[:_FED_SOCIAL_COMMENT_MAX],
        },
    )


def enqueue_social_reaction_changed(
    actor: dict,
    *,
    global_post_id: str,
    owner_nickname: str,
    emoji: str,
    active: bool,
) -> dict:
    return enqueue_server_event(
        "social.reaction.changed",
        {
            "global_post_id": str(global_post_id or "").strip(),
            "actor_nickname": str(actor.get("nickname") or "").strip(),
            "actor_global_user_id": str(actor.get("global_user_id") or "").strip(),
            "owner_nickname": str(owner_nickname or "").strip(),
            "emoji": emoji,
            "active": bool(active),
        },
    )


def enqueue_social_repost_created(
    actor: dict,
    *,
    global_post_id: str,
    owner_nickname: str,
    quote: str | None,
    active: bool = True,
) -> dict:
    return enqueue_server_event(
        "social.repost.created",
        {
            "global_post_id": str(global_post_id or "").strip(),
            "actor_nickname": str(actor.get("nickname") or "").strip(),
            "actor_global_user_id": str(actor.get("global_user_id") or "").strip(),
            "owner_nickname": str(owner_nickname or "").strip(),
            "quote": (str(quote)[:_FED_SOCIAL_QUOTE_MAX] if quote else None),
            "active": bool(active),
        },
    )


def enqueue_social_follow_changed(
    follower: dict,
    following: dict,
    *,
    action: str,
) -> dict:
    follower_gid = str(follower.get("global_user_id") or "").strip()
    following_gid = str(following.get("global_user_id") or "").strip()
    targets = db.resolve_federation_push_targets_for_recipient_gids(
        [follower_gid, following_gid],
    )
    return enqueue_server_event(
        "social.follow.changed",
        {
            "action": action,
            "follower_nickname": str(follower.get("nickname") or "").strip(),
            "follower_global_user_id": follower_gid,
            "following_nickname": str(following.get("nickname") or "").strip(),
            "following_global_user_id": following_gid,
        },
        target_server_ids=targets if targets else None,
    )


def enqueue_friend_graph_event(
    event_type: str,
    from_user: dict,
    to_user: dict,
    *,
    extra: dict | None = None,
) -> dict:
    """Replicate friend.requested / friend.accepted / friend.request.removed to homed nodes."""
    from_gid = str(from_user.get("global_user_id") or "").strip()
    to_gid = str(to_user.get("global_user_id") or "").strip()
    targets = db.resolve_federation_push_targets_for_recipient_gids([from_gid, to_gid])
    payload = {
        "from_nickname": str(from_user.get("nickname") or "").strip(),
        "from_global_user_id": from_gid,
        "to_nickname": str(to_user.get("nickname") or "").strip(),
        "to_global_user_id": to_gid,
    }
    if isinstance(extra, dict):
        for key, val in extra.items():
            if val is not None:
                payload[key] = val
    return enqueue_server_event(
        event_type,
        payload,
        target_server_ids=targets if targets else None,
    )


def enqueue_social_story_created(
    user: dict,
    *,
    global_story_id: str,
    media_data: str,
    media_type: str,
    caption: str = "",
    privacy: str = "public",
) -> dict:
    # Stories federate their media inline. Skip oversized media rather than
    # broadcasting a blob every peer would reject at the same cap — such a
    # story stays local-only (there is no cross-node lazy-fetch for stories).
    if not media_data or len(str(media_data)) > _FED_STORY_MEDIA_DATA_MAX:
        return {"ok": False, "error": "story_media_too_large"}
    return enqueue_server_event(
        "social.story.created",
        {
            "global_story_id": str(global_story_id or "").strip(),
            **_social_user_fields(user),
            "media_data": media_data,
            "media_type": media_type,
            "caption": caption,
            "privacy": privacy,
        },
    )


def enqueue_social_story_deleted(user: dict, *, global_story_id: str) -> dict:
    return enqueue_server_event(
        "social.story.deleted",
        {
            "global_story_id": str(global_story_id or "").strip(),
            **_social_user_fields(user),
        },
    )


def _fed_resolve_social_user(
    payload: dict,
    origin_server_id: str = "",
    *,
    strict_origin: bool = True,
    use_account_home: bool = False,
) -> dict | None:
    """Map a federated social actor to a local users row.

    ``strict_origin=True`` (default) requires the gid's home server to match
    the event ``origin_server_id`` — guards against a peer impersonating users
    homed elsewhere. Pass ``False`` only for counterparty lookups (e.g. the
    "following" side of a follow event, where their home is by definition
    different from the follower's home).

    ``use_account_home=True`` pins shadow users to their federation home
    server (for social-graph events signed on travel nodes).
    """
    nick = _fed_nickname(
        payload.get("nickname")
        or payload.get("actor_nickname")
        or payload.get("author_nickname")
        or payload.get("follower_nickname")
        or payload.get("following_nickname")
        or payload.get("from_nickname")
        or payload.get("to_nickname")
    )
    gid = _fed_global_id(
        payload.get("global_user_id")
        or payload.get("author_global_user_id")
        or payload.get("actor_global_user_id")
        or payload.get("follower_global_user_id")
        or payload.get("following_global_user_id")
        or payload.get("from_global_user_id")
        or payload.get("to_global_user_id")
    )
    origin = (origin_server_id or "").strip()
    if gid:
        home = db.resolve_global_user_home_server_id(gid)
        shadow_origin = (home or origin) if use_account_home else origin
        if not use_account_home and strict_origin:
            if home and origin and home != origin:
                return None
        return db.ensure_federated_dm_local_user(
            gid, nick or "", origin_server_id=shadow_origin or origin,
        )
    if nick:
        return _ensure_local_user_by_nickname(nick)
    return None


def _fed_resolve_friend_party(
    payload: dict,
    role: str,
    origin_server_id: str = "",
) -> dict | None:
    """Resolve ``from`` / ``to`` on friend.* events by global_user_id first."""
    prefix = "from" if role == "from" else "to"
    nick = _fed_nickname(payload.get(f"{prefix}_nickname"))
    gid = _fed_global_id(payload.get(f"{prefix}_global_user_id"))
    if gid:
        home = db.resolve_global_user_home_server_id(gid)
        return db.ensure_federated_dm_local_user(
            gid,
            nick or "",
            origin_server_id=home or origin_server_id,
        )
    if nick:
        return db.get_user_by_nick(nick)
    return None


def _fed_wall_owner_matches_post(owner: dict | None, local_post_id: int) -> bool:
    if not owner or not local_post_id:
        return False
    meta = db.get_wall_post_meta(int(local_post_id))
    if not meta:
        return False
    try:
        return int(meta.get("user_id") or 0) == int(owner["id"])
    except Exception:
        return False


def _tor_proxy_url() -> str:
    return (os.getenv("FROGTALK_TOR_SOCKS_PROXY") or "socks5://127.0.0.1:9050").strip()


def _url_uses_tor(url: str) -> bool:
    try:
        host = (urllib.parse.urlparse(url).hostname or "").strip().lower()
    except Exception:
        host = ""
    return host.endswith(".onion")


class _UnsafeURLError(ValueError):
    """Raised when a federation/peer URL fails the SSRF allowlist."""


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuses to auto-follow redirects.

    Otherwise an attacker-controlled peer URL could 302 us to
    ``http://169.254.169.254/`` after passing the initial IP check.
    Callers wanting to follow redirects must re-validate the new
    target URL through ``_assert_safe_url`` before re-issuing.
    """
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise _UnsafeURLError(f"redirects not allowed (got {code} -> {newurl})")


def _assert_safe_url(url: str) -> None:
    """SSRF allowlist for outbound federation/peer fetches.

    Tor (.onion) hosts skip the IP check — they can't resolve to a
    routable IP anyway, and we want to be able to talk to peer onions.
    Everything else: scheme must be http/https and every resolved
    address has to be a globally routable unicast IP.
    """
    try:
        parsed = urllib.parse.urlsplit(url)
    except Exception as exc:
        raise _UnsafeURLError(f"unparseable URL: {exc}") from exc
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise _UnsafeURLError(f"scheme {scheme!r} not allowed")
    host = (parsed.hostname or "").strip()
    if not host:
        raise _UnsafeURLError("missing host")
    if host.lower().endswith(".onion"):
        # .onion hosts route via Tor; the IP filter doesn't apply.
        return
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise _UnsafeURLError(f"DNS failed for {host}: {exc}") from exc
    seen_any = False
    for family, _stype, _proto, _canon, sockaddr in infos:
        if not sockaddr:
            continue
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        seen_any = True
        # Block any non-globally-routable address. is_global is the most
        # conservative check available; it rules out private, loopback,
        # link-local, multicast, reserved and unspecified ranges.
        if not ip.is_global:
            raise _UnsafeURLError(f"resolved IP {ip_str} for {host} is not globally routable")
    if not seen_any:
        raise _UnsafeURLError(f"no usable IPs for {host}")


# HIGH-12: hard byte cap on outbound federation HTTP responses. A
# malicious or compromised peer that streams gigabytes back at us would
# otherwise OOM the worker; the JSON cap is tight (federation manifests
# / status payloads are small), the binary cap is generous enough for
# update tarballs.
_FED_RESPONSE_MAX_JSON = 4 * 1024 * 1024              # 4 MB
_FED_RESPONSE_MAX_BIN = 256 * 1024 * 1024             # 256 MB (update packages)


def _fetch_url_bytes(
    url: str,
    *,
    timeout_s: float = 4.5,
    method: str = "GET",
    headers: dict | None = None,
    data: bytes | None = None,
    max_bytes: int | None = None,
    _redirect_retry: bool = True,
) -> bytes:
    # SSRF allowlist runs first regardless of transport. We only do this
    # for outbound peer fetches — user-supplied URLs (link previews,
    # imageboard, etc.) have their own checks elsewhere.
    _assert_safe_url(url)
    if max_bytes is None:
        max_bytes = _FED_RESPONSE_MAX_JSON
    try:
        return _fetch_url_bytes_once(
            url,
            timeout_s=timeout_s,
            method=method,
            headers=headers,
            data=data,
            max_bytes=max_bytes,
        )
    except _UnsafeURLError as exc:
        if _redirect_retry:
            upgraded = _upgrade_same_host_https_redirect(url, str(exc))
            if upgraded and upgraded != url:
                return _fetch_url_bytes(
                    upgraded,
                    timeout_s=timeout_s,
                    method=method,
                    headers=headers,
                    data=data,
                    max_bytes=max_bytes,
                    _redirect_retry=False,
                )
        raise


def _fetch_url_bytes_once(
    url: str,
    *,
    timeout_s: float = 4.5,
    method: str = "GET",
    headers: dict | None = None,
    data: bytes | None = None,
    max_bytes: int | None = None,
) -> bytes:
    if max_bytes is None:
        max_bytes = _FED_RESPONSE_MAX_JSON
    if _url_uses_tor(url):
        # follow_redirects=False so a malicious onion can't bounce us
        # to a clearnet attacker target after the SSRF check passed.
        with httpx.Client(proxy=_tor_proxy_url(), timeout=timeout_s, follow_redirects=False) as client:
            with client.stream(method, url, headers=headers, content=data) as resp:
                resp.raise_for_status()
                chunks: list[bytes] = []
                total = 0
                for chunk in resp.iter_bytes(chunk_size=65536):
                    total += len(chunk)
                    if total > max_bytes:
                        raise _UnsafeURLError(
                            f"federation response from {url!r} exceeded {max_bytes} bytes"
                        )
                    chunks.append(chunk)
                return b"".join(chunks)

    req = urllib.request.Request(url, headers=headers or {}, data=data, method=method)
    opener = urllib.request.build_opener(_NoRedirectHandler())
    with opener.open(req, timeout=timeout_s) as resp:
        buf = bytearray()
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            buf.extend(chunk)
            if len(buf) > max_bytes:
                raise _UnsafeURLError(
                    f"federation response from {url!r} exceeded {max_bytes} bytes"
                )
        return bytes(buf)


def peer_uses_tor_route(server: dict) -> bool:
    """True when this peer's effective federation target is a .onion host."""
    try:
        return _url_uses_tor(_select_peer_target(server))
    except Exception:
        onion = _normalize_base_url(str((server or {}).get("onion_url") or ""))
        base = _normalize_base_url(str((server or {}).get("base_url") or ""))
        return _url_uses_tor(onion or base)


def peer_uses_http_only_clearnet(server: dict) -> bool:
    """True when the peer's advertised clearnet base_url is plain http://."""
    from public_url_policy import url_is_http_only_clearnet

    base = _normalize_base_url(str((server or {}).get("base_url") or ""))
    if not base:
        return False
    return url_is_http_only_clearnet(base)


def apply_tor_peer_blocks_if_enabled() -> int:
    """Disable federation peers that route over Tor when policy is on.

    Returns the number of peers newly disabled this call. Does not
    re-enable peers when the policy is turned off — operators unblock
    manually from the node list.
    """
    if not db.get_federation_policy_settings().get("block_tor_peers"):
        return 0
    local_id = str((db.get_or_create_local_server_identity() or {}).get("server_id") or "")
    disabled = 0
    for peer in db.list_federation_servers_admin(include_disabled=True):
        sid = str(peer.get("server_id") or "").strip()
        if not sid or sid == local_id:
            continue
        if not peer.get("enabled"):
            continue
        if peer_uses_tor_route(peer) and db.set_federation_server_enabled(sid, False):
            disabled += 1
    return disabled


def apply_http_only_peer_blocks_if_enabled() -> int:
    """Disable federation peers whose clearnet URL is http:// when policy is on."""
    if not db.get_federation_policy_settings().get("block_http_only_peers"):
        return 0
    local_id = str((db.get_or_create_local_server_identity() or {}).get("server_id") or "")
    disabled = 0
    for peer in db.list_federation_servers_admin(include_disabled=True):
        sid = str(peer.get("server_id") or "").strip()
        if not sid or sid == local_id:
            continue
        if not peer.get("enabled"):
            continue
        if peer_uses_http_only_clearnet(peer) and db.set_federation_server_enabled(sid, False):
            disabled += 1
    return disabled


def _select_peer_target(server: dict) -> str:
    # Prefer transport_preference already on the row (avoids per-peer DB roundtrip
    # when called in a hot loop). Fall back to a single SELECT only if missing.
    transport_raw = server.get("transport_preference")
    if transport_raw is None:
        transport_raw = db.get_federation_server_transport(str(server.get("server_id") or ""))
    transport = str(transport_raw or "auto").strip().lower()
    base_url = _normalize_base_url(str(server.get("base_url") or ""))
    onion_url = _normalize_base_url(str(server.get("onion_url") or ""))
    tor_enabled = _tor_mode_enabled()

    if transport == "onion" and onion_url:
        return onion_url
    if transport == "clearnet" and base_url:
        return base_url
    if transport == "auto" and tor_enabled and onion_url and not base_url:
        return onion_url
    if transport == "auto" and tor_enabled and base_url:
        return base_url
    return base_url or onion_url


def _tor_mode_enabled() -> bool:
    """True iff this node should treat the network as Tor-only.

    HIGH-14: accept either ``FROGTALK_TOR_ENABLED`` or
    ``FROGTALK_TOR_MODE``. Different subsystems were checking different
    env vars (federation read TOR_ENABLED, geoip read TOR_MODE), so an
    operator who only set one ended up with a partially-Tor build that
    still phoned home to clearnet GeoIP services on Tor nodes.
    """
    v1 = (os.getenv("FROGTALK_TOR_ENABLED", "") or "").strip().lower()
    v2 = (os.getenv("FROGTALK_TOR_MODE", "") or "").strip().lower()
    for raw in (v1, v2):
        if raw in ("1", "true", "yes", "on"):
            return True
    return False


def _server_advertises_onion_only(server: dict) -> bool:
    onion_url = _normalize_base_url(str(server.get("onion_url") or ""))
    if not onion_url:
        return False
    if not _normalize_base_url(str(server.get("base_url") or "")):
        return True
    transport = str(server.get("transport_preference") or "").strip().lower()
    return transport == "onion"


def _is_official_main_hub() -> bool:
    """True when this node is configured as the official directory hub (mesh file / env)."""
    if _tor_mode_enabled():
        return False
    return federation_mesh.is_directory_hub()


def _repair_mesh_clearnet_urls() -> int:
    """Apply optional clearnet_repairs from FROGTALK_FEDERATION_MESH_FILE."""
    if not federation_mesh.is_directory_hub():
        return 0
    repaired = 0
    for spec in federation_mesh.clearnet_repairs():
        sid = str(spec.get("server_id") or "").strip()
        want = _normalize_base_url(str(spec.get("canonical_base_url") or ""))
        if not sid or not want:
            continue
        row = db.get_federation_server_row(sid)
        if not row:
            continue
        cur = _normalize_base_url(str(row.get("base_url") or ""))
        if cur == want:
            continue
        legacy_hosts = [
            str(h).strip().lower()
            for h in (spec.get("legacy_base_url_hosts") or [])
            if str(h).strip()
        ]
        cur_host = (_url_hostname(cur) or "").strip().lower()
        if cur and cur != want and (legacy_hosts and cur_host not in legacy_hosts):
            continue
        display = str(spec.get("display_name") or row.get("display_name") or sid).strip()
        mesh_region = str(spec.get("region") or "").strip()
        repair_row = {
            **row,
            "base_url": want,
            "display_name": display,
            "region": mesh_region,
        }
        region = mesh_region or _resolved_server_region(repair_row)
        db.upsert_federation_server(
            server_id=sid,
            display_name=display[:120] or sid,
            base_url=want,
            onion_url=str(row.get("onion_url") or "").strip(),
            region=region,
            official=True,
            trust_tier=str(row.get("trust_tier") or "official").strip() or "official",
            capabilities=row.get("capabilities") if isinstance(row.get("capabilities"), list) else ["federation-v1"],
        )
        local = db.get_or_create_local_server_identity() or {}
        if str(local.get("server_id") or "").strip() == sid:
            db.set_config("federation.base_url", want)
        _log.info("federation: mesh repair %s base_url %s → %s", sid, cur or "(empty)", want)
        repaired += 1
    return repaired


def ensure_official_mesh_peers() -> int:
    """Upsert ensure_peers from federation mesh config when this node is the directory hub."""
    if not federation_mesh.is_directory_hub():
        return 0
    _repair_mesh_clearnet_urls()
    ensured = 0
    for item in federation_mesh.ensure_peers():
        row = _coerce_server_row(item)
        if not row:
            continue
        sid = row["server_id"]
        existing = db.get_federation_server_row(sid)
        onion_ok = bool(_normalize_base_url(str((existing or {}).get("onion_url") or "")))
        enabled = int((existing or {}).get("enabled") or 0)
        if existing and onion_ok and enabled:
            continue
        mesh_region = str(item.get("region") or "").strip()
        region = mesh_region or _resolved_server_region(row)
        official = bool(item.get("official", True))
        trust = str(item.get("trust_tier") or "official").strip() or "official"
        db.upsert_federation_server(
            server_id=sid,
            display_name=row["display_name"],
            base_url=row["base_url"],
            onion_url=row["onion_url"],
            region=region,
            official=official,
            trust_tier=trust,
            capabilities=row["capabilities"],
        )
        ensured += 1
    return ensured


def _builtin_tor_mirror_directory_row() -> dict | None:
    """Tor mirror row from mesh config for the public network picker (onion-only view)."""
    item = federation_mesh.builtin_tor_mirror_peer()
    if not item:
        return None
    item = dict(item)
    item["official"] = 1
    item["enabled"] = 1
    item["trust_tier"] = "official"
    return _public_server_view_for_client(item)


def _hybrid_node_enabled() -> bool:
    """Clearnet hub that federates with Tor peers (e.g. frogtalk.xyz + onion relay)."""
    for key in ("FROGTALK_HYBRID_NODE", "FROGTALK_TOR_RELAY_NODE"):
        raw = (os.getenv(key, "") or "").strip().lower()
        if raw in ("1", "true", "yes", "on"):
            return True
    if _tor_mode_enabled():
        return False
    if _is_official_main_hub():
        return True
    try:
        local = db.get_or_create_local_server_identity() or {}
    except Exception:
        return False
    onion_env = _normalize_base_url(os.getenv("FROGTALK_ONION_URL", ""))
    if not onion_env:
        return False
    site = _normalize_base_url(
        os.getenv("FROGTALK_SITE_URL", "") or os.getenv("SITE_URL", "") or "",
    )
    local_base = _normalize_base_url(str(local.get("base_url") or ""))
    if site and local_base and site.rstrip("/") != local_base.rstrip("/"):
        return False
    return bool(int(local.get("official") or 0))


def _network_viewer_mode() -> str:
    """How this node participates in the public network picker (tor | hybrid | clearnet)."""
    if _tor_mode_enabled():
        return "tor"
    if _hybrid_node_enabled():
        return "hybrid"
    return "clearnet"


def _is_tor_directory_listing(server: dict) -> bool:
    """True when the app must never show a clearnet IP for this directory row."""
    if _server_advertises_onion_only(server):
        return True
    onion = _normalize_base_url(str(server.get("onion_url") or ""))
    if not onion:
        return False
    sid = str(server.get("server_id") or "").strip()
    if sid and sid in federation_mesh.tor_mirror_server_ids():
        return True
    transport = str(server.get("transport_preference") or "").strip().lower()
    if transport == "onion":
        return True
    name = str(server.get("display_name") or "").lower()
    if "tor" in name and any(tok in name for tok in ("mirror", "hidden", "onion")):
        return True
    base = _normalize_base_url(str(server.get("base_url") or ""))
    if not base:
        return True
    try:
        host = (_url_hostname(base) or "").strip()
        if host and ipaddress.ip_address(host):
            return True
    except ValueError:
        pass
    return False


def _is_hybrid_directory_listing(server: dict) -> bool:
    """Clearnet hub with optional onion relay (visible to Tor and hybrid viewers)."""
    if _is_tor_directory_listing(server):
        return False
    base = _normalize_base_url(str(server.get("base_url") or ""))
    onion = _normalize_base_url(str(server.get("onion_url") or ""))
    if base and onion:
        return True
    if base and int(server.get("official") or 0):
        return True
    return False


def _peer_visible_in_network_picker(server: dict) -> bool:
    """Tor → hybrid+tor listings; hybrid → all; clearnet-only → clearnet peers only."""
    mode = _network_viewer_mode()
    tor_peer = bool(server.get("tor_listing"))
    hybrid_peer = bool(server.get("hybrid_listing"))
    if mode == "hybrid":
        return True
    if mode == "tor":
        return tor_peer or hybrid_peer
    return not tor_peer


def _filter_network_picker_servers(servers: list[dict]) -> list[dict]:
    return [s for s in servers if _peer_visible_in_network_picker(s)]


def federation_policy_admin_ui() -> dict:
    """Server-admin toggles: Tor auto-block only applies on hybrid hubs."""
    mode = _network_viewer_mode()
    return {
        "network_viewer_mode": mode,
        "show_block_tor_peers": mode == "hybrid",
        "show_block_http_only_peers": mode in ("hybrid", "clearnet"),
        "block_tor_peers_applicable": mode == "hybrid",
    }


def _public_server_view_for_client(server: dict) -> dict:
    """Public directory row for the SPA — Tor listings never expose clearnet IPs."""
    raw = dict(server or {})
    tor_listing = _is_tor_directory_listing(raw)
    if tor_listing:
        public = _public_server_view(raw, onion_only=True)
        public["tor_listing"] = True
        public["hybrid_listing"] = False
        return public
    public = _public_server_view(raw, onion_only=_tor_mode_enabled())
    public["tor_listing"] = False
    public["hybrid_listing"] = _is_hybrid_directory_listing(raw)
    return public


def _can_reach_onion_federation_peers() -> bool:
    """True when this node may push federation inbox traffic to .onion peers."""
    return _tor_mode_enabled() or _hybrid_node_enabled()


def _select_peer_push_target(server: dict) -> str:
    """Outbound federation push URL — prefer clearnet inbox over Tor."""
    base = _normalize_base_url(str((server or {}).get("base_url") or ""))
    if base and not (_can_reach_onion_federation_peers() and _server_advertises_onion_only(server)):
        return base
    return _select_peer_target(server)


def _public_server_target(server: dict) -> str:
    onion_url = _normalize_base_url(str(server.get("onion_url") or ""))
    base_url = _normalize_base_url(str(server.get("base_url") or ""))
    if _is_tor_directory_listing(server):
        return onion_url or base_url
    if _server_advertises_onion_only(server):
        return onion_url or base_url
    return base_url or onion_url


_GENERIC_DIRECTORY_NAMES = frozenset({"frogtalk node"})


def _directory_row_rank(row: dict) -> tuple:
    """Higher is better when picking one row per public target."""
    name = (row.get("display_name") or "").strip().lower()
    generic = 0 if name in _GENERIC_DIRECTORY_NAMES or not name else 1
    region = 1 if (row.get("region") or "").strip() else 0
    official = 1 if row.get("official") else 0
    pubkey = 1 if (row.get("server_pubkey") or "").strip() else 0
    return (generic, region, official, pubkey, len(name))


def _dedupe_public_servers(rows: list[dict]) -> list[dict]:
    """One listing per clearnet/onion target; drop generic duplicate names."""
    by_key: dict[str, dict] = {}
    order: list[str] = []
    for s in rows:
        key = (_public_server_target(s) or s.get("server_id") or "").strip().rstrip("/").lower()
        if not key:
            continue
        if key not in by_key:
            by_key[key] = s
            order.append(key)
            continue
        if _directory_row_rank(s) > _directory_row_rank(by_key[key]):
            by_key[key] = s
    return [by_key[k] for k in order]


def prune_duplicate_federation_servers() -> int:
    """Delete extra DB rows that share the same public URL (keeps best display name)."""
    rows = db.list_federation_servers_admin(include_disabled=True)
    groups: dict[str, list[dict]] = {}
    for row in rows:
        view = _public_server_view(row)
        key = (_public_server_target(view) or row.get("server_id") or "").strip().rstrip("/").lower()
        if not key:
            continue
        groups.setdefault(key, []).append(row)
    removed = 0
    for group in groups.values():
        if len(group) < 2:
            continue
        group.sort(key=_directory_row_rank, reverse=True)
        for dup in group[1:]:
            if db.delete_federation_server(dup.get("server_id") or ""):
                removed += 1
                _log.info(
                    "federation: removed duplicate directory row %s (%s)",
                    dup.get("server_id"),
                    dup.get("display_name"),
                )
    return removed


def _resolved_server_region(server: dict) -> str:
    """GeoIP from clearnet base URL (fresh), else stored label, else Tor label.

    Directory rows used to keep a stale ``region`` (e.g. every hostname
    hard-coded to Spain in the SPA). Prefer live GeoIP so frogtalk.xyz (AU)
    and frogtalk.app (EU) can differ. Operators may still set
    ``FROGTALK_SERVER_REGION`` at register time; it is used when GeoIP fails.
    """
    if _server_advertises_onion_only(server) and str(server.get("onion_url") or "").strip():
        stored = str(server.get("region") or "").strip()
        return stored[:120] if stored else "Tor Hidden Service"
    base = _normalize_base_url(str(server.get("base_url") or ""))
    if base and ".onion" not in base:
        try:
            label = geoip.format_region_label(geoip.lookup_base_url(base))
            if label:
                return label[:120]
        except Exception:
            _log.debug("geo region resolve failed for %s", base, exc_info=True)
    stored = str(server.get("region") or "").strip()
    if stored:
        return stored[:120]
    return ""


def _public_server_view(server: dict, *, onion_only: bool | None = None) -> dict:
    public = dict(server)
    onion_url = _normalize_base_url(str(public.get("onion_url") or ""))
    base_url = _normalize_base_url(str(public.get("base_url") or ""))
    if onion_only is None:
        onion_only = _server_advertises_onion_only(public)
    public["onion_url"] = onion_url
    public["base_url"] = "" if (onion_only and onion_url) else base_url
    region = _resolved_server_region(public)
    if region:
        public["region"] = region
    return public


def _network_probe_status(target: str, result: dict) -> str:
    """Map probe result to UI-friendly status (not always hard down)."""
    if bool(result.get("ok")):
        return "healthy"
    err = str(result.get("error") or "").lower()
    if _url_uses_tor(target):
        return "tor_required"
    if "redirects not allowed" in err or "301" in err:
        return "redirect"
    if "cloudflare" in err or "challenge" in err or "edge/html" in err:
        return "edge_error"
    return "down"


def _probe_url(base_url: str, timeout_s: float = 1.2) -> dict:
    start = time.perf_counter()
    target = _normalize_base_url(base_url)
    if not target:
        return {"ok": False, "latency_ms": None, "error": "missing_base_url"}
    try:
        raw = _fetch_url_bytes(
            f"{target}/api/network/status",
            timeout_s=timeout_s,
            headers={"User-Agent": "FrogTalk-Probe/1.0"},
            method="GET",
        )
        text = raw.decode("utf-8", errors="replace")
        lower = text.lower()
        if text.startswith("<!doctype") or text.startswith("<html") or "cloudflare" in lower or "cf-ray" in lower:
            return {"ok": False, "latency_ms": None, "error": "edge/html challenge"}
        payload = json.loads(text)
        sid = str(((payload or {}).get("server") or {}).get("server_id") or "").strip()
        if not sid:
            return {"ok": False, "latency_ms": None, "error": "invalid status payload", "server_id": ""}
        ok = True
        latency_ms = int((time.perf_counter() - start) * 1000)
        return {"ok": ok, "latency_ms": latency_ms, "error": None if ok else "status_not_ok", "server_id": sid}
    except urllib.error.URLError as e:
        return {"ok": False, "latency_ms": None, "error": str(e.reason)}
    except Exception as e:
        return {"ok": False, "latency_ms": None, "error": str(e)}


def _local_web_build_info() -> dict:
    """Compute deterministic web bundle hash for legitimacy checks across servers."""
    root = Path(__file__).resolve().parent.parent
    files = [root / "static" / "index.html"]
    js_dir = root / "static" / "js"
    if js_dir.exists():
        files.extend(sorted(js_dir.glob("*.js"), key=lambda p: p.name.lower()))

    h = hashlib.sha256()
    for fp in files:
        if not fp.exists() or not fp.is_file():
            continue
        h.update(fp.name.encode("utf-8", errors="ignore"))
        with open(fp, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                h.update(chunk)

    version = os.getenv("FROGTALK_WEB_BUILD_VERSION", "web-pre-alpha")
    build_hash = h.hexdigest()
    official = db.is_official_build("web", version, build_hash)
    return {
        "platform": "web",
        "version": version,
        "build_hash": build_hash,
        "official": bool(official),
    }


def _get_update_feed_url() -> str:
    return (os.getenv("FROGTALK_UPDATE_FEED_URL", "https://frogtalk.app/api/network/updates/latest") or "").strip()


def _fetch_update_manifest(feed_url: str, timeout_s: float = 4.0) -> dict:
    raw = _fetch_url_bytes(
        feed_url,
        timeout_s=timeout_s,
        headers={"User-Agent": "FrogTalk-Updater/1.0", "Accept": "application/json"},
        method="GET",
    ).decode("utf-8", errors="replace")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("invalid update manifest")
    return payload


def _release_signer_pubkeys() -> list[str]:
    """Allowed Ed25519 PEM public keys for release-manifest verification.

    Configured via ``FROGTALK_RELEASE_SIGNERS`` — a semicolon-separated
    list of PEM blocks (newlines may be escaped as ``\\n``). Returns ``[]``
    when the env var is unset, which disables auto-apply verification.
    """
    raw = (os.getenv("FROGTALK_RELEASE_SIGNERS") or "").strip()
    if not raw:
        return []
    out: list[str] = []
    for chunk in raw.split(";"):
        chunk = chunk.strip().replace("\\n", "\n")
        if "BEGIN PUBLIC KEY" in chunk:
            out.append(chunk)
    return out


def _manifest_signature_ok(manifest: dict) -> tuple[bool, str]:
    """Verify the release manifest's Ed25519 signature.

    The manifest must contain ``signature`` (base64 Ed25519 signature)
    and either ``signed_payload`` (raw bytes/string that was signed) or
    fall back to the canonical JSON of the manifest minus the signature
    fields. Returns ``(ok, reason)``.
    """
    signers = _release_signer_pubkeys()
    if not signers:
        return False, "no_release_signers_configured"
    sig_b64 = str(manifest.get("signature") or manifest.get("manifest_signature") or "").strip()
    if not sig_b64:
        return False, "missing_signature"
    try:
        sig = base64.b64decode(sig_b64)
    except Exception:
        return False, "bad_signature_encoding"
    payload = manifest.get("signed_payload")
    if isinstance(payload, str) and payload:
        canonical = payload.encode("utf-8")
    else:
        # Canonicalize the manifest sans signature fields. Stable ordering
        # so the signer can reproduce it. Both sides must agree on this.
        clean = {k: v for k, v in manifest.items() if k not in {"signature", "manifest_signature", "signed_payload"}}
        canonical = json.dumps(clean, sort_keys=True, separators=(",", ":")).encode("utf-8")
    try:
        from cryptography.hazmat.primitives.serialization import load_pem_public_key
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        for pem in signers:
            try:
                pk = load_pem_public_key(pem.encode("utf-8"))
                if not isinstance(pk, Ed25519PublicKey):
                    continue
                pk.verify(sig, canonical)
                return True, "ok"
            except Exception:
                continue
        return False, "no_signer_verified"
    except Exception as exc:
        return False, f"verify_error:{exc}"


def _sha256_of_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _download_update_package(url: str, target_path: str, timeout_s: float = 15.0) -> None:
    # HIGH-12: the JSON cap (_FED_RESPONSE_MAX_JSON) would refuse most
    # legitimate release tarballs, so request the larger binary cap here.
    raw = _fetch_url_bytes(
        url,
        timeout_s=timeout_s,
        headers={"User-Agent": "FrogTalk-Updater/1.0"},
        method="GET",
        max_bytes=_FED_RESPONSE_MAX_BIN,
    )
    with open(target_path, "wb") as out:
        out.write(raw)


def _apply_package_archive(archive_path: str) -> dict:
    install_dir = (os.getenv("FROGTALK_INSTALL_DIR", "/opt/frogtalk") or "/opt/frogtalk").strip()
    service_name = (os.getenv("FROGTALK_SERVICE_NAME", "frogtalk") or "frogtalk").strip()

    work_dir = tempfile.mkdtemp(prefix="frogtalk-update-")
    try:
        shutil.unpack_archive(archive_path, work_dir)
        entries = [e for e in Path(work_dir).iterdir()]
        src_root = entries[0] if len(entries) == 1 and entries[0].is_dir() else Path(work_dir)
        # Defence-in-depth: a malicious update tarball could include an
        # absolute symlink or a top-level entry that resolves outside the
        # temp dir (zip-slip style). Refuse to rsync anything whose
        # resolved path escapes work_dir — combined with rsync --delete,
        # an escape would wipe arbitrary host files.
        try:
            work_real = Path(work_dir).resolve(strict=True)
            src_real = Path(src_root).resolve(strict=True)
            src_real.relative_to(work_real)
        except Exception:
            return {"ok": False, "error": "archive_path_escape"}
        rsync_cmd = [
            "rsync", "-a", "--delete",
            "--exclude", ".env",
            "--exclude", "data/",
            "--exclude", "venv/",
            "--exclude", ".venv/",
            f"{str(src_root).rstrip('/')}/",
            f"{install_dir.rstrip('/')}/",
        ]
        cp = subprocess.run(rsync_cmd, capture_output=True, text=True)
        if cp.returncode != 0:
            return {"ok": False, "error": f"rsync_failed: {cp.stderr.strip()}"}

        pip_bin = f"{install_dir.rstrip('/')}/venv/bin/pip"
        if Path(pip_bin).exists() and Path(f"{install_dir.rstrip('/')}/requirements.txt").exists():
            subprocess.run([pip_bin, "install", "-r", f"{install_dir.rstrip('/')}/requirements.txt"], capture_output=True, text=True)

        rc = subprocess.run(["systemctl", "restart", service_name], capture_output=True, text=True)
        if rc.returncode != 0:
            return {"ok": False, "error": f"restart_failed: {rc.stderr.strip()}"}
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def _check_update_once(auto_apply: bool = False) -> dict:
    feed_url = _get_update_feed_url()
    local = _local_web_build_info()
    now = str(int(time.time()))

    if not feed_url:
        return {"ok": False, "error": "update_feed_not_configured"}

    # Self-loop guard: if the configured feed URL points back at this very
    # server (the common case on the main site itself), skip the outbound
    # HTTPS round-trip. With a single uvicorn worker this would otherwise
    # deadlock the event loop on itself via nginx loopback. Read the local
    # feed config rows directly instead — semantically identical.
    try:
        from urllib.parse import urlparse as _urlparse
        feed_host = (_urlparse(feed_url).hostname or "").lower()
        own_hosts = {"127.0.0.1", "localhost", "::1"}
        try:
            local_ident = db.get_or_create_local_server_identity() or {}
            own_base = (local_ident.get("base_url") or "").strip()
            if own_base:
                own_hosts.add((_urlparse(own_base).hostname or "").lower())
        except Exception:
            pass
        env_host = (_urlparse(os.getenv("FROGTALK_PUBLIC_BASE_URL", "") or "").hostname or "").lower()
        if env_host:
            own_hosts.add(env_host)
        if feed_host and feed_host in own_hosts:
            latest = {
                "version": db.get_config("update.feed.version") or "",
                "package_url": db.get_config("update.feed.package_url") or "",
                "package_sha256": db.get_config("update.feed.package_sha256") or "",
                "build_hash": db.get_config("update.feed.build_hash") or "",
                "notes": db.get_config("update.feed.notes") or "",
                "published_at": db.get_config("update.feed.published_at") or "",
            }
            db.set_config("update.last_checked_at", now)
            db.set_config("update.last_error", "")
            return {
                "ok": True,
                "feed_url": feed_url,
                "local": local,
                "latest": latest,
                "update_available": False,
                "applied": None,
                "self_loop_skipped": True,
            }
    except Exception:
        pass

    try:
        latest = _fetch_update_manifest(feed_url)
    except Exception as e:
        db.set_config("update.last_checked_at", now)
        db.set_config("update.last_error", str(e))
        return {"ok": False, "error": str(e), "local": local}

    latest_hash = str(latest.get("build_hash") or "").strip().lower()
    local_hash = str(local.get("build_hash") or "").strip().lower()
    update_available = bool(latest_hash and local_hash and latest_hash != local_hash)

    db.set_config("update.last_checked_at", now)
    db.set_config("update.last_error", "")
    db.set_config("update.latest.version", str(latest.get("version") or ""))
    db.set_config("update.latest.package_url", str(latest.get("package_url") or ""))
    db.set_config("update.latest.package_sha256", str(latest.get("package_sha256") or ""))
    db.set_config("update.latest.build_hash", str(latest.get("build_hash") or ""))
    db.set_config("update.available", "1" if update_available else "0")

    applied = None
    if update_available and auto_apply:
        # CRIT-3: require a verified Ed25519 manifest signature before
        # we ever overwrite the install. Operators who haven't set up
        # FROGTALK_RELEASE_SIGNERS yet get a noisy log + no apply, never
        # a silent rollback into a poisoned tarball.
        sig_ok, sig_reason = _manifest_signature_ok(latest)
        if not sig_ok:
            db.set_config("update.last_apply_at", str(int(time.time())))
            db.set_config("update.last_apply_status", f"unsigned:{sig_reason}")
            _log.warning(
                "Auto-update refused: manifest signature check failed (%s). "
                "Set FROGTALK_RELEASE_SIGNERS or apply manually.", sig_reason,
            )
            return {
                "ok": True,
                "feed_url": feed_url,
                "local": local,
                "latest": latest,
                "update_available": update_available,
                "applied": {"ok": False, "error": f"unsigned_manifest:{sig_reason}"},
            }

        # Downgrade guard: refuse to apply if the manifest version is
        # older than what's currently installed (string compare on
        # semver-ish "x.y.z"). Same-version reapplies are still allowed
        # for legitimate hash-only rebuilds.
        try:
            cur_v = tuple(int(x) for x in str(local.get("version") or "0").split(".")[:3])
            new_v = tuple(int(x) for x in str(latest.get("version") or "0").split(".")[:3])
            if new_v < cur_v:
                db.set_config("update.last_apply_at", str(int(time.time())))
                db.set_config("update.last_apply_status", "downgrade_blocked")
                _log.warning("Auto-update refused: manifest version %s is older than installed %s", new_v, cur_v)
                return {
                    "ok": True,
                    "feed_url": feed_url,
                    "local": local,
                    "latest": latest,
                    "update_available": update_available,
                    "applied": {"ok": False, "error": "downgrade_blocked"},
                }
        except Exception:
            pass

        pkg_url = str(latest.get("package_url") or "").strip()
        pkg_sha = str(latest.get("package_sha256") or "").strip().lower()
        if pkg_url and pkg_sha:
            # Use NamedTemporaryFile(delete=False) rather than the
            # deprecated tempfile.mktemp(): mktemp returns a path without
            # creating the file, leaving a TOCTOU race where a local
            # attacker can pre-create the path as a symlink before we
            # open it. NamedTemporaryFile opens with O_EXCL atomically.
            _tmpf = tempfile.NamedTemporaryFile(
                prefix="frogtalk-update-", suffix=".tar.gz", delete=False
            )
            tmp = _tmpf.name
            _tmpf.close()
            try:
                _download_update_package(pkg_url, tmp)
                got_sha = _sha256_of_file(tmp).lower()
                if got_sha != pkg_sha:
                    applied = {"ok": False, "error": "sha256_mismatch"}
                else:
                    applied = _apply_package_archive(tmp)
            except Exception as e:
                applied = {"ok": False, "error": str(e)}
            finally:
                try:
                    os.remove(tmp)
                except Exception:
                    pass
            db.set_config("update.last_apply_at", str(int(time.time())))
            db.set_config("update.last_apply_status", "ok" if applied and applied.get("ok") else (applied or {}).get("error", "failed"))

    return {
        "ok": True,
        "feed_url": feed_url,
        "local": local,
        "latest": latest,
        "update_available": update_available,
        "applied": applied,
    }


def _fed_token_ok(token: str | None) -> bool:
    expected = os.getenv("FROGTALK_FEDERATION_TOKEN", "").strip()
    if not expected:
        return False
    # Constant-time compare to avoid leaking the federation token via
    # timing differences on the per-request token check (high-volume
    # inbox traffic makes timing oracles practical otherwise).
    import hmac as _hmac
    return _hmac.compare_digest((token or "").strip(), expected)


# ── SECURITY-PASS-2: per-peer signed-request auth ──────────────────────────
#
# Wrapper around `crypto_fed.verify_signed_request` that handles:
#   * mode gating (FROGTALK_FEDERATION_AUTH_MODE = dual | signed | legacy)
#   * DB pubkey lookup (cached per process; refreshed on miss)
#   * legacy bearer fallback
#
# Returns (ok, peer_id_or_None, reason_or_None).
#
# Callers should treat `peer_id` as authenticated identity ONLY when
# `ok` is True AND `peer_id` is not None. (legacy bearer path returns
# (True, None, "legacy_bearer") so the caller can decide whether to
# accept anonymous peers for that specific route.)
async def authenticate_federation_request(
    request: Request,
    body: bytes,
    x_federation_token: str | None,
) -> tuple[bool, str | None, str | None]:
    """Authenticate an inbound federation request under any supported
    auth mode. Reads the request method + path + headers itself, so the
    route handler only has to call this once per request.

    `body` MUST be the raw request body bytes (after Starlette parsing
    has consumed it, you need to pass the cached bytes — see
    `_read_body_bytes_once` helper below).
    """
    mode = crypto_fed.federation_auth_mode()
    method = (request.method or "POST").upper()
    path = request.url.path or ""
    headers = dict(request.headers)

    # 1. Try signed path (always allowed unless mode == 'legacy').
    if mode in ("dual", "signed"):
        ok, peer_id, reason = await asyncio.to_thread(
            crypto_fed.verify_signed_request,
            method,
            path,
            body,
            headers,
            db.get_federation_server_pubkey,
        )
        if ok:
            return True, peer_id, None
        # In strict 'signed' mode, never fall back to bearer.
        if mode == "signed":
            return False, peer_id, reason or "signature_required"
        # In 'dual', refuse bearer fallback only when the peer clearly
        # attempted a real signature that failed. ``unknown_peer`` means
        # the receiver has not pinned our server_id yet — outbound pushes
        # must still work via the shared federation token during rollout.
        _NO_BEARER_FALLBACK = frozenset({
            "bad_signature",
            "bad_signature_b64",
            "body_hash_mismatch",
            "replay",
            "stale_timestamp",
            "bad_timestamp",
            "verify_error",
            "not_ed25519",
            "bad_peer_pubkey",
        })
        if peer_id and reason and reason in _NO_BEARER_FALLBACK:
            return False, peer_id, reason

    # 2. Legacy bearer fallback (dual or legacy mode).
    if mode in ("dual", "legacy") and _fed_token_ok(x_federation_token):
        return True, None, "legacy_bearer"

    return False, None, "auth_failed"


# Starlette consumes the body when it parses JSON into pydantic; cache the
# raw body once on the request state so verify_signed_request can see the
# exact bytes we received. This is wired in via dependency in the routes
# that need signed verification.
async def _read_body_bytes_once(request: Request) -> bytes:
    cached = getattr(request.state, "_raw_body", None)
    if cached is not None:
        return cached
    raw = await request.body()
    request.state._raw_body = raw
    return raw


async def _current_user_from_header(x_session_token: str | None) -> dict | None:
    # Threadpool-hop so the sync sqlite lookup doesn't block the event
    # loop on hot federation routes (peer ping, build verify, etc.
    # all call this on every request).
    if not x_session_token:
        return None
    return await asyncio.to_thread(db.get_user_by_token, x_session_token)


def _load_directory_entries(
    directory_url: str,
    timeout_s: float = 8.0,
    *,
    retries: int = 3,
) -> list[dict]:
    """Fetch official server directory with bounded retries."""
    last_err: Exception | None = None
    attempts = max(1, int(retries or 1))
    for attempt in range(attempts):
        try:
            raw = _fetch_url_bytes(
                directory_url,
                timeout_s=timeout_s,
                headers={
                    "User-Agent": "FrogTalk-DirectorySync/1.0",
                    "Accept": "application/json",
                },
                method="GET",
            ).decode("utf-8", errors="replace")
            stripped = raw.strip()
            if not stripped:
                raise RuntimeError(
                    "official directory returned an empty response "
                    "(check FROGTALK_OFFICIAL_DIRECTORY_URL — the hub may be down)"
                )
            try:
                payload = json.loads(stripped)
            except json.JSONDecodeError:
                snippet = stripped[:80].replace("\n", " ").replace("\r", " ")
                raise RuntimeError(
                    "official directory returned a non-JSON response "
                    f"(HTTP error page or wrong URL); starts with: {snippet!r}"
                )
            if isinstance(payload, list):
                return [p for p in payload if isinstance(p, dict)]
            if isinstance(payload, dict):
                servers = payload.get("servers")
                if isinstance(servers, list):
                    return [p for p in servers if isinstance(p, dict)]
            return []
        except Exception as e:
            last_err = e
            if attempt + 1 < attempts:
                time.sleep(min(4.0, 1.0 * (attempt + 1)))
    if last_err is not None:
        raise last_err
    return []


def _coerce_server_row(item: dict) -> dict | None:
    server_id = str(item.get("server_id") or item.get("id") or "").strip()
    base_url = _normalize_base_url(str(item.get("base_url") or item.get("url") or "").strip())
    onion_url = str(item.get("onion_url") or item.get("onion") or "").strip()
    if not server_id or not (base_url or onion_url):
        return None
    display_name = str(item.get("display_name") or item.get("name") or server_id).strip()
    region = str(item.get("region") or "").strip()
    server_pubkey = str(item.get("server_pubkey") or item.get("pubkey") or "").strip()
    caps = item.get("capabilities")
    if not isinstance(caps, list):
        caps = []
    return {
        "server_id": server_id,
        "display_name": display_name,
        "base_url": base_url,
        "onion_url": onion_url,
        "region": region,
        "server_pubkey": server_pubkey,
        "capabilities": [str(c).strip() for c in caps if str(c).strip()],
    }


def official_directory_register_url(directory_url: str) -> str:
    """Derive hub register endpoint from the official directory feed URL."""
    url = (directory_url or "").strip().rstrip("/")
    if not url:
        return ""
    if url.endswith("/servers/register"):
        return url
    if url.endswith("/servers"):
        return f"{url}/register"
    return f"{url}/register"


def _url_hostname(url: str) -> str:
    try:
        return (urllib.parse.urlparse(url).hostname or "").strip().lower()
    except Exception:
        return ""


def _register_urls_same_hub(register_url: str, directory_url: str) -> bool:
    """SSRF guard: register target must match the configured directory host."""
    try:
        reg = urllib.parse.urlparse(register_url)
        direc = urllib.parse.urlparse(directory_url)
    except Exception:
        return False
    if (reg.scheme or "").lower() != (direc.scheme or "").lower():
        return False
    return _url_hostname(register_url) == _url_hostname(directory_url) and bool(_url_hostname(register_url))


def _is_public_register_base_url(base_url: str) -> bool:
    """Clearnet URL suitable for listing on the official directory."""
    base = _normalize_base_url(base_url)
    if not base.startswith(("http://", "https://")):
        return False
    host = _url_hostname(base)
    if not host or host in ("localhost", "127.0.0.1", "::1"):
        return False
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_loopback or ip.is_private or ip.is_link_local:
            return False
    except ValueError:
        pass
    return True


def _local_register_payload() -> dict | None:
    local = db.get_or_create_local_server_identity()
    server_id = (local.get("server_id") or "").strip()
    if not server_id:
        return None
    base_url = _normalize_base_url(
        os.getenv("PUBLIC_URL")
        or os.getenv("FROGTALK_BASE_URL")
        or local.get("base_url")
        or ""
    )
    onion_url = (
        os.getenv("FROGTALK_ONION_URL")
        or local.get("onion_url")
        or db.get_config("federation.onion_url")
        or ""
    ).strip().rstrip("/")
    display_name = (
        os.getenv("FROGTALK_SERVER_NAME", "").strip()
        or local.get("display_name")
        or db.get_config("federation.display_name")
        or "FrogTalk Node"
    ).strip()
    pubkey = (
        db.get_federation_server_pubkey(server_id)
        or (db.get_config("federation.signing.pubkey_pem") or "").strip()
    )
    region = (os.getenv("FROGTALK_SERVER_REGION") or "").strip()
    if not region and base_url:
        try:
            region = geoip.format_region_label(geoip.lookup_base_url(base_url))
        except Exception:
            region = ""
    from fed_turn import local_turn_public_view

    turn_pub = local_turn_public_view()
    return {
        "server_id": server_id,
        "display_name": display_name[:120] or server_id,
        "base_url": base_url,
        "onion_url": onion_url if onion_url.startswith("http") else "",
        "region": region[:64],
        "official": False,
        "trust_tier": "community",
        "server_pubkey": pubkey,
        "capabilities": ["federation-v1"],
        "turn_urls": turn_pub.get("turn_urls") or [],
        "turn_username": turn_pub.get("turn_username") or "",
        "turn_credential": turn_pub.get("turn_credential") or "",
    }


def _directory_lists_server_id(directory_url: str, server_id: str, timeout_s: float = 12.0) -> bool:
    try:
        entries = _load_directory_entries(directory_url, timeout_s=timeout_s, retries=2)
    except Exception:
        return False
    want = (server_id or "").strip()
    for item in entries:
        sid = str(item.get("server_id") or item.get("id") or "").strip()
        if sid == want:
            return True
    return False


def announce_local_server_to_hub(
    register_url: str | None = None,
    federation_token: str | None = None,
    directory_url: str | None = None,
    *,
    verify_listing: bool = True,
    timeout_s: float = 15.0,
) -> dict:
    """POST this node's identity to the official hub directory (frogtalk.app by default).

    Called from ``node_federation_join.sh`` after local directory import. Requires
    the same ``FROGTALK_FEDERATION_TOKEN`` on this node and on the hub.
    """
    direc = (directory_url or os.getenv("FROGTALK_OFFICIAL_DIRECTORY_URL", "")).strip().rstrip("/")
    reg = (register_url or os.getenv("FROGTALK_OFFICIAL_DIRECTORY_REGISTER_URL", "")).strip().rstrip("/")
    if not reg and direc:
        reg = official_directory_register_url(direc)
    token = (federation_token if federation_token is not None else os.getenv("FROGTALK_FEDERATION_TOKEN", "")).strip()

    if not direc or not reg:
        return {"ok": False, "skipped": True, "registered": False, "verified": False, "error": "directory_url_not_set"}
    if not _register_urls_same_hub(reg, direc):
        return {"ok": False, "skipped": False, "registered": False, "verified": False, "error": "register_url_host_mismatch"}
    if not token:
        return {"ok": False, "skipped": True, "registered": False, "verified": False, "error": "federation_token_not_set"}

    payload = _local_register_payload()
    if not payload:
        return {"ok": False, "skipped": False, "registered": False, "verified": False, "error": "local_identity_missing"}

    base_url = payload.get("base_url") or ""
    if not _is_public_register_base_url(base_url):
        if (payload.get("onion_url") or "").startswith("http"):
            return {
                "ok": False,
                "skipped": True,
                "registered": False,
                "verified": False,
                "error": "no_public_base_url",
            }
        return {"ok": False, "skipped": False, "registered": False, "verified": False, "error": "invalid_public_url"}

    hub_host = _url_hostname(reg)
    local_host = _url_hostname(base_url)
    if hub_host and local_host and hub_host == local_host:
        return {
            "ok": True,
            "skipped": True,
            "registered": False,
            "verified": True,
            "error": "",
            "reason": "this_node_is_hub",
        }

    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "FrogTalk-DirectoryAnnounce/1.0",
        "X-Federation-Token": token,
    }
    try:
        raw = _fetch_url_bytes(reg, timeout_s=timeout_s, method="POST", headers=headers, data=body)
        resp = json.loads(raw.decode("utf-8", errors="replace"))
        if not isinstance(resp, dict) or not resp.get("ok"):
            err = "register_rejected"
            if isinstance(resp, dict) and resp.get("error"):
                err = str(resp.get("error"))[:200]
            return {"ok": False, "skipped": False, "registered": False, "verified": False, "error": err}
    except urllib.error.HTTPError as e:
        return {
            "ok": False,
            "skipped": False,
            "registered": False,
            "verified": False,
            "error": f"register_http_{e.code}",
        }
    except Exception:
        _log.exception("federation: hub register failed")
        return {"ok": False, "skipped": False, "registered": False, "verified": False, "error": "register_failed"}

    verified = False
    if verify_listing:
        verified = _directory_lists_server_id(direc, payload["server_id"], timeout_s=timeout_s)

    return {
        "ok": True,
        "skipped": False,
        "registered": True,
        "verified": verified,
        "error": "" if verified else "register_ok_verify_pending",
        "register_url": reg,
        "server_id": payload["server_id"],
        "display_name": payload["display_name"],
    }


async def sync_official_directory_once(directory_url: str | None = None) -> dict:
    url = (directory_url or os.getenv("FROGTALK_OFFICIAL_DIRECTORY_URL", "")).strip()
    if not url:
        return {"ok": False, "imported": 0, "skipped": 0, "error": "directory_url_not_set"}

    mesh_ensured = await asyncio.to_thread(ensure_official_mesh_peers)

    try:
        entries = await asyncio.to_thread(_load_directory_entries, url)
    except Exception as e:
        return {"ok": False, "imported": 0, "skipped": 0, "error": str(e)}

    imported = 0
    skipped = 0
    for item in entries:
        row = _coerce_server_row(item)
        if not row:
            skipped += 1
            continue
        region = row["region"] or _resolved_server_region(row)
        db.upsert_federation_server(
            server_id=row["server_id"],
            display_name=row["display_name"],
            base_url=row["base_url"],
            onion_url=row["onion_url"],
            region=region,
            official=True,
            trust_tier="official",
            server_pubkey=row["server_pubkey"],
            capabilities=row["capabilities"],
        )
        imported += 1

    tor_disabled = apply_tor_peer_blocks_if_enabled()
    http_disabled = apply_http_only_peer_blocks_if_enabled()
    try:
        pinned = await asyncio.to_thread(ensure_peer_pubkeys_pinned)
        if pinned:
            _log.info("federation: directory sync pinned %s peer pubkey(s)", pinned)
    except Exception:
        _log.exception("federation: ensure_peer_pubkeys_pinned after directory sync")
    db.set_config("federation.official_directory_last_sync", str(int(time.time())))
    pruned = prune_duplicate_federation_servers()
    return {
        "ok": True,
        "directory_url": url,
        "imported": imported,
        "skipped": skipped,
        "total": len(entries),
        "mesh_peers_ensured": mesh_ensured,
        "tor_peers_disabled": tor_disabled,
        "http_peers_disabled": http_disabled,
        "duplicates_pruned": pruned,
    }


async def sync_peer_channels_once() -> dict:
    """Pull each enabled peer's authoritative channel directory into our index.

    Push delivery (outbox) is best-effort and can stall between specific peer
    pairs (e.g. a Tor mirror that never sends, or a failing clearnet link). This
    pull makes the federated channel directory *converge*: every node fetches
    every peer's locally-homed public channels and mirrors them — including live
    member counts from the home node — regardless of push health.
    """
    local = db.get_or_create_local_server_identity() or {}
    local_sid = str(local.get("server_id") or "").strip()
    imported = 0
    peers = 0
    errors = 0
    for srv in db.list_federation_servers():
        sid = str(srv.get("server_id") or "").strip()
        if not sid or sid == local_sid:
            continue
        if not int(srv.get("enabled") or 0):
            continue
        target = _public_server_target(_public_server_view(srv))
        if not target:
            continue
        peers += 1
        try:
            raw = await asyncio.to_thread(
                _fetch_url_bytes,
                f"{target}/api/network/channels",
                timeout_s=8.0,
                headers={
                    "User-Agent": "FrogTalk-DirectorySync/1.0",
                    "Accept": "application/json",
                },
            )
            payload = json.loads(raw.decode("utf-8", errors="replace"))
        except Exception as e:
            errors += 1
            _log.debug("federation: channel pull from %s failed: %s", sid, e)
            continue
        # Trust the peer's own declaration of which server homes the channel,
        # but never let a peer claim to home a channel we are authoritative for.
        peer_base = _normalize_base_url(str(srv.get("base_url") or "")) or target
        for ch in (payload.get("channels") or [])[:500]:
            if not isinstance(ch, dict):
                continue
            name = _fed_room_name(ch.get("name"))
            if not name:
                continue
            home_sid = str(ch.get("home_server_id") or sid).strip() or sid
            if home_sid == local_sid:
                continue
            tags_raw = ch.get("tags_json")
            if tags_raw is None:
                tags_raw = ch.get("tags")
            if isinstance(tags_raw, list):
                tags_raw = json.dumps(tags_raw)
            ok = db.upsert_federation_channel_index(
                name,
                home_sid,
                description=_fed_clip(ch.get("description"), 512),
                directory_description=_fed_clip(ch.get("directory_description"), 1200),
                icon=_fed_clip(ch.get("icon"), _FED_AVATAR_MAX) or None,
                category=_fed_clip(ch.get("category"), 32),
                tags_json=str(tags_raw or "[]")[:2000],
                channel_type=str(ch.get("channel_type") or "text")[:16],
                channel_theme=str(ch.get("channel_theme") or "")[:20000],
                member_count=max(0, int(ch.get("member_count") or 0)),
                owner_nickname=_fed_nickname(ch.get("owner_nickname")) or "",
                owner_global_user_id=str(ch.get("owner_global_user_id") or "")[:64],
                home_base_url=str(ch.get("home_base_url") or peer_base)[:256],
                content_warning_enabled=int(ch.get("content_warning_enabled") or 0),
                content_warning_flags=int(ch.get("content_warning_flags") or 0) & db.CW_ALL,
            )
            if ok:
                imported += 1
    return {"ok": True, "peers": peers, "imported": imported, "errors": errors}


@router.get("/network/channels")
async def list_network_channels():
    """Authoritative public channels homed on this node (for peer pull sync)."""
    local = db.get_or_create_local_server_identity() or {}
    local_sid = str(local.get("server_id") or "").strip()
    base_url = _normalize_base_url(str(local.get("base_url") or ""))
    channels = []
    for c in db.get_local_homed_public_channels(local_sid):
        channels.append({
            "name": c.get("name"),
            "description": c.get("description") or "",
            "directory_description": c.get("directory_description") or "",
            "icon": c.get("icon") or "",
            "category": c.get("category") or "",
            "tags_json": c.get("tags") or "[]",
            "channel_type": c.get("channel_type") or "text",
            "channel_theme": c.get("channel_theme") or "",
            "member_count": int(c.get("member_count") or 0),
            "owner_nickname": c.get("owner_nickname") or "",
            "owner_global_user_id": c.get("owner_global_user_id") or "",
            "home_server_id": local_sid,
            "home_base_url": base_url,
            "content_warning_enabled": int(c.get("content_warning_enabled") or 0),
            "content_warning_flags": int(c.get("content_warning_flags") or 0),
        })
    return {"server_id": local_sid, "channels": channels}


@router.get("/network/status")
async def network_status():
    from fed_turn import federation_calls_enabled, local_turn_public_view

    local = db.get_or_create_local_server_identity()
    public = _public_server_view(local, onion_only=_tor_mode_enabled())
    # Expose the local node's federation signing pubkey so peer admins
    # can pin it when registering us. We never expose the private key.
    try:
        local_pubkey_pem = crypto_fed.get_local_public_key_pem()
        local_pubkey_fp = crypto_fed.get_local_public_key_fingerprint()
    except Exception:
        local_pubkey_pem = ""
        local_pubkey_fp = ""
    caps = list(public.get("capabilities") or [])
    if federation_calls_enabled() and "federation-calls-v1" not in caps:
        caps.append("federation-calls-v1")
    turn_view = local_turn_public_view()
    return {
        "server": {
            "server_id": public["server_id"],
            "display_name": public["display_name"],
            "base_url": public["base_url"],
            "onion_url": public["onion_url"],
            "federation_enabled": os.getenv("FROGTALK_FEDERATION_ENABLED", "0") in ("1", "true", "yes"),
            "federation_calls_enabled": federation_calls_enabled(),
            "tor_enabled": _tor_mode_enabled(),
            "federation_pubkey_pem": local_pubkey_pem,
            "federation_pubkey_fingerprint": local_pubkey_fp,
            "capabilities": caps,
            **turn_view,
        }
    }


@router.get("/ice-config")
async def ice_config(
    peer_server_id: str = "",
    current_user: dict = Depends(get_current_user),
):
    """Merged STUN/TURN for WebRTC (local node + optional peer home server).

    Authentication required: TURN credentials are valuable (a non-user can
    use them to relay arbitrary traffic and spend our bandwidth budget),
    so we never publish them to anonymous callers. Only signed-in users
    can fetch ICE config, and only for peer servers we actively federate
    with.
    """
    from fed_turn import local_turn_public_view, merge_ice_servers, parse_server_turn_json

    local = local_turn_public_view()
    peer_turn: dict = {"turn_urls": [], "turn_username": "", "turn_credential": ""}
    peer_sid = (peer_server_id or "").strip()
    if peer_sid:
        if not db.get_federation_server_pubkey(peer_sid):
            try:
                row0 = db.get_federation_server_row(peer_sid)
                if row0 and int(row0.get("enabled") or 0) == 1:
                    target = _select_peer_target(row0)
                    if target:
                        _try_pin_peer_pubkey_from_status_sync(peer_sid, target)
            except Exception:
                pass
        row = db.get_federation_server_row(peer_sid)
        if row and int(row.get("enabled") or 0) == 1:
            raw = row.get("turn_urls_json") or "[]"
            if isinstance(raw, str):
                peer_turn = parse_server_turn_json(raw)
    ice_servers = merge_ice_servers(local, peer_turn)
    merged_urls: list[str] = []
    for s in ice_servers:
        u = s.get("urls")
        if isinstance(u, list):
            merged_urls.extend(str(x) for x in u)
        elif u:
            merged_urls.append(str(u))
    return {
        "ice_servers": ice_servers or local.get("ice_servers") or [],
        "turn_urls": merged_urls,
    }


@router.get("/network/servers")
async def list_network_servers(request: Request, official_only: int = 0):
    ensure_official_mesh_peers()
    rows = [
        _public_server_view_for_client(row)
        for row in db.list_federation_servers(official_only=bool(official_only))
    ]
    local = db.get_or_create_local_server_identity()
    request_base = _normalize_base_url(str(request.base_url))
    local_base = _normalize_base_url(local.get("base_url") or request_base)
    local_public = _public_server_view_for_client({
        "server_id": local["server_id"],
        "display_name": local["display_name"],
        "base_url": local_base,
        "onion_url": local.get("onion_url") or "",
        "region": (os.getenv("FROGTALK_SERVER_REGION") or local.get("region") or "").strip(),
        "official": 1,
        "trust_tier": "official",
        "capabilities": ["federation-v1"],
        "enabled": 1,
        "last_seen": None,
    })
    local_target = _public_server_target(local_public)
    if local_target and not any((s.get("server_id") == local["server_id"] or _public_server_target(s) == local_target) for s in rows):
        rows.insert(0, local_public)
    tor_ids = federation_mesh.tor_mirror_server_ids()
    builtin_tor = _builtin_tor_mirror_directory_row()
    if _is_official_main_hub() and builtin_tor and not any(
        s.get("server_id") in tor_ids for s in rows
    ):
        rows.append(builtin_tor)
    rows = _filter_network_picker_servers(_dedupe_public_servers(rows))
    return {"servers": rows, "network_viewer_mode": _network_viewer_mode()}


@router.get("/network/verify")
async def verify_network_target(
    request: Request,
    target: str = "",
    timeout_ms: int = 2500,
):
    """Server-side reachability check for node switching.

    Browsers cannot cross-fetch arbitrary FrogTalk nodes (CSP connect-src),
    so the SPA calls this on the *current* node and we probe the target
    server-side — same path as /network/probe.
    """
    base = _normalize_base_url(str(target or "").strip())
    if not base:
        return JSONResponse(status_code=400, content={"ok": False, "error": "missing target"})
    here = _normalize_base_url(str(request.base_url))
    if here and base == here:
        local = db.get_or_create_local_server_identity()
        sid = str((local or {}).get("server_id") or "current").strip()
        return {"ok": True, "same_node": True, "server_id": sid}
    timeout_s = max(0.5, min(int(timeout_ms or 2500), 8000) / 1000.0)
    result = await asyncio.to_thread(_probe_url, base, timeout_s)
    if result.get("ok"):
        return {
            "ok": True,
            "same_node": False,
            "server_id": str(result.get("server_id") or "").strip(),
            "latency_ms": result.get("latency_ms"),
        }
    err = str(result.get("error") or "unreachable").strip()
    return {"ok": False, "error": err[:200]}


@router.get("/network/probe")
async def probe_network_servers(
    request: Request,
    official_only: int = 0,
    timeout_ms: int = 1200,
    include_onion: int = 0,
):
    timeout_ms = max(200, min(timeout_ms, 5000))
    servers = (await list_network_servers(request=request, official_only=official_only)).get("servers", [])

    async def probe_one(server: dict):
        if server.get("tor_listing") and server.get("onion_url"):
            target = _normalize_base_url(str(server.get("onion_url") or ""))
        elif include_onion and server.get("onion_url"):
            target = _normalize_base_url(str(server.get("onion_url") or ""))
        else:
            target = _public_server_target(server)
        result = await asyncio.to_thread(_probe_url, target, timeout_ms / 1000.0)
        probe_status = _network_probe_status(target, result)
        return {
            **server,
            "probe_target": target,
            "healthy": bool(result.get("ok")),
            "probe_status": probe_status,
            "latency_ms": result.get("latency_ms"),
            "probe_error": result.get("error"),
        }

    probed = await asyncio.gather(*[probe_one(s) for s in servers]) if servers else []
    probed.sort(key=lambda s: (not s.get("healthy"), s.get("latency_ms") or 999999, -(s.get("official") or 0)))
    return {"servers": probed}


@router.get("/network/auto-select")
async def auto_select_network_server(
    request: Request,
    official_only: int = 1,
    prefer_tor: int = 0,
    timeout_ms: int = 1200,
):
    probe = await probe_network_servers(
        request=request,
        official_only=official_only,
        timeout_ms=timeout_ms,
        include_onion=prefer_tor,
    )
    candidates = probe.get("servers", [])

    def score(s: dict) -> float:
        if not s.get("healthy"):
            return -1_000_000
        latency = s.get("latency_ms") or 999999
        official_bonus = 100 if (s.get("official") or 0) else 0
        trust_bonus = 40 if s.get("trust_tier") == "official" else (15 if s.get("trust_tier") == "community" else 0)
        tor_bonus = 20 if (prefer_tor and s.get("onion_url")) else 0
        return official_bonus + trust_bonus + tor_bonus - (latency / 10.0)

    healthy = [c for c in candidates if c.get("healthy")]
    if not healthy:
        return {"selected": None, "candidates": candidates}

    selected = max(healthy, key=score)
    return {"selected": selected, "candidates": candidates}


@router.get("/network/build/local")
async def network_local_build_status():
    """Return local web bundle hash and official status for trust UI."""
    return _local_web_build_info()


@router.post("/network/build/verify-peers")
async def network_verify_peer_builds(
    body: PeerBuildVerifyBody,
    x_session_token: str | None = Header(default=None),
):
    """Verify peer server bundle hash matches this server's current web build."""
    current_user = await _current_user_from_header(x_session_token)
    if not current_user:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})

    local = _local_web_build_info()
    local_hash = local.get("build_hash") or ""

    seen = set()
    targets: list[str] = []
    for raw in body.base_urls or []:
        url = _normalize_base_url(raw)
        if not url or url in seen:
            continue
        seen.add(url)
        targets.append(url)

    # Detect the server's own public base URL to short-circuit loopback requests.
    # Prefer explicit env vars, then fall back to persisted federation identity.
    own_public = ""
    if not own_public:
        try:
            local_ident = db.get_or_create_local_server_identity() or {}
            own_public = _public_server_target(
                _public_server_view(local_ident, onion_only=_tor_mode_enabled())
            ).rstrip("/").lower()
        except Exception:
            own_public = ""

    results = []
    for base in targets:
        entry = {
            "base_url": base,
            "reachable": False,
            "same_hash": False,
            "remote_hash": "",
            "remote_version": "",
            "remote_official": False,
            "error": None,
        }
        # If the peer URL points at this server itself, skip the outbound
        # HTTP round-trip (which loopbacks through nginx and often times out)
        # and just reuse the already-computed local build info directly.
        is_self = bool(own_public and base.rstrip("/").lower() == own_public)
        if not is_self:
            # Also treat 127.0.0.1 / localhost targets as self.
            try:
                from urllib.parse import urlparse as _up
                _h = _up(base).hostname or ""
                is_self = _h in ("127.0.0.1", "::1", "localhost")
            except Exception:
                pass
        if is_self:
            entry["reachable"] = True
            entry["remote_hash"] = local_hash
            entry["remote_version"] = local.get("version") or ""
            entry["remote_official"] = bool(local.get("official"))
            entry["same_hash"] = True
            results.append(entry)
            continue
        try:
            raw = _fetch_url_bytes(
                f"{base}/api/network/build/local",
                timeout_s=5.0,
                headers={"User-Agent": "FrogTalk-BuildVerify/1.0", "Accept": "application/json"},
                method="GET",
            ).decode("utf-8", errors="replace")
            payload = json.loads(raw)
            remote_hash = str(payload.get("build_hash") or "")
            entry["reachable"] = True
            entry["remote_hash"] = remote_hash
            entry["remote_version"] = str(payload.get("version") or "")
            entry["remote_official"] = bool(payload.get("official"))
            entry["same_hash"] = bool(local_hash and remote_hash and remote_hash == local_hash)
        except Exception as e:
            entry["error"] = str(e)
        results.append(entry)

    return {
        "local": local,
        "results": results,
    }


def run_update_check_background() -> dict:
    """Used by app background task for fleet update sync.

    CRIT-3: Auto-apply is now opt-in. The release manifest is not yet
    publisher-signed, so a compromised feed could otherwise hand every
    auto-updating node a malicious package whose SHA-256 matches what
    the feed itself supplied. Operators who want hands-off updates must
    explicitly set ``FROGTALK_AUTO_UPDATE_ENABLED=1`` *and*, once the
    signed-manifest path lands, configure ``FROGTALK_RELEASE_SIGNERS``.
    """
    auto = (os.getenv("FROGTALK_AUTO_UPDATE_ENABLED", "0") or "0").strip().lower() in ("1", "true", "yes")
    return _check_update_once(auto_apply=auto)


@router.get("/network/updates/latest")
async def network_updates_latest():
    """Main site release feed consumed by federation servers."""
    return {
        "version": db.get_config("update.feed.version") or "",
        "package_url": db.get_config("update.feed.package_url") or "",
        "package_sha256": db.get_config("update.feed.package_sha256") or "",
        "build_hash": db.get_config("update.feed.build_hash") or "",
        "notes": db.get_config("update.feed.notes") or "",
        "published_at": db.get_config("update.feed.published_at") or "",
    }


@router.post("/network/updates/publish")
async def network_updates_publish(
    body: UpdatePublishBody,
    x_session_token: str | None = Header(default=None),
):
    """Publish release metadata on main site for all federation nodes."""
    current_user = await _current_user_from_header(x_session_token)
    if not (current_user and current_user.get("is_admin")):
        return JSONResponse(status_code=403, content={"error": "Admin required"})

    db.set_config("update.feed.version", body.version.strip())
    db.set_config("update.feed.package_url", body.package_url.strip())
    db.set_config("update.feed.package_sha256", body.package_sha256.strip().lower())
    db.set_config("update.feed.build_hash", body.build_hash.strip().lower())
    db.set_config("update.feed.notes", body.notes.strip())
    db.set_config("update.feed.published_at", datetime.utcnow().isoformat() + "Z")
    return {"ok": True}


@router.get("/network/update/status")
async def network_update_status():
    local = _local_web_build_info()
    latest = {
        "version": db.get_config("update.latest.version") or "",
        "package_url": db.get_config("update.latest.package_url") or "",
        "package_sha256": db.get_config("update.latest.package_sha256") or "",
        "build_hash": db.get_config("update.latest.build_hash") or "",
    }
    return {
        "feed_url": _get_update_feed_url(),
        "auto_update_enabled": (os.getenv("FROGTALK_AUTO_UPDATE_ENABLED", "0") or "0").strip().lower() in ("1", "true", "yes"),
        "local": local,
        "latest": latest,
        "update_available": (db.get_config("update.available") or "0") == "1",
        "last_checked_at": db.get_config("update.last_checked_at") or "",
        "last_error": db.get_config("update.last_error") or "",
        "last_apply_at": db.get_config("update.last_apply_at") or "",
        "last_apply_status": db.get_config("update.last_apply_status") or "",
    }


@router.post("/network/update/check")
async def network_update_check(
    x_session_token: str | None = Header(default=None),
):
    current_user = await _current_user_from_header(x_session_token)
    if not (current_user and current_user.get("is_admin")):
        return JSONResponse(status_code=403, content={"error": "Admin required"})
    return _check_update_once(auto_apply=False)


@router.post("/network/update/apply")
async def network_update_apply(
    body: UpdateApplyBody,
    x_session_token: str | None = Header(default=None),
):
    current_user = await _current_user_from_header(x_session_token)
    if not (current_user and current_user.get("is_admin")):
        return JSONResponse(status_code=403, content={"error": "Admin required"})
    status = _check_update_once(auto_apply=True)
    if not status.get("ok"):
        return JSONResponse(status_code=400, content=status)
    if status.get("applied") and not status["applied"].get("ok"):
        return JSONResponse(status_code=400, content=status)
    return status


@router.post("/network/servers/register")
async def register_network_server(
    body: ServerRegisterBody,
    x_federation_token: str | None = Header(default=None),
    x_session_token: str | None = Header(default=None),
):
    """Register / upsert a federated peer.

    HIGH-11: ``official`` and ``trust_tier`` may only be set by a local
    admin. A bearer of the shared ``FROGTALK_FEDERATION_TOKEN`` (every
    peer holds one) could otherwise mark itself ``official=True``,
    ``trust_tier="gold"`` and ride the resulting UI badge to phish users.
    The token path still works for everything else — base URL, public key,
    capabilities — so genuine peer self-registration keeps working.
    """
    current_user = await _current_user_from_header(x_session_token)
    is_admin = bool(current_user and current_user.get("is_admin"))
    if not (is_admin or _fed_token_ok(x_federation_token)):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})

    official = bool(body.official) if is_admin else False
    trust_tier = (body.trust_tier or "") if is_admin else ""

    turn_json = json.dumps({
        "turn_urls": body.turn_urls or [],
        "turn_username": body.turn_username or "",
        "turn_credential": body.turn_credential or "",
    })
    reg_row = {
        "base_url": body.base_url,
        "onion_url": body.onion_url,
        "region": body.region,
    }
    region = (body.region or "").strip() or _resolved_server_region(reg_row)
    db.upsert_federation_server(
        server_id=body.server_id,
        display_name=body.display_name,
        base_url=body.base_url,
        onion_url=body.onion_url,
        region=region,
        official=official,
        trust_tier=trust_tier,
        server_pubkey=body.server_pubkey,
        capabilities=body.capabilities,
        turn_urls_json=turn_json,
        allow_pubkey_overwrite=is_admin,
    )
    prune_duplicate_federation_servers()
    return {"ok": True}


@router.post("/network/servers/sync-official")
async def sync_official_directory(
    x_federation_token: str | None = Header(default=None),
    x_session_token: str | None = Header(default=None),
):
    current_user = await _current_user_from_header(x_session_token)
    is_admin = bool(current_user and current_user.get("is_admin"))
    if not (is_admin or _fed_token_ok(x_federation_token)):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})
    result = await sync_official_directory_once()
    if not result.get("ok"):
        return JSONResponse(status_code=400, content=result)
    return result


@router.get("/federation/rooms/{room_name}/music-queue")
async def federation_room_music_queue(
    room_name: str,
    x_federation_token: str | None = Header(default=None),
):
    """Inter-node pull: current music queue + shared playhead for a room."""
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation auth"})
    name = str(room_name or "").strip().lower()
    if not name:
        return JSONResponse(status_code=400, content={"error": "bad_room_name"})
    room = db.get_room_by_name(name)
    if not room:
        return JSONResponse(status_code=404, content={"error": "room_not_found"})
    if not _room_snapshot_authoritative(room):
        return JSONResponse(status_code=403, content={"error": "not_authoritative"})
    payload = _music_queue_snapshot_payload(name)
    if not payload:
        return JSONResponse(status_code=404, content={"error": "empty_queue"})
    return payload


@router.get("/federation/signal/bundle/{global_user_id}")
async def federation_signal_bundle_by_gid(
    global_user_id: str,
    x_federation_token: str | None = Header(default=None),
):
    """Inter-node prekey fetch for cross-node DM encryption (consumes one OTPK)."""
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation auth"})
    gid = str(global_user_id or "").strip()
    if not gid:
        return JSONResponse(status_code=400, content={"error": "bad_global_user_id"})
    with db._conn() as con:
        row = con.execute(
            "SELECT id FROM users WHERE global_user_id=? LIMIT 1",
            (gid,),
        ).fetchone()
    if not row:
        return JSONResponse(status_code=404, content={"error": "user_not_found"})
    uid = int(row["id"])
    from routers.signal import (
        _peer_signal_bundle_is_remote,
        fetch_peer_bundle_from_home_sync,
        bundle_api_dict,
    )

    if await run_in_threadpool(_peer_signal_bundle_is_remote, uid):
        try:
            return await run_in_threadpool(fetch_peer_bundle_from_home_sync, uid)
        except ValueError as e:
            code = str(e).split(":", 1)[0]
            if code == "federation_token_missing":
                return JSONResponse(status_code=503, content={"error": "federation_not_configured"})
            if code in (
                "peer_bundle_circuit_open",
                "peer_bundle_inflight_timeout",
                "peer_bundle_slot_busy",
            ):
                return JSONResponse(
                    status_code=503,
                    content={"error": code},
                    headers={"Retry-After": "60"},
                )
            return JSONResponse(status_code=404, content={"error": code})
    bundle = await run_in_threadpool(db.signal_fetch_bundle, uid)
    if bundle is None:
        return JSONResponse(status_code=404, content={"error": "no_bundle"})
    return bundle_api_dict(uid, bundle)


@router.post("/federation/signal/nudge-publish/{global_user_id}")
async def federation_signal_nudge_publish(
    global_user_id: str,
    x_federation_token: str | None = Header(default=None),
):
    """Ask a federated user (if connected here) to publish Signal prekeys."""
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation auth"})
    gid = str(global_user_id or "").strip()
    if not gid:
        return JSONResponse(status_code=400, content={"error": "bad_global_user_id"})
    with db._conn() as con:
        row = con.execute(
            "SELECT id FROM users WHERE global_user_id=? LIMIT 1",
            (gid,),
        ).fetchone()
    if not row:
        return JSONResponse(status_code=404, content={"error": "user_not_found"})
    uid = int(row["id"])
    from ws_manager import manager

    delivered = await manager.send_to_user(
        uid,
        {"type": "signal_publish_keys", "reason": "peer_dm"},
    )
    return {"ok": True, "delivered": bool(delivered)}


@router.post("/federation/signal/dm-resync/{global_user_id}")
async def federation_signal_dm_resync(
    global_user_id: str,
    request: Request,
    x_federation_token: str | None = Header(default=None),
):
    """Deliver dm_crypto_resync to a federated user connected on this node."""
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation auth"})
    gid = str(global_user_id or "").strip()
    if not gid:
        return JSONResponse(status_code=400, content={"error": "bad_global_user_id"})
    try:
        body = await request.json()
    except Exception:
        body = {}
    with db._conn() as con:
        row = con.execute(
            "SELECT id FROM users WHERE global_user_id=? LIMIT 1",
            (gid,),
        ).fetchone()
    if not row:
        return JSONResponse(status_code=404, content={"error": "user_not_found"})
    uid = int(row["id"])
    from ws_manager import manager

    payload = {
        "type": "dm_crypto_resync",
        "from_id": int(body.get("from_id") or 0),
        "from_nickname": str(body.get("from_nickname") or ""),
        "from_global_user_id": str(body.get("from_global_user_id") or "").strip(),
    }
    delivered = await manager.send_to_user(uid, payload)
    return {"ok": True, "delivered": bool(delivered)}


@router.post("/federation/signal/dm-heal/{global_user_id}")
async def federation_signal_dm_heal(
    global_user_id: str,
    request: Request,
    x_federation_token: str | None = Header(default=None),
):
    """Deliver dm_crypto_heal to a federated user connected on this node."""
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation auth"})
    gid = str(global_user_id or "").strip()
    if not gid:
        return JSONResponse(status_code=400, content={"error": "bad_global_user_id"})
    try:
        body = await request.json()
    except Exception:
        body = {}
    with db._conn() as con:
        row = con.execute(
            "SELECT id FROM users WHERE global_user_id=? LIMIT 1",
            (gid,),
        ).fetchone()
    if not row:
        return JSONResponse(status_code=404, content={"error": "user_not_found"})
    uid = int(row["id"])
    from ws_manager import manager

    payload = {
        "type": "dm_crypto_heal",
        "from_id": int(body.get("from_id") or 0),
        "from_nickname": str(body.get("from_nickname") or ""),
        "from_global_user_id": str(body.get("from_global_user_id") or "").strip(),
    }
    delivered = await manager.send_to_user(uid, payload)
    return {"ok": True, "delivered": bool(delivered)}


@router.get("/federation/signal/identity/{global_user_id}")
async def federation_signal_identity_by_gid(
    global_user_id: str,
    x_federation_token: str | None = Header(default=None),
):
    """Inter-node identity pub fetch (does not consume OTPK)."""
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation auth"})
    gid = str(global_user_id or "").strip()
    if not gid:
        return JSONResponse(status_code=400, content={"error": "bad_global_user_id"})
    with db._conn() as con:
        row = con.execute(
            "SELECT id FROM users WHERE global_user_id=? LIMIT 1",
            (gid,),
        ).fetchone()
    if not row:
        return JSONResponse(status_code=404, content={"error": "user_not_found"})
    uid = int(row["id"])
    from routers.signal import (
        _peer_signal_bundle_is_remote,
        fetch_peer_identity_from_home_sync,
        _local_server_id,
    )
    import base64

    keys_sid = db.get_user_signal_keys_server_id(uid)
    if await run_in_threadpool(_peer_signal_bundle_is_remote, uid):
        b64 = await run_in_threadpool(fetch_peer_identity_from_home_sync, uid)
        if not b64:
            return JSONResponse(status_code=404, content={"error": "no_identity"})
        return {
            "user_id": uid,
            "global_user_id": gid,
            "identity_pub": b64,
            "keys_server_id": keys_sid or "",
        }
    ident = await run_in_threadpool(db.signal_get_identity_pub, uid)
    if ident is None:
        return JSONResponse(status_code=404, content={"error": "no_identity"})
    local_sid = _local_server_id()
    return {
        "user_id": uid,
        "global_user_id": gid,
        "identity_pub": base64.b64encode(bytes(ident)).decode("ascii"),
        "keys_server_id": keys_sid or local_sid,
    }


@router.get("/identity/me")
async def identity_me(x_session_token: str | None = Header(default=None)):
    current_user = await _current_user_from_header(x_session_token)
    if not current_user:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
    ident = db.get_user_identity(current_user["id"]) or {}
    return {
        "id": ident.get("id"),
        "nickname": ident.get("nickname"),
        "display_name": ident.get("display_name"),
        "global_user_id": ident.get("global_user_id"),
        "identity_pubkey": ident.get("identity_pubkey"),
    }


@router.put("/identity/me/pubkey")
async def set_identity_pubkey(
    body: IdentityPubKeyBody,
    x_session_token: str | None = Header(default=None),
):
    current_user = await _current_user_from_header(x_session_token)
    if not current_user:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
    pubkey = (body.identity_pubkey or "").strip()
    if len(pubkey) < 16 or len(pubkey) > 8192:
        return JSONResponse(status_code=400, content={"error": "Invalid identity_pubkey length"})
    db.set_identity_pub_key(current_user["id"], pubkey)
    return {"ok": True}


@router.get("/federation/profile-card")
async def federation_profile_card_public(
    global_user_id: str = "",
    nickname: str = "",
    home_server_id: str = "",
    refresh: int = 0,
    current_user: dict = Depends(get_current_user),
):
    """Session profile card (alias for ``/api/auth/federation/profile-card``)."""
    from routers.auth import build_federation_profile_card

    del current_user
    out = build_federation_profile_card(
        global_user_id=global_user_id,
        nickname=nickname,
        home_server_id=home_server_id,
        refresh=bool(int(refresh or 0)),
    )
    if out.get("error"):
        code = 400 if out.get("code") == "invalid_gid" else 404
        return JSONResponse(status_code=code, content=out)
    return out


@router.get("/identity/me/claim")
async def get_my_identity_claim(
    ttl_seconds: int = 3600,
    x_session_token: str | None = Header(default=None),
):
    current_user = await _current_user_from_header(x_session_token)
    if not current_user:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
    claim = db.build_signed_profile_claim(current_user["id"], ttl_seconds=ttl_seconds)
    if not claim:
        return JSONResponse(status_code=404, content={"error": "Identity not found"})
    return claim


@router.get("/identity/users/{user_id}/claim")
async def get_user_identity_claim(
    user_id: int,
    ttl_seconds: int = 3600,
    x_federation_token: str | None = Header(default=None),
):
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation token"})
    claim = db.build_signed_profile_claim(user_id, ttl_seconds=ttl_seconds)
    if not claim:
        return JSONResponse(status_code=404, content={"error": "Identity not found"})
    return claim


def _insert_inbox_events_sync(events: list[dict]) -> tuple[int, int]:
    accepted = 0
    rejected = 0
    # CRIT-2: default to *require* signatures. The shared
    # ``FROGTALK_FEDERATION_TOKEN`` is a bearer that lets a peer push events
    # claiming any ``origin_server_id``; without a pinned per-origin pubkey
    # + valid Ed25519 signature, a leaked token reduces the federation to
    # an unauthenticated injection bus. Operators who still need the old
    # behavior during a rolling upgrade can set
    # ``FROGTALK_FEDERATION_REQUIRE_SIGS=0`` explicitly.
    require_sigs = (os.getenv("FROGTALK_FEDERATION_REQUIRE_SIGS", "1").strip().lower()
                    in ("1", "true", "yes", "on"))
    # Events that mutate a SPECIFIC user's identity / inbox / social
    # graph. For these we ALWAYS require a pinned server key + a valid
    # Ed25519 signature, even when the global REQUIRE_SIGS soak flag
    # is off. Without this, a peer that simply holds the shared
    # federation token could forge "user.deleted" / "user.profile.updated"
    # / "dm.message.created" for any global_user_id and have the receiving
    # node act on it. The soak-mode allowance only stays open for less
    # sensitive room/sticker/bot replication traffic.
    _SENSITIVE_PREFIXES = (
        "user.",
        "dm.",
        "friend.",
        "social.",
        "call.",
        "voice.",
    )
    # Specific event types that MUST be signed even though their prefix
    # isn't in _SENSITIVE_PREFIXES. Room moderation events grant the
    # origin server the ability to silence a local account, so a peer
    # that only holds the shared federation token must not be able to
    # forge them.
    _SENSITIVE_TYPES = {
        "room.member.banned",
        "room.member.unbanned",
        # Lifecycle mutations need a signed origin so a peer that only
        # holds the shared token cannot forge a delete/edit for arbitrary
        # message ids.
        "message.deleted",
        "message.edited",
        # Members snapshot purges remote roster rows when origin matches
        # the room home; a forged origin must not be able to wipe rosters.
        "room.members.snapshot",
        "room.member.joined",
        "room.member.left",
        "channel.directory.updated",
        # Settings apply is gated on origin == channel home, so the origin must
        # be cryptographically authenticated (not spoofable in soak mode).
        "room.settings.updated",
        # Cross-node owner relay must be signed; nickname alone is not proof.
        "sticker.pack.owner.request",
        # A channel owner editing from a non-home node: the home node only
        # acts on it after verifying signature + owner-home + owner-gid, so it
        # must always carry a valid signature.
        "channel.owner.edit.request",
    }
    now = datetime.now(tz=timezone.utc)
    # Tightened from ±1h to ±5min after audit: an attacker who captures a
    # signed event has only a 5-minute window to replay it before our
    # clock-skew check rejects it. Peers running NTP have far less drift
    # than this, so legitimate traffic is unaffected.
    skew_seconds = 300    # ±5min max clock skew accepted
    grace_seconds = 60    # allow tiny re-orderings against the monotonic watermark

    for ev in events:
        origin = str(ev.get("origin_server_id") or "").strip()
        if not origin:
            rejected += 1
            continue
        _fed_policy = db.get_federation_policy_settings()
        if _fed_policy.get("block_tor_peers") or _fed_policy.get("block_http_only_peers"):
            origin_row = db.get_federation_server_row(origin)
            if origin_row:
                if _fed_policy.get("block_tor_peers") and peer_uses_tor_route(origin_row):
                    rejected += 1
                    continue
                if _fed_policy.get("block_http_only_peers") and peer_uses_http_only_clearnet(origin_row):
                    rejected += 1
                    continue
        # SECURITY-PASS-2: when the transport auth was per-peer signed
        # (request-level), bind the event to that peer. A peer that
        # signs the HTTP request must not be able to ship events
        # claiming a different origin_server_id — that would let a
        # less-trusted peer launder events through a more-trusted one.
        signed_peer = str(ev.get("_signed_peer_id") or "").strip()
        if signed_peer and signed_peer != origin:
            rejected += 1
            continue
        # Strip the transport-auth helper field before persisting so it
        # never lands in payload_json / replays.
        ev.pop("_signed_peer_id", None)
        _maybe_tofu_pin_origin_from_event(ev)
        ev.pop("origin_pubkey_pem", None)

        # ---- Time window check (replay defence, applies even without sigs) ----
        origin_time_str = str(ev.get("origin_time") or "").strip()
        if not origin_time_str:
            # Tolerate legacy peers that pre-date the outbox origin_time
            # column. Stamping with the current time keeps the monotonic
            # progression check meaningful while letting valid traffic
            # through during a rolling federation upgrade. The replay
            # window below still bounds out-of-skew clocks; this branch
            # is the only place where we synthesize a timestamp.
            origin_time_str = now.isoformat().replace("+00:00", "Z")
            ev["origin_time"] = origin_time_str
        try:
            # Normalize the "Z" suffix that enqueue_server_event emits;
            # fromisoformat in <3.11 doesn't accept it.
            ts = origin_time_str.replace("Z", "+00:00")
            origin_dt = datetime.fromisoformat(ts)
            if origin_dt.tzinfo is None:
                origin_dt = origin_dt.replace(tzinfo=timezone.utc)
        except Exception:
            rejected += 1
            continue
        if abs((now - origin_dt).total_seconds()) > skew_seconds:
            rejected += 1
            continue

        # ---- Monotonic progression per origin ----
        try:
            prev_max = db.get_federation_origin_max_time(origin)
            if prev_max:
                prev_ts = prev_max.replace("Z", "+00:00")
                prev_dt = datetime.fromisoformat(prev_ts)
                if prev_dt.tzinfo is None:
                    prev_dt = prev_dt.replace(tzinfo=timezone.utc)
                if (origin_dt - prev_dt).total_seconds() < -grace_seconds:
                    rejected += 1
                    continue
        except Exception:
            # On any parse error from prior watermark, fall through to
            # signature/dedup checks rather than reject; watermark gets
            # overwritten on success below.
            pass

        # ---- Ed25519 verification (when peer pubkey pinned) ----
        ev_type = str(ev.get("event_type") or "")
        sensitive = ev_type.startswith(_SENSITIVE_PREFIXES) or ev_type in _SENSITIVE_TYPES
        pubkey_pem = crypto_fed._normalize_pubkey_pem(
            db.get_federation_server_pubkey(origin) or ""
        )
        if pubkey_pem:
            # Fingerprint pinning: refuse the event if the signer
            # advertises a different key than the one we have on file
            # for this origin. This makes silent key rotation explicit
            # (admin must re-pin) and blocks cross-peer signature
            # replay where an attacker copies a valid signed event
            # from peer A and re-submits it claiming to come from
            # peer B.
            if not crypto_fed.verify_event(ev, pubkey_pem):
                rejected += 1
                continue
            claimed_fp = str(ev.get("signer_pubkey_fingerprint") or "").strip().lower()
            if claimed_fp:
                expected_fp = crypto_fed.fingerprint_for_pem(pubkey_pem).lower()
                if claimed_fp != expected_fp:
                    # Pre-2026-05-21 nodes hashed the config PEM including a
                    # trailing newline while TOFU pins strip whitespace.
                    legacy_fp = hashlib.sha256(
                        (pubkey_pem + "\n").encode("ascii")
                    ).hexdigest()[:32].lower()
                    if claimed_fp != legacy_fp:
                        _log.info(
                            "federation: signature ok but fingerprint drift "
                            "origin=%s type=%s",
                            origin, ev_type,
                        )
        elif sensitive:
            # Unsigned user/dm/friend/social events are NEVER trusted,
            # even in soak mode. A peer that only holds the shared
            # federation token must not be able to forge identity-
            # bearing events; the per-server Ed25519 key + an
            # administrator-pinned fingerprint is the user-attribution
            # anchor.
            _log.warning(
                "federation: dropping unsigned sensitive event type=%s origin=%s",
                ev_type, origin,
            )
            rejected += 1
            continue
        elif require_sigs:
            # No pinned key + strict mode = reject. We never trust a
            # signer pubkey supplied on the wire (TOFU is too dangerous
            # with federated bots).
            rejected += 1
            continue

        if db.insert_federation_inbox_event(ev):
            accepted += 1
            try:
                db.update_federation_origin_max_time(origin, origin_time_str)
            except Exception:
                _log.exception("failed to bump origin progress for %s", origin)
        else:
            rejected += 1
    return accepted, rejected


# ─── Federation payload validation ─────────────────────────────────────
# Untrusted peers can ship anything in event payloads. Every handler
# below pipes peer-supplied strings/blobs through these helpers before
# we hit the DB or fan out to local clients. The goals are:
#   * No HTML/script smuggling via media_type (data URLs in img/audio
#     tags would otherwise let a peer render arbitrary markup as if the
#     local user had attached it).
#   * No giant blobs (one peer shipping a multi-MB base64 per event
#     across a 1000-event batch is a storage-DoS vector).
#   * Bounded text fields so a peer can't blow up the messages or
#     federation_user_profiles tables.
#   * Whitelist names/room names so a peer can't poison the local
#     namespace with control characters or unicode lookalikes.
_FED_NAME_RE = re.compile(r"^[A-Za-z0-9._\- ]{1,32}$")
_FED_ROOM_RE = re.compile(r"^[A-Za-z0-9._\-]{1,64}$")
_FED_MEDIA_TYPE_RE = re.compile(r"^(image|video|audio)/[A-Za-z0-9.+\-]{1,40}$")
_FED_CONTENT_MAX = 8 * 1024              # 8 KiB room/dm body
_FED_MEDIA_DATA_MAX = 4 * 1024 * 1024    # 4 MiB raw (≈5.3 MiB base64)
# Stories ship their media INLINE in the federation event (no cross-node
# lazy-fetch path like wall posts have), so they need a higher cap or every
# camera photo / short clip drops on the receiving node. nginx allows a 50M
# inbox body, so a single ~16 MiB story event is well within budget.
_FED_STORY_MEDIA_DATA_MAX = 16 * 1024 * 1024
_FED_BIO_MAX = 1024
_FED_AVATAR_MAX = 256 * 1024
_FED_STATUS_MAX = 128
_FED_DISPLAY_MAX = 32
_FED_BANNER_MAX = 500_000
_FED_GLOBAL_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_FED_SOCIAL_CONTENT_MAX = 5000
_FED_SOCIAL_COMMENT_MAX = 4000
_FED_SOCIAL_QUOTE_MAX = 4000
_FED_SOCIAL_CAPTION_MAX = 500
_FED_SOCIAL_PRIVACY_REPLICATE = frozenset({"public", "followers"})
_FED_WALL_REACTION_EMOJIS = frozenset({
    "❤️", "👍", "😂", "😮", "😢", "🔥", "🐸", "👏", "💯", "✨",
    "🎉", "💪", "😍",
})


def _fed_clip(s, n: int) -> str:
    return str(s or "")[:n]


def _fed_nickname(s) -> str | None:
    """Return a safe nickname or None when input is missing/hostile."""
    raw = str(s or "").strip()
    return raw if _FED_NAME_RE.match(raw) else None


def _fed_global_id(s) -> str | None:
    raw = str(s or "").strip()
    return raw if _FED_GLOBAL_ID_RE.match(raw) else None


def _fed_sanitize_social_payload(event_type: str, payload: dict) -> dict | None:
    """Validate and bound an inbound FrogSocial federation payload."""
    p = dict(payload or {})
    et = str(event_type or "").strip()

    def _gid(key: str) -> str | None:
        return _fed_global_id(p.get(key))

    if et in ("social.post.created", "social.post.updated", "social.post.deleted"):
        gpid = _gid("global_post_id")
        if not gpid:
            return None
        p["global_post_id"] = gpid
        nick = _fed_nickname(p.get("nickname"))
        agid = _fed_global_id(p.get("author_global_user_id"))
        if not nick or not agid:
            return None
        p["nickname"] = nick
        p["author_global_user_id"] = agid
        if et == "social.post.created":
            priv = str(p.get("privacy") or "public").strip().lower()
            if priv not in _FED_SOCIAL_PRIVACY_REPLICATE:
                return None
            p["privacy"] = priv
            p["content"] = _fed_clip(p.get("content"), _FED_SOCIAL_CONTENT_MAX)
            mt = _fed_media_type(p.get("media_type"))
            if mt is None:
                p.pop("media_data", None)
                p.pop("media_type", None)
            else:
                md = _fed_media_data(p.get("media_data"))
                if md is None and p.get("media_data"):
                    return None
                p["media_type"] = mt
                p["media_data"] = md
            try:
                from routers.wall import _sanitize_track_room
                p["track_room"] = _sanitize_track_room(p.get("track_room"))
            except Exception:
                p["track_room"] = None
            p["track_title"] = _fed_clip(p.get("track_title"), 200) or None
            p["track_mood"] = _fed_clip(p.get("track_mood"), 64) or None
        elif et == "social.post.updated":
            if "content" in p and p.get("content") is not None:
                p["content"] = _fed_clip(p.get("content"), _FED_SOCIAL_CONTENT_MAX)
            if p.get("privacy") is not None:
                priv = str(p.get("privacy")).strip().lower()
                if priv not in _FED_SOCIAL_PRIVACY_REPLICATE:
                    p.pop("privacy", None)
                else:
                    p["privacy"] = priv
        p.pop("force_delete", None)
        return p

    if et == "social.post.created.encrypted":
        gpid = _gid("global_post_id")
        if not gpid:
            return None
        p["global_post_id"] = gpid
        nick = _fed_nickname(p.get("nickname"))
        agid = _fed_global_id(p.get("author_global_user_id"))
        if not nick or not agid:
            return None
        p["nickname"] = nick
        p["author_global_user_id"] = agid
        aud = str(p.get("audience") or "followers").strip().lower()
        if aud not in ("followers", "friends"):
            return None
        p["audience"] = aud
        ct = str(p.get("ciphertext_b64") or "").strip()
        if not ct or len(ct) > 512 * 1024:
            return None
        p["ciphertext_b64"] = ct
        wraps = []
        for w in (p.get("wrapped_keys") or [])[:512]:
            if not isinstance(w, dict):
                continue
            rgid = _fed_global_id(w.get("recipient_global_user_id"))
            wb = str(w.get("wrapped_b64") or "").strip()
            if not rgid or not wb or len(wb) > 8192:
                continue
            wraps.append({
                "recipient_global_user_id": rgid,
                "recipient_nickname": _fed_nickname(w.get("recipient_nickname")) or "",
                "wrapped_b64": wb,
            })
        if not wraps:
            return None
        p["wrapped_keys"] = wraps
        mt = _fed_media_type(p.get("media_type"))
        if mt is None:
            p.pop("media_data", None)
            p.pop("media_type", None)
        else:
            md = _fed_media_data(p.get("media_data"))
            if md is None and p.get("media_data"):
                return None
            p["media_type"] = mt
            p["media_data"] = md
        return p

    if et == "social.comment.created":
        gpid, gcid = _gid("global_post_id"), _gid("global_comment_id")
        if not gpid or not gcid:
            return None
        p["global_post_id"] = gpid
        p["global_comment_id"] = gcid
        actor_nick = _fed_nickname(p.get("actor_nickname"))
        actor_gid = _fed_global_id(p.get("actor_global_user_id"))
        owner_nick = _fed_nickname(p.get("owner_nickname"))
        if not actor_nick or not actor_gid or not owner_nick:
            return None
        p["actor_nickname"] = actor_nick
        p["actor_global_user_id"] = actor_gid
        p["owner_nickname"] = owner_nick
        p["content"] = _fed_clip(p.get("content"), _FED_SOCIAL_COMMENT_MAX)
        if not str(p.get("content") or "").strip():
            return None
        p.pop("actor_avatar", None)
        return p

    if et == "social.reaction.changed":
        gpid = _gid("global_post_id")
        if not gpid:
            return None
        p["global_post_id"] = gpid
        actor_nick = _fed_nickname(p.get("actor_nickname"))
        actor_gid = _fed_global_id(p.get("actor_global_user_id"))
        owner_nick = _fed_nickname(p.get("owner_nickname"))
        emoji = str(p.get("emoji") or "").strip()
        if not actor_nick or not actor_gid or not owner_nick or emoji not in _FED_WALL_REACTION_EMOJIS:
            return None
        p["actor_nickname"] = actor_nick
        p["actor_global_user_id"] = actor_gid
        p["owner_nickname"] = owner_nick
        p["emoji"] = emoji
        p.pop("actor_avatar", None)
        return p

    if et == "social.repost.created":
        gpid = _gid("global_post_id")
        if not gpid:
            return None
        p["global_post_id"] = gpid
        actor_nick = _fed_nickname(p.get("actor_nickname"))
        actor_gid = _fed_global_id(p.get("actor_global_user_id"))
        owner_nick = _fed_nickname(p.get("owner_nickname"))
        if not actor_nick or not actor_gid or not owner_nick:
            return None
        p["actor_nickname"] = actor_nick
        p["actor_global_user_id"] = actor_gid
        p["owner_nickname"] = owner_nick
        if p.get("quote") is not None:
            p["quote"] = _fed_clip(p.get("quote"), _FED_SOCIAL_QUOTE_MAX)
        p.pop("actor_avatar", None)
        return p

    if et == "social.story.created":
        gsid = _gid("global_story_id")
        if not gsid:
            return None
        p["global_story_id"] = gsid
        nick = _fed_nickname(p.get("nickname"))
        agid = _fed_global_id(p.get("author_global_user_id") or p.get("global_user_id"))
        if not nick or not agid:
            return None
        p["nickname"] = nick
        p["author_global_user_id"] = agid
        p["global_user_id"] = agid
        priv = str(p.get("privacy") or "public").strip().lower()
        p["privacy"] = priv if priv in ("public", "followers") else "public"
        md = _fed_media_data(p.get("media_data"), max_bytes=_FED_STORY_MEDIA_DATA_MAX)
        if not md:
            return None
        mt = _fed_media_type(p.get("media_type"))
        if mt is None:
            return None
        p["media_data"] = md
        p["media_type"] = mt
        p["caption"] = _fed_clip(p.get("caption"), _FED_SOCIAL_CAPTION_MAX)
        return p

    if et == "social.story.deleted":
        gsid = _gid("global_story_id")
        if not gsid:
            return None
        p["global_story_id"] = gsid
        nick = _fed_nickname(p.get("nickname"))
        agid = _fed_global_id(p.get("author_global_user_id") or p.get("global_user_id"))
        if not nick or not agid:
            return None
        p["nickname"] = nick
        p["author_global_user_id"] = agid
        p["global_user_id"] = agid
        p.pop("story_id", None)
        return p

    if et == "social.post.keys.extended":
        gpid = _gid("global_post_id")
        if not gpid:
            return None
        p["global_post_id"] = gpid
        nick = _fed_nickname(p.get("nickname"))
        agid = _fed_global_id(p.get("author_global_user_id"))
        if not nick or not agid:
            return None
        p["nickname"] = nick
        p["author_global_user_id"] = agid
        wraps = []
        for w in (p.get("wrapped_keys") or [])[:64]:
            if not isinstance(w, dict):
                continue
            rgid = _fed_global_id(w.get("recipient_global_user_id"))
            wb = str(w.get("wrapped_b64") or "").strip()
            if not rgid or not wb or len(wb) > 8192:
                continue
            wraps.append({
                "recipient_global_user_id": rgid,
                "recipient_nickname": _fed_nickname(w.get("recipient_nickname")) or "",
                "wrapped_b64": wb,
            })
        if not wraps:
            return None
        p["wrapped_keys"] = wraps
        return p

    if et == "social.follow.changed":
        action = str(p.get("action") or "").strip().lower()
        if action not in ("follow", "unfollow"):
            return None
        p["action"] = action
        fn = _fed_nickname(p.get("follower_nickname"))
        fg = _fed_global_id(p.get("follower_global_user_id"))
        wn = _fed_nickname(p.get("following_nickname"))
        wg = _fed_global_id(p.get("following_global_user_id"))
        if not fn or not fg or not wn or not wg:
            return None
        p["follower_nickname"] = fn
        p["follower_global_user_id"] = fg
        p["following_nickname"] = wn
        p["following_global_user_id"] = wg
        return p

    return None


def _fed_resolve_user_for_dm(
    nickname: str | None,
    global_user_id: str | None,
    *,
    origin_server_id: str = "",
) -> dict | None:
    """Map a federated DM party to a local ``users`` row.

    Prefer ``global_user_id`` (stable across nodes). When the account is not
    registered on this node yet, materialize a mirror user from the signed
    ``dm.message.created`` event so inbox delivery and WebSocket routing work.
    """
    gid = str(global_user_id or "").strip()
    nick = _fed_nickname(nickname)
    if gid:
        user = db.ensure_federated_dm_local_user(
            gid,
            nick or "",
            origin_server_id=origin_server_id or "",
        )
        if user:
            return user
    if nick:
        return _ensure_local_user_by_nickname(nick)
    return None


def _fed_room_name(s) -> str | None:
    raw = str(s or "").strip()
    return raw if _FED_ROOM_RE.match(raw) else None


def _fed_media_type(s) -> str | None:
    """Return a whitelisted media type, '' when absent, or None when hostile.

    Returning None signals the *caller* to drop the entire media payload
    rather than silently fall back to a default that the recipient
    browser might interpret as HTML/script.
    """
    raw = str(s or "").strip().lower()
    if not raw:
        return ""
    # Strip any ;parameters — we only care about the base type for the
    # whitelist check.
    base = raw.split(";", 1)[0].strip()
    return base if _FED_MEDIA_TYPE_RE.match(base) else None


def _fed_media_data(blob, max_bytes=_FED_MEDIA_DATA_MAX):
    """Cap media size. Returns blob (or None when oversized / hostile)."""
    if blob is None or blob == "":
        return None
    if isinstance(blob, (bytes, bytearray, memoryview)):
        return bytes(blob) if len(blob) <= max_bytes else None
    s = str(blob)
    if len(s) > max_bytes:
        return None
    # Refuse data: URLs that smuggle text/html (script-bearing) even if
    # the sibling media_type field is benign. Browsers honour the inline
    # mime of a data URL regardless of the surrounding tag.
    if s[:5].lower() == "data:":
        head = s[:64].lower()
        if "text/html" in head or "application/xhtml" in head or "script" in head:
            return None
    return s


# Per-peer token bucket guarding /federation/events/inbox. A misbehaving
# (or compromised) peer cannot exceed _INBOX_RATE_MAX events per
# _INBOX_RATE_WINDOW seconds, regardless of route-level slowapi limits
# (which key on IP and would let a single peer behind a load balancer
# bypass the throttle). Keyed by the origin_server_id reported in each
# event; events with no origin are accounted under "_unknown".
_INBOX_RATE_WINDOW = 60.0
_INBOX_RATE_MAX = 600        # 10 events/s sustained per peer is plenty
_INBOX_BODY_MAX = 1000        # hard cap on events per single POST
_inbox_buckets: dict[str, list[float]] = {}


def _peer_inbox_allowed(origin: str) -> bool:
    """Return True if this peer is under the per-peer event quota."""
    now = time.time()
    bucket = _inbox_buckets.setdefault(origin or "_unknown", [])
    cutoff = now - _INBOX_RATE_WINDOW
    # Cheap in-place prune; bucket stays bounded by _INBOX_RATE_MAX.
    while bucket and bucket[0] < cutoff:
        bucket.pop(0)
    if len(bucket) >= _INBOX_RATE_MAX:
        return False
    bucket.append(now)
    return True


@router.post("/federation/events/inbox")
async def federation_inbox(
    request: Request,
    x_federation_token: str | None = Header(default=None),
):
    # SECURITY-PASS-2: accept either legacy shared bearer OR per-peer
    # Ed25519 signed request (see crypto_fed.verify_signed_request).
    # Operator flips FROGTALK_FEDERATION_AUTH_MODE=signed to retire
    # the shared bearer once every peer has a registered public key.
    raw_body = await _read_body_bytes_once(request)
    auth_ok, peer_id, auth_reason = await authenticate_federation_request(
        request, raw_body, x_federation_token
    )
    if not auth_ok:
        return JSONResponse(
            status_code=401,
            content={"error": "Invalid federation auth", "reason": auth_reason or "auth_failed"},
        )
    # Parse the cached raw body into our typed model — we can't rely on
    # pydantic having read the body for us because we consumed it
    # ourselves above for signature verification.
    try:
        parsed = json.loads(raw_body.decode("utf-8") or "{}")
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Bad JSON body"})
    try:
        body = FederationInboxBody(**parsed)
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Bad event batch shape"})

    # Bound the per-request payload so a peer can't ship a million-event
    # batch and tie up the worker thread (combined with WS-frame and
    # request body limits this caps total memory pressure).
    if not isinstance(body.events, list) or len(body.events) > _INBOX_BODY_MAX:
        return JSONResponse(status_code=413, content={"error": "Event batch too large"})

    # If we authenticated via per-peer signed request, attach the peer_id
    # to every event so the inbox insert path can require that the
    # signed-peer matches the event origin_server_id (prevents peer A
    # from injecting events claiming origin = peer B even with valid
    # signed-request auth). Legacy bearer path leaves this None and
    # falls back to the existing per-event signature check.
    if peer_id:
        for ev in body.events:
            if isinstance(ev, dict):
                ev.setdefault("_signed_peer_id", peer_id)

    # Per-peer rate limit. Drop events whose origin is over quota; we
    # don't reject the whole batch because a benign peer can still ship
    # mixed-origin batches when relaying.
    filtered: list[dict] = []
    rejected_rate = 0
    for ev in body.events:
        origin = str((ev or {}).get("origin_server_id") or "").strip()
        if _peer_inbox_allowed(origin):
            filtered.append(ev)
        else:
            rejected_rate += 1

    # TOFU-pin origins before verify (status fetch often blocked on hub URLs).
    def _prefetch_inbox_origin_keys(events: list[dict]) -> None:
        seen: set[str] = set()
        for ev in events:
            if not isinstance(ev, dict):
                continue
            origin = str(ev.get("origin_server_id") or "").strip()
            if not origin or origin in seen:
                continue
            seen.add(origin)
            if db.get_federation_server_pubkey(origin):
                continue
            _maybe_tofu_pin_origin_from_event(ev)
            if db.get_federation_server_pubkey(origin):
                continue
            row = db.get_federation_server_row(origin)
            if row:
                target = _select_peer_push_target(row)
                if target:
                    _try_pin_peer_pubkey_from_status_sync(origin, target)

    await asyncio.to_thread(_prefetch_inbox_origin_keys, filtered)

    # Run all SQLite writes on a worker thread so the event loop stays
    # responsive to user requests even when peers spam events.
    accepted, rejected = await asyncio.to_thread(_insert_inbox_events_sync, filtered)
    total_rejected = rejected + rejected_rate
    if total_rejected and accepted == 0:
        _log.warning(
            "federation inbox: rejected all %s events (rate_limited=%s verify=%s)",
            len(body.events), rejected_rate, rejected,
        )
    elif total_rejected:
        _log.info(
            "federation inbox: accepted=%s rejected=%s (rate_limited=%s)",
            accepted, total_rejected, rejected_rate,
        )
    return {"accepted": accepted, "rejected": total_rejected}


# ──────────────────────────────────────────────────────────────
# Phase 4: Build trust and badges
# ──────────────────────────────────────────────────────────────

@router.post("/federation/manifests/register")
async def register_build_manifest(
    body: BuildManifestBody,
    x_federation_token: str | None = Header(default=None),
):
    """Register a build hash manifest.

    Federation token is required for BOTH official and community
    registrations. Previously community builds could self-register with
    no auth, which let any unauthenticated remote pollute the manifest
    table (and pass `official=False, signer=<anything>` to influence
    later /federation/manifests/verify lookups). The federation token
    is shared only with trusted peers, so requiring it for every
    registration closes that gap without breaking legitimate peers
    that already authenticate inbox traffic the same way.
    """
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=403, content={"error": "Not authorised"})

    # HIGH-11: federation-token holders can register manifests for their
    # own builds but cannot mark them official. Only the local server
    # admin UI (which calls this endpoint via the X-Session-Token path
    # in `register_official_manifest`) can flip `official=True`.
    official = False

    # HIGH-15: actually verify the signature before insert. The DB
    # function stored the (signer, signature) pair without checking
    # them, so a peer with the federation token could insert manifests
    # for arbitrary (platform, version, build_hash) tuples and then
    # have ``/federation/manifests/verify`` confirm them. We require
    # the signer pubkey to appear in ``FROGTALK_RELEASE_SIGNERS`` and
    # the Ed25519 signature to cover the canonical
    # ``platform|version|build_hash`` payload.
    sig_ok = _manifest_field_signature_ok(
        signer=body.signer,
        signature=body.signature,
        platform=body.platform,
        version=body.version,
        build_hash=body.build_hash,
    )
    if not sig_ok:
        return JSONResponse(status_code=403, content={"error": "Invalid manifest signature"})

    ok = db.register_build_manifest(
        platform=body.platform,
        version=body.version,
        build_hash=body.build_hash,
        signer=body.signer,
        signature=body.signature,
        official=official,
    )
    if not ok:
        return JSONResponse(status_code=400, content={"error": "Manifest registration failed"})
    return {"ok": True}


def _manifest_field_signature_ok(
    signer: str,
    signature: str,
    platform: str,
    version: str,
    build_hash: str,
) -> bool:
    """Verify the Ed25519 signature on a registered build manifest.

    The signer must be an allowed release signer (configured via
    ``FROGTALK_RELEASE_SIGNERS``) and the signature must cover the
    canonical ``platform|version|build_hash`` byte string.
    """
    signer = (signer or "").strip()
    sig_b64 = (signature or "").strip()
    if not signer or not sig_b64:
        return False
    allowed = _release_signer_pubkeys()
    if not allowed:
        return False
    try:
        sig_bytes = base64.b64decode(sig_b64)
    except Exception:
        return False
    payload = f"{platform}|{version}|{build_hash}".encode("utf-8")
    try:
        from cryptography.hazmat.primitives.serialization import load_pem_public_key
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except Exception:
        return False
    candidates: list[str] = [signer] if "BEGIN PUBLIC KEY" in signer else []
    candidates.extend(allowed)
    for pem in candidates:
        try:
            pk = load_pem_public_key(pem.encode("utf-8"))
            if not isinstance(pk, Ed25519PublicKey):
                continue
            pk.verify(sig_bytes, payload)
            return True
        except Exception:
            continue
    return False


@router.get("/federation/manifests/verify")
async def verify_build_manifest(
    platform: str,
    version: str,
    build_hash: str,
):
    """Check if build hash is registered as official."""
    official = db.is_official_build(platform, version, build_hash)
    return {"platform": platform, "version": version, "build_hash": build_hash, "official": bool(official)}


@router.get("/federation/manifests/list")
async def list_build_manifests(
    platform: str = "",
):
    """List registered build manifests (official or community)."""
    rows = db.list_build_manifests(platform=platform if platform else None)
    return {"manifests": rows}


# ──────────────────────────────────────────────────────────────
# Phase 5: Federation replication
# ──────────────────────────────────────────────────────────────

@router.post("/federation/events/emit")
async def emit_federation_event(
    body: FederationOutboxEventBody,
    x_session_token: str | None = Header(default=None),
):
    """Emit a federation event to local outbox (internal endpoint for app actions)."""
    current_user = await _current_user_from_header(x_session_token)
    if not current_user:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})

    local = db.get_or_create_local_server_identity()
    event_id = f"evt_{int(time.time() * 1000):016x}"

    event = {
        "event_id": event_id,
        "event_type": body.event_type,
        "event_version": 1,
        "origin_server_id": local["server_id"],
        "origin_time": datetime.utcnow().isoformat() + "Z",
        "actor_global_user_id": current_user.get("global_user_id") or "",
        "payload": body.payload,
        "signature": "",  # Signing happens in background task
    }

    if db.insert_federation_outbox_event(event):
        return {"ok": True, "event_id": event_id}
    return JSONResponse(status_code=400, content={"error": "Failed to emit event"})


@router.get("/federation/events/outbox")
async def federation_outbox_pull(
    since: str = "",
    x_federation_token: str | None = Header(default=None),
):
    """Pull outbox events with cursor-based pagination."""
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation token"})

    rows = db.list_federation_outbox_events(since_cursor=since if since else None)
    next_cursor = f"evt_{int(time.time() * 1000):016x}" if rows else None
    return {
        "events": rows,
        "next_cursor": next_cursor,
    }


async def federation_inbox_processor() -> int:
    """Process one inbox batch with idempotency. Returns events processed.

    DB reads/writes are pushed onto worker threads so the single uvicorn event
    loop stays responsive while we drain federation events. The async handlers
    themselves may hit the DB synchronously but each call is short.
    """
    try:
        events = await asyncio.to_thread(
            db.list_federation_inbox_events, "pending", 20
        )
    except Exception:
        _log.exception("Inbox processor list error")
        return 0

    processed = 0
    for row in events:
        event_id = str(row.get("event_id") or "")
        try:
            payload = {}
            raw_payload = row.get("payload_json")
            if isinstance(raw_payload, str) and raw_payload.strip():
                try:
                    payload = json.loads(raw_payload)
                except Exception:
                    payload = {}

            event = {
                "event_id": event_id,
                "event_type": str(row.get("event_type") or ""),
                "origin_server_id": str(row.get("origin_server_id") or ""),
                "payload": payload,
            }

            event_type = event["event_type"]
            if event_type.startswith("message."):
                await _handle_message_event(event)
            elif event_type.startswith("dm."):
                await _handle_dm_event(event)
            elif event_type.startswith("room.") or event_type.startswith("channel."):
                await _handle_room_event(event)
            elif event_type.startswith("user."):
                await _handle_user_event(event)
            elif event_type.startswith("social."):
                await _handle_social_event(event)
            elif event_type.startswith("friend."):
                await _handle_friend_event(event)
            elif event_type.startswith("server."):
                await _handle_server_event(event)
            elif event_type.startswith("sticker."):
                await _handle_sticker_event(event)
            elif event_type.startswith("bot."):
                await _handle_bot_event(event)
            elif event_type.startswith("call."):
                import federation_calls as _fed_calls
                await _fed_calls.apply_call_event(event)
            elif event_type.startswith("voice."):
                import federation_voice as _fed_voice
                await _fed_voice.apply_voice_event(event)

            await asyncio.to_thread(db.mark_federation_inbox_event, event_id, "applied")
            processed += 1
        except Exception:
            _log.exception("Inbox event %s error", event_id)
            try:
                await asyncio.to_thread(db.mark_federation_inbox_event, event_id, "failed")
            except Exception:
                pass
    return processed


def _outbox_collect_targets_sync() -> tuple[str, dict[str, str], list[dict]]:
    """Gather (local_server_id, peer_server_id→base_url, pending_events) in one hop."""
    local = db.get_or_create_local_server_identity()
    local_server_id = str(local.get("server_id") or "")
    # Use only this node's advertised identity for loop detection.
    # Tor mirrors often set PUBLIC_URL=https://frogtalk.xyz for UI links;
    # treating that as "local" made targets=[] so outbound federation never
    # pushed (clubog ping/pong only flowed main → tor, not tor → main).
    local_base = _normalize_base_url(str(local.get("base_url") or "")).lower()
    local_onion = _normalize_base_url(str(local.get("onion_url") or "")).lower()
    env_base = _normalize_base_url((os.getenv("FROGTALK_BASE_URL") or "")).strip().lower()
    if env_base and env_base == local_base:
        local_base = env_base

    own_hosts = {"localhost", "127.0.0.1", "::1"}
    for raw in (
        local_base,
        local_onion,
    ):
        try:
            host = (urllib.parse.urlparse(raw).hostname or "").strip().lower()
            if host:
                own_hosts.add(host)
        except Exception:
            pass

    peers = db.list_federation_servers(official_only=False)
    peer_urls: dict[str, str] = {}
    seen_urls: set[str] = set()
    import federation_calls as fc

    _fed_policy = db.get_federation_policy_settings()
    block_tor = bool(_fed_policy.get("block_tor_peers"))
    block_http = bool(_fed_policy.get("block_http_only_peers"))
    for srv in peers:
        if not srv.get("enabled"):
            continue
        if block_tor and peer_uses_tor_route(srv):
            continue
        if block_http and peer_uses_http_only_clearnet(srv):
            continue
        if (
            not _can_reach_onion_federation_peers()
            and _server_advertises_onion_only(srv)
        ):
            continue
        peer_sid = str(srv.get("server_id") or "").strip()
        if not peer_sid or peer_sid == local_server_id:
            continue
        if fc.federation_peer_is_local_alias(srv, local):
            continue
        target = _select_peer_push_target(srv)
        if not target:
            continue
        normalized_target = _normalize_base_url(target)
        t_lower = normalized_target.lower()
        if local_base and t_lower == local_base:
            continue
        if local_onion and t_lower == local_onion:
            continue

        try:
            target_host = (urllib.parse.urlparse(normalized_target).hostname or "").strip().lower()
        except Exception:
            target_host = ""
        if target_host in own_hosts:
            continue

        if t_lower in seen_urls:
            continue
        seen_urls.add(t_lower)
        _try_pin_peer_pubkey_from_status_sync(peer_sid, normalized_target)
        peer_urls[peer_sid] = normalized_target

    if not peer_urls:
        return local_server_id, peer_urls, []
    events = db.list_federation_outbox_events(
        status="pending", limit=50, priority_sensitive=True,
    )
    return local_server_id, peer_urls, events


def _maybe_tofu_pin_origin_from_event(ev: dict) -> None:
    """Pin origin Ed25519 key from a signed inbox envelope when status fetch fails."""
    origin = str(ev.get("origin_server_id") or "").strip()
    if not origin or db.get_federation_server_pubkey(origin):
        return
    wire_pem = crypto_fed._normalize_pubkey_pem(
        str(ev.get("origin_pubkey_pem") or "")
    )
    if not wire_pem:
        return
    if not crypto_fed.verify_event(ev, wire_pem):
        return
    db.pin_federation_server_pubkey(origin, wire_pem)


def _try_pin_peer_pubkey_from_status_sync(server_id: str, base_url: str) -> None:
    """Best-effort TOFU: fetch /api/network/status and pin pubkey once."""
    sid = str(server_id or "").strip()
    url = _normalize_base_url(base_url)
    if not sid or not url or db.get_federation_server_pubkey(sid):
        return
    try:
        raw = _fetch_url_bytes(
            f"{url}/api/network/status",
            timeout_s=6.0,
        )
        data = json.loads(raw.decode("utf-8", errors="replace") or "{}")
        pem = crypto_fed._normalize_pubkey_pem(
            str((data.get("server") or {}).get("federation_pubkey_pem") or "")
        )
        if pem:
            db.pin_federation_server_pubkey(sid, pem)
    except Exception:
        pass


def ensure_peer_pubkeys_pinned() -> int:
    """Pin Ed25519 pubkeys for every enabled peer that lacks one.

    The official directory listing does not ship ``federation_pubkey_pem``,
    so a node that only ever *receives* from a peer (never pushes to it)
    would reject signed ``dm.*`` / ``message.*`` events until an outbox
    round-trip happened to run TOFU. Proactive pinning fixes one-way chat
    gaps between the clearnet hub and the Tor mirror.
    """
    local_id = str((db.get_or_create_local_server_identity() or {}).get("server_id") or "")
    pinned = 0
    for srv in db.list_federation_servers(official_only=False):
        sid = str(srv.get("server_id") or "").strip()
        if not sid or sid == local_id or not srv.get("enabled"):
            continue
        if db.get_federation_server_pubkey(sid):
            continue
        target = _select_peer_push_target(srv)
        if not target:
            continue
        _try_pin_peer_pubkey_from_status_sync(sid, target)
        if db.get_federation_server_pubkey(sid):
            pinned += 1
    return pinned


async def federation_outbox_processor() -> int:
    """Push pending outbox events to known peers (best-effort).

    Optimized:
      • Batches up to BATCH_SIZE events into a single POST per peer (the
        inbox endpoint already accepts an events list with idempotent dedup
        on event_id, so batching is safe).
      • Pushes to all peers in parallel via asyncio.gather so a slow Tor
        peer cannot block the clearnet peer.
      • Marks all events delivered in one bulk UPDATE.

    Returns the number of events marked delivered this tick.
    """
    fed_token = (os.getenv("FROGTALK_FEDERATION_TOKEN") or "").strip()
    auth_mode = crypto_fed.federation_auth_mode()
    can_sign_push = False
    try:
        can_sign_push = bool(crypto_fed.get_local_public_key_pem())
    except Exception:
        can_sign_push = False
    # Legacy mode requires the shared bearer. dual/signed may push using only
    # per-request Ed25519 headers (receiver must have our pubkey pinned).
    if not fed_token and auth_mode == "legacy":
        return 0
    if not fed_token and not can_sign_push:
        return 0

    try:
        await asyncio.to_thread(ensure_peer_pubkeys_pinned)
    except Exception:
        _log.exception("federation: ensure_peer_pubkeys_pinned before outbox push")

    try:
        local_server_id, peer_urls, events = await asyncio.to_thread(_outbox_collect_targets_sync)
    except Exception:
        _log.exception("Outbox collect error")
        return 0

    if not peer_urls or not events:
        return 0

    BATCH_SIZE = 25
    # Drop rows aimed at unreachable/duplicate-local peers so one bad target
    # (e.g. http://<our-ip> alias) cannot starve delivery to home/main.
    reachable_peer_ids = set(peer_urls.keys())
    orphan_event_ids: list[str] = []
    deliverable_events: list[dict] = []
    for row in events:
        tgt = str(row.get("target_server_id") or "").strip()
        if tgt and tgt not in reachable_peer_ids:
            eid = str(row.get("event_id") or "").strip()
            if eid:
                orphan_event_ids.append(eid)
            continue
        deliverable_events.append(row)
    if orphan_event_ids:
        try:
            await asyncio.to_thread(db.mark_outbox_events_failed, orphan_event_ids[:200])
        except Exception:
            _log.exception("federation: failed to drop orphan outbox targets")
    events = deliverable_events[:BATCH_SIZE]
    if not events:
        return len(orphan_event_ids)

    _ENCRYPTED_PEER_SCOPED = frozenset({
        "social.post.created.encrypted",
        "social.post.keys.extended",
    })

    def _row_payload(row: dict) -> dict:
        raw_payload = row.get("payload_json")
        if isinstance(raw_payload, str) and raw_payload.strip():
            try:
                return json.loads(raw_payload)
            except Exception:
                pass
        return {}

    def _wire_envelope(row: dict, payload: dict) -> dict | None:
        event_id = str(row.get("event_id") or "")
        if not event_id:
            return None
        origin_time = str(row.get("origin_time") or "").strip()
        if not origin_time:
            origin_time = datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z")
        else:
            # Pending rows can sit for hours; receivers reject >5min skew.
            try:
                ts = origin_time.replace("Z", "+00:00")
                origin_dt = datetime.fromisoformat(ts)
                if origin_dt.tzinfo is None:
                    origin_dt = origin_dt.replace(tzinfo=timezone.utc)
                if abs((datetime.now(tz=timezone.utc) - origin_dt).total_seconds()) > 240:
                    origin_time = datetime.now(tz=timezone.utc).isoformat().replace(
                        "+00:00", "Z",
                    )
            except Exception:
                origin_time = datetime.now(tz=timezone.utc).isoformat().replace(
                    "+00:00", "Z",
                )
        envelope: dict = {
            "event_id": event_id,
            "event_type": str(row.get("event_type") or ""),
            "origin_server_id": local_server_id,
            "origin_time": origin_time,
            "event_version": 1,
            "actor_global_user_id": "server-admin",
            "signature": "",
            "payload": payload,
        }
        try:
            crypto_fed.sign_event(envelope)
        except Exception:
            _log.exception("federation: failed to sign outbox event %s", event_id)
        origin_pem = ""
        try:
            origin_pem = crypto_fed.get_local_public_key_pem() or ""
        except Exception:
            origin_pem = ""
        wire = {
            "event_id": event_id,
            "event_type": envelope["event_type"],
            "origin_server_id": local_server_id,
            "origin_time": origin_time,
            "signature": str(envelope.get("signature") or ""),
            "signer_pubkey_fingerprint": str(
                envelope.get("signer_pubkey_fingerprint") or ""
            ),
            "payload": payload,
        }
        if origin_pem:
            wire["origin_pubkey_pem"] = origin_pem
        return wire

    batch = events
    broadcast_rows: list[dict] = []
    targeted_rows: dict[str, list[dict]] = {}
    for row in batch:
        tgt = str(row.get("target_server_id") or "").strip()
        if tgt and tgt in peer_urls:
            targeted_rows.setdefault(tgt, []).append(row)
        else:
            # Missing/unknown/onion-only targets must fan out to reachable
            # clearnet peers; otherwise rows stay pending forever.
            broadcast_rows.append(row)

    base_headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "FrogTalk-FederationPush/1.0",
    }
    if fed_token:
        base_headers["x-federation-token"] = fed_token

    drop_event_ids: set[str] = set()

    async def _push_peer(
        peer_sid: str,
        base: str,
        rows: list[dict],
    ) -> tuple[list[tuple[str, str]], bool, bool]:
        """Returns (deliveries, delivered, payload_too_large)."""
        envelopes: list[dict] = []
        deliveries: list[tuple[str, str]] = []
        for row in rows:
            event_id = str(row.get("event_id") or "")
            if not event_id:
                continue
            payload = _row_payload(row)
            ev_type = str(row.get("event_type") or "")
            row_tgt = str(row.get("target_server_id") or "").strip()
            if ev_type in _ENCRYPTED_PEER_SCOPED and row_tgt:
                scoped = db.filter_encrypted_wraps_for_peer(payload, row_tgt)
                if not scoped:
                    # Recipients no longer home here. Drop the row so it doesn't
                    # stay pending forever; we never push an empty wrap set.
                    drop_event_ids.add(event_id)
                    continue
                payload = scoped
            wire = _wire_envelope(row, payload)
            if wire:
                envelopes.append(wire)
                deliveries.append((event_id, row_tgt))
        if not envelopes:
            return [], False, False

        body = json.dumps({"events": envelopes}).encode("utf-8")
        headers = dict(base_headers)
        # Event bodies are Ed25519-signed; shared bearer authenticates the
        # HTTP hop. Per-request signed headers require the receiver to have
        # already pinned our server_id and broke delivery during rollout.

        try:
            raw = await asyncio.to_thread(
                _fetch_url_bytes,
                f"{base}/api/federation/events/inbox",
                timeout_s=25.0,
                method="POST",
                data=body,
                headers=headers,
            )
            resp: dict = {}
            try:
                resp = json.loads(raw.decode("utf-8", errors="replace") or "{}")
            except Exception:
                resp = {}
            accepted_n = int(resp.get("accepted") or 0)
            if accepted_n <= 0:
                rejected_n = int(resp.get("rejected") or 0)
                _log.warning(
                    "federation: outbox push peer=%s url=%s accepted=0 rejected=%s",
                    peer_sid, base, rejected_n,
                )
                return [], False, False
            return deliveries, True, False
        except httpx.HTTPStatusError as e:
            status = getattr(e.response, "status_code", 0)
            return deliveries, False, status == 413
        except urllib.error.HTTPError as e:
            code = int(getattr(e, "code", 0) or 0)
            if code not in (413,):
                _log.warning(
                    "federation: outbox push HTTP %s peer=%s url=%s",
                    code, peer_sid, base,
                )
            return deliveries, False, code == 413
        except Exception as exc:
            _log.warning(
                "federation: outbox push failed peer=%s url=%s: %s",
                peer_sid, base, exc,
            )
            return deliveries, False, False

    push_jobs = []
    for peer_sid, base in peer_urls.items():
        rows = list(broadcast_rows) + list(targeted_rows.get(peer_sid, []))
        if rows:
            push_jobs.append(_push_peer(peer_sid, base, rows))

    if not push_jobs:
        return 0

    results = await asyncio.gather(*push_jobs)
    all_deliveries: list[tuple[str, str]] = []
    delivered_anywhere = False
    too_large_streak = 0
    for deliveries, ok, too_big in results:
        if ok:
            delivered_anywhere = True
            all_deliveries.extend(deliveries)
        if too_big:
            too_large_streak += 1

    if too_large_streak == len(results) and not delivered_anywhere:
        event_ids = list({
            str(r.get("event_id") or "") for r in batch if r.get("event_id")
        })
        try:
            await asyncio.to_thread(db.mark_outbox_events_failed, event_ids)
        except Exception:
            _log.exception("mark_outbox_events_failed error")
        return 0

    if not delivered_anywhere:
        return 0

    try:
        marked = await asyncio.to_thread(db.mark_outbox_deliveries, all_deliveries)
    except Exception:
        _log.exception("mark_outbox_deliveries error")
        return 0
    if drop_event_ids:
        try:
            await asyncio.to_thread(db.mark_outbox_events_failed, list(drop_event_ids))
        except Exception:
            _log.exception("mark_outbox_events_failed (empty-wraps) error")
    return marked


async def _handle_message_lifecycle_event(event: dict) -> None:
    """Apply `message.deleted` and `message.edited` from a federated peer.

    Authorization: we only mutate a row when the originating peer is the
    same one that originally relayed the message (same origin_server_id
    on `messages` row) and the actor passes `can_moderate_room` on this
    node. This prevents a hostile peer from tombstoning unrelated rows.
    """
    payload = dict(event.get("payload") or {})
    event_type = str(event.get("event_type") or "")
    room_name = _fed_room_name(payload.get("room_name"))
    if not room_name:
        return
    room_name = room_name.lower()
    origin_msg_id = str(payload.get("origin_message_id") or "").strip()
    if not origin_msg_id:
        return
    origin_sid = str(event.get("origin_server_id") or "").strip()
    if not origin_sid:
        return
    actor_nick = _fed_nickname(payload.get("actor_nickname"))
    actor_user = None
    if actor_nick:
        actor_user = _ensure_local_user_by_nickname(actor_nick)
    # Look the row up by (origin_server_id, origin_message_id) — the
    # idempotency keys we already store in `messages`.
    def _resolve_row() -> dict | None:
        try:
            with db._conn() as con:
                row = con.execute(
                    """
                    SELECT id, room_name, user_id, origin_server_id
                      FROM messages
                     WHERE room_name=? AND origin_server_id=? AND origin_message_id=?
                     LIMIT 1
                    """,
                    (room_name, origin_sid, origin_msg_id),
                ).fetchone()
            return dict(row) if row else None
        except Exception:
            return None

    row = await asyncio.to_thread(_resolve_row)
    if not row:
        return
    msg_id = int(row.get("id") or 0)
    if msg_id <= 0:
        return
    # When the actor isn't the original sender, require moderator role
    # on this node — same trust model as our local delete/edit endpoints.
    sender_uid = int(row.get("user_id") or 0)
    actor_is_sender = bool(actor_user and int(actor_user.get("id") or 0) == sender_uid)
    if not actor_is_sender:
        if not actor_user or not db.can_moderate_room(
            room_name, actor_user["id"], bool(actor_user.get("is_admin"))
        ):
            _log.warning(
                "federation: dropping %s (unauthorised) room=%s msg=%s",
                event_type, room_name, msg_id,
            )
            return
    if event_type == "message.deleted":
        try:
            with db._conn() as con:
                con.execute(
                    "UPDATE messages SET tombstoned=1, content='', media_data=NULL, media_type=NULL WHERE id=?",
                    (msg_id,),
                )
                con.commit()
        except Exception:
            return
        try:
            from ws_manager import manager
            await manager.broadcast_room(room_name, {
                "type": "message_deleted",
                "room": room_name,
                "id": msg_id,
            })
        except Exception:
            pass
        return
    if event_type == "message.edited":
        new_content = _fed_clip(payload.get("content"), _FED_CONTENT_MAX)
        try:
            with db._conn() as con:
                con.execute(
                    "UPDATE messages SET content=?, edited=1 WHERE id=?",
                    (new_content, msg_id),
                )
                con.commit()
        except Exception:
            return
        try:
            from ws_manager import manager
            await manager.broadcast_room(room_name, {
                "type": "message_edited",
                "room": room_name,
                "id": msg_id,
                "content": new_content,
                "edited": True,
            })
        except Exception:
            pass


async def _handle_message_event(event: dict) -> None:
    """Handle incoming replicated room message event."""
    event_type = str(event.get("event_type") or "")
    if event_type in ("message.deleted", "message.edited"):
        await _handle_message_lifecycle_event(event)
        return
    if event_type != "message.created":
        return
    payload = dict(event.get("payload") or {})
    # Hostile-peer hardening: validate every untrusted field before we
    # hand the payload to the DB layer. Invalid room/nickname -> drop
    # silently; invalid media_type -> strip the media entirely so it
    # can't smuggle text/html into a browser via a data URL.
    if not _fed_room_name(payload.get("room_name")):
        return
    nick = _fed_nickname(payload.get("nickname")) or "remote"
    payload["nickname"] = nick
    dn = _fed_clip(payload.get("display_name"), _FED_DISPLAY_MAX)
    if dn:
        payload["display_name"] = dn
    av = _fed_clip(payload.get("avatar"), _FED_AVATAR_MAX)
    if av:
        payload["avatar"] = av
    gid = str(payload.get("sender_global_user_id") or "").strip()
    if gid:
        payload["sender_global_user_id"] = gid
    payload["content"] = _fed_clip(payload.get("content"), _FED_CONTENT_MAX)
    mt = _fed_media_type(payload.get("media_type"))
    md = _fed_media_data(payload.get("media_data"))
    if mt is None or md is None:
        payload["media_type"] = None
        payload["media_data"] = None
    else:
        payload["media_type"] = mt or None
        payload["media_data"] = md
    origin_sid = str(event.get("origin_server_id") or "").strip()
    msg_id = await asyncio.to_thread(
        db.save_federated_room_message,
        str(event.get("event_id") or ""),
        payload,
        origin_sid,
    )
    if not msg_id:
        return
    room_name = str(payload.get("room_name") or "").strip()
    try:
        from ws_manager import manager
        with db._conn() as con:
            row = con.execute(
                """
                SELECT m.id, m.room_name, m.nickname, m.user_id, m.content,
                       m.media_type, m.media_blur, m.view_once, m.bridge_platform,
                       u.avatar, u.display_name, u.is_admin
                FROM messages m
                JOIN users u ON u.id = m.user_id
                WHERE m.id = ?
                """,
                (int(msg_id),),
            ).fetchone()
        if not row:
            return
        has_media = bool(payload.get("media_data"))
        broadcast_payload = {
            "type": "message",
            "id": int(row["id"]),
            "room": row["room_name"],
            "nickname": row["nickname"],
            "display_name": row["display_name"],
            "user_id": int(row["user_id"]),
            "avatar": row["avatar"],
            "is_admin": bool(row["is_admin"]),
            "is_bot": False,
            "content": row["content"] or "",
            "media_type": row["media_type"],
            "media_blur": int(row["media_blur"] or 0),
            "view_once": int(row["view_once"] or 0),
            "has_media": has_media,
            "bridge_platform": row["bridge_platform"],
            "reply_to": None,
            "reply_nickname": None,
            "reply_content": None,
            "edited": False,
            "reactions": {},
            "created_at": str(payload.get("created_at") or datetime.utcnow().isoformat() + "Z"),
        }
        await manager.broadcast_room(room_name, broadcast_payload)
    except Exception:
        _log.exception("federation: room message WS broadcast failed room=%s", room_name)


def _fed_room_moderator(room_name: str, actor_nick: str | None) -> dict | None:
    """Return the local user row when a federated actor may moderate ``room_name``."""
    nick = _fed_nickname(actor_nick)
    if not nick:
        return None
    user = _ensure_local_user_by_nickname(nick)
    if not user:
        return None
    if not db.can_moderate_room(room_name, user["id"], bool(user.get("is_admin"))):
        return None
    return user


async def _broadcast_room_settings_ws(room_name: str) -> None:
    try:
        from ws_manager import manager
        room_row = db.get_room_by_name(room_name) or {}
        await manager.broadcast_room(room_name, {
            "type": "room_settings_updated",
            "room": room_name,
            "channel_type": room_row.get("channel_type") or "text",
        })
    except Exception:
        pass


async def _apply_federated_room_settings(room_name: str, payload: dict, origin: str = "") -> None:
    """Apply channel metadata from a trusted federated peer (icon, desc, type)."""
    # Name changes are only accepted via room.renamed (with FK cascade).
    if payload.get("old_name") or payload.get("new_name") or payload.get("name"):
        _log.warning(
            "federation: dropping room.settings.updated with name fields room=%s",
            room_name,
        )
        return
    room_row = db.get_room_by_name(room_name)
    if not room_row:
        return
    # Accept only when the event came from the channel's authoritative home, or
    # (legacy) when the named actor is a local moderator. Without the home check
    # any peer holding a moderator account could push settings for a channel it
    # does not home.
    room_home = str(room_row.get("home_server_id") or "").strip()
    if room_home:
        # The channel has a pinned authoritative home — only that node may push
        # settings. A nickname-moderator match must NOT let a non-home peer
        # mutate the channel (nickname collisions across nodes are trivial).
        if not origin or origin != room_home:
            _log.warning(
                "federation: dropping room.settings.updated (wrong home) room=%s origin=%s home=%s",
                room_name, origin, room_home,
            )
            return
    elif not _fed_room_moderator(room_name, payload.get("updated_by_nickname")):
        # No pinned home (legacy/first-contact): fall back to the local
        # moderator check on the named actor.
        _log.warning(
            "federation: dropping room.settings.updated (unauthorised) room=%s",
            room_name,
        )
        return
    from routers import rooms as rooms_router

    kwargs: dict = {}
    if "icon" in payload:
        try:
            kwargs["icon"] = rooms_router._normalize_room_icon(payload.get("icon"))
        except ValueError:
            _log.warning("federation: dropping room.settings.updated icon (invalid) room=%s", room_name)
            return
    if "description" in payload:
        kwargs["description"] = rooms_router._sanitize_room_text(
            payload.get("description"), max_len=256,
        )
    if "about" in payload:
        kwargs["about"] = rooms_router._sanitize_room_text(
            payload.get("about"), max_len=2000, multiline=True,
        )
    if "channel_type" in payload:
        ct = str(payload.get("channel_type") or "").strip().lower()
        if ct in ("text", "music", "voice"):
            kwargs["channel_type"] = ct
    if "slowmode" in payload:
        try:
            sm = int(payload.get("slowmode"))
            if 0 <= sm <= 3600:
                kwargs["slowmode"] = sm
        except (TypeError, ValueError):
            pass
    if not kwargs:
        return
    if not db.update_room_settings(room_name, **kwargs):
        return
    await _broadcast_room_settings_ws(room_name)


async def _handle_room_event(event: dict) -> None:
    """Handle incoming room event (create/update/delete)."""
    payload = event.get("payload") or {}
    event_type = str(event.get("event_type") or "")

    if event_type == "room.renamed":
        old_name = _fed_room_name(payload.get("old_name"))
        new_name = _fed_room_name(payload.get("new_name"))
        if not old_name or not new_name or old_name == new_name:
            return
        old_name = old_name.lower()
        new_name = new_name.lower()
        if not db.get_room_by_name(old_name):
            return
        if not _fed_room_moderator(old_name, payload.get("renamed_by_nickname")):
            _log.warning(
                "federation: dropping room.renamed (unauthorised) %s -> %s",
                old_name, new_name,
            )
            return
        db.cascade_room_rename(old_name, new_name)
        try:
            from ws_manager import manager
            await manager.broadcast_all({
                "type": "room_renamed",
                "old_name": old_name,
                "new_name": new_name,
            })
        except Exception:
            pass
        await _broadcast_room_settings_ws(new_name)
        return

    if event_type == "room.settings.updated":
        room_name = _fed_room_name(payload.get("room_name"))
        if not room_name:
            return
        await _apply_federated_room_settings(
            room_name.lower(), payload,
            origin=str(event.get("origin_server_id") or "").strip(),
        )
        return

    if event_type == "channel.owner.edit.request":
        # A channel owner edited from a non-home node and relayed the change to
        # us (the home node). The inbox already verified the Ed25519 signature,
        # so origin_server_id and actor_global_user_id are trustworthy. We still
        # enforce: (1) we are the addressed home, (2) the actor is homed on the
        # signing node, (3) the actor IS this channel's owner. Then we apply
        # locally and re-broadcast the authoritative state to all peers.
        origin = str(event.get("origin_server_id") or "").strip()
        actor_gid = str(event.get("actor_global_user_id") or "").strip()
        room_name = _fed_room_name(payload.get("room_name"))
        if not room_name or not actor_gid or actor_gid == "server-admin":
            return
        room_name = room_name.lower()
        local_sid = _local_server_id()
        if not local_sid or str(payload.get("target_origin") or "").strip() != local_sid:
            return  # (1) not addressed to us as home
        room = db.get_room_by_name(room_name)
        if not room or not _room_snapshot_authoritative(room):
            return  # we are not the authoritative home for this channel
        if str(db.resolve_global_user_home_server_id(actor_gid) or "").strip() != origin:
            _log.warning(
                "federation: drop channel.owner.edit.request — actor %s not homed on origin %s room=%s",
                actor_gid, origin, room_name,
            )
            return  # (2) signer does not authoritatively home the actor
        owner_gid = str(room.get("owner_global_user_id") or "").strip() or \
            str((db.get_user_by_id(int(room.get("owner_id") or 0)) or {}).get("global_user_id") or "").strip()
        if not owner_gid or actor_gid != owner_gid:
            _log.warning(
                "federation: drop channel.owner.edit.request — actor %s is not owner of %s",
                actor_gid, room_name,
            )
            return  # (3) actor is not the owner
        if payload.get("name") or payload.get("new_name") or payload.get("old_name"):
            return  # cross-node rename is not supported
        from routers import rooms as rooms_router
        room_type = str(room.get("type") or "public").lower()
        kwargs: dict = {}
        if "description" in payload:
            kwargs["description"] = rooms_router._sanitize_room_text(payload.get("description"), max_len=256)
        if "about" in payload:
            kwargs["about"] = rooms_router._sanitize_room_text(payload.get("about"), max_len=2000, multiline=True)
        if "icon" in payload:
            try:
                kwargs["icon"] = rooms_router._normalize_room_icon(payload.get("icon"))
            except ValueError:
                return
        if "banner" in payload:
            try:
                kwargs["banner"] = rooms_router._normalize_room_banner(payload.get("banner"))
            except ValueError:
                return
        if "channel_theme" in payload:
            try:
                kwargs["channel_theme"] = rooms_router._sanitize_channel_theme(payload.get("channel_theme"), room_type=room_type)
            except ValueError:
                return
        if "channel_type" in payload:
            ct = str(payload.get("channel_type") or "").strip().lower()
            if ct in ("text", "music", "voice"):
                kwargs["channel_type"] = ct
        if "slowmode" in payload:
            try:
                sm = int(payload.get("slowmode"))
                if 0 <= sm <= 3600:
                    kwargs["slowmode"] = sm
            except (TypeError, ValueError):
                pass
        if "invite_only" in payload:
            iv = payload.get("invite_only")
            # HIGH-13: private rooms must stay invite-only.
            if iv in (0, 1) and not (iv == 0 and room_type == "private"):
                kwargs["invite_only"] = iv
        if "who_can_invite" in payload:
            wci = str(payload.get("who_can_invite") or "").strip().lower()
            if wci in ("everyone", "mods", "owner"):
                if room_type == "private" and wci == "everyone":
                    wci = "mods"
                kwargs["who_can_invite"] = wci
        if "forwarding_disabled" in payload:
            fd = payload.get("forwarding_disabled")
            if fd in (0, 1):
                kwargs["forwarding_disabled"] = fd
        if not kwargs or not db.update_room_settings(room_name, **kwargs):
            return
        await _broadcast_room_settings_ws(room_name)
        # Re-broadcast authoritative state to all peers (including the editor's
        # node) so every mirror converges on what the home node accepted.
        try:
            enqueue_channel_directory_updated(room_name)
        except Exception:
            pass
        owner_nick = str((db.get_user_by_id(int(room.get("owner_id") or 0)) or {}).get("nickname") or "")
        fed_settings: dict = {"room_name": room_name, "updated_by_nickname": owner_nick}
        for _k in ("description", "about", "icon", "channel_type", "slowmode"):
            if _k in kwargs:
                fed_settings[_k] = kwargs[_k]
        if len(fed_settings) > 2:
            rooms_router._emit_federation_room_event("room.settings.updated", fed_settings)
        return

    if event_type == "room.presence.updated":
        room_name = _fed_room_name(payload.get("room_name"))
        gid = str(payload.get("global_user_id") or "").strip()
        if not room_name or not gid:
            return
        room_name = room_name.lower()
        if not db.get_room_by_name(room_name):
            return
        pres = str(payload.get("presence") or "offline").strip().lower()
        if pres not in ("online", "away", "dnd", "invisible", "offline"):
            pres = "offline"
        try:
            ts = int(payload.get("updated_at") or 0)
        except Exception:
            ts = 0
        if ts <= 0:
            ts = int(time.time())
        origin_sid = str(event.get("origin_server_id") or "").strip()
        # Only the node that authoritatively homes a user may report that
        # user's presence — otherwise any peer could spoof a foreign user's
        # online/offline state in a room.
        gid_home = str(db.resolve_global_user_home_server_id(gid) or "").strip()
        if gid_home and origin_sid and gid_home != origin_sid:
            _log.warning(
                "federation: drop room.presence.updated — gid %s home %s != origin %s",
                gid, gid_home, origin_sid,
            )
            return
        db.upsert_federation_room_presence(
            room_name,
            gid,
            nickname=_fed_nickname(payload.get("nickname")) or "",
            origin_server_id=origin_sid,
            presence=pres,
            updated_at=ts,
        )
        try:
            from ws_manager import manager
            await manager.broadcast_room(room_name, {
                "type": "room_presence",
                "room": room_name,
                "global_user_id": gid,
                "nickname": _fed_nickname(payload.get("nickname")) or "",
                "presence": "offline" if pres == "invisible" else pres,
                "updated_at": ts,
            })
        except Exception:
            pass
        return

    if event_type == "channel.directory.updated":
        room_name = _fed_room_name(payload.get("room_name"))
        if not room_name:
            return
        room_name = room_name.lower()
        origin_sid = str(event.get("origin_server_id") or "").strip()
        payload_home = str(payload.get("home_server_id") or origin_sid).strip()
        if not origin_sid or origin_sid != payload_home:
            _log.info(
                "federation: drop channel.directory.updated — origin/home mismatch room=%s",
                room_name,
            )
            return
        room_row = db.get_room_by_name(room_name)
        if room_row:
            room_home = str(room_row.get("home_server_id") or "").strip()
            if room_home and room_home != origin_sid:
                _log.info(
                    "federation: drop channel.directory.updated — wrong home room=%s",
                    room_name,
                )
                return
        fci = db.get_federation_channel_index_entry(room_name)
        if fci:
            existing_home = str(fci.get("home_server_id") or "").strip()
            if existing_home and existing_home != origin_sid:
                _log.info(
                    "federation: drop channel.directory.updated — index home conflict room=%s",
                    room_name,
                )
                return
        listed = bool(payload.get("listed")) if "listed" in payload else bool(payload.get("is_public"))
        tombstone = bool(payload.get("tombstone")) or not listed
        if tombstone:
            db.tombstone_federation_channel_index(room_name, origin_sid)
        else:
            tags_raw = payload.get("tags_json")
            if tags_raw is None:
                tags_raw = payload.get("tags")
            if isinstance(tags_raw, list):
                tags_raw = json.dumps(tags_raw)[:2000]
            db.upsert_federation_channel_index(
                room_name,
                origin_sid,
                description=_fed_clip(payload.get("description"), 512),
                directory_description=_fed_clip(payload.get("directory_description"), 1200),
                icon=_fed_clip(payload.get("icon"), _FED_AVATAR_MAX) or None,
                category=_fed_clip(payload.get("category"), 32),
                tags_json=str(tags_raw or "[]")[:2000],
                channel_type=str(payload.get("channel_type") or "text")[:16],
                channel_theme=str(payload.get("channel_theme") or "")[:20000],
                member_count=max(0, int(payload.get("member_count") or 0)),
                owner_nickname=_fed_nickname(payload.get("owner_nickname")) or "",
                owner_global_user_id=str(payload.get("owner_global_user_id") or "")[:64],
                home_base_url=str(payload.get("home_base_url") or "")[:256],
                content_warning_enabled=int(payload.get("content_warning_enabled") or 0),
                content_warning_flags=int(payload.get("content_warning_flags") or 0) & db.CW_ALL,
            )
            cw_en = bool(int(payload.get("content_warning_enabled") or 0))
            cw_fl = int(payload.get("content_warning_flags") or 0) & db.CW_ALL
            if room_row:
                try:
                    db.set_room_content_warning(room_name, enabled=cw_en, flags=cw_fl)
                except Exception:
                    pass
            # Reconcile the real owner onto a local mirror so the directory and
            # the cross-node edit authz resolve by gid (never the system user).
            owner_gid = str(payload.get("owner_global_user_id") or "").strip()
            if owner_gid and room_row and _room_is_federated_mirror(room_row):
                try:
                    with db._conn() as con:
                        con.execute(
                            "UPDATE rooms SET owner_global_user_id=? WHERE name=?",
                            (owner_gid[:64], room_name),
                        )
                        con.commit()
                except Exception:
                    pass
        try:
            from ws_manager import manager
            cw = db.content_warning_to_dict(
                int(payload.get("content_warning_enabled") or 0),
                int(payload.get("content_warning_flags") or 0),
            )
            await manager.broadcast_all({
                "type": "channel_directory_updated",
                "room": room_name,
                "member_count": max(0, int(payload.get("member_count") or 0)),
                "listed": not tombstone,
                "content_warning": cw,
            })
            if cw.get("enabled"):
                await manager.broadcast_all({
                    "type": "content_warning_updated",
                    "room": room_name,
                    "content_warning": cw,
                })
        except Exception:
            pass
        return

    if event_type == "room.members.snapshot":
        room_name = _fed_room_name(payload.get("room_name"))
        if not room_name:
            return
        room_name = room_name.lower()
        members_in = payload.get("members") or []
        if not isinstance(members_in, list):
            return
        # Only honour snapshots from the room's pinned home server.
        # Other peers can still push incremental room.member.joined/left
        # events but cannot purge our local view via a snapshot.
        origin_sid = str(event.get("origin_server_id") or "").strip()
        room_row = db.get_room_by_name(room_name)
        room_home = ""
        if room_row:
            room_home = str(room_row.get("home_server_id") or "").strip()
        sourced_from_home = bool(origin_sid) and (
            origin_sid == room_home or not room_home
        )
        clean: list[dict] = []
        for m in members_in[:_MAX_FED_MEMBER_SNAPSHOT]:
            if not isinstance(m, dict):
                continue
            gid = str(m.get("global_user_id") or "").strip()
            nick = _fed_nickname(m.get("nickname"))
            if not gid or not nick:
                continue
            role = str(m.get("role") or "member").strip().lower()
            if role not in ("owner", "admin", "moderator", "member"):
                role = "member"
            clean.append({
                "global_user_id": gid[:64],
                "nickname": nick[:64],
                "display_name": _fed_clip(m.get("display_name"), _FED_DISPLAY_MAX),
                "avatar": _fed_clip(m.get("avatar"), _FED_AVATAR_MAX),
                "home_server_id": str(m.get("home_server_id") or "")[:64],
                "role": role,
            })
        await asyncio.to_thread(
            db.replace_federation_room_members,
            room_name, clean,
            sourced_from_home=sourced_from_home,
        )
        member_count = max(0, int(payload.get("member_count") or 0))
        if member_count <= 0 and clean:
            member_count = len(clean)
        if origin_sid and member_count >= 0:
            try:
                with db._conn() as con:
                    con.execute(
                        """
                        UPDATE federation_channel_index
                           SET member_count=?, last_seen_at=datetime('now')
                         WHERE room_name=? AND home_server_id=? AND tombstoned=0
                        """,
                        (member_count, room_name, origin_sid),
                    )
                    con.commit()
            except Exception:
                pass
        # If we now know about the room's home, pin it so future snapshots
        # from other peers are downgraded to upsert-only.
        if origin_sid and room_row and not room_home:
            try:
                with db._conn() as con:
                    con.execute(
                        "UPDATE rooms SET home_server_id=? WHERE name=? AND (home_server_id IS NULL OR home_server_id='')",
                        (origin_sid, room_name),
                    )
                    con.commit()
            except Exception:
                pass
        return

    if event_type == "room.music.settings":
        room_name = _fed_room_name(payload.get("room_name"))
        if not room_name:
            return
        room_name = room_name.lower()
        if not _fed_room_moderator(room_name, payload.get("updated_by_nickname")):
            _log.warning(
                "federation: dropping room.music.settings (unauthorised) room=%s",
                room_name,
            )
            return
        room = db.get_room_by_name(room_name)
        if not room:
            return
        ct = str(payload.get("channel_type") or "").strip().lower()
        type_changed = False
        if ct in ("text", "music", "voice"):
            if db.update_room_settings(room_name, channel_type=ct):
                type_changed = True
        if type_changed:
            await _broadcast_room_settings_ws(room_name)
        if "dj_only" in payload:
            db.room_set_dj_only(room_name, 1 if payload.get("dj_only") else 0)
            await _broadcast_music_ws(room_name, {
                "type": "music_dj_only_changed",
                "room": room_name,
                "dj_only": bool(payload.get("dj_only")),
            })
        return

    room_name = _fed_room_name(payload.get("room_name"))
    if not room_name:
        return
    room_name = room_name.lower()

    room = db.get_room_by_name(room_name)
    if not room:
        # CRIT-4: never auto-create a local room from federated events.
        # Doing so used to let any peer materialize arbitrary room names
        # (e.g. "admin-chat") on every node in the network, owned by the
        # federation system user, and then drop fake members and messages
        # into them. Operators who want federated room mirroring should
        # create the room locally first.
        allow_legacy_rooms = (
            os.getenv("FROGTALK_FEDERATION_AUTOCREATE_ROOMS", "0") or "0"
        ).strip().lower() in ("1", "true", "yes", "on")
        if not allow_legacy_rooms:
            _log.info(
                "federation: dropping %s for unknown local room %s",
                event_type, room_name,
            )
            return
        owner = db.get_or_create_federation_system_user()
        room_id = db.create_room(room_name, "Federated room", "public", owner, None)
        if room_id is None:
            room = db.get_room_by_name(room_name)
        else:
            room = db.get_room_by_name(room_name)
    if not room:
        return

    if event_type.startswith("room.music."):
        await _handle_room_music_event(room_name, event_type, payload)
        return

    nickname = _fed_nickname(payload.get("nickname"))
    if not nickname:
        return

    gid = str(payload.get("global_user_id") or "").strip()
    user = db.find_user_by_global_id(gid) if gid else None
    if not user:
        user = _ensure_local_user_by_nickname(nickname)
    if not user:
        return

    is_mirror = _room_is_federated_mirror(room)

    if event_type == "room.member.joined":
        if not is_mirror:
            db.join_room(user["id"], room["id"])
        gid = str(user.get("global_user_id") or gid or "").strip()
        if gid:
            # Derive ownership by global_user_id (works for mirrors, where the
            # local owner_id is the federation_sync system user); fall back to
            # the local-id check only when no owner gid is known.
            chan_owner_gid = str(room.get("owner_global_user_id") or "").strip()
            if not chan_owner_gid:
                chan_owner_gid = str(
                    (db.get_federation_channel_index_entry(room["name"]) or {}).get("owner_global_user_id") or ""
                ).strip()
            is_owner = (
                (bool(chan_owner_gid) and gid == chan_owner_gid)
                or (not chan_owner_gid and int(user.get("id") or 0) == int(room.get("owner_id") or 0))
            )
            db.upsert_federation_room_member(
                room["name"], gid, user.get("nickname") or nickname,
                display_name=user.get("display_name") or "",
                avatar=user.get("avatar") or "",
                home_server_id=str(payload.get("home_server_id") or event.get("origin_server_id") or "").strip(),
                role="owner" if is_owner else "member",
            )
        try:
            from ws_manager import manager
            await manager.broadcast_room(room["name"], {
                "type": "member_joined",
                "room": room["name"],
                "user_id": int(user.get("id") or 0),
                "nickname": user.get("nickname") or nickname,
                "avatar": user.get("avatar"),
            })
        except Exception:
            pass
        if _room_snapshot_authoritative(room):
            try:
                maybe_emit_music_queue_snapshot(room["name"])
            except Exception:
                pass
    elif event_type == "room.member.left":
        if not is_mirror:
            with db._conn() as con:
                con.execute("DELETE FROM room_members WHERE room_id=? AND user_id=?", (room["id"], user["id"]))
                con.commit()
        gid = str(user.get("global_user_id") or gid or "").strip()
        if gid:
            db.tombstone_federation_room_member(room["name"], gid)
        try:
            home_sid = db.resolve_global_user_home_server_id(gid) if gid else ""
            local_sid = _local_server_id()
            if gid and home_sid and local_sid and home_sid != local_sid:
                db.remove_room_from_sync_allowlist(int(user["id"]), str(room.get("name") or ""))
        except Exception:
            pass
        try:
            from ws_manager import manager
            await manager.broadcast_room(room["name"], {
                "type": "member_left",
                "room": room["name"],
                "user_id": int(user.get("id") or 0),
                "nickname": user.get("nickname") or nickname,
            })
        except Exception:
            pass
    elif event_type == "room.member.banned":
        await _apply_federated_room_ban(
            room, user, payload, origin=str(event.get("origin_server_id") or "").strip())
    elif event_type == "room.member.unbanned":
        await _apply_federated_room_unban(
            room, user, payload, origin=str(event.get("origin_server_id") or "").strip())


async def _apply_federated_room_ban(room: dict, target_user: dict, payload: dict, origin: str = "") -> None:
    """Apply a room ban received from a federated peer.

    Security: we do NOT blindly trust the peer's claim of authority.
    The `banned_by_nickname` field is resolved to a local user (real
    or federated mirror) and we re-check `can_moderate_room` against
    THIS node's room state. If the actor isn't an owner/mod/admin
    locally, the ban is dropped silently. This means a node can only
    federate bans for rooms it (or a user it owns) actually moderates.

    Defense in depth: when the room has a pinned authoritative home, only that
    home node may federate bans for it (a non-home peer cannot push bans even if
    a colliding moderator nickname exists locally).
    """
    room_home = str(room.get("home_server_id") or "").strip()
    if room_home and origin and origin != room_home:
        _log.warning(
            "federation: dropping room.member.banned (room=%s origin=%s != home=%s)",
            room.get("name"), origin, room_home,
        )
        return
    actor_nick = _fed_nickname(payload.get("banned_by_nickname"))
    if not actor_nick:
        return
    actor = _ensure_local_user_by_nickname(actor_nick)
    if not actor:
        return
    if not db.can_moderate_room(room["name"], actor["id"], bool(actor.get("is_admin"))):
        _log.warning(
            "federation: dropping room.member.banned (room=%s target=%s actor=%s not authorised locally)",
            room.get("name"), target_user.get("nickname"), actor_nick,
        )
        return
    if target_user.get("is_admin") or target_user["id"] == room.get("owner_id"):
        return    # never allow federation to ban admins/owners
    reason = _fed_clip(payload.get("reason"), 500)
    duration_minutes = None
    try:
        dm = payload.get("duration_minutes")
        if dm is not None:
            duration_minutes = int(dm)
            if duration_minutes <= 0 or duration_minutes > 525_600:  # max 1 yr
                duration_minutes = None
    except Exception:
        duration_minutes = None
    db.ban_user_from_room(room["id"], target_user["id"], actor["id"], reason, duration_minutes)
    # Mirror the live UX: notify the banned user + the room.
    try:
        from ws_manager import manager
        bans = db.get_room_bans(room["id"]) or []
        match = next((b for b in bans if int(b.get("user_id") or 0) == int(target_user["id"])), None)
        expires_at = match.get("expires_at") if match else None
        await manager.send_to_user(target_user["id"], {
            "type": "room_ban",
            "room": room["name"],
            "reason": reason,
            "banned_by": actor_nick,
            "expires_at": expires_at,
            "duration_minutes": duration_minutes,
        })
        await manager.broadcast_room(room["name"], {
            "type": "user_banned",
            "room": room["name"],
            "user_id": target_user["id"],
            "nickname": target_user.get("nickname"),
            "banned_by": actor_nick,
        })
        # Defence-in-depth: close any socket tying the banned user to
        # this room, matching the behaviour of the local /rooms ban
        # endpoint (per-message check in ws.py is still authoritative).
        try:
            await manager.disconnect_user_from_room(target_user["id"], room["name"])
        except Exception:
            pass
    except Exception:
        pass


async def _apply_federated_room_unban(room: dict, target_user: dict, payload: dict, origin: str = "") -> None:
    room_home = str(room.get("home_server_id") or "").strip()
    if room_home and origin and origin != room_home:
        _log.warning(
            "federation: dropping room.member.unbanned (room=%s origin=%s != home=%s)",
            room.get("name"), origin, room_home,
        )
        return
    actor_nick = _fed_nickname(payload.get("unbanned_by_nickname"))
    if not actor_nick:
        return
    actor = _ensure_local_user_by_nickname(actor_nick)
    if not actor:
        return
    if not db.can_moderate_room(room["name"], actor["id"], bool(actor.get("is_admin"))):
        return
    db.unban_user_from_room(room["id"], target_user["id"])
    # Tell the unbanned user (if connected to this node) to drop the
    # inline ban banner without a page refresh.
    try:
        from ws_manager import manager
        await manager.send_to_user(target_user["id"], {
            "type": "room_unban",
            "room": room["name"],
            "unbanned_by": actor_nick,
        })
    except Exception:
        pass


def _set_music_anchor(room_name: str, track_id: int, started_unix: float | int | None) -> None:
    if started_unix is None:
        return
    try:
        from routers import rooms as rooms_router
        rooms_router.set_music_head_anchor(room_name, int(track_id), float(started_unix))
    except Exception:
        pass


def _clear_music_anchor(room_name: str) -> None:
    try:
        from routers import rooms as rooms_router
        rooms_router.clear_music_head_anchor(room_name)
    except Exception:
        pass


async def _broadcast_music_ws(room_name: str, message: dict) -> None:
    try:
        from ws_manager import manager
        await manager.broadcast_room(room_name, message)
    except Exception:
        pass


async def _handle_room_music_event(room_name: str, event_type: str, payload: dict) -> None:
    from routers import rooms as rooms_router

    if event_type == "room.music.queue.snapshot":
        await _apply_federated_music_snapshot(room_name, payload, force=False)
        return

    if event_type == "room.music.track.added":
        provider = str(payload.get("provider") or "").strip()
        video_id = str(payload.get("video_id") or "").strip()
        url = str(payload.get("url") or "").strip()
        if not url:
            return
        parsed_provider, parsed_vid, _embed = rooms_router._parse_track_url(url)
        if not parsed_provider:
            return
        provider = parsed_provider
        video_id = parsed_vid
        submitter_nick = str(payload.get("submitter_nick") or "federation_sync").strip() or "federation_sync"
        submitter = _ensure_local_user_by_nickname(submitter_nick)
        submitter_id = int(submitter["id"]) if submitter else int(db.get_or_create_federation_system_user())
        track_id = db.music_add_track(
            room_name=room_name,
            submitter_id=submitter_id,
            submitter_nick=submitter_nick,
            provider=provider,
            video_id=video_id,
            url=url[:2048],
            title=str(payload.get("title") or "")[:200],
            thumbnail=rooms_router._sanitize_artwork_url(str(payload.get("thumbnail") or "")) or "",
            duration=int(payload.get("duration") or 0),
        )
        if bool(payload.get("make_current")):
            _set_music_anchor(room_name, int(track_id), payload.get("start_unix"))
        await _broadcast_music_ws(room_name, {
            "type": "music_track_added",
            "room": room_name,
            "track": {
                "id": track_id,
                "room_name": room_name,
                "submitter_id": submitter_id,
                "submitter_nick": submitter_nick,
                "provider": provider,
                "video_id": video_id,
                "url": url,
                "title": str(payload.get("title") or ""),
                "thumbnail": str(payload.get("thumbnail") or ""),
                "duration": int(payload.get("duration") or 0),
                "played": 0,
            },
        })
        return

    if event_type == "room.music.track.removed":
        actor = _fed_nickname(payload.get("updated_by_nickname"))
        provider = str(payload.get("provider") or "").strip()
        video_id = str(payload.get("video_id") or "").strip()
        url = str(payload.get("url") or "").strip()
        if not url:
            return
        parsed_provider, parsed_vid, _embed = rooms_router._parse_track_url(url)
        if parsed_provider:
            provider = parsed_provider
            video_id = parsed_vid
        removed_id = None
        with db._conn() as con:
            row = con.execute(
                """
                SELECT id, submitter_id FROM music_queue
                WHERE room_name=? AND played=0 AND provider=? AND video_id=? AND url=?
                ORDER BY id ASC
                LIMIT 1
                """,
                (room_name, provider, video_id, url[:2048]),
            ).fetchone()
            if row:
                removed_id = int(row["id"])
                submitter_id = int(row["submitter_id"] or 0)
                if actor:
                    actor_row = _ensure_local_user_by_nickname(actor)
                    actor_id = int(actor_row["id"]) if actor_row else 0
                    is_submitter = actor_id > 0 and actor_id == submitter_id
                    is_mod = bool(_fed_room_moderator(room_name, actor))
                    if not is_submitter and not is_mod:
                        _log.warning(
                            "federation: dropping room.music.track.removed (unauthorised) room=%s",
                            room_name,
                        )
                        return
                con.execute("DELETE FROM music_queue WHERE id=?", (removed_id,))
                con.commit()
        if removed_id is not None:
            if bool(payload.get("removed_was_head")):
                next_current = db.music_get_current(room_name)
                if next_current:
                    _set_music_anchor(room_name, int(next_current["id"]), payload.get("next_start_unix") or time.time())
                else:
                    _clear_music_anchor(room_name)
            await _broadcast_music_ws(room_name, {
                "type": "music_track_removed",
                "room": room_name,
                "track_id": removed_id,
            })
        return

    if event_type == "room.music.track.skipped":
        if not payload.get("auto") and not _fed_room_moderator(room_name, payload.get("updated_by_nickname")):
            _log.warning(
                "federation: dropping room.music.track.skipped (unauthorised) room=%s",
                room_name,
            )
            return
        current = db.music_get_current(room_name)
        skipped_id = None
        if current:
            skipped_id = int(current["id"])
            db.music_mark_played(skipped_id, room_name)
        next_current = db.music_get_current(room_name)
        if next_current:
            _set_music_anchor(room_name, int(next_current["id"]), payload.get("next_start_unix") or time.time())
        else:
            _clear_music_anchor(room_name)
        await _broadcast_music_ws(room_name, {
            "type": "music_track_skipped",
            "room": room_name,
            "track_id": skipped_id,
        })
        return

    if event_type == "room.music.queue.cleared":
        if not _fed_room_moderator(room_name, payload.get("updated_by_nickname")):
            _log.warning(
                "federation: dropping room.music.queue.cleared (unauthorised) room=%s",
                room_name,
            )
            return
        db.music_clear_queue(room_name)
        _clear_music_anchor(room_name)
        await _broadcast_music_ws(room_name, {"type": "music_queue_cleared", "room": room_name})
        return

    if event_type == "room.music.dj_only.changed":
        if not _fed_room_moderator(room_name, payload.get("updated_by_nickname")):
            _log.warning(
                "federation: dropping room.music.dj_only.changed (unauthorised) room=%s",
                room_name,
            )
            return
        db.room_set_dj_only(room_name, 1 if payload.get("dj_only") else 0)
        await _broadcast_music_ws(room_name, {
            "type": "music_dj_only_changed",
            "room": room_name,
            "dj_only": bool(payload.get("dj_only")),
        })
        return


async def _handle_user_event(event: dict) -> None:
    """Handle incoming federated user profile claim/update/delete."""
    payload = event.get("payload") or {}
    event_type = event.get("event_type")
    # Block / unblock are personal social-graph events with no
    # global_user_id — handle them up front. The "user." prefix
    # already forces a signed origin (see _SENSITIVE_PREFIXES), so by
    # the time we get here the event is signed by the blocker's home
    # server. We still re-validate that the blocker locally maps to a
    # known user before mutating the blocks table.
    if event_type in ("user.blocked", "user.unblocked"):
        await _handle_user_block_event(
            event_type,
            payload,
            origin=str(event.get("origin_server_id") or "").strip(),
        )
        return
    if event_type == "user.privacy.updated":
        await _handle_user_privacy_updated(event)
        return
    if event_type == "user.signal.keys_updated":
        gid = str((payload or {}).get("global_user_id") or "").strip()
        keys_sid = str((payload or {}).get("keys_server_id") or "").strip()
        origin = str(event.get("origin_server_id") or "").strip()
        if gid and keys_sid and origin and keys_sid == origin:
            try:
                ident = db.get_or_create_local_server_identity() or {}
                local_sid = str(ident.get("server_id") or "").strip()
                prev = db.get_signal_keys_server_for_gid(gid)
                db.set_signal_keys_server_for_gid(gid, keys_sid)
                if local_sid and keys_sid != local_sid and prev != keys_sid:
                    db.signal_clear_local_bundles_for_gid(gid)
            except Exception:
                pass
        return

    if event_type == "user.connection.updated":
        gid = str(payload.get("global_user_id") or "").strip()
        origin_sid = str(event.get("origin_server_id") or "").strip()
        if not gid or not origin_sid:
            return
        try:
            ts = int(payload.get("updated_at") or 0)
        except Exception:
            ts = 0
        if ts <= 0:
            ts = int(time.time())
        if payload.get("online"):
            db.upsert_federation_user_connection(gid, origin_sid, updated_at=ts)
            seen = str(payload.get("last_seen") or "").strip()
            if not seen:
                try:
                    seen = db._unix_to_last_seen_str(ts)
                except Exception:
                    seen = ""
            if seen:
                db.apply_last_seen_if_newer(global_user_id=gid, last_seen=seen)
        else:
            db.clear_federation_user_connection(gid, origin_sid)
            seen = str(payload.get("last_seen") or "").strip()
            if seen:
                db.apply_last_seen_if_newer(global_user_id=gid, last_seen=seen)
        try:
            from ws_manager import manager

            local_uid = 0
            try:
                with db._conn() as con:
                    row = con.execute(
                        "SELECT id FROM users WHERE global_user_id=? LIMIT 1",
                        (gid,),
                    ).fetchone()
                if row:
                    local_uid = int(row["id"] if hasattr(row, "keys") else row[0])
            except Exception:
                local_uid = 0
            pres = db.effective_presence_for_user(local_uid, gid)
            broadcast = {
                "type": "profile_update",
                "global_user_id": gid,
                "presence": pres,
            }
            if local_uid > 0:
                broadcast["user_id"] = local_uid
            prof = db.get_federation_user_profile_row(gid) or {}
            nick = str(prof.get("nickname") or "").strip()
            if nick:
                broadcast["nickname"] = nick
            seen = str(payload.get("last_seen") or "").strip()
            if seen:
                broadcast["last_seen"] = seen
            await manager.broadcast_all(broadcast)
        except Exception:
            pass
        return

    if event_type not in ("user.profile.updated", "user.created", "user.deleted"):
        return
    gid = str(payload.get("global_user_id") or "").strip()
    if not gid:
        return
    origin = str(event.get("origin_server_id") or "").strip()
    # Cross-origin pin: only the origin that first claimed a gid can
    # mutate or delete the associated federation_user_profiles row.
    try:
        existing_origin = db.get_federation_profile_origin(gid)
    except Exception:
        existing_origin = ""
    if existing_origin and origin and existing_origin != origin:
        _log.warning(
            "federation: rejecting cross-origin %s for gid=%s (claimed=%s, incoming=%s)",
            event_type, gid, existing_origin, origin,
        )
        return

    if event_type == "user.deleted":
        # Purge the foreign profile record; messages/history stay so
        # existing conversations don't develop holes. The local users
        # row (if any) is untouched — federation never owns local
        # accounts.
        try:
            db.delete_federation_user_profile(gid, origin)
        except Exception:
            _log.exception("federation: failed to delete federation profile gid=%s", gid)
        return

    nick_in = _fed_nickname(payload.get("nickname"))
    if not nick_in:
        return
    banner_omitted_in = bool(payload.get("banner_omitted"))
    banner_in = ""
    if not banner_omitted_in:
        banner_in = _fed_clip(payload.get("banner"), _FED_BANNER_MAX)
    custom_style_in = ""
    if "custom_style" in payload or "custom_css" in payload:
        raw_style = str(payload.get("custom_style") or payload.get("custom_css") or "")[:20000]
        custom_style_in = _sanitize_inline_style(raw_style)
    status_msg_in = _fed_clip(payload.get("status_msg"), _FED_STATUS_MAX)
    db.upsert_federation_user_profile(
        global_user_id=gid,
        nickname=nick_in,
        display_name=_fed_clip(payload.get("display_name"), _FED_DISPLAY_MAX),
        avatar=_fed_clip(payload.get("avatar"), _FED_AVATAR_MAX),
        bio=_fed_clip(payload.get("bio"), _FED_BIO_MAX),
        identity_pubkey=_fed_clip(payload.get("identity_pubkey"), 4096),
        origin_server_id=origin,
        status_msg=_fed_clip(payload.get("status_msg"), _FED_STATUS_MAX),
        mood=_fed_clip(payload.get("mood"), 100),
        presence=str(payload.get("presence") or "offline")[:32],
        custom_style=custom_style_in,
        banner=banner_in,
        last_seen=_fed_clip(payload.get("last_seen"), 64),
        # Banners over the outbox cap ride as banner_omitted=True with no bytes.
        # Flag the row so on-demand/proactive hydration knows a banner exists on
        # home and must be pulled (vs. a user who simply has no banner).
        banner_pending=(1 if banner_omitted_in else None),
    )
    # Proactively pull the omitted banner from the user's home node now, so it's
    # present before anyone views the profile. Rate-limited inside the helper
    # (per-gid 300s) so event bursts can't hammer home; best-effort.
    if banner_omitted_in:
        try:
            from routers.auth import hydrate_federation_profile_from_home
            hydrate_federation_profile_from_home(gid, origin)
        except Exception:
            pass
    seen_in = str(payload.get("last_seen") or "").strip()
    if seen_in:
        db.apply_last_seen_if_newer(global_user_id=gid, last_seen=seen_in)
    # Keep the federated user's "online" status + activity last_seen fresh
    # between connect/disconnect. profile.updated rides the throttled (~90s)
    # heartbeat, so refreshing the connection record here keeps it inside the
    # 300s TTL — otherwise a federated user who stayed connected (no new
    # connect/disconnect event) flipped to "offline" and their last_seen froze.
    try:
        presence_in = str(payload.get("presence") or "").strip().lower()
        if origin and presence_in and presence_in not in ("offline", "invisible"):
            db.upsert_federation_user_connection(gid, origin)
    except Exception:
        pass

    # Only mirror profile fields into the local `users` table when the
    # event's global_user_id matches an EXISTING local user. We deliberately
    # do NOT match by nickname (which would let a federated peer with the
    # same nickname as a real local account silently rewrite that account's
    # status_msg / bio / avatar) and we deliberately do NOT auto-create
    # local users from profile events (the federation_user_profiles
    # directory above is the proper home for foreign user records — the
    # local `users` table should only hold real accounts on this node).
    if not gid:
        return
    local_user = None
    try:
        with db._conn() as con:
            row = con.execute(
                "SELECT id FROM users WHERE global_user_id=? LIMIT 1",
                (gid,),
            ).fetchone()
            if row:
                local_user = {"id": row["id"] if hasattr(row, "keys") else row[0]}
    except Exception:
        local_user = None
    if not local_user:
        try:
            from ws_manager import manager
            fp = db.effective_presence_for_user(0, gid)
            broadcast = {
                "type": "profile_update",
                "nickname": nick_in,
                "global_user_id": gid,
                "presence": fp,
            }
            if status_msg_in:
                broadcast["status_msg"] = status_msg_in
            if seen_in:
                broadcast["last_seen"] = seen_in
            await manager.broadcast_all(broadcast)
        except Exception:
            pass
        return

    allowed_presence = {"online", "away", "dnd", "invisible", "offline"}
    presence = str(payload.get("presence") or "").strip().lower()
    if presence not in allowed_presence:
        presence = None
    display_name_raw = "".join(
        ch for ch in str(payload.get("display_name") or "")
        if ch == " " or ch.isprintable()
    ).strip()[:32]

    # Use COALESCE/NULLIF semantics so an empty/missing field in the
    # payload doesn't blow away an existing local value. This is
    # critical for status_msg: a brief moment where the originating
    # device sends an empty status (e.g. between a music-takeover
    # restore and the next manual edit) would otherwise propagate the
    # blank to every reflecting peer.
    mood_in = _fed_clip(payload.get("mood"), 100)
    avatar_in = _fed_clip(payload.get("avatar"), _FED_AVATAR_MAX)
    bio_in = _fed_clip(payload.get("bio"), _FED_BIO_MAX)

    with db._conn() as con:
        base_sql = """
            UPDATE users
            SET display_name = COALESCE(NULLIF(?, ''), display_name),
                avatar       = COALESCE(NULLIF(?, ''), avatar),
                bio          = COALESCE(NULLIF(?, ''), bio),
                status_msg   = COALESCE(NULLIF(?, ''), status_msg),
                mood         = COALESCE(NULLIF(?, ''), mood),
                presence     = COALESCE(?, presence),
                identity_pubkey = COALESCE(NULLIF(?, ''), identity_pubkey)
        """
        params = [
            display_name_raw,
            avatar_in,
            bio_in,
            status_msg_in,
            mood_in,
            presence,
            str(payload.get("identity_pubkey") or ""),
        ]

        # Only apply CSS when explicitly present in payload to avoid
        # wiping an existing style from profile updates that don't carry it.
        #
        # Track B: the canonical field is `custom_style` (sanitised
        # declaration list). We accept `custom_css` from older peers as
        # a fallback and run it through the same sanitiser \u2014 we never
        # trust a peer's sanitisation, even when the peer is us.
        if "custom_style" in payload or "custom_css" in payload:
            raw = str(payload.get("custom_style") or payload.get("custom_css") or "")[:20000]
            sanitised = _sanitize_inline_style(raw)
            base_sql += ", custom_style=?"
            params.append(sanitised)
            # We deliberately do NOT write to the local `custom_css`
            # column from federation \u2014 raw input only ever comes from
            # the owning user's editor on their home node.

        if not payload.get("banner_omitted"):
            banner_local = _fed_clip(payload.get("banner"), _FED_BANNER_MAX)
            if banner_local:
                base_sql += ", banner=?"
                params.append(banner_local)

        base_sql += " WHERE id=?"
        params.append(local_user["id"])
        con.execute(base_sql, params)
        con.commit()

    # Push live profile changes (including presence/status) to connected clients
    # so channel member sidebars update without a manual refresh. Only fire
    # this when the event actually corresponds to a local user (matched by
    # global_user_id above); otherwise we'd be broadcasting profile updates
    # for foreign users that local clients can't render via the local-user
    # id channel anyway.
    try:
        from ws_manager import manager
        broadcast = {
            "type": "profile_update",
            "user_id": local_user["id"],
            "nickname": str(payload.get("nickname") or "").strip(),
            "display_name": display_name_raw or None,
            "avatar": avatar_in or None,
            "presence": db.effective_presence_for_user(local_user["id"], gid),
        }
        # Never fan-out an empty status — peers use COALESCE on ingest, but
        # the live WS patch used to wipe UI state on other devices.
        if status_msg_in:
            broadcast["status_msg"] = status_msg_in
        if seen_in:
            broadcast["last_seen"] = seen_in
        if not payload.get("banner_omitted"):
            banner_ws = _fed_clip(payload.get("banner"), _FED_BANNER_MAX)
            if banner_ws:
                broadcast["banner"] = banner_ws
        await manager.broadcast_all(broadcast)
    except Exception:
        pass


def _ensure_local_user_by_nickname(nickname: str) -> dict | None:
    """Look up a local user by nickname for federated event application.

    CRIT-4: this helper used to silently auto-create a shadow ``users``
    row whenever a federated event referenced an unknown nickname. That
    let any peer (or any token holder) squat arbitrary names, fake the
    "User X joined" UI signal, and prep impersonation. We now return
    ``None`` for unknown nicks — the callers must drop the event, never
    create a local account as a side effect.

    Operators can opt back into the legacy behavior for a single rolling
    upgrade window by setting ``FROGTALK_FEDERATION_AUTOCREATE_USERS=1``,
    but the default is fail-closed.
    """
    nick = (nickname or "").strip()
    if not _FED_NAME_RE.match(nick):
        return None
    user = db.get_user_by_nick(nick)
    if user:
        return user
    allow_legacy = (os.getenv("FROGTALK_FEDERATION_AUTOCREATE_USERS", "0") or "0").strip().lower() in ("1", "true", "yes", "on")
    if not allow_legacy:
        return None
    uid = db.create_user(nick, secrets.token_urlsafe(24))
    if uid is None:
        return db.get_user_by_nick(nick)
    return db.get_user_by_id(uid)


async def _handle_user_block_event(
    event_type: str,
    payload: dict,
    *,
    origin: str = "",
) -> None:
    """Apply a federated user.blocked / user.unblocked event locally."""
    blocker_gid = str(payload.get("blocker_global_user_id") or "").strip()
    blocked_gid = str(payload.get("blocked_global_user_id") or "").strip()
    blocker_nick = _fed_nickname(payload.get("blocker_nickname"))
    blocked_nick = _fed_nickname(payload.get("blocked_nickname"))
    if not blocker_nick or not blocked_nick:
        return
    if blocker_gid:
        home_sid = str(db.resolve_global_user_home_server_id(blocker_gid) or "").strip()
        if home_sid and origin and home_sid != origin:
            _log.info(
                "federation: drop %s — origin %s is not blocker home %s",
                event_type, origin, home_sid,
            )
            return
        blocker = db.find_user_by_global_id(blocker_gid) or {}
        if not int(blocker.get("id") or 0):
            blocker = db.ensure_federated_dm_local_user(
                blocker_gid,
                blocker_nick,
                origin_server_id=home_sid or origin,
            )
    else:
        blocker = _ensure_local_user_by_nickname(blocker_nick)
    if not blocker or not int(blocker.get("id") or 0):
        return
    blocked_origin = str(db.resolve_global_user_home_server_id(blocked_gid) or origin or "").strip()
    if blocked_gid:
        blocked = db.ensure_federated_dm_local_user(
            blocked_gid,
            blocked_nick,
            origin_server_id=blocked_origin,
        )
    else:
        blocked = db.get_user_by_nick(blocked_nick)
    if not blocked or not int(blocked.get("id") or 0):
        return
    try:
        if event_type == "user.blocked":
            db.block_user(int(blocker["id"]), int(blocked["id"]))
        else:
            db.unblock_user(int(blocker["id"]), int(blocked["id"]))
    except Exception:
        _log.exception(
            "federation: failed to apply %s blocker=%s blocked=%s",
            event_type, blocker_nick, blocked_nick,
        )


async def _handle_user_privacy_updated(event: dict) -> None:
    """Apply federated privacy snapshot for a homed user."""
    payload = event.get("payload") or {}
    gid = str(payload.get("global_user_id") or "").strip()
    if not gid:
        return
    origin = str(event.get("origin_server_id") or "").strip()
    home_sid = str(db.resolve_global_user_home_server_id(gid) or "").strip()
    if home_sid and origin and home_sid != origin:
        _log.info("federation: drop user.privacy.updated — origin not home")
        return
    nick = _fed_nickname(payload.get("nickname"))
    if nick:
        db.upsert_federation_user_profile(gid, nick, origin_server_id=home_sid or origin)
    allow_dm = str(payload.get("allow_dms_from") or "").strip().lower()
    show_ls = str(payload.get("show_last_seen") or "").strip().lower()
    # Only apply the fields the event actually carries — pass None for the rest
    # so apply_federation_user_privacy preserves the existing value. Defaulting
    # an absent field to 0 here is what let a partial event flip profile_public
    # to private.
    def _opt_bool(key):
        return int(bool(payload[key])) if key in payload else None
    db.apply_federation_user_privacy(
        gid,
        origin_server_id=home_sid or origin,
        profile_public=_opt_bool("profile_public"),
        allow_friend_requests=_opt_bool("allow_friend_requests"),
        allow_dms_from=allow_dm if allow_dm in ("everyone", "friends", "nobody") else None,
        show_last_seen=show_ls if show_ls in ("everyone", "friends", "nobody") else None,
        show_read_receipts=_opt_bool("show_read_receipts"),
        hide_dm_history_notice=_opt_bool("hide_dm_history_notice"),
    )


async def _handle_dm_disappear_updated(event: dict) -> None:
    """Apply a federated disappearing-message timer change."""
    payload = event.get("payload") or {}
    actor_nick = _fed_nickname(
        payload.get("actor_nickname") or payload.get("sender_nickname")
    )
    peer_nick = _fed_nickname(payload.get("peer_nickname"))
    if not actor_nick or not peer_nick:
        return
    try:
        seconds = int(payload.get("seconds") or 0)
    except Exception:
        seconds = 0
    allowed = {0, 3600, 86400, 604800, 2592000}
    if seconds not in allowed:
        return
    origin = str(event.get("origin_server_id") or "").strip()
    actor_gid = str(
        payload.get("actor_global_user_id") or payload.get("sender_global_user_id") or ""
    ).strip()
    peer_gid = str(payload.get("peer_global_user_id") or "").strip()
    if not actor_gid or not peer_gid or actor_gid == peer_gid:
        return
    if actor_gid and actor_nick:
        db.upsert_federation_user_profile(actor_gid, actor_nick, origin_server_id=origin)
    if peer_gid and peer_nick:
        db.upsert_federation_user_profile(peer_gid, peer_nick, origin_server_id=origin)
    actor = _fed_resolve_user_for_dm(actor_nick, actor_gid or None, origin_server_id=origin)
    peer = _fed_resolve_user_for_dm(peer_nick, peer_gid or None, origin_server_id=origin)
    if not actor or not peer:
        _log.info(
            "federation: drop dm.disappear.updated — local user missing "
            "(actor=%s peer=%s origin=%s)",
            actor_nick,
            peer_nick,
            origin,
        )
        return
    # Actor must be one of the two DM parties (never a third party).
    actor_ids = {str(actor.get("global_user_id") or "").strip(), str(peer.get("global_user_id") or "").strip()}
    if actor_gid not in actor_ids:
        _log.info("federation: drop dm.disappear.updated — actor not in pair")
        return
    channel_id = db.get_or_create_dm(actor["id"], peer["id"])
    if not db.set_dm_disappear_timer(channel_id, actor["id"], seconds):
        return
    try:
        db.cleanup_expired_dm_messages()
    except Exception:
        _log.debug("federation: disappear cleanup failed", exc_info=True)
    try:
        from routers import dms as dms_mod
        await dms_mod._notify_dm_disappear_updated(
            channel_id, seconds, actor=actor,
        )
        await dms_mod._maybe_post_disappear_timer_notice_federated(
            channel_id, actor, peer, seconds,
        )
    except Exception:
        _log.debug("federation: disappear notice/ws failed", exc_info=True)


async def _handle_dm_lock_prefs_updated(event: dict) -> None:
    payload = event.get("payload") or {}
    actor_nick = _fed_nickname(payload.get("actor_nickname"))
    peer_nick = _fed_nickname(payload.get("peer_nickname"))
    enabled = bool(int(payload.get("pin_lock_enabled") or 0))
    timeout = int(payload.get("pin_lock_timeout_sec") or 0)
    if timeout not in (0, 60, 300, 900, 3600, -1):
        timeout = 0
    origin = str(event.get("origin_server_id") or "").strip()
    actor_gid = str(payload.get("actor_global_user_id") or "").strip()
    peer_gid = str(payload.get("peer_global_user_id") or "").strip()
    if not actor_gid or not peer_gid or actor_gid == peer_gid:
        return
    if actor_gid and actor_nick:
        db.upsert_federation_user_profile(actor_gid, actor_nick, origin_server_id=origin)
    if peer_gid and peer_nick:
        db.upsert_federation_user_profile(peer_gid, peer_nick, origin_server_id=origin)
    actor = _fed_resolve_user_for_dm(actor_nick, actor_gid or None, origin_server_id=origin)
    peer = _fed_resolve_user_for_dm(peer_nick, peer_gid or None, origin_server_id=origin)
    if not actor or not peer:
        _log.info(
            "federation: drop dm.lock_prefs.updated — local user missing "
            "(actor=%s peer=%s origin=%s)",
            actor_nick,
            peer_nick,
            origin,
        )
        return
    actor_ids = {str(actor.get("global_user_id") or "").strip(), str(peer.get("global_user_id") or "").strip()}
    if actor_gid not in actor_ids:
        _log.info("federation: drop dm.lock_prefs.updated — actor not in pair")
        return
    channel_id = db.get_or_create_dm(actor["id"], peer["id"])
    if not db.set_my_dm_pin_lock(
        channel_id,
        actor["id"],
        enabled=enabled,
        timeout_sec=timeout,
    ):
        return
    try:
        from routers import dms as dms_mod
        await dms_mod._notify_dm_lock_prefs_updated(
            channel_id,
            actor=actor,
            enabled=enabled,
            timeout_sec=timeout,
        )
    except Exception:
        _log.debug("federation: dm lock prefs ws failed", exc_info=True)


async def _handle_dm_wipe_all(event: dict) -> None:
    """Apply a federated bilateral DM wipe."""
    payload = event.get("payload") or {}
    actor_nick = _fed_nickname(payload.get("actor_nickname"))
    peer_nick = _fed_nickname(payload.get("peer_nickname"))
    wipe_id = str(payload.get("wipe_id") or "").strip()[:64]
    if not actor_nick or not peer_nick or not wipe_id or not wipe_id.isalnum():
        return
    origin = str(event.get("origin_server_id") or "").strip()
    actor_gid = str(payload.get("actor_global_user_id") or "").strip()
    peer_gid = str(payload.get("peer_global_user_id") or "").strip()
    if not actor_gid or not peer_gid or actor_gid == peer_gid:
        return
    if actor_gid and actor_nick:
        db.upsert_federation_user_profile(actor_gid, actor_nick, origin_server_id=origin)
    if peer_gid and peer_nick:
        db.upsert_federation_user_profile(peer_gid, peer_nick, origin_server_id=origin)
    actor = _fed_resolve_user_for_dm(actor_nick, actor_gid, origin_server_id=origin)
    peer = _fed_resolve_user_for_dm(peer_nick, peer_gid, origin_server_id=origin)
    if not actor or not peer:
        _log.info(
            "federation: drop dm.wipe.all — local user missing "
            "(actor=%s peer=%s origin=%s)",
            actor_nick,
            peer_nick,
            origin,
        )
        return
    pair_gids = {str(actor.get("global_user_id") or "").strip(), str(peer.get("global_user_id") or "").strip()}
    if actor_gid not in pair_gids:
        _log.info("federation: drop dm.wipe.all — actor not in pair")
        return
    channel_id = db.get_or_create_dm(actor["id"], peer["id"])
    result = db.apply_dm_channel_wipe(channel_id, actor["id"], wipe_id=wipe_id)
    if not result.get("ok"):
        return
    peer_id = int(result.get("peer_id") or peer["id"])
    idempotent = bool(result.get("idempotent"))
    try:
        from routers import dms as dms_mod
        await dms_mod._notify_dm_messages_wiped(
            channel_id,
            wipe_id=wipe_id,
            actor=actor,
            peer_id=peer_id,
        )
        if not idempotent:
            await dms_mod._maybe_post_chat_wiped_notice(channel_id, actor, peer)
            await dms_mod._trigger_dm_crypto_heal(actor, peer_id)
    except Exception:
        _log.debug("federation: dm wipe side-effects failed", exc_info=True)


async def _handle_dm_read_receipt(event: dict) -> None:
    """Apply a federated read receipt — push a local dm_read WS event to the sender."""
    payload = event.get("payload") or {}
    reader_gid = str(payload.get("reader_global_user_id") or "").strip()
    peer_gid = str(payload.get("peer_global_user_id") or "").strip()
    if not reader_gid or not peer_gid or reader_gid == peer_gid:
        return
    try:
        up_to = int(payload.get("up_to") or 0)
    except (TypeError, ValueError):
        return
    if up_to <= 0:
        return
    try:
        channel_id = int(payload.get("channel_id") or 0)
    except (TypeError, ValueError):
        channel_id = 0
    origin = str(event.get("origin_server_id") or "").strip()
    reader_nick = _fed_nickname(payload.get("reader_nickname") or "")
    peer_nick = _fed_nickname(payload.get("peer_nickname") or "")
    if not reader_nick or not peer_nick:
        return
    reader = _fed_resolve_user_for_dm(reader_nick, reader_gid, origin_server_id=origin)
    peer_user = _fed_resolve_user_for_dm(peer_nick, peer_gid, origin_server_id=origin)
    if not reader or not peer_user:
        _log.debug(
            "federation: drop dm.read.receipt — user missing (reader=%s peer=%s)",
            reader_nick,
            peer_nick,
        )
        return
    pair_gids = {
        str(reader.get("global_user_id") or "").strip(),
        str(peer_user.get("global_user_id") or "").strip(),
    }
    if reader_gid not in pair_gids or peer_gid not in pair_gids:
        _log.info("federation: drop dm.read.receipt — gids not in resolved pair")
        return
    if db.is_blocked_either_way(int(reader["id"]), int(peer_user["id"])):
        return
    if not db.get_privacy_read_receipts(int(reader["id"])):
        return
    if channel_id > 0:
        with db._conn() as con:
            ch_row = con.execute(
                "SELECT user_a, user_b FROM dm_channels WHERE id=? "
                "AND ((user_a=? AND user_b=?) OR (user_a=? AND user_b=?))",
                (
                    channel_id,
                    reader["id"], peer_user["id"],
                    peer_user["id"], reader["id"],
                ),
            ).fetchone()
        if not ch_row:
            _log.info("federation: drop dm.read.receipt — channel membership mismatch")
            return
    else:
        channel_id = db.get_or_create_dm(int(reader["id"]), int(peer_user["id"]))
    ok, marked_peer_id, new_read = db.mark_dm_read(channel_id, int(reader["id"]), up_to)
    if not ok or int(marked_peer_id or 0) != int(peer_user["id"]):
        return
    try:
        from ws_manager import manager as ws_manager
        await ws_manager.send_to_user(int(peer_user["id"]), {
            "type": "dm_read",
            "channel_id": channel_id,
            "reader_id": int(reader["id"]),
            "last_read": new_read,
        })
    except Exception:
        _log.debug("federation: dm.read.receipt ws delivery failed", exc_info=True)


async def _handle_dm_message_lifecycle(event: dict, action: str) -> None:
    """Apply a federated DM edit/delete to our local copy + push it live.

    The originating node identifies the message by ``source_message_id`` (its own
    local row id); we map that to our federated copy via the origin mapping set
    when the dm.message.created arrived. Only the original sender can edit/delete,
    which holds here because the event is signed by the sender's home node.
    """
    payload = event.get("payload") or {}
    sender_nick = _fed_nickname(payload.get("sender_nickname"))
    peer_nick = _fed_nickname(payload.get("peer_nickname"))
    if not sender_nick or not peer_nick:
        return
    origin = str(event.get("origin_server_id") or "").strip()
    sender_gid = str(payload.get("sender_global_user_id") or "").strip()
    peer_gid = str(payload.get("peer_global_user_id") or "").strip()
    source_msg_id = str(payload.get("source_message_id") or "").strip()
    if not source_msg_id:
        return
    sender = _fed_resolve_user_for_dm(sender_nick, sender_gid or None, origin_server_id=origin)
    peer = _fed_resolve_user_for_dm(peer_nick, peer_gid or None, origin_server_id=origin)
    if not sender or not peer:
        _log.info("federation: drop dm.message.%s — local user missing", action)
        return
    local_id = db.find_dm_message_by_federation_origin(origin, source_msg_id)
    if not local_id:
        _log.info("federation: drop dm.message.%s — unknown source msg %s", action, source_msg_id)
        return
    local_id = int(local_id)
    channel_id = db.get_or_create_dm(int(sender["id"]), int(peer["id"]))
    if action == "edited":
        content = str(payload.get("content") or "")
        if not content.strip():
            return
        if not db.edit_dm_message(local_id, int(sender["id"]), content):
            return
        out = {
            "type": "dm_message_edited", "channel_id": channel_id, "id": local_id,
            "sender_id": int(sender["id"]), "content": content, "edited": True,
            "edited_at": str(payload.get("edited_at") or datetime.utcnow().isoformat() + "Z"),
            "federated": True,
        }
    else:
        if not db.delete_dm_message(local_id, int(sender["id"])):
            return
        out = {
            "type": "dm_message_deleted", "channel_id": channel_id, "id": local_id,
            "sender_id": int(sender["id"]), "federated": True,
        }
    try:
        from ws_manager import manager as ws_manager
        await ws_manager.send_to_user(int(peer["id"]), out)
        if int(sender["id"]) != int(peer["id"]):
            await ws_manager.send_to_user(int(sender["id"]), out)
    except Exception:
        _log.debug("federation: dm.message.%s ws delivery failed", action, exc_info=True)


async def _handle_dm_event(event: dict) -> None:
    """Handle incoming federated DM events."""
    event_type = str(event.get("event_type") or "")
    if event_type == "dm.disappear.updated":
        await _handle_dm_disappear_updated(event)
        return
    if event_type == "dm.lock_prefs.updated":
        await _handle_dm_lock_prefs_updated(event)
        return
    if event_type == "dm.wipe.all":
        await _handle_dm_wipe_all(event)
        return
    if event_type == "dm.read.receipt":
        await _handle_dm_read_receipt(event)
        return
    if event_type == "dm.message.edited":
        await _handle_dm_message_lifecycle(event, "edited")
        return
    if event_type == "dm.message.deleted":
        await _handle_dm_message_lifecycle(event, "deleted")
        return
    if event_type != "dm.message.created":
        return
    payload = event.get("payload") or {}
    # Validate handles + sizes before we touch the local DB. A peer that
    # ships a hostile sender/peer nick (control chars, unicode lookalikes,
    # overly-long values) gets dropped silently — we will never
    # auto-create an attacker-shaped stub account in the local users
    # table as a side effect.
    sender_nick = _fed_nickname(payload.get("sender_nickname"))
    peer_nick = _fed_nickname(payload.get("peer_nickname"))
    if not sender_nick or not peer_nick:
        return
    origin = str(event.get("origin_server_id") or "").strip()
    sender_gid = str(payload.get("sender_global_user_id") or "").strip()
    peer_gid = str(payload.get("peer_global_user_id") or "").strip()
    if sender_gid and sender_nick:
        db.upsert_federation_user_profile(
            sender_gid,
            sender_nick,
            origin_server_id=origin,
        )
    if peer_gid and peer_nick:
        db.upsert_federation_user_profile(
            peer_gid,
            peer_nick,
            origin_server_id=origin,
        )
    sender = _fed_resolve_user_for_dm(
        sender_nick,
        sender_gid or None,
        origin_server_id=origin,
    )
    peer = _fed_resolve_user_for_dm(
        peer_nick,
        peer_gid or None,
        origin_server_id=origin,
    )
    if not sender or not peer:
        _log.info(
            "federation: drop dm.message.created — local user missing "
            "(sender=%s peer=%s origin=%s)",
            sender_nick,
            peer_nick,
            event.get("origin_server_id"),
        )
        return
    if db.is_blocked_either_way(int(sender["id"]), int(peer["id"])):
        _log.info(
            "federation: drop dm.message.created — blocked pair sender=%s peer=%s",
            sender_nick,
            peer_nick,
        )
        return
    # Do not pin signal_keys_server_id from DM ciphertext origin — each node
    # keeps its own published keys; cross-node decrypt uses per-node lanes
    # (see user.signal.keys_updated when a peer uploads a bundle).
    content = _fed_clip(payload.get("content"), _FED_CONTENT_MAX)
    mt = _fed_media_type(payload.get("media_type"))
    md = _fed_media_data(payload.get("media_data"))
    if mt is None or md is None:
        # Hostile media (HTML data URL, oversized blob, non-whitelisted
        # type) is dropped entirely rather than passed through with a
        # fabricated content-type.
        media_type = None
        media_data = None
    else:
        media_type = mt or None
        media_data = md
    media_name = _fed_clip(payload.get("media_name"), 200) or None
    try:
        reply_to = int(payload.get("reply_to")) if payload.get("reply_to") is not None else None
    except Exception:
        reply_to = None
    media_blur = 1 if int(payload.get("media_blur") or 0) else 0
    view_once = 1 if int(payload.get("view_once") or 0) else 0

    source_msg_id = str(payload.get("source_message_id") or "").strip()
    channel_id = db.get_or_create_dm(sender["id"], peer["id"])
    existing_id = None
    if origin and source_msg_id:
        existing_id = db.find_dm_message_by_federation_origin(origin, source_msg_id)

    if existing_id:
        msg_id = int(existing_id)
    else:
        msg_id = db.send_dm_message(
            channel_id,
            sender["id"],
            content,
            media_data,
            media_type,
            media_name,
            reply_to,
            media_blur=media_blur,
            view_once=view_once,
        )
        if origin and msg_id:
            db.set_dm_message_federation_origin(
                msg_id,
                origin,
                source_msg_id or str(msg_id),
            )

    if not msg_id:
        return

    dm_broadcast = {
        "type": "dm_message",
        "id": msg_id,
        "channel_id": channel_id,
        "federated": True,
        "origin_server_id": origin,
        "sender_keys_server_id": origin or None,
        "sender_global_user_id": sender_gid or None,
        "sender_id": sender["id"],
        "sender_nick": sender["nickname"],
        "sender_display_name": sender.get("display_name"),
        "sender_is_admin": bool(sender.get("is_admin")),
        "sender_avatar": sender.get("avatar"),
        "content": content,
        "media_type": media_type,
        "media_name": media_name,
        "has_media": bool(media_data),
        "media_blur": media_blur,
        "view_once": view_once,
        "reply_to": reply_to,
        "edited": False,
        "deleted": False,
        "reactions": {},
        "created_at": str(payload.get("created_at") or datetime.utcnow().isoformat()),
    }
    try:
        from ws_manager import manager
        await manager.send_to_user(peer["id"], dm_broadcast)
        # Same account may be open on this node while sending from a peer node.
        if int(sender["id"]) != int(peer["id"]):
            await manager.send_to_user(sender["id"], dm_broadcast)
    except Exception:
        pass
    if existing_id:
        return
    try:
        from routers.push import send_push
        # PRIVACY: never include plaintext content in the push body. E2E
        # is opt-in per device; forwarding the body would leak it to the
        # tray on devices that don't have the passphrase.
        send_push(
            peer["id"],
            "FrogTalk",
            f"💬 New message from {sender['nickname']}",
            "/app",
            kind="dm",
            tag=f"ft-dm-{channel_id}",
            extra={
                "from_nickname": sender["nickname"],
                "sender_name": sender["nickname"],
                "conversation_id": str(channel_id),
            },
        )
    except Exception:
        pass


async def _handle_friend_event(event: dict) -> None:
    payload = event.get("payload") or {}
    event_type = str(event.get("event_type") or "")

    # Sound events use different keys — handle them before the from/to guard.
    if event_type in ("friend.sound.created", "friend.sound.deleted"):
        from_nick = None  # handled inside the blocks below
        to_nick = None
    else:
        origin = str(event.get("origin_server_id") or "").strip()
        from_user = _fed_resolve_friend_party(payload, "from", origin)
        to_user = _fed_resolve_friend_party(payload, "to", origin)
        if not from_user or not to_user:
            return
        from_nick = str(from_user.get("nickname") or payload.get("from_nickname") or "").strip()
        to_nick = str(to_user.get("nickname") or payload.get("to_nickname") or "").strip()

    if event_type == "friend.requested":
        db.send_friend_request(from_user["id"], to_user["id"])
        try:
            from ws_manager import manager
            await manager.send_to_user(to_user["id"], {
                "type": "friend_notify",
                "action": "request",
                "from": from_nick,
                "from_avatar": from_user.get("avatar"),
            })
        except Exception:
            pass
        try:
            from routers.push import send_push
            send_push(
                to_user["id"], "👥 Friend Request",
                f"{from_nick} wants to be friends", "/app",
                kind="friend_request",
                extra={"from_nickname": ""},
            )
        except Exception:
            pass
        return

    if event_type == "friend.accepted":
        db.accept_friend_request(from_user["id"], to_user["id"])
        await _notify_wall_rewrap_for_new_follower(int(from_user["id"]), int(to_user["id"]))
        await _notify_wall_rewrap_for_new_follower(int(to_user["id"]), int(from_user["id"]))
        try:
            from ws_manager import manager
            await manager.send_to_user(from_user["id"], {
                "type": "friend_notify",
                "action": "accept",
                "from": to_nick,
                "from_avatar": to_user.get("avatar"),
            })
        except Exception:
            pass
        try:
            from routers.push import send_push
            send_push(
                from_user["id"], "👥 Friend Accepted",
                f"{to_nick} accepted your friend request", "/app",
                kind="friend_accepted",
                extra={"from_nickname": ""},
            )
        except Exception:
            pass
        return

    if event_type == "friend.request.removed":
        db.decline_friend_request(from_user["id"], to_user["id"])
        actor = str(payload.get("actor") or "").strip().lower()
        notify_user = None
        notify_from = ""
        notify_avatar = None
        notify_action = ""
        if actor == "to":
            notify_user = from_user
            notify_from = to_nick
            notify_avatar = to_user.get("avatar")
            notify_action = "declined"
        elif actor == "from":
            notify_user = to_user
            notify_from = from_nick
            notify_avatar = from_user.get("avatar")
            notify_action = "cancelled"
        if notify_user and notify_action:
            try:
                from ws_manager import manager
                await manager.send_to_user(int(notify_user["id"]), {
                    "type": "friend_notify",
                    "action": notify_action,
                    "from": notify_from,
                    "from_avatar": notify_avatar,
                })
            except Exception:
                pass
        return

    if event_type == "friend.sound.created":
        owner_nick = str(payload.get("owner_nick") or "").strip()
        friend_nick = str(payload.get("friend_nick") or "").strip()
        kind = str(payload.get("kind") or "").strip()
        file_data_b64 = str(payload.get("file_data_b64") or "").strip()
        filename = str(payload.get("filename") or "sound.bin").strip()
        content_type = str(payload.get("content_type") or "application/octet-stream").strip()
        file_ext = str(payload.get("file_ext") or Path(filename).suffix).strip().lower()
        if not owner_nick or not friend_nick or kind not in ("msg", "ring") or not file_data_b64:
            return
        owner = _ensure_local_user_by_nickname(owner_nick)
        friend = _ensure_local_user_by_nickname(friend_nick)
        if not owner or not friend:
            return
        try:
            raw = base64.b64decode(file_data_b64)
        except Exception:
            return
        if not raw:
            return
        max_bytes = int(os.getenv("FROGTALK_FRIEND_SOUND_MAX_BYTES", str(10 * 1024 * 1024)))
        if len(raw) > max_bytes:
            _log.info("federation: drop friend.sound.created — payload too large")
            return
        sound_root = Path(os.getenv("FROGTALK_FRIEND_SOUND_DIR", "data/friend_sounds"))
        target_dir = sound_root / str(owner["id"]) / str(friend["id"]) / kind
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            return
        import uuid as _uuid
        target_path = target_dir / f"{_uuid.uuid4().hex}{file_ext or '.bin'}"
        try:
            target_path.write_bytes(raw)
        except Exception:
            return
        try:
            db.add_friend_sound_asset(
                owner_user_id=owner["id"],
                friend_user_id=friend["id"],
                kind=kind,
                filename=filename,
                content_type=content_type,
                file_path=str(target_path),
                file_size=len(raw),
                is_active=1,
            )
        except Exception:
            try:
                target_path.unlink(missing_ok=True)
            except Exception:
                pass
        return

    if event_type == "friend.sound.deleted":
        owner_nick = str(payload.get("owner_nick") or "").strip()
        friend_nick = str(payload.get("friend_nick") or "").strip()
        kind = str(payload.get("kind") or "").strip()
        if not owner_nick or not friend_nick or kind not in ("msg", "ring"):
            return
        owner = _ensure_local_user_by_nickname(owner_nick)
        friend = _ensure_local_user_by_nickname(friend_nick)
        if not owner or not friend:
            return
        try:
            active = db.get_active_friend_sound_asset(owner["id"], friend["id"], kind)
            if active:
                deleted = db.delete_friend_sound_asset(owner["id"], active["id"])
                if deleted:
                    fp = Path(str(deleted.get("file_path") or ""))
                    if fp.exists() and fp.is_file():
                        try:
                            fp.unlink()
                        except Exception:
                            pass
        except Exception:
            pass
        return


async def _federated_social_notify(
    owner: dict,
    actor: dict,
    kind: str,
    local_post_id: int,
    *,
    preview: str | None = None,
    emoji: str | None = None,
) -> None:
    """Best-effort local notification after federated engagement is applied."""
    notif_id = db.add_social_notification(
        user_id=int(owner["id"]),
        actor_id=int(actor["id"]),
        kind=kind,
        post_id=int(local_post_id),
        preview=preview,
        emoji=emoji,
    )
    if notif_id is None:
        return
    unread = db.get_social_notification_unread_count(int(owner["id"]))
    try:
        from routers.social import _push_social_notif, _safe_social_preview

        await _push_social_notif(int(owner["id"]), {
            "type": "social_notification",
            "event": kind,
            "id": notif_id,
            "actor": actor.get("nickname"),
            "actor_avatar": actor.get("avatar"),
            "post_id": int(local_post_id),
            "preview": _safe_social_preview(preview),
            "emoji": emoji,
            "unread": unread,
        })
    except Exception:
        _log.debug("federated social notify failed kind=%s", kind, exc_info=True)


async def _notify_wall_rewrap_for_new_follower(
    author_user_id: int,
    follower_user_id: int,
) -> None:
    """Tell the post author their encrypted followers posts need new wraps."""
    try:
        post_ids = await asyncio.to_thread(
            db.get_encrypted_posts_missing_wrap_for_follower,
            int(author_user_id),
            int(follower_user_id),
        )
    except Exception:
        return
    if not post_ids:
        return
    try:
        from ws_manager import manager
        await manager.send_to_user(int(author_user_id), {
            "type": "wall_rewrap_needed",
            "follower_user_id": int(follower_user_id),
            "post_ids": post_ids[:50],
        })
    except Exception:
        _log.debug("wall_rewrap_needed notify failed", exc_info=True)


async def _handle_social_event(event: dict) -> None:
    """Handle incoming FrogSocial / wall federation events."""
    event_type = str(event.get("event_type") or "")
    origin = str(event.get("origin_server_id") or "").strip()
    payload = _fed_sanitize_social_payload(event_type, dict(event.get("payload") or {}))
    if payload is None:
        _log.debug("dropped hostile social event type=%s origin=%s", event_type, origin)
        return

    if event_type == "social.post.created":
        await asyncio.to_thread(db.apply_federated_wall_post_created, payload, origin)
        return

    if event_type == "social.post.created.encrypted":
        await asyncio.to_thread(db.apply_federated_wall_post_encrypted, payload, origin)
        return

    if event_type == "social.post.keys.extended":
        await asyncio.to_thread(db.apply_federated_wall_post_keys_extended, payload, origin)
        return

    if event_type == "social.post.updated":
        await asyncio.to_thread(db.apply_federated_wall_post_updated, payload, origin)
        return

    if event_type == "social.post.deleted":
        await asyncio.to_thread(db.apply_federated_wall_post_deleted, payload, origin)
        return

    if event_type == "social.comment.created":
        await asyncio.to_thread(db.apply_federated_wall_comment_created, payload, origin)
        post_gid = payload.get("global_post_id")
        local_post = db.resolve_federation_wall_local_id(origin, "post", post_gid) if post_gid else None
        actor = _fed_resolve_social_user(payload, origin)
        owner = _ensure_local_user_by_nickname(payload.get("owner_nickname"))
        if (
            actor and owner and local_post
            and int(actor["id"]) != int(owner["id"])
            and _fed_wall_owner_matches_post(owner, int(local_post))
        ):
            await _federated_social_notify(
                owner, actor, "comment", int(local_post),
                preview=str(payload.get("content") or "")[:140],
            )
        return

    if event_type == "social.reaction.changed":
        await asyncio.to_thread(db.apply_federated_wall_reaction_changed, payload, origin)
        post_gid = payload.get("global_post_id")
        local_post = db.resolve_federation_wall_local_id(origin, "post", post_gid) if post_gid else None
        actor = _fed_resolve_social_user(payload, origin)
        owner = _ensure_local_user_by_nickname(payload.get("owner_nickname"))
        if (
            actor and owner and local_post
            and int(actor["id"]) != int(owner["id"])
            and _fed_wall_owner_matches_post(owner, int(local_post))
        ):
            if bool(payload.get("active")):
                await _federated_social_notify(
                    owner, actor, "like", int(local_post),
                    emoji=str(payload.get("emoji") or "")[:8],
                )
            else:
                db.remove_social_like_notification(
                    int(owner["id"]), int(actor["id"]), int(local_post),
                )
        return

    if event_type == "social.repost.created":
        await asyncio.to_thread(db.apply_federated_wall_repost_created, payload, origin)
        post_gid = payload.get("global_post_id")
        local_post = db.resolve_federation_wall_local_id(origin, "post", post_gid) if post_gid else None
        actor = _fed_resolve_social_user(payload, origin)
        owner = _ensure_local_user_by_nickname(payload.get("owner_nickname"))
        if (
            actor and owner and local_post
            and int(actor["id"]) != int(owner["id"])
            and bool(payload.get("active", True))
            and _fed_wall_owner_matches_post(owner, int(local_post))
        ):
            await _federated_social_notify(
                owner, actor, "repost", int(local_post),
                preview=str(payload.get("quote") or "")[:140] or None,
            )
        return

    if event_type == "social.story.created":
        author = _fed_resolve_social_user(payload, origin)
        if not author:
            return
        story_gid = payload.get("global_story_id")
        local_sid = (
            db.resolve_federation_wall_local_id(origin, "story", story_gid)
            if story_gid else None
        )
        if not local_sid:
            local_sid = db.create_story(
                author["id"],
                str(payload["media_data"]),
                str(payload["media_type"]),
                str(payload.get("caption") or ""),
                str(payload.get("privacy") or "public"),
            )
            if story_gid:
                db.map_federation_wall_object(origin, "story", story_gid, int(local_sid))
        try:
            from ws_manager import manager
            await manager.broadcast_all({
                "type": "story_posted",
                "user_id": author["id"],
                "nickname": author["nickname"],
            })
        except Exception:
            pass
        return

    if event_type == "social.story.deleted":
        author = _fed_resolve_social_user(payload, origin)
        if not author:
            return
        story_gid = payload.get("global_story_id")
        local_sid = db.resolve_federation_wall_local_id(origin, "story", story_gid) if story_gid else None
        if not local_sid:
            return
        with db._conn() as con:
            con.execute(
                "DELETE FROM stories WHERE id=? AND user_id=?",
                (int(local_sid), author["id"]),
            )
            con.commit()
        try:
            from ws_manager import manager

            await manager.broadcast_all({
                "type": "story_deleted",
                "user_id": int(author["id"]),
                "nickname": author.get("nickname"),
            })
        except Exception:
            pass
        return

    if event_type == "social.follow.changed":
        action = str(payload.get("action") or "").strip().lower()
        follower = _fed_resolve_social_user(
            {
                "follower_nickname": payload.get("follower_nickname"),
                "follower_global_user_id": payload.get("follower_global_user_id"),
            },
            origin,
            use_account_home=True,
        )
        following = _fed_resolve_social_user(
            {
                "following_nickname": payload.get("following_nickname"),
                "following_global_user_id": payload.get("following_global_user_id"),
            },
            origin,
            use_account_home=True,
        )
        if not follower or not following:
            return
        if action == "follow":
            db.follow_user(follower["id"], following["id"])
            await _notify_wall_rewrap_for_new_follower(
                int(following["id"]), int(follower["id"]),
            )
            try:
                notif_id = db.add_social_notification(
                    user_id=int(following["id"]),
                    actor_id=int(follower["id"]),
                    kind="follow",
                )
                if notif_id is not None:
                    unread = db.get_social_notification_unread_count(int(following["id"]))
                    from routers.social import _push_social_notif

                    await _push_social_notif(int(following["id"]), {
                        "type": "social_notification",
                        "event": "follow",
                        "id": notif_id,
                        "actor": follower.get("nickname"),
                        "actor_avatar": follower.get("avatar"),
                        "unread": unread,
                    })
            except Exception:
                _log.debug("federated follow notify failed", exc_info=True)
        elif action == "unfollow":
            db.unfollow_user(follower["id"], following["id"])


_STICKER_MAX_BYTES = 500 * 1024
_STICKER_MAX_PER_PACK = 30


def _validate_federated_sticker_row(s: dict) -> bool:
    """Reject oversized or malformed sticker blobs at the federation boundary."""
    img = str(s.get("image_data") or "")
    if not img.startswith("data:image/"):
        return False
    if len(img) > _STICKER_MAX_BYTES:
        return False
    return True


async def _handle_sticker_owner_request(event: dict) -> None:
    """Apply cross-node owner edits relayed from a peer where the creator is logged in."""
    payload = event.get("payload") or {}
    action = str(payload.get("action") or "upsert").strip().lower()
    target_origin = str(payload.get("target_origin") or "").strip()
    pack_id = int(payload.get("pack_id") or 0)
    owner_nick = str(payload.get("owner_nickname") or "").strip().lower()
    payload_owner_gid = str(payload.get("owner_global_user_id") or "").strip()
    actor_gid = str(event.get("actor_global_user_id") or "").strip()
    if not target_origin or not pack_id or not owner_nick:
        return
    if not actor_gid or actor_gid == "server-admin":
        return
    if payload_owner_gid and payload_owner_gid != actor_gid:
        return
    try:
        local_sid = str((db.get_or_create_local_server_identity() or {}).get("server_id") or "").strip()
    except Exception:
        return
    if not local_sid or target_origin != local_sid:
        return

    def _apply() -> None:
        with db._conn() as con:
            pack = con.execute(
                "SELECT id, owner_id, name, owner_global_user_id FROM sticker_packs WHERE id=? "
                "AND (origin_server_id IS NULL OR origin_server_id='')",
                (pack_id,),
            ).fetchone()
            if not pack:
                return
            owner = con.execute(
                "SELECT global_user_id, nickname FROM users WHERE id=?",
                (int(pack["owner_id"]),),
            ).fetchone()
            if not owner:
                return
            owner_gid = str(pack["owner_global_user_id"] or owner["global_user_id"] or "").strip()
            owner_nickname = str(owner["nickname"] or "").strip().lower()
            if owner_nickname != owner_nick:
                return
            if not owner_gid or actor_gid != owner_gid:
                return

            if action == "delete":
                con.execute("DELETE FROM stickers WHERE pack_id=?", (pack_id,))
                con.execute("DELETE FROM user_sticker_packs WHERE pack_id=?", (pack_id,))
                con.execute("DELETE FROM sticker_packs WHERE id=?", (pack_id,))
                enqueue_server_event("sticker.pack.delete", {"pack_id": pack_id})
                return

            name = str(payload.get("name") or pack["name"] or "").strip() or "Pack"
            desc = str(payload.get("description") or "")[:200]
            is_public = int(payload.get("is_public") or 1)
            con.execute(
                "UPDATE sticker_packs SET name=?, description=?, is_public=? WHERE id=?",
                (name, desc, is_public, pack_id),
            )
            con.execute("DELETE FROM stickers WHERE pack_id=?", (pack_id,))
            sticker_rows = (payload.get("stickers") or [])[:_STICKER_MAX_PER_PACK]
            for s in sticker_rows:
                if not _validate_federated_sticker_row(s):
                    continue
                try:
                    from routers.gifs import validate_sticker_effects as _vfx
                    fx_raw = s.get("effects")
                    fx_json = None
                    if isinstance(fx_raw, str) and fx_raw.strip():
                        import json as _j
                        fx_raw = _j.loads(fx_raw)
                    fx_norm = _vfx(fx_raw)
                    if fx_norm:
                        import json as _j2
                        fx_json = _j2.dumps(fx_norm)
                except Exception:
                    fx_json = None
                con.execute(
                    "INSERT INTO stickers (pack_id, name, image_data, emoji, effects) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        pack_id,
                        str(s.get("name") or ""),
                        str(s.get("image_data") or ""),
                        str(s.get("emoji") or ""),
                        fx_json,
                    ),
                )
            owner_row = con.execute(
                "SELECT nickname FROM users WHERE id=?", (int(pack["owner_id"]),)
            ).fetchone()
            owner_nick_out = str(owner_row["nickname"] or "") if owner_row else owner_nick
            upsert_payload = {
                "pack_id": pack_id,
                "name": name,
                "description": desc,
                "owner_nickname": owner_nick_out,
                "is_public": is_public,
                "stickers": [
                    dict(r)
                    for r in con.execute(
                        "SELECT id, name, image_data, emoji, effects FROM stickers WHERE pack_id=?",
                        (pack_id,),
                    ).fetchall()
                ],
            }
            enqueue_server_event("sticker.pack.upsert", upsert_payload)

    try:
        await asyncio.to_thread(_apply)
    except Exception:
        _log.exception("sticker owner request failed (pack=%s)", pack_id)


async def _handle_sticker_event(event: dict) -> None:
    """Apply incoming sticker.pack.upsert / sticker.pack.delete events.

    Foreign packs are stored locally with origin_server_id + foreign_pack_id
    set so subsequent updates/deletes find the same row.
    """
    event_type = str(event.get("event_type") or "")
    if event_type == "sticker.pack.owner.request":
        await _handle_sticker_owner_request(event)
        return

    payload = event.get("payload") or {}
    origin = str(event.get("origin_server_id") or "").strip()
    foreign_pack_id = int(payload.get("pack_id") or 0)
    if not origin or not foreign_pack_id:
        return
    # Never materialise our own public packs as owner_id=-1 mirrors on this node.
    try:
        local_sid = str((db.get_or_create_local_server_identity() or {}).get("server_id") or "").strip()
        if local_sid and origin == local_sid:
            return
    except Exception:
        pass

    def _apply() -> None:
        with db._conn() as con:
            # Ensure schema (foreign nodes may have older DB).
            for _ddl in (
                "ALTER TABLE sticker_packs ADD COLUMN origin_server_id TEXT DEFAULT NULL",
                "ALTER TABLE sticker_packs ADD COLUMN foreign_pack_id INTEGER DEFAULT NULL",
            ):
                try: con.execute(_ddl)
                except Exception: pass

            row = con.execute(
                "SELECT id FROM sticker_packs WHERE origin_server_id=? AND foreign_pack_id=?",
                (origin, foreign_pack_id),
            ).fetchone()

            if event_type == "sticker.pack.delete":
                if row:
                    pid = int(row["id"])
                    con.execute("DELETE FROM stickers WHERE pack_id=?", (pid,))
                    con.execute("DELETE FROM user_sticker_packs WHERE pack_id=?", (pid,))
                    con.execute("DELETE FROM sticker_packs WHERE id=?", (pid,))
                return

            # upsert
            name = str(payload.get("name") or "").strip() or "Imported Pack"
            desc = str(payload.get("description") or "")[:200]
            is_public = int(payload.get("is_public") or 1)
            owner_nick = str(payload.get("owner_nickname") or "").strip()[:64]
            owner_gid = str(payload.get("owner_global_user_id") or "").strip()[:128]
            for _ddl in (
                "ALTER TABLE sticker_packs ADD COLUMN owner_nickname TEXT DEFAULT NULL",
                "ALTER TABLE sticker_packs ADD COLUMN owner_global_user_id TEXT DEFAULT NULL",
            ):
                try:
                    con.execute(_ddl)
                except Exception:
                    pass
            # Owner mapping: use a synthetic system user (-1) so foreign packs
            # never appear as a local user's pack but still satisfy the FK
            # contract loosely via the public-browse path. We don't enforce
            # FK in stickers tables (no PRAGMA foreign_keys=ON globally).
            owner_id = -1
            if row:
                pid = int(row["id"])
                con.execute(
                    "UPDATE sticker_packs SET name=?, description=?, is_public=?, "
                    "owner_nickname=?, owner_global_user_id=? WHERE id=?",
                    (name, desc, is_public, owner_nick, owner_gid or None, pid),
                )
                con.execute("DELETE FROM stickers WHERE pack_id=?", (pid,))
            else:
                cur = con.execute(
                    "INSERT INTO sticker_packs (name, description, owner_id, is_public, "
                    "origin_server_id, foreign_pack_id, owner_nickname, owner_global_user_id) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (name, desc, owner_id, is_public, origin, foreign_pack_id, owner_nick, owner_gid or None),
                )
                pid = int(cur.lastrowid)
            for s in (payload.get("stickers") or [])[:_STICKER_MAX_PER_PACK]:
                if not _validate_federated_sticker_row(s):
                    continue
                try:
                    # Effects come over the wire as either an already-encoded
                    # JSON string (from the DB column) or a dict (older peers).
                    # Re-validate before persisting — federation is an
                    # untrusted boundary; the local `validate_sticker_effects`
                    # is the only thing that gets to write the column.
                    fx_raw = s.get("effects")
                    fx_json = None
                    try:
                        from routers.gifs import validate_sticker_effects as _vfx
                        if isinstance(fx_raw, str) and fx_raw.strip():
                            import json as _j
                            fx_raw = _j.loads(fx_raw)
                        fx_norm = _vfx(fx_raw)
                        if fx_norm:
                            import json as _j2
                            fx_json = _j2.dumps(fx_norm)
                    except Exception:
                        fx_json = None
                    con.execute(
                        "INSERT INTO stickers (pack_id, name, image_data, emoji, effects) VALUES (?, ?, ?, ?, ?)",
                        (pid, str(s.get("name") or ""), str(s.get("image_data") or ""), str(s.get("emoji") or ""), fx_json),
                    )
                except Exception:
                    continue

    try:
        await asyncio.to_thread(_apply)
    except Exception:
        _log.exception("sticker federation apply failed (origin=%s pack=%s)", origin, foreign_pack_id)


async def _handle_bot_event(event: dict) -> None:
    """Apply incoming bot.upsert / bot.delete catalog events.

    Federated public bots are mirrored locally with owner_id=-1 so peer
    users can browse them in the Bot Directory and install them into
    local channels. The bot's *runtime* (API key, message-sending) lives
    on the origin server; we only replicate the catalog metadata here.
    """
    payload = event.get("payload") or {}
    event_type = str(event.get("event_type") or "")
    origin = str(event.get("origin_server_id") or "").strip()
    foreign_bot_id = int(payload.get("bot_id") or 0)
    if not origin or not foreign_bot_id:
        return

    def _apply() -> None:
        # Ensure schema (older peers may not have the federation columns yet).
        with db._conn() as con:
            for _ddl in (
                "ALTER TABLE bots ADD COLUMN origin_server_id TEXT DEFAULT NULL",
                "ALTER TABLE bots ADD COLUMN foreign_bot_id INTEGER DEFAULT NULL",
                "ALTER TABLE bots ADD COLUMN owner_nickname TEXT DEFAULT NULL",
            ):
                try: con.execute(_ddl)
                except Exception: pass

        if event_type == "bot.delete":
            db.delete_federated_bot(origin, foreign_bot_id)
            return

        # upsert
        name = str(payload.get("name") or "").strip() or f"bot{foreign_bot_id}"
        avatar = payload.get("avatar") or None
        desc = str(payload.get("description") or "")[:280]
        is_public = int(payload.get("is_public") or 0)
        owner_nick = str(payload.get("owner_nickname") or "")
        if not is_public:
            # Origin flipped it private — drop the mirror.
            db.delete_federated_bot(origin, foreign_bot_id)
            return
        # Honor this node's ban list — if an admin has already banned
        # this federated bot, refuse to re-mirror it and ensure any
        # stale row is gone.
        if db.is_federated_bot_banned(origin, foreign_bot_id):
            db.delete_federated_bot(origin, foreign_bot_id)
            return
        db.upsert_federated_bot(
            origin, foreign_bot_id,
            name=name, avatar=avatar, description=desc,
            owner_nickname=owner_nick, is_public=1,
        )

    try:
        await asyncio.to_thread(_apply)
    except Exception:
        _log.exception("bot federation apply failed (origin=%s bot=%s)", origin, foreign_bot_id)


async def _handle_server_event(event: dict) -> None:
    payload = event.get("payload") or {}
    event_type = str(event.get("event_type") or "")
    if event_type == "server.channel_retention.updated":
        _log.warning("Ignoring remote channel retention settings update event")
        return
    if event_type != "server.channel_retention.pruned":
        return

    source_server = str(event.get("source_server") or "unknown")
    deleted_count = int(payload.get("deleted_count") or 0)
    directory_days = int(payload.get("directory_active_days") or 30)
    auto_delete_days = int(payload.get("auto_delete_days") or 0)
    _log.info(
        "Federation prune report from %s: deleted=%s (directory_active_days=%s, auto_delete_days=%s)",
        source_server,
        deleted_count,
        directory_days,
        auto_delete_days,
    )


# ──────────────────────────────────────────────────────────────
# Phase 6: Tor federation
# ──────────────────────────────────────────────────────────────

@router.get("/network/status/tor")
async def network_status_tor():
    """TOR-specific server identity endpoint."""
    local = db.get_or_create_local_server_identity()
    public = _public_server_view(local, onion_only=True)
    return {
        "server": {
            "server_id": public["server_id"],
            "display_name": public["display_name"],
            "base_url": public.get("base_url") or "",
            "onion_url": public.get("onion_url") or "",
            "tor_enabled": bool(public.get("onion_url")),
            "federation_enabled": True,
        }
    }


@router.post("/network/servers/register-transport")
async def register_transport_preference(
    server_id: str,
    transport: str,  # "clearnet" | "onion" | "auto"
    x_federation_token: str | None = Header(default=None),
):
    """Register preferred transport for communicating with a peer server."""
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation token"})

    if transport not in ("clearnet", "onion", "auto"):
        return JSONResponse(status_code=400, content={"error": "Invalid transport"})

    db.set_federation_server_transport(server_id, transport)
    return {"ok": True}


@router.get("/federation/failover/status")
async def federation_failover_status(
    x_federation_token: str | None = Header(default=None),
):
    """Report current failover state and backup servers."""
    if not _fed_token_ok(x_federation_token):
        return JSONResponse(status_code=401, content={"error": "Invalid federation token"})

    servers = db.list_federation_servers()
    healthy_servers = []
    for srv in servers:
        if srv.get("enabled"):
            healthy_servers.append({
                "server_id": srv["server_id"],
                "base_url": srv.get("base_url"),
                "onion_url": srv.get("onion_url"),
                "transport": db.get_federation_server_transport(srv["server_id"]),
                "last_seen": srv.get("last_seen"),
            })

    return {
        "healthy_servers": healthy_servers,
        "primary": healthy_servers[0] if healthy_servers else None,
    }
