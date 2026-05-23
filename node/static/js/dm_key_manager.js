/**
 * dm_key_manager.js — Client-only encryption key manager (DM sessions + room secrets).
 * Keys never leave the browser except in user-downloaded .key files.
 */
(function () {
  'use strict';

  const MODAL_ID = 'modal-ft-key-manager';
  const GATE_MODAL_ID = 'modal-ft-key-gate';
  const AUTH_TTL_MS = 8 * 60 * 1000;
  const PIN_RECENT_MS = 2 * 60 * 1000;
  const _SS_PIN_UNLOCKED = 'frogtalk-pin-unlocked-at';
  const _SS_AUTH_AT = 'ft_keymgr_auth_at';

  let _openContext = null;
  let _inventory = null;
  let _selectedPeerIds = new Set();
  let _selectedRoomKeys = new Set();

  function _toast(msg, kind) {
    try {
      if (typeof UI !== 'undefined' && UI.showToast) UI.showToast(msg, kind || 'info', 8000);
      else if (typeof toast === 'function') toast(msg, kind || 'info');
    } catch {}
  }

  function _el(id) {
    return document.getElementById(id);
  }

  function _esc(s) {
    if (typeof UI !== 'undefined' && UI.escHtml) return UI.escHtml(s);
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function _fmtTime(ts) {
    const n = Number(ts) || 0;
    if (!n) return '—';
    try {
      return new Date(n).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return '—';
    }
  }

  function _authFresh() {
    try {
      const at = Number(sessionStorage.getItem(_SS_AUTH_AT) || 0);
      return at > 0 && (Date.now() - at) < AUTH_TTL_MS;
    } catch {
      return false;
    }
  }

  function _pinRecentlyUnlocked() {
    try {
      const at = Number(sessionStorage.getItem(_SS_PIN_UNLOCKED) || 0);
      return at > 0 && (Date.now() - at) < PIN_RECENT_MS;
    } catch {
      return false;
    }
  }

  async function _gatePin() {
    if (!window.Pin) return true;
    try { await Pin.refreshFromServer(); } catch {}
    const cfg = Pin.config ? Pin.config() : {};
    if (!cfg.has_pin) return true;
    if (_pinRecentlyUnlocked() && !Pin.isLocked()) return true;
    return new Promise((resolve) => {
      try { Pin.lockNow(); } catch { resolve(false); return; }
      const start = Date.now();
      const iv = setInterval(() => {
        if (!Pin.isLocked()) {
          clearInterval(iv);
          resolve(true);
          return;
        }
        if (Date.now() - start > 5 * 60 * 1000) {
          clearInterval(iv);
          resolve(false);
        }
      }, 200);
    });
  }

  function _promptPassword() {
    return new Promise((resolve) => {
      const modal = _el(GATE_MODAL_ID);
      const input = _el('ft-key-gate-password');
      const err = _el('ft-key-gate-error');
      const btn = _el('ft-key-gate-submit');
      if (!modal || !input) {
        resolve('');
        return;
      }
      const finish = (pw) => {
        try { closeModal(GATE_MODAL_ID); } catch { modal.classList.add('hidden'); }
        modal._ftResolve = null;
        resolve(pw || '');
      };
      const show = () => {
        input.value = '';
        if (err) { err.textContent = ''; err.style.display = 'none'; }
        if (btn) btn.disabled = false;
        modal._ftResolve = finish;
        if (typeof openModal === 'function') openModal(GATE_MODAL_ID);
        else modal.classList.remove('hidden');
        setTimeout(() => input.focus(), 40);
      };
      modal._ftSubmit = async () => {
        const pw = String(input?.value || '');
        if (pw.length < 1) {
          if (err) { err.textContent = 'Enter your account password.'; err.style.display = ''; }
          return;
        }
        if (btn) btn.disabled = true;
        const ok = await _verifyPassword(pw);
        if (btn) btn.disabled = false;
        if (!ok) {
          if (err) { err.textContent = 'Incorrect password.'; err.style.display = ''; }
          input.value = '';
          input.focus();
          return;
        }
        finish(pw);
      };
      show();
    });
  }

  async function _verifyPassword(pw) {
    const pass = String(pw || '');
    if (pass.length < 1) return false;
    try {
      const res = await apiFetch('/api/auth/verify-password', 'POST', { password: pass });
      return !!res.ok;
    } catch {
      return false;
    }
  }

  async function _gateAccess() {
    if (_authFresh()) return true;
    const pinOk = await _gatePin();
    if (!pinOk) {
      _toast('PIN required to open the key manager.', 'warning');
      return false;
    }
    const pw = await _promptPassword();
    if (!pw) return false;
    try { sessionStorage.setItem(_SS_AUTH_AT, String(Date.now())); } catch {}
    return true;
  }

  function _setErr(msg) {
    const el = _el('ft-key-manager-error');
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.style.display = '';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  }

  function _setStatus(msg) {
    const el = _el('ft-key-manager-status');
    if (el) el.textContent = msg || '';
  }

  function _switchTab(tab) {
    const tabs = ['keys', 'export', 'import'];
    const t = tabs.includes(String(tab || '').toLowerCase()) ? String(tab).toLowerCase() : 'keys';
    tabs.forEach((name) => {
      const pane = _el(`ft-key-pane-${name}`);
      const btn = _el(`ft-key-tab-${name}`);
      const on = name === t;
      if (pane) pane.hidden = !on;
      if (btn) {
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      }
    });
    _setErr('');
    if (t === 'keys') void _renderInventory();
  }

  function _requireDeviceCrypto() {
    if (!window.DeviceCrypto || typeof DeviceCrypto.downloadKeyFile !== 'function') {
      throw new Error('crypto_module_missing');
    }
  }

  async function _ensureCryptoReady() {
    _requireDeviceCrypto();
    const uid = Number((window.State && State.user && State.user.id) || 0);
    if (uid > 0 && window.Signal) {
      try {
        if (typeof Signal.ensureReady === 'function') {
          await Signal.ensureReady(uid, { timeoutMs: 20000 });
        } else if (typeof Signal.init === 'function' && !Signal.isReady()) {
          await Signal.init(uid);
        }
      } catch (e) {
        console.warn('[DmKeyManager] Signal init', e);
      }
    }
    if (typeof DeviceCrypto.ensureReadyForExport === 'function') {
      await DeviceCrypto.ensureReadyForExport();
    }
  }

  function _resetForm() {
    const fin = _el('ft-key-file-input');
    if (fin) fin.value = '';
    ['ft-key-export-pass', 'ft-key-export-pass2', 'ft-key-import-pass'].forEach((id) => {
      const inp = _el(id);
      if (inp) inp.value = '';
    });
    _setErr('');
  }

  function _resolveOpenContext(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    let peerUserId = Number(o.peerUserId || o.peerId || 0);
    let dmChannelId = Number(o.dmChannelId || o.dmId || 0);
    let peerGid = String(o.peerGid || o.globalUserId || '').trim();
    let peerNick = String(o.peerNick || o.nickname || '').trim();

    if ((!peerUserId || !peerNick) && typeof _activeDM !== 'undefined' && _activeDM) {
      if (!peerUserId) peerUserId = Number(_activeDM.user_id || 0);
      if (!dmChannelId) dmChannelId = Number(_activeDM.id || 0);
      if (!peerNick) peerNick = String(_activeDM.nickname || '').trim();
    }
    if (!peerGid && peerUserId && typeof _dmChannels !== 'undefined' && Array.isArray(_dmChannels)) {
      const ch = _dmChannels.find((c) => Number(c.user_id || c.other_id || c.with_user_id) === peerUserId
        || Number(c.id) === dmChannelId);
      if (ch) {
        peerGid = String(ch.peer_global_user_id || ch.global_user_id || ch.other_global_user_id || '').trim();
        if (!peerNick) peerNick = String(ch.nickname || ch.other_nickname || '').trim();
      }
    }
    return { peerUserId, dmChannelId, peerGid, peerNick, tab: o.tab || o.action || 'keys' };
  }

  function _applyContextSelection(ctx) {
    _selectedPeerIds.clear();
    _selectedRoomKeys.clear();
    const focused = Number(ctx.peerUserId) || 0;
    if (_inventory) {
      if (focused > 0) {
        _selectedPeerIds.add(focused);
      } else if (ctx.peerNick) {
        const hit = (_inventory.peers || []).find((p) => p.nickname === ctx.peerNick);
        if (hit) _selectedPeerIds.add(hit.localUserId);
        else (_inventory.peers || []).forEach((p) => _selectedPeerIds.add(p.localUserId));
      } else {
        (_inventory.peers || []).forEach((p) => _selectedPeerIds.add(p.localUserId));
      }
      (_inventory.rooms || []).forEach((r) => _selectedRoomKeys.add(r.storageKey));
    }
  }

  function _getExportOptionsFromUi() {
    const peerTotal = (_inventory?.peers || []).length;
    const roomTotal = (_inventory?.rooms || []).length;
    const allPeers = peerTotal === 0 || _selectedPeerIds.size >= peerTotal;
    const allRooms = roomTotal === 0 || _selectedRoomKeys.size >= roomTotal;
    if (allPeers && allRooms) {
      return { peerLocalIds: null, roomStorageKeys: null, includeIdentity: true };
    }
    const peerLocalIds = new Set(_selectedPeerIds);
    const roomStorageKeys = new Set(_selectedRoomKeys);
    return {
      peerLocalIds: peerLocalIds.size ? peerLocalIds : null,
      roomStorageKeys: roomStorageKeys.size ? roomStorageKeys : null,
      includeIdentity: true,
    };
  }

  function _renderInventory() {
    const list = _el('ft-key-inventory-list');
    const summary = _el('ft-key-inventory-summary');
    if (!list) return;
    if (!_inventory) {
      list.innerHTML = '<div class="ft-key-inv-empty">Loading encryption keys…</div>';
      return;
    }
    const ctx = _openContext || {};
    const lines = [];
    lines.push(`<div class="ft-key-inv-meta">Device identity: <b>${_inventory.hasIdentity ? 'present' : 'none'}</b> · Signal sessions: <b>${_inventory.sessionCount || 0}</b></div>`);
    lines.push(`<div class="ft-key-inv-meta">Last export: <b>${_esc(_fmtTime(_inventory.lastExportAt))}</b> · Last import: <b>${_esc(_fmtTime(_inventory.lastImportAt))}</b></div>`);
    lines.push(`<div class="ft-key-inv-meta">Node: <b>${_esc(_inventory.nodeOrigin || '')}</b> — keys are not sent to the server.</div>`);
    if (summary) summary.innerHTML = lines.join('');

    const peerRows = (_inventory.peers || []).map((p) => {
      const sel = _selectedPeerIds.has(p.localUserId);
      const highlight = ctx.peerUserId === p.localUserId ? ' ft-key-row-focus' : '';
      const status = p.sessionCount > 0
        ? (p.imported ? 'Imported' : 'Active in browser')
        : 'No session';
      const badge = p.imported ? '<span class="ft-key-badge ft-key-badge-ok">imported</span>' : '<span class="ft-key-badge">local</span>';
      return `<label class="ft-key-inv-row${highlight}">
        <input type="checkbox" class="ft-key-peer-cb" data-peer-id="${p.localUserId}" ${sel ? 'checked' : ''}>
        <div class="ft-key-inv-row-body">
          <div class="ft-key-inv-title">@${_esc(p.nickname)} ${badge}</div>
          <div class="ft-key-inv-sub">${p.sessionCount} session${p.sessionCount !== 1 ? 's' : ''} · ${status}${p.globalUserId ? ` · gid …${_esc(p.globalUserId.slice(-8))}` : ''}</div>
          <div class="ft-key-inv-sub">Exported: ${_esc(_fmtTime(p.lastExportAt))}</div>
        </div>
      </label>`;
    }).join('');

    const roomRows = (_inventory.rooms || []).map((r) => {
      const sel = _selectedRoomKeys.has(r.storageKey);
      return `<label class="ft-key-inv-row">
        <input type="checkbox" class="ft-key-room-cb" data-room-key="${_esc(r.storageKey)}" ${sel ? 'checked' : ''}>
        <div class="ft-key-inv-row-body">
          <div class="ft-key-inv-title">#${_esc(r.roomName)} <span class="ft-key-badge">private group</span></div>
          <div class="ft-key-inv-sub">Room secret stored locally · server cannot decrypt</div>
        </div>
      </label>`;
    }).join('');

    list.innerHTML = `
      <div class="ft-key-inv-section">
        <div class="ft-key-inv-section-head">
          <span>Direct messages</span>
          <label class="ft-key-select-all"><input type="checkbox" id="ft-key-select-all-peers"> Select all</label>
        </div>
        ${peerRows || '<div class="ft-key-inv-empty">No DM encryption sessions yet — send a message in a DM first.</div>'}
      </div>
      <div class="ft-key-inv-section">
        <div class="ft-key-inv-section-head">
          <span>Private groups</span>
          <label class="ft-key-select-all"><input type="checkbox" id="ft-key-select-all-rooms"> Select all</label>
        </div>
        ${roomRows || '<div class="ft-key-inv-empty">No room secrets in this browser.</div>'}
      </div>`;

    list.querySelectorAll('.ft-key-peer-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = Number(cb.dataset.peerId);
        if (cb.checked) _selectedPeerIds.add(id);
        else _selectedPeerIds.delete(id);
      });
    });
    list.querySelectorAll('.ft-key-room-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        const k = cb.dataset.roomKey || '';
        if (cb.checked) _selectedRoomKeys.add(k);
        else _selectedRoomKeys.delete(k);
      });
    });
    const allP = _el('ft-key-select-all-peers');
    const allR = _el('ft-key-select-all-rooms');
    if (allP) {
      allP.checked = (_inventory.peers || []).length > 0
        && (_inventory.peers || []).every((p) => _selectedPeerIds.has(p.localUserId));
      allP.onchange = () => {
        if (allP.checked) {
          (_inventory.peers || []).forEach((p) => _selectedPeerIds.add(p.localUserId));
        } else _selectedPeerIds.clear();
        void _renderInventory();
      };
    }
    if (allR) {
      allR.checked = (_inventory.rooms || []).length > 0
        && (_inventory.rooms || []).every((r) => _selectedRoomKeys.has(r.storageKey));
      allR.onchange = () => {
        if (allR.checked) {
          (_inventory.rooms || []).forEach((r) => _selectedRoomKeys.add(r.storageKey));
        } else _selectedRoomKeys.clear();
        void _renderInventory();
      };
    }
  }

  async function _loadInventory() {
    try {
      await _ensureCryptoReady();
      _inventory = await DeviceCrypto.listKeyInventory();
    } catch {
      _inventory = { peers: [], rooms: [], hasIdentity: false, sessionCount: 0 };
    }
    _applyContextSelection(_openContext || {});
    _renderInventory();
  }

  async function open(tab, opts) {
    _openContext = _resolveOpenContext({ tab, ...(opts || {}) });
    try {
      _requireDeviceCrypto();
    } catch {
      _toast('Encryption module not loaded — hard refresh (Ctrl+Shift+R).', 'error');
      return false;
    }
    const allowed = await _gateAccess();
    if (!allowed) return false;

    const modal = _el(MODAL_ID);
    if (!modal) {
      _toast('Key manager UI missing — hard refresh the page.', 'error');
      return false;
    }
    _resetForm();
    const wantTab = String(tab || _openContext.tab || 'keys').toLowerCase();
    _switchTab(wantTab === 'export' || wantTab === 'import' ? wantTab : 'keys');
    const sub = _el('ft-key-manager-subtitle');
    if (sub) {
      const nick = (window.State && State.user && State.user.nickname)
        ? `@${State.user.nickname}`
        : 'your account';
      const peer = _openContext.peerNick ? ` · focused: @${_openContext.peerNick}` : '';
      sub.textContent = `Manage end-to-end keys for ${nick}${peer}. Nothing is uploaded to FrogTalk.`;
    }
    if (typeof openModal === 'function') openModal(MODAL_ID);
    else modal.classList.remove('hidden');
    void _loadInventory();
    return true;
  }

  function close() {
    if (typeof closeModal === 'function') closeModal(MODAL_ID);
    else _el(MODAL_ID)?.classList.add('hidden');
  }

  async function _afterImport() {
    try { window.__ftDctImported = true; } catch {}
    try {
      if (typeof window.__ftDmDecryptReset === 'function') window.__ftDmDecryptReset();
    } catch {}
    try {
      if (typeof _redecryptStaleDMMessages === 'function' && typeof _activeDM !== 'undefined' && _activeDM) {
        await _redecryptStaleDMMessages();
      }
    } catch {}
    try {
      if (typeof _refreshDmLockPlaceholders === 'function') await _refreshDmLockPlaceholders();
    } catch {}
    try {
      if (typeof loadDMChannels === 'function') await loadDMChannels();
    } catch {}
    try {
      if (typeof loadDMMessages === 'function' && typeof _activeDM !== 'undefined' && _activeDM?.id) {
        await loadDMMessages(0);
      }
    } catch {}
    try {
      window.dispatchEvent(new CustomEvent('ft:crypto-ready'));
    } catch {}
    void _loadInventory();
  }

  async function runExport() {
    _setErr('');
    const p1 = String(_el('ft-key-export-pass')?.value || '');
    const p2 = String(_el('ft-key-export-pass2')?.value || '');
    if (p1.length < 8) {
      _setErr('Use a passphrase of at least 8 characters.');
      return;
    }
    if (p1 !== p2) {
      _setErr('Passphrases do not match.');
      return;
    }
    const btn = _el('ft-key-export-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
    try {
      await _ensureCryptoReady();
      const has = await DeviceCrypto.hasExportableCrypto();
      if (!has) {
        _setErr('No encryption keys in this browser yet — send a DM message first.');
        return;
      }
      const exportOpts = _getExportOptionsFromUi();
      const pCount = (_inventory?.peers || []).length;
      const rCount = (_inventory?.rooms || []).length;
      if (pCount + rCount > 0 && !exportOpts.peerLocalIds && !exportOpts.roomStorageKeys
          && (_selectedPeerIds.size === 0 && _selectedRoomKeys.size === 0)) {
        _setErr('Select at least one DM or private group to export.');
        return;
      }
      await DeviceCrypto.downloadKeyFile(p1, exportOpts);
      try {
        const gids = (_inventory?.peers || [])
          .filter((p) => !exportOpts.peerLocalIds || exportOpts.peerLocalIds.has(p.localUserId))
          .map((p) => p.globalUserId)
          .filter(Boolean);
        DeviceCrypto.recordKeyExportMeta(gids.length ? gids : (_inventory.peers || []).map((p) => p.globalUserId).filter(Boolean));
      } catch {}
      _toast('Downloaded .key file — store it somewhere safe.', 'success');
      void _loadInventory();
    } catch (e) {
      const code = String((e && e.message) || e || '');
      if (code === 'dct_export_too_large') {
        _setErr('Backup too large — export fewer chats or use home node.');
      } else if (code === 'no_signal_identity') {
        _setErr('No encryption identity found in this browser.');
      } else if (code === 'crypto_module_missing') {
        _setErr('Encryption module not loaded — refresh the page.');
      } else {
        _setErr('Export failed — try again after opening a DM.');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Download .key file'; }
    }
  }

  async function runImport() {
    _setErr('');
    const fileEl = _el('ft-key-file-input');
    const pass = String(_el('ft-key-import-pass')?.value || '');
    const file = fileEl?.files?.[0];
    if (!file) {
      _setErr('Choose a .key file.');
      return;
    }
    if (pass.length < 8) {
      _setErr('Enter the passphrase from when you exported.');
      return;
    }
    const btn = _el('ft-key-import-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
    try {
      await _ensureCryptoReady();
      const text = await file.text();
      await DeviceCrypto.importKeyFileFromText(text, pass);
      await _afterImport();
      let toastMsg = 'Keys restored successfully.';
      let toastKind = 'success';
      try {
        if (typeof window._tryAutoUnlockImportedHistory === 'function') {
          const stats = await window._tryAutoUnlockImportedHistory();
          if (stats?.unlocked > 0 && stats.stillLocked === 0) {
            toastMsg = `Keys restored — unlocked ${stats.unlocked} message${stats.unlocked !== 1 ? 's' : ''}.`;
          } else if (stats?.unlocked > 0) {
            toastMsg = `Unlocked ${stats.unlocked}; ${stats.stillLocked} still need keys.`;
            toastKind = 'info';
          } else if (stats?.stillLocked > 0) {
            toastMsg = `Keys imported but ${stats.stillLocked} message${stats.stillLocked !== 1 ? 's' : ''} could not be decrypted.`;
            toastKind = 'warning';
          }
        }
      } catch {}
      _toast(toastMsg, toastKind);
      close();
    } catch (e) {
      const code = String((e && e.message) || e || '');
      if (code === 'wrong_passphrase') {
        _setErr('Wrong passphrase for this file.');
      } else if (code === 'bad_key_file') {
        _setErr('Not a valid FrogTalk .key file.');
      } else {
        _setErr('Import failed — check the file and passphrase.');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Import keys'; }
    }
  }

  function _readTriggerContext(trigger) {
    if (!trigger) return {};
    return {
      tab: trigger.getAttribute('data-ft-key-action') || 'import',
      dmChannelId: Number(trigger.getAttribute('data-ft-dm-id') || 0),
      peerUserId: Number(trigger.getAttribute('data-ft-peer-id') || 0),
      peerGid: trigger.getAttribute('data-ft-peer-gid') || '',
      peerNick: trigger.getAttribute('data-ft-peer-nick') || '',
    };
  }

  function _bindGateModal() {
    _el('ft-key-gate-submit')?.addEventListener('click', () => {
      const modal = _el(GATE_MODAL_ID);
      if (modal && typeof modal._ftSubmit === 'function') void modal._ftSubmit();
    });
    _el('ft-key-gate-cancel')?.addEventListener('click', () => {
      const modal = _el(GATE_MODAL_ID);
      if (modal && typeof modal._ftResolve === 'function') modal._ftResolve('');
    });
    _el('ft-key-gate-password')?.addEventListener('keydown', (e) => {
      const modal = _el(GATE_MODAL_ID);
      if (e.key === 'Enter') {
        e.preventDefault();
        if (modal && typeof modal._ftSubmit === 'function') void modal._ftSubmit();
      }
      if (e.key === 'Escape' && modal && typeof modal._ftResolve === 'function') {
        modal._ftResolve('');
      }
    });
  }

  function _bindModal() {
    _el('ft-key-tab-keys')?.addEventListener('click', () => _switchTab('keys'));
    _el('ft-key-tab-export')?.addEventListener('click', () => _switchTab('export'));
    _el('ft-key-tab-import')?.addEventListener('click', () => _switchTab('import'));
    _el('ft-key-export-btn')?.addEventListener('click', () => { void runExport(); });
    _el('ft-key-import-btn')?.addEventListener('click', () => { void runImport(); });
    _el('ft-key-manager-close')?.addEventListener('click', () => close());
    _el('ft-key-open-from-privacy')?.addEventListener('click', () => { void open('keys'); });
  }

  function _wireDelegatedClicks() {
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest?.('[data-ft-key-action]');
      if (!trigger) return;
      if (trigger.id === 'ft-key-open-from-privacy') return;
      e.preventDefault();
      e.stopPropagation();
      const ctx = _readTriggerContext(trigger);
      const action = String(ctx.tab || 'import').toLowerCase();
      void open(action === 'export' ? 'export' : (action === 'keys' ? 'keys' : 'import'), ctx);
    }, true);
  }

  function _init() {
    _bindGateModal();
    _bindModal();
    _wireDelegatedClicks();
  }

  const DmKeyManager = {
    open,
    close,
    runExport,
    runImport,
    refreshInventory: _loadInventory,
    MODAL_ID,
  };

  try {
    window.DmKeyManager = DmKeyManager;
    window.showDmCryptoKeysModal = (tab, opts) => open(tab, opts);
    window.openDmKeyManager = (tab, opts) => open(tab, opts);
    window.submitDmKeysExport = () => { void runExport(); };
    window.submitDmKeysImport = () => { void runImport(); };
    window.switchDmKeysModalTab = (tab) => _switchTab(tab);
  } catch {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
