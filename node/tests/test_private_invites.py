"""Private channel invite policy and join redemption tracing."""
import os
import tempfile
import unittest


class PrivateInviteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = os.path.join(cls._tmpdir.name, "test.db")
        os.environ["FROGTALK_CSRF_SECRET"] = "test-csrf-private-invites"
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

    def _create_private_room(self, owner_token: str, name: str):
        r = self.client.post(
            "/api/rooms",
            json={"name": name, "type": "private", "description": "test"},
            headers=self._hdr(owner_token),
        )
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_private_room_defaults_who_can_invite_owner(self):
        owner = self._session("priv_owner_a")
        self._create_private_room(owner, "priv-a")
        room = self.db.get_room_by_name("priv-a")
        self.assertEqual(room.get("who_can_invite"), "owner")

    def test_cannot_set_vanity_on_private_room(self):
        owner = self._session("priv_owner_b")
        self._create_private_room(owner, "priv-b")
        r = self.client.put(
            "/api/invites/channels/priv-b/vanity",
            json={"vanity": "mysecret"},
            headers=self._hdr(owner),
        )
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("Private", r.json().get("error", ""))

    def test_private_rejects_unlimited_invite(self):
        owner = self._session("priv_owner_c")
        self._create_private_room(owner, "priv-c")
        r = self.client.post(
            "/api/invites/channels/priv-c",
            json={"max_uses": 0, "expires_hours": 24},
            headers=self._hdr(owner),
        )
        self.assertEqual(r.status_code, 400, r.text)

    def test_member_cannot_create_invite_when_policy_owner(self):
        owner = self._session("priv_owner_d")
        member = self._session("priv_member_d")
        self._create_private_room(owner, "priv-d")
        room = self.db.get_room_by_name("priv-d")
        self.db.join_room(self.db.get_user_by_token(member)["id"], room["id"])

        r = self.client.post(
            "/api/invites/channels/priv-d",
            json={"max_uses": 1, "expires_hours": 24},
            headers=self._hdr(member),
        )
        self.assertEqual(r.status_code, 403, r.text)

    def test_join_records_redemption_and_idempotent_rejoin(self):
        owner = self._session("priv_owner_e")
        joiner = self._session("priv_joiner_e")
        self._create_private_room(owner, "priv-e")

        cr = self.client.post(
            "/api/invites/channels/priv-e",
            json={"max_uses": 1, "expires_hours": 168},
            headers=self._hdr(owner),
        )
        self.assertEqual(cr.status_code, 200, cr.text)
        code = cr.json()["code"]

        j1 = self.client.post(
            f"/api/invites/{code}/join",
            headers=self._hdr(joiner),
        )
        self.assertEqual(j1.status_code, 200, j1.text)

        lst = self.client.get(
            "/api/invites/channels/priv-e",
            headers=self._hdr(owner),
        )
        self.assertEqual(lst.status_code, 200, lst.text)
        invites = lst.json().get("invites") or []
        self.assertEqual(len(invites), 1)
        self.assertEqual(invites[0]["use_count"], 1)
        redemptions = invites[0].get("redemptions") or []
        self.assertEqual(len(redemptions), 1)
        self.assertEqual(redemptions[0]["nickname"], "priv_joiner_e")

        j2 = self.client.post(
            f"/api/invites/{code}/join",
            headers=self._hdr(joiner),
        )
        self.assertEqual(j2.status_code, 200, j2.text)

        lst2 = self.client.get(
            "/api/invites/channels/priv-e",
            headers=self._hdr(owner),
        )
        invites2 = lst2.json().get("invites") or []
        self.assertEqual(invites2[0]["use_count"], 1)
        self.assertEqual(len(invites2[0].get("redemptions") or []), 1)

    def test_public_room_vanity_and_unlimited_invite_still_work(self):
        owner = self._session("pub_owner_f")
        r = self.client.post(
            "/api/rooms",
            json={"name": "pub-f", "type": "public"},
            headers=self._hdr(owner),
        )
        self.assertEqual(r.status_code, 200, r.text)

        v = self.client.put(
            "/api/invites/channels/pub-f/vanity",
            json={"vanity": "pubftest"},
            headers=self._hdr(owner),
        )
        self.assertEqual(v.status_code, 200, v.text)

        inv = self.client.post(
            "/api/invites/channels/pub-f",
            json={"max_uses": 0},
            headers=self._hdr(owner),
        )
        self.assertEqual(inv.status_code, 200, inv.text)

    def test_owner_can_rejoin_via_own_one_shot_without_burning_uses(self):
        owner = self._session("priv_owner_h")
        joiner = self._session("priv_joiner_h")
        self._create_private_room(owner, "priv-h")

        cr = self.client.post(
            "/api/invites/channels/priv-h",
            json={"max_uses": 1, "expires_hours": 168},
            headers=self._hdr(owner),
        )
        code = cr.json()["code"]

        j1 = self.client.post(f"/api/invites/{code}/join", headers=self._hdr(joiner))
        self.assertEqual(j1.status_code, 200, j1.text)

        j_owner = self.client.post(f"/api/invites/{code}/join", headers=self._hdr(owner))
        self.assertEqual(j_owner.status_code, 200, j_owner.text)
        self.assertEqual(j_owner.json().get("room_type"), "private")

        lst = self.client.get("/api/invites/channels/priv-h", headers=self._hdr(owner))
        inv = lst.json()["invites"][0]
        self.assertEqual(inv["use_count"], 1)

    def test_invite_join_case_insensitive(self):
        owner = self._session("priv_owner_i")
        self._create_private_room(owner, "priv-i")
        cr = self.client.post(
            "/api/invites/channels/priv-i",
            json={"max_uses": 5},
            headers=self._hdr(owner),
        )
        code = cr.json()["code"]
        upper = code.upper()
        joiner = self._session("priv_joiner_i")
        j = self.client.post(f"/api/invites/{upper}/join", headers=self._hdr(joiner))
        self.assertEqual(j.status_code, 200, j.text)

    def test_patch_private_coerces_everyone_to_mods(self):
        owner = self._session("priv_owner_g")
        self._create_private_room(owner, "priv-g")
        r = self.client.patch(
            "/api/rooms/priv-g",
            json={"who_can_invite": "everyone"},
            headers=self._hdr(owner),
        )
        self.assertEqual(r.status_code, 200, r.text)
        room = self.db.get_room_by_name("priv-g")
        self.assertEqual(room.get("who_can_invite"), "mods")


if __name__ == "__main__":
    unittest.main()
