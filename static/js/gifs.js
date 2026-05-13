/**
 * gifs.js — GIF search and sticker functionality
 */

const GIFs = (() => {
  let _isOpen = false;
  let _searchTimeout = null;
  let _currentTab = 'gifs';  // 'gifs' or 'stickers'
  let _stickerPacks = [];
  let _stickersById = new Map(); // sticker_id -> { image_data, name, effects }
  let _stickerGridDelegated = false;
  let _smStickerCache = {};      // sticker_id -> full sticker row (used by the FX editor)
  let _gifReqSeq = 0;

  // ─── Themed prompt / confirm ─────────────────────────────────────────
  // Electron disables window.prompt() (returns null silently) and native
  // confirm() is unstyled, so build small themed dialogs that match the
  // sticker manager modal. Returns a Promise that resolves to the user
  // input string (for prompt) or true/false (for confirm).
  function _smDialog({ title, message, defaultValue, multiline, placeholder, okLabel, cancelLabel, kind }) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:3000;display:flex;align-items:center;justify-content:center;padding:20px';
      const isConfirm = kind === 'confirm';
      const inputHtml = isConfirm ? '' : (multiline
        ? `<textarea id="sm-dlg-input" rows="3" placeholder="${placeholder || ''}" style="width:100%;background:var(--bg-color);border:1px solid var(--border-color);color:var(--text-color);padding:10px;border-radius:8px;font:inherit;resize:vertical;min-height:60px">${defaultValue ? String(defaultValue).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) : ''}</textarea>`
        : `<input id="sm-dlg-input" type="text" placeholder="${placeholder || ''}" value="${defaultValue ? String(defaultValue).replace(/"/g, '&quot;') : ''}" style="width:100%;background:var(--bg-color);border:1px solid var(--border-color);color:var(--text-color);padding:10px;border-radius:8px;font:inherit">`
      );
      overlay.innerHTML = `
        <div style="background:linear-gradient(180deg,
            color-mix(in srgb, var(--accent-color) 18%, var(--surface-color)) 0%,
            var(--surface-color) 55%,
            color-mix(in srgb, var(--bg-color) 70%, var(--surface-color)) 100%);
          border:1px solid color-mix(in srgb, var(--accent-color) 35%, var(--border-color));
          border-radius:12px;width:420px;max-width:100%;box-shadow:0 18px 48px rgba(0,0,0,.6);color:var(--text-color)">
          <div style="padding:14px 16px;border-bottom:1px solid var(--border-color);font-weight:700">${title || ''}</div>
          <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px">
            ${message ? `<div style="color:var(--text-muted);font-size:13px;line-height:1.4">${message}</div>` : ''}
            ${inputHtml}
          </div>
          <div style="padding:12px 16px;border-top:1px solid var(--border-color);display:flex;gap:8px;justify-content:flex-end">
            <button id="sm-dlg-cancel" style="background:color-mix(in srgb, var(--bg-color) 60%, transparent);border:1px solid var(--border-color);color:var(--text-color);padding:8px 14px;border-radius:8px;cursor:pointer">${cancelLabel || 'Cancel'}</button>
            <button id="sm-dlg-ok" style="background:var(--accent-color);border:1px solid var(--accent-color);color:color-mix(in srgb, var(--accent-color) 12%, #000);padding:8px 14px;border-radius:8px;cursor:pointer;font-weight:700">${okLabel || 'OK'}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('#sm-dlg-input');
      const close = (val) => { try { overlay.remove(); } catch {} resolve(val); };
      overlay.querySelector('#sm-dlg-cancel').onclick = () => close(isConfirm ? false : null);
      overlay.querySelector('#sm-dlg-ok').onclick = () => close(isConfirm ? true : (input ? input.value : ''));
      overlay.addEventListener('click', e => { if (e.target === overlay) close(isConfirm ? false : null); });
      overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); close(isConfirm ? false : null); }
        if (e.key === 'Enter' && !multiline) { e.preventDefault(); close(isConfirm ? true : (input ? input.value : '')); }
      });
      if (input) setTimeout(() => { try { input.focus(); input.select?.(); } catch {} }, 30);
      else setTimeout(() => { try { overlay.querySelector('#sm-dlg-ok').focus(); } catch {} }, 30);
    });
  }
  function _smPrompt(title, defaultValue, opts = {}) {
    return _smDialog({ title, defaultValue, kind: 'prompt', ...opts });
  }
  function _smConfirm(title, message, opts = {}) {
    return _smDialog({ title, message, kind: 'confirm', okLabel: 'OK', cancelLabel: 'Cancel', ...opts });
  }
  let _gifAbortController = null;

  async function _fetchGifApi(url, timeoutMs = 8000) {
    if (_gifAbortController) _gifAbortController.abort();
    const controller = new AbortController();
    _gifAbortController = controller;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        headers: { 'X-Session-Token': State.token || '' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
      if (_gifAbortController === controller) _gifAbortController = null;
    }
  }

  function _renderGifGrid(grid, gifs, emptyText) {
    if (!Array.isArray(gifs) || gifs.length === 0) {
      grid.innerHTML = `<div class="gif-empty">${emptyText}</div>`;
      return;
    }

    grid.innerHTML = gifs.map(gif => {
      const safeUrl = String(gif?.url || '').replace(/'/g, '&#39;');
      const safePreview = String(gif?.preview || gif?.url || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
      return `
        <div class="gif-item" onclick="GIFs.send('${safeUrl}')" title="Click to send">
          <img src="${safePreview}" alt="GIF" loading="lazy">
        </div>
      `;
    }).join('');
  }

  function createPicker() {
    if (document.getElementById('gif-picker')) return;
    
    const picker = document.createElement('div');
    picker.id = 'gif-picker';
    picker.className = 'gif-picker';
    picker.innerHTML = `
      <div class="gif-picker-header">
        <div class="gif-tabs">
          <button class="gif-tab active" data-tab="gifs" onclick="GIFs.switchTab('gifs')">GIFs</button>
          <button class="gif-tab" data-tab="stickers" onclick="GIFs.switchTab('stickers')">Stickers</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="gif-manage-btn" id="gif-manage-btn" onclick="GIFs.openManager()" title="Manage sticker packs" style="display:none;padding:5px 10px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">⚙ Manage</button>
          <button class="gif-close" onclick="GIFs.close()">✕</button>
        </div>
      </div>
      <div class="gif-search-wrap">
        <input type="text" class="gif-search" id="gif-search" placeholder="Search GIFs..." 
               oninput="GIFs.handleSearch(this.value)">
      </div>
      <div class="gif-cat-wrap">
        <button class="gif-cat-scroll gif-cat-scroll-l" type="button" aria-label="Scroll categories left" onclick="GIFs.scrollCats(-1)">‹</button>
        <div class="gif-categories" id="gif-categories"></div>
        <button class="gif-cat-scroll gif-cat-scroll-r" type="button" aria-label="Scroll categories right" onclick="GIFs.scrollCats(1)">›</button>
      </div>
      <div class="gif-grid" id="gif-grid"></div>
    `;
    document.body.appendChild(picker);

    // Add styles
    const style = document.createElement('style');
    style.textContent = `
      .gif-picker {
        position: fixed;
        bottom: 80px;
        right: 20px;
        width: 360px;
        max-width: 95vw;
        height: 450px;
        background: linear-gradient(180deg,
          color-mix(in srgb, var(--accent-color) 18%, var(--surface-color)) 0%,
          var(--surface-color) 55%,
          color-mix(in srgb, var(--bg-color) 70%, var(--surface-color)) 100%);
        border: 1px solid color-mix(in srgb, var(--accent-color) 35%, var(--border-color));
        border-radius: 14px;
        display: none;
        flex-direction: column;
        z-index: 1000;
        box-shadow:
          0 12px 32px rgba(0,0,0,.6),
          0 0 0 1px color-mix(in srgb, var(--accent-color) 10%, transparent),
          inset 0 1px 0 color-mix(in srgb, var(--accent-color) 6%, transparent);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        overflow: hidden;
        color: var(--text-color);
      }
      .gif-picker.open {
        display: flex;
        animation: gpPop .14s ease-out;
      }
      @keyframes gpPop { from{opacity:0;transform:translateY(6px) scale(.98)} to{opacity:1;transform:translateY(0) scale(1)} }
      .gif-picker-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border-color);
      }
      .gif-tabs { display: flex; gap: 4px; background: color-mix(in srgb, var(--bg-color) 60%, transparent); padding:3px; border-radius:8px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-color) 10%, transparent); }
      .gif-tab {
        background: transparent;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 6px 14px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 600;
        transition: background .12s, color .12s;
      }
      .gif-tab:hover { color: var(--text-color); }
      .gif-tab.active {
        background: color-mix(in srgb, var(--accent-color) 22%, var(--bg-color));
        color: var(--accent-color);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-color) 40%, transparent);
      }
      .gif-close {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 18px;
        width: 28px; height: 28px;
        border-radius: 6px;
        transition: background .12s, color .12s;
      }
      .gif-close:hover { color: var(--text-color); background: color-mix(in srgb, var(--accent-color) 12%, transparent); }
      .gif-search-wrap { padding: 8px 12px; }
      .gif-search {
        width: 100%;
        background: color-mix(in srgb, var(--bg-color) 60%, transparent);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 9px 12px;
        color: var(--text-color);
        font-size: 13px;
        outline: none;
        box-sizing: border-box;
        transition: border-color .12s, box-shadow .12s;
      }
      .gif-search:focus {
        border-color: var(--accent-color);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-color) 18%, transparent);
      }
      .gif-categories {
        display: flex;
        gap: 6px;
        padding: 4px 4px 10px;
        overflow-x: auto;
        scrollbar-width: none;
        scroll-behavior: smooth;
        flex: 1;
        min-width: 0;
      }
      .gif-categories::-webkit-scrollbar { display: none; }
      .gif-cat-wrap {
        position: relative;
        display: flex;
        align-items: center;
        padding: 0 8px;
        gap: 2px;
      }
      .gif-cat-scroll {
        flex-shrink: 0;
        width: 26px;
        height: 26px;
        display: none;
        align-items: center;
        justify-content: center;
        background: color-mix(in srgb, var(--bg-color) 60%, transparent);
        border: 1px solid var(--border-color);
        color: var(--text-color);
        font-size: 18px;
        font-weight: 700;
        line-height: 1;
        border-radius: 50%;
        cursor: pointer;
        transition: background .12s, transform .12s, border-color .12s, color .12s;
        padding: 0;
        margin-bottom: 6px;
        position: relative;
        z-index: 3;
      }
      .gif-cat-scroll:hover {
        background: color-mix(in srgb, var(--accent-color) 22%, var(--bg-color));
        border-color: var(--accent-color);
        color: var(--accent-color);
        transform: scale(1.08);
      }
      .gif-cat-scroll:active { transform: scale(.95); }
      .gif-cat-wrap.can-scroll-left  .gif-cat-scroll-l { display: flex; }
      .gif-cat-wrap.can-scroll-right .gif-cat-scroll-r { display: flex; }
      .gif-cat-wrap::after,
      .gif-cat-wrap::before {
        content:'';position:absolute;top:4px;bottom:10px;width:18px;pointer-events:none;z-index:1;
        opacity:0;transition:opacity .15s;
      }
      .gif-cat-wrap::after  { right:36px; background:linear-gradient(270deg, var(--surface-color), transparent); }
      .gif-cat-wrap::before { left:36px;  background:linear-gradient(90deg,  var(--surface-color), transparent); }
      .gif-cat-wrap.can-scroll-right::after { opacity:1; }
      .gif-cat-wrap.can-scroll-left::before { opacity:1; }
      .gif-cat-wrap:not(.can-scroll-left)  .gif-cat-scroll-l { display: none; }
      .gif-cat-wrap:not(.can-scroll-right) .gif-cat-scroll-r { display: none; }
      @media (hover: none) {
        .gif-cat-scroll { display: none !important; }
        .gif-cat-wrap::after, .gif-cat-wrap::before { display: none; }
        .gif-cat-wrap { padding: 0; }
        .gif-categories { padding: 4px 12px 10px; }
      }
      .gif-category {
        background: color-mix(in srgb, var(--bg-color) 60%, transparent);
        border: 1px solid var(--border-color);
        color: var(--text-muted);
        cursor: pointer;
        padding: 5px 12px;
        border-radius: 14px;
        font-size: 12px;
        font-weight: 500;
        white-space: nowrap;
        flex-shrink: 0;
        transition: background .12s, color .12s, border-color .12s;
      }
      .gif-category:hover {
        background: color-mix(in srgb, var(--accent-color) 12%, transparent);
        color: var(--text-color);
        border-color: color-mix(in srgb, var(--accent-color) 35%, var(--border-color));
      }
      .gif-grid {
        flex: 1;
        overflow-y: auto;
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 6px;
        padding: 8px 12px 12px;
        scrollbar-width: thin;
        scrollbar-color: color-mix(in srgb, var(--accent-color) 40%, transparent) transparent;
      }
      .gif-grid::-webkit-scrollbar { width: 6px; }
      .gif-grid::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--accent-color) 35%, transparent); border-radius: 3px; }
      .gif-item {
        cursor: pointer;
        border-radius: 8px;
        overflow: hidden;
        background: color-mix(in srgb, var(--bg-color) 60%, transparent);
        aspect-ratio: 1;
        transition: transform .12s, box-shadow .12s;
      }
      .gif-item:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(0,0,0,.5), 0 0 0 1px color-mix(in srgb, var(--accent-color) 30%, transparent);
      }
      .gif-item img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        transition: transform .2s;
      }
      .gif-item:hover img { transform: scale(1.04); }
      .sticker-item {
        cursor: pointer;
        padding: 8px;
        border-radius: 8px;
        background: transparent;
        transition: background .2s, transform .12s;
      }
      .sticker-item:hover {
        background: color-mix(in srgb, var(--accent-color) 12%, transparent);
        transform: translateY(-1px);
      }
      .sticker-item img {
        width: 100%;
        height: auto;
        max-height: 100px;
        object-fit: contain;
      }
      .sticker-pack-header {
        grid-column: 1 / -1;
        padding: 8px 4px 4px;
        color: var(--accent-color);
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: .5px;
        border-bottom: 1px solid var(--border-color);
      }
      .gif-loading {
        grid-column: 1 / -1;
        text-align: center;
        padding: 40px;
        color: var(--text-muted);
      }
      .gif-empty {
        grid-column: 1 / -1;
        text-align: center;
        padding: 40px;
        color: var(--text-muted);
        line-height: 1.5;
      }
      .gif-empty .gif-empty-hint { font-size: 12px; opacity: .8; margin-top: 6px; }
      .gif-manage-btn {
        background: color-mix(in srgb, var(--accent-color) 14%, transparent) !important;
        border: 1px solid color-mix(in srgb, var(--accent-color) 35%, var(--border-color)) !important;
        color: var(--text-color) !important;
      }
      .gif-manage-btn:hover {
        background: color-mix(in srgb, var(--accent-color) 22%, transparent) !important;
        border-color: var(--accent-color) !important;
      }
    `;
    document.head.appendChild(style);
  }

  // Outside-click / Escape close handlers — attached only while the picker is open.
  let _outsideHandler = null;
  let _escHandler = null;
  function _attachOutsideClose() {
    _detachOutsideClose();
    _outsideHandler = (e) => {
      const p = document.getElementById('gif-picker');
      if (!p || !p.classList.contains('open')) return;
      if (p.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.gif-btn')) return;
      close();
    };
    _escHandler = (e) => {
      if (e.key === 'Escape') {
        const p = document.getElementById('gif-picker');
        if (p && p.classList.contains('open')) close();
      }
    };
    // Defer attachment to next tick so the opening click/tap doesn't immediately close.
    setTimeout(() => {
      if (!_outsideHandler) return;
      document.addEventListener('mousedown', _outsideHandler, true);
      document.addEventListener('click',     _outsideHandler, true);
      document.addEventListener('touchstart',_outsideHandler, { capture: true, passive: true });
      document.addEventListener('keydown',   _escHandler, true);
    }, 0);
  }
  function _detachOutsideClose() {
    if (_outsideHandler) {
      document.removeEventListener('mousedown', _outsideHandler, true);
      document.removeEventListener('click',     _outsideHandler, true);
      document.removeEventListener('touchstart',_outsideHandler, true);
    }
    if (_escHandler) {
      document.removeEventListener('keydown', _escHandler, true);
    }
    _outsideHandler = null;
    _escHandler = null;
  }

  function toggle() {
    createPicker();
    const picker = document.getElementById('gif-picker');
    if (!picker) return;
    // Derive state from DOM rather than the cached _isOpen flag — when send()
    // closes the picker, an outside-click handler bug or a missed teardown
    // could leave _isOpen out of sync, leaving the button "stuck" (clicks
    // would re-close instead of re-opening). Trusting the class is foolproof.
    const wasOpen = picker.classList.contains('open');
    _isOpen = !wasOpen;
    picker.classList.toggle('open', _isOpen);
    // Mutually exclusive with the emoji picker.
    if (_isOpen) {
      try { if (typeof toggleEmojiPicker === 'function') toggleEmojiPicker(true); } catch {}
    }

    // Anchor the picker so its bottom edge sits just above the GIF button,
    // using bottom/left positioning so the picker grows *upward* from the
    // composer. The old top-based math mis-clamped on short viewports and
    // flung the picker to the top of the chat.
    if (_isOpen) {
      try {
        const btn = document.querySelector('.gif-btn');
        if (btn) {
          const r  = btn.getBoundingClientRect();
          // Compact footprint — matches native emoji/gif pickers.
          const pw = Math.min(320, window.innerWidth - 16);
          // 4px gap between picker bottom and button top.
          const bottomGap = Math.max(8, window.innerHeight - r.top + 4);
          // Height scales to available space, capped at 360px.
          const avail = r.top - 12;
          const ph = Math.max(260, Math.min(360, avail));
          let left = r.right - pw;
          if (left < 8) left = 8;
          if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
          picker.style.top    = 'auto';
          picker.style.bottom = bottomGap + 'px';
          picker.style.left   = left + 'px';
          picker.style.right  = 'auto';
          picker.style.width  = pw + 'px';
          picker.style.height = ph + 'px';
        }
      } catch {}
    }

    if (_isOpen) {
      _attachOutsideClose();
      if (_currentTab === 'gifs') {
        loadTrending();
        loadCategories();
      } else {
        loadStickerPacks();
      }
    } else {
      _detachOutsideClose();
    }
  }

  function close() {
    const picker = document.getElementById('gif-picker');
    if (picker) picker.classList.remove('open');
    _isOpen = false;
    _detachOutsideClose();
  }

  function switchTab(tab) {
    _currentTab = tab;
    document.querySelectorAll('.gif-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    
    const searchInput = document.getElementById('gif-search');
    const categoriesEl = document.getElementById('gif-categories');
    
    if (tab === 'gifs') {
      searchInput.placeholder = 'Search GIFs...';
      categoriesEl.style.display = 'flex';
      document.getElementById('gif-manage-btn').style.display = 'none';
      loadTrending();
      loadCategories();
    } else {
      searchInput.placeholder = 'Search stickers...';
      categoriesEl.style.display = 'none';
      document.getElementById('gif-manage-btn').style.display = '';
      loadStickerPacks();
    }
  }

  function handleSearch(query) {
    clearTimeout(_searchTimeout);
    const trimmed = String(query || '').trim();
    _searchTimeout = setTimeout(() => {
      if (_currentTab === 'gifs') {
        if (trimmed.length > 1) {
          searchGifs(trimmed);
        } else {
          loadTrending();
        }
      } else {
        // Filter stickers locally
        filterStickers(trimmed);
      }
    }, 300);
  }

  async function loadCategories() {
    const container = document.getElementById('gif-categories');
    try {
      const res = await apiFetch('/api/media/gifs/categories');
      if (!res.ok) return;
      const data = await res.json();
      
      container.innerHTML = data.categories.map(cat => 
        `<button class="gif-category" onclick="GIFs.searchGifs('${cat.search}')">${cat.name}</button>`
      ).join('');
      _refreshCatScrollEdges();
    } catch (e) {
      console.error('Failed to load categories', e);
    }
  }

  // Update .can-scroll-left/.can-scroll-right on the wrap so the floating
  // arrows + edge fades only show when there's actually content to scroll to.
  function _refreshCatScrollEdges() {
    const container = document.getElementById('gif-categories');
    if (!container) return;
    const wrap = container.parentElement;
    if (!wrap || !wrap.classList.contains('gif-cat-wrap')) return;
    const update = () => {
      const canLeft  = container.scrollLeft > 4;
      const canRight = container.scrollLeft + container.clientWidth < container.scrollWidth - 4;
      wrap.classList.toggle('can-scroll-left',  canLeft);
      wrap.classList.toggle('can-scroll-right', canRight);
    };
    update();
    if (!container._scrollBound) {
      container._scrollBound = true;
      container.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
    }
  }

  function scrollCats(dir) {
    const container = document.getElementById('gif-categories');
    if (!container) return;
    const pills = Array.from(container.querySelectorAll('.gif-category'));
    if (!pills.length) {
      const step = Math.max(120, container.clientWidth * 0.7);
      container.scrollBy({ left: dir * step, behavior: 'smooth' });
      return;
    }
    // Snap to the next pill boundary so clicks never leave a pill half-hidden
    // under the arrow fade. We find the first pill fully beyond the current
    // visible edge in the scroll direction and align it flush with that edge.
    const viewLeft  = container.scrollLeft;
    const viewRight = viewLeft + container.clientWidth;
    let targetLeft = null;
    if (dir > 0) {
      // Find the first pill whose right edge exceeds the visible area.
      for (const p of pills) {
        const right = p.offsetLeft + p.offsetWidth;
        if (right > viewRight - 2) { targetLeft = p.offsetLeft - 8; break; }
      }
    } else {
      // Find the last pill whose left edge is before the current view.
      for (let i = pills.length - 1; i >= 0; i--) {
        const p = pills[i];
        if (p.offsetLeft < viewLeft - 2) {
          // Align this pill's right with the visible right edge.
          targetLeft = p.offsetLeft + p.offsetWidth - container.clientWidth + 8;
          break;
        }
      }
    }
    if (targetLeft == null) {
      const step = Math.max(120, container.clientWidth * 0.7);
      container.scrollBy({ left: dir * step, behavior: 'smooth' });
      return;
    }
    const max = container.scrollWidth - container.clientWidth;
    targetLeft = Math.max(0, Math.min(max, targetLeft));
    container.scrollTo({ left: targetLeft, behavior: 'smooth' });
  }

  async function loadTrending() {
    const grid = document.getElementById('gif-grid');
    if (!grid) return;
    const reqSeq = ++_gifReqSeq;
    grid.innerHTML = '<div class="gif-loading">Loading...</div>';
    
    try {
      const res = await _fetchGifApi('/api/media/gifs/trending');
      if (reqSeq !== _gifReqSeq) return;
      if (res.status === 503) {
        grid.innerHTML = '<div class="gif-empty">GIF service not configured<div class="gif-empty-hint">Ask an admin to set <code>KLIPY_API_KEY</code> on the server.</div></div>';
        return;
      }
      if (!res.ok) throw new Error('API error');
      const data = await res.json();
      if (reqSeq !== _gifReqSeq) return;
      _renderGifGrid(grid, data.gifs || data.results || [], 'No GIFs found');
    } catch (e) {
      if (reqSeq !== _gifReqSeq) return;
      if (e?.name === 'AbortError') return;
      grid.innerHTML = '<div class="gif-empty">Failed to load GIFs<div class="gif-empty-hint">Check your network connection.</div></div>';
    }
  }

  async function searchGifs(query) {
    const grid = document.getElementById('gif-grid');
    if (!grid) return;
    const reqSeq = ++_gifReqSeq;
    const trimmed = String(query || '').trim();
    grid.innerHTML = '<div class="gif-loading">Searching...</div>';
    
    try {
      const res = await _fetchGifApi(`/api/media/gifs/search?q=${encodeURIComponent(trimmed)}`);
      if (reqSeq !== _gifReqSeq) return;
      if (res.status === 503) {
        grid.innerHTML = '<div class="gif-empty">GIF service not configured<div class="gif-empty-hint">Ask an admin to set <code>KLIPY_API_KEY</code> on the server.</div></div>';
        return;
      }
      if (!res.ok) throw new Error('API error');
      const data = await res.json();
      if (reqSeq !== _gifReqSeq) return;
      _renderGifGrid(grid, data.gifs || data.results || [], 'No GIFs found for "' + UI.escHtml(trimmed) + '"');
    } catch (e) {
      if (reqSeq !== _gifReqSeq) return;
      if (e?.name === 'AbortError') return;
      grid.innerHTML = '<div class="gif-empty">Failed to search GIFs</div>';
    }
    
    // Update search input
    const searchInput = document.getElementById('gif-search');
    if (searchInput) searchInput.value = trimmed;
  }

  async function loadStickerPacks() {
    const grid = document.getElementById('gif-grid');
    grid.innerHTML = '<div class="gif-loading">Loading stickers...</div>';
    
    try {
      const res = await apiFetch('/api/media/stickers/packs');
      if (!res.ok) throw new Error('API error');
      const data = await res.json();
      
      _stickerPacks = [...(data.own_packs || []), ...(data.installed_packs || [])];
      
      if (_stickerPacks.length === 0) {
        grid.innerHTML = `
          <div class="gif-empty">
            No stickers yet<br>
            <button onclick="GIFs.showPublicPacks()" style="margin-top:12px;background:var(--accent-color);border:none;color:color-mix(in srgb, var(--accent-color) 12%, #000);padding:8px 16px;border-radius:8px;cursor:pointer;font-weight:600">
              Browse Sticker Packs
            </button>
          </div>
        `;
        return;
      }
      
      let html = '';
      _stickersById.clear();
      // Track which sticker items need shadow-DOM hosts mounted after
      // the grid HTML is injected (so we can animate stickers in-place).
      const _toHydrate = [];
      for (const pack of _stickerPacks) {
        const packRes = await apiFetch(`/api/media/stickers/packs/${pack.id}`);
        if (packRes.ok) {
          const packData = await packRes.json();
          if (packData.stickers && packData.stickers.length > 0) {
            html += `<div class="sticker-pack-header">${UI.escHtml(pack.name)}</div>`;
            html += packData.stickers.map(s => {
              _stickersById.set(String(s.id), {
                image_data: s.image_data,
                name: s.name,
                effects: s.effects || null,
              });
              const hasFx = s.effects && window.StickerFX && !StickerFX.isDefault(s.effects);
              if (hasFx) _toHydrate.push(String(s.id));
              return `
              <div class="sticker-item" data-sticker-id="${UI.escHtml(String(s.id))}" title="${UI.escHtml(s.name)}">
                <div class="sticker-host" data-sticker-id="${UI.escHtml(String(s.id))}">
                  ${hasFx ? '' : `<img src="${UI.escHtml(s.image_data)}" alt="${UI.escHtml(s.name)}" loading="lazy">`}
                </div>
              </div>`;
            }).join('');
          }
        }
      }
      
      grid.innerHTML = html || '<div class="gif-empty">No stickers in your packs</div>';
      // Hydrate animated sticker hosts into the grid. Each host is its
      // own closed shadow-root sandbox so the per-sticker CSS can never
      // bleed into the picker UI.
      if (window.StickerFX) {
        for (const sid of _toHydrate) {
          const rec = _stickersById.get(sid);
          const slot = grid.querySelector(`.sticker-host[data-sticker-id="${CSS.escape(sid)}"]`);
          if (!rec || !slot) continue;
          StickerFX.renderInto(slot, {
            src: rec.image_data,
            effects: rec.effects,
            alt: rec.name,
            size: 96,
          });
        }
      }
      if (!_stickerGridDelegated) {
        grid.addEventListener('click', e => {
          const item = e.target.closest('.sticker-item[data-sticker-id]');
          if (!item) return;
          const rec = _stickersById.get(String(item.dataset.stickerId || ''));
          if (rec && rec.image_data) sendSticker(rec.image_data, rec.effects);
        });
        _stickerGridDelegated = true;
      }
    } catch (e) {
      grid.innerHTML = '<div class="gif-empty">Failed to load stickers</div>';
    }
  }

  function filterStickers(query) {
    // Simple local filter based on loaded packs
    const grid = document.getElementById('gif-grid');
    const items = grid.querySelectorAll('.sticker-item');
    const lowerQuery = query.toLowerCase();
    
    items.forEach(item => {
      const name = item.title.toLowerCase();
      item.style.display = name.includes(lowerQuery) ? '' : 'none';
    });
  }

  async function showPublicPacks() {
    const grid = document.getElementById('gif-grid');
    grid.innerHTML = '<div class="gif-loading">Loading public packs...</div>';

    try {
      const res = await apiFetch('/api/media/stickers/public');
      if (!res.ok) throw new Error('API error');
      const data = await res.json();

      if (!data.packs || data.packs.length === 0) {
        grid.innerHTML = '<div class="gif-empty">No public sticker packs yet<div class="gif-empty-hint">Create one and toggle 🌍 to share with everyone.</div></div>';
        return;
      }

      // Figure out which packs are already installed/owned so the button
      // can show "Installed" instead of letting the user double-install.
      let installedIds = new Set();
      try {
        const myRes = await apiFetch('/api/media/stickers/packs');
        if (myRes.ok) {
          const my = await myRes.json();
          [...(my.own_packs || []), ...(my.installed_packs || [])]
            .forEach(p => installedIds.add(p.id));
        }
      } catch {}

      // Render each pack as a card with a small thumbnail strip showing
      // up to 5 stickers from the pack. Fetched lazily after the cards
      // appear so the list itself renders instantly.
      grid.innerHTML = data.packs.map(pack => {
        const installed = installedIds.has(pack.id);
        const btnHtml = installed
          ? `<button disabled style="background:color-mix(in srgb, var(--accent-color) 14%, transparent);border:1px solid var(--border-color);color:var(--text-muted);padding:6px 12px;border-radius:6px;font-size:12px;cursor:default">Installed</button>`
          : `<button onclick="GIFs.installPack(${pack.id})" style="background:var(--accent-color);border:none;color:color-mix(in srgb, var(--accent-color) 12%, #000);padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">Install</button>`;
        return `
        <div class="sp-card" data-pack-id="${pack.id}" style="grid-column:1/-1;background:color-mix(in srgb, var(--bg-color) 60%, transparent);border:1px solid var(--border-color);padding:10px 12px;border-radius:10px;margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <div style="min-width:0;flex:1">
              <div style="font-weight:600;color:var(--text-color);font-size:13px">${UI.escHtml(pack.name)}</div>
              <div style="font-size:11px;color:var(--text-muted)">${pack.sticker_count || 0} stickers · by ${UI.escHtml(pack.owner_name)}</div>
            </div>
            ${btnHtml}
          </div>
          <div class="sp-thumbs" data-pack-id="${pack.id}" style="display:flex;gap:4px;margin-top:8px;min-height:44px;align-items:center"></div>
        </div>`;
      }).join('');

      // Lazy-load thumbnails for each card. We grab up to 5 stickers from
      // each pack so users can actually see what they're installing.
      for (const pack of data.packs) {
        const cont = grid.querySelector(`.sp-thumbs[data-pack-id="${pack.id}"]`);
        if (!cont) continue;
        if (!pack.sticker_count) {
          cont.innerHTML = '<div style="font-size:11px;color:var(--text-muted);opacity:.7">No stickers yet</div>';
          continue;
        }
        try {
          const r = await apiFetch(`/api/media/stickers/packs/${pack.id}`);
          if (!r.ok) continue;
          const d = await r.json();
          const stickers = (d.stickers || []).slice(0, 5);
          cont.innerHTML = stickers.map(s => `
            <div title="${UI.escHtml(s.name)}" style="width:42px;height:42px;border-radius:8px;overflow:hidden;background:color-mix(in srgb, var(--surface-color) 70%, transparent);border:1px solid var(--border-color);display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <img src="${UI.escHtml(s.image_data)}" alt="" loading="lazy" style="max-width:100%;max-height:100%;object-fit:contain">
            </div>`).join('') + (
              pack.sticker_count > 5
                ? `<div style="font-size:11px;color:var(--text-muted);margin-left:4px">+${pack.sticker_count - 5}</div>`
                : ''
            );
        } catch {}
      }
    } catch (e) {
      grid.innerHTML = '<div class="gif-empty">Failed to load public packs</div>';
    }
  }

  async function installPack(packId) {
    try {
      const res = await apiFetch(`/api/media/stickers/packs/${packId}/install`, 'POST');
      if (res.ok) {
        UI.showToast('Sticker pack installed!', 'success');
        loadStickerPacks();
      } else {
        const data = await res.json();
        UI.showToast(data.error || 'Failed to install', 'error');
      }
    } catch (e) {
      UI.showToast('Failed to install pack', 'error');
    }
  }

  async function send(gifUrl) {
    close();
    if (!gifUrl) return;
    // Fetch the GIF so we can upload it like any other attachment — this
    // lets the user type a caption alongside it and renders inline in the
    // chat regardless of the recipient's link-preview settings (and keeps
    // the GIF visible if Tenor/GIPHY later 404s the URL).
    const input = document.getElementById('msg-input');
    // Keep a long "Loading GIF…" toast up until the fetch completes — large
    // GIFs can easily take longer than the default 3 s toast window.
    let loadingToast = null;
    try {
      loadingToast = UI.showToast && UI.showToast('Loading GIF…', 'info', 60000);
      const resp = await fetch(gifUrl, { mode: 'cors', credentials: 'omit' });
      if (!resp.ok) throw new Error('fetch ' + resp.status);
      const blob = await resp.blob();
      // Cap at 20 MB — the composer enforces the same limit.
      if (blob.size > 20 * 1024 * 1024) {
        try { loadingToast?.dismiss?.(); } catch {}
        UI.showToast && UI.showToast('GIF too large, sending as link', 'info');
        return _sendAsLink(gifUrl);
      }
      // Tenor sometimes returns image/gif, sometimes video/mp4 — preserve it.
      const type = blob.type || (gifUrl.endsWith('.mp4') ? 'video/mp4' : 'image/gif');
      const ext  = type.includes('mp4') ? 'mp4' : 'gif';
      const name = 'gif-' + Date.now() + '.' + ext;
      const attachBlob = blob.type ? blob : new Blob([blob], { type });
      window._pendingAttachment = { blob: attachBlob, name, type };
      if (typeof _renderAttachmentPreview === 'function') {
        _renderAttachmentPreview({ blob: attachBlob, name, type, sizeBytes: attachBlob.size });
      }
      try { loadingToast?.dismiss?.(); } catch {}
      if (input) input.focus();
    } catch (e) {
      try { loadingToast?.dismiss?.(); } catch {}
      console.warn('[GIF] fetch failed, falling back to link', e);
      _sendAsLink(gifUrl);
    }
  }

  // Fallback path — when CORS or size blocks the blob upload, drop the URL
  // into the composer so the user can still caption + send it.
  function _sendAsLink(gifUrl) {
    const input = document.getElementById('msg-input');
    if (!input) return;
    const existing = input.value.trim();
    input.value = existing ? `${existing} ${gifUrl}` : gifUrl;
    input.focus();
  }

  function sendSticker(imageData, effects) {
    // Sticker effects ride along inside `media_type` as a `;fx=base64url`
    // suffix. The server passes media_type through untouched, recipients
    // detect the suffix and render the sticker inside a Shadow-DOM-isolated
    // host. If StickerFX is missing (extremely old client) we fall back to
    // a plain image — no breakage, just no animation.
    let mediaType = 'image/png';
    // Try to preserve the original MIME from the data URL so GIFs stay
    // animated even when the user hasn't added any effects.
    try {
      const m = (imageData || '').match(/^data:([^;]+);/);
      if (m && m[1]) mediaType = m[1].toLowerCase();
    } catch {}
    if (effects && window.StickerFX && !StickerFX.isDefault(effects)) {
      mediaType = StickerFX.encodeForMediaType(mediaType, effects);
    }
    State.pendingAttachment = {
      data: imageData,
      type: mediaType,
      isSticker: true,
    };

    // Auto-send stickers
    sendMessage();
    close();
  }

  // ─── Sticker pack manager ────────────────────────────────────────────
  async function openManager() {
    let modal = document.getElementById('sticker-manager-modal');
    if (modal) { modal.style.display = 'flex'; await renderManager(); return; }
    modal = document.createElement('div');
    modal.id = 'sticker-manager-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML = `
      <div style="background:linear-gradient(180deg,
        color-mix(in srgb, var(--accent-color) 18%, var(--surface-color)) 0%,
        var(--surface-color) 55%,
        color-mix(in srgb, var(--bg-color) 70%, var(--surface-color)) 100%);
        border:1px solid color-mix(in srgb, var(--accent-color) 35%, var(--border-color));
        border-radius:14px;width:520px;max-width:100%;max-height:90vh;display:flex;flex-direction:column;
        box-shadow:0 18px 48px rgba(0,0,0,.6), 0 0 0 1px color-mix(in srgb, var(--accent-color) 15%, transparent);
        color:var(--text-color)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--border-color)">
          <div style="font-weight:700;color:var(--text-color);font-size:15px">🎨 Manage Sticker Packs</div>
          <button onclick="GIFs.closeManager()" style="background:none;border:none;color:var(--text-muted);font-size:18px;cursor:pointer;width:28px;height:28px;border-radius:6px">✕</button>
        </div>
        <div id="sm-body" style="flex:1;overflow-y:auto;padding:14px 16px;color:var(--text-color);scrollbar-width:thin;scrollbar-color:color-mix(in srgb, var(--accent-color) 40%, transparent) transparent"></div>
        <div style="padding:12px 16px;border-top:1px solid var(--border-color);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
          <button onclick="GIFs.browseFromManager()" style="background:color-mix(in srgb, var(--bg-color) 60%, transparent);border:1px solid var(--border-color);color:var(--text-color);padding:8px 14px;border-radius:8px;cursor:pointer">🌍 Browse Public</button>
          <button onclick="GIFs.closeManager()" style="background:color-mix(in srgb, var(--bg-color) 60%, transparent);border:1px solid var(--border-color);color:var(--text-color);padding:8px 14px;border-radius:8px;cursor:pointer">Close</button>
          <button onclick="GIFs.showCreatePack()" style="background:var(--accent-color);border:1px solid var(--accent-color);color:color-mix(in srgb, var(--accent-color) 12%, #000);padding:8px 14px;border-radius:8px;cursor:pointer;font-weight:700">+ New Pack</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeManager(); });
    await renderManager();
  }

  function closeManager() {
    const m = document.getElementById('sticker-manager-modal');
    if (m) m.style.display = 'none';
    loadStickerPacks();
  }

  // Lightweight tab UI update without kicking off any data fetch — used
  // by entry points (e.g. browseFromManager) that want to control which
  // payload lands in #gif-grid themselves. Calling switchTab() here
  // would race loadStickerPacks() against the caller's intended load.
  function _setActiveTabUI(tab) {
    _currentTab = tab;
    document.querySelectorAll('.gif-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    const searchInput  = document.getElementById('gif-search');
    const categoriesEl = document.getElementById('gif-categories');
    const manageBtn    = document.getElementById('gif-manage-btn');
    if (searchInput)  searchInput.placeholder = tab === 'gifs' ? 'Search GIFs...' : 'Search stickers...';
    if (categoriesEl) categoriesEl.style.display = tab === 'gifs' ? 'flex' : 'none';
    if (manageBtn)    manageBtn.style.display    = tab === 'gifs' ? 'none'  : '';
  }

  // Close the manager without re-triggering loadStickerPacks (used when
  // jumping directly into the public-pack browser so it doesn't race).
  function browseFromManager() {
    const m = document.getElementById('sticker-manager-modal');
    if (m) m.style.display = 'none';
    // Ensure the GIF picker is open so #gif-grid is actually visible.
    // The picker's outside-click handler may have closed it the moment
    // the user clicked anywhere inside the manager modal, so don't
    // trust the cached _isOpen flag — re-derive from the DOM and force
    // an open state if needed (without going through toggle(), which
    // would also race loadStickerPacks).
    try { createPicker(); } catch {}
    const picker = document.getElementById('gif-picker');
    if (picker && !picker.classList.contains('open')) {
      try { toggle(); } catch {}
    }
    // Force-update the tab UI to "stickers" WITHOUT kicking off
    // loadStickerPacks — otherwise that fetch races our showPublicPacks
    // call and the one that completes last wins. We've already
    // observed the user's own packs (or "no packs yet") overwriting
    // the public-pack list in production.
    _setActiveTabUI('stickers');
    showPublicPacks();
  }

  async function renderManager() {
    const body = document.getElementById('sm-body');
    if (!body) return;
    body.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Loading…</div>';
    try {
      const res = await apiFetch('/api/media/stickers/packs');
      if (!res.ok) throw 0;
      const data = await res.json();
      const own = data.own_packs || [];
      const installed = data.installed_packs || [];
      let html = '';
      if (own.length) {
        html += '<div style="font-size:11px;color:var(--accent-color);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:700">Your Packs</div>';
        for (const p of own) {
          html += `
            <div style="background:color-mix(in srgb, var(--bg-color) 60%, transparent);border:1px solid color-mix(in srgb, var(--accent-color) 25%, var(--border-color));border-radius:10px;padding:10px 12px;margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <div style="min-width:0;flex:1">
                  <div style="font-weight:700;color:var(--text-color)">${UI.escHtml(p.name)}</div>
                  <div style="font-size:11px;color:var(--text-muted)">${p.is_public ? '🌍 Public' : '🔒 Private'}${p.description ? ' · ' + UI.escHtml(p.description) : ''}</div>
                </div>
                <div style="display:flex;gap:4px;flex-shrink:0">
                  <button onclick="GIFs.editPack(${p.id})" title="Rename" style="background:color-mix(in srgb, var(--accent-color) 14%, transparent);border:1px solid var(--border-color);color:var(--text-color);padding:5px 9px;border-radius:6px;cursor:pointer;font-size:12px">✎</button>
                  <button onclick="GIFs.togglePublic(${p.id}, ${p.is_public ? 0 : 1})" title="${p.is_public ? 'Make private' : 'Publish'}" style="background:color-mix(in srgb, var(--accent-color) 14%, transparent);border:1px solid var(--border-color);color:var(--text-color);padding:5px 9px;border-radius:6px;cursor:pointer;font-size:12px">${p.is_public ? '🔒' : '🌍'}</button>
                  <button onclick="GIFs.deletePack(${p.id})" title="Delete pack" style="background:rgba(180,40,40,.18);border:1px solid #6b2a2a;color:#f0a0a0;padding:5px 9px;border-radius:6px;cursor:pointer;font-size:12px">🗑</button>
                </div>
              </div>
              <div id="sm-stickers-${p.id}" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid color-mix(in srgb, var(--accent-color) 18%, transparent)"></div>
              <div style="margin-top:8px"><button onclick="GIFs.uploadStickerTo(${p.id})" style="background:color-mix(in srgb, var(--accent-color) 10%, transparent);border:1px dashed var(--accent-color);color:var(--accent-color);padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;width:100%">+ Add sticker (PNG/WebP/GIF, ≤500KB)</button></div>
            </div>`;
        }
      }
      if (installed.length) {
        html += '<div style="font-size:11px;color:var(--accent-color);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 6px;font-weight:700">Installed</div>';
        for (const p of installed) {
          html += `
            <div style="background:color-mix(in srgb, var(--bg-color) 60%, transparent);border:1px solid var(--border-color);border-radius:10px;padding:10px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">
              <div><div style="font-weight:600;color:var(--text-color)">${UI.escHtml(p.name)}</div><div style="font-size:11px;color:var(--text-muted)">by ${UI.escHtml(p.owner_name || '?')}</div></div>
              <button onclick="GIFs.uninstallPack(${p.id})" style="background:rgba(180,40,40,.18);border:1px solid #6b2a2a;color:#f0a0a0;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px">Uninstall</button>
            </div>`;
        }
      }
      if (!own.length && !installed.length) {
        html += '<div style="text-align:center;padding:24px;color:var(--text-muted)">No packs yet — create one with the + button below, or browse public packs.</div>';
      }
      body.innerHTML = html;
      // load own pack stickers
      for (const p of own) {
        try {
          const r = await apiFetch(`/api/media/stickers/packs/${p.id}`);
          if (!r.ok) continue;
          const d = await r.json();
          const cont = document.getElementById(`sm-stickers-${p.id}`);
          if (!cont) continue;
          if (!d.stickers || !d.stickers.length) {
            cont.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">No stickers yet</div>';
            continue;
          }
          cont.innerHTML = d.stickers.map(s => {
            const safeName = UI.escHtml(s.name || '');
            const hasFx = !!(s.effects && window.StickerFX && !StickerFX.isDefault(s.effects));
            const fxBadge = hasFx
              ? '<div style="position:absolute;bottom:2px;left:2px;background:var(--accent-color);color:color-mix(in srgb, var(--accent-color) 12%, #000);font-size:9px;font-weight:700;padding:1px 5px;border-radius:6px;line-height:1.2;pointer-events:none">FX</div>'
              : '';
            return `
            <div class="sm-sticker-tile" data-sticker-id="${s.id}" style="position:relative;width:64px;height:64px;background:color-mix(in srgb, var(--surface-color) 70%, transparent);border-radius:10px;overflow:hidden;border:1px solid var(--border-color)" title="${safeName}">
              <div class="sm-sticker-host" data-sticker-id="${s.id}" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center">
                ${hasFx ? '' : `<img src="${s.image_data}" style="width:100%;height:100%;object-fit:contain" alt="">`}
              </div>
              ${fxBadge}
              <button onclick="GIFs.editStickerFx(${s.id})" title="Edit effects" style="position:absolute;top:2px;left:2px;background:rgba(0,0,0,.55);border:none;color:var(--accent-color);width:20px;height:20px;border-radius:50%;cursor:pointer;font-size:11px;line-height:1;padding:0">✨</button>
              <button onclick="GIFs.deleteSticker(${s.id})" title="Delete sticker" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,.7);border:none;color:#f0a0a0;width:20px;height:20px;border-radius:50%;cursor:pointer;font-size:11px;line-height:1;padding:0">×</button>
            </div>`;
          }).join('');
          // Hydrate animated stickers in the manager.
          if (window.StickerFX) {
            for (const s of d.stickers) {
              if (!s.effects || StickerFX.isDefault(s.effects)) continue;
              const slot = cont.querySelector(`.sm-sticker-host[data-sticker-id="${s.id}"]`);
              if (!slot) continue;
              StickerFX.renderInto(slot, {
                src: s.image_data,
                effects: s.effects,
                alt: s.name,
                size: 64,
              });
            }
          }
          // Cache stickers so the editor can read effects/image_data without
          // an extra round-trip.
          _smStickerCache = _smStickerCache || {};
          for (const s of d.stickers) _smStickerCache[s.id] = s;
        } catch {}
      }
    } catch (e) {
      body.innerHTML = '<div style="color:#f0a0a0;padding:20px;text-align:center">Failed to load packs</div>';
    }
  }

  async function showCreatePack() {
    const name = await _smPrompt('New Sticker Pack', '', { placeholder: 'Pack name (2-32 chars)' });
    if (!name || !name.trim()) return;
    const desc = await _smPrompt('Pack Description', '', { placeholder: 'Optional short description', multiline: true });
    try {
      const r = await apiFetch('/api/media/stickers/packs', 'POST', { name: name.trim(), description: (desc || '').trim() });
      const d = await r.json();
      if (!r.ok || d.error) UI.showToast(d.error || 'Failed to create pack', 'error');
      else { UI.showToast('Pack created', 'success'); renderManager(); }
    } catch { UI.showToast('Failed to create pack', 'error'); }
  }

  async function editPack(packId) {
    const current = (_stickerPacks.find(p => p.id === packId) || {}).name || '';
    const newName = await _smPrompt('Rename Pack', current, { placeholder: 'New name (2-32 chars)' });
    if (!newName || !newName.trim()) return;
    const r = await apiFetch(`/api/media/stickers/packs/${packId}`, 'PATCH', { name: newName.trim() });
    if (r.ok) { UI.showToast('Renamed', 'success'); renderManager(); }
    else { const d = await r.json(); UI.showToast(d.error || 'Rename failed', 'error'); }
  }

  async function togglePublic(packId, makePublic) {
    const r = await apiFetch(`/api/media/stickers/packs/${packId}`, 'PATCH', { is_public: !!makePublic });
    if (r.ok) { UI.showToast(makePublic ? 'Pack is now public' : 'Pack is now private', 'success'); renderManager(); }
    else UI.showToast('Update failed', 'error');
  }

  async function deletePack(packId) {
    const ok = await _smConfirm('Delete Pack?', 'This will permanently delete the pack and all its stickers. This cannot be undone.', { okLabel: 'Delete' });
    if (!ok) return;
    const r = await apiFetch(`/api/media/stickers/packs/${packId}`, 'DELETE');
    if (r.ok) { UI.showToast('Pack deleted', 'success'); renderManager(); }
    else UI.showToast('Delete failed', 'error');
  }

  async function uninstallPack(packId) {
    const r = await apiFetch(`/api/media/stickers/packs/${packId}/uninstall`, 'DELETE');
    if (r.ok) { UI.showToast('Uninstalled', 'success'); renderManager(); }
    else UI.showToast('Uninstall failed', 'error');
  }

  async function deleteSticker(stickerId) {
    const ok = await _smConfirm('Delete Sticker?', 'Remove this sticker from the pack?', { okLabel: 'Delete' });
    if (!ok) return;
    const r = await apiFetch(`/api/media/stickers/${stickerId}`, 'DELETE');
    if (r.ok) { UI.showToast('Deleted', 'success'); renderManager(); }
    else UI.showToast('Delete failed', 'error');
  }

  // ─── Sticker effects editor ──────────────────────────────────────────
  // Opens a polished modal where the user can dial in filter / transform /
  // animation effects on a sticker. The live preview is rendered through
  // StickerFX.buildHost (shadow-DOM isolated) so what they see is exactly
  // what gets sent to chat. "Save" persists the effects object via PATCH
  // /api/media/stickers/{id} — we NEVER send raw CSS, only the dict the
  // server re-clamps against its whitelist.
  async function editStickerFx(stickerId) {
    if (!window.StickerFX) {
      UI.showToast('Sticker FX engine unavailable', 'error');
      return;
    }
    let sticker = _smStickerCache[stickerId];
    if (!sticker) {
      // Not in cache yet — fetch the pack list & locate it.
      try {
        const r = await apiFetch('/api/media/stickers/packs');
        if (r.ok) {
          const d = await r.json();
          for (const p of [...(d.own_packs || []), ...(d.installed_packs || [])]) {
            const r2 = await apiFetch(`/api/media/stickers/packs/${p.id}`);
            if (!r2.ok) continue;
            const d2 = await r2.json();
            for (const s of (d2.stickers || [])) {
              _smStickerCache[s.id] = s;
              if (s.id === stickerId) sticker = s;
            }
            if (sticker) break;
          }
        }
      } catch {}
    }
    if (!sticker) { UI.showToast('Sticker not found', 'error'); return; }
    _openFxEditor(sticker);
  }

  function _openFxEditor(sticker) {
    let fx = StickerFX.normalize(sticker.effects) || StickerFX.defaults();
    const close = () => { const m = document.getElementById('sticker-fx-modal'); if (m) m.remove(); };

    const modal = document.createElement('div');
    modal.id = 'sticker-fx-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:2100;display:flex;align-items:center;justify-content:center;padding:16px';
    modal.innerHTML = `
      <div role="dialog" aria-modal="true" style="
        background:linear-gradient(180deg,
          color-mix(in srgb, var(--accent-color) 18%, var(--surface-color)) 0%,
          var(--surface-color) 60%,
          color-mix(in srgb, var(--bg-color) 70%, var(--surface-color)) 100%);
        border:1px solid color-mix(in srgb, var(--accent-color) 40%, var(--border-color));
        box-shadow:0 24px 60px rgba(0,0,0,.65), 0 0 0 1px color-mix(in srgb, var(--accent-color) 15%, transparent);
        border-radius:16px;width:760px;max-width:100%;max-height:92vh;display:flex;flex-direction:column;color:var(--text-color)">

        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--border-color)">
          <div style="font-weight:700;font-size:15px">✨ Sticker Effects — <span style="color:var(--accent-color)">${UI.escHtml(sticker.name || '')}</span></div>
          <button id="fx-close" style="background:none;border:none;color:var(--text-muted);font-size:18px;cursor:pointer;width:28px;height:28px;border-radius:6px">✕</button>
        </div>

        <div style="flex:1;overflow:auto;display:grid;grid-template-columns: minmax(220px, 1fr) minmax(280px, 1.6fr);gap:14px;padding:14px 18px">

          <!-- Live preview ─ rendered through StickerFX (Shadow-DOM isolated) -->
          <div>
            <div style="font-size:11px;color:var(--accent-color);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:700">Preview</div>
            <div style="background:
              repeating-conic-gradient(color-mix(in srgb, var(--bg-color) 75%, transparent) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
              border:1px solid var(--border-color);
              border-radius:12px;
              padding:16px;
              display:flex;align-items:center;justify-content:center;
              min-height:220px;
              overflow:hidden;">
              <div id="fx-preview" style="display:inline-flex"></div>
            </div>
            <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
              <button data-fx-preset="none"    class="fx-preset-btn">Plain</button>
              <button data-fx-preset="spin"    class="fx-preset-btn">🌀 Spin</button>
              <button data-fx-preset="pulse"   class="fx-preset-btn">💓 Pulse</button>
              <button data-fx-preset="bounce"  class="fx-preset-btn">⤴ Bounce</button>
              <button data-fx-preset="shake"   class="fx-preset-btn">📳 Shake</button>
              <button data-fx-preset="wobble"  class="fx-preset-btn">🌊 Wobble</button>
              <button data-fx-preset="float"   class="fx-preset-btn">🎈 Float</button>
              <button data-fx-preset="glow"    class="fx-preset-btn">🔆 Glow</button>
              <button data-fx-preset="rainbow" class="fx-preset-btn">🌈 Rainbow</button>
              <button data-fx-preset="flip"    class="fx-preset-btn">🔄 Flip</button>
              <button data-fx-preset="swing"   class="fx-preset-btn">🪀 Swing</button>
            </div>
          </div>

          <!-- Controls -->
          <div id="fx-controls" style="display:flex;flex-direction:column;gap:14px;min-width:0"></div>

        </div>

        <div style="padding:12px 18px;border-top:1px solid var(--border-color);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
          <button id="fx-reset" style="background:color-mix(in srgb, var(--bg-color) 60%, transparent);border:1px solid var(--border-color);color:var(--text-color);padding:8px 14px;border-radius:8px;cursor:pointer">Reset</button>
          <button id="fx-clear" style="background:rgba(180,40,40,.18);border:1px solid #6b2a2a;color:#f0a0a0;padding:8px 14px;border-radius:8px;cursor:pointer">Clear effects</button>
          <button id="fx-cancel" style="background:color-mix(in srgb, var(--bg-color) 60%, transparent);border:1px solid var(--border-color);color:var(--text-color);padding:8px 14px;border-radius:8px;cursor:pointer">Cancel</button>
          <button id="fx-save" style="background:var(--accent-color);border:1px solid var(--accent-color);color:color-mix(in srgb, var(--accent-color) 12%, #000);padding:8px 14px;border-radius:8px;cursor:pointer;font-weight:700">Save</button>
        </div>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.getElementById('fx-close').onclick = close;
    document.getElementById('fx-cancel').onclick = close;
    document.getElementById('fx-reset').onclick = () => {
      fx = StickerFX.defaults();
      renderControls();
      renderPreview();
    };
    document.getElementById('fx-clear').onclick = async () => {
      // Persist empty effects ({}) to clear server-side.
      const r = await apiFetch(`/api/media/stickers/${sticker.id}`, 'PATCH', { effects: {} });
      if (r.ok) {
        UI.showToast('Effects cleared', 'success');
        sticker.effects = null;
        _smStickerCache[sticker.id] = sticker;
        close();
        renderManager();
      } else {
        UI.showToast('Failed to clear', 'error');
      }
    };
    document.getElementById('fx-save').onclick = async () => {
      const r = await apiFetch(`/api/media/stickers/${sticker.id}`, 'PATCH', { effects: fx });
      if (r.ok) {
        UI.showToast('Effects saved', 'success');
        sticker.effects = fx;
        _smStickerCache[sticker.id] = sticker;
        close();
        renderManager();
      } else {
        const d = await r.json().catch(() => ({}));
        UI.showToast(d.error || 'Save failed', 'error');
      }
    };

    // Preset buttons set animation only (leave filters as-is).
    modal.querySelectorAll('.fx-preset-btn').forEach(btn => {
      btn.style.cssText = 'background:color-mix(in srgb, var(--accent-color) 10%, transparent);border:1px solid var(--border-color);color:var(--text-color);padding:5px 9px;border-radius:6px;cursor:pointer;font-size:11px';
      btn.onclick = () => {
        fx.animation = btn.dataset.fxPreset;
        renderControls();
        renderPreview();
      };
    });

    // ── Controls — sliders built from StickerFX.*_RANGES whitelist ───
    function renderControls() {
      const ctr = document.getElementById('fx-controls');
      if (!ctr) return;
      const FR = StickerFX.FILTER_RANGES;
      const TR = StickerFX.TRANSFORM_RANGES;
      const SR = StickerFX.SHADOW_RANGES;

      const sliderHtml = (label, group, key, min, max, step, value, suffix) => `
        <label style="display:grid;grid-template-columns:90px 1fr 56px;align-items:center;gap:8px;font-size:12px">
          <span style="color:var(--text-muted)">${label}</span>
          <input type="range" min="${min}" max="${max}" step="${step}" value="${value}"
                 data-fx-group="${group}" data-fx-key="${key}"
                 style="width:100%;accent-color:var(--accent-color)">
          <span class="fx-num" data-fx-show="${group}.${key}" style="text-align:right;font-variant-numeric:tabular-nums;color:var(--text-color)">${value}${suffix || ''}</span>
        </label>`;

      ctr.innerHTML = `
        <details open style="border:1px solid color-mix(in srgb, var(--accent-color) 22%, var(--border-color));border-radius:10px;padding:10px 12px;background:color-mix(in srgb, var(--bg-color) 55%, transparent)">
          <summary style="cursor:pointer;font-weight:700;color:var(--accent-color);font-size:12px;text-transform:uppercase;letter-spacing:.4px">Filters</summary>
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
            ${sliderHtml('Blur',       'filter', 'blur',       FR.blur[0],       FR.blur[1],       0.1, fx.filter.blur,       'px')}
            ${sliderHtml('Brightness', 'filter', 'brightness', FR.brightness[0], FR.brightness[1], 0.05, fx.filter.brightness, '×')}
            ${sliderHtml('Contrast',   'filter', 'contrast',   FR.contrast[0],   FR.contrast[1],   0.05, fx.filter.contrast,   '×')}
            ${sliderHtml('Saturation', 'filter', 'saturate',   FR.saturate[0],   FR.saturate[1],   0.05, fx.filter.saturate,   '×')}
            ${sliderHtml('Grayscale',  'filter', 'grayscale',  FR.grayscale[0],  FR.grayscale[1],  0.05, fx.filter.grayscale,  '')}
            ${sliderHtml('Sepia',      'filter', 'sepia',      FR.sepia[0],      FR.sepia[1],      0.05, fx.filter.sepia,      '')}
            ${sliderHtml('Invert',     'filter', 'invert',     FR.invert[0],     FR.invert[1],     0.05, fx.filter.invert,     '')}
            ${sliderHtml('Hue',        'filter', 'hue',        FR.hue[0],        FR.hue[1],        1,    fx.filter.hue,        '°')}
          </div>
        </details>

        <details style="border:1px solid color-mix(in srgb, var(--accent-color) 22%, var(--border-color));border-radius:10px;padding:10px 12px;background:color-mix(in srgb, var(--bg-color) 55%, transparent)">
          <summary style="cursor:pointer;font-weight:700;color:var(--accent-color);font-size:12px;text-transform:uppercase;letter-spacing:.4px">Transform</summary>
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
            ${sliderHtml('Scale',  'transform', 'scale',  TR.scale[0],  TR.scale[1],  0.05, fx.transform.scale,  '×')}
            ${sliderHtml('Rotate', 'transform', 'rotate', TR.rotate[0], TR.rotate[1], 1,    fx.transform.rotate, '°')}
            ${sliderHtml('Skew X', 'transform', 'skewX',  TR.skewX[0],  TR.skewX[1],  1,    fx.transform.skewX,  '°')}
            ${sliderHtml('Skew Y', 'transform', 'skewY',  TR.skewY[0],  TR.skewY[1],  1,    fx.transform.skewY,  '°')}
          </div>
        </details>

        <details style="border:1px solid color-mix(in srgb, var(--accent-color) 22%, var(--border-color));border-radius:10px;padding:10px 12px;background:color-mix(in srgb, var(--bg-color) 55%, transparent)">
          <summary style="cursor:pointer;font-weight:700;color:var(--accent-color);font-size:12px;text-transform:uppercase;letter-spacing:.4px">Drop Shadow / Glow</summary>
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
            ${sliderHtml('Offset X', 'shadow', 'x',      SR.x[0],      SR.x[1],      1,    fx.shadow.x,      'px')}
            ${sliderHtml('Offset Y', 'shadow', 'y',      SR.y[0],      SR.y[1],      1,    fx.shadow.y,      'px')}
            ${sliderHtml('Blur',     'shadow', 'blur',   SR.blur[0],   SR.blur[1],   1,    fx.shadow.blur,   'px')}
            ${sliderHtml('Alpha',    'shadow', 'spread', SR.spread[0], SR.spread[1], 0.05, fx.shadow.spread, '')}
            <label style="display:grid;grid-template-columns:90px 1fr;align-items:center;gap:8px;font-size:12px">
              <span style="color:var(--text-muted)">Color</span>
              <input type="color" value="${fx.shadow.color}" data-fx-group="shadow" data-fx-key="color"
                style="width:60px;height:28px;border:1px solid var(--border-color);background:transparent;border-radius:6px;cursor:pointer">
            </label>
          </div>
        </details>

        <details style="border:1px solid color-mix(in srgb, var(--accent-color) 22%, var(--border-color));border-radius:10px;padding:10px 12px;background:color-mix(in srgb, var(--bg-color) 55%, transparent)">
          <summary style="cursor:pointer;font-weight:700;color:var(--accent-color);font-size:12px;text-transform:uppercase;letter-spacing:.4px">Animation</summary>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
            <label style="display:grid;grid-template-columns:90px 1fr;align-items:center;gap:8px;font-size:12px">
              <span style="color:var(--text-muted)">Style</span>
              <select data-fx-anim style="background:var(--surface-color);color:var(--text-color);border:1px solid var(--border-color);border-radius:6px;padding:5px 7px">
                ${StickerFX.ANIMATIONS.map(a => `<option value="${a}" ${a === fx.animation ? 'selected' : ''}>${a}</option>`).join('')}
              </select>
            </label>
            ${sliderHtml('Duration', '_root', 'animation_duration', 0.3, 10, 0.1, fx.animation_duration, 's')}
          </div>
        </details>

        <details style="border:1px solid color-mix(in srgb, var(--accent-color) 22%, var(--border-color));border-radius:10px;padding:10px 12px;background:color-mix(in srgb, var(--bg-color) 55%, transparent)">
          <summary style="cursor:pointer;font-weight:700;color:var(--accent-color);font-size:12px;text-transform:uppercase;letter-spacing:.4px">Background</summary>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
            <label style="display:grid;grid-template-columns:90px 1fr 56px;align-items:center;gap:8px;font-size:12px">
              <span style="color:var(--text-muted)">Color</span>
              <input type="color" value="${fx.background || '#000000'}" data-fx-bg-color
                style="width:100%;height:28px;border:1px solid var(--border-color);background:transparent;border-radius:6px;cursor:pointer">
              <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted)">
                <input type="checkbox" data-fx-bg-on ${fx.background ? 'checked' : ''}> on
              </label>
            </label>
            ${sliderHtml('Round', '_root', 'border_radius', 0, 50, 1, fx.border_radius, '%')}
          </div>
        </details>
      `;

      // Wire sliders / inputs.
      ctr.querySelectorAll('input[type="range"]').forEach(r => {
        r.addEventListener('input', e => {
          const group = e.target.dataset.fxGroup;
          const key = e.target.dataset.fxKey;
          const val = parseFloat(e.target.value);
          if (group === '_root') fx[key] = val;
          else if (fx[group]) fx[group][key] = val;
          // Update numeric readout.
          const show = ctr.querySelector(`.fx-num[data-fx-show="${group}.${key}"]`);
          if (show) {
            const suffix = (show.textContent.match(/[^\d.\-]+$/) || [''])[0];
            show.textContent = val + suffix;
          }
          renderPreview();
        });
      });
      ctr.querySelectorAll('input[type="color"][data-fx-group]').forEach(c => {
        c.addEventListener('input', e => {
          const g = e.target.dataset.fxGroup;
          const k = e.target.dataset.fxKey;
          if (fx[g]) fx[g][k] = e.target.value;
          renderPreview();
        });
      });
      const bgColor = ctr.querySelector('input[data-fx-bg-color]');
      const bgOn = ctr.querySelector('input[data-fx-bg-on]');
      if (bgColor) bgColor.addEventListener('input', e => {
        if (bgOn && bgOn.checked) { fx.background = e.target.value; renderPreview(); }
      });
      if (bgOn) bgOn.addEventListener('change', e => {
        fx.background = e.target.checked ? (bgColor && bgColor.value) || '#000000' : '';
        renderPreview();
      });
      const animSel = ctr.querySelector('select[data-fx-anim]');
      if (animSel) animSel.addEventListener('change', e => {
        fx.animation = e.target.value;
        renderPreview();
      });
    }

    function renderPreview() {
      const host = document.getElementById('fx-preview');
      if (!host) return;
      StickerFX.renderInto(host, {
        src: sticker.image_data,
        effects: fx,
        alt: sticker.name,
        size: 180,
      });
    }

    renderControls();
    renderPreview();
  }

  function uploadStickerTo(packId) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/webp,image/gif';
    inp.onchange = async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      if (file.size > 500 * 1024) { UI.showToast('Sticker too large (max 500KB)', 'error'); return; }
      const suggested = file.name.replace(/\.[^.]+$/, '');
      const raw = await _smPrompt('Sticker Name', suggested, { placeholder: 'Sticker name' });
      const name = (raw || '').trim();
      if (!name) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const r = await apiFetch('/api/media/stickers', 'POST', {
          pack_id: packId, name, image_data: reader.result, emoji: ''
        });
        if (r.ok) { UI.showToast('Sticker added', 'success'); renderManager(); }
        else { const d = await r.json(); UI.showToast(d.error || 'Upload failed', 'error'); }
      };
      reader.readAsDataURL(file);
    };
    inp.click();
  }

  return {
    toggle,
    close,
    switchTab,
    handleSearch,
    searchGifs,
    loadStickerPacks,
    showPublicPacks,
    installPack,
    send,
    sendSticker,
    scrollCats,
    openManager,
    closeManager,
    browseFromManager,
    showCreatePack,
    editPack,
    togglePublic,
    deletePack,
    uninstallPack,
    deleteSticker,
    editStickerFx,
    uploadStickerTo
  };
})();

// Add global toggle function for HTML onclick
function toggleGifPicker() {
  GIFs.toggle();
}
