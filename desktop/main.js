const { app, BrowserWindow, Menu, Tray, Notification, shell, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_URL = 'https://frogtalk.xyz/app';
const WEB_PARTITION = 'persist:frogtalk-web';
const AUTH_SNAPSHOT_PATH = path.join(app.getPath('userData'), 'auth-snapshot.json');

// Ensure incoming call audio can start reliably without a fresh user gesture.
try { app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); } catch {}

let mainWindow = null;
let tray = null;
let _isClosingWindow = false;

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

  mainWindow.loadURL(APP_URL);

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

  // Close button minimizes to tray so calls/messages can still arrive.
  // Use tray menu "Quit" (or OS quit) for a full exit.
  mainWindow.on('close', async (e) => {
    if (app.isQuitting || _isClosingWindow) return;
    e.preventDefault();
    try {
      await snapshotAuthFromRenderer(mainWindow);
    } catch {}
    try {
      await mainWindow.webContents.session.flushStorageData();
    } catch {}
    try { mainWindow.hide(); } catch {}
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show FrogTalk', click: () => mainWindow?.show() },
      { label: 'Minimize to tray', click: () => mainWindow?.hide() },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setToolTip('FrogTalk');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => mainWindow?.show());
  } catch (e) {
    // Tray icon might fail without a display
    console.error('Tray creation failed:', e.message);
  }
}

app.whenReady().then(() => {
  app.isQuitting = false;
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
