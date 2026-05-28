"""GIF search (via KLIPY, with Tenor fallback) and custom stickers routes."""
import json as _json_mod
import logging
import os
import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Any, Dict, Optional

import database as db


# ─── Sticker effects schema ────────────────────────────────────────────────
# Strictly whitelisted, no raw CSS is ever stored. The client converts these
# into a small set of computed `filter` / `transform` / `animation` rules
# that are rendered inside a Shadow-DOM-isolated sticker element. This makes
# it impossible for sticker authors to break out of the sticker bounding box
# or affect any other UI element.
_STICKER_FX_FILTER_RANGES = {
    # name           min   max   default
    "blur":        (0.0,  6.0,  0.0),   # px
    "brightness":  (0.2,  2.5,  1.0),
    "contrast":    (0.2,  2.5,  1.0),
    "saturate":    (0.0,  3.0,  1.0),
    "grayscale":   (0.0,  1.0,  0.0),
    "sepia":       (0.0,  1.0,  0.0),
    "invert":      (0.0,  1.0,  0.0),
    "hue":         (0.0, 360.0, 0.0),   # degrees
}
_STICKER_FX_TRANSFORM_RANGES = {
    "scale":       (0.5,  2.0,  1.0),
    "rotate":      (-180.0, 180.0, 0.0),  # degrees
    "skewX":       (-30.0,  30.0, 0.0),
    "skewY":       (-30.0,  30.0, 0.0),
}
_STICKER_FX_SHADOW_RANGES = {
    "x":           (-20.0, 20.0, 0.0),   # px
    "y":           (-20.0, 20.0, 0.0),
    "blur":        (0.0,   30.0, 0.0),
    "spread":      (0.0,   1.0,  0.0),   # alpha 0..1
}
_STICKER_FX_ANIMATIONS = {
    "none", "spin", "pulse", "bounce", "shake", "wobble",
    "float", "glow", "rainbow", "rainbow_tint", "rainbow_glow",
    "flip", "swing", "sparkle", "pop",
}
_STICKER_FX_HEX_COLOR = (
    # simple #rgb / #rgba / #rrggbb / #rrggbbaa whitelist
    "abcdef0123456789"
)


def _clamp(val: Any, lo: float, hi: float, default: float) -> float:
    try:
        v = float(val)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return max(lo, min(hi, v))


def _safe_hex(val: Any, default: str = "#000000") -> str:
    if not isinstance(val, str):
        return default
    s = val.strip().lower()
    if not s.startswith("#"):
        return default
    body = s[1:]
    if len(body) not in (3, 4, 6, 8):
        return default
    if any(c not in _STICKER_FX_HEX_COLOR for c in body):
        return default
    return "#" + body


def validate_sticker_effects(raw: Any) -> Optional[Dict[str, Any]]:
    """Normalize and clamp a user-supplied effects dict.

    Returns the canonical dict (always populated with every known key, with
    out-of-range values clamped to safe defaults), or None when the input is
    None / empty / not a dict. The output is the ONLY thing that ever gets
    persisted; we never store arbitrary user keys.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        return None

    filt_in = raw.get("filter") or {}
    if not isinstance(filt_in, dict):
        filt_in = {}
    filt = {k: _clamp(filt_in.get(k), *r) for k, r in _STICKER_FX_FILTER_RANGES.items()}

    tfm_in = raw.get("transform") or {}
    if not isinstance(tfm_in, dict):
        tfm_in = {}
    tfm = {k: _clamp(tfm_in.get(k), *r) for k, r in _STICKER_FX_TRANSFORM_RANGES.items()}

    sh_in = raw.get("shadow") or {}
    if not isinstance(sh_in, dict):
        sh_in = {}
    shadow = {k: _clamp(sh_in.get(k), *r) for k, r in _STICKER_FX_SHADOW_RANGES.items()}
    shadow["color"] = _safe_hex(sh_in.get("color"), "#000000")

    anim_name = raw.get("animation")
    if isinstance(anim_name, str):
        anim_name = anim_name.strip()
    if not isinstance(anim_name, str) or anim_name not in _STICKER_FX_ANIMATIONS:
        anim_name = "none"
    anim_duration = _clamp(raw.get("animation_duration"), 0.3, 10.0, 2.0)

    bg = _safe_hex(raw.get("background"), "")  # "" → transparent
    border_radius = _clamp(raw.get("border_radius"), 0.0, 50.0, 0.0)

    # Optional: GIF playback controls (only affects client rendering for GIF media).
    gm = raw.get("gif_mode")
    if isinstance(gm, str):
        gm = gm.strip()
    if gm not in ("loop", "once", "paused"):
        gm = "loop"
    gif_play_seconds = _clamp(raw.get("gif_play_seconds"), 0.3, 10.0, 2.5)

    # Optional v2: chained effect layers (animation stack).
    layers_out = []
    layers_in = raw.get("layers")
    if isinstance(layers_in, list):
        for it in layers_in:
            if not isinstance(it, dict):
                continue
            kind = it.get("kind")
            if isinstance(kind, str):
                kind = kind.strip()
            if kind not in ("transform", "filter", "glow"):
                continue
            an = it.get("animation")
            if isinstance(an, str):
                an = an.strip()
            if not isinstance(an, str) or an not in _STICKER_FX_ANIMATIONS or an == "none":
                continue
            # Keep this tight: only specific animations are allowed per kind.
            if kind == "transform" and an not in {"spin","pulse","bounce","shake","wobble","float","flip","swing","sparkle","pop"}:
                continue
            if kind == "filter" and an not in {"rainbow","rainbow_tint"}:
                continue
            if kind == "glow" and an not in {"glow","rainbow_glow"}:
                continue
            start = _clamp(it.get("start"), 0.0, 20.0, 0.0)
            dur = _clamp(it.get("duration"), 0.3, 10.0, 2.0)
            layers_out.append({"kind": kind, "animation": an, "start": start, "duration": dur})
            if len(layers_out) >= 6:
                break

    out: Dict[str, Any] = {
        "filter": filt,
        "transform": tfm,
        "shadow": shadow,
        "animation": anim_name,
        "animation_duration": anim_duration,
        "background": bg,
        "border_radius": border_radius,
    }
    out["gif_mode"] = gm
    out["gif_play_seconds"] = gif_play_seconds
    if layers_out:
        out["layers"] = layers_out
    return out
from deps import get_current_user

router = APIRouter(prefix="/media", tags=["media"])
_log = logging.getLogger("frogtalk.gifs")

# Display name for pack browse / install lists (federated packs cache owner_nickname).
_STICKER_OWNER_NAME_SQL = """
CASE
  WHEN sp.origin_server_id IS NOT NULL THEN
    COALESCE(NULLIF(TRIM(sp.owner_nickname), ''), NULLIF(u.nickname, '__federated__'), '@federated')
  ELSE COALESCE(u.nickname, NULLIF(TRIM(sp.owner_nickname), ''), '@unknown')
END AS owner_name
"""


def _ensure_sticker_schema(con) -> None:
    """Idempotent sticker tables + federation columns (safe on every request)."""
    con.execute("""CREATE TABLE IF NOT EXISTS sticker_packs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        owner_id INTEGER NOT NULL,
        is_public INTEGER DEFAULT 0,
        origin_server_id TEXT DEFAULT NULL,
        foreign_pack_id INTEGER DEFAULT NULL,
        owner_nickname TEXT DEFAULT NULL,
        room_id INTEGER DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    )""")
    for _col, _ddl in (
        ("origin_server_id", "ALTER TABLE sticker_packs ADD COLUMN origin_server_id TEXT DEFAULT NULL"),
        ("foreign_pack_id", "ALTER TABLE sticker_packs ADD COLUMN foreign_pack_id INTEGER DEFAULT NULL"),
        ("owner_nickname", "ALTER TABLE sticker_packs ADD COLUMN owner_nickname TEXT DEFAULT NULL"),
        ("owner_global_user_id", "ALTER TABLE sticker_packs ADD COLUMN owner_global_user_id TEXT DEFAULT NULL"),
        ("room_id", "ALTER TABLE sticker_packs ADD COLUMN room_id INTEGER DEFAULT NULL"),
    ):
        try:
            con.execute(_ddl)
        except Exception:
            pass
    try:
        con.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_sticker_packs_origin "
            "ON sticker_packs(origin_server_id, foreign_pack_id) "
            "WHERE origin_server_id IS NOT NULL"
        )
        con.execute("CREATE INDEX IF NOT EXISTS idx_sticker_packs_room ON sticker_packs(room_id)")
    except Exception:
        pass
    con.execute("""CREATE TABLE IF NOT EXISTS stickers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pack_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        image_data TEXT NOT NULL,
        emoji TEXT DEFAULT '',
        effects TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (pack_id) REFERENCES sticker_packs(id) ON DELETE CASCADE
    )""")
    try:
        con.execute("ALTER TABLE stickers ADD COLUMN effects TEXT DEFAULT NULL")
    except Exception:
        pass
    con.execute("""CREATE TABLE IF NOT EXISTS user_sticker_packs (
        user_id INTEGER NOT NULL,
        pack_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, pack_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (pack_id) REFERENCES sticker_packs(id) ON DELETE CASCADE
    )""")


def _decode_sticker_row(row: dict) -> dict:
    d = dict(row)
    raw = d.pop("effects", None)
    if raw:
        try:
            d["effects"] = validate_sticker_effects(_json_mod.loads(raw))
        except Exception:
            d["effects"] = None
    else:
        d["effects"] = None
    return d


def _stickers_for_pack_ids(con, pack_ids: list[int]) -> dict[int, list]:
    if not pack_ids:
        return {}
    ph = ",".join("?" * len(pack_ids))
    rows = con.execute(
        f"SELECT id, pack_id, name, image_data, emoji, effects FROM stickers "
        f"WHERE pack_id IN ({ph}) ORDER BY pack_id, id",
        pack_ids,
    ).fetchall()
    out: dict[int, list] = {pid: [] for pid in pack_ids}
    for row in rows:
        out[int(row["pack_id"])].append(_decode_sticker_row(row))
    return out


def _local_server_id() -> str:
    try:
        return str((db.get_or_create_local_server_identity() or {}).get("server_id") or "").strip()
    except Exception:
        return ""


def _pack_is_home_origin_mirror(pack: dict) -> bool:
    """Federated row that mirrors a pack first created on this node."""
    origin = str(pack.get("origin_server_id") or "").strip()
    if not origin:
        return False
    local_sid = _local_server_id()
    return bool(local_sid and origin == local_sid)


def _pack_is_remote_federated(pack: dict) -> bool:
    """Federated copy of a pack created on another node."""
    origin = str(pack.get("origin_server_id") or "").strip()
    if not origin:
        return False
    local_sid = _local_server_id()
    return bool(local_sid and origin != local_sid)


def _canonical_pack_id_for_manage(con, pack: dict) -> int:
    """Prefer the native local pack row when a home-node mirror duplicate exists."""
    pid = int(pack.get("id") or 0)
    if not _pack_is_home_origin_mirror(pack):
        return pid
    fpid = int(pack.get("foreign_pack_id") or 0)
    if not fpid:
        return pid
    row = con.execute(
        "SELECT id FROM sticker_packs WHERE id=? AND (origin_server_id IS NULL OR origin_server_id='')",
        (fpid,),
    ).fetchone()
    return int(row["id"]) if row else pid


def _user_is_pack_creator(con, pack: dict, user: dict) -> bool:
    uid = int(user["id"])
    gid = str(user.get("global_user_id") or "").strip()
    nick = str(user.get("nickname") or "").strip().lower()
    origin = str(pack.get("origin_server_id") or "").strip()
    owner_gid = str(pack.get("owner_global_user_id") or "").strip()
    owner_nick = str(pack.get("owner_nickname") or "").strip().lower()

    if int(pack.get("owner_id") or 0) == uid and int(pack.get("owner_id") or 0) > 0:
        return True

    if origin:
        if owner_gid and gid and owner_gid == gid:
            return True
        if owner_nick and nick and owner_nick == nick and gid:
            row = con.execute(
                "SELECT 1 FROM federation_user_profiles "
                "WHERE global_user_id=? AND LOWER(nickname)=? AND origin_server_id=?",
                (gid, owner_nick, origin),
            ).fetchone()
            if row:
                return True
        if _pack_is_home_origin_mirror(pack):
            fpid = int(pack.get("foreign_pack_id") or 0)
            if fpid:
                row = con.execute(
                    "SELECT owner_id, owner_global_user_id FROM sticker_packs "
                    "WHERE id=? AND (origin_server_id IS NULL OR origin_server_id='')",
                    (fpid,),
                ).fetchone()
                if row:
                    if int(row["owner_id"]) == uid:
                        return True
                    hog = str(row["owner_global_user_id"] or "").strip()
                    if hog and gid and hog == gid:
                        return True
        return False

    if owner_gid and gid and owner_gid == gid:
        return True
    if owner_nick and nick and owner_nick == nick:
        return True
    return False


def _user_can_manage_pack(con, pack: dict, user: dict) -> bool:
    """Owner, channel mod, or node admin (node-local only for admins).

    Federated packs from other nodes: owner may manage cross-node (nickname match).
    Node admins may only manage native packs and home-node mirrors, not foreign
    federated catalog copies from peers.
    Native local packs: owner + node admin + channel mods.
    """
    if not pack or not user:
        return False
    uid = int(user["id"])
    is_admin = bool(user.get("is_admin"))
    origin = str(pack.get("origin_server_id") or "").strip()

    if origin:
        if _user_is_pack_creator(con, pack, user):
            return True
        if is_admin and _pack_is_home_origin_mirror(pack):
            return True
        return False

    if is_admin:
        return True
    if int(pack.get("owner_id") or 0) == uid:
        return True
    rid = pack.get("room_id")
    if rid:
        room = con.execute("SELECT name FROM rooms WHERE id=?", (int(rid),)).fetchone()
        if room and db.can_moderate_room(room["name"], uid, is_admin):
            return True
    return False


def _user_can_read_pack(con, pack: dict, user_id: int) -> bool:
    """Whether the user may view/copy stickers from this pack."""
    if not pack:
        return False
    uid = int(user_id)
    if int(pack.get("is_public") or 0) and not pack.get("room_id"):
        return True
    if int(pack.get("owner_id") or 0) == uid:
        return True
    pid = int(pack.get("id") or 0)
    if pid and con.execute(
        "SELECT 1 FROM user_sticker_packs WHERE user_id=? AND pack_id=?",
        (uid, pid),
    ).fetchone():
        return True
    rid = pack.get("room_id")
    if rid and db.is_room_member(uid, int(rid)):
        return True
    return False


def _packs_with_stickers(con, pack_rows, *, user: dict) -> list:
    packs = [dict(r) for r in pack_rows]
    by_pack = _stickers_for_pack_ids(con, [int(p["id"]) for p in packs])
    result = []
    for p in packs:
        p["stickers"] = by_pack.get(int(p["id"]), [])
        p["sticker_count"] = len(p["stickers"])
        p["can_manage"] = _user_can_manage_pack(con, p, user)
        result.append(p)
    return result

# ─── Sticker pack federation ────────────────────────────────────────────────
# Sticker packs flagged is_public=1 are mirrored to peer servers via the
# federation event bus. Foreign packs are stored locally with origin_server_id
# + foreign_pack_id set so we can dedupe and route delete events back to the
# right row.
def _fed_emit_sticker_event(pack_id: int, action: str) -> None:
    """Emit a sticker.pack.* federation event (best-effort).

    action: 'upsert' or 'delete'. Only LOCAL public packs are emitted —
    re-broadcasting foreign packs would create cycles.
    """
    try:
        from routers import federation as _fed
        with db._conn() as con:
            pack = con.execute(
                "SELECT * FROM sticker_packs WHERE id=?", (pack_id,)
            ).fetchone()
            if not pack:
                return
            pack = dict(pack)
            # Never re-emit foreign-origin packs.
            if pack.get("origin_server_id"):
                return
            # Channel packs stay on this node only — never federate them.
            if pack.get("room_id"):
                return
            if action == "upsert" and not pack.get("is_public"):
                # Private packs aren't federated. If a pack flips public->private
                # we emit a delete instead (handled by caller).
                return
            payload = {
                "pack_id": pack["id"],
                "name": pack.get("name"),
                "description": pack.get("description") or "",
                "owner_nickname": None,
                "owner_global_user_id": None,
                "is_public": int(pack.get("is_public") or 0),
                "stickers": [],
            }
            owner = con.execute(
                "SELECT nickname, global_user_id FROM users WHERE id=?",
                (pack.get("owner_id"),),
            ).fetchone()
            if owner:
                payload["owner_nickname"] = owner["nickname"]
                payload["owner_global_user_id"] = str(owner["global_user_id"] or "").strip() or None
            hog = str(pack.get("owner_global_user_id") or "").strip()
            if hog:
                payload["owner_global_user_id"] = hog
            if action == "upsert":
                rows = con.execute(
                    "SELECT id, name, image_data, emoji, effects FROM stickers WHERE pack_id=?",
                    (pack_id,),
                ).fetchall()
                payload["stickers"] = [dict(r) for r in rows]
        _fed.enqueue_server_event(f"sticker.pack.{action}", payload)
    except Exception:
        _log.exception("Federation emit failed (pack=%s action=%s)", pack_id, action)


def _fed_owner_request_sync(con, pack: dict, user: dict, action: str) -> None:
    """Ask the pack's home node to apply an owner change and re-broadcast.

    Used when the creator edits a federated mirror on a peer node.
    """
    if not _pack_is_remote_federated(pack) or not _user_is_pack_creator(con, pack, user):
        return
    origin = str(pack.get("origin_server_id") or "").strip()
    fpid = int(pack.get("foreign_pack_id") or 0)
    gid = str(user.get("global_user_id") or "").strip()
    nick = str(user.get("nickname") or "").strip()
    if not origin or not fpid or not gid or not nick:
        return
    try:
        from routers import federation as _fed
        local_pid = int(pack.get("id") or 0)
        row = con.execute("SELECT * FROM sticker_packs WHERE id=?", (local_pid,)).fetchone()
        if not row:
            return
        pack_now = dict(row)
        stickers = con.execute(
            "SELECT id, name, image_data, emoji, effects FROM stickers WHERE pack_id=?",
            (local_pid,),
        ).fetchall()
        payload = {
            "target_origin": origin,
            "pack_id": fpid,
            "owner_nickname": nick,
            "owner_global_user_id": gid,
            "action": action,
            "name": pack_now.get("name"),
            "description": pack_now.get("description") or "",
            "is_public": int(pack_now.get("is_public") or 0),
            "stickers": [dict(s) for s in stickers],
        }
        _fed.enqueue_server_event(
            "sticker.pack.owner.request",
            payload,
            target_server_ids=[origin],
            actor_global_user_id=gid,
        )
    except Exception:
        _log.exception("Federation owner sync failed (origin=%s pack=%s)", origin, fpid)


def _manage_pack_id(con, pack: dict) -> int:
    """Row id to mutate: canonical native pack for home mirrors, else this row."""
    if _pack_is_home_origin_mirror(pack):
        return _canonical_pack_id_for_manage(con, pack)
    return int(pack.get("id") or 0)


def _after_pack_mutation(pack: dict, user: dict, action: str) -> None:
    """Propagate pack changes to federation (native emit or owner relay)."""
    with db._conn() as con:
        if _pack_is_remote_federated(pack):
            local_id = int(pack.get("id") or 0)
            row = con.execute("SELECT * FROM sticker_packs WHERE id=?", (local_id,)).fetchone()
            pack_now = dict(row) if row else pack
            _fed_owner_request_sync(con, pack_now, user, action)
            return
        pid = _canonical_pack_id_for_manage(con, pack)
    _fed_emit_sticker_event(pid, action)

# ─── GIF provider configuration ─────────────────────────────────────────────
# Google announced Tenor API sunset on June 30 2026 (no new keys after Jan 13
# 2026). KLIPY is the preferred drop-in replacement; we still honor a Tenor
# key as a fallback for nodes that haven't migrated yet.
#
# Required envs:
#   KLIPY_API_KEY        — your KLIPY platform key (recommended)
#   KLIPY_API_BASE       — override base URL (default https://api.klipy.com)
#   TENOR_API_KEY        — legacy Tenor key (fallback only)
KLIPY_API_KEY = (os.getenv("KLIPY_API_KEY") or "").strip()
KLIPY_API_BASE = (os.getenv("KLIPY_API_BASE") or "https://api.klipy.com").rstrip("/")
TENOR_API_KEY = (os.getenv("TENOR_API_KEY") or "").strip()

if KLIPY_API_KEY:
    _log.info("GIF provider: KLIPY (base=%s)", KLIPY_API_BASE)
elif TENOR_API_KEY:
    _log.warning(
        "GIF provider: Tenor (deprecated, shuts down 2026-06-30). "
        "Set KLIPY_API_KEY to migrate."
    )
else:
    _log.warning(
        "No GIF provider configured — /media/gifs/* will return 503 until "
        "KLIPY_API_KEY (preferred) or TENOR_API_KEY is set."
    )


def _klipy_url(path: str) -> str:
    # KLIPY puts the API key in the URL path: /api/v1/{key}/gifs/...
    return f"{KLIPY_API_BASE}/api/v1/{KLIPY_API_KEY}/gifs/{path.lstrip('/')}"


def _klipy_pick_url(file_obj: dict, *keys: str) -> str:
    """KLIPY items carry variants under file.{hd,md,sm,xs} (and sometimes
    gif/mp4 sub-objects). Walk the candidate keys and return the first url
    we can find."""
    if not isinstance(file_obj, dict):
        return ""
    for k in keys:
        v = file_obj.get(k)
        if isinstance(v, str) and v:
            return v
        if isinstance(v, dict):
            url = v.get("url")
            if url:
                return url
            gif = v.get("gif")
            if isinstance(gif, dict) and gif.get("url"):
                return gif["url"]
    return ""


def _klipy_pick_format_url(node: dict, *formats: str) -> str:
    """Return the first animated/static format URL under a size tier node."""
    if not isinstance(node, dict):
        return ""
    for fmt in formats:
        sub = node.get(fmt)
        if isinstance(sub, dict):
            url = sub.get("url")
            if url:
                return url
        elif isinstance(sub, str) and sub:
            return sub
    return ""


def _klipy_pick_animated_url(file_obj: dict) -> str:
    """Prefer hd.gif / md.gif (or mp4) — not hd.jpg preview stills."""
    if not isinstance(file_obj, dict):
        return ""
    for tier in ("hd", "md", "sm", "xs"):
        url = _klipy_pick_format_url(file_obj.get(tier) or {}, "gif", "mp4", "webm")
        if url:
            return url
    flat = file_obj.get("gif")
    if isinstance(flat, dict) and flat.get("url"):
        return flat["url"]
    if isinstance(flat, str) and flat:
        return flat
    return _klipy_pick_url(file_obj, "gif", "url")


def _klipy_pick_preview_url(file_obj: dict) -> str:
    """Static thumbnail for the picker grid (jpg/webp), not the send URL."""
    if not isinstance(file_obj, dict):
        return ""
    for tier in ("xs", "sm", "md", "hd"):
        url = _klipy_pick_format_url(
            file_obj.get(tier) or {}, "jpg", "webp", "png", "gif",
        )
        if url:
            return url
    return ""


def _klipy_mime_hint(url: str) -> str:
    path = (url or "").split("?", 1)[0].lower()
    if path.endswith(".mp4"):
        return "video/mp4"
    if path.endswith(".webm"):
        return "video/webm"
    return "image/gif"


def _klipy_to_gif(item: dict) -> Optional[dict]:
    if not isinstance(item, dict):
        return None
    # Skip ad slots — caller handles content only.
    if str(item.get("type") or "").lower() == "ad":
        return None
    f = item.get("file") or item.get("file_meta") or {}
    full = _klipy_pick_animated_url(f)
    preview = _klipy_pick_preview_url(f) or full
    if not full:
        return None
    mime_hint = _klipy_mime_hint(full)
    # Width/height — KLIPY exposes dims under the same variant or top-level.
    dims = item.get("dims") or {}
    try:
        w = int(item.get("width") or dims.get("width") or 0)
        h = int(item.get("height") or dims.get("height") or 0)
    except Exception:
        w = h = 0
    return {
        "id": item.get("slug") or item.get("id") or "",
        "url": full,
        "preview": preview,
        "mime": mime_hint,
        "width": w,
        "height": h,
        "title": item.get("title") or item.get("alt") or "",
        "provider": "klipy",
    }


async def _klipy_request(path: str, params: dict) -> Optional[dict]:
    if not KLIPY_API_KEY:
        return None
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(_klipy_url(path), params=params)
            if r.status_code != 200:
                _log.warning("KLIPY %s -> HTTP %s: %s", path, r.status_code, r.text[:200])
                return None
            return r.json()
    except Exception as e:
        _log.warning("KLIPY %s error: %s", path, e)
        return None


def _klipy_extract_items(payload: dict) -> list:
    """KLIPY responses wrap items under {result, data: {data: [...]}}."""
    if not isinstance(payload, dict):
        return []
    data = payload.get("data") or payload.get("result")
    if isinstance(data, dict):
        inner = data.get("data") or data.get("items") or data.get("results")
        if isinstance(inner, list):
            return inner
    if isinstance(data, list):
        return data
    return []


# ---------------------------------------------------------------------------
# GIF Search via KLIPY (preferred) or Tenor (fallback)
# ---------------------------------------------------------------------------

@router.get("/gifs/search")
async def search_gifs(
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(20, le=50),
    user=Depends(get_current_user),
):
    """Search for GIFs."""
    # KLIPY path
    if KLIPY_API_KEY:
        payload = await _klipy_request("search", {
            "q": q,
            "page": 1,
            "per_page": limit,
            "customer_id": str(user["id"]),
        })
        if payload is not None:
            gifs = [g for g in (_klipy_to_gif(i) for i in _klipy_extract_items(payload)) if g]
            return {"gifs": gifs, "query": q, "provider": "klipy"}
        # KLIPY error → fall through to Tenor if configured, else 502.
        if not TENOR_API_KEY:
            return JSONResponse(status_code=502, content={"error": "GIF service unavailable"})

    if not TENOR_API_KEY:
        return JSONResponse(status_code=503, content={"error": "GIF service not configured"})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                "https://tenor.googleapis.com/v2/search",
                params={
                    "q": q,
                    "key": TENOR_API_KEY,
                    "limit": limit,
                    "media_filter": "gif,tinygif",
                    "contentfilter": "medium"
                }
            )
            
            if response.status_code != 200:
                return JSONResponse(status_code=502, content={"error": "GIF service unavailable"})
            
            data = response.json()
            gifs = []
            
            for result in data.get("results", []):
                media = result.get("media_formats", {})
                gif_data = media.get("gif", {}) or media.get("tinygif", {})
                preview = media.get("tinygif", {}) or media.get("nanogif", {})
                
                if gif_data.get("url"):
                    gifs.append({
                        "id": result.get("id"),
                        "url": gif_data.get("url"),
                        "preview": preview.get("url", gif_data.get("url")),
                        "width": gif_data.get("dims", [0, 0])[0],
                        "height": gif_data.get("dims", [0, 0])[1],
                        "title": result.get("title", ""),
                        "provider": "tenor",
                    })
            
            return {"gifs": gifs, "query": q, "provider": "tenor"}
            
    except Exception:
        logging.getLogger(__name__).exception("GIF search failed")
        return JSONResponse(status_code=502, content={"error": "GIF search failed"})


@router.get("/gifs/trending")
async def trending_gifs(
    limit: int = Query(20, le=50),
    user=Depends(get_current_user),
):
    """Get trending GIFs."""
    if KLIPY_API_KEY:
        payload = await _klipy_request("trending", {
            "page": 1,
            "per_page": limit,
            "customer_id": str(user["id"]),
        })
        if payload is not None:
            gifs = [g for g in (_klipy_to_gif(i) for i in _klipy_extract_items(payload)) if g]
            return {"gifs": gifs, "provider": "klipy"}
        if not TENOR_API_KEY:
            return JSONResponse(status_code=502, content={"error": "GIF service unavailable"})

    if not TENOR_API_KEY:
        return JSONResponse(status_code=503, content={"error": "GIF service not configured"})
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                "https://tenor.googleapis.com/v2/featured",
                params={
                    "key": TENOR_API_KEY,
                    "limit": limit,
                    "media_filter": "gif,tinygif",
                    "contentfilter": "medium"
                }
            )
            
            if response.status_code != 200:
                return JSONResponse(status_code=502, content={"error": "GIF service unavailable"})
            
            data = response.json()
            gifs = []
            
            for result in data.get("results", []):
                media = result.get("media_formats", {})
                gif_data = media.get("gif", {}) or media.get("tinygif", {})
                preview = media.get("tinygif", {}) or media.get("nanogif", {})
                
                if gif_data.get("url"):
                    gifs.append({
                        "id": result.get("id"),
                        "url": gif_data.get("url"),
                        "preview": preview.get("url", gif_data.get("url")),
                        "width": gif_data.get("dims", [0, 0])[0],
                        "height": gif_data.get("dims", [0, 0])[1],
                        "provider": "tenor",
                    })
            
            return {"gifs": gifs, "provider": "tenor"}
            
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"Failed to get trending GIFs"})


# ---------------------------------------------------------------------------
# KLIPY engagement signals (best-effort; only fire when KLIPY is configured)
# ---------------------------------------------------------------------------

@router.post("/gifs/{slug}/share")
async def gif_share(slug: str, user=Depends(get_current_user)):
    """Notify KLIPY that the user shared this GIF (improves Recent ranking)."""
    if not KLIPY_API_KEY or not slug:
        return {"ok": True, "provider": None}
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            await client.post(
                _klipy_url(f"{slug}/share"),
                json={"customer_id": str(user["id"])},
            )
    except Exception as e:
        _log.debug("KLIPY share signal failed: %s", e)
    return {"ok": True, "provider": "klipy"}


@router.post("/gifs/{slug}/view")
async def gif_view(slug: str, user=Depends(get_current_user)):
    """Notify KLIPY of a long-press / preview view."""
    if not KLIPY_API_KEY or not slug:
        return {"ok": True, "provider": None}
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            await client.post(
                _klipy_url(f"{slug}/view"),
                json={"customer_id": str(user["id"])},
            )
    except Exception as e:
        _log.debug("KLIPY view signal failed: %s", e)
    return {"ok": True, "provider": "klipy"}


@router.get("/gifs/categories")
async def gif_categories():
    """Get GIF search categories/suggestions."""
    return {
        "categories": [
            {"name": "Reactions", "search": "reaction"},
            {"name": "Happy", "search": "happy"},
            {"name": "Sad", "search": "sad"},
            {"name": "Love", "search": "love heart"},
            {"name": "Angry", "search": "angry"},
            {"name": "Dance", "search": "dance"},
            {"name": "Facepalm", "search": "facepalm"},
            {"name": "Thumbs Up", "search": "thumbs up"},
            {"name": "Applause", "search": "applause clap"},
            {"name": "Frog", "search": "frog"},
            {"name": "Cat", "search": "cat"},
            {"name": "Dog", "search": "dog"}
        ]
    }


# ---------------------------------------------------------------------------
# Custom Stickers
# ---------------------------------------------------------------------------

class CreateStickerPackRequest(BaseModel):
    name: str
    description: str = ""
    room_id: Optional[int] = None


class ImportStickerRequest(BaseModel):
    sticker_id: int


class ImportStickerImageRequest(BaseModel):
    image_data: str
    media_type: Optional[str] = None


class UpdateStickerPackRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_public: Optional[bool] = None


class AddStickerRequest(BaseModel):
    pack_id: int
    name: str
    image_data: str  # Base64 encoded image
    emoji: str = ""  # Associated emoji
    effects: Optional[Dict[str, Any]] = None  # whitelisted CSS effects spec


class UpdateStickerRequest(BaseModel):
    name: Optional[str] = None
    emoji: Optional[str] = None
    effects: Optional[Dict[str, Any]] = None  # pass {} to clear


class AddStickerToChannelRequest(BaseModel):
    room_id: int
    pack_id: Optional[int] = None
    name: Optional[str] = None


@router.get("/stickers/packs")
async def list_sticker_packs(current_user: dict = Depends(get_current_user)):
    """List all sticker packs (user's own + installed)."""
    uid = int(current_user["id"])
    with db._conn() as con:
        _ensure_sticker_schema(con)
        own_packs = con.execute("""
            SELECT sp.*,
                   (SELECT COUNT(*) FROM stickers WHERE pack_id=sp.id) as sticker_count
            FROM sticker_packs sp
            WHERE sp.owner_id=? AND sp.room_id IS NULL
        """, (uid,)).fetchall()
        installed_packs = con.execute(f"""
            SELECT sp.*, {_STICKER_OWNER_NAME_SQL},
                   (SELECT COUNT(*) FROM stickers WHERE pack_id=sp.id) as sticker_count
            FROM user_sticker_packs usp
            JOIN sticker_packs sp ON usp.pack_id = sp.id
            LEFT JOIN users u ON sp.owner_id = u.id
            WHERE usp.user_id=? AND sp.owner_id != ? AND sp.room_id IS NULL
        """, (uid, uid)).fetchall()
        own_out = []
        for row in own_packs:
            d = dict(row)
            d["can_manage"] = _user_can_manage_pack(con, d, current_user)
            own_out.append(d)
        installed_out = []
        for row in installed_packs:
            d = dict(row)
            d["can_manage"] = _user_can_manage_pack(con, d, current_user)
            installed_out.append(d)

    return {
        "own_packs": own_out,
        "installed_packs": installed_out,
    }


@router.get("/stickers/room/{room_id}")
async def list_room_sticker_packs(room_id: int, current_user: dict = Depends(get_current_user)):
    """Channel sticker packs (visible only in that channel unless saved to account)."""
    if not db.is_room_member(current_user["id"], room_id) and not bool(current_user.get("is_admin")):
        return JSONResponse(status_code=403, content={"error": "Not a member of this channel"})
    with db._conn() as con:
        _ensure_sticker_schema(con)
        packs = con.execute(f"""
            SELECT sp.*, {_STICKER_OWNER_NAME_SQL},
                   (SELECT COUNT(*) FROM stickers WHERE pack_id=sp.id) as sticker_count
            FROM sticker_packs sp
            LEFT JOIN users u ON sp.owner_id = u.id
            WHERE sp.room_id=?
            ORDER BY sp.created_at DESC
        """, (room_id,)).fetchall()
        out = []
        for row in packs:
            d = dict(row)
            d["can_manage"] = _user_can_manage_pack(con, d, current_user)
            out.append(d)
    return {"packs": out}


@router.get("/stickers/grid")
async def get_sticker_grid(
    scope: str = Query("mine"),
    room_id: Optional[int] = Query(None),
    current_user: dict = Depends(get_current_user),
):
    """Return packs with embedded stickers in one round-trip (picker / channel tab).

    scope:
      mine  — personal own + installed packs (room_id must be null)
      room  — channel packs for room_id (members only)
    """
    uid = int(current_user["id"])
    scope_norm = (scope or "mine").strip().lower()
    with db._conn() as con:
        _ensure_sticker_schema(con)
        if scope_norm == "room":
            rid = int(room_id or 0)
            if not rid:
                return JSONResponse(status_code=400, content={"error": "room_id required"})
            if not db.is_room_member(uid, rid) and not bool(current_user.get("is_admin")):
                return JSONResponse(status_code=403, content={"error": "Not a member of this channel"})
            pack_rows = con.execute(f"""
                SELECT sp.*, {_STICKER_OWNER_NAME_SQL}
                FROM sticker_packs sp
                LEFT JOIN users u ON sp.owner_id = u.id
                WHERE sp.room_id=?
                ORDER BY sp.created_at DESC
            """, (rid,)).fetchall()
        else:
            own = con.execute(f"""
                SELECT sp.*, {_STICKER_OWNER_NAME_SQL}
                FROM sticker_packs sp
                LEFT JOIN users u ON sp.owner_id = u.id
                WHERE sp.owner_id=? AND sp.room_id IS NULL
                ORDER BY sp.created_at DESC
            """, (uid,)).fetchall()
            installed = con.execute(f"""
                SELECT sp.*, {_STICKER_OWNER_NAME_SQL}
                FROM user_sticker_packs usp
                JOIN sticker_packs sp ON usp.pack_id = sp.id
                LEFT JOIN users u ON sp.owner_id = u.id
                WHERE usp.user_id=? AND sp.owner_id != ? AND sp.room_id IS NULL
                ORDER BY sp.created_at DESC
            """, (uid, uid)).fetchall()
            pack_rows = list(own) + list(installed)

        packs = _packs_with_stickers(con, pack_rows, user=current_user)
    for p in packs:
        p.pop("foreign_pack_id", None)
    return {"packs": packs, "scope": scope_norm}


@router.post("/stickers/import")
async def import_sticker(body: ImportStickerRequest, current_user: dict = Depends(get_current_user)):
    """Save a sticker to your account Saved pack (skips duplicate image)."""
    result = db.import_sticker_to_user(current_user["id"], int(body.sticker_id))
    if not result.get("ok"):
        err = result.get("error") or "import_failed"
        code = 404 if err == "not_found" else 400
        return JSONResponse(status_code=code, content={"error": err})
    return {
        "ok": True,
        "skipped": bool(result.get("skipped")),
        "id": result.get("id"),
        "pack_id": result.get("pack_id"),
        "name": result.get("name"),
    }


@router.post("/stickers/import-image")
async def import_sticker_image(body: ImportStickerImageRequest, current_user: dict = Depends(get_current_user)):
    """Save sticker image from a chat message into your Saved pack."""
    if not str(body.image_data or "").startswith("data:image/"):
        return JSONResponse(status_code=400, content={"error": "Invalid image format"})
    if len(body.image_data) > 500 * 1024:
        return JSONResponse(status_code=413, content={"error": "Sticker too large"})
    fx_json = None
    mt = str(body.media_type or "")
    if ";fx=" in mt:
        try:
            import re as _re
            m = _re.search(r";\s*fx=([A-Za-z0-9_-]+)", mt)
            if m:
                import base64 as _b64
                pad = "=" * (-len(m.group(1)) % 4)
                raw = _b64.urlsafe_b64decode(m.group(1) + pad)
                fx_json = raw.decode("utf-8")
        except Exception:
            fx_json = None
    result = db.import_sticker_image_to_user(current_user["id"], body.image_data, fx_json)
    if not result.get("ok"):
        err = result.get("error") or "import_failed"
        return JSONResponse(status_code=400, content={"error": err})
    return {
        "ok": True,
        "skipped": bool(result.get("skipped")),
        "id": result.get("id"),
        "pack_id": result.get("pack_id"),
        "name": result.get("name"),
    }


@router.post("/stickers/packs")
async def create_sticker_pack(body: CreateStickerPackRequest, current_user: dict = Depends(get_current_user)):
    """Create a new sticker pack."""
    if len(body.name) < 2 or len(body.name) > 32:
        return JSONResponse(status_code=400, content={"error": "Pack name must be 2-32 characters"})
    
    room_id = body.room_id
    if room_id is not None:
        if not db.is_room_member(current_user["id"], int(room_id)) and not bool(current_user.get("is_admin")):
            return JSONResponse(status_code=403, content={"error": "Not a channel member"})
        with db._conn() as con:
            room = con.execute("SELECT name FROM rooms WHERE id=?", (int(room_id),)).fetchone()
        if not room or not db.can_moderate_room(room["name"], current_user["id"], bool(current_user.get("is_admin"))):
            return JSONResponse(status_code=403, content={"error": "Only channel mods can create channel sticker packs"})

    with db._conn() as con:
        _ensure_sticker_schema(con)
        owner_nick = str(current_user.get("nickname") or "")[:64]
        owner_gid = str(current_user.get("global_user_id") or "").strip() or None
        cur = con.execute("""
            INSERT INTO sticker_packs (name, description, owner_id, room_id, owner_nickname, owner_global_user_id)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (body.name, body.description, current_user["id"], room_id, owner_nick, owner_gid))
        pack_id = cur.lastrowid

        if room_id is None:
            con.execute(
                "INSERT INTO user_sticker_packs (user_id, pack_id) VALUES (?, ?)",
                (current_user["id"], pack_id),
            )
    
    # New pack is private by default — no federation emit yet. It will be
    # emitted on the first PATCH that flips is_public=1.
    return {"id": pack_id, "name": body.name}


@router.post("/stickers")
async def add_sticker(body: AddStickerRequest, current_user: dict = Depends(get_current_user)):
    """Add a sticker to a pack (owner, channel mod, or node admin)."""
    with db._conn() as con:
        _ensure_sticker_schema(con)
        pack_row = con.execute(
            "SELECT * FROM sticker_packs WHERE id=?", (body.pack_id,)
        ).fetchone()
        pack_d = dict(pack_row)
        if not _user_can_manage_pack(con, pack_d, current_user):
            return JSONResponse(status_code=404, content={"error": "Pack not found or not permitted"})
        manage_id = _manage_pack_id(con, pack_d)

        count = con.execute(
            "SELECT COUNT(*) FROM stickers WHERE pack_id=?", (manage_id,)
        ).fetchone()[0]
        
        if count >= 30:
            return JSONResponse(status_code=400, content={"error": "Pack full (max 30 stickers)"})
        
        # Validate image data
        if not body.image_data.startswith("data:image/"):
            return JSONResponse(status_code=400, content={"error": "Invalid image format"})
        
        if len(body.image_data) > 500 * 1024:  # 500KB limit for stickers
            return JSONResponse(status_code=413, content={"error": "Sticker too large (max 500KB)"})

        fx = validate_sticker_effects(body.effects)
        fx_json = _json_mod.dumps(fx) if fx else None

        cur = con.execute("""
            INSERT INTO stickers (pack_id, name, image_data, emoji, effects)
            VALUES (?, ?, ?, ?, ?)
        """, (manage_id, body.name, body.image_data, body.emoji, fx_json))
        new_id = cur.lastrowid
        if manage_id != int(pack_d["id"]):
            row2 = con.execute("SELECT * FROM sticker_packs WHERE id=?", (manage_id,)).fetchone()
            if row2:
                pack_d = dict(row2)

        _after_pack_mutation(pack_d, current_user, "upsert")
    return {"id": new_id, "name": body.name, "effects": fx}


@router.get("/stickers/packs/{pack_id}")
async def get_sticker_pack(pack_id: int, current_user: dict = Depends(get_current_user)):
    """Get all stickers in a pack."""
    uid = int(current_user["id"])
    with db._conn() as con:
        _ensure_sticker_schema(con)
        pack = con.execute(f"""
            SELECT sp.*, {_STICKER_OWNER_NAME_SQL}
            FROM sticker_packs sp
            LEFT JOIN users u ON sp.owner_id = u.id
            WHERE sp.id=?
        """, (pack_id,)).fetchone()

        if not pack:
            return JSONResponse(status_code=404, content={"error": "Pack not found"})

        stickers = con.execute(
            "SELECT id, name, image_data, emoji, effects FROM stickers WHERE pack_id=? ORDER BY id",
            (pack_id,),
        ).fetchall()
        pack_d = dict(pack)
        pack_d["can_manage"] = _user_can_manage_pack(con, pack_d, current_user)
        out = [_decode_sticker_row(s) for s in stickers]
    return {"pack": pack_d, "stickers": out}


@router.post("/stickers/packs/{pack_id}/install")
async def install_sticker_pack(pack_id: int, current_user: dict = Depends(get_current_user)):
    """Install a public sticker pack."""
    with db._conn() as con:
        pack = con.execute(
            "SELECT id, is_public FROM sticker_packs WHERE id=?", (pack_id,)
        ).fetchone()
        
        if not pack:
            return JSONResponse(status_code=404, content={"error": "Pack not found"})
        
        if not pack["is_public"]:
            return JSONResponse(status_code=403, content={"error": "Pack is not public"})
        
        try:
            con.execute("""
                INSERT INTO user_sticker_packs (user_id, pack_id) VALUES (?, ?)
            """, (current_user["id"], pack_id))
        except:
            return JSONResponse(status_code=409, content={"error": "Already installed"})
    
    return {"ok": True, "message": "Sticker pack installed"}


@router.delete("/stickers/packs/{pack_id}/uninstall")
async def uninstall_sticker_pack(pack_id: int, current_user: dict = Depends(get_current_user)):
    """Uninstall a sticker pack."""
    with db._conn() as con:
        con.execute("""
            DELETE FROM user_sticker_packs WHERE user_id=? AND pack_id=?
        """, (current_user["id"], pack_id))
    
    return {"ok": True}


@router.delete("/stickers/{sticker_id}")
async def delete_sticker(sticker_id: int, current_user: dict = Depends(get_current_user)):
    """Delete a sticker (pack owner, channel mod, or node admin)."""
    with db._conn() as con:
        _ensure_sticker_schema(con)
        row = con.execute(
            "SELECT id, pack_id FROM stickers WHERE id=?", (sticker_id,)
        ).fetchone()
        if not row:
            return JSONResponse(status_code=404, content={"error": "Sticker not found"})
        pack_row = con.execute(
            "SELECT * FROM sticker_packs WHERE id=?", (int(row["pack_id"]),)
        ).fetchone()
        pack_d = dict(pack_row) if pack_row else {}
        if not pack_row or not _user_can_manage_pack(con, pack_d, current_user):
            return JSONResponse(status_code=403, content={"error": "Not permitted to delete this sticker"})
        src = con.execute(
            "SELECT image_data FROM stickers WHERE id=?", (sticker_id,)
        ).fetchone()
        img = src["image_data"] if src else None
        manage_id = _manage_pack_id(con, pack_d)
        con.execute("DELETE FROM stickers WHERE id=?", (sticker_id,))
        if img and manage_id != int(row["pack_id"]):
            con.execute(
                "DELETE FROM stickers WHERE pack_id=? AND image_data=?",
                (manage_id, img),
            )
        if _pack_is_remote_federated(pack_d):
            row2 = con.execute("SELECT * FROM sticker_packs WHERE id=?", (int(pack_d["id"]),)).fetchone()
            if row2:
                pack_d = dict(row2)
        _after_pack_mutation(pack_d, current_user, "upsert")
    return {"ok": True}


@router.post("/stickers/{sticker_id}/add-to-channel")
async def add_sticker_to_channel(
    sticker_id: int,
    body: AddStickerToChannelRequest,
    current_user: dict = Depends(get_current_user),
):
    """Copy a sticker into a channel pack (channel mods / node admins)."""
    rid = int(body.room_id)
    if not db.is_room_member(current_user["id"], rid) and not bool(current_user.get("is_admin")):
        return JSONResponse(status_code=403, content={"error": "Not a member of this channel"})
    with db._conn() as con:
        _ensure_sticker_schema(con)
        room = con.execute("SELECT name FROM rooms WHERE id=?", (rid,)).fetchone()
        if not room or not db.can_moderate_room(
            room["name"], current_user["id"], bool(current_user.get("is_admin"))
        ):
            return JSONResponse(status_code=403, content={"error": "Only channel mods can add channel stickers"})

        src = con.execute(
            "SELECT id, pack_id, name, image_data, emoji, effects FROM stickers WHERE id=?",
            (sticker_id,),
        ).fetchone()
        if not src:
            return JSONResponse(status_code=404, content={"error": "Sticker not found"})
        src_pack = con.execute(
            "SELECT * FROM sticker_packs WHERE id=?", (int(src["pack_id"]),)
        ).fetchone()
        if not src_pack or not _user_can_read_pack(con, dict(src_pack), int(current_user["id"])):
            return JSONResponse(status_code=403, content={"error": "Cannot use this sticker"})

        target_pack_id = body.pack_id
        if target_pack_id:
            tgt = con.execute(
                "SELECT * FROM sticker_packs WHERE id=? AND room_id=?",
                (int(target_pack_id), rid),
            ).fetchone()
            if not tgt:
                return JSONResponse(status_code=404, content={"error": "Channel pack not found"})
        else:
            tgt = con.execute(
                "SELECT * FROM sticker_packs WHERE room_id=? ORDER BY created_at ASC LIMIT 1",
                (rid,),
            ).fetchone()
            if not tgt:
                return JSONResponse(
                    status_code=400,
                    content={"error": "Create a channel sticker pack first"},
                )
            target_pack_id = int(tgt["id"])

        if not _user_can_manage_pack(con, dict(tgt), current_user):
            return JSONResponse(status_code=403, content={"error": "Not permitted to edit this channel pack"})

        count = con.execute(
            "SELECT COUNT(*) FROM stickers WHERE pack_id=?", (target_pack_id,)
        ).fetchone()[0]
        if count >= 30:
            return JSONResponse(status_code=400, content={"error": "Pack full (max 30 stickers)"})

        dup = con.execute(
            "SELECT id FROM stickers WHERE pack_id=? AND image_data=?",
            (target_pack_id, src["image_data"]),
        ).fetchone()
        if dup:
            return {
                "ok": True,
                "skipped": True,
                "id": int(dup["id"]),
                "pack_id": target_pack_id,
            }

        base_name = (body.name or src["name"] or "sticker").strip()[:32] or "sticker"
        name = base_name
        n = 2
        while con.execute(
            "SELECT 1 FROM stickers WHERE pack_id=? AND name=?", (target_pack_id, name)
        ).fetchone():
            suffix = f"_{n}"
            name = (base_name[: max(2, 32 - len(suffix))] + suffix)[:32]
            n += 1

        cur = con.execute(
            "INSERT INTO stickers (pack_id, name, image_data, emoji, effects) VALUES (?,?,?,?,?)",
            (target_pack_id, name, src["image_data"], src["emoji"] or "", src["effects"]),
        )
        new_id = int(cur.lastrowid)

    return {"ok": True, "skipped": False, "id": new_id, "pack_id": target_pack_id, "name": name}


@router.patch("/stickers/{sticker_id}")
async def update_sticker(sticker_id: int, body: UpdateStickerRequest,
                          current_user: dict = Depends(get_current_user)):
    """Update a sticker's name / emoji / CSS effects (pack manager).

    Effects are run through `validate_sticker_effects` so only whitelisted
    fields with clamped numeric values are persisted. Pass `effects: {}` to
    clear all effects on the sticker (resets to the plain image).
    """
    with db._conn() as con:
        _ensure_sticker_schema(con)
        sticker = con.execute(
            "SELECT id, pack_id FROM stickers WHERE id=?", (sticker_id,)
        ).fetchone()
        if not sticker:
            return JSONResponse(status_code=404, content={"error": "Sticker not found"})
        pack_row = con.execute(
            "SELECT * FROM sticker_packs WHERE id=?", (int(sticker["pack_id"]),)
        ).fetchone()
        if not pack_row or not _user_can_manage_pack(con, dict(pack_row), current_user):
            return JSONResponse(status_code=403, content={"error": "Not permitted to edit this sticker"})

        sets = []
        vals = []
        if body.name is not None:
            name = body.name.strip()
            if not name or len(name) > 64:
                return JSONResponse(status_code=400, content={"error": "Name must be 1-64 characters"})
            sets.append("name=?")
            vals.append(name)
        if body.emoji is not None:
            emoji = body.emoji.strip()
            if len(emoji) > 16:
                return JSONResponse(status_code=400, content={"error": "Emoji string too long"})
            sets.append("emoji=?")
            vals.append(emoji)
        if body.effects is not None:
            # Empty dict {} → clear effects. Anything else → validate.
            if isinstance(body.effects, dict) and not body.effects:
                sets.append("effects=?")
                vals.append(None)
            else:
                fx = validate_sticker_effects(body.effects)
                sets.append("effects=?")
                vals.append(_json_mod.dumps(fx) if fx else None)

        if not sets:
            return JSONResponse(status_code=400, content={"error": "Nothing to update"})

        vals.append(sticker_id)
        con.execute(f"UPDATE stickers SET {', '.join(sets)} WHERE id=?", vals)
        pack_d = dict(pack_row)
        if _pack_is_remote_federated(pack_d):
            row2 = con.execute("SELECT * FROM sticker_packs WHERE id=?", (int(pack_d["id"]),)).fetchone()
            if row2:
                pack_d = dict(row2)

        _after_pack_mutation(pack_d, current_user, "upsert")
    return {"ok": True}


@router.get("/stickers/public")
async def browse_public_sticker_packs(
    q: Optional[str] = Query(None),
    limit: int = Query(20, le=50)
):
    """Browse public sticker packs."""
    with db._conn() as con:
        _ensure_sticker_schema(con)
        local_sid = _local_server_id()
        origin_hide = (
            " AND (sp.origin_server_id IS NULL OR sp.origin_server_id='' "
            "OR sp.origin_server_id != ?)"
            if local_sid else
            " AND (sp.origin_server_id IS NULL OR sp.origin_server_id='')"
        )
        origin_args = (local_sid,) if local_sid else ()
        if q:
            packs = con.execute(f"""
                SELECT sp.*, {_STICKER_OWNER_NAME_SQL},
                       (SELECT COUNT(*) FROM stickers WHERE pack_id=sp.id) as sticker_count
                FROM sticker_packs sp
                LEFT JOIN users u ON sp.owner_id = u.id
                WHERE sp.is_public=1 AND sp.room_id IS NULL
                  {origin_hide}
                  AND (sp.name LIKE ? OR sp.description LIKE ?)
                ORDER BY sp.created_at DESC
                LIMIT ?
            """, (*origin_args, f'%{q}%', f'%{q}%', limit)).fetchall()
        else:
            packs = con.execute(f"""
                SELECT sp.*, {_STICKER_OWNER_NAME_SQL},
                       (SELECT COUNT(*) FROM stickers WHERE pack_id=sp.id) as sticker_count
                FROM sticker_packs sp
                LEFT JOIN users u ON sp.owner_id = u.id
                WHERE sp.is_public=1 AND sp.room_id IS NULL
                  {origin_hide}
                ORDER BY sp.created_at DESC
                LIMIT ?
            """, (*origin_args, limit)).fetchall()
    
    return {"packs": [dict(p) for p in packs]}


@router.patch("/stickers/packs/{pack_id}")
async def update_sticker_pack(pack_id: int, body: UpdateStickerPackRequest, current_user: dict = Depends(get_current_user)):
    """Update a sticker pack (owner, channel mod, or node admin)."""
    with db._conn() as con:
        _ensure_sticker_schema(con)
        pack_row = con.execute(
            "SELECT * FROM sticker_packs WHERE id=?", (pack_id,)
        ).fetchone()
        pack_d = dict(pack_row)
        if not _user_can_manage_pack(con, pack_d, current_user):
            return JSONResponse(status_code=404, content={"error": "Pack not found or not permitted"})
        pid = _manage_pack_id(con, pack_d)

        sets, vals = [], []
        if body.name is not None:
            n = body.name.strip()
            if len(n) < 2 or len(n) > 32:
                return JSONResponse(status_code=400, content={"error": "Pack name must be 2-32 characters"})
            sets.append("name=?"); vals.append(n)
        if body.description is not None:
            sets.append("description=?"); vals.append(body.description[:200])
        if body.is_public is not None:
            row_room = con.execute(
                "SELECT room_id FROM sticker_packs WHERE id=?", (pid,)
            ).fetchone()
            if row_room and row_room["room_id"]:
                return JSONResponse(
                    status_code=400,
                    content={"error": "Channel sticker packs cannot be published globally"},
                )
            sets.append("is_public=?"); vals.append(1 if body.is_public else 0)
        if not sets:
            return {"ok": True}
        vals.append(pid)
        con.execute(f"UPDATE sticker_packs SET {', '.join(sets)} WHERE id=?", vals)
        if pid != int(pack_d["id"]):
            row2 = con.execute("SELECT * FROM sticker_packs WHERE id=?", (pid,)).fetchone()
            if row2:
                pack_d = dict(row2)
        elif _pack_is_remote_federated(pack_d):
            row2 = con.execute("SELECT * FROM sticker_packs WHERE id=?", (int(pack_d["id"]),)).fetchone()
            if row2:
                pack_d = dict(row2)
        action = "upsert"
        if body.is_public is not None and not body.is_public:
            action = "delete"
        _after_pack_mutation(pack_d, current_user, action)
    return {"ok": True}


@router.delete("/stickers/packs/{pack_id}")
async def delete_sticker_pack(pack_id: int, current_user: dict = Depends(get_current_user)):
    """Delete a sticker pack (owner, channel mod, or node admin). Cascades stickers + installs."""
    with db._conn() as con:
        _ensure_sticker_schema(con)
        pack_row = con.execute(
            "SELECT * FROM sticker_packs WHERE id=?", (pack_id,)
        ).fetchone()
        pack_d = dict(pack_row) if pack_row else {}
        if not _user_can_manage_pack(con, pack_d, current_user):
            return JSONResponse(status_code=404, content={"error": "Pack not found or not permitted"})

        if _pack_is_remote_federated(pack_d):
            _fed_owner_request_sync(con, pack_d, current_user, "delete")
            pid = int(pack_d["id"])
            con.execute("DELETE FROM stickers WHERE pack_id=?", (pid,))
            con.execute("DELETE FROM user_sticker_packs WHERE pack_id=?", (pid,))
            con.execute("DELETE FROM sticker_packs WHERE id=?", (pid,))
            return {"ok": True}

        pid = _canonical_pack_id_for_manage(con, pack_d)
        local_sid = _local_server_id()
        pack_ids = [pid]
        if local_sid:
            mirrors = con.execute(
                "SELECT id FROM sticker_packs WHERE foreign_pack_id=? AND origin_server_id=?",
                (pid, local_sid),
            ).fetchall()
            pack_ids.extend(int(r["id"]) for r in mirrors)
        pack_ids = list(dict.fromkeys(pack_ids))
        canon = con.execute(
            "SELECT is_public, origin_server_id FROM sticker_packs WHERE id=?", (pid,)
        ).fetchone()
        was_public = int(canon["is_public"] or 0) if canon else 0
        is_foreign = bool(canon and canon["origin_server_id"])
        for del_id in pack_ids:
            con.execute("DELETE FROM stickers WHERE pack_id=?", (del_id,))
            con.execute("DELETE FROM user_sticker_packs WHERE pack_id=?", (del_id,))
            con.execute("DELETE FROM sticker_packs WHERE id=?", (del_id,))
        pack_id = pid
    if was_public and not is_foreign:
        try:
            from routers import federation as _fed
            _fed.enqueue_server_event("sticker.pack.delete", {"pack_id": pack_id})
        except Exception:
            pass
    return {"ok": True}

