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
  const channelActiveDays = document.getElementById('channel-active-days');
  const channelAutoDeleteDays = document.getElementById('channel-auto-delete-days');
  const saveChannelRetentionBtn = document.getElementById('save-channel-retention-btn');
  let easterEggConfig = { enabled: false, title: 'Frog signal', html: '', updated_at: '' };
  let easterEggLoaded = false;
  let easterEggDirty = false;
  let frogTapCount = 0;
  let frogTapTimer = null;

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

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
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
  }

  async function saveChannelRetention() {
    const directoryActiveDays = Math.max(1, Number(channelActiveDays?.value || 30) || 30);
    const autoDeleteDays = Math.max(0, Number(channelAutoDeleteDays?.value || 0) || 0);
    const payload = await api('/api/server-admin/channel-retention', {
      method: 'PUT',
      body: JSON.stringify({
        directory_active_days: directoryActiveDays,
        auto_delete_days: autoDeleteDays,
      }),
    });
    syncChannelRetention(payload.channel_retention || {});
    const federated = payload.federation?.ok ? ' Federation sync queued.' : ' Federation sync pending retry.';
    setActionMessage(`Channel timing saved.${federated}`);
  }

  function renderStats(payload, pingMs) {
    const db = payload.db || {};
    const ws = payload.ws || {};
    statsGrid.innerHTML = [
      statCard('Total Users', db.users_total ?? 0, `${db.users_admin ?? 0} admins`),
      statCard('Active Sessions', db.sessions_active ?? 0, 'Signed-in accounts'),
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
        <td>${u.nickname || `#${u.user_id}`}</td>
        <td>${u.connections || 0}</td>
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

  async function refreshDashboard() {
    const t0 = performance.now();
    const config = await api('/api/server-admin/config');
    const stats = await api('/api/server-admin/stats');
    const users = await api('/api/server-admin/online-users');
    const pingMs = Math.max(1, Math.round(performance.now() - t0));
    latencyBadge.textContent = `Latency: ${pingMs} ms`;
    syncChannelRetention(config.channel_retention || {});
    renderServerMeta(stats);
    renderStats(stats, pingMs);
    renderResources(stats);
    renderUsers(users.users || []);
    await refreshNodes();
    if (!easterEggLoaded) await loadEasterEgg();
  }

  async function ensureAuth() {
    try {
      await api('/api/server-admin/me');
      loginScreen.classList.add('hidden');
      app.classList.remove('hidden');
      await refreshDashboard();
      return true;
    } catch {
      loginScreen.classList.remove('hidden');
      app.classList.add('hidden');
      return false;
    }
  }

  async function login() {
    const username = document.getElementById('login-user').value.trim();
    const password = document.getElementById('login-pass').value;
    if (!username || !password) {
      setLoginMessage('Enter username and password.', true);
      return;
    }
    setLoginMessage('Signing in...');
    try {
      await api('/api/server-admin/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      setLoginMessage('Authenticated.');
      await ensureAuth();
    } catch (e) {
      setLoginMessage(e.message, true);
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

  document.getElementById('login-btn').addEventListener('click', login);
  document.getElementById('login-pass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });

  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('refresh-btn').addEventListener('click', () => refreshDashboard().catch((e) => setActionMessage(e.message, true)));
  document.getElementById('sync-dir-btn').addEventListener('click', () => runAction('sync'));
  saveChannelRetentionBtn?.addEventListener('click', () => {
    saveChannelRetention().catch((e) => setActionMessage(e.message, true));
  });
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
