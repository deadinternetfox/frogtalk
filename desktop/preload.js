const { contextBridge, ipcRenderer } = require('electron');

// Expose minimal API to the renderer
contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  platform: process.platform,
  showNotification: (title, body) => {
    ipcRenderer.send('show-notification', { title, body });
  },
  getSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  setCloseToTray: (enabled) => ipcRenderer.invoke('desktop:set-close-to-tray', !!enabled),
  getLaunchOnStartup: () => ipcRenderer.invoke('desktop:get-launch-on-startup'),
  setLaunchOnStartup: (enabled) => ipcRenderer.invoke('desktop:set-launch-on-startup', !!enabled)
});
