import unittest

from ws_manager import VoiceManager
import federation_voice as fv


class VoiceManagerTests(unittest.TestCase):
    def setUp(self):
        self.vm = VoiceManager()

    def test_join_idempotent_by_global_user_id(self):
        r1 = self.vm.join("general", 1, "Alice", "a1", "gid-alice")
        self.assertFalse(r1["already"])
        self.assertEqual(len(r1["existing"]), 0)

        r2 = self.vm.join("general", 1, "Alice", "a1", "gid-alice")
        self.assertTrue(r2["already"])
        self.assertEqual(len(self.vm.participants("general")), 1)

    def test_second_tab_same_user_does_not_duplicate_roster(self):
        self.vm.join("general", 1, "Alice", "", "gid-alice")
        self.vm.join("general", 1, "Alice", "", "gid-alice")
        parts = self.vm.participants("general")
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0]["global_user_id"], "gid-alice")

    def test_leave_all_by_gid(self):
        self.vm.join("general", 1, "Alice", "", "gid-alice")
        left = self.vm.leave_all(99, "gid-alice")
        self.assertEqual(left, ["general"])
        self.assertEqual(self.vm.participants("general"), [])

    def test_is_in_voice_by_gid(self):
        self.vm.join("general", 1, "Alice", "", "gid-alice")
        self.assertTrue(self.vm.is_in_voice_by_gid("general", "gid-alice"))
        self.assertFalse(self.vm.is_in_voice_by_gid("general", "gid-other"))


class VoiceParticipantDedupeTests(unittest.TestCase):
    def test_dedupe_prefers_local_over_federated(self):
        parts = [
            {"user_id": 0, "global_user_id": "g1", "nickname": "remote", "federated": True},
            {"user_id": 5, "global_user_id": "g1", "nickname": "local", "federated": False},
        ]
        out = fv._dedupe_voice_participants(parts)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["nickname"], "local")
        self.assertFalse(out[0]["federated"])


if __name__ == "__main__":
    unittest.main()
