// static/js/wall_crypto.js — Track D (encrypted wall posts).
//
// Public API exposed on `window.WallCrypto`:
//
//   await WallCrypto.publish({
//     audience: 'followers' | 'friends' | 'list:<id>',
//     content, mediaData?, mediaType?,
//     trackTitle?, trackRoom?, trackMood?,
//     shareEnabled?, allowComments?,
//   }) → { id, enc_v: 2, audience, recipients, created_at }
//
//   await WallCrypto.decryptInline(post) → mutates `post.content`,
//     `post.media_data`, `post.media_type`, `post.track_*` in place.
//     For enc_v != 2 posts this is a no-op. For enc_v=2 posts where
//     decryption fails the post is annotated with `_decryptError`.
//
// Crypto: per-post random AES-256-GCM payload key + 12-byte nonce;
// payload key is wrapped per-recipient through that user's Signal
// session (via Signal.encryptDM). Ciphertext layout is `nonce || ct`.
// The wrap is the JSON envelope from Signal.encryptDM, serialized to
// UTF-8 bytes (so the server only sees opaque BLOBs).
//
// Theme: no UI in this file; UI lives in social.js / ui.js and uses
// FrogTalk theme tokens already in place.
(function () {
  'use strict';

  const TEXT_ENC = new TextEncoder();
  const TEXT_DEC = new TextDecoder();

  function _b64encode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function _b64decode(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function _aesEncrypt(keyBytes, plaintextBytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, plaintextBytes));
    // Pack as nonce || ciphertext.
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv, 0);
    out.set(ct, iv.length);
    return out;
  }

  async function _aesDecrypt(keyBytes, packed) {
    if (packed.length < 13) throw new Error('ciphertext too short');
    const iv = packed.subarray(0, 12);
    const ct = packed.subarray(12);
    const key = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, key, ct));
  }

  // The Signal envelope is the JSON `{v,t,b}` object returned by
  // Signal.encryptDM. We serialise it as UTF-8 JSON for storage.
  function _wrapEnvelopeToBytes(env) {
    return TEXT_ENC.encode(JSON.stringify(env));
  }
  function _bytesToWrapEnvelope(bytes) {
    return JSON.parse(TEXT_DEC.decode(bytes));
  }

  async function _fetchRecipients(audience) {
    const res = await apiFetch(
      `/api/wall/audience-recipients?audience=${encodeURIComponent(audience)}`);
    if (!res.ok) throw new Error('Could not load audience (' + res.status + ')');
    return await res.json();   // { recipients: [{user_id, nickname}], count }
  }

  async function publish(opts) {
    if (!window.Signal || typeof Signal.isReady !== 'function' || !Signal.isReady()) {
      throw new Error('Encryption not ready. Try again in a moment.');
    }
    const aud = String(opts.audience || '').toLowerCase();
    if (aud === 'public' || aud === 'private') {
      throw new Error('publish() is for encrypted audiences only');
    }

    // 1. Load the recipient set from the server.
    const info = await _fetchRecipients(aud);
    const recips = (info.recipients || []);
    if (recips.length === 0) {
      throw new Error(
        aud === 'followers'
          ? 'No followers to share with yet.'
          : aud === 'friends'
            ? 'No friends to share with yet.'
            : 'Nobody to share with in this audience.');
    }

    // 2. Build the plaintext payload — only fields the server would
    //    otherwise see in cleartext. Media (`media_data`) stays in the
    //    plaintext column on the server until Phase 3, so we don't
    //    duplicate it inside the encrypted blob.
    const payload = {
      v: 1,
      content: opts.content || '',
      track_title: opts.trackTitle || null,
      track_room: opts.trackRoom || null,
      track_mood: opts.trackMood || null,
    };
    const ptBytes = TEXT_ENC.encode(JSON.stringify(payload));

    // 3. Encrypt under a fresh per-post AES-256-GCM payload key.
    const payloadKey = crypto.getRandomValues(new Uint8Array(32));
    const ctBytes = await _aesEncrypt(payloadKey, ptBytes);
    const ciphertextB64 = _b64encode(ctBytes);

    // 4. Wrap the payload key once per recipient through Signal.
    const wrapped = [];
    const failed = [];
    for (const r of recips) {
      try {
        const env = await Signal.encryptDM(r.user_id, _b64encode(payloadKey));
        const wrapBytes = _wrapEnvelopeToBytes(env);
        wrapped.push({
          recipient_id: r.user_id,
          wrapped_b64: _b64encode(wrapBytes),
        });
      } catch (e) {
        failed.push(r.nickname || r.user_id);
        // Silent skip — server will still publish to whoever we could
        // wrap. UI surfaces the count via the returned object.
      }
    }
    if (wrapped.length === 0) {
      throw new Error('Could not establish a Signal session with any recipient.');
    }

    // 5. POST.
    const res = await apiFetch('/api/wall/posts/encrypted', 'POST', {
      audience: aud,
      ciphertext_b64: ciphertextB64,
      wrapped_keys: wrapped,
      media_data: opts.mediaData || null,
      media_type: opts.mediaType || null,
      share_enabled: opts.shareEnabled !== false,
      allow_comments: opts.allowComments !== false,
      track_title: opts.trackTitle || null,
      track_room: opts.trackRoom || null,
      track_mood: opts.trackMood || null,
    });
    if (!res.ok) {
      let err = {};
      try { err = await res.json(); } catch {}
      throw new Error(err.error || ('Server error ' + res.status));
    }
    const body = await res.json();
    body._wrapped = wrapped.length;
    body._wrap_failed = failed;
    // Stash the payload key locally so the author can decrypt their own
    // post in the feed without a wrap row on the server.
    try {
      _authorKeyCache.set(body.id, _b64encode(payloadKey));
      _persistAuthorKeys();
    } catch {}
    return body;
  }

  // Author-side cache: post_id → b64 payload key. Persists for the
  // session only; on reload the author re-fetches via the server.
  // Phase 3 will sync this to a backup table so authors can decrypt
  // their own history across reloads/devices.
  const _authorKeyCache = new Map();
  try {
    const stored = sessionStorage.getItem('ft_wall_keys');
    if (stored) {
      const obj = JSON.parse(stored);
      for (const k of Object.keys(obj)) _authorKeyCache.set(Number(k), obj[k]);
    }
  } catch {}
  function _persistAuthorKeys() {
    try {
      const obj = {};
      for (const [k, v] of _authorKeyCache) obj[k] = v;
      sessionStorage.setItem('ft_wall_keys', JSON.stringify(obj));
    } catch {}
  }

  async function decryptInline(post) {
    if (!post || post.enc_v !== 2) return post;
    if (!post.ciphertext_b64) return post;

    let payloadKeyBytes = null;
    try {
      const myId = (window.State && State.user && State.user.id) || 0;
      const authorId = post.user_id;
      if (authorId === myId) {
        // Author: use the local cache.
        const b64 = _authorKeyCache.get(Number(post.id));
        if (!b64) {
          post._decryptError = 'no_local_key';
          return post;
        }
        payloadKeyBytes = _b64decode(b64);
      } else {
        if (!post.wrapped_key_b64) {
          post._decryptError = 'no_wrap';
          return post;
        }
        if (!window.Signal || typeof Signal.isReady !== 'function' || !Signal.isReady()) {
          post._decryptError = 'signal_not_ready';
          return post;
        }
        const env = _bytesToWrapEnvelope(_b64decode(post.wrapped_key_b64));
        const payloadKeyB64 = await Signal.decryptDM(authorId, env);
        payloadKeyBytes = _b64decode(payloadKeyB64);
      }
      const ctBytes = _b64decode(post.ciphertext_b64);
      const ptBytes = await _aesDecrypt(payloadKeyBytes, ctBytes);
      const payload = JSON.parse(TEXT_DEC.decode(ptBytes));
      if (payload && typeof payload === 'object') {
        post.content    = payload.content || '';
        // media_data / media_type come from the plaintext server
        // columns (see CreateEncryptedPostRequest). Don't clobber.
        post.track_title = post.track_title || payload.track_title || null;
        post.track_room  = post.track_room  || payload.track_room  || null;
        post.track_mood  = post.track_mood  || payload.track_mood  || null;
      }
      // Strip the encrypted blobs from the in-memory object so
      // downstream renderers can treat the post as plaintext.
      delete post.ciphertext_b64;
      delete post.wrapped_key_b64;
    } catch (e) {
      post._decryptError = (e && e.message) || 'decrypt_failed';
    }
    return post;
  }

  async function decryptList(posts) {
    if (!Array.isArray(posts)) return posts;
    // Sequential — sessions through libsignal aren't thread-safe.
    for (const p of posts) {
      await decryptInline(p);
    }
    return posts;
  }

  function rememberAuthorKey(postId, payloadKeyB64) {
    _authorKeyCache.set(Number(postId), String(payloadKeyB64));
    _persistAuthorKeys();
  }

  window.WallCrypto = {
    publish,
    decryptInline,
    decryptList,
    rememberAuthorKey,
  };
})();
