// static/js/signal_store.js
//
// Track A — IndexedDB-backed implementation of the
// `SignalProtocolStore` interface that
// `@privacyresearch/libsignal-protocol-typescript` consumes.
//
// The store is a thin shell around a single IndexedDB database
// (`frogtalk-signal-v1`) with five object stores:
//
//   identity              key='self'          { pubKey, privKey, registrationId }
//   identities            key=<address>       { pubKey }              ← TOFU for peers
//   sessions              key=<address>       string (libsignal blob)
//   prekeys               key=<int id>        { pubKey, privKey }
//   signed_prekeys        key=<int id>        { pubKey, privKey, signature, timestamp }
//
// An "address" is the libsignal `name.device_id` tuple stringified
// (e.g. `"42.1"`). We use the FrogTalk numeric user id as `name` and
// fix device_id at 1 until Track F (linked devices) lands.
//
// All keys / signatures go in as raw ArrayBuffer; libsignal hands us
// ArrayBuffer back out. IndexedDB stores ArrayBuffers natively, so we
// avoid base64 in this layer. Code that crosses the wire converts to
// base64 (see `signal.js`).
//
// Security notes:
//   * IndexedDB is per-origin; a different origin cannot read it.
//   * We never log private keys, session blobs, or message keys.
//   * The store is *not* re-encrypted at rest (the browser's profile
//     directory is the trust boundary; the OS protects it). A future
//     enhancement would derive a key from a user passphrase and wrap
//     each row \u2014 deferred until Track F.
//
// This file ships even when the libsignal WASM module isn't loaded,
// because the IndexedDB layer is independent of the protocol code.

(function () {
  'use strict';

  const DB_NAME = 'frogtalk-signal-v1';
  const DB_VERSION = 1;
  const STORE_IDENTITY = 'identity';
  const STORE_IDENTITIES = 'identities';
  const STORE_SESSIONS = 'sessions';
  const STORE_PREKEYS = 'prekeys';
  const STORE_SIGNED_PREKEYS = 'signed_prekeys';

  let _dbPromise = null;

  function _openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_IDENTITY)) {
          db.createObjectStore(STORE_IDENTITY);
        }
        if (!db.objectStoreNames.contains(STORE_IDENTITIES)) {
          db.createObjectStore(STORE_IDENTITIES);
        }
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          db.createObjectStore(STORE_SESSIONS);
        }
        if (!db.objectStoreNames.contains(STORE_PREKEYS)) {
          db.createObjectStore(STORE_PREKEYS);
        }
        if (!db.objectStoreNames.contains(STORE_SIGNED_PREKEYS)) {
          db.createObjectStore(STORE_SIGNED_PREKEYS);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexeddb open failed'));
      req.onblocked = () => reject(new Error('indexeddb blocked'));
    });
    return _dbPromise;
  }

  function _tx(db, store, mode) {
    const t = db.transaction(store, mode);
    return t.objectStore(store);
  }

  function _get(store, key) {
    return _openDb().then(db => new Promise((resolve, reject) => {
      const req = _tx(db, store, 'readonly').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function _put(store, key, value) {
    return _openDb().then(db => new Promise((resolve, reject) => {
      const req = _tx(db, store, 'readwrite').put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }));
  }

  function _del(store, key) {
    return _openDb().then(db => new Promise((resolve, reject) => {
      const req = _tx(db, store, 'readwrite').delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }));
  }

  function _all(store) {
    return _openDb().then(db => new Promise((resolve, reject) => {
      const out = [];
      const req = _tx(db, store, 'readonly').openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(out); return; }
        out.push({ key: cur.key, value: cur.value });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    }));
  }

  // libsignal-protocol-typescript uses two "directions" for trust
  // decisions: SENDING (encrypting) and RECEIVING (decrypting). Mirror
  // its enum so the interface contract is satisfied.
  const Direction = { SENDING: 1, RECEIVING: 2 };

  // ── Helpers — ArrayBuffer ↔ ArrayBuffer round-trip checks ─────────────
  function _ab(x) {
    if (x instanceof ArrayBuffer) return x;
    if (ArrayBuffer.isView(x)) {
      // Copy out so the underlying buffer can't be mutated by callers.
      return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength);
    }
    throw new Error('expected ArrayBuffer / typed array');
  }

  function _abEqual(a, b) {
    if (!a || !b) return false;
    const va = new Uint8Array(_ab(a));
    const vb = new Uint8Array(_ab(b));
    if (va.length !== vb.length) return false;
    let diff = 0;
    for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
    return diff === 0;
  }

  // ── SignalProtocolStore interface ─────────────────────────────────────

  class FrogtalkSignalStore {
    // Methods libsignal expects, in the order it calls them.

    async getIdentityKeyPair() {
      const row = await _get(STORE_IDENTITY, 'self');
      if (!row) return undefined;
      return { pubKey: row.pubKey, privKey: row.privKey };
    }

    async getLocalRegistrationId() {
      const row = await _get(STORE_IDENTITY, 'self');
      if (!row) return undefined;
      return row.registrationId;
    }

    // Internal — called by Signal.init() after KeyHelper generates a
    // fresh identity. Not part of the libsignal store interface.
    async _setIdentity(keyPair, registrationId) {
      await _put(STORE_IDENTITY, 'self', {
        pubKey: _ab(keyPair.pubKey),
        privKey: _ab(keyPair.privKey),
        registrationId: Number(registrationId) >>> 0,
      });
    }

    async isTrustedIdentity(identifier, identityKey, _direction) {
      if (typeof identifier !== 'string') return false;
      const existing = await _get(STORE_IDENTITIES, identifier);
      if (!existing) {
        // TOFU on first contact, as the Signal protocol expects. We
        // only call back into here on subsequent contacts.
        return true;
      }
      return _abEqual(existing.pubKey, identityKey);
    }

    async saveIdentity(identifier, identityKey, _nonblockingApproval) {
      if (typeof identifier !== 'string') {
        throw new Error('identifier must be string');
      }
      const existing = await _get(STORE_IDENTITIES, identifier);
      await _put(STORE_IDENTITIES, identifier, { pubKey: _ab(identityKey) });
      // Return true if the identity changed (libsignal contract).
      return !!(existing && !_abEqual(existing.pubKey, identityKey));
    }

    // Internal — returns the locally-stored peer identity (ArrayBuffer)
    // or undefined. Used by Signal.js to detect peer-identity drift
    // before reusing an existing session.
    async loadStoredIdentity(identifier) {
      if (typeof identifier !== 'string') return undefined;
      const row = await _get(STORE_IDENTITIES, identifier);
      return row ? row.pubKey : undefined;
    }

    // Internal — drop a stored peer identity so the next saveIdentity
    // on that identifier is treated as TOFU. Used when a drift is
    // detected and we need to rebuild a session under the peer's new
    // identity_pub without libsignal throwing UntrustedIdentityKeyError.
    async removeIdentity(identifier) {
      if (typeof identifier !== 'string') return;
      await _del(STORE_IDENTITIES, identifier);
    }

    // ── Pre-keys (one-time) ────────────────────────────────────────────

    async loadPreKey(keyId) {
      const row = await _get(STORE_PREKEYS, Number(keyId));
      if (!row) return undefined;
      return { pubKey: row.pubKey, privKey: row.privKey };
    }

    async storePreKey(keyId, keyPair) {
      await _put(STORE_PREKEYS, Number(keyId), {
        pubKey: _ab(keyPair.pubKey),
        privKey: _ab(keyPair.privKey),
      });
    }

    async removePreKey(keyId) {
      await _del(STORE_PREKEYS, Number(keyId));
    }

    async _listPreKeyIds() {
      const rows = await _all(STORE_PREKEYS);
      return rows.map(r => Number(r.key)).filter(n => Number.isFinite(n));
    }

    // ── Signed pre-key ─────────────────────────────────────────────────

    async loadSignedPreKey(keyId) {
      const row = await _get(STORE_SIGNED_PREKEYS, Number(keyId));
      if (!row) return undefined;
      return { pubKey: row.pubKey, privKey: row.privKey };
    }

    async storeSignedPreKey(keyId, keyPair) {
      await _put(STORE_SIGNED_PREKEYS, Number(keyId), {
        pubKey: _ab(keyPair.pubKey),
        privKey: _ab(keyPair.privKey),
        signature: keyPair.signature ? _ab(keyPair.signature) : undefined,
        timestamp: Date.now(),
      });
    }

    async removeSignedPreKey(keyId) {
      await _del(STORE_SIGNED_PREKEYS, Number(keyId));
    }

    async _loadSignedPreKeyFull(keyId) {
      return _get(STORE_SIGNED_PREKEYS, Number(keyId));
    }

    async _latestSignedPreKey() {
      const rows = await _all(STORE_SIGNED_PREKEYS);
      if (!rows.length) return null;
      rows.sort((a, b) => (b.value?.timestamp || 0) - (a.value?.timestamp || 0));
      const top = rows[0];
      return { id: Number(top.key), ...top.value };
    }

    // ── Sessions ───────────────────────────────────────────────────────

    async loadSession(identifier) {
      return _get(STORE_SESSIONS, String(identifier));
    }

    async storeSession(identifier, record) {
      await _put(STORE_SESSIONS, String(identifier), record);
    }

    async removeSession(identifier) {
      await _del(STORE_SESSIONS, String(identifier));
    }

    async removeAllSessions(identifierPrefix) {
      const db = await _openDb();
      await new Promise((resolve, reject) => {
        const store = _tx(db, STORE_SESSIONS, 'readwrite');
        const req = store.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) { resolve(); return; }
          if (String(cur.key).startsWith(String(identifierPrefix))) {
            cur.delete();
          }
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    }

    // ── Diagnostics ────────────────────────────────────────────────────

    async _stats() {
      const [id, peers, sess, pks, spks] = await Promise.all([
        _get(STORE_IDENTITY, 'self'),
        _all(STORE_IDENTITIES),
        _all(STORE_SESSIONS),
        _all(STORE_PREKEYS),
        _all(STORE_SIGNED_PREKEYS),
      ]);
      return {
        haveIdentity: !!id,
        registrationId: id?.registrationId,
        peerCount: peers.length,
        sessionCount: sess.length,
        preKeyCount: pks.length,
        signedPreKeyCount: spks.length,
      };
    }

    // Hard reset \u2014 used by "reset DM session" UX.
    async _wipe() {
      const db = await _openDb();
      await new Promise((resolve, reject) => {
        const stores = [STORE_IDENTITY, STORE_IDENTITIES, STORE_SESSIONS,
                        STORE_PREKEYS, STORE_SIGNED_PREKEYS];
        const t = db.transaction(stores, 'readwrite');
        for (const s of stores) t.objectStore(s).clear();
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    }
  }

  try {
    if (typeof window !== 'undefined') {
      window.SignalStore = FrogtalkSignalStore;
      window.SignalStoreDirection = Direction;
    }
  } catch {}
})();
