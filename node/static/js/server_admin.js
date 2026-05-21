(() => {
  const loginScreen = document.getElementById('login-screen');
  const app = document.getElementById('app');
  const loginMsg = document.getElementById('login-msg');
  const actionMsg = document.getElementById('action-msg');
  const statsGrid = document.getElementById('stats-grid');
  const resourceGrid = document.getElementById('resource-grid');
  const nodeSummaryGrid = document.getElementById('node-summary-grid');
  const onlineUsersBody = document.getElementById('online-users-body');
  const nodesBody = document.getElementById('nodes-body');
  const nodeMsg = document.getElementById('node-msg');
  const latencyBadge = document.getElementById('latency-badge');
  const privacyBadge = document.getElementById('privacy-badge');
  const federationBadge = document.getElementById('federation-badge');
  const updatedBadge = document.getElementById('updated-badge');
  const frogTrigger = document.getElementById('node-frog-trigger');
  const easterEnabled = document.getElementById('easter-enabled');
  const easterTitle = document.getElementById('easter-title');
  const easterEditor = document.getElementById('easter-editor');
  const easterMsg = document.getElementById('easter-msg');
  const easterPreview = document.getElementById('easter-preview');
  const easterPreviewBtn = document.getElementById('easter-preview-btn');
  const easterSaveBtn = document.getElementById('easter-save-btn');
  const easterUploadBtn = document.getElementById('easter-upload-btn');
  const easterUploadInput = document.getElementById('easter-upload-input');
  const bugsBody = document.getElementById('bugs-body');
  const bugsStats = document.getElementById('bugs-stats');
  const bugsMsg = document.getElementById('bugs-msg');
  const bugsRefreshBtn = document.getElementById('bugs-refresh');
  const bugsFilterStatus = document.getElementById('bugs-filter-status');
  const bugsFilterSeverity = document.getElementById('bugs-filter-severity');
  const channelActiveDays = document.getElementById('channel-active-days');
  const channelAutoDeleteDays = document.getElementById('channel-auto-delete-days');
  const saveChannelRetentionBtn = document.getElementById('save-channel-retention-btn');
  const channelRetentionStatus = document.getElementById('channel-retention-status');
  const channelRetentionLastSaved = document.getElementById('channel-retention-last-saved');
  const blockTorPeers = document.getElementById('block-tor-peers');
  const saveFederationPolicyBtn = document.getElementById('save-federation-policy-btn');
  const federationPolicyStatus = document.getElementById('federation-policy-status');
  let easterEggConfig = { enabled: false, title: 'Frog signal', html: '', updated_at: '' };
  let easterEggLoaded = false;
  let easterEggDirty = false;
  let frogTapCount = 0;
  let frogTapTimer = null;
  let retentionBaseline = '';
  let federationPolicyBaseline = '';

  function retentionSig() {
    const d = Math.max(1, Number(channelActiveDays?.value || 30) || 30);
    const a = Math.max(0, Number(channelAutoDeleteDays?.value || 0) || 0);
    return `${d}:${a}`;
  }

  function setRetentionStatus(state, text) {
    if (!channelRetentionStatus) return;
    channelRetentionStatus.className = `status-pill state-${state}`;
    channelRetentionStatus.textContent = text || '';
  }

  function setRetentionSavingState(isSaving) {
    if (!saveChannelRetentionBtn) return;
    saveChannelRetentionBtn.disabled = !!isSaving;
    saveChannelRetentionBtn.classList.toggle('is-loading', !!isSaving);
    saveChannelRetentionBtn.textContent = isSaving ? 'Saving Channel Timing…' : 'Save Channel Timing';
  }

  function federationPolicySig() {
    return blockTorPeers?.checked ? '1' : '0';
  }

  function setFederationPolicyStatus(state, text) {
    if (!federationPolicyStatus) return;
    federationPolicyStatus.className = `status-pill state-${state}`;
    federationPolicyStatus.textContent = text || '';
  }

  function refreshFederationPolicyDirtyUi() {
    const dirty = federationPolicySig() !== federationPolicyBaseline;
    if (dirty) {
      setFederationPolicyStatus('dirty', 'Unsaved local changes');
    } else if (!federationPolicyStatus?.classList.contains('state-saved')) {
      setFederationPolicyStatus('saved', 'No local changes');
    }
  }

  function syncFederationPolicy(policy) {
    const block = !!(policy && policy.block_tor_peers);
    if (blockTorPeers) blockTorPeers.checked = block;
    federationPolicyBaseline = federationPolicySig();
    setFederationPolicyStatus('saved', 'Loaded from this node');
  }

  async function saveFederationPolicy() {
    if (!saveFederationPolicyBtn) return;
    saveFederationPolicyBtn.disabled = true;
    saveFederationPolicyBtn.classList.add('is-loading');
    saveFederationPolicyBtn.textContent = 'Saving Federation Policy…';
    setFederationPolicyStatus('saving', 'Saving to this node…');
    try {
      const payload = await api('/api/server-admin/federation-policy', {
        method: 'PUT',
        body: JSON.stringify({ block_tor_peers: !!blockTorPeers?.checked }),
      });
      syncFederationPolicy(payload.federation_policy || {});
      const n = Number(payload.tor_peers_disabled || 0);
      const extra = n > 0 ? ` Disabled ${n} Tor peer${n === 1 ? '' : 's'}.` : '';
      setFederationPolicyStatus('saved', 'Saved on this node');
      setActionMessage(`Federation policy saved.${extra}`);
      await refreshNodes();
    } catch (e) {
      setFederationPolicyStatus('error', 'Save failed');
      setActionMessage(e.message, true);
    } finally {
      saveFederationPolicyBtn.disabled = false;
      saveFederationPolicyBtn.classList.remove('is-loading');
      saveFederationPolicyBtn.textContent = 'Save Federation Policy';
    }
  }

  function refreshRetentionDirtyUi() {
    const dirty = retentionSig() !== retentionBaseline;
    if (dirty) {
      setRetentionStatus('dirty', 'Unsaved local changes');
    } else if (!channelRetentionStatus?.classList.contains('state-saved')) {
      setRetentionStatus('saved', 'No local changes');
    }
  }

  function escHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function setLoginMessage(msg, isError = false) {
    loginMsg.textContent = msg || '';
    loginMsg.style.color = isError ? '#ff9f9f' : '#93ab9a';
  }

  function setActionMessage(msg, isError = false) {
    actionMsg.textContent = msg || '';
    actionMsg.style.color = isError ? '#ff9f9f' : '#93ab9a';
  }

  function setNodeMessage(msg, isError = false) {
    const line = String(msg || '').trim();
    if (!line) return;
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    nodeMsg.innerHTML = `
      <div class="node-status-line ${isError ? 'error' : 'ok'}">
        <span class="node-status-time">${escHtml(stamp)}</span>
        <span class="node-status-text">${escHtml(line)}</span>
      </div>
    `;
  }

  function setEasterMessage(msg, isError = false) {
    easterMsg.textContent = msg || '';
    easterMsg.style.color = isError ? '#ff9f9f' : '#93ab9a';
  }

  function openEasterFilePicker() {
    if (!easterUploadInput) {
      setEasterMessage('Media picker is unavailable on this page.', true);
      return;
    }
    easterUploadInput.value = '';
    try {
      if (typeof easterUploadInput.showPicker === 'function') {
        easterUploadInput.showPicker();
        return;
      }
    } catch {}
    try {
      easterUploadInput.click();
    } catch {
      setEasterMessage('Could not open the media picker in this browser.', true);
    }
  }

  function _sessionToken() {
    try {
      if (window.State && State.token) return String(State.token);
      return localStorage.getItem('fc_token') || '';
    } catch {
      return '';
    }
  }

  function _readCsrfCookie() {
    // FrogTalk session CSRF (``ft_csrf``) — bound to HttpOnly ``ft_session``.
    const m = (document.cookie || '').match(/(?:^|;\s*)ft_csrf=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    // Legacy WebUI fallback (env-only emergency login).
    const legacy = (document.cookie || '').match(/(?:^|;\s*)frogtalk_admin_csrf=([^;]+)/);
    return legacy ? decodeURIComponent(legacy[1]) : '';
  }

  async function api(path, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const tok = _sessionToken();
    if (tok) headers['X-Session-Token'] = tok;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrf = _readCsrfCookie();
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }
    const res = await fetch(path, {
      credentials: 'include',
      headers,
      ...opts,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  function insertHtmlAtCursor(html) {
    const safeHtml = String(html || '');
    if (!safeHtml || !easterEditor) return;
    easterEditor.focus();
    try {
      document.execCommand('insertHTML', false, safeHtml);
    } catch {
      easterEditor.innerHTML += safeHtml;
    }
    easterEggDirty = true;
    updateEditorEmptyState();
    renderEasterPreview();
  }

  function applyEditorCommand(command) {
    if (!easterEditor) return;
    easterEditor.focus();
    if (command === 'h2') {
      document.execCommand('formatBlock', false, 'h2');
      return;
    }
    if (command === 'blockquote') {
      document.execCommand('formatBlock', false, 'blockquote');
      return;
    }
    if (command === 'ul') {
      document.execCommand('insertUnorderedList');
      return;
    }
    if (command === 'link') {
      const url = window.prompt('Link URL');
      if (!url) return;
      document.execCommand('createLink', false, url.trim());
      easterEggDirty = true;
      return;
    }
    if (command === 'clear') {
      easterEditor.innerHTML = '';
      easterEggDirty = true;
      updateEditorEmptyState();
      renderEasterPreview();
      return;
    }
    document.execCommand(command, false);
    easterEggDirty = true;
    updateEditorEmptyState();
    renderEasterPreview();
  }

  function renderEasterPreview() {
    if (!easterPreview) return;
    const title = (easterTitle?.value || 'Frog signal').trim() || 'Frog signal';
    const html = (easterEditor?.innerHTML || '').trim() || 'No popup content configured yet.';
    easterPreview.innerHTML = `
      <div class="easter-preview-title">${escHtml(title)}</div>
      <div class="easter-preview-body">${html}</div>
    `;
  }

  function updateEditorEmptyState() {
    if (!easterEditor) return;
    const text = (easterEditor.textContent || '').replace(/\u00a0/g, ' ').trim();
    const html = (easterEditor.innerHTML || '').trim().toLowerCase();
    const effectivelyEmpty = !text && (html === '' || html === '<br>' || html === '<div><br></div>' || html === '<p><br></p>');
    easterEditor.classList.toggle('is-empty', effectivelyEmpty);
  }

  function pulseEasterPreview() {
    if (!easterPreview) return;
    easterPreview.classList.remove('preview-pulse');
    void easterPreview.offsetWidth;
    easterPreview.classList.add('preview-pulse');
  }

  function syncEasterEditor(payload) {
    easterEggConfig = {
      enabled: !!payload?.enabled,
      title: payload?.title || 'Frog signal',
      html: payload?.html || '',
      updated_at: payload?.updated_at || '',
    };
    if (easterEnabled) easterEnabled.checked = easterEggConfig.enabled;
    if (easterTitle) easterTitle.value = easterEggConfig.title;
    if (easterEditor) easterEditor.innerHTML = easterEggConfig.html || '';
    easterEggLoaded = true;
    easterEggDirty = false;
    updateEditorEmptyState();
    renderEasterPreview();
  }

  async function loadEasterEgg(force = false) {
    if (easterEggDirty && !force) return;
    try {
      const payload = await api('/api/server-admin/easter-egg');
      syncEasterEditor(payload);
    } catch (e) {
      setEasterMessage(e.message, true);
    }
  }

  async function saveEasterEgg() {
    setEasterMessage('Saving popup...');
    try {
      const payload = await api('/api/server-admin/easter-egg', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: !!easterEnabled?.checked,
          title: easterTitle?.value || '',
          html: easterEditor?.innerHTML || '',
        }),
      });
      syncEasterEditor(payload);
      setEasterMessage('Node popup saved.');
    } catch (e) {
      setEasterMessage(e.message, true);
    }
  }

  function closeEasterOverlay() {
    document.getElementById('node-easter-overlay')?.remove();
  }

  async function openEasterOverlay(useEditorState = false) {
    closeEasterOverlay();
    let payload = null;
    if (useEditorState) {
      payload = {
        enabled: !!easterEnabled?.checked,
        title: easterTitle?.value || 'Frog signal',
        html: easterEditor?.innerHTML || '',
      };
    } else {
      try {
        payload = await api('/api/server-admin/easter-egg');
      } catch (e) {
        setEasterMessage(e.message, true);
        return;
      }
    }
    if (!payload?.enabled && !useEditorState) {
      setEasterMessage('Popup is disabled for this node.', true);
      return;
    }
    const overlay = document.createElement('div');
    overlay.id = 'node-easter-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:14050;background:rgba(4,8,5,.76);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:18px';
    overlay.innerHTML = `
      <div style="width:min(720px,96vw);max-height:min(84vh,820px);overflow:auto;border-radius:24px;border:1px solid rgba(86,209,109,.25);background:linear-gradient(160deg,rgba(15,27,20,.98),rgba(7,12,9,.98));box-shadow:0 32px 90px rgba(0,0,0,.55);position:relative;padding:22px;">
        <button type="button" id="node-easter-close" style="position:absolute;top:14px;right:14px;border:none;background:#13241a;color:#dbeadf;width:38px;height:38px;border-radius:12px;cursor:pointer;font-size:18px">✕</button>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
          <div style="width:54px;height:54px;border-radius:18px;background:linear-gradient(135deg,#1c422a,#0c170f);display:flex;align-items:center;justify-content:center;font-size:28px;box-shadow:0 12px 30px rgba(0,0,0,.28)">🐸</div>
          <div>
            <div style="font-size:24px;font-weight:800;color:#f1fff5">${escHtml(payload.title || 'Frog signal')}</div>
            <div style="font-size:12px;color:#96b49f">Secret node popup</div>
          </div>
        </div>
        <div style="color:#deede2;line-height:1.7" class="easter-preview-body">${payload.html || '<p>No content configured.</p>'}</div>
      </div>
    `;
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeEasterOverlay();
    });
    document.body.appendChild(overlay);
    overlay.querySelector('#node-easter-close')?.addEventListener('click', closeEasterOverlay);
    pulseEasterPreview();
    setEasterMessage('Preview opened.');
  }

  async function previewEasterPopup() {
    renderEasterPreview();
    pulseEasterPreview();
    try {
      await openEasterOverlay(true);
    } catch (error) {
      setEasterMessage((error && error.message) || 'Could not open preview popup.', true);
    }
  }

  function handleFrogTap() {
    frogTapCount += 1;
    clearTimeout(frogTapTimer);
    frogTapTimer = setTimeout(() => { frogTapCount = 0; }, 2600);
    if (frogTapCount >= 7) {
      frogTapCount = 0;
      openEasterOverlay(false).catch((e) => setEasterMessage(e.message, true));
    }
  }

  async function uploadEasterAsset(file) {
    if (!file) return;
    setEasterMessage(`Uploading ${file.name}...`);
    try {
      const form = new FormData();
      form.append('media', file);
      const res = await fetch('/api/server-admin/easter-egg/upload', {
        method: 'POST',
        credentials: 'include',
        headers: (() => {
          const h = {};
          const csrf = _readCsrfCookie();
          if (csrf) h['X-CSRF-Token'] = csrf;
          return h;
        })(),
        body: form,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Upload failed');
      if (payload.tag === 'img') {
        insertHtmlAtCursor(`<img src="${payload.media_data}" alt="${escHtml(payload.filename || 'image')}">`);
      } else if (payload.tag === 'video') {
        insertHtmlAtCursor(`<video controls playsinline src="${payload.media_data}"></video>`);
      } else {
        insertHtmlAtCursor(`<audio controls src="${payload.media_data}"></audio>`);
      }
      setEasterMessage('Media inserted into popup.');
    } catch (e) {
      setEasterMessage(e.message, true);
    }
  }

  function statCard(label, value, meta = '') {
    return `
      <div class="card">
        <div class="card-label">${label}</div>
        <div class="card-value">${value}</div>
        <div class="card-meta">${meta}</div>
      </div>
    `;
  }

  function summaryCard(label, value, meta = '', tone = '') {
    return `
      <div class="card summary-card ${tone}">
        <div class="card-label">${label}</div>
        <div class="card-value">${value}</div>
        <div class="card-meta">${meta}</div>
      </div>
    `;
  }

  function fmtWhen(value) {
    if (!value) return 'n/a';
    let date = null;
    if (typeof value === 'number' || /^\d+$/.test(String(value))) {
      const numeric = Number(value);
      date = new Date(numeric < 2_000_000_000 ? numeric * 1000 : numeric);
    } else {
      date = new Date(value);
    }
    if (!date || Number.isNaN(date.getTime())) return 'n/a';
    const deltaSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (deltaSec < 60) return `${deltaSec}s ago`;
    if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
    if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
    return `${Math.floor(deltaSec / 86400)}d ago`;
  }

  function renderServerMeta(payload) {
    const server = payload.server || {};
    const privacyText = server.privacy_mode === 'tor'
      ? `Privacy: Tor-routed · ${server.public_endpoint || 'hidden onion endpoint'}`
      : `Privacy: Direct route · ${server.public_endpoint || 'hidden endpoint'}`;
    privacyBadge.textContent = privacyText;
    privacyBadge.className = `badge ${server.privacy_mode === 'tor' ? 'success' : 'warn'}`;
    federationBadge.textContent = `Node: ${server.display_name || 'FrogTalk Node'} · ${server.server_id || 'local'}`;
    const lastSync = server.directory_last_sync ? `Directory sync ${fmtWhen(server.directory_last_sync)}` : 'Directory sync pending';
    updatedBadge.textContent = `Updated ${fmtWhen(payload.timestamp)} · ${lastSync}`;
  }

  function syncChannelRetention(payload) {
    const retention = payload || {};
    if (channelActiveDays) channelActiveDays.value = String(retention.directory_active_days ?? 30);
    if (channelAutoDeleteDays) channelAutoDeleteDays.value = String(retention.auto_delete_days ?? 0);
    retentionBaseline = retentionSig();
    setRetentionStatus('saved', 'Loaded from this node');
  }

  async function saveChannelRetention() {
    const directoryActiveDays = Math.max(1, Number(channelActiveDays?.value || 30) || 30);
    const autoDeleteDays = Math.max(0, Number(channelAutoDeleteDays?.value || 0) || 0);
    setRetentionSavingState(true);
    setRetentionStatus('saving', 'Saving to this node…');
    try {
      const payload = await api('/api/server-admin/channel-retention', {
        method: 'PUT',
        body: JSON.stringify({
          directory_active_days: directoryActiveDays,
          auto_delete_days: autoDeleteDays,
        }),
      });
      syncChannelRetention(payload.channel_retention || {});
      retentionBaseline = retentionSig();
      setRetentionStatus('saved', 'Saved on this node');
      if (channelRetentionLastSaved) {
        channelRetentionLastSaved.textContent = `Last saved: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      }
      setActionMessage('Channel timing saved on this node. Federation peers keep their own local timing.');
    } catch (e) {
      setRetentionStatus('error', 'Save failed on this node');
      setActionMessage(e.message, true);
      throw e;
    } finally {
      setRetentionSavingState(false);
    }
  }

  function renderStats(payload, pingMs) {
    const db = payload.db || {};
    const ws = payload.ws || {};
    // Prefer the human-admin count (excludes the seed `admin` system
    // account used internally for moderation audit attribution); fall
    // back to the raw count for older server builds that don't return
    // the new field.
    const adminCount = (db.users_admin_human != null) ? db.users_admin_human : (db.users_admin ?? 0);
    const adminLabel = `${adminCount} ${adminCount === 1 ? 'admin' : 'admins'}`;
    // Sessions: report the number of tokens that have actually been
    // used in the last 7 days (reality), with the long-lived token
    // pool — most of which are dormant logins from devices that never
    // came back — relegated to the sub-label so it's still visible
    // but doesn't dominate the headline number.
    const sessRecent = db.sessions_recent_7d ?? db.sessions_active ?? 0;
    const sessUsersRecent = db.sessions_users_recent_7d ?? 0;
    const sessTotal = db.sessions_active ?? 0;
    const sessSub = `${sessUsersRecent} ${sessUsersRecent === 1 ? 'user' : 'users'} · ${sessTotal} total tokens`;
    statsGrid.innerHTML = [
      statCard('Total Users', db.users_total ?? 0, adminLabel),
      statCard('Active Sessions (7d)', sessRecent, sessSub),
      statCard('WS Connections', ws.ws_connections ?? 0, `${ws.online_users ?? 0} users online`),
      statCard('Messages / min', db.msg_per_min_5m ?? 0, 'Rolling 5-minute avg'),
      statCard('Rooms', db.rooms_total ?? 0, `${ws.active_rooms ?? 0} with live sockets`),
      statCard('DM Channels', db.dm_channels_total ?? 0, `${db.dm_messages_total ?? 0} DM messages total`),
      statCard('Messages (1h)', db.messages_last_1h ?? 0, `${db.messages_total ?? 0} room messages total`),
      statCard('Latency', `${pingMs} ms`, 'Dashboard round-trip')
    ].join('');
  }

  function fmtBytes(bytes) {
    const n = Number(bytes || 0);
    if (!n || n < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = n;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx += 1;
    }
    return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
  }

  function fmtUptime(sec) {
    const s = Number(sec || 0);
    if (!s) return 'n/a';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function renderResources(payload) {
    const r = payload.resources || {};
    const cpu = r.cpu || {};
    const mem = r.memory || {};
    const disk = r.disk || {};
    resourceGrid.innerHTML = [
      statCard('CPU (1m)', `${cpu.usage_pct_1m ?? '--'}%`, `Load: ${cpu.load1 ?? '--'} / ${cpu.load5 ?? '--'} / ${cpu.load15 ?? '--'}`),
      statCard('CPU Cores', cpu.cores ?? '--', 'Logical cores'),
      statCard('Memory', `${mem.used_pct ?? '--'}%`, `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}`),
      statCard('Disk /', `${disk.used_pct ?? '--'}%`, `${fmtBytes(disk.used)} / ${fmtBytes(disk.total)}`),
      statCard('Uptime', fmtUptime(r.uptime_sec), 'Host uptime'),
    ].join('');
  }

  function fmtRelative(ts) {
    const t = Number(ts || 0);
    if (!t) return 'never';
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - t);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function renderImageboardSection(payload) {
    const grid = document.getElementById('imageboard-stats-grid');
    const idEl = document.getElementById('imageboard-identity');
    const msg = document.getElementById('imageboard-msg');
    const peersEl = document.getElementById('imageboard-peers');
    if (!grid || !idEl) return;
    if (!payload || !payload.available) {
      grid.innerHTML = '';
      idEl.textContent = 'Imageboard data not found on this node.';
      if (peersEl) peersEl.innerHTML = '';
      if (msg) msg.textContent = payload && payload.data_dir ? `Expected at ${payload.data_dir}` : '';
      return;
    }
    const id = payload.identity || {};
    const s = payload.stats || {};
    const torTag = id.tor_only ? ' · 🧅 Tor-only' : '';
    const lockTag = id.board_locked ? ' · 🔒 LOCKED' : '';
    const topicTag = id.topic ? ` <span class="ib-pill-topic" style="color:#6baf6b;">#${escHtml(id.topic)}</span>` : '';
    const fed = id.federation_enabled ? `${s.federated_peers || 0} federated peer(s)` : 'federation off';
    idEl.innerHTML = `<b>${escHtml(id.title || '/board/')}</b>${id.node_id ? ` <span style="color:var(--muted)">@${escHtml(id.node_id)}</span>` : ''}${topicTag}${torTag}${lockTag}${id.subtitle ? ` — ${escHtml(id.subtitle)}` : ''} <span style="color:var(--muted)">· ${escHtml(fed)}</span>`;
    grid.innerHTML = [
      statCard('Threads', s.threads ?? 0, `${s.threads_24h ?? 0} new in 24h`),
      statCard('Posts', s.posts ?? 0, `${s.posts_24h ?? 0} new in 24h`),
      statCard('Total Views', Number(s.views || 0).toLocaleString(), 'Lifetime (incl. pruned)'),
      statCard('Media Items', s.media ?? 0, `${s.pending_media ?? 0} pending approval`),
      statCard('Approval Queue', s.approval_queue ?? 0, 'Awaiting moderator'),
      statCard('Active Bans', s.active_bans ?? 0, 'Currently in effect'),
      statCard('Chat Messages', s.chat_messages ?? 0, id.chat_enabled ? 'Live chat enabled' : 'Live chat disabled'),
      statCard('Last Post', fmtRelative(s.last_post_ts), s.sticky_threads ? `${s.sticky_threads} sticky · ${s.locked_threads || 0} locked` : `${s.locked_threads || 0} locked`),
    ].join('');

    // Hydrate the identity editor (only when it hasn't been touched, so we
    // don't trample in-progress typing on the next auto-refresh tick).
    const titleI = document.getElementById('ibid-title');
    const subI = document.getElementById('ibid-subtitle');
    const topicI = document.getElementById('ibid-topic');
    const nodeI = document.getElementById('ibid-node');
    [['_orig', titleI, id.title], ['_orig', subI, id.subtitle], ['_orig', topicI, id.topic], ['_orig', nodeI, id.node_id]].forEach(([_, el, v]) => {
      if (!el) return;
      const fresh = String(v || '');
      if (el.dataset.dirty !== '1' && el.value !== fresh) el.value = fresh;
      el.dataset.orig = fresh;
    });

    // Federated peers list — surfaces "both boards" right here in server admin.
    if (peersEl) {
      const peers = Array.isArray(payload.peers) ? payload.peers : [];
      if (!peers.length) {
        peersEl.innerHTML = '<span style="color:var(--muted);font-size:12px;">No peers configured. Add them at /board/admin → Federation.</span>';
      } else {
        peersEl.innerHTML = peers.map((p) => {
          const tor = p.tor_only ? '<span style="color:#ffaa33;">🧅 </span>' : '';
          const t = p.topic ? `<span style="color:#6baf6b;"> #${escHtml(p.topic)}</span>` : '';
          const seen = p.last_seen ? ` · seen ${escHtml(fmtRelative(p.last_seen))}` : '';
          const isBlocked = !!p.blocked;
          const wrapStyle = `display:inline-flex;gap:6px;align-items:center;padding:4px 4px 4px 10px;border:1px solid ${isBlocked ? '#7a3a3a' : 'var(--border,#333)'};border-radius:999px;background:${isBlocked ? 'rgba(180,60,60,.08)' : 'rgba(255,255,255,.02)'};font-size:12px;${isBlocked ? 'opacity:.6;' : ''}`;
          const blockBtn = `<button type="button" data-peer-block="${escHtml(p.node_id || '')}" data-blocked="${isBlocked ? '1' : '0'}" title="${isBlocked ? 'Unblock — show in nav' : 'Block — hide from /board/ nav'}" style="margin-left:4px;padding:3px 8px;border:1px solid ${isBlocked ? '#7a3a3a' : '#3a5544'};background:${isBlocked ? 'rgba(180,60,60,.18)' : 'rgba(127,210,167,.08)'};color:${isBlocked ? '#ff9b9b' : '#7fd2a7'};border-radius:999px;font-size:11px;cursor:pointer;">${isBlocked ? 'Unblock' : 'Block'}</button>`;
          const link = `<a href="${escHtml(p.url || '#')}" target="_blank" rel="noopener" style="display:inline-flex;gap:6px;align-items:center;text-decoration:none;color:var(--text,#eee);">${tor}<b>${escHtml(p.title || p.url || 'peer')}</b><span style="color:var(--muted);">@${escHtml(p.node_id || '?')}</span>${t}<span style="color:var(--muted);font-size:11px;">${seen}</span>${isBlocked ? '<span style="color:#ff9b9b;font-size:11px;"> · blocked</span>' : ''}</a>`;
          return `<span style="${wrapStyle}">${link}${blockBtn}</span>`;
        }).join('');
      }
    }
    if (msg) msg.textContent = '';
  }

  async function togglePeerBlock(nodeId, currentlyBlocked) {
    if (!nodeId) return;
    try {
      await api('/api/server-admin/imageboard-peer-block', {
        method: 'PUT',
        body: JSON.stringify({ node_id: nodeId, blocked: !currentlyBlocked }),
      });
      await refreshImageboard();
    } catch (e) {
      const msg = document.getElementById('imageboard-msg');
      if (msg) { msg.textContent = e.message || 'Failed'; msg.style.color = '#f87171'; }
    }
  }

  async function saveImageboardIdentity() {
    const titleI = document.getElementById('ibid-title');
    const subI = document.getElementById('ibid-subtitle');
    const topicI = document.getElementById('ibid-topic');
    const nodeI = document.getElementById('ibid-node');
    const msg = document.getElementById('ibid-msg');
    const btn = document.getElementById('ibid-save-btn');
    if (!titleI || !btn) return;
    btn.disabled = true;
    if (msg) { msg.textContent = 'Saving…'; msg.style.color = 'var(--muted)'; }
    try {
      const body = {
        board_title: titleI.value,
        board_subtitle: subI ? subI.value : '',
        board_topic: topicI ? topicI.value : '',
        node_id: nodeI ? nodeI.value : '',
      };
      await api('/api/server-admin/imageboard-identity', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      if (msg) { msg.textContent = 'Saved.'; msg.style.color = '#4ade80'; }
      [titleI, subI, topicI, nodeI].forEach((el) => { if (el) delete el.dataset.dirty; });
      await refreshImageboard();
    } catch (e) {
      if (msg) { msg.textContent = e.message || 'Save failed'; msg.style.color = '#f87171'; }
    } finally {
      btn.disabled = false;
    }
  }

  async function refreshImageboard() {
    try {
      const data = await api('/api/server-admin/imageboard-stats');
      renderImageboardSection(data);
    } catch (e) {
      const msg = document.getElementById('imageboard-msg');
      if (msg) msg.textContent = e.message || 'Failed to load imageboard stats';
    }
  }

  // Mark identity inputs dirty so background refresh stops overwriting them.
  ['ibid-title','ibid-subtitle','ibid-topic','ibid-node'].forEach((id) => {
    document.addEventListener('input', (ev) => {
      const t = ev.target;
      if (t && t.id === id) t.dataset.dirty = '1';
    });
  });
  document.addEventListener('click', (ev) => {
    if (ev.target && ev.target.id === 'ibid-save-btn') {
      ev.preventDefault();
      saveImageboardIdentity();
      return;
    }
    // Per-peer Block/Unblock button on the imageboard panel.
    const peerBtn = ev.target && ev.target.closest && ev.target.closest('[data-peer-block]');
    if (peerBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const nid = peerBtn.getAttribute('data-peer-block') || '';
      const blocked = peerBtn.getAttribute('data-blocked') === '1';
      togglePeerBlock(nid, blocked);
    }
  });

  // Tor-required splash intercept. Registered separately at CAPTURE phase
  // on the document so we fire BEFORE any bubble-phase or target-attached
  // listeners (and well before the browser's default-action navigation /
  // Electron's setWindowOpenHandler -> shell.openExternal). Also covers
  // middle-click (auxclick) and right-click "Open in new tab".
  //
  // Fires when a clicked anchor's target host is `.onion` AND the current
  // page host is not — i.e. the operator is on clearnet and the link
  // points at a hidden service their browser can't reach.
  function _onionInterceptHandler(ev) {
    try {
      // Ignore modifier/key combos that should still go through if user
      // really wants to copy URL, etc. We DO want to intercept plain
      // clicks and middle-clicks though.
      if (ev.type === 'auxclick' && ev.button !== 1) return;
      const anchor = ev.target && ev.target.closest && ev.target.closest('a[href]');
      if (!anchor) return;
      // Scope to the imageboard panel + any element flagged data-onion-link.
      const scoped = anchor.closest('#imageboard-panel') || anchor.hasAttribute('data-onion-link');
      if (!scoped) return;
      const href = anchor.getAttribute('href') || '';
      if (!href || href.startsWith('#')) return;
      let targetUrl, targetHost;
      try {
        const u = new URL(href, location.href);
        targetUrl = u.toString();
        targetHost = u.hostname.toLowerCase();
      } catch { return; }
      if (!targetHost.endsWith('.onion')) return;
      const currentHost = String(location.hostname || '').toLowerCase();
      if (currentHost.endsWith('.onion')) return;
      // Block the navigation in every form the browser/Electron knows.
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
      let label = 'Imageboard';
      if (anchor.id === 'imageboard-admin-btn') label = 'Board Admin';
      else if (anchor.id === 'imageboard-open-btn') label = 'Imageboard';
      else {
        const peerTitle = anchor.querySelector('b');
        if (peerTitle && peerTitle.textContent) label = peerTitle.textContent.trim();
      }
      showTorRequiredDialog(targetUrl, label);
    } catch (err) {
      try { console.error('[ft] onion intercept failed', err); } catch {}
    }
  }
  document.addEventListener('click', _onionInterceptHandler, true);
  document.addEventListener('auxclick', _onionInterceptHandler, true);
  // Defensive: also neuter the href on the buttons themselves so even if
  // the listener somehow misses (e.g. CSP, extension), the buttons can't
  // open the onion directly. We restore behaviour through the splash's
  // explicit window.open call.
  function _neuterOnionAnchors() {
    document.querySelectorAll('#imageboard-panel a[href]').forEach((a) => {
      try {
        const u = new URL(a.getAttribute('href') || '', location.href);
        if (u.hostname.toLowerCase().endsWith('.onion')
            && !location.hostname.toLowerCase().endsWith('.onion')) {
          a.dataset.onionHref = u.toString();
          a.setAttribute('href', 'javascript:void(0)');
          a.removeAttribute('target');
        }
      } catch {}
    });
  }
  // Run on next tick + observe so re-renders re-neuter.
  setTimeout(_neuterOnionAnchors, 250);
  setInterval(_neuterOnionAnchors, 4000);

  // Self-contained "Tor required" splash for the server-admin page so we
  // don't have to drag the full app's ui.js into this surface. Renders a
  // dark backdrop, an explanation, the .onion address (click-to-copy),
  // and two actions: copy or open-anyway. Open-anyway routes through
  // window.open so Electron's setWindowOpenHandler -> shell.openExternal
  // still fires; the user has at least been warned.
  function showTorRequiredDialog(url, label) {
    const existing = document.getElementById('tor-required-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'tor-required-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:14000;background:rgba(3,8,6,.78);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = `
      <div style="max-width:520px;width:100%;background:#0f1410;color:#e6f1ea;border:1px solid #2a3a30;border-radius:14px;padding:22px;box-shadow:0 18px 48px rgba(0,0,0,.55);font-family:inherit">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <span style="display:inline-flex;align-items:center;gap:6px;background:#3a2a14;color:#ffb84a;border:1px solid #5a4a1a;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700;letter-spacing:.6px">🧅 TOR REQUIRED</span>
        </div>
        <div style="font-size:18px;font-weight:700;margin-bottom:6px">${label} runs on a Tor hidden service</div>
        <div style="font-size:13px;color:#bcd1c4;line-height:1.55;margin-bottom:14px">
          This node lives at a <b>.onion</b> address. To open <b>${escHtml(label)}</b> you need a
          Tor-connected browser &mdash; either the <a href="https://www.torproject.org/download/" target="_blank" rel="noopener" style="color:#ffb84a;text-decoration:underline">Tor Browser</a>
          or a system that proxies all traffic through Tor. Regular Chrome/Firefox/Safari can't reach this address.
        </div>
        <div style="font-size:11px;color:#7a8a82;margin-bottom:6px;letter-spacing:.4px">ONION ADDRESS</div>
        <div id="tor-required-addr" title="Click to copy" style="background:#070a08;border:1px solid #1f2a23;border-radius:8px;padding:10px;font-family:monospace;font-size:12px;color:#7be0a8;word-break:break-all;cursor:pointer;margin-bottom:14px">${escHtml(url)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button type="button" id="tor-required-close" style="background:transparent;color:#bcd1c4;border:1px solid #2a3a30;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer">Cancel</button>
          <button type="button" id="tor-required-copy" style="background:#1a2820;color:#7be0a8;border:1px solid #2a4a35;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer">Copy address</button>
          <button type="button" id="tor-required-open" style="background:#ffb84a;color:#1a1206;border:0;border-radius:8px;padding:9px 14px;font-weight:700;cursor:pointer">Open anyway ↗</button>
        </div>
        <div style="font-size:11px;color:#7a8a82;margin-top:12px;line-height:1.55">
          Tip: paste the address into Tor Browser. If you frequently moderate this node, run FrogTalk Desktop
          inside a Tor-routed environment (e.g. Whonix or a SOCKS5 wrapper).
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    const copy = () => {
      try { navigator.clipboard.writeText(url); } catch {}
      const b = overlay.querySelector('#tor-required-copy');
      if (b) { b.textContent = 'Copied ✓'; setTimeout(() => { if (b.isConnected) b.textContent = 'Copy address'; }, 1600); }
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#tor-required-close').addEventListener('click', close);
    overlay.querySelector('#tor-required-copy').addEventListener('click', copy);
    overlay.querySelector('#tor-required-addr').addEventListener('click', copy);
    overlay.querySelector('#tor-required-open').addEventListener('click', () => {
      // Use window.open so Electron's window-open handler -> shell.openExternal
      // still routes through the OS. The user has acknowledged the warning.
      try { window.open(url, '_blank', 'noopener,noreferrer'); } catch {}
      close();
    });
  }

  function renderNodeSummary(nodes) {
    if (!nodeSummaryGrid) return;
    const list = Array.isArray(nodes) ? nodes : [];
    const enabled = list.filter((n) => n.enabled).length;
    const blocked = list.length - enabled;
    const tor = list.filter((n) => n.route_mode === 'tor').length;
    const official = list.filter((n) => n.official).length;
    nodeSummaryGrid.innerHTML = [
      summaryCard('Reachable Set', enabled, `${blocked} blocked or disabled`, enabled ? 'success' : 'warn'),
      summaryCard('Tor Routes', tor, `${Math.max(list.length - tor, 0)} direct routes`, tor ? 'success' : 'warn'),
      summaryCard('Official Peers', official, `${Math.max(list.length - official, 0)} community peers`),
      summaryCard('Registry Size', list.length, 'Known federation nodes'),
    ].join('');
  }

  function renderUsers(users) {
    if (!Array.isArray(users) || !users.length) {
      onlineUsersBody.innerHTML = '<tr><td colspan="3" style="color:#93ab9a">No users online</td></tr>';
      return;
    }
    onlineUsersBody.innerHTML = users.map(u => `
      <tr>
        <td>${escHtml(u.nickname || `#${u.user_id}`)}</td>
        <td>${Number(u.connections) || 0}</td>
        <td>${u.is_admin ? 'admin' : 'user'}</td>
      </tr>
    `).join('');
  }

  function nodeActionButton(node) {
    const sid = node.server_id || '';
    const blocked = !Boolean(node.enabled);
    if (!sid) return '';
    if (node.is_local) {
      return '';
    }
    if (blocked) {
      return `<button class="btn" data-node-unblock="${sid}">Unblock</button>`;
    }
    return `<button class="btn danger" data-node-block="${sid}">Block</button>`;
  }

  async function copyNodeId(serverId) {
    if (!serverId) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(serverId);
      } else {
        const ghost = document.createElement('textarea');
        ghost.value = serverId;
        ghost.setAttribute('readonly', 'readonly');
        ghost.style.position = 'fixed';
        ghost.style.opacity = '0';
        document.body.appendChild(ghost);
        ghost.select();
        document.execCommand('copy');
        ghost.remove();
      }
      setNodeMessage(`Copied node id ${serverId}.`);
    } catch (e) {
      setNodeMessage(`Could not copy node id ${serverId}.`, true);
    }
  }

  function renderNodes(nodes) {
    if (!Array.isArray(nodes) || !nodes.length) {
      nodesBody.innerHTML = '<div class="node-card"><div style="color:#93ab9a">No federation nodes found</div></div>';
      renderNodeSummary([]);
      return;
    }
    renderNodeSummary(nodes);
    nodesBody.innerHTML = nodes.map((n) => {
      const blocked = !Boolean(n.enabled);
      const status = blocked ? 'blocked' : 'enabled';
      const trust = n.trust_tier || 'community';
      const lastSeen = n.last_seen ? `Seen ${fmtWhen(n.last_seen)}` : 'No recent heartbeat';
      const caps = Array.isArray(n.capabilities) ? n.capabilities.length : 0;
      return `
        <article class="node-card">
          <div class="node-card-main">
            <div class="node-name-row">
              <span class="node-name">${escHtml(n.display_name || n.server_id || 'Unknown node')}</span>
              ${n.is_local ? '<span class="mini-badge mini-badge-local">local</span>' : ''}
              ${n.official ? '<span class="mini-badge success">official</span>' : ''}
              ${n.onion_available ? '<span class="mini-badge">onion</span>' : ''}
              ${n.policy_tor_blocked ? '<span class="mini-badge" style="border-color:#7a4a2a;color:#ffb347;">tor policy</span>' : ''}
            </div>
            <div class="node-endpoint">${escHtml(n.display_endpoint || 'hidden endpoint')}</div>
            <div class="node-meta">${escHtml(n.transport_label || 'Route unknown')} · ${escHtml(n.privacy_label || 'Privacy unknown')} · ${escHtml(n.region || 'Unknown region')} · ${caps} cap${caps === 1 ? '' : 's'} · ${escHtml(lastSeen)}</div>
            <div class="node-id-row"><span class="node-id-label">ID</span><code class="node-id">${escHtml(n.server_id || 'missing-id')}</code></div>
          </div>
          <div class="node-card-sidebar">
            <div class="node-stat">
              <div class="node-stat-label">Status</div>
              <div class="node-stat-value"><span class="mini-badge ${blocked ? 'danger' : 'success'}">${escHtml(status)}</span></div>
            </div>
            <div class="node-stat">
              <div class="node-stat-label">Trust</div>
              <div class="node-stat-value"><span class="mini-badge ${trust === 'official' ? 'success' : ''}">${escHtml(trust)}</span></div>
            </div>
            <div class="node-actions-cell">${nodeActionButton(n)}<button class="btn" data-node-probe="${n.server_id || ''}">${n.is_local ? 'Self-check' : 'Probe'}</button><button class="btn" data-node-copy="${n.server_id || ''}">Copy ID</button></div>
          </div>
        </article>
      `;
    }).join('');

    nodesBody.querySelectorAll('[data-node-block]').forEach((btn) => {
      btn.addEventListener('click', () => runNodeAction(btn.getAttribute('data-node-block'), 'block'));
    });
    nodesBody.querySelectorAll('[data-node-unblock]').forEach((btn) => {
      btn.addEventListener('click', () => runNodeAction(btn.getAttribute('data-node-unblock'), 'unblock'));
    });
    nodesBody.querySelectorAll('[data-node-probe]').forEach((btn) => {
      btn.addEventListener('click', () => runNodeProbe(btn.getAttribute('data-node-probe')));
    });
    nodesBody.querySelectorAll('[data-node-copy]').forEach((btn) => {
      btn.addEventListener('click', () => copyNodeId(btn.getAttribute('data-node-copy')));
    });
  }

  async function refreshNodes() {
    const data = await api('/api/server-admin/nodes?include_disabled=1');
    renderNodes(data.nodes || []);
  }

  async function runNodeAction(serverId, action) {
    if (!serverId || !action) return;
    setNodeMessage(`Running ${action} for ${serverId}...`);
    try {
      await api(`/api/server-admin/nodes/${encodeURIComponent(serverId)}/${action}`, { method: 'POST' });
      setNodeMessage(`${action} completed for ${serverId}.`);
      await refreshNodes();
    } catch (e) {
      setNodeMessage(e.message, true);
    }
  }

  async function runNodeProbe(serverId) {
    if (!serverId) return;
    setNodeMessage(`Probing ${serverId}...`);
    try {
      const data = await api(`/api/server-admin/nodes/${encodeURIComponent(serverId)}/probe`);
      if (data.healthy) {
        if (data.is_local) {
          setNodeMessage(`${serverId} healthy via ${data.transport_label || 'local self-check'} (${data.display_target || 'local process'})`);
        } else {
          setNodeMessage(`${serverId} healthy (${data.latency_ms ?? '--'} ms) over ${data.transport_label || 'network route'} via ${data.display_target || 'hidden endpoint'}`);
        }
      } else {
        setNodeMessage(`${serverId} probe failed over ${data.transport_label || 'network route'}: ${data.error || 'unknown error'}`, true);
      }
    } catch (e) {
      setNodeMessage(e.message, true);
    }
  }

  // -------------------------------------------------------------------
  // Bot moderation panel
  // -------------------------------------------------------------------
  const botModBody = document.getElementById('bot-mod-body');
  const botModMsg = document.getElementById('bot-mod-msg');
  const botModSearch = document.getElementById('bot-mod-search');
  const botModOnlyBanned = document.getElementById('bot-mod-only-banned');
  const botModRefreshBtn = document.getElementById('bot-mod-refresh');
  let botModCache = [];
  let botModLoadedOnce = false;

  function setBotModMsg(text, isError = false) {
    if (!botModMsg) return;
    botModMsg.textContent = text || '';
    botModMsg.style.color = isError ? '#ff8b8b' : '';
  }

  function filteredBots() {
    const q = (botModSearch?.value || '').trim().toLowerCase();
    const onlyBanned = !!botModOnlyBanned?.checked;
    return botModCache.filter((b) => {
      if (onlyBanned && !b.banned) return false;
      if (!q) return true;
      const hay = `${b.name || ''} ${b.owner_name || ''} ${b.origin_server_id || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function renderBotModeration() {
    if (!botModBody) return;
    const list = filteredBots();
    if (!list.length) {
      botModBody.innerHTML = '<div class="node-card"><div style="color:#93ab9a">No bots match this filter.</div></div>';
      return;
    }
    botModBody.innerHTML = list.map((b) => {
      const avatar = b.avatar
        ? `<img src="${escHtml(b.avatar)}" alt="" style="width:36px;height:36px;border-radius:8px;object-fit:cover;flex-shrink:0;">`
        : `<div style="width:36px;height:36px;border-radius:8px;background:#1f2c22;display:flex;align-items:center;justify-content:center;color:#7d9483;font-weight:700;flex-shrink:0;">${escHtml((b.name || '?').slice(0, 1).toUpperCase())}</div>`;
      const fed = b.federated
        ? `<span class="mini-badge">federated</span>`
        : '<span class="mini-badge mini-badge-local">local</span>';
      const pub = b.is_public
        ? '<span class="mini-badge success">public</span>'
        : '<span class="mini-badge">private</span>';
      const banStatus = b.banned
        ? '<span class="mini-badge danger">banned</span>'
        : '<span class="mini-badge success">allowed</span>';
      const origin = b.origin_server_id ? `<div class="node-id-row"><span class="node-id-label">Origin</span><code class="node-id">${escHtml(b.origin_server_id)}</code></div>` : '';
      const reasonRow = b.banned && b.ban_reason
        ? `<div class="node-meta" style="color:#ff8b8b;">Reason: ${escHtml(b.ban_reason)}</div>`
        : '';
      const desc = b.description ? `<div class="node-meta">${escHtml(b.description)}</div>` : '';
      const action = b.banned
        ? `<button class="btn" data-bot-unban="${b.id}">Unban</button>`
        : `<button class="btn danger" data-bot-ban="${b.id}">Ban</button>`;
      return `
        <article class="node-card">
          <div class="node-card-main">
            <div class="node-name-row" style="gap:10px;align-items:center;">
              ${avatar}
              <span class="node-name">${escHtml(b.name || `bot#${b.id}`)}</span>
              ${fed}
              ${pub}
              ${banStatus}
            </div>
            <div class="node-meta">Owner: ${escHtml(b.owner_name || 'unknown')} · ${b.channel_count || 0} channel${(b.channel_count || 0) === 1 ? '' : 's'}</div>
            ${desc}
            ${origin}
            ${reasonRow}
          </div>
          <div class="node-card-sidebar">
            <div class="node-actions-cell">${action}</div>
          </div>
        </article>
      `;
    }).join('');
    botModBody.querySelectorAll('[data-bot-ban]').forEach((btn) => {
      btn.addEventListener('click', () => banBotPrompt(Number(btn.getAttribute('data-bot-ban'))));
    });
    botModBody.querySelectorAll('[data-bot-unban]').forEach((btn) => {
      btn.addEventListener('click', () => unbanBot(Number(btn.getAttribute('data-bot-unban'))));
    });
  }

  async function refreshBotModeration() {
    if (!botModBody) return;
    try {
      const data = await api('/api/server-admin/bots');
      botModCache = Array.isArray(data.bots) ? data.bots : [];
      botModLoadedOnce = true;
      renderBotModeration();
    } catch (e) {
      setBotModMsg(e.message || 'Failed to load bots.', true);
    }
  }

  async function banBotPrompt(botId) {
    if (!botId) return;
    const bot = botModCache.find((b) => Number(b.id) === Number(botId));
    const label = bot?.name || `#${botId}`;
    const reason = window.prompt(`Ban "${label}" from this node?\n\nOptional reason (shown to admins):`, '');
    if (reason === null) return;
    setBotModMsg(`Banning ${label}...`);
    try {
      await api(`/api/server-admin/bots/${encodeURIComponent(botId)}/ban`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      setBotModMsg(`Banned ${label}. Removed from all channels on this node.`);
      await refreshBotModeration();
    } catch (e) {
      setBotModMsg(e.message || 'Ban failed.', true);
    }
  }

  async function unbanBot(botId) {
    if (!botId) return;
    const bot = botModCache.find((b) => Number(b.id) === Number(botId));
    const label = bot?.name || `#${botId}`;
    setBotModMsg(`Unbanning ${label}...`);
    try {
      await api(`/api/server-admin/bots/${encodeURIComponent(botId)}/unban`, { method: 'POST' });
      setBotModMsg(`Unbanned ${label}.`);
      await refreshBotModeration();
    } catch (e) {
      setBotModMsg(e.message || 'Unban failed.', true);
    }
  }

  botModRefreshBtn?.addEventListener('click', () => refreshBotModeration());
  botModSearch?.addEventListener('input', () => { if (botModLoadedOnce) renderBotModeration(); });
  botModOnlyBanned?.addEventListener('change', () => { if (botModLoadedOnce) renderBotModeration(); });

  // ── Bug & vulnerability report queue ────────────────────────────────
  // Reports filed via /security land in a DB queue. We render them as
  // collapsible cards with severity-coloured badges and inline triage
  // controls (status select, severity select, admin_notes textarea,
  // delete). Open + critical float to the top thanks to the SQL sort.
  let bugsCache = [];
  const bugExpanded = new Set();

  function _bugTimeAgo(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    const diff = Math.max(0, (Date.now() - t) / 1000);
    if (diff < 60)     return `${Math.floor(diff)}s ago`;
    if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function _bugSelect(name, value, options) {
    return `<select data-bug-field="${name}">` +
      options.map(o => `<option value="${escHtml(o)}"${o === value ? ' selected' : ''}>${escHtml(o)}</option>`).join('') +
      `</select>`;
  }

  function renderBugStats(stats) {
    if (!bugsStats) return;
    const s = stats || {};
    const byStatus = s.by_status || {};
    const bySev = s.by_severity || {};
    const total = s.total || 0;
    bugsStats.innerHTML = `
      <span class="bug-stat-pill">Total <b>${total}</b></span>
      <span class="bug-stat-pill">Open <b>${byStatus.open || 0}</b></span>
      <span class="bug-stat-pill">Triage <b>${byStatus.triage || 0}</b></span>
      <span class="bug-stat-pill">In progress <b>${byStatus.in_progress || 0}</b></span>
      <span class="bug-stat-pill">Fixed <b>${byStatus.fixed || 0}</b></span>
      <span class="bug-stat-pill">Critical <b>${bySev.critical || 0}</b></span>
      <span class="bug-stat-pill">High <b>${bySev.high || 0}</b></span>
    `;
  }

  function renderBugs() {
    if (!bugsBody) return;
    if (!bugsCache.length) {
      bugsBody.innerHTML = `<div class="sub" style="padding:18px;text-align:center;">No reports match the current filters. Quiet is good.</div>`;
      return;
    }
    const statuses = ['open', 'triage', 'in_progress', 'fixed', 'wontfix', 'duplicate'];
    const sevs = ['low', 'medium', 'high', 'critical'];

    const html = bugsCache.map(r => {
      const id = Number(r.id) || 0;
      const sev = String(r.severity || 'medium').toLowerCase();
      const st  = String(r.status || 'open').toLowerCase();
      const cat = String(r.category || 'bug').toLowerCase();
      const expanded = bugExpanded.has(id);
      const reporter = r.reporter_nick
        ? `@${escHtml(r.reporter_nick)}`
        : (r.reporter_ip ? `anon (${escHtml(r.reporter_ip)})` : 'anonymous');
      const contact = r.contact ? ` · contact: ${escHtml(r.contact)}` : '';
      return `
        <div class="bug-card sev-${escHtml(sev)} status-${escHtml(st)} ${expanded ? '' : 'bug-collapsed'}" data-bug-id="${id}">
          <div class="bug-card-head">
            <div class="bug-title">#${id} · ${escHtml(r.title || '(no title)')}</div>
            <div class="bug-badges">
              <span class="bug-badge sev-${escHtml(sev)}">${escHtml(sev)}</span>
              <span class="bug-badge status-${escHtml(st)}">${escHtml(st.replace('_', ' '))}</span>
              <span class="bug-badge cat">${escHtml(cat)}</span>
              <button class="bug-toggle" data-bug-toggle="${id}">${expanded ? 'collapse' : 'expand'}</button>
            </div>
          </div>
          <div class="bug-meta">
            ${_bugTimeAgo(r.created_at)} · by ${reporter}${contact}
          </div>
          <div class="bug-body">${escHtml(r.body || '')}</div>
          <div class="bug-actions">
            <label style="font-size:12px;color:#8ea99b;">Status</label>
            ${_bugSelect('status', st, statuses)}
            <label style="font-size:12px;color:#8ea99b;">Severity</label>
            ${_bugSelect('severity', sev, sevs)}
            <button class="btn" data-bug-save="${id}">Save</button>
            <button class="btn danger" data-bug-delete="${id}">Delete</button>
          </div>
          <div class="bug-notes">
            <label style="font-size:12px;color:#8ea99b;display:block;margin-top:6px;">Admin notes</label>
            <textarea data-bug-field="admin_notes" placeholder="Internal triage notes (admins only)…">${escHtml(r.admin_notes || '')}</textarea>
          </div>
        </div>
      `;
    }).join('');
    bugsBody.innerHTML = html;
  }

  async function refreshBugs() {
    if (!bugsBody) return;
    const params = new URLSearchParams();
    const st = bugsFilterStatus?.value || '';
    const sv = bugsFilterSeverity?.value || '';
    if (st) params.set('status', st);
    if (sv) params.set('severity', sv);
    try {
      const data = await api('/api/server-admin/bug-reports?' + params.toString());
      bugsCache = Array.isArray(data.reports) ? data.reports : [];
      renderBugStats(data.stats);
      renderBugs();
    } catch (e) {
      if (bugsMsg) {
        bugsMsg.textContent = `Failed to load bug reports: ${e.message}`;
        bugsMsg.style.color = '#ff9f9f';
      }
    }
  }

  async function saveBug(id) {
    const card = bugsBody?.querySelector(`.bug-card[data-bug-id="${id}"]`);
    if (!card) return;
    const status = card.querySelector('[data-bug-field="status"]')?.value;
    const severity = card.querySelector('[data-bug-field="severity"]')?.value;
    const admin_notes = card.querySelector('[data-bug-field="admin_notes"]')?.value || '';
    try {
      await api(`/api/server-admin/bug-reports/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, severity, admin_notes }),
      });
      if (bugsMsg) {
        bugsMsg.textContent = `Report #${id} updated.`;
        bugsMsg.style.color = '#93ab9a';
      }
      await refreshBugs();
    } catch (e) {
      if (bugsMsg) {
        bugsMsg.textContent = `Save failed: ${e.message}`;
        bugsMsg.style.color = '#ff9f9f';
      }
    }
  }

  async function deleteBug(id) {
    if (!window.confirm(`Delete report #${id}? This cannot be undone.`)) return;
    try {
      await api(`/api/server-admin/bug-reports/${id}`, { method: 'DELETE' });
      bugExpanded.delete(id);
      await refreshBugs();
    } catch (e) {
      if (bugsMsg) {
        bugsMsg.textContent = `Delete failed: ${e.message}`;
        bugsMsg.style.color = '#ff9f9f';
      }
    }
  }

  bugsBody?.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const toggleId = t.getAttribute('data-bug-toggle');
    if (toggleId) {
      const id = Number(toggleId);
      if (bugExpanded.has(id)) bugExpanded.delete(id); else bugExpanded.add(id);
      renderBugs();
      return;
    }
    const saveId = t.getAttribute('data-bug-save');
    if (saveId) { saveBug(Number(saveId)); return; }
    const delId = t.getAttribute('data-bug-delete');
    if (delId) { deleteBug(Number(delId)); return; }
  });
  bugsRefreshBtn?.addEventListener('click', () => refreshBugs());
  bugsFilterStatus?.addEventListener('change', () => refreshBugs());
  bugsFilterSeverity?.addEventListener('change', () => refreshBugs());

  async function refreshDashboard() {
    const t0 = performance.now();
    const config = await api('/api/server-admin/config');
    const stats = await api('/api/server-admin/stats');
    const users = await api('/api/server-admin/online-users');
    const pingMs = Math.max(1, Math.round(performance.now() - t0));
    latencyBadge.textContent = `Latency: ${pingMs} ms`;
    syncChannelRetention(config.channel_retention || {});
    syncFederationPolicy(config.federation_policy || {});
    renderServerMeta(stats);
    renderStats(stats, pingMs);
    renderResources(stats);
    renderUsers(users.users || []);
    await refreshNodes();
    await refreshBotModeration();
    await refreshBugs();
    refreshImageboard();
    if (!easterEggLoaded) await loadEasterEgg();
    if (!easterEggLoaded) await loadEasterEgg();
  }

  function _appLoginUrl() {
    const ret = encodeURIComponent('/server');
    return `/app?return=${ret}`;
  }

  async function _runAdminPinGate() {
    if (!window.Pin || typeof Pin.gateAdmin !== 'function') {
      setLoginMessage('PIN module failed to load. Hard-refresh and try again.', true);
      return false;
    }
    try {
      if (typeof Pin.refreshFromServer === 'function') {
        await Pin.refreshFromServer();
      }
    } catch {}
    const ok = await Pin.gateAdmin();
    if (!ok) {
      setLoginMessage('PIN required to open the server panel.', true);
      return false;
    }
    try {
      await api('/api/auth/pin/sync-admin-gate', { method: 'POST' });
    } catch (e) {
      if (e.status === 423) {
        setLoginMessage('Enter your privacy PIN to unlock the server panel.', true);
        return false;
      }
    }
    return true;
  }

  async function ensureAuth() {
    loginScreen.classList.remove('hidden');
    app.classList.add('hidden');
    let gate = {};
    try {
      gate = await api('/api/server-admin/session');
    } catch (e) {
      if (e.status === 404) {
        setLoginMessage('Server WebUI is disabled on this node.', true);
        return false;
      }
      setLoginMessage(e.message || 'Could not reach server.', true);
      return false;
    }
    const legacyBox = document.getElementById('gate-legacy');
    const frogtalkBox = document.getElementById('gate-frogtalk');
    if (legacyBox) legacyBox.classList.toggle('hidden', !gate.legacy_webui_login);
    if (!gate.authenticated) {
      setLoginMessage('Sign in with a FrogTalk account that has node admin rights.');
      return false;
    }
    if (!gate.is_admin) {
      setLoginMessage('This account is not a node admin. Use an admin account or ask the operator.');
      return false;
    }
    if (gate.pin_required) {
      setLoginMessage('Enter your privacy PIN to unlock the server panel.');
      const pinOk = await _runAdminPinGate();
      if (!pinOk) return false;
      try {
        gate = await api('/api/server-admin/session');
      } catch (e) {
        setLoginMessage(e.message || 'Session check failed after PIN.', true);
        return false;
      }
      if (!gate.ok) {
        try {
          await api('/api/auth/pin/sync-admin-gate', { method: 'POST' });
          gate = await api('/api/server-admin/session');
        } catch (e) {
          if (e.status === 423) {
            setLoginMessage('Enter your privacy PIN to unlock the server panel.', true);
            return false;
          }
        }
        if (!gate.ok) {
          setLoginMessage('PIN accepted but session is not cleared for admin access. Hard-refresh and try again.', true);
          return false;
        }
      }
    }
    try {
      await api('/api/server-admin/me');
      loginScreen.classList.add('hidden');
      app.classList.remove('hidden');
      await refreshDashboard();
      return true;
    } catch (e) {
      setLoginMessage(e.message || 'Could not load server panel.', true);
      return false;
    }
  }

  async function login() {
    const legacyMsg = document.getElementById('legacy-login-msg');
    const say = (msg, isError) => {
      if (legacyMsg) {
        legacyMsg.textContent = msg || '';
        legacyMsg.style.color = isError ? '#ff9f9f' : '#93ab9a';
      } else {
        setLoginMessage(msg, isError);
      }
    };
    const username = document.getElementById('login-user')?.value.trim();
    const password = document.getElementById('login-pass')?.value;
    if (!username || !password) {
      say('Enter username and password.', true);
      return;
    }
    say('Signing in...');
    try {
      await api('/api/server-admin/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      say('Authenticated.');
      await ensureAuth();
    } catch (e) {
      say(e.message, true);
    }
  }

  async function logout() {
    try {
      await api('/api/server-admin/logout', { method: 'POST' });
    } catch {}
    await ensureAuth();
  }

  function getModerationBody() {
    return {
      nickname: document.getElementById('mod-nick').value.trim(),
      duration_minutes: parseInt(document.getElementById('mod-duration').value || '60', 10),
      reason: document.getElementById('mod-reason').value.trim(),
    };
  }

  async function runAction(action) {
    const body = getModerationBody();
    if (!body.nickname && action !== 'sync') {
      setActionMessage('Enter a target nickname first.', true);
      return;
    }
    setActionMessage('Running action...');
    try {
      const path = action === 'sync'
        ? '/api/server-admin/control/sync-official-directory'
        : `/api/server-admin/control/${action}`;
      const data = await api(path, {
        method: 'POST',
        body: action === 'sync' ? undefined : JSON.stringify(body),
      });
      if (action === 'sync') {
        setActionMessage(`Synced directory: imported ${data.imported}, skipped ${data.skipped}.`);
      } else {
        setActionMessage(`${action} completed successfully.`);
      }
      await refreshDashboard();
    } catch (e) {
      setActionMessage(e.message, true);
    }
  }

  document.getElementById('gate-app-login-btn')?.addEventListener('click', () => {
    window.location.assign(_appLoginUrl());
  });
  document.getElementById('login-btn')?.addEventListener('click', login);
  document.getElementById('login-pass')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });

  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('refresh-btn').addEventListener('click', () => refreshDashboard().catch((e) => setActionMessage(e.message, true)));
  document.getElementById('sync-dir-btn').addEventListener('click', () => runAction('sync'));
  saveChannelRetentionBtn?.addEventListener('click', () => {
    saveChannelRetention().catch(() => {});
  });
  saveFederationPolicyBtn?.addEventListener('click', () => {
    saveFederationPolicy().catch(() => {});
  });
  blockTorPeers?.addEventListener('change', refreshFederationPolicyDirtyUi);
  channelActiveDays?.addEventListener('input', refreshRetentionDirtyUi);
  channelAutoDeleteDays?.addEventListener('input', refreshRetentionDirtyUi);
  frogTrigger?.addEventListener('click', handleFrogTap);
  easterEditor?.addEventListener('input', () => {
    easterEggDirty = true;
    updateEditorEmptyState();
    renderEasterPreview();
  });
  easterEditor?.addEventListener('focus', updateEditorEmptyState);
  easterEditor?.addEventListener('blur', updateEditorEmptyState);
  easterTitle?.addEventListener('input', () => {
    easterEggDirty = true;
    renderEasterPreview();
  });
  easterEnabled?.addEventListener('change', () => {
    easterEggDirty = true;
  });
  easterPreviewBtn?.addEventListener('click', previewEasterPopup);
  easterSaveBtn?.addEventListener('click', saveEasterEgg);
  easterUploadBtn?.addEventListener('click', openEasterFilePicker);
  easterUploadInput?.addEventListener('change', (event) => {
    const file = event.target?.files?.[0];
    uploadEasterAsset(file);
    event.target.value = '';
  });
  document.querySelectorAll('[data-editor-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => applyEditorCommand(btn.getAttribute('data-editor-cmd')));
  });

  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => runAction(btn.getAttribute('data-action')));
  });

  ensureAuth().catch(() => {
    setLoginMessage('WebUI unavailable or disabled.', true);
  });

  setInterval(() => {
    if (!app.classList.contains('hidden')) {
      refreshDashboard().catch(() => {});
    }
  }, 12000);
})();
