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
    // Minimal, always-compatible set.
    'none',
    // movement
    'spin', 'pulse', 'bounce', 'shake', 'wobble', 'float', 'flip', 'swing', 'sparkle', 'pop',
    // color
    'rainbow_tint',
    // glow track (overlay)
    'glow', 'rainbow_glow',
  ]);
  const TRANSFORM_ANIMS = new Set([
    'spin', 'pulse', 'bounce', 'shake', 'wobble', 'float', 'flip', 'swing', 'sparkle', 'pop',
  ]);
  const FILTER_ANIMS = new Set([
    'rainbow_tint',
  ]);
  const GLOW_ANIMS = new Set([
    'glow', 'rainbow_glow',
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
    // Optional: GIF playback controls for sticker media (only meaningful for GIF src).
    const gm = (typeof raw.gif_mode === 'string') ? raw.gif_mode.trim() : '';
    out.gif_mode = (gm === 'once' || gm === 'paused' || gm === 'loop') ? gm : 'loop';
    out.gif_play_seconds = _clamp(raw.gif_play_seconds, 0.3, 10, 2.5);
    // Optional v2: effect layers (animation stack). Each layer is whitelisted.
    // This enables chaining multiple effects while keeping strict validation.
    const layersIn = raw.layers;
    if (Array.isArray(layersIn)) {
      const layers = [];
      for (const it of layersIn) {
        if (!it || typeof it !== 'object') continue;
        const kind = (typeof it.kind === 'string') ? it.kind.trim() : '';
        const anim = (typeof it.animation === 'string') ? it.animation.trim() : '';
        if (kind !== 'transform' && kind !== 'filter' && kind !== 'glow') continue;
        if (!ANIMATIONS.has(anim) || anim === 'none') continue;
        if (kind === 'transform' && !TRANSFORM_ANIMS.has(anim)) continue;
        if (kind === 'filter' && !FILTER_ANIMS.has(anim)) continue;
        if (kind === 'glow' && !GLOW_ANIMS.has(anim)) continue;
        const start = _clamp(it.start, 0, 20, 0);
        const dur = _clamp(it.duration, 0.3, 10, 2);
        layers.push({ kind, animation: anim, start, duration: dur });
        if (layers.length >= 6) break;
      }
      out.layers = layers;
    }
    return out;
  }

  function _timelineDurationSec(nfx) {
    try {
      const layers = Array.isArray(nfx?.layers) ? nfx.layers : [];
      let end = 0;
      for (const l of layers) {
        const s = Number(l.start) || 0;
        const d = Number(l.duration) || 0;
        end = Math.max(end, s + d);
      }
      // Keep a sane loop window even for single clips.
      return Math.max(0.6, Math.min(12, end || 2));
    } catch {
      return 2;
    }
  }

  function _pct(t, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, (t / total) * 100));
  }

  function _kf(name, body) {
    return `@keyframes ${name}{${body}}`;
  }

  function _makeTransformTimelineKeyframes(name, anim, sPct, ePct) {
    // We keep base transform via var(--fx-base) and animate only inside the window.
    const hold = `0%,${sPct}%{transform:var(--fx-base);opacity:1;}`;
    const endHold = `${ePct}%,100%{transform:var(--fx-base);opacity:1;}`;
    if (anim === 'spin') {
      return _kf(name, `${hold}${sPct}%{transform:var(--fx-base) rotate(0deg);} ${ePct}%{transform:var(--fx-base) rotate(360deg);} ${endHold}`);
    }
    if (anim === 'pulse') {
      const mid = (sPct + ePct) / 2;
      return _kf(name, `${hold}${sPct}%{transform:var(--fx-base) scale(1);} ${mid}%{transform:var(--fx-base) scale(1.12);} ${ePct}%{transform:var(--fx-base) scale(1);} ${endHold}`);
    }
    if (anim === 'bounce') {
      const mid = (sPct + ePct) / 2;
      return _kf(name, `${hold}${sPct}%{transform:var(--fx-base) translateY(0);} ${mid}%{transform:var(--fx-base) translateY(-8%);} ${ePct}%{transform:var(--fx-base) translateY(0);} ${endHold}`);
    }
    if (anim === 'shake') {
      const q1 = sPct + (ePct - sPct) * 0.25;
      const q3 = sPct + (ePct - sPct) * 0.75;
      return _kf(name, `${hold}${sPct}%{transform:var(--fx-base) translateX(0);} ${q1}%{transform:var(--fx-base) translateX(-4%);} ${q3}%{transform:var(--fx-base) translateX(4%);} ${ePct}%{transform:var(--fx-base) translateX(0);} ${endHold}`);
    }
    if (anim === 'wobble') {
      const mid = (sPct + ePct) / 2;
      return _kf(name, `${hold}${sPct}%{transform:var(--fx-base) rotate(-4deg);} ${mid}%{transform:var(--fx-base) rotate(4deg);} ${ePct}%{transform:var(--fx-base) rotate(-4deg);} ${endHold}`);
    }
    if (anim === 'float') {
      const mid = (sPct + ePct) / 2;
      return _kf(name, `${hold}${sPct}%{transform:var(--fx-base) translateY(0);} ${mid}%{transform:var(--fx-base) translateY(-6%);} ${ePct}%{transform:var(--fx-base) translateY(0);} ${endHold}`);
    }
    if (anim === 'flip') {
      const mid = (sPct + ePct) / 2;
      return _kf(name, `${hold}${sPct}%{transform:var(--fx-base) rotateY(0);} ${mid}%{transform:var(--fx-base) rotateY(180deg);} ${ePct}%{transform:var(--fx-base) rotateY(0);} ${endHold}`);
    }
    if (anim === 'swing') {
      const mid = (sPct + ePct) / 2;
      return _kf(name, `${hold}${sPct}%{transform:var(--fx-base) rotate(-8deg);} ${mid}%{transform:var(--fx-base) rotate(8deg);} ${ePct}%{transform:var(--fx-base) rotate(-8deg);} ${endHold}`);
    }
    if (anim === 'sparkle') {
      const a = sPct + (ePct - sPct) * 0.35;
      const b = sPct + (ePct - sPct) * 0.70;
      return _kf(name, `${hold}${sPct}%{transform:var(--fx-base) scale(1);opacity:1;} ${a}%{transform:var(--fx-base) scale(1.06);opacity:.88;} ${b}%{transform:var(--fx-base) scale(0.98);opacity:1;} ${ePct}%{transform:var(--fx-base) scale(1);opacity:1;} ${endHold}`);
    }
    if (anim === 'pop') {
      const mid = sPct + (ePct - sPct) * 0.45;
      return _kf(name, `${hold}${sPct}%{transform:var(--fx-base) scale(0.92);opacity:.85;} ${mid}%{transform:var(--fx-base) scale(1.12);opacity:1;} ${ePct}%{transform:var(--fx-base) scale(1);opacity:1;} ${endHold}`);
    }
    // Fallback: no-op
    return _kf(name, `${hold}${endHold}`);
  }

  function _makeFilterTimelineKeyframes(name, anim, sPct, ePct) {
    const hold = `0%,${sPct}%{filter:var(--fx-filter);}`;
    const endHold = `${ePct}%,100%{filter:var(--fx-filter);}`;
    if (anim === 'rainbow_tint') {
      return _kf(name, `${hold}${sPct}%{filter:var(--fx-filter) sepia(1) saturate(3) hue-rotate(0deg);} ${ePct}%{filter:var(--fx-filter) sepia(1) saturate(3) hue-rotate(360deg);} ${endHold}`);
    }
    // Glow is handled by a separate overlay layer so it can stack with rainbow.
    return _kf(name, `${hold}${endHold}`);
  }

  function _makeGlowTimelineKeyframes(name, anim, sPct, ePct) {
    const hold = `0%,${sPct}%{opacity:0;}`;
    const endHold = `${ePct}%,100%{opacity:0;}`;
    const mid = (sPct + ePct) / 2;
    if (anim === 'glow') {
      return _kf(name, `${hold}${sPct}%{opacity:.35;} ${mid}%{opacity:1;} ${ePct}%{opacity:.35;} ${endHold}`);
    }
    if (anim === 'rainbow_glow') {
      // Stronger pulse intended to pair with rainbow_tint filter.
      return _kf(name, `${hold}${sPct}%{opacity:.25;} ${mid}%{opacity:1;} ${ePct}%{opacity:.25;} ${endHold}`);
    }
    return _kf(name, `${hold}${endHold}`);
  }

  function isDefault(fx) {
    const n = normalize(fx);
    if (!n) return true;
    if (Array.isArray(n.layers) && n.layers.length) return false;
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
    @keyframes fxRainbowTint { 0%   { filter: var(--fx-filter) sepia(1) saturate(3) hue-rotate(0deg); }
                               100% { filter: var(--fx-filter) sepia(1) saturate(3) hue-rotate(360deg); } }
    @keyframes fxRainbowGlow { 0%,100% { filter: var(--fx-filter) drop-shadow(0 0 6px var(--fx-glow)); }
                               50%     { filter: var(--fx-filter) drop-shadow(0 0 18px var(--fx-glow)); } }
    @keyframes fxFlip   { 0%,100% { transform: var(--fx-base) rotateY(0); } 50% { transform: var(--fx-base) rotateY(180deg); } }
    @keyframes fxSwing  { 0%,100% { transform: var(--fx-base) rotate(-8deg); transform-origin: 50% 0%; }
                          50%     { transform: var(--fx-base) rotate(8deg);  transform-origin: 50% 0%; } }
    @keyframes fxSparkle{ 0%,100% { transform: var(--fx-base) scale(1); opacity: 1; }
                          35%     { transform: var(--fx-base) scale(1.06); opacity: .88; }
                          70%     { transform: var(--fx-base) scale(0.98); opacity: 1; } }
    @keyframes fxPop    { 0% { transform: var(--fx-base) scale(0.92); opacity: .85; }
                          45% { transform: var(--fx-base) scale(1.12); opacity: 1; }
                          100% { transform: var(--fx-base) scale(1); opacity: 1; } }
  `;

  const ANIM_MAP = {
    spin:    'fxSpin 4s linear __ITER__',
    pulse:   'fxPulse  __D__ ease-in-out __ITER__',
    bounce:  'fxBounce __D__ ease-in-out __ITER__',
    shake:   'fxShake  __D__ ease-in-out __ITER__',
    wobble:  'fxWobble __D__ ease-in-out __ITER__',
    float:   'fxFloat  __D__ ease-in-out __ITER__',
    glow:    'fxGlow   __D__ ease-in-out __ITER__',
    rainbow_tint: 'fxRainbowTint __D__ linear __ITER__',
    rainbow_glow: 'fxRainbowGlow __D__ ease-in-out __ITER__',
    flip:    'fxFlip __D__ ease-in-out __ITER__',
    swing:   'fxSwing __D__ ease-in-out __ITER__',
    sparkle: 'fxSparkle __D__ ease-in-out __ITER__',
    pop:     'fxPop __D__ cubic-bezier(.2,.9,.2,1) __ITER__',
  };

  function _prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  function _animationCss(animKey, durationSec, playOnce) {
    const tpl = ANIM_MAP[animKey];
    if (!tpl) return '';
    const iters = playOnce ? '1' : 'infinite';
    return tpl.replace('__D__', `${durationSec}s`).replace('__ITER__', iters);
  }

  function toCss(rawEffects, opts) {
    const playOnce = !!(opts && opts.playOnce);
    const forceAnimation = !!(opts && opts.forceAnimation);
    const n = normalize(rawEffects);
    if (!n) return null;
    const filterStr = _filterCss(n.filter);
    const shadowStr = _shadowCss(n.shadow);
    // Important: keyframe animations concatenate extra transform functions
    // (e.g. `var(--fx-base) rotate(…)`). The keyword `none` cannot be
    // combined with other transform functions, so it would invalidate the
    // whole declaration and make animations appear to "do nothing".
    // Use an identity transform instead.
    const transformStr = _transformCss(n.transform) || 'translate(0px, 0px)';

    let combinedFilter = filterStr;
    if (shadowStr) combinedFilter = combinedFilter ? `${filterStr} ${shadowStr}` : shadowStr;
    // IMPORTANT: keyframe animations concatenate extra filter functions
    // (e.g. `var(--fx-filter) hue-rotate(...)`). The keyword `none` cannot be
    // combined with other filter functions, which would make rainbow/glow
    // appear to do nothing. Use an identity filter instead.
    if (!combinedFilter) combinedFilter = 'brightness(1)';

    let animation = '';
    // Default: honor reduced-motion. Editor preview can explicitly override
    // by passing { forceAnimation: true }.
    if (n.animation && n.animation !== 'none' && (forceAnimation || !_prefersReducedMotion())) {
      animation = _animationCss(n.animation, n.animation_duration, playOnce);
    }

    // Use the shadow color also as the "glow" color for the glow keyframes.
    // Default shadow color is black; when users haven't chosen a glow color
    // yet a black glow can be effectively invisible on dark themes.
    const glowHex = (String(n.shadow.color || '').toLowerCase() === '#000000') ? '#ffffff' : (n.shadow.color || '#ffffff');
    const glow = _hexToRgba(glowHex, 0.8);

    return {
      filter:     combinedFilter,
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

  /** Restart CSS animation on an existing .frog-sticker host (shadow DOM). */
  function replayAnimation(host) {
    if (!host) return;
    try { host._fxRestartGif?.(); } catch {}
    // Restart CSS animations on any registered replay elements.
    const els = host._fxReplayEls || [];
    if (!els.length) return;
    for (const el of els) {
      const anim = el && el.dataset ? (el.dataset.fxAnim || '') : '';
      if (!anim || anim === 'none') continue;
      try {
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = anim;
      } catch {}
    }
  }

  function describeEffects(rawEffects) {
    const n = normalize(rawEffects);
    if (!n || isDefault(n)) return { hasFx: false, summary: 'No effects (plain image/GIF)' };
    const parts = [];
    if (n.animation && n.animation !== 'none') {
      parts.push(`Animation: ${n.animation} (${n.animation_duration}s)`);
    }
    const f = n.filter;
    if (f.blur) parts.push(`Blur ${f.blur}px`);
    if (f.brightness !== 1) parts.push(`Brightness ${f.brightness}×`);
    if (f.hue) parts.push(`Hue ${f.hue}°`);
    if (n.transform.scale !== 1) parts.push(`Scale ${n.transform.scale}×`);
    if (n.shadow.blur || n.shadow.x || n.shadow.y) parts.push('Shadow/glow');
    return {
      hasFx: true,
      summary: parts.length ? parts.join(' · ') : 'Custom filters',
      normalized: n,
    };
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
      playOnce,           // chat: play once; picker/editor: loop
      forceAnimation,     // editor preview: override reduced-motion
    } = opts || {};

    const safeSrc = _safeImageSrc(src);
    const safeAlt = _safeAlt(alt);
    const safeSize = _safeSize(size);
    const isGif = typeof safeSrc === 'string' && (
      safeSrc.startsWith('data:image/gif') || /\.gif(\?|#|$)/i.test(safeSrc)
    );

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
    const css  = toCss(effects, { playOnce: !!playOnce, forceAnimation: !!forceAnimation });
    const nfx = normalize(effects);
    const layers = (nfx && Array.isArray(nfx.layers) && nfx.layers.length) ? nfx.layers : null;
    const gifModeRaw = (nfx && typeof nfx.gif_mode === 'string') ? nfx.gif_mode : '';
    const gifMode = (gifModeRaw === 'once' || gifModeRaw === 'paused' || gifModeRaw === 'loop') ? gifModeRaw : 'loop';
    const gifPlaySec = nfx && typeof nfx.gif_play_seconds === 'number' ? nfx.gif_play_seconds : 2.5;

    let dynKeyframes = '';
    let tLayerAnims = [];
    let fAnim = 'none';
    let gAnim = 'none';
    if (layers && (forceAnimation || !_prefersReducedMotion())) {
      const total = _timelineDurationSec(nfx);
      const tLayers = layers.filter(l => l.kind === 'transform').slice(0, 3);
      const fLayer = layers.find(l => l.kind === 'filter') || null;
      const gLayer = layers.find(l => l.kind === 'glow') || null;
      let i = 0;
      for (const tl of tLayers) {
        const sPct = _pct(tl.start || 0, total);
        const ePct = _pct((tl.start || 0) + (tl.duration || 0), total);
        const kfName = `fxT_${Math.random().toString(36).slice(2, 8)}_${i++}`;
        dynKeyframes += _makeTransformTimelineKeyframes(kfName, tl.animation, sPct, ePct);
        tLayerAnims.push({ name: kfName, total });
      }
      if (fLayer) {
        const sPct = _pct(fLayer.start || 0, total);
        const ePct = _pct((fLayer.start || 0) + (fLayer.duration || 0), total);
        const kfName = `fxF_${Math.random().toString(36).slice(2, 8)}`;
        dynKeyframes += _makeFilterTimelineKeyframes(kfName, fLayer.animation, sPct, ePct);
        fAnim = `${kfName} ${total}s linear infinite`;
      }
      if (gLayer) {
        const sPct = _pct(gLayer.start || 0, total);
        const ePct = _pct((gLayer.start || 0) + (gLayer.duration || 0), total);
        const kfName = `fxG_${Math.random().toString(36).slice(2, 8)}`;
        dynKeyframes += _makeGlowTimelineKeyframes(kfName, gLayer.animation, sPct, ePct);
        gAnim = `${kfName} ${total}s linear infinite`;
      }
    }

    const styleHtml = `
      :host { all: initial; display: block; width: 100%; height: 100%; }
      .wrap {
        width: 100%; height: 100%;
        display: flex; align-items: center; justify-content: center;
        background: ${css ? css.background : 'transparent'};
        border-radius: ${css ? css.borderRadius : '0'};
        overflow: hidden;
        position: relative;
      }
      .fx-anim {
        width: 100%; height: 100%;
        display:flex; align-items:center; justify-content:center;
        /* Transform timeline keyframes reference var(--fx-base). */
        --fx-base: ${css ? css.transform : 'translate(0px,0px)'};
        transform: var(--fx-base);
        will-change: transform;
      }
      .fx-media {
        max-width: 100%; max-height: 100%;
        width: auto; height: auto;
        object-fit: contain;
        --fx-base: ${css ? css.transform : 'none'};
        --fx-filter: ${css ? css.filter : 'brightness(1)'};
        --fx-glow: ${css ? css.glow : 'rgba(255,255,255,0.6)'};
        filter: var(--fx-filter);
        transform: var(--fx-base);
        animation: ${layers ? (fAnim || 'none') : (css ? css.animation : 'none')};
        animation-play-state: running;
        will-change: transform, filter;
      }
      ${KEYFRAMES}
      ${dynKeyframes}
    `;

    if (root) {
      // Build via DOM (not innerHTML) to keep this completely safe even if
      // src ever contained funky characters — `setAttribute('src', ...)`
      // treats the value as plain text.
      const style = document.createElement('style');
      style.textContent = styleHtml;
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      // Nested wrappers let us "chain" multiple transform animations safely
      // (each wrapper owns one animation). For filter animations we allow
      // a single layer on the <img> itself (filter animations conflict if stacked).
      let parent = wrap;
      const replayEls = [];
      if (tLayerAnims.length) {
        for (const it of tLayerAnims) {
          const d = document.createElement('div');
          d.className = 'fx-anim';
          const a = `${it.name} ${it.total}s linear infinite`;
          d.style.animation = a;
          d.dataset.fxAnim = a;
          d.style.willChange = 'transform';
          parent.appendChild(d);
          parent = d;
          replayEls.push(d);
        }
      }

      const img = document.createElement('img');
      img.className = 'fx-media';
      img.setAttribute('alt', safeAlt);
      img.setAttribute('draggable', 'false');
      img.setAttribute('decoding', 'async');
      img.setAttribute('loading', 'lazy');
      if (safeSrc) img.src = safeSrc;

      // Optional glow overlay (separate from filter track so it can combine with rainbow).
      let glowImg = null;
      if (layers && gAnim && gAnim !== 'none') {
        glowImg = document.createElement('img');
        glowImg.className = 'fx-media';
        glowImg.setAttribute('alt', safeAlt);
        glowImg.setAttribute('draggable', 'false');
        glowImg.setAttribute('decoding', 'async');
        glowImg.setAttribute('loading', 'lazy');
        if (safeSrc) glowImg.src = safeSrc;
        glowImg.style.position = 'absolute';
        glowImg.style.inset = '0';
        glowImg.style.margin = 'auto';
        glowImg.style.pointerEvents = 'none';
        glowImg.style.opacity = '0';
        // Apply glow via drop-shadow; opacity timeline controls intensity.
        glowImg.style.filter = 'drop-shadow(0 0 14px var(--fx-glow))';
        glowImg.style.animation = gAnim;
        glowImg.dataset.fxAnim = gAnim;
      }

      const freezeToCanvas = () => {
        try {
          const w = img.naturalWidth || 0;
          const h = img.naturalHeight || 0;
          if (!w || !h) return;
          const c = document.createElement('canvas');
          c.className = 'fx-media';
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(img, 0, 0, w, h);
          // Swap in the canvas to "pause" the GIF visually.
          img.replaceWith(c);
          // Keep restart handle.
          host._fxGifCanvas = c;
        } catch {}
      };

      const startGifPlayback = () => {
        if (!isGif) return;
        // If we were frozen, restore the <img>.
        try {
          if (host._fxGifCanvas && host._fxGifCanvas.parentNode) {
            host._fxGifCanvas.replaceWith(img);
            host._fxGifCanvas = null;
          }
        } catch {}
        // Restart GIF animation by resetting src.
        try {
          const s = img.src;
          img.src = '';
          img.src = s;
        } catch {}
        if (gifMode === 'paused') {
          // Freeze immediately after first frame settles.
          setTimeout(freezeToCanvas, 60);
        } else if (gifMode === 'once') {
          const ms = Math.max(300, Math.min(10000, Math.round((gifPlaySec || 2.5) * 1000)));
          setTimeout(freezeToCanvas, ms);
        }
      };

      // Store for replayAnimation()
      img.dataset.fxAnim = img.style.animation || 'none';
      replayEls.push(img);
      if (glowImg) replayEls.push(glowImg);
      host._fxReplayEls = replayEls;
      host._fxImg = img;
      host._fxRestartGif = startGifPlayback;
      // Glow needs to share the same transform wrappers. Place it alongside the base img.
      parent.appendChild(img);
      if (glowImg) parent.appendChild(glowImg);
      // Kick GIF control if configured.
      if (isGif && (gifMode === 'once' || gifMode === 'paused')) {
        // Wait for image decode to improve snapshot reliability.
        img.addEventListener('load', () => { try { startGifPlayback(); } catch {} }, { once: true });
      }
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
      host._fxImg = img;
      host._fxReplayEls = [img];
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
    replayAnimation,
    describeEffects,
    safeImageSrc: _safeImageSrc,
    defaults,
    ANIMATIONS: Array.from(ANIMATIONS),
    FILTER_RANGES,
    TRANSFORM_RANGES,
    SHADOW_RANGES,
  };
})();
