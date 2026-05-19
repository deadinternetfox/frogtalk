"""Unit tests for the channel-theme image proxy.

These tests exercise the pure-Python validation helpers (URL allowlist,
IP / hostname blocking, cache file layout) without hitting the network.
The full HTTP round-trip is covered by integration tests against a
running server.
"""
from __future__ import annotations

import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from routers.proxy import (  # noqa: E402
    _validate_url, _ip_blocked, _hostname_blocked, _cache_path, _meta_path,
)


# ---------------------------------------------------------------------------
# IP allowlist
# ---------------------------------------------------------------------------

BLOCKED_IPS = [
    "127.0.0.1",          # loopback
    "127.0.0.5",
    "0.0.0.0",            # unspecified
    "10.0.0.1",           # RFC1918
    "172.16.0.5",         # RFC1918
    "192.168.0.10",       # RFC1918
    "169.254.169.254",    # AWS / GCP metadata endpoint
    "::1",                # IPv6 loopback
    "fe80::1",            # link-local v6
    "fc00::1",            # ULA v6
    "::ffff:127.0.0.1",   # IPv4-mapped loopback
]

PUBLIC_IPS = [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",      # example.com
    "2606:4700:4700::1111",  # public Cloudflare v6
]


@pytest.mark.parametrize("ip", BLOCKED_IPS)
def test_blocks_private_and_internal_ips(ip):
    assert _ip_blocked(ip) is True, f"should block {ip}"


@pytest.mark.parametrize("ip", PUBLIC_IPS)
def test_allows_public_ips(ip):
    assert _ip_blocked(ip) is False, f"should allow {ip}"


# ---------------------------------------------------------------------------
# Hostname allowlist
# ---------------------------------------------------------------------------

BLOCKED_HOSTS = [
    "localhost", "ip6-localhost", "broadcasthost",
    "router.local", "printer.local", "host.internal",
    "anything.localhost", "myhost.intranet",
]

ALLOWED_HOSTS_SHAPE = [
    "example.com", "img.example.com", "cdn.example.org",
]


@pytest.mark.parametrize("host", BLOCKED_HOSTS)
def test_blocks_localnet_hostnames(host):
    assert _hostname_blocked(host) is True, f"should block {host}"


@pytest.mark.parametrize("host", ALLOWED_HOSTS_SHAPE)
def test_allows_public_hostname_shape(host):
    # We only check shape here; full validation calls DNS via
    # `_validate_url` and is mocked in the URL-validation tests below.
    assert _hostname_blocked(host) is False, f"should not block {host}"


# ---------------------------------------------------------------------------
# URL validation (mocks `_resolve_and_check` to avoid real DNS)
# ---------------------------------------------------------------------------

def _good_resolve(host):  # public-ip stub
    return "93.184.216.34"


def _internal_resolve(host):  # all hosts resolve to a private IP
    return None


@pytest.mark.parametrize("url", [
    "",
    "x" * 3000,                       # too long
    "ftp://example.com/x",            # disallowed scheme
    "file:///etc/passwd",             # disallowed scheme
    "javascript:alert(1)",            # disallowed scheme
    "http://localhost/x",             # blocked host
    "http://127.0.0.1/x",             # direct loopback IP literal
    "http://10.0.0.1/x",              # direct private IP literal
    "http://[::1]/x",                 # direct loopback v6 literal
])
def test_rejects_unsafe_urls(url):
    with patch("routers.proxy._resolve_and_check", new=_good_resolve):
        err = _validate_url(url)
        assert err, f"expected rejection for {url}"


def test_rejects_url_resolving_to_internal_ip():
    with patch("routers.proxy._resolve_and_check", new=_internal_resolve):
        err = _validate_url("http://attacker.example/x.png")
        assert err is not None


def test_accepts_url_resolving_to_public_ip():
    with patch("routers.proxy._resolve_and_check", new=_good_resolve):
        err = _validate_url("https://example.com/x.png")
        assert err is None


# ---------------------------------------------------------------------------
# Cache file layout — bodies + metadata pair up under a sha256 key.
# ---------------------------------------------------------------------------

def test_cache_paths_pair_up():
    body = _cache_path("https://x.example/a.png")
    meta = _meta_path("https://x.example/a.png")
    assert body.parent == meta.parent
    assert body.name + ".meta" == meta.name.replace(meta.suffix, "") + ".meta"
    # different URL → different filename
    assert _cache_path("https://x.example/b.png") != body
