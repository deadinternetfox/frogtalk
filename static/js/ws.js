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

  function connect(room) {
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
      console.log(`[WS] connected to ${room}`);
      // Only reset backoff after connection is stable for 5 seconds
      _stableTimer = setTimeout(() => { _reconnectDelay = 1000; }, 5000);
      if (_pingInterval) clearInterval(_pingInterval);
      _pingInterval = setInterval(() => {
        if (_ws === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'ping'}));
      }, 30000);
      UI.setConnectionStatus && UI.setConnectionStatus('connected');
      if (typeof ConnErr !== 'undefined') ConnErr.onWsOk();
    };

    ws.onmessage = async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      try { await handleServerMsg(data); } catch (err) { console.error('[WS] handleServerMsg error:', err); }
    };

    ws.onclose = () => {
      // Only reconnect if this is still the current WS
      if (_ws !== ws) return;
      if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
      if (_stableTimer) { clearTimeout(_stableTimer); _stableTimer = null; }
      console.log('[WS] disconnected, reconnecting in', _reconnectDelay, 'ms');
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
          break;
        }
        _historyInFlight.set(room, histSig);
        try {
          const cached = (State.messages && State.messages[room]) ? State.messages[room] : [];
          // If server resent the same history window, skip expensive decrypt +
          // full DOM rebuild. Presence still updates below.
          if (cached.length && incoming.length) {
            const sameLen = cached.length === incoming.length;
            const sameFirst = Number(cached[0]?.id || 0) === Number(incoming[0]?.id || 0);
            const sameLast = Number(cached[cached.length - 1]?.id || 0) === Number(incoming[incoming.length - 1]?.id || 0);
            if (sameLen && sameFirst && sameLast) {
              _historyLastApplied.set(room, histSig);
              Users.updateList(data.online || []);
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
        const dm = await decryptMsg(data, room);
        Messages.appendMessage(room, dm);
        const myNick = State.user?.nickname || '';
        const isMention = myNick && (dm.content || '').toLowerCase().includes('@' + myNick.toLowerCase());
        // Skip sounds / desktop notifications for muted users or muted rooms.
        const mutedAuthor = typeof Mute !== 'undefined' && Mute.isUserMuted(dm.nickname);
        const mutedRoom = typeof Mute !== 'undefined' && Mute.isRoomMuted(room);
        if (mutedAuthor || mutedRoom) break;
        if (document.hidden || isMention) Notifications.notify(dm);
        break;
      }
      case 'edit': {
        // Server broadcasts the new content in the SAME ciphertext form it
        // received it (so E2E stays intact). Decrypt before rendering.
        let plain = data.content;
        try {
          const key = State.roomKeys[room];
          if (key && data.content) {
            const p = await Crypto.decrypt(data.content, key);
            if (p !== null) plain = p;
          }
        } catch {}
        // Keep the local cache in sync so re-renders and replies see plaintext.
        try {
          const cache = State.messages?.[room] || [];
          const m = cache.find(x => x.id === data.id);
          if (m) { m.content = plain; m.edited = 1; }
        } catch {}
        Messages.updateEdited(data.id, plain, room);
        break;
      }
      case 'delete': {
        Messages.removeMessage(data.id);
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
      case 'typing': {
        UI.showTyping(data.nickname);
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
      case 'profile_update': {
        // If our own avatar changed on another device, sync local state + self panel
        if (State.user && (
              (data.user_id && data.user_id === State.user.id) ||
              (data.nickname && data.nickname === State.user.nickname)
            )) {
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
        // Refresh inline Suggested-for-you avatars + any social-rendered profile refs.
        try {
          if (typeof Social !== 'undefined' && Social.refreshUserProfile) {
            Social.refreshUserProfile(data.user_id, data.nickname, data.avatar);
          }
        } catch {}
        // Propagate to friends list cache + re-render if panel open
        try {
          if (typeof _allFriends !== 'undefined' && Array.isArray(_allFriends)) {
            let fChanged = false;
            for (const f of _allFriends) {
              if ((data.user_id && f.user_id === data.user_id) ||
                  (data.nickname && f.nickname === data.nickname)) {
                if (data.avatar !== undefined) { f.avatar = data.avatar; fChanged = true; }
              }
            }
            if (fChanged) {
              const fp = document.getElementById('friends-panel');
              if (fp && !fp.classList.contains('hidden') && typeof renderFriendTab === 'function') {
                renderFriendTab();
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
          if (data.nickname) {
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
      // ── Room ban / kick (Discord-style channel close) ────
      case 'room_ban': {
        try { if (typeof handleRoomBan === 'function') handleRoomBan(data); } catch {}
        break;
      }
      case 'user_banned': {
        // A peer was banned; show a small system notice if currently in that room
        try {
          if (data.room && data.room === State.currentRoom && data.nickname) {
            UI.showToast(`@${data.nickname} was banned from #${data.room}`, 'info');
          }
        } catch {}
        break;
      }
      case 'pong': break;
    }
  }

  async function decryptMsg(msg, room) {
    if (!msg.content) return msg;
    const key = State.roomKeys[room];
    if (!key) return msg;
    const plain = await Crypto.decrypt(msg.content, key);
    const out = { ...msg, content: plain !== null ? plain : msg.content, _decrypted: plain !== null };
    // Also decrypt the quoted parent content so replies show plaintext, not ciphertext.
    if (msg.reply_content) {
      try {
        const rp = await Crypto.decrypt(msg.reply_content, key);
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

  return { connect, disconnect, send, reconnectNow };
})();
