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
  const KEYFILE_MAGIC_FROG = 'FROGTALK-FROG-v1';
  const KEYFILE_KDF_ITERS = 210000;
  const KEYFILE_MAX_BYTES = 12 * 1024 * 1024;
  const KEYFILE_EXT = '.FrogTalk';

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

  async function _exportRoomSecretsPlain() {
    const out = [];
    const seen = new Set();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(ROOM_SECRET_PREFIX)) continue;
        if (/:v\d+$/i.test(k)) continue;
        if (seen.has(k)) continue;
        const wrapped = localStorage.getItem(k) || '';
        if (!wrapped) continue;
        let plain = wrapped;
        if (wrapped.startsWith('ftls1:') && typeof Crypto !== 'undefined' && Crypto.unwrapLocalSecret) {
          plain = await Crypto.unwrapLocalSecret(wrapped);
        }
        if (!plain) continue;
        const roomName = k.slice(ROOM_SECRET_PREFIX.length).split(':')[0];
        let kv = 1;
        try {
          const vr = localStorage.getItem(`${ROOM_KEYVER_PREFIX}${roomName}`);
          const n = parseInt(vr, 10);
          if (Number.isFinite(n) && n > 0) kv = n;
        } catch {}
        seen.add(k);
        out.push({ room_name: roomName, secret: plain, key_version: kv });
      }
    } catch {}
    return out;
  }

  async function _wrapSecretForLocalStorage(secret) {
    if (!secret) return '';
    if (typeof Crypto !== 'undefined' && Crypto.wrapLocalSecret) {
      return Crypto.wrapLocalSecret(secret);
    }
    return secret;
  }

  async function _importRoomSecretsPlain(rows) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const name = String(row.room_name || row.name || '').trim().toLowerCase();
      const secret = String(row.secret || '').trim();
      if (!name || !secret) continue;
      const kv = Math.max(1, parseInt(row.key_version, 10) || 1);
      const baseKey = `${ROOM_SECRET_PREFIX}${name}`;
      const wrapped = await _wrapSecretForLocalStorage(secret);
      try {
        localStorage.setItem(baseKey, wrapped);
        if (kv > 0) {
          localStorage.setItem(`${baseKey}:v${kv}`, wrapped);
          localStorage.setItem(`${ROOM_KEYVER_PREFIX}${name}`, String(kv));
        }
      } catch {}
    }
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
    const room_secrets = await _exportRoomSecretsPlain();
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

  function _filterSignalSnapshot(signal, peerLocalIds) {
    if (!signal || !peerLocalIds || !peerLocalIds.size) return signal;
    const keep = (key) => {
      const uid = Number(String(key || '').split('.')[0]) || 0;
      return uid > 0 && peerLocalIds.has(uid);
    };
    const out = {
      identity: signal.identity,
      identities: (signal.identities || []).filter((r) => keep(r.key)),
      sessions: (signal.sessions || []).filter((r) => keep(r.key)),
    };
    return out;
  }

  function _filterRoomSecrets(allRooms, roomStorageKeys) {
    if (!roomStorageKeys || !roomStorageKeys.size) return allRooms;
    return (allRooms || []).filter((r) => roomStorageKeys.has(String(r.storage_key || '')));
  }

  async function _buildPlainExport(opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const peerLocalIds = options.peerLocalIds instanceof Set
      ? options.peerLocalIds
      : (Array.isArray(options.peerLocalIds)
        ? new Set(options.peerLocalIds.map((x) => Number(x)).filter((n) => n > 0))
        : null);
    const roomKeys = options.roomStorageKeys instanceof Set
      ? options.roomStorageKeys
      : (Array.isArray(options.roomStorageKeys)
        ? new Set(options.roomStorageKeys.map((k) => String(k || '')).filter(Boolean))
        : null);
    const includeIdentity = options.includeIdentity !== false;

    if (!window.SignalStore) throw new Error('SignalStore missing');
    const store = new window.SignalStore();
    const signalFull = await store.exportSnapshot();
    if (!signalFull || !signalFull.identity) {
      throw new Error('no_signal_identity');
    }
    let signal = _slimSignalForDct(signalFull);
    if (peerLocalIds && peerLocalIds.size) {
      signal = _filterSignalSnapshot(signal, peerLocalIds);
      if (!includeIdentity) {
        signal = { ...signal, identity: null };
      }
    } else if (!includeIdentity) {
      signal = { identity: null, identities: [], sessions: [] };
    }
    const partial = !!(peerLocalIds && peerLocalIds.size) || !!(roomKeys && roomKeys.size);
    let room_secrets = await _exportRoomSecretsPlain();
    if (roomKeys && roomKeys.size) {
      room_secrets = room_secrets.filter((r) => {
        const sk = `${ROOM_SECRET_PREFIX}${String(r.room_name || '').toLowerCase()}`;
        return roomKeys.has(sk);
      });
    }
    return {
      dct_version: DCT_VERSION,
      dct_mode: partial ? 'partial' : 'full',
      exported_at: Date.now(),
      address_book: await _collectAddressBook(),
      signal,
      room_secrets,
    };
  }

  async function listKeyInventory() {
    const myId = Number((window.State && State.user && State.user.id) || 0);
    const out = {
      hasIdentity: false,
      sessionCount: 0,
      peers: [],
      rooms: [],
      lastExportAt: 0,
      lastImportAt: 0,
      nodeOrigin: String(window.location.origin || ''),
    };
    try {
      out.lastExportAt = Number(localStorage.getItem('ft_key_last_export_at') || 0) || 0;
      out.lastImportAt = Number(localStorage.getItem('ft_key_last_import_at') || 0) || 0;
    } catch {}
    if (window.SignalStore) {
      try {
        const store = new window.SignalStore();
        if (typeof store._stats === 'function') {
          const st = await store._stats();
          out.hasIdentity = !!(st && st.haveIdentity);
          out.sessionCount = Number(st.sessions || 0);
        }
        const snap = await store.exportSnapshot();
        const peerCounts = new Map();
        for (const row of (snap.sessions || [])) {
          const uid = Number(String(row.key || '').split('.')[0]) || 0;
          if (uid > 0 && uid !== myId) {
            peerCounts.set(uid, (peerCounts.get(uid) || 0) + 1);
          }
        }
        const peerMeta = new Map();
        try {
          const res = await _api('/api/dms');
          if (res.ok) {
            const data = await res.json().catch(() => ({}));
            const rows = data.channels || data.dms || data || [];
            for (const ch of rows) {
              const lid = Number(ch.user_id || ch.other_id || ch.peer_id || ch.with_user_id || 0);
              if (!lid) continue;
              peerMeta.set(lid, {
                nickname: String(ch.nickname || ch.other_nickname || ch.peer_nickname || '').trim(),
                gid: String(ch.peer_global_user_id || ch.global_user_id || ch.other_global_user_id || '').trim(),
                dmChannelId: Number(ch.id || 0),
              });
            }
          }
        } catch {}
        let importedSet = new Set();
        try {
          const raw = localStorage.getItem('ft_key_imported_peer_gids');
          if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) importedSet = new Set(arr.map((g) => String(g || '').trim()).filter(Boolean));
          }
        } catch {}
        for (const [localId, sessions] of peerCounts.entries()) {
          const meta = peerMeta.get(localId) || {};
          const gid = meta.gid || '';
          out.peers.push({
            localUserId: localId,
            nickname: meta.nickname || `User #${localId}`,
            globalUserId: gid,
            dmChannelId: meta.dmChannelId || 0,
            sessionCount: sessions,
            imported: gid ? importedSet.has(gid) : false,
            lastExportAt: Number(localStorage.getItem(`ft_key_peer_export:${gid || localId}`) || 0) || 0,
          });
        }
        out.peers.sort((a, b) => String(a.nickname).localeCompare(String(b.nickname)));
      } catch (e) {
        if (window.__ftDctDebug) console.warn('[DeviceCrypto] listKeyInventory', e);
      }
    }
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(ROOM_SECRET_PREFIX)) continue;
        const roomName = k.slice(ROOM_SECRET_PREFIX.length);
        out.rooms.push({
          storageKey: k,
          roomName,
          hasSecret: !!(localStorage.getItem(k) || ''),
        });
      }
      out.rooms.sort((a, b) => String(a.roomName).localeCompare(String(b.roomName)));
    } catch {}
    return out;
  }

  function _recordKeyExportMeta(peerGids) {
    const at = Date.now();
    try {
      localStorage.setItem('ft_key_last_export_at', String(at));
      for (const g of (peerGids || [])) {
        const gid = String(g || '').trim();
        if (gid) localStorage.setItem(`ft_key_peer_export:${gid}`, String(at));
      }
    } catch {}
  }

  function _recordKeyImportMeta(peerGids) {
    const at = Date.now();
    try {
      localStorage.setItem('ft_key_last_import_at', String(at));
      if (peerGids && peerGids.length) {
        let prev = [];
        try {
          const raw = localStorage.getItem('ft_key_imported_peer_gids');
          if (raw) prev = JSON.parse(raw);
        } catch {}
        const merged = new Set([...(Array.isArray(prev) ? prev : []), ...peerGids.map((g) => String(g || '').trim()).filter(Boolean)]);
        localStorage.setItem('ft_key_imported_peer_gids', JSON.stringify([...merged]));
      }
    } catch {}
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
      await _importRoomSecretsPlain(plain.room_secrets);
      try { window.__ftDctRoomSecretsImported = true; } catch {}
      return true;
    }

    const partial = mode === 'partial';
    if (!partial && (!plain.signal || !plain.signal.identity)) return false;
    if (partial && !plain.signal) return false;
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
    if (partial) {
      await store.mergeSnapshot(signal, (k) => k);
    } else {
      if (!plain.signal.identity) return false;
      await store.importSnapshot(signal, (k) => k);
    }

    if (plain.room_secrets && plain.room_secrets.length) {
      const first = plain.room_secrets[0] || {};
      if (first.secret || first.room_name) {
        await _importRoomSecretsPlain(plain.room_secrets);
      } else {
        _importRoomSecrets(plain.room_secrets);
      }
    }
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

  /** e.g. frog-2026-05-23-full.FrogTalk or testy-2026-05-23-p2r1.FrogTalk */
  function _keyfileDownloadName(exportOpts) {
    const nick = _keyfileNickname();
    const stamp = new Date().toISOString().slice(0, 10);
    const opts = exportOpts && typeof exportOpts === 'object' ? exportOpts : {};
    const partial = !!(opts.peerLocalIds && opts.peerLocalIds.size)
      || !!(opts.roomStorageKeys && opts.roomStorageKeys.size);
    let meta = 'full';
    if (partial) {
      const p = opts.peerLocalIds ? opts.peerLocalIds.size : 0;
      const r = opts.roomStorageKeys ? opts.roomStorageKeys.size : 0;
      meta = `p${p}r${r}`;
    }
    return `${nick}-${stamp}-${meta}${KEYFILE_EXT}`;
  }

  function _keyfileExtensionOk(filename) {
    const lower = String(filename || '').trim().toLowerCase();
    return lower.endsWith('.frogtalk') || lower.endsWith('.json');
  }

  function _isValidKeyFileMagic(magic) {
    const m = String(magic || '').trim();
    return m === KEYFILE_MAGIC || m === KEYFILE_MAGIC_FROG;
  }

  function _parseKeyFileJson(text) {
    const raw = String(text || '').trim();
    if (!raw || raw.length > KEYFILE_MAX_BYTES) throw new Error('bad_key_file');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('bad_key_file');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('bad_key_file');
    }
    return parsed;
  }

  async function _decryptKeyFilePayload(obj, passphrase) {
    const pass = String(passphrase || '');
    if (pass.length < 8) throw new Error('passphrase_too_short');
    let packed;
    try {
      packed = await _openPackedFromPassphrase(obj, pass);
    } catch {
      throw new Error('wrong_passphrase');
    }
    return _unpackPlainExport(packed);
  }

  function _summarizePlainExport(plain, envelope) {
    const env = envelope && typeof envelope === 'object' ? envelope : {};
    const signal = plain?.signal || {};
    const sessions = Array.isArray(signal.sessions) ? signal.sessions : [];
    const peerIds = new Set();
    for (const row of sessions) {
      const uid = Number(String(row?.key || '').split('.')[0]) || 0;
      if (uid > 0) peerIds.add(uid);
    }
    const book = plain?.address_book || {};
    const bookPeers = Array.isArray(book.peers) ? book.peers : [];
    return {
      magic: String(env.magic || ''),
      exportScope: String(plain?.dct_mode || 'full'),
      exportedAt: Number(plain?.exported_at || env.exported_at || 0),
      nodeOrigin: String(env.node_origin || ''),
      accountNickname: String(env.account_nickname || '').slice(0, 64),
      identityPresent: !!(signal.identity),
      dmSessionCount: sessions.length,
      dmPeerCount: peerIds.size,
      addressBookPeers: bookPeers.length,
      roomSecretCount: Array.isArray(plain?.room_secrets) ? plain.room_secrets.length : 0,
    };
  }

  async function previewKeyFileFromText(text, passphrase) {
    const parsed = _parseKeyFileJson(text);
    if (!_isValidKeyFileMagic(parsed.magic)) throw new Error('bad_key_file');
    const plain = await _decryptKeyFilePayload(parsed, passphrase);
    if (!plain) throw new Error('bad_key_file');
    return _summarizePlainExport(plain, parsed);
  }

  async function exportKeyFilePayload(passphrase, opts) {
    const pass = String(passphrase || '');
    if (pass.length < 8) throw new Error('passphrase_too_short');
    await _ensureSignalReadyForExport();
    if (!(await _hasExportableCrypto())) throw new Error('no_signal_identity');
    const plain = await _buildPlainExport(opts);
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

  async function downloadKeyFile(passphrase, opts) {
    const payload = await exportKeyFilePayload(passphrase, opts);
    const body = JSON.stringify(payload, null, 2);
    const blob = new Blob([body], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = _keyfileDownloadName(opts);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  }

  async function importKeyFilePayload(payload, passphrase) {
    const obj = (payload && typeof payload === 'object') ? payload : null;
    if (!obj || !_isValidKeyFileMagic(obj.magic)) throw new Error('bad_key_file');
    const plain = await _decryptKeyFilePayload(obj, passphrase);
    const ok = await _importPlainPayload(plain, '');
    if (!ok) throw new Error('import_failed');
    try {
      const gids = [];
      for (const p of ((plain.address_book && plain.address_book.peers) || [])) {
        const g = String(p.gid || '').trim();
        if (g) gids.push(g);
      }
      _recordKeyImportMeta(gids);
    } catch {}
    try {
      if (window.Signal && typeof Signal.init === 'function' && State?.user?.id) {
        await Signal.init(State.user.id);
      }
    } catch {}
    return true;
  }

  async function importKeyFileFromText(text, passphrase) {
    const parsed = _parseKeyFileJson(text);
    return importKeyFilePayload(parsed, passphrase);
  }

  async function stageRoomSecretsForHomeSync() {
    if (!State?.token) return false;
    if (window.App && typeof App.isAtHomeNode === 'function' && App.isAtHomeNode()) {
      return false;
    }
    const rooms = await _exportRoomSecretsPlain();
    if (!rooms.length) return true;
    try {
      const res = await _api('/api/auth/travel-room-secrets/stage', 'POST', { rooms });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function importPendingTravelRoomSecretsFromServer() {
    if (!State?.token) return false;
    if (window.App && typeof App.isAtHomeNode === 'function' && !App.isAtHomeNode()) {
      return false;
    }
    try {
      const res = await _api('/api/auth/travel-room-secrets/pending', 'GET');
      if (!res.ok) return false;
      const data = await res.json().catch(() => ({}));
      const rooms = data.rooms || [];
      if (!rooms.length) return 0;
      await _importRoomSecretsPlain(rooms);
      try { window.__ftTravelRoomSecretsImported = true; } catch {}
      if (typeof UI !== 'undefined' && UI.showToast) {
        UI.showToast(
          `Restored ${rooms.length} private channel secret${rooms.length === 1 ? '' : 's'} from your travel node`,
          'success',
          5000,
        );
      }
      return rooms.length;
    } catch {
      return 0;
    }
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
    previewKeyFileFromText,
    buildPlainExport: _buildPlainExport,
    KEYFILE_EXT,
    keyfileDownloadName: _keyfileDownloadName,
    keyfileExtensionOk: _keyfileExtensionOk,
    ensureReadyForExport: _ensureSignalReadyForExport,
    listKeyInventory,
    recordKeyExportMeta: _recordKeyExportMeta,
    recordKeyImportMeta: _recordKeyImportMeta,
    stageRoomSecretsForHomeSync,
    importPendingTravelRoomSecretsFromServer,
  };

  try {
    if (typeof window !== 'undefined') window.DeviceCrypto = DeviceCrypto;
  } catch {}
})();
