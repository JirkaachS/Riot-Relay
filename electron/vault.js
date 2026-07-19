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
    this.data = { accounts: [] };  // decrypted in-memory model
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
    if (!Array.isArray(data.accounts)) data.accounts = [];
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
    this.data = { accounts: [] };
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

  getAccountSecret(id) {
    const a = this.data.accounts.find((x) => x.id === id);
    return a ? a.password || '' : '';
  }

  upsertAccount(account) {
    const now = new Date().toISOString();
    const idx = this.data.accounts.findIndex((a) => a.id === account.id);
    if (idx >= 0) {
      const prev = this.data.accounts[idx];
      // Keep existing password if the incoming one is blank (edit without retype).
      const password = account.password ? account.password : prev.password;
      // Spread `account` first, then re-pin id/password so an incoming
      // `id: undefined` can never clobber the real identifier.
      this.data.accounts[idx] = { ...prev, ...account, id: prev.id, password, updatedAt: now };
    } else {
      const id = account.id || crypto.randomUUID();
      // Spread `account` first so a stray `id: undefined` from the renderer
      // doesn't overwrite the freshly generated id (which caused every new
      // account to collapse onto the previous one).
      this.data.accounts.push({
        createdAt: now,
        updatedAt: now,
        favorite: false,
        ...account,
        id,
      });
    }
    this._persist();
    return this.listAccounts();
  }

  removeAccount(id) {
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    this._persist();
    return this.listAccounts();
  }

  /** Merge live data (rank, riotId, puuid, level) into an account and save. */
  patchAccount(id, patch) {
    const idx = this.data.accounts.findIndex((a) => a.id === id);
    if (idx < 0) return this.listAccounts();
    this.data.accounts[idx] = { ...this.data.accounts[idx], ...patch, updatedAt: new Date().toISOString() };
    this._persist();
    return this.listAccounts();
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
