"""WebSocket connection manager for real-time messaging."""
import json
from typing import Dict, Set, Optional
from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        # room -> set of websockets
        self._rooms: Dict[str, Set] = {}
        # websocket -> (room, nickname, user_id, avatar, is_admin)
        self._ws_meta: Dict[WebSocket, tuple] = {}
        # user_id -> set of websockets (for DM / call signaling)
        self._user_ws: Dict[int, Set] = {}

    async def connect(self, ws: WebSocket, room: str, nickname: str, user_id: int, avatar: str = None, is_admin: bool = False):
        await ws.accept()
        if room not in self._rooms:
            self._rooms[room] = set()
        self._rooms[room].add(ws)
        self._ws_meta[ws] = (room, nickname, user_id, avatar, is_admin)
        if user_id not in self._user_ws:
            self._user_ws[user_id] = set()
        self._user_ws[user_id].add(ws)
        # Announce join
        await self.broadcast_room(room, {
            "type": "presence",
            "event": "join",
            "nickname": nickname,
            "room": room,
        }, exclude=ws)

    def disconnect(self, ws: WebSocket):
        meta = self._ws_meta.pop(ws, None)
        if not meta:
            return
        room, nickname, user_id = meta[:3]
        if room in self._rooms:
            self._rooms[room].discard(ws)
            if not self._rooms[room]:
                del self._rooms[room]
        if user_id in self._user_ws:
            self._user_ws[user_id].discard(ws)
            if not self._user_ws[user_id]:
                del self._user_ws[user_id]
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

    def update_user_meta(self, user_id: int, *, avatar: str = None, nickname: str = None):
        """Update cached meta (avatar / nickname) on all active websockets for a user."""
        for ws in list(self._user_ws.get(user_id, [])):
            meta = self._ws_meta.get(ws)
            if not meta:
                continue
            room, nick, uid, av, is_adm = meta
            if avatar is not None:
                av = avatar
            if nickname is not None:
                nick = nickname
            self._ws_meta[ws] = (room, nick, uid, av, is_adm)

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
    """Track users in voice channels per room. Mesh topology for <=8 users."""
    
    def __init__(self):
        # room -> set of (user_id, nickname, avatar)
        self._voice_rooms: Dict[str, Set[tuple]] = {}
    
    def join(self, room: str, user_id: int, nickname: str, avatar: str = None):
        """User joins voice channel. Returns list of existing participants."""
        if room not in self._voice_rooms:
            self._voice_rooms[room] = set()
        
        # Max 8 users per voice channel
        if len(self._voice_rooms[room]) >= 8:
            return None  # Room full
        
        existing = list(self._voice_rooms[room])
        self._voice_rooms[room].add((user_id, nickname, avatar or ""))
        return existing
    
    def leave(self, room: str, user_id: int):
        """User leaves voice channel."""
        if room not in self._voice_rooms:
            return
        self._voice_rooms[room] = {u for u in self._voice_rooms[room] if u[0] != user_id}
        if not self._voice_rooms[room]:
            del self._voice_rooms[room]
    
    def participants(self, room: str):
        """Get list of participants in voice channel."""
        return [
            {"user_id": u[0], "nickname": u[1], "avatar": u[2]}
            for u in self._voice_rooms.get(room, set())
        ]
    
    def is_in_voice(self, room: str, user_id: int) -> bool:
        """Check if user is in voice channel."""
        return any(u[0] == user_id for u in self._voice_rooms.get(room, set()))
    
    def leave_all(self, user_id: int):
        """Remove user from all voice channels (on disconnect)."""
        rooms_left = []
        for room in list(self._voice_rooms.keys()):
            before = len(self._voice_rooms[room])
            self._voice_rooms[room] = {u for u in self._voice_rooms[room] if u[0] != user_id}
            if len(self._voice_rooms[room]) < before:
                rooms_left.append(room)
            if not self._voice_rooms[room]:
                del self._voice_rooms[room]
        return rooms_left


manager = ConnectionManager()
voice_manager = VoiceManager()
