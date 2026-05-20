/**
 * crypto.js — Signal-style E2E encryption using Web Crypto API
 * Each room uses an AES-256-GCM key derived from the room name + a user-held passphrase.
 * DMs use a key derived from both participants' names + passphrase.
 * The server NEVER sees plaintext for encrypted rooms.
 */

const Crypto = (() => {
  // Key cache: roomKey -> CryptoKey
  const _keyCache = new Map();
  const _ecdhPairCache = new Map();
  // In-flight pair loader keyed by identity scope, so concurrent callers
  // (e.g. publishPubkey + first DM decrypt) share a single generate/import
  // and never end up with two different keypairs racing into localStorage.
  const _ecdhPairPending = new Map();
  const _payloadPrefix = 'ftenc:';

  function _bytesToBase64(bytes) {
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function _base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function _getIdentityScope() {
    try {
      const state = window.STATE || window.State || {};
      if (state.user?.id != null) return `user:${state.user.id}`;
      if (state.user?.nickname) return `nick:${String(state.user.nickname).toLowerCase()}`;
    } catch {}
    return 'anon';
  }

  function _ecdhStorageKey(scope = _getIdentityScope()) {
    return `frogtalk-ecdh-v1:${scope}`;
  }

  // ──────────────────────────────────────────────────────────────────
  // IndexedDB layer for ECDH keypair storage.
  //
  // Previously the keypair was JSON.stringify(JWK) in localStorage —
  // any XSS could grab the private key in plaintext. CryptoKey objects
  // are structured-cloneable, so IndexedDB lets us persist a private
  // key with `extractable: false` and the raw key material is never
  // exposed to JS again. localStorage is only consulted once for the
  // one-shot migration of legacy keypairs.
  // ──────────────────────────────────────────────────────────────────
  const _IDB_NAME = 'frogtalk-keys';
  const _IDB_STORE = 'ecdh';
  const _IDB_VERSION = 1;

  function _openIDB() {
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(_IDB_NAME, _IDB_VERSION);
        req.onupgradeneeded = () => {
          try { req.result.createObjectStore(_IDB_STORE); } catch {}
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('idb_open_failed'));
      } catch (e) { reject(e); }
    });
  }

  async function _idbGet(scope) {
    const db = await _openIDB();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(_IDB_STORE, 'readonly');
        const req = tx.objectStore(_IDB_STORE).get(scope);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } finally { try { db.close(); } catch {} }
  }

  async function _idbPut(scope, value) {
    const db = await _openIDB();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(_IDB_STORE, 'readwrite');
        tx.objectStore(_IDB_STORE).put(value, scope);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { try { db.close(); } catch {} }
  }

  async function _idbDelete(scope) {
    const db = await _openIDB();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(_IDB_STORE, 'readwrite');
        tx.objectStore(_IDB_STORE).delete(scope);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { try { db.close(); } catch {} }
  }

  async function _loadOrCreateECDHPair() {
    const scope = _getIdentityScope();
    if (_ecdhPairCache.has(scope)) return _ecdhPairCache.get(scope);
    if (_ecdhPairPending.has(scope)) return _ecdhPairPending.get(scope);

    const p = (async () => {
      // Re-check inside the async closure in case another caller populated
      // the cache between the outer guard and our scheduled microtask.
      if (_ecdhPairCache.has(scope)) return _ecdhPairCache.get(scope);
      return await _loadOrCreateECDHPairUnsafe(scope);
    })();
    _ecdhPairPending.set(scope, p);
    try { return await p; }
    finally { _ecdhPairPending.delete(scope); }
  }

  async function _loadOrCreateECDHPairUnsafe(scope) {
    // Preferred: keypair already in IndexedDB. Private key was stored
    // with extractable:false so it cannot be exfiltrated by XSS.
    try {
      const stored = await _idbGet(scope);
      if (stored && stored.publicKey && stored.privateKey) {
        const pair = { publicKey: stored.publicKey, privateKey: stored.privateKey };
        _ecdhPairCache.set(scope, pair);
        return pair;
      }
    } catch (e) {
      // IndexedDB unavailable (private mode / quota / etc). Fall through
      // to legacy load and finally fresh generation. We deliberately do
      // not throw here so the app still works without IDB.
      console.warn('[Crypto] IndexedDB unavailable, falling back', e);
    }

    // Legacy: keypair from older localStorage JWK layout. Import the
    // private half as non-extractable, migrate into IDB, then wipe the
    // localStorage entry so the raw JWK never persists again.
    const existingRaw = (() => {
      try { return localStorage.getItem(_ecdhStorageKey(scope)); } catch { return null; }
    })();
    if (existingRaw) {
      try {
        const parsed = JSON.parse(existingRaw);
        const publicKey = await crypto.subtle.importKey(
          'jwk',
          parsed.publicJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          []
        );
        const privateKey = await crypto.subtle.importKey(
          'jwk',
          parsed.privateJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          false, // non-extractable from here on
          ['deriveBits']
        );
        const pair = { publicKey, privateKey };
        try {
          await _idbPut(scope, { publicKey, privateKey });
          // Only purge the localStorage copy once the IDB write succeeds;
          // otherwise a quota error in IDB would brick the keypair.
          try { localStorage.removeItem(_ecdhStorageKey(scope)); } catch {}
        } catch (e2) {
          console.warn('[Crypto] IDB migration write failed; keeping legacy entry', e2);
        }
        _ecdhPairCache.set(scope, pair);
        return pair;
      } catch (e) {
        // CRITICAL: do NOT silently delete the keypair on transient import
        // failures. Doing so rotates the user's identity key and bricks
        // every previously-encrypted DM to/from this device. Surface the
        // error and refuse to generate a new one — the next page load
        // (or a deliberate "reset encryption keys" action) can recover.
        console.error('[Crypto] Failed to import existing ECDH pair; refusing to overwrite. Reload the page.', e);
        try { window._frogtalkEcdhImportError = String(e?.message || e); } catch {}
        throw new Error('ECDH keypair import failed; not regenerating to avoid losing history. Reload.');
      }
    }

    // Fresh keypair. We need an extractable public half (so it can be
    // exported to JWK and published to the server) but a non-extractable
    // private half (so XSS cannot pull it back out). Web Crypto's
    // generateKey applies one `extractable` flag to both halves of an
    // ECDH pair, so we generate with extractable=true, immediately
    // export+re-import the private side as non-extractable, and drop
    // the original extractable handle on the floor.
    const tmpPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', tmpPair.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', tmpPair.privateKey);
    const publicKey = await crypto.subtle.importKey(
      'jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []
    );
    const privateKey = await crypto.subtle.importKey(
      'jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']
    );
    const finalPair = { publicKey, privateKey };
    let idbOk = false;
    try {
      await _idbPut(scope, finalPair);
      idbOk = true;
    } catch (e) {
      // IDB write failed → fall back to (extractable) localStorage so
      // the user isn't locked out. Anything worse than this would brick
      // the device the moment IDB hiccups in private mode.
      try {
        localStorage.setItem(_ecdhStorageKey(scope), JSON.stringify({
          publicJwk,
          privateJwk,
        }));
      } catch {}
    }
    // Best-effort scrub of the transient JWK that briefly carried the
    // private scalar — only safe to do AFTER the localStorage fallback
    // (which still needs the JWK) has either succeeded or been skipped.
    if (idbOk) {
      try { for (const k of Object.keys(privateJwk)) delete privateJwk[k]; } catch {}
    }
    _ecdhPairCache.set(scope, finalPair);
    return finalPair;
  }

  // Deliberate, user-initiated key reset. Wipes the local ECDH keypair AND
  // the per-message plaintext cache so the next call to getPublicKey()
  // generates a fresh identity. Only call from a confirmed UI action.
  async function resetIdentityKey() {
    try {
      const scope = _getIdentityScope();
      _ecdhPairCache.delete(scope);
      _ecdhPairPending.delete(scope);
      try { await _idbDelete(scope); } catch {}
      try { localStorage.removeItem(_ecdhStorageKey(scope)); } catch {}
      // Wipe DM plaintext caches — old ciphertext is no longer decryptable.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('frogtalk-dm-plain-v1:')) localStorage.removeItem(k);
      }
    } catch {}
  }

  async function getPublicKey() {
    const pair = await _loadOrCreateECDHPair();
    return JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey));
  }

  async function deriveShared(peerPubKey) {
    if (!peerPubKey) return null;
    const pair = await _loadOrCreateECDHPair();
    const peerJwk = typeof peerPubKey === 'string' ? JSON.parse(peerPubKey) : peerPubKey;
    const importedPeer = await crypto.subtle.importKey(
      'jwk',
      peerJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: importedPeer },
      pair.privateKey,
      256
    );
    const digest = await crypto.subtle.digest('SHA-256', sharedBits);
    return crypto.subtle.importKey(
      'raw',
      digest,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Derive a 256-bit AES-GCM key from a passphrase + salt using PBKDF2.
   * @param {string} passphrase
   * @param {string} salt
   * @returns {Promise<CryptoKey>}
   */
  async function deriveKey(passphrase, salt) {
    const cacheKey = `${passphrase}::${salt}`;
    if (_keyCache.has(cacheKey)) return _keyCache.get(cacheKey);

    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100_000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    _keyCache.set(cacheKey, key);
    return key;
  }

  /**
   * Encrypt plaintext. Returns base64(iv + ciphertext) for legacy callers,
   * or base64(0x02 || iv || ciphertext) when an `aad` is supplied.
   *
   * The version byte lets us evolve the wire format without ambiguity:
   *   • absent / not 0x02  → legacy, no AAD bound
   *   • 0x02               → AAD-bound (caller-supplied additional data)
   *
   * AAD is NEVER transmitted with the ciphertext; sender and receiver must
   * derive it from out-of-band context (e.g. room_id + key_version), which
   * prevents an attacker from replaying a ciphertext under a different
   * room/version — AES-GCM rejects the decryption.
   *
   * @param {string} plaintext
   * @param {CryptoKey} key
   * @param {Uint8Array|string} [aad] Additional-authenticated-data. Strings
   *   are UTF-8 encoded. When provided, output is prefixed with 0x02.
   * @returns {Promise<string>}
   */
  async function encrypt(plaintext, key, aad) {
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const params = { name: 'AES-GCM', iv };
    let useV2 = false;
    if (aad != null) {
      const aadBytes = (typeof aad === 'string') ? enc.encode(aad) : aad;
      if (aadBytes && aadBytes.byteLength > 0) {
        params.additionalData = aadBytes;
        useV2 = true;
      }
    }
    const cipherBuf = await crypto.subtle.encrypt(params, key, enc.encode(plaintext));
    if (useV2) {
      const combined = new Uint8Array(1 + iv.byteLength + cipherBuf.byteLength);
      combined[0] = 0x02;
      combined.set(iv, 1);
      combined.set(new Uint8Array(cipherBuf), 1 + iv.byteLength);
      return _bytesToBase64(combined);
    }
    const combined = new Uint8Array(iv.byteLength + cipherBuf.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipherBuf), iv.byteLength);
    return _bytesToBase64(combined);
  }

  /**
   * Decrypt a base64-encoded encrypted message.
   *
   * Detects the wire format from the leading byte:
   *   • 0x02 → strip prefix, treat next 12 bytes as IV, bind AAD on verify
   *   • else → legacy: first 12 bytes IV, rest ciphertext, no AAD
   *
   * If `aad` is supplied on a legacy (non-prefixed) ciphertext the caller
   * is asserting they expect v2 — we still attempt the legacy decode as a
   * fallback so a single mixed-version channel keeps rendering during the
   * migration window.
   *
   * @param {string} b64
   * @param {CryptoKey} key
   * @param {Uint8Array|string} [aad]
   * @returns {Promise<string|null>}
   */
  async function decrypt(b64, key, aad) {
    let aadBytes = null;
    if (aad != null) {
      aadBytes = (typeof aad === 'string') ? new TextEncoder().encode(aad) : aad;
    }
    try {
      const bytes = _base64ToBytes(b64);
      // v2: leading 0x02 marker + 12-byte IV + ciphertext+tag (>= 1+12+16 = 29 bytes)
      if (bytes.length >= 29 && bytes[0] === 0x02) {
        const iv = bytes.slice(1, 13);
        const data = bytes.slice(13);
        const params = { name: 'AES-GCM', iv };
        if (aadBytes && aadBytes.byteLength > 0) params.additionalData = aadBytes;
        try {
          const plainBuf = await crypto.subtle.decrypt(params, key, data);
          return new TextDecoder().decode(plainBuf);
        } catch {
          // Fall through to legacy attempt in case the leading byte was a
          // random IV that happened to equal 0x02 on an old message.
        }
      }
      const iv = bytes.slice(0, 12);
      const data = bytes.slice(12);
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
      return new TextDecoder().decode(plainBuf);
    } catch {
      return null; // wrong key or not encrypted
    }
  }

  async function encryptPayload(payload, key, aad) {
    if (!payload || !key) return payload;
    return `${_payloadPrefix}${await encrypt(payload, key, aad)}`;
  }

  async function decryptPayload(payload, key, aad) {
    if (!payload || typeof payload !== 'string') return payload;
    if (!payload.startsWith(_payloadPrefix)) return payload;
    if (!key) return null;
    return decrypt(payload.slice(_payloadPrefix.length), key, aad);
  }

  /**
   * Get (or create) the room key based on passphrase stored in sessionStorage.
   * The passphrase for public rooms is the room name itself (no user secret) —
   * so all members can read them by default.
   * Private rooms require a shared secret the user provides on join.
   * @param {string} roomName
   * @param {string} [secret] - optional extra passphrase for private rooms
   * @returns {Promise<CryptoKey>}
   */
  async function getRoomKey(roomName, secret = '') {
    const passphrase = secret || `frogtalk-public-${roomName}`;
    return deriveKey(passphrase, `room:${roomName}`);
  }

  /**
   * Get a DM key from both party's nicknames + a shared passphrase.
   * The key is symmetric: dm(alice, bob) === dm(bob, alice)
   * @param {string} userA
   * @param {string} userB
   * @param {string} [secret]
   * @returns {Promise<CryptoKey>}
   */
  async function getDMKey(userA, userB, secret = '') {
    const sorted = [userA, userB].sort().join(':');
    const passphrase = secret || `frogtalk-dm-${sorted}`;
    return deriveKey(passphrase, `dm:${sorted}`);
  }

  /**
   * DEPRECATED — kept only to avoid breaking older cached UI code paths.
   *
   * This function derives 4 emoji from the sorted lowercase nickname
   * pair (SHA-256 of `"frogtalk-fingerprint-v1::" + sorted`). It does
   * NOT bind to any cryptographic identity key — two users with the
   * same nickname pair will always see the same emojis even if the
   * underlying identity keys were swapped by an active MITM. It also
   * collides trivially when a nickname is reused.
   *
   * The DM verification modal now shows ONLY the Signal-compatible
   * 60-digit safety number (`Signal.safetyNumberWith`) which is
   * derived from sort(identity_key_A || identity_key_B). New code
   * MUST NOT rely on `Crypto.fingerprint` for any security claim.
   *
   * @deprecated Use `Signal.safetyNumberWith(peerUserId)` instead.
   * @param {string} userA
   * @param {string} userB
   * @returns {Promise<string[]>} array of 4 emoji characters
   */
  async function fingerprint(userA, userB) {
    const PALETTE = [
      '🐸','🦊','🐻','🐼','🐨','🦁','🐯','🐵','🐷','🐮','🐔','🐧','🐦','🦄','🐴','🐺',
      '🦉','🦅','🦆','🐢','🐍','🦎','🐙','🐳','🐬','🦈','🐠','🐡','🐌','🦋','🐝','🐞',
      '🌸','🌻','🌹','🌷','🌼','🌵','🌲','🌴','🍀','🍁','🍄','🍇','🍉','🍊','🍋','🍌',
      '🍎','🍐','🍑','🍓','🫐','🍒','🥝','🥥','🥑','🌶️','🌽','🥕','🍞','🧀','🥨','🍕',
      '🍔','🌮','🌯','🥗','🍿','🍩','🍪','🍰','🎂','🍫','🍬','🍭','🍮','🍯','🧁','☕',
      '🍵','🧋','🥤','🍷','🍺','⚽','🏀','🏈','🎾','🏐','🎱','🏓','🏸','🥊','🎣','🎮',
      '🎲','🎯','🎳','🎸','🎺','🎷','🥁','🎹','🎻','🎤','🎧','🎨','🎭','🎬','🚗','🚕',
      '🚌','🚑','🚒','🚜','🏎️','🚂','🚀','🛸','🚁','⛵','🛶','⚓','🗿','🗽','🏰','🗻',
      '🌋','⛰️','🏖️','🌅','🌆','🌈','☀️','🌙','⭐','🌟','⚡','🔥','💧','🌊','❄️','☃️',
      '🎃','🎄','🎁','🎈','🎉','🎊','🔮','💎','💰','🔑','🔒','🗝️','⚔️','🛡️','🏆','🏅',
      '🎖️','🎗️','🎀','🔔','📯','📻','📱','☎️','📷','📸','🎥','📺','💻','🖥️','⌨️','🖱️',
      '💾','📀','💿','🕹️','📚','📖','📰','📝','📎','📌','📍','📅','📊','💡','🔦','🕯️',
      '🧭','⏰','⌛','🧲','🧪','🧬','🔭','🔬','🧯','🪐','👻','👽','🤖','👹','👺','💀',
      '👾','🐲','🐉','🦖','🦕','🦀','🦞','🦑','🦐','🌮','🥟','🍣','🍤','🍙','🍚','🍜',
      '🫕','🍦','🍨','🥮','🫘','🧂','🧈','🥐','🥖','🥞','🧇','🥓','🍖','🍗','🥩','🦴',
      '🥚','🥪','🌭','🍝','🥘','🥫','🍲','🫗','🍹','🍸','🥂','🍾','🥃','🥛','🧊','🍻'
    ];
    const enc = new TextEncoder();
    const sorted = [userA, userB].map(s => String(s || '').toLowerCase()).sort().join(':');
    const material = enc.encode(`frogtalk-fingerprint-v1::${sorted}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
    // Take 4 bytes, mod into palette
    const size = PALETTE.length;
    return [digest[0] % size, digest[7] % size, digest[14] % size, digest[21] % size]
      .map(i => PALETTE[i]);
  }

  // Short fingerprint of THIS device's ECDH public key. Useful for showing
  // "this device" identity in the encryption-info modal so users can tell
  // multi-device situations apart.
  async function publicKeyFingerprint() {
    try {
      const pair = await _loadOrCreateECDHPair();
      const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
      const enc = new TextEncoder();
      const buf = await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(jwk)));
      const bytes = new Uint8Array(buf);
      const hex = Array.from(bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
      return hex.toUpperCase().match(/.{1,4}/g).join(' ');
    } catch { return ''; }
  }

  return { encrypt, decrypt, encryptPayload, decryptPayload, getRoomKey, getDMKey, fingerprint, getPublicKey, deriveShared, resetIdentityKey, publicKeyFingerprint };
})();
