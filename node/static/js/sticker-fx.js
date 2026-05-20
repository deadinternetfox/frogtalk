/**
 * sticker-fx.js — FrogTalk sticker visual effects
 *
 * Three responsibilities:
 *   1. Normalize / validate effects objects (mirrors the server whitelist).
 *   2. Convert effects → safe CSS strings (filter / transform / animation).
 *   3. Render an isolated sticker into a Shadow DOM container so the CSS
 *      can NEVER bleed into the surrounding page.
 *
 * Why Shadow DOM? Even though we only emit our own computed style strings
 * (no user-typed CSS ever reaches the DOM), shadow-root encapsulation
 * gives us defence-in-depth: animations / transforms can be `contain`ed
 * to the sticker box, and even `position: fixed` or `!important` rules
 * defined inside the shadow can't leak out to influence the chat layout.
 */
(function () {
  'use strict';

  // ── Whitelist (mirrors routers/gifs.py:validate_sticker_effects) ────
  const FILTER_RANGES = {
    blur:       [0,   6,   0],   // px
    brightness: [0.2, 2.5, 1],
    contrast:   [0.2, 2.5, 1],
    saturate:   [0,   3,   1],
    grayscale:  [0,   1,   0],
    sepia:      [0,   1,   0],
    invert:     [0,   1,   0],
    hue:        [0,   360, 0],   // degrees
  };
  const TRANSFORM_RANGES = {
    scale:  [0.5, 2,    1],
    rotate: [-180, 180, 0],
    skewX:  [-30, 30,   0],
    skewY:  [-30, 30,   0],
  };
  const SHADOW_RANGES = {
    x:      [-20, 20,   0],
    y:      [-20, 20,   0],
    blur:   [0,   30,   0],
    spread: [0,   1,    0],
  };
  const ANIMATIONS = new Set([
    'none', 'spin', 'pulse', 'bounce', 'shake', 'wobble',
    'float', 'glow', 'rainbow', 'flip', 'swing',
  ]);
  const HEX_CHARS = '0123456789abcdef';
  const FX_B64_MAX_LEN = 1500;
  const FX_ALT_MAX_LEN = 120;
  const FX_SIZE_MIN = 16;
  const FX_SIZE_MAX = 512;
  const FX_DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp|apng|avif);base64,[A-Za-z0-9+/=]+$/;

  function _stripControlChars(s) {
    return String(s || '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  }

  /** Safe `src` for <img> — blocks javascript:/data:text/html and other schemes. */
  function _safeImageSrc(raw) {
    if (typeof raw !== 'string') return '';
    const s = raw.trim();
    if (!s || s.length > 600000) return '';
    const head = s.slice(0, 32).toLowerCase();
    if (head.startsWith('javascript:') || head.startsWith('vbscript:')
        || head.startsWith('data:text') || head.startsWith('blob:')) {
      return '';
    }
    if (FX_DATA_URL_RE.test(s)) return s;
    try {
      const u = new URL(s, window.location.origin);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
    } catch {}
    return '';
  }

  function _safeSize(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    return Math.max(FX_SIZE_MIN, Math.min(FX_SIZE_MAX, Math.round(n)));
  }

  function _safeAlt(raw) {
    const t = _stripControlChars(raw);
    if (!t) return '';
    return t.length > FX_ALT_MAX_LEN ? t.slice(0, FX_ALT_MAX_LEN) : t;
  }

  function _clamp(v, lo, hi, def) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }
  function _hex(v, def) {
    if (typeof v !== 'string') return def;
    const s = v.trim().toLowerCase();
    if (!s.startsWith('#')) return def;
    const body = s.slice(1);
    if (![3, 4, 6, 8].includes(body.length)) return def;
    for (const c of body) if (HEX_CHARS.indexOf(c) < 0) return def;
    return '#' + body;
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = { filter: {}, transform: {}, shadow: {} };
    for (const [k, [lo, hi, d]] of Object.entries(FILTER_RANGES)) {
      out.filter[k] = _clamp(raw.filter && raw.filter[k], lo, hi, d);
    }
    for (const [k, [lo, hi, d]] of Object.entries(TRANSFORM_RANGES)) {
      out.transform[k] = _clamp(raw.transform && raw.transform[k], lo, hi, d);
    }
    for (const [k, [lo, hi, d]] of Object.entries(SHADOW_RANGES)) {
      out.shadow[k] = _clamp(raw.shadow && raw.shadow[k], lo, hi, d);
    }
    out.shadow.color = _hex(raw.shadow && raw.shadow.color, '#000000');
    const animRaw = (typeof raw.animation === 'string') ? raw.animation.trim() : '';
    out.animation = ANIMATIONS.has(animRaw) ? animRaw : 'none';
    out.animation_duration = _clamp(raw.animation_duration, 0.3, 10, 2);
    out.background = _hex(raw.background, '');
    out.border_radius = _clamp(raw.border_radius, 0, 50, 0);
    return out;
  }

  function isDefault(fx) {
    const n = normalize(fx);
    if (!n) return true;
    if (n.animation !== 'none') return false;
    if (n.background) return false;
    if (n.border_radius) return false;
    const allDefault = (obj, ranges) =>
      Object.entries(ranges).every(([k, r]) => Math.abs(obj[k] - r[2]) < 1e-6);
    if (!allDefault(n.filter, FILTER_RANGES)) return false;
    if (!allDefault(n.transform, TRANSFORM_RANGES)) return false;
    if (n.shadow.x || n.shadow.y || n.shadow.blur || n.shadow.spread) return false;
    return true;
  }

  // Build a CSS `filter:` string. Values are clamped numbers, no
  // interpolation of free-form text ever happens.
  function _filterCss(f) {
    const parts = [];
    if (f.blur)            parts.push(`blur(${f.blur}px)`);
    if (f.brightness !== 1) parts.push(`brightness(${f.brightness})`);
    if (f.contrast !== 1)  parts.push(`contrast(${f.contrast})`);
    if (f.saturate !== 1)  parts.push(`saturate(${f.saturate})`);
    if (f.grayscale)       parts.push(`grayscale(${f.grayscale})`);
    if (f.sepia)           parts.push(`sepia(${f.sepia})`);
    if (f.invert)          parts.push(`invert(${f.invert})`);
    if (f.hue)             parts.push(`hue-rotate(${f.hue}deg)`);
    return parts.join(' ');
  }

  function _transformCss(t) {
    const parts = [];
    if (t.scale !== 1)  parts.push(`scale(${t.scale})`);
    if (t.rotate)       parts.push(`rotate(${t.rotate}deg)`);
    if (t.skewX)        parts.push(`skewX(${t.skewX}deg)`);
    if (t.skewY)        parts.push(`skewY(${t.skewY}deg)`);
    return parts.join(' ');
  }

  function _shadowCss(s) {
    if (!s.x && !s.y && !s.blur && !s.spread) return '';
    // `spread` here is reused as alpha for the drop-shadow color, which
    // gives a nicer "glow" knob than the actual CSS spread parameter
    // (which doesn't apply to drop-shadow anyway).
    const a = Math.max(0, Math.min(1, s.spread || 0));
    const hex = s.color || '#000000';
    const rgba = _hexToRgba(hex, a || 0.5);
    return `drop-shadow(${s.x}px ${s.y}px ${s.blur}px ${rgba})`;
  }

  function _hexToRgba(hex, a) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length === 4) h = h.split('').map(c => c + c).join('');
    if (h.length === 8) h = h.slice(0, 6); // drop alpha — we set our own
    const n = parseInt(h, 16);
    const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
  }

  // The animation keyframes. All transforms / opacities only — no positional
  // properties — so they can never visually escape the sticker bounding box
  // beyond what `overflow:hidden` already clips.
  const KEYFRAMES = `
    @keyframes fxSpin   { from { transform: var(--fx-base) rotate(0deg); } to { transform: var(--fx-base) rotate(360deg); } }
    @keyframes fxPulse  { 0%,100% { transform: var(--fx-base) scale(1); } 50% { transform: var(--fx-base) scale(1.12); } }
    @keyframes fxBounce { 0%,100% { transform: var(--fx-base) translateY(0); } 50% { transform: var(--fx-base) translateY(-8%); } }
    @keyframes fxShake  { 0%,100% { transform: var(--fx-base) translateX(0); } 25% { transform: var(--fx-base) translateX(-4%); } 75% { transform: var(--fx-base) translateX(4%); } }
    @keyframes fxWobble { 0%,100% { transform: var(--fx-base) rotate(-4deg); } 50% { transform: var(--fx-base) rotate(4deg); } }
    @keyframes fxFloat  { 0%,100% { transform: var(--fx-base) translateY(0); } 50% { transform: var(--fx-base) translateY(-6%); } }
    @keyframes fxGlow   { 0%,100% { filter: var(--fx-filter) drop-shadow(0 0 4px var(--fx-glow)); } 50% { filter: var(--fx-filter) drop-shadow(0 0 14px var(--fx-glow)); } }
    @keyframes fxRainbow{ 0%   { filter: var(--fx-filter) hue-rotate(0deg); }
                          100% { filter: var(--fx-filter) hue-rotate(360deg); } }
    @keyframes fxFlip   { 0%,100% { transform: var(--fx-base) rotateY(0); } 50% { transform: var(--fx-base) rotateY(180deg); } }
    @keyframes fxSwing  { 0%,100% { transform: var(--fx-base) rotate(-8deg); transform-origin: 50% 0%; }
                          50%     { transform: var(--fx-base) rotate(8deg);  transform-origin: 50% 0%; } }
  `;

  const ANIM_MAP = {
    spin:    'fxSpin 4s linear infinite',
    pulse:   'fxPulse  __D__ ease-in-out infinite',
    bounce:  'fxBounce __D__ ease-in-out infinite',
    shake:   'fxShake  __D__ ease-in-out infinite',
    wobble:  'fxWobble __D__ ease-in-out infinite',
    float:   'fxFloat  __D__ ease-in-out infinite',
    glow:    'fxGlow   __D__ ease-in-out infinite',
    rainbow: 'fxRainbow __D__ linear infinite',
    flip:    'fxFlip __D__ ease-in-out infinite',
    swing:   'fxSwing __D__ ease-in-out infinite',
  };

  function toCss(rawEffects) {
    const n = normalize(rawEffects);
    if (!n) return null;
    const filterStr = _filterCss(n.filter);
    const shadowStr = _shadowCss(n.shadow);
    const transformStr = _transformCss(n.transform) || 'none';

    let combinedFilter = filterStr;
    if (shadowStr) combinedFilter = combinedFilter ? `${filterStr} ${shadowStr}` : shadowStr;

    let animation = '';
    const animName = ANIM_MAP[n.animation];
    if (animName) animation = animName.replace('__D__', `${n.animation_duration}s`);

    // Use the shadow color also as the "glow" color for the glow keyframes.
    const glow = _hexToRgba(n.shadow.color || '#ffffff', 0.8);

    return {
      filter:     combinedFilter || 'none',
      transform:  transformStr,
      animation:  animation || 'none',
      background: n.background || 'transparent',
      borderRadius: n.border_radius ? `${n.border_radius}%` : '0',
      glow,
      hasAny:    !isDefault(n),
    };
  }

  // base64url helpers (sticker effects piggyback on `media_type`)
  function _b64urlEncode(str) {
    const b = btoa(unescape(encodeURIComponent(str)));
    return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function _b64urlDecode(s) {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return decodeURIComponent(escape(atob(t)));
  }

  function encodeForMediaType(baseType, effects) {
    const n = normalize(effects);
    if (!n || isDefault(n)) return baseType || 'image/png';
    try {
      const enc = _b64urlEncode(JSON.stringify(n));
      // Hard cap so a malformed encoder can't blow out the messages.media_type
      // column (which is short).
      if (enc.length > 1500) return baseType || 'image/png';
      return `${baseType || 'image/png'};fx=${enc}`;
    } catch {
      return baseType || 'image/png';
    }
  }

  function decodeFromMediaType(mediaType) {
    if (typeof mediaType !== 'string') return null;
    const m = mediaType.match(/;\s*fx=([A-Za-z0-9_-]+)/);
    if (!m || m[1].length > FX_B64_MAX_LEN) return null;
    try {
      const parsed = JSON.parse(_b64urlDecode(m[1]));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return normalize(parsed);
    } catch {
      return null;
    }
  }

  function stripFx(mediaType) {
    if (typeof mediaType !== 'string') return mediaType;
    return mediaType.replace(/;\s*fx=[A-Za-z0-9_-]+/g, '');
  }

  // ── Rendering ────────────────────────────────────────────────────────
  // Build a fully-isolated sticker DOM node. The outer host gets a closed
  // shadow root containing a <style> + <img>. Everything inside is scoped
  // to that shadow; nothing inside can affect the rest of the page.
  function buildHost(opts) {
    const {
      src,                // image data URL
      effects,            // raw or normalized effects obj
      size,               // box dimensions ('contain' clipping)
      alt,
      onClick,
    } = opts || {};

    const safeSrc = _safeImageSrc(src);
    const safeAlt = _safeAlt(alt);
    const safeSize = _safeSize(size);

    const host = document.createElement('span');
    host.className = 'frog-sticker';
    // The host itself is the sandbox boundary. `contain: layout paint
    // style` prevents transforms / animations / blurs from spilling out
    // and affecting siblings' layout / paint regions.
    host.style.cssText = (
      'display:inline-block;' +
      'contain:layout paint style;' +
      'overflow:hidden;' +
      'isolation:isolate;' +
      'line-height:0;' +
      'vertical-align:middle;' +
      (safeSize ? `width:${safeSize}px;height:${safeSize}px;` : 'max-width:160px;max-height:160px;')
    );
    if (safeAlt) host.setAttribute('aria-label', safeAlt);
    if (onClick) {
      host.style.cursor = 'pointer';
      host.addEventListener('click', onClick);
    }

    // Closed shadow — outside JS can't reach in and tamper with the styles.
    const root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : null;
    const css  = toCss(effects);

    const styleHtml = `
      :host { all: initial; display: block; width: 100%; height: 100%; }
      .wrap {
        width: 100%; height: 100%;
        display: flex; align-items: center; justify-content: center;
        background: ${css ? css.background : 'transparent'};
        border-radius: ${css ? css.borderRadius : '0'};
        overflow: hidden;
      }
      img {
        max-width: 100%; max-height: 100%;
        width: auto; height: auto;
        object-fit: contain;
        --fx-base: ${css ? css.transform : 'none'};
        --fx-filter: ${css ? css.filter : 'none'};
        --fx-glow: ${css ? css.glow : 'rgba(255,255,255,0.6)'};
        filter: var(--fx-filter);
        transform: var(--fx-base);
        animation: ${css ? css.animation : 'none'};
        animation-play-state: running;
        will-change: transform, filter;
      }
      ${KEYFRAMES}
      @media (prefers-reduced-motion: reduce) {
        img { animation: none !important; }
      }
    `;

    if (root) {
      // Build via DOM (not innerHTML) to keep this completely safe even if
      // src ever contained funky characters — `setAttribute('src', ...)`
      // treats the value as plain text.
      const style = document.createElement('style');
      style.textContent = styleHtml;
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      const img = document.createElement('img');
      img.setAttribute('alt', safeAlt);
      img.setAttribute('draggable', 'false');
      img.setAttribute('decoding', 'async');
      img.setAttribute('loading', 'lazy');
      if (safeSrc) img.src = safeSrc;
      wrap.appendChild(img);
      root.appendChild(style);
      root.appendChild(wrap);
    } else {
      // Shadow DOM unsupported (very old browsers / odd webviews) — fall
      // back to a plain <img>. No animation in that case, but the page
      // still renders cleanly.
      const img = document.createElement('img');
      if (safeSrc) img.src = safeSrc;
      img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain';
      if (safeAlt) img.alt = safeAlt;
      host.appendChild(img);
    }
    return host;
  }

  // Convenience: render into an existing container.
  function renderInto(container, opts) {
    if (!container) return null;
    container.innerHTML = '';
    const host = buildHost(opts);
    container.appendChild(host);
    return host;
  }

  // Return the canonical "no effects" object — useful as the editor's
  // starting state.
  function defaults() {
    return normalize({
      filter:    {},
      transform: {},
      shadow:    {},
      animation: 'none',
    });
  }

  // Public API
  window.StickerFX = {
    normalize,
    isDefault,
    toCss,
    encodeForMediaType,
    decodeFromMediaType,
    stripFx,
    buildHost,
    renderInto,
    safeImageSrc: _safeImageSrc,
    defaults,
    ANIMATIONS: Array.from(ANIMATIONS),
    FILTER_RANGES,
    TRANSFORM_RANGES,
    SHADOW_RANGES,
  };
})();
