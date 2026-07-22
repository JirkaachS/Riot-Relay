'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupApi', {
  windowAction: (action) => ipcRenderer.invoke('setup:window-action', action),
  getContext: () => ipcRenderer.invoke('setup:get-context'),
  chooseDirectory: (currentDir) => ipcRenderer.invoke('setup:choose-directory', currentDir),
  startInstall: (options) => ipcRenderer.invoke('setup:start-install', options),
  startUninstall: (options) => ipcRenderer.invoke('setup:start-uninstall', options),
  launchApp: (exePath) => ipcRenderer.invoke('setup:launch-app', exePath),
  quit: () => ipcRenderer.invoke('setup:quit'),
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('setup:progress', listener);
    return () => ipcRenderer.removeListener('setup:progress', listener);
  },
});
