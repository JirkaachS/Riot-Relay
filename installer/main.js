'use strict';

/**
 * main.js — Riot Relay Setup: a fully custom-branded install/uninstall
 * wizard. This is a small, separate Electron app (own package.json) whose
 * only job is to present a bespoke HTML/CSS wizard UI instead of NSIS's
 * built-in installer pages, then unpack the already-built app payload and
 * register it with Windows like a normal installer would.
 *
 * Scope and security notes:
 *  - Per-user install only (no admin elevation, no HKLM writes), matching
 *    the existing NSIS config's perMachine:false.
 *  - All filesystem/registry/shortcut work happens locally via PowerShell,
 *    the same pattern already used throughout the main app (electron/switcher.js,
 *    electron/league.js) instead of adding new native dependencies.
 *  - This installer never touches network resources; the payload is bundled
 *    as a local resource at build time (see build-payload.js).
 *  - Ongoing app updates are unaffected: electron-updater in the main app
 *    still silently drives the existing NSIS installer in the background.
 *    This wizard only replaces the first-time download/install experience
 *    (and provides a matching custom uninstall flow).
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const setup = require('./setup-actions');

const PRODUCT_NAME = setup.PRODUCT_NAME;

const isUninstallMode = process.argv.includes('--uninstall');
const resourcesRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
const manifestPath = path.join(resourcesRoot, 'manifest.json');
const payloadZipPath = path.join(resourcesRoot, 'payload.zip');
const licensePath = path.join(resourcesRoot, 'LICENSE.txt');

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const manifest = readJsonSafe(manifestPath, { version: app.getVersion(), productName: PRODUCT_NAME, exeName: 'Riot Relay.exe' });
const licenseText = (() => {
  try { return fs.readFileSync(licensePath, 'utf8'); } catch { return ''; }
})();

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 420,
    resizable: false,
    maximizable: false,
    frame: false,
    backgroundColor: '#0b0b0e',
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

ipcMain.handle('setup:window-action', (_event, action) => {
  if (!win) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'close') app.quit();
});

ipcMain.handle('setup:get-context', async () => {
  const registeredDir = await setup.readRegisteredInstallDir();
  return {
    mode: isUninstallMode ? 'uninstall' : 'install',
    productName: manifest.productName || PRODUCT_NAME,
    version: manifest.version || app.getVersion(),
    licenseText,
    installDir: registeredDir || setup.defaultInstallDir(),
    hasExistingInstall: !!registeredDir,
  };
});

ipcMain.handle('setup:choose-directory', async (_event, currentDir) => {
  const result = await dialog.showOpenDialog(win, {
    title: `Choose where to install ${PRODUCT_NAME}`,
    defaultPath: currentDir || setup.defaultInstallDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return path.join(result.filePaths[0], PRODUCT_NAME);
});

function sendProgress(percent, label) {
  if (win && !win.isDestroyed()) win.webContents.send('setup:progress', { percent, label });
}

ipcMain.handle('setup:start-install', async (_event, { installDir, createDesktopShortcut, createStartMenuShortcut }) => {
  try {
    return await setup.install({
      installDir,
      payloadZipPath,
      exeSourcePath: process.execPath,
      manifest,
      createDesktopShortcut,
      createStartMenuShortcut,
      onProgress: sendProgress,
    });
  } catch (error) {
    return { success: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('setup:start-uninstall', async (_event, { installDir, keepUserData }) => {
  try {
    return await setup.uninstall({
      installDir,
      selfExePath: process.execPath,
      keepUserData,
      onProgress: sendProgress,
    });
  } catch (error) {
    return { success: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('setup:launch-app', async (_event, exePath) => {
  try {
    if (exePath && fs.existsSync(exePath)) shell.openPath(exePath);
    return true;
  } catch { return false; }
});

ipcMain.handle('setup:quit', () => app.quit());
