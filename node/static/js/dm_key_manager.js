/**
 * dm_key_manager.js — Client-only encryption key manager (DM sessions + room secrets).
 * Keys never leave the browser except in user-downloaded .key files.
 */
(function () {
  'use strict';

  const MODAL_ID = 'modal-ft-key-manager';
  const GATE_MODAL_ID = 'modal-ft-key-gate';
  const AUTH_TTL_MS = 8 * 60 * 1000;
  const _SS_AUTH_AT = 'ft_keymgr_auth_at';

  let _openContext = null;
  let _inventory = null;
  let _selectedPeerIds = new Set();
  let _selectedRoomKeys = new Set();
  let _importPreview = null;
  let _importFileText = null;

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

  async function _pinIsConfigured() {
    if (!window.Pin) return false;
    try { await Pin.refreshFromServer(); } catch {}
    const cfg = Pin.config ? Pin.config() : {};
    return !!cfg.has_pin;
  }

  async function _gatePin() {
    if (!window.Pin) return false;
    if (!(await _pinIsConfigured())) return true;
    if (typeof Pin.gateKeyManager === 'function') return Pin.gateKeyManager();
    try { Pin.lockNow(); } catch { return false; }
    return new Promise((resolve) => {
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
    const hasPin = await _pinIsConfigured();
    if (hasPin) {
      const pinOk = await _gatePin();
      if (!pinOk) {
        _toast('PIN required to open the key manager.', 'warning');
        return false;
      }
      try { sessionStorage.setItem(_SS_AUTH_AT, String(Date.now())); } catch {}
      return true;
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
    if (t === 'import') _hideImportPreview();
  }

  function _hideImportPreview() {
    _importPreview = null;
    _importFileText = null;
    const form = _el('ft-key-import-form');
    const prev = _el('ft-key-import-preview');
    if (form) form.hidden = false;
    if (prev) prev.hidden = true;
    const body = _el('ft-key-preview-body');
    if (body) body.textContent = '';
  }

  function _showImportPreview(summary) {
    const form = _el('ft-key-import-form');
    const prev = _el('ft-key-import-preview');
    const body = _el('ft-key-preview-body');
    if (!prev || !body) return;
    _importPreview = summary;
    if (form) form.hidden = true;
    prev.hidden = false;
    body.textContent = '';
    const dl = document.createElement('dl');
    const addRow = (label, value) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dl.appendChild(dt);
      dl.appendChild(dd);
    };
    const scope = summary.exportScope === 'partial' ? 'Selected keys only' : 'Full backup';
    addRow('Backup type', scope);
    addRow('Exported', _fmtTime(summary.exportedAt));
    addRow('From node', summary.nodeOrigin || '—');
    addRow('Account in file', summary.accountNickname ? `@${summary.accountNickname}` : '—');
    addRow('DM sessions', String(summary.dmSessionCount || 0));
    addRow('DM peers', String(summary.dmPeerCount || 0));
    addRow('Private groups', String(summary.roomSecretCount || 0));
    addRow('Identity key', summary.identityPresent ? 'Included' : 'Not included');
    body.appendChild(dl);
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
    _hideImportPreview();
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

  function _getDeleteSelectionFromUi() {
    const peerLocalIds = new Set(_selectedPeerIds);
    const roomStorageKeys = new Set(_selectedRoomKeys);
    return { peerLocalIds, roomStorageKeys };
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
    if (summary) {
      summary.textContent = '';
      const addMeta = (text) => {
        const d = document.createElement('div');
        d.className = 'ft-key-inv-meta';
        d.textContent = text;
        summary.appendChild(d);
      };
      addMeta(`Device identity: ${_inventory.hasIdentity ? 'present' : 'none'} · Signal sessions: ${_inventory.sessionCount || 0}`);
      addMeta(`Last export: ${_fmtTime(_inventory.lastExportAt)} · Last import: ${_fmtTime(_inventory.lastImportAt)}`);
      addMeta(`Node: ${_inventory.nodeOrigin || ''} — keys are not sent to the server.`);
    }

    list.textContent = '';
    const peerSection = document.createElement('div');
    peerSection.className = 'ft-key-inv-section';
    const peerHead = document.createElement('div');
    peerHead.className = 'ft-key-inv-section-head';
    peerHead.innerHTML = '<span>Direct messages</span><label class="ft-key-select-all"><input type="checkbox" id="ft-key-select-all-peers"> Select all</label>';
    peerSection.appendChild(peerHead);
    if (!(_inventory.peers || []).length) {
      const empty = document.createElement('div');
      empty.className = 'ft-key-inv-empty';
      empty.textContent = 'No DM encryption sessions yet — send a message in a DM first.';
      peerSection.appendChild(empty);
    } else {
      for (const p of _inventory.peers) {
        const label = document.createElement('label');
        label.className = 'ft-key-inv-row' + (ctx.peerUserId === p.localUserId ? ' ft-key-row-focus' : '');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'ft-key-peer-cb';
        cb.dataset.peerId = String(p.localUserId);
        cb.checked = _selectedPeerIds.has(p.localUserId);
        cb.addEventListener('change', () => {
          const id = Number(p.localUserId);
          if (cb.checked) _selectedPeerIds.add(id);
          else _selectedPeerIds.delete(id);
        });
        const body = document.createElement('div');
        body.className = 'ft-key-inv-row-body';
        const title = document.createElement('div');
        title.className = 'ft-key-inv-title';
        title.textContent = `@${p.nickname}`;
        const badge = document.createElement('span');
        badge.className = 'ft-key-badge' + (p.imported ? ' ft-key-badge-ok' : '');
        badge.textContent = p.imported ? 'imported' : 'local';
        title.appendChild(document.createTextNode(' '));
        title.appendChild(badge);
        const sub1 = document.createElement('div');
        sub1.className = 'ft-key-inv-sub';
        const gidHint = p.globalUserId ? ` · gid …${p.globalUserId.slice(-8)}` : '';
        sub1.textContent = `${p.sessionCount} session${p.sessionCount !== 1 ? 's' : ''} · ${p.sessionCount > 0 ? (p.imported ? 'Imported' : 'Active in browser') : 'No session'}${gidHint}`;
        const sub2 = document.createElement('div');
        sub2.className = 'ft-key-inv-sub';
        sub2.textContent = `Exported: ${_fmtTime(p.lastExportAt)}`;
        body.appendChild(title);
        body.appendChild(sub1);
        body.appendChild(sub2);
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'ft-key-row-delete';
        delBtn.title = 'Delete keys for this contact';
        delBtn.setAttribute('aria-label', `Delete keys for @${p.nickname}`);
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          void _deleteKeys({ peerLocalIds: new Set([p.localUserId]), roomStorageKeys: new Set() });
        });
        label.appendChild(cb);
        label.appendChild(body);
        label.appendChild(delBtn);
        peerSection.appendChild(label);
      }
    }
    list.appendChild(peerSection);

    const roomSection = document.createElement('div');
    roomSection.className = 'ft-key-inv-section';
    const roomHead = document.createElement('div');
    roomHead.className = 'ft-key-inv-section-head';
    roomHead.innerHTML = '<span>Private groups</span><label class="ft-key-select-all"><input type="checkbox" id="ft-key-select-all-rooms"> Select all</label>';
    roomSection.appendChild(roomHead);
    if (!(_inventory.rooms || []).length) {
      const empty = document.createElement('div');
      empty.className = 'ft-key-inv-empty';
      empty.textContent = 'No room secrets in this browser.';
      roomSection.appendChild(empty);
    } else {
      (_inventory.rooms || []).forEach((r, idx) => {
        const label = document.createElement('label');
        label.className = 'ft-key-inv-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'ft-key-room-cb';
        cb.dataset.roomIdx = String(idx);
        cb.checked = _selectedRoomKeys.has(r.storageKey);
        cb.addEventListener('change', () => {
          const room = (_inventory.rooms || [])[idx];
          if (!room) return;
          if (cb.checked) _selectedRoomKeys.add(room.storageKey);
          else _selectedRoomKeys.delete(room.storageKey);
        });
        const body = document.createElement('div');
        body.className = 'ft-key-inv-row-body';
        const title = document.createElement('div');
        title.className = 'ft-key-inv-title';
        title.textContent = `#${r.roomName}`;
        const badge = document.createElement('span');
        badge.className = 'ft-key-badge';
        badge.textContent = 'private group';
        title.appendChild(document.createTextNode(' '));
        title.appendChild(badge);
        const sub = document.createElement('div');
        sub.className = 'ft-key-inv-sub';
        sub.textContent = 'Room secret stored locally · server cannot decrypt';
        body.appendChild(title);
        body.appendChild(sub);
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'ft-key-row-delete';
        delBtn.title = 'Delete room secret from this device';
        delBtn.setAttribute('aria-label', `Delete secret for #${r.roomName}`);
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          void _deleteKeys({ peerLocalIds: new Set(), roomStorageKeys: new Set([r.storageKey]) });
        });
        label.appendChild(cb);
        label.appendChild(body);
        label.appendChild(delBtn);
        roomSection.appendChild(label);
      });
    }
    list.appendChild(roomSection);
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

  async function _deleteKeys({ peerLocalIds, roomStorageKeys }) {
    const peers = peerLocalIds instanceof Set ? peerLocalIds : new Set(peerLocalIds || []);
    const rooms = roomStorageKeys instanceof Set ? roomStorageKeys : new Set(roomStorageKeys || []);
    if (!peers.size && !rooms.size) {
      _toast('Select at least one DM or private group to delete.', 'warning');
      return;
    }
    const peerNames = (_inventory?.peers || [])
      .filter((p) => peers.has(p.localUserId))
      .map((p) => `@${p.nickname}`);
    const roomNames = (_inventory?.rooms || [])
      .filter((r) => rooms.has(r.storageKey))
      .map((r) => `#${r.roomName}`);
    const parts = [];
    if (peerNames.length) parts.push(`${peerNames.length} DM key${peerNames.length !== 1 ? 's' : ''}`);
    if (roomNames.length) parts.push(`${roomNames.length} private group secret${roomNames.length !== 1 ? 's' : ''}`);
    const detail = [...peerNames, ...roomNames].slice(0, 6).join(', ');
    const more = peerNames.length + roomNames.length > 6 ? '…' : '';
    const ok = await UI.confirm({
      title: 'Delete selected keys?',
      message: `Remove ${parts.join(' and ')} from this browser only? ${detail}${more} — you can restore from a backup later.`,
      confirmLabel: 'Delete keys',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    const btn = _el('ft-key-delete-selected');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    try {
      await _ensureCryptoReady();
      const result = await DeviceCrypto.deleteSelectedKeys({ peerLocalIds: peers, roomStorageKeys: rooms });
      for (const id of peers) _selectedPeerIds.delete(id);
      for (const k of rooms) _selectedRoomKeys.delete(k);
      _toast(
        `Deleted ${result.deletedSessions || 0} session${(result.deletedSessions || 0) !== 1 ? 's' : ''}`
        + (result.deletedRooms ? ` and ${result.deletedRooms} room secret${result.deletedRooms !== 1 ? 's' : ''}` : '')
        + ' from this device.',
        'success',
      );
      void _loadInventory();
    } catch {
      _toast('Could not delete keys — try again.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Delete selected'; }
    }
  }

  async function runDeleteSelected() {
    const sel = _getDeleteSelectionFromUi();
    await _deleteKeys(sel);
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
      if (window.Signal && typeof Signal.ensureMyBundleFresh === 'function') {
        await Signal.ensureMyBundleFresh();
      }
    } catch {}
    try {
      if (window.Signal && typeof Signal.broadcastSelfCryptoResync === 'function') {
        await Signal.broadcastSelfCryptoResync({ limit: 16 });
      }
    } catch {}
    try {
      if (typeof window.__ftDmDecryptReset === 'function') window.__ftDmDecryptReset();
    } catch {}
    try {
      if (typeof _redecryptTravelDMMessages === 'function' && typeof _dmSkipHistoricalDecrypt === 'function'
          && _dmSkipHistoricalDecrypt()) {
        await _redecryptTravelDMMessages();
      } else if (typeof _redecryptStaleDMMessages === 'function' && typeof _activeDM !== 'undefined' && _activeDM) {
        await _redecryptStaleDMMessages();
      }
    } catch {}
    try {
      if (typeof _retryPendingDmDecrypts === 'function') await _retryPendingDmDecrypts();
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
    try {
      if (typeof _dmPostCryptoSyncNotice === 'function'
          && typeof _activeDM !== 'undefined' && _activeDM?.user_id && _activeDM?.id) {
        void _dmPostCryptoSyncNotice(_activeDM.user_id, {
          actor: 'self',
          reason: 'manual',
          channelId: _activeDM.id,
        });
      }
    } catch {}
    void _loadInventory();
  }

  async function runExport() {
    _setErr('');
    const p1 = String(_el('ft-key-export-pass')?.value || '');
    const p2 = String(_el('ft-key-export-pass2')?.value || '');
    if (p1.length < 12) {
      _setErr('Use a passphrase of at least 12 characters.');
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
      _toast('Downloaded .FrogTalk backup — store it somewhere safe.', 'success');
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
      if (btn) { btn.disabled = false; btn.textContent = 'Download .FrogTalk file'; }
    }
  }

  async function _readImportInputs() {
    const fileEl = _el('ft-key-file-input');
    const pass = String(_el('ft-key-import-pass')?.value || '');
    const file = fileEl?.files?.[0];
    if (!file) return { error: 'Choose a .FrogTalk backup file.' };
    if (window.DeviceCrypto?.keyfileExtensionOk && !DeviceCrypto.keyfileExtensionOk(file.name)) {
      return { error: 'Use a .FrogTalk backup file.' };
    }
    if (pass.length < 8) return { error: 'Enter the passphrase from when you exported.' };
    if (file.size > 12 * 1024 * 1024) return { error: 'Backup file is too large.' };
    let text;
    try {
      text = await file.text();
    } catch {
      return { error: 'Could not read the file.' };
    }
    return { text, pass, file };
  }

  async function runImportPreview() {
    _setErr('');
    const inp = await _readImportInputs();
    if (inp.error) {
      _setErr(inp.error);
      return;
    }
    const btn = _el('ft-key-preview-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Reviewing…'; }
    try {
      await _ensureCryptoReady();
      const summary = await DeviceCrypto.previewKeyFileFromText(inp.text, inp.pass);
      _importFileText = inp.text;
      _showImportPreview(summary);
    } catch (e) {
      const code = String((e && e.message) || e || '');
      if (code === 'wrong_passphrase') _setErr('Wrong passphrase for this file.');
      else if (code === 'bad_key_file') _setErr('Not a valid FrogTalk backup file.');
      else _setErr('Could not read backup — check the file and passphrase.');
      _hideImportPreview();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Review backup'; }
    }
  }

  async function runImportConfirm() {
    _setErr('');
    const pass = String(_el('ft-key-import-pass')?.value || '');
    let text = _importFileText;
    if (!text) {
      const inp = await _readImportInputs();
      if (inp.error) {
        _setErr(inp.error);
        return;
      }
      text = inp.text;
    }
    if (pass.length < 8) {
      _setErr('Enter the passphrase from when you exported.');
      return;
    }
    const btn = _el('ft-key-import-confirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
    try {
      await _ensureCryptoReady();
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
        _setErr('Not a valid FrogTalk backup file.');
      } else {
        _setErr('Import failed — check the file and passphrase.');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Restore keys'; }
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

  function _openFromTrigger(trigger) {
    const ctx = _readTriggerContext(trigger);
    const action = String(ctx.tab || 'import').toLowerCase();
    const tab = action === 'export' ? 'export' : (action === 'keys' ? 'keys' : 'import');
    if (typeof closeModal === 'function') {
      closeModal('modal-disappear');
      closeModal('modal-encrypt-verify');
    }
    return open(tab, ctx);
  }

  async function _resetDeviceKeys() {
    if (typeof window.resetEncryptionKeys === 'function') {
      close();
      await window.resetEncryptionKeys();
    } else {
      _toast('Reset is not available — hard refresh the page.', 'error');
    }
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
    _el('ft-key-preview-btn')?.addEventListener('click', () => { void runImportPreview(); });
    _el('ft-key-import-confirm')?.addEventListener('click', () => { void runImportConfirm(); });
    _el('ft-key-import-back')?.addEventListener('click', () => _hideImportPreview());
    _el('ft-key-delete-selected')?.addEventListener('click', () => { void runDeleteSelected(); });
    _el('ft-key-manager-close')?.addEventListener('click', () => close());
    _el('ft-key-reset-device')?.addEventListener('click', () => { void _resetDeviceKeys(); });
    _el('ft-key-open-from-privacy')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void _openFromTrigger(e.currentTarget);
    });
  }

  function _wireDelegatedClicks() {
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest?.('[data-ft-key-action]');
      if (!trigger) return;
      if (trigger.id === 'ft-key-open-from-privacy') return;
      e.preventDefault();
      e.stopPropagation();
      void _openFromTrigger(trigger);
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
    runImport: runImportConfirm,
    runImportPreview,
    runImportConfirm,
    runDeleteSelected,
    refreshInventory: _loadInventory,
    MODAL_ID,
  };

  try {
    window.DmKeyManager = DmKeyManager;
    window.showDmCryptoKeysModal = (tab, opts) => open(tab, opts);
    window.openDmKeyManager = (tab, opts) => open(tab, opts);
    window.submitDmKeysExport = () => { void runExport(); };
    window.submitDmKeysImport = () => { void runImportConfirm(); };
    window.switchDmKeysModalTab = (tab) => _switchTab(tab);
  } catch {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
