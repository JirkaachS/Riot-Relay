'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const {
  fetchOpggStats, fetchOpggTftStats, discoverOpggStats, discoverOpggTftStats,
  opggRegion, opggProfileUrl, uggProfileUrl, deeplolProfileUrl, dpmProfileUrl,
  LEAGUE_PLATFORMS, normalizeLeaguePlatform, canonicalLeaguePlatform, selectLeaguePlatform,
  leagueWallet, normalizeRankedQueue, priceLeagueRecord,
} = require('../electron/league');
const { vtlProfileUrl, trackerProfileUrl } = require('../electron/valorant');
const {
  RiotClient, parseRiotClientUxProcessRows, resolveRiotClientUxEndpoint,
} = require('../electron/riot');
const { ConfigProfiles } = require('../electron/config-profiles');

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

function mockTextByUrl(resolveValue) {
  const original = https.get;
  const requests = [];
  https.get = (url, _options, callback) => {
    const href = String(url);
    requests.push(href);
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => { if (error) request.emit('error', error); };
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      response.emit('data', Buffer.from(resolveValue(href)));
      response.emit('end');
    });
    return request;
  };
  return { requests, restore: () => { https.get = original; } };
}

function structuredTftHtml(payload) {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></html>`;
}

function flightTftHtml(chunks) {
  const scripts = chunks.map((chunk) => `<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`).join('');
  return `<html>${scripts}</html>`;
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

test('LCU ranked queues omit placeholders while preserving explicit Unranked', () => {
  assert.equal(normalizeRankedQueue({ queueType: 'RANKED_TFT', tier: null, rank: 'NA' }), null);
  assert.equal(normalizeRankedQueue({ queueType: 'RANKED_TFT' }), null);
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
      { game_name: 'Exact Name', tagline: 'TAG', summoner_id: 'sum-1', puuid: 'puuid-1', player_uuid: 'provider-local-value', level: 42 },
    ] },
    { data: { summoner: {
      game_name: 'Exact Name', tagline: 'TAG', summoner_id: 'sum-1', puuid: 'puuid-1', player_uuid: 'different-provider-local-value', level: 43,
      league_stats: [
        { game_type: 'SOLORANKED', tier_info: { tier: 'gold', division: 2, lp: 77 }, win: 12, lose: 8 },
        { game_type: 'FLEXRANKED', tier_info: { tier: null, division: null, lp: null }, win: null, lose: null },
      ],
    } } },
  ]);
  try {
    const result = await fetchOpggStats('Exact Name#TAG', 'EUW1', 'puuid-1');
    assert.equal(result.source, 'opgg');
    assert.equal(result.providerPuuid, 'puuid-1');
    assert.equal(result.riotId, 'Exact Name#TAG');
    assert.equal(result.queues.length, 1);
    assert.deepEqual(result.queues[0], {
      queue: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'II', lp: 77, wins: 12, losses: 8,
    });
    assert.match(mock.requests[0], /riot_id=Exact\+Name%23TAG/);
    assert.match(mock.requests[1], /\/summoners\/sum-1\/summary/);
  } finally { mock.restore(); }
});

test('OP.GG lookup accepts a single exact Riot ID summary on a trusted platform even when the provider PUUID is stale', async () => {
  // Weakened verification: an exact, globally-unique Riot ID on an already
  // trusted platform is accepted; a stale/mismatched OP.GG PUUID no longer
  // rejects it, but it is reported as not corroborated.
  const mock = mockJsonSequence([
    { data: [{ game_name: 'Wanted', tagline: 'TAG', summoner_id: 'sum-2', puuid: 'stale-search-puuid' }] },
    { data: { summoner: { game_name: 'Wanted', tagline: 'TAG', puuid: 'different-puuid', league_stats: [] } } },
  ]);
  try {
    const result = await fetchOpggStats('Wanted#TAG', 'NA1', 'wanted-puuid');
    assert.equal(result.riotId, 'Wanted#TAG');
    assert.equal(result.providerPuuidCorroborated, false);
  } finally { mock.restore(); }
});

test('OP.GG lookup accepts and disambiguates PUUID-less exact Riot ID rows on a trusted platform', async () => {
  const mock = mockJsonSequence([
    { data: [
      { game_name: 'Wanted', tagline: 'TAG', summoner_id: 'stale-sum', puuid: 'stale-search-puuid', player_uuid: 'provider-local-a' },
      { game_name: 'Wanted', tagline: 'TAG', summoner_id: 'sum-3', puuid: 'another-stale-search-puuid', playerUuid: 'provider-local-b' },
    ] },
    { data: { summoner: { game_name: 'Other', tagline: 'TAG', player_uuid: 'provider-local-c', league_stats: [] } } },
    { data: { summoner: { game_name: 'Wanted', tagline: 'TAG', player_uuid: 'provider-local-d', league_stats: [] } } },
  ]);
  try {
    const result = await fetchOpggStats('Wanted#TAG', 'NA1', 'wanted-puuid');
    assert.equal(result.providerPuuid, null);
    assert.equal(result.riotId, 'Wanted#TAG');
    assert.equal(mock.requests.length, 3);
  } finally { mock.restore(); }
});


test('OP.GG summary PUUID selects the requested identity despite stale search rows', async () => {
  const mock = mockJsonSequence([
    { data: [
      { game_name: 'Duplicate', tagline: 'TAG', summoner_id: 'euw-row', puuid: 'wanted-puuid' },
      { game_name: 'Duplicate', tagline: 'TAG', summoner_id: 'eune-row', puuid: 'wrong-search-puuid' },
    ] },
    { data: { summoner: {
      game_name: 'Duplicate', tagline: 'TAG', summoner_id: 'euw-row', puuid: 'wrong-summary-puuid', league_stats: [],
    } } },
    { data: { summoner: {
      game_name: 'Duplicate', tagline: 'TAG', summoner_id: 'eune-row', puuid: 'wanted-puuid', league_stats: [],
    } } },
  ]);
  try {
    const result = await fetchOpggStats('Duplicate#TAG', 'EUN1', 'wanted-puuid');
    assert.equal(result.providerPuuid, 'wanted-puuid');
    assert.match(mock.requests[0], /\/eune\/summoners/);
    assert.match(mock.requests[1], /\/summoners\/euw-row\/summary/);
    assert.match(mock.requests[2], /\/summoners\/eune-row\/summary/);
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

test('stale platform hint and search-row PUUID cannot satisfy discovery', async () => {
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
    assert.equal(result.providerPuuid, 'wanted-puuid');
    assert.equal(mock.requests.some((href) => href.includes('wrong-row/summary')), true);
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


test('OP.GG League adapts bounded nested envelopes and object-shaped league stats', async () => {
  const mock = mockJsonSequence([
    { response: { data: { results: [
      { riot_id: 'Nested Name#TAG', summonerId: 'nested-summoner', player_uuid: 'not-riot-evidence' },
    ] } } },
    { payload: { content: { profile: {
      riotId: 'Nested Name#TAG', PUUID: 'nested-puuid',
      leagueStats: {
        SOLORANKED: { currentSeason: { tierInfo: { tier: 'emerald', division: 3, lp: 61 }, wins: 9, losses: 4 } },
        FLEXRANKED: { current: { tierInfo: { tier: null } } },
      },
    } } } },
  ]);
  try {
    const result = await fetchOpggStats('Nested Name#TAG', 'EUW1', 'nested-puuid');
    assert.equal(result.providerPuuid, 'nested-puuid');
    assert.deepEqual(result.queues, [{
      queue: 'RANKED_SOLO_5x5', tier: 'EMERALD', division: 'III', lp: 61, wins: 9, losses: 4,
    }]);
  } finally { mock.restore(); }
});

test('OP.GG TFT parses structured profile payload queue maps and ignores unrelated queue data', async () => {
  const html = structuredTftHtml({ pageProps: {
    unrelated: { queues: { RANKED_TFT: { current: { tier: 'challenger', division: 1, lp: 999 } } } },
    profile: {
      riot_id: 'Redacted Name#TAG', puuid: 'tft-puuid', player_uuid: 'provider-local-only',
      queueMap: {
        RANKED_TFT: { current: { tier: 'diamond', division: 2, lp: 44, wins: 7, losses: 3 } },
        RANKED_TFT_DOUBLE_UP: { currentSeason: { tier: 'gold', division: 4, lp: 12 } },
      },
    },
  } });
  const mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Redacted Name#TAG', 'NA1', 'tft-puuid');
    assert.equal(result.providerPuuid, 'tft-puuid');
    assert.deepEqual(result.queues, [
      { queue: 'RANKED_TFT', tier: 'DIAMOND', division: 'II', lp: 44, wins: 7, losses: 3 },
      { queue: 'RANKED_TFT_DOUBLE_UP', tier: 'GOLD', division: 'IV', lp: 12, wins: null, losses: null },
    ]);
  } finally { mock.restore(); }
});

test('OP.GG TFT resolves same-page cross-script React Flight rank references', async () => {
  const html = flightTftHtml([
    'a:{"pageProps":{"profile":{"riot_id":"Flight Name#TAG","puuid":"flight-puuid","entry":"$b","previousSeasons":{"RANKED_TFT":[{"seasonId":"set-12","tier":"emerald","division":1,"lp":20}]}}}}\n',
    'b:{"RANKED_TFT":{"current":{"tier":"diamond","rank":"II","leaguePoints":44,"wins":7,"losses":3}}}\n',
  ]);
  const mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Flight Name#TAG', 'NA1', 'flight-puuid');
    assert.equal(result.providerPuuid, 'flight-puuid');
    assert.deepEqual(result.queues, [
      { queue: 'RANKED_TFT', tier: 'DIAMOND', division: 'II', lp: 44, wins: 7, losses: 3 },
    ]);
    assert.deepEqual(result.pastSeasons, [
      { seasonId: 'set-12', queue: 'RANKED_TFT', tier: 'EMERALD', division: 'I', lp: 20, wins: null, losses: null },
    ]);
  } finally { mock.restore(); }
});

test('OP.GG TFT resolves identity-bearing JSON strings nested in React Flight records', async () => {
  const profileFragment = JSON.stringify({ pageProps: { profile: {
    riot_id: 'Flight Name#TAG', puuid: 'flight-puuid', entry: '$b',
  } } });
  const rank = { RANKED_TFT: { current: {
    tier: 'diamond', rank: 'II', leaguePoints: 73, wins: 11, losses: 4,
  } } };
  const unrelatedRankFragment = JSON.stringify({ RANKED_TFT: { current: {
    tier: 'challenger', rank: 'I', leaguePoints: 999, wins: 50, losses: 1,
  } } });
  const html = flightTftHtml([
    `a:${JSON.stringify({ routeData: profileFragment })}\n`,
    `b:${JSON.stringify(rank)}\n`,
    `c:${JSON.stringify(unrelatedRankFragment)}\n`,
  ]);
  const mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Flight Name#TAG', 'NA1', 'flight-puuid');
    assert.equal(result.providerPuuid, 'flight-puuid');
    assert.deepEqual(result.queues, [
      { queue: 'RANKED_TFT', tier: 'DIAMOND', division: 'II', lp: 73, wins: 11, losses: 4 },
    ]);
  } finally { mock.restore(); }
});

test('OP.GG TFT resolves identity-bearing non-JSON raw Flight chunks without attaching raw ranks', async () => {
  const profile = { profile: {
    riot_id: 'Raw Flight Name#TAG', puuid: 'raw-flight-puuid', entry: '$b',
  } };
  const rank = { RANKED_TFT: { current: {
    tier: 'emerald', rank: 'III', leaguePoints: 86, wins: 14, losses: 6,
  } } };
  const unrelatedRawRank = { RANKED_TFT: { current: {
    tier: 'challenger', rank: 'I', leaguePoints: 999, wins: 50, losses: 1,
  } } };
  const html = flightTftHtml([
    `a:T${JSON.stringify(profile)}\n`,
    `b:${JSON.stringify(rank)}\n`,
    JSON.stringify(unrelatedRawRank),
  ]);
  const mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Raw Flight Name#TAG', 'NA1', 'raw-flight-puuid');
    assert.equal(result.providerPuuid, 'raw-flight-puuid');
    assert.deepEqual(result.queues, [
      { queue: 'RANKED_TFT', tier: 'EMERALD', division: 'III', lp: 86, wins: 14, losses: 6 },
    ]);
  } finally { mock.restore(); }
});

test('OP.GG TFT resolves valid Flight profile fields despite unrelated broken child references', async () => {
  const html = flightTftHtml([
    'a:{"profile":{"riot_id":"Flight Name#TAG","puuid":"flight-puuid","unrelated":{"missing":"$dead","cyclic":"$c","unsafe":"$e:__proto__","items":["$dead","$c","$e:constructor"]},"entry":"$b"}}\n',
    'b:{"RANKED_TFT":{"current":{"tier":"diamond","rank":"II","leaguePoints":44,"wins":7,"losses":3}}}\n',
    'c:"$d"\n',
    'd:"$c"\n',
    'e:{"safe":"opaque"}\n',
  ]);
  const mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Flight Name#TAG', 'NA1', 'flight-puuid');
    assert.equal(result.providerPuuid, 'flight-puuid');
    assert.deepEqual(result.queues, [
      { queue: 'RANKED_TFT', tier: 'DIAMOND', division: 'II', lp: 44, wins: 7, losses: 3 },
    ]);
  } finally { mock.restore(); }
});

test('OP.GG TFT resolves a bounded 93-character outlined React Flight model reference', async () => {
  const segments = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(28)];
  const entry = `$b:${segments.join(':')}`;
  assert.equal(entry.length, 93);
  const rank = { RANKED_TFT: { current: {
    tier: 'master', rank: 'I', leaguePoints: 417, wins: 31, losses: 12,
  } } };
  const outlined = { [segments[0]]: { [segments[1]]: { [segments[2]]: rank } } };
  const html = flightTftHtml([
    `a:${JSON.stringify({ profile: { riot_id: 'Flight Name#TAG', puuid: 'flight-puuid', entry } })}\n`,
    `b:${JSON.stringify(outlined)}\n`,
  ]);
  const mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Flight Name#TAG', 'NA1', 'flight-puuid');
    assert.equal(result.providerPuuid, 'flight-puuid');
    assert.deepEqual(result.queues, [
      { queue: 'RANKED_TFT', tier: 'MASTER', division: 'I', lp: 417, wins: 31, losses: 12 },
    ]);
  } finally { mock.restore(); }
});

test('OP.GG TFT lazily resolves a 14-segment path through a large Flight backing model', async () => {
  const segments = Array.from({ length: 14 }, (_, index) => `segment${index}`);
  const rank = { RANKED_TFT: { current: {
    tier: 'master', rank: 'I', leaguePoints: 512, wins: 41, losses: 19,
  } } };
  let continuation = '$f';
  for (let index = segments.length - 1; index >= 1; index -= 1) {
    continuation = { [segments[index]]: continuation };
  }
  let deepBranch = 'ignored';
  for (let depth = 0; depth < 18; depth += 1) deepBranch = { next: deepBranch };
  const backing = {
    [segments[0]]: '$e',
    unrelated: Array.from({ length: 40 }, (_, group) => (
      Array.from({ length: 60 }, (_, item) => group * 60 + item)
    )),
    unresolved: '$dead',
    cyclic: '$c',
    deepBranch,
  };
  const html = flightTftHtml([
    `a:${JSON.stringify({ profile: {
      riot_id: 'Flight Name#TAG', puuid: 'flight-puuid', entry: `$b:${segments.join(':')}`,
    } })}\n`,
    `b:${JSON.stringify(backing)}\n`,
    `e:${JSON.stringify(continuation)}\n`,
    `f:${JSON.stringify(rank)}\n`,
    'c:"$d"\n',
    'd:"$c"\n',
  ]);
  const mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Flight Name#TAG', 'NA1', 'flight-puuid');
    assert.equal(result.providerPuuid, 'flight-puuid');
    assert.deepEqual(result.queues, [
      { queue: 'RANKED_TFT', tier: 'MASTER', division: 'I', lp: 512, wins: 41, losses: 19 },
    ]);
  } finally { mock.restore(); }
});

test('OP.GG TFT rejects unsafe, missing, cyclic, and excessive outlined Flight paths', async () => {
  const rank = { RANKED_TFT: { current: { tier: 'challenger', rank: 'I', leaguePoints: 999 } } };
  const ownPrototypeKeys = JSON.parse('{"__proto__":{},"prototype":{},"constructor":{}}');
  ownPrototypeKeys.__proto__ = rank;
  ownPrototypeKeys.prototype = rank;
  ownPrototypeKeys.constructor = rank;
  const fixtures = [
    { entry: '$b:missing', record: rank },
    { entry: '$b:items:00', record: { items: [rank] } },
    { entry: '$b:__proto__', record: ownPrototypeKeys },
    { entry: '$b:prototype', record: ownPrototypeKeys },
    { entry: '$b:constructor', record: ownPrototypeKeys },
    { entry: `$b:${Array.from({ length: 25 }, () => 'key').join(':')}`, record: rank },
    { entry: `$b:${'x'.repeat(65)}`, record: rank },
    { entry: `$b:${Array.from({ length: 9 }, () => 'x'.repeat(64)).join(':')}`, record: rank },
    { entry: '$b:invalid!', record: rank },
    { entry: '$b:next', record: { next: '$b:next', rank } },
    { entry: '$L1', record: rank },
    { entry: '$@1', record: rank },
    { entry: '$I1', record: rank },
  ];
  for (const fixture of fixtures) {
    const html = flightTftHtml([
      `a:${JSON.stringify({ profile: { riot_id: 'Flight Name#TAG', puuid: 'flight-puuid', entry: fixture.entry } })}\n`,
      `b:${JSON.stringify(fixture.record)}\n`,
      `1:${JSON.stringify(rank)}\n`,
    ]);
    const mock = mockTextByUrl(() => html);
    try {
      const result = await fetchOpggTftStats('Flight Name#TAG', 'NA1', 'flight-puuid');
      assert.equal(result.providerPuuid, 'flight-puuid');
      assert.deepEqual(result.queues, [], fixture.entry);
    } finally { mock.restore(); }
  }
});

test('OP.GG TFT scans past irrelevant React Flight roots for an exact-PUUID profile', async () => {
  const irrelevant = Array.from({ length: 101 }, (_, index) => (
    `${(index + 16).toString(16)}:${JSON.stringify({ routeData: { index } })}`
  ));
  const html = flightTftHtml([[
    ...irrelevant,
    'f0:{"pageProps":{"profile":{"riot_id":"Flight Name#TAG","puuid":"flight-puuid","entry":"$f1"}}}',
    'f1:{"RANKED_TFT":{"current":{"tier":"master","rank":"I","leaguePoints":321,"wins":40,"losses":20}}}',
  ].join('\n')]);
  const mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Flight Name#TAG', 'NA1', 'flight-puuid');
    assert.equal(result.providerPuuid, 'flight-puuid');
    assert.deepEqual(result.queues, [
      { queue: 'RANKED_TFT', tier: 'MASTER', division: 'I', lp: 321, wins: 40, losses: 20 },
    ]);
  } finally { mock.restore(); }
});

test('OP.GG TFT gives later identity roots an independent Flight resolve budget', async () => {
  const unrelated = Array.from({ length: 108 }, (_, index) => {
    let nested = {
      values: Array.from({ length: 80 }, (_, valueIndex) => `noise-${index}-${valueIndex}`),
    };
    for (let depth = 0; depth < 20; depth += 1) nested = { depth, next: nested };
    return `${(index + 0x100).toString(16)}:${JSON.stringify({ routeData: nested })}`;
  });
  const html = flightTftHtml([[
    ...unrelated,
    'f0:{"pageProps":{"profile":{"riot_id":"Flight Name#TAG","puuid":"flight-puuid","entry":"$f1"}}}',
    'f1:{"RANKED_TFT":{"current":{"tier":"master","rank":"I","leaguePoints":654,"wins":45,"losses":21}}}',
  ].join('\n')]);
  const mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Flight Name#TAG', 'NA1', 'flight-puuid');
    assert.equal(result.providerPuuid, 'flight-puuid');
    assert.deepEqual(result.queues, [
      { queue: 'RANKED_TFT', tier: 'MASTER', division: 'I', lp: 654, wins: 45, losses: 21 },
    ]);
  } finally { mock.restore(); }
});

test('OP.GG TFT leaves unresolved and cyclic React Flight references unranked', async () => {
  const fixtures = [
    flightTftHtml([
      'a:{"profile":{"riot_id":"Flight Name#TAG","puuid":"flight-puuid","entry":"$dead"}}\n',
    ]),
    flightTftHtml([
      'a:{"profile":{"riot_id":"Flight Name#TAG","puuid":"flight-puuid","entry":"$b"}}\n',
      'b:"$a"\n',
    ]),
  ];
  for (const html of fixtures) {
    const mock = mockTextByUrl(() => html);
    try {
      const result = await fetchOpggTftStats('Flight Name#TAG', 'NA1', 'flight-puuid');
      assert.deepEqual(result.queues, []);
    } finally { mock.restore(); }
  }
});

test('OP.GG TFT does not attach unrelated React Flight rank records', async () => {
  const html = flightTftHtml([
    'a:{"profile":{"riot_id":"Flight Name#TAG","puuid":"flight-puuid","entry":"$b"}}\n',
    'b:{"metadata":{"label":"profile-only"}}\n',
    'c:{"RANKED_TFT":{"current":{"tier":"challenger","rank":"I","leaguePoints":999,"wins":50,"losses":1}}}\n',
  ]);
  const mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Flight Name#TAG', 'NA1', 'flight-puuid');
    assert.equal(result.providerPuuid, 'flight-puuid');
    assert.deepEqual(result.queues, []);
  } finally { mock.restore(); }
});

test('OP.GG TFT fails closed on multiple uncorroborated explicit Riot PUUIDs', async () => {
  // Repeated route/Flight representations are coalesced, but two distinct
  // explicit Riot PUUIDs for the same Riot ID remain genuinely ambiguous.
  const html = structuredTftHtml({ profiles: [
    { riot_id: 'Redacted#TAG', puuid: 'wrong-puuid-a', queues: {} },
    { riot_id: 'Redacted#TAG', puuid: 'wrong-puuid-b', queues: {} },
  ] });
  const mock = mockTextByUrl(() => html);
  try {
    await assert.rejects(fetchOpggTftStats('Redacted#TAG', 'EUW1', 'wanted-puuid'), /ambiguous duplicate exact Riot ID profiles/i);
  } finally { mock.restore(); }
});

test('OP.GG TFT safely merges repeated profile representations and excludes an explicit PUUID mismatch', async () => {
  const repeatedRank = { current: { tier: 'diamond', division: 2, lp: 44, wins: 7, losses: 3 } };
  const routeRank = { current: { tier: 'platinum', division: 3, lp: 12, wins: 5, losses: 4 } };
  const html = structuredTftHtml({ profiles: [
    {
      matchStat: { queues: { RANKED_TFT: { current: { tier: 'challenger', division: 1, lp: 999 } } } },
      ranking: { RANKED_TFT: repeatedRank },
      summoner: {
        gameName: 'Redacted', tagLine: 'TAG', puuid: 'wanted-puuid',
        entry: { RANKED_TFT: repeatedRank },
        previousSeasons: { RANKED_TFT: [{ seasonId: 'set-12', tier: 'emerald', division: 1, lp: 20 }] },
      },
    },
    {
      matchStat: { queues: { RANKED_TFT: { current: { tier: 'iron', division: 4, lp: 0 } } } },
      ranking: { RANKED_TFT: repeatedRank },
      summoner: {
        gameName: 'Redacted', tagLine: 'TAG', puuid: 'wanted-puuid',
        entry: { RANKED_TFT: repeatedRank },
        previousSeasons: { RANKED_TFT: [{ seasonId: 'set-12', tier: 'emerald', division: 1, lp: 20 }] },
      },
    },
    {
      gameName: 'Redacted', tagLine: 'TAG', puuid: 'explicitly-wrong-puuid',
      queues: { RANKED_TFT: { current: { tier: 'challenger', division: 1, lp: 999 } } },
    },
    {
      gameName: 'Redacted', tagLine: 'TAG', region: 'euw',
      ranking: { RANKED_TFT_DOUBLE_UP: routeRank },
    },
  ] });
  const mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Redacted#TAG', 'EUW1', 'wanted-puuid');
    assert.equal(result.providerPuuid, 'wanted-puuid');
    assert.deepEqual(result.queues, [
      { queue: 'RANKED_TFT', tier: 'DIAMOND', division: 'II', lp: 44, wins: 7, losses: 3 },
      { queue: 'RANKED_TFT_DOUBLE_UP', tier: 'PLATINUM', division: 'III', lp: 12, wins: 5, losses: 4 },
    ]);
    assert.deepEqual(result.pastSeasons, [
      { seasonId: 'set-12', queue: 'RANKED_TFT', tier: 'EMERALD', division: 'I', lp: 20, wins: null, losses: null },
    ]);
  } finally { mock.restore(); }
});

test('OP.GG TFT coalesces repeated PUUID-less exact profile representations', async () => {
  const html = structuredTftHtml({ profiles: [
    { riot_id: 'Redacted#TAG', queues: {} },
    { game_name: 'Redacted', tag_line: 'TAG', player_uuid: 'provider-local-only', queues: {} },
  ] });
  const mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Redacted#TAG', 'EUW1', 'wanted-puuid');
    assert.equal(result.providerPuuid, null);
    assert.deepEqual(result.queues, []);
  } finally { mock.restore(); }
});

test('OP.GG TFT rejects conflicting current records across repeated same-PUUID profiles', async () => {
  const html = structuredTftHtml({ profiles: [
    {
      riot_id: 'Redacted#TAG', puuid: 'wanted-puuid',
      queues: { RANKED_TFT: { current: { tier: 'gold', division: 1, lp: 20 } } },
    },
    {
      riot_id: 'Redacted#TAG', puuid: 'wanted-puuid',
      queues: { RANKED_TFT: { current: { tier: 'silver', division: 1, lp: 20 } } },
    },
  ] });
  const mock = mockTextByUrl(() => html);
  try {
    await assert.rejects(fetchOpggTftStats('Redacted#TAG', 'EUW1', 'wanted-puuid'), /ambiguous current RANKED_TFT/i);
  } finally { mock.restore(); }
});

test('PUUID-less TFT stats require one exact profile and cannot satisfy platform discovery', async () => {
  const html = structuredTftHtml({ profile: {
    riot_id: 'Redacted#TAG', player_uuid: 'provider-local-only',
    queues: { RANKED_TFT: { current: { tier: 'platinum', division: 3, lp: 8 } } },
  } });
  let mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Redacted#TAG', 'EUW1', 'wanted-puuid');
    assert.equal(result.providerPuuid, null);
    assert.equal(result.queues[0].tier, 'PLATINUM');
  } finally { mock.restore(); }

  mock = mockTextByUrl(() => html);
  try {
    // The identical uncorroborated profile appears on every platform, so its
    // region cannot be uniquely determined and discovery must fail closed.
    await assert.rejects(
      discoverOpggTftStats('Redacted#TAG', 'wanted-puuid', 'EUW1', { timeoutMs: 2000 }),
      /multiple platforms|could not be uniquely determined/i,
    );
    assert.equal(mock.requests.length, LEAGUE_PLATFORMS.length);
  } finally { mock.restore(); }
});


test('Riot Client UX process parsing keeps port and token on one trusted process row', () => {
  const endpoint = parseRiotClientUxProcessRows(JSON.stringify([
    {
      ProcessId: 41,
      ExecutablePath: 'C:\\Riot Games\\Riot Client\\RiotClientElectron\\Riot Client.exe',
      CommandLine: '"C:\\Riot Games\\Riot Client\\RiotClientElectron\\Riot Client.exe" --app-port=54321 --remoting-auth-token=test_token_123',
    },
    {
      ProcessId: 42,
      ExecutablePath: 'C:\\Riot Games\\Riot Client\\RiotClientElectron\\Riot Client.exe',
      CommandLine: '"C:\\Riot Games\\Riot Client\\RiotClientElectron\\Riot Client.exe" --type=renderer',
    },
  ]));
  assert.deepEqual(endpoint, { port: 54321, token: 'test_token_123', pid: 41 });

  assert.throws(() => parseRiotClientUxProcessRows(JSON.stringify([
    {
      ProcessId: 41,
      ExecutablePath: 'C:\\Riot Games\\Riot Client\\RiotClientElectron\\Riot Client.exe',
      CommandLine: 'RiotClient.exe --app-port=54321',
    },
    {
      ProcessId: 42,
      ExecutablePath: 'C:\\Riot Games\\Riot Client\\RiotClientElectron\\Riot Client.exe',
      CommandLine: 'RiotClient.exe --remoting-auth-token=test_token_123',
    },
  ])), /UX is not ready/i);
});

test('Riot Client UX resolver uses a fixed bounded process query and redacts failures', async () => {
  const privateMarker = 'private_process_output_marker';
  let invocation;
  await assert.rejects(resolveRiotClientUxEndpoint((file, args, options, callback) => {
    invocation = { file, args, options };
    callback(new Error(privateMarker), privateMarker, privateMarker);
  }), (error) => {
    assert.doesNotMatch(error.message, new RegExp(privateMarker));
    return true;
  });
  assert.equal(invocation.file, 'powershell.exe');
  assert.deepEqual(invocation.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.timeout, 6000);
  assert.equal(invocation.options.maxBuffer, 256 * 1024);
});

test('player-preferences UX transport is loopback-only, allowlisted, and redacts response bodies', async () => {
  const client = new RiotClient();
  const endpoint = { port: 54321, token: 'test_token_123', pid: 41 };
  const privateMarker = 'private_settings_response_marker';
  const original = https.request;
  let requested;
  https.request = (options, callback) => {
    requested = options;
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => {};
    req.end = () => process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 500;
      response.headers = {};
      response.destroy = () => {};
      callback(response);
      response.emit('data', Buffer.from(privateMarker));
      response.emit('end');
    });
    return req;
  };
  try {
    await assert.rejects(
      client.playerPreferencesLocal(endpoint, '/player-preferences/v1/ready'),
      (error) => {
        assert.equal(error.statusCode, 500);
        assert.equal(Object.hasOwn(error, 'body'), false);
        assert.doesNotMatch(error.message, new RegExp(privateMarker));
        return true;
      },
    );
    assert.equal(requested.hostname, '127.0.0.1');
    assert.equal(requested.port, '54321');
    assert.equal(requested.path, '/player-preferences/v1/ready');
    assert.equal(requested.headers.Authorization, `Basic ${Buffer.from('riot:test_token_123').toString('base64')}`);
    await assert.rejects(
      client.playerPreferencesLocal(endpoint, '/product-session/v1/external-sessions'),
      /unsupported player-preferences request path/i,
    );
  } finally { https.request = original; }
});

test('VALORANT player preferences discover the UX caller route with GET requests only', async () => {
  const client = new RiotClient();
  const endpoint = { port: 54321, token: 'test_token_123', pid: 41 };
  const calls = [];
  client._resolvePlayerPreferencesEndpoint = async () => endpoint;
  client.playerPreferencesLocal = async (actualEndpoint, pathname, options = {}) => {
    assert.equal(actualEndpoint, endpoint);
    calls.push([options.method || 'GET', pathname]);
    if (pathname === '/player-preferences/v1/ready') return true;
    if (pathname === '/player-preferences/v1/data-json/Ares.PlayerSettings') {
      return { type: 'Ares.PlayerSettings', modified: 12, data: { sensitivity: 0.42 } };
    }
    const error = new Error('route unavailable');
    error.statusCode = 404;
    throw error;
  };

  const result = await client.getPlayerSettings();
  assert.deepEqual(JSON.parse(result.json), { sensitivity: 0.42 });
  assert.equal(result.path, '/player-preferences/v1/data-json/Ares.PlayerSettings');
  assert.deepEqual(calls, [
    ['GET', '/player-preferences/v1/ready'],
    ['GET', '/player-preferences/v1/data-json/productId/valorant/type/Ares.PlayerSettings'],
    ['GET', '/player-preferences/v1/data-json/Ares.PlayerSettings'],
  ]);
  assert.equal(calls.some(([method]) => method === 'PUT'), false);
});

test('VALORANT player preferences unwrap Riot envelopes and migrate legacy backups safely', async () => {
  const client = new RiotClient();
  const endpoint = { port: 54321, token: 'test_token_123', pid: 41 };
  const settings = { sensitivity: 0.55, crosshair: { color: 'green' } };
  const legacyBackup = JSON.stringify({ type: 'Ares.PlayerSettings', modified: 10, data: settings });
  const route = '/player-preferences/v1/data-json/Ares.PlayerSettings';
  const writes = [];
  const stages = [];
  client._resolvePlayerPreferencesEndpoint = async () => endpoint;
  client.playerPreferencesLocal = async (actualEndpoint, pathname, options = {}) => {
    assert.equal(actualEndpoint, endpoint);
    if (pathname === '/player-preferences/v1/ready') return true;
    if (pathname === route && options.method === 'PUT') { writes.push(options.body); return {}; }
    if (pathname === route) return { type: 'Ares.PlayerSettings', modified: 11, data: settings };
    const error = new Error('missing'); error.statusCode = 404; throw error;
  };

  assert.deepEqual(
    client._decodePlayerSettings({ type: 'Ares.PlayerSettings', modified: 12, data: JSON.stringify(settings) }).parsed,
    settings,
  );
  const result = await client.savePlayerSettings(legacyBackup, route, { onStage: (stage) => stages.push(stage) });
  assert.equal(result.verified, true);
  assert.deepEqual(writes, [settings]);
  assert.deepEqual(stages, ['endpoint-ready', 'route-proven', 'put-accepted', 'readback-fetched', 'write-verified']);
});

test('VALORANT player preferences pin one UX endpoint for route proof, one write, and read-back', async () => {
  const client = new RiotClient();
  const endpoint = { port: 54321, token: 'test_token_123', pid: 41 };
  const source = JSON.stringify({ crosshair: { color: 'cyan' }, sensitivity: 0.37 });
  const writes = [];
  let resolutions = 0;
  client._resolvePlayerPreferencesEndpoint = async () => { resolutions += 1; return endpoint; };
  client.playerPreferencesLocal = async (actualEndpoint, pathname, options = {}) => {
    assert.equal(actualEndpoint, endpoint);
    if (pathname === '/player-preferences/v1/ready') return true;
    if (options.method === 'PUT') {
      writes.push({ pathname, body: options.body });
      assert.equal(pathname, '/player-preferences/v1/data/Ares.PlayerSettings');
      assert.equal(typeof options.body, 'string');
      assert.equal(options.body, source);
      return {};
    }
    if (pathname === '/player-preferences/v1/data/Ares.PlayerSettings') return source;
    const error = new Error('missing');
    error.statusCode = 404;
    throw error;
  };

  const result = await client.savePlayerSettings(source);
  assert.deepEqual(result, {
    saved: true,
    verified: true,
    path: '/player-preferences/v1/data/Ares.PlayerSettings',
  });
  assert.equal(resolutions, 1);
  assert.equal(writes.length, 1);
});

test('VALORANT player-preferences failures do not expose private response data', async () => {
  const client = new RiotClient();
  const privateMarker = 'private_response_marker';
  client._resolvePlayerPreferencesEndpoint = async () => ({ port: 54321, token: 'test_token_123', pid: 41 });
  client.playerPreferencesLocal = async (_endpoint, pathname) => {
    if (pathname === '/player-preferences/v1/ready') return true;
    const error = new Error(`local request failed ${privateMarker}`);
    error.statusCode = pathname.includes('/productId/') ? 404 : 500;
    error.body = `private body ${privateMarker}`;
    throw error;
  };

  await assert.rejects(client.getPlayerSettings(), (error) => {
    assert.match(error.message, /server error/i);
    assert.doesNotMatch(error.message, new RegExp(privateMarker));
    return true;
  });
});

test('VALORANT settings stop after a successful PUT when read-back does not match', async () => {
  const client = new RiotClient();
  const endpoint = { port: 54321, token: 'test_token_123', pid: 41 };
  let writes = 0;
  client._resolvePlayerPreferencesEndpoint = async () => endpoint;
  client.playerPreferencesLocal = async (actualEndpoint, pathname, options = {}) => {
    assert.equal(actualEndpoint, endpoint);
    if (pathname === '/player-preferences/v1/ready') return true;
    if (options.method === 'PUT') { writes += 1; return {}; }
    if (pathname === '/player-preferences/v1/data-json/Ares.PlayerSettings') return { sensitivity: 0.9 };
    const error = new Error(`Unexpected fallback after accepted write: ${pathname}`);
    error.statusCode = 404;
    throw error;
  };

  await assert.rejects(
    client.savePlayerSettings(JSON.stringify({ sensitivity: 0.3 })),
    /read-back value did not match/i,
  );
  assert.equal(writes, 1);
});

test('VALORANT settings reject non-object and UTF-8 oversized documents before endpoint discovery', async () => {
  const client = new RiotClient();
  let resolutions = 0;
  client._resolvePlayerPreferencesEndpoint = async () => { resolutions += 1; return null; };

  await assert.rejects(client.savePlayerSettings('[]'), /valid settings document/i);
  await assert.rejects(
    client.savePlayerSettings(JSON.stringify({ value: 'é'.repeat(4 * 1024 * 1024) })),
    /unexpectedly large/i,
  );
  assert.equal(resolutions, 0);
});

test('VALORANT local-file migration stays disabled while validated cloud state remains available', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riot-relay-cloud-profile-'));
  const account = { id: 'cloud-account', puuid: '11111111-2222-3333-4444-555555555555' };
  const other = { id: 'cloud-target', puuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  const profiles = new ConfigProfiles(dir, { localAppData: path.join(dir, 'local') });
  const route = '/player-preferences/v1/data-json/Ares.PlayerSettings';
  try {
    assert.throws(() => profiles.capture(account, 'valorant'), /cloud settings migration/i);
    assert.throws(() => profiles.migrate(account, other, 'valorant'), /cloud settings migration/i);
    assert.equal(profiles.hasBinding(account, 'valorant'), false);

    profiles.saveCloudSettings(account, JSON.stringify({ sensitivity: 0.4 }), route);
    profiles.backupCloudSettings(account, JSON.stringify({ sensitivity: 0.7 }), route);
    assert.equal(profiles.readCloudSettings(account).playerPreferencesPath, route);
    assert.equal(profiles.readCloudBackup(account).playerPreferencesPath, route);
    const status = profiles.status([account])[0];
    assert.equal(status.cloudCaptured, true);
    assert.equal(status.cloudBackupAvailable, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OP.GG TFT resolves outlined paths through initialized Flight element props', async () => {
  const html = flightTftHtml([
    'a:{"profile":{"riot_id":"Flight Name#TAG","puuid":"flight-puuid","entry":"$b:props:ranking"}}\n',
    'b:["$","component",null,{"ranking":{"RANKED_TFT":{"current":{"tier":"diamond","rank":"II","leaguePoints":88,"wins":13,"losses":5}}}}]\n',
  ]);
  const mock = mockTextByUrl(() => html);
  try {
    const result = await fetchOpggTftStats('Flight Name#TAG', 'NA1', 'flight-puuid');
    assert.deepEqual(result.queues, [
      { queue: 'RANKED_TFT', tier: 'DIAMOND', division: 'II', lp: 88, wins: 13, losses: 5 },
    ]);
  } finally { mock.restore(); }
});

test('VALORANT player preferences report an unloaded UX plugin before data routes', async () => {
  const client = new RiotClient();
  const endpoint = { port: 54321, token: 'test_token_123', pid: 41 };
  let dataCalls = 0;
  client._resolvePlayerPreferencesEndpoint = async () => endpoint;
  client.playerPreferencesLocal = async (actualEndpoint, pathname) => {
    assert.equal(actualEndpoint, endpoint);
    if (pathname.includes('/data')) dataCalls += 1;
    const error = new Error('not found');
    error.statusCode = 404;
    throw error;
  };

  await assert.rejects(client.getPlayerSettings(), (error) => {
    assert.equal(error.code, 'PLAYER_PREFERENCES_PLUGIN_UNAVAILABLE');
    assert.match(error.message, /open VALORANT.*main menu/i);
    assert.doesNotMatch(error.message, /caller ID/i);
    return true;
  });
  assert.equal(dataCalls, 0);
});