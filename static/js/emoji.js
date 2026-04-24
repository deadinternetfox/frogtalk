/**
 * emoji.js — Simple emoji picker with custom emoji support
 */

const EMOJI_DATA = {
  '⭐ Custom': [], // Loaded from server
  '🙂 Smileys': ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','🥳','🤩','😍','🥰','😘','😜','😝','😛','🤪','😐','😑','😶','🙄','😏','😒','🤔','🤨','😣','😥','😮','😲','😯','😦','😧','😨','😱','😬','😭','😢','😰','😓','🙃','😌','😤','😠','😡','🤬','😴'],
  '🐸 Animals': ['🐸','🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐙','🦋','🐝','🦄','🐲','🦎','🐊'],
  '🍕 Food': ['🍕','🍔','🌮','🌯','🍜','🍣','🍦','🎂','🍰','🧁','🍩','🍪','🌭','🍟','🥗','🥑','🍎','🍇','🍓'],
  '⚡ Symbols': ['❤️','🔥','✅','❌','⭐','💫','🎉','🎊','🎯','🏆','💎','👑','🔒','🔑','💡','🛡️','⚡','💥','✨','🌈','🎮','🎵','🎸','🎹'],
  '👋 People': ['👍','👎','👌','✌️','🤞','🤟','👊','✊','👏','🙌','🤲','👐','🤜','🤛','👋','🙏','🤝'],
};

let _customEmojis = [];

async function loadCustomEmojis() {
  try {
    const res = await fetch('/api/emojis', { headers: { 'X-Session-Token': State.token } });
    if (res.ok) {
      const data = await res.json();
      _customEmojis = data.emojis || [];
    }
  } catch (e) {
    console.error('Failed to load custom emojis:', e);
  }
}

function buildEmojiPicker() {
  const cats = document.getElementById('ep-cats');
  const grid = document.getElementById('ep-grid');
  if (!cats || !grid) return;

  const keys = Object.keys(EMOJI_DATA);
  keys.forEach((cat, i) => {
    const btn = document.createElement('div');
    btn.className = 'ep-cat' + (i === 0 ? ' active' : '');
    btn.textContent = cat.split(' ')[0];
    btn.title = cat;
    btn.onclick = () => {
      document.querySelectorAll('.ep-cat').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderCategory(cat);
    };
    cats.appendChild(btn);
  });

  // Load custom emojis and render first category
  loadCustomEmojis().then(() => renderCategory(keys[0]));
}

function renderCategory(cat) {
  const grid = document.getElementById('ep-grid');
  grid.innerHTML = '';
  
  if (cat === '⭐ Custom') {
    if (_customEmojis.length === 0) {
      grid.innerHTML = '<div style="color:#666;padding:10px;text-align:center;font-size:12px">No custom emojis yet</div>';
      // Add upload button for admin
      if (State.user?.is_admin) {
        const addBtn = document.createElement('button');
        addBtn.className = 'modal-btn primary';
        addBtn.style.cssText = 'margin:10px auto;display:block;font-size:12px;padding:6px 12px';
        addBtn.textContent = '+ Add Emoji';
        addBtn.onclick = () => openAddEmojiModal();
        grid.appendChild(addBtn);
      }
      return;
    }
    
    _customEmojis.forEach(emoji => {
      const span = document.createElement('span');
      span.className = 'ep-emoji custom-emoji';
      span.innerHTML = `<img src="${emoji.image_data}" alt=":${emoji.name}:" title=":${emoji.name}:" style="width:24px;height:24px">`;
      span.onclick = () => insertEmoji(`:${emoji.name}:`);
      grid.appendChild(span);
    });
    
    // Add upload button for admin
    if (State.user?.is_admin) {
      const addBtn = document.createElement('span');
      addBtn.className = 'ep-emoji';
      addBtn.style.cssText = 'background:#2a2a2a;border:1px dashed #444;border-radius:4px';
      addBtn.textContent = '+';
      addBtn.title = 'Add custom emoji';
      addBtn.onclick = () => openAddEmojiModal();
      grid.appendChild(addBtn);
    }
  } else {
    (EMOJI_DATA[cat] || []).forEach(e => {
      const span = document.createElement('span');
      span.className = 'ep-emoji';
      span.textContent = e;
      span.onclick = () => insertEmoji(e);
      grid.appendChild(span);
    });
  }
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
  toggleEmojiPicker(true); // close after insert
}

function toggleEmojiPicker(forceClose = false) {
  const picker = document.getElementById('emoji-picker');
  if (!picker) return;
  if (forceClose) { picker.classList.remove('active'); return; }
  // Mutually exclusive with the GIF picker — closing it here prevents the
  // two panels from stacking over each other on top of the composer.
  try { if (typeof GIFs !== 'undefined' && GIFs.close) GIFs.close(); } catch {}
  picker.classList.toggle('active');
  // Anchor the picker near the emoji button — on wide desktop/electron
  // windows the old fixed right:70px,bottom:70px placement drifted far
  // from the composer. We now measure the button each open.
  if (picker.classList.contains('active')) {
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
        picker.style.top    = 'auto';
        picker.style.bottom = bottomGap + 'px';
        picker.style.left   = left + 'px';
        picker.style.right  = 'auto';
        picker.style.width  = pw + 'px';
        picker.style.height = ph + 'px';
      }
    } catch {}
  }
}

// Add custom emoji modal
function openAddEmojiModal() {
  toggleEmojiPicker(true);
  
  // Create modal if doesn't exist
  let modal = document.getElementById('modal-add-emoji');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal-overlay hidden';
    modal.id = 'modal-add-emoji';
    modal.innerHTML = `
      <div class="modal" style="max-width:360px">
        <div class="modal-title">Add Custom Emoji</div>
        <label class="modal-label">Emoji Name</label>
        <input class="modal-input" id="add-emoji-name" placeholder="e.g. cool_frog" maxlength="32"
               oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9_]/g,'')">
        <label class="modal-label">Image (PNG, GIF, up to 256KB)</label>
        <input type="file" id="add-emoji-file" accept="image/png,image/gif,image/webp" style="display:none">
        <div id="add-emoji-preview" style="width:64px;height:64px;background:#1a1a1a;border-radius:8px;margin:10px auto;display:flex;align-items:center;justify-content:center;cursor:pointer;border:2px dashed #333" onclick="document.getElementById('add-emoji-file').click()">
          <span style="color:#666">Click</span>
        </div>
        <label class="toggle-row" style="display:flex;align-items:center;gap:8px;margin:12px 0">
          <input type="checkbox" id="add-emoji-global" style="width:18px;height:18px">
          <span style="font-size:13px;color:#ccc">Make available server-wide</span>
        </label>
        <div class="modal-actions">
          <button class="modal-btn secondary" onclick="closeModal('modal-add-emoji')">Cancel</button>
          <button class="modal-btn primary" onclick="submitCustomEmoji()">Add</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    
    // File input handler
    document.getElementById('add-emoji-file').onchange = function(e) {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 256 * 1024) {
        toast('Image too large (max 256KB)', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const preview = document.getElementById('add-emoji-preview');
        preview.innerHTML = `<img src="${e.target.result}" style="max-width:100%;max-height:100%;border-radius:6px">`;
        preview.dataset.imageData = e.target.result;
      };
      reader.readAsDataURL(file);
    };
  }
  
  // Reset form
  document.getElementById('add-emoji-name').value = '';
  document.getElementById('add-emoji-file').value = '';
  document.getElementById('add-emoji-preview').innerHTML = '<span style="color:#666">Click</span>';
  document.getElementById('add-emoji-preview').dataset.imageData = '';
  document.getElementById('add-emoji-global').checked = true;
  
  openModal('modal-add-emoji');
}

async function submitCustomEmoji() {
  const name = document.getElementById('add-emoji-name').value.trim();
  const imageData = document.getElementById('add-emoji-preview').dataset.imageData;
  const isGlobal = document.getElementById('add-emoji-global').checked;
  
  if (!name) { toast('Please enter a name', 'error'); return; }
  if (!imageData) { toast('Please select an image', 'error'); return; }
  
  try {
    const res = await fetch('/api/emojis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': State.token },
      body: JSON.stringify({ name, image_data: imageData, is_global: isGlobal })
    });
    
    if (!res.ok) {
      const data = await res.json();
      toast(data.error || 'Failed to add emoji', 'error');
      return;
    }
    
    toast(`Emoji :${name}: added!`);
    closeModal('modal-add-emoji');
    
    // Reload custom emojis
    await loadCustomEmojis();
    renderCategory('⭐ Custom');
  } catch (e) {
    toast('Failed to add emoji', 'error');
  }
}

// Replace :emoji_name: with custom emoji images in messages
function renderCustomEmojisInText(text) {
  return text.replace(/:([a-z0-9_]{2,32}):/g, (match, name) => {
    const emoji = _customEmojis.find(e => e.name === name);
    if (emoji) {
      return `<img src="${emoji.image_data}" alt=":${name}:" title=":${name}:" class="custom-emoji-inline" style="width:20px;height:20px;vertical-align:middle">`;
    }
    return match;
  });
}

// Close picker when clicking outside
document.addEventListener('click', (e) => {
  const picker = document.getElementById('emoji-picker');
  if (!picker) return;
  if (!picker.contains(e.target) && !e.target.classList.contains('emoji-btn')) {
    picker.classList.remove('active');
  }
});
