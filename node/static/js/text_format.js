/**
 * Secure Discord-style bracket formatting for chat messages.
 * Allowed tags: [b], [i], [u], [s], [code] (and closing counterparts).
 * Input MUST be HTML-escaped before tag parsing; output is safe HTML spans.
 */
const TextFormat = (() => {
  const TAGS = {
    b: { open: 'strong', cls: 'fmt-b' },
    i: { open: 'em', cls: 'fmt-i' },
    u: { open: 'u', cls: 'fmt-u' },
    s: { open: 's', cls: 'fmt-s' },
    code: { open: 'code', cls: 'fmt-code' },
  };
  const OPEN_RE = /^\[(b|i|u|s|code)\]/i;
  const HAS_FMT_RE = /\[(?:\/)?(?:b|i|u|s|code)\]/i;
  const MAX_LEN = 10000;
  const MAX_DEPTH = 12;

  function _findClose(str, from, tag) {
    const close = `[/${tag}]`;
    const closeLower = close.toLowerCase();
    let depth = 1;
    let i = from;
    while (i < str.length) {
      const rest = str.slice(i);
      const nestedOpen = rest.match(OPEN_RE);
      if (nestedOpen && nestedOpen[1].toLowerCase() === tag) {
        depth += 1;
        i += nestedOpen[0].length;
        continue;
      }
      if (rest.toLowerCase().startsWith(closeLower)) {
        depth -= 1;
        if (depth === 0) return i;
        i += close.length;
        continue;
      }
      i += 1;
    }
    return -1;
  }

  function applyTags(escaped, depth) {
    if (!escaped) return '';
    if (depth > MAX_DEPTH) return escaped;
    let out = '';
    let i = 0;
    while (i < escaped.length) {
      const slice = escaped.slice(i);
      const m = slice.match(OPEN_RE);
      if (m) {
        const tag = m[1].toLowerCase();
        const spec = TAGS[tag];
        const innerStart = i + m[0].length;
        const innerEnd = _findClose(escaped, innerStart, tag);
        if (innerEnd === -1) {
          out += m[0];
          i += m[0].length;
          continue;
        }
        const inner = applyTags(escaped.slice(innerStart, innerEnd), depth + 1);
        out += `<${spec.open} class="${spec.cls}">${inner}</${spec.open}>`;
        i = innerEnd + closeLen(tag);
        continue;
      }
      const next = escaped.indexOf('[', i);
      if (next === -1) {
        out += escaped.slice(i);
        break;
      }
      out += escaped.slice(i, next);
      i = next;
    }
    return out;
  }

  function closeLen(tag) {
    return (`[/${tag}]`).length;
  }

  /** Format already-escaped HTML text with bracket tags. */
  function formatEscaped(escaped) {
    if (!escaped) return '';
    const s = String(escaped);
    if (s.length > MAX_LEN) return s;
    if (!s.includes('[') || !HAS_FMT_RE.test(s)) return s;
    return applyTags(s, 0);
  }

  /** Escape + format raw user text for display. */
  function formatRaw(raw, escFn) {
    if (!raw) return '';
    const esc = typeof escFn === 'function' ? escFn : (s) => String(s || '');
    return formatEscaped(esc(raw));
  }

  /** True when text may contain supported formatting tags. */
  function hasFormatting(raw) {
    if (!raw) return false;
    return HAS_FMT_RE.test(String(raw));
  }

  return { formatEscaped, formatRaw, hasFormatting, TAGS };
})();

try { if (typeof window !== 'undefined') window.TextFormat = TextFormat; } catch {}
