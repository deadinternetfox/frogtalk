"""Unit + fuzz tests for the scoped-stylesheet profile-CSS sanitiser.

This sanitiser (`routers._css_inline.sanitize_inline_style`) succeeds the
flat-declaration Track B model. It now parses full CSS, validates selectors
against a fixed profile allowlist, validates every property + value, and
re-emits a canonical stylesheet whose selectors are prefixed with the
literal ``__FTSCOPE__`` token (the client swaps it for a per-mount id).

Key policy differences from the old model (deliberate — see the module
docstring and the security note in the implementation plan):
  * `url()` is ALLOWED but rewritten: external http(s) → `/api/proxy/image`,
    same-origin paths pass through; data:/javascript:/protocol-relative are
    dropped.
  * `font-family` (allowlisted families), `content` (::before/::after), and
    gradients are ALLOWED.
  * `!important`, `:hover`, `::before`/`::after`, and multi-element
    selectors survive.

What must STILL be impossible: any output containing `<` (so a `</style>`
breakout can't happen), `@`-rules, escapes (`\\`), `expression(`,
`javascript:`, broadening/root selectors, attribute selectors, `*`/`body`,
or unbalanced braces.
"""

from __future__ import annotations

import os
import re
import sys

# Make `routers` importable when pytest is invoked from repo root or node/.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from routers._css_inline import sanitize_inline_style  # noqa: E402


NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _assert_structurally_safe(out: str, src: str = "") -> None:
    """Invariants the generator must hold for ANY input."""
    assert isinstance(out, str)
    low = out.lower()
    for bad in ("<", "@", "\\", "javascript:", "expression(", "behavior(",
                "</style", "<script", ":root", ":host", ":scope", ":target",
                ":has", ":is(", ":where(", "[data-theme", "[data-mode",
                "/*", "*/"):
        assert bad not in low, f"forbidden {bad!r} survived in {out!r} from {src!r}"
    assert out.count("{") == out.count("}"), f"unbalanced braces in {out!r}"


# ---------------------------------------------------------------------------
# Hostile inputs — must be neutralised (empty or scrubbed, never dangerous)
# ---------------------------------------------------------------------------

HOSTILE = [
    # Closing-style / HTML breakouts
    ".sp-nick { color: red } </style><script>alert(1)</script>",
    ".sp-nick { color: red\\3c /style\\3e }",
    ".sp-nick { color: red\\3c/style\\3e }",
    ".sp-nick { color: red /*</style>*/ }",
    "</style><script>alert(1)</script> .sp-nick { color: red }",
    # Value-level function abuses
    ".sp-nick { color: var(--x) }",
    ".sp-nick { width: calc(100% - 10px) }",
    ".sp-nick { color: expression(alert(1)) }",
    ".sp-nick { color: red; behavior: url(xss.htc) }",
    ".sp-nick { background: -moz-binding:url(http://evil/x.xml#xss) }",
    # url() that must be dropped (not rewritten)
    ".sp-banner { background-image: url('javascript:alert(1)') }",
    ".sp-banner { background-image: url(data:image/svg+xml;base64,PHN2Zw==) }",
    ".sp-banner { background-image: url(//evil.example/x.png) }",
    ".sp-banner { background: data:text/html,<script>alert(1)</script> }",
    # @-rule + selector smuggling
    "@import url(http://evil/x.css); .sp-nick { color: red }",
    ".sp-nick { color: red; @media all { color: green } }",
    "} body { background: red; ",
    "*:has(input) { color: red }",
    ":root { color: red }",
    "body { color: red }",
    "* { color: red }",
    "[data-theme] { color: red }",
    "#secret { color: red }",
    ".sp-nick > .x { color: red }",
    ".sp-nick + .y { color: red }",
    ".not-an-allowed-class { color: red }",
    # Unicode comma-bridge / hex-escape bypasses
    ".sp-nick ,* { color: red }",
    ".sp-nick { background: \\75 rl(http://evil/x) }",
    "\\:root { color: red }",
    # Vendor + custom props
    ".sp-nick { -webkit-filter: blur(5px) }",
    ".sp-nick { --evil: red; color: var(--evil) }",
    # Numbers out of bounds
    ".sp-nick { padding: 999999px }",
    ".sp-nick { opacity: 99 }",
    ".sp-nick { transform: scale(100) }",
    # Empty / malformed
    "", ":", ";", "color:", ":red", "color red", ".sp-nick {}",
    # Oversize input
    ".sp-nick { color: red }" * 5000,
]


def test_hostile_inputs_are_neutralised():
    for src in HOSTILE:
        out = sanitize_inline_style(src)
        _assert_structurally_safe(out, src)


def test_hostile_does_not_become_nonempty_garbage():
    # A pure-attack input with no salvageable rule must be empty.
    for src in [
        "*:has(input) { color: red }",
        ":root { color: red }",
        "[data-theme] { color: red }",
        "@import url(http://evil/x.css)",
        ".evil { color: red }",
    ]:
        assert sanitize_inline_style(src) == "", src


# ---------------------------------------------------------------------------
# Selector allowlist + scoping
# ---------------------------------------------------------------------------

def test_allowed_selectors_are_scoped():
    out = sanitize_inline_style(".sp-nick { color: red }")
    assert out == "__FTSCOPE__ .sp-nick { color: red }"


def test_pseudo_class_and_element_allowed():
    assert sanitize_inline_style(".wall-post:hover { color: red }") == \
        "__FTSCOPE__ .wall-post:hover { color: red }"
    out = sanitize_inline_style(".sp-nick::before { content: '> ' }")
    assert out == '__FTSCOPE__ .sp-nick::before { content: "> " }'


def test_container_class_folds_into_scope():
    # `.social-profile` is the scoped element itself, not a descendant.
    assert sanitize_inline_style(".social-profile { background: #000 }") == \
        "__FTSCOPE__ { background: #000 }"
    assert sanitize_inline_style(".social-profile .sp-tag { color: red }") == \
        "__FTSCOPE__ .sp-tag { color: red }"


def test_modal_classes_allowed():
    # The in-chat user-info modal classes are also in the allowlist so one
    # custom_style themes both surfaces.
    for sel in (".profile-header", ".userinfo-nick", ".profile-avatar-large"):
        out = sanitize_inline_style(f"{sel} {{ color: red }}")
        assert out == f"__FTSCOPE__ {sel} {{ color: red }}", out


def test_disallowed_selectors_dropped():
    for sel in (".unknown", "#id", "*", "body", "div", "[class]",
                ".sp-nick > .x", ".sp-nick + .y", ".sp-nick ~ .z",
                ".sp-nick:has(.x)", ".sp-nick:is(.y)"):
        assert sanitize_inline_style(f"{sel} {{ color: red }}") == "", sel


def test_comma_list_keeps_only_allowed_parts():
    out = sanitize_inline_style(".sp-nick, body, .sp-tag { color: red }")
    # body is dropped; the two allowed parts survive, each scoped.
    assert "__FTSCOPE__ .sp-nick" in out
    assert "__FTSCOPE__ .sp-tag" in out
    assert "body" not in out


# ---------------------------------------------------------------------------
# Value validators (new capabilities)
# ---------------------------------------------------------------------------

def test_important_preserved_once():
    out = sanitize_inline_style(".sp-nick { color: red !important }")
    assert out == "__FTSCOPE__ .sp-nick { color: red !important }"
    assert out.lower().count("!important") == 1


def test_gradient_validated_and_canonicalised():
    out = sanitize_inline_style(
        ".sp-banner { background: linear-gradient(135deg, #0a001a 0%, #1a0033 100%) }")
    assert "linear-gradient(135deg, #0a001a 0%, #1a0033 100%)" in out
    # Out-of-range angle / single stop / non-color stop → dropped.
    assert sanitize_inline_style(".sp-banner { background: linear-gradient(999deg, #000, #fff) }") == ""
    assert sanitize_inline_style(".sp-banner { background: linear-gradient(#000) }") == ""


def test_url_external_rewritten_to_proxy():
    out = sanitize_inline_style(".sp-banner { background-image: url(https://evil.test/x.png) }")
    assert 'url("/api/proxy/image?u=https%3A%2F%2Fevil.test%2Fx.png")' in out
    assert "evil.test" in out  # via the proxy, encoded
    # but no direct/raw scheme survives
    assert "https://evil" not in out


def test_url_same_origin_passthrough():
    out = sanitize_inline_style(".sp-banner { background-image: url(/api/rooms/foo/theme-bg) }")
    assert 'url("/api/rooms/foo/theme-bg")' in out


def test_url_dangerous_dropped():
    for v in ("url(data:image/png;base64,AAAA)", "url(javascript:alert(1))",
              "url(//evil.test/x.png)", "url('x\");}</style>')"):
        assert sanitize_inline_style(f".sp-banner {{ background-image: {v} }}") == "", v


def test_multi_shadow_and_inset():
    out = sanitize_inline_style(
        ".wall-post { box-shadow: 0 0 20px rgba(0,0,0,.5), inset 0 0 10px #000 }")
    assert "0 0 20px rgba(0, 0, 0, .5)" in out
    assert "inset 0 0 10px #000" in out
    # text-shadow must NOT accept inset
    assert sanitize_inline_style(".sp-nick { text-shadow: inset 1px 1px 2px #000 }") == ""


def test_font_family_allowlist():
    out = sanitize_inline_style(".sp-nick { font-family: 'Courier New', monospace }")
    assert out == '__FTSCOPE__ .sp-nick { font-family: "courier new", monospace }'
    assert sanitize_inline_style(".sp-nick { font-family: 'Evil Font' }") == ""


def test_content_canonical_quoting():
    assert sanitize_inline_style(".sp-nick::before { content: '~/users/' }") == \
        '__FTSCOPE__ .sp-nick::before { content: "~/users/" }'
    # dangerous content dropped
    assert sanitize_inline_style(".sp-nick::before { content: '</style>' }") == ""
    assert sanitize_inline_style('.sp-nick::before { content: "a@b" }') == ""


def test_color_rejects_garbage():
    assert sanitize_inline_style(".sp-nick { color: not-a-color }") == ""
    assert sanitize_inline_style(".sp-nick { color: #zzz }") == ""
    assert sanitize_inline_style(".sp-nick { color: rgb(9999, 0, 0) }") == ""


def test_lengths_units():
    assert "padding: 8px" in sanitize_inline_style(".sp-nick { padding: 8px }")
    assert sanitize_inline_style(".sp-nick { padding: 8vw }") == ""
    # font-size accepts em (the hacker preset uses 0.7em)
    assert "font-size: 0.7em" in sanitize_inline_style(".sp-nick { font-size: 0.7em }")


# ---------------------------------------------------------------------------
# Structural invariants
# ---------------------------------------------------------------------------

def test_duplicate_props_per_rule_first_wins():
    out = sanitize_inline_style(".sp-nick { color: red; color: green }")
    assert out.lower().count("color:") == 1
    assert "red" in out


def test_bare_declaration_list_wrapped():
    out = sanitize_inline_style("color: red; padding: 8px")
    assert out == "__FTSCOPE__.social-profile { color: red; padding: 8px }"


def test_idempotent_resanitisation():
    # Federation re-runs the sanitiser over already-scoped stylesheets.
    src = (".sp-nick:hover { color: #bf5af2 !important; "
           "text-shadow: 0 0 12px #bf5af2, 0 0 30px rgba(191,90,242,.4) !important } "
           ".sp-banner { background: linear-gradient(135deg, rgba(10,0,26,.9) 0%, #1a0033 100%) }")
    once = sanitize_inline_style(src)
    assert once
    assert sanitize_inline_style(once) == once


def test_output_length_cap_breaks_at_rule_boundary():
    src = " ".join(f".sp-tag {{ padding: {i % 9 + 1}px }}" for i in range(2000))
    out = sanitize_inline_style(src, max_output_len=300)
    assert len(out) <= 300
    _assert_structurally_safe(out, "len-cap")


def test_non_string_and_empty():
    assert sanitize_inline_style(None) == ""        # type: ignore[arg-type]
    assert sanitize_inline_style(b"color: red") == ""  # type: ignore[arg-type]
    assert sanitize_inline_style(123) == ""         # type: ignore[arg-type]
    assert sanitize_inline_style("") == ""
    assert sanitize_inline_style("   ") == ""
    assert sanitize_inline_style(";;;;") == ""


# ---------------------------------------------------------------------------
# Shipped presets must survive sanitisation (read live from ui.js so the
# test fails if a future allowlist change silently blanks a preset).
# ---------------------------------------------------------------------------

def _load_presets() -> dict[str, str]:
    path = os.path.join(NODE_DIR, "static", "js", "ui.js")
    js = open(path, encoding="utf-8").read()
    block = js[js.index("const CSS_PRESETS = {"):]
    block = block[:block.index("\n};") + 3]
    return dict(re.findall(r"(\w+):\s*`(.*?)`", block, re.DOTALL))


def test_all_shipped_presets_round_trip():
    presets = _load_presets()
    assert len(presets) >= 7, f"parsed only {list(presets)}"
    for name, css in presets.items():
        out = sanitize_inline_style(css)
        assert out, f"preset {name} sanitised to empty"
        _assert_structurally_safe(out, name)
        # signature: the social wall must be themed
        assert "__FTSCOPE__ .sp-banner" in out, name
        assert "__FTSCOPE__ .sp-nick" in out, name
        # idempotent
        assert sanitize_inline_style(out) == out, f"{name} not idempotent"


def test_hacker_preset_keeps_pseudo_content():
    out = sanitize_inline_style(_load_presets()["hacker"])
    assert 'content: "> "' in out
    assert 'content: "~/users/"' in out


# ---------------------------------------------------------------------------
# Fuzz — never raises, always returns str, never leaks `<`
# ---------------------------------------------------------------------------

def test_fuzz_never_raises():
    import random
    rnd = random.Random(1337)
    alphabet = list(
        "{}();:.#abcXYZ /\\*@<>\"'!important url( linear-gradient color "
        "background 0123456789%pxem,-  ，\\3c"
    )
    for _ in range(5000):
        n = rnd.randint(0, 90)
        s = "".join(rnd.choice(alphabet) for _ in range(n))
        out = sanitize_inline_style(s)
        assert isinstance(out, str)
        assert "<" not in out
        assert out.count("{") == out.count("}")
