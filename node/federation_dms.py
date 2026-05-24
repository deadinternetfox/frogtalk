"""Federated DM delivery (dm.message.created outbox routing).

Mirrors ``federation_calls.call_offer_target_servers``: when the recipient
is not on this node's WebSocket, push one outbox row per federation peer
so partial delivery can retry per target instead of marking a broadcast
row sent after the first peer ACK.
"""
from __future__ import annotations

import database as db
import federation_calls as fc


def peer_session_on_local_node(peer_user: dict | None) -> bool:
    """True when the DM recipient has an active session on this node."""
    return fc.callee_session_on_local_node(peer_user or {})


def _local_server_id() -> str:
    ident = db.get_or_create_local_server_identity() or {}
    return str(ident.get("server_id") or "").strip()


def _peer_connected_on_remote_node(peer_user: dict | None) -> bool:
    """True when federation knows the peer has a WS on another node."""
    gid = str((peer_user or {}).get("global_user_id") or "").strip()
    if not gid:
        return False
    local_sid = _local_server_id()
    for sid in db.get_federation_user_connection_servers(gid):
        if sid and sid != local_sid:
            return True
    return False


def dm_message_target_servers(peer_user: dict | None) -> list[str]:
    """Peer server_ids that should receive ``dm.message.created``.

    Unlike call signaling, never return ``[]`` solely because a stale local
    WebSocket exists on this node — travelers on AU/EU must still receive
    events when a background tab keeps the home session alive.
    """
    user = dict(peer_user or {})
    local_sid = _local_server_id()
    gid = str(user.get("global_user_id") or "").strip()
    targets: set[str] = set()
    if gid:
        for sid in db.resolve_federation_push_targets_for_recipient_gids([gid]):
            if sid:
                targets.add(sid)
        try:
            origin = str(db.get_federation_profile_origin(gid) or "").strip()
        except Exception:
            origin = ""
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
    peer_online_here = peer_session_on_local_node(user)
    remote_conn = _peer_connected_on_remote_node(user)
    homed_remote = _party_homed_elsewhere(user)
    if not peer_online_here or remote_conn or homed_remote:
        for sid in fc._clearnet_federation_peer_ids():
            targets.add(sid)
    if targets:
        return sorted(targets)
    if not peer_online_here:
        return fc._clearnet_federation_peer_ids()
    return []


def _party_homed_elsewhere(user: dict | None) -> bool:
    ident = db.get_or_create_local_server_identity() or {}
    local_sid = str(ident.get("server_id") or "").strip()
    gid = str((user or {}).get("global_user_id") or "").strip()
    if not gid or not local_sid:
        return False
    home = db.resolve_global_user_home_server_id(gid)
    return bool(home and home != local_sid)


def should_federate_dm(sender: dict | None, peer: dict | None) -> bool:
    """Push to federation when the DM cannot be satisfied only on this node.

    If the recipient is on our WebSocket *and* not connected elsewhere, local
    delivery is enough. A stale home-tab session must not block federation when
    ``user.connection.updated`` shows the peer on a travel node.
    """
    if _peer_connected_on_remote_node(peer):
        return True
    if peer_session_on_local_node(peer):
        return _party_homed_elsewhere(sender) or _party_homed_elsewhere(peer)
    return True


def dm_parties_have_global_ids(sender: dict | None, peer: dict | None) -> bool:
    s = str((sender or {}).get("global_user_id") or "").strip()
    p = str((peer or {}).get("global_user_id") or "").strip()
    return bool(s and p)
