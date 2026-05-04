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
    const existingRaw = localStorage.getItem(_ecdhStorageKey(scope));
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
          false,
          ['deriveBits']
        );
        const pair = { publicKey, privateKey };
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

    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    localStorage.setItem(_ecdhStorageKey(scope), JSON.stringify({ publicJwk, privateJwk }));
    _ecdhPairCache.set(scope, pair);
    return pair;
  }

  // Deliberate, user-initiated key reset. Wipes the local ECDH keypair AND
  // the per-message plaintext cache so the next call to getPublicKey()
  // generates a fresh identity. Only call from a confirmed UI action.
  async function resetIdentityKey() {
    try {
      const scope = _getIdentityScope();
      _ecdhPairCache.delete(scope);
      _ecdhPairPending.delete(scope);
      localStorage.removeItem(_ecdhStorageKey(scope));
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
   * Encrypt plaintext. Returns base64(iv + ciphertext).
   * @param {string} plaintext
   * @param {CryptoKey} key
   * @returns {Promise<string>}
   */
  async function encrypt(plaintext, key) {
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, enc.encode(plaintext)
    );
    const combined = new Uint8Array(iv.byteLength + cipherBuf.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipherBuf), iv.byteLength);
    return _bytesToBase64(combined);
  }

  /**
   * Decrypt a base64-encoded encrypted message.
   * @param {string} b64
   * @param {CryptoKey} key
   * @returns {Promise<string|null>}
   */
  async function decrypt(b64, key) {
    try {
      const bytes = _base64ToBytes(b64);
      const iv = bytes.slice(0, 12);
      const data = bytes.slice(12);
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
      return new TextDecoder().decode(plainBuf);
    } catch {
      return null; // wrong key or not encrypted
    }
  }

  async function encryptPayload(payload, key) {
    if (!payload || !key) return payload;
    return `${_payloadPrefix}${await encrypt(payload, key)}`;
  }

  async function decryptPayload(payload, key) {
    if (!payload || typeof payload !== 'string') return payload;
    if (!payload.startsWith(_payloadPrefix)) return payload;
    if (!key) return null;
    return decrypt(payload.slice(_payloadPrefix.length), key);
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
   * Telegram-style emoji fingerprint for DM key verification.
   * Both peers compute identical output because it derives only from the
   * sorted lowercase nickname pair, which is also how the DM AES key is
   * seeded. If two users see the same 4 emojis, nobody is MITMing them.
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
