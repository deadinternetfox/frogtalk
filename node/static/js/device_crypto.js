// device_crypto.js — Travel / node-switch encryption policy.
//
// Default policy is `fresh_keys`: each federated (travel) node uses new
// end-to-end keys in this browser. DM history ciphertext from your home
// node is not migrated — new messages work after sync; old bubbles stay locked.
//
// Legacy `transfer` policy (full Signal export via switch ticket) remains in
// code for operators who set window.FT_DCT_POLICY = 'transfer'.

(function () {
  'use strict';

  const DCT_VERSION = 2;
  const DEFAULT_POLICY = 'fresh_keys';
  const KEYFILE_MAGIC = 'FROGTALK-KEY-v1';
  const KEYFILE_KDF_ITERS = 210000;

  function dctPolicy() {
    try {
      const p = String(window.FT_DCT_POLICY || DEFAULT_POLICY).trim().toLowerCase();
      return p === 'transfer' ? 'transfer' : 'fresh_keys';
    } catch {
      return DEFAULT_POLICY;
    }
  }

  function usesFreshKeysOnTravel() {
    return dctPolicy() === 'fresh_keys';
  }
  const ROOM_SECRET_PREFIX = 'ft-room-secret-v1:';
  const ROOM_KEYVER_PREFIX = 'ft-room-keyver:';
  const DCT_PLAIN_MAX = 6 * 1024 * 1024;

  function _api(path, method, body) {
    const fn = (typeof apiFetch === 'function') ? apiFetch : fetch;
    if (fn !== fetch) return fn(path, method || 'GET', body || null);
    const headers = {
      'Content-Type': 'application/json',
      'X-Session-Token': (window.State && State.token) || localStorage.getItem('fc_token') || '',
    };
    return fetch(path, {
      method: method || 'GET',
      headers,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async function _deriveAesKeyFromTicket(ticket) {
    const enc = new TextEncoder();
    const digest = await crypto.subtle.digest(
      'SHA-256',
      enc.encode(String(ticket || '') + '|frogtalk-dct-v1'),
    );
    return crypto.subtle.importKey(
      'raw',
      digest,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  function _b64FromBytes(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }

  function _bytesFromB64(b64) {
    const raw = atob(String(b64 || ''));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function _gzipBytes(u8) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      return null;
    }
  }

  async function _gunzipBytes(u8) {
    if (typeof DecompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      return null;
    }
  }

  async function _encryptJson(obj, ticket) {
    const key = await _deriveAesKeyFromTicket(ticket);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    return _b64FromBytes(iv) + '.' + _b64FromBytes(new Uint8Array(ct));
  }

  async function _decryptJson(blobStr, ticket) {
    const parts = String(blobStr || '').split('.');
    if (parts.length !== 2) throw new Error('bad dct blob');
    const iv = _bytesFromB64(parts[0]);
    const ct = _bytesFromB64(parts[1]);
    const key = await _deriveAesKeyFromTicket(ticket);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function _unpackPlainExport(wrap) {
    if (!wrap || typeof wrap !== 'object') return null;
    if (wrap.compression === 'gzip' && wrap.body_b64) {
      const gz = _bytesFromB64(wrap.body_b64);
      const raw = await _gunzipBytes(gz);
      if (!raw) throw new Error('dct gunzip failed');
      return JSON.parse(new TextDecoder().decode(raw));
    }
    if (wrap.compression === 'none' && wrap.body_b64) {
      return JSON.parse(new TextDecoder().decode(_bytesFromB64(wrap.body_b64)));
    }
    if (wrap.dct_version) return wrap;
    return wrap;
  }

  async function _packPlainExport(plain) {
    const json = JSON.stringify(plain);
    let bytes = new TextEncoder().encode(json);
    let compression = 'none';
    if (bytes.length > 200000) {
      const gz = await _gzipBytes(bytes);
      if (gz && gz.length + 64 < bytes.length) {
        bytes = gz;
        compression = 'gzip';
      }
    }
    if (bytes.length > DCT_PLAIN_MAX) {
      throw new Error('dct_export_too_large');
    }
    return {
      dct_wrap_version: 1,
      compression,
      body_b64: _b64FromBytes(bytes),
    };
  }

  function _slimSignalForDct(signal) {
    if (!signal || typeof signal !== 'object') return null;
    return {
      identity: signal.identity,
      identities: Array.isArray(signal.identities) ? signal.identities : [],
      sessions: Array.isArray(signal.sessions) ? signal.sessions : [],
    };
  }

  async function _collectAddressBook() {
    const peers = [];
    const seen = new Set();
    const add = (gid, localId) => {
      const g = String(gid || '').trim();
      const lid = Number(localId) || 0;
      if (!g || lid <= 0) return;
      const k = g + ':' + lid;
      if (seen.has(k)) return;
      seen.add(k);
      peers.push({ gid: g, source_local_id: lid });
    };
    try {
      const res = await _api('/api/dms');
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const rows = data.channels || data.dms || data || [];
        for (const ch of rows) {
          add(
            ch.peer_global_user_id || ch.global_user_id || ch.other_global_user_id,
            ch.user_id || ch.other_id || ch.peer_id,
          );
        }
      }
    } catch {}
    try {
      const res = await _api('/api/friends');
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const rows = data.friends || data.users || data || [];
        for (const f of rows) {
          add(f.global_user_id, f.id || f.user_id);
        }
      }
    } catch {}
    return {
      source_user_id: Number((window.State && State.user && State.user.id) || 0) || 0,
      peers,
    };
  }

  function _exportRoomSecrets() {
    const rooms = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(ROOM_SECRET_PREFIX)) continue;
        const wrapped = localStorage.getItem(k) || '';
        if (!wrapped) continue;
        rooms.push({ storage_key: k, wrapped });
      }
    } catch {}
    return rooms;
  }

  function _importRoomSecrets(rows) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const k = String(row.storage_key || '');
      if (!k) continue;
      try {
        if (row.wrapped != null) localStorage.setItem(k, String(row.wrapped));
      } catch {}
    }
  }

  async function _hasExportableCrypto() {
    if (!window.SignalStore) return false;
    try {
      const store = new window.SignalStore();
      if (typeof store._stats === 'function') {
        const st = await store._stats();
        return !!(st && st.haveIdentity);
      }
      const snap = await store.exportSnapshot();
      return !!(snap && snap.identity);
    } catch {
      return false;
    }
  }

  async function _buildRoomSecretsOnlyExport() {
    const room_secrets = _exportRoomSecrets();
    if (!room_secrets.length) return null;
    return {
      dct_version: DCT_VERSION,
      dct_mode: 'room_secrets_only',
      exported_at: Date.now(),
      address_book: {
        source_user_id: Number((window.State && State.user && State.user.id) || 0) || 0,
        peers: [],
      },
      signal: null,
      room_secrets,
    };
  }

  async function _buildPlainExport() {
    if (!window.SignalStore) throw new Error('SignalStore missing');
    const store = new window.SignalStore();
    const signal = await store.exportSnapshot();
    if (!signal || !signal.identity) {
      throw new Error('no_signal_identity');
    }
    return {
      dct_version: DCT_VERSION,
      dct_mode: 'full',
      exported_at: Date.now(),
      address_book: await _collectAddressBook(),
      signal: _slimSignalForDct(signal),
      room_secrets: _exportRoomSecrets(),
    };
  }

  async function _resolveGidToLocalId(gid) {
    const g = String(gid || '').trim();
    if (!g) return 0;
    try {
      if (window.State && State.user && State.user.global_user_id === g) {
        return Number(State.user.id) || 0;
      }
    } catch {}
    try {
      const res = await _api('/api/friends');
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const rows = data.friends || data.users || data || [];
        for (const f of rows) {
          if (String(f.global_user_id || '').trim() === g) {
            return Number(f.id || f.user_id) || 0;
          }
        }
      }
    } catch {}
    try {
      const res = await _api('/api/dms');
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const rows = data.channels || data.dms || data || [];
        for (const ch of rows) {
          const cg = ch.peer_global_user_id || ch.global_user_id || ch.other_global_user_id;
          if (String(cg || '').trim() === g) {
            return Number(ch.user_id || ch.other_id || ch.peer_id) || 0;
          }
        }
      }
    } catch {}
    return 0;
  }

  async function _remapAddressKey(addrKey, exportedBook, idMap) {
    const parts = String(addrKey || '').split('.');
    const srcUid = Number(parts[0]) || 0;
    const dev = parts[1] || '1';
    if (!srcUid) return addrKey;
    if (idMap.has(srcUid)) {
      const dest = idMap.get(srcUid);
      return dest ? `${dest}.${dev}` : addrKey;
    }
    const peers = (exportedBook && exportedBook.peers) || [];
    const peer = peers.find((p) => Number(p.source_local_id) === srcUid);
    if (!peer || !peer.gid) {
      idMap.set(srcUid, 0);
      return addrKey;
    }
    const destId = await _resolveGidToLocalId(peer.gid);
    idMap.set(srcUid, destId);
    return destId ? `${destId}.${dev}` : addrKey;
  }

  let _lastExportError = null;

  function _dctPublicMessage(status, detail, errMsg) {
    const code = String(detail || errMsg || '').trim();
    if (status === 422 || code === 'dct_export_too_large') {
      return 'Encryption backup is too large for one switch (too many DM sessions). Switch from your home node in the same browser, or ask contacts to send a new message after you land.';
    }
    if (status === 413) {
      return 'Encryption backup exceeded server size limit — try again from your home node with fewer open DMs.';
    }
    if (status === 400 || status === 401 || status === 403) {
      return 'Switch ticket rejected — wait a moment and try switching again.';
    }
    return 'Could not save encryption keys for this switch — DMs and private channels may need new secrets on the other node.';
  }

  function _dctErrorToast(status, detail, errMsg) {
    if (window.__ftDctAwaitingSwitchConfirm) return;
    const msg = _dctPublicMessage(status, detail, errMsg);
    try {
      if (typeof UI !== 'undefined' && UI.showToast) UI.showToast(msg, 'warn', 12000);
    } catch {}
  }

  async function _ensureSignalReadyForExport() {
    if (!window.Signal || !State?.user?.id) return;
    try {
      if (typeof Signal.init === 'function' && !Signal.isReady()) {
        await Signal.init(State.user.id);
      }
      if (typeof Signal.ensureReady === 'function') {
        await Signal.ensureReady(State.user.id, { timeoutMs: 15000 });
      }
    } catch {}
  }

  async function exportAndUploadForSwitch(ticket) {
    const t = String(ticket || '').trim();
    if (!t) return false;
    if (usesFreshKeysOnTravel()) {
      try { sessionStorage.setItem('ft_switch_ticket_dct', t); } catch {}
      try {
        const plain = await _buildRoomSecretsOnlyExport();
        if (plain) {
          const packed = await _packPlainExport(plain);
          const sealed = await _encryptJson(packed, t);
          const res = await _api('/api/auth/device-crypto-blob', 'POST', {
            ticket: t,
            blob_b64: sealed,
          });
          if (res.ok) {
            try { window.__ftDctRoomSecretsQueued = true; } catch {}
            if (typeof UI !== 'undefined' && UI.showToast) {
              UI.showToast(
                'Switching nodes — fresh DM encryption here; private channel secrets saved for this browser.',
                'info',
                7000,
              );
            }
            return true;
          }
        }
        if (typeof UI !== 'undefined' && UI.showToast) {
          UI.showToast(
            'Switching nodes — fresh DM encryption here. Chat history stays on your home node.',
            'info',
            7000,
          );
        }
      } catch (e) {
        if (window.__ftDctDebug) console.info('[DCT] room-secrets-only export failed', e);
        try {
          if (typeof UI !== 'undefined' && UI.showToast) {
            UI.showToast(
              'Switching nodes — fresh DM encryption here. Chat history stays on your home node.',
              'info',
              7000,
            );
          }
        } catch {}
      }
      return true;
    }
    if (!(await _hasExportableCrypto())) {
      if (window.__ftDctDebug) console.info('[DCT] skip export — no Signal identity on this device');
      return false;
    }
    try { window.__ftDctAwaitingSwitchConfirm = true; } catch {}
    try {
      sessionStorage.setItem('ft_switch_ticket_dct', t);
    } catch {}
    try {
      if (typeof UI !== 'undefined' && UI.showToast) {
        UI.showToast('Saving encryption keys for node switch…', 'info', 4000);
      }
    } catch {}
    try {
      await _ensureSignalReadyForExport();
      const plain = await _buildPlainExport();
      const packed = await _packPlainExport(plain);
      const sealed = await _encryptJson(packed, t);
      if (sealed.length > 9 * 1024 * 1024) {
        throw new Error('dct_export_too_large');
      }
      const res = await _api('/api/auth/device-crypto-blob', 'POST', {
        ticket: t,
        blob_b64: sealed,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        const errText = String(detail.error || detail.detail || '').trim();
        _lastExportError = { status: res.status, detail: errText };
        if (window.__ftDctDebug) {
          console.info('[DCT] upload failed', res.status, errText || res.statusText);
        }
        return false;
      }
      try {
        if (typeof UI !== 'undefined' && UI.showToast) {
          UI.showToast('Encryption keys saved for node switch', 'success', 3500);
        }
      } catch {}
      return true;
    } catch (e) {
      const errMsg = String((e && e.message) || e || '');
      _lastExportError = { status: 0, detail: errMsg };
      if (window.__ftDctDebug) console.info('[DCT] export failed', errMsg);
      if (errMsg === 'dct_export_too_large') {
        _lastExportError = { status: 422, detail: 'dct_export_too_large' };
        _dctErrorToast(422, 'dct_export_too_large', errMsg);
      }
      return false;
    } finally {
      try { window.__ftDctAwaitingSwitchConfirm = false; } catch {}
    }
  }

  function getLastExportError() {
    return _lastExportError;
  }

  async function fetchBlobForSwitch(ticket) {
    const t = String(ticket || '').trim();
    if (!t) return null;
    const res = await _api(
      '/api/auth/device-crypto-blob?ticket=' + encodeURIComponent(t),
      'GET',
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return String(data.blob_b64 || '').trim() || null;
  }

  async function _importPlainPayload(plain, ticket) {
    if (!plain) return false;
    const mode = String(plain.dct_mode || 'full').trim();
    const ver = Number(plain.dct_version || 0);
    if (ver !== 1 && ver !== 2) return false;

    if (mode === 'room_secrets_only') {
      _importRoomSecrets(plain.room_secrets);
      try { window.__ftDctRoomSecretsImported = true; } catch {}
      return true;
    }

    if (!plain.signal || !plain.signal.identity) return false;
    const idMap = new Map();
    const book = plain.address_book || {};
    const meId = Number((window.State && State.user && State.user.id) || 0);
    const srcMe = Number(book.source_user_id || 0);
    if (srcMe > 0 && meId > 0) idMap.set(srcMe, meId);

    for (const p of (book.peers || [])) {
      const src = Number(p.source_local_id) || 0;
      const gid = String(p.gid || '').trim();
      if (!gid || src <= 0 || idMap.has(src)) continue;
      const dest = await _resolveGidToLocalId(gid);
      idMap.set(src, dest);
    }

    if (!window.SignalStore) return false;
    const store = new window.SignalStore();
    const signal = plain.signal;
    const _remapRowKey = async (key) => {
      const mapped = await _remapAddressKey(String(key || ''), book, idMap);
      const uid = Number(String(mapped || '').split('.')[0]) || 0;
      return uid > 0 ? mapped : '';
    };
    if (signal.sessions) {
      const kept = [];
      for (const row of signal.sessions) {
        const nk = await _remapRowKey(row.key);
        if (!nk) continue;
        row.key = nk;
        kept.push(row);
      }
      signal.sessions = kept;
    }
    if (signal.identities) {
      const keptId = [];
      for (const row of signal.identities) {
        const nk = await _remapRowKey(row.key);
        if (!nk) continue;
        row.key = nk;
        keptId.push(row);
      }
      signal.identities = keptId;
    }
    await store.importSnapshot(signal, (k) => k);

    _importRoomSecrets(plain.room_secrets);
    try { window.__ftDctImported = true; } catch {}
    return true;
  }

  async function importFromSwitch(ticket) {
    const t = String(ticket || '').trim();
    if (!t) return false;
    try {
      const sealed = await fetchBlobForSwitch(t);
      if (!sealed) return false;
      const wrap = await _decryptJson(sealed, t);
      const plain = await _unpackPlainExport(wrap);
      return await _importPlainPayload(plain, t);
    } catch (e) {
      if (window.__ftDctDebug) console.warn('[DCT] import failed', e);
      return false;
    }
  }

  async function tryImportAfterSwitch(ticket) {
    return importFromSwitch(ticket);
  }

  async function tryImportRoomSecretsAfterSwitch(ticket) {
    if (!usesFreshKeysOnTravel()) return importFromSwitch(ticket);
    return importFromSwitch(ticket);
  }

  async function _deriveKeyFromPassphrase(passphrase, saltU8) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(String(passphrase || '')),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltU8,
        iterations: KEYFILE_KDF_ITERS,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async function _sealPackedForPassphrase(packed, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await _deriveKeyFromPassphrase(passphrase, salt);
    const plain = new TextEncoder().encode(JSON.stringify(packed));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    return { salt, iv, ct };
  }

  async function _openPackedFromPassphrase(wrap, passphrase) {
    const salt = _bytesFromB64(wrap.salt_b64);
    const iv = _bytesFromB64(wrap.iv_b64);
    const ct = _bytesFromB64(wrap.ciphertext_b64);
    const key = await _deriveKeyFromPassphrase(passphrase, salt);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function _keyfileNickname() {
    try {
      const n = String((window.State && State.user && State.user.nickname) || 'user').trim();
      return n.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 32) || 'user';
    } catch {
      return 'user';
    }
  }

  async function exportKeyFilePayload(passphrase) {
    const pass = String(passphrase || '');
    if (pass.length < 8) throw new Error('passphrase_too_short');
    await _ensureSignalReadyForExport();
    if (!(await _hasExportableCrypto())) throw new Error('no_signal_identity');
    const plain = await _buildPlainExport();
    const packed = await _packPlainExport(plain);
    const sealed = await _sealPackedForPassphrase(packed, pass);
    return {
      magic: KEYFILE_MAGIC,
      exported_at: Date.now(),
      node_origin: String(window.location.origin || ''),
      account_nickname: _keyfileNickname(),
      kdf: 'pbkdf2-sha256',
      kdf_iters: KEYFILE_KDF_ITERS,
      salt_b64: _b64FromBytes(sealed.salt),
      iv_b64: _b64FromBytes(sealed.iv),
      ciphertext_b64: _b64FromBytes(new Uint8Array(sealed.ct)),
    };
  }

  async function downloadKeyFile(passphrase) {
    const payload = await exportKeyFilePayload(passphrase);
    const body = JSON.stringify(payload, null, 2);
    const blob = new Blob([body], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `frogtalk-${_keyfileNickname()}-${stamp}.key`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  }

  async function importKeyFilePayload(payload, passphrase) {
    const obj = (payload && typeof payload === 'object') ? payload : null;
    if (!obj || String(obj.magic || '') !== KEYFILE_MAGIC) throw new Error('bad_key_file');
    const pass = String(passphrase || '');
    if (pass.length < 8) throw new Error('passphrase_too_short');
    let packed;
    try {
      packed = await _openPackedFromPassphrase(obj, pass);
    } catch {
      throw new Error('wrong_passphrase');
    }
    const plain = await _unpackPlainExport(packed);
    const ok = await _importPlainPayload(plain, '');
    if (!ok) throw new Error('import_failed');
    try {
      if (window.Signal && typeof Signal.init === 'function' && State?.user?.id) {
        await Signal.init(State.user.id);
      }
    } catch {}
    return true;
  }

  async function importKeyFileFromText(text, passphrase) {
    let parsed;
    try {
      parsed = JSON.parse(String(text || '').trim());
    } catch {
      throw new Error('bad_key_file');
    }
    return importKeyFilePayload(parsed, passphrase);
  }

  const DeviceCrypto = {
    exportAndUploadForSwitch,
    importFromSwitch,
    tryImportAfterSwitch,
    tryImportRoomSecretsAfterSwitch,
    fetchBlobForSwitch,
    hasExportableCrypto: _hasExportableCrypto,
    getLastExportError,
    publicExportErrorMessage: _dctPublicMessage,
    policy: dctPolicy,
    usesFreshKeysOnTravel,
    exportKeyFilePayload,
    downloadKeyFile,
    importKeyFilePayload,
    importKeyFileFromText,
    buildPlainExport: _buildPlainExport,
    ensureReadyForExport: _ensureSignalReadyForExport,
  };

  try {
    if (typeof window !== 'undefined') window.DeviceCrypto = DeviceCrypto;
  } catch {}
})();
