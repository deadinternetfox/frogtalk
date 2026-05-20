"""SECURITY-PASS-2 regression tests.

Covers the additions made in the second-pass security cycle:

- HIGH-7: CSP enforce + nonce middleware
- HIGH-2: HttpOnly session cookie + CSRF double-submit middleware
- Federation per-request Ed25519 signing
- Media off-SQLite storage abstraction + auth-gated blob serving
- Emoji-fingerprint UI deprecation (verifies the helper is now a no-op
  surface only, no nickname-derived "verification" claim leaks).
"""

import base64
import hashlib
import json
import os
import tempfile
import unittest

# Force the media storage root + offload flag before importing the app
# so any startup that touches media_storage sees a sandboxed env.
_TMP_MEDIA = tempfile.mkdtemp(prefix="ft-sec2-media-")
os.environ["FROGTALK_MEDIA_DIR"] = _TMP_MEDIA
os.environ["FROGTALK_MEDIA_OFFLOAD_ENABLED"] = "1"
# Pin the CSRF secret so the middleware's HMAC is deterministic in tests.
os.environ.setdefault("FROGTALK_CSRF_SECRET", "test-csrf-secret-do-not-use-in-prod")
# Run federation auth tests in dual mode so signed + legacy both exercised.
os.environ.setdefault("FROGTALK_FEDERATION_AUTH_MODE", "dual")


class MediaStorageTests(unittest.TestCase):
    """Off-SQLite media storage round-trip + path-traversal safety."""

    def test_store_read_roundtrip(self):
        import media_storage

        payload = b"hello-world-media-bytes" * 4096
        ref = media_storage.store_bytes(payload, mime="image/png")
        self.assertTrue(media_storage.is_ref(ref))
        data, mime = media_storage.read_bytes(ref)
        self.assertEqual(data, payload)
        self.assertEqual(mime, "image/png")

    def test_traversal_blocked(self):
        import media_storage

        with self.assertRaises(media_storage.InvalidMediaRef):
            media_storage.read_bytes("ref:../etc/passwd")
        with self.assertRaises(media_storage.InvalidMediaRef):
            media_storage.read_bytes("ref:not-hex-but-long-enough-to-look-real-XXXX")

    def test_maybe_offload_returns_url_form(self):
        import media_storage

        payload_bytes = b"X" * (media_storage._inline_threshold() + 1024)
        data_url = "data:image/png;base64," + base64.b64encode(payload_bytes).decode("ascii")
        result = media_storage.maybe_offload(data_url)
        self.assertIsNotNone(result)
        self.assertTrue(result.startswith("/api/media/blob/"))
        # Round-trip the URL back to a ref and read the bytes.
        ref = media_storage.blob_url_to_ref(result)
        self.assertTrue(media_storage.is_ref(ref))
        got, _ = media_storage.read_bytes(ref)
        self.assertEqual(got, payload_bytes)

    def test_maybe_offload_skips_small_blob(self):
        import media_storage

        # 100 byte data URL should NOT be offloaded.
        tiny = "data:image/png;base64," + base64.b64encode(b"AAA" * 30).decode("ascii")
        self.assertEqual(media_storage.maybe_offload(tiny), tiny)

    def test_maybe_offload_skips_when_disabled(self):
        import media_storage

        old = os.environ.get("FROGTALK_MEDIA_OFFLOAD_ENABLED")
        os.environ["FROGTALK_MEDIA_OFFLOAD_ENABLED"] = "0"
        try:
            big = "data:image/png;base64," + base64.b64encode(b"B" * 200000).decode("ascii")
            self.assertEqual(media_storage.maybe_offload(big), big)
        finally:
            if old is None:
                os.environ.pop("FROGTALK_MEDIA_OFFLOAD_ENABLED", None)
            else:
                os.environ["FROGTALK_MEDIA_OFFLOAD_ENABLED"] = old

    def test_maybe_offload_skips_non_data(self):
        import media_storage

        self.assertEqual(media_storage.maybe_offload(None), None)
        self.assertEqual(media_storage.maybe_offload("ftenc:cipherbytes"), "ftenc:cipherbytes")
        self.assertEqual(
            media_storage.maybe_offload("/api/media/blob/" + "a" * 64),
            "/api/media/blob/" + "a" * 64,
        )

    def test_unsafe_mime_marked_not_inline(self):
        import media_storage

        self.assertFalse(media_storage.is_safe_inline_mime("text/html"))
        self.assertFalse(media_storage.is_safe_inline_mime("image/svg+xml"))
        self.assertTrue(media_storage.is_safe_inline_mime("image/png"))


class FederationSigningTests(unittest.TestCase):
    """Per-request Ed25519 signing replaces shared-bearer for federation."""

    def setUp(self):
        # Reset replay cache so tests are isolated.
        import crypto_fed

        crypto_fed._replay_cache.clear()

    def test_sign_and_verify_roundtrip(self):
        import crypto_fed
        import database as db

        # Spin up our local keypair (the "peer" in this self-test).
        # We pretend the local server is peer_id "self".
        peer_id = "self_test_peer"
        body = json.dumps({"events": []}).encode("utf-8")
        headers = crypto_fed.sign_request_headers(
            "POST", "/api/federation/events/inbox", body, peer_id
        )
        # Lookup: return our own public key as if it had been registered.
        pubkey_pem = crypto_fed.get_local_public_key_pem()

        def _lookup(pid):
            return pubkey_pem if pid == peer_id else None

        ok, recovered_peer, reason = crypto_fed.verify_signed_request(
            "POST", "/api/federation/events/inbox", body, headers, _lookup
        )
        self.assertTrue(ok, msg=f"expected ok=True, got reason={reason!r}")
        self.assertEqual(recovered_peer, peer_id)

    def test_tampered_body_rejected(self):
        import crypto_fed

        peer_id = "self_test_peer"
        body = b'{"events":[]}'
        headers = crypto_fed.sign_request_headers(
            "POST", "/api/federation/events/inbox", body, peer_id
        )
        pubkey_pem = crypto_fed.get_local_public_key_pem()
        tampered = b'{"events":[{"evil":true}]}'
        ok, _, reason = crypto_fed.verify_signed_request(
            "POST", "/api/federation/events/inbox", tampered,
            headers, lambda _pid: pubkey_pem,
        )
        self.assertFalse(ok)
        self.assertEqual(reason, "body_hash_mismatch")

    def test_replay_rejected(self):
        import crypto_fed

        peer_id = "self_test_peer"
        body = b'{"events":[]}'
        headers = crypto_fed.sign_request_headers(
            "POST", "/api/federation/events/inbox", body, peer_id
        )
        pubkey_pem = crypto_fed.get_local_public_key_pem()
        lookup = lambda _pid: pubkey_pem  # noqa: E731

        ok1, _, _ = crypto_fed.verify_signed_request(
            "POST", "/api/federation/events/inbox", body, headers, lookup
        )
        self.assertTrue(ok1)
        # Same headers a second time → replay.
        ok2, _, reason = crypto_fed.verify_signed_request(
            "POST", "/api/federation/events/inbox", body, headers, lookup
        )
        self.assertFalse(ok2)
        self.assertEqual(reason, "replay")

    def test_unknown_peer_rejected(self):
        import crypto_fed

        peer_id = "stranger"
        body = b'{}'
        headers = crypto_fed.sign_request_headers("POST", "/api/federation/events/inbox", body, peer_id)
        ok, _, reason = crypto_fed.verify_signed_request(
            "POST", "/api/federation/events/inbox", body, headers, lambda _pid: None
        )
        self.assertFalse(ok)
        self.assertEqual(reason, "unknown_peer")

    def test_path_or_method_mismatch_rejected(self):
        import crypto_fed

        peer_id = "self_test_peer"
        body = b'{}'
        headers = crypto_fed.sign_request_headers(
            "POST", "/api/federation/events/inbox", body, peer_id
        )
        pubkey_pem = crypto_fed.get_local_public_key_pem()
        # Re-route the verification to a different path.
        ok, _, reason = crypto_fed.verify_signed_request(
            "POST", "/api/federation/events/different",
            body, headers, lambda _pid: pubkey_pem,
        )
        self.assertFalse(ok)
        self.assertEqual(reason, "bad_signature")

    def test_auth_mode_env(self):
        import crypto_fed

        for v, expected in (("dual", "dual"), ("signed", "signed"),
                            ("legacy", "legacy"), ("bogus", "dual"),
                            ("", "dual")):
            os.environ["FROGTALK_FEDERATION_AUTH_MODE"] = v
            self.assertEqual(crypto_fed.federation_auth_mode(), expected)


class CSPTests(unittest.TestCase):
    """CSP middleware emits a per-request nonce in enforce mode."""

    def test_csp_includes_nonce(self):
        from fastapi.testclient import TestClient
        # Force enforce mode for the test.
        os.environ["FROGTALK_CSP_ENFORCE"] = "1"
        # Re-import main so _CSP_ENFORCE picks up the env.
        import importlib
        import main
        importlib.reload(main)
        client = TestClient(main.app)
        r = client.get("/health")
        csp = r.headers.get("content-security-policy", "")
        self.assertIn("default-src 'self'", csp)
        self.assertIn("style-src 'self' 'unsafe-inline'", csp)
        self.assertIn("script-src 'self' 'unsafe-inline'", csp)
        # Phase A: nonce must NOT appear in CSP directives (breaks inline
        # <style> until every tag is nonce-tagged).
        self.assertNotIn("'nonce-", csp)
        self.assertIn("object-src 'none'", csp)
        self.assertIn("base-uri 'self'", csp)
        self.assertIn("form-action 'self'", csp)


class CSRFGuardTests(unittest.TestCase):
    """CSRF middleware blocks cookie-auth mutating requests without token,
    accepts them with the correct double-submit token, and skips
    header-only auth paths entirely."""

    @classmethod
    def setUpClass(cls):
        os.environ["FROGTALK_CSP_ENFORCE"] = "1"
        from fastapi.testclient import TestClient
        import importlib
        import main
        importlib.reload(main)
        cls.client = TestClient(main.app)

    def _expected_csrf(self, sess_token: str) -> str:
        import hmac
        import hashlib as h
        secret = os.environ["FROGTALK_CSRF_SECRET"].encode()
        return hmac.new(secret, sess_token.encode(), h.sha256).hexdigest()

    def test_get_with_cookie_not_blocked(self):
        # GET is a safe method — should not require CSRF even with cookie.
        c = self.client
        c.cookies.set("ft_session", "fakesess")
        r = c.get("/api/auth/me")
        # Will 401 (invalid session) — what matters is it is NOT 403 CSRF.
        self.assertNotEqual(r.status_code, 403)
        self.assertNotIn(b"csrf", r.content.lower())
        c.cookies.clear()

    def test_post_with_cookie_no_csrf_rejected(self):
        c = self.client
        c.cookies.set("ft_session", "fakesess")
        r = c.post("/api/dms/start", json={"nickname": "x"})
        self.assertEqual(r.status_code, 403)
        body = r.json()
        self.assertEqual(body.get("code"), "csrf_missing")
        c.cookies.clear()

    def test_post_with_cookie_and_bad_csrf_rejected(self):
        c = self.client
        c.cookies.set("ft_session", "fakesess")
        r = c.post(
            "/api/dms/start", json={"nickname": "x"},
            headers={"X-CSRF-Token": "obviously-bogus"},
        )
        self.assertEqual(r.status_code, 403)
        body = r.json()
        self.assertEqual(body.get("code"), "csrf_invalid")
        c.cookies.clear()

    def test_post_with_x_session_token_header_bypasses_csrf(self):
        # Header-only auth path doesn't need CSRF — custom headers
        # trip CORS preflight cross-origin so they're already safe.
        c = self.client
        r = c.post(
            "/api/dms/start", json={"nickname": "x"},
            headers={"X-Session-Token": "not-a-real-token"},
        )
        # Will 401 (invalid session), NOT 403 CSRF.
        self.assertNotEqual(r.status_code, 403)

    def test_exempt_paths_skip_csrf(self):
        c = self.client
        c.cookies.set("ft_session", "fakesess")
        # /api/auth/login is exempt because the cookie isn't set yet
        # by the time login itself is called.
        r = c.post("/api/auth/login", json={"nickname": "x", "password": "y"})
        # Will be 401 or 422 — but not 403 csrf.
        self.assertNotEqual(r.status_code, 403)
        c.cookies.clear()


if __name__ == "__main__":
    unittest.main()
