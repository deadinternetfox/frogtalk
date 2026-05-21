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


def _enqueue(event_type: str, payload: dict, target_server_ids: list[str]) -> dict:
    from routers import federation as fed

    return fed.enqueue_server_event(
        event_type,
        payload,
        target_server_ids=target_server_ids,
    )


def callee_home_server(callee_user: dict) -> str:
    gid = str((callee_user or {}).get("global_user_id") or "").strip()
    if gid:
        return db.resolve_global_user_home_server_id(gid)
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


def is_remote_peer(callee_user: dict) -> bool:
    return user_home_is_remote(callee_user)


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
) -> dict:
    home = callee_home_server(callee)
    if not home:
        return {"ok": False, "error": "no_callee_home"}
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
    return _enqueue("call.offer", payload, [home])


def enqueue_call_answer(
    callee: dict,
    caller_gid: str,
    *,
    global_call_id: str,
    sdp: str,
    fp_sig: str = "",
    renegotiate: bool = False,
) -> dict:
    home = db.resolve_global_user_home_server_id(caller_gid)
    if not home:
        return {"ok": False, "error": "no_caller_home"}
    callee_gid = str(callee.get("global_user_id") or "").strip()
    caller_gid_clean = str(caller_gid or "").strip()
    sdp_clip = _clip_sdp(sdp)
    if not callee_gid or not caller_gid_clean or not sdp_clip:
        return {"ok": False, "error": "invalid_answer_payload"}
    payload = {
        "global_call_id": global_call_id,
        "callee_global_user_id": callee_gid,
        "caller_global_user_id": caller_gid_clean,
        "sdp": sdp_clip,
        "fp_sig": str(fp_sig or "")[:_FED_CALL_FP_SIG_MAX],
        "renegotiate": bool(renegotiate),
    }
    return _enqueue("call.answer", payload, [home])


def enqueue_call_ice(
    from_user: dict,
    to_gid: str,
    *,
    global_call_id: str,
    candidate: str,
) -> dict:
    home = db.resolve_global_user_home_server_id(to_gid)
    if not home:
        return {"ok": False, "error": "no_peer_home"}
    from_gid = str(from_user.get("global_user_id") or "").strip()
    to_gid_clean = str(to_gid or "").strip()
    cand = _clip_ice(candidate)
    if not from_gid or not to_gid_clean or not cand:
        return {"ok": False, "error": "invalid_ice_payload"}
    payload = {
        "global_call_id": global_call_id,
        "from_global_user_id": from_gid,
        "to_global_user_id": to_gid_clean,
        "candidate": cand,
    }
    return _enqueue("call.ice", payload, [home])


def enqueue_call_end(
    from_user: dict,
    to_gid: str,
    *,
    global_call_id: str,
    status: str = "ended",
) -> dict:
    home = db.resolve_global_user_home_server_id(to_gid)
    if not home:
        return {"ok": False, "error": "no_peer_home"}
    safe_status = str(status or "ended").strip().lower()
    if safe_status not in ("ended", "missed", "cancelled"):
        safe_status = "ended"
    payload = {
        "global_call_id": global_call_id,
        "from_global_user_id": str(from_user.get("global_user_id") or "").strip(),
        "status": safe_status,
    }
    return _enqueue("call.end", payload, [home])


def enqueue_call_reject(
    callee: dict,
    caller_gid: str,
    *,
    global_call_id: str,
) -> dict:
    home = db.resolve_global_user_home_server_id(caller_gid)
    if not home:
        return {"ok": False, "error": "no_caller_home"}
    payload = {
        "global_call_id": global_call_id,
        "callee_global_user_id": str(callee.get("global_user_id") or "").strip(),
        "caller_global_user_id": str(caller_gid or "").strip(),
    }
    return _enqueue("call.reject", payload, [home])


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
    known_home = db.resolve_global_user_home_server_id(caller_gid)
    if known_home and known_home != origin:
        _log.info(
            "federation: drop call.offer — caller home %s != origin %s",
            known_home, origin,
        )
        return

    if _offer_throttled(origin, callee_gid):
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

    err = can_call_user(int(caller["id"]), int(callee["id"]))
    if err:
        _log.info("federation: drop call.offer — gate=%s", err)
        return

    sdp = _fed_clip(payload.get("sdp"), _FED_CALL_SDP_MAX) or ""
    if not sdp:
        return
    fp_sig = _fed_clip(payload.get("fp_sig"), _FED_CALL_FP_SIG_MAX) or ""
    call_type = _safe_call_type(payload.get("call_type"))

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
    known_home = db.resolve_global_user_home_server_id(callee_gid)
    if known_home and known_home != origin:
        _log.info("federation: drop call.answer — callee home != origin")
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

    known_home = db.resolve_global_user_home_server_id(from_gid)
    if known_home and known_home != origin:
        _log.info("federation: drop call.ice — sender home != origin")
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

    known_home = db.resolve_global_user_home_server_id(from_gid)
    if known_home and known_home != origin:
        _log.info("federation: drop call.end — sender home != origin")
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
        try:
            from routers.ws import _emit_dm_call_log, _push_always

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
            await _emit_dm_call_log(
                int(caller_id),
                int(callee_id),
                call_type,
                "Missed call",
                f"Missed a {call_label} call from {caller.get('nickname') or 'someone'}",
                "📵",
                "missed",
            )
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

    known_home = db.resolve_global_user_home_server_id(callee_gid)
    if known_home and known_home != origin:
        _log.info("federation: drop call.reject — callee home != origin")
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
