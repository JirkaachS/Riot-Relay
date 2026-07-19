'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LINK_REQUIRED, assertAccountIdentity, findRosterMatches } = require('../electron/account-identity');

const live = { puuid: 'PUUID-1', gameName: 'hmu for biceps', tagLine: '271j' };

test('PUUID is authoritative and rejects mismatches even if Riot ID matches', () => {
  assert.equal(assertAccountIdentity({ puuid: 'puuid-1', riotId: 'old#id' }, live).linked, true);
  assert.throws(
    () => assertAccountIdentity({ label: 'Wrong', puuid: 'PUUID-2', riotId: 'hmu for biceps#271j' }, live),
    /does not match/,
  );
});

test('complete Riot ID is a case-insensitive secondary match for unlinked accounts', () => {
  const result = assertAccountIdentity({ riotId: 'HMU FOR BICEPS#271J' }, live);
  assert.equal(result.firstLink, true);
  assert.equal(result.patch.puuid, live.puuid);
  assert.equal(result.patch.riotId, 'hmu for biceps#271j');
});

test('login username is never treated as Riot identity', () => {
  assert.throws(
    () => assertAccountIdentity({ username: 'hmu for biceps' }, live),
    (error) => error.message.startsWith(LINK_REQUIRED),
  );
});

test('an identity-less account requires explicit first-time linkage', () => {
  assert.throws(() => assertAccountIdentity({ label: 'Boxaquadow', username: 'Boxaquadow' }, live), /LINK_REQUIRED/);
  const linked = assertAccountIdentity({ label: 'Boxaquadow', username: 'Boxaquadow' }, live, { allowLink: true });
  assert.deepEqual(linked.patch, { puuid: 'PUUID-1', riotId: 'hmu for biceps#271j' });
});

test('roster matching prefers PUUID and never falls back through login username', () => {
  const accounts = [
    { id: 'login-only', username: 'hmu for biceps' },
    { id: 'riot-id', riotId: 'HMU FOR BICEPS#271J' },
    { id: 'puuid', puuid: 'puuid-1', riotId: 'stale#id' },
  ];
  assert.deepEqual(findRosterMatches(accounts, live).map((account) => account.id), ['puuid']);
});