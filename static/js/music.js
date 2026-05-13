/**
 * music.js — Music/Radio channel UI
 *
 * Renders an embedded player (YouTube / Spotify) with a queue and submit box.
 * Chat still happens in the standard #messages-area below the player.
 * Permissions:
 *   - Owner/admin/mod can skip, clear queue, toggle "DJ-only submit", manage DJs
 *   - DJs can also skip + clear
 *   - Anyone can submit unless `dj_only` is set; then only DJs/owner/admin/mod
 */
const Music = (() => {
  let _room = null;       // active music room name
  let _state = null;      // { queue, djs, dj_only, can_submit, can_control, is_dj }
  let _soloMode = false;  // true when playing a track via Music.playSolo (no room)
  let _paused = false;    // mirrors current play/pause state (best-effort; iframe APIs don't always notify)
  // Sticky flag: set ONLY when the user explicitly pauses via togglePause
  // (dock / mini bar / drawer button). Cleared on user-initiated play and
  // when the head track changes. Used to suppress the auto-resume ladder
  // when the user genuinely wants playback paused — without this, any
  // focus/visibility flicker (opening the channel-list drawer on mobile,
  // alt-tabbing back, the WebView regaining focus) restarts audio behind
  // the user's back.
  let _userPaused = false;
  let _muted = false;     // native Android notification mute state (best-effort)
  // User collapsed the player (button in the header) — channel stays open
  // but the iframe + meta shrink to a slim bar so the chat takes the rest
  // of the screen. Persisted in localStorage so it survives reloads.
  let _collapsed = (() => {
    try { return localStorage.getItem('mp.collapsed') === '1'; } catch { return false; }
  })();
  // Radio-sync anchor: the wall-clock moment (ms) at which the current head
  // track would have started if played from 0. `position_sec` is derived
  // from this on every check — all clients that share a server-supplied
  // anchor stay aligned even if they pause/seek locally.
  let _anchorMs = 0;
  let _anchorTrackKey = '';  // `${provider}:${video_id}` of the anchored track
  let _syncTimer = null;
  // Phase 1/4: dedupe + debounce metadata pushes so a WS burst (or a
  // chatty `_render` tick) can't hammer the system tray / Android service.
  let _lastEmitHash = '';
  let _emitTimer = null;
  let _msHandlersBound = false;
  let _autoAdvanceLastKey = '';
  let _autoAdvanceLastAt = 0;
  // Last duration (seconds) the YouTube/SoundCloud iframe reported via
  // infoDelivery. Used to clamp Resync seeks so we never request a
  // position past the end of the video (which YT silently honours,
  // leaving the player stuck on the last frame). Reset on every
  // head-track change.
  let _currentDurationSec = 0;

  // Live radio-sync probe state. We poll the iframe's actual play head
  // every ~4s while the panel is visible and audio is playing, and update
  // a small badge in-place (no full re-render). This stays cheap because:
  //   - probe is iframe postMessage only — no network, no DB, no WS.
  //   - paused/hidden/no-track halts the timer entirely.
  //   - we update only the badge node, never re-render the whole panel.
  //   - YouTube replies asynchronously; we read those replies in a single
  //     window 'message' listener installed once.
  const SYNC_TOLERANCE_OK = 1.2;     // <1.2s drift → green (real-world tight)
  const SYNC_TOLERANCE_WARN = 4.0;   // <4s drift → yellow, else red
  const SYNC_PROBE_INTERVAL_MS = 10000;  // steady-state — gentle on the iframe
  const SYNC_PROBE_TIMEOUT_MS = 1500;
  let _syncProbeTimer = null;
  let _syncProbePending = false;
  let _syncProbeFiredAt = 0;
  let _syncMsgListenerBound = false;
  let _lastDriftSec = null;          // null = unknown/checking
  let _lastSyncProvider = '';
  let _lastPlayerState = null;       // YouTube playerState: 1=play 2=pause 3=buffer
  // Wall-clock ms of the most recent USER play/pause toggle (button click,
  // notification action, togglePauseGlobal, etc.). Iframe state events
  // that arrive within USER_INTENT_GUARD_MS AFTER this and CONTRADICT
  // the user's intent are ignored — they are almost always stale
  // pre-toggle state messages still in flight from the embed and were
  // the root cause of the play/pause button flipping back to the wrong
  // icon a moment after the click.
  let _userIntentAt = 0;
  let _userIntentPaused = null;      // last user-intent value (true=paused)
  const USER_INTENT_GUARD_MS = 900;
  function _userIntentActive() {
    return _userIntentPaused !== null
      && (Date.now() - _userIntentAt) < USER_INTENT_GUARD_MS;
  }
  let _syncProbeStartedAt = 0;       // ms when probing began for current track
  let _syncFastProbeTimers = [];     // setTimeouts queued by fast re-probe
  // Lightweight UI-only re-sync. Fires every ~1.5s while a track is
  // mounted to guarantee the play/pause icon on every visible button
  // matches reality, even when the heavy sync probe is paused (track
  // paused, or between probes). YT's onStateChange/infoDelivery keep
  // _lastPlayerState honest; this just propagates that to the DOM.
  let _uiSyncTimer = null;
  const UI_SYNC_INTERVAL_MS = 1500;
  // Last paused flag we broadcast to the rest of the app. Used by the UI
  // tick to detect drift between music:statechange listeners (FrogSocial
  // top strip, music cards, etc.) and reality, and to fire a fresh
  // _emitState() ONLY when the effective state has flipped — so the
  // dedupe inside _emitState does the right thing and we don't spam.
  let _lastBroadcastPaused = null;
  function _broadcastIfChanged() {
    const cur = _state && _state.queue && _state.queue[0];
    if (!cur) return;
    const effective = _currentEffectivePaused();
    if (effective !== _lastBroadcastPaused) {
      _lastBroadcastPaused = effective;
      // Force the dedupe to let this through.
      _lastEmitHash = '';
      try { _emitState(); } catch {}
    }
  }
  // SoundCloud Widget API: subscribe once per iframe to play/pause/finish
  // events so we can reconcile _paused without polling. Idempotent: marks
  // the iframe with data-sc-bound after subscribing.
  function _bindSoundCloudWidget(frame) {
    if (!frame || !frame.contentWindow) return;
    if (!(frame.src || '').includes('soundcloud.com')) return;
    if (frame.dataset.scBound === '1') return;
    frame.dataset.scBound = '1';
    try {
      ['play', 'pause', 'finish'].forEach(ev => {
        frame.contentWindow.postMessage(
          JSON.stringify({ method: 'addEventListener', value: ev }), '*');
      });
    } catch {}
  }

  function _startUiSync() {
    if (_uiSyncTimer) return;
    _uiSyncTimer = setInterval(() => {
      try {
        // Re-handshake YT's listening channel each tick (idempotent) so
        // the iframe keeps pushing state events; cheap insurance against
        // a remounted iframe that lost the registration.
        const cur = _state && _state.queue && _state.queue[0];
        const frame = document.querySelector('#mp-player-wrap iframe.mp-frame');
        if (cur && cur.provider === 'youtube') {
          if (frame && frame.contentWindow) {
            try {
              frame.contentWindow.postMessage(
                JSON.stringify({ event: 'listening', id: 'frogtalk-music' }), '*');
              // Asking for currentTime triggers an infoDelivery reply
              // which carries playerState. Free state-truth refresh.
              frame.contentWindow.postMessage(
                JSON.stringify({ event: 'command', func: 'getPlayerState', args: [] }), '*');
            } catch {}
          }
        } else if (cur && cur.provider === 'soundcloud') {
          if (frame && frame.contentWindow) {
            try {
              _bindSoundCloudWidget(frame);
              // Cheap state-truth refresh: SC widget answers with
              // {method:"isPaused", value:bool} which the listener
              // reconciles into _paused.
              frame.contentWindow.postMessage(
                JSON.stringify({ method: 'isPaused' }), '*');
            } catch {}
          }
        }
        _syncPlayPauseButtons();
        // Recovery heartbeat: reconcile `_paused` to YT/SC ground truth
        // even when no state event fired. The infoDelivery/onStateChange
        // listeners only correct drift when an event arrives — so if YT
        // is steadily reporting state=1 ("playing") and our local
        // `_paused` got stuck `true` (stale pre-toggle event, app
        // visibility race, _onAppHidden optimism, etc.), nothing else
        // will heal it. Run outside the user-intent guard window so we
        // don't fight a fresh user click.
        try {
          if (cur && cur.provider === 'youtube'
              && (_lastPlayerState === 1 || _lastPlayerState === 2)
              && !_userIntentActive()) {
            const ytPaused = (_lastPlayerState === 2);
            if (_paused !== ytPaused) {
              _paused = ytPaused;
              _lastEmitHash = '';
              try { _emitState(); } catch {}
            }
          }
        } catch {}
        // Repaint downstream consumers (FrogSocial top "Now playing"
        // strip, music cards) when our effective paused flag has drifted
        // from what they last saw — without this, a transient YT state=2
        // during iframe mount/track-change leaves the strip stuck on
        // "Paused" even after audio is happily playing again.
        _broadcastIfChanged();
        // Belt + braces: the postMessages above are async — YT's reply
        // updates _lastPlayerState ~tens of ms later. Schedule a
        // delayed repaint so any state correction from this tick's
        // probe lands on the side-menu mini-dock button (.mmd-play)
        // and the FrogSocial top strip BEFORE the next tick. Without
        // this, a stale ▶/⏸ icon can survive an extra ~1.5s window.
        setTimeout(() => {
          try { _syncPlayPauseButtons(); } catch {}
          try { _broadcastIfChanged(); } catch {}
        }, 350);
      } catch {}
    }, UI_SYNC_INTERVAL_MS);
  }
  function _stopUiSync() {
    if (_uiSyncTimer) { clearInterval(_uiSyncTimer); _uiSyncTimer = null; }
    _lastBroadcastPaused = null;
  }
  const $ = (id) => document.getElementById(id);
  const esc = (s) => UI.escHtml(String(s || ''));

  // Strict allowlist for artwork URLs. Anything outside the known
  // CDN hosts (or a small set of inline data: types) is rejected so
  // hostile track metadata can't smuggle `javascript:` / `file:` /
  // arbitrary HTTP into either `mediaSession.metadata` or the Android
  // bitmap loader. Keep the list in sync with MusicService.kt.
  const _ARTWORK_HOSTS = new Set([
    'i.ytimg.com',
    'img.youtube.com',
    'i1.sndcdn.com',
    'i.scdn.co',
  ]);
  function _safeArtwork(url) {
    if (!url || typeof url !== 'string') return '';
    if (url.length > 2048) return '';
    // Allow short inline images (rare, but harmless and same-origin-ish).
    if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(url)
        && url.length < 200000) {
      return url;
    }
    try {
      const u = new URL(url, location.origin);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
      if (!_ARTWORK_HOSTS.has(u.hostname)) return '';
      // Force https on http CDN urls.
      if (u.protocol === 'http:') u.protocol = 'https:';
      return u.toString();
    } catch { return ''; }
  }

  // Length-cap + control-char strip for any string we hand to the system
  // tray or to Android. Defends older Android / native clients from
  // hostile titles. Pure web mediaSession is also more pleasant without
  // 4kB titles.
  function _sanitizeText(s, max) {
    if (s == null) return '';
    let t = String(s);
    // Strip C0 + DEL.
    t = t.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
    if (t.length > (max || 200)) t = t.slice(0, max || 200);
    return t;
  }

  function _expectedPosSec() {
    if (!_anchorMs) return 0;
    return Math.max(0, Math.floor((Date.now() - _anchorMs) / 1000));
  }

  // Inline SVG for the "skip to next track" icon. Some Android WebView
  // emoji fonts render U+23ED without the trailing bar — it ends up
  // looking like a plain double-chevron (">>"). SVG renders identically
  // everywhere; sized to match the surrounding emoji buttons.
  const _SKIP_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em"><path d="M6 5l9 7-9 7V5zm11 0h2v14h-2V5z"/></svg>';
  // Plain white play / pause glyphs. Same visual weight so the dock
  // button doesn't shift when toggling state. Using SVG (not emoji)
  // because Android WebView renders ⏸ in colour on some skins which
  // looks out of place next to the SVG skip icon.
  const _PLAY_SVG  = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em"><path d="M8 5v14l11-7z"/></svg>';
  const _PAUSE_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
  // Auto-next ON: stylized ⏭ with a small loop indicator. OFF: same skip
  // glyph dimmed with a strike. Kept as inline SVG so it sits next to the
  // other dock controls without font-emoji weirdness.
  const _AUTONEXT_ON_SVG  = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em"><path d="M6 5l9 7-9 7V5zm11 0h2v14h-2V5z"/><circle cx="20" cy="5" r="3" fill="#4caf50"/></svg>';
  const _AUTONEXT_OFF_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;opacity:0.55"><path d="M6 5l9 7-9 7V5zm11 0h2v14h-2V5z"/><path d="M3 21L21 3" stroke="#e74c3c" stroke-width="2" fill="none"/></svg>';
  const _AUTONEXT_LS_KEY = 'frogtalk:music:autonext';
  function _autoNextEnabled() {
    try { return localStorage.getItem(_AUTONEXT_LS_KEY) !== '0'; } catch { return true; }
  }

  // Owner / DJ toggle: when the channel queue runs dry, automatically
  // submit a fresh track from the FrogSocial Discover algorithm so the
  // music never stops. Off by default (opt-in) — only fires when the
  // local user has can_control on the room. Per-room key so different
  // rooms can have different policies.
  const _AUTOFILL_LS_PREFIX = 'frogtalk:music:autofill:';
  function _autoFillKey(room) { return _AUTOFILL_LS_PREFIX + (room || ''); }
  function _autoFillEnabled(room) {
    try { return localStorage.getItem(_autoFillKey(room)) === '1'; } catch { return false; }
  }
  function toggleAutoFill() {
    if (!_room || !_state || !_state.can_control) return;
    const next = !_autoFillEnabled(_room);
    try { localStorage.setItem(_autoFillKey(_room), next ? '1' : '0'); } catch {}
    try { UI.showToast && UI.showToast(next
      ? 'Auto-fill on — Discover picks will keep #' + _room + ' going'
      : 'Auto-fill off', 'info', 2000); } catch {}
    try { _render(); } catch {}
    if (next) { try { _maybeAutoFillEmptyQueue(); } catch {} }
  }
  let _autoFillLastAt = 0;
  let _autoFillInFlight = false;
  async function _maybeAutoFillEmptyQueue() {
    if (!_room || !_state || !_state.can_control) return;
    if (!_autoFillEnabled(_room)) return;
    const q = _state.queue || [];
    if (q.length > 0) return;          // something is still playing / queued
    if (_autoFillInFlight) return;
    const now = Date.now();
    if ((now - _autoFillLastAt) < 8000) return;  // debounce churn
    _autoFillLastAt = now;
    _autoFillInFlight = true;
    try {
      const S = window.Social;
      let next = null;
      if (S && typeof S.getNextMusicTrack === 'function') {
        try { next = S.getNextMusicTrack('', {}); } catch {}
      }
      if ((!next || !next.url) && S && typeof S.fetchDiscoverMusicTrack === 'function') {
        try { next = await S.fetchDiscoverMusicTrack(''); } catch {}
      }
      if (next && next.url) {
        try { UI.showToast && UI.showToast('Auto-fill: queued a Discover pick 🎵', 'info', 1800); } catch {}
        try { await submit(next.url); } catch {}
      }
    } finally {
      _autoFillInFlight = false;
    }
  }
  function _syncAutoNextButtons() {
    const on = _autoNextEnabled();
    const svg = on ? _AUTONEXT_ON_SVG : _AUTONEXT_OFF_SVG;
    // Polished checkbox-style controls on mini-dock + FrogSocial strip.
    // Mirror the live setting onto every <input data-autonext-check>; we
    // also flip a sibling label class so the custom-painted box reflects
    // the on/off state without depending on :checked alone (some Android
    // WebView builds don't repaint the ::before glyph on programmatic
    // checked changes — this dataset hook is a reliable backup).
    document.querySelectorAll('[data-autonext-check]').forEach(inp => {
      inp.checked = on;
      const wrap = inp.closest('.mp-an-check');
      if (wrap) {
        wrap.classList.toggle('on', on);
        wrap.title = on ? 'Auto-next: on (uncheck to disable)' : 'Auto-next: off (check to enable)';
      }
    });
    document.querySelectorAll('[data-autonext-btn]').forEach(b => {
      b.dataset.on = on ? '1' : '0';
      b.classList.toggle('on', on);
      b.title = on ? 'Auto-next: on (click to disable)' : 'Auto-next: off (click to enable)';
      b.setAttribute('aria-label', b.title);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      // Preserve a sibling <span class="san-label"> if present (topbar
      // variant). Replace only the leading <svg>; if no svg child, fall
      // back to setting innerHTML.
      const existingSvg = b.querySelector(':scope > svg');
      if (existingSvg) {
        const tmp = document.createElement('div');
        tmp.innerHTML = svg;
        const newSvg = tmp.firstElementChild;
        if (newSvg) existingSvg.replaceWith(newSvg);
      } else {
        // Inline-icon variant: <span class="mp-act-ico"><svg/></span>
        // <span class="mp-act-lbl">label</span>. Replace only the SVG
        // inside the ico span and update the lbl text — otherwise the
        // whole button would lose its label on toggle.
        const ico = b.querySelector('.mp-act-ico');
        const lbl = b.querySelector('.mp-act-lbl');
        if (ico) ico.innerHTML = svg;
        if (lbl) lbl.textContent = on ? 'Auto-next: on' : 'Auto-next: off';
        if (!ico && !lbl) b.innerHTML = svg;
      }
    });
  }
  function toggleAutoNext(btn) {
    const next = !_autoNextEnabled();
    try { localStorage.setItem(_AUTONEXT_LS_KEY, next ? '1' : '0'); } catch {}
    _syncAutoNextButtons();
    try { UI.showToast && UI.showToast('Auto-next ' + (next ? 'on' : 'off'), 'info', 1500); } catch {}
    // If we just turned auto-next OFF while the big-player was sitting
    // on the "🎵 Advancing to the next track…" grace placeholder (set
    // by _render() when the head track ended and auto-advance fired
    // skip server-side), clear that state and re-render immediately so
    // the user sees the proper empty queue UI with Add Track + controls
    // instead of a stuck "Advancing…" message.
    try {
      const panel = $('music-panel');
      if (panel && panel.dataset.emptySince) {
        delete panel.dataset.emptySince;
      }
      _render();
    } catch {}
  }

  // Single source of truth for "is the player effectively paused right
  // now?". Combines user intent (_paused) with YouTube's reported state
  // (_lastPlayerState) so a YT auto-pause in background or after the
  // app returns is reflected without us having to call _emitState first.
  function _currentEffectivePaused() {
    try {
      const cur = _state && _state.queue && _state.queue[0];
      const isYouTube = !!(cur && cur.provider === 'youtube');
      // YT ground-truth wins when it's known. If the iframe explicitly
      // says state=1 (playing), the player is playing — full stop —
      // even if our local `_paused` flag drifted true (e.g. a stale
      // pre-toggle event slipped past the guard, or _onAppHidden
      // optimistically set it). Without this, the dock button can get
      // stuck on ▶ while audio is happily playing, and the user has
      // to click pause-then-play to unstick it. The recovery tick in
      // _startUiSync also reconciles `_paused` to truth in the
      // background, but this guards the UI immediately.
      const ytKnowsPlaying = isYouTube && _lastPlayerState === 1;
      if (ytKnowsPlaying) return false;
      // Only YT state 2 = "paused" actually means paused. -1 (unstarted),
      // 0 (ended), 3 (buffering), 5 (cued) are transient states during a
      // tab swap, iframe remount or auto-advance where the user clearly
      // intends to be playing — treating them as paused makes the dock
      // button (and the FrogSocial top strip) flash to ▶ every time the
      // user navigates between channels even though audio is still
      // flowing. Trust _paused (user intent) and only override when YT
      // explicitly says "I am paused".
      const ytKnowsPaused = isYouTube && _lastPlayerState === 2;
      return _paused || ytKnowsPaused;
    } catch { return _paused; }
  }

  // After a surface switch (big↔mini), the YT iframe may already be
  // playing/paused but our cached _lastPlayerState can be stale. Poke
  // the iframe so it answers with a fresh onStateChange/infoDelivery,
  // then re-paint every play/pause button on a short ladder so the
  // dock + mini bar + FrogSocial top strip all converge to truth
  // within ~1s instead of waiting for the next 1.5s UI sync tick.
  function _probeIframeStateSoon() {
    try {
      const frame = document.querySelector('#mp-player-wrap iframe.mp-frame');
      const cur = _state && _state.queue && _state.queue[0];
      if (frame && frame.contentWindow && cur && cur.provider === 'youtube') {
        try {
          frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'frogtalk-music' }), '*');
          frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'getPlayerState', args: [] }), '*');
        } catch {}
      }
    } catch {}
    // Belt + braces re-paint ladder. Each tick re-derives from
    // _currentEffectivePaused() so any state event landing in between
    // is reflected immediately on every visible surface.
    [60, 250, 700, 1500].forEach(ms => {
      setTimeout(() => {
        try { _syncPlayPauseButtons(); } catch {}
        try { _broadcastIfChanged(); } catch {}
      }, ms);
    });
  }

  // Sync the on-screen play/pause buttons (drawer + mini player) to the
  // given playing flag. Used by togglePauseGlobal AND by _emitState so a
  // state flip from any source (Android tray, visibility change, YT
  // auto-pause) reaches the in-app UI without a re-render. When called
  // with no argument, derives from _currentEffectivePaused() so every
  // render hook can just call _syncPlayPauseButtons() and trust the
  // helper to consult the single source of truth.
  function _syncPlayPauseButtons(playing) {
    try {
      if (typeof playing !== 'boolean') {
        playing = !_currentEffectivePaused();
      }
      document.querySelectorAll('.mmd-play, .mp-mini-playpause').forEach(el => {
        if (!el || el.classList.contains('unsupported')) return;
        el.dataset.playing = playing ? '1' : '0';
        el.innerHTML = playing ? _PAUSE_SVG : _PLAY_SVG;
        el.title = playing ? 'Pause' : 'Play';
        el.setAttribute('aria-label', el.title);
      });
      // Also drive the FrogSocial persistent now-playing strip — it lives
      // in social.js and only rebuilds on music:statechange events, so
      // anything that nudges _paused in between (tab switches, YT
      // auto-pause reconciled before the next emit) used to leave the
      // strip's icon stale until something else re-emitted.
      document.querySelectorAll('.mtnp-pp').forEach(el => {
        el.dataset.playing = playing ? '1' : '0';
        el.textContent = playing ? '⏸' : '▶';
        el.title = playing ? 'Pause' : 'Resume';
        el.setAttribute('aria-label', el.title);
      });
      document.querySelectorAll('.mtnp-dot').forEach(el => {
        el.classList.toggle('paused', !playing);
      });
      // mtnp-state structure: text node + <span.mtnp-prov> + optional sharer.
      // Replace only the leading text node so we don't blow away children.
      document.querySelectorAll('.mtnp-state').forEach(el => {
        const stateText = playing ? 'Playing now' : 'Paused';
        if (el.firstChild && el.firstChild.nodeType === 3) {
          el.firstChild.nodeValue = stateText;
        }
      });
    } catch { /* DOM may not be ready */ }
  }

  // Broadcasts a lightweight snapshot of the current player state so other
  // modules (FrogSocial music cards, wall posts, etc.) can update their UI
  // in sync with play/pause/track-change.
  function _emitState() {
    let detail;
    try {
      const cur = _state && _state.queue && _state.queue[0];
      const rawArt = cur ? (cur.thumbnail || cur.artwork || '') : '';
      const artworkUrl = _safeArtwork(rawArt);
      // Real-playback flag. _paused is user intent; _lastPlayerState is
      // ground truth from the YT iframe. Only YT state 2 ("paused")
      // actually means paused — 0 (ended), -1 (unstarted), 3 (buffering),
      // 5 (cued) are transient and were misreporting "Paused" on the
      // FrogSocial top strip during track changes / auto-advance.
      const isYouTube = !!(cur && cur.provider === 'youtube');
      const ytKnowsPaused = isYouTube && _lastPlayerState === 2;
      const effectivePaused = _paused || ytKnowsPaused;
      // Reflect the truth in the in-app buttons too — a YT auto-pause or a
      // background-forced pause needs to flip the side UI play/pause icon
      // immediately, not just the system tray.
      try { _syncPlayPauseButtons(!!cur && !effectivePaused); } catch {}
      detail = {
        active: !!cur,
        soloMode: _soloMode,
        room: _room || '',
        paused: effectivePaused,
        muted: _muted,
        provider: cur ? (cur.provider || '') : '',
        url: cur ? (cur.url || '') : '',
        video_id: cur ? (cur.video_id || '') : '',
        title: cur ? (cur.title || '') : '',
        sharer: cur ? (cur.sharer || '') : '',
        artworkUrl,
      };
      document.dispatchEvent(new CustomEvent('music:statechange', { detail }));
      _lastBroadcastPaused = effectivePaused;
    } catch { return; }

    // Dedupe: only push to mediaSession + Android when the user-visible
    // tuple actually changes. Stops `_render` ticks from churning.
    const hash = JSON.stringify([
      detail.active, detail.paused, detail.muted,
      detail.title, detail.sharer, detail.room, detail.soloMode,
      detail.provider, detail.artworkUrl
    ]);
    if (hash === _lastEmitHash) return;
    _lastEmitHash = hash;

    // Trailing-edge debounce — coalesce bursts inside ~200ms.
    if (_emitTimer) clearTimeout(_emitTimer);
    _emitTimer = setTimeout(() => {
      _emitTimer = null;
      _pushMediaSession(detail);
      _pushAndroidBridge(detail);
    }, 200);
  }

  // ── Web Media Session API integration ────────────────────────────────
  // Universal: powers desktop hardware-key control, Win11/macOS volume
  // flyout, and the Android system tray when the iframe ever surfaces it.
  // Only registers action handlers once; updating metadata/playbackState
  // is cheap on every state change.
  function _bindMediaSessionHandlers() {
    if (_msHandlersBound) return;
    if (!('mediaSession' in navigator)) return;
    _msHandlersBound = true;
    const set = (action, fn) => {
      try { navigator.mediaSession.setActionHandler(action, fn); }
      catch { /* unsupported action — ignore */ }
    };
    set('play',          () => { if (_paused) togglePauseGlobal(); });
    set('pause',         () => { if (!_paused) togglePauseGlobal(); });
    set('stop',          () => { try { Music.close(); } catch {} });
    set('nexttrack',     () => {
      if (_state && _state.can_control) { try { Music.skip(); } catch {} }
    });
    set('previoustrack', () => { try { Music.resyncNow(); } catch {} });
  }

  function _pushMediaSession(detail) {
    if (!('mediaSession' in navigator)) return;
    try {
      _bindMediaSessionHandlers();
      if (!detail.active) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
        return;
      }
      const title = _sanitizeText(detail.title, 200) || 'FrogTalk Music';
      const artist = detail.soloMode
        ? (detail.sharer ? `@${_sanitizeText(detail.sharer, 100)}` : 'FrogSocial')
        : `#${_sanitizeText(detail.room, 100) || 'music'}`;
      const fallbackArt = '/static/icons/icon-512.png';
      const art = detail.artworkUrl || fallbackArt;
      const artwork = [
        { src: art,           sizes: '512x512', type: 'image/png' },
        { src: fallbackArt,   sizes: '192x192', type: 'image/png' },
        { src: fallbackArt,   sizes: '96x96',   type: 'image/png' },
      ];
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist,
        album: 'FrogTalk',
        artwork,
      });
      navigator.mediaSession.playbackState = _paused ? 'paused' : 'playing';
    } catch { /* MediaSession is best-effort */ }
  }

  function _pushAndroidBridge(detail) {
    try {
      const A = window.Android;
      if (!A) return;
      const active = !!detail.active;
      const title = _sanitizeText(detail.title, 200) || 'FrogTalk Music';
      const subtitle = _sanitizeText(
        active
          ? (detail.soloMode
              ? `FrogSocial${detail.sharer ? ` · @${detail.sharer}` : ''}`
              : `#${detail.room || 'music'}`)
          : 'Playback stopped',
        200
      );
      // Prefer the V2 bridge when present (artwork + provider). Old APKs
      // fall through to the legacy 5-arg signature.
      if (typeof A.updateMusicPlaybackV2 === 'function') {
        A.updateMusicPlaybackV2(
          title, subtitle,
          detail.artworkUrl || '',
          detail.provider || '',
          active, !detail.paused, _muted
        );
      } else if (typeof A.updateMusicPlayback === 'function') {
        A.updateMusicPlayback(title, subtitle, active, !detail.paused, _muted);
      }
    } catch { /* native bridge failures are non-fatal */ }
  }

  // Public snapshot for other modules.
  function getCurrent() {
    const cur = _state && _state.queue && _state.queue[0];
    if (!cur) return { active: false };
    // Use _currentEffectivePaused() so callers (FrogSocial top strip, mini
    // dock re-renders, friends-list status text, etc.) see the real audio
    // truth — if YT auto-paused in the background while the user was on
    // another channel, _paused alone would still report "playing" and
    // every UI consuming this snapshot would draw the wrong icon.
    return {
      active: true,
      soloMode: _soloMode,
      room: _room || '',
      paused: _currentEffectivePaused(),
      provider: cur.provider,
      url: cur.url || '',
      video_id: cur.video_id || '',
      title: cur.title || '',
      sharer: cur.sharer || '',
    };
  }

  // Toggle pause on the shared iframe without needing a reference to a button.
  // Locates any existing play/pause button in the DOM and drives togglePause
  // through it so sibling buttons all stay in sync.
  function togglePauseGlobal() {
    const btn = document.querySelector('.mmd-play, .mp-mini-playpause');
    if (btn) { togglePause(btn); return true; }
    return false;
  }

  // Notification-tray play action for YouTube. The Android side already
  // brought the Activity to the foreground (so the WebView is on-screen
  // and Chromium will honor playVideo). We DO NOT optimistically flip
  // _paused here — the icon would flip to ⏸ before audio actually
  // started, and if YT refuses we'd be lying to the user. Instead we
  // kick the bounded retry ladder with ignorePaused; the verify loop
  // sets _paused=false ONLY when YT confirms state=1 (playing), and
  // back to _paused=true if all attempts fail. The notification icon
  // tracks reality the whole way. No DOM button click is involved, so
  // there is zero risk of churning _room/_state and pushing
  // active=false to the foreground service — the notification stays up.
  function resumeFromNotification() {
    const cur = _state && _state.queue && _state.queue[0];
    if (!cur) return false;
    // User-intent guard: tray Play is a real user click; suppress any
    // stale playerState=2 events from before the resume ladder lands.
    _userIntentPaused = false;
    _userIntentAt = Date.now();
    // Bring the user back to the music source (channel or FrogSocial
    // music tab) so they actually see the player they tapped on.
    try { expand(); } catch {}
    try { _resumeOnVisible({ force: true, ignorePaused: true }); } catch {}
    return true;
  }

  function setNativeMuted(muted) {
    _muted = !!muted;
    _emitState();
    return _muted;
  }

  // Sanity ceiling for any single track's elapsed position. Protects
  // every anchor path from a runaway server reading (process kept the
  // _music_head_started anchor while everyone was offline, no one DJ'd
  // a skip → position_sec grows forever, badge displays "19669s out of
  // sync" forever and Resync is a no-op because we keep re-accepting
  // the same bogus value). 4h covers every realistic music track and
  // long DJ set we host without clipping legitimate playback.
  const _MAX_TRACK_POS_SEC = 4 * 3600;

  function _setAnchor(track, serverPosSec) {
    if (!track) { _anchorMs = 0; _anchorTrackKey = ''; _userPaused = false; _currentDurationSec = 0; return; }
    const key = `${track.provider}:${track.video_id}`;
    let incoming = Math.max(0, parseInt(serverPosSec || 0, 10) || 0);
    // Clamp obviously-impossible server readings (see _MAX_TRACK_POS_SEC).
    // If the server kept advancing the anchor for a track that ended
    // hours ago, treat it as "start of track" rather than seeding a
    // 5-hours-ago anchor that makes Resync useless.
    if (incoming > _MAX_TRACK_POS_SEC) incoming = 0;
    // Also clamp against the known track duration if available.
    if (_currentDurationSec > 0 && incoming > _currentDurationSec + 5) incoming = 0;
    // Track change clears the sticky user-pause flag — pausing song A and
    // then having the queue advance to song B should default to "playing".
    // Also clear _lastPlayerState so the duration-overshoot fallback waits
    // until the freshly-mounted iframe actually reports state=1 — without
    // this, a stale "1" from the previous track makes the next iframe
    // auto-skip before it even gets a chance to start.
    if (key !== _anchorTrackKey) { _userPaused = false; _currentDurationSec = 0; _lastPlayerState = null; }

    // Defensive: protect a healthy local clock from a stale/just-stamped
    // server reading. The server's _music_head_started is in-memory, and
    // any miss (process restart, track changed in DB without going through
    // skip/delete, race with a clear) makes /queue return position_sec=0
    // and re-stamp with `now`. If we blindly accept that, the iframe gets
    // seeked back to the start of the track every time a WS event fires
    // or the user clicks Resync.
    //
    // Heuristic: if we already have an anchor for THIS same track, only
    // accept the incoming value when it's plausible. "Plausible" means
    // either close to our local clock (<5s drift, normal jitter) or it
    // moved forward (someone seeked the room ahead). A backwards jump of
    // more than a few seconds on the same head track is almost always a
    // server-side anchor reset, not a real seek-backwards.
    if (key === _anchorTrackKey && _anchorMs) {
      const localElapsed = Math.max(0, Math.floor((Date.now() - _anchorMs) / 1000));
      // Server lost its anchor and is reporting ~0 — ALWAYS reject for
      // an already-anchored track, regardless of how recent ours is.
      // (The previous threshold of localElapsed>5 created a 5-second
      // window where a stale server zero would obliterate a fresh
      // anchor and yank playback to the start of the track.)
      if (incoming < 3) return;
      // Server reading is behind ours by more than 10s on the same track.
      // Trust the local clock; the server just (re)stamped.
      if (localElapsed - incoming > 10) return;
      // Within tolerance — leave the existing anchor alone to avoid
      // imperceptible jitter on every refetch.
      if (Math.abs(localElapsed - incoming) < 3) return;
    }

    // Cross-track edge case: server reports incoming=0 for a track we
    // haven't anchored yet (different head, or first observation after
    // a restart). The iframe — if one exists for this same track —
    // probably has the real position. Seed a *tentative* anchor from
    // server now; the next sync probe will replace it with iframe truth
    // via the asymmetric reconciliation in _bindSyncMessageListener.
    _anchorTrackKey = key;
    _anchorMs = Date.now() - (incoming * 1000);
  }

  // Send a seek command to the current iframe. Works for YouTube + SoundCloud
  // (via their postMessage protocols). Spotify has no seek in the public
  // embed API, so it falls back to restarting the track at the given offset
  // via URL reload when the drift is severe (handled in _resync).
  function _seekIframe(posSec) {
    const frame = document.querySelector('#mp-player-wrap iframe.mp-frame');
    if (!frame || !frame.contentWindow) return false;
    const src = frame.src || '';
    try {
      if (src.includes('youtube.com')) {
        frame.contentWindow.postMessage(
          JSON.stringify({ event: 'command', func: 'seekTo', args: [posSec, true] }),
          '*'
        );
        return true;
      }
      if (src.includes('soundcloud.com')) {
        frame.contentWindow.postMessage(
          JSON.stringify({ method: 'seekTo', value: posSec * 1000 }),
          '*'
        );
        return true;
      }
    } catch {}
    return false;
  }

  // Re-align the local iframe to the "radio" position. Called on:
  //   - user resume-from-pause
  //   - user clicks the Resync button
  //   - mini-dock expand back to the channel
  function _resync(force) {
    if (!_anchorMs) return;
    const pos = _expectedPosSec();
    // Runaway anchor (e.g. server kept advancing position_sec for hours
    // while nobody was in the room). Reset the anchor to "now" so the
    // badge stops showing nonsense and the next state push from the
    // server can re-seed properly. Also kick auto-advance in case the
    // track really did end.
    if (pos > _MAX_TRACK_POS_SEC) {
      _anchorMs = Date.now();
      _lastDriftSec = 0;
      _renderSyncBadge();
      try { _maybeAutoAdvanceOnEnded(); } catch {}
      return;
    }
    // Past end of track? Don't seek to a phantom position — fire
    // auto-advance and let the queue progress instead. This was the
    // 'Resync just sets you to end of video' bug: server's position_sec
    // kept growing when nobody DJ'd a skip, so Resync sent seekTo(huge)
    // and YT clamped to the final frame.
    if (_currentDurationSec > 0 && pos >= _currentDurationSec - 2) {
      try { _maybeAutoAdvanceOnEnded(); } catch {}
      return;
    }
    // Clamp seek to a safe offset before the end so a near-end Resync
    // doesn't accidentally trigger YT's own end-of-video screen.
    const safePos = (_currentDurationSec > 0)
      ? Math.min(pos, Math.max(0, _currentDurationSec - 3))
      : pos;
    const ok = _seekIframe(safePos);
    if (!ok && force) {
      // Provider without seek support (Spotify) — hard reload the iframe at
      // the current expected offset. Disruptive, so only on explicit user
      // request (force=true).
      const cur = (_state && _state.queue && _state.queue[0]) || null;
      if (!cur) return;
      const wrap = document.getElementById('mp-player-wrap');
      if (!wrap) return;
      if (cur.provider === 'spotify') {
        wrap.innerHTML = `<iframe class="mp-frame" src="https://open.spotify.com/embed/${esc(cur.video_id)}?t=${safePos}" allow="autoplay; clipboard-write; encrypted-media" allowfullscreen></iframe>`;
      }
    }
  }

  // ── Live radio-sync probe ────────────────────────────────────────────
  // Polls the active iframe's actual play head and compares against the
  // server-anchored expected position. Pure postMessage + setInterval —
  // no network, no DB, no WS. Halted entirely when paused, hidden, or no
  // track. Updates only the badge node in place (no full re-render).
  function _bindSyncMessageListener() {
    if (_syncMsgListenerBound) return;
    _syncMsgListenerBound = true;
    window.addEventListener('message', (ev) => {
      try {
        const data = ev.data;
        if (!data) return;
        let parsed = null;
        if (typeof data === 'string' && data.length < 4096
            && (data.charCodeAt(0) === 123 /* { */ || data.charCodeAt(0) === 34 /* " */)) {
          try { parsed = JSON.parse(data); } catch { /* not JSON */ }
        } else if (typeof data === 'object') {
          parsed = data;
        }
        if (!parsed) return;

        // YouTube fires onStateChange unsolicited. Capture state regardless
        // of whether we're awaiting a probe. We DO NOT try to auto-resume
        // on a background-induced pause anymore — YouTube's iframe in
        // Android WebView has proven too unreliable about accepting a
        // playVideo from background return, often playing for a beat
        // then re-pausing. Instead we just reflect the truth: flip the
        // tray icon, the side UI button, and the badge to paused so the
        // user can tap play once and have it work the first time.
        if (parsed.event === 'onStateChange' && typeof parsed.info === 'number') {
          const prev = _lastPlayerState;
          _lastPlayerState = parsed.info;
          if (parsed.info === 0) {
            try { _maybeAutoAdvanceOnEnded(); } catch {}
          }
          const wasPlaying = (prev === 1);
          const nowPlaying = (parsed.info === 1);
          // Reconcile _paused to YT ground truth on every state change.
          // YT autonomously fires onStateChange when it pauses (state 2)
          // or resumes (state 1) itself — e.g. user taps the iframe's
          // own play button, the embed self-resumes after a buffer, or
          // the resume ladder lands. Without this, _paused gets stuck
          // at whatever _onAppHidden / togglePause set it to.
          // Suppress contradictory reconciliations during the brief
          // window after a user toggle — stale events from before the
          // postMessage(pause/play) was honoured by the embed routinely
          // arrived here and undid the flip, leaving the button icon
          // out of sync with the actual audio.
          const guardActive = _userIntentActive();
          if (nowPlaying && _paused) {
            if (!(guardActive && _userIntentPaused === true)) {
              _paused = false;
              try { _syncPlayPauseButtons(); } catch {}
            }
          } else if (parsed.info === 2 && !_paused) {
            // YT paused itself (background, user-clicked iframe, etc.).
            // Mirror to _paused so the dock + tray + badge are honest.
            if (!(guardActive && _userIntentPaused === false)) {
              _paused = true;
              try { _syncPlayPauseButtons(); } catch {}
            }
          }
          if (wasPlaying !== nowPlaying) {
            // Force the next _emitState() through the dedupe so the
            // notification + side button update right now.
            _lastEmitHash = '';
            try { _emitState(); } catch {}
            try { _renderSyncBadge(); } catch {}
          }
        }

        // YouTube also fires infoDelivery with a playerState field on
        // virtually every state transition (often more reliably than
        // onStateChange after an Android WebView background return).
        // Reconcile _paused from that BEFORE the _syncProbePending gate
        // so the dock + sidebar button track audio truth even when no
        // sync probe is currently in flight.
        if (parsed.event === 'infoDelivery'
            && parsed.info
            && typeof parsed.info.playerState === 'number') {
          const ps = parsed.info.playerState;
          _lastPlayerState = ps;
          // Capture duration whenever YT volunteers it. Different YT
          // builds send it on different infoDelivery messages; keep
          // the latest non-zero reading.
          if (typeof parsed.info.duration === 'number'
              && parsed.info.duration > 0
              && Math.abs(parsed.info.duration - _currentDurationSec) > 0.5) {
            _currentDurationSec = parsed.info.duration;
          }
          const guardActiveInfo = _userIntentActive();
          if (ps === 1 && _paused) {
            if (!(guardActiveInfo && _userIntentPaused === true)) {
              _paused = false;
              _lastEmitHash = '';
              try { _syncPlayPauseButtons(); } catch {}
              try { _emitState(); } catch {}
              try { _startSyncProbeIfNeeded(); } catch {}
            }
          } else if (ps === 2 && !_paused) {
            if (!(guardActiveInfo && _userIntentPaused === false)) {
              _paused = true;
              _lastEmitHash = '';
              try { _syncPlayPauseButtons(); } catch {}
              try { _emitState(); } catch {}
            }
          }
        }

        // SoundCloud Widget API ground-truth reconciliation. The widget
        // emits {method:"play"|"pause"|"finish"} when subscribed (see
        // _bindSoundCloudWidget), and answers {method:"isPaused", value:
        // bool} to polled queries from the UI sync tick. Using ev.origin
        // gates this to actual SC frames so a stray YT message can't
        // collide on the same `method` keys.
        if (typeof parsed.method === 'string'
            && ev.origin
            && ev.origin.indexOf('soundcloud.com') !== -1) {
          let scPaused = null;
          if (parsed.method === 'play') scPaused = false;
          else if (parsed.method === 'pause' || parsed.method === 'finish') scPaused = true;
          else if (parsed.method === 'isPaused' && typeof parsed.value === 'boolean') scPaused = parsed.value;
          if (scPaused !== null && scPaused !== _paused) {
            // Same intent guard as YouTube — SC's widget will answer
            // an in-flight isPaused poll with the pre-toggle value
            // moments after the user clicks the dock button. Only
            // skip when the iframe is reporting the OPPOSITE of what
            // the user just asked for; matching reports always pass.
            if (!(_userIntentActive() && _userIntentPaused !== scPaused)) {
              _paused = scPaused;
              _lastEmitHash = '';
              try { _syncPlayPauseButtons(); } catch {}
              try { _emitState(); } catch {}
            }
          }
        }

        // Drift updates only happen when we asked for them, to avoid the
        // listener doing arithmetic on every spontaneous YT message.
        if (!_syncProbePending) return;

        let actualSec = null;
        let lastUpdatedAtMs = null;
        let playerState = null;
        // YouTube IFrame API: {event:"infoDelivery", info:{currentTime, currentTimeLastUpdated_, playerState}}
        if (parsed.event === 'infoDelivery'
            && parsed.info && typeof parsed.info.currentTime === 'number') {
          actualSec = parsed.info.currentTime;
          if (typeof parsed.info.currentTimeLastUpdated_ === 'number') {
            // YouTube ships this as Unix seconds (sometimes ms). Detect:
            // values > 1e12 are ms, > 1e9 are seconds.
            const v = parsed.info.currentTimeLastUpdated_;
            lastUpdatedAtMs = v > 1e12 ? v : v * 1000;
          }
          if (typeof parsed.info.playerState === 'number') {
            playerState = parsed.info.playerState;
          }
        // SoundCloud Widget API: {method:"getPosition", value:<ms>}
        } else if (parsed.method === 'getPosition'
                   && typeof parsed.value === 'number') {
          actualSec = parsed.value / 1000;
        }
        if (actualSec == null) return;
        _syncProbePending = false;
        if (playerState != null) _lastPlayerState = playerState;
        // If we have a timestamp for when the player generated this reading,
        // compare against the *expected position at that moment* — not
        // expected-now — so message latency doesn't get billed as drift.
        const expectedAtSample = lastUpdatedAtMs
          ? Math.max(0, (lastUpdatedAtMs - _anchorMs) / 1000)
          : _expectedPosSec();
        _lastDriftSec = Math.abs(actualSec - expectedAtSample);
        _renderSyncBadge();

        // Asymmetric reconciliation. Two distinct failure modes coexist:
        //
        //   A) Iframe restarted at 0 after Android background while our
        //      local anchor is correct — actualSec << expectedAtSample.
        //      Recovery: seek the iframe forward to the room's expected.
        //
        //   B) Server lost its in-memory anchor and returned a fresh
        //      position_sec=0 (process restart, race), so OUR local
        //      anchor is the stale one — actualSec >> expectedAtSample,
        //      because the iframe is the only thing that kept playing
        //      across the disruption. Recovery: adopt the iframe's
        //      clock as the new anchor; do NOT seek backwards.
        //
        // Doing the wrong recovery in case B is what the user reported:
        // the sync probe was forcing the iframe back to 0 because we
        // kept reseeding the anchor with stale server zeros and then
        // seeking the iframe to that bad anchor.
        const cur2 = _state && _state.queue && _state.queue[0];
        if (cur2 && !_paused && _lastPlayerState === 1) {
          if (actualSec > expectedAtSample + 10) {
            // Iframe is ahead — anchor is stale, trust the iframe.
            _anchorMs = Date.now() - (Math.floor(actualSec) * 1000);
            _anchorTrackKey = `${cur2.provider}:${cur2.video_id}`;
            _lastDriftSec = 0;
            _restartAtZeroHits = 0;
            _renderSyncBadge();
          } else if (actualSec < 1.0 && expectedAtSample >= 20) {
            // Strong evidence the iframe restarted at 0 (Android long
            // background). Require TWO consecutive probes to confirm
            // — single hits trigger spuriously during track-change
            // buffering or seek-pause races.
            _restartAtZeroHits += 1;
            if (_restartAtZeroHits >= 2
                && (Date.now() - _lastAutoCorrectAt) > 6000) {
              _lastAutoCorrectAt = Date.now();
              _restartAtZeroHits = 0;
              try { _seekIframe(_expectedPosSec()); } catch {}
            }
          } else {
            _restartAtZeroHits = 0;
          }
        }
      } catch { /* keep listener resilient */ }
    });
  }

  function _renderSyncBadge() {
    const node = document.getElementById('mp-sync-status');
    if (!node) return;
    let state, label, title;
    if (_lastSyncProvider === 'spotify') {
      state = 'unknown';
      label = '📻 Radio-synced';
      title = 'Spotify embed does not expose a play head — best-effort sync';
    } else if (_lastPlayerState === 2) {
      state = 'warn';
      label = '⏸ Paused locally';
      title = "Your iframe is paused while the room keeps going — click Resync to catch up";
    } else if (_lastPlayerState === 3) {
      state = 'checking';
      label = '⏳ Buffering…';
      title = 'Player is buffering';
    } else if (_lastDriftSec == null) {
      state = 'checking';
      label = '📻 Checking…';
      title = "Checking your sync to the room's play head";
    } else if (_lastDriftSec <= SYNC_TOLERANCE_OK) {
      state = 'ok';
      label = `📻 In sync · ${_lastDriftSec.toFixed(1)}s`;
      title = `Aligned to the room's play head (drift ${_lastDriftSec.toFixed(2)}s)`;
    } else if (_lastDriftSec <= SYNC_TOLERANCE_WARN) {
      state = 'warn';
      label = `⚠ Drifting · ${_lastDriftSec.toFixed(1)}s`;
      title = `You're ${_lastDriftSec.toFixed(2)}s off the room — click Resync`;
    } else if (_lastDriftSec > 600) {
      // Drift of >10 minutes is never a real listen-in-progress drift —
      // it always means the server's anchor for this track is stale
      // (track ended hours ago, nobody DJ'd a skip). Show an honest
      // "stalled" badge instead of a meaningless 19000s number, and
      // schedule a one-shot anchor reset so the next click of Resync
      // can succeed.
      state = 'bad';
      label = '❗ Room stream stalled — Resync';
      title = "This room's play head looks stuck. Click Resync to refresh, or pick another channel.";
    } else {
      state = 'bad';
      label = `❗ Out of sync · ${_lastDriftSec.toFixed(0)}s`;
      title = `You're ${_lastDriftSec.toFixed(0)}s off the room — click Resync`;
    }
    if (node.dataset.state !== state) node.dataset.state = state;
    const text = node.querySelector('.mp-sync-text');
    if (text && text.textContent !== label) text.textContent = label;
    if (node.title !== title) node.title = title;
  }

  // Schedule a few rapid one-shot probes after a manual action (resync / track
  // change) so the badge updates within ~1s instead of waiting for the next
  // periodic tick. Each delay is short and self-contained — no overlap with
  // the steady probe and capped at three pending timers.
  function _scheduleFastProbes(delays) {
    // Clear any prior fast timers — we never want them to stack.
    for (const t of _syncFastProbeTimers) { try { clearTimeout(t); } catch {} }
    _syncFastProbeTimers = [];
    for (const d of delays) {
      const t = setTimeout(() => {
        if (!_syncProbeTimer) return;  // probe was stopped meanwhile
        if (document.hidden || _paused) return;
        _runSyncProbe();
      }, d);
      _syncFastProbeTimers.push(t);
    }
  }

  function _stopSyncProbe() {
    if (_syncProbeTimer) { clearInterval(_syncProbeTimer); _syncProbeTimer = null; }
    for (const t of _syncFastProbeTimers) { try { clearTimeout(t); } catch {} }
    _syncFastProbeTimers = [];
    _syncProbePending = false;
    _lastDriftSec = null;
    _lastPlayerState = null;
  }

  function _startSyncProbeIfNeeded() {
    const cur = _state && _state.queue && _state.queue[0];
    if (!cur || _paused || !_anchorMs) { _stopSyncProbe(); return; }
    _lastSyncProvider = cur.provider || '';
    _bindSyncMessageListener();
    if (_syncProbeTimer) return;  // already running
    _syncProbeStartedAt = Date.now();
    // Skip the synchronous first probe — the iframe's API often hasn't
    // hooked up yet on a fresh embed. Schedule a quick warm-up probe at
    // ~700ms then steady-state every 4s.
    _scheduleFastProbes([700, 1800]);
    _syncProbeTimer = setInterval(_runSyncProbe, SYNC_PROBE_INTERVAL_MS);
  }

  function _runSyncProbe() {
    try {
      if (document.hidden) return;       // tab hidden — pay nothing
      if (_paused) { _stopSyncProbe(); return; }
      const cur = _state && _state.queue && _state.queue[0];
      if (!cur) { _stopSyncProbe(); return; }

      // Duration-overshoot fallback for auto-next. The YT iframe is
      // supposed to fire onStateChange=0 (ended) when a track finishes,
      // but on mobile and after lock-screen wake it sometimes never
      // delivers that message — the track just stops, or YT autoplays
      // the same track over from the beginning. Without this, the user
      // sits on a dead mini-player despite auto-next being on. So once
      // our local anchor says we're meaningfully past the known
      // duration, force the auto-advance path. Dedupe inside
      // _maybeAutoAdvanceOnEnded prevents this from double-firing.
      //
      // BUT only when YT has confirmed the iframe is actually playing
      // (state=1). On mobile, autoplay is blocked for fresh iframes
      // until the user taps play. While the user is still tapping, our
      // local _anchorMs keeps ticking and would race past the known
      // duration even though no audio ever played — yanking the queue
      // forward and skipping every track autonomously. The ended-event
      // dedupe doesn't save us because the *id* changes each skip, so
      // the loop runs unbounded. Gate on _lastPlayerState===1 so the
      // overshoot fallback only kicks in for tracks that actually
      // started playing at some point.
      if (_currentDurationSec > 0 && _anchorMs > 0 && _lastPlayerState === 1) {
        const expected = _expectedPosSec();
        if (expected >= _currentDurationSec + 2) {
          try { _maybeAutoAdvanceOnEnded(); } catch {}
          return;
        }
      }

      const frame = document.querySelector('#mp-player-wrap iframe.mp-frame');
      if (!frame || !frame.contentWindow) return;

      if (cur.provider === 'spotify') {
        _lastSyncProvider = 'spotify';
        _renderSyncBadge();
        return;
      }

      _syncProbeFiredAt = Date.now();
      _syncProbePending = true;
      setTimeout(() => {
        if (_syncProbePending
            && (Date.now() - _syncProbeFiredAt) >= SYNC_PROBE_TIMEOUT_MS) {
          _syncProbePending = false;  // leave last known drift in place
        }
      }, SYNC_PROBE_TIMEOUT_MS + 50);

      if (cur.provider === 'youtube') {
        try {
          // 'listening' handshake registers us with the YouTube embed so
          // it accepts our 'command' messages. Idempotent.
          frame.contentWindow.postMessage(
            JSON.stringify({ event: 'listening', id: 'frogtalk-music' }), '*');
          frame.contentWindow.postMessage(
            JSON.stringify({ event: 'command', func: 'getCurrentTime', args: [] }), '*');
        } catch { _syncProbePending = false; }
      } else if (cur.provider === 'soundcloud') {
        try {
          frame.contentWindow.postMessage(
            JSON.stringify({ method: 'getPosition' }), '*');
        } catch { _syncProbePending = false; }
      } else {
        _syncProbePending = false;
      }
    } catch { _syncProbePending = false; }
  }

  // Resume the iframe if it got auto-paused while the tab was hidden. Mobile
  // browsers + YouTube's autoplay policy will silently pause an embed when
  // the page is backgrounded, so by the time the user returns the UI says
  // "playing" but no audio is coming out. Send play+seek to recover.
  //
  // Real-world quirks this guards against:
  // - YouTube returning state=2 (paused) or even state=-1/3 (unstarted/buffering)
  //   right after foreground. A single playVideo can be ignored if the
  //   embed is mid-transition; we verify and retry up to 3 times.
  // - The seek-then-pause race: sending seekTo while the player is still
  //   in paused state can briefly play then re-pause. So we play FIRST,
  //   then seek only if the room has drifted meaningfully (>3s) to avoid
  //   that race for the common small-drift case.
  // - Multiple foreground events firing in <1.5s — debounced.
  let _lastResumeAt = 0;
  let _resumeRetryToken = 0;
  let _lastAutoCorrectAt = 0;
  // Android-restart-at-0 detection. We only seek the iframe forward
  // automatically when we have HIGH confidence it actually restarted at
  // zero \u2014 require two consecutive probes reading currentTime\u22480 while
  // our anchor says >=20s have elapsed. One reading is not enough; YT's
  // currentTime can briefly read 0 during track-change buffering.
  let _restartAtZeroHits = 0;
  function _resumeOnVisible(opts) {
    try {
      const force = !!(opts && opts.force);
      const ignorePaused = !!(opts && opts.ignorePaused);
      const now = Date.now();
      // Debounce duplicate triggers (visibilitychange + focus + pageshow
      // can all fire within ~50ms). `force` is used by the Android
      // bridge's onResume hook so a native-side trigger can bypass.
      if (!force && now - _lastResumeAt < 1500) return;
      _lastResumeAt = now;
      // ignorePaused: notification-tray play + foreground bring-up. We
      // want to ATTEMPT a resume even though _paused=true was asserted
      // by _onAppHidden — the verify loop will reconcile _paused to YT
      // truth on confirmation or surrender.
      if (_paused && !ignorePaused) return;
      const cur = _state && _state.queue && _state.queue[0];
      if (!cur) return;
      if (cur.provider === 'spotify') return;       // no postMessage play API

      const frame = document.querySelector('#mp-player-wrap iframe.mp-frame');
      if (!frame || !frame.contentWindow) return;
      const win = frame.contentWindow;
      // Make sure we're listening for the iframe's onStateChange replies
      // even if the steady probe hasn't started yet.
      _bindSyncMessageListener();

      // Helper that survives any cross-origin oddity.
      const send = (msg) => {
        try { win.postMessage(typeof msg === 'string' ? msg : JSON.stringify(msg), '*'); }
        catch { /* nothing we can do */ }
      };

      const targetSec = _expectedPosSec();
      // Cancel any in-flight retry chain from a prior return.
      const myToken = ++_resumeRetryToken;

      if (cur.provider === 'youtube') {
        // Idempotent handshake — required for fresh embeds, no-op otherwise.
        send({ event: 'listening', id: 'frogtalk-music' });
        // Force a fresh state read by clearing cache; verifier waits for it.
        _lastPlayerState = null;
        // Play first. Seeking before play lands can trigger a paused-seek
        // that re-pauses immediately on some YT iframe builds.
        send({ event: 'command', func: 'playVideo', args: [] });
        // INTENTIONALLY no early seek. The iframe retains its playback
        // position naturally across visibility changes inside the
        // WebView; seeking to _expectedPosSec() here is a net negative
        // because (a) on a healthy resume it introduces unwanted jitter
        // and (b) on a stale anchor it actively yanks playback to the
        // start of the track. The sync probe's asymmetric reconciliation
        // will detect a genuine Android restart-at-0 (currentTime≈0
        // while expected≫0) and recover. Anything else stays put.

        // Verify-and-retry. Up to 5 play attempts on a back-off ladder.
        // Real Android WebView return-from-background can keep the YT
        // embed in state 2 (paused) or -1 (unstarted) for several
        // seconds before it accepts a play, so we spread retries across
        // ~5s instead of giving up at 2s. Re-issue the listening
        // handshake on later attempts in case the embed lost its
        // listener registration during background suspension.
        const MAX_ATTEMPTS = 5;
        const RETRY_GAP_MS = 900;
        let attempts = 1;
        const verify = () => {
          if (myToken !== _resumeRetryToken) return;   // superseded by a newer call
          if (document.hidden) return;
          // Only honor _paused as a stop signal when we did NOT enter via
          // ignorePaused. Without this exception, the notification-tray
          // resume + app-return resume bail immediately because
          // _onAppHidden left _paused=true — verify never runs, the
          // sidebar button stays on ▶ even though YT resumed audio.
          if (_paused && !ignorePaused) return;
          // Ask the embed for its current state — reply lands in our
          // global message listener and updates _lastPlayerState.
          send({ event: 'command', func: 'getPlayerState', args: [] });
          setTimeout(() => {
            if (myToken !== _resumeRetryToken) return;
            if (document.hidden) return;
            if (_paused && !ignorePaused) return;
            if (_lastPlayerState === 1) {
              // Playing — do NOT seek. The iframe's currentTime is
              // ground truth here; if it's playing, it's at a real
              // position from before background, and we trust it. If
              // Android genuinely restarted it at 0, the sync probe's
              // asymmetric reconciliation will catch and seek forward
              // (currentTime≈0 while expected≫0).
              //
              // Reconcile _paused to YT truth: audio is playing, so
              // user-intent paused must be false. Without this, the
              // notification icon stays on ▶ even though audio is
              // running (effectivePaused = _paused || ytKnowsPaused).
              if (_paused) {
                _paused = false;
                try { _syncPlayPauseButtons(); } catch {}
              }
              _lastEmitHash = '';
              try { _emitState(); } catch {}
              try { _startSyncProbeIfNeeded(); } catch {}
              return;
            }
            if (attempts++ < MAX_ATTEMPTS) {
              // Re-handshake on attempt 3+ in case the embed forgot us.
              if (attempts >= 3) {
                send({ event: 'listening', id: 'frogtalk-music' });
              }
              send({ event: 'command', func: 'playVideo', args: [] });
              // No position-nudge seek here either — we're trying to
              // wake an embed stuck in state -1/2; seeking to expected
              // can land on a stale anchor and start the track over.
              setTimeout(verify, RETRY_GAP_MS);
            } else {
              // Surrender. Reflect reality so the user can tap play
              // themselves: force _paused=true so every UI surface
              // (notification, side button, badge) shows ▶ honestly.
              if (!_paused) {
                _paused = true;
                try { _syncPlayPauseButtons(); } catch {}
              }
              _lastEmitHash = '';
              try { _emitState(); } catch {}
            }
          }, 400);
        };
        setTimeout(verify, 600);

      } else if (cur.provider === 'soundcloud') {
        send({ method: 'play' });
        // No automatic seek — SoundCloud retains its position across
        // visibility changes too; users can hit Resync to catch up.
      }

      // Reset the badge to "checking" — fast probes will repaint within ~1s.
      _lastDriftSec = null;
      _lastPlayerState = null;
      _renderSyncBadge();
      _scheduleFastProbes([800, 2200]);
    } catch { /* never throw from a visibility handler */ }
  }

  // App background / foreground policy:
  //  - On hide: stop the sync probe to save postMessage/setInterval cost,
  //    AND flip our user-intent flag to paused. Reason: YouTube's iframe
  //    pauses itself in background reliably but resists being driven back
  //    into play on return (especially in Android WebView), causing the
  //    "plays for a second then stops" bug. So we acknowledge reality and
  //    require one tap to resume; the tap path is well-tested.
  //  - On show: do NOT auto-issue play. Just probe the iframe for its
  //    current state and re-emit so every UI surface (system tray, side
  //    play button, sync badge) shows the correct play icon. The user
  //    presses play once and we know exactly which path that takes.
  // NOTE: in the Android WebView these handlers are NOT enough on their
  // own. MainActivity skips webView.onPause() while music is active so
  // the WebView keeps running; that means visibilitychange/pagehide
  // never fire. The native side calls Music.notifyAppBackground() /
  // Music.notifyAppForeground() directly to drive these paths instead.
  function _onAppHidden() {
    try { _stopSyncProbe(); } catch {}
    // Manual-resume policy: only force _paused=true inside the FrogTalk
    // Android app, where YouTube's WebView routinely refuses playVideo
    // after a background return. On desktop, alt-tabbing fires
    // visibilitychange but audio keeps playing, so we leave _paused
    // alone and let the helper consult _lastPlayerState for truth.
    if (typeof window !== 'undefined' && window.Android) {
      _paused = true;
    }
    _lastDriftSec = null;
    _lastPlayerState = null;
    try { _renderSyncBadge(); } catch {}
    try { _syncPlayPauseButtons(); } catch {}
    // Force the system tray + bridge update through dedupe.
    _lastEmitHash = '';
    try { _emitState(); } catch {}
  }
  function _onAppVisible() {
    // Re-bind listener defensively (some embeds drop registration during
    // background suspension). Then probe the iframe so _lastPlayerState
    // is fresh, and reconcile every UI surface.
    try { _bindSyncMessageListener(); } catch {}
    try {
      const frame = document.querySelector('#mp-player-wrap iframe.mp-frame');
      const cur = _state && _state.queue && _state.queue[0];
      if (frame && frame.contentWindow && cur && cur.provider === 'youtube') {
        frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'frogtalk-music' }), '*');
        frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'getPlayerState', args: [] }), '*');
      }
    } catch {}
    // Keep _paused as-is for now. The bounded retry ladder below will
    // attempt a resume regardless (ignorePaused) and reconcile _paused
    // to YT ground truth: state=1 → _paused=false; surrender → _paused=true.
    _lastEmitHash = '';
    try { _syncPlayPauseButtons(); } catch {}
    try { _emitState(); } catch {}
    // Auto-resume: kick the bounded ladder. No-op for non-YouTube
    // (SoundCloud and Spotify play from background fine). Ignored if
    // there's no current track.
    // CRITICAL: respect user-initiated pause. If the user explicitly
    // tapped the pause button before backgrounding / opening the
    // sidebar / switching channels, we MUST NOT force-resume on the
    // next visibility flicker. Just probe state and bail.
    if (_userPaused) {
      try { _syncPlayPauseButtons(); } catch {}
      return;
    }
    try { _resumeOnVisible({ force: true, ignorePaused: true }); } catch {}
    // Schedule fast drift probes after the resume ladder lands. The
    // sync probe's auto-correct branch will catch + reseek any case
    // where YT resumed the iframe at currentTime=0 despite our verify
    // ladder seeking — which happens occasionally when the seek
    // postMessage races the iframe's restoration window.
    try { _scheduleFastProbes([1500, 3000, 5000]); } catch {}
    // Belt-and-suspenders: re-sync on the next two animation frames in
    // case a queued _render() runs after us and clobbers the button
    // HTML back to the "⏸" template default.
    try {
      requestAnimationFrame(() => {
        try { _syncPlayPauseButtons(); } catch {}
        requestAnimationFrame(() => { try { _syncPlayPauseButtons(); } catch {} });
      });
    } catch {}
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) _onAppHidden();
      else _onAppVisible();
    });
    // Some mobile browsers fire pageshow (bfcache restore) without
    // visibilitychange. Cover that path too.
    window.addEventListener('pageshow', () => { if (!document.hidden) _onAppVisible(); });
    // Window focus catches desktop alt-tab back.
    window.addEventListener('focus', () => { if (!document.hidden) _onAppVisible(); });
    // Mobile UAs fire pagehide on swipe-away/lockscreen.
    window.addEventListener('pagehide', () => { _onAppHidden(); });
  }

  async function _fetchState(room) {
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(room)}/queue`, {
        headers: { 'X-Session-Token': State.token }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  function _render() {
    const panel = $('music-panel');
    if (!panel || !_room || !_state) return;
    const q = _state.queue || [];
    const cur = q[0] || null;
    const upcoming = q.slice(1);

    // Auto-advance grace window:
    //
    // When the playing track ends, _maybeAutoAdvanceOnEnded fires skip()
    // on the server. Server pops the head; if auto-fill is enabled it
    // then asks Discover for a fresh track and pushes it. Between those
    // two server-side steps the queue is briefly empty, and the WS
    // refresh that lands in that window would paint our big in-channel
    // player as "🎵 Queue is empty" — tearing down the iframe and
    // making the whole big-player UI vanish — even though the side dock
    // still shows the previous (just-ended) track and the next one is
    // about to land. Skip that empty re-render for up to 9s; the next
    // WS event with the new head will rebuild the player normally.
    const wrap0 = document.getElementById('mp-player-wrap');
    const hadTrack = !!(wrap0 && wrap0.dataset.curKey);
    // Only hold the "Advancing…" placeholder when a new track is
    // actually about to land — i.e. auto-fill is enabled for this room
    // and the local user controls it. Without auto-fill, an empty
    // queue is the final state, so showing a 9-second "Advancing…"
    // splash just hides the Add Track button (and on mobile makes the
    // panel look broken — there's nothing to advance *to*).
    const advancingPossible = _state && _state.can_control && _autoFillEnabled(_room);
    if (!cur && hadTrack && _autoNextEnabled() && advancingPossible) {
      const since = Number(panel.dataset.emptySince || 0);
      const now = Date.now();
      if (!since) {
        panel.dataset.emptySince = String(now);
        // Refresh once after the grace window so we eventually fall back
        // to the real "queue empty" UI if no track ever arrives.
        setTimeout(() => {
          try {
            const p = $('music-panel');
            if (!p) return;
            const stillEmpty = !((_state && _state.queue && _state.queue[0]));
            if (stillEmpty) {
              delete p.dataset.emptySince;
              _render();
            }
          } catch {}
        }, 9500);
        // Light meta update so the user sees something is happening
        // instead of a frozen player.
        const meta = document.getElementById('mp-meta-wrap');
        if (meta) {
          meta.innerHTML = `<div class="mp-empty" style="padding:14px">🎵 Advancing to the next track…</div>`;
        }
        return;
      }
      if (now - since < 9000) {
        return; // keep the existing iframe + meta in place
      }
      delete panel.dataset.emptySince;
    } else if (cur && panel.dataset.emptySince) {
      delete panel.dataset.emptySince;
    }

    // Radio sync: anchor this client to the server's "play head" so all
    // listeners agree on the timeline. Only reset when the head track
    // actually changes, otherwise repeated state refreshes would keep
    // pulling the user back in time.
    const curKeyForAnchor = cur ? `${cur.provider}:${cur.video_id}` : '';
    if (curKeyForAnchor !== _anchorTrackKey) {
      _setAnchor(cur, _state.position_sec);
    }
    const posSec = _expectedPosSec();
    // Honour user-pause across full re-renders too (room switch, head
    // track unchanged path is handled separately above).
    const ap = _userPaused ? '0' : '1';
    const scAuto = _userPaused ? 'false' : 'true';
    const playerHtml = cur
      ? (cur.provider === 'youtube'
          ? `<iframe class="mp-frame" src="https://www.youtube.com/embed/${esc(cur.video_id)}?autoplay=${ap}&enablejsapi=1&start=${posSec}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`
          : cur.provider === 'spotify'
            ? `<iframe class="mp-frame" src="https://open.spotify.com/embed/${esc(cur.video_id)}?t=${posSec}" allow="autoplay; clipboard-write; encrypted-media" allowfullscreen></iframe>`
            : cur.provider === 'soundcloud'
              ? `<iframe class="mp-frame" scrolling="no" frameborder="no" src="https://w.soundcloud.com/player/?url=${encodeURIComponent(cur.video_id)}&auto_play=${scAuto}&show_artwork=true&visual=false&hide_related=true&color=%234caf50"></iframe>`
              : `<div class="mp-empty">Unsupported provider</div>`
        )
      : `<div class="mp-empty">🎵 Queue is empty — paste a YouTube, Spotify, or SoundCloud link below to start the party</div>`;

    const providerIcon = cur
      ? (cur.provider === 'youtube' ? '▶' : cur.provider === 'spotify' ? '♫' : cur.provider === 'soundcloud' ? '☁' : '🎵')
      : '🎵';
    const providerLabel = cur ? (cur.provider || 'music') : 'music';
    const headerHtml = `
      <div class="mp-header">
        <div class="mp-header-left">
          <div class="mp-header-icon" data-provider="${esc(providerLabel)}">${providerIcon}</div>
          <div class="mp-header-info">
            <div class="mp-header-room">
              <span class="mp-header-room-hash">#</span>${esc(_room)}
              <span class="mp-header-badge">🎬 Media</span>
            </div>
            <div class="mp-header-sub">
              ${cur ? `<span class="mp-live-pulse"></span> Now playing · ${esc(providerLabel)}` : 'Idle · waiting for a track'}
              ${q.length ? ` · ${q.length} track${q.length === 1 ? '' : 's'} in queue` : ''}
              ${cur ? ` · <span id="mp-sync-status" class="mp-sync-hint" data-state="checking" title="Checking your sync to the room's play head…"><span class="mp-sync-dot"></span><span class="mp-sync-text">📻 Checking…</span></span>` : ''}
            </div>
          </div>
        </div>
        <div class="mp-header-actions">
          ${cur ? `<button class="mp-btn mp-resync" title="Catch up to the room: refreshes the queue from the server and seeks your iframe to the live play-head position"
                           onclick="Music.resyncNow()"><span class="mp-resync-ico">📻</span><span class="mp-resync-lbl">Resync</span></button>` : ''}
        </div>
      </div>`;

    const _curUrlEsc = cur ? esc(cur.url || '') : '';
    const _curSubmitterEsc = cur ? esc(cur.submitter_nick || '') : '';
    const nowRow = cur ? `
      <div class="mp-now">
        <a class="mp-art" href="${_curUrlEsc}" target="_blank" rel="noopener noreferrer"
           title="Open on ${esc(cur.provider || 'source')}"
           style="background-image:url('${esc(cur.thumbnail || '')}')"></a>
        <div class="mp-info">
          <a class="mp-title" href="${_curUrlEsc}" target="_blank" rel="noopener noreferrer"
             title="Open this track on ${esc(cur.provider || 'source')} ↗">${esc(cur.title || cur.url)}</a>
          <div class="mp-sub">Queued by ${cur.submitter_nick
            ? `<a class="mp-sub-nick" href="javascript:void(0)" onclick="event.stopPropagation();window.Social&&Social.openProfile&&Social.openProfile('${_curSubmitterEsc.replace(/'/g,"\\'")}')" title="View @${_curSubmitterEsc}'s profile">${_curSubmitterEsc}</a>`
            : '?'} · ${esc(cur.provider)}</div>
        </div>
        <div class="mp-ctrls">
          <button class="mp-act mp-act-share" onclick="Music.shareToWall()" title="Share this track to your FrogSocial wall">
            <span class="mp-act-ico">🐸</span><span class="mp-act-lbl">Share</span>
          </button>
          ${_state.can_control ? `<button class="mp-act mp-act-skip" onclick="Music.skip()" title="Skip to next track">
            <span class="mp-act-ico">${_SKIP_SVG}</span><span class="mp-act-lbl">Skip</span>
          </button>` : ''}
          ${_state.can_control ? `<button class="mp-act mp-act-clear" onclick="Music.clearQueue()" title="Clear the entire queue">
            <span class="mp-act-ico">🗑</span><span class="mp-act-lbl">Clear</span>
          </button>` : ''}
        </div>
      </div>` : '';

    const _afOn = _state.can_control && _autoFillEnabled(_room);
    const submitHtml = _state.can_submit ? `
      <div class="mp-submit">
        <button class="mp-btn primary mp-add-btn" onclick="Music.openAddModal()" title="Add a track to the queue">
          <span class="mp-add-lbl">Add Media</span>
        </button>
        ${_state.can_control ? `
          <label class="mp-dj-toggle" title="${_state.dj_only ? 'DJ-only mode is ON — only DJs can queue' : 'Open mode — anyone can queue'}">
            <input type="checkbox" ${_state.dj_only ? 'checked' : ''} onchange="Music.toggleDJOnly()">
            <span class="mp-dj-track"><span class="mp-dj-knob"></span></span>
            <span class="mp-dj-label">${_state.dj_only ? '🎧 DJ-only' : '👥 Open'}</span>
          </label>
          <label class="mp-dj-toggle mp-autofill-toggle" title="${_afOn ? 'Auto-fill ON — when the queue empties, Discover picks a track' : 'Auto-fill OFF — queue will stop when empty'}">
            <input type="checkbox" ${_afOn ? 'checked' : ''} onchange="Music.toggleAutoFill()">
            <span class="mp-dj-track"><span class="mp-dj-knob"></span></span>
            <span class="mp-dj-label">${_afOn ? '🪄 Auto-fill' : '🪄 Auto-fill'}</span>
          </label>` : ''}
      </div>` : `<div class="mp-empty" style="padding:8px">Only DJs may add tracks in this channel.</div>`;

    // "Up next" preview: show only the immediate next track plus a
    // pill button that opens the full playlist modal. Keeps the inline
    // panel short on mobile where vertical real-estate is precious.
    // The Playlist pill itself is always shown when something is
    // playing so non-DJs can browse the (read-only) queue without
    // hunting for a hidden button.
    const nextTrack = upcoming[0];
    const remaining = Math.max(0, upcoming.length - 1);
    const playlistPillHtml = cur ? `
      <button class="mp-playlist-btn" type="button" onclick="Music.openPlaylistModal()" title="View the full ${_state.dj_only ? 'DJ-only ' : ''}playlist">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M2 4h9v1.5H2zm0 3h9v1.5H2zm0 3h6v1.5H2zm9 .5l4 2.5-4 2.5z"/></svg>
        <span class="mp-playlist-lbl">Playlist${upcoming.length ? ` · ${upcoming.length}` : ''}</span>
      </button>` : '';
    const queueHtml = cur ? `
      <div class="mp-upnext">
        ${nextTrack ? `
        <div class="mp-upnext-row">
          <span class="mp-upnext-label">Up next</span>
          <div class="mp-upnext-art" style="background-image:url('${esc(nextTrack.thumbnail || '')}')"></div>
          <div class="mp-upnext-title" title="${esc(nextTrack.title || nextTrack.url)}">${esc(nextTrack.title || nextTrack.url)}</div>
          <span class="mp-upnext-sub">${esc(nextTrack.submitter_nick || '')}</span>
        </div>` : `
        <div class="mp-upnext-row mp-upnext-empty">
          <span class="mp-upnext-label">Up next</span>
          <span class="mp-upnext-empty-msg">Nothing queued — ${_state.can_submit ? 'add a track to keep the vibes going' : 'waiting for a DJ to add one'}</span>
        </div>`}
        ${playlistPillHtml}
      </div>` : '';

    // Only rewrite the iframe when the head track actually changes —
    // otherwise WS refreshes would re-seek the active listener back to the
    // server's cached position every time a new track is queued below.
    const curKey = cur ? `${cur.provider}:${cur.video_id}` : '';
    const wrap = document.getElementById('mp-player-wrap');
    if (wrap && wrap.dataset.curKey === curKey) {
      // Head unchanged — only refresh the meta + controls + queue sections.
      const meta = document.getElementById('mp-meta-wrap');
      if (meta) meta.innerHTML = `${headerHtml}${nowRow}${submitHtml}${queueHtml}`;
      // Re-paint badge with the cached drift (the node was just replaced).
      _renderSyncBadge();
      _startSyncProbeIfNeeded();
      if (document.getElementById('mp-playlist-modal')) _renderPlaylistModal();
      return;
    }

    // Tiny overlay button — sits in the top-right of the iframe so the
    // user can collapse the player to give the chat more room. SVG icons
    // (minimize line ↔ maximize square) flip based on _collapsed state.
    const sizeToggleHtml = cur ? `
      <button class="mp-size-toggle" type="button" onclick="Music.toggleCollapse()"
              aria-label="${_collapsed ? 'Expand player' : 'Minimize player'}"
              title="${_collapsed ? 'Expand player' : 'Minimize player to make chat bigger'}">
        ${_collapsed
          ? '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M3 8h10M8 3v10"/></svg>'
          : '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M3 8h10"/></svg>'}
      </button>` : '';

    panel.innerHTML = `
      <div id="mp-player-wrap" data-cur-key="${curKey}">${playerHtml}${sizeToggleHtml}</div>
      <div id="mp-meta-wrap">
        ${headerHtml}
        ${nowRow}
        ${submitHtml}
        ${queueHtml}
      </div>
    `;
    _emitState();
    // Track changed (or first render) — reset drift state and (re)start probe.
    _lastDriftSec = null;
    _renderSyncBadge();
    _startSyncProbeIfNeeded();
    // If the playlist modal is open, refresh it so it always reflects
    // the live queue (skips, removes, new submissions, etc.).
    if (document.getElementById('mp-playlist-modal')) _renderPlaylistModal();
  }

  async function mount(roomName, channelType) {
    const panel = $('music-panel');
    if (!panel) return;
    // Treat legacy 'voice' channels as music
    const isMusic = channelType === 'music' || channelType === 'voice';
    if (!isMusic) {
      // If we already have a live track — either a room channel or a
      // solo (FrogSocial) play — shrink into a mini persistent player
      // instead of tearing down. The user wanted music to keep playing
      // (and the dock to stay visible in the sidebar) while they browse
      // other channels / DMs / Social.
      const hasLive = (_room || _soloMode) && _state && (_state.queue || []).length;
      if (hasLive) {
        const cur = _state.queue[0];
        panel.classList.remove('active');
        panel.classList.add('mini');
        panel.style.display = 'flex';
        _renderMini(cur);
        _renderDock(cur);
        // Make sure the body flag is set so the sidebar dock CSS
        // (`body[data-music-mini="1"] #music-mini-dock{display:flex}`)
        // actually shows the dock. Without this, switching from a music
        // channel directly into a non-music room could leave the
        // attribute unset and the dock invisible despite the iframe
        // still playing in the background.
        document.body.setAttribute('data-music-mini', '1');
        document.body.setAttribute('data-music', '1');
        // Defensive: any path that pushes fresh HTML for the dock or
        // mini bar resets data-playing="1" / textContent="⏸". Re-sync
        // from effective state so the button reflects YT's actual
        // playback, not the template default.
        try { _syncPlayPauseButtons(); } catch {}
        // Surface change (big↔mini): force a state broadcast + probe
        // so the FrogSocial top strip and music cards repaint from
        // the live `_currentEffectivePaused()` value instead of the
        // last cached snapshot. Without this, going from big to mini
        // (or back) could leave the top strip showing the opposite
        // glyph until the next 1.5s UI tick caught the drift.
        try { _lastEmitHash = ''; _emitState(); } catch {}
        try { _probeIframeStateSoon(); } catch {}
        return;
      }
      panel.classList.remove('active');
      panel.classList.remove('mini');
      panel.style.display = 'none';
      document.body.removeAttribute('data-music');
      document.body.removeAttribute('data-music-mini');
      _clearDock();
      _anchorMs = 0;
      _anchorTrackKey = '';
      _room = null;
      _state = null;
      delete panel.dataset.mountedRoom;
      return;
    }
    _room = roomName;
    panel.classList.remove('mini');
    panel.classList.add('active');
    panel.classList.toggle('collapsed', _collapsed);
    panel.style.display = 'flex';
    document.body.setAttribute('data-music', '1');
    document.body.toggleAttribute('data-music-collapsed', _collapsed);
    document.body.removeAttribute('data-music-mini');
    _clearDock();
    // Strip any leftover mini bar from a previous navigate-away.
    const oldBar = panel.querySelector('.mp-mini-bar');
    if (oldBar) oldBar.remove();
    // Hard-switch between music channels: if the panel already holds an
    // iframe from a *different* room, tear it down before rendering so the
    // old track doesn't keep playing while the new one loads.
    const wrap = document.getElementById('mp-player-wrap');
    if (wrap && panel.dataset.mountedRoom && panel.dataset.mountedRoom !== roomName) {
      panel.innerHTML = `<div class="mp-empty">Switching to #${esc(roomName)}…</div>`;
      _anchorMs = 0;
      _anchorTrackKey = '';
    } else if (!wrap) {
      panel.innerHTML = `<div class="mp-empty">Loading queue…</div>`;
    }
    panel.dataset.mountedRoom = roomName;
    _state = await _fetchState(roomName);
    if (!_state) {
      panel.innerHTML = `<div class="mp-empty">Could not load queue</div>`;
      _emitState();
      return;
    }
    _render();
    // Surface change: force a state broadcast through the dedupe so every
    // dependent UI (FrogSocial top strip, music cards, dock) repaints from
    // current truth instead of holding the snapshot from before the switch.
    try { _lastEmitHash = ''; _emitState(); } catch {}
    // Owner / DJ auto-fill: if the user just opened a media channel that
    // happens to be empty AND auto-fill is enabled for this room, queue
    // a Discover pick now. Previously this only fired off WS events, so
    // joining an idle room sat empty until something else nudged the
    // queue.
    try { _maybeAutoFillEmptyQueue(); } catch {}
    // Probe the iframe so _lastPlayerState reflects reality ASAP after
    // a surface switch (large ↔ mini), and re-paint buttons on a short
    // ladder so any transient YT "buffering/cued" state doesn't leave a
    // surface mid-flip with the wrong glyph.
    try { _probeIframeStateSoon(); } catch {}
  }

  // Toggle the collapsed state of the music panel. When collapsed, the
  // panel shrinks to a slim bar so the chat takes most of the screen;
  // tap the same button again to bring the player back. Persisted across
  // reloads via localStorage so the user's preference sticks.
  function toggleCollapse() {
    _collapsed = !_collapsed;
    try { localStorage.setItem('mp.collapsed', _collapsed ? '1' : '0'); } catch {}
    const panel = $('music-panel');
    if (panel) panel.classList.toggle('collapsed', _collapsed);
    document.body.toggleAttribute('data-music-collapsed', _collapsed);
    // _render()'s curKey-unchanged early-return only refreshes
    // mp-meta-wrap, leaving the size-toggle button (which lives inside
    // mp-player-wrap) with stale icon + label. Update the button in
    // place so the glyph flips even when the head track hasn't changed.
    try {
      const btn = panel && panel.querySelector('.mp-size-toggle');
      if (btn) {
        const expandSvg = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M3 8h10M8 3v10"/></svg>';
        const minimizeSvg = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M3 8h10"/></svg>';
        btn.innerHTML = _collapsed ? expandSvg : minimizeSvg;
        btn.title = _collapsed ? 'Expand player' : 'Minimize player to make chat bigger';
        btn.setAttribute('aria-label', _collapsed ? 'Expand player' : 'Minimize player');
      }
    } catch {}
    // Re-render the rest so meta / queue layout adapt to the new height.
    _render();
  }

  // Manual re-align to the room's play head. Useful after a user pauses
  // for a while, plugs headphones, or just wants to catch up to the group.
  function resyncNow() {
    if (!_room) return;
    // Instant visual feedback so the user knows we heard them. Reset the
    // badge to "checking" while the seek lands and the next probe runs.
    _lastDriftSec = null;
    _lastPlayerState = null;
    _renderSyncBadge();
    // Refresh server state in case someone skipped while we were away, then
    // seek to the expected position.
    _fetchState(_room).then(s => {
      if (!s) return;
      _state = s;
      const cur = (s.queue || [])[0];
      if (cur) {
        const key = `${cur.provider}:${cur.video_id}`;
        if (key !== _anchorTrackKey) {
          _setAnchor(cur, s.position_sec);
          _render();
          return;
        }
        // Same head track — local anchor IS the room's clock once seeded.
        // Do NOT re-anchor from server here: server's position_sec can
        // return a stale ~0 after an in-memory anchor miss, which would
        // yank our seek target to the start of the track. _setAnchor
        // already filters bad readings, but skipping the call entirely
        // for the steady-state Resync path is the cheapest correct
        // option.
        _resync(true);
        // Fast follow-up probes: ~900ms (after the seek lands) and ~2.5s
        // (after the iframe has settled) so the badge updates promptly
        // instead of waiting for the next 4s tick.
        _scheduleFastProbes([900, 2500]);
      }
      try { UI.showToast('📻 Re-synced with the room', 'success'); } catch {}
    });
  }

  // ─── Sidebar / mobile mini dock ─────────────────────────────────────
  // Polished persistent bar shown when music is playing but the user is
  // viewing a different channel. Anchored in the sidebar on desktop, pinned
  // to the bottom of the viewport on mobile (CSS handles positioning).

  function _clearDock() {
    const dock = $('music-mini-dock');
    if (!dock) return;
    dock.innerHTML = '';
    dock.setAttribute('aria-hidden', 'true');
  }

  function _providerSupportsPause(p) {
    return p === 'youtube' || p === 'soundcloud';
  }

  function _renderDock(cur) {
    const dock = $('music-mini-dock');
    if (!dock || !cur) return;
    if (!_room && !_soloMode) return;
    const titleEsc = esc(cur.title || cur.url || 'Now playing');
    const roomEsc = esc(_room || '');
    const sharerEsc = esc(cur.sharer || '');
    const art = cur.thumbnail ? `style="background-image:url('${esc(cur.thumbnail)}')"` : '';
    const noArt = cur.thumbnail ? '' : 'no-art';
    const canPause = _providerSupportsPause(cur.provider);
    // Skip is allowed in solo mode (advances via Social.getNextMusicTrack /
    // discover fallback) and in room mode for users with can_control. For
    // listeners in a room we hide the button rather than show a toast on
    // every click — the queue is server-authoritative there anyway.
    const canSkip = _soloMode || !!(_state && _state.can_control);
    dock.setAttribute('aria-hidden', 'false');
    dock.setAttribute('data-provider', cur.provider || '');
    dock.setAttribute('data-solo', _soloMode ? '1' : '0');
    const expandTitle = _soloMode ? 'Back to FrogSocial Music' : 'Back to channel';
    // In solo mode we show "@sharer" (or just "FrogSocial" if the sharer
    // wasn't recorded) instead of a channel name — matches the "played from
    // <user>'s Music tab" mental model.
    const soloLabel = sharerEsc ? `@${sharerEsc}` : 'FrogSocial';
    const subInner = _soloMode
      ? `<span class="mmd-live-dot"></span>
         <span class="mmd-room" title="Open FrogSocial Music">${soloLabel}</span>`
      : `<span class="mmd-live-dot"></span>
         <span class="mmd-room" title="Go to #${roomEsc}">#${roomEsc}</span>`;
    const anOn = _autoNextEnabled();
    // Compute initial play/pause icon from canonical truth so the dock
    // doesn't flash ⏸ for a frame on a paused track before the
    // post-render _syncPlayPauseButtons() call repaints it.
    const _dockInitPlaying = !_currentEffectivePaused();
    dock.innerHTML = `
      <div class="mmd-art ${noArt}" ${art} onclick="Music.expand()" title="${expandTitle}"></div>
      <div class="mmd-info" onclick="Music.expand()">
        <div class="mmd-title" title="${titleEsc}">${titleEsc}</div>
        <div class="mmd-sub">${subInner}</div>
        <label class="mp-an-check mp-an-check--dock ${anOn ? 'on' : ''}" onclick="event.stopPropagation()" title="${anOn ? 'Auto-next: on (uncheck to disable)' : 'Auto-next: off (check to enable)'}">
          <input type="checkbox" data-autonext-check ${anOn ? 'checked' : ''} onchange="Music.toggleAutoNext()" aria-label="Auto-next">
          <span class="mp-an-box" aria-hidden="true"></span>
          <span class="mp-an-lbl">Auto-next</span>
        </label>
      </div>
      <div class="mmd-ctrls">
        <button class="mmd-btn mmd-play ${canPause ? '' : 'unsupported'}" data-playing="${_dockInitPlaying ? '1' : '0'}"
                title="${_dockInitPlaying ? 'Pause' : 'Play'}" aria-label="${_dockInitPlaying ? 'Pause' : 'Play'}"
                onclick="event.stopPropagation();Music.togglePause(this)">${_dockInitPlaying ? _PAUSE_SVG : _PLAY_SVG}</button>
        ${canSkip ? `<button class="mmd-btn mmd-skip" title="Next track" aria-label="Next track"
                       onclick="event.stopPropagation();Music.skipNext()">${_SKIP_SVG}</button>` : ''}
        <button class="mmd-btn mmd-close" title="Stop" aria-label="Stop"
                onclick="event.stopPropagation();Music.close()">✕</button>
      </div>`;
    document.body.setAttribute('data-music-mini', '1');
    // Reflect current effective paused state on the freshly-rendered
    // button. The template hardcodes ⏸ for layout simplicity; without
    // this the dock would always show "playing" on re-render even if YT
    // has auto-paused or the user backgrounded the app.
    try { _syncPlayPauseButtons(); } catch {}
    try { _syncAutoNextButtons(); } catch {}
    try { _startUiSync(); } catch {}
  }

  function _miniBarHtml(titleEsc, provider) {
    const canPause = (provider === 'youtube' || provider === 'soundcloud');
    // Same anti-flash trick as _renderDock — render the icon from the
    // canonical effective-paused flag instead of hardcoded ⏸.
    const playing = !_currentEffectivePaused();
    const ppBtn = canPause
      ? `<button class="mp-mini-btn mp-mini-playpause" data-playing="${playing ? '1' : '0'}" title="${playing ? 'Pause' : 'Play'}" aria-label="${playing ? 'Pause' : 'Play'}" onclick="Music.togglePause(this)">${playing ? _PAUSE_SVG : _PLAY_SVG}</button>`
      : '';
    return `
      <span class="mp-mini-title" title="${titleEsc}">🎵 ${titleEsc}</span>
      ${ppBtn}
      <button class="mp-mini-btn" title="Back to channel" onclick="Music.expand()">⤢</button>
      <button class="mp-mini-btn" title="Stop" onclick="Music.close()">✕</button>`;
  }

  function togglePause(btn) {
    const frame = document.querySelector('#mp-player-wrap iframe.mp-frame');
    if (!frame || !frame.contentWindow) return;
    // Source of truth: the canonical effective state (combines user
    // intent + YT-reported state). Trusting btn.dataset.playing alone
    // breaks if a button was just rendered before _syncPlayPauseButtons
    // ran, or if YT auto-paused in the background — you'd press the
    // ⏸ icon and the code would think you wanted to pause again.
    const effectivelyPaused = _currentEffectivePaused();
    const playing = !effectivelyPaused;       // currently playing?
    const src = frame.src || '';
    try {
      if (src.includes('youtube.com')) {
        frame.contentWindow.postMessage(
          JSON.stringify({ event: 'command', func: playing ? 'pauseVideo' : 'playVideo', args: [] }),
          '*'
        );
      } else if (src.includes('soundcloud.com')) {
        frame.contentWindow.postMessage(
          JSON.stringify({ method: playing ? 'pause' : 'play' }),
          '*'
        );
      } else {
        return;
      }
    } catch {}
    const nowPlaying = !playing;
    // Track user-intent pause separately from _paused. _paused gets
    // flipped by lots of paths (visibility, infoDelivery, surrender);
    // _userPaused is sticky and only the user toggles it.
    _userPaused = !nowPlaying;
    // Stamp the user-intent guard so the iframe reconciliation handlers
    // ignore any stale pre-toggle state events still in flight. Without
    // this, clicking pause and then receiving a buffered playerState=1
    // event a moment later would silently flip _paused back to false
    // and leave the dock/mini buttons showing ⏸ while audio was paused
    // (and vice versa on a click-to-play). Same root cause for both
    // YouTube and SoundCloud iframes.
    _userIntentPaused = !nowPlaying;
    _userIntentAt = Date.now();
    // Don't auto-catch-up on un-pause. The iframe resumes from where
    // the user paused it — that's the expected behaviour. Resync is
    // a separate explicit action.
    if (btn) {
      btn.dataset.playing = nowPlaying ? '1' : '0';
      btn.innerHTML = nowPlaying ? _PAUSE_SVG : _PLAY_SVG;
      btn.title = nowPlaying ? 'Pause' : 'Play';
      btn.setAttribute('aria-label', btn.title);
    }
    // Optimistically prime YT's reported state so the next _emitState()
    // doesn't fall back to the stale value. Without this, after pressing
    // Play the dock button would flicker right back to ▶ because
    // _currentEffectivePaused() consults _lastPlayerState (still 2)
    // until YT's onStateChange catches up a moment later.
    _lastPlayerState = nowPlaying ? 1 : 2;
    _paused = !nowPlaying;
    // Keep every play/pause button in the UI in sync (drawer + mini bar).
    _syncPlayPauseButtons(nowPlaying);
    if (_paused) _stopSyncProbe(); else _startSyncProbeIfNeeded();
    _emitState();
  }

  function _renderMini(cur) {
    const panel = $('music-panel');
    if (!panel || !cur) return;
    const existingWrap = document.getElementById('mp-player-wrap');
    const curKey = `${cur.provider}:${cur.video_id}`;
    if (existingWrap && existingWrap.dataset.curKey === curKey) {
      // Same track — keep the iframe intact so playback doesn't restart.
      return;
    }
    // Fresh iframe needed (first mini render or track change). Prefer
    // the local clock (_expectedPosSec) over raw _state.position_sec so
    // the mini player picks up where the main one left off, even if the
    // server's anchor is currently stale (e.g. just restamped to 0).
    const localPos = _expectedPosSec();
    const serverPos = Math.max(0, Math.min(21600, parseInt(_state.position_sec || 0, 10) || 0));
    const posSec = Math.max(localPos, serverPos);
    // Honour user-pause intent. If the user explicitly paused before
    // navigating to another channel (which is what triggers this fresh
    // mini render), an autoplay=1 iframe would override that and start
    // playing from the embed's start offset. Build the iframe paused.
    const ap = _userPaused ? '0' : '1';
    const scAuto = _userPaused ? 'false' : 'true';
    const playerHtml = cur.provider === 'youtube'
      ? `<iframe class="mp-frame" src="https://www.youtube.com/embed/${esc(cur.video_id)}?autoplay=${ap}&enablejsapi=1&start=${posSec}" allow="autoplay; encrypted-media"></iframe>`
      : cur.provider === 'spotify'
        ? `<iframe class="mp-frame" src="https://open.spotify.com/embed/${esc(cur.video_id)}?t=${posSec}" allow="autoplay; clipboard-write; encrypted-media"></iframe>`
        : cur.provider === 'soundcloud'
          ? `<iframe class="mp-frame" scrolling="no" frameborder="no" src="https://w.soundcloud.com/player/?url=${encodeURIComponent(cur.video_id)}&auto_play=${scAuto}&show_artwork=true&visual=false&hide_related=true&color=%234caf50"></iframe>`
          : `<div class="mp-empty">Unsupported</div>`;
    panel.innerHTML = `
      <div id="mp-player-wrap" data-cur-key="${curKey}">${playerHtml}</div>
      <div id="mp-meta-wrap"></div>`;
    // Mirror _renderDock — make sure every play/pause icon (mmd-play,
    // mp-mini-playpause, mtnp-pp, mtnp-dot, mtnp-state) reflects current
    // truth right after a fresh mount, instead of being stuck on the
    // hardcoded data-playing="1" template default.
    try { _syncPlayPauseButtons(); } catch {}
    try { _startUiSync(); } catch {}
  }

  function expand() {
    // Solo (FrogSocial) playback: bring the user back to the Social Music tab
    // and, if we know the source post, scroll to it.
    if (_soloMode) {
      try {
        const cur = _state && _state.queue && _state.queue[0];
        const postId = cur && cur.post_id;
        if (typeof Social !== 'undefined') {
          if (typeof Social.open === 'function') Social.open();
          if (postId && typeof Social.scrollToMusicPost === 'function') {
            Social.scrollToMusicPost(postId);
          } else if (typeof Social.switchTab === 'function') {
            Social.switchTab('music');
          }
        }
      } catch {}
      return;
    }
    if (_room && typeof Rooms !== 'undefined' && Rooms.switchToRoom) {
      Rooms.switchToRoom(_room, 'music');
      // No auto-resync. The iframe was kept alive while the user was on
      // another channel; it's still where they left it. If they want
      // to catch back up to the room they can hit Resync explicitly.
      // Surface change (mini→big): force every dependent UI to repaint
      // from live state instead of holding the previous snapshot.
      try { _lastEmitHash = ''; _emitState(); } catch {}
      try { _probeIframeStateSoon(); } catch {}
    }
  }

  function close() {
    _stopSyncProbe();
    _stopUiSync();
    const panel = $('music-panel');
    if (panel) {
      panel.classList.remove('active');
      panel.classList.remove('mini');
      panel.style.display = 'none';
      panel.innerHTML = '';
      delete panel.dataset.mountedRoom;
    }
    document.body.removeAttribute('data-music');
    document.body.removeAttribute('data-music-mini');
    _clearDock();
    _anchorMs = 0;
    _anchorTrackKey = '';
    _room = null;
    _state = null;
    _soloMode = false;
    _paused = false;
    _muted = false;
    // Reset every sticky pause flag so the NEXT render (channel mount
    // or playSolo) builds an autoplay=1 iframe. Without this, a user
    // who paused a track and then triggered "Send to player" / clicked
    // a music card got a silent iframe (autoplay=0 from _userPaused)
    // and the play/pause buttons stayed stuck on ▶ even though the
    // freshly-mounted iframe was happy to play. Same root cause for
    // both the side player and the FrogSocial top strip — both consume
    // _userPaused / _userIntentPaused via _currentEffectivePaused().
    _userPaused = false;
    _userIntentPaused = null;
    _userIntentAt = 0;
    _lastPlayerState = null;
    _emitState();
  }

  // ── Solo playback: plays a single track from FrogSocial (not a channel) ──
  // Reuses the same #music-panel + #music-mini-dock UI the channel player
  // uses, so the track docks to the persistent mini-player just like a
  // normal music-channel track.
  //
  //   Music.playSolo({url, title, provider, thumbnail})
  //
  // If the user is already in a real music channel, we silently detach
  // from it (the channel keeps playing for everyone else — only this
  // user's player is hijacked) and start solo playback of the clicked
  // track. The user can hop back to the music channel from the sidebar
  // any time and re-sync.
  function playSolo(opts) {
    opts = opts || {};
    // Clear sticky pause-intent BEFORE anything else. _renderMini reads
    // _userPaused to decide autoplay=0 vs 1 in the iframe URL — and if
    // the user had paused a previous track in this session, that flag
    // would leak into the fresh iframe, producing silent playback. Same
    // for _userIntentPaused which gates iframe state-event reconciliation.
    _userPaused = false;
    _userIntentPaused = null;
    _userIntentAt = 0;
    _lastPlayerState = null;
    if (_room && !_soloMode) {
      // Tear down the channel-mode UI/state without leaving the room
      // server-side: close() resets _room/_state/_paused locally so the
      // fresh solo render below starts from a clean slate. The channel
      // continues for other users; this client just stopped following.
      try { close(); } catch {}
      // close() resets _userPaused; re-clear here so the order of the
      // ifs above doesn't matter to a future reader.
      _userPaused = false;
      _userIntentPaused = null;
    }
    const url = String(opts.url || '').trim();
    if (!url) return false;
    // Derive provider + video_id (same matcher social.js uses).
    let provider = (opts.provider || '').toLowerCase();
    let videoId = '';
    try {
      const ytFull = url.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
      const ytShort = url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
      const ytId = (ytFull && ytFull[1]) || (ytShort && ytShort[1]);
      if (ytId && (!provider || provider === 'youtube')) {
        provider = 'youtube'; videoId = ytId;
      } else {
        const sp = url.match(/open\.spotify\.com\/(track|playlist|album|episode)\/([A-Za-z0-9]+)/);
        if (sp) { provider = 'spotify'; videoId = `${sp[1]}/${sp[2]}`; }
        else if (url.includes('soundcloud.com')) { provider = 'soundcloud'; videoId = url; }
      }
    } catch {}
    if (!provider || !videoId) {
      try { UI.showToast('Unsupported music link', 'error'); } catch {}
      return false;
    }
    // Auto-thumbnail for YouTube when caller didn't supply one.
    let thumb = opts.thumbnail || '';
    if (!thumb && provider === 'youtube') {
      thumb = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    }
    const track = {
      provider,
      video_id: videoId,
      url,
      title: opts.title || 'Music',
      thumbnail: thumb,
      sharer: String(opts.sharer || '').trim(),
      // Optional source-post id so the dock can scroll back to it
      // and so a third-party 'recommend next' can prefer the same author.
      post_id: (opts.postId != null && Number.isFinite(Number(opts.postId)))
        ? Number(opts.postId) : null,
    };
    // Stash a fake channel state so _renderMini / togglePause / _resync all
    // operate normally. can_control is false so the dock hides the skip btn.
    _soloMode = true;
    _room = null;
    _state = { queue: [track], can_control: false, is_dj: false, position_sec: 0 };
    // Critical: reset playback flags BEFORE _renderMini below. The mini
    // iframe is built from these (autoplay=${_userPaused ? 0 : 1}); if
    // we let _setAnchor or stale state set _userPaused=true, we get a
    // silent iframe and the dock button stuck on ▶.
    _paused = false;
    _muted = false;
    _userPaused = false;
    _userIntentPaused = null;
    // Optional start offset (seconds) — chat link previews pass this
    // through so a "Send to player" click resumes at the same point
    // the user was watching in the inline iframe.
    const startSec = Math.max(0, Math.floor(Number(opts.startSec) || 0));
    // _setAnchor refuses regressions when the track key matches an
    // existing anchor; clear it so a fresh playSolo always seeds
    // cleanly regardless of session history.
    _anchorMs = 0;
    _anchorTrackKey = '';
    _setAnchor(track, startSec);

    // Keep the #music-panel hidden (solo playback runs inside the mini-dock
    // iframe only — we don't want a giant full-screen player covering the
    // Social view). Build a hidden host div that holds the iframe.
    const panel = $('music-panel');
    if (panel) {
      panel.classList.remove('active');
      panel.classList.add('mini');
      panel.style.display = 'flex';
      // _renderMini writes #mp-player-wrap into the panel. That's where the
      // togglePause/seek code looks for the iframe, so we need it mounted
      // even if visually hidden. The existing CSS for `.mini` collapses
      // the panel to just the mini-bar footprint.
      _renderMini(track);
      document.body.setAttribute('data-music', '1');
    }
    _renderDock(track);
    _emitState();
    // Critical: kick off the sync probe so the YT iframe's 'listening'
    // handshake gets sent. Without this, onStateChange messages never
    // come back and _maybeAutoAdvanceOnEnded() never fires when the
    // solo track ends — auto-next would silently die. The probe is
    // cheap (postMessage every 4s) and self-stops on pause/unmount.
    try { _startSyncProbeIfNeeded(); } catch {}
    // Reconcile every surface (dock + FrogSocial top strip) to live
    // truth on the same ladder mount() uses, so a Send-to-player from
    // a music card flips every visible play/pause glyph correctly
    // even before YT's first state event lands.
    try { _probeIframeStateSoon(); } catch {}
    return true;
  }

  async function submit(urlOverride) {
    if (!_room) return;
    let url;
    if (typeof urlOverride === 'string') {
      url = urlOverride.trim();
    } else {
      const inp = $('mp-input');
      url = (inp?.value || '').trim();
      if (inp) inp.disabled = true;
    }
    if (!url) {
      const inp = $('mp-input'); if (inp) inp.disabled = false;
      return;
    }
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(_room)}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!res.ok) { UI.showToast(data.error || 'Failed to add track', 'error'); return false; }
      const inp = $('mp-input'); if (inp) inp.value = '';
      // Optimistic refresh — WS will also push
      _state = await _fetchState(_room);
      _render();
      return true;
    } finally {
      const inp = $('mp-input'); if (inp) inp.disabled = false;
    }
  }

  // Modal-based URL entry. Inline inputs on Android are unreliable because
  // the soft keyboard reflows the page and can push embedded iframes
  // behind other panels. A position:fixed overlay sidesteps that entirely.
  function openAddModal() {
    if (!_state || !_state.can_submit) return;
    closeAddModal();
    const overlay = document.createElement('div');
    overlay.id = 'mp-add-modal';
    overlay.className = 'mp-add-modal';
    overlay.innerHTML = `
      <div class="mp-add-card" role="dialog" aria-modal="true" aria-label="Add track">
        <div class="mp-add-head">
          <span class="mp-add-head-ico">🎵</span>
          <span class="mp-add-head-title">Add a track</span>
          <button class="mp-add-close" aria-label="Close" onclick="Music.closeAddModal()">✕</button>
        </div>
        <div class="mp-add-body">
          <label class="mp-add-label" for="mp-input">Paste a YouTube, Spotify, or SoundCloud link</label>
          <input id="mp-input" class="mp-add-input" type="url" inputmode="url"
                 autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
                 placeholder="https://www.youtube.com/watch?v=…">
          <div class="mp-add-hint">Press Enter or tap Add to queue it.</div>
        </div>
        <div class="mp-add-actions">
          <button class="mp-btn" onclick="Music.closeAddModal()">Cancel</button>
          <button class="mp-btn primary" onclick="Music.submitFromModal()">Add</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    // Close on backdrop click (but not card click)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeAddModal();
    });
    const inp = overlay.querySelector('#mp-input');
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitFromModal(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeAddModal(); }
      });
      // Try to pre-fill from clipboard if it looks like a URL.
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(t => {
            const v = (t || '').trim();
            if (/^https?:\/\//i.test(v) && /youtu|spotify|soundcloud/i.test(v) && !inp.value) {
              inp.value = v;
            }
          }).catch(() => {});
        }
      } catch {}
      // Focus on next tick so the modal animation completes first.
      setTimeout(() => { try { inp.focus(); inp.select(); } catch {} }, 60);
    }
  }

  function closeAddModal() {
    const o = document.getElementById('mp-add-modal');
    if (o) o.remove();
  }

  async function submitFromModal() {
    const inp = document.getElementById('mp-input');
    const url = (inp?.value || '').trim();
    if (!url) return;
    if (inp) inp.disabled = true;
    const ok = await submit(url);
    if (inp) inp.disabled = false;
    if (ok) closeAddModal();
  }

  // Full-playlist modal. Opens a fixed overlay listing every track in
  // the queue with thumbnails, submitter, and (for DJs / track owners)
  // a remove button. Re-renders itself on every state change so it
  // stays live while open.
  function openPlaylistModal() {
    closePlaylistModal();
    const overlay = document.createElement('div');
    overlay.id = 'mp-playlist-modal';
    overlay.className = 'mp-add-modal';
    overlay.addEventListener('click', e => { if (e.target === overlay) closePlaylistModal(); });
    document.body.appendChild(overlay);
    _renderPlaylistModal();
    const onKey = e => { if (e.key === 'Escape') { closePlaylistModal(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  }

  function closePlaylistModal() {
    const o = document.getElementById('mp-playlist-modal');
    if (o) o.remove();
  }

  function _renderPlaylistModal() {
    const overlay = document.getElementById('mp-playlist-modal');
    if (!overlay) return;
    const q = (_state && _state.queue) || [];
    const cur = q[0];
    const upcoming = q.slice(1);
    const meId = State.user?.id;
    const items = upcoming.map((t, i) => `
      <div class="mp-pl-item" data-tid="${t.id}">
        <span class="mp-pl-idx">${i + 1}</span>
        <div class="mp-pl-art" style="background-image:url('${esc(t.thumbnail || '')}')"></div>
        <div class="mp-pl-info">
          <div class="mp-pl-title" title="${esc(t.title || t.url)}">${esc(t.title || t.url)}</div>
          <div class="mp-pl-sub">${esc(t.submitter_nick || '?')} · ${esc(t.provider || '')}</div>
        </div>
        ${(_state.can_control || t.submitter_id === meId)
          ? `<button class="mp-pl-del" title="Remove from playlist" onclick="Music.removeTrack(${t.id})" aria-label="Remove">✕</button>`
          : ''}
      </div>
    `).join('');
    const nowHtml = cur ? `
      <div class="mp-pl-now">
        <span class="mp-pl-now-pulse"></span>
        <div class="mp-pl-now-art" style="background-image:url('${esc(cur.thumbnail || '')}')"></div>
        <div class="mp-pl-info">
          <div class="mp-pl-now-label">Now playing</div>
          <div class="mp-pl-title" title="${esc(cur.title || cur.url)}">${esc(cur.title || cur.url)}</div>
          <div class="mp-pl-sub">${esc(cur.submitter_nick || '?')} · ${esc(cur.provider || '')}</div>
        </div>
      </div>` : '';
    const emptyHtml = upcoming.length ? '' :
      (_state && _state.can_submit
        ? `<div class="mp-pl-empty">Nothing queued yet — tap <b>Add Media</b> to drop the first one.</div>`
        : `<div class="mp-pl-empty">Nothing queued yet. ${_state && _state.dj_only ? 'Only DJs can add tracks in this channel.' : 'Be the first to add one!'}</div>`);
    const canAdd = _state && _state.can_submit;
    const headSubtitle = (_state && _state.dj_only)
      ? `${upcoming.length ? `${upcoming.length} up next · ` : ''}🎧 DJ-only`
      : (upcoming.length ? `${upcoming.length} up next` : 'Open queue');
    overlay.innerHTML = `
      <div class="mp-add-card mp-pl-card" role="dialog" aria-modal="true" aria-label="Playlist">
        <div class="mp-add-head">
          <span class="mp-add-head-ico">🎶</span>
          <span class="mp-add-head-title">Playlist · ${headSubtitle}</span>
          ${(_state && _state.can_control && upcoming.length)
            ? `<button class="mp-pl-clear" type="button" onclick="Music.clearQueue()" title="Clear all queued tracks">Clear all</button>` : ''}
          <button class="mp-add-close" type="button" onclick="Music.closePlaylistModal()" aria-label="Close">✕</button>
        </div>
        <div class="mp-pl-body">
          ${nowHtml}
          <div class="mp-pl-list">${items}${emptyHtml}</div>
        </div>
        <div class="mp-add-actions">
          ${canAdd ? `<button class="mp-btn primary" type="button" onclick="Music.closePlaylistModal();Music.openAddModal()">Add Media</button>` : ''}
          <button class="mp-btn" type="button" onclick="Music.closePlaylistModal()">Close</button>
        </div>
      </div>`;
  }

  // Public skip-to-next that works from every mini player on the site.
  // Reuses the same advancement logic as auto-next-on-ended:
  //   - solo mode: ask Social for the next FrogSocial music track,
  //     fall back to the public discover endpoint;
  //   - room mode (DJ/owner/admin): server-authoritative skip;
  //   - room mode listener: noop with a toast (queue is server-side).
  // Bypasses the auto-next preference because the user explicitly
  // pressed the skip button.
  function skipNext() {
    const cur = _state && _state.queue && _state.queue[0];
    if (!cur) return;
    if (_soloMode) {
      try {
        const S = window.Social;
        const next = (S && typeof S.getNextMusicTrack === 'function')
          ? S.getNextMusicTrack(cur.url, { provider: cur.provider })
          : null;
        if (next && next.url && next.url !== cur.url) {
          playSolo(next);
          return;
        }
        if (S && typeof S.fetchDiscoverMusicTrack === 'function') {
          S.fetchDiscoverMusicTrack(cur.url).then(d => {
            if (!d || !d.url || d.url === cur.url) {
              try { UI.showToast && UI.showToast('No next track available', 'info'); } catch {}
              return;
            }
            try { UI.showToast && UI.showToast('Skipped — Discover pick 🎵', 'info'); } catch {}
            playSolo(d);
          }).catch(() => {
            try { UI.showToast && UI.showToast('Could not load next track', 'error'); } catch {}
          });
        } else {
          try { UI.showToast && UI.showToast('No next track available', 'info'); } catch {}
        }
      } catch {}
      return;
    }
    if (_state && _state.can_control) {
      skip(parseInt(cur.id, 10) || null).catch(() => {});
    } else {
      try { UI.showToast && UI.showToast('Only DJs can skip in this room', 'info', 1800); } catch {}
    }
  }

  async function skip() {
    const expectedTrackId = (arguments.length > 0) ? arguments[0] : null;
    const isAuto = !!(arguments.length > 1 && arguments[1] && arguments[1].auto);
    if (!_room) return;
    const body = {};
    if (Number.isInteger(expectedTrackId) && expectedTrackId > 0) {
      body.expected_track_id = expectedTrackId;
    }
    if (isAuto) body.auto = true;
    const res = await fetch(`/api/rooms/${encodeURIComponent(_room)}/queue/skip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': State.token,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) { _state = await _fetchState(_room); _render(); }
  }

  // Loop the current track from 0 in the YT/SC iframe. Used in solo
  // (FrogSocial mini-dock / topbar / sidebar) playback when auto-next
  // is OFF and the head track ends — instead of leaving the user on a
  // dead frozen player, we restart the same track. Deliberately NOT
  // wired into room mode: a music channel queue is server-authoritative
  // and shared across listeners, so a client-side loop would desync
  // every other listener with the head track they're already past.
  function _loopCurrentSolo() {
    try {
      const frame = document.querySelector('#mp-player-wrap iframe.mp-frame');
      if (!frame || !frame.contentWindow) return false;
      const src = frame.src || '';
      if (src.includes('youtube.com')) {
        // Seek to 0, then play. YT iframe accepts both messages back to back.
        frame.contentWindow.postMessage(
          JSON.stringify({ event: 'command', func: 'seekTo', args: [0, true] }), '*');
        frame.contentWindow.postMessage(
          JSON.stringify({ event: 'command', func: 'playVideo', args: [] }), '*');
        return true;
      } else if (src.includes('soundcloud.com')) {
        frame.contentWindow.postMessage(JSON.stringify({ method: 'seekTo', value: 0 }), '*');
        frame.contentWindow.postMessage(JSON.stringify({ method: 'play' }), '*');
        return true;
      }
    } catch {}
    return false;
  }

  function _maybeAutoAdvanceOnEnded() {
    const q = (_state && _state.queue) || [];
    const cur = q[0];
    if (!cur) return;
    if ((cur.provider || '') !== 'youtube') return;

    // Auto-next OFF behavior:
    //   - solo mode (mini-dock / topbar / sidebar): loop the same
    //     track so the user always has audio. This matches the
    //     "keep the vibe going" expectation of a casual music dock.
    //   - room mode (big music channel player): do nothing — the
    //     player just sits on the last frame, exactly like YouTube
    //     does when loop is off. Looping client-side here would
    //     desync from other listeners hearing the server-side queue.
    if (!_autoNextEnabled()) {
      if (_soloMode) {
        const key = `loop:${cur.id || cur.url || ''}`;
        const now = Date.now();
        if (key === _autoAdvanceLastKey && (now - _autoAdvanceLastAt) < 4000) return;
        _autoAdvanceLastKey = key;
        _autoAdvanceLastAt = now;
        _loopCurrentSolo();
      }
      return;
    }

    const key = `${_room || 'solo'}:${cur.id || cur.url || ''}`;
    const now = Date.now();
    if (key === _autoAdvanceLastKey && (now - _autoAdvanceLastAt) < 6000) return;
    _autoAdvanceLastKey = key;
    _autoAdvanceLastAt = now;

    // Solo (FrogSocial) playback: ask Social for the next track in the
    // music feed. If Social hasn't loaded its music tab yet or its cache
    // is exhausted, fall back to the public discover endpoint so the
    // mini-player keeps the music going instead of dying silently.
    if (_soloMode) {
      try {
        const next = (window.Social && typeof Social.getNextMusicTrack === 'function')
          ? Social.getNextMusicTrack(cur.url, { provider: cur.provider })
          : null;
        if (next && next.url && next.url !== cur.url) {
          // Tear down current solo track first so playSolo's
          // "already in a music channel" guard doesn't get confused.
          playSolo(next);
          return;
        }
        // Async discover fallback. We don't await this branch with the
        // outer function (which is sync) — fire-and-forget. Worst case,
        // a small playback gap; best case, the next track lands.
        if (window.Social && typeof Social.fetchDiscoverMusicTrack === 'function') {
          Social.fetchDiscoverMusicTrack(cur.url).then(d => {
            if (!d || !d.url || d.url === cur.url) return;
            // Make sure the user hasn't manually started something else
            // in the meantime.
            const head = (_state && _state.queue && _state.queue[0]) || null;
            if (!head || head.url !== cur.url) return;
            try { UI.showToast('Auto-next: discover pick 🎵', 'info'); } catch {}
            playSolo(d);
          }).catch(() => {});
        }
      } catch {}
      return;
    }

    if (!_room) return;
    // Listeners (non-DJs) can also auto-advance now — server validates
    // expected_track_id + min-played-seconds to prevent abuse. Without
    // this, a music channel where the DJ has left or where the only
    // member is a listener would get stuck on the last played track
    // and Resync would seek past the end of the video.
    skip(parseInt(cur.id, 10) || null, { auto: true }).catch(() => {});
  }

  async function clearQueue() {
    if (!_room) return;
    if (!confirm('Clear the entire queue?')) return;
    const res = await fetch(`/api/rooms/${encodeURIComponent(_room)}/queue/clear`, {
      method: 'POST', headers: { 'X-Session-Token': State.token }
    });
    if (res.ok) { _state = await _fetchState(_room); _render(); }
  }

  async function removeTrack(trackId) {
    if (!_room) return;
    const res = await fetch(`/api/rooms/${encodeURIComponent(_room)}/queue/${trackId}`, {
      method: 'DELETE', headers: { 'X-Session-Token': State.token }
    });
    if (res.ok) { _state = await _fetchState(_room); _render(); }
  }

  async function toggleDJOnly() {
    if (!_room || !_state) return;
    const next = _state.dj_only ? 0 : 1;
    const res = await fetch(`/api/rooms/${encodeURIComponent(_room)}/dj-only`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ dj_only: next })
    });
    if (res.ok) { _state = await _fetchState(_room); _render(); }
  }

  async function grantDJ(userId) {
    if (!_room) return false;
    const res = await fetch(`/api/rooms/${encodeURIComponent(_room)}/djs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ user_id: userId })
    });
    if (res.ok) { UI.showToast('DJ role granted 🎧', 'success'); _state = await _fetchState(_room); _render(); return true; }
    return false;
  }

  async function revokeDJ(userId) {
    if (!_room) return false;
    const res = await fetch(`/api/rooms/${encodeURIComponent(_room)}/djs/${userId}`, {
      method: 'DELETE', headers: { 'X-Session-Token': State.token }
    });
    if (res.ok) { UI.showToast('DJ role removed', 'info'); _state = await _fetchState(_room); _render(); return true; }
    return false;
  }

  function isDJ(userId) {
    if (!_state || !userId) return false;
    return (_state.djs || []).some(d => d.user_id === userId);
  }

  // Called from ws.js on music_* events
  async function handleWsEvent(evt) {
    if (!_room || evt.room !== _room) return;
    _state = await _fetchState(_room);
    const panel = $('music-panel');
    const isMini = panel && panel.classList.contains('mini');
    if (isMini) {
      const cur = (_state && _state.queue && _state.queue[0]) || null;
      if (cur) {
        _renderMini(cur);
        _renderDock(cur);
        try { _syncPlayPauseButtons(); } catch {}
      } else {
        // Queue emptied while minimized — give auto-fill a chance
        // before tearing down. If the owner has the toggle on, we'll
        // submit a Discover pick and the next ws event will rebuild.
        try { await _maybeAutoFillEmptyQueue(); } catch {}
        // Re-check: if auto-fill landed something the next ws event
        // is already on its way. Either way close() is safe to skip
        // if a new track is now in the queue.
        const after = (_state && _state.queue && _state.queue[0]) || null;
        if (!after) close();
      }
    } else {
      _render();
      try { _maybeAutoFillEmptyQueue(); } catch {}
    }
  }

  // Share the currently-playing track as a post on the user's FrogSocial
  // wall. Stored with media_type="music/<provider>" + media_data=track URL
  // so the social feed can render a native embed (see social.js).
  async function shareToWall() {
    const cur = (_state && _state.queue && _state.queue[0]) || null;
    if (!cur) {
      try { UI.showToast('No track playing to share', 'info'); } catch {}
      return;
    }
    const trackUrl = cur.url || '';
    if (!trackUrl) {
      try { UI.showToast('Track has no shareable URL', 'error'); } catch {}
      return;
    }
    // Open the polished Social music-share modal (no window.prompt).
    // Open the polished Social music-share modal (no window.prompt).
    // Resolve Social via both `window.Social` and the bare global binding —
    // top-level `const` doesn't attach to window in non-module scripts, so
    // older versions of social.js only exposed the bare name.
    const S = (typeof window !== 'undefined' && window.Social)
           || (typeof Social !== 'undefined' ? Social : null);
    if (S && typeof S.openMusicShareModal === 'function') {
      S.openMusicShareModal({
        url: trackUrl,
        title: cur.title || '',
        provider: cur.provider || '',
        room: _room || null,
        lockUrl: true,
      });
      return;
    }
    // Fallback (Social not loaded): toast error rather than old prompt().
    try { UI.showToast('FrogSocial not available — open Social first', 'error'); } catch {}
  }

  // ─── Chat-embed routing helpers ──────────────────────────────────────
  // Used by messages.js to decide where the "▸ Send to player" affordance
  // should send a YouTube/Spotify/SoundCloud link when the user is viewing
  // a media channel:
  //   • If they're in a media channel AND have queue permission → route
  //     the link into the channel's BIG player as a queue add (so the
  //     whole room hears it together).
  //   • If they're in a media channel WITHOUT queue permission → omit
  //     the affordance entirely (no point offering a button that 403s).
  //   • Anywhere else (text channels, DMs, FrogSocial) → fall back to
  //     the side / solo player as before.
  function isMediaChannelContext() {
    // Authoritative signal: Music has mounted into a room (mount() only
    // sets _room when channelType resolves to 'music' / 'voice'), and
    // the user is still standing in that same room. We deliberately
    // DON'T trust State.currentChannelType here — switchToRoom() copies
    // the *parameter* into State, but that parameter defaults to 'text'
    // when callers omit it, so for media channels State.currentChannelType
    // is frequently 'text' even though Music.mount was called with the
    // correct chType derived from roomData. Using _room as the source
    // of truth avoids that whole class of false negatives (which were
    // sending owner clicks to the side player instead of the queue).
    try {
      if (!_room) return false;
      const panel = document.getElementById('music-panel');
      // mount() flips this on for music/voice; off for text/dm.
      if (panel && !panel.classList.contains('active')) return false;
      const cur = String(State?.currentRoom || '');
      return cur === _room;
    } catch { return false; }
  }
  function canQueueInCurrentRoom() {
    return !!(_state && _state.can_submit) && isMediaChannelContext();
  }
  async function queueFromUrl(url) {
    // Used by chat-embed Send-to-player buttons in media channels.
    // Returns true on a successful queue add, false otherwise. The
    // caller decides whether to fall back to playSolo on failure.
    if (!canQueueInCurrentRoom()) return false;
    try {
      const ok = await submit(url);
      return ok !== false;
    } catch { return false; }
  }

  return { mount, submit, skip, skipNext, clearQueue, removeTrack, toggleDJOnly,
           grantDJ, revokeDJ, isDJ, handleWsEvent, expand, close, togglePause,
           togglePauseGlobal, resumeFromNotification, setNativeMuted, getCurrent,
           resyncNow, shareToWall, playSolo,
           toggleAutoNext,
           toggleAutoFill,
           _syncAutoNextButtons,
           _syncPlayPauseButtons,
           openAddModal, closeAddModal, submitFromModal,
           openPlaylistModal, closePlaylistModal,
           toggleCollapse,
           isMediaChannelContext, canQueueInCurrentRoom, queueFromUrl,
           // Native-callable hooks: MainActivity invokes these from
           // Activity.onPause() / onResume() because we deliberately keep
           // the WebView running in the background (so YT audio survives),
           // which means visibilitychange does not fire \u2014 these are
           // the only reliable signal that the app went bg/fg.
           notifyAppBackground: _onAppHidden,
           notifyAppForeground: _onAppVisible,
           resumeOnVisible: _resumeOnVisible };
})();

window.Music = Music;
