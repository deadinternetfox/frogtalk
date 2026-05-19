/**
 * state.js — Shared application state
 */

const State = {
  token: null,
  user: null,          // { id, nickname, avatar, bio, is_admin }
  currentRoom: null,    // room name string
  currentRoomType: 'public', // 'public' | 'private' | 'dm'
  currentRoomOwner: null, // nickname of room owner (for permission checks)
  currentRoomMods: [],  // list of moderator nicknames for the current room
  rooms: [],            // list of room objects from server
  _showAllChannels: false, // toggle to show unjoined channels
  messages: {},         // roomName -> [msg, ...]
  onlineUsers: [],      // current room online users
  dmPeer: null,         // nickname of DM peer if in DM
  roomKeys: {},         // roomName -> CryptoKey
  bridgeOut: {},        // roomName -> bool (has active outbound bridge)
  pendingAttachment: null, // { dataUrl, type }
  isLoadingHistory: false,
  oldestMsgId: null,
  typingTimeout: null,
  blockedNicks: new Set(), // lowercased nicknames the viewer has blocked

  save() {
    if (this.token) localStorage.setItem('fc_token', this.token);
    if (this.user) localStorage.setItem('fc_user', JSON.stringify(this.user));
  },

  load() {
    this.token = localStorage.getItem('fc_token');
    try { this.user = JSON.parse(localStorage.getItem('fc_user')); } catch { this.user = null; }
  },

  clear() {
    try { if (typeof _dmPtCacheFlush === 'function') _dmPtCacheFlush(); } catch {}
    try { if (window.Pin && typeof Pin.reset === 'function') Pin.reset(); } catch {}
    localStorage.removeItem('fc_token');
    localStorage.removeItem('fc_user');
    localStorage.removeItem('fc_last_room');
    this.token = null;
    this.user = null;
  }
};

/* ── Compatibility shims for new modules (friends.js, dms.js, calls.js, media.js) ── */

// STATE alias → State (new modules use STATE, old use State)
// We use a Proxy so both names share the same object
const STATE = State;

// wsSend → WS.send (WS is defined after state.js loads)
function wsSend (obj) {
  if (typeof WS !== 'undefined') WS.send(obj);
}

// toast() → UI.showToast() with optional stack-based toasts div
// Signature: toast(text, type='info', ms=3000)
//   - or:    toast(text, type, ms, onClickFn)
//   - or:    toast(text, { type, ms, onClick })
function toast (text, type = 'info', ms = 3000, onClick) {
  // Allow options-object form: toast(text, { type, ms, onClick })
  if (type && typeof type === 'object') {
    onClick = type.onClick;
    ms = type.ms || 3000;
    type = type.type || 'info';
  }
  const stack = document.getElementById('toasts');
  if (stack) {
    const el = document.createElement('div');
    const kind = ['error', 'success', 'warn', 'info'].includes(type) ? type : 'info';
    el.className = `toast toast-${kind}`;
    el.style.cssText = `max-width:320px;cursor:pointer;animation:fadeInRight .2s ease`;
    const icons = { error: '⚠️', success: '✓', info: 'ℹ️', warn: '⚠️' };
    el.innerHTML = `
      <span class="toast-icon">${icons[kind] || icons.info}</span>
      <span class="toast-text"></span>
    `;
    el.querySelector('.toast-text').textContent = String(text ?? '');
    el.onclick = () => {
      try { if (typeof onClick === 'function') onClick(); } catch {}
      el.remove();
    };
    stack.appendChild(el);
    setTimeout(() => el.remove(), ms);
  } else if (typeof UI !== 'undefined') {
    UI.showToast(text, type, ms, onClick);
  }
}

// esc() → UI.escHtml() — HTML-escape helper. SAFE ONLY for HTML text
// nodes and HTML attribute *values* (between the quotes). NOT safe for
// inline-event-handler JS string contexts like
//     onclick="foo('${esc(x)}')"
// because the HTML parser decodes &#39; back to ' BEFORE the value is
// handed to the JS engine, so x can break out of the JS string and
// inject arbitrary JS. For JS-string-in-HTML-attr contexts use jsStr()
// (defined below) which produces a properly JSON-quoted JS literal with
// embedded " escaped as &quot; so attribute parsing stays intact.
function esc (s) {
  if (typeof UI !== 'undefined') return UI.escHtml(String(s ?? ''));
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// jsStr() — produce a JS string literal (including the outer quotes) safe
// to embed inside an HTML attribute. Used for inline event handlers:
//     onclick="foo(${jsStr(x)})"
// JSON.stringify gives us a valid JS literal that escapes " \ control
// chars and high-bit chars; we then HTML-escape the resulting outer " to
// &quot; so the HTML attribute parser doesn't terminate early. Drop the
// surrounding ' ... ' you'd normally put around an esc() call.
function jsStr (s) {
  return JSON.stringify(String(s ?? '')).replace(/"/g, '&quot;');
}

// ── Css.sanitizeScopedCss ───────────────────────────────────────────────────
// Single source of truth for "user-supplied CSS, scoped to a container".
// Used by channel themes, profile custom CSS, social profile custom CSS,
// and the live CSS preview pane. Every scoper used to roll its own
// `selectors.split(',').map(s => `${scope} ${s}`)` which was exploitable:
//
//   1. A leading comma like `,*` produced [\"\", \"*\"]; filter(Boolean)
//      dropped the empty, leaving a plain `${scope} *` which then matched
//      every descendant — enough for a fullscreen overlay attack inside
//      the scope.
//   2. `position:fixed` in the rule body escapes the scope visually,
//      letting an attacker overlay the whole viewport from inside any
//      scoped element.
//   3. `@import`, `url(`, `expression(`, `behavior:`, `javascript:` and
//      their hex/entity-encoded variants could fetch / execute remote
//      payloads.
//   4. `</style>` inside the body could end the inline <style> early and
//      drop into HTML mode (rare in practice because we use textContent,
//      but cheap to guard).
//
// Returns the safe, scoped CSS string. Logs (console.warn) and drops any
// rule that fails validation; never throws.
const Css = (() => {
  const DANGEROUS_TOKENS = [
    'javascript:', 'expression(', 'url(', '@import', '@charset',
    '@font-face', '@keyframes', '@supports', '@media',
    'behavior:', '-moz-binding', '</style', '<script', '\\',
    'position:fixed', 'position:sticky',
  ];
  const BARE_TAG_HEADS = new Set(['*', 'html', 'body']);
  const ROOT_PSEUDO_PREFIXES = [':root', ':host', ':scope', ':target'];
  // :defined / :is / :where / :has / :not / :matches / :any can broaden
  // a match to elements the attacker doesn't otherwise have grounds to
  // touch — reject them anywhere in the first compound selector.
  const BROADENING_PSEUDO_RE = /:(defined|is|where|has|not|matches|any)\b/;

  function _isBroadSelectorPart(p) {
    const first = (p || '').split(/[\s>+~]/)[0].toLowerCase();
    if (!first) return true;
    if (BROADENING_PSEUDO_RE.test(first)) return true;
    if (ROOT_PSEUDO_PREFIXES.some(pref => first.startsWith(pref))) return true;
    const m = first.match(/^([*a-z][a-z0-9-]*)/);
    const headTag = m ? m[1] : '';
    return BARE_TAG_HEADS.has(headTag);
  }

  function _normalize(s) {
    let out = String(s || '').toLowerCase()
      .replace(/\\([0-9a-f]{1,6})\s?/g, (_, h) => {
        const cp = parseInt(h, 16);
        return cp < 0x110000 ? String.fromCodePoint(cp) : '';
      })
      .replace(/\\(.)/g, '$1');
    try { out = out.replace(/&#(\d+);?/g, (_, n) => String.fromCharCode(+n)); } catch {}
    return out.replace(/\s+/g, '');
  }

  function _hasDangerous(s) {
    const n = _normalize(s);
    return DANGEROUS_TOKENS.some(t => n.includes(t));
  }

  // selectorMapper(selector) -> scoped selector or '' to drop
  function sanitizeScopedCss(rawCss, scope, selectorMapper) {
    if (!rawCss || !scope) return '';
    let css = String(rawCss).slice(0, 10240).replace(/\/\*[\s\S]*?\*\//g, '');
    if (_hasDangerous(css)) return '';
    if ((css.match(/\{/g) || []).length !== (css.match(/\}/g) || []).length) return '';
    const out = [];
    for (const chunk of css.split('}')) {
      const i = chunk.indexOf('{');
      if (i === -1) continue;
      const selRaw = chunk.slice(0, i).trim();
      const body = chunk.slice(i + 1).trim();
      if (!selRaw || !body) continue;
      if (selRaw.startsWith('@')) continue;
      if (/[<>(){}"'`\\;]/.test(selRaw)) continue;
      if (_hasDangerous(body)) continue;
      const parts = selRaw.split(',').map(s => s.trim());
      if (parts.some(p => !p)) continue; // empty part = leading/trailing comma
      let badPart = false;
      const mapped = [];
      for (const p of parts) {
        if (_isBroadSelectorPart(p)) { badPart = true; break; }
        const m = typeof selectorMapper === 'function'
          ? selectorMapper(p) : `${scope} ${p}`;
        if (!m) { badPart = true; break; }
        mapped.push(m);
      }
      if (badPart || !mapped.length) continue;
      out.push(`${mapped.join(', ')} { ${body} }`);
    }
    return out.join('\n');
  }

  return { sanitizeScopedCss };
})();
try { if (typeof window !== 'undefined') window.Css = Css; } catch {}

// apiFetch() — authenticated fetch using current State.token.
// Signals ConnErr on network-level failures (TypeError) so the retry overlay
// appears after repeated offline failures.
async function apiFetch (url, method = 'GET', body = null) {
  const authHeaders = { 'X-Session-Token': State.token || '' };
  // Back-compat: many callers pass a fetch-style options object as the 2nd
  // arg (e.g. { method:'POST' } or { signal }). Normalize both signatures.
  const isOptsObject = method && typeof method === 'object' && !Array.isArray(method);
  // 10.5: callers can opt out of the PIN-gate auto-retry by passing
  // `_pinRetried:true` in the opts object. We use it internally to
  // break the loop after one retry attempt; no caller should set it
  // by hand.
  const _pinRetried = !!(isOptsObject && method && method._pinRetried);
  const opts = isOptsObject
    ? { ...method, method: method.method || 'GET', headers: { ...(method.headers || {}), ...authHeaders } }
    : { method, headers: authHeaders };
  if (body && String(opts.method).toUpperCase() !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  // Per-request timeout so a stalled socket (e.g. video downloads
  // saturating the 6-conn pool) can't pin a /feed call forever and
  // surface as a "loading…" hang. 25 s is far longer than any healthy
  // API response yet shorter than the browser's default ~5 min idle.
  let timer = null;
  if (typeof AbortController !== 'undefined') {
    const ac = new AbortController();
    opts.signal = ac.signal;
    timer = setTimeout(() => { try { ac.abort(); } catch {} }, 25000);
  }
  try {
    const res = await fetch(url, opts);
    const _u = String(url || '');
    const _isApi = _u.startsWith('/api');
    // ── PIN gate (server-side) ──────────────────────────────────────
    // The server returns 423 Locked with {pin_required:true} when this
    // session has a PIN configured and hasn't unlocked this process
    // (or has been idle past the user's timeout). We pop the lock
    // overlay, wait for the user to enter the PIN, then retry exactly
    // once with the same URL/method/body. A second 423 is surfaced to
    // the caller untouched so it doesn't loop forever.
    if (_isApi && res.status === 423 && !_pinRetried
        && typeof Pin !== 'undefined' && Pin.gateRequest) {
      let bodyJson = null;
      try { bodyJson = await res.clone().json(); } catch {}
      if (bodyJson && bodyJson.pin_required) {
        if (timer) { clearTimeout(timer); timer = null; }
        try { await Pin.gateRequest(); } catch {}
        // Rebuild the opts object so the retry gets a fresh
        // AbortController + clean headers, and tag it so we don't
        // recurse on a second 423.
        const retryOpts = isOptsObject
          ? { ...method, _pinRetried: true }
          : { method, _pinRetried: true };
        return apiFetch(url, retryOpts, body);
      }
    }
    if (_isApi) {
      const ct = String(res.headers?.get('content-type') || '').toLowerCase();
      const isJson = ct.includes('application/json') || ct.includes('+json');
      const looksHtml = ct.includes('text/html');
      // Some proxy/auth edge paths can return HTML for API calls; normalize
      // this into JSON so callers don't crash with "Unexpected token <".
      if (!isJson && looksHtml) {
        let preview = '';
        try { preview = (await res.clone().text()).slice(0, 120); } catch {}
        const mappedStatus = res.status === 200 ? 502 : res.status;
        const payload = {
          error: 'Invalid non-JSON API response',
          status: res.status,
          content_type: ct || 'unknown',
          preview,
        };
        if (typeof ConnErr !== 'undefined') ConnErr.onNetOk();
        return new Response(JSON.stringify(payload), {
          status: mappedStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    if (typeof ConnErr !== 'undefined') ConnErr.onNetOk();
    return res;
  } catch (err) {
    // TypeError: Failed to fetch → network / server unreachable
    if (typeof ConnErr !== 'undefined') ConnErr.onNetFail();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// scrollChatBottom helper
function scrollChatBottom () {
  const area = document.getElementById('messages-area');
  if (area) area.scrollTop = area.scrollHeight;
}

// Track H cleanup: deriveSharedSecret / encryptMsg / decryptMsg were
// helpers for the legacy v1 ECDH DM path; Signal Protocol (window.Signal)
// is now the only DM crypto. Removed.

// Inject toast fade-in keyframe
const _toastStyle = document.createElement('style');
_toastStyle.textContent = `@keyframes fadeInRight{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}`;
document.head?.appendChild(_toastStyle);
