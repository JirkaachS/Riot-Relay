'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const {
  fetchOpggStats, discoverOpggStats, opggRegion, opggProfileUrl, uggProfileUrl, deeplolProfileUrl, dpmProfileUrl,
  LEAGUE_PLATFORMS, normalizeLeaguePlatform, canonicalLeaguePlatform, selectLeaguePlatform,
  leagueWallet, normalizeRankedQueue, priceLeagueRecord,
} = require('../electron/league');
const { vtlProfileUrl, trackerProfileUrl } = require('../electron/valorant');

function mockJsonSequence(values) {
  const original = https.get;
  const requests = [];
  https.get = (url, _options, callback) => {
    requests.push(String(url));
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => { if (error) request.emit('error', error); };
    const value = values.shift();
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      response.emit('data', Buffer.from(JSON.stringify(value)));
      response.emit('end');
    });
    return request;
  };
  return { requests, restore: () => { https.get = original; } };
}

function mockJsonByUrl(resolveValue) {
  const original = https.get;
  const requests = [];
  let active = 0;
  let maxActive = 0;
  https.get = (url, _options, callback) => {
    const href = String(url);
    requests.push(href);
    active += 1;
    maxActive = Math.max(maxActive, active);
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => { if (error) request.emit('error', error); };
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      response.emit('data', Buffer.from(JSON.stringify(resolveValue(href))));
      response.emit('end');
      active -= 1;
    });
    return request;
  };
  return { requests, maxActive: () => maxActive, restore: () => { https.get = original; } };
}

function opggFixture(platformSlug, wantedPuuid = 'wanted-puuid') {
  return (href) => {
    if (href.includes(`/api/v3/${platformSlug}/summoners`)) {
      return { data: [{ game_name: 'Wanted', tagline: 'TAG', summoner_id: `${platformSlug}-row`, puuid: wantedPuuid }] };
    }
    if (href.includes(`/api/${platformSlug}/summoners/${platformSlug}-row/summary`)) {
      return { data: { summoner: { game_name: 'Wanted', tagline: 'TAG', puuid: wantedPuuid, league_stats: [] } } };
    }
    return { data: [] };
  };
}

test('League provider URLs require canonical platforms and use provider-specific slugs', () => {
  assert.equal(opggRegion('EUN1'), 'eune');
  assert.equal(opggRegion('LA2'), 'las');
  assert.equal(opggRegion('SG2'), 'sg');
  assert.equal(opggProfileUrl('Name With Space#EUW', 'EUW1'), 'https://www.op.gg/summoners/euw/Name%20With%20Space-EUW');
  assert.equal(uggProfileUrl('Name With Space#TAG', 'EUN1'), 'https://u.gg/lol/profile/eun1/Name%20With%20Space-TAG/overview');
  assert.equal(deeplolProfileUrl('Name With Space#TAG', 'EUN1'), 'https://www.deeplol.gg/summoner/eune/Name%20With%20Space-TAG');
  assert.equal(dpmProfileUrl('Name With Space#TAG'), 'https://dpm.lol/Name%20With%20Space-TAG');
  assert.throws(() => opggProfileUrl('Name#TAG', 'eu'), /verified League platform/i);
  assert.throws(() => opggProfileUrl('Name#TAG', 'EUNE'), /verified League platform/i);
});

test('VALORANT profile URLs encode complete Riot IDs for VTL.LOL and Tracker.gg', () => {
  assert.equal(vtlProfileUrl('Sen Sacy#eprod'), 'https://vtl.lol/id/Sen+Sacy_eprod');
  assert.equal(trackerProfileUrl('Sen Sacy#eprod'), 'https://tracker.gg/valorant/profile/riot/Sen%20Sacy%23eprod/overview');
  assert.throws(() => vtlProfileUrl('incomplete'), /complete Riot ID/i);
  assert.throws(() => trackerProfileUrl('incomplete'), /complete Riot ID/i);
});

test('League platform aliases normalize while broad routing shards fail canonical validation', () => {
  for (const platformId of LEAGUE_PLATFORMS) assert.equal(canonicalLeaguePlatform(platformId), platformId);
  const aliases = {
    na: 'NA1', na1: 'NA1', euw: 'EUW1', euw1: 'EUW1', eune: 'EUN1', eun: 'EUN1', eun1: 'EUN1',
    kr: 'KR', jp: 'JP1', jp1: 'JP1', br: 'BR1', br1: 'BR1', lan: 'LA1', la1: 'LA1', las: 'LA2', la2: 'LA2',
    oce: 'OC1', oc1: 'OC1', tr: 'TR1', tr1: 'TR1', ru: 'RU', ph: 'PH2', ph2: 'PH2', sg: 'SG2', sg2: 'SG2',
    th: 'TH2', th2: 'TH2', tw: 'TW2', tw2: 'TW2', vn: 'VN2', vn2: 'VN2', me: 'ME1', me1: 'ME1',
  };
  for (const [alias, platformId] of Object.entries(aliases)) assert.equal(normalizeLeaguePlatform(alias), platformId);
  for (const value of ['eu', 'ap', 'latam', '', null]) {
    assert.equal(normalizeLeaguePlatform(value), null);
    assert.equal(canonicalLeaguePlatform(value), null);
  }
});

test('LCU LoginDataPacket platform is preferred, region-locale is fallback, and conflicts fail closed', () => {
  assert.deepEqual(selectLeaguePlatform({ platformId: 'EUN1' }, { region: 'eune' }), {
    platformId: 'EUN1', platformSource: 'lcu-login-data',
  });
  assert.deepEqual(selectLeaguePlatform(null, { region: 'euw' }), {
    platformId: 'EUW1', platformSource: 'lcu-region-locale',
  });
  assert.deepEqual(selectLeaguePlatform({ LoginDataPacket: { platformId: 'NA1' } }, { region: 'euw' }), {
    platformId: null, platformSource: 'lcu-conflict',
  });
});
test('League wallet reads current LCU RP and Blue Essence shapes', () => {
  assert.deepEqual(leagueWallet({ RP: 100, lol_blue_essence: 167 }), { rp: 100, blueEssence: 167 });
  assert.deepEqual(leagueWallet({ balances: { RP: { amount: 250 }, IP: { balance: 900 } } }), {
    rp: 250, blueEssence: 900,
  });
});

test('LCU ranked queues omit fake NA divisions and unranked LP', () => {
  assert.deepEqual(normalizeRankedQueue({ queueType: 'RANKED_TFT', tier: 'UNRANKED', rank: 'NA' }), {
    queue: 'RANKED_TFT', tier: 'UNRANKED', division: '', lp: null, wins: null, losses: null,
  });
  assert.deepEqual(normalizeRankedQueue({ queueType: 'RANKED_SOLO_5x5', tier: 'iron', division: 'I', leaguePoints: 0, wins: 0, losses: 1 }), {
    queue: 'RANKED_SOLO_5x5', tier: 'IRON', division: 'I', lp: 0, wins: 0, losses: 1,
  });
});

test('OP.GG lookup selects only an exact Riot ID and preserves real rank values', async () => {
  const mock = mockJsonSequence([
    { data: [
      { game_name: 'Exact Name', tagline: 'TAG X', summoner_id: 'wrong' },
      { game_name: 'Exact Name', tagline: 'TAG', summoner_id: 'sum-1', puuid: 'puuid-1', level: 42 },
    ] },
    { data: { summoner: {
      game_name: 'Exact Name', tagline: 'TAG', summoner_id: 'sum-1', puuid: 'puuid-1', level: 43,
      league_stats: [
        { game_type: 'SOLORANKED', tier_info: { tier: 'gold', division: 2, lp: 77 }, win: 12, lose: 8 },
        { game_type: 'FLEXRANKED', tier_info: { tier: null, division: null, lp: null }, win: null, lose: null },
      ],
    } } },
  ]);
  try {
    const result = await fetchOpggStats('Exact Name#TAG', 'EUW1', 'puuid-1');
    assert.equal(result.source, 'opgg');
    assert.equal(result.puuid, 'puuid-1');
    assert.equal(result.riotId, 'Exact Name#TAG');
    assert.deepEqual(result.queues[0], {
      queue: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'II', lp: 77, wins: 12, losses: 8,
    });
    assert.deepEqual(result.queues[1], {
      queue: 'RANKED_FLEX_SR', tier: 'UNRANKED', division: '', lp: null, wins: null, losses: null,
    });
    assert.match(mock.requests[0], /riot_id=Exact\+Name%23TAG/);
    assert.match(mock.requests[1], /\/summoners\/sum-1\/summary/);
  } finally { mock.restore(); }
});

test('OP.GG lookup fails closed when summary identity drifts', async () => {
  const mock = mockJsonSequence([
    { data: [{ game_name: 'Wanted', tagline: 'TAG', summoner_id: 'sum-2', puuid: 'wanted-puuid' }] },
    { data: { summoner: { game_name: 'Other', tagline: 'TAG', league_stats: [] } } },
  ]);
  try {
    await assert.rejects(fetchOpggStats('Wanted#TAG', 'NA1', 'wanted-puuid'), /summary identity did not match/i);
  } finally { mock.restore(); }
});

test('OP.GG lookup rejects an exact Riot ID when PUUID is absent', async () => {
  const mock = mockJsonSequence([
    { data: [{ game_name: 'Wanted', tagline: 'TAG', summoner_id: 'sum-3' }] },
    { data: { summoner: { game_name: 'Wanted', tagline: 'TAG', league_stats: [] } } },
  ]);
  try {
    await assert.rejects(fetchOpggStats('Wanted#TAG', 'NA1', 'wanted-puuid'), /requested PUUID/i);
  } finally { mock.restore(); }
});


test('OP.GG chooses the requested PUUID among duplicate exact Riot IDs in EUNE', async () => {
  const mock = mockJsonSequence([
    { data: [
      { game_name: 'Duplicate', tagline: 'TAG', summoner_id: 'euw-row', puuid: 'wrong-puuid' },
      { game_name: 'Duplicate', tagline: 'TAG', summoner_id: 'eune-row', puuid: 'wanted-puuid' },
    ] },
    { data: { summoner: {
      game_name: 'Duplicate', tagline: 'TAG', summoner_id: 'eune-row', puuid: 'wanted-puuid', league_stats: [],
    } } },
  ]);
  try {
    const result = await fetchOpggStats('Duplicate#TAG', 'EUN1', 'wanted-puuid');
    assert.equal(result.puuid, 'wanted-puuid');
    assert.match(mock.requests[0], /\/eune\/summoners/);
    assert.match(mock.requests[1], /\/summoners\/eune-row\/summary/);
  } finally { mock.restore(); }
});

test('invalid or broad League platform makes zero OP.GG HTTPS requests', async () => {
  const mock = mockJsonByUrl(() => ({ data: [] }));
  try {
    await assert.rejects(fetchOpggStats('Wanted#TAG', 'eu', 'wanted-puuid'), /canonical League platform/i);
    await assert.rejects(fetchOpggStats('Wanted#TAG', 'AP', 'wanted-puuid'), /canonical League platform/i);
    assert.equal(mock.requests.length, 0);
  } finally { mock.restore(); }
});

test('League platform discovery prioritizes a correct verified-platform hint', async () => {
  const mock = mockJsonByUrl(opggFixture('eune'));
  try {
    const result = await discoverOpggStats('Wanted#TAG', 'wanted-puuid', 'EUN1');
    assert.equal(result.platformId, 'EUN1');
    assert.equal(result.platformSource, 'opgg-discovery');
    assert.match(mock.requests[0], /\/eune\/summoners/);
  } finally { mock.restore(); }
});

test('stale platform hint and wrong-PUUID rows fall through to the actual platform', async () => {
  const euw = opggFixture('euw');
  const mock = mockJsonByUrl((href) => {
    if (href.includes('/api/v3/eune/summoners')) {
      return { data: [{ game_name: 'Wanted', tagline: 'TAG', summoner_id: 'wrong-row', puuid: 'wrong-puuid' }] };
    }
    return euw(href);
  });
  try {
    const result = await discoverOpggStats('Wanted#TAG', 'wanted-puuid', 'EUN1');
    assert.equal(result.platformId, 'EUW1');
    assert.equal(result.puuid, 'wanted-puuid');
    assert.equal(mock.requests.some((href) => href.includes('wrong-row/summary')), false);
  } finally { mock.restore(); }
});

test('platform discovery requires PUUID and is bounded to three concurrent allowlisted probes', async () => {
  const mock = mockJsonByUrl(() => ({ data: [] }));
  try {
    await assert.rejects(discoverOpggStats('Wanted#TAG', ''), /expected PUUID/i);
    assert.equal(mock.requests.length, 0);
    await assert.rejects(discoverOpggStats('Wanted#TAG', 'wanted-puuid', '', { timeoutMs: 1000 }), /No League platform matched/i);
    assert.equal(mock.requests.length, LEAGUE_PLATFORMS.length);
    assert.ok(mock.maxActive() <= 3);
  } finally { mock.restore(); }
});

test('owned LCU skin receives its real RP price from a matching store fixture', () => {
  const ownedSkin = { id: 1001, contentId: 'skin-content', ownership: { owned: true } };
  const communityDragon = { 1001: { id: 1001, contentId: 'skin-content', name: 'Fixture Skin' } };
  const storeCatalog = [{ itemId: 'CHAMPION_SKIN_1001', prices: [{ currency: 'RP', cost: 1350 }] }];
  const priced = priceLeagueRecord(ownedSkin, communityDragon, storeCatalog);
  assert.equal(priced.meta.name, 'Fixture Skin');
  assert.equal(priced.store.itemId, 'CHAMPION_SKIN_1001');
  assert.equal(priced.value, 1350);
});

test('skin pricing never invents RP from rarity metadata', () => {
  const priced = priceLeagueRecord({ id: 2002, rarity: 'kLegendary' }, { 2002: { id: 2002, rarity: 'kLegendary' } }, []);
  assert.equal(priced.value, 0);
});