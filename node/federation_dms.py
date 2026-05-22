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


def dm_message_target_servers(peer_user: dict | None) -> list[str]:
    """Peer server_ids that should receive ``dm.message.created``."""
    return fc.call_offer_target_servers(peer_user or {})


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

    Cross-home threads always fan out (travelers may be connected elsewhere).
    Same-home DMs skip federation when the recipient is on our WebSocket now.

    ``global_user_id`` is not required here — nicknames in the signed
    ``dm.message.created`` payload still resolve on the receiver. Requiring
    GIDs caused "only my messages visible" when a travel session had not yet
    adopted a global id but the peer was on another node.
    """
    if _party_homed_elsewhere(sender) or _party_homed_elsewhere(peer):
        return True
    return not peer_session_on_local_node(peer)


def dm_parties_have_global_ids(sender: dict | None, peer: dict | None) -> bool:
    s = str((sender or {}).get("global_user_id") or "").strip()
    p = str((peer or {}).get("global_user_id") or "").strip()
    return bool(s and p)
