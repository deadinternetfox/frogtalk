/**
 * users.js — Online user list panel with search
 */

const Users = (() => {
  let _allUsers = [];          // online users in the current room (from WS)
  let _channelMembers = [];    // full joined-member list for the room (online+offline)
  let _channelRoom = null;     // which room _channelMembers is for
  let _filter = '';
  const _displayNameCache = new Map();

  async function _hydrateDisplayNames(users) {
    const missing = (users || []).filter(u => u && u.nickname && !u.display_name && (!State.user || u.nickname !== State.user.nickname));
    if (!missing.length || !State.token) return;
    await Promise.all(missing.map(async (u) => {
      const nick = String(u.nickname || '').trim();
      if (!nick || _displayNameCache.has(nick)) {
        const cached = _displayNameCache.get(nick);
        if (cached) u.display_name = cached;
        return;
      }
      try {
        const res = await fetch(`/api/users/profile/${encodeURIComponent(nick)}`, {
          headers: { 'X-Session-Token': State.token }
        });
        if (!res.ok) return;
        const data = await res.json();
        const displayName = (data && data.display_name) ? String(data.display_name).trim() : '';
        _displayNameCache.set(nick, displayName || null);
        if (displayName) u.display_name = displayName;
      } catch {}
    }));
  }

  function updateList(users) {
    // Deduplicate by user_id (or nickname if id missing) and always prefer the
    // most-recent avatar we've cached for ourselves. Prevents seeing yourself
    // twice with an old picture while the new one is still propagating.
    const seen = new Map();
    for (const u of (users || [])) {
      const key = u.user_id || u.id || u.nickname;
      if (!key) continue;
      const prev = seen.get(key);
      // Keep the entry with online-dot info; if both are present, later one wins.
      // Preserve display_name from previous entry if the incoming one is null/missing
      // (WS online_nicknames may omit display_name for pre-existing connections).
      if (!prev) {
        seen.set(key, { ...u });
      } else {
        const merged = { ...prev, ...u };
        if (!merged.display_name && prev.display_name) merged.display_name = prev.display_name;
        seen.set(key, merged);
      }
    }
    // For any online user whose display_name is still missing, try to fill it
    // from the already-loaded channelMembers list (which comes from the DB).
    if (_channelMembers.length) {
      for (const [key, u] of seen) {
        if (!u.display_name) {
          const cm = _channelMembers.find(m =>
            (m.user_id && m.user_id === u.user_id) || m.nickname === u.nickname
          );
          if (cm && cm.display_name) u.display_name = cm.display_name;
        }
      }
    }
    // Inject self only if the server didn't include us. Never override a
    // server-provided avatar with the stale local cache — that's what caused
    // "different avatar per device" when the picture was changed elsewhere.
    if (State.user) {
      const selfKey = State.user.id || State.user.nickname;
      if (selfKey && !seen.has(selfKey)) {
        seen.set(selfKey, {
          user_id: State.user.id,
          nickname: State.user.nickname,
          display_name: State.user.display_name,
          avatar: State.user.avatar,
          is_admin: State.user.is_admin,
        });
      } else if (selfKey && seen.has(selfKey)) {
        // Always keep our own display_name up to date from local State
        const self = seen.get(selfKey);
        if (!self.display_name && State.user.display_name) {
          self.display_name = State.user.display_name;
        }
      }
    }
    const deduped = Array.from(seen.values());
    State.onlineUsers = deduped;
    _allUsers = deduped;
    _renderFiltered();
    _hydrateDisplayNames(_allUsers).then(() => _renderFiltered()).catch(() => {});
  }

  function _renderFiltered() {
    const list = document.getElementById('users-list');
    const count = document.getElementById('online-count');
    if (!list) return;

    // Build the display list:
    //   - Online first: every entry from _allUsers (server-confirmed online).
    //   - Offline next: _channelMembers - online intersection (if we have a
    //     member list for the current room). If we don't, we just show online.
    const onlineNicks = new Set(_allUsers.map(u => (u.nickname || '').toLowerCase()));
    const onRoom = _channelRoom && State.currentRoom === _channelRoom;
    const offline = onRoom
      ? _channelMembers.filter(m => !onlineNicks.has((m.nickname || '').toLowerCase()))
      : [];

    const matches = (u) => !_filter || (u.nickname || '').toLowerCase().includes(_filter);
    const onlineShown  = _allUsers.filter(matches);
    const offlineShown = offline.filter(matches);

    if (count) count.textContent = _allUsers.length;

    list.innerHTML = '';

    // Search input
    let search = document.getElementById('member-search');
    if (!search) {
      search = document.createElement('input');
      search.id = 'member-search';
      search.className = 'member-search-input';
      search.placeholder = 'Search by username…';
      search.oninput = () => { _filter = search.value.trim().toLowerCase(); _renderFiltered(); };
    }
    list.appendChild(search);

    if (onlineShown.length) {
      const header = document.createElement('div');
      header.className = 'users-section users-section-online';
      header.textContent = _filter ? `Online matches — ${onlineShown.length}` : `Online — ${onlineShown.length}`;
      list.appendChild(header);
      onlineShown.forEach(u => list.appendChild(_renderUserRow(u, true)));
    }

    if (offlineShown.length) {
      const header = document.createElement('div');
      header.className = 'users-section users-section-offline';
      header.textContent = _filter ? `Offline matches — ${offlineShown.length}` : `Offline — ${offlineShown.length}`;
      list.appendChild(header);
      offlineShown.forEach(u => list.appendChild(_renderUserRow(u, false)));
    }

    if (!onlineShown.length && !offlineShown.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#666;font-size:12px;padding:12px;text-align:center';
      empty.textContent = _filter ? 'No members match' : 'No members yet';
      list.appendChild(empty);
    }
  }

  function _renderUserRow(u, isOnline) {
    const el = document.createElement('div');
    el.className = 'user-item' + (isOnline ? '' : ' offline');
    el.onclick = () => showUserInfo(u.nickname, u.user_id);
    const isAdmin = u.nickname === 'admin' || u.is_admin;
    const inCall = isOnline && typeof getVoiceParticipantNicks === 'function' && getVoiceParticipantNicks().has(u.nickname);
    const isMuted = inCall && typeof getVoiceMutedNicks === 'function' && getVoiceMutedNicks().has(u.nickname);
    const iAmInSameVoice = typeof _voiceRoom !== 'undefined' && _voiceRoom === State.currentRoom;
    const voiceIcon = !inCall ? '' :
      (isMuted ? '<span class="in-call-badge muted" title="Muted in voice">🔇</span>' :
        iAmInSameVoice
          ? '<span class="in-call-badge live" title="Live in voice">🔊</span>'
          : '<span class="in-call-badge" title="In voice channel">📞</span>');
    const isSelf = State.user && u.nickname === State.user.nickname;
    const avatarSrc = u.avatar || (isSelf ? State.user.avatar : null);
    const dot = isOnline ? '<span class="online-dot"></span>' : '<span class="offline-dot"></span>';
    const displayLabel = (isSelf && State.user?.display_name)
      ? State.user.display_name
      : (u.display_name || u.nickname);
    const hasHandle = !!(displayLabel && displayLabel !== u.nickname);
    el.innerHTML = `
      <div class="user-avatar">
        ${UI.avatarEl(avatarSrc, u.nickname, 32)}
        ${dot}
      </div>
      <div class="user-name-wrap">
        <span class="user-name${isAdmin ? ' admin' : ''}">${isAdmin ? '👑 ' : ''}${UI.escHtml(displayLabel)}${voiceIcon ? ' ' + voiceIcon : ''}</span>
        ${hasHandle ? `<span class="user-handle">@${UI.escHtml(u.nickname)}</span>` : ''}
      </div>
    `;
    return el;
  }

  async function loadChannelMembers(roomName) {
    if (!roomName || !State.token) return;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/members`, {
        headers: { 'X-Session-Token': State.token }
      });
      if (!res.ok) return;
      const data = await res.json();
      _channelMembers = data.members || [];
      _channelRoom = roomName;
      // Backfill display_name into any online users that the WS sent without it
      for (const u of _allUsers) {
        if (!u.display_name) {
          const cm = _channelMembers.find(m =>
            (m.user_id && m.user_id === u.user_id) || m.nickname === u.nickname
          );
          if (cm && cm.display_name) u.display_name = cm.display_name;
        }
      }
      _renderFiltered();
      _hydrateDisplayNames(_channelMembers).then(() => _renderFiltered()).catch(() => {});
    } catch {}
  }

  function updateAvatar(userId, nickname, avatar) {
    let changed = false;
    for (const u of _allUsers) {
      if ((userId && u.user_id === userId) || (nickname && u.nickname === nickname)) {
        if (avatar !== undefined) u.avatar = avatar;
        changed = true;
      }
    }
    if (State.onlineUsers) {
      for (const u of State.onlineUsers) {
        if ((userId && u.user_id === userId) || (nickname && u.nickname === nickname)) {
          if (avatar !== undefined) u.avatar = avatar;
        }
      }
    }
    if (changed) _renderFiltered();
    // Also refresh any rendered message avatars for this user in the current room
    try {
      if (typeof document !== 'undefined' && nickname) {
        document.querySelectorAll(`.msg-group[data-nick="${CSS.escape(nickname)}"] .msg-avatar, .msg-group[data-nick="${CSS.escape(nickname)}"] .avatar-img`).forEach(el => {
          if (el.tagName === 'IMG') {
            if (avatar) el.src = avatar;
          } else {
            el.innerHTML = UI.avatarEl(avatar, nickname, 36);
          }
        });
      }
    } catch {}
  }

  return { updateList, updateAvatar, loadChannelMembers };
})();
