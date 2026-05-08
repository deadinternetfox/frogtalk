/* ─── dms.js ──────────────────────────────────────────────────────────────── */
'use strict';

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

// Persistent per-message plaintext cache. Once a message has been
// successfully decrypted on this device we remember it so re-renders,
// reloads and tab-restores stay readable even if the ECDH shared key
// later becomes briefly unavailable (e.g. parallel race during cold
// start). Keyed by channelId; value is {msgId: plaintext}. Capped per
// channel to keep localStorage bounded.
const _DM_PLAINTEXT_CACHE_PREFIX = 'frogtalk-dm-plain-v1:';
const _DM_PLAINTEXT_CACHE_MAX = 500;
const _cannotDecryptToastShown = new Set();
function _dmPlainCacheKey(channelId) {
  return _DM_PLAINTEXT_CACHE_PREFIX + String(channelId || 0);
}
function _readDMPlaintextCache(channelId) {
  try {
    const raw = localStorage.getItem(_dmPlainCacheKey(channelId));
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch { return {}; }
}
function _writeDMPlaintextCache(channelId, map) {
  try {
    // Trim oldest by msg id if we exceed the cap.
    const ids = Object.keys(map);
    if (ids.length > _DM_PLAINTEXT_CACHE_MAX) {
      ids.sort((a, b) => Number(a) - Number(b));
      const drop = ids.slice(0, ids.length - _DM_PLAINTEXT_CACHE_MAX);
      for (const k of drop) delete map[k];
    }
    localStorage.setItem(_dmPlainCacheKey(channelId), JSON.stringify(map));
  } catch {}
}
function _rememberDMPlaintext(channelId, msgId, plaintext) {
  if (!channelId || !msgId || typeof plaintext !== 'string' || !plaintext) return;
  if (_looksEncryptedBlob(plaintext)) return;
  const map = _readDMPlaintextCache(channelId);
  if (map[msgId] === plaintext) return;
  map[msgId] = plaintext;
  _writeDMPlaintextCache(channelId, map);
}
function _recallDMPlaintext(channelId, msgId) {
  if (!channelId || !msgId) return null;
  const map = _readDMPlaintextCache(channelId);
  return Object.prototype.hasOwnProperty.call(map, msgId) ? map[msgId] : null;
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

function _looksEncryptedBlob(content) {
  if (typeof content !== 'string') return false;
  const s = content.trim();
  if (!s || s.length < 40) return false;
  if (s.startsWith('[[CALLLOG]]')) return false;
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
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
  return /^[A-Za-z0-9+/_=-]+$/.test(s);
}

function _dmPreviewText(content, hasMedia, mediaType) {
  const c = _parseDMCallLog(content);
  if (c) return c.subtitle || c.title || 'Call update';
  if (_looksEncryptedBlob(content)) return 'Encrypted message';
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
    const nick = esc(p.nickname || 'frog');
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
          `<div class="share-card-name">@${nick}</div>` +
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
    const nick = esc(p.nickname || 'frog');
    let preview = String(p.content || '').trim();
    if (!preview) preview = '🎬 Watch this reel in Frog Social';
    const safePreview = esc(preview.substring(0, 90));
    const pid = Number(p.id || postId);
    placeholder.outerHTML =
      `<div class="share-card" data-social-reel="${pid}" onclick="openDMSocialReel(this.dataset.socialReel)">` +
        `<div style="flex-shrink:0">${UI.avatarEl(p.avatar || null, p.nickname || 'frog', 42)}</div>` +
        `<div class="share-card-info">` +
          `<div class="share-card-label">Frog Social Reel</div>` +
          `<div class="share-card-name">@${nick}</div>` +
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
  const msgEl = document.getElementById(`msg-${msgId}`);
  if (!msgEl) return;
  // Invite cards: delegate to the channel-side loader so DMs and channels
  // render identical join cards (icon + room name + Join/Open button).
  // The channel loader is keyed off the same .invite-card-placeholder
  // [data-invite-code] markup we emit during DM render.
  msgEl.querySelectorAll('.invite-card-placeholder[data-invite-code]').forEach(el => {
    const code = (el.dataset.inviteCode || '').trim();
    if (!code) return;
    try {
      if (typeof Messages !== 'undefined' && typeof Messages._loadInviteCard === 'function') {
        Messages._loadInviteCard(msgId, code);
      } else if (typeof window !== 'undefined' && window.Messages && typeof window.Messages._loadInviteCard === 'function') {
        window.Messages._loadInviteCard(msgId, code);
      }
    } catch {}
  });
  // FrogSocial profile cards: same delegation pattern as invites.
  msgEl.querySelectorAll('.social-profile-card-placeholder[data-social-profile]').forEach(el => {
    const nick = (el.dataset.socialProfile || '').trim();
    if (!nick) return;
    try {
      if (typeof Messages !== 'undefined' && typeof Messages._loadSocialProfileCard === 'function') {
        Messages._loadSocialProfileCard(msgId, nick);
      } else if (typeof window !== 'undefined' && window.Messages && typeof window.Messages._loadSocialProfileCard === 'function') {
        window.Messages._loadSocialProfileCard(msgId, nick);
      }
    } catch {}
  });
  msgEl.querySelectorAll('.dm-social-post-card-placeholder[data-social-post]').forEach(el => {
    const postId = Number(el.dataset.socialPost || '0');
    if (Number.isFinite(postId) && postId > 0) _loadDMSocialPostCard(msgId, postId);
  });
  msgEl.querySelectorAll('.dm-social-reel-card-placeholder[data-social-reel]').forEach(el => {
    const postId = Number(el.dataset.socialReel || '0');
    if (Number.isFinite(postId) && postId > 0) _loadDMSocialReelCard(msgId, postId);
  });
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
      <div class="yt-embed" style="margin-top:8px;max-width:560px;width:100%;border-radius:10px;overflow:hidden;background:linear-gradient(180deg,#173027 0%,#102018 100%);border:1px solid #2f5548;box-shadow:0 2px 12px rgba(0,0,0,.35)">
        <div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden">
          <iframe
            src="https://www.youtube.com/embed/${esc(preview.video_id)}"
            style="position:absolute;top:0;left:0;width:100%;height:100%;border:0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
          ></iframe>
        </div>
        <div style="padding:8px 12px;border-top:1px solid #2f5548;background:rgba(12,28,22,.52)">
          <div style="font-size:11px;color:#ff0000;display:flex;align-items:center;gap:4px;margin-bottom:4px">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#ff0000"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"/><path fill="#fff" d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
            YouTube${preview.author ? ` • ${esc(preview.author)}` : ''}
          </div>
          <a href="${esc(preview.url)}" target="_blank" rel="noopener" style="font-weight:600;color:#dff5e8;font-size:13px;text-decoration:none;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(preview.title || 'YouTube Video')}</a>
        </div>
      </div>`;
  } else if (preview.type === 'spotify' && preview.embed_url) {
    const height = preview.spotify_type === 'track' ? '80' : '152';
    html = `
      <div class="spotify-embed" style="margin-top:8px;max-width:400px;border-radius:12px;overflow:hidden">
        <iframe
          src="${esc(preview.embed_url)}?theme=0"
          width="100%"
          height="${height}"
          frameBorder="0"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          style="border-radius:12px"
        ></iframe>
      </div>`;
  } else {
    html = `
      <a href="${esc(preview.url)}" target="_blank" rel="noopener" class="link-preview" style="display:block;margin-top:8px;background:linear-gradient(180deg,#173027 0%,#102018 100%);border:1px solid #2f5548;border-radius:8px;overflow:hidden;text-decoration:none;color:inherit;max-width:480px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.35)">
        ${preview.image ? `<img src="${esc(preview.image)}" alt="" style="width:100%;max-height:260px;object-fit:cover" onerror="this.style.display='none'">` : ''}
        <div style="padding:10px;background:rgba(12,28,22,.52)">
          <div style="font-size:11px;color:#85a89a;display:flex;align-items:center;gap:4px;margin-bottom:4px">
            ${preview.favicon ? `<img src="${esc(preview.favicon)}" style="width:14px;height:14px;border-radius:2px" onerror="this.style.display='none'">` : ''}
            ${esc(preview.site_name || '')}
          </div>
          ${preview.title ? `<div style="font-weight:600;color:#dff5e8;margin-bottom:4px;font-size:14px">${esc(preview.title)}</div>` : ''}
          ${preview.description ? `<div style="font-size:12px;color:#85a89a;line-height:1.4">${esc(preview.description.substring(0, 150))}${preview.description.length > 150 ? '…' : ''}</div>` : ''}
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
        // Move top spacing from embed to wrapper so the X anchor point is stable.
        wrap.style.marginTop = '8px';
        newEmbed.style.marginTop = '0';
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



async function _getDMSharedKey(peerId, opts = {}) {
  const id = Number(peerId || 0);
  if (!id) return null;
  const force = !!opts.force;
  if (!force && _dmSharedKeyCache.has(id)) return _dmSharedKeyCache.get(id);
  let peerPub = (!force && _dmPeerPubKeyCache.get(id)) || null;
  if (!peerPub) {
    try {
      const r = await apiFetch(`/api/users/${id}/pubkey`);
      if (!r.ok) return null;
      const d = await r.json();
      peerPub = d.ecdh_pub_key || d.pub_key || null;
      if (peerPub) _dmPeerPubKeyCache.set(id, peerPub);
    } catch {
      return null;
    }
  }
  if (!peerPub || typeof Crypto === 'undefined' || !Crypto.deriveShared) return null;
  try {
    const key = await Crypto.deriveShared(peerPub);
    if (key) _dmSharedKeyCache.set(id, key);
    return key || null;
  } catch {
    return null;
  }
}

function _invalidateDMPeerKey(peerId) {
  const id = Number(peerId || 0);
  if (!id) return;
  _dmSharedKeyCache.delete(id);
  _dmPeerPubKeyCache.delete(id);
}

async function _decryptDMPreviewContent(cipher, peerId, peerNick) {
  const raw = String(cipher || '');
  if (!raw) return '';
  if (_parseDMCallLog(raw)) return raw;

  // Primary path: ECDH shared key for this peer.
  try {
    const key = await _getDMSharedKey(peerId);
    if (key && typeof Crypto !== 'undefined' && Crypto.decrypt) {
      const out = await Crypto.decrypt(raw, key);
      if (out !== null) return out;
    }
  } catch {}

  // Re-fetch the peer's pubkey once and retry. Covers the case where the
  // peer logged in from another device and rotated their server pubkey
  // mid-session: our cached shared key would otherwise stay stale forever.
  try {
    _invalidateDMPeerKey(peerId);
    const key2 = await _getDMSharedKey(peerId, { force: true });
    if (key2 && typeof Crypto !== 'undefined' && Crypto.decrypt) {
      const out = await Crypto.decrypt(raw, key2);
      if (out !== null) return out;
    }
  } catch {}

  // Legacy fallback: deterministic DM key derivation.
  try {
    if (typeof Crypto !== 'undefined' && Crypto.getDMKey && Crypto.decrypt && STATE?.user?.nickname && peerNick) {
      const legacyKey = await Crypto.getDMKey(STATE.user.nickname, peerNick);
      const out = await Crypto.decrypt(raw, legacyKey);
      if (out !== null) return out;
    }
  } catch {}

  // If decrypt fails, keep the raw payload so message rendering can still
  // show a lock placeholder instead of an empty bubble.
  return raw;
}

/* ── Sidebar DM list ────────────────────────────────────────────────────────── */
async function loadDMChannels () {
  const sidebarEl = document.getElementById('dm-channels');
  if (sidebarEl && !_dmChannels.length) {
    sidebarEl.innerHTML = `<div style="padding:6px 8px"><span class="skel-line" style="width:70%;height:10px;display:block;margin-bottom:6px"></span><span class="skel-line" style="width:50%;height:10px;display:block"></span></div>`;
  }
  try {
    const r = await apiFetch('/api/dms');
    if (!r.ok) return;
    const data = await r.json();
    _dmChannels = await Promise.all((data.channels || data || []).map(async (ch) => {
      const peerNick = ch.other_nick || ch.nickname || '';
      const peerId = ch.other_id || ch.with_user_id || 0;
      const previewContent = await _decryptDMPreviewContent(ch.last_msg, peerId, peerNick);
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
  _show('encrypt-btn');
  // Encode DM peer info for calls
  STATE.dmPeerNick = nickname;

  // Load messages FIRST — that's the user's primary expectation. The ECDH
  // handshake + pubkey fetch used to block this path; if either stalled the
  // spinner never went away. Now it runs in the background while the chat
  // opens immediately.
  const _openId = id;
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
      const rk = await withTimeout(apiFetch('/api/users/' + peerUserId + '/pubkey'), 5000);
      if (!rk || !rk.ok) return;
      const kd = await rk.json();
      const peerPubKey = kd.ecdh_pub_key || kd.pub_key || null;
      if (!peerPubKey) return;
      if (!_activeDM || _activeDM.id !== _openId) return;
      STATE.dmPeerPubKey = peerPubKey;
      await deriveSharedSecret(peerPubKey);
      try {
        const _enc = document.getElementById('encrypt-indicator');
        if (_enc && _activeDM && _activeDM.id === _openId) {
          _enc.style.display = STATE.sharedSecret ? '' : 'none';
        }
      } catch {}
      // Cold-start race: loadDMMessages ran in parallel and may have decrypted
      // *before* the ECDH key was ready, leaving cipher-blobs in m.content
      // (which renderDMMessage now shows as "🔒 Encrypted message"). Now
      // that the shared key is derived, retry decryption on every still-
      // encrypted message and re-render so the chat shows real plaintext.
      if (_activeDM && _activeDM.id === _openId && Array.isArray(_dmMessages) && _dmMessages.length) {
        const _peerNk2 = _activeDM?.nickname || '';
        let _changed = false;
        for (const m of _dmMessages) {
          if (!m || typeof m.content !== 'string') continue;
          if (_looksEncryptedBlob(m.content)) {
            try {
              const dec = await _decryptDMPreviewContent(m.content, peerUserId, _peerNk2);
              if (dec && dec !== m.content && !_looksEncryptedBlob(dec)) {
                m.content = dec; _changed = true;
                _rememberDMPlaintext(_activeDM.id, m.id, dec);
              } else {
                // Still cipher — try the per-device plaintext cache so we
                // at least show history that was decrypted on this browser
                // before. Avoids the alarming 🔒 across the whole feed when
                // a single re-render happens before keys settle.
                const cached = _recallDMPlaintext(_activeDM.id, m.id);
                if (cached) { m.content = cached; _changed = true; }
              }
            } catch {}
          }
          if (m.reply_content && typeof m.reply_content === 'string' && _looksEncryptedBlob(m.reply_content)) {
            try {
              const dec = await _decryptDMPreviewContent(m.reply_content, peerUserId, _peerNk2);
              if (dec && dec !== m.reply_content) { m.reply_content = dec; _changed = true; }
            } catch {}
          }
        }
        if (_changed && _activeDM && _activeDM.id === _openId) {
          if (_activeDM.id) _dmHistoryCache.set(_activeDM.id, _dmMessages.map(x => ({ ...x })));
          renderDMChat();
        }
      }
    } catch (e) { /* silent — encryption is best-effort */ }
  })();

  await msgsP;
  await timerP;
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
  const _peerUserId  = _activeDM?.user_id || _dmChanEntry?.with_user_id || 0;
  const _peerNick    = _activeDM?.nickname || '';
  const msgs = await Promise.all(rawMsgs.map(async (msg) => {
    if (!msg) return msg;
    const next = _normalizeDMMessage(msg);
    if (next.content) {
      try { next.content = await _decryptDMPreviewContent(next.content, _peerUserId, _peerNick); } catch {}
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
  if (!area) return;
  if (!_dmMessages.length) {
    area.innerHTML = `<div style="text-align:center;color:#555;padding:48px 16px">
      <div style="display:flex;justify-content:center;margin-bottom:10px">${fmtAv(_activeDM.avatar, _activeDM.nickname, 64)}</div>
      <div style="font-size:18px;font-weight:700;margin:8px 0">This is the beginning of your DM with ${esc(_activeDM.nickname)}</div>
      <div style="font-size:13px;color:#444">Messages are end-to-end encrypted 🔒</div>
    </div>`;
    return;
  }
  _dmMessages = _dmMessages.map(m => _normalizeDMMessage(m));
  area.innerHTML = _dmMessages.map(m => renderDMMessage(m)).join('');
  // One-shot dialog per DM session if any message body is still cipher-shaped
  // after every decrypt path. These messages were encrypted to another
  // device's key and can't be recovered here — reset won't help. Be honest
  // about it; offer a "Learn more" path into the encryption modal.
  try {
    const cid = _activeDM?.id;
    if (cid && !_cannotDecryptToastShown.has(cid)) {
      const undec = _dmMessages.filter(m => typeof m?.content === 'string' && _looksEncryptedBlob(m.content)).length;
      if (undec > 0) {
        _cannotDecryptToastShown.add(cid);
        if (typeof UI !== 'undefined' && UI.notice) {
          UI.notice({
            icon: '🔒',
            title: `${undec} older message${undec===1?'':'s'} can't be read on this device`,
            message: `${undec===1?'This message was':'These messages were'} encrypted to an encryption key this device doesn't hold, so ${undec===1?'it':'they'} can't be unlocked here.\n\nThis usually happens when either you or the other person signed in on a new device, reinstalled the app, or cleared local data — FrogTalk then issues fresh end-to-end keys, and older ciphertext stays readable only on the device it was originally delivered to.\n\nNew messages in this chat will work normally going forward.`,
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

function renderDMMessage (m) {
  // Loose numeric compare — server may send sender_id as string in some paths.
  const _uid = STATE.user?.id;
  const mine = (m.sender_id != null && _uid != null && (+m.sender_id === +_uid))
            || (!!m.sender_nick && !!STATE.user?.nickname && m.sender_nick === STATE.user.nickname);
  const time  = new Date(m.created_at && m.created_at.endsWith('Z') ? m.created_at : m.created_at + 'Z').toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  const avatar = m.sender_avatar || m.avatar || '🐸';
  const senderNick = m.sender_nick || '';
  const editedTag = (m.edited_at || m.edited) ? '<span class="msg-edited">(edited)</span>' : '';

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
    if (mimeType.startsWith('image/') || (!mimeType && mediaUrl.startsWith('data:image'))) {
      inner = `<img src="${mediaUrl}" class="msg-media" onclick="openLightbox('${mediaUrl}')" loading="lazy">`;
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
      const _vSrcAttr = _isNote ? `data-pending-src="${mediaUrl}"` : `src="${mediaUrl}"`;
      inner = `<div class="chat-video${_noteCls}"${_noteAttr} data-sender="${_vSender}" data-time="${time}">`+
        `<div class="cv-poster"></div>`+
        `<video ${_vSrcAttr} class="msg-media clickable-media" data-sender="${_vSender}" data-time="${time}" preload="${_preload}" muted playsinline></video>`+
        `<div class="cv-loading"><div class="cv-spinner"></div></div>`+
        `<div class="cv-overlay"><div class="cv-play" aria-label="Play video" role="button"></div></div>`+
        `<div class="cv-badge"><span class="cv-icon">${_badgeIco}</span><span class="cv-dur">${_badgeLbl}</span></div>`+
      `</div>`;
    } else if (mimeType.startsWith('audio/') || (!mimeType && mediaUrl.startsWith('data:audio'))) {
      inner = `<audio src="${mediaUrl}" controls preload="metadata" style="width:260px;display:block;margin-top:6px"></audio>`;
    } else {
      const name = mediaUrl.split('/').pop();
      inner = `<a href="${mediaUrl}" target="_blank" style="color:#4caf50;display:block;margin-top:4px">📄 ${esc(name)}</a>`;
    }
    if (isBlurred) {
      // Wrap in a spoiler overlay that reveals on click. Replace the media's
      // click handler so it doesn't fire openLightbox while still blurred.
      const wrappedInner = inner
        .replace('class="msg-media"', 'class="spoiler-img msg-media"')
        .replace(/onclick="[^"]*"/, '');
      mediaHtml = `<div class="spoiler-wrap" id="sp-dm-${m.id}" onclick="revealDMSpoiler(this, event)" data-media="${esc(mediaUrl)}">
        <div class="spoiler-overlay">👁️ Spoiler — Click to Reveal</div>
        ${wrappedInner}
      </div>`;
    } else {
      mediaHtml = inner;
    }
  } else if (m.has_media) {
    // Auto-loading stub (IntersectionObserver kicks in via _observeDMLazyMedia).
    const icon = mimeType?.startsWith('video') ? '🎬' : mimeType?.startsWith('audio') ? '🎵' : '🖼️';
    mediaHtml = `<div class="media-lazy auto" id="dm-media-lazy-${m.id}" data-msg-id="${m.id}" data-channel-id="${m.channel_id || _activeDM?.id || ''}" data-media-type="${esc(mimeType)}">
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
  const _rawContent = (typeof m.content === 'string') ? m.content : '';
  const _isCipherBlob = _looksEncryptedBlob(_rawContent);
  const safeContent = (m.view_once || isViewOnceConsumed)
    ? ''
    : (_isCipherBlob ? '' : _rawContent);
  if (safeContent) {
    contentHtml = esc(safeContent);
    const urlRe = /https?:\/\/[^\s<>"]+/g;
    contentHtml = contentHtml.replace(/@(\w+)/g, (match, nick) => {
      const isSelf = nick.toLowerCase() === STATE.user?.nickname?.toLowerCase();
      return `<span class="mention${isSelf ? ' mention-self' : ''}">@${nick}</span>`;
    });
    contentHtml = contentHtml.replace(urlRe, url => {
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
        return `<span class="dm-social-post-card-placeholder" data-social-post="${social.postId}">` +
          `<span class="invite-card-loading">🐸 Loading post…</span></span>`;
      }
      if (social?.type === 'reel') {
        return `<span class="dm-social-reel-card-placeholder" data-social-reel="${social.postId}">` +
          `<span class="invite-card-loading">🐸 Loading reel…</span></span>`;
      }
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="msg-link" data-preview-url="${esc(url)}">${url}</a>`;
    });
    if (typeof renderCustomEmojisInText === 'function') {
      contentHtml = renderCustomEmojisInText(contentHtml);
    }
  }
  if (!contentHtml && !mediaHtml) {
    if (_isCipherBlob || m._decryptPending) {
      // Decryption hasn't succeeded yet — show a lock placeholder instead
      // of the misleading "Media" string. A re-decrypt happens on the next
      // render pass once the ECDH key derives (loadDMMessages / openDM
      // attach the peer pubkey → _dmSharedKeyCache populates).
      contentHtml = '<em style="color:#888">\uD83D\uDD12 Older message — encrypted on a previous device</em>';
    } else if (m.has_media) {
      contentHtml = '<em style="color:#444">Media</em>';
    }
  }

  // Reply quote
  const replyPreviewRaw = String(m.reply_content || '…');
  const replyPreviewSafe = _looksEncryptedBlob(replyPreviewRaw) ? 'Encrypted message' : replyPreviewRaw;
  const replyNick = m.reply_nickname || m.reply_nick || senderNick || '?';
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
  const actions = `
    <div class="msg-actions">
      <button class="msg-act-btn" title="Reply" onclick="replyToDM(${m.id},'${esc(senderNick)}','${esc((safeContent||'').substring(0,80))}')">↩️</button>
      <button class="msg-act-btn" title="React" onclick="showDMReactMenu(${m.id}, this)">😀</button>
      <button class="msg-act-btn" title="Copy" onclick="Messages.copyMessage(${m.id})">📋</button>
      ${fwdDisabled ? '' : `<button class="msg-act-btn" title="Forward" onclick="forwardDMMessage(${m.id})">📤</button>`}
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
      ${contentHtml ? `<div class="msg-content">${contentHtml}</div>` : ''}
      ${mediaHtml}
      ${reactionsHtml}
    </div>
    ${actions}
  </div>`;
}

function _dmReactionHtml (reactions, msgId) {
  if (!reactions || typeof reactions === 'string') return '';
  const obj = typeof reactions === 'object' ? reactions : {};
  const pills = Object.entries(obj).map(([emoji, count]) =>
    count > 0 ? `<span class="reaction-pill" onclick="toggleDMReaction(${msgId},'${emoji}')">${emoji} ${count}</span>` : ''
  ).join('');
  if (!pills) return '';
  return `<div class="msg-reactions">${pills}</div>`;
}

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
      const _vSrcAttr = _isNote ? `data-pending-src="${data.media_data}"` : `src="${data.media_data}"`;
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
      html = `<audio src="${data.media_data}" controls preload="metadata" style="width:260px;display:block;margin-top:6px"></audio>`;
    } else {
      html = `<img src="${data.media_data}" class="msg-media" onclick="openLightbox('${data.media_data}')" loading="lazy">`;
    }
    container.outerHTML = html;
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

  // E2E encrypt if shared secret available
  let encryptedContent = content;
  if (content && STATE.sharedSecret) {
    try { encryptedContent = await encryptMsg(content); } catch {}
  }

  const payload = {
    content    : encryptedContent || content,
    reply_to   : _dmReplyTo?.id || null,
    client_mime: fileData?.type || null,
  };

  if (fileData) {
    _dmSending = true;
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '⏳'; }
    // Convert blob to base64 data URL and send as JSON (API only accepts JSON body).
    // Progress phases (matches the channel-message uploader so the toast
    // climbs honestly with bytes-on-the-wire instead of pausing at 70%):
    //   0–20%  Preparing media   (blob → base64)
    //  20–25%  Encrypting        (E2EE DMs only)
    //  25–95%  Uploading         (real XHR upload progress)
    //  95–99%  Server processing
    //    100%  Sent
    try {
      let mediaData = fileData.dataUrl || fileData.data || null;
      if (!mediaData && fileData.blob) {
        UI.showProgressToast('Preparing media…', 0);
        try {
          mediaData = await UI.blobToDataURL(fileData.blob, (pct) => {
            UI.showProgressToast('Preparing media…', Math.max(1, Math.round(pct * 0.20)));
          });
        } catch (err) {
          UI.showProgressToast('Failed to prepare media', 100);
          toast('Could not read attachment: ' + (err?.message || 'unknown error'), 'error');
          return;
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
          content: encryptedContent || content || '',
          media_data: mediaData,
          media_type: fileData.type || '',
          media_name: fileData.name || 'file',
          media_blur: window._pendingMediaBlur ? 1 : 0,
          view_once: window._pendingViewOnce ? 1 : 0,
          reply_to: _dmReplyTo?.id || null,
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
      if (!r.ok) { UI.showProgressToast('Upload failed', 100); toast('Upload failed', 'error'); return; }
      UI.showProgressToast('Sent!', 100);
      clearReplyToDM();
      clearAttachment();
      input.value = '';
      autoResize(input);
      const msg = await r.json();
      appendDMMessage(msg);
    } catch (e) {
      console.error('DM file send error', e);
      UI.showProgressToast('Upload failed', 100);
      toast('Failed to send file', 'error');
    } finally {
      _dmSending = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '➤'; }
    }
    return;
  }

  // Send over WebSocket for speed. Include a client_nonce so we can reconcile
  // the server's echo back to our optimistic bubble.
  const _nonce = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  wsSend({ type: 'dm_message', channel_id: _activeDM.id, content: encryptedContent || content,
           reply_to: _dmReplyTo?.id || null, client_nonce: _nonce });

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
      content    : content,            // plaintext \u2014 what the user typed
      created_at : new Date().toISOString().replace('Z',''),
      reply_to   : _dmReplyTo?.id || null,
      _pending   : true,
    };
    _dmMessages.push(_tempMsg);
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

  // Cheap in-place sidebar update (avoid round-tripping /api/dms on every message
  // which was adding 200-500 ms of perceived send lag).
  (async () => {
    try {
      const ch = _dmChannels.find(c => c.id === data.channel_id);
      if (ch) {
        const previewContent = await _decryptDMPreviewContent(
          data.content || '',
          data.sender_id || ch.with_user_id,
          data.sender_nick || ch.nickname,
        );
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
          const ch2 = _dmChannels.find(c => c.id === data.channel_id);
          const toastContent = await _decryptDMPreviewContent(
            data.content || '',
            data.sender_id || ch2?.with_user_id || 0,
            data.sender_nick || ch2?.nickname || '',
          );
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
      pend.classList.remove('dm-pending');
      pend.removeAttribute('data-own');
      pend.removeAttribute('data-nonce');
      pend.id = `msg-${data.id}`;
      pend.setAttribute('data-dmid', data.id);
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
        _dmMessages[pi] = _normalizeDMMessage({ ...data, content: _dmMessages[pi].content });
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
        fallback.classList.remove('dm-pending');
        fallback.removeAttribute('data-own');
        fallback.removeAttribute('data-nonce');
        fallback.id = `msg-${data.id}`;
        fallback.setAttribute('data-dmid', data.id);
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
          _dmMessages[pi] = _normalizeDMMessage({ ...data, content: _dmMessages[pi].content });
          const previewUrl = _extractDMPreviewUrl(String(_dmMessages[pi].content || ''));
          if (previewUrl && !_dmMessages[pi].preview_suppressed) {
            setTimeout(() => _loadDMPreview(data.id, previewUrl), 80);
          }
        }
        return;
      }
    }
  }

  // Try to decrypt
  (async () => {
    let content = data.content || '';
    if (content) {
      const _dmChanEntry2 = _dmChannels.find(c => c.id === _activeDM?.id);
      const _peerUid  = _activeDM?.user_id || _dmChanEntry2?.with_user_id || 0;
      const _peerNk   = _activeDM?.nickname || '';
      try { content = await _decryptDMPreviewContent(content, _peerUid, _peerNk); } catch {}
    }
    appendDMMessage({ ...data, content });
    // Active chat — immediately mark as read
    if (!document.hidden) markDMRead();
  })();
}

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
  const m = _dmMessages.find(x => x.id === id);
  if (!m) return;
  const newContent = prompt('Edit message:', m.content || '');
  if (newContent === null) return;
  let enc = newContent;
  if (STATE.sharedSecret) { try { enc = await encryptMsg(newContent); } catch {} }
  const r = await apiFetch(`/api/dms/${_activeDM.id}/messages/${id}`, 'PUT', { content: enc });
  if (r.ok) {
    m.content  = newContent;
    m.edited_at = new Date().toISOString();
    renderDMChat();
  }
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
