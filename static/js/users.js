/**
 * users.js — Online user list panel with search
 */

const Users = (() => {
  let _allUsers = [];          // online users in the current room (from WS)
  let _channelMembers = [];    // full joined-member list for the room (online+offline)
  let _channelRoom = null;     // which room _channelMembers is for
  let _filter = '';
  let _searchInput = null;
  const _displayNameCache = new Map();

  function _sameUser(aUserId, aNickname, bUserId, bNickname) {
    if (aUserId != null && bUserId != null && String(aUserId) === String(bUserId)) return true;
    const aNick = String(aNickname || '').toLowerCase();
    const bNick = String(bNickname || '').toLowerCase();
    return !!(aNick && bNick && aNick === bNick);
  }

  function _mergeLocalSelf(user) {
    if (!user || !State.user) return user;
    const sameUser = _sameUser(user.user_id, user.nickname, State.user.id, State.user.nickname);
    if (!sameUser) return user;
    return {
      ...user,
      user_id: user.user_id || State.user.id,
      nickname: user.nickname || State.user.nickname,
      display_name: State.user.display_name || user.display_name,
      avatar: State.user.avatar || user.avatar,
      is_admin: State.user.is_admin || user.is_admin,
    };
  }

  function _mergeLocalSelfIntoList(users) {
    return (users || []).map(u => _mergeLocalSelf(u));
  }

  async function _hydrateDisplayNames(users) {
    const missing = (users || []).filter(u => u && u.nickname && !u.display_name && (!State.user || !_sameUser(u.user_id, u.nickname, State.user.id, State.user.nickname)));
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
    const deduped = _mergeLocalSelfIntoList(Array.from(seen.values()));
    State.onlineUsers = deduped;
    _allUsers = deduped;
    _renderFiltered();
    _hydrateDisplayNames(_allUsers).then(() => _renderFiltered()).catch(() => {});
  }

  function _renderFiltered() {
    const list = document.getElementById('users-list');
    const count = document.getElementById('online-count');
    if (!list) return;

    const onRoom = _channelRoom && State.currentRoom === _channelRoom;

    // When we have a full room-member snapshot, use that as the source of
    // truth for names/display_names and only merge online presence into it.
    let onlineSource = _allUsers;
    let offlineSource = [];
    if (onRoom && _channelMembers.length) {
      const onlineMap = new Map(
        _allUsers.map(u => [String((u.nickname || '')).toLowerCase(), u])
      );
      onlineSource = [];
      offlineSource = [];
      for (const member of _channelMembers) {
        const key = String((member.nickname || '')).toLowerCase();
        const online = onlineMap.get(key);
        const merged = online ? { ...member, ...online, display_name: member.display_name || online.display_name } : { ...member };
        const liveOnline = (member.live_online === true) || !!online;
        merged.live_online = liveOnline;
        const p = String((merged.presence || member.presence || '')).toLowerCase();
        const forceOffline = p === 'invisible' || p === 'offline';
        if (liveOnline && !forceOffline) onlineSource.push(merged);
        else offlineSource.push({ ...merged, presence: forceOffline ? 'offline' : merged.presence });
      }
      // Include any online users not present in the members snapshot as a fallback.
      for (const user of _allUsers) {
        const key = String((user.nickname || '')).toLowerCase();
        if (!_channelMembers.some(m => String((m.nickname || '')).toLowerCase() === key)) {
          onlineSource.push(user);
        }
      }
    }

    const matches = (u) => {
      if (!_filter) return true;
      const nickname = String(u.nickname || '').toLowerCase();
      const displayName = String(u.display_name || '').toLowerCase();
      return nickname.includes(_filter) || displayName.includes(_filter);
    };
    const onlineShown = onlineSource.filter(matches);
    const offlineShown = offlineSource.filter(matches);

    if (count) count.textContent = (onRoom && _channelMembers.length) ? onlineSource.length : _allUsers.length;

    const prevSearchValue = _filter;
    const hadFocus = _searchInput && document.activeElement === _searchInput;
    const selStart = hadFocus ? _searchInput.selectionStart : null;
    const selEnd = hadFocus ? _searchInput.selectionEnd : null;
    list.innerHTML = '';

    // Search input
    if (!_searchInput) {
      _searchInput = document.createElement('input');
      _searchInput.id = 'member-search';
      _searchInput.className = 'member-search-input';
      _searchInput.placeholder = 'Search by display name or username…';
      _searchInput.oninput = () => {
        _filter = _searchInput.value.trim().replace(/^@+/, '').toLowerCase();
        _renderFiltered();
      };
    }
    if (_searchInput.value !== prevSearchValue) _searchInput.value = prevSearchValue;
    list.appendChild(_searchInput);
    if (hadFocus) {
      _searchInput.focus();
      try { _searchInput.setSelectionRange(selStart, selEnd); } catch {}
    }

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
    // isSelf: prefer user_id match (most reliable), fall back to nickname
    const isSelf = !!(State.user && _sameUser(u.user_id, u.nickname, State.user.id, State.user.nickname));
    const handleNick = isSelf ? (State.user.nickname || u.nickname) : u.nickname;
    const avatarSrc = u.avatar || (isSelf ? State.user.avatar : null);
    const pRaw = String(u.presence || '').toLowerCase();
    const effectivePresence = isOnline
      ? ((pRaw === 'away' || pRaw === 'dnd' || pRaw === 'online') ? pRaw : 'online')
      : ((pRaw === 'away' || pRaw === 'dnd') ? pRaw : 'offline');
    const presenceMeta = {
      online: { color: '#4caf50', label: 'Online' },
      away: { color: '#ffc107', label: 'Away' },
      dnd: { color: '#f44336', label: 'Busy' },
      offline: { color: '#8a8a8a', label: 'Offline' },
    };
    const pm = presenceMeta[effectivePresence] || presenceMeta.online;
    const dotClass = effectivePresence === 'offline' ? 'offline-dot' : 'online-dot';
    const dot = `<span class="${dotClass}" style="background:${pm.color}" title="${pm.label}"></span>`;
    // For self always use authoritative State.user data so stale WS/DB caches can't win
    const displayLabel = isSelf
      ? (State.user.display_name || State.user.nickname || u.nickname)
      : (u.display_name || u.nickname);
    const hasHandle = !!(displayLabel && displayLabel !== handleNick);
    el.innerHTML = `
      <div class="user-avatar">
        ${UI.avatarEl(avatarSrc, handleNick, 32)}
        ${dot}
      </div>
      <div class="user-name-wrap">
        <span class="user-name${isAdmin ? ' admin' : ''}">${isAdmin ? '👑 ' : ''}${UI.escHtml(displayLabel)}${voiceIcon ? ' ' + voiceIcon : ''}</span>
        ${hasHandle ? `<span class="user-handle">@${UI.escHtml(handleNick)}</span>` : ''}
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
      _channelMembers = _mergeLocalSelfIntoList(data.members || []);
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

  function updateDisplayName(userId, nickname, displayName) {
    let changed = false;
    for (const u of _allUsers) {
      if (_sameUser(u.user_id, u.nickname, userId, nickname)) {
        u.display_name = displayName;
        changed = true;
      }
    }
    for (const m of _channelMembers) {
      if (_sameUser(m.user_id, m.nickname, userId, nickname)) {
        m.display_name = displayName;
        changed = true;
      }
    }
    if (changed) _renderFiltered();
  }

  function updatePresence(userId, nickname, presence, statusMsg) {
    let changed = false;
    const p = presence === undefined ? undefined : String(presence || '').toLowerCase();
    const nextPresence = p;
    for (const u of _allUsers) {
      if (_sameUser(u.user_id, u.nickname, userId, nickname)) {
        if (nextPresence !== undefined) u.presence = nextPresence;
        if (statusMsg !== undefined) u.status_msg = statusMsg;
        changed = true;
      }
    }
    for (const m of _channelMembers) {
      if (_sameUser(m.user_id, m.nickname, userId, nickname)) {
        if (nextPresence !== undefined) m.presence = nextPresence;
        if (statusMsg !== undefined) m.status_msg = statusMsg;
        changed = true;
      }
    }
    if (State.onlineUsers) {
      for (const u of State.onlineUsers) {
        if (_sameUser(u.user_id, u.nickname, userId, nickname)) {
          if (nextPresence !== undefined) u.presence = nextPresence;
          if (statusMsg !== undefined) u.status_msg = statusMsg;
        }
      }
    }
    if (changed) _renderFiltered();
  }

  function updateAvatar(userId, nickname, avatar) {
    let changed = false;
    for (const u of _allUsers) {
      if (_sameUser(u.user_id, u.nickname, userId, nickname)) {
        if (avatar !== undefined) u.avatar = avatar;
        changed = true;
      }
    }
    if (State.onlineUsers) {
      for (const u of State.onlineUsers) {
        if (_sameUser(u.user_id, u.nickname, userId, nickname)) {
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

  return { updateList, updateAvatar, updateDisplayName, updatePresence, loadChannelMembers };
})();
