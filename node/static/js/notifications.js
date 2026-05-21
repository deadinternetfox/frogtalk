/**
 * notifications.js — Service Worker registration, Push subscription, Install prompt
 */

const Notifications = (() => {
  let _swReg = null;
  let _installPrompt = null;
  let _audioPrimed = false;

  // Word-boundary @mention detector. Prevents @frog matching inside @frogai
  // and similar prefix collisions (the original substring check fired a
  // self-mention notification when a bot whose name started with the
  // owner's nickname was @-mentioned by a third party).
  function _isMentionOf(text, nick) {
    if (!text || !nick) return false;
    try {
      const esc = String(nick).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(^|[^A-Za-z0-9_-])@' + esc + '(?![A-Za-z0-9_-])', 'i');
      return re.test(String(text));
    } catch {
      return false;
    }
  }
  const _audioDebugEnabled = () => {
    try { return window.localStorage?.getItem('ft_sound_debug') === '1'; }
    catch { return false; }
  };
  const _audioDbg = (...args) => {
    if (_audioDebugEnabled()) console.log('[FTDBG]', ...args);
  };

  // ── Service Worker registration ────────────────────────────────────────────
  async function registerSW() {
    if (!('serviceWorker' in navigator)) return null;
    // The browser throws "InvalidStateError: document is in an invalid state"
    // if we try to register before the document has finished loading. Wait
    // for 'load' if we're not ready yet.
    if (document.readyState !== 'complete') {
      await new Promise(res => window.addEventListener('load', res, { once: true }));
    }
    try {
      _swReg = await navigator.serviceWorker.register('/sw.js?v=683', { scope: '/' });
      // Note: incoming-call accept/decline is handled exclusively by the
      // in-page #incoming-call popup (driven by WS call_offer). The SW
      // notification has no action buttons and posts no ft-call-action.
      return _swReg;
    } catch (err) {
      console.warn('[SW] registration failed:', err);
      return null;
    }
  }

  // ── VAPID public key → Uint8Array ──────────────────────────────────────────
  function _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw     = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  // ── Request permission + subscribe ─────────────────────────────────────────
  async function requestPermission() {
    if (!_swReg) await registerSW();
    if (!_swReg) return;
    if (!('PushManager' in window)) return; // no push support

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;

    try {
      // Get VAPID public key
      const res = await fetch('/api/push/vapid-key', {
        headers: { 'X-Session-Token': State.token }
      });
      if (!res.ok) return;
      const { public_key } = await res.json();

      // Subscribe
      const sub = await _swReg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: _urlBase64ToUint8Array(public_key),
      });

      // Send to backend
      const subJson = sub.toJSON();
      await fetch('/api/push/subscribe', {
        method:  'POST',
        headers: {
          'Content-Type':    'application/json',
          'X-Session-Token': State.token,
        },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: {
            p256dh: subJson.keys.p256dh,
            auth:   subJson.keys.auth,
          },
        }),
      });
    } catch (err) {
      console.warn('[Push] subscribe error:', err);
    }
  }

  // ── PWA install prompt ─────────────────────────────────────────────────────
  function setupInstallPrompt() {
    // Default: hide the section. We'll reveal it only if the browser
    // actually fires beforeinstallprompt (Chrome/Edge/Brave on Android/desktop
    // when the PWA is installable). Electron, iOS Safari, Firefox, and the
    // installed-PWA case all never fire it — and a dead "not available"
    // button is worse than no button at all.
    updateInstallButton(false);

    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      _installPrompt = e;
      updateInstallButton(true);
    });

    window.addEventListener('appinstalled', () => {
      _installPrompt = null;
      updateInstallButton(false);
      toast('FrogTalk installed successfully! 🐸');
    });
  }

  function updateInstallButton(canInstall) {
    const section = document.getElementById('install-app-section');
    const btn     = document.getElementById('install-app-btn');
    const note    = document.getElementById('install-app-note');
    const show = !!(canInstall && _installPrompt);
    if (section) section.style.display = show ? '' : 'none';
    if (btn) {
      btn.disabled = !show;
      btn.style.opacity = show ? '1' : '0.5';
    }
    if (note) note.style.display = 'none';
  }

  async function promptInstall() {
    if (!_installPrompt) {
      toast('App install not available in this browser', 'error');
      return;
    }
    _installPrompt.prompt();
    const { outcome } = await _installPrompt.userChoice;
    if (outcome === 'accepted') {
      _installPrompt = null;
      updateInstallButton(false);
    }
  }

  // ── Init (called once, before launch) ─────────────────────────────────────
  async function init() {
    await registerSW();
    setupInstallPrompt();
    // Prime audio only from trusted gestures to satisfy autoplay rules.
    try {
      const prime = (ev) => {
        if (_audioPrimed) return;
        if (ev && ev.isTrusted === false) return;
        _audioPrimed = true;
        try { _unlockAudio(); } catch {}
      };
      window.addEventListener('pointerdown', prime, { once: true, passive: true });
      window.addEventListener('keydown', prime, { once: true });
      window.addEventListener('touchstart', prime, { once: true, passive: true });
    } catch {}
  }

  // ── Vibration + tone helpers ───────────────────────────────────────────────
  // _pref reads a notification preference from State.user (where ui.js stores
  // it after a profile save) with a sensible default. The values are stored as
  // 0 / 1 by the backend (SQLite ints) and as true / false in-memory after a
  // PATCH /api/auth/profile, so any falsy non-undefined value disables it.
  // (Earlier versions of this file read State.settings?.notify_* which never
  // existed — the toggles silently had no runtime effect.)
  function _pref(key, def = true) {
    const u = (typeof State !== 'undefined' && State && State.user) || null;
    if (!u) return def;
    const v = u[key];
    if (v === undefined || v === null) return def;
    if (v === 0 || v === false || v === '0') return false;
    return true;
  }
  function _isDndActive() {
    try {
      const p = String((State && State.user && State.user.presence) || '').toLowerCase();
      return p === 'dnd';
    } catch {
      return false;
    }
  }
  function _vibEnabled() {
    return localStorage.getItem('ft_notify_vibrate') !== '0';
  }
  function _vibrate(pattern) {
    if (!_vibEnabled()) return;
    try {
      // Prefer native Android bridge (works even with silent webview audio)
      if (window.Android && typeof window.Android.vibrate === 'function') {
        const ms = Array.isArray(pattern)
          ? pattern.reduce((a, b) => a + b, 0)
          : (pattern | 0);
        window.Android.vibrate(ms);
        return;
      }
    } catch {}
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {}
  }
  function _currentTone() {
    return localStorage.getItem('ft_notify_tone') || 'pop';
  }

  // ── Per-friend custom sounds ──────────────────────────────────────────────
  // Schema: ft_friend_tones → { [nick]: { msg: 'chime', ring: 'classic' } }
  const _friendTonesMem = {};
  function _friendTones() {
    try {
      const persisted = JSON.parse(localStorage.getItem('ft_friend_tones') || '{}') || {};
      return { ...persisted, ..._friendTonesMem };
    } catch {
      return { ..._friendTonesMem };
    }
  }
  function _saveFriendTones(map) {
    try { localStorage.setItem('ft_friend_tones', JSON.stringify(map || {})); }
    catch {
      throw new Error('Storage quota exceeded for friend sound settings');
    }
  }
  function _toneForFriend(nick) {
    if (!nick) return null;
    const entry = _friendTones()[nick];
    return entry?.msg || null;
  }
  function _ringForFriend(nick) {
    if (!nick) return null;
    const entry = _friendTones()[nick];
    return entry?.ring || null;
  }

  // ── Custom uploaded sounds (per-friend & app-wide) ────────────────────────
  // Stored as data URLs in a dedicated localStorage slot. Keep files capped to
  // reduce localStorage pressure while allowing short media clips.
  // Data URLs inflate binary size by ~33% and localStorage is usually ~5MB.
  // Keep custom files small enough to reliably persist across devices.
  const CUSTOM_MAX_BYTES = 10 * 1024 * 1024;
  const CUSTOM_MSG_MAX_MS = 10 * 1000;
  const CUSTOM_RING_MAX_MS = 30 * 1000;
  const _CUSTOM_MIME_FROM_EXT = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    webm: 'audio/webm',
    weba: 'audio/webm',
    aac: 'audio/aac',
    flac: 'audio/flac',
  };
  function _guessMimeFromName(name) {
    const n = String(name || '').trim().toLowerCase();
    const m = /\.([a-z0-9]+)$/.exec(n);
    if (!m) return '';
    return _CUSTOM_MIME_FROM_EXT[m[1]] || '';
  }
  function _isPlayableMimeOnDevice(mime) {
    const mt = String(mime || '').trim().toLowerCase();
    if (!mt) return false;
    try {
      const a = document.createElement('audio');
      if (!a || typeof a.canPlayType !== 'function') return true;
      const out = String(a.canPlayType(mt) || '').toLowerCase();
      return out === 'probably' || out === 'maybe';
    } catch {
      return true;
    }
  }
  function _isSupportedCustomAudioFile(file) {
    if (!file) return false;
    const type = String(file.type || '').trim().toLowerCase();
    const guessed = _guessMimeFromName(file.name || '');
    const candidates = [];
    if (type) candidates.push(type);
    if (guessed && guessed !== type) candidates.push(guessed);
    if (!candidates.length) return false;
    return candidates.some(_isPlayableMimeOnDevice);
  }
  function _customSounds() {
    try { return JSON.parse(localStorage.getItem('ft_custom_sounds') || '{}') || {}; }
    catch { return {}; }
  }
  function _saveCustomSounds(map) {
    try { localStorage.setItem('ft_custom_sounds', JSON.stringify(map || {})); }
    catch (e) {
      throw new Error('Storage quota exceeded for custom sounds');
    }
  }
  function _customKey(nick, kind) {
    return (nick ? ('friend:' + nick) : 'app') + ':' + kind;
  }
  function _getCustomSound(nick, kind) {
    return _customSounds()[_customKey(nick, kind)] || null;
  }
  function _setCustomSound(nick, kind, dataUrl) {
    const map = _customSounds();
    const key = _customKey(nick, kind);
    if (dataUrl) map[key] = dataUrl;
    else delete map[key];
    _saveCustomSounds(map);
  }
  let _customAudio = null;
  let _customAudioToken = 0;
  let _customAudioStopTimer = null;
  const _audioBlobUrlByElement = new WeakMap();
  const _audioProbeSeen = new Set();
  const _FALLBACK_PREVIEW_BEEP = 'data:audio/wav;base64,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';
  function _customMaxMsForKind(kind) {
    return kind === 'ring' ? CUSTOM_RING_MAX_MS : CUSTOM_MSG_MAX_MS;
  }
  function _clearCustomAudioStopTimer() {
    if (!_customAudioStopTimer) return;
    try { clearTimeout(_customAudioStopTimer); } catch {}
    _customAudioStopTimer = null;
  }
  function _teardownCustomAudioElement(a) {
    if (!a) return;
    try {
      const oldBlob = _audioBlobUrlByElement.get(a);
      if (oldBlob) {
        URL.revokeObjectURL(oldBlob);
        _audioBlobUrlByElement.delete(a);
      }
    } catch {}
    try {
      a.pause();
      a.currentTime = 0;
      a.src = '';
      a.load();
    } catch {}
  }
  function _isFriendSoundApiUrl(url) {
    const u = String(url || '');
    if (!u) return false;
    if (u.startsWith('/api/friends/sounds/file/')) return true;
    try {
      const abs = new URL(u, window.location.origin);
      return abs.origin === window.location.origin && abs.pathname.startsWith('/api/friends/sounds/file/');
    } catch {
      return false;
    }
  }
  function _sessionToken() {
    try { return String((typeof State !== 'undefined' && State && State.token) ? State.token : ''); }
    catch { return ''; }
  }
  function _parseMaybeUrl(url) {
    try { return new URL(String(url || ''), window.location.origin); }
    catch { return null; }
  }
  function _removeTokenQuery(url) {
    const u = _parseMaybeUrl(url);
    if (!u) return String(url || '');
    u.searchParams.delete('token');
    return (u.origin === window.location.origin) ? (u.pathname + (u.search || '')) : u.toString();
  }
  function _addTokenQuery(url, token) {
    const t = String(token || '');
    if (!t) return String(url || '');
    const u = _parseMaybeUrl(url);
    if (!u) return String(url || '');
    u.searchParams.set('token', t);
    return (u.origin === window.location.origin) ? (u.pathname + (u.search || '')) : u.toString();
  }
  function _candidateFriendSoundUrls(url) {
    const out = [];
    const raw = String(url || '');
    if (raw) out.push(raw);
    const noToken = _removeTokenQuery(raw);
    if (noToken && !out.includes(noToken)) out.push(noToken);
    const token = _sessionToken();
    if (token) {
      const withToken = _addTokenQuery(noToken || raw, token);
      if (withToken && !out.includes(withToken)) out.push(withToken);
    }
    return out;
  }
  async function _fetchFriendSoundBlobUrl(url) {
    const token = _sessionToken();
    const headers = {};
    if (token) headers['X-Session-Token'] = token;
    let lastStatus = 0;
    const candidates = _candidateFriendSoundUrls(url);
    for (const candidate of candidates) {
      const res = await fetch(candidate, {
        method: 'GET',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
      });
      lastStatus = Number(res.status || 0) || 0;
      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok) {
        _audioDbg('custom:blob-fetch-http', {
          status: lastStatus,
          candidate: String(candidate || '').slice(0, 220),
          contentType: contentType || '(none)',
        });
        continue;
      }
      const blob = await res.blob();
      const blobType = String(blob?.type || contentType || '').toLowerCase();
      if (blobType && !_isPlayableMimeOnDevice(blobType)) {
        throw new Error('unsupported_mime_' + blobType);
      }
      return {
        objectUrl: URL.createObjectURL(blob),
        contentType: contentType || blobType,
        size: Number(blob?.size || 0) || 0,
      };
    }
    throw new Error('http_' + String(lastStatus || 0));
  }
  function _scheduleCustomAutoStop(token, a, maxDurationMs) {
    const n = Number(maxDurationMs || 0);
    if (!Number.isFinite(n) || n <= 0) return;
    _customAudioStopTimer = setTimeout(() => {
      if (token !== _customAudioToken) return;
      if (_customAudio !== a) return;
      _audioDbg('custom:auto-stop', { maxDurationMs: n });
      _teardownCustomAudioElement(a);
      _customAudio = null;
      _clearCustomAudioStopTimer();
    }, n);
  }
  async function _debugProbeCustomPlayFailure(url, err, token) {
    if (!_audioDebugEnabled()) return;
    try {
      const key = String(url || '').slice(0, 256);
      if (!key || _audioProbeSeen.has(key)) return;
      _audioProbeSeen.add(key);
      const headers = {};
      const st = String((typeof State !== 'undefined' && State && State.token) ? State.token : '');
      if (st) headers['X-Session-Token'] = st;
      const res = await fetch(url, { method: 'GET', headers, credentials: 'same-origin', cache: 'no-store' });
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      _audioDbg('custom:probe', {
        token,
        status: Number(res.status || 0) || 0,
        ok: !!res.ok,
        contentType: ct || '(none)',
        error: String(err?.message || err || ''),
      });
    } catch (probeErr) {
      _audioDbg('custom:probe-failed', {
        token,
        error: String(probeErr?.message || probeErr || ''),
      });
    }
  }
  function _playAudioUrl(dataUrl, opts) {
    if (!dataUrl) return false;
    const token = ++_customAudioToken;
    _clearCustomAudioStopTimer();
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      try { opts?._resolveResult?.({ ok: !!ok, error: error ? String(error) : '' }); } catch {}
    };
    try {
      if (_customAudio) {
        _teardownCustomAudioElement(_customAudio);
      }
      const a = new Audio(dataUrl);
      a.volume = opts?.volume ?? 0.9;
      if (opts?.playbackRate) a.playbackRate = opts.playbackRate;
      a.addEventListener('ended', () => {
        if (token !== _customAudioToken) return;
        _clearCustomAudioStopTimer();
        if (_customAudio === a) _customAudio = null;
      }, { once: true });
      _customAudio = a;
      _audioDbg('custom:play-attempt', {
        token,
        kind: String(opts?.kind || ''),
        isFriendUrl: _isFriendSoundApiUrl(dataUrl),
        sourcePreview: String(dataUrl).slice(0, 120),
      });
      a.play().then(() => {
        if (token !== _customAudioToken) {
          _teardownCustomAudioElement(a);
          finish(false, 'play_interrupted');
          return;
        }
        _scheduleCustomAutoStop(token, a, opts?.maxDurationMs);
        finish(true, '');
      }).catch(async (err) => {
        _audioDbg('custom:play-rejected', {
          token,
          message: String(err?.message || err || ''),
          kind: String(opts?.kind || ''),
        });
        if (token !== _customAudioToken) return;
        if (!_isFriendSoundApiUrl(dataUrl)) {
          if (_audioDebugEnabled()) console.warn('[FTDBG] custom play rejected', String(err?.message || err || 'play_failed'));
          void _debugProbeCustomPlayFailure(dataUrl, err, token);
          finish(false, String(err?.message || err || 'play_failed'));
          return;
        }
        try {
          const fetched = await _fetchFriendSoundBlobUrl(dataUrl);
          if (token !== _customAudioToken) return;
          _audioDbg('custom:blob-retry', {
            token,
            contentType: fetched.contentType || '(none)',
            size: fetched.size,
          });
          try {
            const oldBlob = _audioBlobUrlByElement.get(a);
            if (oldBlob) URL.revokeObjectURL(oldBlob);
          } catch {}
          _audioBlobUrlByElement.set(a, fetched.objectUrl);
          a.src = fetched.objectUrl;
          a.load();
          await a.play();
          if (token !== _customAudioToken) {
            _teardownCustomAudioElement(a);
            finish(false, 'play_interrupted');
            return;
          }
          _scheduleCustomAutoStop(token, a, opts?.maxDurationMs);
          _audioDbg('custom:blob-retry-ok', { token });
          finish(true, '');
        } catch (retryErr) {
          _audioDbg('custom:blob-retry-failed', {
            token,
            message: String(retryErr?.message || retryErr || ''),
          });
          if (_audioDebugEnabled()) console.warn('[FTDBG] custom play rejected', String(retryErr?.message || retryErr || 'play_failed'));
          void _debugProbeCustomPlayFailure(dataUrl, retryErr, token);
          finish(false, String(retryErr?.message || retryErr || 'play_failed'));
        }
      });
      return true;
    } catch {
      finish(false, 'play_exception');
      return false;
    }
  }
  function _playCustomSoundWithResult(dataUrl, kind) {
    return new Promise((resolve) => {
      const started = _playAudioUrl(dataUrl, {
        volume: 0.9,
        maxDurationMs: _customMaxMsForKind(kind),
        kind: kind === 'ring' ? 'ring' : 'msg',
        reportErrors: true,
        _resolveResult: resolve,
      });
      if (!started) resolve({ ok: false, error: 'play_not_started' });
    });
  }
  function _playCustomSound(dataUrl, kind) {
    return _playAudioUrl(dataUrl, {
      volume: 0.9,
      maxDurationMs: _customMaxMsForKind(kind),
      kind: kind === 'ring' ? 'ring' : 'msg',
    });
  }
  function _playPreviewFallback(kind, tone) {
    const maps = kind === 'ring'
      ? { default: 0.95, classic: 0.9, digital: 1.05, melody: 1.12, marimba: 1.18, sonar: 0.82 }
      : { pop: 1.0, chime: 1.1, ding: 1.2, click: 0.85, bell: 1.25, soft: 0.9, bubble: 1.3, zap: 1.4, coin: 1.15, knock: 0.75 };
    return _playAudioUrl(_FALLBACK_PREVIEW_BEEP, {
      volume: 0.95,
      playbackRate: maps[tone] || 1.0,
    });
  }
  function _stopCustomSound() {
    _customAudioToken += 1;
    _clearCustomAudioStopTimer();
    if (!_customAudio) return;
    _teardownCustomAudioElement(_customAudio);
    _customAudio = null;
  }
  function _stopAllPreviewAudio() {
    _stopCustomSound();
    try {
      if (_sharedCtx && _sharedCtx.state !== 'closed') {
        _sharedCtx.close();
      }
    } catch {}
    _sharedCtx = null;
  }

  // ── Message-tone catalog (used for default + per-friend alerts) ───────────
  // Every tone is a function of an AudioContext + optional callback-on-done.
  const MSG_TONES = {
    pop:    ctx => _burstSeq(ctx, [[660, 0, 0.18, 0.18]]),
    chime:  ctx => _burstSeq(ctx, [[660,0,0.25,0.18],[880,0.12,0.28,0.18],[1100,0.24,0.32,0.18]]),
    ding:   ctx => _burstSeq(ctx, [[1320,0,0.45,0.22,'triangle']]),
    click:  ctx => _burstSeq(ctx, [[220,0,0.05,0.25,'square']]),
    bell:   ctx => _burstSeq(ctx, [[1760,0,0.5,0.18,'sine'],[2349,0.02,0.45,0.10,'sine']]),
    soft:   ctx => _burstSeq(ctx, [[392,0,0.3,0.14,'sine'],[523,0.12,0.35,0.14,'sine']]),
    bubble: ctx => _burstSeq(ctx, [[523,0,0.08,0.22,'sine'],[784,0.06,0.1,0.22,'sine'],[1047,0.13,0.12,0.18,'sine']]),
    zap:    ctx => _burstSeq(ctx, [[220,0,0.05,0.26,'sawtooth'],[880,0.03,0.08,0.22,'square'],[1760,0.08,0.06,0.18,'triangle']]),
    coin:   ctx => _burstSeq(ctx, [[988,0,0.08,0.22,'square'],[1319,0.06,0.14,0.22,'square']]),
    knock:  ctx => _burstSeq(ctx, [[180,0,0.05,0.25,'sine'],[180,0.15,0.05,0.25,'sine']]),
    silent: () => {},
  };

  // ── Ringtone catalog — each returns {stop(), totalMs} style or plays a
  //    fixed pattern. Called every 2 seconds by startRinging's loop.
  const RING_TONES = {
    default: ctx => _burstSeq(ctx, [[440,0,0.25,0.30],[550,0.25,0.25,0.30]], { sustain: 0.15 }),
    classic: ctx => _burstSeq(ctx, [
      [480,0,0.20,0.28,'sine'],[620,0.02,0.20,0.28,'sine'],
      [480,0.40,0.20,0.28,'sine'],[620,0.42,0.20,0.28,'sine'],
    ], { sustain: 0.08 }),
    digital: ctx => _burstSeq(ctx, [
      [988,0,0.08,0.25,'square'],[988,0.12,0.08,0.25,'square'],
      [988,0.24,0.08,0.25,'square'],[988,0.36,0.08,0.25,'square'],
    ]),
    melody: ctx => _burstSeq(ctx, [
      [784,0,0.18,0.22,'triangle'],[988,0.18,0.18,0.22,'triangle'],
      [1175,0.36,0.18,0.22,'triangle'],[988,0.54,0.22,0.22,'triangle'],
    ]),
    marimba: ctx => _burstSeq(ctx, [
      [523,0,0.14,0.26,'sine'],[659,0.14,0.14,0.26,'sine'],
      [784,0.28,0.14,0.26,'sine'],[1047,0.42,0.20,0.26,'sine'],
    ]),
    sonar: ctx => _burstSeq(ctx, [[330,0,0.4,0.26,'sine'],[262,0.4,0.5,0.22,'sine']], { sustain: 0.2 }),
    silent: () => {},
  };

  // Generic scheduler used by both catalogs. `steps` is an array of
  // [freq, startOffset, duration, volume, type?]. `opts.sustain` holds the
  // note at peak volume for that long before decaying (for ring-style tones).
  function _burstSeq(ctx, steps, opts) {
    const sustain = opts?.sustain || 0;
    steps.forEach(([freq, start, dur, vol, type]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + start;
      const amp = Math.max(0.01, Math.min(0.9, (vol || 0.2) * 2.0));
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(amp, t + 0.015);
      if (sustain > 0) gain.gain.setValueAtTime(amp, t + sustain);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur + sustain);
      osc.start(t);
      osc.stop(t + dur + sustain + 0.02);
    });
    const totalMs = Math.max(
      ...steps.map(([, s, d]) => (s + d + sustain)),
    ) * 1000 + 40;
    // Do NOT close the shared context — just let oscillators stop naturally.
    void totalMs;
  }

  function _playTone(name, opts) {
    if (!opts?.force && !_pref('notify_sounds', true)) {
      return { ok: false, reason: 'notify_sounds_disabled' };
    }
    try {
      const tone = name || _currentTone();
      if (tone === 'silent') return { ok: false, reason: 'tone_silent' };
      // Custom uploaded app-wide tone
      if (tone === 'custom') {
        const data = _getCustomSound(null, 'msg');
        if (data) {
          _playCustomSound(data, 'msg');
          return { ok: true, mode: 'custom' };
        }
      }
      // Per-friend custom: "custom:<nick>"
      if (typeof tone === 'string' && tone.startsWith('custom:')) {
        const nick = tone.slice(7);
        const data = _getCustomSound(nick, 'msg');
        if (data) {
          _playCustomSound(data, 'msg');
          return { ok: true, mode: 'custom-friend' };
        }
      }
      const fn = MSG_TONES[tone] || MSG_TONES.pop;
      const tag = opts?.preview ? ('preview-tone:' + tone) : ('tone:' + tone);
      const ok = _playWithCtx(fn, tag);
      if (ok) {
        return { ok: true, mode: opts?.preview ? 'webaudio-preview' : 'webaudio' };
      }
      if (opts?.preview) {
        const fb = _playPreviewFallback('msg', tone);
        return fb ? { ok: true, mode: 'htmlaudio-preview' } : { ok: false, reason: 'preview_fallback_failed' };
      }
      return { ok: false, reason: 'webaudio_unavailable' };
    } catch (e) { console.warn('[FT sound]', e); }
    return { ok: false, reason: 'tone_exception' };
  }

  function _playRing(name, opts) {
    if (!opts?.force && !_pref('notify_sounds', true)) {
      return { ok: false, reason: 'notify_sounds_disabled' };
    }
    try {
      const tone = name || 'default';
      if (tone === 'silent') return { ok: false, reason: 'ring_silent' };
      if (tone === 'custom') {
        const data = _getCustomSound(null, 'ring');
        if (data) {
          _playCustomSound(data, 'ring');
          return { ok: true, mode: 'custom' };
        }
      }
      if (typeof tone === 'string' && tone.startsWith('custom:')) {
        const nick = tone.slice(7);
        const data = _getCustomSound(nick, 'ring');
        if (data) {
          _playCustomSound(data, 'ring');
          return { ok: true, mode: 'custom-friend' };
        }
      }
      const fn = RING_TONES[tone] || RING_TONES.default;
      const tag = opts?.preview ? ('preview-ring:' + tone) : ('ring:' + tone);
      const ok = _playWithCtx(fn, tag);
      if (ok) {
        return { ok: true, mode: opts?.preview ? 'webaudio-preview' : 'webaudio' };
      }
      if (opts?.preview) {
        const fb = _playPreviewFallback('ring', tone);
        return fb ? { ok: true, mode: 'htmlaudio-preview' } : { ok: false, reason: 'preview_fallback_failed' };
      }
      return { ok: false, reason: 'webaudio_unavailable' };
    } catch (e) { console.warn('[FT ring]', e); }
    return { ok: false, reason: 'ring_exception' };
  }

  // Shared AudioContext — created once, kept alive and resumed synchronously
  // inside click/touch handlers so mobile browsers accept it as a user gesture.
  let _sharedCtx = null;
  function _getCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    // Never create a context before first trusted user gesture.
    // This avoids autoplay-policy warnings and blocked resume attempts.
    if (!_audioPrimed && !_sharedCtx) return null;
    if (!_sharedCtx || _sharedCtx.state === 'closed') {
      try {
        _sharedCtx = new AC();
      } catch {
        return null;
      }
    }
    // resume() synchronously within a user-gesture call stack is accepted by
    // all browsers; the returned promise is for the state change propagation.
    if (_sharedCtx.state === 'suspended') {
      try {
        _sharedCtx.resume();
      } catch {}
    }
    return _sharedCtx;
  }

  function _unlockAudio() {
    _audioPrimed = true;
    const ctx = _getCtx();
    if (!ctx) return false;
    try {
      if (ctx.state === 'suspended') {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      return true;
    } catch {
      return false;
    }
  }

  function _playWithCtx(fn, tag) {
    const ctx = _getCtx();
    if (!ctx) return false;
    const run = () => { try { fn(ctx); } catch (e) { console.warn('[FT ctx]', e); } };
    if (ctx.state === 'running') {
      run();
      return true;
    }
    // Schedule immediately in the same trusted gesture tick; this is more
    // reliable on mobile/webview than waiting for resume() promise timing.
    run();
    try {
      const p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
    return true;
  }

  return { init, registerSW, requestPermission, promptInstall,
    unlockAudio() { return _unlockAudio(); },
    previewTone(name, opts) { const r = _playTone(name, opts); _vibrate(80); return r; },
    previewRingtone(name, opts) { return _playRing(name, opts); },
    // Per-friend sound settings API (used by friends UI)
    getFriendTones: _friendTones,
    setFriendTones(map) {
      try {
        _saveFriendTones(map);
        return true;
      } catch {
        return false;
      }
    },
    setFriendSound(nick, kind, tone) {
      if (!nick) return;
      const map = _friendTones();
      map[nick] = map[nick] || {};
      if (tone && tone !== 'default') map[nick][kind] = tone;
      else delete map[nick][kind];
      if (!map[nick].msg && !map[nick].ring) delete map[nick];
      try {
        _saveFriendTones(map);
        delete _friendTonesMem[nick];
        return true;
      } catch {
        // Storage full: keep selection active for this runtime session.
        _friendTonesMem[nick] = _friendTonesMem[nick] || {};
        if (tone && tone !== 'default') _friendTonesMem[nick][kind] = tone;
        else delete _friendTonesMem[nick][kind];
        if (!_friendTonesMem[nick].msg && !_friendTonesMem[nick].ring) delete _friendTonesMem[nick];
        return false;
      }
    },
    getFriendSound(nick, kind) {
      if (kind === 'ring') return _ringForFriend(nick);
      return _toneForFriend(nick);
    },
    MSG_TONES_LIST: Object.keys(MSG_TONES),
    RING_TONES_LIST: Object.keys(RING_TONES),

    // Custom uploaded sound API
    getCustomSound(nick, kind) { return _getCustomSound(nick, kind); },
    setCustomSound(nick, kind, dataUrl) { _setCustomSound(nick, kind, dataUrl); },
    // Accepts a File/Blob, returns a Promise<{ok, error?, dataUrl?, asset?}>
    uploadCustomSound(nick, kind, file, onProgress) {
      return new Promise((resolve) => {
        if (!file) return resolve({ ok: false, error: 'No file' });
        if (
          !/^audio\//i.test(file.type)
          && !/^video\/(mp4|webm)$/i.test(file.type)
          && !/\.(mp3|wav|ogg|m4a|aac|opus|flac|mp4|webm)$/i.test(file.name || '')
        ) {
          return resolve({ ok: false, error: 'Unsupported file type' });
        }
        if (!_isSupportedCustomAudioFile(file)) {
          return resolve({ ok: false, error: 'This audio format is not playable on your device. Use MP3, WAV, M4A, OGG, or WEBM.' });
        }

        const sessionToken = (typeof State !== 'undefined' && State && State.token) ? String(State.token) : '';
        const safeKind = kind === 'ring' ? 'ring' : 'msg';
        if (nick && sessionToken) {
          const fd = new FormData();
          fd.append('media', file, file.name || 'sound');
          const xhr = new XMLHttpRequest();
          const TIMEOUT_MS = 120000;
          let settled = false;
          const finish = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
          };
          xhr.upload.onprogress = (ev) => {
            if (!onProgress || !ev || !ev.lengthComputable) return;
            try {
              // Reserve 0-90 for actual upload bytes, 90-100 for server processing
              const pct = Math.max(5, Math.min(90, Math.round((ev.loaded / ev.total) * 90)));
              onProgress(pct);
            } catch {}
          };
          xhr.upload.onloadstart = () => {
            try { if (onProgress) onProgress(5); } catch {}
          };
          xhr.onload = () => {
            try { if (onProgress) onProgress(95); } catch {}
            let payload = {};
            try { payload = JSON.parse(xhr.responseText); } catch {}
            if (xhr.status < 200 || xhr.status >= 300 || !payload?.ok || !payload?.asset?.url) {
              return finish({ ok: false, error: payload?.error || ('Upload failed (' + xhr.status + ')') });
            }
            const separator = payload.asset.url.includes('?') ? '&' : '?';
            const authedUrl = payload.asset.url + separator + 'token=' + encodeURIComponent(sessionToken);
            try { _setCustomSound(nick, safeKind, authedUrl); } catch {}
            try { if (onProgress) onProgress(100); } catch {}
            finish({ ok: true, dataUrl: authedUrl, asset: payload.asset });
          };
          xhr.onerror = () => finish({ ok: false, error: 'Upload failed' });
          xhr.onabort = () => finish({ ok: false, error: 'Upload timed out' });
          xhr.ontimeout = () => finish({ ok: false, error: 'Upload timed out' });
          xhr.timeout = TIMEOUT_MS;
          xhr.open('POST', '/api/friends/sounds/upload/' + encodeURIComponent(nick) + '/' + safeKind);
          xhr.setRequestHeader('X-Session-Token', sessionToken);
          xhr.withCredentials = true;
          xhr.send(fd);
          return;
        }

        if (file.size > CUSTOM_MAX_BYTES) {
          return resolve({ ok: false, error: 'File too large (max 10 MB)' });
        }
        const fr = new FileReader();
        fr.onprogress = (ev) => {
          if (!onProgress || !ev || !ev.lengthComputable) return;
          try {
            const pct = Math.max(0, Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
            onProgress(pct);
          } catch {}
        };
        fr.onload = () => {
          try {
            _setCustomSound(nick, safeKind, fr.result);
            if (onProgress) {
              try { onProgress(100); } catch {}
            }
            resolve({ ok: true, dataUrl: fr.result });
          } catch (e) {
            const msg = (e && e.message) ? e.message : String(e);
            resolve({ ok: false, error: msg || 'Failed to store custom sound' });
          }
        };
        fr.onerror = () => {
          resolve({ ok: false, error: 'Read failed' });
        };
        fr.readAsDataURL(file);
      });
    },
    CUSTOM_SOUND_MAX_BYTES: CUSTOM_MAX_BYTES,
    CUSTOM_SOUND_MAX_MSG_SECONDS: CUSTOM_MSG_MAX_MS / 1000,
    CUSTOM_SOUND_MAX_RING_SECONDS: CUSTOM_RING_MAX_MS / 1000,
    canPlayCustomContentType(contentType) { return _isPlayableMimeOnDevice(contentType); },
    playCustomSound(dataUrl, kind) { return _playCustomSound(dataUrl, kind); },
    previewCustomSound(dataUrl, kind) { return _playCustomSoundWithResult(dataUrl, kind); },
    stopCustomSound() { _stopCustomSound(); },
    stopAllPreviewAudio() { _stopAllPreviewAudio(); },

    // In-app + desktop notification for a new message
    notify(msg) {
      if (_isDndActive()) return;
      const myNick = State.user?.nickname || '';
      const contentText = (msg.content || '').replace(/<[^>]+>/g, '');
      // Word-boundary check — substring matches caused @frogai to also
      // trigger a self-mention for user @frog. Nickname charset matches
      // the server NICKNAME_RE (letters, digits, underscore, hyphen).
      let isMention = !!(myNick && _isMentionOf(contentText, myNick));
      // notify_mentions toggle: when off, demote a mention to a regular message
      // notification (no mention-boost sound, no "@you" title).
      if (isMention && !_pref('notify_mentions', true)) isMention = false;
      _vibrate(isMention ? [30, 40, 30, 40, 60] : 40);
      // Friendly fallback body so media-only messages don't show a blank tray
      // entry. Picks an icon from the media_type when available.
      const _mediaIcon = (mt) => {
        const t = String(mt || '').toLowerCase();
        if (t.startsWith('image')) return '🖼️ Image';
        if (t.startsWith('video')) return '🎬 Video';
        if (t.startsWith('audio')) return '🎵 Voice note';
        return '📎 Media';
      };
      const _bodyText = contentText
        || (msg.has_media || msg.media_type ? _mediaIcon(msg.media_type) : 'New message');

      // Play sound (only if sound is not disabled in settings)
      if (_pref('notify_sounds', true)) {
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          if (isMention) {
            // Two-tone ping for mentions
            [880, 1100].forEach((freq, i) => {
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.connect(gain); gain.connect(ctx.destination);
              osc.type = 'sine';
              osc.frequency.value = freq;
              const t = ctx.currentTime + i * 0.12;
              gain.gain.setValueAtTime(0, t);
              gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
              gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
              osc.start(t); osc.stop(t + 0.25);
            });
          } else {
            // Soft single pop for normal messages
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.value = 660;
            gain.gain.setValueAtTime(0, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
            osc.start(); osc.stop(ctx.currentTime + 0.2);
          }
          setTimeout(() => ctx.close(), 500);
        } catch {}
      }

      // Desktop notification — guarded with typeof because the Notification
      // global is undefined in some Android WebViews. An unguarded reference
      // throws ReferenceError and kills the rest of this handler before the
      // window.Android.showNotification bridge call below can fire — which is
      // why foreground-app users heard the JS "tink" but got no tray entry.
      if (_pref('notify_desktop', true) &&
          typeof Notification !== 'undefined' &&
          Notification.permission === 'granted') {
        try {
          const title = isMention
            ? `${msg.nickname} mentioned you in #${msg.room_name || 'chat'}`
            : `${msg.nickname} in #${msg.room_name || 'chat'}`;
          new Notification(title, {
            body: _bodyText.slice(0, 100),
            icon: '/static/icons/icon-192.png',
            tag: 'frogtalk-msg-' + (msg.room_name || 'dm'),
          });
        } catch {}
      }
      // Native Android bridge — fires even when the web Notification API
      // is blocked inside the WebView.
      try {
        if (window.Android && typeof window.Android.showNotification === 'function') {
          const title = isMention
            ? `${msg.nickname} mentioned you in #${msg.room_name || 'chat'}`
            : `${msg.nickname} in #${msg.room_name || 'chat'}`;
          window.Android.showNotification(title, _bodyText.slice(0, 140));
        }
      } catch {}
    },

    // DM message notification
    notifyDM(msg) {
      if (_isDndActive()) return;
      // Hard guard: never alert for our own echoed-back DM
      try {
        const selfId = State.user?.id;
        const selfNick = State.user?.nickname;
        const sid = msg.sender_id;
        const snick = msg.sender_nickname || msg.sender_nick || msg.nickname;
        if ((sid && selfId && sid === selfId) ||
            (snick && selfNick && String(snick).toLowerCase() === String(selfNick).toLowerCase())) {
          return;
        }
      } catch {}
      // Check DM notification setting — if disabled, skip tray/sound/vibration
      const dmNotifsOn = _pref('notify_dms', true);
      if (!dmNotifsOn) return;
      _vibrate([40, 60, 40]);
      // Per-friend custom alert tone takes precedence over the built-in double-pop.
      const senderNick = msg.sender_nickname || msg.sender_nick || msg.nickname;
      const custom = _toneForFriend(senderNick);
      if (_pref('notify_sounds', true)) {
        if (custom === 'custom') {
          // User uploaded a file for this specific friend
          const data = _getCustomSound(senderNick, 'msg');
          if (data) _playCustomSound(data, 'msg');
          else _playTone('pop');
        } else if (custom) {
          _playTone(custom);
        } else {
          try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            // Two soft pops for DM — friendly double-knock (default)
            [520, 680].forEach((freq, i) => {
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.connect(gain); gain.connect(ctx.destination);
              osc.type = 'sine';
              osc.frequency.value = freq;
              const t = ctx.currentTime + i * 0.15;
              gain.gain.setValueAtTime(0, t);
              gain.gain.linearRampToValueAtTime(0.2, t + 0.015);
              gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
              osc.start(t); osc.stop(t + 0.22);
            });
            setTimeout(() => ctx.close(), 600);
          } catch {}
        }
      }
      // Desktop notification for DM — guarded with typeof because the
      // Notification global is undefined in some Android WebViews. An
      // unguarded reference throws ReferenceError and kills the rest of
      // notifyDM before the window.Android.showNotification bridge call
      // below can fire — that was the foreground-tink-no-tray bug.
      // Call-log system messages embed JSON as their content
      // ([[CALLLOG]]{...}) — render a friendly one-liner instead of the
      // raw payload that would otherwise leak into the notification.
      const _bodyForPush = (() => {
        const raw = String(msg.content || '');
        if (raw.startsWith('[[CALLLOG]]')) {
          try {
            const meta = JSON.parse(raw.slice('[[CALLLOG]]'.length));
            const icon = meta.icon || '📞';
            const t = meta.title ? String(meta.title) : 'Call';
            const sub = meta.subtitle ? ` · ${meta.subtitle}` : '';
            return `${icon} ${t}${sub}`;
          } catch { return '📞 Call'; }
        }
        const stripped = raw.replace(/<[^>]+>/g, '').slice(0, 140);
        if (stripped) return stripped;
        // Media-only DM: pick a friendly icon by media_type.
        const mt = String(msg.media_type || '').toLowerCase();
        if (mt.startsWith('image')) return '🖼️ Image';
        if (mt.startsWith('video')) return '🎬 Video';
        if (mt.startsWith('audio')) return '🎵 Voice note';
        if (msg.has_media || mt) return '📎 Media';
        return 'New message';
      })();
      if (_pref('notify_desktop', true) &&
          typeof Notification !== 'undefined' &&
          Notification.permission === 'granted') {
        try {
          new Notification(`${msg.sender_nickname || msg.sender_nick || msg.nickname || 'Someone'} sent you a message`, {
            body: _bodyForPush.slice(0, 100),
            icon: '/static/icons/icon-192.png',
            tag: 'frogtalk-dm-' + (msg.sender_nickname || 'dm'),
          });
        } catch {}
      }
      // Native Android notification (WebView bridge). The web Notification API is
      // usually a no-op inside a WebView, so we push through Android directly.
      try {
        if (window.Android && typeof window.Android.showNotification === 'function') {
          const title = `${msg.sender_nickname || msg.sender_nick || msg.nickname || 'Someone'} sent you a message`;
          window.Android.showNotification(title, _bodyForPush);
        }
      } catch {}
      // Electron desktop app bridge
      try {
        if (window.desktopApp && typeof window.desktopApp.showNotification === 'function') {
          window.desktopApp.showNotification(
            `${msg.sender_nickname || msg.sender_nick || msg.nickname || 'Someone'}`,
            _bodyForPush
          );
        }
      } catch {}
    },

    // Incoming call ringtone — repeating two-tone ring
    _ringInterval: null,
    _ringAudio: null,
    _ringCtx: null,
    startRinging(peerNick) {
      this.stopRinging();
      // First try an <audio> element — it survives autoplay restrictions after
      // any prior user gesture on the page (login click, etc.) better than
      // spinning up a fresh AudioContext each time.
      try {
        if (!this._ringAudio) {
          // Short beep encoded as a data-URI WAV (440 Hz, 0.3 s) — fallback tone.
          // eslint-disable-next-line max-len
          const BEEP = 'data:audio/wav;base64,UklGRtQkAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YbAkAAA=';
          const a = new Audio(BEEP);
          a.loop = true;
          a.volume = 0.7;
          this._ringAudio = a;
        }
        // Best-effort play — may reject if no user interaction yet.
        this._ringAudio.currentTime = 0;
        const p = this._ringAudio.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {}
      // Create ONE AudioContext for the entire ring session and reuse it.
      // This avoids the "AudioContext was not allowed to start" warning that
      // fires every 2 s when a new context is created inside the interval.
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx && (!this._ringCtx || this._ringCtx.state === 'closed')) {
          this._ringCtx = new Ctx();
        }
        if (this._ringCtx && this._ringCtx.state === 'suspended') {
          const rp = this._ringCtx.resume();
          if (rp && typeof rp.catch === 'function') rp.catch(() => {});
        }
      } catch {}
      const customRing = _ringForFriend(peerNick);
      const appRing    = (typeof localStorage !== 'undefined' && localStorage.getItem('ft_notify_ring')) || null;
      const chosenRing = customRing || appRing;  // friend-specific beats app-wide
      const ring = () => {
        _vibrate([200, 100, 200, 100, 400]);
        try {
          if (window.Android && typeof window.Android.playNotificationTone === 'function') {
            window.Android.playNotificationTone();
          }
        } catch {}
        // Friend has an uploaded audio file for ringtone
        if (chosenRing === 'custom' && peerNick) {
          const data = _getCustomSound(peerNick, 'ring');
          if (data) { _playCustomSound(data, 'ring'); return; }
        }
        if (chosenRing && chosenRing !== 'default') {
          _playRing(chosenRing);
          return;
        }
        try {
          // Reuse the session-scoped context — no new AudioContext() each 2 s.
          const ctx = this._ringCtx;
          if (!ctx || ctx.state === 'closed') return;
          if (ctx.state === 'suspended') {
            const rp = ctx.resume();
            if (rp && typeof rp.catch === 'function') rp.catch(() => {});
          }
          // Phone-style two-tone ring (default)
          [440, 550].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.value = freq;
            const t = ctx.currentTime + i * 0.25;
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(0.3, t + 0.02);
            gain.gain.setValueAtTime(0.3, t + 0.15);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
            osc.start(t); osc.stop(t + 0.25);
          });
        } catch {}
      };
      ring();
      this._ringInterval = setInterval(ring, 2000);
    },
    stopRinging() {
      if (this._ringInterval) { clearInterval(this._ringInterval); this._ringInterval = null; }
      if (this._ringAudio) { try { this._ringAudio.pause(); this._ringAudio.currentTime = 0; } catch {} }
      if (this._ringCtx) { try { this._ringCtx.close(); } catch {} this._ringCtx = null; }
    },

    // Friend request notification
    notifyFriend(data) {
      _vibrate([50, 80, 50]);
      if (_pref('notify_sounds', true)) {
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          // Cheerful three-note chime
          [523, 659, 784].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.value = freq;
            const t = ctx.currentTime + i * 0.12;
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
            osc.start(t); osc.stop(t + 0.32);
          });
          setTimeout(() => ctx.close(), 800);
        } catch {}
      }
      // Desktop notification for friend events
      if (_pref('notify_desktop', true) && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const kind = data.kind || data.type || 'friend';
          const who = data.from_nickname || data.nickname || 'Someone';
          let title = `${who}`;
          let body = '';
          if (kind === 'friend_request' || kind === 'request') { title += ' sent you a friend request'; body = 'Open FrogTalk to accept'; }
          else if (kind === 'friend_accept' || kind === 'accept') { title += ' accepted your friend request'; body = 'You are now friends'; }
          else { title += ' — friend update'; body = data.text || ''; }
          new Notification(title, {
            body, icon: '/static/icons/icon-192.png', tag: 'frogtalk-friend-' + who,
          });
        } catch {}
      }
    },
  };
})();

// Make Notifications accessible to non-module scripts (friends.js, etc.).
try { window.Notifications = Notifications; } catch {}
try { globalThis.Notifications = Notifications; } catch {}

// Auto-register SW when script loads (before auth)
Notifications.init();
