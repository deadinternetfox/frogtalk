// static/js/signal_room.js
//
// Track C Phase 1 — Sender Keys for multi-party room encryption.
//
// The vendored libsignal-protocol-typescript v0.0.16 bundle does NOT
// export the GroupCipher / SenderKey APIs. Rather than swap libraries
// mid-flight (would invalidate every 1:1 session we just shipped in
// Track A), we implement Sender Keys directly on top of the primitives
// libsignal does expose (Curve25519 XEdDSA signatures) plus WebCrypto's
// HMAC-SHA256 / HKDF / AES-GCM. The protocol below matches Signal's
// SenderKey scheme byte-for-byte at the chain-key ratchet, then uses
// AES-256-GCM + Curve25519 XEdDSA signing for the payload — the only
// material delta from upstream is GCM in place of CBC+HMAC (gives us
// an auth tag for free, simpler audit, identical security argument).
//
// === Wire envelopes (carried inside the existing messages.content) ===
//
//   normal room message (broadcast on the room channel):
//   { v:2, t:'sk', b:base64(JSON.stringify({
//       c:  chain_id,            // rotation count, uint32
//       i:  iteration,           // message counter within chain, uint32
//       d:  device_id,           // sender device id, uint32 (1 today)
//       ct: base64(ciphertext),  // AES-GCM(msg_key, plaintext) incl tag
//       s:  base64(signature),   // XEdDSA over header||ct
//   })) }
//
//   sender-key distribution message (delivered point-to-point as a
//   regular Track A v2 DM envelope from the room sender to each other
//   member — never visible on the room channel):
//   { v:2, t:'skdm', b:base64(JSON.stringify({
//       r:   room_id,            // string
//       c:   chain_id, i: iteration,
//       d:   device_id,
//       ck:  base64(chain_key),  // 32 bytes — RECEIVER'S COPY of chain key at iter
//       pk:  base64(sign_pub),   // 32 bytes Curve25519 signing pub
//   })) }
//
// === Trust model ===
//
// SKDMs are wrapped in Track A v2 DM envelopes for confidentiality and
// sender authentication. A receiver therefore trusts the SKDM iff the
// outer 1:1 Signal session verified — no extra binding required.
//
// === Out of scope for Phase 1 ===
//
// - Skipped-message handling (receiver chain-key catch-up) — Phase 2.
// - Membership-change rotation/fanout glue — Phase 2.
// - UI wiring in messages.js / ws.js — Phase 3.
// - "Older message — encrypted" placeholder for v1-only receivers —
//   Phase 3.

(function () {
  'use strict';

  const ENVELOPE_VERSION = 2;
  const DB_NAME = 'frogtalk-signal-room-v1';
  const DB_VERSION = 1;
  const STORE_SENDER_KEYS = 'sender_keys';
  const STORE_SELF_KEYS   = 'self_keys';
  const STORE_EPOCHS      = 'epochs';

  // ── IndexedDB layer ──────────────────────────────────────────────────

  let _dbPromise = null;

  function _openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_SENDER_KEYS)) db.createObjectStore(STORE_SENDER_KEYS);
        if (!db.objectStoreNames.contains(STORE_SELF_KEYS))   db.createObjectStore(STORE_SELF_KEYS);
        if (!db.objectStoreNames.contains(STORE_EPOCHS))      db.createObjectStore(STORE_EPOCHS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error || new Error('indexeddb open failed'));
      req.onblocked = () => reject(new Error('indexeddb blocked'));
    });
    return _dbPromise;
  }

  function _idbGet(store, key) {
    return _openDb().then(db => new Promise((resolve, reject) => {
      const r = db.transaction(store, 'readonly').objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror   = () => reject(r.error);
    }));
  }
  function _idbPut(store, key, value) {
    return _openDb().then(db => new Promise((resolve, reject) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).put(value, key);
      r.onsuccess = () => resolve();
      r.onerror   = () => reject(r.error);
    }));
  }
  function _idbDel(store, key) {
    return _openDb().then(db => new Promise((resolve, reject) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).delete(key);
      r.onsuccess = () => resolve();
      r.onerror   = () => reject(r.error);
    }));
  }

  // ── b64 / byte helpers ───────────────────────────────────────────────

  function _abToB64(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function _b64ToBytes(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function _u32be(n) {
    const b = new Uint8Array(4);
    b[0] = (n >>> 24) & 0xff; b[1] = (n >>> 16) & 0xff;
    b[2] = (n >>> 8) & 0xff;  b[3] = n & 0xff;
    return b;
  }
  function _concat(...arrs) {
    let total = 0;
    for (const a of arrs) total += a.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  }
  function _randomBytes(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }

  // ── Crypto primitives ────────────────────────────────────────────────

  // HMAC-SHA256(key, data) → 32 bytes
  async function _hmac(key, data) {
    const k = await crypto.subtle.importKey(
      'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', k, data);
    return new Uint8Array(sig);
  }

  // Signal SenderKey chain-key ratchet:
  //   message_key    = HMAC(chain_key, 0x01)
  //   next_chain_key = HMAC(chain_key, 0x02)
  async function _deriveMessageKey(chainKey) {
    return _hmac(chainKey, new Uint8Array([0x01]));
  }
  async function _ratchetChainKey(chainKey) {
    return _hmac(chainKey, new Uint8Array([0x02]));
  }

  // HKDF(messageKey, info) → 32B AES key || 12B IV
  async function _expandMessageKey(messageKey, info) {
    const ikm = await crypto.subtle.importKey('raw', messageKey, { name: 'HKDF' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info },
      ikm, (32 + 12) * 8,
    );
    const out = new Uint8Array(bits);
    return { aesKey: out.subarray(0, 32), iv: out.subarray(32, 44) };
  }

  // AES-256-GCM encrypt → ciphertext (incl 16-byte tag)
  async function _aesEncrypt(keyBytes, iv, plaintext, aad) {
    const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      k, plaintext,
    );
    return new Uint8Array(ct);
  }
  async function _aesDecrypt(keyBytes, iv, ciphertext, aad) {
    const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      k, ciphertext,
    );
    return new Uint8Array(pt);
  }

  // Curve25519 XEdDSA via the vendored libsignal Curve. Async or sync.
  function _curve() {
    const L = window.libsignal;
    if (!L || !L.Curve) throw new Error('libsignal not loaded');
    return L.Curve.async || L.Curve;
  }
  async function _generateSigningKeyPair() {
    const kp = await _curve().generateKeyPair();
    // {pubKey, privKey} as ArrayBuffers
    return {
      pub:  new Uint8Array(kp.pubKey),
      priv: new Uint8Array(kp.privKey),
    };
  }
  async function _sign(privBytes, data) {
    const sig = await _curve().calculateSignature(privBytes.buffer, data.buffer || data);
    return new Uint8Array(sig);
  }
  async function _verifySig(pubBytes, data, sigBytes) {
    try {
      await _curve().verifySignature(pubBytes.buffer, data.buffer || data, sigBytes.buffer || sigBytes);
      return true;
    } catch { return false; }
  }

  // ── Sender-key state ─────────────────────────────────────────────────
  //
  // Key shape per room:
  //   self_keys[roomId]                  = { chain_id, iteration, chain_key, sign_pub, sign_priv, device_id }
  //   sender_keys[`${roomId}|${uid}|${did}`] = { chain_id, iteration, chain_key, sign_pub }
  //   epochs[roomId]                     = uint32 (informational)

  async function _getSelfState(roomId) {
    return _idbGet(STORE_SELF_KEYS, String(roomId));
  }
  async function _putSelfState(roomId, state) {
    return _idbPut(STORE_SELF_KEYS, String(roomId), state);
  }
  async function _getPeerState(roomId, uid, did) {
    return _idbGet(STORE_SENDER_KEYS, `${roomId}|${uid}|${did}`);
  }
  async function _putPeerState(roomId, uid, did, state) {
    return _idbPut(STORE_SENDER_KEYS, `${roomId}|${uid}|${did}`, state);
  }
  async function _delPeerState(roomId, uid, did) {
    return _idbDel(STORE_SENDER_KEYS, `${roomId}|${uid}|${did}`);
  }
  async function _bumpEpoch(roomId) {
    const cur = (await _idbGet(STORE_EPOCHS, String(roomId))) | 0;
    const next = cur + 1;
    await _idbPut(STORE_EPOCHS, String(roomId), next);
    return next;
  }

  // ── Public API ───────────────────────────────────────────────────────

  // Create or rotate this device's sender-key for `roomId`. Returns the
  // SKDM payload object that callers must wrap in v2 DM envelopes and
  // fan out to every other member.
  async function rotateSenderKey(roomId, deviceId = 1) {
    const chainKey = _randomBytes(32);
    const kp = await _generateSigningKeyPair();
    const prev = await _getSelfState(roomId);
    const chainId = ((prev?.chain_id | 0) + 1) >>> 0;
    const state = {
      chain_id:  chainId,
      iteration: 0,
      chain_key: chainKey,
      sign_pub:  kp.pub,
      sign_priv: kp.priv,
      device_id: deviceId | 0,
    };
    await _putSelfState(roomId, state);
    await _bumpEpoch(roomId);
    return {
      r:  String(roomId),
      c:  chainId,
      i:  0,
      d:  state.device_id,
      ck: _abToB64(chainKey),
      pk: _abToB64(kp.pub),
    };
  }

  // Build the SKDM payload from current self state (without rotating).
  // Useful when a new member joins and we need to ship them our chain
  // *at its current iteration* rather than rotating.
  async function buildSKDMForCurrentChain(roomId) {
    const s = await _getSelfState(roomId);
    if (!s) return null;
    return {
      r:  String(roomId),
      c:  s.chain_id,
      i:  s.iteration,
      d:  s.device_id,
      ck: _abToB64(s.chain_key),
      pk: _abToB64(s.sign_pub),
    };
  }

  // Persist an SKDM received from `senderUid` for `roomId`. Replaces
  // any older state for that (room, sender, device).
  async function processSKDM(senderUid, skdmPayload) {
    if (!skdmPayload || typeof skdmPayload !== 'object') throw new Error('bad SKDM');
    const roomId = String(skdmPayload.r);
    const did    = (skdmPayload.d | 0) || 1;
    const ck     = _b64ToBytes(skdmPayload.ck);
    const pk     = _b64ToBytes(skdmPayload.pk);
    if (ck.length !== 32) throw new Error('bad SKDM: chain_key length');
    if (pk.length !== 32) throw new Error('bad SKDM: sign_pub length');
    await _putPeerState(roomId, senderUid, did, {
      chain_id:  (skdmPayload.c | 0) >>> 0,
      iteration: (skdmPayload.i | 0) >>> 0,
      chain_key: ck,
      sign_pub:  pk,
    });
  }

  // Encrypt `plaintext` for `roomId` under this device's sender key.
  // Advances the chain. Returns wire envelope {v,t:'sk',b}.
  async function encryptMessage(roomId, plaintext) {
    let s = await _getSelfState(roomId);
    if (!s) throw new Error('no sender-key for room — call rotateSenderKey first');
    const pt = (plaintext instanceof Uint8Array)
      ? plaintext
      : new TextEncoder().encode(String(plaintext));
    const header = _concat(
      new TextEncoder().encode('FrogTalk-SK-v1|'),
      new TextEncoder().encode(String(roomId)),
      new Uint8Array([0]),
      _u32be(s.chain_id),
      _u32be(s.iteration),
      _u32be(s.device_id),
    );
    const messageKey = await _deriveMessageKey(s.chain_key);
    const { aesKey, iv } = await _expandMessageKey(messageKey, header);
    const ct = await _aesEncrypt(aesKey, iv, pt, header);
    const sig = await _sign(s.sign_priv, _concat(header, ct));
    // Ratchet chain key + bump iteration, persist.
    const next = await _ratchetChainKey(s.chain_key);
    s = { ...s, chain_key: next, iteration: (s.iteration + 1) >>> 0 };
    await _putSelfState(roomId, s);
    const payload = {
      c:  s.chain_id,   // chain_id we just used (pre-bump)
      i:  s.iteration - 1,
      d:  s.device_id,
      ct: _abToB64(ct),
      s:  _abToB64(sig),
    };
    return {
      v: ENVELOPE_VERSION,
      t: 'sk',
      b: _abToB64(new TextEncoder().encode(JSON.stringify(payload))),
    };
  }

  // Decrypt a {v:2,t:'sk',b:…} envelope from `senderUid`.
  // Phase 1: only handles in-order delivery (iteration === stored iter).
  // Phase 2 will add skipped-message catch-up.
  async function decryptMessage(roomId, senderUid, envelope) {
    if (!envelope || envelope.v !== ENVELOPE_VERSION || envelope.t !== 'sk') {
      throw new Error('not a sender-key envelope');
    }
    const payload = JSON.parse(new TextDecoder().decode(_b64ToBytes(envelope.b)));
    const did = (payload.d | 0) || 1;
    const peer = await _getPeerState(String(roomId), senderUid, did);
    if (!peer) throw new Error('no sender-key state for (room, sender) — awaiting SKDM');
    if ((payload.c >>> 0) !== peer.chain_id) {
      throw new Error('chain_id mismatch (rotation pending)');
    }
    if ((payload.i >>> 0) < peer.iteration) {
      throw new Error('replay — iteration already consumed');
    }
    if ((payload.i >>> 0) !== peer.iteration) {
      throw new Error('skipped iteration (Phase 1 in-order only)');
    }
    const ct  = _b64ToBytes(payload.ct);
    const sig = _b64ToBytes(payload.s);
    const header = _concat(
      new TextEncoder().encode('FrogTalk-SK-v1|'),
      new TextEncoder().encode(String(roomId)),
      new Uint8Array([0]),
      _u32be(peer.chain_id),
      _u32be(peer.iteration),
      _u32be(did),
    );
    const sigOk = await _verifySig(peer.sign_pub, _concat(header, ct), sig);
    if (!sigOk) throw new Error('signature verification failed');
    const messageKey = await _deriveMessageKey(peer.chain_key);
    const { aesKey, iv } = await _expandMessageKey(messageKey, header);
    const pt = await _aesDecrypt(aesKey, iv, ct, header);
    // Ratchet forward and persist.
    const nextKey = await _ratchetChainKey(peer.chain_key);
    await _putPeerState(String(roomId), senderUid, did, {
      ...peer, chain_key: nextKey, iteration: (peer.iteration + 1) >>> 0,
    });
    return new TextDecoder().decode(pt);
  }

  // Forget a peer's sender-key state (membership change).
  async function forgetSender(roomId, uid, deviceId = 1) {
    await _delPeerState(String(roomId), uid, deviceId | 0);
  }

  // Diagnostics: have we ever sent in this room?
  async function hasSelfKey(roomId) {
    return !!(await _getSelfState(roomId));
  }
  async function epoch(roomId) {
    return (await _idbGet(STORE_EPOCHS, String(roomId))) | 0;
  }

  // Diagnostics for the Encryption-info UI. Returns a compact snapshot
  // of local Sender-Keys state for a room. Never throws.
  async function describeRoom(roomId) {
    const out = {
      available: false,
      hasSelfKey: false,
      epoch: 0,
      self: null,       // { chain_id, iteration, device_id }
      peerCount: 0,     // number of known sender peers (devices)
      peers: [],        // [{ uid, deviceId, chain_id, iteration }]
    };
    try {
      out.available = isAvailable();
      out.epoch = (await _idbGet(STORE_EPOCHS, String(roomId))) | 0;
      const self = await _getSelfState(roomId);
      if (self) {
        out.hasSelfKey = true;
        out.self = {
          chain_id:  self.chain_id  >>> 0,
          iteration: self.iteration >>> 0,
          device_id: self.device_id | 0,
        };
      }
      // Walk the sender_keys store, filtering by roomId prefix.
      try {
        const db = await _openDb();
        const tx = db.transaction(STORE_SENDER_KEYS, 'readonly');
        const store = tx.objectStore(STORE_SENDER_KEYS);
        const prefix = String(roomId) + '|';
        await new Promise((resolve) => {
          const req = store.openCursor();
          req.onsuccess = (ev) => {
            const cur = ev.target.result;
            if (!cur) { resolve(); return; }
            const k = String(cur.key || '');
            if (k.startsWith(prefix)) {
              const rest = k.slice(prefix.length).split('|');
              const uid = rest[0] || '';
              const deviceId = (rest[1] | 0) || 1;
              const v = cur.value || {};
              out.peers.push({
                uid,
                deviceId,
                chain_id:  (v.chain_id  | 0) >>> 0,
                iteration: (v.iteration | 0) >>> 0,
              });
            }
            cur.continue();
          };
          req.onerror = () => resolve();
        });
        out.peerCount = out.peers.length;
      } catch {}
    } catch {}
    return out;
  }

  // ── Capability probe ─────────────────────────────────────────────────
  // Returns true iff the libsignal Curve primitives we depend on are
  // loaded and the WebCrypto subset we need is present.
  function isAvailable() {
    try {
      return !!(window.libsignal
        && window.libsignal.Curve
        && (window.libsignal.Curve.async || window.libsignal.Curve).calculateSignature
        && crypto && crypto.subtle && crypto.getRandomValues);
    } catch { return false; }
  }

  // Lazy boot mirror of Signal.ensureReady — sends in rooms hit
  // isAvailable() before encryptMessage(); if libsignal hasn't finished
  // loading from a fresh login the user used to see
  // "signal_room_unavailable". Now we await the in-flight Signal init.
  async function ensureAvailable(opts) {
    if (isAvailable()) return true;
    try {
      if (window.Signal && typeof window.Signal.ensureReady === 'function') {
        await window.Signal.ensureReady(null, opts || {});
      }
    } catch (e) { console.warn('[Signal.room] ensureAvailable failed', e); }
    return isAvailable();
  }

  // ── SKDM transport over the backend relay (Track C Phase 3) ──────────
  //
  // The recipient's identity is already established by Track A. We:
  //   1. Wrap the SKDM payload in a marker JSON so the receiver can
  //      distinguish it from a real DM body.
  //   2. Encrypt that JSON to the recipient using `Signal.encryptDM`.
  //   3. POST the resulting opaque envelope to `/api/signal/skdm/{uid}`
  //      together with the target room id.
  //
  // The server cannot read the envelope. If the recipient is offline it
  // spools the row and the WS connect handler drains it on next login.
  async function sendSKDMTo(peerUserId, skdmPayload) {
    if (!skdmPayload || typeof skdmPayload !== 'object') {
      throw new Error('sendSKDMTo: bad payload');
    }
    if (!(window.Signal && typeof window.Signal.encryptDM === 'function')) {
      throw new Error('sendSKDMTo: Signal DM transport unavailable');
    }
    const peer = Number(peerUserId) | 0;
    if (peer <= 0) throw new Error('sendSKDMTo: bad recipient');
    const roomId = String(skdmPayload.r || '');
    if (!roomId) throw new Error('sendSKDMTo: missing room id in payload');

    const marker = JSON.stringify({ __skdm: 1, p: skdmPayload });
    const env = await window.Signal.encryptDM(peer, marker);

    const resp = await fetch(`/api/signal/skdm/${peer}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id: roomId,
        envelope: JSON.stringify(env),
      }),
    });
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.json())?.detail || ''; } catch {}
      throw new Error(`sendSKDMTo: server ${resp.status}${detail ? ' ' + detail : ''}`);
    }
    return await resp.json().catch(() => ({ ok: true }));
  }

  // Convenience: fan the current chain's SKDM to a list of peer uids
  // (excluding self). Failures per-peer are swallowed and reported in
  // the result so callers can retry only the failing recipients.
  async function fanSKDMTo(roomId, peerUids) {
    const skdm = await buildSKDMForCurrentChain(roomId);
    if (!skdm) throw new Error('fanSKDMTo: no self chain — rotate first');
    const results = [];
    for (const uid of (peerUids || [])) {
      try {
        await sendSKDMTo(uid, skdm);
        results.push({ uid, ok: true });
      } catch (e) {
        results.push({ uid, ok: false, error: String(e && e.message || e) });
      }
    }
    return results;
  }

  // ── Public surface ───────────────────────────────────────────────────

  const Room = {
    isAvailable,
    ensureAvailable,
    rotateSenderKey,
    buildSKDMForCurrentChain,
    processSKDM,
    encryptMessage,
    decryptMessage,
    forgetSender,
    hasSelfKey,
    epoch,
    describeRoom,
    sendSKDMTo,
    fanSKDMTo,
  };

  try {
    if (typeof window !== 'undefined') {
      window.SignalRoom = Room;
      // Also attach to window.Signal if Signal has finished loading.
      if (window.Signal) window.Signal.room = Room;
    }
  } catch {}
})();
