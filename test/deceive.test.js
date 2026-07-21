'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DeceiveProxy } = require('../electron/deceive');

const ROSTER = "<iq id='roster'><query xmlns='jabber:iq:riotgames:roster'><item jid='real@eu1.pvp.net'/></query></iq>";
const PRESENCE = "<presence id='a'><show>chat</show><status>Playing</status><games><valorant><st>chat</st></valorant></games></presence>";

class MemorySocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.chunks = [];
  }

  write(value) {
    this.chunks.push(Buffer.from(value));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
  clear() { this.chunks = []; }
  text() { return Buffer.concat(this.chunks).toString('utf8'); }
}

function createConnection(proxy) {
  const incoming = new MemorySocket();
  const outgoing = new MemorySocket();
  const conn = proxy._createConnection(incoming, outgoing);
  return { conn, incoming, outgoing };
}

function processServer(proxy, conn, content) {
  let error;
  proxy._processServerData(conn, Buffer.from(content), (value) => { error = value; });
  assert.equal(error, undefined);
}

function processClient(proxy, conn, content) {
  let error;
  proxy._processClientData(conn, Buffer.from(content), (value) => { error = value; });
  assert.equal(error, undefined);
}

function requestConfig(proxy, url, headers = {}) {
  return new Promise((resolve) => {
    proxy._handleConfig(
      { url, headers },
      {
        writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
        end(body) { resolve({ statusCode: this.statusCode, headers: this.headers, body: String(body || '') }); },
      },
    );
  });
}

test('constructor maps launchProduct once and connection policy is immutable', () => {
  const cases = [
    ['league', 'league'], ['lol', 'league'], ['tft', 'league'],
    ['league_of_legends', 'league'], ['valorant', 'valorant'],
    ['other', 'unknown'], [undefined, 'unknown'],
  ];
  for (const [input, expected] of cases) {
    const proxy = new DeceiveProxy('unused', { launchProduct: input });
    const { conn } = createConnection(proxy);
    assert.equal(proxy.launchProduct, expected);
    assert.equal(proxy.clientProduct, expected);
    assert.equal(conn.product, expected);
    assert.equal(proxy._canUseHelper(conn), expected === 'league');
    assert.equal(Object.getOwnPropertyDescriptor(conn, 'product').writable, false);
    assert.throws(() => { proxy.launchProduct = 'league'; }, TypeError);
    assert.throws(() => { conn.product = 'league'; }, TypeError);
  }
});

test('League connection injects named helper and intercepts exact commands without forwarding', () => {
  const proxy = new DeceiveProxy('unused', { launchProduct: 'league' });
  const { conn, incoming, outgoing } = createConnection(proxy);
  proxy._scheduleHelperNotifications = (connection) => {
    assert.equal(proxy._writeFakePresence(connection), true);
    assert.equal(proxy._writeFakeMessage(connection, 'helper ready'), true);
  };

  processServer(proxy, conn, ROSTER);
  const injected = incoming.text();
  assert.equal(conn.insertedFake, true);
  assert.equal(conn.rosterSeen, true);
  assert.match(injected, /Deceive Active!/);
  assert.match(injected, /<presence from=/);
  assert.match(injected, /<message from=/);
  assert.match(injected, /helper ready/);

  for (const [command, status] of [['away', 'away'], ['mobile', 'mobile'], ['offline', 'offline'], ['online', 'chat']]) {
    processClient(proxy, conn, `<message to='${conn.fakeJid}/RC'><body>${command}</body></message>`);
    assert.equal(proxy.status, status);
    assert.equal(proxy.enabled, true);
  }
  assert.equal(outgoing.text(), '');

  processClient(proxy, conn, `<message to='${conn.fakeJid}/RC'><body>go offline</body></message>`);
  assert.equal(proxy.status, 'chat', 'commands must match exactly');
  assert.match(incoming.text(), /Unknown command/);
  assert.equal(outgoing.text(), '');

  processClient(proxy, conn, `<message to='${conn.fakeJid}/RC'><body>disable</body></message>`);
  assert.equal(proxy.enabled, false);
  processClient(proxy, conn, `<message to='${conn.fakeJid}/RC'><body>status</body></message>`);
  assert.match(incoming.text(), /Visible status: Riot-controlled\. Deceive is disabled\./);
  processClient(proxy, conn, `<message to='${conn.fakeJid}/RC'><body>enable</body></message>`);
  processClient(proxy, conn, `<message to='${conn.fakeJid}/RC'><body>help</body></message>`);
  assert.equal(proxy.enabled, true);
  assert.match(incoming.text(), /online, offline, mobile, away, enable, disable, status, help/);
  assert.equal(outgoing.text(), '');

  proxy.setOptions({ leagueHelper: false });
  processClient(proxy, conn, `<message to='${conn.fakeJid}/RC'><body>offline</body></message>`);
  assert.equal(proxy.status, 'chat');
  assert.equal(outgoing.text(), '', 'synthetic helper traffic must stay private when disabled');
  assert.equal(proxy.getState().helperAvailable, false);
});

test('League helper disabled passes roster but never forwards synthetic-JID messages', () => {
  const proxy = new DeceiveProxy('unused', { launchProduct: 'league', leagueHelper: false });
  const { conn, incoming, outgoing } = createConnection(proxy);
  processServer(proxy, conn, ROSTER);
  assert.equal(incoming.text(), ROSTER);
  assert.equal(conn.rosterSeen, true);
  assert.equal(conn.insertedFake, false);
  const message = `<message to='${conn.fakeJid}'><body>offline</body></message>`;
  processClient(proxy, conn, message);
  assert.equal(outgoing.text(), '');

  proxy.setOptions({ leagueHelper: true });
  proxy._scheduleHelperNotifications = () => {};
  incoming.clear();
  processServer(proxy, conn, ROSTER);
  assert.equal(conn.insertedFake, true);
  assert.match(incoming.text(), /Deceive Active!/);
});

test('VALORANT and unknown connections fail closed while presence rewriting still applies', async (t) => {
  for (const product of ['valorant', 'unknown']) {
    await t.test(product, () => {
      const proxy = new DeceiveProxy('unused', { launchProduct: product });
      const { conn, incoming, outgoing } = createConnection(proxy);
      processServer(proxy, conn, ROSTER);
      assert.equal(incoming.text(), ROSTER);
      assert.equal(conn.insertedFake, false);

      proxy.setStatus('offline');
      const command = `<message to='${conn.fakeJid}'><body>online</body></message>`;
      processClient(proxy, conn, PRESENCE + command);
      assert.match(outgoing.text(), /<show>offline<\/show>/);
      assert.doesNotMatch(outgoing.text(), /<status>|<games>/);
      assert.ok(outgoing.text().endsWith(command));
      assert.equal(proxy.status, 'offline');
    });
  }
});

test('config routing is product-scoped, certificate-compatible, affinity-resolved, and immutable', async () => {
  const originalGet = https.get;
  let leagueRequests = 0;
  let mismatchedBody = '';
  https.get = (url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => { if (error) request.emit('error', error); };
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      const isValorant = String(url).includes('/valorant/');
      if (!isValorant) leagueRequests += 1;
      const suffix = isValorant ? 'valorant' : `league-${leagueRequests}`;
      const body = JSON.stringify({
        'chat.host': `fallback.${suffix}.riotgames.com`,
        'chat.port': isValorant ? 5224 : 5223,
        'chat.affinity.enabled': true,
        'chat.affinities': { eu1: `chat.${suffix}.riotgames.com` },
      }, null, isValorant ? 2 : 0);
      if (isValorant) mismatchedBody = body;
      response.emit('data', Buffer.from(body));
      response.emit('end');
    });
    return request;
  };

  try {
    const league = new DeceiveProxy('unused', { launchProduct: 'league' });
    league.chatProxyPort = 43123;
    league._affinity = async () => 'eu1';

    const stale = await requestConfig(league, '/api/v1/config/valorant/live', { authorization: 'Bearer private' });
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.body, mismatchedBody);
    const staleConfig = JSON.parse(stale.body);
    assert.equal(staleConfig['chat.host'], 'fallback.valorant.riotgames.com');
    assert.equal(staleConfig['chat.port'], 5224);
    assert.equal(staleConfig['chat.allow_bad_cert'], undefined);
    assert.equal(league.chatHost, null);

    const first = JSON.parse((await requestConfig(league, '/api/v1/config/league_of_legends/live', { authorization: 'Bearer private' })).body);
    assert.equal(first['chat.host'], 'deceive-localhost.molenzwiebel.xyz');
    assert.equal(first['chat.port'], 43123);
    assert.equal(first['chat.allow_bad_cert'], true);
    assert.deepEqual(first['chat.affinities'], { eu1: 'deceive-localhost.molenzwiebel.xyz' });
    assert.equal(league.chatHost, 'chat.league-1.riotgames.com');
    assert.equal(league.chatPort, 5223);
    assert.equal(Object.isFrozen(league._chatRoute), true);

    await requestConfig(league, '/api/v1/config/league-client/live', { authorization: 'Bearer private' });
    await requestConfig(league, '/api/v1/config/valorant/live', { authorization: 'Bearer private' });
    assert.deepEqual(league._chatRoute, { host: 'chat.league-1.riotgames.com', port: 5223 });
    assert.throws(() => { league.chatHost = 'attacker.invalid'; }, TypeError);

    const valorant = new DeceiveProxy('unused', { launchProduct: 'valorant' });
    await requestConfig(valorant, '/api/v1/config/league-client/live');
    assert.equal(valorant.chatHost, null);
    const valConn = createConnection(valorant).conn;
    assert.deepEqual([valorant.launchProduct, valConn.product, valorant._canUseHelper(valConn)], ['valorant', 'valorant', false]);
  } finally {
    https.get = originalGet;
  }
});

test('a latched route persists the chat port and route so a restart can rebind them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deceive-session-'));
  try {
    assert.equal(DeceiveProxy.readPersistedSession(dir), null);
    const proxy = new DeceiveProxy(dir, { launchProduct: 'valorant' });
    proxy.chatProxyPort = 54321;
    assert.equal(proxy._latchRoute('chat.eu1.pvp.net', 5223), true);

    const persisted = DeceiveProxy.readPersistedSession(dir);
    assert.deepEqual(persisted, {
      chatProxyPort: 54321,
      route: { host: 'chat.eu1.pvp.net', port: 5223 },
      launchProduct: 'valorant',
    });

    DeceiveProxy.clearPersistedSession(dir);
    assert.equal(DeceiveProxy.readPersistedSession(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('route-free client config passes through byte-for-byte without latching chat', async () => {
  const originalGet = https.get;
  const upstreamBody = Buffer.from('{\n  "patchline": "live",\n  "chat.feature.enabled": true,\n  "updater": { "channel": "stable" }\n}\n', 'utf8');
  https.get = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => { if (error) request.emit('error', error); };
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      response.emit('data', upstreamBody.subarray(0, 17));
      response.emit('data', upstreamBody.subarray(17));
      response.emit('end');
    });
    return request;
  };

  try {
    const proxy = new DeceiveProxy('unused', { launchProduct: 'league' });
    const result = await requestConfig(proxy, '/api/v1/config/league_of_legends/live');
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, upstreamBody.toString('utf8'));
    assert.equal(proxy._chatRoute, null);
    assert.equal(proxy.chatHost, null);
    assert.equal(proxy.chatPort, 0);
    assert.equal(proxy.lastError, null);
  } finally {
    https.get = originalGet;
  }
});

test('a plain-switch proxy persists the observed product so restart restores League helper eligibility only', async () => {
  const originalGet = https.get;
  const leagueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deceive-league-restart-'));
  const valorantDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deceive-valorant-restart-'));
  https.get = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => { if (error) request.emit('error', error); };
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      response.emit('data', Buffer.from(JSON.stringify({ 'chat.host': 'chat.eu1.pvp.net', 'chat.port': 5223 })));
      response.emit('end');
    });
    return request;
  };
  try {
    const league = new DeceiveProxy(leagueDir); // no launchProduct => 'unknown'
    league.chatProxyPort = 43123;
    assert.equal(league._canUseHelper(createConnection(league).conn), false);
    await requestConfig(league, '/api/v1/config/league_of_legends/live');
    assert.equal(league._latchedProduct, 'league');
    assert.equal(league._canUseHelper(createConnection(league).conn), true);
    const persistedLeague = DeceiveProxy.readPersistedSession(leagueDir);
    assert.equal(persistedLeague.launchProduct, 'league');
    const restartedLeague = new DeceiveProxy(leagueDir, { launchProduct: persistedLeague.launchProduct });
    restartedLeague._chatRoute = Object.freeze(persistedLeague.route);
    assert.equal(restartedLeague._canUseHelper(createConnection(restartedLeague).conn), true);

    const valorant = new DeceiveProxy(valorantDir); // 'unknown'
    valorant.chatProxyPort = 43124;
    await requestConfig(valorant, '/api/v1/config/valorant/live');
    assert.equal(valorant._latchedProduct, 'valorant');
    assert.equal(valorant._canUseHelper(createConnection(valorant).conn), false);
    const persistedValorant = DeceiveProxy.readPersistedSession(valorantDir);
    assert.equal(persistedValorant.launchProduct, 'valorant');
    const restartedValorant = new DeceiveProxy(valorantDir, { launchProduct: persistedValorant.launchProduct });
    restartedValorant._chatRoute = Object.freeze(persistedValorant.route);
    assert.equal(restartedValorant._canUseHelper(createConnection(restartedValorant).conn), false);
  } finally {
    https.get = originalGet;
    fs.rmSync(leagueDir, { recursive: true, force: true });
    fs.rmSync(valorantDir, { recursive: true, force: true });
  }
});

test('setStatus never emits helper content to non-League connections', () => {
  for (const product of ['valorant', 'unknown']) {
    const proxy = new DeceiveProxy('unused', { launchProduct: product });
    const { conn, incoming, outgoing } = createConnection(proxy);
    conn.insertedFake = true; // Even stale/corrupt mutable state must fail closed.
    conn.lastPresence = PRESENCE;
    proxy._connections.add(conn);

    assert.equal(proxy._writeFakePresence(conn), false);
    assert.equal(proxy._writeFakeMessage(conn, 'must not send'), false);
    const result = proxy.setStatus('away');
    assert.equal(result.notifiedChats, 0);
    assert.equal(incoming.text(), '');
    assert.match(outgoing.text(), /<show>away<\/show>/);
    assert.doesNotMatch(outgoing.text(), /Deceive Active!|type='chat'/);
  }
});

test('away, mobile, online, offline, hide-game, and party behavior are preserved', () => {
  const hidden = new DeceiveProxy('unused', { launchProduct: 'unknown' });
  for (const status of ['offline', 'mobile', 'away']) {
    hidden.setStatus(status);
    const output = hidden._rewritePresence(PRESENCE);
    assert.match(output, new RegExp(`<show>${status}</show>`));
    assert.doesNotMatch(output, /<status>|<games>/);
  }

  const visible = new DeceiveProxy('unused', { launchProduct: 'valorant', hideGameActivity: false });
  visible.setStatus('online');
  const online = visible._rewritePresence(PRESENCE);
  assert.match(online, /<show>chat<\/show>/);
  assert.match(online, /<status>Playing<\/status>/);
  assert.match(online, /<games>/);

  const party = "<presence to='room@muc'><show>chat</show></presence>";
  assert.equal(hidden._rewritePresence(party), party);
  hidden.setOptions({ preserveParty: false });
  assert.equal(hidden._rewritePresence(party), '');
});

test('getState summarizes mixed immutable connection products', () => {
  const league = new DeceiveProxy('unused', { launchProduct: 'league' });
  const valorant = new DeceiveProxy('unused', { launchProduct: 'valorant' });
  const unknown = new DeceiveProxy('unused');
  const leagueConnection = createConnection(league).conn;
  leagueConnection.insertedFake = true;
  league._connections.add(leagueConnection);
  league._connections.add(createConnection(valorant).conn);
  league._connections.add(createConnection(unknown).conn);

  assert.deepEqual(league.getState(), {
    running: false,
    chatConnected: false,
    status: 'offline',
    enabled: true,
    activeConnections: 3,
    connectionProducts: { league: 1, valorant: 1, unknown: 1 },
    helperConnections: 1,
    lastError: null,
    fakeFriend: 'Deceive Active!',
    helperAvailable: true,
    launchProduct: 'league',
    clientProduct: 'league',
    preserveParty: true,
    activityMode: 'hide',
    customStatus: '',
    hideGameActivity: true,
    leagueHelper: true,
  });
});


test('activity modes preserve, hide, or replace rich activity with escaped generic status', () => {
  const proxy = new DeceiveProxy('unused', { launchProduct: 'valorant', activityMode: 'preserve' });
  proxy.setStatus('chat');
  const preserved = proxy._rewritePresence(PRESENCE);
  assert.match(preserved, /<status>Playing<\/status>/);
  assert.match(preserved, /<games>/);

  proxy.setOptions({ activityMode: 'hide' });
  const hidden = proxy._rewritePresence(PRESENCE);
  assert.doesNotMatch(hidden, /<status>|<games>/);

  proxy.setOptions({ activityMode: 'generic', customStatus: 'Queue <later> & "safe"\u0000' });
  const generic = proxy._rewritePresence(PRESENCE);
  assert.doesNotMatch(generic, /<games>|<valorant>/);
  assert.match(generic, /<status>Queue &lt;later&gt; &amp; &quot;safe&quot;<\/status>/);
  assert.equal(proxy.getState().customStatus, 'Queue <later> & "safe"');
});

test('a non-2xx upstream response is forwarded unchanged so Riot Client can retry itself', async () => {
  const originalGet = https.get;
  const reply = { status: 503, body: 'upstream secret details', contentType: 'text/plain' };
  https.get = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => { if (error) request.emit('error', error); };
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = reply.status;
      response.headers = { 'content-type': reply.contentType };
      response.resume = () => {};
      callback(response);
      response.emit('data', Buffer.from(reply.body));
      response.emit('end');
    });
    return request;
  };

  try {
    const proxy = new DeceiveProxy('unused', { launchProduct: 'league' });
    const result = await requestConfig(proxy, '/api/v1/config/league_of_legends/live');
    assert.equal(result.statusCode, 503);
    assert.equal(result.body, reply.body);
    assert.equal(result.headers['Content-Type'], reply.contentType);
    assert.equal(proxy.chatHost, null);
    assert.equal(proxy.lastError, null);
  } finally {
    https.get = originalGet;
  }
});

test('config responses with an invalid or incomplete chat route return only a sanitized 502 and never latch a route', async () => {
  const originalGet = https.get;
  const replies = [
    { status: 200, body: '{not json' },
    { status: 200, body: JSON.stringify({ 'chat.host': '', 'chat.port': 70000 }) },
    { status: 200, body: JSON.stringify({ 'chat.host': 'chat.example.com' }) },
    { status: 200, body: JSON.stringify({ 'chat.port': 5223 }) },
    { status: 200, body: JSON.stringify({ 'chat.affinities': { eu1: 'chat.example.com' } }) },
    { status: 200, body: JSON.stringify({ 'chat.affinity.enabled': true }) },
  ];
  const replyCount = replies.length;
  https.get = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => { if (error) request.emit('error', error); };
    process.nextTick(() => {
      const reply = replies.shift();
      const response = new EventEmitter();
      response.statusCode = reply.status;
      response.headers = {};
      response.resume = () => {};
      callback(response);
      response.emit('data', Buffer.from(reply.body));
      response.emit('end');
    });
    return request;
  };

  try {
    const proxy = new DeceiveProxy('unused', { launchProduct: 'league' });
    for (let index = 0; index < replyCount; index += 1) {
      const result = await requestConfig(proxy, '/api/v1/config/league_of_legends/live');
      assert.equal(result.statusCode, 502);
      assert.equal(result.body, 'Bad Gateway');
      assert.equal(result.headers['Content-Type'], 'text/plain; charset=utf-8');
      assert.equal(result.headers.Connection, 'close');
      assert.equal(proxy.chatHost, null);
    }
  } finally {
    https.get = originalGet;
  }
});

test('early chat sockets drain once through verified TLS when the route latches', () => {
  const originalConnect = tls.connect;
  const calls = [];
  tls.connect = (options) => {
    const socket = new MemorySocket();
    calls.push({ options, socket });
    return socket;
  };

  try {
    const proxy = new DeceiveProxy('unused', { launchProduct: 'league' });
    const first = new MemorySocket();
    const second = new MemorySocket();
    proxy._handleChat(first);
    proxy._handleChat(second);
    assert.equal(proxy._pendingChats.size, 2);
    assert.equal(calls.length, 0);

    assert.equal(proxy._latchRoute('chat.eu1.riotgames.com', 5223), true);
    assert.equal(proxy._pendingChats.size, 0);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.deepEqual(call.options, {
        host: 'chat.eu1.riotgames.com',
        port: 5223,
        servername: 'chat.eu1.riotgames.com',
        rejectUnauthorized: true,
      });
      call.socket.emit('secureConnect');
    }

    assert.equal(proxy._latchRoute('chat.na1.riotgames.com', 5224), false);
    assert.equal(calls.length, 2, 'pending sockets must drain only on the first latch');
    assert.equal(proxy.chatHost, 'chat.eu1.riotgames.com');
    proxy.stop();
  } finally {
    tls.connect = originalConnect;
  }
});

test('early chat queue enforces its cap, timeout, and stop cleanup', () => {
  const capped = new DeceiveProxy('unused');
  const sockets = Array.from({ length: 5 }, () => new MemorySocket());
  for (const socket of sockets) capped._handleChat(socket);
  assert.equal(capped._pendingChats.size, 4);
  assert.equal(sockets[4].destroyed, true);
  capped.stop();
  assert.equal(capped._pendingChats.size, 0);
  assert.equal(sockets.slice(0, 4).every((socket) => socket.destroyed), true);

  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let timeoutCallback;
  global.setTimeout = (callback) => { timeoutCallback = callback; return { fake: true }; };
  global.clearTimeout = () => {};
  try {
    const timed = new DeceiveProxy('unused');
    const socket = new MemorySocket();
    timed._handleChat(socket);
    assert.equal(timed._pendingChats.size, 1);
    timeoutCallback();
    assert.equal(socket.destroyed, true);
    assert.equal(timed._pendingChats.size, 0);
    assert.match(timed.lastError, /routing was not ready/i);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('chatConnected becomes true only after an actual roster response is observed', () => {
  const proxy = new DeceiveProxy('unused', { launchProduct: 'league' });
  proxy._scheduleHelperNotifications = () => {};
  const { conn } = createConnection(proxy);
  proxy._connections.add(conn);
  assert.equal(proxy.getState().chatConnected, false);
  processServer(proxy, conn, '<iq><query xmlns="unrelated"/></iq>');
  assert.equal(proxy.getState().chatConnected, false);
  processServer(proxy, conn, ROSTER);
  assert.equal(proxy.getState().chatConnected, true);
});

test('disable restores Riot presence, enable reapplies masking, and status reports both', () => {
  const proxy = new DeceiveProxy('unused', { launchProduct: 'league' });
  proxy._scheduleHelperNotifications = () => {};
  const { conn, incoming, outgoing } = createConnection(proxy);
  proxy._connections.add(conn);
  processServer(proxy, conn, ROSTER);
  processClient(proxy, conn, PRESENCE);
  assert.match(outgoing.text(), /<show>offline<\/show>/);

  outgoing.clear();
  incoming.clear();
  processClient(proxy, conn, `<message to='${conn.fakeJid}'><body>disable</body></message>`);
  assert.equal(proxy.enabled, false);
  assert.equal(outgoing.text(), PRESENCE);
  processClient(proxy, conn, `<message to='${conn.fakeJid}'><body>status</body></message>`);
  assert.match(incoming.text(), /Visible status: online\. Deceive is disabled\./);
  assert.doesNotMatch(outgoing.text(), /<message/);

  outgoing.clear();
  processClient(proxy, conn, `<message to='${conn.fakeJid}'><body>enable</body></message>`);
  assert.equal(proxy.enabled, true);
  assert.match(outgoing.text(), /<show>offline<\/show>/);
  assert.doesNotMatch(outgoing.text(), /<status>|<games>|<message/);
});