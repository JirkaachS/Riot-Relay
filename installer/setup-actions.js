'use strict';

/**
 * setup-actions.js — Pure Node (no Electron APIs) install/uninstall logic,
 * kept separate from main.js so it can be exercised directly by a test
 * script without needing to drive the actual wizard UI.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PRODUCT_NAME = 'Riot Relay';
const UNINSTALL_KEY = 'RiotRelay';

function defaultInstallDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Programs', PRODUCT_NAME);
}

function startMenuDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

function desktopDir() {
  return path.join(os.homedir(), 'Desktop');
}

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) { reject(new Error(String(stderr || error.message || 'PowerShell step failed.').trim())); return; }
        resolve(String(stdout || '').trim());
      },
    );
  });
}

function readRegisteredInstallDir() {
  return new Promise((resolve) => {
    const script = `
      $ErrorActionPreference = 'SilentlyContinue'
      $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_KEY}'
      $value = (Get-ItemProperty -Path $key -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
      if ($value) { Write-Output $value }
    `;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (error, stdout) => {
      const value = String(stdout || '').trim();
      resolve(!error && value ? value : null);
    });
  });
}

function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else { try { total += fs.statSync(full).size; } catch { /* ignore */ } }
    }
  }
  return total;
}

async function install({ installDir, payloadZipPath, exeSourcePath, manifest, createDesktopShortcut, createStartMenuShortcut, onProgress = () => {} }) {
  const target = String(installDir || defaultInstallDir()).trim();
  if (!target) throw new Error('An install location is required.');
  const exePath = path.join(target, manifest.exeName || 'Riot Relay.exe');
  const uninstallerPath = path.join(target, 'Uninstall Riot Relay.exe');

  onProgress(5, 'Preparing install location…');
  fs.mkdirSync(target, { recursive: true });
  const existing = fs.existsSync(target) ? fs.readdirSync(target) : [];
  for (const entry of existing) {
    try { fs.rmSync(path.join(target, entry), { recursive: true, force: true }); } catch { /* best effort */ }
  }

  onProgress(15, 'Extracting application files…');
  if (!fs.existsSync(payloadZipPath)) throw new Error('Installer payload is missing from this build.');
  await runPowerShell(`
    $ErrorActionPreference = 'Stop'
    Expand-Archive -Path '${psQuote(payloadZipPath)}' -DestinationPath '${psQuote(target)}' -Force
  `);

  onProgress(55, 'Registering the uninstaller…');
  fs.copyFileSync(exeSourcePath, uninstallerPath);

  onProgress(65, 'Creating shortcuts…');
  const shortcutTargets = [];
  if (createStartMenuShortcut) shortcutTargets.push(path.join(startMenuDir(), `${PRODUCT_NAME}.lnk`));
  if (createDesktopShortcut) shortcutTargets.push(path.join(desktopDir(), `${PRODUCT_NAME}.lnk`));
  for (const lnkPath of shortcutTargets) {
    await runPowerShell(`
      $ErrorActionPreference = 'Stop'
      $ws = New-Object -ComObject WScript.Shell
      $sc = $ws.CreateShortcut('${psQuote(lnkPath)}')
      $sc.TargetPath = '${psQuote(exePath)}'
      $sc.WorkingDirectory = '${psQuote(target)}'
      $sc.IconLocation = '${psQuote(exePath)}'
      $sc.Save()
    `);
  }

  onProgress(85, 'Updating Windows Apps & Features…');
  const estimatedSizeKb = Math.max(1, Math.round(dirSizeBytes(target) / 1024));
  await runPowerShell(`
    $ErrorActionPreference = 'Stop'
    $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_KEY}'
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name DisplayName -Value '${PRODUCT_NAME}'
    Set-ItemProperty -Path $key -Name DisplayVersion -Value '${psQuote(manifest.version)}'
    Set-ItemProperty -Path $key -Name Publisher -Value 'Riot Relay contributors'
    Set-ItemProperty -Path $key -Name InstallLocation -Value '${psQuote(target)}'
    Set-ItemProperty -Path $key -Name DisplayIcon -Value '${psQuote(exePath)}'
    Set-ItemProperty -Path $key -Name UninstallString -Value '"${psQuote(uninstallerPath)}" --uninstall'
    Set-ItemProperty -Path $key -Name EstimatedSize -Value ${estimatedSizeKb} -Type DWord
    Set-ItemProperty -Path $key -Name NoModify -Value 1 -Type DWord
    Set-ItemProperty -Path $key -Name NoRepair -Value 1 -Type DWord
  `);

  onProgress(100, 'Done.');
  return { success: true, exePath };
}

async function uninstall({ installDir, selfExePath, keepUserData, onProgress = () => {} }) {
  const target = String(installDir || '').trim();

  onProgress(10, 'Removing shortcuts…');
  for (const lnkPath of [
    path.join(startMenuDir(), `${PRODUCT_NAME}.lnk`),
    path.join(desktopDir(), `${PRODUCT_NAME}.lnk`),
  ]) {
    try { fs.rmSync(lnkPath, { force: true }); } catch { /* ignore */ }
  }

  onProgress(35, 'Removing Windows Apps & Features entry…');
  await runPowerShell(`
    $ErrorActionPreference = 'SilentlyContinue'
    Remove-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_KEY}' -Recurse -Force
  `);

  if (!keepUserData) {
    onProgress(55, 'Removing saved settings…');
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    try { fs.rmSync(path.join(appData, PRODUCT_NAME), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  onProgress(75, 'Removing application files…');
  if (target && fs.existsSync(target)) {
    const scheduled = selfExePath && target.toLowerCase() === path.dirname(selfExePath).toLowerCase();
    const entries = fs.readdirSync(target);
    for (const entry of entries) {
      const full = path.join(target, entry);
      if (scheduled && path.basename(full).toLowerCase() === path.basename(selfExePath).toLowerCase()) continue;
      try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    if (scheduled) {
      runPowerShell(`
        Start-Sleep -Seconds 2
        Remove-Item -Path '${psQuote(selfExePath)}' -Force -ErrorAction SilentlyContinue
        Remove-Item -Path '${psQuote(target)}' -Recurse -Force -ErrorAction SilentlyContinue
      `).catch(() => {});
    } else {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  onProgress(100, 'Done.');
  return { success: true };
}

module.exports = {
  PRODUCT_NAME,
  UNINSTALL_KEY,
  defaultInstallDir,
  startMenuDir,
  desktopDir,
  readRegisteredInstallDir,
  dirSizeBytes,
  install,
  uninstall,
};
