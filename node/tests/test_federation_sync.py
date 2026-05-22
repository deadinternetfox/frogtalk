"""Federation sync layer: directory index, member roster, history backfill.

These tests cover the database helpers and apply paths that drive the
node-switch experience (per the plan in
``federation_sync_and_calls_bca15485.plan.md``). The federation event
relay itself is exercised in ``test_federated_calls.py``; here we focus
on the inputs/outputs of the local SQL helpers.
"""
import os
import tempfile
import unittest


class FederationSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = os.path.join(cls._tmpdir.name, "fed.db")
        os.environ["FROGTALK_CSRF_SECRET"] = "test-csrf-fed-sync"
        os.environ["ADMIN_PASSWORD"] = "test-admin-pass"
        import importlib
        import database as db_mod

        importlib.reload(db_mod)
        db_mod.init_db()
        cls.db = db_mod

    @classmethod
    def tearDownClass(cls):
        cls._tmpdir.cleanup()

    # ── Directory index ───────────────────────────────────────────

    def test_directory_index_upsert_and_tombstone(self):
        db = self.db
        ok = db.upsert_federation_channel_index(
            room_name="public-au",
            home_server_id="srv_au",
            description="Hello from AU",
            member_count=7,
            category="general",
            visibility="public",
        )
        self.assertTrue(ok)
        row = db.get_federation_channel_index_entry("public-au")
        self.assertIsNotNone(row)
        self.assertEqual(int(row["member_count"]), 7)
        self.assertEqual(int(row["tombstoned"]), 0)

        self.assertTrue(db.tombstone_federation_channel_index("public-au", "srv_au"))
        # Tombstone is hidden from the public-facing entry lookup so the
        # UI never displays a deleted channel.
        self.assertIsNone(db.get_federation_channel_index_entry("public-au"))

    def test_directory_index_list_excludes_tombstoned(self):
        db = self.db
        db.upsert_federation_channel_index(
            room_name="alive",
            home_server_id="srv_eu",
            description="",
            visibility="public",
        )
        db.upsert_federation_channel_index(
            room_name="dead",
            home_server_id="srv_eu",
            description="",
            visibility="public",
        )
        db.tombstone_federation_channel_index("dead", "srv_eu")
        names = {r["name"] for r in db.list_federation_channel_index(limit=50)}
        self.assertIn("alive", names)
        self.assertNotIn("dead", names)

    def test_directory_index_private_visibility_refused(self):
        """Only ``visibility='public'`` rows are accepted to keep
        privately-listed channels out of the discovery surface even if a
        peer's payload tags them otherwise."""
        ok = self.db.upsert_federation_channel_index(
            room_name="should-be-rejected",
            home_server_id="srv_eu",
            visibility="private",
        )
        self.assertFalse(ok)
        self.assertIsNone(self.db.get_federation_channel_index_entry("should-be-rejected"))

    # ── Member roster ─────────────────────────────────────────────

    def test_federation_room_member_snapshot_replace(self):
        db = self.db
        room = "fed-room-1"
        # Seed three members from a snapshot.
        db.replace_federation_room_members(
            room_name=room,
            snapshot=[
                {"global_user_id": "gid-a", "nickname": "alice", "role": "owner"},
                {"global_user_id": "gid-b", "nickname": "bob", "role": "member"},
                {"global_user_id": "gid-c", "nickname": "carol", "role": "member"},
            ],
            sourced_from_home=True,
        )
        rows = db.list_federation_room_members(room)
        self.assertEqual(len(rows), 3)

        # New snapshot drops carol and adds dave — replace should mirror it
        # because ``sourced_from_home`` lets the helper tombstone misses.
        db.replace_federation_room_members(
            room_name=room,
            snapshot=[
                {"global_user_id": "gid-a", "nickname": "alice", "role": "owner"},
                {"global_user_id": "gid-b", "nickname": "bob", "role": "member"},
                {"global_user_id": "gid-d", "nickname": "dave", "role": "member"},
            ],
            sourced_from_home=True,
        )
        rows = db.list_federation_room_members(room)
        gids = {r["global_user_id"] for r in rows}
        self.assertEqual(gids, {"gid-a", "gid-b", "gid-d"})

    def test_non_home_snapshot_only_additive(self):
        """Non-home peer snapshots must not purge members.

        Without this guard a peer holding only the shared federation
        token could send a 0-member snapshot for a room and silently
        empty our cached roster on the destination node.
        """
        db = self.db
        room = "fed-room-2"
        db.replace_federation_room_members(
            room_name=room,
            snapshot=[
                {"global_user_id": "gid-x", "nickname": "x", "role": "owner"},
                {"global_user_id": "gid-y", "nickname": "y", "role": "member"},
            ],
            sourced_from_home=True,
        )
        # Non-home peer pushes a snapshot with only ``gid-y``; ``gid-x``
        # must remain because the source isn't authoritative.
        db.replace_federation_room_members(
            room_name=room,
            snapshot=[
                {"global_user_id": "gid-y", "nickname": "y", "role": "member"},
            ],
            sourced_from_home=False,
        )
        rows = db.list_federation_room_members(room)
        gids = {r["global_user_id"] for r in rows}
        self.assertIn("gid-x", gids)
        self.assertIn("gid-y", gids)

    # ── History backfill (DM origin/idempotency) ──────────────────

    def test_sync_import_accepted_friendship(self):
        db = self.db
        a = db.create_user("sync_a", "secret12")
        b = db.create_user("sync_b", "secret12")
        self.assertIsNotNone(a)
        self.assertIsNotNone(b)
        self.assertTrue(db.sync_import_accepted_friendship(a, b))
        self.assertTrue(db.are_friends(a, b))

    def test_save_synced_dm_message_idempotent(self):
        db = self.db
        sender = db.create_user("alice_dm", "secret12")
        recipient = db.create_user("bob_dm", "secret12")
        self.assertIsNotNone(sender)
        self.assertIsNotNone(recipient)
        ch_id = db.get_or_create_dm(sender, recipient)
        self.assertIsNotNone(ch_id)
        # Insert the same synced row twice; the second call must be a
        # no-op — never a duplicate.
        first = db.save_synced_dm_message(
            channel_id=int(ch_id),
            sender_id=sender,
            content="ct-v1",
            source_server_id="srv_au",
            origin_message_id="ext-msg-1",
        )
        again = db.save_synced_dm_message(
            channel_id=int(ch_id),
            sender_id=sender,
            content="ct-v1",
            source_server_id="srv_au",
            origin_message_id="ext-msg-1",
        )
        self.assertTrue(first)
        # The helper short-circuits on already-stored rows so the second
        # call reports False (not an error — just nothing new to do).
        self.assertFalse(again)
        with db._conn() as con:
            count = con.execute(
                "SELECT COUNT(*) AS n FROM dm_messages "
                "WHERE sync_origin_server_id=? AND sync_origin_message_id=?",
                ("srv_au", "ext-msg-1"),
            ).fetchone()["n"]
        self.assertEqual(int(count), 1)

    # ── FrogSocial account sync ───────────────────────────────────

    def test_apply_synced_social_post_feed_and_profile(self):
        db = self.db
        viewer = db.create_user("sync_feed_viewer", "secret12")
        self.assertIsNotNone(viewer)
        origin = "srv_home_test"
        author_gid = "gid-sync-feed-author-0001"
        post_gid = "gid-sync-feed-post-0001"
        payload = {
            "global_post_id": post_gid,
            "origin_server_id": origin,
            "author_global_user_id": author_gid,
            "nickname": "sync_feed_author",
            "author_display_name": "Synced Author Name",
            "content": "synced hello",
            "privacy": "public",
            "share_enabled": 1,
            "allow_comments": 1,
            "created_at": "2025-06-01 12:00:00",
            "enc_v": 0,
        }
        local_id = db.apply_synced_social_post(
            payload, origin, viewer_user_id=viewer,
        )
        self.assertIsNotNone(local_id)
        author = db.get_user_profile("sync_feed_author") or {}
        self.assertTrue(author)
        db.follow_user(viewer, int(author["id"]))
        feed = db.get_feed_posts(viewer, limit=20)
        self.assertTrue(any(int(p.get("id") or 0) == int(local_id) for p in feed))
        explore = db.get_explore_posts(viewer, limit=20)
        self.assertTrue(any(int(p.get("id") or 0) == int(local_id) for p in explore))
        self.assertEqual(str(author.get("display_name") or ""), "Synced Author Name")

    def test_apply_synced_social_post_idempotent(self):
        db = self.db
        viewer = db.create_user("sync_idem_v", "secret12")
        origin = "srv_idem_test"
        payload = {
            "global_post_id": "gid-sync-idem-post-0001",
            "author_global_user_id": "gid-sync-idem-author-01",
            "nickname": "sync_idem_a",
            "content": "once",
            "privacy": "public",
            "enc_v": 0,
        }
        first = db.apply_synced_social_post(payload, origin, viewer_user_id=viewer)
        second = db.apply_synced_social_post(payload, origin, viewer_user_id=viewer)
        self.assertIsNotNone(first)
        self.assertEqual(int(first), int(second))


if __name__ == "__main__":
    unittest.main()
