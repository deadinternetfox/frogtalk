/**
 * content_warning.js — 18+ content warning gate for public channels.
 */
(function () {
  'use strict';

  const OVERLAY_ID = 'ft-content-warning-gate';
  const FLAG_META = {
    nudity: { label: 'Nudity / sexual content', desc: 'May contain nudity or sexual themes' },
    violence: { label: 'Violence', desc: 'May contain graphic violence' },
    extremism: { label: 'Extremist ideology', desc: 'May contain extremist or hateful ideology' },
    mature_themes: { label: 'Other mature themes', desc: 'May contain drugs, profanity, or other adult themes' },
  };

  /** Rooms acked during the current in-app visit (cleared on prepareRoomEntry). */
  const _visitAcked = new Set();

  function _el(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    if (typeof esc === 'function') return esc(s);
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatFlags(flags) {
    return (flags || []).map((f) => {
      const m = FLAG_META[f] || { label: f, desc: '' };
      return { key: f, ...m };
    });
  }

  function _cwEnabled(cw) {
    return !!(cw && cw.enabled && Array.isArray(cw.flags) && cw.flags.length);
  }

  function _roomMeta(roomName) {
    const name = String(roomName || '').trim().toLowerCase();
    if (!name || !window.State || !Array.isArray(State.rooms)) return null;
    return State.rooms.find((r) => String(r.name || '').toLowerCase() === name) || null;
  }

  function isCwRoom(roomName) {
    return _cwEnabled(_roomMeta(roomName)?.content_warning);
  }

  async function _fetchStatus(roomName) {
    const name = String(roomName || '').trim().toLowerCase();
    if (!name || !window.State || !State.token) return null;
    try {
      const r = await fetch(
        '/api/rooms/' + encodeURIComponent(name) + '/content-warning/status?_=' + Date.now(),
        { headers: { 'X-Session-Token': State.token }, cache: 'no-store' },
      );
      if (r.ok) return r.json();
      if (r.status === 403 || r.status === 404) {
        return { _httpStatus: r.status, required: false, content_warning: { enabled: false, flags: [] } };
      }
    } catch {}
    return null;
  }

  async function resolveCwMeta(roomName) {
    const name = String(roomName || '').trim().toLowerCase();
    const local = _roomMeta(name)?.content_warning;
    if (_cwEnabled(local)) return local;
    const status = await _fetchStatus(name);
    if (status && _cwEnabled(status.content_warning)) return status.content_warning;
    if (_cwEnabled(local)) return local;
    return status?.content_warning || local || { enabled: false, flags: [] };
  }

  function _removeOverlay() {
    const el = _el(OVERLAY_ID);
    if (el) el.remove();
  }

  function _clearRoomCache(roomName) {
    try {
      if (window.State && State.messages) State.messages[roomName] = [];
    } catch {}
  }

  function showDeclinedScreen(roomName) {
    _removeOverlay();
    const area = _el('messages-area');
    if (!area) return;
    const name = escapeHtml(roomName || 'this channel');
    area.innerHTML =
      '<div class="cw-declined-screen" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:280px;padding:32px 24px;text-align:center">' +
      '<div style="font-size:48px;margin-bottom:12px" aria-hidden="true">🔞</div>' +
      '<div style="font-size:17px;font-weight:600;color:#e8c4a8;margin-bottom:8px">18+ only</div>' +
      '<p style="font-size:13px;line-height:1.5;color:#a89888;max-width:340px;margin:0">' +
      'You must be 18 or older to view <strong style="color:#d4b896">#' + name + '</strong>. ' +
      'This channel is marked for mature audiences.</p></div>';
  }

  function _showGate(roomName, meta, resolve, showDeclinedOnBack) {
    _removeOverlay();
    _clearRoomCache(roomName);
    const flags = (meta && meta.flags) || [];
    const items = formatFlags(flags);
    const listHtml = items.length
      ? '<ul class="cw-gate-flags">' + items.map((it) =>
          '<li><strong>' + escapeHtml(it.label) + '</strong>' +
          (it.desc ? '<span>' + escapeHtml(it.desc) + '</span>' : '') + '</li>'
        ).join('') + '</ul>'
      : '<p class="cw-gate-flags-empty">This channel is marked for mature audiences.</p>';

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'cw-gate-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML =
      '<div class="cw-gate-card">' +
      '<div class="cw-gate-badge" aria-hidden="true">18+</div>' +
      '<h2 class="cw-gate-title">18+ content warning</h2>' +
      '<p class="cw-gate-lead">This channel may contain mature content flagged as:</p>' +
      listHtml +
      '<p class="cw-gate-confirm">Are you <strong>18 years of age or older</strong>?</p>' +
      '<div class="cw-gate-actions">' +
      '<button type="button" class="modal-btn secondary" id="cw-gate-back">Go back</button>' +
      '<button type="button" class="modal-btn primary" id="cw-gate-enter">I am 18 or older — enter</button>' +
      '</div></div>';

    document.body.appendChild(overlay);

    const onBack = () => {
      _removeOverlay();
      if (showDeclinedOnBack) showDeclinedScreen(roomName);
      resolve(false);
    };
    const onEnter = async () => {
      const enterBtn = _el('cw-gate-enter');
      if (enterBtn) {
        enterBtn.disabled = true;
        enterBtn.textContent = 'Confirming…';
      }
      try {
        const r = await fetch(
          '/api/rooms/' + encodeURIComponent(roomName) + '/content-warning/ack',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Session-Token': (window.State && State.token) || '',
            },
            body: JSON.stringify({ confirm: true }),
          },
        );
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          if (window.UI && UI.showToast) {
            UI.showToast(err.error || 'Could not confirm age', 'error');
          }
          if (enterBtn) {
            enterBtn.disabled = false;
            enterBtn.textContent = 'I am 18 or older — enter';
          }
          return;
        }
        _visitAcked.add(String(roomName || '').trim().toLowerCase());
        _removeOverlay();
        resolve(true);
      } catch {
        if (enterBtn) {
          enterBtn.disabled = false;
          enterBtn.textContent = 'I am 18 or older — enter';
        }
        if (window.UI && UI.showToast) UI.showToast('Network error', 'error');
      }
    };

    _el('cw-gate-back').onclick = onBack;
    _el('cw-gate-enter').onclick = () => { void onEnter(); };
  }

  async function _waitForToken(maxMs) {
    const limit = maxMs || 5000;
    const start = Date.now();
    while (Date.now() - start < limit) {
      if (window.State && State.token) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !!(window.State && State.token);
  }

  async function forgetAck(roomName) {
    const name = String(roomName || '').trim().toLowerCase();
    if (!name || name.startsWith('dm:') || !window.State || !State.token) return;
    _visitAcked.delete(name);
    try {
      await fetch('/api/rooms/' + encodeURIComponent(name) + '/content-warning/forget', {
        method: 'POST',
        headers: { 'X-Session-Token': State.token },
      });
    } catch {}
    _clearRoomCache(name);
  }

  async function prepareRoomEntry(roomName) {
    const name = String(roomName || '').trim().toLowerCase();
    if (!name || name.startsWith('dm:')) return;
    _visitAcked.delete(name);
    await forgetAck(name);
  }

  function gate(roomName, opts) {
    const name = String(roomName || '').trim().toLowerCase();
    const options = opts || {};
    if (!name || name.startsWith('dm:')) return Promise.resolve(true);

    return (async () => {
      if (_visitAcked.has(name)) return true;

      const localCw = _roomMeta(name)?.content_warning;
      const localMarked = _cwEnabled(localCw);

      const hasToken = await _waitForToken(options.tokenWaitMs || 8000);
      if (!hasToken) {
        if (localMarked) {
          const meta = localCw || await resolveCwMeta(name);
          return await new Promise((resolve) => {
            _showGate(name, meta, resolve, !!(window.State && State.currentRoom === name));
          });
        }
        return true;
      }

      const status = await _fetchStatus(name);
      const cwMeta = await resolveCwMeta(name);
      const statusMarked = _cwEnabled(status?.content_warning) || _cwEnabled(cwMeta);
      const statusRequired = !!(status && status.required);

      let shouldGate = statusRequired || statusMarked || localMarked;
      if (!shouldGate && localMarked) shouldGate = true;
      if (!shouldGate && statusMarked) shouldGate = true;
      if (!shouldGate && status === null && (localMarked || isCwRoom(name))) {
        shouldGate = true;
      }

      if (!shouldGate) return true;

      const alreadyInRoom = !!(window.State && State.currentRoom === name);
      return await new Promise((resolve) => {
        _showGate(name, cwMeta.enabled ? cwMeta : (localCw || cwMeta), resolve, alreadyInRoom);
      });
    })();
  }

  function _lockRoomUntilAck(room) {
    try {
      _clearRoomCache(room);
      const area = _el('messages-area');
      if (area) {
        area.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:center;min-height:200px;color:#888;font-size:13px">18+ confirmation required…</div>';
      }
      if (typeof WS !== 'undefined' && WS.disconnect) {
        try { WS.disconnect(); } catch {}
      }
    } catch {}
  }

  function handleWsUpdate(data) {
    const room = String((data && data.room) || '').trim().toLowerCase();
    if (!room) return;
    const cw = data.content_warning || {};
    if (!cw.enabled) {
      _removeOverlay();
      return;
    }
    if (window.State && State.currentRoom === room) {
      _visitAcked.delete(room);
      _lockRoomUntilAck(room);
      void gate(room).then((ok) => {
        if (ok && typeof WS !== 'undefined' && WS.connect) {
          try { WS.connect(room); } catch {}
        } else if (!ok) {
          try { showDeclinedScreen(room); } catch {}
        }
      });
    }
  }

  function handleWsRequired(data) {
    const room = String((data && data.room) || '').trim().toLowerCase();
    if (!room || !window.State || State.currentRoom !== room) return;
    _visitAcked.delete(room);
    _lockRoomUntilAck(room);
    void gate(room).then((ok) => {
      if (ok && typeof WS !== 'undefined' && WS.connect) {
        try { WS.connect(room); } catch {}
      } else if (!ok) {
        try { showDeclinedScreen(room); } catch {}
      }
    });
  }

  function badgeHtml(cw) {
    if (!cw || !cw.enabled || !(cw.flags && cw.flags.length)) return '';
    const labels = formatFlags(cw.flags).map((f) => f.label).join(', ');
    const tip = escapeHtml(labels);
    return '<span class="ch-cw-badge" title="' + tip + '">18+</span>';
  }

  function patchMeta(roomName, cw) {
    const name = String(roomName || '').trim().toLowerCase();
    if (!name) return;
    if (cw && cw.enabled) _visitAcked.delete(name);
  }

  window.ContentWarning = {
    gate,
    forgetAck,
    prepareRoomEntry,
    resolveCwMeta,
    isCwRoom,
    patchMeta,
    formatFlags,
    handleWsUpdate,
    handleWsRequired,
    showDeclinedScreen,
    badgeHtml,
  };
})();
