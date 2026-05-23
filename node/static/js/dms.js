/* ─── dms.js ──────────────────────────────────────────────────────────────── */
'use strict';

const SPOILER_EYE = '\u{1F441}\uFE0F';

function _dmSpoilerOverlayHtml () {
  return `<div class="spoiler-overlay" aria-hidden="true">`
    + `<span class="spoiler-overlay-pill">`
    + `<span class="spoiler-overlay-ic">${SPOILER_EYE}</span>`
    + `<span class="spoiler-overlay-txt">Tap to reveal spoiler</span>`
    + `</span></div>`;
}

let _dmChannels  = [];    // [{id, with_user_id, nickname, avatar, unread, last_msg}]
let _activeDM    = null;  // {id, nickname, avatar, user_id}
let _dmMessages  = [];    // local cache for active DM
let _dmPage      = 0;
const DM_PER_PAGE = 50;
let _dmTypingTimer = null;
let _dmReplyTo   = null;  // {id, content, nickname}
const _dmPeerPubKeyCache = new Map();
const _dmSharedKeyCache = new Map();
let _dmLoadReqSeq = 0;
const _dmHistoryCache = new Map();
const _dmHistoryMeta = new Map();

// In-memory per-message plaintext cache. Once a message has been
// successfully decrypted on this device we remember it so re-renders
// stay readable even if the ECDH shared key later becomes briefly
// unavailable (e.g. parallel race during cold start).
//
// SECURITY: previously persisted to localStorage, which made the entire
// DM history XSS-exfiltratable. Now lives only in this tab's memory and
// dies on reload. The ciphertext is still on the server and re-decrypts
// at the next history fetch — so a reload only costs one decrypt pass,
// not the user's privacy. Sweep any pre-existing localStorage entries
// from older versions on module load.
const _DM_PLAINTEXT_CACHE_MAX = 500;
const _DM_PLAINTEXT_CACHE = new Map(); // channelId -> Map<msgId, plaintext>
const _cannotDecryptToastShown = new Set();
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith('frogtalk-dm-plain-v1:')) localStorage.removeItem(k);
  }
} catch {}
function _getChannelPlainMap(channelId) {
  const key = String(channelId || 0);
  let m = _DM_PLAINTEXT_CACHE.get(key);
  if (!m) { m = new Map(); _DM_PLAINTEXT_CACHE.set(key, m); }
  return m;
}
function _rememberDMPlaintext(channelId, msgId, plaintext) {
  if (!channelId || !msgId || typeof plaintext !== 'string' || !plaintext) return;
  if (_looksEncryptedBlob(plaintext) || _dmIsLockPlaceholder(plaintext)) return;
  const map = _getChannelPlainMap(channelId);
  const key = String(msgId);
  if (map.get(key) === plaintext) return;
  map.set(key, plaintext);
  if (map.size > _DM_PLAINTEXT_CACHE_MAX) {
    // Drop oldest insertion(s) — Map preserves insertion order.
    const overflow = map.size - _DM_PLAINTEXT_CACHE_MAX;
    let i = 0;
    for (const k of map.keys()) {
      if (i++ >= overflow) break;
      map.delete(k);
    }
  }
}
function _recallDMPlaintext(channelId, msgId) {
  if (!channelId || !msgId) return null;
  const map = _DM_PLAINTEXT_CACHE.get(String(channelId));
  if (!map) return null;
  const v = map.get(String(msgId));
  if (typeof v !== 'string' || _dmIsLockPlaceholder(v)) return null;
  return v;
}
const _dmPreviewCache = {};

function _normalizeDMMessage(message) {
  if (!message) return message;
  const normalized = { ...message };
  if (Number(normalized.id || 0) > 0) {
    delete normalized._pending;
    delete normalized._nonce;
  }
  return normalized;
}

function _sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function _fetchWithTimeout(url, timeoutMs) {
  return Promise.race([
    apiFetch(url),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
  ]);
}

async function _fetchDMPageResilient(url, attempts = 2, timeoutMs = 25000) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await _fetchWithTimeout(url, timeoutMs);
      // Retry once on transient server errors; leave auth/4xx alone.
      if (res && !res.ok && res.status >= 500 && i < attempts - 1) {
        await _sleep(250 * (i + 1));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i >= attempts - 1) break;
      await _sleep(250 * (i + 1));
    }
  }
  throw lastErr || new Error('fetch_failed');
}

async function _repairActiveDMChannelId() {
  if (!_activeDM?.nickname) return false;
  try {
    const r = await apiFetch('/api/dms');
    if (!r || !r.ok) return false;
    const data = await r.json();
    const channels = data.channels || data || [];
    const targetNick = String(_activeDM.nickname || '').toLowerCase();
    const match = channels.find(ch => {
      const nick = String(ch.other_nick || ch.nickname || '').toLowerCase();
      return !!nick && nick === targetNick;
    });
    const nextId = Number(match?.id || 0);
    if (!nextId) return false;
    const curId = Number(_activeDM.id || 0);
    if (nextId === curId) return false;
    _activeDM.id = nextId;
    return true;
  } catch {
    return false;
  }
}

function _voSeenKey(msgId, channelId) {
  const uid = STATE.user?.id || '0';
  return `ft_dm_vo_seen:${uid}:${channelId || 0}:${msgId}`;
}

function _isViewOnceSeenLocal(msgId, channelId) {
  try { return localStorage.getItem(_voSeenKey(msgId, channelId)) === '1'; } catch { return false; }
}

function _markViewOnceSeenLocal(msgId, channelId) {
  try { localStorage.setItem(_voSeenKey(msgId, channelId), '1'); } catch {}
}

function _parseDMCallLog(content) {
  if (typeof content !== 'string' || !content.startsWith('[[CALLLOG]]')) return null;
  try { return JSON.parse(content.slice('[[CALLLOG]]'.length)); } catch { return null; }
}

function _parseDMSysLog(content) {
  if (typeof content !== 'string' || !content.startsWith('[[DMSYS]]')) return null;
  try { return JSON.parse(content.slice('[[DMSYS]]'.length)); } catch { return null; }
}

function _looksEncryptedBlob(content) {
  if (typeof content !== 'string') return false;
  const s = content.trim();
  if (!s || s.length < 40) return false;
  if (s.startsWith('[[CALLLOG]]') || s.startsWith('[[DMSYS]]')) return false;
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        // Track A v2 DM Double-Ratchet envelope: {v:2,t:'pre'|'msg',b:…}.
        // When decrypt fails (peer hasn't shared keys yet, cold device,
        // etc.) the raw envelope used to leak into the bubble and render
        // as plaintext JSON. Treat it as cipher so the lock placeholder
        // shows instead.
        if (obj.v === 2 && typeof obj.b === 'string' && (obj.t === 'pre' || obj.t === 'msg')) return true;
        const keys = Object.keys(obj).map(k => String(k).toLowerCase());
        const hasEncKeys = keys.includes('iv') || keys.includes('ciphertext') || keys.includes('ct') || keys.includes('tag') || keys.includes('salt');
        if (hasEncKeys) return true;
      }
    } catch {
      // Non-JSON payloads that begin with { or [ are not treated as encrypted by this branch.
    }
    return false;
  }
  if (/\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return false;
  // Bare-blob branch: only the legacy "base64(iv|cipher)" form ever lands
  // here. btoa() uses the standard alphabet, so real ciphertext contains
  // `+`, `/`, or `=` with overwhelming probability, and the random-byte
  // payload always mixes upper- and lower-case letters. Requiring one of
  // those signals stops natural-language plaintext from being mistaken
  // for cipher — e.g. a user typing "lollollollol..." 2-3 times in a row
  // used to defeat the heuristic and render as "Older message — encrypted
  // on a previous device" because the *decrypted* plaintext was then
  // re-classified as cipher and discarded by the decrypt-reject guard at
  // the message-render call site.
  if (!/^[A-Za-z0-9+/=]+$/.test(s)) return false;
  const hasB64Special = /[+/=]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  const hasLower = /[a-z]/.test(s);
  if (!hasB64Special && !(hasUpper && hasLower)) return false;
  return true;
}

function _dmPreviewText(content, hasMedia, mediaType) {
  const sys = _parseDMSysLog(content);
  if (sys) return sys.title || 'Encryption synced';
  const c = _parseDMCallLog(content);
  if (c) {
    if (c.kind === 'missed') return c.subtitle || c.title || 'Missed call';
    return c.subtitle || c.title || 'Call update';
  }
  if (_looksEncryptedBlob(content)) {
    if (_dmSkipHistoricalDecrypt()) return '🔒 From home node';
    return 'Encrypted message';
  }
  if (content) return content;
  return (hasMedia || mediaType) ? 'Media' : '';
}

function _extractDMPreviewUrl(text) {
  if (typeof text !== 'string' || !text) return '';
  const urls = text.match(/https?:\/\/[^\s<>"]+/g) || [];
  if (!urls.length) return '';
  for (const url of urls) {
    // Skip invite/short-link URLs — they get their own rich invite-card embed.
    if (/\/(?:invite|i)\/[A-Za-z0-9_-]{2,32}/.test(url)) continue;
    if (_parseDMFrogSocialUrl(url)) continue;
    // Allow regular internal links (docs/help/blog) to unfurl like any URL.
    // Only invite/social share URLs are filtered above.
    return url;
  }
  return '';
}

function _normalizeUrl(url) {
  return String(url || '').replace(/&amp;/g, '&');
}

// Re-pin the DM messages area to the bottom AFTER an async embed swap
// (post/reel/invite/profile placeholder → real card). The render-time
// auto-scroll fires before hydration completes; without this nudge the
// card pushes the latest message below the fold. Only snap if the
// viewer is already at/near the bottom — never yank someone reading
// history. DMs share #messages-area with channels, so we delegate to
// the Messages helper when available; otherwise inline the same logic.
function _dmScrollIfNearBottom() {
  if (typeof Messages !== 'undefined' && typeof Messages._scrollIfNearBottom === 'function') {
    try { Messages._scrollIfNearBottom(); return; } catch {}
  }
  const area = document.getElementById('messages-area');
  if (!area) return;
  const distance = area.scrollHeight - area.scrollTop - area.clientHeight;
  if (distance > 450) return;
  const snap = () => { area.scrollTop = area.scrollHeight; };
  requestAnimationFrame(() => { snap(); requestAnimationFrame(snap); });
}

function _parseDMFrogSocialUrl(url) {
  try {
    const parsed = new URL(_normalizeUrl(url));
    const hostOk = (parsed.hostname === 'frogtalk.xyz' || parsed.hostname === 'frogtalk.app' || parsed.hostname === 'localhost');
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

async function _loadDMSocialPostCard(msgId, postId) {
  const msgEl = document.getElementById(`msg-${msgId}`);
  if (!msgEl) return;
  const placeholder = msgEl.querySelector(`.dm-social-post-card-placeholder[data-social-post="${postId}"]`);
  if (!placeholder) return;
  try {
    const res = await apiFetch(`/api/wall/posts/${postId}`);
    if (!res.ok) {
      placeholder.outerHTML = `<span class="invite-card invite-card-invalid">❌ Post unavailable</span>`;
      _dmScrollIfNearBottom();
      return;
    }
    const p = await res.json();
    // For music posts (and any other type the chat-side richer embed
    // already handles), reuse Messages._renderRichShareEmbed so DMs get
    // the inline music mini-player + purple styling for free.
    const mediaType = String(p.media_type || '').toLowerCase();
    if (mediaType.startsWith('music/') && typeof Messages !== 'undefined' && Messages._renderRichShareEmbed) {
      placeholder.outerHTML = Messages._renderRichShareEmbed(p, 'post', Number(p.id || postId));
      _dmScrollIfNearBottom();
      return;
    }
    const rawNick = String(p.nickname || 'frog').replace(/^@+/, '').trim() || 'frog';
    const nick = esc(rawNick);
    const authorHandle =
      `<span class="share-card-name chat-share-embed-author" role="button" tabindex="0"` +
      ` onclick="event.stopPropagation();event.preventDefault();` +
      `(window.Messages&&Messages.openSocialProfile?Messages.openSocialProfile('${nick}'):void 0)">@${nick}</span>`;
    const privacy = String(p.privacy || 'public').toLowerCase();
    const label = privacy === 'public' ? 'Frog Social Post' : (privacy === 'followers' ? 'Followers Post' : 'Private Post');
    let preview = String(p.content || '').trim();
    if (!preview) {
      if (mediaType.startsWith('image/')) preview = '📷 Photo post';
      else if (mediaType.startsWith('video/')) preview = '🎬 Video post';
      else preview = 'Open this post in Frog Social';
    }
    const safePreview = esc(preview.substring(0, 90));
    const pid = Number(p.id || postId);
    placeholder.outerHTML =
      `<div class="share-card" data-social-post="${pid}" onclick="openDMSocialPost(this.dataset.socialPost)">` +
        `<div style="flex-shrink:0">${UI.avatarEl(p.avatar || null, p.nickname || 'frog', 42)}</div>` +
        `<div class="share-card-info">` +
          `<div class="share-card-label">${esc(label)}</div>` +
          `${authorHandle}` +
          `<div class="share-card-bio">${safePreview}</div>` +
        `</div>` +
      `</div>`;
    _dmScrollIfNearBottom();
  } catch {
    placeholder.outerHTML = `<span class="invite-card invite-card-invalid">❌ Could not load post</span>`;
    _dmScrollIfNearBottom();
  }
}

async function _loadDMSocialReelCard(msgId, postId) {
  const msgEl = document.getElementById(`msg-${msgId}`);
  if (!msgEl) return;
  const placeholder = msgEl.querySelector(`.dm-social-reel-card-placeholder[data-social-reel="${postId}"]`);
  if (!placeholder) return;
  try {
    const res = await apiFetch(`/api/wall/posts/${postId}`);
    if (!res.ok) {
      placeholder.outerHTML = `<span class="invite-card invite-card-invalid">❌ Reel unavailable</span>`;
      _dmScrollIfNearBottom();
      return;
    }
    const p = await res.json();
    const mediaType = String(p.media_type || '').toLowerCase();
    if (!mediaType.startsWith('video/')) {
      placeholder.outerHTML = `<span class="invite-card invite-card-invalid">❌ Not a reel</span>`;
      _dmScrollIfNearBottom();
      return;
    }
    const rawNick = String(p.nickname || 'frog').replace(/^@+/, '').trim() || 'frog';
    const nick = esc(rawNick);
    const authorHandle =
      `<span class="share-card-name chat-share-embed-author" role="button" tabindex="0"` +
      ` onclick="event.stopPropagation();event.preventDefault();` +
      `(window.Messages&&Messages.openSocialProfile?Messages.openSocialProfile('${nick}'):void 0)">@${nick}</span>`;
    let preview = String(p.content || '').trim();
    if (!preview) preview = '🎬 Watch this reel in Frog Social';
    const safePreview = esc(preview.substring(0, 90));
    const pid = Number(p.id || postId);
    placeholder.outerHTML =
      `<div class="share-card" data-social-reel="${pid}" onclick="openDMSocialReel(this.dataset.socialReel)">` +
        `<div style="flex-shrink:0">${UI.avatarEl(p.avatar || null, p.nickname || 'frog', 42)}</div>` +
        `<div class="share-card-info">` +
          `<div class="share-card-label">Frog Social Reel</div>` +
          `${authorHandle}` +
          `<div class="share-card-bio">${safePreview}</div>` +
        `</div>` +
      `</div>`;
    _dmScrollIfNearBottom();
  } catch {
    placeholder.outerHTML = `<span class="invite-card invite-card-invalid">❌ Could not load reel</span>`;
    _dmScrollIfNearBottom();
  }
}

function _hydrateDMSocialCards(msgId) {
  try {
    if (typeof Messages !== 'undefined' && typeof Messages._hydrateSpecialCards === 'function') {
      Messages._hydrateSpecialCards(msgId);
      return;
    }
    if (typeof window !== 'undefined' && window.Messages?._hydrateSpecialCards) {
      window.Messages._hydrateSpecialCards(msgId);
    }
  } catch {}
}

function _extractYouTubeVideoId(text) {
  if (typeof text !== 'string' || !text) return '';
  const urls = text.match(/https?:\/\/[^\s<>"]+/g) || [];
  for (const raw of urls) {
    try {
      const u = new URL(raw);
      const host = String(u.hostname || '').toLowerCase().replace(/^www\./, '');
      let id = '';
      if (host === 'youtu.be') {
        id = String(u.pathname || '').split('/').filter(Boolean)[0] || '';
      } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
        if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
        else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2] || '';
        else if (u.pathname.startsWith('/embed/')) id = u.pathname.split('/')[2] || '';
      }
      if (/^[A-Za-z0-9_-]{6,20}$/.test(id)) return id;
    } catch {}
  }
  return '';
}

// Discord-style "X" — sender dismisses the embed for both sides.
async function suppressDMPreview(msgId) {
  const ch = _activeDM;
  if (!ch || !msgId) return;
  try {
    const res = await apiFetch(
      `/api/dms/${ch.id}/messages/${msgId}/preview-suppress`,
      'POST'
    );
    if (!res.ok) return;
  } catch { return; }
  applyDMPreviewSuppress(msgId);
}

function applyDMPreviewSuppress(msgId) {
  try {
    const m = (_dmMessages || []).find(x => x && +x.id === +msgId);
    if (m) m.preview_suppressed = 1;
  } catch {}
  const msgEl = document.getElementById(`msg-${msgId}`);
  if (!msgEl) return;
  msgEl.querySelectorAll('.link-preview, .yt-embed, .spotify-embed').forEach(el => el.remove());
  msgEl.querySelectorAll('.preview-wrap').forEach(el => el.remove());
}
window.suppressDMPreview = suppressDMPreview;
window.applyDMPreviewSuppress = applyDMPreviewSuppress;

async function _loadDMPreview(msgId, url) {
  if (!msgId || !url) return;
  // Author-suppressed: don't fetch.
  try {
    const cached = (_dmMessages || []).find(m => m && +m.id === +msgId);
    if (cached && cached.preview_suppressed) return;
  } catch {}  if (_dmPreviewCache[url] !== undefined) {
    if (_dmPreviewCache[url]) _renderDMPreview(msgId, _dmPreviewCache[url]);
    return;
  }
  try {
    const res = await apiFetch(`/api/preview?url=${encodeURIComponent(url)}`);
    if (!res.ok) return;
    const data = await res.json();
    _dmPreviewCache[url] = data.preview;
    if (data.preview) _renderDMPreview(msgId, data.preview);
  } catch {}
}

function _renderDMPreview(msgId, preview) {
  const msgEl = document.getElementById(`msg-${msgId}`);
  if (!msgEl || msgEl.querySelector('.link-preview, .yt-embed, .spotify-embed')) return;
  const body = msgEl.querySelector('.msg-body');
  if (!body) return;

  let html = '';
  if (preview.type === 'youtube' && preview.video_id) {
    html = `
      <div class="yt-embed">
        <div class="yt-embed-frame">
          <iframe
            src="https://www.youtube.com/embed/${esc(preview.video_id)}"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
          ></iframe>
        </div>
        <div class="yt-embed-meta">
          <div class="yt-embed-info">
            <div class="yt-embed-brand">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="#ff0000"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"/><path fill="#fff" d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
              YouTube${preview.author ? ` • ${esc(preview.author)}` : ''}
            </div>
            <a href="${esc(preview.url)}" target="_blank" rel="noopener" class="yt-embed-title">${esc(preview.title || 'YouTube Video')}</a>
          </div>
        </div>
      </div>`;
  } else if (preview.type === 'spotify' && preview.embed_url) {
    const height = preview.spotify_type === 'track' ? '80' : '152';
    html = `
      <div class="spotify-embed">
        <iframe
          src="${esc(preview.embed_url)}?theme=0"
          width="100%"
          height="${height}"
          frameBorder="0"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        ></iframe>
      </div>`;
  } else {
    html = `
      <a href="${esc(preview.url)}" target="_blank" rel="noopener" class="link-preview">
        ${preview.image ? `<img class="link-preview-image" src="${esc(preview.image)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="link-preview-body">
          <div class="link-preview-head">
            ${preview.favicon ? `<img class="link-preview-favicon" src="${esc(preview.favicon)}" onerror="this.style.display='none'">` : ''}
            <span class="link-preview-site">${esc(preview.site_name || '')}</span>
          </div>
          ${preview.title ? `<div class="link-preview-title">${esc(preview.title)}</div>` : ''}
          ${preview.description ? `<div class="link-preview-desc">${esc(preview.description.substring(0, 150))}${preview.description.length > 150 ? '…' : ''}</div>` : ''}
        </div>
      </a>`;
  }

  body.insertAdjacentHTML('beforeend', html);

  // Discord-style "X" — sender-only. Wrap in a sibling div so the X is
  // OUTSIDE the <a target="_blank"> embed, otherwise some browsers
  // navigate on pointerdown before our preventDefault fires.
  try {
    const cached = (_dmMessages || []).find(m => m && +m.id === +msgId);
    const myId = STATE.user?.id;
    const myNick = STATE.user?.nickname;
    const isOwn = cached && (
      (cached.sender_id != null && myId != null && +cached.sender_id === +myId) ||
      (!!cached.sender_nick && !!myNick && cached.sender_nick === myNick)
    );
    if (isOwn) {
      const newEmbed = body.querySelector(':scope > .link-preview:last-child, :scope > .yt-embed:last-child, :scope > .spotify-embed:last-child');
      if (newEmbed && !newEmbed.parentElement?.classList.contains('preview-wrap')) {
        const wrap = document.createElement('div');
        wrap.className = 'preview-wrap';
        newEmbed.parentNode.insertBefore(wrap, newEmbed);
        wrap.appendChild(newEmbed);
        newEmbed.classList.add('preview-wrap__inner');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'preview-suppress-btn';
        btn.title = 'Remove preview';
        btn.setAttribute('aria-label', 'Remove preview');
        btn.textContent = '\u00d7';
        const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
        btn.addEventListener('mousedown', swallow, true);
        btn.addEventListener('pointerdown', swallow, true);
        btn.addEventListener('touchstart', swallow, { capture: true, passive: false });
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          suppressDMPreview(msgId);
        }, true);
        wrap.appendChild(btn);
      }
    }
  } catch {}

  const area = document.getElementById('messages-area');
  if (area && (area.scrollHeight - area.scrollTop - area.clientHeight) < 140) {
    requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; });
  }
}



async function _getDMSharedKey(_peerId, _opts = {}) {
  // Track H cleanup: legacy v1 ECDH shared-key derivation is gone. All
  // new DM crypto goes through Signal Protocol (`window.Signal`). This
  // stub is kept so callers don't crash; it always returns null.
  return null;
}

function _invalidateDMPeerKey(_peerId) {
  // Track H cleanup: no caches left to invalidate.
}

// ── Decrypted-plaintext cache ──────────────────────────────────────────
//
// Signal Double-Ratchet advances state on the FIRST successful decrypt.
// If we then try to decrypt the same envelope again (e.g. sidebar preview
// load, then channel-open history reload, then a WS retransmit), libsignal
// returns "Bad MAC" / "Message key not found" because the chain has moved.
// Fix: remember the plaintext we computed, keyed by the ciphertext itself,
// and short-circuit any subsequent decrypt attempt for the same envelope.
// Backed by localStorage so the cache survives reloads (the DM history we
// pull from the server is what re-triggers the duplicate decrypts).
const _DM_PT_CACHE_KEY  = 'ft_dm_pt_v1';
const _DM_PT_CACHE_CAP  = 4000;          // entries
const _dmPtCache        = new Map();     // ciphertext → plaintext
const _dmDecryptInflight = new Map();   // cache-key → Promise (one ratchet step)
let   _dmPtCacheLoaded  = false;
let   _dmPtCacheDirty   = false;
let   _dmPtCacheSaveT   = 0;

function _dmPtCacheLoad() {
  if (_dmPtCacheLoaded) return;
  _dmPtCacheLoaded = true;
  try {
    const raw = localStorage.getItem(_DM_PT_CACHE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        _dmPtCache.set(k, String(obj[k] || ''));
      }
    }
  } catch {}
}

function _dmPtCacheSave() {
  if (!_dmPtCacheDirty) return;
  _dmPtCacheDirty = false;
  try {
    const out = {};
    // Insertion order = LRU-ish (we re-insert on every hit).
    let n = 0;
    for (const [k, v] of _dmPtCache) {
      if (++n > _DM_PT_CACHE_CAP) break;
      out[k] = v;
    }
    localStorage.setItem(_DM_PT_CACHE_KEY, JSON.stringify(out));
  } catch {}
}

function _dmPtCacheKey(cipher) {
  // Server JSON-roundtrip may reorder envelope keys / change whitespace
  // vs the client-side JSON.stringify used at send time, so keying on
  // the raw string misses on history reload. Normalize v2 envelopes to
  // their inner `b` ciphertext (base64, identity-unique per message).
  if (!cipher || typeof cipher !== 'string') return String(cipher || '');
  if (cipher.length < 9 || cipher[0] !== '{') return cipher;
  try {
    const env = JSON.parse(cipher);
    if (env && env.v === 2 && typeof env.b === 'string'
        && (env.t === 'sk' || env.t === 'pre' || env.t === 'msg')) {
      return 'v2:' + env.t + ':' + env.b;
    }
  } catch {}
  return cipher;
}

function _dmPtCacheGet(cipher) {
  _dmPtCacheLoad();
  const k = _dmPtCacheKey(cipher);
  // Back-compat: also probe the legacy raw-string key.
  return _dmPtCache.get(k) ?? _dmPtCache.get(cipher);
}

function _dmPtCachePut(cipher, plain) {
  _dmPtCacheLoad();
  const k = _dmPtCacheKey(cipher);
  // Refresh insertion order.
  if (_dmPtCache.has(k)) _dmPtCache.delete(k);
  _dmPtCache.set(k, String(plain));
  // Evict oldest if over cap.
  while (_dmPtCache.size > _DM_PT_CACHE_CAP) {
    const firstKey = _dmPtCache.keys().next().value;
    if (firstKey === undefined) break;
    _dmPtCache.delete(firstKey);
  }
  _dmPtCacheDirty = true;
  if (!_dmPtCacheSaveT) {
    _dmPtCacheSaveT = setTimeout(() => {
      _dmPtCacheSaveT = 0;
      _dmPtCacheSave();
    }, 250);
  }
}

// Flush any pending debounced DM-cache write synchronously. Called on
// pagehide/beforeunload and on logout so a send → logout → login within
// the 250ms save debounce window doesn't lose own-message plaintext.
function _dmPtCacheFlush() {
  try {
    if (_dmPtCacheSaveT) { clearTimeout(_dmPtCacheSaveT); _dmPtCacheSaveT = 0; }
    _dmPtCacheSave();
  } catch {}
}
try {
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', _dmPtCacheFlush);
    window.addEventListener('beforeunload', _dmPtCacheFlush);
  }
} catch {}

function _resolveOwnDMPlaintext(cipher, msgId, channelId) {
  const raw = String(cipher || '');
  if (!raw) return '';
  const cached = _dmPtCacheGet(raw);
  if (typeof cached === 'string' && cached.length) return cached;
  const byMsg = _recallDMPlaintext(channelId, msgId);
  if (byMsg) return byMsg;
  const pend = _dmMessages.find(x => x._pending && x.content && !_looksEncryptedBlob(x.content));
  if (pend?.content) return pend.content;
  return '';
}

const _dmDecryptWarned = new Set();
const _dmDecryptPermafail = new Set();
const _dmPeerRecoveryAttempted = new Set();
const _dmCryptoResyncAt = new Map(); // peerUserId -> last attempt ms
const _DM_CRYPTO_RESYNC_COOLDOWN_MS = 10 * 60 * 1000;
const _DM_DECRYPT_LOCKED_HOME = '\u{1F512} Encrypted on your home node';

function _dmIsLockPlaceholder(text) {
  const s = String(text || '');
  return s.includes('\u{1F512}') && (
    s.includes('keys not available')
    || s.includes('From home node')
    || s.includes('Encrypted on your home node')
    || s.includes('keys out of sync')
    || s.includes('Could not unlock')
    || s.includes('waiting for encryption sync')
    || s.includes('Syncing from your home')
    || s.includes('Sync failed')
    || s.includes('Encryption sync incomplete')
    || s.includes('Import a .key')
    || s.includes('import keys')
    || s.includes('Starting encryption')
    || s.includes('Cannot fetch encryption')
  );
}

function _federationSyncSnapshot() {
  try {
    const raw = (window.FtSync && typeof FtSync.state === 'function')
      ? FtSync.state()
      : ((window.App && App.federationSyncState) || window.__ftFederationSync || {});
    return (window.FtSync && typeof FtSync.normalizeState === 'function')
      ? FtSync.normalizeState(raw)
      : (raw && typeof raw === 'object' ? raw : {});
  } catch {
    return {};
  }
}

/** Why a bubble is still locked — drives user-visible placeholder text. */
function _dmDecryptLockContext(peerId, live) {
  const pid = Number(peerId) || 0;
  const sync = _federationSyncSnapshot();

  if (sync.in_progress || _federationSyncInProgress()) {
    return { reason: 'sync_in_progress', hint: String(sync.hint || '').trim() };
  }

  const err = String(sync.error || '').trim();
  const syncDone = !!sync.done && !sync.in_progress;
  if (syncDone && err) {
    const coreOk = window.FtSync && FtSync.federationSyncCoreComplete
      ? FtSync.federationSyncCoreComplete(sync)
      : false;
    if (!coreOk) {
      const hint = (window.FtSync && FtSync.syncErrorPublicHint)
        ? FtSync.syncErrorPublicHint(err)
        : err.slice(0, 120);
      return { reason: 'sync_failed', hint };
    }
  }

  if (_dmSkipHistoricalDecrypt()) {
    return { reason: 'home_locked' };
  }

  if (pid && window.Signal && typeof window.Signal.isPeerBundleBackedOff === 'function'
      && window.Signal.isPeerBundleBackedOff(pid)) {
    return { reason: 'peer_unreachable' };
  }

  if (live) {
    return { reason: 'unlocking' };
  }

  if (!window.Signal?.isReady?.()) {
    return { reason: 'signal_boot' };
  }

  if (pid) {
    const last = _dmCryptoResyncAt.get(pid) || 0;
    if (last > 0 && (Date.now() - last) < 120000) {
      return { reason: 'sync_attempted' };
    }
  }

  if (_isTravelNode() && !window.__ftDctImported && syncDone) {
    return { reason: 'keys_needed' };
  }

  return { reason: 'decrypt_failed' };
}

function _dmLockedBubbleText(live, peerId) {
  const ctx = _dmDecryptLockContext(peerId, live);
  switch (ctx.reason) {
    case 'sync_in_progress':
      return '🔒 Syncing from your home node…';
    case 'sync_failed':
      return `🔒 Sync failed — ${ctx.hint || 'home node unreachable'}. Re-sync in Settings → Network or import keys (🗝️).`;
    case 'home_locked':
      return `${_DM_DECRYPT_LOCKED_HOME} — send a new message or import keys (🗝️).`;
    case 'peer_unreachable':
      return '🔒 Cannot reach peer node for encryption keys — try again later.';
    case 'unlocking':
      return '🔒 Unlocking…';
    case 'signal_boot':
      return '🔒 Starting encryption…';
    case 'keys_needed':
      return '🔒 Import a .key file (🗝️) to unlock older messages from home.';
    case 'sync_attempted':
      return '🔒 Encryption sync did not complete — send a new message or import keys (🗝️).';
    default:
      return '🔒 Could not unlock — send a new message or use 🗝️ Import keys.';
  }
}

async function _refreshDmLockPlaceholders() {
  if (!_activeDM?.id || !_dmMessages.length) return;
  const peerId = Number(_activeDM.user_id) || 0;
  let changed = false;
  for (const m of _dmMessages) {
    if (!m || m.deleted) continue;
    if (!_isDmLockPlaceholder(m.content) && !_dmIsLockPlaceholder(m.content)) continue;
    const next = _dmLockedBubbleText(false, peerId);
    if (next && next !== m.content) {
      m.content = next;
      changed = true;
    }
  }
  if (!changed) return;
  _dmHistoryCache.set(_activeDM.id, _dmMessages.map((x) => ({ ...x })));
  if (State.currentRoomType === 'dm' && typeof renderDMChat === 'function') {
    renderDMChat();
  }
  if (typeof renderDMChannels === 'function') {
    void renderDMChannels();
  }
}

const _dmCryptoSyncNoticeAt = new Map();

function _resetDmDecryptWarnings() {
  _dmDecryptWarned.clear();
  _dmDecryptPermafail.clear();
  _dmPeerRecoveryAttempted.clear();
}

/** Polished in-chat system line when keys were auto-synced (both users via federation). */
async function _dmPostCryptoSyncNotice(peerUserId) {
  const chId = Number(_activeDM?.id) || 0;
  const pid = Number(peerUserId) || 0;
  if (!chId || !pid) return;
  const dedupeKey = `${chId}:crypto_sync`;
  if ((_dmCryptoSyncNoticeAt.get(dedupeKey) || 0) > Date.now() - 120000) return;
  try {
    const res = await apiFetch(`/api/dms/${chId}/crypto-sync-notice`, 'POST', {
      peer_user_id: pid,
      reason: 'auto',
    });
    if (!res.ok) return;
    _dmCryptoSyncNoticeAt.set(dedupeKey, Date.now());
    const data = await res.json().catch(() => ({}));
    if (data?.message && typeof handleWSDMMessage === 'function') {
      handleWSDMMessage(data.message);
    }
  } catch (e) {
    if (window.__ftDctDebug) console.info('[dms] crypto-sync notice failed', e);
  }
}
try { window._dmPostCryptoSyncNotice = _dmPostCryptoSyncNotice; } catch {}

const _dmHistorySyncNoticeAt = new Map();

async function _dmPostHistoryKeysNotice(peerUserId, channelId) {
  const chId = Number(channelId) || 0;
  const pid = Number(peerUserId) || 0;
  if (!chId || !pid) return;
  const dedupeKey = `${chId}:history_keys`;
  if ((_dmHistorySyncNoticeAt.get(dedupeKey) || 0) > Date.now() - 600000) return;
  try {
    const res = await apiFetch(`/api/dms/${chId}/history-sync-notice`, 'POST', {
      peer_user_id: pid,
      reason: 'keys',
    });
    if (!res.ok) return;
    _dmHistorySyncNoticeAt.set(dedupeKey, Date.now());
    const data = await res.json().catch(() => ({}));
    if (data?.message && Number(_activeDM?.id) === chId && typeof handleWSDMMessage === 'function') {
      handleWSDMMessage(data.message);
    }
  } catch (e) {
    if (window.__ftDctDebug) console.info('[dms] history keys notice failed', e);
  }
}

/** After federation sync on a travel node: in-chat note when keys were not restored. */
async function afterFederationSyncHistoryNotices(opts = {}) {
  try {
    if (window.App && typeof App.isAtHomeNode === 'function' && App.isAtHomeNode()) return;
    if (window.__ftDctImported) return;
    const dmApplied = Number(opts.dmHistoryApplied || 0);
    const dmLinked = Number(opts.dmLinked || 0);
    const syncErr = String(opts.syncError || '').trim();
    const freshKeys = !!(window.DeviceCrypto && DeviceCrypto.usesFreshKeysOnTravel
      && DeviceCrypto.usesFreshKeysOnTravel());
    if (dmApplied > 0 && freshKeys) return;
    if (!freshKeys && dmApplied <= 0 && !syncErr) return;
    if (dmApplied <= 0 && dmLinked <= 0 && !syncErr) return;
    if (typeof loadDMChannels === 'function' && !_dmChannels.length) {
      await loadDMChannels();
    }
    const max = 8;
    for (const ch of _dmChannels.slice(0, max)) {
      const peerId = Number(ch.other_id || ch.with_user_id || 0);
      const chId = Number(ch.id || 0);
      if (!peerId || !chId) continue;
      await _dmPostHistoryKeysNotice(peerId, chId);
    }
  } catch (e) {
    if (window.__ftDctDebug) console.info('[dms] afterFederationSyncHistoryNotices', e);
  }
}
try {
  window.DMs = window.DMs || {};
  window.DMs.afterFederationSyncHistoryNotices = afterFederationSyncHistoryNotices;
} catch {}

/** Ask both sides to refresh Signal sessions + prekeys after a live decrypt failure. */
async function _dmTryCoordinatedResync(peerUserId) {
  const pid = Number(peerUserId) || 0;
  if (!pid || _dmSkipHistoricalDecrypt()) return;
  if (window.Signal && typeof window.Signal.isPeerBundleBackedOff === 'function'
      && window.Signal.isPeerBundleBackedOff(pid)) {
    return;
  }
  const now = Date.now();
  const last = _dmCryptoResyncAt.get(pid) || 0;
  if (now - last < _DM_CRYPTO_RESYNC_COOLDOWN_MS) return;
  _dmCryptoResyncAt.set(pid, now);
  try {
    if (window.Signal && typeof window.Signal.requestDmCryptoResync === 'function') {
      const out = await window.Signal.requestDmCryptoResync(pid);
      if (out?.ok) {
        void _dmPostCryptoSyncNotice(pid);
      }
    }
  } catch (e) {
    if (window.__ftDctDebug) console.info('[dms] coordinated resync failed', e);
  }
}

function _dmMarkDecryptPermafail(cipher) {
  const k = _dmPtCacheKey(String(cipher || ''));
  if (k) _dmDecryptPermafail.add(k);
}

try {
  window.__ftDmDecryptReset = _resetDmDecryptWarnings;
  window.addEventListener('ft:crypto-ready', () => {
    _resetDmDecryptWarnings();
    if (_activeDM?.id && _dmMessages.length && !_dmSkipHistoricalDecrypt()) {
      void _redecryptStaleDMMessages().then(() => {
        if (typeof renderDMChannels === 'function') renderDMChannels();
      });
    } else if (typeof loadDMChannels === 'function') {
      void loadDMChannels();
    } else {
      void _refreshDmLockPlaceholders();
    }
  });
  window.addEventListener('ft:federation-sync', () => {
    void _refreshDmLockPlaceholders();
  });
} catch {}

function _federationSyncInProgress() {
  try {
    const st = _federationSyncSnapshot();
    return !!(st && st.in_progress);
  } catch {
    return false;
  }
}

function _dmEncryptedPreviewLabel(peerId) {
  const ctx = _dmDecryptLockContext(peerId, false);
  switch (ctx.reason) {
    case 'sync_in_progress':
      return '🔒 Syncing…';
    case 'sync_failed':
      return '🔒 Sync failed';
    case 'home_locked':
      return '🔒 From home node';
    case 'peer_unreachable':
      return '🔒 Peer unreachable';
    case 'keys_needed':
      return '🔒 Needs .key import';
    case 'sync_attempted':
      return '🔒 Sync incomplete';
    default:
      break;
  }
  if (!window.Signal || !Signal.isReady()) return '🔒 Encrypted';
  return '🔒 Encrypted message';
}

function _isTravelNode() {
  try {
    if (window.App && typeof App.isAtHomeNode === 'function' && !App.isAtHomeNode()) {
      return true;
    }
    const here = String(window.location?.origin || '').replace(/\/$/, '').toLowerCase();
    const syncFrom = String(
      (window.App && App.getSyncSourceBase && App.getSyncSourceBase()) || ''
    ).replace(/\/$/, '').toLowerCase();
    if (syncFrom && here && syncFrom !== here) return true;
    const homeUrl = String(STATE?.user?.account_home_base_url || '').replace(/\/$/, '').toLowerCase();
    if (homeUrl && here && homeUrl !== here) return true;
    if (STATE?.user?.at_home_node === false) return true;
  } catch {}
  return false;
}

/** On travel nodes without full DCT transfer, home ciphertext stays locked here. */
function _dmSkipHistoricalDecrypt() {
  if (!_isTravelNode()) return false;
  if (window.__ftDctImported) return false;
  return true;
}

function _dmExpectedDecryptFailure(errMsg, env) {
  const msg = String(errMsg || '');
  if (msg.includes('No record for device')) return true;
  if (msg.includes('Bad MAC')) return true;
  if (env && env.t === 'pre' && _dmSkipHistoricalDecrypt()) return true;
  return false;
}

async function _decryptDMPreviewContent(cipher, peerId, _peerNick, opts = {}) {
  const raw = String(cipher || '');
  if (!raw) return '';
  if (_parseDMCallLog(raw)) return raw;

  const peerNum = Number(peerId) || 0;
  const _cacheKey = _dmPtCacheKey(raw);

  // Plaintext cache: if we've previously decrypted this exact envelope,
  // return the cached plaintext without touching the ratchet. This is
  // essential because libsignal advances state on first decrypt and
  // any second call would fail with "Bad MAC".
  const _cached = _dmPtCacheGet(raw);
  if (_cached !== undefined) return _cached;
  if (_dmDecryptPermafail.has(_cacheKey)) {
    if (opts.sidebar) return _dmEncryptedPreviewLabel(peerNum);
    return _dmLockedBubbleText(!!opts.live, peerNum);
  }

  if (_dmSkipHistoricalDecrypt() && !opts.live && _looksEncryptedBlob(raw)) {
    _dmMarkDecryptPermafail(raw);
    if (opts.sidebar) return _dmEncryptedPreviewLabel(peerNum);
    return _dmLockedBubbleText(false, peerNum);
  }

  const inflight = _dmDecryptInflight.get(_cacheKey);
  if (inflight) {
    try { return await inflight; } catch { return raw; }
  }

  const myId = STATE?.user?.id;
  // Outgoing ciphertext cannot be decrypted via a session keyed to self.
  if (myId && peerNum && (+peerNum === +myId) && _looksEncryptedBlob(raw)) {
    return raw;
  }

  if (raw.length < 9 || raw[0] !== '{' || !window.Signal) return raw;

  let env;
  try {
    env = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!env || env.v !== 2 || typeof env.b !== 'string') return raw;

  if (opts.sidebar && !window.Signal?.isReady?.()) {
    if (_federationSyncInProgress() || opts.waitForSignal) {
      return _dmEncryptedPreviewLabel(peerNum);
    }
  }

  const _tryDecrypt = async (allowSessionReset) => {
    try {
      if (!window.Signal.isReady()) {
        const meId = STATE?.user?.id;
        if (meId) await window.Signal.init(meId);
      }
    } catch {}
    if (!window.Signal.isReady() || !peerNum) return null;

    const _recoverPeerKeys = async () => {
      if (env.t === 'pre') return false;
      const rk = `live:${peerNum}`;
      if (!opts.live || _dmPeerRecoveryAttempted.has(rk)) return false;
      _dmPeerRecoveryAttempted.add(rk);
      try {
        if (typeof window.Signal.refreshPeerForDecrypt === 'function') {
          await window.Signal.refreshPeerForDecrypt(peerNum);
          return true;
        }
      } catch {}
      return false;
    };
    // Never call ensureSessionWith before decrypt — it builds an outbound
    // X3DH session and breaks inbound t:'pre' envelopes (Bad MAC).
    const _attempt = async () => {
      const out = await window.Signal.decryptDM(peerNum, env);
      if (typeof out === 'string') {
        _dmPtCachePut(raw, out);
        return out;
      }
      return null;
    };
    try {
      const plain = await _attempt();
      if (plain !== null) return plain;
    } catch (e) {
      const errMsg = String((e && e.message) || e || '');
      const expected = _dmExpectedDecryptFailure(errMsg, env) && !opts.live;
      const warnKey = `${peerNum}:${env.t || 'msg'}:${errMsg.slice(0, 40)}`;
      if (!opts.silent && !expected && !_dmDecryptWarned.has(warnKey)) {
        _dmDecryptWarned.add(warnKey);
        if (window.__ftDctDebug) {
          console.info('[dms.decryptDM] FAIL', 't=', env.t, 'from', peerNum, errMsg.slice(0, 120));
        }
      }
      const noDevice = errMsg.includes('No record for device');
      const isPre = env.t === 'pre';
      const recoverable = errMsg.includes('Bad MAC') || errMsg.includes('Message key not found')
        || noDevice || isPre;
      if (opts.live && recoverable && await _recoverPeerKeys()) {
        try {
          const out3 = await _attempt();
          if (out3 !== null) return out3;
        } catch {}
      }
      if (
        allowSessionReset
        && !noDevice
        && !isPre
        && (opts.live || !_dmSkipHistoricalDecrypt())
        && (errMsg.includes('Bad MAC') || errMsg.includes('Message key not found'))
      ) {
        try {
          if (typeof window.Signal.resetSessionWith === 'function') {
            await window.Signal.resetSessionWith(peerNum);
          }
          const out2 = await _attempt();
          if (out2 !== null) return out2;
        } catch (e2) {
          const err2 = String((e2 && e2.message) || e2 || '').slice(0, 120);
          const rk = `${peerNum}:retry:${err2.slice(0, 40)}`;
          if (!opts.silent && !expected && !_dmDecryptWarned.has(rk)) {
            _dmDecryptWarned.add(rk);
            if (window.__ftDctDebug) console.info('[dms.decryptDM] retry FAIL', err2);
          }
        }
      }
      if (!opts.live && (noDevice || isPre || errMsg.includes('Bad MAC') || expected)) {
        _dmMarkDecryptPermafail(raw);
      }
    }
    return null;
  };

  const work = (async () => {
    const plain = await _tryDecrypt(!!opts.retry);
    if (plain !== null) return plain;
    if (opts.live && peerNum && !_dmSkipHistoricalDecrypt()
        && !(window.Signal?.isPeerBundleBackedOff?.(peerNum))) {
      void _dmTryCoordinatedResync(peerNum);
    }
    if (_dmDecryptPermafail.has(_cacheKey)) {
      if (opts.sidebar) return _dmEncryptedPreviewLabel(peerNum);
      return _dmLockedBubbleText(!!opts.live, peerNum);
    }
    if (_looksEncryptedBlob(raw) && !opts.sidebar) {
      return _dmLockedBubbleText(!!opts.live, peerNum);
    }
    if (opts.sidebar && _looksEncryptedBlob(raw)) {
      return _dmEncryptedPreviewLabel(peerNum);
    }
    if (_looksEncryptedBlob(raw) && !opts.silent) {
      const warnKey = `toast:${peerNum}`;
      if (!_dmDecryptWarned.has(warnKey)) {
        _dmDecryptWarned.add(warnKey);
        try {
          let msg = 'Could not decrypt — ask your contact to send a new message.';
          if (_dmSkipHistoricalDecrypt()) {
            msg = 'Older messages from your home node stay locked here — send a new message to start a fresh encrypted thread on this node.';
          } else if (opts.federated) {
            msg = 'Encrypted message from another node — open your home node or wait for sync.';
          }
          window.UI?.showToast?.(msg, 'warning', 7000);
        } catch {}
      }
    }
    return raw;
  })();
  _dmDecryptInflight.set(_cacheKey, work);
  try {
    return await work;
  } finally {
    if (_dmDecryptInflight.get(_cacheKey) === work) {
      _dmDecryptInflight.delete(_cacheKey);
    }
  }
}

async function _decryptDMSidebarPreview(content, peerId, peerNick, lastSenderId) {
  const raw = String(content || '');
  if (!raw) return '';
  const myId = STATE?.user?.id;
  if (myId && lastSenderId != null && +lastSenderId === +myId) {
    if (!_looksEncryptedBlob(raw)) return raw;
    const cached = _dmPtCacheGet(raw);
    if (typeof cached === 'string' && cached.length && !_looksEncryptedBlob(cached)) return cached;
    return raw;
  }
  return _decryptDMPreviewContent(raw, peerId, peerNick, {
    retry: false,
    silent: true,
    sidebar: true,
    waitForSignal: true,
    live: false,
  });
}

async function _ensureActiveDMPeerUserId() {
  if (!_activeDM) return 0;
  const existing = Number(_activeDM.user_id) || 0;
  if (existing > 0) return existing;
  const ch = _dmChannels.find(c => c.id === _activeDM.id);
  const fromList = Number(ch?.with_user_id || ch?.other_id || 0) || 0;
  if (fromList > 0) {
    _activeDM.user_id = fromList;
    return fromList;
  }
  const nick = String(_activeDM.nickname || '').trim();
  if (!nick) return 0;
  try {
    const rp = await apiFetch('/api/users/search?q=' + encodeURIComponent(nick));
    if (!rp?.ok) return 0;
    const data = await rp.json();
    const users = Array.isArray(data) ? data : (data.users || []);
    const u = users.find(x => x.nickname === nick);
    if (u?.id) {
      _activeDM.user_id = u.id;
      return Number(u.id);
    }
  } catch {}
  return 0;
}

async function _redecryptStaleDMMessages() {
  const dm = _activeDM;
  if (!dm?.id || !_dmMessages.length) return;
  if (_dmSkipHistoricalDecrypt()) return;
  const peerId = Number(dm.user_id) || 0;
  const myId = Number(STATE?.user?.id) || 0;
  if (!peerId) return;
  const peerNick = String(dm.nickname || '');
  let changed = false;
  try {
    for (const m of _dmMessages) {
      if (!dm?.id || _activeDM?.id !== dm.id) break;
      if (!m?.content || !_looksEncryptedBlob(m.content)) continue;
      const mine = !!(m.sender_id != null && myId && +m.sender_id === +myId);
      let plain = '';
      if (mine) {
        plain = _resolveOwnDMPlaintext(m.content, m.id, m.channel_id || dm.id);
      } else {
        plain = await _decryptDMPreviewContent(
          m.content, peerId, peerNick, { retry: false, silent: true, live: false },
        );
      }
      if (plain && !_looksEncryptedBlob(plain)) {
        m.content = plain;
        _rememberDMPlaintext(dm.id, m.id, plain);
        changed = true;
      }
    }
  } catch (e) {
    if (window.__ftDctDebug) console.info('[dms] redecrypt stale skipped', e);
  }
  if (!changed || !dm?.id) return;
  _dmHistoryCache.set(dm.id, _dmMessages.map((x) => ({ ...x })));
  if (State.currentRoomType === 'dm' && _activeDM?.id === dm.id) renderDMChat();
}

/** Re-decrypt one bubble after Signal boots or a transient decrypt miss. */
async function _retryDecryptDMMessageInPlace(m) {
  if (!m?.id || !_activeDM?.id) return;
  const myId = Number(STATE?.user?.id) || 0;
  const mine = !!(m.sender_id != null && myId && +m.sender_id === +myId);
  if (mine) return;
  const raw = String(m.content || '');
  if (!_looksEncryptedBlob(raw)) return;
  if (_dmSkipHistoricalDecrypt()) return;
  const peerId = Number(_activeDM.user_id) || 0;
  if (!peerId) return;
  const plain = await _decryptDMPreviewContent(
    raw, peerId, String(_activeDM.nickname || ''), { retry: false, silent: true, live: true },
  );
  if (!plain || _looksEncryptedBlob(plain)) return;
  const idx = _dmMessages.findIndex(x => Number(x.id) === Number(m.id));
  if (idx < 0) return;
  _dmMessages[idx].content = plain;
  _rememberDMPlaintext(_activeDM.id, m.id, plain);
  _dmHistoryCache.set(_activeDM.id, _dmMessages.map((x) => ({ ...x })));
  const row = document.getElementById('msg-' + m.id);
  if (row && State.currentRoomType === 'dm') {
    const tmp = document.createElement('div');
    tmp.innerHTML = renderDMMessage(_dmMessages[idx]);
    const fresh = tmp.firstElementChild;
    if (fresh) row.replaceWith(fresh);
  }
}

/* ── Sidebar DM list ────────────────────────────────────────────────────────── */
async function loadDMChannels () {
  if (window.Signal && typeof Signal.ensureReady === 'function' && State?.user?.id) {
    try {
      if (!Signal.isReady()) {
        await Signal.ensureReady(State.user.id, { timeoutMs: 15000 });
      }
    } catch {}
  }
  const sidebarEl = document.getElementById('dm-channels');
  if (sidebarEl && !_dmChannels.length) {
    let syncHint = '';
    try {
      if (window.FtSync && FtSync.state().in_progress) {
        syncHint = FtSync.renderInline(FtSync.state(), { compact: true, fallback: 'Syncing DMs…' });
      }
    } catch {}
    sidebarEl.innerHTML = `<div style="padding:6px 8px"><span class="skel-line" style="width:70%;height:10px;display:block;margin-bottom:6px"></span><span class="skel-line" style="width:50%;height:10px;display:block"></span></div>${syncHint}`;
  }
  try {
    const r = await apiFetch('/api/dms');
    if (!r.ok) return;
    const data = await r.json();
    _dmChannels = await Promise.all((data.channels || data || []).map(async (ch) => {
      const peerNick = ch.other_nick || ch.nickname || '';
      const peerId = ch.other_id || ch.with_user_id || 0;
      const lastSenderId = ch.last_sender_id != null ? +ch.last_sender_id : null;
      const previewContent = await _decryptDMSidebarPreview(ch.last_msg, peerId, peerNick, lastSenderId);
      const _logMeta = _parseDMCallLog(previewContent);
      return {
        id: ch.id,
        nickname: peerNick,
        avatar: ch.other_avatar || ch.avatar || '🐸',
        unread: ch.unread || 0,
        last_msg_raw: previewContent,
        last_msg_meta: _logMeta,
        last_msg: _dmPreviewText(previewContent, false, null),
        last_msg_at: ch.last_msg_at,
        last_msg_id: ch.last_msg_id || 0,
        last_sender_id: ch.last_sender_id != null ? +ch.last_sender_id : null,
        my_last_read: ch.my_last_read || 0,
        peer_last_read: ch.peer_last_read || 0,
        other_last_seen: ch.other_last_seen || null,
        other_show_read_receipts: ch.other_show_read_receipts !== 0,
        with_user_id: peerId,
        peer_home_server_id: ch.peer_home_server_id || '',
        global_user_id: ch.other_global_user_id || '',
      };
    }));
    renderDMChannels();
  } catch (e) { console.error('loadDMChannels', e); }
}

async function hideDMChannel (channelId) {
  try {
    const r = await apiFetch(`/api/dms/${channelId}/hide`, 'POST');
    if (r.ok) {
      _dmChannels = _dmChannels.filter(c => c.id !== channelId);
      if (_activeDM?.id === channelId) {
        _activeDM = null;
        selectServer('general');
      }
      renderDMChannels();
      toast('Conversation hidden', 'info');
    }
  } catch (e) { console.error('hideDMChannel', e); }
}

async function wipeDMMessages () {
  if (!_activeDM) return;
  const ok = await UI.confirm({
    title: 'Wipe conversation',
    message: 'Delete ALL messages in this conversation? This cannot be undone.',
    confirmLabel: 'Delete all',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await apiFetch(`/api/dms/${_activeDM.id}/messages`, 'DELETE');
    if (r.ok) {
      _dmMessages = [];
      renderDMChat();
      toast('All messages wiped', 'info');
    } else {
      const d = await r.json().catch(() => ({}));
      toast(d.error || 'Failed to wipe messages', 'error');
    }
  } catch (e) { console.error('wipeDMMessages', e); }
}

function renderDMChannels () {
  // Also refresh global unread badge on the sidebar 💬 icon
  try { if (typeof updateFrogBadge === 'function') updateFrogBadge(); } catch {}
  const el = document.getElementById('dm-channels');
  if (!el) return;
  if (!_dmChannels.length) {
    el.innerHTML = '<div style="font-size:12px;color:#555;padding:4px 8px">No DMs yet</div>';
    return;
  }
  el.innerHTML = _dmChannels.map(ch => {
    const avHtml = fmtAv(ch.avatar, ch.nickname, 28);
    const avArg = JSON.stringify(ch.avatar || '');
    const nkArg = JSON.stringify(ch.nickname || '');
    // Prefer the actual last message as the preview line; fall back to
    // "last seen" presence text only when no message history exists yet.
    const mySelfId = (typeof STATE !== 'undefined' && STATE.user?.id) || (State.user?.id);
    const isMine = ch.last_sender_id != null && mySelfId != null && +ch.last_sender_id === +mySelfId;
    const isMissedCall = ch.last_msg_meta?.kind === 'missed';
    const isCallLog = ch.last_msg_meta != null;
    const previewIcon = isMissedCall ? '<span class="dm-row-preview-icon" title="Missed call">📵</span>' : '';
    const preview = ch.last_msg
      ? (isMine && !isCallLog ? 'You: ' : '') + String(ch.last_msg).replace(/\s+/g, ' ').slice(0, 60)
      : (typeof _formatLastSeen === 'function' ? _formatLastSeen(ch.other_last_seen) : '');
    const previewHtml = preview
      ? `<div class="dm-row-preview ${isMissedCall ? 'missed' : ''}">${previewIcon}<span>${esc(preview)}</span></div>`
      : '';
    const boldName = ch.unread ? 'font-weight:700;color:#e0e0e0' : '';
    return `
    <div class="channel-item ${_activeDM?.id === ch.id ? 'active' : ''}"
         onclick='openDMChannel(${ch.id}, ${nkArg}, ${avArg})'
         style="position:relative;display:flex;align-items:center;gap:8px;padding-right:32px">
      <span style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
        ${avHtml}
        <span style="flex:1;min-width:0;overflow:hidden">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${boldName}">${esc(ch.nickname)}</div>
          ${previewHtml}
        </span>
      </span>
      ${ch.unread ? `<span style="background:#4caf50;color:#000;border-radius:8px;padding:1px 6px;font-size:11px;font-weight:700">${ch.unread}</span>` : ''}
      <button class="dm-close-btn" onclick="event.stopPropagation();hideDMChannel(${ch.id})" title="Hide conversation"
        style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;color:#666;cursor:pointer;font-size:12px;padding:2px 4px;border-radius:4px;opacity:0;transition:opacity .15s"
        onmouseenter="this.style.color='#ff5555';this.style.opacity='1'" onmouseleave="this.style.color='#666'">✕</button>
    </div>`;
  }).join('');
  // Desktop: show ✕ on hover. Mobile: hide it entirely — long-press menu has
  // "Hide conversation" so we don't need a misfire-prone close button on touch.
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  el.querySelectorAll('.channel-item').forEach((item, idx) => {
    const btn = item.querySelector('.dm-close-btn');
    if (btn) {
      if (isTouch) {
        btn.style.display = 'none';
      } else {
        item.onmouseenter = () => btn.style.opacity = '1';
        item.onmouseleave = () => btn.style.opacity = '0';
      }
    }
    const ch = _dmChannels[idx];
    if (ch && typeof bindLongPress === 'function') {
      bindLongPress(item, () => {
        const items = [
          { icon: '👤', label: 'View profile', onclick: () => {
            if (typeof showUserInfo === 'function' && ch.with_user_id) showUserInfo(ch.with_user_id);
            else if (typeof openUserProfile === 'function') openUserProfile(ch.nickname);
          }},
          { icon: '✉️', label: 'Open conversation', onclick: () => openDMChannel(ch.id, ch.nickname, ch.avatar || '🐸') },
          { icon: '👁️', label: 'Mark as read', onclick: () => {
            if (_activeDM?.id !== ch.id) openDMChannel(ch.id, ch.nickname, ch.avatar || '🐸');
            else if (typeof markDMRead === 'function') markDMRead();
          }},
          { icon: '🧹', label: 'Wipe all messages', danger: true, onclick: async () => {
            if (_activeDM?.id !== ch.id) openDMChannel(ch.id, ch.nickname, ch.avatar || '🐸');
            setTimeout(() => { if (typeof wipeDMMessages === 'function') wipeDMMessages(); }, 200);
          }},
          { icon: '✕', label: 'Hide conversation', danger: true, onclick: () => { if (typeof hideDMChannel === 'function') hideDMChannel(ch.id); } },
        ];
        showActionSheet('@' + ch.nickname, items);
      });
    }
  });
}

/* ── Open / navigate ─────────────────────────────────────────────────────────── */
async function openDMChannel (id, nickname, avatar) {
  // If user lands in DMs from the empty-state welcome screen, clear the
  // welcome-mode body flag first. That mode intentionally hides #input-area
  // (display:none !important), which otherwise makes the composer vanish.
  try { document.body.classList.remove('in-welcome'); } catch {}
  try {
    const typingBar = document.getElementById('typing-bar');
    if (typingBar) typingBar.textContent = '';
  } catch {}

  // Smooth transition: if we're coming from a public channel, clear its state
  if (State.currentRoomType && State.currentRoomType !== 'dm') {
    State.currentRoom = null;
    State.currentRoomOwner = null;
    // Un-highlight public channel list
    document.querySelectorAll('#public-channels .channel-item.active').forEach(el => el.classList.remove('active'));
  }
  State.currentRoomType = 'dm';
  // If we were in a music channel, shrink the full player into the sidebar
  // mini-dock so the DM view isn't covered. Music keeps playing.
  try { window.Music?.mount?.(null, 'text'); } catch {}
  // Reset shared secret until key exchange completes for this peer
  try { STATE.sharedSecret = null; } catch {}
  // Hide E2E indicator until we confirm the handshake succeeded
  try {
    const _enc = document.getElementById('encrypt-indicator');
    if (_enc) _enc.style.display = 'none';
  } catch {}
  // Blank chat area up-front to prevent stale-message flash, but drop in a
  // spinner right away so the user always sees *something* while we derive the
  // ECDH shared secret + fetch messages.
  const area0 = document.getElementById('messages-area');
  if (area0) {
    area0.innerHTML = (typeof inlineSpinner === 'function')
      ? inlineSpinner('Opening conversation with ' + (nickname || '…') + '…')
      : '';
  }
  // DMs have no voice channel — always hide the presence bar.
  const vpb = document.getElementById('voice-presence-bar');
  if (vpb) vpb.style.display = 'none';
  // If user came from a voice-only channel, the composer may still be hidden.
  const inputArea = document.getElementById('input-area');
  if (inputArea) inputArea.style.display = '';
  // Close mobile sidebar so chat is visible
  if (typeof closeMobileSidebar === 'function') closeMobileSidebar();

  const existing = _dmChannels.find(c => c.id === id) || {};
  _activeDM    = {
    id, nickname, avatar,
    user_id: existing.with_user_id || existing.other_id || null,
    peer_last_read: existing.peer_last_read || 0,
    my_last_read:   existing.my_last_read   || 0,
    last_msg_id:    existing.last_msg_id    || 0,
    other_last_seen: existing.other_last_seen || null,
    other_show_read_receipts: existing.other_show_read_receipts !== false,
    forwarding_disabled: !!existing.forwarding_disabled,
    peer_home_server_id: existing.peer_home_server_id || '',
    global_user_id: existing.global_user_id || '',
  };
  _dmPage      = 0;
  const _cached = _dmHistoryCache.get(id);
  _dmMessages  = Array.isArray(_cached) ? _cached.map(m => ({ ...m })) : [];
  clearReplyToDM();

  // If we have recent cached history for this DM, render instantly and refresh
  // in the background to avoid blank-screen flash when switching threads.
  if (_dmMessages.length) {
    renderDMChat();
    scrollChatBottom();
    if (!_dmSkipHistoricalDecrypt()) void _redecryptStaleDMMessages();
  }

  // Switch app to DM view
  selectServer('dms');
  // Hide members list in DMs — it's a 1:1 conversation, bigger @nick in top bar
  const usersPanel = document.getElementById('users-panel');
  if (usersPanel) usersPanel.classList.add('hidden');
  document.getElementById('chat-header')?.classList.add('is-dm');
  // Highlight in sidebar
  renderDMChannels();
  // Update header — avatar + @nick, clean layout.
  // Wrap the avatar so flex doesn't squish it and it never gets cut off.
  const titleEl = document.getElementById('ch-title');
  if (titleEl) {
    const avHtml = (typeof UI !== 'undefined' && UI.avatarEl)
      ? UI.avatarEl(avatar, nickname, 34)
      : `<span class="room-title-icon">${esc(avatar || '🐸')}</span>`;
    titleEl.innerHTML = `
      <span class="dm-avatar-wrap" aria-hidden="true">${avHtml}</span>
      <span class="room-title-text" style="font-weight:700">@${esc(nickname)}</span>
    `;
    titleEl.onclick = () => { if (typeof showUserInfo === 'function') showUserInfo(nickname, _activeDM?.user_id || null); };
    titleEl.style.cursor = 'pointer';
  }
  const _setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const _setPlaceholder = (id, v) => { const el = document.getElementById(id); if (el) el.placeholder = v; };
  const _show = (id) => { const el = document.getElementById(id); if (el) el.style.display = ''; };
  _setTxt('ch-desc', _formatLastSeen(_activeDM.other_last_seen));
  _setTxt('typing-bar', '');
  const typingBar = document.getElementById('typing-bar');
  if (typingBar) typingBar.style.display = '';
  _setPlaceholder('msg-input', 'Message ' + nickname + '…');
  // Show call buttons and timer button for DMs — guard every lookup so a
  // missing element can't crash the whole open flow (which was leaving the
  // spinner hung on "Opening conversation with…").
  _show('call-voice-btn');
  _show('dm-timer-btn');
  _show('dm-keys-btn');
  _show('encrypt-btn');
  // Encode DM peer info for calls
  STATE.dmPeerNick = nickname;

  // Load messages FIRST — that's the user's primary expectation. The ECDH
  // handshake + pubkey fetch used to block this path; if either stalled the
  // spinner never went away. Now it runs in the background while the chat
  // opens immediately.
  const _openId = id;
  await _ensureActiveDMPeerUserId();
  const _meta = _dmHistoryMeta.get(id);
  const _cacheFreshMs = 15000;
  const _cacheIsFresh = !!(_meta && (Date.now() - _meta.fetchedAt) < _cacheFreshMs);
  const _cacheMatchesLast = !!(_meta && Number(_meta.lastMsgId || 0) === Number(existing.last_msg_id || 0));
  const _canSkipInitialFetch = !!(_dmMessages.length && _cacheIsFresh && _cacheMatchesLast && !(existing.unread > 0));
  const _lastCachedId = Number((_dmMessages[_dmMessages.length - 1]?.id) || 0);
  const msgsP = _canSkipInitialFetch
    ? Promise.resolve()
    : loadDMMessages(0, { afterId: _lastCachedId }).catch(e => console.error('loadDMMessages', e));
  const timerP = loadDisappearTimer().catch(e => console.error('loadDisappearTimer', e));

  // Fire-and-forget: fetch peer user_id + public key for calls/encryption.
  // Wrap each step in a 5s timeout so a slow endpoint can't leave the DM in
  // a half-opened state with no encryption indicator ever appearing.
  (async () => {
    const withTimeout = (p, ms) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
    try {
      let peerUserId = _activeDM?.user_id || null;
      // Fast path: DM list already contains peer user_id. Fallback to search
      // only when opening from contexts that don't provide with_user_id.
      if (!peerUserId) {
        const rp = await withTimeout(apiFetch('/api/users/search?q=' + encodeURIComponent(nickname)), 5000);
        if (!rp || !rp.ok) return;
        const data  = await rp.json();
        const users = Array.isArray(data) ? data : (data.users || []);
        const u = users.find(x => x.nickname === nickname);
        if (!u) return;
        peerUserId = u.id;
      }
      // User may have switched away from this DM while we were waiting —
      // only mutate state if we're still on the same conversation.
      if (!_activeDM || _activeDM.id !== _openId) return;
      _activeDM.user_id = peerUserId;
      try {
        const prof = await withTimeout(
          apiFetch('/api/users/profile/' + encodeURIComponent(nickname)),
          5000,
        );
        if (prof && prof.ok && _activeDM && _activeDM.id === _openId) {
          const pu = await prof.json();
          const sid = String(pu.peer_home_server_id || '').trim();
          if (sid) _activeDM.peer_home_server_id = sid;
          const gid = String(pu.global_user_id || '').trim();
          if (gid) _activeDM.global_user_id = gid;
        }
      } catch {}
      // Track H cleanup: legacy ECDH pubkey publish/fetch (used to seed
      // STATE.sharedSecret for v1 DM AES-GCM) was retired. Signal
      // Protocol prekey bundles do this job now and are fetched lazily
      // by Signal.encryptDM() the first time we send to this peer.
      //
      // Do not pre-warm X3DH on open — building an outbound session here
      // races inbound `t:'pre'` envelopes and causes Bad MAC on the same
      // node. Sessions are created lazily on send via encryptDM().
      try {
        if (!_dmSkipHistoricalDecrypt()) {
          if (typeof window.Signal?.isReady === 'function' && window.Signal.isReady()) {
            void _redecryptStaleDMMessages();
          } else if (typeof window.Signal?.ensureReady === 'function' && State?.user?.id) {
            window.Signal.ensureReady(State.user.id, { timeoutMs: 8000 })
              .then(() => _redecryptStaleDMMessages())
              .catch(() => {});
          }
        }
      } catch {}
    } catch (e) { /* silent — encryption is best-effort */ }
  })();

  await msgsP;
  await timerP;
  if (_activeDM?.user_id && !_dmSkipHistoricalDecrypt()) void _redecryptStaleDMMessages();
  // Only mark as read when the app is actually visible + focused. If the user
  // tapped a notification or we're restoring state in the background, defer
  // until the tab becomes visible so peers don't get a false ✓✓ read receipt.
  if (!document.hidden && document.hasFocus()) {
    markDMRead();
  } else {
    const onVisible = () => {
      if (!document.hidden && document.hasFocus() && _activeDM && _activeDM.id === id) {
        markDMRead();
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onVisible);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
  }
}

/* ── Format last-seen (Telegram-style) ─────────────────────────────────────── */
function _formatLastSeen (ts) {
  if (!ts) return 'Direct message';
  try {
    const d = new Date(ts.includes('Z') || ts.includes('+') ? ts : ts + 'Z');
    const now = Date.now();
    const diff = (now - d.getTime()) / 1000;
    if (diff < 60)       return 'online';
    if (diff < 300)      return 'last seen just now';
    if (diff < 3600)     return `last seen ${Math.floor(diff/60)} min ago`;
    if (diff < 86400)    return `last seen ${Math.floor(diff/3600)} h ago`;
    if (diff < 86400*7)  return `last seen ${Math.floor(diff/86400)} d ago`;
    return 'last seen ' + d.toLocaleDateString();
  } catch { return 'Direct message'; }
}

/* ── Mark active DM as read on server ──────────────────────────────────────── */
async function markDMRead () {
  if (!_activeDM) return;
  // Guard against marking-read while the app is backgrounded/unfocused — that
  // was leaking ✓✓ to peers for messages the user hadn't actually seen.
  if (document.hidden || !document.hasFocus()) return;
  let top = 0;
  for (const m of _dmMessages) { if ((m.id|0) > top) top = m.id|0; }
  if (!top) return;
  if (_activeDM.my_last_read >= top) return;
  _activeDM.my_last_read = top;
  try {
    await apiFetch(`/api/dms/${_activeDM.id}/read`, 'POST', { up_to: top });
  } catch {}
  // Clear unread badge in sidebar
  const ch = _dmChannels.find(c => c.id === _activeDM.id);
  if (ch) { ch.unread = 0; ch.my_last_read = top; renderDMChannels(); }
}

/* ── WS: peer read receipt ─────────────────────────────────────────────────── */
function handleWSDMRead (data) {
  const chId = data.channel_id|0;
  // Server broadcasts "last_read"; accept "up_to" as a fallback for forward-compat.
  const upTo = (data.last_read|0) || (data.up_to|0);
  if (!chId || !upTo) return;
  const ch = _dmChannels.find(c => c.id === chId);
  if (ch) ch.peer_last_read = Math.max(ch.peer_last_read||0, upTo);
  if (_activeDM && _activeDM.id === chId) {
    _activeDM.peer_last_read = Math.max(_activeDM.peer_last_read||0, upTo);
    // Only upgrade to ✓✓ (read) when BOTH users have read-receipts on.
    const myShowReceipts   = STATE.user?.show_read_receipts !== 0;
    const peerShowReceipts = _activeDM.other_show_read_receipts !== false;
    if (!(myShowReceipts && peerShowReceipts)) return;
    document.querySelectorAll('#messages-area .msg-tick[data-mine="1"]').forEach(el => {
      const mid = +el.dataset.mid;
      if (mid && mid <= _activeDM.peer_last_read) {
        el.textContent = '✓✓';
        el.classList.remove('msg-tick-pending');
        el.classList.add('msg-tick-read');
        el.title = 'Read';
      }
    });
  }
}

/* Shortcut: open DM by nickname (creates channel if needed) */
async function openDMWithNick (nick) {
  // Guard against blank/whitespace nicks — these come from notification taps
  // where dm_nick was missing/empty and would otherwise hit /api/dms/open/
  // with an empty path segment, surfacing a useless "User not found" toast.
  nick = String(nick || '').trim();
  if (!nick) return;
  const r = await apiFetch('/api/dms/open/' + encodeURIComponent(nick), 'POST');
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    toast(err.error || 'Could not open DM', 'error');
    return;
  }
  const ch = await r.json();
  const chId = ch.channel_id || ch.id;
  const avatar = ch.other_user?.avatar || '🐸';
  // Optimistically inject into sidebar so it shows up instantly even before loadDMChannels returns
  if (!_dmChannels.find(c => c.id === chId)) {
    _dmChannels.unshift({
      id: chId, nickname: nick, avatar, unread: 0,
      with_user_id: ch.other_user?.id, last_msg_id: 0,
      my_last_read: 0, peer_last_read: 0,
      other_last_seen: ch.other_user?.last_seen || null,
      other_show_read_receipts: ch.other_user?.show_read_receipts !== false,
      peer_home_server_id: ch.other_user?.peer_home_server_id || '',
      global_user_id: ch.other_user?.global_user_id || '',
    });
    renderDMChannels();
  }
  openDMChannel(chId, nick, avatar);
  // Refresh from server in background
  loadDMChannels();
}

/* DM entry button — opens last DM, empty-state if no DMs exist */
function openDMsPanel () {
  if (typeof selectServer === 'function') selectServer('dms');
  // Always refresh the list — after an app restart or server reconnect the cached
  // list may be empty or stale; without this Android users see an empty panel.
  loadDMChannels().then(() => {
    if (_dmChannels && _dmChannels.length > 0) {
      if (!_activeDM) {
        const last = _dmChannels[0];
        openDMChannel(last.id, last.nickname, last.avatar || '🐸');
      } else {
        renderDMChannels();
      }
    } else if (typeof showNewDM === 'function') {
      showNewDM();
    }
  });
}

/* ── Load messages ─────────────────────────────────────────────────────────── */
async function loadDMMessages (pageOffset = 0, options = {}) {
  if (!_activeDM) return;
  const afterId = Number(options?.afterId || 0);
  const uiRetry = Number(options?.uiRetry || 0);
  const isDelta = pageOffset === 0 && afterId > 0;
  const _reqRoomId = _activeDM.id;
  const _reqSeq = ++_dmLoadReqSeq;
  const _isReqCurrent = () => !!(_activeDM && _activeDM.id === _reqRoomId && _reqSeq === _dmLoadReqSeq);
  if (pageOffset === 0 && !isDelta) {
    const area = document.getElementById('messages-area');
    // Preserve already-rendered content (cache or prior load) and only show a
    // full spinner when there is nothing to display yet.
    if (area && (!_dmMessages || !_dmMessages.length)) {
      area.innerHTML = inlineSpinner('Loading conversation…');
    }
  }
  const url = isDelta
    ? `/api/dms/${_reqRoomId}/messages?limit=${DM_PER_PAGE}&after=${afterId}`
    : `/api/dms/${_reqRoomId}/messages?limit=${DM_PER_PAGE}&offset=${pageOffset * DM_PER_PAGE}`;
  let r;
  try {
    // One built-in retry smooths transient network hiccups so users rarely
    // need to click Retry manually.
    r = await _fetchDMPageResilient(url, 2, 25000);
  } catch (e) {
    if (!_isReqCurrent()) return;
    // Delta fetch failed — fall back to a full refresh before showing error UI.
    if (isDelta && uiRetry < 1) {
      return loadDMMessages(0, { ...options, afterId: 0, uiRetry: uiRetry + 1 });
    }
    // First visible load failure gets one silent reconnect attempt before we
    // show the hard retry panel.
    if (pageOffset === 0 && uiRetry < 2) {
      const area = document.getElementById('messages-area');
      const hasVisible = !!(_dmMessages && _dmMessages.length);
      if (area && !hasVisible) area.innerHTML = inlineSpinner('Reconnecting…');
      await _sleep(500);
      if (!_isReqCurrent()) return;
      return loadDMMessages(pageOffset, { ...options, uiRetry: uiRetry + 1 });
    }
    // Network errors hit here — show a clickable retry instead of an endless spinner.
    if (pageOffset === 0) {
      const area = document.getElementById('messages-area');
      const hasVisible = !!(_dmMessages && _dmMessages.length);
      if (area && !hasVisible) area.innerHTML = `<div style="text-align:center;color:#888;padding:32px">
        <div style="font-size:36px;margin-bottom:8px">⚠️</div>
        <div>Couldn't load messages — check your connection.</div>
        <button class="modal-btn" style="margin-top:12px" onclick="loadDMMessages(0)">Retry</button>
      </div>`;
      else if (hasVisible && typeof toast === 'function') {
        toast('Connection hiccup. Showing cached messages.', 'info', 2200);
      }
    }
    return;
  }
  if (!r || !r.ok) {
    if (!_isReqCurrent()) return;
    // Delta fetch got a bad response — retry once as a full load.
    if (isDelta && uiRetry < 1) {
      return loadDMMessages(0, { ...options, afterId: 0, uiRetry: uiRetry + 1 });
    }
    // Some errors can happen with stale channel ids after reconnect/resync;
    // refresh DM channel mapping and retry once automatically.
    if (pageOffset === 0 && uiRetry < 2 && r && (r.status === 403 || r.status === 404 || r.status === 422)) {
      const repaired = await _repairActiveDMChannelId();
      if (repaired) {
        return loadDMMessages(0, { ...options, afterId: 0, uiRetry: uiRetry + 1 });
      }
    }
    // Soft-retry once on transient server errors before showing error UI.
    if (pageOffset === 0 && uiRetry < 2 && r && r.status >= 500) {
      const area = document.getElementById('messages-area');
      const hasVisible = !!(_dmMessages && _dmMessages.length);
      if (area && !hasVisible) area.innerHTML = inlineSpinner('Reconnecting…');
      await _sleep(500);
      if (!_isReqCurrent()) return;
      return loadDMMessages(pageOffset, { ...options, uiRetry: uiRetry + 1 });
    }
    if (pageOffset === 0) {
      const area = document.getElementById('messages-area');
      const hasVisible = !!(_dmMessages && _dmMessages.length);
      if (area && !hasVisible) area.innerHTML = `<div style="text-align:center;color:#888;padding:32px">
        <div style="font-size:36px;margin-bottom:8px">⚠️</div>
        <div>Couldn't load messages (server error).</div>
        <button class="modal-btn" style="margin-top:12px" onclick="loadDMMessages(0)">Retry</button>
      </div>`;
      else if (hasVisible && typeof toast === 'function') {
        toast('Server slow right now. Keeping current messages.', 'info', 2200);
      }
    }
    return;
  }
  const data = await r.json();
  // Ignore stale responses from older requests or previous DM sessions.
  if (!_activeDM || _activeDM.id !== _reqRoomId || _reqSeq !== _dmLoadReqSeq) return;
  const rawMsgs = Array.isArray(data) ? data : (data.messages || []);
  // Resolve peer identity for decryption. _activeDM.user_id is set by the
  // background ECDH task but may not be ready yet — fall back to the
  // channel list entry which always has with_user_id populated.
  const _dmChanEntry = _dmChannels.find(c => c.id === _reqRoomId);
  const _peerUserId  = _activeDM?.user_id || _dmChanEntry?.with_user_id || _dmChanEntry?.other_id || 0;
  if (!_activeDM.user_id && _peerUserId) _activeDM.user_id = _peerUserId;
  const _peerNick    = _activeDM?.nickname || '';
  const _myIdLoad = Number(STATE?.user?.id) || 0;
  const msgs = await Promise.all(rawMsgs.map(async (msg) => {
    if (!msg) return msg;
    const next = _normalizeDMMessage(msg);
    if (next.content) {
      const mine = _myIdLoad && next.sender_id != null && +next.sender_id === +_myIdLoad;
      if (mine) {
        const own = _resolveOwnDMPlaintext(next.content, next.id, _reqRoomId);
        if (own && !_looksEncryptedBlob(own)) next.content = own;
      } else if (_dmSkipHistoricalDecrypt()) {
        next.content = _dmLockedBubbleText(false, _peerUserId);
        _dmMarkDecryptPermafail(String(msg.content || ''));
      } else {
        try {
          next.content = await _decryptDMPreviewContent(next.content, _peerUserId, _peerNick, {
            retry: false, silent: true, live: false,
          });
        } catch {}
      }
      // If decrypt didn't yield plaintext, fall back to per-device cache so
      // history that was previously decrypted on this browser stays readable.
      if (_looksEncryptedBlob(next.content)) {
        const cached = _recallDMPlaintext(_reqRoomId, next.id);
        if (cached) next.content = cached;
      } else {
        _rememberDMPlaintext(_reqRoomId, next.id, next.content);
      }
    }
    if (next.reply_content) {
      try { next.reply_content = await _decryptDMPreviewContent(next.reply_content, _peerUserId, _peerNick); } catch {}
    }
    return next;
  }));
  for (const m of msgs) {
    if (!m || !m.view_once) continue;
    const cid = m.channel_id || _reqRoomId || 0;
    if (_isViewOnceSeenLocal(m.id, cid)) m.viewed_by_me = 1;
  }
  if (pageOffset === 0) {
    if (isDelta) {
      if (msgs.length) {
        const seen = new Set(_dmMessages.map(m => Number(m.id || 0)));
        const merged = [..._dmMessages];
        for (const m of msgs) {
          const mid = Number(m?.id || 0);
          if (!mid || seen.has(mid)) continue;
          seen.add(mid);
          merged.push(m);
        }
        _dmMessages = merged;
      }
    } else {
      _dmMessages = msgs;
    }
    _dmHistoryCache.set(_reqRoomId, _dmMessages.map(m => ({ ...m })));
    _dmHistoryMeta.set(_reqRoomId, {
      fetchedAt: Date.now(),
      lastMsgId: Number((_dmMessages[_dmMessages.length - 1]?.id) || 0),
    });
    if (!isDelta || msgs.length) {
      renderDMChat();
      scrollChatBottom();
      if (!_dmSkipHistoricalDecrypt()) void _redecryptStaleDMMessages();
    }
  } else {
    _dmMessages = [...msgs, ..._dmMessages];
    // Re-render but keep scroll position
    const area = document.getElementById('messages-area');
    const prevH = area.scrollHeight;
    renderDMChat();
    area.scrollTop = area.scrollHeight - prevH;
  }
  // Clear unread badge
  const ch = _dmChannels.find(c => c.id === _reqRoomId);
  if (ch) { ch.unread = 0; renderDMChannels(); }
}

/* ── Render DM chat ──────────────────────────────────────────────────────────── */
function renderDMChat () {
  const area = document.getElementById('messages-area');
  if (!area || !_activeDM) return;
  if (!_dmMessages.length) {
    const onTravel = !!(window.App && typeof App.isAtHomeNode === 'function' && !App.isAtHomeNode());
    const travelNote = onTravel
      ? `<div style="font-size:12px;color:#7ba88f;max-width:340px;margin:14px auto 0;line-height:1.5">On a travel node, new messages use fresh encryption in this browser. Older chat history from your home node is not decrypted here — that is expected.</div>`
      : '';
    area.innerHTML = `<div style="text-align:center;color:#555;padding:48px 16px">
      <div style="display:flex;justify-content:center;margin-bottom:10px">${fmtAv(_activeDM.avatar, _activeDM.nickname, 64)}</div>
      <div style="font-size:18px;font-weight:700;margin:8px 0">This is the beginning of your DM with ${esc(_activeDM.nickname)}</div>
      <div style="font-size:13px;color:#444">Messages are end-to-end encrypted 🔒</div>
      ${travelNote}
    </div>`;
    return;
  }
  _dmMessages = _dmMessages.map(m => _normalizeDMMessage(m));
  area.innerHTML = _dmMessages.map(m => renderDMMessage(m)).join('');
  if (window.Messages && Messages.hydrateStickers) Messages.hydrateStickers(area);
  // One-shot dialog per DM session if any message body is still cipher-shaped
  // after every decrypt path AND has no plaintext cached locally. Cache
  // hits self-heal in _formatContent/_dmRenderContent, so those don't
  // count as "can't be read" — only true cache-miss undecryptables do.
  // These messages were encrypted to another device's key and can't be
  // recovered here — reset won't help. Be honest about it; offer a
  // "Learn more" path into the encryption modal.
  try {
    const cid = _activeDM?.id;
    if (cid && !_cannotDecryptToastShown.has(cid)) {
      const undec = _dmMessages.filter(m => {
        if (typeof m?.content !== 'string') return false;
        if (!_looksEncryptedBlob(m.content)) return false;
        // Self-heal candidate? If we have plaintext cached under the
        // ciphertext key, the render path will resolve it — not undec.
        try {
          if (typeof _dmPtCacheGet === 'function') {
            const _pt = _dmPtCacheGet(m.content);
            if (typeof _pt === 'string' && _pt.length) return false;
          }
        } catch {}
        return true;
      }).length;
      if (undec > 0) {
        _cannotDecryptToastShown.add(cid);
        if (typeof UI !== 'undefined' && UI.notice) {
          UI.notice({
            icon: '🔒',
            title: `${undec} older message${undec===1?'':'s'} can't be read on this device`,
            message: (() => {
              const onTravel = !!(window.App && typeof App.isAtHomeNode === 'function' && !App.isAtHomeNode());
              if (onTravel) {
                return `${undec===1?'This message was':'These messages were'} encrypted on your home node (or an earlier device) and are not shown decrypted on this travel node.\n\nSend a new message here to start a fresh encrypted thread on this node. Calls to this contact should still work after sync.`;
              }
              return `${undec===1?'This message was':'These messages were'} encrypted to an encryption key this device doesn't hold, so ${undec===1?'it':'they'} can't be unlocked here.\n\nNew messages in this chat will work normally going forward.`;
            })(),
            primaryLabel: 'Got it',
            actionLabel: 'Learn more',
          }).then(r => {
            if (r === 'action' && typeof toggleEncryptionInfo === 'function') {
              try { toggleEncryptionInfo(); } catch {}
            }
          });
        }
      }
    }
  } catch {}
  // reaction buttons now use inline onclick → showDMReactMenu, no delegation needed
  _observeDMLazyMedia(area);

  // DM link previews/embeds (YouTube/Spotify/cards), including forwarded links.
  _dmMessages.slice(-8).forEach((m, idx) => {
    if (m && m.preview_suppressed) return;
    const u = _extractDMPreviewUrl(String(m?.content || ''));
    if (!u) return;
    setTimeout(() => _loadDMPreview(m.id, u), 90 + idx * 40);
  });
  _dmMessages.slice(-20).forEach((m, idx) => {
    if (!m?.id) return;
    setTimeout(() => _hydrateDMSocialCards(m.id), 90 + idx * 25);
  });

  // Scroll to bottom — with robust pinning for late-loading media
  const forceBottom = () => { area.scrollTop = area.scrollHeight; };
  forceBottom();
  requestAnimationFrame(() => { forceBottom(); requestAnimationFrame(forceBottom); });
  const openedAt = Date.now();
  const WINDOW_MS = 8000;
  let userScrolled = false;
  const onUserScroll = () => {
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
  try {
    area.querySelectorAll('img,video').forEach(el => {
      el.addEventListener('load', () => { if (!userScrolled && Date.now() - openedAt < WINDOW_MS) forceBottom(); }, { once: true });
      el.addEventListener('loadedmetadata', () => { if (!userScrolled && Date.now() - openedAt < WINDOW_MS) forceBottom(); }, { once: true });
    });
  } catch {}
  [120, 400, 900, 1800, 3500].forEach(ms =>
    setTimeout(() => { if (!userScrolled) forceBottom(); }, ms)
  );
  setTimeout(() => {
    try { ro?.disconnect(); } catch {}
    area.removeEventListener('wheel', onUserScroll);
    area.removeEventListener('touchmove', onUserScroll);
  }, WINDOW_MS + 200);
}

function _scrollDMToBottomStable() {
  const area = document.getElementById('messages-area');
  if (!area) return;
  const go = () => { area.scrollTop = area.scrollHeight; };
  go();
  requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
  [80, 220, 500].forEach(ms => setTimeout(go, ms));
}

function _dmSysLogActionsHtml(kind) {
  const k = String(kind || '');
  if (k !== 'history_locked' && k !== 'history_import_failed') return '';
  const impPrimary = k === 'history_locked' ? ' dm-sys-log-btn-primary' : '';
  return `<div class="dm-sys-log-actions" role="group" aria-label="Encryption keys">
    <button type="button" class="dm-sys-log-btn${impPrimary}" onclick="showDmCryptoKeysModal('import')">Import keys</button>
    <button type="button" class="dm-sys-log-btn" onclick="showDmCryptoKeysModal('export')">Export keys</button>
    <button type="button" class="dm-sys-log-btn" onclick="openChatMoreMenu()">More…</button>
  </div>`;
}

function renderDMMessage (m) {
  // Loose numeric compare — server may send sender_id as string in some paths.
  const _uid = STATE.user?.id;
  const mine = (m.sender_id != null && _uid != null && (+m.sender_id === +_uid))
            || (!!m.sender_nick && !!STATE.user?.nickname && m.sender_nick === STATE.user.nickname);
  const time  = new Date(m.created_at && m.created_at.endsWith('Z') ? m.created_at : m.created_at + 'Z').toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  const avatar = m.sender_avatar || m.avatar || '🐸';
  const senderNick = m.sender_nick || '';
  const editedTag = (m.edited_at || m.edited) ? '<span class="msg-edited">(edited)</span>' : '';

  // In-chat system lines: [[DMSYS]]{"kind":"crypto_sync"|"history_locked"|...}
  if (typeof m.content === 'string' && m.content.startsWith('[[DMSYS]]')) {
    let meta = null;
    try { meta = JSON.parse(m.content.slice('[[DMSYS]]'.length)); } catch {}
    const kind = String(meta?.kind || 'info');
    const cardClass = kind === 'history_locked' ? 'dm-sys-log-locked'
      : (kind === 'history_import_ok' ? 'dm-sys-log-ok'
        : (kind === 'history_import_failed' ? 'dm-sys-log-warn' : 'dm-sys-log-crypto'));
    const title = esc(meta?.title || 'Notice');
    const subtitle = esc(meta?.subtitle || '');
    const icon = esc(meta?.icon || 'ℹ️');
    const actions = _dmSysLogActionsHtml(kind);
    return `<div class="dm-sys-log-wrap" id="msg-${m.id}" data-dmid="${m.id}">
      <div class="dm-sys-log-card ${cardClass}">
        <div class="dm-sys-log-icon">${icon}</div>
        <div class="dm-sys-log-text" style="flex:1;min-width:0">
          <div class="dm-sys-log-title">${title}</div>
          ${subtitle ? `<div class="dm-sys-log-sub">${subtitle}</div>` : ''}
          ${actions}
          <div class="dm-sys-log-time">${time}</div>
        </div>
      </div>
    </div>`;
  }

  // Special persisted call-log entries: [[CALLLOG]]{"title":"...","subtitle":"...","icon":"..."}
  if (typeof m.content === 'string' && m.content.startsWith('[[CALLLOG]]')) {
    let meta = null;
    try { meta = JSON.parse(m.content.slice('[[CALLLOG]]'.length)); } catch {}
    const callTypeRaw = (meta?.call_type === 'video') ? 'video' : 'voice';
    const peerNick = m.sender_nick || m.sender_nickname || 'Someone';
    const otherNick = _activeDM?.nickname || peerNick;
    const rawTitle = (meta?.kind === 'missed' && mine) ? 'No answer' : (meta?.title || 'Call');
    const title = esc(rawTitle);
    const icon = esc(meta?.icon || '📞');
    const kind = esc(meta?.kind || 'info');
    const callType = esc(otherNick);
    const missedOutgoing = (meta?.kind === 'missed' && mine);
    const missedIncoming = (meta?.kind === 'missed' && !mine);
    const dirClass = missedOutgoing
      ? ' dm-call-log-missed-outgoing'
      : (missedIncoming ? ' dm-call-log-missed-incoming' : '');
    let subtitleText = meta?.subtitle || '';
    if (meta?.kind === 'missed') {
      subtitleText = mine
        ? `No answer to your ${callTypeRaw} call`
        : `You missed a ${callTypeRaw} call from ${peerNick}`;
    } else if (meta?.kind === 'declined') {
      subtitleText = mine
        ? (meta?.subtitle || `${peerNick} declined`)
        : 'You declined';
    }
    const subtitle = esc(subtitleText);
    return `<div class="dm-call-log-wrap" id="msg-${m.id}" data-dmid="${m.id}">
      <div class="dm-call-log-card dm-call-log-${kind}${dirClass}">
        <div class="dm-call-log-icon">${icon}</div>
        <div class="dm-call-log-text">
          <div class="dm-call-log-title">${title} <span class="dm-call-log-pill">@${callType}</span></div>
          ${subtitle ? `<div class="dm-call-log-sub">${subtitle}</div>` : ''}
          <div class="dm-call-log-time">${time}</div>
        </div>
      </div>
    </div>`;
  }

  // WhatsApp-style tick state for own messages:
  //   ⏱  pending  — optimistic, no server id yet
  //   ✓  delivered — server stored (always shown regardless of receipt settings)
  //   ✓✓ read     — peer has read AND both users have read-receipts enabled
  let tickHtml = '';
  if (mine) {
    const myShowReceipts  = STATE.user?.show_read_receipts !== 0; // default on
    const peerShowReceipts = _activeDM && _activeDM.other_show_read_receipts !== false;
    const receiptsMutual   = myShowReceipts && peerShowReceipts;
    const hasId            = (m.id|0) > 0 && !m._pending;
    const peerRead         = hasId && _activeDM && (m.id|0) <= (_activeDM.peer_last_read|0);
    const showRead         = peerRead && receiptsMutual;

    if (!hasId) {
      tickHtml = `<span class="msg-tick msg-tick-pending" data-mine="1" data-mid="0" title="Sending…">⏱</span>`;
    } else if (showRead) {
      tickHtml = `<span class="msg-tick msg-tick-read" data-mine="1" data-mid="${m.id}" title="Read">✓✓</span>`;
    } else {
      tickHtml = `<span class="msg-tick" data-mine="1" data-mid="${m.id}" title="Delivered">✓</span>`;
    }
  }

  // Build media HTML
  let mediaHtml = '';
  const mediaUrl = m.media_url || m.media_data;
  const mimeType = m.mime_type || m.media_type || '';
  const isBlurred = !!m.media_blur && !(mimeType.startsWith('audio/'));

  // View-once: already consumed — show burned placeholder
  const chIdForSeen = m.channel_id || (_activeDM?.id ?? 0);
  const seenByMe = !!m.viewed_by_me || _isViewOnceSeenLocal(m.id, chIdForSeen);
  const seenByOther = !!m.viewed_by_other;
  const isViewOnceConsumed = !!(m.view_once && ((mine && seenByOther) || (!mine && seenByMe) || (!mediaUrl && !m.has_media)));
  if (m.view_once && ((mine && seenByOther) || (!mine && seenByMe) || (!mediaUrl && !m.has_media))) {
    mediaHtml = '<div class="view-once-viewed">🔥 ✓ <em>Seen</em></div>';
  // View-once: media present — show spoiler-style tap-to-view overlay
  } else if (m.view_once && (mediaUrl || m.has_media)) {
    const chId = m.channel_id || (_activeDM?.id ?? 0);
    const senderLabel = seenByOther ? 'Seen' : 'Sent • Awaiting view';
    const receiverLabel = 'Tap to view once';
    const label = mine ? senderLabel : receiverLabel;
    mediaHtml = `<div class="view-once-wrap" id="vo-dm-${m.id}" data-mtype="${esc(mimeType)}" data-channel="${chId}" data-media="${esc(mediaUrl || '')}" role="button" tabindex="0" onclick="revealDMViewOnce(${m.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();revealDMViewOnce(${m.id})}">
      <div class="view-once-overlay">
        <span class="view-once-icon">🔥</span>
        <span class="view-once-label">${label}</span>
      </div>
    </div>`;
  } else if (mediaUrl) {
    let inner = '';
    // DM stickers: same Shadow-DOM-isolated render path as room messages.
    const _dmHasFx = typeof mimeType === 'string' && /;\s*fx=/.test(mimeType);
    if (_dmHasFx && window.StickerFX && (mimeType.startsWith('image/') || mediaUrl.startsWith('data:image'))) {
      inner = `<span class="frog-sticker-mount"
        data-fx-src="${esc(mediaUrl)}"
        data-fx-mt="${esc(mimeType)}"
        data-fx-sender="${esc(senderNick || '')}"
        data-fx-time="${time}"
        onclick="Messages.openSticker(this)"
        style="display:inline-block;line-height:0;cursor:pointer"></span>`;
    } else if (mimeType.startsWith('image/') || (!mimeType && mediaUrl.startsWith('data:image'))) {
      // SECURITY: media_data is sender-controlled (a `data:` URL is allowed
      // by the server) and can therefore contain ' or " — escape into both
      // the src attribute and the onclick handler. Move the URL into a
      // data-* attribute and have openLightbox read this.dataset.url so
      // the URL never enters a JS-string context in the HTML parser.
      inner = `<img src="${esc(mediaUrl)}" class="msg-media" data-lburl="${esc(mediaUrl)}" onclick="openLightbox(this.dataset.lburl)" loading="lazy">`;
    } else if (mimeType.startsWith('video/') || (!mimeType && mediaUrl.startsWith('data:video'))) {
      const _vSender = esc(senderNick || '');
      const _isNote = (mimeType || '').includes('videonote=1') || /(^|\/)videonote-/.test(m.media_name || '');
      const _noteAttr = _isNote ? ' data-video-note="1"' : '';
      const _noteCls  = _isNote ? ' is-note' : '';
      const _preload  = _isNote ? 'auto' : 'metadata';
      const _badgeIco = _isNote ? '🎥' : '🎬';
      const _badgeLbl = _isNote ? 'Note' : 'Video';
      // Video notes are MediaRecorder webm; keeping the data: URL in `src`
      // wedges Android WebView at HTML-parse time. Defer to data-pending-src
      // so ChatVideo can swap to a blob: URL before any load happens.
      const _vSrcAttr = _isNote ? `data-pending-src="${esc(mediaUrl)}"` : `src="${esc(mediaUrl)}"`;
      inner = `<div class="chat-video${_noteCls}"${_noteAttr} data-sender="${_vSender}" data-time="${time}">`+
        `<div class="cv-poster"></div>`+
        `<video ${_vSrcAttr} class="msg-media clickable-media" data-sender="${_vSender}" data-time="${time}" preload="${_preload}" muted playsinline></video>`+
        `<div class="cv-loading"><div class="cv-spinner"></div></div>`+
        `<div class="cv-overlay"><div class="cv-play" aria-label="Play video" role="button"></div></div>`+
        `<div class="cv-badge"><span class="cv-icon">${_badgeIco}</span><span class="cv-dur">${_badgeLbl}</span></div>`+
      `</div>`;
    } else if (mimeType.startsWith('audio/') || (!mimeType && mediaUrl.startsWith('data:audio'))) {
      inner = `<audio src="${esc(mediaUrl)}" controls preload="metadata" style="width:260px;display:block;margin-top:6px"></audio>`;
    } else {
      const name = mediaUrl.split('/').pop();
      inner = `<a href="${esc(mediaUrl)}" target="_blank" rel="noopener noreferrer" style="color:#4caf50;display:block;margin-top:4px">📄 ${esc(name)}</a>`;
    }
    if (isBlurred) {
      // Wrap in a spoiler overlay that reveals on click. Replace the media's
      // click handler so it doesn't fire openLightbox while still blurred.
      const wrappedInner = inner
        .replace('class="msg-media"', 'class="spoiler-img msg-media"')
        .replace(/onclick="[^"]*"/, '');
      mediaHtml = `<div class="spoiler-wrap" id="sp-dm-${m.id}" onclick="revealDMSpoiler(this, event)" data-media="${esc(mediaUrl)}">
        ${_dmSpoilerOverlayHtml()}
        ${wrappedInner}
      </div>`;
    } else {
      mediaHtml = inner;
    }
  } else if (m.has_media) {
    // Auto-loading stub (IntersectionObserver kicks in via _observeDMLazyMedia).
    const icon = mimeType?.startsWith('video') ? '🎬' : mimeType?.startsWith('audio') ? '🎵' : '🖼️';
    const blurAttr = isBlurred ? ' data-blur="1"' : '';
    mediaHtml = `<div class="media-lazy auto" id="dm-media-lazy-${m.id}" data-msg-id="${m.id}" data-channel-id="${m.channel_id || _activeDM?.id || ''}" data-media-type="${esc(mimeType)}"${blurAttr}>
      <div class="media-lazy-placeholder media-lazy-auto" onclick="loadDMMedia(${m.id}, ${m.channel_id || _activeDM?.id || 0})">
        <span class="media-lazy-icon" style="font-size:20px">${icon}</span>
        <span class="media-lazy-spinner" aria-hidden="true"></span>
        <span style="font-size:12px;color:#85a89a">Loading media…</span>
      </div>
    </div>`;
  }

  // Content with formatting (links, mentions, custom emoji)
  let contentHtml = '';
  // Distinguish three empty-content cases so we don't mislabel a normal
  // text message as "Media":
  //   1. view-once / consumed       → ''
  //   2. content was an encrypted blob that failed to decrypt (key not
  //      ready yet, e.g. cold-start from a notification tap) → keep raw
  //      ciphertext out of the UI but show a clear lock placeholder
  //   3. legitimately blank (media-only message) → fall through to media
  const _rawContentOrig = (typeof m.content === 'string') ? m.content : '';
  // Self-heal: if content is still a v2 envelope (e.g. sender re-opens DM
  // after channel switch, or a re-paint pulls from cached State without
  // re-running decryptMsg), substitute the cached plaintext we seeded at
  // send/receive time. Avoids the bubble flipping to "Encrypted message".
  let _rawContent = _rawContentOrig;
  if (_rawContent && _rawContent.length >= 9 && _rawContent[0] === '{' && _looksEncryptedBlob(_rawContent)) {
    try {
      const _cachedPt = _dmPtCacheGet(_rawContentOrig);
      if (typeof _cachedPt === 'string' && _cachedPt.length) _rawContent = _cachedPt;
    } catch {}
  }
  if (_looksEncryptedBlob(_rawContent)) {
    const recalled = _recallDMPlaintext(m.channel_id || _activeDM?.id, m.id);
    if (recalled) _rawContent = recalled;
  }
  if (mine && _looksEncryptedBlob(_rawContent)) {
    const ownPlain = _resolveOwnDMPlaintext(_rawContentOrig, m.id, m.channel_id || _activeDM?.id);
    if (ownPlain) _rawContent = ownPlain;
  }
  const _isCipherBlob = _looksEncryptedBlob(_rawContent);
  const safeContent = (m.view_once || isViewOnceConsumed)
    ? ''
    : (_isCipherBlob ? '' : _rawContent);
  if (safeContent) {
    contentHtml = esc(safeContent);
    const urlRe = /https?:\/\/[^\s<>"]+/g;
    // Extract URLs to placeholders BEFORE the @mention pass so URLs that
    // legitimately contain "@" (e.g. https://www.tiktok.com/@frogtalkxyz)
    // don't get their path mistaken for a mention pill.
    const _urlSlots = [];
    contentHtml = contentHtml.replace(urlRe, url => {
      const i = _urlSlots.push(url) - 1;
      return `\x00URL${i}\x00`;
    });
    contentHtml = contentHtml.replace(/@(\w+)/g, (match, nick) => {
      const isSelf = nick.toLowerCase() === STATE.user?.nickname?.toLowerCase();
      return `<span class="mention${isSelf ? ' mention-self' : ''}">@${nick}</span>`;
    });
    contentHtml = contentHtml.replace(/\x00URL(\d+)\x00/g, (_m, i) => {
      const url = _urlSlots[+i];
      // FrogTalk channel-invite URLs → reuse the same loader as channels.
      // Match host: frogtalk.xyz, frogtalk.app, or localhost; accept both
      // legacy /invite/<code> and the short /i/<code-or-vanity> form.
      const inviteMatch = url.match(/^https?:\/\/(?:frogtalk\.(?:xyz|app)|localhost(?::\d+)?)\/(?:invite|i)\/([A-Za-z0-9_-]{2,32})\b/i);
      if (inviteMatch) {
        const code = inviteMatch[1];
        return `<span class="invite-card-placeholder" data-invite-code="${esc(code)}">` +
          `<span class="invite-card-loading">🐸 Loading invite…</span></span>`;
      }
      const social = _parseDMFrogSocialUrl(url);
      if (social?.type === 'profile') {
        return `<span class="social-profile-card-placeholder" data-social-profile="${esc(social.nickname)}">` +
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
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="msg-link" data-preview-url="${esc(url)}">${url}</a>`;
    });
    if (typeof renderCustomEmojisInText === 'function') {
      contentHtml = renderCustomEmojisInText(contentHtml);
    }
    if (typeof TextFormat !== 'undefined' && TextFormat.formatEscaped) {
      contentHtml = TextFormat.formatEscaped(contentHtml);
    }
  }
  if (!contentHtml && !mediaHtml) {
    if (_isCipherBlob || m._decryptPending) {
      const _preEnvelope = (() => {
        try {
          const o = JSON.parse(_rawContentOrig);
          return o && o.v === 2 && o.t === 'pre';
        } catch { return false; }
      })();
      contentHtml = mine
        ? '<em style="color:#888">\uD83D\uDD12 Couldn\u2019t show your sent message on this device</em>'
        : (_preEnvelope
          ? '<em style="color:#888">\uD83D\uDD12 Couldn\u2019t unlock this message — ask them to send a new one, or open the chat on the device that received it first</em>'
          : '<em style="color:#888">\uD83D\uDD12 Older message — encrypted on a previous device</em>');
    } else if (m.has_media) {
      contentHtml = '<em style="color:#444">Media</em>';
    }
  }

  // Reply quote
  const replyPreviewRaw = String(m.reply_content || '…');
  const replyPreviewSafe = _looksEncryptedBlob(replyPreviewRaw) ? 'Encrypted message' : replyPreviewRaw;
  // SECURITY/UX: never fall back to senderNick — a quote whose author is
  // the same as the message author is meaningless and used to render the
  // current user's own (truncated) name (e.g. "Frog…") as the "replied-to"
  // label on optimistic pending bubbles. Show '?' if we genuinely don't
  // know who was being replied to.
  const replyNick = m.reply_nickname || m.reply_nick || '?';
  const replyQuote = m.reply_to
    ? `<div class="msg-reply-quote" onclick="document.querySelector('[data-dmid=&quot;${m.reply_to}&quot;]')?.scrollIntoView({behavior:'smooth',block:'center'})">
        <span class="reply-quote-nick">${esc(replyNick)}</span>
        <span class="reply-quote-text">${esc(replyPreviewSafe.substring(0, 80))}</span>
      </div>`
    : '';

  // Reactions
  const reactionsHtml = _dmReactionHtml(m.reactions, m.id);

  // Actions (same style as channel messages)
  const fwdDisabled = !!(_activeDM && _activeDM.forwarding_disabled);
  const fwdBadge = (typeof Messages !== 'undefined' && Messages.forwardedBadgeHtml) ? Messages.forwardedBadgeHtml(m) : '';
  const isForwarded = !!(m && m.forwarded_from);
  const messageTextHtml = (!isForwarded && contentHtml) ? `<div class="msg-content">${contentHtml}</div>` : '';
  const _hasVisualDmMedia = !!(mediaUrl || m.has_media || m.media_blur)
    && !mimeType.startsWith('audio/')
    && !m.view_once
    && !isViewOnceConsumed;
  const canToggleDMSpoiler = _hasVisualDmMedia;
  const spoilerBtnHtml = canToggleDMSpoiler
    ? `<button class="msg-act-btn msg-spoiler-btn" data-blur="${m.media_blur ? 1 : 0}" title="${m.media_blur ? 'Remove spoiler' : 'Mark as spoiler'}" onclick="toggleDMSpoiler(${m.id})">${SPOILER_EYE}</button>`
    : '';
  // SECURITY: reply button stores reply context in data-* attrs and reads
  // them back via this.dataset.* so DM plaintext NEVER ends up interpolated
  // into a JS-string-in-HTML-attr context. The previous form
  //   onclick="replyToDM(${m.id},'${esc(senderNick)}','${esc(safeContent)}')"
  // was a stored-XSS sink because UI.escHtml() converts ' to &#39;, which
  // the HTML attribute parser decodes back to ' BEFORE handing the onclick
  // value to the JS engine. An attacker DM containing  '); fetch(...); //
  // would escape the JS string and run arbitrary code in the recipient's
  // session when they tapped Reply — bypassing E2EE because the payload
  // sits in the already-decrypted plaintext. Mirrors messages.js setReplyTo.
  const actions = `
    <div class="msg-actions">
      <button class="msg-act-btn" title="Reply" data-rid="${m.id}" data-rnick="${esc(senderNick||'')}" data-rtxt="${esc((safeContent||'').substring(0,80))}" onclick="replyToDM(+this.dataset.rid,this.dataset.rnick,this.dataset.rtxt)">↩️</button>
      <button class="msg-act-btn" title="React" onclick="showDMReactMenu(${m.id}, this)">😀</button>
      <button class="msg-act-btn" title="Copy" onclick="Messages.copyMessage(${m.id})">📋</button>
      ${fwdDisabled ? '' : `<button class="msg-act-btn" title="Forward" onclick="forwardDMMessage(${m.id})">📤</button>`}
      ${spoilerBtnHtml}
      ${mine ? `<button class="msg-act-btn" title="Edit" onclick="editDMMsg(${m.id})">✏️</button>` : ''}
      <button class="msg-act-btn danger" title="Delete" onclick="deleteDMMsg(${m.id})">🗑️</button>
    </div>
    <button class="msg-more-trigger" title="Message options" aria-label="Message options" onclick="event.stopPropagation();Messages.openActionSheet(${m.id})">⋯</button>
  `;

  return `<div class="msg-group" id="msg-${m.id}" data-dmid="${m.id}">
    <div class="msg-avatar" data-nick="${esc(senderNick||'')}">${UI.avatarEl(avatar, senderNick, 38)}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-author" onclick="showUserInfo('${esc(senderNick)}',${m.sender_id||'null'})">${m.sender_is_admin ? '👑 ' : ''}${esc(m.sender_display_name || senderNick)}</span>
        <span class="msg-time">${time}</span>
        ${tickHtml}
        ${editedTag}
      </div>
      ${replyQuote}
      ${fwdBadge}
      ${messageTextHtml}
      ${mediaHtml}
      ${reactionsHtml}
    </div>
    ${actions}
  </div>`;
}

function _dmReactionHtml (reactions, msgId) {
  if (!reactions || typeof reactions === 'string') return '';
  const obj = typeof reactions === 'object' ? reactions : {};
  // SECURITY: emoji key is server-supplied and must be treated as untrusted.
  // Store it in a data-* attr (HTML-escape via esc) and read via
  // this.dataset.emoji so it cannot break out of a JS-string-in-HTML-attr.
  // Also esc() the visible text and coerce count to a number.
  const pills = Object.entries(obj).map(([emoji, count]) => {
    const n = Number(count) || 0;
    if (n <= 0) return '';
    return `<span class="reaction-pill" data-emoji="${esc(emoji)}" onclick="toggleDMReaction(${msgId},this.dataset.emoji)">${esc(emoji)} ${n}</span>`;
  }).join('');
  if (!pills) return '';
  return `<div class="msg-reactions">${pills}</div>`;
}

function _updateDMSpoilerBtn(msgEl, blur) {
  try {
    const btn = msgEl.querySelector('.msg-spoiler-btn');
    if (btn) {
      btn.textContent = SPOILER_EYE;
      btn.title = blur ? 'Remove spoiler' : 'Mark as spoiler';
      btn.dataset.blur = blur ? '1' : '0';
    }
  } catch {}
}

function _wrapDMNodeInSpoiler(msgId, node, mediaUrl) {
  if (!node || node.closest(`#sp-dm-${msgId}`)) return;
  const wrap = document.createElement('div');
  wrap.className = 'spoiler-wrap';
  wrap.id = `sp-dm-${msgId}`;
  wrap.dataset.media = mediaUrl || '';
  wrap.onclick = (e) => revealDMSpoiler(wrap, e);
  wrap.innerHTML = _dmSpoilerOverlayHtml();
  if (node.classList?.contains('msg-media')) {
    node.classList.add('spoiler-img');
    node.removeAttribute('onclick');
  }
  const parent = node.parentNode;
  if (!parent) return;
  parent.insertBefore(wrap, node);
  wrap.appendChild(node);
}

function _unwrapDMSpoiler(msgId) {
  const wrap = document.getElementById(`sp-dm-${msgId}`);
  if (!wrap) return;
  const url = wrap.dataset.media || '';
  const inner = wrap.querySelector('.chat-video, .frog-sticker-mount, .msg-media, img.clickable-media, video.msg-media');
  if (!inner) {
    wrap.remove();
    return;
  }
  inner.classList.remove('spoiler-img');
  wrap.replaceWith(inner);
  const img = inner.matches?.('img.msg-media') ? inner : inner.querySelector?.('img.msg-media');
  if (img && url) {
    img.setAttribute('data-lburl', url);
    img.onclick = () => { try { openLightbox(url); } catch {} };
  }
  try {
    if (inner.classList?.contains('chat-video') && window.ChatVideo?.scan) {
      ChatVideo.scan(document);
    }
  } catch {}
}

function _findDMSpoilerWrapTarget(msgEl, msgId) {
  if (msgEl.querySelector(`#vo-dm-${msgId}`)) return null;
  if (msgEl.querySelector(`#sp-dm-${msgId}`)) return null;
  const chatVideo = msgEl.querySelector('.chat-video');
  if (chatVideo) return chatVideo;
  const sticker = msgEl.querySelector('.frog-sticker-mount');
  if (sticker) return sticker;
  const img = msgEl.querySelector('img.msg-media, img.clickable-media');
  if (img) return img;
  const video = msgEl.querySelector('video.msg-media');
  if (video && !video.closest('.chat-video')) return video;
  return null;
}

function applyDMMediaBlur(msgId, blur, channelId) {
  _dmMessages.forEach(m => {
    if (m && +m.id === +msgId) m.media_blur = blur ? 1 : 0;
  });
  if (!_activeDM || +_activeDM.id !== +channelId) return;
  const msgEl = document.getElementById(`msg-${msgId}`);
  if (!msgEl) return;
  const cached = _dmMessages.find(x => x && +x.id === +msgId);
  const mediaUrl = cached?.media_url || cached?.media_data || '';

  const spoilerWrap = document.getElementById(`sp-dm-${msgId}`);
  const lazyEl = document.getElementById(`dm-media-lazy-${msgId}`);

  if (!blur && spoilerWrap) {
    _unwrapDMSpoiler(msgId);
    _updateDMSpoilerBtn(msgEl, blur);
    return;
  }

  if (blur && spoilerWrap) {
    spoilerWrap.classList.remove('revealed');
    spoilerWrap.onclick = (e) => revealDMSpoiler(spoilerWrap, e);
    _updateDMSpoilerBtn(msgEl, blur);
    return;
  }

  if (blur) {
    const target = _findDMSpoilerWrapTarget(msgEl, msgId);
    if (target) {
      _wrapDMNodeInSpoiler(msgId, target, mediaUrl);
      _updateDMSpoilerBtn(msgEl, blur);
      try { Messages?.hydrateStickers?.(msgEl); } catch {}
      return;
    }
    if (lazyEl) {
      lazyEl.setAttribute('data-blur', '1');
      loadDMMedia(msgId, channelId);
      _updateDMSpoilerBtn(msgEl, blur);
      return;
    }
  }

  if (!blur && lazyEl) {
    lazyEl.setAttribute('data-blur', '0');
    _updateDMSpoilerBtn(msgEl, blur);
    return;
  }

  if (cached && !cached.media_url && !cached.media_data && cached.has_media) {
    if (blur) {
      if (!lazyEl) {
        const icon = (cached.media_type || '').startsWith('video') ? '🎬' : '🖼️';
        const stub = document.createElement('div');
        stub.className = 'media-lazy auto';
        stub.id = `dm-media-lazy-${msgId}`;
        stub.dataset.msgId = String(msgId);
        stub.dataset.channelId = String(channelId);
        stub.dataset.blur = '1';
        stub.innerHTML = `<div class="media-lazy-placeholder media-lazy-auto" onclick="loadDMMedia(${msgId}, ${channelId})">
          <span class="media-lazy-icon" style="font-size:20px">${icon}</span>
          <span class="media-lazy-spinner" aria-hidden="true"></span>
          <span style="font-size:12px;color:#85a89a">Loading media…</span>
        </div>`;
        const anchor = msgEl.querySelector('.msg-content') || msgEl.querySelector('.msg-body') || msgEl;
        anchor.appendChild(stub);
        _observeDMLazyMedia(msgEl);
      } else {
        lazyEl.setAttribute('data-blur', '1');
      }
      loadDMMedia(msgId, channelId);
    }
    _updateDMSpoilerBtn(msgEl, blur);
    return;
  }

  _updateDMSpoilerBtn(msgEl, blur);
}
window.applyDMMediaBlur = applyDMMediaBlur;

async function toggleDMSpoiler(msgId) {
  if (!_activeDM) return;
  const m = _dmMessages.find(x => x && +x.id === +msgId);
  if (!m) return;
  const next = m.media_blur ? 0 : 1;
  try {
    const res = await apiFetch(`/api/dms/${_activeDM.id}/messages/${msgId}/spoiler`, 'POST', { blur: next });
    if (!res.ok) {
      toast(`Could not toggle spoiler (${res.status})`, 'error');
      return;
    }
  } catch {
    toast('Network error toggling spoiler', 'error');
    return;
  }
  applyDMMediaBlur(msgId, !!next, _activeDM.id);
}
window.toggleDMSpoiler = toggleDMSpoiler;

/* Reveal a DM spoiler on click — unblurs and restores the image click-to-open. */
function revealDMSpoiler (wrap, ev) {
  if (!wrap || wrap.classList.contains('revealed')) return;
  try { ev && ev.stopPropagation && ev.stopPropagation(); } catch {}
  wrap.classList.add('revealed');
  // Re-wire the media's onclick → lightbox now that it's visible
  const url = wrap.dataset.media;
  const img = wrap.querySelector('img.msg-media');
  if (img && url) img.onclick = () => { try { openLightbox(url); } catch {} };
}
window.revealDMSpoiler = revealDMSpoiler;

/* Reveal a DM view-once image — load full media, show overlay. Consume only if receiver. */
async function revealDMViewOnce (msgId) {
  const msgIdx = _dmMessages.findIndex(x => +x.id === +msgId);
  const msg = msgIdx >= 0 ? _dmMessages[msgIdx] : null;
  const isSender = msg && msg.sender_id === (STATE.user?.id || 0);

  const _markViewedLocal = (forceSeenForSender = false) => {
    const i = _dmMessages.findIndex(x => +x.id === +msgId);
    const cid = (i >= 0 && _dmMessages[i].channel_id) ? _dmMessages[i].channel_id : (_activeDM?.id || 0);
    const el = document.getElementById(`vo-dm-${msgId}`);
    if (isSender) {
      if (i >= 0 && forceSeenForSender) _dmMessages[i].viewed_by_other = 1;
      const seenByOther = (i >= 0 && !!_dmMessages[i].viewed_by_other) || forceSeenForSender;
      if (el) {
        if (seenByOther) {
          el.outerHTML = '<div class="view-once-viewed">🔥 ✓ <em>Seen</em></div>';
        } else {
          const lbl = el.querySelector('.view-once-label');
          if (lbl) lbl.textContent = 'Sent • Awaiting view';
        }
      }
      return;
    }

    if (i >= 0) _dmMessages[i].viewed_by_me = 1;
    _markViewOnceSeenLocal(msgId, cid);
    if (el) el.outerHTML = '<div class="view-once-viewed">🔥 <em>Viewed</em></div>';
  };

  const el = document.getElementById(`vo-dm-${msgId}`);
  if (!el) return;
  if (el.dataset.opening === '1') return;
  el.dataset.opening = '1';

  const channelId = +(el.dataset.channel || _activeDM?.id || 0);
  const mimeType  = el.dataset.mtype || '';
  let   mediaData = el.dataset.media || '';

  // Show loading state
  const labelEl = el.querySelector('.view-once-label');
  if (labelEl) labelEl.textContent = 'Loading…';

  // If media_data wasn't inlined (lazy), fetch it first
  if (!mediaData && channelId) {
    let loaded = false;
    for (let attempt = 0; attempt < 2 && !loaded; attempt++) {
      try {
        const res = await apiFetch(`/api/dms/${channelId}/messages/${msgId}/media`);
        if (res.status === 410) {
          _markViewedLocal(isSender);
          delete el.dataset.opening;
          return;
        }
        if (!res.ok) throw new Error('load failed');
        const d = await res.json();
        mediaData = d.media_data || '';
        if (mediaData && typeof Crypto !== 'undefined' && Crypto.decryptPayload) {
          mediaData = await Crypto.decryptPayload(mediaData, STATE.sharedSecret || null);
        }
        loaded = !!mediaData;
      } catch {
        if (attempt === 0) await new Promise(r => setTimeout(r, 120));
      }
    }
    if (!loaded) {
      if (labelEl) labelEl.textContent = 'Failed to load';
      delete el.dataset.opening;
      return;
    }

    // Cache fetched media for repeat opens (important for sender re-open flow).
    el.dataset.media = mediaData || '';
  }

  if (!mediaData) {
    if (labelEl) labelEl.textContent = 'Failed to load';
    delete el.dataset.opening;
    return;
  }

  // Open in fullscreen lightbox overlay — close/backdrop click marks as viewed (receiver only)
  const overlay = document.createElement('div');
  overlay.className = 'vo-overlay';
  const safeMime = mimeType || '';
  const mediaEl = safeMime.startsWith('video')
    ? `<video class="vo-media" src="${mediaData}" autoplay controls playsinline></video>`
    : `<img class="vo-media" src="${mediaData}" alt="">`;
  const hintText = isSender
    ? '🔥 Sent • Waiting for them to open…'
    : '🔥 View Once • tap outside or close to dismiss';
  overlay.innerHTML = `
    <button class="vo-close" title="Close">✕</button>
    ${mediaEl}
    <div class="vo-hint">${hintText}</div>`;
  document.body.appendChild(overlay);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    _markViewedLocal();
    // Only consume (call /view) if receiver
    if (!isSender) {
      try { await apiFetch(`/api/dms/${channelId}/messages/${msgId}/view`, 'POST'); } catch {}
    }
    delete el.dataset.opening;
  };

  overlay.querySelector('.vo-close').addEventListener('click', () => { close(); });
  overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
  // Escape key closes too
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
}
window.revealDMViewOnce = revealDMViewOnce;

function handleWSDMViewOnceViewed (data) {
  if (!data || !data.msg_id) return;
  const myId = STATE.user?.id;
  if (myId && data.user_id && +data.user_id !== +myId) return;
  const i = _dmMessages.findIndex(x => +x.id === +data.msg_id);
  const cid = data.channel_id || ((i >= 0 && _dmMessages[i].channel_id) ? _dmMessages[i].channel_id : (_activeDM?.id || 0));
  if (i >= 0) {
    if (!data.is_sender) _dmMessages[i].viewed_by_me = 1;
    _dmMessages[i].viewed_by_other = 1;
  }
  if (!data.is_sender) _markViewOnceSeenLocal(data.msg_id, cid);
  const el = document.getElementById(`vo-dm-${data.msg_id}`);
  if (el) el.outerHTML = '<div class="view-once-viewed">🔥 ✓ <em>Seen</em></div>';
}
window.handleWSDMViewOnceViewed = handleWSDMViewOnceViewed;

function handleWSDMViewOnceViewedByPeer (data) {
  if (!data || !data.msg_id) return;
  const i = _dmMessages.findIndex(x => +x.id === +data.msg_id);
  if (i >= 0) _dmMessages[i].viewed_by_other = 1;
  const el = document.getElementById(`vo-dm-${data.msg_id}`);
  if (el) el.outerHTML = '<div class="view-once-viewed">🔥 ✓ <em>Seen</em></div>';
}
window.handleWSDMViewOnceViewedByPeer = handleWSDMViewOnceViewedByPeer;

/* ── Forwarding ─────────────────────────────────────────────────────────────── */
async function forwardDMMessage (msgId) {
  const m = _dmMessages.find(x => +x.id === +msgId);
  if (!m) { toast('Message not found'); return; }
  if (!_activeDM) return;
  if (typeof Messages === 'undefined' || !Messages.openForwardPicker) {
    toast('Forwarding unavailable'); return;
  }
  // Prepare a content payload that's plaintext-safe for forwarding.
  // DM messages may be E2EE-encrypted in `m.content`; use what's already
  // displayed to the user instead of the cipher blob.
  let plain = m.content || '';
  if (m._decrypted) plain = m._decrypted;
  await Messages.openForwardPicker({
    sourceKind: 'dm',
    sourceId: _activeDM.id,
    sourceLabel: '@' + (_activeDM.nickname || '?'),
    msg: { ...m, content: plain, nickname: m.sender_nick || m.nickname || '?' },
  });
}
window.forwardDMMessage = forwardDMMessage;

async function toggleDMForwarding (disabled) {
  if (!_activeDM) return;
  try {
    const r = await apiFetch(`/api/dms/${_activeDM.id}/forwarding`, 'POST', { disabled: disabled ? 1 : 0 });
    if (r.ok) {
      _activeDM.forwarding_disabled = !!disabled;
      const ch = _dmChannels.find(c => c.id === _activeDM.id);
      if (ch) ch.forwarding_disabled = disabled ? 1 : 0;
      toast(disabled ? 'Forwarding disabled' : 'Forwarding enabled', 'success');
      try { renderDMChat(); } catch {}
    } else {
      toast('Failed to update setting', 'error');
    }
  } catch { toast('Failed to update setting', 'error'); }
}
window.toggleDMForwarding = toggleDMForwarding;

function handleWSDMForwarding (data) {
  if (!data || !data.channel_id) return;
  const ch = _dmChannels.find(c => c.id === +data.channel_id);
  if (ch) ch.forwarding_disabled = data.disabled ? 1 : 0;
  if (_activeDM && _activeDM.id === +data.channel_id) {
    _activeDM.forwarding_disabled = !!data.disabled;
    try { renderDMChat(); } catch {}
  }
}
window.handleWSDMForwarding = handleWSDMForwarding;

/* ── Lazy-load DM media ──────────────────────────────────────────────────────── */
async function loadDMMedia (msgId, channelId) {
  const container = document.getElementById(`dm-media-lazy-${msgId}`);
  if (!container) return;
  const cached = _dmMessages.find(x => x && +x.id === +msgId);
  const isBlur = !!(cached && cached.media_blur) || container.getAttribute('data-blur') === '1';
  container.innerHTML = '<div style="padding:12px;color:#85a89a;font-size:13px">Loading…</div>';
  try {
    const res = await apiFetch(`/api/dms/${channelId}/messages/${msgId}/media`);
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    if (typeof Crypto !== 'undefined' && Crypto.decryptPayload) {
      data.media_data = await Crypto.decryptPayload(data.media_data, STATE.sharedSecret || null);
    }
    if (!data.media_data) throw new Error('Decrypt failed');
    const mediaType = data.media_type || '';
    let html;
    if (mediaType.startsWith('video')) {
      const _isNote = mediaType.includes('videonote=1') || /(^|\/)videonote-/.test(data.media_name || '');
      const _noteAttr = _isNote ? ' data-video-note="1"' : '';
      const _noteCls  = _isNote ? ' is-note' : '';
      const _preload  = _isNote ? 'auto' : 'metadata';
      const _badgeIco = _isNote ? '🎥' : '🎬';
      const _badgeLbl = _isNote ? 'Note' : 'Video';
      // See render-side comment: notes go through data-pending-src so the
      // WebView never tries to parse the multi-MB webm data: URL.
      const _vSrcAttr = _isNote ? `data-pending-src="${esc(data.media_data)}"` : `src="${esc(data.media_data)}"`;
      html = `<div class="chat-video${_noteCls}"${_noteAttr}>`+
        `<div class="cv-poster"></div>`+
        `<video ${_vSrcAttr} class="msg-media clickable-media" preload="${_preload}" muted playsinline></video>`+
        `<div class="cv-loading"><div class="cv-spinner"></div></div>`+
        `<div class="cv-overlay"><div class="cv-play" aria-label="Play video" role="button"></div></div>`+
        `<div class="cv-badge"><span class="cv-icon">${_badgeIco}</span><span class="cv-dur">${_badgeLbl}</span></div>`+
      `</div>`;
      // ChatVideo's MutationObserver only fires for newly-added nodes; the
      // outerHTML swap below replaces an existing element, so kick the scan
      // manually right after to ensure poster generation + themed overlay
      // run on the freshly-rendered video.
      try { setTimeout(() => { try { ChatVideo?.scan?.(document); } catch {} }, 0); } catch {}
    } else if (mediaType.startsWith('audio')) {
      html = `<audio src="${esc(data.media_data)}" controls preload="metadata" style="width:260px;display:block;margin-top:6px"></audio>`;
    } else if (/;\s*fx=/.test(mediaType) && window.StickerFX) {
      // Deferred-load DM sticker — mount a placeholder and hydrate from
      // the parent container so the shadow-root sandbox stays in effect.
      html = `<span class="frog-sticker-mount" data-fx-src="${esc(data.media_data)}" data-fx-mt="${esc(mediaType)}" onclick="Messages.openSticker(this)" style="display:inline-block;line-height:0;cursor:pointer"></span>`;
    } else {
      html = `<img src="${esc(data.media_data)}" class="msg-media" data-lburl="${esc(data.media_data)}" onclick="openLightbox(this.dataset.lburl)" loading="lazy">`;
    }
    if (isBlur && !mediaType.startsWith('audio')) {
      const wrappedInner = html
        .replace('class="msg-media"', 'class="spoiler-img msg-media"')
        .replace(/onclick="[^"]*"/, '');
      html = `<div class="spoiler-wrap" id="sp-dm-${msgId}" onclick="revealDMSpoiler(this, event)" data-media="${esc(data.media_data)}">
        ${_dmSpoilerOverlayHtml()}
        ${wrappedInner}
      </div>`;
    }
    container.outerHTML = html;
    if (cached && data.media_data) {
      cached.media_url = data.media_data;
      cached.media_data = data.media_data;
    }
    try {
      if (window.Messages && Messages.hydrateStickers) Messages.hydrateStickers(document);
    } catch {}
    try { setTimeout(() => { try { ChatVideo?.scan?.(document); } catch {} }, 0); } catch {}
  } catch {
    container.innerHTML = '<div style="padding:12px;color:#d9a89f;font-size:13px">Failed to load media</div>';
  }
}

/* Auto-fetch DM lazy-media as soon as it scrolls into view. */
let _dmLazyObserver = null;
function _observeDMLazyMedia(root) {
  if (typeof IntersectionObserver === 'undefined') return;
  // Respect user auto-play toggle.
  if (localStorage.getItem('ft_autoplay_media') === '0') return;
  if (!_dmLazyObserver) {
    _dmLazyObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        _dmLazyObserver.unobserve(el);
        const id = +el.dataset.msgId;
        const cid = +el.dataset.channelId;
        if (id && cid) loadDMMedia(id, cid);
      }
    }, { rootMargin: '200px 0px', threshold: 0.01 });
  }
  const host = root || document.getElementById('messages-area');
  if (!host) return;
  host.querySelectorAll('.media-lazy.auto').forEach(el => {
    if (!el.dataset._obs) { _dmLazyObserver.observe(el); el.dataset._obs = '1'; }
  });
}

async function _sendDMFileMessage (fileData, payload) {
  let mediaData = fileData.dataUrl || fileData.data || null;
  if (!mediaData && fileData.blob) {
    UI.showProgressToast('Preparing media…', 0);
    try {
      mediaData = await UI.blobToDataURL(fileData.blob, (pct) => {
        UI.showProgressToast('Preparing media…', Math.max(1, Math.round(pct * 0.20)));
      });
    } catch (err) {
      UI.showProgressToast('Failed to prepare media', 100);
      throw err;
    }
    UI.showProgressToast('Preparing media…', 20);
  }
  if (mediaData && STATE.sharedSecret && typeof Crypto !== 'undefined' && Crypto.encryptPayload) {
    UI.showProgressToast('Encrypting…', 22);
    mediaData = await Crypto.encryptPayload(mediaData, STATE.sharedSecret);
    UI.showProgressToast('Encrypting…', 25);
  }
  UI.showProgressToast('Uploading…', 25);
  const r = await UI.uploadJSONWithProgress(
    `/api/dms/${_activeDM.id}/messages`,
    {
      ...payload,
      media_data: mediaData,
      media_type: fileData.type || '',
      media_name: fileData.name || 'file',
      // Per-item flags fall back to the legacy globals for code paths
      // that still set window._pending* directly (camera, voice notes).
      media_blur: (fileData.blur != null ? fileData.blur : window._pendingMediaBlur) ? 1 : 0,
      view_once: (fileData.viewOnce != null ? fileData.viewOnce : window._pendingViewOnce) ? 1 : 0,
    },
    {
      onProgress: (loaded, total, phase) => {
        if (phase === 'uploaded') {
          UI.showProgressToast('Sending…', 97);
          return;
        }
        if (!total) return;
        const frac = Math.max(0, Math.min(1, loaded / total));
        const pct = 25 + Math.round(frac * 70);
        UI.showProgressToast('Uploading…', Math.min(95, pct));
      },
    }
  );
  if (!r.ok) {
    UI.showProgressToast('Upload failed', 100);
    const errBody = await r.json().catch(() => ({}));
    if (r.status === 403 && errBody?.code === 'blocked') {
      handleDMSendError({
        channel_id: _activeDM?.id || 0,
        code: 'blocked',
        i_blocked: !!errBody.i_blocked,
        blocked_by_them: !!errBody.blocked_by_them,
        peer_nickname: errBody.peer_nickname || '',
      });
      return null;
    }
    throw new Error(errBody?.error || 'Upload failed');
  }
  return r.json();
}

const _dmOutboundQueue = [];
const _DM_OUTBOUND_MAX = 24;

function _dmWsLooksOpen() {
  try {
    return !!(typeof WS !== 'undefined' && typeof WS.isOpen === 'function' && WS.isOpen());
  } catch {
    return false;
  }
}

function _dmQueueOutbound(item) {
  if (_dmOutboundQueue.length >= _DM_OUTBOUND_MAX) _dmOutboundQueue.shift();
  _dmOutboundQueue.push(item);
}

async function _dmFlushOutboundQueue() {
  if (!_dmOutboundQueue.length || !_dmWsLooksOpen()) return;
  const batch = _dmOutboundQueue.splice(0, _dmOutboundQueue.length);
  for (const item of batch) {
    try {
      wsSend({
        type: 'dm_message',
        channel_id: item.channelId,
        content: item.content,
        reply_to: item.replyTo || null,
        client_nonce: item.nonce,
      });
    } catch {}
  }
}

try {
  window.addEventListener('ws:open', () => { void _dmFlushOutboundQueue(); });
} catch {}

async function _dmEncryptErrorHint(peerUid, errMsg) {
  const em = String(errMsg || '');
  if (em.includes('federation_token') || em.includes('503')) {
    return 'This node cannot reach peer encryption keys — federation token must be set on every node.';
  }
  if (em.includes('timeout') || em.includes('peer_bundle') || em.includes('signal_session')) {
    let extra = '';
    try {
      if (window.Signal?.peerKeysDiagnostics && peerUid) {
        const d = await window.Signal.peerKeysDiagnostics(peerUid);
        if (d?.bundle_is_remote && d.bundle_source_server) {
          extra = ' (keys on ' + String(d.bundle_source_server) + ')';
        }
      }
    } catch {}
    return 'Fetching encryption keys from another node timed out' + extra
      + ' — wait for Frog\'s travel message to arrive, dismiss sync, hard-refresh, then retry.';
  }
  if (em.includes('404') || em.includes('no_bundle')) {
    return 'Peer encryption keys are not ready yet — we asked their device to sync. Try again in a few seconds.';
  }
  return 'Could not encrypt message — peer may need to refresh or reset keys in Settings.';
}

function handleDMSendWarning(data) {
  const code = String(data?.code || '').trim();
  if (!code || code === 'peer_online_local') return;
  const labels = {
    no_dm_route: 'Message saved here but cannot reach peer node (no federation route).',
    federation_enqueue_failed: 'Message may not reach other nodes — federation queue failed.',
    federation_enqueue_exception: 'Message may not reach other nodes — federation error.',
  };
  const msg = labels[code] || ('Delivery warning: ' + code);
  try { (window.toast || window.UI?.showToast)?.(msg, 'warn', 8000); } catch {}
}
try { window.handleDMSendWarning = handleDMSendWarning; } catch {}

async function _sendDMTextHttp(channelId, encryptedContent, replyToId) {
  const r = await apiFetch(`/api/dms/${channelId}/messages`, 'POST', {
    content: encryptedContent || '',
    reply_to: replyToId || null,
  });
  if (!r.ok) {
    const errBody = await r.json().catch(() => ({}));
    if (r.status === 403 && errBody?.code === 'blocked') {
      handleDMSendError({
        channel_id: channelId,
        code: 'blocked',
        i_blocked: !!errBody.i_blocked,
        blocked_by_them: !!errBody.blocked_by_them,
        peer_nickname: errBody.peer_nickname || '',
      });
      return null;
    }
    throw new Error(errBody?.error || ('HTTP ' + r.status));
  }
  return r.json();
}

/* ── Send DM ─────────────────────────────────────────────────────────────────── */
let _dmSending = false;
async function sendDMMessage () {
  if (!_activeDM) return;
  if (_dmSending) return;  // guard against double-tap / rapid re-sends

  // Auto-stop recording if in progress and wait for finalization
  if (typeof _isRecording !== 'undefined' && _isRecording) {
    stopRecording();
    await new Promise(resolve => {
      const check = () => window._pendingAttachment ? resolve() : setTimeout(check, 50);
      setTimeout(check, 50);
      setTimeout(resolve, 2000); // safety timeout
    });
  }

  const input = document.getElementById('msg-input');
  let content = (input.value || '').trim();

  // Pop attached file if any (check both slots)
  const fileData = window._pendingAttachment || State.pendingAttachment;

  if (!content && !fileData) return;

  const sendBtn = document.getElementById('send-btn');
  const prevBtnText = sendBtn ? sendBtn.textContent : '';
  _dmSending = true;
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '⏳'; }

  // Resolve peer for v2 (Signal/libsignal) encryption preference.
  const _dmChanEntry = _dmChannels.find(c => c.id === _activeDM?.id);
  const _peerUidForEnc = _activeDM?.user_id || _dmChanEntry?.with_user_id || 0;

  // Track A — Signal Double-Ratchet v2 envelope is now the ONLY DM
  // crypto. Envelope is JSON-stringified and stored verbatim in
  // dm_messages.content — the server is opaque. If Signal isn't ready
  // or has no bundle for this peer, we hard-fail rather than silently
  // sending plaintext.
  let encryptedContent = content;
  try {
  if (content && _peerUidForEnc) {
    // Lazy-await Signal boot — a send fired before App.launch()'s
    // fire-and-forget init resolves no longer throws "Encryption layer
    // not ready"; we wait up to ~12s for libsignal + identity to be
    // usable, then re-check.
    if (!window.Signal || !window.Signal.isReady || !window.Signal.isReady()) {
      let ok = false;
      try {
        if (window.Signal && typeof Signal.ensureReady === 'function') {
          ok = await Signal.ensureReady(State.user && State.user.id, { timeoutMs: 12000 });
        }
      } catch {}
      if (!ok) {
        try { UI.showToast('Encryption layer not ready — please refresh.', 'error'); } catch {}
        return;
      }
    }
    const _peerHomeForEnc = _activeDM?.peer_home_server_id || _dmChanEntry?.peer_home_server_id || '';
    let _encryptHadKeyRetry = false;
    const _runEncrypt = async () => {
      let encTimeoutMs = 22000;
      try {
        const diag = (typeof Signal.warmPeerBundleForSend === 'function')
          ? await Signal.warmPeerBundleForSend(_peerUidForEnc)
          : ((typeof Signal.peerKeysDiagnostics === 'function')
            ? await Signal.peerKeysDiagnostics(_peerUidForEnc)
            : null);
        if (diag?.bundle_is_remote) encTimeoutMs = 45000;
      } catch {}
      const encPromise = Signal.encryptDM(_peerUidForEnc, content, {
        peerHomeServerId: _peerHomeForEnc,
      });
      const encTimeout = new Promise((_, rej) => {
        setTimeout(() => rej(new Error('encrypt_timeout')), encTimeoutMs);
      });
      return Promise.race([encPromise, encTimeout]);
    };
    try {
      let env;
      try {
        env = await _runEncrypt();
      } catch (e1) {
        const em1 = String((e1 && e1.message) || e1 || '');
        const missingKeys = em1.includes('404') || em1.includes('no_bundle')
          || em1.includes('peer bundle fetch failed');
        if (missingKeys) {
          _encryptHadKeyRetry = true;
          await new Promise((r) => setTimeout(r, 3000));
          env = await _runEncrypt();
        } else {
          throw e1;
        }
      }
      encryptedContent = JSON.stringify(env);
      if (_encryptHadKeyRetry) {
        void _dmPostCryptoSyncNotice(_peerUidForEnc);
      }
      // Seed plaintext cache: we can NEVER decrypt our own outgoing
      // ciphertext (libsignal has a sending chain only). When the server
      // echoes this message back on history reload, _decryptDMPreviewContent
      // will look it up by ciphertext and return the cached plaintext
      // instead of failing with 'Tried to decrypt on a sending chain'.
      try { _dmPtCachePut(encryptedContent, content); } catch {}
    } catch (e) {
      console.error('[dms] Signal.encryptDM failed:', e);
      const em = String((e && e.message) || e || '');
      const hint = await _dmEncryptErrorHint(_peerUidForEnc, em);
      try { UI.showToast(hint, 'error', 9000); } catch {}
      return;
    }
  }

  const pendingAttachments = (typeof getPendingAttachments === 'function')
    ? getPendingAttachments()
    : (window._pendingAttachment ? [window._pendingAttachment] : State.pendingAttachment ? [State.pendingAttachment] : []);

  if (pendingAttachments.length) {
    try {
      for (let i = 0; i < pendingAttachments.length; i++) {
        const fileItem = pendingAttachments[i];
        const filePayload = {
          content: i === 0 ? (encryptedContent || content || '') : '',
          reply_to: i === 0 ? _dmReplyTo?.id || null : null,
          client_mime: fileItem?.type || null,
        };
        const msg = await _sendDMFileMessage(fileItem, filePayload);
        if (msg === null) return;
        appendDMMessage(msg);
      }
      UI.showProgressToast('Sent!', 100);
      clearReplyToDM();
      clearAttachment();
      input.value = '';
      autoResize(input);
    } catch (e) {
      console.error('DM file send error', e);
      UI.showProgressToast('Upload failed', 100);
      toast('Failed to send file', 'error');
    } finally {
      _dmSending = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = prevBtnText || '➤'; }
    }
    return;
  }

  // Send over WebSocket when connected; otherwise HTTP (sync overlay / reconnect).
  const _nonce = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const _wsUp = _dmWsLooksOpen();
  if (_wsUp) {
    wsSend({ type: 'dm_message', channel_id: _activeDM.id, content: encryptedContent || content,
             reply_to: _dmReplyTo?.id || null, client_nonce: _nonce });
  } else {
    try {
      const saved = await _sendDMTextHttp(
        _activeDM.id,
        encryptedContent || content,
        _dmReplyTo?.id || null,
      );
      if (!saved) return;
      appendDMMessage(saved);
      clearReplyToDM();
      input.value = '';
      autoResize(input);
      return;
    } catch (e) {
      console.error('[dms] HTTP DM send failed', e);
      _dmQueueOutbound({
        channelId: _activeDM.id,
        content: encryptedContent || content,
        replyTo: _dmReplyTo?.id || null,
        nonce: _nonce,
      });
      try {
        UI.showToast('Queued — will send when connection is back.', 'warn', 6000);
      } catch {}
    }
  }

  // Optimistic local append \u2014 the user sees their message instantly instead of
  // waiting for the WS round-trip. The echo handler will swap the temp id for
  // the real id on arrival.
  try {
    const _me = STATE.user || {};
    const _tempId = -Date.now();
    const _tempMsg = {
      id         : _tempId,
      _nonce     : _nonce,
      channel_id : _activeDM.id,
      sender_id  : _me.id,
      sender_nick: _me.nickname,
      sender_display_name: _me.display_name,
      sender_avatar: _me.avatar,
      sender_is_admin: !!_me.is_admin,
      content    : content,            // plaintext — what the user typed
      created_at : new Date().toISOString().replace('Z',''),
      reply_to   : _dmReplyTo?.id || null,
      // Carry the reply snapshot into the optimistic bubble so the quote
      // shows the actual replied-to author / preview instead of falling
      // back to '?' (or, before the fix, to the current user's own nick).
      reply_nickname: _dmReplyTo?.nick || null,
      reply_nick    : _dmReplyTo?.nick || null,
      reply_content : _dmReplyTo?.content || null,
      _pending   : true,
    };
    _dmMessages.push(_tempMsg);
    if (encryptedContent !== content) {
      try { _rememberDMPlaintext(_activeDM.id, _tempId, content); } catch {}
    }
    const area = document.getElementById('messages-area');
    if (area) {
      const tmp = document.createElement('div');
      tmp.innerHTML = renderDMMessage(_tempMsg);
      const el = tmp.firstElementChild;
      if (el) {
        el.classList.add('dm-pending');
        el.setAttribute('data-own', '1');
        el.setAttribute('data-nonce', _nonce);
        el.style.opacity = '0.65';
        area.appendChild(el);
        _scrollDMToBottomStable();
      }
    }
  } catch (e) { console.warn('optimistic DM append failed', e); }

  clearReplyToDM();
  input.value = '';
  autoResize(input);
  // Re-snap AFTER input/reply chip layout changes settle. Mobile needs
  // this because the soft keyboard collapse + input shrink happen after
  // the optimistic append, pushing the new bubble below the viewport.
  _scrollDMToBottomStable();
  } finally {
    _dmSending = false;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = prevBtnText || '➤';
    }
  }
}

/* ── Incoming WS DM message ─────────────────────────────────────────────────── */
function handleWSDMMessage (data) {
  // Flag whether this DM is for the currently-open conversation (used by
  // notifications.js to suppress desktop/sound alerts when already reading).
  data._isActive = !!(_activeDM && data.channel_id === _activeDM.id);
  // Detect our own echoed-back DMs so we don't toast/alert on them
  const _selfId = STATE.user?.id;
  const _selfNick = STATE.user?.nickname;
  const _isMine = (data.sender_id != null && _selfId != null && +data.sender_id === +_selfId) ||
                  (data.sender_nick && _selfNick && data.sender_nick === _selfNick);
  data._isMine = _isMine;

  // ── Decrypt ONCE ──────────────────────────────────────────────────────
  // Track A v2 envelopes mutate Signal Protocol state on decrypt: a
  // pre-key bundle (`t:'pre'`) is consumed and the Double-Ratchet steps
  // forward. Calling Signal.decryptDM twice on the same envelope therefore
  // **always** fails on the second call — sidebar would decrypt, then the
  // bubble path would get raw envelope back and render the lock
  // placeholder. Decrypt up-front and share the plaintext with every
  // downstream consumer (sidebar, toast, bubble).
  const _ch0 = _dmChannels.find(c => c.id === data.channel_id);
  const _peerNick0 = data.sender_nick || _ch0?.nickname || '';
  const _peerForDecrypt = _isMine
    ? 0
    : (Number(data.sender_id) || Number(_activeDM?.user_id) || Number(_ch0?.with_user_id) || 0);
  const _fedInbound = !!(data.federated || data.origin_server_id);
  const _senderHome = String(data.origin_server_id || '').trim();
  if (_senderHome) {
    const chUp = _dmChannels.find(c => c.id === data.channel_id);
    if (chUp) chUp.peer_home_server_id = _senderHome;
    if (_activeDM && _activeDM.id === data.channel_id) {
      _activeDM.peer_home_server_id = _senderHome;
    }
  }
  const _isDMSys = typeof data.content === 'string' && data.content.startsWith('[[DMSYS]]');
  const _plainPromise = (_isMine || _isDMSys)
    ? Promise.resolve(String(data.content || ''))
    : _decryptDMPreviewContent(data.content || '', _peerForDecrypt, _peerNick0, {
      retry: true,
      live: true,
      federated: _fedInbound,
      peerHomeServerId: _senderHome,
    });

  // Cheap in-place sidebar update (avoid round-tripping /api/dms on every message
  // which was adding 200-500 ms of perceived send lag).
  (async () => {
    try {
      const ch = _dmChannels.find(c => c.id === data.channel_id);
      if (ch) {
        const previewContent = await _plainPromise;
        ch.last_msg_raw = previewContent;
        ch.last_msg_meta = _parseDMCallLog(previewContent);
        ch.last_msg = _dmPreviewText(previewContent, data.has_media, data.media_type);
        ch.last_msg_at = data.created_at || new Date().toISOString();
        ch.last_msg_id = data.id || ch.last_msg_id || 0;
        ch.last_sender_id = data.sender_id != null ? +data.sender_id : ch.last_sender_id;
        if (!_isMine && !(data._isActive && !document.hidden)) {
          ch.unread = (ch.unread || 0) + 1;
        }
        // Bubble to top of list
        const idx = _dmChannels.indexOf(ch);
        if (idx > 0) { _dmChannels.splice(idx, 1); _dmChannels.unshift(ch); }
        renderDMChannels();
        // Notify with decrypted content so the system notification shows plaintext
        if (!_isMine && (document.hidden || !data._isActive)) {
          try {
            if (typeof Notifications !== 'undefined' && Notifications.notifyDM) {
              Notifications.notifyDM({ ...data, content: previewContent });
            }
          } catch {}
        }
      } else {
        // Unknown channel — fall back to refresh (rare path).
        loadDMChannels();
      }
    } catch {}
  })();

  if (!_activeDM || data.channel_id !== _activeDM.id) {
    // Not in this DM — async-decrypt and toast with readable text
    if (!_isMine) {
      (async () => {
        try {
          // Reuse the single decrypt result (see comment above) so we
          // don't try to consume the same Track A envelope twice.
          const toastContent = await _plainPromise;
          const preview = _dmPreviewText(toastContent, data.has_media, data.media_type);
          // Click the toast → jump straight into that DM thread.
          const onClick = () => {
            try {
              const ch3 = _dmChannels.find(c => c.id === data.channel_id);
              if (ch3) openDMChannel(ch3.id, ch3.nickname, ch3.avatar);
              else if (typeof openDMWithNick === 'function' && data.sender_nick) {
                openDMWithNick(data.sender_nick);
              }
            } catch {}
          };
          toast(
            `💬 ${data.sender_nick}: ${preview ? preview.substring(0,60) : 'Media'}`,
            'info', 4500, onClick
          );
        } catch {}
      })();
    }
    return;
  }

  // Our own echoed message — reconcile with any optimistic placeholder.
  if (_isMine) {
    const area = document.getElementById('messages-area');
    const pend = area?.querySelector('.dm-pending[data-nonce="' + (data.client_nonce || '') + '"]');
    if (pend && data.id) {
      const _oldMsgId = String((pend.id || '').replace(/^msg-/, '') || '').trim();
      pend.classList.remove('dm-pending');
      pend.removeAttribute('data-own');
      pend.removeAttribute('data-nonce');
      pend.id = `msg-${data.id}`;
      pend.setAttribute('data-dmid', data.id);
      // Sync crown from server echo so the user's own freshly-sent DM
      // shows the admin crown immediately instead of waiting for a fresh
      // history fetch on next channel switch.
      try {
        const wantCrown = !!data.sender_is_admin;
        const authorEl = pend.querySelector('.msg-author');
        if (authorEl) {
          const hasCrown = authorEl.textContent.trim().startsWith('👑');
          if (wantCrown && !hasCrown) {
            authorEl.insertBefore(document.createTextNode('👑 '), authorEl.firstChild);
          } else if (!wantCrown && hasCrown) {
            authorEl.textContent = authorEl.textContent.replace(/^👑\s*/, '');
          }
        }
      } catch {}
      if (_oldMsgId && _oldMsgId !== String(data.id)) {
        try {
          const _newMsgId = String(data.id);
          pend.querySelectorAll('[onclick],[data-rid]').forEach(node => {
            const oc = node.getAttribute('onclick');
            if (oc && oc.includes(_oldMsgId)) {
              node.setAttribute('onclick', oc.split('(' + _oldMsgId).join('(' + _newMsgId)
                                           .split(',' + _oldMsgId).join(',' + _newMsgId)
                                           .split(' ' + _oldMsgId).join(' ' + _newMsgId));
            }
            const rid = node.getAttribute('data-rid');
            if (rid === _oldMsgId) node.setAttribute('data-rid', _newMsgId);
          });
        } catch {}
      }
      pend.style.opacity = '';
      const tick = pend.querySelector('.msg-tick');
      if (tick) {
        tick.dataset.mid = data.id;
        tick.textContent = '✓';
        tick.title = 'Delivered';
        tick.classList.remove('msg-tick-pending', 'msg-tick-read');
      }
      // Replace any cached pending entry
      const pi = _dmMessages.findIndex(x => x._nonce === data.client_nonce);
      if (pi >= 0) {
        const plain = _dmMessages[pi].content || '';
        _dmMessages[pi] = _normalizeDMMessage({ ...data, content: plain });
        if (plain && data.content) {
          try { _dmPtCachePut(data.content, plain); } catch {}
          try { _rememberDMPlaintext(data.channel_id, data.id, plain); } catch {}
        }
        const previewUrl = _extractDMPreviewUrl(String(_dmMessages[pi].content || ''));
        if (previewUrl && !_dmMessages[pi].preview_suppressed) {
          setTimeout(() => _loadDMPreview(data.id, previewUrl), 80);
        }
      }
      return;
    }

    // Fallback reconciliation when server/client nonce is missing: upgrade
    // the most recent pending bubble from me so sent state doesn't stay dull.
    if (data.id && area) {
      const pendingEls = Array.from(area.querySelectorAll('.dm-pending[data-own="1"], .dm-pending'));
      const fallback = pendingEls.length ? pendingEls[pendingEls.length - 1] : null;
      if (fallback) {
        const _oldMsgId = String((fallback.id || '').replace(/^msg-/, '') || '').trim();
        fallback.classList.remove('dm-pending');
        fallback.removeAttribute('data-own');
        fallback.removeAttribute('data-nonce');
        fallback.id = `msg-${data.id}`;
        fallback.setAttribute('data-dmid', data.id);
        if (_oldMsgId && _oldMsgId !== String(data.id)) {
          try {
            const _newMsgId = String(data.id);
            fallback.querySelectorAll('[onclick],[data-rid]').forEach(node => {
              const oc = node.getAttribute('onclick');
              if (oc && oc.includes(_oldMsgId)) {
                node.setAttribute('onclick', oc.split('(' + _oldMsgId).join('(' + _newMsgId)
                                             .split(',' + _oldMsgId).join(',' + _newMsgId)
                                             .split(' ' + _oldMsgId).join(' ' + _newMsgId));
              }
              const rid = node.getAttribute('data-rid');
              if (rid === _oldMsgId) node.setAttribute('data-rid', _newMsgId);
            });
          } catch {}
        }
        fallback.style.opacity = '';
        const tick = fallback.querySelector('.msg-tick');
        if (tick) {
          tick.dataset.mid = data.id;
          tick.textContent = '✓';
          tick.title = 'Delivered';
          tick.classList.remove('msg-tick-pending', 'msg-tick-read');
        }
        let pi = -1;
        for (let i = _dmMessages.length - 1; i >= 0; i--) {
          const x = _dmMessages[i];
          if (x && x._pending && ((x.sender_id|0) === (_selfId|0))) { pi = i; break; }
        }
        if (pi >= 0) {
          const plain = _dmMessages[pi].content || '';
          _dmMessages[pi] = _normalizeDMMessage({ ...data, content: plain });
          if (plain && data.content) {
            try { _dmPtCachePut(data.content, plain); } catch {}
            try { _rememberDMPlaintext(data.channel_id, data.id, plain); } catch {}
          }
          const previewUrl = _extractDMPreviewUrl(String(_dmMessages[pi].content || ''));
          if (previewUrl && !_dmMessages[pi].preview_suppressed) {
            setTimeout(() => _loadDMPreview(data.id, previewUrl), 80);
          }
        }
        return;
      }
    }
    if (data.id && _dmMessages.some(x => Number(x.id) === Number(data.id))) return;
  }

  // Try to decrypt
  (async () => {
    let content = data.content || '';
    if (content) {
      try { content = await _plainPromise; } catch {}
    }
    if (_isMine && _looksEncryptedBlob(content)) {
      const plain = _resolveOwnDMPlaintext(data.content || content, data.id, data.channel_id);
      if (plain) {
        content = plain;
        try { _dmPtCachePut(data.content || '', plain); } catch {}
        try { _rememberDMPlaintext(data.channel_id, data.id, plain); } catch {}
      }
    }
    appendDMMessage({ ...data, content });
    // Active chat — immediately mark as read
    if (!document.hidden) markDMRead();
  })();
}

/* ── Server rejected a WS dm_message — currently the only reason is a
 *    block (either direction). Remove the optimistic bubble, drop the
 *    cached pending entry, and surface a friendly inline notice + toast
 *    so the sender understands why their message vanished.
 * ────────────────────────────────────────────────────────────────────── */
function handleDMSendError (data) {
  try {
    const nonce = data?.client_nonce || '';
    const area  = document.getElementById('messages-area');
    // Drop the optimistic bubble
    if (nonce && area) {
      const pend = area.querySelector('.dm-pending[data-nonce="' + nonce + '"]');
      if (pend) pend.remove();
    }
    // Drop the cached entry so it doesn't get re-rendered on channel switch
    if (nonce) {
      const pi = _dmMessages.findIndex(x => x._nonce === nonce);
      if (pi >= 0) _dmMessages.splice(pi, 1);
      if (_activeDM?.id) {
        _dmHistoryCache.set(_activeDM.id, _dmMessages.map(x => ({ ...x })));
      }
    }
    if (data?.code === 'blocked') {
      const peer = data.peer_nickname ? '@' + data.peer_nickname : 'this user';
      const txt = data.i_blocked
        ? `You have blocked ${peer} — unblock to message them again.`
        : `You have been blocked by ${peer}.`;
      // Toast + persistent inline banner inside the thread
      try { (window.toast || window.UI?.showToast)?.(txt, 'error', 5500); } catch {}
      try {
        if (area && (!_activeDM || _activeDM.id === data.channel_id)) {
          // Replace any prior banner so it doesn't stack
          area.querySelector('#dm-block-banner')?.remove();
          const banner = document.createElement('div');
          banner.id = 'dm-block-banner';
          banner.style.cssText = 'margin:10px auto;padding:10px 14px;max-width:520px;background:#2a0d0d;border:1px solid #7f1d1d;border-radius:10px;color:#fca5a5;font-size:13px;text-align:center;font-weight:600;';
          banner.textContent = '🚫 ' + txt;
          area.appendChild(banner);
          banner.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
      } catch {}
    } else {
      const err = data?.error || 'Message not delivered';
      try { (window.toast || window.UI?.showToast)?.(err, 'error'); } catch {}
    }
  } catch {}
}
window.handleDMSendError = handleDMSendError;

function appendDMMessage (m) {
  m = _normalizeDMMessage(m);
  // Dedup: if a message with this id already exists (e.g. REST-sent media
  // then WS echo arrives), skip the second append.
  if (m.id && _dmMessages.some(x => x.id === m.id)) return;
  _dmMessages.push(m);
  if (_activeDM?.id) {
    _dmHistoryCache.set(_activeDM.id, _dmMessages.map(x => ({ ...x })));
    _dmHistoryMeta.set(_activeDM.id, {
      fetchedAt: Date.now(),
      lastMsgId: Number((_dmMessages[_dmMessages.length - 1]?.id) || 0),
    });
  }
  const area = document.getElementById('messages-area');
  if (!area) return;
  const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
  const myId = STATE.user?.id;
  const myNick = STATE.user?.nickname;
  const mine = (m.sender_id != null && myId != null && (+m.sender_id === +myId))
            || (!!m.sender_nick && !!myNick && m.sender_nick === myNick);
  const tmp = document.createElement('div');
  tmp.innerHTML = renderDMMessage(m);
  const el = tmp.firstElementChild;
  // reaction buttons now use inline onclick → showDMReactMenu
  area.appendChild(el);
  if (!mine && _looksEncryptedBlob(m.content)) {
    void _retryDecryptDMMessageInPlace(m);
  }
  if (window.Messages && Messages.hydrateStickers) Messages.hydrateStickers(area);
  if (mine || atBottom) _scrollDMToBottomStable();
  const previewUrl = _extractDMPreviewUrl(String(m.content || ''));
  if (previewUrl && !m.preview_suppressed) setTimeout(() => _loadDMPreview(m.id, previewUrl), 180);
  setTimeout(() => _hydrateDMSocialCards(m.id), 120);
  // Auto-load media for new real-time DM messages (skip view-once — those need explicit tap)
  if (m.has_media && m.id && _activeDM && !m.view_once) {
    setTimeout(() => loadDMMedia(m.id, _activeDM.id), 100);
  }
}

function openDMSocialPost(postId) {
  const id = Number(postId);
  if (!Number.isFinite(id) || id <= 0) return;
  try {
    if (typeof Messages !== 'undefined' && typeof Messages.openSocialPost === 'function') {
      Messages.openSocialPost(id);
      return;
    }
  } catch {}
  try { window.location.href = `/app?post=${id}`; } catch {}
}

function openDMSocialReel(postId) {
  const id = Number(postId);
  if (!Number.isFinite(id) || id <= 0) return;
  try {
    if (typeof Messages !== 'undefined' && typeof Messages.openSocialReel === 'function') {
      Messages.openSocialReel(id);
      return;
    }
  } catch {}
  try { window.location.href = `/?reel=${id}`; } catch {}
}

/* ── Typing indicator ───────────────────────────────────────────────────────── */
function sendDMTyping () {
  if (!_activeDM) return;
  clearTimeout(_dmTypingTimer);
  wsSend({ type: 'dm_typing', channel_id: _activeDM.id });
  _dmTypingTimer = setTimeout(() => {}, 3000);
}

function handleWSDMTyping (data) {
  if (!_activeDM || data.channel_id !== _activeDM.id) return;
  const bar = document.getElementById('typing-bar');
  if (!bar) return;
  bar.style.display = '';
  const who = data.sender_nick || data.nickname || 'Someone';
  bar.textContent = who + ' is typing…';
  clearTimeout(_dmTypingTimer);
  _dmTypingTimer = setTimeout(() => { bar.textContent = ''; }, 3000);
}

/* ── Edit / Delete DM ───────────────────────────────────────────────────────── */
async function editDMMsg (id) {
  const m = _dmMessages.find(x => +x.id === +id);
  if (!m) return;
  const myId = Number(STATE?.user?.id || 0);
  if (!myId || Number(m.sender_id || 0) !== myId) {
    toast('Only the sender can edit this DM', 'error');
    return;
  }

  const msgEl = document.getElementById(`msg-${id}`);
  const contentEl = msgEl?.querySelector('.msg-content');
  if (!contentEl) return;
  if (contentEl.querySelector(`#dm-edit-input-${id}`)) {
    contentEl.querySelector(`#dm-edit-input-${id}`)?.focus();
    return;
  }

  const current = String(m.content || '');
  contentEl.dataset.originalText = current;
  contentEl.innerHTML = `
    <textarea id="dm-edit-input-${id}" style="width:100%;background:#1a1a1a;border:1px solid #4caf50;border-radius:6px;color:#e0e0e0;padding:6px;font-size:14px;resize:none;outline:none" rows="2">${UI.escHtml(current)}</textarea>
    <div style="display:flex;gap:8px;margin-top:4px">
      <button onclick="submitDMEdit(${id})" style="background:#4caf50;border:none;border-radius:6px;color:#000;padding:4px 12px;cursor:pointer;font-size:13px">Save</button>
      <button onclick="cancelDMEdit(${id})" style="background:#1a1a1a;border:none;border-radius:6px;color:#888;padding:4px 12px;cursor:pointer;font-size:13px">Cancel</button>
    </div>
  `;
  const input = document.getElementById(`dm-edit-input-${id}`);
  if (input) {
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        submitDMEdit(id);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancelDMEdit(id);
      }
    });
  }
}

async function submitDMEdit(id) {
  const m = _dmMessages.find(x => +x.id === +id);
  if (!m) return;
  const myId = Number(STATE?.user?.id || 0);
  if (!myId || Number(m.sender_id || 0) !== myId) {
    toast('Only the sender can edit this DM', 'error');
    return;
  }
  const input = document.getElementById(`dm-edit-input-${id}`);
  if (!input) return;
  const newContent = String(input.value || '').trim();
  if (!newContent) {
    toast('Message cannot be empty', 'error');
    return;
  }

  // Track H: Signal Double-Ratchet is the only DM crypto path.
  let enc = newContent;
  const _peerUidEdit = _activeDM?.user_id
    || _dmChannels.find(c => c.id === _activeDM?.id)?.with_user_id
    || 0;
  if (!_peerUidEdit) {
    toast('Encryption layer not ready — please refresh.', 'error');
    return;
  }
  if (!window.Signal || !window.Signal.isReady || !window.Signal.isReady()) {
    let ok = false;
    try {
      if (window.Signal && typeof Signal.ensureReady === 'function') {
        ok = await Signal.ensureReady(State.user && State.user.id);
      }
    } catch {}
    if (!ok) {
      toast('Encryption layer not ready — please refresh.', 'error');
      return;
    }
  }
  try {
    const env = await Signal.encryptDM(_peerUidEdit, newContent);
    enc = JSON.stringify(env);
    try { _dmPtCachePut(enc, newContent); } catch {}
  } catch (e) {
    console.error('[dms] edit Signal.encryptDM failed:', e);
    toast('Could not encrypt edit.', 'error');
    return;
  }
  const r = await apiFetch(`/api/dms/${_activeDM.id}/messages/${id}`, 'PUT', { content: enc });
  if (!r.ok) {
    toast('Could not edit message', 'error');
    return;
  }

  m.content = newContent;
  m.edited = 1;
  m.edited_at = new Date().toISOString();
  renderDMChat();
}

function cancelDMEdit(id) {
  const msgEl = document.getElementById(`msg-${id}`);
  const contentEl = msgEl?.querySelector('.msg-content');
  if (!contentEl) return;
  const original = contentEl.dataset.originalText;
  delete contentEl.dataset.originalText;
  if (typeof original === 'string') {
    const m = _dmMessages.find(x => +x.id === +id);
    if (m) m.content = original;
  }
  renderDMChat();
}

async function deleteDMMsg (id) {
  const ok = await UI.confirm({
    title: 'Delete message',
    message: 'Delete this message? This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const r = await apiFetch(`/api/dms/${_activeDM.id}/messages/${id}`, 'DELETE');
  if (r.ok) {
    _dmMessages = _dmMessages.filter(x => x.id !== id);
    renderDMChat();
  }
}

/* ── Reactions ─────────────────────────────────────────────────────────────── */
const _DM_REACT_QUICK = ['👍','❤️','😂','😮','😢','🎉','🔥','🐸'];
const _DM_REACT_CATS = [
  { id:'smileys', icon:'😀', name:'Smileys & People', emojis:['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
  { id:'hearts', icon:'❤️', name:'Hearts', emojis:['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','♥️','💌'] },
  { id:'hands', icon:'👋', name:'Gestures', emojis:['👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋','🤛','🤜','✊','👊','👏','🙌','👐','🤲','🙏','✍️','💪','🦾','🫶'] },
  { id:'animals', icon:'🐸', name:'Animals & Nature', emojis:['🐸','🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐽','🐵','🙈','🙉','🙊','🐒','🦆','🦅','🦉','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🐢','🐍','🦎','🐙','🦀','🐠','🐟','🐡','🐬','🦈','🐳','🐋','🌱','🌿','🍀','🌵','🌴','🌲','🌳','🌺','🌻','🌹','🌷','🌸','🌼'] },
  { id:'food', icon:'🍔', name:'Food & Drink', emojis:['🍎','🍌','🍓','🍇','🍉','🍍','🥝','🍅','🥑','🌽','🥕','🥦','🧄','🍞','🥐','🥨','🧀','🥚','🥓','🍗','🍖','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🥙','🍝','🍜','🍲','🍛','🍣','🍱','🍙','🍘','🍰','🎂','🧁','🍮','🍭','🍬','🍫','🍿','🍩','🍪','☕','🍵','🥤','🧋','🍺','🍻','🥂','🍷','🥃','🍸','🍹'] },
  { id:'activity', icon:'⚽', name:'Activity & Objects', emojis:['⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🥅','⛳','🎣','🎽','🎿','🎯','🎮','🎲','🧩','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🎷','🎺','🎸','🎻','💻','📱','⌚','📷','🔒','🔑','💡','🔋','🔦','🛒','🎁','🎈','🎀','🎊','🎉'] },
  { id:'symbols', icon:'⭐', name:'Symbols', emojis:['⭐','🌟','✨','⚡','💥','🔥','🌈','☀️','🌙','❄️','☃️','💧','🌊','✅','❌','❓','❗','⁉️','‼️','💯','💢','💬','💭','💤','👀','🎉','🏆','🥇','🥈','🥉','🏅','♻️','☯️','☮️','🆗','🆒','🆕','🆙','💫','⚠️','🚫','✔️','☑️'] },
];

function showDMReactMenu(msgId, anchor) {
  const existing = document.getElementById('dm-react-picker');
  if (existing) { existing.remove(); return; }

  let anchorEl = anchor && anchor.nodeType === 1 ? anchor : null;
  let rect = anchorEl ? anchorEl.getBoundingClientRect() : null;
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    const msgEl = document.getElementById('msg-' + msgId);
    rect = msgEl ? msgEl.getBoundingClientRect() : null;
  }

  const recent = (() => { try { const r = localStorage.getItem('ft-recent-reacts'); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a.slice(0, 24) : []; } catch { return []; } })();
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const picker = document.createElement('div');
  picker.id = 'dm-react-picker';
  picker.className = 'react-picker';
  picker.innerHTML = `
    <div class="rp-quick">
      ${_DM_REACT_QUICK.map(e => `<button class="rp-quick-btn" data-e="${esc(e)}" type="button">${e}</button>`).join('')}
      <button class="rp-quick-btn rp-plus" type="button" title="More reactions" aria-label="More reactions">＋</button>
    </div>
    <div class="rp-body" hidden>
      <div class="rp-search"><input type="text" class="rp-search-input" placeholder="Search emoji…" aria-label="Search emoji"></div>
      <div class="rp-grid"></div>
      <div class="rp-tabs">
        ${recent.length ? `<button class="rp-tab" data-cat="recent" title="Recent" type="button">🕘</button>` : ''}
        ${_DM_REACT_CATS.map(c => `<button class="rp-tab" data-cat="${c.id}" title="${esc(c.name)}" type="button">${c.icon}</button>`).join('')}
      </div>
    </div>
  `;

  document.body.appendChild(picker);

  const _position = () => {
    if (!rect) return;
    const ph = picker.offsetHeight, pw = picker.offsetWidth;
    const vw = window.innerWidth, vh = window.innerHeight;
    let top = rect.top - ph - 6;
    if (top < 6) top = rect.bottom + 6;
    if (top + ph > vh - 6) top = vh - ph - 6;
    let left = rect.left;
    if (left + pw > vw - 6) left = vw - pw - 6;
    if (left < 6) left = 6;
    picker.style.cssText = `position:fixed;top:${top}px;left:${left}px;z-index:9999`;
  };
  _position();

  const body = picker.querySelector('.rp-body');
  const grid = picker.querySelector('.rp-grid');
  const tabs = picker.querySelectorAll('.rp-tab');
  const searchInput = picker.querySelector('.rp-search-input');

  const close = () => {
    picker.classList.add('rp-closing');
    setTimeout(() => picker.remove(), 140);
    document.removeEventListener('keydown', _onKey);
    document.removeEventListener('mousedown', _onOutside, true);
  };
  const pick = (e) => {
    try { const cur = recent.filter(x => x !== e); cur.unshift(e); localStorage.setItem('ft-recent-reacts', JSON.stringify(cur.slice(0,24))); } catch {}
    toggleDMReaction(msgId, e);
    close();
  };
  const _onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  const _onOutside = (ev) => { if (!picker.contains(ev.target)) close(); };

  const _renderCat = (catId) => {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.cat === catId));
    let emojis = catId === 'recent' ? recent : ((_DM_REACT_CATS.find(c => c.id === catId) || {}).emojis || []);
    grid.innerHTML = emojis.map(e => `<button class="rp-emoji" data-e="${esc(e)}" type="button">${e}</button>`).join('');
    grid.scrollTop = 0;
  };

  picker.querySelector('.rp-quick').addEventListener('click', ev => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    if (btn.classList.contains('rp-plus')) {
      body.hidden = !body.hidden;
      picker.classList.toggle('rp-expanded', !body.hidden);
      if (!body.hidden) { const ft = picker.querySelector('.rp-tab'); if (ft) _renderCat(ft.dataset.cat); _position(); }
      return;
    }
    if (btn.dataset.e) pick(btn.dataset.e);
  });

  tabs.forEach(t => t.addEventListener('click', () => _renderCat(t.dataset.cat)));
  grid.addEventListener('click', ev => { const btn = ev.target.closest('.rp-emoji'); if (btn && btn.dataset.e) pick(btn.dataset.e); });
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { _renderCat(picker.querySelector('.rp-tab.active')?.dataset.cat || _DM_REACT_CATS[0].id); return; }
    const all = _DM_REACT_CATS.flatMap(c => c.emojis);
    grid.innerHTML = all.filter(e => e.toLowerCase().includes(q)).map(e => `<button class="rp-emoji" data-e="${esc(e)}" type="button">${e}</button>`).join('');
  });

  document.addEventListener('keydown', _onKey);
  setTimeout(() => document.addEventListener('mousedown', _onOutside, true), 0);
}

async function toggleDMReaction (msgId, emoji) {
  await apiFetch(`/api/dms/${_activeDM.id}/messages/${msgId}/react`, 'POST', { emoji });
  // Reload messages to get updated counts
  loadDMMessages();
}

/* ── Reply ─────────────────────────────────────────────────────────────────── */
function replyToDM (id, nick, content) {
  _dmReplyTo = { id, nick, content };
  const bar = document.getElementById('reply-bar');
  if (!bar) return;
  bar.style.display = 'flex';
  const nickEl = bar.querySelector('#reply-bar-nick');
  const textEl = bar.querySelector('#reply-bar-text');
  const closeBtn = bar.querySelector('button[title="Cancel reply"]');
  if (nickEl) nickEl.textContent = nick;
  if (textEl) textEl.textContent = content || 'Media';
  if (closeBtn) {
    closeBtn.onclick = clearReplyToDM;
  }
}

function clearReplyToDM () {
  _dmReplyTo = null;
  const bar = document.getElementById('reply-bar');
  if (!bar) return;
  bar.style.display = 'none';
  const closeBtn = bar.querySelector('button[title="Cancel reply"]');
  if (closeBtn) {
    closeBtn.onclick = () => {
      if (typeof Messages !== 'undefined' && typeof Messages.clearReply === 'function') {
        Messages.clearReply();
      }
    };
  }
}

/* ── Lightbox ─────────────────────────────────────────────────────────────── */
function openLightbox (src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.remove('hidden');
}
function closeLightbox () {
  document.getElementById('lightbox').classList.add('hidden');
}
function openLightboxInNewTab () {
  const src = document.getElementById('lightbox-img').src;
  if (!src) return;
  if (src.startsWith('data:')) {
    // Convert data URI to blob URL so it opens in a new tab
    try {
      const [header, b64] = src.split(',');
      const mime = header.match(/:(.*?);/)?.[1] || 'image/png';
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: mime });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch { window.open(src, '_blank'); }
  } else {
    window.open(src, '_blank');
  }
}

/* ── Helper ─────────────────────────────────────────────────────────────────── */
function isDMView () {
  return !!_activeDM;
}

/* ── Disappearing Messages ────────────────────────────────────────────────── */
let _dmDisappearTimer = 0;

async function loadDisappearTimer() {
  if (!_activeDM) return;
  try {
    const r = await apiFetch(`/api/dms/${_activeDM.id}/disappear`);
    if (r.ok) {
      const data = await r.json();
      _dmDisappearTimer = data.seconds || 0;
      updateDisappearIndicator();
    }
  } catch (e) {
    console.error('loadDisappearTimer', e);
  }
}

function updateDisappearIndicator() {
  // Remove existing indicator
  const existing = document.getElementById('disappear-indicator');
  if (existing) existing.remove();
  
  if (!_activeDM || _dmDisappearTimer === 0) return;
  
  // Add indicator next to channel title
  const header = document.getElementById('ch-desc');
  if (header) {
    const label = formatDisappearTime(_dmDisappearTimer);
    header.innerHTML = `Direct message · <span id="disappear-indicator" style="color:#f9a825;cursor:pointer" onclick="showDisappearSettings()" title="Messages disappear after ${label}">⏱️ ${label}</span>`;
  }
}

function formatDisappearTime(seconds) {
  if (seconds <= 0) return 'Off';
  if (seconds === 3600) return '1h';
  if (seconds === 86400) return '24h';
  if (seconds === 604800) return '7d';
  if (seconds === 2592000) return '30d';
  return seconds + 's';
}

function showDisappearSettings() {
  if (!_activeDM) return;
  
  // Create modal if doesn't exist
  let modal = document.getElementById('modal-disappear');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal-overlay hidden';
    modal.id = 'modal-disappear';
    modal.innerHTML = `
      <div class="modal" style="max-width:320px">
        <div class="modal-title">🔐 Privacy & Security</div>
        <div style="font-size:12px;color:#888;margin:-6px 0 12px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">⏱️ Disappearing messages</div>
        <div style="font-size:13px;color:#888;margin-bottom:16px">
          Messages will be automatically deleted after the selected time.
        </div>
        <select class="modal-input" id="disappear-select" style="color:#e0e0e0;background:#0d0d0d">
          <option value="0">Off</option>
          <option value="3600">1 hour</option>
          <option value="86400">24 hours</option>
          <option value="604800">7 days</option>
          <option value="2592000">30 days</option>
        </select>
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid #2a2a2a">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
            <input type="checkbox" id="dm-forwarding-disabled" style="width:18px;height:18px;accent-color:#4caf50;cursor:pointer" onchange="toggleDMForwarding(this.checked)">
            <div>
              <div style="font-weight:600;font-size:14px">📤 Disable Forwarding</div>
              <div style="font-size:12px;color:#888">Messages in this DM cannot be forwarded elsewhere</div>
            </div>
          </label>
        </div>
        <div class="modal-actions">
          <button class="modal-btn secondary" onclick="closeModal('modal-disappear')">Cancel</button>
          <button class="modal-btn danger" onclick="wipeDMMessages();closeModal('modal-disappear')">🗑️ Wipe All</button>
          <button class="modal-btn primary" onclick="saveDisappearTimer()">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  
  // Set current value
  document.getElementById('disappear-select').value = _dmDisappearTimer.toString();
  const fwdCb = document.getElementById('dm-forwarding-disabled');
  if (fwdCb) fwdCb.checked = !!(_activeDM && _activeDM.forwarding_disabled);
  openModal('modal-disappear');
}

async function saveDisappearTimer() {
  if (!_activeDM) return;
  
  const seconds = parseInt(document.getElementById('disappear-select').value) || 0;
  
  try {
    const r = await apiFetch(`/api/dms/${_activeDM.id}/disappear`, 'POST', { seconds });
    if (!r.ok) {
      const data = await r.json();
      toast(data.error || 'Failed to set timer', 'error');
      return;
    }
    
    _dmDisappearTimer = seconds;
    updateDisappearIndicator();
    closeModal('modal-disappear');
    
    if (seconds > 0) {
      toast(`Messages will disappear after ${formatDisappearTime(seconds)}`);
    } else {
      toast('Disappearing messages turned off');
    }
  } catch (e) {
    toast('Failed to set timer', 'error');
  }
}
