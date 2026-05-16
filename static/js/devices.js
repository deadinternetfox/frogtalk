// static/js/devices.js — Track F Phase 3 (linked devices UI)
//
// Manages the "Linked devices" Settings pane plus the QR-based pairing
// flow for enrolling secondary devices. Backend lives at
// /api/signal/devices/* (see routers/signal.py).
//
// Public surface (window.Devices):
//   list()                          → fetch current user's devices
//   refresh()                       → re-render the devices pane
//   registerThisDevice(name?)       → enrol the current browser
//   revoke(deviceId)                → revoke a device
//   openManager()                   → open the manager modal
//   startPairing()                  → show QR for a new device to scan
//   openScanner()                   → open camera scanner on this device
//   cancelPairing()                 → abort an in-flight pairing
//
// Conventions:
// - All API calls go through window.apiFetch when present, falling back
//   to a fetch with credentials.
// - User feedback uses UI.showToast — never alert/confirm.
// - QR generation: qrcode-generator (window.qrcode).
// - QR scanning: jsQR (window.jsQR).
// - Theme tokens drive every color; modals reuse .modal-overlay /
//   .modal-input / .modal-btn for parity with the rest of the app.
(function () {
  'use strict';

  const DEVICE_ID_KEY        = 'frogtalk.deviceId.v1';
  const DEVICE_NAME_KEY      = 'frogtalk.deviceName.v1';
  const PAIR_STATUS_INTERVAL = 1500;
  const SCAN_INTERVAL_MS     = 200;

  let _devicesCache = null;
  let _activePairing = null;   // { token, expires_at, pollId }
  let _activeScanner = null;   // { stream, video, canvas, raf }

  // ─── tiny utils ──────────────────────────────────────────────────────

  function _api(url, method = 'GET', body = null) {
    if (typeof window.apiFetch === 'function') {
      return window.apiFetch(url, method, body);
    }
    const opts = { method, credentials: 'include', headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts);
  }

  async function _apiJSON(url, method, body) {
    const res = await _api(url, method, body);
    let json = null;
    try { json = await res.json(); } catch {}
    if (!res.ok) {
      const detail = (json && (json.detail || json.error)) || res.statusText || 'error';
      const err = new Error(String(detail));
      err.status = res.status;
      err.detail = detail;
      throw err;
    }
    return json || {};
  }

  function _toast(text, type = 'info', ms = 3500) {
    if (window.UI && UI.showToast) UI.showToast(text, type, ms);
    else console.log('[Devices]', type, text);
  }

  function _b64ToBytes(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function _bytesToHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      s += bytes[i].toString(16).padStart(2, '0');
    }
    return s;
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _shortFp(bytesOrB64) {
    // 4 groups of 5 decimal digits, derived from the first 16 bytes
    // of the device identity public key. Stable, visually scannable,
    // matches the Safety-Number-style fingerprint we already use.
    let bytes;
    if (bytesOrB64 instanceof Uint8Array) bytes = bytesOrB64;
    else if (typeof bytesOrB64 === 'string') bytes = _b64ToBytes(bytesOrB64);
    else return '';
    const groups = [];
    for (let g = 0; g < 4; g++) {
      const off = g * 4;
      const n =
          (bytes[off]     << 24 >>> 0) +
          (bytes[off + 1] << 16) +
          (bytes[off + 2] <<  8) +
           bytes[off + 3];
      groups.push((n >>> 0).toString().padStart(10, '0').slice(0, 5));
    }
    return groups.join(' ');
  }

  function _humanAgo(ts) {
    if (!ts) return 'never seen';
    const dt = (Date.now() / 1000) - Number(ts);
    if (dt < 60)    return 'just now';
    if (dt < 3600)  return Math.floor(dt / 60) + ' min ago';
    if (dt < 86400) return Math.floor(dt / 3600) + ' h ago';
    return Math.floor(dt / 86400) + ' d ago';
  }

  function _getOrCreateDeviceId() {
    let id = '';
    try { id = localStorage.getItem(DEVICE_ID_KEY) || ''; } catch {}
    if (id && id.length >= 8 && id.length <= 64 && /^[0-9a-fA-F-]+$/.test(id)) return id;
    id = (crypto.randomUUID && crypto.randomUUID()) ||
         (Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0')).join('')
            .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'));
    try { localStorage.setItem(DEVICE_ID_KEY, id); } catch {}
    return id;
  }

  function _getThisDeviceName() {
    let n = '';
    try { n = localStorage.getItem(DEVICE_NAME_KEY) || ''; } catch {}
    if (n) return n;
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    // Cheap, theme-friendly default. User can rename later.
    if (/Android/i.test(ua))    return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return /iPad/i.test(ua) ? 'iPad' : 'iPhone';
    if (/Macintosh/i.test(ua))  return 'Mac';
    if (/Windows/i.test(ua))    return 'Windows';
    if (/Linux/i.test(ua))      return 'Linux';
    return platform || 'This device';
  }

  function _setThisDeviceName(n) {
    try { localStorage.setItem(DEVICE_NAME_KEY, String(n || '').slice(0, 64)); } catch {}
  }

  // ─── identity signing ────────────────────────────────────────────────

  async function _signEnrolment(deviceId, identityPubBytes) {
    if (!window.Signal || !Signal.signWithIdentity) {
      throw new Error('Signal not ready');
    }
    // Message canonical bytes: utf8(device_id) || identity_pub (32B).
    // The server stores them opaquely; peers re-derive the same bytes
    // and verify against the primary identity key they already trust
    // via TOFU / safety numbers.
    const idBytes = new TextEncoder().encode(deviceId);
    const msg = new Uint8Array(idBytes.length + identityPubBytes.length);
    msg.set(idBytes, 0);
    msg.set(identityPubBytes, idBytes.length);
    return await Signal.signWithIdentity(msg);
  }

  // ─── public API ──────────────────────────────────────────────────────

  async function list() {
    const j = await _apiJSON('/api/signal/devices/me', 'GET');
    _devicesCache = j.devices || [];
    return _devicesCache;
  }

  async function refresh() {
    try { await list(); } catch (e) { console.warn('[Devices] refresh failed', e); }
    _renderSettingsList();
    _renderManagerList();
  }

  async function registerThisDevice(nameOverride) {
    if (!window.Signal || !Signal.isReady || !Signal.isReady()) {
      _toast('Encryption is still starting — try again in a moment.', 'error');
      return null;
    }
    const deviceId = _getOrCreateDeviceId();
    const name = String(nameOverride || _getThisDeviceName()).slice(0, 64);
    const identityPubB64 = await Signal.getMyIdentityPubB64();
    const identityPubBytes = _b64ToBytes(identityPubB64);
    const sigB64 = await _signEnrolment(deviceId, identityPubBytes);
    try {
      const j = await _apiJSON('/api/signal/devices/link', 'POST', {
        device_id:    deviceId,
        name,
        identity_pub: identityPubB64,
        primary_sig:  sigB64,
      });
      _setThisDeviceName(name);
      _toast('This device is registered for encryption.', 'success');
      await refresh();
      return j.device || null;
    } catch (e) {
      if (e.detail === 'device_cap_reached') {
        _toast('Device limit reached. Revoke an old device first.', 'error', 5000);
      } else {
        _toast('Could not register this device: ' + (e.detail || e.message), 'error');
      }
      return null;
    }
  }

  async function revoke(deviceId) {
    if (!deviceId) return false;
    const thisId = _getOrCreateDeviceId();
    const isSelf = deviceId === thisId;
    const ok = await UI.confirm(isSelf
      ? 'Revoke THIS device? You will need to re-register it to receive new encrypted messages here.'
      : 'Revoke this device? It will lose access to future encrypted messages.', {
        confirmLabel: 'Revoke',
        danger: true,
      });
    if (!ok) return false;
    try {
      await _apiJSON('/api/signal/devices/' + encodeURIComponent(deviceId) + '/revoke', 'POST', {});
      _toast(isSelf ? 'This device revoked.' : 'Device revoked.', 'success');
      await refresh();
      return true;
    } catch (e) {
      _toast('Could not revoke device: ' + (e.detail || e.message), 'error');
      return false;
    }
  }

  // ─── pairing — primary side (display QR, approve claim) ──────────────

  async function startPairing() {
    cancelPairing();
    let res;
    try {
      res = await _apiJSON('/api/signal/devices/pairing/start', 'POST', {});
    } catch (e) {
      _toast('Could not start pairing: ' + (e.detail || e.message), 'error');
      return;
    }
    const token = res.token;
    const expiresAt = Number(res.expires_at);
    const payload = JSON.stringify({
      v: 1,
      type: 'frogtalk-link',
      token,
      server: location.origin,
    });
    _activePairing = { token, expires_at: expiresAt, pollId: null };

    const modal = document.getElementById('modal-link-device');
    if (!modal) {
      _toast('Pairing UI missing.', 'error');
      return;
    }
    const qrEl = document.getElementById('link-device-qr');
    const codeEl = document.getElementById('link-device-code');
    const statusEl = document.getElementById('link-device-status');
    const expiresEl = document.getElementById('link-device-expires');
    const approveBox = document.getElementById('link-device-approve');
    if (approveBox) approveBox.style.display = 'none';
    if (qrEl) {
      qrEl.innerHTML = '';
      qrEl.appendChild(_makeQrSvg(payload, 220));
    }
    if (codeEl) codeEl.textContent = token.slice(0, 8) + '…' + token.slice(-8);
    if (statusEl) statusEl.textContent = 'Waiting for the new device to scan this code…';
    if (expiresEl) expiresEl.textContent = 'Code expires in 5:00';

    modal.classList.remove('hidden');

    // tick the countdown
    let tick = null;
    function tickFn() {
      if (!_activePairing || _activePairing.token !== token) return;
      const left = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
      if (expiresEl) {
        const m = Math.floor(left / 60), s = String(left % 60).padStart(2, '0');
        expiresEl.textContent = left > 0 ? `Code expires in ${m}:${s}` : 'Code expired — generate a new one.';
      }
      if (left <= 0) {
        clearInterval(tick);
        if (_activePairing && _activePairing.pollId) clearInterval(_activePairing.pollId);
      }
    }
    tick = setInterval(tickFn, 500);
    tickFn();

    // poll for claim
    _activePairing.pollId = setInterval(async () => {
      if (!_activePairing || _activePairing.token !== token) return;
      try {
        const row = await _apiJSON('/api/signal/devices/pairing/' + encodeURIComponent(token), 'GET');
        if (row.status === 'claimed') {
          clearInterval(_activePairing.pollId);
          _activePairing.pollId = null;
          _showApproveStep(token, row);
        }
      } catch (e) {
        if (e.status === 404 || e.status === 410) {
          clearInterval(_activePairing.pollId);
          _activePairing.pollId = null;
          if (statusEl) statusEl.textContent = 'Code expired — generate a new one.';
        }
      }
    }, PAIR_STATUS_INTERVAL);
  }

  function _showApproveStep(token, row) {
    const statusEl   = document.getElementById('link-device-status');
    const approveBox = document.getElementById('link-device-approve');
    const fpEl       = document.getElementById('link-device-fp');
    const nameEl     = document.getElementById('link-device-name');
    if (statusEl) statusEl.textContent = 'New device scanned — verify the code below matches what it shows, then approve.';
    if (nameEl)   nameEl.textContent = row.device_name || 'Unnamed device';
    if (fpEl)     fpEl.textContent = _shortFp(row.identity_pub);
    if (approveBox) approveBox.style.display = '';
  }

  async function approvePairing() {
    if (!_activePairing) return;
    const token = _activePairing.token;
    const btn = document.getElementById('link-device-approve-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Approving…'; }
    try {
      const row = await _apiJSON('/api/signal/devices/pairing/' + encodeURIComponent(token), 'GET');
      if (row.status !== 'claimed') throw new Error('not_claimed');
      const idPubBytes = _b64ToBytes(row.identity_pub);
      const deviceId = (crypto.randomUUID && crypto.randomUUID()) || _getOrCreateDeviceId();
      const sigB64 = await _signEnrolment(deviceId, idPubBytes);
      await _apiJSON('/api/signal/devices/pairing/' + encodeURIComponent(token) + '/approve', 'POST', {
        device_id:   deviceId,
        primary_sig: sigB64,
        device_name: row.device_name || '',
      });
      _toast('Device linked.', 'success');
      cancelPairing();
      const modal = document.getElementById('modal-link-device');
      if (modal) modal.classList.add('hidden');
      await refresh();
    } catch (e) {
      _toast('Could not approve: ' + (e.detail || e.message), 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Approve & link'; }
    }
  }

  function cancelPairing() {
    if (_activePairing && _activePairing.pollId) {
      clearInterval(_activePairing.pollId);
    }
    _activePairing = null;
  }

  // ─── pairing — secondary side (scan QR, claim) ───────────────────────

  async function openScanner() {
    const modal = document.getElementById('modal-scan-device');
    if (!modal) { _toast('Scanner UI missing.', 'error'); return; }
    modal.classList.remove('hidden');
    const video = document.getElementById('scan-device-video');
    const statusEl = document.getElementById('scan-device-status');
    const tokenInput = document.getElementById('scan-device-token-input');
    if (tokenInput) tokenInput.value = '';
    if (statusEl) statusEl.textContent = 'Point the camera at the QR code on your other device.';

    if (!window.jsQR) { _toast('QR scanner not loaded.', 'error'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (statusEl) statusEl.textContent = 'Camera not available. Paste the code below instead.';
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, audio: false,
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      const canvas = document.createElement('canvas');
      _activeScanner = { stream, video, canvas, raf: null, lastTry: 0 };
      _scanLoop();
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Could not access camera. Paste the code manually.';
    }
  }

  function _scanLoop() {
    const s = _activeScanner;
    if (!s) return;
    const { video, canvas } = s;
    if (video.readyState >= 2 && video.videoWidth > 0) {
      const now = performance.now();
      if (now - (s.lastTry || 0) >= SCAN_INTERVAL_MS) {
        s.lastTry = now;
        const w = canvas.width = video.videoWidth;
        const h = canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (code && code.data) {
          _onScannedPayload(code.data);
          return;
        }
      }
    }
    s.raf = requestAnimationFrame(_scanLoop);
  }

  function _onScannedPayload(text) {
    closeScanner();
    let token = null;
    try {
      const j = JSON.parse(text);
      if (j && j.type === 'frogtalk-link' && j.token) token = j.token;
    } catch {
      if (/^[0-9a-fA-F]{64}$/.test(String(text).trim())) token = String(text).trim();
    }
    if (!token) { _toast('That QR code is not a FrogTalk linking code.', 'error'); return; }
    _claimToken(token);
  }

  async function submitManualToken() {
    const input = document.getElementById('scan-device-token-input');
    const raw = (input && input.value || '').trim();
    // Accept either the full 64-char hex token or a pasted JSON payload.
    let token = null;
    try {
      const j = JSON.parse(raw);
      if (j && j.token) token = j.token;
    } catch {
      if (/^[0-9a-fA-F]{64}$/.test(raw)) token = raw;
    }
    if (!token) { _toast('Paste the full code from your other device.', 'error'); return; }
    closeScanner();
    _claimToken(token);
  }

  async function _claimToken(token) {
    if (!window.Signal || !Signal.isReady || !Signal.isReady()) {
      _toast('Encryption is still starting — try again in a moment.', 'error');
      return;
    }
    const name = _getThisDeviceName();
    const identityPubB64 = await Signal.getMyIdentityPubB64();
    try {
      await _apiJSON('/api/signal/devices/pairing/' + encodeURIComponent(token) + '/claim', 'POST', {
        identity_pub: identityPubB64,
        device_name:  name,
      });
    } catch (e) {
      const m = {
        token_not_found:       'That code is not valid.',
        token_wrong_user:      'That code belongs to a different account.',
        token_expired:         'That code expired. Ask the other device to generate a new one.',
        token_already_claimed: 'That code has already been used.',
      };
      _toast(m[e.detail] || ('Could not link: ' + (e.detail || e.message)), 'error', 5000);
      return;
    }
    _toast('Waiting for your other device to approve…', 'info', 4000);
    // Poll until complete or expired.
    let tries = 0;
    const maxTries = 120;       // ~3 min at 1.5 s
    const id = setInterval(async () => {
      tries++;
      try {
        const j = await _apiJSON('/api/signal/devices/pairing/' + encodeURIComponent(token) + '/status', 'GET');
        if (j.status === 'complete') {
          clearInterval(id);
          if (j.device_id) {
            try { localStorage.setItem(DEVICE_ID_KEY, j.device_id); } catch {}
          }
          _toast('This device is now linked.', 'success');
          await refresh();
        } else if (j.status === 'expired' || j.status === 'unknown') {
          clearInterval(id);
          _toast('Linking timed out. Try again.', 'error');
        }
      } catch {}
      if (tries >= maxTries) {
        clearInterval(id);
        _toast('Linking timed out. Try again.', 'error');
      }
    }, PAIR_STATUS_INTERVAL);
  }

  function closeScanner() {
    if (_activeScanner) {
      try { if (_activeScanner.raf) cancelAnimationFrame(_activeScanner.raf); } catch {}
      try { _activeScanner.stream.getTracks().forEach(t => t.stop()); } catch {}
      _activeScanner = null;
    }
    const modal = document.getElementById('modal-scan-device');
    if (modal) modal.classList.add('hidden');
  }

  // ─── QR rendering ────────────────────────────────────────────────────

  function _makeQrSvg(text, size) {
    if (!window.qrcode) {
      const div = document.createElement('div');
      div.style.color = 'var(--text-muted, #888)';
      div.textContent = 'QR library not loaded';
      return div;
    }
    const qr = window.qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
    const count = qr.getModuleCount();
    const cell = Math.max(2, Math.floor(size / (count + 4)));
    const margin = cell * 2;
    const dim = cell * count + margin * 2;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${dim} ${dim}`);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.style.background = '#fff';
    svg.style.borderRadius = '10px';
    // build a single path for performance
    let d = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          d += `M${margin + c * cell},${margin + r * cell}h${cell}v${cell}h-${cell}z`;
        }
      }
    }
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000');
    svg.appendChild(path);
    return svg;
  }

  // ─── rendering ───────────────────────────────────────────────────────

  function _deviceCardHtml(d, opts = {}) {
    const thisId = _getOrCreateDeviceId();
    const isThis = d.device_id === thisId;
    const revoked = !!d.revoked_at;
    const name = _esc(d.name || 'Unnamed device');
    const fp = _shortFp(d.identity_pub);
    const last = _humanAgo(d.last_seen_at || d.created_at);
    const idShort = _esc(String(d.device_id).slice(0, 8));
    const badge = isThis
      ? '<span style="font-size:10px;background:var(--accent-dim,#1a3a2a);color:var(--accent-color,#4caf50);padding:2px 7px;border-radius:6px;font-weight:700;letter-spacing:.3px">THIS DEVICE</span>'
      : '';
    const revokedBadge = revoked
      ? '<span style="font-size:10px;background:rgba(244,67,54,.12);color:#f48a82;padding:2px 7px;border-radius:6px;font-weight:700">REVOKED</span>'
      : '';
    const revokeBtn = (!revoked && !opts.hideRevoke)
      ? `<button class="modal-btn" type="button" onclick="Devices.revoke('${_esc(d.device_id)}')" style="background:rgba(244,67,54,.08);border:1px solid #5a2a2a;color:#e89a92;font-size:12px;padding:6px 12px;min-height:36px">Revoke</button>`
      : '';
    return `
      <div class="device-card" style="display:flex;flex-direction:column;gap:6px;padding:12px 14px;background:var(--surface-color,#1e1e1e);border:1px solid var(--border-color,#2a2a2a);border-radius:12px${revoked ? ';opacity:.55' : ''}">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:14px;font-weight:600;color:var(--text-color,#e0e0e0);flex:1;min-width:0;word-break:break-word">${name}</span>
          ${badge} ${revokedBadge}
        </div>
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text-muted,#9bbfaf);letter-spacing:.5px">${_esc(fp)}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div style="font-size:11px;color:var(--text-muted,#7a8a82)">id ${idShort}… · ${_esc(last)}</div>
          <div>${revokeBtn}</div>
        </div>
      </div>`;
  }

  function _renderSettingsList() {
    const container = document.getElementById('linked-devices-list');
    if (!container) return;
    const devs = _devicesCache || [];
    if (devs.length === 0) {
      container.innerHTML = '<div style="font-size:12px;color:var(--text-muted,#7a8a82);padding:8px 0">No devices registered yet. Click "Register this device" to enrol this browser.</div>';
      return;
    }
    container.innerHTML = devs.map(d => _deviceCardHtml(d)).join('');
  }

  function _renderManagerList() {
    const container = document.getElementById('linked-devices-manager-list');
    if (!container) return;
    const devs = _devicesCache || [];
    if (devs.length === 0) {
      container.innerHTML = '<div style="font-size:13px;color:var(--text-muted,#7a8a82);padding:18px 0;text-align:center">No devices yet.</div>';
      return;
    }
    container.innerHTML = devs.map(d => _deviceCardHtml(d)).join('');
  }

  function openManager() {
    const modal = document.getElementById('modal-linked-devices');
    if (!modal) { _toast('Devices UI missing.', 'error'); return; }
    modal.classList.remove('hidden');
    refresh();
  }

  function closeManager() {
    const modal = document.getElementById('modal-linked-devices');
    if (modal) modal.classList.add('hidden');
  }

  function closePairing() {
    cancelPairing();
    const modal = document.getElementById('modal-link-device');
    if (modal) modal.classList.add('hidden');
  }

  // ─── auto-register this device on first run after Signal is ready ───
  // Keeps the device list non-empty in the UI without bothering the
  // user. If it fails (cap reached, etc.) we just stay silent.
  async function _autoRegister() {
    try {
      if (!window.Signal || !Signal.isReady || !Signal.isReady()) return;
      const devs = await list();
      const thisId = _getOrCreateDeviceId();
      const have = devs.find(d => d.device_id === thisId && !d.revoked_at);
      if (have) return;
      // Quiet enrolment — no toast, no UI noise on first run.
      const deviceId = thisId;
      const name = _getThisDeviceName();
      const identityPubB64 = await Signal.getMyIdentityPubB64();
      const identityPubBytes = _b64ToBytes(identityPubB64);
      const sigB64 = await _signEnrolment(deviceId, identityPubBytes);
      await _apiJSON('/api/signal/devices/link', 'POST', {
        device_id: deviceId, name, identity_pub: identityPubB64, primary_sig: sigB64,
      }).catch(() => {});
      try { await list(); } catch {}
      _renderSettingsList();
      _renderManagerList();
    } catch (e) {
      console.warn('[Devices] auto-register failed', e);
    }
  }

  // wait for Signal to be ready then quietly register this device
  let _bootTries = 0;
  const _bootId = setInterval(() => {
    _bootTries++;
    if (window.Signal && Signal.isReady && Signal.isReady()) {
      clearInterval(_bootId);
      _autoRegister();
    } else if (_bootTries > 60) {  // ~30s — give up silently
      clearInterval(_bootId);
    }
  }, 500);

  window.Devices = {
    list,
    refresh,
    registerThisDevice,
    revoke,
    openManager,
    closeManager,
    startPairing,
    approvePairing,
    cancelPairing,
    closePairing,
    openScanner,
    closeScanner,
    submitManualToken,
  };
})();
