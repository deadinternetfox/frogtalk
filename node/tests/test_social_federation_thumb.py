"""Federated wall post thumbnails on travel nodes.

Covers ``_lookup_federation_post_map`` and the home-node fallback inside
``_resolve_federated_post_media`` when local mirror bytes are missing.
"""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class SocialFederationThumbTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        os.environ["DB_PATH"] = os.path.join(cls._tmpdir.name, "social_fed_thumb.db")
        os.environ["FROGTALK_CSRF_SECRET"] = "test-csrf-social-fed-thumb"
        os.environ["ADMIN_PASSWORD"] = "test-admin-pass"
        os.environ["FROGTALK_DATA_DIR"] = os.path.join(cls._tmpdir.name, "data")
        import database as db_mod

        importlib.reload(db_mod)
        db_mod.init_db()
        cls.db = db_mod

        import routers.social as social_mod

        importlib.reload(social_mod)
        cls.social = social_mod

    @classmethod
    def tearDownClass(cls):
        cls._tmpdir.cleanup()

    def test_lookup_federation_post_map_invalid_id(self):
        self.assertEqual(self.social._lookup_federation_post_map(0), ("", ""))
        self.assertEqual(self.social._lookup_federation_post_map(-3), ("", ""))

    def test_lookup_federation_post_map_from_db(self):
        db = self.db
        self.assertTrue(
            db.map_federation_wall_object(
                "srv_home",
                "post",
                "gid-post-42",
                42,
            )
        )
        self.assertEqual(
            self.social._lookup_federation_post_map(42),
            ("srv_home", "gid-post-42"),
        )

    def test_lookup_federation_post_map_missing_row(self):
        self.assertEqual(self.social._lookup_federation_post_map(99999), ("", ""))

    def test_resolve_media_uses_home_when_local_missing(self):
        with mock.patch(
            "routers.social._fetch_home_federated_post_media",
            return_value=("ok", b"jpeg-bytes", "image/jpeg"),
        ) as fetch_home, mock.patch(
            "routers.social._wall_post_media_bytes_for_viewer",
            return_value=("not_found", None, ""),
        ) as local_bytes:
            st, raw, ct = self.social._resolve_federated_post_media(
                "srv_home",
                "gid-post-1",
                101,
                viewer_id=7,
                viewer_gid="viewer-gid",
                media_kind="media",
            )
        self.assertEqual(st, "ok")
        self.assertEqual(raw, b"jpeg-bytes")
        self.assertEqual(ct, "image/jpeg")
        local_bytes.assert_called_once_with(101, 7)
        fetch_home.assert_called_once_with(
            "srv_home", "gid-post-1", "viewer-gid", kind="media",
        )

    @mock.patch("routers.social._generate_thumb_sync", return_value=False)
    def test_resolve_thumb_falls_back_to_home(self, _mock_gen):
        home_payload = b"home-thumb-jpg"
        with mock.patch(
            "routers.social._fetch_home_federated_post_media",
            return_value=("ok", home_payload, "image/jpeg"),
        ) as fetch_home, mock.patch(
            "routers.social._wall_post_media_bytes_for_viewer",
            return_value=("not_found", None, ""),
        ) as local_bytes, mock.patch(
            "routers.social._thumb_path",
            side_effect=lambda lid: __import__("pathlib").Path(
                os.environ["FROGTALK_DATA_DIR"], "thumbs", f"{lid}.jpg",
            ),
        ):
            st, raw, ct = self.social._resolve_federated_post_media(
                "srv_home",
                "gid-post-2",
                202,
                viewer_id=8,
                viewer_gid="viewer-gid-2",
                media_kind="thumb",
            )
        self.assertEqual(st, "ok")
        self.assertEqual(raw, home_payload)
        self.assertEqual(ct, "image/jpeg")
        local_bytes.assert_called_once_with(202, 8)
        fetch_home.assert_called_once_with(
            "srv_home", "gid-post-2", "viewer-gid-2", kind="thumb",
        )
        cached = os.path.join(os.environ["FROGTALK_DATA_DIR"], "thumbs", "202.jpg")
        self.assertTrue(os.path.isfile(cached))
        with open(cached, "rb") as fh:
            self.assertEqual(fh.read(), home_payload)

    def test_resolve_forbidden_skips_home_fetch(self):
        with mock.patch(
            "routers.social._fetch_home_federated_post_media",
        ) as fetch_home, mock.patch(
            "routers.social._wall_post_media_bytes_for_viewer",
            return_value=("forbidden", None, ""),
        ) as local_bytes:
            st, raw, ct = self.social._resolve_federated_post_media(
                "srv_home",
                "gid-post-3",
                303,
                viewer_id=9,
                viewer_gid="viewer-gid-3",
                media_kind="media",
            )
        self.assertEqual(st, "forbidden")
        self.assertIsNone(raw)
        self.assertEqual(ct, "")
        local_bytes.assert_called_once_with(303, 9)
        fetch_home.assert_not_called()


if __name__ == "__main__":
    unittest.main()
