// dm_crypto_keys.js — Manual .key export/import for DM encryption (this browser).
(function () {
  'use strict';

  function _toast(msg, kind) {
    try {
      if (typeof UI !== 'undefined' && UI.showToast) UI.showToast(msg, kind || 'info', 7000);
      else if (typeof toast === 'function') toast(msg, kind || 'info');
    } catch {}
  }

  function _setErr(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.style.display = '';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  }

  function _switchTab(tab) {
    const exp = document.getElementById('dm-keys-pane-export');
    const imp = document.getElementById('dm-keys-pane-import');
    const tExp = document.getElementById('dm-keys-tab-export');
    const tImp = document.getElementById('dm-keys-tab-import');
    const onExp = tab !== 'import';
    if (exp) exp.style.display = onExp ? '' : 'none';
    if (imp) imp.style.display = onExp ? 'none' : '';
    if (tExp) tExp.classList.toggle('active', onExp);
    if (tImp) tImp.classList.toggle('active', !onExp);
    _setErr('dm-keys-error', '');
  }

  function showDmCryptoKeysModal(tab) {
    if (!window.DeviceCrypto) {
      _toast('Encryption module not loaded — refresh the page.', 'error');
      return;
    }
    _switchTab(tab === 'import' ? 'import' : 'export');
    const sub = document.getElementById('dm-keys-subtitle');
    if (sub) {
      const nick = (window.State && State.user && State.user.nickname) ? `@${State.user.nickname}` : 'your account';
      sub.textContent = `Save or restore end-to-end encryption keys for ${nick} in this browser.`;
    }
    const fin = document.getElementById('dm-keys-file-input');
    if (fin) fin.value = '';
    ['dm-keys-export-pass', 'dm-keys-export-pass2', 'dm-keys-import-pass'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    if (typeof openModal === 'function') openModal('modal-dm-crypto-keys');
  }

  async function _afterKeysImported() {
    try {
      if (typeof window.__ftDmDecryptReset === 'function') window.__ftDmDecryptReset();
    } catch {}
    try {
      if (typeof _redecryptStaleDMMessages === 'function' && typeof _activeDM !== 'undefined' && _activeDM) {
        await _redecryptStaleDMMessages();
      }
    } catch {}
    try {
      if (typeof loadDMChannels === 'function') await loadDMChannels();
    } catch {}
    try {
      if (typeof loadDMMessages === 'function' && typeof _activeDM !== 'undefined' && _activeDM?.id) {
        await loadDMMessages(0);
      }
    } catch {}
  }

  async function submitDmKeysExport() {
    _setErr('dm-keys-error', '');
    const p1 = String(document.getElementById('dm-keys-export-pass')?.value || '');
    const p2 = String(document.getElementById('dm-keys-export-pass2')?.value || '');
    if (p1.length < 8) {
      _setErr('dm-keys-error', 'Use a passphrase of at least 8 characters.');
      return;
    }
    if (p1 !== p2) {
      _setErr('dm-keys-error', 'Passphrases do not match.');
      return;
    }
    const btn = document.getElementById('dm-keys-export-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
    try {
      await DeviceCrypto.ensureReadyForExport();
      const has = await DeviceCrypto.hasExportableCrypto();
      if (!has) {
        _setErr('dm-keys-error', 'No encryption identity in this browser yet — open a DM and send a message first.');
        return;
      }
      await DeviceCrypto.downloadKeyFile(p1);
      _toast('Encryption keys saved — store the .key file somewhere safe.', 'success');
      if (typeof closeModal === 'function') closeModal('modal-dm-crypto-keys');
    } catch (e) {
      const code = String((e && e.message) || e || '');
      if (code === 'dct_export_too_large') {
        _setErr('dm-keys-error', 'Backup is too large — try from your home node with fewer open DMs.');
      } else if (code === 'no_signal_identity') {
        _setErr('dm-keys-error', 'No encryption keys found in this browser.');
      } else {
        _setErr('dm-keys-error', 'Export failed — try again after opening a DM.');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Download .key file'; }
    }
  }

  async function submitDmKeysImport() {
    _setErr('dm-keys-error', '');
    const fileEl = document.getElementById('dm-keys-file-input');
    const pass = String(document.getElementById('dm-keys-import-pass')?.value || '');
    const file = fileEl && fileEl.files && fileEl.files[0];
    if (!file) {
      _setErr('dm-keys-error', 'Choose a .key file to import.');
      return;
    }
    if (pass.length < 8) {
      _setErr('dm-keys-error', 'Enter the passphrase used when you exported.');
      return;
    }
    const btn = document.getElementById('dm-keys-import-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
    try {
      const text = await file.text();
      await DeviceCrypto.importKeyFileFromText(text, pass);
      _toast('Encryption keys restored — unlocking older messages…', 'success');
      await _afterKeysImported();
      try {
        if (typeof _refreshDmLockPlaceholders === 'function') await _refreshDmLockPlaceholders();
      } catch {}
      if (typeof closeModal === 'function') closeModal('modal-dm-crypto-keys');
    } catch (e) {
      const code = String((e && e.message) || e || '');
      if (code === 'wrong_passphrase') {
        _setErr('dm-keys-error', 'Wrong passphrase for this file.');
      } else if (code === 'bad_key_file') {
        _setErr('dm-keys-error', 'Not a valid FrogTalk .key file.');
      } else {
        _setErr('dm-keys-error', 'Import failed — check the file and passphrase.');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Import keys'; }
    }
  }

  try {
    window.showDmCryptoKeysModal = showDmCryptoKeysModal;
    window.submitDmKeysExport = submitDmKeysExport;
    window.submitDmKeysImport = submitDmKeysImport;
    window.switchDmKeysModalTab = _switchTab;
  } catch {}
})();
