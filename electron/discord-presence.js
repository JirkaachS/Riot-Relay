'use strict';

const net = require('net');
const crypto = require('crypto');

const PIPE_COUNT = 10;
const MAX_FRAME = 1024 * 1024;
const RETRY_MS = 5000;

function cleanText(value, max = 128) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanClientId(value) {
  const id = String(value || '').trim();
  return /^\d{17,20}$/.test(id) ? id : '';
}

function cleanAssetKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(key) ? key : '';
}

function frame(opcode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function pipeName(index) {
  return process.platform === 'win32'
    ? `\\\\?\\pipe\\discord-ipc-${index}`
    : `${process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp'}/discord-ipc-${index}`;
}
function normalizeOptions(value = {}) {
  return {
    enabled: value.enabled === true,
    clientId: cleanClientId(value.clientId),
    showGame: value.showGame !== false,
    showRank: value.showRank === true,
    showRiotId: value.showRiotId === true && value.hideDisplayNames !== true,
    showStatus: value.showStatus === true,
    showElapsed: value.showElapsed !== false,
    showLiveMatch: value.showLiveMatch === true,
    showMatchMode: value.showMatchMode === true,
    showMatchMap: value.showMatchMap === true,
    showMatchPhase: value.showMatchPhase === true,
    showMatchScore: value.showMatchScore === true,
    showMatchElapsed: value.showMatchElapsed === true,
    customDetails: cleanText(value.customDetails),
    customState: cleanText(value.customState),
    largeImage: cleanAssetKey(value.largeImage),
  };
}

function safeLiveContext(value) {
  if (!value || typeof value !== 'object') return null;
  const rawScore = String(value.score || '');
  const score = /^(?:\d{1,3}–\d{1,3}|K\/D\/A \d{1,3}\/\d{1,3}\/\d{1,3})$/.test(rawScore) ? rawScore : '';
  const startedAt = Number(value.matchStartedAt);
  const now = Date.now();
  return {
    mode: cleanText(value.mode, 48), map: cleanText(value.map, 48), phase: cleanText(value.phase, 32), score,
    matchStartedAt: Number.isFinite(startedAt) && startedAt >= now - 86400000 && startedAt <= now + 60000 ? Math.floor(startedAt) : null,
  };
}

function buildActivity(options, context, startedAt) {
  const safe = context && typeof context === 'object' ? context : {};
  const live = options.showLiveMatch ? safeLiveContext(safe.live) : null;
  const detailsParts = [];
  const stateParts = [];
  if (options.customDetails) detailsParts.push(options.customDetails);
  else {
    if (options.showGame && cleanText(safe.game, 64)) detailsParts.push(cleanText(safe.game, 64));
    else detailsParts.push('Riot Relay');
    if (live && options.showMatchMode && live.mode) detailsParts.push(live.mode);
  }
  if (options.customState) stateParts.push(options.customState);
  else {
    if (live && options.showMatchMap && live.map) stateParts.push(live.map);
    if (live && options.showMatchPhase && live.phase) stateParts.push(live.phase);
    if (live && options.showMatchScore && live.score) stateParts.push(live.score);
    if (options.showRank && cleanText(safe.rank, 64)) stateParts.push(cleanText(safe.rank, 64));
    if (options.showStatus && cleanText(safe.status, 32)) stateParts.push(cleanText(safe.status, 32));
    if (options.showRiotId && cleanText(safe.riotId, 64)) stateParts.push(cleanText(safe.riotId, 64));
  }
  const activity = {
    details: cleanText(detailsParts.join(' · ')) || 'Riot Relay',
    state: cleanText(stateParts.join(' · ')) || undefined,
    instance: false,
  };
  if (live && options.showMatchElapsed && live.matchStartedAt) activity.timestamps = { start: live.matchStartedAt };
  else if (options.showElapsed && startedAt) activity.timestamps = { start: startedAt };
  if (options.largeImage) {
    activity.assets = { large_image: options.largeImage, large_text: 'Riot Relay' };
  }
  return activity;
}

function discordErrorMessage(payload) {
  const data = payload && payload.data;
  const message = cleanText(data && data.message, 160);
  const code = cleanText(data && data.code, 24);
  return message || (code ? `Discord rejected the activity (${code}).` : 'Discord rejected the activity.');
}

class DiscordPresenceService {
  constructor({ onState = null } = {}) {
    this.options = normalizeOptions();
    this.context = null;
    this.available = false;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.ready = false;
    this.connecting = false;
    this.published = false;
    this.pipeIndex = null;
    this.handshakeAt = null;
    this.lastPublishAt = null;
    this.lastPublishRequestedAt = null;
    this.pendingPublish = null;
    this.reconnectCount = 0;
    this.closeReason = null;
    this.testPending = false;
    this.retryTimer = null;
    this.startedAt = Date.now();
    this.lastError = null;
    this.onState = typeof onState === 'function' ? onState : null;
    this.disposed = false;
  }

  configure(options) {
    const previousId = this.options.clientId;
    const previousEnabled = this.options.enabled;
    this.options = normalizeOptions(options);
    if (!this.options.enabled || !this.options.clientId || !this.available) {
      this._disconnect(true, this.options.enabled ? 'Discord activity is unavailable.' : 'Discord activity disabled.');
    } else if (!previousEnabled || previousId !== this.options.clientId) {
      this._disconnect(true, 'Discord application changed.');
      this._connect();
    } else if (this.ready) this._publish();
    else this._connect();
    this._emit();
    return this.getState();
  }

  setAvailable(value) {
    this.available = value === true;
    if (!this.available) this._disconnect(true, 'Vault locked.');
    else this._connect();
    this._emit();
  }

  setContext(context) {
    const next = context && typeof context === 'object' ? { ...context } : null;
    if (!this.context || !next || cleanText(this.context.game, 64) !== cleanText(next.game, 64)) this.startedAt = Date.now();
    this.context = next;
    this.testPending = false;
    if (this.ready) this._publish();
    else this._connect();
    this._emit();
  }

  testActivity() {
    if (!this.options.enabled) throw new Error('Enable Discord Rich Presence first.');
    if (!this.options.clientId) throw new Error('A valid Discord Application ID is required.');
    if (!this.available) throw new Error('Unlock the vault before testing Discord activity.');
    this.testPending = true;
    this.published = false;
    this.lastError = null;
    if (this.ready) this._publish({ details: 'Riot Relay', state: 'Discord connection test', instance: false });
    else this._connect();
    this._emit();
    return this.getState();
  }

  getState() {
    let status = 'idle';
    if (!this.options.enabled) status = 'disabled';
    else if (!this.options.clientId) status = 'unconfigured';
    else if (!this.available) status = 'unavailable';
    else if (this.connecting) status = 'connecting';
    else if (!this.socket && /not available|not running/i.test(String(this.lastError || ''))) status = 'not-running';
    else if (!this.ready) status = 'handshake';
    else if (this.lastError) status = 'rejected';
    else if (this.published) status = 'published';
    else status = 'publishing';
    return {
      enabled: this.options.enabled,
      configured: !!this.options.clientId,
      connected: this.ready,
      connecting: this.connecting,
      published: this.published,
      status,
      available: this.available,
      pipe: Number.isInteger(this.pipeIndex) ? this.pipeIndex : null,
      handshakeAt: this.handshakeAt,
      lastPublishAt: this.lastPublishAt,
      lastPublishRequestedAt: this.lastPublishRequestedAt,
      reconnectCount: this.reconnectCount,
      closeReason: this.closeReason,
      lastError: this.lastError,
      preview: buildActivity(this.options, this.context, this.startedAt),
    };
  }

  dispose() {
    this.disposed = true;
    this._disconnect(true, 'Discord activity service stopped.');
  }

  _emit() {
    if (this.onState) this.onState(this.getState());
  }

  _canConnect() {
    return !this.disposed && this.available && this.options.enabled && !!this.options.clientId;
  }

  _connect() {
    if (!this._canConnect() || this.socket || this.connecting) return;
    this.connecting = true;
    this.closeReason = null;
    this._tryPipe(0);
    this._emit();
  }

  _tryPipe(index) {
    if (!this._canConnect()) { this.connecting = false; return; }
    if (index >= PIPE_COUNT) {
      this.connecting = false;
      this.pipeIndex = null;
      this.lastError = 'Discord desktop is not running or its local activity pipe is unavailable.';
      this.closeReason = 'No Discord activity pipe was found.';
      this._emit();
      this._scheduleRetry();
      return;
    }
    const socket = net.createConnection(pipeName(index));
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      this._tryPipe(index + 1);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      socket.removeListener('error', fail);
      this.socket = socket;
      this.connecting = false;
      this.buffer = Buffer.alloc(0);
      this.ready = false;
      this.published = false;
      this.pipeIndex = index;
      this.handshakeAt = null;
      this.pendingPublish = null;
      this.lastError = null;
      this.closeReason = null;
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (error) => {
        this.lastError = cleanText(error.message, 160) || 'Discord connection failed.';
        this.closeReason = 'Discord activity pipe error.';
        this._emit();
      });
      socket.on('close', () => this._onClose(socket));
      socket.write(frame(0, { v: 1, client_id: this.options.clientId }));
      this._emit();
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readUInt32LE(0);
      const length = this.buffer.readUInt32LE(4);
      if (length > MAX_FRAME) {
        this.lastError = 'Discord returned an oversized response.';
        this._disconnect(false, 'Oversized Discord response.');
        return;
      }
      if (this.buffer.length < 8 + length) return;
      const body = this.buffer.subarray(8, 8 + length);
      this.buffer = this.buffer.subarray(8 + length);
      let payload = null;
      try { payload = JSON.parse(body.toString('utf8')); } catch { /* ignore malformed frames */ }
      if (opcode === 2) { this._disconnect(false, 'Discord requested reconnect.'); return; }
      if (opcode === 3) {
        try { if (this.socket && !this.socket.destroyed) this.socket.write(frame(4, payload || {})); } catch { /* reconnect on close */ }
        continue;
      }
      if (opcode === 1 && payload && payload.evt === 'READY') {
        this.ready = true;
        this.handshakeAt = new Date().toISOString();
        this.lastError = null;
        if (this.testPending) this._publish({ details: 'Riot Relay', state: 'Discord connection test', instance: false });
        else this._publish();
        this._emit();
        continue;
      }
      const pending = this.pendingPublish;
      if (payload && payload.evt === 'ERROR') {
        const message = discordErrorMessage(payload);
        const invalidAsset = pending && pending.nonce === payload.nonce && pending.activity && pending.activity.assets
          && !pending.retriedWithoutAssets && /asset|image|invalid form body|50035/i.test(message);
        if (invalidAsset) {
          const withoutAssets = { ...pending.activity };
          delete withoutAssets.assets;
          this.lastError = null;
          this._publish(withoutAssets, { retriedWithoutAssets: true });
          continue;
        }
        if (!payload.nonce || !pending || pending.nonce === payload.nonce) {
          this.published = false;
          this.lastError = message;
          this.pendingPublish = null;
          this.testPending = false;
          this._emit();
        }
        continue;
      }
      if (payload && payload.cmd === 'SET_ACTIVITY' && pending && payload.nonce === pending.nonce) {
        const cleared = pending.activity === null;
        this.pendingPublish = null;
        this.published = !cleared;
        this.lastPublishAt = new Date().toISOString();
        this.lastError = null;
        this.testPending = false;
        this._emit();
      }
    }
  }

  _publish(activity, publishOptions = {}) {
    if (!this.socket || !this.ready || this.socket.destroyed) return;
    const nextActivity = arguments.length > 0
      ? activity
      : (this.context ? buildActivity(this.options, this.context, this.startedAt) : null);
    const nonce = crypto.randomUUID();
    const payload = {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: nextActivity },
      nonce,
    };
    this.pendingPublish = {
      nonce,
      activity: nextActivity,
      retriedWithoutAssets: publishOptions.retriedWithoutAssets === true,
    };
    this.published = false;
    this.lastPublishRequestedAt = new Date().toISOString();
    try { this.socket.write(frame(1, payload)); }
    catch (error) {
      this.pendingPublish = null;
      this.lastError = cleanText(error.message, 160) || 'Discord activity could not be updated.';
    }
    this._emit();
  }

  _disconnect(clear, reason = '') {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connecting = false;
    const socket = this.socket;
    if (clear && socket && this.ready && !socket.destroyed) {
      try { this._publish(null); } catch { /* best effort clear */ }
    }
    this.socket = null;
    this.ready = false;
    this.published = false;
    this.pipeIndex = null;
    this.handshakeAt = null;
    this.pendingPublish = null;
    this.testPending = false;
    this.buffer = Buffer.alloc(0);
    if (reason) this.closeReason = cleanText(reason, 120);
    if (socket) {
      socket.removeAllListeners();
      try { socket.end(); } catch { /* ignore */ }
      if (!clear) {
        try { socket.destroy(); } catch { /* ignore */ }
      } else {
        const timer = setTimeout(() => { try { socket.destroy(); } catch { /* ignore */ } }, 250);
        if (typeof timer.unref === 'function') timer.unref();
      }
    }
    this._emit();
  }

  _onClose(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.ready = false;
    this.published = false;
    this.pipeIndex = null;
    this.handshakeAt = null;
    this.pendingPublish = null;
    this.buffer = Buffer.alloc(0);
    this.closeReason = this.closeReason || 'Discord activity pipe closed.';
    this._emit();
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (!this._canConnect() || this.retryTimer) return;
    this.reconnectCount += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this._connect();
    }, RETRY_MS);
    if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
  }
}

module.exports = { DiscordPresenceService, buildActivity, normalizeOptions, cleanText };
