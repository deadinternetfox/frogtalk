/**
 * rooms.js — Channel & DM management
 */

const Rooms = (() => {
  let _selectedRoomType = 'public';
  let _selectedChannelType = 'text';  // text or voice
  let _settingsChannelType = 'text';
  let _currentSettingsRoom = null;
  let _currentRoomData = null;
  const ROOM_ICON_MAX_BYTES = 2 * 1024 * 1024;
  const ROOM_SECRET_PREFIX = 'ft-room-secret-v1:';
  // Pointer key per room → current localStorage key version. When the
  // pointer is missing the room is treated as v1 with the legacy unsuffixed
  // secret (auto-migrated on first read).
  const ROOM_KEYVER_PREFIX = 'ft-room-keyver:';
  let _secretPromptResolver = null;

  function _roomSecretStorageKey(name, version) {
    const base = `${ROOM_SECRET_PREFIX}${String(name || '').toLowerCase()}`;
    if (version && Number.isFinite(version) && version > 0) {
      return `${base}:v${version}`;
    }
    return base;
  }

  function _roomKeyVersionStorageKey(name) {
    return `${ROOM_KEYVER_PREFIX}${String(name || '').toLowerCase()}`;
  }

  function _getStoredKeyVersion(name) {
    try {
      const raw = localStorage.getItem(_roomKeyVersionStorageKey(name));
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch { return 0; }
  }

  function _setStoredKeyVersion(name, version) {
    try {
      if (version && version > 0) {
        localStorage.setItem(_roomKeyVersionStorageKey(name), String(version));
      }
    } catch {}
  }

  /**
   * Read the room secret for a specific key version, with backward-compat:
   *   • version omitted / 0 → legacy unsuffixed slot
   *   • version ≥ 1 → versioned slot; falls back to migrating the legacy
   *     slot to v1 on first access so existing users keep working without
   *     a re-key prompt.
   */
  function _getStoredRoomSecret(name, version) {
    try {
      if (version && version > 0) {
        const v = localStorage.getItem(_roomSecretStorageKey(name, version));
        if (v) return v;
        // Migration: if we have a legacy secret and the caller asked for v1,
        // promote the legacy slot in-place so subsequent fetches hit fast.
        if (version === 1) {
          const legacy = localStorage.getItem(_roomSecretStorageKey(name));
          if (legacy) {
            try { localStorage.setItem(_roomSecretStorageKey(name, 1), legacy); } catch {}
            return legacy;
          }
        }
        return '';
      }
      return localStorage.getItem(_roomSecretStorageKey(name)) || '';
    } catch {
      return '';
    }
  }

  function _storeRoomSecret(name, secret, version) {
    try {
      if (secret) {
        localStorage.setItem(_roomSecretStorageKey(name), secret);
        if (version && version > 0) {
          localStorage.setItem(_roomSecretStorageKey(name, version), secret);
          _setStoredKeyVersion(name, version);
        }
      } else {
        localStorage.removeItem(_roomSecretStorageKey(name));
      }
    } catch {}
  }

  function toggleSecretVisibility(inputId, buttonId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(buttonId);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    if (btn) {
      btn.textContent = show ? '🙈' : '👁️';
      btn.setAttribute('aria-label', show ? 'Hide shared secret' : 'Show shared secret');
      btn.setAttribute('title', show ? 'Hide shared secret' : 'Show shared secret');
    }
  }

  function _closePrivateSecretModal() {
    const input = document.getElementById('room-secret-input');
    if (input) {
      input.onkeydown = null;
      input.value = '';
      input.type = 'password';
    }
    const toggle = document.getElementById('room-secret-toggle');
    if (toggle) {
      toggle.textContent = '👁️';
      toggle.setAttribute('aria-label', 'Show shared secret');
      toggle.setAttribute('title', 'Show shared secret');
    }
    const hint = document.getElementById('room-secret-hint');
    if (hint) {
      hint.style.display = 'none';
      hint.textContent = '';
    }
    closeModal('modal-room-secret');
  }

  function cancelPrivateSecretPrompt() {
    const resolve = _secretPromptResolver;
    _secretPromptResolver = null;
    _closePrivateSecretModal();
    if (resolve) resolve(undefined);
  }

  function submitPrivateSecretPrompt() {
    const input = document.getElementById('room-secret-input');
    const rememberEl = document.getElementById('room-secret-remember');
    const resolve = _secretPromptResolver;
    if (!resolve) return;
    const secret = (input?.value || '').trim();
    if (!secret) {
      UI.showToast('Private rooms require a shared secret', 'error');
      input?.focus();
      return;
    }
    _secretPromptResolver = null;
    _closePrivateSecretModal();
    resolve({ secret, remember: !!rememberEl?.checked });
  }

  function _promptPrivateRoomSecret(name, hintText) {
    return new Promise((resolve) => {
      _secretPromptResolver = resolve;
      const roomNameEl = document.getElementById('room-secret-room-name');
      const hintEl = document.getElementById('room-secret-hint');
      const input = document.getElementById('room-secret-input');
      const rememberEl = document.getElementById('room-secret-remember');

      if (roomNameEl) roomNameEl.textContent = `Channel: #${name}`;
      if (hintEl) {
        const h = (hintText || '').trim();
        if (h) {
          hintEl.textContent = `Hint: ${h}`;
          hintEl.style.display = '';
        } else {
          hintEl.textContent = '';
          hintEl.style.display = 'none';
        }
      }
      if (rememberEl) rememberEl.checked = true;
      if (input) {
        input.value = '';
        input.onkeydown = (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submitPrivateSecretPrompt();
          }
        };
      }
      openModal('modal-room-secret');
      setTimeout(() => input?.focus(), 30);
    });
  }

  async function _resolvePrivateRoomKey(name) {
    const room = (State.rooms || []).find(r => r.name === name) || null;
    const srvVer = Math.max(1, parseInt(room?.room_key_version, 10) || 1);
    // Try the per-version slot first; fall back to legacy unsuffixed.
    let secret = _getStoredRoomSecret(name, srvVer);
    if (!secret) secret = _getStoredRoomSecret(name);
    if (!secret) {
      const entered = await _promptPrivateRoomSecret(name, room?.room_key_hint || '');
      if (!entered) return undefined;
      secret = entered.secret;
      if (!secret) {
        UI.showToast('Private rooms require a shared secret', 'error');
        return undefined;
      }
      if (entered.remember) _storeRoomSecret(name, secret, srvVer);
    } else {
      // Promote into the versioned slot if we only had a legacy copy, so
      // future loads skip the fallback path and per-version decryption
      // (for messages encrypted under srvVer) just works.
      try {
        if (!localStorage.getItem(_roomSecretStorageKey(name, srvVer))) {
          localStorage.setItem(_roomSecretStorageKey(name, srvVer), secret);
          _setStoredKeyVersion(name, srvVer);
        }
      } catch {}
    }
    return Crypto.getRoomKey(name, secret);
  }

  // ─── Key rotation (Phase 2 #3, #4) ───────────────────────────────────
  // AAD bound to room_id + key_version so a ciphertext from one version can
  // never be replayed under another. Public rooms aren't E2EE — caller
  // must only invoke these for private rooms.
  function _aadForRoom(roomId, version) {
    if (!roomId || !version) return null;
    return `room:${roomId}:v${version}`;
  }

  /**
   * Return a CryptoKey for the secret stored at a specific version,
   * or null if no secret is stored for that version. Used by the decrypt
   * path to pick the right historical key for an old message.
   */
  async function _getRoomKeyForVersion(name, version) {
    if (!name) return null;
    const v = parseInt(version, 10) || 0;
    let secret = '';
    if (v > 0) secret = _getStoredRoomSecret(name, v);
    if (!secret) secret = _getStoredRoomSecret(name);
    if (!secret) return null;
    try { return await Crypto.getRoomKey(name, secret); } catch { return null; }
  }

  function _b64FromBytes(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  /**
   * Install a rotated room secret received via Signal-DM fanout. Idempotent:
   * the same envelope can be delivered twice (e.g. WS reconnect race) and
   * the second install is a no-op. We never DOWNGRADE — if we already hold
   * a higher version, the older envelope is ignored.
   *
   * Triggered from ws.js on incoming `room_key_envelope`. The envelope is
   * the raw Signal v2 envelope JSON; this helper handles the Signal decrypt
   * before persisting.
   */
  async function installRotatedKey({ room, version, env, from_user_id, from_nickname }) {
    if (!room || !version || !env) return false;
    const v = parseInt(version, 10) || 0;
    if (v <= 0) return false;
    // Don't downgrade.
    const cur = _getStoredKeyVersion(room);
    if (cur && cur >= v && _getStoredRoomSecret(room, v)) return true;
    if (!window.Signal || typeof Signal.decryptDM !== 'function') {
      console.warn('[rooms] installRotatedKey: Signal not ready');
      return false;
    }
    let envObj = env;
    if (typeof env === 'string') {
      try { envObj = JSON.parse(env); } catch { envObj = null; }
    }
    if (!envObj) return false;
    let plain;
    try {
      plain = await Signal.decryptDM(from_user_id, envObj);
    } catch (e) {
      console.warn('[rooms] room_key_envelope decrypt failed', e);
      return false;
    }
    if (!plain) return false;
    let payload;
    try { payload = JSON.parse(plain); } catch { return false; }
    if (!payload || payload.__ft_rkey !== 1) return false;
    // The rotator can't know the final server-assigned version when it builds
    // the envelope, so payload.version is informational only. Trust the server
    // version from the WS frame and just verify the room matches.
    if (payload.room !== room) return false;
    const secret = String(payload.secret || '');
    if (!secret) return false;
    try {
      localStorage.setItem(_roomSecretStorageKey(room, v), secret);
      localStorage.setItem(_roomSecretStorageKey(room), secret); // current pointer
      _setStoredKeyVersion(room, v);
    } catch {}
    // Bump the cached room metadata so encrypts immediately use the new
    // version without waiting for a /api/rooms refresh.
    try {
      const r = (State.rooms || []).find(x => x.name === room);
      if (r) r.room_key_version = v;
      if (State.roomKeys && State.roomKeys[room] != null) {
        // Force re-derivation on next access.
        State.roomKeys[room] = await Crypto.getRoomKey(room, secret);
      }
    } catch {}
    try {
      const who = from_nickname ? `@${from_nickname}` : 'a moderator';
      UI.showToast(`🔄 Room key updated by ${who}`, 'info');
    } catch {}
    return true;
  }

  /**
   * Generate a fresh room secret, fan it out via Signal DM envelopes to
   * every current member, and bump the server's key_version. Invoked
   * either manually (settings → "Rotate room key") or automatically by
   * ws.js when the server sends `room_should_rotate` after a ban.
   *
   * For private rooms only — bridge rooms are blocked at the bridge
   * endpoint, so private rooms by construction have no bridges.
   */
  async function rotateRoomKey(roomName, { reason = 'manual', targetUserId = null, targetNickname = null, silent = false } = {}) {
    if (!roomName) return false;
    const room = (State.rooms || []).find(r => r.name === roomName) || null;
    if (!room) {
      try { UI.showToast('Room not found', 'error'); } catch {}
      return false;
    }
    if ((room.type || 'public') !== 'private') {
      try { UI.showToast('Only private rooms can rotate keys', 'error'); } catch {}
      return false;
    }
    if (!window.Signal || !window.Signal.isReady || !window.Signal.isReady()) {
      try {
        if (window.Signal && typeof Signal.ensureReady === 'function') {
          await Signal.ensureReady(State.user && State.user.id);
        }
      } catch {}
      if (!window.Signal || !Signal.isReady || !Signal.isReady()) {
        try { UI.showToast('Encryption layer not ready — try again', 'error'); } catch {}
        return false;
      }
    }

    // Fetch fresh members list (don't rely on a cached sidebar).
    let members = [];
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/members`, { credentials: 'same-origin' });
      if (r.ok) {
        const d = await r.json();
        members = Array.isArray(d.members) ? d.members : [];
      }
    } catch {}
    const myId = State.user?.id;
    // Drop self + freshly-banned user from the recipient list. The banned
    // user is already on members until the next refresh, so filter by id.
    const recipients = members.filter(m => {
      const uid = parseInt(m.user_id, 10);
      if (!uid) return false;
      if (myId && uid === parseInt(myId, 10)) return false;
      if (targetUserId && uid === parseInt(targetUserId, 10)) return false;
      return true;
    });

    // Generate a fresh 32-byte secret, base64-encode for transport.
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const secretB64 = _b64FromBytes(raw);

    // Encrypt one envelope per recipient via their Signal session.
    const envelopes = {};
    let failedPeers = 0;
    for (const m of recipients) {
      const uid = parseInt(m.user_id, 10);
      try {
        // Make sure we have a session (handles peer-identity drift too).
        if (typeof Signal.ensureSessionWith === 'function') {
          try { await Signal.ensureSessionWith(uid); } catch {}
        }
        const env = await Signal.encryptDM(uid, JSON.stringify({
          __ft_rkey: 1,
          room: roomName,
          version: 0,         // server fills in the new version on POST; client computes locally below
          secret: secretB64,
        }));
        envelopes[String(uid)] = JSON.stringify(env);
      } catch (e) {
        failedPeers += 1;
        console.warn('[rooms] rotate: encrypt to', uid, 'failed', e);
      }
    }

    // POST to /rotate — server increments key_version, fans out envelopes,
    // inserts the system message, and broadcasts to the room.
    let resp;
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/rotate`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason,
          target_user_id: targetUserId || null,
          target_nickname: targetNickname || null,
          envelopes,
        }),
      });
      if (!r.ok) {
        try { UI.showToast('Could not rotate room key', 'error'); } catch {}
        return false;
      }
      resp = await r.json();
    } catch (e) {
      console.error('[rooms] rotate POST failed', e);
      try { UI.showToast('Network error rotating key', 'error'); } catch {}
      return false;
    }

    const newVer = parseInt(resp.version, 10) || 0;
    if (newVer <= 0) {
      try { UI.showToast('Server rejected rotation', 'error'); } catch {}
      return false;
    }
    // Persist locally under the new version.
    try {
      localStorage.setItem(_roomSecretStorageKey(roomName, newVer), secretB64);
      localStorage.setItem(_roomSecretStorageKey(roomName), secretB64);
      _setStoredKeyVersion(roomName, newVer);
      room.room_key_version = newVer;
      // Drop any cached derived key so the next encrypt picks up the new
      // secret. messages.js re-derives via Rooms helpers below.
      if (State.roomKeys) State.roomKeys[roomName] = await Crypto.getRoomKey(roomName, secretB64);
    } catch {}

    if (!silent) {
      const delivered = parseInt(resp.delivered, 10) || 0;
      const total = recipients.length;
      const tail = failedPeers ? ` (${failedPeers} peer${failedPeers === 1 ? '' : 's'} unreachable)` : '';
      try {
        UI.showToast(`🔄 Room key rotated · sent to ${delivered}/${total} member${total === 1 ? '' : 's'}${tail}`, 'success');
      } catch {}
    }
    return true;
  }

  function isImageIcon(icon) {
    if (!icon || typeof icon !== 'string') return false;
    return isSafeCssImageUrl(icon);
  }

  function isSafeCssImageUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return false;
    if (/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(s)) return true;
    if (/^https?:\/\//i.test(s)) {
      if (s.length > 2048) return false;
      if (/[)\\\s'"<>]/.test(s)) return false;
      return true;
    }
    if (s.startsWith('/')) {
      if (s.length > 2048) return false;
      return /^\/[A-Za-z0-9._\-/?=&%]+$/.test(s);
    }
    return false;
  }

  function defaultIconForType(type, channelType = 'text') {
    if (channelType === 'voice') return '🔊';
    return type === 'private' ? '🔒' : '#';
  }

  function roomIconHtml(icon, type, className = 'ch-icon', channelType = 'text') {
    const safeIcon = (icon || '').trim();
    if (isImageIcon(safeIcon)) {
      return `<span class="${className} is-image"><img src="${UI.escHtml(safeIcon)}" alt="Room icon"></span>`;
    }
    const renderedIcon = safeIcon || defaultIconForType(type, channelType);
    const fallbackHashClass = (!safeIcon && renderedIcon === '#') ? ' is-fallback-hash' : '';
    return `<span class="${className}${fallbackHashClass}">${UI.escHtml(renderedIcon)}</span>`;
  }

  function setRoomHeader(name, type, roomIcon = null, dmPeer = null, channelType = 'text') {
    const titleEl = document.getElementById('ch-title');
    const iconMarkup = type === 'dm'
      ? '<span class="room-title-icon">💬</span>'
      : `<button class="room-title-icon-btn" type="button" title="Open channel info" onclick="event.stopPropagation();Rooms.showChannelAbout('${UI.escHtml(name)}')">${roomIconHtml(roomIcon, type, 'room-title-icon', channelType)}</button>`;
    titleEl.innerHTML = `${iconMarkup}<span class="room-title-text" data-room-name="${UI.escHtml(name)}" title="Long-press for settings" style="cursor:pointer">${UI.escHtml(name)}</span>`;
    // Long-press / right-click on channel header (icon + name) → open settings (if permitted)
    const txt = titleEl.querySelector('.room-title-text');
    const iconBtn = titleEl.querySelector('.room-title-icon-btn');
    if (type !== 'dm') {
      const tryOpenSettings = () => {
        const rn = (txt && txt.dataset.roomName) || name;
        try { openChannelSettings(rn); } catch {}
      };
      const bind = (el) => {
        if (!el) return;
        let pressTimer = null;
        let longFired = false;
        el.addEventListener('pointerdown', () => {
          longFired = false;
          if (pressTimer) clearTimeout(pressTimer);
          pressTimer = setTimeout(() => { pressTimer = null; longFired = true; tryOpenSettings(); }, 550);
        });
        const cancel = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
        el.addEventListener('pointerup', cancel);
        el.addEventListener('pointerleave', cancel);
        el.addEventListener('pointercancel', cancel);
        el.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); tryOpenSettings(); });
        // Suppress the normal click (e.g. icon → about) if a long-press just fired
        el.addEventListener('click', (e) => {
          if (longFired) { e.preventDefault(); e.stopPropagation(); longFired = false; }
        }, true);
      };
      bind(txt);
      bind(iconBtn);
    }

    const input = document.getElementById('msg-input');
    input.placeholder = type === 'dm' ? `Message @${dmPeer || name}` : `Message #${name}`;
  }

  function setRoomIconPreview(elId, icon, roomType = 'public', channelType = 'text') {
    const el = document.getElementById(elId);
    if (!el) return;
    const safeIcon = (icon || '').trim();
    if (isImageIcon(safeIcon)) {
      el.classList.add('is-image');
      el.innerHTML = `<img src="${UI.escHtml(safeIcon)}" alt="Room icon">`;
      return;
    }
    el.classList.remove('is-image');
    el.textContent = safeIcon || defaultIconForType(roomType, channelType);
  }

  async function readRoomIconFile(file) {
    if (!file) return null;
    if (!file.type.startsWith('image/')) {
      UI.showToast('Please choose an image file', 'error');
      return null;
    }
    if (file.size > ROOM_ICON_MAX_BYTES) {
      UI.showToast('Room image too large (max 2MB)', 'error');
      return null;
    }
    return await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  function triggerRoomIconUpload(kind) {
    const id = kind === 'create' ? 'new-room-icon-file' : 'ch-settings-icon-file';
    document.getElementById(id)?.click();
  }

  async function handleCreateRoomIconSelect(input) {
    const file = input?.files?.[0];
    if (!file) return;
    // Offer cropping (square). Falls back to the raw data URL if cropper unavailable.
    const finish = (dataUrl) => {
      const iconInput = document.getElementById('new-room-icon-input');
      iconInput.value = dataUrl;
      setRoomIconPreview('new-room-icon-preview', dataUrl, _selectedRoomType);
    };
    if (typeof ImageCropper !== 'undefined') {
      ImageCropper.open({ file, aspect: 1, maxSize: 256, circle: false, onCrop: finish });
    } else {
      const dataUrl = await readRoomIconFile(file);
      if (dataUrl) finish(dataUrl);
    }
    input.value = '';
  }

  async function handleChannelRoomIconSelect(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const finish = (dataUrl) => {
      const iconInput = document.getElementById('ch-settings-icon-input');
      iconInput.value = dataUrl;
      setRoomIconPreview('ch-settings-icon', dataUrl, _currentRoomData?.room?.type || 'public');
    };
    if (typeof ImageCropper !== 'undefined') {
      ImageCropper.open({ file, aspect: 1, maxSize: 256, circle: false, onCrop: finish });
    } else {
      const dataUrl = await readRoomIconFile(file);
      if (dataUrl) finish(dataUrl);
    }
    input.value = '';
  }

  async function handleChannelBannerSelect(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const finish = (dataUrl) => {
      const hidden = document.getElementById('ch-settings-banner');
      const preview = document.getElementById('ch-settings-banner-preview');
      if (hidden) hidden.value = dataUrl;
      if (preview) {
        preview.style.backgroundImage = `url(${dataUrl})`;
        preview.style.backgroundSize = 'cover';
        preview.style.backgroundPosition = 'center';
        preview.textContent = '';
      }
    };
    if (typeof ImageCropper !== 'undefined') {
      ImageCropper.open({ file, aspect: 3, maxSize: 1200, circle: false, onCrop: finish });
    } else {
      const r = new FileReader();
      r.onload = e => finish(e.target.result);
      r.readAsDataURL(file);
    }
    input.value = '';
  }

  // Upload a channel theme background image to the dedicated server
  // endpoint. The server re-encodes / strips EXIF / caps dimensions and
  // returns a relative URL we drop into the theme.bgImage input.
  // Multipart (rather than a base64 data URL inlined into the
  // channel_theme JSON) is the only viable path because channel_theme
  // is capped at 4 KB server-side.
  async function handleChannelThemeBgUpload(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const room = _currentSettingsRoom || State.currentRoom;
    const urlField = document.getElementById('ch-theme-bg-image');
    const hint = document.getElementById('ch-theme-bg-image-hint');
    const setHint = (msg, cls) => {
      if (!hint) return;
      hint.textContent = msg;
      hint.style.color = cls === 'error' ? '#e57373' : (cls === 'ok' ? '#7cb342' : '#888');
    };
    if (!room) { setHint('No channel selected', 'error'); input.value = ''; return; }
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type || '')) {
      setHint('Use JPEG, PNG, or WEBP', 'error'); input.value = ''; return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setHint('Image too large (max 8 MB)', 'error'); input.value = ''; return;
    }
    setHint('Uploading…');
    try {
      const fd = new FormData();
      fd.append('media', file, file.name || 'bg');
      const res = await fetch(`/api/rooms/${encodeURIComponent(room)}/theme-bg`, {
        method: 'POST',
        headers: { 'X-Session-Token': State.token },
        body: fd,
      });
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok || !data?.url) {
        setHint(data?.error || `Upload failed (${res.status})`, 'error');
        return;
      }
      if (urlField) urlField.value = data.url;
      const kb = Math.max(1, Math.round((data.size || 0) / 1024));
      setHint(`Uploaded (${kb} KB). Click Preview to see it, then Save.`, 'ok');
    } catch (e) {
      setHint('Network error', 'error');
    } finally {
      input.value = '';
    }
  }

  // Wired to the small ✕ next to the Background Image URL field. Clears
  // the input AND tells the server to delete the stored file so we don't
  // leak storage when an admin gives up on a theme. The actual
  // channel_theme JSON still gets the empty string committed when they
  // hit Save.
  async function clearChannelThemeBgImage() {
    const urlField = document.getElementById('ch-theme-bg-image');
    if (urlField) urlField.value = '';
    const hint = document.getElementById('ch-theme-bg-image-hint');
    const room = _currentSettingsRoom || State.currentRoom;
    if (!room) return;
    try {
      await fetch(`/api/rooms/${encodeURIComponent(room)}/theme-bg`, {
        method: 'DELETE',
        headers: { 'X-Session-Token': State.token },
      });
      if (hint) {
        hint.textContent = 'Background removed. Save to apply.';
        hint.style.color = '#888';
      }
    } catch {}
  }

  async function loadRooms() {
    // Show skeleton placeholders while loading (first load only)
    const container = document.getElementById('public-channels');
    if (container && !container.children.length) {
      container.innerHTML = Array(5).fill(0).map(() => `
        <div class="channel-item skel-row" style="display:flex;align-items:center;gap:10px;padding:8px 10px">
          <div class="skel-circle" style="width:32px;height:32px;flex-shrink:0"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:4px">
            <div class="skel-line" style="height:11px;width:70%"></div>
            <div class="skel-line" style="height:9px;width:40%"></div>
          </div>
        </div>`).join('');
    }
    const res = await fetch('/api/rooms', { headers: { 'X-Session-Token': State.token } });
    const data = await res.json();
    State.rooms = data.rooms || [];
    renderRooms();
  }

  // ── Discord-style drag-to-reorder for joined channels ────────────────────
  // Desktop: small mousemove after pointerdown enters drag mode.
  // Touch (Android): a ~380ms hold without movement enters drag mode and
  //   suppresses the long-press "channel options" menu (which fires at 500ms
  //   via bindLongPress) by dispatching a synthetic touchcancel that clears
  //   that handler's timer. If the user moves their finger before the hold
  //   timer fires we treat it as a scroll and bail. Released-without-move
  //   leaves the long-press menu free to fire normally.
  // DMs are intentionally excluded — this binder is only attached to rows
  // inside #public-channels.
  async function _persistChannelOrder() {
    const container = document.getElementById('public-channels');
    if (!container) return;
    const order = [...container.querySelectorAll('.channel-item:not(.channel-unjoined)')]
      .map(el => el.dataset.room).filter(Boolean);
    try {
      const rank = {};
      order.forEach((n, i) => { rank[n] = i; });
      State.rooms.sort((a, b) => {
        const ra = (a.name in rank) ? rank[a.name] : 1e9;
        const rb = (b.name in rank) ? rank[b.name] : 1e9;
        return ra - rb;
      });
    } catch {}
    try {
      await fetch('/api/rooms/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
        body: JSON.stringify({ order })
      });
    } catch {}
  }

  function _bindChannelDrag(el) {
    if (el._dragBound) return;
    el._dragBound = true;

    // Capture-phase click filter — only active when a real drag-with-movement
    // just finished, so a simple tap on the handle never eats the click.
    el.addEventListener('click', (e) => {
      if (el._dragSuppressClick) {
        e.stopImmediatePropagation();
        e.preventDefault();
        el._dragSuppressClick = false;
      }
    }, true);

    el.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return;
      if (e.target.closest && e.target.closest('.ch-icon-btn')) return;

      const isTouch = e.pointerType === 'touch';
      const fromHandle = !!(e.target.closest && e.target.closest('.ch-drag-handle'));
      // Touch must come from the handle; taps on the row body open the channel.
      if (isTouch && !fromHandle) return;

      if (fromHandle) {
        // stopPropagation so the row's click / longpress bubbling doesn't fire.
        // NOTE: do NOT call e.preventDefault() — on mobile Chrome preventing
        // pointerdown suppresses the subsequent click event entirely, which
        // would cause the channel to require two taps to select.
        e.stopPropagation();
        // bindLongPress armed its 500ms timer on touchstart (fires before
        // pointerdown), so cancel it now via a synthetic touchcancel.
        if (isTouch) {
          try { el.dispatchEvent(new Event('touchcancel', { bubbles: false })); } catch {}
        }
      }

      const startX = e.clientX, startY = e.clientY;
      const container = el.parentElement;
      let dragging = false;
      let movedSignificantly = false; // true only when real movement occurred
      let rafId = 0;
      let rafX = 0, rafY = 0;

      const arm = () => {
        if (dragging) return;
        dragging = true;
        el.classList.add('dragging');
        try { navigator.vibrate && navigator.vibrate(12); } catch {}
      };

      // Throttled reorder — runs inside rAF so DOM insertBefore only fires
      // once per frame (~16ms) instead of on every raw pointermove event.
      const doReorder = () => {
        rafId = 0;
        const below = document.elementFromPoint(rafX, rafY);
        const target = below && below.closest && below.closest('.channel-item');
        if (!target || target === el) return;
        if (target.parentElement !== container) return;
        if (target.classList.contains('channel-unjoined')) return;
        const rect = target.getBoundingClientRect();
        const after = rafY > rect.top + rect.height / 2;
        if (after) {
          if (target.nextSibling !== el) container.insertBefore(el, target.nextSibling);
        } else {
          if (target !== el) container.insertBefore(el, target);
        }
      };

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const dist = Math.hypot(dx, dy);
        if (!dragging) {
          // Require intentional movement (>6px) before entering drag mode so a
          // firm tap on the handle never accidentally becomes a drag.
          if (dist < 6) return;
          arm();
          if (!dragging) return;
        }
        if (dist > 8) movedSignificantly = true;
        if (ev.cancelable) ev.preventDefault();
        // Queue a single reorder check per animation frame.
        rafX = ev.clientX;
        rafY = ev.clientY;
        if (!rafId) rafId = requestAnimationFrame(doReorder);
      };

      const onUp = () => {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        if (dragging) {
          el.classList.remove('dragging');
          // Only suppress the tap-click and persist order when the user actually
          // dragged to a new position — not when they just touched the handle.
          if (movedSignificantly) {
            el._dragSuppressClick = true;
            _persistChannelOrder();
          }
        }
        cleanup();
      };

      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  function renderRooms() {
    const container = document.getElementById('public-channels');
    container.innerHTML = '';
    const joinedRooms = State.rooms.filter(r => r.joined);
    const unjoinedRooms = State.rooms.filter(r => !r.joined);

    // Always show joined first, then unjoined (when toggled visible)
    const _searchingNow = !!(State._channelSearchQuery || '').trim();
    const roomsToRender = (State._showAllChannels && _searchingNow)
      ? [...joinedRooms, ...unjoinedRooms]
      : joinedRooms;

    let shownUnjoinedHeader = false;
    roomsToRender.forEach(room => {
      // Add a divider before the first unjoined room
      if (State._showAllChannels && !room.joined && !shownUnjoinedHeader) {
        shownUnjoinedHeader = true;
        const divider = document.createElement('div');
        divider.style.cssText = 'font-size:11px;color:#888;font-weight:600;padding:8px 10px 4px;text-transform:uppercase;letter-spacing:.5px';
        divider.textContent = 'Unjoined channels';
        container.appendChild(divider);
      }

      const isOwner = room.owner_nickname === State.user.nickname;
      const isAdmin = State.user.is_admin;
      const canEdit = isOwner || isAdmin;
      const protectedRooms = ['general', 'random', 'announcements'];
      const showDelete = canEdit && (!protectedRooms.includes(room.name) || isAdmin);
      const channelType = (room.channel_type === 'voice') ? 'music' : (room.channel_type || 'text');
      const isInviteOnly = !!room.invite_only;
      const isMyMod = !isOwner && Array.isArray(State.currentRoomMods) && State.currentRoomMods.includes(State.user.nickname)
        && State.currentRoom === room.name;

      const el = document.createElement('div');
      el.className = 'channel-item' + (channelType === 'music' ? ' music-channel' : '') + (!room.joined ? ' channel-unjoined' : '');
      if (typeof Mute !== 'undefined' && Mute.isRoomMuted(room.name)) el.classList.add('is-muted');
      el.dataset.room = room.name;
      el.dataset.channelType = channelType;
      el.innerHTML = `
        <button class="ch-icon-btn" type="button" title="Channel info" onclick="event.stopPropagation();Rooms.showChannelAbout('${UI.escHtml(room.name)}')">
          ${roomIconHtml(room.icon, room.type, 'ch-icon', channelType)}
        </button>
        <span class="ch-name">${UI.escHtml(room.name)}</span>
        ${isInviteOnly ? '<span class="ch-badge" title="Invite only">🔒</span>' : ''}
        ${(typeof Mute !== 'undefined' && Mute.isRoomMuted(room.name)) ? '<span class="ch-muted-ind" title="Muted">🔕</span>' : ''}
        ${isOwner ? '<span class="ch-owner-badge" title="You own this channel">Owner</span>' : ''}
        ${room.joined ? '<span class="ch-drag-handle" title="Drag to reorder" aria-label="Drag to reorder"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg></span>' : ''}
      `;
      el.onclick = () => {
        if (!room.joined) { joinRoom(room.name); return; }
        switchToRoom(room.name, room.type, null, channelType);
      };
      // Long-press (mobile) / right-click: show channel action sheet
      if (typeof bindLongPress === 'function') {
        bindLongPress(el, () => {
          const items = [
            { icon: 'ℹ️', label: 'Channel info', onclick: () => showChannelAbout(room.name) },
          ];
          if (canEdit) items.push({ icon: '⚙️', label: 'Settings', onclick: () => openChannelSettings(room.name) });
          if (room.joined) {
            items.push({ icon: '🔗', label: 'Copy invite link', onclick: () => quickShareChannel() });
            if (typeof Mute !== 'undefined') {
              const muted = Mute.isRoomMuted(room.name);
              items.push({ icon: muted ? '🔔' : '🔕', label: muted ? 'Unmute channel' : 'Mute channel', onclick: () => Mute.toggleRoom(room.name) });
            }
            items.push({ icon: '🚪', label: 'Leave channel', onclick: () => leaveRoom(room.name) });
          } else {
            items.push({ icon: '➕', label: 'Join channel', onclick: () => joinRoom(room.name) });
          }
          if (showDelete) items.push({ icon: '🗑️', label: 'Delete channel', danger: true, onclick: () => deleteRoom(room.name) });
          showActionSheet('#' + room.name, items);
        });
      }
      // Drag-to-reorder (joined channels only — DMs and unjoined rows skip).
      if (room.joined) _bindChannelDrag(el);
      container.appendChild(el);
    });

    // Browse/collapse button — only shown while the user is actively searching.
    // Outside of search we rely on the dedicated Channel Directory (server list
    // → "Discover") so the sidebar stays focused on joined rooms.
    const _searchQ = (State._channelSearchQuery || '').trim();
    if (unjoinedRooms.length > 0 && _searchQ) {
      const browseBtn = document.createElement('div');
      browseBtn.className = 'channel-browse-btn';
      browseBtn.textContent = State._showAllChannels
        ? '▲ Hide unjoined'
        : `▼ Show ${unjoinedRooms.length} unjoined matching "${_searchQ}"`;
      browseBtn.onclick = () => { State._showAllChannels = !State._showAllChannels; renderRooms(); };
      container.appendChild(browseBtn);
    }
  }

  async function switchToRoom(name, type = 'public', dmPeer = null, channelType = 'text') {    closeMobileSidebar();
    const _roomDataEarly = State.rooms.find(r => r.name === name);
    const _chTypeEarly = (_roomDataEarly?.channel_type === 'voice') ? 'music' : (_roomDataEarly?.channel_type || channelType || 'text');
    if (State.currentRoom === name && State.currentRoomType === type) {
      // Re-clicking the current channel must still refresh the music panel
      // (e.g. user played a FrogSocial track while staying on this channel).
      try { Music?.mount?.(name, _chTypeEarly); } catch {}
      return;
    }
    try {
      const typingBar = document.getElementById('typing-bar');
      if (typingBar) typingBar.textContent = '';
    } catch {}

    // Resolve room encryption before mutating the current UI so canceling a
    // private-room prompt leaves the existing conversation intact.
    let key = null;
    if (type === 'private') {
      key = await _resolvePrivateRoomKey(name);
      if (key === undefined) return;
    }

    // ── Smooth transition: clear DM UI state so no stale DM bleeds through
    if (typeof _activeDM !== 'undefined' && _activeDM) {
      try { _activeDM = null; } catch {}
      if (typeof renderDMChannels === 'function') {
        try { renderDMChannels(); } catch {}
      }
    }
    // We're entering an actual channel now — drop the welcome-screen flag
    // so the composer / members panel / encryption banner reappear.
    document.body.classList.remove('in-welcome');
    // Immediately blank the messages area to avoid flash of old content
    const area0 = document.getElementById('messages-area');
    if (area0) area0.innerHTML = '';
    const _enc = document.getElementById('encrypt-indicator');
    const _encBtn = document.getElementById('encrypt-btn');
    if (_enc) _enc.style.display = 'none';
    if (_encBtn) _encBtn.style.display = 'none';
    // Update server-list active icon (main vs dms)
    if (typeof selectServer === 'function') selectServer(type === 'dm' ? 'dms' : 'main');

    // Derive encryption key for this room
    const hadMessageCache = Object.prototype.hasOwnProperty.call(State.messages || {}, name);
    State.roomKeys[name] = key;
    State.currentRoom = name;
    State.currentRoomType = type;
    State.currentChannelType = channelType;
    State.dmPeer = dmPeer;
    try {
      if (typeof UI !== 'undefined' && UI.updateTypingBar) UI.updateTypingBar();
    } catch {}
    if (!State.messages[name]) State.messages[name] = [];
    State.oldestMsgId = State.messages[name].length ? State.messages[name][0].id : null;

    // Persist the last-opened channel so the next launch can jump straight
    // back to it instead of flashing the default welcome header. DMs are
    // intentionally skipped (they're peer-scoped, not channel-scoped).
    try {
      if (type !== 'dm') {
        localStorage.setItem('fc_last_room', JSON.stringify({
          name, type, channelType,
          ts: Date.now()
        }));
      }
    } catch {}

    // Check if this room has an active outbound bridge. When true, we will
    // attach a `bridge_plain` field on sends so the bridge can forward
    // readable text to Telegram/Discord (E2EE-encrypted content is opaque
    // to the server). DMs never bridge, so skip the check there.
    if (!State.bridgeOut) State.bridgeOut = {};
    if (type !== 'dm') {
      (async () => {
        try {
          const r = await fetch(`/api/rooms/${encodeURIComponent(name)}/bridge-outbound`,
            { headers: { 'X-Session-Token': State.token } });
          if (r.ok) {
            const j = await r.json();
            State.bridgeOut[name] = !!j.outbound;
          } else {
            State.bridgeOut[name] = false;
          }
        } catch { State.bridgeOut[name] = false; }
      })();
    } else {
      State.bridgeOut[name] = false;
    }

    // Refresh the Discord-style "who's in voice" bar above chat for this room.
    try {
      if (type !== 'dm' && typeof refreshVoicePresenceBar === 'function') {
        refreshVoicePresenceBar(name);
      } else {
        const bar = document.getElementById('voice-presence-bar');
        if (bar) bar.style.display = 'none';
      }
    } catch {}

    // Refresh the Discord-style pinned-messages banner. Hidden in DMs;
    // populated from /api/rooms/{room}/pins for channels.
    try {
      if (typeof refreshPinnedBar === 'function') {
        refreshPinnedBar();
      } else {
        const pb = document.getElementById('pinned-bar');
        if (pb) pb.style.display = 'none';
      }
    } catch {}

    // Update header
    const roomData = State.rooms.find(r => r.name === name);
    State.currentRoomOwner = roomData?.owner_nickname || null;
    State.currentRoomMods = [];
    State.currentRoomForwardingDisabled = !!(roomData?.forwarding_disabled);
    // Fetch moderator list for permission checks (non-blocking)
    if (type !== 'dm') {
      fetch(`/api/rooms/${encodeURIComponent(name)}`, {
        headers: { 'Authorization': 'Bearer ' + State.token }
      }).then(r => r.ok ? r.json() : null).then(d => {
        if (d && Array.isArray(d.moderators)) {
          State.currentRoomMods = d.moderators.map(m => m.nickname);
        }
        if (d && typeof d.forwarding_disabled !== 'undefined') {
          State.currentRoomForwardingDisabled = !!d.forwarding_disabled;
        }
      }).catch(() => {});
    }
    const chType = (roomData?.channel_type === 'voice') ? 'music' : (roomData?.channel_type || channelType || 'text');
    setRoomHeader(name, type, roomData?.icon || null, dmPeer, chType);
    document.getElementById('ch-desc').textContent = type === 'dm'
      ? `Direct message with ${dmPeer}`
      : (roomData?.description || '');

    // Hide DM-specific buttons when switching to regular channels
    const timerBtn = document.getElementById('dm-timer-btn');
    if (timerBtn && type !== 'dm') timerBtn.style.display = 'none';

    // Show/hide unified call button: voice/video-capable call only in DMs.
    // (There is no separate 📹 button — the user turns on camera mid-call.)
    const callVoiceBtn = document.getElementById('call-voice-btn');
    if (callVoiceBtn) callVoiceBtn.style.display = type === 'dm' ? '' : 'none';

    // Show/hide encrypt button: only in DMs
    const encryptBtn = document.getElementById('encrypt-btn');
    if (encryptBtn) encryptBtn.style.display = type === 'dm' ? '' : 'none';

    // Show voice join button for voice channels or as general room voice
    const voiceJoinBtn = document.getElementById('voice-join-btn');
    if (voiceJoinBtn) {
      // Always visible outside active voice sessions — useful from any context.
      // Music channels don't use the voice bar (they use the YouTube/Spotify
      // player instead), so hide it there to avoid user confusion.
      const isMusicCh = chType === 'music';
      const showVoice = !window._voiceRoom && !isMusicCh && type !== 'dm';
      voiceJoinBtn.style.display = showVoice ? '' : 'none';
    }
    
    // For voice channels, auto-hide the message input (voice channels don't have text chat in this model)
    const msgBar = document.getElementById('input-area');
    if (msgBar) {
      msgBar.style.display = chType === 'voice' ? 'none' : '';
    }
    if (_enc) {
      _enc.style.display = (key && chType !== 'voice') ? '' : 'none';
    }
    // Re-apply mute UI for the channel we just switched to (composer
    // disabled + "You're muted" pill). Defined in ws.js below as a
    // window-scoped helper so room_muted events from any panel hit it.
    try {
      if (typeof window._applyRoomMuteUI === 'function') {
        window._applyRoomMuteUI(name);
      }
    } catch {}
    // Re-apply ban banner if this room had a prior `room_ban` event
    // (composer is replaced by the inline "Banned by …" banner). For
    // any other room, this call clears any stale ban banner left over.
    //
    // Edge case: if our WS got force-closed when the ban landed (code
    // 4003 → auto-reconnect suppressed), a subsequent `room_unban` push
    // from the server has nowhere to land and the local _roomBans entry
    // outlives the actual ban. The user then re-joins via invite/link
    // and would see a phantom red banner. Detect that case by checking
    // whether the room is back in State.rooms (server-side /api/rooms
    // filters out rooms the caller is currently banned from), and drop
    // the stale entry + show the green "you're unbanned" confirmation.
    let _staleBanCleared = false;
    try {
      const inRooms = !!(State.rooms || []).find(r => r.name === name);
      if (inRooms && window._roomBans && window._roomBans[name]) {
        delete window._roomBans[name];
        _staleBanCleared = true;
      }
    } catch {}
    try {
      if (typeof window._applyRoomBanUI === 'function') {
        window._applyRoomBanUI(name);
      }
    } catch {}
    if (_staleBanCleared) {
      try {
        if (typeof window._showRoomUnbannedBanner === 'function') {
          window._showRoomUnbannedBanner(name, { rejoined: true });
        }
      } catch {}
    }

    // Music channels: chat stays open but we lock the attachment bar down to
    // pictures + GIFs only so nobody can drop a voice note or a 2-minute
    // vlog in the middle of a DJ set. Also hide record buttons entirely.
    const isMusic = (chType === 'music');
    const voiceRecBtn = document.getElementById('voice-rec-btn');
    const videoRecBtn = document.getElementById('video-rec-btn');
    const fileInput   = document.getElementById('file-input');
    if (voiceRecBtn) voiceRecBtn.style.display = isMusic ? 'none' : '';
    if (videoRecBtn) videoRecBtn.style.display = isMusic ? 'none' : '';
    if (fileInput)   fileInput.accept = isMusic ? 'image/*,image/gif' : 'image/*,video/mp4,video/webm,audio/*';
    document.body.classList.toggle('in-music-channel', isMusic);

    // Show/hide the music channel panel
    try { Music?.mount?.(name, chType); } catch {}

    // Highlight active
    document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
    const activeEl = document.querySelector(`[data-room="${name}"]`);
    if (activeEl) activeEl.classList.add('active');

    // Clear unread marker for this room
    try {
      if (State._unreadRooms) delete State._unreadRooms[name];
      if (activeEl) {
        activeEl.classList.remove('has-unread');
        const ub = activeEl.querySelector('.unread-badge');
        if (ub) ub.remove();
      }
    } catch {}

    // Hide members list in DMs — only two people anyway, frees up space for the conversation
    const usersPanel = document.getElementById('users-panel');
    if (usersPanel) {
      if (type === 'dm') usersPanel.classList.add('hidden');
      else usersPanel.classList.remove('hidden');
    }
    const chatHeader = document.getElementById('chat-header');
    if (chatHeader) {
      if (type === 'dm') chatHeader.classList.add('is-dm');
      else chatHeader.classList.remove('is-dm');
    }

    // Connect WebSocket
    WS.connect(name);

    // Load full channel member list (online + offline) for the sidebar.
    // DMs don't have this concept, so only fetch for real rooms.
    if (type !== 'dm' && typeof Users !== 'undefined' && Users.loadChannelMembers) {
      try { Users.loadChannelMembers(name); } catch {}
    }

    // Apply channel theme if set
    clearChannelThemeOverride();
    if (roomData?.channel_theme) {
      try { applyChannelThemeOverride(JSON.parse(roomData.channel_theme)); } catch {}
    }
    // Clear messages and reply state
    const msgArea = document.getElementById('messages-area');
    if (msgArea) msgArea.innerHTML = '';
    // Hide any lingering "jump to latest" pip from the previous channel.
    try { document.getElementById('jump-to-latest-pip')?.classList.remove('visible'); } catch {}
    if (typeof Messages !== 'undefined' && Messages.clearReply) Messages.clearReply();
    if (type !== 'dm' && typeof clearReplyToDM === 'function') clearReplyToDM();

    // For text/DM channels, prefer rendering cached history instantly.
    // Show spinner only when there is no cache yet.
    if (chType !== 'voice' && msgArea) {
      // An empty array IS a valid cache state (e.g. a freshly-created
      // channel that has no messages yet). Treat presence of the array
      // as cache-hit so loadHistory renders the empty-state immediately
      // instead of showing a perpetual "Loading #room…" spinner that
      // the WS history dedup will refuse to clear.
      const hasCached = type !== 'dm' && hadMessageCache && Array.isArray(State.messages[name]);
      if (hasCached && typeof Messages !== 'undefined' && Messages.loadHistory) {
        try { Messages.loadHistory(name, State.messages[name].slice()); } catch {}
      } else {
        const label = type === 'dm'
          ? `Loading conversation with ${dmPeer}…`
          : `Loading #${name}…`;
        msgArea.innerHTML = `
          <div class="ch-loading-state" id="ch-loading-state">
            <div class="ch-spin"></div>
            <div>${label.replace(/[<>&]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]))}</div>
          </div>`;
      }
    }
    
    // For voice channels, show a prompt to join voice
    if (chType === 'voice') {
      document.getElementById('messages-area').innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;color:#888">
          <div style="font-size:48px">🔊</div>
          <div style="font-size:18px;font-weight:600">Voice Channel</div>
          <div style="font-size:14px">Click the voice button in the header to join</div>
        </div>
      `;
    }
  }

  function openDM(targetNickname) {
    // DM room name: "dm:" + sorted nicks joined by ":"
    const sorted = [State.user.nickname, targetNickname].sort();
    const dmRoom = `dm:${sorted.join(':')}`;

    // Ensure DM entry in sidebar
    renderDMEntry(targetNickname, dmRoom);
    switchToRoom(dmRoom, 'dm', targetNickname);
  }

  function renderDMEntry(nickname, room) {
    const container = document.getElementById('dm-channels');
    if (container.querySelector(`[data-room="${room}"]`)) return;
    const el = document.createElement('div');
    el.className = 'channel-item';
    el.dataset.room = room;
    el.innerHTML = `
      <div class="dm-badge"></div>
      <span class="ch-name">${UI.escHtml(nickname)}</span>
    `;
    el.onclick = () => switchToRoom(room, 'dm', nickname);
    container.prepend(el);
  }

  function showCreateRoom() {
    document.getElementById('new-room-name').value = '';
    document.getElementById('new-room-desc').value = '';
    document.getElementById('new-room-icon-input').value = '';
    const inviteOnlyEl = document.getElementById('new-room-invite-only');
    if (inviteOnlyEl) inviteOnlyEl.checked = false;
    const listDirEl = document.getElementById('new-room-list-directory');
    if (listDirEl) listDirEl.checked = false;
    const catEl = document.getElementById('new-room-category');    if (catEl) catEl.value = '';
    const ddEl  = document.getElementById('new-room-dir-desc');    if (ddEl)  ddEl.value = '';
    const tagEl = document.getElementById('new-room-tags');        if (tagEl) tagEl.value = '';
    const secretEl = document.getElementById('new-room-secret');   if (secretEl) secretEl.value = '';
    if (secretEl) secretEl.type = 'password';
    const secretToggleEl = document.getElementById('new-room-secret-toggle');
    if (secretToggleEl) {
      secretToggleEl.textContent = '👁️';
      secretToggleEl.setAttribute('aria-label', 'Show shared secret');
      secretToggleEl.setAttribute('title', 'Show shared secret');
    }
    const hintEl = document.getElementById('new-room-secret-hint'); if (hintEl) hintEl.value = '';
    const dirFields = document.getElementById('new-room-directory-fields');
    if (dirFields) dirFields.style.display = 'none';
    const secretSec = document.getElementById('new-room-secret-section');
    if (secretSec) secretSec.style.display = 'none';
    _selectedRoomType = 'public';
    _selectedChannelType = 'text';
    document.getElementById('type-public').classList.add('selected');
    document.getElementById('type-private').classList.remove('selected');
    document.getElementById('chtype-text').classList.add('selected');
    document.getElementById('chtype-music').classList.remove('selected');
    const dirSec = document.getElementById('new-room-directory-section');
    if (dirSec) dirSec.style.display = '';
    const inviteCard = document.getElementById('new-room-invite-only-card');
    if (inviteCard) inviteCard.style.display = '';
    const inviteToggle = document.getElementById('new-room-invite-only');
    if (inviteToggle) inviteToggle.checked = false;
    setRoomIconPreview('new-room-icon-preview', '', 'public', 'text');
    openModal('modal-create-room');
    setTimeout(() => document.getElementById('new-room-name').focus(), 100);
  }

  function selectRoomType(type) {
    _selectedRoomType = type;
    document.getElementById('type-public').classList.toggle('selected', type === 'public');
    document.getElementById('type-private').classList.toggle('selected', type === 'private');
    setRoomIconPreview('new-room-icon-preview', document.getElementById('new-room-icon-input')?.value || '', type, _selectedChannelType);
    // Hide directory section when not public
    const dirSec = document.getElementById('new-room-directory-section');
    if (dirSec) dirSec.style.display = (type === 'public') ? '' : 'none';
    const secretSec = document.getElementById('new-room-secret-section');
    if (secretSec) secretSec.style.display = (type === 'private') ? '' : 'none';
    // Private channels are invite-only by definition — hide the redundant
    // toggle so users don't think they have a choice.
    const inviteCard = document.getElementById('new-room-invite-only-card');
    if (inviteCard) inviteCard.style.display = (type === 'private') ? 'none' : '';
  }

  function selectChannelType(type) {
    _selectedChannelType = type;
    document.getElementById('chtype-text').classList.toggle('selected', type === 'text');
    document.getElementById('chtype-music').classList.toggle('selected', type === 'music');
    setRoomIconPreview('new-room-icon-preview', document.getElementById('new-room-icon-input')?.value || '', _selectedRoomType, type);
  }

  async function createRoom() {
    const name = document.getElementById('new-room-name').value.trim();
    const desc = document.getElementById('new-room-desc').value.trim();
    const icon = document.getElementById('new-room-icon-input').value.trim();
    const inviteOnly = (_selectedRoomType === 'private')
      ? 1
      : (document.getElementById('new-room-invite-only')?.checked ? 1 : 0);
    if (!name) return;
    let roomKeyHint = null;
    if (_selectedRoomType === 'private') {
      const enteredSecret = (document.getElementById('new-room-secret')?.value || '').trim();
      const trimmedSecret = enteredSecret;
      if (!trimmedSecret) {
        UI.showToast('Private rooms require a shared secret', 'error');
        document.getElementById('new-room-secret')?.focus();
        return;
      }
      _storeRoomSecret(name, trimmedSecret);
      roomKeyHint = (document.getElementById('new-room-secret-hint')?.value || '').trim() || null;
    }

    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ name, description: desc, type: _selectedRoomType, room_key_hint: roomKeyHint, icon, channel_type: _selectedChannelType, invite_only: inviteOnly })
    });
    const data = await res.json();
    if (!res.ok) {
      if (_selectedRoomType === 'private') _storeRoomSecret(name, '');
      UI.showToast(data.error || 'Failed to create room', 'error');
      return;
    }

    // If public + opted into directory, immediately publish listing
    const listInDir = document.getElementById('new-room-list-directory')?.checked;
    if (_selectedRoomType === 'public' && listInDir) {
      const cat = document.getElementById('new-room-category')?.value || '';
      const dirDesc = (document.getElementById('new-room-dir-desc')?.value || '').slice(0, 1200).trim();
      const tagsRaw = document.getElementById('new-room-tags')?.value?.trim() || '';
      const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 10) : [];
      try {
        const vr = await fetch(`/api/directory/channels/${encodeURIComponent(name)}/visibility`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
          body: JSON.stringify({ is_public: true, category: cat, directory_description: dirDesc, tags })
        });
        if (vr.ok) UI.showToast('Channel listed in directory 📣', 'success');
        else {
          const er = await vr.json().catch(() => ({}));
          UI.showToast(er.error || 'Channel created (listing failed)', 'info');
        }
      } catch (_) {}
    }
    closeModal('modal-create-room');
    await loadRooms();
    switchToRoom(name, _selectedRoomType, null, _selectedChannelType);
  }

  async function deleteRoom(name) {
    if (!confirm(`Delete #${name}? This cannot be undone.`)) return;
    const res = await fetch(`/api/rooms/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { 'X-Session-Token': State.token }
    });
    const data = await res.json();
    if (!res.ok) { UI.showToast(data.error || 'Failed to delete room', 'error'); return; }
    await loadRooms();
    if (State.currentRoom === name) {
      try { App.openFirstAvailableRoom(); }
      catch { App.showEmptyOnboarding?.(); }
    }
  }

  async function joinRoom(name) {
    const res = await fetch(`/api/rooms/${encodeURIComponent(name)}/join`, {
      method: 'POST', headers: { 'X-Session-Token': State.token }
    });
    if (res.ok) {
      await loadRooms();
      const room = (State.rooms || []).find(r => r.name === name);
      switchToRoom(name, room?.type || 'public', null, room?.channel_type || 'text');
      return;
    }
    // Banned-from-channel: dedicated screen with reason + duration.
    try {
      const err = await res.json();
      if (err && err.code === 'room_banned' && typeof window.showRoomBannedScreen === 'function') {
        window.showRoomBannedScreen(err);
      } else if (err && err.error && typeof UI?.showToast === 'function') {
        UI.showToast(err.error, 'error');
      }
    } catch {}
  }

  async function leaveRoom(name) {
    if (!confirm(`Leave #${name}?`)) return;
    const res = await fetch(`/api/rooms/${encodeURIComponent(name)}/leave`, {
      method: 'POST', headers: { 'X-Session-Token': State.token }
    });
    if (res.ok) {
      await loadRooms();
      if (State.currentRoom === name) {
        // Find first joined room to switch to
        const fallback = State.rooms.find(r => r.joined && r.name !== name);
        switchToRoom(fallback ? fallback.name : 'general', 'public');
      }
    }
  }

  // ─── Channel Settings ────────────────────────────────────────────────────────

  function selectSettingsChannelType(type) {
    _settingsChannelType = type;
    document.getElementById('ch-settings-chtype-text').classList.toggle('selected', type === 'text');
    document.getElementById('ch-settings-chtype-music').classList.toggle('selected', type === 'music');
  }

  function _applyDirectoryPolicyForRoomType(roomType) {
    const isPrivate = roomType === 'private';
    const tab = document.getElementById('ch-tab-directory');
    if (tab) {
      tab.style.opacity = isPrivate ? '0.45' : '';
      tab.style.pointerEvents = isPrivate ? 'none' : '';
      tab.title = isPrivate ? 'Only public channels can be listed in directory' : '';
    }
    // Private channels don't expose a public bot surface (bots authenticate
    // against the room owner — adding one to a private channel would leak
    // every message via the bot's API key). Dim & disable the tab the same
    // way as Directory so it's visibly out-of-scope here.
    const botsTab = document.getElementById('ch-tab-bots');
    if (botsTab) {
      botsTab.style.opacity = isPrivate ? '0.45' : '';
      botsTab.style.pointerEvents = isPrivate ? 'none' : '';
      botsTab.title = isPrivate ? 'Bots are disabled in private channels' : '';
    }
    // Same reasoning for bridges: a Telegram/Discord mirror would publish
    // every private message to a third-party platform, defeating the
    // E2EE guarantee. Tab is dimmed/disabled here.
    const bridgesTab = document.getElementById('ch-tab-bridges');
    if (bridgesTab) {
      bridgesTab.style.opacity = isPrivate ? '0.45' : '';
      bridgesTab.style.pointerEvents = isPrivate ? 'none' : '';
      bridgesTab.title = isPrivate ? 'Bridges are disabled in private channels' : '';
    }

    const note = document.getElementById('ch-dir-policy-note');
    if (note) note.style.display = isPrivate ? '' : 'none';

    const dirListedEl = document.getElementById('ch-dir-listed');
    const dirCatEl = document.getElementById('ch-dir-category');
    const dirTagsEl = document.getElementById('ch-dir-tags');
    const dirDescEl = document.getElementById('ch-dir-desc');

    if (isPrivate && dirListedEl) dirListedEl.checked = false;
    if (dirListedEl) dirListedEl.disabled = isPrivate;
    if (dirCatEl) dirCatEl.disabled = isPrivate;
    if (dirTagsEl) dirTagsEl.disabled = isPrivate;
    if (dirDescEl) dirDescEl.disabled = isPrivate;

    // Private channels are invite-only by definition — hide the toggle and
    // show an explainer card instead. The Permissions tab still loads so
    // owners can edit "Who Can Create Invites" / forwarding rules.
    const inviteCard = document.getElementById('ch-invite-only-card');
    if (inviteCard) inviteCard.style.display = isPrivate ? 'none' : '';
    const inviteNote = document.getElementById('ch-invite-only-private-note');
    if (inviteNote) inviteNote.style.display = isPrivate ? '' : 'none';
    const inviteCheckbox = document.getElementById('ch-invite-only');
    if (isPrivate && inviteCheckbox) inviteCheckbox.checked = true;
  }

  async function openChannelSettings(roomName) {
    _currentSettingsRoom = roomName;
    
    // Fetch room data
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}`, {
      headers: { 'X-Session-Token': State.token }
    });
    if (!res.ok) {
      UI.showToast('Failed to load channel settings', 'error');
      return;
    }
    const data = await res.json();
    _currentRoomData = data;
    
    // Populate fields
    document.getElementById('ch-settings-icon-input').value = data.room.icon || '';
    document.getElementById('ch-settings-name').value = data.room.name;
    document.getElementById('ch-settings-desc').value = data.room.description || '';
    document.getElementById('ch-settings-slowmode').value = data.room.slowmode || 0;
    // Banner + about
    const _banner = data.room.banner || '';
    const _bannerHidden = document.getElementById('ch-settings-banner');
    const _bannerPreview = document.getElementById('ch-settings-banner-preview');
    if (_bannerHidden) _bannerHidden.value = _banner;
    if (_bannerPreview) {
      if (_banner && isSafeCssImageUrl(_banner)) {
        _bannerPreview.style.backgroundImage = `url('${_banner}')`;
        _bannerPreview.style.backgroundSize = 'cover';
        _bannerPreview.style.backgroundPosition = 'center';
        _bannerPreview.textContent = '';
      } else {
        _bannerPreview.style.backgroundImage = '';
        _bannerPreview.textContent = 'Click to upload banner';
      }
    }
    const _aboutEl = document.getElementById('ch-settings-about');
    if (_aboutEl) _aboutEl.value = data.room.about || '';
    
    // Set channel type (migrate legacy 'voice' → 'music')
    _settingsChannelType = (data.room.channel_type === 'voice') ? 'music' : (data.room.channel_type || 'text');
    document.getElementById('ch-settings-chtype-text').classList.toggle('selected', _settingsChannelType === 'text');
    document.getElementById('ch-settings-chtype-music').classList.toggle('selected', _settingsChannelType === 'music');
    
    setRoomIconPreview('ch-settings-icon', data.room.icon || '', data.room.type, _settingsChannelType);
    const titleIcon = document.getElementById('ch-settings-title-icon');
    if (titleIcon) {
      titleIcon.textContent = isImageIcon(data.room.icon || '') ? '🖼️' : (data.room.icon || defaultIconForType(data.room.type, _settingsChannelType));
    }
    document.getElementById('ch-settings-icon-input').oninput = (e) => {
      const value = e.target.value;
      setRoomIconPreview('ch-settings-icon', value, data.room.type, _settingsChannelType);
      const titleEl = document.getElementById('ch-settings-title-icon');
      if (titleEl) titleEl.textContent = isImageIcon(value || '') ? '🖼️' : (value || defaultIconForType(data.room.type, _settingsChannelType));
      const preview = document.getElementById('ch-settings-icon');
      if (preview) {
        preview.style.cursor = isImageIcon(value || '') ? 'zoom-in' : 'default';
        preview.onclick = isImageIcon(value || '') ? (() => {
          if (typeof openLightbox === 'function') openLightbox(value);
        }) : null;
      }
    };

    const settingsPreview = document.getElementById('ch-settings-icon');
    if (settingsPreview) {
      settingsPreview.style.cursor = isImageIcon(data.room.icon || '') ? 'zoom-in' : 'default';
      settingsPreview.onclick = isImageIcon(data.room.icon || '') ? (() => {
        if (typeof openLightbox === 'function') openLightbox(data.room.icon);
      }) : null;
    };
    
    // Show/hide delete button for protected rooms
    const protectedRooms = ['general', 'random', 'announcements'];
    const canDelete = !protectedRooms.includes(roomName) || State.user.is_admin;
    document.getElementById('ch-delete-btn').style.display = canDelete ? 'block' : 'none';
    
    // Populate permissions fields
    const inviteOnlyEl = document.getElementById('ch-invite-only');
    if (inviteOnlyEl) inviteOnlyEl.checked = !!data.room.invite_only;
    const whoCanInviteEl = document.getElementById('ch-who-can-invite');
    if (whoCanInviteEl) whoCanInviteEl.value = data.room.who_can_invite || 'everyone';
    const fwdEl = document.getElementById('ch-forwarding-disabled');
    if (fwdEl) fwdEl.checked = !!data.room.forwarding_disabled;
    
    // Populate directory fields
    const dirListedEl = document.getElementById('ch-dir-listed');
    if (dirListedEl) dirListedEl.checked = !!data.room.is_public;
    const dirCatEl = document.getElementById('ch-dir-category');
    if (dirCatEl) dirCatEl.value = data.room.category || '';
    const dirTagsEl = document.getElementById('ch-dir-tags');
    if (dirTagsEl) {
      try { dirTagsEl.value = JSON.parse(data.room.tags || '[]').join(', '); } catch { dirTagsEl.value = ''; }
    }
    const dirDescEl = document.getElementById('ch-dir-desc');
    if (dirDescEl) dirDescEl.value = data.room.directory_description || '';
    _applyDirectoryPolicyForRoomType(data.room.type);
    
    // Render moderators
    renderModerators(data.moderators);

    // Show/hide owner-only Danger Zone (transfer ownership) based on
    // whether the current user actually owns this room. Server enforces
    // the same rule; this is just a UI clarity layer.
    try {
      const dangerEl = document.getElementById('ch-owner-danger');
      const ownerNameEl = document.getElementById('ch-owner-current-name');
      const myNick = State.user && State.user.nickname;
      const ownerNick = data.room && data.room.owner_nickname;
      const iAmOwner = !!(myNick && ownerNick && myNick === ownerNick);
      if (dangerEl) dangerEl.style.display = iAmOwner ? '' : 'none';
      if (ownerNameEl) ownerNameEl.textContent = ownerNick || '—';
    } catch {}
    
    // Fetch and render bans
    fetchBans(roomName);

    // ── Encryption badge + rotate button + bridge restriction ────────────
    try {
      const isPrivate = data.room && data.room.type === 'private';
      const badge = document.getElementById('ch-enc-badge');
      if (badge) {
        if (isPrivate) {
          const ver = parseInt(data.room.room_key_version, 10) || 1;
          badge.style.display = 'block';
          badge.style.background = 'rgba(76,175,80,.08)';
          badge.style.border = '1px solid rgba(76,175,80,.3)';
          badge.style.color = '#9bd0ad';
          badge.innerHTML =
            '🔒 <strong>End-to-end encrypted</strong> — AES-256-GCM per-room key with rotation. ' +
            '<span style="color:#7a9b85;font-size:12px">Current key version: <strong>v' + ver + '</strong>. ' +
            'The server stores ciphertext only; it cannot read your messages.</span>';
        } else {
          badge.style.display = 'block';
          badge.style.background = 'rgba(255,193,7,.06)';
          badge.style.border = '1px solid rgba(255,193,7,.25)';
          badge.style.color = '#ffd47a';
          badge.innerHTML =
            '🔓 <strong>Encrypted at rest only.</strong> ' +
            '<span style="color:#b39555;font-size:12px">Public channels are not end-to-end encrypted — the server (and any connected bridges) can read messages. For private conversations, create a Private channel.</span>';
        }
      }
      const rotCard = document.getElementById('ch-rotate-key-card');
      const rotBtn  = document.getElementById('ch-rotate-key-btn');
      if (rotCard) rotCard.style.display = isPrivate ? 'block' : 'none';
      if (rotBtn) {
        rotBtn.onclick = async () => {
          const ok = confirm(
            'Rotate the room key now?\n\n' +
            'A fresh AES-256-GCM key will be generated and securely sent ' +
            'to every current member via Signal. Anyone who is no longer in ' +
            'the room loses access to new messages.\n\n' +
            'Old messages they already had access to remain readable on their device.'
          );
          if (!ok) return;
          rotBtn.disabled = true;
          rotBtn.textContent = 'Rotating…';
          try {
            await rotateRoomKey(roomName, { reason: 'manual' });
            // Refresh the modal so the new version badge shows.
            try { openChannelSettings(roomName); } catch {}
          } catch (e) {
            console.warn('[rooms] manual rotate failed', e);
            UI.showToast('Key rotation failed: ' + (e && e.message ? e.message : 'unknown'), 'error');
          } finally {
            rotBtn.disabled = false;
            rotBtn.textContent = 'Rotate room key now';
          }
        };
      }
      // Hide bridge creation UI for private rooms, show warning.
      const bWarn = document.getElementById('ch-bridges-private-warning');
      const bBody = document.getElementById('ch-bridges-public-body');
      if (bWarn) bWarn.style.display = isPrivate ? 'block' : 'none';
      if (bBody) bBody.style.display = isPrivate ? 'none' : 'block';
      // Theme tab: private channels hide bgImage + custom CSS entirely
      // (server also rejects them). Public channels show a warning that
      // CSS is allowed but background images are proxied. Color fields
      // (bg / text / accent) are always visible above this wrapper.
      const tAdv = document.getElementById('ch-theme-advanced-fields');
      const tPrivNotice = document.getElementById('ch-theme-private-notice');
      const tPubWarn = document.getElementById('ch-theme-public-warning');
      if (tAdv) tAdv.style.display = isPrivate ? 'none' : '';
      if (tPrivNotice) tPrivNotice.style.display = isPrivate ? 'block' : 'none';
      if (tPubWarn) tPubWarn.style.display = isPrivate ? 'none' : 'block';
    } catch (e) { console.warn('[rooms] enc/rotate UI setup failed', e); }
    
    // Default to general tab
    switchChannelTab('general');
    openModal('modal-channel-settings');
  }

  function switchChannelTab(tab) {
    if (tab === 'directory' && _currentRoomData?.room?.type === 'private') {
      UI.showToast('Private channels cannot be listed in directory', 'error');
      tab = 'perms';
    }
    if (tab === 'bots' && _currentRoomData?.room?.type === 'private') {
      UI.showToast('Bots are disabled in private channels', 'error');
      tab = 'perms';
    }
    if (tab === 'bridges' && _currentRoomData?.room?.type === 'private') {
      UI.showToast('Bridges are disabled in private channels', 'error');
      tab = 'perms';
    }
    ['general', 'perms', 'directory', 'invites', 'mods', 'bans', 'theme', 'bots', 'bridges'].forEach(t => {
      const tabEl = document.getElementById(`ch-tab-${t}`);
      const panelEl = document.getElementById(`ch-panel-${t}`);
      if (tabEl) tabEl.classList.toggle('active', t === tab);
      if (panelEl) {
        panelEl.style.display = t === tab ? 'block' : 'none';
        if (t === tab) {
          panelEl.classList.add('modal-tab-pane');
        } else {
          panelEl.classList.remove('modal-tab-pane');
        }
      }
    });
    if (tab === 'invites') fetchInvites(_currentSettingsRoom);
    if (tab === 'theme') loadChannelTheme(_currentSettingsRoom);
    if (tab === 'bots' && typeof loadChannelBotsPanel === 'function') loadChannelBotsPanel(_currentSettingsRoom);
    if (tab === 'bridges' && typeof loadChannelBridgesPanel === 'function') loadChannelBridgesPanel(_currentSettingsRoom);
  }

  function renderModerators(mods) {
    const container = document.getElementById('ch-mods-list');
    if (!container) return;
    if (!mods || mods.length === 0) {
      container.innerHTML = '<div class="mods-empty">No moderators yet — add one above.</div>';
      return;
    }
    container.innerHTML = mods.map(mod => {
      const name = UI.escHtml(mod.nickname || 'unknown');
      const initial = (mod.nickname || '?').trim().charAt(0).toUpperCase() || '?';
      const avatar = mod.avatar
        ? `<img src="${UI.escHtml(mod.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover">`
        : UI.escHtml(initial);
      const added = mod.added_at ? `Added ${new Date(mod.added_at).toLocaleDateString()}` : 'Moderator';
      return `
        <div class="mod-item">
          <div class="mod-avatar">${avatar}</div>
          <div class="mod-info">
            <div class="mod-name">${name}</div>
            <div class="mod-role">${UI.escHtml(added)}</div>
          </div>
          <button class="mod-remove" onclick="Rooms.removeModerator(${mod.user_id}, '${name.replace(/'/g, "\\'")}')">Remove</button>
        </div>
      `;
    }).join('');
  }

  async function addModerator() {
    const input = document.getElementById('ch-add-mod-input');
    const nickname = input.value.trim();
    if (!nickname) return;

    try {
      // Find user ID by nickname
      const usersRes = await apiFetch('/api/users');
      const usersData = await usersRes.json().catch(() => ({}));
      if (!usersRes.ok) {
        UI.showToast(usersData.error || 'Failed to load users', 'error');
        return;
      }
      const users = Array.isArray(usersData.users) ? usersData.users : [];
      const user = users.find(u => String(u.nickname || '').toLowerCase() === nickname.toLowerCase());

      if (!user) {
        UI.showToast('User not found', 'error');
        return;
      }

      const res = await fetch(`/api/rooms/${encodeURIComponent(_currentSettingsRoom)}/moderators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
        body: JSON.stringify({ user_id: user.id })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        UI.showToast(data.error || 'Failed to add moderator', 'error');
        return;
      }

      input.value = '';
      UI.showToast(`${nickname} is now a moderator`);

      // Refresh moderators list
      const roomRes = await fetch(`/api/rooms/${encodeURIComponent(_currentSettingsRoom)}`, {
        headers: { 'X-Session-Token': State.token }
      });
      const roomData = await roomRes.json().catch(() => ({}));
      renderModerators(roomData.moderators || []);
    } catch {
      UI.showToast('Failed to add moderator', 'error');
    }
  }

  async function removeModerator(userId, nickname) {
    const label = nickname ? `Remove ${nickname} as moderator?` : 'Remove this moderator?';
    if (!confirm(label)) return;
    const res = await fetch(`/api/rooms/${encodeURIComponent(_currentSettingsRoom)}/moderators/${userId}`, {
      method: 'DELETE',
      headers: { 'X-Session-Token': State.token }
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      UI.showToast(data.error || 'Failed to remove moderator', 'error');
      return;
    }

    UI.showToast('Moderator removed');

    // Refresh moderators list
    const roomRes = await fetch(`/api/rooms/${encodeURIComponent(_currentSettingsRoom)}`, {
      headers: { 'X-Session-Token': State.token }
    });
    const roomData = await roomRes.json().catch(() => ({}));
    renderModerators(roomData.moderators || []);
  }

  // ── Transfer ownership ───────────────────────────────────────────────
  // Two-step confirmation: user must type the exact target nickname AND
  // tick the acknowledgement before the destructive button arms. Server
  // additionally requires confirm=true and re-checks owner status, so a
  // tampered client can't bypass this.
  function openTransferOwnershipModal() {
    const room = _currentSettingsRoom;
    if (!room) return;
    const labelEl = document.getElementById('xfer-room-label');
    if (labelEl) labelEl.textContent = '#' + room;
    const inp = document.getElementById('xfer-target-input');
    if (inp) inp.value = '';
    const ack = document.getElementById('xfer-ack');
    if (ack) ack.checked = false;
    const hint = document.getElementById('xfer-target-hint');
    if (hint) {
      hint.textContent = 'Type the username exactly as shown in the member list.';
      hint.style.color = '#85a89a';
    }
    _setTransferConfirmArmed(false);
    if (typeof openModal === 'function') openModal('modal-transfer-ownership');
    setTimeout(() => { try { inp && inp.focus(); } catch {} }, 50);
  }

  function _setTransferConfirmArmed(armed) {
    const btn = document.getElementById('xfer-confirm-btn');
    if (!btn) return;
    btn.disabled = !armed;
    btn.style.opacity = armed ? '1' : '.55';
    btn.style.cursor = armed ? 'pointer' : 'not-allowed';
  }

  function onTransferOwnershipInput() {
    const inp = document.getElementById('xfer-target-input');
    const ack = document.getElementById('xfer-ack');
    const name = (inp && inp.value || '').trim();
    const ackOK = !!(ack && ack.checked);
    const myNick = (State.user && State.user.nickname) || '';
    const hint = document.getElementById('xfer-target-hint');
    let armed = false;
    if (!name) {
      if (hint) { hint.textContent = 'Type the username exactly as shown in the member list.'; hint.style.color = '#85a89a'; }
    } else if (myNick && name.toLowerCase() === myNick.toLowerCase()) {
      if (hint) { hint.textContent = "That's you — pick a different member."; hint.style.color = '#ff9b9b'; }
    } else {
      if (hint) { hint.textContent = ackOK ? 'Ready.' : 'Tick the acknowledgement to enable the transfer.'; hint.style.color = ackOK ? '#9bd0ad' : '#85a89a'; }
      armed = ackOK;
    }
    _setTransferConfirmArmed(armed);
  }

  async function confirmTransferOwnership() {
    const btn = document.getElementById('xfer-confirm-btn');
    if (!btn || btn.disabled) return;
    const inp = document.getElementById('xfer-target-input');
    const ack = document.getElementById('xfer-ack');
    const name = (inp && inp.value || '').trim();
    if (!name || !ack || !ack.checked) return;
    const room = _currentSettingsRoom;
    if (!room) return;

    btn.disabled = true;
    btn.style.opacity = '.55';
    const origLabel = btn.textContent;
    btn.textContent = 'Transferring…';

    try {
      // Resolve nickname → user_id via /api/users (same lookup the
      // mod-add path uses, so behaviour is consistent and we never
      // sneak a numeric id through the UI).
      const usersRes = await apiFetch('/api/users');
      const usersData = await usersRes.json().catch(() => ({}));
      if (!usersRes.ok) {
        UI.showToast(usersData.error || 'Failed to look up user', 'error');
        btn.textContent = origLabel;
        _setTransferConfirmArmed(true);
        return;
      }
      const users = Array.isArray(usersData.users) ? usersData.users : [];
      const target = users.find(u => String(u.nickname || '').toLowerCase() === name.toLowerCase());
      if (!target) {
        const hint = document.getElementById('xfer-target-hint');
        if (hint) { hint.textContent = 'No user with that exact username.'; hint.style.color = '#ff9b9b'; }
        btn.textContent = origLabel;
        _setTransferConfirmArmed(false);
        return;
      }

      const res = await fetch(`/api/rooms/${encodeURIComponent(room)}/transfer-ownership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
        body: JSON.stringify({ user_id: target.id, confirm: true })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        UI.showToast(data.error || 'Transfer failed', 'error');
        btn.textContent = origLabel;
        _setTransferConfirmArmed(true);
        return;
      }
      UI.showToast(`Ownership of #${room} transferred to ${target.nickname}`);
      try { closeModal('modal-transfer-ownership'); } catch {}
      try { closeModal('modal-channel-settings'); } catch {}
      // Refresh local view of mod state — the WS room_owner_changed
      // event also fires for everyone in the room (see ws.js handler).
      try {
        const roomRes = await fetch(`/api/rooms/${encodeURIComponent(room)}`, {
          headers: { 'X-Session-Token': State.token }
        });
        const roomData = await roomRes.json().catch(() => ({}));
        if (Array.isArray(roomData.moderators)) {
          State.currentRoomMods = roomData.moderators.map(m => m.nickname);
        }
      } catch {}
    } catch (e) {
      UI.showToast('Network error', 'error');
      btn.textContent = origLabel;
      _setTransferConfirmArmed(true);
    }
  }

  async function fetchBans(roomName) {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/bans`, {
      headers: { 'X-Session-Token': State.token }
    });
    
    if (!res.ok) {
      document.getElementById('ch-bans-list').innerHTML = '';
      document.getElementById('ch-no-bans').style.display = 'block';
      return;
    }
    
    const data = await res.json();
    renderBans(data.bans);
  }

  function renderBans(bans) {
    const container = document.getElementById('ch-bans-list');
    const noBans = document.getElementById('ch-no-bans');
    
    if (!bans || bans.length === 0) {
      container.innerHTML = '';
      noBans.style.display = 'block';
      return;
    }
    
    noBans.style.display = 'none';
    container.innerHTML = bans.map(ban => `
      <div class="ban-item">
        <div class="ban-avatar">🚫</div>
        <div class="ban-info">
          <div class="ban-name">${UI.escHtml(ban.nickname)}</div>
          <div class="ban-reason">${ban.reason ? `Reason: ${UI.escHtml(ban.reason)}` : 'No reason provided'}${ban.expires_at ? ` · Expires: ${new Date(ban.expires_at).toLocaleDateString()}` : ' · Permanent'}</div>
        </div>
        <button class="ban-remove" onclick="Rooms.unbanUser(${ban.user_id})">Unban</button>
      </div>
    `).join('');
  }

  async function unbanUser(userId) {
    const res = await fetch(`/api/rooms/${encodeURIComponent(_currentSettingsRoom)}/bans/${userId}`, {
      method: 'DELETE',
      headers: { 'X-Session-Token': State.token }
    });
    
    if (!res.ok) {
      const data = await res.json();
      UI.showToast(data.error || 'Failed to unban user', 'error');
      return;
    }
    
    UI.showToast('User unbanned');
    fetchBans(_currentSettingsRoom);
  }

  async function saveChannelSettings() {
    const icon = document.getElementById('ch-settings-icon-input').value.trim();
    const name = document.getElementById('ch-settings-name').value.trim();
    const desc = document.getElementById('ch-settings-desc').value.trim();
    const slowmode = parseInt(document.getElementById('ch-settings-slowmode').value) || 0;
    const banner = document.getElementById('ch-settings-banner')?.value || '';
    const about = document.getElementById('ch-settings-about')?.value.slice(0, 2000) || '';
    
    if (!name) {
      UI.showToast('Channel name is required', 'error');
      return;
    }

    // Immediate UI feedback: disable Save button and show spinner label.
    const saveBtn = document.getElementById('ch-settings-save-btn');
    const origLabel = saveBtn ? saveBtn.textContent : null;
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.dataset.origLabel = origLabel || 'Save';
      saveBtn.textContent = 'Saving…';
      saveBtn.style.opacity = '0.7';
      saveBtn.style.cursor = 'wait';
    }
    const restoreBtn = () => {
      if (!saveBtn) return;
      saveBtn.disabled = false;
      saveBtn.textContent = saveBtn.dataset.origLabel || 'Save';
      saveBtn.style.opacity = '';
      saveBtn.style.cursor = '';
    };

    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(_currentSettingsRoom)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ icon, name, description: desc, slowmode, channel_type: _settingsChannelType,
        banner, about,
        invite_only: (_currentRoomData?.room?.type === 'private')
          ? 1
          : (document.getElementById('ch-invite-only')?.checked ? 1 : 0),
        who_can_invite: document.getElementById('ch-who-can-invite')?.value || 'everyone',
        forwarding_disabled: document.getElementById('ch-forwarding-disabled')?.checked ? 1 : 0,
        channel_theme: JSON.stringify((() => {
          // Private channels are server-rejected if `bgImage` or `css`
          // is non-empty (per `_sanitize_channel_theme`) — strip them
          // here so a stale value left in a hidden input can't cause a
          // 400 on save. Color fields ship for both privacy tiers.
          const isPriv = (_currentRoomData?.room?.type === 'private');
          const payload = {
            bg: document.getElementById('ch-theme-bg').value,
            text: document.getElementById('ch-theme-text').value,
            accent: document.getElementById('ch-theme-accent').value,
            bgImage: isPriv ? '' : (document.getElementById('ch-theme-bg-image').value.trim()),
            css: isPriv ? '' : (document.getElementById('ch-theme-css').value.trim().slice(0, 4096)),
          };
          return payload;
        })())
      })
    });
    
    if (!res.ok) {
      const data = await res.json();
      let msg = data.error || 'Failed to save settings';
      // The server returns `channel_theme: ...` for CSS / bgImage
      // sanitiser rejections. Replace with a friendlier prefix that
      // makes it clear WHY the save failed.
      if (typeof msg === 'string' && msg.startsWith('channel_theme:')) {
        const detail = msg.slice('channel_theme:'.length).trim();
        msg = `Channel theme was rejected — ${detail}. Open the console for help.`;
        try { console.warn('[channel-theme] save rejected:', detail); } catch {}
      }
      UI.showToast(msg, 'error');
      restoreBtn();
      return;
    }
    
    // Save directory settings separately
    const dirListed = (_currentRoomData?.room?.type === 'private') ? false : !!document.getElementById('ch-dir-listed')?.checked;
    const dirCategory = document.getElementById('ch-dir-category')?.value || '';
    const dirTagsRaw = document.getElementById('ch-dir-tags')?.value || '';
    const dirDesc = (document.getElementById('ch-dir-desc')?.value || '').slice(0, 1200);
    const dirTags = dirTagsRaw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 10);
    
    const dirRoom = (_currentSettingsRoom !== name) ? name : _currentSettingsRoom;
    await fetch(`/api/directory/channels/${encodeURIComponent(dirRoom)}/visibility`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ is_public: !!dirListed, category: dirCategory, tags: dirTags, directory_description: dirDesc })
    });

    if (_currentSettingsRoom !== name) {
      try {
        if (window.Music && typeof Music.migrateRoomPreferences === 'function') {
          Music.migrateRoomPreferences(_currentSettingsRoom, name);
        }
      } catch {}
    }
    
    closeModal('modal-channel-settings');
    UI.showToast('Channel settings saved');
    restoreBtn();

    // Reload rooms to reflect changes
    await loadRooms();

    // If we renamed the room or we're in it, update
    if (State.currentRoom === _currentSettingsRoom && _currentSettingsRoom !== name) {
      switchToRoom(name, _currentRoomData.room.type, null, _settingsChannelType);
    }
    } catch (err) {
      UI.showToast('Failed to save settings', 'error');
      restoreBtn();
    }
  }

  async function deleteChannelFromSettings() {
    if (!confirm(`Delete #${_currentSettingsRoom}? This cannot be undone.`)) return;
    closeModal('modal-channel-settings');
    await deleteRoom(_currentSettingsRoom);
  }

  // ─── Invite Links ─────────────────────────────────────────────────────────

  async function createInvite() {
    if (!_currentSettingsRoom) return;
    const maxUses = parseInt(document.getElementById('ch-invite-max-uses').value) || 0;
    const expiresHours = document.getElementById('ch-invite-expires').value;

    const res = await fetch(`/api/invites/channels/${encodeURIComponent(_currentSettingsRoom)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ max_uses: maxUses, expires_hours: expiresHours ? parseInt(expiresHours) : null })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      UI.showToast(data.error || 'Failed to create invite', 'error');
      return;
    }

    const data = await res.json();
    UI.showToast('Invite link created!');

    // Copy to clipboard (with Electron/legacy fallbacks)
    if (await UI.copy(data.url)) UI.showToast('Link copied to clipboard!');
    else UI.showToast('Could not copy — tap the link to copy manually', 'error');

    fetchInvites(_currentSettingsRoom);
  }

  async function fetchInvites(roomName) {
    const container = document.getElementById('ch-invites-list');
    const noInvites = document.getElementById('ch-no-invites');

    const res = await fetch(`/api/invites/channels/${encodeURIComponent(roomName)}`, {
      headers: { 'X-Session-Token': State.token }
    });

    if (!res.ok) {
      container.innerHTML = '';
      noInvites.style.display = 'block';
      _renderVanityCard(false, null);
      return;
    }

    const data = await res.json();
    const invites = data.invites || [];

    // Owner-only vanity card. Render before invite list so layout is stable.
    _renderVanityCard(!!data.is_owner, data.vanity || null);

    if (!invites.length) {
      container.innerHTML = '';
      noInvites.style.display = 'block';
      return;
    }

    noInvites.style.display = 'none';
    container.innerHTML = invites.map(inv => {
      const url = `https://frogtalk.xyz/i/${inv.code}`;
      const uses = inv.max_uses > 0 ? `${inv.use_count || 0}/${inv.max_uses} uses` : `${inv.use_count || 0} uses`;
      const expires = inv.expires_at ? `Expires ${new Date(inv.expires_at).toLocaleDateString()}` : 'Never expires';
      const by = inv.created_by_name ? `@${inv.created_by_name}` : '?';
      return `<div class="modal-card" style="display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:8px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:700;color:#7fd2a7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${UI.escHtml(url)}</div>
          <div style="font-size:11px;color:#7a9c8d;margin-top:2px">${uses} · ${expires} · by ${UI.escHtml(by)}</div>
        </div>
        <button class="icon-btn" title="Copy" onclick="UI.copy('${url}').then(ok=>UI.showToast(ok?'Copied!':'Could not copy',ok?'success':'error'))" style="font-size:16px">📋</button>
        <button class="icon-btn" title="Revoke" onclick="Rooms.revokeInvite('${inv.code}')" style="font-size:16px;color:#f85149">🗑</button>
      </div>`;
    }).join('');
  }

  // ─── Vanity URL (owner-only) ────────────────────────────────────────────
  // Lifecycle: fetchInvites() seeds {is_owner, vanity}. The card is hidden
  // for non-owners (server also enforces). Live validation runs client-side
  // first, then a debounced server availability check fires once the input
  // looks plausible. Save commits the slug; Clear removes it.

  const _VANITY_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
  let _vanityCurrent = null;       // last server-confirmed vanity for this room
  let _vanityCheckTimer = null;
  let _vanityCheckSeq = 0;
  let _vanityWired = false;
  let _vanityLastStatus = 'idle';  // 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'unchanged'

  function _renderVanityCard(isOwner, currentVanity) {
    const card = document.getElementById('ch-vanity-card');
    if (!card) return;
    if (!isOwner) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    _vanityCurrent = currentVanity || null;

    const input = document.getElementById('ch-vanity-input');
    const clearBtn = document.getElementById('ch-vanity-clear-btn');
    const currentRow = document.getElementById('ch-vanity-current');
    const currentLink = document.getElementById('ch-vanity-current-link');

    if (input) {
      input.value = _vanityCurrent || '';
      input.disabled = false;
    }
    if (clearBtn) clearBtn.style.display = _vanityCurrent ? '' : 'none';
    if (currentRow && currentLink) {
      if (_vanityCurrent) {
        const url = `https://frogtalk.xyz/i/${_vanityCurrent}`;
        currentRow.style.display = '';
        currentLink.textContent = `frogtalk.xyz/i/${_vanityCurrent}`;
        currentLink.href = url;
      } else {
        currentRow.style.display = 'none';
      }
    }
    _setVanityStatus('idle');

    if (!_vanityWired && input) {
      _vanityWired = true;
      input.addEventListener('input', _onVanityInput);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (_vanityLastStatus === 'available') saveVanity();
        }
      });
    }
  }

  function _setVanityStatus(state, text) {
    _vanityLastStatus = state;
    const statusEl = document.getElementById('ch-vanity-status');
    const saveBtn = document.getElementById('ch-vanity-save-btn');
    if (saveBtn) saveBtn.disabled = (state !== 'available');
    if (!statusEl) return;
    let html = '';
    let color = '#7fa897';
    if (state === 'idle') {
      html = 'Letters, digits, hyphen and underscore. 2–32 characters.';
    } else if (state === 'checking') {
      html = '<span style="opacity:.85">Checking availability…</span>';
    } else if (state === 'available') {
      html = `<span style="color:#7fd2a7;font-weight:600">✓ Available</span>`;
      color = '#7fd2a7';
    } else if (state === 'unchanged') {
      html = '<span style="color:#7fa897">This is already your vanity</span>';
    } else if (state === 'invalid') {
      html = `<span style="color:#f8a058">${UI.escHtml(text || 'Invalid')}</span>`;
      color = '#f8a058';
    } else if (state === 'taken') {
      html = `<span style="color:#f85149">${UI.escHtml(text || 'Already taken')}</span>`;
      color = '#f85149';
    } else if (state === 'error') {
      html = `<span style="color:#f85149">${UI.escHtml(text || 'Could not check')}</span>`;
      color = '#f85149';
    }
    statusEl.style.color = color;
    statusEl.innerHTML = html;
  }

  function _onVanityInput() {
    const input = document.getElementById('ch-vanity-input');
    if (!input) return;
    // Coerce to canonical form as the user types: lowercase, strip spaces.
    const normalized = (input.value || '').toLowerCase().replace(/\s+/g, '');
    if (input.value !== normalized) {
      const pos = input.selectionStart;
      input.value = normalized;
      try { input.setSelectionRange(pos, pos); } catch {}
    }

    if (_vanityCheckTimer) {
      clearTimeout(_vanityCheckTimer);
      _vanityCheckTimer = null;
    }
    if (!normalized) {
      _setVanityStatus('idle');
      return;
    }
    if (normalized === (_vanityCurrent || '')) {
      _setVanityStatus('unchanged');
      return;
    }
    if (normalized.length < 2) {
      _setVanityStatus('invalid', 'Too short — minimum 2 characters');
      return;
    }
    if (normalized.length > 32) {
      _setVanityStatus('invalid', 'Too long — maximum 32 characters');
      return;
    }
    if (!_VANITY_RE.test(normalized)) {
      _setVanityStatus('invalid', 'Use lowercase letters, digits, hyphen and underscore (must start/end with a letter or digit)');
      return;
    }
    _setVanityStatus('checking');
    const seq = ++_vanityCheckSeq;
    _vanityCheckTimer = setTimeout(() => _vanityServerCheck(normalized, seq), 350);
  }

  async function _vanityServerCheck(slug, seq) {
    try {
      const url = `/api/invites/vanity-check?slug=${encodeURIComponent(slug)}&room=${encodeURIComponent(_currentSettingsRoom || '')}`;
      const res = await fetch(url, { headers: { 'X-Session-Token': State.token } });
      if (seq !== _vanityCheckSeq) return; // stale
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        _setVanityStatus('error', data.error || 'Could not check availability');
        return;
      }
      if (data.available) {
        _setVanityStatus('available');
      } else {
        _setVanityStatus('taken', data.error || 'Already taken');
      }
    } catch (err) {
      if (seq === _vanityCheckSeq) _setVanityStatus('error', 'Network error');
    }
  }

  async function saveVanity() {
    const input = document.getElementById('ch-vanity-input');
    if (!input || !_currentSettingsRoom) return;
    const slug = (input.value || '').trim().toLowerCase();
    if (!slug) return;
    if (!_VANITY_RE.test(slug) || slug.length < 2 || slug.length > 32) {
      _setVanityStatus('invalid', 'Invalid format');
      return;
    }
    const saveBtn = document.getElementById('ch-vanity-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    try {
      const res = await fetch(`/api/invites/channels/${encodeURIComponent(_currentSettingsRoom)}/vanity`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
        body: JSON.stringify({ vanity: slug })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        UI.showToast(data.error || 'Could not save vanity', 'error');
        _setVanityStatus(res.status === 409 ? 'taken' : 'error', data.error);
        return;
      }
      _vanityCurrent = data.vanity || null;
      UI.showToast('Vanity URL saved!');
      // Refresh card state from authoritative response.
      _renderVanityCard(true, _vanityCurrent);
      // Auto-copy short URL for convenience.
      if (data.url && await UI.copy(data.url)) UI.showToast('Link copied!');
    } catch (err) {
      UI.showToast('Network error', 'error');
    } finally {
      if (saveBtn) { saveBtn.textContent = 'Save'; }
    }
  }

  async function clearVanity() {
    if (!_currentSettingsRoom || !_vanityCurrent) return;
    if (!confirm(`Remove the vanity URL frogtalk.xyz/i/${_vanityCurrent}? Existing /invite/ links will continue to work.`)) return;
    const clearBtn = document.getElementById('ch-vanity-clear-btn');
    if (clearBtn) clearBtn.disabled = true;
    try {
      const res = await fetch(`/api/invites/channels/${encodeURIComponent(_currentSettingsRoom)}/vanity`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
        body: JSON.stringify({ vanity: null })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        UI.showToast(data.error || 'Could not remove vanity', 'error');
        return;
      }
      _vanityCurrent = null;
      _renderVanityCard(true, null);
      UI.showToast('Vanity URL removed');
    } catch (err) {
      UI.showToast('Network error', 'error');
    } finally {
      if (clearBtn) clearBtn.disabled = false;
    }
  }

  async function copyVanityLink() {
    if (!_vanityCurrent) return;
    const url = `https://frogtalk.xyz/i/${_vanityCurrent}`;
    if (await UI.copy(url)) UI.showToast('Link copied!');
    else UI.showToast('Could not copy — long-press the link to copy manually', 'error');
  }

  async function revokeInvite(code) {
    if (!confirm('Revoke this invite link?')) return;
    const res = await fetch(`/api/invites/channels/${encodeURIComponent(_currentSettingsRoom)}/${code}`, {
      method: 'DELETE',
      headers: { 'X-Session-Token': State.token }
    });
    if (res.ok) {
      UI.showToast('Invite revoked');
      fetchInvites(_currentSettingsRoom);
    } else {
      UI.showToast('Failed to revoke invite', 'error');
    }
  }

  function showChannelAbout(roomName = null) {
    const targetRoom = roomName || State.currentRoom;
    if (!targetRoom || String(targetRoom).startsWith('dm:')) {
      UI.showToast('Channel info is only available for channels', 'info');
      return;
    }

    const room = State.rooms.find(r => r.name === targetRoom);
    if (!room) {
      UI.showToast('Channel details unavailable', 'error');
      return;
    }

    const aboutTitle = document.getElementById('channel-about-title');
    const aboutDesc = document.getElementById('channel-about-description');
    const aboutImg = document.getElementById('channel-about-image');
    const aboutFallback = document.getElementById('channel-about-fallback');
    const aboutType = document.getElementById('channel-about-type');
    const aboutAccess = document.getElementById('channel-about-access');
    const aboutInvites = document.getElementById('channel-about-invites');
    const aboutOwner = document.getElementById('channel-about-owner');

    if (aboutTitle) aboutTitle.textContent = `#${room.name}`;
    if (aboutDesc) aboutDesc.textContent = room.description || 'No description yet.';

    if (aboutImg && aboutFallback) {
      if (isImageIcon(room.icon || '')) {
        aboutImg.src = room.icon;
        aboutImg.style.display = 'block';
        aboutFallback.style.display = 'none';
      } else {
        aboutImg.src = '';
        aboutImg.style.display = 'none';
        aboutFallback.style.display = 'block';
        aboutFallback.textContent = room.icon || defaultIconForType(room.type, room.channel_type || 'text');
      }
    }

    if (aboutType) {
      const channelType = room.channel_type === 'music' || room.channel_type === 'voice' ? 'Music' : 'Text';
      aboutType.textContent = `${channelType} • ${room.type === 'private' ? 'Private' : 'Public'}`;
    }

    if (aboutAccess) {
      aboutAccess.textContent = room.invite_only ? 'Invite only' : 'Open join';
    }

    if (aboutInvites) {
      const invitePolicy = room.who_can_invite || 'everyone';
      aboutInvites.textContent = invitePolicy === 'owner'
        ? 'Owner only'
        : (invitePolicy === 'mods' ? 'Moderators and owner' : 'Everyone');
    }

    if (aboutOwner) aboutOwner.textContent = room.owner_nickname || 'Unknown';

    // Show ⚙️ Manage button only to owner/mods/admins
    const manageBtn = document.getElementById('channel-about-manage-btn');
    if (manageBtn) {
      const myNick = State.user?.nickname;
      const isOwner = room.owner_nickname === myNick;
      const isMod = Array.isArray(room.mods) && room.mods.includes(myNick);
      const isAdmin = !!State.user?.is_admin;
      manageBtn.style.display = (isOwner || isMod || isAdmin) ? '' : 'none';
    }

    openModal('modal-channel-about');
  }

  // Re-render the channel sidebar (used by Mute.toggleRoom so 🔕 indicator
  // and `.is-muted` class reflect current state without a full reload).
  function renderMuteState() {
    try { renderRooms(); } catch {}
  }

  // Jump to a channel from a #room-mention inside a message.  Verifies the
  // channel still exists (deleted channels return 404), otherwise shows a
  // friendly toast.  The pill briefly flashes to give tactile feedback.
  async function openChannelLink(name) {
    if (!name) return;
    const raw = String(name).trim();
    // Visual feedback on the clicked pill (event.target isn't always the
    // pill — look it up by data-room).
    const pill = document.querySelector(`.room-mention[data-room="${CSS.escape(raw)}"]`);
    if (pill) {
      pill.classList.add('loading');
      setTimeout(() => { try { pill.classList.remove('loading'); } catch {} }, 1200);
    }
    // Close Frog Social if it's open so the channel takes over the view.
    try { if (window.Social && typeof Social.close === 'function') Social.close(); } catch {}
    // Fast path: it's already joined — just switch.
    const cached = (State.rooms || []).find(r => r.name === raw);
    if (cached && cached.joined) {
      switchToRoom(raw, 'public', null, cached.channel_type || 'text');
      return;
    }
    // Verify server-side so a deleted channel doesn't leave the user hanging.
    try {
      const res = await apiFetch(`/api/rooms/${encodeURIComponent(raw)}`);
      if (res.status === 404) {
        UI.showToast(`#${raw} was deleted`, 'error');
        if (pill) pill.classList.add('dead');
        return;
      }
      if (!res.ok) {
        UI.showToast(`Can't open #${raw}`, 'error');
        return;
      }
      const data = await res.json();
      const room = data.room || {};
      // Auto-join public channels so the link "just works".
      if (!room.is_private && !(cached && cached.joined)) {
        try {
          await apiFetch(`/api/rooms/${encodeURIComponent(raw)}/join`, 'POST');
        } catch {}
      }
      try { await loadRooms(); } catch {}
      switchToRoom(raw, 'public', null, room.channel_type || 'text');
    } catch {
      UI.showToast('Network error', 'error');
    }
  }

  return { 
    loadRooms, switchToRoom, openDM, showCreateRoom, createRoom, deleteRoom,
    joinRoom, leaveRoom,
    openChannelSettings, addModerator, removeModerator, unbanUser, saveChannelSettings, deleteChannelFromSettings,
    switchChannelTab,
    selectRoomType, selectChannelType, selectSettingsChannelType,
    triggerRoomIconUpload, handleCreateRoomIconSelect, handleChannelRoomIconSelect, handleChannelBannerSelect,
    handleChannelThemeBgUpload, clearChannelThemeBgImage,
    createInvite, revokeInvite, fetchInvites, showChannelAbout,
    saveVanity, clearVanity, copyVanityLink,
    renderMuteState, renderRooms, openChannelLink,
    cancelPrivateSecretPrompt, submitPrivateSecretPrompt,
    toggleSecretVisibility,
    openTransferOwnershipModal, onTransferOwnershipInput, confirmTransferOwnership,
    // Phase 2 key-rotation API used by ws.js + messages.js + settings UI.
    rotateRoomKey, installRotatedKey,
    aadForRoom: _aadForRoom,
    getRoomKeyForVersion: _getRoomKeyForVersion,
    getStoredKeyVersion: _getStoredKeyVersion
  };
})();

// expose to HTML onclick
function showCreateRoom() { Rooms.showCreateRoom(); }
function createRoom() { Rooms.createRoom(); }
function switchChannelTab(tab) { 
  Rooms.switchChannelTab(tab);
}
function addModerator() { Rooms.addModerator(); }
function saveChannelSettings() { Rooms.saveChannelSettings(); }
function deleteChannelFromSettings() { Rooms.deleteChannelFromSettings(); }
function selectRoomType(type) { Rooms.selectRoomType(type); }
function selectChannelType(type) { Rooms.selectChannelType(type); }
function selectSettingsChannelType(type) { Rooms.selectSettingsChannelType(type); }
function toggleSecretVisibility(inputId, buttonId) {
  if (window.Rooms && typeof Rooms.toggleSecretVisibility === 'function') {
    return Rooms.toggleSecretVisibility(inputId, buttonId);
  }
  // Fallback for mixed-cache situations where Rooms API is stale.
  const input = document.getElementById(inputId);
  const btn = document.getElementById(buttonId);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  if (btn) {
    btn.textContent = show ? '🙈' : '👁️';
    btn.setAttribute('aria-label', show ? 'Hide shared secret' : 'Show shared secret');
    btn.setAttribute('title', show ? 'Hide shared secret' : 'Show shared secret');
  }
}

function triggerRoomIconUpload(kind) { Rooms.triggerRoomIconUpload(kind); }
function handleCreateRoomIconSelect(input) { Rooms.handleCreateRoomIconSelect(input); }
function handleChannelRoomIconSelect(input) { Rooms.handleChannelRoomIconSelect(input); }
function handleChannelBannerSelect(input) { Rooms.handleChannelBannerSelect(input); }
function handleChannelThemeBgUpload(input) { Rooms.handleChannelThemeBgUpload(input); }
function clearChannelThemeBgImage() { Rooms.clearChannelThemeBgImage(); }
function showChannelAbout() { Rooms.showChannelAbout(); }

// Transfer-ownership modal hooks (HTML onclick targets).
function openTransferOwnershipModal() { Rooms.openTransferOwnershipModal(); }
function onTransferOwnershipInput() { Rooms.onTransferOwnershipInput(); }
function confirmTransferOwnership() { Rooms.confirmTransferOwnership(); }

function toggleNewRoomDirectoryFields() {
  const cb = document.getElementById('new-room-list-directory');
  const fields = document.getElementById('new-room-directory-fields');
  if (cb && fields) fields.style.display = cb.checked ? '' : 'none';
}

/* ── Channel Bots panel ─────────────────────────────────────────────────── */
async function loadChannelBotsPanel(roomName) {
  const list = document.getElementById('ch-bots-list');
  if (!list) return;
  list.innerHTML = '<div class="spinner-ring" style="display:block;margin:12px auto"></div>';
  try {
    const r = await fetch(`/api/developer/channels/${encodeURIComponent(roomName)}/bots`, { headers: { 'X-Session-Token': State.token } });
    const data = await r.json();
    const bots = data.bots || [];
    if (bots.length === 0) {
      list.innerHTML = '<div style="color:#666;font-size:13px;text-align:center;padding:16px">No bots in this channel yet</div>';
      return;
    }
    list.innerHTML = bots.map(b => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;border-bottom:1px solid #1a1a1a">
        <div style="display:flex;align-items:center;gap:10px">
          ${UI.avatarEl(b.avatar, b.name, 32)}
          <div>
            <div style="color:#e0e0e0;font-size:13px;font-weight:600">🤖 ${UI.escHtml(b.name)}</div>
            <div style="color:#666;font-size:11px">${UI.escHtml(b.description || 'No description')}</div>
          </div>
        </div>
        <button onclick="removeBotFromChannelPrompt(${b.id}, ${_jsStr(roomName)})" style="background:#2a1a1a;border:1px solid #4a2a2a;color:#f66;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">Remove</button>
      </div>`).join('');
  } catch { list.innerHTML = '<div style="color:#f44336;font-size:13px;text-align:center">Failed to load</div>'; }
}

async function removeBotFromChannelPrompt(botId, roomName) {
  if (!confirm('Remove this bot from the channel?')) return;
  try {
    const r = await fetch(`/api/developer/channels/${encodeURIComponent(roomName)}/bots/${botId}`, {
      method: 'DELETE', headers: { 'X-Session-Token': State.token }
    });
    if (r.ok) { UI.showToast('Bot removed', 'success'); loadChannelBotsPanel(roomName); }
    else { const d = await r.json().catch(()=>({})); UI.showToast(d.error || 'Failed', 'error'); }
  } catch { UI.showToast('Network error', 'error'); }
}

async function addBotByNameToRoom() {
  const name = prompt('Bot name (must be a public bot or one you own):');
  if (!name) return;
  // Look up bot id via public bots list
  try {
    const r = await fetch('/api/developer/bots/public', { headers: { 'X-Session-Token': State.token } });
    const data = await r.json();
    const bot = (data.bots || []).find(b => b.name.toLowerCase() === name.toLowerCase());
    if (!bot) { UI.showToast('Bot not found in public directory', 'error'); return; }
    await _addBotToCurrentChannel(bot.id);
  } catch { UI.showToast('Network error', 'error'); }
}

async function _addBotToCurrentChannel(botId) {
  const roomName = _getCurrentSettingsRoom();
  if (!roomName) return;
  try {
    const r = await fetch(`/api/developer/channels/${encodeURIComponent(roomName)}/bots/${botId}`, {
      method: 'POST', headers: { 'X-Session-Token': State.token }
    });
    if (r.ok) { UI.showToast('Bot added!', 'success'); loadChannelBotsPanel(roomName); }
    else { const d = await r.json().catch(()=>({})); UI.showToast(d.error || 'Failed', 'error'); }
  } catch { UI.showToast('Network error', 'error'); }
}

function _getCurrentSettingsRoom() {
  // Read from the open channel settings modal title (stored in room.js via _currentSettingsRoom)
  // Use the name field as the source of truth
  const nameEl = document.getElementById('ch-settings-name');
  return nameEl ? nameEl.value.trim() : null;
}

/* ── Bot Directory (browse public bots) ─────────────────────────────────── */
async function openBotDirectory() {
  let overlay = document.getElementById('bot-directory-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'bot-directory-overlay';
    overlay.className = 'modal-overlay';
    overlay.onclick = e => { if (e.target === overlay) overlay.classList.add('hidden'); };
    overlay.innerHTML = `
      <div class="modal" style="max-width:560px;width:100%;max-height:80vh;overflow-y:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div class="modal-title" style="margin:0">🤖 Bot Directory</div>
          <button class="social-close-btn" onclick="document.getElementById('bot-directory-overlay').classList.add('hidden')" style="position:static;font-size:20px">✕</button>
        </div>
        <div style="color:#888;font-size:13px;margin-bottom:12px">Browse public bots. Tap "Add" to install one in this channel.</div>
        <input class="modal-input" id="bot-dir-search" placeholder="🔍 Search bots by name…" oninput="filterBotDirectory()" style="margin-bottom:12px">
        <div id="bot-dir-list" style="display:flex;flex-direction:column;gap:8px"></div>
      </div>`;
    document.body.appendChild(overlay);
  }
  overlay.classList.remove('hidden');
  const list = document.getElementById('bot-dir-list');
  list.innerHTML = '<div class="spinner-ring lg" style="display:block;margin:24px auto"></div>';
  try {
    const r = await fetch('/api/developer/bots/public', { headers: { 'X-Session-Token': State.token } });
    const data = await r.json();
    window._botDirCache = data.bots || [];
    renderBotDirectory(window._botDirCache);
  } catch { list.innerHTML = '<div style="color:#f44336;text-align:center;padding:20px">Failed to load</div>'; }
}

function filterBotDirectory() {
  const q = (document.getElementById('bot-dir-search')?.value || '').toLowerCase().trim();
  const bots = (window._botDirCache || []).filter(b =>
    !q || b.name.toLowerCase().includes(q) || (b.description || '').toLowerCase().includes(q));
  renderBotDirectory(bots);
}

function renderBotDirectory(bots) {
  const list = document.getElementById('bot-dir-list');
  if (!list) return;
  if (!bots.length) { list.innerHTML = '<div style="color:#666;text-align:center;padding:20px">No bots match</div>'; return; }
  list.innerHTML = bots.map(b => `
    <div class="modal-card" style="display:flex;align-items:center;gap:12px;padding:10px 12px;margin-bottom:8px">
      ${UI.avatarEl(b.avatar, b.name, 40)}
      <div style="flex:1;min-width:0">
        <div style="color:#dff5e8;font-weight:700;font-size:14px">🤖 ${UI.escHtml(b.name)}</div>
        <div style="color:#85a89a;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${UI.escHtml(b.description || 'No description')}</div>
        <div style="color:#6a9a86;font-size:11px">by ${UI.escHtml(b.owner_name || 'unknown')}</div>
      </div>
      <button class="modal-btn primary" style="padding:6px 14px;flex:0 0 auto" onclick="_addBotToCurrentChannel(${b.id});document.getElementById('bot-directory-overlay').classList.add('hidden')">+ Add</button>
    </div>`).join('');
}

/* ── Channel Bridges panel ──────────────────────────────────────────────── */
async function loadChannelBridgesPanel(roomName) {
  const list = document.getElementById('ch-bridges-list');
  if (!list) return;
  list.innerHTML = '<div class="spinner-ring" style="display:block;margin:12px auto"></div>';
  try {
    const [tg, dc] = await Promise.all([
      fetch('/api/bridges', { headers: { 'X-Session-Token': State.token } }).then(r => r.json()).catch(() => ({ bridges: [] })),
      fetch('/api/discord-bridges', { headers: { 'X-Session-Token': State.token } }).then(r => r.json()).catch(() => ({ bridges: [] }))
    ]);
    const all = [
      ...(tg.bridges || []).filter(b => b.room_name === roomName).map(b => ({ ...b, _platform: 'telegram' })),
      ...(dc.bridges || []).filter(b => b.room_name === roomName).map(b => ({ ...b, _platform: 'discord' }))
    ];
    if (!all.length) {
      list.innerHTML = '<div style="color:#666;font-size:13px;text-align:center;padding:16px">No bridges yet</div>';
      return;
    }
    list.innerHTML = all.map(b => {
      const icon = b._platform === 'telegram' ? '✈️' : '💬';
      const label = b._platform === 'telegram' ? 'Telegram' : 'Discord';
      const external = b.telegram_chat_id || b.discord_channel_id || b.webhook_url || '(unknown)';
      const dir = (b.direction || 'both');
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px;border-bottom:1px solid #1a1a1a;gap:8px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">
          <span style="font-size:22px">${icon}</span>
          <div style="min-width:0">
            <div style="color:#e0e0e0;font-size:13px;font-weight:600">${label}</div>
            <div style="color:#666;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${UI.escHtml(String(external).slice(0, 60))}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <select class="bridge-dir-sel" data-id="${b.id}" title="Mirroring direction" style="background:#151515;border:1px solid #2a2a2a;color:#e0e0e0;padding:4px 6px;border-radius:6px;font-size:12px;cursor:pointer">
            <option value="both" ${dir==='both'?'selected':''}>↔ Two-way</option>
            <option value="in"   ${dir==='in'  ?'selected':''}>⬇ From ${label}</option>
            <option value="out"  ${dir==='out' ?'selected':''}>⬆ To ${label}</option>
          </select>
          <button class="bridge-remove-btn" data-id="${b.id}" data-platform="${b._platform}" data-room="${UI.escHtml(roomName)}" style="background:#2a1a1a;border:1px solid #4a2a2a;color:#f66;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">Remove</button>
        </div>
      </div>`;
    }).join('');
    // Bind remove buttons via event delegation — avoids any HTML-attribute
    // quoting pitfalls (the inline onclick with JSON-stringified args was
    // silently breaking with "Unexpected end of input").
    list.querySelectorAll('.bridge-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        removeChannelBridge(+btn.dataset.id, btn.dataset.platform, btn.dataset.room);
      });
    });
    // Direction selector — persist change to server.
    list.querySelectorAll('.bridge-dir-sel').forEach(sel => {
      sel.addEventListener('change', async () => {
        const id = +sel.dataset.id;
        const direction = sel.value;
        const prev = sel.getAttribute('data-last') || 'both';
        sel.setAttribute('data-last', direction);
        try {
          const r = await fetch(`/api/bridges/${id}/direction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
            body: JSON.stringify({ direction })
          });
          if (!r.ok) throw new Error();
          const dlabel = direction === 'both' ? 'Two-way' : (direction === 'in' ? 'Incoming only' : 'Outgoing only');
          UI.showToast('Bridge mode: ' + dlabel, 'success');
        } catch {
          sel.value = prev;
          UI.showToast('Failed to update direction', 'error');
        }
      });
    });
  } catch { list.innerHTML = '<div style="color:#f44336;font-size:13px;text-align:center">Failed to load</div>'; }
}

async function createChannelBridge() {
  const roomName = _getCurrentSettingsRoom();
  if (!roomName) { UI.showToast('No channel selected', 'error'); return; }
  const platform = document.getElementById('ch-bridge-platform')?.value || 'telegram';
  const external = document.getElementById('ch-bridge-external')?.value.trim() || '';
  const token = document.getElementById('ch-bridge-token')?.value.trim() || '';
  if (!external) { UI.showToast('External channel ID is required', 'error'); return; }

  try {
    let r;
    if (platform === 'telegram') {
      const chatId = parseInt(external, 10);
      if (isNaN(chatId)) { UI.showToast('Telegram chat ID must be a number (e.g. -1001234567890)', 'error'); return; }
      if (!token || token.length < 20 || !token.includes(':')) { UI.showToast('Telegram bot token required (format: 12345:ABC...)', 'error'); return; }
      r = await fetch('/api/bridges/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
        body: JSON.stringify({ room_name: roomName, telegram_chat_id: chatId, bot_token: token, bot_name: 'Telegram Bridge' })
      });
    } else {
      const chId = parseInt(external, 10);
      if (isNaN(chId)) { UI.showToast('Discord channel ID must be a number', 'error'); return; }
      r = await fetch('/api/discord-bridges/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
        body: JSON.stringify({ room_name: roomName, discord_channel_id: chId, bot_name: 'Discord Bridge' })
      });
    }
    if (r.ok) {
      UI.showToast('Bridge connected!', 'success');
      document.getElementById('ch-bridge-external').value = '';
      document.getElementById('ch-bridge-token').value = '';
      loadChannelBridgesPanel(roomName);
    } else {
      const d = await r.json().catch(()=>({}));
      UI.showToast(d.error || d.detail || 'Failed to create bridge', 'error');
    }
  } catch { UI.showToast('Network error', 'error'); }
}

/* ─── Easy Telegram bridge setup (invite-code flow) ─────────────────────── */
let _bridgeCodePollTimer = null;
let _discordBridgeCodePollTimer = null;
let _discordInviteMetaLoaded = false;

async function generateDiscordBridgeCode() {
  const roomName = _getCurrentSettingsRoom();
  if (!roomName) { UI.showToast('No channel selected', 'error'); return; }
  try {
    const r = await fetch('/api/discord-bridges/prepare-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ room_name: roomName, bot_name: 'Discord Bridge' })
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      UI.showToast(d.detail || d.error || 'Failed to generate Discord code', 'error');
      return;
    }
    const data = await r.json();
    const box = document.getElementById('ch-bridge-discord-code-box');
    if (box) box.style.display = 'block';
    const codeEl = document.getElementById('ch-bridge-discord-code');
    if (codeEl) codeEl.textContent = data.code;
    const st = document.getElementById('ch-bridge-discord-code-status');
    if (st) {
      st.textContent = '⏳ Waiting for your bridge command in Discord...';
      st.style.color = '#888';
    }
    _startDiscordBridgeCodePoll(data.code, roomName);
    try { box?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
    UI.showToast('Discord claim code ready', 'success');
  } catch {
    UI.showToast('Network error', 'error');
  }
}
window.generateDiscordBridgeCode = generateDiscordBridgeCode;

async function _copyDiscordBridgeCode(ev) {
  try {
    const codeEl = document.getElementById('ch-bridge-discord-code');
    // Read only the first text node to avoid picking up child element text
    const code = (codeEl?.firstChild?.nodeType === Node.TEXT_NODE
      ? codeEl.firstChild.textContent
      : codeEl?.textContent
    )?.trim() || '';
    if (!code || code === '------') return;
    const text = 'bridge ' + code;
    const copied = await UI.copy(text);
    if (!copied) throw new Error('clipboard failed');
    // ev.currentTarget is null for inline onclick — walk up from ev.target
    const line = ev?.currentTarget || ev?.target?.closest?.('.bridge-claim-line');
    if (line) {
      line.classList.add('copied');
      const copyEl = line.querySelector('.bridge-claim-copy');
      const orig = copyEl?.textContent;
      if (copyEl) copyEl.textContent = '✓ copied';
      setTimeout(() => {
        line.classList.remove('copied');
        if (copyEl && orig) copyEl.textContent = orig;
      }, 1400);
    }
    UI.showToast('Copied — now paste it in the Discord channel you want to bridge', 'success');
  } catch {
    UI.showToast('Could not copy — long-press to copy manually', 'error');
  }
}
window._copyDiscordBridgeCode = _copyDiscordBridgeCode;

async function _checkDiscordBridgeCodeNow() {
  const code = document.getElementById('ch-bridge-discord-code')?.textContent?.trim() || '';
  if (!code || code === '------') {
    UI.showToast('Generate a Discord claim code first', 'error');
    return;
  }
  const roomName = _getCurrentSettingsRoom();
  if (!roomName) { UI.showToast('No channel selected', 'error'); return; }

  const statusEl = document.getElementById('ch-bridge-discord-code-status');
  const checkBtn = document.getElementById('ch-bridge-discord-check-btn');
  if (checkBtn) checkBtn.disabled = true;
  if (statusEl) {
    statusEl.textContent = 'Checking Discord for your claim message...';
    statusEl.style.color = '#8fa3b6';
  }

  try {
    const r = await fetch(`/api/bridges/check-code/${encodeURIComponent(code)}`, {
      headers: { 'X-Session-Token': State.token }
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (statusEl) {
        statusEl.textContent = d.error || d.detail || 'Could not check code right now. Try again.';
        statusEl.style.color = '#f55';
      }
      UI.showToast(d.error || d.detail || 'Code check failed', 'error');
      return;
    }

    if (d.status === 'claimed') {
      if (statusEl) {
        statusEl.textContent = '✅ Discord bridge linked! Messages will now mirror.';
        statusEl.style.color = '#4caf50';
      }
      UI.showToast('Discord bridge connected!', 'success');
      loadChannelBridgesPanel(roomName);
      return;
    }

    if (d.status === 'expired') {
      if (statusEl) {
        statusEl.textContent = '⌛ Code expired. Generate a new one.';
        statusEl.style.color = '#f55';
      }
      UI.showToast('Claim code expired', 'error');
      return;
    }

    if (statusEl) {
      statusEl.textContent = 'Not detected yet. Post the code in the target Discord channel, then click this button again.';
      statusEl.style.color = '#caa56c';
    }
    UI.showToast('Code not detected yet', 'error');
  } catch {
    if (statusEl) {
      statusEl.textContent = 'Network error while checking code. Try again.';
      statusEl.style.color = '#f55';
    }
    UI.showToast('Network error', 'error');
  } finally {
    if (checkBtn) checkBtn.disabled = false;
  }
}
window._checkDiscordBridgeCodeNow = _checkDiscordBridgeCodeNow;

function _startDiscordBridgeCodePoll(code, roomName) {
  if (_discordBridgeCodePollTimer) clearInterval(_discordBridgeCodePollTimer);
  let tries = 0;
  _discordBridgeCodePollTimer = setInterval(async () => {
    tries++;
    if (tries > 60) {
      clearInterval(_discordBridgeCodePollTimer);
      const el = document.getElementById('ch-bridge-discord-code-status');
      if (el) { el.textContent = '⌛ Code expired or timed out. Generate a new one.'; el.style.color = '#f55'; }
      return;
    }
    try {
      const r = await fetch(`/api/bridges/check-code/${encodeURIComponent(code)}`, {
        headers: { 'X-Session-Token': State.token }
      });
      if (!r.ok) return;
      const d = await r.json();
      const el = document.getElementById('ch-bridge-discord-code-status');
      if (d.status === 'claimed') {
        clearInterval(_discordBridgeCodePollTimer);
        if (el) {
          el.textContent = '✅ Discord bridge linked automatically. Messages and media will now mirror.';
          el.style.color = '#4caf50';
        }
        UI.showToast('Discord bridge connected!', 'success');
        loadChannelBridgesPanel(roomName);
      } else if (d.status === 'expired') {
        clearInterval(_discordBridgeCodePollTimer);
        if (el) { el.textContent = '⌛ Code expired. Generate a new one.'; el.style.color = '#f55'; }
      }
    } catch {}
  }, 5000);
}

async function _loadDiscordBridgeInviteMeta() {
  if (_discordInviteMetaLoaded) return;
  const linkEl = document.getElementById('ch-discord-invite-link');
  const hintEl = document.getElementById('ch-discord-invite-hint');
  if (!linkEl) return;
  try {
    const r = await fetch('/api/discord-bridges/invite-meta', {
      headers: { 'X-Session-Token': State.token }
    });
    if (!r.ok) throw new Error('invite-meta failed');
    const d = await r.json();
    if (d && d.invite_url) {
      linkEl.href = d.invite_url;
      linkEl.style.opacity = '1';
      linkEl.style.pointerEvents = 'auto';
      linkEl.innerHTML = '<span>Invite FrogTalk Discord Bot</span><span style="opacity:.7">↗</span>';
      if (hintEl) hintEl.textContent = 'Open link, choose your server, approve permissions, then continue to step 2.';
      _discordInviteMetaLoaded = true;
      return;
    }
  } catch {}
  linkEl.href = '#';
  linkEl.style.opacity = '.65';
  linkEl.style.pointerEvents = 'none';
  linkEl.innerHTML = '<span>Invite link unavailable</span><span style="opacity:.7">↗</span>';
  if (hintEl) hintEl.textContent = 'Ask your FrogTalk admin for the Discord bot invite URL.';
}

function _onBridgePlatformChange() {
  const p = document.getElementById('ch-bridge-platform')?.value || 'telegram';
  const tg = document.getElementById('ch-bridge-tg-easy');
  const dc = document.getElementById('ch-bridge-discord');
  if (tg) tg.style.display = (p === 'telegram') ? 'block' : 'none';
  if (dc) dc.style.display = (p === 'discord')  ? 'block' : 'none';
  if (p === 'discord') {
    _loadDiscordBridgeInviteMeta();
  }
}
window._onBridgePlatformChange = _onBridgePlatformChange;

async function generateBridgeCode() {
  const roomName = _getCurrentSettingsRoom();
  if (!roomName) { UI.showToast('No channel selected', 'error'); return; }
  const ftToken = document.getElementById('ch-bridge-ft-token')?.value.trim() || '';
  if (!ftToken || ftToken.length < 8) {
    UI.showToast('Enter your FrogTalk bot API token (bot_xxx) from Developer settings', 'error');
    return;
  }
  try {
    const r = await fetch('/api/bridges/prepare-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ room_name: roomName, bot_token: ftToken, bot_name: 'Telegram Bridge' })
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      UI.showToast(d.detail || d.error || 'Failed to generate code', 'error');
      return;
    }
    const data = await r.json();
    const box = document.getElementById('ch-bridge-code-box');
    if (box) box.style.display = 'block';
    const codeEl = document.getElementById('ch-bridge-code');
    if (codeEl) codeEl.textContent = data.code;
    const st = document.getElementById('ch-bridge-code-status');
    if (st) { st.textContent = '⏳ Waiting for you to send it in Telegram…'; st.style.color = '#888'; }
    // Smooth-scroll the new code into view so the user sees it immediately
    try { box?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
    _startBridgeCodePoll(data.code, roomName);
  } catch { UI.showToast('Network error', 'error'); }
}
window.generateBridgeCode = generateBridgeCode;

async function _copyClaimCode(ev) {
  try {
    const code = document.getElementById('ch-bridge-code')?.textContent?.trim() || '';
    if (!code || code === '------') return;
    const text = '/claim ' + code;
    const copied = await UI.copy(text);
    if (!copied) throw new Error('clipboard failed');
    const line = ev?.currentTarget;
    if (line) {
      line.classList.add('copied');
      const copyEl = line.querySelector('.bridge-claim-copy');
      const orig = copyEl?.textContent;
      if (copyEl) copyEl.textContent = '✓ copied';
      setTimeout(() => {
        line.classList.remove('copied');
        if (copyEl && orig) copyEl.textContent = orig;
      }, 1400);
    }
    UI.showToast('Copied — now paste it in your Telegram group', 'success');
  } catch {
    UI.showToast('Could not copy — long-press to copy manually', 'error');
  }
}
window._copyClaimCode = _copyClaimCode;

function _startBridgeCodePoll(code, roomName) {
  if (_bridgeCodePollTimer) clearInterval(_bridgeCodePollTimer);
  let tries = 0;
  _bridgeCodePollTimer = setInterval(async () => {
    tries++;
    if (tries > 60) {
      clearInterval(_bridgeCodePollTimer);
      const el = document.getElementById('ch-bridge-code-status');
      if (el) { el.textContent = '⌛ Timed out. Generate a new code.'; el.style.color = '#f55'; }
      return;
    }
    try {
      const r = await fetch(`/api/bridges/check-code/${encodeURIComponent(code)}`, {
        headers: { 'X-Session-Token': State.token }
      });
      if (!r.ok) return;
      const d = await r.json();
      const el = document.getElementById('ch-bridge-code-status');
      if (d.status === 'claimed') {
        clearInterval(_bridgeCodePollTimer);
        if (el) { el.textContent = '✅ Bridge linked! Messages will now mirror.'; el.style.color = '#4caf50'; }
        UI.showToast('Telegram bridge connected!', 'success');
        loadChannelBridgesPanel(roomName);
      } else if (d.status === 'expired') {
        clearInterval(_bridgeCodePollTimer);
        if (el) { el.textContent = '⌛ Code expired. Generate a new one.'; el.style.color = '#f55'; }
      }
    } catch {}
  }, 5000);
}

async function removeChannelBridge(id, platform, roomName) {
  if (!confirm('Remove this bridge? Messages will stop mirroring.')) return;
  const url = platform === 'telegram' ? `/api/bridges/${id}` : `/api/discord-bridges/${id}`;
  try {
    const r = await fetch(url, { method: 'DELETE', headers: { 'X-Session-Token': State.token } });
    if (r.ok) { UI.showToast('Bridge removed', 'success'); loadChannelBridgesPanel(roomName); }
    else UI.showToast('Failed to remove', 'error');
  } catch { UI.showToast('Network error', 'error'); }
}

/* ── Channel Directory ─────────────────────────────────────────────────────── */
let _dirSearchTimer = null;

function _escapeHtml(s) {
  return UI.escHtml(s || '');
}

function _jsStr(s) {
  // Every call site drops the result into an HTML attribute wrapped in
  // double quotes (e.g. onclick="fn(${_jsStr(name)})"). JSON.stringify
  // produces raw " characters which broke attribute parsing and silently
  // killed every button that used this helper — Remove Bridge included.
  // Encode the quotes so the HTML parser decodes them back to " at the
  // attribute boundary, leaving valid JS for the click handler.
  return JSON.stringify(String(s || '')).replace(/"/g, '&quot;');
}

function _renderRichText(md) {
  let html = _escapeHtml(md || '');
  // Links first so later replacements don't break URL detection.
  html = html.replace(/https?:\/\/[^\s<]+/g, url =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#4caf50">${url}</a>`
  );
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`(.+?)`/g, '<code style="background:#1a1a1a;padding:1px 4px;border-radius:4px">$1</code>');
  html = html.replace(/^###\s+(.+)$/gm, '<h4 style="margin:8px 0 4px;color:#e0e0e0">$1</h4>');
  html = html.replace(/^##\s+(.+)$/gm, '<h3 style="margin:10px 0 4px;color:#e0e0e0">$1</h3>');
  html = html.replace(/^#\s+(.+)$/gm, '<h2 style="margin:12px 0 6px;color:#e0e0e0">$1</h2>');
  html = html.replace(/^(?:-\s+.+(?:\n|$))+?/gm, block => {
    const items = block.trim().split('\n').map(line => line.replace(/^-\s+/, '').trim());
    return `<ul style="margin:8px 0 8px 18px">${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
  });
  return html.replace(/\n/g, '<br>');
}

function _richTextToPlain(md) {
  const html = _renderRichText(md || '');
  const el = document.createElement('div');
  el.innerHTML = html;
  return (el.textContent || '').trim();
}

function applyListingFormat(cmd) {
  const ta = document.getElementById('listing-desc');
  if (!ta) return;
  const start = ta.selectionStart || 0;
  const end = ta.selectionEnd || 0;
  const value = ta.value || '';
  const selected = value.slice(start, end) || 'text';
  let replacement = selected;
  if (cmd === 'bold') replacement = `**${selected}**`;
  else if (cmd === 'italic') replacement = `*${selected}*`;
  else if (cmd === 'code') replacement = `\`${selected}\``;
  else if (cmd === 'h2') replacement = `## ${selected}`;
  else if (cmd === 'list') replacement = selected.split('\n').map(s => `- ${s}`).join('\n');
  else if (cmd === 'link') replacement = `${selected} https://`;
  ta.value = value.slice(0, start) + replacement + value.slice(end);
  ta.focus();
  ta.selectionStart = start;
  ta.selectionEnd = start + replacement.length;
}

async function showChannelDirectory() {
  let modal = document.getElementById('modal-directory');
  if (!modal) {
    const overlay = document.createElement('div');
    overlay.id = 'modal-directory';
    overlay.className = 'modal-overlay hidden';
    overlay.onclick = e => { if (e.target === overlay) overlay.classList.add('hidden'); };
    overlay.innerHTML = `
      <div class="modal dir-modal" style="max-width:720px;width:100%">
        <div class="dir-header">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:28px">🌐</span>
            <div>
              <div class="modal-title" style="margin:0;font-size:18px">Channel Directory</div>
              <div style="color:#9bbf9b;font-size:12px">Discover and join communities</div>
            </div>
          </div>
          <button class="social-close-btn" onclick="document.getElementById('modal-directory').classList.add('hidden')" style="position:static;font-size:20px">✕</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;position:relative">
          <div style="flex:1;min-width:200px;position:relative">
            <input class="modal-input" id="dir-search" placeholder="🔍 Search channels, tags…" style="width:100%;margin-bottom:0"
                   oninput="directoryAutoSearch()">
            <div id="dir-suggestions" class="dir-suggestions" style="display:none"></div>
          </div>
          <select class="modal-input" id="dir-category" style="width:160px;margin-bottom:0" onchange="searchDirectory()">
            <option value="">All Categories</option>
          </select>
        </div>
        <div id="dir-suggested" style="margin-bottom:16px"></div>
        <div id="dir-results" style="max-height:420px;overflow-y:auto"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    modal = overlay;
  }
  modal.classList.remove('hidden');

  // Always start with a clean loading state — never flash stale cached
  // channels from a previous open.  Skeleton cards keep the layout stable
  // so the modal doesn't visibly collapse and re-expand when results land.
  const _skeletonCard = `
    <div class="dir-card dir-skel" aria-hidden="true">
      <div class="dir-card-left"><div class="dir-card-icon-lg dir-skel-shimmer" style="border-radius:50%"></div></div>
      <div class="dir-card-body" style="flex:1">
        <div class="dir-skel-shimmer" style="height:16px;width:38%;border-radius:6px;margin-bottom:10px"></div>
        <div class="dir-skel-shimmer" style="height:12px;width:80%;border-radius:6px;margin-bottom:8px"></div>
        <div class="dir-skel-shimmer" style="height:12px;width:55%;border-radius:6px"></div>
      </div>
    </div>`;
  const _res = document.getElementById('dir-results');
  if (_res) _res.innerHTML = _skeletonCard + _skeletonCard + _skeletonCard;
  const _sug = document.getElementById('dir-suggested');
  if (_sug) _sug.innerHTML = '';
  const _searchEl = document.getElementById('dir-search');
  if (_searchEl) _searchEl.value = '';
  const _catEl = document.getElementById('dir-category');
  if (_catEl) _catEl.value = '';

  // Load categories
  try {
    const r = await fetch('/api/directory/categories', { headers: { 'X-Session-Token': State.token } });
    if (r.ok) {
      const data = await r.json();
      const sel = document.getElementById('dir-category');
      const catIcons = {gaming:'🎮',music:'🎵',art:'🎨',tech:'💻',social:'💬',education:'📚',memes:'😂',crypto:'💰',sports:'⚽',other:'📦'};
      sel.innerHTML = '<option value="">All Categories</option>' +
        data.categories.map(c => `<option value="${c}">${catIcons[c]||''} ${c}</option>`).join('');
    }
  } catch {}
  
  // Load suggested
  try {
    const r = await fetch('/api/directory/suggested', { headers: { 'X-Session-Token': State.token } });
    if (r.ok) {
      const data = await r.json();
      const sug = data.channels || [];
      const el = document.getElementById('dir-suggested');
      if (sug.length > 0) {
        el.innerHTML = `
          <div style="font-size:13px;font-weight:600;color:#888;margin-bottom:8px">✨ Suggested for you</div>
          <div class="dir-suggest-scroll">${sug.slice(0, 6).map(ch => renderDirectoryCard(ch, true)).join('')}</div>
        `;
      } else {
        el.innerHTML = '';
      }
    }
  } catch {}
  
  searchDirectory();
}

function renderDirectoryCard(ch, compact) {
  const esc = s => _escapeHtml(s);
  let tags = [];
  try { tags = typeof ch.tags === 'string' ? JSON.parse(ch.tags) : (ch.tags || []); } catch {}
  const catIcons = {gaming:'🎮',music:'🎵',art:'🎨',tech:'💻',social:'💬',education:'📚',memes:'😂',crypto:'💰',sports:'⚽',other:'📦'};
  const iconHtml = isImageIcon(ch.icon || '')
    ? `<img src="${esc(ch.icon)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
    : esc(ch.icon || '💬');
  // "Joined" vs "Join" state — check our local rooms list.
  const alreadyJoined = !!(State.rooms || []).find(r => r.name === ch.name && r.joined);
  
  if (compact) {
    return `<div class="dir-card-compact" onclick="viewChannelProfile(${_jsStr(ch.name)})">
      <div class="dir-card-icon">${iconHtml}</div>
      <div class="dir-card-name">${esc(ch.name)}</div>
      <div class="dir-card-meta">${ch.member_count || 0} members</div>
      ${ch.category ? `<div class="dir-card-cat">${catIcons[ch.category]||''} ${esc(ch.category)}</div>` : ''}
    </div>`;
  }
  
  const desc = ch.directory_description || ch.description || '';
  const plainDesc = _richTextToPlain(desc);
  return `<div class="dir-card" onclick="viewChannelProfile(${_jsStr(ch.name)})">
    <div class="dir-card-left">
      <div class="dir-card-icon-lg">${iconHtml}</div>
    </div>
    <div class="dir-card-body">
      <div class="dir-card-top">
        <span class="dir-card-title">${esc(ch.name)}</span>
        ${ch.category ? `<span class="dir-card-badge">${catIcons[ch.category]||''} ${esc(ch.category)}</span>` : ''}
        <span class="dir-card-members">👥 ${ch.member_count || 0}</span>
      </div>
      <div class="dir-card-desc">${esc(plainDesc.substring(0, 200))}${plainDesc.length > 200 ? '…' : ''}</div>
      ${tags.length ? `<div class="dir-card-tags">${tags.slice(0, 5).map(t => `<span class="dir-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      ${ch.owner_name ? `<div class="dir-card-owner">by ${ch.owner_avatar ? `<img src="${esc(ch.owner_avatar)}" style="width:14px;height:14px;border-radius:50%;vertical-align:middle;margin-right:2px">` : ''}${esc(ch.owner_name)}</div>` : ''}
    </div>
    <div class="dir-card-join">
      ${alreadyJoined
        ? `<button class="modal-btn" style="margin:0;padding:6px 16px;font-size:13px;background:#1a2a1a;color:#7fd97f;border:1px solid #2a4a2a;cursor:pointer" onclick="event.stopPropagation();Rooms.switchToRoom(${_jsStr(ch.name)}, 'public')">✓ Joined</button>`
        : `<button class="modal-btn primary" style="margin:0;padding:6px 16px;font-size:13px" onclick="event.stopPropagation();joinDirectoryChannel(${_jsStr(ch.name)})">Join</button>`}
    </div>
  </div>`;
}

async function searchDirectory() {
  const q = document.getElementById('dir-search')?.value || '';
  const cat = document.getElementById('dir-category')?.value || '';
  const el = document.getElementById('dir-results');
  if (!el) return;
  // Keep existing skeletons / results visible while refetching — only dim
  // them.  Fall back to a plain text placeholder if the area is empty.
  const _hadContent = el.children.length > 0;
  if (!_hadContent) {
    el.innerHTML = '<div style="text-align:center;padding:20px;color:#666">Loading...</div>';
  } else {
    el.style.opacity = '0.55';
    el.style.transition = 'opacity .15s ease';
  }
  
  try {
    const params = new URLSearchParams();
    if (q) params.set('search', q);
    if (cat) params.set('category', cat);
    const r = await fetch(`/api/directory/channels?${params}`, { headers: { 'X-Session-Token': State.token } });
    if (!r.ok) { el.style.opacity=''; el.innerHTML = '<div style="color:#f44336;padding:20px">Failed to load</div>'; return; }
    const data = await r.json();
    const channels = data.channels || [];

    if (!channels.length) {
      el.style.opacity = '';
      el.innerHTML = `<div style="text-align:center;padding:40px">
        <div style="font-size:48px;margin-bottom:12px">🔍</div>
        <div style="color:#888;font-size:15px">No channels found</div>
        <div style="color:#555;font-size:12px;margin-top:4px">Try a different search or category</div>
      </div>`;
      return;
    }

    el.innerHTML = channels.map(ch => renderDirectoryCard(ch, false)).join('');
    el.style.opacity = '';
  } catch (e) {
    el.style.opacity = '';
    el.innerHTML = '<div style="color:#f44336;padding:20px">Error loading directory</div>';
  }
}

async function joinDirectoryChannel(name) {
  try {
    const r = await fetch(`/api/rooms/${encodeURIComponent(name)}/join`, {
      method: 'POST',
      headers: { 'X-Session-Token': State.token }
    });
    if (r.ok) {
      document.getElementById('modal-directory')?.classList.add('hidden');
      await Rooms.loadRooms();
      Rooms.switchToRoom(name);
      UI.showToast(`Joined #${name}!`);
    } else {
      const d = await r.json().catch(() => ({}));
      UI.showToast(d.error || 'Failed to join', 'error');
    }
  } catch {
    UI.showToast('Failed to join channel', 'error');
  }
}

// Unified "Open channel" from any discovery surface (Frog Social explore
// cards, channel-profile modal, directory modal).  Responsibilities:
//   • If the viewer isn't a member yet, POST /join silently.
//   • Close every discovery overlay so the chat view is front-and-center.
//   • Switch to the room with a short loading flash on the triggering btn.
async function openChannelFromDiscovery(name, btnEl) {
  if (!name) return;
  // Visual feedback on the clicked button.
  let origHtml = '';
  if (btnEl && !btnEl.disabled) {
    origHtml = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.innerHTML = '<span style="display:inline-block;animation:spin 1s linear infinite">⏳</span> Opening…';
  }
  const restore = () => {
    if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = origHtml; }
  };
  try {
    const joined = (State.rooms || []).some(r => r.name === name && r.joined);
    if (!joined) {
      const r = await fetch(`/api/rooms/${encodeURIComponent(name)}/join`, {
        method: 'POST', headers: { 'X-Session-Token': State.token }
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        UI.showToast(d.error || `Couldn't join #${name}`, 'error');
        restore();
        return;
      }
      try { await Rooms.loadRooms(); } catch {}
      UI.showToast(`✓ Joined #${name}`);
    }
    // Close every discovery surface so the channel takes over.
    try { document.getElementById('channel-profile-overlay')?.remove(); } catch {}
    try { document.getElementById('modal-directory')?.classList.add('hidden'); } catch {}
    try { if (window.Social && typeof Social.close === 'function') Social.close(); } catch {}
    Rooms.switchToRoom(name, 'public');
  } catch {
    UI.showToast('Network error', 'error');
    restore();
  }
}

// ── Auto-search with debounce + suggestions dropdown ──────────────────────
function directoryAutoSearch() {
  const q = document.getElementById('dir-search')?.value || '';
  clearTimeout(_dirSearchTimer);
  const sugEl = document.getElementById('dir-suggestions');
  if (q.length < 1) {
    if (sugEl) sugEl.style.display = 'none';
    searchDirectory();
    return;
  }
  _dirSearchTimer = setTimeout(async () => {
    // Fetch lightweight suggestions
    try {
      const r = await fetch(`/api/directory/suggest?q=${encodeURIComponent(q)}`, { headers: { 'X-Session-Token': State.token } });
      if (r.ok) {
        const data = await r.json();
        const items = data.suggestions || [];
        if (items.length && sugEl) {
          const catIcons = {gaming:'🎮',music:'🎵',art:'🎨',tech:'💻',social:'💬',education:'📚',memes:'😂',crypto:'💰',sports:'⚽',other:'📦'};
          sugEl.innerHTML = items.map(s => {
            const iconHtml = isImageIcon(s.icon || '')
              ? `<img src="${UI.escHtml(s.icon)}" style="width:20px;height:20px;border-radius:50%;object-fit:cover">`
              : UI.escHtml(s.icon || '💬');
            return `<div class="dir-suggestion-item" onmousedown="directorySelectSuggestion(${_jsStr(s.name)})">
              <span>${iconHtml}</span>
              <span style="flex:1">${UI.escHtml(s.name)}</span>
              ${s.category ? `<span style="font-size:11px;color:#888">${catIcons[s.category]||''} ${UI.escHtml(s.category)}</span>` : ''}
              <span style="font-size:11px;color:#666">👥 ${s.member_count}</span>
            </div>`;
          }).join('');
          sugEl.style.display = 'block';
        } else if (sugEl) {
          sugEl.style.display = 'none';
        }
      }
    } catch {}
    // Also run full search
    searchDirectory();
  }, 250);
}

function directorySelectSuggestion(name) {
  const input = document.getElementById('dir-search');
  if (input) input.value = name;
  const sugEl = document.getElementById('dir-suggestions');
  if (sugEl) sugEl.style.display = 'none';
  // Open channel profile
  viewChannelProfile(name);
}

// ── Channel Profile Page ──────────────────────────────────────────────────
async function viewChannelProfile(channelName) {
  try {
    const r = await fetch(`/api/directory/channels/${encodeURIComponent(channelName)}/profile`, { headers: { 'X-Session-Token': State.token } });
    if (!r.ok) { UI.showToast('Channel not found', 'error'); return; }
    const ch = await r.json();

    let tags = [];
    try { tags = Array.isArray(ch.tags) ? ch.tags : JSON.parse(ch.tags || '[]'); } catch {}
    const catIcons = {gaming:'🎮',music:'🎵',art:'🎨',tech:'💻',social:'💬',education:'📚',memes:'😂',crypto:'💰',sports:'⚽',other:'📦'};
    const iconHtml = isImageIcon(ch.icon || '')
      ? `<img src="${UI.escHtml(ch.icon)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
      : UI.escHtml(ch.icon || '💬');
    const safeBanner = isSafeCssImageUrl(ch.banner || '') ? String(ch.banner).trim() : '';
    const desc = ch.directory_description || ch.description || '';
    const aboutText = ch.about || desc;
    const showListingHint = !!ch.is_owner && !!ch.about && !!desc && ch.about.trim() !== desc.trim();
    const alreadyJoined = !!(State.rooms || []).find(r => r.name === ch.name && r.joined);

    let overlay = document.getElementById('channel-profile-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'channel-profile-overlay';
      overlay.className = 'modal-overlay';
      overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
      document.body.appendChild(overlay);
    } else {
      overlay.classList.remove('hidden');
    }

    overlay.innerHTML = `
      <div class="modal ch-prof-modal">
        ${safeBanner ? `<div class="ch-prof-banner" style="background-image:url('${UI.escHtml(safeBanner)}')"></div>` : ''}
        <div class="ch-prof-body">
        <div class="ch-prof-head${ch.banner?' has-banner':''}">
          <div class="ch-prof-head-left">
            <div class="ch-prof-avatar">${iconHtml}</div>
            <div class="ch-prof-titlewrap">
              <div class="ch-prof-name">${UI.escHtml(ch.name)}</div>
              <div class="ch-prof-meta">
                ${ch.category ? `<span>${catIcons[ch.category]||''} ${UI.escHtml(ch.category)}</span>` : ''}
                <span>👥 ${ch.member_count || 0}</span>
                <span>❤️ <span id="ch-likes-count">${ch.like_count || 0}</span></span>
                <span>${ch.is_public ? '🌐 Public' : '🔒 Private'}</span>
              </div>
            </div>
          </div>
          <button class="ch-prof-close" onclick="document.getElementById('channel-profile-overlay').remove()" aria-label="Close">✕</button>
        </div>

        ${aboutText ? `<div class="ch-prof-about-label">About</div><div class="ch-prof-about">${_renderRichText(aboutText)}</div>` : ''}
        ${showListingHint ? `<div class="ch-prof-desc-hint">Directory listing description differs — <a href="#" onclick="editChannelListing(${_jsStr(ch.name)});return false;">Edit listing</a></div>` : ''}

        ${tags.length ? `<div class="ch-prof-tags">${tags.map(t => `<span class="dir-tag">${UI.escHtml(t)}</span>`).join('')}</div>` : ''}

        ${ch.owner_name ? `<div class="ch-prof-owner">
          <span>Created by</span>
          ${ch.owner_avatar ? `<img src="${UI.escHtml(ch.owner_avatar)}" class="ch-prof-owner-avatar">` : ''}
          <span class="ch-prof-owner-name" onclick="showUserInfo('${UI.escHtml(ch.owner_name)}')">${UI.escHtml(ch.owner_name)}</span>
        </div>` : ''}

        <div class="ch-prof-actions">
          ${alreadyJoined
            ? `<button type="button" class="modal-btn primary" onclick="openChannelFromDiscovery(${_jsStr(ch.name)}, this)">🚀 Open channel</button>`
            : `<button type="button" class="modal-btn primary" onclick="openChannelFromDiscovery(${_jsStr(ch.name)}, this)">Join</button>`}
          <button type="button" class="modal-btn ch-prof-secondary" id="ch-like-btn" onclick="toggleChannelLike(event, ${_jsStr(ch.name)})">${ch.liked_by_me ? '💔 Unlike' : '❤️ Like'}</button>
          ${ch.is_owner ? `<button type="button" class="modal-btn ch-prof-secondary" onclick="editChannelListing(${_jsStr(ch.name)})">✏️ Edit</button>` : ''}
        </div>

        <div class="ch-prof-comments">
          <div class="ch-prof-comments-title">💬 Comments</div>
          <div class="ch-prof-comments-row">
            <input class="modal-input" id="ch-comment-input" placeholder="Share your thoughts..." maxlength="2000">
            <button class="modal-btn primary" onclick="postChannelComment(${_jsStr(ch.name)})">Post</button>
          </div>
          <div id="ch-comments-list">
            ${(ch.recent_comments || []).map(c => _renderChannelComment(c, ch.name)).join('') || '<div class="ch-prof-empty">No comments yet — be the first!</div>'}
          </div>
        </div>
        </div>
      </div>
    `;
  } catch (e) {
    UI.showToast('Could not load channel profile', 'error');
  }
}

function _renderChannelComment(c, channelName) {
  const avatar = c.avatar ? `<img src="${UI.escHtml(c.avatar)}" class="ch-prof-cmt-avatar">` : `<div class="ch-prof-cmt-avatar ch-prof-cmt-avatar-fallback">🐸</div>`;
  const canDelete = (c.user_id === State.user.id) || State.user.is_admin;
  const delBtn = canDelete ? `<button type="button" class="ch-prof-cmt-del" title="Delete comment" aria-label="Delete comment" onclick="deleteChannelComment(${_jsStr(channelName)}, ${c.id})">🗑</button>` : '';
  const myVote = Number(c.my_vote || 0);
  const upCount = Number(c.like_count || 0);
  const downCount = Number(c.dislike_count || 0);
  const upActive = myVote === 1 ? ' is-up' : '';
  const downActive = myVote === -1 ? ' is-down' : '';
  return `<div class="ch-prof-cmt" data-comment-id="${c.id}">
    ${avatar}
    <div class="ch-prof-cmt-main">
      <div class="ch-prof-cmt-head">
        <span class="ch-prof-cmt-name" onclick="showUserInfo('${UI.escHtml(c.nickname)}')">${UI.escHtml(c.nickname)}</span>
        <span class="ch-prof-cmt-time">
          <span>${UI.formatDate ? UI.formatDate(c.created_at) : ''}</span>
          ${delBtn}
        </span>
      </div>
      <div class="ch-prof-cmt-body">${UI.escHtml(c.content)}</div>
      <div class="ch-prof-cmt-votes">
        <button type="button" class="ch-prof-vote-btn${upActive}" data-vote="up" onclick="voteChannelComment(event, ${_jsStr(channelName)}, ${c.id}, 1, this)" aria-label="Like comment">
          <span class="ch-prof-vote-icon">👍</span><span class="ch-prof-vote-count">${upCount}</span>
        </button>
        <button type="button" class="ch-prof-vote-btn${downActive}" data-vote="down" onclick="voteChannelComment(event, ${_jsStr(channelName)}, ${c.id}, -1, this)" aria-label="Dislike comment">
          <span class="ch-prof-vote-icon">👎</span><span class="ch-prof-vote-count">${downCount}</span>
        </button>
      </div>
    </div>
  </div>`;
}

async function voteChannelComment(ev, channelName, commentId, value, btn) {
  try { ev?.preventDefault?.(); ev?.stopPropagation?.(); } catch {}
  if (!btn || btn.dataset.pending === '1') return;
  const wrap = btn.closest('.ch-prof-cmt');
  if (!wrap) return;
  const upBtn = wrap.querySelector('.ch-prof-vote-btn[data-vote="up"]');
  const downBtn = wrap.querySelector('.ch-prof-vote-btn[data-vote="down"]');
  const upCountEl = upBtn?.querySelector('.ch-prof-vote-count');
  const downCountEl = downBtn?.querySelector('.ch-prof-vote-count');
  // Determine current state from class flags
  const wasUp = upBtn?.classList.contains('is-up');
  const wasDown = downBtn?.classList.contains('is-down');
  // Toggle: clicking the active direction clears (value -> 0)
  let newValue = value;
  if (value === 1 && wasUp) newValue = 0;
  if (value === -1 && wasDown) newValue = 0;
  // Optimistic UI
  const prevUp = Number(upCountEl?.textContent || '0');
  const prevDown = Number(downCountEl?.textContent || '0');
  let nextUp = prevUp;
  let nextDown = prevDown;
  if (wasUp && newValue !== 1) nextUp -= 1;
  if (!wasUp && newValue === 1) nextUp += 1;
  if (wasDown && newValue !== -1) nextDown -= 1;
  if (!wasDown && newValue === -1) nextDown += 1;
  if (upCountEl) upCountEl.textContent = String(Math.max(0, nextUp));
  if (downCountEl) downCountEl.textContent = String(Math.max(0, nextDown));
  upBtn?.classList.toggle('is-up', newValue === 1);
  downBtn?.classList.toggle('is-down', newValue === -1);
  if (upBtn) upBtn.dataset.pending = '1';
  if (downBtn) downBtn.dataset.pending = '1';
  try {
    const r = await fetch(`/api/directory/channels/${encodeURIComponent(channelName)}/comments/${commentId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ value: newValue })
    });
    if (!r.ok) throw new Error('vote failed');
    const d = await r.json();
    if (upCountEl) upCountEl.textContent = String(d.like_count || 0);
    if (downCountEl) downCountEl.textContent = String(d.dislike_count || 0);
    upBtn?.classList.toggle('is-up', Number(d.my_vote) === 1);
    downBtn?.classList.toggle('is-down', Number(d.my_vote) === -1);
  } catch {
    // Rollback
    if (upCountEl) upCountEl.textContent = String(prevUp);
    if (downCountEl) downCountEl.textContent = String(prevDown);
    upBtn?.classList.toggle('is-up', !!wasUp);
    downBtn?.classList.toggle('is-down', !!wasDown);
    UI.showToast('Could not vote', 'error');
  } finally {
    if (upBtn) delete upBtn.dataset.pending;
    if (downBtn) delete downBtn.dataset.pending;
  }
}

async function toggleChannelLike(ev, channelName) {
  try {
    ev?.preventDefault?.();
    ev?.stopPropagation?.();
  } catch {}
  const btn = document.getElementById('ch-like-btn');
  if (!btn || btn.dataset.pending === '1') return;
  const countEl = document.getElementById('ch-likes-count');
  const wasLiked = btn.textContent.includes('Unlike');
  const prevCount = countEl ? Number(countEl.textContent || '0') : 0;
  // Optimistic channel like toggle so the modal feels instant.
  btn.dataset.pending = '1';
  btn.style.opacity = '0.75';
  btn.textContent = wasLiked ? '❤️ Like' : '💔 Unlike';
  if (countEl) countEl.textContent = String(Math.max(0, prevCount + (wasLiked ? -1 : 1)));
  try {
    const r = await fetch(`/api/directory/channels/${encodeURIComponent(channelName)}/like`, {
      method: wasLiked ? 'DELETE' : 'POST',
      headers: { 'X-Session-Token': State.token }
    });
    if (r.ok) {
      const d = await r.json();
      btn.textContent = d.liked ? '💔 Unlike' : '❤️ Like';
      if (countEl) countEl.textContent = d.like_count;
    } else {
      btn.textContent = wasLiked ? '💔 Unlike' : '❤️ Like';
      if (countEl) countEl.textContent = String(prevCount);
      UI.showToast('Could not update like', 'error');
    }
  } catch {
    btn.textContent = wasLiked ? '💔 Unlike' : '❤️ Like';
    if (countEl) countEl.textContent = String(prevCount);
    UI.showToast('Could not update like', 'error');
  } finally {
    delete btn.dataset.pending;
    btn.style.opacity = '';
  }
}

async function postChannelComment(channelName) {
  const input = document.getElementById('ch-comment-input');
  const content = (input?.value || '').trim();
  if (!content) return;
  try {
    const r = await fetch(`/api/directory/channels/${encodeURIComponent(channelName)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ content })
    });
    if (r.ok) {
      if (input) input.value = '';
      // Reload comments
      const lr = await fetch(`/api/directory/channels/${encodeURIComponent(channelName)}/comments?limit=10`, { headers: { 'X-Session-Token': State.token } });
      if (lr.ok) {
        const ld = await lr.json();
        const list = document.getElementById('ch-comments-list');
        if (list) list.innerHTML = (ld.comments || []).map(c => _renderChannelComment(c, channelName)).join('') || '<div style="color:#666;font-size:13px;text-align:center;padding:20px">No comments yet</div>';
      }
    } else {
      const d = await r.json().catch(()=>({}));
      UI.showToast(d.error || 'Failed to post comment', 'error');
    }
  } catch { UI.showToast('Network error', 'error'); }
}

async function deleteChannelComment(channelName, commentId) {
  if (!confirm('Delete this comment?')) return;
  try {
    const r = await fetch(`/api/directory/channels/${encodeURIComponent(channelName)}/comments/${commentId}`, {
      method: 'DELETE',
      headers: { 'X-Session-Token': State.token }
    });
    if (r.ok) {
      // Refresh
      const lr = await fetch(`/api/directory/channels/${encodeURIComponent(channelName)}/comments?limit=10`, { headers: { 'X-Session-Token': State.token } });
      if (lr.ok) {
        const ld = await lr.json();
        const list = document.getElementById('ch-comments-list');
        if (list) list.innerHTML = (ld.comments || []).map(c => _renderChannelComment(c, channelName)).join('') || '<div style="color:#666;font-size:13px;text-align:center;padding:20px">No comments yet</div>';
      }
    }
  } catch {}
}

// ── Edit Channel Listing (owner ad/profile editor) ────────────────────────
async function editChannelListing(channelName) {
  document.getElementById('channel-profile-overlay')?.remove();
  
  // Fetch current profile
  let ch;
  try {
    const r = await fetch(`/api/directory/channels/${encodeURIComponent(channelName)}/profile`, { headers: { 'X-Session-Token': State.token } });
    if (!r.ok) return;
    ch = await r.json();
  } catch { return; }

  let tags = [];
  try { tags = Array.isArray(ch.tags) ? ch.tags : JSON.parse(ch.tags || '[]'); } catch {}

  const overlay = document.createElement('div');
  overlay.id = 'channel-listing-editor';
  overlay.className = 'modal-overlay';
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  const catIcons = {gaming:'🎮',music:'🎵',art:'🎨',tech:'💻',social:'💬',education:'📚',memes:'😂',crypto:'💰',sports:'⚽',other:'📦'};
  const catOptions = ['gaming','music','art','tech','social','education','memes','crypto','sports','other']
    .map(c => `<option value="${c}" ${ch.category === c ? 'selected' : ''}>${catIcons[c]} ${c}</option>`).join('');

  overlay.innerHTML = `
    <div class="modal" style="max-width:560px;width:100%;animation:slideUp .3s ease">
      <div class="modal-title" style="font-size:18px">✏️ Edit Channel Listing</div>
      <div style="color:#888;font-size:13px;margin-bottom:16px">Customize how <strong>${UI.escHtml(channelName)}</strong> appears in the directory</div>
      
      <label style="font-size:13px;color:#aaa;margin-bottom:4px;display:block">Category</label>
      <select class="modal-input" id="listing-category" style="margin-bottom:12px">
        <option value="">None</option>
        ${catOptions}
      </select>

      <label style="font-size:13px;color:#aaa;margin-bottom:4px;display:block">Directory Description</label>
      <div class="listing-toolbar" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
        <button type="button" class="modal-btn" style="padding:4px 10px" onclick="applyListingFormat('bold')"><strong>B</strong></button>
        <button type="button" class="modal-btn" style="padding:4px 10px" onclick="applyListingFormat('italic')"><em>I</em></button>
        <button type="button" class="modal-btn" style="padding:4px 10px" onclick="applyListingFormat('code')">Code</button>
        <button type="button" class="modal-btn" style="padding:4px 10px" onclick="applyListingFormat('h2')">H2</button>
        <button type="button" class="modal-btn" style="padding:4px 10px" onclick="applyListingFormat('list')">List</button>
        <button type="button" class="modal-btn" style="padding:4px 10px" onclick="applyListingFormat('link')">Link</button>
      </div>
      <textarea class="modal-input" id="listing-desc" rows="5" style="margin-bottom:12px;resize:vertical;min-height:100px" placeholder="Describe your channel for the directory… Supports rich formatting">${UI.escHtml(ch.directory_description || '')}</textarea>
      <div style="font-size:11px;color:#777;margin:-6px 0 10px">Formatting: **bold**, *italic*, \`code\`, # headings, - list items, and links.</div>

      <label style="font-size:13px;color:#aaa;margin-bottom:4px;display:block">Tags (comma separated, max 10)</label>
      <input class="modal-input" id="listing-tags" value="${UI.escHtml(tags.join(', '))}" placeholder="gaming, fun, community" style="margin-bottom:16px">

      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="modal-btn" onclick="document.getElementById('channel-listing-editor').remove()">Cancel</button>
        <button class="modal-btn primary" onclick="saveChannelListing(${_jsStr(channelName)})">Save Listing</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function saveChannelListing(channelName) {
  const desc = document.getElementById('listing-desc')?.value || '';
  const category = document.getElementById('listing-category')?.value || '';
  const tagsRaw = document.getElementById('listing-tags')?.value || '';
  const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 10);

  try {
    const r = await fetch(`/api/directory/channels/${encodeURIComponent(channelName)}/listing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ directory_description: desc, category, tags })
    });
    if (r.ok) {
      UI.showToast('Listing updated!', 'success');
      document.getElementById('channel-listing-editor')?.remove();
    } else {
      const d = await r.json().catch(() => ({}));
      UI.showToast(d.error || 'Failed to update', 'error');
    }
  } catch {
    UI.showToast('Network error', 'error');
  }
}

function selectServer(s) {
  // Minimal server switching — future expansion point
  document.querySelectorAll('.server-icon').forEach(el => el.classList.remove('active'));
  const icons = { main: 0, dms: 1 };
  document.querySelectorAll('.server-icon')[icons[s] || 0]?.classList.add('active');

  // Hide/show unified call button based on view (DMs only).
  const showCalls = s === 'dms';
  document.getElementById('call-voice-btn')?.style && (document.getElementById('call-voice-btn').style.display = showCalls ? '' : 'none');
  
  // Show encrypt button only for DMs
  const encryptBtn = document.getElementById('encrypt-btn');
  if (encryptBtn) encryptBtn.style.display = showCalls ? '' : 'none';

  // Voice join button: available in channel views only. DMs have their own
  // unified 📞 call button (camera can be toggled mid-call) and pressing 🔊
  // there just produces a confusing "join voice channel" error — hide in DMs.
  const voiceJoinBtn = document.getElementById('voice-join-btn');
  if (voiceJoinBtn) {
    const hideVoice = window._voiceRoom || s === 'dms';
    voiceJoinBtn.style.display = hideVoice ? 'none' : '';
  }

  // Share / invite-link button lives in the ⋯ overflow menu now — keep it
  // hidden from the header in every view.
  const shareBtn = document.getElementById('share-channel-btn');
  if (shareBtn) shareBtn.style.display = 'none';

  // Auto-open last active DM when switching to DMs
  if (s === 'dms' && typeof _activeDM !== 'undefined' && !_activeDM && typeof _dmChannels !== 'undefined' && _dmChannels.length > 0) {
    const last = _dmChannels[0];
    openDMChannel(last.id, last.nickname, last.avatar || '🐸');
  }
}

async function quickShareChannel() {
  const room = State.currentRoom;
  if (!room) return;
  // Create a quick invite (unlimited uses, 7 day expiry)
  try {
    const res = await fetch(`/api/invites/channels/${encodeURIComponent(room)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ max_uses: 0, expires_hours: 168 })
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      UI.showToast(d.error || 'Cannot create invite for this channel', 'error');
      return;
    }
    const data = await res.json();
    if (await UI.copy(data.url)) {
      UI.showToast('Invite link copied! (7 day, unlimited uses)');
    } else {
      // Clipboard blocked — surface the link so the user can copy it manually.
      window.prompt('Copy this invite link:', data.url);
    }
  } catch (e) {
    UI.showToast('Failed to create invite', 'error');
  }
}

// ---------------------------------------------------------------------------
// Channel Theme
// ---------------------------------------------------------------------------
let _channelThemeStyleEl = null;

async function loadChannelTheme(roomName) {
  const room = roomName || State.currentRoom;
  if (!room) return;
  try {
    const res = await apiFetch(`/api/rooms/${encodeURIComponent(room)}`);
    const data = await res.json();
    const theme = data.room?.channel_theme;
    if (theme) {
      try {
        const t = JSON.parse(theme);
        document.getElementById('ch-theme-bg').value = t.bg || '#0d0d0d';
        document.getElementById('ch-theme-text').value = t.text || '#e0e0e0';
        document.getElementById('ch-theme-accent').value = t.accent || '#4caf50';
        document.getElementById('ch-theme-bg-image').value = t.bgImage || '';
        document.getElementById('ch-theme-css').value = t.css || '';
      } catch {}
    } else {
      document.getElementById('ch-theme-bg').value = '#0d0d0d';
      document.getElementById('ch-theme-text').value = '#e0e0e0';
      document.getElementById('ch-theme-accent').value = '#4caf50';
      document.getElementById('ch-theme-bg-image').value = '';
      document.getElementById('ch-theme-css').value = '';
    }
  } catch {}
}

function previewChannelTheme() {
  const bg = document.getElementById('ch-theme-bg').value;
  const text = document.getElementById('ch-theme-text').value;
  const accent = document.getElementById('ch-theme-accent').value;
  const bgImage = document.getElementById('ch-theme-bg-image').value.trim();
  const css = document.getElementById('ch-theme-css').value.trim();
  applyChannelThemeOverride({ bg, text, accent, bgImage, css });

  // Dry-run the custom CSS through the same client-side sanitizer the
  // production renderer uses so owners learn IMMEDIATELY (during
  // preview) that a rule was stripped, instead of waiting for a 400
  // from the server on save. Surfaces a friendly toast with the
  // reason(s).
  if (css && window.Css && typeof Css.sanitizeScopedCssWithReport === 'function') {
    try {
      const { rejections } = Css.sanitizeScopedCssWithReport(css, '#main');
      if (rejections && rejections.length) {
        const first = rejections[0];
        const more = rejections.length > 1 ? ` (+${rejections.length - 1} more)` : '';
        const detail = first.selector
          ? `'${first.selector}': ${first.reason}`
          : first.reason;
        UI.showToast(
          `Some CSS was stripped — ${detail}${more}. Open the console for the full list.`,
          'warn'
        );
        return;
      }
    } catch {}
  }
  UI.showToast('Preview applied — save channel settings to keep');
}

function resetChannelTheme() {
  document.getElementById('ch-theme-bg').value = '#0d0d0d';
  document.getElementById('ch-theme-text').value = '#e0e0e0';
  document.getElementById('ch-theme-accent').value = '#4caf50';
  document.getElementById('ch-theme-bg-image').value = '';
  document.getElementById('ch-theme-css').value = '';
  clearChannelThemeOverride();
  UI.showToast('Channel theme reset');
}

function applyChannelThemeOverride(t) {
  clearChannelThemeOverride();
  if (!t) return;
  let css = '';
  if (t.bg) css += `#main { background: ${t.bg} !important; }\n`;
  if (t.text) css += `#messages-area .msg-content { color: ${t.text} !important; }\n`;
  if (t.accent) css += `.msg-author { color: ${t.accent} !important; }\n`;
  if (t.bgImage) {
    // Sanitize: only allow http(s) URLs OR same-origin absolute paths
    // (which is what /api/rooms/<name>/theme-bg?v=<mtime> uploads return).
    // Anything else — javascript:, data:, file:, embedded ')' to break
    // out of the url() — is rejected.
    const safeBgImage = (() => {
      const v = String(t.bgImage || '').trim();
      if (!v) return '';
      if (/[)\\\s'"<>]/.test(v)) return '';
      if (/^https?:\/\//i.test(v)) return v;
      if (/^\/[A-Za-z0-9._\-/?=&%]+$/.test(v)) return v;
      return '';
    })();
    if (safeBgImage) {
      css += `#messages-area { background-image: url('${safeBgImage}'); background-size: cover; background-position: center; background-attachment: fixed; }\n`;
    }
  }
  if (t.css) {
    // Channel theme custom CSS, scoped to #main. See Css.sanitizeScopedCss
    // in state.js for the comma-bridge / hex-escape / position:fixed
    // rejection rules.
    try { css += (window.Css?.sanitizeScopedCss?.(t.css, '#main') || ''); } catch {}
  }
  if (css) {
    _channelThemeStyleEl = document.createElement('style');
    _channelThemeStyleEl.id = 'channel-theme-override';
    _channelThemeStyleEl.textContent = css;
    document.head.appendChild(_channelThemeStyleEl);
  }
}

function clearChannelThemeOverride() {
  if (_channelThemeStyleEl) { _channelThemeStyleEl.remove(); _channelThemeStyleEl = null; }
  const existing = document.getElementById('channel-theme-override');
  if (existing) existing.remove();
}
