/**
 * mute.js — Client-side mute for users & channels (Discord-style).
 *
 *  - Muted USER: their messages render as collapsed "muted" placeholders that
 *    can be clicked to reveal. No sound, no desktop/native notification, no
 *    unread badge increment.
 *  - Muted CHANNEL: no sound, no notification, no unread badge increment when
 *    messages arrive there. A 🔕 indicator shows next to the channel in the
 *    sidebar.
 *
 *  State is persisted in localStorage so it survives reloads and syncs across
 *  tabs. It is intentionally client-only — server still delivers messages.
 */
const Mute = (() => {
  const K_USERS = 'ft_muted_users';
  const K_ROOMS = 'ft_muted_rooms';

  function _load(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
  }
  function _save(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr.slice(0, 500))); } catch {}
  }

  function listUsers() { return _load(K_USERS); }
  function listRooms() { return _load(K_ROOMS); }

  function isUserMuted(nick) {
    if (!nick) return false;
    return _load(K_USERS).some(n => n.toLowerCase() === String(nick).toLowerCase());
  }
  function isRoomMuted(name) {
    if (!name) return false;
    return _load(K_ROOMS).some(n => n.toLowerCase() === String(name).toLowerCase());
  }

  function _toggle(key, value) {
    const arr = _load(key);
    const idx = arr.findIndex(n => n.toLowerCase() === String(value).toLowerCase());
    let nowMuted;
    if (idx >= 0) { arr.splice(idx, 1); nowMuted = false; }
    else          { arr.push(String(value)); nowMuted = true; }
    _save(key, arr);
    return nowMuted;
  }

  function toggleUser(nick) {
    const now = _toggle(K_USERS, nick);
    try {
      if (typeof UI !== 'undefined' && UI.showToast) {
        UI.showToast(now ? `🔕 Muted @${nick}` : `🔔 Unmuted @${nick}`);
      }
    } catch {}
    _refreshVisibleMessages();
    return now;
  }

  function toggleRoom(name) {
    const now = _toggle(K_ROOMS, name);
    try {
      if (typeof UI !== 'undefined' && UI.showToast) {
        UI.showToast(now ? `🔕 Muted #${name}` : `🔔 Unmuted #${name}`);
      }
    } catch {}
    // Refresh channel list UI so the 🔕 indicator appears/disappears.
    try { if (typeof Rooms !== 'undefined' && Rooms.renderMuteState) Rooms.renderMuteState(); } catch {}
    // If the muted room is currently open, refresh unread badge.
    return now;
  }

  // Re-render currently visible messages so muted users collapse/uncollapse.
  function _refreshVisibleMessages() {
    try {
      const room = State.currentRoom;
      const cache = State.messages?.[room] || [];
      if (cache.length && typeof Messages !== 'undefined' && Messages.loadHistory) {
        Messages.loadHistory(room, cache.slice());
      }
    } catch {}
  }

  // Called by the inline "Show message" button in muted placeholders.
  function revealMessage(msgId) {
    const el = document.getElementById(`msg-${msgId}`);
    if (!el) return;
    el.classList.remove('is-muted-user');
    const ghost = el.querySelector('.msg-muted-placeholder');
    const hidden = el.querySelector('.msg-muted-hidden');
    if (ghost) ghost.remove();
    if (hidden) hidden.style.display = '';
  }

  return {
    listUsers, listRooms,
    isUserMuted, isRoomMuted,
    toggleUser, toggleRoom,
    revealMessage,
  };
})();

// Expose globals for inline onclick handlers.
window.Mute = Mute;
function muteRevealMessage(id) { Mute.revealMessage(id); }
