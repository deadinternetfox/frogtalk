"""Fuzz + unit tests for the inline-style sanitiser (Track B)."""

from __future__ import annotations

import sys
import os

# Make `routers` importable when pytest is invoked from repo root.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from routers._css_inline import sanitize_inline_style  # noqa: E402


# ---------------------------------------------------------------------------
# Hostile inputs that must produce empty / property-stripped output
# ---------------------------------------------------------------------------

HOSTILE = [
    # Closing-style escapes
    "color: red</style><script>alert(1)</script>",
    "color: red\\3c /style\\3e",
    "color: red\\3c/style\\3e",
    "color: red /*</style>*/",
    # Substring grammar abuses
    "background: url(http://evil.example/x.png)",
    "background-image: url('javascript:alert(1)')",
    "color: var(--x)",
    "width: calc(100% - 10px)",
    "color: red; behavior:url(xss.htc)",
    "background: -moz-binding:url(http://evil/x.xml#xss)",
    "color: expression(alert(1))",
    # @-rule + selector smuggling
    "@import url(http://evil/x.css)",
    "color: red; @media all { color: green }",
    "} body { background: red; ",
    "*:has(input) { color: red }",
    # Quoted values (we don't allow any quoted token)
    'font-family: "Arial"',
    "content: 'pwn'",
    # Data URIs
    "background-image: url(data:image/svg+xml;base64,PHN2Zw==)",
    "background: data:text/html,<script>alert(1)</script>",
    # Unicode bidi/lookalike
    "color: red\u202e; background: blue",
    # Hex escapes
    "color\\3a red",
    "color: re\\64",
    # Vendor + custom props
    "-webkit-filter: blur(5px)",
    "--evil: red; color: var(--evil)",
    # Numbers out of bounds
    "padding: 999999px",
    "opacity: 99",
    "transform: scale(100)",
    # Empty / malformed
    "",
    ":",
    ";",
    "color:",
    ":red",
    "color red",
    # Oversize input
    "color: red;" * 5000,
    # Mixed legit + hostile — legit pieces should survive, hostile dropped
    # (asserted separately below).
]


def test_hostile_inputs_drop_dangerous_tokens():
    for src in HOSTILE:
        out = sanitize_inline_style(src)
        low = out.lower()
        # No declaration in output may contain any of these strings.
        for bad in (
            "<", ">", "url(", "var(", "calc(", "expression(", "@",
            "javascript:", "data:", "</style", "\\", "{", "}", '"', "'",
            "behavior", "binding", "/*", "*/",
        ):
            assert bad not in low, f"forbidden {bad!r} survived in {out!r} from {src!r}"


def test_mixed_legit_and_hostile_keeps_legit_drops_hostile():
    src = "color: #ff0000; background: url(x); padding: 8px; --evil: red"
    out = sanitize_inline_style(src)
    assert "color: #ff0000" in out
    assert "padding: 8px" in out
    assert "url" not in out
    assert "--" not in out


# ---------------------------------------------------------------------------
# Per-property validators — accept good values, reject bad ones
# ---------------------------------------------------------------------------

def test_color_accepts_named_hex_rgb():
    assert sanitize_inline_style("color: red") == "color: red"
    assert sanitize_inline_style("color: #abc") == "color: #abc"
    assert sanitize_inline_style("color: #aabbcc") == "color: #aabbcc"
    assert sanitize_inline_style("color: rgb(10, 20, 30)").startswith("color: rgb(")
    assert sanitize_inline_style("color: rgba(10, 20, 30, 0.5)").startswith("color: rgba(")


def test_color_rejects_garbage():
    assert sanitize_inline_style("color: not-a-color") == ""
    assert sanitize_inline_style("color: #zzz") == ""
    assert sanitize_inline_style("color: rgb(9999, 0, 0)") == ""


def test_lengths_accept_px_reject_unknown_units():
    assert sanitize_inline_style("padding: 8px") == "padding: 8px"
    assert sanitize_inline_style("padding: 0") == "padding: 0"
    assert sanitize_inline_style("padding: 8em") == ""
    assert sanitize_inline_style("padding: 8vw") == ""
    assert sanitize_inline_style("padding: 8") == ""


def test_font_weight_keyword_set():
    assert sanitize_inline_style("font-weight: 700") == "font-weight: 700"
    assert sanitize_inline_style("font-weight: bold") == "font-weight: bold"
    assert sanitize_inline_style("font-weight: bolder") == ""


def test_transform_only_known_functions():
    assert sanitize_inline_style("transform: rotate(45deg)") == "transform: rotate(45deg)"
    assert sanitize_inline_style("transform: scale(1.2)") == "transform: scale(1.2)"
    assert sanitize_inline_style("transform: matrix(1,0,0,1,0,0)") == ""
    assert sanitize_inline_style("transform: rotate(9999deg)") == ""


def test_transition_requires_allowed_property():
    out = sanitize_inline_style("transition: color 200ms ease")
    assert out == "transition: color 200ms ease"
    # `all` is forbidden — too broad, can be abused for side-channels.
    assert sanitize_inline_style("transition: all 200ms ease") == ""
    # Unallowed property name
    assert sanitize_inline_style("transition: position 200ms") == ""
    # Out-of-range duration
    assert sanitize_inline_style("transition: color 5s") == ""


def test_border_shorthand_requires_style():
    assert sanitize_inline_style("border: 1px solid red") == "border: 1px solid red"
    assert sanitize_inline_style("border: 1px red") == ""  # missing style
    assert sanitize_inline_style("border: solid red") == "border: solid red"


def test_text_shadow_rejects_inset_and_url():
    assert sanitize_inline_style("text-shadow: 1px 1px 2px #000").startswith("text-shadow: 1px 1px 2px")
    assert sanitize_inline_style("text-shadow: inset 1px 1px 2px #000") == ""
    assert sanitize_inline_style("text-shadow: 1px 1px url(x)") == ""


def test_opacity_range():
    assert sanitize_inline_style("opacity: 0.5") == "opacity: 0.5"
    assert sanitize_inline_style("opacity: 1") == "opacity: 1"
    assert sanitize_inline_style("opacity: 2") == ""
    assert sanitize_inline_style("opacity: -0.1") == ""


# ---------------------------------------------------------------------------
# Structural invariants
# ---------------------------------------------------------------------------

def test_duplicate_props_kept_only_once():
    out = sanitize_inline_style("color: red; color: green; color: blue")
    assert out.count("color:") == 1
    assert "red" in out  # first wins


def test_output_length_cap():
    src = "; ".join(f"padding: {i % 10}px" for i in range(2000))
    out = sanitize_inline_style(src, max_output_len=200)
    assert len(out) <= 200
    # Cap doesn't break grammar
    assert ";" not in out or all(":" in chunk for chunk in out.split("; "))


def test_non_string_returns_empty():
    assert sanitize_inline_style(None) == ""  # type: ignore[arg-type]
    assert sanitize_inline_style(b"color: red") == ""  # type: ignore[arg-type]
    assert sanitize_inline_style(123) == ""  # type: ignore[arg-type]


def test_empty_returns_empty():
    assert sanitize_inline_style("") == ""
    assert sanitize_inline_style("   ") == ""
    assert sanitize_inline_style(";;;;") == ""


def test_output_never_contains_semicolon_inside_value():
    # Every "; " in the output separates declarations; no value may
    # itself contain a semicolon.
    out = sanitize_inline_style("color: red; padding: 8px; font-size: 14px")
    pieces = out.split("; ")
    for p in pieces:
        # Each piece is "prop: value" with exactly one ':'
        assert p.count(":") == 1
        # Value has no inner semicolons (would be caught by _FORBIDDEN_SUBSTR
        # but assert end-to-end too).
        prop, val = p.split(":", 1)
        assert ";" not in val
