'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { DeceiveProxy } = require('../electron/deceive');

const ROSTER = "<iq id='roster'><query xmlns='jabber:iq:riotgames:roster'><item jid='real@eu1.pvp.net'/></query></iq>";
const PRESENCE = "<presence id='a'><show>chat</show><status>Playing</status><games><valorant><st>chat</st></valorant></games></presence>";

class MemorySocket {
  constructor() {
    this.destroyed = false;
    this.chunks = [];
  }

  write(value) {
    this.chunks.push(Buffer.from(value));
    return true;
  }

  destroy() { this.destroyed = true; }
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

function requestConfig(proxy, url) {
  return new Promise((resolve) => {
    proxy._handleConfig(
      { url, headers: {} },
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

test('League connection injects roster, presence, messages, and intercepts helper commands', () => {
  const proxy = new DeceiveProxy('unused', { launchProduct: 'league' });
  const { conn, incoming, outgoing } = createConnection(proxy);
  proxy._scheduleHelperNotifications = (connection) => {
    assert.equal(proxy._writeFakePresence(connection), true);
    assert.equal(proxy._writeFakeMessage(connection, 'helper ready'), true);
  };

  processServer(proxy, conn, ROSTER);
  const injected = incoming.text();
  assert.equal(conn.insertedFake, true);
  assert.match(injected, /Riot Relay/);
  assert.match(injected, /<presence from=/);
  assert.match(injected, /<message from=/);
  assert.match(injected, /helper ready/);

  proxy.setStatus('chat');
  processClient(proxy, conn, `<message to='${conn.fakeJid}/RC'><body>away</body></message>`);
  assert.equal(proxy.status, 'away');
  assert.equal(outgoing.text(), '');

  proxy.setOptions({ leagueHelper: false });
  processClient(proxy, conn, `<message to='${conn.fakeJid}/RC'><body>online</body></message>`);
  assert.equal(proxy.status, 'away');
  assert.equal(outgoing.text(), '');
  assert.equal(proxy.getState().helperAvailable, false);
});

test('League helper disabled passes roster and fake-JID messages through unchanged', () => {
  const proxy = new DeceiveProxy('unused', { launchProduct: 'league', leagueHelper: false });
  const { conn, incoming, outgoing } = createConnection(proxy);
  processServer(proxy, conn, ROSTER);
  assert.equal(incoming.text(), ROSTER);
  assert.equal(conn.insertedFake, false);
  const message = `<message to='${conn.fakeJid}'><body>offline</body></message>`;
  processClient(proxy, conn, message);
  assert.equal(outgoing.text(), message);

  proxy.setOptions({ leagueHelper: true });
  proxy._scheduleHelperNotifications = () => {};
  incoming.clear();
  processServer(proxy, conn, ROSTER);
  assert.equal(conn.insertedFake, true);
  assert.match(incoming.text(), /Riot Relay/);
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

test('mixed and stale config URL ordering never changes launch or connection policy', async () => {
  const originalGet = https.get;
  https.get = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => { if (error) request.emit('error', error); };
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      response.emit('data', Buffer.from(JSON.stringify({ 'chat.host': 'chat.eu1.lol.riotgames.com', 'chat.port': 5223 })));
      response.emit('end');
    });
    return request;
  };

  try {
    const league = new DeceiveProxy('unused', { launchProduct: 'league' });
    const before = createConnection(league).conn;
    await requestConfig(league, '/api/v1/config/valorant/live');
    const afterValorant = createConnection(league).conn;
    await requestConfig(league, '/api/v1/config/league_of_legends/live');
    const afterLeague = createConnection(league).conn;
    assert.equal(league.launchProduct, 'league');
    assert.deepEqual([before, afterValorant, afterLeague].map((conn) => [conn.product, league._canUseHelper(conn)]), [
      ['league', true], ['league', true], ['league', true],
    ]);

    const valorant = new DeceiveProxy('unused', { launchProduct: 'valorant' });
    await requestConfig(valorant, '/api/v1/config/league-client/live');
    const valConn = createConnection(valorant).conn;
    assert.deepEqual([valorant.launchProduct, valConn.product, valorant._canUseHelper(valConn)], ['valorant', 'valorant', false]);
  } finally {
    https.get = originalGet;
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
    assert.doesNotMatch(outgoing.text(), /Riot Relay|type='chat'/);
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
    activeConnections: 3,
    connectionProducts: { league: 1, valorant: 1, unknown: 1 },
    helperConnections: 1,
    lastError: null,
    fakeFriend: 'Riot Relay',
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