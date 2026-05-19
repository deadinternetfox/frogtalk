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
  const MAX_DEPTH = 12;

  function _findClose(str, from, tag) {
    const close = `[/${tag}]`;
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
      if (rest.toLowerCase().startsWith(close)) {
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
        i = innerEnd + (`[/${tag}]`).length;
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

  /** Format already-escaped HTML text with bracket tags. */
  function formatEscaped(escaped) {
    if (!escaped) return '';
    return applyTags(String(escaped), 0);
  }

  /** Escape + format raw user text for display. */
  function formatRaw(raw, escFn) {
    if (!raw) return '';
    const esc = typeof escFn === 'function' ? escFn : (s) => String(s || '');
    return formatEscaped(esc(raw));
  }

  return { formatEscaped, formatRaw, TAGS };
})();

try { if (typeof window !== 'undefined') window.TextFormat = TextFormat; } catch {}
