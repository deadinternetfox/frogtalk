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
    elif peer_online_here:
        # A stale local tab may hide that the peer is reading on a travel node.
        for sid in fc._clearnet_federation_peer_ids():
            if sid and sid != local_sid:
                targets.add(sid)
    if targets:
        return sorted(targets)
    if not peer_online_here:
        return fc._clearnet_federation_peer_ids()
    return []


def dm_message_federation_targets(*users: dict | None) -> list[str]:
    """Server ids that should receive a ``dm.message.created`` event.

    Union both DM parties — routing on the recipient alone misses travel
    delivery when the sender is online locally (clearnet fan-out) or the
    peer looks online here via a stale tab while reading on AU/EU.
    """
    local_sid = _local_server_id()
    targets: set[str] = set()
    for user in users:
        if not user:
            continue
        for sid in dm_message_target_servers(user):
            if sid:
                targets.add(sid)
    return sorted(targets)


def _user_required_mirror_servers(user: dict | None) -> list[str]:
    """Home + live-connection servers that must receive DM copies for ``user``."""
    local_sid = _local_server_id()
    targets: set[str] = set()
    u = dict(user or {})
    gid = str(u.get("global_user_id") or "").strip()
    uid = int(u.get("id") or 0)
    if gid:
        for sid in db.resolve_federation_push_targets_for_recipient_gids([gid]):
            if sid:
                targets.add(sid)
        home = str(db.resolve_global_user_home_server_id(gid) or "").strip()
        if home:
            targets.add(home)
        try:
            origin = str(db.get_federation_profile_origin(gid) or "").strip()
        except Exception:
            origin = ""
        if origin:
            targets.add(origin)
    if uid > 0:
        try:
            acct = str(db.get_user_account_home_server_id(uid) or "").strip()
        except Exception:
            acct = ""
        if acct:
            targets.add(acct)
    if local_sid:
        targets.discard(local_sid)
    return sorted(targets)


def user_session_on_travel_node(user: dict | None) -> bool:
    """True when this account's home server is not the node we're running on."""
    local_sid = _local_server_id()
    if not local_sid:
        return False
    u = dict(user or {})
    uid = int(u.get("id") or 0)
    if uid > 0:
        try:
            acct = str(db.get_user_account_home_server_id(uid) or "").strip()
        except Exception:
            acct = ""
        if acct and acct != local_sid:
            return True
    gid = str(u.get("global_user_id") or "").strip()
    if gid:
        home = str(db.resolve_global_user_home_server_id(gid) or "").strip()
        if home and home != local_sid:
            return True
    return False


def dm_message_federation_remote_targets(*users: dict | None) -> list[str]:
    """Remote server_ids for ``dm.message.created`` (never the local node)."""
    local_sid = _local_server_id()
    targets: set[str] = set()
    for user in users:
        if not user:
            continue
        for sid in _user_required_mirror_servers(user):
            if sid and sid != local_sid:
                targets.add(sid)
    for sid in dm_message_federation_targets(*users):
        if sid and sid != local_sid:
            targets.add(sid)
    if not targets:
        for sid in fc._clearnet_federation_peer_ids():
            if sid and sid != local_sid:
                targets.add(sid)
    return sorted(targets)


def federation_mirror_targets(*users: dict | None) -> list[str]:
    """Server ids that should receive DM channel metadata (disappear timer, etc.)."""
    local_sid = _local_server_id()
    targets: set[str] = set()
    for sid in dm_message_federation_targets(*users):
        if sid:
            targets.add(sid)
    for sid in fc._clearnet_federation_peer_ids():
        if sid and sid != local_sid:
            targets.add(sid)
    return sorted(targets)


def _party_homed_elsewhere(user: dict | None) -> bool:
    return user_session_on_travel_node(user)


def should_federate_dm(sender: dict | None, peer: dict | None) -> bool:
    """Push to federation when the DM cannot be satisfied only on this node.

    If the recipient is on our WebSocket *and* not connected elsewhere, local
    delivery is enough. A stale home-tab session must not block federation when
    ``user.connection.updated`` shows the peer on a travel node.
    """
    local_sid = _local_server_id()
    targets = dm_message_federation_targets(sender, peer)
    if any(t for t in (targets or []) if t and t != local_sid):
        return True
    if _peer_connected_on_remote_node(peer) or _peer_connected_on_remote_node(sender):
        return True
    if not peer_session_on_local_node(peer):
        return True
    if _party_homed_elsewhere(sender) or _party_homed_elsewhere(peer):
        return True
    return False


def dm_parties_have_global_ids(sender: dict | None, peer: dict | None) -> bool:
    s = str((sender or {}).get("global_user_id") or "").strip()
    p = str((peer or {}).get("global_user_id") or "").strip()
    return bool(s and p)
