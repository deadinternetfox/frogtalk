/**
 * app.js — Boot, auth check, main app initialization
 */

// ─── Mobile keyboard / visual-viewport sync ───────────────────────────────
// When the on-screen keyboard opens in a DM or channel composer, the
// browser's "layout viewport" doesn't change height — so anything sized
// to 100vh stays the same and gets pushed up by the focused input, which
// drags the top of the app off-screen and hides the channel header.
//
// We solve this two ways:
//  1. The viewport <meta> uses interactive-widget=resizes-content so
//     Android Chrome shrinks the layout viewport itself when the keyboard
//     opens (no JS needed there).
//  2. For iOS Safari (and older Android WebViews that ignore that hint)
//     we mirror window.visualViewport.height into the --vvh CSS variable,
//     which `body` and `#app` use for their height. As the keyboard
//     comes up, --vvh shrinks → the app shell shrinks → composer stays
//     visible above the keyboard → header stays glued to the top of the
//     visible area instead of being scrolled off.
//
// We also pin window.scrollTo(0,0) so iOS can't sneak in its automatic
// "scroll the focused input into view" behaviour that re-creates the
// "top of app off-screen" symptom.
(function _ftViewportSync() {
  try {
    const vv = window.visualViewport;
    if (!vv) {
      // No visualViewport API → just leave CSS fallbacks (100svh) in place.
      return;
    }
    const root = document.documentElement;
    let _raf = 0;
    const apply = () => {
      _raf = 0;
      // vv.height is the height of the visible area excluding the
      // keyboard / browser chrome. innerHeight on iOS keeps the full
      // window height even with keyboard up, which is the bug.
      const h = Math.max(0, Math.round(vv.height));
      root.style.setProperty('--vvh', h + 'px');
      // Keep the page glued to the top so the header never scrolls off.
      // visualViewport.offsetTop > 0 means the page was scrolled up by
      // iOS to make the focused input visible — undo that immediately.
      if (vv.offsetTop > 0 || window.scrollY !== 0) {
        try { window.scrollTo(0, 0); } catch {}
      }
    };
    const schedule = () => {
      if (_raf) return;
      _raf = requestAnimationFrame(apply);
    };
    apply();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    // Some browsers don't fire visualViewport events on orientation
    // change reliably; belt-and-braces.
    window.addEventListener('orientationchange', () => setTimeout(apply, 120));
    window.addEventListener('resize', schedule);
    // When an input gains focus on iOS the scroll-into-view kicks in
    // before visualViewport reports the new height. Re-run on focus.
    document.addEventListener('focusin', () => setTimeout(apply, 60), true);
    document.addEventListener('focusout', () => setTimeout(apply, 60), true);
  } catch {}
})();

const App = {
  pendingInvite: null,  // Store invite code to process after login
  PENDING_CALL_KEY: 'ft_pending_incoming_call',
  ASSET_RESET_VERSION: 'android-calls-setup-v2',
  easterEgg: null,
  easterTapCount: 0,
  easterTapTimer: null,
  federationSyncHint: '',
  federationSyncState: null,

  async ensureFreshAssets() {
    try {
      const markerKey = 'ft_asset_reset_version';
      const current = localStorage.getItem(markerKey);
      if (current === this.ASSET_RESET_VERSION) return false;

      // One-time hard reset for stale SW/caches so latest call UI JS is loaded.
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      if ('caches' in window && typeof caches.keys === 'function') {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }

      localStorage.setItem(markerKey, this.ASSET_RESET_VERSION);
      location.reload();
      return true;
    } catch {
      return false;
    }
  },

  setPendingIncomingCall(pending) {
    try {
      const callId = String(pending?.callId || '').trim();
      if (!callId) return;
      const payload = {
        callId,
        peerNick: String(pending?.peerNick || '').trim(),
        action: String(pending?.action || '').trim().toLowerCase(),
        ts: Date.now(),
      };
      localStorage.setItem(this.PENDING_CALL_KEY, JSON.stringify(payload));
    } catch {}
  },

  getPendingIncomingCall() {
    try {
      const raw = localStorage.getItem(this.PENDING_CALL_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      const callId = String(p?.callId || '').trim();
      if (!callId) return null;
      return {
        callId,
        peerNick: String(p?.peerNick || '').trim(),
        action: String(p?.action || '').trim().toLowerCase(),
      };
    } catch {
      return null;
    }
  },

  clearPendingIncomingCall() {
    try { localStorage.removeItem(this.PENDING_CALL_KEY); } catch {}
  },

  forceAndroidFcmResync(sessionToken = '') {
    const token = String(sessionToken || State.token || '').trim();
    if (!token) return;
    try {
      if (window.Android && typeof window.Android.registerFcmToken === 'function') {
        window.Android.registerFcmToken(token);
      }
    } catch (e) {
      console.warn('[App] Android FCM resync failed', e);
    }
  },

  consumeSwitchTicket() {
    try {
      const raw = String(window.name || '').trim();
      if (!raw) return '';
      const obj = JSON.parse(raw);
      const ticket = String(obj?.ft_switch_ticket || '').trim();
      const ts = Number(obj?.ts || 0);
      window.name = '';
      if (!ticket) return '';
      if (!Number.isFinite(ts) || (Date.now() - ts) > 2 * 60 * 1000) return '';
      return ticket;
    } catch {
      try { window.name = ''; } catch {}
      return '';
    }
  },

  async tryAutoLoginFromSwitchTicket(ticket = '') {
    const t = String(ticket || this.consumeSwitchTicket() || '').trim();
    if (!t) return false;
    try {
      const res = await fetch('/api/auth/federation-ticket-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: t }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data?.token || !data?.user_id) return false;
      State.token = data.token;
      State.user = {
        id: data.user_id,
        nickname: data.nickname,
        display_name: data.display_name || null,
        username_change_remaining_seconds: Number(data.username_change_remaining_seconds || 0),
        avatar: data.avatar,
        bio: data.bio,
        is_admin: data.is_admin,
        presence: data.presence || 'online',
        status_msg: ('status_msg' in data) ? (data.status_msg ?? '') : '',
      };
      State.save();
      this.federationSyncHint = String(data?.federation_sync?.hint || '').trim();
      this.forceAndroidFcmResync(State.token);
      try { localStorage.setItem('ft_just_switched_node', '1'); } catch {}
      return true;
    } catch {
      return false;
    }
  },

  consumeJustSwitchedNodeFlag() {
    try {
      if (localStorage.getItem('ft_just_switched_node') !== '1') return false;
      localStorage.removeItem('ft_just_switched_node');
      return true;
    } catch {
      return false;
    }
  },

  async init() {
    if (await this.ensureFreshAssets()) return;

    State.load();

    const hideSplash = () => {
      const s = document.getElementById('boot-splash');
      if (!s) return;
      s.classList.add('fading');
      setTimeout(() => s.remove(), 260);
    };
    const showAuth = () => {
      document.getElementById('auth-overlay').classList.remove('hidden');
      document.getElementById('app').classList.add('hidden');
      try { window.__ftApplyMiniBoardGuestMode && window.__ftApplyMiniBoardGuestMode(); } catch {}
      const nick = document.getElementById('auth-nickname');
      if (nick) nick.focus();
      hideSplash();
    };

    // Check for invite link / share link params in URL
    const params = new URLSearchParams(window.location.search);
    const returnTo = (params.get('return') || '').trim();
    if (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')) {
      this.pendingReturn = returnTo;
    }
    const inviteCode = params.get('invite');
    if (inviteCode) {
      this.pendingInvite = inviteCode;
      // Auto-switch to the Register tab if the landing page sent the user
      // via "Create a new account" — otherwise they'd land on Login and wonder
      // where the sign-up fields went.
      if (params.get('register') === '1') {
        this.pendingRegisterMode = true;
      }
      window.history.replaceState({}, '', window.location.pathname);
    }
    const pendingProfile = params.get('profile');
    if (pendingProfile) {
      this.pendingProfile = pendingProfile;
      window.history.replaceState({}, '', window.location.pathname);
    }
    const pendingDM = (params.get('dm') || '').trim();
    if (pendingDM) {
      this.pendingDM = pendingDM;
      window.history.replaceState({}, '', window.location.pathname);
    }
    const pendingRoom = params.get('room');
    if (pendingRoom) {
      this.pendingRoom = pendingRoom;
      window.history.replaceState({}, '', window.location.pathname);
    }
    const pendingReel = params.get('reel') || params.get('r');
    if (pendingReel) {
      this.pendingReel = pendingReel;
      window.history.replaceState({}, '', window.location.pathname);
    }
    const pendingPost = params.get('post') || params.get('p');
    if (pendingPost) {
      this.pendingPost = pendingPost;
      window.history.replaceState({}, '', window.location.pathname);
    }
    const incomingCall = params.get('incoming_call');
    const pendingCallId = params.get('call_id');
    const pendingPeerNick = params.get('peer_nick');
    const pendingCallAction = String(params.get('action') || params.get('call_action') || '').trim().toLowerCase();
    if (incomingCall === '1' && pendingCallId) {
      this.pendingIncomingCall = {
        callId: pendingCallId,
        peerNick: pendingPeerNick || '',
        action: pendingCallAction,
      };
      this.setPendingIncomingCall(this.pendingIncomingCall);
      window.history.replaceState({}, '', window.location.pathname);
    } else {
      this.pendingIncomingCall = this.getPendingIncomingCall();
    }
    // (Removed: legacy cold-start ftCallAccept/ftCallReject hash handler.
    //  OS notification action buttons no longer exist — the in-page
    //  #incoming-call popup is the single Accept/Decline surface.)

    if (!State.token || !State.user) {
      const switched = params.get('switched') === '1';
      const switchedTor = params.get('tor') === '1';
      if (switched) {
        const ok = await this.tryAutoLoginFromSwitchTicket();
        if (ok) {
          hideSplash();
          try { await this.launch(); } catch (e) { console.error('[App] launch failed', e); }
          return;
        }
        if (switchedTor && typeof UI !== 'undefined' && UI.showToast) {
          UI.showToast('Tor switch detected. Auto-login can fail across onion hops — log in again if needed.', 'info', 6500);
        }
      }
    }

    if (State.token && State.user) {
      // Check auto-login setting
      if (localStorage.getItem('frogtalk-auto-login') === 'false') {
        // Auto-login disabled, clear saved session
        State.token = null;
        State.user = null;
        localStorage.removeItem('fc_token');
        localStorage.removeItem('fc_user');
        showAuth();
        return;
      }
      // Verify token still valid — splash stays up during this
      try {
        const res = await fetch('/api/auth/me', {
          headers: { 'X-Session-Token': State.token }
        });
        if (res.ok) {
          const fresh = await res.json();
          State.user = fresh;
          State.save();
          // Hand the freshly-fetched PIN flags to pin.js so its gate
          // decisions don't need a second roundtrip.
          try { if (window.Pin) Pin.adoptFromMe(fresh); } catch {}
          // Privacy PIN: when the user has enabled "Require PIN after
          // auto-login", block the launch behind the lock screen. The
          // promise resolves true once the correct PIN is entered (or
          // immediately if the gate is off / not configured).
          try {
            if (window.Pin && typeof Pin.gateAutoLogin === 'function') {
              hideSplash();
              const ok = await Pin.gateAutoLogin();
              if (!ok) { showAuth(); return; }
              try { await this.launch(); } catch (e) { console.error('[App] launch failed', e); }
              return;
            }
          } catch {}
          // Hide splash early so a thrown error inside launch() doesn't leave it stuck
          hideSplash();
          try { await this.launch(); } catch (e) { console.error('[App] launch failed', e); }
          return;
        }
      } catch {
        // Network error at boot — show the connection-lost overlay instead of
        // silently kicking the user back to auth. Once the server is reachable
        // again, the retry button / auto-retry will reload the app.
        hideSplash();
        if (typeof ConnErr !== 'undefined') {
          ConnErr.show(navigator.onLine ? 'server' : 'offline');
        }
        return;
      }
      State.clear();
    }

    // No token or token invalid — show auth
    showAuth();

    // Show invite notice if pending
    if (this.pendingInvite) {
      this.showInviteNotice();
      // Flip the auth form to "Register" when we arrived from the
      // "Create a new account" button on the invite landing page.
      if (this.pendingRegisterMode && typeof switchAuthTab === 'function') {
        try { switchAuthTab('register'); } catch {}
      }
    }
  },

  async showInviteNotice() {
    try {
      const res = await fetch(`/api/invites/${this.pendingInvite}`);
      if (res.ok) {
        const data = await res.json();
        const notice = document.createElement('div');
        notice.className = 'invite-notice';
        const rawIcon = data.room_icon || '💬';
        const isImg = typeof rawIcon === 'string' && (
          rawIcon.startsWith('data:image') ||
          rawIcon.startsWith('http://') ||
          rawIcon.startsWith('https://') ||
          rawIcon.startsWith('/')
        );
        const iconHtml = isImg
          ? `<img src="${UI.escHtml(rawIcon)}" alt="" style="width:48px;height:48px;border-radius:12px;object-fit:cover;display:block;margin:0 auto 8px">`
          : `<div style="font-size:32px;margin-bottom:8px;line-height:1">${UI.escHtml(rawIcon)}</div>`;
        notice.innerHTML = `
          <div style="background:#1a3a1a;border:1px solid #4caf50;border-radius:12px;padding:16px;margin-bottom:16px;text-align:center">
            ${iconHtml}
            <div style="font-weight:600;color:#4caf50">You're invited to #${UI.escHtml(data.room_name)}</div>
            <div style="color:#888;font-size:13px;margin-top:4px">Login or register to join!</div>
          </div>
        `;
        const authBox = document.querySelector('.auth-box');
        if (authBox) authBox.insertBefore(notice, authBox.firstChild);
      }
    } catch {}
  },

  async launch() {
    const pendingReturn = (this.pendingReturn || '').trim();
    if (pendingReturn) {
      this.pendingReturn = null;
      try {
        if (window.Pin && typeof Pin.gateAdmin === 'function') {
          const ok = await Pin.gateAdmin();
          if (!ok) return;
        }
      } catch {}
      window.location.assign(pendingReturn);
      return;
    }

    document.getElementById('auth-overlay').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    try { window.__ftApplyMiniBoardGuestMode && window.__ftApplyMiniBoardGuestMode(); } catch {}

    // Apply saved theme
    const savedThemeRaw = State.user?.theme || localStorage.getItem('frogtalk-theme') || 'frog';
    const savedTheme = (String(savedThemeRaw || '').toLowerCase() === 'dark') ? 'frog' : savedThemeRaw;
    if (typeof applyTheme === 'function') applyTheme(savedTheme);

    // Rehydrate profile fields (status_msg, presence) from this node — not
    // only the fc_user cache which can be stale after SW/cache bumps.
    try {
      if (UI.refreshSelfProfileFromServer) await UI.refreshSelfProfileFromServer({ force: true });
    } catch {}

    // Populate self panel
    const u = State.user;
    UI.setSelfNameAndHandle();
    const sa = document.getElementById('self-avatar-el');
    sa.innerHTML = UI.avatarEl(u.avatar, u.nickname, 36);
    this.bindEasterEggTriggers();
    // Render presence + status msg under the name
    try { UI.renderSelfStatus && UI.renderSelfStatus(); } catch {}

    // Reveal the Node Admin shortcut on the server strip for accounts
    // flagged is_admin=true (typically the node operator, e.g. "frog").
    // The element ships hidden so non-admins never see it.
    try {
      const showAdmin = !!(u && u.is_admin);
      // Main server strip
      const adminIcon = document.getElementById('node-admin-icon');
      if (adminIcon) adminIcon.style.display = showAdmin ? '' : 'none';
      // FrogSocial side menu
      const socialAdminIcon = document.getElementById('social-admin-icon');
      if (socialAdminIcon) socialAdminIcon.style.display = showAdmin ? '' : 'none';
      // FrogChannel (board overlay) side menu
      const boardSideAdminIcon = document.getElementById('board-side-admin-icon');
      if (boardSideAdminIcon) boardSideAdminIcon.style.display = showAdmin ? '' : 'none';
    } catch {}

    // Build emoji picker
    buildEmojiPicker();

    // Signal Protocol bootstrap. `Signal.init` is idempotent and only
    // touches IndexedDB; the heavier bundle publish (signed prekey +
    // OTPK top-up + POST /api/signal/bundle) is fired-and-forgotten so
    // we don't block the UI. Without this, the first DM/room send on a
    // fresh login fails with "Encryption layer not ready" because the
    // only other call site is a lazy init buried in the v2-receive
    // path.
    try {
      if (window.Signal && typeof Signal.init === 'function' && State.user && State.user.id) {
        Signal.init(State.user.id)
          .then(() => {
            if (typeof Signal.ensureMyBundleFresh === 'function') {
              return Signal.ensureMyBundleFresh();
            }
          })
          .catch(e => console.warn('[Signal] boot init failed', e));
      }
    } catch (e) { console.warn('[Signal] boot init threw', e); }

    // Show a loading UI in the messages area & channel title immediately so
    // we don't flash the "Welcome to FrogTalk" default header before the
    // last channel has a chance to open. This is cleared by switchToRoom()
    // or replaced by showEmptyOnboarding() if the user truly has no rooms.
    App.showChannelLoading();
    try {
      if (typeof ConnErr !== 'undefined' && ConnErr.armBootGrace) {
        ConnErr.armBootGrace(18000);
      }
    } catch {}

    // Rooms must load before call recovery or signaling bootstrap (joined-room WS).
    const justSwitchedNode = this.consumeJustSwitchedNodeFlag()
      || (new URLSearchParams(window.location.search).get('switched') === '1');
    try {
      await Rooms.loadRooms();
    } catch (e) {
      console.warn('[App] loadRooms failed', e);
      try { State.rooms = []; } catch {}
    }
    const syncApplied = await this.waitForFederationSyncIfNeeded();
    if (syncApplied) {
      try { await Rooms.loadRooms(); } catch {}
    }

    // Cold-boot from FCM: recover the offer before the permissions wizard can block Accept.
    if (this.pendingIncomingCall) {
      const restored = await this.ensureIncomingCallPipeline(this.pendingIncomingCall);
      if (restored) this.pendingIncomingCall = null;
    } else {
      await this.recoverLatestIncomingCall();
    }

    // Browser notification prompt is useful on web/desktop only.
    // (Android first-run setup + permissions live in mobile_node_setup.html.)
    if (!window.Android) Notifications.requestPermission();

    // Android native push: register/sync FCM token against this account.
    try {
      this.forceAndroidFcmResync(State.token);
    } catch {}

    // Process pending invite / share link
    if (this.pendingInvite) {
      await this.handleInvite(this.pendingInvite);
      this.pendingInvite = null;
    } else if (this.pendingRoom) {
      // Share link: /c/{room} — public rooms can open/join; private needs /i/<invite>.
      const roomName = this.pendingRoom;
      this.pendingRoom = null;
      let listed = (State.rooms || []).find(x => x.name === roomName);
      let roomType = listed?.type;
      let chType = listed?.channel_type || 'text';
      if (!listed) {
        try {
          const metaRes = await apiFetch(`/api/rooms/${encodeURIComponent(roomName)}`);
          if (metaRes.ok) {
            const meta = await metaRes.json();
            roomType = meta.room?.type || 'public';
            chType = meta.room?.channel_type || 'text';
          } else if (metaRes.status === 404) {
            UI.showToast(`#${roomName} was not found`, 'error');
            await App.openFirstAvailableRoomWhenIdle();
            return;
          }
        } catch {}
      }
      roomType = roomType || 'public';
      if (listed?.joined) {
        Rooms.switchToRoom(roomName, roomType, null, chType);
      } else if (roomType === 'private') {
        UI.showToast(`#${roomName} is private — ask the owner for an invite link (/i/…)`, 'warning');
        await App.openFirstAvailableRoomWhenIdle();
      } else {
        try {
          const jr = await apiFetch(`/api/rooms/${encodeURIComponent(roomName)}/join`, 'POST');
          if (jr.ok) {
            await Rooms.loadRooms();
            const fresh = (State.rooms || []).find(x => x.name === roomName);
            Rooms.switchToRoom(roomName, fresh?.type || 'public', null, fresh?.channel_type || chType);
          } else {
            const err = await jr.json().catch(() => ({}));
            UI.showToast(err.error || `Couldn't join #${roomName}`, 'error');
            await App.openFirstAvailableRoomWhenIdle();
          }
        } catch {
          await App.openFirstAvailableRoomWhenIdle();
        }
      }
    } else if (this.pendingDM && String(this.pendingDM).trim()) {
      // Share link: /u/{nick} "Send a message" -> open DM with that user
      if (typeof openDMWithNick === 'function') {
        try { openDMWithNick(this.pendingDM); } catch {}
      } else {
        await App.openFirstAvailableRoomWhenIdle();
      }
      this.pendingDM = null;
    } else if (this.pendingReel) {
      // Share link: /r/{id} or /?reel={id} — open FrogSocial reels and focus target reel.
      await App.openFirstAvailableRoomWhenIdle();
      const reelId = Number(this.pendingReel);
      this.pendingReel = null;
      const tryOpenReel = (attempts) => {
        try {
          if (typeof Social !== 'undefined' && Social.open) {
            Social.open('reels');
          }
          if (Number.isFinite(reelId) && reelId > 0 && typeof Social !== 'undefined' && Social.openSharedReel) {
            Social.openSharedReel(reelId);
            return;
          }
        } catch (e) {
          console.error('[App] open shared reel failed', e);
        }
        if (attempts > 0) setTimeout(() => tryOpenReel(attempts - 1), 120);
      };
      tryOpenReel(60);
    } else if (this.pendingPost) {
      // Share link: /p/{id} or /?post={id} — open FrogSocial post detail.
      await App.openFirstAvailableRoomWhenIdle();
      const postId = Number(this.pendingPost);
      this.pendingPost = null;
      const tryOpenPost = (attempts) => {
        try {
          if (Number.isFinite(postId) && postId > 0 && typeof Social !== 'undefined' && Social.open && Social.viewPostDetail) {
            Social.open('feed');
            setTimeout(() => {
              try { Social.viewPostDetail(postId); } catch {}
            }, 60);
            return;
          }
        } catch (e) {
          console.error('[App] open shared post failed', e);
        }
        if (attempts > 0) setTimeout(() => tryOpenPost(attempts - 1), 120);
      };
      tryOpenPost(16);
    } else if (this.pendingProfile) {
      // Share link: /?profile={nick} — open the polished FrogSocial profile
      // view. Falls back to the legacy user-info modal if Social isn't loaded.
      await App.openFirstAvailableRoomWhenIdle();
      const nick = this.pendingProfile;
      this.pendingProfile = null;
      // Retry briefly — on slow boots Social may not be attached to window
      // by the time launch() runs (script ordering vs. deferred parsing
      // in some packaged builds). Poll for up to ~2s before giving up.
      const tryOpen = (attempts) => {
        try {
          if (typeof Social !== 'undefined' && Social.openProfile) {
            Social.openProfile(nick);
            return;
          }
        } catch (e) {
          console.error('[App] open shared profile failed', e);
        }
        if (attempts > 0) {
          setTimeout(() => tryOpen(attempts - 1), 120);
        } else if (typeof showUserInfo === 'function') {
          try { showUserInfo(nick); } catch {}
        }
      };
      tryOpen(16);
    } else {
      await App.openFirstAvailableRoomWhenIdle();
    }

    if (justSwitchedNode) {
      const joined = (State.rooms || []).filter(r => r.joined);
      const dmPending = typeof loadDMChannels === 'function';
      if (joined.length === 0) {
        try { App.showNodeSwitchOnboarding(); } catch {}
      }
      try {
        UI.showToast(
          joined.length
            ? 'Connected to this node — federation sync finished for your account.'
            : 'Connected to this node. If this is your first hop, federation sync may still be importing your channels and DMs.',
          'info',
          9000
        );
      } catch {}
      try {
        window.history.replaceState({}, '', window.location.pathname);
      } catch {}
    }

    // Load DM channels sidebar
    if (typeof loadDMChannels === 'function') loadDMChannels();
    if (justSwitchedNode || (this.federationSyncState && this.federationSyncState.in_progress)) {
      this.startFederationSyncWatcher();
    }

    // Load friends (for badge count)
    if (typeof loadFriends === 'function') loadFriends();

    // Fetch social activity unread count for the 🤳🏼 sidebar badge
    if (typeof Social !== 'undefined' && Social.refreshActivityBadge) {
      try { Social.refreshActivityBadge(); } catch {}
    }

    // Refresh blocked-users cache so rooms/DMs/feed filters take effect
    if (typeof refreshBlockedCache === 'function') refreshBlockedCache();

    // Track H cleanup: the legacy /api/users/pubkey publish/fetch flow was
    // retired with v1 DM crypto. Signal Protocol bundle publication is
    // handled by Signal.ensureMyBundleFresh() during init; no per-login
    // ECDH key sync is needed any more.

    // Recover pending story uploads (if app was closed during upload)
    if (typeof Social !== 'undefined' && Social._initUploadRecovery) {
      try { Social._initUploadRecovery(); } catch {}
    }
  },

  bindEasterEggTriggers() {
    const bindTap = (el, key = 'easterBound') => {
      if (!el || el.dataset[key]) return;
      el.dataset[key] = '1';
      let lastTapTs = 0;
      const handler = () => {
        const now = Date.now();
        if (now - lastTapTs < 320) return;
        lastTapTs = now;
        this.trackEasterTap();
      };
      el.addEventListener('click', handler);
      el.addEventListener('touchend', handler, { passive: true });
    };

    ['server-label', 'self-avatar-el', 'home-frog-icon'].forEach((id) => {
      const el = document.getElementById(id);
      bindTap(el);
    });

    document.querySelectorAll('.social-menu-btn').forEach((el) => {
      bindTap(el);
    });
  },

  trackEasterTap() {
    this.easterTapCount += 1;
    clearTimeout(this.easterTapTimer);
    this.easterTapTimer = setTimeout(() => { this.easterTapCount = 0; }, 2600);
    if (this.easterTapCount < 7) return;
    this.easterTapCount = 0;
    this.openNodeEasterEgg();
  },

  closeNodeEasterEgg() {
    document.getElementById('ft-node-easter-overlay')?.remove();
  },

  async fetchNodeEasterEgg(force = false) {
    if (this.easterEgg && !force) return this.easterEgg;
    try {
      const res = await fetch('/api/server/easter-egg');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return null;
      this.easterEgg = data;
      return data;
    } catch {
      return null;
    }
  },

  async openNodeEasterEgg() {
    const payload = await this.fetchNodeEasterEgg(true);
    if (!payload?.enabled || !payload?.html) {
      try { UI.showToast('No hidden node popup configured here yet', 'info'); } catch {}
      return;
    }
    this.closeNodeEasterEgg();
    const overlay = document.createElement('div');
    overlay.id = 'ft-node-easter-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:14060;background:rgba(3,7,5,.76);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:18px';
    overlay.innerHTML = `
      <div style="width:min(760px,96vw);max-height:min(86vh,860px);overflow:auto;border-radius:24px;border:1px solid rgba(86,209,109,.26);background:linear-gradient(165deg,rgba(10,19,14,.98),rgba(7,10,8,.98));box-shadow:0 34px 100px rgba(0,0,0,.58);position:relative;padding:22px;">
        <button type="button" id="ft-node-easter-close" style="position:absolute;top:14px;right:14px;border:none;background:#102016;color:#dcebe0;width:38px;height:38px;border-radius:12px;cursor:pointer;font-size:18px">✕</button>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
          <div style="width:56px;height:56px;border-radius:18px;background:linear-gradient(135deg,#1b4329,#0c170f);display:flex;align-items:center;justify-content:center;font-size:28px;">🐸</div>
          <div>
            <div style="font-size:24px;font-weight:800;color:#f1fff5">${UI.escHtml(payload.title || 'Frog signal')}</div>
            <div style="font-size:12px;color:#95b39e">Hidden node message</div>
          </div>
        </div>
        <div style="color:#dfede3;line-height:1.72" class="easter-preview-body">${payload.html}</div>
      </div>
    `;
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) this.closeNodeEasterEgg();
    });
    document.body.appendChild(overlay);
    overlay.querySelector('#ft-node-easter-close')?.addEventListener('click', () => this.closeNodeEasterEgg());
  },

  /**
   * Android warm-tap on incoming-call notification (activity already running).
   * Fetches pending offer via REST, opens the DM thread, shows #incoming-call.
   */
  async recoverIncomingCallFromNative(pending) {
    const callId = String(pending?.callId || '').trim().replace(/\D/g, '');
    const peerNick = String(pending?.peerNick || '').trim().slice(0, 64);
    if (!callId && !peerNick) return false;
    if (!State.token) {
      this.setPendingIncomingCall({ callId, peerNick, action: '' });
      return false;
    }
    try {
      const payload = { callId, peerNick, action: '' };
      this.setPendingIncomingCall(payload);
      return await this.ensureIncomingCallPipeline(payload);
    } catch (e) {
      console.warn('[App] recoverIncomingCallFromNative failed', e);
      return false;
    }
  },

  async ensureIncomingCallPipeline(pending) {
    const callId = String(pending?.callId || '').trim().replace(/\D/g, '');
    const peerNick = String(pending?.peerNick || '').trim().slice(0, 64);
    if (!callId && !peerNick) return false;
    if (!State.token) {
      this.setPendingIncomingCall({ callId, peerNick, action: '' });
      return false;
    }
    try { document.body.classList.remove('in-welcome'); } catch {}
    try {
      if (typeof ensureCallSignalingReady === 'function') {
        const wsReady = await ensureCallSignalingReady({ timeoutMs: 15000 });
        if (!wsReady) return false;
      }
      if (typeof ensureIncomingCallSurfaceVisible === 'function' &&
          ensureIncomingCallSurfaceVisible()) {
        if (typeof isCallSignalingReady === 'function' && !isCallSignalingReady()) {
          return false;
        }
        if (peerNick && typeof openDMWithNick === 'function') {
          void openDMWithNick(peerNick).catch(() => {});
        }
        return true;
      }
      let ok = false;
      if (callId) ok = await this.recoverIncomingCall({ callId, peerNick, action: '' }, { skipSignalReady: true });
      if (!ok) ok = await this.recoverLatestIncomingCall({ silent: true, peerNick, skipSignalReady: true });
      if (!ok && typeof ensureIncomingCallSurfaceVisible === 'function') {
        ok = ensureIncomingCallSurfaceVisible();
        if (ok && typeof isCallSignalingReady === 'function' && !isCallSignalingReady()) ok = false;
      }
      return ok;
    } catch (e) {
      console.warn('[App] ensureIncomingCallPipeline failed', e);
      return false;
    }
  },

  async recoverIncomingCall(pending, opts) {
    const callId = String(pending?.callId || '').trim();
    if (!callId || !State.token) return false;
    try {
      if (opts?.requireSignalReady && typeof ensureCallSignalingReady === 'function') {
        const wsReady = await ensureCallSignalingReady({ timeoutMs: 15000 });
        if (!wsReady) return false;
      }
      const peerNick = String(pending?.peerNick || '').trim();
      if (peerNick && typeof openDMWithNick === 'function') {
        void openDMWithNick(peerNick).catch(() => {});
      }
      const res = await fetch(`/api/calls/${encodeURIComponent(callId)}/pending`, {
        headers: { 'X-Session-Token': State.token }
      });
      if (!res.ok) {
        if (res.status === 404 || res.status === 409) {
          this.clearPendingIncomingCall();
          if (typeof clearStaleIncomingCallUi === 'function') {
            clearStaleIncomingCallUi(res.status === 404 ? 'gone' : 'ended');
          }
        }
        return false;
      }
      const offer = await res.json();
      if (!offer?.from_nickname && peerNick) {
        offer.from_nickname = peerNick;
      }
      if (typeof handleCallOffer === 'function') {
        await handleCallOffer(offer);
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[App] recover incoming call failed', e);
      return false;
    }
  },

  async recoverLatestIncomingCall(opts) {
    if (!State.token) return false;
    try {
      if (opts?.requireSignalReady && typeof ensureCallSignalingReady === 'function') {
        const wsReady = await ensureCallSignalingReady({ timeoutMs: 15000 });
        if (!wsReady) return false;
      }
      if (typeof ensureIncomingCallSurfaceVisible === 'function' && ensureIncomingCallSurfaceVisible()) {
        return true;
      }
      if (typeof _callState !== 'undefined' && (_callState === 'calling' || _callState === 'active')) return false;
      if (typeof isIncomingCallActive === 'function' && isIncomingCallActive()) return false;
      const res = await fetch('/api/calls/pending-latest', {
        headers: { 'X-Session-Token': State.token }
      });
      if (!res.ok) return false;
      const offer = await res.json();
      const peerNick = String(offer?.from_nickname || opts?.peerNick || '').trim();
      if (offer?.call_id) {
        this.setPendingIncomingCall({
          callId: String(offer.call_id),
          peerNick,
        });
      }
      if (peerNick && typeof openDMWithNick === 'function') {
        void openDMWithNick(peerNick).catch(() => {});
      }
      if (typeof handleCallOffer === 'function') {
        await handleCallOffer(offer);
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[App] recover latest incoming call failed', e);
      return false;
    }
  },

  async handleInvite(code) {
    try {
      // Join via invite
      const res = await apiFetch(`/api/invites/${code}/join`, 'POST');
      if (res.ok) {
        const data = await res.json();
        await Rooms.loadRooms();
        const joined = (State.rooms || []).find(r => r.name === data.room);
        const roomType = joined?.type || data.room_type || 'public';
        const chType = joined?.channel_type || 'text';
        if (roomType === 'private') {
          const ok = await Rooms.ensurePrivateRoomSecret(data.room);
          if (!ok) {
            await App.openFirstAvailableRoomWhenIdle();
            return;
          }
        }
        UI.showToast(`Joined #${data.room}!`, 'success');
        Rooms.switchToRoom(data.room, roomType, null, chType);
      } else {
        const err = await res.json().catch(() => ({}));
        // Banned-from-channel: render the dedicated ban screen so the
        // user sees reason + duration, not a vague disconnect modal.
        if (err && err.code === 'room_banned' && typeof window.showRoomBannedScreen === 'function') {
          window.showRoomBannedScreen(err);
        } else {
          UI.showToast(err.error || 'Failed to join', 'error');
        }
        await App.openFirstAvailableRoomWhenIdle();
      }
    } catch (e) {
      UI.showToast('Failed to process invite', 'error');
          await App.openFirstAvailableRoomWhenIdle();
    }
  },

  /**
   * Pick the first joined room and switch to it. If the user has no rooms yet
   * (fresh signup with no invite), show the onboarding/empty state instead of
   * falling back to a non-existent "general" channel.
   */
  async openFirstAvailableRoomWhenIdle(maxWaitMs = 90000) {
    const busy = () => {
      try {
        if (typeof window.isCallSessionBusy === 'function') return window.isCallSessionBusy();
      } catch {}
      return false;
    };
    let waited = 0;
    while (busy() && waited < maxWaitMs) {
      await new Promise(r => setTimeout(r, 250));
      waited += 250;
    }
    this.openFirstAvailableRoom();
  },

  _setLoadingSyncHint(text) {
    const el = document.getElementById('ch-loading-sync-hint');
    if (!el) return;
    const msg = String(text || '').trim();
    if (!msg) {
      el.textContent = '';
      el.style.display = 'none';
      return;
    }
    el.textContent = msg;
    el.style.display = '';
  },

  _emitFederationSyncEvent(state) {
    try {
      const payload = state && typeof state === 'object' ? state : {};
      window.__ftFederationSync = payload;
      window.dispatchEvent(new CustomEvent('ft:federation-sync', { detail: payload }));
    } catch {}
  },

  _renderGlobalSyncChip(state) {
    const inProgress = !!(state && state.in_progress);
    let chip = document.getElementById('ft-sync-chip');
    if (!inProgress) {
      if (chip) chip.remove();
      return;
    }
    const hint = String(state.hint || this.federationSyncHint || 'Syncing node data…').trim();
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'ft-sync-chip';
      chip.style.cssText = 'position:fixed;right:14px;top:14px;z-index:12050;background:rgba(11,18,14,.86);border:1px solid rgba(126,207,163,.32);color:#b7d9c3;padding:6px 10px;border-radius:999px;font-size:12px;backdrop-filter:blur(8px);box-shadow:0 8px 24px rgba(0,0,0,.35);pointer-events:none;';
      document.body.appendChild(chip);
    }
    chip.textContent = hint;
  },

  _applyFederationSyncUiState(state) {
    const payload = (state && typeof state === 'object') ? state : {};
    this.federationSyncState = payload;
    if (payload.hint) this.federationSyncHint = String(payload.hint || '');
    this._setLoadingSyncHint(payload.in_progress ? (payload.hint || this.federationSyncHint) : '');
    this._renderGlobalSyncChip(payload);
    this._emitFederationSyncEvent(payload);
  },

  startFederationSyncWatcher(maxWatchMs = 180000) {
    if (!State.token) return;
    const started = Date.now();
    if (this._syncWatcherTimer) {
      try { clearTimeout(this._syncWatcherTimer); } catch {}
      this._syncWatcherTimer = null;
    }
    const tick = async () => {
      try {
        const res = await fetch('/api/auth/federation-sync-status', {
          headers: { 'X-Session-Token': State.token },
        });
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        this._applyFederationSyncUiState(data || {});
        if (data && data.done && !data.in_progress) return;
      } catch {}
      if ((Date.now() - started) >= maxWatchMs) return;
      this._syncWatcherTimer = setTimeout(tick, 2200);
    };
    this._syncWatcherTimer = setTimeout(tick, 300);
  },

  async waitForFederationSyncIfNeeded(maxWaitMs = 22000) {
    if (!State.token) return false;
    const started = Date.now();
    let sawInProgress = false;
    let applied = false;
    while ((Date.now() - started) < maxWaitMs) {
      try {
        const res = await fetch('/api/auth/federation-sync-status', {
          headers: { 'X-Session-Token': State.token },
        });
        if (!res.ok) break;
        const data = await res.json().catch(() => ({}));
        const inProgress = !!data.in_progress;
        const done = !!data.done;
        const hint = String(data.hint || this.federationSyncHint || '').trim();
        this._applyFederationSyncUiState(data || {});
        if (inProgress) {
          sawInProgress = true;
          this._setLoadingSyncHint(hint || 'Syncing channels and DMs from your home node…');
          await new Promise((r) => setTimeout(r, 900));
          continue;
        }
        this._setLoadingSyncHint('');
        if (done) {
          const joined = Number(data.rooms_joined || 0);
          const dms = Number(data.dm_linked || 0);
          applied = joined > 0 || dms > 0;
          if (sawInProgress && applied && typeof UI !== 'undefined' && UI.showToast) {
            const parts = [];
            if (joined > 0) parts.push(`${joined} channels`);
            if (dms > 0) parts.push(`${dms} DMs`);
            UI.showToast(`Synced ${parts.join(' and ')} from federation`, 'info', 3600);
          }
        }
        break;
      } catch {
        break;
      }
    }
    this._setLoadingSyncHint('');
    if (!applied) this.startFederationSyncWatcher();
    return applied;
  },

  openFirstAvailableRoom() {
    try {
      const rooms = (typeof State !== 'undefined' && Array.isArray(State.rooms)) ? State.rooms : [];
      const joined = rooms.filter(r => r.joined);
      // Prefer the last channel the user had open — persisted by
      // Rooms.switchToRoom. Only use it if it's still in the joined list.
      let target = null;
      try {
        const lastRaw = localStorage.getItem('fc_last_room');
        if (lastRaw) {
          const last = JSON.parse(lastRaw);
          if (last && last.name && last.type !== 'dm') {
            target = joined.find(r => r.name === last.name) || null;
          }
        }
      } catch {}
      if (!target) target = joined[0] || null;
      if (target) {
        const type = (target.channel_type === 'voice') ? 'music' : (target.channel_type || 'public');
        Rooms.switchToRoom(target.name, type);
        return;
      }
    } catch {}
    App.showEmptyOnboarding();
  },

  /**
   * Transient loading state shown between app launch and the first
   * switchToRoom() — prevents the default "Welcome to FrogTalk" header
   * from flashing while rooms are still loading.
   */
  showChannelLoading() {
    // Don't overwrite a real channel if one is already active.
    if (State && State.currentRoom) return;
    const area = document.getElementById('messages-area');
    if (area) {
      area.innerHTML = `
        <div class="ch-loading-state">
          <div class="ch-spin" aria-hidden="true"></div>
          <div>Loading your channels…</div>
          <div id="ch-loading-sync-hint" style="display:none;color:#8da59b;font-size:12px;margin-top:6px"></div>
        </div>`;
    }
    const titleEl = document.getElementById('ch-title');
    if (titleEl) {
      titleEl.innerHTML = '<span class="room-title-text" style="color:#888">Loading\u2026</span>';
    }
    // Ensure the welcome-only CSS flag is not set during the load.
    document.body.classList.remove('in-welcome');
    if (this.federationSyncHint) {
      this._setLoadingSyncHint(this.federationSyncHint);
    }
  },

  /** Welcome / empty state for users with no channels yet. */
  showEmptyOnboarding() {
    const area = document.getElementById('messages-area');
    if (!area) return;
    // Clear any active room state so UI doesn't show stale header / members.
    try {
      State.currentRoom = null;
      State.currentRoomOwner = null;
      State.currentRoomType = null;
    } catch {}
    // Replace the transient "Loading…" header set by showChannelLoading()
    // with a friendly empty-state title + subtitle. New users with zero
    // channels otherwise sit on "Loading…" forever.
    const titleEl = document.getElementById('ch-title');
    if (titleEl) {
      titleEl.innerHTML =
        '<span class="room-title-icon">🐸</span>' +
        '<span class="room-title-text">Welcome to FrogTalk</span>';
    }
    const descEl = document.getElementById('ch-desc');
    if (descEl) descEl.textContent = 'Join a channel or send a DM to get started';
    document.querySelectorAll('#public-channels .channel-item.active').forEach(el => el.classList.remove('active'));

    // This is an intro screen, not a real channel — flag the body so CSS can
    // hide chat chrome (composer, typing indicator, encryption banner,
    // members panel, voice-presence strip). Cleared on switchToRoom.
    document.body.classList.add('in-welcome');
    area.innerHTML = `
      <div class="welcome-hero fade-in">
        <div class="welcome-glow"></div>
        <h2 class="welcome-title">Welcome to FrogTalk</h2>
        <p class="welcome-sub">
          End-to-end encrypted chat and private messaging, plus transport-secure voice &amp; video.
          Get started by creating a channel, discovering public ones, or adding a friend.
        </p>
        <div class="welcome-actions">
          <button class="welcome-btn primary" onclick="Rooms.showCreateRoom()">
            <span class="welcome-btn-ic">➕</span>
            <span class="welcome-btn-label">
              <span class="welcome-btn-title">Create a channel</span>
              <span class="welcome-btn-sub">Make your own space</span>
            </span>
          </button>
          <button class="welcome-btn" onclick="showChannelDirectory()">
            <span class="welcome-btn-ic">🔍</span>
            <span class="welcome-btn-label">
              <span class="welcome-btn-title">Browse directory</span>
              <span class="welcome-btn-sub">Find public channels</span>
            </span>
          </button>
          <button class="welcome-btn" onclick="(function(){try{if(typeof openFriends==='function'){openFriends();if(typeof switchFriendTab==='function')setTimeout(()=>switchFriendTab('add'),60);}}catch(e){}})()">
            <span class="welcome-btn-ic">➕</span>
            <span class="welcome-btn-label">
              <span class="welcome-btn-title">Add a friend</span>
              <span class="welcome-btn-sub">Search &amp; send a request</span>
            </span>
          </button>
          <button class="welcome-btn" onclick="Social.open('explore')">
            <span class="welcome-btn-ic">🌐</span>
            <span class="welcome-btn-label">
              <span class="welcome-btn-title">Open Frog Social</span>
              <span class="welcome-btn-sub">Wall, media &amp; music</span>
            </span>
          </button>
        </div>
        <p class="welcome-tip">
          Tip: invite links from other users will drop you straight into their channel.
        </p>
      </div>`;
  }
};

// Boot on DOM ready
document.addEventListener('DOMContentLoaded', () => App.init());

// ===========================================================================
// Active devices dialog — shown after login when other sessions exist.
// Lists each other session with country flag, city, browser/OS, last-active
// time, and a per-row "Log out" button. Returns once user clicks Continue.
// ===========================================================================
function _activeDev_codeToFlag(cc) {
  cc = String(cc || '').toUpperCase();
  if (cc.length !== 2 || !/^[A-Z]{2}$/.test(cc)) return '🌐';
  return [...cc].map(c => String.fromCodePoint(0x1F1A5 + c.charCodeAt(0))).join('');
}
function _activeDev_parseUA(ua) {
  ua = String(ua || '');
  let browser = 'Unknown browser', os = 'Unknown OS';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(ua)) os = 'iOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return browser + ' on ' + os;
}
function _activeDev_relTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!t || isNaN(t)) return '';
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff/60) + ' min ago';
  if (diff < 86400) return Math.floor(diff/3600) + ' hr ago';
  return Math.floor(diff/86400) + ' d ago';
}
function _activeDev_esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

async function showActiveDevicesDialog(opts) {
  opts = opts || {};
  let sessions = [];
  try {
    const r = await apiFetch('/api/auth/sessions');
    if (r && r.ok) {
      const d = await r.json();
      sessions = (d.sessions || []).filter(s => !s.is_current);
    }
  } catch (e) { /* network — fall through, show takeover-only message */ }

  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop ui-notice-backdrop active-devices-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;animation:adFade .18s ease-out;';

    // Inject keyframes once
    if (!document.getElementById('active-devices-anim')) {
      const st = document.createElement('style');
      st.id = 'active-devices-anim';
      st.textContent = '@keyframes adFade{from{opacity:0}to{opacity:1}}@keyframes adPop{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}';
      document.head.appendChild(st);
    }

    const card = document.createElement('div');
    // Match the app's signature green-tinted modal look (see index.html
    // server-info / about modals): subtle dark-green vertical gradient with
    // an accent-green border. This makes the active-devices dialog feel
    // native to FrogTalk instead of a neutral grey popover.
    card.style.cssText = 'background:linear-gradient(180deg,#173027 0%,#13271f 56%,#102018 100%);color:var(--text-color,#e9ecf3);border:1px solid #3b6c59;border-radius:12px;max-width:540px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 46px rgba(0,0,0,.58),inset 0 1px 0 rgba(255,255,255,.08),0 0 0 1px rgba(76,175,80,.1);overflow:hidden;font:14px/1.45 var(--font-family,system-ui),-apple-system,Segoe UI,Roboto,sans-serif;animation:adPop .22s cubic-bezier(.2,.7,.3,1);position:relative;';

    const headerTitle = opts.takeover
      ? 'Another device is signed in'
      : 'Your active devices';
    const headerNote = opts.takeover
      ? "FrogTalk uses one encryption key per device. We'll switch DMs to this device after you continue. Don't recognise something below? Sign it out first."
      : 'These devices are currently signed in to your account.';

    let rowsHtml = '';
    if (!sessions.length) {
      rowsHtml = '<div style="padding:22px 18px;text-align:center;color:#a8c9b8;font-size:13px;">No other devices are signed in.</div>';
    } else {
      rowsHtml = sessions.map(s => {
        const isLegacy = !!s.legacy;
        const flag = isLegacy ? '📱' : _activeDev_codeToFlag(s.country_code);
        const place = isLegacy
          ? 'Sign in again on that device to refresh its details'
          : ([s.city, s.country].filter(Boolean).join(', ') || (s.ip_address || 'Location unknown'));
        const dev = isLegacy ? 'Older session (pre-update)' : _activeDev_parseUA(s.user_agent);
        const last = _activeDev_relTime(s.last_active) || _activeDev_relTime(s.created_at);
        const ip = (!isLegacy && s.ip_address) ? _activeDev_esc(s.ip_address) : '';
        return `<div class="ad-row" data-id="${_activeDev_esc(s.id)}" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(59,108,89,.35);transition:background .15s;">
          <div style="font-size:24px;line-height:1;width:36px;text-align:center;flex-shrink:0;filter:${isLegacy?'grayscale(.4) opacity(.85)':'none'};">${flag}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;color:#dff5e8;font-size:13.5px;">${_activeDev_esc(dev)}</div>
            <div style="color:#a8c9b8;font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_activeDev_esc(place)}${ip ? ' · ' + ip : ''}</div>
            <div style="color:#7fa492;font-size:11px;margin-top:2px;opacity:.85;">${_activeDev_esc(last || 'unknown')}</div>
          </div>
          <button class="ad-revoke" type="button" style="background:rgba(15,30,24,.55);color:#b8d5c8;border:1px solid #2f594a;padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer;font-weight:600;flex-shrink:0;transition:all .15s;">Sign out</button>
        </div>`;
      }).join('');
    }

    const footerActions = sessions.length > 1
      ? `<button class="ad-revoke-all" type="button" style="background:rgba(15,30,24,.55);color:#b8d5c8;border:1px solid #2f594a;padding:9px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;margin-right:auto;transition:all .15s;">Sign out of all</button>`
      : '';

    card.innerHTML = `
      <div style="height:3px;background:linear-gradient(90deg,transparent,#4caf50,transparent);opacity:.9;"></div>
      <div style="padding:18px 20px 14px;border-bottom:1px solid rgba(59,108,89,.5);display:flex;gap:14px;align-items:flex-start;">
        <div style="font-size:22px;line-height:1;flex-shrink:0;color:#7fd28a;">🔐</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:16px;font-weight:700;color:#dff5e8;letter-spacing:-.1px;">${_activeDev_esc(headerTitle)}</div>
          <div style="color:#a8c9b8;font-size:13px;margin-top:6px;line-height:1.5;">${_activeDev_esc(headerNote)}</div>
        </div>
      </div>
      <div class="ad-list" style="overflow:auto;flex:1;background:linear-gradient(180deg,rgba(13,29,23,.6),rgba(10,22,17,.6));">${rowsHtml}</div>
      <div style="padding:14px 18px;border-top:1px solid rgba(59,108,89,.5);display:flex;justify-content:flex-end;gap:10px;align-items:center;background:linear-gradient(180deg,rgba(16,35,27,.55),rgba(13,29,23,.65));">
        ${footerActions}
        <button class="ad-continue" type="button" style="background:#4caf50;color:#0a1a0d;border:0;padding:9px 22px;border-radius:8px;font-size:13.5px;font-weight:700;cursor:pointer;letter-spacing:.2px;box-shadow:0 4px 14px rgba(76,175,80,.3);transition:all .15s;">Continue</button>
      </div>`;

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    function close() {
      try { backdrop.remove(); } catch {}
      resolve();
    }
    card.querySelector('.ad-continue').addEventListener('click', close);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
    const escHandler = e => { if (e.key === 'Escape') { document.removeEventListener('keydown', escHandler); close(); } };
    document.addEventListener('keydown', escHandler);

    // Hover affordance for revoke buttons
    card.querySelectorAll('.ad-revoke, .ad-revoke-all').forEach(b => {
      b.addEventListener('mouseenter', () => {
        b.style.background = 'rgba(255,90,95,.14)';
        b.style.color = '#ff8b95';
        b.style.borderColor = 'rgba(255,90,95,.5)';
      });
      b.addEventListener('mouseleave', () => {
        if (b.dataset.done) return;
        b.style.background = 'rgba(15,30,24,.55)';
        b.style.color = '#b8d5c8';
        b.style.borderColor = '#2f594a';
      });
    });

    card.querySelectorAll('.ad-revoke').forEach(btn => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.ad-row');
        const id = row && row.dataset.id;
        if (!id) return;
        btn.disabled = true;
        btn.textContent = '…';
        try {
          const r = await apiFetch('/api/auth/sessions/' + encodeURIComponent(id), 'DELETE');
          if (r && r.ok) {
            row.style.opacity = '0.5';
            btn.dataset.done = '1';
            btn.textContent = 'Signed out';
            btn.style.background = 'rgba(76,175,80,.12)';
            btn.style.color = '#7fd28a';
            btn.style.borderColor = 'rgba(76,175,80,.55)';
          } else {
            btn.disabled = false;
            btn.textContent = 'Sign out';
            if (typeof UI !== 'undefined' && UI.showToast) {
              UI.showToast('Could not sign out that device.', 'error', 3000);
            }
          }
        } catch (e) {
          btn.disabled = false;
          btn.textContent = 'Sign out';
        }
      });
    });

    const allBtn = card.querySelector('.ad-revoke-all');
    if (allBtn) {
      allBtn.addEventListener('click', async () => {
        allBtn.disabled = true;
        const orig = allBtn.textContent;
        allBtn.textContent = 'Signing out…';
        try {
          const r = await apiFetch('/api/auth/sessions/revoke-others', 'POST');
          if (r && r.ok) {
            card.querySelectorAll('.ad-row').forEach(row => {
              row.style.opacity = '0.5';
              const b = row.querySelector('.ad-revoke');
              if (b) {
                b.dataset.done = '1';
                b.disabled = true;
                b.textContent = 'Signed out';
                b.style.color = '#7fd28a';
                b.style.borderColor = 'rgba(76,175,80,.55)';
              }
            });
            allBtn.textContent = 'All signed out';
            allBtn.style.color = '#7fd28a';
            allBtn.style.borderColor = 'rgba(76,175,80,.55)';
          } else {
            allBtn.disabled = false;
            allBtn.textContent = orig;
          }
        } catch (e) {
          allBtn.disabled = false;
          allBtn.textContent = orig;
        }
      });
    }
  });
}
window.showActiveDevicesDialog = showActiveDevicesDialog;
