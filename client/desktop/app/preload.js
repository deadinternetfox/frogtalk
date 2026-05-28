const { contextBridge, ipcRenderer } = require('electron');

// Expose minimal API to the renderer
contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  platform: process.platform,
  showNotification: (title, body) => {
    ipcRenderer.send('show-notification', { title, body });
  },
  getSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  getServerBaseUrl: () => ipcRenderer.invoke('desktop:get-server-base-url'),
  setServerBaseUrl: (url) => ipcRenderer.invoke('desktop:set-server-base-url', url || ''),
  setCloseToTray: (enabled) => ipcRenderer.invoke('desktop:set-close-to-tray', !!enabled),
  setBlockScreenshots: (enabled) => ipcRenderer.invoke('desktop:set-block-screenshots', !!enabled),
  getLaunchOnStartup: () => ipcRenderer.invoke('desktop:get-launch-on-startup'),
  setLaunchOnStartup: (enabled) => ipcRenderer.invoke('desktop:set-launch-on-startup', !!enabled)
});

// Minimal API used by the offline/disconnected fallback page (data-URL).
contextBridge.exposeInMainWorld('desktopOffline', {
  retry: () => ipcRenderer.invoke('desktop:offline-retry'),
  reload: () => ipcRenderer.invoke('desktop:offline-reload'),
  switchNode: () => ipcRenderer.invoke('desktop:offline-switch-node'),
});
