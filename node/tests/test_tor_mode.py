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

    def test_tor_mirror_listing_hides_clearnet_ip(self):
        server = {
            "server_id": "srv_tor_mirror",
            "display_name": "FrogTalk Tor Mirror",
            "base_url": "http://203.0.113.30",
            "onion_url": "http://icn3a43nb6byhdmon4rqzeqswkskk2bnvf54l6at3iskmqlture3blqd.onion",
            "official": 1,
            "transport_preference": "auto",
        }
        view = federation._public_server_view_for_client(server)
        self.assertTrue(view.get("tor_listing"))
        self.assertEqual(view["base_url"], "")
        self.assertIn(".onion", view["onion_url"])

    def _sample_network_servers(self):
        return [
            federation._public_server_view_for_client({
                "server_id": "srv_clearnet",
                "display_name": "FrogTalk AU",
                "base_url": "https://au.example.com",
                "onion_url": "",
            }),
            federation._public_server_view_for_client({
                "server_id": "srv_main",
                "display_name": "FrogTalk Main",
                "base_url": "https://frogtalk.xyz",
                "onion_url": "",
                "official": 1,
            }),
            federation._public_server_view_for_client({
                "server_id": "srv_tor_mirror",
                "display_name": "FrogTalk Tor Mirror",
                "base_url": "http://203.0.113.30",
                "onion_url": "http://mirror.onion",
                "official": 1,
            }),
        ]

    @mock.patch("routers.federation._hybrid_node_enabled", return_value=False)
    @mock.patch("routers.federation._tor_mode_enabled", return_value=False)
    def test_network_picker_clearnet_only_sees_clearnet(self, _tor, _hybrid):
        filtered = federation._filter_network_picker_servers(self._sample_network_servers())
        ids = {s["server_id"] for s in filtered}
        self.assertEqual(ids, {"srv_clearnet", "srv_main"})

    @mock.patch("routers.federation._hybrid_node_enabled", return_value=True)
    @mock.patch("routers.federation._tor_mode_enabled", return_value=False)
    def test_network_picker_hybrid_sees_all(self, _tor, _hybrid):
        filtered = federation._filter_network_picker_servers(self._sample_network_servers())
        self.assertEqual(len(filtered), 3)

    @mock.patch("routers.federation._hybrid_node_enabled", return_value=False)
    @mock.patch("routers.federation._tor_mode_enabled", return_value=True)
    def test_network_picker_tor_sees_tor_and_hybrid(self, _tor, _hybrid):
        filtered = federation._filter_network_picker_servers(self._sample_network_servers())
        ids = {s["server_id"] for s in filtered}
        self.assertEqual(ids, {"srv_main", "srv_tor_mirror"})

    @mock.patch("routers.federation._hybrid_node_enabled", return_value=False)
    @mock.patch("routers.federation._tor_mode_enabled", return_value=False)
    def test_federation_policy_ui_clearnet_hides_tor_block(self, _tor, _hybrid):
        ui = federation.federation_policy_admin_ui()
        self.assertEqual(ui["network_viewer_mode"], "clearnet")
        self.assertFalse(ui["show_block_tor_peers"])
        self.assertTrue(ui["show_block_http_only_peers"])

    @mock.patch("routers.federation._hybrid_node_enabled", return_value=True)
    @mock.patch("routers.federation._tor_mode_enabled", return_value=False)
    def test_federation_policy_ui_hybrid_shows_tor_block(self, _tor, _hybrid):
        ui = federation.federation_policy_admin_ui()
        self.assertEqual(ui["network_viewer_mode"], "hybrid")
        self.assertTrue(ui["show_block_tor_peers"])

    @mock.patch("federation_mesh.is_directory_hub", return_value=True)
    @mock.patch("routers.federation._tor_mode_enabled", return_value=False)
    def test_directory_hub_enables_hybrid(self, _tor, _hub):
        self.assertTrue(federation._is_official_main_hub())
        self.assertTrue(federation._hybrid_node_enabled())

    @mock.patch("federation_mesh.clearnet_repairs", return_value=[])
    @mock.patch("federation_mesh.ensure_peers", return_value=[
        {
            "server_id": "srv_tor_mirror",
            "display_name": "Tor Mirror",
            "base_url": "",
            "onion_url": "http://examplehiddenservice.onion",
            "region": "Tor Hidden Service",
            "capabilities": ["federation-v1"],
            "transport_preference": "onion",
        },
    ])
    @mock.patch("federation_mesh.is_directory_hub", return_value=True)
    @mock.patch("database.get_federation_server_row", return_value=None)
    @mock.patch("database.upsert_federation_server")
    def test_ensure_official_mesh_peers_seeds_from_config(self, upsert, _row, _peers, _repairs, _hub):
        n = federation.ensure_official_mesh_peers()
        self.assertEqual(n, 1)
        upsert.assert_called_once()
        self.assertEqual(upsert.call_args.kwargs["server_id"], "srv_tor_mirror")
        self.assertIn(".onion", upsert.call_args.kwargs["onion_url"])

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

    @mock.patch("routers.server_admin.federation_router._tor_mode_enabled", return_value=True)
    @mock.patch.dict(os.environ, {"FROGTALK_TOR_ENABLED": "1"}, clear=False)
    @mock.patch("database.get_federation_server_transport", return_value="auto")
    def test_admin_node_view_prefers_tor_safe_endpoint(self, _transport_mock, _tor_mock):
        view = server_admin._admin_node_view({
            "server_id": "srv_test",
            "display_name": "Test",
            "base_url": "http://203.0.113.10",
            "onion_url": "http://examplehiddenserviceabcdefghijklmnop.onion",
            "transport_preference": "onion",
            "trust_tier": "community",
            "enabled": 1,
            "official": 0,
            "capabilities": [],
        })
        self.assertEqual(view["route_mode"], "tor")
        self.assertTrue(view["onion_available"])
        self.assertIn("onion", view["display_endpoint"])
        self.assertEqual(view["privacy_label"], "IP hidden (Tor)")

    @mock.patch("database.get_federation_policy_settings", return_value={"block_tor_peers": False, "block_http_only_peers": False, "redact_clearnet_ips": True})
    def test_admin_node_view_redacts_clearnet_ip(self, _policy_mock):
        view = server_admin._admin_node_view({
            "server_id": "srv_test",
            "display_name": "Test",
            "base_url": "http://203.0.113.10",
            "onion_url": "",
            "trust_tier": "community",
            "enabled": 1,
            "official": 0,
            "capabilities": [],
        })
        self.assertEqual(view["route_mode"], "clearnet")
        self.assertEqual(view["display_endpoint"], "203.0.*.*")
        self.assertEqual(view["privacy_label"], "Clearnet address redacted")

    @mock.patch("database.get_federation_policy_settings", return_value={"block_tor_peers": False, "block_http_only_peers": False, "redact_clearnet_ips": False})
    def test_admin_node_view_shows_clearnet_ip_when_redact_off(self, _policy_mock):
        view = server_admin._admin_node_view({
            "server_id": "srv_test",
            "display_name": "Test",
            "base_url": "http://203.0.113.10",
            "onion_url": "",
            "trust_tier": "community",
            "enabled": 1,
            "official": 0,
            "capabilities": [],
        })
        self.assertEqual(view["display_endpoint"], "203.0.113.10")
        self.assertEqual(view["privacy_label"], "Public host")

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

    def test_peer_uses_http_only_clearnet(self):
        self.assertTrue(federation.peer_uses_http_only_clearnet({"base_url": "http://203.0.113.10"}))
        self.assertFalse(federation.peer_uses_http_only_clearnet({"base_url": "https://frogtalk.xyz"}))
        self.assertFalse(federation.peer_uses_http_only_clearnet({"base_url": "http://abcdefghijklmnop.onion"}))

    @mock.patch("database.get_federation_policy_settings", return_value={"block_tor_peers": False, "block_http_only_peers": False, "redact_clearnet_ips": False})
    def test_admin_node_view_flags_http_only_tls(self, _policy_mock):
        view = server_admin._admin_node_view({
            "server_id": "srv_http",
            "display_name": "HTTP Node",
            "base_url": "http://10.0.0.5",
            "onion_url": "",
            "trust_tier": "community",
            "enabled": 1,
            "official": 0,
            "capabilities": [],
        })
        self.assertTrue(view["tls_insecure"])
        self.assertFalse(view["tls_secure"])

    def test_federation_policy_redact_defaults_off(self):
        with mock.patch("database.get_config", return_value=None):
            pol = __import__("database").get_federation_policy_settings()
        self.assertFalse(pol["redact_clearnet_ips"])

    @mock.patch("routers.federation._hybrid_node_enabled", return_value=True)
    @mock.patch("routers.federation._tor_mode_enabled", return_value=False)
    def test_resolve_server_base_url_hybrid_uses_onion_for_tor_mirror(self, _tor, _hybrid):
        onion = "http://examplehiddenservice.onion"
        tor_row = {
            "server_id": "srv_tor_mirror",
            "base_url": "",
            "onion_url": onion,
            "transport_preference": "onion",
            "enabled": 1,
        }
        with mock.patch("database.get_federation_server_row", return_value=tor_row):
            url = auth.resolve_server_base_url("srv_tor_mirror")
        self.assertEqual(url, onion.rstrip("/"))

    @mock.patch("federation_calls.db.list_federation_servers", return_value=[
        {
            "server_id": "srv_tor_mirror",
            "base_url": "",
            "onion_url": "http://examplehiddenservice.onion",
            "transport_preference": "onion",
            "enabled": 1,
        },
        {
            "server_id": "srv_clearnet",
            "base_url": "https://au.example.com",
            "onion_url": "",
            "enabled": 1,
        },
    ])
    @mock.patch("federation_calls.db.get_or_create_local_server_identity", return_value={"server_id": "srv_main"})
    @mock.patch("federation_calls.federation_peer_is_local_alias", return_value=False)
    @mock.patch("routers.federation._hybrid_node_enabled", return_value=True)
    @mock.patch("routers.federation._tor_mode_enabled", return_value=False)
    def test_hybrid_federation_peer_ids_include_tor_mirror(
        self, _tor, _hybrid, _alias, _local, _peers,
    ):
        import federation_calls as fc

        ids = set(fc._clearnet_federation_peer_ids())
        self.assertIn("srv_tor_mirror", ids)
        self.assertIn("srv_clearnet", ids)

    @mock.patch("federation_mesh.tor_mirror_server_ids", return_value={"srv_tor_mirror"})
    @mock.patch("federation_calls.db.list_federation_servers", return_value=[
        {
            "server_id": "srv_tor_mirror",
            "base_url": "",
            "onion_url": "http://examplehiddenservice.onion",
            "transport_preference": "onion",
            "enabled": 1,
        },
    ])
    @mock.patch("federation_calls.db.get_or_create_local_server_identity", return_value={"server_id": "srv_main"})
    @mock.patch("federation_calls.federation_peer_is_local_alias", return_value=False)
    @mock.patch("routers.federation._hybrid_node_enabled", return_value=False)
    @mock.patch("routers.federation._tor_mode_enabled", return_value=False)
    def test_clearnet_only_federation_peer_ids_skip_tor_mirror(
        self, _tor, _hybrid, _alias, _local, _peers, _tor_ids,
    ):
        import federation_calls as fc

        self.assertNotIn("srv_tor_mirror", fc._clearnet_federation_peer_ids())


if __name__ == "__main__":
    unittest.main()