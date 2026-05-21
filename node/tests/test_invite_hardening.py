"""Invite system hardening: membership, validation, atomic consume, caps."""
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor, as_completed


class InviteHardeningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = os.path.join(cls._tmpdir.name, "test.db")
        os.environ["FROGTALK_CSRF_SECRET"] = "test-csrf-invite-hardening"
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

    def _make_public_room(self, owner_token: str, name: str):
        owner = self.db.get_user_by_token(owner_token)
        rid = self.db.create_room(name, "test", "public", owner["id"], None)
        self.assertIsNotNone(rid)
        self.db.join_room(owner["id"], rid)
        return rid

    def _make_private_room(self, owner_token: str, name: str):
        owner = self.db.get_user_by_token(owner_token)
        rid = self.db.create_room(name, "test", "private", owner["id"], None)
        self.assertIsNotNone(rid)
        self.db.join_room(owner["id"], rid)
        self.db.update_room_settings(name, invite_only=1, who_can_invite="owner")
        return rid

    def test_non_member_cannot_create_invite_on_public(self):
        owner = self._session("ih_owner_a")
        outsider = self._session("ih_outsider_a")
        self._make_public_room(owner, "ih-pub-a")

        cr = self.client.post(
            "/api/invites/channels/ih-pub-a",
            json={"max_uses": 5},
            headers=self._hdr(outsider),
        )
        self.assertEqual(cr.status_code, 403, cr.text)
        self.assertIn("member", cr.json().get("error", "").lower())

    def test_negative_max_uses_rejected(self):
        owner = self._session("ih_owner_b")
        self._make_public_room(owner, "ih-pub-b")
        cr = self.client.post(
            "/api/invites/channels/ih-pub-b",
            json={"max_uses": -1},
            headers=self._hdr(owner),
        )
        self.assertEqual(cr.status_code, 422, cr.text)

    def test_invalid_expires_hours_rejected(self):
        owner = self._session("ih_owner_c")
        self._make_public_room(owner, "ih-pub-c")
        cr = self.client.post(
            "/api/invites/channels/ih-pub-c",
            json={"max_uses": 1, "expires_hours": 0},
            headers=self._hdr(owner),
        )
        self.assertEqual(cr.status_code, 422, cr.text)

    def test_banned_user_join_does_not_consume_use(self):
        owner = self._session("ih_owner_d")
        banned = self._session("ih_banned_d")
        rid = self._make_private_room(owner, "ih-priv-d")
        cr = self.client.post(
            "/api/invites/channels/ih-priv-d",
            json={"max_uses": 1},
            headers=self._hdr(owner),
        )
        self.assertEqual(cr.status_code, 200, cr.text)
        code = cr.json()["code"]
        owner_u = self.db.get_user_by_token(owner)
        banned_u = self.db.get_user_by_token(banned)
        self.db.ban_user_from_room(rid, banned_u["id"], owner_u["id"], reason="test")
        j = self.client.post(f"/api/invites/{code}/join", headers=self._hdr(banned))
        self.assertEqual(j.status_code, 403, j.text)
        self.assertEqual(j.json().get("code"), "room_banned")
        inv = self.db.get_invite(code)
        self.assertEqual(inv["use_count"], 0)

    def test_one_shot_only_one_new_member_consumes(self):
        owner = self._session("ih_owner_e")
        self._make_private_room(owner, "ih-priv-e")
        cr = self.client.post(
            "/api/invites/channels/ih-priv-e",
            json={"max_uses": 1},
            headers=self._hdr(owner),
        )
        self.assertEqual(cr.status_code, 200, cr.text)
        code = cr.json()["code"]
        tokens = [self._session(f"ih_joiner_e{i}") for i in range(4)]

        def _join(tok):
            return self.client.post(f"/api/invites/{code}/join", headers=self._hdr(tok))

        ok = 0
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(_join, t) for t in tokens]
            for fut in as_completed(futures):
                r = fut.result()
                if r.status_code == 200:
                    ok += 1
        self.assertEqual(ok, 1)
        inv = self.db.get_invite(code)
        self.assertEqual(inv["use_count"], 1)

    def test_channel_invite_cap(self):
        owner = self._session("ih_owner_f")
        rid = self._make_public_room(owner, "ih-pub-f")
        owner_u = self.db.get_user_by_token(owner)
        from routers.invites import MAX_INVITES_PER_CHANNEL

        for i in range(MAX_INVITES_PER_CHANNEL):
            self.db.create_invite(rid, owner_u["id"], f"capcode{i:02d}", 1, None)

        extra = self.client.post(
            "/api/invites/channels/ih-pub-f",
            json={"max_uses": 1},
            headers=self._hdr(owner),
        )
        self.assertEqual(extra.status_code, 400, extra.text)
        self.assertIn("maximum", extra.json().get("error", "").lower())

    def test_redemption_unique_per_user(self):
        owner = self._session("ih_owner_g")
        joiner = self._session("ih_joiner_g")
        rid = self._make_private_room(owner, "ih-priv-g")
        cr = self.client.post(
            "/api/invites/channels/ih-priv-g",
            json={"max_uses": 5},
            headers=self._hdr(owner),
        )
        self.assertEqual(cr.status_code, 200, cr.text)
        code = cr.json()["code"]
        self.client.post(f"/api/invites/{code}/join", headers=self._hdr(joiner))
        joiner_u = self.db.get_user_by_token(joiner)
        self.db.leave_room(joiner_u["id"], rid)
        self.client.post(f"/api/invites/{code}/join", headers=self._hdr(joiner))
        inv = self.db.get_invite(code)
        self.assertEqual(inv["use_count"], 2)
        red = self.db.get_invite_redemptions([inv["id"]])[inv["id"]]
        nicks = [r["nickname"] for r in red]
        self.assertEqual(nicks.count("ih_joiner_g"), 1)


if __name__ == "__main__":
    unittest.main()
