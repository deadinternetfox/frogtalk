import os
import unittest
from unittest import mock

import federation_mesh


class FederationMeshTests(unittest.TestCase):
    def tearDown(self):
        federation_mesh._MESH_CACHE = None

    def test_empty_mesh_without_env(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            federation_mesh.load_mesh_config(reload=True)
        self.assertEqual(federation_mesh.ensure_peers(), [])
        self.assertFalse(federation_mesh.is_directory_hub())

    def test_directory_hub_from_hosts(self):
        cfg = {
            "directory_hub_hosts": ["hub.example.com"],
            "ensure_peers": [],
        }
        with mock.patch.dict(
            os.environ,
            {"FROGTALK_FEDERATION_MESH_JSON": __import__("json").dumps(cfg)},
            clear=False,
        ):
            federation_mesh.load_mesh_config(reload=True)
        with mock.patch.dict(os.environ, {"PUBLIC_URL": "https://hub.example.com"}, clear=False):
            self.assertTrue(federation_mesh.is_directory_hub())

    def test_tor_mirror_ids_from_ensure_peers(self):
        cfg = {
            "ensure_peers": [
                {
                    "server_id": "srv_tor",
                    "onion_url": "http://abcdef.onion",
                    "base_url": "",
                    "transport_preference": "onion",
                }
            ]
        }
        with mock.patch.dict(
            os.environ,
            {"FROGTALK_FEDERATION_MESH_JSON": __import__("json").dumps(cfg)},
            clear=False,
        ):
            federation_mesh.load_mesh_config(reload=True)
        self.assertEqual(federation_mesh.tor_mirror_server_ids(), {"srv_tor"})


if __name__ == "__main__":
    unittest.main()
