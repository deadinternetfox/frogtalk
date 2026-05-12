const { app, BrowserWindow, Menu, Tray, Notification, shell, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_URL = 'https://frogtalk.xyz/app';
const WEB_PARTITION = 'persist:frogtalk-web';
const AUTH_SNAPSHOT_PATH = path.join(app.getPath('userData'), 'auth-snapshot.json');
const DESKTOP_SETTINGS_PATH = path.join(app.getPath('userData'), 'desktop-settings.json');

// Ensure incoming call audio can start reliably without a fresh user gesture.
try { app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); } catch {}

let mainWindow = null;
let tray = null;
let _creatingTray = false;
let _isClosingWindow = false;
let _desktopSettings = {
  closeToTrayOnX: true,
};

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function readDesktopSettings() {
  try {
    const raw = fs.readFileSync(DESKTOP_SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}') || {};
    _desktopSettings = {
      ..._desktopSettings,
      closeToTrayOnX: parsed.closeToTrayOnX !== false,
    };
  } catch {
    // Keep defaults on first run or corrupted file.
  }
}

function writeDesktopSettings() {
  try {
    fs.mkdirSync(path.dirname(DESKTOP_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(DESKTOP_SETTINGS_PATH, JSON.stringify(_desktopSettings || {}, null, 2), 'utf8');
  } catch {}
}

function shouldCloseToTray() {
  return !!(_desktopSettings && _desktopSettings.closeToTrayOnX !== false);
}

function destroyTray() {
  if (!tray) return;
  try { tray.destroy(); } catch {}
  tray = null;
}

app.on('second-instance', () => {
  try {
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    // NOTE: do NOT destroyTray() here. On Linux (libappindicator) the
    // indicator can outlive the destroy() call, so the next createTray()
    // would register a second indicator and the user ends up with two
    // FrogTalk icons in the tray. Leave the tray persistent for the app's
    // lifetime instead.
  } catch {}
});

async function stopRendererMedia(win) {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.setAudioMuted(true); } catch {}
  try {
    await win.webContents.executeJavaScript(`(() => {
      try {
        const media = document.querySelectorAll('video, audio');
        media.forEach((el) => {
          try { el.pause(); } catch {}
          try { el.muted = true; } catch {}
          try { el.removeAttribute('autoplay'); } catch {}
          try { el.currentTime = 0; } catch {}
        });
      } catch {}
      try {
        if (window.Social && typeof window.Social.switchTab === 'function') {
          window.Social.switchTab('feed');
        }
      } catch {}
      try { window.dispatchEvent(new Event('frogtalk-desktop-before-close')); } catch {}
      return true;
    })()`, true);
  } catch {}
}

async function showMinimizeToTrayToast(win) {
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(`(() => {
      try {
        if (window.UI && typeof window.UI.showToast === 'function') {
          window.UI.showToast('Minimized to tray', 'success');
          return true;
        }
      } catch {}
      return false;
    })()`, true);
  } catch {}
}

function readAuthSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_SNAPSHOT_PATH, 'utf8')) || null;
  } catch {
    return null;
  }
}

function writeAuthSnapshot(data) {
  try {
    fs.mkdirSync(path.dirname(AUTH_SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(AUTH_SNAPSHOT_PATH, JSON.stringify(data || {}, null, 0), 'utf8');
  } catch {}
}

async function snapshotAuthFromRenderer(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const data = await win.webContents.executeJavaScript(`(() => ({
      token: localStorage.getItem('fc_token') || '',
      user: localStorage.getItem('fc_user') || '',
      autoLogin: localStorage.getItem('frogtalk-auto-login') || ''
    }))()`, true);
    // Respect explicit opt-out: do not keep stale auth when auto-login is off.
    if (data && data.autoLogin === 'false') {
      writeAuthSnapshot({ token: '', user: '', autoLogin: 'false' });
      return;
    }
    if (data && (data.token || data.user || data.autoLogin)) {
      writeAuthSnapshot(data);
    }
  } catch {}
}

async function tryRestoreAuthToRenderer(win) {
  if (!win || win.isDestroyed()) return false;
  const snap = readAuthSnapshot();
  if (!snap || !snap.token || !snap.user || snap.autoLogin === 'false') return false;
  try {
    const restored = await win.webContents.executeJavaScript(`(() => {
      const auto = localStorage.getItem('frogtalk-auto-login');
      if (auto === 'false') return false;
      const hasToken = !!localStorage.getItem('fc_token');
      const hasUser  = !!localStorage.getItem('fc_user');
      if (hasToken && hasUser) return false;
      localStorage.setItem('fc_token', ${JSON.stringify(snap.token)});
      localStorage.setItem('fc_user', ${JSON.stringify(snap.user)});
      if (!localStorage.getItem('frogtalk-auto-login')) localStorage.setItem('frogtalk-auto-login', 'true');
      return true;
    })()`, true);
    return !!restored;
  } catch {
    return false;
  }
}

// ── Native notification handler ──────────────────────────────────────────────
ipcMain.on('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    const notif = new Notification({
      title: title || 'FrogTalk',
      body: body || '',
      icon: path.join(__dirname, 'icon.png'),
      silent: false,
    });
    notif.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    notif.show();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    title: 'FrogTalk',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    // Identify ourselves so the web app can hide redundant "Open FrogTalk"
    // / mini-widget UI when running inside the desktop shell.
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Explicit persistent partition prevents login/session storage from
      // resetting across desktop app restarts on some Linux/Electron setups.
      partition: WEB_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: true,
      // Keep audio / WebRTC / timers running at full speed when the window is
      // hidden in the system tray. Without this, music pauses and WebSocket
      // heartbeats throttle when the user clicks away from the app.
      backgroundThrottling: false,
    }
  });

  // Prevent the OS from suspending audio/WebRTC when the window is hidden.
  mainWindow.webContents.setBackgroundThrottling(false);

  // Tag UA so the web shell (and the imageboard / Frog Channel widget) can
  // detect a genuine FrogTalk desktop client and hide redundant UI.
  try {
    const baseUA = mainWindow.webContents.getUserAgent();
    if (baseUA && !/FrogTalkDesktop/i.test(baseUA)) {
      mainWindow.webContents.setUserAgent(baseUA + ' FrogTalkDesktop/1.0');
    }
  } catch {}

  let restoredThisRun = false;
  mainWindow.webContents.on('did-finish-load', async () => {
    // Keep auth snapshot up to date.
    await snapshotAuthFromRenderer(mainWindow);
    // One-time restore pass per app run, then hard reload to let app.js boot
    // from restored localStorage.
    if (!restoredThisRun) {
      const restored = await tryRestoreAuthToRenderer(mainWindow);
      if (restored) {
        restoredThisRun = true;
        try { mainWindow.webContents.reloadIgnoringCache(); } catch {}
        return;
      }
      restoredThisRun = true;
    }
  });

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>FrogTalk</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          background:
            radial-gradient(900px 380px at 10% 0%, rgba(76,175,80,.10), transparent 60%),
            radial-gradient(900px 420px at 110% 110%, rgba(111,199,150,.08), transparent 60%),
            linear-gradient(180deg, #12231e 0%, #0a1411 60%, #08110e 100%);
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
          color: #dff5e8;
          overflow: hidden;
        }
        .load-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 18px;
          text-align: center;
          padding: 28px 36px;
          background: linear-gradient(180deg, rgba(23,48,39,.55) 0%, rgba(16,32,24,.55) 100%);
          border: 1px solid #2f5548;
          border-radius: 18px;
          box-shadow: 0 18px 48px rgba(0,0,0,.55), 0 0 0 1px rgba(76,175,80,.08);
          backdrop-filter: blur(8px);
        }
        .load-logo {
          font-size: 56px;
          margin-bottom: 4px;
          animation: bounce 1.6s ease-in-out infinite;
          filter: drop-shadow(0 4px 12px rgba(76,175,80,.35));
        }
        .load-title {
          font-size: 26px;
          font-weight: 700;
          letter-spacing: 1px;
          background: linear-gradient(135deg, #ffffff 0%, #b8f0c0 60%, #4caf50 100%);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .load-spinner {
          width: 38px;
          height: 38px;
          border: 3px solid #1f3a30;
          border-top-color: #4caf50;
          border-right-color: #6fbf7e;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }
        .load-text {
          font-size: 12px;
          color: #85a89a;
          letter-spacing: 0.8px;
          text-transform: uppercase;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-8px); }
        }
      </style>
    </head>
    <body>
      <div class="load-container">
        <div class="load-logo">🐸</div>
        <div class="load-title">FrogTalk</div>
        <div class="load-spinner"></div>
        <div class="load-text">Connecting to the pond…</div>
      </div>
    </body>
    </html>
  `)}`);
  
  setTimeout(() => {
    mainWindow.loadURL(APP_URL);
  }, 500);

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Allow camera/mic + notifications permissions needed by calls and alerts.
  try {
    mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
      const allowed = ['media', 'mediaKeySystem', 'notifications', 'clipboard-read'];
      return allowed.includes(permission);
    });
  } catch {}
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'notifications', 'clipboard-read'];
    callback(allowed.includes(permission));
  });

  // Chromium device-level permission gate used by newer Electron builds.
  try {
    if (typeof mainWindow.webContents.session.setDevicePermissionHandler === 'function') {
      mainWindow.webContents.session.setDevicePermissionHandler((details) => {
        return details.deviceType === 'audioCapture' || details.deviceType === 'videoCapture';
      });
    }
  } catch {}

  // If tray mode is enabled, X hides to tray; otherwise quit.
  // Before full quit, force-stop media and flush auth/session snapshot.
  mainWindow.on('close', async (e) => {
    if (!app.isQuitting && shouldCloseToTray()) {
      const trayReady = createTray();
      if (trayReady) {
        e.preventDefault();
        try { await showMinimizeToTrayToast(mainWindow); } catch {}
        try { mainWindow.hide(); } catch {}
        try {
          await snapshotAuthFromRenderer(mainWindow);
          await mainWindow.webContents.session.flushStorageData();
        } catch {}
        return;
      }
    }

    if (app.isQuitting) {
      try { await stopRendererMedia(mainWindow); } catch {}
      return;
    }
    if (_isClosingWindow) return;
    e.preventDefault();
    _isClosingWindow = true;
    try { await stopRendererMedia(mainWindow); } catch {}
    try {
      await snapshotAuthFromRenderer(mainWindow);
    } catch {}
    try {
      await mainWindow.webContents.session.flushStorageData();
    } catch {}
    app.isQuitting = true;
    try { mainWindow.destroy(); } catch {}
    try { app.quit(); } catch {}
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('desktop:get-settings', () => {
  return {
    closeToTrayOnX: _desktopSettings.closeToTrayOnX !== false,
    trayAvailable: process.platform !== 'linux' || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY,
  };
});

ipcMain.handle('desktop:set-close-to-tray', (_event, enabled) => {
  const next = enabled !== false;
  _desktopSettings.closeToTrayOnX = next;
  writeDesktopSettings();
  if (!next) destroyTray();
  return {
    ok: true,
    closeToTrayOnX: next,
    trayAvailable: process.platform !== 'linux' || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY,
  };
});

// ── Launch-on-startup ───────────────────────────────────────────────────────
// On Win/macOS Electron talks to the OS directly via app.setLoginItemSettings.
// On Linux that API is a no-op, so we write an XDG autostart .desktop file
// in ~/.config/autostart/ which every major DE (GNOME/KDE/Xfce/Cinnamon)
// honours. The launcher we wrote there points at process.execPath, which on
// AppImage is APPIMAGE (the mounted image path) and on .deb is the installed
// /opt/FrogTalk/frogtalk binary — both correct entry points.
const LINUX_AUTOSTART_DIR = path.join(app.getPath('home') || '', '.config', 'autostart');
const LINUX_AUTOSTART_FILE = path.join(LINUX_AUTOSTART_DIR, 'frogtalk.desktop');

function _linuxAutostartExePath() {
  // AppImage exposes its mount point via APPIMAGE; fall back to the
  // Electron-resolved exec path for .deb / source runs.
  return process.env.APPIMAGE || process.execPath || '';
}

function _readLaunchOnStartup() {
  try {
    if (process.platform === 'linux') {
      return fs.existsSync(LINUX_AUTOSTART_FILE);
    }
    const s = app.getLoginItemSettings({});
    return !!(s && s.openAtLogin);
  } catch {
    return false;
  }
}

function _writeLaunchOnStartup(enabled) {
  try {
    if (process.platform === 'linux') {
      if (enabled) {
        try { fs.mkdirSync(LINUX_AUTOSTART_DIR, { recursive: true }); } catch {}
        const exe = _linuxAutostartExePath();
        if (!exe) return false;
        // --hidden tells our main process this was launched at login so
        // future versions could choose to start minimized to tray.
        const desktop = [
          '[Desktop Entry]',
          'Type=Application',
          'Name=FrogTalk',
          'Comment=End-to-end encrypted chat',
          `Exec=${exe} --hidden`,
          'Icon=frogtalk',
          'Terminal=false',
          'Categories=Network;InstantMessaging;Chat;',
          'X-GNOME-Autostart-enabled=true',
          'StartupNotify=false',
          ''
        ].join('\n');
        fs.writeFileSync(LINUX_AUTOSTART_FILE, desktop, { encoding: 'utf8', mode: 0o644 });
        return true;
      }
      try { fs.unlinkSync(LINUX_AUTOSTART_FILE); } catch {}
      return true;
    }
    // Windows + macOS
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      // Start hidden in the tray so the OS login isn't blocked by a popup.
      openAsHidden: !!enabled,
      // On Windows we have to pass the EXE path explicitly when installed.
      path: process.execPath,
      args: enabled ? ['--hidden'] : [],
    });
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle('desktop:get-launch-on-startup', () => {
  return { enabled: _readLaunchOnStartup(), platform: process.platform };
});

ipcMain.handle('desktop:set-launch-on-startup', (_event, enabled) => {
  const ok = _writeLaunchOnStartup(enabled !== false);
  return { ok, enabled: _readLaunchOnStartup(), platform: process.platform };
});

function createTray() {
  if (tray) return true;
  if (_creatingTray) return true;
  _creatingTray = true;
  try {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    const contextMenu = Menu.buildFromTemplate([
      // Bringing the window back must NOT destroy the tray on Linux —
      // libappindicator can leak old indicators on next create() which
      // causes a duplicate FrogTalk tray icon after close→reopen. Leave
      // the tray alive for the lifetime of the app.
      { label: 'Show FrogTalk', click: () => { try { mainWindow?.show(); mainWindow?.focus(); } catch {} } },
      { label: 'Minimize to tray', click: () => mainWindow?.hide() },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setToolTip('FrogTalk');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
      try { mainWindow?.show(); mainWindow?.focus(); } catch {}
      // Persistent tray (see note above).
    });
    _creatingTray = false;
    return true;
  } catch (e) {
    // Tray icon might fail without a display
    console.error('Tray creation failed:', e.message);
    tray = null;
    _creatingTray = false;
    return false;
  }
}

app.whenReady().then(() => {
  app.isQuitting = false;
  readDesktopSettings();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  else {
    mainWindow.show();
    destroyTray();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  destroyTray();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.setAudioMuted(true); } catch {}
  }
});
