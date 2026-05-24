"""Regression: presence reflects live sessions, not stale DB defaults."""
import os
import tempfile
import time
import unittest


class UserPresenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = os.path.join(cls._tmpdir.name, "test.db")
        os.environ["ADMIN_PASSWORD"] = "test-admin-pass"
        import importlib
        import database as db_mod

        importlib.reload(db_mod)
        db_mod.init_db()
        cls.db = db_mod

    @classmethod
    def tearDownClass(cls):
        cls._tmpdir.cleanup()

    def test_stale_db_online_renders_offline_without_live_session(self):
        db = self.db
        uid = db.create_user("offline_peer", "secret12345")
        self.assertIsNotNone(uid)
        with db._conn() as con:
            con.execute("UPDATE users SET presence='online' WHERE id=?", (uid,))
            con.commit()
        self.assertEqual(db.effective_presence_for_user(uid), "offline")

    def test_federated_connection_counts_as_live(self):
        db = self.db
        uid = db.create_user("fed_peer", "secret12345")
        self.assertIsNotNone(uid)
        row = db.get_user_by_id(uid) or {}
        gid = str(row.get("global_user_id") or "").strip()
        self.assertTrue(gid)
        with db._conn() as con:
            con.execute("UPDATE users SET presence='online' WHERE id=?", (uid,))
            con.commit()
        db.upsert_federation_user_connection(gid, "srv_remote_test", updated_at=int(time.time()))
        self.assertEqual(db.effective_presence_for_user(uid, gid), "online")

    def test_away_preserved_when_live(self):
        db = self.db
        uid = db.create_user("away_peer", "secret12345")
        self.assertIsNotNone(uid)
        row = db.get_user_by_id(uid) or {}
        gid = str(row.get("global_user_id") or "").strip()
        with db._conn() as con:
            con.execute("UPDATE users SET presence='away' WHERE id=?", (uid,))
            con.commit()
        db.upsert_federation_user_connection(gid, "srv_remote_test2", updated_at=int(time.time()))
        self.assertEqual(db.effective_presence_for_user(uid, gid), "away")
