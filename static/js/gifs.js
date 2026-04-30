/**
 * gifs.js — GIF search and sticker functionality
 */

const GIFs = (() => {
  let _isOpen = false;
  let _searchTimeout = null;
  let _currentTab = 'gifs';  // 'gifs' or 'stickers'
  let _stickerPacks = [];
  let _gifReqSeq = 0;
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
          <button class="gif-manage-btn" id="gif-manage-btn" onclick="GIFs.openManager()" title="Manage sticker packs" style="display:none;background:rgba(76,175,80,.14);border:1px solid #3a6b48;color:#cfe8d2;padding:5px 10px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600">⚙ Manage</button>
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
        background: linear-gradient(180deg,#1f3a2c 0%,#193024 55%,#13241b 100%);
        border: 1px solid #3a6b48;
        border-radius: 14px;
        display: none;
        flex-direction: column;
        z-index: 1000;
        box-shadow: 0 12px 32px rgba(0,0,0,.6), 0 0 0 1px rgba(76,175,80,.10), inset 0 1px 0 rgba(76,175,80,.06);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        overflow: hidden;
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
        border-bottom: 1px solid #2a5a3a;
      }
      .gif-tabs { display: flex; gap: 4px; background:rgba(0,0,0,.35); padding:3px; border-radius:8px; box-shadow: inset 0 0 0 1px rgba(76,175,80,.10); }
      .gif-tab {
        background: transparent;
        border: none;
        color: #9bbf9b;
        cursor: pointer;
        padding: 6px 14px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 600;
        transition: background .12s, color .12s;
      }
      .gif-tab:hover { color: #cfe8d2; }
      .gif-tab.active { background: linear-gradient(135deg,#1a3a1a 0%,#0d1f0d 100%); color: #7fd08a; box-shadow: inset 0 0 0 1px rgba(76,175,80,.25); }
      .gif-close {
        background: none;
        border: none;
        color: #9bbf9b;
        cursor: pointer;
        font-size: 18px;
        width: 28px; height: 28px;
        border-radius: 6px;
        transition: background .12s, color .12s;
      }
      .gif-close:hover { color: #cfe8d2; background: rgba(76,175,80,.12); }
      .gif-search-wrap { padding: 8px 12px; }
      .gif-search {
        width: 100%;
        background: rgba(0,0,0,.35);
        border: 1px solid #2a5a3a;
        border-radius: 8px;
        padding: 9px 12px;
        color: #d6ecda;
        font-size: 13px;
        outline: none;
        box-sizing: border-box;
        transition: border-color .12s, box-shadow .12s;
      }
      .gif-search:focus { border-color: #4caf50; box-shadow: 0 0 0 3px rgba(76,175,80,.18); }
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
      /* Desktop-only horizontal scroll arrows for the category row.
         Arrows are proper flex siblings (not overlays), so category pills
         never slide under them. Fades hint at more content. */
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
        background: rgba(0,0,0,.30);
        border: 1px solid #2a5a3a;
        color: #cfe8d2;
        font-size: 18px;
        font-weight: 700;
        line-height: 1;
        border-radius: 50%;
        cursor: pointer;
        transition: background .12s, transform .12s, border-color .12s, color .12s;
        padding: 0;
        margin-bottom: 6px; /* align with .gif-categories bottom padding */
        position: relative;
        z-index: 3;
      }
      .gif-cat-scroll:hover {
        background: linear-gradient(135deg,#1a3a1a 0%,#0d1f0d 100%); border-color: #4caf50; color: #7fd08a;
        transform: scale(1.08);
      }
      .gif-cat-scroll:active { transform: scale(.95); }
      .gif-cat-wrap.can-scroll-left  .gif-cat-scroll-l { display: flex; }
      .gif-cat-wrap.can-scroll-right .gif-cat-scroll-r { display: flex; }
      /* Soft fade on the scroll container edges so pills don't feel cut off.
         Sits INSIDE the scroll track between the arrows, never overlapping
         the arrow buttons themselves. */
      .gif-cat-wrap::after,
      .gif-cat-wrap::before {
        content:'';position:absolute;top:4px;bottom:10px;width:18px;pointer-events:none;z-index:1;
        opacity:0;transition:opacity .15s;
      }
      /* 8px wrap padding + 26px arrow + 2px gap = 36px from the edge */
      .gif-cat-wrap::after  { right:36px; background:linear-gradient(270deg,#15291f,transparent); }
      .gif-cat-wrap::before { left:36px;  background:linear-gradient(90deg,#15291f,transparent); }
      .gif-cat-wrap.can-scroll-right::after { opacity:1; }
      .gif-cat-wrap.can-scroll-left::before { opacity:1; }
      /* When arrows are hidden (no overflow on that side), the fade would
         otherwise sit awkwardly inset from the edge. Suppress it. */
      .gif-cat-wrap:not(.can-scroll-left)  .gif-cat-scroll-l { display: none; }
      .gif-cat-wrap:not(.can-scroll-right) .gif-cat-scroll-r { display: none; }
      @media (hover: none) {
        .gif-cat-scroll { display: none !important; }
        .gif-cat-wrap::after, .gif-cat-wrap::before { display: none; }
        .gif-cat-wrap { padding: 0; }
        .gif-categories { padding: 4px 12px 10px; }
      }
      .gif-category {
        background: rgba(0,0,0,.30);
        border: 1px solid #2a5a3a;
        color: #9bbf9b;
        cursor: pointer;
        padding: 5px 12px;
        border-radius: 14px;
        font-size: 12px;
        font-weight: 500;
        white-space: nowrap;
        flex-shrink: 0;
        transition: background .12s, color .12s, border-color .12s;
      }
      .gif-category:hover { background: rgba(76,175,80,.12); color: #cfe8d2; border-color: rgba(76,175,80,.35); }
      .gif-grid {
        flex: 1;
        overflow-y: auto;
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 6px;
        padding: 8px 12px 12px;
        scrollbar-width: thin;
        scrollbar-color: rgba(76,175,80,.4) transparent;
      }
      .gif-grid::-webkit-scrollbar { width: 6px; }
      .gif-grid::-webkit-scrollbar-thumb { background: rgba(76,175,80,.35); border-radius: 3px; }
      .gif-item {
        cursor: pointer;
        border-radius: 8px;
        overflow: hidden;
        background: rgba(0,0,0,.35);
        aspect-ratio: 1;
        transition: transform .12s, box-shadow .12s;
      }
      .gif-item:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,.5), 0 0 0 1px rgba(76,175,80,.25); }
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
      .sticker-item:hover { background: rgba(76,175,80,.12); transform: translateY(-1px); }
      .sticker-item img {
        width: 100%;
        height: auto;
        max-height: 100px;
        object-fit: contain;
      }
      .sticker-pack-header {
        grid-column: 1 / -1;
        padding: 8px 4px 4px;
        color: #7fd08a;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: .5px;
        border-bottom: 1px solid #2a5a3a;
      }
      .gif-loading {
        grid-column: 1 / -1;
        text-align: center;
        padding: 40px;
        color: #6fbf7e;
      }
      .gif-empty {
        grid-column: 1 / -1;
        text-align: center;
        padding: 40px;
        color: #6fbf7e;
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
      if (!res.ok) throw new Error('API error');
      const data = await res.json();
      if (reqSeq !== _gifReqSeq) return;
      _renderGifGrid(grid, data.gifs || data.results || [], 'No GIFs found');
    } catch (e) {
      if (reqSeq !== _gifReqSeq) return;
      if (e?.name === 'AbortError') return;
      grid.innerHTML = '<div class="gif-empty">Failed to load GIFs</div>';
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
            <button onclick="GIFs.showPublicPacks()" style="margin-top:12px;background:#4caf50;border:none;color:#000;padding:8px 16px;border-radius:8px;cursor:pointer">
              Browse Sticker Packs
            </button>
          </div>
        `;
        return;
      }
      
      let html = '';
      for (const pack of _stickerPacks) {
        const packRes = await apiFetch(`/api/media/stickers/packs/${pack.id}`);
        if (packRes.ok) {
          const packData = await packRes.json();
          if (packData.stickers && packData.stickers.length > 0) {
            html += `<div class="sticker-pack-header">${UI.escHtml(pack.name)}</div>`;
            html += packData.stickers.map(s => `
              <div class="sticker-item" onclick="GIFs.sendSticker('${s.image_data}')" title="${UI.escHtml(s.name)}">
                <img src="${s.image_data}" alt="${UI.escHtml(s.name)}" loading="lazy">
              </div>
            `).join('');
          }
        }
      }
      
      grid.innerHTML = html || '<div class="gif-empty">No stickers in your packs</div>';
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
        grid.innerHTML = '<div class="gif-empty">No public sticker packs yet</div>';
        return;
      }
      
      grid.innerHTML = data.packs.map(pack => `
        <div style="grid-column:1/-1;background:#0f0f0f;padding:12px;border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-weight:600;color:#e0e0e0">${UI.escHtml(pack.name)}</div>
            <div style="font-size:12px;color:#666">${pack.sticker_count || 0} stickers · by ${UI.escHtml(pack.owner_name)}</div>
          </div>
          <button onclick="GIFs.installPack(${pack.id})" style="background:#4caf50;border:none;color:#000;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px">
            Install
          </button>
        </div>
      `).join('');
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

  function sendSticker(imageData) {
    // Send sticker directly
    State.pendingAttachment = {
      data: imageData,
      type: 'image/png',
      isSticker: true
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
      <div style="background:linear-gradient(180deg,#1f3a2c 0%,#13241b 100%);border:1px solid #3a6b48;border-radius:14px;width:520px;max-width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 18px 48px rgba(0,0,0,.6),0 0 0 1px rgba(76,175,80,.15)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #3a6b48">
          <div style="font-weight:700;color:#cfe8d2;font-size:15px">🎨 Manage Sticker Packs</div>
          <button onclick="GIFs.closeManager()" style="background:none;border:none;color:#9bbf9b;font-size:18px;cursor:pointer;width:28px;height:28px;border-radius:6px">✕</button>
        </div>
        <div id="sm-body" style="flex:1;overflow-y:auto;padding:14px 16px;color:#d6ecda;scrollbar-width:thin;scrollbar-color:rgba(76,175,80,.4) transparent"></div>
        <div style="padding:12px 16px;border-top:1px solid #3a6b48;display:flex;gap:8px;justify-content:flex-end">
          <button onclick="GIFs.closeManager()" style="background:rgba(0,0,0,.35);border:1px solid #3a6b48;color:#cfe8d2;padding:8px 14px;border-radius:8px;cursor:pointer">Close</button>
          <button onclick="GIFs.showCreatePack()" style="background:linear-gradient(135deg,#2a5a2a 0%,#1a3a1a 100%);border:1px solid #4caf50;color:#fff;padding:8px 14px;border-radius:8px;cursor:pointer;font-weight:600">+ New Pack</button>
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

  async function renderManager() {
    const body = document.getElementById('sm-body');
    if (!body) return;
    body.innerHTML = '<div style="text-align:center;padding:20px;color:#6fbf7e">Loading…</div>';
    try {
      const res = await apiFetch('/api/media/stickers/packs');
      if (!res.ok) throw 0;
      const data = await res.json();
      const own = data.own_packs || [];
      const installed = data.installed_packs || [];
      let html = '';
      if (own.length) {
        html += '<div style="font-size:11px;color:#7fd08a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:700">Your Packs</div>';
        for (const p of own) {
          html += `
            <div style="background:rgba(0,0,0,.30);border:1px solid #3a6b48;border-radius:10px;padding:10px 12px;margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <div style="min-width:0;flex:1">
                  <div style="font-weight:700;color:#fff">${UI.escHtml(p.name)}</div>
                  <div style="font-size:11px;color:#9bbf9b">${p.is_public ? '🌍 Public' : '🔒 Private'}${p.description ? ' · ' + UI.escHtml(p.description) : ''}</div>
                </div>
                <div style="display:flex;gap:4px;flex-shrink:0">
                  <button onclick="GIFs.editPack(${p.id})" style="background:rgba(76,175,80,.14);border:1px solid #3a6b48;color:#cfe8d2;padding:5px 9px;border-radius:6px;cursor:pointer;font-size:12px">✎</button>
                  <button onclick="GIFs.togglePublic(${p.id}, ${p.is_public ? 0 : 1})" style="background:rgba(76,175,80,.14);border:1px solid #3a6b48;color:#cfe8d2;padding:5px 9px;border-radius:6px;cursor:pointer;font-size:12px">${p.is_public ? '🔒' : '🌍'}</button>
                  <button onclick="GIFs.deletePack(${p.id})" style="background:rgba(180,40,40,.14);border:1px solid #6b2a2a;color:#f0a0a0;padding:5px 9px;border-radius:6px;cursor:pointer;font-size:12px">🗑</button>
                </div>
              </div>
              <div id="sm-stickers-${p.id}" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(76,175,80,.18)"></div>
              <div style="margin-top:8px"><button onclick="GIFs.uploadStickerTo(${p.id})" style="background:rgba(76,175,80,.10);border:1px dashed #4caf50;color:#7fd08a;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;width:100%">+ Add sticker (PNG/WebP, ≤500KB)</button></div>
            </div>`;
        }
      }
      if (installed.length) {
        html += '<div style="font-size:11px;color:#7fd08a;text-transform:uppercase;letter-spacing:.5px;margin:14px 0 6px;font-weight:700">Installed</div>';
        for (const p of installed) {
          html += `
            <div style="background:rgba(0,0,0,.20);border:1px solid #2a5a3a;border-radius:10px;padding:10px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">
              <div><div style="font-weight:600;color:#cfe8d2">${UI.escHtml(p.name)}</div><div style="font-size:11px;color:#9bbf9b">by ${UI.escHtml(p.owner_name || '?')}</div></div>
              <button onclick="GIFs.uninstallPack(${p.id})" style="background:rgba(180,40,40,.14);border:1px solid #6b2a2a;color:#f0a0a0;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px">Uninstall</button>
            </div>`;
        }
      }
      if (!own.length && !installed.length) {
        html += '<div style="text-align:center;padding:24px;color:#6fbf7e">No packs yet — create one or browse public packs from the picker.</div>';
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
            cont.innerHTML = '<div style="font-size:11px;color:#6fbf7e">No stickers yet</div>';
            continue;
          }
          cont.innerHTML = d.stickers.map(s => `
            <div style="position:relative;width:56px;height:56px;background:rgba(0,0,0,.35);border-radius:8px;overflow:hidden;border:1px solid #2a5a3a" title="${UI.escHtml(s.name)}">
              <img src="${s.image_data}" style="width:100%;height:100%;object-fit:contain" alt="">
              <button onclick="GIFs.deleteSticker(${s.id})" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,.7);border:none;color:#f0a0a0;width:18px;height:18px;border-radius:50%;cursor:pointer;font-size:10px;line-height:1;padding:0">×</button>
            </div>`).join('');
        } catch {}
      }
    } catch (e) {
      body.innerHTML = '<div style="color:#f0a0a0;padding:20px;text-align:center">Failed to load packs</div>';
    }
  }

  function showCreatePack() {
    const name = prompt('Pack name (2-32 chars):');
    if (!name) return;
    const desc = prompt('Description (optional):') || '';
    apiFetch('/api/media/stickers/packs', 'POST', { name: name.trim(), description: desc.trim() })
      .then(r => r.json())
      .then(d => {
        if (d.error) UI.showToast(d.error, 'error');
        else { UI.showToast('Pack created', 'success'); renderManager(); }
      })
      .catch(() => UI.showToast('Failed to create pack', 'error'));
  }

  async function editPack(packId) {
    const newName = prompt('New pack name:');
    if (!newName) return;
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
    if (!confirm('Delete this pack and all its stickers? This cannot be undone.')) return;
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
    if (!confirm('Delete this sticker?')) return;
    const r = await apiFetch(`/api/media/stickers/${stickerId}`, 'DELETE');
    if (r.ok) { UI.showToast('Deleted', 'success'); renderManager(); }
    else UI.showToast('Delete failed', 'error');
  }

  function uploadStickerTo(packId) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/webp,image/gif';
    inp.onchange = async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      if (file.size > 500 * 1024) { UI.showToast('Sticker too large (max 500KB)', 'error'); return; }
      const name = (prompt('Sticker name:', file.name.replace(/\.[^.]+$/, '')) || '').trim();
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
    showCreatePack,
    editPack,
    togglePublic,
    deletePack,
    uninstallPack,
    deleteSticker,
    uploadStickerTo
  };
})();

// Add global toggle function for HTML onclick
function toggleGifPicker() {
  GIFs.toggle();
}
