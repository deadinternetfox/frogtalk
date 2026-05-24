"""Federated call signaling helpers."""
import asyncio
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
        with mock.patch.dict(
            os.environ,
            {"FROGTALK_FEDERATION_CALLS_ENABLED": "", "FROGTALK_FEDERATION_ENABLED": "1"},
            clear=False,
        ):
            self.assertTrue(federation_calls_enabled())
        with mock.patch.dict(
            os.environ,
            {"FROGTALK_FEDERATION_CALLS_ENABLED": "", "FROGTALK_FEDERATION_ENABLED": "0"},
            clear=False,
        ):
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

    @mock.patch("federation_calls.callee_session_on_local_node", return_value=False)
    @mock.patch("federation_calls.federation_calls_enabled", return_value=True)
    @mock.patch("database.resolve_global_user_home_server_id")
    @mock.patch("database.get_or_create_local_server_identity")
    def test_is_remote_peer(self, mock_ident, mock_home, _enabled, _local_sess):
        mock_ident.return_value = {"server_id": "local_srv"}
        mock_home.return_value = "remote_srv"
        self.assertTrue(fc.is_remote_peer({"global_user_id": "00000000-0000-4000-8000-000000000001"}))
        mock_home.return_value = "local_srv"
        # Home matches this node but callee is not on our WS — still federate.
        self.assertTrue(fc.is_remote_peer({"global_user_id": "00000000-0000-4000-8000-000000000001"}))

    @mock.patch("federation_calls.federation_calls_enabled", return_value=True)
    @mock.patch("federation_calls.callee_session_on_local_node", return_value=True)
    @mock.patch("database.resolve_global_user_home_server_id", return_value="remote_srv")
    @mock.patch("database.get_or_create_local_server_identity", return_value={"server_id": "local_srv"})
    def test_is_remote_peer_false_when_callee_online_locally(self, *_mocks):
        """Travelers homed elsewhere but connected here use local call delivery."""
        self.assertFalse(fc.is_remote_peer({
            "id": 99,
            "global_user_id": "00000000-0000-4000-8000-000000000002",
        }))

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
        self.assertEqual(fc._safe_avatar("data:image/svg+xml,<svg onload=alert(1)>"), "")
        self.assertEqual(fc._safe_avatar("file:///etc/passwd"), "")
        self.assertEqual(fc._safe_avatar(""), "")
        self.assertTrue(fc._safe_avatar("https://example.com/a.png").startswith("https://"))
        self.assertTrue(fc._safe_avatar("data:image/png;base64,abc").startswith("data:image/"))

    def test_clip_sdp_caps(self):
        big = "v=0\r\n" + ("a" * (fc._FED_CALL_SDP_MAX * 2))
        self.assertLessEqual(len(fc._clip_sdp(big)), fc._FED_CALL_SDP_MAX)
        self.assertNotIn("\x00", fc._clip_sdp("v=0\r\nabc\x00def"))

    def test_clip_ice_strips_controls(self):
        out = fc._clip_ice("candidate:1 1 udp 2122252543 1.2.3.4 5555 typ host\x00")
        self.assertNotIn("\x00", out)
        self.assertTrue(out.startswith("candidate:1"))

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

    def test_peer_signal_bundle_source_prefers_keys_server(self):
        from routers import signal as sig_mod

        with mock.patch.object(sig_mod.db, "get_or_create_local_server_identity",
                               return_value={"server_id": "srv_local"}), \
             mock.patch.object(sig_mod.db, "get_user_signal_keys_server_id",
                               return_value="srv_travel"), \
             mock.patch.object(sig_mod.db, "get_user_account_home_server_id",
                               return_value="srv_home"), \
             mock.patch.object(sig_mod.db, "signal_fetch_bundle", return_value={"x": 1}), \
             mock.patch.object(sig_mod.db, "get_user_by_id", return_value={"global_user_id": "g1"}):
            self.assertEqual(sig_mod._peer_signal_bundle_source_server(42), "srv_travel")
            self.assertTrue(sig_mod._peer_signal_bundle_is_remote(42))

    def test_can_call_user_allows_existing_dm_without_friend(self):
        class _Row:
            def __init__(self):
                self._data = {"id": 99}

            def fetchone(self):
                return self._data

        class _Con:
            def execute(self, *_a, **_k):
                return _Row()

        with mock.patch("database.is_blocked_either_way", return_value=False), \
             mock.patch("federation_calls.require_friend_for_calls", return_value=True), \
             mock.patch("database.are_friends", return_value=False), \
             mock.patch.object(db, "_conn") as mock_conn:
            mock_conn.return_value.__enter__.return_value = _Con()
            self.assertIsNone(fc.can_call_user(1, 2))

    def test_relay_origin_allowed_for_enabled_peer(self):
        with mock.patch.object(db, "get_or_create_local_server_identity",
                               return_value={"server_id": "srv_local"}), \
             mock.patch.object(db, "get_federation_server_row",
                               return_value={"server_id": "srv_travel", "enabled": 1}):
            self.assertTrue(fc._relay_origin_allowed("srv_travel"))
        with mock.patch.object(db, "get_federation_server_row", return_value=None):
            self.assertFalse(fc._relay_origin_allowed("srv_unknown"))

    @mock.patch("federation_calls._relay_origin_allowed", return_value=True)
    @mock.patch.object(db, "resolve_global_user_home_server_id", return_value="srv_home")
    def test_call_home_mismatch_allowed_for_travel_relay(self, _relay, _home):
        self.assertFalse(fc._call_home_origin_mismatch("gid-a", "srv_travel"))

    def test_apply_call_offer_drops_forged_origin(self):
        """Caller's claimed home must equal the federation event's origin.

        Without this check a peer holding only the shared federation
        token could spoof a `call.offer` for any caller they like.
        """
        ev = {
            "event_id": "evt_test_1",
            "event_type": "call.offer",
            "origin_server_id": "srv_attacker",
            "payload": {
                "global_call_id": "00000000-0000-4000-8000-000000000111",
                "caller_global_user_id": "caller-gid",
                "callee_global_user_id": "callee-gid",
                "call_type": "voice",
                "sdp": "v=0",
                "fp_sig": "",
                "caller_nickname": "alice",
            },
        }
        # The caller's real home is `srv_honest`; the attacker forged origin.
        with mock.patch("federation_calls.federation_calls_enabled", return_value=True), \
             mock.patch("federation_calls._relay_origin_allowed", return_value=False), \
             mock.patch.object(db, "resolve_global_user_home_server_id",
                               side_effect=lambda gid: "srv_honest" if gid == "caller-gid" else "srv_anywhere"), \
             mock.patch.object(db, "save_pending_call_offer") as save_mock:
            asyncio.run(fc.apply_call_event(ev))
            save_mock.assert_not_called()

    @mock.patch("federation_calls._enqueue")
    @mock.patch("federation_calls.call_offer_target_servers", return_value=["srv_remote", "srv_b"])
    def test_enqueue_call_renegotiate_sets_flag(self, _targets, mock_enqueue):
        mock_enqueue.return_value = {"ok": True}
        caller = {"id": 1, "global_user_id": "gid-a", "nickname": "a"}
        callee = {"id": 2, "global_user_id": "gid-b", "nickname": "b"}
        fc.enqueue_call_renegotiate(
            caller,
            callee,
            global_call_id="00000000-0000-4000-8000-000000000099",
            local_call_id=7,
            call_type="video",
            sdp="v=0\r\no=-",
        )
        self.assertTrue(mock_enqueue.called)
        _etype, payload, _targets = mock_enqueue.call_args[0]
        self.assertEqual(_etype, "call.offer")
        self.assertTrue(payload.get("renegotiate"))

    @mock.patch("federation_calls.callee_session_on_local_node", return_value=False)
    @mock.patch("federation_calls.federation_calls_enabled", return_value=True)
    @mock.patch("database.list_federation_servers", return_value=[
        {"server_id": "srv_b", "enabled": 1, "base_url": "https://peer-b.test"},
    ])
    @mock.patch(
        "database.resolve_federation_push_targets_for_recipient_gids",
        return_value=["srv_home"],
    )
    @mock.patch("database.get_or_create_local_server_identity", return_value={"server_id": "srv_local"})
    def test_call_signal_target_servers_use_recipient_home(self, *_mocks):
        targets = fc.call_signal_target_servers(
            {"global_user_id": "gid-traveler"},
        )
        self.assertEqual(targets, ["srv_home"])

    @mock.patch("federation_calls.callee_session_on_local_node", return_value=False)
    @mock.patch("database.resolve_federation_push_targets_for_recipient_gids", return_value=[])
    @mock.patch("database.list_federation_servers", return_value=[
        {"server_id": "srv_b", "enabled": 1, "base_url": "https://peer-b.test"},
        {"server_id": "srv_onion", "enabled": 1, "onion_url": "http://x.onion", "base_url": ""},
    ])
    @mock.patch("database.get_or_create_local_server_identity", return_value={"server_id": "srv_local"})
    def test_call_signal_target_servers_clearnet_fallback_skips_onion(self, *_mocks):
        targets = fc.call_signal_target_servers({"global_user_id": "gid-local-home"})
        self.assertEqual(targets, ["srv_b"])

    @mock.patch("federation_calls.federation_calls_enabled", return_value=True)
    @mock.patch("federation_calls.callee_session_on_local_node", return_value=True)
    def test_needs_federated_call_delivery_false_when_online(self, _sess, _enabled):
        self.assertFalse(fc.needs_federated_call_delivery({"id": 1, "global_user_id": "g1"}))

    @mock.patch("federation_calls.federation_calls_enabled", return_value=True)
    @mock.patch("federation_calls.callee_session_on_local_node", return_value=False)
    def test_needs_federated_call_delivery_true_when_offline(self, _sess, _enabled):
        self.assertTrue(fc.needs_federated_call_delivery({"id": 1, "global_user_id": "g1"}))

    def test_callee_home_server_routes_to_remote_peer(self):
        """``callee_home_server`` returns the remote sid for federated peers."""
        with mock.patch.object(db, "resolve_global_user_home_server_id",
                               return_value="srv_au"), \
             mock.patch.object(db, "get_or_create_local_server_identity",
                               return_value={"server_id": "srv_local"}):
            sid = fc.callee_home_server({"global_user_id": "gid-au"})
            self.assertEqual(sid, "srv_au")
        with mock.patch.object(db, "resolve_global_user_home_server_id",
                               return_value=""), \
             mock.patch.object(db, "get_or_create_local_server_identity",
                               return_value={"server_id": "srv_local"}):
            sid = fc.callee_home_server({"global_user_id": "gid-local"})
            self.assertEqual(sid, "srv_local")

    def test_turn_ice_servers_merges_peer_urls(self):
        """Merged ICE config picks up peer TURN URLs without duplicates."""
        local_only = turn_ice_servers(
            ["stun:stun.local:3478", "turn:turn.local:3478"],
            username="alice", credential="pw1",
        )
        merged = turn_ice_servers(
            [
                "stun:stun.local:3478",
                "turn:turn.local:3478",
                "turn:turn.peer:3478",
            ],
            username="alice", credential="pw1",
        )
        self.assertGreater(len(merged), len(local_only))
        # No duplicate `stun:stun.local:3478` after the merge.
        seen = set()
        for s in merged:
            url = s.get("urls")
            self.assertNotIn(url, seen)
            seen.add(url)

    @mock.patch("federation_calls._call_home_origin_mismatch", return_value=False)
    @mock.patch("federation_calls._participants_match_gid", return_value=True)
    @mock.patch("federation_calls._lookup_local_user_by_gid")
    @mock.patch.object(db, "resolve_local_call_id", return_value=42)
    @mock.patch.object(db, "queue_ice_candidate")
    def test_apply_call_ice_queues_with_correct_from_id(self, mock_q, _resolve, mock_lookup, *_mocks):
        to_user = {"id": 10, "global_user_id": "gid-to", "nickname": "bob"}
        from_user = {"id": 20, "global_user_id": "gid-from", "nickname": "alice"}
        mock_lookup.side_effect = lambda gid: to_user if gid == "gid-to" else from_user

        async def _run():
            with mock.patch("ws_manager.manager") as mock_mgr:
                mock_mgr.send_to_user = mock.AsyncMock(return_value=False)
                await fc._apply_call_ice(
                    {
                        "to_global_user_id": "gid-to",
                        "from_global_user_id": "gid-from",
                        "candidate": '{"candidate":"x"}',
                    },
                    "srv_home",
                    "gid-call",
                    lambda x: x,
                )

        asyncio.run(_run())
        mock_q.assert_called_once()
        args = mock_q.call_args[0]
        self.assertEqual(args[0], 42)
        self.assertEqual(args[1], 10)
        self.assertEqual(args[2], 20)
        self.assertEqual(args[3], "alice")


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

    def test_voice_signal_targets_include_join_origin(self):
        reg = fv.FederatedVoiceRegistry()
        sid = "sess-abc"
        reg.add_remote(
            sid,
            global_user_id="gid-traveler",
            nickname="t",
            home_server_id="srv_travel",
            room_name="general",
        )
        with mock.patch.object(fv, "federated_voice_registry", reg), \
             mock.patch.object(fv.db, "resolve_global_user_home_server_id", return_value="srv_home"), \
             mock.patch.object(fv.db, "get_federation_user_connection_servers", return_value=[]), \
             mock.patch.object(fv.db, "get_or_create_local_server_identity", return_value={"server_id": "srv_local"}):
            targets = fv.voice_signal_target_servers("gid-traveler", sid)
        self.assertIn("srv_home", targets)
        self.assertIn("srv_travel", targets)
        self.assertNotIn("srv_local", targets)

    def test_push_targets_prefer_active_connection_over_home(self):
        with mock.patch.object(db, "get_or_create_local_server_identity", return_value={"server_id": "srv_local"}), \
             mock.patch.object(db, "get_federation_user_connection_servers", return_value=["srv_visit"]), \
             mock.patch.object(db, "resolve_global_user_home_server_id", return_value="srv_home"):
            targets = db.resolve_federation_push_targets_for_recipient_gids(["gid-travel"])
        self.assertEqual(set(targets), {"srv_visit", "srv_home"})

    def test_federation_voice_enabled_when_federation_on_calls_off(self):
        from fed_turn import federation_voice_enabled
        with mock.patch.dict(os.environ, {
            "FROGTALK_FEDERATION_CALLS_ENABLED": "0",
            "FROGTALK_FEDERATION_ENABLED": "1",
        }, clear=False):
            self.assertTrue(federation_voice_enabled())

    def test_push_targets_fall_back_to_home_when_offline(self):
        with mock.patch.object(db, "get_or_create_local_server_identity", return_value={"server_id": "srv_local"}), \
             mock.patch.object(db, "resolve_global_user_home_server_id", return_value="srv_home"):
            targets = db.resolve_federation_push_targets_for_recipient_gids(["gid-offline"])
        self.assertEqual(targets, ["srv_home"])

    def test_federation_bundle_by_gid_proxies_remote_keys(self):
        """EU must not return a stale local bundle when keys live on travel."""
        from routers import federation as fed_mod
        from routers import signal as sig_mod

        remote_bundle = {
            "user_id": 42,
            "identity_pub": "dGVzdA==",
            "registration_id": 1,
            "signed_prekey": {"id": 1, "pub": "cA==", "sig": "cQ=="},
            "one_time_prekey": None,
        }

        class _Con:
            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

            def execute(self, *_a, **_k):
                class _Cur:
                    def fetchone(self):
                        return {"id": 42}

                return _Cur()

        async def _run():
            with mock.patch.object(fed_mod, "_fed_token_ok", return_value=True), \
                 mock.patch.object(db, "_conn", return_value=_Con()), \
                 mock.patch.object(sig_mod, "_peer_signal_bundle_is_remote", return_value=True), \
                 mock.patch.object(sig_mod, "fetch_peer_bundle_from_home_sync", return_value=remote_bundle) as prox:
                out = await fed_mod.federation_signal_bundle_by_gid(
                    "00000000-0000-4000-8000-000000000042",
                    x_federation_token="tok",
                )
                prox.assert_called_once_with(42)
                return out

        out = asyncio.run(_run())
        self.assertEqual(out, remote_bundle)


class SignalBundleRoutingTests(unittest.TestCase):
    def test_bundle_source_prefers_remote_keys_pin_over_stale_local(self):
        from routers import signal as sig_mod

        with mock.patch.object(sig_mod.db, "signal_has_published_bundle", return_value=True), \
             mock.patch.object(sig_mod.db, "get_user_signal_keys_server_id", return_value="srv_travel"), \
             mock.patch.object(sig_mod.db, "get_signal_keys_server_for_gid", return_value=""), \
             mock.patch.object(sig_mod.db, "get_user_by_id", return_value={"global_user_id": "g1"}), \
             mock.patch.object(sig_mod, "_local_server_id", return_value="srv_home"):
            self.assertEqual(sig_mod._peer_signal_bundle_source_server(42), "srv_travel")
            self.assertTrue(sig_mod._peer_signal_bundle_is_remote(42))

    def test_bundle_source_uses_local_when_keys_pinned_on_travel(self):
        from routers import signal as sig_mod

        with mock.patch.object(sig_mod.db, "get_user_signal_keys_server_id", return_value="srv_au"), \
             mock.patch.object(sig_mod.db, "get_signal_keys_server_for_gid", return_value=""), \
             mock.patch.object(sig_mod.db, "get_user_account_home_server_id", return_value="srv_home"), \
             mock.patch.object(sig_mod.db, "signal_has_published_bundle", return_value=True), \
             mock.patch.object(sig_mod.db, "get_user_by_id", return_value={"global_user_id": "g1"}), \
             mock.patch.object(sig_mod, "_local_server_id", return_value="srv_au"):
            self.assertEqual(sig_mod._peer_signal_bundle_source_server(42), "")
            self.assertFalse(sig_mod._peer_signal_bundle_is_remote(42))

    def test_bundle_source_prefers_account_home_over_stale_unpinned_travel(self):
        from routers import signal as sig_mod

        with mock.patch.object(sig_mod.db, "get_user_signal_keys_server_id", return_value=""), \
             mock.patch.object(sig_mod.db, "get_signal_keys_server_for_gid", return_value=""), \
             mock.patch.object(sig_mod.db, "get_user_account_home_server_id", return_value="srv_home"), \
             mock.patch.object(sig_mod.db, "signal_has_published_bundle", return_value=True), \
             mock.patch.object(sig_mod.db, "get_user_by_id", return_value={"global_user_id": "g1"}), \
             mock.patch.object(sig_mod, "_local_server_id", return_value="srv_au"):
            self.assertEqual(sig_mod._peer_signal_bundle_source_server(42), "srv_home")
            self.assertTrue(sig_mod._peer_signal_bundle_is_remote(42))

    def test_bundle_source_uses_local_when_keys_pinned_here(self):
        from routers import signal as sig_mod

        with mock.patch.object(sig_mod.db, "signal_has_published_bundle", return_value=True), \
             mock.patch.object(sig_mod.db, "get_user_signal_keys_server_id", return_value="srv_home"), \
             mock.patch.object(sig_mod.db, "get_signal_keys_server_for_gid", return_value=""), \
             mock.patch.object(sig_mod.db, "get_user_by_id", return_value={"global_user_id": "g1"}), \
             mock.patch.object(sig_mod, "_local_server_id", return_value="srv_home"):
            self.assertEqual(sig_mod._peer_signal_bundle_source_server(42), "")
            self.assertFalse(sig_mod._peer_signal_bundle_is_remote(42))


class RemoteBundleGuardTests(unittest.TestCase):
    def setUp(self):
        from routers import signal as sig

        sig._CIRCUIT_FAILS.clear()
        sig._CIRCUIT_OPEN_UNTIL.clear()
        with sig._REMOTE_BUNDLE_INFLIGHT_LOCK:
            sig._REMOTE_BUNDLE_INFLIGHT.clear()

    def test_circuit_opens_after_repeated_failures(self):
        from routers import signal as sig

        sid, gid = "srv_test", "gid-test"
        for _ in range(sig._CIRCUIT_FAIL_THRESHOLD):
            sig._remote_bundle_record_failure(sid, gid)
        self.assertTrue(sig._remote_bundle_circuit_open(sid, gid))

    def test_success_clears_circuit(self):
        from routers import signal as sig

        sid, gid = "srv_test", "gid-test"
        sig._remote_bundle_record_failure(sid, gid)
        sig._remote_bundle_record_success(sid, gid)
        self.assertFalse(sig._remote_bundle_circuit_open(sid, gid))


if __name__ == "__main__":
    unittest.main()
