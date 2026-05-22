// device_crypto.js — Device Crypto Transfer (DCT) for node switch.
//
// Before leaving a node, export Signal IndexedDB + room secrets, encrypt
// with a key derived from the switch ticket, and POST to the source node.
// After landing on the destination, pull the blob from source via the
// destination API and import before Signal.init publishes a new identity.

(function () {
  'use strict';

  const DCT_VERSION = 1;
  const ROOM_SECRET_PREFIX = 'ft-room-secret-v1:';
  const ROOM_KEYVER_PREFIX = 'ft-room-keyver:';

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
        const val = localStorage.getItem(k) || '';
        if (!val) continue;
        rooms.push({ storage_key: k, wrapped: val });
      }
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(ROOM_KEYVER_PREFIX)) continue;
        rooms.push({ storage_key: k, wrapped: localStorage.getItem(k) || '' });
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

  async function _buildPlainExport() {
    if (!window.SignalStore) throw new Error('SignalStore missing');
    const store = new window.SignalStore();
    const signal = await store.exportSnapshot();
    if (!signal || !signal.identity) {
      throw new Error('no_signal_identity');
    }
    return {
      dct_version: DCT_VERSION,
      exported_at: Date.now(),
      address_book: await _collectAddressBook(),
      signal,
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

  async function exportAndUploadForSwitch(ticket) {
    const t = String(ticket || '').trim();
    if (!t) return false;
    if (!(await _hasExportableCrypto())) {
      console.warn('[DCT] skip export — no Signal identity on this device');
      return false;
    }
    try {
      if (typeof UI !== 'undefined' && UI.showToast) {
        UI.showToast('Saving encryption keys for node switch…', 'info', 2800);
      }
      const plain = await _buildPlainExport();
      const sealed = await _encryptJson(plain, t);
      const res = await _api('/api/auth/device-crypto-blob', 'POST', {
        ticket: t,
        blob_b64: sealed,
      });
      if (!res.ok) {
        console.warn('[DCT] upload failed', res.status);
        return false;
      }
      return true;
    } catch (e) {
      console.warn('[DCT] export failed', e);
      return false;
    }
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

  async function importFromSwitch(ticket) {
    const t = String(ticket || '').trim();
    if (!t) return false;
    try {
      const sealed = await fetchBlobForSwitch(t);
      if (!sealed) return false;
      const plain = await _decryptJson(sealed, t);
      if (!plain || plain.dct_version !== DCT_VERSION) return false;

      const idMap = new Map();
      const book = plain.address_book;

      if (!window.SignalStore) return false;
      const store = new window.SignalStore();
      const signal = plain.signal;
      if (signal && signal.sessions) {
        for (const row of signal.sessions) {
          row.key = await _remapAddressKey(String(row.key), book, idMap);
        }
      }
      if (signal && signal.identities) {
        for (const row of signal.identities) {
          row.key = await _remapAddressKey(String(row.key), book, idMap);
        }
      }
      await store.importSnapshot(signal, (k) => k);

      _importRoomSecrets(plain.room_secrets);
      try { window.__ftDctImported = true; } catch {}
      return true;
    } catch (e) {
      console.warn('[DCT] import failed', e);
      return false;
    }
  }

  async function tryImportAfterSwitch(ticket) {
    return importFromSwitch(ticket);
  }

  const DeviceCrypto = {
    exportAndUploadForSwitch,
    importFromSwitch,
    tryImportAfterSwitch,
    fetchBlobForSwitch,
    hasExportableCrypto: _hasExportableCrypto,
  };

  try {
    if (typeof window !== 'undefined') window.DeviceCrypto = DeviceCrypto;
  } catch {}
})();
