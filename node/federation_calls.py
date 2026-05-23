"""Federated 1:1 call signaling (call.* events).

Hardening notes (kept inline for future auditors):

- ``call.*`` is in ``_SENSITIVE_PREFIXES`` so every inbound event requires a
  valid Ed25519 signature against the origin server's pinned pubkey
  (see ``routers.federation.authenticate_federation_request``).
- The callee is **never** auto-materialized from a foreign ``call.offer``;
  if no local users row exists for the callee GID, the event is dropped.
  Auto-materializing would let a hostile peer seed arbitrary GIDs as stub
  local accounts via ring spam.
- The caller GID's home server must match ``origin_server_id`` when its
  home is already known locally (first-contact peers are accepted because
  their home is empty until we observe one signed event).
- ICE/answer/end/reject apply paths verify the acting GID against the
  participants of the mapped local call row (caller_id, callee_id) so a
  third party can't spray signalling at unrelated users by guessing
  ``global_call_id``.
- Optional friendship/DM-history gate (``FROGTALK_FEDERATION_CALLS_REQUIRE_FRIEND``)
  prevents random federated ring spam from non-friends.
- Inbound ``call.offer`` is throttled per origin server via the existing
  federation inbox rate limiter; we additionally count per-(origin, callee)
  in a short window to refuse flooding a single user from one peer.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime
from typing import Any, Deque

import database as db
from fed_turn import federation_calls_enabled

_log = logging.getLogger(__name__)

_FED_CALL_SDP_MAX = 32 * 1024
_FED_CALL_FP_SIG_MAX = 16 * 1024
_FED_CALL_ICE_MAX = 8 * 1024
_FED_CALL_AVATAR_MAX = 200 * 1024  # 200 KiB cap on call.offer avatars
_FED_CALL_TYPES = ("voice", "video")

# Inbound rate limit: max call.offer events per (origin_server_id, callee_gid)
# in a sliding window. Keeps a hostile peer from ring-bombing one user even
# when origin-wide budget is healthy.
_OFFER_FLOOD_WINDOW_S = 60
_OFFER_FLOOD_MAX = 4
_OFFER_FLOOD_KEYS_MAX = 4096
_offer_flood: dict[tuple[str, str], Deque[float]] = defaultdict(deque)


def new_global_call_id() -> str:
    return str(uuid.uuid4())


def _clip_sdp(sdp: str) -> str:
    # Keep SDP printable + CR/LF/TAB only; strip other control bytes.
    s = re.sub(r"[^\x09\x0a\x0d\x20-\x7e]", "", str(sdp or ""))
    return s[:_FED_CALL_SDP_MAX]


def _clip_ice(candidate: str) -> str:
    # ICE lines should be plain text; drop non-printable controls so peers
    # cannot smuggle terminal/log control chars through signaling.
    c = re.sub(r"[^\x09\x0a\x0d\x20-\x7e]", "", str(candidate or ""))
    return c[:_FED_CALL_ICE_MAX]


def _safe_call_type(value: Any) -> str:
    v = str(value or "voice").strip().lower()
    return v if v in _FED_CALL_TYPES else "voice"


def _safe_avatar(value: Any) -> str:
    """Clip and refuse hostile avatar schemes.

    Only allow ``data:image/...`` and ``http(s)://`` avatars; anything else
    (``javascript:``, ``data:text/html``, ``vbscript:``, etc.) is dropped to
    an empty string. Length-capped to ``_FED_CALL_AVATAR_MAX``.
    """
    raw = str(value or "").strip()
    if not raw:
        return ""
    low = raw.lower()
    if low.startswith("data:image/"):
        # Require base64 data URLs and deny SVG to reduce scriptable payload
        # surface in downstream renderers.
        if not re.match(r"^data:image/(?!svg\+xml)[a-z0-9.+-]+;base64,[a-z0-9+/=\n\r]+$", low, re.IGNORECASE):
            return ""
    elif low.startswith("http://") or low.startswith("https://"):
        pass
    else:
        return ""
    if len(raw) > _FED_CALL_AVATAR_MAX:
        raw = raw[:_FED_CALL_AVATAR_MAX]
    return raw


def _offer_throttled(origin: str, callee_gid: str) -> bool:
    """Return True when ``origin`` has rung ``callee_gid`` too often recently."""
    key = (str(origin or "").strip(), str(callee_gid or "").strip())
    if not key[0] or not key[1]:
        return False
    now = time.monotonic()
    if len(_offer_flood) > _OFFER_FLOOD_KEYS_MAX:
        # Opportunistic compact: drop stale/empty buckets first, then trim
        # oldest survivors to keep memory bounded under hostile cardinality.
        stale: list[tuple[str, str]] = []
        for k, b in _offer_flood.items():
            while b and (now - b[0]) > _OFFER_FLOOD_WINDOW_S:
                b.popleft()
            if not b:
                stale.append(k)
        for k in stale:
            _offer_flood.pop(k, None)
        if len(_offer_flood) > _OFFER_FLOOD_KEYS_MAX:
            for k in list(_offer_flood.keys())[: len(_offer_flood) - _OFFER_FLOOD_KEYS_MAX]:
                _offer_flood.pop(k, None)
    bucket = _offer_flood[key]
    while bucket and (now - bucket[0]) > _OFFER_FLOOD_WINDOW_S:
        bucket.popleft()
    if len(bucket) >= _OFFER_FLOOD_MAX:
        return True
    bucket.append(now)
    return False


def require_friend_for_calls() -> bool:
    return os.getenv(
        "FROGTALK_FEDERATION_CALLS_REQUIRE_FRIEND", "1"
    ).strip().lower() in ("1", "true", "yes")


def _relay_origin_allowed(origin: str) -> bool:
    """Whether a signed ``call.*`` from ``origin`` may relay traveler signaling.

    Account home may differ from the node the user is connected to. Fan-out
    delivers offers/answers/ICE from community nodes; receivers must accept
    any enabled federation peer, not only the party's pinned home server.
    """
    oid = str(origin or "").strip()
    if not oid:
        return False
    ident = db.get_or_create_local_server_identity() or {}
    if oid == str(ident.get("server_id") or "").strip():
        return True
    row = db.get_federation_server_row(oid)
    return bool(row and int(row.get("enabled") or 0))


def _call_home_origin_mismatch(party_gid: str, origin: str) -> bool:
    """True when we should drop: pinned home disagrees with origin and origin untrusted."""
    gid = str(party_gid or "").strip()
    oid = str(origin or "").strip()
    if not gid or not oid:
        return False
    known_home = db.resolve_global_user_home_server_id(gid)
    if not known_home or known_home == oid:
        return False
    return not _relay_origin_allowed(oid)


def _enqueue(event_type: str, payload: dict, target_server_ids: list[str]) -> dict:
    from routers import federation as fed

    return fed.enqueue_server_event(
        event_type,
        payload,
        target_server_ids=target_server_ids,
    )


def callee_home_server(callee_user: dict) -> str:
    """Server_id of the callee's home node, with local-fallback.

    If ``resolve_global_user_home_server_id`` can't pin the user (no
    federated profile row, or the row's origin is missing) we treat the
    callee as local — the call still works because the caller's TURN
    bundle is the local node's anyway.
    """
    gid = str((callee_user or {}).get("global_user_id") or "").strip()
    if gid:
        home = db.resolve_global_user_home_server_id(gid)
        if home:
            return home
    ident = db.get_or_create_local_server_identity() or {}
    return str(ident.get("server_id") or "").strip()


def user_home_is_remote(user: dict) -> bool:
    if not federation_calls_enabled():
        return False
    ident = db.get_or_create_local_server_identity() or {}
    local_sid = str(ident.get("server_id") or "").strip()
    gid = str((user or {}).get("global_user_id") or "").strip()
    if not gid:
        return False
    home = db.resolve_global_user_home_server_id(gid)
    return bool(home and local_sid and home != local_sid)


def callee_session_on_local_node(callee_user: dict) -> bool:
    """True when the callee has an active WebSocket session on this node.

    Travelers homed elsewhere but currently connected here are rung via the
    local call path so co-located visitors can call each other on a community
    node without signaling through their home servers.
    """
    if not callee_user:
        return False
    uid = int(callee_user.get("id") or 0)
    if uid <= 0:
        return False
    try:
        from ws_manager import manager

        return bool(manager.is_user_online(uid))
    except Exception:
        return False


def is_remote_peer(callee_user: dict) -> bool:
    """Use federation signaling unless the callee is on this node's WebSocket now.

    Account home alone is not enough: travelers homed on this node but connected
    elsewhere must still be reached via federation fan-out. Mirrors can show
    stale ``online`` presence without a live session — homed-elsewhere callees
    still need federation even when presence looks local.
    """
    if callee_session_on_local_node(callee_user):
        return False
    if user_home_is_remote(callee_user):
        return True
    return needs_federated_call_delivery(callee_user)


def needs_federated_call_delivery(recipient_user: dict | None) -> bool:
    """True when a call signal must leave this node to reach ``recipient_user``."""
    if not federation_calls_enabled():
        return False
    return not callee_session_on_local_node(recipient_user or {})


def _federation_fanout_server_ids(*extra_server_ids: str) -> list[str]:
    """Callee/caller home plus every enabled peer (traveler reachability)."""
    ident = db.get_or_create_local_server_identity() or {}
    local_sid = str(ident.get("server_id") or "").strip()
    targets: set[str] = set()
    for raw in extra_server_ids:
        sid = str(raw or "").strip()
        if sid:
            targets.add(sid)
    try:
        for row in db.list_federation_servers(official_only=False):
            sid = str(row.get("server_id") or "").strip()
            if not sid or sid == local_sid or not int(row.get("enabled") or 0):
                continue
            targets.add(sid)
    except Exception:
        pass
    if not targets and local_sid:
        targets.add(local_sid)
    return sorted(targets)


def _peer_is_onion_only(server_row: dict) -> bool:
    """True when a federation row has no usable clearnet inbox URL."""
    base = str((server_row or {}).get("base_url") or "").strip()
    onion = str((server_row or {}).get("onion_url") or "").strip()
    if onion and not base:
        return True
    transport = str((server_row or {}).get("transport_preference") or "auto").strip().lower()
    return transport == "onion"


def _clearnet_federation_peer_ids() -> list[str]:
    """Enabled peers with a clearnet base URL, excluding this node and onion-only rows."""
    ident = db.get_or_create_local_server_identity() or {}
    local_sid = str(ident.get("server_id") or "").strip()
    out: list[str] = []
    try:
        for row in db.list_federation_servers(official_only=False):
            if not int(row.get("enabled") or 0):
                continue
            sid = str(row.get("server_id") or "").strip()
            if not sid or sid == local_sid:
                continue
            if _peer_is_onion_only(row):
                continue
            if not str(row.get("base_url") or "").strip():
                continue
            out.append(sid)
    except Exception:
        pass
    return sorted(set(out))


def call_signal_target_servers(
    recipient_user: dict | None,
    *,
    recipient_gid: str = "",
) -> list[str]:
    """Outbox destinations for any ``call.*`` / ``dm.*`` event aimed at one participant."""
    user = dict(recipient_user or {})
    gid = str(user.get("global_user_id") or recipient_gid or "").strip()
    if not user and gid:
        looked = _lookup_local_user_by_gid(gid)
        if looked:
            user = looked
    if user and callee_session_on_local_node(user):
        return []
    ident = db.get_or_create_local_server_identity() or {}
    local_sid = str(ident.get("server_id") or "").strip()
    targets: set[str] = set()
    if gid:
        for sid in db.resolve_federation_push_targets_for_recipient_gids([gid]):
            if sid:
                targets.add(sid)
        origin = str(db.get_federation_profile_origin(gid) or "").strip()
        if origin and origin != local_sid:
            targets.add(origin)
    uid = int(user.get("id") or 0)
    if uid > 0:
        try:
            home = str(db.get_user_account_home_server_id(uid) or "").strip()
        except Exception:
            home = ""
        if home and home != local_sid:
            targets.add(home)
    if targets:
        return sorted(targets)
    # Same federation id on multiple physical nodes, or unknown home: reach every
    # other clearnet-capable peer (never onion-only rows).
    return _clearnet_federation_peer_ids()


def call_offer_target_servers(callee_user: dict) -> list[str]:
    """Federation destinations for ``call.offer`` when the callee is not local-WS."""
    return call_signal_target_servers(callee_user)


def can_call_user(caller_id: int, callee_id: int) -> str | None:
    """Return error code or ``None`` when the call is permitted.

    Enforces ``is_blocked_either_way`` and (optionally) friendship. The
    friendship gate prevents random cross-node strangers from ringing your
    users; turn off with ``FROGTALK_FEDERATION_CALLS_REQUIRE_FRIEND=0`` if
    you explicitly want open ringing.
    """
    if not caller_id or not callee_id:
        return "user_not_found"
    if db.is_blocked_either_way(int(caller_id), int(callee_id)):
        return "blocked"
    if require_friend_for_calls() and not db.are_friends(int(caller_id), int(callee_id)):
        try:
            with db._conn() as con:
                row = con.execute(
                    """
                    SELECT id FROM dm_channels
                    WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)
                    LIMIT 1
                    """,
                    (int(caller_id), int(callee_id), int(callee_id), int(caller_id)),
                ).fetchone()
            if row:
                return None
        except Exception:
            pass
        return "not_friends"
    return None


def _lookup_local_user_by_gid(gid: str) -> dict | None:
    g = str(gid or "").strip()
    if not g:
        return None
    with db._conn() as con:
        row = con.execute(
            "SELECT id, nickname, display_name, avatar, global_user_id "
            "FROM users WHERE global_user_id=? LIMIT 1",
            (g,),
        ).fetchone()
    return dict(row) if row else None


def _participants_match_gid(local_call_id: int, gid: str) -> bool:
    """True when ``gid`` resolves to one of the local call's participants."""
    if not local_call_id or not gid:
        return False
    user = _lookup_local_user_by_gid(gid)
    if not user:
        return False
    parts = db.get_call_participants_by_global_for_local(local_call_id)
    if not parts:
        return False
    uid = int(user["id"])
    return uid == parts[0] or uid == parts[1]


def enqueue_call_offer(
    caller: dict,
    callee: dict,
    *,
    global_call_id: str,
    local_call_id: int,
    call_type: str,
    sdp: str,
    fp_sig: str = "",
    renegotiate: bool = False,
) -> dict:
    targets = call_offer_target_servers(callee)
    if not targets:
        return {"ok": False, "error": "no_callee_route"}
    ident = db.get_or_create_local_server_identity() or {}
    origin = str(ident.get("server_id") or "").strip()
    db.map_federation_call(global_call_id, origin, local_call_id, "caller")
    caller_gid = str(caller.get("global_user_id") or "").strip()
    callee_gid = str(callee.get("global_user_id") or "").strip()
    sdp_clip = _clip_sdp(sdp)
    if not caller_gid or not callee_gid or not sdp_clip:
        return {"ok": False, "error": "invalid_offer_payload"}
    payload = {
        "global_call_id": global_call_id,
        "local_call_id_origin": int(local_call_id),
        "caller_global_user_id": caller_gid,
        "callee_global_user_id": callee_gid,
        "caller_nickname": str(caller.get("nickname") or "").strip(),
        "caller_avatar": _safe_avatar(caller.get("avatar")),
        "call_type": _safe_call_type(call_type),
        "sdp": sdp_clip,
        "fp_sig": str(fp_sig or "")[:_FED_CALL_FP_SIG_MAX],
    }
    if renegotiate:
        payload["renegotiate"] = True
    try:
        from routers import auth as _auth

        for sid in targets:
            base = _auth.resolve_server_base_url(sid)
            _auth._ensure_export_signer_pubkey_pinned(
                sid, base, user_id=int(caller.get("id") or 0),
            )
        _auth._ensure_export_signer_pubkey_pinned(
            origin, "", user_id=int(caller.get("id") or 0),
        )
    except Exception:
        pass
    return _enqueue("call.offer", payload, targets)


def enqueue_call_renegotiate(
    caller: dict,
    callee: dict,
    *,
    global_call_id: str,
    local_call_id: int,
    call_type: str,
    sdp: str,
    fp_sig: str = "",
) -> dict:
    """Mid-call SDP offer (screen share, camera-on) to callee's home node."""
    return enqueue_call_offer(
        caller,
        callee,
        global_call_id=global_call_id,
        local_call_id=local_call_id,
        call_type=call_type,
        sdp=sdp,
        fp_sig=fp_sig,
        renegotiate=True,
    )


def enqueue_call_answer(
    callee: dict,
    caller_gid: str,
    *,
    global_call_id: str,
    sdp: str,
    fp_sig: str = "",
    renegotiate: bool = False,
) -> dict:
    callee_gid = str(callee.get("global_user_id") or "").strip()
    caller_gid_clean = str(caller_gid or "").strip()
    sdp_clip = _clip_sdp(sdp)
    if not callee_gid or not caller_gid_clean or not sdp_clip:
        return {"ok": False, "error": "invalid_answer_payload"}
    targets = call_signal_target_servers(None, recipient_gid=caller_gid_clean)
    if not targets:
        return {"ok": False, "error": "no_caller_route"}
    payload = {
        "global_call_id": global_call_id,
        "callee_global_user_id": callee_gid,
        "caller_global_user_id": caller_gid_clean,
        "sdp": sdp_clip,
        "fp_sig": str(fp_sig or "")[:_FED_CALL_FP_SIG_MAX],
        "renegotiate": bool(renegotiate),
    }
    return _enqueue("call.answer", payload, targets)


def enqueue_call_ice(
    from_user: dict,
    to_gid: str,
    *,
    global_call_id: str,
    candidate: str,
) -> dict:
    from_gid = str(from_user.get("global_user_id") or "").strip()
    to_gid_clean = str(to_gid or "").strip()
    cand = _clip_ice(candidate)
    if not from_gid or not to_gid_clean or not cand:
        return {"ok": False, "error": "invalid_ice_payload"}
    targets = call_signal_target_servers(None, recipient_gid=to_gid_clean)
    if not targets:
        return {"ok": False, "error": "no_ice_route"}
    payload = {
        "global_call_id": global_call_id,
        "from_global_user_id": from_gid,
        "to_global_user_id": to_gid_clean,
        "candidate": cand,
    }
    return _enqueue("call.ice", payload, targets)


def enqueue_call_end(
    from_user: dict,
    to_gid: str,
    *,
    global_call_id: str,
    status: str = "ended",
) -> dict:
    to_gid_clean = str(to_gid or "").strip()
    targets = call_signal_target_servers(None, recipient_gid=to_gid_clean)
    if not targets:
        return {"ok": False, "error": "no_end_route"}
    safe_status = str(status or "ended").strip().lower()
    if safe_status not in ("ended", "missed", "cancelled"):
        safe_status = "ended"
    payload = {
        "global_call_id": global_call_id,
        "from_global_user_id": str(from_user.get("global_user_id") or "").strip(),
        "status": safe_status,
    }
    return _enqueue("call.end", payload, targets)


def fanout_dm_call_log(
    caller_id: int,
    callee_id: int,
    *,
    channel_id: int,
    content: str,
    created_at: str | None = None,
) -> None:
    """Mirror a [[CALLLOG]] DM row to peer nodes (missed/declined/ended on travel)."""
    if not federation_calls_enabled():
        return
    try:
        from datetime import datetime
        from routers.federation import enqueue_server_event

        caller = db.get_user_by_id(int(caller_id)) or {}
        callee = db.get_user_by_id(int(callee_id)) or {}
        if not caller or not callee:
            return
        targets: set[str] = set()
        for u in (caller, callee):
            gid = str(u.get("global_user_id") or "").strip()
            if gid:
                for sid in db.resolve_federation_push_targets_for_recipient_gids([gid]):
                    if sid:
                        targets.add(sid)
            for sid in call_offer_target_servers(u):
                if sid:
                    targets.add(sid)
        if not targets:
            return
        ts = created_at or (datetime.utcnow().isoformat() + "Z")
        enqueue_server_event(
            "dm.message.created",
            {
                "channel_id": int(channel_id or 0),
                "sender_nickname": str(caller.get("nickname") or "").strip(),
                "peer_nickname": str(callee.get("nickname") or "").strip(),
                "sender_global_user_id": str(caller.get("global_user_id") or "").strip(),
                "peer_global_user_id": str(callee.get("global_user_id") or "").strip(),
                "content": str(content or ""),
                "media_data": None,
                "media_type": None,
                "media_name": None,
                "reply_to": None,
                "media_blur": 0,
                "view_once": 0,
                "created_at": ts,
            },
            target_server_ids=sorted(targets),
        )
    except Exception:
        _log.exception("federation: fanout dm call log failed")


def enqueue_call_reject(
    callee: dict,
    caller_gid: str,
    *,
    global_call_id: str,
) -> dict:
    caller_gid_clean = str(caller_gid or "").strip()
    targets = call_signal_target_servers(None, recipient_gid=caller_gid_clean)
    if not targets:
        return {"ok": False, "error": "no_reject_route"}
    payload = {
        "global_call_id": global_call_id,
        "callee_global_user_id": str(callee.get("global_user_id") or "").strip(),
        "caller_global_user_id": caller_gid_clean,
    }
    return _enqueue("call.reject", payload, targets)


async def apply_call_event(event: dict) -> None:
    """Inbox apply for ``call.*`` events."""
    from routers.federation import _fed_clip, _fed_global_id, _fed_nickname

    if not federation_calls_enabled():
        _log.info("federation: drop %s — calls disabled", event.get("event_type"))
        return

    event_type = str(event.get("event_type") or "")
    payload = dict(event.get("payload") or {})
    origin = str(event.get("origin_server_id") or "").strip()
    if not origin:
        return
    gid_call = _fed_global_id(payload.get("global_call_id"))
    if not gid_call:
        return

    if event_type == "call.offer":
        await _apply_call_offer(payload, origin, gid_call, _fed_nickname, _fed_global_id, _fed_clip)
    elif event_type == "call.answer":
        await _apply_call_answer(payload, origin, gid_call, _fed_global_id)
    elif event_type == "call.ice":
        await _apply_call_ice(payload, origin, gid_call, _fed_global_id)
    elif event_type == "call.end":
        await _apply_call_end(payload, origin, gid_call, _fed_global_id)
    elif event_type == "call.reject":
        await _apply_call_reject(payload, origin, gid_call, _fed_global_id)


async def _apply_call_offer(payload, origin, gid_call, _fed_nickname, _fed_global_id, _fed_clip):
    from ws_manager import manager

    caller_gid = _fed_global_id(payload.get("caller_global_user_id"))
    callee_gid = _fed_global_id(payload.get("callee_global_user_id"))
    if not caller_gid or not callee_gid:
        _log.info("federation: drop call.offer — missing gid")
        return

    # Caller home binding: when we already know this user, their pinned home
    # must match the event origin. Unknown caller (first contact) is OK —
    # we'll pin their home on the upsert path below.
    if _call_home_origin_mismatch(caller_gid, origin):
        _log.info(
            "federation: drop call.offer — caller home != origin %s (untrusted relay)",
            origin,
        )
        return

    reneg_early = bool(payload.get("renegotiate"))
    if not reneg_early and _offer_throttled(origin, callee_gid):
        _log.warning(
            "federation: drop call.offer — flood from origin=%s callee_gid=%s",
            origin, callee_gid,
        )
        return

    # Strict callee lookup: never materialize a stub local user from a
    # foreign call.offer. The callee must already have an account here.
    callee = _lookup_local_user_by_gid(callee_gid)
    if not callee:
        _log.info("federation: drop call.offer — unknown local callee gid=%s", callee_gid)
        return

    caller_nick = _fed_nickname(payload.get("caller_nickname")) or "remote"
    caller_avatar = _safe_avatar(_fed_clip(payload.get("caller_avatar"), _FED_CALL_AVATAR_MAX))
    caller = db.ensure_federated_dm_local_user(
        caller_gid, caller_nick, origin_server_id=origin, avatar=caller_avatar,
    )
    if not caller:
        _log.info("federation: drop call.offer — caller upsert failed")
        return

    sdp = _fed_clip(payload.get("sdp"), _FED_CALL_SDP_MAX) or ""
    if not sdp:
        return
    fp_sig = _fed_clip(payload.get("fp_sig"), _FED_CALL_FP_SIG_MAX) or ""
    call_type = _safe_call_type(payload.get("call_type"))
    reneg = bool(payload.get("renegotiate"))

    if reneg:
        local_id = db.resolve_local_call_id(gid_call, origin) or db.resolve_local_call_id(gid_call)
        if not local_id:
            _log.info("federation: drop call.offer renegotiate — unknown call %s", gid_call)
            return
        if not _participants_match_gid(local_id, caller_gid):
            _log.info("federation: drop call.offer renegotiate — caller not participant")
            return
        if not _participants_match_gid(local_id, callee_gid):
            _log.info("federation: drop call.offer renegotiate — callee not participant")
            return
        offer_payload = {
            "type": "call_offer",
            "from_id": int(caller["id"]),
            "from_nickname": caller.get("nickname") or caller_nick,
            "call_type": call_type,
            "call_id": local_id,
            "global_call_id": gid_call,
            "sdp": sdp,
            "fp_sig": fp_sig,
            "renegotiate": True,
            "federated": True,
            "peer_home_server_id": origin,
            "origin_server_id": origin,
        }
        callee_id = int(callee["id"])
        delivered = await manager.send_to_user(callee_id, offer_payload)
        if not delivered:
            try:
                db.queue_call_signal(
                    local_id,
                    callee_id,
                    int(caller["id"]),
                    caller.get("nickname") or caller_nick,
                    "call_offer",
                    json.dumps(offer_payload),
                )
            except Exception:
                _log.exception("queue_call_signal(call_offer renegotiate fed) failed")
        return

    err = can_call_user(int(caller["id"]), int(callee["id"]))
    if err:
        _log.info("federation: drop call.offer — gate=%s", err)
        return

    local_id = db.resolve_local_call_id(gid_call, origin)
    if not local_id:
        local_id = db.create_call(
            int(caller["id"]),
            int(callee["id"]),
            call_type,
            global_call_id=gid_call,
        )
        ident = db.get_or_create_local_server_identity() or {}
        local_origin = str(ident.get("server_id") or "").strip()
        db.map_federation_call(gid_call, origin, local_id, "caller_remote")
        db.map_federation_call(gid_call, local_origin, local_id, "callee")

    db.save_pending_call_offer(
        local_id,
        int(caller["id"]),
        int(callee["id"]),
        caller.get("nickname") or caller_nick,
        caller.get("avatar"),
        call_type,
        sdp,
        fp_sig=fp_sig,
    )

    offer_payload = {
        "type": "call_offer",
        "from_id": int(caller["id"]),
        "from_nickname": caller.get("nickname") or caller_nick,
        "from_avatar": caller.get("avatar") or "",
        "call_type": call_type,
        "call_id": local_id,
        "global_call_id": gid_call,
        "sdp": sdp,
        "fp_sig": fp_sig,
        "federated": True,
        # The caller's home is the origin server that pushed this event.
        # Carrying it through lets the callee's createPC merge the
        # caller-side TURN servers via /api/network/ice-config.
        "peer_home_server_id": origin,
        "origin_server_id": origin,
    }
    callee_id = int(callee["id"])
    await manager.send_to_user(callee_id, offer_payload)
    try:
        from routers.ws import _push_always

        call_label = "Video" if call_type == "video" else "Voice"
        _push_always(
            callee_id,
            f"{call_label} call",
            f"{caller.get('nickname') or caller_nick} is calling…",
            "/app",
            kind="call",
            tag=f"ft-call-{local_id}",
            require_interaction=True,
            extra={
                "call_id": local_id,
                "global_call_id": gid_call,
                "from_nickname": caller.get("nickname") or caller_nick,
                "from_avatar": caller.get("avatar") or "",
                "call_type": call_type,
                "federated": True,
            },
        )
    except Exception:
        _log.exception("federated call.offer push failed")


async def _apply_call_answer(payload, origin, gid_call, _fed_global_id):
    from ws_manager import manager

    callee_gid = _fed_global_id(payload.get("callee_global_user_id"))
    caller_gid = _fed_global_id(payload.get("caller_global_user_id"))
    if not callee_gid or not caller_gid:
        return

    # The answerer (callee) lives on the origin peer. Bind their home so a
    # third peer can't forge an answer for a call hosted elsewhere.
    if _call_home_origin_mismatch(callee_gid, origin):
        _log.info("federation: drop call.answer — callee home != origin %s", origin)
        return

    local_id = db.resolve_local_call_id(gid_call)
    if not local_id:
        return

    # Both gids must map onto the actual participants of the local row.
    if not _participants_match_gid(local_id, callee_gid):
        _log.info("federation: drop call.answer — callee not participant")
        return
    if not _participants_match_gid(local_id, caller_gid):
        _log.info("federation: drop call.answer — caller not participant")
        return

    callee_user = _lookup_local_user_by_gid(callee_gid)
    caller_user = _lookup_local_user_by_gid(caller_gid)
    if not callee_user or not caller_user:
        return

    sdp = str(payload.get("sdp") or "")[:_FED_CALL_SDP_MAX]
    if not sdp:
        return
    reneg = bool(payload.get("renegotiate"))
    if not reneg:
        db.update_call_status(local_id, "active", started_at=datetime.utcnow().isoformat())
        db.delete_pending_call_offer(local_id)

    ans = {
        "type": "call_answer",
        "from_id": int(callee_user["id"]),
        "from_nickname": callee_user.get("nickname") or "",
        "call_id": local_id,
        "global_call_id": gid_call,
        "sdp": sdp,
        "fp_sig": str(payload.get("fp_sig") or "")[:_FED_CALL_FP_SIG_MAX],
        "renegotiate": reneg,
        "federated": True,
        # The answerer's home == origin. Caller updates _peerHomeServerId
        # in handleCallAnswer so any later ICE-restart pulls the right
        # peer TURN bundle (see calls.js).
        "peer_home_server_id": origin,
        "origin_server_id": origin,
    }
    delivered = await manager.send_to_user(int(caller_user["id"]), ans)
    if not delivered:
        try:
            db.queue_call_signal(
                local_id, int(caller_user["id"]), int(callee_user["id"]),
                callee_user.get("nickname") or "",
                "call_answer",
                json.dumps(ans),
            )
        except Exception:
            _log.exception("queue_call_signal(call_answer fed) failed")


async def _apply_call_ice(payload, origin, gid_call, _fed_global_id):
    from ws_manager import manager

    to_gid = _fed_global_id(payload.get("to_global_user_id"))
    from_gid = _fed_global_id(payload.get("from_global_user_id"))
    if not to_gid or not from_gid:
        return

    if _call_home_origin_mismatch(from_gid, origin):
        _log.info("federation: drop call.ice — sender home != origin %s", origin)
        return

    local_id = db.resolve_local_call_id(gid_call)
    if not local_id:
        return
    if not _participants_match_gid(local_id, from_gid):
        return
    if not _participants_match_gid(local_id, to_gid):
        return

    to_user = _lookup_local_user_by_gid(to_gid)
    from_user = _lookup_local_user_by_gid(from_gid)
    if not to_user or not from_user:
        return

    cand_raw = payload.get("candidate")
    if cand_raw is None:
        return
    cand = _clip_ice(cand_raw)
    if not cand:
        return
    ice_payload = {
        "type": "ice_candidate",
        "from_id": int(from_user["id"]),
        "from_nickname": from_user.get("nickname") or "",
        "call_id": local_id,
        "global_call_id": gid_call,
        "candidate": cand,
        "federated": True,
    }
    delivered = await manager.send_to_user(int(to_user["id"]), ice_payload)
    if not delivered and cand:
        try:
            db.queue_ice_candidate(
                local_id, int(to_user["id"]),
                from_user.get("nickname") or "", cand,
            )
        except Exception:
            _log.exception("queue_ice_candidate(fed) failed")


async def _apply_call_end(payload, origin, gid_call, _fed_global_id):
    from ws_manager import manager

    from_gid = _fed_global_id(payload.get("from_global_user_id"))
    if not from_gid:
        return

    if _call_home_origin_mismatch(from_gid, origin):
        _log.info("federation: drop call.end — sender home != origin %s", origin)
        return

    local_id = db.resolve_local_call_id(gid_call)
    if not local_id:
        return
    if not _participants_match_gid(local_id, from_gid):
        return

    parts = db.get_call_participants_by_global(gid_call)
    if not parts:
        return
    caller_id, callee_id = parts
    from_user = _lookup_local_user_by_gid(from_gid)
    from_id = int(from_user["id"]) if from_user else 0
    to_id = callee_id if from_id == caller_id else caller_id

    safe_status = str(payload.get("status") or "ended").strip().lower()
    if safe_status not in ("ended", "missed", "cancelled"):
        safe_status = "ended"
    ended_at = datetime.utcnow().isoformat()
    if safe_status == "missed":
        db.update_call_status(local_id, "missed", ended_at=ended_at)
        had_pending = False
        try:
            with db._conn() as con:
                had_pending = bool(con.execute(
                    "SELECT 1 FROM pending_call_offers WHERE call_id=? LIMIT 1",
                    (int(local_id),),
                ).fetchone())
        except Exception:
            had_pending = False
        if had_pending:
            _log.info(
                "federation: suppress missed-call push — offer never delivered call=%s",
                local_id,
            )
        else:
            try:
                from routers.ws import _push_always

                caller = db.get_user_by_id(int(caller_id)) or {}
                call_type = "voice"
                with db._conn() as con:
                    row = con.execute(
                        "SELECT call_type FROM calls WHERE id=?",
                        (int(local_id),),
                    ).fetchone()
                if row and row.get("call_type") in _FED_CALL_TYPES:
                    call_type = str(row.get("call_type"))
                call_label = "video" if call_type == "video" else "voice"
                _push_always(
                    int(callee_id),
                    "📵 Missed call",
                    f"Missed a {call_label} call from {caller.get('nickname') or 'someone'}",
                    "/app",
                    kind="missed_call",
                    tag=f"ft-missed-{local_id}",
                    require_interaction=False,
                )
            except Exception:
                _log.exception("federation: failed to emit missed-call log/push")
    else:
        db.update_call_status(local_id, "ended", ended_at=ended_at)
    db.delete_pending_call_offer(local_id)
    await manager.send_to_user(to_id, {
        "type": "call_end",
        "from_id": from_id,
        "call_id": local_id,
        "global_call_id": gid_call,
        "status": safe_status,
    })


async def _apply_call_reject(payload, origin, gid_call, _fed_global_id):
    from ws_manager import manager

    callee_gid = _fed_global_id(payload.get("callee_global_user_id"))
    if not callee_gid:
        return

    if _call_home_origin_mismatch(callee_gid, origin):
        _log.info("federation: drop call.reject — callee home != origin %s", origin)
        return

    local_id = db.resolve_local_call_id(gid_call)
    if not local_id:
        return
    if not _participants_match_gid(local_id, callee_gid):
        return

    parts = db.get_call_participants_by_global(gid_call)
    if not parts:
        return
    caller_id, _callee_id = parts
    db.update_call_status(local_id, "rejected", ended_at=datetime.utcnow().isoformat())
    db.delete_pending_call_offer(local_id)
    await manager.send_to_user(caller_id, {
        "type": "call_reject",
        "call_id": local_id,
        "global_call_id": gid_call,
        "federated": True,
    })
