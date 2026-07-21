'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'docs', 'assets', 'screenshots');
const PROFILE = path.join(os.tmpdir(), 'riot-relay-doc-capture');

app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('force-prefers-reduced-motion');
app.disableHardwareAcceleration();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(window, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function settle(window) {
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  // View transitions and surface entrances run for up to 180 ms. Wait beyond
  // them so deterministic docs never capture an in-between pseudo-element.
  await wait(260);
}

async function capture(window, name, prepare, ready) {
  await window.webContents.executeJavaScript(prepare);
  if (ready) await waitFor(window, ready);
  await window.webContents.executeJavaScript(`document.querySelector('#toasts').innerHTML = ''`);
  await settle(window);
  const image = await window.webContents.capturePage();
  const target = path.join(OUTPUT, name);
  fs.rmSync(target, { force: true });
  fs.writeFileSync(target, image.toPNG());
  process.stdout.write(`Captured ${name}\n`);
}
app.whenReady().then(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'docs-fixture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) process.stderr.write(`Renderer: ${message}\n`);
  });

  await window.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await waitFor(window, `document.querySelector('#boot-screen').hidden && document.querySelector('#feature-tour').hidden`);

  await capture(window, 'accounts-overview.png',
    `document.querySelector('[data-select="demo-primary"]').click()`,
    `!document.querySelector('#account-detail').hidden`);

  await capture(window, 'inventory-workspace.png', `(() => {
    document.querySelector('[data-view="inventory"]').click();
    const game = document.querySelector('#inv-game');
    game.value = 'lol';
    game.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#btn-load-inventory').click();
  })()`, `document.querySelector('#view-inventory').classList.contains('is-active') && document.querySelector('.item:not(.item--skeleton)')`);

  await capture(window, 'privacy-settings.png', `(() => {
    document.querySelector('[data-view="settings"]').click();
    document.querySelector('.settingnav[data-group="privacy"]').click();
  })()`, `document.querySelector('#view-settings').classList.contains('is-active') && document.querySelector('.setting-group[data-group="privacy"].is-active')`);

  await capture(window, 'security-settings.png', `(() => {
    document.querySelector('.settingnav[data-group="security"]').click();
  })()`, `document.querySelector('.setting-group[data-group="security"].is-active')`);

  await capture(window, 'settings-migration.png', `(async () => {
    await api.configs.setActiveTarget();
    document.querySelector('#btn-sync-current').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    document.querySelector('[data-view="settings"]').click();
    document.querySelector('.settingnav[data-group="configs"]').click();
    await api.configs.applyCloud('demo-primary');
    await refreshConfigProfiles();
    renderConfigProfileStatus();
  })()`, `document.querySelector('.setting-group[data-group="configs"].is-active') && Number(document.querySelector('#activity-count').textContent) >= 8 && !document.querySelector('#btn-cloud-restore').disabled`);

  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());