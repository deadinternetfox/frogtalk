/* ─── friends.js ──────────────────────────────────────────────────────────── */
'use strict';

// Render a friend's status_msg with the music-note prefix detected: when
// a friend's status starts with "🎵 " (set automatically by the Now
// Playing feature in ui.js) the line becomes a clickable link to that
// friend's FrogSocial profile, where their latest shared track lives.
function _renderStatusHtml (status_msg, nickname, fallbackLabel) {
  const raw = String(status_msg || '').trim();
  if (!raw) return esc(fallbackLabel || '');
  if (raw.indexOf('🎵') === 0 && nickname) {
    const safeNick = String(nickname).replace(/'/g, "\\'").replace(/"/g, '&quot;');
    // Strip the leading 🎵 and any trailing whitespace. The friends
    // list row is space-constrained (avatar + name + 4 action icons)
    // so we render the COMPACT pill — just "🎵 <track>" with the
    // "Now playing:" label dropped. The full label still appears on
    // the chat mini-profile and FrogSocial profile where there's room.
    const track = raw.replace(/^🎵\s*/, '').trim() || 'a track';
    return `<a href="javascript:void(0)" class="status-music-link status-music-link-compact"
              onclick="event.stopPropagation();window.Social&&Social.openProfileMusic&&Social.openProfileMusic('${esc(safeNick)}')"
              title="Now playing: ${esc(track)} · open @${esc(nickname)}'s music">🎵<span class="sml-track">${esc(track)}</span></a>`;
  }
  return esc(raw);
}

let _currentFriendTab = 'friends';
let _pendingFriends    = [];
let _allFriends        = [];
const _FSM_BUILD = 5;

/* ── Open / close ──────────────────────────────────────────────────────────── */
function openFriends () {
  document.getElementById('friends-panel').classList.remove('hidden');
  loadFriends();
}
function closeFriends () {
  document.getElementById('friends-panel').classList.add('hidden');
}

/* ── Tab switching ─────────────────────────────────────────────────────────── */
function switchFriendTab (tab) {
  _currentFriendTab = tab;
  ['friends','all','pending','add'].forEach(t => {
    document.getElementById('ftab-' + t).classList.toggle('active', t === tab);
  });
  renderFriendTab();
}

/* ── Data loading ──────────────────────────────────────────────────────────── */
async function loadFriends () {
  const content = document.getElementById('friends-content');
  if (content && !content.innerHTML.trim()) content.innerHTML = skelList(4, 40);
  try {
    const r = await apiFetch('/api/friends');
    if (!r.ok) return;
    const d = await r.json();
    _allFriends   = d.friends        || [];
    _pendingFriends = d.requests_in  || [];
    const badge = document.getElementById('pending-badge');
    if (_pendingFriends.length) {
      badge.textContent = ' (' + _pendingFriends.length + ')';
    } else {
      badge.textContent = '';
    }
    renderFriendTab();
  } catch (e) { console.error('loadFriends', e); }
}

/* ── Render current tab ────────────────────────────────────────────────────── */
function renderFriendTab () {
  const el = document.getElementById('friends-content');
  if (_currentFriendTab === 'add') { renderAddFriend(el); return; }
  if (_currentFriendTab === 'pending') { renderPending(el); return; }

  const list = _currentFriendTab === 'friends'
    ? _allFriends.filter(isFriendOnlinePresence)
    : _allFriends;

  if (!list.length) {
    el.innerHTML = `<div style="color:#9ec4b2;text-align:center;padding:32px 0">
      ${_currentFriendTab === 'friends' ? 'No friends online' : 'No friends yet'}<br>
      <small style="font-size:12px;color:#7fa392">Use the Add tab to find people</small>
    </div>`;
    return;
  }

  el.innerHTML = list.map(f => `
    <div class="fade-in" style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #244438">
      <div style="position:relative;flex-shrink:0;width:40px;height:40px;display:flex;align-items:center;justify-content:center">
        ${fmtAv(f.avatar, f.nickname, 40)}
        <span style="position:absolute;bottom:0;right:0;width:10px;height:10px;border-radius:50%;
          background:${presenceColor(f.presence)};border:2px solid #12231d"></span>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px;color:#e3f6ec">${esc(f.nickname)}</div>
        <div style="font-size:12px;color:#9dc4b2">${_renderStatusHtml(f.status_msg, f.nickname, presenceLabel(f.presence))}</div>
      </div>
      <div style="display:flex;gap:4px">
        <button class="icon-btn" onclick="closeFriends();openDMWithNick('${esc(f.nickname)}')" title="Message">💬</button>
        <button class="icon-btn" onclick="closeFriends();callNick('${esc(f.nickname)}','voice')" title="Call">📞</button>
        <button class="icon-btn" onclick="openFriendSoundEditor('${esc(f.nickname)}')" title="Custom sounds">🔔</button>
        <button class="icon-btn" onclick="removeFriend('${esc(f.nickname)}', this)" title="Remove" style="color:#95b9a8">✕</button>
      </div>
    </div>`).join('');
}

function renderPending (el) {
  const incoming = _pendingFriends;
  const outgoing = _allFriends.filter ? [] : []; // we re-fetch outgoing below if needed

  if (!incoming.length) {
    el.innerHTML = `<div style="color:#9ec4b2;text-align:center;padding:32px 0">No pending requests</div>`;
    return;
  }

  el.innerHTML = `<div style="font-size:12px;color:#9dc4b2;font-weight:700;margin-bottom:8px;letter-spacing:.4px">INCOMING</div>` +
    incoming.map(f => `
      <div class="fade-in" style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #244438">
        <div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${fmtAv(f.avatar, f.nickname, 40)}</div>
        <div style="flex:1">
          <div style="font-weight:600;font-size:14px;color:#e3f6ec">${esc(f.nickname)}</div>
          <div style="font-size:12px;color:#9dc4b2">${esc(f.bio||'')}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="modal-btn primary" style="padding:4px 10px;font-size:12px" onclick="acceptFriend('${esc(f.nickname)}', this)">✓ Accept</button>
          <button class="modal-btn secondary" style="padding:4px 10px;font-size:12px" onclick="declineFriend('${esc(f.nickname)}', this)">✕</button>
        </div>
      </div>`).join('');
}

function renderAddFriend (el) {
  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px">
      <input id="friend-search-inp" class="modal-input" style="margin:0;flex:1" placeholder="Search by nickname…"
             oninput="searchFriends()" maxlength="64">
    </div>
    <div id="friend-search-results"></div>`;
}

/* ── Search ────────────────────────────────────────────────────────────────── */
let _fSearchTimer = null;
async function searchFriends () {
  clearTimeout(_fSearchTimer);
  _fSearchTimer = setTimeout(async () => {
    const q = (document.getElementById('friend-search-inp')?.value||'').trim();
    if (q.length < 2) { document.getElementById('friend-search-results').innerHTML=''; return; }
    const r = await apiFetch('/api/users/search?q=' + encodeURIComponent(q));
    if (!r.ok) return;
    const data = await r.json();
    const users = Array.isArray(data) ? data : (data.users || []);
    const el = document.getElementById('friend-search-results');
    if (!el) return;
    if (!users.length) { el.innerHTML='<div style="color:#9ec4b2;text-align:center;padding:16px">No users found</div>'; return; }
    const myNick = STATE.user?.nickname;
    el.innerHTML = users.filter(u => u.nickname !== myNick).map(u => {
      const isFriend = _allFriends.some(f => f.nickname === u.nickname);
      return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #244438">
        <div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${fmtAv(u.avatar, u.nickname, 40)}</div>
        <div style="flex:1">
          <div style="font-weight:600;font-size:14px;color:#e3f6ec">${esc(u.nickname)}</div>
          <div style="font-size:12px;color:#9dc4b2">${esc(u.bio||'')}</div>
        </div>
        ${isFriend
          ? `<span style="font-size:12px;color:#7fd2a7">Friends</span>`
          : `<button class="modal-btn primary" style="padding:4px 12px;font-size:12px"
               onclick="sendFriendReq('${esc(u.nickname)}',this)">+ Add</button>`}
      </div>`;
    }).join('');
  }, 300);
}

/* ── Actions ───────────────────────────────────────────────────────────────── */
async function sendFriendReq (nick, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-ring" style="width:12px;height:12px;border-width:2px"></span>'; }
  const r = await apiFetch('/api/friends/request/' + encodeURIComponent(nick), 'POST');
  if (r.ok) {
    toast('Friend request sent to ' + nick);
    if (btn) { btn.textContent = 'Sent ✓'; btn.style.background = '#1a3a1a'; btn.style.color = '#4caf50'; }
    // Notify recipient in real-time via WebSocket
    wsSend({ type: 'friend_notify', action: 'request', to_nick: nick });
  } else {
    if (btn) { btn.disabled = false; btn.textContent = '+ Add'; }
    const d = await r.json().catch(()=>({}));
    toast(d.detail || d.error || 'Could not send request', 'error');
  }
}

function _animateRemoveRow (btn) {
  const row = btn && btn.closest('div[style*="border-bottom"], .ffp-friend');
  if (!row) return;
  row.classList.add('row-leaving');
  return new Promise(res => setTimeout(res, 260));
}

async function acceptFriend (nick, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-ring" style="width:12px;height:12px;border-width:2px"></span>'; }
  const r = await apiFetch('/api/friends/accept/' + encodeURIComponent(nick), 'POST');
  if (r.ok) {
    toast(nick + ' is now your friend! 🐸', 'success');
    if (btn) await _animateRemoveRow(btn);
    loadFriends();
    try { if (typeof Social !== 'undefined' && Social.refreshProfileRelationship) Social.refreshProfileRelationship(nick); } catch {}
    wsSend({ type: 'friend_notify', action: 'accept', to_nick: nick });
  } else {
    if (btn) { btn.disabled = false; btn.textContent = '✓ Accept'; }
    toast('Could not accept request', 'error');
  }
}

async function declineFriend (nick, btn) {
  if (btn) btn.disabled = true;
  const r = await apiFetch('/api/friends/decline/' + encodeURIComponent(nick), 'POST');
  if (r.ok) {
    if (btn) await _animateRemoveRow(btn);
    loadFriends();
  } else if (btn) { btn.disabled = false; }
}

async function removeFriend (nick, btn) {
  if (!confirm('Remove ' + nick + ' from friends?')) return;
  if (btn) btn.disabled = true;
  const r = await apiFetch('/api/friends/' + encodeURIComponent(nick), 'DELETE');
  if (r.ok) {
    toast('Removed ' + nick);
    if (btn) await _animateRemoveRow(btn);
    loadFriends();
  } else if (btn) { btn.disabled = false; }
}

/* ── Called from user-info modal ────────────────────────────────────────────── */
function friendActionUserInfo () {
  const nick = document.getElementById('userinfo-name').dataset.nick;
  const btn  = document.getElementById('userinfo-friend-btn');
  if (!nick) return;
  const action = btn && btn.dataset.action;
  if (action === 'accept') {
    acceptFriend(nick).then(() => closeModal('modal-user-info'));
  } else if (action === 'remove') {
    // Already friends → unfriend. removeFriend() shows its own confirm
    // dialog and closes the modal so the user lands back on the chat.
    removeFriend(nick, btn).then(() => {
      try { closeModal('modal-user-info'); } catch {}
    });
  } else {
    sendFriendReq(nick, btn);
  }
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */
function presenceColor (p) {
  const m = {online:'#4caf50',away:'#ffc107',dnd:'#f44336',offline:'#888'};
  return m[p] || '#888';
}
function presenceLabel (p) {
  const m = {online:'Online',away:'Away',dnd:'Do Not Disturb',offline:'Offline'};
  return m[p] || 'Offline';
}

function isFriendOnlinePresence(friend) {
  const p = String((friend && friend.presence) || '').toLowerCase();
  return p === 'online';
}

/* ── Receive WS push notification for friend request ───────────────────────── */
function handleFriendNotify (data) {
  if (data.type === 'friend_notify') {
    const msg = data.action === 'request'
      ? `${data.from} sent you a friend request`
      : `${data.from} accepted your friend request`;
    // Click the toast → open the Friends panel on the right tab so the user
    // can immediately accept/decline (request) or view their friend (accept).
    const onClick = () => {
      try {
        if (typeof openFriendsPanel === 'function') openFriendsPanel();
        if (typeof switchFfpTab === 'function' && data.action === 'request') {
          // Defer until panel is in the DOM
          setTimeout(() => { try { switchFfpTab('pending'); } catch {} }, 80);
        }
      } catch {}
    };
    toast('👥 ' + msg, 'info', 6000, onClick);
    loadFriends(); // refresh badge
    updateFrogBadge();
    // Show system notification (browser / Electron / Android)
    _showFriendNotification(data.from, data.action, data.from_avatar);
  }
}

function _showFriendNotification (fromNick, action, avatar) {
  const title = action === 'request' ? '👥 Friend Request' : '👥 Friend Accepted';
  const body  = action === 'request'
    ? `${fromNick} wants to be friends`
    : `${fromNick} accepted your friend request`;
  // Android native bridge
  if (window.Android?.showNotification) {
    try { window.Android.showNotification(title, body); } catch (_) {}
    return;
  }
  // Electron native bridge
  if (window.desktopApp?.showNotification) {
    try { window.desktopApp.showNotification(title, body); } catch (_) {}
    return;
  }
  // Browser Notification API
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, {
        body, icon: '/static/icons/icon-192.png', tag: 'friend-' + fromNick,
        badge: '/static/icons/icon-192.png',
      });
    } catch (_) {}
  }
}

/* ── Frog icon friends panel ───────────────────────────────────────────────── */
let _friendsPanelOpen = false;

function openFriendsPanel() {
  // Toggle the friends panel overlay
  let panel = document.getElementById('frog-friends-panel');
  if (!panel) {
    // Create the panel
    panel = document.createElement('div');
    panel.id = 'frog-friends-panel';
    panel.className = 'frog-friends-panel';
    panel.innerHTML = `
      <div class="ffp-header">
        <span>🐸 Friends & Activity</span>
        <button onclick="closeFriendsPanel()" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer">✕</button>
      </div>
      <div class="ffp-tabs">
        <button class="ffp-tab active" data-tab="online" onclick="switchFfpTab('online')">Online</button>
        <button class="ffp-tab" data-tab="all" onclick="switchFfpTab('all')">All Friends</button>
        <button class="ffp-tab" data-tab="pending" onclick="switchFfpTab('pending')">Pending <span id="ffp-pending-count"></span></button>
      </div>
      <div class="ffp-content" id="ffp-content"></div>
    `;
    document.body.appendChild(panel);
    
    // Add styles
    const style = document.createElement('style');
    style.textContent = `
      .frog-friends-panel {
        position: fixed;
        left: 70px;
        top: 0;
        width: 300px;
        height: 100vh;
        background: linear-gradient(180deg,#132520 0%,#0f1d19 58%,#0c1714 100%);
        border-right: 1px solid #2a4a3f;
        z-index: 500;
        display: none;
        flex-direction: column;
        animation: slideInLeft .2s ease;
        box-shadow: 4px 0 22px rgba(0,0,0,.3);
      }
      .frog-friends-panel.open { display: flex; }
      @keyframes slideInLeft {
        from { transform: translateX(-100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      .ffp-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px;
        font-weight: 600;
        color: #dff3e9;
        border-bottom: 1px solid #2a4a3f;
        background: linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,0));
      }
      .ffp-tabs {
        display: flex;
        padding: 8px;
        gap: 4px;
        border-bottom: 1px solid #29453b;
      }
      .ffp-tab {
        flex: 1;
        background: transparent;
        border: none;
        color: #97b3a8;
        padding: 8px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
      }
      .ffp-tab:hover { background: rgba(30,61,50,.72); color: #e7f5ee; }
      .ffp-tab.active { background: linear-gradient(180deg,#234238,#1b332b); color: #79cf9f; }
      .ffp-content {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
      }
      .ffp-friend {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px;
        border-radius: 8px;
        cursor: pointer;
        transition: background .15s, border-color .15s, transform .1s;
        border: 1px solid transparent;
      }
      .ffp-friend:hover {
        background: linear-gradient(180deg,rgba(27,54,45,.65),rgba(20,40,33,.65));
        border-color: rgba(110,178,147,.25);
        transform: translateY(-1px);
      }
      .ffp-avatar {
        font-size: 1.8rem;
        position: relative;
        flex-shrink: 0;
      }
      .ffp-presence {
        position: absolute;
        bottom: 0;
        right: 0;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        border: 2px solid #12231d;
      }
      .ffp-info { flex: 1; min-width: 0; }
      .ffp-name { font-weight: 600; font-size: 14px; color: #dff3e9; }
      .ffp-status { font-size: 12px; color: #9cb9ae; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ffp-actions { display: flex; gap: 4px; }
      .ffp-empty {
        text-align: center;
        padding: 40px 16px;
        color: #8aa498;
      }
    `;
    document.head.appendChild(style);
  }
  
  _friendsPanelOpen = !_friendsPanelOpen;
  panel.classList.toggle('open', _friendsPanelOpen);
  
  if (_friendsPanelOpen) {
    loadFriends();
    renderFfpContent('online');
  }
}

function closeFriendsPanel() {
  _friendsPanelOpen = false;
  const panel = document.getElementById('frog-friends-panel');
  if (panel) panel.classList.remove('open');
}

function switchFfpTab(tab) {
  document.querySelectorAll('.ffp-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  renderFfpContent(tab);
}

function renderFfpContent(tab) {
  const el = document.getElementById('ffp-content');
  if (!el) return;
  
  // Update pending count
  const countEl = document.getElementById('ffp-pending-count');
  if (countEl) countEl.textContent = _pendingFriends.length ? `(${_pendingFriends.length})` : '';
  
  if (tab === 'pending') {
    if (!_pendingFriends.length) {
      el.innerHTML = '<div class="ffp-empty">No pending friend requests</div>';
      return;
    }
    el.innerHTML = _pendingFriends.map(f => `
      <div class="ffp-friend">
        <div class="ffp-avatar">${fmtAv(f.avatar, f.nickname, 40)}</div>
        <div class="ffp-info">
          <div class="ffp-name">${esc(f.nickname)}</div>
          <div class="ffp-status">Wants to be friends</div>
        </div>
        <div class="ffp-actions">
          <button class="icon-btn" onclick="acceptFriend('${esc(f.nickname)}', this).then(()=>{renderFfpContent('pending')})" title="Accept" style="color:#4caf50">✓</button>
          <button class="icon-btn" onclick="declineFriend('${esc(f.nickname)}', this).then(()=>{renderFfpContent('pending')})" title="Decline" style="color:#f44336">✕</button>
        </div>
      </div>
    `).join('');
    return;
  }
  
  let list;
  if (tab === 'online') {
    list = _allFriends.filter(isFriendOnlinePresence);
  } else {
    list = _allFriends;
  }
  
  if (!list.length) {
    el.innerHTML = `<div class="ffp-empty">${tab === 'online' ? 'No friends online' : 'No friends yet'}</div>`;
    return;
  }
  
  el.innerHTML = list.map(f => `
    <div class="ffp-friend" onclick="closeFriendsPanel();openDMWithNick('${esc(f.nickname)}')">
      <div class="ffp-avatar" style="position:relative">
        ${fmtAv(f.avatar, f.nickname, 40)}
        <span class="ffp-presence" style="background:${presenceColor(f.presence)}"></span>
      </div>
      <div class="ffp-info">
        <div class="ffp-name">${esc(f.nickname)}</div>
        <div class="ffp-status">${_renderStatusHtml(f.status_msg, f.nickname, presenceLabel(f.presence))}</div>
      </div>
      <div class="ffp-actions" onclick="event.stopPropagation()">
        <button class="icon-btn" onclick="closeFriendsPanel();openDMWithNick('${esc(f.nickname)}')" title="Message">💬</button>
        <button class="icon-btn" onclick="closeFriendsPanel();callNick('${esc(f.nickname)}','voice')" title="Call">📞</button>
        <button class="icon-btn" onclick="openFriendSoundEditor('${esc(f.nickname)}')" title="Custom sounds">🔔</button>
      </div>
    </div>
  `).join('');
}

function updateFrogBadge() {
  const count = _pendingFriends.length;
  const setBadge = (id, n) => {
    const badge = document.getElementById(id);
    if (!badge) return;
    if (n > 0) {
      badge.textContent = n > 99 ? '99+' : n;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  };
  // Friend-request pending count goes on the Friends (👥) sidebar icon
  setBadge('friends-sidebar-badge', count);
  // Keep the legacy frog badge as an aggregate unread indicator
  let unreadDMs = 0;
  try {
    if (typeof _dmChannels !== 'undefined' && Array.isArray(_dmChannels)) {
      unreadDMs = _dmChannels.reduce((n, c) => n + (c.unread || 0), 0);
    }
  } catch {}
  setBadge('dm-sidebar-badge', unreadDMs);
  setBadge('frog-badge', count + unreadDMs);
}

// Hook into loadFriends to update badge
const _originalLoadFriends = loadFriends;
loadFriends = async function() {
  await _originalLoadFriends();
  updateFrogBadge();
};

// ── Per-friend custom sounds editor ──────────────────────────────────────
// Opens a modal that lets the user pick a message alert tone and an incoming
// call ringtone for a specific friend. Selections are stored in localStorage
// via Notifications.setFriendSound and take effect immediately.
function openFriendSoundEditor(nick) {
  if (!nick) return;
  try { window.Notifications?.stopCustomSound?.(); } catch {}
  try { window.Notifications?.stopAllPreviewAudio?.(); } catch {}
  let modal = document.getElementById('friend-sound-modal');
  if (modal && modal._fsmBuild !== _FSM_BUILD) {
    try { modal.remove(); } catch {}
    modal = null;
  }
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'friend-sound-modal';
    modal.className = 'fsm-overlay hidden';
    modal.innerHTML = `
      <div id="fsm-box" class="fsm-card">
        <div class="fsm-head">
          <span class="fsm-head-ico">🔔</span>
          <div class="fsm-head-info">
            <div class="fsm-head-title">Custom sounds</div>
            <div id="fsm-peer" class="fsm-head-sub"></div>
          </div>
          <button class="fsm-close" type="button" aria-label="Close" data-fsm-action="close">✕</button>
        </div>
        <div class="fsm-body">
          <div class="fsm-kind-switch" role="tablist" aria-label="Sound type">
            <button class="fsm-kind-tab active" type="button" data-fsm-action="switch-kind" data-kind="msg" aria-selected="true">💬 Message</button>
            <button class="fsm-kind-tab" type="button" data-fsm-action="switch-kind" data-kind="ring" aria-selected="false">📞 Call</button>
          </div>
          <div class="fsm-section fsm-kind-panel" data-kind="msg">
            <div class="fsm-section-head">
              <div class="fsm-section-title"><span>💬</span> Message alert</div>
              <label class="fsm-upload-wrap" title="Upload mp3, wav, ogg, m4a, aac, opus, flac, mp4, or webm">
                <span class="fsm-upload-btn"><span>📁</span> Upload</span>
                <input id="fsm-native-upload-msg" class="fsm-upload-native" type="file" data-kind="msg" accept="audio/*,video/mp4,video/webm,.mp3,.wav,.ogg,.m4a,.aac,.opus,.flac,.mp4,.webm">
              </label>
            </div>
            <div class="fsm-select-row" aria-label="Message tone selector">
              <select id="fsm-msg-select" class="fsm-tone-select" data-kind="msg"></select>
              <button class="fsm-upload-btn" type="button" data-fsm-action="preview-selected" data-kind="msg">▶ Preview</button>
            </div>
            <div id="fsm-msg-current"></div>
            <div id="fsm-msg-pending"></div>
            <div id="fsm-msg-custom"></div>
            <div id="fsm-msg-list" class="fsm-list"></div>
          </div>
          <div class="fsm-section fsm-kind-panel" data-kind="ring" style="display:none">
            <div class="fsm-section-head">
              <div class="fsm-section-title"><span>📞</span> Incoming call ringtone</div>
              <label class="fsm-upload-wrap" title="Upload mp3, wav, ogg, m4a, aac, opus, flac, mp4, or webm">
                <span class="fsm-upload-btn"><span>📁</span> Upload</span>
                <input id="fsm-native-upload-ring" class="fsm-upload-native" type="file" data-kind="ring" accept="audio/*,video/mp4,video/webm,.mp3,.wav,.ogg,.m4a,.aac,.opus,.flac,.mp4,.webm">
              </label>
            </div>
            <div class="fsm-select-row" aria-label="Ringtone selector">
              <select id="fsm-ring-select" class="fsm-tone-select" data-kind="ring"></select>
              <button class="fsm-upload-btn" type="button" data-fsm-action="preview-selected" data-kind="ring">▶ Preview</button>
            </div>
            <div id="fsm-ring-current"></div>
            <div id="fsm-ring-pending"></div>
            <div id="fsm-ring-custom"></div>
            <div id="fsm-ring-list" class="fsm-list"></div>
          </div>
        </div>
        <div class="fsm-actions">
          <button class="fsm-btn" type="button" data-fsm-action="reset">↺ Reset to default</button>
          <button class="fsm-btn primary" type="button" data-fsm-action="close">✓ Done</button>
        </div>
      </div>`;
    _bindFriendSoundModalEvents(modal);
    modal._fsmBuild = _FSM_BUILD;
    _ensureFriendSoundModalGuard(modal);
    document.body.appendChild(modal);
  }
  modal._targetNick = nick;
  modal._activeKind = modal._activeKind || 'msg';
  modal._serverSounds = {};
  modal._selectedByKind = {
    msg: (window.Notifications?.getFriendSound?.(nick, 'msg') || null),
    ring: (window.Notifications?.getFriendSound?.(nick, 'ring') || null),
  };
  const peerEl = modal.querySelector('#fsm-peer');
  if (peerEl) peerEl.textContent = 'for @' + nick;
  _renderFriendSoundList('msg');
  _renderFriendSoundList('ring');
  void _syncServerSounds('msg');
  void _syncServerSounds('ring');
  _setSoundKindView(modal._activeKind || 'msg');
  modal.style.display = 'flex';
  modal.classList.remove('hidden');
}

function _setSoundKindView(kind) {
  const m = document.getElementById('friend-sound-modal');
  if (!m) return;
  const active = (kind === 'ring') ? 'ring' : 'msg';
  m._activeKind = active;
  const panels = Array.from(m.querySelectorAll('.fsm-kind-panel'));
  panels.forEach((panel) => {
    const k = panel.dataset.kind || '';
    panel.style.display = (k === active) ? '' : 'none';
  });
  const tabs = Array.from(m.querySelectorAll('.fsm-kind-tab'));
  tabs.forEach((tab) => {
    const selected = (tab.dataset.kind || '') === active;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

function _ensureFriendSoundModalGuard(modal) {
  if (!modal || modal._fsmHideGuardBound) return;
  modal._fsmHideGuardBound = true;
  const stopAll = () => {
    try { window.Notifications?.stopCustomSound?.(); } catch {}
    try { window.Notifications?.stopAllPreviewAudio?.(); } catch {}
    try { _setCustomPreviewState('', ''); } catch {}
  };
  const checkHidden = () => {
    try {
      if (modal.classList.contains('hidden') || modal.style.display === 'none') stopAll();
    } catch {}
  };
  try {
    const obs = new MutationObserver(checkHidden);
    obs.observe(modal, { attributes: true, attributeFilter: ['class', 'style'] });
    modal._fsmObserver = obs;
  } catch {}
  try {
    const bodyObs = new MutationObserver(() => {
      try {
        if (!document.body.contains(modal)) stopAll();
      } catch {}
    });
    bodyObs.observe(document.body, { childList: true, subtree: true });
    modal._fsmBodyObserver = bodyObs;
  } catch {}
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopAll();
    }, { passive: true });
  } catch {}
  try {
    window.addEventListener('pagehide', stopAll, { passive: true });
  } catch {}
}

function closeFriendSoundEditor() {
  const m = document.getElementById('friend-sound-modal');
  if (!m) return;
  // Block close while an upload is in progress
  const busyKinds = Object.entries(m._uploadBusy || {}).filter(([, v]) => v).map(([k]) => k);
  if (busyKinds.length) {
    if (typeof toast === 'function') toast('Upload in progress — please wait', 'info');
    return;
  }
  // Stop all audio FIRST, before clearing state or hiding
  try { window.Notifications?.stopCustomSound?.(); } catch {}
  try { window.Notifications?.stopAllPreviewAudio?.(); } catch {}
  // Clear state after stopping audio
  try {
    const pending = m._pendingUploads || {};
    for (const k of Object.keys(pending)) {
      if (pending[k]?.url) URL.revokeObjectURL(pending[k].url);
    }
    m._pendingUploads = {};
    m._uploadBusy = {};
    m._uploadProgress = {};
    m._uploadStatus = {};
    m._serverSounds = {};
    m._selectedByKind = {};
    m._customPreviewKind = '';
    m._customPreviewSource = '';
    _renderPendingUpload('msg');
    _renderPendingUpload('ring');
  } catch {}
  // Hide modal after stopping audio and clearing state
  m.style.display = 'none';
  m.classList.add('hidden');
  // Some browsers delay media graph teardown; enforce one extra stop tick.
  setTimeout(() => {
    try { window.Notifications?.stopCustomSound?.(); } catch {}
    try { window.Notifications?.stopAllPreviewAudio?.(); } catch {}
  }, 60);
}

function _setCustomPreviewState(kind, source) {
  const m = document.getElementById('friend-sound-modal');
  if (!m) return;
  const prevKind = m._customPreviewKind || '';
  const prevSource = m._customPreviewSource || '';
  m._customPreviewKind = kind || '';
  m._customPreviewSource = source || '';
  _renderPendingUpload('msg');
  _renderPendingUpload('ring');
  const touchesCustom = (s) => {
    const v = String(s || '');
    return v === 'pending' || v.startsWith('saved');
  };
  // Avoid full list rerenders for non-custom previews, which can make
  // selection styling appear to reset under rapid interactions.
  if (touchesCustom(prevSource) || touchesCustom(m._customPreviewSource)) {
    if (prevKind === 'msg' || prevKind === 'ring') _renderFriendSoundList(prevKind);
    if (m._customPreviewKind && m._customPreviewKind !== prevKind) _renderFriendSoundList(m._customPreviewKind);
    if (!m._customPreviewKind && prevKind && prevKind !== m._customPreviewKind) _renderFriendSoundList(prevKind);
  }
}

function _renderQuickButtons(kind, current) {
  const m = document.getElementById('friend-sound-modal');
  if (!m) return;
  const modalCurrent = Object.prototype.hasOwnProperty.call(m._selectedByKind || {}, kind)
    ? m._selectedByKind[kind]
    : undefined;
  const active = (modalCurrent !== undefined) ? modalCurrent : current;
  const buttons = Array.from(m.querySelectorAll('[data-fsm-action="pick"][data-kind="' + kind + '"]'));
  buttons.forEach((btn) => {
    const key = btn.dataset.key || '';
    const isDefault = key === '';
    const selected = (isDefault && !active) || (!isDefault && key === active);
    btn.classList.toggle('active', selected);
    if (selected) {
      btn.style.boxShadow = '0 0 0 2px rgba(76,175,80,.35)';
      btn.style.borderColor = '#4caf50';
      btn.style.color = '#dff5e8';
    } else {
      btn.style.boxShadow = '';
      btn.style.borderColor = '';
      btn.style.color = '';
    }
  });
}

function _renderToneSelect(kind, current, customMeta, serverState, options) {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (!m || !nick) return;
  const selId = kind === 'msg' ? 'fsm-msg-select' : 'fsm-ring-select';
  const sel = m.querySelector('#' + selId);
  if (!sel) return;

  const hasServerCustom = Array.isArray(serverState?.assets) && serverState.assets.length > 0;
  const hasLocalCustom = !!window.Notifications?.getCustomSound?.(nick, kind);
  const customLabel = customMeta?.name ? ('Custom: ' + customMeta.name) : 'Custom upload';

  const rows = [];
  if (hasServerCustom || hasLocalCustom || current === 'custom') rows.push({ value: 'custom', label: customLabel });

  const seen = new Set(['', 'custom']);
  (options || []).forEach((k) => {
    const key = String(k || '');
    if (!key || seen.has(key)) return;
    if (kind === 'ring' && key === 'default') return;
    seen.add(key);
    rows.push({ value: key, label: _friendSoundLabel(kind, key) });
  });

  sel.innerHTML = rows
    .map((r) => `<option value="${esc(r.value)}">${esc(r.label)}</option>`)
    .join('');
  const value = (current == null) ? '' : String(current);
  const valid = rows.some((r) => r.value === value);
  if (valid) sel.value = value;
  else if (rows.length) sel.value = rows[0].value;
}

function _previewSelectedTone(kind) {
  const m = document.getElementById('friend-sound-modal');
  if (!m) return;
  const selId = kind === 'msg' ? 'fsm-msg-select' : 'fsm-ring-select';
  const sel = m.querySelector('#' + selId);
  const val = String(sel?.value || '');
  if (!val) return _previewDefaultFriendSound(kind);
  if (val === 'custom') {
    const sid = Number(m?._serverSounds?.[kind]?.active?.id || 0) || 0;
    return _previewFriendSound(kind, 'custom', sid || null);
  }
  return _previewFriendSound(kind, val);
}

function _isPreviewing(kind, source) {
  const m = document.getElementById('friend-sound-modal');
  if (!m) return false;
  return m._customPreviewKind === kind && m._customPreviewSource === source;
}

function _canPreviewAudioContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (!ct) return true;
  try {
    const canPlay = window.Notifications?.canPlayCustomContentType;
    if (typeof canPlay === 'function') return !!canPlay(ct);
  } catch {}
  const fallbackPlayable = new Set([
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
    'audio/ogg',
    'audio/webm',
    'audio/mp4',
    'audio/x-m4a',
  ]);
  return fallbackPlayable.has(ct);
}

function _bindFriendSoundModalEvents(modal) {
  if (!modal || modal._fsmEventsBound) return;
  modal._fsmEventsBound = true;
  // Capture phase makes this resilient even if nested controls stop bubbling.
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeFriendSoundEditor();
      return;
    }
    const actionEl = e.target.closest('[data-fsm-action]');
    if (!actionEl || !modal.contains(actionEl)) return;
    const action = actionEl.dataset.fsmAction;
    const kind = actionEl.dataset.kind || '';
    const key = actionEl.dataset.key || '';
    const assetId = Number(actionEl.dataset.assetId || 0) || 0;
    // Keep audio unlocked as part of this trusted user gesture.
    try { window.Notifications?.unlockAudio?.(); } catch {}
    if (action === 'close') return closeFriendSoundEditor();
    if (action === 'switch-kind') return _setSoundKindView(kind);
    if (action === 'reset') return resetFriendSounds();
    if (action === 'pick') return _selectFriendSoundKey(kind, key || null);
    if (action === 'pick-row') return _selectFriendSound(actionEl);
    if (action === 'preview-selected') return _previewSelectedTone(kind);
    if (action === 'preview-current') return _previewCurrentChoice(kind);
    if (action === 'preview-pending') return _previewPendingUpload(kind);
    if (action === 'clear-pending') return _clearPendingUpload(kind);
    if (action === 'preview') {
      e.stopPropagation();
      return _previewFriendSound(kind, key, assetId || null);
    }
    if (action === 'use-custom') return _selectCustomSound(kind, assetId || null);
    if (action === 'delete-custom') return _deleteCustomSound(kind, assetId || null);
  }, true); // capture phase — fires before any child stopPropagation

  modal.addEventListener('change', async (e) => {
    const toneSel = e.target?.closest?.('.fsm-tone-select');
    if (toneSel && modal.contains(toneSel)) {
      const kind = toneSel.dataset.kind || '';
      const value = String(toneSel.value || '');
      _selectFriendSoundKey(kind, value || null);
      return;
    }
    const input = e.target?.closest?.('.fsm-upload-native');
    if (!input || !modal.contains(input)) return;
    const kind = input.dataset.kind || '';
    modal._uploadBusy = modal._uploadBusy || {};
    if (modal._uploadBusy[kind]) {
      input.value = '';
      if (typeof toast === 'function') toast('Upload already in progress', 'info');
      return;
    }
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) {
      if (typeof toast === 'function') toast('No file selected', 'info');
      return;
    }
    const max = Number(window.Notifications?.CUSTOM_SOUND_MAX_BYTES || 0) || (10 * 1024 * 1024);
    if (file.size > max) {
      _setPendingUpload(kind, file);
      modal._uploadStatus = modal._uploadStatus || {};
      modal._uploadStatus[kind] = 'file too large (max ' + Math.round(max / (1024 * 1024)) + ' MB)';
      _renderPendingUpload(kind);
      if (typeof toast === 'function') toast('File too large (max ' + Math.round(max / (1024 * 1024)) + ' MB)', 'error');
      return;
    }
    _setPendingUpload(kind, file);
    if (typeof toast === 'function') toast('Selected ' + (file.name || 'file') + '. Uploading…', 'info');
    await _commitPendingUpload(kind);
  });
}

function resetFriendSounds() {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (!nick || !window.Notifications) return;
  m._selectedByKind = m._selectedByKind || {};
  m._selectedByKind.msg = null;
  m._selectedByKind.ring = null;
  Notifications.setFriendSound(nick, 'msg', null);
  Notifications.setFriendSound(nick, 'ring', null);
  // Also purge any uploaded custom files so Default really means default.
  try {
    Notifications.setCustomSound?.(nick, 'msg', null);
    Notifications.setCustomSound?.(nick, 'ring', null);
    _setCustomSoundMeta(nick, 'msg', null);
    _setCustomSoundMeta(nick, 'ring', null);
  } catch {}
  _renderFriendSoundList('msg');
  _renderFriendSoundList('ring');
  if (typeof toast === 'function') toast('Reset to default sounds', 'success');
}

function _friendSoundLabel(kind, key) {
  const labels = {
    msg: {
      pop: 'Pop', chime: 'Chime', ding: 'Ding', click: 'Click',
      bell: 'Bell', soft: 'Soft', bubble: 'Bubble', zap: 'Zap',
      coin: 'Coin', knock: 'Knock', silent: 'Silent',
      custom: '🎵 Custom upload',
    },
    ring: {
      default: 'Classic two-tone', classic: 'Classic phone', digital: 'Digital',
      melody: 'Melody', marimba: 'Marimba', sonar: 'Sonar', silent: 'Silent',
      custom: '🎵 Custom upload',
    },
  };
  return labels[kind]?.[key] || key;
}

function _renderFriendSoundList(kind) {
  const m = document.getElementById('friend-sound-modal');
  if (!m || !window.Notifications) return;
  const nick = m._targetNick;
  const listId = kind === 'msg' ? 'fsm-msg-list' : 'fsm-ring-list';
  const el = m.querySelector('#' + listId);
  if (!el) return;
  // Defensive: fall back to known catalogue if the exported lists are ever
  // missing (e.g. older cached notifications.js).
  const MSG_FALLBACK  = ['pop','chime','ding','click','bell','soft','bubble','zap','coin','knock','silent'];
  const RING_FALLBACK = ['default','classic','digital','melody','marimba','sonar','silent'];
  let options = kind === 'msg' ? Notifications.MSG_TONES_LIST : Notifications.RING_TONES_LIST;
  if (!Array.isArray(options) || !options.length) {
    options = kind === 'msg' ? MSG_FALLBACK : RING_FALLBACK;
  }
  // Prepend an explicit "Default" entry. Uploaded custom file gets its own
  // highlighted chip above the preset list (see fsm-{kind}-custom container).
  const items = [
    { key: null, isDefault: true },
    ...options.map(k => ({ key: k })),
  ];
  const stored = Notifications.getFriendSound ? Notifications.getFriendSound(nick, kind) : null;
  const current = Object.prototype.hasOwnProperty.call(m._selectedByKind || {}, kind)
    ? m._selectedByKind[kind]
    : stored;
  const customData = (Notifications.getCustomSound && Notifications.getCustomSound(nick, kind)) || null;
  const customMeta = _getCustomSoundMeta(nick, kind);
  const serverState = m._serverSounds?.[kind] || null;
  _renderToneSelect(kind, current, customMeta, serverState, options);
  _renderCurrentChoice(kind, current, customMeta);

  // Render the "uploaded file" chip if present
  const customContainerId = kind === 'msg' ? 'fsm-msg-custom' : 'fsm-ring-custom';
  const customEl = m.querySelector('#' + customContainerId);
  if (customEl) {
    if (Array.isArray(serverState?.assets) && serverState.assets.length) {
      const rows = serverState.assets.map((asset) => {
        const aid = Number(asset?.id || 0) || 0;
        const isActive = !!asset?.is_active;
        const playingSaved = _isPreviewing(kind, 'saved:' + aid);
        const name = asset?.filename || ('Custom ' + aid);
        const sizeKb = asset?.file_size ? Math.round(asset.file_size / 1024) + ' KB' : '';
        return `
          <div class="fsm-custom-chip" style="${isActive ? 'box-shadow:0 0 0 2px rgba(76,175,80,.35)' : ''}">
            <button class="fcc-btn" type="button" title="${playingSaved ? 'Stop preview' : 'Preview'}" data-fsm-action="preview" data-kind="${kind}" data-key="custom" data-asset-id="${aid}">${playingSaved ? '■' : '▶'}</button>
            <div style="flex:1;min-width:0">
              <div class="fcc-name">${esc(name)}</div>
              <div class="fcc-meta">${sizeKb} · ${isActive ? '✓ Active' : 'tap to use'}</div>
            </div>
            ${isActive
              ? '<span style="color:#4caf50;font-size:11px;font-weight:700;padding:0 6px">ACTIVE</span>'
              : `<button class="fcc-btn" type="button" title="Use this" data-fsm-action="use-custom" data-kind="${kind}" data-asset-id="${aid}">✓</button>`}
            <button class="fcc-btn danger" type="button" title="Delete" data-fsm-action="delete-custom" data-kind="${kind}" data-asset-id="${aid}">✕</button>
          </div>`;
      }).join('');
      customEl.innerHTML = rows;
      customEl.style.marginBottom = '8px';
    } else if (customData) {
      const isSelected = current === 'custom';
      const playingSaved = _isPreviewing(kind, 'saved');
      const name = customMeta?.name || 'Custom file';
      const sizeKb = customMeta?.size ? Math.round(customMeta.size / 1024) + ' KB' : '';
      customEl.innerHTML = `
        <div class="fsm-custom-chip" style="${isSelected ? 'box-shadow:0 0 0 2px rgba(76,175,80,.35)' : ''}">
          <button class="fcc-btn" type="button" title="${playingSaved ? 'Stop preview' : 'Preview'}" data-fsm-action="preview" data-kind="${kind}" data-key="custom">${playingSaved ? '■' : '▶'}</button>
          <div style="flex:1;min-width:0">
            <div class="fcc-name">${esc(name)}</div>
            <div class="fcc-meta">${sizeKb} · ${isSelected ? '✓ Active' : 'tap to use'}</div>
          </div>
          ${isSelected
            ? '<span style="color:#4caf50;font-size:11px;font-weight:700;padding:0 6px">ACTIVE</span>'
            : `<button class="fcc-btn" type="button" title="Use this" data-fsm-action="use-custom" data-kind="${kind}">✓</button>`}
          <button class="fcc-btn danger" type="button" title="Delete" data-fsm-action="delete-custom" data-kind="${kind}">✕</button>
        </div>`;
      customEl.style.marginBottom = '8px';
    } else {
      customEl.innerHTML = `<div class="fsm-empty-hint">No custom file uploaded. Tap 📁 Upload above (mp3/wav/ogg/m4a/aac/opus/flac/mp4/webm).</div>`;
      customEl.style.marginBottom = '8px';
    }
  }

  el.innerHTML = items.map(it => {
    const selected = (it.isDefault && !current) || (!it.isDefault && it.key === current);
    const label = it.isDefault ? 'Default (app setting)' : _friendSoundLabel(kind, it.key);
    const key = it.isDefault ? '' : esc(it.key);
    const rightBtn = it.isDefault ? ''
      : `<button class="fsm-play" type="button" title="Preview" data-fsm-action="preview" data-kind="${kind}" data-key="${key}">▶</button>`;
    return `
      <div class="fsm-row ${selected ? 'selected' : ''}" data-fsm-action="pick-row" data-kind="${kind}" data-key="${key}" data-default="${it.isDefault ? '1' : ''}">
        <span class="fsm-dot"></span>
        <span class="fsm-label">${esc(label)}</span>
        ${rightBtn}
      </div>`;
  }).join('');
  // Compact mode uses dropdown selectors; keep list hidden to save vertical space.
  el.style.display = 'none';
}

function _renderCurrentChoice(kind, current, customMeta) {
  const m = document.getElementById('friend-sound-modal');
  if (!m) return;
  const id = kind === 'msg' ? 'fsm-msg-current' : 'fsm-ring-current';
  const el = m.querySelector('#' + id);
  if (!el) return;
  // Current state is represented by the ACTIVE row in the list below.
  // Keep this container empty to avoid duplicate active cards.
  void current;
  void customMeta;
  el.innerHTML = '';
}

function _previewCurrentChoice(kind) {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (!nick || !window.Notifications) return;
  const current = Notifications.getFriendSound(nick, kind);
  if (!current) return _previewDefaultFriendSound(kind);
  if (current === 'custom') {
    const sid = Number(m?._serverSounds?.[kind]?.active?.id || 0) || 0;
    return _previewFriendSound(kind, current, sid || null);
  }
  return _previewFriendSound(kind, current);
}

function _selectFriendSound(row) {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (!nick || !window.Notifications) return;
  const kind = row.dataset.kind;
  const isDefault = row.dataset.default === '1';
  const key = isDefault ? null : row.dataset.key;
  _selectFriendSoundKey(kind, key);
}

function _selectFriendSoundKey(kind, key) {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (!nick || !window.Notifications) return;
  if (key === 'custom') {
    const serverState = m?._serverSounds?.[kind] || null;
    const hasServerAsset = Array.isArray(serverState?.assets) && serverState.assets.length > 0;
    const hasLocalAsset = !!Notifications.getCustomSound?.(nick, kind);
    if (!hasServerAsset && !hasLocalAsset) {
      if (typeof toast === 'function') toast('Upload a custom file first', 'info');
      try {
        const picker = m.querySelector('#fsm-native-upload-' + kind);
        if (picker) picker.click();
      } catch {}
      return;
    }
  }
  m._selectedByKind = m._selectedByKind || {};
  m._selectedByKind[kind] = key || null;
  const saved = Notifications.setFriendSound(nick, kind, key);
  if (saved === false) {
    if (typeof toast === 'function') toast('Storage full: selection applied for this session only', 'warning');
  }
  _renderQuickButtons(kind, key || null);
  _renderFriendSoundList(kind);
  if (key) _previewFriendSound(kind, key);
  else _previewDefaultFriendSound(kind);
  // Re-assert selected state after preview path (which may trigger other UI refreshes).
  m._selectedByKind[kind] = key || null;
  _renderQuickButtons(kind, key || null);
}

function _previewDefaultFriendSound(kind) {
  if (!window.Notifications) return;
  try { Notifications.stopAllPreviewAudio?.(); } catch {}
  try { Notifications.unlockAudio?.(); } catch {}
  _setCustomPreviewState('', '');
  if (kind === 'msg') {
    const tone = localStorage.getItem('ft_notify_tone') || 'pop';
    Notifications.previewTone(tone, { force: true, preview: true });
  } else {
    const ring = localStorage.getItem('ft_notify_ring') || 'default';
    Notifications.previewRingtone(ring, { force: true, preview: true });
  }
}

// Custom-sound metadata: { [friend:<nick>:<kind>]: { name, size } }
function _getCustomSoundMetaMap() {
  try { return JSON.parse(localStorage.getItem('ft_custom_sound_meta') || '{}') || {}; }
  catch { return {}; }
}
function _saveCustomSoundMetaMap(m) {
  try { localStorage.setItem('ft_custom_sound_meta', JSON.stringify(m || {})); } catch {}
}
function _customMetaKey(nick, kind) { return 'friend:' + nick + ':' + kind; }
function _getCustomSoundMeta(nick, kind) {
  return _getCustomSoundMetaMap()[_customMetaKey(nick, kind)] || null;
}
function _setCustomSoundMeta(nick, kind, meta) {
  const m = _getCustomSoundMetaMap();
  const key = _customMetaKey(nick, kind);
  if (meta) m[key] = meta; else delete m[key];
  _saveCustomSoundMetaMap(m);
}

function _serverSessionToken() {
  try { return String(State?.token || ''); } catch { return ''; }
}

function _authedSoundUrl(url) {
  const u = String(url || '');
  if (!u) return '';
  const tok = _serverSessionToken();
  if (!tok) return u;
  const sep = u.includes('?') ? '&' : '?';
  return u + sep + 'token=' + encodeURIComponent(tok);
}

function _fileToDataUrl(file) {
  return new Promise((resolve) => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => resolve('');
      fr.readAsDataURL(file);
    } catch {
      resolve('');
    }
  });
}

async function _syncServerSounds(kind) {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  const tok = _serverSessionToken();
  if (!m || !nick || !tok) return;
  try {
    const res = await fetch('/api/friends/sounds/' + encodeURIComponent(nick) + '/' + encodeURIComponent(kind), {
      headers: { 'X-Session-Token': tok },
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error('load failed');
    const payload = await res.json().catch(() => ({}));
    const assets = Array.isArray(payload?.assets) ? payload.assets : [];
    const active = payload?.active || assets.find(a => a?.is_active) || null;
    m._serverSounds = m._serverSounds || {};
    m._serverSounds[kind] = { assets, active, loaded: true };
    if (active?.url) {
      const authed = _authedSoundUrl(active.url);
      // Don't overwrite a locally-cached data: URL with a server URL — server
      // URLs with embedded tokens drift across nodes and cause http_400 on preview.
      const existing = Notifications.getCustomSound?.(nick, kind);
      if (!existing || !/^data:/i.test(existing)) {
        try { Notifications.setCustomSound?.(nick, kind, authed); } catch {}
      }
      _setCustomSoundMeta(nick, kind, {
        name: active.filename || 'Custom file',
        size: Number(active.file_size || 0) || 0,
        assetId: Number(active.id || 0) || 0,
        url: String(active.url || ''),
      });
    }
    _renderFriendSoundList(kind);
  } catch {
    m._serverSounds = m._serverSounds || {};
    m._serverSounds[kind] = { assets: [], active: null, loaded: false };
  }
}

async function _activateServerSound(kind, assetId) {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  const tok = _serverSessionToken();
  if (!m || !nick || !tok || !assetId) return false;
  try {
    const res = await fetch('/api/friends/sounds/activate/' + encodeURIComponent(String(assetId)), {
      method: 'POST',
      headers: { 'X-Session-Token': tok },
      credentials: 'same-origin',
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload?.ok) return false;
    await _syncServerSounds(kind);
    return true;
  } catch {
    return false;
  }
}

async function _deleteServerSound(kind, assetId) {
  const m = document.getElementById('friend-sound-modal');
  const tok = _serverSessionToken();
  if (!m || !tok || !assetId) return false;
  try {
    const res = await fetch('/api/friends/sounds/' + encodeURIComponent(String(assetId)), {
      method: 'DELETE',
      headers: { 'X-Session-Token': tok },
      credentials: 'same-origin',
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload?.ok) return false;
    await _syncServerSounds(kind);
    return true;
  } catch {
    return false;
  }
}

async function _selectCustomSound(kind, assetId) {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (!nick || !window.Notifications) return;
  const serverState = m?._serverSounds?.[kind] || null;
  const pickId = Number(assetId || serverState?.active?.id || serverState?.assets?.[0]?.id || 0) || 0;
  if (pickId) {
    const ok = await _activateServerSound(kind, pickId);
    if (!ok && typeof toast === 'function') toast('Could not activate this sound', 'error');
  }
  m._selectedByKind = m._selectedByKind || {};
  m._selectedByKind[kind] = 'custom';
  Notifications.setFriendSound(nick, kind, 'custom');
  _renderFriendSoundList(kind);
  _previewFriendSound(kind, 'custom', pickId || null);
  if (typeof toast === 'function') toast('Using your custom sound', 'success');
}

async function _deleteCustomSound(kind, assetId) {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (!nick || !window.Notifications) return;
  const serverState = m?._serverSounds?.[kind] || null;
  const pickId = Number(assetId || serverState?.active?.id || 0) || 0;
  // Optimistic: update UI immediately so controls feel instant
  Notifications.setCustomSound(nick, kind, null);
  _setCustomSoundMeta(nick, kind, null);
  m._selectedByKind = m._selectedByKind || {};
  // If this custom was the active selection, fall back to default
  if (Notifications.getFriendSound(nick, kind) === 'custom') {
    m._selectedByKind[kind] = null;
    Notifications.setFriendSound(nick, kind, null);
  }
  _renderFriendSoundList(kind);
  if (typeof toast === 'function') toast('Custom sound removed', 'info');
  // Fire server delete in background; if it fails just warn
  if (pickId) {
    _deleteServerSound(kind, pickId).then(ok => {
      if (!ok && typeof toast === 'function') toast('Warning: could not remove from server', 'warning');
    }).catch(() => {});
  }
}

function _setPendingUpload(kind, file) {
  const m = document.getElementById('friend-sound-modal');
  if (!m || !kind || !file) return;
  m._pendingUploads = m._pendingUploads || {};
  m._uploadBusy = m._uploadBusy || {};
  m._uploadProgress = m._uploadProgress || {};
  m._uploadStatus = m._uploadStatus || {};
  m._uploadBusy[kind] = false;
  m._uploadProgress[kind] = 0;
  m._uploadStatus[kind] = 'not uploaded yet';
  const prev = m._pendingUploads[kind];
  if (prev?.url) {
    try { URL.revokeObjectURL(prev.url); } catch {}
  }
  let url = '';
  try { url = URL.createObjectURL(file); } catch {}
  m._pendingUploads[kind] = { file, url };
  _renderPendingUpload(kind);
}

function _clearPendingUpload(kind) {
  const m = document.getElementById('friend-sound-modal');
  if (!m || !m._pendingUploads?.[kind]) return;
  const p = m._pendingUploads[kind];
  if (p?.url) {
    try { URL.revokeObjectURL(p.url); } catch {}
  }
  delete m._pendingUploads[kind];
  if (m._uploadBusy) delete m._uploadBusy[kind];
  if (m._uploadProgress) delete m._uploadProgress[kind];
  if (m._uploadStatus) delete m._uploadStatus[kind];
  _renderPendingUpload(kind);
}

function _renderPendingUpload(kind) {
  const m = document.getElementById('friend-sound-modal');
  if (!m) return;
  const id = kind === 'msg' ? 'fsm-msg-pending' : 'fsm-ring-pending';
  const el = m.querySelector('#' + id);
  if (!el) return;
  const p = m._pendingUploads?.[kind] || null;
  const busy = !!m._uploadBusy?.[kind];
  const prog = Math.max(0, Math.min(100, m._uploadProgress?.[kind] || 0));
  const status = m._uploadStatus?.[kind] || (busy ? ('uploading ' + prog + '%') : 'not uploaded yet');
  const playingPending = _isPreviewing(kind, 'pending');
  if (!p?.file) {
    el.innerHTML = '';
    return;
  }
  const kb = Math.max(1, Math.round((p.file.size || 0) / 1024));
  el.innerHTML = `
    <div class="fsm-custom-chip" style="margin-bottom:8px;box-shadow:0 0 0 2px rgba(255,193,7,.18)">
      <button class="fcc-btn" type="button" title="${playingPending ? 'Stop preview' : 'Preview selected'}" data-fsm-action="preview-pending" data-kind="${kind}" ${busy ? 'disabled' : ''}>${playingPending ? '■' : '▶'}</button>
      <div style="flex:1;min-width:0">
        <div class="fcc-name">Selected: ${esc(p.file.name || 'file')}</div>
        <div class="fcc-meta">${kb} KB · ${esc(status)}</div>
      </div>
      <button class="fcc-btn danger" type="button" title="Clear selected" data-fsm-action="clear-pending" data-kind="${kind}" ${busy ? 'disabled' : ''}>✕</button>
    </div>`;
}

async function _previewPendingUpload(kind) {
  const m = document.getElementById('friend-sound-modal');
  const p = m?._pendingUploads?.[kind];
  if (!p?.url) return;
  if (_isPreviewing(kind, 'pending')) {
    try { Notifications.stopAllPreviewAudio?.(); } catch {}
    _setCustomPreviewState('', '');
    return;
  }
  try {
    try { Notifications.unlockAudio?.(); } catch {}
    Notifications.stopAllPreviewAudio?.();
    const res = await (Notifications.previewCustomSound?.(p.url, kind)
      || Promise.resolve({ ok: !!Notifications.playCustomSound?.(p.url, kind), error: 'play_failed' }));
    if (!res?.ok) throw new Error(res?.error || 'play_failed');
    _setCustomPreviewState(kind, 'pending');
    if (typeof toast === 'function') toast('Previewing selected file', 'info');
  } catch (e) {
    if (typeof toast === 'function') toast('Preview failed: ' + String(e?.message || 'unavailable'), 'error');
  }
}

async function _commitPendingUpload(kind) {
  const m = document.getElementById('friend-sound-modal');
  if (m?._uploadBusy?.[kind]) {
    if (typeof toast === 'function') toast('Upload already in progress', 'info');
    return;
  }
  const p = m?._pendingUploads?.[kind];
  if (!p?.file) {
    if (typeof toast === 'function') toast('No file selected', 'info');
    return;
  }
  m._uploadBusy = m._uploadBusy || {};
  m._uploadProgress = m._uploadProgress || {};
  m._uploadStatus = m._uploadStatus || {};
  m._uploadBusy[kind] = true;
  m._uploadProgress[kind] = 0;
  m._uploadStatus[kind] = 'uploading...';
  const input = m.querySelector('#fsm-native-upload-' + kind);
  if (input) input.disabled = true;
  _renderPendingUpload(kind);
  let ok = false;
  try {
    const watchdog = new Promise((resolve) => {
      setTimeout(() => resolve('__timeout__'), 130000);
    });
    const result = await Promise.race([_uploadFriendSound(kind, p.file), watchdog]);
    if (result === '__timeout__') {
      ok = false;
      m._uploadStatus[kind] = 'upload timed out';
    } else {
      ok = !!result;
    }
    if (ok) {
      m._uploadProgress[kind] = 100;
      m._uploadStatus[kind] = 'upload complete';
    }
  } catch (e) {
    ok = false;
    m._uploadStatus[kind] = 'upload failed';
  } finally {
    m._uploadBusy[kind] = false;
    if (input) input.disabled = false;
  }
  if (!ok && (!m._uploadStatus?.[kind] || String(m._uploadStatus?.[kind]).startsWith('uploading'))) {
    m._uploadStatus[kind] = 'upload failed';
    _renderPendingUpload(kind);
  }
  if (!ok) _renderPendingUpload(kind);
  if (!ok && (!m._uploadStatus || !m._uploadStatus[kind])) {
    m._uploadStatus = m._uploadStatus || {};
    m._uploadStatus[kind] = 'upload failed';
    _renderPendingUpload(kind);
  }
  if (ok) _clearPendingUpload(kind);
}

async function _uploadFriendSound(kind, file) {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (!nick || !window.Notifications) {
    if (m) {
      m._uploadStatus = m._uploadStatus || {};
      m._uploadStatus[kind] = !nick ? 'upload failed: no active friend context' : 'upload failed: notifications unavailable';
      _renderPendingUpload(kind);
    }
    return false;
  }
  if (!file) {
    const picker = m.querySelector('#fsm-native-upload-' + kind);
    if (!picker) return false;
    // Fallback path used when custom preview triggers upload.
    try {
      picker.click();
    } catch {
      if (typeof toast === 'function') toast('Unable to open file picker', 'error');
    }
    return false;
  }
  let res = null;
  try {
    res = await Notifications.uploadCustomSound(nick, kind, file, (pct) => {
      const mm = document.getElementById('friend-sound-modal');
      if (!mm) return;
      mm._uploadProgress = mm._uploadProgress || {};
      mm._uploadStatus = mm._uploadStatus || {};
      const n = Number(pct);
      if (Number.isFinite(n) && n > 0) {
        const p = Math.max(1, Math.min(100, Math.round(n)));
        mm._uploadProgress[kind] = p;
        mm._uploadStatus[kind] = 'uploading ' + p + '%';
      } else {
        mm._uploadStatus[kind] = 'uploading...';
      }
      _renderPendingUpload(kind);
    });
  } catch {
    const mm = document.getElementById('friend-sound-modal');
    if (mm) {
      mm._uploadStatus = mm._uploadStatus || {};
      mm._uploadStatus[kind] = 'upload failed';
    }
    if (typeof toast === 'function') toast('Upload failed', 'error');
    return false;
  }
  if (!res.ok) {
    const mm = document.getElementById('friend-sound-modal');
    if (mm) {
      mm._uploadStatus = mm._uploadStatus || {};
      mm._uploadStatus[kind] = res.error || 'upload failed';
    }
    if (typeof toast === 'function') toast(res.error || 'Upload failed', 'error');
    _renderPendingUpload(kind);
    return false;
  }
  _setCustomSoundMeta(nick, kind, { name: file.name || 'Custom file', size: file.size || 0 });
  Notifications.setFriendSound(nick, kind, 'custom');
  // Wire modal-local selection state so UI shows 'custom' as selected
  const modalEl = document.getElementById('friend-sound-modal');
  if (modalEl) {
    modalEl._selectedByKind = modalEl._selectedByKind || {};
    modalEl._selectedByKind[kind] = 'custom';
  }
  if (res.asset?.id) {
    _setCustomSoundMeta(nick, kind, {
      name: res.asset.filename || file.name || 'Custom file',
      size: Number(res.asset.file_size || file.size || 0) || 0,
      assetId: Number(res.asset.id || 0) || 0,
      url: String(res.asset.url || ''),
    });
    void _syncServerSounds(kind);
  }
  // Best effort: keep a local data URL for reliable preview even when
  // server-token validation drifts across origins.
  try {
    const localDataUrl = await _fileToDataUrl(file);
    if (localDataUrl) Notifications.setCustomSound?.(nick, kind, localDataUrl);
  } catch {}
  _renderFriendSoundList(kind);
  if (typeof toast === 'function') toast('Custom sound saved & active', 'success');
  const uploadedCt = String(res.asset?.content_type || file.type || '').toLowerCase();
  let localPreviewUrl = '';
  try { localPreviewUrl = URL.createObjectURL(file); } catch {}
  if (_canPreviewAudioContentType(uploadedCt)) {
    // Prefer previewing the local selected file first to avoid cross-node
    // token drift immediately after upload.
    let played = await (Notifications.previewCustomSound?.(localPreviewUrl || res.dataUrl, kind)
      || Promise.resolve({ ok: !!Notifications.playCustomSound?.(localPreviewUrl || res.dataUrl, kind), error: 'play_failed' }));
    if (!played?.ok && localPreviewUrl) {
      played = await (Notifications.previewCustomSound?.(res.dataUrl, kind)
        || Promise.resolve({ ok: !!Notifications.playCustomSound?.(res.dataUrl, kind), error: 'play_failed' }));
    }
    if (played?.ok) {
      _setCustomPreviewState(kind, 'saved:' + (Number(res.asset?.id || 0) || 'local'));
    } else {
      _setCustomPreviewState('', '');
      if (typeof toast === 'function') toast('Saved, but preview failed: ' + String(played?.error || 'unavailable'), 'warning');
    }
  } else {
    _setCustomPreviewState('', '');
    if (typeof toast === 'function') toast('Saved. Preview not available for this file format', 'info');
  }
  return true;
}

async function _previewFriendSound(kind, key, assetId) {
  if (!window.Notifications || !key) return;
  try { Notifications.unlockAudio?.(); } catch {}
  try { Notifications.stopAllPreviewAudio?.(); } catch {}
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (key === 'custom' && nick) {
    const localCached = String(Notifications.getCustomSound?.(nick, kind) || '');
    const hasLocalPlayable = /^data:audio\//i.test(localCached) || /^blob:/i.test(localCached);
    if (hasLocalPlayable) {
      if (_isPreviewing(kind, 'saved')) {
        try { Notifications.stopCustomSound?.(); } catch {}
        _setCustomPreviewState('', '');
        return;
      }
      const localRes = await (Notifications.previewCustomSound?.(localCached, kind)
        || Promise.resolve({ ok: !!Notifications.playCustomSound?.(localCached, kind), error: 'play_failed' }));
      if (localRes?.ok) {
        _setCustomPreviewState(kind, 'saved');
        return;
      }
    }
    const serverState = m?._serverSounds?.[kind] || null;
    const sid = Number(assetId || serverState?.active?.id || 0) || 0;
    const serverAsset = sid
      ? (Array.isArray(serverState?.assets) ? serverState.assets.find(a => Number(a?.id || 0) === sid) : null)
      : (serverState?.active || null);
    if (serverAsset?.url) {
      if (!_canPreviewAudioContentType(serverAsset?.content_type)) {
        if (typeof toast === 'function') toast('Saved, but this format cannot be previewed on this device', 'info');
        _setCustomPreviewState('', '');
        return;
      }
      const sourceKey = 'saved:' + (Number(serverAsset.id || 0) || 'x');
      if (_isPreviewing(kind, sourceKey)) {
        try { Notifications.stopCustomSound?.(); } catch {}
        _setCustomPreviewState('', '');
        return;
      }
      const res = await (Notifications.previewCustomSound?.(_authedSoundUrl(serverAsset.url), kind)
        || Promise.resolve({ ok: !!Notifications.playCustomSound?.(_authedSoundUrl(serverAsset.url), kind), error: 'play_failed' }));
      if (!res?.ok) {
        const local = Notifications.getCustomSound?.(nick, kind);
        const remote = _authedSoundUrl(serverAsset.url);
        if (local && local !== remote) {
          const localRes = await (Notifications.previewCustomSound?.(local, kind)
            || Promise.resolve({ ok: !!Notifications.playCustomSound?.(local, kind), error: 'play_failed' }));
          if (localRes?.ok) {
            _setCustomPreviewState(kind, sourceKey);
            if (typeof toast === 'function') toast('Previewing local cached sound', 'info');
            return;
          }
        }
        if (typeof toast === 'function') toast('Preview failed: ' + String(res?.error || 'unavailable'), 'error');
        _setCustomPreviewState('', '');
        return;
      }
      _setCustomPreviewState(kind, sourceKey);
      return;
    }
    const data = Notifications.getCustomSound(nick, kind);
    if (data) {
      if (_isPreviewing(kind, 'saved')) {
        try { Notifications.stopCustomSound?.(); } catch {}
        _setCustomPreviewState('', '');
        return;
      }
      const res = await (Notifications.previewCustomSound?.(data, kind)
        || Promise.resolve({ ok: !!Notifications.playCustomSound?.(data, kind), error: 'play_failed' }));
      if (!res?.ok) {
        if (typeof toast === 'function') toast('Preview failed: ' + String(res?.error || 'unavailable'), 'error');
        _setCustomPreviewState('', '');
        return;
      }
      _setCustomPreviewState(kind, 'saved');
      return;
    }
    return _uploadFriendSound(kind);
  }
  _setCustomPreviewState('', '');
  const result = kind === 'msg'
    ? Notifications.previewTone(key, { force: true, preview: true })
    : Notifications.previewRingtone(key, { force: true, preview: true });
  if (result && result.ok === false) {
    if (typeof toast === 'function') toast('Preview blocked: ' + (result.reason || 'audio unavailable'), 'error');
  }
}
