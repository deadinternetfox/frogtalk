"""Federated channel voice (voice.* events) + session registry.

Hardening notes:

- ``voice.*`` is in ``_SENSITIVE_PREFIXES`` so every inbound event carries a
  pinned-server Ed25519 signature.
- Inbound ``voice.session.join`` / ``voice.session.leave`` / ``voice.signal``
  bind the actor GID's pinned home to the event's ``origin_server_id``. A
  peer cannot announce a join on behalf of users it does not host.
- ``voice.session.join`` requires the joining user to be a member of the
  room (or the room to be ``private=0``). Non-members get rejected, which
  stops a hostile peer from advertising arbitrary GIDs into someone else's
  room roster.
- ``voice.signal`` requires both endpoints to be tracked as currently
  voice-active for the room — either as local voice participants
  (``ws_manager.voice_manager``) or as registered remote participants. This
  blocks bystanders from spraying SDP/ICE at users who are not in voice.
- Session IDs are derived deterministically from
  ``room_name | anchor_server_id`` so every node converges on the same
  ``global_voice_session_id`` and we don't fork the roster on a race.
- Roster trim: cap remote participants per session to a hard limit and per
  origin server to a per-origin limit, defending against memory blow-up
  from a misbehaving peer.
- Avatar/nickname go through the federation sanitizers so XSS payloads in
  nicknames or hostile avatar URL schemes can't reach clients.
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from typing import Any

import database as db
from fed_turn import federation_calls_enabled, federation_voice_enabled, voice_sfu_enabled

_log = logging.getLogger(__name__)

# Per-session and per-origin caps protect the in-memory registry.
_REMOTE_PER_SESSION_CAP = 64
_REMOTE_PER_ORIGIN_CAP = 256


def _safe_avatar(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    low = raw.lower()
    if not (low.startswith("data:image/") or low.startswith("http://") or low.startswith("https://")):
        return ""
    return raw[:200 * 1024]


def deterministic_session_id(room_name: str, anchor_server_id: str) -> str:
    """Stable cross-node session id for ``(room, anchor)`` pair.

    Using a deterministic id ensures every peer that observes the same
    anchor agrees on the session, so two nodes won't fork into competing
    rosters during a races.
    """
    room = (room_name or "").strip().lower()
    anchor = (anchor_server_id or "").strip().lower()
    digest = hashlib.sha256(f"{anchor}|{room}".encode("utf-8")).digest()
    return str(uuid.UUID(bytes=digest[:16], version=4))


class FederatedVoiceRegistry:
    """Remote participants in voice channels (per room session)."""

    def __init__(self) -> None:
        # room_name -> session_id
        self._room_session: dict[str, str] = {}
        # session_id -> list of remote participant dicts
        self._remote: dict[str, list[dict[str, Any]]] = {}
        # origin_server_id -> count of remote rosters tied to it
        self._origin_count: dict[str, int] = {}

    def session_for_room(self, room_name: str) -> str:
        """Return the session id for ``room_name``.

        Prefer an existing room binding (set by inbound ``voice.session.join``)
        so ``session_for_room`` does not fork rosters that live under another
        node's anchor-derived id.  Only derive a new id when unbound.
        """
        room = (room_name or "").strip().lower()
        if not room:
            return ""
        bound = self._room_session.get(room, "")
        if bound:
            return bound
        anchor = room_anchor_server_id(room)
        sid = deterministic_session_id(room, anchor)
        self._room_session[room] = sid
        return sid

    def add_remote(
        self,
        session_id: str,
        *,
        global_user_id: str,
        nickname: str,
        home_server_id: str,
        avatar: str = "",
        room_name: str = "",
    ) -> bool:
        sid = (session_id or "").strip()
        gid = (global_user_id or "").strip()
        home = (home_server_id or "").strip()
        if not sid or not gid or not home:
            return False
        lst = self._remote.setdefault(sid, [])
        for p in lst:
            if p.get("global_user_id") == gid:
                p.update({
                    "nickname": nickname,
                    "home_server_id": home,
                    "avatar": avatar,
                    "federated": True,
                })
                return True
        if len(lst) >= _REMOTE_PER_SESSION_CAP:
            _log.warning("federation: voice roster cap reached for sid=%s", sid)
            return False
        if self._origin_count.get(home, 0) >= _REMOTE_PER_ORIGIN_CAP:
            _log.warning(
                "federation: per-origin remote roster cap reached for %s", home
            )
            return False
        lst.append({
            "global_user_id": gid,
            "nickname": nickname,
            "home_server_id": home,
            "avatar": avatar,
            "federated": True,
            "user_id": 0,
        })
        self._origin_count[home] = self._origin_count.get(home, 0) + 1
        if room_name:
            self._room_session[(room_name or "").strip().lower()] = sid
        return True

    def remove_remote(self, session_id: str, global_user_id: str) -> dict | None:
        sid = (session_id or "").strip()
        gid = (global_user_id or "").strip()
        if not sid or not gid:
            return None
        lst = self._remote.get(sid, [])
        removed: dict | None = None
        keep: list[dict] = []
        for p in lst:
            if p.get("global_user_id") == gid and removed is None:
                removed = p
            else:
                keep.append(p)
        self._remote[sid] = keep
        if removed:
            home = str(removed.get("home_server_id") or "")
            if home and self._origin_count.get(home, 0) > 0:
                self._origin_count[home] -= 1
        return removed

    def remotes_for_room(self, room_name: str) -> list[dict]:
        room = (room_name or "").strip().lower()
        if not room:
            return []
        sid = self._room_session.get(room, "")
        if sid:
            remotes = list(self._remote.get(sid, []))
            if remotes:
                return remotes
        # Roster may live under the local anchor sid while the room is still
        # unbound (e.g. before the first inbound join sets the mapping).
        anchor = room_anchor_server_id(room)
        alt = deterministic_session_id(room, anchor)
        if alt and alt != sid:
            alt_remotes = list(self._remote.get(alt, []))
            if alt_remotes:
                self._room_session[room] = alt
                return alt_remotes
        return list(self._remote.get(sid, [])) if sid else []

    def is_remote_in_room(self, room_name: str, global_user_id: str) -> bool:
        gid = (global_user_id or "").strip()
        if not gid:
            return False
        return any(p.get("global_user_id") == gid for p in self.remotes_for_room(room_name))

    def clear_room(self, room_name: str) -> None:
        room = (room_name or "").strip().lower()
        sid = self._room_session.pop(room, "")
        if not sid:
            return
        for p in self._remote.get(sid, []):
            home = str(p.get("home_server_id") or "")
            if home and self._origin_count.get(home, 0) > 0:
                self._origin_count[home] -= 1
        self._remote.pop(sid, None)


federated_voice_registry = FederatedVoiceRegistry()


def room_anchor_server_id(room_name: str) -> str:
    room = db.get_room_by_name(room_name)
    if not room:
        ident = db.get_or_create_local_server_identity() or {}
        return str(ident.get("server_id") or "").strip()
    owner_id = int(room.get("owner_id") or 0)
    if owner_id:
        u = db.get_user_by_id(owner_id)
        if u and u.get("global_user_id"):
            home = db.resolve_global_user_home_server_id(str(u["global_user_id"]))
            if home:
                return home
    ident = db.get_or_create_local_server_identity() or {}
    return str(ident.get("server_id") or "").strip()


def _room_member_gids(room_id: int) -> set[str]:
    with db._conn() as con:
        rows = con.execute(
            """
            SELECT u.global_user_id FROM room_members rm
            JOIN users u ON u.id = rm.user_id
            WHERE rm.room_id=?
            """,
            (int(room_id),),
        ).fetchall()
    return {str(r["global_user_id"] or "").strip() for r in rows if r["global_user_id"]}


def member_home_servers_for_room(room_name: str) -> list[str]:
    """Peer server_ids that may host members currently in this room."""
    room = db.get_room_by_name(room_name)
    if not room:
        return []
    ident = db.get_or_create_local_server_identity() or {}
    local_sid = str(ident.get("server_id") or "").strip()
    targets: set[str] = set()
    for gid in _room_member_gids(int(room["id"])):
        if not gid:
            continue
        for sid in db.resolve_federation_push_targets_for_recipient_gids([gid]):
            if sid:
                targets.add(sid)
    targets.discard(local_sid)
    return sorted(targets)


def _enqueue(event_type: str, payload: dict, target_server_ids: list[str]) -> dict:
    from routers import federation as fed

    return fed.enqueue_server_event(event_type, payload, target_server_ids=target_server_ids)


def enqueue_voice_session_join(
    user: dict,
    room_name: str,
    *,
    session_id: str,
    anchor_server_id: str,
) -> dict:
    targets = member_home_servers_for_room(room_name)
    ident = db.get_or_create_local_server_identity() or {}
    local_sid = str(ident.get("server_id") or "").strip()
    if anchor_server_id and anchor_server_id != local_sid:
        targets = sorted(set(targets) | {anchor_server_id})
    payload = {
        "global_voice_session_id": session_id,
        "room_name": room_name,
        "global_user_id": str(user.get("global_user_id") or "").strip(),
        "nickname": str(user.get("nickname") or "").strip(),
        "avatar": _safe_avatar(user.get("avatar")),
        "anchor_server_id": anchor_server_id,
    }
    if not targets:
        return {"ok": True, "local_only": True}
    return _enqueue("voice.session.join", payload, targets)


def enqueue_voice_session_leave(
    user: dict,
    room_name: str,
    *,
    session_id: str,
) -> dict:
    targets = member_home_servers_for_room(room_name)
    payload = {
        "global_voice_session_id": session_id,
        "room_name": room_name,
        "global_user_id": str(user.get("global_user_id") or "").strip(),
    }
    if not targets:
        return {"ok": True}
    return _enqueue("voice.session.leave", payload, targets)


def voice_signal_target_servers(
    to_gid: str,
    session_id: str,
    *,
    room_name: str = "",
) -> list[str]:
    """Servers that may host the callee's active voice session.

    Account home alone is insufficient for travelers: also include the
    federation origin that announced their ``voice.session.join`` (stored on
    remote roster rows as ``home_server_id``).
    """
    gid = str(to_gid or "").strip()
    vsid = str(session_id or "").strip()
    if not gid:
        return []
    targets: set[str] = set()
    home = db.resolve_global_user_home_server_id(gid)
    if home:
        targets.add(home)
    for conn_sid in db.get_federation_user_connection_servers(gid):
        if conn_sid:
            targets.add(conn_sid)
    for p in federated_voice_registry._remote.get(vsid, []):
        if str(p.get("global_user_id") or "").strip() != gid:
            continue
        origin = str(p.get("home_server_id") or "").strip()
        if origin:
            targets.add(origin)
        break
    ident = db.get_or_create_local_server_identity() or {}
    local_sid = str(ident.get("server_id") or "").strip()
    if local_sid:
        targets.discard(local_sid)
    return sorted(targets)


def should_route_voice_signal_federated(
    room_name: str,
    to_global_user_id: str,
    *,
    locally_in_voice: bool,
) -> bool:
    """True when WebRTC signaling for ``to_global_user_id`` must cross federation."""
    gid = str(to_global_user_id or "").strip()
    if not gid:
        return False
    if federated_voice_registry.is_remote_in_room(room_name, gid):
        return True
    return not locally_in_voice


def enqueue_voice_signal(
    from_user: dict,
    to_gid: str,
    *,
    session_id: str,
    room_name: str,
    kind: str,
    sdp: str = "",
    candidate: str = "",
) -> dict:
    safe_kind = str(kind or "").strip().lower()
    if safe_kind not in ("offer", "answer", "ice"):
        return {"ok": False, "error": "bad_kind"}
    targets = voice_signal_target_servers(to_gid, session_id, room_name=room_name)
    if not targets:
        return {"ok": False, "error": "no_peer_route"}
    payload = {
        "global_voice_session_id": session_id,
        "room_name": room_name,
        "from_global_user_id": str(from_user.get("global_user_id") or "").strip(),
        "to_global_user_id": to_gid,
        "kind": safe_kind,
        "sdp": (sdp or "")[:32768],
        "candidate": (candidate or "")[:8192],
    }
    return _enqueue("voice.signal", payload, targets)


async def apply_voice_event(event: dict) -> None:
    from routers.federation import _fed_global_id, _fed_nickname, _fed_clip

    if not federation_voice_enabled() or voice_sfu_enabled():
        return

    event_type = str(event.get("event_type") or "")
    payload = dict(event.get("payload") or {})
    origin = str(event.get("origin_server_id") or "").strip()
    if not origin:
        return
    session_id = _fed_global_id(payload.get("global_voice_session_id"))
    room_name = str(payload.get("room_name") or "").strip().lower()
    if not session_id or not room_name:
        return
    room = db.get_room_by_name(room_name)
    if not room:
        # Don't broadcast for rooms we don't know — prevents foreign peers
        # from injecting "ghost" voice notifications for non-existent rooms.
        return

    if event_type == "voice.session.join":
        await _apply_voice_join(
            payload, origin, session_id, room_name, room,
            _fed_global_id, _fed_nickname, _fed_clip,
        )
    elif event_type == "voice.session.leave":
        await _apply_voice_leave(
            payload, origin, session_id, room_name, _fed_global_id,
        )
    elif event_type == "voice.signal":
        await _apply_voice_signal(
            payload, origin, session_id, room_name, _fed_global_id,
        )


def _bind_actor_origin(gid: str, origin: str) -> bool:
    """True when origin may assert voice state for ``gid``.

    Account home may differ from the node the user is connected to (travel).
    Accept any enabled federation peer as relay origin, same as ``call.*``.
    """
    from federation_calls import _relay_origin_allowed

    oid = str(origin or "").strip()
    if not oid:
        return False
    home = db.resolve_global_user_home_server_id(str(gid or "").strip())
    if not home or home == oid:
        return True
    return _relay_origin_allowed(oid)


async def _apply_voice_join(
    payload, origin, session_id, room_name, room,
    _fed_global_id, _fed_nickname, _fed_clip,
):
    from ws_manager import manager, voice_manager

    gid = _fed_global_id(payload.get("global_user_id"))
    if not gid:
        return
    if not _bind_actor_origin(gid, origin):
        _log.info("federation: drop voice.session.join — actor home != origin")
        return

    # Room membership: a peer can only announce voice presence for users
    # that are room members. Travel mirrors may lack full member rows but
    # still grant access via synced allowlists / local membership checks.
    if int(room.get("private") or 0) == 1:
        members = _room_member_gids(int(room["id"]))
        if gid not in members:
            with db._conn() as con:
                row = con.execute(
                    "SELECT id FROM users WHERE global_user_id=? LIMIT 1",
                    (gid,),
                ).fetchone()
            uid = int(row["id"]) if row else 0
            if uid <= 0 or not db.user_can_access_room(uid, room_name):
                _log.info("federation: drop voice.session.join — not a member")
                return

    nick = _fed_nickname(payload.get("nickname")) or "remote"
    avatar = _safe_avatar(_fed_clip(payload.get("avatar"), 200 * 1024))

    if voice_manager.is_in_voice_by_gid(room_name, gid):
        _log.info("federation: skip voice.session.join — user already local in voice")
        return

    if not federated_voice_registry.add_remote(
        session_id,
        global_user_id=gid,
        nickname=nick,
        home_server_id=origin,
        avatar=avatar,
        room_name=room_name,
    ):
        return
    try:
        db.upsert_federation_voice_remote(session_id, gid, nick, origin, avatar)
    except Exception:
        _log.exception("upsert_federation_voice_remote failed")

    await manager.broadcast_room(room_name, {
        "type": "voice_user_joined",
        "room": room_name,
        "user_id": 0,
        "global_user_id": gid,
        "nickname": nick,
        "avatar": avatar,
        "federated": True,
        "participants": participants_for_room(room_name, voice_manager),
    })


async def _apply_voice_leave(payload, origin, session_id, room_name, _fed_global_id):
    from ws_manager import manager, voice_manager

    gid = _fed_global_id(payload.get("global_user_id"))
    if not gid:
        return
    if not _bind_actor_origin(gid, origin):
        _log.info("federation: drop voice.session.leave — actor home != origin")
        return

    federated_voice_registry.remove_remote(session_id, gid)
    try:
        db.remove_federation_voice_remote(session_id, gid)
    except Exception:
        _log.exception("remove_federation_voice_remote failed")

    await manager.broadcast_room(room_name, {
        "type": "voice_user_left",
        "room": room_name,
        "user_id": 0,
        "global_user_id": gid,
        "federated": True,
        "participants": participants_for_room(room_name, voice_manager),
    })


def _dedupe_voice_participants(parts: list) -> list:
    """One roster row per ``global_user_id``; prefer local over federated."""
    by_gid: dict[str, dict] = {}
    no_gid: list[dict] = []
    seen_uid: set[int] = set()
    for p in parts or []:
        if not isinstance(p, dict):
            continue
        gid = str(p.get("global_user_id") or "").strip()
        uid = int(p.get("user_id") or 0)
        if gid:
            cur = by_gid.get(gid)
            if cur is None:
                by_gid[gid] = p
            elif cur.get("federated") and not p.get("federated"):
                by_gid[gid] = p
        elif uid:
            if uid in seen_uid:
                continue
            seen_uid.add(uid)
            no_gid.append(p)
    return no_gid + list(by_gid.values())


def clear_local_remote_voice_duplicate(room_name: str, global_user_id: str) -> None:
    """Drop federated roster row when the same user joins locally."""
    gid = str(global_user_id or "").strip()
    if not gid or not federated_voice_registry.is_remote_in_room(room_name, gid):
        return
    sid = federated_voice_registry.session_for_room(room_name)
    if not sid:
        return
    federated_voice_registry.remove_remote(sid, gid)
    try:
        db.remove_federation_voice_remote(sid, gid)
    except Exception:
        _log.exception("remove_federation_voice_remote after local join failed")


def _combined_participants(room_name: str, voice_manager) -> list:
    local: list[dict] = []
    for p in voice_manager.participants(room_name):
        uid = int(p.get("user_id") or 0)
        gid = str(p.get("global_user_id") or "").strip()
        if not gid and uid:
            u = db.get_user_by_id(uid) or {}
            gid = str(u.get("global_user_id") or "").strip()
        local.append({
            "user_id": uid,
            "nickname": p.get("nickname") or "",
            "avatar": p.get("avatar") or "",
            "global_user_id": gid,
            "home_server_id": "",
            "federated": False,
        })
    remote = federated_voice_registry.remotes_for_room(room_name)
    return _dedupe_voice_participants(local + remote)


def peers_for_joiner(room_name: str, voice_manager, user: dict) -> list[dict]:
    """Voice peers the joiner should mesh with (same roster as presence API, minus self)."""
    my_uid = int((user or {}).get("id") or 0)
    my_gid = str((user or {}).get("global_user_id") or "").strip()
    peers: list[dict] = []
    for p in participants_for_room(room_name, voice_manager):
        uid = int(p.get("user_id") or 0)
        gid = str(p.get("global_user_id") or "").strip()
        if my_gid and gid == my_gid:
            continue
        if my_uid and uid == my_uid:
            continue
        peers.append(p)
    return peers


def participants_for_room(room_name: str, voice_manager) -> list[dict]:
    """Local + federated voice roster, rehydrating DB rows into the registry."""
    room = (room_name or "").strip().lower()
    sid = federated_voice_registry.session_for_room(room)
    combined = _combined_participants(room, voice_manager)
    if not sid:
        return combined
    seen = {
        str(p.get("global_user_id") or "").strip()
        for p in combined
        if str(p.get("global_user_id") or "").strip()
    }
    try:
        db_remotes = db.list_federation_voice_remote(sid)
    except Exception:
        db_remotes = []
    for raw in db_remotes:
        gid = str(raw.get("global_user_id") or "").strip()
        if not gid or gid in seen:
            continue
        nick = str(raw.get("nickname") or "remote").strip() or "remote"
        home = str(raw.get("home_server_id") or "").strip()
        avatar = str(raw.get("avatar") or "")
        federated_voice_registry.add_remote(
            sid,
            global_user_id=gid,
            nickname=nick,
            home_server_id=home,
            avatar=avatar,
            room_name=room,
        )
        combined.append(dict(raw))
        seen.add(gid)
    return _dedupe_voice_participants(combined)


def _remote_in_room(room_name: str, global_user_id: str, voice_manager) -> bool:
    gid = str(global_user_id or "").strip()
    if not gid:
        return False
    if federated_voice_registry.is_remote_in_room(room_name, gid):
        return True
    participants_for_room(room_name, voice_manager)
    return federated_voice_registry.is_remote_in_room(room_name, gid)


def _local_user_in_voice(room_name: str, user_id: int, voice_manager) -> bool:
    try:
        return any(int(p.get("user_id") or 0) == int(user_id) for p in voice_manager.participants(room_name))
    except Exception:
        return False


async def _apply_voice_signal(payload, origin, session_id, room_name, _fed_global_id):
    from ws_manager import manager, voice_manager

    to_gid = _fed_global_id(payload.get("to_global_user_id"))
    from_gid = _fed_global_id(payload.get("from_global_user_id"))
    kind = str(payload.get("kind") or "").strip().lower()
    if kind not in ("offer", "answer", "ice"):
        return
    if not to_gid or not from_gid:
        return
    if not _bind_actor_origin(from_gid, origin):
        _log.info("federation: drop voice.signal — sender home != origin")
        return

    # Sender must be in the federated voice roster.  Offers may arrive on the
    # callee node before ``voice.session.join`` is processed; register the
    # sender from the signed origin so mesh setup is not dropped on latency.
    if not _remote_in_room(room_name, from_gid, voice_manager):
        if kind == "offer" and session_id:
            federated_voice_registry.add_remote(
                session_id,
                global_user_id=from_gid,
                nickname="remote",
                home_server_id=origin,
                room_name=room_name,
            )
        if not _remote_in_room(room_name, from_gid, voice_manager):
            _log.info("federation: drop voice.signal — sender not in voice roster")
            return

    # Receiver must be a local user currently in voice for this room.
    with db._conn() as con:
        row = con.execute(
            "SELECT id, nickname FROM users WHERE global_user_id=? LIMIT 1",
            (to_gid,),
        ).fetchone()
        fr = (
            con.execute(
                "SELECT id, nickname FROM users WHERE global_user_id=? LIMIT 1",
                (from_gid,),
            ).fetchone()
            if from_gid
            else None
        )
    if not row:
        return
    to_id = int(row["id"])
    if not _local_user_in_voice(room_name, to_id, voice_manager):
        _log.info("federation: drop voice.signal — receiver not in voice")
        return

    from_nick = ""
    from_uid = 0
    if fr:
        from_uid = int(fr["id"])
        from_nick = str(fr["nickname"] or "")

    if kind == "offer":
        msg = {
            "type": "voice_offer",
            "from_id": from_uid,
            "from_global_user_id": from_gid,
            "from_nickname": from_nick,
            "sdp": str(payload.get("sdp") or "")[:32768],
            "room": room_name,
            "session_id": session_id,
            "federated": True,
            "origin_server_id": origin,
            "peer_home_server_id": origin,
        }
    elif kind == "answer":
        msg = {
            "type": "voice_answer",
            "from_id": from_uid,
            "from_global_user_id": from_gid,
            "from_nickname": from_nick,
            "sdp": str(payload.get("sdp") or "")[:32768],
            "room": room_name,
            "session_id": session_id,
            "federated": True,
        }
    else:  # ice
        msg = {
            "type": "voice_ice",
            "from_id": from_uid,
            "from_global_user_id": from_gid,
            "candidate": str(payload.get("candidate") or "")[:8192],
            "room": room_name,
            "session_id": session_id,
            "federated": True,
        }
    await manager.send_to_user(to_id, msg)
