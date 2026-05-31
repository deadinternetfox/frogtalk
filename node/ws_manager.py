"""WebSocket connection manager for real-time messaging."""
import json
import os
from typing import Dict, Set, Optional
from fastapi import WebSocket


def _per_ip_ws_cap() -> int:
    # Total ceiling per source IP across ALL accounts. Generous default
    # because a single household/office IP can legitimately have many
    # devices and active tabs (multi-account testing, family share).
    try:
        return max(1, int(os.getenv("FROGTALK_WS_PER_IP_CAP", "50")))
    except ValueError:
        return 50


def _per_user_per_ip_ws_cap() -> int:
    # Cap per (ip, user_id). Phone + desktop + a few tabs = ~5 per account.
    try:
        return max(1, int(os.getenv("FROGTALK_WS_PER_USER_PER_IP_CAP", "8")))
    except ValueError:
        return 8


class ConnectionManager:
    def __init__(self):
        # room -> set of websockets
        self._rooms: Dict[str, Set] = {}
        # websocket -> (room, nickname, user_id, avatar, is_admin, ip)
        self._ws_meta: Dict[WebSocket, tuple] = {}
        # user_id -> set of websockets (for DM / call signaling)
        self._user_ws: Dict[int, Set] = {}
        # ip -> active connection count (per-IP DoS cap)
        self._ip_count: Dict[str, int] = {}
        # (ip, user_id) -> active connection count (per-account-per-IP cap)
        self._ip_user_count: Dict[tuple, int] = {}

    async def connect(self, ws: WebSocket, room: str, nickname: str, user_id: int, avatar: str = None, is_admin: bool = False, display_name: str = None):
        # Per-IP cap (covers phone+desktop+browser tabs at 5).
        # When deployed behind nginx/Cloudflare, ws.client.host is the loopback
        # address (127.0.0.1 / ::1) for every client, so the raw socket peer is
        # useless as a per-IP key. Trust X-Forwarded-For / X-Real-IP only when
        # the immediate peer is loopback (we control the reverse proxy there).
        ip = ""
        try:
            client = getattr(ws, "client", None)
            if client and getattr(client, "host", None):
                ip = str(client.host)
        except Exception:
            ip = ""
        if ip in ("127.0.0.1", "::1", "localhost"):
            try:
                headers = getattr(ws, "headers", {}) or {}
                fwd = (headers.get("x-forwarded-for") or "").strip()
                if fwd:
                    # First entry = original client.
                    ip = fwd.split(",", 1)[0].strip() or ip
                else:
                    real = (headers.get("x-real-ip") or "").strip()
                    if real:
                        ip = real
            except Exception:
                pass
        if ip:
            ip_user_key = (ip, int(user_id))
            if self._ip_user_count.get(ip_user_key, 0) >= _per_user_per_ip_ws_cap():
                try:
                    await ws.close(code=4008)
                except Exception:
                    pass
                return False
            if self._ip_count.get(ip, 0) >= _per_ip_ws_cap():
                try:
                    await ws.close(code=4008)
                except Exception:
                    pass
                return False
        await ws.accept()
        if room not in self._rooms:
            self._rooms[room] = set()
        self._rooms[room].add(ws)
        self._ws_meta[ws] = (room, nickname, user_id, avatar, is_admin, ip, display_name)
        if user_id not in self._user_ws:
            self._user_ws[user_id] = set()
        self._user_ws[user_id].add(ws)
        if ip:
            self._ip_count[ip] = self._ip_count.get(ip, 0) + 1
            ip_user_key = (ip, int(user_id))
            self._ip_user_count[ip_user_key] = self._ip_user_count.get(ip_user_key, 0) + 1
        # Announce join
        await self.broadcast_room(room, {
            "type": "presence",
            "event": "join",
            "nickname": nickname,
            "room": room,
        }, exclude=ws)
        return True

    def disconnect(self, ws: WebSocket):
        meta = self._ws_meta.pop(ws, None)
        if not meta:
            return
        room, nickname, user_id = meta[:3]
        ip = meta[5] if len(meta) >= 6 else ""
        if room in self._rooms:
            self._rooms[room].discard(ws)
            if not self._rooms[room]:
                del self._rooms[room]
        if user_id in self._user_ws:
            self._user_ws[user_id].discard(ws)
            if not self._user_ws[user_id]:
                del self._user_ws[user_id]
        if ip and ip in self._ip_count:
            self._ip_count[ip] -= 1
            if self._ip_count[ip] <= 0:
                del self._ip_count[ip]
        if ip and user_id is not None:
            ip_user_key = (ip, int(user_id))
            if ip_user_key in self._ip_user_count:
                self._ip_user_count[ip_user_key] -= 1
                if self._ip_user_count[ip_user_key] <= 0:
                    del self._ip_user_count[ip_user_key]
        return room, nickname

    async def broadcast_room(self, room: str, data: dict, exclude: WebSocket = None):
        payload = json.dumps(data)
        dead = []
        for ws in list(self._rooms.get(room, [])):
            if ws is exclude:
                continue
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    async def send_personal(self, ws: WebSocket, data: dict):
        try:
            await ws.send_text(json.dumps(data))
        except Exception:
            pass

    async def send_to_user(self, user_id: int, data: dict):
        """Send to all connections belonging to a user (DMs, calls, notifications).
        Returns the number of connections the payload was successfully delivered to."""
        payload = json.dumps(data)
        dead = []
        delivered = 0
        for ws in list(self._user_ws.get(user_id, [])):
            try:
                await ws.send_text(payload)
                delivered += 1
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)
        return delivered

    def is_user_online(self, user_id: int) -> bool:
        return bool(self._user_ws.get(user_id))

    async def broadcast_all(self, data: dict):
        """Send to every connected websocket (profile updates etc.)."""
        payload = json.dumps(data)
        dead = []
        for ws in list(self._ws_meta.keys()):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    def update_user_meta(self, user_id: int, *, avatar: str = None, nickname: str = None, display_name: str = None):
        """Update cached meta (avatar / nickname / display_name) on all active websockets for a user."""
        for ws in list(self._user_ws.get(user_id, [])):
            meta = self._ws_meta.get(ws)
            if not meta:
                continue
            room, nick, uid, av, is_adm = meta[0], meta[1], meta[2], meta[3], meta[4]
            dn = meta[6] if len(meta) > 6 else None
            if avatar is not None:
                av = avatar
            if nickname is not None:
                nick = nickname
            if display_name is not None:
                dn = display_name if display_name.strip() else None
            self._ws_meta[ws] = (room, nick, uid, av, is_adm, meta[5] if len(meta) > 5 else '', dn)

    async def disconnect_user(self, user_id: int) -> int:
        """Disconnect all websockets belonging to a user. Returns count of disconnected sessions."""
        sockets = list(self._user_ws.get(user_id, []))
        count = 0
        for ws in sockets:
            try:
                await ws.close(code=4000, reason="You have been disconnected by an administrator")
                count += 1
            except Exception:
                pass
            self.disconnect(ws)
        return count

    async def disconnect_user_from_room(self, user_id: int, room: str) -> int:
        """Close only the websockets that bind `user_id` to `room`.

        Used when a moderator bans a user from a specific channel: their
        other channel sessions (including DMs) must stay connected, but
        the socket holding the banned room must drop so they can't keep
        sending until their own client decides to reconnect. The per-
        message ban check in routers/ws.py is the authoritative gate;
        this is defence-in-depth so a hostile/modded client can't sit on
        a stale socket and spam.
        """
        targets = []
        for ws in list(self._user_ws.get(user_id, [])):
            meta = self._ws_meta.get(ws)
            if meta and meta[0] == room:
                targets.append(ws)
        count = 0
        for ws in targets:
            try:
                await ws.close(code=4003, reason="Banned from this channel")
                count += 1
            except Exception:
                pass
            self.disconnect(ws)
        return count

    def online_count(self, room: str) -> int:
        return len(self._rooms.get(room, set()))

    def online_nicknames(self, room: str):
        result = []
        for ws in self._rooms.get(room, []):
            meta = self._ws_meta.get(ws)
            if meta:
                result.append({
                    "nickname": meta[1],
                    "user_id": meta[2],
                    "avatar": meta[3] if len(meta) > 3 else None,
                    "is_admin": meta[4] if len(meta) > 4 else False,
                    "display_name": meta[6] if len(meta) > 6 else None,
                })
        return result

    def metrics_snapshot(self):
        """Return lightweight live WebSocket metrics for server-admin dashboards."""
        rooms = {room: len(sockets) for room, sockets in self._rooms.items()}
        return {
            "ws_connections": len(self._ws_meta),
            "online_users": len(self._user_ws),
            "active_rooms": len(rooms),
            "room_connections": rooms,
        }

    def online_users_snapshot(self):
        """Return one representative socket identity per online user."""
        out = []
        for user_id, sockets in self._user_ws.items():
            nickname = None
            avatar = None
            is_admin = False
            for ws in sockets:
                meta = self._ws_meta.get(ws)
                if not meta:
                    continue
                nickname = meta[1]
                avatar = meta[3] if len(meta) > 3 else None
                is_admin = bool(meta[4] if len(meta) > 4 else False)
                break
            out.append({
                "user_id": user_id,
                "nickname": nickname,
                "avatar": avatar,
                "is_admin": is_admin,
                "connections": len(sockets),
            })
        out.sort(key=lambda u: (u.get("nickname") or "").lower())
        return out


# Voice Channel Tracking (for group calls)
class VoiceManager:
    """Track users in voice channels per room. One roster row per identity (GID preferred)."""

    def __init__(self):
        # room -> identity_key -> participant dict
        self._voice_rooms: Dict[str, Dict[str, dict]] = {}

    @staticmethod
    def _identity_key(user_id: int, global_user_id: str = "") -> str:
        gid = (global_user_id or "").strip()
        if gid:
            return f"g:{gid}"
        return f"u:{int(user_id)}"

    def join(
        self,
        room: str,
        user_id: int,
        nickname: str,
        avatar: str = None,
        global_user_id: str = "",
    ):
        """Join voice. Returns ``{existing, already}`` or ``None`` if full."""
        if room not in self._voice_rooms:
            self._voice_rooms[room] = {}
        bucket = self._voice_rooms[room]
        ik = self._identity_key(user_id, global_user_id)
        gid = (global_user_id or "").strip()
        profile = {
            "user_id": int(user_id),
            "nickname": nickname,
            "avatar": avatar or "",
            "global_user_id": gid,
        }

        if ik in bucket:
            bucket[ik].update(profile)
            existing = [p for k, p in bucket.items() if k != ik]
            return {"existing": existing, "already": True}

        if len(bucket) >= 8:
            return None

        existing = list(bucket.values())
        bucket[ik] = dict(profile)
        return {"existing": existing, "already": False}

    def leave(self, room: str, user_id: int, global_user_id: str = ""):
        """User leaves voice channel."""
        if room not in self._voice_rooms:
            return
        bucket = self._voice_rooms[room]
        ik = self._identity_key(user_id, global_user_id)
        if ik in bucket:
            del bucket[ik]
        else:
            for k, p in list(bucket.items()):
                if int(p.get("user_id") or 0) == int(user_id):
                    del bucket[k]
        if not bucket:
            del self._voice_rooms[room]

    def participants(self, room: str):
        """Get list of participants in voice channel."""
        return list(self._voice_rooms.get(room, {}).values())

    def is_in_voice(self, room: str, user_id: int) -> bool:
        """Check if user is in voice channel."""
        return any(int(p.get("user_id") or 0) == int(user_id) for p in self.participants(room))

    def is_in_voice_by_gid(self, room: str, global_user_id: str) -> bool:
        gid = (global_user_id or "").strip()
        if not gid:
            return False
        return self._identity_key(0, gid) in self._voice_rooms.get(room, {})

    def leave_all(self, user_id: int, global_user_id: str = ""):
        """Remove user from all voice channels (when fully offline)."""
        gid = (global_user_id or "").strip()
        rooms_left = []
        for room in list(self._voice_rooms.keys()):
            bucket = self._voice_rooms[room]
            before = len(bucket)
            for k, p in list(bucket.items()):
                if int(p.get("user_id") or 0) == int(user_id):
                    del bucket[k]
                elif gid and str(p.get("global_user_id") or "").strip() == gid:
                    del bucket[k]
            if len(bucket) < before:
                rooms_left.append(room)
            if not bucket:
                del self._voice_rooms[room]
        return rooms_left

    def reap_offline(self, is_online) -> list:
        """Drop local voice participants whose user no longer has any live
        connection (device off / network loss / half-open socket reaped by the
        WS ping timeout). Returns ``[(room, participant_dict)]`` removed so the
        caller can broadcast ``voice_user_left``. Prevents zombies lingering in
        the voice list when someone disconnects and never comes back."""
        removed = []
        for room in list(self._voice_rooms.keys()):
            bucket = self._voice_rooms.get(room) or {}
            for k, p in list(bucket.items()):
                uid = int(p.get("user_id") or 0)
                try:
                    online = bool(uid) and bool(is_online(uid))
                except Exception:
                    online = True  # never reap on a probe error
                if not online:
                    del bucket[k]
                    removed.append((room, dict(p)))
            if not bucket:
                self._voice_rooms.pop(room, None)
        return removed


manager = ConnectionManager()
voice_manager = VoiceManager()
