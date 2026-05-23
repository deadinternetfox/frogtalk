/**
 * dm_key_manager.js — Client-only DM encryption key backup (.key export / import).
 * Keys never leave this browser; the server only stores encrypted message blobs.
 */
(function () {
  'use strict';

  const MODAL_ID = 'modal-ft-key-manager';

  function _toast(msg, kind) {
    try {
      if (typeof UI !== 'undefined' && UI.showToast) UI.showToast(msg, kind || 'info', 8000);
      else if (typeof toast === 'function') toast(msg, kind || 'info');
    } catch {}
  }

  function _el(id) {
    return document.getElementById(id);
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
    if (!el) return;
    el.textContent = msg || '';
  }

  function _switchTab(tab) {
    const onImport = String(tab || '').toLowerCase() === 'import';
    const exp = _el('ft-key-pane-export');
    const imp = _el('ft-key-pane-import');
    const tExp = _el('ft-key-tab-export');
    const tImp = _el('ft-key-tab-import');
    if (exp) exp.hidden = onImport;
    if (imp) imp.hidden = !onImport;
    if (tExp) tExp.classList.toggle('active', !onImport);
    if (tImp) tImp.classList.toggle('active', onImport);
    if (tExp) tExp.setAttribute('aria-selected', onImport ? 'false' : 'true');
    if (tImp) tImp.setAttribute('aria-selected', onImport ? 'true' : 'false');
    _setErr('');
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
    _setStatus('');
  }

  function open(tab) {
    try {
      _requireDeviceCrypto();
    } catch {
      _toast('Encryption module not loaded — hard refresh the page (Ctrl+Shift+R).', 'error');
      return false;
    }
    const modal = _el(MODAL_ID);
    if (!modal) {
      _toast('Key manager UI missing — hard refresh the page.', 'error');
      return false;
    }
    _resetForm();
    _switchTab(tab === 'import' ? 'import' : 'export');
    const sub = _el('ft-key-manager-subtitle');
    if (sub) {
      const nick = (window.State && State.user && State.user.nickname)
        ? `@${State.user.nickname}`
        : 'your account';
      sub.textContent = `Backup or restore end-to-end encryption for ${nick}. Keys stay in this browser only.`;
    }
    if (typeof openModal === 'function') {
      openModal(MODAL_ID);
    } else {
      modal.classList.remove('hidden');
    }
    void _refreshStatus();
    return true;
  }

  function close() {
    if (typeof closeModal === 'function') closeModal(MODAL_ID);
    else _el(MODAL_ID)?.classList.add('hidden');
  }

  async function _refreshStatus() {
    try {
      await _ensureCryptoReady();
      const has = await DeviceCrypto.hasExportableCrypto();
      _setStatus(has
        ? 'Ready — you can export a .key file from this device.'
        : 'No encryption identity yet. Open a DM and send one message, then try again.');
    } catch {
      _setStatus('Unlock encryption in this browser before exporting.');
    }
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
      await DeviceCrypto.downloadKeyFile(p1);
      _toast('Downloaded .key file — store it somewhere safe.', 'success');
      close();
    } catch (e) {
      const code = String((e && e.message) || e || '');
      if (code === 'dct_export_too_large') {
        _setErr('Backup too large — export from home with fewer open DMs.');
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
      _toast('Keys restored — unlocking messages…', 'success');
      await _afterImport();
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

  function _bindModal() {
    _el('ft-key-tab-export')?.addEventListener('click', () => _switchTab('export'));
    _el('ft-key-tab-import')?.addEventListener('click', () => _switchTab('import'));
    _el('ft-key-export-btn')?.addEventListener('click', () => { void runExport(); });
    _el('ft-key-import-btn')?.addEventListener('click', () => { void runImport(); });
    _el('ft-key-manager-close')?.addEventListener('click', () => close());
  }

  function _wireDelegatedClicks() {
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest?.('[data-ft-key-action]');
      if (!trigger) return;
      e.preventDefault();
      e.stopPropagation();
      const action = String(trigger.getAttribute('data-ft-key-action') || 'import').toLowerCase();
      open(action === 'export' ? 'export' : 'import');
    }, true);
  }

  function _init() {
    _bindModal();
    _wireDelegatedClicks();
  }

  const DmKeyManager = {
    open,
    close,
    runExport,
    runImport,
    MODAL_ID,
  };

  try {
    window.DmKeyManager = DmKeyManager;
    window.showDmCryptoKeysModal = (tab) => open(tab);
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
