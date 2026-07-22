'use strict';

/**
 * test-setup-actions.js — Ad hoc verification script (not part of the main
 * project's `npm test`) that exercises setup-actions.js's install/uninstall
 * against a temporary directory + a small fake payload, so the actual
 * filesystem/registry/shortcut behavior is verified without needing to
 * click through the Electron wizard UI by hand. Deletes all traces of
 * itself (including the HKCU registry key) when done, whether it passes
 * or fails.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const setup = require('./setup-actions');

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (error, stdout, stderr) => {
      if (error) { reject(new Error(String(stderr || error.message))); return; }
      resolve(String(stdout || '').trim());
    });
  });
}

async function readRegistryValue(name) {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${setup.UNINSTALL_KEY}' -Name ${name} -ErrorAction SilentlyContinue).${name}
  `;
  return runPowerShell(script);
}

async function registryKeyExists() {
  const script = `
    if (Test-Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${setup.UNINSTALL_KEY}') { Write-Output 'yes' } else { Write-Output 'no' }
  `;
  return (await runPowerShell(script)) === 'yes';
}

let failures = 0;
function assertTrue(condition, message) {
  if (!condition) { failures += 1; console.error(`FAIL: ${message}`); }
  else console.log(`OK: ${message}`);
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riot-relay-setup-test-'));
  const fakeSourceDir = path.join(workDir, 'fake-app');
  const installDir = path.join(workDir, 'installed', 'Riot Relay');
  const payloadZipPath = path.join(workDir, 'payload.zip');
  const fakeExeSource = path.join(workDir, 'fake-uninstaller-source.exe');

  try {
    // Build a tiny fake "app" payload to stand in for dist/win-unpacked.
    fs.mkdirSync(fakeSourceDir, { recursive: true });
    fs.writeFileSync(path.join(fakeSourceDir, 'Riot Relay.exe'), 'fake-exe-content');
    fs.writeFileSync(path.join(fakeSourceDir, 'resources.pak'), 'fake-resource-data');
    fs.writeFileSync(fakeExeSource, 'fake-uninstaller-binary');

    await runPowerShell(`
      $ErrorActionPreference = 'Stop'
      Compress-Archive -Path (Join-Path '${fakeSourceDir}' '*') -DestinationPath '${payloadZipPath}' -Force
    `);
    assertTrue(fs.existsSync(payloadZipPath), 'fake payload zip was created');

    const manifest = { version: '9.9.9-test', exeName: 'Riot Relay.exe' };
    const progressEvents = [];
    const installResult = await setup.install({
      installDir,
      payloadZipPath,
      exeSourcePath: fakeExeSource,
      manifest,
      createDesktopShortcut: false, // avoid touching the real user Desktop during this test
      createStartMenuShortcut: false,
      onProgress: (percent, label) => progressEvents.push({ percent, label }),
    });

    assertTrue(installResult.success === true, 'install() reported success');
    assertTrue(fs.existsSync(path.join(installDir, 'Riot Relay.exe')), 'app exe was extracted into the install directory');
    assertTrue(fs.existsSync(path.join(installDir, 'resources.pak')), 'app resource file was extracted');
    assertTrue(fs.existsSync(path.join(installDir, 'Uninstall Riot Relay.exe')), 'uninstaller exe copy was created');
    assertTrue(progressEvents.some((e) => e.percent === 100), 'install progress reached 100%');

    assertTrue(await registryKeyExists(), 'uninstall registry key exists after install');
    const displayVersion = await readRegistryValue('DisplayVersion');
    assertTrue(displayVersion === '9.9.9-test', `registry DisplayVersion matches manifest version (got "${displayVersion}")`);
    const uninstallString = await readRegistryValue('UninstallString');
    assertTrue(uninstallString.includes('--uninstall'), 'registry UninstallString includes --uninstall flag');

    const registeredDir = await setup.readRegisteredInstallDir();
    assertTrue(registeredDir === installDir, `readRegisteredInstallDir() returns the installed directory (got "${registeredDir}")`);

    // Uninstall using the real-world shape: the running "uninstaller" exe is
    // itself a file inside the install directory (as it is in production,
    // where Uninstall Riot Relay.exe lives next to the app it removes). This
    // exercises the delayed self-delete branch, which schedules removal of
    // the exe + directory via a detached PowerShell after this process
    // would have exited, so the test polls for that instead of asserting
    // synchronous removal.
    const selfExePath = path.join(installDir, 'Uninstall Riot Relay.exe');
    const uninstallProgress = [];
    const uninstallResult = await setup.uninstall({
      installDir,
      selfExePath,
      keepUserData: true,
      onProgress: (percent, label) => uninstallProgress.push({ percent, label }),
    });
    assertTrue(uninstallResult.success === true, 'uninstall() reported success');
    assertTrue(!(await registryKeyExists()), 'uninstall registry key was removed');

    let removedAfterDelay = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!fs.existsSync(installDir)) { removedAfterDelay = true; break; }
    }
    assertTrue(removedAfterDelay, 'install directory was removed by the delayed self-delete after the exe would have exited');
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
    // Belt-and-suspenders: make sure the real HKCU key never survives this
    // test run even if an assertion above failed mid-way.
    try {
      await runPowerShell(`Remove-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${setup.UNINSTALL_KEY}' -Recurse -Force -ErrorAction SilentlyContinue`);
    } catch { /* ignore */ }
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('TEST SCRIPT ERROR:', error);
  process.exit(1);
});
