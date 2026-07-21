'use strict';

/**
 * preload.js — The single, audited bridge between the sandboxed renderer and
 * the main process. Nothing here exposes Node primitives; every method is an
 * explicit, promise-based RPC. Events are relayed through narrow callbacks.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  // Window chrome
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    onState: (cb) => ipcRenderer.on('window:state', (_e, s) => cb(s)),
  },

  // Encrypted vault
  vault: {
    status: () => invoke('vault:status'),
    create: (masterPassword) => invoke('vault:create', { masterPassword }),
    unlock: (masterPassword) => invoke('vault:unlock', { masterPassword }),
    unlockParked: (assertion = null) => invoke('vault:unlock-parked', assertion),
    helloOptions: (purpose) => invoke('vault:hello-options', purpose),
    lock: () => invoke('vault:lock'),
    setKeyStorageMode: (mode, registration = null) => invoke('vault:set-key-storage', { mode: String(mode || 'disabled'), registration }),
    changeMaster: (newPassword) => invoke('vault:change-master', { newPassword }),
  },

  // Accounts
  accounts: {
    list: () => invoke('accounts:list'),
    upsert: (account) => invoke('accounts:upsert', account),
    remove: (id) => invoke('accounts:remove', id),
    toggleFavorite: (id) => invoke('accounts:toggle-favorite', id),
  },

  // Riot live data + switching
  riot: {
    isRunning: () => invoke('riot:is-running'),
    currentSession: () => invoke('riot:current-session'),
    allStats: () => invoke('riot:all-stats'),
    refreshAccount: (accountId, allowLink = false) => invoke('riot:refresh-account', { accountId, allowLink }),
    switch: (id, launchGame = null) => invoke('account:switch', { id, launchGame }),
    onSwitchProgress: (cb) => ipcRenderer.on('switch:progress', (_e, p) => cb(p)),
    rankTiers: () => invoke('app:rank-tiers'),
    games: () => invoke('app:games'),
  },

  // Current authenticated Riot account chat. Main process returns only
  // display-safe fields and opaque conversation handles.
  chat: {
    friends: () => invoke('chat:friends'),
    history: (conversationId) => invoke('chat:history', conversationId),
    send: (conversationId, message) => invoke('chat:send', { conversationId, message }),
  },

  // Inventory
  inventory: {
    catalogStatus: () => invoke('inventory:catalog-status'),
    loadCatalog: (force) => invoke('inventory:load-catalog', force),
    buildCurrent: (game) => invoke('inventory:build-current', game),
    export: (payload) => invoke('inventory:export', payload),
    exportImage: (payload) => invoke('inventory:export-image', payload),
  },

  // Deceive (built-in appear-offline proxy)
  deceive: {
    getState: () => invoke('deceive:get-state'),
    setStatus: (status) => invoke('deceive:set-status', status),
    setOptions: (options) => invoke('deceive:set-options', options),
  },

  // Identity-bound game preference profiles. No filesystem paths or PUUIDs
  // cross this bridge.
  configs: {
    status: () => invoke('configs:status'),
    capture: (accountId, game) => invoke('configs:capture', { accountId, game }),
    migrate: (sourceAccountId, targetAccountId, game) => invoke('configs:migrate', { sourceAccountId, targetAccountId, game }),
    captureCloud: (accountId) => invoke('configs:capture-cloud', { accountId }),
    applyCloud: (sourceAccountId) => invoke('configs:apply-cloud', { sourceAccountId }),
    restoreCloud: (accountId) => invoke('configs:restore-cloud', { accountId }),
    removeBinding: (targetAccountId, game) => invoke('configs:remove-binding', { targetAccountId, game }),
    onActivity: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, activity) => callback(activity);
      ipcRenderer.on('configs:activity', listener);
      return () => ipcRenderer.removeListener('configs:activity', listener);
    },
  },

  // Account-bound third-party profile links. Main resolves only identities
  // already linked to a stored PUUID and verified League platform.
  profiles: {
    links: (accountId) => invoke('profiles:links', accountId),
  },

  // Instant-switch session snapshots
  session: {
    capture: (accountId, allowLink = false) => invoke('session:capture', { accountId, allowLink }),
    clear: (accountId) => invoke('session:clear', accountId),
  },

  // Packaged Windows startup registration. The main process always reads back
  // the actual OS state; development Electron.exe is never registered.
  startup: {
    get: () => invoke('startup:get'),
    set: (enabled) => invoke('startup:set', { enabled: enabled === true }),
  },

  // Settings + misc
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    pickClient: () => invoke('settings:pick-client'),
  },

  updates: {
    getState: () => invoke('updates:get-state'),
    check: () => invoke('updates:check'),
    install: () => invoke('updates:install'),
    onState: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, updateState) => callback(updateState);
      ipcRenderer.on('updates:state', listener);
      return () => ipcRenderer.removeListener('updates:state', listener);
    },
  },

  project: {
    open: (target) => invoke('app:open-project', String(target || '')),
  },

  openExternal: (url) => invoke('app:open-external', url),
});
