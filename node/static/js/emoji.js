/**
 * emoji.js — Emoji picker: account emojis, channel emojis, unicode sets
 */

const CAT_MY = '👤 My emojis';
const CAT_CHANNEL = '📢 Channel emojis';

const EMOJI_DATA = {
  [CAT_MY]: [],
  [CAT_CHANNEL]: [],
  '🙂 Smileys': ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','🥳','🤩','😍','🥰','😘','😜','😝','😛','🤪','😐','😑','😶','🙄','😏','😒','🤔','🤨','😣','😥','😮','😲','😯','😦','😧','😨','😱','😬','😭','😢','😰','😓','🙃','😌','😤','😠','😡','🤬','😴'],
  '🐸 Animals': ['🐸','🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐙','🦋','🐝','🦄','🐲','🦎','🐊'],
  '🍕 Food': ['🍕','🍔','🌮','🌯','🍜','🍣','🍦','🎂','🍰','🧁','🍩','🍪','🌭','🍟','🥗','🥑','🍎','🍇','🍓'],
  '⚡ Symbols': ['❤️','🔥','✅','❌','⭐','💫','🎉','🎊','🎯','🏆','💎','👑','🔒','🔑','💡','🛡️','⚡','💥','✨','🌈','🎮','🎵','🎸','🎹'],
  '👋 People': ['👍','👎','👌','✌️','🤞','🤟','👊','✊','👏','🙌','🤲','👐','🤜','🤛','👋','🙏','🤝'],
};

let _myEmojis = [];
let _channelEmojis = [];
let _renderEmojis = [];
let _epActiveCategory = CAT_MY;
let _addEmojiScope = 'mine';

const _EMOJI_DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i;

function _attrEsc(s) {
  return (window.UI && UI.escHtml)
    ? UI.escHtml(s)
    : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _isSafeEmojiDataUrl(raw) {
  return _EMOJI_DATA_URL_RE.test(String(raw || '').trim());
}

function getCurrentRoomId() {
  if (!State?.currentRoom || State.currentRoomType === 'dm') return null;
  const row = (State.rooms || []).find(r => r.name === State.currentRoom);
  return row?.id != null ? Number(row.id) : null;
}

function _canModerateCurrentChannel() {
  if (!State?.user || State.currentRoomType === 'dm') return false;
  if (State.user.is_admin) return true;
  const isOwner = State.currentRoomOwner === State.user.nickname;
  const isMod = Array.isArray(State.currentRoomMods) && State.currentRoomMods.includes(State.user.nickname);
  return isOwner || isMod;
}

function _rebuildRenderEmojis() {
  const map = new Map();
  _myEmojis.forEach(e => map.set(e.name, e));
  _channelEmojis.forEach(e => map.set(e.name, e));
  _renderEmojis = Array.from(map.values());
}

function _setEmojiPreviewImage(previewEl, dataUrl) {
  if (!previewEl) return;
  previewEl.replaceChildren();
  previewEl.dataset.imageData = '';
  if (!_isSafeEmojiDataUrl(dataUrl)) {
    previewEl.innerHTML = '<span class="emoji-upload-placeholder">Click</span>';
    return;
  }
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = 'Emoji preview';
  img.style.cssText = 'max-width:100%;max-height:100%;border-radius:6px';
  previewEl.appendChild(img);
  previewEl.dataset.imageData = dataUrl;
}

async function loadCustomEmojis() {
  _myEmojis = [];
  _channelEmojis = [];
  if (!State?.token) {
    _rebuildRenderEmojis();
    return;
  }
  const headers = { 'X-Session-Token': State.token };
  try {
    const mineRes = await fetch('/api/emojis/mine', { headers });
    if (mineRes.ok) {
      const data = await mineRes.json();
      _myEmojis = (data.emojis || []).filter(e => _isSafeEmojiDataUrl(e?.image_data));
    }
  } catch (e) {
    console.error('Failed to load my emojis:', e);
  }
  const rid = getCurrentRoomId();
  if (rid) {
    try {
      const chRes = await fetch(`/api/emojis/room/${rid}`, { headers });
      if (chRes.ok) {
        const data = await chRes.json();
        _channelEmojis = (data.emojis || []).filter(e => _isSafeEmojiDataUrl(e?.image_data));
      }
    } catch (e) {
      console.error('Failed to load channel emojis:', e);
    }
  }
  _rebuildRenderEmojis();
}

async function refreshEmojiRenderCache() {
  const rid = getCurrentRoomId();
  if (!State?.token) return;
  try {
    const q = rid ? `?room_id=${encodeURIComponent(rid)}` : '';
    const res = await fetch(`/api/emojis/render${q}`, { headers: { 'X-Session-Token': State.token } });
    if (res.ok) {
      const data = await res.json();
      _renderEmojis = (data.emojis || []).filter(e => _isSafeEmojiDataUrl(e?.image_data));
    }
  } catch {
    _rebuildRenderEmojis();
  }
}

function _pickerCategoryKeys() {
  const keys = [CAT_MY];
  if (getCurrentRoomId()) keys.push(CAT_CHANNEL);
  Object.keys(EMOJI_DATA).forEach(k => {
    if (k !== CAT_MY && k !== CAT_CHANNEL) keys.push(k);
  });
  return keys;
}

function buildEmojiPicker() {
  const cats = document.getElementById('ep-cats');
  const grid = document.getElementById('ep-grid');
  if (!cats || !grid) return;

  const renderCats = () => {
    cats.replaceChildren();
    const keys = _pickerCategoryKeys();
    keys.forEach((cat, i) => {
      const btn = document.createElement('div');
      const isActive = cat === _epActiveCategory || (i === 0 && !keys.includes(_epActiveCategory));
      btn.className = 'ep-cat' + (isActive ? ' active' : '');
      if (cat === CAT_CHANNEL && _canModerateCurrentChannel()) {
        btn.classList.add('ep-cat-channel-manage');
      }
      btn.title = cat;
      btn.dataset.cat = cat;
      const label = document.createElement('span');
      label.textContent = cat.split(' ')[0];
      btn.appendChild(label);
      if (cat === CAT_CHANNEL && _canModerateCurrentChannel()) {
        const plus = document.createElement('span');
        plus.className = 'ep-cat-channel-add';
        plus.setAttribute('aria-hidden', 'true');
        plus.textContent = '+';
        btn.appendChild(plus);
        btn.title = 'Channel emojis — tap + in grid to add';
      }
      btn.onclick = () => {
        document.querySelectorAll('.ep-cat').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderCategory(cat);
      };
      cats.appendChild(btn);
    });
  };

  if (cats.dataset.built === '1') {
    renderCats();
    loadCustomEmojis().then(() => renderCategory(_epActiveCategory));
    return;
  }
  cats.dataset.built = '1';

  renderCats();
  loadCustomEmojis().then(() => renderCategory(CAT_MY));
}

function _setCustomEmojiFooterVisible(on) {
  const picker = document.getElementById('emoji-picker');
  if (picker) picker.classList.toggle('ep-custom-tab', !!on);
}

function _appendEmojiTile(grid, emoji, scope) {
  const rawSrc = String(emoji.image_data || '');
  if (!_isSafeEmojiDataUrl(rawSrc)) return;
  const span = document.createElement('span');
  span.className = 'ep-emoji custom-emoji';
  span.dataset.emojiId = String(emoji.id || '');
  span.dataset.emojiScope = scope;
  const img = document.createElement('img');
  img.src = rawSrc;
  img.alt = `:${emoji.name || ''}:`;
  img.title = img.alt;
  img.style.cssText = 'width:24px;height:24px';
  span.appendChild(img);
  span.onclick = () => insertEmoji(`:${emoji.name}:`);
  if (typeof bindLongPress === 'function') {
    bindLongPress(span, (ev) => {
      ev.preventDefault();
      _openEmojiTileMenu(emoji, scope);
    });
  }
  grid.appendChild(span);
}

function _openEmojiTileMenu(emoji, scope) {
  const items = [];
  if (scope === 'channel') {
    items.push({ label: 'Add emoji', icon: '➕', onclick: () => importEmojiToAccount(emoji.id) });
  }
  const canDelete = scope === 'mine' || (scope === 'channel' && _canModerateCurrentChannel());
  if (canDelete) {
    items.push({ label: 'Delete emoji', icon: '🗑', danger: true, onclick: () => deleteCustomEmoji(emoji.id, scope) });
  }
  if (!items.length) return;
  if (typeof showActionSheet === 'function') showActionSheet('Emoji', items);
  else if (items[0]?.onclick) items[0].onclick();
}

async function importEmojiToAccount(emojiId) {
  if (!emojiId || !State?.token) return;
  try {
    const res = await fetch('/api/emojis/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ emoji_id: Number(emojiId) }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || 'Could not add emoji', 'error');
      return;
    }
    toast(data.skipped ? 'Already in your emojis' : `Added :${data.name}: to your account`, data.skipped ? 'info' : 'success');
    await loadCustomEmojis();
    if (_epActiveCategory === CAT_MY) renderCategory(CAT_MY);
  } catch {
    toast('Failed to add emoji', 'error');
  }
}

async function deleteCustomEmoji(emojiId, scope) {
  const ok = confirm(scope === 'channel' ? 'Delete this channel emoji for everyone?' : 'Delete this emoji from your account?');
  if (!ok) return;
  try {
    const res = await fetch(`/api/emojis/${emojiId}`, {
      method: 'DELETE',
      headers: { 'X-Session-Token': State.token },
    });
    if (!res.ok) {
      const data = await res.json();
      toast(data.error || 'Delete failed', 'error');
      return;
    }
    toast('Emoji deleted', 'success');
    await loadCustomEmojis();
    renderCategory(_epActiveCategory);
    refreshEmojiRenderCache();
  } catch {
    toast('Delete failed', 'error');
  }
}

function renderCategory(cat) {
  const grid = document.getElementById('ep-grid');
  if (!grid) return;
  _epActiveCategory = cat;
  grid.innerHTML = '';
  const isMine = cat === CAT_MY;
  const isChannel = cat === CAT_CHANNEL;
  _setCustomEmojiFooterVisible(isMine || (isChannel && _canModerateCurrentChannel()));

  if (isMine || isChannel) {
    const list = isMine ? _myEmojis : _channelEmojis;
    const scope = isMine ? 'mine' : 'channel';
    if (!isMine && !getCurrentRoomId()) {
      const empty = document.createElement('div');
      empty.className = 'ep-custom-empty';
      empty.textContent = 'Join a channel to see channel emojis';
      grid.appendChild(empty);
      return;
    }
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ep-custom-empty';
      empty.textContent = isMine
        ? 'No emojis yet — tap + to add'
        : (_canModerateCurrentChannel()
          ? 'No channel emojis yet — tap + to add'
          : 'No channel emojis in this channel yet');
      grid.appendChild(empty);
    } else {
      list.forEach(emoji => _appendEmojiTile(grid, emoji, scope));
    }
    if (isMine || (isChannel && _canModerateCurrentChannel())) {
      const addTile = document.createElement('span');
      addTile.className = 'ep-emoji ep-emoji-add';
      addTile.textContent = '+';
      addTile.title = isChannel ? 'Add channel emoji' : 'Add emoji to your account';
      addTile.setAttribute('aria-label', addTile.title);
      addTile.onclick = (e) => {
        e.stopPropagation();
        _addEmojiScope = isChannel ? 'channel' : 'mine';
        openAddEmojiModal();
      };
      grid.appendChild(addTile);
    }
    return;
  }

  _setCustomEmojiFooterVisible(false);
  (EMOJI_DATA[cat] || []).forEach(e => {
    const span = document.createElement('span');
    span.className = 'ep-emoji';
    span.textContent = e;
    span.onclick = () => insertEmoji(e);
    grid.appendChild(span);
  });
}

function insertEmoji(emoji) {
  const input = document.getElementById('msg-input');
  if (!input) return;
  const pos = input.selectionStart;
  const val = input.value;
  input.value = val.slice(0, pos) + emoji + val.slice(pos);
  input.selectionStart = input.selectionEnd = pos + emoji.length;
  input.focus();
  autoResize(input);
  toggleEmojiPicker(true);
}

function toggleEmojiPicker(forceClose = false) {
  const picker = document.getElementById('emoji-picker');
  if (!picker) return;
  if (forceClose) {
    picker.classList.remove('active');
    _setCustomEmojiFooterVisible(false);
    return;
  }
  try { if (typeof GIFs !== 'undefined' && GIFs.close) GIFs.close(); } catch {}
  const opening = !picker.classList.contains('active');
  picker.classList.toggle('active');
  if (opening) {
    loadCustomEmojis().then(() => {
      const cats = document.getElementById('ep-cats');
      if (cats) {
        cats.dataset.built = '0';
        buildEmojiPicker();
      }
      renderCategory(_epActiveCategory);
    });
    if (_epActiveCategory === CAT_MY || _epActiveCategory === CAT_CHANNEL) {
      _setCustomEmojiFooterVisible(true);
    }
    try {
      const btn = document.querySelector('.emoji-btn');
      if (btn) {
        const r = btn.getBoundingClientRect();
        const pw = Math.min(260, window.innerWidth - 16);
        const bottomGap = Math.max(8, window.innerHeight - r.top + 4);
        const avail = r.top - 12;
        const ph = Math.max(220, Math.min(300, avail));
        let left = r.right - pw;
        if (left < 8) left = 8;
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
        picker.style.position = 'fixed';
        picker.style.top = 'auto';
        picker.style.bottom = bottomGap + 'px';
        picker.style.left = left + 'px';
        picker.style.right = 'auto';
        picker.style.width = pw + 'px';
        picker.style.height = ph + 'px';
      }
    } catch {}
  }
}

function openAddEmojiModal() {
  toggleEmojiPicker(true);
  let modal = document.getElementById('modal-add-emoji');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal-overlay hidden';
    modal.id = 'modal-add-emoji';
    modal.innerHTML = `
      <div class="modal modal-add-emoji">
        <div class="modal-title">Add emoji</div>
        <label class="modal-label">Emoji Name</label>
        <input class="modal-input" id="add-emoji-name" placeholder="e.g. cool_frog" maxlength="32"
               oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9_]/g,'')">
        <label class="modal-label">Image (PNG, GIF, WebP, up to 256KB)</label>
        <input type="file" id="add-emoji-file" accept="image/png,image/gif,image/webp" style="display:none">
        <div id="add-emoji-preview" class="emoji-upload-preview" onclick="document.getElementById('add-emoji-file').click()">
          <span class="emoji-upload-placeholder">Click</span>
        </div>
        <div id="add-emoji-scope-row" class="add-emoji-scope-row" style="display:none;flex-direction:column;gap:8px;margin-top:8px">
          <label class="toggle-row"><input type="radio" name="add-emoji-scope" value="mine" checked> <span class="modal-label">My account (all channels)</span></label>
          <label class="toggle-row add-emoji-channel-row"><input type="radio" name="add-emoji-scope" value="channel"> <span class="modal-label">This channel only</span></label>
        </div>
        <div class="modal-actions">
          <button class="modal-btn secondary" onclick="closeModal('modal-add-emoji')">Cancel</button>
          <button class="modal-btn primary" onclick="submitCustomEmoji()">Add</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('add-emoji-file').onchange = function(e) {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 256 * 1024) {
        toast('Image too large (max 256KB)', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        _setEmojiPreviewImage(document.getElementById('add-emoji-preview'), ev.target.result);
      };
      reader.readAsDataURL(file);
    };
  }

  const scopeRow = document.getElementById('add-emoji-scope-row');
  const showScope = getCurrentRoomId() && _canModerateCurrentChannel();
  if (scopeRow) scopeRow.style.display = showScope ? 'flex' : 'none';
  const scopeVal = _addEmojiScope === 'channel' && showScope ? 'channel' : 'mine';
  scopeRow?.querySelectorAll('input[name="add-emoji-scope"]').forEach(inp => {
    inp.checked = inp.value === scopeVal;
  });

  document.getElementById('add-emoji-name').value = '';
  document.getElementById('add-emoji-file').value = '';
  document.getElementById('add-emoji-preview').innerHTML = '<span class="emoji-upload-placeholder">Click</span>';
  document.getElementById('add-emoji-preview').dataset.imageData = '';
  openModal('modal-add-emoji');
}

async function submitCustomEmoji() {
  const name = document.getElementById('add-emoji-name').value.trim();
  const imageData = document.getElementById('add-emoji-preview').dataset.imageData;
  if (!name) { toast('Please enter a name', 'error'); return; }
  if (!imageData) { toast('Please select an image', 'error'); return; }

  let roomId = null;
  const scopeInp = document.querySelector('input[name="add-emoji-scope"]:checked');
  if (scopeInp?.value === 'channel') {
    roomId = getCurrentRoomId();
    if (!roomId) {
      toast('Open a channel to add channel emojis', 'error');
      return;
    }
  }

  try {
    const res = await fetch('/api/emojis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ name, image_data: imageData, room_id: roomId }),
    });
    if (!res.ok) {
      const data = await res.json();
      toast(data.error || 'Failed to add emoji', 'error');
      return;
    }
    toast(roomId ? `Channel emoji :${name}: added` : `Emoji :${name}: added to your account`);
    closeModal('modal-add-emoji');
    await loadCustomEmojis();
    refreshEmojiRenderCache();
    renderCategory(roomId ? CAT_CHANNEL : CAT_MY);
  } catch {
    toast('Failed to add emoji', 'error');
  }
}

function renderCustomEmojisInText(text) {
  return text.replace(/:([a-z0-9_]{2,32}):/g, (match, name) => {
    const emoji = _renderEmojis.find(e => e.name === name);
    if (!emoji) return match;
    const raw = String(emoji.image_data || '');
    if (!_isSafeEmojiDataUrl(raw)) return match;
    const safeSrc = _attrEsc(raw);
    const safeName = _attrEsc(name);
    const eid = emoji.id != null ? ` data-emoji-id="${_attrEsc(String(emoji.id))}"` : '';
    return `<img src="${safeSrc}" alt=":${safeName}:" title=":${safeName}:" class="custom-emoji-inline"${eid} style="width:20px;height:20px;vertical-align:middle">`;
  });
}

document.addEventListener('click', (e) => {
  const picker = document.getElementById('emoji-picker');
  if (!picker) return;
  if (!picker.contains(e.target) && !e.target.classList.contains('emoji-btn')) {
    picker.classList.remove('active');
  }
});
