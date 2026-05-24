/**
 * dm_lock.js — Per-DM PIN / password lock (client gate + settings helpers).
 * PIN users get the full-screen App PIN keypad (pin.js). Password is fallback only.
 */
(function () {
  'use strict';

  const PW_MODAL_ID = 'modal-dm-lock-password';
  let _pendingResolve = null;

  function _el(id) { return document.getElementById(id); }

  async function _hasAppPin() {
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

  function _markSessionUnlocked(channelId) {
    const ch = _channelMeta(channelId);
    ch.dm_locked = false;
    ch._dmSessionUnlocked = true;
    if (typeof _activeDM !== 'undefined' && _activeDM && _activeDM.id === channelId) {
      _activeDM.dm_locked = false;
      _activeDM._dmSessionUnlocked = true;
    }
  }

  function _markSessionLocked(channelId) {
    const ch = _channelMeta(channelId);
    if (!ch.my_pin_lock) return;
    ch.dm_locked = true;
    ch._dmSessionUnlocked = false;
    if (typeof _activeDM !== 'undefined' && _activeDM && _activeDM.id === channelId) {
      _activeDM.dm_locked = true;
      _activeDM._dmSessionUnlocked = false;
    }
  }

  function isLockEnabled(channelId) {
    const ch = _channelMeta(channelId);
    return !!(ch.my_pin_lock || ch.pin_lock_enabled);
  }

  function isServerLocked(channelId) {
    const ch = _channelMeta(channelId);
    if (ch._dmSessionUnlocked && !ch.dm_locked) return false;
    return !!ch.dm_locked || !!ch.my_pin_lock;
  }

  async function lockChannelView(channelId) {
    const id = Number(channelId) || 0;
    if (!id || !isLockEnabled(id)) return;
    try { await apiFetch('/api/dms/' + id + '/lock', 'POST', {}); } catch {}
    _markSessionLocked(id);
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

  function _ensurePasswordModal() {
    let modal = _el(PW_MODAL_ID);
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'modal-overlay hidden';
    modal.id = PW_MODAL_ID;
    modal.setAttribute('data-dismiss-on-backdrop', 'false');
    modal.innerHTML =
      '<div class="modal" style="max-width:340px" role="dialog" aria-modal="true">' +
      '<div class="modal-title" id="dm-lock-pw-title">\uD83D\uDD12 Unlock chat</div>' +
      '<p id="dm-lock-pw-sub" style="font-size:13px;color:#888;margin:-4px 0 14px;line-height:1.45"></p>' +
      '<p style="font-size:12px;color:#888;margin:-6px 0 12px;line-height:1.45">No App PIN on this account — enter your account password.</p>' +
      '<label class="modal-label" for="dm-lock-pw-input">Account password</label>' +
      '<input type="password" id="dm-lock-pw-input" class="modal-input" autocomplete="current-password" maxlength="128" placeholder="Your FrogTalk password">' +
      '<p style="font-size:12px;color:#888;margin:10px 0 0;line-height:1.45">' +
      '<button type="button" id="dm-lock-set-pin-link" style="background:none;border:none;color:var(--accent-color,#4caf50);cursor:pointer;padding:0;font-size:12px">Set an App PIN</button> for faster unlock next time.</p>' +
      '<div id="dm-lock-pw-error" class="auth-error" style="display:none;margin-top:10px" role="alert"></div>' +
      '<div class="modal-actions" style="margin-top:14px">' +
      '<button type="button" class="modal-btn secondary" id="dm-lock-pw-cancel">Cancel</button>' +
      '<button type="button" class="modal-btn primary" id="dm-lock-pw-submit">Unlock</button></div></div>';
    document.body.appendChild(modal);
    _el('dm-lock-pw-cancel').addEventListener('click', () => _finishPassword(false));
    _el('dm-lock-set-pin-link').addEventListener('click', () => {
      try { closeModal(PW_MODAL_ID); } catch { modal.classList.add('hidden'); }
      try { Pin.openSettings(); } catch {}
      _finishPassword(false);
    });
    _el('dm-lock-pw-submit').addEventListener('click', () => { void _submitPasswordUnlock(); });
    return modal;
  }

  function _finishPassword(ok) {
    const modal = _el(PW_MODAL_ID);
    try { closeModal(PW_MODAL_ID); } catch { if (modal) modal.classList.add('hidden'); }
    const resolve = _pendingResolve;
    _pendingResolve = null;
    if (resolve) resolve(!!ok);
  }

  async function _submitPasswordUnlock() {
    const modal = _el(PW_MODAL_ID);
    const channelId = Number((modal && modal._ftChannelId) || (typeof _activeDM !== 'undefined' && _activeDM && _activeDM.id)) || 0;
    const errEl = _el('dm-lock-pw-error');
    const btn = _el('dm-lock-pw-submit');
    if (!channelId) { _finishPassword(false); return; }
    const password = String((_el('dm-lock-pw-input') && _el('dm-lock-pw-input').value) || '');
    if (!password) {
      if (errEl) { errEl.textContent = 'Enter your account password.'; errEl.style.display = ''; }
      return;
    }
    if (btn) btn.disabled = true;
    try {
      const res = await apiFetch('/api/dms/' + channelId + '/unlock', 'POST', { password });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (errEl) { errEl.textContent = j.error || 'Unlock failed'; errEl.style.display = ''; }
        return;
      }
      _markSessionUnlocked(channelId);
      _finishPassword(true);
    } catch {
      if (errEl) { errEl.textContent = 'Network error — try again.'; errEl.style.display = ''; }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function _gatePassword(channelId, nickname) {
    return new Promise((resolve) => {
      _pendingResolve = resolve;
      const modal = _ensurePasswordModal();
      modal._ftChannelId = Number(channelId) || 0;
      const sub = _el('dm-lock-pw-sub');
      if (sub) sub.textContent = 'This conversation with @' + (nickname || _channelMeta(channelId).nickname || 'chat') + ' is locked.';
      const errEl = _el('dm-lock-pw-error');
      const inp = _el('dm-lock-pw-input');
      if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
      if (inp) inp.value = '';
      try { openModal(PW_MODAL_ID); } catch { modal.classList.remove('hidden'); }
      setTimeout(() => { if (inp) inp.focus(); }, 40);
    });
  }

  async function gate(channelId, nickname) {
    const id = Number(channelId) || 0;
    if (!id) return true;
    const ch = _channelMeta(id);
    if (!ch.my_pin_lock && !ch.pin_lock_enabled) return true;
    if (ch._dmSessionUnlocked && !ch.dm_locked) return true;

    const hasPin = await _hasAppPin();
    if (hasPin && window.Pin && typeof Pin.gateDmUnlock === 'function') {
      const ok = await Pin.gateDmUnlock(id, nickname || ch.nickname);
      if (ok) _markSessionUnlocked(id);
      return ok;
    }
    return _gatePassword(id, nickname);
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
    if (enabled) {
      ch.dm_locked = true;
      ch._dmSessionUnlocked = false;
    } else {
      ch.dm_locked = false;
      ch._dmSessionUnlocked = false;
    }
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
    if (ch.my_pin_lock) {
      ch.dm_locked = true;
      ch._dmSessionUnlocked = false;
    } else {
      ch.dm_locked = false;
      ch._dmSessionUnlocked = false;
    }
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
