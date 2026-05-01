/* ─── friends.js ──────────────────────────────────────────────────────────── */
'use strict';

let _currentFriendTab = 'friends';
let _pendingFriends    = [];
let _allFriends        = [];

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
        <div style="font-size:12px;color:#9dc4b2">${esc(f.status_msg||presenceLabel(f.presence))}</div>
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
  if (btn.dataset.action === 'accept') {
    acceptFriend(nick).then(() => closeModal('modal-user-info'));
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
        <div class="ffp-status">${esc(f.status_msg || presenceLabel(f.presence))}</div>
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
  let modal = document.getElementById('friend-sound-modal');
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
          <button class="fsm-close" type="button" aria-label="Close" onclick="closeFriendSoundEditor()">✕</button>
        </div>
        <div class="fsm-body">
          <div class="fsm-section">
            <div class="fsm-section-head">
              <div class="fsm-section-title"><span>💬</span> Message alert</div>
              <button class="fsm-upload-btn" type="button" onclick="_uploadFriendSound('msg')" title="Upload mp3, wav, ogg, m4a, aac, opus, flac, mp4, or webm"><span>📁</span> Upload</button>
            </div>
            <div class="fsm-empty-hint" style="margin:4px 0 8px">Default picks:
              <button class="fcc-btn" type="button" onclick="_selectFriendSoundKey('msg', null)">App default</button>
              <button class="fcc-btn" type="button" onclick="_selectFriendSoundKey('msg', 'pop')">Pop</button>
              <button class="fcc-btn" type="button" onclick="_selectFriendSoundKey('msg', 'chime')">Chime</button>
              <button class="fcc-btn" type="button" onclick="_selectFriendSoundKey('msg', 'ding')">Ding</button>
            </div>
            <div id="fsm-msg-custom"></div>
            <div id="fsm-msg-list" class="fsm-list"></div>
          </div>
          <div class="fsm-section">
            <div class="fsm-section-head">
              <div class="fsm-section-title"><span>📞</span> Incoming call ringtone</div>
              <button class="fsm-upload-btn" type="button" onclick="_uploadFriendSound('ring')" title="Upload mp3, wav, ogg, m4a, aac, opus, flac, mp4, or webm"><span>📁</span> Upload</button>
            </div>
            <div class="fsm-empty-hint" style="margin:4px 0 8px">Default picks:
              <button class="fcc-btn" type="button" onclick="_selectFriendSoundKey('ring', null)">App default</button>
              <button class="fcc-btn" type="button" onclick="_selectFriendSoundKey('ring', 'classic')">Classic</button>
              <button class="fcc-btn" type="button" onclick="_selectFriendSoundKey('ring', 'digital')">Digital</button>
              <button class="fcc-btn" type="button" onclick="_selectFriendSoundKey('ring', 'melody')">Melody</button>
            </div>
            <div id="fsm-ring-custom"></div>
            <div id="fsm-ring-list" class="fsm-list"></div>
          </div>
        </div>
        <input id="fsm-file-input" type="file" accept="audio/*,video/mp4,video/webm,.mp3,.wav,.ogg,.m4a,.aac,.opus,.flac,.mp4,.webm" style="display:none">
        <div class="fsm-actions">
          <button class="fsm-btn" type="button" onclick="resetFriendSounds()">↺ Reset to default</button>
          <button class="fsm-btn primary" type="button" onclick="closeFriendSoundEditor()">✓ Done</button>
        </div>
      </div>`;
    // Click outside the box to close
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeFriendSoundEditor();
    });
    document.body.appendChild(modal);
  }
  modal._targetNick = nick;
  const peerEl = modal.querySelector('#fsm-peer');
  if (peerEl) peerEl.textContent = 'for @' + nick;
  _renderFriendSoundList('msg');
  _renderFriendSoundList('ring');
  modal.style.display = 'flex';
  modal.classList.remove('hidden');
}

function closeFriendSoundEditor() {
  const m = document.getElementById('friend-sound-modal');
  if (m) { m.style.display = 'none'; m.classList.add('hidden'); }
}

function resetFriendSounds() {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (!nick || !window.Notifications) return;
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
  const current = Notifications.getFriendSound ? Notifications.getFriendSound(nick, kind) : null;
  const customData = (Notifications.getCustomSound && Notifications.getCustomSound(nick, kind)) || null;
  const customMeta = _getCustomSoundMeta(nick, kind);

  // Render the "uploaded file" chip if present
  const customContainerId = kind === 'msg' ? 'fsm-msg-custom' : 'fsm-ring-custom';
  const customEl = m.querySelector('#' + customContainerId);
  if (customEl) {
    if (customData) {
      const isSelected = current === 'custom';
      const name = customMeta?.name || 'Custom file';
      const sizeKb = customMeta?.size ? Math.round(customMeta.size / 1024) + ' KB' : '';
      customEl.innerHTML = `
        <div class="fsm-custom-chip" style="${isSelected ? 'box-shadow:0 0 0 2px rgba(76,175,80,.35)' : ''}">
          <button class="fcc-btn" title="Preview" onclick="_previewFriendSound('${kind}','custom')">▶</button>
          <div style="flex:1;min-width:0">
            <div class="fcc-name">${esc(name)}</div>
            <div class="fcc-meta">${sizeKb} · ${isSelected ? '✓ Active' : 'tap to use'}</div>
          </div>
          ${isSelected
            ? '<span style="color:#4caf50;font-size:11px;font-weight:700;padding:0 6px">ACTIVE</span>'
            : `<button class="fcc-btn" title="Use this" onclick="_selectCustomSound('${kind}')">✓</button>`}
          <button class="fcc-btn danger" title="Delete" onclick="_deleteCustomSound('${kind}')">✕</button>
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
      : `<button class="fsm-play" title="Preview" onclick="event.stopPropagation();_previewFriendSound('${kind}','${key}')">▶</button>`;
    return `
      <div class="fsm-row ${selected ? 'selected' : ''}" data-kind="${kind}" data-key="${key}" data-default="${it.isDefault ? '1' : ''}" onclick="_selectFriendSound(this)">
        <span class="fsm-dot"></span>
        <span class="fsm-label">${esc(label)}</span>
        ${rightBtn}
      </div>`;
  }).join('');
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
  Notifications.setFriendSound(nick, kind, key);
  _renderFriendSoundList(kind);
  if (key) _previewFriendSound(kind, key);
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

function _selectCustomSound(kind) {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (!nick || !window.Notifications) return;
  Notifications.setFriendSound(nick, kind, 'custom');
  _renderFriendSoundList(kind);
  _previewFriendSound(kind, 'custom');
  if (typeof toast === 'function') toast('Using your custom sound', 'success');
}

function _deleteCustomSound(kind) {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (!nick || !window.Notifications) return;
  Notifications.setCustomSound(nick, kind, null);
  _setCustomSoundMeta(nick, kind, null);
  // If this custom was the active selection, fall back to default
  if (Notifications.getFriendSound(nick, kind) === 'custom') {
    Notifications.setFriendSound(nick, kind, null);
  }
  _renderFriendSoundList(kind);
  if (typeof toast === 'function') toast('Custom sound removed', 'info');
}

function _uploadFriendSound(kind) {
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (!nick || !window.Notifications) return;
  const input = m.querySelector('#fsm-file-input');
  if (!input) {
    if (typeof toast === 'function') toast('Upload control unavailable', 'error');
    return;
  }
  m._uploadKind = kind;
  input.value = '';
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const useKind = m._uploadKind || kind;
    const res = await Notifications.uploadCustomSound(nick, useKind, f);
    if (!res.ok) {
      if (typeof toast === 'function') toast(res.error || 'Upload failed', 'error');
      return;
    }
    _setCustomSoundMeta(nick, useKind, { name: f.name || 'Custom file', size: f.size || 0 });
    Notifications.setFriendSound(nick, useKind, 'custom');
    _renderFriendSoundList(useKind);
    if (typeof toast === 'function') toast('Custom sound saved & active', 'success');
    Notifications.playCustomSound(res.dataUrl);
  };
  input.click();
}

function _previewFriendSound(kind, key) {
  if (!window.Notifications || !key) return;
  const m = document.getElementById('friend-sound-modal');
  const nick = m?._targetNick;
  if (key === 'custom' && nick) {
    const data = Notifications.getCustomSound(nick, kind);
    if (data) return Notifications.playCustomSound(data);
    return _uploadFriendSound(kind);
  }
  if (kind === 'msg') Notifications.previewTone(key);
  else Notifications.previewRingtone(key);
}
