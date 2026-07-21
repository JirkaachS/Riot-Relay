'use strict';

/**
 * deceive.js — Built-in "appear offline" proxy, a Node re-implementation of
 * Deceive (github.com/molenzwiebel/Deceive, MIT).
 *
 * How it works (same approach as Deceive):
 *   1. A local HTTP "config proxy" intercepts the Riot Client's client-config
 *      request. We launch the client with --client-config-url pointing here.
 *   2. We forward the request to Riot's real clientconfig, then rewrite the
 *      response so chat.host/chat.port (and every affinity) point at our local
 *      XMPP proxy, and set chat.allow_bad_cert so the client accepts our cert.
 *   3. A local TLS "chat proxy" then sits between the client and Riot's real
 *      chat server, rewriting outgoing <presence> stanzas to force your status
 *      to offline / mobile / online. Game traffic is untouched.
 *
 * Everything is best-effort and self-contained: if anything here fails, the
 * caller still launches the game normally — Deceive never blocks a switch.
 */

const tls = require('tls');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const CONFIG_URL = 'https://clientconfig.rpg.riotgames.com';
const GEO_PAS_URL = 'https://riot-geo.pas.si.riotgames.com/pas/v1/service/chat';
// Advertise the hostname covered by Deceive's certificate, while binding both
// listeners only to loopback. Proxy-to-Riot TLS remains strictly verified.
const LOCAL_CHAT_HOST = 'deceive-localhost.molenzwiebel.xyz';
const LOOPBACK_HOST = '127.0.0.1';
const CERT_URL = 'https://mln.cx/deceive/localhost.pfx';

// Map friendly status -> XMPP <show> value.
const STATUS_SHOW = { chat: 'chat', online: 'chat', offline: 'offline', mobile: 'mobile', away: 'away' };
const ACTIVITY_MODES = new Set(['preserve', 'hide', 'generic']);
const normalizeActivityMode = (value) => ACTIVITY_MODES.has(String(value || '').toLowerCase()) ? String(value).toLowerCase() : 'hide';
const normalizeCustomStatus = (value) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 96);
const normalizeLaunchProduct = (value) => {
  const product = String(value || '').trim().toLowerCase();
  if (['league', 'lol', 'tft', 'league_of_legends', 'league-client'].includes(product)) return 'league';
  if (product === 'valorant') return 'valorant';
  return 'unknown';
};
const xmlEscape = (value) => String(value || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// A synthetic League-only helper contact. VALORANT validates social identities
// against Riot's backend, so injecting this contact there would produce a blank
// "Player" profile that cannot reliably receive messages.
const FAKE_PUUID = '41c322a1-b328-495b-a004-5ccd3e45eae8';
const HELPER_NAME = 'Deceive Active!';
const LEAGUE_HELPER_ICON = 29;

const NETWORK_TIMEOUT_MS = 10000;
const EARLY_CHAT_TIMEOUT_MS = 5000;
const MAX_PENDING_CHATS = 4;
const MAX_HTTP_BYTES = 5 * 1024 * 1024;
const MAX_XML_BUFFER = 1024 * 1024;

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const req = https.get(url, { headers: { 'User-Agent': 'Riot Relay' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_HTTP_BYTES) {
          req.destroy(new Error('Response exceeded the Riot Relay safety limit.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(null, Buffer.concat(chunks)));
      res.on('error', (error) => finish(error));
    });
    req.on('error', (error) => finish(error));
    req.setTimeout(NETWORK_TIMEOUT_MS, () => req.destroy(new Error('Request timed out.')));
  });
}

/** Fetch Deceive's trusted localhost PFX (cached), falling back to cache on error. */
async function getPfx(dir) {
  const file = path.join(dir, 'deceive-localhost.pfx');
  try {
    const buf = await httpGetBuffer(CERT_URL);
    try { fs.writeFileSync(file, buf); } catch { /* ignore */ }
    return buf;
  } catch (e) {
    if (fs.existsSync(file)) return fs.readFileSync(file);
    throw new Error(`Could not fetch the offline-mode certificate (${e.message}).`);
  }
}

class DeceiveProxy {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.status = 'offline';
    this.enabled = true;
    this.connectToMuc = options.preserveParty !== false;
    this.activityMode = normalizeActivityMode(options.activityMode || (options.hideGameActivity === false ? 'preserve' : 'hide'));
    this.customStatus = normalizeCustomStatus(options.customStatus);
    this.hideGameActivity = this.activityMode !== 'preserve';
    this.leagueHelper = options.leagueHelper !== false;
    Object.defineProperties(this, {
      launchProduct: { value: normalizeLaunchProduct(options.launchProduct), enumerable: true },
      // Retained as a read-only compatibility alias for existing state consumers.
      clientProduct: { value: normalizeLaunchProduct(options.launchProduct), enumerable: true },
    });
    this._chatRoute = null;
    // The product whose config established the chat route. Used to enable the
    // League helper when the proxy was started without a specific product.
    this._latchedProduct = 'unknown';
    Object.defineProperties(this, {
      chatHost: { enumerable: true, get: () => this._chatRoute && this._chatRoute.host },
      chatPort: { enumerable: true, get: () => this._chatRoute ? this._chatRoute.port : 0 },
    });
    this.chatProxyPort = 0;
    this.configPort = 0;
    this._servers = [];
    this._connections = new Set();
    this._pendingChats = new Map();
    this._running = false;
    this.lastError = null;
  }

  _fakeJid(chatHost = this.chatHost) {
    const affinity = (String(chatHost || '').match(/(?:^|\.)([a-z]{2,4}\d)(?:\.|$)/i) || [])[1] || 'eu1';
    return `${FAKE_PUUID}@${affinity.toLowerCase()}.pvp.net`;
  }

  _fakeRosterItem(conn) {
    const jid = conn.fakeJid;
    return `<item jid='${jid}' name='${HELPER_NAME}' subscription='both' puuid='${FAKE_PUUID}'>`
      + `<group priority='9999'>${HELPER_NAME}</group><state>online</state>`
      + `<id name='${HELPER_NAME}' tagline='HELP'/><lol name='${HELPER_NAME}'/>`
      + `<platforms><riot name='${HELPER_NAME}' tagline='HELP'/></platforms></item>`;
  }

  _createConnection(incoming, outgoing) {
    const conn = {
      incoming,
      outgoing,
      insertedFake: false,
      rosterSeen: false,
      lastPresence: null,
      clientBuffer: '',
      serverBuffer: '',
      clientDecoder: new StringDecoder('utf8'),
      serverDecoder: new StringDecoder('utf8'),
    };
    Object.defineProperties(conn, {
      product: { value: this.launchProduct, enumerable: true },
      fakeJid: { value: this._fakeJid(this.chatHost), enumerable: true },
    });
    return conn;
  }

  _canUseHelper(conn) {
    if (!conn || !this.leagueHelper) return false;
    // The connection's own product wins when known. For a proxy started without
    // a specific product (a plain account switch), fall back to the product
    // whose config latched the chat route. VALORANT never qualifies.
    const product = conn.product !== 'unknown' ? conn.product : this._latchedProduct;
    return product === 'league';
  }

  setOptions(options = {}) {
    if (typeof options.preserveParty === 'boolean') this.connectToMuc = options.preserveParty;
    if (options.activityMode != null) this.activityMode = normalizeActivityMode(options.activityMode);
    else if (typeof options.hideGameActivity === 'boolean') this.activityMode = options.hideGameActivity ? 'hide' : 'preserve';
    if (options.customStatus != null) this.customStatus = normalizeCustomStatus(options.customStatus);
    this.hideGameActivity = this.activityMode !== 'preserve';
    if (typeof options.leagueHelper === 'boolean') this.leagueHelper = options.leagueHelper;
    let rewritten = 0;
    for (const conn of this._connections) {
      try { if (this._resendPresence(conn)) rewritten += 1; }
      catch (error) { this.lastError = error.message; }
    }
    return { applied: rewritten > 0, ...this.getState() };
  }

  _resendPresence(conn) {
    if (!conn.lastPresence || !conn.outgoing || conn.outgoing.destroyed) return false;
    conn.outgoing.write(Buffer.from(this.enabled ? this._rewritePresence(conn.lastPresence) : conn.lastPresence, 'utf8'));
    return true;
  }

  setEnabled(enabled) {
    this.enabled = enabled === true;
    let applied = 0;
    for (const conn of this._connections) {
      try { if (this._resendPresence(conn)) applied += 1; }
      catch (error) { this.lastError = error.message; }
    }
    return { enabled: this.enabled, applied: applied > 0, ...this.getState() };
  }

  setStatus(status) {
    this.status = STATUS_SHOW[status] ? status : 'offline';
    let applied = 0;
    let notifiedChats = 0;
    for (const conn of this._connections) {
      if (!conn.incoming || conn.incoming.destroyed) continue;
      try {
        if (this._resendPresence(conn)) applied += 1;
        if (conn.insertedFake && this._canUseHelper(conn)) {
          this._writeFakePresence(conn);
          this._writeFakeMessage(
            conn,
            applied ? `Your presence is now set to ${this._word()}.` : `Status saved as ${this._word()}; it will apply with your next Riot presence update.`,
          );
          notifiedChats += 1;
        }
      } catch (error) { this.lastError = error.message; }
    }
    return { status: this.status, applied: applied > 0, notifiedChats };
  }

  _visibleStatus() {
    if (this.enabled) return this._word();
    for (const conn of this._connections) {
      const show = (conn.lastPresence && conn.lastPresence.match(/<show>([^<]+)<\/show>/i) || [])[1];
      if (show) return show.toLowerCase() === 'chat' ? 'online' : show.toLowerCase();
    }
    return 'Riot-controlled';
  }

  getState() {
    const connectionProducts = { league: 0, valorant: 0, unknown: 0 };
    let helperConnections = 0;
    for (const conn of this._connections) {
      const product = ['league', 'valorant'].includes(conn.product) ? conn.product : 'unknown';
      connectionProducts[product] += 1;
      if (conn.insertedFake && this._canUseHelper(conn)) helperConnections += 1;
    }
    return {
      running: this._running,
      chatConnected: [...this._connections].some((conn) => conn.rosterSeen),
      status: this.status,
      enabled: this.enabled,
      activeConnections: this._connections.size,
      connectionProducts,
      helperConnections,
      lastError: this.lastError,
      fakeFriend: HELPER_NAME,
      helperAvailable: helperConnections > 0,
      launchProduct: this.launchProduct,
      clientProduct: this.launchProduct,
      preserveParty: this.connectToMuc,
      activityMode: this.activityMode,
      customStatus: this.customStatus,
      hideGameActivity: this.hideGameActivity,
      leagueHelper: this.leagueHelper,
    };
  }

  _listen(server, port) {
    return new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen(port, LOOPBACK_HOST, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
  }

  async start(status = 'offline', options = {}) {
    this.setStatus(status);
    // When restoring a session after a Riot Relay restart, pre-latch the known
    // upstream route so early chat sockets forward immediately, and rebind the
    // same local chat port the already-running game is trying to reach.
    const restoreRoute = options.restoreRoute;
    const restorePort = Number(options.restorePort);
    if (restoreRoute && this._validRoute(restoreRoute.host, restoreRoute.port)) {
      this._chatRoute = Object.freeze({ host: String(restoreRoute.host).trim(), port: restoreRoute.port });
    }
    try {
      const pfx = await getPfx(this.dir);

      const chatServer = tls.createServer(
        { pfx },
        (incoming) => this._handleChat(incoming),
      );
      this._servers.push(chatServer);
      const desiredChatPort = Number.isInteger(restorePort) && restorePort > 0 && restorePort <= 65535 ? restorePort : 0;
      try {
        await this._listen(chatServer, desiredChatPort);
      } catch (error) {
        // The old port may be taken; fall back to an ephemeral one. Reconnection
        // of an already-running game will not succeed, but a fresh launch will.
        if (desiredChatPort === 0) throw error;
        this.lastError = 'The previous offline chat port was unavailable; a new one was used.';
        await this._listen(chatServer, 0);
      }
      chatServer.on('error', (error) => { this.lastError = error.message; });
      this.chatProxyPort = chatServer.address().port;
      if (this._chatRoute) this._persistSession();

      const configServer = http.createServer((req, res) => this._handleConfig(req, res));
      this._servers.push(configServer);
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        configServer.once('error', onError);
        configServer.listen(0, LOOPBACK_HOST, () => {
          configServer.removeListener('error', onError);
          resolve();
        });
      });
      configServer.on('error', (error) => { this.lastError = error.message; });
      this.configPort = configServer.address().port;

      this._running = true;
      this.lastError = null;
      return { configPort: this.configPort, configUrl: `http://127.0.0.1:${this.configPort}` };
    } catch (error) {
      this.lastError = error.message;
      this.stop();
      throw error;
    }
  }

  stop() {
    for (const pending of this._pendingChats.values()) {
      clearTimeout(pending.timer);
      pending.incoming.removeListener('close', pending.cleanup);
      pending.incoming.removeListener('error', pending.cleanup);
      try { pending.incoming.destroy(); } catch { /* ignore */ }
    }
    this._pendingChats.clear();
    for (const conn of this._connections) {
      try { conn.incoming.destroy(); } catch { /* ignore */ }
      try { conn.outgoing.destroy(); } catch { /* ignore */ }
    }
    this._connections.clear();
    for (const s of this._servers) { try { s.close(); } catch { /* ignore */ } }
    this._servers = [];
    this._chatRoute = null;
    this._running = false;
  }

  isRunning() { return this._running; }

  // ---- Config proxy --------------------------------------------------------

  _configProduct(url) {
    const value = String(url || '').toLowerCase();
    if (/(?:^|[\/_-])valorant(?:[\/_-]|$)/.test(value)) return 'valorant';
    if (/(?:league_of_legends|league-client|league_client|(?:^|[\/_-])league(?:[\/_-]|$)|(?:^|[\/_-])lol(?:[\/_-]|$)|(?:^|[\/_-])tft(?:[\/_-]|$))/.test(value)) return 'league';
    return 'unknown';
  }

  _isCompatibleConfig(product) {
    return this.launchProduct === 'unknown' || product === this.launchProduct;
  }

  _validRoute(host, port) {
    if (typeof host !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535) return false;
    const value = host.trim();
    return value.length > 0 && value.length <= 253
      && /^[a-z0-9.-]+$/i.test(value)
      && !value.startsWith('.') && !value.endsWith('.') && !value.includes('..');
  }

  _sessionFile() { return path.join(this.dir, 'deceive-session.json'); }

  static readPersistedSession(dir) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, 'deceive-session.json'), 'utf8'));
      if (!value || typeof value !== 'object') return null;
      const port = Number(value.chatProxyPort);
      const host = value.route && typeof value.route.host === 'string' ? value.route.host.trim() : '';
      const routePort = value.route ? Number(value.route.port) : 0;
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
      if (!host || !Number.isInteger(routePort) || routePort <= 0 || routePort > 65535) return null;
      return { chatProxyPort: port, route: { host, port: routePort }, launchProduct: normalizeLaunchProduct(value.launchProduct) };
    } catch { return null; }
  }

  static clearPersistedSession(dir) {
    try { fs.rmSync(path.join(dir, 'deceive-session.json'), { force: true }); } catch { /* ignore */ }
  }

  _persistSession() {
    if (!this._chatRoute || !this.chatProxyPort) return;
    try {
      const effectiveProduct = this.launchProduct !== 'unknown' ? this.launchProduct : this._latchedProduct;
      fs.writeFileSync(this._sessionFile(), JSON.stringify({
        chatProxyPort: this.chatProxyPort,
        route: { host: this._chatRoute.host, port: this._chatRoute.port },
        launchProduct: normalizeLaunchProduct(effectiveProduct),
        savedAt: new Date().toISOString(),
      }));
    } catch { /* best effort */ }
  }

  _latchRoute(host, port, product = 'unknown') {
    if (this._chatRoute || !this._validRoute(host, port)) return false;
    const observedProduct = normalizeLaunchProduct(product);
    if (this.launchProduct === 'unknown' && observedProduct !== 'unknown') this._latchedProduct = observedProduct;
    this._chatRoute = Object.freeze({ host: host.trim(), port });
    this._persistSession();
    const pending = [...this._pendingChats.values()];
    this._pendingChats.clear();
    for (const item of pending) {
      clearTimeout(item.timer);
      item.incoming.removeListener('close', item.cleanup);
      item.incoming.removeListener('error', item.cleanup);
      if (!item.incoming.destroyed) this._connectChat(item.incoming, this._chatRoute);
    }
    return true;
  }

  _handleConfig(req, res) {
    const target = CONFIG_URL + req.url;
    const requestProduct = this._configProduct(req.url);
    const compatible = this._isCompatibleConfig(requestProduct);
    const headers = {};
    if (req.headers['user-agent']) headers['User-Agent'] = req.headers['user-agent'];
    if (req.headers['x-riot-entitlements-jwt']) headers['X-Riot-Entitlements-JWT'] = req.headers['x-riot-entitlements-jwt'];
    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];

    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      if (error) this.lastError = error.message;
      const body = Buffer.from('Bad Gateway', 'utf8');
      try {
        res.writeHead(502, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': body.length,
          Connection: 'close',
        });
        res.end(body);
      } catch { /* ignore */ }
    };
    const up = https.get(target, { headers }, (upRes) => {
      const statusCode = Number.isInteger(upRes.statusCode) ? upRes.statusCode : 0;
      const chunks = [];
      let size = 0;
      upRes.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_HTTP_BYTES) {
          up.destroy(new Error('Config response exceeded the Riot Relay safety limit.'));
          fail(new Error('Config response exceeded the Riot Relay safety limit.'));
          return;
        }
        chunks.push(chunk);
      });
      upRes.on('end', async () => {
        if (failed) return;
        const upstreamBody = Buffer.concat(chunks);
        if (statusCode < 200 || statusCode >= 300) {
          // Riot occasionally answers a config request with a transient
          // non-success status (sometimes with a non-JSON body). Forwarding
          // it unchanged lets the Riot Client apply its own retry behavior,
          // exactly like upstream Deceive. Replacing it with a synthetic 502
          // stalls the client instead of letting it recover on its own.
          if (failed) return;
          failed = true;
          try {
            const responseHeaders = { 'Content-Length': upstreamBody.length };
            const contentType = upRes.headers && upRes.headers['content-type'];
            if (contentType) responseHeaders['Content-Type'] = contentType;
            res.writeHead(statusCode || 502, responseHeaders);
            res.end(upstreamBody);
          } catch { /* ignore */ }
          return;
        }
        try {
          const cfg = JSON.parse(upstreamBody.toString('utf8'));
          if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('Client config was not a JSON object.');

          const routingFields = ['chat.host', 'chat.port', 'chat.affinities', 'chat.affinity.enabled'];
          const hasRoutingFields = routingFields.some((field) => Object.prototype.hasOwnProperty.call(cfg, field));
          let body = upstreamBody;

          if (hasRoutingFields) {
            let routeHost = cfg['chat.host'];
            const routePort = cfg['chat.port'];
            const affinities = cfg['chat.affinities'];
            if (affinities != null && (typeof affinities !== 'object' || Array.isArray(affinities))) {
              throw new Error('Client config contained invalid chat affinities.');
            }
            if (cfg['chat.affinity.enabled'] && req.headers['authorization'] && affinities) {
              try {
                const affinity = await this._affinity(req.headers['authorization']);
                if (Object.prototype.hasOwnProperty.call(affinities, affinity)) routeHost = affinities[affinity];
              } catch { /* The complete fallback route remains authoritative. */ }
            }

            if (!this._validRoute(routeHost, routePort)) {
              throw new Error('Client config did not contain a complete valid chat route.');
            }
            if (compatible) {
              // Latch the observed product before persistence so a Riot Relay
              // restart can restore League helper eligibility without waiting
              // for another client-config request. VALORANT remains excluded.
              this._latchRoute(routeHost, routePort, requestProduct);
              cfg['chat.host'] = LOCAL_CHAT_HOST;
              cfg['chat.port'] = this.chatProxyPort;
              if (affinities) {
                for (const key of Object.keys(affinities)) affinities[key] = LOCAL_CHAT_HOST;
              }
              cfg['chat.allow_bad_cert'] = true;
              body = Buffer.from(JSON.stringify(cfg), 'utf8');
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
          res.end(body);
        } catch (error) { fail(error); }
      });
      upRes.on('error', fail);
    });
    up.on('error', fail);
    up.setTimeout(NETWORK_TIMEOUT_MS, () => up.destroy(new Error('Config request timed out.')));
  }

  _affinity(auth) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve(value);
      };
      const req = https.get(GEO_PAS_URL, { headers: { Authorization: auth } }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          finish(new Error(`Affinity request returned HTTP ${res.statusCode}.`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 64 * 1024) {
            req.destroy(new Error('Affinity response exceeded the Riot Relay safety limit.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const jwt = Buffer.concat(chunks).toString('utf8').split('.')[1];
            const json = JSON.parse(Buffer.from(jwt.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
            finish(null, json.affinity);
          } catch (error) { finish(error); }
        });
        res.on('error', (error) => finish(error));
      });
      req.on('error', (error) => finish(error));
      req.setTimeout(NETWORK_TIMEOUT_MS, () => req.destroy(new Error('Affinity request timed out.')));
    });
  }

  // ---- Chat (XMPP over TLS) proxy -----------------------------------------

  _handleChat(incoming) {
    if (this._chatRoute) {
      this._connectChat(incoming, this._chatRoute);
      return;
    }
    if (this._pendingChats.size >= MAX_PENDING_CHATS) {
      this.lastError = 'Too many Riot chat connections arrived before routing was ready.';
      incoming.destroy();
      return;
    }

    const cleanup = () => {
      const pending = this._pendingChats.get(incoming);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pendingChats.delete(incoming);
    };
    const timer = setTimeout(() => {
      cleanup();
      this.lastError = 'Riot chat routing was not ready in time.';
      try { incoming.destroy(); } catch { /* ignore */ }
    }, EARLY_CHAT_TIMEOUT_MS);
    this._pendingChats.set(incoming, { incoming, timer, cleanup });
    incoming.once('close', cleanup);
    incoming.once('error', cleanup);
  }

  _connectChat(incoming, route) {
    let outgoing;
    try {
      outgoing = tls.connect({
        host: route.host,
        port: route.port,
        servername: route.host,
        rejectUnauthorized: true,
      });
    } catch (error) {
      this.lastError = error.message;
      incoming.destroy();
      return;
    }
    const conn = this._createConnection(incoming, outgoing);
    this._connections.add(conn);
    let closed = false;
    const connectTimer = setTimeout(() => {
      this.lastError = 'Riot chat TLS connection timed out.';
      done();
    }, NETWORK_TIMEOUT_MS);
    const done = (error) => {
      if (closed) return;
      closed = true;
      clearTimeout(connectTimer);
      if (error) this.lastError = error.message;
      this._connections.delete(conn);
      try { incoming.destroy(); } catch { /* ignore */ }
      try { outgoing.destroy(); } catch { /* ignore */ }
    };
    outgoing.once('secureConnect', () => clearTimeout(connectTimer));

    // Targeted framing keeps incomplete presence/command stanzas buffered across
    // TCP chunks. Other XMPP data is forwarded immediately.
    incoming.on('data', (buf) => this._processClientData(conn, buf, done));
    outgoing.on('data', (buf) => this._processServerData(conn, buf, done));

    incoming.on('error', done); outgoing.on('error', done);
    incoming.on('close', () => done()); outgoing.on('close', () => done());
  }

  _partialMarkerLength(value, markers) {
    const lower = value.toLowerCase();
    let keep = 0;
    for (const marker of markers) {
      const max = Math.min(marker.length - 1, lower.length);
      for (let size = max; size > keep; size -= 1) {
        if (marker.startsWith(lower.slice(-size))) { keep = size; break; }
      }
    }
    return keep;
  }

  _processClientData(conn, buf, done) {
    conn.clientBuffer += conn.clientDecoder.write(buf);
    if (Buffer.byteLength(conn.clientBuffer, 'utf8') > MAX_XML_BUFFER) {
      done(new Error('Riot chat sent an oversized incomplete XML stanza.'));
      return;
    }

    let source = conn.clientBuffer;
    let output = '';
    while (source) {
      const candidate = /<(presence|message)\b/i.exec(source);
      if (!candidate) {
        const keep = this._partialMarkerLength(source, ['<presence', '<message']);
        output += source.slice(0, source.length - keep);
        source = source.slice(source.length - keep);
        break;
      }
      if (candidate.index > 0) {
        output += source.slice(0, candidate.index);
        source = source.slice(candidate.index);
      }

      const kind = candidate[1].toLowerCase();
      const openEnd = source.indexOf('>');
      if (openEnd < 0) break;
      const opening = source.slice(0, openEnd + 1);
      let stanzaEnd = openEnd + 1;
      if (!/\/\s*>$/.test(opening)) {
        const closing = `</${kind}>`;
        const closingAt = source.toLowerCase().indexOf(closing, openEnd + 1);
        if (closingAt < 0) break;
        stanzaEnd = closingAt + closing.length;
      }
      const stanza = source.slice(0, stanzaEnd);
      source = source.slice(stanzaEnd);

      if (kind === 'presence') {
        if (!/\bto\s*=/.test(opening)) conn.lastPresence = stanza;
        output += this.enabled ? this._rewritePresence(stanza) : stanza;
        continue;
      }

      const escapedJid = conn.fakeJid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const isHelperCommand = new RegExp(`\\bto\\s*=\\s*(['"])${escapedJid}(?:\\/[^'"]*)?\\1`, 'i').test(opening);
      if (isHelperCommand && conn.product === 'league') {
        // The JID is synthetic and must never be disclosed to or forwarded to
        // Riot, including while the helper is disabled on a live connection.
        if (conn.insertedFake && this._canUseHelper(conn)) this._handleCommand(stanza, conn);
      } else output += stanza;
    }

    conn.clientBuffer = source;
    if (output) {
      try { conn.outgoing.write(Buffer.from(output, 'utf8')); } catch (error) { done(error); }
    }
  }

  _processServerData(conn, buf, done) {
    const decoded = conn.serverDecoder.write(buf);
    if (conn.insertedFake && this._canUseHelper(conn)) {
      try { if (decoded) conn.incoming.write(Buffer.from(decoded, 'utf8')); } catch (error) { done(error); }
      return;
    }
    conn.serverBuffer += decoded;
    if (Buffer.byteLength(conn.serverBuffer, 'utf8') > MAX_XML_BUFFER) {
      done(new Error('Riot chat sent an oversized incomplete roster response.'));
      return;
    }

    const roster = /<query\b[^>]*\bxmlns\s*=\s*(['"])jabber:iq:riotgames:roster\1[^>]*>/i;
    const match = roster.exec(conn.serverBuffer);
    if (match) {
      conn.rosterSeen = true;
      if (!this._canUseHelper(conn)) {
        const output = conn.serverBuffer;
        conn.serverBuffer = '';
        try { conn.incoming.write(Buffer.from(output, 'utf8')); } catch (error) { done(error); }
        return;
      }
      conn.insertedFake = true;
      const end = match.index + match[0].length;
      const output = conn.serverBuffer.slice(0, end) + this._fakeRosterItem(conn) + conn.serverBuffer.slice(end);
      conn.serverBuffer = '';
      try { conn.incoming.write(Buffer.from(output, 'utf8')); } catch (error) { done(error); return; }
      this._scheduleHelperNotifications(conn);
      return;
    }

    const lower = conn.serverBuffer.toLowerCase();
    const queryAt = lower.lastIndexOf('<query');
    let keep = this._partialMarkerLength(conn.serverBuffer, ['<query']);
    if (queryAt >= 0 && lower.indexOf('>', queryAt) < 0) keep = conn.serverBuffer.length - queryAt;
    const flushLength = conn.serverBuffer.length - keep;
    if (flushLength > 0) {
      try { conn.incoming.write(Buffer.from(conn.serverBuffer.slice(0, flushLength), 'utf8')); }
      catch (error) { done(error); return; }
      conn.serverBuffer = conn.serverBuffer.slice(flushLength);
    }
  }

  _scheduleHelperNotifications(conn) {
    if (!this._canUseHelper(conn)) return;
    setTimeout(() => this._writeFakePresence(conn), 400);
    setTimeout(() => this._writeFakeMessage(conn, `${HELPER_NAME} is active — you are appearing ${this._visibleStatus()} to your friends.`), 2500);
    setTimeout(() => this._writeFakeMessage(conn, 'Commands: online, offline, mobile, away, enable, disable, status, help.'), 3200);
  }

  _word() { return this.status === 'chat' ? 'online' : this.status; }

  _writeFakePresence(conn) {
    if (!this._canUseHelper(conn)) return false;
    const now = Date.now();
    const p = `<presence from='${conn.fakeJid}/RC-RiotRelay' id='rr-${now}'>`
      + `<games><league_of_legends><st>chat</st><s.t>${now}</s.t><s.p>league_of_legends</s.p><p>${LEAGUE_HELPER_ICON}</p></league_of_legends></games>`
      + '<show>chat</show><platform>riot</platform><status>Presence controls</status></presence>';
    try { conn.incoming.write(Buffer.from(p, 'utf8')); return true; } catch { return false; }
  }

  _writeFakeMessage(conn, message) {
    if (!this._canUseHelper(conn)) return false;
    const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
    const m = `<message from='${conn.fakeJid}/RC-RiotRelay' stamp='${stamp}' id='rr-${Date.now()}' type='chat'><body>${xmlEscape(message)}</body></message>`;
    try { conn.incoming.write(Buffer.from(m, 'utf8')); return true; } catch { return false; }
  }

  /** Handle an exact chat command typed to the League helper contact. */
  _handleCommand(content, conn) {
    if (!this._canUseHelper(conn) || !conn.insertedFake) return false;
    const body = (content.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i) || [])[1] || '';
    const command = body.trim().toLowerCase();
    const statuses = { online: 'chat', offline: 'offline', mobile: 'mobile', away: 'away' };
    if (Object.prototype.hasOwnProperty.call(statuses, command)) {
      this.enabled = true;
      this.setStatus(statuses[command]);
      return true;
    }
    if (command === 'enable') {
      const changed = !this.enabled;
      this.setEnabled(true);
      this._writeFakeMessage(conn, changed ? 'Deceive is now enabled.' : 'Deceive is already enabled.');
      return true;
    }
    if (command === 'disable') {
      const changed = this.enabled;
      this.setEnabled(false);
      this._writeFakeMessage(conn, changed ? 'Deceive is now disabled.' : 'Deceive is already disabled.');
      return true;
    }
    if (command === 'status') {
      this._writeFakeMessage(conn, `Visible status: ${this._visibleStatus()}. Deceive is ${this.enabled ? 'enabled' : 'disabled'}.`);
      return true;
    }
    const help = 'Commands: online, offline, mobile, away, enable, disable, status, help.';
    this._writeFakeMessage(conn, command === 'help' ? help : `Unknown command. ${help}`);
    return true;
  }

  /**
   * Rewrite every <presence> stanza in a chunk so the reported status matches
   * the chosen appearance, stripping rich game presence when hidden. Ported
   * from Deceive's ProxiedConnection.PossiblyRewriteAndResendPresence.
   */
  _rewritePresence(content) {
    const show = STATUS_SHOW[this.status] || 'offline';
    const rewriteOne = (p) => {
      // Directed presence (to=...) is lobby/MUC — leave it alone so party chat works.
      if (/\bto\s*=/.test(p) && this.connectToMuc) return p;
      if (/\bto\s*=/.test(p)) return '';
      let out = p;
      if (/\/\s*>$/.test(out)) {
        out = out.replace(/\/\s*>$/, `><show>${show}</show></presence>`);
      } else if (/<show>[\s\S]*?<\/show>/.test(out)) {
        out = out.replace(/<show>[\s\S]*?<\/show>/, `<show>${show}</show>`);
      } else {
        out = out.replace(/(<presence\b[^>]*>)/, `$1<show>${show}</show>`);
      }
      if (show !== 'chat' || this.activityMode !== 'preserve') {
        out = out.replace(/<status>[\s\S]*?<\/status>/g, '');
        out = out.replace(/<games>[\s\S]*?<\/games>/g, '');
      }
      if (show === 'chat' && this.activityMode === 'generic' && this.customStatus) {
        out = out.replace(/<\/presence>$/, `<status>${xmlEscape(this.customStatus)}</status></presence>`);
      }
      return out;
    };
    // Match both full and self-closing presence stanzas.
    return content.replace(/<presence\b[\s\S]*?<\/presence>|<presence\b[^>]*\/>/g, rewriteOne);
  }
}

module.exports = { DeceiveProxy };
