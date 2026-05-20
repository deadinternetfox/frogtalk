/**
 * ws.js — WebSocket client with auto-reconnect
 */

const WS = (() => {
  let _ws = null;
  let _room = null;
  let _reconnectTimer = null;
  let _reconnectDelay = 1000;
  let _pingInterval = null;
  let _stableTimer = null;
  const _historyInFlight = new Map();
  const _historyLastApplied = new Map();

  // Word-boundary @mention detector. Allows letters, digits, underscore and
  // hyphen (NICKNAME_RE on the server), and refuses to fire when the
  // nickname is a strict prefix of a longer handle (so @frog won't match
  // @frogai). Case-insensitive; escapes the nickname for regex safety.
  function _isMentionOf(text, nick) {
    if (!text || !nick) return false;
    try {
      const esc = String(nick).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(^|[^A-Za-z0-9_-])@' + esc + '(?![A-Za-z0-9_-])', 'i');
      return re.test(String(text));
    } catch {
      return false;
    }
  }

  function resetHistoryCache(room) {
    if (!room) return;
    _historyInFlight.delete(room);
    _historyLastApplied.delete(room);
  }

  function connect(room) {
    resetHistoryCache(room);
    if (_ws && _room === room) {
      if (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN) {
        return;
      }
    }
    // Clear any pending reconnect timer to prevent old onclose from triggering
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    if (_stableTimer) { clearTimeout(_stableTimer); _stableTimer = null; }
    if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
    // Close old WS without triggering reconnect
    if (_ws) {
      _ws.onclose = null;
      _ws.onerror = null;
      _ws.onmessage = null;
      _ws.close();
      _ws = null;
    }
    _room = room;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/${encodeURIComponent(room)}?token=${encodeURIComponent(State.token)}`;
    const ws = new WebSocket(url);
    _ws = ws;

    ws.onopen = () => {
      // Only reset backoff after connection is stable for 5 seconds
      _stableTimer = setTimeout(() => { _reconnectDelay = 1000; }, 5000);
      if (_pingInterval) clearInterval(_pingInterval);
      _pingInterval = setInterval(() => {
        if (_ws === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'ping'}));
      }, 30000);
      UI.setConnectionStatus && UI.setConnectionStatus('connected');
      if (typeof ConnErr !== 'undefined') ConnErr.onWsOk();
      // Notify subsystems (calls.js, etc.) so they can flush any locally
      // queued sends. Cold-start incoming-call answers fire ICE before this
      // socket reaches OPEN, and without a flush hook those candidates are
      // silently dropped.
      try { window.dispatchEvent(new CustomEvent('ws:open', { detail: { room } })); } catch {}
      try { UI.refreshSelfProfileFromServer && UI.refreshSelfProfileFromServer(); } catch {}
    };

    ws.onmessage = async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      try { await handleServerMsg(data); } catch (err) { console.error('[WS] handleServerMsg error:', err); }
    };

    ws.onclose = (ev) => {
      // Only reconnect if this is still the current WS
      if (_ws !== ws) return;
      if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
      if (_stableTimer) { clearTimeout(_stableTimer); _stableTimer = null; }
      // Server-issued "do-not-reconnect" close codes. The server uses 4003
      // when access is refused (e.g. the user was just banned from this
      // room) — auto-reconnecting in that case loops forever and paints
      // the disorienting "Connection lost" banner on top of the ban UI.
      // 4001 = bad token (logout/expired), 4007 = bad origin (CSWSH),
      // 4008 = per-IP cap. None of these are worth retrying silently.
      const noRetry = ev && (ev.code === 4001 || ev.code === 4003 || ev.code === 4007 || ev.code === 4008);
      if (noRetry) {
        _room = null;
        try { UI.setConnectionStatus && UI.setConnectionStatus('connected'); } catch {}
        return;
      }
      _reconnectTimer = setTimeout(() => {
        if (_room) connect(_room);
      }, _reconnectDelay);
      const thisDelay = _reconnectDelay;
      _reconnectDelay = Math.min(_reconnectDelay * 2, 30000);
      UI.setConnectionStatus && UI.setConnectionStatus('reconnecting');
      if (typeof ConnErr !== 'undefined') ConnErr.onWsFail(thisDelay);
    };

    ws.onerror = () => {};
  }

  function disconnect() {
    if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    _room = null;
    if (_ws) { _ws.close(); _ws = null; }
  }

  function send(obj) {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify(obj));
    }
  }

  function isOpen() {
    return !!(_ws && _ws.readyState === WebSocket.OPEN);
  }

  async function handleServerMsg(data) {
    const room = _room;
    switch (data.type) {
      case 'history': {
        const incoming = data.messages || [];
        const histSig = `${incoming.length}:${incoming[0]?.id || 0}:${incoming[incoming.length - 1]?.id || 0}`;
        const prevApplied = _historyLastApplied.get(room);
        // Drop duplicate history packets while the first one is still being
        // decrypted/rendered, and suppress immediate replays of the same
        // history window.
        if (_historyInFlight.get(room) === histSig || prevApplied === histSig) {
          Users.updateList(data.online || []);
          // Edge case: empty channel revisit. After a fresh-create with no
          // messages the first history packet (sig "0:0:0") is applied and
          // remembered. Switching away and back fires switchToRoom which
          // paints a "Loading #room…" spinner; the next history packet
          // matches the remembered sig so the early-out skips loadHistory
          // and the spinner sticks forever. If the messages area is still
          // showing the loading state for THIS room, force a re-render
          // from cache (which may legitimately be empty → empty-state).
          try {
            if (State.currentRoom === room) {
              const area = document.getElementById('messages-area');
              if (area && area.querySelector('#ch-loading-state')) {
                const cachedNow = (State.messages && State.messages[room]) || [];
                Messages.loadHistory(room, cachedNow.slice());
              }
            }
          } catch {}
          break;
        }
        _historyInFlight.set(room, histSig);
        try {
          const cached = (State.messages && State.messages[room]) ? State.messages[room] : [];
          // After a channel rename the server may briefly return an empty history
          // window while rows are being re-keyed; never wipe a populated cache.
          if (!incoming.length && cached.length) {
            _historyLastApplied.set(room, histSig);
            Users.updateList(data.online || []);
            try {
              if (State.currentRoom === room) {
                const area = document.getElementById('messages-area');
                if (area && (area.querySelector('#ch-loading-state') || !area.children.length)) {
                  Messages.loadHistory(room, cached.slice());
                }
              }
            } catch {}
            break;
          }
          // If server resent the same history window, skip expensive decrypt +
          // full DOM rebuild. Presence still updates below.
          if (cached.length && incoming.length) {
            const sameLen = cached.length === incoming.length;
            const sameFirst = Number(cached[0]?.id || 0) === Number(incoming[0]?.id || 0);
            const sameLast = Number(cached[cached.length - 1]?.id || 0) === Number(incoming[incoming.length - 1]?.id || 0);
            if (sameLen && sameFirst && sameLast) {
              _historyLastApplied.set(room, histSig);
              Users.updateList(data.online || []);
              // Same defensive paint-over as the dedup-by-sig branch
              // above: if the spinner is still up, render from cache.
              try {
                if (State.currentRoom === room) {
                  const area = document.getElementById('messages-area');
                  if (area && area.querySelector('#ch-loading-state')) {
                    Messages.loadHistory(room, cached.slice());
                  }
                }
              } catch {}
              break;
            }
          }
          const decrypted = await Promise.all(
            incoming.map(m => decryptMsg(m, room))
          );
          Messages.loadHistory(room, decrypted);
          try {
            if (State.currentRoom === room && State.currentChannelType !== 'voice') {
              const inputArea = document.getElementById('input-area');
              if (inputArea) inputArea.style.display = '';
            }
          } catch {}
          _historyLastApplied.set(room, histSig);
          Users.updateList(data.online || []);
        } finally {
          _historyInFlight.delete(room);
        }
        break;
      }
      case 'message': {
        const msgRoom = data.room || room;
        const dm = await decryptMsg(data, msgRoom);
        Messages.appendMessage(msgRoom, dm);
        const myNick = State.user?.nickname || '';
        // Use a word-boundary mention check so e.g. @frog doesn't also match
        // inside @frogai (substring fired a self-notif when our bot was
        // mentioned and the bot's name shared a prefix with the owner).
        const isMention = !!(myNick && _isMentionOf(dm.content, myNick));
        // Skip sounds / desktop notifications for muted users or muted rooms.
        const mutedAuthor = typeof Mute !== 'undefined' && Mute.isUserMuted(dm.nickname);
        const mutedRoom = typeof Mute !== 'undefined' && Mute.isRoomMuted(msgRoom);
        if (mutedAuthor || mutedRoom) break;
        if (document.hidden || isMention) Notifications.notify(dm);
        break;
      }
      case 'edit': {
        const hasContent = Object.prototype.hasOwnProperty.call(data, 'content');
        const hasMediaBlur = Object.prototype.hasOwnProperty.call(data, 'media_blur');
        // Server broadcasts content in the same ciphertext form it received.
        // Decrypt before rendering when content was part of this edit payload.
        let plain = data.content;
        if (hasContent) {
          try {
            const ver = parseInt(data.key_version, 10) || 0;
            let key = State.roomKeys[room];
            let aad = null;
            if (ver > 0 && window.Rooms && typeof Rooms.getRoomKeyForVersion === 'function') {
              try { key = (await Rooms.getRoomKeyForVersion(room, ver)) || key; } catch {}
              try {
                const r = (State.rooms || []).find(x => x.name === room);
                if (r && r.id) aad = Rooms.aadForRoom(r.id, ver);
              } catch {}
            }
            if (key && data.content) {
              const p = await Crypto.decrypt(data.content, key, aad || undefined);
              if (p !== null) plain = p;
            }
          } catch {}
        }
        // Keep the local cache in sync so re-renders and replies see updates.
        try {
          const cache = State.messages?.[room] || [];
          const m = cache.find(x => x.id === data.id);
          if (m) {
            if (hasContent) m.content = plain;
            if (hasMediaBlur) m.media_blur = data.media_blur ? 1 : 0;
            m.edited = 1;
          }
        } catch {}
        Messages.updateEdited(data.id, hasContent ? plain : null, room, {
          hasContent,
          media_blur: hasMediaBlur ? (data.media_blur ? 1 : 0) : undefined,
        });
        break;
      }
      case 'delete': {
        Messages.removeMessage(data.id);
        break;
      }
      case 'preview_suppress': {
        try { Messages.applyPreviewSuppress?.(data.id); } catch {}
        break;
      }
      case 'media_blur': {
        try { Messages.applyMediaBlur?.(data.id, !!data.blur, data.room); } catch {}
        break;
      }
      case 'dm_preview_suppress': {
        try { window.applyDMPreviewSuppress?.(data.id); } catch {}
        break;
      }
      case 'dm_media_blur': {
        try { window.applyDMMediaBlur?.(data.id, !!data.blur, data.channel_id); } catch {}
        break;
      }
      case 'reaction': {
        Messages.updateReactions(data.id, data.reactions);
        break;
      }
      case 'dm_reaction': {
        Messages.updateReactions(data.id, data.reactions);
        break;
      }
      case 'pin':
      case 'unpin': {
        // Live update the Discord-style pinned banner above the chat for
        // every connected client in this room. Also flip the per-message
        // 📌 badge so users don't have to reload to see it.
        try {
          if (typeof window.onPinEventLive === 'function') {
            window.onPinEventLive(data);
          }
          const el = document.getElementById(`msg-${data.id}`);
          if (el) {
            if (data.type === 'pin' && !el.querySelector('.msg-pinned')) {
              const head = el.querySelector('.msg-author')?.parentElement;
              if (head) {
                const tag = document.createElement('span');
                tag.className = 'msg-pinned';
                tag.style.cssText = 'color:#4caf50;font-size:11px;margin-left:4px';
                tag.textContent = '📌';
                head.appendChild(tag);
              }
            } else if (data.type === 'unpin') {
              el.querySelectorAll('.msg-pinned').forEach(n => n.remove());
            }
          }
        } catch {}
        break;
      }
      case 'typing': {
        UI.showTyping(data.nickname, data.room);
        break;
      }
      case 'presence': {
        UI.showPresence(data.event, data.nickname);
        // A user just came online — they may be a brand-new channel member
        // who isn't in our cached @mention list yet. Trigger a throttled
        // refresh so the autocomplete includes them next time.
        if (data.event === 'join' || data.event === 'online') {
          try { window.refreshMentionUsers && window.refreshMentionUsers(); } catch {}
        }
        break;
      }
      case 'online_users': {
        if (data.room === room) Users.updateList(data.users || []);
        // Refresh mentionable list when room roster updates so new members
        // appear in the @ autocomplete.
        try { window.refreshMentionUsers && window.refreshMentionUsers(); } catch {}
        break;
      }
      case 'member_joined': {
        // A new member joined this room (either via REST /join or via a
        // first-time WS connect). Refresh the channel-members cache so
        // the right-hand sidebar shows them immediately, even if they
        // haven't opened a WS to this room yet.
        if (data.room === room && typeof Users !== 'undefined' && Users.loadChannelMembers) {
          try { Users.loadChannelMembers(data.room); } catch {}
        }
        try { window.refreshMentionUsers && window.refreshMentionUsers(); } catch {}
        break;
      }
      case 'bot_added':
      case 'bot_removed': {
        // A bot was installed in or removed from this room. Refresh the
        // sidebar so the BOT entry appears/disappears live without
        // requiring a channel close+reopen.
        if (data.room === room && typeof Users !== 'undefined' && Users.loadChannelMembers) {
          try { Users.loadChannelMembers(data.room); } catch {}
        }
        try { window.refreshMentionUsers && window.refreshMentionUsers(); } catch {}
        break;
      }
      case 'room_owner_changed': {
        // Owner transferred. Update locally cached mod list (the
        // outgoing owner just became a moderator) and surface a small
        // toast for everyone watching the room. The new owner gets a
        // direct `room_ownership_received` ping below.
        if (data.room === room) {
          try {
            // Refresh full room metadata so the moderator list and
            // owner_nickname pick up the change without a reload.
            fetch(`/api/rooms/${encodeURIComponent(data.room)}`, {
              headers: { 'X-Session-Token': State.token }
            }).then(r => r.json()).then(roomData => {
              if (roomData && Array.isArray(roomData.moderators)) {
                State.currentRoomMods = roomData.moderators.map(m => m.nickname);
              }
            }).catch(() => {});
          } catch {}
          try {
            const prev = data.previous_owner_nickname || 'previous owner';
            const next = data.new_owner_nickname || 'new owner';
            UI.showToast(`#${data.room}: ${prev} transferred ownership to ${next}`);
          } catch {}
        }
        try { window.refreshMentionUsers && window.refreshMentionUsers(); } catch {}
        break;
      }
      case 'room_ownership_received': {
        // Direct ping to the new owner. Toast even if they're not
        // currently looking at that room — they'll likely want to know.
        try {
          const from = data.from_nickname || 'someone';
          UI.showToast(`You're now the owner of #${data.room} (transferred by ${from})`);
        } catch {}
        break;
      }
      case 'profile_update': {
        const sameUser = (user) => {
          if (!user) return false;
          if (data.user_id != null && user.id != null && String(data.user_id) === String(user.id)) return true;
          const a = String(data.nickname || '').toLowerCase();
          const b = String(user.nickname || '').toLowerCase();
          return !!(a && b && a === b);
        };
        // If our own avatar changed on another device, sync local state + self panel
        if (sameUser(State.user)) {
          if (data.avatar !== undefined) State.user.avatar = data.avatar;
          try { State.save(); } catch {}
          try {
            const sa = document.getElementById('self-avatar-el');
            if (sa) sa.innerHTML = UI.avatarEl(State.user.avatar, State.user.nickname, 36);
          } catch {}
        }
        if (typeof Users !== 'undefined' && Users.updateAvatar) {
          Users.updateAvatar(data.user_id, data.nickname, data.avatar);
        }
        // Sync presence/status changes into member list rows immediately.
        if (data.presence !== undefined || data.status_msg !== undefined) {
          const isSelf = sameUser(State.user);
          const allowedPresence = new Set(['online', 'away', 'dnd', 'invisible']);
          const nextPresence = (typeof data.presence === 'string' && allowedPresence.has(data.presence))
            ? data.presence
            : undefined;
          const statusPatch = (data.status_msg !== undefined && (data.status_msg || isSelf))
            ? String(data.status_msg || '').slice(0, 128)
            : undefined;
          if (isSelf) {
            if (nextPresence !== undefined) State.user.presence = nextPresence;
            if (statusPatch !== undefined) State.user.status_msg = statusPatch;
            try { State.save(); } catch {}
            try { UI.renderSelfStatus && UI.renderSelfStatus(); } catch {}
          }
          if (typeof Users !== 'undefined' && Users.updatePresence) {
            Users.updatePresence(data.user_id, data.nickname, nextPresence, statusPatch);
          }
        }
        // Sync display_name change to member list caches
        if (data.display_name !== undefined) {
          if (sameUser(State.user)) {
            State.user.display_name = data.display_name || null;
            try { State.save(); } catch {}
            // Update self panel
            try { UI.setSelfNameAndHandle(); } catch {}
          }
          if (typeof Users !== 'undefined' && Users.updateDisplayName) {
            Users.updateDisplayName(data.user_id, data.nickname, data.display_name || null);
          }
        }
        // Refresh inline Suggested-for-you avatars + any social-rendered profile refs.
        try {
          if (data.avatar !== undefined && typeof Social !== 'undefined' && Social.refreshUserProfile) {
            Social.refreshUserProfile(data.user_id, data.nickname, data.avatar);
          }
        } catch {}
        // Propagate to friends list cache + re-render if panel open
        try {
          if (typeof _allFriends !== 'undefined' && Array.isArray(_allFriends)) {
            let fChanged = false;
            for (const f of _allFriends) {
              const sameById = data.user_id && (String(f.user_id || f.id || '') === String(data.user_id));
              const sameByNick = data.nickname && f.nickname === data.nickname;
              if (sameById || sameByNick) {
                if (data.avatar !== undefined) { f.avatar = data.avatar; fChanged = true; }
                if (data.display_name !== undefined) { f.display_name = data.display_name || null; fChanged = true; }
                if (data.presence !== undefined) { f.presence = data.presence || 'online'; fChanged = true; }
                if (data.status_msg !== undefined && data.status_msg) {
                  f.status_msg = data.status_msg;
                  fChanged = true;
                }
              }
            }
            if (fChanged) {
              const fp = document.getElementById('friends-panel');
              if (fp && !fp.classList.contains('hidden') && typeof renderFriendTab === 'function') {
                renderFriendTab();
              }
              const frogPanel = document.getElementById('frog-friends-panel');
              if (frogPanel && frogPanel.classList.contains('open') && typeof renderFfpContent === 'function') {
                const activeTab = document.querySelector('.ffp-tab.active')?.dataset?.tab || 'online';
                renderFfpContent(activeTab);
              }
            }
          }
        } catch {}
        // Propagate to DM channel cache + re-render sidebar
        try {
          if (typeof _dmChannels !== 'undefined' && Array.isArray(_dmChannels)) {
            let dChanged = false;
            for (const ch of _dmChannels) {
              if ((data.user_id && ch.with_user_id === data.user_id) ||
                  (data.nickname && ch.nickname === data.nickname)) {
                if (data.avatar !== undefined) { ch.avatar = data.avatar; dChanged = true; }
              }
            }
            if (dChanged && typeof renderDMChannels === 'function') renderDMChannels();
          }
        } catch {}
        // Live-update any rendered message avatars across ALL rooms for this user
        try {
          if (data.avatar !== undefined && data.nickname) {
            const sel = `.msg-group[data-nick="${CSS.escape(data.nickname)}"] .msg-avatar`;
            document.querySelectorAll(sel).forEach(el => {
              el.innerHTML = UI.avatarEl(data.avatar, data.nickname, 38);
            });
          }
        } catch {}
        break;
      }
      case 'error': {
        UI.showToast(data.text, 'error');
        break;
      }
      // ── Social activity (likes / comments / follows on YOUR posts) ──
      case 'social_notification': {
        try {
          if (window.Social && typeof window.Social.handleSocialNotification === 'function') {
            window.Social.handleSocialNotification(data);
          }
        } catch {}
        break;
      }
      // ── Encrypted wall re-wrap needed (new follower / accepted friend) ──
      case 'wall_rewrap_needed': {
        try {
          if (window.WallCrypto && typeof window.WallCrypto.extendWrapsForRecipient === 'function') {
            window.WallCrypto.extendWrapsForRecipient(
              Number(data.follower_user_id || 0),
              Array.isArray(data.post_ids) ? data.post_ids.map(Number).filter(Boolean) : []
            );
          }
        } catch {}
        break;
      }
      // ── Story posted by anyone — refresh chat-avatar story rings live ──
      case 'story_posted': {
        try {
          if (window._frogtalkStoryRingDebug) {
            try { /* story_posted ws event */ void data; } catch {}
          }
          if (window.Social) {
            // Optimistic local update (instant ring flip) + background true-up.
            // Falls back to a plain force-refresh if the optimistic helper
            // isn't loaded yet (older social.js cached by the SW).
            if (typeof window.Social.markUserStoryPostedLive === 'function') {
              window.Social.markUserStoryPostedLive(data.user_id, data.nickname);
            } else if (typeof window.Social.refreshChatStoryCache === 'function') {
              window.Social.refreshChatStoryCache(true);
            }
          }
        } catch {}
        break;
      }
      // ── DM events ────────────────────────────────
      case 'dm_message': {
        if (typeof handleWSDMMessage === 'function') handleWSDMMessage(data);
        // Notification is now fired from handleWSDMMessage with decrypted content
        break;
      }
      case 'dm_typing': {
        if (typeof handleWSDMTyping === 'function') handleWSDMTyping(data);
        break;
      }
      case 'dm_read': {
        if (typeof handleWSDMRead === 'function') handleWSDMRead(data);
        break;
      }
      case 'dm_view_once_viewed': {
        if (typeof handleWSDMViewOnceViewed === 'function') handleWSDMViewOnceViewed(data);
        break;
      }
      case 'dm_view_once_viewed_by_peer': {
        if (typeof handleWSDMViewOnceViewedByPeer === 'function') handleWSDMViewOnceViewedByPeer(data);
        break;
      }
      case 'dm_forwarding': {
        if (typeof handleWSDMForwarding === 'function') handleWSDMForwarding(data);
        break;
      }
      case 'dm_send_error': {
        // Server rejected a WS dm_message (currently: blocked either way).
        // Hand off to dms.js which knows about optimistic bubbles + nonces.
        try {
          if (typeof window.handleDMSendError === 'function') window.handleDMSendError(data);
          else if (data.code === 'blocked') {
            const who = data.peer_nickname ? '@' + data.peer_nickname : 'this user';
            const text = data.i_blocked
              ? `You have blocked ${who} — unblock to message them.`
              : `You have been blocked by ${who}.`;
            try { (window.toast || window.UI?.showToast)?.(text, 'error'); } catch {}
          }
        } catch {}
        break;
      }
      // ── WebRTC call signaling ─────────────────────
      case 'call_offer': {
        if (typeof handleCallOffer === 'function') handleCallOffer(data);
        break;
      }
      case 'call_created': {
        if (typeof handleCallCreated === 'function') handleCallCreated(data);
        break;
      }
      case 'call_answer': {
        Notifications.stopRinging();
        if (typeof handleCallAnswer === 'function') handleCallAnswer(data);
        break;
      }
      case 'call_reject': {
        Notifications.stopRinging();
        if (typeof handleCallReject === 'function') handleCallReject(data);
        break;
      }
      case 'call_unreachable': {
        // Server confirmed the callee is fully offline (no WS, no FCM/APNs/web-push).
        // Stop ringing immediately instead of timing out after 30s.
        Notifications.stopRinging();
        const nick = (typeof _callPeerNick !== 'undefined' && _callPeerNick) || 'User';
        if (typeof toast === 'function') toast(`${nick} is unavailable`, 'info');
        if (typeof resetCall === 'function') resetCall();
        if (typeof closeCallOverlay === 'function') closeCallOverlay();
        break;
      }
      case 'call_handled': {
        // Sent to all of this user's sessions when the call was accepted or
        // declined elsewhere (e.g. via the Android system notification action
        // while the WebView was still ringing). Silence any incoming-call UI.
        Notifications.stopRinging();
        if (typeof handleCallHandled === 'function') handleCallHandled(data);
        break;
      }
      case 'call_end': {
        Notifications.stopRinging();
        if (typeof handleCallEnd === 'function') handleCallEnd(data);
        break;
      }
      case 'call_error': {
        Notifications.stopRinging();
        if (typeof handleCallError === 'function') handleCallError(data);
        else {
          const nick = (typeof _callPeerNick !== 'undefined' && _callPeerNick) || 'User';
          if (data.reason === 'peer_offline') {
            // Keep call flow alive so push-wake can ring the recipient and caller
            // still sees normal timeout behavior instead of an immediate hard fail.
            toast(`${nick} is offline right now — trying push ring`, 'info');
          } else {
            const reason = data.reason === 'user_not_found'
              ? 'Could not find that user'
              : 'Call failed';
            toast(reason, 'error');
            if (typeof resetCall === 'function') resetCall();
            if (typeof closeCallOverlay === 'function') closeCallOverlay();
          }
        }
        break;
      }
      case 'ice_candidate': {
        if (typeof handleIceCandidate === 'function') handleIceCandidate(data);
        break;
      }
      // ── Group voice channel signaling ─────────────
      case 'voice_joined': {
        if (typeof handleVoiceJoined === 'function') handleVoiceJoined(data);
        break;
      }
      case 'voice_user_joined': {
        if (typeof handleVoiceUserJoined === 'function') handleVoiceUserJoined(data);
        break;
      }
      case 'voice_user_left': {
        if (typeof handleVoiceUserLeft === 'function') handleVoiceUserLeft(data);
        break;
      }
      case 'voice_offer': {
        if (typeof handleVoiceOffer === 'function') handleVoiceOffer(data);
        break;
      }
      case 'voice_answer': {
        if (typeof handleVoiceAnswer === 'function') handleVoiceAnswer(data);
        break;
      }
      case 'voice_ice': {
        if (typeof handleVoiceIce === 'function') handleVoiceIce(data);
        break;
      }
      case 'voice_error': {
        if (typeof handleVoiceError === 'function') handleVoiceError(data);
        break;
      }
      case 'voice_mute': {
        if (typeof handleVoiceMute === 'function') handleVoiceMute(data);
        break;
      }
      // ── Friend notifications ──────────────────────
      case 'friend_notify': {
        Notifications.notifyFriend(data);
        if (typeof handleFriendNotify === 'function') handleFriendNotify(data);
        break;
      }
      // ── Music channel events ──────────────────────
      case 'music_track_added':
      case 'music_track_removed':
      case 'music_track_skipped':
      case 'music_queue_cleared':
      case 'music_dj_only_changed':
      case 'music_djs_changed': {
        try { window.Music?.handleWsEvent?.(data); } catch {}
        break;
      }
      case 'room_settings_updated': {
        try { window.Rooms?.onRoomSettingsUpdated?.(data.room, data); } catch {}
        if (data.renamed_from && data.room) {
          try { window.Social?.onRoomRenamed?.(data.renamed_from, data.room); } catch {}
        }
        break;
      }
      case 'room_renamed': {
        if (data.old_name && data.new_name) {
          try { window.Social?.onRoomRenamed?.(data.old_name, data.new_name); } catch {}
        }
        break;
      }
      // ── Room ban / kick (Discord-style channel close) ────
      case 'room_ban': {
        try { if (typeof handleRoomBan === 'function') handleRoomBan(data); } catch {}
        break;
      }
      case 'room_unban': {
        try { if (typeof handleRoomUnban === 'function') handleRoomUnban(data); } catch {}
        break;
      }
      case 'room_muted': {
        // A mod muted us in this channel — toast + disable composer if
        // we're currently looking at that room. We also persist the
        // expiry on State so the per-room view code (rooms.js) can
        // re-apply the disabled state when the user switches back.
        try {
          window._roomMutes = window._roomMutes || {};
          window._roomMutes[data.room] = {
            reason: data.reason || '',
            expires_at: data.expires_at || null,
            duration_minutes: data.duration_minutes || null,
            muted_by: data.muted_by || '',
          };
          UI.showToast(`🔇 You were muted in #${data.room}${data.reason ? ': ' + data.reason : ''}`, 'warning');
          if (State.currentRoom === data.room && typeof window._applyRoomMuteUI === 'function') {
            window._applyRoomMuteUI(data.room);
          }
        } catch {}
        break;
      }
      case 'room_unmuted': {
        try {
          window._roomMutes = window._roomMutes || {};
          delete window._roomMutes[data.room];
          UI.showToast(`🔊 You were unmuted in #${data.room}`, 'success');
          if (State.currentRoom === data.room && typeof window._applyRoomMuteUI === 'function') {
            window._applyRoomMuteUI(data.room);
          }
        } catch {}
        break;
      }
      case 'user_banned': {
        // A peer was banned/kicked from this room. Surface a system toast,
        // live-remove them from the sidebar member list, and refresh the
        // @mention candidates so they vanish from autocomplete too — no
        // tab-out/tab-in needed.
        try {
          if (data.room && data.room === State.currentRoom && data.nickname) {
            UI.showToast(`@${data.nickname} was banned from #${data.room}`, 'info');
          }
          if (typeof Users !== 'undefined' && typeof Users.removeMember === 'function') {
            Users.removeMember(data.user_id, data.nickname);
          }
          if (typeof window.refreshMentionUsers === 'function') {
            window.refreshMentionUsers(true);
          }
        } catch {}
        break;
      }
      // ── Private-room key rotation ────────────────────────────────────
      // Sent only to the moderator who just performed a ban — instructs
      // their client to generate and fan out a fresh room key.
      case 'room_should_rotate': {
        try {
          if (window.Rooms && typeof Rooms.rotateRoomKey === 'function') {
            Rooms.rotateRoomKey(data.room, {
              reason: data.reason || 'ban',
              targetUserId: data.target_user_id || null,
              targetNickname: data.target_nickname || null,
            }).catch(e => console.warn('[ws] auto-rotate failed', e));
          }
        } catch (e) { console.warn('[ws] room_should_rotate handler', e); }
        break;
      }
      // Sent to each remaining member after a successful rotation. Carries
      // the new room secret encrypted with the recipient's Signal session.
      case 'room_key_envelope': {
        try {
          if (window.Rooms && typeof Rooms.installRotatedKey === 'function') {
            Rooms.installRotatedKey({
              room: data.room,
              version: data.version,
              env: data.env,
              from_user_id: data.from_user_id,
              from_nickname: data.from_nickname,
            }).catch(e => console.warn('[ws] installRotatedKey failed', e));
          }
        } catch (e) { console.warn('[ws] room_key_envelope handler', e); }
        break;
      }
      case 'pong': break;
    }
  }

  async function decryptMsg(msg, room) {
    if (!msg.content) return msg;
    // System messages (e.g. key rotation notices) ship as plaintext JSON —
    // never attempt to AES-decrypt them.
    if (msg.system_kind) {
      return { ...msg, _decrypted: false, _system: true };
    }
    // Version-aware key selection. For private rooms the message carries
    // `key_version` (0 = legacy no-AAD wire format). Public rooms still
    // use the single in-memory roomKeys entry.
    const ver = parseInt(msg.key_version, 10) || 0;
    let key = null;
    let aad = null;
    if (ver > 0 && window.Rooms && typeof Rooms.getRoomKeyForVersion === 'function') {
      try { key = await Rooms.getRoomKeyForVersion(room, ver); } catch { key = null; }
      try {
        const r = (State.rooms || []).find(x => x.name === room);
        if (r && r.id) aad = Rooms.aadForRoom(r.id, ver);
      } catch {}
    }
    if (!key) key = State.roomKeys[room];
    if (!key) return msg;
    const plain = await Crypto.decrypt(msg.content, key, aad || undefined);
    const out = { ...msg, content: plain !== null ? plain : msg.content, _decrypted: plain !== null };
    // Also decrypt the quoted parent content so replies show plaintext, not ciphertext.
    if (msg.reply_content) {
      try {
        const rp = await Crypto.decrypt(msg.reply_content, key, aad || undefined);
        if (rp !== null) out.reply_content = rp;
      } catch {}
    }
    return out;
  }

  function reconnectNow() {
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    _reconnectDelay = 1000;
    if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) {
      return;
    }
    if (_room) connect(_room);
  }

  return { connect, disconnect, send, reconnectNow, isOpen, resetHistoryCache };
})();

// ─── Per-room mute UI helper ──────────────────────────────────────────────
// Painted by ws.js on room_muted/room_unmuted events and by rooms.js when
// switching channels. Disables the composer and shows a bar above it
// explaining why. window-scoped so handlers in either file can reach it
// without a circular import.
window._applyRoomMuteUI = function _applyRoomMuteUI(room) {
  try {
    const mutes = window._roomMutes || {};
    const m = mutes[room];
    const ta = document.getElementById('msg-input');
    const sendBtn = document.getElementById('send-btn');
    const existing = document.getElementById('room-mute-banner');
    if (!m) {
      if (existing) existing.remove();
      if (ta) { ta.disabled = false; ta.placeholder = `Message #${room || 'channel'}`; }
      if (sendBtn) sendBtn.disabled = false;
      return;
    }
    // Resolve a friendly remaining-time label. Server sends ISO-with-Z so
    // new Date() parses correctly across timezones (same fix as kick).
    let when = '';
    if (m.expires_at) {
      try {
        const exp = new Date(m.expires_at);
        const mins = Math.round((exp - new Date()) / 60000);
        if (mins > 0) {
          if (mins < 60) when = ` · ${mins} min remaining`;
          else if (mins < 1440) when = ` · ${Math.round(mins/60)} h remaining`;
          else when = ` · until ${exp.toLocaleString()}`;
        }
      } catch {}
    } else {
      when = ' · permanent';
    }
    const inputArea = document.getElementById('input-area');
    if (inputArea && !existing) {
      const bar = document.createElement('div');
      bar.id = 'room-mute-banner';
      bar.style.cssText = 'background:linear-gradient(180deg,#3a2410,#2a1908);border:1px solid #7c4a14;border-radius:8px;margin:0 8px 6px;padding:8px 12px;color:#fbbf24;font-size:13px;display:flex;align-items:center;gap:8px;';
      inputArea.insertBefore(bar, inputArea.firstChild);
    }
    const bar = document.getElementById('room-mute-banner');
    if (bar) {
      const reason = m.reason ? ` — ${m.reason}` : '';
      bar.innerHTML = `🔇 <span style="flex:1">You're muted in this channel${UI.escHtml(when)}${UI.escHtml(reason)}</span>`;
    }
    if (ta) { ta.disabled = true; ta.placeholder = "You're muted in this channel"; }
    if (sendBtn) sendBtn.disabled = true;
  } catch (e) { console.warn('[mute] apply UI', e); }
};
