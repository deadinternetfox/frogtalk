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

  // ── Track E — signed DTLS fingerprint envelope ───────────────────────
  //
  // Signal-identity-signed binding of {call_id, peer_user_id,
  // fingerprint_sha256, ts} → guards against a malicious signalling
  // server substituting its own DTLS fingerprint into the SDP and
  // bridging the media. Envelope is base64-JSON for opaque transport
  // through the existing call_offer / call_answer WS frames.
  //
  // Wire format (after base64 decode):
  //   { p: <payload JSON string>, s: <b64 sig>, i: <b64 identity_pub> }
  //
  // Verify side fetches the *advertised* identity_pub from the peer's
  // /api/signal/bundle/<peerId> response and refuses to verify against
  // the one embedded in `i` if they disagree — otherwise a MITM could
  // sign with its own key and self-attest.

  const CALL_FP_MAX_AGE_MS = 60 * 1000;  // 1-minute freshness window

  // ── Generic XEdDSA signing with our primary identity key ────────────
  // Track F (linked devices) uses this to sign a (device_id ||
  // identity_pub) enrolment payload so peers can verify a secondary
  // device was authorised by the primary identity they already trust.

  async function getMyIdentityPubB64() {
    if (!_store) throw new Error('Signal not initialised');
    const idKey = await _store.getIdentityKeyPair();
    return _abToB64(idKey.pubKey);
  }

  async function signWithIdentity(bytes) {
    if (!_libsignal || !_store) throw new Error('Signal not initialised');
    if (!bytes) throw new Error('bytes required');
    const buf = bytes instanceof ArrayBuffer ? bytes
      : (bytes && bytes.buffer instanceof ArrayBuffer ? bytes.buffer : null);
    if (!buf) throw new Error('bytes must be ArrayBuffer or Uint8Array');
    const idKey = await _store.getIdentityKeyPair();
    const curve = (_libsignal.Curve && _libsignal.Curve.async) ? _libsignal.Curve.async : _libsignal.Curve;
    const sig = await curve.calculateSignature(idKey.privKey, buf);
    return _abToB64(sig);
  }

  async function signCallFingerprint(payload) {
    if (!_libsignal || !_store) throw new Error('Signal not initialised');
    if (!payload || typeof payload !== 'object') throw new Error('payload required');
    const required = ['call_id', 'peer_user_id', 'fingerprint_sha256'];
    for (const k of required) {
      if (payload[k] === undefined || payload[k] === null || payload[k] === '') {
        throw new Error('missing field: ' + k);
      }
    }
    // Canonicalise: stable JSON with sorted keys so caller and callee
    // sign / verify byte-identical messages.
    const canon = {
      call_id: Number(payload.call_id) || 0,
      peer_user_id: Number(payload.peer_user_id) || 0,
      fingerprint_sha256: String(payload.fingerprint_sha256).toLowerCase(),
      ts: Number(payload.ts) || Date.now(),
    };
    const message = JSON.stringify(canon, Object.keys(canon).sort());
    const idKey = await _store.getIdentityKeyPair();
    const msgBuf = new TextEncoder().encode(message).buffer;
    const curve = (_libsignal.Curve && _libsignal.Curve.async) ? _libsignal.Curve.async : _libsignal.Curve;
    const sig = await curve.calculateSignature(idKey.privKey, msgBuf);
    const env = {
      p: message,
      s: _abToB64(sig),
      i: _abToB64(idKey.pubKey),
    };
    return btoa(JSON.stringify(env));
  }

  async function verifyCallFingerprint(envelopeB64, opts) {
    // opts: { expectedFingerprint, expectedCallId, expectedPeerUserId,
    //         expectedIdentityPub /* b64 */ }
    if (!_libsignal) throw new Error('libsignal not loaded');
    if (!envelopeB64 || typeof envelopeB64 !== 'string') {
      return { ok: false, reason: 'no_envelope' };
    }
    let env;
    try { env = JSON.parse(atob(envelopeB64)); }
    catch { return { ok: false, reason: 'envelope_malformed' }; }
    if (!env || typeof env.p !== 'string' || typeof env.s !== 'string' || typeof env.i !== 'string') {
      return { ok: false, reason: 'envelope_malformed' };
    }
    // If caller supplied an out-of-band identity key (the trusted
    // bundle), demand the envelope advertise the *same* key. Otherwise
    // an attacker could sign with its own key and pass verification.
    if (opts && opts.expectedIdentityPub && env.i !== opts.expectedIdentityPub) {
      return { ok: false, reason: 'identity_mismatch' };
    }
    let payload;
    try { payload = JSON.parse(env.p); }
    catch { return { ok: false, reason: 'payload_malformed' }; }
    // Bind-check fields. Each mismatch is a distinct refusal reason so
    // the UI can surface "signalling tampering detected" precisely.
    if (opts && opts.expectedCallId !== undefined &&
        Number(payload.call_id) !== Number(opts.expectedCallId)) {
      return { ok: false, reason: 'call_id_mismatch' };
    }
    if (opts && opts.expectedPeerUserId !== undefined &&
        Number(payload.peer_user_id) !== Number(opts.expectedPeerUserId)) {
      return { ok: false, reason: 'peer_mismatch' };
    }
    if (opts && opts.expectedFingerprint &&
        String(payload.fingerprint_sha256 || '').toLowerCase() !==
        String(opts.expectedFingerprint).toLowerCase()) {
      return { ok: false, reason: 'fingerprint_mismatch' };
    }
    if (Math.abs(Date.now() - (Number(payload.ts) || 0)) > CALL_FP_MAX_AGE_MS) {
      return { ok: false, reason: 'stale' };
    }
    try {
      const pub = _b64ToAb(env.i);
      const sig = _b64ToAb(env.s);
      const msg = new TextEncoder().encode(env.p).buffer;
      const curve = (_libsignal.Curve && _libsignal.Curve.async) ? _libsignal.Curve.async : _libsignal.Curve;
      await curve.verifySignature(pub, msg, sig);
    } catch {
      return { ok: false, reason: 'bad_signature' };
    }
    return { ok: true, payload };
  }

  // Phase 1.5 helper: fetch peer identity public key (base64 string)
  // so the caller can pass it as `expectedIdentityPub` (base64) to
  // verifyCallFingerprint. Cached for ~5 min via the existing
  // /api/signal/bundle/<peer> endpoint.
  const _idkCache = new Map(); // peerUserId -> { b64, ts }
  const _IDK_TTL_MS = 5 * 60 * 1000;
  async function getPeerIdentityKey(peerUserId) {
    const key = String(peerUserId);
    const now = Date.now();
    const hit = _idkCache.get(key);
    if (hit && (now - hit.ts) < _IDK_TTL_MS) return hit.b64;
    try {
      const bundle = await _fetchPeerBundle(key);
      if (!bundle || !bundle.identity_pub) return null;
      const b64 = String(bundle.identity_pub);
      _idkCache.set(key, { b64, ts: now });
      return b64;
    } catch {
      return null;
    }
  }

  // ── Track E Phase 2 — Safety Numbers ─────────────────────────────────
  //
  // Returns a Signal-style 60-digit numeric safety number for in-person
  // verification (or QR-scan). Identical on both peers iff their cached
  // identity keys match. A change in the number = peer's identity key
  // rotated (re-install, key wipe, OR a MITM injecting a foreign key).
  //
  // Algorithm: SHA-512^5 over sort(idA||idB), interpreted as 12 groups of
  // 5 bytes → big-endian uint40 mod 100000, zero-padded to 5 digits.

  function _cmpBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  }

  async function safetyNumberWith(peerUserId) {
    if (!_libsignal || !_store) return null;
    let myPub;
    try {
      const idKey = await _store.getIdentityKeyPair();
      myPub = new Uint8Array(idKey.pubKey);
    } catch { return null; }
    const peerB64 = await getPeerIdentityKey(peerUserId);
    if (!peerB64) return null;
    let peerPub;
    try { peerPub = new Uint8Array(_b64ToAb(peerB64)); }
    catch { return null; }
    const [a, b] = _cmpBytes(myPub, peerPub) <= 0 ? [myPub, peerPub] : [peerPub, myPub];
    const concat = new Uint8Array(a.length + b.length);
    concat.set(a, 0); concat.set(b, a.length);
    let h = concat.buffer;
    for (let i = 0; i < 5; i++) {
      h = await crypto.subtle.digest('SHA-512', h);
    }
    const bytes = new Uint8Array(h);
    const groups = [];
    for (let i = 0; i < 12; i++) {
      let n = 0n;
      for (let j = 0; j < 5; j++) {
        n = (n << 8n) | BigInt(bytes[i * 5 + j]);
      }
      groups.push(String(Number(n % 100000n)).padStart(5, '0'));
    }
    return groups.join(' ');
  }

  // Identity-rotation watcher: returns true if the cached identity key
  // for `peerUserId` has changed since the last call (after first call
  // it always returns false). Used by calls.js to surface a "safety
  // number changed" toast at call setup time.
  const _idkSeen = new Map(); // peerUserId -> last seen b64
  function _checkIdentityRotation(peerUserId, currentB64) {
    if (!peerUserId || !currentB64) return false;
    const k = String(peerUserId);
    const prev = _idkSeen.get(k);
    _idkSeen.set(k, currentB64);
    return !!(prev && prev !== currentB64);
  }
  async function peerIdentityRotated(peerUserId) {
    const cur = await getPeerIdentityKey(peerUserId);
    if (!cur) return false;
    return _checkIdentityRotation(peerUserId, cur);
  }

  function isReady() {
    return !!(_libsignal && _store);
  }

  // Lazy / forgiving boot: if the caller tries to send before our
  // fire-and-forget App.launch() bootstrap has resolved, await the
  // in-flight init promise instead of throwing "Encryption layer not
  // ready". Returns true when libsignal + store are usable, false on
  // timeout / permanent failure. Safe to call concurrently — init()
  // dedupes via _initPromise. The bundle publish is fire-and-forget so
  // the first send isn't blocked on a network round-trip.
  async function ensureReady(userId, opts) {
    opts = opts || {};
    if (isReady()) return true;
    let uid = Number(userId) || _ourUserId || 0;
    if (!uid) {
      try { uid = Number(window.State && window.State.user && window.State.user.id) || 0; } catch {}
    }
    if (!uid) return false;
    const timeoutMs = Number(opts.timeoutMs) || 12000;
    try {
      await Promise.race([
        (async () => {
          await init(uid);
          // Fire-and-forget bundle publish — sends shouldn't block on
          // POST /api/signal/bundle.
          try { ensureMyBundleFresh().catch(() => {}); } catch {}
        })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('signal_init_timeout')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[Signal] ensureReady failed', e);
    }
    return isReady();
  }

  function bundleHealthy() {
    return _bundleHealthy;
  }

  // ── Public surface ───────────────────────────────────────────────────

  const Signal = {
    init,
    isReady,
    ensureReady,
    bundleHealthy,
    ensureMyBundleFresh,
    encryptDM,
    decryptDM,
    resetSessionWith,
    // Track E:
    signCallFingerprint,
    verifyCallFingerprint,
    getPeerIdentityKey,
    safetyNumberWith,
    peerIdentityRotated,
    // Track F (linked devices):
    getMyIdentityPubB64,
    signWithIdentity,
    // Diagnostics:
    async _stats() { return _store ? _store._stats() : null; },
    async _wipe() { if (_store) await _store._wipe(); },
    // Track H: full identity reset — wipes local Signal state and
    // publishes a fresh prekey bundle. Used by Settings → "Reset
    // encryption keys".
    async resetIdentity() {
      if (_store) {
        try { await _store._wipe(); } catch (e) { console.warn('[Signal] wipe failed', e); }
      }
      _store = null;
      _ready = false;
      _bundleHealthy = false;
      await init();
      await ensureMyBundleFresh();
    },
  };

  try {
    if (typeof window !== 'undefined') window.Signal = Signal;
    // Track C — if signal_room.js loaded before us, attach it now.
    if (typeof window !== 'undefined' && window.SignalRoom) {
      Signal.room = window.SignalRoom;
    }
  } catch {}
})();
