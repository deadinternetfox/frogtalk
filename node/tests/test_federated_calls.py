"""Federated call signaling helpers."""
import os
import unittest
from unittest import mock

import database as db
import federation_calls as fc
import federation_voice as fv
from fed_turn import federation_calls_enabled, local_turn_public_view, turn_ice_servers


class FederatedCallsTests(unittest.TestCase):
    def setUp(self):
        os.environ.setdefault("FROGTALK_FEDERATION_CALLS_ENABLED", "1")

    def test_federation_calls_enabled_env(self):
        with mock.patch.dict(os.environ, {"FROGTALK_FEDERATION_CALLS_ENABLED": "1"}):
            self.assertTrue(federation_calls_enabled())
        with mock.patch.dict(os.environ, {"FROGTALK_FEDERATION_CALLS_ENABLED": "0"}):
            self.assertFalse(federation_calls_enabled())

    def test_turn_ice_servers_stun_and_turn(self):
        servers = turn_ice_servers(
            ["stun:stun.example.com:3478", "turn:turn.example.com:3478"],
            username="u",
            credential="p",
        )
        self.assertTrue(len(servers) >= 2)

    def test_local_turn_public_view_empty_when_unset(self):
        with mock.patch.dict(os.environ, {"FROGTALK_TURN_URLS": ""}, clear=False):
            view = local_turn_public_view()
            self.assertEqual(view.get("turn_urls"), [])

    def test_new_global_call_id_uuid(self):
        a = fc.new_global_call_id()
        b = fc.new_global_call_id()
        self.assertNotEqual(a, b)
        self.assertEqual(len(a), 36)

    def test_map_and_resolve_call_id(self):
        gid = fc.new_global_call_id()
        db.map_federation_call(gid, "srv_a", 42, "callee")
        self.assertEqual(db.resolve_local_call_id(gid, "srv_a"), 42)
        self.assertEqual(db.resolve_local_call_id(gid), 42)

    @mock.patch("federation_calls.federation_calls_enabled", return_value=True)
    @mock.patch("database.resolve_global_user_home_server_id")
    @mock.patch("database.get_or_create_local_server_identity")
    def test_is_remote_peer(self, mock_ident, mock_home, _enabled):
        mock_ident.return_value = {"server_id": "local_srv"}
        mock_home.return_value = "remote_srv"
        self.assertTrue(fc.is_remote_peer({"global_user_id": "00000000-0000-4000-8000-000000000001"}))
        mock_home.return_value = "local_srv"
        self.assertFalse(fc.is_remote_peer({"global_user_id": "00000000-0000-4000-8000-000000000001"}))

    # ── Hardening regression tests ────────────────────────────────

    def test_safe_call_type_allowlist(self):
        self.assertEqual(fc._safe_call_type("voice"), "voice")
        self.assertEqual(fc._safe_call_type("video"), "video")
        self.assertEqual(fc._safe_call_type("VIDEO"), "video")
        # Anything outside the allowlist collapses to "voice" so an
        # attacker can't smuggle e.g. "screenshare" or HTML into the
        # client-rendered call type.
        self.assertEqual(fc._safe_call_type("<script>"), "voice")
        self.assertEqual(fc._safe_call_type(""), "voice")
        self.assertEqual(fc._safe_call_type(None), "voice")

    def test_safe_avatar_rejects_hostile_schemes(self):
        # Only data:image/* and http(s):// are permitted; anything else
        # (javascript:, vbscript:, data:text/html, etc.) is dropped to
        # the empty string so a hostile peer can't smuggle a JS url into
        # the client's <img src>.
        self.assertEqual(fc._safe_avatar("javascript:alert(1)"), "")
        self.assertEqual(fc._safe_avatar("vbscript:msgbox 1"), "")
        self.assertEqual(fc._safe_avatar("data:text/html,<script>"), "")
        self.assertEqual(fc._safe_avatar("file:///etc/passwd"), "")
        self.assertEqual(fc._safe_avatar(""), "")
        self.assertTrue(fc._safe_avatar("https://example.com/a.png").startswith("https://"))
        self.assertTrue(fc._safe_avatar("data:image/png;base64,abc").startswith("data:image/"))

    def test_clip_sdp_caps(self):
        big = "v=0\r\n" + ("a" * (fc._FED_CALL_SDP_MAX * 2))
        self.assertLessEqual(len(fc._clip_sdp(big)), fc._FED_CALL_SDP_MAX)

    def test_offer_flood_per_origin_callee(self):
        # Clear shared bucket to make the test deterministic.
        fc._offer_flood.clear()
        origin = "srv_attacker"
        callee = "00000000-0000-4000-8000-000000000099"
        # First _FED_..._MAX go through, then we start dropping.
        for _ in range(fc._OFFER_FLOOD_MAX):
            self.assertFalse(fc._offer_throttled(origin, callee))
        self.assertTrue(fc._offer_throttled(origin, callee))
        # Different callee on same origin still fine — throttle is
        # scoped per (origin, callee_gid) pair so honest cross-traffic
        # isn't penalised.
        self.assertFalse(fc._offer_throttled(origin, "00000000-0000-4000-8000-0000000000aa"))

    def test_can_call_user_block_and_friend(self):
        with mock.patch("database.is_blocked_either_way", return_value=True):
            self.assertEqual(fc.can_call_user(1, 2), "blocked")
        with mock.patch("database.is_blocked_either_way", return_value=False), \
             mock.patch("federation_calls.require_friend_for_calls", return_value=True), \
             mock.patch("database.are_friends", return_value=False):
            self.assertEqual(fc.can_call_user(1, 2), "not_friends")
        with mock.patch("database.is_blocked_either_way", return_value=False), \
             mock.patch("federation_calls.require_friend_for_calls", return_value=False):
            self.assertIsNone(fc.can_call_user(1, 2))


class FederatedVoiceTests(unittest.TestCase):
    def setUp(self):
        os.environ.setdefault("FROGTALK_FEDERATION_CALLS_ENABLED", "1")

    def test_safe_avatar_blocks_hostile(self):
        self.assertEqual(fv._safe_avatar("javascript:1"), "")
        self.assertEqual(fv._safe_avatar("data:text/html,<x>"), "")
        self.assertTrue(fv._safe_avatar("https://x/y.png").startswith("https://"))

    def test_deterministic_session_id_stable(self):
        a = fv.deterministic_session_id("Room", "srv_anchor")
        b = fv.deterministic_session_id("room", "srv_anchor")
        # Case-insensitive room name (callers may pass any casing); both
        # nodes must agree on the same session id.
        self.assertEqual(a, b)
        c = fv.deterministic_session_id("room", "OTHER_ANCHOR")
        self.assertNotEqual(a, c)

    def test_registry_caps_per_session(self):
        reg = fv.FederatedVoiceRegistry()
        sid = "test-sid"
        for i in range(fv._REMOTE_PER_SESSION_CAP):
            self.assertTrue(reg.add_remote(
                sid,
                global_user_id=f"gid-{i}",
                nickname=f"n{i}",
                home_server_id="srv_remote",
            ))
        # Cap reached — additional adds must refuse rather than grow
        # the in-memory roster without bound.
        self.assertFalse(reg.add_remote(
            sid,
            global_user_id="gid-overflow",
            nickname="x",
            home_server_id="srv_remote",
        ))

    def test_registry_remove_decrements_origin(self):
        reg = fv.FederatedVoiceRegistry()
        sid = "rr"
        reg.add_remote(sid, global_user_id="g1", nickname="n", home_server_id="srv_a")
        reg.add_remote(sid, global_user_id="g2", nickname="n", home_server_id="srv_a")
        self.assertEqual(reg._origin_count.get("srv_a"), 2)
        removed = reg.remove_remote(sid, "g1")
        self.assertIsNotNone(removed)
        self.assertEqual(reg._origin_count.get("srv_a"), 1)

    def test_enqueue_voice_signal_rejects_bad_kind(self):
        out = fv.enqueue_voice_signal(
            {"global_user_id": "g"}, "to-gid",
            session_id="s", room_name="r", kind="<script>",
        )
        # Validates 'kind' allow-list (offer/answer/ice) before going
        # anywhere near federation outbox.
        self.assertEqual(out.get("error"), "bad_kind")


if __name__ == "__main__":
    unittest.main()
