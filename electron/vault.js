'use strict';

/**
 * vault.js — Encrypted credential store.
 *
 * Security model
 * --------------
 *  - Every account secret (password) is sealed with AES-256-GCM.
 *  - The symmetric key is derived from the user's master password using scrypt
 *    with a per-vault random salt (N=2^15). GCM auth tags guarantee integrity;
 *    a tampered file will fail to decrypt rather than return garbage.
 *  - OS-keystore storage is disabled by default and can only be enabled from
 *    inside an authenticated vault. Stored keys are versioned and bound to the
 *    vault before they can be used for passwordless unlock.
 *  - Plaintext secrets never touch disk. Only ciphertext + salt + nonce + tag.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, keylen: 32 };
const MAGIC = 'VNGRD1';
const LEGACY_TFT_RUNTIME_ERRORS = new Set(['path is not defined', 'referenceerror: path is not defined']);

function sanitizeStats(stats) {
  if (!stats || typeof stats !== 'object' || !stats.tft || typeof stats.tft !== 'object') return stats;
  const tft = stats.tft;
  const queues = Array.isArray(tft.queues) ? tft.queues : [];
  const error = String(tft.error || '').trim().toLowerCase();
  if (tft.available === true || queues.length || !LEGACY_TFT_RUNTIME_ERRORS.has(error)) return stats;
  return {
    ...stats,
    tft: {
      ...tft,
      error: 'Previous TFT sync failed before data could be read. Sync again to retry.',
    },
  };
}

class Vault {
  /**
   * @param {string} dir            userData directory
   * @param {object} safeStorage    Electron safeStorage (optional, DPAPI layer)
   */
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'vault.dat');
    this.keyPark = path.join(dir, 'vault.key'); // DPAPI-wrapped derived key
    this.keyModeHint = path.join(dir, 'vault.key.mode'); // non-secret, authenticated after decrypt
    this.safeStorage = safeStorage;
    this.key = null;               // Buffer(32) once unlocked
    this.salt = null;              // Buffer(16)
    this.data = { accounts: [], rosterSections: [] };  // decrypted in-memory model
  }

  exists() {
    return fs.existsSync(this.file);
  }

  isUnlocked() {
    return this.key !== null;
  }

  _deriveKey(password, salt) {
    return crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: 256 * 1024 * 1024,
    });
  }

  _seal(plaintextBuf, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString('base64'), ct: enc.toString('base64'), tag: tag.toString('base64') };
  }

  _open(sealed, key) {
    const iv = Buffer.from(sealed.iv, 'base64');
    const ct = Buffer.from(sealed.ct, 'base64');
    const tag = Buffer.from(sealed.tag, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  /** Create a brand new vault protected by `masterPassword`. */
  create(masterPassword) {
    this.salt = crypto.randomBytes(16);
    this.key = this._deriveKey(masterPassword, this.salt);
    this.data = {
      accounts: [],
      rosterSections: [],
      capabilities: { osKeyMode: 'disabled' },
      createdAt: new Date().toISOString(),
    };
    this._persist();
    this.forgetParkedKey();
    return true;
  }

  _normalizeHelloCredential(value) {
    const credential = value && typeof value === 'object' ? value : {};
    const id = String(credential.id || '');
    const publicKey = String(credential.publicKey || '');
    const algorithm = Number(credential.algorithm);
    if (!/^[A-Za-z0-9_-]{16,2048}$/.test(id)
      || !/^[A-Za-z0-9_-]{32,8192}$/.test(publicKey)
      || ![-7, -257].includes(algorithm)) return null;
    return { id, publicKey, algorithm };
  }

  _helloCredentialHash(value) {
    const credential = this._normalizeHelloCredential(value);
    if (!credential) return '';
    return crypto.createHash('sha256')
      .update(JSON.stringify([credential.id, credential.publicKey, credential.algorithm]))
      .digest('base64');
  }

  _normalizedData(value) {
    const data = value && typeof value === 'object' ? value : {};
    if (!Array.isArray(data.rosterSections)) data.rosterSections = [];
    const seenSectionIds = new Set();
    const seenSectionNames = new Set();
    data.rosterSections = data.rosterSections.flatMap((section, index) => {
      if (!section || typeof section !== 'object') return [];
      const id = String(section.id || '').trim();
      const name = String(section.name || '').trim().slice(0, 64);
      const nameKey = name.toLocaleLowerCase();
      if (!/^[0-9a-f-]{36}$/i.test(id) || !name || seenSectionIds.has(id) || seenSectionNames.has(nameKey)) return [];
      seenSectionIds.add(id);
      seenSectionNames.add(nameKey);
      return [{
        id,
        name,
        order: Number.isFinite(Number(section.order)) ? Number(section.order) : index,
        rosterHidden: section.rosterHidden === true,
        createdAt: section.createdAt || null,
        updatedAt: section.updatedAt || null,
      }];
    }).sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
    data.rosterSections.forEach((section, index) => { section.order = index; });
    const validSectionIds = new Set(data.rosterSections.map((section) => section.id));
    if (!Array.isArray(data.accounts)) data.accounts = [];
    data.accounts = data.accounts.flatMap((account, index) => account && typeof account === 'object'
      ? [{
        ...account,
        sectionId: validSectionIds.has(String(account.sectionId || '')) ? String(account.sectionId) : null,
        rosterOrder: Number.isSafeInteger(Number(account.rosterOrder)) && Number(account.rosterOrder) >= 0
          ? Number(account.rosterOrder) : Number.MAX_SAFE_INTEGER,
        rosterHidden: account.rosterHidden === true,
        stats: sanitizeStats(account.stats),
        _legacyRosterIndex: index,
      }]
      : []);
    const bucketIds = [null, ...data.rosterSections.map((section) => section.id)];
    for (const sectionId of bucketIds) {
      data.accounts.filter((account) => account.sectionId === sectionId)
        .sort((left, right) => left.rosterOrder - right.rosterOrder
          || left._legacyRosterIndex - right._legacyRosterIndex
          || String(left.label || left.username || '').localeCompare(String(right.label || right.username || ''))
          || String(left.id || '').localeCompare(String(right.id || '')))
        .forEach((account, index) => { account.rosterOrder = index; });
    }
    data.accounts.forEach((account) => { delete account._legacyRosterIndex; });
    if (!data.capabilities || typeof data.capabilities !== 'object') data.capabilities = {};
    const legacyMode = data.capabilities.osKeyStorage === true ? 'os' : 'disabled';
    const requestedMode = String(data.capabilities.osKeyMode || legacyMode);
    const helloCredential = this._normalizeHelloCredential(data.capabilities.windowsHelloCredential);
    data.capabilities.osKeyMode = ['disabled', 'os', 'hello'].includes(requestedMode)
      ? requestedMode : 'disabled';
    if (data.capabilities.osKeyMode === 'hello' && !helloCredential) data.capabilities.osKeyMode = 'disabled';
    if (data.capabilities.osKeyMode === 'hello') data.capabilities.windowsHelloCredential = helloCredential;
    else delete data.capabilities.windowsHelloCredential;
    delete data.capabilities.osKeyStorage;
    return data;
  }

  _vaultBinding(salt) {
    return crypto.createHash('sha256').update(MAGIC).update(salt).digest('base64');
  }

  /** Unlock an existing vault with the master password. Throws on bad password. */
  unlock(masterPassword) {
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (raw.magic !== MAGIC) throw new Error('Unrecognized vault format.');
    const candidateSalt = Buffer.from(raw.salt, 'base64');
    if (candidateSalt.length !== 16) throw new Error('Invalid vault salt.');
    const candidateKey = this._deriveKey(masterPassword, candidateSalt);
    const plain = this._open(raw.payload, candidateKey); // throws if wrong password
    const candidateData = this._normalizedData(JSON.parse(plain.toString('utf8')));
    if (candidateData.capabilities.osKeyMode === 'disabled') this.forgetParkedKey();
    this.salt = candidateSalt;
    this.key = candidateKey;
    this.data = candidateData;
    return true;
  }

  getKeyStorageMode() {
    if (!this.isUnlocked() || !this.data.capabilities) return 'disabled';
    const mode = String(this.data.capabilities.osKeyMode || 'disabled');
    return ['os', 'hello'].includes(mode) ? mode : 'disabled';
  }

  _readParkedHint() {
    try {
      if (!fs.existsSync(this.file) || !fs.existsSync(this.keyPark)
        || !this.safeStorage || !this.safeStorage.isEncryptionAvailable()) return null;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw.magic !== MAGIC) return null;
      const vaultSalt = Buffer.from(raw.salt || '', 'base64');
      if (vaultSalt.length !== 16) return null;
      if (!fs.existsSync(this.keyModeHint)) return { mode: 'os', helloCredential: null }; // version 2 legacy blobs
      const hint = JSON.parse(fs.readFileSync(this.keyModeHint, 'utf8'));
      if (![1, 2].includes(hint.version) || hint.magic !== MAGIC
        || !['os', 'hello'].includes(hint.mode)
        || hint.vaultBinding !== this._vaultBinding(vaultSalt)) return null;
      const helloCredential = this._normalizeHelloCredential(hint.windowsHelloCredential);
      if (hint.mode === 'hello' && (hint.version !== 2 || !helloCredential)) return null;
      return { mode: hint.mode, helloCredential };
    } catch { return null; }
  }

  parkedKeyMode() {
    const hint = this._readParkedHint();
    return hint ? hint.mode : 'disabled';
  }

  parkedHelloCredential() {
    const hint = this._readParkedHint();
    return hint && hint.mode === 'hello' ? { ...hint.helloCredential } : null;
  }

  _readParkedCandidate(expectedMode, expectedHelloCredential = null) {
    if (!fs.existsSync(this.keyPark) || !this.safeStorage || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('No stored key is available on this machine.');
    }
    let candidateKey = null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw.magic !== MAGIC) throw new Error('Unrecognized vault format.');
      const vaultSalt = Buffer.from(raw.salt, 'base64');
      const wrapped = fs.readFileSync(this.keyPark);
      const blob = JSON.parse(this.safeStorage.decryptString(wrapped));
      const candidateSalt = Buffer.from(blob.salt || '', 'base64');
      candidateKey = Buffer.from(blob.key || '', 'base64');
      const mode = blob.version === 2 ? 'os' : String(blob.mode || '');
      const validVersion = blob.version === 2
        || (blob.version === 3 && mode === 'os')
        || (blob.version === 4 && ['os', 'hello'].includes(mode));
      const helloHash = expectedMode === 'hello' ? this._helloCredentialHash(expectedHelloCredential) : '';
      if (!validVersion || blob.magic !== MAGIC || mode !== expectedMode
        || (mode === 'hello' && (!helloHash || blob.windowsHelloCredentialHash !== helloHash))
        || candidateSalt.length !== 16 || candidateKey.length !== 32
        || candidateSalt.length !== vaultSalt.length
        || !crypto.timingSafeEqual(candidateSalt, vaultSalt)
        || blob.vaultBinding !== this._vaultBinding(vaultSalt)) {
        throw new Error('Stored key does not belong to this vault or unlock mode.');
      }
      return { raw, salt: candidateSalt, key: candidateKey, mode, helloHash };
    } catch (error) {
      if (Buffer.isBuffer(candidateKey)) candidateKey.fill(0);
      throw error;
    }
  }

  /** Wrap the derived key only after this vault explicitly enables a mode. */
  parkKey() {
    if (!this.isUnlocked()) throw new Error('Unlock the vault before enabling OS key storage.');
    const mode = this.getKeyStorageMode();
    if (mode === 'disabled') throw new Error('OS key storage is disabled for this vault.');
    if (!this.safeStorage || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('The OS keystore is unavailable on this machine.');
    }
    const binding = this._vaultBinding(this.salt);
    const helloCredential = mode === 'hello'
      ? this._normalizeHelloCredential(this.data.capabilities.windowsHelloCredential) : null;
    const helloHash = mode === 'hello' ? this._helloCredentialHash(helloCredential) : '';
    if (mode === 'hello' && !helloCredential) throw new Error('Windows Hello is not enrolled for this vault.');
    const wrapped = this.safeStorage.encryptString(JSON.stringify({
      version: 4,
      magic: MAGIC,
      mode,
      vaultBinding: binding,
      windowsHelloCredentialHash: helloHash || undefined,
      salt: this.salt.toString('base64'),
      key: this.key.toString('base64'),
    }));
    const hint = JSON.stringify({
      version: 2,
      magic: MAGIC,
      mode,
      vaultBinding: binding,
      windowsHelloCredential: helloCredential || undefined,
    });
    const keyTemp = `${this.keyPark}.tmp-${process.pid}-${Date.now()}`;
    const hintTemp = `${this.keyModeHint}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(keyTemp, wrapped);
      fs.writeFileSync(hintTemp, hint);
      fs.rmSync(this.keyPark, { force: true });
      fs.rmSync(this.keyModeHint, { force: true });
      fs.renameSync(keyTemp, this.keyPark);
      fs.renameSync(hintTemp, this.keyModeHint);
    } catch (error) {
      try { fs.rmSync(keyTemp, { force: true }); } catch { /* preserve original error */ }
      try { fs.rmSync(hintTemp, { force: true }); } catch { /* preserve original error */ }
      throw error;
    }
    return true;
  }

  hasParkedKey() {
    return this.parkedKeyMode() !== 'disabled';
  }

  /** Unlock only after the outer mode gate and encrypted capability agree. */
  unlockWithParkedKey(expectedMode, expectedHelloCredential = null) {
    if (!['os', 'hello'].includes(expectedMode)) throw new Error('Stored-key unlock mode is invalid.');
    const candidate = this._readParkedCandidate(expectedMode, expectedHelloCredential);
    try {
      const plain = this._open(candidate.raw.payload, candidate.key);
      const candidateData = this._normalizedData(JSON.parse(plain.toString('utf8')));
      const encryptedHelloHash = this._helloCredentialHash(candidateData.capabilities.windowsHelloCredential);
      if (candidateData.capabilities.osKeyMode !== candidate.mode
        || (candidate.mode === 'hello' && encryptedHelloHash !== candidate.helloHash)) {
        if (candidateData.capabilities.osKeyMode === 'disabled') this.forgetParkedKey();
        throw new Error('Stored-key unlock mode does not match this vault.');
      }
      this.salt = candidate.salt;
      this.key = candidate.key;
      this.data = candidateData;
      return true;
    } catch (error) {
      candidate.key.fill(0);
      throw error;
    }
  }

  forgetParkedKey() {
    fs.rmSync(this.keyPark, { force: true });
    fs.rmSync(this.keyModeHint, { force: true });
    if (fs.existsSync(this.keyPark) || fs.existsSync(this.keyModeHint)) {
      throw new Error('The stored key could not be removed.');
    }
    return true;
  }

  setKeyStorageMode(mode, windowsHelloCredential = null) {
    if (!this.isUnlocked()) throw new Error('Unlock the vault before changing OS key storage.');
    const requested = String(mode || 'disabled');
    if (!['disabled', 'os', 'hello'].includes(requested)) throw new Error('Invalid OS key storage mode.');
    const helloCredential = requested === 'hello' ? this._normalizeHelloCredential(windowsHelloCredential) : null;
    if (requested === 'hello' && !helloCredential) throw new Error('Windows Hello enrollment is invalid.');
    const previous = this.getKeyStorageMode();
    if (requested === previous && requested !== 'hello'
      && (requested === 'disabled' || this.parkedKeyMode() === requested)) return requested;

    if (requested === 'disabled') {
      this.forgetParkedKey();
      this.data.capabilities.osKeyMode = 'disabled';
      delete this.data.capabilities.windowsHelloCredential;
      try { this._persist(); }
      catch (error) {
        this.data.capabilities.osKeyMode = previous;
        throw error;
      }
      return 'disabled';
    }

    if (!this.safeStorage || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('The OS keystore is unavailable on this machine.');
    }
    this.data.capabilities.osKeyMode = requested;
    if (helloCredential) this.data.capabilities.windowsHelloCredential = helloCredential;
    else delete this.data.capabilities.windowsHelloCredential;
    try {
      this._persist();
      this.parkKey();
      return requested;
    } catch (error) {
      this.data.capabilities.osKeyMode = 'disabled';
      delete this.data.capabilities.windowsHelloCredential;
      try { this.forgetParkedKey(); } catch { /* remain fail-closed */ }
      try { this._persist(); } catch { /* original enable failure is primary */ }
      throw error;
    }
  }

  lock() {
    if (Buffer.isBuffer(this.key)) this.key.fill(0);
    this.key = null;
    this.salt = null;
    this.data = { accounts: [], rosterSections: [] };
  }

  _persist() {
    if (!this.key) throw new Error('Vault is locked.');
    const payload = this._seal(Buffer.from(JSON.stringify(this.data), 'utf8'), this.key);
    const out = { magic: MAGIC, salt: this.salt.toString('base64'), payload, updatedAt: new Date().toISOString() };
    fs.writeFileSync(this.file, JSON.stringify(out));
  }

  // ---- Account CRUD ---------------------------------------------------------

  listAccounts() {
    // Never expose the raw password to the renderer; flag presence instead.
    return this.data.accounts.map((a) => ({ ...a, password: undefined, hasPassword: !!a.password }));
  }

  _orderedRosterBucket(sectionId, excludingId = null) {
    return this.data.accounts.filter((account) => account.sectionId === sectionId && account.id !== excludingId)
      .sort((left, right) => Number(left.rosterOrder) - Number(right.rosterOrder)
        || String(left.label || left.username || '').localeCompare(String(right.label || right.username || ''))
        || String(left.id || '').localeCompare(String(right.id || '')));
  }

  _compactRosterBuckets(sectionIds) {
    const ids = sectionIds ? [...new Set(sectionIds)] : [null, ...this.data.rosterSections.map((section) => section.id)];
    for (const sectionId of ids) {
      this._orderedRosterBucket(sectionId).forEach((account, index) => { account.rosterOrder = index; });
    }
  }

  getAccountSecret(id) {
    const a = this.data.accounts.find((x) => x.id === id);
    return a ? a.password || '' : '';
  }

  upsertAccount(account) {
    const requestedSectionId = String(account && account.sectionId || '');
    const sectionId = this.data.rosterSections.some((section) => section.id === requestedSectionId)
      ? requestedSectionId
      : null;
    account = { ...account, sectionId };
    const now = new Date().toISOString();
    const idx = this.data.accounts.findIndex((a) => a.id === account.id);
    let previousSectionId = null;
    if (idx >= 0) {
      const prev = this.data.accounts[idx];
      previousSectionId = prev.sectionId;
      const password = account.password ? account.password : prev.password;
      const rosterOrder = prev.sectionId === sectionId
        ? prev.rosterOrder
        : this._orderedRosterBucket(sectionId, prev.id).length;
      this.data.accounts[idx] = { ...prev, ...account, id: prev.id, password, rosterOrder, updatedAt: now };
    } else {
      const id = account.id || crypto.randomUUID();
      this.data.accounts.push({
        createdAt: now,
        updatedAt: now,
        favorite: false,
        ...account,
        id,
        rosterOrder: this._orderedRosterBucket(sectionId).length,
      });
    }
    this._compactRosterBuckets(idx >= 0 ? [previousSectionId, sectionId] : [sectionId]);
    this._persist();
    return this.listAccounts();
  }

  removeAccount(id) {
    const account = this.data.accounts.find((item) => item.id === id);
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (account) this._compactRosterBuckets([account.sectionId]);
    this._persist();
    return this.listAccounts();
  }

  /** Merge live data (rank, riotId, puuid, level) into an account and save. */
  patchAccount(id, patch) {
    const idx = this.data.accounts.findIndex((a) => a.id === id);
    if (idx < 0) return this.listAccounts();
    const safePatch = { ...patch };
    if (Object.prototype.hasOwnProperty.call(safePatch, 'stats')) safePatch.stats = sanitizeStats(safePatch.stats);
    this.data.accounts[idx] = { ...this.data.accounts[idx], ...safePatch, updatedAt: new Date().toISOString() };
    this._persist();
    return this.listAccounts();
  }

  // ---- Encrypted roster organization ---------------------------------------

  listRosterSections() {
    return (this.data.rosterSections || []).map((section) => ({ ...section }));
  }

  _rosterSectionName(value, excludingId = null) {
    const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 64);
    if (!name) throw new Error('Section name is required.');
    const duplicate = this.data.rosterSections.some((section) => section.id !== excludingId
      && section.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicate) throw new Error('A roster section with that name already exists.');
    return name;
  }

  createRosterSection(name) {
    const now = new Date().toISOString();
    const section = {
      id: crypto.randomUUID(),
      name: this._rosterSectionName(name),
      order: this.data.rosterSections.length,
      rosterHidden: false,
      createdAt: now,
      updatedAt: now,
    };
    this.data.rosterSections.push(section);
    this._persist();
    return section;
  }

  renameRosterSection(id, name) {
    const section = this.data.rosterSections.find((item) => item.id === id);
    if (!section) throw new Error('Roster section not found.');
    section.name = this._rosterSectionName(name, id);
    section.updatedAt = new Date().toISOString();
    this._persist();
  }

  reorderRosterSections(orderedIds) {
    if (!Array.isArray(orderedIds)) throw new Error('Roster section order must be an array.');
    const ids = orderedIds.map((id) => String(id || ''));
    const currentIds = this.data.rosterSections.map((section) => section.id);
    if (ids.length !== currentIds.length || new Set(ids).size !== ids.length
      || ids.some((id) => !currentIds.includes(id))) {
      throw new Error('Roster section order must be an exact duplicate-free permutation.');
    }
    const order = new Map(ids.map((id, index) => [id, index]));
    this.data.rosterSections.sort((left, right) => order.get(left.id) - order.get(right.id));
    this.data.rosterSections.forEach((section, index) => { section.order = index; });
    this._persist();
  }

  moveAccountToRosterSection(accountId, sectionIdOrNull, targetIndex) {
    const account = this.data.accounts.find((item) => item.id === String(accountId || ''));
    if (!account) throw new Error('Account not found.');
    const sectionId = sectionIdOrNull === null || sectionIdOrNull === undefined || sectionIdOrNull === ''
      ? null : String(sectionIdOrNull);
    if (sectionId && !this.data.rosterSections.some((section) => section.id === sectionId)) {
      throw new Error('Roster section not found.');
    }
    if (targetIndex !== undefined && (!Number.isSafeInteger(targetIndex) || targetIndex < 0)) {
      throw new Error('Target roster index must be a non-negative integer.');
    }
    const previousSectionId = account.sectionId;
    const target = this._orderedRosterBucket(sectionId, account.id);
    const index = targetIndex === undefined ? target.length : Math.min(targetIndex, target.length);
    target.splice(index, 0, account);
    account.sectionId = sectionId;
    account.updatedAt = new Date().toISOString();
    target.forEach((item, order) => { item.rosterOrder = order; });
    if (previousSectionId !== sectionId) this._compactRosterBuckets([previousSectionId]);
    this._persist();
  }

  removeRosterSection(id) {
    if (!this.data.rosterSections.some((section) => section.id === id)) throw new Error('Roster section not found.');
    const unsectioned = this._orderedRosterBucket(null);
    const moved = this._orderedRosterBucket(id);
    this.data.rosterSections = this.data.rosterSections.filter((section) => section.id !== id);
    this.data.rosterSections.forEach((section, index) => { section.order = index; });
    const now = new Date().toISOString();
    moved.forEach((account, index) => {
      account.sectionId = null;
      account.rosterOrder = unsectioned.length + index;
      account.updatedAt = now;
    });
    this._compactRosterBuckets([null]);
    this._persist();
  }

  setRosterSectionHidden(id, hidden) {
    const section = this.data.rosterSections.find((item) => item.id === id);
    if (!section) throw new Error('Roster section not found.');
    section.rosterHidden = hidden === true;
    section.updatedAt = new Date().toISOString();
    this._persist();
  }

  setAccountRosterHidden(id, hidden) {
    const account = this.data.accounts.find((item) => item.id === id);
    if (!account) throw new Error('Account not found.');
    account.rosterHidden = hidden === true;
    account.updatedAt = new Date().toISOString();
    this._persist();
  }

  showAllRosterItems() {
    const now = new Date().toISOString();
    this.data.rosterSections.forEach((section) => {
      if (section.rosterHidden) {
        section.rosterHidden = false;
        section.updatedAt = now;
      }
    });
    this.data.accounts.forEach((account) => {
      if (account.rosterHidden) {
        account.rosterHidden = false;
        account.updatedAt = now;
      }
    });
    this._persist();
  }

  changeMasterPassword(newPassword) {
    const keyStorageMode = this.getKeyStorageMode();
    this.salt = crypto.randomBytes(16);
    this.key = this._deriveKey(newPassword, this.salt);
    this._persist();
    if (keyStorageMode !== 'disabled') {
      try { this.parkKey(); }
      catch {
        this.data.capabilities.osKeyMode = 'disabled';
        this.forgetParkedKey();
        this._persist();
      }
    } else {
      this.forgetParkedKey();
    }
    return true;
  }
}

module.exports = { Vault };
