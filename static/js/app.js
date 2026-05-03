/**
 * app.js — Boot, auth check, main app initialization
 */

const App = {
  pendingInvite: null,  // Store invite code to process after login
  PENDING_CALL_KEY: 'ft_pending_incoming_call',
  ASSET_RESET_VERSION: 'reaction-ui-sync-hotfix-v2',
  easterEgg: null,
  easterTapCount: 0,
  easterTapTimer: null,

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
      };
    } catch {
      return null;
    }
  },

  clearPendingIncomingCall() {
    try { localStorage.removeItem(this.PENDING_CALL_KEY); } catch {}
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
        avatar: data.avatar,
        bio: data.bio,
        is_admin: data.is_admin,
      };
      State.save();
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
    if (incomingCall === '1' && pendingCallId) {
      this.pendingIncomingCall = {
        callId: pendingCallId,
        peerNick: pendingPeerNick || '',
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
    document.getElementById('auth-overlay').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    try { window.__ftApplyMiniBoardGuestMode && window.__ftApplyMiniBoardGuestMode(); } catch {}

    // Apply saved theme
    const savedTheme = State.user?.theme || localStorage.getItem('frogtalk-theme') || 'dark';
    if (typeof applyTheme === 'function') applyTheme(savedTheme);

    // Populate self panel
    const u = State.user;
    document.getElementById('self-name').textContent = u.nickname;
    const sa = document.getElementById('self-avatar-el');
    sa.innerHTML = UI.avatarEl(u.avatar, u.nickname, 36);
    this.bindEasterEggTriggers();
    // Render presence + status msg under the name
    try { UI.renderSelfStatus && UI.renderSelfStatus(); } catch {}

    // Build emoji picker
    buildEmojiPicker();

    // Show a loading UI in the messages area & channel title immediately so
    // we don't flash the "Welcome to FrogTalk" default header before the
    // last channel has a chance to open. This is cleared by switchToRoom()
    // or replaced by showEmptyOnboarding() if the user truly has no rooms.
    App.showChannelLoading();

    // Request notification permission
    Notifications.requestPermission();

    // Android native push: register/sync FCM token against this account.
    try {
      if (window.Android && typeof window.Android.registerFcmToken === 'function' && State.token) {
        window.Android.registerFcmToken(State.token);
      }
    } catch {}

    // Recover pending incoming call as early as possible so reloads don't hide
    // the ring UI behind rooms/sidebar loading.
    if (this.pendingIncomingCall) {
      const restored = await this.recoverIncomingCall(this.pendingIncomingCall);
      if (restored) {
        this.pendingIncomingCall = null;
      }
    } else {
      await this.recoverLatestIncomingCall();
    }

    // Load rooms then join first available room (or show onboarding)
    await Rooms.loadRooms();

    if (this.pendingIncomingCall) {
      const restored = await this.recoverIncomingCall(this.pendingIncomingCall);
      if (restored) {
        this.pendingIncomingCall = null;
      }
    }

    // Process pending invite / share link
    if (this.pendingInvite) {
      await this.handleInvite(this.pendingInvite);
      this.pendingInvite = null;
    } else if (this.pendingRoom) {
      // Share link: /c/{room} -> try to switch into that room
      const r = (State.rooms || []).find(x => x.name === this.pendingRoom);
      if (r && typeof Rooms !== 'undefined' && Rooms.switchToRoom) {
        Rooms.switchToRoom(r.name, r.channel_type || 'public');
      } else {
        App.openFirstAvailableRoom();
      }
      this.pendingRoom = null;
    } else if (this.pendingDM && String(this.pendingDM).trim()) {
      // Share link: /u/{nick} "Send a message" -> open DM with that user
      if (typeof openDMWithNick === 'function') {
        try { openDMWithNick(this.pendingDM); } catch {}
      } else {
        App.openFirstAvailableRoom();
      }
      this.pendingDM = null;
    } else if (this.pendingReel) {
      // Share link: /r/{id} or /?reel={id} — open FrogSocial reels and focus target reel.
      App.openFirstAvailableRoom();
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
      App.openFirstAvailableRoom();
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
      App.openFirstAvailableRoom();
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
      App.openFirstAvailableRoom();
    }

    // Load DM channels sidebar
    if (typeof loadDMChannels === 'function') loadDMChannels();

    // Load friends (for badge count)
    if (typeof loadFriends === 'function') loadFriends();

    // Fetch social activity unread count for the 🤳🏼 sidebar badge
    if (typeof Social !== 'undefined' && Social.refreshActivityBadge) {
      try { Social.refreshActivityBadge(); } catch {}
    }

    // Refresh blocked-users cache so rooms/DMs/feed filters take effect
    if (typeof refreshBlockedCache === 'function') refreshBlockedCache();

    // Publish ECDH public key for E2E DM encryption
    if (typeof Crypto !== 'undefined' && Crypto.getPublicKey) {
      try {
        const pubKey = await Crypto.getPublicKey();
        if (pubKey) {
          apiFetch('/api/users/pubkey', 'POST', { pub_key: pubKey, ecdh_pub_key: pubKey }).catch(() => {});
        }
      } catch {}
    }

    // Recover pending story uploads (if app was closed during upload)
    if (typeof Social !== 'undefined' && Social._initUploadRecovery) {
      try { Social._initUploadRecovery(); } catch {}
    }
  },

  bindEasterEggTriggers() {
    const bindTap = (el, key = 'easterBound') => {
      if (!el || el.dataset[key]) return;
      el.dataset[key] = '1';
      try {
        console.debug('[EasterEgg] Bound tap trigger', el.id || el.className || el.tagName);
      } catch {}
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
    try {
      console.debug('[EasterEgg] Tap count', this.easterTapCount);
    } catch {}
    clearTimeout(this.easterTapTimer);
    this.easterTapTimer = setTimeout(() => { this.easterTapCount = 0; }, 2600);
    if (this.easterTapCount < 7) return;
    this.easterTapCount = 0;
    try {
      console.debug('[EasterEgg] Trigger threshold reached, opening popup');
    } catch {}
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
      try {
        console.debug('[EasterEgg] Fetch result', { ok: res.ok, status: res.status, enabled: !!data?.enabled, hasHtml: !!data?.html });
      } catch {}
      if (!res.ok) return null;
      this.easterEgg = data;
      return data;
    } catch {
      try {
        console.debug('[EasterEgg] Fetch failed');
      } catch {}
      return null;
    }
  },

  async openNodeEasterEgg() {
    const payload = await this.fetchNodeEasterEgg(true);
    if (!payload?.enabled || !payload?.html) {
      try {
        console.debug('[EasterEgg] Popup not shown: missing enabled/html');
      } catch {}
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

  async recoverIncomingCall(pending) {
    const callId = String(pending?.callId || '').trim();
    if (!callId || !State.token) return false;
    try {
      const res = await fetch(`/api/calls/${encodeURIComponent(callId)}/pending`, {
        headers: { 'X-Session-Token': State.token }
      });
      if (!res.ok) {
        if (res.status === 404 || res.status === 409) {
          this.clearPendingIncomingCall();
        }
        return false;
      }
      const offer = await res.json();
      if (!offer?.from_nickname && pending?.peerNick) {
        offer.from_nickname = pending.peerNick;
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
      const res = await fetch('/api/calls/pending-latest', {
        headers: { 'X-Session-Token': State.token }
      });
      if (!res.ok) return false;
      const offer = await res.json();
      if (offer?.call_id) {
        this.setPendingIncomingCall({
          callId: String(offer.call_id),
          peerNick: String(offer.from_nickname || ''),
        });
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
        UI.showToast(`Joined #${data.room}!`, 'success');
        // Reload rooms and switch to the new room
        await Rooms.loadRooms();
        Rooms.switchToRoom(data.room, 'public');
      } else {
        const err = await res.json();
        UI.showToast(err.error || 'Failed to join', 'error');
        App.openFirstAvailableRoom();
      }
    } catch (e) {
      UI.showToast('Failed to process invite', 'error');
      App.openFirstAvailableRoom();
    }
  },

  /**
   * Pick the first joined room and switch to it. If the user has no rooms yet
   * (fresh signup with no invite), show the onboarding/empty state instead of
   * falling back to a non-existent "general" channel.
   */
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
        </div>`;
    }
    const titleEl = document.getElementById('ch-title');
    if (titleEl) {
      titleEl.innerHTML = '<span class="room-title-text" style="color:#888">Loading\u2026</span>';
    }
    // Ensure the welcome-only CSS flag is not set during the load.
    document.body.classList.remove('in-welcome');
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
    const hdr = document.getElementById('chat-header-title');
    if (hdr) hdr.textContent = 'Welcome to FrogTalk';
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
