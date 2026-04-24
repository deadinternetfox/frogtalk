"""Auth routes: register, login, logout, me."""
import re
from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

import database as db
from deps import get_current_user
from ws_manager import manager

router = APIRouter(prefix="/auth", tags=["auth"])
limiter = Limiter(key_func=get_remote_address)

NICKNAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{2,32}$")

MAX_AVATAR_BYTES = 2 * 1024 * 1024  # 2 MB in base64


class RegisterRequest(BaseModel):
    nickname: str
    password: str


class LoginRequest(BaseModel):
    nickname: str
    password: str


class ProfileUpdateRequest(BaseModel):
    avatar: str | None = None
    banner: str | None = None
    bio: str | None = None
    new_password: str | None = None
    current_password: str | None = None
    status_msg: str | None = None
    presence: str | None = None
    profile_public: bool | None = None
    allow_friend_requests: bool | None = None
    # New settings fields
    theme: str | None = None
    notify_sounds: bool | None = None
    notify_desktop: bool | None = None
    notify_dms: bool | None = None
    notify_mentions: bool | None = None
    allow_dms_from: str | None = None
    show_last_seen: str | None = None
    show_read_receipts: bool | None = None
    hide_active_channels: bool | None = None


@router.post("/register")
@limiter.limit("10/hour")
async def register(request: Request, body: RegisterRequest):
    if not NICKNAME_RE.match(body.nickname):
        return JSONResponse(status_code=400, content={
            "error": "Nickname must be 2-32 characters: letters, numbers, _ or -"
        })
    if len(body.password) < 6:
        return JSONResponse(status_code=400, content={"error": "Password must be at least 6 characters"})
    user_id = db.create_user(body.nickname, body.password)
    if user_id is None:
        return JSONResponse(status_code=409, content={"error": "Nickname already taken"})
    db.auto_join_defaults(user_id)
    token = db.create_session(user_id)
    return {"token": token, "nickname": body.nickname, "user_id": user_id, "is_admin": False}


@router.post("/login")
@limiter.limit("20/hour")
async def login(request: Request, body: LoginRequest):
    user = db.verify_user(body.nickname, body.password)
    if not user:
        return JSONResponse(status_code=401, content={"error": "Invalid nickname or password"})
    token = db.create_session(user["id"])
    return {
        "token": token,
        "nickname": user["nickname"],
        "user_id": user["id"],
        "is_admin": bool(user["is_admin"]),
        "avatar": user["avatar"],
        "bio": user["bio"],
    }


@router.post("/logout")
async def logout(x_session_token: str = None, current_user: dict = Depends(get_current_user)):
    from fastapi import Header
    # Token comes through the dependency — delete it
    return {"ok": True}


class NicknameChangeRequest(BaseModel):
    nickname: str
    password: str


@router.patch("/nickname")
async def change_nickname(body: NicknameChangeRequest, current_user: dict = Depends(get_current_user)):
    """Change user's nickname. Requires password confirmation."""
    if not NICKNAME_RE.match(body.nickname):
        return JSONResponse(status_code=400, content={
            "error": "Nickname must be 2-32 characters: letters, numbers, _ or -"
        })
    if body.nickname == current_user["nickname"]:
        return JSONResponse(status_code=400, content={"error": "That's already your nickname"})
    if not db.verify_user(current_user["nickname"], body.password):
        return JSONResponse(status_code=401, content={"error": "Incorrect password"})
    existing = db.get_user_by_nick(body.nickname)
    if existing and existing["id"] != current_user["id"]:
        return JSONResponse(status_code=409, content={"error": "Nickname already taken"})
    try:
        with db._conn() as con:
            # Log old nickname to history
            con.execute("INSERT INTO nickname_history (user_id, old_nickname) VALUES (?, ?)",
                       (current_user["id"], current_user["nickname"]))
            # Update nickname — FK user_id keeps posts, DMs, messages intact
            con.execute("UPDATE users SET nickname=? WHERE id=?", (body.nickname, current_user["id"]))
            con.commit()
    except Exception:
        return JSONResponse(status_code=409, content={"error": "Nickname already taken"})
    return {"ok": True, "nickname": body.nickname}


@router.get("/me")
async def me(current_user: dict = Depends(get_current_user)):
    return current_user


@router.patch("/profile")
async def update_profile(body: ProfileUpdateRequest, current_user: dict = Depends(get_current_user)):
    # Validate avatar size
    if body.avatar and len(body.avatar) > MAX_AVATAR_BYTES:
        return JSONResponse(status_code=413, content={"error": "Avatar too large (max 2MB)"})

    # Validate avatar is a safe data URL
    if body.avatar:
        allowed = ('data:image/png;base64,', 'data:image/jpeg;base64,',
                   'data:image/webp;base64,', 'data:image/gif;base64,')
        if not any(body.avatar.startswith(p) for p in allowed):
            return JSONResponse(status_code=400, content={"error": "Invalid avatar format"})

    # Validate banner
    if body.banner and len(body.banner) > 3 * 1024 * 1024:
        return JSONResponse(status_code=413, content={"error": "Banner too large (max 3MB)"})
    if body.banner:
        allowed_b = ('data:image/png;base64,', 'data:image/jpeg;base64,',
                     'data:image/webp;base64,', 'data:image/gif;base64,')
        if not any(body.banner.startswith(p) for p in allowed_b):
            return JSONResponse(status_code=400, content={"error": "Invalid banner format"})

    # Require current password to change password
    if body.new_password:
        if not body.current_password:
            return JSONResponse(status_code=400, content={"error": "Current password required"})
        if not db.verify_user(current_user["nickname"], body.current_password or ""):
            return JSONResponse(status_code=401, content={"error": "Current password incorrect"})
        if len(body.new_password) < 6:
            return JSONResponse(status_code=400, content={"error": "New password must be 6+ characters"})

    db.update_profile(
        current_user["id"],
        avatar=body.avatar,
        bio=body.bio,
        new_password=body.new_password,
        banner=body.banner,
    )
    if body.status_msg is not None or body.presence is not None:
        with db._conn() as con:
            if body.status_msg is not None:
                con.execute("UPDATE users SET status_msg=? WHERE id=?",
                            (body.status_msg[:128], current_user["id"]))
            if body.presence is not None:
                allowed_p = {"online", "away", "dnd", "invisible"}
                if body.presence in allowed_p:
                    con.execute("UPDATE users SET presence=? WHERE id=?",
                                (body.presence, current_user["id"]))
            con.commit()
    if body.profile_public is not None or body.allow_friend_requests is not None:
        profile_public = body.profile_public if body.profile_public is not None else True
        allow_fr = body.allow_friend_requests if body.allow_friend_requests is not None else True
        db.update_privacy(current_user["id"], profile_public, allow_fr)
    # Update user settings
    with db._conn() as con:
        if body.theme is not None:
            allowed_themes = {"dark", "light", "midnight", "forest", "cyberpunk", "ocean", "sunset"}
            if body.theme in allowed_themes:
                con.execute("UPDATE users SET theme=? WHERE id=?", (body.theme, current_user["id"]))
        if body.notify_sounds is not None:
            con.execute("UPDATE users SET notify_sounds=? WHERE id=?", (1 if body.notify_sounds else 0, current_user["id"]))
        if body.notify_desktop is not None:
            con.execute("UPDATE users SET notify_desktop=? WHERE id=?", (1 if body.notify_desktop else 0, current_user["id"]))
        if body.notify_dms is not None:
            con.execute("UPDATE users SET notify_dms=? WHERE id=?", (1 if body.notify_dms else 0, current_user["id"]))
        if body.notify_mentions is not None:
            con.execute("UPDATE users SET notify_mentions=? WHERE id=?", (1 if body.notify_mentions else 0, current_user["id"]))
        if body.allow_dms_from is not None:
            allowed_dm_opts = {"everyone", "friends", "nobody"}
            if body.allow_dms_from in allowed_dm_opts:
                con.execute("UPDATE users SET allow_dms_from=? WHERE id=?", (body.allow_dms_from, current_user["id"]))
        if body.show_last_seen is not None:
            allowed_ls = {"everyone", "friends", "nobody"}
            if body.show_last_seen in allowed_ls:
                con.execute("UPDATE users SET show_last_seen=? WHERE id=?", (body.show_last_seen, current_user["id"]))
        if body.show_read_receipts is not None:
            con.execute("UPDATE users SET show_read_receipts=? WHERE id=?",
                        (1 if body.show_read_receipts else 0, current_user["id"]))
        if body.hide_active_channels is not None:
            con.execute("UPDATE users SET hide_active_channels=? WHERE id=?",
                        (1 if body.hide_active_channels else 0, current_user["id"]))
        con.commit()
    # Broadcast profile update so open clients refresh avatars / nicknames in member lists
    if body.avatar is not None:
        try:
            manager.update_user_meta(current_user["id"], avatar=body.avatar)
        except Exception:
            pass
        try:
            await manager.broadcast_all({
                "type": "profile_update",
                "user_id": current_user["id"],
                "nickname": current_user["nickname"],
                "avatar": body.avatar,
            })
        except Exception:
            pass
    return {"ok": True}


class DeleteAccountRequest(BaseModel):
    password: str


@router.delete("/account")
async def delete_account(body: DeleteAccountRequest, current_user: dict = Depends(get_current_user)):
    """Permanently delete user account. Requires password confirmation."""
    # Verify password
    if not db.verify_user(current_user["nickname"], body.password):
        return JSONResponse(status_code=401, content={"error": "Incorrect password"})
    
    # Prevent admin account deletion
    if current_user.get("is_admin"):
        return JSONResponse(status_code=403, content={"error": "Admin accounts cannot be deleted"})
    
    # Delete the account
    ok = db.delete_user_account(current_user["id"])
    if not ok:
        return JSONResponse(status_code=500, content={"error": "Failed to delete account"})
    
    return {"ok": True, "message": "Account permanently deleted"}


# ===========================================================================
# CAPTCHA System - Image-based challenge for registration
# ===========================================================================
import secrets
import base64
import io
import hashlib

# Simple CAPTCHA generation without external dependencies
def generate_captcha_image(text: str) -> str:
    """Generate a simple ASCII-art style CAPTCHA as base64 PNG."""
    try:
        from PIL import Image, ImageDraw, ImageFont
        import random
        
        width, height = 200, 80
        img = Image.new('RGB', (width, height), color='#1a1a1a')
        draw = ImageDraw.Draw(img)
        
        # Draw noise lines
        for _ in range(8):
            x1 = random.randint(0, width)
            y1 = random.randint(0, height)
            x2 = random.randint(0, width)
            y2 = random.randint(0, height)
            draw.line([(x1, y1), (x2, y2)], fill='#333333', width=1)
        
        # Draw the text
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 36)
        except:
            font = ImageFont.load_default()
        
        # Calculate text position
        bbox = draw.textbbox((0, 0), text, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]
        x = (width - text_width) // 2
        y = (height - text_height) // 2
        
        # Draw text with slight distortion
        for i, char in enumerate(text):
            char_x = x + i * (text_width // len(text))
            char_y = y + random.randint(-5, 5)
            color = random.choice(['#4caf50', '#66bb6a', '#81c784'])
            draw.text((char_x, char_y), char, font=font, fill=color)
        
        # Add noise dots
        for _ in range(100):
            x = random.randint(0, width - 1)
            y = random.randint(0, height - 1)
            draw.point((x, y), fill='#444444')
        
        # Convert to base64
        buffer = io.BytesIO()
        img.save(buffer, format='PNG')
        return f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode()}"
    except ImportError:
        # Fallback: return simple text-based challenge
        return None


def generate_captcha_text(length: int = 5) -> str:
    """Generate random CAPTCHA text (avoiding confusing chars)."""
    chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(chars) for _ in range(length))


class CaptchaResponse(BaseModel):
    challenge_id: str
    image: str | None = None
    text_challenge: str | None = None  # Fallback if image generation fails


@router.get("/captcha")
@limiter.limit("30/hour")
async def get_captcha(request: Request):
    """Generate a new CAPTCHA challenge."""
    challenge_id = secrets.token_urlsafe(16)
    answer = generate_captcha_text(5)
    
    # Store challenge
    db.create_captcha(challenge_id, answer, expires_minutes=5)
    
    # Try to generate image
    image = generate_captcha_image(answer)
    
    if image:
        return {"challenge_id": challenge_id, "image": image}
    else:
        # Fallback: math challenge
        a, b = secrets.randbelow(20) + 1, secrets.randbelow(20) + 1
        math_answer = str(a + b)
        db.create_captcha(challenge_id, math_answer, expires_minutes=5)
        return {
            "challenge_id": challenge_id,
            "text_challenge": f"What is {a} + {b}?"
        }


class RegisterWithCaptchaRequest(BaseModel):
    nickname: str
    password: str
    captcha_id: str
    captcha_answer: str


@router.post("/register-secure")
@limiter.limit("10/hour")
async def register_with_captcha(request: Request, body: RegisterWithCaptchaRequest):
    """Register with CAPTCHA verification (bot-proof)."""
    # Verify CAPTCHA first
    if not db.verify_captcha(body.captcha_id, body.captcha_answer):
        return JSONResponse(status_code=400, content={"error": "Invalid or expired CAPTCHA"})
    
    # Normal registration logic
    if not NICKNAME_RE.match(body.nickname):
        return JSONResponse(status_code=400, content={
            "error": "Nickname must be 2-32 characters: letters, numbers, _ or -"
        })
    if len(body.password) < 6:
        return JSONResponse(status_code=400, content={"error": "Password must be at least 6 characters"})
    
    user_id = db.create_user(body.nickname, body.password)
    if user_id is None:
        return JSONResponse(status_code=409, content={"error": "Nickname already taken"})
    db.auto_join_defaults(user_id)
    token = db.create_session(user_id)
    return {"token": token, "nickname": body.nickname, "user_id": user_id, "is_admin": False}


# ===========================================================================
# Recovery Key System - Account recovery without email
# ===========================================================================

class GenerateRecoveryKeyRequest(BaseModel):
    password: str  # Verify identity


@router.post("/recovery-key")
async def generate_recovery_key(body: GenerateRecoveryKeyRequest, current_user: dict = Depends(get_current_user)):
    """Generate a recovery key file for account recovery."""
    # Verify password
    if not db.verify_user(current_user["nickname"], body.password):
        return JSONResponse(status_code=401, content={"error": "Incorrect password"})
    
    # Generate recovery key
    raw_key = secrets.token_urlsafe(32)
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    
    db.create_recovery_key(current_user["id"], key_hash)
    
    # Create recovery file content
    recovery_data = {
        "app": "FrogTalk",
        "version": 1,
        "username": current_user["nickname"],
        "user_id": current_user["id"],
        "recovery_key": raw_key,
        "warning": "KEEP THIS FILE SAFE! Anyone with this key can access your account."
    }
    
    import json
    recovery_json = json.dumps(recovery_data, indent=2)
    recovery_b64 = base64.b64encode(recovery_json.encode()).decode()
    
    return {
        "recovery_key": raw_key,
        "file_content": f"data:application/json;base64,{recovery_b64}",
        "filename": f"frogtalk-recovery-{current_user['nickname']}.json",
        "message": "Save this file securely! It's the ONLY way to recover your account."
    }


class RecoverAccountRequest(BaseModel):
    recovery_key: str
    new_password: str


@router.post("/recover")
@limiter.limit("5/hour")
async def recover_account(request: Request, body: RecoverAccountRequest):
    """Recover account using recovery key."""
    if len(body.new_password) < 6:
        return JSONResponse(status_code=400, content={"error": "Password must be at least 6 characters"})
    
    key_hash = hashlib.sha256(body.recovery_key.encode()).hexdigest()
    user_id = db.use_recovery_key(key_hash)
    
    if not user_id:
        return JSONResponse(status_code=401, content={"error": "Invalid or already used recovery key"})
    
    # Reset password
    with db._conn() as con:
        from bcrypt import hashpw, gensalt
        pw_hash = hashpw(body.new_password.encode(), gensalt()).decode()
        con.execute("UPDATE users SET password_hash=? WHERE id=?", (pw_hash, user_id))
        
        # Get user info
        user = con.execute("SELECT nickname FROM users WHERE id=?", (user_id,)).fetchone()
    
    # Create new session
    token = db.create_session(user_id)
    
    return {
        "ok": True,
        "token": token,
        "nickname": user["nickname"],
        "message": "Account recovered! Please generate a new recovery key."
    }


class VerifyRecoveryKeyRequest(BaseModel):
    recovery_key: str


@router.post("/verify-recovery-key")
async def verify_recovery_key(body: VerifyRecoveryKeyRequest):
    """Check if a recovery key is valid (without using it)."""
    key_hash = hashlib.sha256(body.recovery_key.encode()).hexdigest()
    
    with db._conn() as con:
        row = con.execute("""
            SELECT rk.id, u.nickname FROM recovery_keys rk
            JOIN users u ON rk.user_id = u.id
            WHERE rk.key_hash=? AND rk.used_at IS NULL
        """, (key_hash,)).fetchone()
    
    if row:
        return {"valid": True, "username": row["nickname"]}
    return {"valid": False}
