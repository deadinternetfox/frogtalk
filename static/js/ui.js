/**
 * ui.js — UI helpers, modals, toasts, typing indicator
 */

const UI = (() => {
  let _typingTimers = {};
  let _toastTimeout = null;
  // ── "Now Playing" status ───────────────────────────────────────────
  // When enabled (toggle in the status picker, persisted to localStorage)
  // the user's status_msg auto-mirrors the active mini-player track.
  // Tapping the status link then jumps to the source (channel or post).
  const _NOWPLAYING_LS_KEY = 'frogtalk:status:nowplaying';
  const _NOWPLAYING_SAVED_LS_KEY = 'frogtalk:status:nowplaying:saved';
  let _nowPlayingActive = false;        // status currently shows a track
  let _nowPlayingLastTitle = '';        // last track title we pushed
  let _nowPlayingSavedMsg = null;       // user's manual msg before takeover
  let _nowPlayingPatchInflight = false; // crude debounce
  function _nowPlayingEnabled() {
    // Default ON — most users expect their status to mirror what they're
    // listening to. Only an explicit '0' disables it.
    try {
      const v = localStorage.getItem(_NOWPLAYING_LS_KEY);
      return v !== '0';
    } catch { return true; }
  }
  // Persisted saved-msg helpers. We need this to survive reloads:
  // otherwise if the user reloads while a 🎵 status was live and then
  // unticks the toggle, _nowPlayingActive is false → nothing restores
  // → the song title stays stuck as their status.
  function _readSavedMsg() {
    try {
      const v = localStorage.getItem(_NOWPLAYING_SAVED_LS_KEY);
      return v == null ? null : String(v);
    } catch { return null; }
  }
  function _writeSavedMsg(v) {
    try {
      if (v == null) localStorage.removeItem(_NOWPLAYING_SAVED_LS_KEY);
      else localStorage.setItem(_NOWPLAYING_SAVED_LS_KEY, String(v));
    } catch {}
  }

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(iso) {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatDate(iso) {
    const d = iso ? new Date(iso) : new Date();
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
  }

  function avatarEl(avatar, nickname, size = 38) {
    const s = String(avatar || '');
    // Image-like sources: data URLs, http(s) URLs, absolute paths
    if (s && (s.startsWith('data:') || s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/'))) {
      return `<img src="${escHtml(s)}" alt="" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:inline-block;vertical-align:middle">`;
    }
    // Emoji avatar
    if (s) {
      return `<span style="display:inline-flex;width:${size}px;height:${size}px;border-radius:50%;background:#1a2a1a;align-items:center;justify-content:center;font-size:${Math.round(size*0.55)}px;vertical-align:middle">${escHtml(s)}</span>`;
    }
    // No avatar at all → show the FrogTalk default frog. Per-nickname tinted
    // gradient keeps users visually distinguishable while staying on-brand.
    const grads = [
      'linear-gradient(135deg,#1d4a2e,#0f2018)',
      'linear-gradient(135deg,#2a4a1d,#15240e)',
      'linear-gradient(135deg,#1d3a4a,#0e1a24)',
      'linear-gradient(135deg,#3a1d4a,#1d0e24)',
      'linear-gradient(135deg,#4a3a1d,#241a0e)',
    ];
    const idx = ((nickname || '?').charCodeAt(0) || 0) % grads.length;
    return `<span aria-label="${escHtml(nickname || 'user')}" style="display:inline-flex;width:${size}px;height:${size}px;border-radius:50%;background:${grads[idx]};align-items:center;justify-content:center;font-size:${Math.round(size*0.6)}px;line-height:1;vertical-align:middle;box-shadow:inset 0 0 0 1px rgba(127,210,167,.18)">🐸</span>`;
  }

  function setConnectionStatus(status) {
    const el = document.getElementById('self-status');
    if (!el) return;
    // Cache actual user-presence label so we can restore once network recovers.
    if (status === 'offline') { el.dataset.conn = 'offline'; el.textContent = '🔴 Offline'; return; }
    if (status === 'reconnecting') { el.dataset.conn = 'reconnecting'; el.textContent = '🟡 Reconnecting…'; return; }
    delete el.dataset.conn;
    renderSelfStatus();
  }

  // Render "presence + status message" on the self panel. Preserves offline/
  // reconnecting overrides so the connection indicator still wins when needed.
  function renderSelfStatus() {
    const el = document.getElementById('self-status');
    if (!el) return;
    if (el.dataset.conn) return; // connection override active
    const p = (State?.user?.presence) || 'online';
    const msg = (State?.user?.status_msg) || '';
    const dots = { online: '🟢', away: '🟡', dnd: '⛔', invisible: '⚫' };
    const labels = { online: 'Online', away: 'Away', dnd: 'Do Not Disturb', invisible: 'Invisible' };
    const dot = dots[p] || '🟢';
    const name = labels[p] || 'Online';
    // When the now-playing toggle is on AND a track is live, show a
    // music note + clickable affordance so the user can tap to open
    // the source post / channel. _syncNowPlayingStatus now writes the
    // 🎵 prefix into status_msg itself, so don't double-prefix.
    const hasNote = !!msg && msg.indexOf('🎵') === 0;
    const np = (_nowPlayingActive && msg && !hasNote) ? '🎵 ' : '';
    el.innerHTML = msg
      ? `<span style="opacity:.9">${dot}</span> <span style="color:#bbb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px;display:inline-block;vertical-align:bottom">${np}${escHtml(msg)}</span>`
      : `${dot} ${escHtml(name)}`;
    el.title = _nowPlayingActive
      ? `${name} — ${msg} (tap to open track · long-press to change status)`
      : (msg ? `${name} — ${msg} (click to change)` : `${name} (click to change)`);
    el.dataset.nowplaying = _nowPlayingActive ? '1' : '0';
    // Update the under-avatar status display
    const disp = document.getElementById('self-status-display');
    if (disp) {
      disp.textContent = msg ? `${dot} ${np}${msg}` : `${dot} ${name}`;
      disp.style.color = msg ? '#b2dfc3' : '#7ecfa3';
      disp.style.cursor = _nowPlayingActive ? 'pointer' : '';
      disp.title = _nowPlayingActive ? 'Tap to open the playing track' : '';
    }
    renderSelfQuickStatus();
  }

  function renderSelfQuickStatus() {
    const textEl = document.getElementById('self-quick-status-text');
    const inputEl = document.getElementById('self-quick-input');
    const p = (State?.user?.presence) || 'online';
    const msg = (State?.user?.status_msg || '').trim();
    const labels = { online: 'Online', away: 'Away', dnd: 'Do Not Disturb', invisible: 'Invisible' };
    if (textEl) textEl.textContent = msg || labels[p] || 'Online';
    if (inputEl && document.activeElement !== inputEl) inputEl.value = msg;
  }

  async function _refreshSelfStatusFromApi() {
    try {
      const res = await fetch('/api/auth/me', { headers: { 'X-Session-Token': State.token } });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !State.user) return;
      if (typeof data.presence === 'string') State.user.presence = data.presence;
      if (typeof data.status_msg === 'string') State.user.status_msg = data.status_msg;
      if (typeof State.save === 'function') State.save();
      renderSelfStatus();
      renderSelfQuickStatus();
    } catch {}
  }

  async function toggleSelfStatusComposer(open) {
    const wrap = document.getElementById('self-quick-editor');
    const input = document.getElementById('self-quick-input');
    const tick = document.getElementById('self-quick-save');
    if (!wrap || !input) return;
    const wantOpen = (typeof open === 'boolean') ? open : !wrap.classList.contains('is-open');
    if (wantOpen) await _refreshSelfStatusFromApi();
    wrap.classList.toggle('is-open', wantOpen);
    if (tick) tick.classList.toggle('is-active', wantOpen);
    if (wantOpen) {
      input.value = (State?.user?.status_msg || '').trim();
      try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch {}
    }
  }

  function cancelSelfQuickStatus() {
    toggleSelfStatusComposer(false);
  }

  async function submitSelfQuickStatus() {
    const input = document.getElementById('self-quick-input');
    if (!input) return;
    const nextMsg = String(input.value || '').slice(0, 128).trim();
    const nextPresence = (State?.user?.presence) || 'online';
    await _saveStatus(nextPresence, nextMsg);
    renderSelfQuickStatus();
    toggleSelfStatusComposer(false);
  }

  async function openStatusPicker(ev) {
    try { ev?.stopPropagation?.(); } catch {}
    if (!State?.user) return;
    // Open instantly using local state; refresh in background to avoid UI lag.
    _refreshSelfStatusFromApi();

    // Always destroy + recreate so stale DOM / old styles never show
    const old = document.getElementById('status-picker-popover');
    if (old) old.remove();

    const pop = document.createElement('div');
    pop.id = 'status-picker-popover';
    // No backdrop-filter — it renders black on Android Chrome when unsupported
    Object.assign(pop.style, {
      position: 'fixed',
      zIndex: '1000',
      background: 'linear-gradient(160deg,#234d3e 0%,#1c3d30 40%,#172f25 100%)',
      border: '1px solid #4f9675',
      borderRadius: '14px',
      padding: '14px',
      width: 'min(320px, calc(100vw - 24px))',
      boxShadow: '0 20px 50px rgba(0,0,0,.65), 0 4px 14px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.1)',
      display: 'none',
      boxSizing: 'border-box',
    });
    pop.innerHTML = `
      <div style="font-size:11px;color:#a3e8c0;font-weight:800;letter-spacing:.6px;text-transform:uppercase;margin-bottom:8px">Set status</div>
      <div id="sp-opts" style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px"></div>
      <div style="font-size:11px;color:#a3e8c0;font-weight:800;letter-spacing:.6px;text-transform:uppercase;margin-bottom:7px">Status message</div>
      <input id="sp-msg" type="text" maxlength="128" placeholder="What are you up to?"
        style="width:100%;background:#0f2219;border:1px solid #4a8068;border-radius:9px;padding:9px 11px;color:#e8f8ee;font-size:13px;outline:none;box-sizing:border-box">
      <button id="sp-nowplaying" type="button" title="Mirror your active mini-player track as your status. Tap your status to jump back to the source."
        style="margin-top:9px;display:flex;align-items:center;gap:9px;width:100%;padding:9px 11px;border-radius:9px;background:linear-gradient(180deg,#182e25,#13261f);border:1px solid #355f4f;color:#deefe7;font-size:12.5px;cursor:pointer;text-align:left;box-sizing:border-box">
        <span id="sp-np-icon" style="display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;font-size:13px">✕</span>
        <span style="flex:1">🎵 Show now-playing as status</span>
      </button>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button id="sp-clear" style="flex:1;background:#1a3c2d;border:1px solid #3d6a58;color:#a8ccb8;padding:10px;border-radius:9px;cursor:pointer;font-size:12px;font-weight:600">Clear</button>
        <button id="sp-save" style="flex:1;background:linear-gradient(180deg,#5abf65,#48aa52);border:1px solid #65c870;color:#041704;font-weight:800;padding:10px;border-radius:9px;cursor:pointer;font-size:13px">Save</button>
      </div>
    `;
    document.body.appendChild(pop);
    document.addEventListener('click', function _spClose(e) {
      const statusAnchor = document.getElementById('self-status');
      const clickedAnchor = !!(statusAnchor && statusAnchor.contains(e.target));
      if (!pop.contains(e.target) && !clickedAnchor) {
        pop.remove();
        document.removeEventListener('click', _spClose);
      }
    });
    // Populate presence options (reflect current)
    const curP = State.user.presence || 'online';
    const opts = [
      { k: 'online',    d: '🟢', l: 'Online' },
      { k: 'away',      d: '🟡', l: 'Away' },
      { k: 'dnd',       d: '⛔', l: 'Do Not Disturb' },
      { k: 'invisible', d: '⚫', l: 'Invisible' },
    ];
    pop.querySelector('#sp-opts').innerHTML = opts.map(o => `
      <button type="button" data-presence="${o.k}"
        style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:${o.k===curP?'linear-gradient(180deg,#214438,#1a372d)':'linear-gradient(180deg,#182e25,#13261f)'};border:1px solid ${o.k===curP?'#66c596':'#355f4f'};color:${o.k===curP?'#9ce2be':'#deefe7'};font-size:13px;cursor:pointer;text-align:left">
        <span style="font-size:14px">${o.d}</span><span style="flex:1">${o.l}</span>${o.k===curP?'<span>✓</span>':''}
      </button>
    `).join('');
    pop.querySelectorAll('[data-presence]').forEach(btn => {
      btn.onclick = () => {
        pop.querySelectorAll('[data-presence]').forEach(b => {
          const k = b.dataset.presence;
          b.style.background = k === btn.dataset.presence ? 'linear-gradient(180deg,#214438,#1a372d)' : 'linear-gradient(180deg,#182e25,#13261f)';
          b.style.borderColor = k === btn.dataset.presence ? '#66c596' : '#355f4f';
          b.style.color = k === btn.dataset.presence ? '#9ce2be' : '#deefe7';
        });
        pop.dataset.pendingPresence = btn.dataset.presence;
      };
    });
    pop.dataset.pendingPresence = curP;
    pop.querySelector('#sp-msg').value = State.user.status_msg || '';
    // Now-playing toggle reflects current LS state and flips it on click.
    const npBtn = pop.querySelector('#sp-nowplaying');
    const npIcon = pop.querySelector('#sp-np-icon');
    function _renderNpBtn() {
      const on = _nowPlayingEnabled();
      npIcon.textContent = on ? '✓' : '✕';
      npBtn.style.background = on
        ? 'linear-gradient(180deg,#214438,#1a372d)'
        : 'linear-gradient(180deg,#182e25,#13261f)';
      npBtn.style.borderColor = on ? '#66c596' : '#355f4f';
      npBtn.style.color       = on ? '#9ce2be' : '#deefe7';
    }
    _renderNpBtn();
    npBtn.onclick = () => {
      const next = !_nowPlayingEnabled();
      setNowPlayingEnabled(next);
      _renderNpBtn();
    };
    // Close immediately, save in background — no blocking lag
    pop.querySelector('#sp-clear').onclick = () => {
      const presence = pop.dataset.pendingPresence || State?.user?.presence || 'online';
      State.user.presence = presence;
      State.user.status_msg = '';
      renderSelfStatus();
      pop.remove();
      _saveStatus(presence, '');
    };
    pop.querySelector('#sp-save').onclick = () => {
      const presence = pop.dataset.pendingPresence || 'online';
      const msg = pop.querySelector('#sp-msg').value.slice(0, 128);
      State.user.presence = presence;
      State.user.status_msg = msg;
      renderSelfStatus();
      pop.remove();
      _saveStatus(presence, msg);
    };
    // Position above the self-status element
    const anchor = document.getElementById('self-status');
    const r = anchor.getBoundingClientRect();
    pop.style.display = 'block';
    const popH = pop.offsetHeight || 300;
    pop.style.left = Math.max(8, Math.min(window.innerWidth - 330, r.left)) + 'px';
    pop.style.top  = Math.max(8, r.top - popH - 8) + 'px';
  }

  async function _saveStatus(presence, status_msg) {
    try {
      const res = await fetch('/api/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
        body: JSON.stringify({ presence, status_msg })
      });
      if (!res.ok) { toast('Could not save status', 'error'); return; }
      State.user.presence = presence;
      State.user.status_msg = status_msg;
      renderSelfStatus();
      toast('Status updated', 'success');
    } catch { toast('Could not save status', 'error'); }
  }

  // Quietly push a status_msg without toasting (used by the now-playing
  // auto-mirror so we don't spam the user every track change).
  async function _saveStatusSilent(presence, status_msg) {
    if (_nowPlayingPatchInflight) return;
    _nowPlayingPatchInflight = true;
    try {
      const res = await fetch('/api/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
        body: JSON.stringify({ presence, status_msg })
      });
      if (!res.ok) return;
      State.user.presence = presence;
      State.user.status_msg = status_msg;
      renderSelfStatus();
    } catch {} finally {
      _nowPlayingPatchInflight = false;
    }
  }

  // Sync the user's status_msg to whatever's playing in the mini-player.
  // Called on every music:statechange and once at boot.
  function _syncNowPlayingStatus() {
    if (!_nowPlayingEnabled() || !State?.user) {
      // Toggle is off — release any takeover that was in effect, AND
      // also recover from a stale 🎵 status that survived a page
      // reload (in-memory _nowPlayingActive resets to false on reload,
      // so without this branch the song title would stay forever).
      const curMsg = String(State?.user?.status_msg || '');
      const looksLikeMusic = curMsg.indexOf('🎵') === 0;
      if (_nowPlayingActive || looksLikeMusic) {
        _nowPlayingActive = false;
        const persisted = _readSavedMsg();
        const restore = (_nowPlayingSavedMsg != null) ? _nowPlayingSavedMsg
                       : (persisted != null) ? persisted
                       : '';
        _nowPlayingSavedMsg = null;
        _writeSavedMsg(null);
        _nowPlayingLastTitle = '';
        const presence = (State?.user?.presence) || 'online';
        // Only PATCH if we'd actually be changing something.
        if (restore !== curMsg) _saveStatusSilent(presence, restore);
      }
      return;
    }
    let cur = null;
    try {
      cur = (window.Music && typeof Music.getCurrent === 'function') ? Music.getCurrent() : null;
    } catch {}
    const isLive = !!(cur && cur.active && cur.title);
    if (isLive) {
      // Prefix with the music note so remote clients can detect a
      // now-playing status and render it as a clickable link to the
      // user's profile (where their latest shared track is visible).
      // Cap the title so the prefix never pushes the message over the
      // 128-char status_msg limit.
      const rawTitle = String(cur.title || '').slice(0, 90);
      const title = '🎵 ' + rawTitle;
      if (title === _nowPlayingLastTitle && _nowPlayingActive) return;
      // First time we take over the status: stash whatever the user had.
      // Persist to localStorage so a reload mid-takeover doesn't lose it.
      if (!_nowPlayingActive) {
        const prev = String(State.user.status_msg || '');
        // Don't overwrite saved with another 🎵 string — that would
        // happen if the takeover migrates to a new track and the
        // previous status was already the old 🎵 title.
        if (prev.indexOf('🎵') !== 0) {
          _nowPlayingSavedMsg = prev;
          _writeSavedMsg(prev);
        } else if (_nowPlayingSavedMsg == null) {
          // Reload mid-takeover: rehydrate from LS if present so a
          // later untick still restores the right thing.
          _nowPlayingSavedMsg = _readSavedMsg();
        }
      }
      _nowPlayingActive = true;
      _nowPlayingLastTitle = title;
      const presence = (State?.user?.presence) || 'online';
      _saveStatusSilent(presence, title);
    } else if (_nowPlayingActive || String(State.user.status_msg || '').indexOf('🎵') === 0) {
      // Music stopped — restore the user's manual message. Same
      // reload-recovery branch as the toggle-off path: even if the
      // in-memory takeover flag is false, a stuck 🎵 status from a
      // previous session should be cleared.
      _nowPlayingActive = false;
      _nowPlayingLastTitle = '';
      const persisted = _readSavedMsg();
      const restore = (_nowPlayingSavedMsg != null) ? _nowPlayingSavedMsg
                     : (persisted != null) ? persisted
                     : '';
      _nowPlayingSavedMsg = null;
      _writeSavedMsg(null);
      const presence = (State?.user?.presence) || 'online';
      if (restore !== String(State.user.status_msg || '')) {
        _saveStatusSilent(presence, restore);
      }
    }
  }

  // Toggle from the status picker. Enabling it grabs the active track
  // immediately; disabling restores the user's previous msg.
  function setNowPlayingEnabled(on) {
    try { localStorage.setItem(_NOWPLAYING_LS_KEY, on ? '1' : '0'); } catch {}
    _syncNowPlayingStatus();
    try { toast(on ? 'Now Playing status: on' : 'Now Playing status: off', 'success'); } catch {}
  }

  // Click handler for the status pill / under-avatar status when the
  // status reflects a live track. Falls back to opening the picker so
  // the user isn't trapped without a way to change presence.
  function handleSelfStatusClick(ev) {
    if (_nowPlayingActive) {
      try { ev?.stopPropagation?.(); } catch {}
      try {
        if (window.Music && typeof Music.expand === 'function') {
          Music.expand();
          return;
        }
      } catch {}
    }
    openStatusPicker(ev);
  }

  // Wire one-time listeners for music state changes and DOM clicks on
  // the under-avatar status display (the pill already has its own
  // onclick attribute in HTML, which we re-route in handleSelfStatusClick).
  let _nowPlayingWired = false;
  function _wireNowPlaying() {
    if (_nowPlayingWired) return;
    _nowPlayingWired = true;
    document.addEventListener('music:statechange', () => {
      try { _syncNowPlayingStatus(); } catch {}
    });
    const disp = document.getElementById('self-status-display');
    if (disp) {
      disp.addEventListener('click', (ev) => {
        if (_nowPlayingActive) handleSelfStatusClick(ev);
      });
    }
    // Re-route the pill's existing onclick through our handler so the
    // "open source" behaviour also works there.
    const pill = document.getElementById('self-status');
    if (pill) {
      pill.setAttribute('onclick', 'UI.handleSelfStatusClick(event)');
    }
    // Initial sync in case music was already playing when the page loaded.
    setTimeout(() => { try { _syncNowPlayingStatus(); } catch {} }, 600);
  }
  // Defer until DOM exists.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireNowPlaying);
  } else {
    _wireNowPlaying();
  }

  function showTyping(nickname) {
    const bar = document.getElementById('typing-bar');
    if (!bar) return;
    clearTimeout(_typingTimers[nickname]);
    _typingTimers[nickname] = setTimeout(() => {
      delete _typingTimers[nickname];
      updateTypingBar();
    }, 3000);
    updateTypingBar();
  }

  function updateTypingBar() {
    const bar = document.getElementById('typing-bar');
    if (!bar) return;
    const names = Object.keys(_typingTimers);
    if (!names.length) { bar.textContent = ''; return; }
    if (names.length === 1) bar.textContent = `${names[0]} is typing…`;
    else if (names.length === 2) bar.textContent = `${names[0]} and ${names[1]} are typing…`;
    else bar.textContent = `${names.length} people are typing…`;
  }

  function showPresence(event, nickname) {
    // Generic presence noise (X joined / X left) is intentionally silenced —
    // it's distracting and was largely test-grade. Friends/online list still
    // updates from the WS handler, so visibility is preserved where it matters.
    return;
  }

  function showToast(text, type = 'info', duration = 3000, onClick = null) {
    // Toast stack: multiple toasts stack upward at bottom-center.
    let stack = document.getElementById('toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toast-stack';
      stack.style.cssText = `
        position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
        display:flex;flex-direction:column-reverse;gap:8px;z-index:9999;
        pointer-events:none;max-width:92vw;align-items:center
      `;
      document.body.appendChild(stack);
    }
    const icons  = { error: '⚠️', success: '✓',   info: 'ℹ️',  warn: '⚠️' };
    const accent = { error: '#ff8a8a', success: '#7fd8a5', info: '#9fd8c0', warn: '#e7cf8b' };
    const bg     = { error: '#2a1517', success: '#152721', info: '#14231f', warn: '#2a2316' };
    const color  = accent[type] || accent.info;
    const toast = document.createElement('div');
    toast.className = 'ft-toast ft-toast-enter';
    toast.style.cssText = `
      display:flex;align-items:center;gap:10px;max-width:92vw;
      background:${bg[type] || '#151515'};
      border:1px solid ${color}55;border-left:3px solid ${color};
      color:#e8e8e8;border-radius:10px;padding:10px 16px 10px 12px;
      font-size:14px;line-height:1.35;
      box-shadow:0 8px 28px rgba(0,0,0,.5),0 0 0 1px rgba(126,199,166,.08);
      backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
      transition:transform .22s cubic-bezier(.22,1.02,.36,1),opacity .22s ease;
      transform:translateY(16px) scale(.96);opacity:0;
      pointer-events:auto;${typeof onClick === 'function' ? 'cursor:pointer;' : ''}
    `;
    toast.innerHTML = `
      <span style="color:${color};font-size:16px;flex-shrink:0;font-weight:700;width:18px;text-align:center">${icons[type] || icons.info}</span>
      <span style="flex:1;word-break:break-word"></span>
    `;
    toast.lastElementChild.textContent = String(text ?? '');
    if (typeof onClick === 'function') {
      toast.addEventListener('click', () => {
        try { onClick(); } catch {}
        try { dismiss(); } catch {}
      });
    }
    stack.appendChild(toast);
    // Trigger entrance on next frame
    requestAnimationFrame(() => {
      toast.style.transform = 'translateY(0) scale(1)';
      toast.style.opacity = '1';
    });
    const dismiss = () => {
      toast.style.transform = 'translateY(16px) scale(.96)';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 260);
    };
    const autoDismissAt = setTimeout(dismiss, Math.max(1200, duration));
    // Return a handle so callers can cancel early (e.g. "Loading GIF…" toast
    // that should stay until the fetch resolves).
    return {
      dismiss: () => { clearTimeout(autoDismissAt); dismiss(); },
      el: toast,
    };
  }

  let _progressToastTimer = null;
  function showProgressToast(label, percent) {
    let el = document.getElementById('progress-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'progress-toast';
      el.style.cssText = `
        position:fixed;bottom:70px;left:50%;transform:translateX(-50%);
        background:linear-gradient(180deg,#153028,#112720);
        border:1px solid #305d4d;border-radius:12px;
        padding:12px 20px;z-index:1000;box-shadow:0 4px 24px rgba(0,0,0,.6);
        min-width:220px;transition:opacity .3s;
      `;
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span id="progress-toast-label" style="font-size:13px;color:#e4f3ec;flex:1"></span>
          <span id="progress-toast-pct" style="font-size:12px;color:#7fd8a5;font-weight:700;min-width:36px;text-align:right"></span>
        </div>
        <div style="height:4px;background:#1d3a31;border-radius:2px;overflow:hidden">
          <div id="progress-toast-bar" style="height:100%;background:linear-gradient(90deg,#6bc29a,#8adbb3);border-radius:2px;transition:width .3s ease;width:0%"></div>
        </div>
      `;
      document.body.appendChild(el);
    }
    el.style.opacity = '1';
    document.getElementById('progress-toast-label').textContent = label;
    document.getElementById('progress-toast-pct').textContent = percent + '%';
    document.getElementById('progress-toast-bar').style.width = percent + '%';
    clearTimeout(_progressToastTimer);
    if (percent >= 100) {
      _progressToastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1500);
    }
  }

  // Safari-safe Blob → data URL conversion. Some iOS Safari / WKWebView
  // contexts surface "Can't find variable: FileReader" when FileReader is
  // referenced from inside a Promise constructor; using the modern
  // Blob.arrayBuffer() API + manual base64 encode avoids the issue entirely.
  // Falls back to FileReader if arrayBuffer is unavailable (very old browsers).
  async function blobToDataURL(blob, onProgress) {
    if (!blob) return null;
    try {
      if (typeof blob.arrayBuffer === 'function') {
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const CHUNK = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
          if (typeof onProgress === 'function') {
            try { onProgress(Math.min(100, Math.round((i / bytes.length) * 100))); } catch {}
          }
        }
        const b64 = btoa(binary);
        const mime = blob.type || 'application/octet-stream';
        if (typeof onProgress === 'function') { try { onProgress(100); } catch {} }
        return `data:${mime};base64,${b64}`;
      }
    } catch (e) { /* fall through */ }
    // Last-resort FileReader fallback (guarded against Safari's missing-global error)
    return await new Promise((resolve, reject) => {
      try {
        const FR = (typeof FileReader !== 'undefined') ? FileReader : (window && window.FileReader);
        if (!FR) { reject(new Error('No FileReader available')); return; }
        const r = new FR();
        r.onprogress = (e) => {
          if (typeof onProgress === 'function' && e && e.lengthComputable) {
            try { onProgress(Math.round((e.loaded / e.total) * 100)); } catch {}
          }
        };
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error || new Error('FileReader failed'));
        r.readAsDataURL(blob);
      } catch (err) { reject(err); }
    });
  }

  // Authenticated JSON POST/PUT with real upload progress via XHR. Returns
  // a Response-like object: { ok, status, json(), text() }. Used for chat
  // attachments where users want to see actual bytes-on-the-wire instead of
  // the fake "70% then jump to 100%" feedback that fetch() can't expose.
  function uploadJSONWithProgress(url, payload, opts = {}) {
    const method = (opts.method || 'POST').toUpperCase();
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const token = (typeof State !== 'undefined' && State && State.token) ? State.token : '';
    return new Promise((resolve, reject) => {
      let body;
      try { body = JSON.stringify(payload); }
      catch (e) { reject(e); return; }
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (token) xhr.setRequestHeader('X-Session-Token', token);
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e && e.lengthComputable) {
            try { onProgress(e.loaded, e.total); } catch {}
          }
        };
        // upload.onload fires when the request body has finished going up
        // but before the server has responded — useful to flip the label
        // from "Uploading…" to "Sending…".
        xhr.upload.onload = () => {
          try { onProgress(1, 1, 'uploaded'); } catch {}
        };
      }
      xhr.onload = () => {
        const status = xhr.status || 0;
        const text = xhr.responseText || '';
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: () => Promise.resolve(text),
          json: () => { try { return Promise.resolve(JSON.parse(text)); } catch (e) { return Promise.reject(e); } },
        });
      };
      xhr.onerror = () => reject(new TypeError('Network request failed'));
      xhr.onabort = () => reject(new Error('aborted'));
      try { xhr.send(body); } catch (e) { reject(e); }
    });
  }

  // ── Themed confirm dialog ────────────────────────────────────────────
  // Drop-in async replacement for window.confirm() that uses the app's
  // .modal-overlay/.modal-box/.modal-btn styles instead of the browser's
  // chrome dialog ("frogtalk.xyz says…"). Resolves true on confirm,
  // false on cancel / overlay click / Esc.
  //   await UI.confirm('Delete this message?')
  //   await UI.confirm({ title:'Delete', message:'…', confirmLabel:'Delete', danger:true })
  function confirm(opts) {
    if (typeof opts === 'string') opts = { message: opts };
    opts = opts || {};
    const message      = String(opts.message || 'Are you sure?');
    const title        = opts.title != null ? String(opts.title) : '';
    const confirmLabel = String(opts.confirmLabel || 'Confirm');
    const cancelLabel  = String(opts.cancelLabel  || 'Cancel');
    const danger       = !!opts.danger;
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;' +
        'justify-content:center;padding:16px;';
      const titleHtml = title
        ? `<div style="font-weight:600;font-size:15px;margin-bottom:8px;color:var(--accent-color,#e8e8e8)">${escHtml(title)}</div>`
        : '';
      overlay.innerHTML =
        '<div class="modal-box" role="dialog" aria-modal="true" ' +
        'style="max-width:min(420px,94vw);padding:18px 18px 14px;' +
        // Match chat surfaces (#chat-header / #input-area): accent-tinted
        // gradient over --surface-color so the dialog feels like part of
        // the app instead of a plain charcoal box.
        'background:linear-gradient(180deg,' +
          'color-mix(in srgb, var(--accent-color,#4caf50) 14%, var(--surface-color,#1e1e1e)) 0%,' +
          'color-mix(in srgb, var(--accent-color,#4caf50) 8%,  var(--surface-color,#1e1e1e)) 100%);' +
        'border:1px solid color-mix(in srgb, var(--accent-color,#4caf50) 30%, var(--border-color,#2a2a2a));' +
        'border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.55);' +
        'color:var(--text-color,#e8e8e8)">' +
          titleHtml +
          `<div style="font-size:14px;line-height:1.45;color:var(--text-color,#d6d6d6);white-space:pre-wrap;opacity:.92">${escHtml(message)}</div>` +
          '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">' +
            `<button type="button" class="modal-btn secondary" data-act="cancel">${escHtml(cancelLabel)}</button>` +
            `<button type="button" class="modal-btn ${danger ? 'danger' : 'primary'}" data-act="ok">${escHtml(confirmLabel)}</button>` +
          '</div>' +
        '</div>';
      let done = false;
      const cleanup = (val) => {
        if (done) return; done = true;
        document.removeEventListener('keydown', onKey, true);
        try { overlay.remove(); } catch {}
        resolve(val);
      };
      const onKey = (ev) => {
        if (ev.key === 'Escape')      { ev.preventDefault(); cleanup(false); }
        else if (ev.key === 'Enter')  { ev.preventDefault(); cleanup(true); }
      };
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) cleanup(false);
        const act = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-act');
        if (act === 'cancel') cleanup(false);
        else if (act === 'ok') cleanup(true);
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      // Focus the confirm button so Enter works immediately, but place
      // it on the safer cancel button when this is a destructive prompt.
      try {
        const focusBtn = overlay.querySelector(
          danger ? '[data-act="cancel"]' : '[data-act="ok"]'
        );
        focusBtn && focusBtn.focus();
      } catch {}
    });
  }

  return { escHtml, formatTime, formatDate, avatarEl, setConnectionStatus, renderSelfStatus, renderSelfQuickStatus, openStatusPicker, toggleSelfStatusComposer, submitSelfQuickStatus, cancelSelfQuickStatus, showTyping, showPresence, showToast, showProgressToast, copy, blobToDataURL, uploadJSONWithProgress, confirm, handleSelfStatusClick, setNowPlayingEnabled };
})();

// ─── ChatVideo: themed inline video player for chat ──────────────────────────
// Wraps <video class="msg-media"> elements that live inside <div class="chat-video">
// with a polished themed UI:
//   - Real first-frame poster (captured to a canvas once metadata loads —
//     fixes the "black rectangle, no thumbnail" symptom on Android WebView /
//     Safari / data: URL videos where browsers refuse to paint a poster).
//   - Big centered play button in the brand green.
//   - Duration badge in the corner.
//   - Tap to play inline; native controls appear after the user starts playback
//     so scrub/fullscreen/volume all still work natively. Long-press still
//     opens the lightbox via the existing onclick on the <video>.
const ChatVideo = (() => {
  const POSTER_SEEK = 0.08;

  function fmtDuration(s) {
    if (!isFinite(s) || s <= 0) return '';
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60).toString().padStart(2, '0');
    return m + ':' + ss;
  }

  function init(wrap) {
    if (!wrap || wrap.dataset.cvInit === '1') return;
    const v = wrap.querySelector('video');
    if (!v) return;
    wrap.dataset.cvInit = '1';

    const overlay = wrap.querySelector('.cv-overlay');
    const poster = wrap.querySelector('.cv-poster');
    const durEl = wrap.querySelector('.cv-dur');
    const loading = wrap.querySelector('.cv-loading');

    // Big data: URLs are pathologically slow / non-seekable on Android
    // Chromium WebView (it decodes the base64 inline on every read), and
    // for video notes the WebView frequently can't even decode them at
    // all — fetch(dataUrl) silently hangs, never resolves, and we end up
    // with an empty <video> element (grey play button, no poster, no
    // playback). So we decode the base64 *synchronously* via atob() and
    // hand the WebView a real blob: URL up front. This fixes BOTH the
    // missing thumbnail and the "tap play but nothing happens" symptom
    // for video notes (and regular videos > a few hundred KB).
    const setup = () => _wireVideo(wrap, v, overlay, poster, durEl, loading);
    // Renderers that know upfront the source is a giant data: URL (video
    // notes) emit `data-pending-src` instead of `src` so the WebView
    // never even tries to load the base64 URL — Android Chromium gets
    // wedged decoding multi-MB webm data: URLs at HTML-parse time and
    // *never* recovers, even after we replace .src. Picking up a
    // pending src here lets us hand the element a blob: URL as its
    // very first src.
    const _pendingSrc = v.getAttribute('data-pending-src') || '';
    const _origSrc = v.getAttribute('src') || '' || _pendingSrc;
    const _srcToConvert = _origSrc.startsWith('data:') ? _origSrc
                       : (_pendingSrc.startsWith('data:') ? _pendingSrc : '');
    if (_srcToConvert) {
      // Stop any in-flight data: URL load before swapping.
      try { v.removeAttribute('src'); v.load(); } catch {}
      try { v.removeAttribute('data-pending-src'); } catch {}
      const blobUrl = _dataUrlToBlobUrl(_srcToConvert);
      if (blobUrl) {
        try { v.src = blobUrl; v.load(); } catch {}
        // Revoke when the wrapper leaves the DOM.
        try {
          const mo = new MutationObserver(() => {
            if (!document.contains(wrap)) {
              try { URL.revokeObjectURL(blobUrl); } catch {}
              mo.disconnect();
            }
          });
          mo.observe(document.body, { childList: true, subtree: true });
        } catch {}
      } else {
        // atob failed (non-base64 data URL?) — restore the original src.
        try { v.src = _srcToConvert; v.load(); } catch {}
      }
    }
    setup();
  }

  // Convert a data: URL to a blob: URL synchronously. Returns null on failure.
  function _dataUrlToBlobUrl(dataUrl) {
    try {
      // MediaRecorder produces mime types like
      //   `data:video/webm;codecs=vp9,opus;videonote=1;base64,...`
      // — note the comma INSIDE `codecs=vp9,opus`. A naïve indexOf(',')
      // splits at the wrong comma and we end up feeding garbage bytes to
      // the blob, which is exactly the "buffers forever, grey circle"
      // chat symptom. Locate the real header/payload separator by
      // looking for `;base64,` first (covers all our recorder output)
      // and fall back to lastIndexOf(',') for non-base64 data: URLs.
      let header, payload, isB64;
      const b64Marker = dataUrl.toLowerCase().indexOf(';base64,');
      if (b64Marker >= 0) {
        header  = dataUrl.slice(5, b64Marker);
        payload = dataUrl.slice(b64Marker + 8);
        isB64   = true;
      } else {
        const comma = dataUrl.lastIndexOf(',');
        if (comma < 0) return null;
        header  = dataUrl.slice(5, comma);
        payload = dataUrl.slice(comma + 1);
        isB64   = false;
      }
      const parts = header.split(';');
      const mime  = parts[0] || 'application/octet-stream';
      let bytes;
      if (isB64) {
        const bin = atob(payload);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else {
        const txt = decodeURIComponent(payload);
        bytes = new Uint8Array(txt.length);
        for (let i = 0; i < txt.length; i++) bytes[i] = txt.charCodeAt(i);
      }
      // Strip our internal `;videonote=1` hint and any unsupported codec
      // params from the blob mime — some Android WebView builds reject
      // unknown mime params on createObjectURL playback. Keep just
      // `type/subtype` (e.g. `video/webm`) which the WebView can sniff.
      return URL.createObjectURL(new Blob([bytes], { type: mime }));
    } catch { return null; }
  }

  // Wire up metadata/poster/play interaction on a chat-video wrapper whose
  // <video> already has its final src (blob: or http(s):). Split out of
  // init() so the data:→blob: swap can defer this past the async fetch.
  function _wireVideo(wrap, v, overlay, poster, durEl, loading) {

    // Telegram-style "video note": flagged at render time via the
    // `data-video-note="1"` attribute (driven by the `;videonote=1` mime
    // hint set when finaliseVideoNote produced the blob). Apply the
    // .is-note class up front so the wrapper is round immediately —
    // independent of whether videoWidth/Height metadata ever resolves on
    // this device. This also bumps preload to "auto" so the WebView
    // actually fetches the first keyframe (mandatory for poster capture
    // on Android Chromium WebView, where preload="metadata" on data:
    // URLs frequently never paints anything).
    const flaggedAsNote = wrap.dataset.videoNote === '1';
    if (flaggedAsNote) {
      wrap.classList.add('is-note');
      const icon = wrap.querySelector('.cv-icon');
      if (icon) icon.textContent = '🎥';
      try { v.preload = 'auto'; v.setAttribute('preload', 'auto'); } catch {}
    }

    // Strip native controls until the user starts playback so the themed
    // overlay isn't fighting browser UI for the same pixels.
    try { v.removeAttribute('controls'); } catch {}
    if (!flaggedAsNote) v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    try { v.setAttribute('playsinline', ''); } catch {}
    // Force the loader to actually start. Some WebView builds otherwise
    // leave preload="metadata" data: URLs in HAVE_NOTHING forever.
    try { v.load(); } catch {}

    let posterDrawn = false;
    let candidates = [];     // fractional positions to try (0..1)
    let candidateIdx = 0;
    let lastSnapshot = null; // {url, score} — best frame so far if all candidates dim
    // Block drawPoster while the duration-recovery seek-to-1e9 is in
    // flight: that seek fires `seeked` on the end-of-stream frame
    // (typically black on a freshly recorded MediaRecorder blob), and
    // since `candidates.length === 0` at that moment drawPoster would
    // immediately accept it as the final poster — pinning the chat
    // bubble to a black circle forever.
    let posterArmed = false;

    // Returns "interest score" for a frame: higher == more visual variety.
    // We sample sparse pixels and compute mean brightness + variance; pure
    // black / pure white / single-colour frames score near zero.
    const scoreFrame = (ctx, w, h) => {
      try {
        const step = Math.max(1, Math.floor(Math.min(w, h) / 24));
        const data = ctx.getImageData(0, 0, w, h).data;
        let n = 0, sum = 0, sumSq = 0;
        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            const i = (y * w + x) * 4;
            // Rec.601 luma
            const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
            sum += lum; sumSq += lum * lum; n++;
          }
        }
        if (!n) return 0;
        const mean = sum / n;
        const variance = Math.max(0, sumSq / n - mean * mean);
        // Penalise frames that are nearly pure black or pure white.
        const edge = Math.min(mean, 255 - mean); // 0 at extremes, 127 mid
        return variance * (edge / 127);
      } catch { return 1; } // getImageData can throw on tainted canvas — accept frame.
    };

    const applyPoster = (url) => {
      if (poster) {
        poster.style.backgroundImage = `url(${url})`;
        poster.classList.add('ready');
      }
      try { v.setAttribute('poster', url); } catch {}
      if (loading) loading.style.display = 'none';
    };

    const tryNextCandidate = () => {
      if (posterDrawn) return;
      if (candidateIdx >= candidates.length) {
        // Out of candidates — use best snapshot we got, or just hide loader.
        if (lastSnapshot) { applyPoster(lastSnapshot.url); posterDrawn = true; }
        else if (loading) loading.style.display = 'none';
        return;
      }
      const frac = candidates[candidateIdx++];
      const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      const target = dur > 0 ? Math.min(dur - 0.05, Math.max(0.01, dur * frac)) : 0.08;
      try { v.currentTime = target; } catch { drawPoster(); }
    };

    const drawPoster = () => {
      if (posterDrawn || !posterArmed) return;
      try {
        const w = v.videoWidth, h = v.videoHeight;
        if (!w || !h) return;
        const c = document.createElement('canvas');
        const scale = Math.min(1, 720 / w);
        c.width = Math.max(2, Math.round(w * scale));
        c.height = Math.max(2, Math.round(h * scale));
        const ctx = c.getContext('2d');
        ctx.drawImage(v, 0, 0, c.width, c.height);
        const score = scoreFrame(ctx, c.width, c.height);
        const url = c.toDataURL('image/jpeg', 0.72);
        // Threshold tuned empirically: a near-black frame scores well under 50.
        const GOOD = 120;
        if (score >= GOOD || candidateIdx >= candidates.length) {
          applyPoster(url);
          posterDrawn = true;
        } else {
          if (!lastSnapshot || score > lastSnapshot.score) lastSnapshot = { url, score };
          tryNextCandidate();
        }
      } catch {
        // CORS or canvas-tainted (shouldn't happen for data: URLs / same origin).
        if (loading) loading.style.display = 'none';
      }
    };

    const onMeta = () => {
      if (loading) loading.style.display = 'none';
      if (durEl && isFinite(v.duration) && v.duration > 0) {
        durEl.textContent = fmtDuration(v.duration);
      }
      // Detect Telegram-style "video note": square (or near-square) clip
      // recorded from the front-facing camera at 480×480. Apply .is-note
      // so CSS can render the wrapper as a circle with our brand ring,
      // and swap the badge label. (May already have been pre-applied via
      // the `data-video-note="1"` hint from the renderer, in which case
      // this is a no-op.) Tolerance widened to 15% because some Android
      // cameras silently ignore the 480x480 constraint and pick e.g.
      // 640x480 or 720x720 close-but-not-square depending on sensor.
      try {
        const w = v.videoWidth, h = v.videoHeight;
        if (w && h && Math.abs(w - h) <= Math.max(2, Math.round(Math.min(w, h) * 0.15))) {
          wrap.classList.add('is-note');
          const icon = wrap.querySelector('.cv-icon');
          if (icon) icon.textContent = '🎥';
          const dur = wrap.querySelector('.cv-dur');
          if (dur && (!dur.textContent || dur.textContent === 'Video')) {
            dur.textContent = isFinite(v.duration) && v.duration > 0
              ? fmtDuration(v.duration) : 'Note';
          }
        }
      } catch {}
      // MediaRecorder webm/mp4 blobs from Chromium report duration=Infinity
      // until the player is forced to seek past the end. In that state the
      // subsequent fractional seek for poster capture quietly no-ops on
      // some Android WebViews, leaving us with no thumbnail at all. Force
      // duration to materialise first, then snapshot.
      const startCandidates = () => {
        // Try a few positions and keep the most visually interesting frame.
        // Middle-first because intros / outros are commonly fades from black.
        // Note videos are short and typically a face-cam — first frame is
        // already meaningful, so we lead with 0.05 to avoid the dead-air
        // mid-clip frame on a 1-2s clip.
        candidates = wrap.classList.contains('is-note')
          ? [0.05, 0.15, 0.35, 0.55]
          : [0.5, 0.35, 0.65, 0.2, 0.8, 0.05];
        candidateIdx = 0;
        posterArmed = true;
        tryNextCandidate();
      };
      if (!isFinite(v.duration) || v.duration <= 0) {
        let settled = false;
        const cont = () => { if (settled) return; settled = true; startCandidates(); };
        const onDur = () => { v.removeEventListener('durationchange', onDur); cont(); };
        v.addEventListener('durationchange', onDur, { once: true });
        try { v.currentTime = 1e9; } catch { cont(); }
        setTimeout(cont, 800);
      } else {
        startCandidates();
      }
    };

    if (v.readyState >= 1) onMeta();
    else v.addEventListener('loadedmetadata', onMeta, { once: true });

    // Each successful seek triggers another draw attempt; drawPoster decides
    // whether the frame is good enough or to advance to the next candidate.
    v.addEventListener('seeked', drawPoster);
    v.addEventListener('loadeddata', () => { if (!candidates.length) drawPoster(); });
    // Safety: if the browser never fires seeked (some Android WebViews on
    // data: URLs), fall back to a timer.
    setTimeout(() => { posterArmed = true; if (!posterDrawn) drawPoster(); }, 2500);

    if (overlay) {
      overlay.addEventListener('click', (e) => {
        e.stopPropagation();
        // Capture poster before play so a flash-of-black is impossible.
        drawPoster();
        wrap.classList.add('cv-playing');
        const isNote = wrap.classList.contains('is-note');
        // For video notes we keep the circular bubble and suppress native
        // controls (they'd render a square bar bursting out of the circle).
        // Tap-to-toggle is wired below.
        try { v.controls = !isNote; } catch {}
        try { v.muted = false; } catch {}

        // MediaRecorder-produced webm/mp4 blobs frequently report
        // `duration === Infinity` until the browser has been forced to
        // seek to the end (Chromium bug). In that state, setting
        // currentTime = 0 can be a no-op or throw, leaving the element
        // stuck at "no current frame" so the subsequent play() resolves
        // but no pixels move. Force the duration to materialise first
        // by seeking past the end, then rewind and play.
        const finishPlay = () => {
          const p = v.play();
          if (p && typeof p.catch === 'function') {
            p.catch(() => {
              // Browser blocked unmuted autoplay — retry muted (user can unmute via controls).
              try { v.muted = true; v.play().catch(() => {}); } catch {}
            });
          }
        };
        const needsDurationFix = !isFinite(v.duration) || v.duration <= 0;
        if (needsDurationFix) {
          let settled = false;
          const recover = () => {
            if (settled) return;
            settled = true;
            try { v.currentTime = 0; } catch {}
            finishPlay();
          };
          const onDur = () => {
            v.removeEventListener('durationchange', onDur);
            v.removeEventListener('seeked', onSeeked);
            recover();
          };
          const onSeeked = () => {
            v.removeEventListener('seeked', onSeeked);
            v.removeEventListener('durationchange', onDur);
            recover();
          };
          v.addEventListener('durationchange', onDur, { once: true });
          v.addEventListener('seeked', onSeeked, { once: true });
          try { v.currentTime = 1e9; } catch { recover(); }
          // Safety: if neither event fires (rare WebView), play anyway.
          setTimeout(recover, 600);
        } else {
          try { v.currentTime = 0; } catch {}
          finishPlay();
        }
      });
    }

    v.addEventListener('ended', () => {
      wrap.classList.remove('cv-playing');
      try { v.controls = false; } catch {}
    });
    // Video notes: tap the circle while playing to pause/resume (native
    // controls are hidden for the round bubble).
    v.addEventListener('click', (e) => {
      if (!wrap.classList.contains('is-note')) return;
      if (!wrap.classList.contains('cv-playing')) return;
      e.preventDefault();
      e.stopPropagation();
      if (v.paused) { v.play().catch(() => {}); }
      else { try { v.pause(); } catch {} }
    });
  }

  function scan(scope) {
    const root = scope || document;
    root.querySelectorAll('.chat-video:not([data-cv-init="1"])').forEach(init);
  }

  // MutationObserver auto-attaches to every chat-video added to the DOM, so
  // renderers in messages.js / dms.js / lazy-load paths don't need to remember
  // to call scan() themselves.
  function _startObserver() {
    if (typeof MutationObserver === 'undefined' || !document.body) return;
    try {
      scan(document);
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const node of m.addedNodes) {
            if (node && node.nodeType === 1) {
              if (node.matches && node.matches('.chat-video')) init(node);
              else if (node.querySelectorAll) scan(node);
            }
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _startObserver, { once: true });
  } else {
    _startObserver();
  }

  return { init, scan };
})();
window.ChatVideo = ChatVideo;

// Global alias so non-module callers can use it without going through UI.
window.blobToDataURL = (blob, onProgress) => UI.blobToDataURL(blob, onProgress);

// Robust clipboard writer. `navigator.clipboard` often fails in the Electron
// shell (no focus, non-secure origin, denied permission) and the async
// rejection was being silently swallowed by callers — so "Copy invite link"
// and "Share profile" looked like no-ops. Try each fallback in turn and
// only toast an error when all three fail.
async function copy(text) {
  text = String(text == null ? '' : text);
  if (!text) return false;
  // 1) Electron bridge if exposed by the preload script.
  try {
    if (typeof window !== 'undefined' && window.electronAPI
        && typeof window.electronAPI.copyText === 'function') {
      await window.electronAPI.copyText(text);
      return true;
    }
  } catch {}
  // 2) Async clipboard API (needs focus + secure context).
  try {
    if (navigator.clipboard && navigator.clipboard.writeText
        && (document.hasFocus ? document.hasFocus() : true)) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // 3) Legacy execCommand fallback via hidden <textarea>. Works in Electron
  //    even without secure origin, which is why it's kept around.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {}
  return false;
}

// Wire the self-status click in the sidebar to the picker.
window.openStatusPicker = (ev) => UI.openStatusPicker(ev);
window.toggleSelfStatusComposer = (open) => UI.toggleSelfStatusComposer(open);
window.submitSelfQuickStatus = () => UI.submitSelfQuickStatus();
window.cancelSelfQuickStatus = () => UI.cancelSelfQuickStatus();

/* ── Global avatar renderer (handles emoji + data: URLs + http URLs) ─────── */
function fmtAv(avatar, nick, size) {
  size = size || 32;
  const s = String(avatar || '');
  if (s && (s.startsWith('data:') || s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/'))) {
    return `<img src="${UI.escHtml(s)}" alt="" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;vertical-align:middle;display:inline-block">`;
  }
  if (s) return `<span style="font-size:${Math.round(size*0.9)}px;line-height:1;vertical-align:middle">${UI.escHtml(s)}</span>`;
  const initial = (nick || '?')[0].toUpperCase();
  const colors = ['#1a3a1a', '#2a1a3a', '#3a1a1a', '#1a2a3a', '#3a2a1a'];
  const idx = (nick || '').charCodeAt(0) % colors.length || 0;
  return `<span style="display:inline-flex;width:${size}px;height:${size}px;border-radius:50%;background:${colors[idx]};align-items:center;justify-content:center;font-size:${Math.round(size*0.5)}px;font-weight:700;color:#4caf50;vertical-align:middle">${UI.escHtml(initial)}</span>`;
}

/* Skeleton loading placeholders */
function skelList(rows, size) {
  rows = rows || 5; size = size || 38;
  let out = '';
  for (let i = 0; i < rows; i++) {
    out += `<div class="skel-row" style="display:flex;align-items:center;gap:10px;padding:8px 0">
      <div class="skel-circle" style="width:${size}px;height:${size}px;border-radius:50%"></div>
      <div style="flex:1">
        <div class="skel-line" style="width:60%;height:10px;margin-bottom:6px"></div>
        <div class="skel-line" style="width:40%;height:8px"></div>
      </div>
    </div>`;
  }
  return out;
}

/* Full-page loader */
function showPageLoader(label) {
  let el = document.getElementById('page-loader');
  if (!el) {
    el = document.createElement('div');
    el.id = 'page-loader';
    el.className = 'page-loader';
    el.innerHTML = `<div class="spinner-ring lg"></div><div class="pl-label" id="page-loader-label"></div>`;
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
  document.getElementById('page-loader-label').textContent = label || 'Loading…';
}
function hidePageLoader() {
  const el = document.getElementById('page-loader');
  if (el) el.style.display = 'none';
}

/* Inline spinner HTML snippet */
function inlineSpinner(label) {
  return `<div style="display:flex;align-items:center;justify-content:center;gap:10px;padding:28px;color:#888">
    <span class="spinner-ring"></span>
    <span style="font-size:13px">${UI.escHtml(label || 'Loading…')}</span>
  </div>`;
}

// ── Helpers used directly from HTML ──────────────────────────────────────────

function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
  if (id === 'modal-user-info') clearProfileCustomCss();
}

function openModal(id) {
  document.getElementById(id)?.classList.remove('hidden');
}

/* ── Global "click backdrop to close" + Esc-to-close ────────────────────────
   Discord-style: clicking on the dimmed area outside a modal dismisses it.
   Each modal can opt out by adding data-dismiss-on-backdrop="false" or by
   being listed in _noBackdropDismiss below (e.g. active calls). */
const _noBackdropDismiss = new Set([
  'modal-call',            // don't accidentally end a live call
  'modal-incoming-call',   // answer/decline only
  'modal-confirm',         // explicit Yes/No required
]);

document.addEventListener('click', (e) => {
  const overlay = e.target.closest?.('.modal-overlay');
  if (!overlay || e.target !== overlay) return;              // clicked inside content, ignore
  if (overlay.classList.contains('hidden')) return;
  if (overlay.dataset.dismissOnBackdrop === 'false') return;
  if (overlay.id && _noBackdropDismiss.has(overlay.id)) return;
  // An overlay might also carry its own onclick handler (some legacy modals
  // wire `if(event.target===this)closeModal(...)`). Skip those so we don't
  // fire closeModal twice.
  if (overlay.hasAttribute('onclick')) return;
  if (overlay.id) closeModal(overlay.id);
  else overlay.classList.add('hidden');
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Close the top-most visible modal overlay
  const open = Array.from(document.querySelectorAll('.modal-overlay:not(.hidden)'));
  if (!open.length) return;
  const top = open[open.length - 1];
  if (_noBackdropDismiss.has(top.id)) return;
  if (top.dataset.dismissOnBackdrop === 'false') return;
  if (top.id) closeModal(top.id);
  else top.classList.add('hidden');
});

/* ── Action Sheet (long-press context menu) ─────────────────────────── */
function showActionSheet(title, items) {
  // items: [{icon, label, danger?, onclick}]
  closeActionSheet();
  const sheet = document.createElement('div');
  sheet.className = 'action-sheet';
  sheet.onclick = e => { if (e.target === sheet) closeActionSheet(); };
  const panel = document.createElement('div');
  panel.className = 'as-panel';
  panel.onclick = e => e.stopPropagation();
  let html = title ? `<div class="as-title">${UI.escHtml(title)}</div>` : '';
  items.forEach((it, i) => {
    if (!it) return;
    // Stagger each item in for a smooth cascade entrance
    const delay = (40 + i * 28) + 'ms';
    html += `<button class="as-btn${it.danger ? ' danger' : ''}" data-idx="${i}" style="animation-delay:${delay}">
      <span class="as-ic">${it.icon || '•'}</span><span>${UI.escHtml(it.label)}</span>
    </button>`;
  });
  html += `<div class="as-cancel" onclick="closeActionSheet()">Cancel</div>`;
  panel.innerHTML = html;
  panel.querySelectorAll('.as-btn').forEach(b => {
    b.onclick = () => {
      const idx = +b.dataset.idx;
      try { navigator.vibrate?.(8); } catch {}
      const fn = items[idx]?.onclick;
      closeActionSheet();
      try { fn && fn(); } catch (e) { console.error(e); }
    };
  });
  sheet.appendChild(panel);
  document.body.appendChild(sheet);
  // Light haptic feedback if supported
  try { navigator.vibrate?.(15); } catch {}
}
function closeActionSheet() {
  document.querySelectorAll('.action-sheet').forEach(el => {
    if (el.classList.contains('closing')) return;
    el.classList.add('closing');
    setTimeout(() => el.remove(), 180);
  });
}

/* ── Long-press binder (works on both touch & mouse) ──────────────── */
function bindLongPress(el, handler, ms = 500) {
  if (!el || el._longPressBound) return;
  el._longPressBound = true;
  let timer = null, startX = 0, startY = 0, moved = false;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('touchstart', e => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; moved = false;
    timer = setTimeout(() => {
      if (!moved) {
        try { e.preventDefault(); } catch {}
        handler(e);
      }
    }, ms);
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > 12 || Math.abs(t.clientY - startY) > 12) {
      moved = true; clear();
    }
  }, { passive: true });
  el.addEventListener('touchend', clear);
  el.addEventListener('touchcancel', clear);
  // Context menu (desktop right-click)
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    handler(e);
  });
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function toggleUsersPanel() {
  const panel = document.getElementById('users-panel');
  if (!panel) return;
  
  // On mobile, use slide-in from right
  if (window.innerWidth <= 640) {
    panel.classList.toggle('mobile-open');
    document.getElementById('mobile-overlay')?.classList.toggle('active', panel.classList.contains('mobile-open'));
  } else {
    panel.classList.toggle('hidden');
  }
}

/* Chat header "⋯" overflow menu. Content depends on whether we're in a DM or a channel. */
function openChatMoreMenu() {
  const header = document.getElementById('chat-header');
  const isDM = !!header && header.classList.contains('is-dm');
  const items = [];

  if (isDM) {
    // Pull the active peer from dms.js
    const peer = (typeof _activeDM !== 'undefined' && _activeDM) ? _activeDM : null;
    const nick = peer?.nickname || State.currentRoom || '';
    const uid  = peer?.user_id || null;
    items.push({ icon: '👤', label: `View profile`,         onclick: () => showUserInfo(nick, uid) });
    items.push({ icon: '🔍', label: 'Search messages',       onclick: () => showSearchModal() });
    items.push({ icon: '📌', label: 'Pinned messages',       onclick: () => showPinnedMessages() });
    items.push({ icon: '⏱️', label: 'Disappearing messages', onclick: () => showDisappearSettings() });
    items.push({ icon: '🔒', label: 'Encryption info',       onclick: () => toggleEncryptionInfo() });
    items.push({ icon: '🚫', label: `Block @${nick}`, danger: true, onclick: () => _blockDmPeer(nick) });
    showActionSheet(`@${nick}`, items);
    return;
  }

  // Channel mode — compact overflow for power users
  const room = State.currentRoom;
  items.push({ icon: 'ℹ️', label: 'Channel info',       onclick: () => (typeof Rooms !== 'undefined') && Rooms.showChannelAbout(room) });
  items.push({ icon: '🔍', label: 'Search messages',    onclick: () => showSearchModal() });
  items.push({ icon: '📌', label: 'Pinned messages',    onclick: () => showPinnedMessages() });
  items.push({ icon: '🔗', label: 'Copy invite link',   onclick: () => (typeof quickShareChannel === 'function') && quickShareChannel() });
  items.push({ icon: '👥', label: 'Toggle members',     onclick: () => toggleUsersPanel() });
  showActionSheet(room ? `#${room}` : 'Channel', items);
}

async function _blockDmPeer(nickname) {
  if (!nickname) return;
  if (!confirm(`Block @${nickname}?\n\nThey won't be able to DM you or interact with you across FrogTalk.`)) return;
  try {
    const r = await apiFetch(`/api/friends/block/${encodeURIComponent(nickname)}`, 'POST');
    if (r.ok) {
      UI.showToast(`@${nickname} blocked`, 'success');
      if (typeof refreshBlockedCache === 'function') refreshBlockedCache();
      // Close the DM view
      if (typeof _activeDM !== 'undefined') _activeDM = null;
      if (typeof selectServer === 'function') selectServer('channels');
    } else {
      const d = await r.json().catch(() => ({}));
      UI.showToast(d.error || 'Failed to block user', 'error');
    }
  } catch {
    UI.showToast('Failed to block user', 'error');
  }
}

function toggleMobileSidebar() {
  // Close users panel if open
  document.getElementById('users-panel')?.classList.remove('mobile-open');
  document.getElementById('server-list')?.classList.remove('open');
  document.getElementById('sidebar')?.classList.add('open');
  document.getElementById('mobile-overlay')?.classList.add('active');
}

function toggleServerList() {
  const sl = document.getElementById('server-list');
  if (!sl) return;
  sl.classList.toggle('open');
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('users-panel')?.classList.remove('mobile-open');
  document.getElementById('mobile-overlay')?.classList.toggle('active', sl.classList.contains('open'));
}

function closeMobileSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('server-list')?.classList.remove('open');
  document.getElementById('users-panel')?.classList.remove('mobile-open');
  document.getElementById('mobile-overlay')?.classList.remove('active');
}

function filterChannels(q) {
  const qs = (q || '').trim();
  // Store the live query so Rooms.renderRooms can gate the "Show unjoined"
  // button behind an active search — no clutter when the sidebar is idle.
  try { State._channelSearchQuery = qs; } catch {}
  // When searching, auto-expand unjoined channels so matches can actually show.
  // When the search box is cleared, snap back to the joined-only view.
  try {
    State._showAllChannels = !!qs;
    if (typeof Rooms !== 'undefined' && typeof Rooms.renderRooms === 'function') {
      Rooms.renderRooms();
    } else if (typeof renderRooms === 'function') {
      renderRooms();
    }
  } catch {}
  const needle = qs.toLowerCase();
  const items = document.querySelectorAll('#channel-list .channel-item, #public-channels .channel-item');
  items.forEach(el => {
    el.style.display = !needle || el.textContent.toLowerCase().includes(needle) ? '' : 'none';
  });
}

function clearAuthError() {
  document.getElementById('auth-error').textContent = '';
}

function switchAuthTab(tab) {
  const isReg = tab === 'register';
  document.getElementById('tab-login').classList.toggle('active', !isReg);
  document.getElementById('tab-register').classList.toggle('active', isReg);
  document.getElementById('auth-password2').style.display = isReg ? 'block' : 'none';
  const captchaBox = document.getElementById('auth-captcha-box');
  if (captchaBox) captchaBox.style.display = isReg ? 'block' : 'none';
  if (isReg) loadCaptcha();
  clearAuthError();
}

let _captchaId = null;

async function loadCaptcha() {
  _captchaId = null;
  const img = document.getElementById('auth-captcha-img');
  const txt = document.getElementById('auth-captcha-text');
  const ans = document.getElementById('auth-captcha-answer');
  if (ans) ans.value = '';
  try {
    const res = await fetch('/api/auth/captcha');
    const data = await res.json();
    _captchaId = data.challenge_id;
    if (data.image) {
      if (img) { img.src = data.image; img.style.display = 'block'; }
      if (txt) txt.style.display = 'none';
    } else if (data.text_challenge) {
      if (img) img.style.display = 'none';
      if (txt) { txt.textContent = data.text_challenge; txt.style.display = 'block'; }
    }
  } catch {
    if (txt) { txt.textContent = 'Failed to load CAPTCHA'; txt.style.display = 'block'; }
  }
}

async function doAuth() {
  const nickname = document.getElementById('auth-nickname').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl = document.getElementById('auth-error');
  const isReg = document.getElementById('tab-register').classList.contains('active');

  if (!nickname || !password) { errEl.textContent = 'Please fill in all fields'; return; }

  if (isReg) {
    const pw2 = document.getElementById('auth-password2').value;
    if (password !== pw2) { errEl.textContent = 'Passwords do not match'; return; }
    const captchaAnswer = (document.getElementById('auth-captcha-answer')?.value || '').trim();
    if (!captchaAnswer || !_captchaId) { errEl.textContent = 'Please complete the CAPTCHA'; return; }
  }

  const endpoint = isReg ? '/api/auth/register-secure' : '/api/auth/login';
  const body = isReg
    ? { nickname, password, captcha_id: _captchaId, captcha_answer: document.getElementById('auth-captcha-answer').value.trim() }
    : { nickname, password };
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Auth failed';
      if (isReg) loadCaptcha();
      return;
    }
    State.token = data.token;
    State.user = { id: data.user_id, nickname: data.nickname, avatar: data.avatar, bio: data.bio, is_admin: data.is_admin };
    State.save();
    App.launch();
  } catch {
    errEl.textContent = 'Network error. Please try again.';
  }
}

async function doLogout() {
  try { WS.disconnect(); } catch {}
  // Tell server to kill our session
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'X-Session-Token': State.token || '' },
      keepalive: true
    });
  } catch {}
  // Purge caches (service worker) so auth-bearing HTML isn't served offline
  try {
    if (window.caches && caches.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch {}
  State.clear();
  // Hard redirect to login (cache-bust) so Android WebView doesn't re-hydrate
  const here = location.pathname.startsWith('/app') ? '/app' : '/';
  location.replace(here + '?logout=' + Date.now());
}

// Sidebar home: go back to the last/current channel
function goHomeChannel() {
  // Close any mobile overlays first
  try { closeMobileSidebar && closeMobileSidebar(); } catch {}
  const room = State.currentRoom;
  const type = State.currentRoomType || 'public';
  if (room && type !== 'dm') {
    if (typeof Rooms !== 'undefined' && Rooms.switchToRoom) Rooms.switchToRoom(room, type);
    else if (typeof switchToRoom === 'function') switchToRoom(room, type);
  } else {
    // Fallback: first joined room or the empty-state onboarding
    try { App.openFirstAvailableRoom?.(); }
    catch { App.showEmptyOnboarding?.(); }
  }
  if (typeof selectServer === 'function') selectServer('main');
}

// Profile/Settings modal
let _currentSettingsTab = 'profile';
let _networkProbeResults = [];
let _networkSelectedServer = null;
let _networkBuildTrustByBase = {};
let _networkLocalBuildInfo = null;
let _networkCurrentServerInfo = null;

function ensureNetworkPaneContent() {
  const pane = document.getElementById('set-pane-network');
  if (!pane) return;

  pane.innerHTML = `
    <div style="font-size:13px;color:#4caf50;font-weight:600;margin-bottom:8px">🌐 Network Settings</div>
    <div style="font-size:12px;color:#666;margin-bottom:12px">Pick how FrogTalk chooses a server. Auto mode probes known servers and prefers healthy low-latency options.</div>

    <div style="background:linear-gradient(135deg,#0f1f16,#0d1712);border:1px solid #234532;border-radius:10px;padding:10px;margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div>
          <div style="font-size:12px;color:#9bd6ab;font-weight:700">Build Integrity</div>
          <div id="network-build-local" style="font-size:11px;color:#78a187;margin-top:3px">Checking local build hash...</div>
        </div>
        <button class="modal-btn secondary" type="button" onclick="verifyNetworkBuildIntegrity()" style="padding:8px 12px;min-width:180px">Verify Server Legitimacy</button>
      </div>
      <div id="network-trust-summary" style="font-size:11px;color:#6f8e77;margin-top:8px">Probe servers, then verify they run the same legitimate copy.</div>
    </div>

    <div style="background:#1a3a1a;border:1px solid #2a5a2a;border-radius:8px;padding:10px;margin-bottom:12px">
      <div style="font-size:11px;color:#93ab9a;line-height:1.5">
        💡 <strong>Run your own server:</strong> FrogTalk is open-source and free to self-host for complete privacy and control.<br>
        <span style="margin-top:6px;display:inline-block">
          Setup guide: <a href="https://github.com/deadinternetfox/frogtalk#docker" target="_blank" rel="noopener noreferrer" style="color:#4caf50;text-decoration:underline;font-weight:600">Docker</a> • 
          <a href="/docs/api" target="_blank" style="color:#4caf50;text-decoration:underline;font-weight:600">API docs</a> • 
          <a href="/docs/node" target="_blank" style="color:#4caf50;text-decoration:underline;font-weight:600">Run a node doc</a> • 
          <a href="/app" target="_blank" style="color:#4caf50;text-decoration:underline;font-weight:600">Open app</a> • 
          <a href="https://github.com/deadinternetfox/frogtalk" target="_blank" rel="noopener noreferrer" style="color:#4caf50;text-decoration:underline;font-weight:600">GitHub</a>
        </span>
      </div>
    </div>

    <label class="modal-label" style="margin-top:0">Connection Mode</label>
    <select id="network-mode" class="modal-input" style="color:#e0e0e0;background:#0d0d0d">
      <option value="auto">Auto (recommended)</option>
      <option value="official">Official only</option>
      <option value="custom">Custom server URL</option>
    </select>

    <label style="display:flex;align-items:center;justify-content:space-between;padding:8px 0 12px;cursor:pointer">
      <div>
        <div style="font-size:13px;color:#e0e0e0">Prefer onion endpoints</div>
        <div style="font-size:11px;color:#666;margin-top:2px">Use Tor/onion URLs when available during auto-select</div>
      </div>
      <input type="checkbox" id="network-prefer-onion" style="width:18px;height:18px;cursor:pointer;accent-color:#4caf50">
    </label>

    <label class="modal-label">Custom Server URL</label>
    <input id="network-custom-url" class="modal-input" placeholder="https://your-frogtalk-server.example">

    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
      <button class="modal-btn secondary" type="button" onclick="refreshNetworkServers()" style="flex:1;min-width:160px">Probe Servers</button>
      <button class="modal-btn secondary" type="button" onclick="runAutoNetworkSelect()" style="flex:1;min-width:160px">Auto Select Best</button>
    </div>

    <div id="network-current-selection" style="margin-top:10px;font-size:12px;color:#9ec59e"></div>

    <div style="margin-top:10px;background:#0d0d0d;border:1px solid #1e1e1e;border-radius:8px;padding:8px;max-height:220px;overflow-y:auto" id="network-servers-list">
      <div style="color:#666;font-size:12px;text-align:center;padding:8px">Click "Probe Servers" or "Auto Select Best" to discover available FrogTalk instances with location and ping.</div>
    </div>

    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="modal-btn primary" type="button" onclick="saveNetworkSettings()" style="flex:1;min-width:180px">Save Network Routing</button>
      <button class="modal-btn secondary" type="button" onclick="connectToSelectedServer()" style="flex:1;min-width:180px">Connect To Selected Server</button>
    </div>
    <div style="margin-top:6px;font-size:11px;color:#687d74">This saves only Network tab options. The modal "Save" button still saves your account/profile settings.</div>
  `;
}

function switchSettingsTab(tab) {
  _currentSettingsTab = tab;
  // Update tab buttons
  document.querySelectorAll('.settings-tab').forEach(btn => btn.classList.remove('active'));
  const tabBtn = document.getElementById(`set-tab-${tab}`);
  if (tabBtn) tabBtn.classList.add('active');
  // Show/hide panes with animation
  ['profile', 'social', 'privacy', 'notif', 'appear', 'style', 'network', 'dev', 'account'].forEach(p => {
    const pane = document.getElementById(`set-pane-${p}`);
    if (pane) {
      if (p === tab) {
        pane.style.setProperty('display', 'block', 'important');
        pane.style.setProperty('visibility', 'visible', 'important');
        pane.style.setProperty('opacity', '1', 'important');
        pane.style.setProperty('height', 'auto', 'important');
        pane.style.setProperty('min-height', '220px', 'important');
        pane.classList.add('modal-tab-pane');
      } else {
        pane.style.setProperty('display', 'none', 'important');
        pane.classList.remove('modal-tab-pane');
      }
    }
  });
  // Load blocked users when privacy tab opened
  if (tab === 'privacy') loadBlockedUsers();
  // Load API keys / bots when dev tab opened
  if (tab === 'dev') { loadApiKeys(); loadBots(); }
  // Load social stats
  if (tab === 'social') loadSocialStats();
  // Load network settings and latest health checks
  if (tab === 'network') {
    // Rebuild every time in case stale/corrupted DOM or conflicting CSS hid controls.
    ensureNetworkPaneContent();
    loadNetworkSettings();
    loadLocalBuildIntegrity();
  }
  // Update char count on style tab
  if (tab === 'style') updateCssCharCount();
  // Pre-fill custom theme color inputs and highlight the saved theme button
  if (tab === 'appear') {
    try { loadCustomThemeIntoInputs(); } catch {}
    try {
      const saved = document.body.dataset.theme || localStorage.getItem('frogtalk-theme') || 'dark';
      document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.style.borderColor = btn.dataset.theme === saved ? '#4caf50' : '#333';
      });
    } catch {}
  }
}

function _normalizeNetworkUrl(url) {
  const raw = (url || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/$/, '');
}

function _networkAppUrl(url) {
  const base = _normalizeNetworkUrl(url || '');
  if (!base) return '';
  try {
    return new URL('/app', base).toString();
  } catch {
    return `${base}/app`;
  }
}

function _isOnionNetworkUrl(url) {
  return /\.onion(?=\/|$)/i.test(String(url || '').trim());
}

function _isTorPreferred() {
  const checkbox = document.getElementById('network-prefer-onion');
  if (checkbox) return !!checkbox.checked;
  return localStorage.getItem('ft_network_prefer_onion') === '1';
}

function _preferredNetworkUrl(server) {
  const onion = _normalizeNetworkUrl(server?.onion_url || '');
  const base = _normalizeNetworkUrl(server?.base_url || '');
  return (_isTorPreferred() && onion) ? onion : (base || onion);
}

function _networkCurrentServerEntry() {
  const connectedBase = _normalizeNetworkUrl(window.location.origin || '');
  const onion = _normalizeNetworkUrl(_networkCurrentServerInfo?.onion_url || '');
  const base = _normalizeNetworkUrl(_networkCurrentServerInfo?.base_url || connectedBase || '');
  const publicAddr = (_isTorPreferred() && onion) ? onion : (base || onion || connectedBase);
  if (!publicAddr) return null;
  return {
    server_id: _networkCurrentServerInfo?.server?.server_id || 'current-connected',
    display_name: _networkCurrentServerInfo?.server?.display_name || 'Current Server',
    base_url: base || connectedBase,
    onion_url: onion,
    region: _guessNetworkRegionFromBaseUrl(base || connectedBase),
    official: 0,
    trust_tier: 'community',
    healthy: true,
    latency_ms: 0,
    probe_error: null,
    _public_addr: publicAddr,
  };
}

function _getConnectedServerBaseUrl() {
  try {
    return _networkCurrentServerEntry()?._public_addr || _normalizeNetworkUrl(window.location.origin || '');
  } catch {
    return '';
  }
}

async function _loadCurrentNetworkStatus() {
  try {
    const res = await apiFetch('/api/network/status');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'status unavailable');
    _networkCurrentServerInfo = data || null;
  } catch {
    _networkCurrentServerInfo = null;
  }
}

function _networkAddressRow(address, tone = 'tor') {
  const appUrl = _networkAppUrl(address || '');
  const safe = UI.escHtml(appUrl || address || '');
  const isTor = tone === 'tor';
  const color = isTor ? '#7fd6a2' : '#9aa3aa';
  const bg = isTor ? 'rgba(51,122,82,.12)' : 'transparent';
  return `
    <div style="display:flex;align-items:center;gap:6px;min-width:0;margin-top:4px;background:${bg};border:${isTor ? '1px solid rgba(92,171,118,.22)' : 'none'};border-radius:8px;padding:${isTor ? '6px 8px' : '0'}">
      <button type="button" onclick="UI.copy('${safe}').then(ok=>UI.showToast(ok?'App link copied':'Could not copy address', ok?'success':'error'))" title="Copy app link" style="flex:1;min-width:0;background:none;border:none;color:${color};padding:0;text-align:left;cursor:pointer;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
        ${safe}
      </button>
      <button type="button" onclick="window.open('${safe}','_blank','noopener')" title="Open app" style="flex:0 0 auto;background:#101010;border:1px solid rgba(255,255,255,.08);color:${color};border-radius:6px;padding:2px 6px;font-size:10px;cursor:pointer">Open</button>
      <button type="button" onclick="UI.copy('${safe}').then(ok=>UI.showToast(ok?'App link copied':'Could not copy address', ok?'success':'error'))" title="Copy app link" style="flex:0 0 auto;background:#101010;border:1px solid rgba(255,255,255,.08);color:${color};border-radius:6px;padding:2px 6px;font-size:10px;cursor:pointer">Copy</button>
    </div>
  `;
}

async function _showTorModeDialog({ title, body, address = '', confirmLabel = '', showCancel = false } = {}) {
  return await new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:12000;background:rgba(3,8,6,.72);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:18px';
    const card = document.createElement('div');
    card.style.cssText = 'width:min(560px,96vw);background:linear-gradient(180deg,#0f1714 0%,#101312 100%);border:1px solid rgba(95,181,121,.24);border-radius:20px;box-shadow:0 28px 80px rgba(0,0,0,.58);overflow:hidden';
    const safeAddress = UI.escHtml(address || '');
    card.innerHTML = `
      <div style="padding:18px 20px 14px;background:radial-gradient(circle at top left,rgba(91,196,124,.16),transparent 55%)">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:44px;height:44px;border-radius:14px;background:linear-gradient(135deg,#173626,#0d1812);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;letter-spacing:.06em;color:#85d7a0;border:1px solid rgba(95,181,121,.25)">TOR</div>
          <div>
            <div style="font-size:18px;color:#e7f5eb;font-weight:800;letter-spacing:.01em">${UI.escHtml(title || 'Tor Mode')}</div>
            <div style="font-size:12px;color:#8fb198;margin-top:3px">Use hidden services instead of public clearnet routing.</div>
          </div>
        </div>
      </div>
      <div style="padding:0 20px 20px">
        <div style="font-size:13px;line-height:1.65;color:#c8d6cc">${body || ''}</div>
        ${safeAddress ? `<div style="margin-top:14px;background:#0c1110;border:1px solid rgba(95,181,121,.18);border-radius:14px;padding:12px 12px 10px"><div style="font-size:11px;color:#84ad8f;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Tor Address</div>${_networkAddressRow(safeAddress, 'tor')}</div>` : ''}
        <div style="margin-top:14px;background:rgba(18,23,22,.92);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:12px 14px;font-size:12px;color:#9eb0a6;line-height:1.6">
          You need a Tor-connected browser or system Tor setup to open <span style="color:#d7efe0">.onion</span> addresses. FrogTalk will try account handoff automatically, but onion switches can still require a fresh login.
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:18px">
          <button type="button" data-role="copy" style="background:#101615;border:1px solid rgba(95,181,121,.2);color:#bfe3ca;border-radius:10px;padding:10px 14px;font-size:12px;font-weight:700;cursor:pointer;${safeAddress ? '' : 'display:none;'}">Copy Address</button>
          ${showCancel ? '<button type="button" data-role="cancel" style="background:#171717;border:1px solid #2a2a2a;color:#b7b7b7;border-radius:10px;padding:10px 14px;font-size:12px;font-weight:700;cursor:pointer">Stay Here</button>' : ''}
          <button type="button" data-role="confirm" style="background:linear-gradient(135deg,#5cc06f,#4ca65f);border:none;color:#071008;border-radius:10px;padding:10px 16px;font-size:12px;font-weight:800;cursor:pointer">${UI.escHtml(confirmLabel || 'Got it')}</button>
        </div>
      </div>
    `;
    overlay.appendChild(card);
    const cleanup = (value) => {
      overlay.remove();
      resolve(value);
    };
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay && showCancel) cleanup(false);
    });
    card.querySelector('[data-role="confirm"]').onclick = () => cleanup(true);
    if (showCancel) card.querySelector('[data-role="cancel"]').onclick = () => cleanup(false);
    const copyBtn = card.querySelector('[data-role="copy"]');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        const ok = await UI.copy(address || '');
        UI.showToast(ok ? 'Tor address copied' : 'Could not copy address', ok ? 'success' : 'error');
      };
    }
    document.body.appendChild(overlay);
  });
}

async function handleNetworkPreferOnionChange(showPopup = true) {
  const torPreferred = _isTorPreferred();
  _renderNetworkServersList();
  _renderNetworkSelection();
  if (!torPreferred || !showPopup) return;
  const current = _networkSelectedServer?.onion_url || _networkCurrentServerEntry()?.onion_url || '';
  await _showTorModeDialog({
    title: 'Tor Mode Enabled',
    body: 'FrogTalk will now prefer onion nodes in discovery, probing, and server switching. Location hints are hidden in Tor mode and onion-capable nodes get a dedicated badge.',
    address: current,
    confirmLabel: 'Use Tor Mode',
    showCancel: false,
  });
}

function _guessNetworkRegionFromBaseUrl(baseUrl) {
  const base = _normalizeNetworkUrl(baseUrl || '');
  if (!base) return '';
  let host = '';
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    host = String(base).toLowerCase();
  }
  if (host === 'frogtalk.xyz' || host.endsWith('.frogtalk.xyz')) return 'Spain';
  if (host.endsWith('.es')) return 'Spain';
  if (host.endsWith('.fr')) return 'France';
  if (host.endsWith('.de')) return 'Germany';
  if (host.endsWith('.it')) return 'Italy';
  if (host.endsWith('.nl')) return 'Netherlands';
  if (host.endsWith('.pt')) return 'Portugal';
  if (host.endsWith('.pl')) return 'Poland';
  if (host.endsWith('.uk') || host.endsWith('.co.uk')) return 'United Kingdom';
  if (host.endsWith('.jp')) return 'Japan';
  if (host.endsWith('.sg')) return 'Singapore';
  if (host.endsWith('.in')) return 'India';
  if (host.endsWith('.au')) return 'Australia';
  if (host.endsWith('.ca')) return 'Canada';
  if (host.endsWith('.us')) return 'United States';
  return '';
}

function _shortHash(h) {
  const s = String(h || '').trim();
  if (!s) return 'n/a';
  if (s.length <= 16) return s;
  return `${s.slice(0, 10)}...${s.slice(-8)}`;
}

function _renderNetworkBuildHeader() {
  const el = document.getElementById('network-build-local');
  if (!el) return;
  if (!_networkLocalBuildInfo || !_networkLocalBuildInfo.build_hash) {
    el.textContent = 'Local build hash unavailable';
    return;
  }
  const official = _networkLocalBuildInfo.official ? 'official copy' : 'unverified copy';
  el.textContent = `Local ${_networkLocalBuildInfo.version || 'web'} · ${_shortHash(_networkLocalBuildInfo.build_hash)} · ${official}`;
}

async function loadLocalBuildIntegrity() {
  try {
    const res = await apiFetch('/api/network/build/local');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'build status unavailable');
    _networkLocalBuildInfo = data;
  } catch {
    _networkLocalBuildInfo = null;
  }
  _renderNetworkBuildHeader();
}

async function verifyNetworkBuildIntegrity() {
  if (!_networkProbeResults.length) {
    await refreshNetworkServers();
  }
  const summaryEl = document.getElementById('network-trust-summary');
  if (summaryEl) summaryEl.textContent = 'Verifying peer build hashes...';

  try {
    const urls = [...new Set(_networkProbeResults.map(s => _normalizeNetworkUrl(s.onion_url || s.base_url || '')).filter(Boolean))];
    const res = await apiFetch('/api/network/build/verify-peers', 'POST', { base_urls: urls });
    const data = await res.json();
    if (!res.ok) {
      UI.showToast(data.error || 'Verification failed', 'error');
      if (summaryEl) summaryEl.textContent = 'Verification failed. Try again.';
      return;
    }
    _networkLocalBuildInfo = data.local || _networkLocalBuildInfo;
    _renderNetworkBuildHeader();
    _networkBuildTrustByBase = {};
    for (const row of (data.results || [])) {
      const base = _normalizeNetworkUrl(row.base_url || '');
      if (base) _networkBuildTrustByBase[base] = row;
    }
    const same = (data.results || []).filter(r => r.same_hash).length;
    const total = (data.results || []).length;
    if (summaryEl) summaryEl.textContent = `Verified ${same}/${total} servers running the same build hash.`;
    _renderNetworkServersList();
    UI.showToast('Build legitimacy verification completed', 'success');
  } catch {
    if (summaryEl) summaryEl.textContent = 'Verification failed due to network error.';
    UI.showToast('Build verification failed', 'error');
  }
}

function _prettyNetworkRegion(region) {
  const raw = String(region || '').trim();
  if (!raw) return 'Unknown';
  const k = raw.toLowerCase();
  const map = {
    'es': 'Spain',
    'spain': 'Spain',
    'uk': 'United Kingdom',
    'gb': 'United Kingdom',
    'fr': 'France',
    'de': 'Germany',
    'it': 'Italy',
    'nl': 'Netherlands',
    'pl': 'Poland',
    'pt': 'Portugal',
    'us': 'United States',
    'usa': 'United States',
    'ca': 'Canada',
    'au': 'Australia',
    'in': 'India',
    'sg': 'Singapore',
    'jp': 'Japan',
  };
  return map[k] || raw;
}

function _networkRegionLabel(server, fallbackBase) {
  const region = _prettyNetworkRegion(server?.region || _guessNetworkRegionFromBaseUrl(fallbackBase));
  if (region && region !== 'Unknown') return region;
  if (server?.onion_url || _isOnionNetworkUrl(fallbackBase || '')) return 'Tor Hidden Service';
  return 'Unknown';
}

function _renderNetworkSelection() {
  const infoEl = document.getElementById('network-current-selection');
  if (!infoEl) return;
  if (_networkSelectedServer && (_networkSelectedServer.base_url || _networkSelectedServer.onion_url)) {
    const addr = _networkAppUrl(_preferredNetworkUrl(_networkSelectedServer));
    const via = _isOnionNetworkUrl(addr) ? ' via Tor' : '';
    infoEl.textContent = `Selected: ${_networkSelectedServer.display_name || _networkSelectedServer.server_id} (${addr}${via})`;
    return;
  }
  const saved = localStorage.getItem('ft_network_selected') || '';
  infoEl.textContent = saved ? `Selected: ${_networkAppUrl(saved) || saved}` : 'Selected: current server';
}

function _renderNetworkServersList() {
  const list = document.getElementById('network-servers-list');
  if (!list) return;
  if (!_networkProbeResults.length) {
    list.innerHTML = '<div style="color:#666;font-size:12px;text-align:center;padding:16px 8px">Click "Probe Servers" or "Auto Select Best" to discover available FrogTalk instances</div>';
    return;
  }
  const connectedBase = _getConnectedServerBaseUrl();
  list.innerHTML = _networkProbeResults.map((s) => {
    const publicAddr = _preferredNetworkUrl(s);
    const torPreferred = _isTorPreferred();
    const isOnion = _isOnionNetworkUrl(publicAddr) || !!s.onion_url;
    const healthy = !!s.healthy;
    const latency = s.latency_ms == null ? 'n/a' : `${s.latency_ms} ms`;
    const region = _networkRegionLabel(s, s.base_url || publicAddr);
    const statusColor = healthy ? '#4caf50' : '#f44336';
    const statusDot = healthy ? '#3ecf65' : '#f44336';
    const selected = _networkSelectedServer && _networkSelectedServer.server_id === s.server_id;
    const isConnected = connectedBase && publicAddr === connectedBase;
    const trust = _networkBuildTrustByBase[publicAddr] || null;
    const trustChecked = !!trust;
    const isSameHash = !!(trust && trust.same_hash);
    const isOfficialCopy = !!(trust && trust.remote_official);
    const trustError = trust && trust.error;

    // Card accent: green for connected, purple-green tint for onion, default for others
    const cardBorder = isConnected
      ? '1px solid rgba(62,207,101,.35)'
      : isOnion
        ? '1px solid rgba(133,215,160,.18)'
        : '1px solid rgba(255,255,255,.055)';
    const cardBg = isConnected
      ? 'linear-gradient(135deg,rgba(23,52,39,.7) 0%,rgba(15,27,20,.85) 100%)'
      : isOnion
        ? 'linear-gradient(135deg,rgba(20,38,29,.65) 0%,rgba(13,19,16,.85) 100%)'
        : 'rgba(18,20,19,.5)';
    const cardShadow = isConnected
      ? '0 2px 16px rgba(62,207,101,.08)'
      : isOnion
        ? '0 2px 12px rgba(133,215,160,.05)'
        : 'none';

    const chips = [];
    if (isConnected) chips.push('<span style="padding:2px 8px;border-radius:999px;background:rgba(62,207,101,.15);border:1px solid rgba(62,207,101,.3);color:#88e7a4;font-size:10px;font-weight:700;letter-spacing:.03em">CONNECTED</span>');
    if ((s.official || 0) || s.trust_tier === 'official') chips.push('<span style="padding:2px 8px;border-radius:999px;background:rgba(52,130,255,.12);border:1px solid rgba(52,130,255,.25);color:#8fc7ff;font-size:10px;font-weight:700;letter-spacing:.03em">OFFICIAL DIR</span>');
    if (s.onion_url) chips.push('<span style="padding:2px 8px;border-radius:999px;background:rgba(62,170,101,.13);border:1px solid rgba(133,215,160,.28);color:#85d7a0;font-size:10px;font-weight:700;letter-spacing:.03em">TOR</span>');
    if (torPreferred && s.onion_url) chips.push('<span style="padding:2px 8px;border-radius:999px;background:rgba(120,180,40,.13);border:1px solid rgba(180,230,80,.22);color:#d7f08a;font-size:10px;font-weight:700;letter-spacing:.03em">TOR MODE</span>');
    if (trustChecked && isSameHash) chips.push('<span style="padding:2px 8px;border-radius:999px;background:rgba(30,58,36,.8);border:1px solid rgba(80,220,120,.22);color:#8fffaa;font-size:10px;font-weight:700;letter-spacing:.03em">✓ SAME HASH</span>');
    if (trustChecked && isOfficialCopy) chips.push('<span style="padding:2px 8px;border-radius:999px;background:rgba(47,42,22,.8);border:1px solid rgba(255,200,60,.2);color:#ffd66d;font-size:10px;font-weight:700;letter-spacing:.03em">LEGIT COPY</span>');
    if (trustChecked && !isSameHash && !trustError) chips.push('<span style="padding:2px 8px;border-radius:999px;background:rgba(58,29,29,.8);border:1px solid rgba(255,80,80,.2);color:#ff9f9f;font-size:10px;font-weight:700;letter-spacing:.03em">⚠ HASH MISMATCH</span>');
    if (trustError) chips.push('<span style="padding:2px 8px;border-radius:999px;background:rgba(53,38,26,.8);border:1px solid rgba(255,150,80,.2);color:#ffbf8f;font-size:10px;font-weight:700;letter-spacing:.03em">VERIFY ERROR</span>');

    const isTorRegion = region === 'Tor Hidden Service';
    const locationRow = (!torPreferred && region && !isTorRegion)
      ? `<div style="font-size:11px;color:#7a94a6;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">📍 ${UI.escHtml(region)}</div>`
      : '';
    const addressRow = _isOnionNetworkUrl(publicAddr)
      ? _networkAddressRow(publicAddr, 'tor')
      : `<div style="font-size:11px;color:#566870;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${UI.escHtml(publicAddr || '')}</div>`;

    const latencyColor = s.latency_ms == null ? '#555' : s.latency_ms < 200 ? '#4caf50' : s.latency_ms < 600 ? '#f0c040' : '#f07060';

    return `
      <label class="network-server-row ${selected ? 'is-selected' : ''}"
        style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;
               border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;transition:background .15s;
               background:${cardBg};border:${cardBorder};border-radius:12px;margin:4px 0;
               box-shadow:${cardShadow};">
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          <input type="radio" name="network-server-choice" ${selected ? 'checked' : ''}
            style="accent-color:#3ecf65;width:15px;height:15px;flex-shrink:0"
            onchange="selectNetworkServer('${String(s.server_id).replace(/'/g, "\\'")}')">
          <div style="min-width:0">
            <div style="font-size:13px;font-weight:600;color:#dde8e2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.01em">${UI.escHtml(s.display_name || s.server_id || 'Unknown')}</div>
            ${locationRow}
            ${addressRow}
            ${chips.length ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">${chips.join('')}</div>` : ''}
          </div>
        </div>
        <div style="flex-shrink:0;text-align:right;min-width:80px">
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:5px;margin-bottom:3px">
            <span style="width:7px;height:7px;border-radius:50%;background:${statusDot};display:inline-block;box-shadow:0 0 6px ${statusDot}55"></span>
            <span style="font-size:11px;color:${statusColor};font-weight:600">${healthy ? 'healthy' : 'down'}</span>
          </div>
          <div style="font-size:11px;color:${latencyColor};font-weight:500">${latency === 'n/a' ? '— ms' : latency}</div>
        </div>
      </label>
    `;
  }).join('');
}

function selectNetworkServer(serverId) {
  _networkSelectedServer = _networkProbeResults.find(s => String(s.server_id) === String(serverId)) || null;
  _renderNetworkServersList();
  _renderNetworkSelection();
  saveNetworkSettings(true);
}

async function refreshNetworkServers() {
  const mode = document.getElementById('network-mode')?.value || 'auto';
  const officialOnly = mode === 'official' ? 1 : 0;
  try {
    // Always request onion metadata so capability badges remain accurate even when clearnet is preferred.
    const res = await apiFetch(`/api/network/probe?official_only=${officialOnly}&include_onion=1`);
    const data = await res.json();
    if (!res.ok) {
      UI.showToast(data.error || 'Failed to probe network', 'error');
      return;
    }
    _networkProbeResults = data.servers || [];
    const connectedBase = _getConnectedServerBaseUrl();
    const currentServer = _networkCurrentServerEntry();
    if (connectedBase && currentServer && !_networkProbeResults.some(s => _preferredNetworkUrl(s) === connectedBase)) {
      _networkProbeResults.unshift(currentServer);
    }
    if (!_networkSelectedServer && _networkProbeResults.length) {
      _networkSelectedServer = _networkProbeResults.find(s => s.healthy) || _networkProbeResults[0];
    }
    _renderNetworkServersList();
    _renderNetworkSelection();
  } catch {
    UI.showToast('Network probe failed', 'error');
  }
}

async function runAutoNetworkSelect() {
  const mode = document.getElementById('network-mode')?.value || 'auto';
  const preferOnion = document.getElementById('network-prefer-onion')?.checked ? 1 : 0;
  const officialOnly = mode === 'official' ? 1 : 0;
  try {
    const res = await apiFetch(`/api/network/auto-select?official_only=${officialOnly}&prefer_tor=${preferOnion}`);
    const data = await res.json();
    if (!res.ok) {
      UI.showToast(data.error || 'Auto selection failed', 'error');
      return;
    }
    _networkProbeResults = data.candidates || [];
    const connectedBase = _getConnectedServerBaseUrl();
    const currentServer = _networkCurrentServerEntry();
    if (connectedBase && currentServer && !_networkProbeResults.some(s => _preferredNetworkUrl(s) === connectedBase)) {
      _networkProbeResults.unshift(currentServer);
    }
    _networkSelectedServer = data.selected || _networkSelectedServer;
    _renderNetworkServersList();
    _renderNetworkSelection();
    if (_networkSelectedServer) UI.showToast('Best server selected', 'success');
    else UI.showToast('No healthy server found', 'error');
  } catch {
    UI.showToast('Auto selection failed', 'error');
  }
}

function saveNetworkSettings(silent = false) {
  const mode = document.getElementById('network-mode')?.value || 'auto';
  const preferOnion = document.getElementById('network-prefer-onion')?.checked ? '1' : '0';
  const customUrl = _normalizeNetworkUrl(document.getElementById('network-custom-url')?.value || '');
  localStorage.setItem('ft_network_mode', mode);
  localStorage.setItem('ft_network_prefer_onion', preferOnion);
  localStorage.setItem('ft_network_custom_url', customUrl);
  const selectedAddr = _preferredNetworkUrl(_networkSelectedServer || {});
  if (selectedAddr) {
    localStorage.setItem('ft_network_selected', selectedAddr);
  }
  if (!silent) UI.showToast('Network preferences saved', 'success');
}

async function connectToSelectedServer() {
  const mode = document.getElementById('network-mode')?.value || 'auto';
  const customUrl = _normalizeNetworkUrl(document.getElementById('network-custom-url')?.value || '');
  let target = '';
  if (mode === 'custom') {
    target = customUrl;
    if (!target) {
      UI.showToast('Enter a custom server URL first', 'error');
      return;
    }
  } else if (_networkSelectedServer?.onion_url || _networkSelectedServer?.base_url) {
    target = _preferredNetworkUrl(_networkSelectedServer);
  } else {
    target = localStorage.getItem('ft_network_selected') || '';
  }
  if (!target) {
    UI.showToast('No server selected yet', 'error');
    return;
  }
  saveNetworkSettings(true);

  if (_isOnionNetworkUrl(target)) {
    const confirmed = await _showTorModeDialog({
      title: 'Open Onion Node',
      body: `You are switching FrogTalk to a Tor hidden service. If your browser is not connected to Tor, this address will not open. Automatic account handoff will be attempted first, but manual login can still be required after the switch.`,
      address: target,
      confirmLabel: 'Open Onion Node',
      showCancel: true,
    });
    if (!confirmed) return;
  }

  let switchTicket = '';
  try {
    const targetBase = _normalizeNetworkUrl(target || '');
    const hereBase = _normalizeNetworkUrl(window.location.origin || '');
    if (targetBase && hereBase && targetBase !== hereBase && State.token) {
      const r = await fetch('/api/auth/federation-ticket', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': State.token || '',
        },
        body: JSON.stringify({ target_base_url: targetBase, target_url: targetBase }),
      });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        switchTicket = String(d.ticket || '');
      }
    }
  } catch {}

  if (switchTicket) {
    try {
      window.name = JSON.stringify({
        ft_switch_ticket: switchTicket,
        ts: Date.now(),
      });
    } catch {}
  }

  try {
    // Sessions are per-node; clear stale token before hopping servers so the
    // next node starts in a clean auth state instead of carrying invalid creds.
    State.clear();
  } catch {}
  try {
    const next = new URL('/app', target);
    next.searchParams.set('switched', '1');
    next.searchParams.set('register', '1');
    if (_isOnionNetworkUrl(target)) next.searchParams.set('tor', '1');
    if (window.location?.origin) next.searchParams.set('from', window.location.origin);
    window.location.href = next.toString();
  } catch {
    window.location.href = target;
  }
}

async function loadNetworkSettings() {
  const modeEl = document.getElementById('network-mode');
  const onionEl = document.getElementById('network-prefer-onion');
  const customEl = document.getElementById('network-custom-url');
  if (!modeEl || !onionEl || !customEl) return;
  modeEl.value = localStorage.getItem('ft_network_mode') || 'auto';
  onionEl.checked = localStorage.getItem('ft_network_prefer_onion') === '1';
  customEl.value = localStorage.getItem('ft_network_custom_url') || '';
  if (!onionEl.dataset.bound) {
    onionEl.addEventListener('change', () => {
      saveNetworkSettings(true);
      handleNetworkPreferOnionChange(true);
    });
    onionEl.dataset.bound = '1';
  }
  _networkSelectedServer = null;
  await _loadCurrentNetworkStatus();
  const currentServer = _networkCurrentServerEntry();
  _networkProbeResults = currentServer ? [currentServer] : [];
  _networkSelectedServer = _networkProbeResults[0] || null;
  _renderNetworkServersList();
  _renderNetworkSelection();
  _renderNetworkBuildHeader();
  // Only auto-probe if user previously had saved servers
  const saved = localStorage.getItem('ft_network_selected') || '';
  if (saved) {
    _networkProbeResults = [];
    _renderNetworkServersList();
    await refreshNetworkServers();
    _networkSelectedServer = _networkProbeResults.find(s => _normalizeNetworkUrl(s.onion_url || s.base_url || '') === saved) || _networkSelectedServer;
    _renderNetworkServersList();
    _renderNetworkSelection();
  }
}

async function loadBlockedUsers() {
  const list = document.getElementById('blocked-users-list');
  try {
    const res = await fetch('/api/users/me/blocked', {
      headers: { 'X-Session-Token': State.token }
    });
    const data = await res.json();
    // Mirror into State so filters hide blocked authors everywhere
    try {
      State.blockedNicks = new Set(
        (data.blocked || [])
          .map(u => (u.nickname || '').toLowerCase())
          .filter(Boolean)
      );
    } catch {}
    if (!list) return;
    if (!data.blocked || data.blocked.length === 0) {
      list.innerHTML = '<div style="color:#666;font-size:13px;text-align:center;padding:8px">No blocked users</div>';
      return;
    }
    list.innerHTML = data.blocked.map(u => `
      <div class="blocked-user-item" style="display:flex;align-items:center;justify-content:space-between;padding:6px;border-bottom:1px solid #1a1a1a">
        <div style="display:flex;align-items:center;gap:8px">
          ${UI.avatarEl(u.avatar, u.nickname, 28)}
          <span style="color:#ccc;font-size:13px">${UI.escHtml(u.nickname)}</span>
        </div>
        <button onclick="unblockUser(${u.user_id})" style="background:#333;border:none;color:#f44336;padding:4px 8px;border-radius:4px;font-size:12px;cursor:pointer">Unblock</button>
      </div>
    `).join('');
  } catch {
    list.innerHTML = '<div style="color:#f44336;font-size:13px;text-align:center">Failed to load</div>';
  }
}

async function unblockUser(userId) {
  try {
    await fetch(`/api/users/${userId}/block`, {
      method: 'DELETE',
      headers: { 'X-Session-Token': State.token }
    });
    loadBlockedUsers();
    if (typeof refreshBlockedCache === 'function') refreshBlockedCache();
    UI.showToast('User unblocked', 'success');
  } catch {
    UI.showToast('Failed to unblock', 'error');
  }
}

// Lightweight cache refresh used by app.js on boot and after block/unblock.
// Safe to call when no #blocked-users-list exists in the DOM.
async function refreshBlockedCache() {
  try {
    const res = await fetch('/api/users/me/blocked', {
      headers: { 'X-Session-Token': State.token || '' }
    });
    if (!res.ok) return;
    const data = await res.json();
    State.blockedNicks = new Set(
      (data.blocked || [])
        .map(u => (u.nickname || '').toLowerCase())
        .filter(Boolean)
    );
  } catch {}
}
window.refreshBlockedCache = refreshBlockedCache;

// ---------------------------------------------------------------------------
// Developer Tab — API Keys & Bots
// ---------------------------------------------------------------------------
async function loadApiKeys() {
  const list = document.getElementById('api-keys-list');
  if (!list) return;
  try {
    const res = await apiFetch('/api/developer/keys');
    const data = await res.json();
    const keys = data.keys || [];
    if (keys.length === 0) {
      list.innerHTML = '<div style="color:#666;font-size:13px;text-align:center;padding:8px">No API keys yet</div>';
      return;
    }
    list.innerHTML = keys.map(k => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px;border-bottom:1px solid #1a1a1a">
        <div>
          <div style="color:#e0e0e0;font-size:13px;font-weight:600">${UI.escHtml(k.name)}</div>
          <div style="color:#666;font-size:11px">${k.key_hash ? k.key_hash.substring(0,12) + '...' : 'Created ' + (k.created_at || '').substring(0,10)}</div>
        </div>
        <button onclick="revokeApiKey(${k.id})" style="background:#333;border:none;color:#f44336;padding:4px 8px;border-radius:4px;font-size:12px;cursor:pointer">Revoke</button>
      </div>
    `).join('');
  } catch {
    list.innerHTML = '<div style="color:#f44336;font-size:13px;text-align:center">Failed to load</div>';
  }
}

async function createApiKey() {
  const name = prompt('API key name:');
  if (!name || !name.trim()) return;
  try {
    const res = await apiFetch('/api/developer/keys', 'POST', { name: name.trim(), permissions: ['read', 'write'] });
    const data = await res.json();
    if (!res.ok) { UI.showToast(data.error || 'Failed', 'error'); return; }
    // Show the key once
    const keyModal = document.createElement('div');
    keyModal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center';
    keyModal.innerHTML = `<div style="background:#1e1e1e;border:1px solid #4caf50;border-radius:12px;padding:24px;max-width:500px;width:90%">
      <div style="font-size:16px;font-weight:700;color:#4caf50;margin-bottom:12px">🔑 API Key Created</div>
      <div style="font-size:12px;color:#f44336;margin-bottom:12px;font-weight:600">Copy this key now — it won't be shown again!</div>
      <div style="background:#0d0d0d;border:1px solid #333;border-radius:8px;padding:12px;font-family:monospace;font-size:13px;color:#4caf50;word-break:break-all;cursor:pointer" onclick="navigator.clipboard.writeText('${data.key}');this.style.borderColor='#4caf50'">${data.key}</div>
      <button onclick="this.parentElement.parentElement.remove()" style="margin-top:16px;width:100%;background:#4caf50;color:#000;border:none;border-radius:8px;padding:10px;font-weight:700;cursor:pointer">Done</button>
    </div>`;
    document.body.appendChild(keyModal);
    loadApiKeys();
  } catch {
    UI.showToast('Network error', 'error');
  }
}

async function revokeApiKey(keyId) {
  if (!confirm('Revoke this API key? Any bots using it will stop working.')) return;
  try {
    await apiFetch(`/api/developer/keys/${keyId}`, 'DELETE');
    loadApiKeys();
    UI.showToast('Key revoked', 'success');
  } catch {
    UI.showToast('Failed to revoke', 'error');
  }
}

async function loadBots() {
  const list = document.getElementById('bots-list');
  if (!list) return;
  try {
    const res = await apiFetch('/api/developer/bots');
    const data = await res.json();
    const bots = data.bots || [];
    if (bots.length === 0) {
      list.innerHTML = '<div style="color:#666;font-size:13px;text-align:center;padding:8px">No bots yet</div>';
      return;
    }
    list.innerHTML = bots.map(b => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px;border-bottom:1px solid #1a1a1a">
        <div style="display:flex;align-items:center;gap:8px">
          ${UI.avatarEl(b.avatar, b.name, 28)}
          <div>
            <div style="color:#e0e0e0;font-size:13px;font-weight:600">${UI.escHtml(b.name)}</div>
            <div style="color:#666;font-size:11px">${b.is_public ? '🌐 Public' : '🔒 Private'}</div>
          </div>
        </div>
        <button onclick="deleteBot(${b.id})" style="background:#333;border:none;color:#f44336;padding:4px 8px;border-radius:4px;font-size:12px;cursor:pointer">Delete</button>
      </div>
    `).join('');
  } catch {
    list.innerHTML = '<div style="color:#f44336;font-size:13px;text-align:center">Failed to load</div>';
  }
}

async function createBot() {
  const nameInput = document.getElementById('new-bot-name');
  const name = (nameInput?.value || '').trim();
  if (!name || name.length < 2) { UI.showToast('Bot name must be at least 2 characters', 'error'); return; }
  try {
    const res = await apiFetch('/api/developer/bots', 'POST', { name });
    const data = await res.json();
    if (!res.ok) { UI.showToast(data.error || 'Failed', 'error'); return; }
    nameInput.value = '';
    UI.showToast(`Bot "${name}" created!`, 'success');
    if (data.api_key) {
      const keyModal = document.createElement('div');
      keyModal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center';
      keyModal.innerHTML = `<div style="background:#1e1e1e;border:1px solid #4caf50;border-radius:12px;padding:24px;max-width:500px;width:90%">
        <div style="font-size:16px;font-weight:700;color:#4caf50;margin-bottom:12px">🤖 Bot "${UI.escHtml(name)}" Created</div>
        <div style="font-size:12px;color:#f44336;margin-bottom:12px;font-weight:600">Save this bot token — it won't be shown again!</div>
        <div style="background:#0d0d0d;border:1px solid #333;border-radius:8px;padding:12px;font-family:monospace;font-size:12px;color:#4caf50;word-break:break-all;cursor:pointer" onclick="navigator.clipboard.writeText('${data.api_key}');this.style.borderColor='#4caf50'">${data.api_key}</div>
        <button onclick="this.parentElement.parentElement.remove()" style="margin-top:16px;width:100%;background:#4caf50;color:#000;border:none;border-radius:8px;padding:10px;font-weight:700;cursor:pointer">Done</button>
      </div>`;
      document.body.appendChild(keyModal);
    }
    loadBots();
  } catch {
    UI.showToast('Network error', 'error');
  }
}

async function deleteBot(botId) {
  if (!confirm('Delete this bot permanently?')) return;
  try {
    await apiFetch(`/api/developer/bots/${botId}`, 'DELETE');
    loadBots();
    UI.showToast('Bot deleted', 'success');
  } catch {
    UI.showToast('Failed to delete', 'error');
  }
}

let _themePreviewOriginal = null; // theme before preview started

function selectTheme(theme) {
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.style.borderColor = btn.dataset.theme === theme ? '#4caf50' : '#333';
  });
  // Save current theme before preview
  if (!_themePreviewOriginal) {
    _themePreviewOriginal = localStorage.getItem('frogtalk-theme') || 'dark';
  }
  // Apply visually without saving
  _applyThemeVars(theme);
  document.body.dataset.theme = theme;
  // Close the settings modal so user can see the app
  closeModal('modal-profile');
  // Show preview bar
  _showThemePreviewBar(theme);
}

function _showThemePreviewBar(theme) {
  let bar = document.getElementById('theme-preview-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'theme-preview-bar';
    bar.style.cssText = `position:fixed;bottom:0;left:0;right:0;z-index:9999;
      background:linear-gradient(135deg,#1a1a1a,#222);border-top:2px solid #4caf50;
      padding:12px 20px;display:flex;align-items:center;justify-content:center;gap:16px;
      box-shadow:0 -4px 24px rgba(0,0,0,.6);animation:slideUpBar .25s ease`;
    document.body.appendChild(bar);
  }
  bar.innerHTML = `
    <span style="color:#e0e0e0;font-size:14px;font-weight:600">🎨 Previewing <em style="color:#4caf50">${UI.escHtml(theme)}</em> theme</span>
    <button onclick="confirmThemePreview()" style="background:#4caf50;color:#000;border:none;border-radius:8px;padding:8px 20px;font-weight:700;cursor:pointer;font-size:13px">✓ Save</button>
    <button onclick="cancelThemePreview()" style="background:#333;color:#e0e0e0;border:1px solid #555;border-radius:8px;padding:8px 20px;font-weight:600;cursor:pointer;font-size:13px">✕ Cancel</button>
  `;
}

function confirmThemePreview() {
  const theme = document.body.dataset.theme || 'dark';
  localStorage.setItem('frogtalk-theme', theme);
  _themePreviewOriginal = null;
  const bar = document.getElementById('theme-preview-bar');
  if (bar) bar.remove();
  toast('Theme saved!', 'success');
}

function cancelThemePreview() {
  const original = _themePreviewOriginal || 'dark';
  _applyThemeVars(original);
  document.body.dataset.theme = original;
  localStorage.setItem('frogtalk-theme', original);
  _themePreviewOriginal = null;
  const bar = document.getElementById('theme-preview-bar');
  if (bar) bar.remove();
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  localStorage.setItem('frogtalk-theme', theme);
  _applyThemeVars(theme);
}

function _applyThemeVars(theme) {
  const root = document.documentElement;
  if (theme === 'custom') {
    try {
      const d = JSON.parse(localStorage.getItem('frogtalk-custom-theme') || '{}');
      if (d.accent) root.style.setProperty('--accent-color', d.accent);
      if (d.bg) root.style.setProperty('--bg-color', d.bg);
      if (d.surface) root.style.setProperty('--surface-color', d.surface);
      if (d.border) root.style.setProperty('--border-color', d.border);
      if (d.text) root.style.setProperty('--text-color', d.text);
      if (d.muted) root.style.setProperty('--text-muted', d.muted);
      return;
    } catch {}
  }
  const themes = {
    dark: { bg: '#0d0d0d', surface: '#1e1e1e', text: '#e0e0e0', muted: '#888', border: '#2a2a2a', accent: '#4caf50' },
    light: { bg: '#f5f5f5', surface: '#ffffff', text: '#333333', muted: '#666', border: '#ddd', accent: '#4caf50' },
    midnight: { bg: '#0a0a1a', surface: '#151528', text: '#c0c0ff', muted: '#8888aa', border: '#252540', accent: '#6666ff' },
    forest: { bg: '#0a1a0a', surface: '#152015', text: '#c0e0c0', muted: '#88aa88', border: '#254025', accent: '#4caf50' },
    cyberpunk: { bg: '#0a000f', surface: '#1a0a24', text: '#e0d0ff', muted: '#9988bb', border: '#3a1a50', accent: '#bf5af2' },
    ocean: { bg: '#040d18', surface: '#0a1628', text: '#c8ddf0', muted: '#6899bb', border: '#162a45', accent: '#2196f3' },
    sunset: { bg: '#1a0a05', surface: '#2a1208', text: '#f0d8c8', muted: '#bb8866', border: '#3a2010', accent: '#ff7043' },
    rose: { bg: '#1a0814', surface: '#240a18', text: '#f5d8e6', muted: '#bb8aa3', border: '#3a1a2a', accent: '#ff6b9d' },
    solarized: { bg: '#002b36', surface: '#073642', text: '#93a1a1', muted: '#586e75', border: '#0a4a55', accent: '#b58900' },
    mono: { bg: '#0a0a0a', surface: '#1a1a1a', text: '#e0e0e0', muted: '#888', border: '#2a2a2a', accent: '#cccccc' }
  };
  const t = themes[theme] || themes.dark;
  root.style.setProperty('--bg-color', t.bg);
  root.style.setProperty('--surface-color', t.surface);
  root.style.setProperty('--text-color', t.text);
  root.style.setProperty('--text-muted', t.muted);
  root.style.setProperty('--border-color', t.border);
  root.style.setProperty('--accent-color', t.accent);
}

// ── Custom theme editor ──────────────────────────────────────────────────────
function _customThemeFromInputs() {
  const get = id => (document.getElementById(id) || {}).value;
  return {
    accent: get('ct-accent'),
    bg: get('ct-bg'),
    surface: get('ct-surface'),
    border: get('ct-border'),
    text: get('ct-text'),
    muted: get('ct-muted')
  };
}
function updateCustomTheme() {
  const root = document.documentElement;
  const d = _customThemeFromInputs();
  if (d.accent) root.style.setProperty('--accent-color', d.accent);
  if (d.bg) root.style.setProperty('--bg-color', d.bg);
  if (d.surface) root.style.setProperty('--surface-color', d.surface);
  if (d.border) root.style.setProperty('--border-color', d.border);
  if (d.text) root.style.setProperty('--text-color', d.text);
  if (d.muted) root.style.setProperty('--text-muted', d.muted);
  document.body.dataset.theme = 'custom';
}
function saveCustomTheme() {
  const d = _customThemeFromInputs();
  localStorage.setItem('frogtalk-custom-theme', JSON.stringify(d));
  localStorage.setItem('frogtalk-theme', 'custom');
  document.body.dataset.theme = 'custom';
  updateCustomTheme();
  if (typeof toast === 'function') toast('Custom theme saved!', 'success');
  else if (typeof UI !== 'undefined' && UI.showToast) UI.showToast('Custom theme saved!', 'success');
}
function resetCustomTheme() {
  localStorage.removeItem('frogtalk-custom-theme');
  applyTheme('dark');
  loadCustomThemeIntoInputs();
  if (typeof toast === 'function') toast('Reset to Dark', 'success');
}
function exportThemeJson() {
  const d = _customThemeFromInputs();
  const json = JSON.stringify(d, null, 2);
  if (navigator.clipboard) navigator.clipboard.writeText(json).catch(() => {});
  prompt('Theme JSON (copied to clipboard if supported):', json);
}
function importThemeJson() {
  const txt = prompt('Paste theme JSON:');
  if (!txt) return;
  try {
    const d = JSON.parse(txt);
    ['accent', 'bg', 'surface', 'border', 'text', 'muted'].forEach(k => {
      const el = document.getElementById('ct-' + k);
      if (el && typeof d[k] === 'string' && /^#[0-9a-f]{3,8}$/i.test(d[k])) el.value = d[k];
    });
    saveCustomTheme();
  } catch {
    if (typeof toast === 'function') toast('Invalid theme JSON', 'error');
  }
}
function loadCustomThemeIntoInputs() {
  const raw = localStorage.getItem('frogtalk-custom-theme');
  if (!raw) return;
  try {
    const d = JSON.parse(raw);
    ['accent', 'bg', 'surface', 'border', 'text', 'muted'].forEach(k => {
      const el = document.getElementById('ct-' + k);
      if (el && d[k]) el.value = d[k];
    });
  } catch {}
}
// Expose globally so onclick=... handlers in index.html can find them.
try {
  window.updateCustomTheme = updateCustomTheme;
  window.saveCustomTheme = saveCustomTheme;
  window.resetCustomTheme = resetCustomTheme;
  window.exportThemeJson = exportThemeJson;
  window.importThemeJson = importThemeJson;
  window.loadCustomThemeIntoInputs = loadCustomThemeIntoInputs;
} catch {}

async function confirmDeleteAccount() {
  const confirmed = confirm('⚠️ Are you absolutely sure you want to delete your account?\n\nThis action CANNOT be undone. All your messages, friends, and data will be permanently deleted.');
  if (!confirmed) return;
  
  const password = prompt('Enter your password to confirm account deletion:');
  if (!password) return;
  
  try {
    const res = await fetch('/api/auth/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) {
      UI.showToast(data.error || 'Failed to delete account', 'error');
      return;
    }
    UI.showToast('Account deleted. Goodbye! 🐸', 'success');
    setTimeout(() => {
      State.clear();
      location.reload();
    }, 2000);
  } catch {
    UI.showToast('Network error', 'error');
  }
}

let _profileCustomCssEl = null;

function clearProfileCustomCss() {
  if (_profileCustomCssEl) {
    _profileCustomCssEl.remove();
    _profileCustomCssEl = null;
  }
}

function scopeProfileCustomCss(css) {
  if (!css) return '';
  return css
    .split('}')
    .map(rule => rule.trim())
    .filter(Boolean)
    .map(rule => {
      const braceIdx = rule.indexOf('{');
      if (braceIdx === -1) return '';
      const selectors = rule.slice(0, braceIdx).trim();
      const body = rule.slice(braceIdx + 1).trim();
      if (!selectors || !body || selectors.includes('@')) return '';
      const scopedSelectors = selectors
        .split(',')
        .map(selector => selector.trim())
        .filter(Boolean)
        .map(selector => `#modal-user-info ${selector}`)
        .join(', ');
      return scopedSelectors ? `${scopedSelectors} { ${body} }` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function applyProfileCustomCss(css) {
  clearProfileCustomCss();
  const scopedCss = scopeProfileCustomCss(css || '');
  if (!scopedCss) return;
  const styleEl = document.createElement('style');
  styleEl.id = 'profile-custom-style';
  styleEl.textContent = scopedCss;
  document.head.appendChild(styleEl);
  _profileCustomCssEl = styleEl;
}

// ── CSS Theme Presets ──────────────────────────────────────────────────────
const CSS_PRESETS = {
  cyberpunk: `/* 🌆 Cyberpunk — Neon purple & pink glow */
.profile-header {
  background: linear-gradient(135deg, #0a001a 0%, #1a0033 40%, #33004d 100%) !important;
}
.userinfo-nick {
  color: #bf5af2 !important;
  text-shadow: 0 0 12px #bf5af2, 0 0 30px rgba(191,90,242,.4) !important;
  font-weight: 800 !important;
}
.profile-avatar-large {
  border: 3px solid #bf5af2 !important;
  box-shadow: 0 0 20px rgba(191,90,242,.5), 0 0 40px rgba(191,90,242,.2) !important;
}
.wall-post {
  background: rgba(20,0,40,.6) !important;
  border: 1px solid rgba(191,90,242,.3) !important;
  box-shadow: 0 0 15px rgba(191,90,242,.1) !important;
}
.wall-post:hover {
  border-color: #ff2d95 !important;
  box-shadow: 0 0 20px rgba(255,45,149,.2) !important;
}
.sp-banner {
  background: linear-gradient(135deg, #1a003a, #33005a, #4d0066) !important;
}
.sp-nick {
  color: #e040fb !important;
  text-shadow: 0 0 10px #e040fb !important;
}
.sp-tag {
  background: rgba(191,90,242,.2) !important;
  color: #e040fb !important;
  border: 1px solid rgba(191,90,242,.4) !important;
}`,

  ocean: `/* 🌊 Ocean — Deep blue waves & teal */
.profile-header {
  background: linear-gradient(135deg, #001520 0%, #002a40 40%, #003d5c 100%) !important;
}
.userinfo-nick {
  color: #64d2ff !important;
  text-shadow: 0 0 10px rgba(100,210,255,.5) !important;
  font-weight: 700 !important;
}
.profile-avatar-large {
  border: 3px solid #0097a7 !important;
  box-shadow: 0 0 20px rgba(0,151,167,.4) !important;
}
.wall-post {
  background: rgba(0,30,50,.6) !important;
  border: 1px solid rgba(100,210,255,.2) !important;
}
.wall-post:hover {
  border-color: #64d2ff !important;
}
.sp-banner {
  background: linear-gradient(180deg, #001a2e 0%, #003355 50%, #004d80 100%) !important;
}
.sp-nick {
  color: #4dd0e1 !important;
  text-shadow: 0 0 8px rgba(77,208,225,.4) !important;
}
.sp-tag {
  background: rgba(0,151,167,.2) !important;
  color: #4dd0e1 !important;
}
.sp-bio {
  color: #80cbc4 !important;
}`,

  retrowave: `/* 🕹️ Retrowave — 80s synthwave sunset */
.profile-header {
  background: linear-gradient(180deg, #0a001a 0%, #1a0030 30%, #4a0050 50%, #ff006e 80%, #ff8c00 100%) !important;
}
.userinfo-nick {
  color: #ff6b9d !important;
  text-shadow: 0 0 15px #ff006e, 0 0 30px rgba(255,0,110,.3) !important;
  font-weight: 800 !important;
  letter-spacing: 2px !important;
  text-transform: uppercase !important;
}
.profile-avatar-large {
  border: 3px solid #ff006e !important;
  box-shadow: 0 0 25px rgba(255,0,110,.5), inset 0 0 10px rgba(255,0,110,.2) !important;
}
.wall-post {
  background: rgba(26,0,48,.7) !important;
  border: 1px solid rgba(255,107,157,.3) !important;
}
.sp-banner {
  background: linear-gradient(180deg, #0d001a, #2a0040, #5c0060, #ff006e, #ff8c00) !important;
}
.sp-nick {
  color: #ff6bde !important;
  text-shadow: 0 0 12px #ff006e !important;
  text-transform: uppercase !important;
  letter-spacing: 3px !important;
}
.sp-tag {
  background: rgba(255,0,110,.2) !important;
  color: #ff6b9d !important;
  border: 1px solid rgba(255,0,110,.4) !important;
}`,

  sakura: `/* 🌸 Sakura — Cherry blossom pink */
.profile-header {
  background: linear-gradient(135deg, #1a0a12 0%, #2a1018 40%, #3a1520 100%) !important;
}
.userinfo-nick {
  color: #ffb7c5 !important;
  text-shadow: 0 0 8px rgba(255,183,197,.4) !important;
  font-weight: 600 !important;
}
.profile-avatar-large {
  border: 3px solid #ffb7c5 !important;
  box-shadow: 0 0 15px rgba(255,183,197,.3) !important;
}
.wall-post {
  background: rgba(30,10,18,.8) !important;
  border: 1px solid rgba(255,183,197,.2) !important;
}
.wall-post:hover {
  border-color: #ffb7c5 !important;
}
.sp-banner {
  background: linear-gradient(135deg, #1a0a12, #3a1520, #4d1a2a) !important;
}
.sp-nick {
  color: #ffb7c5 !important;
}
.sp-tag {
  background: rgba(255,183,197,.15) !important;
  color: #ffcdd2 !important;
}
.sp-bio {
  color: #e8a0b0 !important;
}`,

  hacker: `/* 💀 Hacker — Matrix-style green terminal */
.profile-header {
  background: #000 !important;
  border-bottom: 1px solid #003300 !important;
}
.userinfo-nick {
  color: #00ff41 !important;
  text-shadow: 0 0 10px #00ff41, 0 0 25px rgba(0,255,65,.3) !important;
  font-family: 'Courier New', monospace !important;
  font-weight: 700 !important;
  letter-spacing: 1px !important;
}
.userinfo-nick::before {
  content: '> ' !important;
  color: #005500 !important;
}
.profile-avatar-large {
  border: 2px solid #00ff41 !important;
  box-shadow: 0 0 20px rgba(0,255,65,.4), inset 0 0 30px rgba(0,255,65,.1) !important;
}
.wall-post {
  background: rgba(0,10,0,.8) !important;
  border: 1px solid #003300 !important;
  font-family: 'Courier New', monospace !important;
}
.sp-banner {
  background: linear-gradient(180deg, #000000, #001a00, #003300) !important;
}
.sp-nick {
  color: #00ff41 !important;
  text-shadow: 0 0 10px #00ff41 !important;
  font-family: 'Courier New', monospace !important;
}
.sp-nick::before {
  content: '~/users/' !important;
  color: #006600 !important;
  font-size: 0.7em !important;
}
.sp-tag {
  background: #001a00 !important;
  color: #00ff41 !important;
  border: 1px solid #003300 !important;
  font-family: monospace !important;
}`,

  golden: `/* 👑 Royal Gold — Luxury gold & dark */
.profile-header {
  background: linear-gradient(135deg, #0a0800 0%, #1a1400 40%, #2a2000 100%) !important;
  border-bottom: 2px solid #ffd700 !important;
}
.userinfo-nick {
  color: #ffd700 !important;
  text-shadow: 0 0 12px rgba(255,215,0,.5), 0 2px 4px rgba(0,0,0,.8) !important;
  font-weight: 800 !important;
}
.profile-avatar-large {
  border: 3px solid #ffd700 !important;
  box-shadow: 0 0 20px rgba(255,215,0,.4) !important;
}
.wall-post {
  background: rgba(20,16,0,.7) !important;
  border: 1px solid rgba(255,215,0,.25) !important;
}
.wall-post:hover {
  border-color: #ffd700 !important;
}
.sp-banner {
  background: linear-gradient(135deg, #0a0800, #1a1200, #2a1e00) !important;
  border-bottom: 2px solid #ffd700 !important;
}
.sp-nick {
  color: #ffd700 !important;
  text-shadow: 0 0 15px rgba(255,215,0,.5) !important;
}
.sp-tag {
  background: rgba(255,215,0,.15) !important;
  color: #ffd700 !important;
  border: 1px solid rgba(255,215,0,.3) !important;
}`,

  lava: `/* 🌋 Lava — Molten reds & orange */
.profile-header {
  background: linear-gradient(180deg, #0a0000 0%, #1a0500 30%, #330a00 50%, #4d1500 100%) !important;
}
.userinfo-nick {
  color: #ff5722 !important;
  text-shadow: 0 0 12px rgba(255,87,34,.6), 0 0 25px rgba(255,152,0,.3) !important;
  font-weight: 800 !important;
}
.profile-avatar-large {
  border: 3px solid #ff5722 !important;
  box-shadow: 0 0 20px rgba(255,87,34,.5), 0 0 40px rgba(255,152,0,.2) !important;
}
.wall-post {
  background: rgba(20,5,0,.8) !important;
  border: 1px solid rgba(255,87,34,.25) !important;
}
.wall-post:hover {
  border-color: #ff9800 !important;
  box-shadow: 0 0 15px rgba(255,152,0,.2) !important;
}
.sp-banner {
  background: linear-gradient(180deg, #0a0000, #1a0500, #330a00, #4d1500) !important;
}
.sp-nick {
  color: #ff5722 !important;
  text-shadow: 0 0 12px #ff5722, 0 0 25px rgba(255,152,0,.4) !important;
}
.sp-tag {
  background: rgba(255,87,34,.2) !important;
  color: #ff8a65 !important;
  border: 1px solid rgba(255,87,34,.3) !important;
}`,
};

function applyCssPreset(name) {
  const textarea = document.getElementById('profile-custom-css');
  if (!textarea) return;
  if (name === 'none') {
    textarea.value = '';
  } else {
    textarea.value = CSS_PRESETS[name] || '';
  }
  updateCssCharCount();
  // Highlight selected preset button
  document.querySelectorAll('.css-preset-btn').forEach(btn => {
    btn.style.borderColor = '#222';
  });
  event.currentTarget.style.borderColor = '#4caf50';
}

function updateCssCharCount() {
  const textarea = document.getElementById('profile-custom-css');
  const counter = document.getElementById('css-char-count');
  if (textarea && counter) {
    const len = textarea.value.length;
    counter.textContent = `${len} / 10240`;
    counter.style.color = len > 9000 ? '#ff5722' : len > 7000 ? '#ff9800' : '#555';
  }
}

// Scope a chunk of user CSS to a chosen container ID. Mirrors scopeProfileCustomCss
// but lets us point at the live preview card instead of #modal-user-info.
function scopeCssToContainer(css, containerId) {
  if (!css || !containerId) return '';
  return css
    .split('}')
    .map(rule => rule.trim())
    .filter(Boolean)
    .map(rule => {
      const braceIdx = rule.indexOf('{');
      if (braceIdx === -1) return '';
      const selectors = rule.slice(0, braceIdx).trim();
      const body = rule.slice(braceIdx + 1).trim();
      if (!selectors || !body || selectors.includes('@')) return '';
      const scoped = selectors
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => `#${containerId} ${s}`)
        .join(', ');
      return scoped ? `${scoped} { ${body} }` : '';
    })
    .filter(Boolean)
    .join('\n');
}

let _cssPreviewStyleEl = null;
let _cssPreviewInputBound = false;
let _cssPreviewKeyHandler = null;

function _renderCssPreviewStyle() {
  const css = document.getElementById('profile-custom-css')?.value || '';
  const scoped = scopeCssToContainer(css, 'css-preview-card');
  if (!_cssPreviewStyleEl) {
    _cssPreviewStyleEl = document.createElement('style');
    _cssPreviewStyleEl.id = 'css-preview-style';
    document.head.appendChild(_cssPreviewStyleEl);
  }
  _cssPreviewStyleEl.textContent = scoped;
}

function _populateCssPreviewIdentity() {
  try {
    const u = State.user || {};
    const nameEl = document.getElementById('css-preview-name');
    if (nameEl) nameEl.textContent = u.nickname || 'YourNick';
    const bioEl = document.getElementById('css-preview-bio');
    if (bioEl && u.bio) bioEl.textContent = u.bio;
    const statusEl = document.getElementById('css-preview-status');
    if (statusEl) {
      const parts = [u.status_msg, u.mood].filter(Boolean);
      if (parts.length) statusEl.textContent = parts.join(' · ');
    }
    const avEl = document.getElementById('css-preview-avatar');
    if (avEl && typeof UI !== 'undefined' && UI.avatarEl) {
      avEl.innerHTML = UI.avatarEl(u.avatar, u.nickname, 90);
    }
    const headerEl = document.getElementById('css-preview-header');
    if (headerEl && u.banner) {
      headerEl.style.setProperty('background-image', `url(${u.banner})`, 'important');
      headerEl.style.setProperty('background-size', 'cover', 'important');
      headerEl.style.setProperty('background-position', 'center', 'important');
    }
  } catch {}
}

function previewCssLive() {
  const overlay = document.getElementById('css-preview-overlay');
  if (!overlay) return;
  _populateCssPreviewIdentity();
  _renderCssPreviewStyle();
  overlay.classList.remove('hidden');
  // Live update while typing
  if (!_cssPreviewInputBound) {
    const ta = document.getElementById('profile-custom-css');
    if (ta) {
      ta.addEventListener('input', () => {
        if (!document.getElementById('css-preview-overlay')?.classList.contains('hidden')) {
          _renderCssPreviewStyle();
        }
      });
      _cssPreviewInputBound = true;
    }
  }
  // Backdrop click closes
  overlay.onclick = (e) => { if (e.target === overlay) closeCssPreview(); };
  // Escape closes
  if (!_cssPreviewKeyHandler) {
    _cssPreviewKeyHandler = (e) => {
      if (e.key === 'Escape' && !document.getElementById('css-preview-overlay')?.classList.contains('hidden')) {
        closeCssPreview();
      }
    };
    document.addEventListener('keydown', _cssPreviewKeyHandler);
  }
}

function closeCssPreview() {
  const overlay = document.getElementById('css-preview-overlay');
  if (overlay) overlay.classList.add('hidden');
  if (_cssPreviewStyleEl) {
    _cssPreviewStyleEl.remove();
    _cssPreviewStyleEl = null;
  }
}

try {
  window.previewCssLive = previewCssLive;
  window.closeCssPreview = closeCssPreview;
  window.applyCssPreset = applyCssPreset;
  window.updateCssCharCount = updateCssCharCount;
} catch {}

async function loadSocialStats() {
  const nick = State.user?.nickname;
  if (!nick) return;
  try {
    const res = await apiFetch('/api/social/profile/' + encodeURIComponent(nick));
    if (!res.ok) return;
    const data = await res.json();
    const pe = document.getElementById('social-stat-posts');
    const fre = document.getElementById('social-stat-followers');
    const fie = document.getElementById('social-stat-following');
    if (pe) pe.textContent = data.post_count ?? 0;
    if (fre) fre.textContent = data.follower_count ?? 0;
    if (fie) fie.textContent = data.following_count ?? 0;
    // Wall settings
    const we = document.getElementById('profile-wall-enabled');
    const wce = document.getElementById('profile-wall-comments');
    if (we && State.user.wall_enabled !== undefined) we.checked = State.user.wall_enabled !== 0;
    if (wce && State.user.wall_comments_enabled !== undefined) wce.checked = State.user.wall_comments_enabled !== 0;
  } catch {}
}

async function showProfile() {
  const u = State.user;
  if (!u) return;
  // Close social overlay if open (so modal appears on top)
  const socialOverlay = document.getElementById('social-overlay');
  if (socialOverlay && !socialOverlay.classList.contains('hidden')) {
    socialOverlay.classList.add('hidden');
  }
  // Reset to profile tab
  switchSettingsTab('profile');
  // Profile tab
  document.getElementById('profile-nickname').value = u.nickname;
  document.getElementById('profile-bio').value = u.bio || '';
  const smEl = document.getElementById('profile-status-msg');
  if (smEl) smEl.value = u.status_msg || '';
  const presEl = document.getElementById('profile-presence');
  if (presEl) presEl.value = u.presence || 'online';
  const pal = document.getElementById('profile-avatar-large');
  pal.innerHTML = UI.avatarEl(u.avatar, u.nickname, 80);
  delete pal.dataset.newAvatar;
  // Banner
  const bannerPrev = document.getElementById('profile-banner-preview');
  if (bannerPrev) {
    delete bannerPrev.dataset.newBanner;
    bannerPrev.style.backgroundImage = u.banner ? `url(${u.banner})` : '';
  }
  // Account tab
  document.getElementById('profile-cur-pw').value = '';
  document.getElementById('profile-new-pw').value = '';
  document.getElementById('profile-error').textContent = '';
  // Privacy tab
  const ppEl = document.getElementById('profile-public');
  if (ppEl) ppEl.checked = u.profile_public !== 0;
  const frEl = document.getElementById('profile-allow-fr');
  if (frEl) frEl.checked = u.allow_friend_requests !== 0;
  const dmEl = document.getElementById('profile-allow-dms');
  if (dmEl) dmEl.value = u.allow_dms_from || 'everyone';
  const lsEl = document.getElementById('profile-show-last-seen');
  if (lsEl) lsEl.value = u.show_last_seen || 'everyone';
  const rrEl = document.getElementById('profile-show-read-receipts');
  if (rrEl) rrEl.checked = u.show_read_receipts !== 0;
  const hacEl = document.getElementById('profile-hide-active-channels');
  if (hacEl) hacEl.checked = !!u.hide_active_channels;
  // Auto-login
  const autoLoginEl = document.getElementById('profile-auto-login');
  if (autoLoginEl) {
    autoLoginEl.checked = localStorage.getItem('frogtalk-auto-login') !== 'false';
    autoLoginEl.onchange = () => {
      localStorage.setItem('frogtalk-auto-login', autoLoginEl.checked ? 'true' : 'false');
    };
  }
  // Notifications tab
  document.getElementById('profile-notify-sounds').checked = u.notify_sounds !== 0;
  document.getElementById('profile-notify-desktop').checked = u.notify_desktop !== 0;
  document.getElementById('profile-notify-dms').checked = u.notify_dms !== 0;
  document.getElementById('profile-notify-mentions').checked = u.notify_mentions !== 0;
  // Vibration + tone (client-side prefs)
  const vibEl = document.getElementById('profile-notify-vibrate');
  if (vibEl) vibEl.checked = localStorage.getItem('ft_notify_vibrate') !== '0';
  const apEl = document.getElementById('profile-autoplay-media');
  if (apEl) apEl.checked = localStorage.getItem('ft_autoplay_media') !== '0';
  const toneEl = document.getElementById('profile-notify-tone');
  if (toneEl) toneEl.value = localStorage.getItem('ft_notify_tone') || 'pop';
  const ringEl = document.getElementById('profile-notify-ring');
  if (ringEl) ringEl.value = localStorage.getItem('ft_notify_ring') || 'default';
  const moodEl = document.getElementById('profile-mood');
  if (moodEl) moodEl.value = u.mood || '';
  const cssEl = document.getElementById('profile-custom-css');
  if (cssEl) cssEl.value = u.custom_css || '';
  // Appearance tab - select current theme
  const currentTheme = u.theme || localStorage.getItem('frogtalk-theme') || 'dark';
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.style.borderColor = btn.dataset.theme === currentTheme ? '#4caf50' : '#333';
    btn.onclick = () => selectTheme(btn.dataset.theme);
  });
  openModal('modal-profile');
  loadNetworkSettings();

  try {
    const res = await apiFetch('/api/wall/settings');
    if (!res.ok) return;
    const data = await res.json();
    if (moodEl) moodEl.value = data.mood || '';
    if (cssEl) { cssEl.value = data.custom_css || ''; updateCssCharCount(); }
    State.user.mood = data.mood || '';
    State.user.custom_css = data.custom_css || '';
    State.user.wall_enabled = data.wall_enabled;
    State.user.wall_comments_enabled = data.wall_comments_enabled;
    // Populate social tab checkboxes
    const weEl = document.getElementById('profile-wall-enabled');
    const wceEl = document.getElementById('profile-wall-comments');
    if (weEl) weEl.checked = data.wall_enabled !== 0;
    if (wceEl) wceEl.checked = data.wall_comments_enabled !== 0;
    State.save();
  } catch {}
}

function triggerAvatarUpload() {
  document.getElementById('avatar-input').click();
}

async function handleAvatarSelect(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) { UI.showToast('Avatar too large (max 4MB)', 'error'); return; }
  // Use the proven ImageCropper (drag to pan crop rect, slider to zoom, circle
  // mask). This writes out a real JPEG of just the cropped region — no more
  // full-image previews slipping through.
  const finish = (cropped) => {
    const pal = document.getElementById('profile-avatar-large');
    if (!pal) return;
    pal.innerHTML = `<img src="${cropped}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block">`;
    pal.dataset.newAvatar = cropped;
  };
  if (typeof ImageCropper !== 'undefined' && ImageCropper.open) {
    ImageCropper.open({ file, aspect: 1, maxSize: 256, circle: true, onCrop: finish });
  } else {
    // Fallback: legacy in-page cropper
    const reader = new FileReader();
    reader.onload = e => openCropTool(e.target.result, 'circle', 256, 256, finish);
    reader.readAsDataURL(file);
  }
  // Let the user re-pick the same file next time
  try { input.value = ''; } catch {}
}

async function handleBannerSelect(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { UI.showToast('Banner too large (max 5MB)', 'error'); return; }
  const finish = (cropped) => {
    const prev = document.getElementById('profile-banner-preview');
    if (!prev) return;
    prev.style.backgroundImage = `url(${cropped})`;
    prev.dataset.newBanner = cropped;
  };
  if (typeof ImageCropper !== 'undefined' && ImageCropper.open) {
    ImageCropper.open({ file, aspect: 3, maxSize: 1200, circle: false, onCrop: finish });
  } else {
    const reader = new FileReader();
    reader.onload = e => openCropTool(e.target.result, 'rect', 600, 200, finish);
    reader.readAsDataURL(file);
  }
  try { input.value = ''; } catch {}
}

/* ── Image Crop Tool ───────────────────────────────────────────────────── */
let _cropState = null;

function openCropTool(dataUrl, shape, outW, outH, callback) {
  const modal = document.getElementById('crop-modal');
  const canvas = document.getElementById('crop-canvas');
  const overlay = document.getElementById('crop-overlay');
  const zoomSlider = document.getElementById('crop-zoom');
  const titleEl = document.getElementById('crop-title');

  titleEl.textContent = shape === 'circle' ? 'Crop Avatar' : 'Crop Banner';
  overlay.className = shape;
  zoomSlider.value = 100;

  const img = new Image();
  img.onload = () => {
    const maxW = Math.min(window.innerWidth * 0.85, 500);
    const maxH = Math.min(window.innerHeight * 0.55, 400);
    let cw, ch;
    if (shape === 'circle') {
      cw = ch = Math.min(maxW, maxH, 360);
    } else {
      const ratio = outW / outH;
      cw = Math.min(maxW, 480);
      ch = cw / ratio;
      if (ch > maxH) { ch = maxH; cw = ch * ratio; }
    }
    canvas.width = cw;
    canvas.height = ch;
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    document.getElementById('crop-container').style.width = cw + 'px';
    document.getElementById('crop-container').style.height = ch + 'px';

    _cropState = {
      img, canvas, shape, outW, outH, callback,
      zoom: 1, panX: 0, panY: 0,
      dragging: false, lastX: 0, lastY: 0
    };
    drawCrop();
    modal.classList.remove('hidden');
  };
  img.src = dataUrl;

  // Zoom
  zoomSlider.oninput = () => {
    if (!_cropState) return;
    _cropState.zoom = parseInt(zoomSlider.value) / 100;
    drawCrop();
  };

  // Pan via drag
  const container = document.getElementById('crop-container');
  container.onpointerdown = e => {
    if (!_cropState) return;
    _cropState.dragging = true;
    _cropState.lastX = e.clientX;
    _cropState.lastY = e.clientY;
    container.setPointerCapture(e.pointerId);
  };
  container.onpointermove = e => {
    if (!_cropState || !_cropState.dragging) return;
    _cropState.panX += e.clientX - _cropState.lastX;
    _cropState.panY += e.clientY - _cropState.lastY;
    _cropState.lastX = e.clientX;
    _cropState.lastY = e.clientY;
    drawCrop();
  };
  container.onpointerup = () => { if (_cropState) _cropState.dragging = false; };
}

function drawCrop() {
  if (!_cropState) return;
  const { img, canvas, zoom, panX, panY } = _cropState;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const scale = Math.max(canvas.width / img.width, canvas.height / img.height) * zoom;
  const dw = img.width * scale;
  const dh = img.height * scale;
  const dx = (canvas.width - dw) / 2 + panX;
  const dy = (canvas.height - dh) / 2 + panY;
  ctx.drawImage(img, dx, dy, dw, dh);
}

function applyCrop() {
  if (!_cropState) return;
  const { img, canvas, shape, outW, outH, zoom, panX, panY, callback } = _cropState;

  // Draw to output canvas at target resolution
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');

  const scaleX = outW / canvas.width;
  const scaleY = outH / canvas.height;
  const scale = Math.max(canvas.width / img.width, canvas.height / img.height) * zoom;
  const dw = img.width * scale * scaleX;
  const dh = img.height * scale * scaleY;
  const dx = (outW - dw) / 2 + panX * scaleX;
  const dy = (outH - dh) / 2 + panY * scaleY;

  if (shape === 'circle') {
    ctx.beginPath();
    ctx.arc(outW / 2, outH / 2, outW / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
  }
  ctx.drawImage(img, dx, dy, dw, dh);

  const result = out.toDataURL('image/png');
  callback(result);
  closeCropModal();
}

function cancelCrop() {
  _cropState = null;
  closeCropModal();
}

function closeCropModal() {
  document.getElementById('crop-modal').classList.add('hidden');
  _cropState = null;
}

async function changeNickname() {
  const input = document.getElementById('profile-nickname');
  const newNick = (input?.value || '').trim();
  if (!newNick) return;
  if (newNick === State.user?.nickname) { UI.showToast("That's already your nickname", 'error'); return; }
  if (!/^[a-zA-Z0-9_\-]{2,32}$/.test(newNick)) { UI.showToast('Nickname: 2-32 chars, letters/numbers/_/-', 'error'); return; }
  const password = prompt('Enter your password to confirm nickname change:');
  if (!password) return;
  try {
    const res = await apiFetch('/api/auth/nickname', 'PATCH', { nickname: newNick, password });
    const data = await res.json();
    if (!res.ok) { UI.showToast(data.error || 'Could not change nickname', 'error'); return; }
    State.user.nickname = data.nickname;
    State.save();
    // Update sidebar
    const selfNick = document.getElementById('self-nick');
    if (selfNick) selfNick.textContent = data.nickname;
    UI.showToast('Nickname changed to ' + data.nickname, 'success');
  } catch { UI.showToast('Network error', 'error'); }
}

async function saveProfile() {
  const bio = document.getElementById('profile-bio').value.slice(0, 256);
  const curPw = document.getElementById('profile-cur-pw').value;
  const newPw = document.getElementById('profile-new-pw').value;
  const pal = document.getElementById('profile-avatar-large');
  const newAvatar = pal.dataset.newAvatar || null;
  const errEl = document.getElementById('profile-error');
  const statusMsg = document.getElementById('profile-status-msg')?.value?.slice(0,128) || '';
  const presence  = document.getElementById('profile-presence')?.value || 'online';
  const profilePublic = document.getElementById('profile-public')?.checked ?? true;
  const allowFr       = document.getElementById('profile-allow-fr')?.checked ?? true;
  const allowDms      = document.getElementById('profile-allow-dms')?.value || 'everyone';
  const showLastSeen  = document.getElementById('profile-show-last-seen')?.value || 'everyone';
  const showReadRx    = document.getElementById('profile-show-read-receipts')?.checked ?? true;
  const hideActiveCh  = document.getElementById('profile-hide-active-channels')?.checked ?? false;
  // Auto-login preference (local only)
  const autoLogin = document.getElementById('profile-auto-login')?.checked ?? true;
  localStorage.setItem('frogtalk-auto-login', autoLogin ? 'true' : 'false');
  // Notification settings
  const notifySounds   = document.getElementById('profile-notify-sounds')?.checked ?? true;
  const notifyDesktop  = document.getElementById('profile-notify-desktop')?.checked ?? true;
  const notifyDms      = document.getElementById('profile-notify-dms')?.checked ?? true;
  const notifyMentions = document.getElementById('profile-notify-mentions')?.checked ?? true;
  // Vibration + tone (client-side only)
  const notifyVibrate = document.getElementById('profile-notify-vibrate')?.checked ?? true;
  const notifyTone    = document.getElementById('profile-notify-tone')?.value || 'pop';
  const notifyRing    = document.getElementById('profile-notify-ring')?.value || 'default';
  const autoplayMedia = document.getElementById('profile-autoplay-media')?.checked ?? true;
  localStorage.setItem('ft_notify_vibrate', notifyVibrate ? '1' : '0');
  localStorage.setItem('ft_notify_tone', notifyTone);
  localStorage.setItem('ft_notify_ring', notifyRing);
  localStorage.setItem('ft_autoplay_media', autoplayMedia ? '1' : '0');
  saveNetworkSettings(true);
  const mood = document.getElementById('profile-mood')?.value?.slice(0, 100) || '';
  const customCss = document.getElementById('profile-custom-css')?.value?.slice(0, 10240) || '';
  // Theme
  const currentTheme = document.body.dataset.theme || 'dark';

  const body = {
    bio,
    status_msg: statusMsg,
    presence,
    profile_public: profilePublic,
    allow_friend_requests: allowFr,
    allow_dms_from: allowDms,
    show_last_seen: showLastSeen,
    show_read_receipts: showReadRx,
    hide_active_channels: hideActiveCh,
    notify_sounds: notifySounds,
    notify_desktop: notifyDesktop,
    notify_dms: notifyDms,
    notify_mentions: notifyMentions,
    theme: currentTheme,
  };
  if (newAvatar) body.avatar = newAvatar;
  const bannerPrev = document.getElementById('profile-banner-preview');
  if (bannerPrev?.dataset.newBanner) body.banner = bannerPrev.dataset.newBanner;
  if (newPw) { body.new_password = newPw; body.current_password = curPw; }

  try {
    const res = await fetch('/api/auth/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Save failed'; return; }
    // Update local state
    State.user.bio = bio;
    State.user.status_msg = statusMsg;
    State.user.presence   = presence;
    State.user.profile_public = profilePublic ? 1 : 0;
    State.user.allow_friend_requests = allowFr ? 1 : 0;
    State.user.allow_dms_from = allowDms;
    State.user.show_last_seen = showLastSeen;
    State.user.show_read_receipts = showReadRx ? 1 : 0;
    State.user.hide_active_channels = hideActiveCh ? 1 : 0;
    State.user.notify_sounds = notifySounds ? 1 : 0;
    State.user.notify_desktop = notifyDesktop ? 1 : 0;
    State.user.notify_dms = notifyDms ? 1 : 0;
    State.user.notify_mentions = notifyMentions ? 1 : 0;
    State.user.theme = currentTheme;
    if (newAvatar) State.user.avatar = newAvatar;

    const wallRes = await apiFetch('/api/wall/settings', 'PATCH', {
      mood,
      custom_css: customCss,
      wall_enabled: document.getElementById('profile-wall-enabled')?.checked ?? true,
      wall_comments_enabled: document.getElementById('profile-wall-comments')?.checked ?? true,
    });
    const wallData = await wallRes.json();
    if (!wallRes.ok) {
      State.save();
      errEl.textContent = wallData.error || 'Style save failed';
      return;
    }

    State.user.mood = mood;
    State.user.custom_css = customCss;
    State.user.wall_enabled = wallData.wall_enabled ?? 1;
    State.user.wall_comments_enabled = wallData.wall_comments_enabled ?? 1;
    State.save();
    // Update self panel
    const sa = document.getElementById('self-avatar-el');
    sa.innerHTML = UI.avatarEl(State.user.avatar, State.user.nickname, 36);
    // Eagerly update self rendered avatars everywhere (messages, DM sidebar, friends list)
    if (newAvatar) {
      try {
        const nk = State.user.nickname;
        document.querySelectorAll(`.msg-group[data-nick="${CSS.escape(nk)}"] .msg-avatar`).forEach(el => {
          el.innerHTML = UI.avatarEl(newAvatar, nk, 38);
        });
      } catch {}
    }
    closeModal('modal-profile');
    UI.showToast('Settings saved', 'success');
  } catch {
    errEl.textContent = 'Network error';
  }
}

function toggleEncryptionInfo() {
  try {
    const peer = (typeof _activeDM !== 'undefined' && _activeDM) ? _activeDM : null;
    const me = State?.user?.nickname || State?.nickname || '';
    const them = peer?.nickname || '';
    if (!peer || !them || !me) {
      UI.showToast('Open a DM to verify its encryption.', 'info');
      return;
    }
    if (typeof Crypto === 'undefined' || !Crypto.fingerprint) {
      UI.showToast('🔒 AES-256-GCM end-to-end encryption.', 'success');
      return;
    }
    const slot = document.getElementById('enc-verify-emojis');
    const peerEl = document.getElementById('enc-verify-peer');
    if (peerEl) peerEl.textContent = '@' + them;
    if (slot) slot.textContent = '· · · ·';
    openModal('modal-encrypt-verify');
    Crypto.fingerprint(me, them).then(emojis => {
      if (slot) slot.textContent = emojis.join(' ');
    }).catch(() => {
      if (slot) slot.textContent = '—';
    });
  } catch (e) {
    UI.showToast('Could not compute encryption fingerprint.', 'error');
  }
}

async function copyEncVerifyEmojis() {
  const slot = document.getElementById('enc-verify-emojis');
  const hint = document.getElementById('enc-verify-copy-hint');
  if (!slot) return;
  const text = (slot.textContent || '').trim();
  if (!text || text === '· · · ·' || text === '—') return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(slot);
      sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('copy');
      sel.removeAllRanges();
    }
    if (hint) { hint.textContent = '✅ Copied!'; hint.style.color = '#4caf50'; }
    slot.style.borderColor = '#4caf50';
    setTimeout(() => {
      if (hint) { hint.textContent = 'Tap the emojis to copy'; hint.style.color = '#666'; }
      slot.style.borderColor = '#2a4a2a';
    }, 1400);
  } catch {
    UI.showToast('Could not copy', 'error');
  }
}
window.copyEncVerifyEmojis = copyEncVerifyEmojis;

// DM functions
function showNewDM() {
  document.getElementById('dm-target').value = '';
  document.getElementById('dm-error').textContent = '';
  openModal('modal-new-dm');
  setTimeout(() => document.getElementById('dm-target').focus(), 100);
}

async function openDM() {
  const target = document.getElementById('dm-target').value.trim();
  const errEl = document.getElementById('dm-error');
  if (!target) { errEl.textContent = 'Enter a nickname'; return; }
  closeModal('modal-new-dm');
  if (typeof openDMWithNick === 'function') {
    openDMWithNick(target);
  } else {
    Rooms.openDM(target);
  }
}

// User info popup - enhanced with wall
let _userInfoTarget = null;
let _userInfoTargetId = null;

// Dedicated profile popup for bridged users (Telegram / Discord mirrors).
// These users have no FrogTalk account, so DM / call / friend / follow are
// not possible. We render a small explanatory card themed to the source
// platform instead of the regular blank-loading profile modal.
async function _resolveBridgeSourceFromConfig(platform) {
  const plat = String(platform || '').toLowerCase();
  const room = String(State?.currentRoom || '');
  if (!plat || !room || typeof apiFetch !== 'function') return null;
  try {
    const res = await apiFetch('/api/bridge/rooms/' + encodeURIComponent(room) + '/bridge-sources');
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data?.sources)) return null;
    const rows = data.sources.filter(s => String(s?.platform || '').toLowerCase() === plat);
    const row = rows[0] || null;
    if (!row) return null;
    return {
      name: String(row.name || '').trim(),
      id: String(row.id || '').trim(),
      parent: String(row.parent || '').trim(),
    };
  } catch {
    return null;
  }
}

function showBridgedUserInfo(nickname, platform, sourceName, sourceId, sourceParent, bridgeAvatar) {
  const plat = String(platform || '').toLowerCase();
  const meta = ({
    telegram: {
      label: 'Telegram',
      color: '#4fc3e8',
      logo: "<svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor' aria-hidden='true'><path d='M21.5 4.1 2.7 11.5c-.9.4-.9 1 .1 1.3l4.8 1.5 1.9 5.9c.2.7.6.9 1.1.4l2.7-2.5 4.8 3.6c.9.5 1.5.2 1.7-.8l3-14.1c.3-1.3-.5-1.9-1.3-1.7zM9.7 14.3l8.8-5.5c.4-.2.8.1.5.5l-7.2 6.5-.3 3.1-1.8-4.6z'/></svg>",
    },
    discord: {
      label: 'Discord',
      color: '#8aa5f5',
      logo: "<svg viewBox='0 0 24 24' width='16' height='16' fill='currentColor' aria-hidden='true'><path d='M20.3 4.5a18.3 18.3 0 0 0-4.6-1.4l-.2.4c-1.7-.3-3.4-.3-5 0l-.2-.4a18 18 0 0 0-4.6 1.4C2.3 9.9 1.5 15.2 1.9 20.4a18.5 18.5 0 0 0 5.6 2.8l.4-.6c-.9-.3-1.8-.8-2.6-1.3l.2-.2c5 2.3 10.5 2.3 15.4 0l.2.2c-.8.5-1.7.9-2.6 1.3l.4.6a18.3 18.3 0 0 0 5.6-2.8c.5-6-.9-11.2-4.2-15.9zM8.5 17.2c-1.1 0-2-1-2-2.3 0-1.2.9-2.3 2-2.3s2 1 2 2.3c0 1.2-.9 2.3-2 2.3zm7 0c-1.1 0-2-1-2-2.3 0-1.2.9-2.3 2-2.3s2 1 2 2.3c0 1.2-.9 2.3-2 2.3z'/></svg>",
    },
  })[plat] || {
    label: 'Bridge',
    color: '#9aa4ae',
    logo: "<span style='font-size:13px;line-height:1' aria-hidden='true'>🌉</span>",
  };
  const pipBg = '#111a20';
  const logoPip = `<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;line-height:1">${meta.logo}</span>`;
  const logoBadge = `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;line-height:1">${meta.logo}</span>`;
  const safeNick = (typeof UI !== 'undefined' && UI.escHtml) ? UI.escHtml(nickname) : String(nickname).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
  const safePlat = (typeof UI !== 'undefined' && UI.escHtml) ? UI.escHtml(meta.label) : meta.label;
  const sourceFallback = sourceName ? '' : 'Loading source...';
  const safeSourceName = (typeof UI !== 'undefined' && UI.escHtml) ? UI.escHtml(String(sourceName || sourceFallback || 'Source unavailable')) : String(sourceName || sourceFallback || 'Source unavailable');
  const safeSourceId = (typeof UI !== 'undefined' && UI.escHtml) ? UI.escHtml(String(sourceId || '')) : String(sourceId || '');
  const safeSourceParent = (typeof UI !== 'undefined' && UI.escHtml) ? UI.escHtml(String(sourceParent || '')) : String(sourceParent || '');
  const avatar = (typeof UI !== 'undefined' && UI.avatarEl) ? UI.avatarEl(bridgeAvatar || null, nickname, 90) : '🐸';

  const host = document.getElementById('modal-bridge-user-info') || (() => {
    const el = document.createElement('div');
    el.id = 'modal-bridge-user-info';
    el.className = 'modal-overlay hidden';
    document.body.appendChild(el);
    return el;
  })();

  host.innerHTML = `
    <div class="modal user-profile-modal bridge-profile-card" data-platform="${plat}" style="max-width:440px;padding:0;overflow:hidden;border:1px solid ${meta.color}33">
      <div class="profile-header" style="position:relative;background:linear-gradient(135deg, ${meta.color}26 0%, #0d1f0d 100%);padding:20px;min-height:130px;border-bottom:1px solid ${meta.color}33">
        <button class="profile-close-btn" onclick="closeModal('modal-bridge-user-info')" style="position:absolute;top:12px;right:12px;background:rgba(0,0,0,0.4);border:none;width:32px;height:32px;border-radius:50%;color:#fff;font-size:18px;cursor:pointer;z-index:5" title="Close">✕</button>
        <div class="profile-header-content" style="display:flex;align-items:flex-end;gap:16px;padding-top:36px">
          <div class="profile-avatar-large" style="width:90px;height:90px;font-size:42px;flex-shrink:0;border:4px solid #111;border-radius:50%;box-shadow:0 4px 15px rgba(0,0,0,0.4);position:relative;overflow:visible">
            ${avatar}
            <div class="bp-platform-pip" title="Bridged from ${safePlat}" style="position:absolute;right:-6px;bottom:-6px;width:30px;height:30px;border-radius:50%;background:${pipBg};color:${meta.color};display:flex;align-items:center;justify-content:center;border:2px solid ${meta.color};z-index:5;box-shadow:0 2px 8px rgba(0,0,0,.45)">${logoPip}</div>
          </div>
          <div style="flex:1;min-width:0;padding-bottom:4px">
            <div class="userinfo-nick" style="font-size:22px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 2px 4px rgba(0,0,0,0.3)">${safeNick}</div>
            <div style="margin-top:4px"><span class="bridge-origin-badge" data-platform="${plat}" style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:3px 8px;border-radius:10px;background:${pipBg};color:${meta.color};border:1px solid ${meta.color}66">${logoBadge} VIA ${safePlat.toUpperCase()}</span></div>
          </div>
        </div>
      </div>

      <div class="profile-body" style="padding:18px;background:#111">
        <div class="profile-section" style="background:#1a1a1a;border-radius:12px;padding:14px;margin-bottom:12px;border-left:3px solid ${meta.color}">
          <div class="profile-section-title" style="font-size:11px;color:${meta.color};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;font-weight:700">Bridged Connection</div>
          <div style="font-size:14px;color:#e0e0e0;line-height:1.55">
            <strong style="color:#fff">@${safeNick}</strong> is chatting from <strong style="color:${meta.color}">${safePlat}</strong> through a bridged connection &mdash; they're not a FrogTalk account.
            <div style="margin-top:8px;color:#aaa;font-size:13px">Their messages are mirrored here in real time, but features that need a FrogTalk account aren't available.</div>
          </div>
        </div>

        <div class="profile-section" style="background:#1a1a1a;border-radius:12px;padding:12px;margin-bottom:12px;border:1px solid ${meta.color}26">
          <div class="profile-section-title" style="font-size:11px;color:${meta.color};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;font-weight:700">Bridge Source</div>
          <div style="display:grid;grid-template-columns:110px 1fr;gap:8px 10px;font-size:13px;line-height:1.5">
            <div style="color:#7f8c8d">Platform</div><div style="color:#fff">${safePlat}</div>
            <div style="color:#7f8c8d">Source</div><div style="color:#fff;word-break:break-word" data-bridge-source="name">${safeSourceName}</div>
            <div style="color:#7f8c8d;${safeSourceParent ? '' : 'display:none'}" data-bridge-source="parent-label">Server / Group</div><div style="color:#fff;word-break:break-word;${safeSourceParent ? '' : 'display:none'}" data-bridge-source="parent">${safeSourceParent}</div>
            <div style="color:#7f8c8d;${safeSourceId ? '' : 'display:none'}" data-bridge-source="id-label">Source ID</div><div style="color:#bbb;word-break:break-all;${safeSourceId ? '' : 'display:none'}" data-bridge-source="id">${safeSourceId}</div>
          </div>
        </div>
      </div>
    </div>
  `;

  if (typeof openModal === 'function') {
    openModal('modal-bridge-user-info');
  } else {
    host.classList.remove('hidden');
  }

  if (!String(sourceName || '').trim()) {
    void _resolveBridgeSourceFromConfig(plat).then((resolved) => {
      if (!resolved) {
        const el = host.querySelector('[data-bridge-source="name"]');
        if (el && String(el.textContent || '').trim().toLowerCase() === 'loading source...') {
          el.textContent = 'Source unavailable';
        }
        return;
      }
      const nameEl = host.querySelector('[data-bridge-source="name"]');
      const parentLabelEl = host.querySelector('[data-bridge-source="parent-label"]');
      const parentEl = host.querySelector('[data-bridge-source="parent"]');
      const idLabelEl = host.querySelector('[data-bridge-source="id-label"]');
      const idEl = host.querySelector('[data-bridge-source="id"]');
      if (nameEl) nameEl.textContent = resolved.name || 'Source unavailable';
      if (parentLabelEl) parentLabelEl.style.display = resolved.parent ? '' : 'none';
      if (parentEl) {
        parentEl.style.display = resolved.parent ? '' : 'none';
        parentEl.textContent = resolved.parent || '';
      }
      if (idLabelEl) idLabelEl.style.display = resolved.id ? '' : 'none';
      if (idEl) {
        idEl.style.display = resolved.id ? '' : 'none';
        idEl.textContent = resolved.id || '';
      }
    });
  }
}

function showUserInfo(nickname, userId, bridgePlatform, bridgeSourceName, bridgeSourceId, bridgeSourceParent, bridgeAvatar) {
  // Bridge users (Telegram / Discord mirrors) have no FrogTalk account.
  // Showing the regular profile modal results in a permanently-blank
  // "Loading…" state and exposes irrelevant DM / call / friend buttons.
  // Route them to a dedicated bridged-user popup that explains the
  // origin and offers no actions that can't possibly work.
  if (bridgePlatform && typeof showBridgedUserInfo === 'function') {
    showBridgedUserInfo(nickname, bridgePlatform, bridgeSourceName, bridgeSourceId, bridgeSourceParent, bridgeAvatar);
    return;
  }
  _userInfoTarget = nickname;
  _userInfoTargetId = userId;
  clearProfileCustomCss();
  
  const nameEl = document.getElementById('userinfo-name');
  nameEl.textContent = nickname;
  nameEl.dataset.nick = nickname;
  document.getElementById('userinfo-avatar').innerHTML = UI.avatarEl(null, nickname, 90);
  document.getElementById('userinfo-bio').textContent = 'Loading...';
  const smEl = document.getElementById('userinfo-status-msg');
  if (smEl) smEl.textContent = '';
  const tagsEl = document.getElementById('userinfo-tags');
  const tagsSection = document.getElementById('userinfo-tags-section');
  if (tagsEl) tagsEl.innerHTML = '';
  if (tagsSection) tagsSection.style.display = 'none';
  
  // Reset wall
  const wallEl = document.getElementById('userinfo-wall');
  if (wallEl) wallEl.innerHTML = '<div style="text-align:center;color:#666;font-size:13px;padding:20px 0">Loading wall...</div>';
  const wallPostBtn = document.getElementById('userinfo-wall-post-btn');
  if (wallPostBtn) wallPostBtn.style.display = 'none';
  hideWallPostInput();

  const isSelf = nickname === State.user?.nickname;
  const dmBtn  = document.getElementById('userinfo-dm-btn');
  // Unified call button — camera can be toggled mid-call. No separate video btn.
  const voiceBtn  = document.getElementById('userinfo-voice-btn');
  const friendBtn = document.getElementById('userinfo-friend-btn');
  const blockBtn  = document.getElementById('userinfo-block-btn');
  const soundsBtn = document.getElementById('userinfo-sounds-btn');
  const dangerZone = document.getElementById('userinfo-danger-zone');

  // Hide action buttons for self
  if (dmBtn) dmBtn.style.display = isSelf ? 'none' : '';
  if (voiceBtn) voiceBtn.style.display = isSelf ? 'none' : '';
  if (friendBtn) friendBtn.style.display = isSelf ? 'none' : '';
  if (blockBtn) blockBtn.style.display = isSelf ? 'none' : '';
  if (dangerZone) dangerZone.style.display = isSelf ? 'none' : '';
  // Sounds button — always shown for non-self users (per-friend sound map is
  // keyed by nickname; you don't need to be friends to customise a sound).
  if (soundsBtn) {
    soundsBtn.style.display = isSelf ? 'none' : '';
  }
  // Keep the Mute button label + highlight in sync with current state.
  const muteBtn = document.getElementById('userinfo-mute-btn');
  if (muteBtn) {
    muteBtn.style.display = isSelf ? 'none' : '';
    if (typeof _syncMuteButtonLabel === 'function') _syncMuteButtonLabel();
  }

  // Load profile data
  if (userId) {
    apiFetch('/api/users/profile/' + encodeURIComponent(nickname))
      .then(r => r.json())
      .then(u => {
        document.getElementById('userinfo-bio').textContent = u.bio || 'No bio set.';
        document.getElementById('userinfo-avatar').innerHTML = UI.avatarEl(u.avatar, u.nickname, 90);
        if (smEl) {
          const status = String(u.status_msg || '').trim();
          const mood = String(u.mood || '').trim();
          if (status && status.indexOf('🎵') === 0) {
            // Music status — render as a polished pill linking to the
            // user's Music tab on FrogSocial. Same look & label as the
            // FrogSocial profile and the friends list.
            const track = status.replace(/^🎵\s*/, '').trim() || 'a track';
            const safeNick = String(u.nickname || nickname || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const moodSuffix = mood ? ` <span class="sml-mood">· ${esc(mood)}</span>` : '';
            smEl.innerHTML = `<a href="javascript:void(0)" class="status-music-link"
                onclick="event.stopPropagation();window.Social&&Social.openProfileMusic&&Social.openProfileMusic('${esc(safeNick)}')"
                title="Open @${esc(u.nickname || nickname)}'s music">🎵 <span class="sml-label">Now playing:</span> <span class="sml-track">${esc(track)}</span>${moodSuffix}</a>`;
          } else {
            smEl.textContent = [status, mood].filter(Boolean).join(' · ');
          }
        }
        applyProfileCustomCss(u.custom_css || '');
        if (tagsEl && Array.isArray(u.tags) && u.tags.length > 0) {
          tagsEl.innerHTML = u.tags.map(t =>
            `<span style="background:#1a2e1a;color:#4caf50;border-radius:12px;padding:4px 10px;font-size:12px">${esc(t)}</span>`
          ).join('');
          if (tagsSection) tagsSection.style.display = 'block';
        }
        // Update banner (use setProperty with 'important' so it wins over custom CSS themes)
        const header = document.getElementById('userinfo-header');
        if (header) {
          if (u.banner) {
            header.style.setProperty('background-image', `url(${u.banner})`, 'important');
            header.style.setProperty('background-size', 'cover', 'important');
            header.style.setProperty('background-position', 'center', 'important');
            header.style.setProperty('background-color', 'transparent', 'important');
          } else {
            header.style.removeProperty('background-image');
            header.style.removeProperty('background-size');
            header.style.removeProperty('background-position');
            header.style.removeProperty('background-color');
          }
        }
        
        // Friend button state — always visible (non-self), label flips
        // between Add Friend / ✓ Accept / ✕ Unfriend so the secondary
        // action row stays a clean 3-up grid alongside Sounds + Mute.
        if (friendBtn && !isSelf) {
          const isFriend = typeof _allFriends !== 'undefined' && _allFriends.some(f => f.nickname === u.nickname);
          const isPending = typeof _pendingFriends !== 'undefined' && _pendingFriends.some(f => f.nickname === u.nickname);
          if (isFriend) {
            friendBtn.textContent    = 'Unfriend';
            friendBtn.dataset.action = 'remove';
            friendBtn.style.display  = '';
          } else if (isPending) {
            friendBtn.textContent    = '✓ Accept';
            friendBtn.dataset.action = 'accept';
            friendBtn.style.display  = '';
          } else {
            friendBtn.textContent    = '+ Add Friend';
            friendBtn.dataset.action = 'add';
            friendBtn.style.display  = '';
          }
          // Sounds button stays visible for any non-self user — the
          // per-user sound map is keyed by nickname, no friendship
          // required to set a custom alert sound.
          if (soundsBtn) soundsBtn.style.display = '';
        }
      })
      .catch(() => {
        clearProfileCustomCss();
        document.getElementById('userinfo-bio').textContent = 'No bio set.';
      });
    
    // Load wall posts
    loadUserWall(nickname);
    
    // Show post button for self (anyone can react/comment, only self can create posts on own wall)
    if (isSelf && wallPostBtn) {
      wallPostBtn.style.display = '';
    }
    // Load channel-ban list for self only
    const bansSection = document.getElementById('userinfo-bans-section');
    if (bansSection) {
      if (isSelf) loadMyChannelBans();
      else bansSection.style.display = 'none';
    }
  }
  
  openModal('modal-user-info');
  // Layout fix is now CSS: #modal-user-info uses align-items:flex-start
  // and overflow-y:auto so the banner can never be clipped above the
  // viewport when async content (wall, music) grows the modal. Just
  // make sure the overlay itself starts scrolled to the top in case a
  // previous open left it scrolled.
  try {
    const overlay = document.getElementById('modal-user-info');
    if (overlay) overlay.scrollTop = 0;
  } catch {}
}

// Load the current user's active channel bans (read-only) and render them
async function loadMyChannelBans() {
  const section = document.getElementById('userinfo-bans-section');
  const list    = document.getElementById('userinfo-bans-list');
  const count   = document.getElementById('userinfo-bans-count');
  if (!section || !list) return;
  try {
    const r = await apiFetch('/api/users/me/bans');
    if (!r.ok) { section.style.display = 'none'; return; }
    const data = await r.json();
    const bans = data.bans || [];
    if (!bans.length) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    if (count) count.textContent = bans.length;
    list.innerHTML = bans.map(b => {
      const expires = b.expires_at ? new Date(b.expires_at.includes('Z') ? b.expires_at : b.expires_at + 'Z') : null;
      const expTxt = expires ? `Until ${expires.toLocaleString()}` : 'Permanent';
      const reason = b.reason ? `<div style="font-size:11px;color:#aaa;margin-top:2px">“${esc(b.reason)}”</div>` : '';
      const by = b.banned_by_nick ? ` · by @${esc(b.banned_by_nick)}` : '';
      const icon = b.room_icon && b.room_icon.startsWith('data:')
        ? `<img src="${esc(b.room_icon)}" style="width:28px;height:28px;border-radius:6px;object-fit:cover">`
        : `<div style="width:28px;height:28px;border-radius:6px;background:#1a1a1a;display:flex;align-items:center;justify-content:center;font-size:14px">${esc(b.room_icon || '#')}</div>`;
      return `<div style="display:flex;gap:8px;align-items:flex-start;padding:8px 10px;background:#1a0d0d;border:1px solid #3a1a1a;border-radius:8px">
        ${icon}
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:#e0e0e0">#${esc(b.room_name)}</div>
          <div style="font-size:11px;color:#ff9090">${expTxt}${by}</div>
          ${reason}
        </div>
      </div>`;
    }).join('');
  } catch { section.style.display = 'none'; }
}

// Load wall posts for user profile.
// Uses the cached `/api/social/profile/{nick}/posts?lite=1` endpoint —
// same one the FrogSocial full-profile uses — so the chat-side mini
// profile gets the same fast path: image/video blobs are stripped at
// the SQL level and the client lazy-loads each one through
// /api/social/posts/{id}/media. The legacy /api/wall/users/{nick}
// returned full base64 inline which made big walls take seconds.
async function loadUserWall(nickname) {
  const wallEl = document.getElementById('userinfo-wall');
  if (!wallEl) return;
  // Snapshot the target so a slow response from a previous open doesn't
  // overwrite the wall when the user has already opened a different profile.
  const targetSnapshot = _userInfoTarget;
  try {
    const res = await apiFetch(`/api/social/profile/${encodeURIComponent(nickname)}/posts?lite=1&limit=20`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load wall');
    if (_userInfoTarget !== targetSnapshot) return;  // user navigated away
    const posts = data.posts || [];

    if (posts.length === 0) {
      wallEl.innerHTML = '<div style="text-align:center;color:#666;font-size:13px;padding:20px 0">No posts yet.</div>';
      return;
    }

    wallEl.innerHTML = posts.map(p => {
      // Media rendering
      let mediaHtml = '';
      if (p.media_data && p.media_type) {
        if (p.media_type.startsWith('image/')) {
          mediaHtml = `<div style="margin:8px 0"><img loading="lazy" src="${esc(p.media_data)}" style="max-width:100%;border-radius:8px;cursor:pointer" onclick="if(typeof openLightbox==='function')openLightbox(this.src)" alt="Post media"></div>`;
        } else if (p.media_type.startsWith('video/')) {
          mediaHtml = `<div style="margin:8px 0"><video preload="metadata" src="${esc(p.media_data)}" controls style="max-width:100%;border-radius:8px"></video></div>`;
        } else if (p.media_type.startsWith('music/')) {
          // Music share — clickable card that hands off to FrogSocial's
          // mini-player so the song actually plays from the chat profile.
          const url = String(p.media_data || '');
          const title = String(p.track_title || '🎵 Track').replace(/'/g, "\\'");
          const provider = String(p.media_type || '').split('/')[1] || 'music';
          mediaHtml = `<div style="margin:8px 0"><a href="javascript:void(0)" onclick="event.stopPropagation();window.Music&&Music.playSolo&&Music.playSolo({url:'${esc(url).replace(/'/g,"\\'")}', title:'${esc(title)}', postId:${p.id||'null'}})" style="display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,rgba(75,51,128,0.22) 0%,rgba(61,42,102,0.18) 60%,rgba(76,175,80,0.10));border:1px solid rgba(186,160,235,0.42);border-radius:8px;padding:8px 12px;color:#e3d4ff;text-decoration:none;font-size:13px;box-shadow:0 1px 0 rgba(186,160,235,0.10) inset"><span style="opacity:.85">🎵</span><span style="color:#f0e4ff;font-weight:600">${esc(p.track_title || provider)}</span></a></div>`;
        }
      }

      // Reactions rendering (same style language as Social feed)
      const reactions = Array.isArray(p.reactions) ? p.reactions : [];
      const myNick = String(State?.user?.nickname || '').trim();
      const normalized = reactions.map(r => {
        const users = Array.isArray(r.users)
          ? r.users.map(u => String(u || '').trim()).filter(Boolean)
          : String(r.users || '').split(',').map(u => u.trim()).filter(Boolean);
        return {
          emoji: String(r.emoji || ''),
          count: Number(r.count || 0),
          users,
        };
      }).filter(r => r.emoji);
      const totalReactions = normalized.reduce((n, r) => n + r.count, 0);
      const myReaction = normalized.find(r => r.users.includes(myNick));
      const myEmoji = myReaction ? myReaction.emoji : '';
      const topEmojis = [...normalized]
        .sort((a, b) => (b.count - a.count) || a.emoji.localeCompare(b.emoji))
        .slice(0, 3)
        .map(r => r.emoji)
        .join('');
      const reactionBarHtml = `<div class="sf-rx-bar">`
        + (totalReactions > 0
          ? `<button type="button" class="sf-rx-summary" onclick="showWallReactionDetail(${p.id})" aria-label="See reactions">`
              + `<span class="sf-rx-emojis">${topEmojis}</span><span class="sf-rx-total">${totalReactions}</span></button>`
              + `<button type="button" class="sf-rx-list" onclick="showWallReactionDetail(${p.id})" aria-label="Open reactions list">👥</button>`
          : '')
        + `<button type="button" class="sf-rx-add${myEmoji ? ' active' : ''}" data-my-emoji="${esc(myEmoji)}" onclick="showWallReactionPicker(${p.id})" aria-label="React">${myEmoji || '😊'}</button>`
        + `</div>`;

      // Comments count
      const commentCount = p.comment_count || 0;
      const commentsToggle = p.allow_comments !== 0
        ? `<button onclick="toggleWallComments(${p.id})" style="background:none;border:none;color:#888;cursor:pointer;font-size:12px;padding:4px 0">💬 ${commentCount} comment${commentCount !== 1 ? 's' : ''}</button>`
        : '';

      const contentTrimmed = String(p.content || '').trim();
      const hasBody = !!(contentTrimmed || mediaHtml);
      const contentHtml = contentTrimmed
        ? `<div style="font-size:14px;color:#ccc;line-height:1.5;white-space:pre-wrap;word-break:break-word">${esc(contentTrimmed)}</div>`
        : (hasBody ? '' : `<div style="font-size:13px;color:#666;font-style:italic">(no content)</div>`);

      return `
      <div class="wall-post" data-post-id="${p.id}" style="background:#0d0d0d;border-radius:10px;padding:12px;border:1px solid #222">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <div style="width:32px;height:32px;flex-shrink:0">${UI.avatarEl(p.avatar, p.nickname, 32)}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:#e0e0e0;cursor:pointer" onclick="showUserInfo('${esc(p.nickname)}',${p.user_id})">${esc(p.nickname)}</div>
            <div style="font-size:11px;color:#666">${UI.formatTime(p.created_at)}${p.edited_at ? ' <span style="color:#555">(edited)</span>' : ''}</div>
          </div>
          ${p.user_id === State.user?.id ? 
            `<button onclick="deleteWallPost(${p.id})" style="background:none;border:none;color:#666;cursor:pointer;font-size:14px" title="Delete">🗑️</button>` : ''}
        </div>
        ${contentHtml}
        ${mediaHtml}
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;align-items:center">${reactionBarHtml}</div>
        <div style="margin-top:6px;display:flex;align-items:center;gap:10px">${commentsToggle}</div>
        <div id="wall-comments-${p.id}" style="display:none;margin-top:8px"></div>
      </div>`;
    }).join('');
  } catch (err) {
    wallEl.innerHTML = `<div style="text-align:center;color:#666;font-size:13px;padding:20px 0">${esc(err?.message || 'No posts yet')}</div>`;
  }
}

// Toggle a reaction on a wall post
async function toggleWallReaction(postId, emoji) {
  try {
    const res = await apiFetch(`/api/wall/posts/${postId}/reactions`, 'POST', { emoji });
    if (res.ok && _userInfoTarget) loadUserWall(_userInfoTarget);
  } catch {}
}

function showWallReactionDetail(postId) {
  try {
    if (window.Social && typeof window.Social.showReactionDetail === 'function') {
      window.Social.showReactionDetail(postId);
      return;
    }
  } catch {}
}

// Quick reaction picker for wall posts
function showWallReactionPicker(postId) {
  const quickEmojis = ['❤️','👍','😂','😮','😢','🔥','🐸','👏'];
  const postEl = document.querySelector(`[data-post-id="${postId}"]`);
  if (!postEl) return;
  // Remove existing picker
  const old = postEl.querySelector('.wall-reaction-picker');
  if (old) { old.remove(); return; }
  const myEmoji = postEl.querySelector('.sf-rx-add')?.dataset?.myEmoji || '';
  const picker = document.createElement('div');
  picker.className = 'wall-reaction-picker';
  picker.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;padding:8px;background:#101710;border-radius:10px;border:1px solid #2a3a2a';
  const removeBtnHtml = myEmoji
    ? `<button onclick="toggleWallReaction(${postId},'${myEmoji}');this.parentElement.remove()" style="background:#1a2e1a;border:1px solid #2a3a2a;color:#8bd48b;border-radius:8px;padding:4px 8px;font-size:12px;cursor:pointer">Remove ${myEmoji}</button>`
    : '';
  picker.innerHTML = removeBtnHtml + quickEmojis.map(e =>
    `<button onclick="toggleWallReaction(${postId},'${e}');this.parentElement.remove()" style="background:none;border:1px solid #2a2a2a;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:8px;transition:background .15s" onmouseover="this.style.background='#1a2e1a'" onmouseout="this.style.background='none'">${e}</button>`
  ).join('');
  postEl.appendChild(picker);
}

// Toggle comments section for a wall post
async function toggleWallComments(postId) {
  const el = document.getElementById(`wall-comments-${postId}`);
  if (!el) return;
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = '<div style="color:#666;font-size:12px;padding:8px 0">Loading comments...</div>';
  try {
    const res = await apiFetch(`/api/wall/posts/${postId}/comments`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const comments = data.comments || [];
    const allowComments = data.allow_comments !== false;
    let html = comments.map(c => {
      const myVote = Number(c.my_vote || 0);
      const upCount = Number(c.like_count || 0);
      const upActive = myVote === 1 ? ' is-up' : '';
      const downActive = myVote === -1 ? ' is-down' : '';
      return `
      <div class="wall-comment-row" style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid #1a1a1a" data-comment-id="${c.id}" data-post-id="${postId}">
        <div style="width:24px;height:24px;flex-shrink:0">${UI.avatarEl(c.avatar, c.nickname, 24)}</div>
        <div style="flex:1;min-width:0">
          <span style="font-size:12px;font-weight:600;color:#e0e0e0">${esc(c.nickname)}</span>
          <span style="font-size:12px;color:#aaa;margin-left:4px">${esc(c.content)}</span>
          <div style="font-size:10px;color:#555;margin-top:2px">${UI.formatTime(c.created_at)}</div>
          <div class="sf-comment-votes" style="margin-top:4px">
            <button type="button" class="sf-vote-btn${upActive}" data-vote="up" onclick="voteWallComment(event, ${postId}, ${c.id}, 1, this)" aria-label="Like comment">
              <span class="sf-vote-icon">👍</span><span class="sf-vote-count">${upCount}</span>
            </button>
            <button type="button" class="sf-vote-btn${downActive}" data-vote="down" onclick="voteWallComment(event, ${postId}, ${c.id}, -1, this)" aria-label="Dislike comment">
              <span class="sf-vote-icon">👎</span>
            </button>
          </div>
        </div>
        ${c.user_id === State.user?.id ? `<button onclick="deleteWallComment(${c.id},${postId})" style="background:none;border:none;color:#666;cursor:pointer;font-size:11px" title="Delete">✕</button>` : ''}
      </div>
    `;}).join('');
    if (allowComments) {
      html += `
      <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
        <input id="wall-comment-input-${postId}" placeholder="Write a comment..." style="flex:1;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:16px;color:#e0e0e0;padding:6px 12px;font-size:12px;outline:none" onkeydown="if(event.key==='Enter'){event.preventDefault();submitWallComment(${postId})}">
        <button onclick="submitWallComment(${postId})" style="background:#4caf50;border:none;border-radius:50%;width:28px;height:28px;color:#000;font-size:14px;cursor:pointer;flex-shrink:0">➤</button>
      </div>`;
    }
    el.innerHTML = html || '<div style="color:#666;font-size:12px;padding:8px 0">No comments yet</div>' + (allowComments ? `<div style="display:flex;gap:6px;margin-top:8px;align-items:center"><input id="wall-comment-input-${postId}" placeholder="Write a comment..." style="flex:1;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:16px;color:#e0e0e0;padding:6px 12px;font-size:12px;outline:none" onkeydown="if(event.key==='Enter'){event.preventDefault();submitWallComment(${postId})}"><button onclick="submitWallComment(${postId})" style="background:#4caf50;border:none;border-radius:50%;width:28px;height:28px;color:#000;font-size:14px;cursor:pointer;flex-shrink:0">➤</button></div>` : '');
  } catch {
    el.innerHTML = '<div style="color:#666;font-size:12px;padding:8px 0">Could not load comments</div>';
  }
}

// Submit a comment on a wall post
async function submitWallComment(postId) {
  const input = document.getElementById(`wall-comment-input-${postId}`);
  if (!input || !input.value.trim()) return;
  try {
    const res = await apiFetch(`/api/wall/posts/${postId}/comments`, 'POST', { content: input.value.trim() });
    if (res.ok) {
      input.value = '';
      toggleWallComments(postId); // hide
      toggleWallComments(postId); // reload & show
    } else {
      const data = await res.json();
      toast(data.error || 'Could not comment', 'error');
    }
  } catch { toast('Could not comment', 'error'); }
}

// Delete a wall comment
async function deleteWallComment(commentId, postId) {
  try {
    const res = await apiFetch(`/api/wall/comments/${commentId}`, 'DELETE');
    if (res.ok) {
      const el = document.querySelector(`[data-comment-id="${commentId}"]`);
      if (el) el.remove();
    }
  } catch {}
}

// 👍/👎 a wall comment from the legacy ui.js renderer (profile page).
async function voteWallComment(ev, postId, commentId, value, btn) {
  try { ev?.preventDefault?.(); ev?.stopPropagation?.(); } catch {}
  if (!btn || btn.dataset.pending === '1') return;
  const wrap = btn.closest('.wall-comment-row') || btn.closest('[data-comment-id]');
  if (!wrap) return;
  const upBtn = wrap.querySelector('.sf-vote-btn[data-vote="up"]');
  const downBtn = wrap.querySelector('.sf-vote-btn[data-vote="down"]');
  const upCountEl = upBtn?.querySelector('.sf-vote-count');
  const wasUp = upBtn?.classList.contains('is-up');
  const wasDown = downBtn?.classList.contains('is-down');
  let newValue = value;
  if (value === 1 && wasUp) newValue = 0;
  if (value === -1 && wasDown) newValue = 0;
  const prevUp = Number(upCountEl?.textContent || '0');
  let nextUp = prevUp;
  if (wasUp && newValue !== 1) nextUp -= 1;
  if (!wasUp && newValue === 1) nextUp += 1;
  if (upCountEl) upCountEl.textContent = String(Math.max(0, nextUp));
  upBtn?.classList.toggle('is-up', newValue === 1);
  downBtn?.classList.toggle('is-down', newValue === -1);
  if (upBtn) upBtn.dataset.pending = '1';
  if (downBtn) downBtn.dataset.pending = '1';
  try {
    const res = await apiFetch(`/api/wall/posts/${postId}/comments/${commentId}/vote`, 'POST', { value: newValue });
    if (!res.ok) throw new Error('vote failed');
    const d = await res.json();
    if (upCountEl) upCountEl.textContent = String(d.like_count || 0);
    upBtn?.classList.toggle('is-up', Number(d.my_vote) === 1);
    downBtn?.classList.toggle('is-down', Number(d.my_vote) === -1);
  } catch {
    if (upCountEl) upCountEl.textContent = String(prevUp);
    upBtn?.classList.toggle('is-up', !!wasUp);
    downBtn?.classList.toggle('is-down', !!wasDown);
    if (typeof toast === 'function') toast('Could not vote', 'error');
  } finally {
    if (upBtn) delete upBtn.dataset.pending;
    if (downBtn) delete downBtn.dataset.pending;
  }
}

function showWallPostInput() {
  document.getElementById('wall-post-input').style.display = 'block';
  document.getElementById('wall-post-text').focus();
}

function hideWallPostInput() {
  const input = document.getElementById('wall-post-input');
  if (input) input.style.display = 'none';
  const text = document.getElementById('wall-post-text');
  if (text) text.value = '';
  clearWallPostMedia();
}

let _wallPostMediaData = null;
let _wallPostMediaType = null;

function handleWallPostMedia(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { toast('Image too large (max 10MB)', 'error'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    _wallPostMediaData = e.target.result;
    _wallPostMediaType = file.type;
    const preview = document.getElementById('wall-post-media-preview');
    const img = document.getElementById('wall-post-media-img');
    if (preview && img) {
      img.src = e.target.result;
      preview.style.display = 'block';
    }
  };
  reader.readAsDataURL(file);
}

function openWallPostCamera() {
  if (typeof openCameraCapture !== 'function') { toast('Camera unavailable', 'error'); return; }
  openCameraCapture((dataUrl) => {
    _wallPostMediaData = dataUrl;
    _wallPostMediaType = 'image/jpeg';
    const preview = document.getElementById('wall-post-media-preview');
    const img = document.getElementById('wall-post-media-img');
    if (preview && img) { img.src = dataUrl; preview.style.display = 'block'; }
  });
}

function clearWallPostMedia() {
  _wallPostMediaData = null;
  _wallPostMediaType = null;
  const preview = document.getElementById('wall-post-media-preview');
  if (preview) preview.style.display = 'none';
  const input = document.getElementById('wall-post-media-input');
  if (input) input.value = '';
}

async function submitWallPost() {
  const text = document.getElementById('wall-post-text');
  if (!text || (!text.value.trim() && !_wallPostMediaData)) return;
  if (!_userInfoTarget || _userInfoTarget !== State.user?.nickname) return;
  
  try {
    const payload = { content: text.value.trim() || '' };
    if (_wallPostMediaData) {
      payload.media_data = _wallPostMediaData;
      payload.media_type = _wallPostMediaType;
    }
    const res = await apiFetch('/api/wall/posts', 'POST', payload);
    
    if (res.ok) {
      hideWallPostInput();
      loadUserWall(_userInfoTarget);
      toast('Posted to wall!');
    } else {
      const data = await res.json();
      toast(data.error || 'Could not post', 'error');
    }
  } catch {
    toast('Could not post', 'error');
  }
}

async function deleteWallPost(postId) {
  if (!confirm('Delete this post?')) return;
  
  try {
    const res = await apiFetch(`/api/wall/posts/${postId}`, 'DELETE');
    if (res.ok) {
      if (_userInfoTarget) loadUserWall(_userInfoTarget);
      toast('Post deleted');
    }
  } catch {
    toast('Could not delete post', 'error');
  }
}

function dmUserInfo() {
  closeModal('modal-user-info');
  if (_userInfoTarget) {
    if (typeof openDMWithNick === 'function') openDMWithNick(_userInfoTarget);
    else Rooms.openDM(_userInfoTarget);
  }
}

function soundsUserInfo() {
  if (!_userInfoTarget) return;
  closeModal('modal-user-info');
  if (typeof openFriendSoundEditor === 'function') {
    openFriendSoundEditor(_userInfoTarget);
  } else {
    UI.showToast('Sound editor unavailable', 'error');
  }
}

// Toggle mute for the currently-inspected user. Purely client-side: their
// messages collapse to a click-to-reveal placeholder and we suppress any
// notification sounds / desktop popups for them.
function muteUserInfo() {
  if (!_userInfoTarget) return;
  if (typeof Mute === 'undefined') { UI.showToast('Mute unavailable', 'error'); return; }
  Mute.toggleUser(_userInfoTarget);
  _syncMuteButtonLabel();
}

// Keep the Mute button label in sync with state. Called from showUserInfo
// whenever the modal is (re)populated.
function _syncMuteButtonLabel() {
  const btn = document.getElementById('userinfo-mute-btn');
  if (!btn || !_userInfoTarget || typeof Mute === 'undefined') return;
  const isMuted = Mute.isUserMuted(_userInfoTarget);
  btn.textContent = isMuted ? '🔔 Unmute' : '🔕 Mute';
  btn.classList.toggle('is-active', isMuted);
}

async function blockUserInfo() {
  if (!_userInfoTarget) return;
  if (!confirm(`Block ${_userInfoTarget}? They won't be able to message you.`)) return;
  try {
    const res = await apiFetch(`/api/friends/block/${encodeURIComponent(_userInfoTarget)}`, 'POST');
    if (res.ok) {
      toast(`${_userInfoTarget} blocked`);
      if (typeof refreshBlockedCache === 'function') refreshBlockedCache();
      closeModal('modal-user-info');
    } else {
      const data = await res.json();
      toast(data.error || 'Failed to block user', 'error');
    }
  } catch {
    toast('Failed to block user', 'error');
  }
}

// Moderator actions - kick removes user from room temporarily
async function kickUserInfo() {
  if (!_userInfoTarget) return;
  if (!State.currentRoom || State.currentRoomType === 'dm') {
    toast('Cannot kick in DMs', 'error');
    return;
  }
  if (!confirm(`Kick ${_userInfoTarget} from #${State.currentRoom}?`)) return;

  // Find user ID
  try {
    const users = await apiFetch('/api/users').then(r => r.json()).then(d => d.users);
    const user = users.find(u => u.nickname === _userInfoTarget);
    if (!user) {
      toast('User not found', 'error');
      return;
    }

    // Ban for 1 minute (kick)
    const res = await apiFetch(`/api/rooms/${encodeURIComponent(State.currentRoom)}/bans`, 'POST', {
      user_id: user.id,
      reason: 'Kicked',
      duration_minutes: 1
    });

    if (res.ok) {
      toast(`${_userInfoTarget} kicked from #${State.currentRoom}`);
      closeModal('modal-user-info');
    } else {
      const data = await res.json();
      toast(data.error || 'Failed to kick user', 'error');
    }
  } catch (e) {
    toast('Failed to kick user', 'error');
  }
}

// Ban user from current room
async function banUserInfo() {
  if (!_userInfoTarget) return;
  if (!State.currentRoom || State.currentRoomType === 'dm') {
    toast('Cannot ban in DMs', 'error');
    return;
  }
  
  const reason = prompt(`Ban ${_userInfoTarget} from #${State.currentRoom}?\n\nEnter reason (optional):`);
  if (reason === null) return; // Cancelled

  try {
    const users = await apiFetch('/api/users').then(r => r.json()).then(d => d.users);
    const user = users.find(u => u.nickname === _userInfoTarget);
    if (!user) {
      toast('User not found', 'error');
      return;
    }

    const res = await apiFetch(`/api/rooms/${encodeURIComponent(State.currentRoom)}/bans`, 'POST', {
      user_id: user.id,
      reason: reason || '',
      duration_minutes: null // Permanent
    });

    if (res.ok) {
      toast(`${_userInfoTarget} banned from #${State.currentRoom}`);
      closeModal('modal-user-info');
    } else {
      const data = await res.json();
      toast(data.error || 'Failed to ban user', 'error');
    }
  } catch (e) {
    toast('Failed to ban user', 'error');
  }
}

// Check if current user can moderate current room
async function checkModStatus() {
  if (!State.currentRoom || State.currentRoomType === 'dm') return false;
  if (State.user?.is_admin) return true;
  
  try {
    const res = await apiFetch(`/api/rooms/${encodeURIComponent(State.currentRoom)}`);
    if (!res.ok) return false;
    const data = await res.json();
    return data.can_edit;
  } catch {
    return false;
  }
}

// Update showUserInfo to check mod status
const _originalShowUserInfo = showUserInfo;
showUserInfo = async function(nickname, userId, bridgePlatform, bridgeSourceName, bridgeSourceId, bridgeSourceParent, bridgeAvatar) {
  _originalShowUserInfo(nickname, userId, bridgePlatform, bridgeSourceName, bridgeSourceId, bridgeSourceParent, bridgeAvatar);
  if (bridgePlatform) return;
  
  // Check mod status and show kick/ban buttons
  const kickBtn = document.getElementById('userinfo-kick-btn');
  const banBtn = document.getElementById('userinfo-ban-btn');
  const djBtn = document.getElementById('userinfo-dj-btn');
  
  if (kickBtn) kickBtn.style.display = 'none';
  if (banBtn) banBtn.style.display = 'none';
  if (djBtn) djBtn.style.display = 'none';
  
  // Don't show for self or in DMs
  const isSelf = nickname === State.user?.nickname;
  if (isSelf || !State.currentRoom || State.currentRoomType === 'dm') return;
  
  // Check if current user can moderate
  const canMod = await checkModStatus();
  if (canMod) {
    if (kickBtn) kickBtn.style.display = '';
    if (banBtn) banBtn.style.display = '';
    // DJ button only in music channels
    const chType = State.currentChannelType;
    const isMusic = chType === 'music' || chType === 'voice';
    if (djBtn && isMusic && userId) {
      djBtn.dataset.nick = nickname;
      djBtn.dataset.uid = userId;
      const isDj = window.Music?.isDJ?.(userId);
      djBtn.textContent = isDj ? '🎧 Remove DJ' : '🎧 Make DJ';
      djBtn.style.display = '';
    }
  }
};

async function toggleDJFromProfile() {
  const btn = document.getElementById('userinfo-dj-btn');
  if (!btn) return;
  const uid = parseInt(btn.dataset.uid || '0', 10);
  if (!uid) return;
  const isDj = window.Music?.isDJ?.(uid);
  if (isDj) {
    await window.Music?.revokeDJ?.(uid);
    btn.textContent = '🎧 Make DJ';
  } else {
    await window.Music?.grantDJ?.(uid);
    btn.textContent = '🎧 Remove DJ';
  }
}
window.toggleDJFromProfile = toggleDJFromProfile;

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

function showSearchModal() {
  document.getElementById('modal-search').classList.remove('hidden');
  document.getElementById('search-input').value = '';
  const scopeEl = document.getElementById('search-scope');
  if (scopeEl) {
    scopeEl.textContent = (State.currentRoom && State.currentRoomType !== 'dm')
      ? `#${State.currentRoom}`
      : 'Global';
  }
  document.getElementById('search-results').innerHTML = '<div style="color:#555;text-align:center;padding:40px 20px"><div style="font-size:32px;margin-bottom:8px;opacity:.5">🔍</div><div style="font-size:13px">Search messages by keyword</div></div>';
  setTimeout(() => document.getElementById('search-input').focus(), 100);
}

async function performSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;
  
  const resultsEl = document.getElementById('search-results');
  resultsEl.innerHTML = '<div style="color:#666;text-align:center;padding:30px">Searching…</div>';
  
  try {
    // Search in current room or globally
    let url;
    const isGlobal = !State.currentRoom || State.currentRoomType === 'dm';
    if (!isGlobal) {
      url = `/api/messages/${encodeURIComponent(State.currentRoom)}/search?q=${encodeURIComponent(query)}`;
    } else {
      url = `/api/messages/search/global?q=${encodeURIComponent(query)}`;
    }
    
    const res = await apiFetch(url);
    if (!res.ok) throw new Error('Search failed');
    
    const data = await res.json();
    
    // Normalize results — global returns {rooms:[], dms:[]}, room returns flat array
    let results = [];
    if (data.results?.rooms) results.push(...data.results.rooms);
    if (data.results?.dms) results.push(...data.results.dms);
    if (Array.isArray(data.results)) results = data.results;
    
    if (!results.length) {
      resultsEl.innerHTML = `<div style="color:#666;text-align:center;padding:30px">
        <div style="font-size:32px;margin-bottom:8px">🔍</div>
        <div>No results for "<strong style="color:#e0e0e0">${UI.escHtml(query)}</strong>"</div>
      </div>`;
      return;
    }

    const heading = isGlobal ? 'Global results' : `Results in #${UI.escHtml(State.currentRoom)}`;
    resultsEl.innerHTML = `<div style="font-size:12px;color:#666;margin-bottom:8px;padding:0 4px">${heading} — ${results.length} match${results.length !== 1 ? 'es' : ''}</div>` +
      results.map(r => {
      const nick = r.nickname || r.sender_nick || 'Unknown';
      const loc = r.room_name ? `#${r.room_name}` : (r.peer_nick ? `DM with ${r.peer_nick}` : '');
      const content = r.content || '';
      // Highlight the match
      const hl = content.substring(0, 200).replace(
        new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
        '<mark style="background:#4caf5040;color:#4caf50;border-radius:2px;padding:0 1px">$1</mark>'
      );
      return `
      <div class="search-result" onclick="jumpToMessage(${r.id}, '${UI.escHtml(r.room_name || '')}', ${r.channel_id || 0})"
           style="padding:10px 12px;border-radius:8px;background:#1a1a1a;margin-bottom:6px;cursor:pointer;transition:all .15s;border:1px solid #222">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          ${UI.avatarEl(r.avatar, nick, 24)}
          <span style="font-weight:600;color:#e0e0e0;font-size:13px">${UI.escHtml(nick)}</span>
          ${loc ? `<span style="color:#4caf50;font-size:11px;background:#1a3a1a;border-radius:4px;padding:1px 6px">${UI.escHtml(loc)}</span>` : ''}
          <span style="color:#444;font-size:11px;margin-left:auto;white-space:nowrap">${UI.formatTime(r.created_at)}</span>
        </div>
        <div style="color:#bbb;font-size:13px;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">
          ${content ? hl : '<span style="color:#888;font-style:italic">📎 Media attachment</span>'}
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    resultsEl.innerHTML = '<div style="color:#ff5555;text-align:center;padding:30px">Search failed — try again</div>';
  }
}

function jumpToMessage(msgId, roomName, channelId) {
  closeModal('modal-search');
  if (roomName && roomName !== State.currentRoom) {
    // Switch to room first, then scroll
    switchRoom(roomName);
    setTimeout(() => scrollToMsgId(msgId), 500);
  } else if (channelId && typeof openDMById === 'function') {
    openDMById(channelId);
    setTimeout(() => scrollToMsgId(msgId), 500);
  } else {
    scrollToMsgId(msgId);
  }
}

function scrollToMsgId(msgId) {
  const el = document.getElementById(`msg-${msgId}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.animation = 'highlight 2s';
    setTimeout(() => el.style.animation = '', 2000);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PINNED MESSAGES
// ═══════════════════════════════════════════════════════════════════════════════

async function showPinnedMessages() {
  const modal = document.getElementById('modal-pins');
  const list = document.getElementById('pins-list');
  const empty = document.getElementById('pins-empty');
  
  modal.classList.remove('hidden');
  list.innerHTML = '<div style="color:#666;text-align:center;padding:20px">Loading…</div>';
  empty.style.display = 'none';
  
  if (!State.currentRoom || State.currentRoomType === 'dm') {
    list.innerHTML = '';
    empty.textContent = 'Pinned messages are only available in channels';
    empty.style.display = 'block';
    return;
  }
  
  try {
    const res = await apiFetch(`/api/rooms/${encodeURIComponent(State.currentRoom)}/pins`);
    if (!res.ok) throw new Error('Failed to load pins');
    
    const data = await res.json();
    const pins = data.pins || [];
    
    if (!pins.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    
    empty.style.display = 'none';
    list.innerHTML = pins.map(p => `
      <div class="pin-item" style="padding:12px;border-radius:8px;background:#1a1a1a;margin-bottom:8px;position:relative">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-weight:600;color:#4caf50">${UI.escHtml(p.nickname)}</span>
          <span style="color:#444;font-size:11px">${UI.formatDate(p.created_at)} ${UI.formatTime(p.created_at)}</span>
        </div>
        <div style="color:#e0e0e0;font-size:14px">${UI.escHtml(p.content || '📎 Media')}</div>
        <div style="font-size:11px;color:#666;margin-top:6px">Pinned by ${UI.escHtml(p.pinned_by_nick)}</div>
        <button onclick="unpinMessage(${p.id})" style="position:absolute;top:8px;right:8px;background:none;border:none;color:#666;cursor:pointer;font-size:14px" title="Unpin">✕</button>
        <button onclick="jumpToMessage(${p.id}, '${UI.escHtml(State.currentRoom)}', 0)" style="position:absolute;bottom:8px;right:8px;background:none;border:none;color:#4caf50;cursor:pointer;font-size:12px">Jump →</button>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = '<div style="color:#ff5555;text-align:center;padding:20px">Failed to load pins</div>';
  }
}

async function pinMessage(msgId) {
  if (!State.currentRoom || State.currentRoomType === 'dm') return;
  
  try {
    const res = await apiFetch(`/api/rooms/${encodeURIComponent(State.currentRoom)}/pins/${msgId}`, {
      method: 'POST'
    });
    if (res.ok) {
      toast('Message pinned', 'success');
    } else {
      const data = await res.json();
      toast(data.error || 'Failed to pin', 'error');
    }
  } catch (e) {
    toast('Failed to pin message', 'error');
  }
}

async function unpinMessage(msgId) {
  if (!State.currentRoom) return;
  
  try {
    const res = await apiFetch(`/api/rooms/${encodeURIComponent(State.currentRoom)}/pins/${msgId}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      toast('Message unpinned', 'success');
      showPinnedMessages(); // Refresh the list
    } else {
      toast('Failed to unpin', 'error');
    }
  } catch (e) {
    toast('Failed to unpin message', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// @MENTION AUTOCOMPLETE
// ═══════════════════════════════════════════════════════════════════════════════

let _mentionUsers = [];
let _mentionOpen = false;
let _mentionIndex = 0;
let _mentionLoadedAt = 0;
let _mentionLoading = null;
let _mentionScope = '';

function _currentMentionScope() {
  const room = String(State?.currentRoom || '').trim();
  if (!room) return '';
  const joined = Array.isArray(State?.rooms) && State.rooms.some(r => r && r.name === room);
  return joined ? room : '';
}

async function loadMentionUsers(force = false) {
  const scope = _currentMentionScope();
  const scopeChanged = scope !== _mentionScope;
  // Throttle: at most one refresh every 10s unless forced.
  const now = Date.now();
  if (!force && !scopeChanged && _mentionLoadedAt && now - _mentionLoadedAt < 10000) return;
  if (_mentionLoading) return _mentionLoading;
  _mentionLoading = (async () => {
    try {
      const url = scope
        ? `/api/messages/users/mentionable?room_name=${encodeURIComponent(scope)}`
        : '/api/messages/users/mentionable';
      const res = await apiFetch(url);
      if (res.ok) {
        const data = await res.json();
        _mentionUsers = data.users || [];
        _mentionLoadedAt = Date.now();
        _mentionScope = scope;
      }
    } catch (e) {}
    finally { _mentionLoading = null; }
  })();
  return _mentionLoading;
}

// Hook so other modules (ws, rooms, presence) can request a refresh when a
// new member shows up. Exposed via window for cross-file access.
function refreshMentionUsers(force = false) { return loadMentionUsers(force); }
window.refreshMentionUsers = refreshMentionUsers;

function handleMentionInput(input) {
  const text = input.value;
  const cursorPos = input.selectionStart;
  
  // Find @ before cursor
  const beforeCursor = text.substring(0, cursorPos);
  const atMatch = beforeCursor.match(/@(\w*)$/);
  
  const dropdown = document.getElementById('mention-dropdown');
  if (!dropdown) return;
  
  if (!atMatch) {
    dropdown.style.display = 'none';
    _mentionOpen = false;
    return;
  }

  // Refresh mentionable users in the background each time an @ trigger
  // appears so newly-joined channel members show up without an app reload.
  // Throttled inside loadMentionUsers (10s) so this is cheap.
  loadMentionUsers();
  
  const query = atMatch[1].toLowerCase();
  const filtered = _mentionUsers.filter(u => 
    u.nickname.toLowerCase().includes(query)
  ).slice(0, 8);
  
  if (!filtered.length) {
    dropdown.style.display = 'none';
    _mentionOpen = false;
    return;
  }
  
  _mentionOpen = true;
  _mentionIndex = 0;
  
  dropdown.innerHTML = filtered.map((u, i) => {
    const online = u.presence === 'online';
    return `
      <div class="mention-item${i === 0 ? ' selected' : ''}" data-nick="${UI.escHtml(u.nickname)}" onclick="insertMention('${UI.escHtml(u.nickname)}')">
        ${UI.avatarEl(u.avatar, u.nickname, 24)}
        <span class="mention-nick">${UI.escHtml(u.nickname)}</span>
        <span class="mention-presence ${online ? 'online' : 'offline'}" title="${online ? 'Online' : 'Offline'}"></span>
      </div>
    `;
  }).join('');
  
  dropdown.style.display = 'block';
  
  // Position dropdown above input
  const rect = input.getBoundingClientRect();
  dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
  dropdown.style.left = rect.left + 'px';
  dropdown.style.width = Math.min(rect.width, 300) + 'px';
}

function handleMentionKeydown(e) {
  const dropdown = document.getElementById('mention-dropdown');
  if (!_mentionOpen || !dropdown) return false;
  
  const items = dropdown.querySelectorAll('.mention-item');
  if (!items.length) return false;
  
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[_mentionIndex].classList.remove('selected');
    _mentionIndex = (_mentionIndex + 1) % items.length;
    items[_mentionIndex].classList.add('selected');
    return true;
  }
  
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    items[_mentionIndex].classList.remove('selected');
    _mentionIndex = (_mentionIndex - 1 + items.length) % items.length;
    items[_mentionIndex].classList.add('selected');
    return true;
  }
  
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const nick = items[_mentionIndex].dataset.nick;
    insertMention(nick);
    return true;
  }
  
  if (e.key === 'Escape') {
    dropdown.style.display = 'none';
    _mentionOpen = false;
    return true;
  }
  
  return false;
}

function insertMention(nickname) {
  const input = document.getElementById('msg-input');
  if (!input) return;
  
  const text = input.value;
  const cursorPos = input.selectionStart;
  const beforeCursor = text.substring(0, cursorPos);
  const afterCursor = text.substring(cursorPos);
  
  // Replace @partial with @nickname
  const newBefore = beforeCursor.replace(/@\w*$/, `@${nickname} `);
  input.value = newBefore + afterCursor;
  input.selectionStart = input.selectionEnd = newBefore.length;
  input.focus();
  
  const dropdown = document.getElementById('mention-dropdown');
  if (dropdown) dropdown.style.display = 'none';
  _mentionOpen = false;
}

// Load mention users on app init
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(loadMentionUsers, 2000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SMART TOOLTIPS - Viewport-aware positioning
// ═══════════════════════════════════════════════════════════════════════════════

function initSmartTooltips() {
  // Use JS-based tooltips for elements with data-tip-smart attribute
  document.addEventListener('mouseenter', e => {
    if (!e.target || !e.target.closest) return;
    const el = e.target.closest('[data-tip]');
    if (!el || el._tooltip) return;
    
    const rect = el.getBoundingClientRect();
    const tip = document.createElement('div');
    tip.className = 'smart-tooltip';
    tip.textContent = el.getAttribute('data-tip');
    tip.style.cssText = `
      position:fixed;
      background:#0d0d0d;
      color:#e0e0e0;
      font-size:12px;
      padding:6px 10px;
      border-radius:6px;
      white-space:nowrap;
      pointer-events:none;
      border:1px solid #2a2a2a;
      z-index:9999;
      opacity:0;
      transition:opacity 0.15s;
      box-shadow:0 2px 10px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(tip);
    
    // Calculate best position
    const tipRect = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    
    let top, left;
    const explicitPos = el.getAttribute('data-tip-pos');
    
    // Try explicit position first, then find best fit
    if (explicitPos === 'right' && rect.right + tipRect.width + margin < vw) {
      top = rect.top + rect.height/2 - tipRect.height/2;
      left = rect.right + margin;
    } else if (explicitPos === 'left' && rect.left - tipRect.width - margin > 0) {
      top = rect.top + rect.height/2 - tipRect.height/2;
      left = rect.left - tipRect.width - margin;
    } else if (explicitPos === 'bottom' && rect.bottom + tipRect.height + margin < vh) {
      top = rect.bottom + margin;
      left = rect.left + rect.width/2 - tipRect.width/2;
    } else if (rect.top - tipRect.height - margin > 0) {
      // Default: above
      top = rect.top - tipRect.height - margin;
      left = rect.left + rect.width/2 - tipRect.width/2;
    } else if (rect.bottom + tipRect.height + margin < vh) {
      // Fallback: below
      top = rect.bottom + margin;
      left = rect.left + rect.width/2 - tipRect.width/2;
    } else if (rect.right + tipRect.width + margin < vw) {
      // Fallback: right
      top = rect.top + rect.height/2 - tipRect.height/2;
      left = rect.right + margin;
    } else {
      // Last resort: left
      top = rect.top + rect.height/2 - tipRect.height/2;
      left = rect.left - tipRect.width - margin;
    }
    
    // Clamp to viewport
    if (left < margin) left = margin;
    if (left + tipRect.width > vw - margin) left = vw - tipRect.width - margin;
    if (top < margin) top = margin;
    if (top + tipRect.height > vh - margin) top = vh - tipRect.height - margin;
    
    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
    
    requestAnimationFrame(() => { tip.style.opacity = '1'; });
    
    el._tooltip = tip;
  }, true);
  
  document.addEventListener('mouseleave', e => {
    if (!e.target || !e.target.closest) return;
    const el = e.target.closest('[data-tip]');
    if (el && el._tooltip) {
      el._tooltip.remove();
      el._tooltip = null;
    }
  }, true);
}

// Initialize smart tooltips
document.addEventListener('DOMContentLoaded', initSmartTooltips);

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE SHARING
// ═══════════════════════════════════════════════════════════════════════════════

function shareProfile() {
  const nickname = _userInfoTarget;
  const userId = _userInfoTargetId;
  if (!nickname) return;
  const bio = document.getElementById('userinfo-bio')?.textContent?.trim() || '';
  // Populate room destination dropdown
  const sel = document.getElementById('share-dest-select');
  if (sel) {
    sel.innerHTML = '';
    State.rooms.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.name;
      opt.textContent = '#' + r.name;
      if (r.name === State.currentRoom) opt.selected = true;
      sel.appendChild(opt);
    });
  }
  // Build preview card
  const prev = document.getElementById('share-preview-card');
  if (prev) {
    prev.innerHTML = `<div class="share-card" style="cursor:default">
      <div style="width:42px;height:42px;border-radius:50%;background:#7c5cbf;display:flex;align-items:center;justify-content:center;font-size:18px;color:#fff;font-weight:700;flex-shrink:0">${UI.escHtml(nickname.charAt(0).toUpperCase())}</div>
      <div class="share-card-info">
        <div class="share-card-label">FrogTalk Profile</div>
        <div class="share-card-name">${UI.escHtml(nickname)}</div>
        ${bio ? `<div class="share-card-bio">${UI.escHtml(bio.substring(0, 80))}</div>` : ''}
      </div>
    </div>`;
  }
  window._pendingShareData = JSON.stringify({ _type: 'profile_share', nickname, user_id: userId, bio: bio.substring(0, 120) });
  closeModal('modal-user-info');
  openModal('modal-share-to-chat');
}

function copyUserTag(nickname) {
  if (!nickname) return;
  const tag = '@' + nickname;
  navigator.clipboard.writeText(tag).then(() => {
    UI.showToast(`Copied ${tag} to clipboard`);
  }).catch(() => {});
}

function doShareToChat() {
  const dest = document.getElementById('share-dest-select')?.value;
  const content = window._pendingShareData;
  if (!dest || !content) return;
  if (typeof Rooms !== 'undefined' && typeof Rooms.joinRoom === 'function') {
    Rooms.joinRoom(dest);
  }
  setTimeout(() => {
    if (typeof WS !== 'undefined') {
      WS.send({ type: 'message', content, media_data: null, media_type: null, media_blur: 0, view_once: 0 });
    }
  }, dest === State.currentRoom ? 0 : 600);
  closeModal('modal-share-to-chat');
  window._pendingShareData = null;
  toast('Profile shared');
}
