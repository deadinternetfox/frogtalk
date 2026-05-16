// static/js/signal.js
//
// Track A — FrogTalk wrapper around
// `@privacyresearch/libsignal-protocol-typescript` (bundled at
// /static/vendor/libsignal/libsignal-protocol.js).
//
// Public API exposed on `window.Signal`:
//
//   await Signal.init()
//       Loads the libsignal module if not already loaded.
//       Opens the IndexedDB store. Generates a fresh identity +
//       prekey pool on first run. Idempotent.
//
//   Signal.isReady() → boolean
//       True iff init() has completed AND the local user has an
//       uploaded bundle on the server.
//
//   await Signal.ensureMyBundleFresh()
//       Rotates the signed prekey if older than 7 days, tops up the
//       one-time prekey pool if depleted, uploads via
//       POST /api/signal/bundle.
//
//   await Signal.encryptDM(peerUserId, plaintextString) → envelope
//       Encrypts under the recipient's Signal session, returns
//       {v:2, t:'pre'|'msg', b:'<base64>'}.
//
//   await Signal.decryptDM(peerUserId, envelope) → plaintextString
//       Inverse. Throws on tamper / wrong recipient / replay.
//
//   await Signal.resetSessionWith(peerUserId)
//       Drop the local session record for a peer (forces a fresh
//       PREKEY exchange on next send). UX surface: "Reset DM session".
//
// The `enc_v2` feature flag is a server-side concept; this module
// just provides the capability. `dms.js` chooses v1 vs v2 per-message.
//
// All wire bytes use base64. All in-process keys are ArrayBuffer.

(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────

  const LIBSIGNAL_URL = '/static/vendor/libsignal/libsignal-protocol.js?v=1';
  const SIGNED_PREKEY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // 1 week
  const OTPK_LOW_WATERMARK = 10;
  const OTPK_BATCH = 100;
  const OUR_DEVICE_ID = 1;   // single-device until Track F lands
  const ENVELOPE_VERSION = 2;

  // libsignal "message type" constants. We re-derive locally so we
  // don't depend on the bundle's internal enum being exposed.
  const TYPE_PREKEY = 3;
  const TYPE_WHISPER = 1;

  // ── Module-load state ────────────────────────────────────────────────

  let _libsignal = null;
  let _store = null;
  let _initPromise = null;
  let _bundlePromise = null;
  let _bundleHealthy = false;
  let _ourUserId = null;

  // ── b64 helpers ──────────────────────────────────────────────────────

  function _abToB64(buf) {
    const bytes = buf instanceof Uint8Array
      ? buf
      : new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function _b64ToAb(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  // libsignal expects ArrayBuffer for key material. Some functions
  // return Uint8Array wrappers; normalise.
  function _toAb(x) {
    if (x instanceof ArrayBuffer) return x;
    if (ArrayBuffer.isView(x)) return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength);
    if (typeof x === 'string') return _b64ToAb(x);
    throw new Error('expected ArrayBuffer / view / b64 string');
  }

  // ── Module loader ────────────────────────────────────────────────────

  async function _loadLibsignal() {
    if (_libsignal) return _libsignal;
    // Dynamic ESM import \u2014 the bundle assigns `window.libsignal` on
    // first evaluation as a fallback, but we prefer the module export.
    const mod = await import(LIBSIGNAL_URL);
    _libsignal = mod.default || window.libsignal;
    if (!_libsignal || !_libsignal.KeyHelper) {
      throw new Error('libsignal bundle malformed');
    }
    return _libsignal;
  }

  // ── Init ─────────────────────────────────────────────────────────────

  async function _ensureIdentity(libsignal, store) {
    const have = await store.getIdentityKeyPair();
    if (have) return;
    const idKey = await libsignal.KeyHelper.generateIdentityKeyPair();
    const regId = libsignal.KeyHelper.generateRegistrationId();
    await store._setIdentity(idKey, regId);
  }

  async function _ensureSignedPreKey(libsignal, store) {
    const latest = await store._latestSignedPreKey();
    const now = Date.now();
    if (latest && latest.signature && (now - (latest.timestamp || 0) < SIGNED_PREKEY_MAX_AGE_MS)) {
      return latest;
    }
    const idKey = await store.getIdentityKeyPair();
    const nextId = (latest ? latest.id + 1 : 1) >>> 0;
    const signed = await libsignal.KeyHelper.generateSignedPreKey(idKey, nextId);
    // Stash the signature into the keypair object before persistence so
    // our store's storeSignedPreKey serialises it in one row.
    const kp = {
      pubKey: signed.keyPair.pubKey,
      privKey: signed.keyPair.privKey,
      signature: signed.signature,
    };
    await store.storeSignedPreKey(nextId, kp);
    return {
      id: nextId,
      pubKey: kp.pubKey,
      privKey: kp.privKey,
      signature: signed.signature,
      timestamp: Date.now(),
    };
  }

  async function _ensurePreKeyPool(libsignal, store) {
    const ids = await store._listPreKeyIds();
    if (ids.length >= OTPK_LOW_WATERMARK) return [];
    const nextStart = (ids.length ? Math.max(...ids) : 0) + 1;
    const fresh = [];
    for (let i = 0; i < OTPK_BATCH; i++) {
      const id = (nextStart + i) >>> 0;
      const pk = await libsignal.KeyHelper.generatePreKey(id);
      await store.storePreKey(id, pk.keyPair);
      fresh.push({ id, pubKey: pk.keyPair.pubKey });
    }
    return fresh;
  }

  async function init(ourUserId) {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      const libsignal = await _loadLibsignal();
      if (!window.SignalStore) {
        throw new Error('SignalStore (signal_store.js) not loaded');
      }
      _store = new window.SignalStore();
      _ourUserId = Number(ourUserId) || null;
      await _ensureIdentity(libsignal, _store);
    })();
    try {
      await _initPromise;
    } catch (e) {
      _initPromise = null;
      throw e;
    }
    return _initPromise;
  }

  // ── Bundle upload / fetch ────────────────────────────────────────────

  async function ensureMyBundleFresh() {
    if (!_libsignal || !_store) return;
    if (_bundlePromise) return _bundlePromise;
    _bundlePromise = (async () => {
      const libsignal = _libsignal;
      const store = _store;
      const signed = await _ensureSignedPreKey(libsignal, store);
      const fresh = await _ensurePreKeyPool(libsignal, store);
      const idKey = await store.getIdentityKeyPair();
      const regId = await store.getLocalRegistrationId();

      const body = {
        registration_id: regId,
        identity_pub: _abToB64(idKey.pubKey),
        signed_prekey: {
          id: signed.id,
          pub: _abToB64(signed.pubKey),
          sig: _abToB64(signed.signature),
        },
        one_time_prekeys: fresh.map(k => ({ id: k.id, pub: _abToB64(k.pubKey) })),
      };
      const apiFetch = window.apiFetch || ((u, m, b) => fetch(u, {
        method: m || 'GET',
        headers: { 'content-type': 'application/json' },
        body: b ? JSON.stringify(b) : undefined,
        credentials: 'include',
      }));
      const res = await apiFetch('/api/signal/bundle', 'POST', body);
      if (!res.ok) {
        // 503 \u2192 server still has flag off. Not an error from our side.
        if (res.status === 503) { _bundleHealthy = false; return; }
        throw new Error('bundle upload failed: ' + res.status);
      }
      _bundleHealthy = true;
    })();
    try {
      await _bundlePromise;
    } finally {
      _bundlePromise = null;
    }
  }

  async function _fetchPeerBundle(peerUserId) {
    const apiFetch = window.apiFetch || ((u) => fetch(u, { credentials: 'include' }));
    const res = await apiFetch(`/api/signal/bundle/${encodeURIComponent(peerUserId)}`);
    if (!res.ok) throw new Error('peer bundle fetch failed: ' + res.status);
    const data = await res.json();
    return data;
  }

  // ── Per-peer addressing ──────────────────────────────────────────────

  function _addr(peerUserId) {
    if (!_libsignal) throw new Error('Signal not initialised');
    return new _libsignal.SignalProtocolAddress(String(peerUserId), OUR_DEVICE_ID);
  }

  async function _ensureSessionWith(peerUserId) {
    const addr = _addr(peerUserId);
    const existing = await _store.loadSession(addr.toString());
    if (existing) return;
    // No session yet \u2014 fetch a bundle and run X3DH.
    const bundle = await _fetchPeerBundle(peerUserId);
    const remote = {
      identityKey: _toAb(bundle.identity_pub),
      registrationId: bundle.registration_id,
      preKey: bundle.one_time_prekey ? {
        keyId: bundle.one_time_prekey.id,
        publicKey: _toAb(bundle.one_time_prekey.pub),
      } : undefined,
      signedPreKey: {
        keyId: bundle.signed_prekey.id,
        publicKey: _toAb(bundle.signed_prekey.pub),
        signature: _toAb(bundle.signed_prekey.sig),
      },
    };
    const builder = new _libsignal.SessionBuilder(_store, addr);
    await builder.processPreKey(remote);
  }

  // ── Encrypt / decrypt ────────────────────────────────────────────────

  async function encryptDM(peerUserId, plaintext) {
    if (!_libsignal || !_store) throw new Error('Signal not initialised');
    await _ensureSessionWith(peerUserId);
    const addr = _addr(peerUserId);
    const cipher = new _libsignal.SessionCipher(_store, addr);
    const ptBytes = new TextEncoder().encode(String(plaintext));
    const ct = await cipher.encrypt(ptBytes.buffer);
    // ct.type is 3 (PREKEY) on first message, 1 (WHISPER) thereafter.
    const tag = (ct.type === TYPE_PREKEY) ? 'pre' : 'msg';
    return {
      v: ENVELOPE_VERSION,
      t: tag,
      // ct.body is a binary STRING (libsignal API quirk); convert via
      // charCode to Uint8Array.
      b: _binaryStringToB64(ct.body),
    };
  }

  function _binaryStringToB64(s) {
    if (typeof s !== 'string') return _abToB64(_toAb(s));
    // Already a binary string; btoa accepts it directly.
    return btoa(s);
  }

  function _b64ToBinaryString(b64) {
    return atob(String(b64 || ''));
  }

  async function decryptDM(peerUserId, envelope) {
    if (!_libsignal || !_store) throw new Error('Signal not initialised');
    if (!envelope || envelope.v !== ENVELOPE_VERSION || typeof envelope.b !== 'string') {
      throw new Error('not a v2 envelope');
    }
    const addr = _addr(peerUserId);
    const cipher = new _libsignal.SessionCipher(_store, addr);
    const binaryBody = _b64ToBinaryString(envelope.b);
    let ptBuf;
    if (envelope.t === 'pre') {
      ptBuf = await cipher.decryptPreKeyWhisperMessage(binaryBody, 'binary');
    } else if (envelope.t === 'msg') {
      ptBuf = await cipher.decryptWhisperMessage(binaryBody, 'binary');
    } else {
      throw new Error('unknown envelope type: ' + envelope.t);
    }
    return new TextDecoder().decode(ptBuf);
  }

  async function resetSessionWith(peerUserId) {
    if (!_store) return;
    const addr = _addr(peerUserId);
    await _store.removeSession(addr.toString());
  }

  function isReady() {
    return !!(_libsignal && _store);
  }

  function bundleHealthy() {
    return _bundleHealthy;
  }

  // ── Public surface ───────────────────────────────────────────────────

  const Signal = {
    init,
    isReady,
    bundleHealthy,
    ensureMyBundleFresh,
    encryptDM,
    decryptDM,
    resetSessionWith,
    // Diagnostics:
    async _stats() { return _store ? _store._stats() : null; },
    async _wipe() { if (_store) await _store._wipe(); },
  };

  try {
    if (typeof window !== 'undefined') window.Signal = Signal;
  } catch {}
})();
