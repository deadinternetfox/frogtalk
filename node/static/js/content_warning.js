/**
 * content_warning.js — 18+ content warning gate for public channels.
 *
 * Ack persists per user+room on the server (survives relogin). Gate shows when
 * first entering a CW channel without ack, after leave/rejoin, or when CW flags change.
 */
(function () {
  'use strict';

  const OVERLAY_ID = 'ft-content-warning-gate';
  const CHAT_CONTENT_ID = 'cw-chat-content';
  const FLAG_META = {
    nudity: { label: 'Nudity / sexual content', desc: 'May contain nudity or sexual themes' },
    violence: { label: 'Violence', desc: 'May contain graphic violence' },
    extremism: { label: 'Extremist ideology', desc: 'May contain extremist or hateful ideology' },
    mature_themes: { label: 'Other mature themes', desc: 'May contain drugs, profanity, or other adult themes' },
  };

  /** In-flight gate promises only — server is source of truth for acks. */
  const _gateInflight = new Map();

  function _el(id) { return document.getElementById(id); }

  async function _cwFetch(url, method, body) {
    const verb = String(method || 'GET').toUpperCase();
    if (typeof apiFetch === 'function') {
      return apiFetch(url, verb, body == null ? null : body);
    }
    const headers = { 'X-Session-Token': (window.State && State.token) || '' };
    if (body != null && verb !== 'GET') {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(url, {
      method: verb,
      credentials: 'include',
      cache: 'no-store',
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
  }

  function _cwErrorMessage(resBody, fallback) {
    if (!resBody || typeof resBody !== 'object') return fallback;
    if (resBody.error) return String(resBody.error);
    if (resBody.detail) return String(resBody.detail);
    if (resBody.code === 'csrf_missing') return 'Session security token missing — refresh and try again';
    if (resBody.code === 'csrf_invalid') return 'Session expired — refresh and try again';
    return fallback;
  }

  function _resumeChannelAfterCwAck(roomName) {
    const room = String(roomName || '').trim().toLowerCase();
    if (!room || !window.State) return;
    if (String(State.currentRoom || '').toLowerCase() !== room) return;
    if (State.currentRoomType === 'dm') return;
    try { window.FtCompose?.beginChannelSwitch?.(room); } catch {}
    try {
      if (typeof WS !== 'undefined' && WS.connect) {
        WS.resetHistoryCache?.(room);
        WS.connect(room, { force: true });
      }
    } catch {}
  }

  function escapeHtml(s) {
    if (typeof esc === 'function') return esc(s);
    if (typeof UI !== 'undefined' && UI.escHtml) return UI.escHtml(s);
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
    if (!name || !window.State || !Array.isArray(State.rooms)) return;
    const row = State.rooms.find((r) => String(r.name || '').toLowerCase() === name);
    if (row) row.content_warning = cw || { enabled: false, flags: [] };
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
    if (String(State.currentRoom || '').toLowerCase() === room) return true;
    try {
      if (String(State._roomSwitchInProgress || '').toLowerCase() === room) return true;
    } catch {}
    return false;
  }

  function isGateActive(roomName) {
    if (_el(OVERLAY_ID)) return true;
    if (!roomName) return _gateInflight.size > 0;
    const name = String(roomName || '').trim().toLowerCase();
    return name && _gateInflight.has(name);
  }

  function resetSession() {
    _gateInflight.clear();
    try { _el(OVERLAY_ID)?.remove(); } catch {}
    _setChatGated(false);
    _unlockComposer();
  }

  function _lockComposer() {
    try { window.FtCompose?.captureFocus?.(); } catch {}
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
    try { window.FtCompose?.restoreFocus?.(); } catch {}
    try { window.FtCompose?.refresh?.(); } catch {}
  }

  function _setChatGated(on) {
    const area = _el('messages-area');
    if (!area) return;
    if (on) {
      area.classList.add('cw-chat-gated');
      try { ensureChatShell(area); } catch {}
      try { if (typeof ensureLoadingShieldStyle === 'function') ensureLoadingShieldStyle(); } catch {}
    } else {
      area.classList.remove('cw-chat-gated', 'cw-unlocking');
    }
  }

  function ensureChatShell(area) {
    const mount = area || _el('messages-area');
    if (!mount) return null;
    let content = mount.querySelector('#' + CHAT_CONTENT_ID);
    if (!content) {
      content = document.createElement('div');
      content.id = CHAT_CONTENT_ID;
      content.className = 'cw-chat-content';
      mount.appendChild(content);
    }
    const keepIds = new Set([OVERLAY_ID, 'ft-chat-transition']);
    for (const ch of [...mount.children]) {
      if (ch === content) continue;
      if (keepIds.has(ch.id)) continue;
      if (ch.classList.contains('cw-gate-inline')) continue;
      if (ch.classList.contains('cw-chat-loading')) continue;
      if (ch.classList.contains('chat-transition-overlay')) continue;
      content.appendChild(ch);
    }
    return content;
  }

  function historyMount() {
    const area = _el('messages-area');
    if (!area) return null;
    return ensureChatShell(area) || area.querySelector('#' + CHAT_CONTENT_ID) || area;
  }

  function _dismissGateOverlay() {
    const overlay = _el(OVERLAY_ID);
    if (!overlay) return Promise.resolve();
    const area = _el('messages-area');
    if (area) {
      area.classList.add('cw-unlocking');
      _setChatGated(false);
    }
    overlay.classList.add('cw-gate-dismiss');
    return new Promise((resolve) => {
      const done = () => {
        try { overlay.remove(); } catch {}
        try { area?.classList.remove('cw-unlocking', 'cw-chat-gated'); } catch {}
        resolve();
      };
      overlay.addEventListener('animationend', done, { once: true });
      setTimeout(done, 420);
    });
  }

  function _unlockUi(roomName) {
    return _dismissGateOverlay().then(() => {
      _unlockComposer();
      try {
        if (typeof clearChatTransition === 'function') {
          clearChatTransition({ finish: false });
        }
      } catch {}
      try { window.FtCompose?.beginChannelSwitch?.(roomName); } catch {}
      try { window.FtCompose?.refresh?.(); } catch {}
    });
  }

  function _removeOverlay() {
    void _dismissGateOverlay().then(() => {
      _unlockComposer();
    });
  }

  async function _fetchStatus(roomName) {
    const name = String(roomName || '').trim().toLowerCase();
    if (!name) return null;
    try {
      const r = await _cwFetch(
        '/api/rooms/' + encodeURIComponent(name) + '/content-warning/status?_=' + Date.now(),
      );
      if (r.ok) return r.json();
      return { _failed: true, _httpStatus: r.status };
    } catch {
      return null;
    }
  }

  async function _waitForToken(maxMs) {
    const limit = maxMs || 8000;
    const start = Date.now();
    while (Date.now() - start < limit) {
      if (window.State && State.token) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !!(window.State && State.token);
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

  function _buildGateCardEl(meta, roomName) {
    const card = document.createElement('div');
    card.className = 'cw-gate-card';

    const badge = document.createElement('div');
    badge.className = 'cw-gate-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = '18+';
    card.appendChild(badge);

    const title = document.createElement('h2');
    title.className = 'cw-gate-title';
    title.id = 'cw-gate-title';
    title.textContent = '18+ · #' + String(roomName || '').replace(/^#/, '');
    card.appendChild(title);

    const lead = document.createElement('p');
    lead.className = 'cw-gate-lead';
    lead.textContent = 'This channel may contain mature content such as:';
    card.appendChild(lead);

    const flags = (meta && meta.flags) || [];
    const items = formatFlags(flags);
    if (items.length) {
      const list = document.createElement('ul');
      list.className = 'cw-gate-flags';
      items.forEach((it) => {
        const li = document.createElement('li');
        const strong = document.createElement('strong');
        strong.textContent = it.label;
        li.appendChild(strong);
        if (it.desc) {
          const span = document.createElement('span');
          span.textContent = it.desc;
          li.appendChild(span);
        }
        list.appendChild(li);
      });
      card.appendChild(list);
    } else {
      const empty = document.createElement('p');
      empty.className = 'cw-gate-flags-empty';
      empty.textContent = 'This channel is marked for mature audiences.';
      card.appendChild(empty);
    }

    const confirm = document.createElement('p');
    confirm.className = 'cw-gate-confirm';
    confirm.appendChild(document.createTextNode('Are you '));
    const strongAge = document.createElement('strong');
    strongAge.textContent = '18 years of age or older';
    confirm.appendChild(strongAge);
    confirm.appendChild(document.createTextNode('?'));
    card.appendChild(confirm);

    const actions = document.createElement('div');
    actions.className = 'cw-gate-actions';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'modal-btn secondary';
    backBtn.id = 'cw-gate-back';
    backBtn.textContent = 'I\u2019m under 18 \u2014 go back';
    actions.appendChild(backBtn);

    const enterBtn = document.createElement('button');
    enterBtn.type = 'button';
    enterBtn.className = 'modal-btn primary';
    enterBtn.id = 'cw-gate-enter';
    const enterLabel = document.createElement('span');
    enterLabel.className = 'cw-gate-btn-label';
    enterLabel.textContent = 'I am 18 or older \u2014 enter';
    enterBtn.appendChild(enterLabel);
    actions.appendChild(enterBtn);

    card.appendChild(actions);
    return card;
  }

  function _showGate(roomName, meta) {
    return new Promise((resolve) => {
      try {
        if (typeof clearChatTransition === 'function') clearChatTransition({ finish: false });
      } catch {}

      _lockComposer();
      _setChatGated(true);

      const area = _el('messages-area');
      if (!area) {
        resolve(false);
        return;
      }
      ensureChatShell(area);
      try { _el(OVERLAY_ID)?.remove(); } catch {}

      const overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.className = 'cw-gate-inline';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'cw-gate-title');

      const backdrop = document.createElement('div');
      backdrop.className = 'cw-gate-inline-backdrop';
      backdrop.setAttribute('aria-hidden', 'true');
      overlay.appendChild(backdrop);

      const ambient = document.createElement('div');
      ambient.className = 'ch-transition-ambient cw-gate-ambient';
      ambient.setAttribute('aria-hidden', 'true');
      ambient.innerHTML = '<span class="ch-orb o1"></span><span class="ch-orb o2"></span><span class="ch-orb o3"></span>';
      overlay.appendChild(ambient);

      const banner = document.createElement('div');
      banner.className = 'cw-gate-banner';
      banner.appendChild(_buildGateCardEl(meta, roomName));
      overlay.appendChild(banner);
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
          const r = await _cwFetch(
            '/api/rooms/' + encodeURIComponent(roomName) + '/content-warning/ack',
            'POST',
            { confirm: true },
          );
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            if (window.UI && UI.showToast) {
              UI.showToast(_cwErrorMessage(err, 'Could not confirm age'), 'error');
            }
            if (enterBtn) {
              enterBtn.disabled = false;
              enterBtn.classList.remove('cw-gate-enter-loading');
              const labelEl = enterBtn.querySelector('.cw-gate-btn-label');
              if (labelEl) labelEl.textContent = 'I am 18 or older — enter';
            }
            return;
          }
          await _unlockUi(roomName);
          finish(true);
        } catch {
          if (enterBtn) {
            enterBtn.disabled = false;
            enterBtn.classList.remove('cw-gate-enter-loading');
            const labelEl = enterBtn.querySelector('.cw-gate-btn-label');
            if (labelEl) labelEl.textContent = 'I am 18 or older — enter';
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

  async function resolveCwMeta(roomName, knownCw) {
    const name = String(roomName || '').trim().toLowerCase();
    if (_cwEnabled(knownCw)) return knownCw;
    const local = _roomMeta(name)?.content_warning;
    if (_cwEnabled(local)) return local;
    const status = await _fetchStatus(name);
    if (status && _cwEnabled(status.content_warning)) return status.content_warning;
    return _mergeCwMeta(knownCw, local, status?.content_warning);
  }

  async function _runGate(roomName, options) {
    const name = String(roomName || '').trim().toLowerCase();
    const knownCw = options.knownCw;
    if (_cwEnabled(knownCw)) patchRoomCwMeta(name, knownCw);

    const hasToken = await _waitForToken(options.tokenWaitMs || 8000);
    const fallbackMeta = _mergeCwMeta(knownCw, _roomMeta(name)?.content_warning);
    if (!hasToken) {
      if (_cwEnabled(fallbackMeta)) {
        return _showGate(name, fallbackMeta);
      }
      _removeOverlay();
      return true;
    }

    const status = await _fetchStatus(name);
    if (status && !status._failed) {
      if (status.content_warning) patchRoomCwMeta(name, status.content_warning);
      if (!status.required) {
        _removeOverlay();
        return true;
      }
      const meta = _mergeCwMeta(knownCw, _roomMeta(name)?.content_warning, status.content_warning);
      return _showGate(name, meta);
    }

    // Status unavailable — only gate if we know the room is CW-marked locally.
    if (!_cwEnabled(fallbackMeta)) {
      _removeOverlay();
      return true;
    }
    return _showGate(name, fallbackMeta);
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

  async function forgetAck(roomName) {
    const name = String(roomName || '').trim().toLowerCase();
    if (!name || name.startsWith('dm:')) return;
    try {
      await _cwFetch('/api/rooms/' + encodeURIComponent(name) + '/content-warning/forget', 'POST');
    } catch {}
  }

  function markVisitAcked(_roomName) {
    /* Server persists acks — client noop kept for API compat. */
  }

  function _handleWsGateEvent(data, invalidateClient) {
    const room = String((data && data.room) || '').trim().toLowerCase();
    if (!room) return;
    const cw = (data && data.content_warning) || {};
    if (invalidateClient && !cw.enabled) {
      _removeOverlay();
      return;
    }
    if (_cwEnabled(cw)) patchRoomCwMeta(room, cw);
    if (!_isViewingRoom(room)) return;
    if (_el(OVERLAY_ID)) return;
    if (_gateInflight.has(room)) return;
    void gate(room, { knownCw: cw }).then((ok) => {
      if (!ok) {
        try {
          if (window.Rooms && typeof Rooms.handleCwDecline === 'function') {
            void Rooms.handleCwDecline(room, { wasCurrentRoom: true });
          } else {
            showDeclinedScreen(room);
          }
        } catch {}
      } else {
        _resumeChannelAfterCwAck(room);
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
    return '<span class="ch-cw-badge" title="' + escapeHtml(labels) + '">18+</span>';
  }

  function patchMeta(roomName, cw) {
    const name = String(roomName || '').trim().toLowerCase();
    if (!name) return;
    patchRoomCwMeta(name, cw);
  }

  window.ContentWarning = {
    gate,
    forgetAck,
    resetSession,
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
    unlockUi: _unlockUi,
    ensureChatShell,
    historyMount,
    isGateActive,
  };
})();
