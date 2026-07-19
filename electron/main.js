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
const { RiotClient, RANK_TIERS } = require('./riot');
const { Catalog, vtlProfileUrl, trackerProfileUrl } = require('./valorant');
const league = require('./league');
const { switchAccount, launchClient, findRiotClient, clearRiotSession, GAMES } = require('./switcher');
const { DeceiveProxy } = require('./deceive');
const session = require('./session');
const { assertAccountIdentity, findRosterMatches } = require('./account-identity');
const { UpdateService } = require('./updater');

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

const openDevTools = process.argv.includes('--devtools');

let mainWindow = null;
let tray = null;
let trayNotification = null;
let rendererServer = null;
let rendererOrigin = '';
let isQuitting = false;
let vault = null;
let riot = null;
let catalog = null;
let deceiveProxy = null;
let updateService = null;
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
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
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
  const title = 'Riot Relay is still running';
  const body = 'The window was hidden to the notification area. Click this notification or the Riot Relay tray icon to restore it.';
  let usedFallback = false;
  const showBalloonFallback = () => {
    if (usedFallback || !tray) return;
    usedFallback = true;
    try {
      tray.displayBalloon({ title, content: body, iconType: 'info', noSound: true, respectQuietTime: false });
    } catch { /* Windows may disable both app notifications and tray balloons */ }
  };

  if (!Notification.isSupported()) {
    showBalloonFallback();
    return;
  }
  try {
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
    notification.once('click', () => focusMainWindow());
    notification.once('failed', showBalloonFallback);
    notification.once('close', () => {
      if (trayNotification === notification) trayNotification = null;
    });
    notification.show();
  } catch {
    trayNotification = null;
    showBalloonFallback();
  }
}

function hideMainWindowToTray() {
  if (!mainWindow) return;
  const wasVisible = mainWindow.isVisible();
  reconcileTray();
  mainWindow.hide();
  if (wasVisible && !mainWindow.isVisible()) showTrayHiddenNotification();
}

function minimizeMainWindow() {
  if (!mainWindow) return;
  if (trayEnabled()) hideMainWindowToTray();
  else mainWindow.minimize();
}

function createWindow() {
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
    if (!isQuitting && trayEnabled()) {
      event.preventDefault();
      hideMainWindowToTray();
    }
  });
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state', { maximized: false }));
  mainWindow.on('closed', () => (mainWindow = null));
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.riotrelay.desktop');
  const dir = app.getPath('userData');
  vault = new Vault(dir, safeStorage);
  riot = new RiotClient();
  catalog = new Catalog(dir);

  await startRendererServer();
  createWindow();
  reconcileTray();
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
  if (trayNotification) trayNotification.close();
  trayNotification = null;
  if (tray) tray.destroy();
  tray = null;
  if (rendererServer) rendererServer.close();
  rendererServer = null;
  if (deceiveProxy) deceiveProxy.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC helpers -----------------------------------------------------------

function ok(data) { return { ok: true, data }; }
function fail(err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }

function handle(channel, fn) {
  ipcMain.handle(channel, async (_evt, ...args) => {
    try { return ok(await fn(...args)); }
    catch (err) { return fail(err); }
  });
}

function handleTrusted(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const senderOrigin = new URL(event.senderFrame && event.senderFrame.url || '').origin;
      if (!rendererOrigin || senderOrigin !== rendererOrigin) throw new Error('Untrusted renderer request.');
      return ok(await fn(...args));
    } catch (err) { return fail(err); }
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

/** Tag accounts only when a manifest-backed, identity-bound snapshot is valid. */
function annotate(accounts) {
  const userData = app.getPath('userData');
  return (accounts || []).map((account) => {
    const { manifest, ...sessionStatus } = session.validateSession(userData, account.id, account);
    return { ...account, session: sessionStatus, hasSession: sessionStatus.available && sessionStatus.identityVerified };
  });
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sameIdentity(a, b) { return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }
function safeError(error, fallback) {
  const message = String(error && error.message ? error.message : error || fallback);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 180);
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

function normalizeChatFriend(friend) {
  const raw = rawChatId(friend);
  const id = chatHandle(raw);
  if (!id) return null;
  const gameName = String(friend.game_name || friend.gameName || friend.name || friend.displayName || 'Unknown friend').slice(0, 80);
  const tagLine = String(friend.game_tag || friend.gameTag || friend.tag_line || friend.tagLine || '').slice(0, 20);
  const label = tagLine ? `${gameName}#${tagLine}` : gameName;
  chatLabels.set(raw.toLowerCase(), label);
  return {
    id,
    displayName: gameName,
    riotId: label,
    availability: String(friend.availability || friend.state || 'offline').slice(0, 24),
    game: String(friend.product || friend.platform || friend.game || '').slice(0, 32),
    group: String(friend.group || friend.groupName || '').slice(0, 60),
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
  if (!vault || !vault.isUnlocked() || !live || !live.puuid) return '';
  const match = vault.listAccounts().find((account) => sameIdentity(account.puuid, live.puuid));
  return match ? league.canonicalLeaguePlatform(match.leaguePlatformId) || '' : '';
}

function verifiedLeaguePlatformPatch(live, leagueStats) {
  const platformId = league.canonicalLeaguePlatform(leagueStats && leagueStats.platformId);
  if (!platformId || !live || !live.puuid || !leagueStats || !sameIdentity(leagueStats.puuid, live.puuid)) return {};
  return {
    leaguePlatformId: platformId,
    leaguePlatformSource: String(leagueStats.platformSource || 'verified'),
    leaguePlatformVerifiedAt: leagueStats.platformVerifiedAt || new Date().toISOString(),
  };
}

async function buildAllStats(live) {
  const liveRiotId = live.gameName && live.tagLine ? `${live.gameName}#${live.tagLine}` : null;
  const valorantPromise = Promise.all([
    riot.fetchRank(live).catch(() => null),
    riot.fetchAccountXP(live).catch(() => ({ level: 0 })),
    riot.fetchWallet(live).catch(() => ({ vp: 0, radianite: 0, kingdom: 0 })),
    riot.fetchPlayerCard(live).catch(() => null),
  ]);
  const lcuPromise = league.buildStats(loadSettings().leaguePath)
    .then((value) => ({ value })).catch((error) => ({ error }));
  const [[rank, xp, wallet, playerCard], lcuResult] = await Promise.all([valorantPromise, lcuPromise]);
  const valorant = { available: true, rank, level: xp.level || 0, wallet, playerCard, updatedAt: new Date().toISOString() };

  let verifiedLcu = null;
  let lcuError = lcuResult.error ? safeError(lcuResult.error, 'League client is unavailable.') : null;
  if (!lcuResult.error) {
    const lcu = lcuResult.value;
    if (!lcu.puuid) lcuError = 'League Client did not provide a PUUID, so its data was rejected.';
    else if (!sameIdentity(lcu.puuid, live.puuid)) lcuError = 'League Client is signed into a different Riot identity.';
    else verifiedLcu = lcu;
  }

  let opggResult = { error: new Error('A complete Riot ID and PUUID are required for OP.GG lookup.') };
  let onlineTftResult = { error: new Error('A complete Riot ID and PUUID are required for OP.GG TFT lookup.') };
  if (liveRiotId && live.puuid) {
    const lcuPlatform = verifiedLcu && league.canonicalLeaguePlatform(verifiedLcu.platformId);
    const storedPlatform = storedLeaguePlatformForLive(live);
    const leagueLookup = lcuPlatform
      ? league.fetchOpggStats(liveRiotId, lcuPlatform, live.puuid)
        .then((value) => ({ value: { ...value, platformSource: verifiedLcu.platformSource } }))
        .catch((error) => ({ error }))
      : league.discoverOpggStats(liveRiotId, live.puuid, storedPlatform)
        .then((value) => ({ value })).catch((error) => ({ error }));
    const tftLookup = verifiedLcu
      ? Promise.resolve({ value: null })
      : league.discoverOpggTftStats(liveRiotId, live.puuid, storedPlatform)
        .then((value) => ({ value })).catch((error) => ({ error }));
    [opggResult, onlineTftResult] = await Promise.all([leagueLookup, tftLookup]);
  }

  const verifiedOpgg = opggResult.value
    && opggResult.value.puuid
    && sameIdentity(opggResult.value.puuid, live.puuid)
    && sameIdentity(opggResult.value.riotId, liveRiotId)
    && league.canonicalLeaguePlatform(opggResult.value.platformId)
    ? opggResult.value
    : null;
  const opggIdentityError = opggResult.value && !verifiedOpgg
    ? 'OP.GG returned a different PUUID, Riot ID, or invalid League platform, so its data was rejected.'
    : null;
  const verifiedOnlineTft = onlineTftResult.value
    && onlineTftResult.value.puuid
    && sameIdentity(onlineTftResult.value.puuid, live.puuid)
    && sameIdentity(onlineTftResult.value.riotId, liveRiotId)
    && league.canonicalLeaguePlatform(onlineTftResult.value.platformId)
    ? onlineTftResult.value
    : null;
  const onlineTftIdentityError = onlineTftResult.value && !verifiedOnlineTft
    ? 'OP.GG TFT returned a different PUUID, Riot ID, or invalid League platform, so its data was rejected.'
    : null;
  const verifiedTftPlatform = league.canonicalLeaguePlatform(verifiedOnlineTft && verifiedOnlineTft.platformId);
  const platformVerifiedAt = new Date().toISOString();

  let leagueStats;
  if (verifiedOpgg) {
    leagueStats = {
      ...verifiedOpgg,
      puuid: live.puuid,
      platformId: league.canonicalLeaguePlatform(verifiedOpgg.platformId),
      platformSource: verifiedOpgg.platformSource || 'opgg-discovery',
      platformVerifiedAt,
      level: verifiedLcu && verifiedLcu.summonerLevel || verifiedOpgg.level || 0,
      profileIconId: verifiedLcu && verifiedLcu.profileIconId || null,
    };
  } else if (verifiedLcu) {
    const platformId = league.canonicalLeaguePlatform(verifiedLcu.platformId);
    leagueStats = {
      available: true,
      puuid: verifiedLcu.puuid || null,
      riotId: verifiedLcu.riotId,
      platformId,
      platformSource: platformId ? verifiedLcu.platformSource : null,
      platformVerifiedAt: platformId ? platformVerifiedAt : null,
      level: verifiedLcu.summonerLevel,
      profileIconId: verifiedLcu.profileIconId,
      queues: verifiedLcu.league,
      source: 'lcu',
      updatedAt: new Date().toISOString(),
    };
  } else {
    const reason = verifiedTftPlatform
      ? 'OP.GG verified the account platform through TFT, but identity-verified League rank data is unavailable.'
      : opggIdentityError || (opggResult.error && safeError(opggResult.error, 'OP.GG profile data is unavailable.'));
    leagueStats = {
      available: false,
      puuid: verifiedTftPlatform ? live.puuid : null,
      riotId: verifiedTftPlatform ? liveRiotId : null,
      platformId: verifiedTftPlatform,
      platformSource: verifiedTftPlatform ? verifiedOnlineTft.platformSource || 'opgg-tft-discovery' : null,
      platformVerifiedAt: verifiedTftPlatform ? platformVerifiedAt : null,
      queues: [],
      error: reason || 'OP.GG profile data is unavailable and League Client is not connected.',
    };
  }

  const onlineTftError = onlineTftIdentityError
    || (onlineTftResult.error && safeError(onlineTftResult.error, 'OP.GG TFT profile data is unavailable.'));
  const tftStats = verifiedLcu
    ? {
      available: true,
      puuid: verifiedLcu.puuid || null,
      riotId: verifiedLcu.riotId,
      level: verifiedLcu.summonerLevel,
      profileIconId: verifiedLcu.profileIconId,
      queues: verifiedLcu.tft,
      source: 'lcu',
      updatedAt: new Date().toISOString(),
    }
    : verifiedOnlineTft || { available: false, queues: [], error: onlineTftError || lcuError || 'League client is unavailable for TFT data.' };

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
  let wrongPuuid = null;
  let wrongSamples = 0;
  let unauthenticatedSamples = 0;
  let lastLive = null;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const live = await settleBefore(riot.resolveSession(), remaining);
      if (live && live.puuid) {
        unauthenticatedSamples = 0;
        lastLive = live;
        if (sameIdentity(live.puuid, account.puuid)) return { status: 'matched', live };
        if (sameIdentity(live.puuid, wrongPuuid)) wrongSamples += 1;
        else { wrongPuuid = live.puuid; wrongSamples = 1; }
        if (wrongSamples >= 3) return { status: 'mismatched', live };
      }
    } catch {
      // A persistent lockfile with no entitlements/session is the signed-out
      // login form. Require several samples so normal startup is not mistaken
      // for an expired snapshot. During post-login, keep waiting for manual 2FA.
      unauthenticatedSamples = riot.isRunning() ? unauthenticatedSamples + 1 : 0;
      if (unauthenticatedSamples >= 12 && !allowUserVerification) return { status: 'unauthenticated' };
    }
    const waitMs = Math.min(1000, Math.max(0, deadline - Date.now()));
    if (waitMs) await wait(waitMs);
  }
  if (!lastLive && riot.isRunning()) return { status: 'unauthenticated' };
  return { status: 'timeout', live: lastLive || undefined };
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

handle('vault:lock', async () => { vault.lock(); return true; });

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

handle('riot:current-session', async () => buildCurrentSessionView());

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
  const requestedGame = typeof payload === 'object' && payload && ['valorant', 'lol', 'tft'].includes(payload.launchGame)
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

  appendSwitchLog('START', {
    loginMode,
    hasUsername: !!String(acc.username || '').trim(),
    hasPassword: !!password,
    instantCandidate: instant,
    snapshotReason: snapshot.reason || null,
    launchGame: requestedGame,
  });
  const send = (label) => {
    appendSwitchLog('STAGE', { label });
    if (mainWindow) mainWindow.webContents.send('switch:progress', { id, label, at: new Date().toISOString() });
  };

  // Never restart Riot when the requested PUUID is already active.
  if (acc.puuid) {
    try {
      const live = await riot.resolveSession();
      if (sameIdentity(live.puuid, acc.puuid)) {
        send('Requested account is already active.');
        if (requestedGame) {
          const client = findRiotClient(settings.clientPath);
          if (!client) throw new Error('Riot Client not found. Set its path in Settings.');
          launchClient(client, { game: requestedGame });
          send(`Launching ${GAMES[requestedGame].label} without restarting the session…`);
        }
        const currentSession = await buildCurrentSessionView(live);
        return {
          instant: true,
          mode: 'already-active',
          launchedGame: requestedGame,
          verified: true,
          verification: { status: 'matched' },
          currentSession,
          accounts: annotate(vault.listAccounts()),
          sessionCapture: { captured: false, reason: 'already-active' },
        };
      }
    } catch { /* no authenticated Riot session; continue with the switch */ }
  }

  let configUrl = '';
  if (settings.useDeceive) {
    try {
      if (deceiveProxy) deceiveProxy.stop();
      deceiveProxy = new DeceiveProxy(app.getPath('userData'), {
        launchProduct: requestedGame === 'lol' || requestedGame === 'tft' ? 'league' : requestedGame === 'valorant' ? 'valorant' : 'unknown',
        preserveParty: settings.deceivePreserveParty !== false,
        activityMode: settings.deceiveActivityMode || 'hide',
        customStatus: settings.deceiveCustomStatus || '',
        leagueHelper: settings.deceiveLeagueHelper !== false,
      });
      send('Starting offline proxy…');
      const res = await deceiveProxy.start(settings.deceiveStatus || 'offline');
      configUrl = res.configUrl;
    } catch (error) {
      if (deceiveProxy) deceiveProxy.lastError = safeError(error, 'Offline proxy unavailable.');
      send(`Offline proxy unavailable (${error.message}) — launching normally.`);
    }
  }

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
        phase === 'post-login' ? 180000 : 30000,
        phase === 'post-login',
      ) : null,
      onBeforeLaunch: async (step) => {
        if (instant) {
          step('Restoring identity-bound saved session…');
          try {
            session.restoreSession(userData, id, acc);
            return { instant: true };
          } catch (error) {
            step(`Saved session could not be restored (${error.message}) — using one clean sign-in.`);
            clearRiotSession();
            return { instant: false };
          }
        }
        step(snapshot.reason === 'legacy' ? 'Legacy session requires recapture — signing in normally…' : 'Preparing a clean sign-in…');
        clearRiotSession();
        return { instant: false };
      },
    }, send);
  } catch (error) {
    appendSwitchLog('FAILED', { reason: safeError(error, 'Switch failed.') });
    focusMainWindow();
    throw error;
  }

  let sessionCapture = { captured: false, reason: result.verified ? 'not-required' : 'account-not-verified' };
  if (result.verified === true && result.verification && result.verification.status === 'matched') {
    const live = result.verification.live;
    const currentSession = await buildCurrentSessionView(live);
    const rank = currentSession.stats.valorant.rank;
    vault.patchAccount(id, {
      riotId: currentSession.riotId || acc.riotId,
      ...verifiedLeaguePlatformPatch(live, currentSession.stats.league),
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
    acc = vault.listAccounts().find((item) => item.id === id);

    if (result.loginSubmitted && result.staySignedInClicked) {
      send('Waiting for Riot to persist the verified session…');
      try {
        const captured = await session.captureWhenStable(userData, id, acc, { sinceMs: result.submittedAt });
        sessionCapture = { captured: true, reason: null, capturedAt: captured.capturedAt };
        send('Verified session captured for seamless switching.');
      } catch (error) {
        sessionCapture = { captured: false, reason: safeError(error, 'Session capture failed.') };
        send(`Account verified; session capture was skipped (${sessionCapture.reason}).`);
      }
    }

    result.currentSession = currentSession;
    result.accounts = annotate(vault.listAccounts());
  } else {
    result.accounts = annotate(vault.listAccounts());
  }
  result.sessionCapture = sessionCapture;
  result.launchedGame = requestedGame;
  if (result.verification) {
    result.verification = {
      status: result.verification.status,
      reason: result.verification.reason || undefined,
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
    reason: result.reason || sessionCapture.reason || null,
  });
  if (result.manualRequired || (result.verification && result.verification.status === 'mismatched')) focusMainWindow();
  if (settings.minimizeOnSwitch && mainWindow && result.verified === true) minimizeMainWindow();
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
  const payload = await riot.fetchChatFriends();
  await verifyChatSession(live);
  const friends = chatRows(payload, ['friends', 'data'])
    .map(normalizeChatFriend)
    .filter(Boolean)
    .sort((a, b) => {
      const onlineA = a.availability !== 'offline' ? 0 : 1;
      const onlineB = b.availability !== 'offline' ? 0 : 1;
      return onlineA - onlineB || a.riotId.localeCompare(b.riotId);
    });
  return {
    identity: {
      riotId: live.gameName && live.tagLine ? `${live.gameName}#${live.tagLine}` : 'Current Riot account',
      puuidHash: crypto.createHash('sha256').update(String(live.puuid)).digest('hex').slice(0, 12),
    },
    friends,
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
