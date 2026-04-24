(() => {
  const loginScreen = document.getElementById('login-screen');
  const app = document.getElementById('app');
  const loginMsg = document.getElementById('login-msg');
  const actionMsg = document.getElementById('action-msg');
  const statsGrid = document.getElementById('stats-grid');
  const resourceGrid = document.getElementById('resource-grid');
  const onlineUsersBody = document.getElementById('online-users-body');
  const nodesBody = document.getElementById('nodes-body');
  const nodeMsg = document.getElementById('node-msg');
  const latencyBadge = document.getElementById('latency-badge');

  function setLoginMessage(msg, isError = false) {
    loginMsg.textContent = msg || '';
    loginMsg.style.color = isError ? '#ff9f9f' : '#93ab9a';
  }

  function setActionMessage(msg, isError = false) {
    actionMsg.textContent = msg || '';
    actionMsg.style.color = isError ? '#ff9f9f' : '#93ab9a';
  }

  function setNodeMessage(msg, isError = false) {
    nodeMsg.textContent = msg || '';
    nodeMsg.style.color = isError ? '#ff9f9f' : '#93ab9a';
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

  function statCard(label, value, meta = '') {
    return `
      <div class="card">
        <div class="card-label">${label}</div>
        <div class="card-value">${value}</div>
        <div class="card-meta">${meta}</div>
      </div>
    `;
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
    if (blocked) {
      return `<button class="btn" data-node-unblock="${sid}">Unblock</button>`;
    }
    return `<button class="btn danger" data-node-block="${sid}">Block</button>`;
  }

  function renderNodes(nodes) {
    if (!Array.isArray(nodes) || !nodes.length) {
      nodesBody.innerHTML = '<tr><td colspan="4" style="color:#93ab9a">No federation nodes found</td></tr>';
      return;
    }
    nodesBody.innerHTML = nodes.map((n) => {
      const blocked = !Boolean(n.enabled);
      const status = blocked ? 'blocked' : 'enabled';
      return `
        <tr>
          <td>
            <div>${n.display_name || n.server_id}</div>
            <div style="font-size:11px;color:#93ab9a">${n.base_url || ''}</div>
          </td>
          <td>${status}</td>
          <td>${n.trust_tier || 'community'}</td>
          <td style="display:flex; gap:6px; flex-wrap:wrap;">${nodeActionButton(n)}<button class="btn" data-node-probe="${n.server_id || ''}">Probe</button></td>
        </tr>
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
        setNodeMessage(`${serverId} healthy (${data.latency_ms ?? '--'} ms) via ${data.target}`);
      } else {
        setNodeMessage(`${serverId} probe failed: ${data.error || 'unknown error'}`, true);
      }
    } catch (e) {
      setNodeMessage(e.message, true);
    }
  }

  async function refreshDashboard() {
    const t0 = performance.now();
    const stats = await api('/api/server-admin/stats');
    const users = await api('/api/server-admin/online-users');
    const pingMs = Math.max(1, Math.round(performance.now() - t0));
    latencyBadge.textContent = `Latency: ${pingMs} ms`;
    renderStats(stats, pingMs);
    renderResources(stats);
    renderUsers(users.users || []);
    await refreshNodes();
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
