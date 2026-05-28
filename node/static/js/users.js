/**
 * users.js — Online user list panel with search
 */

const Users = (() => {
  let _allUsers = [];          // online users in the current room (from WS)
  let _channelMembers = [];    // full joined-member list for the room (online+offline)
  let _channelRoom = null;     // which room _channelMembers is for
  let _channelBots = [];       // bots installed in the current channel
  let _filter = '';
  let _searchInput = null;
  const _displayNameCache = new Map();

  function _sameUser(aUserId, aNickname, bUserId, bNickname) {
    if (aUserId != null && bUserId != null && String(aUserId) === String(bUserId)) return true;
    const aNick = String(aNickname || '').toLowerCase();
    const bNick = String(bNickname || '').toLowerCase();
    return !!(aNick && bNick && aNick === bNick);
  }

  function _selfMemberPresence(user) {
    const fromState = String(State.user?.presence || '').toLowerCase();
    const fromRow = String(user?.presence || '').toLowerCase();
    if (fromState === 'invisible') return 'invisible';
    if (fromState === 'away' || fromState === 'dnd') return fromState;
    if (user?.live_online === true) {
      if (fromRow === 'away' || fromRow === 'dnd') return fromRow;
      return 'online';
    }
    if (fromState === 'online' || fromState === 'away' || fromState === 'dnd') return fromState;
    if (fromRow === 'online' || fromRow === 'away' || fromRow === 'dnd') return fromRow;
    return 'online';
  }

  function _mergeLocalSelf(user) {
    if (!user || !State.user) return user;
    const sameUser = _sameUser(user.user_id, user.nickname, State.user.id, State.user.nickname);
    if (!sameUser) return user;
    const presence = _selfMemberPresence(user);
    return {
      ...user,
      user_id: user.user_id || State.user.id,
      nickname: user.nickname || State.user.nickname,
      display_name: State.user.display_name || user.display_name,
      avatar: State.user.avatar || user.avatar,
      is_admin: State.user.is_admin || user.is_admin,
      live_online: presence !== 'invisible' && presence !== 'offline'
        && (user.live_online === true || presence === 'online' || presence === 'away' || presence === 'dnd'),
      presence,
      status_msg: (State.user.status_msg ?? user.status_msg ?? ''),
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

  let _membersLoading = false;
  let _membersBootPending = false;
  let _membersLoadInflight = null;
  let _membersLoadRoom = null;
  let _membersRetryTimer = 0;
  let _membersRetryAttempts = 0;
  let _membersRetryRoom = null;
  const _membersRoomCache = new Map();

  // Self-heal a failed/stalled member-snapshot fetch. Without this, a
  // single timed-out or non-OK /members request leaves the panel on the
  // skeleton forever (_membersPanelShouldSkeleton stays true with no
  // members + no cache and nothing else re-fetches the snapshot — only a
  // manual channel switch recovers). Retry on a bounded backoff while the
  // user is still sitting on the room.
  function _scheduleMembersRetry(room) {
    if (!_roomNamesMatch(_membersRetryRoom, room)) {
      _membersRetryRoom = room;
      _membersRetryAttempts = 0;
    }
    if (_membersRetryTimer) return;          // one pending retry at a time
    if (_membersRetryAttempts >= 6) return;  // give up after ~45s of tries
    const delay = Math.min(2000 * Math.pow(1.7, _membersRetryAttempts), 15000);
    _membersRetryAttempts++;
    _membersRetryTimer = setTimeout(() => {
      _membersRetryTimer = 0;
      if (_roomNamesMatch(State.currentRoom, room) && State.currentRoomType !== 'dm') {
        try { loadChannelMembers(room); } catch {}
      }
    }, delay);
  }
  function _clearMembersRetry() {
    _membersRetryAttempts = 0;
    _membersRetryRoom = null;
    if (_membersRetryTimer) { clearTimeout(_membersRetryTimer); _membersRetryTimer = 0; }
  }
  const _MEMBERS_CACHE_MAX = 40;

  function _membersCacheKey(room) {
    return String(room || '').trim().toLowerCase();
  }

  function _roomNamesMatch(a, b) {
    if (!a || !b) return false;
    return _membersCacheKey(a) === _membersCacheKey(b);
  }

  function _getCachedMembers(room) {
    const entry = _membersRoomCache.get(_membersCacheKey(room));
    if (!entry || !Array.isArray(entry.members) || !entry.members.length) return null;
    return entry;
  }

  function _putCachedMembers(room, members, bots) {
    const key = _membersCacheKey(room);
    if (!key) return;
    _membersRoomCache.set(key, {
      members: (members || []).map((m) => ({ ...m })),
      bots: (bots || []).map((b) => ({ ...b })),
      ts: Date.now(),
    });
    while (_membersRoomCache.size > _MEMBERS_CACHE_MAX) {
      const oldest = _membersRoomCache.keys().next().value;
      if (!oldest) break;
      _membersRoomCache.delete(oldest);
    }
  }

  function _memberListSignature(members, bots) {
    const mids = (members || []).map((m) => `${m.user_id || ''}\t${m.nickname || ''}`).sort().join('\n');
    const bnames = (bots || []).map((b) => b.name || '').sort().join('\n');
    return `${(members || []).length}:${mids}::${(bots || []).length}:${bnames}`;
  }

  function hasMembersCache(room) {
    return !!_getCachedMembers(room);
  }

  function _applyCachedMembers(room) {
    const entry = _getCachedMembers(room);
    if (!entry) return false;
    _channelRoom = String(room);
    _channelMembers = _mergeLocalSelfIntoList(entry.members.map((m) => ({ ...m })));
    _channelBots = (entry.bots || []).map((b) => ({ ...b }));
    return true;
  }

  function _membersPanelShouldSkeleton() {
    if (State.currentRoomType === 'dm') return false;
    if (_membersBootPending) return true;
    if (_membersLoading && !_channelMembers.length) return true;
    const cur = (State.currentRoom && State.currentRoomType !== 'dm')
      ? String(State.currentRoom)
      : '';
    return !!(
      cur
      && _roomNamesMatch(_channelRoom, cur)
      && !_channelMembers.length
      && !_getCachedMembers(cur)
    );
  }

  function _paintMembersSkeleton(list, opts = {}) {
    if (!list) return;
    const o = opts && typeof opts === 'object' ? opts : {};
    const existing = list.querySelector('.users-skeleton');
    if (existing) {
      if (o.instant) existing.classList.add('ft-skel-instant');
      return;
    }
    const rows = [68, 82, 58, 74, 64].map((w, i) =>
      `<div class="ft-skel-user-row" style="--ft-skel-i:${i}">`
      + '<span class="ft-skel-avatar sm" aria-hidden="true"></span>'
      + `<span class="ft-skel-line" style="width:${w}%"></span></div>`,
    ).join('');
    const instantCls = o.instant ? ' ft-skel-instant' : '';
    list.innerHTML =
      `<div class="users-skeleton${instantCls}" role="status" aria-live="polite" aria-busy="true">${rows}</div>`;
  }

  function resetMembersListLoad() {
    _membersLoading = false;
    _membersBootPending = false;
    _membersLoadInflight = null;
    _membersLoadRoom = null;
    _clearMembersRetry();
  }

  /** Paint members skeleton at login boot (before rooms list / last-room are known). */
  function prepareMembersPanelBoot() {
    if (!State.token) return;
    const panel = document.getElementById('users-panel');
    if (panel) panel.classList.remove('hidden');
    const list = document.getElementById('users-list');
    if (!list) return;
    _membersBootPending = true;
    _membersLoading = true;
    _paintMembersSkeleton(list);
    const count = document.getElementById('online-count');
    if (count) count.textContent = '…';
  }

  /** Sync paint before fetch — keeps members panel from sitting blank during switch/boot. */
  function prepareMembersListLoad(roomName, opts = {}) {
    if (!roomName || !State.token) return;
    const room = String(roomName);
    const o = opts && typeof opts === 'object' ? opts : {};
    const panel = document.getElementById('users-panel');
    if (panel) panel.classList.remove('hidden');
    const list = document.getElementById('users-list');
    if (!list) return;
    const roomChanged = _channelRoom !== room;
    _channelRoom = room;
    _membersLoadRoom = room;
    _membersBootPending = false;

    const fromCache = o.forceRefresh !== true && _applyCachedMembers(room);
    if (fromCache) {
      _membersLoading = false;
      list.classList.remove('users-list-refreshing');
      _renderFiltered();
      return;
    }

    _membersLoading = true;
    if (roomChanged) {
      _channelMembers = [];
      _channelBots = [];
    }
    list.classList.remove('users-list-refreshing');
    const instant = !!(o.instant || list.querySelector('.users-skeleton'));
    _paintMembersSkeleton(list, { instant });
    const count = document.getElementById('online-count');
    if (count) count.textContent = '…';
  }

  function _renderFiltered() {
    const list = document.getElementById('users-list');
    const count = document.getElementById('online-count');
    if (!list) return;

    const curRoom = (State.currentRoom && State.currentRoomType !== 'dm')
      ? String(State.currentRoom)
      : '';
    const roomAhead = !!(curRoom && _channelRoom && !_roomNamesMatch(_channelRoom, curRoom));
    const onRoom = !!(
      _channelRoom
      && _channelMembers.length
      && (_roomNamesMatch(_channelRoom, curRoom) || _roomNamesMatch(_channelRoom, _membersLoadRoom))
    );

    if (roomAhead) {
      if (_applyCachedMembers(_channelRoom)) {
        _membersLoading = false;
        list.classList.add('users-list-refreshing');
      } else {
        _paintMembersSkeleton(list, { instant: true });
        if (count) count.textContent = '…';
        return;
      }
    } else if (curRoom && !_channelMembers.length && _applyCachedMembers(curRoom)) {
      _channelRoom = curRoom;
      _membersLoading = false;
      list.classList.remove('users-list-refreshing');
    }

    if (_membersPanelShouldSkeleton()) {
      _paintMembersSkeleton(list, { instant: true });
      if (count) count.textContent = '…';
      return;
    }

    // When we have a full room-member snapshot, use that as the source of
    // truth for names/display_names and only merge online presence into it.
    let onlineSource = _allUsers;
    let offlineSource = [];
    let remoteSource = [];
    if (onRoom && _channelMembers.length) {
      const onlineMap = new Map(
        _allUsers.map(u => [String((u.nickname || '')).toLowerCase(), u])
      );
      onlineSource = [];
      offlineSource = [];
      for (const member of _channelMembers) {
        const isSelfRow = !!(State.user && _sameUser(
          member.user_id, member.nickname, State.user.id, State.user.nickname,
        ));
        // Federated members: use server-provided live_online / presence.
        if (member.remote === true && !isSelfRow) {
          const p = String((member.presence || '')).toLowerCase();
          const forceOffline = p === 'invisible' || p === 'offline';
          const liveOnline = member.live_online === true
            || (!forceOffline && (p === 'online' || p === 'away' || p === 'dnd'));
          const merged = { ...member, live_online: liveOnline };
          if (liveOnline && !forceOffline) onlineSource.push(merged);
          else remoteSource.push({ ...merged, presence: forceOffline ? 'offline' : merged.presence });
          continue;
        }
        const key = String((member.nickname || '')).toLowerCase();
        const online = onlineMap.get(key);
        const merged = online ? { ...member, ...online, display_name: member.display_name || online.display_name } : { ...member };
        let liveOnline = (member.live_online === true) || !!online;
        if (isSelfRow) {
          const sp = _selfMemberPresence(merged);
          merged.presence = sp;
          liveOnline = sp !== 'invisible' && sp !== 'offline';
          merged.live_online = liveOnline;
        } else {
          merged.live_online = liveOnline;
        }
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
    const remoteShown = remoteSource.filter(matches);

    // Publish effective presence exactly as the members list computes it,
    // so other UI (mentions, etc.) can stay in perfect sync.
    const presenceByNick = {};
    for (const u of onlineSource) {
      const nick = String((u && u.nickname) || '').toLowerCase();
      if (!nick) continue;
      presenceByNick[nick] = _effectivePresence(u, true);
    }
    for (const u of offlineSource) {
      const nick = String((u && u.nickname) || '').toLowerCase();
      if (!nick) continue;
      if (!presenceByNick[nick]) presenceByNick[nick] = 'offline';
    }
    State.presenceByNick = presenceByNick;

    if (count) count.textContent = (onRoom && _channelMembers.length)
      ? (onlineSource.length + offlineSource.length + remoteSource.length)
      : _allUsers.length;

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

    if (remoteShown.length) {
      const header = document.createElement('div');
      header.className = 'users-section users-section-offline';
      header.title = 'Federated members from other nodes';
      header.textContent = _filter ? `Federated matches — ${remoteShown.length}` : `Federated — ${remoteShown.length}`;
      list.appendChild(header);
      remoteShown.forEach(u => list.appendChild(_renderUserRow(u, false)));
    }

    // Bots section — installed-in-channel bots sit at the bottom under
    // their own header so users can see what's mentionable. Filtered by
    // the same search box as users (matches bot name or description).
    const botsToShow = onRoom
      ? _channelBots.filter(b => {
          if (!_filter) return true;
          const name = String(b.name || '').toLowerCase();
          const desc = String(b.description || '').toLowerCase();
          return name.includes(_filter) || desc.includes(_filter);
        })
      : [];
    if (botsToShow.length) {
      const header = document.createElement('div');
      header.className = 'users-section users-section-bots';
      header.textContent = _filter ? `Bot matches — ${botsToShow.length}` : `Bots — ${botsToShow.length}`;
      list.appendChild(header);
      botsToShow.forEach(b => list.appendChild(_renderBotRow(b)));
    }

    if (!onlineShown.length && !offlineShown.length && !remoteShown.length && !botsToShow.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#666;font-size:12px;padding:12px;text-align:center';
      const syncing = !!(window.FtSync && window.FtSync.state && window.FtSync.state().in_progress);
      empty.textContent = _filter ? 'No members match'
        : syncing ? 'Members loading from your home node…'
        : 'No members yet';
      list.appendChild(empty);
    }

    if (_roomNamesMatch(_channelRoom, curRoom)) {
      list.classList.remove('users-list-refreshing');
    }
  }

  function _effectivePresence(u, isOnline) {
    if (!isOnline) return 'offline';
    const pRaw = String((u && u.presence) || '').toLowerCase();
    if (pRaw === 'busy') return 'dnd';
    if (pRaw === 'idle') return 'away';
    if (pRaw === 'away' || pRaw === 'dnd' || pRaw === 'online') return pRaw;
    return 'online';
  }

  function _renderUserRow(u, isOnline) {
    const el = document.createElement('div');
    el.className = 'user-item' + (isOnline ? '' : ' offline') + (u.remote ? ' remote' : '');
    el.onclick = () => {
      if ((u.remote || !u.user_id) && typeof App !== 'undefined' && App.openFederatedProfileCard) {
        void App.openFederatedProfileCard({
          global_user_id: u.global_user_id || '',
          nickname: u.nickname,
          home_server_id: u.home_server_id || '',
        });
        return;
      }
      showUserInfo(u.nickname, u.user_id);
    };
    const isAdmin = u.nickname === 'admin' || u.is_admin;
    const inCall = isOnline && typeof getVoiceParticipantNicks === 'function' && getVoiceParticipantNicks().has(u.nickname);
    const isMuted = inCall && typeof getVoiceMutedNicks === 'function' && getVoiceMutedNicks().has(u.nickname);
    const iAmInSameVoice = typeof _voiceRoom !== 'undefined' && _voiceRoom === State.currentRoom;
    const voiceIcon = !inCall ? '' :
      (isMuted ? '<span class="in-call-badge muted" title="Muted in voice">🔇</span>' :
        iAmInSameVoice
          ? '<span class="in-call-badge live" title="Live in voice">🔊</span>'
          : '<span class="in-call-badge" title="In voice channel">📞</span>');
    const remoteBadge = u.remote
      ? `<span class="user-remote-badge" title="On ${UI.escHtml(String(u.home_server_id || '').slice(0, 12) || 'another node')}" style="font-size:10px;color:#7fd6a2;background:rgba(127,214,162,.08);border:1px solid rgba(127,214,162,.22);padding:0 4px;border-radius:4px;margin-left:4px">🌐</span>`
      : '';
    // isSelf: prefer user_id match (most reliable), fall back to nickname
    const isSelf = !!(State.user && _sameUser(u.user_id, u.nickname, State.user.id, State.user.nickname));
    const handleNick = isSelf ? (State.user.nickname || u.nickname) : u.nickname;
    const avatarSrc = u.avatar || (isSelf ? State.user.avatar : null);
    // For self, always trust State.user.presence so the row matches the
    // status pill in the self-panel (the WS-cached u.presence may be stale).
    const effectivePresence = isSelf
      ? _effectivePresence({ presence: _selfMemberPresence(u) }, true)
      : _effectivePresence(u, isOnline);
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
    const statusSub = (u.remote && String(u.status_msg || '').trim())
      ? `<span class="user-status-sub" style="display:block;font-size:11px;color:#6f9a7d;margin-top:2px;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${UI.escHtml(u.status_msg)}">${UI.escHtml(u.status_msg)}</span>`
      : '';
    el.innerHTML = `
      <div class="user-avatar">
        ${UI.avatarEl(avatarSrc, handleNick, 32)}
        ${dot}
      </div>
      <div class="user-name-wrap">
        <span class="user-name${isAdmin ? ' admin' : ''}">${isAdmin ? '👑 ' : ''}${UI.escHtml(displayLabel)}${voiceIcon ? ' ' + voiceIcon : ''}${remoteBadge}</span>
        ${hasHandle ? `<span class="user-handle">@${UI.escHtml(handleNick)}</span>` : ''}
        ${statusSub}
      </div>
    `;
    return el;
  }


  function _renderBotRow(bot) {
    // Compact row mirroring _renderUserRow's layout but flagged with a
    // BOT pill and a fixed bot-cyan dot. Clicking inserts an @-mention
    // at the end of the composer so users can address the bot without
    // typing the handle manually.
    const el = document.createElement('div');
    el.className = 'user-item bot-item';
    el.title = bot.description || `Bot: ${bot.name}`;
    el.onclick = () => {
      try {
        const input = document.getElementById('message-input');
        if (input) {
          const insert = `@${bot.name} `;
          input.value = (input.value || '').replace(/\s+$/, '');
          input.value = (input.value ? input.value + ' ' : '') + insert;
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
          if (typeof handleMentionInput === 'function') handleMentionInput(input);
        }
      } catch {}
    };
    el.innerHTML = `
      <div class="user-avatar">
        ${UI.avatarEl(bot.avatar, bot.name, 32)}
        <span class="online-dot" style="background:#6fbf7e;box-shadow:0 0 4px rgba(76,175,80,.45)" title="Bot — online"></span>
      </div>
      <div class="user-name-wrap">
        <span class="user-name">${UI.escHtml(bot.name)} <span class="bot-pill" title="Automated bot account">BOT</span></span>
        ${bot.description ? `<span class="user-handle">${UI.escHtml(String(bot.description).slice(0, 60))}</span>` : `<span class="user-handle">@${UI.escHtml(bot.name)}</span>`}
      </div>
    `;
    return el;
  }


  async function loadChannelMembers(roomName) {
    if (!roomName || !State.token) return;
    const room = String(roomName);
    const list = document.getElementById('users-list');
    const hadCache = hasMembersCache(room);
    if (hadCache) {
      _applyCachedMembers(room);
      _channelRoom = room;
      _membersLoadRoom = room;
      _membersLoading = false;
      _membersBootPending = false;
      if (list) list.classList.add('users-list-refreshing');
      _renderFiltered();
    } else {
      prepareMembersListLoad(room);
    }
    if (_membersLoadInflight && _roomNamesMatch(_membersLoadRoom, room)) return _membersLoadInflight;
    let _loadOk = false;
    _membersLoadInflight = (async () => {
      // Bound the request: /members has no native timeout, so on a flaky
      // mobile/Tor link a stalled fetch would never settle — leaving
      // _membersLoading true, the skeleton spinning, and _membersLoadInflight
      // wedged so no later call ever retries.
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const to = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, 12000) : 0;
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(room)}/members`, {
          headers: { 'X-Session-Token': State.token },
          signal: ctrl ? ctrl.signal : undefined,
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!_roomNamesMatch(_channelRoom, room) || !_roomNamesMatch(State.currentRoom, room)) return;
        const prevSig = _memberListSignature(_channelMembers, _channelBots);
        const nextMembers = _mergeLocalSelfIntoList(data.members || []);
        const nextBots = Array.isArray(data.bots) ? data.bots : [];
        const nextSig = _memberListSignature(nextMembers, nextBots);
        _channelMembers = nextMembers;
        _channelBots = nextBots;
        _loadOk = true;
        _putCachedMembers(room, _channelMembers, _channelBots);
        // Backfill display_name into any online users that the WS sent without it
        for (const u of _allUsers) {
          if (!u.display_name) {
            const cm = _channelMembers.find(m =>
              (m.user_id && m.user_id === u.user_id) || m.nickname === u.nickname
            );
            if (cm && cm.display_name) u.display_name = cm.display_name;
          }
        }
        void _hydrateDisplayNames(_channelMembers)
          .then(() => {
            if (_roomNamesMatch(_channelRoom, room) && _roomNamesMatch(State.currentRoom, room)) {
              _renderFiltered();
            }
          })
          .catch(() => {});
        if (prevSig !== nextSig && _roomNamesMatch(_channelRoom, room) && _roomNamesMatch(State.currentRoom, room)) {
          _renderFiltered();
        }
      } catch {} finally {
        clearTimeout(to);
        if (_roomNamesMatch(_channelRoom, room)) {
          _membersLoading = false;
          _membersBootPending = false;
          if (list) list.classList.remove('users-list-refreshing');
          _renderFiltered();
        }
      }
    })();
    try {
      await _membersLoadInflight;
    } finally {
      if (_roomNamesMatch(_membersLoadRoom, room)) {
        _membersLoadInflight = null;
        _membersLoadRoom = null;
      }
    }
    // The snapshot didn't load (timeout / transient non-OK) and we're still
    // on this room with nothing cached — retry on a backoff so the skeleton
    // self-heals instead of hanging until a manual channel switch.
    if (!_loadOk
        && _roomNamesMatch(State.currentRoom, room)
        && State.currentRoomType !== 'dm'
        && !hasMembersCache(room)) {
      _scheduleMembersRetry(room);
    } else if (_loadOk) {
      _clearMembersRetry();
    }
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

  function updatePresence(userId, nickname, presence, statusMsg, globalUserId, opts) {
    let changed = false;
    const roomScoped = !!(opts && opts.roomScoped);
    const p = presence === undefined ? undefined : String(presence || '').toLowerCase();
    const nextPresence = p;
    const gid = globalUserId ? String(globalUserId).trim() : '';
    const matches = (u) => {
      if (_sameUser(u.user_id, u.nickname, userId, nickname)) return true;
      return !!(gid && String(u.global_user_id || '').trim() === gid);
    };
    const isLive = nextPresence === 'online' || nextPresence === 'away' || nextPresence === 'dnd';
    if (nextPresence === 'offline' || nextPresence === 'invisible') {
      const before = _allUsers.length;
      _allUsers = _allUsers.filter(u => !matches(u));
      if (_allUsers.length !== before) changed = true;
    }
    for (const u of _allUsers) {
      if (matches(u)) {
        if (nextPresence !== undefined) u.presence = nextPresence;
        if (statusMsg !== undefined) u.status_msg = statusMsg;
        changed = true;
      }
    }
    for (const m of _channelMembers) {
      if (matches(m)) {
        if (nextPresence !== undefined) {
          m.presence = nextPresence;
          if (roomScoped) {
            m.live_online = isLive;
          } else if (!isLive) {
            // Global disconnect / invisible — clear live in every channel.
            m.live_online = false;
          }
          // Global profile_update (connect elsewhere): refresh status
          // label only — live_online stays room-scoped via online_users.
        }
        if (statusMsg !== undefined) m.status_msg = statusMsg;
        changed = true;
      }
    }
    if (State.onlineUsers) {
      for (const u of State.onlineUsers) {
        if (matches(u)) {
          if (nextPresence !== undefined) u.presence = nextPresence;
          if (statusMsg !== undefined) u.status_msg = statusMsg;
        }
      }
    }
    if (changed) _renderFiltered();
  }

  function updateAvatar(userId, nickname, avatar) {
    // Some WS profile_update payloads only carry presence/status changes.
    // If avatar is omitted, do not touch rendered avatars.
    if (avatar === undefined) return;
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

  // Live-drop a user from the channel member list + WS presence + State
  // mirror so a ban/kick takes effect in the sidebar without a tab-out/in
  // round trip. Caller (ws.js `user_banned` handler) also asks the
  // @mention autocomplete cache to refresh so the user disappears from
  // the dropdown candidates too.
  function removeMember(userId, nickname) {
    let changed = false;
    const before = _channelMembers.length;
    _channelMembers = _channelMembers.filter(m => !_sameUser(m.user_id, m.nickname, userId, nickname));
    if (_channelMembers.length !== before) changed = true;
    const beforeAll = _allUsers.length;
    _allUsers = _allUsers.filter(u => !_sameUser(u.user_id, u.nickname, userId, nickname));
    if (_allUsers.length !== beforeAll) changed = true;
    try {
      if (Array.isArray(State.onlineUsers)) {
        const beforeOnline = State.onlineUsers.length;
        State.onlineUsers = State.onlineUsers.filter(u => !_sameUser(u.user_id, u.nickname, userId, nickname));
        if (State.onlineUsers.length !== beforeOnline) changed = true;
      }
    } catch {}
    if (changed) {
      if (_channelRoom) _putCachedMembers(_channelRoom, _channelMembers, _channelBots);
      _renderFiltered();
    }
    return changed;
  }

  function getPresenceByNickname(nickname) {
    const nick = String(nickname || '').toLowerCase();
    if (!nick) return 'offline';

    try {
      const fromMap = State?.presenceByNick && State.presenceByNick[nick];
      if (fromMap) return fromMap;
    } catch {}

    const onRoom = _channelRoom && State.currentRoom === _channelRoom;
    if (onRoom && _channelMembers.length && State.user
        && nick === String(State.user.nickname || '').toLowerCase()) {
      const selfMember = _channelMembers.find(m => _sameUser(
        m.user_id, m.nickname, State.user.id, State.user.nickname,
      ));
      if (selfMember) {
        const sp = _selfMemberPresence(selfMember);
        if (sp === 'invisible' || sp === 'offline') return 'offline';
        if (sp === 'away' || sp === 'dnd' || sp === 'online') return sp;
        return 'online';
      }
    }

    if (onRoom && _channelMembers.length) {
      const member = _channelMembers.find(m => String((m?.nickname || '')).toLowerCase() === nick);
      if (member) {
        const online = _allUsers.find(u => String((u?.nickname || '')).toLowerCase() === nick);
        const merged = online ? { ...member, ...online } : { ...member };
        const liveOnline = (member.live_online === true) || !!online;
        const p = String((merged.presence || member.presence || '')).toLowerCase();
        const forceOffline = p === 'invisible' || p === 'offline';
        if (liveOnline && !forceOffline) {
          if (p === 'away' || p === 'dnd' || p === 'online') return p;
          return 'online';
        }
        return 'offline';
      }
    }

    const u = _allUsers.find(x => String((x?.nickname || '')).toLowerCase() === nick);
    if (!u) return 'offline';
    const p = String((u.presence || '')).toLowerCase();
    if (p === 'away' || p === 'dnd' || p === 'online') return p;
    if (p === 'offline' || p === 'invisible') return 'offline';
    return 'online';
  }

  return {
    updateList,
    updateAvatar,
    updateDisplayName,
    updatePresence,
    prepareMembersPanelBoot,
    prepareMembersListLoad,
    resetMembersListLoad,
    loadChannelMembers,
    hasMembersCache,
    getPresenceByNickname,
    removeMember,
  };
})();
try {
  if (typeof window !== 'undefined' && window.Users) {
    window.Users.prepareMembersPanelBoot = Users.prepareMembersPanelBoot;
    window.Users.prepareMembersListLoad = Users.prepareMembersListLoad;
    window.Users.hasMembersCache = Users.hasMembersCache;
  }
} catch {}
