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
        self.assertEqual(int(r2.get("social_posts_imported") or 0), 0)

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

    def test_user_at_home_requires_explicit_pin(self):
        import routers.auth as auth_mod

        db = self.db
        uid = int(db.create_user("unpinned_home", "secret12"))
        self.assertFalse(auth_mod._user_at_account_home(uid))
        local_sid = str((db.get_or_create_local_server_identity() or {}).get("server_id") or "")
        db.set_user_account_home_server_id(uid, local_sid, force=True)
        self.assertTrue(auth_mod._user_at_account_home(uid))

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


if __name__ == "__main__":
    unittest.main()
