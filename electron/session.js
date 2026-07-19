'use strict';

/** Versioned, integrity-checked Riot session snapshots bound to one roster identity. */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;
const MANIFEST_FILE = 'manifest.json';
const LOCAL = path.join(os.homedir(), 'AppData', 'Local', 'Riot Games');
const RIOT_DATA = path.join(LOCAL, 'Riot Client', 'Data');
const RIOT_CONFIG = path.join(LOCAL, 'Riot Client', 'Config');
const LOL_DATA = path.join(LOCAL, 'League of Legends', 'Data');
const SETTINGS_FILE = 'RiotGamesPrivateSettings.yaml';

function sessionsDir(userData) {
  const dir = path.join(userData, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function accountDir(userData, id) { return path.join(userData, 'sessions', String(id)); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function compatibilityMarker() {
  let username = '';
  try { username = os.userInfo().username; } catch { /* unavailable */ }
  return crypto.createHash('sha256').update(`${process.platform}\0${os.hostname()}\0${username}`).digest('hex');
}
function normalize(value) { return String(value || '').trim().toLowerCase(); }
function unavailable(reason, detail = '') {
  return { available: false, identityVerified: false, reason, detail, capturedAt: null };
}

function copyDir(src, dest, skip = () => false, bestEffort = false) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const source = path.join(src, entry.name);
    const target = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) count += copyDir(source, target, skip, bestEffort);
      else { fs.copyFileSync(source, target); count += 1; }
    } catch (error) {
      if (!bestEffort) throw error;
    }
  }
  return count;
}
/** Validate integrity, machine compatibility, and account binding without restoring. */
function validateSession(userData, id, account) {
  const dir = accountDir(userData, id);
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(dir)) return unavailable('missing', 'No saved session.');
  if (!fs.existsSync(manifestPath)) return unavailable('legacy', 'Legacy snapshot must be recaptured.');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { return unavailable('corrupt-manifest', 'Session manifest is unreadable.'); }
  if (manifest.schemaVersion !== SCHEMA_VERSION) return unavailable('unsupported-version', 'Session snapshot version is unsupported.');
  if (String(manifest.accountId) !== String(id)) return unavailable('account-mismatch', 'Snapshot belongs to another roster entry.');
  if (manifest.compatibility !== compatibilityMarker()) return unavailable('machine-mismatch', 'Snapshot was captured for another Windows user or machine.');
  if (!account || !account.puuid) return unavailable('unlinked-account', 'Link this roster entry to a Riot identity first.');
  if (!manifest.identity || !manifest.identity.puuid || normalize(manifest.identity.puuid) !== normalize(account.puuid)) {
    return unavailable('identity-mismatch', 'Snapshot Riot identity does not match this roster entry.');
  }
  const settings = path.join(dir, SETTINGS_FILE);
  const artifact = (manifest.artifacts || []).find((item) => item.name === SETTINGS_FILE && item.required);
  if (!artifact || !fs.existsSync(settings)) return unavailable('missing-settings', 'Required Riot session data is missing.');
  const stat = fs.statSync(settings);
  if (!stat.isFile() || stat.size < 1 || stat.size !== artifact.size) return unavailable('invalid-settings', 'Required Riot session data is empty or incomplete.');
  try {
    if (sha256(settings) !== artifact.sha256) return unavailable('integrity-failed', 'Saved Riot session data failed its integrity check.');
  } catch { return unavailable('integrity-failed', 'Saved Riot session data could not be verified.'); }
  return {
    available: true,
    identityVerified: true,
    reason: null,
    detail: '',
    capturedAt: manifest.capturedAt,
    riotId: manifest.identity.riotId || null,
    manifest,
  };
}

function hasSession(userData, id, account) {
  return validateSession(userData, id, account).available;
}

function validateNewSnapshot(dir, id, account) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')); }
  catch { return unavailable('corrupt-manifest'); }
  const settings = path.join(dir, SETTINGS_FILE);
  const artifact = (manifest.artifacts || []).find((item) => item.name === SETTINGS_FILE && item.required);
  if (manifest.schemaVersion !== SCHEMA_VERSION || String(manifest.accountId) !== String(id) || !artifact || !fs.existsSync(settings)) return unavailable('invalid-new-snapshot');
  if (!account.puuid || normalize(manifest.identity && manifest.identity.puuid) !== normalize(account.puuid)) return unavailable('identity-mismatch');
  const stat = fs.statSync(settings);
  if (stat.size < 1 || stat.size !== artifact.size || sha256(settings) !== artifact.sha256) return unavailable('integrity-failed');
  return { available: true };
}
/** Atomically snapshot the active session after main.js verifies its identity. */
function captureSession(userData, id, account) {
  if (!account || !account.puuid) throw new Error('Link this roster entry to the signed-in Riot account before saving its session.');
  const primary = path.join(RIOT_DATA, SETTINGS_FILE);
  if (!fs.existsSync(primary) || fs.statSync(primary).size < 1) {
    throw new Error('No active Riot session found. Sign in with “Stay signed in” checked, then save the session.');
  }
  const parent = sessionsDir(userData);
  const finalDir = accountDir(userData, id);
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const tempDir = path.join(parent, `${id}.tmp-${token}`);
  const backupDir = path.join(parent, `${id}.bak-${token}`);
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    const savedSettings = path.join(tempDir, SETTINGS_FILE);
    fs.copyFileSync(primary, savedSettings);
    const configCount = copyDir(RIOT_CONFIG, path.join(tempDir, 'Config'), (name) => name.toLowerCase() === 'lockfile', true);
    const stat = fs.statSync(savedSettings);
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      accountId: String(id),
      identity: { puuid: account.puuid, riotId: account.riotId || null },
      capturedAt: new Date().toISOString(),
      compatibility: compatibilityMarker(),
      artifacts: [
        { name: SETTINGS_FILE, path: SETTINGS_FILE, required: true, size: stat.size, sha256: sha256(savedSettings) },
        { name: 'Config', path: 'Config', required: false, fileCount: configCount },
      ],
    };
    fs.writeFileSync(path.join(tempDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    const checked = validateNewSnapshot(tempDir, id, account);
    if (!checked.available) throw new Error(`Could not validate the new session snapshot: ${checked.reason}.`);
    if (fs.existsSync(finalDir)) fs.renameSync(finalDir, backupDir);
    try { fs.renameSync(tempDir, finalDir); }
    catch (error) {
      if (fs.existsSync(backupDir)) fs.renameSync(backupDir, finalDir);
      throw error;
    }
    fs.rmSync(backupDir, { recursive: true, force: true });
    return validateSession(userData, id, account);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
/** Restore only a currently valid, identity-bound snapshot. */
function restoreSession(userData, id, account) {
  const status = validateSession(userData, id, account);
  if (!status.available) throw new Error(`Saved session is not usable: ${status.detail || status.reason}.`);
  const dir = accountDir(userData, id);
  const savedSettings = path.join(dir, SETTINGS_FILE);
  for (const target of [RIOT_DATA, LOL_DATA]) {
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(savedSettings, path.join(target, SETTINGS_FILE));
  }
  copyDir(path.join(dir, 'Config'), RIOT_CONFIG, (name) => name.toLowerCase() === 'lockfile', true);
  return { ok: true, status };
}

/**
 * Wait until Riot has written a new, durable private-settings file, then
 * capture it. A login can verify before Chromium flushes its persistent token;
 * sampling size + mtime prevents saving the pre-login or half-written file.
 */
async function captureWhenStable(userData, id, account, options = {}) {
  const sinceMs = Number(options.sinceMs || 0);
  const timeoutMs = Number(options.timeoutMs || 30000);
  const sampleMs = Number(options.sampleMs || 750);
  const requiredStableSamples = Number(options.stableSamples || 3);
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let stable = 0;

  while (Date.now() < deadline) {
    try {
      const stat = fs.statSync(path.join(RIOT_DATA, SETTINGS_FILE));
      const current = `${stat.size}:${stat.mtimeMs}`;
      const isFresh = stat.size > 0 && (!sinceMs || stat.mtimeMs >= sinceMs - 1000);
      if (isFresh && current === previous) stable += 1;
      else stable = isFresh ? 1 : 0;
      previous = current;
      if (stable >= requiredStableSamples) return captureSession(userData, id, account);
    } catch {
      previous = null;
      stable = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
  }
  throw new Error('Riot verified the account, but its persistent session file was not updated and stable before the capture timeout.');
}

function removeSession(userData, id) {
  fs.rmSync(accountDir(userData, id), { recursive: true, force: true });
}

module.exports = {
  SCHEMA_VERSION,
  validateSession,
  hasSession,
  captureSession,
  captureWhenStable,
  restoreSession,
  removeSession,
};