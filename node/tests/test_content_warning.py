"""Public channel 18+ content-warning gate (API + session ack)."""
import os
import tempfile
import unittest


class ContentWarningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = os.path.join(cls._tmpdir.name, "cw.db")
        os.environ["FROGTALK_CSRF_SECRET"] = "test-csrf-content-warning"
        os.environ["ADMIN_PASSWORD"] = "test-admin-pass"
        from fastapi.testclient import TestClient
        import importlib
        import database as db_mod
        import main

        importlib.reload(db_mod)
        db_mod.init_db()
        importlib.reload(main)
        cls.client = TestClient(main.app)
        cls.db = db_mod

    @classmethod
    def tearDownClass(cls):
        cls._tmpdir.cleanup()

    def _session(self, nick: str, password: str = "secret12"):
        uid = self.db.create_user(nick, password)
        self.assertIsNotNone(uid)
        return self.db.create_session(uid)

    def _hdr(self, token: str):
        return {"X-Session-Token": token}

    def _create_public_room(self, owner_token: str, name: str, *, cw=None):
        body = {"name": name, "description": "test", "type": "public"}
        if cw is not None:
            body["content_warning"] = cw
        cr = self.client.post("/api/rooms", json=body, headers=self._hdr(owner_token))
        self.assertEqual(cr.status_code, 200, cr.text)
        return cr.json()

    def test_create_room_with_content_warning(self):
        owner = self._session("cw_owner_a")
        self._create_public_room(
            owner,
            "cw-pub-a",
            cw={"enabled": True, "flags": ["nudity", "violence"]},
        )
        enabled, flags = self.db.get_room_content_warning("cw-pub-a")
        self.assertTrue(enabled)
        cw = self.db.content_warning_to_dict(enabled, flags)
        self.assertTrue(cw["enabled"])
        self.assertEqual(set(cw["flags"]), {"nudity", "violence"})

    def test_enabled_without_flags_rejected(self):
        owner = self._session("cw_owner_b")
        cr = self.client.post(
            "/api/rooms",
            json={
                "name": "cw-pub-b",
                "description": "test",
                "type": "public",
                "content_warning": {"enabled": True, "flags": []},
            },
            headers=self._hdr(owner),
        )
        self.assertEqual(cr.status_code, 400, cr.text)
        self.assertIn("category", cr.json().get("error", "").lower())
        self.assertIsNone(self.db.get_room_by_name("cw-pub-b"))

    def test_creator_must_ack_after_create(self):
        owner = self._session("cw_owner_f")
        self._create_public_room(
            owner,
            "cw-pub-f",
            cw={"enabled": True, "flags": ["nudity"]},
        )
        st = self.client.get(
            "/api/rooms/cw-pub-f/content-warning/status",
            headers=self._hdr(owner),
        )
        self.assertEqual(st.status_code, 200, st.text)
        body = st.json()
        self.assertTrue(body["required"])
        self.assertFalse(body["acknowledged"])

    def test_leave_clears_content_warning_ack(self):
        owner = self._session("cw_owner_g")
        member = self._session("cw_member_g")
        self._create_public_room(
            owner,
            "cw-pub-g",
            cw={"enabled": True, "flags": ["violence"]},
        )
        self.client.post("/api/rooms/cw-pub-g/join", headers=self._hdr(member))
        ack = self.client.post(
            "/api/rooms/cw-pub-g/content-warning/ack",
            json={"confirm": True},
            headers=self._hdr(member),
        )
        self.assertEqual(ack.status_code, 200, ack.text)
        leave = self.client.post("/api/rooms/cw-pub-g/leave", headers=self._hdr(member))
        self.assertEqual(leave.status_code, 200, leave.text)
        st = self.client.get(
            "/api/rooms/cw-pub-g/content-warning/status",
            headers=self._hdr(member),
        )
        self.assertTrue(st.json().get("required"))

    def test_private_room_rejects_content_warning(self):
        owner = self._session("cw_owner_c")
        uid = self.db.get_user_by_token(owner)["id"]
        rid = self.db.create_room("cw-priv-c", "secret", "private", uid, None)
        self.assertIsNotNone(rid)
        self.db.join_room(uid, rid)
        pr = self.client.patch(
            "/api/rooms/cw-priv-c",
            json={"content_warning": {"enabled": True, "flags": ["nudity"]}},
            headers=self._hdr(owner),
        )
        self.assertEqual(pr.status_code, 400, pr.text)

    def test_status_required_until_ack(self):
        owner = self._session("cw_owner_d")
        member = self._session("cw_member_d")
        self._create_public_room(
            owner,
            "cw-pub-d",
            cw={"enabled": True, "flags": ["mature_themes"]},
        )
        self.client.post("/api/rooms/cw-pub-d/join", headers=self._hdr(member))

        st = self.client.get(
            "/api/rooms/cw-pub-d/content-warning/status",
            headers=self._hdr(member),
        )
        self.assertEqual(st.status_code, 200, st.text)
        body = st.json()
        self.assertTrue(body["required"])
        self.assertFalse(body["acknowledged"])
        self.assertTrue(body["content_warning"]["enabled"])

        hist = self.client.get(
            "/api/messages/cw-pub-d?limit=20",
            headers=self._hdr(member),
        )
        self.assertEqual(hist.status_code, 451, hist.text)
        self.assertTrue(hist.json().get("content_warning_required"))

        ack = self.client.post(
            "/api/rooms/cw-pub-d/content-warning/ack",
            json={"confirm": True},
            headers=self._hdr(member),
        )
        self.assertEqual(ack.status_code, 200, ack.text)
        self.assertFalse(ack.json().get("required"))

        hist2 = self.client.get(
            "/api/messages/cw-pub-d?limit=20",
            headers=self._hdr(member),
        )
        self.assertEqual(hist2.status_code, 200, hist2.text)

    def test_flag_change_rerequires_ack(self):
        owner = self._session("cw_owner_e")
        member = self._session("cw_member_e")
        self._create_public_room(
            owner,
            "cw-pub-e",
            cw={"enabled": True, "flags": ["nudity"]},
        )
        self.client.post("/api/rooms/cw-pub-e/join", headers=self._hdr(member))
        self.client.post(
            "/api/rooms/cw-pub-e/content-warning/ack",
            json={"confirm": True},
            headers=self._hdr(member),
        )
        ok = self.client.get("/api/messages/cw-pub-e?limit=20", headers=self._hdr(member))
        self.assertEqual(ok.status_code, 200, ok.text)

        patch = self.client.patch(
            "/api/rooms/cw-pub-e",
            json={"content_warning": {"enabled": True, "flags": ["nudity", "violence"]}},
            headers=self._hdr(owner),
        )
        self.assertEqual(patch.status_code, 200, patch.text)

        blocked = self.client.get(
            "/api/messages/cw-pub-e?limit=20",
            headers=self._hdr(member),
        )
        self.assertEqual(blocked.status_code, 451, blocked.text)

    def test_database_helpers_round_trip(self):
        db = self.db
        uid = db.create_user("cw_db_user", "secret12")
        rid = db.create_room("cw-db-room", "mature", "public", uid, None)
        self.assertIsNotNone(rid)
        self.assertTrue(
            db.set_room_content_warning("cw-db-room", enabled=True, flags=db.CW_NUDITY | db.CW_EXTREMISM)
        )
        enabled, flags = db.get_room_content_warning("cw-db-room")
        self.assertTrue(enabled)
        self.assertEqual(flags, db.CW_NUDITY | db.CW_EXTREMISM)
        cw = db.content_warning_to_dict(enabled, flags)
        self.assertEqual(set(cw["flags"]), {"nudity", "extremism"})
        parsed = db.parse_content_warning_flags(["violence", "nudity", "bogus"])
        self.assertEqual(parsed, db.CW_NUDITY | db.CW_VIOLENCE)


if __name__ == "__main__":
    unittest.main()
