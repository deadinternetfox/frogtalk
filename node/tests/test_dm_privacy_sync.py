"""Bilateral DM timer + wipe privacy sync."""
import json
import unittest
import uuid

import database as db
import dm_system_messages as dmsys


class DmPrivacySyncTests(unittest.TestCase):
    def setUp(self):
        db.init_db()
        suffix = uuid.uuid4().hex[:8]
        self.actor = int(db.create_user(f"dm_wipe_actor_{suffix}", "secret12"))
        self.peer = int(db.create_user(f"dm_wipe_peer_{suffix}", "secret12"))
        self.assertTrue(self.actor and self.peer)
        self.cid = int(db.get_or_create_dm(self.actor, self.peer))

    def test_apply_dm_channel_wipe_idempotent(self):
        db.send_dm_message(self.cid, self.actor, "hello")
        db.send_dm_message(self.cid, self.peer, "hi back")
        wid = "abc123wipe"
        r1 = db.apply_dm_channel_wipe(self.cid, self.actor, wipe_id=wid)
        self.assertTrue(r1.get("ok"))
        self.assertFalse(r1.get("idempotent"))
        with db._conn() as con:
            n = con.execute(
                "SELECT COUNT(*) AS c FROM dm_messages WHERE channel_id=?",
                (self.cid,),
            ).fetchone()["c"]
            row = con.execute(
                "SELECT wiped_at, last_wipe_id FROM dm_channels WHERE id=?",
                (self.cid,),
            ).fetchone()
        self.assertEqual(int(n), 0)
        self.assertTrue(str(row["wiped_at"] or "").strip())
        self.assertEqual(str(row["last_wipe_id"]), wid)

        r2 = db.apply_dm_channel_wipe(self.cid, self.actor, wipe_id=wid)
        self.assertTrue(r2.get("ok"))
        self.assertTrue(r2.get("idempotent"))

    def test_disappear_timer_content(self):
        raw = dmsys.disappear_timer_content(
            actor_nick="alice",
            peer_nick="bob",
            seconds=3600,
            actor_is_self=False,
        )
        self.assertTrue(raw.startswith(dmsys.DMSYS_PREFIX))
        meta = json.loads(raw[len(dmsys.DMSYS_PREFIX):])
        self.assertEqual(meta["kind"], "disappear_timer")
        self.assertIn("alice", meta["subtitle"])
        self.assertIn("1 hour", meta["subtitle"])

    def test_chat_wiped_content(self):
        raw = dmsys.chat_wiped_content(actor_nick="alice", peer_nick="bob")
        meta = json.loads(raw[len(dmsys.DMSYS_PREFIX):])
        self.assertEqual(meta["kind"], "chat_wiped")
        self.assertIn("alice", meta["subtitle"])
        self.assertIn("Encryption", meta["subtitle"])

    def test_sync_apply_wiped_at_clears_messages(self):
        db.send_dm_message(self.cid, self.actor, "old")
        ok = db.apply_sync_dm_channel_settings(
            self.cid,
            self.actor,
            wiped_at="2099-01-01T00:00:00Z",
            last_wipe_id="sync-wipe-1",
        )
        self.assertTrue(ok)
        with db._conn() as con:
            n = con.execute(
                "SELECT COUNT(*) AS c FROM dm_messages WHERE channel_id=?",
                (self.cid,),
            ).fetchone()["c"]
        self.assertEqual(int(n), 0)


if __name__ == "__main__":
    unittest.main()
