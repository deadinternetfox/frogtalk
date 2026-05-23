"""Federated DM outbox routing."""
import unittest
from unittest import mock

import federation_dms as fd


class FederatedDMsTests(unittest.TestCase):
    @mock.patch("federation_dms._party_homed_elsewhere", return_value=False)
    @mock.patch("federation_dms.fc.callee_session_on_local_node", return_value=True)
    def test_should_not_federate_same_home_peer_online(self, _local, _remote):
        sender = {"global_user_id": "00000000-0000-4000-8000-000000000001"}
        peer = {"id": 2, "global_user_id": "00000000-0000-4000-8000-000000000002"}
        self.assertFalse(fd.should_federate_dm(sender, peer))

    @mock.patch("federation_dms._party_homed_elsewhere", return_value=False)
    @mock.patch("federation_dms.fc.callee_session_on_local_node", return_value=False)
    def test_should_federate_when_peer_not_local(self, _local, _remote):
        sender = {"global_user_id": "00000000-0000-4000-8000-000000000001"}
        peer = {"id": 2, "global_user_id": "00000000-0000-4000-8000-000000000002"}
        self.assertTrue(fd.should_federate_dm(sender, peer))

    @mock.patch("federation_dms._party_homed_elsewhere", return_value=False)
    @mock.patch("federation_dms.fc.callee_session_on_local_node", return_value=False)
    def test_should_federate_without_global_ids_when_peer_off_node(self, _local, _remote):
        """Travel sessions without global_user_id must still replicate DMs."""
        sender = {"id": 1, "nickname": "alice"}
        peer = {"id": 2, "nickname": "bob"}
        self.assertTrue(fd.should_federate_dm(sender, peer))

    @mock.patch("federation_dms._party_homed_elsewhere", return_value=True)
    @mock.patch("federation_dms.fc.callee_session_on_local_node", return_value=True)
    def test_should_not_federate_when_peer_online_even_if_homed_elsewhere(self, _local, _remote):
        """WS delivery on this node is enough — avoids false no_dm_route warnings."""
        sender = {"global_user_id": "00000000-0000-4000-8000-000000000001"}
        peer = {"id": 2, "global_user_id": "00000000-0000-4000-8000-000000000002"}
        self.assertFalse(fd.should_federate_dm(sender, peer))

    def test_dm_parties_need_global_ids(self):
        self.assertTrue(fd.dm_parties_have_global_ids(
            {"global_user_id": "a"},
            {"global_user_id": "b"},
        ))
        self.assertFalse(fd.dm_parties_have_global_ids(
            {"global_user_id": "a"},
            {"global_user_id": ""},
        ))

    @mock.patch("federation_dms.fc.call_offer_target_servers", return_value=["home", "peer_b"])
    def test_dm_targets_match_call_fanout(self, mock_targets):
        peer = {"global_user_id": "00000000-0000-4000-8000-000000000002"}
        self.assertEqual(fd.dm_message_target_servers(peer), ["home", "peer_b"])
        mock_targets.assert_called_once_with(peer)


if __name__ == "__main__":
    unittest.main()
