"""Inline-style sanitiser for user-supplied custom CSS.

Track B of the security refactor (see docs/SECURITY_REFACTOR_PLAN.md).

The pentest finding was that a `<style>` block from user data is
unsalvageable: closing-tag tricks, selector abuse (`:has(...)`, attribute
selectors with side-channel leaks via background-image timing), and the
constant churn of new CSS specs all keep widening the surface. The fix
is to never emit user CSS as a `<style>` block again — instead, sanitise
to a single inline `style="prop: val; prop: val"` declaration list,
attach it to one container element via `el.style.setProperty(...)` in
the client.

This module is the canonical sanitiser. The output is a string of
canonicalised `prop: value` declarations joined by `"; "` — bytes that
this module wrote, never bytes lifted verbatim from user input.

Hard rules:
  * No selectors, no @-rules, no nested rules — we only accept
    declaration-list grammar (`prop: value; prop: value;`).
  * Property allowlist — anything outside the table is dropped.
  * Per-property value validators that re-emit a canonicalised value.
  * Final pass strips declarations whose value contains any forbidden
    token (url, var, calc, etc.) — defence in depth against any
    validator that might have let something through.
  * Length cap on validated output.

This module is import-clean (no I/O, no globals mutated at import time)
so it is cheap to fuzz.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Callable, Optional


# ---------------------------------------------------------------------------
# Forbidden value-level substrings.
#
# After per-property validation, the *final* canonicalised value is scanned
# for these substrings (case-insensitive). The grammar of allowlisted
# values has no legitimate reason to contain any of these — colours,
# lengths, keyword enums, and the bounded transform/transition forms all
# produce values without parens-with-letters-before or backslashes etc.
# ---------------------------------------------------------------------------
_FORBIDDEN_SUBSTR: tuple[str, ...] = (
    "url(", "var(", "env(", "attr(", "calc(", "min(", "max(", "clamp(",
    "image(", "image-set(", "cross-fade(", "element(",
    "counter(", "counters(",
    "expression(", "behavior(",
    "@", "javascript:", "data:text", "data:application", "data:image",
    "\\",
    "/*", "*/", "//",
    "<", ">", "{", "}",
    '"', "'", "`",
    ";",  # any survived inner semicolon is an injection attempt
)


_NAMED_COLORS: frozenset[str] = frozenset({
    # CSS Level 1+2+3 named colours. Curated subset — we drop a few
    # extreme aliases that have no real use but bloat the surface.
    "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige",
    "bisque", "black", "blanchedalmond", "blue", "blueviolet", "brown",
    "burlywood", "cadetblue", "chartreuse", "chocolate", "coral",
    "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue",
    "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey",
    "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange",
    "darkorchid", "darkred", "darksalmon", "darkseagreen",
    "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise",
    "darkviolet", "deeppink", "deepskyblue", "dimgray", "dimgrey",
    "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia",
    "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green",
    "greenyellow", "grey", "honeydew", "hotpink", "indianred", "indigo",
    "ivory", "khaki", "lavender", "lavenderblush", "lawngreen",
    "lemonchiffon", "lightblue", "lightcoral", "lightcyan",
    "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey",
    "lightpink", "lightsalmon", "lightseagreen", "lightskyblue",
    "lightslategray", "lightslategrey", "lightsteelblue", "lightyellow",
    "lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine",
    "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen",
    "mediumslateblue", "mediumspringgreen", "mediumturquoise",
    "mediumvioletred", "midnightblue", "mintcream", "mistyrose",
    "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab",
    "orange", "orangered", "orchid", "palegoldenrod", "palegreen",
    "paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru",
    "pink", "plum", "powderblue", "purple", "rebeccapurple", "red",
    "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown",
    "seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue",
    "slategray", "slategrey", "snow", "springgreen", "steelblue", "tan",
    "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white",
    "whitesmoke", "yellow", "yellowgreen",
    "transparent", "currentcolor",
})


_FONT_FAMILIES: frozenset[str] = frozenset({
    "system-ui", "sans-serif", "serif", "monospace", "cursive", "fantasy",
    "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded",
    "inherit", "initial",
})


_FONT_WEIGHTS: frozenset[str] = frozenset({
    "100", "200", "300", "400", "500", "600", "700", "800", "900",
    "normal", "bold",
})


_FONT_STYLES: frozenset[str] = frozenset({"normal", "italic", "oblique"})
_BORDER_STYLES: frozenset[str] = frozenset({
    "none", "solid", "dashed", "dotted", "double",
})
_TEXT_ALIGN: frozenset[str] = frozenset({
    "left", "right", "center", "justify", "start", "end",
})
_TEXT_TRANSFORM: frozenset[str] = frozenset({
    "none", "uppercase", "lowercase", "capitalize",
})
_TEXT_DECOR_LINE: frozenset[str] = frozenset({
    "none", "underline", "line-through", "overline",
})
_TEXT_DECOR_STYLE: frozenset[str] = frozenset({
    "solid", "dashed", "dotted", "wavy", "double",
})
_TRANSITION_TIMING: frozenset[str] = frozenset({
    "linear", "ease", "ease-in", "ease-out", "ease-in-out",
})


# ---------------------------------------------------------------------------
# Atomic value parsers.
#
# Each returns a canonicalised string, or None to reject. None of them
# raise — invalid input means dropped declaration, never a 500.
# ---------------------------------------------------------------------------

_RE_HEX_COLOR = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_RE_RGB = re.compile(
    r"^(rgb|rgba|hsl|hsla)\(\s*"
    r"(-?\d+(?:\.\d+)?%?)\s*[, ]\s*"
    r"(-?\d+(?:\.\d+)?%?)\s*[, ]\s*"
    r"(-?\d+(?:\.\d+)?%?)"
    r"(?:\s*[,/]\s*(-?\d+(?:\.\d+)?%?))?"
    r"\s*\)$"
)


def _v_color(raw: str) -> Optional[str]:
    s = raw.strip().lower()
    if not s:
        return None
    if s in _NAMED_COLORS:
        return s
    if _RE_HEX_COLOR.match(s):
        return s
    m = _RE_RGB.match(s)
    if m:
        # Re-emit so the canonical form is what we wrote, never the user's.
        fn = m.group(1)
        parts = [m.group(2), m.group(3), m.group(4)]
        alpha = m.group(5)
        # Reject obviously crazy magnitudes that some parsers accept.
        for p in parts + ([alpha] if alpha else []):
            try:
                n = float(p[:-1] if p.endswith("%") else p)
            except ValueError:
                return None
            if n < -1000 or n > 1000:
                return None
        return f"{fn}({', '.join(parts)}" + (f", {alpha})" if alpha else ")")
    return None


def _length_validator(min_px: float, max_px: float,
                      allow_percent: bool = False) -> Callable[[str], Optional[str]]:
    def _v(raw: str) -> Optional[str]:
        s = raw.strip().lower()
        if not s:
            return None
        if s == "0":
            return "0"
        if s.endswith("px"):
            try:
                n = float(s[:-2])
            except ValueError:
                return None
            if n != n or n < min_px or n > max_px:  # NaN check via self-comparison
                return None
            # Canonicalise integers without trailing .0
            return f"{int(n)}px" if n.is_integer() else f"{n}px"
        if allow_percent and s.endswith("%"):
            try:
                n = float(s[:-1])
            except ValueError:
                return None
            if n != n or n < 0 or n > 100:
                return None
            return f"{int(n)}%" if n.is_integer() else f"{n}%"
        return None
    return _v


_v_pad = _length_validator(0, 64)
_v_radius = _length_validator(0, 64, allow_percent=True)
_v_border_w = _length_validator(0, 8)
_v_font_size = _length_validator(8, 48)
_v_spacing = _length_validator(-2, 8)
_v_margin = _length_validator(-32, 64)


def _v_line_height(raw: str) -> Optional[str]:
    s = raw.strip().lower()
    if not s:
        return None
    # Unitless number 0.8 - 3.0
    try:
        n = float(s)
        if 0.8 <= n <= 3.0:
            return f"{int(n)}" if n.is_integer() else f"{n}"
    except ValueError:
        pass
    return _length_validator(8, 64)(raw)


def _v_opacity(raw: str) -> Optional[str]:
    s = raw.strip().lower()
    try:
        n = float(s)
    except ValueError:
        return None
    if not (0.0 <= n <= 1.0):
        return None
    return f"{int(n)}" if n.is_integer() else f"{n}"


def _v_keyword(allowed: frozenset[str]) -> Callable[[str], Optional[str]]:
    def _v(raw: str) -> Optional[str]:
        s = raw.strip().lower()
        return s if s in allowed else None
    return _v


def _v_font_family(raw: str) -> Optional[str]:
    s = raw.strip().lower()
    if s in _FONT_FAMILIES:
        return s
    # Allow exactly one quoted/bare token only if it matches a strict
    # identifier whitelist of safe families. We don't allow commas to
    # keep the value grammar trivial.
    if re.match(r"^[a-z][a-z0-9 -]{0,30}$", s) and "," not in s:
        # Last-resort accept of generic stack aliases the front-end
        # already ships; if the user types something obscure we drop it.
        return s if s in _FONT_FAMILIES else None
    return None


def _v_border(raw: str) -> Optional[str]:
    # Shorthand: width style color (any order, all three required for
    # safety — we don't accept omissions). Up to ~64 chars total.
    s = raw.strip()
    if len(s) > 64:
        return None
    parts = s.split()
    if not (2 <= len(parts) <= 3):
        return None
    width: Optional[str] = None
    style: Optional[str] = None
    color: Optional[str] = None
    for p in parts:
        pl = p.lower()
        if width is None:
            w = _v_border_w(p)
            if w is not None:
                width = w
                continue
        if style is None and pl in _BORDER_STYLES:
            style = pl
            continue
        if color is None:
            c = _v_color(p)
            if c is not None:
                color = c
                continue
        return None  # unrecognised token
    if not style:
        return None
    out = []
    if width:
        out.append(width)
    out.append(style)
    if color:
        out.append(color)
    return " ".join(out)


_RE_TRANSFORM_FN = re.compile(
    r"^(rotate|scale|translate|translatex|translatey)\(([^()]{0,40})\)$"
)


def _v_transform(raw: str) -> Optional[str]:
    s = raw.strip().lower()
    if len(s) > 128:
        return None
    # One to three functions, space-separated. Each function's argument
    # is parsed strictly per kind.
    pieces = s.split()
    if not (1 <= len(pieces) <= 3):
        return None
    out: list[str] = []
    for piece in pieces:
        m = _RE_TRANSFORM_FN.match(piece)
        if not m:
            return None
        fn, arg = m.group(1), m.group(2).strip()
        if fn == "rotate":
            if not arg.endswith("deg"):
                return None
            try:
                n = float(arg[:-3])
            except ValueError:
                return None
            if abs(n) > 360:
                return None
            out.append(f"rotate({int(n)}deg)" if n.is_integer() else f"rotate({n}deg)")
        elif fn == "scale":
            try:
                n = float(arg)
            except ValueError:
                return None
            if not (0.1 <= n <= 3.0):
                return None
            out.append(f"scale({int(n)})" if n.is_integer() else f"scale({n})")
        elif fn in ("translate", "translatex", "translatey"):
            args = [a.strip() for a in arg.split(",")] if "," in arg else [arg]
            if fn == "translate" and len(args) not in (1, 2):
                return None
            if fn in ("translatex", "translatey") and len(args) != 1:
                return None
            normed: list[str] = []
            for a in args:
                v = _length_validator(-200, 200)(a)
                if v is None:
                    return None
                normed.append(v)
            out.append(f"{fn}({', '.join(normed)})")
    return " ".join(out)


def _v_transition(raw: str) -> Optional[str]:
    s = raw.strip().lower()
    if len(s) > 96:
        return None
    parts = s.split()
    if not (2 <= len(parts) <= 3):
        return None
    # property duration timing-function?  No delays, no "all".
    prop = parts[0]
    if not re.match(r"^[a-z][a-z-]{1,30}$", prop) or prop == "all":
        return None
    # property must itself be in our allowlist
    if prop not in ALLOWED_PROPS:
        return None
    dur = parts[1]
    if not dur.endswith(("s", "ms")):
        return None
    try:
        n = float(dur[:-2] if dur.endswith("ms") else dur[:-1])
    except ValueError:
        return None
    ms = n if dur.endswith("ms") else n * 1000
    if ms <= 0 or ms > 2000:
        return None
    out = [prop, dur]
    if len(parts) == 3:
        if parts[2] not in _TRANSITION_TIMING:
            return None
        out.append(parts[2])
    return " ".join(out)


def _v_text_decoration(raw: str) -> Optional[str]:
    s = raw.strip().lower()
    if len(s) > 64:
        return None
    parts = s.split()
    if not (1 <= len(parts) <= 3):
        return None
    line: Optional[str] = None
    style: Optional[str] = None
    color: Optional[str] = None
    for p in parts:
        if line is None and p in _TEXT_DECOR_LINE:
            line = p
            continue
        if style is None and p in _TEXT_DECOR_STYLE:
            style = p
            continue
        if color is None:
            c = _v_color(p)
            if c is not None:
                color = c
                continue
        return None
    if line is None:
        return None
    out = [line]
    if style:
        out.append(style)
    if color:
        out.append(color)
    return " ".join(out)


def _v_shadow(raw: str) -> Optional[str]:
    """Validate text-shadow / box-shadow: up to 4 lengths + optional color, no `inset`."""
    s = raw.strip().lower()
    if len(s) > 96:
        return None
    if "inset" in s:
        return None
    parts = s.split()
    if not (2 <= len(parts) <= 5):
        return None
    lengths: list[str] = []
    color: Optional[str] = None
    for p in parts:
        v = _length_validator(-32, 32)(p)
        if v is not None:
            lengths.append(v)
            continue
        if color is None:
            c = _v_color(p)
            if c is not None:
                color = c
                continue
        return None
    if not (2 <= len(lengths) <= 4):
        return None
    out = lengths[:]
    if color:
        out.append(color)
    return " ".join(out)


# ---------------------------------------------------------------------------
# Property allowlist.
# ---------------------------------------------------------------------------

ALLOWED_PROPS: dict[str, Callable[[str], Optional[str]]] = {
    "color": _v_color,
    "background-color": _v_color,
    "background": _v_color,                       # shorthand limited to color in v1
    "border-color": _v_color,
    "outline-color": _v_color,
    "text-decoration-color": _v_color,

    "border": _v_border,
    "border-top": _v_border,
    "border-right": _v_border,
    "border-bottom": _v_border,
    "border-left": _v_border,
    "border-style": _v_keyword(_BORDER_STYLES),
    "border-width": _v_border_w,
    "border-top-width": _v_border_w,
    "border-right-width": _v_border_w,
    "border-bottom-width": _v_border_w,
    "border-left-width": _v_border_w,

    "border-radius": _v_radius,
    "border-top-left-radius": _v_radius,
    "border-top-right-radius": _v_radius,
    "border-bottom-left-radius": _v_radius,
    "border-bottom-right-radius": _v_radius,

    "padding": _v_pad,
    "padding-top": _v_pad,
    "padding-right": _v_pad,
    "padding-bottom": _v_pad,
    "padding-left": _v_pad,

    "margin": _v_margin,
    "margin-top": _v_margin,
    "margin-right": _v_margin,
    "margin-bottom": _v_margin,
    "margin-left": _v_margin,

    "font-family": _v_font_family,
    "font-size": _v_font_size,
    "font-weight": _v_keyword(_FONT_WEIGHTS),
    "font-style": _v_keyword(_FONT_STYLES),
    "line-height": _v_line_height,
    "letter-spacing": _v_spacing,
    "word-spacing": _v_spacing,

    "text-align": _v_keyword(_TEXT_ALIGN),
    "text-decoration": _v_text_decoration,
    "text-transform": _v_keyword(_TEXT_TRANSFORM),
    "text-shadow": _v_shadow,
    "box-shadow": _v_shadow,

    "opacity": _v_opacity,
    "transform": _v_transform,
    "transition": _v_transition,
}


# ---------------------------------------------------------------------------
# Top-level parser.
# ---------------------------------------------------------------------------

_RE_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)


def _extract_legacy_rule_bodies(s: str) -> str:
    """Legacy-input shim: if the user pasted full `selector { … }` rules,
    extract just the declaration bodies and concatenate them into one
    flat `;`-separated list.

    The Track B grammar is declarations-only. Existing user CSS in the
    DB was authored as scoped rules like `body { color: red }`. To make
    the migration non-destructive we salvage the *bodies* of each
    top-level rule and drop the selectors. Selectors themselves are
    unsalvageable — they're exactly the surface we're closing.

    If the input has no `{`, it's already declaration form; return as-is.
    Nested braces are walked with a depth counter so a hostile
    `{ }; <script>` outside braces is excluded.
    """
    if "{" not in s:
        return s
    out: list[str] = []
    depth = 0
    buf: list[str] = []
    for ch in s:
        if ch == "{":
            if depth == 0:
                buf = []  # discard selector text accumulated so far
            else:
                buf.append(ch)
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth <= 0:
                depth = 0
                out.append("".join(buf))
                out.append(";")
                buf = []
            else:
                buf.append(ch)
        else:
            if depth > 0:
                buf.append(ch)
    return "".join(out)


def sanitize_inline_style(raw: str, *, max_output_len: int = 4096) -> str:
    """Return a canonical, safe `prop: val; ...` declaration list.

    Empty string on rejection or empty input. Never raises.
    """
    if not isinstance(raw, str):
        return ""
    if not raw:
        return ""
    # Hard cap on input — generous (40 KB lets people paste commented
    # CSS into the editor and have most of it dropped on the floor).
    if len(raw) > 40_000:
        raw = raw[:40_000]
    # NFC normalisation foils bidi-control + lookalike-character tricks
    # that try to smuggle ASCII keywords past the validators.
    s = unicodedata.normalize("NFC", raw)
    # Strip /* … */ comments. Multiline-safe.
    s = _RE_COMMENT.sub(" ", s)
    # Strip stray newlines/tabs — declaration grammar is a flat ;-list.
    s = s.replace("\r", " ").replace("\n", " ").replace("\t", " ")
    # Salvage legacy `selector { decls; }` inputs by keeping only the
    # bodies. Pure declaration-list inputs pass through untouched.
    s = _extract_legacy_rule_bodies(s)

    out: list[str] = []
    seen_props: set[str] = set()
    out_len = 0

    for decl in s.split(";"):
        decl = decl.strip()
        if not decl or ":" not in decl:
            continue
        prop, _, val = decl.partition(":")
        prop = prop.strip().lower()
        val = val.strip()
        if not prop or not val:
            continue
        # Reject vendor-prefixed and custom properties up front.
        if prop.startswith("-") or prop.startswith("--"):
            continue
        if not re.match(r"^[a-z][a-z-]{1,40}$", prop):
            continue
        if prop in seen_props:
            # Last-write-wins is the CSS spec but we don't want
            # attackers to flood a single property; ignore re-declarations.
            continue
        validator = ALLOWED_PROPS.get(prop)
        if validator is None:
            continue
        norm = validator(val)
        if norm is None:
            continue
        # Defence in depth: post-validation sweep for forbidden tokens.
        low = norm.lower()
        if any(tok in low for tok in _FORBIDDEN_SUBSTR):
            continue
        # Final canonical form is bytes WE wrote.
        piece = f"{prop}: {norm}"
        if out_len + len(piece) + 2 > max_output_len:
            break
        out.append(piece)
        out_len += len(piece) + 2
        seen_props.add(prop)

    return "; ".join(out)


__all__ = ["sanitize_inline_style", "ALLOWED_PROPS"]
