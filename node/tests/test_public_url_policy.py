"""Tests for configurable public site URL resolution."""
import os
import unittest
from unittest import mock

import database as db
from public_url_policy import (
    OFFICIAL_HUB_URL_DEFAULT,
    LEGACY_OFFICIAL_HUB_URL,
    SITE_PUBLIC_URL_CONFIG_KEY,
    normalize_public_url,
    public_invite_url,
    resolve_public_site_url,
    is_known_frog_host,
    substitute_site_url_in_text,
)


class PublicUrlPolicyTests(unittest.TestCase):
    def setUp(self):
        self._env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)

    def test_normalize_public_url_strips_path(self):
        self.assertEqual(normalize_public_url("https://Chat.Example.com/app/"), "https://chat.example.com")

    def test_resolve_prefers_db_config(self):
        with mock.patch.object(db, "get_config", return_value="https://node.example.com"):
            with mock.patch.object(db, "get_or_create_local_server_identity", return_value={"base_url": ""}):
                self.assertEqual(resolve_public_site_url(), "https://node.example.com")

    def test_resolve_falls_back_to_public_url_env(self):
        with mock.patch.object(db, "get_config", return_value=None):
            with mock.patch.object(db, "get_or_create_local_server_identity", return_value={"base_url": ""}):
                os.environ["PUBLIC_URL"] = "https://env.example.com"
                self.assertEqual(resolve_public_site_url(), "https://env.example.com")

    def test_public_invite_url_uses_resolver(self):
        with mock.patch("public_url_policy.resolve_public_site_url", return_value="https://chat.example.com"):
            self.assertEqual(public_invite_url("abc123"), "https://chat.example.com/i/abc123")

    def test_is_known_frog_host_includes_configured_host(self):
        with mock.patch("public_url_policy.resolve_public_site_host", return_value="chat.example.com"):
            self.assertTrue(is_known_frog_host("chat.example.com"))
            self.assertFalse(is_known_frog_host("evil.example.com"))

    def test_substitute_replaces_legacy_xyz_and_app(self):
        with mock.patch("public_url_policy.resolve_public_site_url", return_value="https://mine.test"):
            out = substitute_site_url_in_text(
                "See https://frogtalk.xyz/docs and https://frogtalk.app/app"
            )
            self.assertIn("https://mine.test/docs", out)
            self.assertIn("https://mine.test/app", out)
            self.assertNotIn("frogtalk.xyz", out)
            self.assertNotIn("frogtalk.app", out)

    def test_default_official_hub(self):
        with mock.patch.object(db, "get_config", return_value=None):
            with mock.patch.object(db, "get_or_create_local_server_identity", return_value={"base_url": ""}):
                for key in ("PUBLIC_URL", "FROGTALK_SITE_URL", "FROGTALK_BASE_URL", "SITE_URL"):
                    os.environ.pop(key, None)
                self.assertEqual(resolve_public_site_url(), OFFICIAL_HUB_URL_DEFAULT)


if __name__ == "__main__":
    unittest.main()
