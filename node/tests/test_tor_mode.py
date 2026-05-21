import os
import unittest
from unittest import mock

from routers import auth, federation, server_admin


class TorModeTests(unittest.TestCase):
    def test_public_server_view_keeps_clearnet_outside_tor_mode(self):
        server = {
            "server_id": "srv_test",
            "base_url": "https://example.com",
            "onion_url": "http://examplehiddenservice.onion",
            "transport_preference": "auto",
        }
        view = federation._public_server_view(server)
        self.assertEqual(view["base_url"], "https://example.com")
        self.assertEqual(view["onion_url"], "http://examplehiddenservice.onion")

    def test_public_server_view_hides_clearnet_for_onion_only_peer(self):
        server = {
            "server_id": "srv_test",
            "base_url": "https://example.com",
            "onion_url": "http://examplehiddenservice.onion",
            "transport_preference": "onion",
        }
        view = federation._public_server_view(server)
        self.assertEqual(view["base_url"], "")
        self.assertEqual(view["onion_url"], "http://examplehiddenservice.onion")

    def test_coerce_server_row_accepts_onion_only_payload(self):
        row = federation._coerce_server_row({
            "server_id": "srv_test",
            "display_name": "Test",
            "base_url": "",
            "onion_url": "http://examplehiddenservice.onion",
            "capabilities": ["federation-v1"],
        })
        self.assertIsNotNone(row)
        self.assertEqual(row["base_url"], "")
        self.assertEqual(row["onion_url"], "http://examplehiddenservice.onion")

    @mock.patch.dict(os.environ, {"FROGTALK_TOR_ENABLED": "1"}, clear=False)
    @mock.patch("database.get_federation_server_transport", return_value="auto")
    def test_admin_node_view_prefers_tor_safe_endpoint(self, _transport_mock):
        view = server_admin._admin_node_view({
            "server_id": "srv_test",
            "display_name": "Test",
            "base_url": "http://31.220.92.120",
            "onion_url": "http://examplehiddenserviceabcdefghijklmnop.onion",
            "trust_tier": "community",
            "enabled": 1,
            "official": 0,
            "capabilities": [],
        })
        self.assertEqual(view["route_mode"], "tor")
        self.assertTrue(view["onion_available"])
        self.assertIn("onion", view["display_endpoint"])
        self.assertEqual(view["privacy_label"], "IP hidden")

    def test_admin_node_view_redacts_clearnet_ip(self):
        view = server_admin._admin_node_view({
            "server_id": "srv_test",
            "display_name": "Test",
            "base_url": "http://31.220.92.120",
            "onion_url": "",
            "trust_tier": "community",
            "enabled": 1,
            "official": 0,
            "capabilities": [],
        })
        self.assertEqual(view["route_mode"], "clearnet")
        self.assertEqual(view["display_endpoint"], "31.220.*.*")
        self.assertEqual(view["privacy_label"], "Clearnet address redacted")

    def test_easter_egg_sanitizer_removes_script_and_handlers(self):
        raw = '<div onclick="alert(1)">ok</div><script>alert(2)</script><a href="javascript:alert(3)">x</a>'
        cleaned = server_admin._sanitize_easter_html(raw)
        self.assertNotIn('script', cleaned.lower())
        self.assertNotIn('onclick', cleaned.lower())
        self.assertNotIn('javascript:', cleaned.lower())
        self.assertIn('<div', cleaned)

    def test_easter_egg_sanitizer_keeps_video_markup(self):
        raw = '<p>Hello</p><video controls src="data:video/mp4;base64,AAAA"></video>'
        cleaned = server_admin._sanitize_easter_html(raw)
        self.assertIn('<video', cleaned)
        self.assertIn('data:video/mp4', cleaned)

    @mock.patch.dict(os.environ, {"FROGTALK_TOR_ENABLED": "1"}, clear=False)
    def test_auth_peer_target_prefers_onion_in_tor_mode(self):
        row = {
            "base_url": "https://example.com",
            "onion_url": "http://examplehiddenservice.onion",
            "transport_preference": "auto",
        }
        self.assertEqual(auth._peer_target(row), "http://examplehiddenservice.onion")

    @mock.patch.dict(os.environ, {"FROGTALK_TOR_ENABLED": "0"}, clear=False)
    def test_auth_peer_target_prefers_clearnet_outside_tor_mode(self):
        row = {
            "base_url": "https://example.com",
            "onion_url": "http://examplehiddenservice.onion",
            "transport_preference": "auto",
        }
        self.assertEqual(auth._peer_target(row), "https://example.com")


if __name__ == "__main__":
    unittest.main()