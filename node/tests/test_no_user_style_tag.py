"""Acceptance tests for the scoped-stylesheet profile-CSS generator.

History: the original "Track B" hardening forbade emitting user CSS as a
`<style>` block at all, rendering only a flat declaration list via
`el.style.setProperty()`. That over-corrected — it gutted real profile
themes (gradients, `!important`, `:hover`, multi-element selectors, and the
app's own shipped presets all vanished). The current model restores a
`<style>` block, but one **generated** by the server's allowlist sanitiser
(`routers._css_inline.sanitize_inline_style`) from bytes the server wrote —
never raw user input — and injected client-side via `.textContent` after a
fixed-token scope substitution.

These tests pin the invariants that keep that safe:
  1. Nobody imports the long-deleted `routers._css_safety` module.
  2. No JS file stitches user-CSS data into `innerHTML`.
  3. The generator's output can never break out of a `<style>` element
     (no `<`, no `@`-rule, balanced braces) for a broad hostile corpus.
  4. The client injects via `.textContent` (not `.innerHTML`) and guards
     the payload before injecting.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from routers._css_inline import sanitize_inline_style  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
JS_DIR = REPO_ROOT / "static" / "js"
UI_JS = JS_DIR / "ui.js"


def _walk_python_files() -> list[Path]:
    out: list[Path] = []
    self_name = Path(__file__).name
    for root, dirs, files in os.walk(REPO_ROOT):
        parts = set(Path(root).relative_to(REPO_ROOT).parts)
        if parts & {"__pycache__", ".venv", "venv", "node_modules",
                    ".git", "build", "dist", "android", "ios",
                    "github-build-mirror", "secrets"}:
            continue
        for f in files:
            if not f.endswith(".py") or f == self_name:
                continue
            out.append(Path(root) / f)
    return out


def _walk_js_files() -> list[Path]:
    if not JS_DIR.is_dir():
        return []
    return [p for p in JS_DIR.iterdir() if p.suffix == ".js"]


# ──────────────────────────────────────────────────────────────────────
# 1. The removed _css_safety module stays removed.
# ──────────────────────────────────────────────────────────────────────

_FORBIDDEN_PY_IMPORTS = (
    "from routers._css_safety",
    "import routers._css_safety",
    "_css_safety.sanitize_scoped_css",
    "sanitize_scoped_css(",
)


def test_no_imports_of_removed_css_safety_module():
    offenders: list[tuple[str, int, str]] = []
    for path in _walk_python_files():
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            for tok in _FORBIDDEN_PY_IMPORTS:
                if tok in line:
                    offenders.append((str(path.relative_to(REPO_ROOT)), i, line.rstrip()))
                    break
    assert not offenders, (
        "Files still reference the removed _css_safety module:\n"
        + "\n".join(f"  {p}:{n}: {l}" for p, n, l in offenders)
    )


# ──────────────────────────────────────────────────────────────────────
# 2. No innerHTML stitched together with user-CSS data.
# ──────────────────────────────────────────────────────────────────────

_USER_CSS_TOKENS = ("custom_css", "custom_style", "customCss", "customStyle")


def test_no_innerhtml_with_user_css():
    offenders: list[tuple[str, int, str]] = []
    for path in _walk_js_files():
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = text.splitlines()
        for i, line in enumerate(lines):
            if "innerHTML" not in line:
                continue
            window = "\n".join(lines[i:i + 3]).lower()
            if "innerhtml" not in window:
                continue
            for tok in _USER_CSS_TOKENS:
                if tok.lower() in window:
                    offenders.append((path.name, i + 1, line.rstrip()))
                    break
    assert not offenders, (
        "innerHTML assignment near user-CSS data:\n"
        + "\n".join(f"  static/js/{p}:{n}: {l}" for p, n, l in offenders)
    )


# ──────────────────────────────────────────────────────────────────────
# 3. The generator can never break out of a <style> element.
# ──────────────────────────────────────────────────────────────────────

_BREAKOUT_CORPUS = [
    ".sp-nick { color: red } </style><script>alert(1)</script>",
    ".sp-nick { content: '</style>' }",
    ".sp-nick::before { content: '</style><script>x' }",
    ".sp-nick { color: red\\3c /style\\3e }",
    "</style><svg onload=alert(1)>",
    ".sp-banner { background: url(\"x\");}</style><script>y</script>{a:b }",
    "@import 'https://evil/x.css'; .sp-nick { color: red }",
    ".sp-nick { color: expression(alert(1)) }",
    "*{}</style >",
]


def test_generator_output_cannot_break_out_of_style():
    for src in _BREAKOUT_CORPUS:
        out = sanitize_inline_style(src)
        assert "<" not in out, f"'<' leaked from {src!r}: {out!r}"
        assert "@" not in out, f"'@' leaked from {src!r}: {out!r}"
        assert "\\" not in out, f"backslash leaked from {src!r}: {out!r}"
        assert "</style" not in out.lower()
        assert "<script" not in out.lower()
        assert out.count("{") == out.count("}"), f"unbalanced braces from {src!r}"


# ──────────────────────────────────────────────────────────────────────
# 4. The client injects via textContent and guards the payload.
# ──────────────────────────────────────────────────────────────────────

def test_client_injects_scoped_style_via_textcontent():
    assert UI_JS.is_file(), "ui.js missing"
    src = UI_JS.read_text(encoding="utf-8", errors="replace")
    # The scoped-style injector exists and uses the fixed scope token + a
    # safety guard, and binds the stylesheet via textContent.
    assert "_injectScopedStyle" in src
    assert "_scopedStyleIsSafe" in src
    assert "__FTSCOPE__" in src
    # Find the injector body and assert it uses textContent, not innerHTML.
    m = re.search(r"function _injectScopedStyle\(.*?\n}", src, re.DOTALL)
    assert m, "could not locate _injectScopedStyle body"
    body = m.group(0)
    assert "createElement('style')" in body or 'createElement("style")' in body
    assert ".textContent" in body
    assert ".innerHTML" not in body
    # The guard rejects the breakout/at-rule/escape characters.
    g = re.search(r"function _scopedStyleIsSafe\(.*?\n}", src, re.DOTALL)
    assert g, "could not locate _scopedStyleIsSafe body"
    assert "[<@\\\\]" in g.group(0)
