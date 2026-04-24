import os
import unittest
from unittest import mock

from routers import auth, federation


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