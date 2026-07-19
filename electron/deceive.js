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

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const dns = require('dns');

const CONFIG_URL = 'https://clientconfig.rpg.riotgames.com';
const GEO_PAS_URL = 'https://riot-geo.pas.si.riotgames.com/pas/v1/service/chat';
// Deceive's publicly-trusted cert + domain. The domain resolves to 127.0.0.1,
// and the cert is genuinely valid for it, so the Riot Client trusts our local
// chat proxy (a self-signed cert would fail and break chat/voice/friends).
const LOCALHOST_DOMAIN = 'deceive-localhost.molenzwiebel.xyz';
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
const HELPER_NAME = 'Riot Relay';
const LEAGUE_HELPER_ICON = 29;

const NETWORK_TIMEOUT_MS = 10000;
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

/** Verify the localhost domain resolves to 127.0.0.1 (required for the MITM). */
function ensureResolves() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`DNS lookup for ${LOCALHOST_DOMAIN} timed out.`));
    }, NETWORK_TIMEOUT_MS);
    dns.resolve4(LOCALHOST_DOMAIN, (err, addrs) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!err && addrs && addrs.includes('127.0.0.1')) return resolve(true);
      reject(new Error(`${LOCALHOST_DOMAIN} doesn't resolve to 127.0.0.1 on this network. Switch DNS to 1.1.1.1/8.8.8.8 or add a hosts entry.`));
    });
  });
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
    this.chatHost = null;
    this.chatPort = 0;
    this.chatProxyPort = 0;
    this.configPort = 0;
    this._servers = [];
    this._connections = new Set();
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
    return Boolean(conn && conn.product === 'league' && this.leagueHelper);
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
      if (!conn.lastPresence || !conn.outgoing || conn.outgoing.destroyed) continue;
      try { conn.outgoing.write(Buffer.from(this._rewritePresence(conn.lastPresence), 'utf8')); rewritten += 1; }
      catch (error) { this.lastError = error.message; }
    }
    return { applied: rewritten > 0, ...this.getState() };
  }

  setStatus(status) {
    this.status = STATUS_SHOW[status] ? status : 'offline';
    let applied = 0;
    let notifiedChats = 0;
    for (const conn of this._connections) {
      if (!conn.incoming || conn.incoming.destroyed) continue;
      try {
        if (conn.lastPresence && conn.outgoing && !conn.outgoing.destroyed) {
          conn.outgoing.write(Buffer.from(this._rewritePresence(conn.lastPresence), 'utf8'));
          applied += 1;
        }
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

  async start(status = 'offline') {
    this.setStatus(status);
    try {
      await ensureResolves();               // fail fast if the domain can't reach localhost
      const pfx = await getPfx(this.dir);

      const chatServer = tls.createServer(
        { pfx },
        (incoming) => this._handleChat(incoming),
      );
      this._servers.push(chatServer);
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        chatServer.once('error', onError);
        chatServer.listen(0, '127.0.0.1', () => {
          chatServer.removeListener('error', onError);
          resolve();
        });
      });
      chatServer.on('error', (error) => { this.lastError = error.message; });
      this.chatProxyPort = chatServer.address().port;

      const configServer = http.createServer((req, res) => this._handleConfig(req, res));
      this._servers.push(configServer);
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        configServer.once('error', onError);
        configServer.listen(0, '127.0.0.1', () => {
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
    for (const conn of this._connections) {
      try { conn.incoming.destroy(); } catch { /* ignore */ }
      try { conn.outgoing.destroy(); } catch { /* ignore */ }
    }
    this._connections.clear();
    for (const s of this._servers) { try { s.close(); } catch { /* ignore */ } }
    this._servers = [];
    this._running = false;
  }

  isRunning() { return this._running; }

  // ---- Config proxy --------------------------------------------------------

  _handleConfig(req, res) {
    const target = CONFIG_URL + req.url;
    const headers = {};
    if (req.headers['user-agent']) headers['User-Agent'] = req.headers['user-agent'];
    if (req.headers['x-riot-entitlements-jwt']) headers['X-Riot-Entitlements-JWT'] = req.headers['x-riot-entitlements-jwt'];
    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];

    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      try { res.writeHead(502); res.end(); } catch { /* ignore */ }
    };
    const up = https.get(target, { headers }, (upRes) => {
      const chunks = [];
      let size = 0;
      upRes.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_HTTP_BYTES) {
          up.destroy(new Error('Config response exceeded the Riot Relay safety limit.'));
          fail();
          return;
        }
        chunks.push(chunk);
      });
      upRes.on('end', async () => {
        if (failed) return;
        let body = Buffer.concat(chunks).toString('utf8');
        if (upRes.statusCode >= 200 && upRes.statusCode < 300) {
          try {
            const cfg = JSON.parse(body);
            // Point chat at our proxy via the trusted localhost domain (NOT a
            // raw 127.0.0.1, so the client's TLS cert check against the domain
            // succeeds). Remember the real host to forward to.
            if (cfg['chat.host']) { this.chatHost = cfg['chat.host']; cfg['chat.host'] = LOCALHOST_DOMAIN; }
            if (cfg['chat.port']) { this.chatPort = cfg['chat.port']; cfg['chat.port'] = this.chatProxyPort; }
            if (cfg['chat.affinities']) {
              if (cfg['chat.affinity.enabled'] && req.headers['authorization']) {
                try {
                  const aff = await this._affinity(req.headers['authorization']);
                  if (aff && cfg['chat.affinities'][aff]) this.chatHost = cfg['chat.affinities'][aff];
                } catch { /* keep fallback host */ }
              }
              for (const k of Object.keys(cfg['chat.affinities'])) cfg['chat.affinities'][k] = LOCALHOST_DOMAIN;
            }
            body = JSON.stringify(cfg);
          } catch { /* forward as-is */ }
        }
        const buf = Buffer.from(body, 'utf8');
        res.writeHead(upRes.statusCode || 200, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
        res.end(buf);
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
    if (!this.chatHost || !this.chatPort) { incoming.destroy(); return; }
    const outgoing = tls.connect({
      host: this.chatHost,
      port: this.chatPort,
      servername: this.chatHost,
      rejectUnauthorized: true,
    });
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
      if (isHelperCommand && conn.insertedFake) {
        // The JID is synthetic and must never be forwarded to Riot, even when
        // the helper has just been disabled on this live connection.
        if (this._canUseHelper(conn)) this._handleCommand(stanza, conn);
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
    setTimeout(() => this._writeFakeMessage(conn, `${HELPER_NAME} is active — you are appearing ${this._word()} to your friends. Parties and invites remain available.`), 2500);
    setTimeout(() => this._writeFakeMessage(conn, 'Message me "status", "online", "away", "offline" or "mobile" to change how you appear.'), 3200);
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

  /** Handle a chat command the user typed to the League helper contact. */
  _handleCommand(content, conn) {
    if (!this._canUseHelper(conn) || !conn.insertedFake) return false;
    const body = (content.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i) || [])[1] || '';
    const command = body.trim().toLowerCase();
    if (command.includes('offline')) { this.setStatus('offline'); return true; }
    if (command.includes('mobile')) { this.setStatus('mobile'); return true; }
    if (command.includes('away')) { this.setStatus('away'); return true; }
    if (command.includes('online')) { this.setStatus('chat'); return true; }

    const reply = command.includes('status')
      ? `You are currently appearing ${this._word()}.`
      : 'Send "online", "away", "offline" or "mobile" to change how you appear.';
    setTimeout(() => this._writeFakeMessage(conn, reply), 150);
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
