"""GIF search (via KLIPY, with Tenor fallback) and custom stickers routes."""
import logging
import os
import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

import database as db
from deps import get_current_user

router = APIRouter(prefix="/media", tags=["media"])
_log = logging.getLogger("frogtalk.gifs")

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
            if action == "upsert" and not pack.get("is_public"):
                # Private packs aren't federated. If a pack flips public->private
                # we emit a delete instead (handled by caller).
                return
            payload = {
                "pack_id": pack["id"],
                "name": pack.get("name"),
                "description": pack.get("description") or "",
                "owner_nickname": None,
                "is_public": int(pack.get("is_public") or 0),
                "stickers": [],
            }
            owner = con.execute(
                "SELECT nickname FROM users WHERE id=?", (pack.get("owner_id"),)
            ).fetchone()
            if owner:
                payload["owner_nickname"] = owner["nickname"]
            if action == "upsert":
                rows = con.execute(
                    "SELECT id, name, image_data, emoji FROM stickers WHERE pack_id=?",
                    (pack_id,),
                ).fetchall()
                payload["stickers"] = [dict(r) for r in rows]
        _fed.enqueue_server_event(f"sticker.pack.{action}", payload)
    except Exception:
        _log.exception("Federation emit failed (pack=%s action=%s)", pack_id, action)

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


def _klipy_to_gif(item: dict) -> Optional[dict]:
    if not isinstance(item, dict):
        return None
    # Skip ad slots — caller handles content only.
    if str(item.get("type") or "").lower() == "ad":
        return None
    f = item.get("file") or item.get("file_meta") or {}
    full = _klipy_pick_url(f, "hd", "md", "sm", "xs", "gif", "url")
    preview = _klipy_pick_url(f, "sm", "xs", "md", "hd") or full
    if not full:
        return None
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
            
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"GIF search failed: {str(e)}"})


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


class UpdateStickerPackRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_public: Optional[bool] = None


class AddStickerRequest(BaseModel):
    pack_id: int
    name: str
    image_data: str  # Base64 encoded image
    emoji: str = ""  # Associated emoji


@router.get("/stickers/packs")
async def list_sticker_packs(current_user: dict = Depends(get_current_user)):
    """List all sticker packs (user's own + installed)."""
    with db._conn() as con:
        # Ensure tables exist
        con.execute("""CREATE TABLE IF NOT EXISTS sticker_packs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            owner_id INTEGER NOT NULL,
            is_public INTEGER DEFAULT 0,
            origin_server_id TEXT DEFAULT NULL,
            foreign_pack_id INTEGER DEFAULT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        # Backfill columns on old DBs (idempotent).
        for _col, _ddl in (
            ("origin_server_id", "ALTER TABLE sticker_packs ADD COLUMN origin_server_id TEXT DEFAULT NULL"),
            ("foreign_pack_id",  "ALTER TABLE sticker_packs ADD COLUMN foreign_pack_id INTEGER DEFAULT NULL"),
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
        except Exception:
            pass
        
        con.execute("""CREATE TABLE IF NOT EXISTS stickers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pack_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            image_data TEXT NOT NULL,
            emoji TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (pack_id) REFERENCES sticker_packs(id) ON DELETE CASCADE
        )""")
        
        con.execute("""CREATE TABLE IF NOT EXISTS user_sticker_packs (
            user_id INTEGER NOT NULL,
            pack_id INTEGER NOT NULL,
            PRIMARY KEY (user_id, pack_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (pack_id) REFERENCES sticker_packs(id) ON DELETE CASCADE
        )""")
        
        # Get user's own packs
        own_packs = con.execute("""
            SELECT sp.*, 
                   (SELECT COUNT(*) FROM stickers WHERE pack_id=sp.id) as sticker_count
            FROM sticker_packs sp
            WHERE sp.owner_id=?
        """, (current_user["id"],)).fetchall()
        
        # Get installed packs (includes federated packs whose owner_id = -1)
        installed_packs = con.execute("""
            SELECT sp.*, COALESCE(u.nickname, '@federated') as owner_name,
                   (SELECT COUNT(*) FROM stickers WHERE pack_id=sp.id) as sticker_count
            FROM user_sticker_packs usp
            JOIN sticker_packs sp ON usp.pack_id = sp.id
            LEFT JOIN users u ON sp.owner_id = u.id
            WHERE usp.user_id=? AND sp.owner_id != ?
        """, (current_user["id"], current_user["id"])).fetchall()
    
    return {
        "own_packs": [dict(p) for p in own_packs],
        "installed_packs": [dict(p) for p in installed_packs]
    }


@router.post("/stickers/packs")
async def create_sticker_pack(body: CreateStickerPackRequest, current_user: dict = Depends(get_current_user)):
    """Create a new sticker pack."""
    if len(body.name) < 2 or len(body.name) > 32:
        return JSONResponse(status_code=400, content={"error": "Pack name must be 2-32 characters"})
    
    with db._conn() as con:
        cur = con.execute("""
            INSERT INTO sticker_packs (name, description, owner_id)
            VALUES (?, ?, ?)
        """, (body.name, body.description, current_user["id"]))
        pack_id = cur.lastrowid
        
        # Auto-install for creator
        con.execute("""
            INSERT INTO user_sticker_packs (user_id, pack_id) VALUES (?, ?)
        """, (current_user["id"], pack_id))
    
    # New pack is private by default — no federation emit yet. It will be
    # emitted on the first PATCH that flips is_public=1.
    return {"id": pack_id, "name": body.name}


@router.post("/stickers")
async def add_sticker(body: AddStickerRequest, current_user: dict = Depends(get_current_user)):
    """Add a sticker to a pack."""
    # Verify ownership
    with db._conn() as con:
        pack = con.execute(
            "SELECT id FROM sticker_packs WHERE id=? AND owner_id=?",
            (body.pack_id, current_user["id"])
        ).fetchone()
        
        if not pack:
            return JSONResponse(status_code=404, content={"error": "Pack not found or not owned by you"})
        
        # Limit stickers per pack
        count = con.execute(
            "SELECT COUNT(*) FROM stickers WHERE pack_id=?", (body.pack_id,)
        ).fetchone()[0]
        
        if count >= 30:
            return JSONResponse(status_code=400, content={"error": "Pack full (max 30 stickers)"})
        
        # Validate image data
        if not body.image_data.startswith("data:image/"):
            return JSONResponse(status_code=400, content={"error": "Invalid image format"})
        
        if len(body.image_data) > 500 * 1024:  # 500KB limit for stickers
            return JSONResponse(status_code=413, content={"error": "Sticker too large (max 500KB)"})
        
        cur = con.execute("""
            INSERT INTO stickers (pack_id, name, image_data, emoji)
            VALUES (?, ?, ?, ?)
        """, (body.pack_id, body.name, body.image_data, body.emoji))
    
    _fed_emit_sticker_event(body.pack_id, "upsert")
    return {"id": cur.lastrowid, "name": body.name}


@router.get("/stickers/packs/{pack_id}")
async def get_sticker_pack(pack_id: int, current_user: dict = Depends(get_current_user)):
    """Get all stickers in a pack."""
    with db._conn() as con:
        pack = con.execute("""
            SELECT sp.*, COALESCE(u.nickname, '@federated') as owner_name
            FROM sticker_packs sp
            LEFT JOIN users u ON sp.owner_id = u.id
            WHERE sp.id=?
        """, (pack_id,)).fetchone()
        
        if not pack:
            return JSONResponse(status_code=404, content={"error": "Pack not found"})
        
        stickers = con.execute("""
            SELECT id, name, image_data, emoji FROM stickers WHERE pack_id=?
        """, (pack_id,)).fetchall()
    
    return {
        "pack": dict(pack),
        "stickers": [dict(s) for s in stickers]
    }


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
    """Delete a sticker (owner only)."""
    with db._conn() as con:
        sticker = con.execute("""
            SELECT s.id, s.pack_id FROM stickers s
            JOIN sticker_packs sp ON s.pack_id = sp.id
            WHERE s.id=? AND sp.owner_id=?
        """, (sticker_id, current_user["id"])).fetchone()
        
        if not sticker:
            return JSONResponse(status_code=404, content={"error": "Sticker not found or not owned by you"})
        
        con.execute("DELETE FROM stickers WHERE id=?", (sticker_id,))
        pack_id_for_emit = int(sticker["pack_id"]) if "pack_id" in sticker.keys() else None
    if pack_id_for_emit:
        _fed_emit_sticker_event(pack_id_for_emit, "upsert")
    return {"ok": True}


@router.get("/stickers/public")
async def browse_public_sticker_packs(
    q: Optional[str] = Query(None),
    limit: int = Query(20, le=50)
):
    """Browse public sticker packs."""
    with db._conn() as con:
        if q:
            packs = con.execute("""
                SELECT sp.*, COALESCE(u.nickname, '@federated') as owner_name,
                       (SELECT COUNT(*) FROM stickers WHERE pack_id=sp.id) as sticker_count
                FROM sticker_packs sp
                LEFT JOIN users u ON sp.owner_id = u.id
                WHERE sp.is_public=1 AND (sp.name LIKE ? OR sp.description LIKE ?)
                ORDER BY sp.created_at DESC
                LIMIT ?
            """, (f'%{q}%', f'%{q}%', limit)).fetchall()
        else:
            packs = con.execute("""
                SELECT sp.*, COALESCE(u.nickname, '@federated') as owner_name,
                       (SELECT COUNT(*) FROM stickers WHERE pack_id=sp.id) as sticker_count
                FROM sticker_packs sp
                LEFT JOIN users u ON sp.owner_id = u.id
                WHERE sp.is_public=1
                ORDER BY sp.created_at DESC
                LIMIT ?
            """, (limit,)).fetchall()
    
    return {"packs": [dict(p) for p in packs]}


@router.patch("/stickers/packs/{pack_id}")
async def update_sticker_pack(pack_id: int, body: UpdateStickerPackRequest, current_user: dict = Depends(get_current_user)):
    """Update a sticker pack (owner only)."""
    with db._conn() as con:
        pack = con.execute(
            "SELECT id FROM sticker_packs WHERE id=? AND owner_id=?",
            (pack_id, current_user["id"])
        ).fetchone()
        if not pack:
            return JSONResponse(status_code=404, content={"error": "Pack not found or not owned by you"})

        sets, vals = [], []
        if body.name is not None:
            n = body.name.strip()
            if len(n) < 2 or len(n) > 32:
                return JSONResponse(status_code=400, content={"error": "Pack name must be 2-32 characters"})
            sets.append("name=?"); vals.append(n)
        if body.description is not None:
            sets.append("description=?"); vals.append(body.description[:200])
        if body.is_public is not None:
            sets.append("is_public=?"); vals.append(1 if body.is_public else 0)
        if not sets:
            return {"ok": True}
        vals.append(pack_id)
        con.execute(f"UPDATE sticker_packs SET {', '.join(sets)} WHERE id=?", vals)
    # If the public flag was touched, emit. Going public → upsert; going
    # private → delete. Other edits (name/description) also propagate via
    # upsert when the pack is currently public.
    if body.is_public is not None:
        _fed_emit_sticker_event(pack_id, "upsert" if body.is_public else "delete")
    elif body.name is not None or body.description is not None:
        _fed_emit_sticker_event(pack_id, "upsert")
    return {"ok": True}


@router.delete("/stickers/packs/{pack_id}")
async def delete_sticker_pack(pack_id: int, current_user: dict = Depends(get_current_user)):
    """Delete a sticker pack (owner only). Cascades stickers + installs."""
    with db._conn() as con:
        pack = con.execute(
            "SELECT id, is_public, origin_server_id FROM sticker_packs WHERE id=? AND owner_id=?",
            (pack_id, current_user["id"])
        ).fetchone()
        if not pack:
            return JSONResponse(status_code=404, content={"error": "Pack not found or not owned by you"})
        con.execute("DELETE FROM stickers WHERE pack_id=?", (pack_id,))
        con.execute("DELETE FROM user_sticker_packs WHERE pack_id=?", (pack_id,))
        was_public = int(pack["is_public"] or 0)
        is_foreign  = bool(pack["origin_server_id"])
        con.execute("DELETE FROM sticker_packs WHERE id=?", (pack_id,))
    if was_public and not is_foreign:
        # Tell peers the pack went away.
        try:
            from routers import federation as _fed
            _fed.enqueue_server_event("sticker.pack.delete", {"pack_id": pack_id})
        except Exception:
            pass
    return {"ok": True}

