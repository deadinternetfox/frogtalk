"""SQLite database layer for FrogChat."""
import os
import json
import secrets
import sqlite3
import threading
import uuid
import time
import hmac
import hashlib
import base64
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import bcrypt as _bcrypt

# ── Bridge token at-rest encryption ───────────────────────────────────
# Telegram / Discord bot tokens stored in telegram_bridges.bot_token and
# discord_bridges.bot_token are sensitive (a leaked Telegram bot token
# lets anyone post as the bot). We Fernet-encrypt them at rest with a
# key-encryption-key (KEK) that lives outside the database — either an
# env var or a 0600-perm file in the data dir. Migration is transparent:
# rows still in plaintext are detected by the missing "fkek1:" prefix
# and re-encrypted on first read.
try:
    from cryptography.fernet import Fernet as _Fernet, InvalidToken as _FInvalid
    _FERNET_AVAILABLE = True
except Exception:                          # pragma: no cover - cryptography missing
    _Fernet = None
    _FInvalid = Exception
    _FERNET_AVAILABLE = False

_BRIDGE_KEK_PREFIX = "fkek1:"              # marker so we know it's encrypted
_bridge_fernet = None                       # lazy singleton

def _bridge_kek_path() -> Path:
    return Path(os.getenv("FROGTALK_BRIDGE_KEK_PATH", "data/bridge_kek.key"))

def _load_bridge_fernet():
    """Resolve the Fernet KEK in this priority order:
       1. FROGTALK_BRIDGE_KEK env (already a base64 urlsafe Fernet key)
       2. <data dir>/bridge_kek.key file (created on first call, 0600)
    Returns None if cryptography isn't installed, in which case the
    caller silently falls back to plaintext storage (compat path)."""
    global _bridge_fernet
    if _bridge_fernet is not None:
        return _bridge_fernet
    if not _FERNET_AVAILABLE:
        return None
    env_key = (os.getenv("FROGTALK_BRIDGE_KEK") or "").strip()
    if env_key:
        try:
            _bridge_fernet = _Fernet(env_key.encode())
            return _bridge_fernet
        except Exception:
            # Bad env key — fall through to file-backed key rather than
            # crash on import. Operator gets logged warnings via the
            # caller paths instead.
            pass
    path = _bridge_kek_path()
    try:
        if path.exists():
            key = path.read_bytes().strip()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            key = _Fernet.generate_key()
            # Atomic 0600 write — same pattern used by the bootstrap
            # admin password file in the 8th-pass hardening.
            fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, key)
            finally:
                os.close(fd)
            try:
                os.chmod(str(path), 0o600)
            except Exception:
                # If we can't enforce perms, refuse to keep the file —
                # plaintext-equivalent KEK is worse than no KEK at all.
                try: path.unlink()
                except Exception: pass
                return None
        _bridge_fernet = _Fernet(key)
        return _bridge_fernet
    except Exception:
        return None


def _encrypt_bridge_token(plain: Optional[str]) -> Optional[str]:
    """Encrypt a bridge bot token for at-rest storage. If the cryptography
    library is unavailable or the KEK can't be loaded, returns the value
    unchanged so the caller still works (degraded mode)."""
    if not plain:
        return plain
    if isinstance(plain, str) and plain.startswith(_BRIDGE_KEK_PREFIX):
        return plain    # already encrypted
    f = _load_bridge_fernet()
    if f is None:
        return plain
    try:
        ct = f.encrypt(str(plain).encode("utf-8")).decode("ascii")
        return _BRIDGE_KEK_PREFIX + ct
    except Exception:
        return plain


def _decrypt_bridge_token(stored: Optional[str]) -> Optional[str]:
    """Inverse of _encrypt_bridge_token. Plaintext rows from before the
    migration are returned unchanged (detected by missing prefix)."""
    if not stored:
        return stored
    if not isinstance(stored, str) or not stored.startswith(_BRIDGE_KEK_PREFIX):
        return stored
    f = _load_bridge_fernet()
    if f is None:
        # Encrypted-looking row but no KEK to decrypt. Returning the
        # ciphertext to the caller would be worse than failing fast.
        return ""
    try:
        return f.decrypt(stored[len(_BRIDGE_KEK_PREFIX):].encode("ascii")).decode("utf-8")
    except _FInvalid:
        return ""
    except Exception:
        return ""


DB_PATH = Path(os.getenv("DB_PATH", "data/frogtalk.db"))


# ── Session token at-rest hardening ───────────────────────────────────
# Session tokens used to be stored as the raw `secrets.token_urlsafe(32)`
# string that the cookie carries. A DB dump leak therefore handed the
# attacker every live session cookie — instant impersonation of every
# online user, regardless of password strength.
#
# We now store SHA-256(token) instead (constant 64-hex-char column),
# which makes a stolen DB useless for hijacking: the cookie value the
# server compares against is never written to disk in recoverable form.
# Lookups stay O(log n) via the existing UNIQUE idx_sessions_token; we
# transparently fall back to a plaintext lookup so sessions issued
# before this build keep working until they expire / get re-touched.
_LEGACY_PLAINTEXT_SESSION_TOKENS = True   # flip to False after the 30-day cookie horizon

def _hash_session_token(token: str) -> str:
    """Deterministic at-rest representation of a session cookie. Keyless
    SHA-256 is sufficient because the cookie itself is 32 bytes of
    secrets.token_urlsafe entropy (~256 bits) — there's nothing to
    brute-force from the hash. Using a keyed HMAC would buy nothing and
    introduce a key-rotation failure mode."""
    if not token:
        return ""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


CHANNEL_DIRECTORY_ACTIVE_DAYS_KEY = "channels.directory_active_days"
CHANNEL_AUTO_DELETE_DAYS_KEY = "channels.auto_delete_days"
DEFAULT_CHANNEL_DIRECTORY_ACTIVE_DAYS = 30
DEFAULT_CHANNEL_AUTO_DELETE_DAYS = 0


# ── Thread-local connection pool ──────────────────────────────────────
# Previously _conn() opened a fresh sqlite3 connection AND ran 7 PRAGMA
# statements on every call. A typical Frog Social profile load triggers
# ~10 db.* calls, so that's 10 connect()s + 70 PRAGMA round-trips per
# request, all on the asyncio event loop. Under contention from the
# federation outbox writer + WS broadcasts that's enough to push
# /api/ping past 8s.
#
# Each thread (the main event-loop thread plus every worker thread that
# asyncio.to_thread spins up) now owns ONE long-lived connection that
# is reused across requests. PRAGMAs run exactly once per thread.
#
# Drop-in safe: `with _conn() as con:` still works — sqlite3.Connection's
# context-manager __exit__ only commits / rolls back, it never closes the
# connection. So every existing call site keeps the same transactional
# semantics; it just stops paying the connect-+-PRAGMA tax.
_DB_LOCAL = threading.local()


def _conn():
    con = getattr(_DB_LOCAL, "con", None)
    if con is not None:
        return con
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    # 5s busy timeout avoids "database is locked" errors when multiple
    # short writes contend (WS broadcast + DM insert + presence update).
    con = sqlite3.connect(
        DB_PATH,
        detect_types=sqlite3.PARSE_DECLTYPES,
        timeout=5.0,
    )
    con.row_factory = sqlite3.Row
    # WAL + NORMAL sync is the standard "fast and safe under WAL" combo.
    # temp_store=MEMORY keeps sort/temp tables off disk.
    # 64 MiB page cache + 128 MiB mmap dramatically reduces read latency on
    # hot tables (messages, dm_messages, sessions). All of these stay
    # crash-consistent; only OS power-loss can lose a few last writes.
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA temp_store=MEMORY")
    con.execute("PRAGMA cache_size=-65536")
    con.execute("PRAGMA mmap_size=268435456")
    con.execute("PRAGMA foreign_keys=ON")
    # Cap WAL physical size at 64 MiB. Without this the WAL can balloon
    # to hundreds of MB when long-lived reader connections (e.g. async
    # generators, slow http clients) prevent the auto-checkpoint from
    # reclaiming pages — every subsequent transaction then has to walk
    # the entire WAL, making the whole API feel slow. The limit only
    # truncates *after* a successful checkpoint, so it's safe.
    con.execute("PRAGMA journal_size_limit=67108864")
    _DB_LOCAL.con = con
    return con


def init_db():
    with _conn() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            nickname  TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            avatar    TEXT,
            bio       TEXT DEFAULT '',
            is_admin  INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            user_id    INTEGER NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS rooms (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT UNIQUE NOT NULL,
            description TEXT DEFAULT '',
            type        TEXT DEFAULT 'public',
            owner_id    INTEGER,
            room_key_hint TEXT,
            created_at  TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            room_name  TEXT NOT NULL,
            user_id    INTEGER NOT NULL,
            nickname   TEXT NOT NULL,
            content    TEXT NOT NULL,
            media_data TEXT,
            media_type TEXT,
            edited     INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            bridge_source_name TEXT,
            bridge_source_id TEXT,
            bridge_source_parent TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS reactions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            emoji      TEXT NOT NULL,
            UNIQUE(message_id, user_id, emoji),
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_name, created_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

        -- ── Friends & social graph ───────────────────────────────────────
        CREATE TABLE IF NOT EXISTS friends (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            friend_id  INTEGER NOT NULL,
            status     TEXT DEFAULT 'pending',
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(user_id, friend_id),
            FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS friend_sound_assets (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_user_id  INTEGER NOT NULL,
            friend_user_id INTEGER NOT NULL,
            kind           TEXT NOT NULL,
            filename       TEXT NOT NULL,
            content_type   TEXT NOT NULL,
            file_path      TEXT NOT NULL UNIQUE,
            file_size      INTEGER NOT NULL DEFAULT 0,
            is_active      INTEGER NOT NULL DEFAULT 1,
            created_at     TEXT DEFAULT (datetime('now')),
            updated_at     TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (friend_user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_friend_sound_owner_friend_kind
            ON friend_sound_assets(owner_user_id, friend_user_id, kind, is_active, created_at DESC);

        -- ── User tags/interests ─────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS user_tags (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            tag     TEXT    NOT NULL,
            UNIQUE(user_id, tag),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- ── Nickname history for alias tracking ────────────────────────
        CREATE TABLE IF NOT EXISTS nickname_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL,
            old_nickname TEXT NOT NULL,
            changed_at  TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_nickname_history_user ON nickname_history(user_id);

        -- ── User status & extended profile ─────────────────────────────
        -- Add extra columns to users if not exist (ALTER TABLE for migration)

        -- ── DM channels ────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS dm_channels (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_a     INTEGER NOT NULL,
            user_b     INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_a) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (user_b) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_channels_pair
            ON dm_channels(MIN(user_a,user_b), MAX(user_a,user_b));

        -- ── DM messages ────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS dm_messages (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id   INTEGER NOT NULL,
            sender_id    INTEGER NOT NULL,
            content      TEXT    NOT NULL DEFAULT '',
            media_data   TEXT,
            media_type   TEXT,
            media_name   TEXT,
            reply_to     INTEGER,
            edited       INTEGER DEFAULT 0,
            deleted      INTEGER DEFAULT 0,
            created_at   TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (channel_id) REFERENCES dm_channels(id) ON DELETE CASCADE,
            FOREIGN KEY (sender_id)  REFERENCES users(id)       ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_dm_messages_channel ON dm_messages(channel_id, created_at);

        -- ── DM reactions ───────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS dm_reactions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            emoji      TEXT    NOT NULL,
            UNIQUE(message_id, user_id, emoji),
            FOREIGN KEY (message_id) REFERENCES dm_messages(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id)    REFERENCES users(id)       ON DELETE CASCADE
        );

        -- ── Calls history ──────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS calls (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            caller_id  INTEGER NOT NULL,
            callee_id  INTEGER NOT NULL,
            channel_id INTEGER,
            call_type  TEXT NOT NULL DEFAULT 'voice',
            status     TEXT NOT NULL DEFAULT 'ringing',
            started_at TEXT,
            ended_at   TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (caller_id)  REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (callee_id)  REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS pending_call_offers (
            call_id        INTEGER PRIMARY KEY,
            caller_id      INTEGER NOT NULL,
            callee_id      INTEGER NOT NULL,
            from_nickname  TEXT    NOT NULL,
            from_avatar    TEXT,
            call_type      TEXT    NOT NULL DEFAULT 'voice',
            sdp            TEXT    NOT NULL,
            created_at     TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE,
            FOREIGN KEY (caller_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (callee_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- Trickle-ICE candidates buffered for a peer that isn't on a WS yet.
        -- Cold-start callees (push-wake) take 1-3 s to reconnect, during which
        -- the caller has already trickled the first half of its candidates.
        -- Without this buffer those candidates are lost and ICE often can't
        -- complete with only the late ones, producing the "answered but stuck
        -- on Connecting…" symptom. Drained on the target's next WS connect.
        CREATE TABLE IF NOT EXISTS pending_ice_candidates (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            call_id     INTEGER NOT NULL,
            target_id   INTEGER NOT NULL,
            from_id     INTEGER NOT NULL,
            from_nick   TEXT    NOT NULL DEFAULT '',
            candidate   TEXT    NOT NULL,
            created_at  TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_pending_ice_target
            ON pending_ice_candidates(target_id, call_id);

        -- ── Room pins ──────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS pinned_messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            room_name  TEXT    NOT NULL,
            message_id INTEGER NOT NULL,
            pinned_by  INTEGER NOT NULL,
            pinned_at  TEXT DEFAULT (datetime('now')),
            UNIQUE(room_name, message_id)
        );

        CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_name, created_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

        -- ── Directory likes & comments ─────────────────────────────────
        CREATE TABLE IF NOT EXISTS channel_likes (
            room_id    INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (room_id, user_id),
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS channel_comments (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id    INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            content    TEXT    NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_channel_comments_room ON channel_comments(room_id, created_at);
        """)
        # Note: default rooms are no longer auto-seeded. Users create their
        # own channels; new signups see an empty state or accept an invite.
        # Seed admin user. ADMIN_PASSWORD env is preferred. If unset on a
        # fresh install we generate a random password instead of using a
        # well-known default — operator must read it from the bootstrap
        # file and set ADMIN_PASSWORD env afterwards.
        existing = con.execute("SELECT id FROM users WHERE nickname='admin'").fetchone()
        if not existing:
            admin_pw = os.getenv("ADMIN_PASSWORD", "").strip()
            if not admin_pw:
                admin_pw = secrets.token_urlsafe(24)
                # Write 0600 atomically: open with O_CREAT|O_EXCL|O_WRONLY
                # at mode 0600 so the file is *never* world-readable, not
                # even for a microsecond between create() and chmod().
                # If we can't satisfy that — read-only mount, lost-race,
                # FS that ignores chmod — DO NOT silently fall back to a
                # potentially world-readable file with the admin password
                # in it; print to the operator and bail out of the
                # write attempt entirely so they see the password in the
                # journal and can act.
                boot_path = DB_PATH.parent / ".bootstrap_admin_password"
                _wrote = False
                try:
                    fd = os.open(
                        str(boot_path),
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_TRUNC,
                        0o600,
                    )
                    try:
                        with os.fdopen(fd, "w", encoding="utf-8") as fh:
                            fh.write(admin_pw + "\n")
                        # Defence in depth — confirm permissions on disk.
                        st = os.stat(boot_path)
                        if st.st_mode & 0o077:
                            os.chmod(boot_path, 0o600)
                            st = os.stat(boot_path)
                            if st.st_mode & 0o077:
                                raise OSError("could not enforce 0600")
                        _wrote = True
                    except Exception:
                        # Best effort: remove the file rather than leave a
                        # partial / wrong-perms password file behind.
                        try:
                            os.remove(boot_path)
                        except OSError:
                            pass
                        raise
                except (OSError, FileExistsError) as _e:
                    print(
                        f"[DB] Could not write bootstrap admin password file securely "
                        f"({_e}). Generated password (set ADMIN_PASSWORD env immediately): "
                        f"{admin_pw}"
                    )
                if _wrote:
                    print(
                        f"[DB] Seeded admin user with random password; "
                        f"see {boot_path} (mode 0600). Set ADMIN_PASSWORD env and remove the file."
                    )
            con.execute(
                "INSERT INTO users (nickname, password_hash, is_admin) VALUES (?, ?, 1)",
                ("admin", _bcrypt.hashpw(admin_pw.encode(), _bcrypt.gensalt()).decode())
            )
        # Case-insensitive unique index on nickname — blocks "Frog" vs "frog" collisions.
        # (A one-time dedupe pass for legacy case-variant duplicates ran in
        # an earlier release; both production nodes have already converged,
        # so the migration code has been removed.)
        try:
            con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname_nocase ON users(nickname COLLATE NOCASE)")
        except sqlite3.IntegrityError:
            # Existing case-variant duplicates present; skip — admin must resolve manually
            pass
        con.commit()
    _migrate()


# ---------------------------------------------------------------------------
# User helpers
# ---------------------------------------------------------------------------

def create_user(nickname: str, password: str, registration_ip: Optional[str] = None) -> Optional[int]:
    """Return new user id or None if nickname taken.

    `registration_ip` is best-effort \u2014 the column was added in a later
    migration so older installs may not have it. Stored verbatim (no
    geolookup) so admins can spot bot-farm bursts of accounts created from
    the same IP.
    """
    try:
        with _conn() as con:
            try:
                cur = con.execute(
                    "INSERT INTO users (nickname, password_hash, global_user_id, registration_ip) VALUES (?, ?, ?, ?)",
                    (
                        nickname,
                        _bcrypt.hashpw(password.encode(), _bcrypt.gensalt()).decode(),
                        str(uuid.uuid4()),
                        registration_ip,
                    )
                )
            except sqlite3.OperationalError:
                # Column may not exist on pre-migration databases; fall back.
                cur = con.execute(
                    "INSERT INTO users (nickname, password_hash, global_user_id) VALUES (?, ?, ?)",
                    (
                        nickname,
                        _bcrypt.hashpw(password.encode(), _bcrypt.gensalt()).decode(),
                        str(uuid.uuid4()),
                    )
                )
            con.commit()
            return cur.lastrowid
    except sqlite3.IntegrityError:
        return None


def create_user_with_hash(nickname: str, password_hash: str, global_user_id: Optional[str] = None) -> Optional[int]:
    """Insert a user with a pre-computed bcrypt hash (used by federation
    provisioning so plaintext passwords never leave the issuing node)."""
    try:
        with _conn() as con:
            cur = con.execute(
                "INSERT INTO users (nickname, password_hash, global_user_id) VALUES (?, ?, ?)",
                (nickname, password_hash, (global_user_id or str(uuid.uuid4()))),
            )
            con.commit()
            return cur.lastrowid
    except sqlite3.IntegrityError:
        return None


def is_username_available(nickname: str) -> bool:
    """Return True if the username is not yet taken (case-insensitive)."""
    if not nickname:
        return False
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM users WHERE LOWER(nickname) = LOWER(?) LIMIT 1",
            (nickname,),
        ).fetchone()
    return row is None


def suggest_available_usernames(base: str, count: int = 5) -> list[str]:
    """Suggest up to `count` available username variants near `base`.

    Strategy: numeric suffixes (base2, base3 …) plus a few short random
    suffixes. Caller has already validated `base` against NICKNAME_RE so
    we only need length-trimming here. Returns lowercase suggestions
    only — the username column is case-insensitive on the unique check.
    """
    import random as _random
    base = (base or "").strip().lower()
    if not base:
        return []
    # Reserve a few characters for the suffix so we never exceed 32.
    base_trim = base[:28] if len(base) > 28 else base
    out: list[str] = []
    seen: set[str] = set()
    # Numeric suffixes first — most users prefer "name2" over "nameXyz".
    n = 2
    while len(out) < count and n < 9999:
        cand = f"{base_trim}{n}"
        if cand not in seen and is_username_available(cand):
            out.append(cand)
            seen.add(cand)
        n += 1
    # Top up with short random alphanumeric suffixes if needed.
    alphabet = "abcdefghijkmnpqrstuvwxyz23456789"
    safety = 0
    while len(out) < count and safety < 200:
        suffix = "".join(_random.choice(alphabet) for _ in range(3))
        cand = f"{base_trim}_{suffix}"
        if cand not in seen and is_username_available(cand):
            out.append(cand)
            seen.add(cand)
        safety += 1
    return out


def get_user_password_hash(user_id: int) -> Optional[str]:
    with _conn() as con:
        row = con.execute("SELECT password_hash FROM users WHERE id=?", (user_id,)).fetchone()
    return row["password_hash"] if row else None


def verify_user(nickname: str, password: str) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute(
            "SELECT id, nickname, password_hash, avatar, bio, is_admin FROM users WHERE nickname=? COLLATE NOCASE",
            (nickname,)
        ).fetchone()
    if not row:
        return None
    if not _bcrypt.checkpw(password.encode(), row["password_hash"].encode()):
        return None
    return dict(row)


def get_user_by_token(token: str) -> Optional[Dict]:
    if not token:
        return None
    hashed = _hash_session_token(token)
    with _conn() as con:
        row = con.execute("""
            SELECT u.id, u.nickname, u.display_name, u.username_changed_at,
                   u.avatar, u.bio, u.is_admin,
                   u.presence, u.status_msg, u.profile_public,
                   u.allow_friend_requests, u.banner,
                   u.global_user_id, u.identity_pubkey,
                   u.theme, u.notify_sounds, u.notify_desktop,
                   u.notify_dms, u.notify_mentions, u.allow_dms_from,
                   u.show_last_seen, u.show_read_receipts,
                   u.hide_active_channels,
                   -- PIN privacy: surface only the *flags*, never the hash
                   CASE WHEN u.pin_hash IS NULL OR u.pin_hash='' THEN 0 ELSE 1 END AS has_pin,
                   u.pin_require_on_unlock, u.pin_require_for_admin,
                   u.pin_require_after_autologin, u.pin_idle_timeout_sec
            FROM sessions s JOIN users u ON s.user_id = u.id
            WHERE s.token=? AND s.expires_at > datetime('now')
        """, (hashed,)).fetchone()
        if row is None and _LEGACY_PLAINTEXT_SESSION_TOKENS:
            # Cookie issued before the hash-at-rest migration. One last
            # fetch by raw token, then upgrade the row to a hash so the
            # plaintext disappears from disk on the next write.
            row = con.execute("""
                SELECT u.id, u.nickname, u.display_name, u.username_changed_at,
                       u.avatar, u.bio, u.is_admin,
                       u.presence, u.status_msg, u.profile_public,
                       u.allow_friend_requests, u.banner,
                       u.global_user_id, u.identity_pubkey,
                       u.theme, u.notify_sounds, u.notify_desktop,
                       u.notify_dms, u.notify_mentions, u.allow_dms_from,
                       u.show_last_seen, u.show_read_receipts,
                       u.hide_active_channels,
                       CASE WHEN u.pin_hash IS NULL OR u.pin_hash='' THEN 0 ELSE 1 END AS has_pin,
                       u.pin_require_on_unlock, u.pin_require_for_admin,
                       u.pin_require_after_autologin, u.pin_idle_timeout_sec
                FROM sessions s JOIN users u ON s.user_id = u.id
                WHERE s.token=? AND s.expires_at > datetime('now')
            """, (token,)).fetchone()
            if row is not None:
                try:
                    con.execute("UPDATE sessions SET token=? WHERE token=?", (hashed, token))
                    con.commit()
                except Exception:
                    # UNIQUE collision (someone else already migrated
                    # this row) — harmless, fall through.
                    pass
    return dict(row) if row else None


def get_user_by_id(user_id: int) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute(
            "SELECT id, nickname, display_name, avatar, bio, is_admin, global_user_id, identity_pubkey FROM users WHERE id=?",
            (user_id,)
        ).fetchone()
    return dict(row) if row else None


def get_user_identity(user_id: int) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute(
            """
            SELECT id, nickname, display_name, avatar, bio, global_user_id, identity_pubkey
            FROM users WHERE id=?
            """,
            (user_id,),
        ).fetchone()
    return dict(row) if row else None


def create_session(user_id: int, user_agent: str = "", ip_address: str = "") -> str:
    token = secrets.token_urlsafe(32)
    expires = (datetime.utcnow() + timedelta(days=30)).isoformat()
    now = datetime.utcnow().isoformat()
    # Store only the hash; the raw token is returned to the caller (and
    # from there into the client cookie) and is never persisted.
    stored = _hash_session_token(token)
    with _conn() as con:
        con.execute(
            "INSERT INTO sessions (token, user_id, expires_at, user_agent, ip_address, created_at, last_active) "
            "VALUES (?,?,?,?,?,?,?)",
            (stored, user_id, expires, (user_agent or "")[:512], (ip_address or "")[:64], now, now),
        )
        con.commit()
    return token


def touch_session(token: str) -> None:
    if not token:
        return
    hashed = _hash_session_token(token)
    try:
        with _conn() as con:
            cur = con.execute(
                "UPDATE sessions SET last_active=? WHERE token=?",
                (datetime.utcnow().isoformat(), hashed),
            )
            if cur.rowcount == 0 and _LEGACY_PLAINTEXT_SESSION_TOKENS:
                con.execute(
                    "UPDATE sessions SET token=?, last_active=? WHERE token=?",
                    (hashed, datetime.utcnow().isoformat(), token),
                )
            con.commit()
    except Exception:
        pass


def list_user_sessions(user_id: int, current_token: str = "") -> list:
    current_hashed = _hash_session_token(current_token) if current_token else ""
    with _conn() as con:
        rows = con.execute(
            "SELECT token, user_agent, ip_address, created_at, last_active, expires_at, "
            "country_code, country, city "
            "FROM sessions WHERE user_id=? AND expires_at > datetime('now') "
            "ORDER BY COALESCE(last_active, created_at) DESC",
            (user_id,),
        ).fetchall()
    out = []
    legacy_seen = False
    for r in rows:
        d = dict(r)
        token = d.pop("token", "") or ""
        d["id"] = token[:16]
        d["is_current"] = bool(
            current_token and (token == current_hashed or token == current_token)
        )
        # Pre-v300 sessions have no UA/IP. Don't drop them entirely (the user
        # might have signed in on their phone before this build deployed) —
        # but collapse them to a single "older session" row so the dialog
        # doesn't list every stale token from the last few months.
        if not d["is_current"] and not (d.get("user_agent") or d.get("ip_address")):
            if legacy_seen:
                continue
            legacy_seen = True
            d["legacy"] = True
        out.append(d)
    return out


def delete_other_sessions(user_id: int, current_token: str) -> int:
    """Revoke every session for the user except the caller's current one.
    Returns the number of rows removed."""
    if not current_token:
        return 0
    hashed = _hash_session_token(current_token)
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM sessions WHERE user_id=? AND token<>? AND token<>?",
            (user_id, hashed, current_token),
        )
        con.commit()
        return cur.rowcount or 0


def update_session_geo(token: str, country_code: str = "", country: str = "", city: str = "") -> None:
    if not token:
        return
    hashed = _hash_session_token(token)
    try:
        with _conn() as con:
            cur = con.execute(
                "UPDATE sessions SET country_code=?, country=?, city=? WHERE token=?",
                ((country_code or "")[:8], (country or "")[:96], (city or "")[:96], hashed),
            )
            if cur.rowcount == 0 and _LEGACY_PLAINTEXT_SESSION_TOKENS:
                con.execute(
                    "UPDATE sessions SET country_code=?, country=?, city=? WHERE token=?",
                    ((country_code or "")[:8], (country or "")[:96], (city or "")[:96], token),
                )
            con.commit()
    except Exception:
        pass


def delete_session_by_short_id(user_id: int, short_id: str, except_token: str = "") -> bool:
    short_id = (short_id or "").strip()
    if not short_id or len(short_id) < 8:
        return False
    except_hashed = _hash_session_token(except_token) if except_token else ""
    with _conn() as con:
        if except_token:
            cur = con.execute(
                "DELETE FROM sessions WHERE user_id=? AND token LIKE ? AND token<>? AND token<>?",
                (user_id, short_id + "%", except_hashed, except_token),
            )
        else:
            cur = con.execute(
                "DELETE FROM sessions WHERE user_id=? AND token LIKE ?",
                (user_id, short_id + "%"),
            )
        con.commit()
        return cur.rowcount > 0


def delete_session(token: str):
    if not token:
        return
    hashed = _hash_session_token(token)
    with _conn() as con:
        con.execute(
            "DELETE FROM sessions WHERE token IN (?, ?)",
            (hashed, token),
        )
        con.commit()


def delete_user_account(user_id: int) -> bool:
    """Permanently delete a user account and all associated data."""
    with _conn() as con:
        # Check user exists
        row = con.execute("SELECT id FROM users WHERE id=?", (user_id,)).fetchone()
        if not row:
            return False
        # Delete all user data (cascade will handle most via FK)
        con.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        con.execute("DELETE FROM messages WHERE user_id=?", (user_id,))
        con.execute("DELETE FROM dm_messages WHERE sender_id=?", (user_id,))
        con.execute("DELETE FROM push_subscriptions WHERE user_id=?", (user_id,))
        con.execute("DELETE FROM room_moderators WHERE user_id=?", (user_id,))
        con.execute("DELETE FROM room_bans WHERE user_id=?", (user_id,))
        con.execute("DELETE FROM user_blocks WHERE blocker_id=? OR blocked_id=?", (user_id, user_id))
        con.execute("DELETE FROM custom_emojis WHERE uploaded_by=?", (user_id,))
        con.execute("DELETE FROM friendships WHERE user_id=? OR friend_id=?", (user_id, user_id))
        con.execute("DELETE FROM dm_participants WHERE user_id=?", (user_id,))
        # Finally delete user
        con.execute("DELETE FROM users WHERE id=?", (user_id,))
        con.commit()
    return True
def update_profile(user_id: int, avatar: Optional[str] = None, bio: Optional[str] = None,
                   new_password: Optional[str] = None, banner: Optional[str] = None):
    with _conn() as con:
        if avatar is not None:
            con.execute("UPDATE users SET avatar=? WHERE id=?", (avatar, user_id))
        if bio is not None:
            con.execute("UPDATE users SET bio=? WHERE id=?", (bio, user_id))
        if banner is not None:
            con.execute("UPDATE users SET banner=? WHERE id=?", (banner, user_id))
        if new_password is not None:
            con.execute("UPDATE users SET password_hash=? WHERE id=?",
                        (_bcrypt.hashpw(new_password.encode(), _bcrypt.gensalt()).decode(), user_id))
        con.commit()


def get_all_users() -> List[Dict]:
    with _conn() as con:
        rows = con.execute("SELECT id, nickname, display_name, avatar, bio, is_admin FROM users").fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Identity: display_name (free) + username (= unique nickname column)
# ---------------------------------------------------------------------------

USERNAME_CHANGE_COOLDOWN_DAYS = 7


def set_display_name(user_id: int, display_name: Optional[str]) -> None:
    """Set or clear the freeform display name. Pass None / empty to clear
    (UI will fall back to the username)."""
    val = (display_name or "").strip() or None
    with _conn() as con:
        con.execute("UPDATE users SET display_name=? WHERE id=?", (val, user_id))
        con.commit()


def username_change_remaining_seconds(user_id: int) -> int:
    """Returns seconds until the user is allowed to change username again.
    0 means change is allowed right now."""
    with _conn() as con:
        row = con.execute(
            "SELECT username_changed_at FROM users WHERE id=?", (user_id,)
        ).fetchone()
    if not row or not row["username_changed_at"]:
        return 0
    try:
        last = datetime.fromisoformat(row["username_changed_at"])
    except Exception:
        return 0
    elapsed = (datetime.utcnow() - last).total_seconds()
    cooldown = USERNAME_CHANGE_COOLDOWN_DAYS * 86400
    remaining = int(cooldown - elapsed)
    return max(0, remaining)


def set_username(user_id: int, new_username: str, old_username: str) -> None:
    """Rename the unique handle and stamp the cooldown clock. Caller is
    responsible for permission, regex and uniqueness checks."""
    with _conn() as con:
        con.execute(
            "INSERT INTO nickname_history (user_id, old_nickname) VALUES (?, ?)",
            (user_id, old_username),
        )
        con.execute(
            "UPDATE users SET nickname=?, username_changed_at=? WHERE id=?",
            (new_username, datetime.utcnow().isoformat(), user_id),
        )
        con.commit()



# ---------------------------------------------------------------------------
# Room helpers
# ---------------------------------------------------------------------------

def list_rooms() -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT r.id, r.name, r.description, r.type, r.icon, r.slowmode, r.room_key_hint,
                   r.channel_type, r.channel_theme, r.invite_only, r.who_can_invite,
                   r.is_public, r.category, r.tags, r.dj_only_queue,
                   COALESCE(r.forwarding_disabled, 0) AS forwarding_disabled,
                   u.nickname AS owner_nickname
            FROM rooms r LEFT JOIN users u ON r.owner_id = u.id
            ORDER BY r.id
        """).fetchall()
    return [dict(r) for r in rows]


def create_room(name: str, description: str, room_type: str, owner_id: int,
                room_key_hint: Optional[str], icon: Optional[str] = None,
                channel_type: str = "text", about: Optional[str] = None) -> Optional[int]:
    # Seed the long-form "about" with the description on creation so the
    # Settings → About tab shows the same text the creator typed instead of
    # being blank until they re-save.
    about_val = about if (about is not None and about != "") else (description or "")
    try:
        with _conn() as con:
            cur = con.execute(
                "INSERT INTO rooms (name, description, about, type, owner_id, room_key_hint, icon, channel_type) VALUES (?,?,?,?,?,?,?,?)",
                (name, description, about_val, room_type, owner_id, room_key_hint, icon, channel_type)
            )
            con.commit()
            return cur.lastrowid
    except sqlite3.IntegrityError:
        return None


def delete_room(room_name: str, requester_id: int, is_admin: bool) -> bool:
    with _conn() as con:
        row = con.execute("SELECT id, owner_id FROM rooms WHERE name=?", (room_name,)).fetchone()
        if not row:
            return False
        if not is_admin and row["owner_id"] != requester_id:
            return False
        con.execute("DELETE FROM pinned_messages WHERE room_name=?", (room_name,))
        con.execute("DELETE FROM room_djs WHERE room_name=?", (room_name,))
        con.execute("DELETE FROM music_queue WHERE room_name=?", (room_name,))
        con.execute("DELETE FROM telegram_bridges WHERE room_name=?", (room_name,))
        con.execute("DELETE FROM discord_bridges WHERE room_name=?", (room_name,))
        con.execute("DELETE FROM messages WHERE room_name=?", (room_name,))
        con.execute("DELETE FROM rooms WHERE name=?", (room_name,))
        con.commit()
    try:
        set_config(_music_anchor_config_key(room_name), "")
    except Exception:
        pass
    return True


# ---------------------------------------------------------------------------
# Message helpers
# ---------------------------------------------------------------------------

def get_user_last_message_epoch(room_name: str, user_id: int) -> float:
    """Return the unix timestamp of the user's most recent message in
    ``room_name``, or 0.0 if none. Used by slowmode enforcement so that
    a process restart cannot reset a user's slowmode timer (the
    in-memory ``_slowmode_tracker`` would otherwise let them post
    immediately again).
    """
    try:
        with _conn() as con:
            row = con.execute(
                "SELECT strftime('%s', created_at) AS ts FROM messages "
                "WHERE room_name=? AND user_id=? ORDER BY id DESC LIMIT 1",
                (room_name, user_id),
            ).fetchone()
    except Exception:
        return 0.0
    if not row or row["ts"] is None:
        return 0.0
    try:
        return float(row["ts"])
    except (TypeError, ValueError):
        return 0.0


def save_message(room_name: str, user_id: int, nickname: str, content: str,
                 media_data: Optional[str] = None,
                 media_type: Optional[str] = None,
                 media_blur: int = 0,
                 view_once: int = 0,
                 bridge_platform: Optional[str] = None,
                 bridge_avatar: Optional[str] = None,
                                 bridge_source_name: Optional[str] = None,
                                 bridge_source_id: Optional[str] = None,
                                 bridge_source_parent: Optional[str] = None,
                 reply_to: Optional[int] = None,
                 forwarded_from: Optional[str] = None) -> int:
    with _conn() as con:
        cur = con.execute(
            """INSERT INTO messages (room_name, user_id, nickname, content, media_data, media_type,
                                                                         media_blur, view_once, bridge_platform, bridge_avatar,
                                                                         bridge_source_name, bridge_source_id, bridge_source_parent,
                                                                         reply_to, forwarded_from)
                             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (room_name, user_id, nickname, content, media_data, media_type,
                         media_blur, view_once, bridge_platform, bridge_avatar,
                         bridge_source_name, bridge_source_id, bridge_source_parent,
                         reply_to, forwarded_from)
        )
        con.commit()
        return cur.lastrowid


# ─── Bridge message-ID mapping ────────────────────────────────────────────
# Used by the Telegram / Discord bridges to correlate remote message IDs
# with FrogTalk message rows so inbound replies on the remote platform can
# be rendered as native reply-cards in FrogTalk.

def save_bridge_msg_map(platform: str, chat_id, remote_msg_id,
                        ft_msg_id: int) -> None:
    """Record a (platform, chat_id, remote_msg_id) → ft_msg_id mapping.

    chat_id and remote_msg_id are stored as TEXT so Telegram's 64-bit
    chat ids and arbitrary Discord snowflakes both fit without overflow.
    Silently ignored on duplicate — the UNIQUE constraint makes this
    idempotent, which matters because webhooks/pollers can re-deliver.
    """
    if not platform or chat_id is None or remote_msg_id is None or not ft_msg_id:
        return
    try:
        with _conn() as con:
            con.execute(
                "INSERT OR IGNORE INTO bridge_msg_map "
                "(platform, chat_id, remote_msg_id, ft_msg_id) VALUES (?,?,?,?)",
                (platform, str(chat_id), str(remote_msg_id), int(ft_msg_id))
            )
            con.commit()
    except Exception:
        pass


def lookup_bridge_msg_map(platform: str, chat_id, remote_msg_id) -> Optional[int]:
    """Resolve a remote (platform, chat_id, msg_id) back to the FrogTalk
    message id, or None if we don't have a mapping yet."""
    if not platform or chat_id is None or remote_msg_id is None:
        return None
    try:
        with _conn() as con:
            row = con.execute(
                "SELECT ft_msg_id FROM bridge_msg_map "
                "WHERE platform=? AND chat_id=? AND remote_msg_id=? LIMIT 1",
                (platform, str(chat_id), str(remote_msg_id))
            ).fetchone()
        return int(row["ft_msg_id"]) if row else None
    except Exception:
        return None


def lookup_bridge_remote_id(platform: str, chat_id, ft_msg_id: int) -> Optional[str]:
    """Reverse of `lookup_bridge_msg_map`: given a FrogTalk message id,
    return the matching remote-platform message id in the given chat
    (or None if we haven't forwarded that message to this chat yet)."""
    if not platform or chat_id is None or not ft_msg_id:
        return None
    try:
        with _conn() as con:
            row = con.execute(
                "SELECT remote_msg_id FROM bridge_msg_map "
                "WHERE platform=? AND chat_id=? AND ft_msg_id=? LIMIT 1",
                (platform, str(chat_id), int(ft_msg_id))
            ).fetchone()
        return row["remote_msg_id"] if row else None
    except Exception:
        return None


def get_messages(room_name: str, limit: int = 100, before_id: Optional[int] = None) -> List[Dict]:
    # PERF: select reactions in a separate aggregate query rather than via a
    # per-message correlated subquery joined into a GROUP BY. Also avoid
    # SELECT-ing m.media_data (potentially MB of base64 per row); the API
    # surfaces a has_media flag and clients lazy-load via /messages/<id>/media.
    with _conn() as con:
        if before_id:
            rows = con.execute(
                """SELECT m.id, m.room_name, m.user_id, m.nickname, m.content,
                          (m.media_type IS NOT NULL AND m.media_type != '') AS has_media,
                          m.media_type, m.edited, m.created_at, m.media_blur, m.view_once,
                          m.reply_to, m.bridge_platform, m.bridge_source_name,
                          m.bridge_source_id, m.bridge_source_parent, m.forwarded_from,
                          COALESCE(m.preview_suppressed, 0) AS preview_suppressed,
                         COALESCE(m.bridge_avatar, b.avatar, u.avatar) AS avatar,
                         CASE WHEN m.bridge_platform IS NOT NULL AND m.bridge_platform != ''
                             THEN NULL
                             WHEN b.id IS NOT NULL THEN b.name
                             ELSE u.display_name END AS display_name,
                          CASE WHEN b.id IS NOT NULL THEN 0 ELSE u.is_admin END AS is_admin,
                          (b.id IS NOT NULL) AS is_bot,
                          b.id AS bot_id,
                          r.nickname AS reply_nickname,
                          substr(r.content,1,120) AS reply_content
                   FROM messages m
                   LEFT JOIN users u ON m.user_id=u.id
                   LEFT JOIN bots  b ON b.owner_id = m.user_id AND b.name = m.nickname
                   LEFT JOIN messages r ON r.id = m.reply_to
                   WHERE m.room_name=? AND m.id < ?
                   ORDER BY m.id DESC LIMIT ?""",
                (room_name, before_id, limit)
            ).fetchall()
        else:
            rows = con.execute(
                """SELECT m.id, m.room_name, m.user_id, m.nickname, m.content,
                          (m.media_type IS NOT NULL AND m.media_type != '') AS has_media,
                          m.media_type, m.edited, m.created_at, m.media_blur, m.view_once,
                          m.reply_to, m.bridge_platform, m.bridge_source_name,
                          m.bridge_source_id, m.bridge_source_parent, m.forwarded_from,
                          COALESCE(m.preview_suppressed, 0) AS preview_suppressed,
                         COALESCE(m.bridge_avatar, b.avatar, u.avatar) AS avatar,
                         CASE WHEN m.bridge_platform IS NOT NULL AND m.bridge_platform != ''
                             THEN NULL
                             WHEN b.id IS NOT NULL THEN b.name
                             ELSE u.display_name END AS display_name,
                          CASE WHEN b.id IS NOT NULL THEN 0 ELSE u.is_admin END AS is_admin,
                          (b.id IS NOT NULL) AS is_bot,
                          b.id AS bot_id,
                          r.nickname AS reply_nickname,
                          substr(r.content,1,120) AS reply_content
                   FROM messages m
                   LEFT JOIN users u ON m.user_id=u.id
                   LEFT JOIN bots  b ON b.owner_id = m.user_id AND b.name = m.nickname
                   LEFT JOIN messages r ON r.id = m.reply_to
                   WHERE m.room_name=?
                   ORDER BY m.id DESC LIMIT ?""",
                (room_name, limit)
            ).fetchall()
        msgs = [dict(r) for r in rows]
        if msgs:
            ids = [m["id"] for m in msgs]
            placeholders = ",".join(["?"] * len(ids))
            rx = con.execute(
                f"SELECT message_id, emoji, COUNT(*) AS c FROM reactions "
                f"WHERE message_id IN ({placeholders}) GROUP BY message_id, emoji",
                ids,
            ).fetchall()
            grouped: Dict[int, list] = {}
            for r in rx:
                grouped.setdefault(int(r["message_id"]), []).append(
                    {"emoji": r["emoji"], "count": int(r["c"])}
                )
            import json as _json
            for m in msgs:
                lst = grouped.get(int(m["id"]))
                m["reactions"] = _json.dumps(lst) if lst else None
    return list(reversed(msgs))


def get_message(msg_id: int) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute(
            "SELECT id, room_name, user_id, nickname, content, media_data, media_type, "
            "forwarded_from, created_at FROM messages WHERE id=?",
            (msg_id,)
        ).fetchone()
    return dict(row) if row else None


def edit_message(msg_id: int, user_id: int, new_content: str, is_admin: bool, is_room_owner: bool = False) -> bool:
    # NOTE: room owners and moderators CANNOT edit other users' messages
    # (only the author or a global admin may). They can still delete via
    # delete_message(). `is_room_owner` is accepted for API stability but
    # intentionally ignored here.
    with _conn() as con:
        row = con.execute("SELECT user_id FROM messages WHERE id=?", (msg_id,)).fetchone()
        if not row:
            return False
        if not is_admin and row["user_id"] != user_id:
            return False
        con.execute("UPDATE messages SET content=?, edited=1 WHERE id=?", (new_content, msg_id))
        con.commit()
    return True


def delete_message(msg_id: int, user_id: int, is_admin: bool, is_room_owner: bool = False) -> bool:
    with _conn() as con:
        row = con.execute("SELECT user_id FROM messages WHERE id=?", (msg_id,)).fetchone()
        if not row:
            return False
        if not is_admin and not is_room_owner and row["user_id"] != user_id:
            return False
        con.execute("DELETE FROM messages WHERE id=?", (msg_id,))
        con.commit()
    return True


def set_message_preview_suppressed(msg_id: int, user_id: int, is_admin: bool = False) -> bool:
    """Mark a room message's link preview as suppressed (Discord-style X).

    Only the message author may suppress their own preview. Global admins are
    also allowed for moderation. Returns True on success, False if the caller
    is not authorised or the message no longer exists.
    """
    with _conn() as con:
        row = con.execute("SELECT user_id FROM messages WHERE id=?", (msg_id,)).fetchone()
        if not row:
            return False
        if not is_admin and row["user_id"] != user_id:
            return False
        con.execute("UPDATE messages SET preview_suppressed=1 WHERE id=?", (msg_id,))
        con.commit()
    return True


def consume_view_once_media(msg_id: int) -> bool:
    """Null out media_data for a view-once message after it has been viewed."""
    with _conn() as con:
        row = con.execute(
            "SELECT view_once FROM messages WHERE id=?", (msg_id,)
        ).fetchone()
        if not row or not row["view_once"]:
            return False
        con.execute(
            "UPDATE messages SET media_data=NULL WHERE id=?", (msg_id,)
        )
        con.commit()
    return True


def consume_view_once_dm_media(msg_id: int) -> bool:
    """Legacy helper: null out DM media globally (kept for backward compatibility)."""
    with _conn() as con:
        row = con.execute(
            "SELECT view_once FROM dm_messages WHERE id=?", (msg_id,)
        ).fetchone()
        if not row or not row["view_once"]:
            return False
        con.execute(
            "UPDATE dm_messages SET media_data=NULL WHERE id=?", (msg_id,)
        )
        con.commit()
    return True


def has_dm_view_once_been_viewed(msg_id: int, user_id: int) -> bool:
    """Return True if this user has already consumed a DM view-once message."""
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM dm_view_once_views WHERE msg_id=? AND user_id=?",
            (msg_id, user_id)
        ).fetchone()
    return bool(row)


def mark_dm_view_once_viewed(msg_id: int, user_id: int) -> bool:
    """Mark DM view-once message consumed for this user only."""
    with _conn() as con:
        row = con.execute(
            "SELECT view_once FROM dm_messages WHERE id=?",
            (msg_id,)
        ).fetchone()
        if not row or not row["view_once"]:
            return False
        con.execute(
            "INSERT OR IGNORE INTO dm_view_once_views (msg_id, user_id) VALUES (?, ?)",
            (msg_id, user_id)
        )
        con.commit()
    return True


def get_dm_view_once_viewed_map(msg_ids: List[int], user_id: int) -> Dict[int, int]:
    """Return mapping of msg_id -> 1 for messages already consumed by this user."""
    if not msg_ids:
        return {}
    placeholders = ",".join(["?"] * len(msg_ids))
    with _conn() as con:
        rows = con.execute(
            f"SELECT msg_id FROM dm_view_once_views WHERE user_id=? AND msg_id IN ({placeholders})",
            (user_id, *msg_ids)
        ).fetchall()
    return {int(r["msg_id"]): 1 for r in rows}


def is_dm_member(channel_id: int, user_id: int) -> bool:
    """Cheap membership check for a DM channel (single PK lookup)."""
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM dm_channels WHERE id=? AND (user_a=? OR user_b=?)",
            (channel_id, user_id, user_id)
        ).fetchone()
    return bool(row)


def toggle_reaction(msg_id: int, user_id: int, emoji: str) -> Dict:
    """Add or remove reaction. Returns updated reaction counts for the message."""
    with _conn() as con:
        existing = con.execute(
            "SELECT id FROM reactions WHERE message_id=? AND user_id=? AND emoji=?",
            (msg_id, user_id, emoji)
        ).fetchone()
        if existing:
            con.execute("DELETE FROM reactions WHERE id=?", (existing["id"],))
        else:
            con.execute("INSERT INTO reactions (message_id, user_id, emoji) VALUES (?,?,?)",
                        (msg_id, user_id, emoji))
        con.commit()
        rows = con.execute(
            "SELECT emoji, COUNT(*) as count FROM reactions WHERE message_id=? GROUP BY emoji",
            (msg_id,)
        ).fetchall()
    return {r["emoji"]: r["count"] for r in rows}


# ---------------------------------------------------------------------------
# Migration helper – safely add columns to existing DBs
# ---------------------------------------------------------------------------

def _migrate():
    """Idempotent column migrations for existing deployments."""
    with _conn() as con:
        cols = {r["name"] for r in con.execute("PRAGMA table_info(users)").fetchall()}
        if "status_msg" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN status_msg TEXT DEFAULT ''")
        if "presence" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN presence TEXT DEFAULT 'online'")
        # Track H cleanup: the legacy `ecdh_pub_key` column (static-ECDH DM
        # crypto) was retired with v1 DM crypto. The column may still
        # exist on older databases but we no longer reference it; SQLite
        # has no portable DROP COLUMN so we leave it as a tombstone.
        if "banner" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN banner TEXT")
        if "last_seen" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN last_seen TEXT")
        if "profile_public" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN profile_public INTEGER DEFAULT 1")
        if "allow_friend_requests" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN allow_friend_requests INTEGER DEFAULT 1")
        if "registration_ip" not in cols:
            # Captured at /register-secure to make bot-farm bursts (one IP
            # creating dozens of randomly-named accounts) visible to admins.
            # NULL for older accounts that pre-date this migration.
            con.execute("ALTER TABLE users ADD COLUMN registration_ip TEXT")
        # User settings columns
        if "theme" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'frog'")
        # One-time migration: 'dark' was the old default palette name; it is
        # identical to 'frog'.  Normalise all legacy rows so the theme system
        # only needs to reason about a single canonical name.
        con.execute("UPDATE users SET theme='frog' WHERE theme='dark' OR theme IS NULL OR theme=''")
        if "notify_sounds" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN notify_sounds INTEGER DEFAULT 1")
        if "notify_desktop" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN notify_desktop INTEGER DEFAULT 1")
        if "notify_dms" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN notify_dms INTEGER DEFAULT 1")
        if "notify_mentions" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN notify_mentions INTEGER DEFAULT 1")
        if "allow_dms_from" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN allow_dms_from TEXT DEFAULT 'everyone'")
        # Privacy: last-seen + read-receipts (everyone|friends|nobody)
        if "show_last_seen" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN show_last_seen TEXT DEFAULT 'everyone'")
        if "show_read_receipts" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN show_read_receipts INTEGER DEFAULT 1")
        # Privacy: hide which channels the user is active in from profile viewers.
        if "hide_active_channels" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN hide_active_channels INTEGER DEFAULT 0")
        # ── PIN-lock (privacy) ─────────────────────────────────────────────
        # Local app-lock: a numeric PIN gates app re-entry after idle /
        # auto-login / opening the admin panel. The hash is bcrypt of the
        # PIN string — *never* stored or transmitted in plaintext, never
        # included in /api/auth/me, and only writable after the user
        # re-enters their account password. `pin_failed_attempts` and
        # `pin_locked_until` implement a sliding lockout against
        # online brute force: 5 wrong PINs in a row → 15 min lock.
        if "pin_hash" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN pin_hash TEXT")
        if "pin_failed_attempts" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN pin_failed_attempts INTEGER DEFAULT 0")
        if "pin_locked_until" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN pin_locked_until TEXT")
        if "pin_require_on_unlock" not in cols:
            # Lock the app when window blurs / tab hides past the idle
            # timeout, requiring PIN to come back in.
            con.execute("ALTER TABLE users ADD COLUMN pin_require_on_unlock INTEGER DEFAULT 1")
        if "pin_require_for_admin" not in cols:
            # Re-prompt for PIN before opening the Server Admin panel.
            con.execute("ALTER TABLE users ADD COLUMN pin_require_for_admin INTEGER DEFAULT 1")
        if "pin_require_after_autologin" not in cols:
            # When the client auto-logs-in via stored token, still demand
            # PIN before showing any chat content.
            con.execute("ALTER TABLE users ADD COLUMN pin_require_after_autologin INTEGER DEFAULT 1")
        if "pin_idle_timeout_sec" not in cols:
            # Idle window before auto-lock kicks in (seconds). 0 = lock
            # immediately on blur. Default 5 minutes balances usability
            # with shoulder-surf protection.
            con.execute("ALTER TABLE users ADD COLUMN pin_idle_timeout_sec INTEGER DEFAULT 300")
        if "pin_keypad_privacy" not in cols:
            # 10.5: when 1, the on-screen lock keypad shows only shape
            # glyphs (●▲■◆…) and hides the digit labels entirely. The
            # underlying digit-to-position mapping still reshuffles every
            # render so muscle-memory and screen-record attacks fail; the
            # privacy mode just adds a second layer for shoulder-surf.
            con.execute("ALTER TABLE users ADD COLUMN pin_keypad_privacy INTEGER DEFAULT 0")
        # Per-user channel ordering (Discord-style drag-to-reorder). Stored as
        # a JSON array of room names; rooms not in the list fall back to the
        # default server order at the end.
        if "room_order" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN room_order TEXT")
        if "global_user_id" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN global_user_id TEXT")
        if "identity_pubkey" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN identity_pubkey TEXT")
        # Identity split: `nickname` is the unique handle (UI label
        # "Username"), `display_name` is the freeform display label
        # (UI label "Nickname") that defaults to nickname when NULL.
        # `username_changed_at` anchors the once-per-week rate limit.
        if "display_name" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN display_name TEXT")
        if "username_changed_at" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN username_changed_at TEXT")
        # Sessions: per-device metadata so users can see/revoke other logins.
        sess_cols = {r["name"] for r in con.execute("PRAGMA table_info(sessions)").fetchall()}
        if "user_agent" not in sess_cols:
            con.execute("ALTER TABLE sessions ADD COLUMN user_agent TEXT")
        if "ip_address" not in sess_cols:
            con.execute("ALTER TABLE sessions ADD COLUMN ip_address TEXT")
        if "created_at" not in sess_cols:
            con.execute("ALTER TABLE sessions ADD COLUMN created_at TEXT")
        if "last_active" not in sess_cols:
            con.execute("ALTER TABLE sessions ADD COLUMN last_active TEXT")
        if "country_code" not in sess_cols:
            con.execute("ALTER TABLE sessions ADD COLUMN country_code TEXT")
        if "country" not in sess_cols:
            con.execute("ALTER TABLE sessions ADD COLUMN country TEXT")
        if "city" not in sess_cols:
            con.execute("ALTER TABLE sessions ADD COLUMN city TEXT")
        msg_cols = {r["name"] for r in con.execute("PRAGMA table_info(messages)").fetchall()}
        if "reply_to" not in msg_cols:
            con.execute("ALTER TABLE messages ADD COLUMN reply_to INTEGER")
        if "pinned" not in msg_cols:
            con.execute("ALTER TABLE messages ADD COLUMN pinned INTEGER DEFAULT 0")

        # Bot federation: cache origin server + foreign bot id so peer
        # nodes can list and add federated bots to local channels. Also
        # cache the owner_nickname so we don't need a local users row for
        # display (federated bots use owner_id=-1 sentinel).
        try:
            bot_cols = {r["name"] for r in con.execute("PRAGMA table_info(bots)").fetchall()}
            if bot_cols:
                if "origin_server_id" not in bot_cols:
                    con.execute("ALTER TABLE bots ADD COLUMN origin_server_id TEXT DEFAULT NULL")
                if "foreign_bot_id" not in bot_cols:
                    con.execute("ALTER TABLE bots ADD COLUMN foreign_bot_id INTEGER DEFAULT NULL")
                if "owner_nickname" not in bot_cols:
                    con.execute("ALTER TABLE bots ADD COLUMN owner_nickname TEXT DEFAULT NULL")
                # api_key_id must be nullable for federated rows (they have
                # no local key). Old schema declared it NOT NULL; sqlite
                # can't relax a column, so we side-step with a sentinel 0.
        except Exception:
            pass

        # Bot ban list (catalog moderation, see init_db comment).
        try:
            con.execute("""CREATE TABLE IF NOT EXISTS banned_bots (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                bot_id            INTEGER,
                origin_server_id  TEXT,
                foreign_bot_id    INTEGER,
                name              TEXT,
                reason            TEXT DEFAULT '',
                banned_by         INTEGER,
                created_at        TEXT DEFAULT (datetime('now')),
                UNIQUE(bot_id),
                UNIQUE(origin_server_id, foreign_bot_id)
            )""")
        except Exception:
            pass
        if "media_blur" not in msg_cols:
            con.execute("ALTER TABLE messages ADD COLUMN media_blur INTEGER DEFAULT 0")
        if "view_once" not in msg_cols:
            con.execute("ALTER TABLE messages ADD COLUMN view_once INTEGER DEFAULT 0")
        # Bridge metadata — which platform a bridged message came from plus a
        # cached sender avatar URL (typically a data: URL fetched by the bot).
        if "bridge_platform" not in msg_cols:
            con.execute("ALTER TABLE messages ADD COLUMN bridge_platform TEXT")
        if "bridge_avatar" not in msg_cols:
            con.execute("ALTER TABLE messages ADD COLUMN bridge_avatar TEXT")
        if "bridge_source_name" not in msg_cols:
            con.execute("ALTER TABLE messages ADD COLUMN bridge_source_name TEXT")
        if "bridge_source_id" not in msg_cols:
            con.execute("ALTER TABLE messages ADD COLUMN bridge_source_id TEXT")
        if "bridge_source_parent" not in msg_cols:
            con.execute("ALTER TABLE messages ADD COLUMN bridge_source_parent TEXT")
        # Track which channel-media messages have already been promoted to the
        # user's public wall via "Make Public". Filtering on this lets the
        # Private Media tab truly move items out instead of copying them, so
        # the tab empties as the user promotes tracks/photos.
        if "posted_to_wall" not in msg_cols:
            con.execute("ALTER TABLE messages ADD COLUMN posted_to_wall INTEGER DEFAULT 0")
        # Author-suppressed link preview (Discord-style "X" on own embed).
        # When set, clients skip rendering the rich link unfurl card for this
        # message for everyone in the room. The original URL stays visible as
        # a plain hyperlink — only the embed is hidden.
        if "preview_suppressed" not in msg_cols:
            con.execute("ALTER TABLE messages ADD COLUMN preview_suppressed INTEGER DEFAULT 0")
        # Per-bridge direction: 'both' (default), 'in' (only remote→FrogTalk),
        # or 'out' (only FrogTalk→remote). Lets an owner use a channel as a
        # one-way announcement feed in either direction.
        try:
            tg_cols = {r["name"] for r in con.execute("PRAGMA table_info(telegram_bridges)").fetchall()}
            if tg_cols and "direction" not in tg_cols:
                con.execute("ALTER TABLE telegram_bridges ADD COLUMN direction TEXT DEFAULT 'both'")
            if tg_cols and "telegram_chat_title" not in tg_cols:
                con.execute("ALTER TABLE telegram_bridges ADD COLUMN telegram_chat_title TEXT DEFAULT ''")
        except Exception:
            pass
        try:
            dc_cols = {r["name"] for r in con.execute("PRAGMA table_info(discord_bridges)").fetchall()}
            if dc_cols and "direction" not in dc_cols:
                con.execute("ALTER TABLE discord_bridges ADD COLUMN direction TEXT DEFAULT 'both'")
            if dc_cols and "discord_channel_name" not in dc_cols:
                con.execute("ALTER TABLE discord_bridges ADD COLUMN discord_channel_name TEXT DEFAULT ''")
            if dc_cols and "discord_guild_name" not in dc_cols:
                con.execute("ALTER TABLE discord_bridges ADD COLUMN discord_guild_name TEXT DEFAULT ''")
        except Exception:
            pass
        # Room columns for settings
        room_cols = {r["name"] for r in con.execute("PRAGMA table_info(rooms)").fetchall()}
        if "icon" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN icon TEXT DEFAULT '💬'")
        if "slowmode" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN slowmode INTEGER DEFAULT 0")
        if "channel_type" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN channel_type TEXT DEFAULT 'text'")
        # Wall-post columns for shared-track metadata (title + source room).
        # Keeps media_data as the raw URL so existing share/play paths keep
        # working; the title is surfaced on cards instead of the old
        # "YouTube track" fallback.
        wp_cols = {r["name"] for r in con.execute("PRAGMA table_info(wall_posts)").fetchall()}
        if wp_cols and "track_title" not in wp_cols:
            con.execute("ALTER TABLE wall_posts ADD COLUMN track_title TEXT")
        if wp_cols and "track_room" not in wp_cols:
            con.execute("ALTER TABLE wall_posts ADD COLUMN track_room TEXT")
        if wp_cols and "share_enabled" not in wp_cols:
            con.execute("ALTER TABLE wall_posts ADD COLUMN share_enabled INTEGER DEFAULT 1")
        # Mood label on shared tracks ("chill", "hype", "focus", …). Powers
        # the mood chips on the Music tab and the mood filter pills above
        # the feed so people can browse by vibe.
        if wp_cols and "track_mood" not in wp_cols:
            con.execute("ALTER TABLE wall_posts ADD COLUMN track_mood TEXT")
        # Bridge message-ID mapping: remote platform msg_id ↔ FrogTalk msg_id.
        # Lets us surface Telegram/Discord replies as native FrogTalk replies
        # (when someone replies on Telegram, the remote msg_id of the parent
        # is looked up here and resolved to the original FrogTalk msg id).
        con.execute("""
            CREATE TABLE IF NOT EXISTS bridge_msg_map (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                platform     TEXT NOT NULL,
                chat_id      TEXT NOT NULL,
                remote_msg_id TEXT NOT NULL,
                ft_msg_id    INTEGER NOT NULL,
                created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(platform, chat_id, remote_msg_id)
            )
        """)
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_bmm_ft ON bridge_msg_map(ft_msg_id)"
        )
        # DM channel columns for disappearing messages
        dm_cols = {r["name"] for r in con.execute("PRAGMA table_info(dm_channels)").fetchall()}
        if "disappear_after" not in dm_cols:
            con.execute("ALTER TABLE dm_channels ADD COLUMN disappear_after INTEGER DEFAULT 0")
        if "hidden_by_a" not in dm_cols:
            con.execute("ALTER TABLE dm_channels ADD COLUMN hidden_by_a INTEGER DEFAULT 0")
        if "hidden_by_b" not in dm_cols:
            con.execute("ALTER TABLE dm_channels ADD COLUMN hidden_by_b INTEGER DEFAULT 0")
        # Read receipts: last read message id per participant
        if "last_read_a" not in dm_cols:
            con.execute("ALTER TABLE dm_channels ADD COLUMN last_read_a INTEGER DEFAULT 0")
        if "last_read_b" not in dm_cols:
            con.execute("ALTER TABLE dm_channels ADD COLUMN last_read_b INTEGER DEFAULT 0")
        dm_msg_cols = {r["name"] for r in con.execute("PRAGMA table_info(dm_messages)").fetchall()}
        if "media_blur" not in dm_msg_cols:
            con.execute("ALTER TABLE dm_messages ADD COLUMN media_blur INTEGER DEFAULT 0")
        if "view_once" not in dm_msg_cols:
            con.execute("ALTER TABLE dm_messages ADD COLUMN view_once INTEGER DEFAULT 0")
        if "preview_suppressed" not in dm_msg_cols:
            con.execute("ALTER TABLE dm_messages ADD COLUMN preview_suppressed INTEGER DEFAULT 0")
        con.execute("""
            CREATE TABLE IF NOT EXISTS dm_view_once_views (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                msg_id     INTEGER NOT NULL,
                user_id    INTEGER NOT NULL,
                viewed_at  TEXT DEFAULT (datetime('now')),
                UNIQUE(msg_id, user_id),
                FOREIGN KEY (msg_id) REFERENCES dm_messages(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_dm_vo_user ON dm_view_once_views(user_id, msg_id)")

        # ── Bug / security report queue ────────────────────────────────
        # User-submitted bug & security vulnerability reports. Reporter_id
        # may be NULL for anonymous submissions (still rate-limited by IP
        # in the route). Severity is one of: low / medium / high / critical.
        # Status: open / triage / in_progress / fixed / wontfix / duplicate.
        con.execute("""
            CREATE TABLE IF NOT EXISTS bug_reports (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                reporter_id  INTEGER,
                reporter_ip  TEXT,
                title        TEXT    NOT NULL,
                body         TEXT    NOT NULL,
                severity     TEXT    NOT NULL DEFAULT 'medium',
                category     TEXT    NOT NULL DEFAULT 'bug',
                contact      TEXT,
                status       TEXT    NOT NULL DEFAULT 'open',
                admin_notes  TEXT,
                created_at   TEXT    DEFAULT (datetime('now')),
                updated_at   TEXT    DEFAULT (datetime('now')),
                FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL
            )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status, created_at DESC)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_bug_reports_severity ON bug_reports(severity, created_at DESC)")

        # Hot paths: latest-N by id within a channel/room and reaction lookup.
        con.execute("CREATE INDEX IF NOT EXISTS idx_dm_messages_channel_id ON dm_messages(channel_id, id DESC)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_name, id DESC)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_dm_messages_sender ON dm_messages(channel_id, sender_id, id)")

        con.execute("""
            CREATE TABLE IF NOT EXISTS friend_sound_assets (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_user_id  INTEGER NOT NULL,
                friend_user_id INTEGER NOT NULL,
                kind           TEXT NOT NULL,
                filename       TEXT NOT NULL,
                content_type   TEXT NOT NULL,
                file_path      TEXT NOT NULL UNIQUE,
                file_size      INTEGER NOT NULL DEFAULT 0,
                is_active      INTEGER NOT NULL DEFAULT 1,
                created_at     TEXT DEFAULT (datetime('now')),
                updated_at     TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (friend_user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        con.execute("""
            CREATE INDEX IF NOT EXISTS idx_friend_sound_owner_friend_kind
            ON friend_sound_assets(owner_user_id, friend_user_id, kind, is_active, created_at DESC)
        """)

        # Federation metadata and replication queues (additive/non-breaking).
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS federation_servers (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id         TEXT NOT NULL UNIQUE,
                display_name      TEXT NOT NULL,
                base_url          TEXT NOT NULL,
                onion_url         TEXT,
                region            TEXT DEFAULT '',
                official          INTEGER DEFAULT 0,
                trust_tier        TEXT DEFAULT 'community',
                server_pubkey     TEXT,
                capabilities_json TEXT DEFAULT '[]',
                enabled           INTEGER DEFAULT 1,
                last_seen         TEXT,
                transport_preference TEXT DEFAULT 'auto',
                created_at        TEXT DEFAULT (datetime('now'))
            )
            """
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS federation_links (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                remote_server_id TEXT NOT NULL UNIQUE,
                sync_mode        TEXT DEFAULT 'both',
                enabled          INTEGER DEFAULT 1,
                created_at       TEXT DEFAULT (datetime('now'))
            )
            """
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS federation_inbox_events (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id         TEXT NOT NULL UNIQUE,
                origin_server_id TEXT NOT NULL,
                event_type       TEXT NOT NULL,
                payload_json     TEXT NOT NULL,
                received_at      TEXT DEFAULT (datetime('now')),
                status           TEXT DEFAULT 'pending'
            )
            """
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS federation_outbox_events (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id         TEXT NOT NULL UNIQUE,
                target_server_id TEXT NOT NULL,
                event_type       TEXT NOT NULL,
                payload_json     TEXT NOT NULL,
                created_at       TEXT DEFAULT (datetime('now')),
                status           TEXT DEFAULT 'pending',
                origin_time      TEXT DEFAULT '',
                signature        TEXT DEFAULT ''
            )
            """
        )
        # Migrate older deployments that pre-date origin_time/signature columns.
        # Without origin_time the receiving peer's skew/monotonic checks reject
        # every event (silent rejected += 1), which is exactly the regression
        # that froze bot.upsert and other replication after May 2026.
        for _ddl in (
            "ALTER TABLE federation_outbox_events ADD COLUMN origin_time TEXT DEFAULT ''",
            "ALTER TABLE federation_outbox_events ADD COLUMN signature  TEXT DEFAULT ''",
        ):
            try: con.execute(_ddl)
            except Exception: pass
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS federation_user_profiles (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                global_user_id   TEXT NOT NULL UNIQUE,
                nickname         TEXT NOT NULL,
                display_name     TEXT DEFAULT '',
                avatar           TEXT DEFAULT '',
                bio              TEXT DEFAULT '',
                identity_pubkey  TEXT DEFAULT '',
                origin_server_id TEXT DEFAULT '',
                updated_at       TEXT DEFAULT (datetime('now'))
            )
            """
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS federation_message_events (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id         TEXT NOT NULL UNIQUE,
                message_id       INTEGER,
                applied_at       TEXT DEFAULT (datetime('now'))
            )
            """
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS official_build_manifests (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                platform   TEXT NOT NULL,
                version    TEXT NOT NULL,
                build_hash TEXT NOT NULL,
                signer     TEXT NOT NULL,
                signature  TEXT NOT NULL,
                official   INTEGER DEFAULT 1,
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(platform, version, build_hash)
            )
            """
        )
        # Config table for VAPID keys and other settings
        con.execute("""CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )""")

        # Backfill global IDs for existing users after adding the new column.
        missing_gid_rows = con.execute(
            "SELECT id FROM users WHERE global_user_id IS NULL OR global_user_id=''"
        ).fetchall()
        for row in missing_gid_rows:
            con.execute(
                "UPDATE users SET global_user_id=? WHERE id=?",
                (str(uuid.uuid4()), row["id"]),
            )
        # Push subscriptions
        con.execute("""CREATE TABLE IF NOT EXISTS push_subscriptions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            endpoint   TEXT NOT NULL UNIQUE,
            p256dh     TEXT NOT NULL,
            auth_key   TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        con.execute("""CREATE TABLE IF NOT EXISTS fcm_tokens (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            token      TEXT NOT NULL UNIQUE,
            platform   TEXT NOT NULL DEFAULT 'android',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        # Room moderators table
        con.execute("""CREATE TABLE IF NOT EXISTS room_moderators (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id    INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            added_by   INTEGER NOT NULL,
            added_at   TEXT DEFAULT (datetime('now')),
            UNIQUE(room_id, user_id),
            FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(added_by) REFERENCES users(id) ON DELETE CASCADE
        )""")
        # Room bans table
        con.execute("""CREATE TABLE IF NOT EXISTS room_bans (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id    INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            banned_by  INTEGER NOT NULL,
            reason     TEXT DEFAULT '',
            expires_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(room_id, user_id),
            FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(banned_by) REFERENCES users(id) ON DELETE CASCADE
        )""")
        # Global admin bans table
        con.execute("""CREATE TABLE IF NOT EXISTS global_bans (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL UNIQUE,
            banned_by  INTEGER NOT NULL,
            reason     TEXT,
            expires_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(banned_by) REFERENCES users(id) ON DELETE CASCADE
        )""")
        # Global mutes table
        con.execute("""CREATE TABLE IF NOT EXISTS global_mutes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL UNIQUE,
            muted_by   INTEGER NOT NULL,
            reason     TEXT,
            expires_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(muted_by) REFERENCES users(id) ON DELETE CASCADE
        )""")
        # User blocks table
        con.execute("""CREATE TABLE IF NOT EXISTS user_blocks (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            blocker_id INTEGER NOT NULL,
            blocked_id INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(blocker_id, blocked_id),
            FOREIGN KEY(blocker_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(blocked_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        # Custom emojis table
        con.execute("""CREATE TABLE IF NOT EXISTS custom_emojis (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            image_data TEXT NOT NULL,
            uploaded_by INTEGER NOT NULL,
            is_global  INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(name),
            FOREIGN KEY(uploaded_by) REFERENCES users(id) ON DELETE CASCADE
        )""")
        
        # ===================================================================
        # PHASE 5 — API Keys & Bots
        # ===================================================================
        con.execute("""CREATE TABLE IF NOT EXISTS api_keys (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL,
            key_hash    TEXT NOT NULL,
            name        TEXT NOT NULL,
            permissions TEXT DEFAULT '[]',
            last_used   TEXT,
            created_at  TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        
        con.execute("""CREATE TABLE IF NOT EXISTS bots (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id    INTEGER NOT NULL,
            name        TEXT UNIQUE NOT NULL,
            avatar      TEXT,
            description TEXT DEFAULT '',
            api_key_id  INTEGER NOT NULL,
            is_public   INTEGER DEFAULT 0,
            created_at  TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
        )""")
        
        con.execute("""CREATE TABLE IF NOT EXISTS bot_channel_members (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id      INTEGER NOT NULL,
            room_id     INTEGER NOT NULL,
            invited_by  INTEGER NOT NULL,
            permissions TEXT DEFAULT '["read","write"]',
            created_at  TEXT DEFAULT (datetime('now')),
            UNIQUE(bot_id, room_id),
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
            FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
        )""")

        # Bot ban list — per-node moderation. A banned bot:
        #   1. is removed from all local channels,
        #   2. cannot be re-added to any channel on this node,
        #   3. cannot post messages via the external API,
        #   4. is hidden from the public bot directory,
        #   5. if federated, its incoming bot.upsert events are dropped.
        # We track both the local bot id (snapshot, may go null on
        # cascade-delete) and origin/foreign_bot_id so federated bans
        # survive even after the local mirror row is gone.
        con.execute("""CREATE TABLE IF NOT EXISTS banned_bots (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id            INTEGER,
            origin_server_id  TEXT,
            foreign_bot_id    INTEGER,
            name              TEXT,
            reason            TEXT DEFAULT '',
            banned_by         INTEGER,
            created_at        TEXT DEFAULT (datetime('now')),
            UNIQUE(bot_id),
            UNIQUE(origin_server_id, foreign_bot_id)
        )""")
        
        # ===================================================================
        # PHASE 6 — Invite Links & Channel Directory
        # ===================================================================
        con.execute("""CREATE TABLE IF NOT EXISTS channel_invites (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id     INTEGER NOT NULL,
            code        TEXT UNIQUE NOT NULL,
            created_by  INTEGER NOT NULL,
            max_uses    INTEGER DEFAULT 0,
            use_count   INTEGER DEFAULT 0,
            expires_at  TEXT,
            created_at  TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
        )""")
        
        # Room directory columns
        if "is_public" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN is_public INTEGER DEFAULT 0")
        if "member_count" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN member_count INTEGER DEFAULT 0")
        if "category" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN category TEXT DEFAULT ''")
        if "channel_theme" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN channel_theme TEXT DEFAULT ''")
        if "invite_only" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN invite_only INTEGER DEFAULT 0")
        if "who_can_invite" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN who_can_invite TEXT DEFAULT 'everyone'")
        if "directory_description" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN directory_description TEXT DEFAULT ''")
        if "tags" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN tags TEXT DEFAULT '[]'")
        if "banner" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN banner TEXT DEFAULT ''")
        if "about" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN about TEXT DEFAULT ''")
        if "dj_only_queue" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN dj_only_queue INTEGER DEFAULT 0")
        # Forwarding controls: when set to 1, server rejects forwarded
        # messages whose source is this room, and the client hides the
        # Forward button on its messages.
        if "forwarding_disabled" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN forwarding_disabled INTEGER DEFAULT 0")
        # Vanity invite slug — owner-set custom URL component for
        # https://frogtalk.xyz/i/<vanity>. NULL = unset. Uniqueness across
        # channels is enforced case-insensitively via a partial index below.
        if "vanity" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN vanity TEXT")
        con.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_vanity_lower "
            "ON rooms(LOWER(vanity)) WHERE vanity IS NOT NULL"
        )
        # Track C Phase 1 — Sender Keys epoch counter. Informational only:
        # bumped by clients whenever they rotate their room sender-key
        # after a membership change. Server uses it for diagnostics
        # ("did everyone rotate after this kick?"). Not enforced.
        if "sender_key_epoch" not in room_cols:
            con.execute("ALTER TABLE rooms ADD COLUMN sender_key_epoch INTEGER NOT NULL DEFAULT 0")
        # Forwarded-from metadata for room messages: JSON blob
        # {nick, source_label, kind:'room'|'dm', original_id?}.
        if "forwarded_from" not in msg_cols:
            con.execute("ALTER TABLE messages ADD COLUMN forwarded_from TEXT")
        # Same for DMs.
        if "forwarding_disabled" not in dm_cols:
            con.execute("ALTER TABLE dm_channels ADD COLUMN forwarding_disabled INTEGER DEFAULT 0")
        if "forwarded_from" not in dm_msg_cols:
            con.execute("ALTER TABLE dm_messages ADD COLUMN forwarded_from TEXT")

        # ── Music channels: track queue + DJ roles ─────────────────────────
        con.execute("""CREATE TABLE IF NOT EXISTS music_queue (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            room_name  TEXT NOT NULL,
            submitter_id INTEGER,
            submitter_nick TEXT,
            provider   TEXT NOT NULL DEFAULT 'youtube',
            video_id   TEXT NOT NULL,
            url        TEXT NOT NULL,
            title      TEXT DEFAULT '',
            thumbnail  TEXT DEFAULT '',
            duration   INTEGER DEFAULT 0,
            played     INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )""")
        con.execute("CREATE INDEX IF NOT EXISTS idx_music_queue_room ON music_queue(room_name, played, id)")
        con.execute("""CREATE TABLE IF NOT EXISTS room_djs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            room_name  TEXT NOT NULL,
            user_id    INTEGER NOT NULL,
            granted_by INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(room_name, user_id)
        )""")
        
        # ===================================================================
        # PHASE 7 — Social Profiles & Wall
        # ===================================================================
        con.execute("""CREATE TABLE IF NOT EXISTS wall_posts (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id        INTEGER NOT NULL,
            content        TEXT NOT NULL,
            media_data     TEXT,
            media_type     TEXT,
            privacy        TEXT DEFAULT 'public',
            share_enabled  INTEGER DEFAULT 1,
            allow_comments INTEGER DEFAULT 1,
            created_at     TEXT DEFAULT (datetime('now')),
            edited_at      TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        
        con.execute("""CREATE TABLE IF NOT EXISTS wall_post_reactions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id    INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            emoji      TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(post_id, user_id, emoji),
            FOREIGN KEY (post_id) REFERENCES wall_posts(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        
        con.execute("""CREATE TABLE IF NOT EXISTS wall_comments (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id    INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            content    TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (post_id) REFERENCES wall_posts(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")

        con.execute("""CREATE TABLE IF NOT EXISTS wall_reposts (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id    INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            quote_text TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(post_id, user_id),
            FOREIGN KEY (post_id) REFERENCES wall_posts(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")

        # Polymorphic 👍/👎 votes on comments. `target_type` selects which
        # comments table the row refers to ('channel_comment' or
        # 'wall_comment'). SQLite has no polymorphic FK so the parent rows
        # are cleared explicitly in delete_channel_comment /
        # delete_wall_comment.
        con.execute("""CREATE TABLE IF NOT EXISTS comment_votes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            target_type TEXT NOT NULL CHECK(target_type IN ('channel_comment','wall_comment')),
            target_id   INTEGER NOT NULL,
            user_id     INTEGER NOT NULL,
            value       INTEGER NOT NULL CHECK(value IN (-1, 1)),
            created_at  TEXT DEFAULT (datetime('now')),
            UNIQUE(target_type, target_id, user_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        con.execute("""CREATE INDEX IF NOT EXISTS idx_cv_target
                       ON comment_votes(target_type, target_id)""")

        # Social activity notifications (likes, comments, follows on the
        # logged-in user's own posts/profile). Coalesced badge feed for the
        # 🤳🏼 sidebar icon.
        con.execute("""CREATE TABLE IF NOT EXISTS social_notifications (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,            -- recipient
            actor_id   INTEGER NOT NULL,            -- who triggered it
            kind       TEXT NOT NULL,               -- 'like' | 'comment' | 'follow'
            post_id    INTEGER,                     -- nullable
            comment_id INTEGER,                     -- nullable
            emoji      TEXT,                        -- like emoji (nullable)
            preview    TEXT,                        -- comment preview (nullable, ≤140 chars)
            created_at TEXT DEFAULT (datetime('now')),
            read_at    TEXT,                        -- NULL while unread
            FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        con.execute("""CREATE INDEX IF NOT EXISTS idx_social_notif_user_unread
                       ON social_notifications(user_id, read_at, created_at DESC)""")

        con.execute("""CREATE TABLE IF NOT EXISTS location_shares (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            dm_channel_id INTEGER NOT NULL,
            user_id       INTEGER NOT NULL,
            latitude      REAL NOT NULL,
            longitude     REAL NOT NULL,
            accuracy      REAL,
            expires_at    TEXT,
            created_at    TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (dm_channel_id) REFERENCES dm_channels(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        
        # User profile columns for wall and customization
        if "mood" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN mood TEXT DEFAULT ''")
        if "custom_css" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN custom_css TEXT DEFAULT ''")
        if "wall_enabled" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN wall_enabled INTEGER DEFAULT 1")
        if "wall_comments_enabled" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN wall_comments_enabled INTEGER DEFAULT 1")
        if "location_sharing_enabled" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN location_sharing_enabled INTEGER DEFAULT 0")
        
        # ===================================================================
        # PHASE 8 — Security & Recovery
        # ===================================================================
        con.execute("""CREATE TABLE IF NOT EXISTS followers (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            follower_id  INTEGER NOT NULL,
            following_id INTEGER NOT NULL,
            created_at   TEXT DEFAULT (datetime('now')),
            UNIQUE(follower_id, following_id),
            FOREIGN KEY (follower_id)  REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
        )""")

        # Reels seen — tracks which reels each viewer has already watched so
        # the personalized reels feed can prefer unseen content. We deliberately
        # keep this lean (uid, pid, ts) so writes on every scroll are cheap.
        con.execute("""CREATE TABLE IF NOT EXISTS reels_seen (
            user_id    INTEGER NOT NULL,
            post_id    INTEGER NOT NULL,
            seen_at    TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, post_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (post_id) REFERENCES wall_posts(id) ON DELETE CASCADE
        )""")
        con.execute("CREATE INDEX IF NOT EXISTS idx_reels_seen_user_seen ON reels_seen(user_id, seen_at DESC)")

        con.execute("""CREATE TABLE IF NOT EXISTS recovery_keys (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            key_hash   TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            used_at    TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        
        con.execute("""CREATE TABLE IF NOT EXISTS captcha_challenges (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            challenge_id TEXT UNIQUE NOT NULL,
            answer       TEXT NOT NULL,
            expires_at   TEXT NOT NULL,
            created_at   TEXT DEFAULT (datetime('now'))
        )""")

        # ===================================================================
        # PHASE 9 — Telegram Bridge
        # ===================================================================
        con.execute("""CREATE TABLE IF NOT EXISTS telegram_bridges (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            room_name        TEXT NOT NULL,
            telegram_chat_id INTEGER NOT NULL,
            telegram_chat_title TEXT DEFAULT '',
            bot_token        TEXT NOT NULL,
            bot_name         TEXT DEFAULT '',
            enabled          INTEGER DEFAULT 1,
            owner_id         INTEGER NOT NULL,
            created_at       TEXT DEFAULT (datetime('now')),
            UNIQUE(room_name, telegram_chat_id),
            FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
        )""")

        # ===================================================================
        # PHASE 10 — Discord Bridge
        # ===================================================================
        con.execute("""CREATE TABLE IF NOT EXISTS discord_bridges (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            room_name          TEXT NOT NULL,
            discord_channel_id INTEGER NOT NULL,
            discord_guild_id   INTEGER DEFAULT 0,
            discord_channel_name TEXT DEFAULT '',
            discord_guild_name TEXT DEFAULT '',
            bot_token          TEXT NOT NULL,
            bot_name           TEXT DEFAULT '',
            enabled            INTEGER DEFAULT 1,
            owner_id           INTEGER NOT NULL,
            created_at         TEXT DEFAULT (datetime('now')),
            UNIQUE(room_name, discord_channel_id),
            FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
        )""")

        # ===================================================================
        # Stories (Instagram-style, 24h expiry)
        # ===================================================================
        con.execute("""CREATE TABLE IF NOT EXISTS stories (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            media_data TEXT NOT NULL,
            media_type TEXT NOT NULL,
            caption    TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now')),
            expires_at TEXT DEFAULT (datetime('now', '+1 day')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")

        con.execute("""CREATE TABLE IF NOT EXISTS story_views (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            story_id   INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            viewed_at  TEXT DEFAULT (datetime('now')),
            UNIQUE(story_id, user_id),
            FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")

        # Room membership (which rooms a user has joined)
        con.execute("""CREATE TABLE IF NOT EXISTS room_members (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            joined_at TEXT DEFAULT (datetime('now')),
            UNIQUE(room_id, user_id),
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")

        # Stories privacy column (added later — safe migration)
        story_cols = {r["name"] for r in con.execute("PRAGMA table_info(stories)").fetchall()}
        if "privacy" not in story_cols:
            con.execute("ALTER TABLE stories ADD COLUMN privacy TEXT DEFAULT 'public'")

        # Federation servers: transport_preference column (added later — safe migration)
        fed_srv_cols = {r["name"] for r in con.execute("PRAGMA table_info(federation_servers)").fetchall()}
        if fed_srv_cols and "transport_preference" not in fed_srv_cols:
            con.execute("ALTER TABLE federation_servers ADD COLUMN transport_preference TEXT DEFAULT 'auto'")
        fed_profile_cols = {r["name"] for r in con.execute("PRAGMA table_info(federation_user_profiles)").fetchall()}
        if fed_profile_cols and "display_name" not in fed_profile_cols:
            con.execute("ALTER TABLE federation_user_profiles ADD COLUMN display_name TEXT DEFAULT ''")

        # ── Denormalized engagement counters on wall_posts ──
        # The /feed, /explore and /reels endpoints used to evaluate three
        # correlated subqueries per row (reactions/comments/reposts COUNT(*))
        # × ~120 candidate rows = up to 360 sub-selects per page. Materializing
        # the counts on wall_posts and maintaining them via triggers turns each
        # row into a single column read.
        wall_cols = {r["name"] for r in con.execute("PRAGMA table_info(wall_posts)").fetchall()}
        _newly_added_counters: list[str] = []
        for _col in ("reaction_count", "comment_count", "repost_count"):
            if _col not in wall_cols:
                con.execute(f"ALTER TABLE wall_posts ADD COLUMN {_col} INTEGER DEFAULT 0")
                _newly_added_counters.append(_col)

        # Backfill once for any newly-added column (idempotent — runs only on
        # the first server start that introduced the column).
        if "reaction_count" in _newly_added_counters:
            con.execute(
                "UPDATE wall_posts SET reaction_count = COALESCE(("
                "SELECT COUNT(*) FROM wall_post_reactions WHERE post_id = wall_posts.id), 0)"
            )
        if "comment_count" in _newly_added_counters:
            con.execute(
                "UPDATE wall_posts SET comment_count = COALESCE(("
                "SELECT COUNT(*) FROM wall_comments WHERE post_id = wall_posts.id), 0)"
            )
        if "repost_count" in _newly_added_counters:
            con.execute(
                "UPDATE wall_posts SET repost_count = COALESCE(("
                "SELECT COUNT(*) FROM wall_reposts WHERE post_id = wall_posts.id), 0)"
            )

        # Triggers keep the counters in sync within the same transaction as
        # the INSERT/DELETE — race-free, no application-level coupling.
        for _trig in (
            "CREATE TRIGGER IF NOT EXISTS tr_wall_post_reactions_ai "
            "AFTER INSERT ON wall_post_reactions BEGIN "
            "UPDATE wall_posts SET reaction_count = reaction_count + 1 WHERE id = NEW.post_id; END",
            "CREATE TRIGGER IF NOT EXISTS tr_wall_post_reactions_ad "
            "AFTER DELETE ON wall_post_reactions BEGIN "
            "UPDATE wall_posts SET reaction_count = MAX(0, reaction_count - 1) WHERE id = OLD.post_id; END",
            "CREATE TRIGGER IF NOT EXISTS tr_wall_comments_ai "
            "AFTER INSERT ON wall_comments BEGIN "
            "UPDATE wall_posts SET comment_count = comment_count + 1 WHERE id = NEW.post_id; END",
            "CREATE TRIGGER IF NOT EXISTS tr_wall_comments_ad "
            "AFTER DELETE ON wall_comments BEGIN "
            "UPDATE wall_posts SET comment_count = MAX(0, comment_count - 1) WHERE id = OLD.post_id; END",
            "CREATE TRIGGER IF NOT EXISTS tr_wall_reposts_ai "
            "AFTER INSERT ON wall_reposts BEGIN "
            "UPDATE wall_posts SET repost_count = repost_count + 1 WHERE id = NEW.post_id; END",
            "CREATE TRIGGER IF NOT EXISTS tr_wall_reposts_ad "
            "AFTER DELETE ON wall_reposts BEGIN "
            "UPDATE wall_posts SET repost_count = MAX(0, repost_count - 1) WHERE id = OLD.post_id; END",
        ):
            try:
                con.execute(_trig)
            except Exception:
                pass

        # ── Performance indexes for social/wall/stories/friends hot paths ──
        for _idx in (
            "CREATE INDEX IF NOT EXISTS idx_wall_posts_user_created ON wall_posts(user_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_wall_posts_created ON wall_posts(created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_wall_post_reactions_post ON wall_post_reactions(post_id)",
            "CREATE INDEX IF NOT EXISTS idx_wall_comments_post ON wall_comments(post_id, created_at)",
            "CREATE INDEX IF NOT EXISTS idx_wall_reposts_post ON wall_reposts(post_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_wall_reposts_user ON wall_reposts(user_id, created_at DESC)",
            # Composite index optimizes the per-row EXISTS check used to
            # populate `i_reposted` in feed/explore/reels queries.
            "CREATE INDEX IF NOT EXISTS idx_wall_reposts_post_user ON wall_reposts(post_id, user_id)",
            # Reaction lookups by reactor (reels-friends scope EXISTS check).
            "CREATE INDEX IF NOT EXISTS idx_wall_post_reactions_user_post ON wall_post_reactions(user_id, post_id)",
            "CREATE INDEX IF NOT EXISTS idx_stories_user_expires ON stories(user_id, expires_at)",
            "CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at)",
            "CREATE INDEX IF NOT EXISTS idx_followers_follower ON followers(follower_id, following_id)",
            "CREATE INDEX IF NOT EXISTS idx_followers_following ON followers(following_id, follower_id)",
            "CREATE INDEX IF NOT EXISTS idx_friends_pair ON friends(user_id, friend_id, status)",
            "CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_id, status)",
            "CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id, blocked_id)",
            "CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id, blocker_id)",
            "CREATE INDEX IF NOT EXISTS idx_dm_messages_expires ON dm_messages(expires_at)",
            "CREATE INDEX IF NOT EXISTS idx_story_views_pair ON story_views(story_id, user_id)",
            # Round 2 perf: hot SELECT paths
            "CREATE INDEX IF NOT EXISTS idx_messages_room_id_desc ON messages(room_name, id DESC)",
            "CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_dm_messages_channel_id ON dm_messages(channel_id, id DESC)",
            "CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id)",
            "CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)",
            "CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id, room_id)",
            "CREATE INDEX IF NOT EXISTS idx_room_bans_lookup ON room_bans(room_id, user_id)",
            # Reels tab: filters wall_posts by media_type LIKE 'video/%' — this
            # composite index lets SQLite scan only video rows before sorting.
            "CREATE INDEX IF NOT EXISTS idx_wall_posts_mediatype_created ON wall_posts(media_type, created_at DESC)",
            # Feed/explore follower join — speeds up the LEFT JOIN on followers
            # used in get_feed_posts to find posts from followed users.
            "CREATE INDEX IF NOT EXISTS idx_followers_following_follower ON followers(following_id, follower_id)",
        ):
            try:
                con.execute(_idx)
            except Exception:
                pass

        # Refresh planner statistics so the new indexes are actually used.
        try:
            con.execute("ANALYZE")
        except Exception:
            pass

        # ──────────────────────────────────────────────────────────────────
        # Security refactor — Phase 1 schema (dark by default).
        #
        # See docs/SECURITY_REFACTOR_PLAN.md.
        #
        #   Track A — Signal Protocol prekey bundle storage. These tables
        #   sit idle until FROGTALK_DM_ENC_V2 is enabled and clients start
        #   publishing bundles. Existing v1 ECDH path is unaffected.
        #
        #   Track B — `users.custom_style` is the sanitised inline-style
        #   declaration list. `users.custom_css` keeps the raw user input
        #   for the editor round-trip; only `custom_style` is ever applied
        #   to the DOM (and never as a <style> block).
        # ──────────────────────────────────────────────────────────────────
        try:
            if "custom_style" not in cols:
                con.execute("ALTER TABLE users ADD COLUMN custom_style TEXT DEFAULT ''")
        except Exception:
            pass

        con.execute("""CREATE TABLE IF NOT EXISTS signal_identity_keys (
            user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            registration_id INTEGER NOT NULL,
            identity_pub    BLOB    NOT NULL,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        )""")
        con.execute("""CREATE TABLE IF NOT EXISTS signal_signed_prekeys (
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            prekey_id   INTEGER NOT NULL,
            public_key  BLOB    NOT NULL,
            signature   BLOB    NOT NULL,
            created_at  INTEGER NOT NULL,
            PRIMARY KEY (user_id, prekey_id)
        )""")
        con.execute("""CREATE TABLE IF NOT EXISTS signal_one_time_prekeys (
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            prekey_id   INTEGER NOT NULL,
            public_key  BLOB    NOT NULL,
            consumed_at INTEGER,
            PRIMARY KEY (user_id, prekey_id)
        )""")
        # Hot path: "pick an unconsumed OTPK for user X" — partial index on
        # the NULL consumed_at rows keeps the lookup O(log N) regardless of
        # how many historical OTPKs have been consumed.
        try:
            con.execute(
                "CREATE INDEX IF NOT EXISTS idx_otpk_avail "
                "ON signal_one_time_prekeys(user_id) WHERE consumed_at IS NULL"
            )
        except Exception:
            pass

        # ──────────────────────────────────────────────────────────────────
        # Security refactor Track C Phase 3 — SKDM (Sender-Key Distribution
        # Message) offline spool. The payload is an opaque Track A v2
        # Signal envelope (already DM-encrypted to the recipient). The
        # server cannot read it. It is kept only as a hand-off buffer for
        # recipients that are offline when the sender fans the SKDM. On
        # WS connect the recipient drains its pending rows.
        #
        # Cap: an attacker spamming SKDMs cannot grow this table without
        # bound — see `signal_skdm_enqueue`'s per-recipient cap (256 rows,
        # oldest evicted FIFO). 30-day age cap on top of that. No PII.
        # ──────────────────────────────────────────────────────────────────
        con.execute("""CREATE TABLE IF NOT EXISTS signal_pending_skdms (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            room_id      TEXT    NOT NULL,
            envelope     TEXT    NOT NULL,
            created_at   INTEGER NOT NULL
        )""")
        try:
            con.execute(
                "CREATE INDEX IF NOT EXISTS idx_skdm_recipient "
                "ON signal_pending_skdms(recipient_id, id)"
            )
        except Exception:
            pass

        # ──────────────────────────────────────────────────────────────────
        # Security refactor Track F Phase 1 — linked devices (dark backend).
        # One row per (user_id, device_id). device_id is a client-generated
        # UUID. `device_identity_pub` is the per-device Curve25519 identity
        # the secondary publishes; `primary_sig` is an XEdDSA signature by
        # the user's *primary* identity key over (device_id || identity_pub
        # || created_at), so any receiver can verify the device enrolment
        # against the primary key it already trusts. The server never
        # verifies the signature itself — it is dumb transit, exactly like
        # the bundle endpoints. Bundle-shape change and client fanout are
        # deferred to Phase 2; this phase only stores the data so that the
        # device-management UI can be built against a real backend.
        # ──────────────────────────────────────────────────────────────────
        con.execute("""CREATE TABLE IF NOT EXISTS user_devices (
            user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            device_id            TEXT    NOT NULL,
            name                 TEXT    NOT NULL DEFAULT '',
            device_identity_pub  BLOB    NOT NULL,
            primary_sig          BLOB    NOT NULL,
            created_at           INTEGER NOT NULL,
            last_seen_at         INTEGER,
            revoked_at           INTEGER,
            PRIMARY KEY (user_id, device_id)
        )""")
        try:
            con.execute(
                "CREATE INDEX IF NOT EXISTS idx_user_devices_active "
                "ON user_devices(user_id) WHERE revoked_at IS NULL"
            )
        except Exception:
            pass

        # ──────────────────────────────────────────────────────────────────
        # Security refactor Track F Phase 2 — pairing tokens for QR-based
        # secondary device enrolment. Short-lived (5 minute TTL). The
        # primary generates a token, displays it as a QR code. The
        # secondary device (logged into the same account) scans the QR
        # and POSTs its locally-generated Curve25519 device identity
        # public key under that token. The primary polls, verifies the
        # device fingerprint with the user, signs (device_id ||
        # identity_pub) with its primary Signal identity key, and
        # approves — at which point the pairing row is consumed and the
        # device is written into `user_devices`. The token is opaque
        # 32-byte random hex; never reused; status transitions are one-
        # way (pending → claimed → complete | expired). The server does
        # not verify the primary signature; receivers verify on read.
        # ──────────────────────────────────────────────────────────────────
        con.execute("""CREATE TABLE IF NOT EXISTS signal_pairing_tokens (
            token                TEXT    PRIMARY KEY,
            user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            device_identity_pub  BLOB,
            device_name          TEXT,
            device_id            TEXT,
            status               TEXT    NOT NULL,
            created_at           INTEGER NOT NULL,
            expires_at           INTEGER NOT NULL
        )""")
        try:
            con.execute(
                "CREATE INDEX IF NOT EXISTS idx_pairing_user_status "
                "ON signal_pairing_tokens(user_id, status)"
            )
        except Exception:
            pass

        # ──────────────────────────────────────────────────────────────────
        # Security refactor Track E — signed DTLS fingerprint blob carried
        # alongside the call SDP. Opaque base64 JSON; server is just a
        # passthrough. Stored on the pending offer so a cold-resumed
        # callee still gets the signed payload to verify against the
        # received SDP. Empty string means "v1 unverified call".
        # ──────────────────────────────────────────────────────────────────
        try:
            pco_cols = {r["name"] for r in con.execute("PRAGMA table_info(pending_call_offers)").fetchall()}
            if pco_cols and "fp_sig" not in pco_cols:
                con.execute("ALTER TABLE pending_call_offers ADD COLUMN fp_sig TEXT DEFAULT ''")
        except Exception:
            pass

        con.commit()

    # Track B one-shot backfill: ensure every existing user has their
    # `custom_style` derived from the raw `custom_css`. Idempotent —
    # only touches rows where `custom_style` is still empty. Failure
    # here must not block startup (logging out of band; renderer just
    # falls back to default styling for that user).
    try:
        n = backfill_custom_style()
        if n:
            print(f"[migrate] backfilled custom_style for {n} users")
    except Exception as _e:
        print(f"[migrate] custom_style backfill skipped: {_e!r}")

def signal_publish_bundle(user_id: int, registration_id: int,
                          identity_pub: bytes,
                          signed_prekey_id: int, signed_prekey_pub: bytes,
                          signed_prekey_sig: bytes,
                          one_time_prekeys: List[Dict]) -> Dict:
    """Replace the user's identity + signed-prekey, append OTPKs.

    `one_time_prekeys` is a list of `{"id": int, "pub": bytes}`. The
    signed prekey is always replaced (one-per-user model — old signed
    prekey IDs are kept for in-flight session establishment but a future
    cleanup task may sweep them).

    Returns counts so the caller can surface them in the response.
    """
    if not isinstance(identity_pub, (bytes, bytearray)) or len(identity_pub) != 32:
        raise ValueError("identity_pub must be 32 bytes")
    if not isinstance(signed_prekey_pub, (bytes, bytearray)) or len(signed_prekey_pub) != 32:
        raise ValueError("signed_prekey_pub must be 32 bytes")
    if not isinstance(signed_prekey_sig, (bytes, bytearray)) or len(signed_prekey_sig) != 64:
        raise ValueError("signed_prekey_sig must be 64 bytes (Ed25519)")
    now = int(time.time())
    appended = 0
    with _conn() as con:
        con.execute("BEGIN IMMEDIATE")
        con.execute("""
            INSERT INTO signal_identity_keys (user_id, registration_id, identity_pub, created_at, updated_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET
                registration_id=excluded.registration_id,
                identity_pub=excluded.identity_pub,
                updated_at=excluded.updated_at
        """, (user_id, int(registration_id), bytes(identity_pub), now, now))
        con.execute("""
            INSERT INTO signal_signed_prekeys (user_id, prekey_id, public_key, signature, created_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(user_id, prekey_id) DO UPDATE SET
                public_key=excluded.public_key,
                signature=excluded.signature,
                created_at=excluded.created_at
        """, (user_id, int(signed_prekey_id), bytes(signed_prekey_pub),
              bytes(signed_prekey_sig), now))
        for otpk in (one_time_prekeys or [])[:100]:
            try:
                pid = int(otpk["id"])
                pub = otpk["pub"]
                if not isinstance(pub, (bytes, bytearray)) or len(pub) != 32:
                    continue
                con.execute(
                    "INSERT OR IGNORE INTO signal_one_time_prekeys "
                    "(user_id, prekey_id, public_key, consumed_at) VALUES (?,?,?,NULL)",
                    (user_id, pid, bytes(pub))
                )
                if con.total_changes:
                    appended += 1
            except (KeyError, TypeError, ValueError):
                continue
        con.commit()
    return {"ok": True, "otpks_added": appended}


def signal_fetch_bundle(user_id: int) -> Optional[Dict]:
    """Return one bundle for `user_id` and atomically consume one OTPK.

    Returns None if the user has not published an identity. Returns a
    dict with `one_time_prekey: None` when the OTPK pool is empty — the
    Signal protocol permits this and clients must handle the null.
    """
    with _conn() as con:
        con.execute("BEGIN IMMEDIATE")
        ident = con.execute(
            "SELECT registration_id, identity_pub FROM signal_identity_keys WHERE user_id=?",
            (user_id,)
        ).fetchone()
        if not ident:
            con.commit()
            return None
        sp = con.execute(
            "SELECT prekey_id, public_key, signature FROM signal_signed_prekeys "
            "WHERE user_id=? ORDER BY prekey_id DESC LIMIT 1",
            (user_id,)
        ).fetchone()
        if not sp:
            con.commit()
            return None
        otpk_row = con.execute(
            "SELECT prekey_id, public_key FROM signal_one_time_prekeys "
            "WHERE user_id=? AND consumed_at IS NULL ORDER BY prekey_id LIMIT 1",
            (user_id,)
        ).fetchone()
        otpk: Optional[Dict] = None
        if otpk_row:
            # Hard delete (rather than marking consumed_at) keeps the table
            # bounded and means a leaked DB snapshot can't replay used OTPKs.
            con.execute(
                "DELETE FROM signal_one_time_prekeys WHERE user_id=? AND prekey_id=?",
                (user_id, int(otpk_row["prekey_id"]))
            )
            otpk = {
                "id": int(otpk_row["prekey_id"]),
                "pub": bytes(otpk_row["public_key"]),
            }
        con.commit()
    return {
        "registration_id": int(ident["registration_id"]),
        "identity_pub": bytes(ident["identity_pub"]),
        "signed_prekey": {
            "id": int(sp["prekey_id"]),
            "pub": bytes(sp["public_key"]),
            "sig": bytes(sp["signature"]),
        },
        "one_time_prekey": otpk,
    }


def signal_otpk_count(user_id: int) -> int:
    """Return the count of unconsumed OTPKs for this user."""
    with _conn() as con:
        row = con.execute(
            "SELECT COUNT(*) AS n FROM signal_one_time_prekeys "
            "WHERE user_id=? AND consumed_at IS NULL",
            (user_id,)
        ).fetchone()
    return int(row["n"]) if row else 0


# ---------------------------------------------------------------------------
# Sender-Key Distribution Message (SKDM) spool — Track C Phase 3
# ---------------------------------------------------------------------------

# Per-recipient cap to bound storage under SKDM spam. Picked generously
# enough to cover a user in many rooms whose contacts all rotate at the
# same time, but small enough that an attacker cannot grow the table to
# DoS proportions. Oldest rows are evicted FIFO on enqueue.
_SKDM_PER_RECIPIENT_CAP = 256

# Anything older than this is dropped on drain. Bounds the table size
# against zombie recipients that never come back online.
_SKDM_MAX_AGE_SECS = 30 * 24 * 3600


def signal_skdm_enqueue(recipient_id: int, sender_id: int,
                        room_id: str, envelope: str) -> int:
    """Persist one SKDM for offline delivery. Returns the row id.

    `envelope` is the opaque Track-A v2 Signal envelope JSON (already
    encrypted by the sender against the recipient's identity). The
    server cannot read it.
    """
    import time
    now = int(time.time())
    with _conn() as con:
        con.execute("BEGIN IMMEDIATE")
        # Trim to cap BEFORE inserting so we keep the row we're about to
        # add and only evict older entries for this recipient.
        con.execute(
            "DELETE FROM signal_pending_skdms WHERE recipient_id=? "
            "AND id IN ("
            " SELECT id FROM signal_pending_skdms WHERE recipient_id=? "
            " ORDER BY id DESC LIMIT -1 OFFSET ?"
            ")",
            (recipient_id, recipient_id, _SKDM_PER_RECIPIENT_CAP - 1),
        )
        cur = con.execute(
            "INSERT INTO signal_pending_skdms "
            "(recipient_id, sender_id, room_id, envelope, created_at) "
            "VALUES (?,?,?,?,?)",
            (recipient_id, sender_id, str(room_id), envelope, now),
        )
        rid = int(cur.lastrowid or 0)
        con.commit()
    return rid


def signal_skdm_drain(recipient_id: int) -> list:
    """Pop all pending SKDMs for this recipient. Returns a list of dicts:
        {id, sender_id, room_id, envelope, created_at}
    Rows older than _SKDM_MAX_AGE_SECS are dropped without delivery.
    """
    import time
    cutoff = int(time.time()) - _SKDM_MAX_AGE_SECS
    with _conn() as con:
        con.execute("BEGIN IMMEDIATE")
        # Drop stale rows for this recipient first.
        con.execute(
            "DELETE FROM signal_pending_skdms WHERE recipient_id=? AND created_at < ?",
            (recipient_id, cutoff),
        )
        rows = con.execute(
            "SELECT id, sender_id, room_id, envelope, created_at "
            "FROM signal_pending_skdms WHERE recipient_id=? ORDER BY id ASC",
            (recipient_id,),
        ).fetchall()
        if rows:
            con.execute(
                "DELETE FROM signal_pending_skdms WHERE recipient_id=?",
                (recipient_id,),
            )
        con.commit()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Linked devices — Track F Phase 1 (dark backend)
# ---------------------------------------------------------------------------

# Hard cap on devices per user. Signal allows 5 secondaries + 1 primary;
# we cap at 6 active rows total. A revoked row stays around so the audit
# trail survives — only *active* (revoked_at IS NULL) rows count.
_MAX_ACTIVE_DEVICES = 6


def signal_device_link(*, user_id: int, device_id: str, name: str,
                       device_identity_pub: bytes, primary_sig: bytes) -> dict:
    """Persist a new linked device for `user_id`.

    The server does not verify `primary_sig` itself — peers verify the
    sig with the user's primary identity key on read. We do enforce
    structural constraints (bytes lengths, device_id shape, cap).

    Raises ValueError for structural errors and a `cap` error when the
    user already has _MAX_ACTIVE_DEVICES active devices.
    """
    if not isinstance(device_id, str) or not (8 <= len(device_id) <= 64):
        raise ValueError("device_id_bad_length")
    if any((c not in "0123456789abcdefABCDEF-") for c in device_id):
        raise ValueError("device_id_bad_chars")
    if not isinstance(device_identity_pub, (bytes, bytearray)) or len(device_identity_pub) != 32:
        raise ValueError("device_identity_pub_bad_length")
    if not isinstance(primary_sig, (bytes, bytearray)) or len(primary_sig) != 64:
        raise ValueError("primary_sig_bad_length")
    safe_name = (name or "").strip()[:64]
    now = int(time.time())
    with _conn() as con:
        con.execute("BEGIN IMMEDIATE")
        active = con.execute(
            "SELECT COUNT(*) AS n FROM user_devices "
            "WHERE user_id=? AND revoked_at IS NULL",
            (user_id,),
        ).fetchone()
        if active and int(active["n"]) >= _MAX_ACTIVE_DEVICES:
            con.commit()
            raise ValueError("device_cap_reached")
        con.execute(
            "INSERT OR REPLACE INTO user_devices "
            "(user_id, device_id, name, device_identity_pub, primary_sig, "
            " created_at, last_seen_at, revoked_at) "
            "VALUES (?,?,?,?,?,?,?,NULL)",
            (int(user_id), device_id, safe_name,
             bytes(device_identity_pub), bytes(primary_sig), now, now),
        )
        con.commit()
    return {
        "user_id":     int(user_id),
        "device_id":   device_id,
        "name":        safe_name,
        "created_at":  now,
        "last_seen_at": now,
        "revoked_at":  None,
    }


def signal_devices_for_user(user_id: int, *, include_revoked: bool = False) -> list:
    """Return all devices for `user_id`. Each dict has:
        device_id, name, device_identity_pub (bytes), primary_sig (bytes),
        created_at, last_seen_at, revoked_at
    """
    with _conn() as con:
        if include_revoked:
            rows = con.execute(
                "SELECT device_id, name, device_identity_pub, primary_sig, "
                "       created_at, last_seen_at, revoked_at "
                "FROM user_devices WHERE user_id=? ORDER BY created_at ASC",
                (int(user_id),),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT device_id, name, device_identity_pub, primary_sig, "
                "       created_at, last_seen_at, revoked_at "
                "FROM user_devices WHERE user_id=? AND revoked_at IS NULL "
                "ORDER BY created_at ASC",
                (int(user_id),),
            ).fetchall()
    out = []
    for r in rows:
        out.append({
            "device_id":           str(r["device_id"]),
            "name":                str(r["name"] or ""),
            "device_identity_pub": bytes(r["device_identity_pub"]),
            "primary_sig":         bytes(r["primary_sig"]),
            "created_at":          int(r["created_at"]),
            "last_seen_at":        int(r["last_seen_at"] or 0) or None,
            "revoked_at":          int(r["revoked_at"]) if r["revoked_at"] else None,
        })
    return out


def signal_device_revoke(user_id: int, device_id: str) -> bool:
    """Mark a device as revoked. Returns True if a row was changed.

    Idempotent: revoking an already-revoked device is a no-op success.
    """
    now = int(time.time())
    with _conn() as con:
        con.execute("BEGIN IMMEDIATE")
        cur = con.execute(
            "UPDATE user_devices SET revoked_at=? "
            "WHERE user_id=? AND device_id=? AND revoked_at IS NULL",
            (now, int(user_id), str(device_id)),
        )
        changed = cur.rowcount
        con.commit()
    return changed > 0


def signal_device_touch(user_id: int, device_id: str) -> None:
    """Bump last_seen_at for an active device. No-op for revoked/unknown rows."""
    now = int(time.time())
    with _conn() as con:
        con.execute(
            "UPDATE user_devices SET last_seen_at=? "
            "WHERE user_id=? AND device_id=? AND revoked_at IS NULL",
            (now, int(user_id), str(device_id)),
        )
        con.commit()


# ---------------------------------------------------------------------------
# Pairing tokens for QR-based device linking (Track F Phase 2)
# ---------------------------------------------------------------------------

_PAIRING_TTL_SECONDS = 5 * 60   # 5 minutes
_PAIRING_TOKEN_BYTES = 32       # 256-bit unguessable token, encoded as hex

# Status enum (string for SQLite clarity):
#   "pending"  — primary created the token, secondary not yet claimed
#   "claimed"  — secondary posted its identity_pub, awaiting primary signature
#   "complete" — primary signed + signal_device_link succeeded
# Expired rows are pruned lazily on lookup; an explicit sweep keeps them out
# of the table indefinitely.


def _pairing_prune(con) -> None:
    """Mark expired pending/claimed rows so callers see a clean state."""
    now = int(time.time())
    con.execute(
        "DELETE FROM signal_pairing_tokens "
        "WHERE expires_at < ? AND status IN ('pending','claimed')",
        (now,),
    )


def signal_pairing_create(user_id: int) -> Dict:
    """Primary device creates a fresh pairing token.

    Returns ``{token, expires_at}``. A user may have many concurrent
    tokens (we don't deduplicate) — the UI is responsible for cancelling
    stale flows. The TTL is short enough that abandoned tokens self-expire.
    """
    import secrets
    token = secrets.token_hex(_PAIRING_TOKEN_BYTES)
    now = int(time.time())
    expires_at = now + _PAIRING_TTL_SECONDS
    with _conn() as con:
        con.execute("BEGIN IMMEDIATE")
        _pairing_prune(con)
        con.execute(
            "INSERT INTO signal_pairing_tokens "
            "(token, user_id, status, created_at, expires_at) "
            "VALUES (?,?,?,?,?)",
            (token, int(user_id), "pending", now, expires_at),
        )
        con.commit()
    return {"token": token, "expires_at": expires_at}


def signal_pairing_claim(*, token: str, caller_user_id: int,
                         device_identity_pub: bytes,
                         device_name: str) -> Dict:
    """Secondary device claims a pairing token.

    Raises ValueError with a stable code for the API layer to map:
      ``token_not_found`` ``token_expired`` ``token_wrong_user``
      ``token_already_claimed`` ``device_identity_pub_bad_length``
      ``device_name_too_long``
    """
    if not isinstance(token, str) or len(token) != _PAIRING_TOKEN_BYTES * 2:
        raise ValueError("token_not_found")
    if not isinstance(device_identity_pub, (bytes, bytearray)) or len(device_identity_pub) != 32:
        raise ValueError("device_identity_pub_bad_length")
    if device_name is None:
        device_name = ""
    device_name = str(device_name)[:64]
    now = int(time.time())
    with _conn() as con:
        con.execute("BEGIN IMMEDIATE")
        _pairing_prune(con)
        row = con.execute(
            "SELECT user_id, status, expires_at FROM signal_pairing_tokens WHERE token=?",
            (token,),
        ).fetchone()
        if not row:
            con.commit()
            raise ValueError("token_not_found")
        if int(row["user_id"]) != int(caller_user_id):
            con.commit()
            raise ValueError("token_wrong_user")
        if int(row["expires_at"]) < now:
            con.commit()
            raise ValueError("token_expired")
        if row["status"] != "pending":
            con.commit()
            raise ValueError("token_already_claimed")
        con.execute(
            "UPDATE signal_pairing_tokens "
            "SET device_identity_pub=?, device_name=?, status='claimed' "
            "WHERE token=?",
            (bytes(device_identity_pub), device_name, token),
        )
        con.commit()
    return {"ok": True, "expires_at": int(row["expires_at"])}


def signal_pairing_lookup(*, token: str, caller_user_id: int) -> Optional[Dict]:
    """Primary polls the token to see whether the secondary has claimed it.

    Returns ``None`` if the token does not exist, is expired, or belongs
    to a different user (the API maps None → 404). Otherwise returns the
    row as a dict, with `device_identity_pub` as bytes (may be None).
    """
    if not isinstance(token, str) or len(token) != _PAIRING_TOKEN_BYTES * 2:
        return None
    now = int(time.time())
    with _conn() as con:
        con.execute("BEGIN IMMEDIATE")
        _pairing_prune(con)
        row = con.execute(
            "SELECT user_id, device_identity_pub, device_name, device_id, "
            "       status, created_at, expires_at "
            "FROM signal_pairing_tokens WHERE token=?",
            (token,),
        ).fetchone()
        con.commit()
    if not row:
        return None
    if int(row["user_id"]) != int(caller_user_id):
        return None
    if int(row["expires_at"]) < now and row["status"] in ("pending", "claimed"):
        return None
    return {
        "user_id":             int(row["user_id"]),
        "device_identity_pub": bytes(row["device_identity_pub"]) if row["device_identity_pub"] else None,
        "device_name":         row["device_name"] or "",
        "device_id":           row["device_id"],
        "status":              row["status"],
        "created_at":          int(row["created_at"]),
        "expires_at":          int(row["expires_at"]),
    }


def signal_pairing_approve(*, token: str, caller_user_id: int,
                           device_id: str, primary_sig: bytes,
                           name_override: Optional[str] = None) -> Dict:
    """Primary approves a claimed pairing token.

    Verifies that the token belongs to the caller, is in `claimed`
    status, and not expired. Then calls `signal_device_link` with the
    secondary's identity_pub stashed under the token. On success the
    token row is marked `complete` so the secondary's status poll
    flips to "done".
    """
    if not isinstance(token, str) or len(token) != _PAIRING_TOKEN_BYTES * 2:
        raise ValueError("token_not_found")
    if not isinstance(primary_sig, (bytes, bytearray)) or len(primary_sig) != 64:
        raise ValueError("primary_sig_bad_length")
    now = int(time.time())
    with _conn() as con:
        con.execute("BEGIN IMMEDIATE")
        _pairing_prune(con)
        row = con.execute(
            "SELECT user_id, device_identity_pub, device_name, status, expires_at "
            "FROM signal_pairing_tokens WHERE token=?",
            (token,),
        ).fetchone()
        if not row:
            con.commit()
            raise ValueError("token_not_found")
        if int(row["user_id"]) != int(caller_user_id):
            con.commit()
            raise ValueError("token_wrong_user")
        if int(row["expires_at"]) < now:
            con.commit()
            raise ValueError("token_expired")
        if row["status"] != "claimed":
            con.commit()
            raise ValueError("token_not_claimed")
        identity_pub = bytes(row["device_identity_pub"]) if row["device_identity_pub"] else b""
        if len(identity_pub) != 32:
            con.commit()
            raise ValueError("token_corrupt")
        # We're inside an outer transaction; signal_device_link uses its
        # own connection + BEGIN IMMEDIATE. Commit here so we don't hold
        # the writer lock across the helper call.
        con.commit()

    name = name_override if name_override is not None else (row["device_name"] or "")
    # signal_device_link raises ValueError on cap / format errors — let
    # those propagate so the API maps them to 400.
    linked = signal_device_link(
        user_id=int(caller_user_id),
        device_id=str(device_id),
        name=str(name)[:64],
        device_identity_pub=identity_pub,
        primary_sig=bytes(primary_sig),
    )
    # Flip the token to complete and remember which device_id was used so
    # the secondary's status poll can echo it back.
    with _conn() as con:
        con.execute(
            "UPDATE signal_pairing_tokens SET status='complete', device_id=? "
            "WHERE token=? AND status='claimed'",
            (str(device_id), token),
        )
        con.commit()
    return {"ok": True, "device": linked}


def signal_pairing_status(token: str) -> Dict:
    """Unauthenticated status poll for the secondary device.

    Returns ``{status: 'pending'|'claimed'|'complete'|'expired'|'unknown',
    device_id?: str}``. Never reveals the identity_pub, name, or user_id
    — the caller must hold the token to learn anything.
    """
    if not isinstance(token, str) or len(token) != _PAIRING_TOKEN_BYTES * 2:
        return {"status": "unknown"}
    now = int(time.time())
    with _conn() as con:
        row = con.execute(
            "SELECT status, device_id, expires_at "
            "FROM signal_pairing_tokens WHERE token=?",
            (token,),
        ).fetchone()
    if not row:
        return {"status": "unknown"}
    status = row["status"]
    if status in ("pending", "claimed") and int(row["expires_at"]) < now:
        return {"status": "expired"}
    out = {"status": status}
    if status == "complete" and row["device_id"]:
        out["device_id"] = row["device_id"]
    return out


# ---------------------------------------------------------------------------
# Extended user helpers
# ---------------------------------------------------------------------------

def get_config(key: str) -> Optional[str]:
    with _conn() as con:
        row = con.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def set_config(key: str, value: str):
    with _conn() as con:
        con.execute("INSERT OR REPLACE INTO config(key,value) VALUES(?,?)", (key, value))
        con.commit()


def _get_positive_int_config(key: str, default: int, minimum: int = 0, maximum: int = 3650) -> int:
    raw = get_config(key)
    if raw is None or str(raw).strip() == "":
        return int(default)
    try:
        value = int(str(raw).strip())
    except Exception:
        return int(default)
    return max(minimum, min(maximum, value))


def get_channel_directory_active_days() -> int:
    return _get_positive_int_config(
        CHANNEL_DIRECTORY_ACTIVE_DAYS_KEY,
        DEFAULT_CHANNEL_DIRECTORY_ACTIVE_DAYS,
        minimum=1,
    )


def get_channel_auto_delete_days() -> int:
    return _get_positive_int_config(
        CHANNEL_AUTO_DELETE_DAYS_KEY,
        DEFAULT_CHANNEL_AUTO_DELETE_DAYS,
        minimum=0,
    )


def get_channel_retention_settings() -> Dict[str, int]:
    directory_days = get_channel_directory_active_days()
    auto_delete_days = get_channel_auto_delete_days()
    return {
        "directory_active_days": directory_days,
        "auto_delete_days": auto_delete_days,
        "auto_delete_enabled": 1 if auto_delete_days > 0 else 0,
    }


def set_channel_retention_settings(directory_active_days: int, auto_delete_days: int) -> Dict[str, int]:
    directory_days = max(1, min(3650, int(directory_active_days)))
    delete_days = max(0, min(3650, int(auto_delete_days)))
    set_config(CHANNEL_DIRECTORY_ACTIVE_DAYS_KEY, str(directory_days))
    set_config(CHANNEL_AUTO_DELETE_DAYS_KEY, str(delete_days))
    return get_channel_retention_settings()


def cleanup_inactive_public_rooms() -> Dict[str, object]:
    settings = get_channel_retention_settings()
    auto_delete_days = int(settings["auto_delete_days"])
    if auto_delete_days <= 0:
        return {
            "deleted": 0,
            "rooms": [],
            "directory_active_days": int(settings.get("directory_active_days") or 30),
            "auto_delete_days": auto_delete_days,
        }

    with _conn() as con:
        rows = con.execute(
            """
            SELECT r.name
            FROM rooms r
            WHERE r.is_public=1
              AND COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.room_name = r.name), r.created_at)
                  < datetime('now', '-' || ? || ' days')
            """,
            (auto_delete_days,),
        ).fetchall()

    deleted_rooms: List[str] = []
    for row in rows:
        room_name = str(row["name"] or "").strip()
        if not room_name:
            continue
        if delete_room(room_name, requester_id=0, is_admin=True):
            deleted_rooms.append(room_name)
    return {
        "deleted": len(deleted_rooms),
        "rooms": deleted_rooms,
        "directory_active_days": int(settings.get("directory_active_days") or 30),
        "auto_delete_days": auto_delete_days,
    }


def save_push_subscription(user_id: int, endpoint: str, p256dh: str, auth_key: str):
    with _conn() as con:
        con.execute("""INSERT OR REPLACE INTO push_subscriptions
            (user_id, endpoint, p256dh, auth_key) VALUES (?,?,?,?)""",
            (user_id, endpoint, p256dh, auth_key))
        con.commit()


def get_push_subscriptions(user_id: int) -> List[Dict]:
    with _conn() as con:
        rows = con.execute(
            "SELECT endpoint, p256dh, auth_key FROM push_subscriptions WHERE user_id=?",
            (user_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def delete_push_subscription(endpoint: str):
    with _conn() as con:
        con.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))
        con.commit()


def _ensure_fcm_tokens_table(con):
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS fcm_tokens (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            token      TEXT NOT NULL UNIQUE,
            platform   TEXT NOT NULL DEFAULT 'android',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )


def save_fcm_token(user_id: int, token: str, platform: str = "android"):
    if not token:
        return
    with _conn() as con:
        _ensure_fcm_tokens_table(con)
        con.execute(
            """
            INSERT OR REPLACE INTO fcm_tokens (user_id, token, platform, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            """,
            (user_id, token, platform or "android"),
        )
        con.commit()


def get_fcm_tokens(user_id: int, platform: str | None = None) -> List[Dict]:
    with _conn() as con:
        _ensure_fcm_tokens_table(con)
        if platform:
            rows = con.execute(
                "SELECT token, platform FROM fcm_tokens WHERE user_id=? AND platform=?",
                (user_id, platform),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT token, platform FROM fcm_tokens WHERE user_id=?",
                (user_id,),
            ).fetchall()
    return [dict(r) for r in rows]


def delete_fcm_token(token: str):
    if not token:
        return
    with _conn() as con:
        _ensure_fcm_tokens_table(con)
        con.execute("DELETE FROM fcm_tokens WHERE token=?", (token,))
        con.commit()


def delete_user_fcm_tokens(user_id: int) -> int:
    """Drop every FCM/push token for a user. Used on logout so a stolen
    device token cannot keep receiving the user's push notifications
    after they've signed out."""
    if not user_id:
        return 0
    with _conn() as con:
        _ensure_fcm_tokens_table(con)
        cur = con.execute("DELETE FROM fcm_tokens WHERE user_id=?", (user_id,))
        con.commit()
        return int(cur.rowcount or 0)


# ── PIN-lock (privacy) ──────────────────────────────────────────────
# All PIN values flow through bcrypt. We deliberately use the same cost
# factor as the password hash so an attacker who exfiltrates the DB
# can't crack PINs faster than passwords. The PIN hash itself is never
# returned by any query exposed to the API layer (see get_user_by_token,
# which selects has_pin as a derived 0/1 flag instead of the hash).

# Lock-out policy. Tunable via env in case an operator wants stricter
# defaults; sane fallback is 5 attempts then 15 minutes lockout — that
# limits an online attacker to roughly 480 PIN guesses/day, vs the
# ~10⁴ - 10⁸ search space for a 4-8 digit PIN.
_PIN_MAX_ATTEMPTS = max(3, int(os.getenv("FROGTALK_PIN_MAX_ATTEMPTS", "5") or 5))
_PIN_LOCKOUT_MIN  = max(1, int(os.getenv("FROGTALK_PIN_LOCKOUT_MIN", "15") or 15))


def _pin_is_weak(pin: str) -> Optional[str]:
    """Return None if the PIN is acceptable, else a short reason.

    We block trivially-guessable patterns server-side so the policy can
    not be bypassed by a malicious client. The client mirrors the same
    rules for UX feedback but never gets to override them.
    """
    s = (pin or "").strip()
    if not s.isdigit():
        return "PIN must be digits only"
    if not (4 <= len(s) <= 8):
        return "PIN must be 4-8 digits"
    if len(set(s)) == 1:
        return "PIN cannot be all the same digit"
    # Strict ascending or descending sequence (1234, 4321, 12345, …).
    asc = all(int(s[i]) + 1 == int(s[i + 1]) for i in range(len(s) - 1))
    desc = all(int(s[i]) - 1 == int(s[i + 1]) for i in range(len(s) - 1))
    if asc or desc:
        return "PIN cannot be a simple sequence"
    # Reject the dozen most-common 4-digit PINs (covers ~25% of real
    # PIN choices per public datasets — Bonneau 2012 etc.).
    common = {"0000","1111","1212","2000","2222","2580","4321","5555",
              "6969","7777","8888","9999","1004","2004","2580","6666"}
    if len(s) == 4 and s in common:
        return "PIN is too common"
    return None


def _pin_lock_active(row) -> int:
    """Return seconds remaining on a PIN lockout (0 if not locked)."""
    if not row:
        return 0
    locked = (row["pin_locked_until"] or "").strip() if hasattr(row, "keys") else (row.get("pin_locked_until") or "").strip()
    if not locked:
        return 0
    try:
        # SQLite stores naive UTC; treat as such.
        from datetime import datetime as _dt, timezone as _tz
        dt = _dt.fromisoformat(locked.replace(" ", "T"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_tz.utc)
        now = _dt.now(tz=_tz.utc)
        remaining = int((dt - now).total_seconds())
        return max(0, remaining)
    except Exception:
        return 0


def get_pin_status(user_id: int) -> Dict:
    """Return PIN configuration flags for a user. Never includes the hash."""
    with _conn() as con:
        row = con.execute(
            """SELECT CASE WHEN pin_hash IS NULL OR pin_hash='' THEN 0 ELSE 1 END AS has_pin,
                      pin_require_on_unlock, pin_require_for_admin,
                      pin_require_after_autologin, pin_idle_timeout_sec,
                      pin_keypad_privacy,
                      pin_locked_until, pin_failed_attempts
                 FROM users WHERE id=?""",
            (user_id,),
        ).fetchone()
    if not row:
        return {"has_pin": 0}
    out = dict(row)
    out["pin_lock_remaining_sec"] = _pin_lock_active(row)
    # Don't leak attempt counter to the client — only whether locked.
    out.pop("pin_locked_until", None)
    out.pop("pin_failed_attempts", None)
    return out


def set_user_pin(user_id: int, current_password: str, new_pin: str) -> Dict:
    """Set or rotate the user's PIN. Requires current account password.

    Returns ``{"ok": True}`` on success or ``{"error": "..."}`` on
    failure. Resets the lockout counters.
    """
    weak = _pin_is_weak(new_pin)
    if weak:
        return {"error": weak}
    with _conn() as con:
        row = con.execute(
            "SELECT password_hash FROM users WHERE id=?", (user_id,)
        ).fetchone()
        if not row:
            return {"error": "User not found"}
        if not _bcrypt.checkpw((current_password or "").encode(), row["password_hash"].encode()):
            return {"error": "Incorrect password"}
        pin_hash = _bcrypt.hashpw(new_pin.encode(), _bcrypt.gensalt()).decode()
        con.execute(
            """UPDATE users
                  SET pin_hash=?, pin_failed_attempts=0, pin_locked_until=NULL
                WHERE id=?""",
            (pin_hash, user_id),
        )
        con.commit()
    return {"ok": True}


def disable_user_pin(user_id: int, current_password: str) -> Dict:
    """Remove the user's PIN. Requires current account password."""
    with _conn() as con:
        row = con.execute(
            "SELECT password_hash FROM users WHERE id=?", (user_id,)
        ).fetchone()
        if not row:
            return {"error": "User not found"}
        if not _bcrypt.checkpw((current_password or "").encode(), row["password_hash"].encode()):
            return {"error": "Incorrect password"}
        con.execute(
            """UPDATE users
                  SET pin_hash=NULL, pin_failed_attempts=0, pin_locked_until=NULL,
                      pin_require_on_unlock=1, pin_require_for_admin=1,
                      pin_require_after_autologin=1
                WHERE id=?""",
            (user_id,),
        )
        con.commit()
    return {"ok": True}


def verify_user_pin(user_id: int, pin: str) -> Dict:
    """Verify a PIN. On success returns ``{"ok": True}``; on failure
    returns ``{"error": "...", "remaining_attempts": N, "lock_seconds": S}``.

    Constant-time bcrypt compare. Increments failed-attempt counter
    and triggers lockout if the threshold is crossed.
    """
    with _conn() as con:
        row = con.execute(
            """SELECT pin_hash, pin_failed_attempts, pin_locked_until
                 FROM users WHERE id=?""",
            (user_id,),
        ).fetchone()
        if not row or not row["pin_hash"]:
            return {"error": "PIN not set"}
        # Honour any pre-existing lockout *before* doing the bcrypt
        # comparison — also denies the timing channel a successful
        # bcrypt would otherwise expose during lockout.
        lock_remaining = _pin_lock_active(row)
        if lock_remaining > 0:
            return {"error": "PIN locked", "lock_seconds": lock_remaining,
                    "remaining_attempts": 0}
        ok = False
        try:
            ok = _bcrypt.checkpw((pin or "").encode(), row["pin_hash"].encode())
        except Exception:
            ok = False
        if ok:
            con.execute(
                """UPDATE users
                      SET pin_failed_attempts=0, pin_locked_until=NULL
                    WHERE id=?""",
                (user_id,),
            )
            con.commit()
            return {"ok": True}
        attempts = int(row["pin_failed_attempts"] or 0) + 1
        if attempts >= _PIN_MAX_ATTEMPTS:
            # Trigger lockout window. We store an absolute UTC timestamp
            # (not a duration) so the lock survives process restarts.
            con.execute(
                """UPDATE users
                      SET pin_failed_attempts=?,
                          pin_locked_until=datetime('now', '+' || ? || ' minutes')
                    WHERE id=?""",
                (attempts, _PIN_LOCKOUT_MIN, user_id),
            )
            con.commit()
            return {"error": "PIN locked",
                    "lock_seconds": _PIN_LOCKOUT_MIN * 60,
                    "remaining_attempts": 0}
        con.execute(
            "UPDATE users SET pin_failed_attempts=? WHERE id=?",
            (attempts, user_id),
        )
        con.commit()
        return {"error": "Incorrect PIN",
                "remaining_attempts": max(0, _PIN_MAX_ATTEMPTS - attempts),
                "lock_seconds": 0}


def update_pin_options(
    user_id: int,
    require_on_unlock: Optional[bool] = None,
    require_for_admin: Optional[bool] = None,
    require_after_autologin: Optional[bool] = None,
    idle_timeout_sec: Optional[int] = None,
    keypad_privacy: Optional[bool] = None,
) -> bool:
    """Update PIN behaviour flags. Caller must have already verified
    the user owns a PIN; this function does not re-check (the route
    layer enforces that).
    """
    fields, values = [], []
    if require_on_unlock is not None:
        fields.append("pin_require_on_unlock=?")
        values.append(1 if require_on_unlock else 0)
    if require_for_admin is not None:
        fields.append("pin_require_for_admin=?")
        values.append(1 if require_for_admin else 0)
    if require_after_autologin is not None:
        fields.append("pin_require_after_autologin=?")
        values.append(1 if require_after_autologin else 0)
    if idle_timeout_sec is not None:
        # Bound the timeout: 0 (immediate) up to 24h. Anything weirder
        # is almost certainly a malformed client.
        t = max(0, min(86400, int(idle_timeout_sec)))
        fields.append("pin_idle_timeout_sec=?")
        values.append(t)
    if keypad_privacy is not None:
        fields.append("pin_keypad_privacy=?")
        values.append(1 if keypad_privacy else 0)
    if not fields:
        return False
    values.append(user_id)
    with _conn() as con:
        con.execute(f"UPDATE users SET {', '.join(fields)} WHERE id=?", values)
        con.commit()
    return True


def update_privacy(user_id: int, profile_public: bool, allow_friend_requests: bool):
    with _conn() as con:
        con.execute(
            "UPDATE users SET profile_public=?, allow_friend_requests=? WHERE id=?",
            (1 if profile_public else 0, 1 if allow_friend_requests else 0, user_id)
        )
        con.commit()


def update_presence(user_id: int, presence: str):
    allowed = {"online", "away", "dnd", "invisible"}
    if presence not in allowed:
        return
    with _conn() as con:
        con.execute("UPDATE users SET presence=?, last_seen=datetime('now') WHERE id=?",
                    (presence, user_id))
        con.commit()


def update_last_seen(user_id: int):
    with _conn() as con:
        con.execute("UPDATE users SET last_seen=datetime('now') WHERE id=?", (user_id,))
        con.commit()


def set_identity_pub_key(user_id: int, pub_key: str):
    with _conn() as con:
        con.execute("UPDATE users SET identity_pubkey=? WHERE id=?", (pub_key, user_id))
        con.commit()


def get_room_order(user_id: int) -> Optional[str]:
    """Return the user's saved channel ordering as a JSON string, or None."""
    with _conn() as con:
        row = con.execute("SELECT room_order FROM users WHERE id=?", (user_id,)).fetchone()
    return row["room_order"] if row and row["room_order"] else None


def set_room_order(user_id: int, order_json: str) -> None:
    with _conn() as con:
        con.execute("UPDATE users SET room_order=? WHERE id=?", (order_json, user_id))
        con.commit()


def get_identity_pub_key(user_id: int) -> Optional[str]:
    with _conn() as con:
        row = con.execute("SELECT identity_pubkey FROM users WHERE id=?", (user_id,)).fetchone()
    return row["identity_pubkey"] if row else None


def _get_identity_signing_secret() -> str:
    key = "federation.identity_signing_secret"
    secret = get_config(key)
    if secret:
        return secret
    secret = secrets.token_urlsafe(48)
    set_config(key, secret)
    return secret


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def build_signed_profile_claim(user_id: int, ttl_seconds: int = 3600) -> Optional[Dict]:
    """Create a compact signed profile claim for federation bootstrap.

    This is server-signed metadata proving current profile fields for a
    `global_user_id`. Clients/peers can verify with the server signing key
    distribution layer in later federation phases.
    """
    ident = get_user_identity(user_id)
    if not ident:
        return None

    now = int(time.time())
    local = get_or_create_local_server_identity()
    payload = {
        "v": 1,
        "type": "profile.claim",
        "iss": local["server_id"],
        "iat": now,
        "exp": now + max(60, int(ttl_seconds)),
        "sub": ident.get("global_user_id") or "",
        "nickname": ident.get("nickname") or "",
        "display_name": ident.get("display_name") or "",
        "avatar": ident.get("avatar") or "",
        "bio": ident.get("bio") or "",
        "identity_pubkey": ident.get("identity_pubkey") or "",
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    sig = hmac.new(_get_identity_signing_secret().encode(), canonical, hashlib.sha256).digest()
    return {
        "payload": payload,
        "signature": _b64url(sig),
        "alg": "HS256",
    }


def get_pubkey(user_id: int) -> Optional[str]:
    # Track H cleanup: the legacy ECDH pubkey column was dropped along
    # with v1 DM crypto. Callers should use the Signal bundle endpoints
    # instead. Returning None keeps any remaining call sites graceful.
    return None


def search_users(query: str, limit: int = 20, requester_id: int = 0) -> List[Dict]:
    """Search public profiles. Friends are visible regardless of privacy setting."""
    query = str(query or "").strip().lstrip("@")
    if not query:
        return []
    with _conn() as con:
        rows = con.execute(
            """SELECT u.id, u.nickname, u.display_name, u.avatar, u.bio, u.presence, u.last_seen,
                      u.profile_public, u.allow_friend_requests, u.status_msg, u.is_admin
               FROM users u
               WHERE u.nickname LIKE ?
                 AND (u.profile_public=1
                      OR u.id=?
                      OR EXISTS (
                          SELECT 1 FROM friends f
                          WHERE f.user_id=? AND f.friend_id=u.id AND f.status='accepted'
                      ))
               LIMIT ?""",
            (f"%{query}%", requester_id, requester_id, limit)
        ).fetchall()
    return [dict(r) for r in rows]


def get_user_profile(nickname: str) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute(
            """SELECT id, nickname, display_name, username_changed_at,
                      avatar, banner, bio, status_msg,
                      presence, last_seen, is_admin,
                      mood, custom_css, custom_style,
                      wall_enabled, wall_comments_enabled,
                      show_last_seen, show_read_receipts, profile_public,
                      created_at
               FROM users WHERE nickname=? COLLATE NOCASE""",
            (nickname,)
        ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["tags"] = [r["tag"] for r in con.execute(
            "SELECT tag FROM user_tags WHERE user_id=? ORDER BY tag", (d["id"],)
        ).fetchall()]
    return d

# Alias used by social.py
get_user_by_nick = get_user_profile


def get_nickname_history(user_id: int, limit: int = 10) -> List[Dict]:
    """Get previous nicknames for a user."""
    with _conn() as con:
        rows = con.execute(
            """SELECT old_nickname, changed_at FROM nickname_history
               WHERE user_id = ? ORDER BY changed_at DESC LIMIT ?""",
            (user_id, limit)
        ).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Tags helpers
# ---------------------------------------------------------------------------

def add_tag(user_id: int, tag: str) -> bool:
    tag = tag.strip().lower()[:32]
    if not tag:
        return False
    try:
        with _conn() as con:
            con.execute("INSERT INTO user_tags (user_id, tag) VALUES (?,?)", (user_id, tag))
            con.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def remove_tag(user_id: int, tag: str):
    with _conn() as con:
        con.execute("DELETE FROM user_tags WHERE user_id=? AND tag=?", (user_id, tag.strip().lower()))
        con.commit()


def get_tags(user_id: int) -> List[str]:
    with _conn() as con:
        rows = con.execute("SELECT tag FROM user_tags WHERE user_id=? ORDER BY tag", (user_id,)).fetchall()
    return [r["tag"] for r in rows]


# ---------------------------------------------------------------------------
# Friends helpers
# ---------------------------------------------------------------------------

def send_friend_request(from_id: int, to_id: int) -> str:
    """Returns 'ok', 'already', 'self', 'blocked'."""
    if from_id == to_id:
        return "self"
    # Hard block: either party has blocked the other via user_blocks
    if is_blocked_either_way(from_id, to_id):
        return "blocked"
    try:
        with _conn() as con:
            # Legacy blocked status on friends row (kept for backwards compat)
            blocked = con.execute(
                "SELECT status FROM friends WHERE user_id=? AND friend_id=? AND status='blocked'",
                (to_id, from_id)
            ).fetchone()
            if blocked:
                return "blocked"
            existing = con.execute(
                "SELECT status FROM friends WHERE user_id=? AND friend_id=?",
                (from_id, to_id)
            ).fetchone()
            if existing:
                return "already"
            con.execute(
                "INSERT INTO friends (user_id, friend_id, status) VALUES (?,?,'pending')",
                (from_id, to_id)
            )
            con.commit()
        return "ok"
    except sqlite3.IntegrityError:
        return "already"


def accept_friend_request(from_id: int, to_id: int) -> bool:
    """from_id sent the request, to_id is accepting."""
    with _conn() as con:
        row = con.execute(
            "SELECT id FROM friends WHERE user_id=? AND friend_id=? AND status='pending'",
            (from_id, to_id)
        ).fetchone()
        if not row:
            return False
        con.execute("UPDATE friends SET status='accepted' WHERE id=?", (row["id"],))
        # Create reverse row too so both can query
        try:
            con.execute(
                "INSERT INTO friends (user_id, friend_id, status) VALUES (?,?,'accepted')",
                (to_id, from_id)
            )
        except sqlite3.IntegrityError:
            con.execute(
                "UPDATE friends SET status='accepted' WHERE user_id=? AND friend_id=?",
                (to_id, from_id)
            )
        con.commit()
    return True


def decline_friend_request(from_id: int, to_id: int) -> bool:
    with _conn() as con:
        con.execute(
            "DELETE FROM friends WHERE user_id=? AND friend_id=? AND status='pending'",
            (from_id, to_id)
        )
        con.commit()
    return True


def remove_friend(user_id: int, friend_id: int):
    with _conn() as con:
        con.execute(
            "DELETE FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)",
            (user_id, friend_id, friend_id, user_id)
        )
        con.commit()


# Legacy friends-based block_user removed — superseded by the user_blocks table
# implementation further below. `db.block_user` now routes exclusively through
# the dedicated user_blocks table (see block_user near the bottom of this file).


def get_friends(user_id: int) -> List[Dict]:
    """All accepted friends with basic profile."""
    with _conn() as con:
        rows = con.execute("""
            SELECT u.id, u.nickname, u.display_name, u.avatar, u.presence, u.last_seen, u.status_msg, u.is_admin
            FROM friends f JOIN users u ON f.friend_id = u.id
            WHERE f.user_id=? AND f.status='accepted'
            ORDER BY u.nickname
        """, (user_id,)).fetchall()
    return [dict(r) for r in rows]


def get_friend_requests_in(user_id: int) -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT u.id, u.nickname, u.display_name, u.avatar, u.bio, u.is_admin, f.created_at
            FROM friends f JOIN users u ON f.user_id = u.id
            WHERE f.friend_id=? AND f.status='pending'
            ORDER BY f.created_at DESC
        """, (user_id,)).fetchall()
    return [dict(r) for r in rows]


def get_friend_requests_out(user_id: int) -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT u.id, u.nickname, u.display_name, u.avatar, u.bio, u.is_admin, f.created_at
            FROM friends f JOIN users u ON f.friend_id = u.id
            WHERE f.user_id=? AND f.status='pending'
            ORDER BY f.created_at DESC
        """, (user_id,)).fetchall()
    return [dict(r) for r in rows]


def are_friends(user_id: int, other_id: int) -> bool:
    with _conn() as con:
        row = con.execute(
            "SELECT id FROM friends WHERE user_id=? AND friend_id=? AND status='accepted'",
            (user_id, other_id)
        ).fetchone()
    return row is not None


def friend_request_status(from_id: int, to_id: int) -> str:
    """Returns 'friends', 'sent', 'received', or 'none'."""
    with _conn() as con:
        row = con.execute(
            "SELECT status FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)",
            (from_id, to_id, to_id, from_id)
        ).fetchone()
    if not row:
        return 'none'
    if row['status'] == 'accepted':
        return 'friends'
    # pending — check direction
    with _conn() as con:
        sent = con.execute(
            "SELECT id FROM friends WHERE user_id=? AND friend_id=? AND status='pending'",
            (from_id, to_id)
        ).fetchone()
    return 'sent' if sent else 'received'


def add_friend_sound_asset(owner_user_id: int, friend_user_id: int, kind: str,
                           filename: str, content_type: str, file_path: str,
                           file_size: int, is_active: int = 1) -> Dict:
    """Insert a new friend sound asset and optionally mark it active."""
    with _conn() as con:
        if is_active:
            con.execute(
                """
                UPDATE friend_sound_assets
                SET is_active=0, updated_at=datetime('now')
                WHERE owner_user_id=? AND friend_user_id=? AND kind=?
                """,
                (owner_user_id, friend_user_id, kind),
            )
        cur = con.execute(
            """
            INSERT INTO friend_sound_assets
                (owner_user_id, friend_user_id, kind, filename, content_type, file_path, file_size, is_active)
            VALUES (?,?,?,?,?,?,?,?)
            """,
            (owner_user_id, friend_user_id, kind, filename, content_type, file_path, int(file_size or 0), 1 if is_active else 0),
        )
        con.commit()
        row = con.execute(
            "SELECT * FROM friend_sound_assets WHERE id=?",
            (cur.lastrowid,),
        ).fetchone()
    return dict(row) if row else {}


def list_friend_sound_assets(owner_user_id: int, friend_user_id: int, kind: str) -> List[Dict]:
    with _conn() as con:
        rows = con.execute(
            """
            SELECT * FROM friend_sound_assets
            WHERE owner_user_id=? AND friend_user_id=? AND kind=?
            ORDER BY is_active DESC, created_at DESC, id DESC
            """,
            (owner_user_id, friend_user_id, kind),
        ).fetchall()
    return [dict(r) for r in rows]


def get_friend_sound_asset(owner_user_id: int, asset_id: int) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM friend_sound_assets WHERE id=? AND owner_user_id=?",
            (asset_id, owner_user_id),
        ).fetchone()
    return dict(row) if row else None


def get_active_friend_sound_asset(owner_user_id: int, friend_user_id: int, kind: str) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute(
            """
            SELECT * FROM friend_sound_assets
            WHERE owner_user_id=? AND friend_user_id=? AND kind=? AND is_active=1
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            """,
            (owner_user_id, friend_user_id, kind),
        ).fetchone()
    return dict(row) if row else None


def set_active_friend_sound_asset(owner_user_id: int, asset_id: int) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM friend_sound_assets WHERE id=? AND owner_user_id=?",
            (asset_id, owner_user_id),
        ).fetchone()
        if not row:
            return None
        con.execute(
            """
            UPDATE friend_sound_assets
            SET is_active=0, updated_at=datetime('now')
            WHERE owner_user_id=? AND friend_user_id=? AND kind=?
            """,
            (owner_user_id, row["friend_user_id"], row["kind"]),
        )
        con.execute(
            "UPDATE friend_sound_assets SET is_active=1, updated_at=datetime('now') WHERE id=?",
            (asset_id,),
        )
        con.commit()
        fresh = con.execute("SELECT * FROM friend_sound_assets WHERE id=?", (asset_id,)).fetchone()
    return dict(fresh) if fresh else None


def delete_friend_sound_asset(owner_user_id: int, asset_id: int) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM friend_sound_assets WHERE id=? AND owner_user_id=?",
            (asset_id, owner_user_id),
        ).fetchone()
        if not row:
            return None
        con.execute("DELETE FROM friend_sound_assets WHERE id=?", (asset_id,))
        con.commit()
    return dict(row)


# ---------------------------------------------------------------------------
# DM helpers
# ---------------------------------------------------------------------------

def dm_channel_exists(user_a: int, user_b: int) -> bool:
    """Check if a DM channel already exists between two users."""
    lo, hi = min(user_a, user_b), max(user_a, user_b)
    with _conn() as con:
        row = con.execute(
            "SELECT id FROM dm_channels WHERE MIN(user_a,user_b)=? AND MAX(user_a,user_b)=?",
            (lo, hi)
        ).fetchone()
        return row is not None


def get_user_dm_policy(user_id: int) -> str:
    """Get a user's DM policy setting."""
    with _conn() as con:
        row = con.execute("SELECT allow_dms_from FROM users WHERE id=?", (user_id,)).fetchone()
        return row["allow_dms_from"] if row else "everyone"


def get_or_create_dm(user_a: int, user_b: int) -> int:
    lo, hi = min(user_a, user_b), max(user_a, user_b)
    with _conn() as con:
        row = con.execute(
            "SELECT id FROM dm_channels WHERE MIN(user_a,user_b)=? AND MAX(user_a,user_b)=?",
            (lo, hi)
        ).fetchone()
        if row:
            return row["id"]
        cur = con.execute(
            "INSERT INTO dm_channels (user_a, user_b) VALUES (?,?)", (lo, hi)
        )
        con.commit()
        return cur.lastrowid


def get_dm_channels(user_id: int) -> List[Dict]:
    # Single query: pick latest visible message per channel via a window-style
    # MAX(id) join, and compute unread count in the same SELECT instead of
    # opening a new connection for every channel (was N+1 connections + 4
    # correlated subqueries per row, ~20-50ms × N for users with many DMs).
    with _conn() as con:
        rows = con.execute("""
            WITH last_msg AS (
                SELECT channel_id, MAX(id) AS last_id
                FROM dm_messages
                WHERE deleted=0
                GROUP BY channel_id
            )
            SELECT dc.id, dc.created_at,
                   dc.user_a, dc.user_b,
                   COALESCE(dc.last_read_a, 0) AS last_read_a,
                   COALESCE(dc.last_read_b, 0) AS last_read_b,
                   COALESCE(dc.forwarding_disabled, 0) AS forwarding_disabled,
                   u.id AS other_id, u.nickname AS other_nick,
                   u.avatar AS other_avatar, u.presence AS other_presence,
                   u.last_seen AS other_last_seen,
                   u.show_last_seen AS other_show_last_seen,
                   COALESCE(u.show_read_receipts, 1) AS other_show_read_receipts,
                   lm.last_id AS last_msg_id,
                   dm.content AS last_msg,
                   dm.created_at AS last_msg_at,
                   dm.sender_id AS last_sender_id,
                   (SELECT COUNT(*) FROM dm_messages x
                      WHERE x.channel_id=dc.id AND x.deleted=0
                        AND x.sender_id != ?
                        AND x.id > CASE WHEN dc.user_a=? THEN COALESCE(dc.last_read_a,0)
                                                        ELSE COALESCE(dc.last_read_b,0) END
                   ) AS unread
            FROM dm_channels dc
            JOIN users u ON u.id = CASE WHEN dc.user_a=? THEN dc.user_b ELSE dc.user_a END
            LEFT JOIN last_msg lm ON lm.channel_id=dc.id
            LEFT JOIN dm_messages dm ON dm.id = lm.last_id
            WHERE (dc.user_a=? OR dc.user_b=?)
              AND NOT (
                  (dc.user_a=? AND COALESCE(dc.hidden_by_a, 0)=1) OR
                  (dc.user_b=? AND COALESCE(dc.hidden_by_b, 0)=1)
              )
            ORDER BY last_msg_at DESC
        """, (user_id, user_id, user_id, user_id, user_id, user_id, user_id)).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        is_a = d["user_a"] == user_id
        my_read = d["last_read_a"] if is_a else d["last_read_b"]
        peer_read = d["last_read_b"] if is_a else d["last_read_a"]
        d["my_last_read"] = my_read
        d["peer_last_read"] = peer_read
        # Hide internal fields
        d.pop("user_a", None); d.pop("user_b", None)
        d.pop("last_read_a", None); d.pop("last_read_b", None)
        result.append(d)
    return result


def mark_dm_read(channel_id: int, user_id: int, up_to_msg_id: int) -> Tuple[bool, int, int]:
    """Mark messages in DM channel as read up to msg id. Returns (ok, peer_id, new_read_id)."""
    with _conn() as con:
        row = con.execute(
            "SELECT user_a, user_b, COALESCE(last_read_a,0) AS lra, COALESCE(last_read_b,0) AS lrb "
            "FROM dm_channels WHERE id=?",
            (channel_id,)
        ).fetchone()
        if not row:
            return False, 0, 0
        if user_id == row["user_a"]:
            if up_to_msg_id <= row["lra"]:
                return True, row["user_b"], row["lra"]
            con.execute("UPDATE dm_channels SET last_read_a=? WHERE id=?", (up_to_msg_id, channel_id))
            peer = row["user_b"]
        elif user_id == row["user_b"]:
            if up_to_msg_id <= row["lrb"]:
                return True, row["user_a"], row["lrb"]
            con.execute("UPDATE dm_channels SET last_read_b=? WHERE id=?", (up_to_msg_id, channel_id))
            peer = row["user_a"]
        else:
            return False, 0, 0
        con.commit()
        return True, peer, up_to_msg_id


def get_dm_peer_read(channel_id: int, user_id: int) -> int:
    """Return the peer's last_read pointer (for rendering seen ticks)."""
    with _conn() as con:
        row = con.execute(
            "SELECT user_a, user_b, COALESCE(last_read_a,0) AS lra, COALESCE(last_read_b,0) AS lrb "
            "FROM dm_channels WHERE id=?", (channel_id,)
        ).fetchone()
        if not row:
            return 0
        return row["lrb"] if user_id == row["user_a"] else row["lra"]


def get_privacy_last_seen(user_id: int, viewer_id: int) -> Optional[str]:
    """Return viewer-allowed last_seen string, or None if hidden."""
    with _conn() as con:
        row = con.execute(
            "SELECT last_seen, COALESCE(show_last_seen,'everyone') AS p FROM users WHERE id=?",
            (user_id,)
        ).fetchone()
    if not row:
        return None
    if user_id == viewer_id:
        return row["last_seen"]
    p = row["p"]
    if p == "nobody":
        return None
    if p == "friends":
        if not are_friends(user_id, viewer_id):
            return None
    return row["last_seen"]


def get_privacy_read_receipts(user_id: int) -> bool:
    with _conn() as con:
        row = con.execute("SELECT COALESCE(show_read_receipts,1) AS r FROM users WHERE id=?", (user_id,)).fetchone()
    return bool(row and row["r"])


def get_dm_messages(channel_id: int, user_id: int, limit: int = 50,
                    before_id: Optional[int] = None,
                    after_id: Optional[int] = None) -> Tuple[List[Dict], bool]:
    """Returns (messages, user_is_member)."""
    with _conn() as con:
        # Verify membership
        row = con.execute(
            "SELECT id FROM dm_channels WHERE id=? AND (user_a=? OR user_b=?)",
            (channel_id, user_id, user_id)
        ).fetchone()
        if not row:
            return [], False
        # NOTE: do NOT SELECT dm.media_data here. Histories with image/audio/
        # video attachments stored as base64 data URIs would otherwise return
        # several MB just to be stripped client-side. Use has_media flag
        # instead — the client lazy-loads media via /messages/<id>/media.
        if after_id:
            rows = con.execute("""
                SELECT dm.id, dm.sender_id, dm.content,
                       (dm.media_type IS NOT NULL AND dm.media_type != '') AS has_media,
                       dm.media_type, dm.media_name, dm.reply_to, dm.edited,
                       dm.deleted, dm.created_at, dm.media_blur, dm.view_once,
                       dm.forwarded_from,
                       COALESCE(dm.preview_suppressed, 0) AS preview_suppressed,
                       u.nickname AS sender_nick, u.avatar AS sender_avatar,
                       u.display_name AS sender_display_name,
                       u.is_admin AS sender_is_admin,
                       ru.nickname AS reply_nick,
                       substr(r.content,1,120) AS reply_content
                FROM dm_messages dm JOIN users u ON dm.sender_id=u.id
                LEFT JOIN dm_messages r ON r.id = dm.reply_to
                LEFT JOIN users ru ON ru.id = r.sender_id
                WHERE dm.channel_id=? AND dm.id > ? AND dm.deleted=0
                ORDER BY dm.id ASC LIMIT ?
            """, (channel_id, after_id, limit)).fetchall()
        elif before_id:
            rows = con.execute("""
                SELECT dm.id, dm.sender_id, dm.content,
                       (dm.media_type IS NOT NULL AND dm.media_type != '') AS has_media,
                       dm.media_type, dm.media_name, dm.reply_to, dm.edited,
                       dm.deleted, dm.created_at, dm.media_blur, dm.view_once,
                       dm.forwarded_from,
                       COALESCE(dm.preview_suppressed, 0) AS preview_suppressed,
                       u.nickname AS sender_nick, u.avatar AS sender_avatar,
                       u.display_name AS sender_display_name,
                       u.is_admin AS sender_is_admin,
                       ru.nickname AS reply_nick,
                       substr(r.content,1,120) AS reply_content
                FROM dm_messages dm JOIN users u ON dm.sender_id=u.id
                LEFT JOIN dm_messages r ON r.id = dm.reply_to
                LEFT JOIN users ru ON ru.id = r.sender_id
                WHERE dm.channel_id=? AND dm.id < ? AND dm.deleted=0
                ORDER BY dm.id DESC LIMIT ?
            """, (channel_id, before_id, limit)).fetchall()
        else:
            rows = con.execute("""
                SELECT dm.id, dm.sender_id, dm.content,
                       (dm.media_type IS NOT NULL AND dm.media_type != '') AS has_media,
                       dm.media_type, dm.media_name, dm.reply_to, dm.edited,
                       dm.deleted, dm.created_at, dm.media_blur, dm.view_once,
                       dm.forwarded_from,
                       COALESCE(dm.preview_suppressed, 0) AS preview_suppressed,
                       u.nickname AS sender_nick, u.avatar AS sender_avatar,
                       u.display_name AS sender_display_name,
                       u.is_admin AS sender_is_admin,
                       ru.nickname AS reply_nick,
                       substr(r.content,1,120) AS reply_content
                FROM dm_messages dm JOIN users u ON dm.sender_id=u.id
                LEFT JOIN dm_messages r ON r.id = dm.reply_to
                LEFT JOIN users ru ON ru.id = r.sender_id
                WHERE dm.channel_id=? AND dm.deleted=0
                ORDER BY dm.id DESC LIMIT ?
            """, (channel_id, limit)).fetchall()
    if after_id:
        return [dict(r) for r in rows], True
    return list(reversed([dict(r) for r in rows])), True


def send_dm_message(channel_id: int, sender_id: int, content: str,
                    media_data: Optional[str] = None, media_type: Optional[str] = None,
                    media_name: Optional[str] = None, reply_to: Optional[int] = None,
                    media_blur: int = 0, view_once: int = 0,
                    forwarded_from: Optional[str] = None) -> int:
    with _conn() as con:
        cur = con.execute(
            """INSERT INTO dm_messages
               (channel_id, sender_id, content, media_data, media_type, media_name, reply_to,
                media_blur, view_once, forwarded_from)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (channel_id, sender_id, content, media_data, media_type, media_name, reply_to,
             1 if media_blur else 0, 1 if view_once else 0, forwarded_from)
        )
        con.commit()
        msg_id = cur.lastrowid
    # Unhide channel for recipient so they see the new message
    unhide_dm_channel_for_recipient(channel_id, sender_id)
    return msg_id


def edit_dm_message(msg_id: int, user_id: int, new_content: str) -> bool:
    with _conn() as con:
        row = con.execute("SELECT sender_id FROM dm_messages WHERE id=?", (msg_id,)).fetchone()
        if not row or row["sender_id"] != user_id:
            return False
        con.execute("UPDATE dm_messages SET content=?, edited=1 WHERE id=?", (new_content, msg_id))
        con.commit()
    return True


def delete_dm_message(msg_id: int, user_id: int) -> bool:
    with _conn() as con:
        row = con.execute(
            "SELECT dm.sender_id, dc.user_a, dc.user_b "
            "FROM dm_messages dm JOIN dm_channels dc ON dm.channel_id=dc.id "
            "WHERE dm.id=?", (msg_id,)
        ).fetchone()
        if not row or user_id not in (row["user_a"], row["user_b"]):
            return False
        con.execute("UPDATE dm_messages SET deleted=1, content='[deleted]' WHERE id=?", (msg_id,))
        con.commit()
    return True


def set_dm_preview_suppressed(msg_id: int, user_id: int) -> Optional[int]:
    """Mark a DM message's link preview as suppressed.

    Only the original sender may suppress their own preview. Returns the
    channel_id on success (so the caller can route a WS broadcast), or None
    if not authorised / not found.
    """
    with _conn() as con:
        row = con.execute(
            "SELECT sender_id, channel_id FROM dm_messages WHERE id=?", (msg_id,)
        ).fetchone()
        if not row or row["sender_id"] != user_id:
            return None
        con.execute("UPDATE dm_messages SET preview_suppressed=1 WHERE id=?", (msg_id,))
        con.commit()
        return int(row["channel_id"])


# ---------------------------------------------------------------------------
# DM channel hide/unhide helpers
# ---------------------------------------------------------------------------

def hide_dm_channel(channel_id: int, user_id: int) -> bool:
    """Hide a DM channel from the user's sidebar. Returns True if successful."""
    with _conn() as con:
        row = con.execute(
            "SELECT user_a, user_b FROM dm_channels WHERE id=?",
            (channel_id,)
        ).fetchone()
        if not row:
            return False
        if row["user_a"] == user_id and row["user_b"] == user_id:
            con.execute("UPDATE dm_channels SET hidden_by_a=1, hidden_by_b=1 WHERE id=?", (channel_id,))
        elif row["user_a"] == user_id:
            con.execute("UPDATE dm_channels SET hidden_by_a=1 WHERE id=?", (channel_id,))
        elif row["user_b"] == user_id:
            con.execute("UPDATE dm_channels SET hidden_by_b=1 WHERE id=?", (channel_id,))
        else:
            return False
        con.commit()
    return True


def unhide_dm_channel(channel_id: int, user_id: int) -> bool:
    """Unhide a DM channel for a user. Returns True if successful."""
    with _conn() as con:
        row = con.execute(
            "SELECT user_a, user_b FROM dm_channels WHERE id=?",
            (channel_id,)
        ).fetchone()
        if not row:
            return False
        if row["user_a"] == user_id:
            con.execute("UPDATE dm_channels SET hidden_by_a=0 WHERE id=?", (channel_id,))
        elif row["user_b"] == user_id:
            con.execute("UPDATE dm_channels SET hidden_by_b=0 WHERE id=?", (channel_id,))
        else:
            return False
        con.commit()
    return True


def unhide_dm_channel_for_recipient(channel_id: int, sender_id: int) -> None:
    """Unhide channel for the OTHER user (recipient) when a message is sent."""
    with _conn() as con:
        row = con.execute(
            "SELECT user_a, user_b FROM dm_channels WHERE id=?",
            (channel_id,)
        ).fetchone()
        if not row:
            return
        # If sender is user_a, unhide for user_b; if sender is user_b, unhide for user_a
        if row["user_a"] == sender_id:
            con.execute("UPDATE dm_channels SET hidden_by_b=0 WHERE id=?", (channel_id,))
        elif row["user_b"] == sender_id:
            con.execute("UPDATE dm_channels SET hidden_by_a=0 WHERE id=?", (channel_id,))
        con.commit()


def wipe_dm_messages(channel_id: int, user_id: int) -> bool:
    """Delete all messages in a DM channel. Only channel members can do this."""
    with _conn() as con:
        row = con.execute(
            "SELECT id FROM dm_channels WHERE id=? AND (user_a=? OR user_b=?)",
            (channel_id, user_id, user_id)
        ).fetchone()
        if not row:
            return False
        con.execute("DELETE FROM dm_messages WHERE channel_id=?", (channel_id,))
        con.commit()
        return True


# ---------------------------------------------------------------------------
# Disappearing DM messages helpers
# ---------------------------------------------------------------------------

def set_dm_disappear_timer(channel_id: int, user_id: int, seconds: int) -> bool:
    """Set disappearing message timer for a DM channel. 0 = off. Only channel members can set."""
    with _conn() as con:
        row = con.execute(
            "SELECT id FROM dm_channels WHERE id=? AND (user_a=? OR user_b=?)",
            (channel_id, user_id, user_id)
        ).fetchone()
        if not row:
            return False
        con.execute("UPDATE dm_channels SET disappear_after=? WHERE id=?", (seconds, channel_id))
        con.commit()
    return True


def get_dm_disappear_timer(channel_id: int) -> int:
    """Get disappearing message timer for a DM channel in seconds. 0 = off."""
    with _conn() as con:
        row = con.execute(
            "SELECT disappear_after FROM dm_channels WHERE id=?",
            (channel_id,)
        ).fetchone()
    return row["disappear_after"] if row and row["disappear_after"] else 0


def cleanup_expired_dm_messages():
    """Delete DM messages that have expired based on channel's disappear_after setting."""
    with _conn() as con:
        # Get all channels with disappear_after > 0
        channels = con.execute(
            "SELECT id, disappear_after FROM dm_channels WHERE disappear_after > 0"
        ).fetchall()
        
        total_deleted = 0
        for ch in channels:
            seconds = ch["disappear_after"]
            # Delete messages older than disappear_after seconds
            cur = con.execute("""
                DELETE FROM dm_messages 
                WHERE channel_id = ? 
                AND datetime(created_at) < datetime('now', ?)
            """, (ch["id"], f'-{seconds} seconds'))
            total_deleted += cur.rowcount
        
        con.commit()
    return total_deleted


def get_dm_reactions_bulk(message_ids: List[int]) -> Dict[int, Dict[str, int]]:
    """Return {msg_id: {emoji: count}} for a batch of message IDs."""
    if not message_ids:
        return {}
    placeholders = ",".join("?" * len(message_ids))
    with _conn() as con:
        rows = con.execute(
            f"SELECT message_id, emoji, COUNT(*) as count FROM dm_reactions "
            f"WHERE message_id IN ({placeholders}) GROUP BY message_id, emoji",
            message_ids
        ).fetchall()
    result: Dict[int, Dict[str, int]] = {}
    for r in rows:
        result.setdefault(r["message_id"], {})[r["emoji"]] = r["count"]
    return result


def toggle_dm_reaction(msg_id: int, user_id: int, emoji: str) -> Dict:
    with _conn() as con:
        existing = con.execute(
            "SELECT id FROM dm_reactions WHERE message_id=? AND user_id=? AND emoji=?",
            (msg_id, user_id, emoji)
        ).fetchone()
        if existing:
            con.execute("DELETE FROM dm_reactions WHERE id=?", (existing["id"],))
        else:
            con.execute("INSERT INTO dm_reactions (message_id, user_id, emoji) VALUES (?,?,?)",
                        (msg_id, user_id, emoji))
        con.commit()
        rows = con.execute(
            "SELECT emoji, COUNT(*) as count FROM dm_reactions WHERE message_id=? GROUP BY emoji",
            (msg_id,)
        ).fetchall()
    return {r["emoji"]: r["count"] for r in rows}


# ---------------------------------------------------------------------------
# Calls helpers
# ---------------------------------------------------------------------------

def create_call(caller_id: int, callee_id: int, call_type: str,
                channel_id: Optional[int] = None) -> int:
    with _conn() as con:
        cur = con.execute(
            """INSERT INTO calls (caller_id, callee_id, call_type, channel_id, status)
               VALUES (?,?,?,?, 'ringing')""",
            (caller_id, callee_id, call_type, channel_id)
        )
        con.commit()
        return cur.lastrowid


def save_pending_call_offer(call_id: int, caller_id: int, callee_id: int,
                            from_nickname: str, from_avatar: Optional[str],
                            call_type: str, sdp: str,
                            fp_sig: Optional[str] = None):
    # `fp_sig` is the Track E signed-fingerprint blob — opaque base64
    # JSON the caller's client built and signed with its Signal identity
    # key. Server stores verbatim and replays it when the callee
    # cold-starts so the integrity check survives a push-wake.
    with _conn() as con:
        try:
            con.execute(
                """INSERT OR REPLACE INTO pending_call_offers
                   (call_id, caller_id, callee_id, from_nickname, from_avatar, call_type, sdp, fp_sig)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (call_id, caller_id, callee_id, from_nickname, from_avatar or "",
                 call_type, sdp, fp_sig or ""),
            )
        except sqlite3.OperationalError:
            # Pre-migration schema (no fp_sig column). Fall back so we
            # never block call setup on a stale DB.
            con.execute(
                """INSERT OR REPLACE INTO pending_call_offers
                   (call_id, caller_id, callee_id, from_nickname, from_avatar, call_type, sdp)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (call_id, caller_id, callee_id, from_nickname, from_avatar or "",
                 call_type, sdp),
            )
        con.commit()


def get_pending_call_offer(call_id: int, callee_id: int) -> Optional[Dict]:
    with _conn() as con:
        try:
            row = con.execute(
                """SELECT p.call_id, p.caller_id, p.callee_id, p.from_nickname, p.from_avatar,
                          p.call_type, p.sdp, COALESCE(p.fp_sig, '') AS fp_sig, c.status
                   FROM pending_call_offers p
                   JOIN calls c ON c.id = p.call_id
                   WHERE p.call_id=? AND p.callee_id=?""",
                (call_id, callee_id),
            ).fetchone()
        except sqlite3.OperationalError:
            row = con.execute(
                """SELECT p.call_id, p.caller_id, p.callee_id, p.from_nickname, p.from_avatar,
                          p.call_type, p.sdp, '' AS fp_sig, c.status
                   FROM pending_call_offers p
                   JOIN calls c ON c.id = p.call_id
                   WHERE p.call_id=? AND p.callee_id=?""",
                (call_id, callee_id),
            ).fetchone()
    return dict(row) if row else None


def get_latest_pending_call_offer(callee_id: int) -> Optional[Dict]:
    with _conn() as con:
        try:
            row = con.execute(
                """SELECT p.call_id, p.caller_id, p.callee_id, p.from_nickname, p.from_avatar,
                          p.call_type, p.sdp, COALESCE(p.fp_sig, '') AS fp_sig, c.status
                   FROM pending_call_offers p
                   JOIN calls c ON c.id = p.call_id
                   WHERE p.callee_id=? AND c.status='ringing'
                   ORDER BY p.call_id DESC
                   LIMIT 1""",
                (callee_id,),
            ).fetchone()
        except sqlite3.OperationalError:
            row = con.execute(
                """SELECT p.call_id, p.caller_id, p.callee_id, p.from_nickname, p.from_avatar,
                          p.call_type, p.sdp, '' AS fp_sig, c.status
                   FROM pending_call_offers p
                   JOIN calls c ON c.id = p.call_id
                   WHERE p.callee_id=? AND c.status='ringing'
                   ORDER BY p.call_id DESC
                   LIMIT 1""",
                (callee_id,),
            ).fetchone()
    return dict(row) if row else None


def delete_pending_call_offer(call_id: int):
    with _conn() as con:
        con.execute("DELETE FROM pending_call_offers WHERE call_id=?", (call_id,))
        con.commit()


def _ensure_pending_ice_table(con):
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS pending_ice_candidates (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            call_id     INTEGER NOT NULL,
            target_id   INTEGER NOT NULL,
            from_id     INTEGER NOT NULL,
            from_nick   TEXT    NOT NULL DEFAULT '',
            candidate   TEXT    NOT NULL,
            created_at  TEXT DEFAULT (datetime('now'))
        )
        """
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS idx_pending_ice_target ON pending_ice_candidates(target_id, call_id)"
    )


def queue_ice_candidate(call_id: int, target_id: int, from_id: int,
                        from_nick: str, candidate: str) -> None:
    """Buffer an ICE candidate addressed to a user who isn't currently on WS."""
    if not candidate:
        return
    with _conn() as con:
        _ensure_pending_ice_table(con)
        # Bound the buffer per (call_id, target_id) to avoid runaway growth on
        # a stuck peer; keep the most recent 64 candidates.
        con.execute(
            """INSERT INTO pending_ice_candidates
               (call_id, target_id, from_id, from_nick, candidate)
               VALUES (?, ?, ?, ?, ?)""",
            (int(call_id or 0), int(target_id), int(from_id), str(from_nick or ""), str(candidate)),
        )
        con.execute(
            """DELETE FROM pending_ice_candidates
               WHERE id IN (
                 SELECT id FROM pending_ice_candidates
                 WHERE target_id=? AND call_id=?
                 ORDER BY id DESC LIMIT -1 OFFSET 64
               )""",
            (int(target_id), int(call_id or 0)),
        )
        # Garbage-collect anything older than 60 seconds — ICE candidates are
        # useless past that point and we don't want stale rows fanning out.
        con.execute(
            "DELETE FROM pending_ice_candidates WHERE created_at < datetime('now', '-60 seconds')"
        )
        con.commit()


def drain_pending_ice_candidates(target_id: int) -> List[Dict]:
    """Pop and return every queued ICE candidate for this user, oldest first."""
    with _conn() as con:
        _ensure_pending_ice_table(con)
        rows = con.execute(
            """SELECT id, call_id, from_id, from_nick, candidate
               FROM pending_ice_candidates WHERE target_id=?
               ORDER BY id ASC""",
            (int(target_id),),
        ).fetchall()
        if rows:
            con.execute(
                "DELETE FROM pending_ice_candidates WHERE target_id=?",
                (int(target_id),),
            )
            con.commit()
    return [dict(r) for r in rows]


def _ensure_pending_call_signals_table(con):
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS pending_call_signals (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            call_id     INTEGER NOT NULL DEFAULT 0,
            target_id   INTEGER NOT NULL,
            from_id     INTEGER NOT NULL,
            from_nick   TEXT    NOT NULL DEFAULT '',
            kind        TEXT    NOT NULL,
            payload     TEXT    NOT NULL,
            created_at  TEXT DEFAULT (datetime('now'))
        )
        """
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS idx_pending_call_sig_target ON pending_call_signals(target_id)"
    )


def queue_call_signal(call_id: int, target_id: int, from_id: int,
                      from_nick: str, kind: str, payload: str) -> None:
    """Buffer a call control signal (call_end / call_reject) addressed to a
    user who isn't currently on WS. Bounded to the last 8 rows per target,
    GC'd after 5 minutes."""
    with _conn() as con:
        _ensure_pending_call_signals_table(con)
        con.execute(
            """INSERT INTO pending_call_signals
               (call_id, target_id, from_id, from_nick, kind, payload)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (int(call_id or 0), int(target_id), int(from_id),
             str(from_nick or ""), str(kind or ""), str(payload or "")),
        )
        con.execute(
            """DELETE FROM pending_call_signals
               WHERE id IN (
                 SELECT id FROM pending_call_signals
                 WHERE target_id=?
                 ORDER BY id DESC LIMIT -1 OFFSET 8
               )""",
            (int(target_id),),
        )
        con.execute(
            "DELETE FROM pending_call_signals WHERE created_at < datetime('now', '-5 minutes')"
        )
        con.commit()


def drain_pending_call_signals(target_id: int) -> List[Dict]:
    """Pop and return every queued call signal for this user, oldest first."""
    with _conn() as con:
        _ensure_pending_call_signals_table(con)
        rows = con.execute(
            """SELECT id, call_id, from_id, from_nick, kind, payload
               FROM pending_call_signals WHERE target_id=?
               ORDER BY id ASC""",
            (int(target_id),),
        ).fetchall()
        if rows:
            con.execute(
                "DELETE FROM pending_call_signals WHERE target_id=?",
                (int(target_id),),
            )
            con.commit()
    return [dict(r) for r in rows]


def has_recent_mobile_token(user_id: int, max_age_days: int = 30) -> bool:
    """True if the user has at least one FCM/APNs token updated within the
    last `max_age_days`. Used by the call-unreachable check so stale web-push
    subscriptions from uninstalled browsers don't keep the caller spinning."""
    with _conn() as con:
        _ensure_fcm_tokens_table(con)
        row = con.execute(
            f"""SELECT 1 FROM fcm_tokens
                WHERE user_id=? AND platform IN ('android','ios')
                  AND updated_at >= datetime('now', '-{int(max_age_days)} days')
                LIMIT 1""",
            (int(user_id),),
        ).fetchone()
    return bool(row)


def update_call_status(call_id: int, status: str, started_at: Optional[str] = None,
                       ended_at: Optional[str] = None):
    with _conn() as con:
        if started_at:
            con.execute("UPDATE calls SET status=?, started_at=? WHERE id=?",
                        (status, started_at, call_id))
        elif ended_at:
            con.execute("UPDATE calls SET status=?, ended_at=? WHERE id=?",
                        (status, ended_at, call_id))
        else:
            con.execute("UPDATE calls SET status=? WHERE id=?", (status, call_id))
        con.commit()


def get_call_history(user_id: int, limit: int = 50) -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT c.id, c.call_type, c.status, c.started_at, c.ended_at, c.created_at,
                   uc.nickname AS caller_nick, uc.avatar AS caller_avatar,
                   ue.nickname AS callee_nick, ue.avatar AS callee_avatar
            FROM calls c
            JOIN users uc ON c.caller_id=uc.id
            JOIN users ue ON c.callee_id=ue.id
            WHERE c.caller_id=? OR c.callee_id=?
            ORDER BY c.created_at DESC LIMIT ?
        """, (user_id, user_id, limit)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Pinned messages helpers
# ---------------------------------------------------------------------------

def pin_message(room_name: str, msg_id: int, user_id: int) -> bool:
    try:
        with _conn() as con:
            con.execute(
                "INSERT INTO pinned_messages (room_name, message_id, pinned_by) VALUES (?,?,?)",
                (room_name, msg_id, user_id)
            )
            con.execute("UPDATE messages SET pinned=1 WHERE id=?", (msg_id,))
            con.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def unpin_message(room_name: str, msg_id: int) -> bool:
    with _conn() as con:
        con.execute("DELETE FROM pinned_messages WHERE room_name=? AND message_id=?",
                    (room_name, msg_id))
        con.execute("UPDATE messages SET pinned=0 WHERE id=?", (msg_id,))
        con.commit()
    return True


def get_pinned_messages(room_name: str) -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT m.id, m.nickname, m.content, m.media_type, m.created_at,
                   p.pinned_at, pu.nickname AS pinned_by_nick
            FROM pinned_messages p
            JOIN messages m ON p.message_id=m.id
            JOIN users pu ON p.pinned_by=pu.id
            WHERE p.room_name=?
            ORDER BY p.pinned_at DESC
        """, (room_name,)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Room settings & moderation helpers
# ---------------------------------------------------------------------------

def get_room_by_name(room_name: str) -> Optional[Dict]:
    """Get room details by name."""
    with _conn() as con:
        row = con.execute("""
            SELECT r.id, r.name, r.description, r.type, r.icon, r.slowmode, 
                   r.owner_id, r.room_key_hint, r.channel_type, r.channel_theme, r.created_at,
                   r.invite_only, r.who_can_invite,
                   r.is_public, r.category, r.tags, r.directory_description,
                   (SELECT COUNT(*) FROM room_members WHERE room_id=r.id) AS member_count,
                   r.banner, r.about, r.dj_only_queue, r.forwarding_disabled,
                   r.vanity,
                   u.nickname AS owner_nickname
            FROM rooms r LEFT JOIN users u ON r.owner_id = u.id
            WHERE r.name = ?
        """, (room_name,)).fetchone()
    return dict(row) if row else None

# Alias used by directory.py, bots.py, external_api.py
get_room = get_room_by_name


def update_room_settings(room_name: str, **kwargs) -> bool:
    """Update room settings. Accepts: name, description, icon, slowmode, channel_type, channel_theme, invite_only, who_can_invite, is_public, category, tags, directory_description."""
    valid_cols = {'name', 'description', 'icon', 'slowmode', 'channel_type', 'channel_theme', 'invite_only', 'who_can_invite', 'is_public', 'category', 'tags', 'directory_description', 'banner', 'about', 'forwarding_disabled'}
    updates = {k: v for k, v in kwargs.items() if k in valid_cols and v is not None}
    if not updates:
        return False
    set_clause = ", ".join(f"{k}=?" for k in updates)
    values = list(updates.values()) + [room_name]
    try:
        with _conn() as con:
            con.execute(f"UPDATE rooms SET {set_clause} WHERE name=?", values)
            con.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def add_room_moderator(room_id: int, user_id: int, added_by: int) -> bool:
    """Add a moderator to a room."""
    try:
        with _conn() as con:
            con.execute(
                "INSERT INTO room_moderators (room_id, user_id, added_by) VALUES (?,?,?)",
                (room_id, user_id, added_by)
            )
            con.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def remove_room_moderator(room_id: int, user_id: int) -> bool:
    """Remove a moderator from a room."""
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM room_moderators WHERE room_id=? AND user_id=?",
            (room_id, user_id)
        )
        con.commit()
    return cur.rowcount > 0


def get_room_moderators(room_id: int) -> List[Dict]:
    """Get all moderators for a room."""
    with _conn() as con:
        rows = con.execute("""
            SELECT m.user_id, u.nickname, u.avatar, m.added_at
            FROM room_moderators m
            JOIN users u ON m.user_id = u.id
            WHERE m.room_id = ?
        """, (room_id,)).fetchall()
    return [dict(r) for r in rows]


def is_room_moderator(room_name: str, user_id: int) -> bool:
    """Check if user is a moderator (or owner/admin) for a room."""
    with _conn() as con:
        row = con.execute("""
            SELECT 1 FROM rooms r
            LEFT JOIN room_moderators m ON r.id = m.room_id AND m.user_id = ?
            WHERE r.name = ? AND (r.owner_id = ? OR m.user_id IS NOT NULL)
        """, (user_id, room_name, user_id)).fetchone()
    return row is not None


def can_moderate_room(room_name: str, user_id: int, is_admin: bool) -> bool:
    """Check if user can moderate a room (owner, mod, or admin)."""
    if is_admin:
        return True
    return is_room_moderator(room_name, user_id)


# ---------------------------------------------------------------------------
# Room ban helpers
# ---------------------------------------------------------------------------

def ban_user_from_room(room_id: int, user_id: int, banned_by: int, 
                       reason: str = "", duration_minutes: Optional[int] = None) -> bool:
    """Ban a user from a room. Duration None = permanent."""
    expires = None
    if duration_minutes:
        expires = (datetime.utcnow() + timedelta(minutes=duration_minutes)).isoformat()
    try:
        with _conn() as con:
            con.execute("""
                INSERT OR REPLACE INTO room_bans (room_id, user_id, banned_by, reason, expires_at)
                VALUES (?,?,?,?,?)
            """, (room_id, user_id, banned_by, reason, expires))
            con.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def unban_user_from_room(room_id: int, user_id: int) -> bool:
    """Unban a user from a room."""
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM room_bans WHERE room_id=? AND user_id=?",
            (room_id, user_id)
        )
        con.commit()
    return cur.rowcount > 0


def is_user_banned_from_room(room_name: str, user_id: int) -> bool:
    """Check if user is banned from a room (and ban hasn't expired)."""
    with _conn() as con:
        row = con.execute("""
            SELECT b.expires_at FROM room_bans b
            JOIN rooms r ON b.room_id = r.id
            WHERE r.name = ? AND b.user_id = ?
            AND (b.expires_at IS NULL OR b.expires_at > datetime('now'))
        """, (room_name, user_id)).fetchone()
    return row is not None


def user_can_access_room(user_id: int, room_name: str, *, is_admin: bool = False) -> bool:
    """Authoritative check: can `user_id` read messages from `room_name`?

    Admin always allowed. Otherwise: room must exist, user must not be
    currently banned, and (a) room is not invite_only, OR (b) user is the
    owner / a member of the room.
    """
    if not room_name:
        return False
    with _conn() as con:
        room = con.execute(
            "SELECT id, owner_id, COALESCE(invite_only,0) AS invite_only FROM rooms WHERE name=?",
            (room_name,),
        ).fetchone()
        if not room:
            return False
        if is_admin:
            return True
        ban = con.execute(
            """SELECT 1 FROM room_bans
               WHERE room_id=? AND user_id=?
                 AND (expires_at IS NULL OR expires_at > datetime('now'))""",
            (room["id"], user_id),
        ).fetchone()
        if ban:
            return False
        if not int(room["invite_only"] or 0):
            return True
        if int(room["owner_id"] or 0) == int(user_id):
            return True
        member = con.execute(
            "SELECT 1 FROM room_members WHERE room_id=? AND user_id=?",
            (room["id"], user_id),
        ).fetchone()
        return member is not None


def get_room_bans(room_id: int) -> List[Dict]:
    """Get all bans for a room."""
    with _conn() as con:
        rows = con.execute("""
            SELECT b.user_id, u.nickname, b.reason, b.expires_at, b.created_at,
                   bu.nickname AS banned_by_nick
            FROM room_bans b
            JOIN users u ON b.user_id = u.id
            JOIN users bu ON b.banned_by = bu.id
            WHERE b.room_id = ?
        """, (room_id,)).fetchall()
    return [dict(r) for r in rows]


def get_user_room_bans(user_id: int) -> List[Dict]:
    """Get every room a user is currently banned from (only for still-existing rooms)."""
    with _conn() as con:
        rows = con.execute("""
            SELECT r.name AS room_name, r.icon AS room_icon,
                   b.reason, b.expires_at, b.created_at,
                   bu.nickname AS banned_by_nick
            FROM room_bans b
            JOIN rooms r ON b.room_id = r.id
            LEFT JOIN users bu ON b.banned_by = bu.id
            WHERE b.user_id = ?
              AND (b.expires_at IS NULL OR b.expires_at > datetime('now'))
            ORDER BY b.created_at DESC
        """, (user_id,)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Global admin ban/mute helpers
# ---------------------------------------------------------------------------

def global_ban_user(user_id: int, banned_by: int, reason: str = "", 
                    duration_minutes: Optional[int] = None) -> bool:
    """Globally ban a user. Duration None = permanent."""
    expires = None
    if duration_minutes:
        expires = (datetime.utcnow() + timedelta(minutes=duration_minutes)).isoformat()
    try:
        with _conn() as con:
            con.execute("""
                INSERT OR REPLACE INTO global_bans (user_id, banned_by, reason, expires_at)
                VALUES (?,?,?,?)
            """, (user_id, banned_by, reason, expires))
            con.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def global_unban_user(user_id: int) -> bool:
    """Remove global ban from a user."""
    with _conn() as con:
        cur = con.execute("DELETE FROM global_bans WHERE user_id=?", (user_id,))
        con.commit()
    return cur.rowcount > 0


def is_user_globally_banned(user_id: int) -> bool:
    """Check if user is globally banned."""
    with _conn() as con:
        row = con.execute("""
            SELECT expires_at FROM global_bans WHERE user_id=?
            AND (expires_at IS NULL OR expires_at > datetime('now'))
        """, (user_id,)).fetchone()
    return row is not None


def global_mute_user(user_id: int, muted_by: int, reason: str = "",
                     duration_minutes: int = 60) -> bool:
    """Globally mute a user for a duration."""
    expires = (datetime.utcnow() + timedelta(minutes=duration_minutes)).isoformat()
    try:
        with _conn() as con:
            con.execute("""
                INSERT OR REPLACE INTO global_mutes (user_id, muted_by, reason, expires_at)
                VALUES (?,?,?,?)
            """, (user_id, muted_by, reason, expires))
            con.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def global_unmute_user(user_id: int) -> bool:
    """Remove global mute from a user."""
    with _conn() as con:
        cur = con.execute("DELETE FROM global_mutes WHERE user_id=?", (user_id,))
        con.commit()
    return cur.rowcount > 0


def is_user_globally_muted(user_id: int) -> bool:
    """Check if user is globally muted."""
    with _conn() as con:
        row = con.execute("""
            SELECT expires_at FROM global_mutes WHERE user_id=?
            AND (expires_at IS NULL OR expires_at > datetime('now'))
        """, (user_id,)).fetchone()
    return row is not None


def get_user_id_by_nickname(nickname: str) -> Optional[int]:
    """Get user ID by nickname."""
    with _conn() as con:
        row = con.execute("SELECT id FROM users WHERE nickname=?", (nickname,)).fetchone()
    return row["id"] if row else None


# ---------------------------------------------------------------------------
# User block helpers
# ---------------------------------------------------------------------------

def block_user(blocker_id: int, blocked_id: int) -> bool:
    """Block a user. Also severs existing friendship, cancels pending
    requests, drops follow relationships and closes DM read receipts so
    the block is a clean break on both sides."""
    if blocker_id == blocked_id:
        return False
    try:
        with _conn() as con:
            con.execute(
                "INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?,?)",
                (blocker_id, blocked_id)
            )
            # Remove any friend rows (either direction, any status)
            con.execute(
                "DELETE FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)",
                (blocker_id, blocked_id, blocked_id, blocker_id)
            )
            # Remove follow relationships (either direction)
            try:
                con.execute(
                    "DELETE FROM followers WHERE (follower_id=? AND following_id=?) OR (follower_id=? AND following_id=?)",
                    (blocker_id, blocked_id, blocked_id, blocker_id)
                )
            except sqlite3.OperationalError:
                pass  # followers table may not exist in older schemas
            con.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def unblock_user(blocker_id: int, blocked_id: int) -> bool:
    """Unblock a user."""
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM user_blocks WHERE blocker_id=? AND blocked_id=?",
            (blocker_id, blocked_id)
        )
        con.commit()
    return cur.rowcount > 0


def is_blocked(blocker_id: int, blocked_id: int) -> bool:
    """Check if blocker has blocked blocked_id."""
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM user_blocks WHERE blocker_id=? AND blocked_id=?",
            (blocker_id, blocked_id)
        ).fetchone()
    return row is not None


def is_blocked_either_way(a_id: int, b_id: int) -> bool:
    """True if either user has blocked the other."""
    if a_id == b_id:
        return False
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM user_blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?) LIMIT 1",
            (a_id, b_id, b_id, a_id)
        ).fetchone()
    return row is not None


def get_blocked_user_id_set(user_id: int) -> set:
    """Set of user_ids that are blocked by user_id OR have blocked user_id.
    Used to hide content from blocked parties in either direction."""
    with _conn() as con:
        rows = con.execute(
            "SELECT blocked_id AS uid FROM user_blocks WHERE blocker_id=? "
            "UNION SELECT blocker_id AS uid FROM user_blocks WHERE blocked_id=?",
            (user_id, user_id)
        ).fetchall()
    return {r["uid"] for r in rows}


def get_blocked_users(user_id: int) -> List[Dict]:
    """Get all users blocked by this user."""
    with _conn() as con:
        rows = con.execute("""
            SELECT b.blocked_id AS user_id, u.nickname, u.avatar, b.created_at
            FROM user_blocks b
            JOIN users u ON b.blocked_id = u.id
            WHERE b.blocker_id = ?
        """, (user_id,)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Custom emoji helpers
# ---------------------------------------------------------------------------

def add_custom_emoji(name: str, image_data: str, uploaded_by: int, is_global: bool = False) -> Optional[int]:
    """Add a custom emoji. Returns emoji ID or None if name taken."""
    try:
        with _conn() as con:
            cur = con.execute(
                "INSERT INTO custom_emojis (name, image_data, uploaded_by, is_global) VALUES (?,?,?,?)",
                (name, image_data, uploaded_by, 1 if is_global else 0)
            )
            con.commit()
            return cur.lastrowid
    except sqlite3.IntegrityError:
        return None


def delete_custom_emoji(emoji_id: int, user_id: int, is_admin: bool) -> bool:
    """Delete a custom emoji. Only uploader or admin can delete."""
    with _conn() as con:
        if is_admin:
            cur = con.execute("DELETE FROM custom_emojis WHERE id=?", (emoji_id,))
        else:
            cur = con.execute(
                "DELETE FROM custom_emojis WHERE id=? AND uploaded_by=?",
                (emoji_id, user_id)
            )
        con.commit()
    return cur.rowcount > 0


def get_custom_emojis() -> List[Dict]:
    """Get all custom emojis."""
    with _conn() as con:
        rows = con.execute("""
            SELECT e.id, e.name, e.image_data, e.is_global, e.created_at,
                   u.nickname AS uploaded_by_nick
            FROM custom_emojis e
            JOIN users u ON e.uploaded_by = u.id
            ORDER BY e.created_at DESC
        """).fetchall()
    return [dict(r) for r in rows]


def get_custom_emoji_by_name(name: str) -> Optional[Dict]:
    """Get a custom emoji by name."""
    with _conn() as con:
        row = con.execute(
            "SELECT id, name, image_data, is_global FROM custom_emojis WHERE name=?",
            (name,)
        ).fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Message search helpers
# ---------------------------------------------------------------------------

def search_room_messages(room_name: str, query: str, limit: int = 50) -> List[Dict]:
    """Search messages in a room by content."""
    with _conn() as con:
        rows = con.execute("""
            SELECT m.id, m.room_name, m.nickname, m.content, m.media_type,
                   m.edited, m.created_at, u.avatar
            FROM messages m
            LEFT JOIN users u ON m.user_id = u.id
            WHERE m.room_name=? AND m.content LIKE ?
            ORDER BY m.created_at DESC
            LIMIT ?
        """, (room_name, f'%{query}%', limit)).fetchall()
    return [dict(r) for r in rows]


def search_dm_messages(channel_id: int, user_id: int, query: str, limit: int = 50) -> List[Dict]:
    """Search messages in a DM channel."""
    with _conn() as con:
        # Verify user is participant
        ch = con.execute(
            "SELECT id FROM dm_channels WHERE id=? AND (user_a=? OR user_b=?)",
            (channel_id, user_id, user_id)
        ).fetchone()
        if not ch:
            return []
        rows = con.execute("""
            SELECT m.id, m.channel_id, m.sender_id, m.content, m.media_type,
                   m.edited, m.deleted, m.created_at, u.nickname AS sender_nick, u.avatar
            FROM dm_messages m
            JOIN users u ON m.sender_id = u.id
            WHERE m.channel_id=? AND m.deleted=0 AND m.content LIKE ?
            ORDER BY m.created_at DESC
            LIMIT ?
        """, (channel_id, f'%{query}%', limit)).fetchall()
    return [dict(r) for r in rows]


def search_all_messages(user_id: int, query: str, limit: int = 50) -> Dict:
    """Global search across all accessible rooms and DMs."""
    results = {"rooms": [], "dms": []}
    with _conn() as con:
        # Search room messages — restrict to rooms the user can actually
        # access: public rooms, or invite_only rooms where the user is a
        # member or owner. Excludes rooms where the user is currently banned.
        room_rows = con.execute("""
            SELECT m.id, m.room_name, m.nickname, m.content, m.media_type,
                   m.created_at, u.avatar
            FROM messages m
            JOIN rooms r ON r.name = m.room_name
            LEFT JOIN users u ON m.user_id = u.id
            WHERE m.content LIKE ?
              AND NOT EXISTS (
                  SELECT 1 FROM room_bans b
                  WHERE b.room_id = r.id AND b.user_id = ?
                    AND (b.expires_at IS NULL OR b.expires_at > datetime('now'))
              )
              AND (
                  COALESCE(r.invite_only, 0) = 0
                  OR r.owner_id = ?
                  OR EXISTS (
                      SELECT 1 FROM room_members rm
                      WHERE rm.room_id = r.id AND rm.user_id = ?
                  )
              )
            ORDER BY m.created_at DESC
            LIMIT ?
        """, (f'%{query}%', user_id, user_id, user_id, limit)).fetchall()
        results["rooms"] = [dict(r) for r in room_rows]
        
        # Search DM messages the user has access to
        dm_rows = con.execute("""
            SELECT m.id, m.channel_id, m.content, m.media_type, m.created_at,
                   s.nickname AS sender_nick, s.avatar,
                   CASE WHEN c.user_a=? THEN ub.nickname ELSE ua.nickname END AS peer_nick
            FROM dm_messages m
            JOIN dm_channels c ON m.channel_id = c.id
            JOIN users s ON m.sender_id = s.id
            JOIN users ua ON c.user_a = ua.id
            JOIN users ub ON c.user_b = ub.id
            WHERE (c.user_a=? OR c.user_b=?) 
              AND m.deleted=0 
              AND m.content LIKE ?
            ORDER BY m.created_at DESC
            LIMIT ?
        """, (user_id, user_id, user_id, f'%{query}%', limit)).fetchall()
        results["dms"] = [dict(r) for r in dm_rows]
    return results


# ---------------------------------------------------------------------------
# Room members for @mention
# ---------------------------------------------------------------------------

def get_room_members(room_id: Optional[int] = None) -> List[Dict]:
    """Get users for @mention autocomplete.

    If ``room_id`` is provided, only members of that room are returned.
    Otherwise, all users are returned (legacy behavior).
    """
    with _conn() as con:
        if room_id:
            rows = con.execute("""
                SELECT u.id, u.nickname, u.avatar, u.presence, u.display_name
                FROM room_members rm
                JOIN users u ON u.id = rm.user_id
                WHERE rm.room_id = ?
                ORDER BY u.nickname COLLATE NOCASE
            """, (room_id,)).fetchall()
        else:
            rows = con.execute("""
                SELECT id, nickname, avatar, presence, display_name
                FROM users
                ORDER BY nickname
            """).fetchall()
    return [dict(r) for r in rows]


def get_channel_members(room_id: int) -> List[Dict]:
    """Return every joined member of a room with presence + last_seen so the
    sidebar can split them into online vs offline sections."""
    with _conn() as con:
        rows = con.execute("""
            SELECT u.id AS user_id, u.nickname, u.avatar, u.is_admin,
                   u.presence, u.last_seen, u.display_name
            FROM room_members rm
            JOIN users u ON u.id = rm.user_id
            WHERE rm.room_id = ?
            ORDER BY u.nickname COLLATE NOCASE
        """, (room_id,)).fetchall()
    return [dict(r) for r in rows]


# ===========================================================================
# PHASE 5 — API Keys & Bots
# ===========================================================================

def create_api_key(user_id: int, name: str, key_hash: str, permissions: List[str]) -> int:
    """Create an API key for a user."""
    import json
    with _conn() as con:
        cur = con.execute("""
            INSERT INTO api_keys (user_id, key_hash, name, permissions)
            VALUES (?, ?, ?, ?)
        """, (user_id, key_hash, name, json.dumps(permissions)))
        return cur.lastrowid


def get_user_api_keys(user_id: int) -> List[Dict]:
    """Get all API keys for a user."""
    with _conn() as con:
        rows = con.execute("""
            SELECT id, name, permissions, last_used, created_at
            FROM api_keys WHERE user_id=?
            ORDER BY created_at DESC
        """, (user_id,)).fetchall()
    return [dict(r) for r in rows]


def delete_api_key(key_id: int, user_id: int) -> bool:
    """Delete an API key."""
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM api_keys WHERE id=? AND user_id=?",
            (key_id, user_id)
        )
        return cur.rowcount > 0


def get_api_key_by_hash(key_hash: str) -> Optional[Dict]:
    """Get API key details by hash."""
    with _conn() as con:
        row = con.execute("""
            SELECT id, user_id, name, permissions, last_used, created_at
            FROM api_keys
            WHERE key_hash=?
        """, (key_hash,)).fetchone()
        return dict(row) if row else None


def update_api_key_last_used(key_id: int):
    """Update last_used timestamp for an API key."""
    with _conn() as con:
        con.execute(
            "UPDATE api_keys SET last_used=datetime('now') WHERE id=?",
            (key_id,)
        )


def verify_api_key(key_hash: str) -> Optional[Dict]:
    """Verify API key and return user info."""
    with _conn() as con:
        row = con.execute("""
            SELECT ak.id, ak.user_id, ak.permissions, u.nickname
            FROM api_keys ak
            JOIN users u ON ak.user_id = u.id
            WHERE ak.key_hash=?
        """, (key_hash,)).fetchone()
        if row:
            con.execute(
                "UPDATE api_keys SET last_used=datetime('now') WHERE id=?",
                (row['id'],)
            )
        return dict(row) if row else None


def create_bot(owner_id: int, name: str, api_key_id: int, avatar: str = None,
               description: str = '', is_public: int = 0) -> Optional[int]:
    """Create a bot account."""
    with _conn() as con:
        try:
            cur = con.execute("""
                INSERT INTO bots (owner_id, name, api_key_id, avatar, description, is_public)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (owner_id, name, api_key_id, avatar, description, is_public))
            return cur.lastrowid
        except:
            return None


def get_user_bots(user_id: int) -> List[Dict]:
    """Get all bots owned by a user."""
    with _conn() as con:
        rows = con.execute("""
            SELECT id, name, avatar, description, is_public, created_at
            FROM bots WHERE owner_id=?
            ORDER BY created_at DESC
        """, (user_id,)).fetchall()
    return [dict(r) for r in rows]


def get_bot_by_id(bot_id: int) -> Optional[Dict]:
    """Get bot by ID."""
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM bots WHERE id=?", (bot_id,)
        ).fetchone()
    return dict(row) if row else None


def get_bot_by_api_key_id(api_key_id: int) -> Optional[Dict]:
    """Get bot by its linked API key id. Used by the external API to map
    an authenticated bot_… key back to the bot's display identity
    (name, avatar) when posting messages."""
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM bots WHERE api_key_id=?", (api_key_id,)
        ).fetchone()
    return dict(row) if row else None


def update_bot(bot_id: int, owner_id: int, **kwargs) -> bool:
    """Update bot details."""
    allowed = {'name', 'avatar', 'description', 'is_public'}
    updates = {k: v for k, v in kwargs.items() if k in allowed}
    if not updates:
        return False
    set_clause = ', '.join(f'{k}=?' for k in updates)
    with _conn() as con:
        cur = con.execute(
            f"UPDATE bots SET {set_clause} WHERE id=? AND owner_id=?",
            (*updates.values(), bot_id, owner_id)
        )
        return cur.rowcount > 0


def delete_bot(bot_id: int, owner_id: int) -> bool:
    """Delete a bot."""
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM bots WHERE id=? AND owner_id=?",
            (bot_id, owner_id)
        )
        return cur.rowcount > 0


def rotate_bot_api_key(bot_id: int, owner_id: int, new_key_hash: str) -> Optional[int]:
    """Atomically replace the api_keys row attached to a bot.

    Returns the new key id, or None if the bot doesn't exist / isn't
    owned by `owner_id`. The old api_keys row is hard-deleted so the
    previous raw token stops authenticating immediately — callers MUST
    surface the new raw token to the user (it's the only time they'll
    see it).

    Done in a single transaction so we never end up with a bot whose
    api_key_id points at a deleted row."""
    import json
    with _conn() as con:
        row = con.execute(
            "SELECT api_key_id, name FROM bots WHERE id=? AND owner_id=?",
            (bot_id, owner_id),
        ).fetchone()
        if not row:
            return None
        old_key_id = row["api_key_id"]
        bot_name = row["name"]
        # Preserve original permissions so the new key keeps whatever
        # scopes were granted (bots default to read/write/dm/bot).
        perms_row = con.execute(
            "SELECT permissions FROM api_keys WHERE id=?", (old_key_id,)
        ).fetchone()
        perms_json = perms_row["permissions"] if perms_row else json.dumps(
            ["read", "write", "dm", "bot"]
        )
        cur = con.execute(
            "INSERT INTO api_keys (user_id, key_hash, name, permissions) VALUES (?, ?, ?, ?)",
            (owner_id, new_key_hash, f"Bot: {bot_name}", perms_json),
        )
        new_key_id = cur.lastrowid
        con.execute(
            "UPDATE bots SET api_key_id=? WHERE id=? AND owner_id=?",
            (new_key_id, bot_id, owner_id),
        )
        # Drop the old key row last so a partial failure above never
        # leaves the bot pointing at nothing.
        if old_key_id:
            con.execute("DELETE FROM api_keys WHERE id=?", (old_key_id,))
        return new_key_id


def add_bot_to_channel(bot_id: int, room_id: int, invited_by: int,
                       permissions: List[str] = None) -> bool:
    """Add a bot to a channel. Blocked if the bot is on this node's
    banned_bots list."""
    if is_bot_banned(bot_id):
        return False
    import json
    perms = json.dumps(permissions or ['read', 'write'])
    with _conn() as con:
        try:
            con.execute("""
                INSERT INTO bot_channel_members (bot_id, room_id, invited_by, permissions)
                VALUES (?, ?, ?, ?)
            """, (bot_id, room_id, invited_by, perms))
            return True
        except:
            return False


def remove_bot_from_channel(bot_id: int, room_id: int) -> bool:
    """Remove a bot from a channel."""
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM bot_channel_members WHERE bot_id=? AND room_id=?",
            (bot_id, room_id)
        )
        return cur.rowcount > 0


def get_channel_bots(room_id: int) -> List[Dict]:
    """Get all bots in a channel."""
    with _conn() as con:
        rows = con.execute("""
            SELECT b.id, b.name, b.avatar, b.description, bcm.permissions
            FROM bot_channel_members bcm
            JOIN bots b ON bcm.bot_id = b.id
            WHERE bcm.room_id=?
        """, (room_id,)).fetchall()
    return [dict(r) for r in rows]


def get_bot_channel_names(bot_id: int) -> List[Dict]:
    """Channels a bot has been installed in. Returned in a shape close
    to /api/external/channels so a bot daemon can swap a hardcoded
    `FROGTALK_CHANNELS=foo,bar` list for `GET /api/external/me/channels`
    without restructuring its loop."""
    with _conn() as con:
        rows = con.execute("""
            SELECT r.id AS room_id,
                   r.name,
                   COALESCE(r.description, '') AS description,
                   COALESCE(r.icon, '💬') AS icon,
                   COALESCE(r.is_public, 0) AS is_public,
                   bcm.permissions
            FROM bot_channel_members bcm
            JOIN rooms r ON r.id = bcm.room_id
            WHERE bcm.bot_id = ?
            ORDER BY r.name
        """, (int(bot_id),)).fetchall()
    return [dict(r) for r in rows]


def bot_in_channel(bot_id: int, room_id: int) -> bool:
    """True iff the bot has been explicitly added to the channel.
    Used by the external API to refuse bot messages into rooms the bot
    was never installed in."""
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM bot_channel_members WHERE bot_id=? AND room_id=? LIMIT 1",
            (int(bot_id), int(room_id)),
        ).fetchone()
    return bool(row)


def get_public_bots() -> List[Dict]:
    """Get all public bots — local + federated. Federated rows have
    owner_id=-1 so we LEFT JOIN users and fall back to the cached
    owner_nickname column. Banned bots are filtered out."""
    with _conn() as con:
        rows = con.execute("""
            SELECT b.id, b.name, b.avatar, b.description,
                   CASE WHEN b.origin_server_id IS NULL THEN COALESCE(u.nickname, b.owner_nickname) ELSE COALESCE(b.owner_nickname, u.nickname) END AS owner_name,
                   b.origin_server_id
            FROM bots b
            LEFT JOIN users u ON b.owner_id = u.id
            WHERE b.is_public=1
              AND NOT EXISTS (SELECT 1 FROM banned_bots bb WHERE bb.bot_id = b.id)
            ORDER BY (b.origin_server_id IS NOT NULL), b.name
        """).fetchall()
    return [dict(r) for r in rows]


def find_federated_bot(origin_server_id: str, foreign_bot_id: int) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM bots WHERE origin_server_id=? AND foreign_bot_id=?",
            (origin_server_id, int(foreign_bot_id)),
        ).fetchone()
    return dict(row) if row else None


def upsert_federated_bot(origin_server_id: str, foreign_bot_id: int, *,
                         name: str, avatar: Optional[str] = None,
                         description: str = "",
                         owner_nickname: Optional[str] = None,
                         is_public: int = 1) -> Optional[int]:
    """Mirror a public bot from a peer server into the local catalog.
    Uses owner_id = -1 as a synthetic 'federated' sentinel so it never
    collides with a real account and never appears in get_user_bots().
    api_key_id is 0 — federated bots have no local key; their runtime
    lives on the origin server."""
    if not origin_server_id or not foreign_bot_id:
        return None
    with _conn() as con:
        # bots has two FOREIGN KEYs that the federated mirror rows must
        # satisfy when PRAGMA foreign_keys=ON: owner_id -> users(id) and
        # api_key_id -> api_keys(id). We use synthetic sentinel rows
        # (id=-1 user, id=0 api_key) so the mirror has somewhere to
        # point. Without these the INSERT silently fails inside the
        # broad ``except Exception`` below and the helper returns None
        # — which is exactly the regression that prevented federated
        # bots from appearing in peer bot directories.
        try:
            con.execute(
                "INSERT OR IGNORE INTO users (id, nickname, password_hash, bio, is_admin) "
                "VALUES (-1, '__federated__', '', 'Federated bot owner sentinel', 0)"
            )
            con.execute(
                "INSERT OR IGNORE INTO api_keys (id, user_id, key_hash, name, permissions) "
                "VALUES (0, -1, '', '__federated__', '[]')"
            )
        except Exception:
            pass
        row = con.execute(
            "SELECT id FROM bots WHERE origin_server_id=? AND foreign_bot_id=?",
            (origin_server_id, int(foreign_bot_id)),
        ).fetchone()
        if row:
            con.execute(
                """UPDATE bots
                   SET name=?, avatar=?, description=?, owner_nickname=?, is_public=?
                   WHERE id=?""",
                (name, avatar, description or '', owner_nickname or '',
                 1 if is_public else 0, int(row["id"])),
            )
            return int(row["id"])
        try:
            cur = con.execute(
                """INSERT INTO bots
                   (owner_id, name, api_key_id, avatar, description, is_public,
                    origin_server_id, foreign_bot_id, owner_nickname)
                   VALUES (-1, ?, 0, ?, ?, ?, ?, ?, ?)""",
                (name, avatar, description or '', 1 if is_public else 0,
                 origin_server_id, int(foreign_bot_id), owner_nickname or ''),
            )
            return int(cur.lastrowid)
        except Exception:
            # Likely UNIQUE(name) collision with a local bot of the same
            # display name. Disambiguate by appending @origin once.
            try:
                short_origin = (origin_server_id or '').split('//')[-1].split('/')[0]
                fed_name = f"{name}@{short_origin}" if short_origin else f"{name}#fed{foreign_bot_id}"
                cur = con.execute(
                    """INSERT INTO bots
                       (owner_id, name, api_key_id, avatar, description, is_public,
                        origin_server_id, foreign_bot_id, owner_nickname)
                       VALUES (-1, ?, 0, ?, ?, ?, ?, ?, ?)""",
                    (fed_name, avatar, description or '', 1 if is_public else 0,
                     origin_server_id, int(foreign_bot_id), owner_nickname or ''),
                )
                return int(cur.lastrowid)
            except Exception:
                return None


def delete_federated_bot(origin_server_id: str, foreign_bot_id: int) -> bool:
    if not origin_server_id or not foreign_bot_id:
        return False
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM bots WHERE origin_server_id=? AND foreign_bot_id=?",
            (origin_server_id, int(foreign_bot_id)),
        )
        return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Bot moderation (per-node ban list)
# ---------------------------------------------------------------------------

def is_bot_banned(bot_id: int) -> bool:
    if not bot_id:
        return False
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM banned_bots WHERE bot_id=? LIMIT 1",
            (int(bot_id),),
        ).fetchone()
    return bool(row)


def is_federated_bot_banned(origin_server_id: Optional[str],
                            foreign_bot_id: Optional[int]) -> bool:
    if not origin_server_id or not foreign_bot_id:
        return False
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM banned_bots WHERE origin_server_id=? AND foreign_bot_id=? LIMIT 1",
            (origin_server_id, int(foreign_bot_id)),
        ).fetchone()
    return bool(row)


def ban_bot(bot_id: int, *, reason: str = "", banned_by: Optional[int] = None) -> bool:
    """Add a bot to this node's ban list and evict it from every local
    channel. Idempotent — banning an already-banned bot returns True."""
    if not bot_id:
        return False
    with _conn() as con:
        row = con.execute(
            "SELECT id, name, origin_server_id, foreign_bot_id FROM bots WHERE id=?",
            (int(bot_id),),
        ).fetchone()
        name = row["name"] if row else None
        origin = row["origin_server_id"] if row else None
        foreign = row["foreign_bot_id"] if row else None
        try:
            con.execute(
                """INSERT INTO banned_bots
                   (bot_id, origin_server_id, foreign_bot_id, name, reason, banned_by)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (int(bot_id), origin, foreign, name, reason or '', banned_by),
            )
        except Exception:
            # UNIQUE collision — already banned; refresh reason/name.
            con.execute(
                """UPDATE banned_bots
                   SET reason=?, name=COALESCE(?, name)
                   WHERE bot_id=?""",
                (reason or '', name, int(bot_id)),
            )
        # Evict from every channel on this node.
        con.execute("DELETE FROM bot_channel_members WHERE bot_id=?", (int(bot_id),))
    return True


def unban_bot(bot_id: int) -> bool:
    if not bot_id:
        return False
    with _conn() as con:
        cur = con.execute("DELETE FROM banned_bots WHERE bot_id=?", (int(bot_id),))
        return cur.rowcount > 0


def list_banned_bots() -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT bb.id AS ban_id, bb.bot_id, bb.origin_server_id, bb.foreign_bot_id,
                   bb.name, bb.reason, bb.created_at, bb.banned_by,
                   b.avatar, b.description, b.is_public,
                   CASE WHEN b.origin_server_id IS NULL THEN COALESCE(u.nickname, b.owner_nickname) ELSE COALESCE(b.owner_nickname, u.nickname) END AS owner_name
            FROM banned_bots bb
            LEFT JOIN bots b ON b.id = bb.bot_id
            LEFT JOIN users u ON u.id = b.owner_id
            ORDER BY bb.created_at DESC
        """).fetchall()
    return [dict(r) for r in rows]


def list_all_bots_admin() -> List[Dict]:
    """List every bot known to this node (local + federated mirrors)
    annotated with a `banned` flag and channel-installation count, for
    the server-admin moderation UI."""
    with _conn() as con:
        rows = con.execute("""
            SELECT b.id, b.name, b.avatar, b.description, b.is_public,
                   b.origin_server_id, b.foreign_bot_id,
                   b.owner_id,
                   CASE WHEN b.origin_server_id IS NULL THEN COALESCE(u.nickname, b.owner_nickname) ELSE COALESCE(b.owner_nickname, u.nickname) END AS owner_name,
                   (SELECT COUNT(*) FROM bot_channel_members bcm WHERE bcm.bot_id = b.id) AS channel_count,
                   (SELECT 1 FROM banned_bots bb WHERE bb.bot_id = b.id) AS banned,
                   (SELECT bb.reason FROM banned_bots bb WHERE bb.bot_id = b.id) AS ban_reason
            FROM bots b
            LEFT JOIN users u ON b.owner_id = u.id
            ORDER BY (b.origin_server_id IS NOT NULL), b.name
        """).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["banned"] = bool(d.get("banned"))
        d["federated"] = bool(d.get("origin_server_id"))
        out.append(d)
    return out


# ===========================================================================
# PHASE 6 — Invite Links & Channel Directory
# ===========================================================================

def create_invite(room_id: int, created_by: int, code: str,
                  max_uses: int = 0, expires_hours: int = None) -> bool:
    """Create an invite link for a channel."""
    expires_at = None
    if expires_hours:
        with _conn() as con:
            expires_at = con.execute(
                "SELECT datetime('now', '+' || ? || ' hours')",
                (expires_hours,)
            ).fetchone()[0]
    with _conn() as con:
        try:
            con.execute("""
                INSERT INTO channel_invites (room_id, code, created_by, max_uses, expires_at)
                VALUES (?, ?, ?, ?, ?)
            """, (room_id, code, created_by, max_uses, expires_at))
            return True
        except:
            return False


def get_invite(code: str) -> Optional[Dict]:
    """Get invite info by code."""
    with _conn() as con:
        row = con.execute("""
            SELECT ci.*, r.name as room_name, r.description as room_desc,
                   r.icon as room_icon, u.nickname as created_by_name
            FROM channel_invites ci
            JOIN rooms r ON ci.room_id = r.id
            JOIN users u ON ci.created_by = u.id
            WHERE ci.code=?
        """, (code,)).fetchone()
    return dict(row) if row else None


def use_invite(code: str) -> Optional[int]:
    """Use an invite, return room_id if valid."""
    with _conn() as con:
        invite = con.execute("""
            SELECT id, room_id, max_uses, use_count, expires_at
            FROM channel_invites WHERE code=?
        """, (code,)).fetchone()
        if not invite:
            return None
        # Check expiry
        if invite['expires_at']:
            expired = con.execute(
                "SELECT datetime('now') > ?", (invite['expires_at'],)
            ).fetchone()[0]
            if expired:
                return None
        # Check max uses
        if invite['max_uses'] > 0 and invite['use_count'] >= invite['max_uses']:
            return None
        # Increment use count
        con.execute(
            "UPDATE channel_invites SET use_count = use_count + 1 WHERE id=?",
            (invite['id'],)
        )
        return invite['room_id']


def get_channel_invites(room_id: int) -> List[Dict]:
    """Get all invites for a channel."""
    with _conn() as con:
        rows = con.execute("""
            SELECT ci.*, u.nickname as created_by_name
            FROM channel_invites ci
            JOIN users u ON ci.created_by = u.id
            WHERE ci.room_id=?
            ORDER BY ci.created_at DESC
        """, (room_id,)).fetchall()
    return [dict(r) for r in rows]


def delete_invite(code: str, room_id: int) -> bool:
    """Delete an invite."""
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM channel_invites WHERE code=? AND room_id=?",
            (code, room_id)
        )
        return cur.rowcount > 0


# ─── Vanity invite slugs ──────────────────────────────────────────────────
# A channel owner may claim a single human-friendly slug, served at
# https://frogtalk.xyz/i/<vanity>. Stored on rooms.vanity (UNIQUE LOWER).
# All comparisons are case-insensitive; we always store the canonical
# lowercased form so the URL is deterministic.

def get_room_by_vanity(slug: str) -> Optional[Dict]:
    """Resolve a vanity slug to a room. Case-insensitive lookup."""
    if not slug:
        return None
    with _conn() as con:
        row = con.execute("""
            SELECT r.id, r.name, r.description, r.icon, r.owner_id,
                   r.invite_only, r.who_can_invite, r.vanity,
                   u.nickname AS owner_nickname
            FROM rooms r LEFT JOIN users u ON r.owner_id = u.id
            WHERE LOWER(r.vanity) = LOWER(?)
        """, (slug,)).fetchone()
    return dict(row) if row else None


def is_vanity_available(slug: str, exclude_room_id: Optional[int] = None) -> bool:
    """True iff no other room currently owns this vanity (case-insensitive)."""
    if not slug:
        return False
    with _conn() as con:
        if exclude_room_id is not None:
            row = con.execute(
                "SELECT 1 FROM rooms WHERE LOWER(vanity)=LOWER(?) AND id<>? LIMIT 1",
                (slug, exclude_room_id),
            ).fetchone()
        else:
            row = con.execute(
                "SELECT 1 FROM rooms WHERE LOWER(vanity)=LOWER(?) LIMIT 1",
                (slug,),
            ).fetchone()
    return row is None


def set_room_vanity(room_id: int, slug: Optional[str]) -> bool:
    """Set or clear a room's vanity. Caller must validate format/blacklist
    and call is_vanity_available() first; this performs a final UNIQUE-safe
    write and returns False on collision (race) or DB error."""
    canonical = slug.strip().lower() if slug else None
    try:
        with _conn() as con:
            con.execute("UPDATE rooms SET vanity=? WHERE id=?", (canonical, room_id))
        return True
    except Exception:
        return False


def get_invite_code_collides(slug: str) -> bool:
    """True iff any active invite already uses this exact code (case-sensitive
    on `code`, since codes are random URL-safe tokens)."""
    if not slug:
        return False
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM channel_invites WHERE code=? LIMIT 1", (slug,)
        ).fetchone()
    return row is not None


def get_public_channels(category: str = None, search: str = None,
                        limit: int = 50, offset: int = 0) -> List[Dict]:
    """Get public channels for directory."""
    active_days = get_channel_directory_active_days()
    with _conn() as con:
        query = """
            SELECT r.id, r.name, r.description, r.directory_description,
                   r.icon, r.category, r.tags,
                   (SELECT COUNT(*) FROM room_members WHERE room_id=r.id) AS member_count,
                   r.channel_type,
                   u.nickname as owner_name, u.avatar as owner_avatar
            FROM rooms r
            JOIN users u ON r.owner_id = u.id
            WHERE r.is_public=1
                            AND r.type='public'
              AND COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.room_name = r.name), r.created_at)
                  >= datetime('now', '-' || ? || ' days')
        """
        params = [active_days]
        if category:
            query += " AND r.category=?"
            params.append(category)
        if search:
            query += " AND (r.name LIKE ? OR r.description LIKE ? OR r.tags LIKE ?)"
            params.extend([f'%{search}%', f'%{search}%', f'%{search}%'])
        query += " ORDER BY r.member_count DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        rows = con.execute(query, params).fetchall()
    return [dict(r) for r in rows]


def set_room_public(room_name: str, is_public: int, category: str = '',
                    directory_description: str = '', tags: str = '[]') -> bool:
    """Set room public status with directory info."""
    with _conn() as con:
        cur = con.execute(
            "UPDATE rooms SET is_public=?, category=?, directory_description=?, tags=? WHERE name=?",
            (is_public, category, directory_description, tags, room_name)
        )
        return cur.rowcount > 0


def update_room_member_count(room_id: int, count: int):
    """Update room member count."""
    with _conn() as con:
        con.execute("UPDATE rooms SET member_count=? WHERE id=?", (count, room_id))


# ── Channel likes & comments (directory engagement) ───────────────────────

def like_channel(room_id: int, user_id: int) -> bool:
    with _conn() as con:
        try:
            con.execute(
                "INSERT OR IGNORE INTO channel_likes (room_id, user_id) VALUES (?, ?)",
                (room_id, user_id)
            )
            return True
        except Exception:
            return False


def unlike_channel(room_id: int, user_id: int) -> bool:
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM channel_likes WHERE room_id=? AND user_id=?",
            (room_id, user_id)
        )
        return cur.rowcount > 0


def get_channel_like_count(room_id: int) -> int:
    with _conn() as con:
        row = con.execute(
            "SELECT COUNT(*) AS c FROM channel_likes WHERE room_id=?", (room_id,)
        ).fetchone()
        return int(row["c"]) if row else 0


def user_liked_channel(room_id: int, user_id: int) -> bool:
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM channel_likes WHERE room_id=? AND user_id=? LIMIT 1",
            (room_id, user_id)
        ).fetchone()
        return bool(row)


def add_channel_comment(room_id: int, user_id: int, content: str) -> Optional[int]:
    content = (content or "").strip()
    if not content:
        return None
    content = content[:2000]
    with _conn() as con:
        cur = con.execute(
            "INSERT INTO channel_comments (room_id, user_id, content) VALUES (?, ?, ?)",
            (room_id, user_id, content)
        )
        return cur.lastrowid


def get_channel_comments(room_id: int, limit: int = 50, offset: int = 0,
                         viewer_id: Optional[int] = None) -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT c.id, c.content, c.created_at, c.user_id,
                   u.nickname, u.avatar
            FROM channel_comments c
            JOIN users u ON u.id = c.user_id
            WHERE c.room_id=?
            ORDER BY c.created_at DESC
            LIMIT ? OFFSET ?
        """, (room_id, limit, offset)).fetchall()
    out = [dict(r) for r in rows]
    _attach_comment_votes(out, "channel_comment", viewer_id)
    return out


def delete_channel_comment(comment_id: int, user_id: int, is_admin: bool = False) -> bool:
    """Delete a comment; allowed if author, admin, or room owner/mod."""
    with _conn() as con:
        row = con.execute(
            "SELECT user_id, room_id FROM channel_comments WHERE id=?",
            (comment_id,)
        ).fetchone()
        if not row:
            return False
        if row["user_id"] != user_id and not is_admin:
            # Check room owner / mod
            rm = con.execute(
                "SELECT owner_id FROM rooms WHERE id=?", (row["room_id"],)
            ).fetchone()
            is_owner = rm and rm["owner_id"] == user_id
            is_mod = con.execute(
                "SELECT 1 FROM room_moderators WHERE room_id=? AND user_id=? LIMIT 1",
                (row["room_id"], user_id)
            ).fetchone() if not is_owner else None
            if not is_owner and not is_mod:
                return False
        con.execute(
            "DELETE FROM comment_votes WHERE target_type='channel_comment' AND target_id=?",
            (comment_id,)
        )
        cur = con.execute("DELETE FROM channel_comments WHERE id=?", (comment_id,))
        return cur.rowcount > 0


def get_channel_comment(comment_id: int) -> Optional[Dict]:
    """Return raw channel comment row or None."""
    with _conn() as con:
        row = con.execute(
            "SELECT id, room_id, user_id, content, created_at FROM channel_comments WHERE id=?",
            (comment_id,)
        ).fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Polymorphic comment votes (👍/👎 on channel comments + wall comments)
# ---------------------------------------------------------------------------

_VALID_VOTE_TARGETS = ("channel_comment", "wall_comment")


def set_comment_vote(target_type: str, target_id: int, user_id: int,
                     value: int) -> Dict[str, int]:
    """Set the user's vote on a comment.

    `value` must be -1, 0, or 1. `0` clears any existing vote. Idempotent.
    Returns the post-update counts {up, down, my_vote}.
    """
    if target_type not in _VALID_VOTE_TARGETS:
        raise ValueError(f"invalid target_type: {target_type}")
    if value not in (-1, 0, 1):
        raise ValueError(f"invalid value: {value}")
    with _conn() as con:
        if value == 0:
            con.execute(
                "DELETE FROM comment_votes WHERE target_type=? AND target_id=? AND user_id=?",
                (target_type, target_id, user_id)
            )
        else:
            # Upsert against the unique (target_type, target_id, user_id).
            con.execute("""
                INSERT INTO comment_votes (target_type, target_id, user_id, value)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(target_type, target_id, user_id)
                DO UPDATE SET value=excluded.value, created_at=datetime('now')
            """, (target_type, target_id, user_id, value))
        agg = con.execute("""
            SELECT
                SUM(CASE WHEN value =  1 THEN 1 ELSE 0 END) AS up,
                SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS down
            FROM comment_votes WHERE target_type=? AND target_id=?
        """, (target_type, target_id)).fetchone()
    return {
        "up": int(agg["up"] or 0),
        "down": int(agg["down"] or 0),
        "my_vote": int(value),
    }


def get_comment_vote_counts_bulk(target_type: str,
                                 ids: List[int]) -> Dict[int, Dict[str, int]]:
    """Return {comment_id: {up, down}} for the requested ids."""
    if target_type not in _VALID_VOTE_TARGETS or not ids:
        return {}
    placeholders = ",".join("?" * len(ids))
    with _conn() as con:
        rows = con.execute(f"""
            SELECT target_id,
                   SUM(CASE WHEN value =  1 THEN 1 ELSE 0 END) AS up,
                   SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS down
            FROM comment_votes
            WHERE target_type=? AND target_id IN ({placeholders})
            GROUP BY target_id
        """, (target_type, *ids)).fetchall()
    return {
        int(r["target_id"]): {"up": int(r["up"] or 0), "down": int(r["down"] or 0)}
        for r in rows
    }


def get_user_comment_votes_bulk(target_type: str, ids: List[int],
                                user_id: int) -> Dict[int, int]:
    """Return {comment_id: value} for rows the user has voted on."""
    if target_type not in _VALID_VOTE_TARGETS or not ids or not user_id:
        return {}
    placeholders = ",".join("?" * len(ids))
    with _conn() as con:
        rows = con.execute(f"""
            SELECT target_id, value FROM comment_votes
            WHERE target_type=? AND user_id=? AND target_id IN ({placeholders})
        """, (target_type, user_id, *ids)).fetchall()
    return {int(r["target_id"]): int(r["value"]) for r in rows}


def _attach_comment_votes(rows: List[Dict], target_type: str,
                          viewer_id: Optional[int]) -> None:
    """Mutate `rows` in-place to add like_count/dislike_count/my_vote."""
    if not rows:
        return
    ids = [int(r["id"]) for r in rows]
    counts = get_comment_vote_counts_bulk(target_type, ids)
    mine = get_user_comment_votes_bulk(target_type, ids, viewer_id) if viewer_id else {}
    for r in rows:
        c = counts.get(int(r["id"]), {})
        r["like_count"] = int(c.get("up", 0))
        r["dislike_count"] = int(c.get("down", 0))
        r["my_vote"] = int(mine.get(int(r["id"]), 0))


def get_suggested_channels(user_id: int, limit: int = 10) -> List[Dict]:
    """Get public channels the user hasn't joined, ordered by popularity."""
    active_days = get_channel_directory_active_days()
    with _conn() as con:
        rows = con.execute("""
            SELECT r.id, r.name, r.description, r.directory_description,
                   r.icon, r.category, r.tags,
                   (SELECT COUNT(*) FROM room_members WHERE room_id=r.id) AS member_count,
                   r.channel_type,
                   u.nickname as owner_name, u.avatar as owner_avatar
            FROM rooms r
            JOIN users u ON r.owner_id = u.id
            WHERE r.is_public=1
              AND COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.room_name = r.name), r.created_at)
                  >= datetime('now', '-' || ? || ' days')
              AND r.id NOT IN (SELECT room_id FROM room_members WHERE user_id=?)
            ORDER BY member_count DESC
            LIMIT ?
        """, (active_days, user_id, limit)).fetchall()
    return [dict(r) for r in rows]


def get_user_channels(user_id: int) -> List[Dict]:
    """Get all channels owned/created by a user."""
    with _conn() as con:
        rows = con.execute("""
            SELECT r.id, r.name, r.description, r.directory_description,
                   r.icon, r.category, r.tags,
                   (SELECT COUNT(*) FROM room_members WHERE room_id=r.id) AS member_count,
                   r.channel_type,
                   r.is_public
            FROM rooms r
            WHERE r.owner_id=?
            ORDER BY member_count DESC
        """, (user_id,)).fetchall()
    return [dict(r) for r in rows]


def get_new_public_channels(limit: int = 10) -> List[Dict]:
    """Get newest public channels for explore."""
    active_days = get_channel_directory_active_days()
    with _conn() as con:
        rows = con.execute("""
            SELECT r.id, r.name, r.description, r.directory_description,
                   r.icon, r.category, r.tags,
                   (SELECT COUNT(*) FROM room_members WHERE room_id=r.id) AS member_count,
                   r.channel_type,
                   u.nickname as owner_name, u.avatar as owner_avatar
            FROM rooms r
            JOIN users u ON r.owner_id = u.id
            WHERE r.is_public=1
              AND COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.room_name = r.name), r.created_at)
                  >= datetime('now', '-' || ? || ' days')
            ORDER BY r.id DESC
            LIMIT ?
        """, (active_days, limit)).fetchall()
    return [dict(r) for r in rows]


# ===========================================================================
# PHASE 7 — Social Profiles & Wall
# ===========================================================================

def create_wall_post(user_id: int, content: str, media_data: str = None,
                     media_type: str = None, privacy: str = 'public',
                     share_enabled: int = 1,
                     allow_comments: int = 1,
                     track_title: str = None,
                     track_room: str = None,
                     track_mood: str = None) -> int:
    """Create a wall post."""
    with _conn() as con:
        cur = con.execute("""
            INSERT INTO wall_posts (user_id, content, media_data, media_type,
                                   privacy, share_enabled, allow_comments,
                                   track_title, track_room, track_mood)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (user_id, content, media_data, media_type, privacy, share_enabled, allow_comments,
              track_title, track_room, track_mood))
        return cur.lastrowid


def get_wall_posts(user_id: int, viewer_id: int = None,
                   limit: int = 20, offset: int = 0,
                   lite: bool = False) -> List[Dict]:
    """Get wall posts for a user. Filter by privacy based on viewer.

    `lite=True` strips raw image/video base64 from the row (the client
    will fetch each one lazily via /api/social/posts/{id}/media). Music
    posts keep media_data because that's a URL reference, not a blob.
    A 30-post wall of images drops from megabytes of JSON to kilobytes.
    """
    media_col = (
        "CASE WHEN wp.media_type LIKE 'music/%' THEN wp.media_data ELSE NULL END AS media_data"
        if lite else "wp.media_data"
    )
    with _conn() as con:
        # Determine privacy filter
        if viewer_id == user_id:
            # Owner sees everything
            privacy_filter = "1=1"
        elif viewer_id:
            # Check if friends
            friend = con.execute("""
                SELECT 1 FROM friends
                WHERE ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?))
                AND status='accepted'
            """, (user_id, viewer_id, viewer_id, user_id)).fetchone()
            # Check if viewer follows the profile owner
            follows = con.execute(
                "SELECT 1 FROM followers WHERE follower_id=? AND following_id=?",
                (viewer_id, user_id)
            ).fetchone()
            if friend:
                privacy_filter = "wp.privacy IN ('public', 'followers', 'friends')"
            elif follows:
                privacy_filter = "wp.privacy IN ('public', 'followers')"
            else:
                privacy_filter = "wp.privacy = 'public'"
        else:
            privacy_filter = "wp.privacy = 'public'"

        viewer_lookup_id = int(viewer_id or 0)
        rows = con.execute(f"""
            SELECT wp.id, wp.user_id, wp.content, {media_col}, wp.media_type, wp.privacy, wp.share_enabled,
                   wp.allow_comments, wp.created_at, wp.edited_at,
                   wp.track_title, wp.track_room, wp.track_mood,
                   (wp.media_type IS NOT NULL AND wp.media_type != '') AS has_media,
                   u.nickname, u.avatar, u.display_name, u.is_admin AS is_admin,
                   wp.reaction_count as reaction_count,
                   wp.comment_count as comment_count,
                   wp.repost_count as repost_count,
                   CASE WHEN ? > 0 THEN EXISTS(
                       SELECT 1 FROM wall_reposts wr WHERE wr.post_id=wp.id AND wr.user_id=?
                   ) ELSE 0 END AS i_reposted
            FROM wall_posts wp
            JOIN users u ON wp.user_id = u.id
            WHERE wp.user_id=? AND {privacy_filter}
            ORDER BY wp.created_at DESC
            LIMIT ? OFFSET ?
        """, (viewer_lookup_id, viewer_lookup_id, user_id, limit, offset)).fetchall()
    return [dict(r) for r in rows]


def get_wall_post_media(post_id: int) -> Optional[Dict]:
    """Lean fetch for the lazy media endpoint: only the fields needed for
    privacy gating + the raw media payload. Avoids pulling content/track_*."""
    with _conn() as con:
        row = con.execute("""
            SELECT wp.id, wp.user_id, wp.privacy, wp.media_data, wp.media_type
            FROM wall_posts wp
            WHERE wp.id=?
        """, (post_id,)).fetchone()
    return dict(row) if row else None


def get_wall_post(post_id: int) -> Optional[Dict]:
    """Get a single wall post (full row including media_data)."""
    # Use the materialized `wp.repost_count` column instead of a correlated
    # subquery — counters are kept in sync by triggers (see _ensure_schema).
    with _conn() as con:
        row = con.execute("""
            SELECT wp.*, u.nickname, u.avatar, u.display_name, u.is_admin AS is_admin
            FROM wall_posts wp
            JOIN users u ON wp.user_id = u.id
            WHERE wp.id=?
        """, (post_id,)).fetchone()
    return dict(row) if row else None


def get_wall_post_meta(post_id: int) -> Optional[Dict]:
    """Lean fetch for permission/privacy/notification gating that does NOT
    pull the multi-MB `media_data` column.

    The hot reaction/comment/repost POST handlers used to call
    `get_wall_post`, which executes `SELECT wp.*` — that includes
    `media_data`. With even a single 45 MB video post, every "like" by any
    user pulled 45 MB through SQLite into Python on the event loop just to
    read `user_id` and `privacy`. This helper returns everything the
    handlers actually use and exposes a `has_media` flag for the rare case
    a caller needs to know media exists without loading it.
    """
    with _conn() as con:
        row = con.execute("""
            SELECT wp.id, wp.user_id, wp.content, wp.media_type, wp.privacy,
                   wp.share_enabled, wp.allow_comments, wp.created_at,
                   wp.edited_at, wp.track_title, wp.track_room,
                   COALESCE(wp.reaction_count, 0) AS reaction_count,
                   COALESCE(wp.comment_count, 0)  AS comment_count,
                   COALESCE(wp.repost_count, 0)   AS repost_count,
                   (wp.media_type IS NOT NULL AND wp.media_type != '') AS has_media,
                   u.nickname, u.avatar
            FROM wall_posts wp
            JOIN users u ON wp.user_id = u.id
            WHERE wp.id=?
        """, (post_id,)).fetchone()
    return dict(row) if row else None


def get_user_reposts(user_id: int, viewer_id: int, limit: int = 30,
                     offset: int = 0, lite: bool = False) -> List[Dict]:
    """Get posts that a user has reposted. Respects privacy of original posts.

    See get_wall_posts for `lite` semantics.
    """
    media_col = (
        "CASE WHEN wp.media_type LIKE 'music/%' THEN wp.media_data ELSE NULL END AS media_data"
        if lite else "wp.media_data"
    )
    with _conn() as con:
        # Determine privacy filter based on viewer relationship
        if viewer_id == user_id:
            privacy_filter = "1=1"
        elif viewer_id:
            friend = con.execute("""
                SELECT 1 FROM friends
                WHERE ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?))
                AND status='accepted'
            """, (user_id, viewer_id, viewer_id, user_id)).fetchone()
            follows = con.execute(
                "SELECT 1 FROM followers WHERE follower_id=? AND following_id=?",
                (viewer_id, user_id)
            ).fetchone()
            if friend:
                privacy_filter = "wp.privacy IN ('public', 'followers', 'friends')"
            elif follows:
                privacy_filter = "wp.privacy IN ('public', 'followers')"
            else:
                privacy_filter = "wp.privacy = 'public'"
        else:
            privacy_filter = "wp.privacy = 'public'"

        viewer_lookup_id = int(viewer_id or 0)
        rows = con.execute(f"""
            SELECT wp.id, wp.user_id, wp.content, {media_col}, wp.media_type, wp.privacy, wp.share_enabled,
                   wp.allow_comments, wp.created_at, wp.edited_at,
                   wp.track_title, wp.track_room, wp.track_mood,
                   (wp.media_type IS NOT NULL AND wp.media_type != '') AS has_media,
                   u.nickname, u.avatar, u.display_name, u.is_admin AS is_admin,
                   wp.reaction_count as reaction_count,
                   wp.comment_count as comment_count,
                   wp.repost_count as repost_count,
                   CASE WHEN ? > 0 THEN EXISTS(
                       SELECT 1 FROM wall_reposts wr WHERE wr.post_id=wp.id AND wr.user_id=?
                   ) ELSE 0 END AS i_reposted
            FROM wall_posts wp
            JOIN users u ON wp.user_id = u.id
            JOIN wall_reposts wr ON wr.post_id = wp.id
            WHERE wr.user_id=? AND {privacy_filter}
              AND wp.user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id=?)
              AND wp.user_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id=?)
            ORDER BY wr.created_at DESC
            LIMIT ? OFFSET ?
        """, (viewer_lookup_id, viewer_lookup_id, user_id, viewer_lookup_id, viewer_lookup_id, limit, offset)).fetchall()
    return [dict(r) for r in rows]


def update_wall_post(post_id: int, user_id: int, content: str = None,
                     privacy: str = None, share_enabled: int = None, allow_comments: int = None) -> bool:
    """Update a wall post."""
    updates = {}
    if content is not None:
        updates['content'] = content
    if privacy is not None:
        updates['privacy'] = privacy
    if share_enabled is not None:
        updates['share_enabled'] = share_enabled
    if allow_comments is not None:
        updates['allow_comments'] = allow_comments
    if not updates:
        return False
    updates['edited_at'] = "datetime('now')"
    set_clause = ', '.join(f"{k}=?" if k != 'edited_at' else f"{k}={updates[k]}"
                          for k in updates)
    values = [v for k, v in updates.items() if k != 'edited_at']
    with _conn() as con:
        cur = con.execute(
            f"UPDATE wall_posts SET {set_clause} WHERE id=? AND user_id=?",
            (*values, post_id, user_id)
        )
        return cur.rowcount > 0


def delete_wall_post(post_id: int, user_id: int, force: bool = False) -> bool:
    """Delete a wall post. If force=True (admin), skip ownership check."""
    with _conn() as con:
        if force:
            cur = con.execute("DELETE FROM wall_posts WHERE id=?", (post_id,))
        else:
            cur = con.execute(
                "DELETE FROM wall_posts WHERE id=? AND user_id=?",
                (post_id, user_id)
            )
        return cur.rowcount > 0


def clear_wall_post_media(post_id: int, user_id: int) -> bool:
    """Remove only media attachment from a wall post owned by user.

    Leaves the post row/content intact and updates edited_at.
    """
    with _conn() as con:
        cur = con.execute(
            """
            UPDATE wall_posts
            SET media_data=NULL,
                media_type=NULL,
                track_title=NULL,
                track_room=NULL,
                track_mood=NULL,
                edited_at=datetime('now')
            WHERE id=? AND user_id=? AND media_data IS NOT NULL
            """,
            (post_id, user_id),
        )
        con.commit()
        return cur.rowcount > 0


def add_wall_reaction(post_id: int, user_id: int, emoji: str) -> bool:
    """Add or change a reaction to a post (one active reaction per user).

    - Same emoji as current reaction → toggle off (remove), returns False.
    - Different emoji → replace current reaction, returns True.
    - No existing reaction → insert, returns True.
    """
    with _conn() as con:
        existing = con.execute("""
            SELECT id, emoji FROM wall_post_reactions
            WHERE post_id=? AND user_id=?
        """, (post_id, user_id)).fetchone()
        if existing:
            if existing['emoji'] == emoji:
                # Same emoji — toggle off
                con.execute("DELETE FROM wall_post_reactions WHERE id=?", (existing['id'],))
                return False  # Removed
            else:
                # Different emoji — change reaction in-place
                con.execute(
                    "UPDATE wall_post_reactions SET emoji=?, created_at=datetime('now') WHERE id=?",
                    (emoji, existing['id'])
                )
                return True  # Changed
        else:
            con.execute("""
                INSERT INTO wall_post_reactions (post_id, user_id, emoji)
                VALUES (?, ?, ?)
            """, (post_id, user_id, emoji))
            return True  # Added


def set_wall_reaction(post_id: int, user_id: int, emoji: str, active: bool) -> bool:
    """Set reaction state deterministically (non-toggle).

    Returns True when a reaction is active after the operation, False when
    removed/absent.
    """
    with _conn() as con:
        existing = con.execute(
            "SELECT id, emoji FROM wall_post_reactions WHERE post_id=? AND user_id=?",
            (post_id, user_id),
        ).fetchone()
        if not active:
            if existing:
                con.execute("DELETE FROM wall_post_reactions WHERE id=?", (existing["id"],))
            return False

        if existing:
            if existing["emoji"] != emoji:
                con.execute(
                    "UPDATE wall_post_reactions SET emoji=?, created_at=datetime('now') WHERE id=?",
                    (emoji, existing["id"]),
                )
        else:
            con.execute(
                "INSERT INTO wall_post_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)",
                (post_id, user_id, emoji),
            )
        return True


def toggle_wall_repost(post_id: int, user_id: int, quote_text: Optional[str] = None) -> bool:
    """Toggle/update a repost.

    - No quote and existing repost => remove repost (returns False)
    - Quote provided and existing repost => update quote + bump timestamp
      (returns True)
    - No existing repost => create one (returns True)
    """
    with _conn() as con:
        existing = con.execute(
            "SELECT id FROM wall_reposts WHERE post_id=? AND user_id=?",
            (post_id, user_id),
        ).fetchone()
        normalized_quote = (quote_text or "").strip() or None
        if existing:
            if normalized_quote:
                con.execute(
                    """
                    UPDATE wall_reposts
                       SET quote_text=?, created_at=datetime('now')
                     WHERE id=?
                    """,
                    (normalized_quote, existing["id"]),
                )
                return True
            con.execute("DELETE FROM wall_reposts WHERE id=?", (existing["id"],))
            return False
        con.execute(
            """
            INSERT INTO wall_reposts (post_id, user_id, quote_text)
            VALUES (?, ?, ?)
            """,
            (post_id, user_id, normalized_quote),
        )
        return True


def get_wall_repost_count(post_id: int) -> int:
    """Return repost count for a post."""
    with _conn() as con:
        row = con.execute(
            "SELECT COUNT(*) AS c FROM wall_reposts WHERE post_id=?",
            (post_id,),
        ).fetchone()
    return int(row["c"]) if row else 0


def has_wall_reposted(post_id: int, user_id: int) -> bool:
    """True when user has reposted post_id."""
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM wall_reposts WHERE post_id=? AND user_id=? LIMIT 1",
            (post_id, user_id),
        ).fetchone()
    return bool(row)


def get_post_reactions(post_id: int) -> List[Dict]:
    """Get aggregated reactions for a post.

    Also returns user_ids (CSV) so the reels reactor stack can render
    real avatars via /api/users/{uid}/avatar.png after a fresh react.
    """
    with _conn() as con:
        rows = con.execute("""
            SELECT emoji, COUNT(*) as count,
                   GROUP_CONCAT(u.nickname) as users,
                   GROUP_CONCAT(wpr.user_id) as user_ids
            FROM wall_post_reactions wpr
            JOIN users u ON wpr.user_id = u.id
            WHERE wpr.post_id=?
            GROUP BY emoji
            ORDER BY count DESC, emoji ASC
        """, (post_id,)).fetchall()
    return [dict(r) for r in rows]


def get_post_reactions_detail(post_id: int, limit: int = 500) -> List[Dict]:
    """Get per-user reaction rows for the reaction detail modal.

    Bounded with a hard max to avoid large response payloads on viral posts.
    """
    safe_limit = max(1, min(int(limit or 500), 1000))
    with _conn() as con:
        rows = con.execute("""
            SELECT wpr.user_id, u.nickname, u.avatar, wpr.emoji, wpr.created_at
            FROM wall_post_reactions wpr
            JOIN users u ON wpr.user_id = u.id
            WHERE wpr.post_id=?
            ORDER BY wpr.created_at DESC
            LIMIT ?
        """, (post_id, safe_limit)).fetchall()
    return [dict(r) for r in rows]


def get_post_reactions_bulk(post_ids: List[int]) -> Dict[int, List[Dict]]:
    """Bulk version of get_post_reactions to avoid N+1 query in feeds.
    Returns a dict mapping post_id -> list of reaction summaries."""
    if not post_ids:
        return {}
    out: Dict[int, List[Dict]] = {pid: [] for pid in post_ids}
    placeholders = ",".join("?" for _ in post_ids)
    # Cap users per (post,emoji) bucket so a viral post with thousands of
    # reactions can't return a 100KB GROUP_CONCAT string. The frontend only
    # uses the first ~10 names for the tooltip preview anyway.
    USERS_PER_EMOJI_CAP = 32
    with _conn() as con:
        rows = con.execute(f"""
            SELECT post_id, emoji,
                   GROUP_CONCAT(nickname) AS users,
                   GROUP_CONCAT(user_id)  AS user_ids
            FROM (
                SELECT wpr.post_id AS post_id, wpr.emoji AS emoji,
                       u.nickname AS nickname,
                       wpr.user_id AS user_id,
                       ROW_NUMBER() OVER (
                           PARTITION BY wpr.post_id, wpr.emoji
                           ORDER BY wpr.created_at DESC
                       ) AS rn
                FROM wall_post_reactions wpr
                JOIN users u ON wpr.user_id = u.id
                WHERE wpr.post_id IN ({placeholders})
            )
            WHERE rn <= ?
            GROUP BY post_id, emoji
        """, list(post_ids) + [USERS_PER_EMOJI_CAP]).fetchall()
        # Get true totals so the count stays accurate even when names are capped.
        total_rows = con.execute(f"""
            SELECT post_id, emoji, COUNT(*) AS total
            FROM wall_post_reactions
            WHERE post_id IN ({placeholders})
            GROUP BY post_id, emoji
        """, list(post_ids)).fetchall()
    totals = {(int(r["post_id"]), r["emoji"]): int(r["total"]) for r in total_rows}
    for r in rows:
        key = (int(r["post_id"]), r["emoji"])
        out.setdefault(r["post_id"], []).append({
            "emoji": r["emoji"],
            "count": totals.get(key, 0),
            "users": r["users"],
            "user_ids": r["user_ids"],
        })
    return out


def add_wall_comment(post_id: int, user_id: int, content: str) -> Optional[int]:
    """Add a comment to a post."""
    with _conn() as con:
        # Check if post allows comments
        post = con.execute(
            "SELECT allow_comments FROM wall_posts WHERE id=?", (post_id,)
        ).fetchone()
        if not post or not post['allow_comments']:
            return None
        cur = con.execute("""
            INSERT INTO wall_comments (post_id, user_id, content)
            VALUES (?, ?, ?)
        """, (post_id, user_id, content))
        return cur.lastrowid


def get_post_comments(post_id: int, limit: int = 50, viewer_id: Optional[int] = None) -> List[Dict]:
    """Get comments for a post. When viewer_id is provided, comments from
    users blocked in either direction are excluded."""
    with _conn() as con:
        if viewer_id is not None:
            rows = con.execute("""
                SELECT wc.*, u.nickname, u.avatar
                FROM wall_comments wc
                JOIN users u ON wc.user_id = u.id
                WHERE wc.post_id=?
                  AND wc.user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id=?)
                  AND wc.user_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id=?)
                ORDER BY wc.created_at ASC
                LIMIT ?
            """, (post_id, viewer_id, viewer_id, limit)).fetchall()
        else:
            rows = con.execute("""
                SELECT wc.*, u.nickname, u.avatar
                FROM wall_comments wc
                JOIN users u ON wc.user_id = u.id
                WHERE wc.post_id=?
                ORDER BY wc.created_at ASC
                LIMIT ?
            """, (post_id, limit)).fetchall()
    out = [dict(r) for r in rows]
    _attach_comment_votes(out, "wall_comment", viewer_id)
    return out


def get_wall_comment(comment_id: int) -> Optional[Dict]:
    """Return raw wall comment row or None."""
    with _conn() as con:
        row = con.execute(
            "SELECT id, post_id, user_id, content, created_at FROM wall_comments WHERE id=?",
            (comment_id,)
        ).fetchone()
    return dict(row) if row else None


def delete_wall_comment(comment_id: int, user_id: int) -> bool:
    """Delete a comment (by comment author or post owner)."""
    with _conn() as con:
        # Get comment info
        comment = con.execute("""
            SELECT wc.*, wp.user_id as post_owner
            FROM wall_comments wc
            JOIN wall_posts wp ON wc.post_id = wp.id
            WHERE wc.id=?
        """, (comment_id,)).fetchone()
        if not comment:
            return False
        if comment['user_id'] != user_id and comment['post_owner'] != user_id:
            return False
        con.execute(
            "DELETE FROM comment_votes WHERE target_type='wall_comment' AND target_id=?",
            (comment_id,)
        )
        con.execute("DELETE FROM wall_comments WHERE id=?", (comment_id,))
        return True


# ---------------------------------------------------------------------------
# Social activity notifications (likes / comments / follows)
# ---------------------------------------------------------------------------

def add_social_notification(user_id: int, actor_id: int, kind: str,
                            post_id: Optional[int] = None,
                            comment_id: Optional[int] = None,
                            emoji: Optional[str] = None,
                            preview: Optional[str] = None) -> Optional[int]:
    """Insert a social notification. Returns the new row id, or None if
    the recipient == actor (self-action) or either side is blocked.
    Coalesces near-duplicate likes (same user re-liking the same post)
    by upserting against the previous unread like row."""
    if user_id == actor_id:
        return None
    try:
        if is_blocked_either_way(user_id, actor_id):
            return None
    except Exception:
        pass
    if preview and len(preview) > 140:
        preview = preview[:137] + "…"
    with _conn() as con:
        # Coalesce same-user repeating likes on same post (toggle re-add)
        if kind == "like" and post_id is not None:
            existing = con.execute("""
                SELECT id FROM social_notifications
                WHERE user_id=? AND actor_id=? AND kind='like'
                  AND post_id=? AND read_at IS NULL
                ORDER BY id DESC LIMIT 1
            """, (user_id, actor_id, post_id)).fetchone()
            if existing:
                con.execute("""
                    UPDATE social_notifications
                       SET emoji=?, created_at=datetime('now')
                     WHERE id=?
                """, (emoji, existing["id"]))
                return existing["id"]
        cur = con.execute("""
            INSERT INTO social_notifications
                (user_id, actor_id, kind, post_id, comment_id, emoji, preview)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (user_id, actor_id, kind, post_id, comment_id, emoji, preview))
        return cur.lastrowid


def remove_social_like_notification(user_id: int, actor_id: int, post_id: int) -> int:
    """Delete an unread like notification when the actor unlikes. Returns
    rows affected. (We only remove unread rows — once seen, history stays.)"""
    if user_id == actor_id:
        return 0
    with _conn() as con:
        cur = con.execute("""
            DELETE FROM social_notifications
             WHERE user_id=? AND actor_id=? AND kind='like'
               AND post_id=? AND read_at IS NULL
        """, (user_id, actor_id, post_id))
        return cur.rowcount


def get_social_notifications(user_id: int, limit: int = 40,
                             offset: int = 0) -> List[Dict]:
    """List recent social notifications for a user, newest first.
    Joins actor nickname/avatar for direct rendering."""
    limit = max(1, min(int(limit or 40), 100))
    offset = max(0, int(offset or 0))
    with _conn() as con:
        rows = con.execute("""
            SELECT n.id, n.kind, n.post_id, n.comment_id, n.emoji, n.preview,
                   n.created_at, n.read_at,
                   u.nickname AS actor_nickname,
                   u.avatar   AS actor_avatar
              FROM social_notifications n
              JOIN users u ON u.id = n.actor_id
             WHERE n.user_id=?
             ORDER BY n.id DESC
             LIMIT ? OFFSET ?
        """, (user_id, limit, offset)).fetchall()
    return [dict(r) for r in rows]


def get_social_notification_unread_count(user_id: int) -> int:
    with _conn() as con:
        row = con.execute("""
            SELECT COUNT(*) AS n FROM social_notifications
             WHERE user_id=? AND read_at IS NULL
        """, (user_id,)).fetchone()
    return int(row["n"]) if row else 0


def mark_social_notifications_read(user_id: int,
                                   ids: Optional[List[int]] = None) -> int:
    """Mark notifications as read. If ids is None/empty, marks all unread
    for the user. Returns rows affected."""
    with _conn() as con:
        if ids:
            placeholders = ",".join("?" for _ in ids)
            cur = con.execute(f"""
                UPDATE social_notifications
                   SET read_at=datetime('now')
                 WHERE user_id=? AND read_at IS NULL
                   AND id IN ({placeholders})
            """, [user_id, *ids])
        else:
            cur = con.execute("""
                UPDATE social_notifications
                   SET read_at=datetime('now')
                 WHERE user_id=? AND read_at IS NULL
            """, (user_id,))
        return cur.rowcount


def update_user_mood(user_id: int, mood: str) -> bool:
    """Update user mood/status."""
    with _conn() as con:
        cur = con.execute(
            "UPDATE users SET mood=? WHERE id=?", (mood, user_id)
        )
        return cur.rowcount > 0


def update_user_css(user_id: int, css: str) -> bool:
    """Update user custom CSS — writes both raw (`custom_css`, for the
    editor round-trip) and sanitised inline-style (`custom_style`, the
    only column the renderer reads). See Track B in
    docs/SECURITY_REFACTOR_PLAN.md.
    """
    # Lazy import to avoid pulling FastAPI/Pydantic at database.py
    # import time (database is also used by CLI tools).
    from routers._css_inline import sanitize_inline_style

    if not isinstance(css, str):
        css = ""
    if len(css) > 10240:
        css = css[:10240]
    sanitised = sanitize_inline_style(css)
    with _conn() as con:
        cur = con.execute(
            "UPDATE users SET custom_css=?, custom_style=? WHERE id=?",
            (css, sanitised, user_id),
        )
        return cur.rowcount > 0


def get_user_css(user_id: int) -> str:
    """Get user custom CSS (raw, for the editor)."""
    with _conn() as con:
        row = con.execute(
            "SELECT custom_css FROM users WHERE id=?", (user_id,)
        ).fetchone()
    return row['custom_css'] if row else ''


def get_user_style(user_id: int) -> str:
    """Get sanitised inline-style declaration list (renderer-ready)."""
    with _conn() as con:
        row = con.execute(
            "SELECT custom_style FROM users WHERE id=?", (user_id,)
        ).fetchone()
    return (row['custom_style'] if row else '') or ''


def backfill_custom_style(*, batch: int = 500) -> int:
    """One-shot backfill: populate `custom_style` for every user whose
    raw `custom_css` is non-empty but `custom_style` is still empty.

    Idempotent. Called from `_migrate()` on startup; safe to call again.
    Returns the number of rows updated.
    """
    from routers._css_inline import sanitize_inline_style

    updated = 0
    with _conn() as con:
        # Pull only rows that actually need work — the partial-index-like
        # WHERE keeps this O(touched), not O(users).
        rows = con.execute(
            "SELECT id, custom_css FROM users "
            "WHERE custom_css IS NOT NULL AND custom_css != '' "
            "AND (custom_style IS NULL OR custom_style = '')"
        ).fetchall()
        for i in range(0, len(rows), batch):
            chunk = rows[i:i + batch]
            con.execute("BEGIN IMMEDIATE")
            try:
                for r in chunk:
                    s = sanitize_inline_style(r["custom_css"] or "")
                    con.execute(
                        "UPDATE users SET custom_style=? WHERE id=?",
                        (s, int(r["id"])),
                    )
                    updated += 1
                con.execute("COMMIT")
            except Exception:
                con.execute("ROLLBACK")
                raise
    return updated


# Location Sharing
def share_location(dm_channel_id: int, user_id: int, lat: float, lon: float,
                   accuracy: float = None, expires_hours: int = 1) -> bool:
    """Share location in a DM channel."""
    with _conn() as con:
        expires_at = con.execute(
            "SELECT datetime('now', '+' || ? || ' hours')", (expires_hours,)
        ).fetchone()[0]
        # Remove existing share
        con.execute("""
            DELETE FROM location_shares
            WHERE dm_channel_id=? AND user_id=?
        """, (dm_channel_id, user_id))
        con.execute("""
            INSERT INTO location_shares (dm_channel_id, user_id, latitude, longitude,
                                        accuracy, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (dm_channel_id, user_id, lat, lon, accuracy, expires_at))
        return True


def get_shared_locations(dm_channel_id: int) -> List[Dict]:
    """Get active location shares in a DM channel."""
    with _conn() as con:
        rows = con.execute("""
            SELECT ls.*, u.nickname, u.avatar
            FROM location_shares ls
            JOIN users u ON ls.user_id = u.id
            WHERE ls.dm_channel_id=?
              AND datetime('now') < ls.expires_at
        """, (dm_channel_id,)).fetchall()
    return [dict(r) for r in rows]


def stop_location_share(dm_channel_id: int, user_id: int) -> bool:
    """Stop sharing location."""
    with _conn() as con:
        cur = con.execute("""
            DELETE FROM location_shares
            WHERE dm_channel_id=? AND user_id=?
        """, (dm_channel_id, user_id))
        return cur.rowcount > 0


# ===========================================================================
# PHASE 8 — Security & Recovery
# ===========================================================================

def create_captcha(challenge_id: str, answer: str, expires_minutes: int = 5):
    """Create a CAPTCHA challenge."""
    with _conn() as con:
        expires_at = con.execute(
            "SELECT datetime('now', '+' || ? || ' minutes')", (expires_minutes,)
        ).fetchone()[0]
        con.execute("""
            INSERT INTO captcha_challenges (challenge_id, answer, expires_at)
            VALUES (?, ?, ?)
        """, (challenge_id, answer.upper(), expires_at))


def verify_captcha(challenge_id: str, answer: str) -> bool:
    """Verify CAPTCHA answer and delete challenge."""
    with _conn() as con:
        row = con.execute("""
            SELECT id, answer FROM captcha_challenges
            WHERE challenge_id=? AND datetime('now') < expires_at
        """, (challenge_id,)).fetchone()
        if not row:
            return False
        # Delete used challenge
        con.execute("DELETE FROM captcha_challenges WHERE id=?", (row['id'],))
        return row['answer'] == answer.upper()


def cleanup_expired_captchas():
    """Remove expired captchas."""
    with _conn() as con:
        con.execute(
            "DELETE FROM captcha_challenges WHERE datetime('now') > expires_at"
        )


def create_recovery_key(user_id: int, key_hash: str) -> int:
    """Create a recovery key for user."""
    with _conn() as con:
        # Remove old unused keys
        con.execute(
            "DELETE FROM recovery_keys WHERE user_id=? AND used_at IS NULL",
            (user_id,)
        )
        cur = con.execute("""
            INSERT INTO recovery_keys (user_id, key_hash)
            VALUES (?, ?)
        """, (user_id, key_hash))
        return cur.lastrowid


def use_recovery_key(key_hash: str) -> Optional[int]:
    """Use recovery key, return user_id if valid.

    Atomic claim: the UPDATE itself filters on `used_at IS NULL` and we
    accept the redemption only when SQLite reports rowcount == 1. This
    closes a TOCTOU race where two parallel /recover requests with the
    same key could both read NULL and both mark themselves successful.
    """
    with _conn() as con:
        # First locate the row id and owner so we can issue a single
        # conditional UPDATE that only succeeds for the first caller.
        row = con.execute(
            "SELECT id, user_id FROM recovery_keys WHERE key_hash=? AND used_at IS NULL",
            (key_hash,),
        ).fetchone()
        if not row:
            return None
        cur = con.execute(
            "UPDATE recovery_keys SET used_at=datetime('now') "
            "WHERE id=? AND used_at IS NULL",
            (row["id"],),
        )
        con.commit()
        if cur.rowcount != 1:
            # Another concurrent /recover already claimed this key.
            return None
        return row["user_id"]


# ===========================================================================
# PHASE 9 — Social / Followers
# ===========================================================================

def follow_user(follower_id: int, following_id: int) -> bool:
    """Follow a user. Returns True on success, False if already following."""
    if follower_id == following_id:
        return False
    try:
        with _conn() as con:
            con.execute("INSERT INTO followers (follower_id, following_id) VALUES (?,?)",
                        (follower_id, following_id))
            con.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def unfollow_user(follower_id: int, following_id: int) -> bool:
    with _conn() as con:
        cur = con.execute("DELETE FROM followers WHERE follower_id=? AND following_id=?",
                          (follower_id, following_id))
        con.commit()
    return cur.rowcount > 0


def is_following(follower_id: int, following_id: int) -> bool:
    with _conn() as con:
        row = con.execute("SELECT 1 FROM followers WHERE follower_id=? AND following_id=?",
                          (follower_id, following_id)).fetchone()
    return row is not None


def get_follower_count(user_id: int) -> int:
    with _conn() as con:
        row = con.execute("SELECT COUNT(*) as c FROM followers WHERE following_id=?",
                          (user_id,)).fetchone()
    return row["c"] if row else 0


def get_following_count(user_id: int) -> int:
    with _conn() as con:
        row = con.execute("SELECT COUNT(*) as c FROM followers WHERE follower_id=?",
                          (user_id,)).fetchone()
    return row["c"] if row else 0


def get_post_count(user_id: int) -> int:
    with _conn() as con:
        row = con.execute("SELECT COUNT(*) as c FROM wall_posts WHERE user_id=?",
                          (user_id,)).fetchone()
    return row["c"] if row else 0


def get_followers_list(user_id: int, limit: int = 50) -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT u.id, u.nickname, u.avatar, u.bio
            FROM followers f JOIN users u ON f.follower_id = u.id
            WHERE f.following_id=?
            ORDER BY f.created_at DESC LIMIT ?
        """, (user_id, limit)).fetchall()
    return [dict(r) for r in rows]


def get_following_list(user_id: int, limit: int = 50) -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT u.id, u.nickname, u.avatar, u.bio
            FROM followers f JOIN users u ON f.following_id = u.id
            WHERE f.follower_id=?
            ORDER BY f.created_at DESC LIMIT ?
        """, (user_id, limit)).fetchall()
    return [dict(r) for r in rows]


def _calculate_post_score(context: str = 'explore', post_alias: str = 'wp') -> str:
    """Return a reusable SQL score expression for post-ranking surfaces.

    The same primitive signals are shared across Explore/Reels/Music, with only
    context-specific weights changing. Callers append their own DESC/tiebreaker.

    PERFORMANCE: Uses the materialized counter columns on wall_posts
    (reaction_count, repost_count, comment_count) instead of correlated
    COUNT(*) subqueries. Previously every candidate row triggered 4
    sub-SELECTs against wall_post_reactions/wall_reposts/wall_comments
    BEFORE the LIMIT was applied, which made Explore/Reels ranking O(N*4)
    on the whole public-post set. With materialized columns the ranking
    expression collapses to plain arithmetic on already-loaded columns.
    """
    alias = str(post_alias or 'wp')
    reactions = f"COALESCE({alias}.reaction_count, 0)"
    reposts = f"COALESCE({alias}.repost_count, 0)"
    comments = f"COALESCE({alias}.comment_count, 0)"
    media_bonus = f"CASE WHEN {alias}.media_type IS NOT NULL AND {alias}.media_type != '' THEN 3 ELSE 0 END"
    recency = (
        f"CASE WHEN julianday('now') - julianday({alias}.created_at) < 1 THEN 10 "
        f"WHEN julianday('now') - julianday({alias}.created_at) < 7 THEN 5 ELSE 0 END"
    )

    if context == 'explore_top':
        return f"({reactions} + ({reposts} * 2))"
    if context == 'reels_top':
        # Heart-vs-other split is not materialized; reaction_count is a fine proxy.
        return reactions
    if context == 'reels_hot':
        return f"(({reactions} * 3) + ({reposts} * 2) + {comments} + {recency})"
    return f"(({reactions} * 2) + ({reposts} * 2) + {comments} + {media_bonus} + {recency})"


def get_feed_posts(user_id: int, limit: int = 30, offset: int = 0,
                   mood: str = '', lite: bool = False) -> List[Dict]:
    """Posts from users the current user follows + own posts, newest first.

    Optional `mood` narrows to music-tagged posts with matching `track_mood`.
    When `lite` is True, we include media_data for images/videos/music (all needed
    for rendering). These are either small URLs or decoded on-demand.
    """
    mood = (mood or '').strip().lower()
    # In lite mode, only keep media_data for music posts — those are short
    # URL references (~50 bytes). Image/video media_data is the full base64
    # data URI (often 5–45 MB per row), which is what was making `lite=1`
    # feed responses tens of megabytes. The router substitutes a lazy URL
    # `/api/social/posts/{id}/media` whenever media_data is NULL, so the
    # client lazy-loads images and videos on scroll instead of inlining.
    media_col = (
        "CASE WHEN wp.media_type LIKE 'music/%' "
        "THEN wp.media_data ELSE NULL END AS media_data"
        if lite else "wp.media_data"
    )
    fetch_limit = max(120, int(limit or 30) * 4 + int(offset or 0))
    with _conn() as con:
        base_rows = con.execute(f"""
            SELECT wp.id, wp.user_id, wp.content, {media_col}, wp.media_type, wp.privacy,
                   wp.share_enabled, wp.allow_comments, wp.created_at, wp.edited_at,
                   wp.track_title, wp.track_room, wp.track_mood,
                   (wp.media_type IS NOT NULL AND wp.media_type != '') AS has_media,
                   u.nickname, u.avatar, u.display_name, u.is_admin AS is_admin,
                   wp.reaction_count AS reaction_count,
                   wp.comment_count AS comment_count,
                   wp.repost_count AS repost_count,
                   EXISTS(SELECT 1 FROM wall_reposts wr WHERE wr.post_id=wp.id AND wr.user_id=?) AS i_reposted,
                   'post' AS feed_kind,
                   wp.created_at AS feed_sort_at,
                   NULL AS repost_by_user_id,
                   NULL AS repost_by_nickname,
                   NULL AS repost_by_avatar,
                   NULL AS repost_quote
            FROM wall_posts wp
            JOIN users u ON wp.user_id = u.id
            LEFT JOIN followers f ON f.following_id = wp.user_id AND f.follower_id = ?
            WHERE (f.follower_id IS NOT NULL OR wp.user_id = ?)
              AND wp.privacy IN ('public', 'followers', 'friends')
              AND wp.user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id=?)
              AND wp.user_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id=?)
              AND (? = '' OR (
                    wp.media_type LIKE 'music/%'
                    AND lower(trim(coalesce(wp.track_mood,''))) = ?
              ))
            ORDER BY wp.created_at DESC
            LIMIT ?
        """, (user_id, user_id, user_id, user_id, user_id, mood, mood, fetch_limit)).fetchall()

        repost_rows = con.execute(f"""
            SELECT wp.id, wp.user_id, wp.content, {media_col}, wp.media_type, wp.privacy,
                   wp.share_enabled, wp.allow_comments, wp.created_at, wp.edited_at,
                   wp.track_title, wp.track_room, wp.track_mood,
                   (wp.media_type IS NOT NULL AND wp.media_type != '') AS has_media,
                   u.nickname, u.avatar, u.display_name, u.is_admin AS is_admin,
                   wp.reaction_count AS reaction_count,
                   wp.comment_count AS comment_count,
                   wp.repost_count AS repost_count,
                   EXISTS(SELECT 1 FROM wall_reposts wr2 WHERE wr2.post_id=wp.id AND wr2.user_id=?) AS i_reposted,
                   'repost' AS feed_kind,
                   wr.created_at AS feed_sort_at,
                   wr.user_id AS repost_by_user_id,
                   ru.nickname AS repost_by_nickname,
                   ru.avatar AS repost_by_avatar,
                   wr.quote_text AS repost_quote
            FROM wall_reposts wr
            JOIN wall_posts wp ON wp.id = wr.post_id
            JOIN users u ON u.id = wp.user_id
            JOIN users ru ON ru.id = wr.user_id
            LEFT JOIN followers rf ON rf.following_id = wr.user_id AND rf.follower_id = ?
            WHERE (rf.follower_id IS NOT NULL OR wr.user_id = ?)
              AND wp.share_enabled = 1
              AND wp.privacy IN ('public', 'followers')
              AND ru.id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id=?)
              AND ru.id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id=?)
              AND wp.user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id=?)
              AND wp.user_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id=?)
              AND (
                    wp.privacy = 'public'
                    OR wp.user_id = ?
                    OR (
                        wp.privacy = 'followers' AND (
                            EXISTS(SELECT 1 FROM followers fx WHERE fx.follower_id=? AND fx.following_id=wp.user_id)
                            OR EXISTS(
                                SELECT 1 FROM friends fr
                                WHERE ((fr.user_id=? AND fr.friend_id=wp.user_id)
                                       OR (fr.user_id=wp.user_id AND fr.friend_id=?))
                                  AND fr.status='accepted'
                            )
                        )
                    )
              )
              AND (? = '' OR (
                    wp.media_type LIKE 'music/%'
                    AND lower(trim(coalesce(wp.track_mood,''))) = ?
              ))
            ORDER BY wr.created_at DESC
            LIMIT ?
        """, (
            user_id,
            user_id, user_id,
            user_id, user_id, user_id, user_id,
            user_id,
            user_id,
            user_id, user_id,
            mood, mood,
            fetch_limit,
        )).fetchall()

    merged: List[Dict] = []
    best_by_post: Dict[int, Dict] = {}
    for row in list(base_rows) + list(repost_rows):
        d = dict(row)
        pid = int(d.get("id") or 0)
        ts = str(d.get("feed_sort_at") or d.get("created_at") or "")
        existing = best_by_post.get(pid)
        if not existing:
            best_by_post[pid] = d
            continue
        existing_ts = str(existing.get("feed_sort_at") or existing.get("created_at") or "")
        if ts > existing_ts or (ts == existing_ts and d.get("feed_kind") == "repost"):
            best_by_post[pid] = d

    merged = sorted(best_by_post.values(), key=lambda x: str(x.get("feed_sort_at") or x.get("created_at") or ""), reverse=True)
    start = max(0, int(offset or 0))
    end = start + max(1, int(limit or 30))
    return merged[start:end]


def get_explore_posts(viewer_id: int, limit: int = 30, offset: int = 0,
                      sort: str = 'trending', mood: str = '',
                      lite: bool = False, friends_only: bool = False) -> List[Dict]:
    """All public posts — discover new people. Supports trending/new/top sort.

    Optional `mood` narrows to music-tagged posts with matching `track_mood`.
    When `lite` is True, we include media_data for images/videos/music (all needed
    for rendering).
    When `friends_only` is True, filter to posts posted/reposted/reacted by accepted friends.
    """
    mood = (mood or '').strip().lower()
    # In lite mode, only keep media_data for music posts (small URL refs).
    # Image/video are NULLed so the router substitutes a lazy-load URL and
    # the client only fetches the actual bytes on scroll. See get_feed_posts.
    media_col = (
        "CASE WHEN wp.media_type LIKE 'music/%' "
        "THEN wp.media_data ELSE NULL END AS media_data"
        if lite else "wp.media_data"
    )
    with _conn() as con:
        if sort == 'top':
            order = f"{_calculate_post_score('explore_top')} DESC, wp.created_at DESC"
        elif sort == 'new':
            order = "wp.created_at DESC"
        else:  # trending — mix of recency + engagement
            order = f"{_calculate_post_score('explore')} DESC, wp.created_at DESC"
        rows = con.execute(f"""
            SELECT wp.id, wp.user_id, wp.content, {media_col}, wp.media_type, wp.privacy,
                   wp.allow_comments, wp.created_at, wp.edited_at,
                   wp.track_title, wp.track_room, wp.track_mood,
                   (wp.media_type IS NOT NULL AND wp.media_type != '') AS has_media,
                   u.nickname, u.avatar,
                   wp.reaction_count as reaction_count,
                     wp.comment_count as comment_count,
                     wp.repost_count as repost_count,
                     EXISTS(SELECT 1 FROM wall_reposts wr WHERE wr.post_id=wp.id AND wr.user_id=?) AS i_reposted
            FROM wall_posts wp
            JOIN users u ON wp.user_id = u.id
            WHERE wp.privacy = 'public'
              AND wp.user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id=?)
              AND wp.user_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id=?)
                            AND (? = '' OR (
                                        wp.media_type LIKE 'music/%'
                                        AND lower(trim(coalesce(wp.track_mood,''))) = ?
                            ))
            ORDER BY {order}
            LIMIT ? OFFSET ?
                """, (viewer_id, viewer_id, viewer_id, mood, mood, limit, offset)).fetchall()
    return [dict(r) for r in rows]


def get_suggested_users(user_id: int, limit: int = 10) -> List[Dict]:
    """Instagram-style suggestions: ranks by mutual follows first, then
    follower count + post activity. Returns up to `limit` users the viewer
    does not already follow (and excludes self).

    Adds `mutual_count` (int) + `mutual_sample` (comma-separated nicknames
    of up to 2 mutuals) so the UI can show "Followed by @alice + N others".
    """
    with _conn() as con:
        rows = con.execute("""
            SELECT MIN(u.id) as id, u.nickname, u.avatar, u.bio,
                   (SELECT COUNT(*) FROM followers WHERE following_id=u.id) as follower_count,
                   (SELECT COUNT(*) FROM wall_posts WHERE user_id=u.id) as post_count,
                   (SELECT COUNT(*) FROM followers fm
                      WHERE fm.following_id = u.id
                        AND fm.follower_id IN
                            (SELECT following_id FROM followers WHERE follower_id=?)
                   ) as mutual_count,
                   (SELECT GROUP_CONCAT(nick, ',') FROM (
                       SELECT u2.nickname AS nick
                       FROM followers fm2
                       JOIN users u2 ON u2.id = fm2.follower_id
                       WHERE fm2.following_id = u.id
                         AND fm2.follower_id IN
                             (SELECT following_id FROM followers WHERE follower_id=?)
                       LIMIT 2
                   )) as mutual_sample
            FROM users u
            WHERE u.id != ?
              AND LOWER(u.nickname) != LOWER(COALESCE(
                    (SELECT nickname FROM users WHERE id=?), ''))
              AND u.id NOT IN (SELECT following_id FROM followers WHERE follower_id=?)
              AND u.id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id=?)
              AND u.id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id=?)
                            AND LOWER(u.nickname) NOT GLOB 'soc[0-9]*'
                            AND LOWER(u.nickname) NOT GLOB 'socb[0-9]*'
                            AND (
                                        TRIM(COALESCE(u.avatar, '')) != ''
                                 OR TRIM(COALESCE(u.bio, '')) != ''
                                 OR EXISTS(SELECT 1 FROM wall_posts wp WHERE wp.user_id=u.id)
                                 OR EXISTS(SELECT 1 FROM followers f WHERE f.following_id=u.id)
                            )
            GROUP BY LOWER(u.nickname)
            ORDER BY mutual_count DESC, follower_count DESC, post_count DESC, u.id DESC
            LIMIT ?
        """, (user_id, user_id, user_id, user_id, user_id, user_id, user_id, limit)).fetchall()
    return [dict(r) for r in rows]


def get_user_channel_media(user_id: int, limit: int = 50, offset: int = 0) -> List[Dict]:
    """Get all media messages sent by a user across channels that have not
    already been promoted to their public wall. `posted_to_wall = 1` means
    the user hit "Make Public" on that item, so we hide it here to keep
    Private Media a true inbox of still-private uploads."""
    with _conn() as con:
        rows = con.execute("""
            SELECT id, room_name, media_type, created_at
            FROM messages
            WHERE user_id = ?
              AND media_data IS NOT NULL
              AND (posted_to_wall IS NULL OR posted_to_wall = 0)
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        """, (user_id, limit, offset)).fetchall()
    return [dict(r) for r in rows]


# ===========================================================================
# Music channels — queue + DJ roles
# ===========================================================================

def music_add_track(room_name: str, submitter_id: int, submitter_nick: str,
                    provider: str, video_id: str, url: str,
                    title: str = "", thumbnail: str = "", duration: int = 0) -> int:
    with _conn() as con:
        cur = con.execute(
            """INSERT INTO music_queue
               (room_name, submitter_id, submitter_nick, provider, video_id, url, title, thumbnail, duration)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (room_name, submitter_id, submitter_nick, provider, video_id, url, title, thumbnail, duration)
        )
        con.commit()
        return cur.lastrowid


def music_get_queue(room_name: str, include_played: bool = False, limit: int = 200) -> List[Dict]:
    with _conn() as con:
        if include_played:
            rows = con.execute(
                "SELECT * FROM music_queue WHERE room_name=? ORDER BY id DESC LIMIT ?",
                (room_name, limit)
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM music_queue WHERE room_name=? AND played=0 ORDER BY id ASC LIMIT ?",
                (room_name, limit)
            ).fetchall()
    return [dict(r) for r in rows]


def music_mark_played(track_id: int, room_name: str) -> bool:
    with _conn() as con:
        cur = con.execute(
            "UPDATE music_queue SET played=1 WHERE id=? AND room_name=?",
            (track_id, room_name)
        )
        con.commit()
        return cur.rowcount > 0


def music_delete_track(track_id: int, room_name: str) -> bool:
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM music_queue WHERE id=? AND room_name=?",
            (track_id, room_name)
        )
        con.commit()
        return cur.rowcount > 0


def music_clear_queue(room_name: str) -> int:
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM music_queue WHERE room_name=? AND played=0",
            (room_name,)
        )
        con.commit()
        return cur.rowcount


def music_get_current(room_name: str) -> Optional[Dict]:
    """Get the next unplayed track (head of queue)."""
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM music_queue WHERE room_name=? AND played=0 ORDER BY id ASC LIMIT 1",
            (room_name,)
        ).fetchone()
    return dict(row) if row else None


def _music_anchor_config_key(room_name: str) -> str:
    return f"music.anchor.{str(room_name or '').strip().lower()}"


def set_music_room_anchor(room_name: str, track_id: int, started_unix: float) -> bool:
    try:
        payload = json.dumps({
            "track_id": int(track_id),
            "started_unix": float(started_unix),
        })
        set_config(_music_anchor_config_key(room_name), payload)
        return True
    except Exception:
        return False


def get_music_room_anchor(room_name: str) -> Optional[Dict]:
    raw = get_config(_music_anchor_config_key(room_name))
    if not raw:
        return None
    try:
        payload = json.loads(raw)
        track_id = int(payload.get("track_id") or 0)
        started_unix = float(payload.get("started_unix") or 0)
        if track_id <= 0 or started_unix <= 0:
            return None
        return {
            "track_id": track_id,
            "started_unix": started_unix,
        }
    except Exception:
        return None


def clear_music_room_anchor(room_name: str) -> bool:
    with _conn() as con:
        cur = con.execute("DELETE FROM config WHERE key=?", (_music_anchor_config_key(room_name),))
        con.commit()
        return cur.rowcount > 0


def dj_add(room_name: str, user_id: int, granted_by: int) -> bool:
    try:
        with _conn() as con:
            con.execute(
                "INSERT OR IGNORE INTO room_djs (room_name, user_id, granted_by) VALUES (?,?,?)",
                (room_name, user_id, granted_by)
            )
            con.commit()
        return True
    except Exception:
        return False


def dj_remove(room_name: str, user_id: int) -> bool:
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM room_djs WHERE room_name=? AND user_id=?",
            (room_name, user_id)
        )
        con.commit()
        return cur.rowcount > 0


def dj_list(room_name: str) -> List[Dict]:
    with _conn() as con:
        rows = con.execute(
            """SELECT rd.user_id, u.nickname, u.avatar, rd.created_at
               FROM room_djs rd LEFT JOIN users u ON u.id = rd.user_id
               WHERE rd.room_name=? ORDER BY rd.id ASC""",
            (room_name,)
        ).fetchall()
    return [dict(r) for r in rows]


def dj_is(room_name: str, user_id: int) -> bool:
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM room_djs WHERE room_name=? AND user_id=? LIMIT 1",
            (room_name, user_id)
        ).fetchone()
    return bool(row)


def room_set_dj_only(room_name: str, dj_only: int) -> bool:
    with _conn() as con:
        cur = con.execute(
            "UPDATE rooms SET dj_only_queue=? WHERE name=?",
            (1 if dj_only else 0, room_name)
        )
        con.commit()
        return cur.rowcount > 0


# ===========================================================================
# PHASE 10 — Telegram Bridge
# ===========================================================================

def create_telegram_bridge(room_name: str, telegram_chat_id: int, bot_token: str,
                           bot_name: str, owner_id: int,
                           telegram_chat_title: str = "") -> Optional[int]:
    try:
        with _conn() as con:
            cur = con.execute(
                """INSERT INTO telegram_bridges (room_name, telegram_chat_id, telegram_chat_title, bot_token, bot_name, owner_id)
                   VALUES (?,?,?,?,?,?)""",
                (room_name, telegram_chat_id, telegram_chat_title or "",
                 _encrypt_bridge_token(bot_token), bot_name, owner_id))
            con.commit()
            return cur.lastrowid
    except Exception:
        return None


def _decrypt_bridge_rows(rows):
    """Helper: pass a list of dict rows from telegram_bridges /
    discord_bridges, decrypt each bot_token in place. Plaintext rows
    (pre-migration) are returned untouched. Used by every getter so
    callers always see plaintext."""
    out = []
    for r in rows:
        d = dict(r)
        if "bot_token" in d:
            d["bot_token"] = _decrypt_bridge_token(d["bot_token"])
        out.append(d)
    return out


def get_telegram_bridges(owner_id: int = None) -> List[Dict]:
    with _conn() as con:
        if owner_id:
            rows = con.execute(
                "SELECT * FROM telegram_bridges WHERE owner_id=? ORDER BY id", (owner_id,)
            ).fetchall()
        else:
            rows = con.execute("SELECT * FROM telegram_bridges ORDER BY id").fetchall()
    return _decrypt_bridge_rows(rows)


def get_telegram_bridges_for_room(room_name: str) -> List[Dict]:
    with _conn() as con:
        rows = con.execute(
            "SELECT * FROM telegram_bridges WHERE room_name=? AND enabled=1", (room_name,)
        ).fetchall()
    return _decrypt_bridge_rows(rows)


def delete_telegram_bridge(bridge_id: int, owner_id: int) -> bool:
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM telegram_bridges WHERE id=? AND owner_id=?", (bridge_id, owner_id))
        con.commit()
        return cur.rowcount > 0


def toggle_telegram_bridge(bridge_id: int, owner_id: int, enabled: bool) -> bool:
    with _conn() as con:
        cur = con.execute(
            "UPDATE telegram_bridges SET enabled=? WHERE id=? AND owner_id=?",
            (1 if enabled else 0, bridge_id, owner_id))
        con.commit()
        return cur.rowcount > 0


# PHASE 10 — Discord Bridge
# ---------------------------------------------------------------------------

def create_discord_bridge(room_name: str, discord_channel_id: int, bot_token: str,
                          bot_name: str, owner_id: int, discord_guild_id: int = 0,
                          discord_channel_name: str = "",
                          discord_guild_name: str = "") -> Optional[int]:
    try:
        with _conn() as con:
            cur = con.execute(
                """INSERT INTO discord_bridges (room_name, discord_channel_id, discord_guild_id,
                                               discord_channel_name, discord_guild_name,
                                               bot_token, bot_name, owner_id)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (room_name, discord_channel_id, discord_guild_id,
                 discord_channel_name or "", discord_guild_name or "",
                 _encrypt_bridge_token(bot_token), bot_name, owner_id))
            con.commit()
            return cur.lastrowid
    except Exception:
        return None


def get_discord_bridges(owner_id: int = None) -> List[Dict]:
    with _conn() as con:
        if owner_id is not None:
            rows = con.execute(
                "SELECT * FROM discord_bridges WHERE owner_id=? ORDER BY id", (owner_id,)
            ).fetchall()
        else:
            rows = con.execute("SELECT * FROM discord_bridges ORDER BY id").fetchall()
    return _decrypt_bridge_rows(rows)


def get_discord_bridges_for_room(room_name: str) -> List[Dict]:
    with _conn() as con:
        rows = con.execute(
            "SELECT * FROM discord_bridges WHERE room_name=? AND enabled=1", (room_name,)
        ).fetchall()
    return _decrypt_bridge_rows(rows)


def delete_discord_bridge(bridge_id: int, owner_id: int) -> bool:
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM discord_bridges WHERE id=? AND owner_id=?", (bridge_id, owner_id))
        con.commit()
        return cur.rowcount > 0


def toggle_discord_bridge(bridge_id: int, owner_id: int, enabled: bool) -> bool:
    with _conn() as con:
        cur = con.execute(
            "UPDATE discord_bridges SET enabled=? WHERE id=? AND owner_id=?",
            (1 if enabled else 0, bridge_id, owner_id))
        con.commit()
        return cur.rowcount > 0


# ===========================================================================
# Stories
# ===========================================================================

def create_story(user_id: int, media_data: str, media_type: str, caption: str = '',
                 privacy: str = 'public') -> int:
    if privacy not in ('public', 'followers'):
        privacy = 'public'
    with _conn() as con:
        cur = con.execute(
            "INSERT INTO stories (user_id, media_data, media_type, caption, privacy) VALUES (?,?,?,?,?)",
            (user_id, media_data, media_type, caption, privacy))
        con.commit()
        return cur.lastrowid


def get_active_story_owners(viewer_id: int) -> List[Dict]:
    """Return all users with active stories visible to `viewer_id`, lightweight.

    Visibility rules (broader than get_stories_feed which is follow-gated for
    the stories *bar*): own stories always; public stories from anyone;
    followers-only stories only when the viewer follows the author. This
    powers chat-avatar story rings, where we want a ring to appear for any
    user whose story this viewer is allowed to open — including users they
    don't follow but who post public stories.

    Returns: [{user_id, nickname, avatar, count, has_unviewed}]
    """
    with _conn() as con:
        rows = con.execute("""
            SELECT s.user_id,
                   u.nickname,
                   u.avatar,
                   COALESCE(s.privacy,'public') AS privacy,
                   EXISTS(SELECT 1 FROM story_views sv
                          WHERE sv.story_id=s.id AND sv.user_id=?) AS viewed,
                   EXISTS(SELECT 1 FROM followers f
                          WHERE f.follower_id=? AND f.following_id=s.user_id) AS follows
            FROM stories s
            JOIN users u ON s.user_id = u.id
            WHERE s.expires_at > datetime('now')
        """, (viewer_id, viewer_id)).fetchall()
    by_user: Dict[int, Dict] = {}
    for r in rows:
        owner = r["user_id"]
        privacy = r["privacy"]
        # Visibility filter: own → always; public → always; followers → only if follows.
        if owner != viewer_id:
            if privacy == "followers" and not r["follows"]:
                continue
            if privacy not in ("public", "followers"):
                continue
        bucket = by_user.get(owner)
        if not bucket:
            bucket = {
                "user_id": owner,
                "nickname": r["nickname"],
                "avatar": r["avatar"],
                "count": 0,
                "has_unviewed": 0,
            }
            by_user[owner] = bucket
        bucket["count"] += 1
        if not r["viewed"]:
            bucket["has_unviewed"] = 1
    return list(by_user.values())


def get_stories_feed(viewer_id: int) -> List[Dict]:
    """Get active stories the viewer is allowed to see (+ own), grouped by user.

    NOTE: media_data is intentionally omitted to keep the list payload small.
    Clients lazy-load the full payload via /api/social/stories/{id}/media.
    """
    with _conn() as con:
        rows = con.execute("""
            SELECT s.id, s.user_id, s.media_type, s.caption, s.created_at,
                   (s.media_type IS NOT NULL AND s.media_type != '') AS has_media,
                   COALESCE(s.privacy,'public') AS privacy,
                   u.nickname, u.avatar,
                   EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id=s.id AND sv.user_id=?) AS viewed
            FROM stories s
            JOIN users u ON s.user_id = u.id
            WHERE s.expires_at > datetime('now')
              AND (
                   s.user_id = ?
                   OR (
                        s.user_id IN (SELECT following_id FROM followers WHERE follower_id = ?)
                        AND (
                             COALESCE(s.privacy,'public') = 'public'
                             OR (COALESCE(s.privacy,'public') = 'followers'
                                 AND EXISTS(SELECT 1 FROM followers f2 WHERE f2.follower_id=? AND f2.following_id=s.user_id))
                        )
                   )
              )
            ORDER BY s.user_id, s.created_at
        """, (viewer_id, viewer_id, viewer_id, viewer_id)).fetchall()
    return [dict(r) for r in rows]


def mark_story_viewed(story_id: int, user_id: int):
    with _conn() as con:
        con.execute(
            "INSERT OR IGNORE INTO story_views (story_id, user_id) VALUES (?,?)",
            (story_id, user_id))
        con.commit()


def user_active_story_status(owner_id: int, viewer_id: int) -> Dict[str, int]:
    """Lightweight: does the user have active stories visible to the viewer, and are any unviewed?"""
    with _conn() as con:
        rows = con.execute("""
            SELECT s.id,
                   COALESCE(s.privacy,'public') AS privacy,
                   EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id=s.id AND sv.user_id=?) AS viewed
            FROM stories s
            WHERE s.user_id = ? AND s.expires_at > datetime('now')
        """, (viewer_id, owner_id)).fetchall()
    if not rows:
        return {"count": 0, "has_unviewed": 0}
    # Filter by privacy unless the viewer is the owner.
    # Public stories are visible to anyone; followers-only stories require
    # a follow relationship. Without this, public stories of non-followed
    # users would be hidden — which is wrong, since the same stories show
    # up in /stories/active.
    if viewer_id == owner_id:
        visible = rows
    else:
        with _conn() as con:
            follows = con.execute(
                "SELECT 1 FROM followers WHERE follower_id=? AND following_id=?",
                (viewer_id, owner_id)).fetchone()
        visible = []
        for r in rows:
            if r["privacy"] == "public":
                visible.append(r)
            elif r["privacy"] == "followers" and follows:
                visible.append(r)
    if not visible:
        return {"count": 0, "has_unviewed": 0}
    return {
        "count": len(visible),
        "has_unviewed": 1 if any(not r["viewed"] for r in visible) else 0,
    }


def get_user_stories(owner_id: int, viewer_id: int) -> List[Dict]:
    """Return the active stories of `owner_id` that `viewer_id` is allowed to see.

    Mirrors `get_stories_feed` shape but for a single user, with no follow
    requirement for public stories. Used when viewers tap a chat avatar of
    a user they don't follow but who has posted public stories.
    """
    with _conn() as con:
        follows_row = con.execute(
            "SELECT 1 FROM followers WHERE follower_id=? AND following_id=?",
            (viewer_id, owner_id)).fetchone()
        follows = bool(follows_row)
        rows = con.execute("""
            SELECT s.id, s.user_id, s.media_type, s.caption, s.created_at,
                   (s.media_type IS NOT NULL AND s.media_type != '') AS has_media,
                   COALESCE(s.privacy,'public') AS privacy,
                   u.nickname, u.avatar,
                   EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id=s.id AND sv.user_id=?) AS viewed
            FROM stories s
            JOIN users u ON s.user_id = u.id
            WHERE s.user_id = ? AND s.expires_at > datetime('now')
            ORDER BY s.created_at
        """, (viewer_id, owner_id)).fetchall()
    out: List[Dict] = []
    for r in rows:
        if owner_id != viewer_id:
            if r["privacy"] == "followers" and not follows:
                continue
            if r["privacy"] not in ("public", "followers"):
                continue
        out.append(dict(r))
    return out


def delete_story(story_id: int, user_id: int) -> bool:
    with _conn() as con:
        cur = con.execute("DELETE FROM stories WHERE id=? AND user_id=?", (story_id, user_id))
        con.commit()
        return cur.rowcount > 0


def get_story_viewers(story_id: int) -> List[Dict]:
    with _conn() as con:
        rows = con.execute("""
            SELECT u.id, u.nickname, u.avatar, sv.viewed_at
            FROM story_views sv JOIN users u ON sv.user_id = u.id
            WHERE sv.story_id = ? ORDER BY sv.viewed_at DESC
        """, (story_id,)).fetchall()
    return [dict(r) for r in rows]


def cleanup_expired_stories():
    """Delete expired stories and their views."""
    with _conn() as con:
        con.execute("DELETE FROM stories WHERE expires_at <= datetime('now')")
        con.commit()


# ===========================================================================
# Room membership
# ===========================================================================

def join_room(user_id: int, room_id: int):
    with _conn() as con:
        con.execute("INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?,?)",
                    (room_id, user_id))
        con.commit()


def leave_room(user_id: int, room_id: int):
    """Remove user from room. If the leaver is the owner, transfer ownership
    to the longest-serving moderator; if no moderators exist, delete the room."""
    with _conn() as con:
        # Check ownership before removing membership
        row = con.execute("SELECT owner_id FROM rooms WHERE id=?", (room_id,)).fetchone()
        is_owner = bool(row and row["owner_id"] == user_id)
        # Remove membership
        con.execute("DELETE FROM room_members WHERE room_id=? AND user_id=?",
                    (room_id, user_id))
        if is_owner:
            # Find the longest-serving (earliest-added) moderator who isn't the departing owner
            new_owner = con.execute("""
                SELECT user_id FROM room_moderators
                WHERE room_id=? AND user_id!=?
                ORDER BY added_at ASC, user_id ASC
                LIMIT 1
            """, (room_id, user_id)).fetchone()
            if new_owner:
                new_owner_id = new_owner["user_id"]
                con.execute("UPDATE rooms SET owner_id=? WHERE id=?",
                            (new_owner_id, room_id))
                # Remove them from mods list since they're now the owner
                con.execute("DELETE FROM room_moderators WHERE room_id=? AND user_id=?",
                            (room_id, new_owner_id))
                # Make sure the new owner is a member of the room
                con.execute("INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?,?)",
                            (room_id, new_owner_id))
            else:
                # No moderators — delete the room entirely
                con.execute("DELETE FROM rooms WHERE id=?", (room_id,))
        con.commit()


def get_user_joined_room_ids(user_id: int) -> set:
    with _conn() as con:
        rows = con.execute("SELECT room_id FROM room_members WHERE user_id=?", (user_id,)).fetchall()
    return {r["room_id"] for r in rows}


def is_room_member(user_id: int, room_id: int) -> bool:
    with _conn() as con:
        row = con.execute("SELECT 1 FROM room_members WHERE room_id=? AND user_id=?",
                         (room_id, user_id)).fetchone()
    return row is not None


def transfer_room_ownership(room_id: int, current_owner_id: int, new_owner_id: int) -> Dict:
    """Atomically transfer ownership of a room.

    Returns a dict describing the result:
      {"ok": True, "previous_owner_id": <id>, "new_owner_id": <id>}
      {"ok": False, "error": "<reason>"}

    Guarantees, all in a single transaction so a racing /join, /leave or
    parallel transfer can't leave the room half-owned:
      * the calling user is still the current owner
      * the new owner exists and is a member of the room (auto-joined if not)
      * the new owner is removed from the moderators list (owner already
        has every mod power, so leaving them duplicated muddies the UI)
      * the previous owner is added to the moderators list so they keep
        delete/ban powers and don't lock themselves out of moderation
    """
    if int(current_owner_id) == int(new_owner_id):
        return {"ok": False, "error": "User is already the owner"}
    with _conn() as con:
        # IMMEDIATE upgrades the implicit transaction so the SELECT below
        # is part of the same write barrier as the UPDATE — required to
        # make the owner check race-safe under SQLite's WAL mode.
        con.execute("BEGIN IMMEDIATE")
        try:
            row = con.execute(
                "SELECT owner_id FROM rooms WHERE id=?", (room_id,)
            ).fetchone()
            if not row:
                con.execute("ROLLBACK")
                return {"ok": False, "error": "Room not found"}
            if int(row["owner_id"]) != int(current_owner_id):
                con.execute("ROLLBACK")
                return {"ok": False, "error": "Only the current owner can transfer ownership"}
            target = con.execute(
                "SELECT id FROM users WHERE id=?", (new_owner_id,)
            ).fetchone()
            if not target:
                con.execute("ROLLBACK")
                return {"ok": False, "error": "Target user not found"}
            # Make sure target is a member; auto-join is harmless and prevents
            # a hostile UI flow that hands ownership to a non-member who
            # then can't even open the channel without rejoining.
            con.execute(
                "INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?,?)",
                (room_id, new_owner_id),
            )
            # Pull the new owner out of the mods list (they're about to
            # outrank that role) and add the outgoing owner to it so they
            # keep moderation powers.
            con.execute(
                "DELETE FROM room_moderators WHERE room_id=? AND user_id=?",
                (room_id, new_owner_id),
            )
            con.execute(
                "INSERT OR IGNORE INTO room_moderators (room_id, user_id, added_by) VALUES (?,?,?)",
                (room_id, current_owner_id, current_owner_id),
            )
            con.execute(
                "UPDATE rooms SET owner_id=? WHERE id=?",
                (new_owner_id, room_id),
            )
            con.commit()
        except Exception:
            try: con.execute("ROLLBACK")
            except Exception: pass
            import logging as _log_mod
            _log_mod.getLogger(__name__).exception("Database error during ownership transfer")
            return {"ok": False, "error": "Database error"}
    return {
        "ok": True,
        "previous_owner_id": int(current_owner_id),
        "new_owner_id": int(new_owner_id),
    }


def auto_join_defaults(user_id: int):
    """Default-channel auto-join is disabled. Kept as a no-op so any legacy
    callers don't crash. New users start with an empty channel list and can
    accept an invite or create their own channel."""
    return


# ===========================================================================
# Federation helpers
# ===========================================================================

def get_or_create_local_server_identity() -> Dict:
    """Return local server identity, creating persisted defaults if needed."""
    sid = get_config("federation.server_id")
    if not sid:
        sid = f"srv_{uuid.uuid4().hex[:20]}"
        set_config("federation.server_id", sid)

    display_name = get_config("federation.display_name")
    if not display_name:
        display_name = os.getenv("FROGTALK_SERVER_NAME", "FrogTalk Node")
        set_config("federation.display_name", display_name)

    base_url = get_config("federation.base_url")
    if not base_url:
        base_url = os.getenv("FROGTALK_BASE_URL", "")
        set_config("federation.base_url", base_url)

    onion_url = get_config("federation.onion_url")
    if onion_url is None:
        onion_url = os.getenv("FROGTALK_ONION_URL", "")
        set_config("federation.onion_url", onion_url)

    return {
        "server_id": sid,
        "display_name": display_name,
        "base_url": base_url,
        "onion_url": onion_url,
    }


def list_federation_servers(official_only: bool = False) -> List[Dict]:
    with _conn() as con:
        if official_only:
            rows = con.execute(
                """
                SELECT server_id, display_name, base_url, onion_url, region,
                       official, trust_tier, capabilities_json, enabled, last_seen,
                       transport_preference
                FROM federation_servers
                WHERE enabled=1 AND official=1
                ORDER BY display_name COLLATE NOCASE
                """
            ).fetchall()
        else:
            rows = con.execute(
                """
                SELECT server_id, display_name, base_url, onion_url, region,
                       official, trust_tier, capabilities_json, enabled, last_seen,
                       transport_preference
                FROM federation_servers
                WHERE enabled=1
                ORDER BY official DESC, display_name COLLATE NOCASE
                """
            ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["capabilities"] = json.loads(d.pop("capabilities_json") or "[]")
        except Exception:
            d["capabilities"] = []
            d.pop("capabilities_json", None)
        out.append(d)
    return out


def list_federation_servers_admin(include_disabled: bool = True) -> List[Dict]:
    """List federation servers for admin panels.

    Includes `enabled` state so operators can block/unblock peers.
    """
    with _conn() as con:
        if include_disabled:
            rows = con.execute(
                """
                SELECT server_id, display_name, base_url, onion_url, region,
                       official, trust_tier, capabilities_json, enabled, last_seen,
                       transport_preference
                FROM federation_servers
                ORDER BY official DESC, enabled DESC, display_name COLLATE NOCASE
                """
            ).fetchall()
        else:
            rows = con.execute(
                """
                SELECT server_id, display_name, base_url, onion_url, region,
                       official, trust_tier, capabilities_json, enabled, last_seen,
                       transport_preference
                FROM federation_servers
                WHERE enabled=1
                ORDER BY official DESC, display_name COLLATE NOCASE
                """
            ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["capabilities"] = json.loads(d.pop("capabilities_json") or "[]")
        except Exception:
            d["capabilities"] = []
            d.pop("capabilities_json", None)
        out.append(d)
    return out


def set_federation_server_enabled(server_id: str, enabled: bool) -> bool:
    """Enable/disable (block) a federation peer by server_id."""
    sid = (server_id or "").strip()
    if not sid:
        return False
    with _conn() as con:
        cur = con.execute(
            "UPDATE federation_servers SET enabled=? WHERE server_id=?",
            (1 if enabled else 0, sid),
        )
        con.commit()
    return cur.rowcount > 0


def upsert_federation_server(
    server_id: str,
    display_name: str,
    base_url: str,
    onion_url: str = "",
    region: str = "",
    official: bool = False,
    trust_tier: str = "community",
    server_pubkey: str = "",
    capabilities: Optional[List[str]] = None,
) -> None:
    caps_json = json.dumps(capabilities or [])
    with _conn() as con:
        con.execute(
            """
            INSERT INTO federation_servers
            (server_id, display_name, base_url, onion_url, region, official,
             trust_tier, server_pubkey, capabilities_json, enabled, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
            ON CONFLICT(server_id) DO UPDATE SET
                display_name=excluded.display_name,
                base_url=excluded.base_url,
                onion_url=excluded.onion_url,
                region=excluded.region,
                official=excluded.official,
                trust_tier=excluded.trust_tier,
                server_pubkey=excluded.server_pubkey,
                capabilities_json=excluded.capabilities_json,
                enabled=1,
                last_seen=datetime('now')
            """,
            (
                server_id,
                display_name,
                base_url,
                onion_url,
                region,
                1 if official else 0,
                trust_tier,
                server_pubkey,
                caps_json,
            ),
        )
        con.commit()


def insert_federation_inbox_event(event: Dict) -> bool:
    """Insert incoming event idempotently. Returns True if newly inserted."""
    event_id = str(event.get("event_id") or "").strip()
    if not event_id:
        return False
    origin_server_id = str(event.get("origin_server_id") or "").strip()
    event_type = str(event.get("event_type") or "").strip()
    payload_json = json.dumps(event.get("payload") or {}, separators=(",", ":"))
    try:
        with _conn() as con:
            con.execute(
                """
                INSERT INTO federation_inbox_events (event_id, origin_server_id, event_type, payload_json)
                VALUES (?, ?, ?, ?)
                """,
                (event_id, origin_server_id, event_type, payload_json),
            )
            con.commit()
            return True
    except sqlite3.IntegrityError:
        return False


def get_server_admin_stats() -> Dict:
    """Aggregate DB-backed stats for server management UI."""
    with _conn() as con:
        users_total = con.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        users_admin = con.execute("SELECT COUNT(*) AS c FROM users WHERE is_admin=1").fetchone()["c"]
        # Human-operated admins, excluding the seed `admin` system account
        # (used internally for moderation audit attribution — see
        # routers/server_admin.py:_admin_user_id_for_actions). Without
        # this, the dashboard always reads "+1 admin" higher than reality.
        users_admin_human = con.execute(
            "SELECT COUNT(*) AS c FROM users WHERE is_admin=1 AND LOWER(nickname) != 'admin'"
        ).fetchone()["c"]
        sessions_active = con.execute(
            "SELECT COUNT(*) AS c FROM sessions WHERE expires_at > datetime('now')"
        ).fetchone()["c"]
        # Sessions that have actually been used in the last 7 days. The
        # plain `sessions_active` count includes long-lived tokens from
        # devices that were logged in once and never returned, which
        # makes the dashboard misleadingly large (often 100×+ reality).
        sessions_recent_7d = con.execute(
            "SELECT COUNT(*) AS c FROM sessions "
            "WHERE expires_at > datetime('now') "
            "AND last_active IS NOT NULL "
            "AND last_active > datetime('now', '-7 days')"
        ).fetchone()["c"]
        sessions_users_recent_7d = con.execute(
            "SELECT COUNT(DISTINCT user_id) AS c FROM sessions "
            "WHERE expires_at > datetime('now') "
            "AND last_active IS NOT NULL "
            "AND last_active > datetime('now', '-7 days')"
        ).fetchone()["c"]
        rooms_total = con.execute("SELECT COUNT(*) AS c FROM rooms").fetchone()["c"]
        dms_total = con.execute("SELECT COUNT(*) AS c FROM dm_channels").fetchone()["c"]
        messages_total = con.execute("SELECT COUNT(*) AS c FROM messages").fetchone()["c"]
        dm_messages_total = con.execute("SELECT COUNT(*) AS c FROM dm_messages").fetchone()["c"]

        # Throughput windows based on SQLite timestamps in UTC.
        room_msgs_5m = con.execute(
            "SELECT COUNT(*) AS c FROM messages WHERE created_at >= datetime('now', '-5 minutes')"
        ).fetchone()["c"]
        dm_msgs_5m = con.execute(
            "SELECT COUNT(*) AS c FROM dm_messages WHERE created_at >= datetime('now', '-5 minutes')"
        ).fetchone()["c"]
        room_msgs_1h = con.execute(
            "SELECT COUNT(*) AS c FROM messages WHERE created_at >= datetime('now', '-1 hour')"
        ).fetchone()["c"]
        dm_msgs_1h = con.execute(
            "SELECT COUNT(*) AS c FROM dm_messages WHERE created_at >= datetime('now', '-1 hour')"
        ).fetchone()["c"]

    total_5m = int(room_msgs_5m) + int(dm_msgs_5m)
    return {
        "users_total": int(users_total),
        "users_admin": int(users_admin),
        "users_admin_human": int(users_admin_human),
        "sessions_active": int(sessions_active),
        "sessions_recent_7d": int(sessions_recent_7d),
        "sessions_users_recent_7d": int(sessions_users_recent_7d),
        "rooms_total": int(rooms_total),
        "dm_channels_total": int(dms_total),
        "messages_total": int(messages_total),
        "dm_messages_total": int(dm_messages_total),
        "messages_last_5m": total_5m,
        "messages_last_1h": int(room_msgs_1h) + int(dm_msgs_1h),
        "msg_per_min_5m": round(total_5m / 5.0, 2),
    }


# ──────────────────────────────────────────────────────────────
# Phase 4: Build trust and badges
# ──────────────────────────────────────────────────────────────

def register_build_manifest(
    platform: str,
    version: str,
    build_hash: str,
    signer: str = "",
    signature: str = "",
    official: bool = False,
) -> bool:
    """Register a build hash (official or community)."""
    try:
        with _conn() as con:
            con.execute(
                """
                INSERT OR IGNORE INTO official_build_manifests
                (platform, version, build_hash, signer, signature, official, registered_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                """,
                (platform, version, build_hash, signer, signature, int(official)),
            )
            con.commit()
        return True
    except Exception:
        return False


def is_official_build(platform: str, version: str, build_hash: str) -> bool:
    """Check if build hash is registered as official."""
    with _conn() as con:
        row = con.execute(
            """
            SELECT official FROM official_build_manifests
            WHERE platform=? AND version=? AND build_hash=?
            """,
            (platform, version, build_hash),
        ).fetchone()
    return bool(row and row["official"])


def list_build_manifests(platform: str | None = None) -> list[dict]:
    """List registered build manifests."""
    with _conn() as con:
        if platform:
            rows = con.execute(
                "SELECT * FROM official_build_manifests WHERE platform=? ORDER BY version DESC",
                (platform,),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM official_build_manifests ORDER BY platform, version DESC"
            ).fetchall()
    return [dict(r) for r in rows]


# ──────────────────────────────────────────────────────────────
# Phase 5: Federation replication
# ──────────────────────────────────────────────────────────────

# Hard cap on a single outbox event payload. Anything above this is almost
# certainly a media blob that will 413 on peers — and even if it didn't, every
# read would thrash SQLite's page cache via overflow pages, slowing every other
# query on the box. Peers can lazily fetch media via the per-post media URL.
_FEDERATION_OUTBOX_MAX_PAYLOAD_BYTES = 256 * 1024  # 256 KB


def _strip_media_from_outbox_payload(payload: dict) -> dict:
    """Drop heavy media_data fields. Leave a flag so peers know to refetch."""
    if not isinstance(payload, dict):
        return payload or {}
    out = dict(payload)
    if "media_data" in out and out.get("media_data"):
        out["media_data"] = None
        out["media_omitted"] = True
    return out


def insert_federation_outbox_event(event: dict) -> bool:
    """Add event to federation outbox for delivery to peers.

    Enforces a hard payload-size cap. If the serialized payload exceeds
    ``_FEDERATION_OUTBOX_MAX_PAYLOAD_BYTES`` we first try stripping
    ``media_data`` and re-serializing; if still too large, we skip the
    event entirely (return False) rather than enqueue an event that
    will infinitely 413-loop and trash the page cache.
    """
    payload = event.get("payload") or {}
    payload_json = json.dumps(payload)
    if len(payload_json) > _FEDERATION_OUTBOX_MAX_PAYLOAD_BYTES:
        stripped = _strip_media_from_outbox_payload(payload)
        payload_json = json.dumps(stripped)
        if len(payload_json) > _FEDERATION_OUTBOX_MAX_PAYLOAD_BYTES:
            # Even with media stripped this event is too big — drop it.
            return False
    try:
        with _conn() as con:
            # Idempotent column-add for legacy databases (pre-origin_time/signature).
            for _ddl in (
                "ALTER TABLE federation_outbox_events ADD COLUMN origin_time TEXT DEFAULT ''",
                "ALTER TABLE federation_outbox_events ADD COLUMN signature  TEXT DEFAULT ''",
            ):
                try: con.execute(_ddl)
                except Exception: pass
            con.execute(
                """
                INSERT INTO federation_outbox_events
                (event_id, target_server_id, event_type, payload_json, created_at, status, origin_time, signature)
                VALUES (?, ?, ?, ?, datetime('now'), 'pending', ?, ?)
                """,
                (
                    event.get("event_id"),
                    "",  # Broadcast to all servers
                    event.get("event_type"),
                    payload_json,
                    str(event.get("origin_time") or ""),
                    str(event.get("signature") or ""),
                ),
            )
            con.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def mark_outbox_events_failed(event_ids: list[str]) -> int:
    """Bulk-mark a list of outbox events as ``failed`` so the push worker
    stops retrying them. Returns the number of rows updated."""
    ids = [str(e) for e in (event_ids or []) if e]
    if not ids:
        return 0
    with _conn() as con:
        placeholders = ",".join("?" for _ in ids)
        cur = con.execute(
            f"UPDATE federation_outbox_events SET status='failed' "
            f"WHERE status='pending' AND event_id IN ({placeholders})",
            ids,
        )
        con.commit()
        return int(cur.rowcount or 0)


def wal_checkpoint_truncate() -> dict:
    """Run a TRUNCATE checkpoint to reclaim the WAL file.

    Auto-checkpoints are PASSIVE and silently no-op when any connection
    is holding a read transaction on the un-checkpointed pages, which
    happens constantly under load (FastAPI request handlers + async
    generators). Without a periodic TRUNCATE call the WAL grows
    unbounded and every transaction has to walk it, which presents as
    "the whole app is slow" even though individual SQL statements are
    fine. Returns the (busy, log_pages, checkpointed_pages) tuple.
    """
    with _conn() as con:
        row = con.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    if not row:
        return {"busy": -1, "log": 0, "checkpointed": 0}
    return {
        "busy": int(row[0] or 0),
        "log": int(row[1] or 0),
        "checkpointed": int(row[2] or 0),
    }


def prune_federation_outbox(sent_max_age_days: int = 7,
                            failed_max_age_days: int = 30) -> dict:
    """Delete delivered/failed outbox events past their retention window.

    Also marks any currently-pending events whose payload exceeds the
    insert-time cap as ``failed`` (these were inserted before the cap
    existed and would otherwise loop forever).
    """
    with _conn() as con:
        cur1 = con.execute(
            "DELETE FROM federation_outbox_events "
            "WHERE status='sent' AND created_at < datetime('now', ?)",
            (f"-{int(sent_max_age_days)} days",),
        )
        cur2 = con.execute(
            "DELETE FROM federation_outbox_events "
            "WHERE status='failed' AND created_at < datetime('now', ?)",
            (f"-{int(failed_max_age_days)} days",),
        )
        cur3 = con.execute(
            "UPDATE federation_outbox_events SET status='failed' "
            "WHERE status='pending' AND LENGTH(payload_json) > ?",
            (_FEDERATION_OUTBOX_MAX_PAYLOAD_BYTES,),
        )
        con.commit()
    return {
        "sent_deleted": int(cur1.rowcount or 0),
        "failed_deleted": int(cur2.rowcount or 0),
        "oversized_failed": int(cur3.rowcount or 0),
    }


def list_federation_outbox_events(
    since_cursor: str | None = None,
    limit: int = 100,
    status: str = "pending",
) -> list[dict]:
    """Fetch outbox events for pull/push to peers."""
    with _conn() as con:
        if since_cursor:
            rows = con.execute(
                """
                SELECT * FROM federation_outbox_events
                WHERE status=? AND created_at > ?
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (status, since_cursor, limit),
            ).fetchall()
        else:
            rows = con.execute(
                """
                SELECT * FROM federation_outbox_events
                WHERE status=?
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (status, limit),
            ).fetchall()
    return [dict(r) for r in rows]


def mark_outbox_event_sent(event_id: str, target_server_id: str) -> bool:
    """Mark outbox event as successfully sent."""
    try:
        with _conn() as con:
            if target_server_id:
                con.execute(
                    """
                    UPDATE federation_outbox_events
                    SET status='sent'
                    WHERE event_id=? AND target_server_id=?
                    """,
                    (event_id, target_server_id),
                )
            else:
                con.execute(
                    """
                    UPDATE federation_outbox_events
                    SET status='sent'
                    WHERE event_id=?
                    """,
                    (event_id,),
                )
            con.commit()
        return True
    except Exception:
        return False


def bulk_mark_outbox_events_sent(event_ids: list[str]) -> int:
    """Mark many outbox events sent in a single SQL round-trip.

    Used by the federation outbox processor to drain a batched delivery in
    one write rather than N writes through the SQLite write lock. Returns
    the number of rows updated.
    """
    if not event_ids:
        return 0
    try:
        total = 0
        with _conn() as con:
            # Chunk to stay below SQLite's default 999-parameter limit.
            for i in range(0, len(event_ids), 500):
                chunk = event_ids[i:i + 500]
                placeholders = ",".join("?" * len(chunk))
                cur = con.execute(
                    f"UPDATE federation_outbox_events "
                    f"SET status='sent' WHERE event_id IN ({placeholders})",
                    chunk,
                )
                total += cur.rowcount or 0
            con.commit()
        return total
    except Exception:
        return 0


def list_federation_inbox_events(
    status: str = "pending",
    limit: int = 10,
) -> list[dict]:
    """Fetch inbox events awaiting processing."""
    with _conn() as con:
        rows = con.execute(
            """
            SELECT * FROM federation_inbox_events
            WHERE status=?
            ORDER BY received_at ASC
            LIMIT ?
            """,
            (status, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def is_event_applied(event_id: str) -> bool:
    """Check if federation event was already applied (idempotency)."""
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM federation_inbox_events WHERE event_id=? AND status='applied'",
            (event_id,),
        ).fetchone()
    return bool(row)


def mark_federation_inbox_event(event_id: str, status: str) -> bool:
    """Update inbox event status (pending/applied/failed)."""
    try:
        with _conn() as con:
            con.execute(
                "UPDATE federation_inbox_events SET status=? WHERE event_id=?",
                (status, event_id),
            )
            con.commit()
        return True
    except Exception:
        return False


def get_or_create_federation_system_user() -> int:
    """Dedicated local user used to store replicated remote messages."""
    nick = "federation_sync"
    with _conn() as con:
        row = con.execute("SELECT id FROM users WHERE nickname=? COLLATE NOCASE", (nick,)).fetchone()
        if row:
            return int(row["id"])
    uid = create_user(nick, secrets.token_urlsafe(24))
    if uid is not None:
        return int(uid)
    with _conn() as con:
        row = con.execute("SELECT id FROM users WHERE nickname=? COLLATE NOCASE", (nick,)).fetchone()
    return int(row["id"]) if row else 1


def get_federation_profile_origin(global_user_id: str) -> str:
    """Return the origin_server_id pinned to a foreign user profile, or ''.

    Used by federation inbox handlers to enforce cross-origin
    profile-takeover protection: once a gid has been claimed by a
    particular origin server, only events from that same origin may
    further mutate the local mirror of that profile.
    """
    gid = (global_user_id or "").strip()
    if not gid:
        return ""
    try:
        with _conn() as con:
            row = con.execute(
                "SELECT origin_server_id FROM federation_user_profiles WHERE global_user_id=?",
                (gid,),
            ).fetchone()
            if not row:
                return ""
            val = row["origin_server_id"] if hasattr(row, "keys") else row[0]
            return (val or "").strip()
    except Exception:
        return ""


def delete_federation_user_profile(global_user_id: str, origin_server_id: str = "") -> bool:
    """Remove a foreign user from the federation directory.

    When ``origin_server_id`` is provided, the row is only deleted if its
    pinned origin matches — preventing a peer from purging another
    server's profile by replaying the gid. Returns True when a row was
    actually removed.
    """
    gid = (global_user_id or "").strip()
    if not gid:
        return False
    try:
        with _conn() as con:
            if origin_server_id:
                cur = con.execute(
                    "DELETE FROM federation_user_profiles WHERE global_user_id=? AND (origin_server_id='' OR origin_server_id=?)",
                    (gid, origin_server_id),
                )
            else:
                cur = con.execute(
                    "DELETE FROM federation_user_profiles WHERE global_user_id=?",
                    (gid,),
                )
            con.commit()
            return cur.rowcount > 0
    except Exception:
        return False


def upsert_federation_user_profile(
    global_user_id: str,
    nickname: str,
    display_name: str = "",
    avatar: str = "",
    bio: str = "",
    identity_pubkey: str = "",
    origin_server_id: str = "",
) -> bool:
    gid = (global_user_id or "").strip()
    nick = (nickname or "").strip()
    if not gid or not nick:
        return False
    with _conn() as con:
        # Cross-origin pin: once a row is owned by a particular origin
        # server, refuse updates carrying a different origin. Without
        # this, any peer holding the shared federation token could
        # rebind a victim's avatar / identity_pubkey by replaying the
        # victim's gid.
        if origin_server_id:
            try:
                row = con.execute(
                    "SELECT origin_server_id FROM federation_user_profiles WHERE global_user_id=?",
                    (gid,),
                ).fetchone()
                if row:
                    existing = (row["origin_server_id"] if hasattr(row, "keys") else row[0]) or ""
                    if existing and existing != origin_server_id:
                        return False
            except Exception:
                pass
        con.execute(
            """
            INSERT INTO federation_user_profiles
            (global_user_id, nickname, display_name, avatar, bio, identity_pubkey, origin_server_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(global_user_id) DO UPDATE SET
                nickname=excluded.nickname,
                display_name=excluded.display_name,
                avatar=excluded.avatar,
                bio=excluded.bio,
                identity_pubkey=excluded.identity_pubkey,
                origin_server_id=excluded.origin_server_id,
                updated_at=datetime('now')
            """,
            (gid, nick, display_name or "", avatar or "", bio or "", identity_pubkey or "", origin_server_id or ""),
        )
        con.commit()
    return True


def save_federated_room_message(event_id: str, payload: Dict) -> Optional[int]:
    """Apply replicated message event idempotently into local room timeline."""
    eid = (event_id or "").strip()
    if not eid:
        return None
    room_name = str(payload.get("room_name") or "").strip()
    nickname = str(payload.get("nickname") or "remote").strip() or "remote"
    content = str(payload.get("content") or "")
    media_data = payload.get("media_data")
    media_type = payload.get("media_type")
    media_blur = int(payload.get("media_blur") or 0)
    view_once = int(payload.get("view_once") or 0)
    if not room_name:
        return None

    with _conn() as con:
        seen = con.execute(
            "SELECT message_id FROM federation_message_events WHERE event_id=?",
            (eid,),
        ).fetchone()
        if seen:
            return int(seen["message_id"] or 0) or None

        room = con.execute("SELECT id FROM rooms WHERE name=?", (room_name,)).fetchone()
        if not room:
            owner_id = get_or_create_federation_system_user()
            con.execute(
                "INSERT OR IGNORE INTO rooms (name, description, type, owner_id, room_key_hint, channel_type) VALUES (?,?,?,?,?,?)",
                (room_name, "Federated room", "public", owner_id, None, "text"),
            )

        user_id = get_or_create_federation_system_user()
        cur = con.execute(
            """
            INSERT INTO messages (room_name, user_id, nickname, content, media_data, media_type,
                                  media_blur, view_once, bridge_platform, bridge_avatar, reply_to)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """,
            (room_name, user_id, nickname, content, media_data, media_type,
             media_blur, view_once, "federation", None, None),
        )
        msg_id = int(cur.lastrowid)
        con.execute(
            "INSERT INTO federation_message_events (event_id, message_id) VALUES (?, ?)",
            (eid, msg_id),
        )
        con.commit()
        return msg_id


# ──────────────────────────────────────────────────────────────
# Phase 6: Tor federation
# ──────────────────────────────────────────────────────────────

def set_federation_server_transport(server_id: str, transport: str) -> bool:
    """Set preferred transport for peer server (clearnet/onion/auto)."""
    try:
        with _conn() as con:
            con.execute(
                """
                UPDATE federation_servers
                SET transport_preference=?
                WHERE server_id=?
                """,
                (transport, server_id),
            )
            con.commit()
        return True
    except Exception:
        return False


def get_federation_server_transport(server_id: str) -> str:
    """Get preferred transport for peer server."""
    with _conn() as con:
        row = con.execute(
            "SELECT transport_preference FROM federation_servers WHERE server_id=?",
            (server_id,),
        ).fetchone()
    return row["transport_preference"] if row else "auto"


def get_federation_server_pubkey(server_id: str) -> str:
    """Return the pinned PEM public key for a peer server, or empty string.

    Used by the federation inbox to verify signatures. We pin by
    ``server_id`` so a peer can't rotate keys without an admin
    re-registering them; this is intentional given the small number of
    federated nodes.
    """
    sid = str(server_id or "").strip()
    if not sid:
        return ""
    with _conn() as con:
        row = con.execute(
            "SELECT server_pubkey FROM federation_servers WHERE server_id=?",
            (sid,),
        ).fetchone()
    if not row:
        return ""
    return str(row["server_pubkey"] or "")


def get_federation_origin_max_time(origin_server_id: str) -> str:
    """Return the highest ``origin_time`` we've already accepted from a peer.

    Used as part of replay defence: events strictly older than the max
    (minus a small clock-skew grace window) are dropped. Empty string
    means we've never accepted anything from this peer yet.
    """
    sid = str(origin_server_id or "").strip()
    if not sid:
        return ""
    with _conn() as con:
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS federation_origin_progress (
                origin_server_id TEXT PRIMARY KEY,
                max_origin_time  TEXT NOT NULL DEFAULT ''
            )
            """
        )
        row = con.execute(
            "SELECT max_origin_time FROM federation_origin_progress WHERE origin_server_id=?",
            (sid,),
        ).fetchone()
    return str(row["max_origin_time"] if row else "")


def update_federation_origin_max_time(origin_server_id: str, origin_time: str) -> None:
    """Bump the per-peer max accepted ``origin_time`` (monotonic).

    Called after a signed event passes verification. Uses an UPSERT so
    we don't roundtrip twice; the ``MAX(...)`` SQL ensures concurrent
    inserts can't regress the watermark.
    """
    sid = str(origin_server_id or "").strip()
    ts = str(origin_time or "").strip()
    if not sid or not ts:
        return
    with _conn() as con:
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS federation_origin_progress (
                origin_server_id TEXT PRIMARY KEY,
                max_origin_time  TEXT NOT NULL DEFAULT ''
            )
            """
        )
        con.execute(
            """
            INSERT INTO federation_origin_progress(origin_server_id, max_origin_time)
            VALUES(?, ?)
            ON CONFLICT(origin_server_id) DO UPDATE
               SET max_origin_time = MAX(federation_origin_progress.max_origin_time, excluded.max_origin_time)
            """,
            (sid, ts),
        )
        con.commit()


# ─── Reels ────────────────────────────────────────────────────────────────────

def get_reels_posts(viewer_id: int, scope: str = "all", sort: str = "hot",
                    limit: int = 20, offset: int = 0) -> List[Dict]:
    """Return video posts for the Reels tab.

    scope='all'     → all public videos (explore-style)
    scope='friends' → videos posted, reposted, or liked by accepted friends

    sort='hot'  → ❤️ like reactions × 3 + other reactions + reposts × 2 + comments + recency bonus
    sort='new'  → newest first
    sort='top'  → all-time highest like reaction count
    """
    with _conn() as con:
        if sort == "new":
            order = "wp.created_at DESC"
        elif sort == "top":
            order = f"{_calculate_post_score('reels_top')} DESC, wp.created_at DESC"
        else:  # hot
            order = f"{_calculate_post_score('reels_hot')} DESC, wp.created_at DESC"

        if scope == "friends":
            # Pre-fetch the viewer's accepted-friend ID set once so the SQL
            # below doesn't re-evaluate the same `(SELECT CASE WHEN f.user_id=?
            # THEN f.friend_id ELSE f.user_id END FROM friends f ...)` subquery
            # twelve times. Empty set → trivially empty result.
            friend_ids = [
                int(r[0]) for r in con.execute(
                    "SELECT CASE WHEN user_id=? THEN friend_id ELSE user_id END "
                    "FROM friends WHERE (user_id=? OR friend_id=?) AND status='accepted'",
                    (viewer_id, viewer_id, viewer_id),
                ).fetchall()
            ]
            if not friend_ids:
                return []
            # Safe inline literal: ints only, validated above.
            fids_csv = ",".join(str(i) for i in friend_ids)
            in_friends = f"IN ({fids_csv})"
            rows = con.execute(f"""
                  SELECT DISTINCT wp.id, wp.user_id, wp.content, NULL AS media_data, wp.media_type,
                      wp.privacy, wp.share_enabled, wp.allow_comments, wp.created_at, wp.edited_at,
                       wp.track_title, wp.track_room, wp.track_mood,
                       1 AS has_media,
                       u.nickname, u.avatar, u.display_name, u.is_admin AS is_admin,
                       wp.reaction_count AS reaction_count,
                       (SELECT COUNT(*) FROM wall_post_reactions WHERE post_id=wp.id AND emoji='❤️') AS like_count,
                       wp.comment_count AS comment_count,
                       wp.repost_count AS repost_count,
                       EXISTS(SELECT 1 FROM wall_reposts wr WHERE wr.post_id=wp.id AND wr.user_id=?) AS i_reposted,
                       -- source info: who in your friend list triggered this reel
                       (SELECT u2.nickname FROM users u2 WHERE u2.id = (
                           SELECT CASE
                               WHEN wp.user_id {in_friends} THEN wp.user_id
                               WHEN EXISTS(SELECT 1 FROM wall_reposts wr2
                                   WHERE wr2.post_id=wp.id AND wr2.user_id {in_friends})
                                   THEN (SELECT wr2.user_id FROM wall_reposts wr2
                                       WHERE wr2.post_id=wp.id AND wr2.user_id {in_friends} LIMIT 1)
                               ELSE (SELECT wpr2.user_id FROM wall_post_reactions wpr2
                                   WHERE wpr2.post_id=wp.id AND wpr2.user_id {in_friends} LIMIT 1)
                           END
                       )) AS friend_actor_nick,
                       (SELECT u3.avatar FROM users u3 WHERE u3.id = (
                           SELECT CASE
                               WHEN wp.user_id {in_friends} THEN wp.user_id
                               WHEN EXISTS(SELECT 1 FROM wall_reposts wr3
                                   WHERE wr3.post_id=wp.id AND wr3.user_id {in_friends})
                                   THEN (SELECT wr3.user_id FROM wall_reposts wr3
                                       WHERE wr3.post_id=wp.id AND wr3.user_id {in_friends} LIMIT 1)
                               ELSE (SELECT wpr3.user_id FROM wall_post_reactions wpr3
                                   WHERE wpr3.post_id=wp.id AND wpr3.user_id {in_friends} LIMIT 1)
                           END
                       )) AS friend_actor_avatar,
                       CASE
                           WHEN wp.user_id {in_friends} THEN 'posted'
                           WHEN EXISTS(SELECT 1 FROM wall_reposts wr4
                               WHERE wr4.post_id=wp.id AND wr4.user_id {in_friends}) THEN 'reposted'
                           ELSE 'reacted'
                       END AS friend_actor_action,
                       (SELECT wpr5.emoji FROM wall_post_reactions wpr5
                           WHERE wpr5.post_id=wp.id AND wpr5.user_id {in_friends}
                           ORDER BY wpr5.created_at DESC LIMIT 1) AS friend_actor_emoji
                FROM wall_posts wp
                JOIN users u ON wp.user_id = u.id
                WHERE wp.media_type LIKE 'video/%'
                  AND wp.user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id=?)
                  AND wp.user_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id=?)
                  AND (
                      wp.user_id = ?
                      OR wp.privacy = 'public'
                      OR (
                          wp.privacy = 'friends'
                          AND EXISTS (
                              SELECT 1 FROM friends vf
                              WHERE (
                                  (vf.user_id = ? AND vf.friend_id = wp.user_id)
                                  OR (vf.friend_id = ? AND vf.user_id = wp.user_id)
                              )
                              AND vf.status = 'accepted'
                          )
                      )
                      OR (
                          wp.privacy = 'followers'
                          AND (
                              EXISTS (
                                  SELECT 1 FROM friends vf2
                                  WHERE (
                                      (vf2.user_id = ? AND vf2.friend_id = wp.user_id)
                                      OR (vf2.friend_id = ? AND vf2.user_id = wp.user_id)
                                  )
                                  AND vf2.status = 'accepted'
                              )
                              OR EXISTS (
                                  SELECT 1 FROM followers fl
                                  WHERE fl.follower_id = ? AND fl.following_id = wp.user_id
                              )
                          )
                      )
                  )
                  AND (
                      -- friend posted it
                      wp.user_id {in_friends}
                      OR
                      -- friend reposted it
                      EXISTS (SELECT 1 FROM wall_reposts wr WHERE wr.post_id=wp.id AND wr.user_id {in_friends})
                      OR
                      -- friend reacted/liked it
                      EXISTS (SELECT 1 FROM wall_post_reactions wpr WHERE wpr.post_id=wp.id AND wpr.user_id {in_friends})
                  )
                ORDER BY {order}
                LIMIT ? OFFSET ?
            """, (
                viewer_id,
                # block filters
                viewer_id, viewer_id,
                # visibility rules for viewer
                viewer_id,
                viewer_id, viewer_id,
                viewer_id, viewer_id,
                viewer_id,
                limit, offset,
            )).fetchall()
        else:  # all public
            rows = con.execute(f"""
                  SELECT wp.id, wp.user_id, wp.content, NULL AS media_data, wp.media_type,
                      wp.privacy, wp.share_enabled, wp.allow_comments, wp.created_at, wp.edited_at,
                       wp.track_title, wp.track_room, wp.track_mood,
                       1 AS has_media,
                       u.nickname, u.avatar, u.display_name, u.is_admin AS is_admin,
                       wp.reaction_count AS reaction_count,
                       (SELECT COUNT(*) FROM wall_post_reactions WHERE post_id=wp.id AND emoji='❤️') AS like_count,
                       wp.comment_count AS comment_count,
                       wp.repost_count AS repost_count,
                       EXISTS(SELECT 1 FROM wall_reposts wr WHERE wr.post_id=wp.id AND wr.user_id=?) AS i_reposted,
                       NULL AS friend_actor_nick,
                       NULL AS friend_actor_avatar,
                       NULL AS friend_actor_action,
                       NULL AS friend_actor_emoji
                FROM wall_posts wp
                JOIN users u ON wp.user_id = u.id
                WHERE wp.media_type LIKE 'video/%'
                  AND wp.privacy = 'public'
                  AND wp.user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id=?)
                  AND wp.user_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id=?)
                ORDER BY {order}
                LIMIT ? OFFSET ?
            """, (viewer_id, viewer_id, viewer_id, limit, offset)).fetchall()

    return [dict(r) for r in rows]


# ──────────────────────────────────────────────────────────────────────────
# Reels personalization — seen tracking + scored "for you" ordering
# ──────────────────────────────────────────────────────────────────────────

def mark_reels_seen(user_id: int, post_ids: List[int]) -> int:
    """Record that this viewer has watched these reels. Idempotent."""
    if not post_ids:
        return 0
    rows = [(int(user_id), int(pid)) for pid in post_ids if pid]
    if not rows:
        return 0
    with _conn() as con:
        con.executemany(
            "INSERT OR REPLACE INTO reels_seen (user_id, post_id, seen_at) "
            "VALUES (?, ?, datetime('now'))",
            rows,
        )
    return len(rows)


def get_personalized_reels(viewer_id: int, scope: str = "for_you",
                           limit: int = 20, offset: int = 0,
                           include_seen: bool = False,
                           exclude_post_ids: Optional[List[int]] = None) -> List[Dict]:
    """Personalized reels ordering.

    Scoring (computed in SQL, deterministic):
      + 5  per accepted-friend / mutual reaction on the reel
      + 3  per accepted-friend / mutual repost
      + 4  per accepted-friend / mutual comment
      + 8  if the reel author is a mutual / friend
      + 4  if the viewer follows the author
      + 2  per DISTINCT friend who interacted (capped at 6 = 3 friends)
      +    velocity bonus: (engagement / hours_since_post), capped at 6
      + 0.5 per global ❤️ reaction
      + 0.3 per global other reaction
      + 0.6 per repost
      + 0.4 per comment
      + recency bonus: 12 / (hours_since_post + 4) capped at 8

    Seen reels are filtered out unless include_seen=True. Frontend should
    request include_seen=False first; when result is empty, retry with
    include_seen=True so the user always has something to watch.

    scope='for_you'  → all visible reels, scored.
    scope='friends'  → restrict to reels involving an accepted friend.
    scope='all'      → public, sorted by score.
    """
    if scope not in ("for_you", "friends", "all"):
        scope = "for_you"
    excl_ids = [int(p) for p in (exclude_post_ids or []) if p]
    excl_csv = ",".join(str(i) for i in excl_ids) if excl_ids else ""

    with _conn() as con:
        friend_ids = [
            int(r[0]) for r in con.execute(
                "SELECT CASE WHEN user_id=? THEN friend_id ELSE user_id END "
                "FROM friends WHERE (user_id=? OR friend_id=?) AND status='accepted'",
                (viewer_id, viewer_id, viewer_id),
            ).fetchall()
        ]
        following_ids = [
            int(r[0]) for r in con.execute(
                "SELECT following_id FROM followers WHERE follower_id=?",
                (viewer_id,),
            ).fetchall()
        ]
        affinity_ids = sorted(set(friend_ids) | set(following_ids))
        fids_csv = ",".join(str(i) for i in friend_ids) if friend_ids else "-1"
        aff_csv  = ",".join(str(i) for i in affinity_ids) if affinity_ids else "-1"

        # Pre-aggregate the per-post counters that drive the score via
        # tiny derived tables (filtered to the affinity set / heart emoji)
        # rather than many correlated subqueries per row. Keeps the
        # planner cost roughly O(rows-in-narrow-tables) instead of
        # O(candidate-reels × subqueries).
        score_expr = """(
            5.0 * COALESCE(ar_aff.c, 0)
          + 3.0 * COALESCE(rp_aff.c, 0)
          + 4.0 * COALESCE(cm_aff.c, 0)
          + (CASE WHEN wp.user_id IN (FIDS) THEN 8.0 ELSE 0.0 END)
          + (CASE WHEN wp.user_id IN (AIDS) AND wp.user_id NOT IN (FIDS) THEN 4.0 ELSE 0.0 END)
          + MIN(6.0, 2.0 * COALESCE(fe.c, 0))
          + MIN(6.0,
                (wp.reaction_count + wp.comment_count * 2.0)
                / MAX(1.0, (julianday('now') - julianday(wp.created_at)) * 24.0))
          + 0.5 * COALESCE(hc.c, 0)
          + 0.3 * (wp.reaction_count - COALESCE(hc.c, 0))
          + 0.6 * wp.repost_count
          + 0.4 * wp.comment_count
          + MIN(8.0, 12.0 / (((julianday('now') - julianday(wp.created_at)) * 24.0) + 4.0))
        )""".replace("FIDS", fids_csv).replace("AIDS", aff_csv)

        seen_filter = "" if include_seen else \
            f" AND NOT EXISTS (SELECT 1 FROM reels_seen rs WHERE rs.user_id={int(viewer_id)} AND rs.post_id=wp.id)"
        excl_filter = f" AND wp.id NOT IN ({excl_csv})" if excl_csv else ""

        if scope == "friends":
            scope_filter = f"""
              AND (
                  wp.user_id IN ({fids_csv})
                  OR EXISTS (SELECT 1 FROM wall_reposts wr_s
                             WHERE wr_s.post_id=wp.id AND wr_s.user_id IN ({fids_csv}))
                  OR EXISTS (SELECT 1 FROM wall_post_reactions wpr_s
                             WHERE wpr_s.post_id=wp.id AND wpr_s.user_id IN ({fids_csv}))
              )"""
        else:
            scope_filter = ""

        # When include_seen=True we still want unseen reels to win, so apply
        # a -50 penalty for already-seen rows. Bound parameter for safety.
        sort_seen_penalty = "" if not include_seen else \
            " - (CASE WHEN EXISTS (SELECT 1 FROM reels_seen rs2 WHERE rs2.user_id=? AND rs2.post_id=wp.id) THEN 50.0 ELSE 0.0 END)"

        params: List = []
        if include_seen:
            params.append(viewer_id)

        sql = f"""
            WITH ar_aff AS (
                SELECT post_id, COUNT(*) AS c FROM wall_post_reactions
                WHERE user_id IN ({aff_csv})
                GROUP BY post_id
            ),
            rp_aff AS (
                SELECT post_id, COUNT(*) AS c FROM wall_reposts
                WHERE user_id IN ({aff_csv})
                GROUP BY post_id
            ),
            cm_aff AS (
                SELECT post_id, COUNT(*) AS c FROM wall_comments
                WHERE user_id IN ({aff_csv})
                GROUP BY post_id
            ),
            -- Distinct friends/follows who interacted (any of: react,
            -- repost, comment). Drives the breadth bonus + the
            -- "and N others" reason text shown to the user.
            fe AS (
                SELECT post_id, COUNT(DISTINCT user_id) AS c FROM (
                    SELECT post_id, user_id FROM wall_post_reactions WHERE user_id IN ({aff_csv})
                    UNION
                    SELECT post_id, user_id FROM wall_reposts WHERE user_id IN ({aff_csv})
                    UNION
                    SELECT post_id, user_id FROM wall_comments WHERE user_id IN ({aff_csv})
                )
                GROUP BY post_id
            ),
            hc AS (
                SELECT post_id, COUNT(*) AS c FROM wall_post_reactions
                WHERE emoji='❤️'
                GROUP BY post_id
            ),
            -- Pick ONE friend per post to credit on the reel ribbon
            -- ("Alice ❤️ reacted" / "Bob 🔁 reposted" / "Carol 💬 commented").
            -- Reactions, reposts and comments are unioned, ranked by
            -- recency, and the most recent friend action wins.
            -- Author-is-friend handled in SELECT below.
            friend_act_raw AS (
                SELECT post_id, user_id, action, emoji, ts,
                       ROW_NUMBER() OVER (
                           PARTITION BY post_id
                           ORDER BY ts DESC, user_id DESC
                       ) AS rn
                FROM (
                    SELECT post_id, user_id, 'reacted' AS action, emoji,
                           COALESCE(created_at, '') AS ts
                    FROM wall_post_reactions
                    WHERE user_id IN ({fids_csv})
                    UNION ALL
                    SELECT post_id, user_id, 'reposted' AS action, NULL AS emoji,
                           COALESCE(created_at, '') AS ts
                    FROM wall_reposts
                    WHERE user_id IN ({fids_csv})
                    UNION ALL
                    SELECT post_id, user_id, 'commented' AS action, NULL AS emoji,
                           COALESCE(created_at, '') AS ts
                    FROM wall_comments
                    WHERE user_id IN ({fids_csv})
                )
            ),
            friend_act AS (
                SELECT post_id, user_id, action, emoji
                FROM friend_act_raw WHERE rn = 1
            )
            SELECT wp.id, wp.user_id, wp.content, NULL AS media_data, wp.media_type,
                   wp.privacy, wp.share_enabled, wp.allow_comments, wp.created_at, wp.edited_at,
                   wp.track_title, wp.track_room, wp.track_mood,
                   1 AS has_media,
                   u.nickname, u.avatar, u.display_name, u.is_admin AS is_admin,
                   wp.reaction_count AS reaction_count,
                   COALESCE(hc.c, 0) AS like_count,
                   wp.comment_count AS comment_count,
                   wp.repost_count AS repost_count,
                   COALESCE(fe.c, 0) AS friend_engagement_count,
                   EXISTS(SELECT 1 FROM wall_reposts wr WHERE wr.post_id=wp.id AND wr.user_id=?) AS i_reposted,
                   -- Friend ribbon: prefer the post author when they're a
                   -- friend (action='posted'); else the most-recent friend
                   -- reaction/repost/comment picked by friend_act.
                   CASE
                       WHEN wp.user_id IN ({fids_csv}) THEN u.nickname
                       ELSE (SELECT uf.nickname FROM users uf WHERE uf.id = friend_act.user_id)
                   END AS friend_actor_nick,
                   CASE
                       WHEN wp.user_id IN ({fids_csv}) THEN u.avatar
                       ELSE (SELECT uf2.avatar FROM users uf2 WHERE uf2.id = friend_act.user_id)
                   END AS friend_actor_avatar,
                   CASE
                       WHEN wp.user_id IN ({fids_csv}) THEN 'posted'
                       ELSE friend_act.action
                   END AS friend_actor_action,
                   CASE
                       WHEN wp.user_id IN ({fids_csv}) THEN NULL
                       ELSE friend_act.emoji
                   END AS friend_actor_emoji,
                   {score_expr} {sort_seen_penalty} AS reels_score
            FROM wall_posts wp
            JOIN users u ON wp.user_id = u.id
            LEFT JOIN ar_aff ON ar_aff.post_id = wp.id
            LEFT JOIN rp_aff ON rp_aff.post_id = wp.id
            LEFT JOIN cm_aff ON cm_aff.post_id = wp.id
            LEFT JOIN fe     ON fe.post_id     = wp.id
            LEFT JOIN hc     ON hc.post_id     = wp.id
            LEFT JOIN friend_act ON friend_act.post_id = wp.id
            WHERE wp.media_type LIKE 'video/%'
              AND wp.user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id=?)
              AND wp.user_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id=?)
              AND (
                  wp.user_id = ?
                  OR wp.privacy = 'public'
                  OR (wp.privacy = 'friends' AND wp.user_id IN ({fids_csv}))
                  OR (wp.privacy = 'followers' AND (
                        wp.user_id IN ({fids_csv})
                        OR EXISTS (SELECT 1 FROM followers fl
                                   WHERE fl.follower_id=? AND fl.following_id=wp.user_id)
                  ))
              )
              {scope_filter}
              {seen_filter}
              {excl_filter}
            ORDER BY reels_score DESC, wp.created_at DESC, wp.id DESC
            LIMIT ? OFFSET ?
        """
        # bind: i_reposted viewer, [maybe seen penalty], block (x2), visibility viewer, follower viewer, limit, offset
        bind: List = [viewer_id]
        bind.extend(params)
        bind.extend([viewer_id, viewer_id, viewer_id, viewer_id, limit, offset])
        rows = con.execute(sql, tuple(bind)).fetchall()

    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Bug & security report queue
# ---------------------------------------------------------------------------

_BUG_SEVERITIES = ("low", "medium", "high", "critical")
_BUG_STATUSES   = ("open", "triage", "in_progress", "fixed", "wontfix", "duplicate")
_BUG_CATEGORIES = ("bug", "security", "feature", "ux", "other")


def create_bug_report(
    *,
    reporter_id: Optional[int],
    reporter_ip: str,
    title: str,
    body: str,
    severity: str = "medium",
    category: str = "bug",
    contact: str = "",
) -> int:
    """Insert a bug/security report. Returns new row id."""
    sev = severity if severity in _BUG_SEVERITIES else "medium"
    cat = category if category in _BUG_CATEGORIES else "bug"
    with _conn() as con:
        cur = con.execute(
            """INSERT INTO bug_reports
               (reporter_id, reporter_ip, title, body, severity, category, contact)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (reporter_id, reporter_ip or "", title.strip()[:200],
             body.strip()[:8000], sev, cat, (contact or "").strip()[:200]),
        )
        return int(cur.lastrowid or 0)


def list_bug_reports(
    *,
    status: Optional[str] = None,
    severity: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> list:
    """List bug reports for the admin dashboard, newest first.

    Severity is mapped to a numeric weight so 'critical' floats to the top
    regardless of the optional status filter. Reporter nickname is joined
    so the admin UI doesn't need a second round-trip per report.
    """
    where_parts: list = []
    params: list = []
    if status and status in _BUG_STATUSES:
        where_parts.append("br.status = ?")
        params.append(status)
    if severity and severity in _BUG_SEVERITIES:
        where_parts.append("br.severity = ?")
        params.append(severity)
    where_sql = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""
    params.extend([int(limit), int(offset)])
    with _conn() as con:
        rows = con.execute(f"""
            SELECT br.id, br.reporter_id, br.reporter_ip, br.title, br.body,
                   br.severity, br.category, br.contact, br.status,
                   br.admin_notes, br.created_at, br.updated_at,
                   u.nickname AS reporter_nick,
                   CASE br.severity
                       WHEN 'critical' THEN 4
                       WHEN 'high'     THEN 3
                       WHEN 'medium'   THEN 2
                       WHEN 'low'      THEN 1
                       ELSE 0
                   END AS sev_weight
            FROM bug_reports br
            LEFT JOIN users u ON u.id = br.reporter_id
            {where_sql}
            ORDER BY
                CASE br.status WHEN 'open' THEN 0 WHEN 'triage' THEN 1
                               WHEN 'in_progress' THEN 2 ELSE 3 END,
                sev_weight DESC,
                br.created_at DESC
            LIMIT ? OFFSET ?
        """, tuple(params)).fetchall()
    return [dict(r) for r in rows]


def get_bug_report(report_id: int) -> Optional[Dict]:
    with _conn() as con:
        row = con.execute("""
            SELECT br.*, u.nickname AS reporter_nick
            FROM bug_reports br
            LEFT JOIN users u ON u.id = br.reporter_id
            WHERE br.id = ?
        """, (int(report_id),)).fetchone()
    return dict(row) if row else None


def update_bug_report(
    report_id: int,
    *,
    status: Optional[str] = None,
    severity: Optional[str] = None,
    admin_notes: Optional[str] = None,
) -> bool:
    """Admin update. Only whitelisted fields are mutable."""
    sets: list = []
    params: list = []
    if status is not None and status in _BUG_STATUSES:
        sets.append("status = ?")
        params.append(status)
    if severity is not None and severity in _BUG_SEVERITIES:
        sets.append("severity = ?")
        params.append(severity)
    if admin_notes is not None:
        sets.append("admin_notes = ?")
        params.append(str(admin_notes)[:4000])
    if not sets:
        return False
    sets.append("updated_at = datetime('now')")
    params.append(int(report_id))
    with _conn() as con:
        cur = con.execute(
            f"UPDATE bug_reports SET {', '.join(sets)} WHERE id = ?",
            tuple(params),
        )
        return cur.rowcount > 0


def delete_bug_report(report_id: int) -> bool:
    with _conn() as con:
        cur = con.execute("DELETE FROM bug_reports WHERE id = ?", (int(report_id),))
        return cur.rowcount > 0


def count_recent_bug_reports_from_ip(ip: str, minutes: int = 60) -> int:
    """Rate-limit support: how many reports has this IP filed in the last N minutes."""
    if not ip:
        return 0
    with _conn() as con:
        row = con.execute(
            "SELECT COUNT(*) AS c FROM bug_reports WHERE reporter_ip = ? "
            "AND created_at >= datetime('now', ?)",
            (ip, f"-{int(minutes)} minutes"),
        ).fetchone()
    return int(row["c"]) if row else 0


def bug_report_stats() -> Dict:
    """Counts grouped by status and severity for admin dashboard badges."""
    out = {"by_status": {}, "by_severity": {}, "total": 0}
    with _conn() as con:
        for r in con.execute(
            "SELECT status, COUNT(*) AS c FROM bug_reports GROUP BY status"
        ).fetchall():
            out["by_status"][r["status"]] = r["c"]
            out["total"] += r["c"]
        for r in con.execute(
            "SELECT severity, COUNT(*) AS c FROM bug_reports GROUP BY severity"
        ).fetchall():
            out["by_severity"][r["severity"]] = r["c"]
    return out
