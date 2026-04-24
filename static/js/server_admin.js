(() => {
  const loginScreen = document.getElementById('login-screen');
  const app = document.getElementById('app');
  const loginMsg = document.getElementById('login-msg');
  const actionMsg = document.getElementById('action-msg');
  const statsGrid = document.getElementById('stats-grid');
  const onlineUsersBody = document.getElementById('online-users-body');
  const latencyBadge = document.getElementById('latency-badge');

  function setLoginMessage(msg, isError = false) {
    loginMsg.textContent = msg || '';
    loginMsg.style.color = isError ? '#ff9f9f' : '#93ab9a';
  }

  function setActionMessage(msg, isError = false) {
    actionMsg.textContent = msg || '';
    actionMsg.style.color = isError ? '#ff9f9f' : '#93ab9a';
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

  async function refreshDashboard() {
    const t0 = performance.now();
    const stats = await api('/api/server-admin/stats');
    const users = await api('/api/server-admin/online-users');
    const pingMs = Math.max(1, Math.round(performance.now() - t0));
    latencyBadge.textContent = `Latency: ${pingMs} ms`;
    renderStats(stats, pingMs);
    renderUsers(users.users || []);
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
