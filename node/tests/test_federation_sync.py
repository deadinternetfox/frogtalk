"""Federation sync layer: directory index, member roster, history backfill.

These tests cover the database helpers and apply paths that drive the
node-switch experience (per the plan in
``federation_sync_and_calls_bca15485.plan.md``). The federation event
relay itself is exercised in ``test_federated_calls.py``; here we focus
on the inputs/outputs of the local SQL helpers.
"""
import json
import os
import tempfile
import unittest
from unittest import mock


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

    def test_resolve_home_native_vs_shadow(self):
        db = self.db
        import bcrypt as _bcrypt
        local_sid = str((db.get_or_create_local_server_identity() or {}).get("server_id") or "")
        self.assertTrue(local_sid)
        native_uid = db.create_user("native_home_user", "secret12")
        self.assertIsNotNone(native_uid)
        native_row = db.get_user_by_id(int(native_uid)) or {}
        native_gid = str(native_row.get("global_user_id") or "").strip()
        self.assertTrue(native_gid)
        self.assertEqual(db.resolve_global_user_home_server_id(native_gid), local_sid)

        shadow_gid = "00000000-0000-4000-8000-000000000099"
        shadow = db.ensure_federated_dm_local_user(
            shadow_gid,
            "shadow_remote",
            origin_server_id="srv_remote_peer",
        )
        self.assertIsNotNone(shadow)
        self.assertEqual(db.resolve_global_user_home_server_id(shadow_gid), "srv_remote_peer")

        traveler_gid = "00000000-0000-4000-8000-000000000098"
        pw_hash = _bcrypt.hashpw(b"secret12", _bcrypt.gensalt()).decode()
        traveler_uid = db.create_user_with_hash("traveler_user", pw_hash, traveler_gid)
        self.assertIsNotNone(traveler_uid)
        db.set_user_account_home_server_id(int(traveler_uid), "srv_real_home", force=True)
        self.assertEqual(db.resolve_global_user_home_server_id(traveler_gid), "srv_real_home")

    def test_pinned_home_wins_over_federation_profile_origin(self):
        db = self.db
        import bcrypt as _bcrypt

        local_sid = str((db.get_or_create_local_server_identity() or {}).get("server_id") or "")
        gid = "00000000-0000-4000-8000-000000000095"
        pw_hash = _bcrypt.hashpw(b"secret12", _bcrypt.gensalt()).decode()
        uid = db.create_user_with_hash("pinned_traveler", pw_hash, gid)
        self.assertIsNotNone(uid)
        db.upsert_federation_user_profile(
            gid,
            nickname="pinned_traveler",
            origin_server_id=local_sid,
        )
        db.set_user_account_home_server_id(int(uid), "srv_main_home", force=True)
        self.assertEqual(db.resolve_global_user_home_server_id(gid), "srv_main_home")

    def test_export_includes_peer_home_server_id(self):
        import routers.auth as auth_mod

        db = self.db
        exporter = db.create_user("sync_exporter", "secret12")
        self.assertIsNotNone(exporter)
        remote_gid = "00000000-0000-4000-8000-000000000091"
        shadow = db.ensure_federated_dm_local_user(
            remote_gid,
            "remote_follow",
            origin_server_id="srv_remote_export",
        )
        self.assertIsNotNone(shadow)
        peer_id = int((db.get_user_profile("remote_follow") or {}).get("id") or 0)
        self.assertGreater(peer_id, 0)
        db.follow_user(int(exporter), peer_id)
        export = auth_mod._build_sync_export_for_user(int(exporter))
        following = export.get("following") or []
        self.assertTrue(
            any(
                str(f.get("global_user_id") or "") == remote_gid
                and str(f.get("home_server_id") or "") == "srv_remote_export"
                for f in following
            ),
            f"expected remote home in export, got {following!r}",
        )

    def test_federated_wall_post_after_shadow_user(self):
        db = self.db
        viewer = db.create_user("wall_viewer", "secret12")
        self.assertIsNotNone(viewer)
        origin = "srv_wall_author_home"
        author_gid = "00000000-0000-4000-8000-000000000097"
        db.ensure_federated_dm_local_user(
            author_gid,
            "fed_wall_author",
            origin_server_id=origin,
        )
        db.follow_user(int(viewer), int(db.get_user_profile("fed_wall_author")["id"]))
        payload = {
            "global_post_id": "00000000-0000-4000-8000-000000000096",
            "author_global_user_id": author_gid,
            "nickname": "fed_wall_author",
            "content": "live federated post",
            "privacy": "public",
            "share_enabled": 1,
            "allow_comments": 1,
            "created_at": "2025-06-02 10:00:00",
        }
        local_id = db.apply_federated_wall_post_created(payload, origin)
        self.assertIsNotNone(local_id)
        feed = db.get_feed_posts(int(viewer), limit=20)
        self.assertTrue(any(int(p.get("id") or 0) == int(local_id) for p in feed))


    # ── Sidebar membership reconcile ─────────────────────────────

    def test_reconcile_user_room_memberships_prunes_stale_joins(self):
        db = self.db
        uid = db.create_user("sidebar_user", "secret12")
        self.assertIsNotNone(uid)
        uid = int(uid)
        keep_id = db.create_room("keep-channel", "stay", "public", uid, None)
        leave_id = db.create_room("old-channel", "go", "public", uid, None)
        db.join_room(uid, keep_id)
        db.join_room(uid, leave_id)
        pruned = db.reconcile_user_room_memberships(uid, {"keep-channel"})
        self.assertEqual(pruned, 1)
        joined = set(db.get_user_joined_room_ids(uid))
        self.assertIn(keep_id, joined)
        self.assertNotIn(leave_id, joined)

    def test_apply_sync_room_allowlist_persists_and_prunes_order(self):
        db = self.db
        uid = int(db.create_user("allowlist_user", "secret12"))
        keep_id = db.create_room("alpha", "a", "public", uid, None)
        stale_id = db.create_room("beta", "b", "public", uid, None)
        db.join_room(uid, keep_id)
        db.join_room(uid, stale_id)
        db.set_room_order(uid, json.dumps(["beta", "alpha", "gamma"]))
        pruned = db.apply_sync_room_allowlist(uid, {"alpha"})
        self.assertEqual(pruned, 1)
        self.assertEqual(db.get_user_sync_room_allowlist(uid), {"alpha"})
        order = json.loads(db.get_room_order(uid) or "[]")
        self.assertEqual(order, ["alpha"])

    def test_union_merge_room_allowlist_keeps_home_joins(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("merge_union_user", "secret12"))
        home_id = db.create_room("home-only", "h", "public", uid, None)
        travel_id = db.create_room("travel-new", "t", "private", uid, "hint only")
        db.join_room(uid, home_id)
        db.join_room(uid, travel_id)
        db.set_user_sync_room_allowlist(uid, ["home-only"])
        merged = auth_mod._union_merge_room_allowlist(uid, {"travel-new"})
        self.assertIn("home-only", merged)
        self.assertIn("travel-new", merged)

    def test_travel_created_room_survives_home_allowlist_prune(self):
        db = self.db
        uid = int(db.create_user("travel_creator", "secret12"))
        db.set_user_account_home_server_id(uid, "srv_home_other", force=True)
        db.set_config("federation.server_id", "srv_au_visit")
        travel_id = db.create_room("travel-prune-room", "secret grp", "private", uid, "hint")
        self.assertIsNotNone(travel_id)
        db.join_room(uid, int(travel_id))
        db.add_room_to_sync_allowlist(uid, "travel-prune-room")
        pruned = db.apply_sync_room_allowlist(uid, {"general"})
        self.assertEqual(pruned, 0)
        joined = set(db.get_user_joined_room_ids(uid))
        self.assertIn(int(travel_id), joined)
        self.assertIn("travel-prune-room", db.get_user_sync_room_allowlist(uid))

    @mock.patch("routers.auth._verify_travel_merge_export")
    def test_merge_travel_private_room_owned_on_home(self, _verify):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("home_user", "secret12"))
        gid = str((db.get_user_by_id(uid) or {}).get("global_user_id") or "")
        db.set_config("federation.server_id", "srv_home_main")
        db.set_user_account_home_server_id(uid, "srv_home_main", force=True)
        export = {
            "global_user_id": gid,
            "source_server_id": "srv_au_visit",
            "source_public_url": "https://au.example.com",
            "rooms": [{
                "name": "u",
                "type": "private",
                "channel_type": "text",
                "owner_global_user_id": gid,
                "room_key_hint": "my hint",
                "invite_only": 1,
                "who_can_invite": "owner",
            }],
            "travel_push": True,
        }
        applied = auth_mod._apply_sync_export_to_user(
            uid,
            export,
            fetch_origin="https://au.example.com",
            merge_mode=True,
            merge_peer_server_id="srv_au_visit",
        )
        self.assertGreaterEqual(int(applied.get("rooms_joined") or 0), 1)
        room = db.get_room_by_name("u")
        self.assertIsNotNone(room)
        self.assertEqual(int(room.get("owner_id") or 0), uid)
        joined = set(db.get_user_joined_room_ids(uid))
        self.assertIn(int(room["id"]), joined)

    def test_travel_push_export_is_lean(self):
        import json
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("travel_lean", "secret12"))
        db.set_config("federation.server_id", "srv_au_visit")
        db.set_user_account_home_server_id(uid, "srv_home_main", force=True)
        room_id = db.create_room("leanroom", "Lean", "private", uid, "hint")
        self.assertIsNotNone(room_id)
        db.join_room(uid, int(room_id))
        export = auth_mod._build_sync_travel_push_export(uid)
        self.assertTrue(export.get("travel_push"))
        self.assertEqual(export.get("sync_export_page"), "travel")
        self.assertNotIn("social_posts", export)
        self.assertNotIn("room_histories", export)
        self.assertNotIn("stories", export)
        self.assertNotIn("public_rooms", export)
        names = [r.get("name") for r in (export.get("rooms") or []) if isinstance(r, dict)]
        self.assertIn("leanroom", names)
        blob = json.dumps(export)
        self.assertLess(len(blob), 512_000)

    def test_travel_push_includes_staged_room_secrets(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("travel_secrets", "secret12"))
        db.set_config("federation.server_id", "srv_au_visit")
        db.set_user_account_home_server_id(uid, "srv_home_main", force=True)
        room_id = db.create_room("secroom", "Secret", "private", uid, "hint")
        self.assertIsNotNone(room_id)
        db.join_room(uid, int(room_id))
        db.stage_travel_room_secrets(uid, [{
            "room_name": "secroom",
            "secret": "my-shared-pass",
            "key_version": 1,
        }])
        export = auth_mod._build_sync_travel_push_export(uid)
        secrets = export.get("room_secrets") or []
        self.assertEqual(len(secrets), 1)
        self.assertEqual(secrets[0].get("room_name"), "secroom")

    @mock.patch("routers.auth._verify_travel_merge_export")
    def test_merge_travel_room_secrets_pending_on_home(self, _verify):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("home_secrets", "secret12"))
        gid = str((db.get_user_by_id(uid) or {}).get("global_user_id") or "")
        db.set_config("federation.server_id", "srv_home_main")
        db.set_user_account_home_server_id(uid, "srv_home_main", force=True)
        export = {
            "global_user_id": gid,
            "source_server_id": "srv_au_visit",
            "source_public_url": "https://au.example.com",
            "rooms": [],
            "room_secrets": [{
                "room_name": "secroom",
                "secret": "my-shared-pass",
                "key_version": 1,
            }],
            "travel_push": True,
        }
        applied = auth_mod._apply_sync_export_to_user(
            uid,
            export,
            fetch_origin="https://au.example.com",
            merge_mode=True,
            merge_peer_server_id="srv_au_visit",
        )
        self.assertEqual(int(applied.get("room_secrets_stored") or 0), 1)
        pending = db.take_travel_room_secrets_pending(uid)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0].get("room_name"), "secroom")

    def test_resolve_home_base_from_sync_state(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("travel_push_user", "secret12"))
        db.set_config("federation.server_id", "srv_au_visit")
        db.upsert_user_federation_sync_state(uid, {
            "source_base": "https://frogtalk.xyz",
            "source_public_url": "https://frogtalk.xyz",
            "source_server_id": "srv_home_main",
            "done": True,
        })
        base = auth_mod._resolve_home_base_for_user(uid)
        self.assertEqual(base, "https://frogtalk.xyz")

    def test_split_travel_push_export_chunks(self):
        import json
        import routers.auth as auth_mod

        export = {
            "export_version": auth_mod._SYNC_EXPORT_VERSION,
            "sync_export_page": "travel",
            "global_user_id": "gid_test_user",
            "source_server_id": "srv_au",
            "source_public_url": "https://au.example.com",
            "travel_push": True,
            "issued_at": 1,
            "exported_at": 1,
            "rooms": [{"name": f"r{i}", "type": "private", "channel_type": "text"} for i in range(25)],
            "room_secrets": [{"room_name": "r0", "secret": "s", "key_version": 1}],
            "dm_peers": [],
            "following": [],
            "friends": [],
            "friend_pending_out": [],
            "friend_pending_in": [],
            "blocked_users": [],
        }
        chunks = auth_mod._split_travel_push_export(export)
        self.assertGreaterEqual(len(chunks), 3)
        room_count = sum(len(c.get("rooms") or []) for c in chunks)
        self.assertEqual(room_count, 25)
        for c in chunks:
            wire = len(json.dumps({"export": c}).encode("utf-8"))
            self.assertLess(wire, auth_mod._FEDERATION_MERGE_BODY_MAX)

    def test_travel_room_shell_export_is_small(self):
        import json
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("shell_push_user", "secret12"))
        db.set_user_account_home_server_id(uid, "srv_home_main", force=True)
        db.set_config("federation.server_id", "srv_au_visit")
        db.upsert_user_federation_sync_state(uid, {
            "source_base": "https://frogtalk.xyz",
            "source_public_url": "https://frogtalk.xyz",
            "source_server_id": "srv_home_main",
            "done": True,
        })
        rid = db.create_room("mygrp", "Secret", "private", uid, "hint")
        self.assertIsNotNone(rid)
        db.join_room(uid, int(rid))
        db.add_room_to_sync_allowlist(uid, "mygrp")
        ctx = auth_mod._travel_push_visit_context(uid)
        self.assertIsNotNone(ctx)
        export = auth_mod._build_travel_room_shell_export(ctx, "mygrp")
        self.assertTrue(export.get("travel_shell"))
        self.assertEqual(len(export.get("rooms") or []), 1)
        self.assertEqual((export.get("rooms") or [{}])[0].get("name"), "mygrp")
        wire = len(json.dumps({"global_user_id": ctx["gid"], "export": export}).encode("utf-8"))
        self.assertLess(wire, 4096)

    def test_travel_push_retry_flag_and_status(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("retry_push_user", "secret12"))
        db.set_user_account_home_server_id(uid, "srv_home_main", force=True)
        db.set_config("federation.server_id", "srv_au_visit")
        db.upsert_user_federation_sync_state(uid, {
            "source_base": "https://frogtalk.xyz",
            "source_public_url": "https://frogtalk.xyz",
            "source_server_id": "srv_home_main",
            "done": True,
        })
        auth_mod._mark_travel_push_needs_retry(uid, "home_unreachable")
        self.assertTrue(auth_mod._travel_push_needs_client_retry(uid))
        auth_mod._clear_travel_push_retry(uid)
        self.assertFalse(auth_mod._travel_push_needs_client_retry(uid))

    def test_channel_member_federated_presence_when_not_local_ws(self):
        import routers.rooms as rooms_mod

        db = self.db
        uid = int(db.create_user("home_viewer", "secret12"))
        travel_uid = int(db.create_user("travel_peer", "secret12"))
        travel_gid = str((db.get_user_by_id(travel_uid) or {}).get("global_user_id") or "")
        db.upsert_federation_room_presence(
            "myroom",
            travel_gid,
            nickname="travel_peer",
            presence="online",
            updated_at=int(__import__("time").time()),
        )
        member = {
            "user_id": travel_uid,
            "nickname": "travel_peer",
            "global_user_id": travel_gid,
            "presence": "offline",
        }
        pres_map = db.get_federation_room_presence_map("myroom")
        out = rooms_mod._apply_channel_member_presence(
            member,
            room_name="myroom",
            local_online_ids=set(),
            viewer_user_id=uid,
            room_presence_map=pres_map,
        )
        self.assertTrue(out.get("live_online"))
        self.assertEqual(out.get("presence"), "online")

    def test_stale_room_presence_treated_as_offline(self):
        import routers.rooms as rooms_mod
        import time

        db = self.db
        uid = int(db.create_user("stale_pres_user", "secret12"))
        gid = str((db.get_user_by_id(uid) or {}).get("global_user_id") or "")
        db.upsert_federation_room_presence(
            "stale-room",
            gid,
            nickname="stale_pres_user",
            presence="online",
            updated_at=int(time.time()) - 600,
        )
        pres_map = db.get_federation_room_presence_map("stale-room")
        self.assertEqual(len(pres_map), 0)
        member = {
            "user_id": uid,
            "nickname": "stale_pres_user",
            "global_user_id": gid,
            "presence": "online",
        }
        out = rooms_mod._apply_channel_member_presence(
            member,
            room_name="stale-room",
            local_online_ids=set(),
            viewer_user_id=999,
            room_presence_map=pres_map,
        )
        self.assertFalse(out.get("live_online"))
        self.assertEqual(out.get("presence"), "offline")


    def test_list_room_message_participants_excludes_bridges(self):
        db = self.db
        uid = int(db.create_user("bridge_room_owner", "secret12"))
        room_id = db.create_room("bridge-test", "t", "public", uid, None)
        self.assertIsNotNone(room_id)
        db.save_message(
            "bridge-test",
            uid,
            "native_user",
            "hello from frogtalk",
        )
        db.save_message(
            "bridge-test",
            uid,
            "discord_guy",
            "hello from discord",
            bridge_platform="discord",
        )
        parts = db.list_room_message_participants("bridge-test")
        nicks = {str(p.get("nickname") or "").lower() for p in parts}
        self.assertIn("native_user", nicks)
        self.assertNotIn("discord_guy", nicks)


    def test_remove_room_from_sync_allowlist(self):
        db = self.db
        uid = int(db.create_user("allow_rm_user", "secret12"))
        db.set_user_sync_room_allowlist(uid, ["alpha", "beta"])
        db.set_room_order(uid, json.dumps(["beta", "alpha"]))
        db.remove_room_from_sync_allowlist(uid, "beta")
        self.assertEqual(db.get_user_sync_room_allowlist(uid), {"alpha"})
        order = json.loads(db.get_room_order(uid) or "[]")
        self.assertEqual(order, ["alpha"])

    def test_sync_state_persists_in_sqlite(self):
        db = self.db
        uid = int(db.create_user("persist_sync", "secret12"))
        db.upsert_user_federation_sync_state(uid, {
            "in_progress": True,
            "done": False,
            "progress_pct": 42,
            "phase": "channels",
            "hint": "test",
            "source_base": "https://home.example",
            "source_server_id": "srv_home_test",
        })
        row = db.get_user_federation_sync_state(uid)
        self.assertTrue(row.get("in_progress"))
        self.assertEqual(int(row.get("progress_pct") or 0), 42)
        db.clear_user_federation_sync_state(uid)
        self.assertEqual(db.get_user_federation_sync_state(uid), {})

    def test_paginate_ordered_post_ids(self):
        import routers.auth as auth_mod

        ordered = list(range(1, 401))
        page, has_more, nxt = auth_mod._paginate_ordered_post_ids(ordered, "", 300)
        self.assertEqual(len(page), 300)
        self.assertTrue(has_more)
        self.assertTrue(nxt)
        page2, has_more2, _ = auth_mod._paginate_ordered_post_ids(ordered, nxt, 300)
        self.assertEqual(len(page2), 100)
        self.assertFalse(has_more2)

    def test_verify_sync_export_rejects_wrong_home(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("verify_user", "secret12"))
        db.set_user_account_home_server_id(uid, "srv_pinned_home", force=True)
        gid = str((db.get_user_by_id(uid) or {}).get("global_user_id") or "").strip()
        export = {
            "export_version": 2,
            "global_user_id": gid,
            "source_server_id": "srv_evil",
            "source_public_url": "https://home.example",
        }
        with self.assertRaises(ValueError):
            auth_mod._verify_sync_export(
                export,
                user_id=uid,
                fetch_origin="https://home.example",
            )

    def test_dm_channel_settings_sync_export_apply(self):
        import routers.auth as auth_mod

        db = self.db
        traveler = int(db.create_user("dm_prefs_traveler", "secret12"))
        peer = int(db.create_user("dm_prefs_peer", "secret12"))
        self.assertTrue(traveler and peer)
        cid = int(db.get_or_create_dm(traveler, peer))
        self.assertTrue(cid)
        db.set_dm_disappear_timer(cid, traveler, 3600)
        with db._conn() as con:
            con.execute(
                "UPDATE dm_channels SET forwarding_disabled=1 WHERE id=?",
                (cid,),
            )
            con.execute(
                "UPDATE dm_channels SET last_read_a=42, hidden_by_a=1 WHERE id=?",
                (cid,),
            )
            con.commit()
        export = auth_mod._build_sync_export_for_user(traveler)
        row = next(
            (p for p in (export.get("dm_peers") or []) if p.get("nickname") == "dm_prefs_peer"),
            None,
        )
        self.assertIsNotNone(row, export.get("dm_peers"))
        self.assertEqual(row.get("disappear_after"), 3600)
        self.assertEqual(row.get("forwarding_disabled"), 1)
        self.assertEqual(row.get("my_last_read"), 42)
        self.assertEqual(row.get("hidden"), 1)

        import crypto_fed as cf

        home_sid = "srv_dm_prefs"
        db.upsert_federation_server(
            home_sid,
            "DM Prefs Home",
            "https://dm-prefs.test",
            official=True,
            server_pubkey=cf.get_local_public_key_pem(),
        )
        db.set_user_account_home_server_id(traveler, home_sid, force=True)
        with db._conn() as con:
            con.execute(
                "UPDATE dm_channels SET disappear_after=0, forwarding_disabled=0, "
                "last_read_a=0, last_read_b=0, hidden_by_a=0, hidden_by_b=0 WHERE id=?",
                (cid,),
            )
            con.commit()
        gid = str((db.get_user_by_id(traveler) or {}).get("global_user_id") or "").strip()
        payload = auth_mod._attach_sync_export_signature({
            "export_version": 2,
            "global_user_id": gid,
            "source_server_id": home_sid,
            "source_public_url": "https://dm-prefs.test",
            "dm_peers": [row],
            "following": [],
            "friends": [],
            "blocked_users": [],
            "rooms": [],
            "public_rooms": [],
            "social_posts": [],
            "dm_histories": [],
            "member_snapshots": [],
            "self_profile": {},
        })
        auth_mod._apply_sync_export_to_user(traveler, payload, fetch_origin="https://dm-prefs.test")
        self.assertEqual(db.get_dm_disappear_timer(cid), 3600)
        with db._conn() as con:
            ch = con.execute(
                "SELECT user_a, user_b, forwarding_disabled, last_read_a, last_read_b, "
                "hidden_by_a, hidden_by_b FROM dm_channels WHERE id=?",
                (cid,),
            ).fetchone()
        self.assertEqual(int(ch["forwarding_disabled"]), 1)
        is_a = int(ch["user_a"]) == traveler
        my_read = int(ch["last_read_a"] if is_a else ch["last_read_b"])
        hidden = int(ch["hidden_by_a"] if is_a else ch["hidden_by_b"])
        self.assertGreaterEqual(my_read, 42)
        self.assertEqual(hidden, 1)

    def test_export_pagination_metadata(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("page_exporter", "secret12"))
        for i in range(5):
            db.create_wall_post(uid, f"post {i}", privacy="public")
        export = auth_mod._build_sync_export_for_user(uid)
        self.assertEqual(int(export.get("export_version") or 0), 2)
        self.assertIn("social_posts_total", export)

    def test_sync_stale_ttl_marks_incomplete(self):
        import routers.auth as auth_mod

        os.environ["FROGTALK_SYNC_STALE_HOURS"] = "1"
        db = self.db
        uid = int(db.create_user("stale_traveler", "secret12"))
        db.set_user_account_home_server_id(uid, "srv_stale_home", force=True)
        db.upsert_user_federation_sync_state(uid, {
            "done": True,
            "finished_at": int(__import__("time").time()) - 7200,
            "error": "",
            "social_posts_imported": 10,
            "social_posts_total": 10,
        })
        self.assertTrue(auth_mod._sync_stale_for_user(uid))
        self.assertTrue(auth_mod._sync_incomplete_for_user(uid))
        os.environ["FROGTALK_SYNC_STALE_HOURS"] = "0"

    def test_resolve_sync_source_uses_pinned_home(self):
        import routers.auth as auth_mod

        db = self.db
        db.upsert_federation_server(
            "srv_home_bind",
            "Home Bind",
            "https://home-bind.test",
            official=True,
        )
        uid = int(db.create_user("bind_traveler", "secret12"))
        db.set_user_account_home_server_id(uid, "srv_home_bind", force=True)
        src = auth_mod._resolve_sync_source_base(
            uid,
            client_source_base="https://evil-peer.test",
        )
        self.assertEqual(src, "https://home-bind.test")

    def test_paginated_apply_accumulates_posts(self):
        import routers.auth as auth_mod

        db = self.db
        viewer = int(db.create_user("pag_viewer", "secret12"))
        author = int(db.create_user("pag_author", "secret12"))
        author_gid = str((db.get_user_by_id(author) or {}).get("global_user_id") or "").strip()
        origin = str((db.get_or_create_local_server_identity() or {}).get("server_id") or "srv_local")
        self.assertTrue(author_gid)
        posts = []
        for i in range(3):
            pid = db.create_wall_post(int(author), f"pag post {i}", privacy="public")
            post_gid, _ = db.register_local_wall_post_global_id(int(pid))
            self.assertTrue(post_gid)
            posts.append({
                "global_post_id": post_gid,
                "author_global_user_id": author_gid,
                "nickname": "pag_author",
                "content": f"pag post {i}",
                "privacy": "public",
                "origin_server_id": origin,
                "author_home_server_id": origin,
                "created_at": f"2025-06-02 10:0{i}:00",
            })
        imported = 0
        for post in posts:
            lid = db.apply_synced_social_post(post, origin, viewer_user_id=viewer)
            if lid:
                imported += 1
        self.assertGreaterEqual(imported, 2)
        page2 = {
            "sync_export_page": "social",
            "source_server_id": origin,
            "source_public_url": "https://home.test",
            "social_posts": posts[:1],
            "social_posts_total": 3,
        }
        r2 = auth_mod._apply_sync_social_posts_only(viewer, page2)
        self.assertEqual(int(r2.get("social_posts_imported") or 0), 1)

    def test_sync_state_persists_across_restart(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("restart_traveler", "secret12"))
        db.upsert_user_federation_sync_state(uid, {
            "in_progress": False,
            "done": False,
            "progress_pct": 15,
            "phase": "channels",
            "hint": "resume after restart",
            "source_base": "https://home-restart.test",
        })
        auth_mod._federation_sync_state.clear()
        st = auth_mod._sync_state_get(uid)
        self.assertEqual(int(st.get("progress_pct") or 0), 15)
        self.assertEqual(str(st.get("phase") or ""), "channels")

    def test_sync_export_sign_and_verify(self):
        import crypto_fed as cf
        import routers.auth as auth_mod

        export = auth_mod._attach_sync_export_signature({
            "export_version": 2,
            "global_user_id": "00000000-0000-4000-8000-000000000001",
            "source_server_id": "srv_local",
            "source_public_url": "https://home.test",
            "issued_at": 1,
        })
        pem = cf.get_local_public_key_pem()
        self.assertTrue(str(export.get("export_sig_b64") or "").strip())
        self.assertTrue(cf.verify_sync_export_signature(export, pem))
        bad = dict(export)
        bad["issued_at"] = 2
        self.assertFalse(cf.verify_sync_export_signature(bad, pem))

    def test_verify_sync_export_rejects_unsigned_when_required(self):
        import crypto_fed as cf
        import routers.auth as auth_mod

        db = self.db
        ident = db.get_or_create_local_server_identity() or {}
        home_sid = str(ident.get("server_id") or "srv_unsigned_home")
        db.upsert_federation_server(
            home_sid,
            "Unsigned Home",
            "https://unsigned-home.test",
            official=True,
            server_pubkey=cf.get_local_public_key_pem(),
        )
        uid = int(db.create_user("unsigned_traveler", "secret12"))
        db.set_user_account_home_server_id(uid, home_sid, force=True)
        gid = str((db.get_user_by_id(uid) or {}).get("global_user_id") or "").strip()
        export = {
            "export_version": 2,
            "global_user_id": gid,
            "source_server_id": home_sid,
            "source_public_url": "https://unsigned-home.test",
        }
        with self.assertRaises(ValueError) as ctx:
            auth_mod._verify_sync_export(
                export,
                user_id=uid,
                fetch_origin="https://unsigned-home.test",
            )
        self.assertIn("export_signature_required", str(ctx.exception))

    def test_federation_register_token_cannot_overwrite_pubkey(self):
        import crypto_fed as cf

        db = self.db
        victim_sid = "srv_victim_peer"
        real_pem = cf.get_local_public_key_pem()
        db.upsert_federation_server(
            victim_sid,
            "Victim",
            "https://victim.test",
            server_pubkey=real_pem,
        )
        attacker_pem = cf.get_local_public_key_pem()
        db.upsert_federation_server(
            victim_sid,
            "Victim",
            "https://victim.test",
            server_pubkey=attacker_pem,
            allow_pubkey_overwrite=False,
        )
        stored = str(db.get_federation_server_pubkey(victim_sid) or "")
        self.assertEqual(stored.strip(), real_pem.strip())

    def test_verify_sync_export_checks_signature_when_present(self):
        import crypto_fed as cf
        import routers.auth as auth_mod

        db = self.db
        ident = db.get_or_create_local_server_identity() or {}
        home_sid = str(ident.get("server_id") or "srv_sig_home")
        db.upsert_federation_server(
            home_sid,
            "Sig Home",
            "https://sig-home.test",
            official=True,
            server_pubkey=cf.get_local_public_key_pem(),
        )
        uid = int(db.create_user("sig_traveler", "secret12"))
        db.set_user_account_home_server_id(uid, home_sid, force=True)
        gid = str((db.get_user_by_id(uid) or {}).get("global_user_id") or "").strip()
        export = auth_mod._attach_sync_export_signature({
            "export_version": 2,
            "global_user_id": gid,
            "source_server_id": home_sid,
            "source_public_url": "https://sig-home.test",
            "issued_at": 1,
        })
        auth_mod._verify_sync_export(
            export,
            user_id=uid,
            fetch_origin="https://sig-home.test",
        )
        export["issued_at"] = 99
        pem = cf.get_local_public_key_pem()
        self.assertFalse(cf.verify_sync_export_signature(export, pem))
        with self.assertRaises(ValueError) as ctx:
            auth_mod._verify_sync_export(
                export,
                user_id=uid,
                fetch_origin="https://sig-home.test",
            )
        self.assertIn("export_signature_invalid", str(ctx.exception))

    def test_paginated_sync_imports_more_than_300_posts(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("bulk_exporter", "secret12"))
        for i in range(350):
            db.create_wall_post(uid, f"bulk {i}", privacy="public")
        export = auth_mod._build_sync_export_for_user(uid)
        self.assertGreaterEqual(int(export.get("social_posts_total") or 0), 350)
        self.assertTrue(export.get("social_posts_has_more"))
        imported = len(export.get("social_posts") or [])
        cursor = str(export.get("social_posts_next_cursor") or "").strip()
        guard = 0
        while cursor and guard < 10:
            guard += 1
            page = auth_mod._build_sync_export_for_user(uid, social_posts_cursor=cursor)
            imported += len(page.get("social_posts") or [])
            if not page.get("social_posts_has_more"):
                break
            cursor = str(page.get("social_posts_next_cursor") or "").strip()
        self.assertGreaterEqual(imported, 350)

    def test_wall_reposts_sync_export_apply(self):
        import routers.auth as auth_mod
        import crypto_fed as cf

        db = self.db
        owner = int(db.create_user("repost_owner", "secret12"))
        traveler = int(db.create_user("repost_traveler", "secret12"))
        self.assertTrue(owner and traveler)
        post_id = int(db.create_wall_post(owner, "shared post", privacy="public"))
        self.assertTrue(post_id)
        db.toggle_wall_repost(post_id, traveler, quote_text="nice")

        export = auth_mod._build_sync_export_for_user(traveler)
        reposts = export.get("wall_reposts") or []
        self.assertGreaterEqual(len(reposts), 1)
        self.assertGreaterEqual(int(export.get("wall_reposts_total") or 0), 1)

        ident = db.get_or_create_local_server_identity() or {}
        home_sid = str(ident.get("server_id") or "").strip()
        self.assertTrue(home_sid)
        db.upsert_federation_server(
            home_sid,
            "Repost Home",
            "https://repost-home.test",
            official=True,
            server_pubkey=cf.get_local_public_key_pem(),
        )
        db.set_user_account_home_server_id(traveler, home_sid, force=True)
        gid = str((db.get_user_by_id(traveler) or {}).get("global_user_id") or "").strip()
        post_gid, post_origin = db.ensure_federation_wall_post_global_id(post_id)
        payload = auth_mod._attach_sync_export_signature({
            "export_version": 2,
            "global_user_id": gid,
            "source_server_id": home_sid,
            "source_public_url": "https://repost-home.test",
            "social_posts": [{
                "global_post_id": post_gid,
                "origin_server_id": post_origin,
                "author_global_user_id": str((db.get_user_by_id(owner) or {}).get("global_user_id") or ""),
                "nickname": "repost_owner",
                "content": "shared post",
                "privacy": "public",
                "enc_v": 0,
            }],
            "wall_reposts": reposts,
            "rooms": [],
            "public_rooms": [],
            "dm_peers": [],
            "following": [],
            "friends": [],
            "blocked_users": [],
            "dm_histories": [],
            "room_histories": [],
            "room_member_snapshots": [],
            "self_profile": {},
            "push_tokens": [],
        })
        applied = auth_mod._apply_sync_export_to_user(
            traveler, payload, fetch_origin="https://repost-home.test",
        )
        self.assertGreaterEqual(int(applied.get("reposts_linked") or 0), 1)
        posts = db.get_user_reposts(traveler, traveler, limit=10, lite=True)
        self.assertTrue(any(int(p.get("id") or 0) > 0 for p in posts))

    def test_normalize_stuck_in_progress_sync_state(self):
        import routers.auth as auth_mod
        import time

        db = self.db
        uid = int(db.create_user("stuck_sync_user", "secret12"))
        home_sid = "srv_stuck"
        db.upsert_federation_server(
            home_sid,
            "Stuck Home",
            "https://stuck-home.test",
            official=True,
        )
        db.set_user_account_home_server_id(uid, home_sid, force=True)
        old = int(time.time()) - 90000
        auth_mod._sync_state_set(uid, {
            "in_progress": True,
            "done": False,
            "progress_pct": 87,
            "phase": "social_posts",
            "hint": "Importing posts…",
            "started_at": old,
            "updated_at": old,
        })
        st = auth_mod._sync_state_get(uid)
        self.assertFalse(st.get("in_progress"))
        self.assertTrue(st.get("done"))
        self.assertEqual(int(st.get("progress_pct") or 0), 100)
        self.assertTrue(str(st.get("error") or "").strip())

    def test_friend_requested_federation_event_by_global_user_id(self):
        import asyncio
        from routers import federation as fed_mod

        db = self.db
        alice_id = int(db.create_user("alice_fed_fr", "secret12"))
        alice = db.get_user_by_id(alice_id) or {}
        alice_gid = str(alice.get("global_user_id") or "").strip()
        self.assertTrue(alice_gid)

        bob_gid = "00000000-0000-4000-8000-000000000090"
        bob = db.ensure_federated_dm_local_user(
            bob_gid,
            "bob_fed_fr",
            origin_server_id="srv_bob_home",
        )
        bob_id = int(bob.get("id") or 0)
        self.assertEqual(db.friend_request_status(alice_id, bob_id), "none")

        asyncio.run(fed_mod._handle_friend_event({
            "event_type": "friend.requested",
            "origin_server_id": "srv_travel_node",
            "payload": {
                "from_global_user_id": alice_gid,
                "from_nickname": "alice_fed_fr",
                "to_global_user_id": bob_gid,
                "to_nickname": "bob_fed_fr",
            },
        }))
        self.assertEqual(db.friend_request_status(alice_id, bob_id), "sent")

    def test_social_follow_changed_from_travel_node(self):
        import asyncio
        from routers import federation as fed_mod

        db = self.db
        follower_gid = "00000000-0000-4000-8000-000000000091"
        follower = db.ensure_federated_dm_local_user(
            follower_gid,
            "travel_follower",
            origin_server_id="srv_follower_home",
        )
        db.upsert_federation_user_profile(
            follower_gid,
            "travel_follower",
            origin_server_id="srv_follower_home",
        )
        following_id = int(db.create_user("local_following", "secret12"))
        following = db.get_user_by_id(following_id) or {}
        following_gid = str(following.get("global_user_id") or "").strip()

        asyncio.run(fed_mod._handle_social_event({
            "event_type": "social.follow.changed",
            "origin_server_id": "srv_travel_node",
            "payload": {
                "action": "follow",
                "follower_nickname": "travel_follower",
                "follower_global_user_id": follower_gid,
                "following_nickname": "local_following",
                "following_global_user_id": following_gid,
            },
        }))
        self.assertTrue(db.is_following(int(follower["id"]), following_id))

    def test_sync_export_includes_pin_settings_bcrypt_only(self):
        import bcrypt
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("pin_sync_user", "secret12"))
        pin_hash = bcrypt.hashpw(b"2468", bcrypt.gensalt()).decode()
        with db._conn() as con:
            con.execute(
                """
                UPDATE users
                SET pin_hash=?,
                    pin_require_on_unlock=1,
                    pin_require_for_admin=1,
                    pin_require_after_autologin=1,
                    pin_idle_timeout_sec=120,
                    pin_keypad_privacy=1
                WHERE id=?
                """,
                (pin_hash, uid),
            )
            con.commit()
        export = auth_mod._build_sync_export_for_user(uid)
        prof = export.get("self_profile") or {}
        self.assertTrue(str(prof.get("pin_hash") or "").startswith("$2"))
        self.assertEqual(int(prof.get("pin_require_on_unlock") or 0), 1)
        self.assertEqual(int(prof.get("pin_keypad_privacy") or 0), 1)
        self.assertEqual(int(prof.get("pin_idle_timeout_sec") or 0), 120)

        travel_uid = int(db.create_user("pin_sync_travel", "secret12"))
        auth_mod._apply_sync_pin_from_self_profile(travel_uid, prof)
        status = db.get_pin_status(travel_uid)
        self.assertEqual(int(status.get("has_pin") or 0), 1)
        self.assertEqual(int(status.get("pin_require_on_unlock") or 0), 1)
        self.assertEqual(int(status.get("pin_idle_timeout_sec") or 0), 120)

        bad = dict(prof)
        bad["pin_hash"] = "not-a-bcrypt-hash"
        auth_mod._apply_sync_pin_from_self_profile(travel_uid, bad)
        status2 = db.get_pin_status(travel_uid)
        self.assertEqual(int(status2.get("has_pin") or 0), 0)

    def test_sync_export_includes_stories_when_small_media(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("story_sync_user", "secret12"))
        tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        db.create_story(uid, tiny, "image/png", "sync caption", "public")
        export = auth_mod._build_sync_export_for_user(uid)
        rows = export.get("stories") or []
        self.assertGreaterEqual(len(rows), 1)
        self.assertTrue(str(rows[0].get("global_story_id") or ""))

    def test_app_sound_stored_as_server_url_in_client_prefs(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("app_sound_user", "secret12"))
        wav = (
            "data:audio/wav;base64,UklGRtQkAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YbAkAAA="
        )
        stored = auth_mod._finalize_client_prefs_for_storage(
            uid,
            {"custom_sounds": {"app:msg": wav}},
        )
        self.assertIn("/api/auth/app-sounds/msg/file", stored)
        export = auth_mod._client_prefs_for_sync_export(uid, stored)
        self.assertEqual(
            (export.get("custom_sounds") or {}).get("app:msg"),
            "/api/auth/app-sounds/msg/file",
        )

    def test_friend_pending_export_includes_outgoing_requests(self):
        import routers.auth as auth_mod

        db = self.db
        sender_id = int(db.create_user("pending_sender", "secret12"))
        receiver_gid = "00000000-0000-4000-8000-000000000092"
        receiver = db.ensure_federated_dm_local_user(
            receiver_gid,
            "pending_receiver",
            origin_server_id="srv_recv_home",
        )
        receiver_id = int(receiver.get("id") or 0)
        db.send_friend_request(sender_id, receiver_id)
        export = auth_mod._build_sync_export_for_user(sender_id)
        out_rows = export.get("friend_pending_out") or []
        self.assertTrue(
            any(r.get("global_user_id") == receiver_gid for r in out_rows),
            out_rows,
        )


class FederationSyncLoginApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = os.path.join(cls._tmpdir.name, "fed_login.db")
        os.environ["FROGTALK_CSRF_SECRET"] = "test-csrf-fed-login"
        os.environ["ADMIN_PASSWORD"] = "test-admin-pass"
        os.environ["FROGTALK_SYNC_LOGIN_RESUME"] = "1"
        os.environ["FROGTALK_SYNC_PERSIST"] = "1"
        from fastapi.testclient import TestClient
        import importlib
        import database as db_mod
        import main

        importlib.reload(db_mod)
        db_mod.init_db()
        importlib.reload(main)
        cls.db = db_mod
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        cls._tmpdir.cleanup()

    def _foreign_traveler(self, nick: str = "login_traveler"):
        db = self.db
        ident = db.get_or_create_local_server_identity() or {}
        local_sid = str(ident.get("server_id") or "").strip()
        home_sid = "srv_login_home"
        if local_sid == home_sid:
            home_sid = "srv_login_home_alt"
        db.upsert_federation_server(
            home_sid,
            "Login Home",
            "https://login-home.test",
            official=True,
        )
        uid = int(db.create_user(nick, "secret12"))
        db.set_user_account_home_server_id(uid, home_sid, force=True)
        return uid, home_sid

    def test_login_foreign_node_triggers_resume_when_incomplete(self):
        from unittest.mock import AsyncMock, patch
        import routers.auth as auth_mod

        uid, _ = self._foreign_traveler()
        self.db.upsert_user_federation_sync_state(uid, {
            "done": False,
            "in_progress": False,
            "error": "",
            "social_posts_imported": 1,
            "social_posts_total": 10,
        })
        with patch.object(
            auth_mod,
            "_start_federation_sync_for_user",
            new_callable=AsyncMock,
        ) as mock_start:
            mock_start.return_value = {
                "in_progress": True,
                "source_base": "https://login-home.test",
                "progress_pct": 5,
                "phase": "fetch",
                "hint": "resuming",
            }
            r = self.client.post(
                "/api/auth/login",
                json={"nickname": "login_traveler", "password": "secret12"},
            )
        self.assertEqual(r.status_code, 200, r.text)
        mock_start.assert_called_once()
        body = r.json()
        sync = body.get("federation_sync") or {}
        self.assertTrue(sync.get("in_progress"))

    def test_login_foreign_node_skips_resume_when_complete(self):
        from unittest.mock import AsyncMock, patch
        import routers.auth as auth_mod

        uid, _ = self._foreign_traveler("login_complete")
        self.db.upsert_user_federation_sync_state(uid, {
            "done": True,
            "in_progress": False,
            "error": "",
            "finished_at": int(__import__("time").time()),
            "social_posts_imported": 10,
            "social_posts_total": 10,
        })
        with patch.object(
            auth_mod,
            "_start_federation_sync_for_user",
            new_callable=AsyncMock,
        ) as mock_start:
            r = self.client.post(
                "/api/auth/login",
                json={"nickname": "login_complete", "password": "secret12"},
            )
        self.assertEqual(r.status_code, 200, r.text)
        mock_start.assert_not_called()

    def test_disambiguate_federated_nickname_when_taken(self):
        db = self.db
        db.create_user("alice_local", "secret12")
        alt = db.disambiguate_federated_nickname(
            "alice_local",
            "00000000-0000-4000-8000-000000000099",
            "srv_peer_abcd1234",
        )
        self.assertTrue(alt)
        self.assertNotEqual(alt.lower(), "alice_local")
        self.assertTrue(db.is_username_available(alt))

    def test_ensure_federated_dm_user_disambiguates_nick_collision(self):
        db = self.db
        local = int(db.create_user("bob_local", "secret12"))
        self.assertTrue(local)
        gid = "00000000-0000-4000-8000-000000000088"
        peer = db.ensure_federated_dm_local_user(
            gid,
            "bob_local",
            origin_server_id="srv_home_xyz9",
        )
        self.assertIsNotNone(peer)
        self.assertEqual(str(peer.get("global_user_id") or ""), gid)
        self.assertNotEqual(str(peer.get("nickname") or "").lower(), "bob_local")
        native = db.get_user_by_id(local) or {}
        self.assertNotEqual(str(native.get("global_user_id") or ""), gid)

    def test_ensure_federated_dm_does_not_hijack_native_local_nick(self):
        db = self.db
        native_uid = int(db.create_user("native_alice", "secret12"))
        self.assertTrue(native_uid)
        gid = "00000000-0000-4000-8000-000000000077"
        peer = db.ensure_federated_dm_local_user(
            gid,
            "native_alice",
            origin_server_id="srv_other_home",
        )
        self.assertIsNotNone(peer)
        self.assertEqual(str(peer.get("global_user_id") or ""), gid)
        self.assertNotEqual(int(peer.get("id") or 0), native_uid)
        untouched = db.get_user_by_id(native_uid) or {}
        self.assertNotEqual(str(untouched.get("global_user_id") or ""), gid)

    def test_room_blocks_home_sync_mirror_for_local_owner(self):
        db = self.db
        owner = int(db.create_user("room_owner", "secret12"))
        db.create_room("gaming", "local gaming", "public", owner, None)
        room = db.get_room_by_name("gaming")
        self.assertTrue(db.room_blocks_home_sync_mirror(room))
        fed_uid = int(db.get_or_create_federation_system_user())
        db.create_room("fed-shell", "shell", "public", fed_uid, None)
        shell = db.get_room_by_name("fed-shell")
        self.assertFalse(db.room_blocks_home_sync_mirror(shell))

    def test_materialize_skips_local_channel_name_collision(self):
        import routers.auth as auth_mod

        db = self.db
        owner = int(db.create_user("chan_owner", "secret12"))
        db.create_room("collide-room", "owned here", "public", owner, None)
        room = auth_mod._materialize_federated_channel({
            "name": "collide-room",
            "type": "public",
            "channel_type": "text",
        })
        self.assertIsNone(room)

    def test_user_at_home_auto_pins_legacy_native_account(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("unpinned_home", "secret12"))
        local_sid = str((db.get_or_create_local_server_identity() or {}).get("server_id") or "")
        self.assertTrue(auth_mod._user_at_account_home(uid))
        self.assertEqual(db.get_user_account_home_server_id(uid), local_sid)

    def test_user_at_home_false_when_sync_source_is_remote(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("travel_unpinned", "secret12"))
        local_sid = str((db.get_or_create_local_server_identity() or {}).get("server_id") or "")
        remote_sid = "srv_travel_remote_home"
        if remote_sid == local_sid:
            remote_sid = "srv_travel_remote_home_b"
        db.upsert_federation_server(remote_sid, "Remote", "https://remote-home.test", official=True)
        auth_mod._sync_state_set(uid, {"source_server_id": remote_sid, "source_base": "https://remote-home.test"})
        self.assertFalse(auth_mod._user_at_account_home(uid))

    def test_user_at_home_false_when_only_sync_source_base(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("travel_base_only", "secret12"))
        local_sid = str((db.get_or_create_local_server_identity() or {}).get("server_id") or "")
        remote_sid = "srv_travel_base_only_home"
        if remote_sid == local_sid:
            remote_sid = "srv_travel_base_only_home_b"
        db.upsert_federation_server(remote_sid, "Remote", "https://real-home.test", official=True)
        auth_mod._sync_state_set(uid, {"source_base": "https://real-home.test"})
        self.assertFalse(auth_mod._user_at_account_home(uid))
        self.assertNotEqual(db.get_user_account_home_server_id(uid), local_sid)

    def test_repin_account_home_api(self):
        db = self.db
        ident = db.get_or_create_local_server_identity() or {}
        local_sid = str(ident.get("server_id") or "").strip()
        home_sid = "srv_repin_real_home"
        if local_sid == home_sid:
            home_sid = "srv_repin_real_home_b"
        db.upsert_federation_server(
            home_sid,
            "Real Home",
            "https://real-home.test",
            official=True,
        )
        uid = int(db.create_user("repin_user", "secret12"))
        db.set_user_account_home_server_id(uid, local_sid, force=True)
        token = self.client.post(
            "/api/auth/login",
            json={"nickname": "repin_user", "password": "secret12"},
        ).json().get("token")
        self.assertTrue(token)
        r = self.client.post(
            "/api/auth/repin-account-home",
            json={"source_base": "https://real-home.test", "start_sync": False},
            headers={"X-Session-Token": token},
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertFalse(body.get("at_home_node"))
        self.assertEqual(db.get_user_account_home_server_id(uid), home_sid)

    def test_federation_profile_card_http_route(self):
        db = self.db
        gid = "00000000-0000-4000-8000-000000000044"
        db.upsert_federation_user_profile(
            gid,
            "http_route_peer",
            display_name="HTTP Peer",
            bio="from cache",
            origin_server_id="srv_http_home",
        )
        token = self.client.post(
            "/api/auth/login",
            json={"nickname": "http_route_peer", "password": "secret12"},
        )
        if token.status_code != 200:
            db.create_user("http_viewer", "secret12")
            token = self.client.post(
                "/api/auth/login",
                json={"nickname": "http_viewer", "password": "secret12"},
            )
        self.assertEqual(token.status_code, 200, token.text)
        sess = token.json().get("token")
        r = self.client.get(
            f"/api/federation/profile-card?global_user_id={gid}",
            headers={"X-Session-Token": sess},
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body.get("nickname"), "http_route_peer")
        self.assertEqual(body.get("global_user_id"), gid)

    def test_resolve_federated_subject_home_not_local_mirror(self):
        import routers.auth as auth_mod

        db = self.db
        ident = db.get_or_create_local_server_identity() or {}
        local_sid = str(ident.get("server_id") or "").strip()
        home_sid = "srv_subject_real_home"
        if local_sid == home_sid:
            home_sid = "srv_subject_real_home_b"
        db.upsert_federation_server(
            home_sid,
            "Subject Home",
            "https://subject-home.test",
            official=True,
        )
        gid = "00000000-0000-4000-8000-000000000033"
        db.upsert_federation_user_profile(
            gid,
            "fed_subject",
            origin_server_id=home_sid,
        )
        sid, base = auth_mod._resolve_federated_subject_home(local_sid, gid)
        self.assertEqual(sid, home_sid)
        self.assertEqual(base, "https://subject-home.test")

    def test_profile_card_remote_mirror_home_base_not_local(self):
        import routers.auth as auth_mod

        db = self.db
        ident = db.get_or_create_local_server_identity() or {}
        local_sid = str(ident.get("server_id") or "").strip()
        home_sid = "srv_card_subject_home"
        if local_sid == home_sid:
            home_sid = "srv_card_subject_home_x"
        db.upsert_federation_server(
            home_sid,
            "Card Subject Home",
            "https://card-subject-home.test",
            official=True,
        )
        gid = "00000000-0000-4000-8000-000000000022"
        db.upsert_federation_user_profile(
            gid,
            "mirror_peer",
            origin_server_id=home_sid,
        )
        db.create_user("mirror_peer", "secret12")
        with db._conn() as con:
            con.execute(
                "UPDATE users SET global_user_id=? WHERE nickname=? COLLATE NOCASE",
                (gid, "mirror_peer"),
            )
            con.commit()
        out = auth_mod.build_federation_profile_card(global_user_id=gid)
        self.assertEqual(out.get("home_server_id"), home_sid)
        self.assertEqual(out.get("home_base_url"), "https://card-subject-home.test")

    def test_build_federation_profile_card_local_user(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("fedprof_local", "secret12"))
        self.assertTrue(uid)
        row = db.get_user_by_id(uid) or {}
        gid = str(row.get("global_user_id") or "")
        out = auth_mod.build_federation_profile_card(global_user_id=gid)
        self.assertEqual(out.get("source"), "local")
        self.assertEqual(int(out.get("local_user_id") or 0), uid)
        self.assertEqual(out.get("nickname"), "fedprof_local")

    def test_apply_sync_peer_profile_cache(self):
        import routers.auth as auth_mod

        gid = "00000000-0000-4000-8000-000000000055"
        export = {
            "dm_peers": [{
                "global_user_id": gid,
                "nickname": "avatar_peer",
                "display_name": "Avatar Peer",
                "avatar": "data:image/png;base64,iVBORw0KGgo=",
                "home_server_id": "srv_avatar_home",
            }],
            "member_snapshots": [],
        }
        n = auth_mod._apply_sync_peer_profile_cache_from_export(export, "srv_avatar_home")
        self.assertEqual(n, 1)
        prof = self.db.get_federation_user_profile_row(gid) or {}
        self.assertIn("data:image", str(prof.get("avatar") or ""))


class FederationDirectoryJoinApiTests(unittest.TestCase):
    """Directory browse + join for federation_channel_index (remote_only) rows."""

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = os.path.join(cls._tmpdir.name, "fed_dir_join.db")
        os.environ["FROGTALK_CSRF_SECRET"] = "test-csrf-fed-dir-join"
        os.environ["ADMIN_PASSWORD"] = "test-admin-pass"
        from fastapi.testclient import TestClient
        import importlib
        import database as db_mod
        import main

        importlib.reload(db_mod)
        db_mod.init_db()
        importlib.reload(main)
        cls.db = db_mod
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        cls._tmpdir.cleanup()

    def _login(self, nick: str = "dir_joiner") -> str:
        db = self.db
        if not db.get_user_id_by_nickname(nick):
            db.create_user(nick, "secret12")
        r = self.client.post(
            "/api/auth/login",
            json={"nickname": nick, "password": "secret12"},
        )
        self.assertEqual(r.status_code, 200, r.text)
        token = r.json().get("token")
        self.assertTrue(token)
        return token

    def _seed_index(self, room_name: str, home_sid: str = "srv_dir_home") -> None:
        db = self.db
        db.upsert_federation_server(
            home_sid,
            "Dir Home",
            "https://dir-home.test",
            official=True,
        )
        ok = db.upsert_federation_channel_index(
            room_name=room_name,
            home_server_id=home_sid,
            description="Federated public channel",
            directory_description="Listed on home node",
            category="gaming",
            visibility="public",
            member_count=12,
            home_base_url="https://dir-home.test",
        )
        self.assertTrue(ok)

    def test_browse_includes_remote_only_channel(self):
        self._seed_index("remote-join-room")
        token = self._login()
        r = self.client.get(
            "/api/directory/channels",
            headers={"X-Session-Token": token},
        )
        self.assertEqual(r.status_code, 200, r.text)
        names = {c["name"] for c in (r.json().get("channels") or [])}
        self.assertIn("remote-join-room", names)
        row = next(c for c in r.json()["channels"] if c["name"] == "remote-join-room")
        self.assertTrue(row.get("remote_only"))
        self.assertTrue(row.get("is_federated"))

    def test_join_materializes_shell_from_index(self):
        self._seed_index("lazy-shell-room")
        token = self._login("lazy_joiner")
        self.assertIsNone(self.db.get_room_by_name("lazy-shell-room"))
        r = self.client.post(
            "/api/rooms/lazy-shell-room/join",
            headers={"X-Session-Token": token},
        )
        self.assertEqual(r.status_code, 200, r.text)
        room = self.db.get_room_by_name("lazy-shell-room")
        self.assertIsNotNone(room)
        self.assertEqual(str(room.get("home_server_id") or ""), "srv_dir_home")
        uid = int(self.db.get_user_id_by_nickname("lazy_joiner") or 0)
        self.assertTrue(self.db.is_room_member(uid, int(room["id"])))

    def test_profile_for_index_only_channel(self):
        self._seed_index("profile-fed-room")
        token = self._login("profile_viewer")
        r = self.client.get(
            "/api/directory/channels/profile-fed-room/profile",
            headers={"X-Session-Token": token},
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body.get("name"), "profile-fed-room")
        self.assertTrue(body.get("is_federated"))
        self.assertTrue(body.get("remote_only"))

    def test_join_name_collision_returns_409(self):
        db = self.db
        owner = int(db.create_user("local_chan_owner", "secret12"))
        db.create_room("collision-join", "local channel", "public", owner, None)
        self._seed_index("collision-join", home_sid="srv_other_home")
        token = self._login("collision_joiner")
        r = self.client.post(
            "/api/rooms/collision-join/join",
            headers={"X-Session-Token": token},
        )
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(r.json().get("code"), "name_collision")

    def test_materialize_directory_helper(self):
        import routers.auth as auth_mod

        self._seed_index("helper-mat-room")
        room, err = auth_mod.materialize_directory_federated_channel("helper-mat-room")
        self.assertIsNone(err)
        self.assertIsNotNone(room)
        self.assertEqual(room.get("name"), "helper-mat-room")
        self.assertEqual(str(room.get("home_server_id") or ""), "srv_dir_home")


    def test_enrich_user_profile_merges_federation_custom_style(self):
        db = self.db
        gid = "00000000-0000-4000-8000-000000000088"
        shadow = db.ensure_federated_dm_local_user(
            gid,
            "fed_style_peer",
            origin_server_id="srv_style_home",
        )
        self.assertIsNotNone(shadow)
        db.upsert_federation_user_profile(
            gid,
            "fed_style_peer",
            custom_style="color:#aabbcc;background:#112233",
            origin_server_id="srv_style_home",
        )
        prof = db.get_user_profile("fed_style_peer")
        self.assertIsNotNone(prof)
        self.assertIn("#aabbcc", str(prof.get("custom_style") or ""))

    def test_enrich_user_profile_merges_federation_banner(self):
        db = self.db
        gid = "00000000-0000-4000-8000-000000000089"
        banner = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        shadow = db.ensure_federated_dm_local_user(
            gid,
            "fed_banner_peer",
            origin_server_id="srv_banner_home",
        )
        self.assertIsNotNone(shadow)
        with db._conn() as con:
            row = con.execute(
                "SELECT id FROM users WHERE nickname=?",
                ("fed_banner_peer",),
            ).fetchone()
            uid = int(row["id"]) if row else 0
            con.execute("UPDATE users SET banner='' WHERE id=?", (uid,))
        db.upsert_federation_user_profile(
            gid,
            "fed_banner_peer",
            banner=banner,
            origin_server_id="srv_banner_home",
        )
        prof = db.get_user_profile("fed_banner_peer")
        self.assertIsNotNone(prof)
        self.assertTrue(str(prof.get("banner") or "").startswith("data:image/png"))

    def test_has_active_recovery_key(self):
        db = self.db
        user = db.create_user("recovery_key_user", "secret12")
        self.assertIsNotNone(user)
        uid = int(user)
        self.assertFalse(db.has_active_recovery_key(uid))
        db.create_recovery_key(uid, "test-recovery-token-abc123xyz")
        self.assertTrue(db.has_active_recovery_key(uid))

    def test_following_export_includes_custom_style(self):
        import routers.auth as auth_mod

        db = self.db
        exporter = db.create_user("style_exporter", "secret12")
        self.assertIsNotNone(exporter)
        remote_gid = "00000000-0000-4000-8000-000000000087"
        db.ensure_federated_dm_local_user(
            remote_gid,
            "style_follow",
            origin_server_id="srv_style_export",
        )
        db.upsert_federation_user_profile(
            remote_gid,
            "style_follow",
            custom_style="color:#ff00aa",
            mood="vibing",
            origin_server_id="srv_style_export",
        )
        peer_id = int((db.get_user_profile("style_follow") or {}).get("id") or 0)
        db.follow_user(int(exporter), peer_id)
        export = auth_mod._build_sync_export_for_user(int(exporter))
        row = next(
            (f for f in (export.get("following") or []) if f.get("global_user_id") == remote_gid),
            None,
        )
        self.assertIsNotNone(row, export.get("following"))
        self.assertIn("#ff00aa", str(row.get("custom_style") or ""))
        self.assertEqual(str(row.get("mood") or ""), "vibing")

    def test_custom_theme_json_roundtrip_in_sync_export(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("theme_sync_user", "secret12"))
        with db._conn() as con:
            con.execute(
                "UPDATE users SET theme=?, custom_theme_json=? WHERE id=?",
                (
                    "custom",
                    '{"accent":"#aabbcc","bg":"#101010","surface":"#202020"}',
                    uid,
                ),
            )
            con.commit()
        export = auth_mod._build_sync_export_for_user(uid)
        prof = export.get("self_profile") or {}
        self.assertEqual(prof.get("theme"), "custom")
        self.assertIn("#aabbcc", str(prof.get("custom_theme_json") or ""))

    def test_directory_index_theme_on_materialize(self):
        import routers.auth as auth_mod

        db = self.db
        theme = '{"accent":"#224466","bg":"#0a0a0a"}'
        db.upsert_federation_channel_index(
            "dir-theme-room",
            "srv_dir_home",
            description="Themed federated room",
            channel_theme=theme,
            home_base_url="https://dir-home.test",
        )
        room, err = auth_mod.materialize_directory_federated_channel("dir-theme-room")
        self.assertIsNone(err)
        self.assertIsNotNone(room)
        loaded = db.get_room_by_name("dir-theme-room") or {}
        self.assertIn("#224466", str(loaded.get("channel_theme") or ""))

    def test_client_prefs_onion_url_sanitized(self):
        import routers.auth as auth_mod

        raw = auth_mod._sanitize_client_prefs_json({
            "prefer_onion": 1,
            "preferred_node_url": "abc123def456ghi.onion",
        })
        data = json.loads(raw)
        self.assertEqual(data.get("preferred_node_url"), "abc123def456ghi.onion")

    def test_client_prefs_sync_export_apply(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("prefs_sync_user", "secret12"))
        prefs = auth_mod._finalize_client_prefs_for_storage(uid, {
            "prefer_onion": 1,
            "preferred_node_url": "https://travel.example",
            "custom_sounds": {
                "app:msg": "data:audio/wav;base64,UklGRiQAAABXQVZFZm10",
            },
        })
        with db._conn() as con:
            con.execute(
                "UPDATE users SET client_prefs_json=? WHERE id=?",
                (prefs, uid),
            )
            con.commit()
        export = auth_mod._build_sync_export_for_user(uid)
        prof = export.get("self_profile") or {}
        cp = prof.get("client_prefs") or {}
        self.assertEqual(cp.get("prefer_onion"), 1)
        self.assertEqual(cp.get("preferred_node_url"), "https://travel.example")
        sound = str((cp.get("custom_sounds") or {}).get("app:msg") or "")
        self.assertTrue(
            sound.startswith("/api/auth/app-sounds/") or sound.startswith("data:audio/"),
            sound,
        )

    def test_users_profile_hides_custom_css_from_viewers(self):
        owner = int(self.db.create_user("css_owner", "secret12"))
        viewer = self._login("css_viewer")
        with self.db._conn() as con:
            con.execute(
                "UPDATE users SET custom_css=?, custom_style=? WHERE id=?",
                (
                    "body{color:red}",
                    "color:#00ff00",
                    owner,
                ),
            )
            con.commit()
        r = self.client.get(
            "/api/users/profile/css_owner",
            headers={"X-Session-Token": viewer},
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertNotIn("custom_css", body)
        self.assertIn("#00ff00", str(body.get("custom_style") or ""))

    def test_materialize_applies_channel_theme(self):
        import routers.auth as auth_mod

        db = self.db
        theme = '{"accent":"#336699","bg":"#101010"}'
        room = auth_mod._materialize_federated_channel({
            "name": "themed-fed-room",
            "type": "public",
            "channel_type": "text",
            "channel_theme": theme,
        })
        self.assertIsNotNone(room)
        loaded = db.get_room_by_name("themed-fed-room") or {}
        stored = str(loaded.get("channel_theme") or "")
        self.assertIn("#336699", stored)

    def test_materialize_applies_room_banner(self):
        import routers.auth as auth_mod

        db = self.db
        room = auth_mod._materialize_federated_channel({
            "name": "banner-fed-room",
            "type": "public",
            "channel_type": "text",
            "banner": "https://cdn.example/banner.png",
        })
        self.assertIsNotNone(room)
        loaded = db.get_room_by_name("banner-fed-room") or {}
        self.assertIn("cdn.example", str(loaded.get("banner") or ""))

    def test_room_channel_settings_sync_export_apply(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("room_prefs_owner", "secret12"))
        rid = int(db.create_room("room-prefs-ch", "prefs", "public", uid, None))
        db.join_room(uid, rid)
        with db._conn() as con:
            con.execute(
                "UPDATE rooms SET forwarding_disabled=1, dj_only_queue=1, slowmode=30 WHERE id=?",
                (rid,),
            )
            con.commit()
        export = auth_mod._build_sync_export_for_user(uid)
        row = next(
            (r for r in (export.get("rooms") or []) if r.get("name") == "room-prefs-ch"),
            None,
        )
        self.assertIsNotNone(row, export.get("rooms"))
        self.assertEqual(row.get("forwarding_disabled"), 1)
        self.assertEqual(row.get("dj_only_queue"), 1)
        self.assertEqual(row.get("slowmode"), 30)

        room = auth_mod._materialize_federated_channel({
            "name": "room-prefs-import",
            "type": "public",
            "channel_type": "text",
            "forwarding_disabled": 1,
            "dj_only_queue": 1,
            "slowmode": 30,
        })
        self.assertIsNotNone(room)
        loaded = db.get_room_by_name("room-prefs-import") or {}
        self.assertEqual(int(loaded.get("forwarding_disabled") or 0), 1)
        self.assertEqual(int(loaded.get("dj_only_queue") or 0), 1)
        self.assertEqual(int(loaded.get("slowmode") or 0), 30)

    def test_materialize_patches_channel_type_on_existing_room(self):
        import routers.auth as auth_mod

        db = self.db
        auth_mod._materialize_federated_channel({
            "name": "vibes-mirror",
            "type": "public",
            "channel_type": "text",
            "description": "land",
        })
        room = auth_mod._materialize_federated_channel({
            "name": "vibes-mirror",
            "type": "public",
            "channel_type": "music",
            "dj_only_queue": 1,
            "description": "party",
        })
        self.assertIsNotNone(room)
        loaded = db.get_room_by_name("vibes-mirror") or {}
        self.assertEqual(str(loaded.get("channel_type") or ""), "music")
        self.assertEqual(int(loaded.get("dj_only_queue") or 0), 1)

    def test_travel_shell_export_includes_music_dj_only(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("travel_music_owner", "secret12"))
        rid = db.create_room("travel-vibes", "party", "public", uid, None, channel_type="music")
        self.assertIsNotNone(rid)
        db.join_room(uid, int(rid))
        with db._conn() as con:
            con.execute("UPDATE rooms SET dj_only_queue=1 WHERE id=?", (int(rid),))
            con.commit()
        room = db.get_room_by_name("travel-vibes") or {}
        payload = auth_mod._export_travel_push_room_payload(room, "srv_visit")
        self.assertEqual(payload.get("channel_type"), "music")
        self.assertEqual(payload.get("dj_only_queue"), 1)

    def test_music_queue_snapshot_skips_when_local_queue_nonempty(self):
        import asyncio
        import routers.federation as fed_mod

        db = self.db
        uid = int(db.create_user("snap_owner", "secret12"))
        rid = int(db.create_room("snap-room", "m", "public", uid, None, channel_type="music"))
        db.join_room(uid, rid)
        db.music_add_track(
            room_name="snap-room",
            submitter_id=uid,
            submitter_nick="snap_owner",
            provider="youtube",
            video_id="dQw4w9WgXcQ",
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            title="local",
            thumbnail="",
        )
        asyncio.run(
            fed_mod._handle_room_music_event("snap-room", "room.music.queue.snapshot", {
                "tracks": [{
                    "submitter_nick": "remote",
                    "provider": "youtube",
                    "video_id": "abc12345678",
                    "url": "https://www.youtube.com/watch?v=abc12345678",
                    "title": "remote",
                    "thumbnail": "",
                    "duration": 0,
                }],
            })
        )
        queue = db.music_get_queue("snap-room")
        self.assertEqual(len(queue), 1)
        self.assertEqual(str(queue[0].get("video_id") or ""), "dQw4w9WgXcQ")

    def test_sync_export_includes_room_key_hint(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("hint_room_owner", "secret12"))
        rid = int(db.create_room("hint-room", "private ch", "private", uid, "hint phrase"))
        db.join_room(uid, rid)
        export = auth_mod._build_sync_export_for_user(uid)
        row = next((r for r in (export.get("rooms") or []) if r.get("name") == "hint-room"), None)
        self.assertIsNotNone(row)
        self.assertEqual(row.get("room_key_hint"), "hint phrase")

    def test_federation_profile_updated_persists_banner(self):
        import routers.federation as fed_mod

        db = self.db
        uid = int(db.create_user("banner_fed_user", "secret12"))
        gid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        with db._conn() as con:
            con.execute("UPDATE users SET global_user_id=? WHERE id=?", (gid, uid))
            con.commit()
        banner = "data:image/png;base64,iVBORw0KGgo="
        fed_mod.db.upsert_federation_user_profile(
            gid,
            "banner_fed_user",
            origin_server_id="srv_test_origin",
            banner=banner,
        )
        row = db.get_federation_user_profile_row(gid) or {}
        self.assertIn("iVBORw0KGgo", str(row.get("banner") or ""))

    def test_social_profile_resolves_federated_cache_without_local_account(self):
        db = self.db
        gid = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
        banner = "data:image/png;base64,AAAAfedbanner"
        db.upsert_federation_user_profile(
            gid,
            "fed_only_nick",
            origin_server_id="srv_remote_home",
            banner=banner,
            avatar="🐸",
            bio="from federation cache",
        )
        self.assertIsNone(db.get_user_id_by_nickname("fed_only_nick"))
        token = self._login("fed_viewer")
        r = self.client.get(
            "/api/social/profile/fed_only_nick",
            headers={"X-Session-Token": token},
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIn("fedbanner", str(body.get("banner") or ""))
        self.assertTrue(body.get("federated"))
        self.assertEqual(str(body.get("global_user_id") or ""), gid)


if __name__ == "__main__":
    unittest.main()
