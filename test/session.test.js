'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vanguard-home-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vanguard-userdata-'));
const originalHome = os.homedir;
os.homedir = () => fakeHome;
const session = require('../electron/session');
os.homedir = originalHome;

const riotData = path.join(fakeHome, 'AppData', 'Local', 'Riot Games', 'Riot Client', 'Data');
const liveFile = path.join(riotData, 'RiotGamesPrivateSettings.yaml');
const accountA = { id: 'acc-A', puuid: 'puuid-A', riotId: 'Player#A1' };
fs.mkdirSync(riotData, { recursive: true });

test.after(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
});

test('capture creates a validated identity-bound manifest and restore round-trips', () => {
  fs.writeFileSync(liveFile, 'session: ACCOUNT_A_COOKIE');
  const captured = session.captureSession(userData, accountA.id, accountA);
  assert.equal(captured.available, true);
  assert.equal(captured.identityVerified, true);
  assert.equal(captured.manifest.schemaVersion, session.SCHEMA_VERSION);
  assert.equal(captured.manifest.identity.puuid, accountA.puuid);

  fs.writeFileSync(liveFile, 'session: OTHER_COOKIE');
  const restored = session.restoreSession(userData, accountA.id, accountA);
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(liveFile, 'utf8'), 'session: ACCOUNT_A_COOKIE');
});

test('PUUID mismatch invalidates a snapshot even when Riot ID matches', () => {
  const status = session.validateSession(userData, accountA.id, { ...accountA, puuid: 'different-puuid' });
  assert.equal(status.available, false);
  assert.equal(status.reason, 'identity-mismatch');
  assert.throws(() => session.restoreSession(userData, accountA.id, { ...accountA, puuid: 'different-puuid' }), /not usable/i);
});
test('legacy, missing, corrupt, empty, and tampered snapshots are not advertised', () => {
  const legacyDir = path.join(userData, 'sessions', 'legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'RiotGamesPrivateSettings.yaml'), 'old cookie');
  assert.equal(session.validateSession(userData, 'legacy', { puuid: 'x' }).reason, 'legacy');
  assert.equal(session.validateSession(userData, 'missing', { puuid: 'x' }).reason, 'missing');

  const manifestPath = path.join(userData, 'sessions', accountA.id, 'manifest.json');
  const settingsPath = path.join(userData, 'sessions', accountA.id, 'RiotGamesPrivateSettings.yaml');
  const goodManifest = fs.readFileSync(manifestPath, 'utf8');
  const goodSettings = fs.readFileSync(settingsPath);

  fs.writeFileSync(manifestPath, '{broken');
  assert.equal(session.validateSession(userData, accountA.id, accountA).reason, 'corrupt-manifest');
  fs.writeFileSync(manifestPath, goodManifest);
  fs.writeFileSync(settingsPath, 'tampered-cookie');
  assert.equal(session.validateSession(userData, accountA.id, accountA).reason, 'invalid-settings');
  fs.writeFileSync(settingsPath, '');
  assert.equal(session.validateSession(userData, accountA.id, accountA).reason, 'invalid-settings');
  fs.writeFileSync(settingsPath, goodSettings);
  assert.equal(session.validateSession(userData, accountA.id, accountA).available, true);
});

test('recapture atomically replaces the old snapshot only after validation', () => {
  fs.writeFileSync(liveFile, 'session: NEW_ACCOUNT_A_COOKIE');
  const status = session.captureSession(userData, accountA.id, accountA);
  assert.equal(status.available, true);
  const saved = path.join(userData, 'sessions', accountA.id, 'RiotGamesPrivateSettings.yaml');
  assert.equal(fs.readFileSync(saved, 'utf8'), 'session: NEW_ACCOUNT_A_COOKIE');
  const leftovers = fs.readdirSync(path.join(userData, 'sessions')).filter((name) => name.startsWith(`${accountA.id}.tmp-`) || name.startsWith(`${accountA.id}.bak-`));
  assert.deepEqual(leftovers, []);
});

test('remove clears the complete snapshot', () => {
  session.removeSession(userData, accountA.id);
  assert.equal(session.validateSession(userData, accountA.id, accountA).reason, 'missing');
});