"""Tests for per-DM PIN lock prefs and session gate."""
import os
import unittest
import uuid

os.environ.setdefault("FROGTALK_FEDERATION_ENABLED", "0")

import database as db
from deps import dm_lock_mark_unlocked, dm_lock_session_is_locked, dm_lock_clear_channel


class DmPinLockTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()

    def test_set_and_get_my_dm_pin_lock(self):
        suffix = uuid.uuid4().hex[:8]
        ua = int(db.create_user(f"dm_lock_a_{suffix}", "secret12"))
        ub = int(db.create_user(f"dm_lock_b_{suffix}", "secret12"))
        cid = db.get_or_create_dm(ua, ub)
        self.assertFalse(db.get_my_dm_pin_lock(cid, ua)[0])
        self.assertTrue(db.set_my_dm_pin_lock(cid, ua, enabled=True, timeout_sec=300))
        enabled, tout = db.get_my_dm_pin_lock(cid, ua)
        self.assertTrue(enabled)
        self.assertEqual(tout, 300)
        # Other side unchanged
        self.assertFalse(db.get_my_dm_pin_lock(cid, ub)[0])

    def test_dm_lock_session_gate(self):
        suffix = uuid.uuid4().hex[:8]
        ua = int(db.create_user(f"dm_lock_c_{suffix}", "secret12"))
        ub = int(db.create_user(f"dm_lock_d_{suffix}", "secret12"))
        cid = db.get_or_create_dm(ua, ub)
        db.set_my_dm_pin_lock(cid, ua, enabled=True, timeout_sec=-1)
        tok = "test-session-token-dm-lock"
        self.assertTrue(dm_lock_session_is_locked(cid, ua, tok))
        dm_lock_mark_unlocked(tok, cid, timeout_sec=-1)
        self.assertFalse(dm_lock_session_is_locked(cid, ua, tok))
        dm_lock_clear_channel(tok, cid)
        self.assertTrue(dm_lock_session_is_locked(cid, ua, tok))


if __name__ == "__main__":
    unittest.main()
