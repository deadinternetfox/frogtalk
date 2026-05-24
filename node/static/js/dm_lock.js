/**
 * dm_lock.js — Per-DM PIN / password lock (client gate + settings helpers).
 */
(function () {
  'use strict';

  const MODAL_ID = 'modal-dm-lock-gate';
  let _pendingResolve = null;

  function _el(id) { return document.getElementById(id); }

  async function _pinConfigured() {
    if (!window.Pin) return false;
    try { await Pin.refreshFromServer(); } catch {}
    const cfg = Pin.config ? Pin.config() : {};
    return !!cfg.has_pin;
  }

  function _channelMeta(channelId) {
    const id = Number(channelId) || 0;
    const list = (typeof _dmChannels !== 'undefined' && Array.isArray(_dmChannels)) ? _dmChannels : [];
    return list.find(c => Number(c.id) === id) || {};
  }

  function isLockEnabled(channelId) {
    const ch = _channelMeta(channelId);
    return !!(ch.my_pin_lock || ch.pin_lock_enabled);
  }

  function isServerLocked(channelId) {
    return !!_channelMeta(channelId).dm_locked;
  }

  async function lockChannelView(channelId) {
    const id = Number(channelId) || 0;
    if (!id) return;
    try { await apiFetch('/api/dms/' + id + '/lock', 'POST', {}); } catch {}
    const ch = _channelMeta(id);
    if (ch.my_pin_lock) ch.dm_locked = true;
  }

  function escapeHtml(s) {
    if (typeof esc === 'function') return esc(s);
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderLockOverlay(nickname) {
    const area = _el('messages-area');
    if (!area) return;
    const name = escapeHtml(nickname || 'this chat');
    area.innerHTML =
      '<div class="dm-lock-overlay" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:240px;padding:32px;text-align:center;color:#aaa">' +
      '<div style="font-size:48px;margin-bottom:12px" aria-hidden="true">\uD83D\uDD12</div>' +
      '<div style="font-size:16px;font-weight:600;color:#e0e0e0;margin-bottom:6px">Chat locked</div>' +
      '<div style="font-size:13px;line-height:1.45;max-width:320px;margin-bottom:16px">Unlock to read messages with @' + name + '.</div>' +
      '<button type="button" class="modal-btn primary" id="dm-lock-unlock-btn">Unlock</button></div>';
    const btn = _el('dm-lock-unlock-btn');
    if (btn) {
      btn.onclick = () => {
        if (typeof _activeDM !== 'undefined' && _activeDM && _activeDM.id) {
          void gate(_activeDM.id, _activeDM.nickname).then((ok) => {
            if (ok && typeof loadDMMessages === 'function') loadDMMessages(0);
          });
        }
      };
    }
  }

  function _ensureModal() {
    let modal = _el(MODAL_ID);
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'modal-overlay hidden';
    modal.id = MODAL_ID;
    modal.setAttribute('data-dismiss-on-backdrop', 'false');
    modal.innerHTML =
      '<div class="modal" style="max-width:340px" role="dialog" aria-modal="true">' +
      '<div class="modal-title" id="dm-lock-gate-title">\uD83D\uDD12 Unlock chat</div>' +
      '<p id="dm-lock-gate-sub" style="font-size:13px;color:#888;margin:-4px 0 14px;line-height:1.45"></p>' +
      '<div id="dm-lock-pin-wrap" class="hidden"><label class="modal-label" for="dm-lock-pin-input">App PIN</label>' +
      '<input type="password" inputmode="numeric" id="dm-lock-pin-input" class="modal-input" maxlength="8" autocomplete="off" placeholder="4-8 digits"></div>' +
      '<div id="dm-lock-pw-wrap" class="hidden"><label class="modal-label" for="dm-lock-pw-input">Account password</label>' +
      '<input type="password" id="dm-lock-pw-input" class="modal-input" autocomplete="current-password" maxlength="128" placeholder="Your FrogTalk password">' +
      '<p id="dm-lock-pin-hint" style="font-size:12px;color:#888;margin:10px 0 0;line-height:1.4">' +
      '<button type="button" id="dm-lock-set-pin-link" style="background:none;border:none;color:var(--accent-color,#4caf50);cursor:pointer;padding:0;font-size:12px">Set an App PIN</button> for faster unlock.</p></div>' +
      '<div id="dm-lock-gate-error" class="auth-error" style="display:none;margin-top:10px" role="alert"></div>' +
      '<div class="modal-actions" style="margin-top:14px">' +
      '<button type="button" class="modal-btn secondary" id="dm-lock-gate-cancel">Cancel</button>' +
      '<button type="button" class="modal-btn primary" id="dm-lock-gate-submit">Unlock</button></div></div>';
    document.body.appendChild(modal);
    _el('dm-lock-gate-cancel').addEventListener('click', () => _finish(false));
    _el('dm-lock-set-pin-link').addEventListener('click', () => {
      try { closeModal(MODAL_ID); } catch { modal.classList.add('hidden'); }
      try { Pin.openSettings(); } catch {}
      _finish(false);
    });
    _el('dm-lock-gate-submit').addEventListener('click', () => { void _submitUnlock(); });
    return modal;
  }

  function _finish(ok) {
    const modal = _el(MODAL_ID);
    try { closeModal(MODAL_ID); } catch { if (modal) modal.classList.add('hidden'); }
    const resolve = _pendingResolve;
    _pendingResolve = null;
    if (resolve) resolve(!!ok);
  }

  async function _submitUnlock() {
    const modal = _el(MODAL_ID);
    const channelId = Number((modal && modal._ftChannelId) || (typeof _activeDM !== 'undefined' && _activeDM && _activeDM.id)) || 0;
    const errEl = _el('dm-lock-gate-error');
    const btn = _el('dm-lock-gate-submit');
    if (!channelId) { _finish(false); return; }
    const hasPin = await _pinConfigured();
    const body = {};
    if (hasPin) {
      body.pin = String((_el('dm-lock-pin-input') && _el('dm-lock-pin-input').value) || '').trim();
      if (!body.pin) {
        if (errEl) { errEl.textContent = 'Enter your App PIN.'; errEl.style.display = ''; }
        return;
      }
    } else {
      body.password = String((_el('dm-lock-pw-input') && _el('dm-lock-pw-input').value) || '');
      if (!body.password) {
        if (errEl) { errEl.textContent = 'Enter your account password.'; errEl.style.display = ''; }
        return;
      }
    }
    if (btn) btn.disabled = true;
    try {
      const res = await apiFetch('/api/dms/' + channelId + '/unlock', 'POST', body);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (errEl) { errEl.textContent = j.error || 'Unlock failed'; errEl.style.display = ''; }
        return;
      }
      _channelMeta(channelId).dm_locked = false;
      _finish(true);
    } catch {
      if (errEl) { errEl.textContent = 'Network error — try again.'; errEl.style.display = ''; }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function gate(channelId, nickname) {
    const id = Number(channelId) || 0;
    if (!id) return true;
    const ch = _channelMeta(id);
    if (!ch.my_pin_lock && !ch.pin_lock_enabled) return true;
    if (!ch.dm_locked) return true;
    return new Promise((resolve) => {
      _pendingResolve = resolve;
      const modal = _ensureModal();
      modal._ftChannelId = id;
      const sub = _el('dm-lock-gate-sub');
      if (sub) sub.textContent = 'This conversation with @' + (nickname || ch.nickname || 'chat') + ' is locked.';
      const errEl = _el('dm-lock-gate-error');
      if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
      void _pinConfigured().then((hasPin) => {
        _el('dm-lock-pin-wrap').classList.toggle('hidden', !hasPin);
        _el('dm-lock-pw-wrap').classList.toggle('hidden', !!hasPin);
        const hint = _el('dm-lock-pin-hint');
        if (hint) hint.style.display = hasPin ? 'none' : '';
        try { openModal(MODAL_ID); } catch { modal.classList.remove('hidden'); }
      });
    });
  }

  async function loadPrefs(channelId) {
    const res = await apiFetch('/api/dms/' + Number(channelId) + '/lock-prefs');
    if (!res.ok) return { enabled: false, timeout_sec: 0, has_pin: false };
    return res.json();
  }

  async function savePrefs(channelId, enabled, timeoutSec) {
    const res = await apiFetch('/api/dms/' + Number(channelId) + '/lock-prefs', 'POST', {
      enabled: !!enabled,
      timeout_sec: Number(timeoutSec) || 0,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || 'Failed to save lock settings');
    }
    const ch = _channelMeta(channelId);
    ch.my_pin_lock = !!enabled;
    ch.my_pin_lock_timeout = Number(timeoutSec) || 0;
    ch.dm_locked = !!enabled;
    return res.json();
  }

  function handleWsLockPrefs(data) {
    const chId = Number(data && data.channel_id) || 0;
    const actorId = Number(data && data.actor_id) || 0;
    const myId = Number((typeof STATE !== 'undefined' && STATE.user && STATE.user.id) || (State.user && State.user.id)) || 0;
    if (!chId || actorId !== myId) return;
    const list = (typeof _dmChannels !== 'undefined' && Array.isArray(_dmChannels)) ? _dmChannels : [];
    const ch = list.find(c => Number(c.id) === chId);
    if (!ch) return;
    ch.my_pin_lock = !!Number(data.pin_lock_enabled);
    ch.my_pin_lock_timeout = Number(data.pin_lock_timeout_sec) || 0;
    ch.dm_locked = ch.my_pin_lock;
    if (typeof renderDMChannels === 'function') renderDMChannels();
    if (typeof _activeDM !== 'undefined' && _activeDM && _activeDM.id === chId && ch.dm_locked) {
      if (typeof _dmMessages !== 'undefined') _dmMessages = [];
      renderLockOverlay(_activeDM.nickname);
      void lockChannelView(chId);
    }
  }

  window.DmLock = {
    gate, lockChannelView, renderLockOverlay, isLockEnabled, isServerLocked,
    loadPrefs, savePrefs, handleWsLockPrefs,
  };
})();
