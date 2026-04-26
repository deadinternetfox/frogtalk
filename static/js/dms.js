/* ─── dms.js ──────────────────────────────────────────────────────────────── */
'use strict';

let _dmChannels  = [];    // [{id, with_user_id, nickname, avatar, unread, last_msg}]
let _activeDM    = null;  // {id, nickname, avatar, user_id}
let _dmMessages  = [];    // local cache for active DM
let _dmPage      = 0;
const DM_PER_PAGE = 50;
let _dmTypingTimer = null;
let _dmReplyTo   = null;  // {id, content, nickname}
const _dmPeerPubKeyCache = new Map();
const _dmSharedKeyCache = new Map();
let _dmLoadReqSeq = 0;
const _dmHistoryCache = new Map();
const _dmHistoryMeta = new Map();

function _normalizeDMMessage(message) {
  if (!message) return message;
  const normalized = { ...message };
  if (Number(normalized.id || 0) > 0) {
    delete normalized._pending;
    delete normalized._nonce;
  }
  return normalized;
}

function _sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function _fetchWithTimeout(url, timeoutMs) {
  return Promise.race([
    apiFetch(url),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
  ]);
}

async function _fetchDMPageResilient(url, attempts = 2, timeoutMs = 25000) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await _fetchWithTimeout(url, timeoutMs);
      // Retry once on transient server errors; leave auth/4xx alone.
      if (res && !res.ok && res.status >= 500 && i < attempts - 1) {
        await _sleep(250 * (i + 1));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i >= attempts - 1) break;
      await _sleep(250 * (i + 1));
    }
  }
  throw lastErr || new Error('fetch_failed');
}

async function _repairActiveDMChannelId() {
  if (!_activeDM?.nickname) return false;
  try {
    const r = await apiFetch('/api/dms');
    if (!r || !r.ok) return false;
    const data = await r.json();
    const channels = data.channels || data || [];
    const targetNick = String(_activeDM.nickname || '').toLowerCase();
    const match = channels.find(ch => {
      const nick = String(ch.other_nick || ch.nickname || '').toLowerCase();
      return !!nick && nick === targetNick;
    });
    const nextId = Number(match?.id || 0);
    if (!nextId) return false;
    const curId = Number(_activeDM.id || 0);
    if (nextId === curId) return false;
    _activeDM.id = nextId;
    return true;
  } catch {
    return false;
  }
}

function _voSeenKey(msgId, channelId) {
  const uid = STATE.user?.id || '0';
  return `ft_dm_vo_seen:${uid}:${channelId || 0}:${msgId}`;
}

function _isViewOnceSeenLocal(msgId, channelId) {
  try { return localStorage.getItem(_voSeenKey(msgId, channelId)) === '1'; } catch { return false; }
}

function _markViewOnceSeenLocal(msgId, channelId) {
  try { localStorage.setItem(_voSeenKey(msgId, channelId), '1'); } catch {}
}

function _parseDMCallLog(content) {
  if (typeof content !== 'string' || !content.startsWith('[[CALLLOG]]')) return null;
  try { return JSON.parse(content.slice('[[CALLLOG]]'.length)); } catch { return null; }
}

function _looksEncryptedBlob(content) {
  if (typeof content !== 'string') return false;
  const s = content.trim();
  if (!s || s.length < 40) return false;
  if (s.startsWith('[[CALLLOG]]')) return false;
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const keys = Object.keys(obj).map(k => String(k).toLowerCase());
        const hasEncKeys = keys.includes('iv') || keys.includes('ciphertext') || keys.includes('ct') || keys.includes('tag') || keys.includes('salt');
        if (hasEncKeys) return true;
      }
    } catch {
      // Non-JSON payloads that begin with { or [ are not treated as encrypted by this branch.
    }
    return false;
  }
  if (/\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return false;
  return /^[A-Za-z0-9+/_=-]+$/.test(s);
}

function _dmPreviewText(content, hasMedia, mediaType) {
  const c = _parseDMCallLog(content);
  if (c) return c.subtitle || c.title || 'Call update';
  if (content) return content;
  return (hasMedia || mediaType) ? 'Media' : '';
}

async function _getDMSharedKey(peerId) {
  const id = Number(peerId || 0);
  if (!id) return null;
  if (_dmSharedKeyCache.has(id)) return _dmSharedKeyCache.get(id);
  let peerPub = _dmPeerPubKeyCache.get(id) || null;
  if (!peerPub) {
    try {
      const r = await apiFetch(`/api/users/${id}/pubkey`);
      if (!r.ok) return null;
      const d = await r.json();
      peerPub = d.ecdh_pub_key || d.pub_key || null;
      if (peerPub) _dmPeerPubKeyCache.set(id, peerPub);
    } catch {
      return null;
    }
  }
  if (!peerPub || typeof Crypto === 'undefined' || !Crypto.deriveShared) return null;
  try {
    const key = await Crypto.deriveShared(peerPub);
    if (key) _dmSharedKeyCache.set(id, key);
    return key || null;
  } catch {
    return null;
  }
}

async function _decryptDMPreviewContent(cipher, peerId, peerNick) {
  const raw = String(cipher || '');
  if (!raw) return '';
  if (_parseDMCallLog(raw)) return raw;

  // Primary path: ECDH shared key for this peer.
  try {
    const key = await _getDMSharedKey(peerId);
    if (key && typeof Crypto !== 'undefined' && Crypto.decrypt) {
      const out = await Crypto.decrypt(raw, key);
      if (out !== null) return out;
    }
  } catch {}

  // Legacy fallback: deterministic DM key derivation.
  try {
    if (typeof Crypto !== 'undefined' && Crypto.getDMKey && Crypto.decrypt && STATE?.user?.nickname && peerNick) {
      const legacyKey = await Crypto.getDMKey(STATE.user.nickname, peerNick);
      const out = await Crypto.decrypt(raw, legacyKey);
      if (out !== null) return out;
    }
  } catch {}

  // If decrypt fails and this still looks like ciphertext, do not leak it in UI.
  return _looksEncryptedBlob(raw) ? '' : raw;
}

/* ── Sidebar DM list ────────────────────────────────────────────────────────── */
async function loadDMChannels () {
  const sidebarEl = document.getElementById('dm-channels');
  if (sidebarEl && !_dmChannels.length) {
    sidebarEl.innerHTML = `<div style="padding:6px 8px"><span class="skel-line" style="width:70%;height:10px;display:block;margin-bottom:6px"></span><span class="skel-line" style="width:50%;height:10px;display:block"></span></div>`;
  }
  try {
    const r = await apiFetch('/api/dms');
    if (!r.ok) return;
    const data = await r.json();
    _dmChannels = await Promise.all((data.channels || data || []).map(async (ch) => {
      const peerNick = ch.other_nick || ch.nickname || '';
      const peerId = ch.other_id || ch.with_user_id || 0;
      const previewContent = await _decryptDMPreviewContent(ch.last_msg, peerId, peerNick);
      const _logMeta = _parseDMCallLog(previewContent);
      return {
        id: ch.id,
        nickname: peerNick,
        avatar: ch.other_avatar || ch.avatar || '🐸',
        unread: ch.unread || 0,
        last_msg_raw: previewContent,
        last_msg_meta: _logMeta,
        last_msg: _dmPreviewText(previewContent, false, null),
        last_msg_at: ch.last_msg_at,
        last_msg_id: ch.last_msg_id || 0,
        last_sender_id: ch.last_sender_id != null ? +ch.last_sender_id : null,
        my_last_read: ch.my_last_read || 0,
        peer_last_read: ch.peer_last_read || 0,
        other_last_seen: ch.other_last_seen || null,
        other_show_read_receipts: ch.other_show_read_receipts !== 0,
        with_user_id: peerId,
      };
    }));
    renderDMChannels();
  } catch (e) { console.error('loadDMChannels', e); }
}

async function hideDMChannel (channelId) {
  try {
    const r = await apiFetch(`/api/dms/${channelId}/hide`, 'POST');
    if (r.ok) {
      _dmChannels = _dmChannels.filter(c => c.id !== channelId);
      if (_activeDM?.id === channelId) {
        _activeDM = null;
        selectServer('general');
      }
      renderDMChannels();
      toast('Conversation hidden', 'info');
    }
  } catch (e) { console.error('hideDMChannel', e); }
}

async function wipeDMMessages () {
  if (!_activeDM) return;
  if (!confirm('Delete ALL messages in this conversation? This cannot be undone.')) return;
  try {
    const r = await apiFetch(`/api/dms/${_activeDM.id}/messages`, 'DELETE');
    if (r.ok) {
      _dmMessages = [];
      renderDMChat();
      toast('All messages wiped', 'info');
    } else {
      const d = await r.json().catch(() => ({}));
      toast(d.error || 'Failed to wipe messages', 'error');
    }
  } catch (e) { console.error('wipeDMMessages', e); }
}

function renderDMChannels () {
  // Also refresh global unread badge on the sidebar 💬 icon
  try { if (typeof updateFrogBadge === 'function') updateFrogBadge(); } catch {}
  const el = document.getElementById('dm-channels');
  if (!el) return;
  if (!_dmChannels.length) {
    el.innerHTML = '<div style="font-size:12px;color:#555;padding:4px 8px">No DMs yet</div>';
    return;
  }
  el.innerHTML = _dmChannels.map(ch => {
    const avHtml = fmtAv(ch.avatar, ch.nickname, 28);
    const avArg = JSON.stringify(ch.avatar || '');
    const nkArg = JSON.stringify(ch.nickname || '');
    // Prefer the actual last message as the preview line; fall back to
    // "last seen" presence text only when no message history exists yet.
    const mySelfId = (typeof STATE !== 'undefined' && STATE.user?.id) || (State.user?.id);
    const isMine = ch.last_sender_id != null && mySelfId != null && +ch.last_sender_id === +mySelfId;
    const isMissedCall = ch.last_msg_meta?.kind === 'missed';
    const isCallLog = ch.last_msg_meta != null;
    const previewIcon = isMissedCall ? '<span class="dm-row-preview-icon" title="Missed call">📵</span>' : '';
    const preview = ch.last_msg
      ? (isMine && !isCallLog ? 'You: ' : '') + String(ch.last_msg).replace(/\s+/g, ' ').slice(0, 60)
      : (typeof _formatLastSeen === 'function' ? _formatLastSeen(ch.other_last_seen) : '');
    const previewHtml = preview
      ? `<div class="dm-row-preview ${isMissedCall ? 'missed' : ''}">${previewIcon}<span>${esc(preview)}</span></div>`
      : '';
    const boldName = ch.unread ? 'font-weight:700;color:#e0e0e0' : '';
    return `
    <div class="channel-item ${_activeDM?.id === ch.id ? 'active' : ''}"
         onclick='openDMChannel(${ch.id}, ${nkArg}, ${avArg})'
         style="position:relative;display:flex;align-items:center;gap:8px;padding-right:32px">
      <span style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
        ${avHtml}
        <span style="flex:1;min-width:0;overflow:hidden">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${boldName}">${esc(ch.nickname)}</div>
          ${previewHtml}
        </span>
      </span>
      ${ch.unread ? `<span style="background:#4caf50;color:#000;border-radius:8px;padding:1px 6px;font-size:11px;font-weight:700">${ch.unread}</span>` : ''}
      <button class="dm-close-btn" onclick="event.stopPropagation();hideDMChannel(${ch.id})" title="Hide conversation"
        style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;color:#666;cursor:pointer;font-size:12px;padding:2px 4px;border-radius:4px;opacity:0;transition:opacity .15s"
        onmouseenter="this.style.color='#ff5555';this.style.opacity='1'" onmouseleave="this.style.color='#666'">✕</button>
    </div>`;
  }).join('');
  // Desktop: show ✕ on hover. Mobile: hide it entirely — long-press menu has
  // "Hide conversation" so we don't need a misfire-prone close button on touch.
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  el.querySelectorAll('.channel-item').forEach((item, idx) => {
    const btn = item.querySelector('.dm-close-btn');
    if (btn) {
      if (isTouch) {
        btn.style.display = 'none';
      } else {
        item.onmouseenter = () => btn.style.opacity = '1';
        item.onmouseleave = () => btn.style.opacity = '0';
      }
    }
    const ch = _dmChannels[idx];
    if (ch && typeof bindLongPress === 'function') {
      bindLongPress(item, () => {
        const items = [
          { icon: '👤', label: 'View profile', onclick: () => {
            if (typeof showUserInfo === 'function' && ch.with_user_id) showUserInfo(ch.with_user_id);
            else if (typeof openUserProfile === 'function') openUserProfile(ch.nickname);
          }},
          { icon: '✉️', label: 'Open conversation', onclick: () => openDMChannel(ch.id, ch.nickname, ch.avatar || '🐸') },
          { icon: '👁️', label: 'Mark as read', onclick: () => {
            if (_activeDM?.id !== ch.id) openDMChannel(ch.id, ch.nickname, ch.avatar || '🐸');
            else if (typeof markDMRead === 'function') markDMRead();
          }},
          { icon: '🧹', label: 'Wipe all messages', danger: true, onclick: async () => {
            if (_activeDM?.id !== ch.id) openDMChannel(ch.id, ch.nickname, ch.avatar || '🐸');
            setTimeout(() => { if (typeof wipeDMMessages === 'function') wipeDMMessages(); }, 200);
          }},
          { icon: '✕', label: 'Hide conversation', danger: true, onclick: () => { if (typeof hideDMChannel === 'function') hideDMChannel(ch.id); } },
        ];
        showActionSheet('@' + ch.nickname, items);
      });
    }
  });
}

/* ── Open / navigate ─────────────────────────────────────────────────────────── */
async function openDMChannel (id, nickname, avatar) {
  // Smooth transition: if we're coming from a public channel, clear its state
  if (State.currentRoomType && State.currentRoomType !== 'dm') {
    State.currentRoom = null;
    State.currentRoomOwner = null;
    // Un-highlight public channel list
    document.querySelectorAll('#public-channels .channel-item.active').forEach(el => el.classList.remove('active'));
  }
  State.currentRoomType = 'dm';
  // If we were in a music channel, shrink the full player into the sidebar
  // mini-dock so the DM view isn't covered. Music keeps playing.
  try { window.Music?.mount?.(null, 'text'); } catch {}
  // Reset shared secret until key exchange completes for this peer
  try { STATE.sharedSecret = null; } catch {}
  // Hide E2E indicator until we confirm the handshake succeeded
  try {
    const _enc = document.getElementById('encrypt-indicator');
    if (_enc) _enc.style.display = 'none';
  } catch {}
  // Blank chat area up-front to prevent stale-message flash, but drop in a
  // spinner right away so the user always sees *something* while we derive the
  // ECDH shared secret + fetch messages.
  const area0 = document.getElementById('messages-area');
  if (area0) {
    area0.innerHTML = (typeof inlineSpinner === 'function')
      ? inlineSpinner('Opening conversation with ' + (nickname || '…') + '…')
      : '';
  }
  // DMs have no voice channel — always hide the presence bar.
  const vpb = document.getElementById('voice-presence-bar');
  if (vpb) vpb.style.display = 'none';
  // If user came from a voice-only channel, the composer may still be hidden.
  const inputArea = document.getElementById('input-area');
  if (inputArea) inputArea.style.display = '';
  // Close mobile sidebar so chat is visible
  if (typeof closeMobileSidebar === 'function') closeMobileSidebar();

  const existing = _dmChannels.find(c => c.id === id) || {};
  _activeDM    = {
    id, nickname, avatar,
    user_id: existing.with_user_id || existing.other_id || null,
    peer_last_read: existing.peer_last_read || 0,
    my_last_read:   existing.my_last_read   || 0,
    last_msg_id:    existing.last_msg_id    || 0,
    other_last_seen: existing.other_last_seen || null,
    other_show_read_receipts: existing.other_show_read_receipts !== false,
  };
  _dmPage      = 0;
  const _cached = _dmHistoryCache.get(id);
  _dmMessages  = Array.isArray(_cached) ? _cached.map(m => ({ ...m })) : [];
  clearReplyToDM();

  // If we have recent cached history for this DM, render instantly and refresh
  // in the background to avoid blank-screen flash when switching threads.
  if (_dmMessages.length) {
    renderDMChat();
    scrollChatBottom();
  }

  // Switch app to DM view
  selectServer('dms');
  // Hide members list in DMs — it's a 1:1 conversation, bigger @nick in top bar
  const usersPanel = document.getElementById('users-panel');
  if (usersPanel) usersPanel.classList.add('hidden');
  document.getElementById('chat-header')?.classList.add('is-dm');
  // Highlight in sidebar
  renderDMChannels();
  // Update header — avatar + @nick, clean layout.
  // Wrap the avatar so flex doesn't squish it and it never gets cut off.
  const titleEl = document.getElementById('ch-title');
  if (titleEl) {
    const avHtml = (typeof UI !== 'undefined' && UI.avatarEl)
      ? UI.avatarEl(avatar, nickname, 34)
      : `<span class="room-title-icon">${esc(avatar || '🐸')}</span>`;
    titleEl.innerHTML = `
      <span class="dm-avatar-wrap" aria-hidden="true">${avHtml}</span>
      <span class="room-title-text" style="font-weight:700">@${esc(nickname)}</span>
    `;
    titleEl.onclick = () => { if (typeof showUserInfo === 'function') showUserInfo(nickname, _activeDM?.user_id || null); };
    titleEl.style.cursor = 'pointer';
  }
  const _setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const _setPlaceholder = (id, v) => { const el = document.getElementById(id); if (el) el.placeholder = v; };
  const _show = (id) => { const el = document.getElementById(id); if (el) el.style.display = ''; };
  _setTxt('ch-desc', _formatLastSeen(_activeDM.other_last_seen));
  _setTxt('typing-bar', '');
  const typingBar = document.getElementById('typing-bar');
  if (typingBar) typingBar.style.display = '';
  _setPlaceholder('msg-input', 'Message ' + nickname + '…');
  // Show call buttons and timer button for DMs — guard every lookup so a
  // missing element can't crash the whole open flow (which was leaving the
  // spinner hung on "Opening conversation with…").
  _show('call-voice-btn');
  _show('dm-timer-btn');
  _show('encrypt-btn');
  // Encode DM peer info for calls
  STATE.dmPeerNick = nickname;

  // Load messages FIRST — that's the user's primary expectation. The ECDH
  // handshake + pubkey fetch used to block this path; if either stalled the
  // spinner never went away. Now it runs in the background while the chat
  // opens immediately.
  const _openId = id;
  const _meta = _dmHistoryMeta.get(id);
  const _cacheFreshMs = 15000;
  const _cacheIsFresh = !!(_meta && (Date.now() - _meta.fetchedAt) < _cacheFreshMs);
  const _cacheMatchesLast = !!(_meta && Number(_meta.lastMsgId || 0) === Number(existing.last_msg_id || 0));
  const _canSkipInitialFetch = !!(_dmMessages.length && _cacheIsFresh && _cacheMatchesLast && !(existing.unread > 0));
  const _lastCachedId = Number((_dmMessages[_dmMessages.length - 1]?.id) || 0);
  const msgsP = _canSkipInitialFetch
    ? Promise.resolve()
    : loadDMMessages(0, { afterId: _lastCachedId }).catch(e => console.error('loadDMMessages', e));
  const timerP = loadDisappearTimer().catch(e => console.error('loadDisappearTimer', e));

  // Fire-and-forget: fetch peer user_id + public key for calls/encryption.
  // Wrap each step in a 5s timeout so a slow endpoint can't leave the DM in
  // a half-opened state with no encryption indicator ever appearing.
  (async () => {
    const withTimeout = (p, ms) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
    try {
      let peerUserId = _activeDM?.user_id || null;
      // Fast path: DM list already contains peer user_id. Fallback to search
      // only when opening from contexts that don't provide with_user_id.
      if (!peerUserId) {
        const rp = await withTimeout(apiFetch('/api/users/search?q=' + encodeURIComponent(nickname)), 5000);
        if (!rp || !rp.ok) return;
        const data  = await rp.json();
        const users = Array.isArray(data) ? data : (data.users || []);
        const u = users.find(x => x.nickname === nickname);
        if (!u) return;
        peerUserId = u.id;
      }
      // User may have switched away from this DM while we were waiting —
      // only mutate state if we're still on the same conversation.
      if (!_activeDM || _activeDM.id !== _openId) return;
      _activeDM.user_id = peerUserId;
      const rk = await withTimeout(apiFetch('/api/users/' + peerUserId + '/pubkey'), 5000);
      if (!rk || !rk.ok) return;
      const kd = await rk.json();
      const peerPubKey = kd.ecdh_pub_key || kd.pub_key || null;
      if (!peerPubKey) return;
      if (!_activeDM || _activeDM.id !== _openId) return;
      STATE.dmPeerPubKey = peerPubKey;
      await deriveSharedSecret(peerPubKey);
      try {
        const _enc = document.getElementById('encrypt-indicator');
        if (_enc && _activeDM && _activeDM.id === _openId) {
          _enc.style.display = STATE.sharedSecret ? '' : 'none';
        }
      } catch {}
    } catch (e) { /* silent — encryption is best-effort */ }
  })();

  await msgsP;
  await timerP;
  // Only mark as read when the app is actually visible + focused. If the user
  // tapped a notification or we're restoring state in the background, defer
  // until the tab becomes visible so peers don't get a false ✓✓ read receipt.
  if (!document.hidden && document.hasFocus()) {
    markDMRead();
  } else {
    const onVisible = () => {
      if (!document.hidden && document.hasFocus() && _activeDM && _activeDM.id === id) {
        markDMRead();
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onVisible);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
  }
}

/* ── Format last-seen (Telegram-style) ─────────────────────────────────────── */
function _formatLastSeen (ts) {
  if (!ts) return 'Direct message';
  try {
    const d = new Date(ts.includes('Z') || ts.includes('+') ? ts : ts + 'Z');
    const now = Date.now();
    const diff = (now - d.getTime()) / 1000;
    if (diff < 60)       return 'online';
    if (diff < 300)      return 'last seen just now';
    if (diff < 3600)     return `last seen ${Math.floor(diff/60)} min ago`;
    if (diff < 86400)    return `last seen ${Math.floor(diff/3600)} h ago`;
    if (diff < 86400*7)  return `last seen ${Math.floor(diff/86400)} d ago`;
    return 'last seen ' + d.toLocaleDateString();
  } catch { return 'Direct message'; }
}

/* ── Mark active DM as read on server ──────────────────────────────────────── */
async function markDMRead () {
  if (!_activeDM) return;
  // Guard against marking-read while the app is backgrounded/unfocused — that
  // was leaking ✓✓ to peers for messages the user hadn't actually seen.
  if (document.hidden || !document.hasFocus()) return;
  let top = 0;
  for (const m of _dmMessages) { if ((m.id|0) > top) top = m.id|0; }
  if (!top) return;
  if (_activeDM.my_last_read >= top) return;
  _activeDM.my_last_read = top;
  try {
    await apiFetch(`/api/dms/${_activeDM.id}/read`, 'POST', { up_to: top });
  } catch {}
  // Clear unread badge in sidebar
  const ch = _dmChannels.find(c => c.id === _activeDM.id);
  if (ch) { ch.unread = 0; ch.my_last_read = top; renderDMChannels(); }
}

/* ── WS: peer read receipt ─────────────────────────────────────────────────── */
function handleWSDMRead (data) {
  const chId = data.channel_id|0;
  // Server broadcasts "last_read"; accept "up_to" as a fallback for forward-compat.
  const upTo = (data.last_read|0) || (data.up_to|0);
  if (!chId || !upTo) return;
  const ch = _dmChannels.find(c => c.id === chId);
  if (ch) ch.peer_last_read = Math.max(ch.peer_last_read||0, upTo);
  if (_activeDM && _activeDM.id === chId) {
    _activeDM.peer_last_read = Math.max(_activeDM.peer_last_read||0, upTo);
    // Only upgrade to ✓✓ (read) when BOTH users have read-receipts on.
    const myShowReceipts   = STATE.user?.show_read_receipts !== 0;
    const peerShowReceipts = _activeDM.other_show_read_receipts !== false;
    if (!(myShowReceipts && peerShowReceipts)) return;
    document.querySelectorAll('#messages-area .msg-tick[data-mine="1"]').forEach(el => {
      const mid = +el.dataset.mid;
      if (mid && mid <= _activeDM.peer_last_read) {
        el.textContent = '✓✓';
        el.classList.remove('msg-tick-pending');
        el.classList.add('msg-tick-read');
        el.title = 'Read';
      }
    });
  }
}

/* Shortcut: open DM by nickname (creates channel if needed) */
async function openDMWithNick (nick) {
  const r = await apiFetch('/api/dms/open/' + encodeURIComponent(nick), 'POST');
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    toast(err.error || 'Could not open DM', 'error');
    return;
  }
  const ch = await r.json();
  const chId = ch.channel_id || ch.id;
  const avatar = ch.other_user?.avatar || '🐸';
  // Optimistically inject into sidebar so it shows up instantly even before loadDMChannels returns
  if (!_dmChannels.find(c => c.id === chId)) {
    _dmChannels.unshift({
      id: chId, nickname: nick, avatar, unread: 0,
      with_user_id: ch.other_user?.id, last_msg_id: 0,
      my_last_read: 0, peer_last_read: 0,
      other_last_seen: ch.other_user?.last_seen || null,
      other_show_read_receipts: ch.other_user?.show_read_receipts !== false,
    });
    renderDMChannels();
  }
  openDMChannel(chId, nick, avatar);
  // Refresh from server in background
  loadDMChannels();
}

/* DM entry button — opens last DM, empty-state if no DMs exist */
function openDMsPanel () {
  if (typeof selectServer === 'function') selectServer('dms');
  // Always refresh the list — after an app restart or server reconnect the cached
  // list may be empty or stale; without this Android users see an empty panel.
  loadDMChannels().then(() => {
    if (_dmChannels && _dmChannels.length > 0) {
      if (!_activeDM) {
        const last = _dmChannels[0];
        openDMChannel(last.id, last.nickname, last.avatar || '🐸');
      } else {
        renderDMChannels();
      }
    } else if (typeof showNewDM === 'function') {
      showNewDM();
    }
  });
}

/* ── Load messages ─────────────────────────────────────────────────────────── */
async function loadDMMessages (pageOffset = 0, options = {}) {
  if (!_activeDM) return;
  const afterId = Number(options?.afterId || 0);
  const uiRetry = Number(options?.uiRetry || 0);
  const isDelta = pageOffset === 0 && afterId > 0;
  const _reqRoomId = _activeDM.id;
  const _reqSeq = ++_dmLoadReqSeq;
  const _isReqCurrent = () => !!(_activeDM && _activeDM.id === _reqRoomId && _reqSeq === _dmLoadReqSeq);
  if (pageOffset === 0 && !isDelta) {
    const area = document.getElementById('messages-area');
    // Preserve already-rendered content (cache or prior load) and only show a
    // full spinner when there is nothing to display yet.
    if (area && (!_dmMessages || !_dmMessages.length)) {
      area.innerHTML = inlineSpinner('Loading conversation…');
    }
  }
  const url = isDelta
    ? `/api/dms/${_reqRoomId}/messages?limit=${DM_PER_PAGE}&after=${afterId}`
    : `/api/dms/${_reqRoomId}/messages?limit=${DM_PER_PAGE}&offset=${pageOffset * DM_PER_PAGE}`;
  let r;
  try {
    // One built-in retry smooths transient network hiccups so users rarely
    // need to click Retry manually.
    r = await _fetchDMPageResilient(url, 2, 25000);
  } catch (e) {
    if (!_isReqCurrent()) return;
    // Delta fetch failed — fall back to a full refresh before showing error UI.
    if (isDelta && uiRetry < 1) {
      return loadDMMessages(0, { ...options, afterId: 0, uiRetry: uiRetry + 1 });
    }
    // First visible load failure gets one silent reconnect attempt before we
    // show the hard retry panel.
    if (pageOffset === 0 && uiRetry < 2) {
      const area = document.getElementById('messages-area');
      const hasVisible = !!(_dmMessages && _dmMessages.length);
      if (area && !hasVisible) area.innerHTML = inlineSpinner('Reconnecting…');
      await _sleep(500);
      if (!_isReqCurrent()) return;
      return loadDMMessages(pageOffset, { ...options, uiRetry: uiRetry + 1 });
    }
    // Network errors hit here — show a clickable retry instead of an endless spinner.
    if (pageOffset === 0) {
      const area = document.getElementById('messages-area');
      const hasVisible = !!(_dmMessages && _dmMessages.length);
      if (area && !hasVisible) area.innerHTML = `<div style="text-align:center;color:#888;padding:32px">
        <div style="font-size:36px;margin-bottom:8px">⚠️</div>
        <div>Couldn't load messages — check your connection.</div>
        <button class="modal-btn" style="margin-top:12px" onclick="loadDMMessages(0)">Retry</button>
      </div>`;
      else if (hasVisible && typeof toast === 'function') {
        toast('Connection hiccup. Showing cached messages.', 'info', 2200);
      }
    }
    return;
  }
  if (!r || !r.ok) {
    if (!_isReqCurrent()) return;
    // Delta fetch got a bad response — retry once as a full load.
    if (isDelta && uiRetry < 1) {
      return loadDMMessages(0, { ...options, afterId: 0, uiRetry: uiRetry + 1 });
    }
    // Some errors can happen with stale channel ids after reconnect/resync;
    // refresh DM channel mapping and retry once automatically.
    if (pageOffset === 0 && uiRetry < 2 && r && (r.status === 403 || r.status === 404 || r.status === 422)) {
      const repaired = await _repairActiveDMChannelId();
      if (repaired) {
        return loadDMMessages(0, { ...options, afterId: 0, uiRetry: uiRetry + 1 });
      }
    }
    // Soft-retry once on transient server errors before showing error UI.
    if (pageOffset === 0 && uiRetry < 2 && r && r.status >= 500) {
      const area = document.getElementById('messages-area');
      const hasVisible = !!(_dmMessages && _dmMessages.length);
      if (area && !hasVisible) area.innerHTML = inlineSpinner('Reconnecting…');
      await _sleep(500);
      if (!_isReqCurrent()) return;
      return loadDMMessages(pageOffset, { ...options, uiRetry: uiRetry + 1 });
    }
    if (pageOffset === 0) {
      const area = document.getElementById('messages-area');
      const hasVisible = !!(_dmMessages && _dmMessages.length);
      if (area && !hasVisible) area.innerHTML = `<div style="text-align:center;color:#888;padding:32px">
        <div style="font-size:36px;margin-bottom:8px">⚠️</div>
        <div>Couldn't load messages (server error).</div>
        <button class="modal-btn" style="margin-top:12px" onclick="loadDMMessages(0)">Retry</button>
      </div>`;
      else if (hasVisible && typeof toast === 'function') {
        toast('Server slow right now. Keeping current messages.', 'info', 2200);
      }
    }
    return;
  }
  const data = await r.json();
  // Ignore stale responses from older requests or previous DM sessions.
  if (!_activeDM || _activeDM.id !== _reqRoomId || _reqSeq !== _dmLoadReqSeq) return;
  const rawMsgs = Array.isArray(data) ? data : (data.messages || []);
  // Resolve peer identity for decryption. _activeDM.user_id is set by the
  // background ECDH task but may not be ready yet — fall back to the
  // channel list entry which always has with_user_id populated.
  const _dmChanEntry = _dmChannels.find(c => c.id === _reqRoomId);
  const _peerUserId  = _activeDM?.user_id || _dmChanEntry?.with_user_id || 0;
  const _peerNick    = _activeDM?.nickname || '';
  const msgs = await Promise.all(rawMsgs.map(async (msg) => {
    if (!msg) return msg;
    const next = _normalizeDMMessage(msg);
    if (next.content) {
      try { next.content = await _decryptDMPreviewContent(next.content, _peerUserId, _peerNick); } catch {}
    }
    if (next.reply_content) {
      try { next.reply_content = await _decryptDMPreviewContent(next.reply_content, _peerUserId, _peerNick); } catch {}
    }
    return next;
  }));
  for (const m of msgs) {
    if (!m || !m.view_once) continue;
    const cid = m.channel_id || _reqRoomId || 0;
    if (_isViewOnceSeenLocal(m.id, cid)) m.viewed_by_me = 1;
  }
  if (pageOffset === 0) {
    if (isDelta) {
      if (msgs.length) {
        const seen = new Set(_dmMessages.map(m => Number(m.id || 0)));
        const merged = [..._dmMessages];
        for (const m of msgs) {
          const mid = Number(m?.id || 0);
          if (!mid || seen.has(mid)) continue;
          seen.add(mid);
          merged.push(m);
        }
        _dmMessages = merged;
      }
    } else {
      _dmMessages = msgs;
    }
    _dmHistoryCache.set(_reqRoomId, _dmMessages.map(m => ({ ...m })));
    _dmHistoryMeta.set(_reqRoomId, {
      fetchedAt: Date.now(),
      lastMsgId: Number((_dmMessages[_dmMessages.length - 1]?.id) || 0),
    });
    if (!isDelta || msgs.length) {
      renderDMChat();
      scrollChatBottom();
    }
  } else {
    _dmMessages = [...msgs, ..._dmMessages];
    // Re-render but keep scroll position
    const area = document.getElementById('messages-area');
    const prevH = area.scrollHeight;
    renderDMChat();
    area.scrollTop = area.scrollHeight - prevH;
  }
  // Clear unread badge
  const ch = _dmChannels.find(c => c.id === _reqRoomId);
  if (ch) { ch.unread = 0; renderDMChannels(); }
}

/* ── Render DM chat ──────────────────────────────────────────────────────────── */
function renderDMChat () {
  const area = document.getElementById('messages-area');
  if (!area) return;
  if (!_dmMessages.length) {
    area.innerHTML = `<div style="text-align:center;color:#555;padding:48px 16px">
      <div style="display:flex;justify-content:center;margin-bottom:10px">${fmtAv(_activeDM.avatar, _activeDM.nickname, 64)}</div>
      <div style="font-size:18px;font-weight:700;margin:8px 0">This is the beginning of your DM with ${esc(_activeDM.nickname)}</div>
      <div style="font-size:13px;color:#444">Messages are end-to-end encrypted 🔒</div>
    </div>`;
    return;
  }
  _dmMessages = _dmMessages.map(m => _normalizeDMMessage(m));
  area.innerHTML = _dmMessages.map(m => renderDMMessage(m)).join('');
  // Attach reaction buttons
  area.querySelectorAll('.dm-react-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const msgId = +btn.closest('[data-dmid]').dataset.dmid;
      toggleDMReaction(msgId, btn.dataset.emoji);
    });
  });
  _observeDMLazyMedia(area);

  // Scroll to bottom — with robust pinning for late-loading media
  const forceBottom = () => { area.scrollTop = area.scrollHeight; };
  forceBottom();
  requestAnimationFrame(() => { forceBottom(); requestAnimationFrame(forceBottom); });
  const openedAt = Date.now();
  const WINDOW_MS = 8000;
  let userScrolled = false;
  const onUserScroll = () => {
    const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 120;
    if (!nearBottom) userScrolled = true;
  };
  area.addEventListener('wheel', onUserScroll, { passive: true });
  area.addEventListener('touchmove', onUserScroll, { passive: true });
  const ro = (typeof ResizeObserver !== 'undefined')
    ? new ResizeObserver(() => {
        if (userScrolled) return;
        if (Date.now() - openedAt > WINDOW_MS) { ro.disconnect(); return; }
        forceBottom();
      })
    : null;
  if (ro) ro.observe(area);
  try {
    area.querySelectorAll('img,video').forEach(el => {
      el.addEventListener('load', () => { if (!userScrolled && Date.now() - openedAt < WINDOW_MS) forceBottom(); }, { once: true });
      el.addEventListener('loadedmetadata', () => { if (!userScrolled && Date.now() - openedAt < WINDOW_MS) forceBottom(); }, { once: true });
    });
  } catch {}
  [120, 400, 900, 1800, 3500].forEach(ms =>
    setTimeout(() => { if (!userScrolled) forceBottom(); }, ms)
  );
  setTimeout(() => {
    try { ro?.disconnect(); } catch {}
    area.removeEventListener('wheel', onUserScroll);
    area.removeEventListener('touchmove', onUserScroll);
  }, WINDOW_MS + 200);
}

function _scrollDMToBottomStable() {
  const area = document.getElementById('messages-area');
  if (!area) return;
  const go = () => { area.scrollTop = area.scrollHeight; };
  go();
  requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
  [80, 220, 500].forEach(ms => setTimeout(go, ms));
}

function renderDMMessage (m) {
  // Loose numeric compare — server may send sender_id as string in some paths.
  const _uid = STATE.user?.id;
  const mine = (m.sender_id != null && _uid != null && (+m.sender_id === +_uid))
            || (!!m.sender_nick && !!STATE.user?.nickname && m.sender_nick === STATE.user.nickname);
  const time  = new Date(m.created_at + 'Z').toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  const avatar = m.sender_avatar || m.avatar || '🐸';
  const senderNick = m.sender_nick || '';
  const editedTag = (m.edited_at || m.edited) ? '<span class="msg-edited">(edited)</span>' : '';

  // Special persisted call-log entries: [[CALLLOG]]{"title":"...","subtitle":"...","icon":"..."}
  if (typeof m.content === 'string' && m.content.startsWith('[[CALLLOG]]')) {
    let meta = null;
    try { meta = JSON.parse(m.content.slice('[[CALLLOG]]'.length)); } catch {}
    const callTypeRaw = (meta?.call_type === 'video') ? 'video' : 'voice';
    const peerNick = m.sender_nick || m.sender_nickname || 'Someone';
    const otherNick = _activeDM?.nickname || peerNick;
    const rawTitle = (meta?.kind === 'missed' && mine) ? 'No answer' : (meta?.title || 'Call');
    const title = esc(rawTitle);
    const icon = esc(meta?.icon || '📞');
    const kind = esc(meta?.kind || 'info');
    const callType = esc(otherNick);
    const missedOutgoing = (meta?.kind === 'missed' && mine);
    const missedIncoming = (meta?.kind === 'missed' && !mine);
    const dirClass = missedOutgoing
      ? ' dm-call-log-missed-outgoing'
      : (missedIncoming ? ' dm-call-log-missed-incoming' : '');
    let subtitleText = meta?.subtitle || '';
    if (meta?.kind === 'missed') {
      subtitleText = mine
        ? `No answer to your ${callTypeRaw} call`
        : `You missed a ${callTypeRaw} call from ${peerNick}`;
    } else if (meta?.kind === 'declined') {
      subtitleText = mine
        ? (meta?.subtitle || `${peerNick} declined`)
        : 'You declined';
    }
    const subtitle = esc(subtitleText);
    return `<div class="dm-call-log-wrap" id="msg-${m.id}" data-dmid="${m.id}">
      <div class="dm-call-log-card dm-call-log-${kind}${dirClass}">
        <div class="dm-call-log-icon">${icon}</div>
        <div class="dm-call-log-text">
          <div class="dm-call-log-title">${title} <span class="dm-call-log-pill">@${callType}</span></div>
          ${subtitle ? `<div class="dm-call-log-sub">${subtitle}</div>` : ''}
          <div class="dm-call-log-time">${time}</div>
        </div>
      </div>
    </div>`;
  }

  // WhatsApp-style tick state for own messages:
  //   ⏱  pending  — optimistic, no server id yet
  //   ✓  delivered — server stored (always shown regardless of receipt settings)
  //   ✓✓ read     — peer has read AND both users have read-receipts enabled
  let tickHtml = '';
  if (mine) {
    const myShowReceipts  = STATE.user?.show_read_receipts !== 0; // default on
    const peerShowReceipts = _activeDM && _activeDM.other_show_read_receipts !== false;
    const receiptsMutual   = myShowReceipts && peerShowReceipts;
    const hasId            = (m.id|0) > 0 && !m._pending;
    const peerRead         = hasId && _activeDM && (m.id|0) <= (_activeDM.peer_last_read|0);
    const showRead         = peerRead && receiptsMutual;

    if (!hasId) {
      tickHtml = `<span class="msg-tick msg-tick-pending" data-mine="1" data-mid="0" title="Sending…">⏱</span>`;
    } else if (showRead) {
      tickHtml = `<span class="msg-tick msg-tick-read" data-mine="1" data-mid="${m.id}" title="Read">✓✓</span>`;
    } else {
      tickHtml = `<span class="msg-tick" data-mine="1" data-mid="${m.id}" title="Delivered">✓</span>`;
    }
  }

  // Build media HTML
  let mediaHtml = '';
  const mediaUrl = m.media_url || m.media_data;
  const mimeType = m.mime_type || m.media_type || '';
  const isBlurred = !!m.media_blur && !(mimeType.startsWith('audio/'));

  // View-once: already consumed — show burned placeholder
  const chIdForSeen = m.channel_id || (_activeDM?.id ?? 0);
  const seenByMe = !!m.viewed_by_me || _isViewOnceSeenLocal(m.id, chIdForSeen);
  const seenByOther = !!m.viewed_by_other;
  const isViewOnceConsumed = !!(m.view_once && ((mine && seenByOther) || (!mine && seenByMe) || (!mediaUrl && !m.has_media)));
  if (m.view_once && ((mine && seenByOther) || (!mine && seenByMe) || (!mediaUrl && !m.has_media))) {
    mediaHtml = '<div class="view-once-viewed">🔥 ✓ <em>Seen</em></div>';
  // View-once: media present — show spoiler-style tap-to-view overlay
  } else if (m.view_once && (mediaUrl || m.has_media)) {
    const chId = m.channel_id || (_activeDM?.id ?? 0);
    const senderLabel = seenByOther ? 'Seen' : 'Sent • Awaiting view';
    const receiverLabel = 'Tap to view once';
    const label = mine ? senderLabel : receiverLabel;
    mediaHtml = `<div class="view-once-wrap" id="vo-dm-${m.id}" data-mtype="${esc(mimeType)}" data-channel="${chId}" data-media="${esc(mediaUrl || '')}" role="button" tabindex="0" onclick="revealDMViewOnce(${m.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();revealDMViewOnce(${m.id})}">
      <div class="view-once-overlay">
        <span class="view-once-icon">🔥</span>
        <span class="view-once-label">${label}</span>
      </div>
    </div>`;
  } else if (mediaUrl) {
    let inner = '';
    if (mimeType.startsWith('image/') || (!mimeType && mediaUrl.startsWith('data:image'))) {
      inner = `<img src="${mediaUrl}" class="msg-media" onclick="openLightbox('${mediaUrl}')" loading="lazy">`;
    } else if (mimeType.startsWith('video/') || (!mimeType && mediaUrl.startsWith('data:video'))) {
      inner = `<video src="${mediaUrl}" controls preload="metadata" playsinline muted class="msg-media"></video>`;
    } else if (mimeType.startsWith('audio/') || (!mimeType && mediaUrl.startsWith('data:audio'))) {
      inner = `<audio src="${mediaUrl}" controls preload="metadata" style="width:260px;display:block;margin-top:6px"></audio>`;
    } else {
      const name = mediaUrl.split('/').pop();
      inner = `<a href="${mediaUrl}" target="_blank" style="color:#4caf50;display:block;margin-top:4px">📄 ${esc(name)}</a>`;
    }
    if (isBlurred) {
      // Wrap in a spoiler overlay that reveals on click. Replace the media's
      // click handler so it doesn't fire openLightbox while still blurred.
      const wrappedInner = inner
        .replace('class="msg-media"', 'class="spoiler-img msg-media"')
        .replace(/onclick="[^"]*"/, '');
      mediaHtml = `<div class="spoiler-wrap" id="sp-dm-${m.id}" onclick="revealDMSpoiler(this, event)" data-media="${esc(mediaUrl)}">
        <div class="spoiler-overlay">👁️ Spoiler — Click to Reveal</div>
        ${wrappedInner}
      </div>`;
    } else {
      mediaHtml = inner;
    }
  } else if (m.has_media) {
    // Auto-loading stub (IntersectionObserver kicks in via _observeDMLazyMedia).
    const icon = mimeType?.startsWith('video') ? '🎬' : mimeType?.startsWith('audio') ? '🎵' : '🖼️';
    mediaHtml = `<div class="media-lazy auto" id="dm-media-lazy-${m.id}" data-msg-id="${m.id}" data-channel-id="${m.channel_id || _activeDM?.id || ''}" data-media-type="${esc(mimeType)}">
      <div class="media-lazy-placeholder media-lazy-auto" onclick="loadDMMedia(${m.id}, ${m.channel_id || _activeDM?.id || 0})">
        <span class="media-lazy-icon" style="font-size:20px">${icon}</span>
        <span class="media-lazy-spinner" aria-hidden="true"></span>
        <span style="font-size:12px;color:#888">Loading media…</span>
      </div>
    </div>`;
  }

  // Content with formatting (links, mentions, custom emoji)
  let contentHtml = '';
  const safeContent = (m.view_once || isViewOnceConsumed)
    ? ''
    : ((typeof m.content === 'string' && _looksEncryptedBlob(m.content)) ? '' : m.content);
  if (safeContent) {
    contentHtml = esc(safeContent);
    const urlRe = /https?:\/\/[^\s<>"]+/g;
    contentHtml = contentHtml.replace(/@(\w+)/g, (match, nick) => {
      const isSelf = nick.toLowerCase() === STATE.user?.nickname?.toLowerCase();
      return `<span class="mention${isSelf ? ' mention-self' : ''}">@${nick}</span>`;
    });
    contentHtml = contentHtml.replace(urlRe, url => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="msg-link">${url}</a>`);
    if (typeof renderCustomEmojisInText === 'function') {
      contentHtml = renderCustomEmojisInText(contentHtml);
    }
  }
  if (!contentHtml && !mediaHtml) contentHtml = '<em style="color:#444">Media</em>';

  // Reply quote
  const replyPreviewRaw = String(m.reply_content || '…');
  const replyPreviewSafe = _looksEncryptedBlob(replyPreviewRaw) ? 'Encrypted message' : replyPreviewRaw;
  const replyQuote = m.reply_to
    ? `<div class="msg-reply-quote" onclick="document.querySelector('[data-dmid=&quot;${m.reply_to}&quot;]')?.scrollIntoView({behavior:'smooth',block:'center'})">
        <span class="reply-quote-nick">${esc(m.reply_nick || senderNick || '?')}</span>
        <span class="reply-quote-text">${esc(replyPreviewSafe.substring(0, 80))}</span>
      </div>`
    : '';

  // Reactions
  const reactionsHtml = _dmReactionHtml(m.reactions, m.id);

  // Actions (same style as channel messages)
  const actions = `
    <div class="msg-actions">
      <button class="msg-act-btn" title="Reply" onclick="replyToDM(${m.id},'${esc(senderNick)}','${esc((safeContent||'').substring(0,80))}')">↩️</button>
      <button class="msg-act-btn dm-react-btn" data-dmid="${m.id}" data-emoji="👍" title="React">👍</button>
      ${mine ? `<button class="msg-act-btn" title="Edit" onclick="editDMMsg(${m.id})">✏️</button>` : ''}
      <button class="msg-act-btn danger" title="Delete" onclick="deleteDMMsg(${m.id})">🗑️</button>
    </div>
    <button class="msg-more-trigger" title="Message options" aria-label="Message options" onclick="event.stopPropagation();Messages.openActionSheet(${m.id})">⋯</button>
  `;

  return `<div class="msg-group" id="msg-${m.id}" data-dmid="${m.id}">
    <div class="msg-avatar">${UI.avatarEl(avatar, senderNick, 38)}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-author" onclick="showUserInfo('${esc(senderNick)}',${m.sender_id||'null'})">${esc(senderNick)}</span>
        <span class="msg-time">${time}</span>
        ${tickHtml}
        ${editedTag}
      </div>
      ${replyQuote}
      ${contentHtml ? `<div class="msg-content">${contentHtml}</div>` : ''}
      ${mediaHtml}
      ${reactionsHtml}
    </div>
    ${actions}
  </div>`;
}

function _dmReactionHtml (reactions, msgId) {
  if (!reactions || typeof reactions === 'string') return '';
  const obj = typeof reactions === 'object' ? reactions : {};
  const pills = Object.entries(obj).map(([emoji, count]) =>
    count > 0 ? `<span class="reaction-pill" onclick="toggleDMReaction(${msgId},'${emoji}')">${emoji} ${count}</span>` : ''
  ).join('');
  if (!pills) return '';
  return `<div class="msg-reactions">${pills}</div>`;
}

/* Reveal a DM spoiler on click — unblurs and restores the image click-to-open. */
function revealDMSpoiler (wrap, ev) {
  if (!wrap || wrap.classList.contains('revealed')) return;
  try { ev && ev.stopPropagation && ev.stopPropagation(); } catch {}
  wrap.classList.add('revealed');
  // Re-wire the media's onclick → lightbox now that it's visible
  const url = wrap.dataset.media;
  const img = wrap.querySelector('img.msg-media');
  if (img && url) img.onclick = () => { try { openLightbox(url); } catch {} };
}
window.revealDMSpoiler = revealDMSpoiler;

/* Reveal a DM view-once image — load full media, show overlay. Consume only if receiver. */
async function revealDMViewOnce (msgId) {
  const msgIdx = _dmMessages.findIndex(x => +x.id === +msgId);
  const msg = msgIdx >= 0 ? _dmMessages[msgIdx] : null;
  const isSender = msg && msg.sender_id === (STATE.user?.id || 0);

  const _markViewedLocal = (forceSeenForSender = false) => {
    const i = _dmMessages.findIndex(x => +x.id === +msgId);
    const cid = (i >= 0 && _dmMessages[i].channel_id) ? _dmMessages[i].channel_id : (_activeDM?.id || 0);
    const el = document.getElementById(`vo-dm-${msgId}`);
    if (isSender) {
      if (i >= 0 && forceSeenForSender) _dmMessages[i].viewed_by_other = 1;
      const seenByOther = (i >= 0 && !!_dmMessages[i].viewed_by_other) || forceSeenForSender;
      if (el) {
        if (seenByOther) {
          el.outerHTML = '<div class="view-once-viewed">🔥 ✓ <em>Seen</em></div>';
        } else {
          const lbl = el.querySelector('.view-once-label');
          if (lbl) lbl.textContent = 'Sent • Awaiting view';
        }
      }
      return;
    }

    if (i >= 0) _dmMessages[i].viewed_by_me = 1;
    _markViewOnceSeenLocal(msgId, cid);
    if (el) el.outerHTML = '<div class="view-once-viewed">🔥 <em>Viewed</em></div>';
  };

  const el = document.getElementById(`vo-dm-${msgId}`);
  if (!el) return;
  if (el.dataset.opening === '1') return;
  el.dataset.opening = '1';

  const channelId = +(el.dataset.channel || _activeDM?.id || 0);
  const mimeType  = el.dataset.mtype || '';
  let   mediaData = el.dataset.media || '';

  // Show loading state
  const labelEl = el.querySelector('.view-once-label');
  if (labelEl) labelEl.textContent = 'Loading…';

  // If media_data wasn't inlined (lazy), fetch it first
  if (!mediaData && channelId) {
    let loaded = false;
    for (let attempt = 0; attempt < 2 && !loaded; attempt++) {
      try {
        const res = await apiFetch(`/api/dms/${channelId}/messages/${msgId}/media`);
        if (res.status === 410) {
          _markViewedLocal(isSender);
          delete el.dataset.opening;
          return;
        }
        if (!res.ok) throw new Error('load failed');
        const d = await res.json();
        mediaData = d.media_data || '';
        if (mediaData && typeof Crypto !== 'undefined' && Crypto.decryptPayload) {
          mediaData = await Crypto.decryptPayload(mediaData, STATE.sharedSecret || null);
        }
        loaded = !!mediaData;
      } catch {
        if (attempt === 0) await new Promise(r => setTimeout(r, 120));
      }
    }
    if (!loaded) {
      if (labelEl) labelEl.textContent = 'Failed to load';
      delete el.dataset.opening;
      return;
    }

    // Cache fetched media for repeat opens (important for sender re-open flow).
    el.dataset.media = mediaData || '';
  }

  if (!mediaData) {
    if (labelEl) labelEl.textContent = 'Failed to load';
    delete el.dataset.opening;
    return;
  }

  // Open in fullscreen lightbox overlay — close/backdrop click marks as viewed (receiver only)
  const overlay = document.createElement('div');
  overlay.className = 'vo-overlay';
  const safeMime = mimeType || '';
  const mediaEl = safeMime.startsWith('video')
    ? `<video class="vo-media" src="${mediaData}" autoplay controls playsinline></video>`
    : `<img class="vo-media" src="${mediaData}" alt="">`;
  const hintText = isSender
    ? '🔥 Sent • Waiting for them to open…'
    : '🔥 View Once • tap outside or close to dismiss';
  overlay.innerHTML = `
    <button class="vo-close" title="Close">✕</button>
    ${mediaEl}
    <div class="vo-hint">${hintText}</div>`;
  document.body.appendChild(overlay);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    _markViewedLocal();
    // Only consume (call /view) if receiver
    if (!isSender) {
      try { await apiFetch(`/api/dms/${channelId}/messages/${msgId}/view`, 'POST'); } catch {}
    }
    delete el.dataset.opening;
  };

  overlay.querySelector('.vo-close').addEventListener('click', () => { close(); });
  overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
  // Escape key closes too
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
}
window.revealDMViewOnce = revealDMViewOnce;

function handleWSDMViewOnceViewed (data) {
  if (!data || !data.msg_id) return;
  const myId = STATE.user?.id;
  if (myId && data.user_id && +data.user_id !== +myId) return;
  const i = _dmMessages.findIndex(x => +x.id === +data.msg_id);
  const cid = data.channel_id || ((i >= 0 && _dmMessages[i].channel_id) ? _dmMessages[i].channel_id : (_activeDM?.id || 0));
  if (i >= 0) {
    if (!data.is_sender) _dmMessages[i].viewed_by_me = 1;
    _dmMessages[i].viewed_by_other = 1;
  }
  if (!data.is_sender) _markViewOnceSeenLocal(data.msg_id, cid);
  const el = document.getElementById(`vo-dm-${data.msg_id}`);
  if (el) el.outerHTML = '<div class="view-once-viewed">🔥 ✓ <em>Seen</em></div>';
}
window.handleWSDMViewOnceViewed = handleWSDMViewOnceViewed;

function handleWSDMViewOnceViewedByPeer (data) {
  if (!data || !data.msg_id) return;
  const i = _dmMessages.findIndex(x => +x.id === +data.msg_id);
  if (i >= 0) _dmMessages[i].viewed_by_other = 1;
  const el = document.getElementById(`vo-dm-${data.msg_id}`);
  if (el) el.outerHTML = '<div class="view-once-viewed">🔥 ✓ <em>Seen</em></div>';
}
window.handleWSDMViewOnceViewedByPeer = handleWSDMViewOnceViewedByPeer;

/* ── Lazy-load DM media ──────────────────────────────────────────────────────── */
async function loadDMMedia (msgId, channelId) {
  const container = document.getElementById(`dm-media-lazy-${msgId}`);
  if (!container) return;
  container.innerHTML = '<div style="padding:12px;color:#888;font-size:13px">Loading…</div>';
  try {
    const res = await apiFetch(`/api/dms/${channelId}/messages/${msgId}/media`);
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    if (typeof Crypto !== 'undefined' && Crypto.decryptPayload) {
      data.media_data = await Crypto.decryptPayload(data.media_data, STATE.sharedSecret || null);
    }
    if (!data.media_data) throw new Error('Decrypt failed');
    const mediaType = data.media_type || '';
    let html;
    if (mediaType.startsWith('video')) {
      html = `<video src="${data.media_data}" controls preload="metadata" playsinline muted class="msg-media"></video>`;
    } else if (mediaType.startsWith('audio')) {
      html = `<audio src="${data.media_data}" controls preload="metadata" style="width:260px;display:block;margin-top:6px"></audio>`;
    } else {
      html = `<img src="${data.media_data}" class="msg-media" onclick="openLightbox('${data.media_data}')" loading="lazy">`;
    }
    container.outerHTML = html;
  } catch {
    container.innerHTML = '<div style="padding:12px;color:#f44;font-size:13px">Failed to load media</div>';
  }
}

/* Auto-fetch DM lazy-media as soon as it scrolls into view. */
let _dmLazyObserver = null;
function _observeDMLazyMedia(root) {
  if (typeof IntersectionObserver === 'undefined') return;
  // Respect user auto-play toggle.
  if (localStorage.getItem('ft_autoplay_media') === '0') return;
  if (!_dmLazyObserver) {
    _dmLazyObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        _dmLazyObserver.unobserve(el);
        const id = +el.dataset.msgId;
        const cid = +el.dataset.channelId;
        if (id && cid) loadDMMedia(id, cid);
      }
    }, { rootMargin: '200px 0px', threshold: 0.01 });
  }
  const host = root || document.getElementById('messages-area');
  if (!host) return;
  host.querySelectorAll('.media-lazy.auto').forEach(el => {
    if (!el.dataset._obs) { _dmLazyObserver.observe(el); el.dataset._obs = '1'; }
  });
}

/* ── Send DM ─────────────────────────────────────────────────────────────────── */
let _dmSending = false;
async function sendDMMessage () {
  if (!_activeDM) return;
  if (_dmSending) return;  // guard against double-tap / rapid re-sends

  // Auto-stop recording if in progress and wait for finalization
  if (typeof _isRecording !== 'undefined' && _isRecording) {
    stopRecording();
    await new Promise(resolve => {
      const check = () => window._pendingAttachment ? resolve() : setTimeout(check, 50);
      setTimeout(check, 50);
      setTimeout(resolve, 2000); // safety timeout
    });
  }

  const input = document.getElementById('msg-input');
  let content = (input.value || '').trim();

  // Pop attached file if any (check both slots)
  const fileData = window._pendingAttachment || State.pendingAttachment;

  if (!content && !fileData) return;

  // E2E encrypt if shared secret available
  let encryptedContent = content;
  if (content && STATE.sharedSecret) {
    try { encryptedContent = await encryptMsg(content); } catch {}
  }

  const payload = {
    content    : encryptedContent || content,
    reply_to   : _dmReplyTo?.id || null,
    client_mime: fileData?.type || null,
  };

  if (fileData) {
    _dmSending = true;
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '⏳'; }
    // Convert blob to base64 data URL and send as JSON (API only accepts JSON body)
    try {
      let mediaData = fileData.dataUrl || fileData.data || null;
      if (!mediaData && fileData.blob) {
        mediaData = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(fileData.blob);
        });
      }
      if (mediaData && STATE.sharedSecret && typeof Crypto !== 'undefined' && Crypto.encryptPayload) {
        mediaData = await Crypto.encryptPayload(mediaData, STATE.sharedSecret);
      }
      const r = await apiFetch(`/api/dms/${_activeDM.id}/messages`, 'POST', {
        content: encryptedContent || content || '',
        media_data: mediaData,
        media_type: fileData.type || '',
        media_name: fileData.name || 'file',
        media_blur: window._pendingMediaBlur ? 1 : 0,
        view_once: window._pendingViewOnce ? 1 : 0,
        reply_to: _dmReplyTo?.id || null,
      });
      if (!r.ok) { toast('Upload failed', 'error'); return; }
      clearReplyToDM();
      clearAttachment();
      input.value = '';
      autoResize(input);
      const msg = await r.json();
      appendDMMessage(msg);
    } catch (e) {
      console.error('DM file send error', e);
      toast('Failed to send file', 'error');
    } finally {
      _dmSending = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '➤'; }
    }
    return;
  }

  // Send over WebSocket for speed. Include a client_nonce so we can reconcile
  // the server's echo back to our optimistic bubble.
  const _nonce = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  wsSend({ type: 'dm_message', channel_id: _activeDM.id, content: encryptedContent || content,
           reply_to: _dmReplyTo?.id || null, client_nonce: _nonce });

  // Optimistic local append \u2014 the user sees their message instantly instead of
  // waiting for the WS round-trip. The echo handler will swap the temp id for
  // the real id on arrival.
  try {
    const _me = STATE.user || {};
    const _tempMsg = {
      id         : 0,
      _nonce     : _nonce,
      channel_id : _activeDM.id,
      sender_id  : _me.id,
      sender_nick: _me.nickname,
      sender_avatar: _me.avatar,
      content    : content,            // plaintext \u2014 what the user typed
      created_at : new Date().toISOString().replace('Z',''),
      reply_to   : _dmReplyTo?.id || null,
      _pending   : true,
    };
    _dmMessages.push(_tempMsg);
    const area = document.getElementById('messages-area');
    if (area) {
      const tmp = document.createElement('div');
      tmp.innerHTML = renderDMMessage(_tempMsg);
      const el = tmp.firstElementChild;
      if (el) {
        el.classList.add('dm-pending');
        el.setAttribute('data-own', '1');
        el.setAttribute('data-nonce', _nonce);
        el.style.opacity = '0.65';
        area.appendChild(el);
        _scrollDMToBottomStable();
      }
    }
  } catch (e) { console.warn('optimistic DM append failed', e); }

  clearReplyToDM();
  input.value = '';
  autoResize(input);
}

/* ── Incoming WS DM message ─────────────────────────────────────────────────── */
function handleWSDMMessage (data) {
  // Flag whether this DM is for the currently-open conversation (used by
  // notifications.js to suppress desktop/sound alerts when already reading).
  data._isActive = !!(_activeDM && data.channel_id === _activeDM.id);
  // Detect our own echoed-back DMs so we don't toast/alert on them
  const _selfId = STATE.user?.id;
  const _selfNick = STATE.user?.nickname;
  const _isMine = (data.sender_id != null && _selfId != null && +data.sender_id === +_selfId) ||
                  (data.sender_nick && _selfNick && data.sender_nick === _selfNick);
  data._isMine = _isMine;

  // Cheap in-place sidebar update (avoid round-tripping /api/dms on every message
  // which was adding 200-500 ms of perceived send lag).
  (async () => {
    try {
      const ch = _dmChannels.find(c => c.id === data.channel_id);
      if (ch) {
        const previewContent = await _decryptDMPreviewContent(
          data.content || '',
          data.sender_id || ch.with_user_id,
          data.sender_nick || ch.nickname,
        );
        ch.last_msg_raw = previewContent;
        ch.last_msg_meta = _parseDMCallLog(previewContent);
        ch.last_msg = _dmPreviewText(previewContent, data.has_media, data.media_type);
        ch.last_msg_at = data.created_at || new Date().toISOString();
        ch.last_msg_id = data.id || ch.last_msg_id || 0;
        ch.last_sender_id = data.sender_id != null ? +data.sender_id : ch.last_sender_id;
        if (!_isMine && !(data._isActive && !document.hidden)) {
          ch.unread = (ch.unread || 0) + 1;
        }
        // Bubble to top of list
        const idx = _dmChannels.indexOf(ch);
        if (idx > 0) { _dmChannels.splice(idx, 1); _dmChannels.unshift(ch); }
        renderDMChannels();
        // Notify with decrypted content so the system notification shows plaintext
        if (!_isMine && (document.hidden || !data._isActive)) {
          try {
            if (typeof Notifications !== 'undefined' && Notifications.notifyDM) {
              Notifications.notifyDM({ ...data, content: previewContent });
            }
          } catch {}
        }
      } else {
        // Unknown channel — fall back to refresh (rare path).
        loadDMChannels();
      }
    } catch {}
  })();

  if (!_activeDM || data.channel_id !== _activeDM.id) {
    // Not in this DM — async-decrypt and toast with readable text
    if (!_isMine) {
      (async () => {
        try {
          const ch2 = _dmChannels.find(c => c.id === data.channel_id);
          const toastContent = await _decryptDMPreviewContent(
            data.content || '',
            data.sender_id || ch2?.with_user_id || 0,
            data.sender_nick || ch2?.nickname || '',
          );
          const preview = _dmPreviewText(toastContent, data.has_media, data.media_type);
          toast(`💬 ${data.sender_nick}: ${preview ? preview.substring(0,60) : 'Media'}`, 'info', 4000);
        } catch {}
      })();
    }
    return;
  }

  // Our own echoed message — reconcile with any optimistic placeholder.
  if (_isMine) {
    const area = document.getElementById('messages-area');
    const pend = area?.querySelector('.dm-pending[data-nonce="' + (data.client_nonce || '') + '"]');
    if (pend && data.id) {
      pend.classList.remove('dm-pending');
      pend.removeAttribute('data-own');
      pend.removeAttribute('data-nonce');
      pend.setAttribute('data-dmid', data.id);
      pend.style.opacity = '';
      const tick = pend.querySelector('.msg-tick');
      if (tick) {
        tick.dataset.mid = data.id;
        tick.textContent = '✓';
        tick.title = 'Delivered';
        tick.classList.remove('msg-tick-pending', 'msg-tick-read');
      }
      // Replace any cached pending entry
      const pi = _dmMessages.findIndex(x => x._nonce === data.client_nonce);
      if (pi >= 0) _dmMessages[pi] = _normalizeDMMessage({ ...data, content: _dmMessages[pi].content });
      return;
    }

    // Fallback reconciliation when server/client nonce is missing: upgrade
    // the most recent pending bubble from me so sent state doesn't stay dull.
    if (data.id && area) {
      const pendingEls = Array.from(area.querySelectorAll('.dm-pending[data-own="1"], .dm-pending'));
      const fallback = pendingEls.length ? pendingEls[pendingEls.length - 1] : null;
      if (fallback) {
        fallback.classList.remove('dm-pending');
        fallback.removeAttribute('data-own');
        fallback.removeAttribute('data-nonce');
        fallback.setAttribute('data-dmid', data.id);
        fallback.style.opacity = '';
        const tick = fallback.querySelector('.msg-tick');
        if (tick) {
          tick.dataset.mid = data.id;
          tick.textContent = '✓';
          tick.title = 'Delivered';
          tick.classList.remove('msg-tick-pending', 'msg-tick-read');
        }
        let pi = -1;
        for (let i = _dmMessages.length - 1; i >= 0; i--) {
          const x = _dmMessages[i];
          if (x && x._pending && ((x.sender_id|0) === (_selfId|0))) { pi = i; break; }
        }
        if (pi >= 0) _dmMessages[pi] = _normalizeDMMessage({ ...data, content: _dmMessages[pi].content });
        return;
      }
    }
  }

  // Try to decrypt
  (async () => {
    let content = data.content || '';
    if (content) {
      const _dmChanEntry2 = _dmChannels.find(c => c.id === _activeDM?.id);
      const _peerUid  = _activeDM?.user_id || _dmChanEntry2?.with_user_id || 0;
      const _peerNk   = _activeDM?.nickname || '';
      try { content = await _decryptDMPreviewContent(content, _peerUid, _peerNk); } catch {}
    }
    appendDMMessage({ ...data, content });
    // Active chat — immediately mark as read
    if (!document.hidden) markDMRead();
  })();
}

function appendDMMessage (m) {
  m = _normalizeDMMessage(m);
  // Dedup: if a message with this id already exists (e.g. REST-sent media
  // then WS echo arrives), skip the second append.
  if (m.id && _dmMessages.some(x => x.id === m.id)) return;
  _dmMessages.push(m);
  if (_activeDM?.id) {
    _dmHistoryCache.set(_activeDM.id, _dmMessages.map(x => ({ ...x })));
    _dmHistoryMeta.set(_activeDM.id, {
      fetchedAt: Date.now(),
      lastMsgId: Number((_dmMessages[_dmMessages.length - 1]?.id) || 0),
    });
  }
  const area = document.getElementById('messages-area');
  if (!area) return;
  const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
  const myId = STATE.user?.id;
  const myNick = STATE.user?.nickname;
  const mine = (m.sender_id != null && myId != null && (+m.sender_id === +myId))
            || (!!m.sender_nick && !!myNick && m.sender_nick === myNick);
  const tmp = document.createElement('div');
  tmp.innerHTML = renderDMMessage(m);
  const el = tmp.firstElementChild;
  el.querySelectorAll('.dm-react-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const msgId = +btn.closest('[data-dmid]').dataset.dmid;
      toggleDMReaction(msgId, btn.dataset.emoji);
    });
  });
  area.appendChild(el);
  if (mine || atBottom) _scrollDMToBottomStable();
  // Auto-load media for new real-time DM messages (skip view-once — those need explicit tap)
  if (m.has_media && m.id && _activeDM && !m.view_once) {
    setTimeout(() => loadDMMedia(m.id, _activeDM.id), 100);
  }
}

/* ── Typing indicator ───────────────────────────────────────────────────────── */
function sendDMTyping () {
  if (!_activeDM) return;
  clearTimeout(_dmTypingTimer);
  wsSend({ type: 'dm_typing', channel_id: _activeDM.id });
  _dmTypingTimer = setTimeout(() => {}, 3000);
}

function handleWSDMTyping (data) {
  if (!_activeDM || data.channel_id !== _activeDM.id) return;
  const bar = document.getElementById('typing-bar');
  if (!bar) return;
  bar.style.display = '';
  const who = data.sender_nick || data.nickname || 'Someone';
  bar.textContent = who + ' is typing…';
  clearTimeout(_dmTypingTimer);
  _dmTypingTimer = setTimeout(() => { bar.textContent = ''; }, 3000);
}

/* ── Edit / Delete DM ───────────────────────────────────────────────────────── */
async function editDMMsg (id) {
  const m = _dmMessages.find(x => x.id === id);
  if (!m) return;
  const newContent = prompt('Edit message:', m.content || '');
  if (newContent === null) return;
  let enc = newContent;
  if (STATE.sharedSecret) { try { enc = await encryptMsg(newContent); } catch {} }
  const r = await apiFetch(`/api/dms/${_activeDM.id}/messages/${id}`, 'PUT', { content: enc });
  if (r.ok) {
    m.content  = newContent;
    m.edited_at = new Date().toISOString();
    renderDMChat();
  }
}

async function deleteDMMsg (id) {
  if (!confirm('Delete this message?')) return;
  const r = await apiFetch(`/api/dms/${_activeDM.id}/messages/${id}`, 'DELETE');
  if (r.ok) {
    _dmMessages = _dmMessages.filter(x => x.id !== id);
    renderDMChat();
  }
}

/* ── Reactions ─────────────────────────────────────────────────────────────── */
async function toggleDMReaction (msgId, emoji) {
  await apiFetch(`/api/dms/${_activeDM.id}/messages/${msgId}/react`, 'POST', { emoji });
  // Reload messages to get updated counts
  loadDMMessages();
}

/* ── Reply ─────────────────────────────────────────────────────────────────── */
function replyToDM (id, nick, content) {
  _dmReplyTo = { id, nick, content };
  const bar = document.getElementById('reply-bar');
  if (!bar) return;
  bar.style.display = 'flex';
  const nickEl = bar.querySelector('#reply-bar-nick');
  const textEl = bar.querySelector('#reply-bar-text');
  const closeBtn = bar.querySelector('button[title="Cancel reply"]');
  if (nickEl) nickEl.textContent = nick;
  if (textEl) textEl.textContent = content || 'Media';
  if (closeBtn) {
    closeBtn.onclick = clearReplyToDM;
  }
}

function clearReplyToDM () {
  _dmReplyTo = null;
  const bar = document.getElementById('reply-bar');
  if (!bar) return;
  bar.style.display = 'none';
  const closeBtn = bar.querySelector('button[title="Cancel reply"]');
  if (closeBtn) {
    closeBtn.onclick = () => {
      if (typeof Messages !== 'undefined' && typeof Messages.clearReply === 'function') {
        Messages.clearReply();
      }
    };
  }
}

/* ── Lightbox ─────────────────────────────────────────────────────────────── */
function openLightbox (src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.remove('hidden');
}
function closeLightbox () {
  document.getElementById('lightbox').classList.add('hidden');
}
function openLightboxInNewTab () {
  const src = document.getElementById('lightbox-img').src;
  if (!src) return;
  if (src.startsWith('data:')) {
    // Convert data URI to blob URL so it opens in a new tab
    try {
      const [header, b64] = src.split(',');
      const mime = header.match(/:(.*?);/)?.[1] || 'image/png';
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: mime });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch { window.open(src, '_blank'); }
  } else {
    window.open(src, '_blank');
  }
}

/* ── Helper ─────────────────────────────────────────────────────────────────── */
function isDMView () {
  return !!_activeDM;
}

/* ── Disappearing Messages ────────────────────────────────────────────────── */
let _dmDisappearTimer = 0;

async function loadDisappearTimer() {
  if (!_activeDM) return;
  try {
    const r = await apiFetch(`/api/dms/${_activeDM.id}/disappear`);
    if (r.ok) {
      const data = await r.json();
      _dmDisappearTimer = data.seconds || 0;
      updateDisappearIndicator();
    }
  } catch (e) {
    console.error('loadDisappearTimer', e);
  }
}

function updateDisappearIndicator() {
  // Remove existing indicator
  const existing = document.getElementById('disappear-indicator');
  if (existing) existing.remove();
  
  if (!_activeDM || _dmDisappearTimer === 0) return;
  
  // Add indicator next to channel title
  const header = document.getElementById('ch-desc');
  if (header) {
    const label = formatDisappearTime(_dmDisappearTimer);
    header.innerHTML = `Direct message · <span id="disappear-indicator" style="color:#f9a825;cursor:pointer" onclick="showDisappearSettings()" title="Messages disappear after ${label}">⏱️ ${label}</span>`;
  }
}

function formatDisappearTime(seconds) {
  if (seconds <= 0) return 'Off';
  if (seconds === 3600) return '1h';
  if (seconds === 86400) return '24h';
  if (seconds === 604800) return '7d';
  if (seconds === 2592000) return '30d';
  return seconds + 's';
}

function showDisappearSettings() {
  if (!_activeDM) return;
  
  // Create modal if doesn't exist
  let modal = document.getElementById('modal-disappear');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal-overlay hidden';
    modal.id = 'modal-disappear';
    modal.innerHTML = `
      <div class="modal" style="max-width:320px">
        <div class="modal-title">⏱️ Disappearing Messages</div>
        <div style="font-size:13px;color:#888;margin-bottom:16px">
          Messages will be automatically deleted after the selected time.
        </div>
        <select class="modal-input" id="disappear-select" style="color:#e0e0e0;background:#0d0d0d">
          <option value="0">Off</option>
          <option value="3600">1 hour</option>
          <option value="86400">24 hours</option>
          <option value="604800">7 days</option>
          <option value="2592000">30 days</option>
        </select>
        <div class="modal-actions">
          <button class="modal-btn secondary" onclick="closeModal('modal-disappear')">Cancel</button>
          <button class="modal-btn danger" onclick="wipeDMMessages();closeModal('modal-disappear')">🗑️ Wipe All</button>
          <button class="modal-btn primary" onclick="saveDisappearTimer()">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  
  // Set current value
  document.getElementById('disappear-select').value = _dmDisappearTimer.toString();
  openModal('modal-disappear');
}

async function saveDisappearTimer() {
  if (!_activeDM) return;
  
  const seconds = parseInt(document.getElementById('disappear-select').value) || 0;
  
  try {
    const r = await apiFetch(`/api/dms/${_activeDM.id}/disappear`, 'POST', { seconds });
    if (!r.ok) {
      const data = await r.json();
      toast(data.error || 'Failed to set timer', 'error');
      return;
    }
    
    _dmDisappearTimer = seconds;
    updateDisappearIndicator();
    closeModal('modal-disappear');
    
    if (seconds > 0) {
      toast(`Messages will disappear after ${formatDisappearTime(seconds)}`);
    } else {
      toast('Disappearing messages turned off');
    }
  } catch (e) {
    toast('Failed to set timer', 'error');
  }
}
