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
  let _syncProbeStartedAt = 0;       // ms when probing began for current track
  let _syncFastProbeTimers = [];     // setTimeouts queued by fast re-probe
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

  // Single source of truth for "is the player effectively paused right
  // now?". Combines user intent (_paused) with YouTube's reported state
  // (_lastPlayerState) so a YT auto-pause in background or after the
  // app returns is reflected without us having to call _emitState first.
  function _currentEffectivePaused() {
    try {
      const cur = _state && _state.queue && _state.queue[0];
      const isYouTube = !!(cur && cur.provider === 'youtube');
      const ytKnowsPaused = isYouTube
        && _lastPlayerState !== null
        && _lastPlayerState !== 1
        && _lastPlayerState !== 3;
      return _paused || ytKnowsPaused;
    } catch { return _paused; }
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
        el.textContent = playing ? '⏸' : '▶';
        el.title = playing ? 'Pause' : 'Play';
        el.setAttribute('aria-label', el.title);
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
      // ground truth from the YT iframe. If YT is reporting paused (state
      // 2) or unstarted (-1) but the user hasn't paused, the notification
      // should still show "play" — anything else lies to the user.
      const isYouTube = !!(cur && cur.provider === 'youtube');
      const ytKnowsPaused = isYouTube
        && _lastPlayerState !== null
        && _lastPlayerState !== 1   // 1 = playing
        && _lastPlayerState !== 3;  // 3 = buffering (treat as playing-ish)
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
    return {
      active: true,
      soloMode: _soloMode,
      room: _room || '',
      paused: _paused,
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

  function _setAnchor(track, serverPosSec) {
    if (!track) { _anchorMs = 0; _anchorTrackKey = ''; _userPaused = false; return; }
    const key = `${track.provider}:${track.video_id}`;
    const incoming = Math.max(0, parseInt(serverPosSec || 0, 10) || 0);
    // Track change clears the sticky user-pause flag — pausing song A and
    // then having the queue advance to song B should default to "playing".
    if (key !== _anchorTrackKey) _userPaused = false;

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
      // Server lost its anchor and is reporting ~0 while we're well past it.
      if (incoming < 3 && localElapsed > 5) return;
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
    const ok = _seekIframe(pos);
    if (!ok && force) {
      // Provider without seek support (Spotify) — hard reload the iframe at
      // the current expected offset. Disruptive, so only on explicit user
      // request (force=true).
      const cur = (_state && _state.queue && _state.queue[0]) || null;
      if (!cur) return;
      const wrap = document.getElementById('mp-player-wrap');
      if (!wrap) return;
      if (cur.provider === 'spotify') {
        wrap.innerHTML = `<iframe class="mp-frame" src="https://open.spotify.com/embed/${esc(cur.video_id)}?t=${pos}" allow="autoplay; clipboard-write; encrypted-media" allowfullscreen></iframe>`;
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
          const wasPlaying = (prev === 1);
          const nowPlaying = (parsed.info === 1);
          // Reconcile _paused to YT ground truth on every state change.
          // YT autonomously fires onStateChange when it pauses (state 2)
          // or resumes (state 1) itself — e.g. user taps the iframe's
          // own play button, the embed self-resumes after a buffer, or
          // the resume ladder lands. Without this, _paused gets stuck
          // at whatever _onAppHidden / togglePause set it to.
          if (nowPlaying && _paused) {
            _paused = false;
            try { _syncPlayPauseButtons(); } catch {}
          } else if (parsed.info === 2 && !_paused) {
            // YT paused itself (background, user-clicked iframe, etc.).
            // Mirror to _paused so the dock + tray + badge are honest.
            _paused = true;
            try { _syncPlayPauseButtons(); } catch {}
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
          if (ps === 1 && _paused) {
            _paused = false;
            _lastEmitHash = '';
            try { _syncPlayPauseButtons(); } catch {}
            try { _emitState(); } catch {}
            try { _startSyncProbeIfNeeded(); } catch {}
          } else if (ps === 2 && !_paused) {
            _paused = true;
            _lastEmitHash = '';
            try { _syncPlayPauseButtons(); } catch {}
            try { _emitState(); } catch {}
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
            _renderSyncBadge();
          } else if (actualSec + 10 < expectedAtSample
                     && (Date.now() - _lastAutoCorrectAt) > 6000) {
            // Iframe is behind — most likely Android restart-at-0 case.
            // Seek forward to the room's expected position.
            _lastAutoCorrectAt = Date.now();
            try { _seekIframe(_expectedPosSec()); } catch {}
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
        // For app-foreground / notification-tray resumes, also send an
        // early seek to the room's expected play head. Android WebView
        // routinely restarts the YT embed at position=0 after a long
        // background; without this nudge the user hears the track
        // restart from the beginning until the verify ladder confirms
        // state=1 (~900ms+) and reseeks. The seek-pause race that we
        // normally guard against is acceptable here because the verify
        // ladder will retry play+seek if it re-pauses us.
        if (ignorePaused) {
          setTimeout(() => {
            if (myToken !== _resumeRetryToken) return;
            // Only seek if we have a meaningful expected position. If our
            // anchor is fresh (server just stamped position_sec=0 because
            // it lost its in-memory record), expected~0 — seeking the
            // iframe to 0 would actively clobber any real playback
            // position the iframe still has. Let the sync probe's
            // asymmetric reconciliation adopt iframe truth instead.
            const exp = _expectedPosSec();
            if (exp >= 3) {
              try { _seekIframe(exp); } catch {}
            }
          }, 250);
        }

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
              // Playing — seek to the room's expected play head.
              //
              // Important: when this resume was triggered by an app
              // foreground / notification-tray play (`ignorePaused`),
              // we MUST seek unconditionally. Android WebView routinely
              // restarts the YT embed at position=0 after a long
              // background, but the iframe still reports state=1 once
              // it begins playing the silent intro again. The drift
              // check below compares timeline values, not iframe
              // position, so a "playing-from-zero" scenario passes the
              // check and the user hears the track restart from 0 —
              // exactly the bug being fixed here.
              //
              // For the non-foreground path (steady-state resume after
              // user pause), keep the drift threshold so we don't
              // trigger the seek-pause race for tiny drifts.
              if (ignorePaused) {
                // Same anchor-confidence guard as the early seek above.
                const exp = _expectedPosSec();
                if (exp >= 3) {
                  try { _seekIframe(exp); } catch {}
                }
              } else {
                const drift = Math.abs(_expectedPosSec() - targetSec);
                if (drift > 3) {
                  try { _seekIframe(_expectedPosSec()); } catch {}
                }
              }
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
              // On the last couple attempts, also nudge the position —
              // a seekTo can wake a stuck embed that ignored playVideo.
              if (attempts >= 4) {
                setTimeout(() => {
                  if (myToken !== _resumeRetryToken) return;
                  try { _seekIframe(_expectedPosSec()); } catch {}
                }, 200);
              }
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
        // SoundCloud is more deterministic — single play is enough; only
        // seek if drift is meaningful.
        setTimeout(() => {
          if (myToken !== _resumeRetryToken) return;
          if (document.hidden || _paused) return;
          const drift = Math.abs(_expectedPosSec() - targetSec);
          if (drift > 3) { try { _seekIframe(_expectedPosSec()); } catch {} }
        }, 400);
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
              <span class="mp-header-badge">🎵 Music</span>
            </div>
            <div class="mp-header-sub">
              ${cur ? `<span class="mp-live-pulse"></span> Now playing · ${esc(providerLabel)}` : 'Idle · waiting for a track'}
              ${q.length ? ` · ${q.length} track${q.length === 1 ? '' : 's'} in queue` : ''}
              ${cur ? ` · <span id="mp-sync-status" class="mp-sync-hint" data-state="checking" title="Checking your sync to the room's play head…"><span class="mp-sync-dot"></span><span class="mp-sync-text">📻 Checking…</span></span>` : ''}
            </div>
          </div>
        </div>
        ${cur ? `<button class="mp-btn mp-resync" title="Catch up to the room: refreshes the queue from the server and seeks your iframe to the live play-head position"
                         onclick="Music.resyncNow()"><span class="mp-resync-ico">📻</span><span class="mp-resync-lbl">Resync</span></button>` : ''}
      </div>`;

    const nowRow = cur ? `
      <div class="mp-now">
        <div class="mp-art" style="background-image:url('${esc(cur.thumbnail || '')}')"></div>
        <div class="mp-info">
          <div class="mp-title">${esc(cur.title || cur.url)}</div>
          <div class="mp-sub">Queued by ${esc(cur.submitter_nick || '?')} · ${esc(cur.provider)}</div>
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

    const submitHtml = _state.can_submit ? `
      <div class="mp-submit">
        <input id="mp-input" type="text" placeholder="Paste YouTube, Spotify, or SoundCloud link…"
               onkeydown="if(event.key==='Enter')Music.submit()">
        <button class="mp-btn primary" onclick="Music.submit()">Add</button>
        ${_state.can_control ? `
          <label class="mp-dj-toggle" title="${_state.dj_only ? 'DJ-only mode is ON — only DJs can queue' : 'Open mode — anyone can queue'}">
            <input type="checkbox" ${_state.dj_only ? 'checked' : ''} onchange="Music.toggleDJOnly()">
            <span class="mp-dj-track"><span class="mp-dj-knob"></span></span>
            <span class="mp-dj-label">${_state.dj_only ? '🎧 DJ-only' : '👥 Open'}</span>
          </label>` : ''}
      </div>` : `<div class="mp-empty" style="padding:8px">Only DJs may add tracks in this channel.</div>`;

    const queueHtml = upcoming.length ? `
      <div class="mp-queue">
        ${upcoming.map((t, i) => `
          <div class="mp-queue-item" data-tid="${t.id}">
            <span class="mp-queue-idx">${i + 1}.</span>
            <div class="mp-queue-art" style="background-image:url('${esc(t.thumbnail || '')}')"></div>
            <div class="mp-queue-title">${esc(t.title || t.url)}</div>
            <span class="mp-queue-sub">${esc(t.submitter_nick || '')}</span>
            ${(_state.can_control || t.submitter_id === State.user?.id)
              ? `<button class="mp-queue-del" title="Remove" onclick="Music.removeTrack(${t.id})">✕</button>`
              : ''}
          </div>
        `).join('')}
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
      return;
    }

    panel.innerHTML = `
      <div id="mp-player-wrap" data-cur-key="${curKey}">${playerHtml}</div>
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
  }

  async function mount(roomName, channelType) {
    const panel = $('music-panel');
    if (!panel) return;
    // Treat legacy 'voice' channels as music
    const isMusic = channelType === 'music' || channelType === 'voice';
    if (!isMusic) {
      // If we already have a live track for some room, shrink into a mini
      // persistent player instead of tearing down — user wanted music to
      // keep playing while they browse other channels.
      if (_room && _state && (_state.queue || []).length) {
        const cur = _state.queue[0];
        panel.classList.remove('active');
        panel.classList.add('mini');
        panel.style.display = 'flex';
        _renderMini(cur);
        _renderDock(cur);
        // Defensive: any path that pushes fresh HTML for the dock or
        // mini bar resets data-playing="1" / textContent="⏸". Re-sync
        // from effective state so the button reflects YT's actual
        // playback, not the template default.
        try { _syncPlayPauseButtons(); } catch {}
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
    panel.style.display = 'flex';
    document.body.setAttribute('data-music', '1');
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
    const canSkip = !_soloMode && !!(_state && _state.can_control);
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
    dock.innerHTML = `
      <div class="mmd-art ${noArt}" ${art} onclick="Music.expand()" title="${expandTitle}"></div>
      <div class="mmd-info" onclick="Music.expand()">
        <div class="mmd-title" title="${titleEsc}">${titleEsc}</div>
        <div class="mmd-sub">${subInner}</div>
      </div>
      <div class="mmd-ctrls">
        <button class="mmd-btn mmd-play ${canPause ? '' : 'unsupported'}" data-playing="1"
                title="Pause" aria-label="Pause"
                onclick="event.stopPropagation();Music.togglePause(this)">⏸</button>
        ${canSkip ? `<button class="mmd-btn" title="Skip" aria-label="Skip"
                       onclick="event.stopPropagation();Music.skip()">${_SKIP_SVG}</button>` : ''}
        <button class="mmd-btn mmd-close" title="Stop" aria-label="Stop"
                onclick="event.stopPropagation();Music.close()">✕</button>
      </div>`;
    document.body.setAttribute('data-music-mini', '1');
    // Reflect current effective paused state on the freshly-rendered
    // button. The template hardcodes ⏸ for layout simplicity; without
    // this the dock would always show "playing" on re-render even if YT
    // has auto-paused or the user backgrounded the app.
    try { _syncPlayPauseButtons(); } catch {}
  }

  function _miniBarHtml(titleEsc, provider) {
    const canPause = (provider === 'youtube' || provider === 'soundcloud');
    return `
      <span class="mp-mini-title" title="${titleEsc}">🎵 ${titleEsc}</span>
      ${canPause ? `<button class="mp-mini-btn mp-mini-playpause" data-playing="1" title="Pause" onclick="Music.togglePause(this)">⏸</button>` : ''}
      <button class="mp-mini-btn" title="Back to channel" onclick="Music.expand()">⤢</button>
      <button class="mp-mini-btn" title="Stop" onclick="Music.close()">✕</button>`;
  }

  function togglePause(btn) {
    const frame = document.querySelector('#mp-player-wrap iframe.mp-frame');
    if (!frame || !frame.contentWindow) return;
    const playing = btn.dataset.playing !== '0';
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
    // Radio behavior: if the user is un-pausing, catch them up to where the
    // room's play head is right now. Otherwise they'd hear a stale section.
    if (nowPlaying) {
      setTimeout(() => _seekIframe(_expectedPosSec()), 180);
    }
    btn.dataset.playing = nowPlaying ? '1' : '0';
    btn.textContent = nowPlaying ? '⏸' : '▶';
    btn.title = nowPlaying ? 'Pause' : 'Play';
    btn.setAttribute('aria-label', btn.title);
    // Keep every play/pause button in the UI in sync (drawer + mini bar).
    _syncPlayPauseButtons(nowPlaying);
    _paused = !nowPlaying;
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
  }

  function expand() {
    // Solo (FrogSocial) playback: bring the user back to the Social Music tab
    // instead of switching channels.
    if (_soloMode) {
      try {
        if (typeof Social !== 'undefined') {
          if (typeof Social.open === 'function') Social.open();
          if (typeof Social.switchTab === 'function') Social.switchTab('music');
        }
      } catch {}
      return;
    }
    if (_room && typeof Rooms !== 'undefined' && Rooms.switchToRoom) {
      Rooms.switchToRoom(_room, 'music');
      // After the panel re-expands, nudge the iframe back to the live radio position.
      setTimeout(() => { try { _resync(false); } catch(_) {} }, 500);
    }
  }

  function close() {
    _stopSyncProbe();
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
    _emitState();
  }

  // ── Solo playback: plays a single track from FrogSocial (not a channel) ──
  // Reuses the same #music-panel + #music-mini-dock UI the channel player
  // uses, so the track docks to the persistent mini-player just like a
  // normal music-channel track.
  //
  //   Music.playSolo({url, title, provider, thumbnail})
  //
  // If the user is already in a real music channel, we refuse (the channel
  // player is radio-synced and not safe to hijack) — caller should
  // fall back to opening the embed modal or new tab.
  function playSolo(opts) {
    opts = opts || {};
    if (_room && !_soloMode) {
      try { UI.showToast('Already in a music channel — leave first to play here', 'info'); } catch {}
      return false;
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
    };
    // Stash a fake channel state so _renderMini / togglePause / _resync all
    // operate normally. can_control is false so the dock hides the skip btn.
    _soloMode = true;
    _room = null;
    _state = { queue: [track], can_control: false, is_dj: false, position_sec: 0 };
    _setAnchor(track, 0);

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
    _paused = false;
    _muted = false;
    _renderDock(track);
    _emitState();
    return true;
  }

  async function submit() {
    if (!_room) return;
    const inp = $('mp-input');
    const url = (inp?.value || '').trim();
    if (!url) return;
    inp.disabled = true;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(_room)}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!res.ok) { UI.showToast(data.error || 'Failed to add track', 'error'); return; }
      if (inp) inp.value = '';
      // Optimistic refresh — WS will also push
      _state = await _fetchState(_room);
      _render();
    } finally {
      if (inp) inp.disabled = false;
    }
  }

  async function skip() {
    if (!_room) return;
    const res = await fetch(`/api/rooms/${encodeURIComponent(_room)}/queue/skip`, {
      method: 'POST', headers: { 'X-Session-Token': State.token }
    });
    if (res.ok) { _state = await _fetchState(_room); _render(); }
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
        // Queue emptied while minimized — clean up everything.
        close();
      }
    } else {
      _render();
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

  return { mount, submit, skip, clearQueue, removeTrack, toggleDJOnly,
           grantDJ, revokeDJ, isDJ, handleWsEvent, expand, close, togglePause,
           togglePauseGlobal, resumeFromNotification, setNativeMuted, getCurrent,
           resyncNow, shareToWall, playSolo,
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
