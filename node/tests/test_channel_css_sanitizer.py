"""Fuzz + unit tests for the channel-theme CSS sanitiser.

The channel sanitiser (`_sanitize_channel_css`) is separate from the
profile-CSS sanitiser (Track B). It permits SELECTORS and rebuilds them
against a `#main` scope on the client, so its threat model is wider —
anywhere an attacker can target the document root or fingerprint
elements outside the scope is in scope.

Each `HOSTILE` case below MUST raise `ValueError`. Each `BENIGN` case
MUST round-trip without raising.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from routers.rooms import _sanitize_channel_css, _sanitize_channel_theme  # noqa: E402


# ---------------------------------------------------------------------------
# Hostile CSS — every entry below MUST raise ValueError.
# ---------------------------------------------------------------------------

HOSTILE = [
    # --- :root family (raw, escaped, NBSP-prefixed, HTML-entity) -----------
    pytest.param(":root { color: red }", id="root-raw"),
    pytest.param("\\:root { color: red }", id="root-css-escaped"),
    pytest.param("\\72 oot { color: red }", id="root-hex-r"),
    pytest.param("&#58;root { color: red }", id="root-html-entity-colon"),
    pytest.param("\u00a0:root { color: red }", id="root-nbsp-prefixed"),
    pytest.param("body:root { color: red }", id="root-after-body"),
    pytest.param(":host { color: red }", id="host-raw"),
    pytest.param(":scope { color: red }", id="scope-raw"),
    pytest.param(":target { color: red }", id="target-raw"),

    # --- attribute selectors targeting platform theming hooks --------------
    pytest.param("[data-theme=\"dark\"] { color: red }", id="data-theme-equals"),
    pytest.param("[data-theme] { color: red }", id="data-theme-naked"),
    pytest.param("div[data-theme] { color: red }", id="data-theme-with-tag"),
    pytest.param("[data-mode] { color: red }", id="data-mode-naked"),

    # --- naked attribute selector (too broad) -------------------------------
    pytest.param("[class] { color: red }", id="naked-attr-class"),
    pytest.param("[id] { color: red }", id="naked-attr-id"),

    # --- @-rules ------------------------------------------------------------
    pytest.param("@namespace url(http://x); .foo { color: red }", id="at-namespace"),
    pytest.param("@layer base { .x { color: red } }", id="at-layer"),
    pytest.param("@scope (.x) { :scope { color: red } }", id="at-scope"),
    pytest.param("@container (min-width: 100px) { .x { color: red } }", id="at-container"),

    # --- forbidden pseudo-elements -----------------------------------------
    pytest.param(".x::column { color: red }", id="pseudo-column"),
    pytest.param(".x::scroll-marker { color: red }", id="pseudo-scroll-marker"),
    pytest.param(".x::part(foo) { color: red }", id="pseudo-part"),
    pytest.param(".x::slotted(b) { color: red }", id="pseudo-slotted"),
    pytest.param(".x::backdrop { color: red }", id="pseudo-backdrop"),
    pytest.param(".x::view-transition { color: red }", id="pseudo-view-transition"),

    # --- comma-bridge bypasses with Unicode whitespace + commas ------------
    pytest.param("\u00a0,* { color: red }", id="comma-nbsp-star"),
    pytest.param(".x,\u3000* { color: red }", id="comma-ideographic-star"),
    pytest.param(".x \uff0c :root { color: red }", id="comma-fullwidth-root"),

    # --- universal / html / body bare heads --------------------------------
    pytest.param("* { color: red }", id="bare-universal"),
    pytest.param("html { color: red }", id="bare-html"),
    pytest.param("body { color: red }", id="bare-body"),

    # --- url() with hex / entity-encoded bypasses --------------------------
    pytest.param(".x { background: \\75 rl(http://x) }", id="url-hex-u"),
    pytest.param(".x { background: u\\72 l(http://x) }", id="url-hex-r"),
    pytest.param(".x { background: &#117;rl(http://x) }", id="url-entity-u"),

    # --- broadening pseudos ------------------------------------------------
    pytest.param("body:has(div) { color: red }", id="has-pseudo"),
    pytest.param("*:is(.x) { color: red }", id="is-pseudo"),
    pytest.param(".x:where(:root) { color: red }", id="where-root-nested"),

    # --- HTML / script breakouts -------------------------------------------
    pytest.param(".x { color: red } </style><script>alert(1)</script> .y { color: blue }",
                 id="style-breakout"),
]


@pytest.mark.parametrize("css", HOSTILE)
def test_channel_css_rejects_hostile(css):
    with pytest.raises(ValueError):
        _sanitize_channel_css(css)


# ---------------------------------------------------------------------------
# Benign CSS — must round-trip and produce a non-empty result.
# ---------------------------------------------------------------------------

BENIGN = [
    # The existing sanitiser intentionally bans parens / `>` in
    # selectors — only space-separated descendant chains, classes, ids,
    # and basic attribute selectors are allowed. These cases mirror that
    # restriction so the test suite reflects real-world rules instead of
    # what would be theoretically valid CSS.
    ".my-thing { color: red }",
    "div.foo, span.bar { color: red; font-weight: bold }",
    "#messages-area .msg-content { color: #88ff88 }",
    "section[data-x] { padding: 4px }",  # data-x is NOT data-theme
    ".x .y .z { color: red }",
    ".x:hover { color: red }",
]


@pytest.mark.parametrize("css", BENIGN)
def test_channel_css_accepts_benign(css):
    out = _sanitize_channel_css(css)
    assert out, f"sanitizer dropped legitimate CSS: {css!r}"
    assert "{" in out and "}" in out


def test_channel_css_empty():
    assert _sanitize_channel_css("") == ""
    assert _sanitize_channel_css(None) == ""  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Private-channel gating in `_sanitize_channel_theme`.
# ---------------------------------------------------------------------------

def test_private_channel_rejects_bg_image():
    raw = '{"bgImage":"https://x.example/bg.png"}'
    with pytest.raises(ValueError, match="private"):
        _sanitize_channel_theme(raw, room_type="private")


def test_private_channel_rejects_css():
    raw = '{"css":".x { color: red }"}'
    with pytest.raises(ValueError, match="private"):
        _sanitize_channel_theme(raw, room_type="private")


def test_private_channel_accepts_colors():
    raw = '{"bg":"#101010","text":"#e0e0e0","accent":"#4caf50"}'
    out = _sanitize_channel_theme(raw, room_type="private")
    assert out and "#101010" in out


def test_public_channel_rewrites_external_bg_to_proxy():
    raw = '{"bgImage":"https://x.example/bg.png"}'
    out = _sanitize_channel_theme(raw, room_type="public")
    assert "/api/proxy/image?u=" in out
    # The raw URL is encoded so it can't be quietly extracted.
    assert "x.example" in out
    assert "https%3A" in out or "https%3a" in out


def test_public_channel_keeps_same_origin_bg():
    raw = '{"bgImage":"/api/rooms/foo/theme-bg?v=1"}'
    out = _sanitize_channel_theme(raw, room_type="public")
    assert "/api/rooms/foo/theme-bg" in out
    assert "/api/proxy/image" not in out
