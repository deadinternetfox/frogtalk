"""Regression: privacy settings persist after PATCH /api/auth/profile."""
import hashlib
import hmac
import os
import tempfile
import unittest


def _csrf_for(token: str) -> str:
    secret = os.environ["FROGTALK_CSRF_SECRET"].encode()
    return hmac.new(secret, token.encode(), hashlib.sha256).hexdigest()


class ProfileSettingsPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = os.path.join(cls._tmpdir.name, "test.db")
        os.environ["FROGTALK_CSRF_SECRET"] = "test-csrf-secret-for-profile-settings"
        os.environ["ADMIN_PASSWORD"] = "test-admin-pass"
        from fastapi.testclient import TestClient
        import importlib
        import database as db_mod
        import main

        importlib.reload(db_mod)
        db_mod.init_db()
        importlib.reload(main)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        cls._tmpdir.cleanup()

    def _register_and_login(self, nick: str, password: str = "secret12"):
        import database as db

        uid = db.create_user(nick, password)
        self.assertIsNotNone(uid)
        return db.create_session(uid)

    def test_profile_patch_invalidates_cookie_auth_cache(self):
        import database as db
        from deps import _token_cache_put, _token_cache_get, invalidate_request_session_cache

        nick = "privacy_user_a"
        token = self._register_and_login(nick)
        db._conn().execute(
            "UPDATE users SET allow_dms_from='nobody' WHERE nickname=?",
            (nick,),
        )
        db._conn().commit()

        user = db.get_user_by_token(token)
        self.assertEqual(user.get("allow_dms_from"), "nobody")
        _token_cache_put(token, dict(user))
        self.assertEqual(_token_cache_get(token).get("allow_dms_from"), "nobody")

        r = self.client.patch(
            "/api/auth/profile",
            json={"allow_dms_from": "friends"},
            cookies={"ft_session": token},
            headers={"X-CSRF-Token": _csrf_for(token)},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json().get("allow_dms_from"), "friends")

        cached = _token_cache_get(token)
        self.assertIsNone(cached, "cache should be cleared after profile save")

        me = self.client.get("/api/auth/me", cookies={"ft_session": token})
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json().get("allow_dms_from"), "friends")

    def test_delete_account_with_cookie_session(self):
        import database as db

        nick = "delete_me_user"
        token = self._register_and_login(nick, "deletepass1")
        r = self.client.request(
            "DELETE",
            "/api/auth/account",
            json={"password": "deletepass1"},
            cookies={"ft_session": token},
            headers={"X-CSRF-Token": _csrf_for(token)},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json().get("ok"))
        self.assertIsNone(db.get_user_by_token(token))


if __name__ == "__main__":
    unittest.main()
