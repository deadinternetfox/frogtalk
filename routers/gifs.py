"""GIF search (via Tenor) and custom stickers routes."""
import os
import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

import database as db
from deps import get_current_user

router = APIRouter(prefix="/media", tags=["media"])

# Tenor API - free, no key required for basic usage, or use their free key
TENOR_API_KEY = os.getenv("TENOR_API_KEY", "AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ")  # Public Google/Tenor key


# ---------------------------------------------------------------------------
# GIF Search via Tenor
# ---------------------------------------------------------------------------

@router.get("/gifs/search")
async def search_gifs(
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(20, le=50)
):
    """Search for GIFs via Tenor API."""
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
                        "title": result.get("title", "")
                    })
            
            return {"gifs": gifs, "query": q}
            
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"GIF search failed: {str(e)}"})


@router.get("/gifs/trending")
async def trending_gifs(limit: int = Query(20, le=50)):
    """Get trending GIFs."""
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
                        "height": gif_data.get("dims", [0, 0])[1]
                    })
            
            return {"gifs": gifs}
            
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"Failed to get trending GIFs"})


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
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        
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
        
        # Get installed packs
        installed_packs = con.execute("""
            SELECT sp.*, u.nickname as owner_name,
                   (SELECT COUNT(*) FROM stickers WHERE pack_id=sp.id) as sticker_count
            FROM user_sticker_packs usp
            JOIN sticker_packs sp ON usp.pack_id = sp.id
            JOIN users u ON sp.owner_id = u.id
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
    
    return {"id": cur.lastrowid, "name": body.name}


@router.get("/stickers/packs/{pack_id}")
async def get_sticker_pack(pack_id: int, current_user: dict = Depends(get_current_user)):
    """Get all stickers in a pack."""
    with db._conn() as con:
        pack = con.execute("""
            SELECT sp.*, u.nickname as owner_name
            FROM sticker_packs sp
            JOIN users u ON sp.owner_id = u.id
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
            SELECT s.id FROM stickers s
            JOIN sticker_packs sp ON s.pack_id = sp.id
            WHERE s.id=? AND sp.owner_id=?
        """, (sticker_id, current_user["id"])).fetchone()
        
        if not sticker:
            return JSONResponse(status_code=404, content={"error": "Sticker not found or not owned by you"})
        
        con.execute("DELETE FROM stickers WHERE id=?", (sticker_id,))
    
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
                SELECT sp.*, u.nickname as owner_name,
                       (SELECT COUNT(*) FROM stickers WHERE pack_id=sp.id) as sticker_count
                FROM sticker_packs sp
                JOIN users u ON sp.owner_id = u.id
                WHERE sp.is_public=1 AND (sp.name LIKE ? OR sp.description LIKE ?)
                ORDER BY sp.created_at DESC
                LIMIT ?
            """, (f'%{q}%', f'%{q}%', limit)).fetchall()
        else:
            packs = con.execute("""
                SELECT sp.*, u.nickname as owner_name,
                       (SELECT COUNT(*) FROM stickers WHERE pack_id=sp.id) as sticker_count
                FROM sticker_packs sp
                JOIN users u ON sp.owner_id = u.id
                WHERE sp.is_public=1
                ORDER BY sp.created_at DESC
                LIMIT ?
            """, (limit,)).fetchall()
    
    return {"packs": [dict(p) for p in packs]}
