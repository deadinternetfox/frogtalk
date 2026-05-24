"""Federation block + privacy propagation."""
import unittest
import uuid
from unittest.mock import patch

import database as db
from routers import federation as federation_mod


class FederationBlockPrivacyTests(unittest.TestCase):
    def setUp(self):
        db.init_db()
        suffix = uuid.uuid4().hex[:8]
        self.blocker = int(db.create_user(f"blk_actor_{suffix}", "secret12"))
        self.blocked = int(db.create_user(f"blk_peer_{suffix}", "secret12"))
        self.assertTrue(self.blocker and self.blocked)
        with db._conn() as con:
            self.blocker_gid = str(uuid.uuid4())
            self.blocked_gid = str(uuid.uuid4())
            con.execute(
                "UPDATE users SET global_user_id=? WHERE id=?",
                (self.blocker_gid, self.blocker),
            )
            con.execute(
                "UPDATE users SET global_user_id=? WHERE id=?",
                (self.blocked_gid, self.blocked),
            )
            con.commit()
        ident = db.get_or_create_local_server_identity() or {}
        self.home_sid = str(ident.get("server_id") or "local-home")

    def test_block_event_payload_includes_gids(self):
        blocker = db.get_user_by_id(self.blocker) or {}
        blocked = db.get_user_by_id(self.blocked) or {}
        payload = federation_mod._user_block_event_payload(blocker, blocked)
        self.assertEqual(payload["blocker_global_user_id"], self.blocker_gid)
        self.assertEqual(payload["blocked_global_user_id"], self.blocked_gid)

    @patch.object(federation_mod, "_ensure_local_user_by_nickname")
    def test_handle_block_creates_mirror_for_blocked_gid(self, mock_ensure):
        mock_ensure.return_value = db.get_user_by_id(self.blocker)
        import asyncio
        asyncio.get_event_loop().run_until_complete(
            federation_mod._handle_user_block_event(
                "user.blocked",
                {
                    "blocker_nickname": (db.get_user_by_id(self.blocker) or {}).get("nickname"),
                    "blocked_nickname": (db.get_user_by_id(self.blocked) or {}).get("nickname"),
                    "blocker_global_user_id": self.blocker_gid,
                    "blocked_global_user_id": self.blocked_gid,
                },
                origin=self.home_sid,
            )
        )
        self.assertTrue(db.is_blocked(self.blocker, self.blocked))

    def test_privacy_snapshot_and_effective_profile_public(self):
        db.upsert_federation_user_profile(
            self.blocked_gid,
            (db.get_user_by_id(self.blocked) or {}).get("nickname") or "peer",
            origin_server_id=self.home_sid,
        )
        db.apply_federation_user_privacy(
            self.blocked_gid,
            profile_public=0,
            allow_dms_from="nobody",
        )
        snap = db.get_federation_privacy_snapshot(self.blocked_gid)
        self.assertEqual(snap.get("profile_public"), 0)
        self.assertEqual(snap.get("allow_dms_from"), "nobody")
        peer = db.get_user_by_id(self.blocked) or {}
        peer["global_user_id"] = self.blocked_gid
        with patch.object(db, "resolve_global_user_home_server_id", return_value="remote-home"):
            with patch.object(db, "get_or_create_local_server_identity", return_value={"server_id": "local-node"}):
                self.assertFalse(db.effective_profile_public(peer))


if __name__ == "__main__":
    unittest.main()
