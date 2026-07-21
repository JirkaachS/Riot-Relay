'use strict';

/**
 * main.js — Electron main process for Riot Relay.
 *
 * Responsibilities:
 *   - Create the frameless main window and wire window controls.
 *   - Own the singletons: Vault (encryption), RiotClient (live data),
 *     Catalog (cosmetic metadata), and a small JSON settings store.
 *   - Expose every capability to the renderer through typed IPC handlers.
 *
 * Security posture:
 *   - contextIsolation ON, nodeIntegration OFF, sandbox-friendly preload.
 *   - The renderer never receives raw passwords or tokens — only derived,
 *     display-safe data. Secrets live in the encrypted vault + memory only.
 */

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Tray, Menu, Notification } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const packageMetadata = require('../package.json');

const { Vault } = require('./vault');
const webauthn = require('./webauthn');
const { RiotClient, RANK_TIERS, VALORANT_MAPS, VALORANT_QUEUES } = require('./riot');
const { Catalog, vtlProfileUrl, trackerProfileUrl } = require('./valorant');
const league = require('./league');
const {
  switchAccount, launchProduct, killRiotProcesses, findRiotClient, clearRiotSession, GAMES,
} = require('./switcher');
const { DeceiveProxy } = require('./deceive');
const session = require('./session');
const { assertAccountIdentity, findRosterMatches } = require('./account-identity');
const { UpdateService } = require('./updater');
const { ConfigProfiles, canonicalGame } = require('./config-profiles');

const APP_NAME = 'Riot Relay';
const LEGACY_APP_NAMES = ['Riot Account Manager', 'Arcshift', 'Vanguard'];
const VAULT_MAGIC = 'VNGRD1';

function vaultFingerprint(file) {
  const data = fs.readFileSync(file);
  if (data.length < VAULT_MAGIC.length || data.subarray(0, VAULT_MAGIC.length).toString('utf8') !== VAULT_MAGIC) {
    throw new Error('The legacy vault has an unrecognized format.');
  }
  return { size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

/** Copy the newest valid legacy app data without deleting, merging, or overwriting any vault. */
function configureUserData() {
  const appData = app.getPath('appData');
  const targetDir = path.join(appData, APP_NAME);
  const targetVault = path.join(targetDir, 'vault.dat');
  const legacy = LEGACY_APP_NAMES
    .map((name) => ({ name, dir: path.join(appData, name) }))
    .map((entry) => ({ ...entry, vault: path.join(entry.dir, 'vault.dat') }))
    .filter((entry) => fs.existsSync(entry.vault));
  let selectedDir = targetDir;

  if (!fs.existsSync(targetDir) && legacy.length) {
    const sourceEntry = legacy[0]; // Newest known predecessor wins; originals remain untouched.
    const tempDir = `${targetDir}.migrating-${process.pid}-${Date.now()}`;
    try {
      const source = vaultFingerprint(sourceEntry.vault);
      fs.cpSync(sourceEntry.dir, tempDir, { recursive: true, errorOnExist: true, force: false });
      const copied = vaultFingerprint(path.join(tempDir, 'vault.dat'));
      if (source.size !== copied.size || source.sha256 !== copied.sha256) {
        throw new Error('The copied vault did not match the source vault.');
      }
      fs.renameSync(tempDir, targetDir);
    } catch (error) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* preserve original error */ }
      selectedDir = sourceEntry.dir;
      console.warn(`${APP_NAME} could not safely migrate ${sourceEntry.name} data; continuing with the untouched source directory (${error.message}).`);
    }
  } else if (!fs.existsSync(targetVault) && legacy.length) {
    // Never merge into or overwrite a conflicting target directory.
    selectedDir = legacy[0].dir;
  }

  app.setName(APP_NAME);
  app.setPath('userData', selectedDir);
}
configureUserData();

// Set the Windows application identity before Electron creates any windows or
// taskbar registrations. Late assignment can leave the running window grouped
// under Electron instead of the packaged Riot Relay shortcut.
const WINDOWS_APP_ID = 'com.riotrelay.desktop';
if (process.platform === 'win32') app.setAppUserModelId(WINDOWS_APP_ID);

const openDevTools = process.argv.includes('--devtools');

let mainWindow = null;
let tray = null;
let trayNotification = null;
let trayNotificationWatchdog = null;
let lastTrayNotificationAt = 0;
let rendererServer = null;
let rendererOrigin = '';
let isQuitting = false;
let minimizeToTaskbarPending = false;
let vault = null;
let riot = null;
let catalog = null;
let deceiveProxy = null;
let updateService = null;
let configProfiles = null;
const chatHandleSecret = crypto.randomBytes(32);
const chatHandles = new Map();
const chatLabels = new Map();
let chatSessionPuuid = null;
let accountSwitchInProgress = false;
let activeChatOperations = 0;
const chatIdleWaiters = [];

// ---- Settings store (no secrets) -------------------------------------------

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

const DEFAULT_SETTINGS = {
  clientPath: '',
  autoFill: true,
  minimizeOnSwitch: true,
  minimizeToTray: true,
  useDeceive: false,
  deceiveStatus: 'offline', // offline | mobile | away | chat(online)
  deceivePreserveParty: true,
  deceiveActivityMode: 'hide', // preserve | hide | generic
  deceiveCustomStatus: '',
  deceiveLeagueHelper: true,
  hideLoginNames: false,
  hideDisplayNames: false,
  featureTutorialVersion: 0,
};

function knownSettings(value) {
  const input = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS)
    .filter((key) => Object.prototype.hasOwnProperty.call(input, key))
    .map((key) => [key, input[key]]));
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const raw = knownSettings(parsed);
    const merged = { ...DEFAULT_SETTINGS, ...raw };
    if (!raw.deceiveActivityMode && typeof parsed.deceiveHideGameActivity === 'boolean') {
      merged.deceiveActivityMode = parsed.deceiveHideGameActivity ? 'hide' : 'preserve';
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...knownSettings(patch) };
  const target = settingsPath();
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), { flag: 'wx' });
  const backup = `${target}.bak-${process.pid}-${Date.now()}`;
  try {
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    fs.renameSync(temp, target);
    fs.rmSync(backup, { force: true });
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    try { if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target); } catch { /* preserve original error */ }
    throw error;
  }
  return next;
}

const STARTUP_UNAVAILABLE_REASON = 'Available in installed Windows builds.';

function startupSupported() {
  return process.platform === 'win32' && app.isPackaged;
}

function startupLoginItemOptions() {
  return { path: process.execPath, args: [] };
}

function getStartupState() {
  if (!startupSupported()) {
    return { supported: false, enabled: false, reason: STARTUP_UNAVAILABLE_REASON };
  }
  const registration = app.getLoginItemSettings(startupLoginItemOptions());
  return { supported: true, enabled: registration.openAtLogin === true, reason: '' };
}

function setStartupEnabled(enabled) {
  if (!startupSupported()) return getStartupState();
  const requested = enabled === true;
  const options = startupLoginItemOptions();
  app.setLoginItemSettings({ ...options, openAtLogin: requested });
  const actual = getStartupState();
  if (actual.enabled !== requested) {
    throw new Error(`Windows did not ${requested ? 'enable' : 'disable'} startup registration.`);
  }
  return actual;
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png',
  '.ico': 'image/x-icon', '.jfif': 'image/jpeg',
};

function rendererFile(pathname) {
  const root = path.resolve(__dirname, '..');
  const decoded = decodeURIComponent(pathname === '/' ? '/renderer/index.html' : pathname);
  let base;
  let relative;
  if (decoded.startsWith('/renderer/')) { base = path.join(root, 'renderer'); relative = decoded.slice(10); }
  else if (decoded.startsWith('/build/')) { base = path.join(root, 'build'); relative = decoded.slice(7); }
  else if (decoded === '/images.jfif') return path.join(root, 'images.jfif');
  else return null;
  const target = path.resolve(base, relative);
  return target.startsWith(`${base}${path.sep}`) ? target : null;
}

function startRendererServer() {
  return new Promise((resolve, reject) => {
    rendererServer = http.createServer((request, response) => {
      try {
        if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
        const target = rendererFile(new URL(request.url, 'http://localhost').pathname);
        const extension = target && path.extname(target).toLowerCase();
        if (!target || !CONTENT_TYPES[extension] || !fs.statSync(target).isFile()) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extension], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        if (request.method === 'HEAD') response.end();
        else fs.createReadStream(target).pipe(response);
      } catch { response.writeHead(404); response.end(); }
    });
    rendererServer.once('error', reject);
    rendererServer.listen(0, 'localhost', () => {
      const address = rendererServer.address();
      rendererOrigin = `http://localhost:${address.port}`;
      webauthn.configure(rendererOrigin);
      resolve(rendererOrigin);
    });
  });
}

// ---- Window ----------------------------------------------------------------

function trayEnabled() {
  return loadSettings().minimizeToTray !== false;
}

function reconcileTray() {
  if (!app.isReady()) return;
  if (!trayEnabled()) {
    if (tray) tray.destroy();
    tray = null;
    return;
  }
  if (tray) return;
  const ico = path.join(__dirname, '..', 'build', 'icon.ico');
  const png = path.join(__dirname, '..', 'build', 'icon.png');
  try { tray = new Tray(ico); } catch { tray = new Tray(png); }
  tray.setToolTip('Riot Relay');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Riot Relay', click: () => focusMainWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => focusMainWindow());
  tray.on('double-click', () => focusMainWindow());
}

function showTrayHiddenNotification() {
  if (!tray || process.platform !== 'win32') return;
  const now = Date.now();
  if (now - lastTrayNotificationAt < 2000) return;
  lastTrayNotificationAt = now;

  const title = 'Riot Relay is still running';
  const body = 'The window was hidden to the notification area. Click this notification or the Riot Relay tray icon to restore it.';
  let settled = false;
  const clearWatchdog = () => {
    if (trayNotificationWatchdog) clearTimeout(trayNotificationWatchdog);
    trayNotificationWatchdog = null;
  };
  const showBalloonFallback = () => {
    if (settled || !tray) return;
    settled = true;
    clearWatchdog();
    try {
      tray.displayBalloon({ title, content: body, iconType: 'info', noSound: true, respectQuietTime: false });
    } catch { /* Windows may disable both app notifications and tray balloons */ }
  };

  if (!Notification.isSupported()) {
    showBalloonFallback();
    return;
  }
  try {
    clearWatchdog();
    if (trayNotification) trayNotification.close();
    const notification = new Notification({
      id: 'riot-relay-tray-hidden',
      title,
      body,
      silent: true,
      urgency: 'normal',
      timeoutType: 'default',
      icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    });
    trayNotification = notification;
    notification.once('show', () => {
      settled = true;
      clearWatchdog();
    });
    notification.once('click', () => focusMainWindow());
    notification.once('failed', showBalloonFallback);
    notification.once('close', () => {
      if (trayNotification === notification) trayNotification = null;
    });
    notification.show();
    // Some Windows notification configurations suppress the toast without a
    // failure event. Fall back only when Electron never acknowledges "show".
    trayNotificationWatchdog = setTimeout(showBalloonFallback, 1400);
    if (trayNotificationWatchdog.unref) trayNotificationWatchdog.unref();
  } catch {
    trayNotification = null;
    showBalloonFallback();
  }
}

function hideMainWindowToTray({ notify = 'if-visible' } = {}) {
  if (!mainWindow) return;
  const wasVisible = mainWindow.isVisible();
  reconcileTray();
  mainWindow.hide();
  const hidden = !mainWindow.isVisible();
  if (hidden && (notify === true || (notify === 'if-visible' && wasVisible))) showTrayHiddenNotification();
}

function minimizeMainWindow() {
  if (!mainWindow) return;
  if (trayEnabled()) hideMainWindowToTray({ notify: true });
  else mainWindow.minimize();
}

function minimizeMainWindowToTaskbar() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  minimizeToTaskbarPending = true;
  mainWindow.setSkipTaskbar(false);
  mainWindow.show();
  mainWindow.minimize();
  setTimeout(() => { minimizeToTaskbarPending = false; }, 1000).unref();
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    frame: false,
    backgroundColor: '#0b0b0e',
    show: false,
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (process.platform === 'win32') {
    mainWindow.setAppDetails({
      appId: WINDOWS_APP_ID,
      appIconPath: app.isPackaged ? process.execPath : path.join(__dirname, '..', 'build', 'icon.ico'),
      appIconIndex: 0,
      relaunchCommand: process.execPath,
      relaunchDisplayName: APP_NAME,
    });
  }

  mainWindow.loadURL(`${rendererOrigin}/renderer/index.html`);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== rendererOrigin) event.preventDefault();
    } catch { event.preventDefault(); }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (openDevTools) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Capture renderer warnings/errors to a log file for diagnostics.
  const logPath = path.join(app.getPath('userData'), 'renderer.log');
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] L${level} ${message} (${sourceId}:${line})\n`); } catch { /* ignore */ }
    }
  });







  mainWindow.on('minimize', (event) => {
    if (minimizeToTaskbarPending) {
      minimizeToTaskbarPending = false;
      return;
    }
    if (!isQuitting && trayEnabled()) {
      event.preventDefault();
      // Native taskbar minimize can flip isVisible() before this event reaches
      // Electron, so explicitly request the tray notice instead of inferring it.
      hideMainWindowToTray({ notify: true });
    }
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting && trayEnabled()) {
      event.preventDefault();
      hideMainWindowToTray({ notify: true });
    }
  });
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state', { maximized: false }));
  mainWindow.on('closed', () => (mainWindow = null));
}

// Only one Riot Relay may run at a time. Closing the window minimizes to the
// tray (the process keeps running), so a second launch must surface the
// existing instance instead of starting a duplicate that fights over the tray,
// the renderer server, and the Deceive proxy/ports.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // A second launch can arrive while the asynchronous renderer server is
    // still starting. The primary startup path will create the window once a
    // valid origin exists; never create an invalid or duplicate window here.
    if (gotSingleInstanceLock && rendererOrigin) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  focusMainWindow();
});

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  app.setAppUserModelId(WINDOWS_APP_ID);
  const dir = app.getPath('userData');
  vault = new Vault(dir, safeStorage);
  riot = new RiotClient();
  catalog = new Catalog(dir);
  configProfiles = new ConfigProfiles(dir);

  await startRendererServer();
  createWindow();
  reconcileTray();

  // If a game is still running from before Riot Relay was closed, its chat was
  // routed through our (now gone) Deceive proxy and is stuck reconnecting to a
  // dead local port. Rebind the same port + known route so the session heals
  // instead of staying broken.
  try {
    const settings = loadSettings();
    const persisted = DeceiveProxy.readPersistedSession(dir);
    if (settings.useDeceive === true && persisted && riot.isRunning()) {
      deceiveProxy = new DeceiveProxy(dir, {
        launchProduct: persisted.launchProduct,
        preserveParty: settings.deceivePreserveParty !== false,
        activityMode: settings.deceiveActivityMode || 'hide',
        customStatus: settings.deceiveCustomStatus || '',
        leagueHelper: settings.deceiveLeagueHelper !== false,
      });
      await deceiveProxy.start(settings.deceiveStatus || 'offline', {
        restorePort: persisted.chatProxyPort,
        restoreRoute: persisted.route,
      });
    }
  } catch { /* best effort; never block startup */ }

  updateService = new UpdateService({
    app,
    installerFlavor: packageMetadata.installerFlavor,
    canInstall: () => !accountSwitchInProgress && activeChatOperations === 0,
    emit: (updateState) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:state', updateState);
    },
  });
  updateService.start();
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else focusMainWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (updateService) updateService.dispose();
  if (trayNotificationWatchdog) clearTimeout(trayNotificationWatchdog);
  trayNotificationWatchdog = null;
  if (trayNotification) trayNotification.close();
  trayNotification = null;
  if (tray) tray.destroy();
  tray = null;
  if (rendererServer) rendererServer.close();
  rendererServer = null;
  if (deceiveProxy) deceiveProxy.stop();
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  if (!isQuitting && trayEnabled()) {
    reconcileTray();
    return;
  }
  app.quit();
});

// ---- IPC helpers -----------------------------------------------------------

function ok(data) { return { ok: true, data }; }
function fail(err) { return { ok: false, error: safeError(err, 'Operation failed.') }; }

function handle(channel, fn) {
  ipcMain.handle(channel, async (_evt, ...args) => {
    try { return ok(await fn(...args)); }
    catch (err) { return fail(err); }
  });
}

const CONFIG_ACTIVITY_OPERATIONS = Object.freeze({
  'configs:capture-cloud': 'capture',
  'configs:apply-cloud': 'apply',
  'configs:restore-cloud': 'restore',
});

function emitConfigActivity(channel, stage, outcome = 'info', detail = '') {
  const operation = CONFIG_ACTIVITY_OPERATIONS[channel];
  if (!operation) return;
  const record = { time: new Date().toISOString(), operation, stage, outcome };
  if (detail) record.detail = safeError(detail, 'Operation failed.');
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'config-operations.log'), `${JSON.stringify(record)}\n`); }
  catch { /* diagnostics must never break configuration operations */ }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('configs:activity', record);
}

function handleTrusted(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const senderOrigin = new URL(event.senderFrame && event.senderFrame.url || '').origin;
      if (!rendererOrigin || senderOrigin !== rendererOrigin) throw new Error('Untrusted renderer request.');
      emitConfigActivity(channel, 'started');
      const result = await fn(...args);
      emitConfigActivity(channel, 'completed', 'good');
      return ok(result);
    } catch (err) {
      emitConfigActivity(channel, 'failed', 'bad', err);
      return fail(err);
    }
  });
}

function appendSwitchLog(event, details = {}) {
  const record = { time: new Date().toISOString(), event, ...details };
  const line = `[switch:${event}] ${JSON.stringify(record)}`;
  if (event === 'FAILED') console.error(line);
  else console.log(line);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'switch.log'), `${JSON.stringify(record)}\n`);
  } catch { /* diagnostics must never break switching */ }
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const LEGACY_PROVIDER_IDENTITY_ERROR = /(?:platform probes?.*PUUID.*(?:missing|match)|PUUID was missing|duplicate exact Riot ID rows without a matching provider PUUID|OP\.GG(?: TFT)? returned a PUUID that did not match)/i;

function displaySafeStats(stats) {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return stats;
  const result = { ...stats };
  for (const game of ['valorant', 'league', 'tft']) {
    const section = stats[game];
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
    const next = { ...section };
    let legacy = false;
    for (const key of ['error', 'providerError']) {
      if (!next[key]) continue;
      if (game !== 'valorant' && LEGACY_PROVIDER_IDENTITY_ERROR.test(String(next[key]))) {
        next[key] = 'Provider identity rules changed; sync this account to refresh its verified platform data.';
        legacy = true;
      } else next[key] = safeError(next[key], `${game} data is unavailable.`);
    }
    if (legacy) next.refreshNeeded = true;
    result[game] = next;
  }
  return result;
}

/** Tag accounts only when a manifest-backed, identity-bound snapshot is valid. */
function annotate(accounts) {
  const userData = app.getPath('userData');
  return (accounts || []).map((account) => {
    const { manifest, ...sessionStatus } = session.validateSession(userData, account.id, account);
    return {
      ...account,
      stats: displaySafeStats(account.stats),
      session: sessionStatus,
      hasSession: sessionStatus.available && sessionStatus.identityVerified,
    };
  });
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sameIdentity(a, b) { return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }
function exactPuuidMatch(observed, expected) {
  const actual = String(observed || '').trim();
  const target = String(expected || '').trim();
  return !!actual && !!target && actual === target;
}
function safeError(error, fallback) {
  let message = String(error && error.message ? error.message : error || fallback || 'Operation failed.');
  message = message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(authorization|access[_-]?token|refresh[_-]?token|token|password|secret)\b["']?\s*[:=]\s*["']?[^"'\s,;}]+/gi, '$1=[redacted]')
    .replace(/\/players\/[^/?\s"'<>]+/gi, '/players/[redacted]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>]*/g, '[redacted-path]')
    .replace(/\\\\[^\\\s]+\\[^\r\n"'<>]*/g, '[redacted-path]')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '[redacted-id]')
    .replace(/\b(puuid|uuid|accountId|processId|pid)\b["']?\s*[:=]\s*["']?[^"'\s,;}]+/gi, '$1=[redacted-id]')
    .replace(/\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g, '[redacted-id]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return message.slice(0, 180);
}

function safeProgressLabel(label) {
  return safeError(label, 'Switch in progress.')
    .replace(/\b(?:pid|processId|class|windowClass|size)\s*=\s*[^\s,;]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 180) || 'Switch in progress.';
}

function rawChatId(value) {
  if (!value || typeof value !== 'object') return '';
  return String(value.cid || value.conversationId || value.jid || value.pid || value.puuid || value.id || '').trim();
}

function chatHandle(rawId) {
  const raw = String(rawId || '').trim();
  if (!raw || raw.length > 512 || /[\u0000-\u001f\u007f]/.test(raw)) return '';
  const handle = crypto.createHmac('sha256', chatHandleSecret).update(raw).digest('base64url').slice(0, 32);
  chatHandles.set(handle, raw);
  return handle;
}

function invalidateChatSession() {
  chatHandles.clear();
  chatLabels.clear();
  chatSessionPuuid = null;
}

async function runChatOperation(operation) {
  if (accountSwitchInProgress) throw new Error('Account switching is in progress. Retry chat after the requested identity is verified.');
  activeChatOperations += 1;
  try {
    if (accountSwitchInProgress) throw new Error('Account switching is in progress.');
    return await operation();
  } finally {
    activeChatOperations -= 1;
    if (activeChatOperations === 0) chatIdleWaiters.splice(0).forEach((resolve) => resolve());
  }
}

async function runAccountSwitch(operation) {
  if (accountSwitchInProgress) throw new Error('Another account switch is already in progress.');
  accountSwitchInProgress = true;
  invalidateChatSession();
  if (activeChatOperations > 0) await new Promise((resolve) => chatIdleWaiters.push(resolve));
  try { return await operation(); }
  finally {
    invalidateChatSession();
    accountSwitchInProgress = false;
  }
}

async function activeChatSession() {
  if (accountSwitchInProgress) throw new Error('Account switching is in progress.');
  const live = await riot.resolveChatSession();
  if (!live.puuid) throw new Error('Riot chat is not ready. Sign in and wait for the friends list to load.');
  if (!sameIdentity(chatSessionPuuid, live.puuid)) {
    invalidateChatSession();
    chatSessionPuuid = live.puuid;
  }
  return live;
}

async function verifyChatSession(expected) {
  const current = await riot.resolveChatSession();
  if (accountSwitchInProgress || !sameIdentity(current.puuid, expected.puuid)) {
    invalidateChatSession();
    throw new Error('The active Riot identity changed during the chat request. Refresh chat and try again.');
  }
  return current;
}

function chatRows(value, keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (value && Array.isArray(value[key])) return value[key];
  return [];
}

const CHAT_PRIVATE_MAX_BASE64 = 16384;
const CHAT_PRIVATE_MAX_BYTES = 12288;

function normalizedChatIdentities(value) {
  const identities = new Set();
  if (!value || typeof value !== 'object') return identities;
  const add = (rawValue) => {
    const identity = String(rawValue || '').trim().toLowerCase();
    if (!identity || identity.length > 512 || /[\u0000-\u001f\u007f]/.test(identity)) return;
    const bare = identity.split('/', 1)[0];
    identities.add(bare);
    const separator = bare.indexOf('@');
    if (separator > 0) identities.add(bare.slice(0, separator));
  };
  const sources = [value, value.identity, value.player, value.user, value.account]
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
  for (const source of sources) {
    ['puuid', 'PUUID', 'subject', 'Subject', 'pid', 'PID', 'jid', 'JID'].forEach((key) => add(source[key]));
  }
  return identities;
}

function normalizedChatAvailability(value) {
  const availability = String(value || '').trim().toLowerCase();
  if (availability === 'chat' || availability === 'online' || availability === 'away'
    || availability === 'mobile' || availability === 'dnd') return availability;
  return 'offline';
}

function decodePrivatePresence(value) {
  if (typeof value !== 'string') return null;
  const encoded = value.trim();
  if (!encoded || encoded.length > CHAT_PRIVATE_MAX_BASE64 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(encoded)) return null;
  try {
    const bytes = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (!bytes.length || bytes.length > CHAT_PRIVATE_MAX_BYTES) return null;
    const parsed = JSON.parse(bytes.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function knownChatProduct(presence, privateData) {
  const values = [
    presence && presence.product,
    presence && presence.productName,
    presence && presence.product_name,
    presence && presence.platform,
  ];
  if (privateData && privateData.league_of_legends) values.push('league_of_legends');
  if (privateData && privateData.lol) values.push('lol');
  if (privateData && privateData.valorant) values.push('valorant');
  for (const value of values) {
    const product = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (product === 'league_of_legends' || product === 'league' || product === 'lol') return 'league';
    if (product === 'valorant') return 'valorant';
  }
  return '';
}

function privateProductData(privateData, product) {
  if (!privateData) return {};
  const nested = product === 'league'
    ? privateData.league_of_legends || privateData.lol
    : product === 'valorant' ? privateData.valorant : null;
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : privateData;
}

const LEAGUE_PRESENCE_PHASES = {
  outofgame: '', inqueue: 'In queue', champselect: 'Champion select', championselect: 'Champion select',
  ingame: 'In game', spectating: 'Spectating', hostingcustomgame: 'Custom lobby',
};
const LEAGUE_PRESENCE_QUEUES = {
  0: 'Custom Game', 400: 'Normal Draft', 420: 'Ranked Solo/Duo', 430: 'Normal Blind',
  440: 'Ranked Flex', 450: 'ARAM', 490: 'Quickplay', 700: 'Clash', 830: 'Co-op vs AI',
  840: 'Co-op vs AI', 850: 'Co-op vs AI', 900: 'URF', 1020: 'One for All',
  1090: 'TFT Normal', 1100: 'Ranked TFT', 1130: 'TFT Hyper Roll', 1150: 'TFT Double Up',
  1300: 'Nexus Blitz', 1400: 'Ultimate Spellbook', 1700: 'Arena', 1710: 'Arena',
};
const LEAGUE_PRESENCE_QUEUE_TYPES = {
  RANKED_SOLO_5X5: 'Ranked Solo/Duo', RANKED_FLEX_SR: 'Ranked Flex', NORMAL: 'Normal',
  NORMAL_5X5_BLIND: 'Normal Blind', NORMAL_5X5_DRAFT: 'Normal Draft', ARAM_UNRANKED_5X5: 'ARAM',
  CHERRY: 'Arena', RANKED_TFT: 'Ranked TFT', RANKED_TFT_DOUBLE_UP: 'TFT Double Up',
  NORMAL_TFT: 'TFT Normal', TURBO: 'TFT Hyper Roll',
};
const LEAGUE_PRESENCE_MODES = {
  CLASSIC: 'Summoner’s Rift', ARAM: 'ARAM', CHERRY: 'Arena', TFT: 'Teamfight Tactics',
  URF: 'URF', ONEFORALL: 'One for All', ULTBOOK: 'Ultimate Spellbook', NEXUSBLITZ: 'Nexus Blitz',
};
const LEAGUE_CHAMPIONS = {
  1: 'Annie', 2: 'Olaf', 3: 'Galio', 4: 'Twisted Fate', 5: 'Xin Zhao', 6: 'Urgot', 7: 'LeBlanc',
  8: 'Vladimir', 9: 'Fiddlesticks', 10: 'Kayle', 11: 'Master Yi', 12: 'Alistar', 13: 'Ryze',
  14: 'Sion', 15: 'Sivir', 16: 'Soraka', 17: 'Teemo', 18: 'Tristana', 19: 'Warwick',
  20: 'Nunu & Willump', 21: 'Miss Fortune', 22: 'Ashe', 23: 'Tryndamere', 24: 'Jax', 25: 'Morgana',
  26: 'Zilean', 27: 'Singed', 28: 'Evelynn', 29: 'Twitch', 30: 'Karthus', 31: 'Cho’Gath',
  32: 'Amumu', 33: 'Rammus', 34: 'Anivia', 35: 'Shaco', 36: 'Dr. Mundo', 37: 'Sona',
  38: 'Kassadin', 39: 'Irelia', 40: 'Janna', 41: 'Gangplank', 42: 'Corki', 43: 'Karma',
  44: 'Taric', 45: 'Veigar', 48: 'Trundle', 50: 'Swain', 51: 'Caitlyn', 53: 'Blitzcrank',
  54: 'Malphite', 55: 'Katarina', 56: 'Nocturne', 57: 'Maokai', 58: 'Renekton', 59: 'Jarvan IV',
  60: 'Elise', 61: 'Orianna', 62: 'Wukong', 63: 'Brand', 64: 'Lee Sin', 67: 'Vayne',
  68: 'Rumble', 69: 'Cassiopeia', 72: 'Skarner', 74: 'Heimerdinger', 75: 'Nasus', 76: 'Nidalee',
  77: 'Udyr', 78: 'Poppy', 79: 'Gragas', 80: 'Pantheon', 81: 'Ezreal', 82: 'Mordekaiser',
  83: 'Yorick', 84: 'Akali', 85: 'Kennen', 86: 'Garen', 89: 'Leona', 90: 'Malzahar',
  91: 'Talon', 92: 'Riven', 96: 'Kog’Maw', 98: 'Shen', 99: 'Lux', 101: 'Xerath',
  102: 'Shyvana', 103: 'Ahri', 104: 'Graves', 105: 'Fizz', 106: 'Volibear', 107: 'Rengar',
  110: 'Varus', 111: 'Nautilus', 112: 'Viktor', 113: 'Sejuani', 114: 'Fiora', 115: 'Ziggs',
  117: 'Lulu', 119: 'Draven', 120: 'Hecarim', 121: 'Kha’Zix', 122: 'Darius', 126: 'Jayce',
  127: 'Lissandra', 131: 'Diana', 133: 'Quinn', 134: 'Syndra', 136: 'Aurelion Sol', 141: 'Kayn',
  142: 'Zoe', 143: 'Zyra', 145: 'Kai’Sa', 147: 'Seraphine', 150: 'Gnar', 154: 'Zac',
  157: 'Yasuo', 161: 'Vel’Koz', 163: 'Taliyah', 164: 'Camille', 166: 'Akshan', 200: 'Bel’Veth',
  201: 'Braum', 202: 'Jhin', 203: 'Kindred', 221: 'Zeri', 222: 'Jinx', 223: 'Tahm Kench',
  233: 'Briar', 234: 'Viego', 235: 'Senna', 236: 'Lucian', 238: 'Zed', 240: 'Kled',
  245: 'Ekko', 246: 'Qiyana', 254: 'Vi', 266: 'Aatrox', 267: 'Nami', 268: 'Azir',
  350: 'Yuumi', 360: 'Samira', 412: 'Thresh', 420: 'Illaoi', 421: 'Rek’Sai', 427: 'Ivern',
  429: 'Kalista', 432: 'Bard', 497: 'Rakan', 498: 'Xayah', 516: 'Ornn', 517: 'Sylas',
  518: 'Neeko', 523: 'Aphelios', 526: 'Rell', 555: 'Pyke', 711: 'Vex', 777: 'Yone',
  799: 'Ambessa', 800: 'Mel', 804: 'Yunara', 875: 'Sett', 876: 'Lillia', 887: 'Gwen',
  888: 'Renata Glasc', 893: 'Aurora', 895: 'Nilah', 897: 'K’Sante', 901: 'Smolder',
  902: 'Milio', 910: 'Hwei', 950: 'Naafiri',
};

function boundedPresenceInteger(value, max = 99999) {
  const text = value == null ? '' : String(value).trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 0 && number <= max ? number : null;
}

function leaguePresenceMode(details) {
  const queueId = boundedPresenceInteger(details.queueId ?? details.queue_id, 9999);
  if (queueId != null && LEAGUE_PRESENCE_QUEUES[queueId]) return LEAGUE_PRESENCE_QUEUES[queueId];
  const queueType = String(details.gameQueueType || details.queueType || '').trim().toUpperCase();
  if (LEAGUE_PRESENCE_QUEUE_TYPES[queueType]) return LEAGUE_PRESENCE_QUEUE_TYPES[queueType];
  const mode = String(details.gameMode || details.game_mode || '').trim().toUpperCase();
  return LEAGUE_PRESENCE_MODES[mode] || '';
}

function presenceValue(presence, details, aliases) {
  const sources = [
    details, details && details.identity, details && details.player,
    presence, presence && presence.identity, presence && presence.player,
  ].filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
  for (const source of sources) {
    for (const key of aliases) {
      if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined && source[key] !== null) return source[key];
    }
  }
  return undefined;
}

function safePresenceDetails(presence) {
  const availability = normalizedChatAvailability(presence && (presence.availability || presence.state));
  const privateData = decodePrivatePresence(presence && presence.private);
  const product = knownChatProduct(presence, privateData);
  if (!product) return null;
  const details = privateProductData(privateData, product);
  if (product === 'league') {
    const status = String(details.gameStatus || details.game_status || '').toLowerCase().replace(/[^a-z]/g, '');
    const phase = Object.prototype.hasOwnProperty.call(LEAGUE_PRESENCE_PHASES, status)
      ? LEAGUE_PRESENCE_PHASES[status] : '';
    const championId = boundedPresenceInteger(presenceValue(presence, details, [
      'championId', 'champion_id', 'championID', 'ChampionId', 'ChampionID',
    ]), 9999);
    const showChampion = ['champselect', 'championselect', 'ingame', 'spectating'].includes(status);
    const showMode = status && status !== 'outofgame';
    const rawIcon = presenceValue(presence, details, [
      'profileIcon', 'profileIconId', 'profileIconID', 'ProfileIcon', 'ProfileIconId', 'ProfileIconID',
      'profile_icon', 'profile_icon_id',
    ]);
    const iconValue = rawIcon == null ? '' : String(rawIcon).trim();
    const iconId = /^\d{1,9}$/.test(iconValue) ? iconValue : '';
    const platformId = league.canonicalLeaguePlatform(presenceValue(presence, details, [
      'platformId', 'platformID', 'PlatformId', 'PlatformID', 'platform_id', 'platform',
    ]));
    return {
      availability,
      game: 'League of Legends',
      platformId: platformId || null,
      activity: {
        product: 'league',
        game: 'League',
        phase,
        champion: showChampion && championId != null ? LEAGUE_CHAMPIONS[championId] || '' : '',
        mode: showMode ? leaguePresenceMode(details) : '',
      },
      avatarUrl: iconId ? `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${iconId}.jpg` : '',
    };
  }
  const state = String(details.sessionLoopState || details.session_loop_state || '').toUpperCase();
  const flow = String(details.provisioningFlow || details.partyOwnerProvisioningFlow || '').toLowerCase();
  const partyState = String(details.partyState || '').toLowerCase();
  const phase = state === 'INGAME' ? 'In game'
    : state === 'PREGAME' ? 'Agent select'
      : /matchmaking/.test(`${flow} ${partyState}`) ? 'In queue' : state === 'MENUS' ? 'In menus' : '';
  const queueKey = String(details.queueId || '').trim().toLowerCase();
  const mapPath = String(details.matchMap || details.partyOwnerMatchMap || '').replace(/\\/g, '/');
  const mapKey = mapPath.split('/').filter(Boolean).pop()?.toLowerCase() || '';
  const rawCard = String(presenceValue(presence, details, [
    'playerCardId', 'playerCardID', 'PlayerCardId', 'PlayerCardID', 'player_card_id', 'playercardid',
  ]) || '').trim();
  const cardId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(rawCard) ? rawCard.toLowerCase() : '';
  return {
    availability,
    game: 'VALORANT',
    platformId: null,
    activity: {
      product: 'valorant',
      game: 'VALORANT',
      phase,
      mode: phase === 'In menus' ? '' : VALORANT_QUEUES[queueKey] || '',
      map: state === 'PREGAME' || state === 'INGAME' ? VALORANT_MAPS[mapKey] || '' : '',
    },
    avatarUrl: cardId ? `https://media.valorant-api.com/playercards/${cardId}/smallart.png` : '',
  };
}

function activePresenceIndex(payload) {
  const index = new Map();
  const rank = { chat: 3, online: 3, away: 2, mobile: 2, dnd: 1 };
  for (const presence of chatRows(payload, ['presences', 'data'])) {
    const safe = safePresenceDetails(presence);
    if (!safe) continue;
    for (const identity of normalizedChatIdentities(presence)) {
      const current = index.get(identity);
      if (!current || (rank[safe.availability] || 0) > (rank[current.availability] || 0)) index.set(identity, safe);
    }
  }
  return index;
}

function friendProfileLinks(riotId, platformId) {
  if (!/^.{1,128}#[^#]{1,128}$/.test(String(riotId || '').trim())) return {};
  try {
    const links = {
      tracker: trackerProfileUrl(riotId),
      vtl: vtlProfileUrl(riotId),
      dpm: league.dpmProfileUrl(riotId),
    };
    const canonicalPlatform = league.canonicalLeaguePlatform(platformId);
    if (canonicalPlatform) Object.assign(links, league.profileLinks(riotId, canonicalPlatform));
    return links;
  } catch { return {}; }
}

function normalizeChatFriend(friend, presenceIndex = new Map()) {
  const raw = rawChatId(friend);
  const id = chatHandle(raw);
  if (!id) return null;
  const gameName = String(friend.game_name || friend.gameName || friend.name || friend.displayName || 'Unknown friend').slice(0, 80);
  const tagLine = String(friend.game_tag || friend.gameTag || friend.tag_line || friend.tagLine || '').slice(0, 20);
  const label = tagLine ? `${gameName}#${tagLine}` : gameName;
  const identities = normalizedChatIdentities(friend);
  for (const identity of identities) chatLabels.set(identity, label);
  chatLabels.set(raw.toLowerCase(), label);
  let presence = null;
  for (const identity of identities) {
    if (presenceIndex.has(identity)) { presence = presenceIndex.get(identity); break; }
  }
  const rosterProduct = knownChatProduct(friend, null);
  const platformId = presence && league.canonicalLeaguePlatform(presence.platformId);
  return {
    id,
    displayName: gameName,
    riotId: label,
    availability: presence ? presence.availability : normalizedChatAvailability(friend.availability || friend.state),
    game: presence ? presence.game : (rosterProduct === 'league' ? 'League of Legends' : rosterProduct === 'valorant' ? 'VALORANT' : ''),
    activity: presence && presence.activity ? presence.activity : null,
    group: String(friend.group || friend.groupName || '').slice(0, 60),
    avatarUrl: presence ? presence.avatarUrl : '',
    links: friendProfileLinks(label, platformId),
  };
}

function messageTimestamp(message) {
  const raw = message.time || message.timestamp || message.created_at || message.createdAt || message.sentAt;
  const numeric = Number(raw);
  const date = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(raw || 0);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function flattenChatMessages(payload) {
  const direct = chatRows(payload, ['messages', 'data']);
  if (direct.length) return direct.map((message) => ({ ...message, cid: message.cid || message.conversationId || payload.cid || payload.conversationId }));
  const conversations = chatRows(payload, ['conversations']);
  return conversations.flatMap((conversation) => chatRows(conversation, ['messages', 'data'])
    .map((message) => ({ ...message, cid: message.cid || conversation.cid || conversation.id })));
}

function normalizeChatMessage(message, live, fallbackRawCid = '') {
  const rawCid = String(message.cid || message.conversationId || fallbackRawCid || '').trim();
  const conversationId = chatHandle(rawCid);
  const rawAuthor = String(message.from || message.sender || message.senderId || message.author || message.puuid || '').trim();
  const self = rawAuthor && (sameIdentity(rawAuthor, live.puuid) || rawAuthor.toLowerCase().startsWith(`${String(live.puuid).toLowerCase()}@`));
  const body = String(message.body ?? message.message ?? message.text ?? '').replace(/\r\n/g, '\n').slice(0, 4000);
  if (!conversationId || !body) return null;
  const sourceId = String(message.id || message.messageId || `${rawCid}:${messageTimestamp(message) || ''}:${body}`);
  return {
    id: crypto.createHmac('sha256', chatHandleSecret).update(sourceId).digest('base64url').slice(0, 32),
    conversationId,
    authorId: rawAuthor ? chatHandle(rawAuthor) : '',
    authorName: self
      ? (live.gameName && live.tagLine ? `${live.gameName}#${live.tagLine}` : 'You')
      : (chatLabels.get(rawAuthor.toLowerCase()) || String(message.game_name || message.authorName || 'Friend').slice(0, 100)),
    body,
    timestamp: messageTimestamp(message),
    isSelf: !!self,
  };
}

function validChatHandle(value) {
  const handle = String(value || '');
  if (!/^[A-Za-z0-9_-]{32}$/.test(handle) || !chatHandles.has(handle)) throw new Error('Unknown or expired chat conversation. Refresh friends and try again.');
  return chatHandles.get(handle);
}

function validChatMessage(value) {
  const message = String(value || '').trim();
  if (!message) throw new Error('Message cannot be blank.');
  if (message.length > 1000) throw new Error('Message is too long (maximum 1000 characters).');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)) throw new Error('Message contains unsupported control characters.');
  return message;
}

function storedLeaguePlatformForLive(live) {
  if (!vault || !vault.isUnlocked() || !live || !live.puuid) return null;
  const match = vault.listAccounts().find((account) => sameIdentity(account.puuid, live.puuid));
  if (!match) return null;
  const platformId = league.canonicalLeaguePlatform(match.leaguePlatformId);
  const platformSource = String(match.leaguePlatformSource || '').trim();
  const platformVerifiedAt = String(match.leaguePlatformVerifiedAt || '').trim();
  const verifiedSources = new Set(['lcu-login-data', 'lcu-region-locale', 'opgg-discovery', 'opgg-tft-discovery']);
  if (!platformId || !verifiedSources.has(platformSource) || !Number.isFinite(Date.parse(platformVerifiedAt))) return null;
  return { platformId, platformSource, platformVerifiedAt };
}

function storedValorantRankForLive(live) {
  if (!vault || !vault.isUnlocked() || !live || !live.puuid) return null;
  const account = vault.listAccounts().find((item) => sameIdentity(item.puuid, live.puuid));
  if (!account) return null;
  const candidate = account.stats && account.stats.valorant && account.stats.valorant.rank
    ? account.stats.valorant.rank
    : {
      tier: account.rankTier,
      tierName: account.rankName,
      rr: account.rr,
      peakTier: account.peakTier,
      peakTierName: account.peakName,
      pastSeasons: [],
    };
  if (!candidate || typeof candidate !== 'object') return null;
  const tier = Number(candidate.tier);
  const tierName = String(candidate.tierName || candidate.name || '').trim();
  if ((!Number.isInteger(tier) || tier <= 0) && (!tierName || /^unranked$/i.test(tierName))) return null;
  return {
    ...candidate,
    tier: Number.isInteger(tier) && tier >= 0 && tier < RANK_TIERS.length ? tier : 0,
    tierName: tierName || RANK_TIERS[tier] || 'Ranked',
    stale: true,
    staleReason: 'Live VALORANT rank was unavailable; showing the last verified rank.',
    authoritative: false,
    authoritativeUnranked: false,
    pastSeasons: Array.isArray(candidate.pastSeasons) ? candidate.pastSeasons.slice(-20) : [],
  };
}

function verifiedLeaguePlatformPatch(live, leagueStats) {
  const platformId = league.canonicalLeaguePlatform(leagueStats && leagueStats.platformId);
  const platformSource = String(leagueStats && leagueStats.platformSource || '').trim();
  const platformVerifiedAt = String(leagueStats && leagueStats.platformVerifiedAt || '').trim();
  if (!platformId || !platformSource || !platformVerifiedAt || !live || !live.puuid
    || !leagueStats || !sameIdentity(leagueStats.puuid, live.puuid)) return {};
  return {
    leaguePlatformId: platformId,
    leaguePlatformSource: platformSource,
    leaguePlatformVerifiedAt: platformVerifiedAt,
  };
}

async function buildAllStats(live) {
  const liveRiotId = live.gameName && live.tagLine ? `${live.gameName}#${live.tagLine}` : null;
  let valorantRankError = null;
  const valorantPromise = Promise.all([
    riot.fetchRank(live).catch((error) => {
      valorantRankError = safeError(error, 'VALORANT competitive rank is unavailable.');
      return null;
    }),
    riot.fetchAccountXP(live).catch(() => ({ level: 0 })),
    riot.fetchWallet(live).catch(() => ({ vp: 0, radianite: 0, kingdom: 0 })),
    riot.fetchPlayerCard(live).catch(() => null),
  ]);
  const lcuPromise = league.buildStats(loadSettings().leaguePath)
    .then((value) => ({ value })).catch((error) => ({ error }));
  const [[freshRank, xp, wallet, playerCard], lcuResult] = await Promise.all([valorantPromise, lcuPromise]);
  const rank = freshRank || storedValorantRankForLive(live);
  const valorant = {
    available: !!rank,
    rank,
    level: xp.level || 0,
    wallet,
    playerCard,
    error: rank ? null : (valorantRankError || 'VALORANT competitive rank is unavailable.'),
    updatedAt: new Date().toISOString(),
  };

  let verifiedLcu = null;
  let lcuError = lcuResult.error ? safeError(lcuResult.error, 'League client is unavailable.') : null;
  if (!lcuResult.error) {
    const lcu = lcuResult.value;
    if (!lcu.puuid) lcuError = 'League Client did not provide a PUUID, so its data was rejected.';
    else if (!sameIdentity(lcu.puuid, live.puuid)) lcuError = 'League Client is signed into a different Riot identity.';
    else verifiedLcu = lcu;
  }

  let opggResult = { error: new Error('A complete Riot ID and live PUUID are required for OP.GG lookup.') };
  let onlineTftResult = { error: new Error('A complete Riot ID and live PUUID are required for OP.GG TFT lookup.') };
  let trustedPlatform = null;
  if (liveRiotId && live.puuid) {
    const lcuPlatform = verifiedLcu && league.canonicalLeaguePlatform(verifiedLcu.platformId);
    const storedPlatform = storedLeaguePlatformForLive(live);
    trustedPlatform = lcuPlatform
      ? {
        platformId: lcuPlatform,
        platformSource: verifiedLcu.platformSource,
        platformVerifiedAt: new Date().toISOString(),
      }
      : storedPlatform;

    const acceptOnPlatform = (promise, platform) => promise.then((value) => ({ value: {
      ...value,
      platformSource: platform.platformSource,
      platformVerifiedAt: platform.platformVerifiedAt,
    } })).catch((error) => ({ error }));
    const fetchOnPlatform = (platform) => Promise.all([
      acceptOnPlatform(league.fetchOpggStats(liveRiotId, platform.platformId, live.puuid), platform),
      acceptOnPlatform(league.fetchOpggTftStats(liveRiotId, platform.platformId, live.puuid), platform),
    ]);

    if (trustedPlatform) {
      [opggResult, onlineTftResult] = await fetchOnPlatform(trustedPlatform);
    }

    const directIdentityFailure = [opggResult.error, onlineTftResult.error]
      .some((error) => /PUUID|exact match|identity did not match/i.test(String(error && error.message || '')));
    if (!trustedPlatform || (!opggResult.value && !onlineTftResult.value && directIdentityFailure)) {
      const preferredPlatform = trustedPlatform && trustedPlatform.platformId || '';
      let leagueDiscoveryError = null;
      try {
        const discovered = await league.discoverOpggStats(liveRiotId, live.puuid, preferredPlatform, { timeoutMs: 20000 });
        trustedPlatform = {
          platformId: league.canonicalLeaguePlatform(discovered.platformId),
          platformSource: discovered.platformSource,
          platformVerifiedAt: new Date().toISOString(),
        };
        opggResult = { value: { ...discovered, ...trustedPlatform } };
        onlineTftResult = await acceptOnPlatform(
          league.fetchOpggTftStats(liveRiotId, trustedPlatform.platformId, live.puuid),
          trustedPlatform,
        );
      } catch (error) {
        leagueDiscoveryError = error;
        try {
          const discovered = await league.discoverOpggTftStats(liveRiotId, live.puuid, preferredPlatform, { timeoutMs: 20000 });
          trustedPlatform = {
            platformId: league.canonicalLeaguePlatform(discovered.platformId),
            platformSource: discovered.platformSource,
            platformVerifiedAt: new Date().toISOString(),
          };
          onlineTftResult = { value: { ...discovered, ...trustedPlatform } };
          opggResult = await acceptOnPlatform(
            league.fetchOpggStats(liveRiotId, trustedPlatform.platformId, live.puuid),
            trustedPlatform,
          );
        } catch (tftDiscoveryError) {
          if (!trustedPlatform) {
            opggResult = { error: leagueDiscoveryError };
            onlineTftResult = { error: tftDiscoveryError };
          }
        }
      }
    }
  }

  const acceptProviderStats = (value) => {
    // Weakened verification: an exact, globally-unique Riot ID on the trusted
    // platform is accepted even if OP.GG's indexed PUUID is stale/mismatched.
    // A matching provider PUUID still upgrades the recorded identity basis.
    if (!value || !sameIdentity(value.riotId, liveRiotId) || !trustedPlatform
      || league.canonicalLeaguePlatform(value.platformId) !== trustedPlatform.platformId) return null;
    const { providerPuuid, providerPuuidCorroborated, ...safeProviderStats } = value;
    const corroborated = providerPuuidCorroborated || (providerPuuid && sameIdentity(providerPuuid, live.puuid));
    return {
      ...safeProviderStats,
      puuid: live.puuid,
      identityBasis: corroborated ? 'provider-puuid-corroborated' : 'exact-riot-id+verified-platform',
    };
  };
  const verifiedOpgg = acceptProviderStats(opggResult.value);
  const opggIdentityError = opggResult.value && !verifiedOpgg
    ? 'OP.GG returned a different provider PUUID, Riot ID, or League platform, so its data was rejected.'
    : null;
  const verifiedOnlineTft = acceptProviderStats(onlineTftResult.value);
  const onlineTftIdentityError = onlineTftResult.value && !verifiedOnlineTft
    ? 'OP.GG TFT returned a different provider PUUID, Riot ID, or League platform, so its data was rejected.'
    : null;
  const verifiedTftPlatform = league.canonicalLeaguePlatform(verifiedOnlineTft && verifiedOnlineTft.platformId);

  let leagueStats;
  if (verifiedOpgg) {
    leagueStats = {
      ...verifiedOpgg,
      puuid: live.puuid,
      platformId: league.canonicalLeaguePlatform(verifiedOpgg.platformId),
      platformSource: verifiedOpgg.platformSource,
      platformVerifiedAt: verifiedOpgg.platformVerifiedAt,
      level: verifiedLcu && verifiedLcu.summonerLevel || verifiedOpgg.level || 0,
      profileIconId: verifiedLcu && verifiedLcu.profileIconId || null,
    };
  } else if (verifiedLcu) {
    const platformId = league.canonicalLeaguePlatform(verifiedLcu.platformId);
    leagueStats = {
      available: true,
      puuid: live.puuid,
      identityBasis: 'same-puuid-lcu',
      riotId: liveRiotId || verifiedLcu.riotId,
      platformId,
      platformSource: platformId ? verifiedLcu.platformSource : null,
      platformVerifiedAt: platformId && trustedPlatform ? trustedPlatform.platformVerifiedAt : null,
      level: verifiedLcu.summonerLevel,
      profileIconId: verifiedLcu.profileIconId,
      queues: verifiedLcu.league,
      pastSeasons: [],
      providerError: opggIdentityError || (opggResult.error && safeError(opggResult.error, 'OP.GG profile data is unavailable.')),
      source: 'lcu',
      updatedAt: new Date().toISOString(),
    };
  } else {
    const platformId = trustedPlatform && trustedPlatform.platformId || verifiedTftPlatform;
    const reason = opggIdentityError || (opggResult.error && safeError(opggResult.error, 'OP.GG profile data is unavailable.'));
    leagueStats = {
      available: false,
      puuid: platformId ? live.puuid : null,
      riotId: platformId ? liveRiotId : null,
      platformId: platformId || null,
      platformSource: platformId && trustedPlatform ? trustedPlatform.platformSource : null,
      platformVerifiedAt: platformId && trustedPlatform ? trustedPlatform.platformVerifiedAt : null,
      queues: [],
      pastSeasons: [],
      error: reason || 'OP.GG profile data is unavailable and League Client is not connected.',
    };
  }

  const onlineTftError = onlineTftIdentityError
    || (onlineTftResult.error && safeError(onlineTftResult.error, 'OP.GG TFT profile data is unavailable.'));
  let tftStats;
  if (verifiedLcu) {
    tftStats = {
      available: true,
      puuid: live.puuid,
      identityBasis: 'same-puuid-lcu',
      riotId: liveRiotId || verifiedLcu.riotId,
      platformId: trustedPlatform && trustedPlatform.platformId || null,
      platformSource: trustedPlatform && trustedPlatform.platformSource || null,
      platformVerifiedAt: trustedPlatform && trustedPlatform.platformVerifiedAt || null,
      level: verifiedLcu.summonerLevel,
      profileIconId: verifiedLcu.profileIconId,
      queues: verifiedLcu.tft,
      pastSeasons: verifiedOnlineTft && verifiedOnlineTft.pastSeasons || [],
      providerError: verifiedOnlineTft ? null : onlineTftError,
      source: verifiedOnlineTft ? 'lcu+opgg' : 'lcu',
      updatedAt: new Date().toISOString(),
    };
  } else if (verifiedOnlineTft) {
    tftStats = verifiedOnlineTft;
  } else {
    tftStats = {
      available: false,
      puuid: trustedPlatform ? live.puuid : null,
      riotId: trustedPlatform ? liveRiotId : null,
      platformId: trustedPlatform && trustedPlatform.platformId || null,
      platformSource: trustedPlatform && trustedPlatform.platformSource || null,
      platformVerifiedAt: trustedPlatform && trustedPlatform.platformVerifiedAt || null,
      queues: [],
      pastSeasons: [],
      error: onlineTftError || lcuError || 'League client is unavailable for TFT data.',
    };
  }

  return { valorant, league: leagueStats, tft: tftStats };
}

function portraitFromStats(live, stats) {
  const card = stats && stats.valorant && stats.valorant.playerCard;
  if (card && card.smallArt) {
    return {
      portraitSource: 'valorant',
      portraitId: card.id,
      portraitUrl: card.smallArt,
      portraitWideUrl: card.wideArt || card.largeArt || card.smallArt,
      portraitPuuid: live.puuid,
    };
  }
  const leagueStats = stats && stats.league;
  const iconId = leagueStats && leagueStats.available && leagueStats.profileIconId
    && leagueStats.puuid && sameIdentity(leagueStats.puuid, live.puuid)
    ? leagueStats.profileIconId
    : null;
  if (iconId) {
    return {
      portraitSource: 'league',
      portraitId: String(iconId),
      portraitUrl: `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${iconId}.jpg`,
      portraitWideUrl: null,
      portraitPuuid: live.puuid,
    };
  }
  return { portraitSource: 'default', portraitId: null, portraitUrl: null, portraitWideUrl: null, portraitPuuid: live.puuid };
}

async function buildCurrentSessionView(live = null, existingStats = null) {
  const active = live || await riot.resolveSession();
  const stats = existingStats || await buildAllStats(active);
  const portrait = portraitFromStats(active, stats);
  const current = {
    puuid: active.puuid,
    riotId: active.gameName && active.tagLine ? `${active.gameName}#${active.tagLine}` : null,
    gameName: active.gameName,
    tagLine: active.tagLine,
    region: active.region,
    shard: active.shard,
    leaguePlatformId: league.canonicalLeaguePlatform(stats && stats.league && stats.league.platformId),
    rank: stats.valorant.rank,
    level: stats.valorant.level,
    wallet: stats.valorant.wallet,
    stats,
    ...portrait,
  };
  current.matchingAccountIds = vault && vault.isUnlocked()
    ? findRosterMatches(vault.listAccounts(), current).map((account) => account.id)
    : [];
  return current;
}

function cachedStatsForLive(live) {
  const account = vault && vault.isUnlocked() && live && live.puuid
    ? vault.listAccounts().find((item) => sameIdentity(item.puuid, live.puuid))
    : null;
  const stored = account && displaySafeStats(account.stats);
  const validSection = (game) => {
    const section = stored && stored[game];
    if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
    if (game !== 'valorant' && (!section.puuid || !sameIdentity(section.puuid, live.puuid))) return null;
    return section;
  };
  const storedRank = storedValorantRankForLive(live);
  const platformId = account && league.canonicalLeaguePlatform(account.leaguePlatformId);
  const riotId = live && live.gameName && live.tagLine ? `${live.gameName}#${live.tagLine}` : null;
  return {
    valorant: validSection('valorant') || {
      available: Boolean(storedRank),
      rank: storedRank,
      level: Number(account && account.level || 0),
      wallet: { vp: 0, radianite: 0, kingdom: 0 },
      playerCard: null,
      error: storedRank ? null : 'Live stats are refreshing.',
    },
    league: validSection('league') || {
      available: false,
      puuid: platformId ? live.puuid : null,
      riotId: platformId ? riotId : null,
      platformId: platformId || null,
      platformSource: platformId ? account.leaguePlatformSource || null : null,
      platformVerifiedAt: platformId ? account.leaguePlatformVerifiedAt || null : null,
      queues: [],
      pastSeasons: [],
      error: 'League stats are refreshing.',
    },
    tft: validSection('tft') || {
      available: false,
      puuid: platformId ? live.puuid : null,
      riotId: platformId ? riotId : null,
      platformId: platformId || null,
      platformSource: platformId ? account.leaguePlatformSource || null : null,
      platformVerifiedAt: platformId ? account.leaguePlatformVerifiedAt || null : null,
      queues: [],
      pastSeasons: [],
      error: 'TFT stats are refreshing.',
    },
  };
}

async function buildFastCurrentSessionView(live = null) {
  const active = live || await riot.resolveChatSession();
  return buildCurrentSessionView(active, cachedStatsForLive(active));
}

async function refreshVerifiedAccountStats(accountId, expectedPuuid, game = '') {
  const before = await riot.resolveSession();
  if (!exactPuuidMatch(before && before.puuid, expectedPuuid)) return false;
  const currentSession = await buildCurrentSessionView(before);
  const after = await riot.resolveChatSession();
  if (!exactPuuidMatch(after && after.puuid, expectedPuuid)
    || !exactPuuidMatch(before.puuid, after.puuid)) return false;
  const account = vault && vault.isUnlocked()
    ? vault.listAccounts().find((item) => item.id === accountId)
    : null;
  if (!account || !exactPuuidMatch(account.puuid, expectedPuuid)) return false;
  const rank = currentSession.stats.valorant.rank;
  vault.patchAccount(accountId, {
    riotId: currentSession.riotId || account.riotId,
    ...verifiedLeaguePlatformPatch(before, currentSession.stats.league),
    level: currentSession.stats.valorant.level,
    rankTier: rank ? rank.tier : undefined,
    rankName: rank ? rank.tierName : undefined,
    rr: rank ? rank.rr : undefined,
    peakTier: rank ? rank.peakTier : undefined,
    peakName: rank ? rank.peakTierName : undefined,
    stats: currentSession.stats,
    portraitSource: currentSession.portraitSource,
    portraitId: currentSession.portraitId,
    portraitUrl: currentSession.portraitUrl,
    portraitWideUrl: currentSession.portraitWideUrl,
    portraitPuuid: currentSession.portraitPuuid,
    lastSynced: new Date().toISOString(),
  });
  return true;
}

/** Poll until the target identity is matched or a stable outcome is known. */
function settleBefore(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Verification deadline reached.')), Math.max(1, timeoutMs));
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function verifyActiveAccount(account, timeoutMs = 30000, allowUserVerification = false) {
  if (!account || !account.puuid) return { status: 'timeout', reason: 'Selected roster entry is not linked to a PUUID.' };
  const deadline = Date.now() + timeoutMs;
  let matchedPuuid = null;
  let matchedSamples = 0;
  let wrongPuuid = null;
  let wrongSamples = 0;
  let unauthenticatedSamples = 0;
  let lastLive = null;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      // Use the entitlements-based session (subject/PUUID), which becomes
      // available immediately after Riot authenticates. Chat comes up several
      // seconds later, so probing chat here caused false "not authenticated"
      // results and broke instant session restore. Two consecutive exact
      // samples still prevent a transient/stale session from completing early.
      const live = await settleBefore(riot.resolveSession(), remaining);
      if (live && live.puuid) {
        unauthenticatedSamples = 0;
        lastLive = live;
        if (sameIdentity(live.puuid, account.puuid)) {
          wrongPuuid = null;
          wrongSamples = 0;
          if (sameIdentity(live.puuid, matchedPuuid)) matchedSamples += 1;
          else { matchedPuuid = live.puuid; matchedSamples = 1; }
          if (matchedSamples >= 2) return { status: 'matched', live };
        } else {
          matchedPuuid = null;
          matchedSamples = 0;
          if (sameIdentity(live.puuid, wrongPuuid)) wrongSamples += 1;
          else { wrongPuuid = live.puuid; wrongSamples = 1; }
          if (wrongSamples >= 3) return { status: 'mismatched', live };
        }
      }
    } catch {
      matchedPuuid = null;
      matchedSamples = 0;
      // A persistent lockfile with no entitlements/session is the signed-out
      // login form. Repeated samples avoid treating normal startup as an auth
      // failure while the client is still coming up.
      unauthenticatedSamples = riot.isRunning() ? unauthenticatedSamples + 1 : 0;
      const requiredSamples = 12;
      if (!allowUserVerification && unauthenticatedSamples >= requiredSamples) {
        return { status: 'unauthenticated' };
      }
    }
    const waitMs = Math.min(1000, Math.max(0, deadline - Date.now()));
    if (waitMs) await wait(waitMs);
  }
  if (allowUserVerification && !lastLive && riot.isRunning()) {
    return {
      status: 'authentication-not-confirmed',
      reason: 'Riot did not authenticate before the continuation timeout. Verify the saved credentials or complete Riot’s verification challenge.',
    };
  }
  if (!lastLive && riot.isRunning()) return { status: 'unauthenticated' };
  return { status: 'timeout', live: lastLive || undefined };
}

async function waitForHealthyRiotSession(account, { timeoutMs = 30000, requireDeceive = false } = {}) {
  if (!account || !account.puuid) throw new Error(safeError('The selected account is not linked to a verified identity.', 'Identity verification failed.'));
  const requestedTimeout = Number(timeoutMs);
  const boundedTimeoutMs = Math.min(60000, Math.max(1000, Number.isFinite(requestedTimeout) ? requestedTimeout : 30000));
  const deadline = Date.now() + boundedTimeoutMs;
  let lastReason = '';
  let healthySamples = 0;
  let identityHealthy = false;

  const assertExpectedChatPuuid = (sessionView, phase) => {
    const observed = sessionView && sessionView.puuid;
    if (!observed) throw new Error(safeError('Riot chat identity is not ready.', 'Riot chat is not ready.'));
    if (!exactPuuidMatch(observed, account.puuid)) {
      const error = new Error(safeError(`The active Riot chat identity changed ${phase}; product launch was stopped.`, 'Riot identity changed; product launch was stopped.'));
      error.code = 'RIOT_IDENTITY_CHANGED';
      throw error;
    }
  };

  while (Date.now() < deadline) {
    try {
      let remaining = Math.max(1, deadline - Date.now());
      const beforeFriends = await settleBefore(riot.resolveChatSession(), remaining);
      assertExpectedChatPuuid(beforeFriends, 'before friends verification');

      remaining = Math.max(1, deadline - Date.now());
      await settleBefore(riot.fetchChatFriends(), remaining);

      remaining = Math.max(1, deadline - Date.now());
      const afterFriends = await settleBefore(riot.resolveChatSession(), remaining);
      assertExpectedChatPuuid(afterFriends, 'during friends verification');
      if (!exactPuuidMatch(beforeFriends.puuid, afterFriends.puuid)) {
        const error = new Error(safeError('The Riot chat identity changed during friends verification; product launch was stopped.', 'Riot identity changed; product launch was stopped.'));
        error.code = 'RIOT_IDENTITY_CHANGED';
        throw error;
      }

      healthySamples += 1;
      identityHealthy = true;
      if (healthySamples >= 2) {
        // The exact-PUUID identity and friends session are the authoritative
        // health signal. When Deceive is active we prefer to also confirm this
        // proxy instance observed the roster, but that only happens once the
        // game connects chat — which may lag behind identity readiness (or the
        // game may still be patching / waiting on PLAY). Treat it as a
        // best-effort signal, never a launch-blocking failure.
        if (requireDeceive) {
          const proxyState = deceiveProxy && deceiveProxy.getState();
          const rosterObserved = !!(proxyState && proxyState.running && proxyState.chatConnected === true);
          return { ready: true, deceiveRosterObserved: rosterObserved };
        }
        return { ready: true };
      }
    } catch (error) {
      healthySamples = 0;
      if (error && error.code === 'RIOT_IDENTITY_CHANGED') throw error;
      lastReason = safeError(error, 'Riot social services are not ready.');
    }
    const waitMs = Math.min(500, Math.max(0, deadline - Date.now()));
    if (waitMs) await wait(waitMs);
  }
  // If the identity/friends session was healthy at least once but two
  // consecutive samples did not line up before the deadline, still allow the
  // launch to proceed rather than aborting a working switch.
  if (identityHealthy) return { ready: true, deceiveRosterObserved: false };
  throw new Error(safeError(`Riot friends did not become ready. Product launch was stopped. ${lastReason || 'Retry after Riot Client finishes starting.'}`, 'Riot friends did not become ready.'));
}

// ---- Window controls -------------------------------------------------------

ipcMain.on('window:minimize', () => minimizeMainWindow());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow && mainWindow.close());

// ---- Vault -----------------------------------------------------------------

handle('vault:status', async () => {
  const parkedKeyMode = vault.parkedKeyMode();
  return {
    exists: vault.exists(),
    unlocked: vault.isUnlocked(),
    hasParkedKey: vault.hasParkedKey(),
    keyStorageMode: vault.isUnlocked() ? vault.getKeyStorageMode() : parkedKeyMode,
    parkedKeyMode,
  };
});

handle('vault:hello-options', async (purpose) => {
  if (purpose === 'register') {
    requireUnlocked();
    return webauthn.beginRegistration();
  }
  if (purpose === 'authenticate') {
    if (vault.parkedKeyMode() !== 'hello') throw new Error('Windows Hello is not enabled for this vault.');
    const credential = vault.parkedHelloCredential();
    if (!credential) throw new Error('Windows Hello enrollment is missing. Unlock with the master password and enroll again.');
    return webauthn.beginAuthentication(credential);
  }
  throw new Error('Invalid Windows Hello request.');
});

handle('vault:create', async ({ masterPassword }) => {
  if (!masterPassword || masterPassword.length < 4) throw new Error('Master password must be at least 4 characters.');
  vault.create(masterPassword);
  return annotate(vault.listAccounts());
});

handle('vault:unlock', async ({ masterPassword }) => {
  try { vault.unlock(masterPassword); }
  catch { throw new Error('Incorrect master password or the vault could not be opened.'); }
  return annotate(vault.listAccounts());
});

handle('vault:unlock-parked', async (assertion = null) => {
  const mode = vault.parkedKeyMode();
  const credential = mode === 'hello' ? vault.parkedHelloCredential() : null;
  if (mode === 'hello') webauthn.finishAuthentication(assertion, credential);
  try { vault.unlockWithParkedKey(mode, credential); }
  catch { throw new Error('The stored key is invalid, unavailable, or not enabled for this vault.'); }
  return annotate(vault.listAccounts());
});

handle('vault:lock', async () => {
  vault.lock();
  return true;
});

handle('vault:set-key-storage', async (payload) => {
  requireUnlocked();
  const requested = String(payload && typeof payload === 'object' ? payload.mode : payload || 'disabled');
  if (!['disabled', 'os', 'hello'].includes(requested)) throw new Error('Invalid OS key storage mode.');
  const credential = requested === 'hello' ? webauthn.finishRegistration(payload && payload.registration) : null;
  vault.setKeyStorageMode(requested, credential);
  return {
    mode: vault.getKeyStorageMode(),
    hasParkedKey: vault.hasParkedKey(),
  };
});

handle('vault:change-master', async ({ newPassword }) => {
  requireUnlocked();
  if (!newPassword || newPassword.length < 4) throw new Error('Master password must be at least 4 characters.');
  vault.changeMasterPassword(newPassword);
  return {
    changed: true,
    keyStorageMode: vault.getKeyStorageMode(),
    hasParkedKey: vault.hasParkedKey(),
  };
});

// ---- Accounts --------------------------------------------------------------

function requireUnlocked() {
  if (!vault.isUnlocked()) throw new Error('Vault is locked.');
}

handle('accounts:list', async () => { requireUnlocked(); return annotate(vault.listAccounts()); });

handle('accounts:upsert', async (account) => {
  requireUnlocked();
  const input = account && typeof account === 'object' ? account : {};
  const editable = {
    id: input.id,
    label: String(input.label || '').trim(),
    username: String(input.username || '').trim(),
    password: String(input.password || ''),
  };
  return annotate(vault.upsertAccount(editable));
});

handle('accounts:remove', async (id) => {
  requireUnlocked();
  session.removeSession(app.getPath('userData'), id);
  return annotate(vault.removeAccount(id));
});

handle('accounts:toggle-favorite', async (id) => {
  requireUnlocked();
  const list = vault.listAccounts();
  const acc = list.find((a) => a.id === id);
  return annotate(vault.patchAccount(id, { favorite: !(acc && acc.favorite) }));
});

// Save only a session whose live PUUID is explicitly linked to this entry.
handle('session:capture', async (payload) => {
  requireUnlocked();
  const { accountId, allowLink = false } = typeof payload === 'object' && payload ? payload : { accountId: payload };
  let account = vault.listAccounts().find((item) => item.id === accountId);
  if (!account) throw new Error('Account not found.');
  const live = await riot.resolveSession();
  const identity = assertAccountIdentity(account, live, { allowLink });
  if (identity.firstLink || !account.riotId) {
    vault.patchAccount(accountId, identity.patch);
    account = vault.listAccounts().find((item) => item.id === accountId);
  }
  session.captureSession(app.getPath('userData'), accountId, account);
  return annotate(vault.listAccounts());
});

handle('session:clear', async (accountId) => {
  requireUnlocked();
  session.removeSession(app.getPath('userData'), accountId);
  return annotate(vault.listAccounts());
});

// ---- Riot live data --------------------------------------------------------

handle('riot:is-running', async () => riot.isRunning());

handle('riot:current-session', async () => buildFastCurrentSessionView());

handle('riot:all-stats', async () => {
  const live = await riot.resolveSession();
  return buildAllStats(live);
});

/** Refresh the linked identity and all three game stat panels safely. */
handle('riot:refresh-account', async (payload) => {
  requireUnlocked();
  const { accountId, allowLink = false } = typeof payload === 'object' && payload ? payload : { accountId: payload };
  const live = await riot.resolveSession();
  const riotId = live.gameName && live.tagLine ? `${live.gameName}#${live.tagLine}` : null;

  let linkedAccount = null;
  if (accountId) {
    linkedAccount = vault.listAccounts().find((item) => item.id === accountId);
    assertAccountIdentity(linkedAccount, live, { allowLink });
  }

  const stats = await buildAllStats(live);
  const rank = stats.valorant.rank;
  const patch = {
    puuid: live.puuid,
    riotId: riotId || undefined,
    shard: live.shard,
    ...verifiedLeaguePlatformPatch(live, stats.league),
    level: stats.valorant.level,
    rankTier: rank ? rank.tier : undefined,
    rankName: rank ? rank.tierName : undefined,
    rr: rank ? rank.rr : undefined,
    peakTier: rank ? rank.peakTier : undefined,
    peakName: rank ? rank.peakTierName : undefined,
    stats,
    ...portraitFromStats(live, stats),
    lastSynced: new Date().toISOString(),
  };
  if (accountId) vault.patchAccount(accountId, patch);
  return {
    patch,
    riotId,
    stats,
    currentSession: await buildCurrentSessionView(live, stats),
    accounts: vault.isUnlocked() ? annotate(vault.listAccounts()) : [],
  };
});

// ---- Account switching -----------------------------------------------------

handle('account:switch', async (payload) => runAccountSwitch(async () => {
  requireUnlocked();
  const id = typeof payload === 'object' && payload ? payload.id : payload;
  const requestedGame = typeof payload === 'object' && payload && Object.prototype.hasOwnProperty.call(GAMES, payload.launchGame)
    ? payload.launchGame
    : null;
  const settings = loadSettings();
  const accounts = vault.listAccounts();
  let acc = accounts.find((a) => a.id === id);
  if (!acc) throw new Error('Account not found.');
  const password = vault.getAccountSecret(id);
  const userData = app.getPath('userData');
  const snapshot = session.validateSession(userData, id, acc);
  const instant = snapshot.available && snapshot.identityVerified;
  const loginMode = settings.autoFill ? 'native-required' : 'manual';
  const hasConfigBinding = !!(requestedGame && configProfiles && configProfiles.hasBinding(acc, requestedGame));

  appendSwitchLog('START', {
    loginMode,
    hasUsername: !!String(acc.username || '').trim(),
    hasPassword: !!password,
    instantCandidate: instant,
    snapshotReason: snapshot.reason || null,
    launchGame: requestedGame,
  });
  const send = (label) => {
    const publicLabel = safeProgressLabel(label);
    appendSwitchLog('STAGE', { label: publicLabel });
    if (mainWindow) mainWindow.webContents.send('switch:progress', { label: publicLabel, at: new Date().toISOString() });
  };
  const startOfflineProxy = async () => {
    if (!settings.useDeceive) return '';
    try {
      if (deceiveProxy) deceiveProxy.stop();
      deceiveProxy = new DeceiveProxy(app.getPath('userData'), {
        launchProduct: requestedGame === 'lol' || requestedGame === 'tft'
          ? 'league'
          : requestedGame === 'valorant' ? 'valorant' : 'unknown',
        preserveParty: settings.deceivePreserveParty !== false,
        activityMode: settings.deceiveActivityMode || 'hide',
        customStatus: settings.deceiveCustomStatus || '',
        leagueHelper: settings.deceiveLeagueHelper !== false,
      });
      send('Starting offline proxy…');
      const started = await deceiveProxy.start(settings.deceiveStatus || 'offline');
      return started.configUrl;
    } catch (error) {
      if (deceiveProxy) deceiveProxy.lastError = safeError(error, 'Offline proxy unavailable.');
      send('Offline proxy unavailable — launching normally.');
      return '';
    }
  };

  // Keep an already-active verified session intact unless configuration must
  // be written offline or Deceive must own the relaunched Riot connection.
  // Lookup failure remains recoverable; after an exact match, later failures
  // propagate instead of falling through into the normal destructive switch.
  let alreadyActive = null;
  if (acc.puuid) {
    try { alreadyActive = await riot.resolveSession(); }
    catch { alreadyActive = null; }
  }
  if (alreadyActive && exactPuuidMatch(alreadyActive.puuid, acc.puuid)) {
    send('Requested account is already active.');
    let configMigration = null;
    let launchRequested = false;
    let launcherAccepted = false;
    let launchVerified = false;
    if (requestedGame) {
      let restartRequired = false;
      try {
        send('Verifying the active Riot identity and friends session before restart…');
        await waitForHealthyRiotSession(acc, { timeoutMs: 30000, requireDeceive: false });
        const client = findRiotClient(settings.clientPath);
        if (!client) throw new Error('Riot Client not found. Set its path in Settings.');

        let activeConfigUrl = '';
        if (hasConfigBinding || settings.useDeceive === true) {
          send('Closing Riot processes before the offline configuration write and proxy launch…');
          await killRiotProcesses();
          restartRequired = true;
          await wait(1200);
        }
        if (settings.useDeceive === true) activeConfigUrl = await startOfflineProxy();

        if (hasConfigBinding) {
          const migrated = configProfiles.applyForTarget(acc, requestedGame);
          const changed = Number(migrated.changed || 0);
          const unchanged = Number(migrated.unchanged || 0);
          const skipped = Number(migrated.skipped || 0);
          if (skipped > 0) {
            throw new Error(`The ${GAMES[requestedGame].label} profile had ${skipped} unmapped preference file${skipped === 1 ? '' : 's'}; launch was stopped.`);
          }
          send(changed
            ? `Rewrote ${changed} allowlisted ${GAMES[requestedGame].label} preference file${changed === 1 ? '' : 's'} offline (${unchanged} already matched; backup retained). Game-start verification is pending.`
            : `All ${unchanged} allowlisted ${GAMES[requestedGame].label} preference files already matched; no live files were rewritten. Game-start verification is pending.`);
          configMigration = {
            ...migrated,
            localWriteVerified: true,
            postLaunchVerified: false,
            contentVerifiedAfterProductStart: false,
          };
        }

        send(`Sending the ${GAMES[requestedGame].label} launch request to Riot Client…`);
        launchRequested = true;
        const productLaunch = await launchProduct(client, {
          game: requestedGame,
          configUrl: activeConfigUrl,
        });
        launcherAccepted = productLaunch.launcherAccepted === true;
        launchVerified = productLaunch.launchVerified === true;
        send(launchVerified
          ? `${GAMES[requestedGame].label} is starting.`
          : `Riot Client accepted the ${GAMES[requestedGame].label} launch request. If it does not open, press PLAY in the Riot Client.`);
        await waitForHealthyRiotSession(acc, { timeoutMs: 45000, requireDeceive: Boolean(activeConfigUrl) });

        if (hasConfigBinding && configMigration) {
          const persisted = configProfiles.verifyAppliedForTarget(acc, requestedGame);
          if (!persisted.verified) {
            const failedCount = persisted.mismatched || persisted.skipped || 1;
            throw new Error(`Riot replaced or rejected ${failedCount} migrated preference file${failedCount === 1 ? '' : 's'} after the game started. The game was stopped and the migration was not reported as successful.`);
          }
          configMigration = {
            ...configMigration,
            ...persisted,
            postLaunchVerified: true,
            contentVerifiedAfterProductStart: true,
          };
          send(`Confirmed allowlisted ${GAMES[requestedGame].label} configuration contents after the game process started.`);
        }
      } catch (error) {
        if (restartRequired) {
          if (deceiveProxy) deceiveProxy.stop();
          try { await killRiotProcesses(); } catch { /* preserve the authoritative health or launch error */ }
        }
        throw error;
      }
    }
    const currentSession = await buildFastCurrentSessionView(alreadyActive);
    void refreshVerifiedAccountStats(id, acc.puuid, launchVerified ? requestedGame : '')
      .catch((error) => appendSwitchLog('STATS_REFRESH_FAILED', { reason: safeError(error, 'Background stats refresh failed.') }));
    return {
      instant: true,
      mode: 'already-active',
      launchedGame: launchVerified ? requestedGame : null,
      launchRequested,
      launcherAccepted,
      launchVerified,
      verified: true,
      verification: { status: 'matched' },
      configMigration,
      currentSession,
      accounts: annotate(vault.listAccounts()),
      sessionCapture: { captured: false, reason: 'already-active' },
    };
  }

  const configUrl = await startOfflineProxy();

  let result;
  try {
    result = await switchAccount({
      clientPath: settings.clientPath,
      username: acc.username,
      password,
      loginMode,
      configUrl,
      game: requestedGame,
      instant,
      verifyAccount: acc.puuid ? ({ phase } = {}) => verifyActiveAccount(
        acc,
        phase === 'manual' || phase === 'continuation' ? 180000 : phase === 'post-login' ? 45000 : 30000,
        phase === 'manual' || phase === 'continuation' || phase === 'post-login',
      ) : null,
      onBeforeLaunch: async (step) => {
        if (instant) {
          step('Restoring identity-bound saved session…');
          try {
            session.restoreSession(userData, id, acc);
            return { instant: true };
          } catch {
            step('Saved session could not be restored — using one clean sign-in.');
            clearRiotSession();
            return { instant: false };
          }
        }
        step(snapshot.reason === 'legacy' ? 'Legacy session requires recapture — signing in normally…' : 'Preparing a clean sign-in…');
        clearRiotSession();
        return { instant: false };
      },
      onBeforeGameLaunch: requestedGame ? async (step) => {
        step('Waiting for the verified Riot friends session before product launch…');
        await waitForHealthyRiotSession(acc, { timeoutMs: 30000, requireDeceive: Boolean(configUrl) });
        if (!hasConfigBinding) return null;

        step('Closing Riot processes before the offline configuration write…');
        await killRiotProcesses();
        await wait(1200);
        const migrated = configProfiles.applyForTarget(acc, requestedGame);
        const changed = Number(migrated.changed || 0);
        const unchanged = Number(migrated.unchanged || 0);
        const skipped = Number(migrated.skipped || 0);
        if (skipped > 0) throw new Error(`The ${GAMES[requestedGame].label} profile had ${skipped} unmapped preference file${skipped === 1 ? '' : 's'}; launch was stopped.`);
        step(changed
          ? `Rewrote ${changed} allowlisted ${GAMES[requestedGame].label} preference file${changed === 1 ? '' : 's'} offline (${unchanged} already matched; backup retained). Game-start verification is pending.`
          : `All ${unchanged} allowlisted ${GAMES[requestedGame].label} preference files already matched; no live files were rewritten. Game-start verification is pending.`);
        return {
          ...migrated,
          localWriteVerified: true,
          postLaunchVerified: false,
          contentVerifiedAfterProductStart: false,
        };
      } : null,
      onAfterGameLaunch: requestedGame ? async (migration, step) => {
        step('Waiting for Riot friends after the game process started…');
        await waitForHealthyRiotSession(acc, { timeoutMs: 45000, requireDeceive: Boolean(configUrl) });
        if (!hasConfigBinding || !migration) return null;
        const persisted = configProfiles.verifyAppliedForTarget(acc, requestedGame);
        if (!persisted.verified) {
          throw new Error(`Riot replaced or rejected ${persisted.mismatched || persisted.skipped || 1} migrated preference file${(persisted.mismatched || persisted.skipped || 1) === 1 ? '' : 's'} after the game started. The game was stopped and the migration was not reported as successful.`);
        }
        step(`Confirmed allowlisted ${GAMES[requestedGame].label} configuration contents after the game process started.`);
        return { ...persisted, postLaunchVerified: true, contentVerifiedAfterProductStart: true };
      } : null,
    }, send);
  } catch (error) {
    if (error && error.code === 'PRE_GAME_LAUNCH_FAILED') {
      if (deceiveProxy) deceiveProxy.stop();
      try { await killRiotProcesses(); } catch { /* the original launch error remains authoritative */ }
    }
    appendSwitchLog('FAILED', { reason: safeError(error, 'Switch failed.') });
    focusMainWindow();
    throw error;
  }

  let sessionCapture = { captured: false, reason: result.verified ? 'not-required' : 'account-not-verified' };
  if (result.verified === true && result.verification && result.verification.status === 'matched') {
    const live = result.verification.live;
    const currentSession = await buildFastCurrentSessionView(live);
    vault.patchAccount(id, { riotId: currentSession.riotId || acc.riotId });
    acc = vault.listAccounts().find((item) => item.id === id);

    void refreshVerifiedAccountStats(id, acc.puuid, result.launchedGame || '')
      .catch((error) => appendSwitchLog('STATS_REFRESH_FAILED', { reason: safeError(error, 'Background stats refresh failed.') }));

    if (result.loginSubmitted && result.staySignedInClicked) {
      sessionCapture = { captured: false, reason: 'pending' };
      const captureAccount = acc;
      send('Account verified; persistent session capture continues in the background.');
      void session.captureWhenStable(userData, id, captureAccount, {
        sinceMs: result.submittedAt,
        timeoutMs: 12000,
        verifyIdentity: async () => {
          const active = await settleBefore(riot.resolveChatSession(), 5000);
          if (!exactPuuidMatch(active && active.puuid, captureAccount.puuid)) {
            throw new Error('The active Riot identity changed before session capture.');
          }
          return true;
        },
      }).then(() => {
        send('Verified session captured for seamless switching.');
      }).catch((error) => {
        send(`Account remained verified; background session capture was skipped (${safeError(error, 'Session capture failed.')}).`);
      });
    }

    result.currentSession = currentSession;
    result.accounts = annotate(vault.listAccounts());
  } else {
    result.accounts = annotate(vault.listAccounts());
  }
  result.sessionCapture = sessionCapture;
  result.launchedGame = result.verified === true && result.launchVerified === true
    ? (result.launchedGame || null)
    : null;
  if (result.reason) result.reason = safeError(result.reason, 'Switch needs attention.');
  if (result.verification) {
    result.verification = {
      status: result.verification.status,
      reason: result.verification.reason
        ? safeError(result.verification.reason, 'Riot identity verification needs attention.')
        : undefined,
    };
  }

  appendSwitchLog('RESULT', {
    instant: !!result.instant,
    fallback: !!result.fallback,
    verified: result.verified === true,
    verificationStatus: result.verification && result.verification.status,
    staySignedInClicked: !!result.staySignedInClicked,
    sessionCaptured: !!sessionCapture.captured,
    automationAttempted: !!result.automationAttempted,
    inputDelivered: !!result.inputDelivered,
    manualRequired: !!result.manualRequired,
    inputCode: result.inputCode || null,
    reason: result.reason || (result.verified === true ? null : sessionCapture.reason) || null,
  });
  if (result.manualRequired || result.credentialAttention
    || (result.verification && result.verification.status === 'mismatched')) focusMainWindow();
  // After a verified switch, only minimize to the taskbar. Hiding to the tray
  // made the app appear to vanish; the window must remain easily recoverable.
  if (settings.minimizeOnSwitch && mainWindow && result.verified === true) {
    try { minimizeMainWindowToTaskbar(); } catch { /* window may be gone */ }
  }
  return result;
}));

handle('deceive:get-state', async () => {
  const configured = loadSettings();
  const activityMode = configured.deceiveActivityMode || 'hide';
  const runtime = deceiveProxy ? deceiveProxy.getState() : {
    running: false,
    chatConnected: false,
    status: configured.deceiveStatus || 'offline',
    activeConnections: 0,
    connectionProducts: { league: 0, valorant: 0, unknown: 0 },
    helperConnections: 0,
    lastError: null,
    fakeFriend: 'Riot Relay',
    helperAvailable: false,
    launchProduct: 'unknown',
    clientProduct: 'unknown',
    preserveParty: configured.deceivePreserveParty !== false,
    activityMode,
    customStatus: String(configured.deceiveCustomStatus || '').slice(0, 96),
    hideGameActivity: activityMode !== 'preserve',
    leagueHelper: configured.deceiveLeagueHelper !== false,
  };
  return { enabled: !!configured.useDeceive, ...runtime };
});

handle('deceive:set-status', async (status) => {
  const normalized = ['offline', 'mobile', 'away', 'chat', 'online'].includes(String(status))
    ? (status === 'online' ? 'chat' : status) : 'offline';
  saveSettings({ deceiveStatus: normalized });
  if (deceiveProxy && deceiveProxy.isRunning()) return deceiveProxy.setStatus(normalized);
  return { status: normalized, applied: false, notifiedChats: 0 };
});

handle('deceive:set-options', async (options) => {
  const activityMode = ['preserve', 'hide', 'generic'].includes(String(options && options.activityMode))
    ? String(options.activityMode) : 'hide';
  const customStatus = String(options && options.customStatus || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 96);
  const patch = {
    deceivePreserveParty: options && options.preserveParty !== false,
    deceiveActivityMode: activityMode,
    deceiveCustomStatus: customStatus,
    deceiveLeagueHelper: options && options.leagueHelper !== false,
  };
  saveSettings(patch);
  const normalized = {
    preserveParty: patch.deceivePreserveParty,
    activityMode,
    customStatus,
    leagueHelper: patch.deceiveLeagueHelper,
  };
  if (deceiveProxy && deceiveProxy.isRunning()) return deceiveProxy.setOptions(normalized);
  return { applied: false, ...normalized };
});

// ---- Current-session Riot chat --------------------------------------------

handle('chat:friends', async () => runChatOperation(async () => {
  requireUnlocked();
  const live = await activeChatSession();
  const [friendsResult, presencesResult, messagesResult] = await Promise.allSettled([
    riot.fetchChatFriends(),
    riot.fetchChatPresences(),
    riot.fetchChatMessages(),
  ]);
  await verifyChatSession(live);
  if (friendsResult.status === 'rejected') throw friendsResult.reason;

  let presences = new Map();
  if (presencesResult.status === 'fulfilled') {
    try { presences = activePresenceIndex(presencesResult.value); } catch { presences = new Map(); }
  }
  const friends = chatRows(friendsResult.value, ['friends', 'data'])
    .map((friend) => normalizeChatFriend(friend, presences))
    .filter(Boolean)
    .sort((a, b) => {
      const onlineA = a.availability !== 'offline' ? 0 : 1;
      const onlineB = b.availability !== 'offline' ? 0 : 1;
      return onlineA - onlineB || a.riotId.localeCompare(b.riotId);
    });

  let incomingMessages = [];
  let inboxAvailable = messagesResult.status === 'fulfilled';
  if (inboxAvailable) {
    try {
      const friendHandles = new Set(friends.map((friend) => friend.id));
      incomingMessages = flattenChatMessages(messagesResult.value)
        .map((message) => normalizeChatMessage(message, live))
        .filter((message) => message && !message.isSelf && friendHandles.has(message.conversationId))
        .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
        .slice(-500)
        .map(({ id, conversationId, timestamp }) => ({ id, conversationId, timestamp }));
    } catch {
      inboxAvailable = false;
      incomingMessages = [];
    }
  }

  return {
    identity: {
      riotId: live.gameName && live.tagLine ? `${live.gameName}#${live.tagLine}` : 'Current Riot account',
      puuidHash: crypto.createHash('sha256').update(String(live.puuid)).digest('hex').slice(0, 12),
    },
    friends,
    incomingMessages,
    inboxAvailable,
  };
}));

handle('chat:history', async (conversationHandle) => runChatOperation(async () => {
  requireUnlocked();
  const live = await activeChatSession();
  const rawCid = validChatHandle(conversationHandle);
  const payload = await riot.fetchChatMessages();
  await verifyChatSession(live);
  return flattenChatMessages(payload)
    .filter((message) => sameIdentity(message.cid || message.conversationId, rawCid))
    .map((message) => normalizeChatMessage(message, live, rawCid))
    .filter(Boolean)
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
    .slice(-250);
}));

handle('chat:send', async ({ conversationId, message } = {}) => runChatOperation(async () => {
  requireUnlocked();
  const live = await activeChatSession();
  const rawCid = validChatHandle(conversationId);
  const body = validChatMessage(message);
  const response = await riot.sendChatMessage(rawCid, body);
  await verifyChatSession(live);
  const normalized = response && typeof response === 'object'
    ? normalizeChatMessage({ ...response, cid: response.cid || rawCid, body: response.body || response.message || body }, live, rawCid)
    : null;
  return normalized || { sent: true, conversationId, body, timestamp: new Date().toISOString(), isSelf: true, authorName: 'You' };
}));

// ---- Inventory -------------------------------------------------------------

handle('inventory:catalog-status', async () => catalog.stats());

handle('inventory:load-catalog', async (force) => {
  const res = await catalog.load(!!force);
  return { ...res, ...catalog.stats() };
});

handle('inventory:build-current', async (game = 'valorant') => {
  if (game === 'lol') return { game: 'lol', ...(await league.buildLeague(loadSettings().leaguePath)) };
  if (game === 'tft') return { game: 'tft', ...(await league.buildTft(loadSettings().leaguePath)) };
  if (game === 'lor') {
    throw new Error("Legends of Runeterra doesn't expose an owned-cards API we can read locally yet. VALORANT, League and TFT inventories are supported.");
  }
  const session = await riot.resolveSession();
  if (!catalog.index) await catalog.load(false);
  const [entitlements, offers, wallet] = await Promise.all([
    riot.fetchEntitlements(session),
    riot.fetchOffers(session).catch(() => ({})),
    riot.fetchWallet(session).catch(() => ({ vp: 0, radianite: 0, kingdom: 0 })),
  ]);
  const inventory = catalog.build(entitlements, offers);
  return {
    game: 'valorant',
    riotId: session.gameName && session.tagLine ? `${session.gameName}#${session.tagLine}` : session.puuid,
    wallet,
    ...inventory,
  };
});

handle('inventory:export', async ({ riotId, items, summary, format }) => {
  const hideIdentity = loadSettings().hideDisplayNames === true;
  const exportedRiotId = hideIdentity ? 'Hidden Riot ID' : String(riotId || '');
  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = (hideIdentity ? 'hidden-account' : String(riotId || 'inventory')).replace(/[#\\/:*?"<>|]/g, '_');
  const ext = format === 'csv' ? 'csv' : 'json';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export inventory',
    defaultPath: `${safeName}-inventory-${stamp}.${ext}`,
    filters: ext === 'csv'
      ? [{ name: 'CSV', extensions: ['csv'] }]
      : [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { saved: false };

  let content;
  if (ext === 'csv') {
    const header = 'Name,Type,Category,Tier,Price,Currency,Parent,Variants,Source\n';
    const rows = items.map((i) =>
      [i.name, i.type, i.category, i.tier, i.value || 0, i.currency || '', i.parent || '', i.variants || 0, i.source || '']
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    content = header + rows;
  } else {
    content = JSON.stringify({ riotId: exportedRiotId, exportedAt: new Date().toISOString(), summary, items }, null, 2);
  }
  fs.writeFileSync(result.filePath, content, 'utf8');
  return { saved: true, filePath: result.filePath };
});

handle('inventory:export-image', async ({ riotId, dataUrl, format }) => {
  const hideIdentity = loadSettings().hideDisplayNames === true;
  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = (hideIdentity ? 'hidden-account' : String(riotId || 'inventory')).replace(/[#\\/:*?"<>|]/g, '_');
  const ext = format === 'jpg' || format === 'jpeg' ? 'jpg' : 'png';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export inventory value card',
    defaultPath: `${safeName}-value-${stamp}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (result.canceled || !result.filePath) return { saved: false };
  const base64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(result.filePath, Buffer.from(base64, 'base64'));
  return { saved: true, filePath: result.filePath };
});

// ---- Settings --------------------------------------------------------------

handle('settings:get', async () => {
  const s = loadSettings();
  return {
    ...s,
    detectedClient: findRiotClient(s.clientPath),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  };
});

handle('settings:set', async (patch) => {
  const settings = saveSettings(patch && typeof patch === 'object' ? patch : {});
  reconcileTray();
  return settings;
});

handleTrusted('startup:get', async () => getStartupState());
handleTrusted('startup:set', async ({ enabled } = {}) => setStartupEnabled(enabled === true));

handle('configs:status', async () => {
  requireUnlocked();
  return configProfiles.status(vault.listAccounts());
});

handle('configs:capture', async ({ accountId, game } = {}) => {
  requireUnlocked();
  const account = vault.listAccounts().find((item) => item.id === accountId);
  if (!account) throw new Error('Account not found.');
  const namespace = canonicalGame(game);
  if (namespace === 'valorant') {
    throw new Error('Local-file VALORANT capture is disabled. Use Capture signed-in account in the cloud migration panel.');
  }
  const live = await riot.resolveSession();
  assertAccountIdentity(account, live);
  return configProfiles.capture(account, namespace);
});

handle('configs:migrate', async ({ sourceAccountId, targetAccountId, game } = {}) => {
  requireUnlocked();
  const accounts = vault.listAccounts();
  const source = accounts.find((item) => item.id === sourceAccountId);
  const target = accounts.find((item) => item.id === targetAccountId);
  if (!source || !target) throw new Error('Select a valid source and target account.');
  const namespace = canonicalGame(game);
  if (namespace === 'valorant') {
    throw new Error('Local-file VALORANT bindings are disabled. Use the exact-PUUID cloud migration panel.');
  }
  if (!source.puuid || !target.puuid) throw new Error('Both accounts must be synced and PUUID-linked first.');
  return configProfiles.migrate(source, target, namespace);
});

handle('configs:remove-binding', async ({ targetAccountId, game } = {}) => {
  requireUnlocked();
  const target = vault.listAccounts().find((item) => item.id === targetAccountId);
  if (!target) throw new Error('Target account not found.');
  return configProfiles.removeBinding(target, canonicalGame(game));
});

// Verify the requested account is the exact signed-in PUUID right now.
async function requireActiveExactAccount(account) {
  if (!account || !account.puuid) throw new Error('Select a synced, PUUID-linked account first.');
  const live = await riot.resolveSession();
  if (!live || !exactPuuidMatch(live.puuid, account.puuid)) {
    throw new Error('This must be done while the exact account is signed in to the Riot Client. Switch to it first.');
  }
  return live;
}

// Capture the complete VALORANT settings for the exact signed-in account.
handleTrusted('configs:capture-cloud', async ({ accountId } = {}) => {
  requireUnlocked();
  const account = vault.listAccounts().find((item) => item.id === accountId);
  if (!account) throw new Error('Account not found.');
  await requireActiveExactAccount(account);
  emitConfigActivity('configs:capture-cloud', 'identity-verified');
  const { json, path: playerPreferencesPath } = await riot.getPlayerSettings();
  emitConfigActivity('configs:capture-cloud', 'settings-read');
  if (!json) throw new Error('No VALORANT settings were returned. Open VALORANT once so the Riot Client loads this account’s settings, then retry.');
  // Reading can take long enough for an account switch to occur. Never bind the
  // returned document to a roster identity without checking the PUUID again.
  await requireActiveExactAccount(account);
  emitConfigActivity('configs:capture-cloud', 'identity-reverified');
  const saved = configProfiles.saveCloudSettings(account, json, playerPreferencesPath);
  emitConfigActivity('configs:capture-cloud', 'capture-saved');
  return { captured: true, capturedAt: saved.capturedAt, statuses: configProfiles.status(vault.listAccounts()) };
});

// Push a captured source blob to whichever target account is signed in RIGHT NOW.
// A durable pre-write backup and verified read-back are mandatory.
handleTrusted('configs:apply-cloud', async ({ sourceAccountId } = {}) => {
  requireUnlocked();
  const accounts = vault.listAccounts();
  // Use the explicitly chosen source. The auto-pick path remains only for
  // backwards-compatible callers that omit a source ID entirely.
  let source = sourceAccountId ? accounts.find((item) => item.id === sourceAccountId) : null;
  if (sourceAccountId && !source) throw new Error('The selected source account no longer exists.');
  let stored = source ? configProfiles.readCloudSettings(source) : null;
  if (sourceAccountId && !stored) throw new Error('The selected source account has no valid captured cloud settings. Capture it again.');
  if (!stored) {
    const captured = accounts
      .filter((item) => item.puuid)
      .map((item) => ({ item, stored: configProfiles.readCloudSettings(item) }))
      .filter((entry) => entry.stored)
      .sort((a, b) => String(b.stored.capturedAt || '').localeCompare(String(a.stored.capturedAt || '')));
    if (!captured.length) throw new Error('Capture a source account’s settings first.');
    source = captured[0].item;
    stored = captured[0].stored;
  }

  const live = await riot.resolveSession();
  if (!live || !live.puuid) throw new Error('Sign in to the target account in the Riot Client first.');
  const target = accounts.find((item) => item.puuid && exactPuuidMatch(item.puuid, live.puuid));
  if (!target) throw new Error('The signed-in Riot account is not in your roster; add and sync it first.');
  if (exactPuuidMatch(target.puuid, source.puuid)) throw new Error('The signed-in account is the source; sign in to a different target account.');
  emitConfigActivity('configs:apply-cloud', 'target-identified');

  // Refuse the mutation if the target cannot be read and durably backed up.
  const current = await riot.getPlayerSettings();
  if (!current || !current.json) {
    throw new Error('The target account’s current VALORANT settings could not be backed up, so nothing was changed. Open VALORANT to the main menu and retry.');
  }
  emitConfigActivity('configs:apply-cloud', 'target-settings-read');
  // The read may outlive the account session it began under. Recheck before
  // attributing that document to the target or replacing its one-level backup.
  await requireActiveExactAccount(target);
  const backup = configProfiles.backupCloudSettings(target, current.json, current.path);
  if (!backup || backup.backed !== true) {
    throw new Error('The target account’s VALORANT settings backup could not be saved, so nothing was changed.');
  }
  emitConfigActivity('configs:apply-cloud', 'backup-retained');

  // Re-verify the exact active identity immediately before the write.
  await requireActiveExactAccount(target);
  emitConfigActivity('configs:apply-cloud', 'identity-verified-before-write');
  const write = await riot.savePlayerSettings(stored.blob, current.path || stored.playerPreferencesPath, {
    onStage: (stage) => emitConfigActivity('configs:apply-cloud', stage),
  });
  try {
    await requireActiveExactAccount(target);
    emitConfigActivity('configs:apply-cloud', 'identity-reverified');
  } catch {
    throw new Error('The signed-in Riot identity changed during read-back verification. Settings may have been written; the target backup was retained for explicit restore.');
  }
  return {
    applied: true,
    verified: write && write.verified === true,
    targetAccountId: target.id,
    hadBackup: backup.backed === true,
    note: 'Restart VALORANT to load the migrated cloud settings.',
    statuses: configProfiles.status(vault.listAccounts()),
  };
});

// Restore the target account's pre-migration cloud settings from backup.
handleTrusted('configs:restore-cloud', async ({ accountId } = {}) => {
  requireUnlocked();
  const account = vault.listAccounts().find((item) => item.id === accountId);
  if (!account) throw new Error('Account not found.');
  const backup = configProfiles.readCloudBackup(account);
  if (!backup) throw new Error('No settings backup exists for this account.');
  emitConfigActivity('configs:restore-cloud', 'backup-loaded');
  await requireActiveExactAccount(account);
  emitConfigActivity('configs:restore-cloud', 'identity-verified');
  await riot.savePlayerSettings(backup.blob, backup.playerPreferencesPath, {
    onStage: (stage) => emitConfigActivity('configs:restore-cloud', stage),
  });
  try {
    await requireActiveExactAccount(account);
    emitConfigActivity('configs:restore-cloud', 'identity-reverified');
  } catch {
    throw new Error('The signed-in Riot identity changed during restore verification. The backup was retained; confirm the active account before retrying.');
  }
  return { restored: true, backedUpAt: backup.backedUpAt, note: 'Restart VALORANT to load the restored settings.' };
});

handle('settings:pick-client', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Locate RiotClientServices.exe',
    properties: ['openFile'],
    filters: [{ name: 'Executable', extensions: ['exe'] }],
  });
  if (res.canceled || !res.filePaths[0]) return { picked: false };
  const clientPath = res.filePaths[0];
  saveSettings({ clientPath });
  return { picked: true, clientPath };
});

handle('profiles:links', async (accountId) => {
  requireUnlocked();
  const account = vault.listAccounts().find((item) => item.id === accountId);
  if (!account) throw new Error('Account not found.');
  if (!account.puuid || !String(account.riotId || '').includes('#')) {
    throw new Error('Sync this account first so its Riot ID is bound to a verified PUUID.');
  }
  const links = {
    vtl: vtlProfileUrl(account.riotId),
    tracker: trackerProfileUrl(account.riotId),
    dpm: league.dpmProfileUrl(account.riotId),
  };
  const platformId = league.canonicalLeaguePlatform(account.leaguePlatformId);
  if (platformId) Object.assign(links, league.profileLinks(account.riotId, platformId));
  return links;
});

handleTrusted('updates:get-state', async () => updateService
  ? updateService.snapshot()
  : {
    supported: false,
    installerFlavor: String(packageMetadata.installerFlavor || 'development'),
    status: 'idle',
    currentVersion: app.getVersion(),
    availableVersion: null,
    progress: 0,
    lastCheckedAt: null,
    error: null,
  });
handleTrusted('updates:check', async () => updateService
  ? updateService.check(true)
  : Promise.reject(new Error('Update service is not ready.')));
handleTrusted('updates:install', async () => updateService
  ? updateService.install()
  : Promise.reject(new Error('Update service is not ready.')));

handleTrusted('app:open-project', async (target) => {
  const destinations = {
    docs: 'https://jirkaachs.github.io/Riot-Relay/',
    releases: 'https://github.com/JirkaachS/Riot-Relay/releases/latest',
    repository: 'https://github.com/JirkaachS/Riot-Relay',
  };
  const destination = destinations[String(target || '')];
  if (!destination) throw new Error('Unknown project destination.');
  await shell.openExternal(destination);
  return true;
});

handle('app:open-external', async (value) => {
  const url = new URL(String(value || ''));
  const hosts = new Set([
    'op.gg', 'www.op.gg', 'u.gg', 'www.u.gg', 'deeplol.gg', 'www.deeplol.gg',
    'dpm.lol', 'www.dpm.lol', 'vtl.lol', 'www.vtl.lol', 'tracker.gg', 'www.tracker.gg',
  ]);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname)) {
    throw new Error('External URL is not an approved profile link.');
  }
  await shell.openExternal(url.href);
  return true;
});

handle('app:rank-tiers', async () => RANK_TIERS);

handle('app:games', async () => Object.entries(GAMES).map(([id, g]) => ({ id, label: g.label })));
