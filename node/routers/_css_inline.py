"""Scoped-stylesheet sanitiser for user-supplied custom profile CSS.

Successor to the Track B flat-declaration model (see
docs/SECURITY_REFACTOR_PLAN.md). The original pentest finding was that a
`<style>` block lifted *verbatim* from user data is unsalvageable:
closing-tag tricks, selector abuse (`:has(...)`, attribute selectors with
side-channel leaks), and the constant churn of new CSS specs keep widening
the surface. The earlier fix over-corrected — it flattened every selector
into a single declaration list applied to one container, which gutted real
profile themes (gradients, `!important`, `:hover`, multi-element selectors
all vanished, including the app's own shipped presets).

This module restores expressive, multi-element profile theming **without**
ever emitting user bytes verbatim. It parses the user's CSS, validates
every selector against a fixed allowlist of profile-internal classes
(rejecting `:has`/`:is`/`:where`, attribute selectors, `*`, and escaping
combinators), validates every property *and value* against per-property
validators, and re-emits a canonical stylesheet built **only from bytes
this module wrote**. Each rule's selector is prefixed with the literal
placeholder token ``__FTSCOPE__``; the client replaces that token with a
per-mount unique id via a trivial fixed-string replace (no client-side CSS
parsing).

Hard rules:
  * Selector allowlist — only the known `.sp-*` / `.wall-post` / `.sf-post`
    / `.social-profile` classes, with `:hover`/`:focus`/`:first-child`/
    `:last-child` and `::before`/`::after`. Descendant combinator only.
  * Property allowlist with per-property value validators that re-emit a
    canonicalised value. Quotes/parens appear in output ONLY where a
    validator (url / content / font-family / gradient / shadow) produced
    them.
  * `url()` is allowed but rewritten: external `http(s)` is routed through
    the SSRF-safe `/api/proxy/image` endpoint (no viewer-IP leak, even for
    federated CSS); same-origin paths pass through.
  * Two-tier forbidden-token defence: a per-value sweep for function names
    no validator emits, and a final whole-stylesheet sweep that bans `<`,
    `@`, `\\`, `expression(`, `javascript:`, `behavior(` and unbalanced
    braces. Since `<` is unreachable in output, a `</style>` breakout is
    structurally impossible.
  * Length cap on the assembled stylesheet (enforced at rule boundaries so
    a rule is never chopped mid-body into unbalanced braces).

The function is TOTAL — bad input becomes an empty stylesheet, never an
exception (callers don't 400 on CSS). It is import-clean (no FastAPI, no
I/O, no globals mutated at import time) so it is cheap to fuzz. The
selector-normalisation helpers are ported from the channel-theme sanitiser
(`routers.rooms._sanitize_channel_css`) — the proven, fuzzed engine — but
kept local so this module stays dependency-free.
"""

from __future__ import annotations

import html as _html
import re
import unicodedata
from typing import Callable, Optional
from urllib.parse import quote_plus


# ---------------------------------------------------------------------------
# Per-value forbidden substrings (tier 1).
#
# After per-property validation re-emits a canonical value, scan it for
# function names / tokens that no validator legitimately produces. Quotes,
# parens and commas are NOT banned here — validated url/content/font-family/
# gradient/shadow values contain them by construction.
# ---------------------------------------------------------------------------
_FORBIDDEN_VALUE_SUBSTR: tuple[str, ...] = (
    "var(", "env(", "attr(", "calc(", "min(", "max(", "clamp(",
    "image(", "image-set(", "cross-fade(", "element(",
    "counter(", "counters(",
    "expression(", "behavior(",
    "javascript:", "data:",
    "@", "\\", "/*", "*/", "//", "<",
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
    # Generic families + a small allowlist of common web-safe families.
    # Multiword families are quoted on re-emit. No commas in the names.
    "system-ui", "sans-serif", "serif", "monospace", "cursive", "fantasy",
    "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded",
    "inherit", "initial",
    "arial", "helvetica", "verdana", "tahoma", "geneva", "georgia",
    "garamond", "courier", "courier new", "consolas", "monaco", "menlo",
    "times", "times new roman", "trebuchet ms", "lucida console",
    "palatino", "impact", "comic sans ms", "segoe ui", "roboto",
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
# Number form accepts `12`, `12.5`, and `.5` (alpha without a leading zero,
# which is extremely common in real-world `rgba(...,.4)` values).
_RGB_NUM = r"-?(?:\d+(?:\.\d+)?|\.\d+)%?"
_RE_RGB = re.compile(
    r"^(rgb|rgba|hsl|hsla)\(\s*"
    rf"({_RGB_NUM})\s*[, ]\s*"
    rf"({_RGB_NUM})\s*[, ]\s*"
    rf"({_RGB_NUM})"
    rf"(?:\s*[,/]\s*({_RGB_NUM}))?"
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
_v_spacing = _length_validator(-2, 8)
_v_margin = _length_validator(-32, 64)


def _v_font_size(raw: str) -> Optional[str]:
    s = raw.strip().lower()
    if not s:
        return None
    if s.endswith("em"):
        try:
            n = float(s[:-2])
        except ValueError:
            return None
        if n != n or not (0.4 <= n <= 4.0):
            return None
        return f"{int(n)}em" if n.is_integer() else f"{n}em"
    return _length_validator(8, 48)(raw)


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


def _split_top_commas(s: str) -> list[str]:
    """Split on commas that are not nested inside parentheses, so
    `rgba(0,0,0,.5) 50%, #fff` splits into two items, not five."""
    out: list[str] = []
    depth = 0
    buf: list[str] = []
    for ch in s:
        if ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            if depth > 0:
                depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            out.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        out.append("".join(buf))
    return out


def _split_top_ws(s: str) -> list[str]:
    """Split on whitespace runs that are not nested inside parentheses, so
    a function with internal spaces — `rgba(0, 0, 0, .5)` — stays a single
    token. Critical for idempotency: validators re-emit canonical values
    WITH spaces, and re-sanitisation must re-parse them identically."""
    out: list[str] = []
    depth = 0
    buf: list[str] = []
    for ch in s:
        if ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            if depth > 0:
                depth -= 1
            buf.append(ch)
        elif ch.isspace() and depth == 0:
            if buf:
                out.append("".join(buf))
                buf = []
        else:
            buf.append(ch)
    if buf:
        out.append("".join(buf))
    return out


def _v_font_family(raw: str) -> Optional[str]:
    s = raw.strip().lower()
    if not s:
        return None
    tokens = _split_top_commas(s)
    if not (1 <= len(tokens) <= 4):
        return None
    out: list[str] = []
    for tok in tokens:
        t = tok.strip()
        if len(t) >= 2 and t[0] in "\"'" and t[-1] == t[0]:
            t = t[1:-1].strip()
        if t not in _FONT_FAMILIES:
            return None
        out.append(f'"{t}"' if " " in t else t)
    return ", ".join(out)


def _v_border(raw: str) -> Optional[str]:
    # Shorthand: width style color (any order, all three required for
    # safety — we don't accept omissions). Up to ~64 chars total.
    s = raw.strip()
    if len(s) > 64:
        return None
    parts = _split_top_ws(s)
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
    pieces = _split_top_ws(s)
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
    parts = _split_top_ws(s)
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


def _v_single_shadow(raw: str, allow_inset: bool) -> Optional[str]:
    """Validate ONE shadow: up to 4 lengths + optional color, optional
    leading/trailing `inset` (box-shadow only)."""
    s = raw.strip().lower()
    if not s or len(s) > 96:
        return None
    inset = False
    parts = _split_top_ws(s)
    if parts and parts[0] == "inset":
        if not allow_inset:
            return None
        inset = True
        parts = parts[1:]
    elif parts and parts[-1] == "inset":
        if not allow_inset:
            return None
        inset = True
        parts = parts[:-1]
    lengths: list[str] = []
    color: Optional[str] = None
    for p in parts:
        v = _length_validator(-64, 64)(p)
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
    out: list[str] = []
    if inset:
        out.append("inset")
    out.extend(lengths)
    if color:
        out.append(color)
    return " ".join(out)


def _v_shadow_list(allow_inset: bool) -> Callable[[str], Optional[str]]:
    """text-shadow / box-shadow: a comma-separated list of 1-4 shadows."""
    def _v(raw: str) -> Optional[str]:
        s = raw.strip()
        if len(s) > 300:
            return None
        shadows = [sh.strip() for sh in _split_top_commas(s) if sh.strip()]
        if not (1 <= len(shadows) <= 4):
            return None
        out: list[str] = []
        for sh in shadows:
            v = _v_single_shadow(sh, allow_inset)
            if v is None:
                return None
            out.append(v)
        return ", ".join(out)
    return _v


def _v_pos(raw: str) -> Optional[str]:
    """A gradient color-stop position: a percentage 0-100 or a bounded px."""
    s = raw.strip().lower()
    if not s:
        return None
    if s.endswith("%"):
        try:
            n = float(s[:-1])
        except ValueError:
            return None
        if not (0 <= n <= 100):
            return None
        return f"{int(n)}%" if n.is_integer() else f"{n}%"
    return _length_validator(-2000, 2000)(s)


def _v_color_stop(raw: str) -> Optional[str]:
    """`<color>` optionally followed by 1-2 positions."""
    parts = _split_top_ws(raw)
    if not parts:
        return None
    color = _v_color(parts[0])
    if color is None:
        return None
    if len(parts) > 3:
        return None
    out = [color]
    for pos in parts[1:]:
        v = _v_pos(pos)
        if v is None:
            return None
        out.append(v)
    return " ".join(out)


_RE_GRADIENT = re.compile(r"^(linear-gradient|radial-gradient)\((.*)\)$", re.DOTALL)
_RE_ANGLE = re.compile(r"^-?\d+(?:\.\d+)?deg$")
_RE_TO_DIR = re.compile(r"^to (top|bottom|left|right)(?: (left|right|top|bottom))?$")
_RE_RADIAL_CFG = re.compile(
    r"^(?:circle|ellipse)?\s*"
    r"(?:closest-side|closest-corner|farthest-side|farthest-corner)?\s*"
    r"(?:at [a-z0-9%. ]{1,30})?$"
)


def _v_gradient(raw: str) -> Optional[str]:
    s = raw.strip().lower()
    m = _RE_GRADIENT.match(s)
    if not m:
        return None
    kind = m.group(1)
    inner = m.group(2).strip()
    if not inner or len(inner) > 512:
        return None
    tokens = [t.strip() for t in _split_top_commas(inner) if t.strip()]
    if not tokens:
        return None
    head: Optional[str] = None
    stops_start = 0
    first = tokens[0]
    if kind == "linear-gradient":
        if _RE_ANGLE.match(first):
            try:
                n = float(first[:-3])
            except ValueError:
                return None
            if abs(n) > 360:
                return None
            head = f"{int(n)}deg" if n.is_integer() else f"{n}deg"
            stops_start = 1
        elif _RE_TO_DIR.match(first):
            head = first
            stops_start = 1
    else:  # radial-gradient
        if _v_color_stop(first) is None:
            if _RE_RADIAL_CFG.match(first) and first:
                head = first
                stops_start = 1
            else:
                return None
    stops = tokens[stops_start:]
    if not (2 <= len(stops) <= 8):
        return None
    out_stops: list[str] = []
    for st in stops:
        v = _v_color_stop(st)
        if v is None:
            return None
        out_stops.append(v)
    prefix = f"{head}, " if head else ""
    return f"{kind}({prefix}{', '.join(out_stops)})"


_RE_URL = re.compile(r"^url\(\s*(.*?)\s*\)$", re.IGNORECASE | re.DOTALL)
_RE_SAME_ORIGIN = re.compile(r"^/[A-Za-z0-9._\-/?=&%]+$")


def _v_url(raw: str) -> Optional[str]:
    """Allow background images, but only via safe references.

    External http(s) URLs are rewritten to flow through `/api/proxy/image`
    (SSRF-safe, rate-limited, re-encoded) so the viewer's browser never
    talks directly to the author's URL — this is the IP-leak / tracker
    control that makes federated (untrusted) profile CSS safe. Same-origin
    absolute paths pass through. Everything else (data:, javascript:,
    protocol-relative //, quotes/parens tricks) is rejected.
    """
    m = _RE_URL.match(raw.strip())
    if not m:
        return None
    inner = m.group(1).strip()
    if len(inner) >= 2 and inner[0] in "\"'" and inner[-1] == inner[0]:
        inner = inner[1:-1].strip()
    if not inner or len(inner) > 1024:
        return None
    # No chars that could break out of url(...) or smuggle another value.
    if re.search(r"[)\\\s'\"<>]", inner):
        return None
    if inner.startswith("//"):
        return None  # protocol-relative — would leak to an external host
    if re.match(r"^https?://", inner, re.IGNORECASE):
        return 'url("/api/proxy/image?u=' + quote_plus(inner) + '")'
    if _RE_SAME_ORIGIN.match(inner):
        return 'url("' + inner + '")'
    return None


def _v_background(raw: str) -> Optional[str]:
    """`background` / `background-image`: a single color, gradient, or url."""
    s = raw.strip()
    low = s.lower()
    if low.startswith(("linear-gradient", "radial-gradient")):
        return _v_gradient(s)
    if low.startswith("url("):
        return _v_url(s)
    return _v_color(s)


# `content` for ::before/::after. A canonical double-quoted string of safe
# ASCII chars (no `<`, `@`, `\`, braces, quotes, `;` — chars the sweeps ban
# or that could break grammar), or `none`.
_RE_CONTENT_INNER = re.compile(r"^[\w \-_>~/.:#!?]{0,32}$", re.ASCII)


def _v_content(raw: str) -> Optional[str]:
    s = raw.strip()
    if s.lower() == "none":
        return "none"
    if len(s) >= 2 and s[0] in "\"'" and s[-1] == s[0]:
        inner = s[1:-1]
        if _RE_CONTENT_INNER.match(inner):
            return '"' + inner + '"'
    return None


# ---------------------------------------------------------------------------
# Property allowlist.
# ---------------------------------------------------------------------------

ALLOWED_PROPS: dict[str, Callable[[str], Optional[str]]] = {
    "color": _v_color,
    "background-color": _v_color,
    "background": _v_background,                  # color | gradient | url
    "background-image": _v_background,            # gradient | url
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
    "text-shadow": _v_shadow_list(False),
    "box-shadow": _v_shadow_list(True),

    "content": _v_content,

    "opacity": _v_opacity,
    "transform": _v_transform,
    "transition": _v_transition,
}


# ---------------------------------------------------------------------------
# Selector normalisation + allowlist.
#
# Ported from routers.rooms._sanitize_channel_css — the fuzzed channel-theme
# engine — but kept local (this module must stay FastAPI-free) and made
# total (never raises) + stricter (positive class allowlist).
# ---------------------------------------------------------------------------

_UNICODE_WS_CLASS = r"\s   -   　᠎​‌‍﻿"
_UNICODE_COMMAS = (",", "，", "﹐", "،", "׃", "᠈")
_UNICODE_COMMA_RE = re.compile("|".join(re.escape(c) for c in _UNICODE_COMMAS))

_CSS_FORBIDDEN_PSEUDOS = (
    "::column", "::scroll-marker", "::scroll-marker-group",
    "::scroll-button", "::view-transition", "::view-transition-group",
    "::view-transition-image-pair", "::view-transition-old",
    "::view-transition-new", "::part", "::slotted", "::backdrop",
    "::-webkit-scrollbar", "::-webkit-resizer",
)

# The scope placeholder. The client replaces it with `#<unique-id>`. We
# emit it verbatim and recognise its lowercased form on re-sanitisation
# (federation re-runs this sanitiser over already-scoped stylesheets — it
# must be idempotent, not blank them).
_SCOPE_TOKEN = "__FTSCOPE__"
_SCOPE_TOKEN_LC = _SCOPE_TOKEN.lower()

# Profile-internal classes a theme may target. Stricter than channels
# (which allow any tag head) — profiles must not reach outside their card.
# Covers BOTH profile surfaces so one `custom_style` themes both:
#   * the social-profile wall card (`.social-profile` + `.sp-*`, plus the
#     wall post cards `.wall-post` / `.sf-post`), and
#   * the in-chat user-info modal (`.profile-header` / `.userinfo-nick` /
#     `.profile-avatar-large`, scoped to `#modal-user-info`).
_ALLOWED_PROFILE_CLASSES: frozenset[str] = frozenset({
    # social-profile wall
    "social-profile", "sp-banner", "sp-header", "sp-avatar", "sp-info",
    "sp-name-row", "sp-nick", "sp-handle-row", "sp-handle",
    "sp-actions-row", "sp-action-btn", "sp-share-btn", "sp-stats",
    "sp-stat", "sp-bio", "sp-mood", "sp-tags", "sp-tag", "sp-tabs",
    "sp-tab", "sp-posts", "wall-post", "sf-post",
    # in-chat user-info modal
    "profile-header", "userinfo-nick", "profile-avatar-large",
})

# A single compound: `.class` + optional one pseudo-class + optional one
# pseudo-element. No multi-class, no attribute selectors, no ids.
_COMPOUND_RE = re.compile(
    r"^\.([a-z][a-z0-9-]*)"
    r"(:hover|:focus|:first-child|:last-child)?"
    r"(::before|::after)?$"
)


def _normalize_css_for_check(s: str) -> str:
    """Decode CSS hex escapes + HTML entities, NFC-normalise, strip
    comments, and fold all whitespace away — for detection only."""
    out = unicodedata.normalize("NFC", s).lower()

    def _hx(m):
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
    out = re.sub(f"[{_UNICODE_WS_CLASS}]+", "", out)
    return out


def _normalize_selector(s: str) -> str:
    """Like `_normalize_css_for_check` but preserves ASCII spaces so the
    selector structure stays inspectable. Folds Unicode whitespace to a
    single ASCII space and Unicode commas to ASCII commas."""
    out = unicodedata.normalize("NFC", s)

    def _hx(m):
        try:
            cp = int(m.group(1), 16)
            return chr(cp) if cp < 0x110000 else ""
        except Exception:
            return ""

    out = re.sub(r"\\([0-9a-f]{1,6})\s?", _hx, out, flags=re.IGNORECASE)
    out = re.sub(r"\\(.)", r"\1", out)
    try:
        out = _html.unescape(out)
    except Exception:
        pass
    out = _UNICODE_COMMA_RE.sub(",", out)
    out = re.sub(f"[{_UNICODE_WS_CLASS}]+", " ", out).strip().lower()
    return out


def _validate_compound(comp: str) -> Optional[str]:
    """Validate ONE compound (`.class` + optional pseudos). Returns the
    canonical compound or None."""
    m = _COMPOUND_RE.match(comp)
    if not m:
        return None
    cls = m.group(1)
    if cls not in _ALLOWED_PROFILE_CLASSES:
        return None
    return "." + cls + (m.group(2) or "") + (m.group(3) or "")


def _scope_selector(part: str) -> Optional[str]:
    """Validate one comma-part of a normalised selector and return it with
    the scope token baked in, or None to drop it.

    `.social-profile` (and the `__FTSCOPE__` placeholder on re-sanitisation)
    fold INTO the scope token so the rule targets the container itself;
    other allowed classes are scoped as descendants (`__FTSCOPE__ .x`).
    """
    if not part:
        return None
    # Belt-and-braces stylesheet-wide rejections (also caught structurally
    # by the compound regex, but kept explicit and ordered like the channel
    # engine so escape/entity bypasses can't slip through).
    if re.search(r"[<>(){}\"'`\\;]", part):
        return None
    if re.search(r"[>+~]", part):
        return None  # only the descendant (space) combinator is allowed
    if re.search(r":(defined|is|where|has|not|matches|any)\b", part):
        return None
    if any(rp in part for rp in (":root", ":host", ":scope", ":target")):
        return None
    if "[" in part:
        return None
    for fp in _CSS_FORBIDDEN_PSEUDOS:
        if fp in part:
            return None

    compounds = [c for c in part.split(" ") if c]
    if not compounds or len(compounds) > 4:
        return None
    out: list[str] = []
    for idx, comp in enumerate(compounds):
        if idx == 0:
            # The scope placeholder (re-sanitisation of already-scoped CSS).
            if comp == _SCOPE_TOKEN_LC or comp.startswith(_SCOPE_TOKEN_LC + ":"):
                suffix = comp[len(_SCOPE_TOKEN_LC):]
                if suffix and not re.match(
                    r"^(:hover|:focus|:first-child|:last-child)?(::before|::after)?$",
                    suffix,
                ):
                    return None
                out.append(_SCOPE_TOKEN + suffix)
                continue
            canon = _validate_compound(comp)
            if canon is None:
                return None
            cm = _COMPOUND_RE.match(canon)
            cls = cm.group(1)
            suffix = (cm.group(2) or "") + (cm.group(3) or "")
            if cls == "social-profile":
                out.append(_SCOPE_TOKEN + suffix)
            else:
                out.append(_SCOPE_TOKEN)
                out.append(canon)
        else:
            canon = _validate_compound(comp)
            if canon is None:
                return None
            out.append(canon)
    return " ".join(out)


# ---------------------------------------------------------------------------
# Rule body + final assembly.
# ---------------------------------------------------------------------------

_RE_IMPORTANT = re.compile(r"!\s*important\s*$", re.IGNORECASE)
_RE_PROP = re.compile(r"^[a-z][a-z-]{1,40}$")


def _validate_rule_body(body: str) -> str:
    """Validate a `prop: val; ...` declaration body. Returns a canonical
    declaration list (first-write-wins per rule), or empty string."""
    out: list[str] = []
    seen: set[str] = set()
    for decl in body.split(";"):
        decl = decl.strip()
        if not decl or ":" not in decl:
            continue
        prop, _, val = decl.partition(":")
        prop = prop.strip().lower()
        val = val.strip()
        if not prop or not val:
            continue
        if prop.startswith("-"):          # vendor + custom props
            continue
        if not _RE_PROP.match(prop):
            continue
        if prop in seen:
            continue
        validator = ALLOWED_PROPS.get(prop)
        if validator is None:
            continue
        important = False
        m = _RE_IMPORTANT.search(val)
        if m:
            important = True
            val = val[:m.start()].strip()
            if not val:
                continue
        norm = validator(val)
        if norm is None:
            continue
        low = norm.lower()
        if any(tok in low for tok in _FORBIDDEN_VALUE_SUBSTR):
            continue
        if important:
            norm = norm + " !important"
        out.append(f"{prop}: {norm}")
        seen.add(prop)
    return "; ".join(out)


def _finalize(stylesheet: str) -> str:
    """Final whole-stylesheet sweep. Returns the stylesheet or "".

    Since selectors/properties/values are emitted from a fixed lowercase
    alphabet plus validator-produced quotes/parens/hex, `<`/`@`/`\\` are
    unreachable here — this is defence-in-depth. A hit blanks the whole
    stylesheet (total; never raises).
    """
    if not stylesheet:
        return ""
    norm = _normalize_css_for_check(stylesheet)
    for tok in ("<", "@", "\\", "expression(", "javascript:", "behavior("):
        if tok in norm:
            return ""
    if stylesheet.count("{") != stylesheet.count("}"):
        return ""
    return stylesheet


def sanitize_inline_style(raw: str, *, max_output_len: int = 16384) -> str:
    """Return a canonical, safe, scope-prefixed stylesheet string.

    Each rule's selector is prefixed with the literal ``__FTSCOPE__`` token
    for the client to replace with a per-mount id. Empty string on
    rejection or empty input. Never raises.
    """
    if not isinstance(raw, str) or not raw:
        return ""
    # Hard cap on input — generous (40 KB lets people paste commented CSS
    # into the editor and have most of it dropped on the floor).
    if len(raw) > 40_000:
        raw = raw[:40_000]
    css = unicodedata.normalize("NFC", raw)
    css = re.sub(r"/\*.*?\*/", " ", css, flags=re.DOTALL)
    css = css.replace("\r", " ").replace("\n", " ").replace("\t", " ")

    # No braces → a bare declaration list (legacy DB rows). Wrap it under a
    # default rule scoped to the container itself.
    if "{" not in css:
        body = _validate_rule_body(css)
        if not body:
            return ""
        rule = f"{_SCOPE_TOKEN}.social-profile {{ {body} }}"
        if len(rule) > max_output_len:
            return ""
        return _finalize(rule)

    out_rules: list[str] = []
    out_len = 0
    for chunk in css.split("}"):
        i = chunk.find("{")
        if i == -1:
            continue  # stray text outside a rule — ignore (total, no raise)
        sel_raw = chunk[:i].strip()
        body_raw = chunk[i + 1:].strip()
        if not sel_raw or not body_raw:
            continue
        if sel_raw.startswith("@") or "{" in body_raw:
            continue
        if re.search(r"[<>(){}\"'`\\;]", sel_raw):
            continue
        sel_norm = _normalize_selector(sel_raw)
        good: list[str] = []
        for part in sel_norm.split(","):
            scoped = _scope_selector(part.strip())
            if scoped:
                good.append(scoped)
        if not good:
            continue
        body = _validate_rule_body(body_raw)
        if not body:
            continue
        rule = ", ".join(good) + " { " + body + " }"
        if out_len + len(rule) + 1 > max_output_len:
            break
        out_rules.append(rule)
        out_len += len(rule) + 1

    return _finalize("\n".join(out_rules))


__all__ = ["sanitize_inline_style", "ALLOWED_PROPS"]
