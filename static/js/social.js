/**
 * social.js — Instagram-style social profile page, feed, & explore
 */

const Social = (() => {
  let _currentTab = 'feed';     // feed | explore | profile
  let _profileUser = null;       // currently viewed profile nickname
  let _profileData = null;
  let _feedCache = null;
  // Suggested-users payload cache so the feed fast-path can rebuild the
  // suggest strip without hitting the network again.
  let _suggestedCache = null;
  const _exploreCache = new Map();
  // Cache TTL was 20s, which meant any tab the user revisited > 20s
  // after the last load showed a skeleton instead of the cached content
  // — the very thing we cached. We now treat all cached entries as
  // "valid for instant paint" and only use the TTL to decide whether
  // to re-fetch in the background. 5 minutes is plenty for a session.
  const _tabCacheTtlMs = 300000; // 5 min
  // Hard floor on how stale we'll display — in practice everything
  // lives in the LRU map until evicted, so this is just a sanity bound
  // for very long-idle tabs (e.g. user left the app open overnight).
  const _tabCacheStaleCapMs = 24 * 60 * 60 * 1000; // 24 h
  let _activityCache = null;
  const _reelsCache = new Map();
  const _musicCache = new Map();
  const _musicTitleCache = new Map();
  const _musicTitleInflight = new Map();
  const _profileCache = new Map();
  let _tabLoadUiToken = 0;
  let _tabLoadUiWatchdog = null;
  let _reelsLoadToken = 0;
  let _profileTabLoadToken = 0;
  let _profileActiveTab = 'wall';
  const _profilePostsCache = new Map(); // nick → { ts, posts[] } — shared by wall/music/reels/media tabs
  const _profileChannelsCache = new Map(); // nick → { ts, channels[] }
  const _profileRepostsCache = new Map();  // nick → { ts, posts[] }
  let _profilePrefetchRic = 0;             // idle callback handle for profile subtab warming
  let _reelsDirectLaunchId = 0;          // set by openSharedReel to suppress scope-bar flash
  let _bgPrefetchRic = 0;                // handle for pending background cache-warm callback
  const _socialApiTimeoutMs = 12000;     // fail-fast guard so tabs don't appear stuck forever
  let _reactionButtonDelegated = false;
  let _tabLoadUiPulseIndex = 0;

  // ── Bounded cache helpers ────────────────────────────────────────────
  // The original code used .set() directly on a long-lived Map for every
  // distinct sort/scope key. Keys are user-controlled (e.g. {scope:sort}
  // for reels, {nick} for profiles). Without an upper bound a long
  // session — especially when the user clicks through many profiles —
  // grows the Map unboundedly: each entry pins a posts[] which keeps a
  // chain of media URLs / reaction arrays alive. After enough use the
  // page heap gets large enough that GC pauses contribute to the
  // "everything hangs" feel. Cap each Map at 24 entries; on overflow,
  // drop the oldest (Map iteration is insertion-ordered).
  const _CACHE_CAP = 24;
  function _cacheSet(map, key, value) {
    try {
      if (map.has(key)) map.delete(key); // refresh insertion order
      map.set(key, value);
      while (map.size > _CACHE_CAP) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    } catch {
      try { map.set(key, value); } catch {}
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  const esc = s => UI.escHtml(s);
  // Returns a JS string literal safe to embed in an HTML `onclick="..."`
  // attribute. Raw JSON.stringify emits "foo" — the double quotes terminate
  // the attribute early and the browser throws "Unexpected end of input".
  // Encoding them as &quot; leaves valid HTML that decodes back to "foo"
  // before the JS engine parses the handler.
  const jsStr = s => JSON.stringify(String(s || '')).replace(/"/g, '&quot;');
  function _jsonErrorResponse(status, error, extra = {}) {
    return new Response(JSON.stringify({ error, ...extra }), {
      status: Number(status) || 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function _prefetchAllowed() {
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    const c = (typeof navigator !== 'undefined' && navigator.connection) ? navigator.connection : null;
    if (!c) return true;
    if (c.saveData) return false;
    const t = String(c.effectiveType || '').toLowerCase();
    if (t === 'slow-2g' || t === '2g') return false;
    return true;
  }

  // Statuses where a single quick retry has a high chance of succeeding.
  // Real 4xx (401/403/404 etc.) propagate immediately so callers can render
  // the correct UI ("User not found", "Forbidden") instead of looping.
  const _TRANSIENT_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);
  const _attemptApi = async (path, method, body) => {
    try {
      return await Promise.race([
        apiFetch(path, method, body),
        new Promise(resolve => setTimeout(() => resolve(
          _jsonErrorResponse(504, 'Request timed out')
        ), _socialApiTimeoutMs)),
      ]);
    } catch {
      return _jsonErrorResponse(503, 'Network unavailable');
    }
  };
  const api = async (path, method, body) => {
    let res = await _attemptApi(path, method, body);
    // One automatic retry on transient failures so a brief CF/server hiccup
    // doesn't get rendered as "User not found" / "No posts yet" forever.
    if (!res.ok && _TRANSIENT_STATUSES.has(Number(res.status) || 0)) {
      await new Promise(r => setTimeout(r, 350));
      const retry = await _attemptApi(path, method, body);
      // Only swap in the retry if it actually improved things — otherwise
      // keep the original response so error semantics are preserved.
      if (retry.ok || !_TRANSIENT_STATUSES.has(Number(retry.status) || 0)) {
        res = retry;
      } else {
        res = retry;
      }
    }
    if (!res.ok) {
      // Try to parse JSON error, otherwise create a synthetic JSON response
      const clone = res.clone();
      try { await clone.json(); } catch {
        // Response isn't JSON — wrap the text in a JSON-compatible Response
        const text = await res.text();
        return _jsonErrorResponse(res.status, text || 'Server error');
      }
    }
    return res;
  };

  async function _apiOkJson(path, fallback = {}, retryDelayMs = 220) {
    // Resilient fetch helper. Browsers cap concurrent connections to ~6
    // per origin; if a bunch of <video preload=auto> elements are
    // holding sockets open, a single primary fetch can stall for several
    // seconds. The original code bailed after a single 220 ms retry,
    // which meant any sustained tab-pressure → "Retry" error UI. We now
    // retry up to 3 times with growing backoff so transient queueing
    // doesn't surface to the user.
    const delays = [retryDelayMs, retryDelayMs * 3, retryDelayMs * 7];
    let res = null;
    for (let i = 0; i <= delays.length; i++) {
      res = await api(path).catch(() => null);
      if (res && res.ok) return res.json().catch(() => fallback);
      // 4xx (except 408/429) are not retryable.
      const st = Number(res?.status || 0);
      if (st && st >= 400 && st < 500 && st !== 408 && st !== 429) break;
      if (i < delays.length) {
        await new Promise(r => setTimeout(r, delays[i]));
      }
    }
    const err = new Error('request_failed');
    err.status = Number(res?.status || 0);
    throw err;
  }

  // Build a Frog-themed error-state block with a styled Retry button.
  // `retryExpr` is a JS expression (NOT a JS string) — we inject it raw
  // into the onclick handler, so callers must construct it safely
  // (e.g. with esc()/JSON.stringify of nicknames before interpolating).
  function _socialErrorHTML(title, retryExpr, opts = {}) {
    const sub = opts.sub || 'Check your connection and try again.';
    const ico = opts.ico || '⚠️';
    return `
      <div class="social-empty-state">
        <div class="ico" aria-hidden="true">${ico}</div>
        <div class="ttl">${title}</div>
        <div class="sub">${sub}</div>
        <button class="social-retry-btn" onclick="${retryExpr}"><span class="ico">↻</span> Retry</button>
      </div>`;
  }

  function _ensureReactionButtonDelegation() {
    if (_reactionButtonDelegated) return;
    _reactionButtonDelegated = true;
    // Delegate click handling so refreshed/stale cards always open the
    // reactions panel, even if inline handlers were cached/mismatched.
    document.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('.sf-rx-main');
      if (!btn) return;
      const postId = Number(btn.dataset.postId || btn.closest('.sf-post[data-post-id]')?.dataset.postId || 0);
      if (!postId) return;
      showReactPicker(ev, postId);
    });
  }

  function _authMediaSrc(raw) {
    const src = String(raw || '');
    if (!src) return '';
    if (!src.startsWith('/api/social/posts/')) return src;
    const token = String(State?.token || '');
    if (!token) return src;
    try {
      const u = new URL(src, window.location.origin);
      if (!u.searchParams.get('token')) u.searchParams.set('token', token);
      return `${u.pathname}${u.search}${u.hash}`;
    } catch {
      const sep = src.includes('?') ? '&' : '?';
      return `${src}${sep}token=${encodeURIComponent(token)}`;
    }
  }

  // Sibling of _authMediaSrc that rewrites a /media URL to its server-
  // generated /thumb (a single mid-frame JPG cached on disk). Used as
  // the <video poster="..."> attr so the browser shows a representative
  // frame BEFORE any video bytes are downloaded — fixes "all reel
  // previews are black" since the JS canvas-capture path was racing
  // against an unreliable byte-range stream.
  function _authMediaThumb(raw) {
    const src = String(raw || '');
    if (!src.startsWith('/api/social/posts/')) return '';
    const token = String(State?.token || '');
    try {
      const u = new URL(src, window.location.origin);
      // /api/social/posts/{id}/media → /api/social/posts/{id}/thumb
      u.pathname = u.pathname.replace(/\/media$/, '/thumb');
      if (token && !u.searchParams.get('token')) u.searchParams.set('token', token);
      return `${u.pathname}${u.search}${u.hash}`;
    } catch {
      return '';
    }
  }

  let _socialVideoObserverStarted = false;
  let _socialVideoObserverInstance = null;

  // Aggressive cleanup before we replace the innerHTML of a social
  // container. Without this, the old <video> elements keep their open
  // HTTP connections (browsers cap to ~6 per origin) and the GC may not
  // tear them down for many seconds. After 10–15 tab switches the browser
  // runs out of socket slots and every new /api/social/feed fetch stalls
  // until one of the dead videos finally times out — symptom: "the more I
  // use Frog Social the slower it gets, then everything fails to load
  // with a Retry button". Always call this RIGHT BEFORE assigning
  // innerHTML on a content host that may contain <video> or <img>.
  function _disposeMediaIn(node) {
    if (!node) return;
    try {
      node.querySelectorAll('video').forEach(v => {
        try { v.pause(); } catch {}
        try { v.removeAttribute('src'); v.load(); } catch {}
      });
    } catch {}
    try {
      node.querySelectorAll('img').forEach(im => {
        try { im.removeAttribute('src'); } catch {}
      });
    } catch {}
  }

  // Returns true if the poster was drawn (with a non-black frame),
  // false if the call should be retried later. A returned `true` also
  // sets the .ready class on posterEl. We sample a 16-pixel grid of
  // the captured frame and bail if average luma is sub-12 (effectively
  // black) so seek-to-30% on a video with a fade-in doesn't lock in a
  // black thumbnail forever.
  function _drawVideoPoster(video, posterEl) {
    try {
      if (!video || !posterEl || !video.videoWidth || !video.videoHeight) return false;
      const c = document.createElement('canvas');
      const maxW = 720;
      c.width = Math.min(video.videoWidth, maxW);
      c.height = Math.max(1, Math.round(c.width * (video.videoHeight / video.videoWidth)));
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(video, 0, 0, c.width, c.height);
      // Sample a small grid to detect an all-black frame. We only do
      // this for grid tiles (caller passes opts.detectBlack=true);
      // feed posters can stay as-is to avoid extra work.
      try {
        const sx = Math.max(1, Math.floor(c.width / 5));
        const sy = Math.max(1, Math.floor(c.height / 5));
        let lumaSum = 0; let n = 0;
        for (let y = sy; y < c.height; y += sy) {
          for (let x = sx; x < c.width; x += sx) {
            const px = ctx.getImageData(x, y, 1, 1).data;
            // Rec.601 luma
            lumaSum += 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2];
            n++;
          }
        }
        const avgLuma = n ? lumaSum / n : 0;
        if (avgLuma < 12) {
          // Frame is essentially black — leave the poster un-set so the
          // outer fn can try seeking to a different position.
          return false;
        }
      } catch {}
      posterEl.style.backgroundImage = `url(${c.toDataURL('image/jpeg', 0.74)})`;
      posterEl.classList.add('ready');
      return true;
    } catch {}
    return false;
  }

  function _hydrateVideoThumbs(scope) {
    const root = scope || document;
    root.querySelectorAll('.sf-media video, .social-grid-item.is-video video').forEach(video => {
      if (video.dataset.svInit === '1') return;
      video.dataset.svInit = '1';
      const host = video.parentElement;
      if (!host) return;
      host.classList.add('ft-video-host');
      const isGrid = host.classList.contains('social-grid-item') || host.closest('.social-grid-item') != null;

      // Move src → data-mediasrc so the browser doesn't begin
      // downloading until the tile actually scrolls into view. Without
      // this, a single feed paint kicks off N parallel video downloads
      // (preload=metadata still fetches a moov-atom range; preload=auto
      // streams the whole file). With ~6 conn/origin those fights with
      // primary /api/social/feed fetches → "feed loads slow / hangs".
      try {
        const cur = video.getAttribute('src') || '';
        if (cur && !video.dataset.mediasrc) {
          video.dataset.mediasrc = cur;
          video.removeAttribute('src');
          // Avoid an immediate empty-src error event blowing up the row.
          video.preload = 'none';
          try { video.load(); } catch {}
        }
      } catch {}

      let posterDrawn = false;
      // Grid tiles want a *mid-frame* poster, not the t=0 black/intro
      // frame. The browser fires `loadeddata` and `canplay` while
      // currentTime is still 0 — if we draw on those, we lock in a
      // black canvas and then unbind, so the subsequent seek to 30%
      // never gets to render. Gate early draws on grid tiles until the
      // `seeked` event confirms we actually moved past the intro.
      let allowEarlyDraw = !isGrid;
      if (!host.querySelector('.ft-video-poster')) {
        const poster = document.createElement('div');
        poster.className = 'ft-video-poster';
        host.appendChild(poster);
        try { video.removeAttribute('controls'); } catch {}
        try { video.controls = false; } catch {}
        if (host.classList.contains('sf-media')) {
          const play = document.createElement('button');
          play.type = 'button';
          play.className = 'ft-video-play';
          play.setAttribute('aria-label', 'Play video');
          play.textContent = '▶';
          play.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            host.classList.add('is-playing');
            try { video.removeAttribute('controls'); } catch {}
            try { video.controls = false; } catch {}
            try { video.muted = false; } catch {}
            // Ensure src is bound before play (covers the rare case where
            // the user taps before the IntersectionObserver fires).
            _ftVideoBind(video);
            try { video.play().catch(() => {}); } catch {}
          };
          host.appendChild(play);
          video.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (video.paused) {
              host.classList.add('is-playing');
              _ftVideoBind(video);
              video.play().catch(() => {});
            } else {
              video.pause();
            }
          });
        }
        // Grid tiles try a sequence of seek positions until we get a
        // non-black frame. The classic failure mode was: video has a
        // 1–2 second fade-in, our seek to 30% lands inside the fade,
        // _drawVideoPoster captures pure black, the tile never updates.
        // Now: if drawPoster reports the frame was too dark, advance to
        // the next candidate (50%, 70%, 10%, last 0.1s) and try again.
        const _gridSeekFractions = [0.30, 0.50, 0.70, 0.10, 0.92];
        let _seekIdx = 0;
        const drawPoster = () => {
          if (posterDrawn) return;
          if (!allowEarlyDraw) return; // grid: wait for `seeked`
          const ok = _drawVideoPoster(video, poster);
          if (ok) {
            posterDrawn = true;
            // Flag the tile so CSS can fade out the loading shimmer and
            // fade in the corner play badge. Without this the grid
            // tile looks broken (plain black + tiny grey ▶) while the
            // browser is still decoding enough of the MP4 to draw a
            // representative frame.
            try {
              const tile = host.closest('.social-grid-item') || host;
              tile.classList.add('ft-poster-ready');
            } catch {}
            // Grid tiles only ever needed one canvas frame. Release the
            // socket immediately so it doesn't sit there pinned for the
            // life of the page (the grid never auto-plays).
            if (isGrid) {
              try { setTimeout(() => _ftVideoUnbind(video), 60); } catch {}
            }
            return;
          }
          // Grid + frame too dark + we have another seek candidate →
          // advance and let the next `seeked` event re-enter drawPoster.
          if (isGrid && _seekIdx < _gridSeekFractions.length - 1) {
            _seekIdx += 1;
            try {
              const dur = Number(video.duration);
              if (Number.isFinite(dur) && dur > 0.2) {
                const f = _gridSeekFractions[_seekIdx];
                video.currentTime = Math.min(
                  Math.max(0.05, dur * f),
                  Math.max(0.05, dur - 0.05)
                );
              }
            } catch {}
          }
        };
        video.addEventListener('loadeddata', drawPoster, { once: true });
        video.addEventListener('canplay', drawPoster);
        video.addEventListener('seeked', () => {
          // Once we've actually seeked into the file, allow the poster
          // capture (and trigger it now). Subsequent `seeked` events
          // are no-ops because `posterDrawn` will be true.
          allowEarlyDraw = true;
          drawPoster();
        });
        if (isGrid) {
          // Safety net: if the mid-frame seek never lands within 2.5 s
          // (e.g. zero-duration clip, codec quirks, decode failure)
          // fall back to whatever frame the decoder has buffered so the
          // tile isn't permanently a black square.
          setTimeout(() => {
            if (posterDrawn) return;
            allowEarlyDraw = true;
            drawPoster();
            // If even the safety-net draw failed (codec/decode issue),
            // give up the shimmer anyway so the tile doesn't pulse
            // forever — the corner ▶ badge then signals "this is video".
            if (!posterDrawn) {
              try {
                const tile = host.closest('.social-grid-item') || host;
                tile.classList.add('ft-poster-ready');
              } catch {}
            }
          }, 2500);
        }
        video.addEventListener('loadedmetadata', () => {
          try {
            if (!Number.isFinite(video.duration) || video.duration <= 0.2) return;
            if (video.currentTime > 0.05) return;
            // Grid tiles want a *representative* frame — many videos have
            // 1–2 black/fade-in frames at t=0.06s and the resulting
            // poster looks broken. Seek to ~30% (clamped 1–4 s) so the
            // canvas snapshot is something the user actually recognizes.
            // Feed videos keep the early seek so the "Play" overlay
            // doesn't reveal a spoiler frame.
            const dur = video.duration;
            const target = isGrid
              ? Math.min(4, Math.max(1, dur * 0.30))
              : Math.min(0.12, Math.max(0.06, dur / 10));
            video.currentTime = Math.min(target, Math.max(0, dur - 0.05));
          } catch {}
        }, { once: true });
        // For grid tiles we only want a frame snapshot, not the whole
        // file streaming. .ft-poster-only is sniffed in _ftVideoBind.
        if (isGrid) video.classList.add('ft-poster-only');
      }
      video.addEventListener('play', () => host.classList.add('is-playing'));
      video.addEventListener('pause', () => host.classList.remove('is-playing'));
      video.addEventListener('ended', () => host.classList.remove('is-playing'));
      video.addEventListener('pause', () => {
        try { video.removeAttribute('controls'); } catch {}
        try { video.controls = false; } catch {}
      });
      // Register with the lazy IntersectionObserver. It will bind src
      // when the tile enters the viewport, and (for non-playing tiles)
      // unbind when it scrolls offscreen so we reclaim the socket slot.
      _ftLazyObserve(video);
    });
  }

  // ── Lazy video binding (IntersectionObserver) ──────────────────────
  // Concurrency-limited: at most _FT_MAX_ACTIVE_VIDEOS simultaneously
  // bound. Beyond that, queued tiles wait until one is unbound.
  const _FT_MAX_ACTIVE_VIDEOS = 4;
  const _ftActiveVideos = new Set();
  const _ftPendingVideos = new Set();
  let _ftLazyIO = null;
  function _ftEnsureLazyIO() {
    if (_ftLazyIO || typeof IntersectionObserver === 'undefined') return _ftLazyIO;
    _ftLazyIO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const v = e.target;
        if (e.isIntersecting) {
          _ftPendingVideos.add(v);
          _ftPump();
        } else {
          _ftPendingVideos.delete(v);
          // Don't unbind a video the user is actively watching.
          if (!v.paused) continue;
          _ftVideoUnbind(v);
        }
      }
    }, { root: null, rootMargin: '120px', threshold: 0.01 });
    return _ftLazyIO;
  }
  function _ftLazyObserve(video) {
    const io = _ftEnsureLazyIO();
    if (!io) { _ftVideoBind(video); return; }
    try { io.observe(video); } catch {}
  }
  function _ftPump() {
    if (_ftActiveVideos.size >= _FT_MAX_ACTIVE_VIDEOS) return;
    for (const v of _ftPendingVideos) {
      if (_ftActiveVideos.size >= _FT_MAX_ACTIVE_VIDEOS) break;
      _ftPendingVideos.delete(v);
      _ftVideoBind(v);
    }
  }
  function _ftVideoBind(video) {
    if (!video) return;
    const src = video.dataset.mediasrc;
    if (!src) return;
    if (video.getAttribute('src')) {
      _ftActiveVideos.add(video);
      return;
    }
    try {
      // Grid tiles need just enough to capture one frame. Feed videos
      // stay on preload=metadata until the user clicks ▶ (then play()
      // forces a real download).
      video.preload = video.classList.contains('ft-poster-only') ? 'auto' : 'metadata';
      video.setAttribute('src', src);
      video.load();
    } catch {}
    _ftActiveVideos.add(video);
  }
  function _ftVideoUnbind(video) {
    if (!video) return;
    _ftActiveVideos.delete(video);
    try {
      if (video.getAttribute('src')) {
        try { video.pause(); } catch {}
        video.removeAttribute('src');
        video.load();
      }
    } catch {}
    // Refill the active slot.
    _ftPump();
  }

  function _ensureSocialVideoObserver() {
    if (_socialVideoObserverStarted) return;
    _socialVideoObserverStarted = true;
    _hydrateVideoThumbs(document);
    if (typeof MutationObserver === 'undefined' || !document.body) return;
    const overlay = document.getElementById('social-overlay') || document.body;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node && node.nodeType === 1) {
            if (node.matches && (node.matches('.sf-media video') || node.matches('.social-grid-item.is-video video'))) {
              _hydrateVideoThumbs(node.parentElement || node);
            } else if (node.querySelectorAll) {
              _hydrateVideoThumbs(node);
            }
          }
        }
      }
    });
    // Scope the observer to the social overlay only — watching
    // document.body fires for every reaction badge / DM pop / room
    // update across the whole app, which is wasteful and (with
    // subtree:true) walks the entire DOM on every mutation.
    mo.observe(overlay, { childList: true, subtree: true });
    _socialVideoObserverInstance = mo;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    const s = Math.floor((Date.now() - d) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 604800) return Math.floor(s / 86400) + 'd';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // ── open / close ──────────────────────────────────────────────────────
  function open(tab) {
    _ensureReactionButtonDelegation();
    _currentTab = tab || 'feed';
    const overlay = document.getElementById('social-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    renderNav();
    // Paint the persistent "Now playing" strip immediately — it lives in
    // #social-overlay and must reflect current music state on open.
    try { _applyMusicState(); } catch {}
    // Sync the topbar Auto-next pill (and the dock button if mounted) so
    // its on/off state reflects the user's saved preference, not the
    // hard-coded "ON" markup baked into the static HTML.
    try { window.Music && Music._syncAutoNextButtons && Music._syncAutoNextButtons(); } catch {}
    if (_currentTab === 'profile') {
        loadProfile(_profileUser || State.user?.nickname);
    } else if (_currentTab === 'feed') {
        loadFeed();
    } else if (_currentTab === 'explore') {
        loadExplore();
    }
  }

  function close() {
    const overlay = document.getElementById('social-overlay');
    if (overlay) overlay.classList.add('hidden');
    // Drop the foreign-profile ghost nav button so reopening Social
    // doesn't flash a stale "@them" tab from the previous session.
    try { document.getElementById('social-nav-profile-ghost')?.remove(); } catch {}
    // Tear down all the long-lived observers / sockets so closing the
    // social overlay actually frees memory + connection slots.
    try { _socialVideoObserverInstance?.disconnect(); } catch {}
    _socialVideoObserverInstance = null;
    _socialVideoObserverStarted = false;
    try { _ftLazyIO?.disconnect(); } catch {}
    _ftLazyIO = null;
    _ftPendingVideos.clear();
    for (const v of Array.from(_ftActiveVideos)) { try { _ftVideoUnbind(v); } catch {} }
    _ftActiveVideos.clear();
    _cancelBgPrefetch();
  }

  function openProfile(nickname) {
    _profileUser = nickname;
    _currentTab = 'profile';
    open('profile');
  }

  // ── navigation ──────────────────────────────────────────────────────────
  function renderNav() {
    const isOwnProfile = !_profileUser
      || !State.user?.nickname
      || String(_profileUser).toLowerCase() === String(State.user.nickname).toLowerCase();
    const viewingOther = (_currentTab === 'profile' && !isOwnProfile);

    document.querySelectorAll('.social-nav-btn').forEach(b => {
      let isActive = b.dataset.tab === _currentTab;
      // Don't highlight the "My Profile" button when we're viewing
      // someone else's profile — the ghost button below owns the
      // highlight in that case so the nav reads "you are looking at @them".
      if (viewingOther && b.dataset.tab === 'profile') isActive = false;
      b.classList.toggle('active', isActive);
    });

    _renderProfileGhostNav(viewingOther);
  }

  // Ephemeral nav button shown next to "My Profile" while viewing
  // another user's profile. Removed automatically when:
  //   • user switches to any other tab,
  //   • user navigates back to their own profile,
  //   • the social overlay is closed.
  // Clicking the ghost is a no-op (we're already on it); the ✕ on
  // the ghost button (or any other tab) closes the foreign profile by
  // jumping back to the user's own profile.
  function _renderProfileGhostNav(show) {
    const nav = document.querySelector('.social-nav');
    if (!nav) return;
    let ghost = document.getElementById('social-nav-profile-ghost');
    if (!show) {
      if (ghost) ghost.remove();
      return;
    }
    const nick = String(_profileUser || '').trim();
    if (!nick) { if (ghost) ghost.remove(); return; }
    if (!ghost) {
      ghost = document.createElement('button');
      ghost.id = 'social-nav-profile-ghost';
      ghost.className = 'social-nav-btn social-nav-btn-ghost active';
      // Insert immediately AFTER the "My Profile" button so the layout
      // reads: Feed · Explore · Reels · Music · My Profile · @them · 🔔
      const myBtn = nav.querySelector('[data-tab="profile"]');
      if (myBtn && myBtn.nextSibling) nav.insertBefore(ghost, myBtn.nextSibling);
      else nav.appendChild(ghost);
    }
    // Update label and bind handlers every time so the username stays in
    // sync if the user clicks through to another profile from the
    // currently viewed one.
    const safe = nick.replace(/[^A-Za-z0-9_-]/g, '');
    ghost.dataset.tab = '__ghost_profile__';
    ghost.title = `Viewing @${safe} — click ✕ to return to your profile`;
    ghost.innerHTML =
      `<span style="display:inline-flex;align-items:center;gap:6px">` +
        `<span style="opacity:.85">@</span>` +
        `<span>${safe.replace(/[<>&"']/g, '')}</span>` +
        `<span class="ghost-x" style="margin-left:4px;opacity:.7;font-weight:700" aria-label="Close foreign profile">✕</span>` +
      `</span>`;
    ghost.onclick = (ev) => {
      const x = ev.target && ev.target.closest && ev.target.closest('.ghost-x');
      if (x) {
        ev.preventDefault();
        ev.stopPropagation();
        // Jump back to own profile — switchTab() resets _profileUser.
        switchTab('profile');
        return;
      }
      // Clicking the body of the ghost is a no-op (we're already there).
    };
  }

  function switchTab(tab) {
    // Same-tab clicks were re-running the full load pipeline (and
    // re-painting cards, re-binding observers, kicking another bg
    // prefetch). Treat them as a no-op so taps on the active nav button
    // never feel "slow".
    if (_currentTab === tab && tab !== 'profile') {
      renderNav();
      return;
    }
    if (_currentTab === 'reels' && tab !== 'reels') _teardownReels();
    _currentTab = tab;
    try { _syncReelsMusicInterlock(); } catch {}
    // "My Profile" in the top nav should always jump to the logged-in
    // user's own profile — even if we were just viewing someone else.
    if (tab === 'profile') _profileUser = State.user?.nickname || null;
    renderNav();
    if (tab === 'feed') loadFeed();
    else if (tab === 'explore') loadExplore();
    else if (tab === 'reels') loadReelsTab();
    else if (tab === 'music') loadMusicTab();
    else if (tab === 'activity') loadActivity();
    else if (tab === 'profile') loadProfile(_profileUser || State.user?.nickname);
    // Persistent "Now playing" strip lives outside the tab content —
    // make sure it's painted/hidden correctly after switching tabs.
    try { _applyMusicState(); } catch {}
  }

  function _cacheFresh(entry) {
    return !!(entry && (Date.now() - Number(entry.ts || 0) < _tabCacheTtlMs));
  }

  // True if we have *any* usable cached entry to render instantly,
  // even if it's older than the freshness TTL. Used by the
  // stale-while-revalidate paint path so the user never sees a
  // skeleton when we already have content in memory.
  function _cacheUsable(entry) {
    return !!(entry && (Date.now() - Number(entry.ts || 0) < _tabCacheStaleCapMs));
  }

  // ── In-flight load registry ──────────────────────────────────────────
  // Switching tabs while a fetch is in flight used to abort the paint
  // (`if (_currentTab !== 'feed') return`) and the next tab visit would
  // happily start the SAME fetch over again. Coalesce so re-entering a
  // tab that already has a load running just attaches to it.
  const _tabLoadInflight = Object.create(null);
  function _runOnceForTab(tab, fn) {
    if (_tabLoadInflight[tab]) return _tabLoadInflight[tab];
    const p = Promise.resolve()
      .then(fn)
      .finally(() => { delete _tabLoadInflight[tab]; });
    _tabLoadInflight[tab] = p;
    return p;
  }

  function _socialLoadingHtml(label = 'Loading…', tone = 'default', variant = '') {
    const cls = ['social-loading'];
    if (tone === 'reels') cls.push('social-loading-fun', 'is-reels');
    if (tone === 'fun') cls.push('social-loading-fun');
    if (variant === 'compact') cls.push('social-loading-compact');
    return `<div class="${cls.join(' ')}">${esc(label)}</div>`;
  }

  function _commentsSkeletonHtml(count = 3, includeInput = true) {
    const rows = Array.from({ length: count }).map(() => `
      <div class="sf-comment skel-row" aria-hidden="true" style="pointer-events:none">
        <div class="sf-comment-avatar"><div class="skel-circle" style="width:24px;height:24px"></div></div>
        <div class="sf-comment-body">
          <div class="skel-line" style="width:28%;height:10px;margin-bottom:6px"></div>
          <div class="skel-line" style="width:88%;height:10px;margin-bottom:6px"></div>
          <div class="skel-line" style="width:42%;height:9px"></div>
        </div>
      </div>
    `).join('');
    const input = includeInput ? `
      <div class="sf-comment-input skel-row" aria-hidden="true" style="pointer-events:none">
        <div class="skel-line" style="height:34px;border-radius:10px;flex:1"></div>
        <div class="skel-line" style="width:72px;height:34px;border-radius:10px"></div>
      </div>
    ` : '';
    return `<div class="sf-comments-skeleton">${rows}${input}</div>`;
  }

  function _withTimeout(promise, timeoutMs = 3200) {
    return Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  }

  function _beginProfileTabLoad(tab) {
    _profileActiveTab = String(tab || 'wall');
    _profileTabLoadToken += 1;
    return _profileTabLoadToken;
  }

  function _isProfileTabLoadCurrent(tab, token) {
    return _currentTab === 'profile' && _profileActiveTab === String(tab || '') && token === _profileTabLoadToken;
  }

  // Shared posts fetch with per-nickname cache.
  // Wall, music, reels, and public media tabs all hit the same /posts endpoint
  // — caching means switching between them is instant after the first load.
  async function _fetchProfilePostsCached(nickname, loadToken, tabKey) {
    const cacheKey = String(nickname || '').toLowerCase();
    const cached = _profilePostsCache.get(cacheKey);
    if (_cacheFresh(cached)) return cached.posts;
    let res = null;
    for (let i = 0; i < 2; i += 1) {
      res = await api('/api/social/profile/' + encodeURIComponent(nickname) + '/posts').catch(() => null);
      if (!_isProfileTabLoadCurrent(tabKey, loadToken)) return null; // tab switched mid-flight
      if (res && res.ok) break;
      if (i === 0) await new Promise(resolve => setTimeout(resolve, 180));
    }
    if (!res || !res.ok) {
      // Soft-fail to last known data so wall/reels/media tabs don't show hard errors
      // during brief backend/network hiccups.
      if (cached && Array.isArray(cached.posts)) return cached.posts;
      throw new Error('Failed to load posts');
    }
    const data = await res.json().catch(() => ({ posts: [] }));
    const posts = data.posts || [];
    _cacheSet(_profilePostsCache, cacheKey, { ts: Date.now(), posts });
    return posts;
  }

  // Invalidate the profile posts cache (call after post create/delete).
  function _invalidateProfilePostsCache(nickname) {
    _profilePostsCache.delete(String(nickname || '').toLowerCase());
  }

  async function _fetchProfileChannelsCached(nickname, loadToken = null) {
    const cacheKey = String(nickname || '').toLowerCase();
    const cached = _profileChannelsCache.get(cacheKey);
    if (_cacheFresh(cached)) return cached.channels;
    let res = null;
    for (let i = 0; i < 2; i += 1) {
      res = await api('/api/social/profile/' + encodeURIComponent(nickname) + '/channels').catch(() => null);
      if (res && res.ok) break;
      if (i === 0) await new Promise(resolve => setTimeout(resolve, 180));
    }
    if (loadToken != null && !_isProfileTabLoadCurrent('channels', loadToken)) return null;
    if (!res || !res.ok) {
      if (cached && Array.isArray(cached.channels)) return cached.channels;
      throw new Error('Failed to load channels');
    }
    const data = await res.json().catch(() => ({ channels: [] }));
    const channels = data.channels || [];
    _profileChannelsCache.set(cacheKey, { ts: Date.now(), channels });
    return channels;
  }

  async function _fetchProfileRepostsCached(nickname, loadToken = null) {
    const cacheKey = String(nickname || '').toLowerCase();
    const cached = _profileRepostsCache.get(cacheKey);
    if (_cacheFresh(cached)) return cached.posts;
    let res = null;
    for (let i = 0; i < 2; i += 1) {
      res = await api('/api/social/profile/' + encodeURIComponent(nickname) + '/reposts').catch(() => null);
      if (res && res.ok) break;
      if (i === 0) await new Promise(resolve => setTimeout(resolve, 180));
    }
    if (loadToken != null && !_isProfileTabLoadCurrent('reposts', loadToken)) return null;
    if (!res || !res.ok) {
      if (cached && Array.isArray(cached.posts)) return cached.posts;
      throw new Error('Failed to load reposts');
    }
    const data = await res.json().catch(() => ({ posts: [] }));
    const posts = data.posts || [];
    _cacheSet(_profileRepostsCache, cacheKey, { ts: Date.now(), posts });
    return posts;
  }

  function _schedProfilePrefetch(nickname, isSelf) {
    if (_profilePrefetchRic) {
      try { cancelIdleCallback(_profilePrefetchRic); } catch { clearTimeout(_profilePrefetchRic); }
      _profilePrefetchRic = 0;
    }
    const nick = String(nickname || '').trim();
    if (!nick) return;
    if (!_prefetchAllowed()) return;

    const run = async () => {
      _profilePrefetchRic = 0;
      const key = nick.toLowerCase();
      const jobs = [];
      if (!_cacheFresh(_profilePostsCache.get(key))) {
        jobs.push(_withTimeout(
          api('/api/social/profile/' + encodeURIComponent(nick) + '/posts')
            .then(r => r && r.ok ? r.json().catch(() => ({ posts: [] })) : null)
            .then(data => {
              if (data && Array.isArray(data.posts)) {
                _cacheSet(_profilePostsCache, key, { ts: Date.now(), posts: data.posts });
              }
            })
            .catch(() => null)
        ));
      }
      if (!_cacheFresh(_profileChannelsCache.get(key))) {
        jobs.push(_withTimeout(_fetchProfileChannelsCached(nick).catch(() => null)));
      }
      if (!_cacheFresh(_profileRepostsCache.get(key)) && isSelf) {
        jobs.push(_withTimeout(_fetchProfileRepostsCached(nick).catch(() => null)));
      }
      if (jobs.length) await Promise.allSettled(jobs);
    };

    try {
      _profilePrefetchRic = requestIdleCallback(run, { timeout: 1200 });
    } catch {
      _profilePrefetchRic = setTimeout(run, 140);
    }
  }

  // Per-tab skeleton helpers for profile sub-tabs.
  function _spGridSkeletonHtml(count = 6) {
    return `<div class="social-grid">${Array.from({ length: count }).map(() =>
      `<div class="social-grid-item" style="pointer-events:none;min-height:120px;aspect-ratio:9/14"><div class="skel-block" style="height:100%;min-height:120px;border-radius:0"></div></div>`
    ).join('')}</div>`;
  }

  function _spChannelsSkeletonHtml(count = 3) {
    return `<div class="sp-channels-list">${Array.from({ length: count }).map(() => `
      <div class="sp-channel-card skel-row" style="pointer-events:none">
        <div class="skel-circle" style="width:46px;height:46px;flex-shrink:0"></div>
        <div style="flex:1;min-width:0">
          <div class="skel-line" style="width:42%;height:12px;margin-bottom:7px"></div>
          <div class="skel-line" style="width:62%;height:10px;margin-bottom:5px"></div>
          <div class="skel-line" style="width:36%;height:9px"></div>
        </div>
      </div>
    `).join('')}</div>`;
  }

  // ── Background tab cache warming ──────────────────────────────────────
  // After any main-tab load completes, prime the other tabs' caches during
  // browser idle time so the next switch renders instantly from memory.
  function _cancelBgPrefetch() {
    if (!_bgPrefetchRic) return;
    try { cancelIdleCallback(_bgPrefetchRic); } catch { clearTimeout(_bgPrefetchRic); }
    _bgPrefetchRic = 0;
  }

  function _schedBgPrefetch(excludeTab) {
    _cancelBgPrefetch();
    if (!_prefetchAllowed()) return;
    const cb = () => { _bgPrefetchRic = 0; _doBgPrefetch(excludeTab); };
    // Tighter deadline (was 6 s) so other tabs are warm by the time the
    // user reaches for the nav. The fan-out itself runs in parallel
    // (see _doBgPrefetch), so the work is small.
    try {
      _bgPrefetchRic = requestIdleCallback(cb, { timeout: 1500 });
    } catch {
      _bgPrefetchRic = setTimeout(cb, 400);
    }
  }

  async function _doBgPrefetch(excludeTab) {
    if (!State?.user) return;
    // Guard: never run a fan-out concurrently with itself. With 6 call
    // sites (one per tab swap) it was easy for a slow user-network to
    // stack 3-4 prefetch waves on top of the primary fetch and saturate
    // the browser's 6-conn-per-origin pool \u2192 primary /feed stalls \u2192
    // _apiOkJson trips its retries \u2192 user sees "Retry" UI for no reason.
    if (_doBgPrefetch._busy) return;
    _doBgPrefetch._busy = true;
    // Fan out the 4 cache-warm fetches in parallel. They were
    // sequential awaits before, which on a 200 ms RTT meant the last
    // tab (music) wasn't warm for ~800 ms after the primary load —
    // long enough for the user to beat the prefetch and see a
    // skeleton. The browser's 6-conn budget can absorb 4 concurrent
    // small requests easily; the _busy guard above still prevents
    // overlapping waves.
    const jobs = [];
    if (excludeTab !== 'feed' && !_cacheFresh(_feedCache)) {
      jobs.push((async () => {
        const r = await api('/api/social/feed?lite=1&limit=24').catch(() => null);
        if (r && r.ok) {
          const d = await r.json().catch(() => ({}));
          if (Array.isArray(d.posts)) _feedCache = { ts: Date.now(), posts: d.posts };
        }
      })());
    }
    {
      const _expKey = _exploreSort || 'trending';
      if (excludeTab !== 'explore' && !_cacheFresh(_exploreCache.get(_expKey))) {
        jobs.push((async () => {
          // Warm posts and channels in parallel so a cache-hit on the
          // explore tab paints the channels strip too — not just posts.
          const [postsRes, chRes] = await Promise.all([
            api(`/api/social/explore?lite=1&sort=${encodeURIComponent(_expKey)}&limit=24`).catch(() => null),
            api('/api/directory/new').catch(() => null),
          ]);
          let posts = null, channels = [];
          if (postsRes && postsRes.ok) {
            const d = await postsRes.json().catch(() => ({}));
            if (Array.isArray(d.posts)) posts = d.posts;
          }
          if (chRes && chRes.ok) {
            const d = await chRes.json().catch(() => ({}));
            if (Array.isArray(d.channels)) channels = d.channels;
          }
          if (posts) _cacheSet(_exploreCache, _expKey, { ts: Date.now(), posts, channels });
        })());
      }
    }
    {
      const _rrKey = `${_reelsScope}:${_reelsSort}`;
      if (excludeTab !== 'reels' && !_cacheFresh(_reelsCache.get(_rrKey))) {
        jobs.push((async () => {
          const r = await api(`/api/social/reels?scope=${encodeURIComponent(_reelsScope)}&sort=${encodeURIComponent(_reelsSort)}&limit=12`).catch(() => null);
          if (r && r.ok) {
            const d = await r.json().catch(() => ({}));
            if (Array.isArray(d.posts)) _cacheSet(_reelsCache, _rrKey, { ts: Date.now(), posts: d.posts });
          }
        })());
      }
    }
    {
      const _mKey = `${_musicTabScope}:${_musicTabSort}:`;
      if (excludeTab !== 'music' && !_cacheFresh(_musicCache.get(_mKey))) {
        jobs.push((async () => {
          const url = _musicTabScope === 'explore'
            ? `/api/social/explore?lite=1&limit=40&sort=${encodeURIComponent(_musicTabSort)}`
            : '/api/social/feed?lite=1&limit=40';
          const r = await api(url).catch(() => null);
          if (r && r.ok) {
            const d = await r.json().catch(() => ({}));
            if (Array.isArray(d.posts)) _cacheSet(_musicCache, _mKey, { ts: Date.now(), posts: d.posts });
          }
        })());
      }
    }
    // Suggested-users strip is also rendered on feed but cached
    // separately; warming it removes the only remaining network hop
    // when the user re-enters feed.
    if (excludeTab !== 'feed' && !_cacheFresh(_suggestedCache)) {
      jobs.push((async () => {
        const r = await api('/api/social/suggested').catch(() => null);
        if (r && r.ok) {
          const d = await r.json().catch(() => ({}));
          if (Array.isArray(d.users)) _suggestedCache = { ts: Date.now(), users: d.users };
        }
      })());
    }
    try {
      await Promise.allSettled(jobs);
    } finally {
      _doBgPrefetch._busy = false;
    }
  }

  function _setTabLoadUi(tab, percent, label, detail) {
    const overlay = document.getElementById('social-overlay');
    if (!overlay) return;
    let el = document.getElementById('social-load-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'social-load-banner';
      el.innerHTML = `
        <div class="slb-head">
          <span class="slb-title"></span>
          <span class="slb-pct"></span>
        </div>
        <div class="slb-detail"></div>
        <div class="slb-track"><span class="slb-fill"></span></div>`;
      overlay.appendChild(el);
    }
    const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    const nextLabel = label || 'Loading';
    const nextDetail = detail || 'Preparing content…';
    const prevPct = Number(el.dataset.pct || -1);
    const prevLabel = el.dataset.label || '';
    const prevDetail = el.dataset.detail || '';
    const changed = pct !== prevPct || nextLabel !== prevLabel || nextDetail !== prevDetail;
    el.dataset.tab = String(tab || '');
    el.classList.remove('done');
    el.classList.add('show');
    const titleEl = el.querySelector('.slb-title');
    const pctEl = el.querySelector('.slb-pct');
    const detailEl = el.querySelector('.slb-detail');
    const fillEl = el.querySelector('.slb-fill');
    if (titleEl) titleEl.textContent = nextLabel;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (detailEl) detailEl.textContent = nextDetail;
    if (fillEl) fillEl.style.width = `${pct}%`;
    el.dataset.pct = String(pct);
    el.dataset.label = nextLabel;
    el.dataset.detail = nextDetail;

    if (changed) {
      el.classList.remove('step');
      if (el._stepTimer) clearTimeout(el._stepTimer);
      requestAnimationFrame(() => {
        el.classList.add('step');
        el._stepTimer = setTimeout(() => {
          el.classList.remove('step');
        }, 280);
      });
    }
  }

  function _beginTabLoadUi(tab, label, detail) {
    if (_tabLoadUiWatchdog) {
      clearTimeout(_tabLoadUiWatchdog);
      _tabLoadUiWatchdog = null;
    }
    const token = ++_tabLoadUiToken;
    _setTabLoadUi(tab, 8, label, detail || 'Preparing content…');
    _tabLoadUiPulseIndex = 0;

    const pulseHints = {
      feed: [
        'Downloading newest posts…',
        'Hydrating story and suggestion blocks…',
        'Finalizing feed cards…',
      ],
      explore: [
        'Downloading ranked explore posts…',
        'Resolving channels and previews…',
        'Finalizing explore layout…',
      ],
      music: [
        'Downloading music shares…',
        'Filtering tracks and moods…',
        'Finalizing playlist layout…',
      ],
      reels: [
        'Downloading reels and metadata…',
        'Preparing autoplay and snap state…',
        'Finalizing reel stage…',
      ],
    };

    const pulse = () => {
      if (token !== _tabLoadUiToken) return;
      const el = document.getElementById('social-load-banner');
      if (!el || !el.classList.contains('show')) return;
      const activeTab = String(el.dataset.tab || tab || _currentTab || 'feed');
      const curPct = Math.max(8, Number(el.dataset.pct || 8));
      if (curPct >= 98) {
        _tabLoadUiWatchdog = setTimeout(pulse, 2200);
        return;
      }
      const nextPct = Math.min(97, curPct + (curPct < 70 ? 4 : (curPct < 88 ? 2 : 1)));
      const hints = pulseHints[activeTab] || pulseHints.feed;
      const hint = hints[_tabLoadUiPulseIndex % hints.length];
      _tabLoadUiPulseIndex += 1;
      _setTabLoadUi(activeTab, nextPct, el.dataset.label || 'Loading', hint);
      _tabLoadUiWatchdog = setTimeout(pulse, 2200);
    };

    _tabLoadUiWatchdog = setTimeout(pulse, 2600);
    return token;
  }

  function _updateTabLoadUi(token, percent, label, detail) {
    if (token !== _tabLoadUiToken) return;
    _setTabLoadUi(_currentTab, percent, label, detail);
  }

  function _finishTabLoadUi(token) {
    if (token !== _tabLoadUiToken) return;
    if (_tabLoadUiWatchdog) {
      clearTimeout(_tabLoadUiWatchdog);
      _tabLoadUiWatchdog = null;
    }
    _setTabLoadUi(_currentTab, 100, 'Loaded', 'Ready');
    const doneToken = token;
    setTimeout(() => {
      if (doneToken !== _tabLoadUiToken) return;
      const el = document.getElementById('social-load-banner');
      if (!el) return;
      el.classList.add('done');
      setTimeout(() => {
        if (doneToken !== _tabLoadUiToken) return;
        el.classList.remove('show');
      }, 220);
    }, 80);
  }

  function _socialPostSkeletonCards(count = 3) {
    return Array.from({ length: count }).map(() => `
      <div class="sf-post skel-row" aria-hidden="true" style="pointer-events:none">
        <div class="sf-post-header">
          <div class="skel-circle" style="width:36px;height:36px"></div>
          <div style="flex:1;min-width:0">
            <div class="skel-line" style="width:34%;height:11px;margin-bottom:6px"></div>
            <div class="skel-line" style="width:22%;height:9px"></div>
          </div>
        </div>
        <div style="padding:0 14px 10px">
          <div class="skel-line" style="width:92%;height:10px;margin-bottom:6px"></div>
          <div class="skel-line" style="width:68%;height:10px"></div>
        </div>
        <div class="skel-block" style="height:180px;margin:0 14px 10px;border-radius:12px"></div>
        <div style="display:flex;gap:8px;padding:0 14px 12px">
          <div class="skel-line" style="width:58px;height:20px;border-radius:10px"></div>
          <div class="skel-line" style="width:58px;height:20px;border-radius:10px"></div>
          <div class="skel-line" style="width:58px;height:20px;border-radius:10px"></div>
        </div>
      </div>
    `).join('');
  }

  function _feedSkeletonHtml() {
    return `
      <div id="social-feed-stories">
        <div class="stories-bar" aria-hidden="true">
          <div class="stories-scroll">
            ${Array.from({ length: 5 }).map(() => `
              <div class="story-circle" style="pointer-events:none">
                <div class="story-avatar-ring viewed"><div class="story-avatar skel-circle" style="width:56px;height:56px"></div></div>
                <span class="story-nick"><span class="skel-line" style="display:inline-block;width:46px;height:9px"></span></span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
      <div id="social-feed-suggest"></div>
      <div class="social-feed">${_socialPostSkeletonCards(3)}</div>
    `;
  }

  function _exploreSkeletonHtml() {
    return `
      <div class="explore-toolbar is-skeleton" aria-hidden="true">
        <div class="explore-tabs">
          <span class="explore-tab is-skeleton-chip">🔥 Trending</span>
          <span class="explore-tab is-skeleton-chip">🆕 New</span>
          <span class="explore-tab is-skeleton-chip">⭐ Top</span>
        </div>
        <span class="explore-refresh is-skeleton-chip" title="Refresh">🔄</span>
      </div>
      <div class="social-grid" aria-hidden="true">
        ${Array.from({ length: 6 }).map(() => `<div class="social-grid-item" style="pointer-events:none"><div class="skel-block" style="height:100%;min-height:120px;border-radius:0"></div></div>`).join('')}
      </div>
      <div class="social-feed">${_socialPostSkeletonCards(2)}</div>
    `;
  }

  function _reelsSkeletonHtml(scope, sort) {
    return `
      <div class="reels-scope-bar is-skeleton" aria-hidden="true">
        <span class="rsb-pill is-skeleton-chip">🌐 All</span>
        <span class="rsb-pill is-skeleton-chip">👥 Friends</span>
        <div class="rsb-sort">
          <span class="rsb-sort-chip is-skeleton-chip">🔥 Hot</span>
          <span class="rsb-sort-chip is-skeleton-chip">🆕 New</span>
          <span class="rsb-sort-chip is-skeleton-chip">⭐ Top</span>
        </div>
      </div>
      <div class="reels-stage">
        <div class="reels-snap" aria-hidden="true" style="gap:14px">
          ${Array.from({ length: 3 }).map(() => `
            <div class="reel-card" style="pointer-events:none">
              <div class="skel-block" style="height:100%;border-radius:14px"></div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function _musicSkeletonHtml(scope, sort) {
    return `
      <div class="music-scope-bar is-skeleton" aria-hidden="true">
        <div class="msb-toggle">
          <span class="msb-seg is-skeleton-chip">
            <span class="msb-seg-ico">👥</span><span>Following</span>
          </span>
          <span class="msb-seg is-skeleton-chip">
            <span class="msb-seg-ico">🌐</span><span>Explore</span>
          </span>
        </div>
        ${scope==='explore' ? `
          <div class="msb-sort">
            <span class="msb-sort-chip is-skeleton-chip">🆕 New</span>
            <span class="msb-sort-chip is-skeleton-chip">🔥 Trending</span>
            <span class="msb-sort-chip is-skeleton-chip">⭐ Top</span>
          </div>
        ` : ''}
      </div>
      <div class="social-feed">${_socialPostSkeletonCards(3)}</div>
    `;
  }

  function _animateSocialSwap(el) {
    if (!el) return;
    try { el.classList.remove('social-content-enter'); } catch {}
    requestAnimationFrame(() => {
      try { el.classList.add('social-content-enter'); } catch {}
    });
  }

  // ── STORIES ──────────────────────────────────────────────────────────────
  let _storyData = [];   // [{user_id, nickname, avatar, stories:[], has_unviewed}]
  let _storyViewIdx = 0; // index in current user's stories array
  let _storyUserIdx = 0; // index in _storyData
  const _storyViewerCache = new Map();
  const _storyMediaCache = new Map(); // story_id -> { media_data, media_type }
  const _storyMediaInflight = new Map(); // story_id -> Promise

  function _fetchStoryMedia(storyId) {
    if (!storyId) return Promise.resolve(null);
    if (_storyMediaCache.has(storyId)) return Promise.resolve(_storyMediaCache.get(storyId));
    if (_storyMediaInflight.has(storyId)) return _storyMediaInflight.get(storyId);
    const p = (async () => {
      try {
        const res = await api(`/api/social/stories/${storyId}/media`);
        if (!res.ok) return null;
        const data = await res.json();
        const v = { media_data: data.media_data, media_type: data.media_type };
        _storyMediaCache.set(storyId, v);
        return v;
      } catch { return null; }
      finally { _storyMediaInflight.delete(storyId); }
    })();
    _storyMediaInflight.set(storyId, p);
    return p;
  }
  function _prefetchAdjacentStoryMedia() {
    const user = _storyData[_storyUserIdx]; if (!user) return;
    const next = user.stories[_storyViewIdx + 1];
    if (next && next.has_media && !next.media_data) _fetchStoryMedia(next.id);
    // also peek the first story of the next user
    const nu = _storyData[_storyUserIdx + 1];
    if (nu && nu.stories && nu.stories[0] && nu.stories[0].has_media && !nu.stories[0].media_data) {
      _fetchStoryMedia(nu.stories[0].id);
    }
  }

  async function loadStoriesBar() {
    try {
      const res = await api('/api/social/stories');
      const data = await res.json();
      _storyData = data.users || [];
    } catch { _storyData = []; }
    return renderStoriesBar();
  }

  function renderStoriesBar() {
    if (_storyData.length === 0 && !State.user) return '';
    const myStory = _storyData.find(u => u.user_id === State.user?.id);
    let html = '<div class="stories-bar"><div class="stories-scroll">';
    // "Add story" circle
    html += `<div class="story-circle add-story" onclick="Social.openAddStory()">
      <div class="story-avatar-ring">
        <div class="story-avatar">${UI.avatarEl(State.user?.avatar, State.user?.nickname, 56)}</div>
        <div class="story-add-badge">+</div>
      </div>
      <span class="story-nick">Your story</span>
    </div>`;
    for (let i = 0; i < _storyData.length; i++) {
      const u = _storyData[i];
      if (u.user_id === State.user?.id && u.stories.length > 0) {
        // show own story ring (viewed style)
        continue; // already shown as "Your story"
      }
      html += `<div class="story-circle" onclick="Social.viewStories(${i})">
        <div class="story-avatar-ring ${u.has_unviewed ? 'unviewed' : 'viewed'}">
          <div class="story-avatar">${UI.avatarEl(u.avatar, u.nickname, 56)}</div>
        </div>
        <span class="story-nick">${esc(u.nickname)}</span>
      </div>`;
    }
    html += '</div></div>';
    return html;
  }

  function viewStories(userIdx) {
    _storyUserIdx = userIdx;
    _storyViewIdx = 0;
    // Find first unviewed
    const stories = _storyData[userIdx]?.stories || [];
    for (let i = 0; i < stories.length; i++) {
      if (!stories[i].viewed) { _storyViewIdx = i; break; }
    }
    showStoryViewer();
  }

  function _recomputeUserStorySeenState(user) {
    if (!user || !Array.isArray(user.stories)) return;
    user.has_unviewed = user.stories.some(s => !s.viewed);
  }

  function _rerenderStoriesBarInDom() {
    try {
      const host = document.getElementById('social-content');
      if (!host) return;
      const oldBar = host.querySelector('.stories-bar');
      if (!oldBar) return;
      const wrap = document.createElement('div');
      wrap.innerHTML = renderStoriesBar();
      const newBar = wrap.firstElementChild;
      if (!newBar) return;
      oldBar.replaceWith(newBar);
    } catch {}
  }

  function _setProfileRingViewedStateForUser(nickname, hasUnviewed) {
    try {
      if (!nickname || _currentTab !== 'profile' || _profileUser !== nickname) return;
      const avatar = document.querySelector('.social-profile .sp-avatar');
      if (!avatar) return;
      if (!avatar.classList.contains('has-story')) return;
      avatar.classList.toggle('unviewed', !!hasUnviewed);
      avatar.classList.toggle('viewed', !hasUnviewed);
    } catch {}
  }

  function _renderStoryViewerMeta(story, user) {
    const isMine = Number(user?.user_id) === Number(State.user?.id);
    if (!isMine) return '';
    const cached = _storyViewerCache.get(story.id);
    if (!cached) {
      return `<div class="story-viewers-meta" id="story-viewers-meta">Loading views…</div>`;
    }
    const viewers = cached.viewers || [];
    if (viewers.length === 0) {
      return `<div class="story-viewers-meta" id="story-viewers-meta">No views yet</div>`;
    }
    const top = viewers.slice(0, 6);
    const chips = top.map(v =>
      `<div class="story-view-chip" title="${esc(v.nickname || '')}">${UI.avatarEl(v.avatar, v.nickname, 24)}</div>`
    ).join('');
    const more = viewers.length > 6 ? `<span class="story-view-more">+${viewers.length - 6}</span>` : '';
    return `<div class="story-viewers-meta" id="story-viewers-meta">
      <div class="story-view-chips">${chips}${more}</div>
      <span class="story-view-count">${viewers.length} viewed</span>
    </div>`;
  }

  async function _hydrateStoryViewers(story, user) {
    const isMine = Number(user?.user_id) === Number(State.user?.id);
    if (!isMine || !story?.id || _storyViewerCache.has(story.id)) return;
    try {
      const res = await api(`/api/social/stories/${story.id}/viewers`);
      const data = await res.json();
      _storyViewerCache.set(story.id, { viewers: data.viewers || [] });
      const meta = document.getElementById('story-viewers-meta');
      if (meta && document.getElementById('story-viewer')) {
        meta.outerHTML = _renderStoryViewerMeta(story, user);
      }
    } catch {
      const meta = document.getElementById('story-viewers-meta');
      if (meta) meta.textContent = 'Could not load views';
    }
  }

  function showStoryViewer() {
    const user = _storyData[_storyUserIdx];
    if (!user) return closeStoryViewer();
    const story = user.stories[_storyViewIdx];
    if (!story) return closeStoryViewer();

    // Mark viewed
    if (!story.viewed) {
      api(`/api/social/stories/${story.id}/view`, 'POST');
      story.viewed = true;
      _recomputeUserStorySeenState(user);
      _setProfileRingViewedStateForUser(user.nickname, !!user.has_unviewed);
      _rerenderStoriesBarInDom();
    }

    let viewer = document.getElementById('story-viewer');
    if (!viewer) {
      viewer = document.createElement('div');
      viewer.id = 'story-viewer';
      document.body.appendChild(viewer);
    }
    // CRITICAL: cancel any pending auto-advance from a previous story
    // before we rebuild. Without this, a manually-triggered nextStory()
    // can leave the previous story's setTimeout pending; if it fires
    // while the new story is still loading, the user gets jumped past
    // the story they just opened. Mirror this in any callback paths.
    clearTimeout(viewer._timer);
    viewer._timer = null;
    // Stop any currently-playing media before we replace innerHTML so a
    // half-loaded video doesn't keep emitting audio mid-transition.
    viewer.querySelectorAll('video, audio').forEach(el => {
      try { el.pause(); } catch {}
    });

    const isLoading = !story.media_data && story.has_media;
    const progress = user.stories.map((s, i) => {
      const cls = i < _storyViewIdx ? 'done' : i === _storyViewIdx ? (isLoading ? 'loading' : 'active') : '';
      return `<div class="story-prog-seg ${cls}"><div class="story-prog-fill"></div></div>`;
    }).join('');

    viewer.innerHTML = `
      <div class="story-viewer-inner" onclick="Social.nextStory()">
        <div class="story-progress">${progress}</div>
        <div class="story-header">
          <div class="story-header-avatar">${UI.avatarEl(user.avatar, user.nickname, 32)}</div>
          <span class="story-header-nick" onclick="event.stopPropagation();Social.openStoryProfileFromViewer('${esc(user.nickname)}')" style="cursor:pointer" title="Open profile">${esc(user.nickname)}</span>
          <span class="story-header-time">${timeAgo(story.created_at)}</span>
          <button class="story-close" onclick="event.stopPropagation();Social.closeStoryViewer()">✕</button>
        </div>
        <div class="story-media" id="story-media-slot">
          ${story.media_data
            ? (story.media_type.startsWith('video')
                ? `<video src="${esc(story.media_data)}" autoplay playsinline></video>`
                : `<img src="${esc(story.media_data)}" alt="">`)
            : '<div class="story-media-loading" style="color:#888;font-size:13px">Loading…</div>'}
        </div>
        ${story.caption ? `<div class="story-caption">${esc(story.caption)}</div>` : ''}
        ${_renderStoryViewerMeta(story, user)}
        <div class="story-nav-zones">
          <div class="story-nav-left" onclick="event.stopPropagation();Social.prevStory()"></div>
          <div class="story-nav-right" onclick="event.stopPropagation();Social.nextStory()"></div>
        </div>
      </div>`;
    viewer.style.display = 'flex';

    // Lazy-load full media if the feed payload only had `has_media`.
    // While loading, the auto-advance timer and the active progress-bar
    // animation are both held back so the user gets a full view window
    // once the media actually arrives.
    const startProgressAndTimer = () => {
      const segs = viewer.querySelectorAll('.story-prog-seg');
      const seg = segs[_storyViewIdx];
      const isVideo = (story.media_type || '').startsWith('video');
      const videoEl = viewer.querySelector('#story-media-slot video');

      if (isVideo && videoEl) {
        // Drive the segment from the actual video. No fixed timer — advance
        // when the video ends. The fill is updated each rAF to track currentTime.
        if (seg) {
          const fresh = seg.cloneNode(true);
          fresh.classList.remove('loading', 'timed');
          fresh.classList.add('active');
          seg.parentNode.replaceChild(fresh, seg);
          const fill = fresh.querySelector('.story-prog-fill');
          const myIdx = _storyViewIdx, myUserIdx = _storyUserIdx;
          const tick = () => {
            if (myIdx !== _storyViewIdx || myUserIdx !== _storyUserIdx) return;
            if (!videoEl.isConnected) return;
            const dur = videoEl.duration;
            if (dur && isFinite(dur) && dur > 0) {
              const pct = Math.min(1, Math.max(0, videoEl.currentTime / dur));
              if (fill) fill.style.transform = 'scaleX(' + pct.toFixed(4) + ')';
            }
            if (!videoEl.paused && !videoEl.ended) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
        // Belt-and-braces fallback ONLY for the case where metadata never
        // loads (otherwise we use loadedmetadata + ended). Generous so we
        // never cut off a real video; if `ended` fires first this is moot.
        clearTimeout(viewer._timer);
        viewer._timer = setTimeout(() => nextStory(), 60000);
        videoEl.addEventListener('loadedmetadata', () => {
          const d = videoEl.duration;
          if (d && isFinite(d) && d > 0) {
            // Set a per-video safety net at duration + 1s so a glitched
            // `ended` event still advances the viewer, but we never cut
            // a video short.
            clearTimeout(viewer._timer);
            viewer._timer = setTimeout(() => nextStory(), Math.max(1500, d * 1000 + 1000));
          }
        }, { once: true });
        videoEl.addEventListener('ended', () => {
          clearTimeout(viewer._timer);
          nextStory();
        }, { once: true });
        try { videoEl.play().catch(() => {}); } catch {}
      } else {
        // Photo: 5s fixed timer with the CSS keyframe fill.
        if (seg) {
          const fresh = seg.cloneNode(true);
          fresh.classList.remove('loading');
          fresh.classList.add('active', 'timed');
          seg.parentNode.replaceChild(fresh, seg);
        }
        clearTimeout(viewer._timer);
        viewer._timer = setTimeout(() => nextStory(), 5000);
      }
    };
    if (!story.media_data && story.has_media) {
      const myIdx = _storyViewIdx, myUserIdx = _storyUserIdx;
      _fetchStoryMedia(story.id).then(m => {
        if (!m || !m.media_data) {
          // Couldn't load — don't strand the viewer; advance after a short beat.
          if (myIdx === _storyViewIdx && myUserIdx === _storyUserIdx) {
            clearTimeout(viewer._timer);
            viewer._timer = setTimeout(() => nextStory(), 1500);
          }
          return;
        }
        // Cache on the story object so re-opens are instant.
        story.media_data = m.media_data;
        story.media_type = m.media_type || story.media_type;
        // Only update DOM if the user is still on this exact story.
        if (myIdx !== _storyViewIdx || myUserIdx !== _storyUserIdx) return;
        const slot = document.getElementById('story-media-slot');
        if (!slot) return;
        slot.innerHTML = (story.media_type || '').startsWith('video')
          ? `<video src="${esc(story.media_data)}" autoplay playsinline></video>`
          : `<img src="${esc(story.media_data)}" alt="">`;
        startProgressAndTimer();
      });
    } else {
      startProgressAndTimer();
    }
    _prefetchAdjacentStoryMedia();
    _hydrateStoryViewers(story, user);
  }

  function nextStory() {
    const user = _storyData[_storyUserIdx];
    if (!user) return closeStoryViewer();
    if (_storyViewIdx < user.stories.length - 1) {
      _storyViewIdx++;
      showStoryViewer();
    } else if (_storyUserIdx < _storyData.length - 1) {
      _storyUserIdx++;
      _storyViewIdx = 0;
      showStoryViewer();
    } else {
      closeStoryViewer();
    }
  }

  function prevStory() {
    if (_storyViewIdx > 0) { _storyViewIdx--; showStoryViewer(); }
    else if (_storyUserIdx > 0) {
      _storyUserIdx--;
      _storyViewIdx = _storyData[_storyUserIdx].stories.length - 1;
      showStoryViewer();
    }
  }

  function closeStoryViewer() {
    const v = document.getElementById('story-viewer');
    if (v) {
      clearTimeout(v._timer);
      v._timer = null;
      // Stop any playing media so audio doesn't keep going in the background.
      v.querySelectorAll('video, audio').forEach(el => {
        try { el.pause(); } catch {}
        try { el.removeAttribute('src'); el.load(); } catch {}
      });
      v.style.display = 'none';
      // Clear the inner so the next open starts fresh (no stale video element).
      v.innerHTML = '';
    }
    _rerenderStoriesBarInDom();
  }

  let _addStoryMedia = null, _addStoryFile = null, _addStoryType = null, _addStoryPrivacy = 'public';
  let _addStoryPreviewUrl = null;
  let _storySubmitInFlight = false;
  let _storyModalOpen = false;
  let _lastStoryShareTapAt = 0;
  let _storyTapLocked = false;
  let _storyUploadXhr = null;  // For cancellation support
  let _storyUploadSession = null;  // Current upload session
  let _storyUploadMinimized = false;  // Track if bar is minimized
  let _storySyntheticTimer = null;     // Fallback progress when real events don't fire
  let _storyRealProgressSeen = false;  // Real upload.onprogress event observed
  let _storyUploadCancelled = false;   // User clicked the X on the upload bar

  // _startSyntheticProgress drives a slow, time-based fake progress curve so
  // the user sees motion when xhr.upload.onprogress doesn't fire (Android
  // WebView + SW interception is unreliable for multipart upload events).
  // Real progress events take over via _markRealProgress and supersede this.
  function _startSyntheticProgress(fileSize, onTick) {
    _stopSyntheticProgress();
    _storyRealProgressSeen = false;
    const startedAt = Date.now();
    // Estimate upload time from file size on a conservative 1.5 Mbps link
    // (~190 KB/s). Cap at 60s so a small file moves visibly fast and a big
    // file still shows steady progress without hitting 100% prematurely.
    const estMs = Math.max(8000, Math.min(60000, ((fileSize || 1_500_000) / 190_000) * 1000));
    _storySyntheticTimer = setInterval(() => {
      if (_storyRealProgressSeen) { _stopSyntheticProgress(); return; }
      const elapsed = Date.now() - startedAt;
      // Asymptotic curve: approaches 90% but never reaches it.
      const ratio = 1 - Math.exp(-elapsed / estMs);
      const fake = Math.min(90, Math.max(5, Math.round(ratio * 90)));
      try { onTick(fake); } catch {}
    }, 400);
  }
  function _stopSyntheticProgress() {
    if (_storySyntheticTimer) { clearInterval(_storySyntheticTimer); _storySyntheticTimer = null; }
  }
  function _markRealProgress() { _storyRealProgressSeen = true; }

  function _ensureStoryUploadOverlay() {
    let ov = document.getElementById('story-upload-overlay');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'story-upload-overlay';
    ov.innerHTML = `
      <div class="story-upload-bar" id="story-upload-bar-main">
        <div class="story-upload-bar-inner">
          <div class="story-upload-bar-content">
            <div class="story-upload-bar-left" id="story-upload-bar-left">
              <div class="story-upload-bar-icon" id="story-upload-icon">📤</div>
              <div class="story-upload-bar-text">
                <div class="story-upload-bar-title" id="story-upload-title">Uploading story</div>
                <div class="story-upload-bar-sub" id="story-upload-sub">0%</div>
              </div>
            </div>
            <div class="story-upload-bar-progress" id="story-upload-progress-container">
              <div class="story-upload-progress" style="flex:1">
                <div class="story-upload-progress-fill" id="story-upload-progress-fill"></div>
              </div>
              <div class="story-upload-bar-pct" id="story-upload-pct">0%</div>
            </div>
            <button class="story-upload-bar-minimize" id="story-upload-minimize" type="button" title="Minimize">−</button>
            <button class="story-upload-bar-cancel" id="story-upload-cancel" type="button" title="Cancel upload">✕</button>
          </div>
          <div class="story-upload-bar-retry-hint" id="story-upload-retry-hint" style="display:none;margin-top:8px;font-size:11px;color:#ff9500;text-align:center">
            Retrying... <span id="story-upload-retry-count">1/3</span>
          </div>
        </div>
      </div>`;
    document.body.appendChild(ov);
    
    const minimizeBtn = ov.querySelector('#story-upload-minimize');
    const cancelBtn = ov.querySelector('#story-upload-cancel');
    
    if (minimizeBtn) {
      minimizeBtn.addEventListener('click', () => {
        _storyUploadMinimized = !_storyUploadMinimized;
        const main = ov.querySelector('#story-upload-bar-main');
        const left = ov.querySelector('#story-upload-bar-left');
        const container = ov.querySelector('#story-upload-progress-container');
        if (_storyUploadMinimized) {
          left.style.display = 'none';
          container.style.display = 'none';
          minimizeBtn.textContent = '+';
          minimizeBtn.title = 'Expand';
          main.classList.add('minimized');
        } else {
          left.style.display = 'flex';
          container.style.display = 'flex';
          minimizeBtn.textContent = '−';
          minimizeBtn.title = 'Minimize';
          main.classList.remove('minimized');
        }
      });
    }
    
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        // Mark cancelled BEFORE aborting so the retry loop doesn't kick in
        // when the in-flight xhr rejects with 'Upload cancelled'.
        _storyUploadCancelled = true;
        if (_storyUploadXhr) {
          try { _storyUploadXhr.abort(); } catch {}
          _storyUploadXhr = null;
        }
        _stopSyntheticProgress();
        _storyUploadSession = null;
        try { localStorage.removeItem('_storyUploadState'); } catch {}
        // Tell Android to clear / replace the ongoing upload notification.
        try { _notifyAndroidStoryUpload(0, 'cancelled'); } catch {}
        _hideStoryUploadOverlay(0);
        _storyNotify('Upload cancelled', 'info');
      });
    }
    return ov;
  }

  function _updateStoryUploadOverlay(percent, text) {
    const ov = _ensureStoryUploadOverlay();
    if (!ov) return;
    const fill = ov.querySelector('#story-upload-progress-fill');
    const pct = ov.querySelector('#story-upload-pct');
    const sub = ov.querySelector('#story-upload-sub');
    const title = ov.querySelector('#story-upload-title');
    const icon = ov.querySelector('#story-upload-icon');
    const p = Math.max(0, Math.min(100, Number(percent || 0)));
    
    ov.style.display = 'flex';
    if (fill) {
      fill.style.width = `${p}%`;
    }
    if (pct) pct.textContent = `${Math.round(p)}%`;
    if (sub) {
      // Caller-provided text always wins so we don't get stuck at
      // "Connecting..." when a large video uploads without progress events.
      if (text) sub.textContent = text;
      else if (p <= 1) sub.textContent = 'Connecting…';
      else if (p < 100) sub.textContent = `${Math.round(p)}% uploading…`;
      else sub.textContent = 'Finalizing…';
    }
    if (title && p === 100) title.textContent = 'Story posted!';
    if (icon) {
      if (p === 100) icon.textContent = '✓';
      else if (p > 30) icon.textContent = '📤';
    }
  }

  function _showStoryUploadRetry(retryNum, maxRetries) {
    const ov = _ensureStoryUploadOverlay();
    if (!ov) return;
    const hint = ov.querySelector('#story-upload-retry-hint');
    const count = ov.querySelector('#story-upload-retry-count');
    if (hint && count) {
      count.textContent = `${retryNum}/${maxRetries}`;
      hint.style.display = 'block';
    }
  }

  function _hideStoryUploadRetryHint() {
    const ov = document.getElementById('story-upload-overlay');
    if (!ov) return;
    const hint = ov.querySelector('#story-upload-retry-hint');
    if (hint) hint.style.display = 'none';
  }

  function _hideStoryUploadOverlay(delay = 500) {
    const ov = document.getElementById('story-upload-overlay');
    if (!ov) return;
    setTimeout(() => { ov.style.display = 'none'; }, Math.max(0, delay));
  }

  let _lastAndroidStoryNotif = -1;
  let _lastAndroidStoryNotifAt = 0;
  function _notifyAndroidStoryUpload(percent, stage = 'uploading') {
    try {
      if (!window.Android) return;
      const p = Math.max(0, Math.min(100, Math.round(Number(percent || 0))));
      if (stage === 'done') {
        if (typeof window.Android.finishStoryUploadNotification === 'function') {
          window.Android.finishStoryUploadNotification(true, 'Your story is now live');
        } else if (typeof window.Android.showNotification === 'function') {
          window.Android.showNotification('Story posted', 'Your story is now live');
        }
        _lastAndroidStoryNotif = 100;
        _lastAndroidStoryNotifAt = Date.now();
        return;
      }
      if (stage === 'failed') {
        if (typeof window.Android.finishStoryUploadNotification === 'function') {
          window.Android.finishStoryUploadNotification(false, 'Tap back into FrogTalk to retry');
        } else if (typeof window.Android.showNotification === 'function') {
          window.Android.showNotification('Story upload failed', 'Tap back into FrogTalk to retry');
        }
        _lastAndroidStoryNotifAt = Date.now();
        return;
      }
      if (stage === 'cancelled') {
        if (typeof window.Android.finishStoryUploadNotification === 'function') {
          // Pass success=false so the bridge replaces the ongoing
          // progress notification with a final, dismissable one.
          window.Android.finishStoryUploadNotification(false, 'Upload cancelled');
        } else if (typeof window.Android.showNotification === 'function') {
          window.Android.showNotification('Upload cancelled', '');
        }
        _lastAndroidStoryNotif = -1;
        _lastAndroidStoryNotifAt = Date.now();
        return;
      }

      if (typeof window.Android.updateStoryUploadNotification === 'function') {
        // New Android bridge: in-place update, no sound spam.
        window.Android.updateStoryUploadNotification(p, p < 100 ? `Uploading ${p}%` : 'Finalizing…');
        _lastAndroidStoryNotif = p;
        _lastAndroidStoryNotifAt = Date.now();
        return;
      }

      // Backward compatibility for older APKs: severely throttle to avoid sound spam.
      if (typeof window.Android.showNotification === 'function') {
        const now = Date.now();
        if (_lastAndroidStoryNotif >= 0 && p < 100) {
          const delta = p - _lastAndroidStoryNotif;
          const elapsed = now - _lastAndroidStoryNotifAt;
          if (delta < 25 && elapsed < 12000) return;
        }
        window.Android.showNotification('Uploading story', `${p}%`);
        _lastAndroidStoryNotif = p;
        _lastAndroidStoryNotifAt = now;
      }
    } catch {}
  }

  function _uploadStoryWithProgress(payload, onProgress) {
    return new Promise((resolve, reject) => {
      try {
        const xhr = new XMLHttpRequest();
        let lastReportedProgress = 0;
        
        xhr.open('POST', '/api/social/stories', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (State.token) xhr.setRequestHeader('X-Session-Token', State.token);
        xhr.upload.onloadstart = () => onProgress(0);
        
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          const progress = Math.round((e.loaded / e.total) * 100);
          if (progress > lastReportedProgress) {
            lastReportedProgress = progress;
            onProgress(progress);
          }
        };
        
        xhr.onerror = () => reject(new Error('Network error'));
        
        xhr.onload = () => {
          onProgress(100);
          const txt = xhr.responseText || '';
          let data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch {}
          resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data, text: txt });
        };

        xhr.send(JSON.stringify(payload));
      } catch (e) {
        reject(e);
      }
    });
  }

  function _uploadStoryFileWithProgress({ file, caption, privacy }, onProgress) {
    return new Promise((resolve, reject) => {
      try {
        const xhr = new XMLHttpRequest();
        _storyUploadXhr = xhr;
        let lastReportedProgress = 0;
        
        const uploadTimeout = setTimeout(() => {
          xhr.abort();
          reject(new Error('Upload timeout'));
        }, 120000);  // 120 second timeout
        
        xhr.open('POST', '/api/social/stories/upload', true);
        if (State.token) xhr.setRequestHeader('X-Session-Token', State.token);

        // Synthetic progress drives motion when real upload events don't fire
        // (Android WebView + SW intercept multipart uploads silently). Each
        // synthetic tick reports through onProgress just like a real event.
        _startSyntheticProgress(file?.size || 0, (fakePct) => {
          if (fakePct > lastReportedProgress) {
            lastReportedProgress = fakePct;
            try { onProgress(fakePct); } catch {}
          }
        });

        xhr.upload.onloadstart = () => {
          // Show 5% immediately so bar leaves "Connecting…" right away.
          if (lastReportedProgress < 5) {
            lastReportedProgress = 5;
            try { onProgress(5); } catch {}
          }
        };
        
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          _markRealProgress();
          const progress = Math.round((e.loaded / e.total) * 100);
          if (progress > lastReportedProgress) {
            lastReportedProgress = progress;
            onProgress(progress);
          }
        };
        
        xhr.onerror = () => {
          _stopSyntheticProgress();
          _storyUploadXhr = null;
          clearTimeout(uploadTimeout);
          reject(new Error('Network error'));
        };
        
        xhr.onabort = () => {
          _stopSyntheticProgress();
          _storyUploadXhr = null;
          clearTimeout(uploadTimeout);
          reject(new Error('Upload cancelled'));
        };
        
        xhr.onload = () => {
          _stopSyntheticProgress();
          _storyUploadXhr = null;
          clearTimeout(uploadTimeout);
          onProgress(100);
          const txt = xhr.responseText || '';
          let data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch {}
          resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data, text: txt });
        };
        
        // Start the upload
        const form = new FormData();
        form.append('media', file, file.name || 'story-upload');
        form.append('caption', caption || '');
        form.append('privacy', privacy || 'public');

        xhr.send(form);
      } catch (e) {
        _stopSyntheticProgress();
        _storyUploadXhr = null;
        reject(e);
      }
    });
  }

  function _ensureSelfProfileStoryRing() {
    try {
      const nick = State.user?.nickname;
      if (!nick || _currentTab !== 'profile' || _profileUser !== nick) return;
      const avatar = document.querySelector('.sp-avatar');
      if (!avatar) return;
      avatar.classList.add('has-story', 'unviewed');
      avatar.classList.remove('viewed');
      avatar.style.cursor = 'pointer';
      avatar.title = 'View stories';
      avatar.setAttribute('onclick', `Social.viewProfileStories(${jsStr(nick)},${Number(State.user?.id || 0)})`);
    } catch {}
  }

  function _bindAddStoryActions(modal) {
    if (!modal) return;
    const oldShareBtn = modal.querySelector('#add-story-share-btn');
    if (oldShareBtn && oldShareBtn.dataset.bound !== '2') {
      // Replace node to drop any stale listeners from prior script versions.
      const shareBtn = oldShareBtn.cloneNode(true);
      oldShareBtn.replaceWith(shareBtn);
      const onSharePress = (ev) => handleStoryShareTap(ev);
      shareBtn.addEventListener('click', onSharePress, { passive: false });
      shareBtn.addEventListener('touchstart', onSharePress, { passive: false });
      shareBtn.addEventListener('pointerdown', onSharePress, { passive: false });
      shareBtn.dataset.bound = '2';
    }
  }

  function _ensureGlobalStoryShareDelegation() {
    // Keep as no-op: explicit button handlers are more reliable than
    // global capture listeners and avoid delayed submits after cancel.
  }

  function openAddStory() {
    _ensureGlobalStoryShareDelegation();
    _storyModalOpen = true;
    _storyTapLocked = false;
    _addStoryMedia = null; _addStoryFile = null; _addStoryType = null;
    if (_addStoryPreviewUrl) {
      try { URL.revokeObjectURL(_addStoryPreviewUrl); } catch {}
      _addStoryPreviewUrl = null;
    }
    _addStoryPrivacy = (localStorage.getItem('ft_default_story_privacy') || 'public');
    let modal = document.getElementById('add-story-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'add-story-modal';
      modal.innerHTML = `
        <div class="add-story-box" style="position:relative">
          <button type="button" class="add-story-close" onclick="Social.closeAddStory()" aria-label="Close story dialog">✕</button>
          <h3 style="margin:0 0 12px;color:#e0e0e0;font-size:16px">Add to Your Story</h3>
          <div id="add-story-preview" style="display:none;margin-bottom:12px;text-align:center">
            <img id="add-story-img" style="display:none;max-width:100%;max-height:300px;border-radius:8px">
            <video id="add-story-vid" style="display:none;max-width:100%;max-height:300px;border-radius:8px;background:#000" controls playsinline></video>
          </div>
          <button type="button" onclick="Social.openStoryCamera()" style="display:block;width:100%;padding:16px;text-align:center;border:none;background:linear-gradient(135deg,#4caf50,#2e7d32);border-radius:12px;cursor:pointer;color:#000;font-weight:700;margin-bottom:10px;font-size:15px">
            📷 Open Camera · Tap for photo · Hold for video
          </button>
          <label style="display:block;padding:16px;text-align:center;border:1px dashed #333;border-radius:10px;cursor:pointer;color:#888;margin-bottom:10px;font-size:13px">
            📂 Or pick from gallery
            <input type="file" accept="image/*,video/*" style="display:none" onchange="Social.handleStoryMedia(this)">
          </label>
          <input id="add-story-caption" placeholder="Add a caption…" style="width:100%;padding:10px;background:#1a1a1a;border:1px solid #333;border-radius:8px;color:#e0e0e0;margin-bottom:10px;box-sizing:border-box">
          <div id="add-story-status" style="display:none;margin:-2px 0 10px 0;font-size:12px;color:#9ca3af"></div>
          <div style="display:flex;gap:10px;justify-content:flex-end;align-items:center">
            <button type="button" id="story-priv-chip" class="ft-inline-chip" onclick="Social.cycleStoryPrivacy()" title="Change audience" style="margin-right:auto">🌍 Everyone</button>
            <button type="button" id="add-story-cancel-btn" onclick="Social.closeAddStory()" style="background:#1a1a1a;border:none;color:#888;padding:8px 16px;border-radius:8px;cursor:pointer">Cancel</button>
            <button type="button" id="add-story-share-btn" onclick="Social.handleStoryShareTap(event);return false" ontouchstart="Social.handleStoryShareTap(event);return false" onpointerdown="Social.handleStoryShareTap(event);return false" style="background:#4caf50;border:none;color:#000;font-weight:600;padding:8px 20px;border-radius:8px;cursor:pointer;touch-action:manipulation">Share</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
    }
    _bindAddStoryActions(modal);
    modal.style.display = 'flex';
    modal.onclick = (ev) => {
      if (ev.target === modal) closeAddStory();
    };
    document.getElementById('add-story-preview').style.display = 'none';
    _setAddStoryStatus('', 'info');
    const cap = document.getElementById('add-story-caption');
    if (cap) cap.value = '';
    setStoryPrivacy(_addStoryPrivacy);
  }

  function setStoryPrivacy(p) {
    _addStoryPrivacy = (p === 'followers') ? 'followers' : 'public';
    localStorage.setItem('ft_default_story_privacy', _addStoryPrivacy);
    // Inline chip
    const chip = document.getElementById('story-priv-chip');
    if (chip) {
      chip.textContent = _addStoryPrivacy === 'followers' ? '👥 Followers' : '🌍 Everyone';
      chip.classList.toggle('on', _addStoryPrivacy === 'followers');
    }
    // Legacy buttons (if present)
    ['public','followers'].forEach(k => {
      const btn = document.getElementById('story-priv-' + k);
      if (!btn) return;
      if (k === _addStoryPrivacy) {
        btn.style.background = 'linear-gradient(135deg,#4caf50,#2e7d32)';
        btn.style.color = '#000';
        btn.style.borderColor = '#4caf50';
      } else {
        btn.style.background = '#1a1a1a';
        btn.style.color = '#ddd';
        btn.style.borderColor = '#2a2a2a';
      }
    });
  }

  function cycleStoryPrivacy() {
    setStoryPrivacy(_addStoryPrivacy === 'public' ? 'followers' : 'public');
  }

  function closeAddStory() {
    _storyModalOpen = false;
    const m = document.getElementById('add-story-modal');
    if (m) m.style.display = 'none';
  }

  function _storyNotify(msg, type = 'info') {
    try {
      if (typeof UI !== 'undefined' && typeof UI.showToast === 'function') {
        UI.showToast(msg, type);
        return;
      }
      if (typeof toast === 'function') {
        toast(msg, type);
        return;
      }
      if (typeof alert === 'function' && (type === 'error' || type === 'success')) {
        alert(msg);
        return;
      }
    } catch {}
    console.log('[Story]', type, msg);
  }

  function _setAddStoryStatus(msg, type = 'info') {
    const el = document.getElementById('add-story-status');
    if (!el) return;
    if (!msg) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = 'block';
    el.textContent = msg;
    if (type === 'error') el.style.color = '#f87171';
    else if (type === 'success') el.style.color = '#4caf50';
    else el.style.color = '#9ca3af';
  }

  function _renderStoryPreview(dataUrl, type) {
    const preview = document.getElementById('add-story-preview');
    const img = document.getElementById('add-story-img');
    const vid = document.getElementById('add-story-vid');
    if (!preview) return;
    preview.style.display = 'block';
    if (type && type.startsWith('video')) {
      if (img) img.style.display = 'none';
      if (vid) { vid.src = dataUrl; vid.style.display = 'block'; vid.load(); }
    } else {
      if (vid) { vid.style.display = 'none'; vid.removeAttribute('src'); vid.load(); }
      if (img) { img.src = dataUrl; img.style.display = 'block'; }
    }
  }

  function handleStoryMedia(input) {
    const file = input.files[0];
    if (!file) {
      _setAddStoryStatus('No file selected', 'error');
      return;
    }
    const isVideo = String(file.type || '').startsWith('video');
    const maxBytes = isVideo ? 100 * 1024 * 1024 : 100 * 1024 * 1024;
    if (file.size > maxBytes) {
      _setAddStoryStatus(`File too large (max 100MB)`, 'error');
      _storyNotify(`File too large (max 100MB)`, 'error');
      return;
    }
    _setAddStoryStatus('Preparing preview…', 'info');
    if (_addStoryPreviewUrl) {
      try { URL.revokeObjectURL(_addStoryPreviewUrl); } catch {}
      _addStoryPreviewUrl = null;
    }
    try {
      _addStoryPreviewUrl = URL.createObjectURL(file);
      _addStoryFile = file;
      _addStoryMedia = null;
      _addStoryType = file.type;
      _renderStoryPreview(_addStoryPreviewUrl, file.type);
      _setAddStoryStatus(`${isVideo ? 'Video' : 'Image'} ready to share`, 'success');
    } catch {
      _setAddStoryStatus('', 'info');
      _storyNotify('Could not prepare selected file', 'error');
    }
  }

  function openStoryCamera() {
    if (typeof openStoryCapture === 'function') {
      openStoryCapture((dataUrl, mime) => {
        _addStoryMedia = dataUrl;
        _addStoryFile = null;
        _addStoryType = mime || 'image/jpeg';
        _renderStoryPreview(dataUrl, _addStoryType);
      });
      return;
    }
    if (typeof openCameraCapture === 'function') {
      openCameraCapture((dataUrl) => {
        _addStoryMedia = dataUrl;
        _addStoryFile = null;
        _addStoryType = 'image/jpeg';
        _renderStoryPreview(dataUrl, 'image/jpeg');
      });
      return;
    }
    UI.showToast('Camera unavailable', 'error');
  }

  async function submitStory() {
    if (_storySubmitInFlight) return;
    _storySubmitInFlight = true;
    if (!_addStoryMedia && !_addStoryFile) {
      _setAddStoryStatus('Choose a photo or video first', 'error');
      _storyNotify('Choose a photo or video', 'error');
      _storySubmitInFlight = false;
      _storyTapLocked = false;
      return;
    }
    const caption = document.getElementById('add-story-caption')?.value?.trim() || '';
    const shareBtn = document.getElementById('add-story-share-btn');
    const cancelBtn = document.getElementById('add-story-cancel-btn');
    const oldShareText = shareBtn ? shareBtn.textContent : 'Share';
    if (shareBtn) { shareBtn.disabled = true; shareBtn.style.opacity = '0.7'; shareBtn.textContent = 'Uploading…'; }
    if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.style.opacity = '0.7'; }
    // Close modal immediately so upload happens in background
    closeAddStory();
    _setAddStoryStatus('Starting upload…', 'info');
    _updateStoryUploadOverlay(2, 'Starting upload…');
    _notifyAndroidStoryUpload(2);
    
    // Create upload session for tracking and recovery
    // Reset cancellation flag for this attempt; closure of _storyUploadCancelled
    // is set true by the cancel button click handler.
    _storyUploadCancelled = false;
    _storyUploadSession = {
      fileSize: _addStoryFile?.size || 0,
      startTime: Date.now(),
      retryCount: 0,
      maxRetries: 3,
      caption,
      privacy: _addStoryPrivacy || 'public'
    };
    _saveStoryUploadState();
    
    await _performStoryUploadWithRetry();
    
    if (shareBtn) { shareBtn.disabled = false; shareBtn.style.opacity = '1'; shareBtn.textContent = oldShareText; }
    if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.style.opacity = '1'; }
    _storySubmitInFlight = false;
    _storyTapLocked = false;
  }

  function _saveStoryUploadState() {
    if (!_storyUploadSession) return;
    try {
      localStorage.setItem('_storyUploadState', JSON.stringify({
        startTime: _storyUploadSession.startTime,
        retryCount: _storyUploadSession.retryCount,
        caption: _storyUploadSession.caption,
        privacy: _storyUploadSession.privacy,
        fileSize: _storyUploadSession.fileSize
      }));
    } catch {}
  }

  function _clearStoryUploadState() {
    _storyUploadSession = null;
    try { localStorage.removeItem('_storyUploadState'); } catch {}
  }

  async function _performStoryUploadWithRetry() {
    const maxRetries = _storyUploadSession?.maxRetries || 3;
    let lastError = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Bail out cleanly if the user hit the cancel X at any point.
      if (_storyUploadCancelled) return;
      try {
        const res = _addStoryFile
          ? await _uploadStoryFileWithProgress({ file: _addStoryFile, caption: _storyUploadSession?.caption || '', privacy: _storyUploadSession?.privacy || 'public' }, (p) => {
              _updateStoryUploadOverlay(p, p < 100 ? 'Uploading story…' : 'Finalizing…');
              _notifyAndroidStoryUpload(p);
            })
          : await _uploadStoryWithProgress({
              media_data: _addStoryMedia, media_type: _addStoryType, caption: _storyUploadSession?.caption || '',
              privacy: _storyUploadSession?.privacy || 'public'
            }, (p) => {
              _updateStoryUploadOverlay(p, p < 100 ? 'Uploading story…' : 'Finalizing…');
              _notifyAndroidStoryUpload(p);
            });
        
        if (_storyUploadCancelled) return;
        if (res.ok) {
          _handleStoryUploadSuccess();
          return;
        } else if (res.status >= 400 && res.status < 500) {
          // Client error (4xx) - don't retry
          throw new Error((res.data && (res.data.error || res.data.detail)) || 'Could not add story');
        } else {
          // Server error (5xx) or other - retry
          throw new Error('Server error, retrying...');
        }
      } catch (err) {
        // User cancellation must short-circuit immediately — do NOT retry.
        if (_storyUploadCancelled) return;
        lastError = err;
        if (attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          const delayMs = Math.pow(2, attempt) * 1000;
          _updateStoryUploadSession(attempt + 1);
          _showStoryUploadRetry(attempt + 1, maxRetries);
          _updateStoryUploadOverlay(Math.max(10, Math.min(90, attempt * 20)), `Retrying (${attempt + 1}/${maxRetries})…`);
          await new Promise(r => setTimeout(r, delayMs));
          if (_storyUploadCancelled) return;
        }
      }
    }
    
    // All retries failed
    if (_storyUploadCancelled) return;
    _handleStoryUploadFailure(lastError?.message || 'Upload failed after retries');
  }

  function _updateStoryUploadSession(retryCount) {
    if (_storyUploadSession) {
      _storyUploadSession.retryCount = retryCount;
      _saveStoryUploadState();
    }
  }

  function _handleStoryUploadSuccess() {
    try {
      if (_profileData && _profileData.is_self) {
        const cur = _profileData.story_status || { count: 0, has_unviewed: 0 };
        _profileData.story_status = {
          count: Math.max(1, Number(cur.count || 0) + 1),
          has_unviewed: 1,
        };
      }
      _ensureSelfProfileStoryRing();
    } catch {}
    _updateStoryUploadOverlay(100, 'Story posted');
    _hideStoryUploadRetryHint();
    _notifyAndroidStoryUpload(100, 'done');
    _setAddStoryStatus('Story uploaded', 'success');
    _storyNotify('Story added!', 'success');
    if (_currentTab === 'feed') loadFeed();
    else if (_currentTab === 'profile' && _profileUser === State.user?.nickname) {
      loadProfile(State.user?.nickname);
    }
    _hideStoryUploadOverlay(700);
    if (_addStoryPreviewUrl) {
      try { URL.revokeObjectURL(_addStoryPreviewUrl); } catch {}
      _addStoryPreviewUrl = null;
    }
    _addStoryFile = null;
    _clearStoryUploadState();
  }

  function _handleStoryUploadFailure(errorMsg) {
    _notifyAndroidStoryUpload(0, 'failed');
    _updateStoryUploadOverlay(0, errorMsg || 'Upload failed');
    _hideStoryUploadRetryHint();
    _hideStoryUploadOverlay(2000);
    _setAddStoryStatus(errorMsg || 'Upload failed', 'error');
    _storyNotify(errorMsg || 'Upload failed', 'error');
    _clearStoryUploadState();
  }

  function submitStoryFromTap() {
    submitStory();
  }

  function handleStoryShareTap(ev) {
    try {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    } catch {}
    if (!_storyModalOpen) return;
    if (_storyTapLocked || _storySubmitInFlight) return;
    const now = Date.now();
    if (now - _lastStoryShareTapAt < 500) return;
    _lastStoryShareTapAt = now;
    _storyTapLocked = true;
    try {
      _setAddStoryStatus('Share tapped…', 'info');
      closeAddStory();
      _updateStoryUploadOverlay(1, 'Starting upload…');
    } catch {}
    submitStoryFromTap();
  }

  function _renderSuggestedUsers(users) {
    const _seenSug = new Set();
    const suggested = (users || []).filter(u => {
      const k = (u.nickname || '').toLowerCase();
      if (!k || _seenSug.has(k)) return false;
      _seenSug.add(k);
      return true;
    });
    if (!suggested.length) return '';
    return `<div class="social-suggest-bar">
      <div class="social-suggest-title">Suggested for you</div>
      <div class="social-suggest-scroll">
        ${suggested.map(u => {
          const mc = Number(u.mutual_count || 0);
          const mutualsList = (u.mutual_sample || '').split(',').map(s => s.trim()).filter(Boolean);
          const metaHtml = mc > 0
            ? `<div class="social-suggest-meta mut" title="Followed by ${mutualsList.map(esc).join(', ')}">
                <span class="mut-dot">●</span> ${mutualsList.length ? 'Followed by @' + esc(mutualsList[0]) : ''}${mc > 1 ? ` <span class="mut-more">+${mc - 1}</span>` : ''}
               </div>`
            : `<div class="social-suggest-meta">${u.follower_count || 0} followers</div>`;
          const reasonTag = mc > 0
            ? `<span class="social-suggest-tag mut">${mc} mutual${mc === 1 ? '' : 's'}</span>`
            : (Number(u.follower_count || 0) > 5 ? `<span class="social-suggest-tag pop">🔥 Popular</span>` : `<span class="social-suggest-tag new">✨ New</span>`);
          return `<div class="social-suggest-card" onclick="Social.openProfile('${esc(u.nickname)}')">
            ${reasonTag}
            <div class="social-suggest-avatar">${UI.avatarEl(u.avatar, u.nickname, 56)}</div>
            <div class="social-suggest-nick">${esc(u.nickname)}</div>
            ${metaHtml}
            <button class="social-follow-sm" onclick="event.stopPropagation();Social.toggleFollow('${esc(u.nickname)}',this)">Follow</button>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // ── FEED ────────────────────────────────────────────────────────────────
  function _renderFeedContent(content, posts, extras = {}) {
    let html = `<div id="social-feed-stories">${extras.storiesHtml || renderStoriesBar()}</div><div id="social-feed-suggest">${extras.suggestedHtml || ''}</div>`;

    if (!posts.length) {
      html += `<div class="social-empty">
        <div style="font-size:48px;margin-bottom:12px">🐸</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:6px">Your feed is empty</div>
        <div style="color:#888;font-size:14px">Follow people to see their posts here, or check out <a href="#" onclick="Social.switchTab('explore');return false" style="color:#4caf50">Explore</a>.</div>
      </div>`;
    } else {
      html += `<div class="social-feed">${posts.map(p => renderFeedPost(p)).join('')}</div>`;
    }

    _disposeMediaIn(content);
    content.innerHTML = html;
  }

  async function loadFeed(opts = {}) {
    _ensureSocialVideoObserver();
    const content = document.getElementById('social-content');
    if (!content) return;
    // Fast-path: fresh cache + already-warm stories/suggested → paint
    // and bail out, no banner, no network. Re-opening feed within the
    // 5-min TTL feels instant.
    {
      const _force = !!opts.force;
      if (!_force && _cacheFresh(_feedCache) && Array.isArray(_feedCache.posts)) {
        const _storiesHtml = (_storyData && _storyData.length) ? renderStoriesBar() : '';
        const _sugHtml = (_suggestedCache && _cacheFresh(_suggestedCache))
          ? _renderSuggestedUsers(_suggestedCache.users || [])
          : '';
        _renderFeedContent(content, _feedCache.posts || [], { storiesHtml: _storiesHtml, suggestedHtml: _sugHtml });
        _schedBgPrefetch('feed');
        return;
      }
    }
    const loadUi = _beginTabLoadUi('feed', 'Opening feed', 'Checking cache…');
    const smoothStepTimers = [];
    const queueLoadStep = (delayMs, pct, label, detail) => {
      const t = setTimeout(() => {
        if (_currentTab !== 'feed') return;
        _updateTabLoadUi(loadUi, pct, label, detail);
      }, Math.max(0, Number(delayMs) || 0));
      smoothStepTimers.push(t);
    };
    const clearQueuedSteps = () => {
      while (smoothStepTimers.length) clearTimeout(smoothStepTimers.pop());
    };
    let paintedFeed = false;
    const force = !!opts.force;
    const feedUsable = !force && _cacheUsable(_feedCache) ? (_feedCache.posts || []) : null;
    if (feedUsable) {
      _updateTabLoadUi(loadUi, 32, 'Feed (cached) — refreshing…', `${feedUsable.length} posts ready`);
      _renderFeedContent(content, feedUsable);
      paintedFeed = true;
      // NOTE: we deliberately do NOT short-circuit the fetch path here.
      // Suggested-users + stories are sub-resources patched onto the
      // rendered feed via subsequent api calls, so the network round-trip
      // is needed to restore them after a stale-cache paint. The server
      // path is 5-30 ms; the perceived-slowness fix lives in (a) skipping
      // the skeleton when we have any usable cache, and (b) dropping the
      // fake-progress queueLoadStep timers below.
    } else {
      _updateTabLoadUi(loadUi, 12, 'Opening feed', 'No cache — building layout…');
      content.innerHTML = _feedSkeletonHtml();
    }
    try {
      _updateTabLoadUi(loadUi, 28, 'Connecting to server', 'Sending feed request…');
      // Fake-progress timers removed — server responds in 5-30 ms; the
      // queued steps only created perceived latency on tab swaps.
      // Fire all three requests in parallel — stories and suggested don't depend on feed data.
      const feedReqPromise = _apiOkJson('/api/social/feed?lite=1&limit=24', { posts: [] });
      const storiesEarlyPromise = _withTimeout(loadStoriesBar());
      const suggestedEarlyPromise = _withTimeout(
        _apiOkJson('/api/social/suggested', { users: [] }).catch(() => ({ users: [] }))
      );
      _updateTabLoadUi(loadUi, 44, 'Downloading feed', 'Receiving latest posts from server…');
      const feedData = await feedReqPromise;
      clearQueuedSteps();
      const posts = feedData.posts || [];
      _feedCache = { ts: Date.now(), posts };
      if (_currentTab !== 'feed') return;
      _updateTabLoadUi(loadUi, 62, 'Building post cards', `${posts.length} post${posts.length !== 1 ? 's' : ''} received`);
      // If storiesEarlyPromise already resolved, _storyData is populated and
      // _renderFeedContent will show the real stories bar on the first paint.
      _renderFeedContent(content, posts);
      paintedFeed = true;
      _animateSocialSwap(content);

      let storiesDone = false;
      let suggestDone = false;
      const refreshFeedSubresources = () => {
        const doneCount = (storiesDone ? 1 : 0) + (suggestDone ? 1 : 0);
        if (doneCount === 0) {
          _updateTabLoadUi(loadUi, 72, 'Loading stories & suggestions', 'Fetching friend stories…');
        } else if (doneCount === 1) {
          _updateTabLoadUi(loadUi, 86, 'Almost ready', storiesDone ? 'Loading people you may know…' : 'Loading stories bar…');
        } else {
          _updateTabLoadUi(loadUi, 96, 'Finishing up', 'Feed fully loaded');
        }
      };
      refreshFeedSubresources();

      const storiesPromise = storiesEarlyPromise.then((storiesHtml) => {
        if (_currentTab !== 'feed') return;
        const el = document.getElementById('social-feed-stories');
        if (el && typeof storiesHtml === 'string') el.innerHTML = storiesHtml;
      }).catch(() => {}).finally(() => {
        storiesDone = true;
        refreshFeedSubresources();
      });

      const suggestedPromise = suggestedEarlyPromise.then((sugData) => {
        if (!sugData || _currentTab !== 'feed') return;
        if (Array.isArray(sugData.users)) {
          _suggestedCache = { ts: Date.now(), users: sugData.users };
        }
        const el = document.getElementById('social-feed-suggest');
        if (!el) return;
        el.innerHTML = _renderSuggestedUsers(sugData.users || []);
      }).catch(() => {}).finally(() => {
        suggestDone = true;
        refreshFeedSubresources();
      });

      await Promise.allSettled([storiesPromise, suggestedPromise]);
    } catch {
      clearQueuedSteps();
      if (!feedUsable && _currentTab === 'feed') {
        content.innerHTML = _socialErrorHTML('Could not load feed', "Social.loadFeed({force:true})", { ico: '🐸', sub: 'Your connection blinked or the server is busy. Try again in a moment.' });
      }
    } finally {
      clearQueuedSteps();
      // Guard against a stale skeleton lingering after a timeout/race where no
      // real feed content was ever painted.
      if (_currentTab === 'feed' && !paintedFeed) {
        const hasSkeleton = !!content.querySelector('.skel-row, .skel-block, .is-skeleton');
        if (hasSkeleton) {
          content.innerHTML = `
            <div class="social-empty">
              <div style="font-size:42px;margin-bottom:10px">⏳</div>
              <div style="font-size:16px;font-weight:600;margin-bottom:6px">Feed is taking too long</div>
              <div style="color:#8aa08f;font-size:14px;margin-bottom:10px">Try refreshing the feed.</div>
              <button type="button" class="explore-refresh" onclick="Social.loadFeed({force:true})" style="margin:0 auto">Retry feed</button>
            </div>`;
          paintedFeed = true;
        }
      }
      _schedBgPrefetch('feed');
      _finishTabLoadUi(loadUi);
    }
  }

  // ── EXPLORE ─────────────────────────────────────────────────────────────
  let _exploreSort = 'trending';

  function _renderExploreContent(content, posts, channels = []) {
    let html = `<div class="explore-toolbar">
      <div class="explore-tabs">
        <button class="explore-tab ${_exploreSort==='trending'?'active':''}" onclick="Social.loadExplore('trending')">🔥 Trending</button>
        <button class="explore-tab ${_exploreSort==='new'?'active':''}" onclick="Social.loadExplore('new')">🆕 New</button>
        <button class="explore-tab ${_exploreSort==='top'?'active':''}" onclick="Social.loadExplore('top')">⭐ Top</button>
      </div>
      <button class="explore-refresh" onclick="Social.refreshExplore()" title="Refresh">🔄</button>
    </div><div id="explore-channels-host"></div>`;

    if (posts.length === 0) {
      html += `<div class="social-empty">
        <div style="font-size:48px;margin-bottom:12px">🌍</div>
        <div style="font-size:16px;font-weight:600">Nothing to explore yet</div>
        <div style="color:#888;font-size:14px;margin-top:6px">Be the first to post something!</div>
      </div>`;
      _disposeMediaIn(content);
      content.innerHTML = html;
      return;
    }

    // grid of media posts + list of text posts.
    // Only real images belong in the visual grid — video/music/link posts
    // would render as broken 🖼 placeholders. They still appear in the
    // text-post list below so nothing is hidden from Explore.
    const isImage = (p) => {
      const mt = String(p.media_type || '').toLowerCase();
      if (mt.startsWith('image/')) return true;
      // Legacy posts without media_type: sniff by extension.
      if (!mt && /\.(jpe?g|png|gif|webp|avif|bmp)(\?|#|$)/i.test(String(p.media_data || ''))) return true;
      return false;
    };
    const mediaPosts = posts.filter(isImage);
    const textPosts = posts.filter(p => !isImage(p));

    if (mediaPosts.length > 0) {
      html += `<div class="social-grid">${mediaPosts.map(p => `
        <div class="social-grid-item" onclick="Social.viewPostDetail(${p.id})">
          <img src="${esc(p.media_data)}" alt="" loading="lazy"
               onerror="this.closest('.social-grid-item')?.remove()">
          <div class="social-grid-overlay">
            <span>❤️ ${p.reaction_count || 0}</span>
            <span>💬 ${p.comment_count || 0}</span>
          </div>
        </div>
      `).join('')}</div>`;
    }
    if (textPosts.length > 0) {
      html += `<div class="social-feed">${textPosts.map(p => renderFeedPost(p)).join('')}</div>`;
    }

    _disposeMediaIn(content);
    content.innerHTML = html;
    const host = document.getElementById('explore-channels-host');
    if (!host || !channels.length) return;
    const catIcons = {gaming:'🎮',music:'🎵',art:'🎨',tech:'💻',social:'💬',education:'📚',memes:'😂',crypto:'💰',sports:'⚽',other:'📦'};
    host.innerHTML = `<div class="explore-channels-section">
      <div class="explore-section-head">
        <span class="explore-section-title">📺 New Channels</span>
        <button class="explore-section-link" onclick="showChannelDirectory()">View all →</button>
      </div>
      <div class="explore-channels-scroll">${channels.slice(0, 8).map(ch => {
        const iconHtml = ch.icon && ch.icon.startsWith('data:image')
          ? `<img src="${esc(ch.icon)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
          : esc(ch.icon || '💬');
        return `<div class="explore-channel-card" onclick="viewChannelProfile(${jsStr(ch.name)})">
          <div class="explore-channel-icon">${iconHtml}</div>
          <div class="explore-channel-name">${esc(ch.name)}</div>
          <div class="explore-channel-meta">${catIcons[ch.category]||''} ${ch.member_count || 0} members</div>
        </div>`;
      }).join('')}</div>
    </div>`;
  }

  async function loadExplore(sort, opts = {}) {
    _ensureSocialVideoObserver();
    if (sort) _exploreSort = sort;
    const content = document.getElementById('social-content');
    if (!content) return;
    // Fast-path: fresh cache → instant paint, no banner, no network.
    {
      const _force = !!opts.force;
      const _key = String(_exploreSort || 'trending');
      const _entry = !_force ? _exploreCache.get(_key) : null;
      if (_entry && _cacheFresh(_entry) && Array.isArray(_entry.posts)) {
        _renderExploreContent(content, _entry.posts || [], _entry.channels || []);
        _schedBgPrefetch('explore');
        return;
      }
    }
    const loadUi = _beginTabLoadUi('explore', 'Opening explore', `Checking ${_exploreSort} cache…`);
    const smoothStepTimers = [];
    const queueLoadStep = (delayMs, pct, label, detail) => {
      const t = setTimeout(() => {
        if (_currentTab !== 'explore') return;
        _updateTabLoadUi(loadUi, pct, label, detail);
      }, Math.max(0, Number(delayMs) || 0));
      smoothStepTimers.push(t);
    };
    const clearQueuedSteps = () => {
      while (smoothStepTimers.length) clearTimeout(smoothStepTimers.pop());
    };
    const force = !!opts.force;
    const cacheKey = String(_exploreSort || 'trending');
    const cachedEntry = !force ? _exploreCache.get(cacheKey) : null;
    const exploreFresh = _cacheFresh(cachedEntry);
    const cached = _cacheUsable(cachedEntry) ? (cachedEntry.posts || []) : null;
    const cachedChannels = _cacheUsable(cachedEntry) ? (cachedEntry.channels || []) : [];
    if (cached) {
      _updateTabLoadUi(loadUi, exploreFresh ? 96 : 30, exploreFresh ? 'Explore ready' : 'Explore (cached) — refreshing…', `${cached.length} ${_exploreSort} posts ready`);
      _renderExploreContent(content, cached, cachedChannels);
      if (exploreFresh) {
        _finishTabLoadUi(loadUi);
        _schedBgPrefetch('explore');
        return;
      }
    } else {
      _updateTabLoadUi(loadUi, 12, 'Opening explore', 'No cache — building layout…');
      content.innerHTML = _exploreSkeletonHtml();
    }
    try {
      _updateTabLoadUi(loadUi, 30, 'Connecting to server', `Sending ${_exploreSort} explore request…`);
      // Fake-progress timers removed — see loadFeed.
      const postsReq = _apiOkJson(`/api/social/explore?lite=1&sort=${_exploreSort}&limit=24`, { posts: [] });
      const channelsReq = api('/api/directory/new').catch(() => null);

      _updateTabLoadUi(loadUi, 46, 'Downloading posts', `Fetching ${_exploreSort} ranked posts…`);
      const postsData = await postsReq;
      clearQueuedSteps();
      const posts = postsData.posts || [];
      // Paint posts immediately — don't block on /api/directory/new.
      // Use cached channels if we have any so the strip doesn't flicker;
      // the live channels response will patch in when it arrives.
      if (_currentTab !== 'explore') return;
      const _initialChannels = Array.isArray(cachedChannels) ? cachedChannels : [];
      _updateTabLoadUi(loadUi, 78, 'Building explore view', `${posts.length} post${posts.length !== 1 ? 's' : ''} ready`);
      _renderExploreContent(content, posts, _initialChannels);
      _animateSocialSwap(content);
      // Cache posts now; channels get folded in when the request resolves.
      _cacheSet(_exploreCache, cacheKey, { ts: Date.now(), posts, channels: _initialChannels });

      // Patch channels strip in async — same pattern as feed/stories.
      (async () => {
        const channelsRes = await channelsReq;
        if (!channelsRes || !channelsRes.ok) return;
        const channelsData = await channelsRes.json().catch(() => ({ channels: [] }));
        const channels = channelsData.channels || [];
        // Always update the cache, even if the user navigated away,
        // so the next visit has a real channels list.
        _cacheSet(_exploreCache, cacheKey, { ts: Date.now(), posts, channels });
        if (_currentTab !== 'explore') return;
        const host = document.getElementById('explore-channels-host');
        if (!host || !channels.length) return;
        const catIcons = {gaming:'🎮',music:'🎵',art:'🎨',tech:'💻',social:'💬',education:'📚',memes:'😂',crypto:'💰',sports:'⚽',other:'📦'};
        host.innerHTML = `<div class="explore-channels-section">
          <div class="explore-section-head">
            <span class="explore-section-title">📺 New Channels</span>
            <button class="explore-section-link" onclick="showChannelDirectory()">View all →</button>
          </div>
          <div class="explore-channels-scroll">${channels.slice(0, 8).map(ch => {
            const iconHtml = ch.icon && ch.icon.startsWith('data:image')
              ? `<img src="${esc(ch.icon)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
              : esc(ch.icon || '💬');
            return `<div class="explore-channel-card" onclick="viewChannelProfile(${jsStr(ch.name)})">
              <div class="explore-channel-icon">${iconHtml}</div>
              <div class="explore-channel-name">${esc(ch.name)}</div>
              <div class="explore-channel-meta">${catIcons[ch.category]||''} ${ch.member_count || 0} members</div>
            </div>`;
          }).join('')}</div>
        </div>`;
      })().catch(() => {});
    } catch {
      clearQueuedSteps();
      if (!cached && _currentTab === 'explore') {
        content.innerHTML = _socialErrorHTML('Could not load explore', 'Social.refreshExplore()', { ico: '🔍', sub: 'Couldn\u2019t reach the explore feed. Try again.' });
      }
    } finally {
      clearQueuedSteps();
      _schedBgPrefetch('explore');
      _finishTabLoadUi(loadUi);
    }
  }

  function refreshExplore() {
    return loadExplore(_exploreSort, { force: true });
  }

  // ── PROFILE ─────────────────────────────────────────────────────────────
  async function loadProfile(nickname) {
    if (!nickname) nickname = State.user?.nickname;
    _profileUser = nickname;
    const loadUi = _beginTabLoadUi('profile', 'Opening profile', `Looking up @${nickname}…`);
    const content = document.getElementById('social-content');
    content.innerHTML = `
      <div class="social-profile fade-in">
        <div class="sp-banner skel-block" style="height:140px;border-radius:0"></div>
        <div class="sp-header" style="padding:12px 16px">
          <div class="skel-circle" style="width:86px;height:86px;margin-top:-40px"></div>
          <div style="flex:1;margin-left:14px">
            <div class="skel-line" style="width:40%;height:16px;margin-bottom:8px"></div>
            <div class="skel-line" style="width:55%;height:10px;margin-bottom:6px"></div>
            <div class="skel-line" style="width:70%;height:10px"></div>
          </div>
        </div>
        <div style="padding:16px">${skelList(3, 36)}</div>
      </div>`;
    // Pre-flight the stories check for own profile in parallel with the profile API
    // so the story ring status is ready by the time we need to render it.
    const _selfNickGuess = String(nickname || '').toLowerCase();
    const _isSelfGuess = State.user && _selfNickGuess === String(State.user.nickname || '').toLowerCase();
    const _earlyStoriesReq = _isSelfGuess ? api('/api/social/stories').catch(() => null) : null;
    try {
      const cacheKey = _selfNickGuess;
      const cachedEntry = _profileCache.get(cacheKey);
      let u = null;
      if (_cacheFresh(cachedEntry) && cachedEntry.profile) {
        u = cachedEntry.profile;
        _updateTabLoadUi(loadUi, 44, 'Profile loaded from cache', `@${nickname}'s data ready`);
      } else {
        _updateTabLoadUi(loadUi, 28, 'Downloading profile', `Fetching @${nickname}'s info…`);
        const res = await api('/api/social/profile/' + encodeURIComponent(nickname));
        if (!res.ok) {
          // Only treat a clean 404 as "user doesn't exist". Transient failures
          // (5xx / 429 / network / timeout) get a retry button instead of
          // misreporting the user as missing.
          const status = Number(res.status) || 0;
          const safeNick = esc(String(nickname || ''));
          if (status === 404) {
            content.innerHTML = `<div class="social-empty">User @${safeNick} not found</div>`;
          } else {
            const label = status === 429 ? 'Slow down — too many requests'
                        : status === 401 || status === 403 ? 'You don\u2019t have access to this profile'
                        : 'Couldn\u2019t load profile';
            const subCopy = status === 429 ? 'You\u2019re hitting the rate limit. Wait a few seconds, then try again.'
                          : status === 401 || status === 403 ? 'This profile is private or restricted.'
                          : 'The server didn\u2019t answer in time. Tap retry once it settles.';
            content.innerHTML = _socialErrorHTML(label, `Social.openProfile('${safeNick}')`, { ico: '👤', sub: subCopy });
          }
          return;
        }
        u = await res.json();
        _profileCache.set(cacheKey, { ts: Date.now(), profile: u });
      }
      _profileData = u;

      // Fallback: if self profile says no story but stories feed includes
      // own active stories, patch story_status so ring remains visible.
      if (u.is_self && (!u.story_status || !u.story_status.count)) {
        _updateTabLoadUi(loadUi, 62, 'Loading stories', 'Checking story ring status…');
        try {
          // Reuse the pre-flighted request if it was for our own profile.
          const sr = _earlyStoriesReq ? await _earlyStoriesReq : await api('/api/social/stories');
          if (sr.ok) {
            const sd = await sr.json();
            const me = (sd.users || []).find(x => Number(x.user_id) === Number(u.id));
            if (me && Array.isArray(me.stories) && me.stories.length > 0) {
              u.story_status = {
                count: me.stories.length,
                has_unviewed: me.has_unviewed ? 1 : 0,
              };
            }
          }
        } catch {}
      }

      const isSelf = u.is_self;

      // Private profile fallback — server returned a minimal payload.
      if (u.private) {
        const canRequest = u.friend_status === 'none' || !u.friend_status;
        content.innerHTML = `
        <div class="social-profile fade-in sp-private">
          <div class="sp-banner" style="background:linear-gradient(135deg,#1a1320 0%,#0d0d12 60%)"></div>
          <div class="sp-header">
            <div class="sp-avatar">${UI.avatarEl(u.avatar, u.nickname, 86)}</div>
            <div class="sp-info">
              <div class="sp-name-row">
                <span class="sp-nick">${esc(u.nickname)}</span>
              </div>
              <div class="sp-private-note">
                <span class="sp-lock">🔒</span> This profile is private.
                Only @${esc(u.nickname)}'s friends can see posts, media, and channels.
              </div>
              <div class="sp-private-actions">
                ${canRequest
                  ? `<button class="sp-action-btn primary" onclick="Social.addFriendFromProfile('${esc(u.nickname)}',this)">+ Add Friend</button>`
                  : u.friend_status === 'sent'
                    ? `<button class="sp-action-btn secondary" disabled>Friend Request Sent</button>`
                    : u.friend_status === 'received'
                      ? `<button class="sp-action-btn primary" onclick="Social.acceptFriendFromProfile('${esc(u.nickname)}',this)">Accept Friend</button>`
                      : ''}
                <button class="sp-action-btn secondary" onclick="Social.dmUser('${esc(u.nickname)}')">💬 Message</button>
              </div>
            </div>
          </div>
        </div>`;
        return;
      }

      _updateTabLoadUi(loadUi, 86, 'Rendering profile', 'Preparing wall and tabs');

      content.innerHTML = `
      <div class="social-profile fade-in">
        <!-- Banner -->
        <div class="sp-banner" style="background:${u.banner ? `url('${esc(u.banner)}') center/cover` : 'linear-gradient(135deg,#1a3a1a 0%,#0d1f0d 50%,#1a2a1a 100%)'}">
          ${isSelf ? `<button class="sp-edit-btn" onclick="showProfile()" title="Edit Profile">✏️</button>` : ''}
        </div>

        <!-- Header -->
        <div class="sp-header">
          <div class="sp-avatar ${u.story_status?.count ? (u.story_status.has_unviewed ? 'has-story unviewed' : 'has-story viewed') : ''}"
               ${u.story_status?.count ? `onclick="Social.viewProfileStories('${esc(u.nickname)}',${u.id})" style="cursor:pointer" title="View stories"` : ''}>
            ${UI.avatarEl(u.avatar, u.nickname, 86)}
          </div>
          <div class="sp-info">
            <div class="sp-name-row">
              <span class="sp-nick">${u.is_admin ? '<span style="color:#ffd700">👑</span> ' : ''}${esc(u.nickname)}${isSelf && u.profile_public === false ? ' <span class="sp-privacy-badge" title="Your profile is private — only friends can view it">🔒 Private</span>' : ''}</span>
              ${isSelf
                ? `<button class="sp-action-btn secondary" onclick="Social.openNewPost()">+ New Post</button>
                   <button class="sp-share-btn" onclick="Social.shareProfile('${esc(u.nickname)}',this)" title="Copy share link">🔗 Share</button>`
                : `<button class="sp-action-btn ${u.is_following ? 'secondary' : 'primary'}" id="sp-follow-btn" onclick="Social.toggleFollow('${esc(u.nickname)}',this)">${u.is_following ? 'Following' : 'Follow'}</button>
                   ${u.friend_status === 'friends'
                     ? `<button class="sp-action-btn secondary" disabled>Friends ✓</button>`
                     : u.friend_status === 'sent'
                     ? `<button class="sp-action-btn secondary" disabled>Requested</button>`
                     : u.friend_status === 'received'
                     ? `<button class="sp-action-btn primary" onclick="Social.acceptFriendFromProfile('${esc(u.nickname)}',this)">Accept Friend</button>`
                     : `<button class="sp-action-btn secondary" onclick="Social.addFriendFromProfile('${esc(u.nickname)}',this)">+ Add Friend</button>`
                   }
                   <button class="sp-action-btn primary" onclick="Social.dmUser('${esc(u.nickname)}')" style="background:#4caf50;color:#000;font-weight:600">💬 Message</button>
                   <button class="sp-share-btn" onclick="Social.shareProfile('${esc(u.nickname)}',this)" title="Copy share link">🔗 Share</button>`
              }
            </div>
            <div class="sp-stats">
              <span class="sp-stat"><strong>${u.post_count}</strong> posts</span>
              <span class="sp-stat sp-stat-link" onclick="Social.showFollowers('${esc(u.nickname)}')"><strong>${u.follower_count}</strong> followers</span>
              <span class="sp-stat sp-stat-link" onclick="Social.showFollowing('${esc(u.nickname)}')"><strong>${u.following_count}</strong> following</span>
            </div>
            ${u.bio ? `<div class="sp-bio">${esc(u.bio)}</div>` : ''}
            ${u.status_msg || u.mood ? `<div class="sp-mood">${esc([u.status_msg, u.mood].filter(Boolean).join(' · '))}</div>` : ''}
            ${u.tags?.length ? `<div class="sp-tags">${u.tags.map(t => `<span class="sp-tag">${esc(t)}</span>`).join('')}</div>` : ''}
          </div>
        </div>

        <!-- Tabs -->
        <div class="sp-tabs">
          <button class="sp-tab active" data-pt="wall" onclick="Social.switchProfileTab('wall',this)">📝 Wall</button>
          <button class="sp-tab" data-pt="reels" onclick="Social.switchProfileTab('reels',this)">🎞 Reels</button>
          <button class="sp-tab" data-pt="music" onclick="Social.switchProfileTab('music',this)">🎵 Music</button>
          <button class="sp-tab" data-pt="channels" onclick="Social.switchProfileTab('channels',this)">📺 Channels</button>
          ${isSelf ? `<button class="sp-tab" data-pt="reposts" onclick="Social.switchProfileTab('reposts',this)">🔁 Reposts</button>` : ''}
          <button class="sp-tab" data-pt="media" onclick="Social.switchProfileTab('media',this)">🖼️ Media</button>
        </div>

        <!-- Posts area -->
        <div id="sp-posts" class="sp-posts">
          <div class="social-feed">${_socialPostSkeletonCards(3)}</div>
        </div>
      </div>`;

      const wallToken = _beginProfileTabLoad('wall');
      loadProfilePosts(nickname, 'wall', wallToken);
      _schedProfilePrefetch(nickname, isSelf);
    } catch {
      const _safeNick = esc(String(nickname || ''));
      content.innerHTML = _socialErrorHTML('Could not load profile', `Social.openProfile('${_safeNick}')`, { ico: '👤' });
    } finally {
      _schedBgPrefetch('profile');
      _finishTabLoadUi(loadUi);
    }
  }

  async function loadProfilePosts(nickname, view, loadToken = _profileTabLoadToken) {
    const container = document.getElementById('sp-posts');
    if (!container) return;
    const tabKey = view === 'music'
      ? 'music'
      : ((view === 'public-media' || view === 'media-public') ? 'media' : 'wall');
    try {
      const posts = await _fetchProfilePostsCached(nickname, loadToken, tabKey);
      if (posts === null) return; // tab switched

      if (view === 'public-media' || view === 'media-public') {
        // Public media = image/video posts only. Music shares have their
        // own tab — exclude them from this grid (their media_data is a URL,
        // not an image blob, so they'd render as broken thumbs here).
        const mediaPosts = posts.filter(p =>
          p.media_data && p.privacy !== 'private' &&
          p.media_type && (p.media_type.startsWith('image/') || p.media_type.startsWith('video/'))
        );
        if (mediaPosts.length === 0) {
          container.innerHTML = `<div class="social-empty" style="padding:40px 0">
            <div style="font-size:36px;margin-bottom:8px">🌍</div>
            <div style="font-size:15px;color:#888">No public media yet</div>
          </div>`;
          return;
        }
        container.innerHTML = `<div class="social-grid">${mediaPosts.map(p => {
          const isVideo = p.media_type && p.media_type.startsWith('video/');
          const thumb = isVideo
            ? `<video src="${esc(_authMediaSrc(p.media_data))}" poster="${esc(_authMediaThumb(p.media_data))}" muted preload="metadata"></video>`
            : `<img src="${esc(p.media_data)}" alt="" loading="lazy">`;
          return `
          <div class="social-grid-item ${isVideo ? 'is-video' : ''}" onclick="Social.viewPostDetail(${p.id})">
            ${thumb}
            ${String(nickname || '').toLowerCase() === String(State.user?.nickname || '').toLowerCase()
              ? `<button type="button" class="social-media-del-btn" title="Delete" aria-label="Delete media" onclick="event.stopPropagation();Social.promptDeletePostMedia(${p.id})">✕</button>`
              : ''}
            ${isVideo ? `<span class="social-grid-video-ico">▶</span>` : ''}
            <div class="social-grid-overlay">
              <span>❤️ ${p.reaction_count || 0}</span>
              <span>💬 ${p.comment_count || 0}</span>
            </div>
          </div>`;
        }).join('')}</div>`;
        return;
      }

      if (view === 'music') {
        // Music-only view on profiles — station/playlist style.
        const isMusic = (p) => {
          const mt = (p.media_type || '').toLowerCase();
          if (mt.startsWith('music/')) return true;
          const md = String(p.media_data || '');
          if (!md) return false;
          return /youtube\.com|youtu\.be|open\.spotify\.com|soundcloud\.com/i.test(md);
        };
        const musicPosts = posts.filter(isMusic);
        if (musicPosts.length === 0) {
          container.innerHTML = `<div class="social-empty" style="padding:40px 0">
            <div style="font-size:36px;margin-bottom:8px;opacity:.7">♫</div>
            <div style="font-size:15px;color:#888">No music shared yet</div>
          </div>`;
          return;
        }
        container.innerHTML = `<div class="social-feed sp-music-feed">${musicPosts.map(p => renderFeedPost(p)).join('')}</div>`;
        return;
      }

      // Default "wall" view: all posts (text + media) the viewer may see
      if (posts.length === 0) {
        container.innerHTML = `<div class="social-empty" style="padding:40px 0">
          <div style="font-size:36px;margin-bottom:8px">📝</div>
          <div style="font-size:15px;color:#888">Nothing on the wall yet</div>
        </div>`;
        return;
      }
      container.innerHTML = `<div class="social-feed">${posts.map(p => renderFeedPost(p)).join('')}</div>`;
    } catch {
      if (!_isProfileTabLoadCurrent(tabKey, loadToken)) return;
      const _safeNick = esc(String(nickname || ''));
      container.innerHTML = _socialErrorHTML('Could not load posts', `Social.openProfile('${_safeNick}')`, { ico: '📝' });
    }
  }

  function switchProfileTab(tab, btn) {
    document.querySelectorAll('.sp-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const token = _beginProfileTabLoad(tab);
    const container = document.getElementById('sp-posts');
    if (container) {
      if (tab === 'reels' || tab === 'media') {
        container.innerHTML = _spGridSkeletonHtml();
      } else if (tab === 'channels') {
        container.innerHTML = _spChannelsSkeletonHtml();
      } else {
        container.innerHTML = `<div class="social-feed">${_socialPostSkeletonCards(3)}</div>`;
      }
    }
    if (tab === 'channels') loadProfileChannels(_profileUser, token);
    else if (tab === 'reposts') loadProfileReposts(_profileUser, token);
    else if (tab === 'reels') loadProfileReels(_profileUser, token);
    else if (tab === 'media') loadProfileMediaCombined(_profileUser, 'public', token);
    else loadProfilePosts(_profileUser, tab, token);
  }

  function _profileMediaToggleHtml(nickname, mode) {
    const isPublic = mode !== 'private';
    const isSelf = String(nickname || '').toLowerCase() === String(State.user?.nickname || '').toLowerCase();
    return `
      <div class="sp-media-toggle" style="display:flex;gap:8px;align-items:center;margin:0 0 12px 0;flex-wrap:wrap">
        <button type="button" class="sp-action-btn ${isPublic ? 'primary' : 'secondary'} sp-media-toggle-btn"
          onclick="Social.switchProfileMediaMode('public',this)">🌍 Public</button>
        ${isSelf ? `<button type="button" class="sp-action-btn ${!isPublic ? 'primary' : 'secondary'} sp-media-toggle-btn"
          onclick="Social.switchProfileMediaMode('private',this)">🔒 Private</button>` : ''}
      </div>`;
  }

  async function switchProfileMediaMode(mode, btn) {
    try {
      const row = btn?.closest('.sp-media-toggle');
      row?.querySelectorAll('.sp-media-toggle-btn').forEach(b => {
        b.classList.remove('primary');
        if (!b.classList.contains('secondary')) b.classList.add('secondary');
      });
      if (btn) {
        btn.classList.remove('secondary');
        btn.classList.add('primary');
      }
    } catch {}
    await loadProfileMediaCombined(_profileUser, mode === 'private' ? 'private' : 'public', _profileTabLoadToken);
  }

  async function loadProfileMediaCombined(nickname, mode = 'public', loadToken = _profileTabLoadToken) {
    const container = document.getElementById('sp-posts');
    if (!container) return;
    const isSelf = String(nickname || '').toLowerCase() === String(State.user?.nickname || '').toLowerCase();
    const safeMode = (!isSelf && mode === 'private') ? 'public' : (mode === 'private' ? 'private' : 'public');
    const toggleHtml = _profileMediaToggleHtml(nickname, safeMode);
    if (safeMode !== 'private' && !container.querySelector('.social-grid')) {
      container.innerHTML = toggleHtml + _spGridSkeletonHtml();
    } else if (safeMode === 'private') {
      container.innerHTML = `${toggleHtml}<div class="social-feed">${_socialPostSkeletonCards(2)}</div>`;
    }

    if (safeMode === 'private') {
      try {
        const res = await api('/api/social/profile/' + encodeURIComponent(nickname) + '/media');
        if (!_isProfileTabLoadCurrent('media', loadToken)) return;
        const data = await res.json();
        const items = data.media || [];

        if (items.length === 0) {
          container.innerHTML = `${toggleHtml}<div class="social-empty" style="padding:32px 0">
            <div style="font-size:36px;margin-bottom:8px">🖼️</div>
            <div style="font-size:15px;color:#888">No private media yet</div>
            <div style="color:#666;font-size:12px;margin-top:6px">Media you send in channels shows here — only you can see it until you hit <em>Make Public</em>.</div>
          </div>`;
          return;
        }

        container.innerHTML = `${toggleHtml}<div class="social-media-grid">${items.map(item => {
          const isAudio = item.media_type && item.media_type.startsWith('audio');
          return `
          <div class="social-media-item" data-msg-id="${item.id}">
            <div class="social-media-thumb" onclick="Social.previewMedia(${item.id})">
              ${isAudio
                ? `<div class="social-media-audio-icon">🎵</div>`
                : `<img src="/api/messages/media/${item.id}?thumb=1" alt="" loading="lazy" onerror="this.closest('.social-media-item')?.remove()">`
              }
              <button type="button" class="social-media-del-btn" title="Delete" aria-label="Delete private media" onclick="event.stopPropagation();Social.promptDeletePrivateMedia(${item.id})">✕</button>
              <div class="social-media-info">
                <span>#${esc(item.room_name)}</span>
                <span>${timeAgo(item.created_at)}</span>
              </div>
            </div>
            <button class="social-media-wall-btn" onclick="Social.moveToWall(${item.id},this)" title="Post to Public Media">🌍 Make Public</button>
          </div>`;
        }).join('')}</div>`;
      } catch {
        if (!_isProfileTabLoadCurrent('media', loadToken)) return;
        container.innerHTML = `${toggleHtml}` + _socialErrorHTML('Could not load private media', "Social.switchProfileTab('media')", { ico: '🔒' });
      }
      return;
    }

    try {
      const posts = await _fetchProfilePostsCached(nickname, loadToken, 'media');
      if (posts === null) return;
      if (!_isProfileTabLoadCurrent('media', loadToken)) return;
      const mediaPosts = posts.filter(p =>
        p.media_data && p.privacy !== 'private' &&
        p.media_type && (p.media_type.startsWith('image/') || p.media_type.startsWith('video/'))
      );

      if (mediaPosts.length === 0) {
        container.innerHTML = `${toggleHtml}<div class="social-empty" style="padding:32px 0">
          <div style="font-size:36px;margin-bottom:8px">🌍</div>
          <div style="font-size:15px;color:#888">No public media yet</div>
        </div>`;
        return;
      }

      container.innerHTML = `${toggleHtml}<div class="social-grid">${mediaPosts.map(p => {
        const isVideo = p.media_type && p.media_type.startsWith('video/');
        const thumb = isVideo
          ? `<video src="${esc(_authMediaSrc(p.media_data))}" poster="${esc(_authMediaThumb(p.media_data))}" muted preload="metadata"></video>`
          : `<img src="${esc(p.media_data)}" alt="" loading="lazy">`;
        return `
          <div class="social-grid-item ${isVideo ? 'is-video' : ''}" onclick="Social.viewPostDetail(${p.id})">
            ${thumb}
            ${String(nickname || '').toLowerCase() === String(State.user?.nickname || '').toLowerCase()
              ? `<button type="button" class="social-media-del-btn" title="Delete" aria-label="Delete media" onclick="event.stopPropagation();Social.promptDeletePostMedia(${p.id})">✕</button>`
              : ''}
            ${isVideo ? `<span class="social-grid-video-ico">▶</span>` : ''}
            <div class="social-grid-overlay">
              <span>❤️ ${p.reaction_count || 0}</span>
              <span>💬 ${p.comment_count || 0}</span>
            </div>
          </div>`;
      }).join('')}</div>`;
    } catch {
      if (!_isProfileTabLoadCurrent('media', loadToken)) return;
      const _safeNick = esc(String(nickname || ''));
      container.innerHTML = `${toggleHtml}` + _socialErrorHTML('Could not load public media', "Social.switchProfileTab('media')", { ico: '🌍' });
    }
  }

  // ── REELS TAB ──────────────────────────────────────────────────────────────

  let _reelsScope = 'all';   // 'all' | 'friends'
  let _reelsSort  = 'hot';   // 'hot' | 'new' | 'top'
  let _reelsMuted = true;    // global mute state for all reels
  let _reelsCurrentVideo = null; // currently playing video element
  let _reelsCurrentCard = null;
  let _reelsObserver = null;
  let _reelsScrollRaf = 0;
  let _reelsScrollSnap = null;
  let _reelsSeekLockUntil = 0;
  let _reelsSeekCard = null;
  let _reelsSeekReleaseUntil = 0;
  let _reelsSeekReleaseCard = null;
  let _reelsUserPausedCard = null;
  let _reelsScrubController = null;
    let _reelsAutoPausedMusic = false;
    let _reelsAutoPausedMusicUrl = '';
    let _reelsMusicInterlockBusy = false;

    function _clearReelsMusicInterlock() {
      _reelsAutoPausedMusic = false;
      _reelsAutoPausedMusicUrl = '';
    }

    function _syncReelsMusicInterlock() {
      if (_reelsMusicInterlockBusy) return;
      _reelsMusicInterlockBusy = true;
      try {
        const M = window.Music;
        if (!M || typeof M.getCurrent !== 'function') {
          _clearReelsMusicInterlock();
          return;
        }
        const cur = M.getCurrent();
        const onReelsWithSound = _currentTab === 'reels' && !_reelsMuted;
        const sameTrack = !!(_reelsAutoPausedMusicUrl && cur && cur.active && cur.url === _reelsAutoPausedMusicUrl);

        if (onReelsWithSound) {
          if (!cur || !cur.active) {
            _clearReelsMusicInterlock();
            return;
          }
          if (_reelsAutoPausedMusic) {
            if (!sameTrack) _clearReelsMusicInterlock();
            return;
          }
          if (!cur.paused && typeof M.togglePauseGlobal === 'function' && M.togglePauseGlobal()) {
            _reelsAutoPausedMusic = true;
            _reelsAutoPausedMusicUrl = cur.url || '';
          }
          return;
        }

        if (!_reelsAutoPausedMusic) return;
        if (!cur || !cur.active || !sameTrack) {
          _clearReelsMusicInterlock();
          return;
        }
        if (cur.paused && typeof M.togglePauseGlobal === 'function') {
          M.togglePauseGlobal();
        }
        _clearReelsMusicInterlock();
      } catch {
        _clearReelsMusicInterlock();
      } finally {
        _reelsMusicInterlockBusy = false;
      }
    }

  function _reelsBeginSeek(card) {
    _reelsSeekCard = card || null;
    _reelsSeekLockUntil = Date.now() + 1800;
  }

  function _reelsExtendSeekLock(ms = 900) {
    _reelsSeekLockUntil = Math.max(_reelsSeekLockUntil, Date.now() + ms);
  }

  function _reelsEndSeek(card = null) {
    _reelsSeekLockUntil = Date.now() + 500;
    if (card) {
      _reelsSeekReleaseCard = card;
      _reelsSeekReleaseUntil = Date.now() + 1400;
    }
    setTimeout(() => {
      if (Date.now() > _reelsSeekLockUntil) _reelsSeekCard = null;
    }, 300);
  }

  function _reelsIsSeekLocked(card = null) {
    if (Date.now() > _reelsSeekLockUntil) return false;
    if (!card || !_reelsSeekCard) return true;
    return card === _reelsSeekCard;
  }

  function switchReelsScope(scope) {
    if (_reelsScope === scope) return;
    _reelsScope = scope;
    loadReelsTab();
  }

  function switchReelsSort(sort) {
    if (_reelsSort === sort) return;
    _reelsSort = sort;
    loadReelsTab();
  }

  function openSharedReel(postId) {
    const id = Number(postId);
    if (!Number.isFinite(id) || id <= 0) return;
    _reelsDirectLaunchId = id; // suppress scope-bar flash until reel is ready
    try {
      open('reels');
      switchTab('reels');
    } catch {}

    const tryFocus = (attemptsLeft, reloaded) => {
      const card = document.querySelector(`.reel-card[data-post-id="${id}"]`);
      if (card) {
        try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
        setTimeout(() => {
          try { _reelsActivateCard(card, { reset: true }); } catch {}
        }, 120);
        return;
      }
      if (attemptsLeft <= 0) {
        if (!reloaded) {
          loadReelsTab().finally(() => setTimeout(() => tryFocus(16, true), 120));
          return;
        }
        try { UI.showToast('This reel is unavailable right now', 'info'); } catch {}
        return;
      }
      setTimeout(() => tryFocus(attemptsLeft - 1, reloaded), 120);
    };
    tryFocus(20, false);
  }

  async function loadReelsTab() {
    _ensureSocialVideoObserver();
    const content = document.getElementById('social-content');
    if (!content) return;
    // Fast-path: fresh cache for current scope/sort → paint cached reels,
    // re-init observers, skip the banner and network.
    {
      const _scope = _reelsScope, _sort = _reelsSort;
      const _entry = _reelsCache.get(`${_scope}:${_sort}`);
      if (_entry && _cacheFresh(_entry) && Array.isArray(_entry.posts) && _entry.posts.length) {
        _teardownReels();
        const cards = _entry.posts.map(p => _renderReelCard(p)).join('');
        const scopeBar = `
          <div class="reels-scope-bar">
            <button class="rsb-pill ${_scope==='all'?'active':''}" onclick="Social.switchReelsScope('all')">🌐 All</button>
            <button class="rsb-pill ${_scope==='friends'?'active':''}" onclick="Social.switchReelsScope('friends')">👥 Friends</button>
            <div class="rsb-sort">
              <button class="rsb-sort-chip ${_sort==='hot'?'active':''}" onclick="Social.switchReelsSort('hot')">🔥 Hot</button>
              <button class="rsb-sort-chip ${_sort==='new'?'active':''}" onclick="Social.switchReelsSort('new')">🆕 New</button>
              <button class="rsb-sort-chip ${_sort==='top'?'active':''}" onclick="Social.switchReelsSort('top')">⭐ Top</button>
            </div>
          </div>`;
        content.innerHTML = scopeBar + `
          <div class="reels-stage" id="reels-stage">
            <div class="reels-snap" id="reels-snap">${cards}</div>
          </div>`;
        const snap = document.getElementById('reels-snap');
        if (snap) { _initReelCards(snap); _reelsAutoplayVisible(); }
        _schedBgPrefetch('reels');
        return;
      }
    }
    const loadUi = _beginTabLoadUi('reels', 'Opening reels', 'Checking reel cache…');
    const loadToken = ++_reelsLoadToken;
    const directLaunchId = _reelsDirectLaunchId;
    _reelsDirectLaunchId = 0; // consume so a re-enter doesn't re-suppress
    _teardownReels();
    const smoothStepTimers = [];

    const queueLoadStep = (delayMs, pct, label, detail) => {
      const t = setTimeout(() => {
        if (_currentTab !== 'reels' || loadToken !== _reelsLoadToken) return;
        _updateTabLoadUi(loadUi, pct, label, detail);
      }, Math.max(0, Number(delayMs) || 0));
      smoothStepTimers.push(t);
    };

    const clearQueuedSteps = () => {
      while (smoothStepTimers.length) {
        clearTimeout(smoothStepTimers.pop());
      }
    };

    const scope = _reelsScope;
    const sort  = _reelsSort;

    const scopeBar = `
      <div class="reels-scope-bar">
        <button class="rsb-pill ${scope==='all'?'active':''}" onclick="Social.switchReelsScope('all')">🌐 All</button>
        <button class="rsb-pill ${scope==='friends'?'active':''}" onclick="Social.switchReelsScope('friends')">👥 Friends</button>
        <div class="rsb-sort">
          <button class="rsb-sort-chip ${sort==='hot'?'active':''}" onclick="Social.switchReelsSort('hot')">🔥 Hot</button>
          <button class="rsb-sort-chip ${sort==='new'?'active':''}" onclick="Social.switchReelsSort('new')">🆕 New</button>
          <button class="rsb-sort-chip ${sort==='top'?'active':''}" onclick="Social.switchReelsSort('top')">⭐ Top</button>
        </div>
      </div>`;

    const cacheKey = `${scope}:${sort}`;
    const cachedEntry = _reelsCache.get(cacheKey);
    const reelsFresh = _cacheFresh(cachedEntry);
    const cachedPosts = _cacheUsable(cachedEntry) ? (cachedEntry.posts || []) : null;
    if (cachedPosts && cachedPosts.length) {
      const cachedCards = cachedPosts.map(p => _renderReelCard(p)).join('');
      content.innerHTML = scopeBar + `
        <div class="reels-stage" id="reels-stage">
          <div class="reels-snap" id="reels-snap">${cachedCards}</div>
        </div>`;
      _updateTabLoadUi(loadUi, reelsFresh ? 96 : 22, reelsFresh ? 'Reels ready' : 'Reels (cached) — refreshing…', `${cachedPosts.length} reel${cachedPosts.length !== 1 ? 's' : ''} ready`);
      const snap = document.getElementById('reels-snap');
      if (snap) {
        _initReelCards(snap);
        _reelsAutoplayVisible();
        if (!reelsFresh) _updateTabLoadUi(loadUi, 38, 'Resuming cached reels', 'Restoring reel playback…');
      }
      if (reelsFresh) {
        _finishTabLoadUi(loadUi);
        _schedBgPrefetch('reels');
        return;
      }
    } else {
      content.innerHTML = _reelsSkeletonHtml(scope, sort);
      _updateTabLoadUi(loadUi, 16, 'Building reels layout', 'No cache — loading fresh reels…');
    }

    try {
      _updateTabLoadUi(loadUi, 42, 'Downloading reels', `${scope === 'friends' ? 'Friends' : 'All'} reels · ${sort} order`);
      // Fake-progress timers removed — see loadFeed.
      const res = await api(`/api/social/reels?scope=${scope}&sort=${sort}&limit=20`).catch(() => null);
      clearQueuedSteps();
      if (_currentTab !== 'reels' || loadToken !== _reelsLoadToken) return;
      _updateTabLoadUi(loadUi, 68, 'Processing reels', 'Parsing reel data…');
      const data = res && res.ok ? await res.json() : { posts: [] };
      const posts = data.posts || [];
      _cacheSet(_reelsCache, cacheKey, { ts: Date.now(), posts });

      if (posts.length === 0) {
        _updateTabLoadUi(loadUi, 78, 'Rendering reels', 'No reels found for this filter');
        content.innerHTML = scopeBar + `
          <div class="reels-empty">
            <div class="reels-empty-icon">🎞</div>
            <div class="reels-empty-title">${scope === 'friends' ? 'No friend reels yet' : 'No reels yet'}</div>
            <div class="reels-empty-sub">${scope === 'friends'
              ? 'Reels posted, reposted, or liked by your friends will appear here.'
              : 'When people share videos they\'ll show up here. Be the first!'}</div>
          </div>`;
        _updateTabLoadUi(loadUi, 92, 'Reels ready', 'Try another scope or sort to discover videos');
        return;
      }

      const cards = posts.map(p => _renderReelCard(p)).join('');
      _updateTabLoadUi(loadUi, 74, 'Rendering reels', `${posts.length} reels loaded`);
      content.innerHTML = scopeBar + `
        <div class="reels-stage is-loading" id="reels-stage">
          <div class="social-loading reels-stage-loading">Preparing reel playback…</div>
          <div class="reels-snap" id="reels-snap">${cards}</div>
        </div>`;
      _updateTabLoadUi(loadUi, 82, 'Preparing reels stage', 'Mounting reel cards');
      _animateSocialSwap(content);
      const snap = document.getElementById('reels-snap');
      if (snap) {
        _initReelCards(snap);
        _updateTabLoadUi(loadUi, 88, 'Preparing reels stage', 'Binding playback controls');
        _armReelsStageReveal(snap, loadToken);
        // Start playback immediately so users transition from loading to motion fast.
        _reelsAutoplayVisible();
        _updateTabLoadUi(loadUi, 93, 'Loading reel media', 'Priming first playable video');
      }

      // IntersectionObserver: pause/play as cards scroll into/out of view
      if (snap && window.IntersectionObserver) {
        _reelsObserver = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            const vid = entry.target.querySelector('video');
            if (!vid) return;
            if (entry.isIntersecting) {
              if (_reelsIsSeekLocked()) return;
              _reelsActivateCard(entry.target, { reset: false });
            } else {
              try { vid.pause(); } catch {}
              entry.target.classList.remove('is-playing');
            }
          });
        }, { root: snap, threshold: 0.6 });
        snap.querySelectorAll('.reel-card').forEach(card => _reelsObserver.observe(card));
      }

      if (snap) {
        _reelsScrollSnap = snap;
        const onScroll = () => {
          if (_reelsScrollRaf) return;
          _reelsScrollRaf = requestAnimationFrame(() => {
            _reelsScrollRaf = 0;
            _reelsSyncActiveFromScroll(snap);
          });
        };
        snap._reelsOnScroll = onScroll;
        snap.addEventListener('scroll', onScroll, { passive: true });
        _updateTabLoadUi(loadUi, 97, 'Finalizing reels', 'Snap controls ready');
      }
    } catch (e) {
      clearQueuedSteps();
      content.innerHTML = scopeBar + _socialErrorHTML('Could not load reels', 'Social.loadReelsTab()', { ico: '🎞️', sub: 'Reels couldn\u2019t fetch. Tap retry to try again.' });
    } finally {
      clearQueuedSteps();
      _schedBgPrefetch('reels');
      _finishTabLoadUi(loadUi);
    }
  }

  function _reelsActivateCard(card, opts = {}) {
    if (!card || !card.classList.contains('reel-card')) return;
    const reset = opts.reset !== false;
    const seekReleaseGuard = card === _reelsSeekReleaseCard && Date.now() < _reelsSeekReleaseUntil;
    const seekLiveGuard = _reelsIsSeekLocked(card);
    const userPausedThisCard = _reelsUserPausedCard === card;
    const shouldReset = (_reelsCurrentCard !== card) && reset && !seekReleaseGuard && !seekLiveGuard;
    document.querySelectorAll('.reels-snap .reel-card').forEach(c => {
      if (c === card) return;
      const v = c.querySelector('video');
      if (v) {
        try { v.pause(); } catch {}
      }
      c.classList.remove('is-playing');
    });
    const v = card.querySelector('video');
    if (!v) return;
    _reelsCurrentCard = card;
    _reelsCurrentVideo = v;
    if (_reelsUserPausedCard && _reelsUserPausedCard !== card) _reelsUserPausedCard = null;
    v.muted = _reelsMuted;
    _syncReelMuteUi(card);
    if (shouldReset) {
      try { v.currentTime = 0; } catch {}
    }
    if (!userPausedThisCard || opts.forcePlay) {
      _reelsPlayVideo(card, v);
      card.classList.add('is-playing');
    } else {
      card.classList.remove('is-playing');
    }
  }

  function _reelsPlayVideo(card, video, attempt = 0) {
    if (!card || !video || card !== _reelsCurrentCard) return;
    try { video.muted = _reelsMuted; } catch {}
    const run = video.play?.();
    if (!run || typeof run.catch !== 'function') {
      card.classList.add('is-playing');
      return;
    }
    run.then(() => {
      if (_reelsUserPausedCard === card) _reelsUserPausedCard = null;
      card.classList.add('is-playing');
    }).catch(() => {
      if (card !== _reelsCurrentCard || attempt >= 6) return;
      const retry = () => {
        if (card !== _reelsCurrentCard) return;
        setTimeout(() => _reelsPlayVideo(card, video, attempt + 1), 40);
      };
      video.addEventListener('loadeddata', retry, { once: true });
      video.addEventListener('canplay', retry, { once: true });
      setTimeout(() => _reelsPlayVideo(card, video, attempt + 1), 180);
    });
  }

  function _reelsSyncActiveFromScroll(snap) {
    if (!snap) return;
    if (_reelsIsSeekLocked()) return;
    const cards = Array.from(snap.querySelectorAll('.reel-card'));
    if (!cards.length) return;
    const rootRect = snap.getBoundingClientRect();
    const centerY = rootRect.top + (rootRect.height / 2);
    let best = null;
    let bestDist = Infinity;
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      const c = r.top + (r.height / 2);
      const d = Math.abs(c - centerY);
      if (d < bestDist) {
        bestDist = d;
        best = card;
      }
    }
    if (!best) return;
    if (best !== _reelsCurrentCard) {
      _reelsActivateCard(best, { reset: false });
      return;
    }
    if (_reelsCurrentVideo && _reelsCurrentVideo.paused && _reelsUserPausedCard !== _reelsCurrentCard) {
      _reelsCurrentVideo.play().catch(() => {});
      _reelsCurrentCard?.classList.add('is-playing');
    }
  }

  function _reelsAutoplayVisible() {
    const snap = document.getElementById('reels-snap');
    if (!snap) return;
    const firstCard = snap.querySelector('.reel-card');
    if (firstCard) _reelsActivateCard(firstCard, { reset: true });
  }

  function _waitForFirstReelPreview(snap) {
    return new Promise((resolve) => {
      const firstCard = snap?.querySelector('.reel-card');
      if (!firstCard) { resolve(); return; }
      if (firstCard.classList.contains('is-ready') || firstCard.classList.contains('no-poster')) {
        resolve();
        return;
      }
      const start = Date.now();
      const tick = () => {
        if (!firstCard.isConnected) { resolve(); return; }
        if (firstCard.classList.contains('is-ready') || firstCard.classList.contains('no-poster')) {
          resolve();
          return;
        }
        if (Date.now() - start > 1400) { resolve(); return; }
        setTimeout(tick, 40);
      };
      tick();
    });
  }

  function _waitForFirstReelPlayable(snap) {
    return new Promise((resolve) => {
      const firstCard = snap?.querySelector('.reel-card');
      const firstVideo = firstCard?.querySelector?.('video');
      if (!firstCard || !firstVideo) { resolve(); return; }
      const readyNow = firstCard.classList.contains('is-playing') || firstVideo.readyState >= 2;
      if (readyNow) { resolve(); return; }
      const start = Date.now();
      const tick = () => {
        if (!firstCard.isConnected) { resolve(); return; }
        if (firstCard.classList.contains('is-playing') || firstVideo.readyState >= 2) {
          resolve();
          return;
        }
        if (Date.now() - start > 2600) { resolve(); return; }
        setTimeout(tick, 40);
      };
      tick();
    });
  }

  function _reelsRevealStage(loadToken) {
    if (_currentTab !== 'reels' || loadToken !== _reelsLoadToken) return;
    const stage = document.getElementById('reels-stage');
    if (stage) stage.classList.remove('is-loading');
  }

  function _armReelsStageReveal(snap, loadToken) {
    const firstCard = snap?.querySelector('.reel-card');
    const firstVideo = firstCard?.querySelector?.('video');
    if (!firstCard || !firstVideo) {
      _reelsRevealStage(loadToken);
      return;
    }
    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      _reelsRevealStage(loadToken);
    };
    const hasRealFirstFrame = () => {
      if (!firstCard?.isConnected || !firstVideo?.isConnected) return false;
      if (firstCard.classList.contains('is-ready')) return true;
      if (firstCard.classList.contains('no-poster') && ((firstVideo.readyState || 0) >= 2 || Number(firstVideo.currentTime || 0) > 0.03)) return true;
      return false;
    };
    const maybeReveal = () => {
      if (hasRealFirstFrame()) {
        reveal();
      }
    };
    firstVideo.addEventListener('loadeddata', maybeReveal, { once: true });
    firstVideo.addEventListener('canplay', maybeReveal, { once: true });
    firstVideo.addEventListener('playing', maybeReveal, { once: true });
    firstVideo.addEventListener('seeked', maybeReveal, { once: true });
    firstVideo.addEventListener('timeupdate', maybeReveal, { once: true });
    if (hasRealFirstFrame()) {
      reveal();
      return;
    }
    // Prefer waiting for an actual frame before reveal to avoid grey pre-frame flashes.
    setTimeout(() => {
      maybeReveal();
    }, 1800);
    // Rescue path: try to decode one tiny frame before giving up.
    setTimeout(() => {
      if (revealed) return;
      if (!hasRealFirstFrame()) {
        try {
          const p = firstVideo.play?.();
          if (p && typeof p.then === 'function') {
            p.then(() => {
              setTimeout(() => {
                if (firstCard !== _reelsCurrentCard) {
                  try { firstVideo.pause(); } catch {}
                }
                maybeReveal();
              }, 120);
            }).catch(() => {});
          }
        } catch {}
      }
      setTimeout(() => {
        if (revealed) return;
        maybeReveal();
      }, 900);
    }, 3200);
    // Hard stop: never leave the loading gate indefinitely.
    setTimeout(() => {
      if (revealed) return;
      reveal();
    }, 4600);
  }

  function _reelsAdvanceFrom(card) {
    const snap = card?.closest?.('.reels-snap') || document.getElementById('reels-snap');
    if (!snap) return;
    const cards = Array.from(snap.querySelectorAll('.reel-card'));
    if (!cards.length) return;
    const idx = Math.max(0, cards.indexOf(card));
    const next = cards[idx + 1] || cards[0] || null;
    if (!next) return;
    if (next === card) {
      const v = card.querySelector('video');
      if (v) {
        try { v.currentTime = 0; } catch {}
        _reelsPlayVideo(card, v);
      }
      return;
    }
    next.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => {
      if (_currentTab !== 'reels') return;
      _reelsActivateCard(next, { reset: true });
    }, 220);
  }

  function _teardownReels() {
    if (_reelsScrubController) {
      try { _reelsScrubController.abort(); } catch {}
      _reelsScrubController = null;
    }
    if (_reelsObserver) {
      try { _reelsObserver.disconnect(); } catch {}
      _reelsObserver = null;
    }
    const snap = _reelsScrollSnap || document.getElementById('reels-snap');
    if (snap && snap._reelsOnScroll) {
      try { snap.removeEventListener('scroll', snap._reelsOnScroll); } catch {}
      try { delete snap._reelsOnScroll; } catch {}
    }
    _reelsScrollSnap = null;
    if (_reelsScrollRaf) {
      try { cancelAnimationFrame(_reelsScrollRaf); } catch {}
      _reelsScrollRaf = 0;
    }
    document.querySelectorAll('.reels-snap video').forEach(v => {
      try { v.pause(); } catch {}
    });
    _reelsCurrentVideo = null;
    _reelsCurrentCard = null;
  }

  function _initReelCards(snap) {
    _syncReelMuteUi(snap);
    if (_reelsScrubController) { try { _reelsScrubController.abort(); } catch {} }
    const scrubAbort = new AbortController();
    _reelsScrubController = scrubAbort;
    const firstCardInList = snap.querySelector('.reel-card');
    snap.querySelectorAll('.reel-card').forEach(card => {
      const video = card.querySelector('video');
      const poster = card.querySelector('.reel-video-poster');
      const prog = card.querySelector('.reel-progress > span');
      const progWrap = card.querySelector('.reel-progress');
      if (!video) return;
      try { video.removeAttribute('controls'); } catch {}
      try { video.controls = false; } catch {}
      let posterDrawn = false;
      let seeking = false;

      const drawPoster = () => {
        try {
          if (posterDrawn) return;
          if (!poster || !video.videoWidth || !video.videoHeight) return;
          const c = document.createElement('canvas');
          const maxW = 320;
          c.width = Math.min(video.videoWidth, maxW);
          c.height = Math.max(1, Math.round(c.width * (video.videoHeight / video.videoWidth)));
          const ctx = c.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(video, 0, 0, c.width, c.height);
          poster.style.backgroundImage = `url(${c.toDataURL('image/jpeg', 0.72)})`;
          card.classList.add('is-ready');
          card.classList.remove('no-poster');
          posterDrawn = true;
          if (_reelsCurrentCard === card && video.paused) _reelsPlayVideo(card, video);
        } catch {}
      };

      video.addEventListener('loadeddata', drawPoster, { once: true });
      video.addEventListener('canplay', drawPoster);
      video.addEventListener('seeked', drawPoster);
      video.addEventListener('playing', drawPoster);
      video.addEventListener('loadedmetadata', () => {
        try {
          if (!Number.isFinite(video.duration) || video.duration <= 0.12) return;
          // Do not offset the currently active reel; keep true autoplay start.
          if (card === _reelsCurrentCard) return;
          if (video.currentTime > 0) return;
          video.currentTime = Math.min(0.12, Math.max(0.06, video.duration / 10));
        } catch {}
      }, { once: true });
      if (card === firstCardInList) {
        video.addEventListener('loadedmetadata', () => {
          // Force-decode a tiny first frame for the first visible reel.
          if (posterDrawn || !card.isConnected) return;
          // If this card is already active/playing, don't pause it for decode.
          if (card === _reelsCurrentCard || !video.paused) {
            try { drawPoster(); } catch {}
            return;
          }
          const finish = () => {
            try { drawPoster(); } catch {}
            if (_reelsCurrentCard === card && video.paused) _reelsPlayVideo(card, video);
          };
          try {
            const p = video.play?.();
            if (p && typeof p.then === 'function') {
              p.then(() => {
                setTimeout(() => {
                  try { video.pause(); } catch {}
                  finish();
                }, 80);
              }).catch(() => finish());
            } else {
              finish();
            }
          } catch {
            finish();
          }
        }, { once: true });
      }
      try { video.load(); } catch {}
      // Prime a visible first frame quickly (like feed/explore cards) to avoid
      // showing a flat grey/blank surface while users wait.
      setTimeout(() => {
        if (posterDrawn || !card.isConnected) return;
        if ((video.readyState || 0) < 2) return;
        try {
          const wasPaused = !!video.paused;
          const prev = Number(video.currentTime || 0);
          video.currentTime = Math.min(0.14, Math.max(0.06, (video.duration || 0.2) / 10));
          drawPoster();
          if (wasPaused) {
            try { video.currentTime = prev; } catch {}
          }
        } catch {}
      }, 320);
      setTimeout(() => {
        if (!posterDrawn) {
          const hasFrame = (video.readyState || 0) >= 2 || Number(video.currentTime || 0) > 0.03;
          if (hasFrame) {
            card.classList.add('no-poster');
            if (_reelsCurrentCard === card && video.paused) _reelsPlayVideo(card, video);
          }
        }
      }, 2600);

      video.addEventListener('timeupdate', () => {
        if (!prog || !video.duration) return;
        prog.style.width = `${Math.min(100, Math.max(0, (video.currentTime / video.duration) * 100))}%`;
        if (!posterDrawn && video.currentTime > 0.03) drawPoster();
      });
      const seekFromClientX = (clientX) => {
        if (!progWrap || !Number.isFinite(video.duration) || video.duration <= 0) return;
        const r = progWrap.getBoundingClientRect();
        if (!r.width) return;
        const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        try { video.currentTime = ratio * video.duration; } catch {}
        if (prog) prog.style.width = `${Math.round(ratio * 10000) / 100}%`;
      };
      if (progWrap) {
        const snap = progWrap.closest('.reels-snap');
        let restoreSnapType = '';
        let snapLockTimer = 0;
        let wasPlayingBeforeSeek = false;
        let ignoreClickUntil = 0;
        const clearLockTimer = () => {
          if (!snapLockTimer) return;
          try { clearTimeout(snapLockTimer); } catch {}
          snapLockTimer = 0;
        };
        const armLockFailsafe = () => {
          clearLockTimer();
          snapLockTimer = setTimeout(() => {
            seeking = false;
            touchSeeking = false;
            _reelsEndSeek(card);
            unlockSnapScroll();
          }, 1200);
        };
        const lockSnapScroll = () => {
          if (!snap) return;
          restoreSnapType = snap.style.scrollSnapType || '';
          snap.style.scrollSnapType = 'none';
          snap.style.overflowY = 'hidden';
          snap.style.touchAction = 'none';
          armLockFailsafe();
        };
        const unlockSnapScroll = () => {
          if (!snap) return;
          snap.style.scrollSnapType = restoreSnapType;
          snap.style.overflowY = '';
          snap.style.touchAction = '';
          clearLockTimer();
        };

        progWrap.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          seeking = true;
          _reelsBeginSeek(card);
          wasPlayingBeforeSeek = !video.paused;
          _reelsUserPausedCard = card;
          if (wasPlayingBeforeSeek) {
            try { video.pause(); } catch {}
          }
          card.classList.remove('is-playing');
          lockSnapScroll();
          try { progWrap.setPointerCapture(e.pointerId); } catch {}
          seekFromClientX(e.clientX);
        });
        progWrap.addEventListener('pointermove', (e) => {
          if (!seeking) return;
          e.preventDefault();
          armLockFailsafe();
          _reelsExtendSeekLock();
          seekFromClientX(e.clientX);
        });
        const stopSeek = (e) => {
          if (!seeking) return;
          seeking = false;
          try { progWrap.releasePointerCapture(e.pointerId); } catch {}
          if (typeof e.clientX === 'number') seekFromClientX(e.clientX);
          _reelsEndSeek(card);
          unlockSnapScroll();
          if (wasPlayingBeforeSeek && video.paused) {
            _reelsUserPausedCard = null;
            _reelsPlayVideo(card, video);
          }
          wasPlayingBeforeSeek = false;
          ignoreClickUntil = Date.now() + 420;
        };
        progWrap.addEventListener('pointerup', stopSeek);
        progWrap.addEventListener('pointercancel', () => {
          seeking = false;
          _reelsEndSeek(card);
          unlockSnapScroll();
          if (wasPlayingBeforeSeek && video.paused) {
            _reelsUserPausedCard = null;
            _reelsPlayVideo(card, video);
          }
          wasPlayingBeforeSeek = false;
          ignoreClickUntil = Date.now() + 420;
        });
        // Fallback: keep scrubbing even if pointer leaves the progress bar.
        document.addEventListener('pointermove', (e) => {
          if (!seeking) return;
          armLockFailsafe();
          _reelsExtendSeekLock();
          seekFromClientX(e.clientX);
        }, { passive: true, signal: scrubAbort.signal });
        document.addEventListener('pointerup', (e) => {
          if (!seeking) return;
          stopSeek(e);
        }, { passive: true, signal: scrubAbort.signal });
        progWrap.addEventListener('click', (e) => {
          if (Date.now() < ignoreClickUntil) return;
          if (typeof e.clientX !== 'number') return;
          e.preventDefault();
          e.stopPropagation();
          _reelsBeginSeek(card);
          seekFromClientX(e.clientX);
          _reelsEndSeek(card);
        });

        // Mobile fallback for browsers that don't deliver pointer events reliably.
        let touchSeeking = false;
        progWrap.addEventListener('touchstart', (e) => {
          const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
          if (!t) return;
          e.preventDefault();
          e.stopPropagation();
          touchSeeking = true;
          _reelsBeginSeek(card);
          wasPlayingBeforeSeek = !video.paused;
          _reelsUserPausedCard = card;
          if (wasPlayingBeforeSeek) {
            try { video.pause(); } catch {}
          }
          card.classList.remove('is-playing');
          lockSnapScroll();
          seekFromClientX(t.clientX);
        }, { passive: false });
        progWrap.addEventListener('touchmove', (e) => {
          if (!touchSeeking) return;
          const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
          if (!t) return;
          e.preventDefault();
          armLockFailsafe();
          _reelsExtendSeekLock();
          seekFromClientX(t.clientX);
        }, { passive: false });
        const stopTouchSeek = (e) => {
          if (!touchSeeking) return;
          const t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
          touchSeeking = false;
          if (t) seekFromClientX(t.clientX);
          _reelsEndSeek(card);
          unlockSnapScroll();
          if (wasPlayingBeforeSeek && video.paused) {
            _reelsUserPausedCard = null;
            _reelsPlayVideo(card, video);
          }
          wasPlayingBeforeSeek = false;
          ignoreClickUntil = Date.now() + 520;
        };
        progWrap.addEventListener('touchend', stopTouchSeek, { passive: true });
        progWrap.addEventListener('touchcancel', () => {
          touchSeeking = false;
          _reelsEndSeek(card);
          unlockSnapScroll();
          if (wasPlayingBeforeSeek && video.paused) {
            _reelsUserPausedCard = null;
            _reelsPlayVideo(card, video);
          }
          wasPlayingBeforeSeek = false;
          ignoreClickUntil = Date.now() + 520;
        }, { passive: true });
        // Fallback: continue touch scrub while finger moves off element.
        document.addEventListener('touchmove', (e) => {
          if (!touchSeeking) return;
          const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
          if (!t) return;
          e.preventDefault();
          armLockFailsafe();
          _reelsExtendSeekLock();
          seekFromClientX(t.clientX);
        }, { passive: false, signal: scrubAbort.signal });
        document.addEventListener('touchend', (e) => {
          if (!touchSeeking) return;
          stopTouchSeek(e);
        }, { passive: true, signal: scrubAbort.signal });
      }
      video.addEventListener('play', () => card.classList.add('is-playing'));
      video.addEventListener('pause', () => {
        // Activation can emit transient pause events before first real frame;
        // keep the playing-state UI during that short bootstrap window.
        if (card === _reelsCurrentCard && !video.ended && Number(video.currentTime || 0) <= 0.15) return;
        card.classList.remove('is-playing');
      });
      video.addEventListener('ended', () => {
        card.classList.remove('is-playing');
        if (_currentTab !== 'reels') return;
        if (_reelsCurrentCard && _reelsCurrentCard !== card) return;
        _reelsAdvanceFrom(card);
      });
      video.addEventListener('click', (e) => toggleReelPlayback(e, video));
    });
  }

  function toggleReelPlayback(ev, video) {
    try {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
    } catch {}
    if (!video) return;
    const card = video.closest('.reel-card');
    if (video.paused) {
      if (card && _reelsUserPausedCard === card) _reelsUserPausedCard = null;
      video.play().catch(() => {});
    } else {
      if (card) _reelsUserPausedCard = card;
      video.pause();
    }
  }

  function toggleReelMute(btn) {
    _reelsMuted = !_reelsMuted;
    // Apply to all currently rendered videos
    document.querySelectorAll('.reels-snap video').forEach(v => { v.muted = _reelsMuted; });
    _syncReelMuteUi();
      try { _syncReelsMusicInterlock(); } catch {}
    if (btn) btn.textContent = _reelsMuted ? '🔇' : '🔊';
  }

  function _syncReelMuteUi(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    root.querySelectorAll('.reel-mute-btn').forEach(btn => {
      btn.textContent = _reelsMuted ? '🔇' : '🔊';
      btn.setAttribute('aria-label', _reelsMuted ? 'Unmute reel' : 'Mute reel');
      btn.title = _reelsMuted ? 'Unmute' : 'Mute';
    });
  }

  function openReelReactPicker(postId, btn) {
    // Close any open pickers first
    document.querySelectorAll('.reel-react-picker').forEach(p => p.remove());

    const card = btn.closest('.reel-card');
    if (!card) return;

    const emojis = ['❤️','🔥','😂','😮','😢','👏','💯','🎉','💪','😍'];
    const rows = [];
    for (let i = 0; i < emojis.length; i += 5) {
      rows.push(`<div class="reel-react-row">${emojis.slice(i, i+5).map(e =>
        `<button class="reel-react-emoji" onclick="Social._reelPickEmoji(${postId},'${e}',this)">${e}</button>`
      ).join('')}</div>`);
    }
    const picker = document.createElement('div');
    picker.className = 'reel-react-picker';
    picker.innerHTML = rows.join('');
    card.appendChild(picker);
    // Dismiss on outside click
    setTimeout(() => {
      const dismiss = (ev) => {
        if (!picker.contains(ev.target)) { picker.remove(); document.removeEventListener('click', dismiss, true); }
      };
      document.addEventListener('click', dismiss, true);
    }, 10);
  }

  async function _reelPickEmoji(postId, emoji, btn) {
    btn.closest('.reel-react-picker')?.remove();
    const myNick = String(State?.user?.nickname || '');
    try {
      const res = await api(`/api/wall/posts/${postId}/reactions`, 'POST', { emoji });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const reactions = _normalizeReactions(data.reactions || []);
        _updateReactionsInCaches(postId, reactions);
        _updateAllPostReactionBars(postId, reactions, myNick);
        _updateReelReactionUi(postId, reactions, myNick);
      }
    } catch {}
  }

  function _renderReelCard(post) {
    const videoSrc = esc(_authMediaSrc(post.media_data || ''));
    const nick = esc(post.nickname || '');
    const rawNick = post.nickname || '';
    const avatarSrc = post.avatar ? esc(post.avatar) : '';
    const avatarHtml = avatarSrc
      ? `<img class="reel-author-avatar" src="${avatarSrc}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="reel-author-avatar" style="display:flex;align-items:center;justify-content:center;font-size:18px">🐸</div>`;

    const friendLabel = post.friend_actor_nick
      ? `<span class="reel-friend-label">${post.friend_actor_avatar
          ? `<img src="${esc(post.friend_actor_avatar)}" style="width:16px;height:16px;border-radius:50%;object-fit:cover" alt="">`
          : ''}${esc(post.friend_actor_nick)} ${post.user_id == (window.State?.user?.id) ? 'posted' : 'liked/reposted'}</span>`
      : '';

    const caption = post.content ? `<div class="reel-caption">${esc(post.content)}</div>` : '';
    const likeCount = post.like_count ?? post.reaction_count ?? 0;
    const commentCount = post.comment_count ?? 0;
    const repostCount = post.repost_count ?? 0;
    const postPrivacy = String(post.privacy || 'public').toLowerCase();
    const shareEnabled = Number(post.share_enabled ?? 1) === 1;
    const canShare = shareEnabled && postPrivacy !== 'friends' && postPrivacy !== 'private';

    return `
      <div class="reel-card" data-post-id="${post.id}">
        <div class="reel-loading-layer"><span class="reel-loading-spinner"></span></div>
        <div class="reel-video-poster"></div>
        <video src="${videoSrc}" playsinline preload="auto" muted></video>
        <button class="reel-play-toggle" title="Play or pause" onclick="Social.toggleReelPlayback(event,this.previousElementSibling)">▶</button>
        <div class="reel-progress"><span></span></div>
        <div class="reel-overlay-top"></div>
        <div class="reel-overlay-bottom"></div>
        <button class="reel-mute-btn" onclick="Social.toggleReelMute(this)" title="Toggle mute">🔇</button>
        <div class="reel-author" onclick="Social.openProfile('${nick}')">
          ${avatarHtml}
          <div class="reel-author-info">
            <span class="reel-author-nick">@${nick}</span>
            ${friendLabel}
          </div>
        </div>
        ${caption}
        <div class="reel-actions">
          <button class="reel-act-btn ${post.i_liked ? 'liked' : ''}" title="Like" onclick="Social.reactReelHeart(event,${post.id},this)">
            <div class="reel-act-icon">❤️</div>
            <span class="reel-act-count reel-like-count">${likeCount}</span>
          </button>
          <button class="reel-act-btn" title="Comments" onclick="Social.openReelComments(event,${post.id})">
            <div class="reel-act-icon">💬</div>
            <span class="reel-act-count reel-comment-count">${commentCount}</span>
          </button>
          <button class="reel-act-btn" title="Repost" onclick="Social.toggleRepost(${post.id},this)">
            <div class="reel-act-icon">${post.i_reposted ? '🔁' : '↩️'}</div>
            <span class="reel-act-count reel-repost-count">${repostCount}</span>
          </button>
          <button class="reel-act-btn ${canShare ? '' : 'disabled'}" title="Share" onclick="Social.shareReelUrl(${post.id}, { nickname: ${jsStr(rawNick)}, privacy: ${jsStr(postPrivacy)}, shareEnabled: ${shareEnabled ? 1 : 0}, text: ${jsStr(post.content || '')} })">
            <div class="reel-act-icon">📤</div>
            <span class="reel-act-count">Share</span>
          </button>
        </div>
      </div>`;
  }

  async function reactReelHeart(ev, postId, btn) {
    try {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
    } catch {}
    const countEl = btn?.querySelector('.reel-like-count');
    const wasLiked = !!btn?.classList.contains('liked');
    const prev = Number(countEl?.textContent || '0');
    if (btn && countEl) {
      btn.classList.toggle('liked', !wasLiked);
      countEl.textContent = String(Math.max(0, prev + (!wasLiked ? 1 : -1)));
      btn.disabled = true;
    }
    try {
      const res = await api(`/api/wall/posts/${postId}/reactions`, 'POST', { emoji: '❤️' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to like');
      const reactions = Array.isArray(data.reactions) ? data.reactions : [];
      const heart = reactions.find(r => r && r.emoji === '❤️');
      const nextCount = Number(heart?.count || 0);
      const me = String(State?.user?.nickname || '');
      const nextLiked = heart && Array.isArray(heart.users)
        ? heart.users.includes(me)
        : !!data.added;
      if (btn) btn.classList.toggle('liked', nextLiked);
      if (countEl) countEl.textContent = String(nextCount);
    } catch {
      if (btn) btn.classList.toggle('liked', wasLiked);
      if (countEl) countEl.textContent = String(prev);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function openReelComments(ev, postId) {
    try {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
    } catch {}
    await openPostComments(postId);
    setTimeout(() => {
      const input = document.getElementById(`sf-ci-${postId}`);
      if (input) input.focus();
    }, 80);
  }

  async function loadProfileReels(nickname, loadToken = _profileTabLoadToken) {
    const container = document.getElementById('sp-posts');
    if (!container) return;
    // Show grid skeleton immediately (switchProfileTab already sets it, but handle
    // direct calls such as initial profile load or forced refresh gracefully).
    if (!container.querySelector('.social-grid')) {
      container.innerHTML = _spGridSkeletonHtml();
    }
    try {
      const allPosts = await _fetchProfilePostsCached(nickname, loadToken, 'reels');
      if (allPosts === null) return;
      const posts = allPosts.filter(p => p.media_type && p.media_type.startsWith('video/'));

      if (!_isProfileTabLoadCurrent('reels', loadToken)) return;

      if (posts.length === 0) {
        container.innerHTML = `<div class="social-empty" style="padding:40px 0">
          <div style="font-size:36px;margin-bottom:8px">🎞</div>
          <div style="font-size:15px;color:#888">No reels yet</div>
          <div style="color:#666;font-size:12px;margin-top:6px">Video posts will appear here.</div>
        </div>`;
        return;
      }

      // Grid view for profile reels
      _disposeMediaIn(container);
      container.innerHTML = `<div class="social-grid">${posts.map(p => {
        return `
          <div class="social-grid-item is-video" onclick="Social.openSharedReel(${p.id})">
            <video src="${esc(_authMediaSrc(p.media_data || ''))}" poster="${esc(_authMediaThumb(p.media_data || ''))}" muted playsinline preload="auto"></video>
            <span class="social-grid-video-ico">▶</span>
            <div class="social-grid-overlay">
              <span>❤️ ${p.reaction_count || 0}</span>
              <span>💬 ${p.comment_count || 0}</span>
            </div>
          </div>`;
      }).join('')}</div>`;
      try { _hydrateVideoThumbs(container); } catch {}
    } catch {
      if (!_isProfileTabLoadCurrent('reels', loadToken)) return;
      container.innerHTML = _socialErrorHTML('Could not load reels', "Social.switchProfileTab('reels')", { ico: '🎞️' });
    }
  }

  // ── REPOSTS tab — posts this user has reposted ──────────────────────
  async function loadProfileReposts(nickname, loadToken = _profileTabLoadToken) {
    const container = document.getElementById('sp-posts');
    if (!container) return;
    if (!container.querySelector('.social-feed')) {
      container.innerHTML = `<div class="social-feed">${_socialPostSkeletonCards(3)}</div>`;
    }
    try {
      const posts = await _fetchProfileRepostsCached(nickname, loadToken);
      if (posts === null || !_isProfileTabLoadCurrent('reposts', loadToken)) return;

      if (posts.length === 0) {
        container.innerHTML = `<div class="social-empty" style="padding:40px 0">
          <div style="font-size:36px;margin-bottom:8px">🔁</div>
          <div style="font-size:15px;color:#888">No reposts yet</div>
          <div style="color:#666;font-size:12px;margin-top:6px">When you repost posts from people you follow, they'll appear here.</div>
        </div>`;
        return;
      }
      container.innerHTML = `<div class="social-feed">${posts.map(p => renderFeedPost(p)).join('')}</div>`;
    } catch {
      if (!_isProfileTabLoadCurrent('reposts', loadToken)) return;
      container.innerHTML = _socialErrorHTML('Could not load reposts', "Social.switchProfileTab('reposts')", { ico: '🔁' });
    }
  }

  // ── MEDIA tab — channel media sent by this user ──────────────────────
  async function loadProfileMedia(nickname) {
    const container = document.getElementById('sp-posts');
    if (!container) return;
    container.innerHTML = '<div class="social-loading">Loading media…</div>';
    try {
      const res = await api('/api/social/profile/' + encodeURIComponent(nickname) + '/media');
      const data = await res.json();
      const items = data.media || [];
      const isSelf = data.is_self;

      if (items.length === 0) {
        container.innerHTML = `<div class="social-empty" style="padding:40px 0">
          <div style="font-size:36px;margin-bottom:8px">🖼️</div>
          <div style="font-size:15px;color:#888">No private media yet</div>
          <div style="color:#666;font-size:12px;margin-top:6px">Media you send in channels shows here — only you can see it until you hit <em>Make Public</em>.</div>
        </div>`;
        return;
      }

      container.innerHTML = `<div class="social-media-grid">${items.map(item => {
        const isImg = item.media_type && (item.media_type.startsWith('image') || item.media_type.startsWith('video'));
        const isAudio = item.media_type && item.media_type.startsWith('audio');
        return `
          <div class="social-media-item" data-msg-id="${item.id}">
            <div class="social-media-thumb" onclick="Social.previewMedia(${item.id})">
              ${isAudio
                ? `<div class="social-media-audio-icon">🎵</div>`
                : `<img src="/api/messages/media/${item.id}?thumb=1" alt="" loading="lazy" onerror="this.closest('.social-media-item')?.remove()">`
              }
              <div class="social-media-info">
                <span>#${esc(item.room_name)}</span>
                <span>${timeAgo(item.created_at)}</span>
              </div>
            </div>
            ${isSelf ? `<button class="social-media-wall-btn" onclick="Social.moveToWall(${item.id},this)" title="Post to Public Media">🌍 Make Public</button>` : ''}
          </div>`;
      }).join('')}</div>`;
    } catch {
      container.innerHTML = `<div class="social-empty" style="padding:40px 0">
        <div style="font-size:36px;margin-bottom:8px">🖼️</div>
        <div style="font-size:15px;color:#888">No media yet</div>
      </div>`;
    }
  }

  async function moveToWall(msgId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Posting…'; }
    try {
      const res = await api(`/api/social/profile/media/${msgId}/to-wall`, 'POST');
      if (res.ok) {
        UI.showToast('Posted to your wall!', 'success');
        // Animate the tile out of the Private Media grid — the server has
        // flipped `posted_to_wall`, so the next load won't return it either.
        const tile = btn?.closest('.social-media-item');
        if (tile) {
          tile.style.transition = 'opacity .28s ease, transform .28s ease';
          tile.style.opacity = '0';
          tile.style.transform = 'scale(.9)';
          setTimeout(() => {
            tile.remove();
            // If the grid is now empty, reload the tab so the empty-state
            // hero appears instead of an empty blank area.
            const grid = document.querySelector('.social-media-grid');
            if (grid && !grid.children.length) loadProfileMediaCombined(_profileUser, 'private', _profileTabLoadToken);
          }, 300);
        }
      } else {
        const data = await res.json();
        UI.showToast(data.error || 'Failed', 'error');
        if (btn) { btn.disabled = false; btn.textContent = '🌍 Make Public'; }
      }
    } catch {
      UI.showToast('Network error', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🌍 Make Public'; }
    }
  }

  // ── CHANNELS tab — channels created by this user ──────────────────────
  async function loadProfileChannels(nickname, loadToken = _profileTabLoadToken) {
    const container = document.getElementById('sp-posts');
    if (!container) return;
    if (!container.querySelector('.sp-channels-list')) {
      container.innerHTML = _spChannelsSkeletonHtml();
    }
    try {
      const channels = await _fetchProfileChannelsCached(nickname, loadToken);
      if (channels === null || !_isProfileTabLoadCurrent('channels', loadToken)) return;

      if (channels.length === 0) {
        container.innerHTML = `<div class="social-empty" style="padding:40px 0">
          <div style="font-size:36px;margin-bottom:8px">📺</div>
          <div style="font-size:15px;color:#888">No channels created yet</div>
        </div>`;
        return;
      }

      const catIcons = {gaming:'🎮',music:'🎵',art:'🎨',tech:'💻',social:'💬',education:'📚',memes:'😂',crypto:'💰',sports:'⚽',other:'📦'};
      container.innerHTML = `<div class="sp-channels-list">${channels.map(ch => {
        const iconHtml = ch.icon && ch.icon.startsWith('data:image')
          ? `<img src="${esc(ch.icon)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
          : esc(ch.icon || '💬');
        let tags = [];
        try { tags = typeof ch.tags === 'string' ? JSON.parse(ch.tags) : (ch.tags || []); } catch {}
        const desc = ch.directory_description || ch.description || '';
        return `<div class="sp-channel-card" onclick="Social.viewChannelProfile(${jsStr(ch.name)})">
          <div class="sp-channel-icon">${iconHtml}</div>
          <div class="sp-channel-info">
            <div class="sp-channel-name">${esc(ch.name)}</div>
            <div class="sp-channel-meta">
              ${ch.category ? `<span class="sp-channel-cat">${catIcons[ch.category]||''} ${esc(ch.category)}</span>` : ''}
              <span>👥 ${ch.member_count || 0} members</span>
              ${ch.is_public ? '<span style="color:#4caf50">🌐 Public</span>' : '<span style="color:#888">🔒 Private</span>'}
            </div>
            ${desc ? `<div class="sp-channel-desc">${esc(desc.substring(0, 120))}${desc.length > 120 ? '…' : ''}</div>` : ''}
            ${tags.length ? `<div class="sp-channel-tags">${tags.slice(0, 4).map(t => `<span class="dir-tag">${esc(t)}</span>`).join('')}</div>` : ''}
          </div>
        </div>`;
      }).join('')}</div>`;
    } catch {
      if (!_isProfileTabLoadCurrent('channels', loadToken)) return;
      container.innerHTML = _socialErrorHTML('Could not load channels', "Social.switchProfileTab('channels')", { ico: '💬' });
    }
  }

  async function previewMedia(msgId) {
    try {
      const res = await apiFetch(`/api/messages/media/${msgId}`);
      if (!res.ok) return;
      const data = await res.json();
      const mt = String(data.media_type || '').toLowerCase();
      const src = String(data.media_data || '');
      if (!src) return;

      // Prefer global lightbox when available for consistency.
      if ((mt.startsWith('image/') || mt.startsWith('video/')) && typeof openLightbox === 'function') {
        openLightbox(src);
        return;
      }

      // Fallback: reuse Social's detail overlay so private-media preview
      // always works even if the global lightbox script is unavailable.
      let overlay = document.getElementById('social-post-detail');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'social-post-detail';
        overlay.onclick = e => { if (e.target === overlay) overlay.style.display = 'none'; };
        document.body.appendChild(overlay);
      }

      let body = '';
      if (mt.startsWith('image/')) {
        body = `<img src="${esc(src)}" alt="" style="width:100%;max-height:76vh;object-fit:contain;border-radius:10px;display:block">`;
      } else if (mt.startsWith('video/')) {
        body = `<video src="${esc(src)}" controls autoplay playsinline style="width:100%;max-height:76vh;border-radius:10px;background:#000;display:block"></video>`;
      } else if (mt.startsWith('audio/')) {
        body = `<div style="padding:20px 10px;text-align:center"><div style="font-size:34px;margin-bottom:12px">🎵</div><audio src="${esc(src)}" controls autoplay style="width:100%"></audio></div>`;
      } else {
        body = `<div style="padding:20px 10px;text-align:center;color:#aaa">Preview not available for this media type.</div>`;
      }

      overlay.innerHTML = `<div class="spd-inner"><button class="social-close-btn" onclick="Social.closePostDetail()" style="position:absolute;top:8px;right:8px;z-index:1">✕</button>${body}</div>`;
      overlay.style.display = 'flex';
    } catch {}
  }

  // ── render a single feed post ──────────────────────────────────────────
  function _formatPostContent(text) {
    let html = esc(text);
    // URLs — themed link (green accent, no default blue)
    html = html.replace(/https?:\/\/[^\s<>"]+/g, url =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer" class="sf-link">${url}</a>`);
    // @mentions
    html = html.replace(/@(\w+)/g, (match, nick) =>
      `<span class="sf-mention" onclick="Social.openProfile('${esc(nick)}')">@${esc(nick)}</span>`);
    // #channel refs → clickable pill that jumps to the channel (same flow
    // as in-channel #mentions: closes Social, auto-joins if public, shows
    // a "deleted" toast if the channel is gone).
    html = html.replace(/(^|[\s(\[>])#([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})\b/g,
      (m, pre, name) => `${pre}<span class="room-mention sf-room-mention" data-room="${esc(name)}" onclick="event.stopPropagation();if(window.Rooms&&Rooms.openChannelLink){Rooms.openChannelLink('${esc(name).replace(/'/g,"\\'")}')}">#${esc(name)}</span>`);
    return html;
  }

  // ── Music share card ──────────────────────────────────────────────────
  // Extracts the provider name from media_type ("music/youtube" → "youtube")
  // and builds a clickable embed that opens the track in a new tab.
  function _parseMusicTrack(url, provider) {
    const u = String(url || '');
    try {
      // YouTube — normal + shortened
      const ytFull = u.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
      const ytShort = u.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
      const ytId = (ytFull && ytFull[1]) || (ytShort && ytShort[1]);
      if (ytId && (!provider || provider === 'youtube')) {
        return { provider: 'youtube', id: ytId,
                 thumb: `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`,
                 embed: `https://www.youtube.com/embed/${ytId}` };
      }
      // Spotify — track/playlist/album (embed URL uses same path)
      const sp = u.match(/open\.spotify\.com\/(track|playlist|album|episode)\/([A-Za-z0-9]+)/);
      if (sp) {
        return { provider: 'spotify', id: `${sp[1]}/${sp[2]}`, thumb: '',
                 embed: `https://open.spotify.com/embed/${sp[1]}/${sp[2]}` };
      }
      // SoundCloud — URL is the ID, embed requires passing the URL.
      if (u.includes('soundcloud.com')) {
        return { provider: 'soundcloud', id: u, thumb: '',
                 embed: `https://w.soundcloud.com/player/?url=${encodeURIComponent(u)}&color=%234caf50` };
      }
    } catch {}
    return { provider: provider || 'link', id: u, thumb: '', embed: '' };
  }

  function _prettyMusicFallbackTitle(trackUrl, provider) {
    const url = String(trackUrl || '').trim();
    const prov = String(provider || '').toLowerCase();
    try {
      if (prov === 'soundcloud') {
        const parsed = new URL(url, window.location.origin);
        const slug = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
          .replace(/[-_]+/g, ' ')
          .trim();
        if (slug) return slug.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 140);
      }
    } catch {}
    if (prov === 'youtube') return 'YouTube video';
    if (prov === 'spotify') return 'Spotify track';
    if (prov === 'soundcloud') return 'SoundCloud track';
    return 'Track';
  }

  async function _fetchMusicTitle(trackUrl, provider) {
    const url = String(trackUrl || '').trim();
    if (!url) return '';
    const key = `${String(provider || '').toLowerCase()}|${url}`;
    const cached = _musicTitleCache.get(key);
    if (typeof cached === 'string') return cached;
    if (_musicTitleInflight.has(key)) return _musicTitleInflight.get(key);

    const req = (async () => {
      try {
        const res = await api(`/api/preview?url=${encodeURIComponent(url)}`);
        if (!res.ok) return '';
        const data = await res.json().catch(() => ({}));
        const preview = data.preview || {};
        const title = String(preview.title || '').trim();
        const normalized = title && !/^youtube video$/i.test(title) ? title : '';
        _musicTitleCache.set(key, normalized);
        return normalized;
      } catch {
        _musicTitleCache.set(key, '');
        return '';
      } finally {
        _musicTitleInflight.delete(key);
      }
    })();

    _musicTitleInflight.set(key, req);
    return req;
  }

  function _hydrateMusicCardTitles(scope) {
    const root = scope || document;
    root.querySelectorAll('.sf-music-card[data-track-title-pending="1"]').forEach(card => {
      const url = String(card.getAttribute('data-track-url') || '').trim();
      const provider = String(card.getAttribute('data-provider') || '').trim();
      if (!url) {
        card.dataset.trackTitlePending = '0';
        return;
      }
      _fetchMusicTitle(url, provider).then(title => {
        if (!title) return;
        const safe = esc(title);
        card.dataset.trackTitlePending = '0';
        card.setAttribute('data-track-title', title);
        const titleEl = card.querySelector('.sfmc-title');
        if (titleEl) {
          titleEl.textContent = title;
          titleEl.setAttribute('title', title);
        }
        const playEls = [card.querySelector('.sfmc-play')];
        playEls.forEach(el => {
          if (el) el.setAttribute('aria-label', (el.getAttribute('aria-label') || 'Play').replace(/\s+.*$/, ''));
        });
        const cover = card.querySelector('.sfmc-cover');
        if (cover) cover.setAttribute('title', title);
      }).catch(() => {});
    });
  }

  function _renderMusicCard(p) {
    const prov = (p.media_type || '').split('/')[1] || 'link';
    // media_data is the raw track URL. Early-2026 shares briefly encoded a
    // JSON blob here ({url, title, room}) — unwrap those for compat before
    // the DB-backed track_title/track_room fields took over.
    let rawMediaData = p.media_data || '';
    let metaTitle = p.track_title || '';
    let metaRoom  = p.track_room  || '';
    let trackUrl  = rawMediaData;
    try {
      if (rawMediaData.trim().startsWith('{')) {
        const meta = JSON.parse(rawMediaData);
        trackUrl  = meta.url  || rawMediaData;
        if (!metaTitle) metaTitle = meta.title || '';
        if (!metaRoom)  metaRoom  = meta.room  || '';
      }
    } catch {}
    const t = _parseMusicTrack(trackUrl, prov);
    const cachedTitle = _musicTitleCache.get(`${String(t.provider || '').toLowerCase()}|${trackUrl}`) || '';
    // Try to pluck a title from the post content (we store the track title
    // on its own line after "🎵 Now playing …: ").
    let title = metaTitle || cachedTitle;
    let roomHint = metaRoom;
    try {
      // Legacy posts stored the track title as "🎵 Now playing in #room: <title>".
      if (!title) {
        const m = /🎵\s*(?:Now playing|Sharing)(?:\s+in\s+#(\S+))?:\s*(.+)/i.exec(p.content || '');
        if (m) { roomHint = roomHint || m[1] || ''; title = (m[2] || '').trim(); }
      }
    } catch {}
    // If we still don't have a title, derive a pretty fallback from the URL
    // (e.g. "open.spotify.com/track/..." → "Spotify track") instead of
    // showing the raw link.
    const needsHydrate = !title;
    if (!title) title = _prettyMusicFallbackTitle(trackUrl, t.provider);
    const label = t.provider === 'youtube' ? 'YouTube'
              : t.provider === 'spotify' ? 'Spotify'
              : t.provider === 'soundcloud' ? 'SoundCloud' : 'Music';
    const chipIcon = t.provider === 'youtube' ? '▶' : t.provider === 'spotify' ? '♫' : t.provider === 'soundcloud' ? '☁️' : '🎵';
    const artBg = t.thumb ? `style="background-image:url('${esc(t.thumb)}')"` : '';
    const sharer = p.nickname || p.author_nick || p.author || '';
    const fullUrl = trackUrl;
    // Tapping the cover always routes through the unified Music mini-player,
    // regardless of which tab the card is shown in. If the track is already
    // live, it toggles pause; otherwise it starts solo playback.
    const toggleArgs = `${jsStr(fullUrl)},${jsStr(t.provider)},${jsStr(title)},${jsStr(sharer)},${jsStr(String(p.id || ''))}`;
    const coverAction = `Social.toggleMusicCard(${toggleArgs})`;
    // Ask Music whether this exact url is already the active track so we
    // can render the right icon on first paint (before any state event).
    let initialState = 'idle';
    try {
      const cur = (window.Music && typeof Music.getCurrent === 'function') ? Music.getCurrent() : null;
      if (cur && cur.active && cur.url === fullUrl) {
        initialState = cur.paused ? 'paused' : 'playing';
      }
    } catch {}
    const stateCls = initialState === 'playing' ? 'is-playing'
                   : initialState === 'paused'  ? 'is-playing is-paused' : '';
    const playIcon = initialState === 'playing' ? '⏸'
                   : initialState === 'paused'  ? '▶' : '▶';
    const playTitle = initialState === 'playing' ? 'Pause'
                    : initialState === 'paused'  ? 'Resume' : 'Play';
    return `
      <div class="sf-music-card ${stateCls}" data-provider="${esc(t.provider)}" data-track-url="${esc(fullUrl)}" data-track-title-pending="${needsHydrate ? '1' : '0'}">
        <div class="sfmc-cover ${t.thumb ? '' : 'no-art'}" ${artBg}
             onclick="${coverAction}">
          <span class="sfmc-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <button type="button" class="sfmc-play" title="${playTitle}" aria-label="${playTitle}"
                  onclick="event.stopPropagation();${coverAction}">${playIcon}</button>
          <span class="sfmc-provider-chip" data-provider="${esc(t.provider)}">${chipIcon} ${esc(label)}</span>
        </div>
        <div class="sfmc-body">
          <div class="sfmc-title" title="${esc(title)}">${esc(title)}</div>
          <div class="sfmc-sub">
            ${roomHint ? `<span class="room-mention sfmc-room" data-room="${esc(roomHint)}" onclick="event.stopPropagation();if(window.Rooms&&Rooms.openChannelLink){Rooms.openChannelLink('${esc(roomHint).replace(/'/g,"\\'")}')}">#${esc(roomHint)}</span> · ` : ''}
            <a href="${esc(fullUrl)}" target="_blank" rel="noopener noreferrer" class="sfmc-link">Open on ${esc(label)} ↗</a>
          </div>
          ${(() => {
            const mood = (p.track_mood || '').toLowerCase().trim();
            if (!mood) return '';
            const moodMeta = {
              chill:       { icon: '🎧', label: 'Chill',       color: '#6cc4ff' },
              hype:        { icon: '🔥', label: 'Hype',        color: '#ff7a4d' },
              focus:       { icon: '💼', label: 'Focus',       color: '#b289ff' },
              party:       { icon: '🎉', label: 'Party',       color: '#ff5ea8' },
              'late-night':{ icon: '🌙', label: 'Late-night',  color: '#8ca0ff' },
              morning:     { icon: '🌅', label: 'Morning',     color: '#ffc55a' },
              sad:         { icon: '🌧️', label: 'Sad',         color: '#88aac2' },
              romance:     { icon: '💘', label: 'Romance',     color: '#ff8fb5' },
            };
            const mm = moodMeta[mood] || { icon: '🎵', label: mood, color: '#888' };
            return `<span class="sfmc-mood" style="--mood:${mm.color}"
                           onclick="event.stopPropagation();Social.filterMusicByMood('${esc(mood)}')"
                           title="Filter ${mm.label} tracks">${mm.icon} ${esc(mm.label)}</span>`;
          })()}
          <div class="sfmc-status" aria-live="polite"></div>
        </div>
      </div>`;
  }

  // Opens an in-place embedded player for the given track.
  function openMusicEmbed(embedUrl, provider, title) {
    if (!embedUrl) return;
    // Reuse the profile/media modal if present, otherwise build a simple one.
    let modal = document.getElementById('social-music-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'social-music-modal';
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-box" style="max-width:min(560px,96vw);padding:14px;background:#0f0f0f;border:1px solid #2a2a2a">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px">
            <div id="smm-title" style="color:#e0e0e0;font-weight:600;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
            <button class="modal-btn secondary" onclick="document.getElementById('social-music-modal').classList.add('hidden')" title="Close">✕</button>
          </div>
          <div id="smm-frame-wrap" style="aspect-ratio:16/9;width:100%;background:#000;border-radius:10px;overflow:hidden"></div>
        </div>`;
      document.body.appendChild(modal);
    }
    modal.querySelector('#smm-title').textContent = title || 'Music';
    modal.querySelector('#smm-frame-wrap').innerHTML =
      `<iframe src="${esc(embedUrl)}" allow="autoplay; encrypted-media; clipboard-write" allowfullscreen
               style="width:100%;height:100%;border:0"></iframe>`;
    modal.classList.remove('hidden');
  }

  // Music tab — filters the user's feed to music-share posts across
  // followed users + self. Falls back to "no shares yet" with a prompt.
  // Cache of last-rendered music posts so playMusicInTab can look up
  // track metadata without re-parsing.
  let _musicTabPosts = [];
  // Per-session set of music URLs already auto-served by the recommender,
  // used to avoid loops when the cached feed is short.
  let _autoNextSeen = new Set();
  // Currently selected mood filter on the Music tab ('' = all moods).
  let _musicTabMood = '';
  // Scope of the music feed: 'following' = own + followed, 'explore' = all public.
  let _musicTabScope = 'following';
  // Sort for Explore scope only: 'new' | 'trending' | 'top'.
  let _musicTabSort = 'new';
  let _musicTabLoadToken = 0;

  function filterMusicByMood(mood) {
    _musicTabMood = mood || '';
    // Reload so backend applies mood filtering.
    loadMusicTab();
  }

  function filterMusicByMoodSelect(selectEl) {
    if (!selectEl) return;
    const mood = selectEl.value || '';
    const selected = selectEl.options && selectEl.selectedIndex >= 0
      ? selectEl.options[selectEl.selectedIndex]
      : null;
    const color = (selected && selected.dataset && selected.dataset.color) || '#7e57c2';
    const wrap = selectEl.closest('.msb-mood-select-wrap');
    if (wrap) {
      wrap.style.setProperty('--mood-dot', color);
      wrap.classList.remove('dot-pulse');
      // Reflow so the pulse reliably re-triggers on repeated changes.
      void wrap.offsetWidth;
      wrap.classList.add('dot-pulse');
    }
    filterMusicByMood(mood);
  }

  function switchMusicScope(scope) {
    if (scope !== 'following' && scope !== 'explore') return;
    if (_musicTabScope === scope) return;
    _musicTabScope = scope;
    _musicTabMood = '';
    loadMusicTab();
  }

  function switchMusicSort(sort) {
    if (!['new','trending','top'].includes(sort)) return;
    if (_musicTabSort === sort) return;
    _musicTabSort = sort;
    loadMusicTab();
  }

  async function loadMusicTab() {
    const content = document.getElementById('social-content');
    if (!content) return;
    // Skip the load banner entirely when we have a fresh cache for the
    // current scope/sort/mood. Banner-then-render felt like an
    // unnecessary flash on the way back to the tab.
    const _mKey = `${_musicTabScope}:${_musicTabSort}:${_musicTabMood || ''}`;
    const _mFresh = _cacheFresh(_musicCache.get(_mKey));
    const loadUi = _mFresh ? -1 : _beginTabLoadUi('music', 'Opening music tab', 'Checking music cache…');
    const smoothStepTimers = [];
    const queueLoadStep = (delayMs, pct, label, detail) => {
      const t = setTimeout(() => {
        if (_currentTab !== 'music' || loadToken !== _musicTabLoadToken) return;
        _updateTabLoadUi(loadUi, pct, label, detail);
      }, Math.max(0, Number(delayMs) || 0));
      smoothStepTimers.push(t);
    };
    const clearQueuedSteps = () => {
      while (smoothStepTimers.length) clearTimeout(smoothStepTimers.pop());
    };
    const loadToken = ++_musicTabLoadToken;
    const moodQuery = _musicTabMood ? `&mood=${encodeURIComponent(_musicTabMood)}` : '';
    const cacheKey = `${_musicTabScope}:${_musicTabSort}:${_musicTabMood || ''}`;
    const cachedEntry = _musicCache.get(cacheKey);
    const musicFresh = _cacheFresh(cachedEntry);
    const musicUsable = _cacheUsable(cachedEntry) && Array.isArray(cachedEntry.posts);
    // Only show the skeleton when there's nothing usable to display.
    // With usable cache we paint the cached layout below before any
    // network round-trip — stale-while-revalidate.
    if (!musicUsable) {
      content.innerHTML = _musicSkeletonHtml(_musicTabScope, _musicTabSort);
    }
    try {
      let all = null;
      if (musicUsable) {
        all = cachedEntry.posts;
        _updateTabLoadUi(loadUi, musicFresh ? 96 : 38, musicFresh ? 'Music ready' : 'Music (cached) — refreshing…', `${all.length} track${all.length !== 1 ? 's' : ''} from cache`);
      } else {
        _updateTabLoadUi(loadUi, 32, 'Connecting to server', `Fetching ${_musicTabScope === 'explore' ? 'all public' : 'your'} shared tracks…`);
        _updateTabLoadUi(loadUi, 46, 'Downloading tracks', _musicTabScope === 'explore' ? `Explore · ${_musicTabSort} — receiving posts…` : 'Feed — receiving your posts…');
        // Fake-progress timers removed — see loadFeed.
        let feedData;
        if (_musicTabScope === 'explore') {
          feedData = await _apiOkJson(`/api/social/explore?lite=1&limit=100&sort=${encodeURIComponent(_musicTabSort)}${moodQuery}`, { posts: [] });
        } else {
          feedData = await _apiOkJson(`/api/social/feed?lite=1&limit=100${moodQuery}`, { posts: [] });
        }
        clearQueuedSteps();
        if (_currentTab !== 'music' || loadToken !== _musicTabLoadToken) return;
        const seen = new Set();
        all = [];
        for (const p of (feedData.posts || [])) {
          if (!p || seen.has(p.id)) continue;
          seen.add(p.id);
          all.push(p);
        }
        _cacheSet(_musicCache, cacheKey, { ts: Date.now(), posts: all });
      }
      if (_currentTab !== 'music' || loadToken !== _musicTabLoadToken) return;
      const isMusic = (p) => {
        const mt = (p.media_type || '').toLowerCase();
        if (mt.startsWith('music/')) return true;
        let md = String(p.media_data || '');
        if (!md) return false;
        // Unwrap JSON-encoded media_data ({url, title, room}) before URL test.
        try {
          if (md.trim().startsWith('{')) md = JSON.parse(md).url || md;
        } catch {}
        return /youtube\.com|youtu\.be|open\.spotify\.com|soundcloud\.com/i.test(md);
      };
      const musicPostsRaw = all.filter(isMusic);
      // For 'new' and 'following' we sort by recency. For 'trending'/'top'
      // we keep the server-provided order (ranking already applied).
      const musicPosts = (_musicTabScope === 'explore' && _musicTabSort !== 'new')
        ? musicPostsRaw
        : musicPostsRaw.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      _musicTabPosts = musicPosts;
      if (_currentTab !== 'music' || loadToken !== _musicTabLoadToken) return;
      _updateTabLoadUi(loadUi, 72, 'Filtering music', `${musicPosts.length} track${musicPosts.length !== 1 ? 's' : ''} found — building playlist…`);

      const moodOrder = ['chill','hype','focus','party','late-night','morning','sad','romance'];
      const moodMeta = {
        chill:       { icon: '🎧', label: 'Chill',       color: '#6cc4ff' },
        hype:        { icon: '🔥', label: 'Hype',        color: '#ff7a4d' },
        focus:       { icon: '💼', label: 'Focus',       color: '#b289ff' },
        party:       { icon: '🎉', label: 'Party',       color: '#ff5ea8' },
        'late-night':{ icon: '🌙', label: 'Late-night',  color: '#8ca0ff' },
        morning:     { icon: '🌅', label: 'Morning',     color: '#ffc55a' },
        sad:         { icon: '🌧️', label: 'Sad',         color: '#88aac2' },
        romance:     { icon: '💘', label: 'Romance',     color: '#ff8fb5' },
      };
      const activeMood = _musicTabMood || '';
      const activeMoodColor = (activeMood && moodMeta[activeMood]) ? moodMeta[activeMood].color : '#7e57c2';
      const scope = _musicTabScope;
      const sort  = _musicTabSort;

      const scopeBar = `
        <div class="music-scope-bar">
          <div class="msb-toggle" role="tablist" aria-label="Music feed scope">
            <button class="msb-seg ${scope==='following'?'active':''}" role="tab"
                    aria-selected="${scope==='following'}"
                    onclick="Social.switchMusicScope('following')">
              <span class="msb-seg-ico">👥</span><span>Following</span>
            </button>
            <button class="msb-seg ${scope==='explore'?'active':''}" role="tab"
                    aria-selected="${scope==='explore'}"
                    onclick="Social.switchMusicScope('explore')">
              <span class="msb-seg-ico">🌐</span><span>Explore</span>
            </button>
          </div>
          ${scope==='explore' ? `
            <div class="msb-sort">
              <button class="msb-sort-chip ${sort==='new'?'active':''}"       onclick="Social.switchMusicSort('new')">🆕 New</button>
              <button class="msb-sort-chip ${sort==='trending'?'active':''}"  onclick="Social.switchMusicSort('trending')">🔥 Trending</button>
              <button class="msb-sort-chip ${sort==='top'?'active':''}"       onclick="Social.switchMusicSort('top')">⭐ Top</button>
              <label class="msb-mood-select-wrap" style="--mood-dot:${activeMoodColor}" title="Filter by mood">
                <span class="msb-mood-dot"></span>
                <select class="msb-mood-select" onchange="Social.filterMusicByMoodSelect(this)">
                  <option value="">All moods</option>
                  ${moodOrder.map(m => {
                    const mm = moodMeta[m];
                    return `<option value="${m}" data-color="${mm.color}" ${activeMood===m?'selected':''}>${mm.icon} ${mm.label}</option>`;
                  }).join('')}
                </select>
              </label>
            </div>` : ''}
        </div>`;

      const hero = `
        <div class="music-tab-hero-v2">
          <div class="mth2-head">
            <div>
              <div class="mth2-title">🎵 Share what you're vibing to</div>
              <div class="mth2-sub">Drop a YouTube, Spotify or SoundCloud link — give it a mood and let the feed feel it.</div>
            </div>
            <button class="mth2-share-btn" onclick="Social.promptMusicShare()">
              <span class="mth2-share-icon">＋</span>
              <span>Share a track</span>
            </button>
          </div>
          <div class="mth2-quick">
            ${moodOrder.map(m => {
              const mm = moodMeta[m];
              return `<button class="mth2-mood" data-mood="${m}" style="--mood:${mm.color}"
                             onclick="Social.promptMusicShare('${m}')"
                             title="Share a ${mm.label.toLowerCase()} track">${mm.icon} ${mm.label}</button>`;
            }).join('')}
          </div>
        </div>
        ${scopeBar}`;

      const filteredPosts = musicPosts;

      let feed;
      if (musicPosts.length === 0) {
        if (activeMood) {
          const moodLabel = (moodMeta[activeMood] && moodMeta[activeMood].label) || 'this mood';
          feed = `<div class="social-empty">
            <div style="font-size:36px;margin-bottom:8px;opacity:.7">🕳️</div>
            <div style="font-size:15px;font-weight:600;margin-bottom:4px">No tracks in ${moodLabel}</div>
            <div style="color:#888;font-size:13px">Try another mood or switch sort.</div>
          </div>`;
          content.innerHTML = hero + feed;
          _applyMusicState();
          return;
        }
        const emptyCopy = _musicTabScope === 'explore'
          ? { t: 'No public music shares yet', s: 'When people start sharing tracks publicly, they\'ll show up here.' }
          : { t: 'No music shares yet',        s: 'Tap <b>Share a track</b> above — or switch to <b>Explore</b> to hear what everyone\'s playing.' };
        feed = `<div class="social-empty">
          <div style="font-size:48px;margin-bottom:12px;opacity:.7">♫</div>
          <div style="font-size:16px;font-weight:600;margin-bottom:6px">${emptyCopy.t}</div>
          <div style="color:#888;font-size:14px;max-width:420px;margin:0 auto">${emptyCopy.s}</div>
        </div>`;
      } else if (filteredPosts.length === 0) {
        feed = `<div class="social-empty">
          <div style="font-size:36px;margin-bottom:8px;opacity:.7">🕳️</div>
          <div style="font-size:15px;font-weight:600;margin-bottom:4px">No tracks in this mood yet</div>
          <div style="color:#888;font-size:13px">${_musicTabScope === 'explore' ? 'Try another mood or switch sort.' : 'Be the first to share one.'}</div>
        </div>`;
      } else {
        feed = `<div class="social-feed">${filteredPosts.map(p => renderFeedPost(p)).join('')}</div>`;
      }
      content.innerHTML = hero + feed;

      // Paint current play state onto any card that matches, and refresh
      // the "Now playing" strip at the top of the tab.
      _applyMusicState();
    } catch {
      clearQueuedSteps();
      content.innerHTML = _socialErrorHTML('Could not load music shares', "Social.loadMusicTab()", { ico: '🎵' });
    } finally {
      clearQueuedSteps();
      _schedBgPrefetch('music');
      _finishTabLoadUi(loadUi);
    }
  }

  // Kick off playback of a social music card via the main FrogTalk Music
  // module — same mini-player / mini-dock that music channels use.
  // If the clicked track is ALREADY the live mini-player track, toggle
  // pause/resume instead of restarting it.
  function toggleMusicCard(url, provider, title, sharer, postId) {
    const theUrl = url || '';
    if (!theUrl) return;
    const M = window.Music;
    if (!M || typeof M.playSolo !== 'function') {
      window.open(theUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    try {
      const cur = typeof M.getCurrent === 'function' ? M.getCurrent() : null;
      if (cur && cur.active && cur.url === theUrl) {
        // Same track — pause/resume only if provider supports it.
        if (typeof M.togglePauseGlobal === 'function' && M.togglePauseGlobal()) return;
        try { UI.showToast('This provider doesn\'t support pause — use the embed controls', 'info'); } catch {}
        return;
      }
    } catch {}
    const pidNum = postId != null && String(postId).length
      ? (Number.isFinite(Number(postId)) ? Number(postId) : null)
      : null;
    const ok = M.playSolo({
      url: theUrl,
      title: title || 'Music',
      provider: provider || '',
      sharer: sharer || '',
      postId: pidNum,
    });
    if (!ok) return;
    _applyMusicState();
  }

  // Back-compat: older markup calls Social.playMusicInTab(embed, provider, title, url, sharer, ...)
  function playMusicInTab(embed, provider, title, url, sharer /*, roomHint */) {
    void embed;
    toggleMusicCard(url || '', provider || '', title || '', sharer || '', '');
  }

  // Recommender hook called by the Music module when a solo (FrogSocial)
  // track ends and auto-next is on. Returns { url, provider, title,
  // sharer, postId, thumbnail } or null if there's nothing to play.
  //
  // Strategy:
  //  1. Walk the cached _musicTabPosts (the user's last-loaded music feed)
  //     and pick the next entry after currentUrl that we haven't already
  //     served this session. Wraps to the start so a short feed keeps
  //     playing.
  //  2. If the cache is empty (user never opened the Music tab), bail.
  //     The mini-player will simply stop, which matches what users expect
  //     when nothing was queued.
  function getNextMusicTrack(currentUrl /*, opts */) {
    try {
      const list = Array.isArray(_musicTabPosts) ? _musicTabPosts : [];
      if (!list.length) return null;
      _autoNextSeen = _autoNextSeen || new Set();
      if (currentUrl) _autoNextSeen.add(String(currentUrl));
      // Find the index of the current track so we walk forward from it.
      let startIdx = 0;
      const curIdx = list.findIndex(p => String(p.media_data || '') === String(currentUrl || ''));
      if (curIdx >= 0) startIdx = curIdx + 1;
      const len = list.length;
      for (let off = 0; off < len; off++) {
        const p = list[(startIdx + off) % len];
        const url = String(p.media_data || '').trim();
        if (!url) continue;
        if (_autoNextSeen.has(url)) continue;
        const provider = (p.media_type || '').split('/')[1] || '';
        const t = _parseMusicTrack(url, provider);
        const title = String(p.track_title || '').trim()
          || _prettyMusicFallbackTitle(url, provider);
        _autoNextSeen.add(url);
        return {
          url,
          provider: t.provider || provider,
          title,
          sharer: p.nickname || p.author_nick || p.author || '',
          thumbnail: t.thumb || '',
          postId: p.id || null,
        };
      }
      // Every track in the cached feed has played — reset the seen set
      // and pick the first one (so a small feed keeps looping rather than
      // dying silently). Skip the URL we just played so we don't restart it.
      _autoNextSeen = new Set(currentUrl ? [String(currentUrl)] : []);
      for (const p of list) {
        const url = String(p.media_data || '').trim();
        if (!url || url === String(currentUrl || '')) continue;
        const provider = (p.media_type || '').split('/')[1] || '';
        const t = _parseMusicTrack(url, provider);
        const title = String(p.track_title || '').trim()
          || _prettyMusicFallbackTitle(url, provider);
        _autoNextSeen.add(url);
        return {
          url,
          provider: t.provider || provider,
          title,
          sharer: p.nickname || p.author_nick || p.author || '',
          thumbnail: t.thumb || '',
          postId: p.id || null,
        };
      }
    } catch {}
    return null;
  }

  // Async fallback used by the mini-player when the cached Music-tab feed
  // is empty / exhausted: pull a page of public discover posts and pick
  // a music track the user hasn't heard this session. Network-bound; the
  // mini-player calls this only after the synchronous getNextMusicTrack
  // returns null. Returns null on failure rather than throwing so the
  // caller can fall back to "stop" cleanly.
  async function fetchDiscoverMusicTrack(currentUrl) {
    try {
      _autoNextSeen = _autoNextSeen || new Set();
      if (currentUrl) _autoNextSeen.add(String(currentUrl));
      const isMusicMt = (mt) => {
        const s = String(mt || '').toLowerCase();
        if (s.startsWith('music/')) return true;
        return false;
      };
      const isMusicUrl = (u) =>
        /youtube\.com|youtu\.be|open\.spotify\.com|soundcloud\.com/i.test(String(u || ''));
      // Try a couple of sort modes so a quiet "trending" window still
      // produces *something* to play.
      const sorts = ['trending', 'new'];
      for (const sort of sorts) {
        let res;
        try {
          res = await apiFetch(`/api/social/explore?limit=50&sort=${encodeURIComponent(sort)}&lite=1`);
        } catch { continue; }
        if (!res || !res.ok) continue;
        let body = null;
        try { body = await res.json(); } catch {}
        const list = (body && Array.isArray(body.posts)) ? body.posts : [];
        for (const p of list) {
          const mt = String(p.media_type || '').toLowerCase();
          const url = String(p.media_data || '').trim();
          if (!url) continue;
          if (!(isMusicMt(mt) || isMusicUrl(url))) continue;
          if (_autoNextSeen.has(url)) continue;
          // Don't bounce back to the very track that just finished even
          // if the user hasn't otherwise heard it this session.
          if (currentUrl && url === String(currentUrl)) continue;
          const provider = mt.startsWith('music/')
            ? mt.split('/')[1] || ''
            : (isMusicUrl(url) ? '' : '');
          const t = _parseMusicTrack(url, provider);
          const title = String(p.track_title || '').trim()
            || _prettyMusicFallbackTitle(url, t.provider || provider);
          _autoNextSeen.add(url);
          return {
            url,
            provider: t.provider || provider,
            title,
            sharer: p.nickname || p.author_nick || p.author || '',
            thumbnail: t.thumb || '',
            postId: p.id || null,
          };
        }
      }
    } catch {}
    return null;
  }

  // Switch to Social → Music tab and scroll the named post into view.
  // Used by the mini-player when the user taps the dock to "open source".
  function scrollToMusicPost(postId) {
    if (!postId) return;
    try {
      if (typeof switchTab === 'function') switchTab('music');
    } catch {}
    const pid = String(postId);
    const tryScroll = (attempt) => {
      const el = document.querySelector(`.sf-post[data-post-id="${pid}"]`)
        || document.querySelector(`[data-post-id="${pid}"]`);
      if (el) {
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { el.scrollIntoView(); }
        el.classList.add('sf-post-flash');
        setTimeout(() => { try { el.classList.remove('sf-post-flash'); } catch {} }, 1600);
        return true;
      }
      return false;
    };
    // The Music tab may still be loading — retry a few times.
    if (tryScroll(0)) return;
    let n = 0;
    const iv = setInterval(() => {
      n++;
      if (tryScroll(n) || n > 20) clearInterval(iv);
    }, 250);
  }

  // Paints is-playing / is-paused classes + status text on every visible
  // music card, and refreshes the "Now playing" strip. Driven by the
  // music:statechange event (see _wireMusicEvents) and called directly
  // after a tab load.
  function _applyMusicState() {
    try { _hydrateMusicCardTitles(document); } catch {}
    let cur = { active: false };
    try {
      if (window.Music && typeof Music.getCurrent === 'function') cur = Music.getCurrent();
    } catch {}
    try {
      if (cur.active) document.body.setAttribute('data-social-nowplaying', '1');
      else document.body.removeAttribute('data-social-nowplaying');
    } catch {}
    // Cards
    document.querySelectorAll('.sf-music-card').forEach(card => {
      const url = card.getAttribute('data-track-url') || '';
      const match = cur.active && url && url === cur.url;
      card.classList.toggle('is-playing', !!match);
      card.classList.toggle('is-paused', !!(match && cur.paused));
      const btn = card.querySelector('.sfmc-play');
      const status = card.querySelector('.sfmc-status');
      if (btn) {
        if (match && !cur.paused) { btn.textContent = '⏸'; btn.title = 'Pause'; btn.setAttribute('aria-label', 'Pause'); }
        else if (match && cur.paused) { btn.textContent = '▶'; btn.title = 'Resume'; btn.setAttribute('aria-label', 'Resume'); }
        else { btn.textContent = '▶'; btn.title = 'Play'; btn.setAttribute('aria-label', 'Play'); }
      }
      if (status) {
        if (match && !cur.paused) status.textContent = '● Now playing in mini-player';
        else if (match && cur.paused) status.textContent = '‖ Paused';
        else status.textContent = '';
      }
    });
    // Top "Now playing" strips — paint BOTH the persistent overlay strip
    // (#social-nowplaying, visible on every tab) and the legacy in-tab one
    // (#mt-nowplaying, if any cached HTML still has it).
    const strips = [
      document.getElementById('social-nowplaying'),
      document.getElementById('mt-nowplaying'),
    ].filter(Boolean);
    for (const strip of strips) {
      if (!cur.active) {
        strip.hidden = true;
        strip.innerHTML = '';
        continue;
      }
        const labelMap = { youtube: 'YouTube', spotify: 'Spotify', soundcloud: 'SoundCloud' };
        const providerLabel = labelMap[cur.provider] || 'Music';
        const dotCls = cur.paused ? 'mtnp-dot paused' : 'mtnp-dot';
        const stateTxt = cur.paused ? 'Paused' : 'Playing now';
        const sharerTxt = cur.sharer ? `shared by @${esc(cur.sharer)}` : '';
        const canPause = cur.provider === 'youtube' || cur.provider === 'soundcloud';
        const pauseBtn = canPause
          ? `<button class="mtnp-btn mtnp-pp" onclick="Social._toggleNowPlaying()"
                    title="${cur.paused ? 'Resume' : 'Pause'}">${cur.paused ? '▶' : '⏸'}</button>`
          : '';
        // Middle action: share this track to the viewer's FrogSocial wall.
        const shareBtn = `<button class="mtnp-btn mtnp-share" onclick="Music.shareToWall()"
                                  title="Share this track to your wall" aria-label="Share to wall">↗</button>`;
        strip.hidden = false;
        strip.innerHTML = `
          <span class="${dotCls}"></span>
          <div class="mtnp-info">
            <div class="mtnp-state">${stateTxt}<span class="mtnp-prov" data-provider="${esc(cur.provider)}">${esc(providerLabel)}</span>${sharerTxt ? `<span class="mtnp-sharer">${sharerTxt}</span>` : ''}</div>
            <div class="mtnp-title" title="${esc(cur.title || '')}">${esc(cur.title || 'Music')}</div>
          </div>
          <div class="mtnp-ctrls">
            ${pauseBtn}
            ${shareBtn}
            <button class="mtnp-btn mtnp-stop" onclick="Music.close()" title="Stop">✕</button>
          </div>`;
    }
    try { _syncReelsMusicInterlock(); } catch {}
  }

  function _toggleNowPlaying() {
    if (window.Music && typeof Music.togglePauseGlobal === 'function') Music.togglePauseGlobal();
  }


  // One-time hookup of the music:statechange event so card UI stays in sync.
  let _musicEventsWired = false;
  function _wireMusicEvents() {
    if (_musicEventsWired) return;
    _musicEventsWired = true;
    document.addEventListener('music:statechange', () => _applyMusicState());
  }
  _wireMusicEvents();

  // Legacy alias (kept so older generated markup still functions).
  function _syncMusicTabActiveCard() { _applyMusicState(); }

  // Backwards-compat stubs — nothing pins a player anymore, but older
  // callers (stashed shortcuts, cached HTML) may still reference these.
  function stopMusicInTab() {
    if (window.Music && typeof window.Music.close === 'function') window.Music.close();
    document.querySelectorAll('.sf-music-card.is-playing').forEach(el => el.classList.remove('is-playing'));
  }
  function _openNowPlaying() { /* no-op: handled by mini-dock */ }

  // ── Polished music-share modal ────────────────────────────────────────
  // Shared by Social.promptMusicShare (URL entry) and Music.shareToWall
  // (current-track share). Replaces every window.prompt/confirm flow.
  //
  //   Social.openMusicShareModal({
  //     url, title, provider, caption, room,
  //     lockUrl,              // true = show URL as read-only (current track)
  //     onShare({caption, url, provider, privacy}) -> Promise
  //   })
  function openMusicShareModal(opts) {
    opts = opts || {};
    let modal = document.getElementById('music-share-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'music-share-modal';
      modal.className = 'modal-overlay hidden';
      modal.innerHTML = `
        <div class="modal-box music-share-box" onclick="event.stopPropagation()">
          <div class="msb-header">
            <div class="msb-title">🎵 Share to your wall</div>
            <button class="msb-close" onclick="Social._closeMusicShareModal()" title="Close">✕</button>
          </div>
          <div class="msb-preview" id="msb-preview">
            <div class="msb-art" id="msb-art">🎵</div>
            <div class="msb-meta">
              <div class="msb-track-title" id="msb-track-title">—</div>
              <div class="msb-track-sub" id="msb-track-sub"></div>
            </div>
          </div>
          <div class="msb-field">
            <label class="msb-label" for="msb-url">Track link</label>
            <input type="url" id="msb-url" class="msb-input"
                   placeholder="https://youtu.be/…  ·  open.spotify.com/track/…  ·  soundcloud.com/…"
                   autocomplete="off" spellcheck="false" />
            <div class="msb-hint" id="msb-hint">YouTube, Spotify, or SoundCloud links only.</div>
          </div>
          <div class="msb-field">
            <label class="msb-label" for="msb-caption">Caption <span class="msb-optional">(optional)</span></label>
            <textarea id="msb-caption" class="msb-textarea" rows="3" maxlength="500"
                      placeholder="Say something about this track…"></textarea>
            <div class="msb-counter"><span id="msb-counter-num">0</span>/500</div>
          </div>
          <div class="msb-field">
            <label class="msb-label">Mood <span class="msb-optional">(what's the vibe?)</span></label>
            <div class="msb-moods" id="msb-moods">
              <button type="button" class="msb-mood" data-mood=""           style="--mood:#888">None</button>
              <button type="button" class="msb-mood" data-mood="chill"      style="--mood:#6cc4ff">🎧 Chill</button>
              <button type="button" class="msb-mood" data-mood="hype"       style="--mood:#ff7a4d">🔥 Hype</button>
              <button type="button" class="msb-mood" data-mood="focus"      style="--mood:#b289ff">💼 Focus</button>
              <button type="button" class="msb-mood" data-mood="party"      style="--mood:#ff5ea8">🎉 Party</button>
              <button type="button" class="msb-mood" data-mood="late-night" style="--mood:#8ca0ff">🌙 Late-night</button>
              <button type="button" class="msb-mood" data-mood="morning"    style="--mood:#ffc55a">🌅 Morning</button>
              <button type="button" class="msb-mood" data-mood="sad"        style="--mood:#88aac2">🌧️ Sad</button>
              <button type="button" class="msb-mood" data-mood="romance"    style="--mood:#ff8fb5">💘 Romance</button>
            </div>
          </div>
          <div class="msb-field">
            <label class="msb-label">Visibility</label>
            <div class="msb-privacy" id="msb-privacy">
              <button type="button" class="msb-priv active" data-v="public">🌍 Public</button>
              <button type="button" class="msb-priv"        data-v="followers">👥 Followers</button>
              <button type="button" class="msb-priv"        data-v="friends">🐸 Friends</button>
            </div>
          </div>
          <div class="msb-footer">
            <button class="modal-btn secondary" onclick="Social._closeMusicShareModal()">Cancel</button>
            <button class="modal-btn primary" id="msb-submit" onclick="Social._submitMusicShare()">
              <span class="msb-submit-icon">🐸</span> Share
            </button>
          </div>
        </div>`;
      // Click-outside closes (but only on the overlay, not the box)
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeMusicShareModal();
      });
      document.body.appendChild(modal);

      // Wire live URL → preview + counter
      const urlEl = modal.querySelector('#msb-url');
      const capEl = modal.querySelector('#msb-caption');
      urlEl.addEventListener('input', () => _refreshMusicSharePreview());
      capEl.addEventListener('input', () => {
        const n = modal.querySelector('#msb-counter-num');
        if (n) n.textContent = String(capEl.value.length);
      });
      modal.querySelectorAll('.msb-priv').forEach(b => {
        b.addEventListener('click', () => {
          modal.querySelectorAll('.msb-priv').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
        });
      });
      modal.querySelectorAll('.msb-mood').forEach(b => {
        b.addEventListener('click', () => {
          modal.querySelectorAll('.msb-mood').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
        });
      });
      // Esc closes
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeMusicShareModal();
      });
    }

    // Populate + store callback for submission
    _musicShareOpts = opts;
    const urlEl = modal.querySelector('#msb-url');
    const capEl = modal.querySelector('#msb-caption');
    const titleEl = modal.querySelector('.msb-title');
    const submitBtn = modal.querySelector('#msb-submit');
    urlEl.value = opts.url || '';
    urlEl.readOnly = !!opts.lockUrl;
    urlEl.classList.toggle('is-locked', !!opts.lockUrl);
    capEl.value = opts.caption || '';
    modal.querySelector('#msb-counter-num').textContent = String(capEl.value.length);
    titleEl.textContent = opts.lockUrl ? '🎵 Share this track' : '🎵 Share a track';
    submitBtn.innerHTML = opts.lockUrl
      ? `<span class="msb-submit-icon">🐸</span> Share to wall`
      : `<span class="msb-submit-icon">🐸</span> Share`;

    // Reset privacy to public (or first available)
    modal.querySelectorAll('.msb-priv').forEach((b, i) => b.classList.toggle('active', i === 0));
    // Preselect mood — either the one the user clicked in the hero, or
    // none.
    const wantMood = String(opts.mood || '').toLowerCase();
    modal.querySelectorAll('.msb-mood').forEach(b => {
      b.classList.toggle('active', (b.dataset.mood || '') === wantMood);
    });
    // Ensure SOMETHING is active (default to "None" if we didn't match).
    if (!modal.querySelector('.msb-mood.active')) {
      modal.querySelector('.msb-mood[data-mood=""]')?.classList.add('active');
    }

    _refreshMusicSharePreview();
    // Defensively re-attach to <body> every open. Something in the social
    // overlay stacking context was clipping the modal under #social-overlay
    // (z-index 600). A direct body child with our explicit z-index wins.
    if (modal.parentNode !== document.body) {
      document.body.appendChild(modal);
    }
    modal.style.zIndex = '10050';
    modal.classList.remove('hidden');
    // Focus the first editable field
    setTimeout(() => {
      if (opts.lockUrl) capEl.focus();
      else urlEl.focus();
    }, 50);
  }

  let _musicShareOpts = null;

  function _refreshMusicSharePreview() {
    const modal = document.getElementById('music-share-modal');
    if (!modal) return;
    const url = (modal.querySelector('#msb-url').value || '').trim();
    const artEl = modal.querySelector('#msb-art');
    const titleEl = modal.querySelector('#msb-track-title');
    const subEl = modal.querySelector('#msb-track-sub');
    const hint = modal.querySelector('#msb-hint');
    const submit = modal.querySelector('#msb-submit');
    const preview = modal.querySelector('#msb-preview');

    if (!url) {
      preview.classList.add('is-empty');
      artEl.style.backgroundImage = '';
      artEl.textContent = '🎵';
      titleEl.textContent = 'Paste a link to preview';
      subEl.textContent = '';
      hint.className = 'msb-hint';
      hint.textContent = 'YouTube, Spotify, or SoundCloud links only.';
      if (submit) submit.disabled = !_musicShareOpts?.lockUrl;
      return;
    }
    const t = _parseMusicTrack(url, (_musicShareOpts && _musicShareOpts.provider) || '');
    preview.classList.remove('is-empty');
    preview.setAttribute('data-provider', t.provider);
    if (t.provider === 'link') {
      artEl.style.backgroundImage = '';
      artEl.textContent = '⚠';
      titleEl.textContent = 'Unsupported link';
      subEl.textContent = 'Only YouTube, Spotify, and SoundCloud are supported.';
      hint.className = 'msb-hint is-error';
      hint.textContent = 'This link is not a supported music provider.';
      if (submit) submit.disabled = true;
      return;
    }
    const label = t.provider === 'youtube' ? 'YouTube'
                : t.provider === 'spotify' ? 'Spotify'
                : t.provider === 'soundcloud' ? 'SoundCloud' : 'Music';
    if (t.thumb) {
      artEl.style.backgroundImage = `url('${t.thumb}')`;
      artEl.textContent = '';
    } else {
      artEl.style.backgroundImage = '';
      artEl.textContent = t.provider === 'spotify' ? '♫'
                        : t.provider === 'soundcloud' ? '☁️' : '🎵';
    }
    const incomingTitle = (_musicShareOpts && _musicShareOpts.title) || '';
    titleEl.textContent = incomingTitle || _prettyMusicFallbackTitle(url, t.provider);
    const bits = [label];
    if (_musicShareOpts && _musicShareOpts.room) bits.push(`from #${_musicShareOpts.room}`);
    subEl.textContent = bits.join(' · ');
    hint.className = 'msb-hint is-ok';
    hint.textContent = `✓ Detected ${label}`;
    if (submit) submit.disabled = false;
    if (!incomingTitle) {
      const currentUrl = url;
      _fetchMusicTitle(currentUrl, t.provider).then(title => {
        if (!title || !_musicShareOpts) return;
        const liveModal = document.getElementById('music-share-modal');
        const liveUrl = (liveModal?.querySelector('#msb-url')?.value || '').trim();
        if (liveUrl !== currentUrl) return;
        _musicShareOpts.title = title;
        const liveTitleEl = liveModal?.querySelector('#msb-track-title');
        if (liveTitleEl) liveTitleEl.textContent = title;
      }).catch(() => {});
    }
  }

  function closeMusicShareModal() {
    const modal = document.getElementById('music-share-modal');
    if (modal) modal.classList.add('hidden');
    _musicShareOpts = null;
  }
  // Alias used by inline onclick handlers.
  const _closeMusicShareModal = closeMusicShareModal;

  async function _submitMusicShare() {
    const modal = document.getElementById('music-share-modal');
    if (!modal || !_musicShareOpts) return;
    const url = (modal.querySelector('#msb-url').value || '').trim();
    const caption = (modal.querySelector('#msb-caption').value || '').trim();
    const privacyBtn = modal.querySelector('.msb-priv.active');
    const privacy = (privacyBtn && privacyBtn.dataset.v) || 'public';
    const moodBtn = modal.querySelector('.msb-mood.active');
    const mood = (moodBtn && moodBtn.dataset.mood) || '';
    const submit = modal.querySelector('#msb-submit');
    if (!url) { UI.showToast('Please paste a link', 'error'); return; }
    const t = _parseMusicTrack(url, (_musicShareOpts.provider) || '');
    if (t.provider === 'link') {
      UI.showToast('Only YouTube, Spotify, or SoundCloud links are supported', 'error');
      return;
    }
    if (submit) { submit.disabled = true; submit.classList.add('is-loading'); }
    try {
      const opts = _musicShareOpts;
      if (typeof opts.onShare === 'function') {
        await opts.onShare({ caption, url, provider: t.provider, privacy, mood });
      } else {
        // Default: post directly via wall API. Track title + source room
        // ride along as first-class fields so the rendered music card can
        // show the real title.
        const res = await api('/api/wall/posts', 'POST', {
          content: caption,
          media_data: url,
          media_type: `music/${t.provider}`,
          privacy,
          allow_comments: true,
          track_title: (_musicShareOpts && _musicShareOpts.title) || null,
          track_room:  (_musicShareOpts && _musicShareOpts.room)  || null,
          track_mood:  mood || null,
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || `Server error ${res.status}`);
        }
      }
      UI.showToast('🐸 Shared to your wall', 'success');
      closeMusicShareModal();
      if (_currentTab === 'music') loadMusicTab();
      else if (_currentTab === 'feed') loadFeed();
    } catch (e) {
      UI.showToast(e.message || 'Could not share', 'error');
      if (submit) { submit.disabled = false; submit.classList.remove('is-loading'); }
    }
  }

  // Public entry point — opens the polished modal for a free-form URL share.
  // An optional `mood` preselects one of the mood chips in the modal.
  function promptMusicShare(mood) {
    openMusicShareModal({ lockUrl: false, mood: mood || '' });
  }

  // ── reaction rendering helpers ───────────────────────────────────────────

  function _reactionUsersArray(value) {
    if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
    return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
  }

  function _normalizeReactions(reactions) {
    if (!Array.isArray(reactions)) return [];
    return reactions
      .filter(r => r && r.emoji)
      .map(r => ({
        emoji: String(r.emoji),
        count: Number(r.count || 0),
        users: _reactionUsersArray(r.users),
      }))
      .sort((a, b) => (b.count - a.count) || a.emoji.localeCompare(b.emoji));
  }

  function _updateReactionsInCaches(postId, reactions) {
    const pid = Number(postId);
    const apply = (posts) => {
      if (!Array.isArray(posts)) return;
      posts.forEach(p => {
        if (Number(p?.id) === pid) {
          p.reactions = reactions;
          p.reaction_count = reactions.reduce((n, r) => n + Number(r.count || 0), 0);
          p.i_liked = !!reactions.find(r => r.emoji === '❤️' && r.users.includes(String(State?.user?.nickname || '')));
        }
      });
    };
    apply(_feedCache?.posts);
    _exploreCache.forEach(entry => apply(entry?.posts));
    _reelsCache.forEach(entry => apply(entry?.posts));
    _musicCache.forEach(entry => apply(entry?.posts));
    _profilePostsCache.forEach(entry => apply(entry?.posts));
    _profileRepostsCache.forEach(entry => apply(entry?.posts));
  }

  function _updateReelReactionUi(postId, reactions, myNick) {
    const card = document.querySelector(`.reel-card[data-post-id="${postId}"]`);
    if (!card) return;
    const total = reactions.reduce((s, r) => s + Number(r.count || 0), 0);
    const heart = reactions.find(r => r.emoji === '❤️');
    const heartCount = Number(heart?.count || 0);
    const meHeart = !!heart?.users?.includes(myNick);
    const likeBtn = card.querySelector('.reel-act-btn[title="Like"]');
    const likeCountEl = card.querySelector('.reel-like-count');
    if (likeCountEl) likeCountEl.textContent = String(heartCount);
    if (likeBtn) likeBtn.classList.toggle('liked', meHeart);
    card.dataset.reactionCount = String(total);
  }

  function _renderReactionBar(reactions, myNick, postId) {
    const total = Math.round(reactions.reduce((s, r) => s + Number(r.count || 0), 0));
    const myReaction = reactions.find(r => {
      const users = _reactionUsersArray(r.users);
      return users.includes(myNick);
    });
    const myEmoji = myReaction ? myReaction.emoji : '';
    const sorted = [...reactions].sort((a, b) => (Number(b.count || 0) - Number(a.count || 0)) || String(a.emoji).localeCompare(String(b.emoji)));
    const top = sorted[0] || null;
    const topEmoji = top ? top.emoji : '😊';
    const label = total > 0 ? String(total) : 'React';
    const pid = Number(postId) || 0;
    return `<div class="sf-rx-bar">` +
      `<button type="button" class="sf-rx-main${myEmoji ? ' active' : ''}" data-my-emoji="${esc(myEmoji)}" ` +
      `data-post-id="${pid}" aria-label="React to post">` +
      `${topEmoji} <span class="sf-rx-main-label">${esc(label)}</span>` +
      `</button></div>`;
  }

  function _updatePostReactions(postEl, reactions, myNick) {
    if (!postEl) return;
    const postId = postEl.dataset.postId;
    const bar = postEl.querySelector('.sf-rx-bar');
    if (bar) {
      const tmp = document.createElement('div');
      tmp.innerHTML = _renderReactionBar(reactions, myNick, postId);
      bar.replaceWith(tmp.firstElementChild);
    }
  }

  function _updateAllPostReactionBars(postId, reactions, myNick) {
    document.querySelectorAll(`.sf-post[data-post-id="${postId}"]`).forEach(el => {
      _updatePostReactions(el, reactions, myNick);
    });
  }

  function _updateRepostsInCaches(postId, newRepostCount, isReposted) {
    const pid = Number(postId);
    const myNick = String(State?.user?.nickname || '');
    const apply = (posts) => {
      if (!Array.isArray(posts)) return;
      posts.forEach(p => {
        if (Number(p?.id) === pid) {
          p.repost_count = Number(newRepostCount || 0);
          p.i_reposted = !!isReposted;
        }
      });
    };
    apply(_feedCache?.posts);
    _exploreCache.forEach(entry => apply(entry?.posts));
    _reelsCache.forEach(entry => apply(entry?.posts));
    _musicCache.forEach(entry => apply(entry?.posts));
    _profilePostsCache.forEach(entry => apply(entry?.posts));
    _profileRepostsCache.forEach(entry => apply(entry?.posts));
  }

  // Strip a post from every in-memory cache after a delete. Without
  // this a deleted post would resurrect every time the user navigated
  // back to a cached tab — the cache TTL is 5 minutes and the network
  // refetch only happens in the background, so the stale entry paints
  // first. Also nukes any rendered DOM cards bearing that id.
  function _purgePostFromCaches(postId) {
    const pid = Number(postId);
    if (!Number.isFinite(pid) || pid <= 0) return;
    const filterOut = (posts) => Array.isArray(posts)
      ? posts.filter(p => Number(p?.id) !== pid)
      : posts;
    if (_feedCache && Array.isArray(_feedCache.posts)) {
      _feedCache.posts = filterOut(_feedCache.posts);
    }
    _exploreCache.forEach(entry => { if (entry) entry.posts = filterOut(entry.posts); });
    _reelsCache.forEach(entry => { if (entry) entry.posts = filterOut(entry.posts); });
    _musicCache.forEach(entry => { if (entry) entry.posts = filterOut(entry.posts); });
    _profilePostsCache.forEach(entry => { if (entry) entry.posts = filterOut(entry.posts); });
    try { _profileRepostsCache.forEach(entry => { if (entry) entry.posts = filterOut(entry.posts); }); } catch {}
    try {
      document.querySelectorAll(`.sf-post[data-post-id="${pid}"], .social-grid-item[data-post-id="${pid}"]`)
        .forEach(el => el.remove());
    } catch {}
  }

  function _updateAllPostRepostBars(postId, newRepostCount, isReposted) {
    document.querySelectorAll(`.sf-post[data-post-id="${postId}"] [data-role="repost-toggle"]`).forEach(btn => {
      btn.classList.toggle('liked', !!isReposted);
      btn.innerHTML = `🔁 ${Number(newRepostCount || 0)}`;
    });
  }

  function renderFeedPost(p) {
    const reactions = p.reactions || [];

    let mediaHtml = '';
    let isMusicPost = false;
    if (p.media_data && p.media_type) {
      if (p.media_type.startsWith('image/')) {
        mediaHtml = `<div class="sf-media"><img src="${esc(p.media_data)}" alt="" loading="lazy" decoding="async" onclick="if(typeof openLightbox==='function')openLightbox(this.src)" onerror="this.closest('.sf-media')?.remove()"></div>`;
      } else if (p.media_type.startsWith('video/')) {
        mediaHtml = `<div class="sf-media"><video src="${esc(_authMediaSrc(p.media_data))}" poster="${esc(_authMediaThumb(p.media_data))}" preload="metadata" playsinline onerror="this.closest('.sf-media')?.remove()"></video></div>`;
      } else if (p.media_type.startsWith('music/')) {
        mediaHtml = _renderMusicCard(p);
        isMusicPost = true;
      }
    }

    // For music posts, strip legacy auto-generated lines (emoji prefix +
    // standalone URL) — the card already shows that info. Leaves only
    // the user's real caption text.
    let postText = p.content || '';
    if (isMusicPost && postText) {
      postText = postText
        .split(/\r?\n/)
        .filter(line => {
          const t = line.trim();
          if (!t) return false;
          if (/^🎵\s*(Now playing|Sharing)/i.test(t)) return false;
          // Drop lines that are just the shared URL (or any bare URL).
          if (/^https?:\/\/\S+$/i.test(t)) return false;
          return true;
        })
        .join('\n')
        .trim();
    }

    const postPrivacy = String(p.privacy || 'public').toLowerCase();
    const shareEnabled = Number(p.share_enabled ?? 1) === 1;
    const canAudienceShare = (postPrivacy === 'public' || postPrivacy === 'followers');
    const isRepostCard = String(p.feed_kind || 'post') === 'repost';
    const repostByNick = String(p.repost_by_nickname || '').trim();
    const repostByEsc = esc(repostByNick || p.nickname || '');
    const repostQuote = String(p.repost_quote || '').trim();
    const displayTime = isRepostCard ? (p.feed_sort_at || p.created_at) : p.created_at;
    const repostCount = Number(p.repost_count || 0);
    const iReposted = Number(p.i_reposted || 0) === 1;
    const escNick = esc(p.nickname);
    const repostContextHtml = isRepostCard
      ? `<div class="sf-repost-context">
           <span class="sf-repost-icon">🔁</span>
           <button type="button" class="sf-repost-by" onclick="Social.openProfile('${repostByEsc}')">${repostByEsc}</button>
           <span class="sf-repost-word">reposted</span>
           ${repostQuote ? `<div class="sf-repost-quote">${_formatPostContent(repostQuote)}</div>` : ''}
         </div>`
      : '';
    const repostBtnHtml = !canAudienceShare
      ? ''
      : (shareEnabled
        ? `<button type="button" data-role="repost-toggle" class="sf-comment-btn ${iReposted ? 'liked' : ''}" title="Repost" aria-label="Repost" onclick="Social.toggleRepost(event, ${p.id}, { nickname: '${escNick}', privacy: '${esc(postPrivacy)}', shareEnabled: 1 })">🔁 ${repostCount}</button>`
        : `<button type="button" class="sf-comment-btn" title="Repost disabled" aria-label="Repost disabled" disabled><span style="text-decoration:line-through;opacity:.75">🔁</span> ${repostCount}</button>`);
    const shareBtnHtml = !canAudienceShare
      ? ''
      : (shareEnabled
        ? `<button type="button" class="sf-react-btn" title="Share post" aria-label="Share post" onclick="Social.sharePostUrl(${p.id}, { nickname: '${escNick}', privacy: '${esc(postPrivacy)}', shareEnabled: 1, text: ${jsStr(postText)} })">📤</button>`
        : `<button type="button" class="sf-react-btn" title="Share disabled" aria-label="Share disabled" disabled><span style="text-decoration:line-through;opacity:.75">📤</span></button>`);

    return `
    <div class="sf-post" data-post-id="${p.id}">
      ${repostContextHtml}
      <div class="sf-post-header">
        <div class="sf-post-avatar" onclick="Social.openProfile('${escNick}')">${UI.avatarEl(p.avatar, p.nickname, 36)}</div>
        <div class="sf-post-info" onclick="Social.openProfile('${escNick}')">
          <span class="sf-post-nick">${escNick}</span>
          <span class="sf-post-time">${timeAgo(displayTime)}</span>
        </div>
        <button class="sf-post-menu" title="More options" aria-label="Post options"
          data-nick="${escNick}" data-uid="${p.user_id}" data-pid="${p.id}" data-privacy="${esc(postPrivacy)}" data-share-enabled="${Number(p.share_enabled ?? 1)}" data-i-reposted="${iReposted ? 1 : 0}"
          onclick="event.stopPropagation();Social.openPostMenu(this)">⋯</button>
      </div>
      ${postText ? `<div class="sf-post-text ${isMusicPost ? 'is-music-caption' : ''}">${_formatPostContent(postText)}</div>` : ''}
      ${mediaHtml}
      <div class="sf-post-actions">
        ${_renderReactionBar(reactions, State.user?.nickname || '', p.id)}
        <button type="button" class="sf-comment-btn" onclick="Social.toggleComments(event, ${p.id})">💬 ${p.comment_count || 0}</button>
        ${repostBtnHtml}
        ${shareBtnHtml}
      </div>
      <div class="sf-comments" id="sf-comments-${p.id}" style="display:none"></div>
    </div>`;
  }

  // ── interactions ────────────────────────────────────────────────────────
  // Drop stale profile-cache entries so the next loadProfile() refetches.
  // Without this, after a follow/friend action the cached profile is
  // returned (still showing is_following:false) and the button reverts.
  function _invalidateProfileCache(nickname) {
    try {
      const k = String(nickname || '').toLowerCase();
      if (k) _profileCache.delete(k);
      const me = String(State?.user?.nickname || '').toLowerCase();
      if (me) _profileCache.delete(me);
    } catch {}
  }

  async function toggleFollow(nickname, btn) {
    const isFollowing = btn?.textContent?.trim() === 'Following' || btn?.textContent?.trim() === 'Unfollow';
    const method = isFollowing ? 'DELETE' : 'POST';
    if (btn) btn.disabled = true;
    try {
      const res = await api('/api/social/follow/' + encodeURIComponent(nickname), method);
      if (!res.ok) {
        UI?.showToast?.('Could not update follow', 'error');
        return;
      }
      const data = await res.json().catch(() => ({}));
      // Invalidate the cached profile so any later open/refresh sees fresh state.
      _invalidateProfileCache(nickname);
      if (btn) {
        if (data.following) {
          btn.textContent = 'Following';
          btn.classList.remove('primary');
          btn.classList.add('secondary');
        } else {
          btn.textContent = 'Follow';
          btn.classList.remove('secondary');
          btn.classList.add('primary');
        }
      }
      // Patch follower count in-place rather than reloading the whole profile.
      // Reloading would (a) flash a skeleton over working UI and (b) historically
      // returned the stale cached profile, undoing this very button update.
      if (_currentTab === 'profile' && _profileUser === nickname && typeof data.follower_count === 'number') {
        try {
          const stats = document.querySelectorAll('.sp-stats .sp-stat strong');
          // [posts, followers, following]
          if (stats[1]) stats[1].textContent = String(data.follower_count);
        } catch {}
      }
    } catch {
      UI?.showToast?.('Network error', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function reactPost(ev, postId, emoji) {
    try {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
    } catch {}
    // Close legacy inline pickers if any
    document.querySelectorAll('.sf-react-picker').forEach(p => p.remove());
    const eventPostEl = ev?.target?.closest?.('.sf-post[data-post-id]') || null;
    const postEl = eventPostEl && Number(eventPostEl.dataset.postId) === Number(postId)
      ? eventPostEl
      : document.querySelector(`.sf-post[data-post-id="${postId}"]`);
    const myNick = State.user?.nickname || '';
    const addBtn = postEl?.querySelector('.sf-rx-main');
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.classList.add('is-pending');
    }
    try {
      const res = await api(`/api/wall/posts/${postId}/reactions`, 'POST', { emoji });
      if (!res.ok) throw new Error('Failed to react');
      const data = await res.json();
      const reactions = _normalizeReactions(data.reactions || []);
      _updateReactionsInCaches(postId, reactions);
      _updateAllPostReactionBars(postId, reactions, myNick);
      _updateReelReactionUi(postId, reactions, myNick);
      const openPanel = document.querySelector('.sf-rx-panel-overlay[data-post-id]');
      if (openPanel && Number(openPanel.dataset.postId) === Number(postId)) {
        showReactPicker(null, postId, { refresh: true });
      }
    } catch (e) {
      try { UI.showToast(e?.message || 'Could not update reaction', 'error'); } catch {}
    } finally {
      if (addBtn && addBtn.isConnected) {
        addBtn.disabled = false;
        addBtn.classList.remove('is-pending');
      }
    }
  }

  async function toggleRepost(ev, postId, meta = {}) {
    if (typeof ev === 'number') {
      const reelBtn = postId && typeof postId.closest === 'function' ? postId : null;
      postId = Number(ev);
      ev = null;
      meta = { ...(meta || {}), _reelBtn: reelBtn };
    }
    try {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
    } catch {}
    const privacy = String(meta.privacy || 'public').toLowerCase();
    const shareEnabled = Number(meta.shareEnabled ?? 1) === 1;
    if (!shareEnabled) {
      try { UI.showToast('Repost is disabled for this post', 'info'); } catch {}
      return;
    }
    if (privacy !== 'public' && privacy !== 'followers') {
      try { UI.showToast('Only public and followers posts can be reposted', 'info'); } catch {}
      return;
    }
    const postEl = document.querySelector(`.sf-post[data-post-id="${postId}"]`);
    const btn = postEl?.querySelector('[data-role="repost-toggle"]');
    const reelBtn = meta?._reelBtn || document.querySelector(`.reel-card[data-post-id="${postId}"] .reel-act-btn[title="Repost"]`);
    const reelIconEl = reelBtn?.querySelector('.reel-act-icon');
    const reelCountEl = reelBtn?.querySelector('.reel-repost-count');
    const prevActive = !!btn?.classList.contains('liked');
    const countMatch = (btn?.textContent || '').match(/(\d+)\s*$/);
    const prevCount = countMatch ? Number(countMatch[1]) : 0;
    const prevReelCount = Number(reelCountEl?.textContent || '0');
    const prevReelIcon = reelIconEl?.textContent || '↩️';
    const prevReelActive = !!reelBtn?.classList.contains('liked');

    if (btn) {
      btn.classList.toggle('liked', !prevActive);
      const next = Math.max(0, prevCount + (!prevActive ? 1 : -1));
      btn.innerHTML = `🔁 ${next}`;
      btn.disabled = true;
    }
    if (reelBtn && reelCountEl && reelIconEl) {
      const optimistic = Math.max(0, prevReelCount + ((prevReelIcon === '🔁') ? -1 : 1));
      reelCountEl.textContent = String(optimistic);
      reelIconEl.textContent = prevReelIcon === '🔁' ? '↩️' : '🔁';
      reelBtn.classList.toggle('liked', !prevReelActive);
      reelBtn.disabled = true;
    }
    try {
      const payload = {};
      if (typeof meta.quote === 'string') payload.quote = meta.quote;
      const res = await api(`/api/wall/posts/${postId}/repost`, 'POST', payload);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not repost');
      if (btn) {
        btn.classList.toggle('liked', !!data.reposted);
        btn.innerHTML = `🔁 ${Number(data.repost_count || 0)}`;
      }
      if (reelCountEl && reelIconEl) {
        reelCountEl.textContent = String(Number(data.repost_count || 0));
        reelIconEl.textContent = data.reposted ? '🔁' : '↩️';
        if (reelBtn) reelBtn.classList.toggle('liked', !!data.reposted);
      }
      _updateRepostsInCaches(postId, data.repost_count || 0, data.reposted);
      _updateAllPostRepostBars(postId, data.repost_count || 0, data.reposted);
      try {
        UI.showToast(data.reposted ? (payload.quote ? 'Quote reposted' : 'Reposted') : 'Repost removed', 'success');
      } catch {}
    } catch (e) {
      if (btn) {
        btn.classList.toggle('liked', prevActive);
        btn.innerHTML = `🔁 ${prevCount}`;
      }
      if (reelCountEl && reelIconEl) {
        reelCountEl.textContent = String(prevReelCount);
        reelIconEl.textContent = prevReelIcon;
        if (reelBtn) reelBtn.classList.toggle('liked', prevReelActive);
      }
      try { UI.showToast(e?.message || 'Could not repost', 'error'); } catch {}
    } finally {
      if (btn) btn.disabled = false;
      if (reelBtn) reelBtn.disabled = false;
    }
  }

  function showReactPicker(ev, postId, opts = {}) {
    try {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
    } catch {}
    const refresh = !!opts.refresh;
    const old = document.querySelector('.sf-rx-panel-overlay');
    if (old && !refresh && Number(old.dataset.postId || 0) === Number(postId)) {
      old.remove();
      return;
    }
    old?.remove();

    const postEl = document.querySelector(`[data-post-id="${postId}"]`);
    const myEmoji = postEl?.querySelector('.sf-rx-main')?.dataset?.myEmoji || '';
    const emojis = ['❤️','👍','😂','😮','😢','🔥','🐸','👏','💯','✨'];
    const overlay = document.createElement('div');
    overlay.className = 'sf-rx-panel-overlay';
    overlay.dataset.postId = String(postId);
    const removeBtnHtml = myEmoji
      ? `<button type="button" class="sf-rx-picker-btn remove" onclick="Social.reactPost(event, ${postId},${jsStr(myEmoji)})">Remove ${myEmoji}</button>`
      : '';
    overlay.innerHTML = `
      <div class="sf-rx-panel">
        <div class="sf-rx-panel-header">
          <div class="sf-rx-panel-title">Reactions</div>
          <button class="sf-rx-panel-close" onclick="this.closest('.sf-rx-panel-overlay').remove()">✕</button>
        </div>
        <div class="sf-rx-panel-list-wrap">
          <div class="sf-rx-panel-tabs"></div>
          <div class="sf-rx-panel-list"><div class="sf-rx-detail-loading">Loading reactions…</div></div>
        </div>
        <div class="sf-rx-picker-wrap">
          <div class="sf-rx-picker-title">Pick your reaction</div>
          <div class="sf-rx-picker-grid">${removeBtnHtml + emojis.map(e =>
            `<button type="button" class="sf-rx-picker-btn ${e === myEmoji ? 'active' : ''}" onclick="Social.reactPost(event, ${postId},'${e}')">${e}</button>`
          ).join('')}</div>
        </div>
      </div>`;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    const tabsEl = overlay.querySelector('.sf-rx-panel-tabs');
    const listEl = overlay.querySelector('.sf-rx-panel-list');
    api(`/api/wall/posts/${postId}/reactions/detail`).then(res => res.json()).then(data => {
      const rows = Array.isArray(data.reactions) ? data.reactions : [];
      const me = String(State?.user?.nickname || '');
      const emojisPresent = [...new Set(rows.map(r => String(r.emoji || '')))].filter(Boolean);
      const renderList = (filter) => {
        const filtered = filter === 'all' ? rows : rows.filter(r => r.emoji === filter);
        if (!filtered.length) {
          listEl.innerHTML = '<div class="sf-rx-detail-empty">No reactions yet</div>';
          return;
        }
        listEl.innerHTML = filtered.map(r => {
          const isMe = String(r.nickname || '') === me;
          const av = r.avatar
            ? `<img src="${esc(r.avatar)}" alt="" loading="lazy" onerror="this.style.display='none'">`
            : `<div style="display:flex;align-items:center;justify-content:center;font-size:18px">🐸</div>`;
          return `<div class="sf-rx-detail-row${isMe ? ' is-me' : ''}">
            <div class="sf-rx-detail-avatar" onclick="Social.openProfile('${esc(r.nickname)}')">${av}</div>
            <span class="sf-rx-detail-nick" onclick="Social.openProfile('${esc(r.nickname)}')">${esc(r.nickname)}</span>
            <span class="sf-rx-detail-emoji">${esc(r.emoji)}</span>
            <span class="sf-rx-detail-time">${esc(timeAgo(r.created_at))}</span>
          </div>`;
        }).join('');
      };
      tabsEl.innerHTML = `<button type="button" class="sf-rx-tab active" data-filter="all">All ${rows.length}</button>` +
        emojisPresent.map(e => {
          const count = rows.filter(r => r.emoji === e).length;
          return `<button type="button" class="sf-rx-tab" data-filter="${esc(e)}">${esc(e)} ${count}</button>`;
        }).join('');
      tabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.sf-rx-tab');
        if (!btn) return;
        tabsEl.querySelectorAll('.sf-rx-tab').forEach(b => b.classList.toggle('active', b === btn));
        renderList(btn.dataset.filter || 'all');
      });
      renderList('all');
    }).catch(() => {
      listEl.innerHTML = '<div class="sf-rx-detail-empty">Could not load reactions</div>';
    });
  }

  async function showReactionDetail(postId) {
    showReactPicker(null, postId);
  }

  async function toggleComments(ev, postId) {
    if (typeof postId === 'undefined' && (typeof ev === 'number' || typeof ev === 'string')) {
      postId = Number(ev);
      ev = null;
    }
    try {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
    } catch {}
    const el = document.getElementById(`sf-comments-${postId}`);
    if (!el) return;
    if (el.style.display !== 'none') { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = _commentsSkeletonHtml(3, true);
    try {
      const res = await api(`/api/wall/posts/${postId}/comments`);
      const data = await res.json();
      const comments = data.comments || [];
      let html = '';
      if (comments.length === 0) {
        html += '<div style="color:#666;font-size:12px;padding:8px 0;text-align:center">No comments yet</div>';
      } else {
        html += comments.map(c => {
          const myVote = Number(c.my_vote || 0);
          const upCount = Number(c.like_count || 0);
          const downCount = Number(c.dislike_count || 0);
          const upActive = myVote === 1 ? ' is-up' : '';
          const downActive = myVote === -1 ? ' is-down' : '';
          return `
          <div class="sf-comment" data-comment-id="${c.id}">
            <div class="sf-comment-avatar" onclick="Social.openProfile('${esc(c.nickname)}')">${UI.avatarEl(c.avatar, c.nickname, 24)}</div>
            <div class="sf-comment-body">
              <span class="sf-comment-nick" onclick="Social.openProfile('${esc(c.nickname)}')">${esc(c.nickname)}</span>
              <span class="sf-comment-text">${esc(c.content)}</span>
              <span class="sf-comment-time">${timeAgo(c.created_at)}</span>
              <div class="sf-comment-votes">
                <button type="button" class="sf-vote-btn${upActive}" data-vote="up" onclick="Social.voteComment(event, ${postId}, ${c.id}, 1, this)" aria-label="Like comment">
                  <span class="sf-vote-icon">👍</span><span class="sf-vote-count">${upCount}</span>
                </button>
                <button type="button" class="sf-vote-btn${downActive}" data-vote="down" onclick="Social.voteComment(event, ${postId}, ${c.id}, -1, this)" aria-label="Dislike comment">
                  <span class="sf-vote-icon">👎</span><span class="sf-vote-count">${downCount}</span>
                </button>
              </div>
            </div>
            ${c.user_id === State.user?.id ? `<button class="sf-comment-del" onclick="Social.deleteComment(${c.id},${postId})">✕</button>` : ''}
          </div>
        `;}).join('');
      }
      html += `
        <div class="sf-comment-input">
          <input id="sf-ci-${postId}" placeholder="Add a comment…" onkeydown="if(event.key==='Enter'){Social.submitComment(${postId})}">
          <button onclick="Social.submitComment(${postId})">Post</button>
        </div>`;
      el.innerHTML = html;
    } catch {
      el.innerHTML = '<div style="color:#666;font-size:12px;padding:8px">Could not load comments</div>';
    }
  }

  async function submitComment(postId) {
    const input = document.getElementById(`sf-ci-${postId}`);
    if (!input || !input.value.trim()) return;
    try {
      const res = await api(`/api/wall/posts/${postId}/comments`, 'POST', { content: input.value.trim() });
      if (res.ok) {
        input.value = '';
        toggleComments(postId); // close
        toggleComments(postId); // reopen & reload
      }
    } catch {}
  }

  async function deleteComment(commentId, postId) {
    try {
      await api(`/api/wall/comments/${commentId}`, 'DELETE');
      toggleComments(postId);
      toggleComments(postId);
    } catch {}
  }

  async function voteComment(ev, postId, commentId, value, btn) {
    try { ev?.preventDefault?.(); ev?.stopPropagation?.(); } catch {}
    if (!btn || btn.dataset.pending === '1') return;
    const wrap = btn.closest('.sf-comment');
    if (!wrap) return;
    const upBtn = wrap.querySelector('.sf-vote-btn[data-vote="up"]');
    const downBtn = wrap.querySelector('.sf-vote-btn[data-vote="down"]');
    const upCountEl = upBtn?.querySelector('.sf-vote-count');
    const downCountEl = downBtn?.querySelector('.sf-vote-count');
    const wasUp = upBtn?.classList.contains('is-up');
    const wasDown = downBtn?.classList.contains('is-down');
    let newValue = value;
    if (value === 1 && wasUp) newValue = 0;
    if (value === -1 && wasDown) newValue = 0;
    const prevUp = Number(upCountEl?.textContent || '0');
    const prevDown = Number(downCountEl?.textContent || '0');
    let nextUp = prevUp;
    let nextDown = prevDown;
    if (wasUp && newValue !== 1) nextUp -= 1;
    if (!wasUp && newValue === 1) nextUp += 1;
    if (wasDown && newValue !== -1) nextDown -= 1;
    if (!wasDown && newValue === -1) nextDown += 1;
    if (upCountEl) upCountEl.textContent = String(Math.max(0, nextUp));
    if (downCountEl) downCountEl.textContent = String(Math.max(0, nextDown));
    upBtn?.classList.toggle('is-up', newValue === 1);
    downBtn?.classList.toggle('is-down', newValue === -1);
    if (upBtn) upBtn.dataset.pending = '1';
    if (downBtn) downBtn.dataset.pending = '1';
    try {
      const res = await api(`/api/wall/posts/${postId}/comments/${commentId}/vote`, 'POST', { value: newValue });
      if (!res.ok) throw new Error('vote failed');
      const d = await res.json();
      if (upCountEl) upCountEl.textContent = String(d.like_count || 0);
      if (downCountEl) downCountEl.textContent = String(d.dislike_count || 0);
      upBtn?.classList.toggle('is-up', Number(d.my_vote) === 1);
      downBtn?.classList.toggle('is-down', Number(d.my_vote) === -1);
    } catch {
      if (upCountEl) upCountEl.textContent = String(prevUp);
      if (downCountEl) downCountEl.textContent = String(prevDown);
      upBtn?.classList.toggle('is-up', !!wasUp);
      downBtn?.classList.toggle('is-down', !!wasDown);
      if (typeof UI !== 'undefined' && UI.showToast) UI.showToast('Could not vote', 'error');
    } finally {
      if (upBtn) delete upBtn.dataset.pending;
      if (downBtn) delete downBtn.dataset.pending;
    }
  }

  async function deletePost(postId) {
    if (!confirm('Delete this post?')) return;
    try {
      await api(`/api/wall/posts/${postId}`, 'DELETE');
      _purgePostFromCaches(postId);
      if (_currentTab === 'feed') loadFeed();
      else if (_currentTab === 'explore') loadExplore();
      else if (_currentTab === 'profile') loadProfile(_profileUser);
    } catch {}
  }

  async function deletePostDirect(postId) {
    try {
      await api(`/api/wall/posts/${postId}`, 'DELETE');
      _purgePostFromCaches(postId);
      try { UI.showToast('Post deleted', 'success'); } catch {}
      if (_currentTab === 'feed') loadFeed();
      else if (_currentTab === 'explore') loadExplore();
      else if (_currentTab === 'profile') loadProfile(_profileUser);
    } catch (e) {
      try { UI.showToast(e?.message || 'Could not delete post', 'error'); } catch {}
      throw e;
    }
  }

  async function deletePostMediaOnly(postId) {
    try {
      const res = await api(`/api/wall/posts/${postId}/media`, 'DELETE');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not delete media');
      try { UI.showToast('Media removed from post', 'success'); } catch {}
      if (_currentTab === 'profile') {
        await loadProfileMediaCombined(_profileUser, 'public');
      } else if (_currentTab === 'feed') {
        await loadFeed();
      } else if (_currentTab === 'explore') {
        await loadExplore();
      }
    } catch (e) {
      try { UI.showToast(e?.message || 'Could not delete media', 'error'); } catch {}
      throw e;
    }
  }

  async function promptDeletePrivateMedia(msgId) {
    if (!msgId) return;
    const items = [
      {
        icon: '🗑️',
        label: 'Delete from Private Media and chat',
        danger: true,
        onclick: async () => {
          try {
            const r = await apiFetch(`/api/messages/${msgId}`, 'DELETE');
            if (!r.ok) throw new Error('Could not delete media');
            try { UI.showToast('Deleted from Private Media and original chat', 'success'); } catch {}
            await loadProfileMediaCombined(_profileUser, 'private');
          } catch (e) {
            try { UI.showToast(e?.message || 'Could not delete media', 'error'); } catch {}
          }
        }
      }
    ];
    if (typeof showActionSheet === 'function') {
      showActionSheet('Delete this media from chat history too?', items);
      return;
    }
    if (confirm('Delete this private media from chat history too?')) {
      items[0].onclick();
    }
  }

  async function promptDeletePostMedia(postId) {
    if (!postId) return;
    try {
      const res = await api(`/api/wall/posts/${postId}`);
      if (!res.ok) return;
      const p = await res.json();
      const mine = Number(p.user_id || 0) === Number(State.user?.id || 0);
      if (!mine) {
        try { UI.showToast('Only your own posts can be modified', 'info'); } catch {}
        return;
      }
      const hasText = !!String(p.content || '').trim();
      const hasExtra = !!String(p.track_title || '').trim() || !!String(p.track_room || '').trim() || !!String(p.track_mood || '').trim();
      const canDeleteMediaOnly = hasText || hasExtra;
      await openMediaDeleteDialog(p, canDeleteMediaOnly);
    } catch {
      try { UI.showToast('Could not load post', 'error'); } catch {}
    }
  }

  async function openMediaDeleteDialog(post, canDeleteMediaOnly) {
    let overlay = document.getElementById('social-post-detail');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'social-post-detail';
      overlay.onclick = e => { if (e.target === overlay) overlay.style.display = 'none'; };
      document.body.appendChild(overlay);
    }

    const mediaBtn = canDeleteMediaOnly
      ? `<button type="button" class="modal-btn secondary" id="spmd-del-media-btn">Remove Media Only</button>`
      : `<button type="button" class="modal-btn secondary" id="spmd-del-media-btn" disabled title="Media-only post: delete full post instead" style="opacity:.5;cursor:not-allowed">Remove Media Only</button>`;

    overlay.innerHTML = `<div class="spd-inner spmd-mode">
      <button class="social-close-btn" onclick="Social.closePostDetail()" style="position:absolute;top:8px;right:8px;z-index:1">✕</button>
      <div style="margin:0 0 10px 0;font-size:13px;color:#9aa;line-height:1.45">
        Choose how to delete this media.
      </div>
      ${renderFeedPost(post)}
      <div id="spmd-actions" style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding:10px 16px;margin:10px -16px -16px;position:sticky;bottom:-16px;z-index:2;background:linear-gradient(180deg,rgba(17,17,17,.15),rgba(17,17,17,.96) 22%,rgba(17,17,17,.98));border-top:1px solid #262626;backdrop-filter:blur(2px)">
        ${mediaBtn}
        <button type="button" class="modal-btn primary" id="spmd-del-post-btn" style="background:#b3261e;color:#fff">Delete Full Post</button>
      </div>
    </div>`;
    overlay.style.display = 'flex';

    // Ensure users see the action buttons immediately even on long posts.
    requestAnimationFrame(() => {
      const panel = overlay.querySelector('.spd-inner');
      const actions = document.getElementById('spmd-actions');
      if (!panel || !actions) return;
      const target = Math.max(0, actions.offsetTop - panel.clientHeight + actions.clientHeight + 20);
      panel.scrollTop = target;
      setTimeout(() => { panel.scrollTop = target; }, 40);
    });

    const mediaBtnEl = document.getElementById('spmd-del-media-btn');
    const postBtnEl = document.getElementById('spmd-del-post-btn');
    if (mediaBtnEl && canDeleteMediaOnly) {
      mediaBtnEl.onclick = async () => {
        mediaBtnEl.disabled = true;
        postBtnEl.disabled = true;
        try {
          await deletePostMediaOnly(post.id);
          closePostDetail();
        } finally {
          mediaBtnEl.disabled = false;
          postBtnEl.disabled = false;
        }
      };
    }
    if (postBtnEl) {
      postBtnEl.onclick = async () => {
        postBtnEl.disabled = true;
        if (mediaBtnEl) mediaBtnEl.disabled = true;
        try {
          await deletePostDirect(post.id);
          closePostDetail();
        } finally {
          postBtnEl.disabled = false;
          if (mediaBtnEl) mediaBtnEl.disabled = false;
        }
      };
    }
  }

  // Post "⋯" menu — shared for own posts (Delete) and others (Block / Report / Profile / DM)
  function openPostMenu(btn) {
    const nick = btn.dataset.nick;
    const uid  = +btn.dataset.uid;
    const pid  = +btn.dataset.pid;
    const privacy = (btn.dataset.privacy || 'public').toLowerCase();
    const shareEnabled = Number(btn.dataset.shareEnabled || '1') === 1;
    const iReposted = Number(btn.dataset.iReposted || '0') === 1;
    const isOwn = uid === State.user?.id;

    const items = [];
    items.push({ icon: '👤', label: `View @${nick}`, onclick: () => openProfile(nick) });
    if (privacy !== 'friends' && privacy !== 'private' && shareEnabled) {
      items.push({
        icon: '🔁',
        label: 'Repost',
        onclick: () => toggleRepost(null, pid, { nickname: nick, privacy, shareEnabled: 1 })
      });
      items.push({
        icon: '📝',
        label: iReposted ? 'Edit quote repost' : 'Quote repost',
        onclick: () => openQuoteRepost(pid, { nickname: nick, privacy, shareEnabled: 1 })
      });
    }
    if (privacy !== 'friends' && privacy !== 'private' && shareEnabled) {
      items.push({
        icon: '📤',
        label: 'Share',
        onclick: () => sharePostUrl(pid, { nickname: nick, privacy, shareEnabled: 1 })
      });
    }
    if (!isOwn) {
      items.push({ icon: '✉️', label: 'Send message', onclick: () => dmUser(nick) });
      items.push({ icon: '🚫', label: `Block @${nick}`, danger: true, onclick: () => blockUserFromSocial(nick) });
    }
    if (isOwn || State.user?.is_admin) {
      items.push({ icon: '🗑️', label: isOwn ? 'Delete post' : '🛡 Delete post (admin)', danger: true, onclick: () => deletePost(pid) });
    }
    if (typeof showActionSheet === 'function') {
      showActionSheet(`Post by @${nick}`, items);
    } else {
      // Fallback: simple confirm-based menu
      if (privacy !== 'friends' && privacy !== 'private' && shareEnabled && confirm('Copy post link?')) {
        sharePostUrl(pid, { nickname: nick, privacy, shareEnabled: 1 });
        return;
      }
      if (isOwn && confirm('Delete this post?')) deletePost(pid);
      else if (State.user?.is_admin && confirm(`Delete post #${pid} as admin?`)) deletePost(pid);
      else if (!isOwn && confirm(`Block @${nick}?`)) blockUserFromSocial(nick);
    }
  }

  function postShareUrl(postId) {
    const id = Number(postId);
    const safeId = Number.isFinite(id) && id > 0 ? id : 0;
    return `${window.location.origin}/p/${safeId}`;
  }

  function _shareSnippet(raw, maxLen = 140) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 1)).trim()}…`;
  }

  function _postContext(postId) {
    const root = document.querySelector(`.sf-post[data-post-id="${Number(postId)}"]`);
    if (!root) return { nick: '', text: '' };
    const nick = (root.querySelector('.sf-post-nick')?.textContent || '').replace(/^@+/, '').trim();
    const text = (root.querySelector('.sf-post-text')?.textContent || '').trim();
    return { nick, text };
  }

  function _reelContext(postId) {
    const root = document.querySelector(`.reel-card[data-post-id="${Number(postId)}"]`);
    if (!root) return { nick: '', text: '' };
    const nick = (root.querySelector('.reel-author-nick')?.textContent || '').replace(/^@+/, '').trim();
    const text = (root.querySelector('.reel-caption')?.textContent || '').trim();
    return { nick, text };
  }

  function reelShareUrl(postId) {
    const id = Number(postId);
    const safeId = Number.isFinite(id) && id > 0 ? id : 0;
    return `${window.location.origin}/r/${safeId}`;
  }

  async function sharePostUrl(postId, meta = {}) {
    const privacy = String(meta.privacy || 'public').toLowerCase();
    const shareEnabled = Number(meta.shareEnabled ?? 1) === 1;
    const ctx = _postContext(postId);
    const nick = meta.nickname || ctx.nick || 'user';
    if (!shareEnabled) {
      try { UI.showToast('Share link is disabled for this post', 'info'); } catch {}
      return;
    }
    if (privacy === 'friends' || privacy === 'private') {
      try { UI.showToast('Sharing is disabled for friends-only and private posts', 'info'); } catch {}
      return;
    }
    const url = privacy === 'followers'
      ? `${window.location.origin}/app?post=${encodeURIComponent(String(postId))}`
      : postShareUrl(postId);
    const snippet = _shareSnippet(meta.text || meta.content || ctx.text, 140);
    const shareText = snippet || `Check out this FrogTalk post by @${nick}`;
    if (privacy === 'followers') {
      try { UI.showToast('Followers-only link copied: viewer must be logged in with access', 'info'); } catch {}
    }
    try {
      if (navigator.share) {
        await navigator.share({
          title: `Post by @${nick} on FrogTalk`,
          text: shareText,
          url,
        });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    const ok = await UI.copy(url);
    if (ok) {
      try { UI.showToast('Post link copied to clipboard', 'success'); } catch {}
    } else {
      window.prompt('Copy this post link:', url);
    }
  }

  async function shareReelUrl(postId, meta = {}) {
    const privacy = String(meta.privacy || 'public').toLowerCase();
    const shareEnabled = Number(meta.shareEnabled ?? 1) === 1;
    const ctx = _reelContext(postId);
    const nick = meta.nickname || ctx.nick || 'user';
    if (!shareEnabled) {
      try { UI.showToast('Share link is disabled for this reel', 'info'); } catch {}
      return;
    }
    if (privacy === 'friends' || privacy === 'private') {
      try { UI.showToast('Sharing is disabled for friends-only and private reels', 'info'); } catch {}
      return;
    }
    const url = privacy === 'followers'
      ? `${window.location.origin}/?reel=${encodeURIComponent(String(postId))}`
      : reelShareUrl(postId);
    const snippet = _shareSnippet(meta.text || meta.content || ctx.text, 140);
    const shareText = snippet || `Check out this FrogTalk reel by @${nick}`;
    if (privacy === 'followers') {
      try { UI.showToast('Followers-only reel link copied: viewer must be logged in with access', 'info'); } catch {}
    }
    try {
      if (navigator.share) {
        await navigator.share({
          title: `Reel by @${nick} on FrogTalk`,
          text: shareText,
          url,
        });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    const ok = await UI.copy(url);
    if (ok) {
      try { UI.showToast('Reel link copied to clipboard', 'success'); } catch {}
    } else {
      window.prompt('Copy this reel link:', url);
    }
  }

  async function blockUserFromSocial(nickname) {
    if (!nickname) return;
    if (!confirm(`Block @${nickname}?\n\nThey won't be able to message or interact with you — across chat AND Frog Social.`)) return;
    try {
      const r = await apiFetch(`/api/friends/block/${encodeURIComponent(nickname)}`, 'POST');
      if (r.ok) {
        UI.showToast(`@${nickname} blocked`);
        if (typeof refreshBlockedCache === 'function') refreshBlockedCache();
        if (_currentTab === 'feed') loadFeed();
        else if (_currentTab === 'explore') loadExplore();
        else if (_currentTab === 'profile' && _profileUser === nickname) close();
      } else {
        const d = await r.json().catch(() => ({}));
        UI.showToast(d.error || 'Failed to block user', 'error');
      }
    } catch {
      UI.showToast('Failed to block user', 'error');
    }
  }

  function dmUser(nickname) {
    close();
    if (typeof openDMWithNick === 'function') openDMWithNick(nickname);
    else if (typeof Rooms !== 'undefined') Rooms.openDM(nickname);
  }

  // Build a shareable URL that opens the app directly to this profile.
  // Uses `?profile=<nick>` which app.js already handles post-login.
  function profileShareUrl(nickname) {
    try {
      const u = new URL(window.location.origin);
      u.searchParams.set('profile', nickname);
      return u.toString();
    } catch {
      return `${window.location.origin}/?profile=${encodeURIComponent(nickname)}`;
    }
  }

  // Share/copy a profile link. Uses the native share sheet when available
  // (mobile / PWAs), otherwise falls back to clipboard copy + toast.
  async function shareProfile(nickname, btn) {
    const url = profileShareUrl(nickname);
    // If the current user is looking at their own private profile, warn
    // them that friends-only viewers won't actually be able to see it.
    const isSelfPrivate = _profileData
      && _profileData.nickname === nickname
      && _profileData.is_self
      && _profileData.profile_public === false;
    if (isSelfPrivate) {
      try { UI.showToast('Your profile is private \u2014 only friends will see it via this link', 'info'); } catch {}
    }
    try {
      if (navigator.share) {
        await navigator.share({
          title: `@${nickname} on FrogTalk`,
          text: `Check out @${nickname} on FrogTalk`,
          url,
        });
        return;
      }
    } catch (e) {
      // User cancelled — fall through to clipboard.
      if (e && e.name === 'AbortError') return;
    }
    const ok = await UI.copy(url);
    if (ok) {
      if (btn) {
        const orig = btn.innerHTML;
        btn.classList.add('is-copied');
        btn.innerHTML = '\u2713 Copied';
        setTimeout(() => { btn.classList.remove('is-copied'); btn.innerHTML = orig; }, 1600);
      }
      try { UI.showToast('Profile link copied to clipboard', 'success'); } catch {}
    } else {
      // Clipboard API + execCommand both failed — last-resort prompt.
      window.prompt('Copy this profile link:', url);
    }
  }

  async function addFriendFromProfile(nickname, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    const r = await apiFetch('/api/friends/request/' + encodeURIComponent(nickname), 'POST');
    if (r.ok) {
      // Persist the new friend_status across navigations.
      _invalidateProfileCache(nickname);
      if (btn) { btn.textContent = 'Requested'; btn.disabled = true; }
      UI.showToast('Friend request sent to ' + nickname, 'success');
    } else {
      if (btn) { btn.disabled = false; btn.textContent = '+ Add Friend'; }
      const d = await r.json().catch(() => ({}));
      UI.showToast(d.detail || 'Could not send request', 'error');
    }
  }

  async function acceptFriendFromProfile(nickname, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    const r = await apiFetch('/api/friends/accept/' + encodeURIComponent(nickname), 'POST');
    if (r.ok) {
      // Drop cache before reload — otherwise loadProfile() returns stale
      // friend_status='received' and re-renders the Accept button.
      _invalidateProfileCache(nickname);
      if (btn) { btn.textContent = 'Friends ✓'; }
      UI.showToast(nickname + ' is now your friend! 🐸', 'success');
      try {
        if (_currentTab === 'profile' && _profileUser === nickname) {
          await loadProfile(nickname);
        }
      } catch {}
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Accept Friend'; }
      UI.showToast('Could not accept request', 'error');
    }
  }

  async function refreshProfileRelationship(nickname) {
    try {
      if (!nickname || _currentTab !== 'profile' || _profileUser !== nickname) return;
      await loadProfile(nickname);
    } catch {}
  }

  // ── new post modal ──────────────────────────────────────────────────────
  let _newPostMedia = null;
  let _newPostMediaType = null;
  let _newPostOrigMedia = null; // original unfiltered image
  let _newPostPrivacy = 'public';
  let _newPostShareEnabled = true;
  let _newPostAllowComments = true;
  let _newPostSubmitting = false;
  let _quoteRepostPostId = 0;
  let _quoteRepostMeta = null;
  let _filterState = { brightness: 100, contrast: 100, saturate: 100 };

  const _filterPresets = {
    none:     { brightness: 100, contrast: 100, saturate: 100 },
    warm:     { brightness: 105, contrast: 105, saturate: 130 },
    cool:     { brightness: 100, contrast: 110, saturate: 80 },
    vintage:  { brightness: 110, contrast: 90, saturate: 70 },
    dramatic: { brightness: 90, contrast: 140, saturate: 110 },
    fade:     { brightness: 115, contrast: 85, saturate: 80 },
    bw:       { brightness: 105, contrast: 120, saturate: 0 },
  };

  function openNewPost() {
    _newPostSubmitting = false;
    _newPostMedia = null;
    _newPostMediaType = null;
    _newPostOrigMedia = null;
    _newPostPrivacy = (localStorage.getItem('ft_default_post_privacy') || 'public');
    _newPostShareEnabled = (localStorage.getItem('ft_default_share_link') !== '0');
    _newPostAllowComments = (localStorage.getItem('ft_default_allow_comments') !== '0');
    _filterState = { brightness: 100, contrast: 100, saturate: 100 };
    document.getElementById('social-new-post').classList.remove('hidden');
    document.getElementById('snp-text').value = '';
    document.getElementById('snp-media-preview').style.display = 'none';
    resetFilterUI();
    setPostPrivacy(_newPostPrivacy);
    const share = document.getElementById('snp-share-enabled');
    if (share) share.checked = _newPostShareEnabled;
    const schip = document.getElementById('snp-share-chip');
    if (schip) {
      schip.innerHTML = _newPostShareEnabled ? '📤 On' : '<span style="text-decoration:line-through">📤</span> Off';
      schip.classList.toggle('on', _newPostShareEnabled);
      schip.classList.toggle('off', !_newPostShareEnabled);
    }
    const cmt = document.getElementById('snp-allow-comments');
    if (cmt) cmt.checked = _newPostAllowComments;
    const postBtn = document.getElementById('snp-submit-btn');
    if (postBtn) {
      postBtn.disabled = false;
      postBtn.textContent = 'Post';
      postBtn.style.opacity = '';
    }
    // Sync comments chip label to saved default (without flipping value)
    const cchip = document.getElementById('snp-comments-chip');
    if (cchip) {
      cchip.textContent = _newPostAllowComments ? '💬 On' : '💬 Off';
      cchip.classList.toggle('on', _newPostAllowComments);
      cchip.classList.toggle('off', !_newPostAllowComments);
    }
    setTimeout(() => document.getElementById('snp-text').focus(), 100);
  }

  function closeNewPost() {
    document.getElementById('social-new-post').classList.add('hidden');
  }

  // raw File object for video (avoid slow base64 pre-read; convert at submit time)
  let _newPostFile = null;
  let _newPostObjectUrl = null;

  function _captureVideoPoster(videoEl) {
    if (!videoEl) return;
    const draw = () => {
      try {
        if (!videoEl.videoWidth || !videoEl.videoHeight) return;
        const c = document.createElement('canvas');
        const maxW = 720;
        c.width = Math.min(videoEl.videoWidth, maxW);
        c.height = Math.max(1, Math.round(c.width * (videoEl.videoHeight / videoEl.videoWidth)));
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(videoEl, 0, 0, c.width, c.height);
        videoEl.poster = c.toDataURL('image/jpeg', 0.74);
      } catch {}
    };
    videoEl.addEventListener('loadeddata', draw, { once: true });
    setTimeout(draw, 700);
  }

  function handleNewPostMedia(input) {
    const file = input.files[0];
    if (!file) return;
    if (!file.type || (!file.type.startsWith('image/') && !file.type.startsWith('video/'))) {
      UI.showToast('Unsupported file type', 'error');
      input.value = '';
      return;
    }
    if (file.size > 100 * 1024 * 1024) { UI.showToast('File too large (max 100MB)', 'error'); return; }
    const isVideo = file.type.startsWith('video/');

    // Revoke any previous object URL
    if (_newPostObjectUrl) { URL.revokeObjectURL(_newPostObjectUrl); _newPostObjectUrl = null; }
    _newPostFile = null;

    const img = document.getElementById('snp-media-img');
    const vid = document.getElementById('snp-media-vid');
    const filters = document.getElementById('snp-filters');
    const preview = document.getElementById('snp-media-preview');

    if (isVideo) {
      // Instant preview — no FileReader needed
      _newPostObjectUrl = URL.createObjectURL(file);
      _newPostFile = file;
      _newPostMediaType = file.type;
      _newPostMedia = '__video_file__'; // sentinel so submitNewPost knows media is ready
      if (img) { img.style.display = 'none'; img.src = ''; }
      if (vid) {
        vid.poster = '';
        vid.src = _newPostObjectUrl;
        vid.style.display = 'block';
        _captureVideoPoster(vid);
      }
      if (filters) filters.style.display = 'none';
      if (preview) preview.style.display = 'block';
    } else {
      // Image: read as data URL for preview + filter pipeline
      const reader = new FileReader();
      reader.onload = e => {
        _newPostMedia = e.target.result;
        _newPostOrigMedia = e.target.result;
        _newPostMediaType = file.type;
        _filterState = { brightness: 100, contrast: 100, saturate: 100 };
        resetFilterUI();
        if (vid) { vid.style.display = 'none'; vid.src = ''; }
        if (img) { img.src = e.target.result; img.style.display = 'block'; }
        if (filters) filters.style.display = 'block';
        if (preview) preview.style.display = 'block';
      };
      reader.readAsDataURL(file);
    }
  }

  function openNewPostCamera() {
    if (typeof openCameraCapture !== 'function') { UI.showToast('Camera unavailable', 'error'); return; }
    openCameraCapture((dataUrl) => {
      _newPostMedia = dataUrl;
      _newPostOrigMedia = dataUrl;
      _newPostMediaType = 'image/jpeg';
      _filterState = { brightness: 100, contrast: 100, saturate: 100 };
      resetFilterUI();
      const img = document.getElementById('snp-media-img');
      const vid2 = document.getElementById('snp-media-vid');
      const filters2 = document.getElementById('snp-filters');
      if (vid2) { vid2.style.display = 'none'; vid2.src = ''; }
      if (img) { img.src = dataUrl; img.style.display = 'block'; }
      if (filters2) filters2.style.display = 'block';
      document.getElementById('snp-media-preview').style.display = 'block';
    });
  }

  function clearNewPostMedia() {
    _newPostMedia = null;
    _newPostMediaType = null;
    _newPostOrigMedia = null;
    _newPostFile = null;
    if (_newPostObjectUrl) { URL.revokeObjectURL(_newPostObjectUrl); _newPostObjectUrl = null; }
    _filterState = { brightness: 100, contrast: 100, saturate: 100 };
    resetFilterUI();
    const img = document.getElementById('snp-media-img');
    const vid = document.getElementById('snp-media-vid');
    if (img) { img.src = ''; img.style.display = 'none'; }
    if (vid) { vid.src = ''; vid.poster = ''; vid.style.display = 'none'; }
    const filters = document.getElementById('snp-filters');
    if (filters) filters.style.display = 'none';
    document.getElementById('snp-media-preview').style.display = 'none';
    const fi = document.getElementById('snp-media-input');
    if (fi) fi.value = '';
  }

  function resetFilterUI() {
    document.querySelectorAll('#snp-filters .filter-btn').forEach(b => b.classList.remove('active'));
    const none = document.querySelector('#snp-filters .filter-btn');
    if (none) none.classList.add('active');
    document.querySelectorAll('#snp-filters input[type=range]').forEach(s => { s.value = 100; });
  }

  function applyFilter(preset) {
    if (!_newPostOrigMedia || !_newPostMediaType?.startsWith('image/')) return;
    const p = _filterPresets[preset] || _filterPresets.none;
    _filterState = { ...p };
    // Update sliders
    document.querySelectorAll('#snp-filters input[data-filter]').forEach(s => {
      if (_filterState[s.dataset.filter] !== undefined) s.value = _filterState[s.dataset.filter];
    });
    // Update active button
    document.querySelectorAll('#snp-filters .filter-btn').forEach(b => b.classList.remove('active'));
    const clicked = [...document.querySelectorAll('#snp-filters .filter-btn')].find(b => b.textContent.trim().toLowerCase().replace('&', '').replace('b&w','bw') === preset || b.onclick?.toString().includes(`'${preset}'`));
    if (clicked) clicked.classList.add('active');
    applyFilterToPreview();
  }

  function updateFilter(prop, val) {
    if (!_newPostOrigMedia || !_newPostMediaType?.startsWith('image/')) return;
    _filterState[prop] = parseInt(val);
    // Clear active preset button
    document.querySelectorAll('#snp-filters .filter-btn').forEach(b => b.classList.remove('active'));
    applyFilterToPreview();
  }

  function applyFilterToPreview() {
    const img = document.getElementById('snp-media-img');
    if (!img || !_newPostMediaType?.startsWith('image/')) return;
    const filterStr = `brightness(${_filterState.brightness}%) contrast(${_filterState.contrast}%) saturate(${_filterState.saturate}%)`;
    img.style.filter = filterStr;
  }

  function setPostPrivacy(p) {
    if (!['public', 'followers', 'friends', 'private'].includes(p)) p = 'private';
    _newPostPrivacy = p;
    localStorage.setItem('ft_default_post_privacy', p);
    // Update inline chip label + icon
    const chip = document.getElementById('snp-priv-chip');
    if (chip) {
      const map = { public: '🌍 Public', followers: '👥 Followers', friends: '🤝 Friends', private: '🔒 Only me' };
      chip.textContent = map[p];
      chip.classList.toggle('on', p !== 'public');
    }
    // Legacy pill buttons (if any remain) — keep compatible
    ['public', 'followers', 'friends', 'private'].forEach(k => {
      const btn = document.getElementById('snp-priv-' + k);
      if (!btn) return;
      if (k === p) {
        btn.style.background = 'linear-gradient(135deg,#4caf50,#2e7d32)';
        btn.style.color = '#000';
        btn.style.borderColor = '#4caf50';
      } else {
        btn.style.background = '#1a1a1a';
        btn.style.color = '#ddd';
        btn.style.borderColor = '#2a2a2a';
      }
    });
  }

  function cyclePostPrivacy() {
    const order = ['private', 'friends', 'followers', 'public'];
    const next = order[(order.indexOf(_newPostPrivacy) + 1) % order.length];
    setPostPrivacy(next);
  }

  function toggleAllowComments() {
    _newPostAllowComments = !_newPostAllowComments;
    localStorage.setItem('ft_default_allow_comments', _newPostAllowComments ? '1' : '0');
    const cb = document.getElementById('snp-allow-comments');
    if (cb) cb.checked = _newPostAllowComments;
    const chip = document.getElementById('snp-comments-chip');
    if (chip) {
      chip.textContent = _newPostAllowComments ? '💬 On' : '💬 Off';
      chip.classList.toggle('on', _newPostAllowComments);
      chip.classList.toggle('off', !_newPostAllowComments);
    }
  }

  function toggleShareLink() {
    _newPostShareEnabled = !_newPostShareEnabled;
    localStorage.setItem('ft_default_share_link', _newPostShareEnabled ? '1' : '0');
    const cb = document.getElementById('snp-share-enabled');
    if (cb) cb.checked = _newPostShareEnabled;
    const chip = document.getElementById('snp-share-chip');
    if (chip) {
      chip.innerHTML = _newPostShareEnabled ? '📤 On' : '<span style="text-decoration:line-through">📤</span> Off';
      chip.classList.toggle('on', _newPostShareEnabled);
      chip.classList.toggle('off', !_newPostShareEnabled);
    }
  }

  function applyFilterToImage(dataUrl) {
    // Apply CSS filters to canvas and return filtered data URL
    return new Promise(resolve => {
      const { brightness, contrast, saturate } = _filterState;
      if (brightness === 100 && contrast === 100 && saturate === 100) {
        resolve(dataUrl);
        return;
      }
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%)`;
        ctx.drawImage(img, 0, 0);
        resolve(c.toDataURL('image/jpeg', 0.92));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function submitNewPost() {
    if (_newPostSubmitting) return;
    const text = document.getElementById('snp-text').value.trim();
    if (!text && !_newPostMedia && !_newPostFile) return;
    _newPostSubmitting = true;
    const postBtn = document.getElementById('snp-submit-btn');
    if (postBtn) {
      postBtn.disabled = true;
      postBtn.textContent = 'Posting…';
      postBtn.style.opacity = '.75';
    }
    const cmtEl = document.getElementById('snp-allow-comments');
    const allowCmt = cmtEl ? !!cmtEl.checked : _newPostAllowComments;
    const shareEl = document.getElementById('snp-share-enabled');
    const shareEnabled = shareEl ? !!shareEl.checked : _newPostShareEnabled;
    const hasAttachedMedia = !!_newPostFile || !!_newPostMedia;
    localStorage.setItem('ft_default_allow_comments', allowCmt ? '1' : '0');
    localStorage.setItem('ft_default_share_link', shareEnabled ? '1' : '0');
    try {
      if (hasAttachedMedia) {
        try {
          closeNewPost();
          const ov = _ensureStoryUploadOverlay();
          const title = ov?.querySelector('#story-upload-title');
          const icon = ov?.querySelector('#story-upload-icon');
          if (title) title.textContent = 'Uploading post';
          if (icon) icon.textContent = '📤';
          _hideStoryUploadRetryHint();
          _updateStoryUploadOverlay(2, 'Starting upload…');
        } catch {}
      }
      const body = {
        content: text || '',
        privacy: _newPostPrivacy || 'public',
        share_enabled: shareEnabled,
        allow_comments: allowCmt,
      };
      if (_newPostFile) {
        // Video chosen via file picker — read to base64 now.
        if (postBtn) { postBtn.textContent = 'Uploading…'; }
        body.media_data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onprogress = (e) => {
            if (!hasAttachedMedia || !e?.lengthComputable) return;
            const p = Math.max(5, Math.min(88, Math.round((e.loaded / e.total) * 88)));
            _updateStoryUploadOverlay(p, `Preparing media… ${Math.round((e.loaded / e.total) * 100)}%`);
          };
          r.onload = e => resolve(e.target.result);
          r.onerror = () => reject(new Error('Could not read video file'));
          r.readAsDataURL(_newPostFile);
        });
        body.media_type = _newPostFile.type;
        if (postBtn) { postBtn.textContent = 'Posting…'; }
        if (hasAttachedMedia) _updateStoryUploadOverlay(92, 'Posting…');
      } else if (_newPostMedia && _newPostMediaType?.startsWith('image/') && _newPostOrigMedia) {
        body.media_data = await applyFilterToImage(_newPostOrigMedia);
        body.media_type = 'image/jpeg';
        if (hasAttachedMedia) _updateStoryUploadOverlay(92, 'Posting…');
      } else if (_newPostMedia) {
        body.media_data = _newPostMedia;
        body.media_type = _newPostMediaType;
        if (hasAttachedMedia) _updateStoryUploadOverlay(92, 'Posting…');
      }
      const res = await api('/api/wall/posts', 'POST', body);
      if (res.ok) {
        const isVideo = (_newPostFile?.type || _newPostMediaType || '').startsWith('video/');
        if (hasAttachedMedia) {
          try {
            const ov = _ensureStoryUploadOverlay();
            const title = ov?.querySelector('#story-upload-title');
            const icon = ov?.querySelector('#story-upload-icon');
            if (title) title.textContent = 'Post published!';
            if (icon) icon.textContent = '✓';
            _updateStoryUploadOverlay(100, 'Post published');
            _hideStoryUploadOverlay(700);
          } catch {}
        } else {
          closeNewPost();
        }
        UI.showToast('Posted!', 'success');
        if (isVideo) {
          switchTab('reels');
        } else if (_currentTab === 'profile') {
          loadProfile(State.user?.nickname);
        } else if (_currentTab === 'feed') {
          loadFeed();
        }
      } else {
        const data = await res.json();
        if (hasAttachedMedia) {
          try {
            const ov = _ensureStoryUploadOverlay();
            const title = ov?.querySelector('#story-upload-title');
            const icon = ov?.querySelector('#story-upload-icon');
            if (title) title.textContent = 'Post failed';
            if (icon) icon.textContent = '⚠️';
            _updateStoryUploadOverlay(0, data.error || 'Could not post');
            _hideStoryUploadOverlay(2200);
          } catch {}
        }
        UI.showToast(data.error || 'Could not post', 'error');
      }
    } catch (err) {
      if (hasAttachedMedia) {
        try {
          const ov = _ensureStoryUploadOverlay();
          const title = ov?.querySelector('#story-upload-title');
          const icon = ov?.querySelector('#story-upload-icon');
          if (title) title.textContent = 'Post failed';
          if (icon) icon.textContent = '⚠️';
          _updateStoryUploadOverlay(0, err?.message || 'Network error');
          _hideStoryUploadOverlay(2200);
        } catch {}
      }
      UI.showToast(err?.message || 'Network error', 'error');
    }
    finally {
      _newPostSubmitting = false;
      if (postBtn) {
        postBtn.disabled = false;
        postBtn.textContent = 'Post';
        postBtn.style.opacity = '';
      }
    }
  }

  function openQuoteRepost(postId, meta = {}) {
    const privacy = String(meta.privacy || 'public').toLowerCase();
    const shareEnabled = Number(meta.shareEnabled ?? 1) === 1;
    if (!shareEnabled) {
      try { UI.showToast('Repost is disabled for this post', 'info'); } catch {}
      return;
    }
    if (privacy !== 'public' && privacy !== 'followers') {
      try { UI.showToast('Only public and followers posts can be reposted', 'info'); } catch {}
      return;
    }
    _quoteRepostPostId = Number(postId || 0);
    _quoteRepostMeta = meta || {};
    const overlay = document.getElementById('social-quote-repost');
    const input = document.getElementById('qrp-text');
    const title = document.getElementById('qrp-title');
    if (!overlay || !input) return;
    if (title) title.textContent = `Quote repost @${meta.nickname || 'user'}`;
    input.value = '';
    overlay.classList.remove('hidden');
    setTimeout(() => input.focus(), 30);
  }

  function closeQuoteRepost() {
    const overlay = document.getElementById('social-quote-repost');
    const input = document.getElementById('qrp-text');
    if (overlay) overlay.classList.add('hidden');
    if (input) input.value = '';
    _quoteRepostPostId = 0;
    _quoteRepostMeta = null;
  }

  async function submitQuoteRepost() {
    const input = document.getElementById('qrp-text');
    const btn = document.getElementById('qrp-submit');
    const quote = String(input?.value || '').trim();
    if (!_quoteRepostPostId) return;
    if (!quote) {
      try { UI.showToast('Write a short quote first', 'info'); } catch {}
      input?.focus();
      return;
    }
    if (quote.length > 1000) {
      try { UI.showToast('Quote is too long (max 1000 chars)', 'error'); } catch {}
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }
    try {
      await toggleRepost(null, _quoteRepostPostId, { ...(_quoteRepostMeta || {}), quote });
      closeQuoteRepost();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Quote repost'; }
    }
  }

  // ── followers/following list popup ──────────────────────────────────────
  async function showFollowers(nickname) {
    showUserList('Followers', `/api/social/profile/${encodeURIComponent(nickname)}/followers`);
  }

  async function showFollowing(nickname) {
    showUserList('Following', `/api/social/profile/${encodeURIComponent(nickname)}/following`);
  }

  async function showUserList(title, url) {
    const overlay = document.getElementById('social-userlist');
    const titleEl = document.getElementById('sul-title');
    const listEl = document.getElementById('sul-list');
    titleEl.textContent = title;
    listEl.innerHTML = _socialLoadingHtml('Loading list…', 'default', 'compact');
    overlay.classList.remove('hidden');
    try {
      const res = await api(url);
      const data = await res.json();
      const users = data.users || [];
      if (users.length === 0) {
        listEl.innerHTML = '<div style="text-align:center;color:#666;padding:30px">Nobody here yet</div>';
        return;
      }
      listEl.innerHTML = users.map(u => `
        <div class="sul-user">
          <div class="sul-avatar" onclick="Social.openProfileFromUserList('${esc(u.nickname)}')">${UI.avatarEl(u.avatar, u.nickname, 40)}</div>
          <div class="sul-info" onclick="Social.openProfileFromUserList('${esc(u.nickname)}')">
            <div class="sul-nick">${esc(u.nickname)}</div>
            ${u.bio ? `<div class="sul-bio">${esc(u.bio.substring(0, 60))}</div>` : ''}
          </div>
          ${u.nickname !== State.user?.nickname
            ? `<button class="sp-action-btn ${u.is_following ? 'secondary' : 'primary'} small" onclick="Social.toggleFollow('${esc(u.nickname)}',this)">${u.is_following ? 'Following' : 'Follow'}</button>`
            : ''}
        </div>
      `).join('');
    } catch {
      listEl.innerHTML = '<div style="text-align:center;color:#666;padding:30px">Could not load</div>';
    }
  }

  function closeUserList() {
    document.getElementById('social-userlist').classList.add('hidden');
  }

  function openProfileFromUserList(nickname) {
    closeUserList();
    openProfile(nickname);
  }

  function openStoryProfileFromViewer(nickname) {
    closeStoryViewer();
    openProfile(nickname);
  }

  function expandPost(postId) {
    // Scroll to and highlight the post in feed view, opening its comments
    switchTab('feed');
    setTimeout(() => {
      const el = document.querySelector(`[data-post-id="${postId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.outline = '2px solid #4caf50';
        setTimeout(() => { el.style.outline = ''; }, 2000);
        toggleComments(postId);
      }
    }, 500);
  }

  async function viewPostDetail(postId) {
    // Show a single post in a modal-like overlay
    let overlay = document.getElementById('social-post-detail');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'social-post-detail';
      overlay.onclick = e => { if (e.target === overlay) closePostDetail(); };
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<div class="spd-inner spd-loading" style="min-height:260px">${_socialPostSkeletonCards(1)}</div>`;
    overlay.style.display = 'flex';
    try {
      const res = await api(`/api/wall/posts/${postId}`);
      if (!res.ok) {
        overlay.innerHTML = `<div class="spd-inner" style="padding:24px;color:#a1a1a1">Could not load post</div>`;
        return;
      }
      const p = await res.json();
      p.reactions = p.reactions || [];
      overlay.innerHTML = `<div class="spd-inner"><button class="social-close-btn" onclick="Social.closePostDetail()" style="position:absolute;top:8px;right:8px;z-index:1">✕</button>${renderFeedPost(p)}</div>`;
      overlay.style.display = 'flex';
    } catch {
      overlay.innerHTML = `<div class="spd-inner" style="padding:24px;color:#a1a1a1">Could not load post</div>`;
    }
  }

  async function openPostComments(postId) {
    await viewPostDetail(postId);
    const openWhenReady = (tries = 0) => {
      const el = document.getElementById(`sf-comments-${postId}`);
      if (el) {
        toggleComments(null, postId);
        return;
      }
      if (tries >= 12) return;
      setTimeout(() => openWhenReady(tries + 1), 25);
    };
    openWhenReady();
  }

  function closePostDetail() {
    const o = document.getElementById('social-post-detail');
    if (!o) return;
    try {
      o.querySelectorAll('video,audio').forEach(m => {
        try { m.pause(); } catch {}
        try { m.currentTime = 0; } catch {}
      });
      o.querySelectorAll('iframe').forEach(frame => {
        try {
          const src = frame.getAttribute('src');
          if (src) frame.setAttribute('src', src);
        } catch {}
      });
    } catch {}
    o.style.display = 'none';
  }

  // Open story viewer by nickname — used by the avatar ring on the profile page.
  // Loads a fresh stories feed if we don't already have this user's stories
  // cached, then hands off to viewStories.
  async function viewProfileStories(nickname, userId) {
    try {
      // Populate _storyData if empty (profile is often opened without stories bar loaded)
      if (!_storyData.length) {
        try {
          const res = await api('/api/social/stories');
          const data = await res.json();
          _storyData = data.users || [];
        } catch {}
      }
      const idx = _storyData.findIndex(u =>
        (userId && u.user_id === userId) ||
        (nickname && u.nickname === nickname));
      if (idx < 0) return;
      viewStories(idx);
    } catch {}
  }

  // ─── Side-menu navigation (hamburger in topbar) ─────────────────
  function openSideMenu(){
    const menu = document.getElementById('social-side-menu');
    const bd   = document.getElementById('social-side-backdrop');
    if (menu) menu.classList.add('open');
    if (bd)   bd.classList.add('open');
    // ESC to close
    if (!openSideMenu._esc){
      openSideMenu._esc = (e)=>{ if(e.key==='Escape') closeSideMenu(); };
      document.addEventListener('keydown', openSideMenu._esc);
    }
  }
  function closeSideMenu(){
    const menu = document.getElementById('social-side-menu');
    const bd   = document.getElementById('social-side-backdrop');
    if (menu) menu.classList.remove('open');
    if (bd)   bd.classList.remove('open');
    if (openSideMenu._esc){
      document.removeEventListener('keydown', openSideMenu._esc);
      openSideMenu._esc = null;
    }
  }
  function navTo(target){
    closeSideMenu();
    // Close Frog Social, then run the action after a tiny delay so the
    // overlay transition completes before the target panel/modal opens.
    close();
    setTimeout(()=>{
      try {
        switch(target){
          case 'home':
            if (typeof goHomeChannel === 'function') goHomeChannel();
            break;
          case 'dms':
            if (typeof openDMsPanel === 'function') openDMsPanel();
            break;
          case 'friends':
            if (typeof openFriends === 'function') openFriends();
            break;
          case 'directory':
            if (typeof showChannelDirectory === 'function') showChannelDirectory();
            break;
          case 'profile':
            if (typeof showProfile === 'function') showProfile();
            break;
          case 'logout':
            if (typeof doLogout === 'function') doLogout();
            break;
        }
      } catch(e){ console.warn('[social] navTo failed', target, e); }
    }, 50);
  }

  function _initUploadRecovery() {
    try {
      const saved = localStorage.getItem('_storyUploadState');
      if (!saved) return;
      const state = JSON.parse(saved);
      if (!state || Date.now() - state.startTime > 86400000) {  // Discard if older than 24h
        localStorage.removeItem('_storyUploadState');
        return;
      }
      // Upload is pending, notify user
      _storyNotify(`Resume upload? (${state.retryCount} retries)`, 'info');
    } catch {}
  }

  // ── ACTIVITY (likes / comments / follows on YOUR posts) ──────────────────
  let _activityUnread = 0;
  let _activityList = [];
  let _activityLoading = false;
  let _activityPolledOnce = false;

  function _setSidebarBadge(n) {
    const badge = document.getElementById('social-sidebar-badge');
    if (badge) {
      if (n > 0) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
    const navBadge = document.getElementById('social-activity-nav-badge');
    if (navBadge) {
      if (n > 0) {
        navBadge.textContent = n > 99 ? '99+' : String(n);
        navBadge.style.display = '';
      } else {
        navBadge.style.display = 'none';
      }
    }
    const navBtn = document.querySelector('.social-nav-activity');
    if (navBtn) navBtn.classList.toggle('has-unread', n > 0);
  }

  function refreshActivityBadge() {
    if (!State.user) { _setSidebarBadge(0); return Promise.resolve(0); }
    return api('/api/social/notifications/unread-count', 'GET')
      .then(r => r.ok ? r.json() : { unread: 0 })
      .then(d => {
        _activityUnread = Number(d?.unread || 0);
        _setSidebarBadge(_activityUnread);
        return _activityUnread;
      })
      .catch(() => 0);
  }

  function _activityIcon(kind) {
    if (kind === 'like')    return `<div class="social-activity-icon like" title="like">❤</div>`;
    if (kind === 'comment') return `<div class="social-activity-icon comment" title="comment">💬</div>`;
    if (kind === 'follow')  return `<div class="social-activity-icon follow" title="follow">＋</div>`;
    if (kind === 'repost')  return `<div class="social-activity-icon" title="repost">🔁</div>`;
    return `<div class="social-activity-icon" title="${esc(kind)}">•</div>`;
  }

  function _activityText(n) {
    const nick = `<b>${esc(n.actor_nickname || 'Someone')}</b>`;
    if (n.kind === 'like') {
      const e = n.emoji ? ` ${esc(n.emoji)}` : '';
      return `${nick} reacted${e} to your post`;
    }
    if (n.kind === 'comment') {
      const preview = n.preview
        ? `<span class="preview">“${esc(n.preview)}”</span>`
        : '';
      return `${nick} commented on your post${preview}`;
    }
    if (n.kind === 'follow') return `${nick} started following you`;
    if (n.kind === 'repost') return `${nick} reposted your post`;
    return `${nick} did something`;
  }

  function _renderActivityList() {
    const wrap = document.getElementById('social-activity-list');
    if (!wrap) return;
    if (!_activityList.length) {
      wrap.innerHTML = `<div class="social-activity-empty">
        <div class="ring">🔔</div>
        <div class="ttl">No activity yet</div>
        <div class="sub">When someone likes or comments on your posts, or starts following you, it'll show up here.</div>
        <div class="actions">
          <button class="btn primary" onclick="Social.switchTab('explore')">Find people to follow</button>
          <button class="btn ghost" onclick="Social.openNewPost()">Create a post</button>
        </div>
      </div>`;
      return;
    }
    wrap.innerHTML = `<div class="social-activity-list">${
      _activityList.map(n => {
        const isUnread = !n.read_at;
        const av = UI.avatarEl(n.actor_avatar, n.actor_nickname || '?', 42);
        return `<div class="social-activity-item ${isUnread ? 'unread' : ''}"
                     data-id="${n.id}"
                     onclick="Social.openActivityItem(${n.id})">
          <div class="social-activity-avatar">${av}</div>
          <div class="social-activity-body">
            <div class="social-activity-text">${_activityText(n)}</div>
            <div class="social-activity-time">${timeAgo(n.created_at)}</div>
          </div>
          ${_activityIcon(n.kind)}
        </div>`;
      }).join('')
    }</div>`;
  }

  async function loadActivity() {
    const content = document.getElementById('social-content');
    if (!content) return;
    if (_activityLoading) return;
    const loadUi = _beginTabLoadUi('activity', 'Loading activity', 'Fetching notifications');
    _activityLoading = true;
    content.innerHTML = `
      <div class="social-activity-wrap">
        <div class="social-activity-head">
          <div class="social-activity-title"><span class="ico">🔔</span>Activity</div>
          <button class="social-activity-mark" id="social-activity-mark"
                  onclick="Social.markAllActivityRead()" disabled>Mark all read</button>
        </div>
        <div id="social-activity-list">
          <div class="social-activity-skel" aria-hidden="true">
            <div class="row"></div><div class="row"></div>
            <div class="row"></div><div class="row"></div>
          </div>
        </div>
      </div>`;
    try {
      if (_cacheFresh(_activityCache)) {
        _activityList = _activityCache.notifications || [];
        _activityUnread = Number(_activityCache.unread || 0);
        _renderActivityList();
        const cachedMarkBtn = document.getElementById('social-activity-mark');
        if (cachedMarkBtn) cachedMarkBtn.disabled = _activityUnread === 0;
        _updateTabLoadUi(loadUi, 34, 'Loading activity', 'Using cached notifications');
      }

      _updateTabLoadUi(loadUi, 62, 'Loading activity', 'Refreshing latest notifications');
      const res = await api('/api/social/notifications?limit=60', 'GET');
      const data = res.ok ? await res.json() : { notifications: [], unread: 0 };
      _activityList = data.notifications || [];
      _activityUnread = Number(data.unread || 0);
      _activityCache = { ts: Date.now(), notifications: _activityList.slice(), unread: _activityUnread };
      _renderActivityList();
      const markBtn = document.getElementById('social-activity-mark');
      if (markBtn) markBtn.disabled = _activityUnread === 0;
      // Auto-mark all visible as read on view.
      // Optimistic: update the UI immediately, fire the POST without blocking.
      if (_activityUnread > 0) {
        _activityUnread = 0;
        _activityList = _activityList.map(n => ({ ...n, read_at: n.read_at || new Date().toISOString() }));
        _setSidebarBadge(0);
        _renderActivityList();
        if (markBtn) markBtn.disabled = true;
        api('/api/social/notifications/read', 'POST', { ids: null }).catch(() => {});
      }
    } catch {
      const list = document.getElementById('social-activity-list');
      if (list) list.innerHTML = `<div class="social-activity-empty"><div class="ring">⚠️</div><div class="ttl">Could not load activity</div><div class="sub">Check your connection and try again.</div><div class="actions"><button class="social-retry-btn" onclick="Social.switchTab('activity')"><span class="ico">↻</span> Retry</button></div></div>`;
    } finally {
      _activityLoading = false;
      _schedBgPrefetch('activity');
      _finishTabLoadUi(loadUi);
    }
  }

  async function markAllActivityRead() {
    try {
      await api('/api/social/notifications/read', 'POST', { ids: null });
    } catch {}
    _activityUnread = 0;
    _activityList = _activityList.map(n => ({ ...n, read_at: n.read_at || new Date().toISOString() }));
    _setSidebarBadge(0);
    _renderActivityList();
    const btn = document.getElementById('social-activity-mark');
    if (btn) btn.disabled = true;
  }

  function openActivityItem(id) {
    const n = _activityList.find(x => x.id === id);
    if (!n) return;
    // Mark this single item as read (best-effort) and update local state
    if (!n.read_at) {
      n.read_at = new Date().toISOString();
      _activityUnread = Math.max(0, _activityUnread - 1);
      _setSidebarBadge(_activityUnread);
      try { api('/api/social/notifications/read', 'POST', { ids: [id] }); } catch {}
      // Soft-update the row visually without re-rendering the whole list
      const row = document.querySelector(`.social-activity-item[data-id="${id}"]`);
      if (row) row.classList.remove('unread');
    }
    if (n.kind === 'follow') {
      if (n.actor_nickname) openProfile(n.actor_nickname);
      return;
    }
    if (n.post_id) {
      try {
        if (typeof viewPostDetail === 'function') viewPostDetail(n.post_id);
        else openProfile(State.user?.nickname);
      } catch {
        openProfile(State.user?.nickname);
      }
    }
  }

  // In-app toast that pings when a new social_notification arrives.
  function _activityToast(n) {
    try {
      const av = UI.avatarEl(n.actor_avatar, n.actor || '?', 32);
      let emoji = '🔔', body = '';
      if (n.event === 'like') {
        emoji = n.emoji || '❤';
        body = `<b>${esc(n.actor || 'Someone')}</b> reacted to your post`;
      } else if (n.event === 'comment') {
        emoji = '💬';
        const p = n.preview ? `<span style="color:#9bbeae;display:block;margin-top:2px;font-size:12px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">“${esc(n.preview)}”</span>` : '';
        body = `<b>${esc(n.actor || 'Someone')}</b> commented on your post${p}`;
      } else if (n.event === 'follow') {
        emoji = '＋';
        body = `<b>${esc(n.actor || 'Someone')}</b> started following you`;
      } else if (n.event === 'repost') {
        emoji = '🔁';
        body = `<b>${esc(n.actor || 'Someone')}</b> reposted your post`;
      } else {
        return;
      }
      const div = document.createElement('div');
      div.className = 'social-toast';
      div.innerHTML = `
        <div class="st-avatar">${av}</div>
        <div class="st-text">${body}</div>
        <div class="st-emoji">${esc(emoji)}</div>`;
      div.addEventListener('click', () => {
        try { open('activity'); } catch {}
        div.classList.remove('show');
        setTimeout(() => div.remove(), 300);
      });
      document.body.appendChild(div);
      // Stack vertically if multiple
      const existing = document.querySelectorAll('.social-toast.show');
      const offset = 12 + existing.length * 64;
      div.style.top = `calc(max(${offset}px, var(--safe-top, 0px) + ${offset - 12}px))`;
      requestAnimationFrame(() => div.classList.add('show'));
      setTimeout(() => {
        div.classList.remove('show');
        setTimeout(() => div.remove(), 350);
      }, 4500);
    } catch {}
  }

  function handleSocialNotification(payload) {
    if (!payload) return;
    const ev = payload.event;
    if (ev === 'unlike') {
      // Server may have decremented unread when the actor un-liked; trust its number.
      if (typeof payload.unread === 'number') {
        _activityUnread = payload.unread;
        _setSidebarBadge(_activityUnread);
      }
      // If currently viewing the activity tab, reload to drop the row.
      if (_currentTab === 'activity' && document.getElementById('social-activity-list')) {
        loadActivity();
      }
      return;
    }
    // Update unread count from server-provided value (authoritative)
    if (typeof payload.unread === 'number') {
      _activityUnread = payload.unread;
      _setSidebarBadge(_activityUnread);
    } else {
      _activityUnread += 1;
      _setSidebarBadge(_activityUnread);
    }
    // Toast unless we're already on the activity tab in an open social overlay.
    const overlay = document.getElementById('social-overlay');
    const overlayOpen = overlay && !overlay.classList.contains('hidden');
    const onActivityTab = overlayOpen && _currentTab === 'activity';
    if (!onActivityTab) _activityToast(payload);
    // If the activity tab is currently visible, prepend a fresh-looking row.
    if (onActivityTab) {
      _activityList.unshift({
        id: payload.id,
        kind: payload.event,                // 'like' | 'comment' | 'follow' | 'repost'
        post_id: payload.post_id || null,
        comment_id: payload.comment_id || null,
        emoji: payload.emoji || null,
        preview: payload.preview || null,
        created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        read_at: null,
        actor_nickname: payload.actor || '',
        actor_avatar: payload.actor_avatar || null,
      });
      _renderActivityList();
    }
  }

  function _onLogin() {
    try { refreshActivityBadge(); } catch {}
  }
  function _onLogout() {
    _activityUnread = 0;
    _activityList = [];
    _setSidebarBadge(0);
  }

  return {
    open, close, openProfile, switchTab, switchProfileTab,
    switchProfileMediaMode, loadProfileMediaCombined,
    openSideMenu, closeSideMenu, navTo, _initUploadRecovery,
    toggleFollow, reactPost, showReactPicker, showReactionDetail, toggleComments,
    toggleRepost,
    openQuoteRepost, closeQuoteRepost, submitQuoteRepost,
    submitComment, deleteComment, voteComment, deletePost, dmUser,
    shareProfile, profileShareUrl,
    sharePostUrl, postShareUrl,
    shareReelUrl, reelShareUrl,
    openPostMenu, blockUserFromSocial,
    promptDeletePrivateMedia, promptDeletePostMedia,
    addFriendFromProfile, acceptFriendFromProfile,
    refreshProfileRelationship,
    openNewPost, closeNewPost, handleNewPostMedia, openNewPostCamera, clearNewPostMedia, submitNewPost,    applyFilter, updateFilter,
    setPostPrivacy, cyclePostPrivacy, toggleAllowComments, toggleShareLink,
    showFollowers, showFollowing, closeUserList, openProfileFromUserList, expandPost,
    loadFeed, loadExplore, refreshExplore, loadProfile, moveToWall, previewMedia,
    viewPostDetail, closePostDetail, openPostComments,
    viewStories, nextStory, prevStory, closeStoryViewer, openStoryProfileFromViewer,
    viewProfileStories,
    openAddStory, closeAddStory, handleStoryMedia, openStoryCamera, submitStory, submitStoryFromTap, handleStoryShareTap, setStoryPrivacy, cycleStoryPrivacy,
    loadMusicTab, openMusicEmbed, promptMusicShare,
    playMusicInTab, toggleMusicCard, stopMusicInTab, _openNowPlaying,
    getNextMusicTrack, fetchDiscoverMusicTrack, scrollToMusicPost,
    _toggleNowPlaying, filterMusicByMood, filterMusicByMoodSelect,
    switchMusicScope, switchMusicSort,
    openMusicShareModal, closeMusicShareModal,
    _closeMusicShareModal, _submitMusicShare,
    // Reels
    loadReelsTab, switchReelsScope, switchReelsSort,
    toggleReelMute, toggleReelPlayback, reactReelHeart, openReelComments,
    openSharedReel,
    openReelReactPicker, _reelPickEmoji,
    // Activity / notifications
    loadActivity, markAllActivityRead, openActivityItem,
    handleSocialNotification, refreshActivityBadge, _onLogin, _onLogout,
    // Refresh inline avatars/nicknames in the Suggested-for-you bar and
    // any other rendered profile references when a user updates their
    // profile picture or nickname.
    refreshUserProfile(userId, nickname, avatar) {
      try {
        const nick = String(nickname || '');
        if (!nick) return;
        // Suggested cards
        document.querySelectorAll('.social-suggest-card').forEach(card => {
          const nameEl = card.querySelector('.social-suggest-nick');
          if (!nameEl) return;
          if (nameEl.textContent.trim() === nick) {
            const avWrap = card.querySelector('.social-suggest-avatar');
            if (avWrap && typeof UI !== 'undefined' && UI.avatarEl) {
              avWrap.innerHTML = UI.avatarEl(avatar, nick, 56);
            }
          }
        });
        // Feed / post author avatars rendered with [data-nick]
        document.querySelectorAll(`[data-social-nick="${CSS.escape(nick)}"]`).forEach(el => {
          if (typeof UI !== 'undefined' && UI.avatarEl) {
            const size = parseInt(el.getAttribute('data-size') || '40', 10) || 40;
            el.innerHTML = UI.avatarEl(avatar, nick, size);
          }
        });
      } catch {}
    },
    viewChannelProfile(name) { if (typeof viewChannelProfile === 'function') viewChannelProfile(name); },
  };
})();

// Expose globally so other modules (music.js) can feature-detect via
// `window.Social`. Top-level `const` does NOT attach to window in non-module
// scripts, so without this line `window.Social` would be undefined even
// though `Social` resolves fine in inline onclick= handlers.
window.Social = Social;
