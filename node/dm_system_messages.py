"""Persisted in-chat system lines for DMs ([[DMSYS]] JSON payloads)."""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

import database as db

DMSYS_PREFIX = "[[DMSYS]]"

_HISTORY_FAILED_COPY = {
    "connection": (
        "Could not reach your home node to import DM history. "
        "Check Settings → Network and try Re-sync. New messages still work on this node."
    ),
    "peer_unreachable": (
        "This contact could not be matched on this node during import. "
        "Send a new message to start a fresh encrypted thread."
    ),
    "empty": (
        "No messages could be saved from your home export for this chat. "
        "Try Re-sync from Settings → Network."
    ),
    "keys": (
        "Encryption keys were not restored on this device, so older DM history stays locked. "
        "New messages you send from now on work normally."
    ),
}


def dm_sys_content(kind: str, *, title: str = "", subtitle: str = "", icon: str = "") -> str:
    payload = {
        "kind": str(kind or "info").strip() or "info",
        "title": str(title or "").strip() or "Notice",
        "subtitle": str(subtitle or "").strip(),
        "icon": str(icon or "ℹ️").strip() or "ℹ️",
    }
    return DMSYS_PREFIX + json.dumps(payload, separators=(",", ":"))


def channel_has_recent_dmsys(channel_id: int, kind: str, within_sec: float = 300.0) -> bool:
    cid = int(channel_id or 0)
    want = str(kind or "").strip()
    if not cid or not want:
        return False
    try:
        with db._conn() as con:
            rows = con.execute(
                "SELECT content, created_at FROM dm_messages WHERE channel_id=? "
                "ORDER BY id DESC LIMIT 16",
                (cid,),
            ).fetchall()
    except Exception:
        return False
    now = datetime.utcnow()
    for row in rows or []:
        content = str(row["content"] or "")
        if not content.startswith(DMSYS_PREFIX):
            continue
        try:
            meta = json.loads(content[len(DMSYS_PREFIX) :])
        except Exception:
            return True
        if str((meta or {}).get("kind") or "") != want:
            continue
        created = str(row["created_at"] or "")
        try:
            ts = datetime.fromisoformat(created.replace("Z", "+00:00").replace(" ", "T"))
            age = (now - ts.replace(tzinfo=None)).total_seconds()
        except Exception:
            return True
        if age < within_sec:
            return True
    return False


def insert_dm_system_notice(
    channel_id: int,
    sender_user_id: int,
    kind: str,
    *,
    title: str = "",
    subtitle: str = "",
    icon: str = "",
    dedupe_sec: float = 300.0,
) -> int | None:
    """Insert a [[DMSYS]] row; return message id or None if deduped / failed."""
    cid = int(channel_id or 0)
    uid = int(sender_user_id or 0)
    if cid <= 0 or uid <= 0:
        return None
    k = str(kind or "").strip()
    if k and channel_has_recent_dmsys(cid, k, within_sec=dedupe_sec):
        return None
    content = dm_sys_content(kind=k, title=title, subtitle=subtitle, icon=icon)
    try:
        return int(db.send_dm_message(cid, uid, content) or 0) or None
    except Exception:
        return None


def crypto_sync_content(actor_nick: str) -> str:
    nick = str(actor_nick or "Someone").strip().lstrip("@") or "Someone"
    return dm_sys_content(
        kind="crypto_sync",
        title="Encryption keys synced",
        subtitle=(
            f"@{nick} refreshed encryption for this chat. "
            "New messages here are end-to-end encrypted on this node. "
            "Older messages from other nodes may stay locked — that is expected."
        ),
        icon="🔐",
    )


def maybe_history_sync_notice(
    *,
    channel_id: int,
    actor_user_id: int,
    messages_applied: int,
    messages_offered: int,
    is_travel_import: bool,
    peer_missing: bool = False,
    source_label: str = "your home node",
) -> dict[str, Any]:
    """Insert at most one history-related system line per channel after federation sync."""
    cid = int(channel_id or 0)
    uid = int(actor_user_id or 0)
    applied = int(messages_applied or 0)
    offered = int(messages_offered or 0)
    label = str(source_label or "your home node").strip() or "your home node"
    out: dict[str, Any] = {"channel_id": cid, "inserted": None, "kind": None}
    if cid <= 0 or uid <= 0:
        return out

    if peer_missing and offered > 0:
        out["kind"] = "history_import_failed"
        out["inserted"] = insert_dm_system_notice(
            cid,
            uid,
            "history_import_failed",
            title="History not imported",
            subtitle=_HISTORY_FAILED_COPY["peer_unreachable"],
            icon="⚠️",
        )
        return out

    if applied <= 0 and offered > 0:
        out["kind"] = "history_import_failed"
        out["inserted"] = insert_dm_system_notice(
            cid,
            uid,
            "history_import_failed",
            title="History not imported",
            subtitle=(
                f"Could not import DM history for this chat ({label} connection issue). "
                "Try Re-sync in Settings → Network. New messages still work here."
            ),
            icon="⚠️",
        )
        return out

    if applied > 0 and is_travel_import:
        out["kind"] = "history_locked"
        out["inserted"] = insert_dm_system_notice(
            cid,
            uid,
            "history_locked",
            title="Chat history imported",
            subtitle=(
                f"Imported {applied} older message{'s' if applied != 1 else ''} from {label}. "
                "They stay locked on this node unless you restore encryption keys — "
                "new messages work normally."
            ),
            icon="📥",
        )
        return out

    if applied >= 3 and not is_travel_import:
        out["kind"] = "history_import_ok"
        out["inserted"] = insert_dm_system_notice(
            cid,
            uid,
            "history_import_ok",
            title="Chat history restored",
            subtitle=f"Imported {applied} messages from {label}.",
            icon="✓",
        )
    return out


def insert_history_keys_notice(channel_id: int, actor_user_id: int) -> int | None:
    return insert_dm_system_notice(
        int(channel_id or 0),
        int(actor_user_id or 0),
        "history_import_failed",
        title="History not imported",
        subtitle=_HISTORY_FAILED_COPY["keys"],
        icon="⚠️",
        dedupe_sec=600.0,
    )


def insert_connection_failure_notices_for_user(user_id: int, *, limit: int = 12) -> int:
    """After a failed home sync, leave a gentle in-chat note in recent DM threads."""
    uid = int(user_id or 0)
    if uid <= 0:
        return 0
    try:
        channels = db.get_dm_channels(uid) or []
    except Exception:
        return 0
    inserted = 0
    for ch in channels[: max(1, int(limit or 12))]:
        cid = int(ch.get("channel_id") or ch.get("id") or 0)
        if cid <= 0:
            continue
        mid = insert_dm_system_notice(
            cid,
            uid,
            "history_import_failed",
            title="History not imported",
            subtitle=_HISTORY_FAILED_COPY["connection"],
            icon="⚠️",
            dedupe_sec=900.0,
        )
        if mid:
            inserted += 1
    return inserted
