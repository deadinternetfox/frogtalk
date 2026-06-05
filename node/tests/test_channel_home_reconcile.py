"""Self-healing of ``rooms.home_server_id`` drift.

Regression coverage for the corruption where a locally-created channel had its
home column branded with a *peer's* server_id, after which the genuine owner's
banner / 18+ / settings edits were treated as cross-node mirror edits and
relayed to a node that disclaimed the channel — so they silently never saved.
"""
import os
import tempfile
import unittest


class ChannelHomeReconcileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = os.path.join(cls._tmpdir.name, "home.db")
        os.environ["FROGTALK_CSRF_SECRET"] = "test-csrf-home-reconcile"
        os.environ["ADMIN_PASSWORD"] = "test-admin-pass"
        import importlib
        import database as db_mod

        importlib.reload(db_mod)
        db_mod.init_db()
        cls.db = db_mod
        cls.local_sid = str(
            (db_mod.get_or_create_local_server_identity() or {}).get("server_id") or ""
        ).strip()
        cls.assertTruthy = lambda self, v, m="": self.assertTrue(bool(v), m)

    @classmethod
    def tearDownClass(cls):
        cls._tmpdir.cleanup()

    # ----- helpers ----------------------------------------------------------
    def _mk_owner(self, nick, *, account_home=""):
        uid = self.db.create_user(nick, "secret12")
        self.assertIsNotNone(uid)
        if account_home:
            self.db.set_user_account_home_server_id(uid, account_home, force=True)
        return uid

    def _mk_room(self, name, owner_id, *, home=None):
        rid = self.db.create_room(name, "d", "public", owner_id, None)
        self.assertIsNotNone(rid)
        if home is not None:
            with self.db._conn() as con:
                con.execute(
                    "UPDATE rooms SET home_server_id=? WHERE id=?", (home, rid)
                )
                con.commit()
        return rid

    def _home(self, name):
        return str((self.db.get_room_by_name(name) or {}).get("home_server_id") or "").strip()

    def _add_remote_message(self, room_name, origin_sid):
        sender = int(self.db.get_or_create_federation_system_user())
        with self.db._conn() as con:
            con.execute(
                "INSERT INTO messages (room_name, user_id, nickname, content, origin_server_id) "
                "VALUES (?,?,?,?,?)",
                (room_name, sender, "remoteguy", "hi", origin_sid),
            )
            con.commit()

    # ----- tests ------------------------------------------------------------
    def test_create_room_stamps_local_home(self):
        owner = self._mk_owner("home_creator")
        self._mk_room("home-born-local", owner)
        self.assertEqual(self._home("home-born-local"), self.local_sid)

    def test_reclaim_orphan_local_channel(self):
        """Local-origin owner + bogus peer home + no index + no remote content."""
        owner = self._mk_owner("home_orphan_owner")  # account homed here (unset)
        self._mk_room("home-orphan", owner, home="srv_bogus_peer_aaaa")
        self.assertEqual(self._home("home-orphan"), "srv_bogus_peer_aaaa")
        out = self.db.reconcile_channel_home_server_ids()
        self.assertIn("home-orphan", out["reclaimed"])
        self.assertEqual(self._home("home-orphan"), self.local_sid)

    def test_reclaim_scoped_to_one_room(self):
        owner = self._mk_owner("home_scope_owner")
        self._mk_room("home-scope", owner, home="srv_bogus_peer_bbbb")
        out = self.db.reconcile_channel_home_server_ids("home-scope")
        self.assertEqual(out["reclaimed"], ["home-scope"])
        self.assertEqual(self._home("home-scope"), self.local_sid)

    def test_leaves_correct_local_channel(self):
        owner = self._mk_owner("home_correct_owner")
        self._mk_room("home-correct", owner)  # born home=local_sid
        out = self.db.reconcile_channel_home_server_ids("home-correct")
        self.assertEqual(out["reclaimed"], [])
        self.assertEqual(out["adopted"], [])
        self.assertEqual(self._home("home-correct"), self.local_sid)

    def test_does_not_reclaim_remote_sourced_mirror(self):
        """Owned by a local user but holds messages replicated from a peer."""
        owner = self._mk_owner("home_mirror_owner")
        self._mk_room("home-mirror", owner, home="srv_remote_home_cccc")
        self._add_remote_message("home-mirror", "srv_remote_home_cccc")
        out = self.db.reconcile_channel_home_server_ids("home-mirror")
        self.assertEqual(out["reclaimed"], [])
        self.assertEqual(self._home("home-mirror"), "srv_remote_home_cccc")

    def test_does_not_reclaim_visiting_owner_channel(self):
        """Owner's account is homed on another node → genuinely remote."""
        owner = self._mk_owner("home_visitor", account_home="srv_remote_home_dddd")
        self._mk_room("home-visiting", owner, home="srv_remote_home_dddd")
        out = self.db.reconcile_channel_home_server_ids("home-visiting")
        self.assertEqual(out["reclaimed"], [])
        self.assertEqual(self._home("home-visiting"), "srv_remote_home_dddd")

    def test_adopt_directory_consensus(self):
        """Directory index names a remote home → follow the mesh."""
        owner = self._mk_owner("home_adopt_owner")
        self._mk_room("home-adopt", owner, home="srv_stale_eeee")
        self.db.upsert_federation_channel_index(
            "home-adopt", "srv_consensus_ffff", owner_nickname="x"
        )
        out = self.db.reconcile_channel_home_server_ids("home-adopt")
        self.assertEqual(out["adopted"], ["home-adopt"])
        self.assertEqual(self._home("home-adopt"), "srv_consensus_ffff")

    def test_index_says_we_are_home_is_a_reclaim(self):
        owner = self._mk_owner("home_idxself_owner")
        self._mk_room("home-idxself", owner, home="srv_wrong_gggg")
        self.db.upsert_federation_channel_index(
            "home-idxself", self.local_sid, owner_nickname="x"
        )
        out = self.db.reconcile_channel_home_server_ids("home-idxself")
        self.assertIn("home-idxself", out["reclaimed"])
        self.assertEqual(self._home("home-idxself"), self.local_sid)

    def test_import_does_not_rehome_local_channel(self):
        """A replicated message must not brand our own channel with the peer id."""
        owner = self._mk_owner("home_import_owner")
        rid = self._mk_room("home-import", owner, home="")  # force the empty window
        self.assertEqual(self._home("home-import"), "")
        self.db.save_federated_room_message(
            "evt-import-1",
            {"room_name": "home-import", "content": "yo", "nickname": "peerguy"},
            origin_server_id="srv_peer_hhhh",
        )
        # Stamped to *us*, not the peer, because a local-origin owner owns it.
        self.assertEqual(self._home("home-import"), self.local_sid)

    def test_import_stamps_peer_for_genuinely_remote_channel(self):
        """A brand-new federated channel we don't have still homes at the peer."""
        self.db.save_federated_room_message(
            "evt-import-2",
            {"room_name": "home-newremote", "content": "yo", "nickname": "peerguy"},
            origin_server_id="srv_peer_iiii",
        )
        self.assertEqual(self._home("home-newremote"), "srv_peer_iiii")


if __name__ == "__main__":
    unittest.main()
