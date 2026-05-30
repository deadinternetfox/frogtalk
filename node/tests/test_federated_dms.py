"""Federated DM outbox routing."""
import unittest
from unittest import mock

import federation_dms as fd
import database as db


class FederatedDMsTests(unittest.TestCase):
    @mock.patch("federation_dms.dm_message_federation_targets", return_value=[])
    @mock.patch("federation_dms._party_homed_elsewhere", return_value=False)
    @mock.patch("federation_dms.fc.callee_session_on_local_node", return_value=True)
    @mock.patch("federation_dms._peer_connected_on_remote_node", return_value=False)
    def test_should_not_federate_same_home_peer_online(self, _remote, _local, _targets, _home):
        sender = {"global_user_id": "00000000-0000-4000-8000-000000000001"}
        peer = {"id": 2, "global_user_id": "00000000-0000-4000-8000-000000000002"}
        self.assertFalse(fd.should_federate_dm(sender, peer))

    @mock.patch("federation_dms._party_homed_elsewhere", return_value=False)
    @mock.patch("federation_dms.fc.callee_session_on_local_node", return_value=False)
    @mock.patch("federation_dms._peer_connected_on_remote_node", return_value=False)
    def test_should_federate_when_peer_not_local(self, _remote, _local, _home):
        sender = {"global_user_id": "00000000-0000-4000-8000-000000000001"}
        peer = {"id": 2, "global_user_id": "00000000-0000-4000-8000-000000000002"}
        self.assertTrue(fd.should_federate_dm(sender, peer))

    @mock.patch("federation_dms._party_homed_elsewhere", return_value=False)
    @mock.patch("federation_dms.fc.callee_session_on_local_node", return_value=False)
    @mock.patch("federation_dms._peer_connected_on_remote_node", return_value=False)
    def test_should_federate_without_global_ids_when_peer_off_node(self, _remote, _local, _home):
        """Travel sessions without global_user_id must still replicate DMs."""
        sender = {"id": 1, "nickname": "alice"}
        peer = {"id": 2, "nickname": "bob"}
        self.assertTrue(fd.should_federate_dm(sender, peer))

    @mock.patch("federation_dms._party_homed_elsewhere", return_value=True)
    @mock.patch("federation_dms.fc.callee_session_on_local_node", return_value=True)
    @mock.patch("federation_dms._peer_connected_on_remote_node", return_value=False)
    def test_should_federate_travel_peer_with_stale_local_ws(self, _remote, _local, _home):
        """Homed-elsewhere + local WS (background tab) must still federate."""
        sender = {"global_user_id": "00000000-0000-4000-8000-000000000001"}
        peer = {"id": 2, "global_user_id": "00000000-0000-4000-8000-000000000002"}
        self.assertTrue(fd.should_federate_dm(sender, peer))

    @mock.patch("federation_dms._party_homed_elsewhere", return_value=False)
    @mock.patch("federation_dms.fc.callee_session_on_local_node", return_value=True)
    @mock.patch("federation_dms._peer_connected_on_remote_node", return_value=True)
    def test_should_federate_when_peer_connected_on_travel_node(self, _remote, _local, _home):
        sender = {"global_user_id": "00000000-0000-4000-8000-000000000001"}
        peer = {"id": 2, "global_user_id": "00000000-0000-4000-8000-000000000002"}
        self.assertTrue(fd.should_federate_dm(sender, peer))

    def test_dm_parties_need_global_ids(self):
        self.assertTrue(fd.dm_parties_have_global_ids(
            {"global_user_id": "a"},
            {"global_user_id": "b"},
        ))
        self.assertFalse(fd.dm_parties_have_global_ids(
            {"global_user_id": "a"},
            {"global_user_id": ""},
        ))

    @mock.patch("federation_dms.fc._clearnet_federation_peer_ids", return_value=["srv_au"])
    @mock.patch("federation_dms._party_homed_elsewhere", return_value=False)
    @mock.patch("federation_dms.fc.callee_session_on_local_node", return_value=True)
    @mock.patch("federation_dms._peer_connected_on_remote_node", return_value=False)
    @mock.patch("federation_dms.db.resolve_federation_push_targets_for_recipient_gids", return_value=[])
    @mock.patch("federation_dms.db.get_or_create_local_server_identity", return_value={"server_id": "srv_home"})
    def test_dm_targets_mirror_clearnet_when_stale_local_ws(self, _ident, _push, _remote, _local, _home, _clearnet):
        """Federated peer online here with a stale tab must still fan out to travel nodes."""
        peer = {"id": 2, "global_user_id": "00000000-0000-4000-8000-000000000002"}
        targets = fd.dm_message_target_servers(peer)
        self.assertIn("srv_au", targets)
        self.assertTrue(fd.should_federate_dm(
            {"global_user_id": "00000000-0000-4000-8000-000000000001"},
            peer,
        ))

    @mock.patch("federation_dms.fc._clearnet_federation_peer_ids", return_value=["srv_au"])
    @mock.patch("federation_dms._party_homed_elsewhere", return_value=False)
    @mock.patch("federation_dms.fc.callee_session_on_local_node", return_value=True)
    @mock.patch("federation_dms._peer_connected_on_remote_node", return_value=False)
    @mock.patch("federation_dms.db.resolve_federation_push_targets_for_recipient_gids", return_value=[])
    @mock.patch("federation_dms.db.get_or_create_local_server_identity", return_value={"server_id": "srv_home"})
    def test_federation_targets_union_sender_clearnet(self, _ident, _push, _remote, _local, _home, _clearnet):
        """testys on home → Frog on AU: sender online locally still fans out via union."""
        sender = {"id": 1, "global_user_id": "00000000-0000-4000-8000-000000000001"}
        peer = {"id": 2, "nickname": "Frog"}
        targets = fd.dm_message_federation_targets(sender, peer)
        self.assertIn("srv_au", targets)
        self.assertTrue(fd.should_federate_dm(sender, peer))

    @mock.patch("federation_dms._party_homed_elsewhere", return_value=True)
    @mock.patch("federation_dms.fc._clearnet_federation_peer_ids", return_value=["srv_au", "srv_eu"])
    @mock.patch("federation_dms.fc.callee_session_on_local_node", return_value=True)
    @mock.patch("federation_dms._peer_connected_on_remote_node", return_value=False)
    @mock.patch("federation_dms.db.get_user_account_home_server_id", return_value="srv_home")
    @mock.patch("federation_dms.db.resolve_federation_push_targets_for_recipient_gids", return_value=["srv_home"])
    @mock.patch("federation_dms.db.get_or_create_local_server_identity", return_value={"server_id": "srv_home"})
    def test_dm_targets_include_clearnet_when_homed_elsewhere(
        self, _ident, _push, _acct, _remote, _local, _clearnet, _home,
    ):
        peer = {"id": 2, "global_user_id": "00000000-0000-4000-8000-000000000002"}
        targets = fd.dm_message_target_servers(peer)
        self.assertIn("srv_home", targets)
        self.assertIn("srv_au", targets)

    @mock.patch("federation_dms.fc._clearnet_federation_peer_ids", return_value=["srv_au"])
    @mock.patch("federation_dms.fc.callee_session_on_local_node", return_value=False)
    @mock.patch("federation_dms._peer_connected_on_remote_node", return_value=False)
    @mock.patch("federation_dms.db.resolve_federation_push_targets_for_recipient_gids", return_value=[])
    @mock.patch("federation_dms.db.get_or_create_local_server_identity", return_value={"server_id": "srv_home"})
    def test_dm_targets_fallback_clearnet_when_offline(self, _ident, _push, _remote, _local, _clearnet):
        peer = {"global_user_id": "00000000-0000-4000-8000-000000000002"}
        self.assertEqual(fd.dm_message_target_servers(peer), ["srv_au"])

    @mock.patch("federation_dms.fc._clearnet_federation_peer_ids", return_value=["srv_home", "srv_eu"])
    @mock.patch("federation_dms.db.get_federation_profile_origin", return_value="")
    @mock.patch("federation_dms.db.resolve_global_user_home_server_id", return_value="srv_home")
    @mock.patch("federation_dms.db.resolve_federation_push_targets_for_recipient_gids", return_value=[])
    @mock.patch("federation_dms.db.get_user_account_home_server_id", return_value="srv_home")
    @mock.patch("federation_dms.db.get_or_create_local_server_identity", return_value={"server_id": "srv_au"})
    def test_remote_targets_travel_sender_reaches_peer_home(
        self, _ident, _acct, _push, _home, _origin, _clearnet,
    ):
        """Frog@AU → testy@home must enqueue to srv_home even if AU thinks peer is local."""
        sender = {"id": 1, "global_user_id": "00000000-0000-4000-8000-000000000001"}
        peer = {"id": 2, "global_user_id": "00000000-0000-4000-8000-000000000002"}
        remote = fd.dm_message_federation_remote_targets(sender, peer)
        self.assertIn("srv_home", remote)
        self.assertNotIn("srv_au", remote)
        self.assertTrue(fd.user_session_on_travel_node(sender))

    def test_effective_last_seen_prefers_newest(self):
        gid = "00000000-0000-4000-8000-000000009901"
        with mock.patch.object(db, "get_federation_user_profile_row", return_value={
            "last_seen": "2026-05-24 10:00:00",
        }), mock.patch.object(db, "get_federation_user_activity_last_seen", return_value=""), \
             mock.patch.object(db, "_conn") as mock_conn:
            mock_conn.return_value.__enter__.return_value.execute.return_value.fetchone.return_value = {
                "last_seen": "2026-05-23 10:00:00",
                "global_user_id": gid,
            }
            out = db.get_effective_last_seen(7, gid)
        self.assertEqual(out, "2026-05-24 10:00:00")

    @mock.patch("federation_dms.db.get_or_create_local_server_identity", return_value={
        "server_id": "srv_au",
        "base_url": "https://203.0.113.20.nip.io",
    })
    @mock.patch("federation_dms.db.list_federation_servers", return_value=[
        {"server_id": "srv_au", "base_url": "https://203.0.113.20.nip.io", "enabled": 1},
        {"server_id": "srv_ip_alias", "base_url": "http://203.0.113.20", "enabled": 1},
        {"server_id": "srv_home", "base_url": "https://frogtalk.xyz", "enabled": 1},
    ])
    def test_remote_targets_skip_local_ip_alias(self, _peers, _local):
        import federation_calls as fc

        alias = {"server_id": "srv_ip_alias", "base_url": "http://203.0.113.20"}
        local = {"server_id": "srv_au", "base_url": "https://203.0.113.20.nip.io"}
        self.assertTrue(fc.federation_peer_is_local_alias(alias, local))
        remote = fd.dm_message_federation_remote_targets(
            {"id": 1, "global_user_id": "00000000-0000-4000-8000-000000000001"},
            {"id": 2, "global_user_id": "00000000-0000-4000-8000-000000000002"},
        )
        self.assertIn("srv_home", remote)
        self.assertNotIn("srv_ip_alias", remote)
        self.assertNotIn("srv_au", remote)


if __name__ == "__main__":
    unittest.main()
