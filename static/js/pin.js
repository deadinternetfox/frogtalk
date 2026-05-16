/* ======================================================================
 * pin.js — Privacy PIN lock for FrogTalk
 *
 * Self-contained module. Exposes one global namespace: window.Pin.
 *
 *   Pin.init()                 — wire idle-timer + visibility hook + UI
 *   Pin.refreshFromServer()    — pull fresh /api/auth/pin/status into cache
 *   Pin.openSettings()         — open the Set/Change/Disable PIN dialog
 *   Pin.openOptions()          — render PIN sub-options in privacy panel
 *   Pin.gateAutoLogin()        — Promise<boolean>: must succeed to launch app
 *   Pin.gateAdmin()            — Promise<boolean>: must succeed to open admin
 *   Pin.lockNow()              — show lock screen immediately
 *   Pin.isLocked()             — true while lock screen is active
 *
 * Security model — see /memories/repo and the audit notes in routers/auth.py
 * for the full picture. Highlights:
 *   • PIN is bcrypt-hashed server-side; never stored or transmitted in
 *     plaintext anywhere on the client. We only ever POST it to
 *     /api/auth/pin/{set,verify} where the bcrypt comparison runs.
 *   • The hash never reaches the browser (excluded from get_user_by_token
 *     and /api/auth/me).
 *   • Server enforces 4-8 digit policy, weak-pattern blocking, and a
 *     5-strikes / 15-min lockout (db.verify_user_pin). The client mirrors
 *     the same rules for UX feedback only — server is authoritative.
 *   • The "unlock" timestamp lives in sessionStorage (cleared on tab
 *     close, never persisted). The PIN itself is never written anywhere.
 *   • All DOM injection of user-controllable strings (toasts, error
 *     reasons returned by the server) goes through textContent, never
 *     innerHTML — no XSS vector even if the server were compromised.
 * ====================================================================== */

(function () {
  'use strict';

  // ── Internal state ─────────────────────────────────────────────────
  // _cfg mirrors the PIN-relevant fields from /api/auth/me. Treat as
  // read-only outside of refreshFromServer().
  let _cfg = {
    has_pin: 0,
    pin_require_on_unlock: 0,
    pin_require_for_admin: 0,
    pin_require_after_autologin: 0,
    pin_idle_timeout_sec: 300,
    pin_keypad_privacy: 0,
    pin_lock_remaining_sec: 0,
  };
  let _locked = false;
  let _lastActivity = Date.now();
  let _idleTimer = null;
  let _booted = false;
  // sessionStorage key that holds an "unlocked at" epoch ms. Used so a
  // user who just typed their PIN to open Admin doesn't get re-prompted
  // immediately afterwards. Cleared on browser close.
  const _SS_UNLOCKED_AT = 'frogtalk-pin-unlocked-at';
  // Admin re-auth grace: 5 minutes after unlock, opening admin doesn't
  // re-prompt. Long enough for a normal admin task, short enough that a
  // walked-away laptop doesn't stay open forever.
  const _ADMIN_GRACE_MS = 5 * 60 * 1000;

  // ── Tiny helpers ────────────────────────────────────────────────────
  function $ (id) { return document.getElementById(id); }
  function _setText (id, text) {
    const el = $(id);
    if (el) el.textContent = text == null ? '' : String(text);
  }
  function _show (id) { const el = $(id); if (el) el.classList.remove('hidden'); }
  function _hide (id) { const el = $(id); if (el) el.classList.add('hidden'); }
  function _toast (msg, kind) {
    try {
      if (typeof UI !== 'undefined' && UI.showToast) UI.showToast(msg, kind || 'info', 3500);
    } catch {}
  }

  // Local mirror of the server-side PIN validity rules. Used only for
  // immediate UX feedback; the server check in db._pin_is_weak is the
  // real gate.
  function _localPinReason (pin) {
    const s = String(pin || '');
    if (!/^\d+$/.test(s)) return 'PIN must be digits only';
    if (s.length < 4 || s.length > 8) return 'PIN must be 4-8 digits';
    if (new Set(s).size === 1) return 'PIN cannot be all the same digit';
    let asc = true, desc = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (Number(s[i]) + 1 !== Number(s[i + 1])) asc = false;
      if (Number(s[i]) - 1 !== Number(s[i + 1])) desc = false;
    }
    if (asc || desc) return 'PIN cannot be a simple sequence';
    return null;
  }

  async function _api (path, method, body) {
    // Reuse the project's authenticated fetch so errors surface in the
    // same connection-error overlay as everything else.
    const fn = (typeof apiFetch === 'function') ? apiFetch : fetch;
    const opts = (fn === fetch)
      ? { method: method || 'GET',
          headers: { 'X-Session-Token': (window.State && State.token) || '',
                     'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined }
      : null;
    return (fn === fetch) ? fetch(path, opts) : fn(path, method || 'GET', body || null);
  }

  // ── Server roundtrips ───────────────────────────────────────────────
  async function refreshFromServer () {
    try {
      const res = await _api('/api/auth/pin/status', 'GET');
      if (!res.ok) return _cfg;
      const j = await res.json();
      _cfg = {
        has_pin: Number(j.has_pin || 0),
        pin_require_on_unlock: Number(j.pin_require_on_unlock || 0),
        pin_require_for_admin: Number(j.pin_require_for_admin || 0),
        pin_require_after_autologin: Number(j.pin_require_after_autologin || 0),
        pin_idle_timeout_sec: Number(j.pin_idle_timeout_sec || 300),
        pin_keypad_privacy: Number(j.pin_keypad_privacy || 0),
        pin_lock_remaining_sec: Number(j.pin_lock_remaining_sec || 0),
      };
    } catch {}
    _renderOptionsPanel();
    return _cfg;
  }

  function adoptFromMe (me) {
    // Cheap path: /api/auth/me already includes the same PIN fields, so
    // the boot sequence can hydrate _cfg without an extra round-trip.
    if (!me || typeof me !== 'object') return;
    _cfg = {
      has_pin: Number(me.has_pin || 0),
      pin_require_on_unlock: Number(me.pin_require_on_unlock || 0),
      pin_require_for_admin: Number(me.pin_require_for_admin || 0),
      pin_require_after_autologin: Number(me.pin_require_after_autologin || 0),
      pin_idle_timeout_sec: Number(me.pin_idle_timeout_sec || 300),
      pin_keypad_privacy: Number(me.pin_keypad_privacy || 0),
      pin_lock_remaining_sec: Number(me.pin_lock_remaining_sec || 0),
    };
    _renderOptionsPanel();
  }

  // ── Idle / visibility detection ─────────────────────────────────────
  function _bumpActivity () { _lastActivity = Date.now(); }

  function _idleTick () {
    if (_locked || !_cfg.has_pin || !_cfg.pin_require_on_unlock) return;
    const idleMs = Date.now() - _lastActivity;
    if (idleMs >= _cfg.pin_idle_timeout_sec * 1000) {
      lockNow();
    }
  }

  function _onVisibility () {
    if (document.hidden) {
      // Coming back from a hidden tab counts as "returning" — track
      // when we hid so the next focus knows how long it was away.
      _lastActivity = Math.min(_lastActivity, Date.now());
      return;
    }
    if (!_cfg.has_pin || !_cfg.pin_require_on_unlock) return;
    // If hidden long enough, lock on return. Idle timeout of 0 means
    // "lock immediately on any blur".
    const idleMs = Date.now() - _lastActivity;
    if (_cfg.pin_idle_timeout_sec === 0 || idleMs >= _cfg.pin_idle_timeout_sec * 1000) {
      lockNow();
    }
  }

  // ── Lock screen ─────────────────────────────────────────────────────
  let _unlockResolve = null;          // resolves when correct PIN entered
  let _pinBuffer = '';
  function _renderDots () {
    const wrap = $('lock-pin-dots');
    if (!wrap) return;
    // Dots adapt to current buffer length (4..8); colour fills as digits
    // are typed.
    wrap.textContent = '';
    const n = Math.max(4, Math.min(8, _pinBuffer.length || 4));
    for (let i = 0; i < n; i++) {
      const d = document.createElement('span');
      d.className = 'pin-dot' + (i < _pinBuffer.length ? ' pin-dot-on' : '');
      wrap.appendChild(d);
    }
  }

  function _lockKeyHandler (e) {
    if (!_locked) return;
    if (e.key >= '0' && e.key <= '9') {
      if (_pinBuffer.length < 8) _pinBuffer += e.key;
      _renderDots();
      e.preventDefault();
      // Auto-submit at 4+ digits is annoying — make the user press Enter
      // or hit the submit button so 5/6/7/8-digit PINs work without
      // accidental early submits.
    } else if (e.key === 'Backspace') {
      _pinBuffer = _pinBuffer.slice(0, -1);
      _renderDots();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      _submitLockPin();
      e.preventDefault();
    } else if (e.key === 'Escape') {
      // Trap Escape — there's no "cancel" out of the lock screen. The
      // only way out is the correct PIN or signing out.
      e.preventDefault();
    }
  }

  async function _submitLockPin () {
    const pin = _pinBuffer;
    if (!pin || pin.length < 4) {
      _setText('lock-error', 'Enter at least 4 digits');
      return;
    }
    _setText('lock-error', '');
    const btn = $('lock-submit');
    if (btn) btn.disabled = true;
    try {
      const res = await _api('/api/auth/pin/verify', 'POST', { pin });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        _pinBuffer = '';
        _renderDots();
        _markUnlocked();
        _hideLockScreen();
        if (_unlockResolve) { const r = _unlockResolve; _unlockResolve = null; r(true); }
        return;
      }
      _pinBuffer = '';
      _renderDots();
      // 10.5: re-shuffle the keypad after every wrong attempt so an
      // attacker who recorded the screen for the first guess can't reuse
      // the position-to-digit mapping for the next guess.
      try { _renderNumpadKeys($('lock-numpad')); } catch {}
      if (j.lock_seconds && j.lock_seconds > 0) {
        _startLockoutCountdown(j.lock_seconds);
      } else {
        const remaining = Number(j.remaining_attempts);
        const reason = String(j.error || 'Incorrect PIN');
        _setText('lock-error',
          isFinite(remaining) ? `${reason} — ${remaining} attempt${remaining === 1 ? '' : 's'} left` : reason);
      }
    } catch {
      _setText('lock-error', 'Network error — try again');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function _startLockoutCountdown (initialSeconds) {
    let secs = Math.max(1, Math.floor(initialSeconds));
    const submit = $('lock-submit');
    const numpad = $('lock-numpad');
    if (submit) submit.disabled = true;
    if (numpad) numpad.classList.add('pin-numpad-disabled');
    function paint () {
      const m = Math.floor(secs / 60), s = secs % 60;
      _setText('lock-error',
        `Too many wrong attempts. Try again in ${m ? m + 'm ' : ''}${s}s.`);
    }
    paint();
    const id = setInterval(() => {
      secs -= 1;
      if (secs <= 0) {
        clearInterval(id);
        _setText('lock-error', '');
        if (submit) submit.disabled = false;
        if (numpad) numpad.classList.remove('pin-numpad-disabled');
      } else { paint(); }
    }, 1000);
  }

  function _markUnlocked () {
    try { sessionStorage.setItem(_SS_UNLOCKED_AT, String(Date.now())); } catch {}
  }
  function _wasUnlockedRecently (graceMs) {
    try {
      const t = Number(sessionStorage.getItem(_SS_UNLOCKED_AT) || 0);
      return t > 0 && (Date.now() - t) < graceMs;
    } catch { return false; }
  }

  // 10.5: anti-shoulder-surf / anti-keylogger numeric pad. Each render
  // (and each failed attempt — see _submitLockPin's error path)
  // shuffles the digit-to-position mapping so muscle memory and
  // screen-recording attacks cannot infer the PIN from tap coordinates.
  // The "privacy keypad" toggle hides digits entirely, leaving only
  // shape glyphs the user can memorise as a pattern. Backspace and
  // submit stay in fixed positions so the flow stays predictable.
  function _renderNumpadKeys (numpad) {
    if (!numpad) return;
    while (numpad.firstChild) numpad.removeChild(numpad.firstChild);
    const SHAPES = ['●','▲','■','◆','★','♥','♣','♠','♦'];
    const _shuffle = (arr) => {
      const a = arr.slice();
      const rnd = (max) => {
        try {
          const u = new Uint32Array(1);
          (window.crypto || window.msCrypto).getRandomValues(u);
          return u[0] % max;
        } catch {
          return Math.floor(Math.random() * max);
        }
      };
      for (let i = a.length - 1; i > 0; i--) {
        const j = rnd(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    const privacyKp = !!(_cfg && _cfg.pin_keypad_privacy);
    const digits = _shuffle(['1','2','3','4','5','6','7','8','9']);
    const cells = [];
    for (let i = 0; i < 9; i++) cells.push({ kind: 'digit', digit: digits[i], shape: SHAPES[i] });
    cells.push({ kind: 'back' });
    cells.push({ kind: 'digit', digit: '0', shape: '○' });
    cells.push({ kind: 'submit' });
    cells.forEach(cell => {
      const b = document.createElement('button');
      b.type = 'button';
      let label = '';
      if (cell.kind === 'back') label = '⌫';
      else if (cell.kind === 'submit') label = '✓';
      else if (privacyKp) {
        label = cell.shape;
        b.setAttribute('aria-label', 'Digit ' + cell.digit);
      } else {
        // Larger digit, smaller shape underneath as a memory aid.
        const d = document.createElement('span');
        d.style.cssText = 'font-size:18px;font-weight:600';
        d.textContent = cell.digit;
        const s = document.createElement('span');
        s.style.cssText = 'display:block;font-size:10px;opacity:.45;margin-top:-2px';
        s.textContent = cell.shape;
        b.appendChild(d); b.appendChild(s);
      }
      if (label) b.textContent = label;
      // Always store the actual digit in dataset, never trust label —
      // ensures DOM-scraping accessibility tools and screen recordings
      // can't recover the PIN by reading textContent alone.
      if (cell.kind === 'digit') b.dataset.digit = cell.digit;
      b.style.cssText = 'background:#1d1d1d;color:#e0e0e0;border:1px solid #2a2a2a;' +
                       'border-radius:10px;padding:14px 0;font-size:18px;cursor:pointer;' +
                       'transition:background .12s';
      b.addEventListener('mousedown', () => { b.style.background = '#272727'; });
      b.addEventListener('mouseup',   () => { b.style.background = '#1d1d1d'; });
      b.addEventListener('mouseleave',() => { b.style.background = '#1d1d1d'; });
      b.addEventListener('click', () => {
        if (cell.kind === 'back') { _pinBuffer = _pinBuffer.slice(0, -1); _renderDots(); return; }
        if (cell.kind === 'submit') { _submitLockPin(); return; }
        if (_pinBuffer.length < 8) { _pinBuffer += b.dataset.digit; _renderDots(); }
      });
      if (cell.kind === 'submit') b.id = 'lock-submit';
      numpad.appendChild(b);
    });
  }

  function _ensureLockScreen () {
    if ($('lock-screen')) return;
    const root = document.createElement('div');
    root.id = 'lock-screen';
    root.className = 'modal-overlay hidden';
    // Use textContent / DOM API to build everything — no innerHTML on
    // any data path that could come from the server.
    root.style.cssText = 'z-index:9999;background:#0b0b0b;backdrop-filter:blur(8px);' +
                        'display:flex;align-items:center;justify-content:center;';
    const card = document.createElement('div');
    card.style.cssText = 'background:#141414;border:1px solid #2a2a2a;border-radius:14px;' +
                        'padding:32px 28px;max-width:360px;width:90%;text-align:center;' +
                        'box-shadow:0 10px 40px rgba(0,0,0,.6)';

    const logo = document.createElement('div');
    logo.textContent = '🐸';
    logo.style.cssText = 'font-size:42px;margin-bottom:6px';
    card.appendChild(logo);

    const title = document.createElement('div');
    title.textContent = 'Locked';
    title.style.cssText = 'font-size:20px;font-weight:700;color:#e8f5e9';
    card.appendChild(title);

    const sub = document.createElement('div');
    sub.id = 'lock-subtitle';
    sub.textContent = 'Enter your PIN to continue';
    sub.style.cssText = 'font-size:13px;color:#8a8a8a;margin:6px 0 22px';
    card.appendChild(sub);

    const dots = document.createElement('div');
    dots.id = 'lock-pin-dots';
    dots.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-bottom:18px';
    card.appendChild(dots);

    const err = document.createElement('div');
    err.id = 'lock-error';
    err.style.cssText = 'min-height:18px;color:#ff6b6b;font-size:12px;margin-bottom:10px';
    card.appendChild(err);

    const numpad = document.createElement('div');
    numpad.id = 'lock-numpad';
    numpad.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px';
    _renderNumpadKeys(numpad);
    card.appendChild(numpad);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:center;font-size:12px';
    const signOut = document.createElement('button');
    signOut.type = 'button';
    signOut.textContent = 'Sign out';
    signOut.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;text-decoration:underline';
    signOut.addEventListener('click', () => {
      // Only escape route. Logout clears local state + revokes session
      // server-side, so a forgotten-PIN user is forced through the
      // password sign-in flow again.
      try {
        if (typeof logout === 'function') { logout(); return; }
      } catch {}
      try { localStorage.removeItem('fc_token'); localStorage.removeItem('fc_user'); } catch {}
      location.reload();
    });
    actions.appendChild(signOut);
    card.appendChild(actions);

    root.appendChild(card);
    document.body.appendChild(root);
  }

  function _hideLockScreen () {
    _locked = false;
    document.removeEventListener('keydown', _lockKeyHandler, true);
    _hide('lock-screen');
    _renderOptionsPanel();
  }

  function lockNow () {
    if (_locked) return;
    if (!_cfg.has_pin) return;       // nothing to lock with
    _ensureLockScreen();
    _locked = true;
    _pinBuffer = '';
    _renderDots();
    _setText('lock-error', '');
    _setText('lock-subtitle', 'Enter your PIN to continue');
    _show('lock-screen');
    document.addEventListener('keydown', _lockKeyHandler, true);
    // If the server reported an active lockout, surface it immediately.
    if (_cfg.pin_lock_remaining_sec > 0) {
      _startLockoutCountdown(_cfg.pin_lock_remaining_sec);
      _cfg.pin_lock_remaining_sec = 0;
    }
  }

  function isLocked () { return _locked; }

  // ── Boot-time gates ─────────────────────────────────────────────────
  // Both gates resolve to a Promise<boolean>. Caller awaits — true
  // means "proceed". Callers should not branch on this synchronously.

  function gateAutoLogin () {
    return new Promise((resolve) => {
      if (!_cfg.has_pin || !_cfg.pin_require_after_autologin) { resolve(true); return; }
      if (_wasUnlockedRecently(60 * 1000)) { resolve(true); return; }
      _unlockResolve = resolve;
      lockNow();
    });
  }

  function gateAdmin () {
    return new Promise((resolve) => {
      if (!_cfg.has_pin || !_cfg.pin_require_for_admin) { resolve(true); return; }
      if (_wasUnlockedRecently(_ADMIN_GRACE_MS)) { resolve(true); return; }
      _unlockResolve = resolve;
      lockNow();
    });
  }

  // ── Set / Change / Disable PIN dialog ──────────────────────────────
  function openSettings () {
    _ensureSetDialog();
    // Always pull fresh state so the dialog reflects what the server
    // actually has (e.g. PIN was changed on another device).
    refreshFromServer().catch(() => {});
    // Reset every field on each open so a previously-typed password /
    // PIN doesn't sit in the DOM.
    ['pin-set-password','pin-set-new','pin-set-confirm'].forEach(id => {
      const el = $(id); if (el) el.value = '';
    });
    _setText('pin-set-error', '');
    // Toggle UI between "set/change" mode and "disable" affordance based
    // on current state.
    const disableBtn = $('pin-set-disable');
    if (disableBtn) disableBtn.style.display = _cfg.has_pin ? '' : 'none';
    _setText('pin-set-title', _cfg.has_pin ? 'Change PIN' : 'Set PIN');
    _setText('pin-set-confirm-row-label', 'Confirm new PIN');
    _show('modal-pin-set');
    // Focus password first so Tab-order matches reading order.
    setTimeout(() => { const e = $('pin-set-password'); if (e) e.focus(); }, 30);
  }

  function _ensureSetDialog () {
    if ($('modal-pin-set')) return;

    const overlay = document.createElement('div');
    overlay.id = 'modal-pin-set';
    overlay.className = 'modal-overlay hidden';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) _hide('modal-pin-set'); });

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.cssText = 'max-width:380px';

    const title = document.createElement('div');
    title.id = 'pin-set-title';
    title.className = 'modal-title';
    title.textContent = 'Set PIN';
    modal.appendChild(title);

    const intro = document.createElement('div');
    intro.style.cssText = 'font-size:12px;color:#888;margin:-6px 0 14px';
    intro.textContent = 'Your PIN locks the app on idle, after auto-login, and before opening admin areas. 4–8 digits, no all-same / sequential / common patterns.';
    modal.appendChild(intro);

    function field (labelText, inputId, type, attrs) {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:block;margin-bottom:12px';
      const lbl = document.createElement('div');
      lbl.textContent = labelText;
      lbl.style.cssText = 'font-size:12px;color:#bbb;margin-bottom:4px';
      if (inputId === 'pin-set-confirm') lbl.id = 'pin-set-confirm-row-label';
      wrap.appendChild(lbl);
      const inp = document.createElement('input');
      inp.id = inputId;
      inp.type = type;
      inp.autocomplete = 'off';
      inp.spellcheck = false;
      Object.assign(inp, attrs || {});
      inp.style.cssText = 'width:100%;background:#0d0d0d;color:#e0e0e0;border:1px solid #2a2a2a;' +
                         'border-radius:6px;padding:8px 10px;font-size:14px';
      wrap.appendChild(inp);
      return wrap;
    }
    modal.appendChild(field('Current account password', 'pin-set-password', 'password',
      { maxLength: 128 }));
    modal.appendChild(field('New PIN (4–8 digits)', 'pin-set-new', 'password',
      { maxLength: 8, inputMode: 'numeric', pattern: '[0-9]*' }));
    modal.appendChild(field('Confirm new PIN', 'pin-set-confirm', 'password',
      { maxLength: 8, inputMode: 'numeric', pattern: '[0-9]*' }));

    const err = document.createElement('div');
    err.id = 'pin-set-error';
    err.style.cssText = 'min-height:16px;color:#ff6b6b;font-size:12px;margin-bottom:10px';
    modal.appendChild(err);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'modal-btn secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => _hide('modal-pin-set'));

    const disable = document.createElement('button');
    disable.id = 'pin-set-disable';
    disable.type = 'button';
    disable.className = 'modal-btn secondary';
    disable.textContent = 'Disable PIN';
    disable.addEventListener('click', _onDisableClick);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'modal-btn primary';
    save.textContent = 'Save';
    save.addEventListener('click', _onSaveClick);

    btnRow.appendChild(cancel);
    btnRow.appendChild(disable);
    btnRow.appendChild(save);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Strip non-digit input on the PIN fields as the user types so the
    // server-side digit-only check is never tested by accident.
    ['pin-set-new','pin-set-confirm'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('input', () => {
        const cleaned = el.value.replace(/\D+/g, '').slice(0, 8);
        if (cleaned !== el.value) el.value = cleaned;
      });
    });
  }

  async function _onSaveClick () {
    const pw = ($('pin-set-password') || {}).value || '';
    const a  = ($('pin-set-new') || {}).value || '';
    const b  = ($('pin-set-confirm') || {}).value || '';
    if (!pw) { _setText('pin-set-error', 'Enter your account password'); return; }
    if (a !== b) { _setText('pin-set-error', 'PIN and confirmation do not match'); return; }
    const reason = _localPinReason(a);
    if (reason) { _setText('pin-set-error', reason); return; }
    _setText('pin-set-error', '');
    try {
      const res = await _api('/api/auth/pin/set', 'POST', { current_password: pw, pin: a });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        _setText('pin-set-error', String(j.error || 'Could not set PIN'));
        return;
      }
      // Wipe sensitive inputs from DOM as soon as the request finishes.
      ['pin-set-password','pin-set-new','pin-set-confirm'].forEach(id => {
        const el = $(id); if (el) el.value = '';
      });
      _hide('modal-pin-set');
      await refreshFromServer();
      _toast(_cfg.has_pin ? 'PIN updated' : 'PIN set', 'success');
      _markUnlocked();
    } catch {
      _setText('pin-set-error', 'Network error — try again');
    }
  }

  async function _onDisableClick () {
    const pw = ($('pin-set-password') || {}).value || '';
    if (!pw) { _setText('pin-set-error', 'Enter your account password to disable'); return; }
    _setText('pin-set-error', '');
    try {
      const res = await _api('/api/auth/pin', 'DELETE', { current_password: pw });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        _setText('pin-set-error', String(j.error || 'Could not disable PIN'));
        return;
      }
      ['pin-set-password','pin-set-new','pin-set-confirm'].forEach(id => {
        const el = $(id); if (el) el.value = '';
      });
      _hide('modal-pin-set');
      await refreshFromServer();
      _toast('PIN disabled', 'info');
      try { sessionStorage.removeItem(_SS_UNLOCKED_AT); } catch {}
    } catch {
      _setText('pin-set-error', 'Network error — try again');
    }
  }

  // ── Privacy panel sub-options ──────────────────────────────────────
  // The privacy tab in index.html contains a #pin-privacy-section div.
  // We render its contents here so the source of truth for the PIN
  // option block lives entirely in this file.
  function _renderOptionsPanel () {
    const root = $('pin-privacy-section');
    if (!root) return;
    root.textContent = '';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;flex-direction:column;align-items:stretch;gap:10px;' +
                          'padding:14px 0 10px;border-top:1px solid #1e1e1e;margin-top:6px';
    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'min-width:0';
    const h = document.createElement('div');
    h.textContent = 'App PIN';
    h.style.cssText = 'font-size:14px;color:#e0e0e0;font-weight:600';
    headerLeft.appendChild(h);
    const status = document.createElement('div');
    status.style.cssText = 'font-size:12px;margin-top:3px;line-height:1.4';
    if (_cfg.has_pin) {
      status.textContent = 'Active — locks the app on idle, after auto-login, and before admin areas.';
      status.style.color = '#7ed27e';
    } else {
      status.textContent = 'Not set — set a PIN to enable the auto-lock options below.';
      status.style.color = '#888';
    }
    headerLeft.appendChild(status);
    header.appendChild(headerLeft);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modal-btn ' + (_cfg.has_pin ? 'secondary' : 'primary');
    btn.textContent = _cfg.has_pin ? 'Change / Disable PIN' : 'Set PIN';
    btn.style.cssText = 'width:100%;white-space:nowrap;padding:10px 16px;font-size:14px';
    btn.addEventListener('click', openSettings);
    header.appendChild(btn);
    root.appendChild(header);

    if (!_cfg.has_pin) {
      const callout = document.createElement('div');
      callout.style.cssText = 'background:#161616;border:1px dashed #333;border-radius:8px;' +
                             'padding:10px 12px;margin:10px 0;color:#bbb;font-size:12px';
      callout.textContent = 'You must set a PIN before you can require it for admin areas, auto-login, or after idle. ' +
                            'Click "Set PIN" above to start.';
      root.appendChild(callout);
    }

    function row (labelText, descText, controlEl) {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;align-items:center;justify-content:space-between;' +
                          'padding:10px 0;border-bottom:1px solid #1e1e1e;cursor:pointer;' +
                          (_cfg.has_pin ? '' : 'opacity:.45;cursor:not-allowed');
      const text = document.createElement('div');
      text.style.cssText = 'flex:1;padding-right:10px';
      const t = document.createElement('div');
      t.textContent = labelText;
      t.style.cssText = 'font-size:14px;color:#e0e0e0';
      const d = document.createElement('div');
      d.textContent = descText;
      d.style.cssText = 'font-size:12px;color:#666;margin-top:2px';
      text.appendChild(t); text.appendChild(d);
      wrap.appendChild(text);
      if (!_cfg.has_pin) {
        controlEl.disabled = true;
      }
      wrap.appendChild(controlEl);
      return wrap;
    }

    function checkbox (id, checked) {
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.id = id;
      c.checked = !!checked;
      c.style.cssText = 'width:18px;height:18px;cursor:pointer;accent-color:#4caf50';
      c.addEventListener('change', _commitOptions);
      return c;
    }

    root.appendChild(row(
      'Require PIN to unlock after idle',
      'Lock the app when it sits idle or you switch tabs.',
      checkbox('pin-opt-on-unlock', !!_cfg.pin_require_on_unlock),
    ));

    // Idle timeout select
    const sel = document.createElement('select');
    sel.id = 'pin-opt-idle';
    sel.style.cssText = 'background:#0d0d0d;color:#e0e0e0;border:1px solid #333;padding:4px 8px;border-radius:4px';
    [
      [0,    'Immediately'],
      [60,   '1 minute'],
      [300,  '5 minutes'],
      [900,  '15 minutes'],
      [1800, '30 minutes'],
      [3600, '1 hour'],
    ].forEach(([v, label]) => {
      const opt = document.createElement('option');
      opt.value = String(v);
      opt.textContent = label;
      if (Number(_cfg.pin_idle_timeout_sec) === v) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', _commitOptions);
    root.appendChild(row(
      'Idle timeout',
      'How long the app sits without activity before locking.',
      sel,
    ));

    root.appendChild(row(
      'Require PIN for admin areas',
      'Re-prompt before opening the Server Admin panel.',
      checkbox('pin-opt-admin', !!_cfg.pin_require_for_admin),
    ));
    root.appendChild(row(
      'Require PIN after auto-login',
      'When the saved session restores at startup, demand the PIN before showing chats.',
      checkbox('pin-opt-autologin', !!_cfg.pin_require_after_autologin),
    ));
    root.appendChild(row(
      'Privacy keypad',
      'Hide digits on the lock screen — only shape glyphs are shown. Position still reshuffles every attempt; this adds a second layer against shoulder-surfing and screen recordings.',
      checkbox('pin-opt-privacy-kp', !!_cfg.pin_keypad_privacy),
    ));
  }

  let _commitTimer = null;
  function _commitOptions () {
    // Debounce: rapid toggles collapse into one PATCH.
    clearTimeout(_commitTimer);
    _commitTimer = setTimeout(_doCommitOptions, 200);
  }
  async function _doCommitOptions () {
    if (!_cfg.has_pin) return;
    const body = {
      require_on_unlock:        !!($('pin-opt-on-unlock') || {}).checked,
      require_for_admin:        !!($('pin-opt-admin')      || {}).checked,
      require_after_autologin:  !!($('pin-opt-autologin')  || {}).checked,
      idle_timeout_sec:         Number(($('pin-opt-idle')  || {}).value || 300),
      keypad_privacy:           !!($('pin-opt-privacy-kp') || {}).checked,
    };
    try {
      const res = await _api('/api/auth/pin/options', 'PATCH', body);
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        // Reflect back what the server actually saved (handles clamping
        // / coercion).
        Object.assign(_cfg, {
          pin_require_on_unlock:        Number(j.pin_require_on_unlock || 0),
          pin_require_for_admin:        Number(j.pin_require_for_admin || 0),
          pin_require_after_autologin:  Number(j.pin_require_after_autologin || 0),
          pin_idle_timeout_sec:         Number(j.pin_idle_timeout_sec || 300),
          pin_keypad_privacy:           Number(j.pin_keypad_privacy || 0),
        });
        _toast('PIN options saved', 'success');
      } else {
        _toast('Could not save PIN options', 'error');
      }
    } catch {
      _toast('Network error saving PIN options', 'error');
    }
  }

  // ── init() ──────────────────────────────────────────────────────────
  function init () {
    if (_booted) return;
    _booted = true;
    // Activity tracking: passive so we never block scrolling on mobile.
    ['mousemove','keydown','touchstart','scroll','focus','click'].forEach(ev => {
      window.addEventListener(ev, _bumpActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', _onVisibility);
    window.addEventListener('focus', _onVisibility);
    // Idle poll. 5 s is fine — the user's clock-precision expectation
    // for "the app locked" is on that order anyway.
    _idleTimer = setInterval(_idleTick, 5000);
    // Initial render of options panel if the privacy tab is already in DOM.
    _renderOptionsPanel();
  }

  // ── Public surface ──────────────────────────────────────────────────
  window.Pin = {
    init,
    refreshFromServer,
    adoptFromMe,
    openSettings,
    gateAutoLogin,
    gateAdmin,
    lockNow,
    isLocked,
    // Exposed for callers that want to inspect after refreshFromServer().
    config: () => Object.freeze({ ..._cfg }),
  };

  // Auto-init when DOM is ready so callers don't need to remember.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
