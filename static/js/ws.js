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
      // Sender-Key Distribution Message (Track C Phase 3). The server
      // relays an opaque Track-A v2 DM envelope from `from_id`. We
      // decrypt it locally and feed the inner SKDM payload to the
      // room sender-keys store. Failures are swallowed: the worst case
      // is that we silently can't decrypt that sender's next message
      // and the catch-up flow re-fans.
      case 'skdm': {
        try {
          const fromId   = Number(data.from_id) | 0;
          const roomId   = String(data.room_id || '');
          const envStr   = String(data.envelope || '');
          if (!fromId || !roomId || !envStr) break;
          try { console.log('[ws.skdm] received', { fromId, roomId, envLen: envStr.length }); } catch {}
          if (!(window.Signal && typeof window.Signal.decryptDM === 'function')) break;
          let env;
          try { env = JSON.parse(envStr); }
          catch { break; }
          let plain;
          try { plain = await window.Signal.decryptDM(fromId, env); }
          catch (_e) { try { console.warn('[ws.skdm] decryptDM FAIL from', fromId, _e && _e.message); } catch {} break; }
          let inner;
          try { inner = JSON.parse(plain); }
          catch { try { console.warn('[ws.skdm] inner parse FAIL'); } catch {} break; }
          if (!inner || inner.__skdm !== 1 || !inner.p) break;
          if (!(window.Signal?.room?.isAvailable?.())) { try { console.warn('[ws.skdm] Signal.room not available'); } catch {} break; }
          await window.Signal.room.processSKDM(fromId, inner.p);
          try { console.log('[ws.skdm] processSKDM ok from', fromId, 'room', roomId); } catch {}
          // Clear the throttle marker so we'll re-request if needed in
          // the future (e.g. sender rotates their sender-key).
          try {
            if (window._skdmReqThrottle) {
              window._skdmReqThrottle.delete(`${roomId}:${fromId}`);
            }
          } catch {}
          // Track C — a channel message from `fromId` may have already
          // rendered as ciphertext because we hadn't yet received this
          // sender-key state. Now that the chain exists, re-decrypt any
          // ciphertext bubbles from that sender in this room and rewrite
          // the bubble content in-place. Best-effort: failures stay as
          // 🔒 placeholders until the next SKDM arrives.
          try {
            if (typeof Messages !== 'undefined' && Messages.retrySKDecrypt) {
              await Messages.retrySKDecrypt(roomId, fromId);
            }
          } catch {}
        } catch (e) {
          try { console.warn('[ws] skdm processing failed', e); } catch {}
        }
        break;
      }

      // Recovery rekey — another user couldn't decrypt one of our v2-sk
      // messages because they lack our sender-key state. Build a fresh
      // SKDM and send it to them (DM-encrypted under their identity).
      // Throttled per requester to avoid abuse.
      case 'request_skdm': {
        try {
          const fromId = Number(data.from_id) | 0;
          const roomId = String(data.room_id || '');
          if (!fromId || !roomId) break;
          try { console.log('[ws.request_skdm] received from', fromId, 'room', roomId); } catch {}
          if (!(window.Signal && window.Signal.room && window.Signal.room.isAvailable && window.Signal.room.isAvailable())) {
            try { console.warn('[ws.request_skdm] Signal.room not available'); } catch {}
            break;
          }
          // Per-requester throttle: max one fulfil per (room, requester) per 5s.
          window._skdmFulfilThrottle = window._skdmFulfilThrottle || new Map();
          const key = `${roomId}:${fromId}`;
          const last = window._skdmFulfilThrottle.get(key) || 0;
          if (Date.now() - last < 5000) { try { console.log('[ws.request_skdm] throttled'); } catch {} break; }
          window._skdmFulfilThrottle.set(key, Date.now());
          const skdm = await window.Signal.room.buildSKDMForCurrentChain(roomId);
          if (!skdm) { try { console.warn('[ws.request_skdm] buildSKDM returned null'); } catch {} break; }
          try {
            await window.Signal.room.sendSKDMTo(fromId, skdm);
            try { console.log('[ws.request_skdm] fulfilled to', fromId); } catch {}
          } catch (e) {
            try { console.warn('[ws.request_skdm] sendSKDMTo FAIL', e && e.message); } catch {}
          }
        } catch (e) {
          try { console.warn('[ws] request_skdm processing failed', e); } catch {}
        }
        break;
      }
      case 'message': {
        const dm = await decryptMsg(data, room);
        Messages.appendMessage(room, dm);
        const myNick = State.user?.nickname || '';
        // Use a word-boundary mention check so e.g. @frog doesn't also match
        // inside @frogai (substring fired a self-notif when our bot was
        // mentioned and the bot's name shared a prefix with the owner).
        const isMention = !!(myNick && _isMentionOf(dm.content, myNick));
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
        let v2Decrypted = false;
        try {
          // Track C Phase 2 — v2 sender-key envelope edits.
          if (typeof data.content === 'string' && data.content[0] === '{'
              && window.Signal && window.Signal.room
              && (data.user_id || data.user_id === 0)) {
            try {
              const env = JSON.parse(data.content);
              if (env && env.v === 2 && env.t === 'sk') {
                const p2 = await window.Signal.room.decryptMessage(room, data.user_id, env);
                if (typeof p2 === 'string') { plain = p2; v2Decrypted = true; }
              }
            } catch {}
          }
          if (!v2Decrypted) {
            const key = State.roomKeys[room];
            if (key && data.content) {
              const p = await Crypto.decrypt(data.content, key);
              if (p !== null) plain = p;
            }
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
      case 'preview_suppress': {
        try { Messages.applyPreviewSuppress?.(data.id); } catch {}
        break;
      }
      case 'dm_preview_suppress': {
        try { window.applyDMPreviewSuppress?.(data.id); } catch {}
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

        // Track C Phase 3: if WE have a sender-key chain for this room,
        // ship the new member our current SKDM so they can decrypt our
        // next message immediately. Best-effort, fire-and-forget.
        try {
          const newUid = Number(data.user_id) | 0;
          const myUid  = Number(State.user?.id) | 0;
          if (newUid && newUid !== myUid
              && data.room === room
              && window.Signal && window.Signal.room
              && window.Signal.room.isAvailable
              && window.Signal.room.isAvailable()
              && !(State.bridgeOut && State.bridgeOut[data.room])) {
            (async () => {
              try {
                if (!(await window.Signal.room.hasSelfKey(data.room))) return;
                const skdm = await window.Signal.room.buildSKDMForCurrentChain(data.room);
                if (!skdm) return;
                await window.Signal.room.sendSKDMTo(newUid, skdm);
              } catch (e) {
                try { console.warn('[ws] member_joined SKDM fan failed', e); } catch {}
              }
            })();
          }
        } catch {}
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
          if (sameUser(State.user)) {
            if (data.presence !== undefined) State.user.presence = data.presence || 'online';
            if (data.status_msg !== undefined) State.user.status_msg = data.status_msg || '';
            try { State.save(); } catch {}
            try { UI.renderSelfStatus && UI.renderSelfStatus(); } catch {}
          }
          if (typeof Users !== 'undefined' && Users.updatePresence) {
            Users.updatePresence(data.user_id, data.nickname, data.presence, data.status_msg);
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
                if (data.status_msg !== undefined) { f.status_msg = data.status_msg || ''; fChanged = true; }
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

        // Track C Phase 3: a banned member must NOT be able to decrypt
        // future messages even if they retained their device. Rotate
        // our sender key for this room and re-fan to the remaining
        // members. Best-effort; on failure we surface a console warn
        // but keep going (the next room-enter will re-fan anyway).
        try {
          if (data.room
              && window.Signal && window.Signal.room
              && window.Signal.room.isAvailable
              && window.Signal.room.isAvailable()
              && !(State.bridgeOut && State.bridgeOut[data.room])) {
            (async () => {
              try {
                if (!(await window.Signal.room.hasSelfKey(data.room))) return;
                await window.Signal.room.rotateSenderKey(data.room);

                // Also forget the banned user's known chain so we won't
                // accept any future messages signed by their old key.
                const bannedUid = Number(data.user_id) | 0;
                if (bannedUid) {
                  try { await window.Signal.room.forgetSender(data.room, bannedUid); } catch {}
                }

                // Re-fan the new SKDM to everyone else.
                const myUid = Number(State.user?.id) | 0;
                const r = await fetch(
                  `/api/rooms/${encodeURIComponent(data.room)}/members`,
                  { credentials: 'same-origin',
                    headers: State.token
                      ? { 'X-Session-Token': State.token } : {} }
                );
                if (!r.ok) return;
                const j = await r.json().catch(() => ({}));
                const peers = (j.members || [])
                  .map(m => Number(m.user_id) | 0)
                  .filter(uid => uid > 0 && uid !== myUid && uid !== bannedUid);
                if (!peers.length) return;
                const skdm = await window.Signal.room.buildSKDMForCurrentChain(data.room);
                if (!skdm) return;
                for (const uid of peers) {
                  try { await window.Signal.room.sendSKDMTo(uid, skdm); }
                  catch (e) { /* per-peer failures handled by catch-up */ }
                }
              } catch (e) {
                try { console.warn('[ws] user_banned re-fan failed', e); } catch {}
              }
            })();
          }
        } catch {}
        break;
      }
      case 'pong': break;
    }
  }

  async function decryptMsg(msg, room) {
    if (!msg.content) return msg;

    // Track C Phase 2 — v2 Sender-Key envelope path. Wire format is a
    // JSON object {v:2,t:'sk',b:'<base64>'}. We attempt Signal.room and
    // fall through to the legacy AES path on failure (e.g. SKDM hasn't
    // arrived yet, or this device's IndexedDB lacks the sender-key
    // state). On decrypt success we mark _decrypted so callers know the
    // bubble is plaintext.
    const raw = msg.content;
    if (typeof raw === 'string' && raw.length >= 9 && raw[0] === '{') {
      try {
        const env = JSON.parse(raw);
        if (env && env.v === 2 && env.t === 'sk'
            && window.Signal && window.Signal.room
            && (msg.user_id || msg.user_id === 0)) {
          // Plaintext cache: short-circuit when we've already decrypted
          // this envelope (history reload, retransmit) OR when we sent
          // it ourselves (sender chain can't decrypt own ciphertext).
          try {
            if (typeof Messages !== 'undefined' && Messages._ptCacheGet) {
              const _cached = Messages._ptCacheGet(raw);
              if (typeof _cached === 'string') {
                return { ...msg, content: _cached, _decrypted: true, _v2: true };
              }
            }
          } catch {}
          try {
            const plain = await window.Signal.room.decryptMessage(room, msg.user_id, env);
            try { console.log('[ws.decryptMsg] v2-sk', room, 'from', msg.user_id, 'ok=', typeof plain === 'string'); } catch {}
            if (typeof plain === 'string') {
              try {
                if (typeof Messages !== 'undefined' && Messages._ptCachePut) {
                  Messages._ptCachePut(raw, plain);
                }
              } catch {}
              const out = { ...msg, content: plain, _decrypted: true, _v2: true };
              if (msg.reply_content && typeof msg.reply_content === 'string'
                  && msg.reply_content[0] === '{') {
                try {
                  const renv = JSON.parse(msg.reply_content);
                  if (renv && renv.v === 2 && renv.t === 'sk') {
                    // reply ciphertext only decryptable if we still have
                    // chain state for that older iteration — Phase 1 is
                    // in-order only, so we don't currently chase replies
                    // backwards. Best-effort: leave ciphertext stripped.
                    out.reply_content = '';
                  }
                } catch {}
              }
              return out;
            }
          } catch (_e) {
            try { console.warn('[ws.decryptMsg] v2-sk FAIL', room, 'from', msg.user_id, _e && _e.message ? _e.message : _e); } catch {}
            // Recovery: ask the sender to re-fan their SKDM. Throttle per
            // (room, sender) so we send at most one request every 15s
            // even if many ciphertext bubbles arrive in a burst.
            // Skip self — our own messages should decrypt via our own
            // sender chain; if they can't, requesting from ourselves is
            // pointless (server returns 400 self_request anyway).
            try {
              const _myId = Number(State.user && State.user.id) | 0;
              const _peerId = Number(msg.user_id) | 0;
              if (_peerId && _peerId !== _myId) {
                window._skdmReqThrottle = window._skdmReqThrottle || new Map();
                const _k = `${room}:${_peerId}`;
                const _last = window._skdmReqThrottle.get(_k) || 0;
                if (Date.now() - _last >= 15000) {
                  window._skdmReqThrottle.set(_k, Date.now());
                  (async () => {
                    try {
                      const _r = await fetch('/api/signal/skdm-rekey-request', {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: {
                          'Content-Type': 'application/json',
                          ...(State.token ? { 'X-Session-Token': State.token } : {}),
                        },
                        body: JSON.stringify({ room_id: room, sender_uid: _peerId }),
                      });
                      try { console.log('[ws.decryptMsg] rekey request status', _r.status, 'for', _k); } catch {}
                    } catch (_re) {
                      try { console.warn('[ws.decryptMsg] rekey request FAIL', _re && _re.message); } catch {}
                    }
                  })();
                }
              }
            } catch {}
            // Fall through to legacy.
          }
        }
      } catch {
        // Not v2 — fall through.
      }
    }

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

  return { connect, disconnect, send, reconnectNow, isOpen };
})();
