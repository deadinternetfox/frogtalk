/**
 * notifications.js — Service Worker registration, Push subscription, Install prompt
 */

const Notifications = (() => {
  let _swReg = null;
  let _installPrompt = null;
  let _audioPrimed = false;

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
      _swReg = await navigator.serviceWorker.register('/sw.js?v=190', { scope: '/' });
      console.log('[SW] registered, scope:', _swReg.scope);
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
      console.log('[Push] Subscribed successfully');
    } catch (err) {
      console.warn('[Push] subscribe error:', err);
    }
  }

  // ── PWA install prompt ─────────────────────────────────────────────────────
  function setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      _installPrompt = e;
      // Update install button visibility in settings
      updateInstallButton(true);
    });

    window.addEventListener('appinstalled', () => {
      _installPrompt = null;
      updateInstallButton(false);
      toast('FrogTalk installed successfully! 🐸');
    });
    
    // Check if running as PWA
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
      updateInstallButton(false);
    }
  }
  
  function updateInstallButton(canInstall) {
    const btn = document.getElementById('install-app-btn');
    const note = document.getElementById('install-app-note');
    const section = document.getElementById('install-app-section');
    
    if (btn) {
      if (canInstall && _installPrompt) {
        btn.disabled = false;
        btn.style.opacity = '1';
        if (note) note.style.display = 'none';
      } else {
        btn.disabled = true;
        btn.style.opacity = '0.5';
        if (note) note.style.display = 'block';
      }
    }
  }

  async function promptInstall() {
    if (!_installPrompt) {
      toast('App install not available', 'error');
      return;
    }
    _installPrompt.prompt();
    const { outcome } = await _installPrompt.userChoice;
    console.log('[PWA] install outcome:', outcome);
    if (outcome === 'accepted') {
      _installPrompt = null;
      updateInstallButton(false);
    }
  }

  // ── Init (called once, before launch) ─────────────────────────────────────
  async function init() {
    await registerSW();
    setupInstallPrompt();
    // Prime WebAudio once on user interaction so incoming-call rings work
    // reliably across browsers with autoplay restrictions.
    try {
      const prime = () => {
        if (_audioPrimed) return;
        _audioPrimed = true;
        try {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return;
          const ctx = new Ctx();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          gain.gain.value = 0;
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(); osc.stop(ctx.currentTime + 0.01);
          if (ctx.state === 'suspended') {
            const p = ctx.resume();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          }
          setTimeout(() => { try { if (ctx.state !== 'closed') ctx.close(); } catch {} }, 50);
        } catch {}
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
  function _friendTones() {
    try { return JSON.parse(localStorage.getItem('ft_friend_tones') || '{}') || {}; }
    catch { return {}; }
  }
  function _saveFriendTones(map) {
    try { localStorage.setItem('ft_friend_tones', JSON.stringify(map || {})); }
    catch {}
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
  // Stored as data URLs in a dedicated localStorage slot. Size-capped at ~2MB
  // per file to avoid blowing the quota.
  const CUSTOM_MAX_BYTES = 2 * 1024 * 1024;
  function _customSounds() {
    try { return JSON.parse(localStorage.getItem('ft_custom_sounds') || '{}') || {}; }
    catch { return {}; }
  }
  function _saveCustomSounds(map) {
    try { localStorage.setItem('ft_custom_sounds', JSON.stringify(map || {})); }
    catch (e) { console.warn('Custom sound save failed (quota?)', e); }
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
  function _playCustomSound(dataUrl) {
    if (!dataUrl) return;
    try {
      if (_customAudio) { try { _customAudio.pause(); } catch {} }
      _customAudio = new Audio(dataUrl);
      _customAudio.volume = 0.9;
      _customAudio.play().catch(() => {});
    } catch {}
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
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(vol, t + 0.015);
      if (sustain > 0) gain.gain.setValueAtTime(vol, t + sustain);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur + sustain);
      osc.start(t);
      osc.stop(t + dur + sustain + 0.02);
    });
    const totalMs = Math.max(
      ...steps.map(([, s, d]) => (s + d + sustain)),
    ) * 1000 + 40;
    setTimeout(() => { try { ctx.close(); } catch {} }, totalMs);
  }

  function _playTone(name, opts) {
    if (!opts?.force && !_pref('notify_sounds', true)) return;
    try {
      const tone = name || _currentTone();
      if (tone === 'silent') return;
      // Custom uploaded app-wide tone
      if (tone === 'custom') {
        const data = _getCustomSound(null, 'msg');
        if (data) return _playCustomSound(data);
      }
      // Per-friend custom: "custom:<nick>"
      if (typeof tone === 'string' && tone.startsWith('custom:')) {
        const nick = tone.slice(7);
        const data = _getCustomSound(nick, 'msg');
        if (data) return _playCustomSound(data);
      }
      const fn = MSG_TONES[tone] || MSG_TONES.pop;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      fn(ctx);
    } catch {}
  }

  function _playRing(name, opts) {
    if (!opts?.force && !_pref('notify_sounds', true)) return;
    try {
      const tone = name || 'default';
      if (tone === 'silent') return;
      if (tone === 'custom') {
        const data = _getCustomSound(null, 'ring');
        if (data) return _playCustomSound(data);
      }
      if (typeof tone === 'string' && tone.startsWith('custom:')) {
        const nick = tone.slice(7);
        const data = _getCustomSound(nick, 'ring');
        if (data) return _playCustomSound(data);
      }
      const fn = RING_TONES[tone] || RING_TONES.default;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      fn(ctx);
    } catch {}
  }

  return { init, registerSW, requestPermission, promptInstall,
    previewTone(name, opts) { _playTone(name, opts); _vibrate(80); },
    previewRingtone(name, opts) { _playRing(name, opts); },
    // Per-friend sound settings API (used by friends UI)
    getFriendTones: _friendTones,
    setFriendTones(map) { _saveFriendTones(map); },
    setFriendSound(nick, kind, tone) {
      if (!nick) return;
      const map = _friendTones();
      map[nick] = map[nick] || {};
      if (tone && tone !== 'default') map[nick][kind] = tone;
      else delete map[nick][kind];
      if (!map[nick].msg && !map[nick].ring) delete map[nick];
      _saveFriendTones(map);
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
    // Accepts a File/Blob, returns a Promise<{ok, error?, dataUrl?}>
    uploadCustomSound(nick, kind, file) {
      return new Promise((resolve) => {
        if (!file) return resolve({ ok: false, error: 'No file' });
        if (
          !/^audio\//i.test(file.type)
          && !/^video\/(mp4|webm)$/i.test(file.type)
          && !/\.(mp3|wav|ogg|m4a|aac|opus|flac|mp4|webm)$/i.test(file.name || '')
        ) {
          return resolve({ ok: false, error: 'Unsupported file type' });
        }
        if (file.size > CUSTOM_MAX_BYTES) {
          return resolve({ ok: false, error: 'File too large (max 2 MB)' });
        }
        const fr = new FileReader();
        fr.onload = () => {
          try {
            _setCustomSound(nick, kind, fr.result);
            resolve({ ok: true, dataUrl: fr.result });
          } catch (e) { resolve({ ok: false, error: String(e) }); }
        };
        fr.onerror = () => resolve({ ok: false, error: 'Read failed' });
        fr.readAsDataURL(file);
      });
    },
    playCustomSound(dataUrl) { _playCustomSound(dataUrl); },

    // In-app + desktop notification for a new message
    notify(msg) {
      const myNick = State.user?.nickname || '';
      const contentText = (msg.content || '').replace(/<[^>]+>/g, '');
      let isMention = myNick && contentText.toLowerCase().includes('@' + myNick.toLowerCase());
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
          if (data) _playCustomSound(data);
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
          if (data) { _playCustomSound(data); return; }
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

// Auto-register SW when script loads (before auth)
Notifications.init();
