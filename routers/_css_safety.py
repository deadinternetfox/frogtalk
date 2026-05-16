"""Shared user-CSS sanitiser.

Channel themes (routers/rooms.py), profile custom CSS
(routers/wall.py update_wall_settings), and federated profile imports
(routers/federation.py) all accept user-supplied CSS that we later scope
to a container and inject as <style>. They all share the same exploit
surface:

  *   ``,*`` at the start of a selector turns ``#scope ,*`` into a
      two-element selector list whose second element matches *every*
      element, breaking the scope wrapper.
  *   ``position: fixed`` / ``position: sticky`` in the rule body lets
      scoped descendants overlay the entire viewport.
  *   ``url(...)``, ``@import``, ``@font-face``, ``expression(...)`` and
      ``behavior:`` can fetch / execute remote payloads.
  *   ``\\6a avascript:``, ``&#106;avascript:`` etc. are the same things
      with hex / entity encodings.
  *   ``</style`` closes our inline <style> early and drops back into
      HTML mode.

Use ``sanitize_scoped_css(raw)`` from each call site and treat a
ValueError as a 400. The returned string is rebuilt rule-by-rule from
trusted parts.
"""
from __future__ import annotations

import html as _html
import re

_CSS_DANGEROUS_TOKENS = (
    "javascript:", "expression(", "url(", "@import", "@charset",
    "@font-face", "@keyframes", "@supports", "@media",
    "behavior:", "-moz-binding", "</style", "<script", "\\",
    "position:fixed", "position:sticky",
)
_BARE_SELECTORS = {"*", ":root", "html", "body", ":host", ":where(*)"}


def _normalize_css_for_check(s: str) -> str:
    out = s.lower()

    def _hx(m: "re.Match[str]") -> str:
        try:
            cp = int(m.group(1), 16)
            return chr(cp) if cp < 0x110000 else ""
        except Exception:
            return ""

    out = re.sub(r"\\([0-9a-f]{1,6})\s?", _hx, out)
    out = re.sub(r"\\(.)", r"\1", out)
    try:
        out = _html.unescape(out)
    except Exception:
        pass
    out = re.sub(r"/\*.*?\*/", "", out, flags=re.DOTALL)
    out = re.sub(r"\s+", "", out)
    return out


def sanitize_scoped_css(raw: str | None, max_len: int = 10_240) -> str:
    """Return safe CSS, or raise ValueError. Empty / None -> ''.

    Scoping is applied later at render time by the caller (the JS scoper
    in static/js/state.js for profile CSS, or a server-side prefix for
    channel themes). This function's job is to guarantee the body is
    structurally sound so the scoping wrapper can't be broken out of.
    """
    if not raw:
        return ""
    css = str(raw)[:max_len]
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
    normalized_full = _normalize_css_for_check(css)
    for tok in _CSS_DANGEROUS_TOKENS:
        if tok in normalized_full:
            raise ValueError(f"CSS contains forbidden token: {tok}")
    if css.count("{") != css.count("}"):
        raise ValueError("CSS braces are unbalanced")
    out_rules: list[str] = []
    for chunk in css.split("}"):
        i = chunk.find("{")
        if i == -1:
            if chunk.strip():
                raise ValueError("CSS contains stray text outside a rule")
            continue
        sel_raw = chunk[:i].strip()
        body_raw = chunk[i + 1:].strip()
        if not sel_raw or not body_raw:
            continue
        if sel_raw.startswith("@") or "{" in body_raw:
            raise ValueError("CSS @-rules and nested rules are not allowed")
        if re.search(r"[<>(){}\"'`\\;]", sel_raw):
            raise ValueError("CSS selector contains forbidden characters")
        parts = [p.strip() for p in sel_raw.split(",")]
        if any(not p for p in parts):
            raise ValueError("CSS selector list has empty part (leading/trailing comma?)")
        for p in parts:
            head = re.split(r"[\s>+~]", p, maxsplit=1)[0].lower()
            if head in _BARE_SELECTORS:
                raise ValueError(f"CSS selector '{p}' is too broad")
        body_norm = _normalize_css_for_check(body_raw)
        for tok in _CSS_DANGEROUS_TOKENS:
            if tok in body_norm:
                raise ValueError(f"CSS rule body contains forbidden token: {tok}")
        out_rules.append(f"{', '.join(parts)} {{ {body_raw} }}")
    return "\n".join(out_rules)
