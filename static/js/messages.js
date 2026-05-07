/**
 * messages.js — Render, send, edit, delete messages + reactions
 */

const Messages = (() => {
  let _lastNick = null;
  let _lastBridge = null;
  let _lastDate = null;
  let _isSending = false;
  let _previewCache = {};
  let _replyTo = null; // { id, nickname, content }

  // Inline SVG logos for bridge origin badge (tiny, monochrome, currentColor).
  const _TG_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.5 4.1 2.7 11.5c-.9.4-.9 1 .1 1.3l4.8 1.5 1.9 5.9c.2.7.6.9 1.1.4l2.7-2.5 4.8 3.6c.9.5 1.5.2 1.7-.8l3-14.1c.3-1.3-.5-1.9-1.3-1.7zM9.7 14.3l8.8-5.5c.4-.2.8.1.5.5l-7.2 6.5-.3 3.1-1.8-4.6z"/></svg>';
  const _DC_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.3 4.5a18.3 18.3 0 0 0-4.6-1.4l-.2.4c-1.7-.3-3.4-.3-5 0l-.2-.4a18 18 0 0 0-4.6 1.4C2.3 9.9 1.5 15.2 1.9 20.4a18.5 18.5 0 0 0 5.6 2.8l.4-.6c-.9-.3-1.8-.8-2.6-1.3l.2-.2c5 2.3 10.5 2.3 15.4 0l.2.2c-.8.5-1.7.9-2.6 1.3l.4.6a18.3 18.3 0 0 0 5.6-2.8c.5-6-.9-11.2-4.2-15.9zM8.5 17.2c-1.1 0-2-1-2-2.3 0-1.2.9-2.3 2-2.3s2 1 2 2.3c0 1.2-.9 2.3-2 2.3zm7 0c-1.1 0-2-1-2-2.3 0-1.2.9-2.3 2-2.3s2 1 2 2.3c0 1.2-.9 2.3-2 2.3z"/></svg>';

  function _bridgeBadge(msg) {
    const p = msg && msg.bridge_platform;
    if (!p) return '';
    const label = p === 'telegram' ? 'Telegram' : (p === 'discord' ? 'Discord' : p);
    const svg = p === 'telegram' ? _TG_SVG : (p === 'discord' ? _DC_SVG : '');
    return `<span class="bridge-origin-badge" data-platform="${p}" title="Mirrored from ${label}">${svg}<span>${label}</span></span>`;
  }

  function _normalizeUrl(url) {
    return String(url || '').replace(/&amp;/g, '&');
  }

  // Re-pin the messages area to the bottom AFTER an async embed swap
  // (invite/profile/post/reel) replaces a small placeholder span with a
  // taller card. The render-time auto-scroll fires before hydration
  // completes; without this nudge, the new card pushes the latest
  // message below the fold. We only snap if the viewer was already at
  // (or very near) the bottom — never yank someone who's reading
  // history. Threshold is generous (450px) because a single card can
  // be 200–400px tall and we want to keep the bottom anchored even if
  // multiple embeds finish in series.
  function _scrollIfNearBottom() {
    const area = document.getElementById('messages-area');
    if (!area) return;
    const distance = area.scrollHeight - area.scrollTop - area.clientHeight;
    if (distance > 450) return;
    const snap = () => { area.scrollTop = area.scrollHeight; };
    requestAnimationFrame(() => { snap(); requestAnimationFrame(snap); });
  }

  function _parseFrogSocialUrl(url) {
    try {
      const parsed = new URL(_normalizeUrl(url));
      const hostOk = (parsed.hostname === 'frogtalk.xyz' || parsed.hostname === 'localhost');
      if (!hostOk) return null;
      const path = parsed.pathname || '/';
      const profilePath = path.match(/^\/u\/([A-Za-z0-9_]{1,32})\/?$/i);
      if (profilePath) return { type: 'profile', nickname: profilePath[1] };
      const postPath = path.match(/^\/p\/(\d+)\/?$/i);
      if (postPath) return { type: 'post', postId: Number(postPath[1]) };
      const reelPath = path.match(/^\/r\/(\d+)\/?$/i);
      if (reelPath) return { type: 'reel', postId: Number(reelPath[1]) };
      const qProfile = (parsed.searchParams.get('profile') || '').trim();
      if (/^[A-Za-z0-9_]{1,32}$/.test(qProfile)) return { type: 'profile', nickname: qProfile };
      const qPost = (parsed.searchParams.get('post') || parsed.searchParams.get('p') || '').trim();
      if (/^\d+$/.test(qPost)) return { type: 'post', postId: Number(qPost) };
      const qReel = (parsed.searchParams.get('reel') || '').trim();
      if (/^\d+$/.test(qReel)) return { type: 'reel', postId: Number(qReel) };
      return null;
    } catch {
      return null;
    }
  }

  function _formatContent(text) {
    if (!text) return '';
    // Profile share card
    if (text.startsWith('{"_type":"profile_share"')) {
      try {
        const d = JSON.parse(text);
        if (d._type === 'profile_share') {
          return `<div class="share-card" onclick="showUserInfo('${UI.escHtml(d.nickname)}',${d.user_id || 'null'})">
            <div style="flex-shrink:0">${UI.avatarEl(d.avatar || null, d.nickname, 42)}</div>
            <div class="share-card-info">
              <div class="share-card-label">FrogTalk Profile</div>
              <div class="share-card-name">@${UI.escHtml(d.nickname)}</div>
              ${d.bio ? `<div class="share-card-bio">${UI.escHtml(d.bio.substring(0, 60))}</div>` : ''}
            </div>
          </div>`;
        }
      } catch {}
    }
    // Basic URL linkification
    const urlRe = /https?:\/\/[^\s<>"]+/g;
    let escaped = UI.escHtml(text);
    
    // Highlight @mentions. Server NICKNAME_RE allows letters, digits,
    // underscore and hyphen, so `\w` (no `-`) would truncate names like
    // "foo-bar" at the hyphen and only highlight "@foo". Match the full
    // valid charset, but don't start or end with `-` so trailing dashes
    // and stray hyphens after a mention aren't swallowed.
    escaped = escaped.replace(/@([A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)/g, (match, nick) => {
      const isSelf = nick.toLowerCase() === State.user?.nickname?.toLowerCase();
      return `<span class="mention${isSelf ? ' mention-self' : ''}">@${nick}</span>`;
    });

    // Channel references: #channelname → clickable pill that switches to
    // the room (or shows a "deleted" toast if the channel no longer exists).
    // Allowed chars match the room-name constraint (letters, digits, _-).
    // Rejects things that look like CSS colors (#abc, #a1b2c3) or trailing
    // hashes inside URLs by requiring a word-boundary before the hash.
    escaped = escaped.replace(/(^|[\s(\[>])#([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})\b/g,
      (m, pre, name) => `${pre}<span class="room-mention" data-room="${UI.escHtml(name)}" onclick="Rooms.openChannelLink('${UI.escHtml(name).replace(/'/g,"\\'")}')">#${UI.escHtml(name)}</span>`);

    // FrogTalk invite URLs → render a card placeholder instead of a plain link.
    // Accepts both the legacy /invite/<8-16 chars> form and the new short
    // /i/<code-or-vanity> form. Vanities are 2–32 chars, [a-z0-9_-], so the
    // unified pattern just allows 2–32 [A-Za-z0-9_-] and lets the server
    // resolve which kind it is.
    const inviteRe = /https?:\/\/(?:frogtalk\.xyz|localhost(?::\d+)?)\/(?:invite|i)\/([A-Za-z0-9_-]{2,32})/g;
    escaped = escaped.replace(inviteRe, (url, code) =>
      `<span class="invite-card-placeholder" data-invite-code="${UI.escHtml(code)}">` +
      `<span class="invite-card-loading">🐸 Loading invite…</span></span>`
    );

    escaped = escaped.replace(urlRe, url => {
      // Skip invite URLs — already replaced above
      if (/\/(?:invite|i)\/[A-Za-z0-9_-]{2,32}/.test(url)) return url;
      const social = _parseFrogSocialUrl(url);
      if (social?.type === 'profile') {
        return `<span class="social-profile-card-placeholder" data-social-profile="${UI.escHtml(social.nickname)}">` +
          `<span class="invite-card-loading">🐸 Loading profile…</span></span>`;
      }
      if (social?.type === 'post') {
        return `<span class="social-post-card-placeholder" data-social-post="${social.postId}">` +
          `<span class="invite-card-loading">🐸 Loading post…</span></span>`;
      }
      if (social?.type === 'reel') {
        return `<span class="social-reel-card-placeholder" data-social-reel="${social.postId}">` +
          `<span class="invite-card-loading">🐸 Loading reel…</span></span>`;
      }
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="msg-link" data-preview-url="${UI.escHtml(url)}">${url}</a>`;
    });
    
    // Render custom emojis
    if (typeof renderCustomEmojisInText === 'function') {
      escaped = renderCustomEmojisInText(escaped);
    }
    return escaped;
  }

  // ── Share card loaders ───────────────────────────────────────────────
  // Strategy: try the PUBLIC /api/share/* endpoint first (cacheable, no
  // auth, works for share-enabled public profiles/posts/reels). Fall back
  // to the AUTH'd wall/social endpoints for private content the viewer is
  // allowed to see (friends/followers). All loaders dedupe per-postId so
  // the same shared link in 10 messages only fetches once.
  const _shareInfoCache = new Map(); // key → Promise<{ok,data,kind}>

  function _shareFetchOnce(key, fn) {
    if (_shareInfoCache.has(key)) return _shareInfoCache.get(key);
    const p = fn().catch(() => ({ ok: false }));
    _shareInfoCache.set(key, p);
    // Expire after 2min so deleted/edited posts eventually re-fetch.
    setTimeout(() => { try { _shareInfoCache.delete(key); } catch {} }, 120000);
    return p;
  }

  // Bounded timeout so a stalled fetch fails fast and the user sees the
  // "unavailable" placeholder instead of an indefinite loader. The
  // server-side endpoint is cheap; if it's not back in 8s something is
  // wrong (offline / federated peer down / server backlogged).
  function _withTimeout(ms = 8000) {
    if (typeof AbortController === 'undefined') return { signal: undefined, cancel: () => {} };
    const ctrl = new AbortController();
    const t = setTimeout(() => { try { ctrl.abort(); } catch {} }, ms);
    return { signal: ctrl.signal, cancel: () => { try { clearTimeout(t); } catch {} } };
  }

  async function _publicGet(url) {
    const tm = _withTimeout(8000);
    try {
      const res = await fetch(url, { credentials: 'omit', cache: 'default', signal: tm.signal });
      if (!res.ok) return { ok: false };
      const data = await res.json().catch(() => null);
      return data ? { ok: true, data } : { ok: false };
    } catch {
      return { ok: false };
    } finally {
      tm.cancel();
    }
  }

  async function _authedGet(url) {
    const tm = _withTimeout(8000);
    try {
      const res = await apiFetch(url, { signal: tm.signal });
      if (!res.ok) return { ok: false };
      const data = await res.json().catch(() => null);
      return data ? { ok: true, data } : { ok: false };
    } catch {
      return { ok: false };
    } finally {
      tm.cancel();
    }
  }

  async function _loadSocialProfileCard(msgId, nickname) {
    const msgEl = document.getElementById(`msg-${msgId}`);
    if (!msgEl) return;
    const placeholder = msgEl.querySelector(`.social-profile-card-placeholder[data-social-profile="${nickname}"]`);
    if (!placeholder) return;
    const key = `profile:${nickname.toLowerCase()}`;
    const result = await _shareFetchOnce(key, async () => {
      // Public first — works for any profile_public=1 user
      const pub = await _publicGet(`/api/share/profile/${encodeURIComponent(nickname)}`);
      if (pub.ok) return pub;
      // Fall back to the authed social endpoint for friends/private profiles
      return await _authedGet(`/api/social/profile/${encodeURIComponent(nickname)}`);
    });
    if (!result.ok) {
      placeholder.outerHTML = `<span class="invite-card invite-card-invalid">❌ Profile unavailable</span>`;
      _scrollIfNearBottom();
      return;
    }
    const d = result.data || {};
    const nick = UI.escHtml(d.nickname || nickname);
    const subtitle = d.private
      ? 'Private profile'
      : UI.escHtml(String(d.bio || d.status_msg || 'Open in Frog Social').substring(0, 80));
    placeholder.outerHTML =
      `<div class="share-card" data-social-profile="${nick}" onclick="Messages.openSocialProfile(this.dataset.socialProfile)">` +
        `<div style="flex-shrink:0">${UI.avatarEl(d.avatar || null, d.nickname || nickname, 42)}</div>` +
        `<div class="share-card-info">` +
          `<div class="share-card-label">Frog Social Profile</div>` +
          `<div class="share-card-name">@${nick}</div>` +
          `<div class="share-card-bio">${subtitle}</div>` +
        `</div>` +
      `</div>`;
    _scrollIfNearBottom();
  }

  // Build a provider-iframe src for a music-post URL. Returns null if
  // the URL doesn't match a supported pattern. Mirrors the heuristics
  // in routers/wall.py / static/js/music.js but runs entirely on the
  // client so the inline player works for any music/* share — including
  // ones served via /api/wall/posts where we never get a parsed
  // provider/video_id back.
  function _musicEmbedSrc(provider, url) {
    if (!url || typeof url !== 'string') return null;
    const u = url.trim();
    const prov = String(provider || '').toLowerCase();
    try {
      // YouTube
      if (prov === 'youtube' || /(?:youtube\.com|youtu\.be)/i.test(u)) {
        let id = '';
        const m1 = u.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
        const m2 = u.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/i);
        const m3 = u.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/i);
        id = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]) || '';
        if (!id) return null;
        return { kind: 'youtube', src: `https://www.youtube.com/embed/${encodeURIComponent(id)}?enablejsapi=1` };
      }
      // Spotify — accept any open.spotify.com/{track,album,playlist,episode}/<id>
      if (prov === 'spotify' || /open\.spotify\.com/i.test(u)) {
        const m = u.match(/open\.spotify\.com\/(?:embed\/)?(track|album|playlist|episode|show)\/([A-Za-z0-9]{10,})/i);
        if (!m) return null;
        const type = m[1].toLowerCase();
        const id = m[2];
        return {
          kind: 'spotify',
          src: `https://open.spotify.com/embed/${encodeURIComponent(type)}/${encodeURIComponent(id)}?theme=0`,
          height: type === 'track' ? 80 : 152,
        };
      }
      // SoundCloud — needs the full URL passed to its widget
      if (prov === 'soundcloud' || /soundcloud\.com/i.test(u)) {
        return {
          kind: 'soundcloud',
          src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(u)}&auto_play=false&show_artwork=true&visual=false&hide_related=true&color=%239b59ff`,
          height: 120,
        };
      }
    } catch {}
    return null;
  }

  function _renderRichShareEmbed(p, kind, postId) {
    const nick = UI.escHtml(p.nickname || 'frog');
    const mediaType = String(p.media_type || '').toLowerCase();
    const isVideo = mediaType.startsWith('video/');
    const isImage = mediaType.startsWith('image/');
    const isMusic = mediaType.startsWith('music/');
    const provider = isMusic ? mediaType.slice('music/'.length) : '';
    const pid = Number(p.id || postId);
    const label = isMusic
      ? 'Frog Social Music'
      : (kind === 'reel'
          ? 'Frog Social Reel'
          : (String(p.privacy || 'public').toLowerCase() === 'public' ? 'Frog Social Post' : (String(p.privacy).toLowerCase() === 'followers' ? 'Followers Post' : 'Private Post')));
    let caption = String(p.content || '').trim();
    if (!caption) {
      if (isImage) caption = '📷 Photo post';
      else if (isVideo) caption = kind === 'reel' ? '🎬 Watch this reel' : '🎬 Video post';
      else if (isMusic) caption = '🎵 Music post';
      else caption = 'Open in Frog Social';
    }
    const safeCap = UI.escHtml(caption.substring(0, 220));
    const avatar = UI.avatarEl(p.avatar || null, p.nickname || 'frog', 32);
    const onclick = kind === 'reel'
      ? `Messages.openSocialReel(${pid})`
      : `Messages.openSocialPost(${pid})`;

    // Pick a public media URL (works for share-enabled public posts only).
    // For authed responses without a public URL, fall back to the inline
    // data: URI returned in the post payload.
    let mediaUrl = p.media_url || null;
    if (!mediaUrl && (isVideo || isImage)) {
      if (typeof p.media_data === 'string' && p.media_data.startsWith('data:')) {
        mediaUrl = p.media_data;
      } else if (typeof p.media_data === 'string' && /^https?:\/\//i.test(p.media_data)) {
        mediaUrl = p.media_data;
      } else {
        mediaUrl = isVideo ? `/r/${pid}/media` : `/og/post/${pid}.img`;
      }
    }
    // Music: media_url comes from /api/share/post (public) as the
    // provider URL; fall back to media_data on the authed response.
    let musicUrl = null;
    if (isMusic) {
      if (mediaUrl && /^https?:\/\//i.test(mediaUrl)) musicUrl = mediaUrl;
      else if (typeof p.media_data === 'string' && /^https?:\/\//i.test(p.media_data)) musicUrl = p.media_data;
    }

    let mediaHtml = '';
    if (isMusic) {
      const embed = _musicEmbedSrc(provider, musicUrl);
      if (embed) {
        const h = embed.kind === 'youtube' ? 0 /* aspect-driven */ : (embed.height || 120);
        // YouTube renders responsive 16:9 via padding-bottom hack;
        // Spotify/SoundCloud get a fixed height per provider.
        if (embed.kind === 'youtube') {
          mediaHtml =
            `<div class="chat-share-media chat-share-music chat-share-music-yt"` +
                 ` onclick="event.stopPropagation()">` +
              `<div class="chat-share-music-yt-frame">` +
                `<iframe src="${UI.escHtml(embed.src)}" loading="lazy"` +
                       ` allow="autoplay; encrypted-media; picture-in-picture"` +
                       ` allowfullscreen frameborder="0"></iframe>` +
              `</div>` +
            `</div>`;
        } else {
          mediaHtml =
            `<div class="chat-share-media chat-share-music"` +
                 ` onclick="event.stopPropagation()">` +
              `<iframe src="${UI.escHtml(embed.src)}" loading="lazy"` +
                     ` style="height:${h}px"` +
                     ` allow="autoplay; clipboard-write; encrypted-media; picture-in-picture"` +
                     ` frameborder="0"></iframe>` +
            `</div>`;
        }
      }
    } else if (isVideo && mediaUrl) {
      // Suppress the browser's giant default poster/play UI (Chrome on
      // Android shows a huge ⭕▶ until a real frame is decoded). A
      // transparent 1×1 GIF as `poster` keeps the area blank so our
      // own shimmer + green play overlay are the only visible UI until
      // the real first frame is decoded by the seek below.
      const BLANK_POSTER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
      // Force a tiny seek as soon as metadata is available — this makes
      // the browser decode and paint the first frame so the video itself
      // becomes the poster, working reliably across Chrome / Safari /
      // Firefox where `#t=…` does not.
      const onMeta = "try{this.currentTime=0.1}catch(e){}";
      const onSeeked = "this.parentElement&&this.parentElement.classList.add('has-frame')";
      mediaHtml =
        `<div class="chat-share-media chat-share-video" data-pid="${pid}">` +
          `<video class="chat-share-video-el" preload="metadata" playsinline muted loop ` +
                 `poster="${BLANK_POSTER}" ` +
                 `src="${UI.escHtml(mediaUrl)}" ` +
                 `onloadedmetadata="${onMeta}" ` +
                 `onseeked="${onSeeked}" ` +
                 `onloadeddata="${onSeeked}" ` +
                 `onclick="event.stopPropagation();Messages._toggleChatVideo(this)"></video>` +
          `<button class="chat-share-play-overlay" type="button" aria-label="Play"` +
                 ` onclick="event.stopPropagation();Messages._toggleChatVideo(this.previousElementSibling)">` +
            `<span class="chat-share-play-icon">▶</span>` +
          `</button>` +
        `</div>`;
    } else if (isImage && mediaUrl) {
      mediaHtml =
        `<div class="chat-share-media chat-share-image">` +
          `<img loading="lazy" decoding="async" src="${UI.escHtml(mediaUrl)}" alt="">` +
        `</div>`;
    }

    const cardCls = `chat-share-embed${isMusic ? ' is-music' : ''}`;
    const footLabel = isMusic ? 'Open music post →' : 'Open in Frog Social →';
    return (
      `<div class="${cardCls}" data-share-${kind}="${pid}" onclick="${onclick}">` +
        `<div class="chat-share-embed-head">` +
          `<div class="chat-share-embed-avatar">${avatar}</div>` +
          `<div class="chat-share-embed-meta">` +
            `<div class="chat-share-embed-label">${UI.escHtml(label)}</div>` +
            `<div class="chat-share-embed-name">@${nick}</div>` +
          `</div>` +
          `<div class="chat-share-embed-logo" aria-hidden="true">${isMusic ? '🎵' : '🐸'}</div>` +
        `</div>` +
        (caption ? `<div class="chat-share-embed-caption">${safeCap}</div>` : '') +
        mediaHtml +
        `<div class="chat-share-embed-foot">${footLabel}</div>` +
      `</div>`
    );
  }

  // Toggle play/pause on inline chat video. Pauses any other inline
  // videos so we don't end up with 5 reels playing at once.
  function _toggleChatVideo(videoEl) {
    if (!videoEl) return;
    try {
      if (videoEl.paused) {
        document.querySelectorAll('.chat-share-video-el').forEach(v => {
          if (v !== videoEl) { try { v.pause(); } catch {} }
        });
        const wrap = videoEl.closest('.chat-share-video');
        if (wrap) wrap.classList.add('is-playing');
        // Best effort: try with sound, fall back to muted if blocked.
        videoEl.muted = false;
        videoEl.play().catch(() => {
          videoEl.muted = true;
          videoEl.play().catch(() => {});
        });
      } else {
        videoEl.pause();
        const wrap = videoEl.closest('.chat-share-video');
        if (wrap) wrap.classList.remove('is-playing');
      }
    } catch {}
  }

  async function _loadSocialPostCard(msgId, postId) {
    const msgEl = document.getElementById(`msg-${msgId}`);
    if (!msgEl) return;
    const placeholder = msgEl.querySelector(`.social-post-card-placeholder[data-social-post="${postId}"]`);
    if (!placeholder) return;
    const key = `post:${postId}`;
    const result = await _shareFetchOnce(key, async () => {
      const pub = await _publicGet(`/api/share/post/${encodeURIComponent(postId)}`);
      if (pub.ok) return pub;
      return await _authedGet(`/api/wall/posts/${encodeURIComponent(postId)}`);
    });
    if (!result.ok) {
      placeholder.outerHTML = `<span class="invite-card invite-card-invalid">❌ Post unavailable</span>`;
      _scrollIfNearBottom();
      return;
    }
    placeholder.outerHTML = _renderRichShareEmbed(result.data || {}, 'post', postId);
    _scrollIfNearBottom();
  }

  async function _loadSocialReelCard(msgId, postId) {
    const msgEl = document.getElementById(`msg-${msgId}`);
    if (!msgEl) return;
    const placeholder = msgEl.querySelector(`.social-reel-card-placeholder[data-social-reel="${postId}"]`);
    if (!placeholder) return;
    const key = `reel:${postId}`;
    const result = await _shareFetchOnce(key, async () => {
      const pub = await _publicGet(`/api/share/reel/${encodeURIComponent(postId)}`);
      if (pub.ok) return pub;
      return await _authedGet(`/api/wall/posts/${encodeURIComponent(postId)}`);
    });
    if (!result.ok) {
      placeholder.outerHTML = `<span class="invite-card invite-card-invalid">❌ Reel unavailable</span>`;
      _scrollIfNearBottom();
      return;
    }
    const data = result.data || {};
    const mt = String(data.media_type || '').toLowerCase();
    if (!mt.startsWith('video/')) {
      placeholder.outerHTML = `<span class="invite-card invite-card-invalid">❌ Not a reel</span>`;
      _scrollIfNearBottom();
      return;
    }
    placeholder.outerHTML = _renderRichShareEmbed(data, 'reel', postId);
    _scrollIfNearBottom();
  }

  // Hoist share-card placeholders (and the cards they become) onto
  // their own block-level row, placed immediately AFTER the .msg-meta
  // (author + timestamp) and BEFORE .msg-content. Users want the
  // author/time line at the very top of every message, then the
  // embedded card, then any text the user wrote — putting the embed
  // above the meta hides the sender label behind the card.
  function _hoistShareCardToTop(placeholder) {
    if (!placeholder) return;
    const body = placeholder.closest('.msg-body') || placeholder.closest('.msg-cont-wrap > div');
    if (!body) return;
    let row = placeholder.parentElement;
    if (!row || !row.classList || !row.classList.contains('msg-share-row')) {
      row = document.createElement('div');
      row.className = 'msg-share-row';
      placeholder.parentNode.replaceChild(row, placeholder);
      row.appendChild(placeholder);
    }
    const meta = body.querySelector(':scope > .msg-meta');
    if (meta) {
      // Slot right after the meta row.
      if (meta.nextElementSibling !== row) meta.parentNode.insertBefore(row, meta.nextSibling);
    } else if (body.firstChild !== row) {
      body.insertBefore(row, body.firstChild);
    }
  }

  function _hydrateSpecialCards(msgId) {
    const msgEl = document.getElementById(`msg-${msgId}`);
    if (!msgEl) return;
    // Hoist all share placeholders to the top of the body BEFORE kicking
    // off async loads, so the in-flight loader (and the eventual card or
    // failure state) always sit above the message text.
    msgEl.querySelectorAll(
      '.social-profile-card-placeholder[data-social-profile],' +
      '.social-post-card-placeholder[data-social-post],' +
      '.social-reel-card-placeholder[data-social-reel]'
    ).forEach(_hoistShareCardToTop);

    msgEl.querySelectorAll('.invite-card-placeholder[data-invite-code]').forEach(el => {
      const code = (el.dataset.inviteCode || '').trim();
      if (code) _loadInviteCard(msgId, code);
    });
    msgEl.querySelectorAll('.social-profile-card-placeholder[data-social-profile]').forEach(el => {
      const nick = (el.dataset.socialProfile || '').trim();
      if (nick) _loadSocialProfileCard(msgId, nick);
    });
    msgEl.querySelectorAll('.social-post-card-placeholder[data-social-post]').forEach(el => {
      const postId = Number(el.dataset.socialPost || '0');
      if (Number.isFinite(postId) && postId > 0) _loadSocialPostCard(msgId, postId);
    });
    msgEl.querySelectorAll('.social-reel-card-placeholder[data-social-reel]').forEach(el => {
      const postId = Number(el.dataset.socialReel || '0');
      if (Number.isFinite(postId) && postId > 0) _loadSocialReelCard(msgId, postId);
    });
  }

  // Fetch invite info and render a join card
  async function _loadInviteCard(msgId, code) {
    const msgEl = document.getElementById(`msg-${msgId}`);
    if (!msgEl) return;
    const placeholder = msgEl.querySelector(`.invite-card-placeholder[data-invite-code="${code}"]`);
    if (!placeholder) return;

    try {
      const res = await apiFetch(`/api/invites/${encodeURIComponent(code)}`);
      const data = await res.json();
      if (!placeholder.parentNode) return;
      if (!res.ok || !data.valid) {
        placeholder.outerHTML = `<span class="invite-card invite-card-invalid">❌ Invite invalid or expired</span>`;
        _scrollIfNearBottom();
        return;
      }
      // room_icon can be a single emoji, an uploaded image (data: URL,
      // absolute path, or http(s) URL), or a legacy multi-char text string.
      // Render <img> for images, otherwise take just the first grapheme so
      // the 48x48 avatar circle never overflows with stray letters.
      const rawIconStr = String(data.room_icon || '').trim();
      const isImg = rawIconStr && (
        rawIconStr.startsWith('data:image') ||
        rawIconStr.startsWith('http://') ||
        rawIconStr.startsWith('https://') ||
        rawIconStr.startsWith('/')
      );
      let iconHtml;
      if (isImg) {
        iconHtml = `<img src="${UI.escHtml(rawIconStr)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block">`;
      } else {
        let glyph = rawIconStr || '💬';
        try { glyph = Array.from(glyph)[0] || '💬'; } catch { glyph = glyph.charAt(0) || '💬'; }
        iconHtml = UI.escHtml(glyph);
      }
      const name = UI.escHtml(data.room_name || '');
      const desc = data.room_desc ? `<div class="invite-card-desc">${UI.escHtml(data.room_desc.substring(0, 100))}</div>` : '';
      const _rawByNick = ((data.created_by_handle || data.created_by || '').replace(/^@+/, '').trim());
      const byNick = _rawByNick;
      const createdBy = _rawByNick ? `@${_rawByNick}` : '';
      const by = createdBy
        ? `<span class="invite-card-by">Invited by <strong class="invite-card-by-nick"${byNick ? ` onclick="event.stopPropagation();Messages.openSocialProfile('${UI.escHtml(byNick)}')" tabindex="0" role="button"` : ''}>${UI.escHtml(createdBy)}</strong></span>`
        : '';
      const alreadyJoined = (State.rooms || []).some(r => r.name === data.room_name && r.joined);
      const btnHtml = alreadyJoined
        ? `<button class="invite-join-btn invite-join-btn--already" onclick="Rooms.openChannelLink('${name}')">Open Channel</button>`
        : `<button class="invite-join-btn" onclick="Messages.joinViaInvite('${UI.escHtml(code)}',this)">Join</button>`;
      if (!placeholder.parentNode) return;
      placeholder.outerHTML = `
        <div class="invite-card">
          <div class="invite-card-header">You've been invited to join a channel</div>
          <div class="invite-card-body">
            <div class="invite-card-icon">${iconHtml}</div>
            <div class="invite-card-info">
              <div class="invite-card-name">#${name}</div>
              ${desc}
              ${by}
            </div>
            ${btnHtml}
          </div>
        </div>`;
      _scrollIfNearBottom();
    } catch (e) {
      if (placeholder.parentNode) {
        placeholder.outerHTML = `<span class="invite-card invite-card-invalid">❌ Could not load invite</span>`;
        _scrollIfNearBottom();
      }
    }
  }

  // Discord-style "X" — author dismisses the embed for everyone.
  // Sends a small POST then optimistically removes the embed; the
  // resulting WS broadcast also calls applyPreviewSuppress() for every
  // other client (and for this one if WS races us, applyPreviewSuppress
  // is idempotent because the embed is already gone).
  async function suppressPreview(msgId) {
    try {
      const res = await apiFetch(`/api/messages/${msgId}/preview-suppress`, 'POST');
      if (!res.ok) return;
    } catch { return; }
    applyPreviewSuppress(msgId);
  }

  function applyPreviewSuppress(msgId) {
    // Update cached state across all rooms so a re-render (e.g. switching
    // back to the room) doesn't resurrect the embed.
    try {
      Object.values(State.messages || {}).forEach(arr => {
        if (!Array.isArray(arr)) return;
        const m = arr.find(x => x && +x.id === +msgId);
        if (m) m.preview_suppressed = 1;
      });
    } catch {}
    const msgEl = document.getElementById(`msg-${msgId}`);
    if (!msgEl) return;
    msgEl.querySelectorAll('.link-preview, .yt-embed, .spotify-embed').forEach(el => el.remove());
    // Drop the X-button wrapper too — it has no embed left to decorate.
    msgEl.querySelectorAll('.preview-wrap').forEach(el => el.remove());
  }

  // Fetch and render link preview
  async function _loadLinkPreview(msgId, url) {
    // Author-suppressed embeds: don't even fetch.
    try {
      const cached = (State.messages[State.currentRoom] || []).find(m => m && +m.id === +msgId);
      if (cached && cached.preview_suppressed) return;
    } catch {}
    if (_previewCache[url] !== undefined) {
      if (_previewCache[url]) _renderPreview(msgId, _previewCache[url]);
      return;
    }
    
    try {
      const res = await apiFetch(`/api/preview?url=${encodeURIComponent(url)}`);
      if (!res.ok) return;
      const data = await res.json();
      _previewCache[url] = data.preview;
      if (data.preview) _renderPreview(msgId, data.preview);
    } catch (e) {}
  }

  function _renderPreview(msgId, preview) {
    const msgEl = document.getElementById(`msg-${msgId}`);
    if (!msgEl || msgEl.querySelector('.link-preview, .yt-embed, .spotify-embed')) return;
    
    const body = msgEl.querySelector('.msg-body') || msgEl.querySelector('.msg-cont-wrap > div');
    if (!body) return;

    // Build a "Send to side player" affordance for music-capable embeds.
    // The Music side-player understands raw YT/Spotify/SoundCloud URLs
    // via Music.playSolo; we just need to hand it the original URL plus
    // a hint so it shows the right artwork in the dock.
    //
    // We render the button as a real <button> (not an <a>) so it can
    // safely live inside a parent <a target="_blank"> without racing
    // the anchor's default navigation. The click handler also swallows
    // bubbling so the parent <a> can't fire.
    function _buildSendToPlayerBtn(provider) {
      const url = String(preview.url || '');
      if (!url) return '';
      const title = String(preview.title || (provider === 'youtube' ? 'YouTube video' : provider === 'spotify' ? 'Spotify track' : 'SoundCloud track'));
      const thumb = String(preview.image || preview.thumbnail || '');
      // Render-time hide: in a media channel where the user can't queue
      // (DJ-only mode and they're not a DJ/mod/owner), don't show the
      // affordance at all. We only check this on render — the queue-vs-
      // solo routing is decided at click time below so a late Music.mount
      // doesn't leave us stuck on the wrong path. The click handler also
      // re-checks "no queue permission" and bails out gracefully if the
      // permission flipped between render and click.
      try {
        if (window.Music && Music.isMediaChannelContext && Music.isMediaChannelContext()
            && Music.canQueueInCurrentRoom && !Music.canQueueInCurrentRoom()) {
          return '';
        }
      } catch {}
      // JSON-encode then HTML-escape — safe to drop into an attribute.
      const payload = UI.escHtml(JSON.stringify({ url, title, provider, thumbnail: thumb }));
      // Click handler routes at click time:
      //   • Media channel + queue permission → queue into the big channel
      //     player so the whole room hears it together.
      //   • Otherwise → side / solo player.
      // Always pause the inline embed afterwards so the chat iframe and
      // the player don't double-play out of sync.
      return `<button type="button" class="embed-send-player" data-payload="${payload}"
        onclick="event.preventDefault();event.stopPropagation();(function(b){try{var p=JSON.parse(b.getAttribute('data-payload'));var M=window.Music;var inMedia=!!(M&&M.isMediaChannelContext&&M.isMediaChannelContext());var canQ=inMedia&&!!(M&&M.canQueueInCurrentRoom&&M.canQueueInCurrentRoom());if(inMedia&&canQ&&M.queueFromUrl){M.queueFromUrl(p.url).then(function(ok){try{UI&&UI.showToast&&UI.showToast(ok?'Added to channel queue':'Could not queue — playing in side player','info');}catch(_){}if(!ok&&M.playSolo){try{M.playSolo(p);}catch(_){}}});}else if(inMedia&&!canQ){try{UI&&UI.showToast&&UI.showToast('You don\\u0027t have queue permission in this channel','error');}catch(_){}return;}else if(M&&M.playSolo){M.playSolo(p);try{UI&&UI.showToast&&UI.showToast('Playing in side player');}catch(_){}}try{window._pauseChatEmbed&&window._pauseChatEmbed(b);}catch(_){}}catch(e){}})(this)"
        onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()"
        title="Send this track to the player"
        style="background:transparent;border:0;padding:2px 8px;font-size:11px;font-weight:500;color:rgba(76,175,80,.72);cursor:pointer;border-radius:4px;line-height:1.4;letter-spacing:.2px;flex:0 0 auto;transition:color .15s,background .15s"
        onmouseover="this.style.color='#7ed28a';this.style.background='rgba(76,175,80,.10)'"
        onmouseout="this.style.color='rgba(76,175,80,.72)';this.style.background='transparent'"
      >▸ Send to player</button>`;
    }
    
    let html = '';
    
    // YouTube embed
    if (preview.type === 'youtube' && preview.video_id) {
      html = `
        <div class="yt-embed" style="margin-top:8px;max-width:560px;width:100%;border-radius:10px;overflow:hidden;background:linear-gradient(180deg,#173027 0%,#102018 100%);border:1px solid #2f5548;box-shadow:0 2px 12px rgba(0,0,0,.35)">
          <div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden">
            <iframe 
              src="https://www.youtube.com/embed/${UI.escHtml(preview.video_id)}?enablejsapi=1" 
              style="position:absolute;top:0;left:0;width:100%;height:100%;border:0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
              allowfullscreen
            ></iframe>
          </div>
          <div style="padding:8px 12px;border-top:1px solid #2f5548;background:rgba(12,28,22,.52);display:flex;align-items:center;gap:10px">
            <div style="flex:1 1 auto;min-width:0">
              <div style="font-size:11px;color:#ff0000;display:flex;align-items:center;gap:4px;margin-bottom:4px">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#ff0000"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"/><path fill="#fff" d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                YouTube${preview.author ? ` • ${UI.escHtml(preview.author)}` : ''}
              </div>
              <a href="${UI.escHtml(preview.url)}" target="_blank" rel="noopener" style="font-weight:600;color:#dff5e8;font-size:13px;text-decoration:none;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${UI.escHtml(preview.title || 'YouTube Video')}</a>
            </div>
            ${_buildSendToPlayerBtn('youtube')}
          </div>
        </div>
      `;
    }
    // Spotify embed
    else if (preview.type === 'spotify' && preview.embed_url) {
      const height = preview.spotify_type === 'track' ? '80' : '152';
      html = `
        <div class="spotify-embed" style="margin-top:8px;max-width:400px;border-radius:12px;overflow:hidden;background:linear-gradient(180deg,#173027 0%,#102018 100%);border:1px solid #2f5548;box-shadow:0 2px 12px rgba(0,0,0,.35)">
          <iframe 
            src="${UI.escHtml(preview.embed_url)}?theme=0" 
            width="100%" 
            height="${height}" 
            frameBorder="0" 
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            style="display:block;border:0"
          ></iframe>
          <div style="padding:6px 10px;border-top:1px solid #2f5548;background:rgba(12,28,22,.52);display:flex;align-items:center;gap:10px">
            <div style="flex:1 1 auto;min-width:0;font-size:11px;color:#1db954;font-weight:600;letter-spacing:.3px">Spotify</div>
            ${_buildSendToPlayerBtn('spotify')}
          </div>
        </div>
      `;
    }
    // Twitter/X - show link preview (can't embed due to restrictions)
    else if (preview.type === 'twitter') {
      html = `
        <a href="${UI.escHtml(preview.url)}" target="_blank" rel="noopener" class="link-preview" style="display:block;margin-top:8px;background:linear-gradient(180deg,#173027 0%,#102018 100%);border:1px solid #2f5548;border-left:4px solid #1da1f2;border-radius:8px;overflow:hidden;text-decoration:none;color:inherit;max-width:400px;padding:12px;box-shadow:0 2px 12px rgba(0,0,0,.35)">
          <div style="font-size:11px;color:#1da1f2;display:flex;align-items:center;gap:4px;margin-bottom:4px">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#1da1f2"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            X (Twitter)
          </div>
          <div style="font-weight:500;color:#dff5e8;font-size:13px">View post on X</div>
          <div style="font-size:12px;color:#85a89a;margin-top:4px">${UI.escHtml(preview.url)}</div>
        </a>
      `;
    }
    // Standard link preview
    else {
      // Detect SoundCloud (and other audio-capable URLs) so we can offer
      // the same Send-to-player affordance even when the server returned
      // a generic OG-card preview rather than a typed embed.
      const _u = String(preview.url || '');
      const _isSoundcloud = /(?:^|[\/\.])soundcloud\.com|on\.soundcloud\.com/i.test(_u);
      const _isYouTube = /(?:^|[\/\.])(?:youtube\.com|youtu\.be)/i.test(_u);
      const _isSpotify = /(?:^|[\/\.])open\.spotify\.com/i.test(_u);
      const _musicProvider = _isSoundcloud ? 'soundcloud' : (_isYouTube ? 'youtube' : (_isSpotify ? 'spotify' : null));
      const _sendBtn = _musicProvider ? _buildSendToPlayerBtn(_musicProvider) : '';
      html = `
        <a href="${UI.escHtml(preview.url)}" target="_blank" rel="noopener" class="link-preview" style="display:block;margin-top:8px;background:linear-gradient(180deg,#173027 0%,#102018 100%);border:1px solid #2f5548;border-radius:8px;overflow:hidden;text-decoration:none;color:inherit;max-width:480px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.35)">
          ${preview.image ? `<img src="${UI.escHtml(preview.image)}" alt="" style="width:100%;max-height:260px;object-fit:cover" onerror="this.style.display='none'">` : ''}
          <div style="padding:10px;background:rgba(12,28,22,.52)">
            <div style="font-size:11px;color:#85a89a;display:flex;align-items:center;gap:4px;margin-bottom:4px">
              ${preview.favicon ? `<img src="${UI.escHtml(preview.favicon)}" style="width:14px;height:14px;border-radius:2px" onerror="this.style.display='none'">` : ''}
              <span style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${UI.escHtml(preview.site_name || '')}</span>
              ${_sendBtn}
            </div>
            ${preview.title ? `<div style="font-weight:600;color:#dff5e8;margin-bottom:4px;font-size:14px">${UI.escHtml(preview.title)}</div>` : ''}
            ${preview.description ? `<div style="font-size:12px;color:#85a89a;line-height:1.4">${UI.escHtml(preview.description.substring(0, 150))}${preview.description.length > 150 ? '…' : ''}</div>` : ''}
          </div>
        </a>
      `;
    }
    
    // Capture scroll position BEFORE insertion — once we add the iframe
    // wrapper its padding-bottom:56.25% box immediately bumps scrollHeight
    // by ~270px, which would make the post-insert "near bottom" check
    // always read false and skip the auto-snap.
    const _scrollArea = document.getElementById('messages-area');
    const _wasNearBottomBefore = _scrollArea
      ? (_scrollArea.scrollHeight - _scrollArea.scrollTop - _scrollArea.clientHeight) < 240
      : false;

    body.insertAdjacentHTML('beforeend', html);

    // Discord-style "X" to suppress the embed.
    //
    // Subtle: the standard preview is an <a target="_blank"> so a child
    // <button> click would race the anchor's navigation (mousedown/click
    // default action triggers _blank window in some browsers BEFORE our
    // preventDefault runs). To make the X bulletproof we wrap the freshly
    // inserted embed in a sibling-positioned div and append the button
    // *outside* the anchor — no e.preventDefault gymnastics needed.
    //
    // We also walk every cached room (not just State.currentRoom) so a
    // race between appendMessage's State.messages.push and this code can't
    // hide the button.
    try {
      let cached = null;
      for (const arr of Object.values(State.messages || {})) {
        if (Array.isArray(arr)) {
          const m = arr.find(x => x && +x.id === +msgId);
          if (m) { cached = m; break; }
        }
      }
      const isOwn = cached && State.user && cached.nickname === State.user.nickname;
      if (isOwn) {
        const newEmbed = body.querySelector(':scope > .link-preview:last-child, :scope > .yt-embed:last-child, :scope > .spotify-embed:last-child');
        if (newEmbed && !newEmbed.parentElement?.classList.contains('preview-wrap')) {
          const wrap = document.createElement('div');
          wrap.className = 'preview-wrap';
          newEmbed.parentNode.insertBefore(wrap, newEmbed);
          wrap.appendChild(newEmbed);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'preview-suppress-btn';
          btn.title = 'Remove preview';
          btn.setAttribute('aria-label', 'Remove preview');
          btn.textContent = '\u00d7';
          // Belt + braces: stop every navigation-triggering event before
          // it reaches the embed's <a target="_blank">.
          const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
          btn.addEventListener('mousedown', swallow, true);
          btn.addEventListener('pointerdown', swallow, true);
          btn.addEventListener('touchstart', swallow, { capture: true, passive: false });
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            suppressPreview(msgId);
          }, true);
          wrap.appendChild(btn);
        }
      }
    } catch {}

    // Embeds load asynchronously (iframes, og:image, favicons), so the
    // message bubble grows in size *after* it has been appended. If the
    // user was reading the bottom of the chat the embed pushes the text
    // off-screen — re-snap to bottom whenever a fresh embed lands or one
    // of its images finishes loading.
    try {
      const area = _scrollArea;
      if (area && _wasNearBottomBefore) {
        const snap = () => { area.scrollTop = area.scrollHeight; };
        requestAnimationFrame(() => { snap(); requestAnimationFrame(snap); });
        // Re-snap after each <img>/<iframe> in the new embed reports
        // its final size — those events fire well after insertion.
        const newEmbed = body.querySelector(':scope > .link-preview:last-child, :scope > .yt-embed:last-child, :scope > .spotify-embed:last-child, :scope > .preview-wrap:last-child');
        if (newEmbed) {
          newEmbed.querySelectorAll('img,iframe').forEach(el => {
            const onReady = () => { area.scrollTop = area.scrollHeight; };
            el.addEventListener('load', onReady, { once: true });
            el.addEventListener('error', onReady, { once: true });
          });
        }
      }
    } catch {}
  }

  function _reactionHtml(reactions, msgId) {
    if (!reactions || typeof reactions === 'string') return '';
    const entries = typeof reactions === 'object' && !Array.isArray(reactions)
      ? Object.entries(reactions)
      : [];
    if (!entries.length) return '';
    return `<div class="msg-reactions" id="reactions-${msgId}">
      ${entries.map(([emoji, count]) =>
        `<span class="reaction-pill" onclick="Messages.toggleReaction(${msgId},'${UI.escHtml(emoji)}')">${emoji} ${count}</span>`
      ).join('')}
    </div>`;
  }

  function _buildMediaHtml(msg) {
    const time = UI.formatTime(msg.created_at);
    // View-once already consumed (media_data nulled on server)
    if (msg.view_once && !msg.media_data && !msg.has_media) {
      return '<div class="view-once-viewed">🔥 View Once — <em>already viewed</em></div>';
    }
    // Lazy-load: history messages have has_media but no media_data.
    // Previously the placeholder looked like a spoiler/"click to load" card; now
    // we render a compact auto-loading stub that fetches the real media as soon
    // as it scrolls into view (via _observeAutoLoad below).
    if (!msg.media_data && msg.has_media) {
      const kind = msg.media_type?.startsWith('video') ? '🎬'
                 : msg.media_type?.startsWith('audio') ? '🎵' : '🖼️';
      const blurAttr = msg.media_blur ? ' data-blur="1"' : '';
      return `<div class="media-lazy auto" id="media-lazy-${msg.id}" data-msg-id="${msg.id}" data-media-type="${UI.escHtml(msg.media_type || '')}" data-sender="${UI.escHtml(msg.nickname)}" data-time="${time}"${blurAttr}>
        <div class="media-lazy-placeholder media-lazy-auto" onclick="Messages.loadMedia(${msg.id})">
          <span class="media-lazy-icon" style="font-size:20px">${kind}</span>
          <span class="media-lazy-spinner" aria-hidden="true"></span>
          <span style="font-size:12px;color:#85a89a">Loading media…</span>
        </div>
      </div>`;
    }
    if (!msg.media_data) return '';

    // View-once: show tap-to-reveal button
    if (msg.view_once) {
      return `<div class="view-once-wrap" id="vo-${msg.id}"
        data-media="${UI.escHtml(msg.media_data)}"
        data-mtype="${UI.escHtml(msg.media_type || '')}"
        data-sender="${UI.escHtml(msg.nickname)}"
        data-time="${time}">
        <button class="view-once-btn" onclick="Messages.revealViewOnce(${msg.id})">🔥 View Once — Tap to Reveal</button>
      </div>`;
    }

    // Base media element
    let inner;
    if (msg.media_type?.startsWith('video')) {
      // Telegram-style "video note" hint travels via mime-type param so
      // the wrapper renders as a round bubble immediately (instead of
      // waiting on videoWidth/Height metadata which some Android cameras
      // resolve at non-square sizes despite the 480x480 constraint).
      const isNote = (msg.media_type || '').includes('videonote=1');
      const noteAttr = isNote ? ' data-video-note="1"' : '';
      const noteCls  = isNote ? ' is-note' : '';
      const preload  = isNote ? 'auto' : 'metadata';
      const badgeIco = isNote ? '🎥' : '🎬';
      const badgeLbl = isNote ? 'Note' : 'Video';
      // For video notes (recorded webm), don't put the giant base64 data: URL
      // in `src` — the WebView wedges decoding webm data: URLs at HTML-parse
      // time and never recovers. Stash it on `data-pending-src` so ChatVideo
      // can swap to a blob: URL synchronously before any load happens.
      const _vSrcAttr = isNote ? `data-pending-src="${msg.media_data}"` : `src="${msg.media_data}"`;
      if (msg.media_blur) {
        // Spoiler videos: skip the themed wrapper so the poster background
        // can't leak the thumbnail through the spoiler overlay.
        inner = `<video class="msg-media clickable-media" src="${msg.media_data}" data-sender="${UI.escHtml(msg.nickname)}" data-time="${time}" onclick="Messages.openMedia(this)" preload="metadata" controls muted playsinline></video>`;
      } else {
        // Themed inline player (ChatVideo in ui.js wires interaction).
        // The wrapper draws a real first-frame thumbnail and a brand-coloured
        // play button; native controls appear once the user starts playback.
        inner = `<div class="chat-video${noteCls}"${noteAttr} data-sender="${UI.escHtml(msg.nickname)}" data-time="${time}">`+
          `<div class="cv-poster"></div>`+
          `<video class="msg-media clickable-media" ${_vSrcAttr} data-sender="${UI.escHtml(msg.nickname)}" data-time="${time}" preload="${preload}" muted playsinline></video>`+
          `<div class="cv-loading"><div class="cv-spinner"></div></div>`+
          `<div class="cv-overlay"><div class="cv-play" aria-label="Play video" role="button"></div></div>`+
          `<div class="cv-badge"><span class="cv-icon">${badgeIco}</span><span class="cv-dur">${badgeLbl}</span></div>`+
        `</div>`;
      }
    } else if (msg.media_type?.startsWith('audio')) {
      const waveBars = Array.from({length:20}, () => `<div class="wave-bar" style="height:${4 + Math.random()*20}px"></div>`).join('');
      inner = `<div class="audio-msg" id="audio-${msg.id}" data-src="${msg.media_data}" data-sender="${UI.escHtml(msg.nickname)}" data-time="${time}">
        <button class="audio-play-btn" onclick="Messages.playInlineAudio(${msg.id},this,event)">▶</button>
        <div class="audio-waves">${waveBars}</div>
        <div class="audio-meta"><span class="audio-duration" id="audio-dur-${msg.id}">0:00</span></div>
      </div>`;
      _probeAudioDuration(msg.id, msg.media_data);
    } else {
      inner = `<img class="msg-media clickable-media" src="${msg.media_data}" alt="media" data-sender="${UI.escHtml(msg.nickname)}" data-time="${time}" onclick="Messages.openMedia(this)" loading="lazy">`;
    }

    // Spoiler blur (images/video only)
    if (msg.media_blur && !msg.media_type?.startsWith('audio')) {
      return `<div class="spoiler-wrap" id="sp-${msg.id}" onclick="Messages.revealSpoiler(${msg.id})">
        <div class="spoiler-overlay">👁️ Spoiler — Click to Reveal</div>
        <button type="button" class="spoiler-rehide" title="Hide spoiler" aria-label="Hide spoiler"
          onclick="event.stopPropagation();Messages.hideSpoiler(${msg.id})">👁️‍🗨️</button>
        ${inner.replace('class="msg-media', 'class="spoiler-img msg-media')}
      </div>`;
    }

    return inner;
  }

  // Subtle empty-state banner shown when a channel/DM has no messages yet.
  // Pure HTML, no event handlers — clicked through to the input. Content
  // is text-only and runs through UI.escHtml so a maliciously-named room
  // can't inject markup.
  function _emptyStateHtml(room) {
    const isDm = State.currentRoomType === 'dm' || (room && room.startsWith('dm:'));
    const peer = State.dmPeer || '';
    let title, subtitle;
    if (isDm && peer) {
      title = `This is the start of your conversation with ${peer}`;
      subtitle = 'Say hi — messages here are end-to-end encrypted.';
    } else {
      title = `Welcome to #${room || 'channel'}`;
      subtitle = 'No messages yet. Be the first to say something!';
    }
    return (
      `<div class="msg-empty-state" id="msg-empty-state" aria-hidden="true">` +
        `<div class="msg-empty-icon">💬</div>` +
        `<div class="msg-empty-title">${UI.escHtml(title)}</div>` +
        `<div class="msg-empty-sub">${UI.escHtml(subtitle)}</div>` +
      `</div>`
    );
  }

  function _forwardedBadgeHtml(msg) {
    if (!msg || !msg.forwarded_from) return '';
    let meta;
    try { meta = (typeof msg.forwarded_from === 'string') ? JSON.parse(msg.forwarded_from) : msg.forwarded_from; }
    catch { return ''; }
    if (!meta || typeof meta !== 'object') return '';
    const nick = UI.escHtml(String(meta.nick || '?'));
    const src  = UI.escHtml(String(meta.source_label || ''));
    return `<div class="msg-forwarded" style="font-size:11px;color:#9aa0a6;margin:2px 0 4px;padding:3px 6px;border-left:2px solid #5b8def;background:rgba(91,141,239,0.08);border-radius:3px">↪ Forwarded from <b>${nick}</b>${src ? ` in ${src}` : ''}</div>`;
  }

  let _forwardTargetsCache = null;
  let _forwardTargetsCacheAt = 0;
  const _forwardTargetsCacheTtlMs = 45000;

  function _isEncryptedPayloadString(v) {
    return typeof v === 'string' && v.startsWith('ftenc:');
  }

  async function _resolveForwardMediaData(msg, { sourceKind, sourceName, sourceId }) {
    let mediaData = (typeof msg.media_data === 'string' && msg.media_data) ? msg.media_data : '';
    let mediaType = String(msg.media_type || '');
    let mediaName = String(msg.media_name || '');
    const hasMedia = !!(mediaData || msg.has_media || mediaType);
    if (!hasMedia) return { ok: true, hasMedia: false };

    if (!mediaData && msg.id) {
      try {
        if (sourceKind === 'room') {
          const res = await apiFetch(`/api/messages/media/${msg.id}`);
          if (!res.ok) return { ok: false, error: 'Failed to load media for forwarding' };
          const data = await res.json();
          mediaData = String(data.media_data || '');
          mediaType = String(data.media_type || mediaType || '');
          mediaName = String(data.media_name || mediaName || '');
          if (_isEncryptedPayloadString(mediaData) && typeof Crypto !== 'undefined' && Crypto.decryptPayload) {
            const roomKey = (State.roomKeys && (State.roomKeys[sourceName] || State.roomKeys[State.currentRoom])) || null;
            const dec = await Crypto.decryptPayload(mediaData, roomKey);
            if (!dec) return { ok: false, error: 'Could not decrypt media for forwarding' };
            mediaData = dec;
          }
        } else if (sourceKind === 'dm' && sourceId) {
          const res = await apiFetch(`/api/dms/${sourceId}/messages/${msg.id}/media`);
          if (!res.ok) return { ok: false, error: 'Failed to load DM media for forwarding' };
          const data = await res.json();
          mediaData = String(data.media_data || '');
          mediaType = String(data.media_type || mediaType || '');
          mediaName = String(data.media_name || mediaName || '');
          if (_isEncryptedPayloadString(mediaData) && typeof Crypto !== 'undefined' && Crypto.decryptPayload) {
            const dec = await Crypto.decryptPayload(mediaData, STATE.sharedSecret || null);
            if (!dec) return { ok: false, error: 'Could not decrypt DM media for forwarding' };
            mediaData = dec;
          }
        }
      } catch {
        return { ok: false, error: 'Failed to prepare media for forwarding' };
      }
    }

    if (!mediaData) return { ok: false, error: 'Media payload unavailable for forwarding' };
    return {
      ok: true,
      hasMedia: true,
      media_data: mediaData,
      media_type: mediaType.slice(0, 120),
      media_name: mediaName.slice(0, 180),
      media_blur: msg.media_blur ? 1 : 0,
      view_once: msg.view_once ? 1 : 0,
    };
  }

  async function _buildForwardBody({ msg, sourceKind, sourceName, sourceId, fwdJSON }) {
    const body = {
      content: String(msg.content || ''),
      forwarded_from: fwdJSON,
    };

    const media = await _resolveForwardMediaData(msg, { sourceKind, sourceName, sourceId });
    if (!media.ok) return media;
    if (media.hasMedia) {
      body.media_data = media.media_data;
      body.media_type = media.media_type;
      body.media_name = media.media_name;
      body.media_blur = media.media_blur;
      body.view_once = media.view_once;
    }

    if (!body.content && !body.media_data) {
      return { ok: false, error: 'Nothing to forward' };
    }
    return { ok: true, body };
  }

  async function _roomForwardBody(targetRoom, baseBody) {
    const out = { ...baseBody };
    const key = State.roomKeys && State.roomKeys[targetRoom];
    const hasOutbound = !!(State.bridgeOut && State.bridgeOut[targetRoom]);
    // Encrypt forwarded payloads when the destination room has an E2EE key and
    // no known outbound bridge for that room.
    if (key && !hasOutbound && typeof Crypto !== 'undefined') {
      if (out.content && Crypto.encrypt) out.content = await Crypto.encrypt(out.content, key);
      if (out.media_data && Crypto.encryptPayload) out.media_data = await Crypto.encryptPayload(out.media_data, key);
    }
    return out;
  }

  async function _fetchForwardTargets(forceRefresh) {
    const fresh = _forwardTargetsCache && (Date.now() - _forwardTargetsCacheAt) < _forwardTargetsCacheTtlMs;
    if (!forceRefresh && fresh) return _forwardTargetsCache;

    let rooms = [], dms = [], friends = [];
    try {
      const [r1, r2, r3] = await Promise.all([
        apiFetch('/api/rooms'),
        apiFetch('/api/dms'),
        apiFetch('/api/friends')
      ]);
      try {
        const j1 = await r1.json();
        rooms = (j1.rooms || j1 || []).filter(r => r && r.name);
      } catch {}
      try {
        const j2 = await r2.json();
        dms = j2.channels || [];
      } catch {}
      try {
        const j3 = await r3.json();
        friends = j3.friends || [];
      } catch {}
    } catch {}

    const items = [];
    const dmNickSet = new Set();
    rooms.forEach(r => {
      if (r.forwarding_disabled) return;
      items.push({ key: 'r:' + r.name, kind: 'room', name: r.name, label: '#' + r.name, hint: r.description || '' });
    });
    dms.forEach(d => {
      if (d.forwarding_disabled) return;
      const peerRaw = d.other_nickname || d.nickname || d.other_user_nickname || d.peer_nickname || '';
      const peer = String(peerRaw || '').trim();
      // Only include DMs where we can identify the peer.
      // This keeps the forward picker meaningful and avoids ambiguous @?/DM # rows.
      if (!peer) return;
      dmNickSet.add(peer.toLowerCase());
      items.push({ key: 'd:' + d.id, kind: 'dm', id: d.id, label: '@' + peer, hint: '' });
    });
    friends.forEach(f => {
      const nick = String(f?.nickname || '').trim();
      if (!nick) return;
      if (dmNickSet.has(nick.toLowerCase())) return;
      const status = String(f?.status_msg || '').trim();
      const presence = String(f?.presence || '').trim();
      const hint = status || (presence ? ('Friend · ' + presence) : 'Friend');
      items.push({ key: 'f:' + nick.toLowerCase(), kind: 'friend', nickname: nick, label: '@' + nick, hint });
    });

    _forwardTargetsCache = items;
    _forwardTargetsCacheAt = Date.now();
    return items;
  }

  async function forwardMessage(msgId) {
    const list = State.messages[State.currentRoom] || [];
    const msg = list.find(m => +m.id === +msgId);
    if (!msg) { UI.toast?.('Message not found'); return; }
    await _openForwardPicker({
      sourceKind: 'room',
      sourceName: State.currentRoom,
      sourceLabel: '#' + State.currentRoom,
      msg,
    });
  }

  // Shared picker: opens modal listing rooms + DMs, multi-select, then sends.
  async function _openForwardPicker({ sourceKind, sourceName, sourceId, sourceLabel, msg }) {
    // Build modal
    const old = document.getElementById('forward-picker-modal');
    if (old) old.remove();
    const modal = document.createElement('div');
    modal.id = 'forward-picker-modal';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    const preview = (msg.content || '').slice(0, 120) || (msg.has_media || msg.media_type ? '[media]' : '');
    modal.innerHTML = `
      <div style="background:linear-gradient(180deg,#173027 0%,#13271f 56%,#102018 100%);border:1px solid #2f5548;border-radius:14px;width:min(460px,100%);max-height:85vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,.62)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #2f5548;background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,0))">
          <div style="font-weight:700;color:#cfe8d2;font-size:15px">↪ Forward message</div>
          <button id="fwd-cancel-x" style="background:none;border:none;color:#9bbf9b;font-size:18px;cursor:pointer;width:28px;height:28px;border-radius:6px" title="Close">✕</button>
        </div>
        <div style="padding:10px 14px;border-bottom:1px solid #24473b;font-size:12px;color:#9bbf9b;background:rgba(0,0,0,.2)">
          From <b style="color:#cfe8d2">${UI.escHtml(msg.nickname || '?')}</b>: <span style="color:#a8c4ad">${UI.escHtml(preview)}</span>
        </div>
        <div style="padding:10px 14px 4px">
          <input id="fwd-search" type="text" placeholder="Search channels, DMs, and friends…" style="width:100%;padding:9px 12px;background:rgba(0,0,0,.28);border:1px solid #2f5548;color:#dff5e8;border-radius:8px;outline:none;font-size:13px"/>
        </div>
        <div id="fwd-list" style="overflow-y:auto;flex:1;padding:4px 10px 10px;scrollbar-width:thin;scrollbar-color:rgba(76,175,80,.4) transparent;color:#d6ecda"></div>
        <div style="padding:12px 16px;border-top:1px solid #2f5548;display:flex;gap:8px;justify-content:flex-end;background:rgba(0,0,0,.2)">
          <button id="fwd-cancel" style="background:linear-gradient(180deg,#15291f,#11221b);border:1px solid #2f5548;color:#cfe8d2;padding:8px 16px;border-radius:8px;cursor:pointer;font-weight:600">Cancel</button>
          <button id="fwd-send" style="background:linear-gradient(135deg,#2a5a2a 0%,#1a3a1a 100%);border:1px solid #4caf50;color:#dff5e8;padding:8px 18px;border-radius:8px;cursor:pointer;font-weight:600;opacity:.5" disabled>Send</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const list = modal.querySelector('#fwd-list');
    const search = modal.querySelector('#fwd-search');
    const sendBtn = modal.querySelector('#fwd-send');
    const selected = new Map(); // key -> {kind,name?,id?,label}
    let items = [];
    let loading = true;

    function render() {
      const q = search.value.trim().toLowerCase();
      if (loading) {
        list.innerHTML = '<div style="padding:24px 18px;color:#9bbf9b;text-align:center;font-size:13px">Loading conversations…</div>';
        return;
      }
      const visible = items.filter(it => {
        if (!q) return true;
        const label = String(it.label || '').toLowerCase();
        const hint = String(it.hint || '').toLowerCase();
        return label.includes(q) || hint.includes(q);
      });
      if (!visible.length) { list.innerHTML = '<div style="padding:30px 20px;color:#85a89a;text-align:center;font-size:13px">No matches</div>'; return; }
      list.innerHTML = visible.map(it => {
        const checked = selected.has(it.key) ? 'checked' : '';
        const chosen = selected.has(it.key);
        const bg = chosen
          ? 'background:linear-gradient(135deg,rgba(76,175,80,.2),rgba(46,120,68,.16));border-color:rgba(127,210,167,.55);box-shadow:inset 0 0 0 1px rgba(127,210,167,.12);'
          : 'background:rgba(0,0,0,.2);border-color:rgba(58,107,72,.45);';
        const checkBg = chosen
          ? 'background:linear-gradient(135deg,#7fd2a7,#4caf50);border-color:#7fd2a7;color:#082114;'
          : 'background:rgba(0,0,0,.25);border-color:rgba(127,210,167,.45);color:transparent;';
        return `<label class="fwd-row" data-key="${UI.escHtml(it.key)}" style="${bg}display:flex;align-items:center;gap:10px;padding:9px 10px;margin-bottom:6px;border-radius:10px;border:1px solid #2f5548;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s">
          <input type="checkbox" data-key="${UI.escHtml(it.key)}" ${checked} style="position:absolute;opacity:0;pointer-events:none"/>
          <span aria-hidden="true" style="${checkBg}width:18px;height:18px;border:1px solid #2f5548;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;line-height:1;flex-shrink:0;transition:all .15s">✓</span>
          <span style="flex:1;min-width:0;color:#dff5e8;font-size:14px;display:flex;flex-direction:column;gap:2px">
            <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${UI.escHtml(it.label)}</span>
            ${it.hint ? `<span style="font-size:11px;color:#8db69b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${UI.escHtml(it.hint)}</span>` : ''}
          </span>
        </label>`;
      }).join('');
      list.querySelectorAll('.fwd-row').forEach(row => {
        row.addEventListener('mouseenter', () => {
          if (!selected.has(row.dataset.key)) {
            row.style.background = 'rgba(76,175,80,.08)';
            row.style.borderColor = 'rgba(76,175,80,.38)';
          }
        });
        row.addEventListener('mouseleave', () => {
          if (!selected.has(row.dataset.key)) {
            row.style.background = 'rgba(0,0,0,.2)';
            row.style.borderColor = 'rgba(58,107,72,.45)';
          }
        });
      });
      list.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', () => {
          const k = cb.dataset.key;
          const it = items.find(x => x.key === k);
          if (cb.checked) selected.set(k, it); else selected.delete(k);
          sendBtn.disabled = selected.size === 0;
          sendBtn.style.opacity = sendBtn.disabled ? '.5' : '1';
          // Re-render to refresh themed checkbox + selected row style.
          render();
        });
      });
    }
    render();
    search.addEventListener('input', render);
    modal.querySelector('#fwd-cancel').onclick = () => modal.remove();
    modal.querySelector('#fwd-cancel-x').onclick = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    // Open instantly, then hydrate targets async (uses short-lived cache).
    (async () => {
      const hasFreshCache = _forwardTargetsCache && (Date.now() - _forwardTargetsCacheAt) < _forwardTargetsCacheTtlMs;
      if (hasFreshCache) {
        items = _forwardTargetsCache.slice();
        loading = false;
        render();
      }
      try {
        const fresh = await _fetchForwardTargets(!hasFreshCache);
        if (!modal.isConnected) return;
        items = (fresh || []).slice();
      } catch {
        if (!modal.isConnected) return;
      } finally {
        if (!modal.isConnected) return;
        loading = false;
        render();
      }
    })();

    sendBtn.onclick = () => {
      const targets = Array.from(selected.values());
      if (!targets.length) return;
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      modal.remove();
      Promise.resolve().then(async () => {
        const fwdMeta = {
          nick: msg.nickname || '?',
          source_label: sourceLabel,
          kind: sourceKind,
          original_id: msg.id,
        };
        if (sourceKind === 'room') fwdMeta.source_name = sourceName;
        if (sourceKind === 'dm') fwdMeta.source_id = sourceId;
        const fwdJSON = JSON.stringify(fwdMeta);

        const built = await _buildForwardBody({ msg, sourceKind, sourceName, sourceId, fwdJSON });
        if (!built.ok) {
          UI.toast?.(built.error || 'Forward failed', 'error');
          return;
        }
        const baseBody = built.body;

        let okCount = 0, failCount = 0;
        let dmForwarded = false;
        for (const target of targets) {
          try {
            if (target.kind === 'room') {
              const body = await _roomForwardBody(target.name, baseBody);
              const r = await apiFetch(`/api/messages/${encodeURIComponent(target.name)}/send`, 'POST', {
                ...body,
              });
              if (r.ok) okCount++; else failCount++;
            } else if (target.kind === 'dm') {
              const r = await apiFetch(`/api/dms/${target.id}/messages`, 'POST', {
                ...baseBody,
              });
              if (r.ok) { okCount++; dmForwarded = true; } else failCount++;
            } else if (target.kind === 'friend') {
              const open = await apiFetch('/api/dms/open/' + encodeURIComponent(target.nickname), 'POST');
              if (!open.ok) { failCount++; continue; }
              const ch = await open.json().catch(() => ({}));
              const chId = Number(ch.channel_id || ch.id || 0);
              if (!chId) { failCount++; continue; }
              const r = await apiFetch(`/api/dms/${chId}/messages`, 'POST', {
                ...baseBody,
              });
              if (r.ok) { okCount++; dmForwarded = true; } else failCount++;
            } else {
              failCount++;
            }
          } catch { failCount++; }
        }
        if (dmForwarded && typeof loadDMChannels === 'function') {
          // Refresh in background so the forward dialog never appears stuck on
          // "Sending…" if /api/dms is slow.
          Promise.resolve().then(() => loadDMChannels()).catch(() => {});
        }
        if (okCount && !failCount) UI.toast?.(`Forwarded to ${okCount}`, 'success');
        else if (okCount && failCount) UI.toast?.(`Forwarded to ${okCount}, ${failCount} failed`, 'warn');
        else UI.toast?.('Forward failed', 'error');
      }).catch(() => {
        UI.toast?.('Forward failed', 'error');
      });
    };
    setTimeout(() => search.focus(), 50);
  }

  function _msgHtml(msg, isCont) {
    const isOwn = msg.nickname === State.user?.nickname;
    const isAdmin = msg.nickname === 'admin' || msg._is_admin;
    const time = UI.formatTime(msg.created_at);
    const editedTag = msg.edited ? '<span class="msg-edited">(edited)</span>' : '';
    const pinnedTag = msg.pinned ? '<span class="msg-pinned" style="color:#4caf50;font-size:11px;margin-left:4px">📌</span>' : '';
    // Muted-user collapse: if this author is on the local mute list, render a
    // tiny click-to-reveal placeholder instead of the real content/media.
    const isMutedAuthor = !isOwn && typeof Mute !== 'undefined' && Mute.isUserMuted(msg.nickname);
    const contentHtml = msg.content ? _formatContent(msg.content) : '<em style="color:#444">Media</em>';
    const mediaHtml = _buildMediaHtml(msg);
    const fwdBadge = _forwardedBadgeHtml(msg);

    // Pin button only shows in rooms (not DMs) AND only for users who can
    // actually pin — owners, mods, or global admins. Showing it to regular
    // members just produced a 403 toast when they tried.
    const isRoomOwner = State.currentRoomOwner === State.user?.nickname;
    const isRoomMod = Array.isArray(State.currentRoomMods) && State.currentRoomMods.includes(State.user?.nickname);
    const canModerateHere = (isRoomOwner || isRoomMod || State.user?.is_admin) && State.currentRoomType !== 'dm';
    const canPin = canModerateHere;
    // Edit: only the author can edit their own message. Global admins may edit
    // for moderation. Room owners / mods CANNOT edit other users' messages —
    // they can only delete.
    const canEdit = isOwn || State.user?.is_admin;
    const canDelete = isOwn || State.user?.is_admin || isRoomOwner || isRoomMod;
    const showAdminControls = State.user?.is_admin && !isOwn;
    // Owner/mod can kick/ban other users (not themselves or the owner)
    const showOwnerModControls = !isOwn && canModerateHere && !State.user?.is_admin
      && msg.nickname !== State.currentRoomOwner;
    const adminActions = showAdminControls ? `
        <span class="msg-mod-inline">
          <button class="msg-act-btn" title="Kick" onclick="adminKick('${UI.escHtml(msg.nickname)}')" style="color:#ff9800">👢</button>
          <button class="msg-act-btn" title="Mute" onclick="adminMute('${UI.escHtml(msg.nickname)}')" style="color:#ff9800">🔇</button>
          <button class="msg-act-btn danger" title="Ban" onclick="adminBan('${UI.escHtml(msg.nickname)}')">🚫</button>
        </span>
        <button class="msg-act-btn msg-mod-more" title="Moderation" onclick="Messages.openModMenu(event,'${UI.escHtml(msg.nickname)}',${msg.user_id||'null'},'admin')">⋯</button>` : '';
    const ownerModActions = showOwnerModControls ? `
        <span class="msg-mod-inline">
          <button class="msg-act-btn" title="Kick from channel (5 min)" onclick="roomKick('${UI.escHtml(msg.nickname)}',${msg.user_id||'null'})" style="color:#ff9800">👢</button>
          <button class="msg-act-btn danger" title="Ban from channel" onclick="roomBan('${UI.escHtml(msg.nickname)}',${msg.user_id||'null'})">🚫</button>
        </span>
        <button class="msg-act-btn msg-mod-more" title="Moderation" onclick="Messages.openModMenu(event,'${UI.escHtml(msg.nickname)}',${msg.user_id||'null'},'room')">⋯</button>` : '';
    const actions = `
      <div class="msg-actions">
        <button class="msg-act-btn" title="Reply" data-rid="${msg.id}" data-rnick="${UI.escHtml(msg.nickname)}" data-rtxt="${UI.escHtml((msg.content||'').substring(0,80))}" onclick="Messages.setReplyTo(+this.dataset.rid,this.dataset.rnick,this.dataset.rtxt)">↩️</button>
        <button class="msg-act-btn" title="React" onclick="Messages.showReactMenu(${msg.id}, this)">😀</button>
        <button class="msg-act-btn" title="Copy" onclick="Messages.copyMessage(${msg.id})">📋</button>
        ${State.currentRoomForwardingDisabled ? '' : `<button class="msg-act-btn" title="Forward" onclick="Messages.forwardMessage(${msg.id})">📤</button>`}
        ${canPin ? `<button class="msg-act-btn" title="Pin" onclick="pinMessage(${msg.id})">📌</button>` : ''}
        ${canEdit ? `<button class="msg-act-btn" title="Edit" onclick="Messages.startEdit(${msg.id})">✏️</button>` : ''}
        ${canDelete ? `<button class="msg-act-btn danger" title="Delete" onclick="Messages.deleteMsg(${msg.id})">🗑️</button>` : ''}
        ${ownerModActions}
        ${adminActions}
      </div>
      <button class="msg-more-trigger" title="Message options" aria-label="Message options" onclick="event.stopPropagation();Messages.openActionSheet(${msg.id})">⋯</button>
    `;

    const replyQuote = msg.reply_to ? `<div class="msg-reply-quote" onclick="document.getElementById('msg-${msg.reply_to}')?.scrollIntoView({behavior:'smooth',block:'center'})">
      <span class="reply-quote-nick">${UI.escHtml(msg.reply_nickname || '?')}</span>
      <span class="reply-quote-text">${UI.escHtml((msg.reply_content || 'Media').substring(0, 80))}</span>
    </div>` : '';

    if (isCont) {
      if (isMutedAuthor) {
        return `<div class="msg-cont is-muted-user" id="msg-${msg.id}">
          <div class="msg-cont-wrap">
            <div style="flex:1;min-width:0">
              <div class="msg-muted-placeholder" onclick="muteRevealMessage(${msg.id})">
                🔕 Muted message from <b>${UI.escHtml(msg.nickname)}</b> — tap to show
              </div>
              <div class="msg-muted-hidden" style="display:none">
                ${replyQuote}
                <div class="msg-content">${contentHtml}</div>
                ${mediaHtml}
                ${_reactionHtml(msg.reactions, msg.id)}
              </div>
            </div>
            ${actions}
          </div>
        </div>`;
      }
      return `<div class="msg-cont" id="msg-${msg.id}">
        <div class="msg-cont-wrap">
          <div style="flex:1;min-width:0">
            ${replyQuote}
            ${fwdBadge}
            <div class="msg-content">${contentHtml}</div>
            ${mediaHtml}
            ${_reactionHtml(msg.reactions, msg.id)}
          </div>
          ${actions}
        </div>
      </div>`;
    }

    if (isMutedAuthor) {
      return `<div class="msg-group is-muted-user" id="msg-${msg.id}" data-nick="${UI.escHtml(msg.nickname||'')}">
        <div class="msg-avatar" data-nick="${UI.escHtml(msg.nickname||'')}" data-bridge="${UI.escHtml(msg.bridge_platform||'')}" onclick="showUserInfo('${UI.escHtml(msg.nickname)}',${msg.user_id||'null'},'${UI.escHtml(msg.bridge_platform||'')}','${UI.escHtml(msg.bridge_source_name||'')}','${UI.escHtml(msg.bridge_source_id||'')}','${UI.escHtml(msg.bridge_source_parent||'')}','${UI.escHtml(msg.avatar||'')}')">${UI.avatarEl(msg.avatar, msg.nickname, 38)}</div>
        <div class="msg-body">
          <div class="msg-meta">
            <span class="msg-author" onclick="showUserInfo('${UI.escHtml(msg.nickname)}',${msg.user_id||'null'},'${UI.escHtml(msg.bridge_platform||'')}','${UI.escHtml(msg.bridge_source_name||'')}','${UI.escHtml(msg.bridge_source_id||'')}','${UI.escHtml(msg.bridge_source_parent||'')}','${UI.escHtml(msg.avatar||'')}')">${UI.escHtml(msg.display_name || msg.nickname)}</span>${msg.display_name && msg.display_name !== msg.nickname ? `<span class="msg-author-handle">@${UI.escHtml(msg.nickname)}</span>` : ''}
            ${_bridgeBadge(msg)}
            <span class="msg-time">${time}</span>
          </div>
          <div class="msg-muted-placeholder" onclick="muteRevealMessage(${msg.id})">
            🔕 Muted — tap to show message
          </div>
          <div class="msg-muted-hidden" style="display:none">
            ${replyQuote}
            <div class="msg-content">${contentHtml}</div>
            ${mediaHtml}
            ${_reactionHtml(msg.reactions, msg.id)}
          </div>
        </div>
        ${actions}
      </div>`;
    }

    return `<div class="msg-group" id="msg-${msg.id}" data-nick="${UI.escHtml(msg.nickname||'')}">
      <div class="msg-avatar" data-nick="${UI.escHtml(msg.nickname||'')}" data-bridge="${UI.escHtml(msg.bridge_platform||'')}" onclick="showUserInfo('${UI.escHtml(msg.nickname)}',${msg.user_id||'null'},'${UI.escHtml(msg.bridge_platform||'')}','${UI.escHtml(msg.bridge_source_name||'')}','${UI.escHtml(msg.bridge_source_id||'')}','${UI.escHtml(msg.bridge_source_parent||'')}','${UI.escHtml(msg.avatar||'')}')">${UI.avatarEl(msg.avatar, msg.nickname, 38)}</div>
      <div class="msg-body">
        <div class="msg-meta">
          <span class="msg-author${isAdmin ? ' admin' : ''}" onclick="showUserInfo('${UI.escHtml(msg.nickname)}',${msg.user_id||'null'},'${UI.escHtml(msg.bridge_platform||'')}','${UI.escHtml(msg.bridge_source_name||'')}','${UI.escHtml(msg.bridge_source_id||'')}','${UI.escHtml(msg.bridge_source_parent||'')}','${UI.escHtml(msg.avatar||'')}')">${isAdmin ? '👑 ' : ''}${UI.escHtml(msg.display_name || msg.nickname)}</span>${msg.display_name && msg.display_name !== msg.nickname ? `<span class="msg-author-handle">@${UI.escHtml(msg.nickname)}</span>` : ''}
          ${_bridgeBadge(msg)}
          <span class="msg-time">${time}</span>
          ${editedTag}
          ${pinnedTag}
        </div>
        ${replyQuote}
        ${fwdBadge}
        <div class="msg-content">${contentHtml}</div>
        ${mediaHtml}
        ${_reactionHtml(msg.reactions, msg.id)}
      </div>
      ${actions}
    </div>`;
  }

  function _shouldContinue(msg) {
    // Same author AND same origin (native vs bridged-from-Telegram/Discord/etc).
    // Without the bridge check, a real account whose nickname matches the
    // bridge label (or a user posting right after their own bridged message)
    // gets rendered as a header-less continuation, hiding their avatar /
    // username / timestamp.
    const curBridge = msg.bridge_platform || null;
    return msg.nickname === _lastNick && curBridge === _lastBridge;
  }

  function _dateChanged(msg) {
    const d = UI.formatDate(msg.created_at);
    if (d !== _lastDate) { _lastDate = d; return d; }
    return null;
  }

  function loadHistory(room, msgs) {
    if (room !== State.currentRoom) return;
    const area = document.getElementById('messages-area');
    _lastNick = null;
    _lastBridge = null;
    _lastDate = null;
    // Reset room cache before rebuilding so repeated loadHistory calls
    // (switching back to a room, WS re-sync, cached re-render) don't duplicate.
    State.messages[room] = [];

    // Empty channel/DM: render a subtle, non-interactive system note so the
    // chat doesn't look broken on first open. The note is replaced by real
    // content as soon as anything arrives (see appendMessage below).
    if (!msgs || msgs.length === 0) {
      area.innerHTML = _emptyStateHtml(room);
      area.scrollTop = area.scrollHeight;
      return;
    }

    let html = '';
    const urlRe = /https?:\/\/[^\s<>"]+/g;
    const linksToPreview = [];
    
    msgs.forEach(msg => {
      // Hide messages from blocked authors (client-side filter; server also
      // enforces blocks in DMs/feed/comments). Own messages always show.
      if (msg.nickname && State.blockedNicks &&
          msg.nickname.toLowerCase() !== (State.user?.nickname || '').toLowerCase() &&
          State.blockedNicks.has(msg.nickname.toLowerCase())) {
        return;
      }
      const dateLabel = _dateChanged(msg);
      if (dateLabel) {
        html += `<div class="msg-date-divider">${UI.escHtml(dateLabel)}</div>`;
        _lastNick = null;
        _lastBridge = null;
      }
      const isCont = _shouldContinue(msg);
      html += _msgHtml(msg, isCont);
      _lastNick = msg.nickname;
      _lastBridge = msg.bridge_platform || null;

      State.messages[room].push(msg);
      
      // Collect URLs for link previews (skip invite URLs — rendered as cards,
      // and skip Frog Social profile/post/reel URLs — rendered as our own cards).
      const urls = (msg.content || '').match(urlRe);
      if (urls && urls.length) {
        const firstUrl = urls[0];
        const isInvite = /\/(?:invite|i)\/[A-Za-z0-9_-]{2,32}/.test(firstUrl);
        const isSocial = !!_parseFrogSocialUrl(firstUrl);
        // Always strip our own (frogtalk.xyz / frogtalk.app) OG previews —
        // invite/profile/post/reel URLs hydrate as native cards, and bare
        // self-links shouldn't echo a redundant OG card next to themselves.
        const isSelf = /^https?:\/\/(?:www\.)?frogtalk\.(?:xyz|app)\b/i.test(firstUrl);
        if (!isInvite && !isSocial && !isSelf && !msg.preview_suppressed) linksToPreview.push({ id: msg.id, url: firstUrl });
      }
    });

    area.innerHTML = html;
    area.scrollTop = area.scrollHeight;
    if (msgs.length) State.oldestMsgId = msgs[0].id;
    bindLongPress(area);
    observeLazyMedia(area);

    // Robust scroll-to-bottom: keep pinning to the bottom as long as new content
    // (media, link previews, embeds, reactions) keeps growing the area, for up
    // to 8 seconds. This fixes the mobile problem where late-loading media
    // strands the user mid-history.
    const forceBottom = () => { area.scrollTop = area.scrollHeight; };
    forceBottom();
    requestAnimationFrame(() => { forceBottom(); requestAnimationFrame(forceBottom); });

    const openedAt = Date.now();
    const WINDOW_MS = 8000;
    let userScrolled = false;
    const onUserScroll = () => {
      // User intentionally scrolled up — stop auto-pinning.
      const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 120;
      if (!nearBottom) userScrolled = true;
    };
    area.addEventListener('wheel', onUserScroll, { passive: true });
    area.addEventListener('touchmove', onUserScroll, { passive: true });

    const ro = (typeof ResizeObserver !== 'undefined')
      ? new ResizeObserver(() => {
          if (userScrolled) return;
          if (Date.now() - openedAt > WINDOW_MS) { ro.disconnect(); return; }
          forceBottom();
        })
      : null;
    if (ro) ro.observe(area);

    // Also listen for per-element media loads — covers late images/videos even
    // if ResizeObserver is unavailable.
    try {
      area.querySelectorAll('img,video').forEach(el => {
        const onLoad = () => {
          if (userScrolled) return;
          if (Date.now() - openedAt < WINDOW_MS) forceBottom();
        };
        el.addEventListener('load', onLoad, { once: true });
        el.addEventListener('loadedmetadata', onLoad, { once: true });
      });
    } catch {}

    // Staggered fallbacks for environments without ResizeObserver.
    [120, 400, 900, 1800, 3500, 6000].forEach(ms =>
      setTimeout(() => { if (!userScrolled) forceBottom(); }, ms)
    );

    // Clean up the observer + scroll listener after the window closes.
    setTimeout(() => {
      try { ro?.disconnect(); } catch {}
      try {
        area.removeEventListener('wheel', onUserScroll);
        area.removeEventListener('touchmove', onUserScroll);
      } catch {}
    }, WINDOW_MS + 200);

    // Load link previews for messages (limit to last 5)
    linksToPreview.slice(-5).forEach(({ id, url }) => {
      setTimeout(() => _loadLinkPreview(id, url), 100);
    });

    // Load invite + Frog Social cards
    const area2 = document.getElementById('messages-area');
    if (area2) {
      area2.querySelectorAll('[id^="msg-"]').forEach(msgEl => {
        const msgId = msgEl.id.replace('msg-', '');
        if (msgId) setTimeout(() => _hydrateSpecialCards(msgId), 150);
      });
    }
  }

  function appendMessage(room, msg) {
    // Block filter: drop incoming messages from blocked users completely.
    if (msg && msg.nickname && State.blockedNicks &&
        msg.nickname.toLowerCase() !== (State.user?.nickname || '').toLowerCase() &&
        State.blockedNicks.has(msg.nickname.toLowerCase())) {
      return;
    }
    // Muted room: don't bump unread counters; still render if it's the active room.
    const roomMuted = typeof Mute !== 'undefined' && Mute.isRoomMuted(room);
    if (room !== State.currentRoom) {
      if (roomMuted) return; // silent — no unread badge, no render
      // Mark channel unread with a numeric counter (Discord-style)
      State._unreadRooms = State._unreadRooms || {};
      State._unreadRooms[room] = (State._unreadRooms[room] || 0) + 1;
      const el = document.querySelector(`[data-room="${room}"]`);
      if (el) {
        // Add a left-side pip so unread rooms stand out even when badge hidden
        el.classList.add('has-unread');
        let badge = el.querySelector('.unread-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'unread-badge';
          el.appendChild(badge);
        }
        const n = State._unreadRooms[room];
        badge.textContent = n > 99 ? '99+' : String(n);
      }
      return;
    }

    // Reconcile optimistic pending message from this client with the server
    // echo in-place so it never disappears before becoming delivered.
    let _reconciled = false;
    try {
      const isOwnIncoming = !!(msg && State.user && msg.nickname === State.user.nickname && !msg._pending);
      if (isOwnIncoming) {
        const area = document.getElementById('messages-area');
        const nonce = String(msg.client_nonce || '').trim();
        let pendingEl = null;
        if (nonce) {
          pendingEl = area?.querySelector('.msg-pending[data-nonce="' + nonce + '"]') || null;
        }
        // Fallback when nonce is missing in an edge path.
        if (!pendingEl) {
          pendingEl = area?.querySelector('.msg-pending[data-own="1"]') || null;
        }
        if (pendingEl) {
          _reconciled = true; // Guard: even if work below throws, the catch must not fall through to a second bubble.
          // Capture the optimistic temp id BEFORE we rename the element so we
          // can rewrite all the inline onclick handlers / data-rid attributes
          // that were rendered with the negative temp id. Without this, the
          // ⋯ menu button (and Reply/Edit/Delete) still target the temp id
          // and the action sheet pops up empty until the user navigates away
          // and back to force a full re-render.
          let tempId = null;
          try {
            const m = /^msg-(-?\d+)$/.exec(pendingEl.id || '');
            if (m) tempId = m[1];
          } catch {}
          pendingEl.classList.remove('msg-pending');
          pendingEl.removeAttribute('data-own');
          pendingEl.removeAttribute('data-nonce');
          pendingEl.id = `msg-${msg.id}`;
          // Rewrite any onclick / data-rid that referenced the temp id so the
          // ⋯ menu, Reply, Edit, Delete, React, Copy buttons all work right
          // away on this freshly-reconciled bubble.
          if (tempId !== null && String(msg.id) !== tempId) {
            try {
              const realId = String(msg.id);
              pendingEl.querySelectorAll('[onclick],[data-rid]').forEach(node => {
                const oc = node.getAttribute('onclick');
                if (oc && oc.includes(tempId)) {
                  // Replace bare-number occurrences only (avoid touching
                  // unrelated digits inside string literals like usernames).
                  node.setAttribute('onclick', oc.split('(' + tempId).join('(' + realId)
                                                .split(',' + tempId).join(',' + realId)
                                                .split(' ' + tempId).join(' ' + realId));
                }
                const rid = node.getAttribute('data-rid');
                if (rid === tempId) node.setAttribute('data-rid', realId);
              });
            } catch {}
          }
          // The pending render may have already hoisted a share-card row
          // (.msg-share-row with the loaded embed) ABOVE .msg-content. We
          // are about to rebuild .msg-content's innerHTML which produces a
          // fresh placeholder inside the text — without removing the old
          // hoisted row first, _hydrateSpecialCards will hoist the new
          // placeholder above the old row and we end up rendering the
          // social embed TWICE (https://… post link in chat).
          try {
            const body = pendingEl.querySelector('.msg-body') || pendingEl;
            body.querySelectorAll(':scope > .msg-share-row').forEach(r => r.remove());
          } catch {}
          const contentEl = pendingEl.querySelector('.msg-content');
          if (contentEl) contentEl.innerHTML = _formatContent(msg.content || '');
          const timeEl = pendingEl.querySelector('.msg-time');
          if (timeEl) timeEl.textContent = UI.formatTime(msg.created_at);
          // Optimistic bubble had no media (temp msg always sets media_data:null);
          // when the server echo includes media, inject it now or it never renders.
          try {
            if (msg.media_data || msg.has_media) {
              const body = pendingEl.querySelector('.msg-body') || pendingEl.querySelector('.msg-cont-wrap > div') || pendingEl;
              const hasMedia = body.querySelector(':scope > .msg-media, :scope > .audio-msg, :scope > .chat-video, :scope > .spoiler-wrap, :scope > .view-once-wrap, :scope > .media-lazy');
              if (!hasMedia) {
                const mediaHtml = _buildMediaHtml(msg);
                if (mediaHtml) {
                  const anchor = body.querySelector(':scope > .msg-content');
                  if (anchor) anchor.insertAdjacentHTML('afterend', mediaHtml);
                  else body.insertAdjacentHTML('beforeend', mediaHtml);
                  // If the echo only carried `has_media` (server stripped
                  // media_data from the broadcast), kick off the fetch now
                  // so it loads live instead of being stuck on "Loading
                  // media…" until the user changes channels.
                  if (!msg.media_data && msg.has_media) {
                    setTimeout(() => loadMedia(msg.id), 50);
                  }
                }
              }
            }
          } catch {}
          _attachLongPress(pendingEl, msg.id);
          const urlRe = /https?:\/\/[^\s<>"]+/g;
          const urls = (msg.content || '').match(urlRe);
          if (urls && urls.length) {
            const firstUrl = urls[0];
            const isInvite = /\/(?:invite|i)\/[A-Za-z0-9_-]{2,32}/.test(firstUrl);
            const isSocial = !!_parseFrogSocialUrl(firstUrl);
            const isSelf = /^https?:\/\/(?:www\.)?frogtalk\.(?:xyz|app)\b/i.test(firstUrl);
            if (!isInvite && !isSocial && !isSelf && !msg.preview_suppressed) setTimeout(() => _loadLinkPreview(msg.id, firstUrl), 100);
          }
          setTimeout(() => _hydrateSpecialCards(msg.id), 100);
          const cached = State.messages[room] || [];
          const idx = cached.findIndex(m => m && m._pending && (nonce ? m._nonce === nonce : true));
          if (idx >= 0) cached[idx] = msg;
          else cached.push(msg);
          return;
        }
      }
    } catch {}
    // Safety: if an exception was thrown after we started reconciling the
    // pending bubble (e.g. a throw inside the DOM-rewrite helpers), swallow
    // it but still return so we never render a second bubble for the same msg.
    if (_reconciled) return;

    // Dedup: if a bubble for this message id already exists (e.g. history
    // reload races a WS echo, or two WS connections both deliver the same
    // server broadcast), skip creating a second identical bubble.
    if (msg.id && !msg._pending && document.getElementById(`msg-${msg.id}`)) return;

    const area = document.getElementById('messages-area');
    // "At bottom" with a generous threshold so tiny composer-height shifts /
    // reply preview / attachment preview don't flip us into "user scrolled up".
    const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 220;
    // Always auto-scroll when it's OUR own message — user clearly wants to
    // see their send land, even if they were a bit scrolled up while composing.
    const isOwn = msg.nickname && State.user && msg.nickname === State.user.nickname;

    // Clear the empty-state placeholder the moment any real message arrives.
    const emptyEl = area.querySelector('#msg-empty-state');
    if (emptyEl) emptyEl.remove();

    const dateLabel = _dateChanged(msg);
    let html = '';
    if (dateLabel) {
      html += `<div class="msg-date-divider">${UI.escHtml(dateLabel)}</div>`;
      _lastNick = null;
      _lastBridge = null;
    }
    const isCont = _shouldContinue(msg);
    html += _msgHtml(msg, isCont);
    _lastNick = msg.nickname;
    _lastBridge = msg.bridge_platform || null;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    while (wrapper.firstChild) area.appendChild(wrapper.firstChild);

    if (!State.messages[room]) State.messages[room] = [];
    State.messages[room].push(msg);

    const newEl = document.getElementById(`msg-${msg.id}`);
    if (newEl && !msg._pending) _attachLongPress(newEl, msg.id);

    if (atBottom || isOwn) {
      // Double-rAF so late-loading media/embeds (images decoding, link
      // previews resolving) can't strand us mid-scroll.
      const snap = () => { area.scrollTop = area.scrollHeight; };
      snap();
      requestAnimationFrame(() => { snap(); requestAnimationFrame(snap); });
      // Also re-snap once the new message's own media decodes.
      if (newEl && isOwn) {
        newEl.querySelectorAll('img,video').forEach(el => {
          el.addEventListener('load', snap, { once: true });
          el.addEventListener('loadedmetadata', snap, { once: true });
        });
      }
      // Hide the "jump to latest" pip if visible.
      try { _setJumpPipVisible(false); } catch {}
    } else {
      // User is scrolled up — surface a subtle "jump to latest" pip.
      try { _setJumpPipVisible(true); } catch {}
    }

    // Auto-load media for new real-time messages (lazy-load placeholders)
    if (msg.has_media && msg.id) {
      setTimeout(() => loadMedia(msg.id), 100);
    }
    
    // Load link preview for this message
    const urlRe = /https?:\/\/[^\s<>"]+/g;
    const urls = (msg.content || '').match(urlRe);
    if (urls && urls.length) {
      const firstUrl = urls[0];
      const isInvite = /\/invite\/[A-Za-z0-9]{6,16}/.test(firstUrl);
      const isSocial = !!_parseFrogSocialUrl(firstUrl);
      if (!isInvite && !isSocial && !msg.preview_suppressed) setTimeout(() => _loadLinkPreview(msg.id, firstUrl), 200);
    }
    setTimeout(() => _hydrateSpecialCards(msg.id), 200);
  }

  function updateEdited(id, content, room) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    // Strip any previously hoisted share-card rows so editing a message
    // that contains a /p/<id> link doesn't double up the embed (see
    // pending-replace path for the same fix).
    try {
      const body = el.querySelector('.msg-body') || el;
      body.querySelectorAll(':scope > .msg-share-row').forEach(r => r.remove());
    } catch {}
    const contentEl = el.querySelector('.msg-content');
    if (contentEl) contentEl.innerHTML = _formatContent(content);
    const meta = el.querySelector('.msg-meta');
    if (meta && !meta.querySelector('.msg-edited')) {
      meta.insertAdjacentHTML('beforeend', '<span class="msg-edited">(edited)</span>');
    }
    const urlRe = /https?:\/\/[^\s<>"]+/g;
    const urls = (content || '').match(urlRe);
    if (urls && urls.length) {
      const firstUrl = urls[0];
      const isInvite = /\/invite\/[A-Za-z0-9]{6,16}/.test(firstUrl);
      const isSocial = !!_parseFrogSocialUrl(firstUrl);
      if (!isInvite && !isSocial) setTimeout(() => _loadLinkPreview(id, firstUrl), 120);
    }
    setTimeout(() => _hydrateSpecialCards(id), 120);
  }

  function removeMessage(id) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    // If we're deleting a header message (msg-group) that is followed by one
    // or more continuations (msg-cont from the same author), the first of those
    // continuations must be re-rendered as a full header so the author/avatar/
    // timestamp doesn't vanish from the thread.
    const wasHeader = el.classList.contains('msg-group');
    const next = el.nextElementSibling;
    el.remove();
    if (wasHeader && next && next.classList.contains('msg-cont')) {
      const nextId = +(next.id || '').replace('msg-', '');
      const cache = State.messages?.[State.currentRoom] || [];
      const msg = cache.find(m => m.id === nextId);
      if (msg) {
        // Force a standalone render (no continuation) so meta shows again.
        const temp = document.createElement('div');
        temp.innerHTML = _msgHtml(msg, false);
        const rebuilt = temp.firstElementChild;
        if (rebuilt) next.replaceWith(rebuilt);
      }
    }
  }

  function updateReactions(id, reactions) {
    const el = document.getElementById(`reactions-${id}`);
    if (!el) {
      const msgEl = document.getElementById(`msg-${id}`);
      if (!msgEl) return;
      const body = msgEl.querySelector('.msg-body, .msg-cont-wrap > div');
      if (body) body.insertAdjacentHTML('beforeend', _reactionHtml(reactions, id));
      return;
    }
    el.outerHTML = _reactionHtml(reactions, id);
  }

  function copyMessage(id) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    const contentEl = el.querySelector('.msg-content');
    // Prefer the raw text stashed on the element (preserves original before
    // link/mention/emoji enhancement); fall back to innerText.
    const text = (contentEl && (contentEl.dataset.rawText || contentEl.innerText || '')).trim();
    if (!text) { if (typeof toast === 'function') toast('Nothing to copy', 'info'); return; }
    const done = () => { if (typeof toast === 'function') toast('Copied', 'success'); };
    const fail = () => { if (typeof toast === 'function') toast('Copy failed', 'error'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        try {
          const ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          ok ? done() : fail();
        } catch { fail(); }
      });
    } else {
      fail();
    }
  }

  function startEdit(id) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    const contentEl = el.querySelector('.msg-content');
    if (!contentEl) return;
    const current = contentEl.textContent;
    contentEl.dataset.originalText = current;
    contentEl.innerHTML = `
      <textarea id="edit-input-${id}" style="width:100%;background:#1a1a1a;border:1px solid #4caf50;border-radius:6px;color:#e0e0e0;padding:6px;font-size:14px;resize:none;outline:none" rows="2">${UI.escHtml(current)}</textarea>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button onclick="Messages.submitEdit(${id})" style="background:#4caf50;border:none;border-radius:6px;color:#000;padding:4px 12px;cursor:pointer;font-size:13px">Save</button>
        <button onclick="Messages.cancelEdit(${id})" style="background:#1a1a1a;border:none;border-radius:6px;color:#888;padding:4px 12px;cursor:pointer;font-size:13px">Cancel</button>
      </div>
    `;
    document.getElementById(`edit-input-${id}`)?.focus();
  }

  async function submitEdit(id) {
    const input = document.getElementById(`edit-input-${id}`);
    if (!input) return;
    const newContent = input.value.trim();
    if (!newContent) return;

    const key = State.roomKeys[State.currentRoom];
    const encrypted = key ? await Crypto.encrypt(newContent, key) : newContent;

    WS.send({ type: 'edit', id, content: encrypted });
    // Optimistic update
    updateEdited(id, newContent, State.currentRoom);
  }

  function cancelEdit(id) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    const contentEl = el.querySelector('.msg-content');
    if (!contentEl) return;
    const original = contentEl.dataset.originalText || '';
    delete contentEl.dataset.originalText;
    contentEl.innerHTML = _formatContent(original);
    setTimeout(() => _hydrateSpecialCards(id), 80);
  }

  function openSocialProfile(nickname) {
    const nick = String(nickname || '').trim();
    if (!nick) return;
    try {
      if (typeof Social !== 'undefined' && Social.openProfile) {
        Social.openProfile(nick);
        return;
      }
    } catch {}
    try { showUserInfo(nick); } catch {}
  }

  function openSocialPost(postId) {
    const id = Number(postId);
    if (!Number.isFinite(id) || id <= 0) return;
    try {
      if (typeof Social !== 'undefined' && Social.open && Social.viewPostDetail) {
        Social.open('feed');
        setTimeout(() => {
          try { Social.viewPostDetail(id); } catch {}
        }, 50);
        return;
      }
    } catch {}
    try { window.location.href = `/app?post=${id}`; } catch {}
  }

  function openSocialReel(postId) {
    const id = Number(postId);
    if (!Number.isFinite(id) || id <= 0) return;
    try {
      if (typeof Social !== 'undefined') {
        try { Social.open('reels'); } catch {}
        setTimeout(() => {
          try {
            if (typeof Social.openSharedReel === 'function') Social.openSharedReel(id);
            else if (typeof Social.switchTab === 'function') {
              Social.switchTab('reels');
              if (typeof Social.openPostComments === 'function') Social.openPostComments(id);
            }
          } catch {}
        }, 60);
        return;
      }
    } catch {}
    try { window.location.href = `/?reel=${id}`; } catch {}
  }

  async function deleteMsg(id) {
    const ok = await UI.confirm({
      title: 'Delete message',
      message: 'Delete this message? This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    WS.send({ type: 'delete', id });
  }

  // ─── Discord-style reaction picker ────────────────────────────────────
  const REACT_QUICK = ['👍','❤️','😂','😮','😢','🎉','🔥','🐸'];
  const REACT_CATS = [
    { id:'smileys', icon:'😀', name:'Smileys & People', emojis:['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
    { id:'hearts', icon:'❤️', name:'Hearts', emojis:['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','♥️','💌'] },
    { id:'hands', icon:'👋', name:'Gestures', emojis:['👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋','🤛','🤜','✊','👊','👏','🙌','👐','🤲','🙏','✍️','💪','🦾','🫶'] },
    { id:'animals', icon:'🐸', name:'Animals & Nature', emojis:['🐸','🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐽','🐵','🙈','🙉','🙊','🐒','🦆','🦅','🦉','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🐢','🐍','🦎','🐙','🦀','🐠','🐟','🐡','🐬','🦈','🐳','🐋','🌱','🌿','🍀','🌵','🌴','🌲','🌳','🌺','🌻','🌹','🌷','🌸','🌼'] },
    { id:'food', icon:'🍔', name:'Food & Drink', emojis:['🍎','🍌','🍓','🍇','🍉','🍍','🥝','🍅','🥑','🌽','🥕','🥦','🧄','🍞','🥐','🥨','🧀','🥚','🥓','🍗','🍖','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🥙','🍝','🍜','🍲','🍛','🍣','🍱','🍙','🍘','🍰','🎂','🧁','🍮','🍭','🍬','🍫','🍿','🍩','🍪','☕','🍵','🥤','🧋','🍺','🍻','🥂','🍷','🥃','🍸','🍹'] },
    { id:'activity', icon:'⚽', name:'Activity & Objects', emojis:['⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🥅','⛳','🎣','🎽','🎿','🎯','🎮','🎲','🧩','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🎷','🎺','🎸','🎻','💻','📱','⌚','📷','🔒','🔑','💡','🔋','🔦','🛒','🎁','🎈','🎀','🎊','🎉'] },
    { id:'symbols', icon:'⭐', name:'Symbols', emojis:['⭐','🌟','✨','⚡','💥','🔥','🌈','☀️','🌙','❄️','☃️','💧','🌊','✅','❌','❓','❗','⁉️','‼️','💯','💢','💬','💭','💤','👀','🎉','🏆','🥇','🥈','🥉','🏅','♻️','☯️','☮️','🆗','🆒','🆕','🆙','💫','⚠️','🚫','✔️','☑️'] },
  ];

  function _getRecentReacts() {
    try {
      const raw = localStorage.getItem('ft-recent-reacts');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, 24) : [];
    } catch { return []; }
  }
  function _pushRecentReact(e) {
    try {
      const cur = _getRecentReacts().filter(x => x !== e);
      cur.unshift(e);
      localStorage.setItem('ft-recent-reacts', JSON.stringify(cur.slice(0, 24)));
    } catch {}
  }

  function showReactMenu(msgId, anchor) {
    // Remove any existing picker (toggle behavior)
    const existing = document.getElementById('react-picker');
    if (existing) { existing.remove(); return; }

    // Fall back to message element if the provided anchor is invisible (e.g.
    // invoked from action sheet where .msg-actions is display:none).
    let anchorEl = anchor && anchor.nodeType === 1 ? anchor : null;
    let rect = anchorEl ? anchorEl.getBoundingClientRect() : null;
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      const msgEl = document.getElementById(`msg-${msgId}`);
      rect = msgEl ? msgEl.getBoundingClientRect() : null;
    }

    const recent = _getRecentReacts();
    const picker = document.createElement('div');
    picker.id = 'react-picker';
    picker.className = 'react-picker';
    picker.innerHTML = `
      <div class="rp-quick">
        ${REACT_QUICK.map(e => `<button class="rp-quick-btn" data-e="${UI.escHtml(e)}" type="button">${e}</button>`).join('')}
        <button class="rp-quick-btn rp-plus" type="button" title="More reactions" aria-label="More reactions">＋</button>
      </div>
      <div class="rp-body" hidden>
        <div class="rp-search">
          <input type="text" class="rp-search-input" placeholder="Search emoji…" aria-label="Search emoji">
        </div>
        <div class="rp-grid"></div>
        <div class="rp-tabs">
          ${recent.length ? `<button class="rp-tab" data-cat="recent" title="Recent" type="button">🕘</button>` : ''}
          ${REACT_CATS.map(c => `<button class="rp-tab" data-cat="${c.id}" title="${UI.escHtml(c.name)}" type="button">${c.icon}</button>`).join('')}
        </div>
      </div>
    `;

    document.body.appendChild(picker);

    const quickRow = picker.querySelector('.rp-quick');
    const body = picker.querySelector('.rp-body');
    const grid = picker.querySelector('.rp-grid');
    const tabs = picker.querySelectorAll('.rp-tab');
    const searchInput = picker.querySelector('.rp-search-input');
    let expanded = false;

    const close = () => {
      picker.classList.add('rp-closing');
      setTimeout(() => picker.remove(), 140);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onOutside, true);
    };
    const pick = (e) => {
      _pushRecentReact(e);
      toggleReaction(msgId, e);
      close();
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
    };
    const onOutside = (ev) => {
      if (!picker.contains(ev.target)) close();
    };

    quickRow.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      if (btn.classList.contains('rp-plus')) {
        expanded = !expanded;
        body.hidden = !expanded;
        picker.classList.toggle('rp-expanded', expanded);
        if (expanded) {
          const firstTab = picker.querySelector('.rp-tab');
          if (firstTab) _renderCat(firstTab.dataset.cat);
          // Re-position now that body is shown
          _position();
        }
        return;
      }
      if (btn.dataset.e) pick(btn.dataset.e);
    });

    const _renderCat = (catId) => {
      tabs.forEach(t => t.classList.toggle('active', t.dataset.cat === catId));
      let emojis;
      if (catId === 'recent') emojis = recent;
      else emojis = (REACT_CATS.find(c => c.id === catId) || {}).emojis || [];
      grid.innerHTML = emojis.map(e =>
        `<button class="rp-emoji" data-e="${UI.escHtml(e)}" type="button">${e}</button>`
      ).join('');
      grid.scrollTop = 0;
    };

    grid.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.rp-emoji');
      if (btn && btn.dataset.e) pick(btn.dataset.e);
    });

    tabs.forEach(t => t.addEventListener('click', () => _renderCat(t.dataset.cat)));

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim();
      if (!q) {
        const active = picker.querySelector('.rp-tab.active');
        _renderCat(active ? active.dataset.cat : (REACT_CATS[0].id));
        return;
      }
      // Filter by emoji char match (substring) across all cats
      const all = [...recent, ...REACT_CATS.flatMap(c => c.emojis)];
      const seen = new Set();
      const matches = all.filter(e => {
        if (seen.has(e)) return false;
        seen.add(e);
        return e.includes(q);
      });
      tabs.forEach(t => t.classList.remove('active'));
      grid.innerHTML = matches.length
        ? matches.map(e => `<button class="rp-emoji" data-e="${UI.escHtml(e)}" type="button">${e}</button>`).join('')
        : `<div class="rp-empty">No matches</div>`;
    });

    const _position = () => {
      const pr = picker.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const margin = 8;
      let top, left;
      if (rect) {
        // Prefer above the anchor; flip below if not enough room
        top = rect.top - pr.height - 10;
        if (top < margin) top = Math.min(rect.bottom + 10, vh - pr.height - margin);
        left = rect.left;
        // Clamp horizontally
        if (left + pr.width > vw - margin) left = vw - pr.width - margin;
        if (left < margin) left = margin;
      } else {
        top = (vh - pr.height) / 2;
        left = (vw - pr.width) / 2;
      }
      picker.style.top = top + 'px';
      picker.style.left = left + 'px';
    };
    _position();

    // Defer outside-click binding so the opening click doesn't immediately close us
    setTimeout(() => {
      document.addEventListener('keydown', onKey);
      document.addEventListener('mousedown', onOutside, true);
    }, 0);
  }

  function toggleReaction(msgId, emoji) {
    const isDM = State.currentRoomType === 'dm';
    if (isDM) {
      // DMs use a different WS message type + need the channel id.
      const chId = (typeof _activeDM !== 'undefined' && _activeDM) ? _activeDM.id : null;
      if (chId) {
        WS.send({ type: 'dm_react', id: msgId, channel_id: chId, emoji });
      } else {
        // Fallback to REST if WS can't carry context
        fetch(`/api/dms/0/messages/${msgId}/react`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
          body: JSON.stringify({ emoji })
        }).then(r => r.ok && r.json()).then(d => {
          if (d && d.reactions) updateReactions(msgId, d.reactions);
        }).catch(() => {});
      }
      return;
    }
    WS.send({ type: 'react', id: msgId, emoji });
  }

  function openMedia(el) {
    // Get media info
    const sender = el.getAttribute('data-sender') || 'Unknown';
    const time = el.getAttribute('data-time') || '';
    
    // Determine media type
    let type, url;
    if (el.tagName === 'IMG') {
      type = 'image';
      url = el.src;
    } else if (el.tagName === 'VIDEO') {
      type = 'video';
      url = el.src;
    } else if (el.classList.contains('audio-msg')) {
      type = 'audio';
      url = el.getAttribute('data-src');
    } else {
      return;
    }
    
    // Collect all media in current view for gallery navigation
    const allMedia = [];
    document.querySelectorAll('#messages-area .clickable-media').forEach(m => {
      let mt, mu;
      if (m.tagName === 'IMG') { mt = 'image'; mu = m.src; }
      else if (m.tagName === 'VIDEO') { mt = 'video'; mu = m.src; }
      else if (m.classList.contains('audio-msg')) { mt = 'audio'; mu = m.getAttribute('data-src'); }
      if (mt && mu) {
        allMedia.push({
          type: mt,
          url: mu,
          sender: m.getAttribute('data-sender') || 'Unknown',
          time: m.getAttribute('data-time') || ''
        });
      }
    });
    
    // Create fake element for MediaPlayer
    const fakeEl = document.createElement(type === 'image' ? 'img' : type === 'video' ? 'video' : 'audio');
    fakeEl.src = url;
    
    MediaPlayer.open(fakeEl, sender, time, allMedia);
  }

  function revealSpoiler(id) {
    const el = document.getElementById(`sp-${id}`);
    if (!el) return;
    el.classList.add('revealed');
    // Don't null onclick — we want no action on the wrap once revealed;
    // the re-hide button handles its own event via stopPropagation.
    el.onclick = null;
  }

  function hideSpoiler(id) {
    const el = document.getElementById(`sp-${id}`);
    if (!el) return;
    el.classList.remove('revealed');
    // Re-arm the reveal click so it behaves exactly like it did the first time.
    el.onclick = () => revealSpoiler(id);
  }

  async function revealViewOnce(id) {
    const el = document.getElementById(`vo-${id}`);
    if (!el) return;
    let mediaData = el.getAttribute('data-media');
    const mediaType = el.getAttribute('data-mtype');
    const sender = el.getAttribute('data-sender');
    if (mediaData && typeof Crypto !== 'undefined' && Crypto.decryptPayload) {
      mediaData = await Crypto.decryptPayload(mediaData, State.roomKeys[State.currentRoom] || null);
    }
    if (!mediaData) return;

    // Consume on server first — once the overlay closes there's no going back.
    try { await apiFetch(`/api/messages/${id}/view`, { method: 'POST' }); } catch {}

    // Telegram-style full-screen reveal with a 10-second auto-destruct timer.
    const DURATION = 10;
    const overlay = document.createElement('div');
    overlay.className = 'vo-overlay';
    const mediaEl = mediaType?.startsWith('video')
      ? `<video class="vo-media" src="${UI.escHtml(mediaData)}" autoplay muted playsinline></video>`
      : `<img class="vo-media" src="${UI.escHtml(mediaData)}" alt="">`;
    overlay.innerHTML = `
      <button class="vo-close" title="Close">✕</button>
      ${mediaEl}
      <div class="vo-hint">
        <div class="vo-timer-ring">
          <svg width="56" height="56">
            <circle class="vo-track" cx="28" cy="28" r="24"></circle>
            <circle class="vo-bar" cx="28" cy="28" r="24" stroke-dasharray="150.8" stroke-dashoffset="0"></circle>
          </svg>
          <div class="vo-timer-label">${DURATION}</div>
        </div>
        <div>From <b>${UI.escHtml(sender || '')}</b> — disappears after closing</div>
      </div>`;
    document.body.appendChild(overlay);

    const bar = overlay.querySelector('.vo-bar');
    const label = overlay.querySelector('.vo-timer-label');
    let remaining = DURATION;
    const CIRC = 150.8; // 2πr for r=24
    const tick = () => {
      remaining -= 1;
      if (label) label.textContent = Math.max(0, remaining);
      if (bar) bar.setAttribute('stroke-dashoffset', String(CIRC * (1 - remaining / DURATION)));
      if (remaining <= 0) close();
    };
    const timer = setInterval(tick, 1000);

    const close = () => {
      clearInterval(timer);
      overlay.remove();
      el.innerHTML = '<div class="view-once-viewed">🔥 View Once — <em>viewed</em></div>';
      el.removeAttribute('data-media');
    };
    overlay.querySelector('.vo-close').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  }

  async function loadMedia(msgId) {
    const container = document.getElementById(`media-lazy-${msgId}`);
    if (!container) return;
    const isBlur = container.getAttribute('data-blur') === '1';
    container.innerHTML = '<div style="padding:12px;color:#85a89a;font-size:13px">Loading…</div>';
    try {
      const res = await apiFetch(`/api/messages/media/${msgId}`);
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      if (typeof Crypto !== 'undefined' && Crypto.decryptPayload) {
        data.media_data = await Crypto.decryptPayload(data.media_data, State.roomKeys[State.currentRoom] || null);
      }
      if (!data.media_data) throw new Error('Decrypt failed');
      const sender = container.getAttribute('data-sender');
      const time = container.getAttribute('data-time');
      const mediaType = data.media_type || container.getAttribute('data-media-type') || '';
      let html;
      if (mediaType.startsWith('video')) {
        const isNote = mediaType.includes('videonote=1');
        const noteAttr = isNote ? ' data-video-note="1"' : '';
        const noteCls  = isNote ? ' is-note' : '';
        const preload  = isNote ? 'auto' : 'metadata';
        const badgeIco = isNote ? '🎥' : '🎬';
        const badgeLbl = isNote ? 'Note' : 'Video';
        // See render-side comment above on why notes use data-pending-src.
        const _vSrcAttr = isNote ? `data-pending-src="${data.media_data}"` : `src="${data.media_data}"`;
        if (isBlur) {
          html = `<video class="msg-media clickable-media" src="${data.media_data}" data-sender="${UI.escHtml(sender)}" data-time="${time}" onclick="Messages.openMedia(this)" preload="metadata" controls muted playsinline></video>`;
        } else {
          html = `<div class="chat-video${noteCls}"${noteAttr} data-sender="${UI.escHtml(sender)}" data-time="${time}">`+
            `<div class="cv-poster"></div>`+
            `<video class="msg-media clickable-media" ${_vSrcAttr} data-sender="${UI.escHtml(sender)}" data-time="${time}" preload="${preload}" muted playsinline></video>`+
            `<div class="cv-loading"><div class="cv-spinner"></div></div>`+
            `<div class="cv-overlay"><div class="cv-play" aria-label="Play video" role="button"></div></div>`+
            `<div class="cv-badge"><span class="cv-icon">${badgeIco}</span><span class="cv-dur">${badgeLbl}</span></div>`+
          `</div>`;
        }
      } else if (mediaType.startsWith('audio')) {
        const waveBars = Array.from({length:20}, () => `<div class="wave-bar" style="height:${4 + Math.random()*20}px"></div>`).join('');
        html = `<div class="audio-msg" id="audio-${msgId}" data-src="${data.media_data}" data-sender="${UI.escHtml(sender)}" data-time="${time}">
          <button class="audio-play-btn" onclick="Messages.playInlineAudio(${msgId},this,event)">▶</button>
          <div class="audio-waves">${waveBars}</div>
          <div class="audio-meta"><span class="audio-duration" id="audio-dur-${msgId}">0:00</span></div>
        </div>`;
        _probeAudioDuration(msgId, data.media_data);
      } else {
        html = `<img class="msg-media clickable-media" src="${data.media_data}" alt="media" data-sender="${UI.escHtml(sender)}" data-time="${time}" onclick="Messages.openMedia(this)" loading="lazy">`;
      }
      // Re-apply spoiler wrap if this message was marked as a spoiler — the
      // direct-broadcast render path wraps it, but lazy-loaded history was
      // skipping this so the image displayed uncovered on scroll-in.
      if (isBlur && !mediaType.startsWith('audio')) {
        html = `<div class="spoiler-wrap" id="sp-${msgId}" onclick="Messages.revealSpoiler(${msgId})">
          <div class="spoiler-overlay">👁️ Spoiler — Click to Reveal</div>
          <button type="button" class="spoiler-rehide" title="Hide spoiler" aria-label="Hide spoiler"
            onclick="event.stopPropagation();Messages.hideSpoiler(${msgId})">👁️‍🗨️</button>
          ${html.replace('class="msg-media', 'class="spoiler-img msg-media')}
        </div>`;
      }
      container.outerHTML = html;
    } catch {
      container.innerHTML = '<div style="padding:12px;color:#d9a89f;font-size:13px">Failed to load media</div>';
    }
  }

  /* ── Auto-load any lazy-media placeholders scrolled into view ────────────
     Previously users had to click "Load media" on every history image, which
     looked identical to a spoiler overlay. Now we auto-fetch anything the
     user can actually see. */
  let _autoObserver = null;
  function _ensureAutoObserver() {
    if (_autoObserver || typeof IntersectionObserver === 'undefined') return;
    _autoObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        _autoObserver.unobserve(el);
        const id = +el.dataset.msgId;
        if (id) loadMedia(id);
      }
    }, { rootMargin: '200px 0px', threshold: 0.01 });
  }
  function observeLazyMedia(root) {
    // User-toggleable: if auto-play is disabled, leave placeholders as click-to-load.
    if (localStorage.getItem('ft_autoplay_media') === '0') return;
    _ensureAutoObserver();
    if (!_autoObserver) return;
    const host = root || document.getElementById('messages-area');
    if (!host) return;
    host.querySelectorAll('.media-lazy.auto').forEach(el => {
      if (!el.dataset._obs) { _autoObserver.observe(el); el.dataset._obs = '1'; }
    });
  }

  /* ── Inline audio player ─────────────────────────────────────── */
  let _currentAudio = null;
  let _currentAudioId = null;

  // Pre-load just the metadata of a voice note so the duration shows up on
  // first render instead of "0:00" until the user hits play. Defers via
  // setTimeout so the bubble is in the DOM before we look up the span.
  //
  // Chromium MediaRecorder webm/opus blobs report duration=Infinity until
  // we seek to the very end — so we do the well-known "seek to 1e10, wait
  // for durationchange, then seek back to 0" dance.
  function _probeAudioDuration(msgId, src) {
    if (!src) return;
    setTimeout(() => {
      const durEl = document.getElementById(`audio-dur-${msgId}`);
      if (!durEl) return;
      const writeDur = (d) => {
        if (!isFinite(d) || d <= 0) return;
        const m = Math.floor(d / 60);
        const s = Math.floor(d % 60).toString().padStart(2, '0');
        durEl.textContent = `${m}:${s}`;
      };
      try {
        const a = new Audio();
        a.preload = 'metadata';
        a.muted = true;
        a.src = src;
        a.addEventListener('loadedmetadata', () => {
          if (isFinite(a.duration) && a.duration > 0) {
            writeDur(a.duration);
            return;
          }
          // Force the browser to scan to the end so it discovers the real
          // duration of the chunked MediaRecorder blob.
          const onChange = () => {
            if (isFinite(a.duration) && a.duration > 0) {
              a.removeEventListener('durationchange', onChange);
              writeDur(a.duration);
              try { a.currentTime = 0; } catch {}
            }
          };
          a.addEventListener('durationchange', onChange);
          try { a.currentTime = 1e10; } catch {}
        }, { once: true });
      } catch {}
    }, 0);
  }

  function playInlineAudio(msgId, btn, e) {
    if (e) e.stopPropagation();
    const container = document.getElementById(`audio-${msgId}`);
    if (!container) return;
    const src = container.getAttribute('data-src');
    if (!src) return;

    // If same audio is playing, toggle pause/play
    if (_currentAudioId === msgId && _currentAudio) {
      if (_currentAudio.paused) {
        _currentAudio.play();
        btn.textContent = '■';
        container.classList.add('playing');
      } else {
        _currentAudio.pause();
        btn.textContent = '▶';
        container.classList.remove('playing');
      }
      return;
    }

    // Stop previous audio
    if (_currentAudio) {
      _currentAudio.pause();
      _currentAudio = null;
      const prevContainer = document.getElementById(`audio-${_currentAudioId}`);
      if (prevContainer) {
        prevContainer.classList.remove('playing');
        const prevBtn = prevContainer.querySelector('.audio-play-btn');
        if (prevBtn) prevBtn.textContent = '▶';
      }
    }

    const audio = new Audio(src);
    _currentAudio = audio;
    _currentAudioId = msgId;

    const durEl = document.getElementById(`audio-dur-${msgId}`);
    // The on-render _probeAudioDuration() has already discovered the real
    // length via the seek-to-1e10 trick and stamped it into durEl. Reuse
    // that here — doing a second seek-during-play makes Chromium jump to
    // the end and instantly fire 'ended' before any audio plays.
    let _knownDur = 0;
    const _parseDurText = () => {
      if (!durEl) return 0;
      const m = (durEl.textContent || '').match(/^(\d+):(\d+)$/);
      if (!m) return 0;
      return (+m[1]) * 60 + (+m[2]);
    };
    _knownDur = _parseDurText();

    audio.addEventListener('loadedmetadata', () => {
      if (isFinite(audio.duration) && audio.duration > 0) _knownDur = audio.duration;
      if (durEl && _knownDur) {
        const m = Math.floor(_knownDur / 60);
        const s = Math.floor(_knownDur % 60).toString().padStart(2, '0');
        durEl.textContent = `${m}:${s}`;
      }
    });

    audio.addEventListener('durationchange', () => {
      if (isFinite(audio.duration) && audio.duration > 0) _knownDur = audio.duration;
    });

    audio.addEventListener('timeupdate', () => {
      if (durEl && _knownDur) {
        const rem = Math.max(0, _knownDur - audio.currentTime);
        const m = Math.floor(rem / 60);
        const s = Math.floor(rem % 60).toString().padStart(2, '0');
        durEl.textContent = `${m}:${s}`;
      }
    });

    audio.addEventListener('ended', () => {
      btn.textContent = '▶';
      container.classList.remove('playing');
      _currentAudio = null;
      _currentAudioId = null;
    });

    audio.play();
    btn.textContent = '■';
    container.classList.add('playing');
  }

  function setReplyTo(id, nickname, content) {
    _replyTo = { id, nickname, content };
    const bar = document.getElementById('reply-bar');
    if (bar) {
      bar.style.display = 'flex';
      const nick = bar.querySelector('#reply-bar-nick');
      const text = bar.querySelector('#reply-bar-text');
      if (nick) nick.textContent = nickname;
      if (text) text.textContent = content ? content.substring(0, 80) : 'Media';
    }
    document.getElementById('msg-input')?.focus();
  }

  function clearReply() {
    _replyTo = null;
    const bar = document.getElementById('reply-bar');
    if (bar) bar.style.display = 'none';
  }

  function getReplyToId() {
    return _replyTo ? _replyTo.id : null;
  }
  // Full reply context for the optimistic/pending bubble. Without this the
  // pending render has no reply_* fields, so the quote doesn't appear until
  // the channel re-loads from cache. Returns a shallow copy so callers can
  // freely store it on a temp msg.
  function getReplyTo() {
    if (!_replyTo) return null;
    return { id: _replyTo.id, nickname: _replyTo.nickname, content: _replyTo.content };
  }

  // Open an action sheet for a message — pulls buttons from the hidden .msg-actions
  // of that message and shows them as a mobile-friendly overlay.
  function openActionSheet(msgId) {
    document.querySelectorAll('.action-sheet').forEach(el => el.remove());
    const msgEl = document.getElementById(`msg-${msgId}`);
    if (!msgEl) return;
    const actionsRow = msgEl.querySelector('.msg-actions');
    if (!actionsRow) return;

    const titleBtn = msgEl.querySelector('.msg-author');
    const nick = titleBtn ? titleBtn.textContent.replace(/[^\w\s._-]/g, '').trim() : 'Message';

    const sheet = document.createElement('div');
    sheet.className = 'action-sheet';
    sheet.innerHTML = `
      <div class="as-panel" onclick="event.stopPropagation()">
        <div class="as-title">${UI.escHtml(nick).substring(0, 40)}</div>
        <div class="as-items"></div>
        <div class="as-cancel">Cancel</div>
      </div>
    `;
    const itemsWrap = sheet.querySelector('.as-items');

    const labelFor = (btn) => {
      const t = (btn.getAttribute('title') || '').trim();
      const txt = (btn.textContent || '').trim();
      return t || txt || 'Action';
    };

    Array.from(actionsRow.querySelectorAll('button.msg-act-btn')).forEach((btn, i) => {
      // Skip the redundant ⋯ sub-menu trigger — its children are already listed here
      if (btn.classList.contains('msg-mod-more')) return;
      const isDanger = btn.classList.contains('danger');
      const icon = (btn.textContent || '•').trim();
      const label = labelFor(btn);
      const actionTitle = label.toLowerCase();
      const asBtn = document.createElement('button');
      asBtn.className = 'as-btn' + (isDanger ? ' danger' : '');
      asBtn.style.animationDelay = (40 + i * 28) + 'ms';
      asBtn.innerHTML = `<span class="as-ic">${UI.escHtml(icon)}</span><span>${UI.escHtml(label)}</span>`;
      asBtn.onclick = (e) => {
        e.stopPropagation();
        try { navigator.vibrate?.(8); } catch {}
        const isForwardAction = actionTitle.includes('forward');
        close(isForwardAction);
        // Defer so the sheet is gone before any menu/popup the action opens.
        // On some media/link-only messages, programmatic clicks on hidden
        // action-row buttons can be flaky, so invoke Forward directly.
        setTimeout(() => {
          if (isForwardAction) {
            const isDM = !!msgEl.getAttribute('data-dmid');
            if (isDM && typeof window.forwardDMMessage === 'function') {
              window.forwardDMMessage(msgId);
              return;
            }
            if (!isDM && typeof forwardMessage === 'function') {
              forwardMessage(msgId);
              return;
            }
          }
          try {
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          } catch {
            try { btn.click(); } catch {}
          }
        }, isForwardAction ? 25 : 180);
      };
      itemsWrap.appendChild(asBtn);
    });

    if (!itemsWrap.children.length) return; // nothing to show

    const close = (immediate) => {
      if (sheet.classList.contains('closing')) return;
      if (immediate) {
        sheet.remove();
        return;
      }
      sheet.classList.add('closing');
      setTimeout(() => sheet.remove(), 180);
    };
    sheet.addEventListener('click', close);
    sheet.querySelector('.as-cancel').addEventListener('click', (e) => { e.stopPropagation(); close(); });
    document.body.appendChild(sheet);
    try { navigator.vibrate?.(15); } catch {}
  }

  // Attach long-press handlers to a rendered message element
  function _attachLongPress(el, msgId) {
    if (!el || el._lpBound) return;
    el._lpBound = true;
    // Desktop: right-click opens the same action sheet as mobile long-press.
    el.addEventListener('contextmenu', (e) => {
      if (e.target.closest('a,button,input,textarea,.reaction-pill,.mention,.room-mention,.msg-avatar,.msg-author')) return;
      e.preventDefault();
      openActionSheet(msgId);
    });
    let timer = null;
    let startX = 0, startY = 0;
    const THRESHOLD = 500;
    const MOVE_CANCEL = 10;

    const start = (e) => {
      // Ignore taps on interactive elements
      const tgt = e.target;
      if (tgt.closest('a,button,input,textarea,.msg-media,.msg-reply-quote,.reaction-pill,.spoiler-wrap,.link-preview,.yt-embed,.spotify-embed,.share-card,.chat-share-embed,.mention,.room-mention,.msg-avatar,.msg-author')) return;
      const t = e.touches ? e.touches[0] : e;
      startX = t.clientX; startY = t.clientY;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          if (navigator.vibrate) navigator.vibrate(15);
          else if (window.Android && typeof window.Android.vibrate === 'function') window.Android.vibrate(15);
        } catch {}
        openActionSheet(msgId);
      }, THRESHOLD);
    };
    const move = (e) => {
      if (!timer) return;
      const t = e.touches ? e.touches[0] : e;
      if (Math.abs(t.clientX - startX) > MOVE_CANCEL || Math.abs(t.clientY - startY) > MOVE_CANCEL) {
        clearTimeout(timer); timer = null;
      }
    };
    const cancel = () => { clearTimeout(timer); timer = null; };

    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', cancel);
    el.addEventListener('touchcancel', cancel);
  }

  function bindLongPress(root) {
    const scope = root || document;
    scope.querySelectorAll('.msg-group, .msg-cont').forEach(el => {
      const id = el.id && el.id.startsWith('msg-') ? +el.id.slice(4) : null;
      if (id) _attachLongPress(el, id);
    });
  }

  function openModMenu(ev, nickname, userId, scope) {
    ev.stopPropagation();
    ev.preventDefault();
    document.querySelectorAll('.msg-mod-popup').forEach(el => el.remove());
    const pop = document.createElement('div');
    pop.className = 'msg-mod-popup';
    const items = scope === 'admin'
      ? [
          { label: '👢 Kick (global)', color: '#ff9800', fn: () => adminKick(nickname) },
          { label: '🔇 Mute', color: '#ff9800', fn: () => adminMute(nickname) },
          { label: '🚫 Ban (global)', color: '#ff5555', fn: () => adminBan(nickname) },
        ]
      : [
          { label: '👢 Kick from channel', color: '#ff9800', fn: () => roomKick(nickname, userId) },
          { label: '🚫 Ban from channel', color: '#ff5555', fn: () => roomBan(nickname, userId) },
        ];
    pop.innerHTML = items.map((it, i) =>
      `<button class="msg-mod-popup-btn" data-i="${i}" style="color:${it.color}">${it.label}</button>`
    ).join('');
    document.body.appendChild(pop);
    const rect = ev.currentTarget.getBoundingClientRect();
    const pw = 200;
    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = rect.bottom + 6;
    if (top + 120 > window.innerHeight) top = rect.top - 120;
    pop.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${pw}px;background:#141414;border:1px solid #2a4a2a;border-radius:10px;padding:6px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:2px`;
    pop.querySelectorAll('.msg-mod-popup-btn').forEach(btn => {
      btn.style.cssText = 'background:transparent;border:0;padding:10px 12px;text-align:left;border-radius:6px;cursor:pointer;font-size:14px';
      btn.onmouseover = () => btn.style.background = '#1d2d1d';
      btn.onmouseout  = () => btn.style.background = 'transparent';
      btn.onclick = (e) => {
        e.stopPropagation();
        const idx = +btn.dataset.i;
        pop.remove();
        items[idx].fn();
      };
    });
    setTimeout(() => {
      const off = (e) => {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', off); }
      };
      document.addEventListener('click', off);
    }, 0);
  }

  async function joinViaInvite(code, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Joining…'; }
    try {
      const res = await apiFetch(`/api/invites/${encodeURIComponent(code)}/join`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.ok) {
        if (btn) {
          const card = btn.closest('.invite-card');
          if (card) {
            btn.outerHTML = `<button class="invite-join-btn invite-join-btn--already" onclick="Rooms.openChannelLink('${UI.escHtml(data.room)}')">Open Channel</button>`;
          }
        }
        await Rooms.loadRooms?.();
        Rooms.openChannelLink(data.room);
      } else {
        if (btn) { btn.disabled = false; btn.textContent = 'Join'; }
        UI.toast(data.error || 'Could not join channel');
      }
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Join'; }
      UI.toast('Could not join channel');
    }
  }

  return { loadHistory, appendMessage, updateEdited, removeMessage, updateReactions, startEdit, submitEdit, cancelEdit, deleteMsg, showReactMenu, toggleReaction, openMedia, revealSpoiler, hideSpoiler, revealViewOnce, loadMedia, observeLazyMedia, playInlineAudio, setReplyTo, clearReply, getReplyToId, getReplyTo, openModMenu, openActionSheet, bindLongPress, copyMessage, scrollToBottom, joinViaInvite, openSocialProfile, openSocialPost, openSocialReel, _toggleChatVideo, forwardMessage, openForwardPicker: _openForwardPicker, forwardedBadgeHtml: _forwardedBadgeHtml, _renderRichShareEmbed, suppressPreview, applyPreviewSuppress, _loadInviteCard, _loadSocialProfileCard, _scrollIfNearBottom };
})();

// ── Scroll-to-bottom + "jump to latest" pip ─────────────────────────────────
function scrollToBottom(smooth) {
  const area = document.getElementById('messages-area');
  if (!area) return;
  if (smooth) {
    area.scrollTo({ top: area.scrollHeight, behavior: 'smooth' });
  } else {
    area.scrollTop = area.scrollHeight;
  }
  const snap = () => { area.scrollTop = area.scrollHeight; };
  requestAnimationFrame(() => { snap(); requestAnimationFrame(snap); });
  _setJumpPipVisible(false);
}

function _setJumpPipVisible(show) {
  let pip = document.getElementById('jump-to-latest-pip');
  if (!show) { if (pip) pip.classList.remove('visible'); return; }
  if (!pip) {
    pip = document.createElement('button');
    pip.id = 'jump-to-latest-pip';
    pip.className = 'jump-to-latest-pip';
    pip.type = 'button';
    pip.setAttribute('aria-label', 'Jump to latest message');
    pip.innerHTML = '<span class="jtp-arrow">↓</span><span class="jtp-label">New messages</span>';
    pip.onclick = () => scrollToBottom(true);
    const chatPanel = document.getElementById('main') || document.body;
    chatPanel.appendChild(pip);
  }
  pip.classList.add('visible');
}


// ── Typing & send ────────────────────────────────────────────────────────────

let _typingSent = false;

function sendTyping() {
  if (typeof isDMView === 'function' && isDMView()) {
    if (typeof sendDMTyping === 'function') sendDMTyping();
    return;
  }
  if (!_typingSent) {
    WS.send({ type: 'typing' });
    _typingSent = true;
    setTimeout(() => { _typingSent = false; }, 2500);
  }
}

function handleInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  // Up arrow to edit last message when input is empty
  if (e.key === 'ArrowUp' && e.target.value.trim() === '') {
    e.preventDefault();
    // Find user's last message in current room
    const msgs = State.messages[State.currentRoom] || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].nickname === State.user?.nickname) {
        Messages.startEdit(msgs[i].id);
        break;
      }
    }
  }
}

function handlePasteAttachment(e) {
  const dt = e?.clipboardData;
  if (!dt?.items?.length) return;
  for (const item of dt.items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile?.();
    if (!file || !(file.type || '').startsWith('image/')) continue;
    const ext = (file.type || 'image/png').split('/')[1] || 'png';
    const name = `pasted-${Date.now()}.${ext}`;

    // Route pasted images through the same attachment pipeline used by picker/camera.
    if (typeof addPendingAttachmentFile === 'function') {
      e.preventDefault();
      addPendingAttachmentFile(file, { name, source: 'paste' });
      return;
    }
    break;
  }
}

async function sendMessage() {
  // Delegate to DM handler when in DM view
  if (typeof isDMView === 'function' && isDMView()) {
    return sendDMMessage();
  }

  // Auto-stop recording if in progress and wait for finalization
  if (typeof _isRecording !== 'undefined' && _isRecording) {
    stopRecording();
    await new Promise(resolve => {
      const check = () => window._pendingAttachment ? resolve() : setTimeout(check, 50);
      setTimeout(check, 50);
      setTimeout(resolve, 2000); // safety timeout
    });
  }

  if (Messages._isSending) return;
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  const attachment = State.pendingAttachment || window._pendingAttachment;

  if (!text && !attachment) return;

  Messages._isSending = true;
  const btn = document.getElementById('send-btn');
  btn.disabled = true;
  btn.classList.add('is-sending');
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = '⏳';

  let _nonce = null;
  let _tempId = null;
  let _wsDispatched = false;
  // Always show instant pending feedback for channel text, even if an
  // attachment object is present (stale or in-flight), so users see immediate
  // Discord-style send state.
  if (text) {
    _nonce = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    _tempId = -Math.floor(Date.now() + Math.random() * 10000);
    // Snapshot the reply target NOW — Messages.clearReply() runs after this
    // function returns and would otherwise wipe the context before the
    // server echo lands. Putting these on the temp msg means the optimistic
    // bubble renders the quote immediately, and the reconciliation step
    // below preserves the bubble's existing reply DOM.
    const _replySnap = (typeof Messages !== 'undefined' && typeof Messages.getReplyTo === 'function')
      ? Messages.getReplyTo() : null;
    const _tempMsg = {
      id: _tempId,
      _pending: true,
      _nonce: _nonce,
      room: State.currentRoom,
      nickname: State.user?.nickname,
      display_name: State.user?.display_name,
      user_id: State.user?.id,
      avatar: State.user?.avatar,
      content: text,
      media_data: null,
      media_type: null,
      reply_to: _replySnap ? _replySnap.id : null,
      reply_nickname: _replySnap ? _replySnap.nickname : null,
      reply_content: _replySnap ? _replySnap.content : null,
      edited: false,
      reactions: {},
      created_at: new Date().toISOString(),
    };
    // Render pending message immediately with dull styling (like Discord).
    // Use Messages.appendMessage so the bubble is built via module internals.
    Messages.appendMessage(State.currentRoom, _tempMsg);
    try {
      const pend = document.getElementById(`msg-${_tempId}`);
      if (pend) {
        pend.classList.add('msg-pending');
        pend.setAttribute('data-own', '1');
        pend.setAttribute('data-nonce', _nonce);
      }
    } catch {}
  }

  try {
    const key = State.roomKeys[State.currentRoom];

    // Convert blob attachment to base64 dataUrl if needed.
    // Progress phases for the upload toast (so users see honest motion
    // instead of the old "stick at 70% then jump to 100%" pattern):
    //   0–20%  Preparing media (blob → base64)
    //  20–25%  Encrypting payload (E2EE rooms only)
    //  25–95%  Uploading (real XHR upload-progress bytes)
    //  95–99%  Server processing
    //    100%  Sent
    let mediaData = attachment?.dataUrl || attachment?.data || null;
    let mediaType = attachment?.type || null;
    if (!mediaData && attachment?.blob) {
      UI.showProgressToast('Preparing media…', 0);
      try {
        mediaData = await UI.blobToDataURL(attachment.blob, (pct) => {
          UI.showProgressToast('Preparing media…', Math.max(1, Math.round(pct * 0.20)));
        });
      } catch (err) {
        UI.showProgressToast('Failed to prepare media', 100);
        throw new Error('Could not read attachment: ' + (err && err.message ? err.message : 'unknown error'));
      }
      mediaType = attachment.type;
      UI.showProgressToast('Preparing media…', 20);
    }

    // Use REST API for media (reliable) or WS for text-only (fast)
    // When this room has an active outbound bridge, attach the plaintext
    // alongside the encrypted payload so Telegram/Discord receive readable
    // text. The server NEVER stores `bridge_plain` — it's consumed inside
    // the handler and immediately handed off to the bridge forwarders.
    //
    // For E2EE rooms we ALWAYS re-check the outbound flag at send-time:
    // the client-side cache can be stale if a bridge was added/toggled
    // after the last room-switch, which historically caused Telegram to
    // show opaque ciphertext. For plaintext rooms the check is skipped —
    // the server already has the text anyway.
    let hasOutbound = false;
    if (key) {
      try {
        const r = await fetch(
          `/api/rooms/${encodeURIComponent(State.currentRoom)}/bridge-outbound`,
          { headers: { 'X-Session-Token': State.token } }
        );
        if (r.ok) {
          const j = await r.json();
          hasOutbound = !!j.outbound;
        }
        if (!State.bridgeOut) State.bridgeOut = {};
        State.bridgeOut[State.currentRoom] = hasOutbound;
      } catch { hasOutbound = false; }
    }
    if (!State._bridgePrivacyNotice) State._bridgePrivacyNotice = {};
    if (hasOutbound && key && !State._bridgePrivacyNotice[State.currentRoom]) {
      State._bridgePrivacyNotice[State.currentRoom] = true;
      UI.showToast('Outbound bridge active: new room messages in this channel are sent without E2EE.', 'info');
    }
    const encrypted = (key && text && !hasOutbound) ? await Crypto.encrypt(text, key) : text;
    if (mediaData && key && !hasOutbound && typeof Crypto !== 'undefined' && Crypto.encryptPayload) {
      UI.showProgressToast('Encrypting…', 22);
      mediaData = await Crypto.encryptPayload(mediaData, key);
      UI.showProgressToast('Encrypting…', 25);
    }
    if (mediaData) {
      UI.showProgressToast('Uploading…', 25);
      const res = await UI.uploadJSONWithProgress(
        `/api/messages/${encodeURIComponent(State.currentRoom)}/send`,
        {
          content: encrypted,
          media_data: mediaData,
          media_type: mediaType,
          media_blur: window._pendingMediaBlur ? 1 : 0,
          view_once: window._pendingViewOnce ? 1 : 0,
          reply_to: Messages.getReplyToId(),
          bridge_plain: hasOutbound ? text : null,
        },
        {
          onProgress: (loaded, total, phase) => {
            if (phase === 'uploaded') {
              UI.showProgressToast('Sending…', 97);
              return;
            }
            if (!total) return;
            // Map real upload bytes onto 25 → 95 so the bar climbs smoothly
            // with the network instead of pausing at 70%.
            const frac = Math.max(0, Math.min(1, loaded / total));
            const pct = 25 + Math.round(frac * 70);
            UI.showProgressToast('Uploading…', Math.min(95, pct));
          },
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Upload failed');
      }
      UI.showProgressToast('Sent!', 100);
    } else {
      if (!_nonce) {
        _nonce = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      }
      WS.send({
        type: 'message',
        content: encrypted,
        reply_to: Messages.getReplyToId(),
        client_nonce: _nonce,
        bridge_plain: hasOutbound ? text : undefined,
      });
      _wsDispatched = true;
    }

    input.value = '';
    input.style.height = 'auto';
    clearAttachment();
    Messages.clearReply();
    // User just sent — always snap them to latest so they see their message land.
    try { scrollToBottom(true); } catch {}
  } catch (e) {
    console.error('Send error:', e);
    if (_nonce && !_wsDispatched) {
      try {
        const pend = document.querySelector('.msg-pending[data-nonce="' + _nonce + '"]');
        if (pend) pend.remove();
        const cached = State.messages[State.currentRoom] || [];
        const idx = cached.findIndex(m => m && m._pending && m._nonce === _nonce);
        if (idx >= 0) cached.splice(idx, 1);
      } catch {}
    }
    UI.showToast(e.message || 'Failed to send message', 'error');
  } finally {
    Messages._isSending = false;
    btn.disabled = false;
    btn.classList.remove('is-sending');
    btn.removeAttribute('aria-busy');
    btn.textContent = '➤';
  }
}

function triggerAttach() {
  document.getElementById('file-input').click();
}

// handleFileSelect and clearAttachment are now in media.js
// These stubs keep backward-compat for any direct calls:
function handleFileSelect(input) {
  if (typeof window.handleFileSelectMedia === 'function') {
    return window.handleFileSelectMedia(input);
  }
  // original simple fallback (images/video only, base64)
  const file = input.files[0];
  if (!file) return;
  const MAX = 8 * 1024 * 1024;
  if (file.size > MAX) { UI.showToast('File too large (max 8MB)', 'error'); return; }
  UI.blobToDataURL(file).then(dataUrl => {
    State.pendingAttachment = { dataUrl, type: file.type };
    const preview = document.getElementById('attachment-preview');
    const thumb = document.getElementById('attachment-thumb');
    preview.style.display = 'flex';
    if (file.type.startsWith('video')) {
      thumb.innerHTML = `<video src="${dataUrl}" style="max-width:200px;max-height:120px;border-radius:8px"></video>`;
    } else {
      thumb.innerHTML = `<img src="${dataUrl}" style="max-width:200px;max-height:120px;border-radius:8px">`;
    }
  }).catch(err => {
    UI.showToast('Failed to read file: ' + (err?.message || 'unknown'), 'error');
  });
  input.value = '';
}

function clearAttachment() {
  State.pendingAttachment = null;
  const preview = document.getElementById('attachment-preview');
  preview.style.display = 'none';
  document.getElementById('attachment-thumb').innerHTML = '';
}

function handleMsgScroll() {
  const area = document.getElementById('messages-area');
  if (area.scrollTop < 50 && !State.isLoadingHistory && State.oldestMsgId) {
    loadOlderMessages();
  }
  // Hide the "jump to latest" pip once user has scrolled back near bottom.
  const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
  if (nearBottom) { try { _setJumpPipVisible(false); } catch {} }
}

async function loadOlderMessages() {
  State.isLoadingHistory = true;
  const room = State.currentRoom;
  try {
    const res = await fetch(`/api/messages/${encodeURIComponent(room)}?limit=50&before_id=${State.oldestMsgId}`, {
      headers: { 'X-Session-Token': State.token }
    });
    const data = await res.json();
    const msgs = data.messages || [];
    if (!msgs.length) return;

    const key = State.roomKeys[room];
    const decrypted = await Promise.all(msgs.map(async m => {
      if (!key) return m;
      const plain = await Crypto.decrypt(m.content, key);
      let replyPlain = m.reply_content;
      if (m.reply_content) {
        const decryptedReply = await Crypto.decrypt(m.reply_content, key);
        replyPlain = decryptedReply !== null ? decryptedReply : m.reply_content;
      }
      return {
        ...m,
        content: plain !== null ? plain : m.content,
        reply_content: replyPlain,
      };
    }));

    const area = document.getElementById('messages-area');
    const oldHeight = area.scrollHeight;
    const oldTop = area.scrollTop;

    // Prepend
    const fragment = document.createDocumentFragment();
    let prevNick = null;
    decrypted.forEach(msg => {
      const isCont = msg.nickname === prevNick;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = Messages._msgHtml ? '' : `<!-- ${msg.id} -->`;
      // Reuse internal rendering via DOM manipulation
      const tmp = document.createElement('div');
      // We call the private _msgHtml indirectly via a public wrapper
      tmp.innerHTML = `<div data-tmp="1"></div>`;
      fragment.appendChild(tmp);
      prevNick = msg.nickname;
    });

    // Simpler: reload from REST and keep scroll position
    State.oldestMsgId = decrypted[0].id;
    State.messages[room] = [...decrypted, ...(State.messages[room] || [])];

    // Re-render prefix messages
    decrypted.reverse().forEach(msg => {
      const el = document.createElement('div');
      el.innerHTML = _buildMsgHtml(msg, false);
      const node = el.firstChild;
      area.insertBefore(node, area.firstChild);
      if (node && node.id && typeof Messages !== 'undefined' && Messages.bindLongPress) {
        Messages.bindLongPress(node.parentElement);
      }
    });

    area.scrollTop = area.scrollHeight - oldHeight + oldTop;
  } finally {
    State.isLoadingHistory = false;
  }
}

function _buildMsgHtml(msg, isCont) {
  // Simple inline builder for older messages (avoids circular dependency)
  const time = UI.formatTime(msg.created_at);
  const content = msg.content ? UI.escHtml(msg.content).replace(/https?:\/\/[^\s]+/g, url => `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#4caf50">${url}</a>`) : '';
  const avatar = UI.avatarEl(msg.avatar, msg.nickname, 38);
  return `<div class="msg-group" id="msg-${msg.id}">
    <div class="msg-avatar" data-nick="${UI.escHtml(msg.nickname||'')}" data-bridge="${UI.escHtml(msg.bridge_platform||'')}">${avatar}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-author">${UI.escHtml(msg.display_name || msg.nickname)}</span>${msg.display_name && msg.display_name !== msg.nickname ? `<span class="msg-author-handle">@${UI.escHtml(msg.nickname)}</span>` : ''}
        <span class="msg-time">${time}</span>
      </div>
      <div class="msg-content">${content}</div>
    </div>
  </div>`;
}


// ── Admin controls ───────────────────────────────────────────────────────────

async function adminKick(nickname) {
  if (!confirm(`Kick ${nickname}? This will disconnect all their sessions.`)) return;
  try {
    const r = await apiFetch('/api/admin/kick/' + encodeURIComponent(nickname), 'POST');
    const data = await r.json();
    if (r.ok) {
      toast(data.message || 'User kicked', 'success');
    } else {
      toast(data.error || 'Failed to kick user', 'error');
    }
  } catch (e) {
    toast('Failed to kick user', 'error');
  }
}

async function adminMute(nickname) {
  const minutes = prompt(`Mute ${nickname} for how many minutes?`, '60');
  if (!minutes) return;
  const duration = parseInt(minutes, 10);
  if (isNaN(duration) || duration <= 0) {
    toast('Invalid duration', 'error');
    return;
  }
  try {
    const r = await apiFetch('/api/admin/mute/' + encodeURIComponent(nickname), 'POST', {
      reason: 'Muted by admin',
      duration_minutes: duration
    });
    const data = await r.json();
    if (r.ok) {
      toast(data.message || 'User muted', 'success');
    } else {
      toast(data.error || 'Failed to mute user', 'error');
    }
  } catch (e) {
    toast('Failed to mute user', 'error');
  }
}

async function adminBan(nickname) {
  const reason = prompt(`Ban ${nickname}? Enter reason (or leave blank):`, '');
  if (reason === null) return;  // Cancelled
  const durationStr = prompt('Ban duration in hours (leave empty for permanent):', '');
  let duration_minutes = null;
  if (durationStr && durationStr.trim()) {
    const hours = parseInt(durationStr, 10);
    if (!isNaN(hours) && hours > 0) {
      duration_minutes = hours * 60;
    }
  }
  try {
    const r = await apiFetch('/api/admin/ban/' + encodeURIComponent(nickname), 'POST', {
      reason: reason,
      duration_minutes: duration_minutes
    });
    const data = await r.json();
    if (r.ok) {
      toast(data.message || 'User banned', 'success');
    } else {
      toast(data.error || 'Failed to ban user', 'error');
    }
  } catch (e) {
    toast('Failed to ban user', 'error');
  }
}

/* ── Room-level moderation (owner / mod) ─────────────────────────────── */
async function roomKick(nickname, userId) {
  if (!State.currentRoom) return;
  if (!userId) { toast('User id unavailable', 'error'); return; }
  if (!confirm(`Kick @${nickname} from #${State.currentRoom} for 5 minutes?`)) return;
  try {
    const r = await apiFetch(`/api/rooms/${encodeURIComponent(State.currentRoom)}/bans`, 'POST', {
      user_id: userId, reason: 'Kicked by moderator', duration_minutes: 5
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) toast(`@${nickname} kicked for 5 min`, 'success');
    else toast(data.error || 'Kick failed', 'error');
  } catch { toast('Kick failed', 'error'); }
}

async function roomBan(nickname, userId) {
  if (!State.currentRoom) return;
  if (!userId) { toast('User id unavailable', 'error'); return; }
  showRoomBanModal(nickname, userId, State.currentRoom);
}

/* ── Polished room-ban modal (owner/mod input) ───────────────────────── */
function showRoomBanModal(nickname, userId, room) {
  // Tear down any previous instance
  document.getElementById('room-ban-modal')?.remove();

  const wrap = document.createElement('div');
  wrap.id = 'room-ban-modal';
  wrap.className = 'modal-backdrop';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
  const safeNick = UI.escHtml(nickname || 'user');
  const safeRoom = UI.escHtml(room || '');
  wrap.innerHTML = `
    <div role="dialog" aria-modal="true" aria-labelledby="rb-title" style="background:linear-gradient(180deg,#0d2818 0%,#0a1f12 100%);border:1px solid #1f4d2e;border-radius:14px;width:100%;max-width:460px;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden;">
      <div style="padding:18px 20px 14px;border-bottom:1px solid #1f4d2e;display:flex;align-items:center;gap:12px;">
        <div style="width:40px;height:40px;border-radius:50%;background:rgba(255,85,85,.15);display:flex;align-items:center;justify-content:center;font-size:20px;">🚫</div>
        <div style="flex:1;min-width:0;">
          <div id="rb-title" style="font-weight:700;color:#4ade80;font-size:16px;">Ban from #${safeRoom}</div>
          <div style="color:#9ca3af;font-size:13px;margin-top:2px;">Banning <span style="color:#fff;font-weight:600;">@${safeNick}</span></div>
        </div>
      </div>
      <div style="padding:16px 20px;display:flex;flex-direction:column;gap:14px;">
        <div>
          <label style="display:block;color:#a7d4b3;font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:600;">Reason <span style="color:#6b7280;text-transform:none;letter-spacing:0;font-weight:400;">(shown to the user)</span></label>
          <textarea id="rb-reason" rows="3" maxlength="500" placeholder="e.g. Spamming, harassment, off-topic…" style="width:100%;padding:10px 12px;background:#0a1812;border:1px solid #1f4d2e;border-radius:8px;color:#e5e7eb;font-family:inherit;font-size:14px;resize:vertical;min-height:70px;outline:none;"></textarea>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#6b7280;margin-top:4px;">
            <span>Be specific — they will see this</span>
            <span id="rb-count">0 / 500</span>
          </div>
        </div>
        <div>
          <label style="display:block;color:#a7d4b3;font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:600;">Duration</label>
          <select id="rb-duration" style="width:100%;padding:10px 12px;background:#0a1812;border:1px solid #1f4d2e;border-radius:8px;color:#e5e7eb;font-size:14px;outline:none;">
            <option value="60">1 hour</option>
            <option value="360">6 hours</option>
            <option value="1440" selected>1 day</option>
            <option value="10080">1 week</option>
            <option value="43200">30 days</option>
            <option value="">Permanent</option>
          </select>
        </div>
      </div>
      <div style="padding:14px 20px 18px;display:flex;gap:10px;justify-content:flex-end;border-top:1px solid #1f4d2e;background:rgba(0,0,0,.2);">
        <button id="rb-cancel" type="button" style="padding:9px 16px;background:transparent;border:1px solid #2d4a35;border-radius:8px;color:#9ca3af;cursor:pointer;font-weight:600;">Cancel</button>
        <button id="rb-confirm" type="button" style="padding:9px 18px;background:linear-gradient(180deg,#dc2626,#991b1b);border:1px solid #7f1d1d;border-radius:8px;color:#fff;cursor:pointer;font-weight:700;box-shadow:0 2px 8px rgba(220,38,38,.3);">Ban user</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const reasonEl = wrap.querySelector('#rb-reason');
  const countEl  = wrap.querySelector('#rb-count');
  const durEl    = wrap.querySelector('#rb-duration');
  const cancelBtn= wrap.querySelector('#rb-cancel');
  const okBtn    = wrap.querySelector('#rb-confirm');
  reasonEl.addEventListener('input', () => { countEl.textContent = `${reasonEl.value.length} / 500`; });
  setTimeout(() => reasonEl.focus(), 50);

  function close() { wrap.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) okBtn.click();
  }
  document.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  okBtn.addEventListener('click', async () => {
    const reason = reasonEl.value.trim();
    const dur = durEl.value;
    const duration_minutes = dur ? parseInt(dur, 10) : null;
    okBtn.disabled = true; okBtn.textContent = 'Banning…';
    try {
      const r = await apiFetch(`/api/rooms/${encodeURIComponent(room)}/bans`, 'POST', {
        user_id: userId, reason, duration_minutes
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        toast(`@${nickname} banned from #${room}`, 'success');
        close();
      } else {
        toast(data.error || 'Ban failed', 'error');
        okBtn.disabled = false; okBtn.textContent = 'Ban user';
      }
    } catch {
      toast('Ban failed', 'error');
      okBtn.disabled = false; okBtn.textContent = 'Ban user';
    }
  });
}
window.showRoomBanModal = showRoomBanModal;

/* ── Banned-user receiver: Discord-style channel close + reason modal ── */
function handleRoomBan(data) {
  try {
    const room = data.room || '';
    const reason = (data.reason || '').trim();
    const banner = data.banned_by || 'a moderator';
    const expires = data.expires_at;
    let durationLabel = 'Permanent';
    if (expires) {
      try {
        const exp = new Date(expires);
        const now = new Date();
        const ms = exp - now;
        if (ms > 0) {
          const mins = Math.round(ms / 60000);
          if (mins < 60) durationLabel = `Until ${exp.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} (${mins} min)`;
          else if (mins < 1440) durationLabel = `Until ${exp.toLocaleString([], {hour:'2-digit', minute:'2-digit'})} (${Math.round(mins/60)} h)`;
          else durationLabel = `Until ${exp.toLocaleDateString()} ${exp.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;
        }
      } catch {}
    }

    // Close the channel: navigate away if currently inside the banned room.
    try {
      if (State.currentRoom === room) {
        // Strip from sidebar / cached state, then switch to general
        if (State.rooms && Array.isArray(State.rooms)) {
          State.rooms = State.rooms.filter(r => (r?.name || r) !== room);
        }
        if (typeof Rooms !== 'undefined' && Rooms.renderRoomList) { try { Rooms.renderRoomList(); } catch {} }
        if (typeof switchRoom === 'function') {
          try { switchRoom('general'); } catch {}
        } else if (typeof Rooms !== 'undefined' && Rooms.switchRoom) {
          try { Rooms.switchRoom('general'); } catch {}
        }
      }
    } catch {}

    // Polished modal in FrogTalk theme
    document.getElementById('room-ban-notice')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'room-ban-notice';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);backdrop-filter:blur(6px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
    const safeRoom = UI.escHtml(room);
    const safeBanner = UI.escHtml(banner);
    const safeReason = reason ? UI.escHtml(reason) : '<em style="color:#6b7280;">No reason provided.</em>';
    wrap.innerHTML = `
      <div role="alertdialog" aria-modal="true" style="background:linear-gradient(180deg,#1a0d0d 0%,#0a0505 100%);border:1px solid #7f1d1d;border-radius:14px;width:100%;max-width:480px;box-shadow:0 24px 70px rgba(220,38,38,.25);overflow:hidden;">
        <div style="padding:22px 24px 16px;border-bottom:1px solid #4d1f1f;text-align:center;">
          <div style="font-size:42px;line-height:1;margin-bottom:8px;">🚫</div>
          <div style="font-weight:800;color:#fca5a5;font-size:20px;letter-spacing:.3px;">You have been banned</div>
          <div style="color:#9ca3af;font-size:14px;margin-top:6px;">from <span style="color:#fff;font-weight:700;">#${safeRoom}</span></div>
        </div>
        <div style="padding:16px 24px;display:flex;flex-direction:column;gap:12px;">
          <div>
            <div style="color:#a7d4b3;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:4px;">Reason</div>
            <div style="color:#e5e7eb;font-size:14px;line-height:1.5;background:#0a1812;border:1px solid #1f4d2e;border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;">${safeReason}</div>
          </div>
          <div style="display:flex;gap:14px;font-size:12px;">
            <div style="flex:1;">
              <div style="color:#a7d4b3;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:2px;">Banned by</div>
              <div style="color:#e5e7eb;font-weight:600;">@${safeBanner}</div>
            </div>
            <div style="flex:1;">
              <div style="color:#a7d4b3;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:2px;">Duration</div>
              <div style="color:#e5e7eb;font-weight:600;">${UI.escHtml(durationLabel)}</div>
            </div>
          </div>
        </div>
        <div style="padding:14px 24px 20px;border-top:1px solid #4d1f1f;background:rgba(0,0,0,.25);text-align:center;">
          <button id="rbn-ok" type="button" style="padding:10px 28px;background:linear-gradient(180deg,#16a34a,#15803d);border:1px solid #14532d;border-radius:8px;color:#fff;cursor:pointer;font-weight:700;box-shadow:0 2px 8px rgba(22,163,74,.3);">Return to lobby</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('#rbn-ok').addEventListener('click', close);
    document.addEventListener('keydown', function escClose(e) {
      if (e.key === 'Escape' || e.key === 'Enter') {
        close(); document.removeEventListener('keydown', escClose);
      }
    });
  } catch (e) {
    // Worst-case fallback so the user is at least told.
    try { toast(`Banned from #${data?.room || 'channel'}: ${data?.reason || ''}`, 'error'); } catch {}
  }
}
window.handleRoomBan = handleRoomBan;

// Pause the chat-embedded player adjacent to the given Send-to-player
// button so the inline iframe and the Music side-player don't double-
// play out of sync. YouTube uses its iframe postMessage API
// (enablejsapi=1 must be on the iframe src — see _renderPreview);
// Spotify's embed has no JS pause API, so we reload the iframe by
// re-assigning its src, which stops audio cleanly. SoundCloud chat
// embeds aren't iframes (they're OG cards), so nothing to pause there.
window._pauseChatEmbed = function _pauseChatEmbed(btn) {
  try {
    if (!btn || !btn.closest) return;
    const wrap = btn.closest('.yt-embed, .spotify-embed');
    if (!wrap) return;
    const iframe = wrap.querySelector('iframe');
    if (!iframe) return;
    if (wrap.classList.contains('yt-embed')) {
      try {
        iframe.contentWindow && iframe.contentWindow.postMessage(
          JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }),
          '*'
        );
      } catch {}
      // Belt + braces: if for some reason JS API isn't ready (e.g. the
      // iframe was rendered before this fix shipped and src lacks
      // enablejsapi=1), fall back to reloading the src so audio stops.
      setTimeout(() => {
        try {
          const src = iframe.getAttribute('src') || '';
          if (src && !/[?&]enablejsapi=1\b/.test(src)) {
            iframe.setAttribute('src', src);
          }
        } catch {}
      }, 250);
    } else if (wrap.classList.contains('spotify-embed')) {
      try {
        const src = iframe.getAttribute('src');
        if (src) iframe.setAttribute('src', src);
      } catch {}
    }
  } catch {}
};
