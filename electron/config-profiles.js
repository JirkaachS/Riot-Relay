'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 16;
const REGISTRY_ROOT = 'HKEY_CURRENT_USER\\Software\\Riot Games\\Legends of Runeterra';
const FILE_GAMES = new Set(['league']);
const MAX_CLOUD_SETTINGS_BYTES = 8 * 1024 * 1024;
const PLAYER_PREFERENCES_PATHS = new Set([
  '/player-preferences/v1/data-json/Ares.PlayerSettings',
  '/player-preferences/v1/data/Ares.PlayerSettings',
  '/player-preferences/v1/data-json/productId/valorant/type/Ares.PlayerSettings',
]);

const VALORANT_FILES = [
  ['game-user-settings', 'GameUserSettings.ini'],
  ['riot-user-settings', 'RiotUserSettings.ini'],
  ['input-settings', 'Input.ini'],
];
const VALORANT_PLATFORMS = new Set(['Windows', 'WindowsClient']);
const VALORANT_ROUTING_SUFFIXES = new Set(['na', 'eu', 'ap', 'kr', 'br', 'latam', 'pbe']);
const LEAGUE_FILES = [
  ['persisted-settings', path.join('Config', 'PersistedSettings.json')],
  ['game-settings', path.join('Config', 'game.cfg')],
  ['input-settings', path.join('Config', 'input.ini')],
  ['client-settings', path.join('Config', 'LeagueClientSettings.yaml')],
];

function canonicalGame(game) {
  const value = String(game || '').toLowerCase();
  if (value === 'lol' || value === 'tft' || value === 'league') return 'league';
  if (value === 'valorant' || value === 'lor') return value;
  throw new Error('Unsupported game configuration profile.');
}

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function cleanIdentity(value) { return String(value || '').trim().toLowerCase(); }
function safeJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
  try { fs.renameSync(temp, file); }
  catch (error) { try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ } throw error; }
}

function assertRegularFile(file, root) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(file);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('A configuration path escaped its approved root.');
  }
  let cursor = resolved;
  while (cursor.length >= resolvedRoot.length) {
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error('Configuration symlinks and junctions are not supported.');
      if (cursor === resolved && (!stat.isFile() || stat.nlink > 1)) {
        throw new Error('Configuration files must be regular, unlinked files.');
      }
    }
    if (cursor === resolvedRoot) break;
    cursor = path.dirname(cursor);
  }
  return resolved;
}

function normalizedUuid(value) {
  const compact = cleanIdentity(value).replace(/-/g, '');
  return /^[a-f0-9]{32}$/.test(compact) ? compact : '';
}

function valorantFolderIdentity(folder) {
  const match = String(folder || '').match(/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32})(?:-([a-z0-9]{2,5}))?$/i);
  if (!match) return null;
  const suffix = String(match[2] || '').toLowerCase();
  if (suffix && !VALORANT_ROUTING_SUFFIXES.has(suffix)) return null;
  const owner = normalizedUuid(match[1]);
  return owner ? { owner, suffix } : null;
}

function valorantLocatorFolder(locator) {
  if (!locator || typeof locator !== 'object') return '';
  if (locator.folder) return String(locator.folder);
  if (!locator.relativeDir || path.isAbsolute(locator.relativeDir)) return '';
  return String(locator.relativeDir).split(/[\\/]/).filter(Boolean)[0] || '';
}

function validValorantRelative(relative, folder, allowedName) {
  if (!relative || path.isAbsolute(relative)) return false;
  const parts = String(relative).split(/[\\/]/).filter(Boolean);
  return parts.length === 3
    && parts[0].toLowerCase() === String(folder).toLowerCase()
    && VALORANT_PLATFORMS.has(parts[1])
    && parts[2] === allowedName;
}

function valorantLocator(localAppData, puuid, expectedLocator = null) {
  const root = path.join(localAppData, 'VALORANT', 'Saved', 'Config');
  if (!fs.existsSync(root)) throw new Error('VALORANT configuration was not found for this Windows user.');
  const candidates = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const identity = valorantFolderIdentity(entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !identity) continue;
    const files = [];
    const fileIds = new Set();
    let duplicateFile = false;
    for (const platform of VALORANT_PLATFORMS) {
      const dir = path.join(root, entry.name, platform);
      for (const [id, name] of VALORANT_FILES) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        assertRegularFile(file, root);
        if (fileIds.has(id)) { duplicateFile = true; continue; }
        fileIds.add(id);
        files.push({ id, relative: path.join(entry.name, platform, name) });
      }
    }
    if (files.length) candidates.push({ root, folder: entry.name, identity, files, duplicateFile });
  }
  if (!candidates.length) throw new Error('No safe VALORANT preference files were found. Launch VALORANT once, close it, then capture again.');
  const wanted = normalizedUuid(puuid);
  if (!wanted) throw new Error('The verified VALORANT PUUID has an unsupported format. Sync the account again.');
  const owned = candidates.filter((candidate) => candidate.identity.owner === wanted);
  if (!owned.length) {
    throw new Error('No VALORANT configuration folder belonged to this account’s verified PUUID. Launch VALORANT once with this account, close it, then capture again.');
  }
  const expectedFolder = valorantLocatorFolder(expectedLocator);
  let selected;
  if (expectedFolder) {
    const expected = owned.filter((candidate) => candidate.folder.toLowerCase() === expectedFolder.toLowerCase());
    if (expected.length !== 1) throw new Error('The captured VALORANT configuration folder changed. Capture this account again before applying settings.');
    selected = expected[0];
  } else {
    if (owned.length !== 1) throw new Error('Multiple VALORANT configuration folders belong to this PUUID. Remove the stale duplicate or capture after resolving it.');
    selected = owned[0];
  }
  if (selected.duplicateFile) throw new Error('The VALORANT configuration contains duplicate preference files across platform folders. Resolve the duplicate before capture.');
  return {
    root,
    folder: selected.folder,
    ownership: selected.identity.suffix ? 'puuid-with-routing-suffix' : 'exact-puuid-folder',
    files: selected.files,
  };
}

function leagueInstallRoot(programData = process.env.ProgramData || 'C:\\ProgramData') {
  const metadata = path.join(programData, 'Riot Games', 'Metadata', 'league_of_legends.live', 'league_of_legends.live.product_settings.yaml');
  try {
    const text = fs.readFileSync(metadata, 'utf8');
    const match = text.match(/product_install_full_path:\s*["']?([^\r\n"']+)/i);
    if (match && match[1].trim()) return match[1].trim().replace(/\\\\/g, '\\');
  } catch { /* use fixed install candidates */ }
  for (const candidate of ['C:\\Riot Games\\League of Legends', 'C:\\Program Files\\Riot Games\\League of Legends', 'C:\\Program Files (x86)\\Riot Games\\League of Legends']) {
    if (fs.existsSync(path.join(candidate, 'Config'))) return candidate;
  }
  throw new Error('League of Legends installation was not found.');
}
function safeRegistryPreference(name) {
  const value = String(name || '').toLowerCase();
  if (/(?:auth|token|session|cookie|credential|password|account|puuid|entitlement|login)/.test(value)) return false;
  return /(?:screen|resolution|window|display|fullscreen|quality|graphics|render|texture|shadow|fps|vsync|volume|audio|sound|music|voice|language|locale|mouse|keyboard|keybind|input|accessibility|color|brightness)/.test(value);
}

function queryRegistry() {
  if (process.platform !== 'win32') throw new Error('Legends of Runeterra configuration migration is available on Windows only.');
  let output = '';
  try { output = execFileSync('reg.exe', ['query', REGISTRY_ROOT, '/s', '/reg:64'], { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }); }
  catch (error) {
    if (error && (error.status === 1 || error.code === 1)) return [];
    throw new Error('Legends of Runeterra preferences could not be read.');
  }
  let key = REGISTRY_ROOT;
  const rows = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (/^HKEY_/i.test(line.trim())) {
      key = line.trim();
      if (!key.toLowerCase().startsWith(REGISTRY_ROOT.toLowerCase())) throw new Error('Unexpected Runeterra registry path.');
      continue;
    }
    const match = line.match(/^\s{4}(.+?)\s{4}(REG_(?:SZ|EXPAND_SZ|DWORD|QWORD))\s{4}(.*)$/i);
    if (!match) continue;
    const name = match[1] === '(Default)' ? '' : match[1];
    if (!safeRegistryPreference(name)) continue;
    if (name.length > 256 || match[3].length > 8192) throw new Error('A Runeterra preference exceeded the safety limit.');
    rows.push({ key, name, type: match[2].toUpperCase(), data: match[3] });
    if (rows.length > 512) throw new Error('Too many Runeterra preference values were found.');
  }
  return rows;
}

function setRegistryRow(row) {
  const args = ['add', row.key, row.name ? '/v' : '/ve', ...(row.name ? [row.name] : []), '/t', row.type, '/d', row.data, '/f', '/reg:64'];
  execFileSync('reg.exe', args, { windowsHide: true, timeout: 8000, stdio: 'ignore' });
}

function deleteRegistryRow(row) {
  const args = ['delete', row.key, row.name ? '/v' : '/ve', ...(row.name ? [row.name] : []), '/f', '/reg:64'];
  try { execFileSync('reg.exe', args, { windowsHide: true, timeout: 8000, stdio: 'ignore' }); } catch { /* absent is acceptable */ }
}

class ConfigProfiles {
  constructor(userData, options = {}) {
    this.userData = userData;
    this.root = path.join(userData, 'config-profiles');
    this.transactions = path.join(userData, 'config-transactions');
    this.bindingsFile = path.join(this.root, 'bindings.json');
    this.keyFile = path.join(this.root, '.identity-key');
    this.localAppData = options.localAppData || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    this.programData = options.programData || process.env.ProgramData || 'C:\\ProgramData';
  }

  identityHash(puuid) {
    const identity = cleanIdentity(puuid);
    if (!identity) throw new Error('The account must be linked to a verified PUUID first.');
    fs.mkdirSync(this.root, { recursive: true });
    let key;
    try { key = fs.readFileSync(this.keyFile); }
    catch {
      key = crypto.randomBytes(32);
      fs.writeFileSync(this.keyFile, key, { flag: 'wx', mode: 0o600 });
    }
    return crypto.createHmac('sha256', key).update(identity).digest('hex');
  }

  profileDir(identityHash, game) { return path.join(this.root, identityHash, canonicalGame(game)); }
  manifest(identityHash, game) { return safeJson(path.join(this.profileDir(identityHash, game), 'manifest.json')); }
  bindings() { const value = safeJson(this.bindingsFile); return value && value.schemaVersion === SCHEMA_VERSION ? value : { schemaVersion: SCHEMA_VERSION, targets: {} }; }

  capture(account, game) {
    const namespace = canonicalGame(game);
    if (namespace === 'valorant') {
      throw new Error('Local-file VALORANT migration is disabled. Use the exact-PUUID cloud settings migration instead.');
    }
    const identityHash = this.identityHash(account && account.puuid);
    const finalDir = this.profileDir(identityHash, namespace);
    const tempDir = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.join(tempDir, 'files'), { recursive: true });
    let manifest;
    try {
      if (namespace === 'lor') {
        const registry = queryRegistry();
        if (!registry.length) throw new Error('No Legends of Runeterra preferences were found. Launch the game once, close it, then capture again.');
        manifest = { schemaVersion: SCHEMA_VERSION, game: namespace, identityHash, capturedAt: new Date().toISOString(), registry };
      } else {
        const locator = namespace === 'valorant'
          ? valorantLocator(this.localAppData, account && account.puuid)
          : { root: leagueInstallRoot(this.programData), relativeDir: '' };
        const definitions = namespace === 'valorant'
          ? locator.files.map((item) => [item.id, item.relative])
          : LEAGUE_FILES;
        const files = [];
        let total = 0;
        for (const [id, relative] of definitions) {
          const source = path.join(locator.root, relative);
          if (!fs.existsSync(source)) continue;
          assertRegularFile(source, locator.root);
          const data = fs.readFileSync(source);
          if (!data.length || data.length > MAX_FILE_BYTES) throw new Error(`${id} exceeded the safe configuration size limit.`);
          total += data.length;
          if (total > MAX_TOTAL_BYTES || files.length >= MAX_FILES) throw new Error('The configuration profile exceeded its safety limits.');
          const blob = `${files.length}.bin`;
          fs.writeFileSync(path.join(tempDir, 'files', blob), data, { flag: 'wx' });
          files.push({ id, relative, blob, size: data.length, sha256: sha256(data) });
        }
        if (!files.length) throw new Error(`No safe ${namespace === 'league' ? 'League/TFT' : 'VALORANT'} preference files were found.`);
        manifest = { schemaVersion: SCHEMA_VERSION, game: namespace, identityHash, capturedAt: new Date().toISOString(), locator, files };
      }
      atomicJson(path.join(tempDir, 'manifest.json'), manifest);
      const backup = `${finalDir}.bak-${process.pid}-${Date.now()}`;
      fs.mkdirSync(path.dirname(finalDir), { recursive: true });
      if (fs.existsSync(finalDir)) fs.renameSync(finalDir, backup);
      try { fs.renameSync(tempDir, finalDir); }
      catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, finalDir); throw error; }
      fs.rmSync(backup, { recursive: true, force: true });
      return { captured: true, game: namespace, capturedAt: manifest.capturedAt, itemCount: manifest.files ? manifest.files.length : manifest.registry.length };
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  migrate(sourceAccount, targetAccount, game) {
    const namespace = canonicalGame(game);
    if (namespace === 'valorant') {
      throw new Error('Local-file VALORANT migration is disabled. Use the exact-PUUID cloud settings migration instead.');
    }
    const sourceHash = this.identityHash(sourceAccount && sourceAccount.puuid);
    const targetHash = this.identityHash(targetAccount && targetAccount.puuid);
    if (sourceHash === targetHash) throw new Error('Source and target accounts must be different.');
    const sourceManifest = this._validatedManifest(sourceHash, namespace);
    const targetManifest = this._validatedManifest(targetHash, namespace);
    if (namespace === 'valorant'
      && valorantLocatorFolder(sourceManifest.locator).toLowerCase() === valorantLocatorFolder(targetManifest.locator).toLowerCase()) {
      throw new Error('Source and target resolved to the same VALORANT configuration folder; capture each verified account separately.');
    }
    const bindings = this.bindings();
    const previous = bindings.targets[`${targetHash}:${namespace}`] || {};
    bindings.targets[`${targetHash}:${namespace}`] = {
      sourceHash,
      updatedAt: new Date().toISOString(),
      lastAttemptAt: previous.lastAttemptAt || null,
      lastAppliedAt: previous.lastAppliedAt || null,
      lastResult: previous.sourceHash === sourceHash ? previous.lastResult || null : null,
    };
    atomicJson(this.bindingsFile, bindings);
    return { persistent: true, game: namespace, appliesOnNextLaunch: false, bound: true };
  }

  removeBinding(targetAccount, game) {
    const namespace = canonicalGame(game);
    const targetHash = this.identityHash(targetAccount && targetAccount.puuid);
    const bindings = this.bindings();
    delete bindings.targets[`${targetHash}:${namespace}`];
    atomicJson(this.bindingsFile, bindings);
    return { removed: true, game: namespace };
  }

  cloudFile(identityHash) { return path.join(this.profileDir(identityHash, 'valorant'), 'cloud.json'); }

  cloudBackupFile(identityHash) { return path.join(this.profileDir(identityHash, 'valorant'), 'cloud-backup.json'); }

  // The VALORANT settings payload is plaintext JSON (the local player-preferences
  // plugin format), so validate it as a bounded, non-empty JSON object string.
  _validSettingsBlob(value) {
    if (typeof value !== 'string' || !value.trim()
      || Buffer.byteLength(value, 'utf8') > MAX_CLOUD_SETTINGS_BYTES) return false;
    try {
      const parsed = JSON.parse(value);
      return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch { return false; }
  }

  _validPlayerPreferencesPath(value) {
    return PLAYER_PREFERENCES_PATHS.has(String(value || '')) ? String(value) : null;
  }

  /** Store the captured VALORANT settings JSON and confirmed local route for an account. */
  saveCloudSettings(account, blob, playerPreferencesPath = '') {
    if (!this._validSettingsBlob(blob)) throw new Error('Refusing to store invalid VALORANT settings.');
    const identityHash = this.identityHash(account && account.puuid);
    const file = this.cloudFile(identityHash);
    const capturedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicJson(file, {
      schemaVersion: SCHEMA_VERSION,
      identityHash,
      capturedAt,
      playerPreferencesPath: this._validPlayerPreferencesPath(playerPreferencesPath),
      blob,
    });
    return { captured: true, capturedAt };
  }

  /** Read a previously captured settings blob, or null when absent/invalid. */
  readCloudSettings(account) {
    const identityHash = this.identityHash(account && account.puuid);
    const value = safeJson(this.cloudFile(identityHash));
    if (!value || value.schemaVersion !== SCHEMA_VERSION || value.identityHash !== identityHash
      || !this._validSettingsBlob(value.blob)) return null;
    return {
      blob: value.blob,
      capturedAt: Number.isFinite(Date.parse(value.capturedAt)) ? new Date(value.capturedAt).toISOString() : null,
      playerPreferencesPath: this._validPlayerPreferencesPath(value.playerPreferencesPath),
    };
  }

  hasCloudSettings(account) {
    if (!account || !account.puuid) return false;
    return !!this.readCloudSettings(account);
  }

  /**
   * Persist the target's latest pre-write state. This intentionally implements
   * one-level undo: each verified Apply replaces the prior backup with the
   * settings observed immediately before that Apply.
   */
  backupCloudSettings(account, blob, playerPreferencesPath = '') {
    if (!this._validSettingsBlob(blob)) return { backed: false };
    const identityHash = this.identityHash(account && account.puuid);
    const file = this.cloudBackupFile(identityHash);
    const backedUpAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicJson(file, {
      schemaVersion: SCHEMA_VERSION,
      identityHash,
      backedUpAt,
      playerPreferencesPath: this._validPlayerPreferencesPath(playerPreferencesPath),
      blob,
    });
    return { backed: true, backedUpAt };
  }

  readCloudBackup(account) {
    const identityHash = this.identityHash(account && account.puuid);
    const value = safeJson(this.cloudBackupFile(identityHash));
    if (!value || value.schemaVersion !== SCHEMA_VERSION || value.identityHash !== identityHash
      || !this._validSettingsBlob(value.blob)) return null;
    return {
      blob: value.blob,
      backedUpAt: Number.isFinite(Date.parse(value.backedUpAt)) ? new Date(value.backedUpAt).toISOString() : null,
      playerPreferencesPath: this._validPlayerPreferencesPath(value.playerPreferencesPath),
    };
  }

  hasBinding(targetAccount, game) {
    if (!targetAccount || !targetAccount.puuid) return false;
    const namespace = canonicalGame(game);
    // Riot's cloud roaming settings overwrite the legacy local files, so old
    // VALORANT bindings are retained on disk only for safe user-data
    // preservation and can no longer trigger launch-time writes.
    if (namespace === 'valorant') return false;
    const targetHash = this.identityHash(targetAccount.puuid);
    return !!this.bindings().targets[`${targetHash}:${namespace}`];
  }

  status(accounts) {
    const accountList = accounts || [];
    const bindings = this.bindings();
    const accountIdByHash = new Map();
    for (const account of accountList) {
      if (account.puuid) accountIdByHash.set(this.identityHash(account.puuid), account.id);
    }
    const profileState = new Map();
    const validate = (hash, game) => {
      const key = `${hash}:${game}`;
      if (profileState.has(key)) return profileState.get(key);
      try {
        const manifest = this._validatedManifest(hash, game);
        const state = { valid: true, capturedAt: Number.isFinite(Date.parse(manifest.capturedAt)) ? new Date(manifest.capturedAt).toISOString() : null };
        profileState.set(key, state);
        return state;
      } catch {
        const state = { valid: false, capturedAt: null };
        profileState.set(key, state);
        return state;
      }
    };
    return accountList.map((account) => {
      if (!account.puuid) return {
        accountId: account.id, linked: false, profiles: {}, profileCapturedAt: {}, profileErrors: {},
        bindings: {}, bindingApplicable: {}, bindingSources: {}, bindingUpdatedAt: {},
        lastAttemptAt: {}, lastAppliedAt: {}, lastResult: {},
      };
      const hash = this.identityHash(account.puuid);
      const profiles = {};
      const profileCapturedAt = {};
      const profileErrors = {};
      const persistent = {};
      const bindingApplicable = {};
      const bindingSources = {};
      const bindingUpdatedAt = {};
      const lastAttemptAt = {};
      const lastAppliedAt = {};
      const lastResult = {};
      for (const game of ['valorant', 'league', 'lor']) {
        const state = validate(hash, game);
        const binding = bindings.targets[`${hash}:${game}`];
        const sourceId = binding ? accountIdByHash.get(binding.sourceHash) || null : null;
        const sourceState = binding ? validate(binding.sourceHash, game) : { valid: false };
        profiles[game] = state.valid;
        profileCapturedAt[game] = state.capturedAt;
        profileErrors[game] = !state.valid && this.manifest(hash, game) ? 'Captured profile failed integrity validation.' : null;
        persistent[game] = !!binding;
        bindingApplicable[game] = !!(binding && sourceId && state.valid && sourceState.valid);
        bindingSources[game] = sourceId;
        bindingUpdatedAt[game] = binding && Number.isFinite(Date.parse(binding.updatedAt)) ? new Date(binding.updatedAt).toISOString() : null;
        lastAttemptAt[game] = binding && Number.isFinite(Date.parse(binding.lastAttemptAt)) ? new Date(binding.lastAttemptAt).toISOString() : null;
        lastAppliedAt[game] = binding && Number.isFinite(Date.parse(binding.lastAppliedAt)) ? new Date(binding.lastAppliedAt).toISOString() : null;
        const result = binding && binding.lastResult;
        lastResult[game] = result && typeof result === 'object' ? {
          status: ['changed', 'unchanged', 'failed'].includes(result.status) ? result.status : 'failed',
          changed: Math.max(0, Number(result.changed) || 0),
          unchanged: Math.max(0, Number(result.unchanged) || 0),
          skipped: Math.max(0, Number(result.skipped) || 0),
          verified: result.verified === true,
        } : null;
      }
      const cloud = this.readCloudSettings(account);
      const cloudBackup = this.readCloudBackup(account);
      return {
        accountId: account.id, linked: true, profiles, profileCapturedAt, profileErrors,
        bindings: persistent, bindingApplicable, bindingSources, bindingUpdatedAt,
        lastAttemptAt, lastAppliedAt, lastResult,
        cloudCaptured: !!cloud,
        cloudCapturedAt: cloud ? cloud.capturedAt : null,
        cloudBackupAvailable: !!cloudBackup,
      };
    });
  }

  applyForTarget(targetAccount, game) {
    const namespace = canonicalGame(game);
    if (namespace === 'valorant') {
      throw new Error('Local-file VALORANT migration is disabled. No local settings were changed.');
    }
    const targetHash = this.identityHash(targetAccount && targetAccount.puuid);
    const binding = this.bindings().targets[`${targetHash}:${namespace}`];
    if (!binding) return { applied: false, verified: false, reason: 'not-configured', game: namespace, changed: 0, unchanged: 0, skipped: 0 };
    try {
      const source = this._validatedManifest(binding.sourceHash, namespace);
      const target = this._validatedManifest(targetHash, namespace);
      const raw = namespace === 'lor'
        ? this._applyRegistry(source, targetHash, namespace)
        : this._applyFiles(source, target, targetHash, namespace, targetAccount);
      const result = {
        status: raw.changed > 0 ? 'changed' : 'unchanged',
        changed: raw.changed, unchanged: raw.unchanged, skipped: raw.skipped, verified: true,
      };
      const appliedAt = this._recordApplication(targetHash, namespace, result);
      return {
        applied: result.status === 'changed', verified: true, game: namespace, status: result.status,
        changed: result.changed, unchanged: result.unchanged, skipped: result.skipped, appliedAt,
        writtenFiles: Array.isArray(raw.writtenFiles) ? raw.writtenFiles : [],
      };
    } catch (error) {
      this._recordApplication(targetHash, namespace, { status: 'failed', changed: 0, unchanged: 0, skipped: 0, verified: false });
      throw error;
    }
  }

  verifyAppliedForTarget(targetAccount, game) {
    const namespace = canonicalGame(game);
    if (namespace === 'valorant') {
      return { verified: false, persisted: false, reason: 'cloud-only', matched: 0, mismatched: 0, skipped: 0 };
    }
    const targetHash = this.identityHash(targetAccount && targetAccount.puuid);
    const binding = this.bindings().targets[`${targetHash}:${namespace}`];
    if (!binding) return { verified: false, persisted: false, reason: 'not-configured', matched: 0, mismatched: 0, skipped: 0 };
    const source = this._validatedManifest(binding.sourceHash, namespace);
    const target = this._validatedManifest(targetHash, namespace);
    if (namespace === 'lor') {
      const current = new Map(queryRegistry().map((row) => [`${row.key.toLowerCase()}\0${row.name.toLowerCase()}`, row]));
      let matched = 0;
      let mismatched = 0;
      for (const row of source.registry) {
        const actual = current.get(`${row.key.toLowerCase()}\0${row.name.toLowerCase()}`);
        if (actual && actual.type === row.type && actual.data === row.data) matched += 1;
        else mismatched += 1;
      }
      const verified = matched > 0 && mismatched === 0;
      const previous = binding.lastResult || {};
      this._recordApplication(targetHash, namespace, {
        status: verified ? previous.status || 'unchanged' : 'failed',
        changed: previous.changed || 0, unchanged: previous.unchanged || 0, skipped: previous.skipped || 0, verified,
      });
      return { verified, persisted: verified, matched, mismatched, skipped: 0 };
    }

    const allowed = new Map(namespace === 'valorant' ? VALORANT_FILES : LEAGUE_FILES);
    const locator = namespace === 'valorant'
      ? valorantLocator(this.localAppData, targetAccount && targetAccount.puuid, target.locator)
      : { root: leagueInstallRoot(this.programData), files: null };
    const liveById = namespace === 'valorant' ? new Map(locator.files.map((item) => [item.id, item.relative])) : null;
    const targetById = new Map(target.files.map((item) => [item.id, item]));
    let matched = 0;
    let mismatched = 0;
    let skipped = 0;
    for (const sourceItem of source.files) {
      const targetItem = targetById.get(sourceItem.id);
      const allowedRelative = allowed.get(sourceItem.id);
      const relative = namespace === 'valorant' ? liveById.get(sourceItem.id) : allowedRelative;
      if (!targetItem || !allowedRelative || !relative) { skipped += 1; continue; }
      if (namespace === 'valorant' && targetItem.relative !== relative) { mismatched += 1; continue; }
      const destination = assertRegularFile(path.join(locator.root, relative), locator.root);
      if (!fs.existsSync(destination)) { mismatched += 1; continue; }
      const data = fs.readFileSync(destination);
      if (sha256(data) === sourceItem.sha256) matched += 1;
      else mismatched += 1;
    }
    const verified = matched > 0 && mismatched === 0 && skipped === 0;
    const previous = binding.lastResult || {};
    this._recordApplication(targetHash, namespace, {
      status: verified ? previous.status || 'unchanged' : 'failed',
      changed: previous.changed || 0, unchanged: previous.unchanged || 0, skipped, verified,
    });
    return { verified, persisted: verified, matched, mismatched, skipped };
  }

  _recordApplication(targetHash, game, result) {
    const bindings = this.bindings();
    const key = `${targetHash}:${game}`;
    const binding = bindings.targets[key];
    if (!binding) return null;
    const now = new Date().toISOString();
    binding.lastAttemptAt = now;
    if (result.verified === true) binding.lastAppliedAt = now;
    binding.lastResult = {
      status: result.status, changed: Math.max(0, Number(result.changed) || 0),
      unchanged: Math.max(0, Number(result.unchanged) || 0), skipped: Math.max(0, Number(result.skipped) || 0),
      verified: result.verified === true,
    };
    atomicJson(this.bindingsFile, bindings);
    return binding.lastAppliedAt || null;
  }

  _validatedManifest(identityHash, game) {
    const manifest = this.manifest(identityHash, game);
    if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION || manifest.identityHash !== identityHash || manifest.game !== game) {
      throw new Error(`The ${game === 'league' ? 'League/TFT' : game.toUpperCase()} profile is missing or no longer identity-valid.`);
    }
    if (FILE_GAMES.has(game)) {
      if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) throw new Error('The configuration manifest is invalid.');
      const definitions = game === 'valorant' ? VALORANT_FILES : LEAGUE_FILES;
      const allowed = new Map(definitions);
      if (!manifest.locator || typeof manifest.locator !== 'object') throw new Error('The configuration locator is invalid.');
      const valorantFolder = game === 'valorant' ? valorantLocatorFolder(manifest.locator) : '';
      if (game === 'valorant' && (!valorantFolder || !valorantFolderIdentity(valorantFolder))) {
        throw new Error('The VALORANT configuration locator is invalid.');
      }
      let total = 0;
      const ids = new Set();
      for (const item of manifest.files) {
        const allowedRelative = allowed.get(item && item.id);
        const validRelative = game === 'valorant'
          ? validValorantRelative(item && item.relative, valorantFolder, allowedRelative)
          : item && item.relative === allowedRelative;
        if (!item || !allowedRelative || !validRelative || ids.has(item.id)
          || !/^\d+\.bin$/.test(item.blob) || !/^[a-f0-9]{64}$/.test(item.sha256)) {
          throw new Error('The configuration manifest is invalid.');
        }
        ids.add(item.id);
        const blob = path.join(this.profileDir(identityHash, game), 'files', item.blob);
        assertRegularFile(blob, this.profileDir(identityHash, game));
        const data = fs.readFileSync(blob);
        total += data.length;
        if (!data.length || data.length !== item.size || sha256(data) !== item.sha256 || total > MAX_TOTAL_BYTES) throw new Error('The configuration profile failed integrity validation.');
      }
    } else {
      if (!Array.isArray(manifest.registry) || !manifest.registry.length || manifest.registry.length > 512) throw new Error('The Runeterra profile is invalid.');
      for (const row of manifest.registry) {
        if (!row || typeof row.key !== 'string' || !row.key.toLowerCase().startsWith(REGISTRY_ROOT.toLowerCase())
          || !safeRegistryPreference(row.name) || !/^REG_(?:SZ|EXPAND_SZ|DWORD|QWORD)$/.test(row.type)
          || typeof row.data !== 'string' || row.data.length > 8192) throw new Error('The Runeterra profile is invalid.');
      }
    }
    return manifest;
  }

  _transaction(targetHash, game) {
    const id = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const dir = path.join(this.transactions, targetHash, game, id);
    fs.mkdirSync(dir, { recursive: true });
    return { id, dir, manifest: { schemaVersion: SCHEMA_VERSION, game, targetHash, startedAt: new Date().toISOString(), status: 'started', files: [] } };
  }

  _applyFiles(source, target, targetHash, game, targetAccount) {
    const transaction = this._transaction(targetHash, game);
    const targetById = new Map(target.files.map((item) => [item.id, item]));
    const allowed = new Map(game === 'valorant' ? VALORANT_FILES : LEAGUE_FILES);
    const locator = game === 'valorant'
      ? valorantLocator(this.localAppData, targetAccount && targetAccount.puuid, target.locator)
      : { root: leagueInstallRoot(this.programData), relativeDir: '' };
    const liveTargetById = game === 'valorant'
      ? new Map(locator.files.map((item) => [item.id, item.relative]))
      : null;
    const changed = [];
    let unchanged = 0;
    let skipped = 0;
    try {
      for (const sourceItem of source.files) {
        const targetItem = targetById.get(sourceItem.id);
        const allowedRelative = allowed.get(sourceItem.id);
        const relative = game === 'valorant' ? liveTargetById.get(sourceItem.id) : allowedRelative;
        if (!targetItem || !allowedRelative || !relative) { skipped += 1; continue; }
        if (game === 'valorant' && targetItem.relative !== relative) {
          throw new Error('The target VALORANT configuration layout changed. Capture the target again before applying settings.');
        }
        const destination = assertRegularFile(path.join(locator.root, relative), locator.root);
        const sourceBlob = path.join(this.profileDir(source.identityHash, game), 'files', sourceItem.blob);
        const current = fs.existsSync(destination) ? fs.readFileSync(destination) : null;
        if (current && sha256(current) === sourceItem.sha256) { unchanged += 1; continue; }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const backupItem = { id: sourceItem.id, destination: relative, existed: !!current, backup: null };
        if (current) {
          assertRegularFile(destination, locator.root);
          const backup = `${transaction.manifest.files.length}.bak`;
          fs.copyFileSync(destination, path.join(transaction.dir, backup), fs.constants.COPYFILE_EXCL);
          backupItem.backup = backup;
        }
        transaction.manifest.files.push(backupItem);
        atomicJson(path.join(transaction.dir, 'manifest.json'), transaction.manifest);
        const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.riot-relay-${transaction.id}.tmp`);
        const entry = { destination, backupItem, temp };
        changed.push(entry);
        fs.copyFileSync(sourceBlob, temp, fs.constants.COPYFILE_EXCL);
        const staged = fs.readFileSync(temp);
        if (sha256(staged) !== sourceItem.sha256) throw new Error('A staged configuration file failed verification.');
        const appliedAt = new Date();
        fs.utimesSync(temp, appliedAt, appliedAt);
        fs.rmSync(destination, { force: true });
        fs.renameSync(temp, destination);
        if (sha256(fs.readFileSync(destination)) !== sourceItem.sha256) throw new Error('A replaced configuration file failed verification.');
        entry.modifiedAt = fs.statSync(destination).mtime.toISOString();
      }
      if (!changed.length && !unchanged) throw new Error('The source and target profiles have no compatible preference files.');
      transaction.manifest.status = changed.length ? 'committed' : 'verified-no-change';
      transaction.manifest.completedAt = new Date().toISOString();
      transaction.manifest.changed = changed.length;
      transaction.manifest.unchanged = unchanged;
      transaction.manifest.skipped = skipped;
      atomicJson(path.join(transaction.dir, 'manifest.json'), transaction.manifest);
      this._pruneTransactions(targetHash, game);
      return {
        changed: changed.length,
        unchanged,
        skipped,
        backupId: changed.length ? transaction.id : null,
        writtenFiles: changed.map((entry) => ({ id: entry.backupItem.id, modifiedAt: entry.modifiedAt })),
      };
    } catch (error) {
      const rollbackErrors = [];
      for (const { destination, backupItem, temp } of changed.reverse()) {
        try { fs.rmSync(temp, { force: true }); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        try {
          if (backupItem.existed) fs.copyFileSync(path.join(transaction.dir, backupItem.backup), destination);
          else fs.rmSync(destination, { force: true });
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      transaction.manifest.status = rollbackErrors.length ? 'rollback-failed' : 'rolled-back';
      transaction.manifest.error = String(error.message || error).slice(0, 180);
      atomicJson(path.join(transaction.dir, 'manifest.json'), transaction.manifest);
      if (rollbackErrors.length) throw new Error('Configuration migration failed and its backup could not be fully restored. Do not launch the game until the target files are reviewed.');
      throw new Error(`Configuration migration was rolled back: ${transaction.manifest.error}`);
    }
  }

  _applyRegistry(source, targetHash, game) {
    const transaction = this._transaction(targetHash, game);
    const before = queryRegistry();
    const keyOf = (row) => `${row.key.toLowerCase()}\0${row.name.toLowerCase()}`;
    const beforeByKey = new Map(before.map((row) => [keyOf(row), row]));
    const beforeKeys = new Set(beforeByKey.keys());
    const rowsToChange = source.registry.filter((row) => {
      const current = beforeByKey.get(keyOf(row));
      return !current || current.type !== row.type || current.data !== row.data;
    });
    const unchanged = source.registry.length - rowsToChange.length;
    transaction.manifest.registry = before;
    atomicJson(path.join(transaction.dir, 'manifest.json'), transaction.manifest);
    try {
      for (const row of rowsToChange) setRegistryRow(row);
      const afterByKey = new Map(queryRegistry().map((row) => [keyOf(row), row]));
      for (const row of source.registry) {
        const current = afterByKey.get(keyOf(row));
        if (!current || current.type !== row.type || current.data !== row.data) throw new Error('A Runeterra registry preference failed verification.');
      }
      transaction.manifest.status = rowsToChange.length ? 'committed' : 'verified-no-change';
      transaction.manifest.completedAt = new Date().toISOString();
      atomicJson(path.join(transaction.dir, 'manifest.json'), transaction.manifest);
      this._pruneTransactions(targetHash, game);
      return { changed: rowsToChange.length, unchanged, skipped: 0, backupId: rowsToChange.length ? transaction.id : null };
    } catch (error) {
      const sourceKeys = new Set(source.registry.map(keyOf));
      const rollbackErrors = [];
      for (const row of source.registry) {
        const key = keyOf(row);
        if (!beforeKeys.has(key)) {
          try { deleteRegistryRow(row); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
      }
      for (const row of before) if (sourceKeys.has(keyOf(row))) {
        try { setRegistryRow(row); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      transaction.manifest.status = rollbackErrors.length ? 'rollback-failed' : 'rolled-back';
      transaction.manifest.error = String(error.message || error).slice(0, 180);
      atomicJson(path.join(transaction.dir, 'manifest.json'), transaction.manifest);
      if (rollbackErrors.length) throw new Error('Runeterra migration failed and its backup could not be fully restored.');
      throw new Error(`Runeterra configuration migration was rolled back: ${transaction.manifest.error}`);
    }
  }

  _pruneTransactions(targetHash, game) {
    const root = path.join(this.transactions, targetHash, game);
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, modified: fs.statSync(path.join(root, entry.name)).mtimeMs }))
        .sort((a, b) => b.modified - a.modified);
      entries.slice(5).forEach((entry) => fs.rmSync(path.join(root, entry.name), { recursive: true, force: true }));
    } catch { /* backup retention is best effort */ }
  }
}

module.exports = {
  ConfigProfiles,
  canonicalGame,
  SCHEMA_VERSION,
  REGISTRY_ROOT,
};
