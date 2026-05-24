/**
 * content_warning.js — 18+ content warning gate for public channels.
 */
(function () {
  'use strict';

  const OVERLAY_ID = 'ft-content-warning-gate';
  const CHAT_CONTENT_ID = 'cw-chat-content';
  const UNLOCK_MS = 420;
  const FLAG_META = {
    nudity: { label: 'Nudity / sexual content', desc: 'May contain nudity or sexual themes' },
    violence: { label: 'Violence', desc: 'May contain graphic violence' },
    extremism: { label: 'Extremist ideology', desc: 'May contain extremist or hateful ideology' },
    mature_themes: { label: 'Other mature themes', desc: 'May contain drugs, profanity, or other adult themes' },
  };

  /** Rooms acked during the current in-app visit (cleared on prepareRoomEntry). */
  const _visitAcked = new Set();
  /** One in-flight gate() promise per room — prevents duplicate overlays. */
  const _gateInflight = new Map();

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

  function patchRoomCwMeta(roomName, cw) {
    const name = String(roomName || '').trim().toLowerCase();
    if (!name || !window.State || !Array.isArray(State.rooms) || !_cwEnabled(cw)) return;
    const row = State.rooms.find((r) => String(r.name || '').toLowerCase() === name);
    if (row) row.content_warning = cw;
  }

  function _mergeCwMeta() {
    for (let i = 0; i < arguments.length; i++) {
      const cw = arguments[i];
      if (_cwEnabled(cw)) return cw;
    }
    return { enabled: false, flags: [] };
  }

  function _isViewingRoom(room) {
    if (!room || !window.State) return false;
    if (State.currentRoom === room) return true;
    try {
      if (State._roomSwitchInProgress === room) return true;
    } catch {}
    return false;
  }

  function isGateActive(roomName) {
    const name = String(roomName || '').trim().toLowerCase();
    return !!_el(OVERLAY_ID) || (name && _gateInflight.has(name));
  }

  function _lockComposer() {
    try { document.body.classList.add('cw-composer-locked'); } catch {}
    const input = _el('msg-input');
    const inputArea = _el('input-area');
    if (input) {
      input.setAttribute('readonly', 'readonly');
      input.setAttribute('aria-disabled', 'true');
    }
    if (inputArea) inputArea.setAttribute('aria-disabled', 'true');
  }

  function _unlockComposer() {
    try { document.body.classList.remove('cw-composer-locked'); } catch {}
    const input = _el('msg-input');
    const inputArea = _el('input-area');
    if (input) {
      input.removeAttribute('readonly');
      input.removeAttribute('aria-disabled');
    }
    if (inputArea) inputArea.removeAttribute('aria-disabled');
  }

  function _setChatGated(on) {
    const area = _el('messages-area');
    if (!area) return;
    if (on) area.classList.add('cw-chat-gated');
    else area.classList.remove('cw-chat-gated', 'cw-unlocking');
  }

  /** Blur target for messages — keeps loading UI and gate banner sharp. */
  function ensureChatShell(area) {
    const mount = area || _el('messages-area');
    if (!mount) return null;
    let content = mount.querySelector('#' + CHAT_CONTENT_ID);
    if (!content) {
      content = document.createElement('div');
      content.id = CHAT_CONTENT_ID;
      content.className = 'cw-chat-content';
      const keepIds = new Set([OVERLAY_ID, 'ft-chat-transition']);
      const toMove = [];
      for (const ch of [...mount.children]) {
        if (keepIds.has(ch.id)) continue;
        if (ch.classList.contains('cw-gate-inline')) continue;
        if (ch.classList.contains('cw-chat-loading')) continue;
        if (ch.classList.contains('chat-transition-overlay')) continue;
        toMove.push(ch);
      }
      for (const ch of toMove) content.appendChild(ch);
      mount.appendChild(content);
    }
    return content;
  }

  function historyMount() {
    const area = _el('messages-area');
    if (!area) return null;
    return area.querySelector('#' + CHAT_CONTENT_ID) || area;
  }

  async function finishChannelUnlock(roomName, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const name = String(roomName || '').trim().toLowerCase();
    markVisitAcked(name);

    const inRoomSwitch = !!(window.State && String(State._roomSwitchInProgress || '').toLowerCase() === name);
    const unlockMs = inRoomSwitch ? 0 : UNLOCK_MS;

    const area = _el('messages-area');
    const overlay = _el(OVERLAY_ID);

    if (area && overlay && unlockMs > 0) {
      area.classList.add('cw-unlocking');
      overlay.classList.add('cw-gate-dismiss');
      await new Promise((r) => setTimeout(r, unlockMs));
    }

    _removeOverlay();

    if (inRoomSwitch) {
      // switchToRoom owns WS connect + history load after gate() resolves.
      return;
    }

    try {
      if (typeof clearChatTransition === 'function') clearChatTransition();
    } catch {}

    if (options.connectWs !== false) {
      try {
        if (typeof WS !== 'undefined' && WS.resetHistoryCache) WS.resetHistoryCache(name);
        if (typeof WS !== 'undefined' && WS.connect) WS.connect(name, { force: true });
      } catch {}
    }
  }

  function _preflightInline() {
    _lockComposer();
    _setChatGated(true);
    ensureChatShell();
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
      return { _httpStatus: r.status, _failed: true };
    } catch {
      return null;
    }
  }

  async function resolveCwMeta(roomName, knownCw) {
    const name = String(roomName || '').trim().toLowerCase();
    if (_cwEnabled(knownCw)) return knownCw;
    const local = _roomMeta(name)?.content_warning;
    if (_cwEnabled(local)) return local;
    const status = await _fetchStatus(name);
    if (status && _cwEnabled(status.content_warning)) return status.content_warning;
    return _mergeCwMeta(knownCw, local, status?.content_warning);
  }

  function _removeOverlay() {
    const el = _el(OVERLAY_ID);
    if (el) el.remove();
    _setChatGated(false);
    _unlockComposer();
  }

  function showDeclinedScreen(roomName) {
    _removeOverlay();
    const area = _el('messages-area');
    if (!area) return;
    const name = escapeHtml(roomName || 'this channel');
    area.innerHTML =
      '<div class="cw-declined-screen cw-declined-enter">' +
      '<div class="cw-declined-icon" aria-hidden="true">🔞</div>' +
      '<div class="cw-declined-title">18+ only</div>' +
      '<p class="cw-declined-text">You must be 18 or older to view <strong>#' + name + '</strong>. ' +
      'This channel is marked for mature audiences.</p></div>';
  }

  function _gateCardHtml(meta) {
    const flags = (meta && meta.flags) || [];
    const items = formatFlags(flags);
    const listHtml = items.length
      ? '<ul class="cw-gate-flags">' + items.map((it) =>
          '<li><strong>' + escapeHtml(it.label) + '</strong>' +
          (it.desc ? '<span>' + escapeHtml(it.desc) + '</span>' : '') + '</li>'
        ).join('') + '</ul>'
      : '<p class="cw-gate-flags-empty">This channel is marked for mature audiences.</p>';

    return (
      '<div class="cw-gate-card">' +
      '<div class="cw-gate-badge" aria-hidden="true">18+</div>' +
      '<h2 class="cw-gate-title" id="cw-gate-title">18+ content warning</h2>' +
      '<p class="cw-gate-lead">This channel may contain mature content such as:</p>' +
      listHtml +
      '<p class="cw-gate-confirm">Are you <strong>18 years of age or older</strong>?</p>' +
      '<div class="cw-gate-actions">' +
      '<button type="button" class="modal-btn secondary" id="cw-gate-back">I&rsquo;m under 18 — go back</button>' +
      '<button type="button" class="modal-btn primary" id="cw-gate-enter">' +
      '<span class="cw-gate-btn-label">I am 18 or older — enter</span></button>' +
      '</div></div>'
    );
  }

  function _showGate(roomName, meta) {
    return new Promise((resolve) => {
      _lockComposer();
      _setChatGated(true);

      const area = _el('messages-area');
      if (!area) {
        resolve(false);
        return;
      }
      ensureChatShell(area);
      const existing = _el(OVERLAY_ID);
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.className = 'cw-gate-inline';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'cw-gate-title');
      overlay.innerHTML =
        '<div class="cw-gate-inline-backdrop" aria-hidden="true"></div>' +
        '<div class="cw-gate-banner">' + _gateCardHtml(meta) + '</div>';
      area.appendChild(overlay);

      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey);
        resolve(ok);
      };

      const onBack = () => {
        _removeOverlay();
        finish(false);
      };

      const onEnter = async () => {
        const enterBtn = _el('cw-gate-enter');
        if (enterBtn?.disabled) return;
        if (enterBtn) {
          enterBtn.disabled = true;
          enterBtn.classList.add('cw-gate-enter-loading');
          const label = enterBtn.querySelector('.cw-gate-btn-label');
          if (label) label.textContent = 'Confirming…';
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
              enterBtn.classList.remove('cw-gate-enter-loading');
              const label = enterBtn.querySelector('.cw-gate-btn-label');
              if (label) label.textContent = 'I am 18 or older — enter';
            }
            return;
          }
          await finishChannelUnlock(roomName);
          finish(true);
        } catch {
          if (enterBtn) {
            enterBtn.disabled = false;
            enterBtn.classList.remove('cw-gate-enter-loading');
            const label = enterBtn.querySelector('.cw-gate-btn-label');
            if (label) label.textContent = 'I am 18 or older — enter';
          }
          if (window.UI && UI.showToast) UI.showToast('Network error', 'error');
        }
      };

      const onKey = (e) => {
        if (settled) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          void onEnter();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onBack();
        }
      };

      document.addEventListener('keydown', onKey);
      _el('cw-gate-back').onclick = onBack;
      _el('cw-gate-enter').onclick = () => { void onEnter(); };

      requestAnimationFrame(() => {
        try { _el('cw-gate-enter')?.focus(); } catch {}
      });
    });
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
  }

  async function prepareRoomEntry(roomName) {
    const name = String(roomName || '').trim().toLowerCase();
    if (!name || name.startsWith('dm:')) return;
    _visitAcked.delete(name);
    await forgetAck(name);
  }

  /** Call after switchToRoom commits and the user passes the gate. */
  function markVisitAcked(roomName) {
    const name = String(roomName || '').trim().toLowerCase();
    if (name && !name.startsWith('dm:')) _visitAcked.add(name);
  }

  async function _runGate(roomName, options) {
    const name = String(roomName || '').trim().toLowerCase();
    const knownCw = options.knownCw;
    if (_cwEnabled(knownCw)) patchRoomCwMeta(name, knownCw);

    if (_visitAcked.has(name) && !options.forceRecheck) return true;

    const localCw = _roomMeta(name)?.content_warning;
    const knownMarked = _cwEnabled(knownCw);
    const localMarked = _cwEnabled(localCw);

    if (knownMarked || localMarked) _preflightInline();

    const hasToken = await _waitForToken(options.tokenWaitMs || 8000);
    const displayMeta = _mergeCwMeta(knownCw, localCw);

    if (!hasToken) {
      if (knownMarked || localMarked) {
        return _showGate(name, displayMeta);
      }
      _removeOverlay();
      return true;
    }

    const status = await _fetchStatus(name);
    const cwMeta = _mergeCwMeta(knownCw, localCw, status?.content_warning);
    let resolvedMeta = cwMeta;
    if (!_cwEnabled(resolvedMeta)) {
      resolvedMeta = await resolveCwMeta(name, knownCw);
    }

    const metaMarked = _cwEnabled(resolvedMeta);
    let shouldGate = false;

    if (status && !status._failed) {
      if (!status.required && !options.forceRecheck) {
        _removeOverlay();
        markVisitAcked(name);
        return true;
      }
      shouldGate = !!status.required || (!!options.forceRecheck && metaMarked);
    } else if (status && status._failed) {
      shouldGate = knownMarked || localMarked || metaMarked;
    } else if (status === null) {
      shouldGate = knownMarked || localMarked || metaMarked;
    }

    if (!shouldGate) {
      _removeOverlay();
      return true;
    }

    _preflightInline();
    return _showGate(name, resolvedMeta);
  }

  function gate(roomName, opts) {
    const name = String(roomName || '').trim().toLowerCase();
    const options = opts || {};
    if (!name || name.startsWith('dm:')) return Promise.resolve(true);

    if (_gateInflight.has(name)) return _gateInflight.get(name);

    const p = _runGate(name, options).finally(() => {
      _gateInflight.delete(name);
    });
    _gateInflight.set(name, p);
    return p;
  }

  function _lockRoomUntilAck(room) {
    try {
      _preflightInline();
    } catch {}
  }

  function _handleWsGateEvent(data, forceRecheck) {
    const room = String((data && data.room) || '').trim().toLowerCase();
    if (!room) return;
    const cw = (data && data.content_warning) || {};
    if (forceRecheck && !cw.enabled) {
      _removeOverlay();
      return;
    }
    if (_cwEnabled(cw)) patchRoomCwMeta(room, cw);
    if (!_isViewingRoom(room)) return;
    if (_el(OVERLAY_ID)) return;
    if (_gateInflight.has(room)) return;
    _visitAcked.delete(room);
    _lockRoomUntilAck(room);
    void gate(room, { knownCw: cw, forceRecheck: !!forceRecheck }).then((ok) => {
      if (!ok) {
        try {
          if (window.Rooms && typeof Rooms.handleCwDecline === 'function') {
            void Rooms.handleCwDecline(room, { wasCurrentRoom: true });
          } else {
            showDeclinedScreen(room);
          }
        } catch {}
      }
    });
  }

  function handleWsUpdate(data) {
    _handleWsGateEvent(data, true);
  }

  function handleWsRequired(data) {
    _handleWsGateEvent(data, false);
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
    if (cw && cw.enabled) {
      patchRoomCwMeta(name, cw);
      _visitAcked.delete(name);
    }
  }

  window.ContentWarning = {
    gate,
    forgetAck,
    prepareRoomEntry,
    markVisitAcked,
    resolveCwMeta,
    patchRoomCwMeta,
    isCwRoom,
    patchMeta,
    formatFlags,
    handleWsUpdate,
    handleWsRequired,
    showDeclinedScreen,
    badgeHtml,
    unlockUi: _removeOverlay,
    finishChannelUnlock,
    ensureChatShell,
    historyMount,
    isGateActive,
  };
})();
