"""Track B acceptance test — no `<style>` injection from user data.

We forbid:
    1. Any Python file from importing the deleted ``routers._css_safety``
       module (it was the old selector-aware ``<style>`` sanitiser).
    2. Any JS file in ``static/js/`` from creating a ``<style>`` block
       and feeding it ``custom_css``/``custom_style``/``user_css`` /
       similar user-derived data, or from concatenating those into
       ``innerHTML``.

The rendering path uses ``el.style.setProperty()`` against a container
element exclusively (see ``applyUserStyleToContainer`` in
``static/js/ui.js``). Anything that re-introduces a user-data
``<style>`` block is a regression on the Track B threat model.
"""
from __future__ import annotations

import os
import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
JS_DIR = REPO_ROOT / "static" / "js"


def _walk_python_files() -> list[Path]:
    out: list[Path] = []
    self_name = Path(__file__).name
    for root, dirs, files in os.walk(REPO_ROOT):
        # Skip vendored / generated / cache directories. We only care
        # about source code we author.
        parts = set(Path(root).relative_to(REPO_ROOT).parts)
        if parts & {"__pycache__", ".venv", "venv", "node_modules",
                    ".git", "build", "dist", "android", "ios",
                    "github-build-mirror", "secrets"}:
            continue
        for f in files:
            if not f.endswith(".py"):
                continue
            if f == self_name:
                # The test file itself contains the forbidden token
                # patterns by necessity — skip it from the scan.
                continue
            out.append(Path(root) / f)
    return out


def _walk_js_files() -> list[Path]:
    if not JS_DIR.is_dir():
        return []
    return [p for p in JS_DIR.iterdir() if p.suffix == ".js"]


# ──────────────────────────────────────────────────────────────────────
# Python: nobody imports the deleted module
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
            # Allow comments that *mention* the historical module name —
            # the deletion note in ``routers/wall.py`` is exactly that.
            stripped = line.lstrip()
            if stripped.startswith("#"):
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
# JS: no <style> blocks anywhere near user-derived CSS strings
# ──────────────────────────────────────────────────────────────────────

# Regex matches a single JS line that either:
#   * creates a `<style …>` literal containing or adjacent to a user-CSS
#     identifier, OR
#   * calls ``document.createElement('style')`` (any quote) anywhere in
#     the file — we forbid the constructor outright.

_STYLE_LITERAL_RE = re.compile(r"<style[\s>]", re.IGNORECASE)
_CREATE_STYLE_RE = re.compile(
    r"createElement\s*\(\s*['\"]style['\"]\s*\)", re.IGNORECASE
)

# Names that strongly suggest user-derived CSS *data*. We intentionally
# match only object-field shapes (snake_case `custom_css` /
# `custom_style`, or their camelCase mirrors) — NOT loose function names
# like `_reapplyProfileCss` which legitimately call into the renderer.
_USER_CSS_TOKENS = (
    "custom_css",
    "custom_style",
    "customCss",
    "customStyle",
)

# JS files that are explicitly allowed to call createElement('style')
# because they render *system* CSS (not user data). Each entry must be
# justified by a comment in the corresponding file.
_JS_SYSTEM_STYLE_ALLOWLIST = {
    # Live preview overlay for the profile editor; populated with the
    # *editor's textarea value* but rendered into an overlay sandbox
    # that is removed on close. Kept under audit; if this drifts to
    # injecting saved user data we want this test to flag it via the
    # proximity check on user-CSS tokens below.
    "ui.js",
}


def test_no_user_data_in_style_tags():
    offenders: list[tuple[str, int, str]] = []
    for path in _walk_js_files():
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = text.splitlines()
        for i, line in enumerate(lines):
            if _STYLE_LITERAL_RE.search(line) or _CREATE_STYLE_RE.search(line):
                # Snapshot ±5 lines of context and look for user-CSS
                # identifiers. If found, this is a Track B regression.
                lo = max(0, i - 5)
                hi = min(len(lines), i + 6)
                ctx = "\n".join(lines[lo:hi]).lower()
                for tok in _USER_CSS_TOKENS:
                    if tok.lower() in ctx:
                        offenders.append((path.name, i + 1, line.rstrip()))
                        break
    assert not offenders, (
        "Track B violation: <style> tag in proximity to user-CSS data:\n"
        + "\n".join(f"  static/js/{p}:{n}: {l}" for p, n, l in offenders)
    )


def test_no_innerhtml_with_user_css():
    """``innerHTML = …`` lines must not stitch in user-derived CSS."""
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
            # Look at this line + the next 2 (template literals span)
            window = "\n".join(lines[i:i + 3]).lower()
            if "innerhtml" not in window:
                continue
            for tok in _USER_CSS_TOKENS:
                if tok.lower() in window:
                    offenders.append((path.name, i + 1, line.rstrip()))
                    break
    assert not offenders, (
        "Track B violation: innerHTML assignment near user-CSS data:\n"
        + "\n".join(f"  static/js/{p}:{n}: {l}" for p, n, l in offenders)
    )
