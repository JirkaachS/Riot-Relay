'use strict';

/**
 * league.js — Inventory for League of Legends & Teamfight Tactics via the
 * League Client (LCU) local API. Requires the League client to be running and
 * signed in. Ownership + names come from the LCU; art comes from Community
 * Dragon (stable, unversioned CDN).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

const LOCKFILE_PATHS = [
  'C:\\Riot Games\\League of Legends\\lockfile',
  'C:\\Program Files\\Riot Games\\League of Legends\\lockfile',
  'C:\\Program Files (x86)\\Riot Games\\League of Legends\\lockfile',
];

const CDRAGON = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default';
const OPGG_API_HOST = 'lol-api-summoner.op.gg';
const REMOTE_MAX_BYTES = 32 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 10000;
const ROMAN_DIVISION = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };
const metadataCache = new Map();

const LEAGUE_PLATFORMS = ['NA1', 'EUW1', 'EUN1', 'KR', 'JP1', 'BR1', 'LA1', 'LA2', 'OC1', 'TR1', 'RU', 'PH2', 'SG2', 'TH2', 'TW2', 'VN2', 'ME1'];
const PLATFORM_ALIASES = {
  na: 'NA1', na1: 'NA1', euw: 'EUW1', euw1: 'EUW1',
  eune: 'EUN1', eun: 'EUN1', eun1: 'EUN1', kr: 'KR', jp: 'JP1', jp1: 'JP1',
  br: 'BR1', br1: 'BR1', lan: 'LA1', la1: 'LA1', las: 'LA2', la2: 'LA2',
  oce: 'OC1', oc1: 'OC1', tr: 'TR1', tr1: 'TR1', ru: 'RU',
  ph: 'PH2', ph2: 'PH2', sg: 'SG2', sg2: 'SG2', th: 'TH2', th2: 'TH2',
  tw: 'TW2', tw2: 'TW2', vn: 'VN2', vn2: 'VN2', me: 'ME1', me1: 'ME1',
};
const OPGG_REGIONS = {
  NA1: 'na', EUW1: 'euw', EUN1: 'eune', KR: 'kr', JP1: 'jp', BR1: 'br',
  LA1: 'lan', LA2: 'las', OC1: 'oce', TR1: 'tr', RU: 'ru', PH2: 'ph',
  SG2: 'sg', TH2: 'th', TW2: 'tw', VN2: 'vn', ME1: 'me',
};

function normalizeLeaguePlatform(region) {
  const value = String(region || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return PLATFORM_ALIASES[value] || null;
}

function canonicalLeaguePlatform(region) {
  const value = String(region || '').trim().toUpperCase();
  return LEAGUE_PLATFORMS.includes(value) ? value : null;
}

function providerRegion(region, provider = 'opgg') {
  const platformId = canonicalLeaguePlatform(region);
  if (!platformId) throw new Error('A verified League platform is required. Sync the account first.');
  return provider === 'ugg' ? platformId.toLowerCase() : OPGG_REGIONS[platformId];
}

const opggRegion = (region) => providerRegion(region, 'opgg');
const uggRegion = (region) => providerRegion(region, 'ugg');
const deeplolRegion = (region) => providerRegion(region, 'deeplol');

function loginPlatformValue(loginData) {
  const packet = loginData && (loginData.LoginDataPacket || loginData.loginDataPacket || loginData);
  return packet && (packet.platformId || packet.platformID || packet.PlatformId || packet.platform);
}

function selectLeaguePlatform(loginData, regionLocale) {
  const loginPlatform = normalizeLeaguePlatform(loginPlatformValue(loginData));
  const localePlatform = normalizeLeaguePlatform(regionLocale && (regionLocale.platformId || regionLocale.region));
  if (loginPlatform && localePlatform && loginPlatform !== localePlatform) {
    return { platformId: null, platformSource: 'lcu-conflict' };
  }
  if (loginPlatform) return { platformId: loginPlatform, platformSource: 'lcu-login-data' };
  if (localePlatform) return { platformId: localePlatform, platformSource: 'lcu-region-locale' };
  return { platformId: null, platformSource: null };
}

function splitRiotId(riotId) {
  const value = String(riotId || '').trim();
  const separator = value.lastIndexOf('#');
  const gameName = separator > 0 ? value.slice(0, separator).trim() : '';
  const tagLine = separator > 0 ? value.slice(separator + 1).trim() : '';
  if (!gameName || !tagLine) throw new Error('A complete Riot ID is required for a League profile lookup.');
  return { gameName, tagLine };
}

function profileSlug(riotId) {
  const { gameName, tagLine } = splitRiotId(riotId);
  return `${encodeURIComponent(gameName)}-${encodeURIComponent(tagLine)}`;
}

function opggProfileUrl(riotId, region) {
  return `https://www.op.gg/summoners/${opggRegion(region)}/${profileSlug(riotId)}`;
}

function uggProfileUrl(riotId, region) {
  return `https://u.gg/lol/profile/${uggRegion(region)}/${profileSlug(riotId)}/overview`;
}

function deeplolProfileUrl(riotId, region) {
  return `https://www.deeplol.gg/summoner/${deeplolRegion(region)}/${profileSlug(riotId)}`;
}

function dpmProfileUrl(riotId) {
  return `https://dpm.lol/${profileSlug(riotId)}`;
}

function profileLinks(riotId, region) {
  return {
    opgg: opggProfileUrl(riotId, region),
    ugg: uggProfileUrl(riotId, region),
    deeplol: deeplolProfileUrl(riotId, region),
    dpm: dpmProfileUrl(riotId),
  };
}

function remoteJson(url, allowedHosts, label) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !allowedHosts.has(target.hostname)) {
      reject(new Error(`${label} requested an untrusted host.`));
      return;
    }
    const req = https.get(target, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) RiotRelay/1.3',
      },
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`${label} returned HTTP ${res.statusCode}.`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > REMOTE_MAX_BYTES) req.destroy(new Error(`${label} response was too large.`));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error(`${label} returned invalid JSON.`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(REMOTE_TIMEOUT_MS, () => req.destroy(new Error(`${label} lookup timed out.`)));
  });
}

function remoteText(url, allowedHosts, label) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !allowedHosts.has(target.hostname)) return reject(new Error(`${label} requested an untrusted host.`));
    const req = https.get(target, { headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.8', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) RiotRelay/1.3' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error(`${label} returned HTTP ${res.statusCode}.`)); return; }
      const chunks = []; let size = 0;
      res.on('data', (chunk) => { size += chunk.length; if (size > REMOTE_MAX_BYTES) req.destroy(new Error(`${label} response was too large.`)); else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(REMOTE_TIMEOUT_MS, () => req.destroy(new Error(`${label} lookup timed out.`)));
  });
}

const PROVIDER_ROW_LIMIT = 100;
const PROVIDER_SEASON_LIMIT = 20;
const PROVIDER_TEXT_LIMIT = 256;

function aliasValue(row, aliases) {
  if (!row || typeof row !== 'object') return undefined;
  for (const key of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

function providerText(value, limit = PROVIDER_TEXT_LIMIT) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim().slice(0, limit);
}

function providerRiotIdentity(row) {
  let gameName = providerText(aliasValue(row, ['game_name', 'gameName']), 128);
  let tagLine = providerText(aliasValue(row, ['tagline', 'tag_line', 'tagLine']), 128);
  const complete = providerText(aliasValue(row, ['riot_id', 'riotId']), 260);
  const separator = complete.lastIndexOf('#');
  if (separator > 0 && separator < complete.length - 1) {
    if (!gameName) gameName = complete.slice(0, separator).trim().slice(0, 128);
    if (!tagLine) tagLine = complete.slice(separator + 1).trim().slice(0, 128);
  }
  return { gameName, tagLine };
}

function providerPuuid(row) {
  // Only OP.GG's explicit Riot PUUID field is identity evidence. Provider-local
  // player_uuid/playerUuid values must never reject direct data or discover a platform.
  return providerText(aliasValue(row, ['puuid', 'PUUID']));
}

function providerSummonerId(row) {
  return providerText(aliasValue(row, ['summoner_id', 'summonerId']));
}

function exactRiotId(row, gameName, tagLine) {
  const identity = providerRiotIdentity(row);
  return identity.gameName.toLowerCase() === gameName.toLowerCase()
    && identity.tagLine.toLowerCase() === tagLine.toLowerCase();
}

const PROVIDER_ENVELOPE_KEYS = [
  'data', 'result', 'response', 'payload', 'content', 'props', 'pageProps', 'dehydratedState', 'state',
];

function explicitProviderEnvelopes(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const envelopes = [];
  const pending = [{ value: payload, depth: 0 }];
  const seen = new Set();
  while (pending.length && envelopes.length < PROVIDER_ROW_LIMIT) {
    const { value, depth } = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    envelopes.push(value);
    if (depth >= 4) continue;
    for (const key of PROVIDER_ENVELOPE_KEYS) {
      const nested = value[key];
      if (nested && typeof nested === 'object') pending.push({ value: nested, depth: depth + 1 });
    }
  }
  return envelopes;
}

function opggSearchRows(payload) {
  for (const envelope of explicitProviderEnvelopes(payload)) {
    const collections = [envelope, envelope.summoners, envelope.items, envelope.results, envelope.rows];
    const rows = collections.find(Array.isArray);
    if (rows) return rows.slice(0, PROVIDER_ROW_LIMIT);
  }
  return null;
}

function opggSummarySummoner(payload) {
  for (const envelope of explicitProviderEnvelopes(payload)) {
    for (const key of ['summoner', 'profile', 'summonerProfile']) {
      if (envelope[key] && typeof envelope[key] === 'object' && !Array.isArray(envelope[key])) {
        const identity = providerRiotIdentity(envelope[key]);
        if (identity.gameName && identity.tagLine) return envelope[key];
      }
    }
    const identity = providerRiotIdentity(envelope);
    if (identity.gameName && identity.tagLine) return envelope;
  }
  return null;
}

function finiteProviderNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const PROVIDER_QUEUE_TYPES = {
  SOLORANKED: 'RANKED_SOLO_5x5',
  RANKED_SOLO_5X5: 'RANKED_SOLO_5x5',
  FLEXRANKED: 'RANKED_FLEX_SR',
  RANKED_FLEX_SR: 'RANKED_FLEX_SR',
  RANKED_TFT: 'RANKED_TFT',
  RANKED_TFT_DOUBLE_UP: 'RANKED_TFT_DOUBLE_UP',
};
const PROVIDER_HISTORY_KEYS = [
  'previous_seasons', 'previousSeasons', 'past_seasons', 'pastSeasons', 'season_history', 'seasonHistory',
  'previous_season_tiers', 'previousSeasonTiers', 'previous_tiers', 'previousTiers', 'past_ranks', 'pastRanks',
  'previous_season', 'previousSeason', 'past_season', 'pastSeason', 'previous_season_tier', 'previousSeasonTier',
];

function providerQueueType(row, fallback = '') {
  const raw = providerText(aliasValue(row, ['game_type', 'gameType', 'queue_type', 'queueType', 'queue', 'queue_id', 'queueId']), 64)
    .toUpperCase();
  return PROVIDER_QUEUE_TYPES[raw] || PROVIDER_QUEUE_TYPES[String(fallback || '').toUpperCase()] || '';
}

function providerRankedQueue(row, fallbackQueue = '') {
  if (!row || typeof row !== 'object') return null;
  const queue = providerQueueType(row, fallbackQueue);
  if (!queue) return null;
  const tierInfo = aliasValue(row, ['tier_info', 'tierInfo']);
  const rank = tierInfo && typeof tierInfo === 'object' ? tierInfo : row;
  const rawTier = aliasValue(rank, ['tier', 'tier_name', 'tierName']) ?? aliasValue(row, ['tier', 'tier_name', 'tierName']);
  // Placeholder queue objects are common in OP.GG/LCU payloads. Only an
  // explicit tier is rank evidence; explicit UNRANKED remains authoritative.
  if (rawTier === undefined || rawTier === null || !String(rawTier).trim()) return null;
  const rawDivision = aliasValue(rank, ['division', 'rank']) ?? aliasValue(row, ['division', 'rank']);
  const numericDivision = Number(rawDivision);
  const division = ROMAN_DIVISION[numericDivision] || providerText(rawDivision, 8).toUpperCase();
  return normalizeRankedQueue({
    queueType: queue,
    tier: aliasValue(rank, ['tier', 'tier_name', 'tierName']) ?? aliasValue(row, ['tier', 'tier_name', 'tierName']),
    division,
    leaguePoints: aliasValue(rank, ['lp', 'league_points', 'leaguePoints', 'ranked_rating', 'rankedRating'])
      ?? aliasValue(row, ['lp', 'league_points', 'leaguePoints', 'ranked_rating', 'rankedRating']),
    wins: aliasValue(row, ['win', 'wins']),
    losses: aliasValue(row, ['lose', 'loss', 'losses']),
  });
}

function providerBoolean(row, aliases) {
  const value = aliasValue(row, aliases);
  if (value === true || value === 1 || String(value).toLowerCase() === 'true') return true;
  if (value === false || value === 0 || String(value).toLowerCase() === 'false') return false;
  return null;
}

function historicalProviderRecord(row) {
  if (!row || typeof row !== 'object') return false;
  if (providerBoolean(row, ['is_current', 'isCurrent', 'current']) === false) return true;
  const status = providerText(aliasValue(row, ['status', 'season_status', 'seasonStatus']), 32).toLowerCase();
  return /^(?:past|previous|historical|finished|ended)$/.test(status);
}

function providerCollectionRows(value, inherited = {}, depth = 0) {
  if (!value || depth > 4) return [];
  if (Array.isArray(value)) {
    return value.slice(0, PROVIDER_ROW_LIMIT).flatMap((row) => providerCollectionRows(row, inherited, depth + 1))
      .slice(0, PROVIDER_ROW_LIMIT);
  }
  if (typeof value !== 'object') return [];
  const looksRanked = aliasValue(value, ['tier', 'tier_name', 'tierName', 'tier_info', 'tierInfo']) !== undefined;
  if (looksRanked) return [{ ...inherited, ...value }];
  const rows = [];
  for (const [key, nested] of Object.entries(value).slice(0, PROVIDER_ROW_LIMIT)) {
    if (!nested || (typeof nested !== 'object' && !Array.isArray(nested))) continue;
    const queue = PROVIDER_QUEUE_TYPES[String(key).toUpperCase()];
    const currentCollection = /^(?:current|current_season|currentSeason)$/i.test(key);
    const historicalCollection = /^(?:history|previous|past|previous_seasons|previousSeasons|past_seasons|pastSeasons)$/i.test(key);
    const genericCollection = /^(?:data|items|rows|seasons|ranking|rankings|entry|entries)$/i.test(key);
    const seasonKey = trustedProviderSeasonId(key);
    let next;
    if (queue) next = { ...inherited, queue_type: inherited.queue_type || queue };
    else if (currentCollection) next = { ...inherited, is_current: true };
    else if (historicalCollection) next = { ...inherited, is_current: false };
    else if (genericCollection) next = inherited;
    else if (seasonKey) next = { ...inherited, season_id: inherited.season_id || seasonKey };
    else next = inherited;
    rows.push(...providerCollectionRows(nested, next, depth + 1));
    if (rows.length >= PROVIDER_ROW_LIMIT) break;
  }
  return rows.slice(0, PROVIDER_ROW_LIMIT);
}

function providerSeasonId(row) {
  const value = aliasValue(row, [
    'season_id', 'seasonId', 'season', 'season_name', 'seasonName', 'display_name', 'displayName', 'act_id', 'actId',
  ]);
  if (value && typeof value === 'object') {
    return providerText(aliasValue(value, ['id', 'season_id', 'seasonId', 'name', 'display_name', 'displayName']), 128);
  }
  return providerText(value, 128);
}

function trustedProviderSeasonId(value) {
  const season = providerText(value, 128);
  return /^(?=.{1,64}$)(?=.*\d)[a-z0-9][a-z0-9 ._-]*$/i.test(season) ? season : '';
}

function providerSeasonOrder(value) {
  const season = String(value || '');
  const year = season.match(/20\d{2}/);
  const numbers = season.match(/\d+/g) || [];
  if (year) return Number(year[0]) * 100 + Number(numbers.find((item) => item !== year[0]) || 0);
  return Number(numbers[0] || 0);
}

function providerHistoryRows(containers, currentRows = []) {
  const rows = [];
  const append = (collection, inherited = {}) => {
    rows.push(...providerCollectionRows(collection, inherited));
  };
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const key of PROVIDER_HISTORY_KEYS) append(container[key]);
  }
  for (const row of currentRows.slice(0, PROVIDER_ROW_LIMIT)) {
    const queue = providerQueueType(row);
    for (const key of PROVIDER_HISTORY_KEYS) append(row && row[key], queue ? { queue_type: queue } : {});
  }
  return rows.slice(0, PROVIDER_ROW_LIMIT);
}

function normalizedPastSeasons(rows, fallbackQueue = '') {
  const seen = new Set();
  const result = [];
  for (const row of rows.slice(0, PROVIDER_ROW_LIMIT)) {
    const rank = providerRankedQueue(row, fallbackQueue);
    if (!rank) continue;
    // OP.GG frequently returns old rank fragments without a season identity.
    // Showing those as numbered "previous seasons" invents chronology, so only
    // retain history that carries a recognizable provider season label.
    const seasonId = trustedProviderSeasonId(providerSeasonId(row));
    if (!seasonId) continue;
    const key = `${seasonId.toLowerCase()}|${rank.queue}|${rank.tier}|${rank.division}|${rank.lp ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ seasonId, ...rank });
    if (result.length >= PROVIDER_SEASON_LIMIT) break;
  }
  return result.sort((left, right) => providerSeasonOrder(right.seasonId) - providerSeasonOrder(left.seasonId));
}

function dedupeCurrentQueues(rows) {
  const queues = new Map();
  const score = (row) => Number(row.tier && row.tier !== 'UNRANKED') * 4
    + Number(Boolean(row.division)) * 2 + Number(row.lp !== null) + Number(row.wins !== null || row.losses !== null);
  for (const row of rows) {
    if (!row || !row.queue) continue;
    const current = queues.get(row.queue);
    if (!current || score(row) > score(current)) queues.set(row.queue, row);
  }
  return [...queues.values()];
}

function opggLeaguePayload(summoner, summary) {
  const containers = [summoner, ...explicitProviderEnvelopes(summary)]
    .filter((value, index, all) => value && typeof value === 'object' && all.indexOf(value) === index);
  const leagueStats = containers.map((value) => aliasValue(value, ['league_stats', 'leagueStats']))
    .find((value) => value && typeof value === 'object');
  const rows = providerCollectionRows(leagueStats || {});
  const explicitlyCurrent = (row) => providerBoolean(row, ['is_current', 'isCurrent', 'current']) === true;
  const hasTrustedSeason = (row) => Boolean(trustedProviderSeasonId(providerSeasonId(row)));
  const currentRows = rows.filter((row) => explicitlyCurrent(row)
    || (!historicalProviderRecord(row) && !hasTrustedSeason(row)));
  const historyRows = rows.filter((row) => historicalProviderRecord(row)
    || (!explicitlyCurrent(row) && hasTrustedSeason(row)));
  historyRows.push(...providerHistoryRows(containers, rows));
  return {
    queues: dedupeCurrentQueues(currentRows.map((row) => providerRankedQueue(row)).filter(Boolean)),
    pastSeasons: normalizedPastSeasons(historyRows, 'RANKED_SOLO_5x5'),
  };
}

function checkedProviderPuuid(rows, expectedPuuid, _label, _options = {}) {
  // Weakened per product decision: an exact, globally-unique Riot ID match on a
  // resolved platform is accepted even when OP.GG's indexed PUUID is stale,
  // absent, or mismatched (common for unlinked/not-recently-updated profiles).
  // We still surface whether the provider PUUID corroborated the identity so
  // callers can prefer a corroborated platform during discovery.
  const wanted = providerText(expectedPuuid).toLowerCase();
  const present = rows.map(providerPuuid).filter(Boolean);
  const matching = present.find((value) => value.toLowerCase() === wanted) || null;
  return { providerPuuid: matching || present[0] || null, corroborated: Boolean(matching) };
}

/** Exact-Riot-ID League rank lookup on an already trusted canonical platform. */
async function fetchOpggStats(riotId, platform, expectedPuuid, options = {}) {
  const platformId = canonicalLeaguePlatform(platform);
  if (!platformId) throw new Error('A canonical League platform is required before contacting OP.GG.');
  const wantedPuuid = providerText(expectedPuuid).toLowerCase();
  if (!wantedPuuid) throw new Error('An expected live PUUID is required for an identity-verified OP.GG lookup.');
  const requireProviderPuuid = options.requireProviderPuuid === true;
  const { gameName, tagLine } = splitRiotId(riotId);
  const regionSlug = OPGG_REGIONS[platformId];
  const searchUrl = new URL(`https://${OPGG_API_HOST}/api/v3/${regionSlug}/summoners`);
  searchUrl.searchParams.set('riot_id', `${gameName}#${tagLine}`);
  searchUrl.searchParams.set('hl', 'en_US');
  const search = await remoteJson(searchUrl, new Set([OPGG_API_HOST]), 'OP.GG');
  const rows = opggSearchRows(search);
  if (!rows) throw new Error('OP.GG search response schema was not recognized.');
  const riotIdMatches = rows.filter((row) => exactRiotId(row, gameName, tagLine));
  if (!riotIdMatches.length) throw new Error('OP.GG did not return an exact match for the requested Riot ID.');
  const identifiedMatches = riotIdMatches.filter((row) => providerSummonerId(row));
  if (!identifiedMatches.length) throw new Error('OP.GG exact Riot ID search rows were missing a usable summoner identifier.');

  const candidates = [...new Map(identifiedMatches.map((row) => [providerSummonerId(row), row])).values()].slice(0, 10);

  const candidateErrors = [];
  const verified = [];
  for (const match of candidates) {
    try {
      const summonerId = providerSummonerId(match);
      const summaryUrl = new URL(`https://${OPGG_API_HOST}/api/${regionSlug}/summoners/${encodeURIComponent(summonerId)}/summary`);
      summaryUrl.searchParams.set('hl', 'en_US');
      const summary = await remoteJson(summaryUrl, new Set([OPGG_API_HOST]), 'OP.GG');
      const summoner = opggSummarySummoner(summary);
      if (!summoner) throw new Error('OP.GG summary response schema was not recognized.');
      if (!exactRiotId(summoner, gameName, tagLine)) throw new Error('OP.GG summary identity did not match the requested Riot ID.');
      // Search rows only locate exact-Riot-ID summary candidates. A matching
      // provider PUUID corroborates the identity; a stale/absent one no longer
      // rejects the exact Riot ID match.
      const puuidCheck = checkedProviderPuuid([summoner], wantedPuuid, 'OP.GG');
      const providerPuuidValue = puuidCheck.providerPuuid;
      const providerPuuidCorroborated = puuidCheck.corroborated;
      const identity = providerRiotIdentity(summoner);
      const level = finiteProviderNumber(aliasValue(summoner, ['level', 'summoner_level', 'summonerLevel']))
        ?? finiteProviderNumber(aliasValue(match, ['level', 'summoner_level', 'summonerLevel']))
        ?? 0;
      const ranked = opggLeaguePayload(summoner, summary);
      verified.push({
        available: true,
        providerPuuid: providerPuuidValue,
        providerPuuidCorroborated,
        riotId: `${identity.gameName}#${identity.tagLine}`,
        platformId,
        level,
        profileIconId: null,
        queues: ranked.queues,
        pastSeasons: ranked.pastSeasons,
        source: 'opgg',
        profileUrl: opggProfileUrl(riotId, platformId),
        approximate: false,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      candidateErrors.push(error && error.message ? error.message : 'OP.GG summary lookup failed.');
    }
  }

  // Prefer a PUUID-corroborated summary; otherwise a single exact Riot ID
  // summary on this platform is accepted (weakened verification).
  const corroborated = verified.filter((value) => value.providerPuuidCorroborated);
  if (corroborated.length === 1) return corroborated[0];
  if (corroborated.length > 1) {
    throw new Error('OP.GG returned multiple corroborated exact Riot ID summaries on the verified platform.');
  }
  if (verified.length === 1) return verified[0];
  if (verified.length > 1) {
    throw new Error('OP.GG returned multiple indistinguishable exact Riot ID summaries on the verified platform.');
  }
  const preferredError = candidateErrors.find((message) => /ambiguous/i.test(message))
    || candidateErrors.find((message) => /schema|identity/i.test(message))
    || candidateErrors[0];
  throw new Error(preferredError || 'OP.GG exact Riot ID matches could not be identity verified.');
}

function extractBalancedObject(text, start, maxLength = 12000) {
  if (start < 0 || text[start] !== '{') return '';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  const endLimit = Math.min(text.length, start + maxLength);
  for (let index = start; index < endLimit; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  return '';
}

function parsedObjectsForKeys(text, keys) {
  const keyPattern = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const matches = text.matchAll(new RegExp(`"(?:${keyPattern})"\\s*:`, 'g'));
  const starts = new Set();
  const objects = [];
  for (const match of matches) {
    let start = text.lastIndexOf('{', match.index);
    for (let attempt = 0; start >= 0 && attempt < 20; attempt += 1) {
      const block = extractBalancedObject(text, start);
      if (block && start + block.length > match.index) {
        if (!starts.has(start)) {
          starts.add(start);
          try {
            const value = JSON.parse(block);
            if (value && typeof value === 'object' && !Array.isArray(value)) objects.push(value);
          } catch { /* Provider fragments outside parseable objects are ignored. */ }
        }
        break;
      }
      start = text.lastIndexOf('{', start - 1);
    }
  }
  return objects.slice(0, PROVIDER_ROW_LIMIT);
}

function parseStructuredJson(value) {
  let current = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (typeof current !== 'string') return current && typeof current === 'object' ? current : null;
    const text = current.trim();
    if (!text || text.length > REMOTE_MAX_BYTES) return null;
    try { current = JSON.parse(text); }
    catch { return null; }
  }
  return current && typeof current === 'object' ? current : null;
}

function structuredStringFragments(root) {
  const fragments = [];
  const pending = [{ value: root, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < PROVIDER_ROW_LIMIT * 5 && fragments.length < PROVIDER_ROW_LIMIT) {
    const { value, depth } = pending.shift();
    visited += 1;
    if (typeof value === 'string') {
      const parsed = parseStructuredJson(value);
      if (parsed) fragments.push(parsed);
      else fragments.push(...parsedObjectsForKeys(value, ['game_name', 'gameName', 'riot_id', 'riotId']));
      continue;
    }
    if (!value || typeof value !== 'object' || depth >= 6) continue;
    const children = Array.isArray(value) ? value.slice(0, PROVIDER_ROW_LIMIT) : Object.values(value).slice(0, PROVIDER_ROW_LIMIT);
    for (const nested of children) pending.push({ value: nested, depth: depth + 1 });
  }
  return fragments.slice(0, PROVIDER_ROW_LIMIT);
}

const FLIGHT_SCRIPT_LIMIT = 500;
const FLIGHT_TOTAL_TEXT_LIMIT = 2 * 1024 * 1024;
const FLIGHT_RECORD_TEXT_LIMIT = 256 * 1024;
const FLIGHT_RECORD_LIMIT = PROVIDER_ROW_LIMIT * 2;
const FLIGHT_VALUE_DEPTH_LIMIT = 24;
const FLIGHT_VALUE_NODE_LIMIT = 5000;
const FLIGHT_RESOLVE_NODE_LIMIT = 10000;
const FLIGHT_REFERENCE_PATH_SEGMENT_LIMIT = 24;
const FLIGHT_REFERENCE_PATH_SEGMENT_LENGTH_LIMIT = 64;
const FLIGHT_REFERENCE_PATH_LENGTH_LIMIT = 512;
const FLIGHT_REFERENCE = /^\$([0-9a-f]{1,8})(?::([\s\S]*))?$/i;
const FLIGHT_FORBIDDEN_PATH_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function parsedFlightReference(value) {
  const reference = value.match(FLIGHT_REFERENCE);
  if (!reference) return null;
  if (reference[2] === undefined) return { id: reference[1].toLowerCase(), segments: [] };
  const path = reference[2];
  const segments = path.split(':');
  if (!path || path.length > FLIGHT_REFERENCE_PATH_LENGTH_LIMIT
    || segments.length > FLIGHT_REFERENCE_PATH_SEGMENT_LIMIT
    || segments.some((segment) => !segment
      || segment.length > FLIGHT_REFERENCE_PATH_SEGMENT_LENGTH_LIMIT
      || !/^[A-Za-z0-9_-]+$/.test(segment)
      || FLIGHT_FORBIDDEN_PATH_KEYS.has(segment))) return { invalid: true };
  return { id: reference[1].toLowerCase(), segments };
}

function outlinedFlightValue(value, segments, records, state, depth) {
  let current = value;
  let currentDepth = depth;
  const traversedReferences = [];
  const failed = () => {
    for (const id of traversedReferences) state.path.delete(id);
    return { ok: false };
  };
  for (const segment of segments) {
    while (typeof current === 'string') {
      state.nodes += 1;
      const reference = parsedFlightReference(current);
      if (state.nodes > FLIGHT_RESOLVE_NODE_LIMIT || currentDepth > FLIGHT_VALUE_DEPTH_LIMIT
        || !reference || reference.invalid || reference.segments.length
        || !records.has(reference.id) || state.path.has(reference.id)) return failed();
      state.path.add(reference.id);
      traversedReferences.push(reference.id);
      current = records.get(reference.id);
      currentDepth += 1;
    }
    state.nodes += 1;
    if (state.nodes > FLIGHT_RESOLVE_NODE_LIMIT || !current || typeof current !== 'object') return failed();
    let property = segment;
    if (Array.isArray(current) && !/^(?:0|[1-9][0-9]*)$/.test(segment)) {
      // React initializes a raw Flight element tuple ["$", type, key, props]
      // before applying outlined property paths. Mirror only those stable,
      // non-executable structural aliases; all other array properties fail
      // closed rather than searching arbitrary descendants.
      if (current.length < 4 || current[0] !== '$') return failed();
      const elementProperties = { type: '1', key: '2', props: '3' };
      property = elementProperties[segment];
      if (property === undefined) return failed();
    }
    if (!Object.prototype.hasOwnProperty.call(current, property)) return failed();
    current = current[property];
  }
  return { ok: true, value: current, depth: currentDepth, traversedReferences };
}

function boundedFlightValue(value) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.shift();
    nodes += 1;
    if (nodes > FLIGHT_VALUE_NODE_LIMIT || current.depth > FLIGHT_VALUE_DEPTH_LIMIT) return false;
    if (!current.value || typeof current.value !== 'object') continue;
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    if (children.length > PROVIDER_ROW_LIMIT) return false;
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}

function boundedFlightPacketStrings(html) {
  const packetStrings = [];
  let totalLength = 0;
  let scriptCount = 0;
  const scripts = String(html || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi);
  for (const match of scripts) {
    scriptCount += 1;
    if (scriptCount > FLIGHT_SCRIPT_LIMIT) return null;
    const body = match[1].trim();
    const push = body.match(/^self\.__next_f\.push\(([\s\S]*)\)\s*;?$/);
    if (!push) continue;
    const packet = parseStructuredJson(push[1]);
    if (!Array.isArray(packet)) continue;
    for (const value of packet.slice(0, 4)) {
      if (typeof value !== 'string') continue;
      totalLength += value.length;
      if (totalLength > FLIGHT_TOTAL_TEXT_LIMIT) return null;
      packetStrings.push(value);
    }
  }
  return packetStrings;
}

function flightRecordMap(packetStrings) {
  const records = new Map();
  const duplicates = new Set();
  for (const line of packetStrings.join('').split('\n')) {
    const record = line.replace(/\r$/, '').match(/^([0-9a-f]{1,8}):([\s\S]+)$/i);
    if (!record) continue;
    if (records.size + duplicates.size >= FLIGHT_RECORD_LIMIT) return null;
    const id = record[1].toLowerCase();
    const json = record[2].trim();
    if (!json || json.length > FLIGHT_RECORD_TEXT_LIMIT) continue;
    let value;
    try { value = JSON.parse(json); }
    catch { continue; }
    if (!boundedFlightValue(value)) continue;
    if (records.has(id) || duplicates.has(id)) {
      records.delete(id);
      duplicates.add(id);
    } else {
      records.set(id, value);
    }
  }
  return records;
}

function resolvedFlightValue(value, records, state, depth) {
  state.nodes += 1;
  if (state.nodes > FLIGHT_RESOLVE_NODE_LIMIT || depth > FLIGHT_VALUE_DEPTH_LIMIT) return { ok: false };
  if (typeof value === 'string') {
    const reference = parsedFlightReference(value);
    if (!reference) return { ok: true, value };
    if (reference.invalid || !records.has(reference.id) || state.path.has(reference.id)) return { ok: false };
    state.path.add(reference.id);
    if (reference.segments.length) {
      const outlined = outlinedFlightValue(records.get(reference.id), reference.segments, records, state, depth + 1);
      const resolved = outlined.ok
        ? resolvedFlightValue(outlined.value, records, state, outlined.depth)
        : outlined;
      for (const id of outlined.traversedReferences || []) state.path.delete(id);
      state.path.delete(reference.id);
      return resolved;
    }
    const resolved = resolvedFlightValue(records.get(reference.id), records, state, depth + 1);
    state.path.delete(reference.id);
    return resolved;
  }
  if (!value || typeof value !== 'object') return { ok: true, value };
  const output = Array.isArray(value) ? [] : {};
  for (const [key, child] of Object.entries(value)) {
    const resolved = resolvedFlightValue(child, records, state, depth + 1);
    Object.defineProperty(output, key, {
      // A broken nested reference is opaque field data, not a reason to discard
      // independently valid siblings (notably an identity root and its entry).
      value: resolved.ok ? resolved.value : child,
      enumerable: true, configurable: true, writable: true,
    });
  }
  return { ok: true, value: output };
}

function flightValueHasProviderIdentity(value) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.shift();
    nodes += 1;
    if (nodes > FLIGHT_VALUE_NODE_LIMIT || current.depth > FLIGHT_VALUE_DEPTH_LIMIT) return false;
    if (!current.value || typeof current.value !== 'object') continue;
    if (!Array.isArray(current.value)) {
      const identity = providerRiotIdentity(current.value);
      if (identity.gameName && identity.tagLine) return true;
    }
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    if (children.length > PROVIDER_ROW_LIMIT) return false;
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }
  return false;
}

function resolvedFlightRoots(html) {
  const packetStrings = boundedFlightPacketStrings(html);
  if (!packetStrings) return [];
  const records = flightRecordMap(packetStrings);
  if (!records) return [];
  const roots = [];
  const candidateObjects = new Set();
  const candidateSignatures = new Set();
  const rootSignatures = new Set();

  const considerCandidate = (candidate, rootId = null) => {
    if (!candidate || typeof candidate !== 'object' || candidateObjects.has(candidate)
      || !flightValueHasProviderIdentity(candidate)) return;
    if (candidateObjects.size < FLIGHT_RECORD_LIMIT) candidateObjects.add(candidate);
    let signature;
    try { signature = JSON.stringify(candidate); }
    catch { return; }
    if (candidateSignatures.has(signature) || candidateSignatures.size >= FLIGHT_RECORD_LIMIT) return;
    candidateSignatures.add(signature);

    const state = { nodes: 0, path: new Set(rootId ? [rootId] : []) };
    const resolved = resolvedFlightValue(candidate, records, state, 0);
    if (!resolved.ok || !resolved.value || typeof resolved.value !== 'object'
      || !flightValueHasProviderIdentity(resolved.value)) return;
    let rootSignature;
    try { rootSignature = JSON.stringify(resolved.value); }
    catch { return; }
    if (rootSignatures.has(rootSignature)) return;
    rootSignatures.add(rootSignature);
    roots.push(resolved.value);
  };

  for (const [id, value] of records) {
    considerCandidate(value, id);
    for (const candidate of structuredStringFragments(value)) considerCandidate(candidate, id);
    if (roots.length >= PROVIDER_ROW_LIMIT) return roots.slice(0, PROVIDER_ROW_LIMIT);
  }
  for (const packetString of packetStrings) {
    for (const candidate of structuredStringFragments(packetString)) considerCandidate(candidate);
    if (roots.length >= PROVIDER_ROW_LIMIT) return roots.slice(0, PROVIDER_ROW_LIMIT);
  }
  return roots;
}

function tftStructuredPayloads(html) {
  const payloads = resolvedFlightRoots(html);
  const scripts = String(html || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi);
  for (const match of scripts) {
    const body = match[1].trim();
    if (!body || body.length > REMOTE_MAX_BYTES) continue;
    let parsed = parseStructuredJson(body);
    if (!parsed) {
      const callStart = body.indexOf('(');
      const callEnd = body.lastIndexOf(')');
      if (callStart >= 0 && callEnd > callStart) parsed = parseStructuredJson(body.slice(callStart + 1, callEnd));
    }
    if (!parsed) {
      const start = body.indexOf('{');
      parsed = parseStructuredJson(extractBalancedObject(body, start, REMOTE_MAX_BYTES));
    }
    if (parsed) {
      payloads.push(parsed, ...structuredStringFragments(parsed));
    }
    if (payloads.length >= PROVIDER_ROW_LIMIT) break;
  }
  return payloads.slice(0, PROVIDER_ROW_LIMIT);
}

function boundedProviderObjects(root) {
  const objects = [];
  const pending = [{ value: root, depth: 0, ancestors: [] }];
  const seen = new Set();
  while (pending.length && objects.length < PROVIDER_ROW_LIMIT * 5) {
    const entry = pending.shift();
    const { value, depth, ancestors } = entry;
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (!Array.isArray(value)) objects.push(entry);
    if (depth >= 8) continue;
    const children = Array.isArray(value) ? value.slice(0, PROVIDER_ROW_LIMIT) : Object.entries(value).slice(0, PROVIDER_ROW_LIMIT);
    for (const child of children) {
      const key = Array.isArray(value) ? '' : child[0];
      const nested = Array.isArray(value) ? child : child[1];
      if (nested && typeof nested === 'object') {
        pending.push({ value: nested, depth: depth + 1, ancestors: [...ancestors, { value, key }].slice(-4) });
      }
    }
  }
  return objects;
}

const TFT_RANK_CONTAINER_KEYS = [...new Set([
  'league_stats', 'leagueStats', 'ranked_stats', 'rankedStats', 'queue_stats', 'queueStats', 'queues', 'queueMap',
  'ranking', 'rankings', 'entry', 'entries',
  ...PROVIDER_HISTORY_KEYS,
  'RANKED_TFT', 'RANKED_TFT_DOUBLE_UP',
])];

function hasTftRankContainer(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  return TFT_RANK_CONTAINER_KEYS.some((key) => row[key] && typeof row[key] === 'object');
}

function tftExactProfiles(payloads, gameName, tagLine) {
  const profiles = [];
  for (const payload of payloads.slice(0, PROVIDER_ROW_LIMIT)) {
    for (const entry of boundedProviderObjects(payload)) {
      if (!exactRiotId(entry.value, gameName, tagLine)) continue;
      let subtree = entry.value;
      for (let index = entry.ancestors.length - 1; index >= 0; index -= 1) {
        const ancestor = entry.ancestors[index];
        if (!/^(?:summoner|profile|player|identity|account)$/i.test(ancestor.key)) break;
        if (hasTftRankContainer(ancestor.value)) subtree = ancestor.value;
      }
      profiles.push({ identity: entry.value, subtree });
      if (profiles.length >= PROVIDER_ROW_LIMIT) return profiles;
    }
  }
  return profiles;
}

function tftProfileRankRows(profile) {
  const rows = [];
  const roots = profile.subtree === profile.identity ? [profile.identity] : [profile.identity, profile.subtree];
  for (const root of roots) {
    if (!root || typeof root !== 'object' || Array.isArray(root)) continue;
    for (const key of TFT_RANK_CONTAINER_KEYS) {
      const value = root[key];
      if (!value || typeof value !== 'object') continue;
      // Preserve the owning key so queue and previous-season semantics survive
      // without traversing unrelated siblings such as matchStat page data.
      rows.push(...providerCollectionRows({ [key]: value }));
      if (rows.length >= PROVIDER_ROW_LIMIT) return rows.slice(0, PROVIDER_ROW_LIMIT);
    }
  }
  return rows.slice(0, PROVIDER_ROW_LIMIT);
}

function tftQueuePayload(records, queue, expectedPuuid) {
  const bounded = records.slice(0, PROVIDER_ROW_LIMIT);
  checkedProviderPuuid(bounded, expectedPuuid, 'OP.GG TFT');
  const explicitCurrent = bounded.filter((row) => providerBoolean(row, ['is_current', 'isCurrent', 'current']) === true);
  const eligible = explicitCurrent.length ? explicitCurrent : bounded.filter((row) => !historicalProviderRecord(row)
    && !trustedProviderSeasonId(providerSeasonId(row)));
  const rankedEligible = eligible.map((row) => ({ row, rank: providerRankedQueue(row, queue) })).filter((value) => value.rank);
  const compatibleCurrentRank = (left, right) => left.tier === right.tier
    && (!left.division || !right.division || left.division === right.division)
    && (left.lp === null || right.lp === null || left.lp === right.lp);
  for (let left = 0; left < rankedEligible.length; left += 1) {
    for (let right = left + 1; right < rankedEligible.length; right += 1) {
      if (!compatibleCurrentRank(rankedEligible[left].rank, rankedEligible[right].rank)) {
        throw new Error(`OP.GG TFT returned ambiguous current ${queue} records.`);
      }
    }
  }
  const rankDetailScore = ({ row, rank }) => Number(Boolean(rank.division)) + Number(rank.lp !== null)
    + Number(rank.wins !== null) + Number(rank.losses !== null)
    + Number(providerBoolean(row, ['is_current', 'isCurrent', 'current']) === true);
  const selected = rankedEligible.reduce((best, candidate) => (
    !best || rankDetailScore(candidate) > rankDetailScore(best) ? candidate : best
  ), null);
  const currentRecord = selected && selected.row;
  const current = selected && selected.rank;
  const currentSeasonId = providerSeasonId(currentRecord);
  const historyRows = providerHistoryRows(bounded);
  for (const row of bounded) {
    const seasonId = providerSeasonId(row);
    if (historicalProviderRecord(row) || (seasonId && (!currentSeasonId || seasonId !== currentSeasonId))) historyRows.push(row);
  }
  return { current, pastSeasons: normalizedPastSeasons(historyRows, queue) };
}

async function fetchOpggTftStats(riotId, platform, expectedPuuid, options = {}) {
  const platformId = canonicalLeaguePlatform(platform);
  if (!platformId) throw new Error('A canonical League platform is required before contacting OP.GG TFT.');
  const wantedPuuid = providerText(expectedPuuid).toLowerCase();
  if (!wantedPuuid) throw new Error('An expected live PUUID is required for an identity-verified TFT lookup.');
  const { gameName, tagLine } = splitRiotId(riotId);
  const regionSlug = OPGG_REGIONS[platformId];
  const html = await remoteText(`https://op.gg/tft/summoners/${regionSlug}/${profileSlug(riotId)}`, new Set(['op.gg']), 'OP.GG TFT');
  const decoded = html.replace(/&quot;|&#34;/g, '"');
  let payloads = tftStructuredPayloads(decoded);
  if (!payloads.length) payloads = parsedObjectsForKeys(decoded, ['game_name', 'gameName', 'riot_id', 'riotId']);
  if (!payloads.length) throw new Error('OP.GG TFT profile response schema was not recognized.');
  const exactProfiles = tftExactProfiles(payloads, gameName, tagLine);
  if (!exactProfiles.length) throw new Error('OP.GG TFT profile identity did not match the requested Riot ID.');

  // A Next/React Flight page commonly contains several serializations of the
  // same profile. Group explicit Riot PUUIDs before deciding whether the Riot
  // ID is genuinely ambiguous; object count alone is not identity count.
  const profilePuuids = exactProfiles.map((profile) => providerPuuid(profile.identity));
  const corroboratedProfiles = exactProfiles.filter((_profile, index) => (
    profilePuuids[index] && profilePuuids[index].toLowerCase() === wantedPuuid
  ));
  const explicitPuuids = new Map();
  for (const value of profilePuuids.filter(Boolean)) explicitPuuids.set(value.toLowerCase(), value);

  let selectedProfiles;
  let providerPuuidValue;
  if (corroboratedProfiles.length) {
    // Correct explicit PUUID evidence wins. PUUID-less route fragments can
    // contribute rank fields, while explicit mismatches belong to stale or
    // unrelated provider records and must never be merged into this identity.
    selectedProfiles = exactProfiles.filter((_profile, index) => (
      !profilePuuids[index] || profilePuuids[index].toLowerCase() === wantedPuuid
    ));
    providerPuuidValue = providerPuuid(corroboratedProfiles[0].identity);
  } else {
    if (explicitPuuids.size > 1) {
      throw new Error('OP.GG TFT returned ambiguous duplicate exact Riot ID profiles on the verified platform.');
    }
    // Repeated PUUID-less fragments, or repeated copies carrying the same stale
    // PUUID, are one logical profile. Conflicting current ranks still fail
    // closed in tftQueuePayload rather than being silently combined.
    selectedProfiles = exactProfiles;
    providerPuuidValue = explicitPuuids.values().next().value || null;
  }
  const providerPuuidCorroborated = corroboratedProfiles.length > 0;
  const profileRows = selectedProfiles.flatMap(tftProfileRankRows).slice(0, PROVIDER_ROW_LIMIT);
  const queues = [];
  const pastRows = [];
  for (const queue of ['RANKED_TFT', 'RANKED_TFT_DOUBLE_UP']) {
    const records = profileRows.filter((row) => providerQueueType(row) === queue);
    if (!records.length) continue;
    const ranked = tftQueuePayload(records, queue, wantedPuuid);
    if (ranked.current) queues.push(ranked.current);
    pastRows.push(...ranked.pastSeasons);
  }
  const pastSeasons = [];
  const seenPast = new Set();
  for (const row of pastRows.slice(0, PROVIDER_ROW_LIMIT)) {
    const key = `${row.seasonId || ''}|${row.queue}|${row.tier}|${row.division}|${row.lp ?? ''}`;
    if (seenPast.has(key)) continue;
    seenPast.add(key);
    pastSeasons.push(row);
    if (pastSeasons.length >= PROVIDER_SEASON_LIMIT) break;
  }
  return {
    available: true,
    providerPuuid: providerPuuidValue,
    providerPuuidCorroborated,
    riotId: `${gameName}#${tagLine}`,
    platformId,
    queues: dedupeCurrentQueues(queues),
    pastSeasons,
    source: 'opgg',
    updatedAt: new Date().toISOString(),
  };
}

function beforeDeadline(promise, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('League platform discovery timed out.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('League platform discovery timed out.')), remaining);
    if (timer.unref) timer.unref();
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function discoveryFailure(kind, errors) {
  const messages = errors.map((message) => String(message || ''));
  const noExact = kind === 'League'
    ? /did not return an exact match for the requested Riot ID/i
    : /profile identity did not match the requested Riot ID/i;
  if (messages.length && messages.every((message) => noExact.test(message))) {
    return new Error(`No ${kind} platform matched both the requested Riot ID and PUUID.`);
  }
  if (messages.some((message) => /PUUID/i.test(message))) {
    return new Error(`${kind} platform probes found the exact Riot ID, but its PUUID was missing or did not match.`);
  }
  if (messages.some((message) => /HTTP 429|rate.?limit/i.test(message))) {
    return new Error(`${kind} platform discovery was blocked by OP.GG rate limiting.`);
  }
  if (messages.some((message) => /timed out/i.test(message))) {
    return new Error(`${kind} platform discovery timed out while probing OP.GG.`);
  }
  if (messages.some((message) => /HTTP \d+|invalid JSON|too large|schema|untrusted host|summary identity|summoner identifier/i.test(message))) {
    return new Error(`${kind} platform discovery could not verify OP.GG responses because of an HTTP or schema failure.`);
  }
  return new Error(`${kind} platform discovery failed before identity verification completed.`);
}

async function discoverOpgg(riotId, expectedPuuid, preferredPlatformId, options, config) {
  splitRiotId(riotId);
  const wantedPuuid = providerText(expectedPuuid);
  if (!wantedPuuid) throw new Error(`An expected PUUID is required for ${config.kind} platform discovery.`);
  const preferred = canonicalLeaguePlatform(preferredPlatformId);
  const platforms = preferred
    ? [preferred, ...LEAGUE_PLATFORMS.filter((platformId) => platformId !== preferred)]
    : [...LEAGUE_PLATFORMS];
  const concurrency = Math.max(1, Math.min(3, Number(options.concurrency) || 3));
  const deadlineAt = Date.now() + Math.max(100, Math.min(30000, Number(options.timeoutMs) || 30000));
  const errors = [];

  // A PUUID-corroborated platform is authoritative and returns immediately.
  // Otherwise we collect every platform that returned an exact, globally-unique
  // Riot ID match; if exactly one platform matched, we accept it (weakened
  // verification). Multiple platforms matching the exact Riot ID is ambiguous
  // and still fails closed to avoid attaching the wrong region's data.
  const exactRiotIdCandidates = [];
  for (let index = 0; index < platforms.length; index += concurrency) {
    if (Date.now() >= deadlineAt) break;
    const batch = platforms.slice(index, index + concurrency);
    const results = await Promise.allSettled(batch.map((platformId) => beforeDeadline(
      config.fetcher(riotId, platformId, wantedPuuid),
      deadlineAt,
    )));
    for (let offset = 0; offset < results.length; offset += 1) {
      if (results[offset].status === 'fulfilled') {
        const value = results[offset].value;
        if (!value) { errors.push(`${config.kind} platform probe returned no data.`); continue; }
        if (value.providerPuuid && value.providerPuuid.toLowerCase() === wantedPuuid.toLowerCase()) {
          return { ...value, platformId: batch[offset], platformSource: config.platformSource };
        }
        exactRiotIdCandidates.push({ ...value, platformId: batch[offset], platformSource: config.platformSource });
        continue;
      }
      const reason = results[offset].reason;
      errors.push(reason && reason.message ? reason.message : `${config.kind} platform probe failed.`);
    }
  }
  if (exactRiotIdCandidates.length === 1) return exactRiotIdCandidates[0];
  if (exactRiotIdCandidates.length > 1) {
    throw new Error(`${config.kind} found the exact Riot ID on multiple platforms; its region could not be uniquely determined.`);
  }
  throw discoveryFailure(config.kind, errors);
}

/** Discover a League platform only through an exact Riot ID + exact expected PUUID. */
async function discoverOpggStats(riotId, expectedPuuid, preferredPlatformId = '', options = {}) {
  return discoverOpgg(riotId, expectedPuuid, preferredPlatformId, options, {
    kind: 'League',
    fetcher: (identity, platformId, puuid) => fetchOpggStats(identity, platformId, puuid, { requireProviderPuuid: true }),
    platformSource: 'opgg-discovery',
  });
}

/** Discover a TFT platform independently through an exact Riot ID + exact expected PUUID. */
async function discoverOpggTftStats(riotId, expectedPuuid, preferredPlatformId = '', options = {}) {
  return discoverOpgg(riotId, expectedPuuid, preferredPlatformId, options, {
    kind: 'TFT',
    fetcher: (identity, platformId, puuid) => fetchOpggTftStats(identity, platformId, puuid, { requireProviderPuuid: true }),
    platformSource: 'opgg-tft-discovery',
  });
}

/**
 * Preferred: read the live LCU port + auth token straight off the running
 * LeagueClientUx process command line. This works no matter where League is
 * installed, which the fixed lockfile paths did not.
 */
function lcuFromProcess() {
  return new Promise((resolve) => {
    const ps = "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 6000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const port = (stdout.match(/--app-port=([0-9]+)/) || [])[1];
      const token = (stdout.match(/--remoting-auth-token=([\w-]+)/) || [])[1];
      resolve(port && token ? { port, password: token } : null);
    });
  });
}

function leagueInstallLockfiles() {
  const metadata = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Riot Games', 'Metadata', 'league_of_legends.live', 'league_of_legends.live.product_settings.yaml'),
  ];
  const lockfiles = [];
  for (const file of metadata) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const match = text.match(/product_install_full_path:\s*["']?([^\r\n"']+)/i);
      if (match && match[1].trim()) lockfiles.push(path.join(match[1].trim().replace(/\\\\/g, '\\'), 'lockfile'));
    } catch { /* metadata is optional */ }
  }
  return lockfiles;
}

function lockFromFile(configured) {
  const candidates = [...new Set([
    ...(configured ? [configured] : []),
    ...LOCKFILE_PATHS,
    ...leagueInstallLockfiles(),
  ])];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const parts = fs.readFileSync(p, 'utf8').trim().split(':');
        if (parts.length >= 5) return { port: parts[2], password: parts[3] };
      }
    } catch { /* try next */ }
  }
  return null;
}

async function resolveLcu(configured) {
  return (await lcuFromProcess()) || lockFromFile(configured)
    || Promise.reject(new Error('League client not detected. Make sure League of Legends is fully open (past the login screen), then try again.'));
}

function lcu(lock, pathname) {
  return new Promise((resolve, reject) => {
    const auth = 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64');
    const req = https.request(
      { hostname: '127.0.0.1', port: lock.port, path: pathname, method: 'GET', headers: { Authorization: auth, Accept: 'application/json' }, agent },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`LCU HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(text)); } catch { resolve(text); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('League client request timed out.')));
    req.end();
  });
}

/** LCU asset path -> Community Dragon URL. */
function cdragon(assetPath) {
  if (!assetPath) return '';
  const raw = String(assetPath).trim().replace(/\\/g, '/');
  if (/^https:\/\/raw\.communitydragon\.org\//i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return '';
  const marker = '/lol-game-data/assets';
  const lower = raw.toLowerCase();
  const index = lower.indexOf(marker);
  if (index < 0) return '';
  const relative = raw.slice(index + marker.length);
  return `${CDRAGON}${relative.startsWith('/') ? relative : `/${relative}`}`.toLowerCase();
}

// League skin rarities (LCU skin.rarity) -> display tier + colour, ordered high→low.
const LOL_TIER_ORDER = ['Exalted', 'Transcendent', 'Ultimate', 'Mythic', 'Legendary', 'Epic', 'Standard'];
const RARITY = {
  kEpic: { name: 'Epic', color: '#0ea5c4' },
  kLegendary: { name: 'Legendary', color: '#e0533d' },
  kMythic: { name: 'Mythic', color: '#b061e6' },
  kUltimate: { name: 'Ultimate', color: '#e0a52a' },
  kTranscendent: { name: 'Transcendent', color: '#e0457b' },
  kExalted: { name: 'Exalted', color: '#c0392b' },
};
const rarityOf = (r) => RARITY[r] || { name: 'Standard', color: '#3b6d8a' };
const tierRank = (t) => { const i = LOL_TIER_ORDER.indexOf(t); return i < 0 ? 99 : i; };

async function cdragonJson(file) {
  const cached = metadataCache.get(file);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.value;
  const value = await remoteJson(`${CDRAGON}/v1/${file}`, new Set(['raw.communitydragon.org']), 'CommunityDragon');
  metadataCache.set(file, { at: Date.now(), value });
  return value;
}

function metadataRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['data', 'items', 'offers', 'catalog', 'catalogItems']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return Object.values(value).filter((row) => row && typeof row === 'object');
}

function recordId(value) {
  if (value == null || typeof value !== 'object') return String(value == null ? '' : value);
  return String(value.itemId ?? value.id ?? value.contentId ?? value.uuid ?? value.offerId ?? value.inventoryType ?? '');
}

function idCandidates(row) {
  if (!row || typeof row !== 'object') return [];
  const nested = row.item && typeof row.item === 'object' ? row.item : {};
  const values = [row.itemId, row.id, row.contentId, row.uuid, row.offerId,
    nested.itemId, nested.id, nested.contentId, nested.uuid];
  const aliases = new Set();
  for (const value of values) {
    if (value == null || value === '') continue;
    const normalized = String(value).trim().toLowerCase();
    aliases.add(normalized);
    const numericSuffix = normalized.match(/(?:^|[_:-])(\d+)$/);
    if (numericSuffix) aliases.add(numericSuffix[1]);
  }
  return [...aliases];
}

function metadataIndex(value, includeChromas = false) {
  const index = new Map();
  const add = (row) => {
    if (!row || typeof row !== 'object') return;
    for (const key of idCandidates(row)) index.set(key, row);
    if (includeChromas) for (const chroma of row.chromas || []) add(chroma);
  };
  metadataRows(value).forEach(add);
  return index;
}

function metadataFor(index, record) {
  for (const candidate of idCandidates(record)) {
    const found = index.get(candidate);
    if (found) return found;
  }
  return null;
}

function validPrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 && price < 100000 ? price : 0;
}

function rpPrice(...records) {
  for (const row of records) {
    if (!row || typeof row !== 'object') continue;
    for (const direct of [row.rp, row.rpCost, row.rpPrice, row.storePrice]) {
      const price = validPrice(direct);
      if (price) return price;
    }
    for (const container of [row.costs, row.price, row.cost]) {
      if (!container || typeof container !== 'object') continue;
      for (const direct of [container.RP, container.rp, container.RiotPoints, container.riotPoints]) {
        const price = validPrice(direct && typeof direct === 'object' ? (direct.cost ?? direct.amount ?? direct.price) : direct);
        if (price) return price;
      }
    }
    const entries = [row.prices, row.priceOptions, row.costOptions, row.virtualPrices]
      .flatMap((value) => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : []);
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const currency = String(entry.currency || entry.currencyType || entry.type || entry.id || '').toUpperCase();
      if (!['RP', 'RIOTPOINTS', 'LOL_RP'].includes(currency)) continue;
      const price = validPrice(entry.cost ?? entry.amount ?? entry.price ?? entry.value);
      if (price) return price;
    }
    const currency = String(row.currency || row.currencyType || '').toUpperCase();
    if (['RP', 'RIOTPOINTS', 'LOL_RP'].includes(currency)) {
      const price = validPrice(row.cost ?? row.price ?? row.amount ?? row.value);
      if (price) return price;
    }
  }
  return 0;
}

function priceLeagueRecord(record, metadata, storeCatalog) {
  const meta = metadataFor(metadataIndex(metadata, true), record);
  const store = metadataFor(metadataIndex(storeCatalog, true), record)
    || (meta ? metadataFor(metadataIndex(storeCatalog, true), meta) : null);
  return { meta, store, value: rpPrice(store, record, meta) };
}

function owned(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.owned === false || record.ownership && record.ownership.owned === false) return false;
  if (record.quantity != null && Number(record.quantity) <= 0) return false;
  return true;
}

async function inventoryType(lock, ...types) {
  for (const type of types) {
    const response = await lcu(lock, `/lol-inventory/v1/inventory/${encodeURIComponent(type)}`).catch(() => null);
    const rows = Array.isArray(response) ? response : response && (response.items || response.inventoryItems || response.data);
    if (Array.isArray(rows) && rows.length) return rows.filter(owned);
  }
  return [];
}

async function storeCatalog(lock) {
  // LCU expects inventoryType as a JSON vector. CHAMPION_SKIN includes both
  // base skins and RECOLOR rows (chromas) in current clients.
  const inventoryTypes = encodeURIComponent(JSON.stringify(['CHAMPION_SKIN']));
  return metadataRows(await lcu(lock, `/lol-store/v1/catalog?inventoryType=${inventoryTypes}`).catch(() => []));
}

function itemImage(...records) {
  for (const row of records) {
    if (!row) continue;
    const raw = row.splashPath || row.uncenteredSplashPath || row.tilePath || row.inventoryIcon
      || row.inventoryIconSmall || row.loadoutsIcon || row.iconPath || row.icon || row.imagePath || row.downloadUrl;
    const image = cdragon(raw);
    if (image) return image;
  }
  return '';
}

function itemName(type, record, meta) {
  return String((meta && (meta.name || meta.title)) || record.name || record.displayName || `${type} ${recordId(record)}`).trim();
}

function genericItem(type, record, meta, options = {}) {
  const id = recordId(meta || record) || recordId(record);
  const rarity = options.rarity || rarityOf(meta && meta.rarity || record.rarity);
  return {
    type,
    uuid: `${type.toLowerCase()}-${id}`,
    name: itemName(type, record, meta),
    category: options.category || type,
    tier: rarity.name,
    tierColor: rarity.color,
    fit: options.fit || 'contain',
    image: itemImage(meta, record),
    value: options.value == null ? 0 : options.value,
    currency: options.currency || null,
    parent: options.parent || null,
    variants: Number(options.variants || 0),
    source: options.source || 'lcu',
  };
}

function currencyAmount(value) {
  const amount = value && typeof value === 'object'
    ? (value.amount ?? value.value ?? value.balance ?? value.cost)
    : value;
  const parsed = Number(amount);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function leagueWallet(value) {
  const wallet = value && typeof value === 'object' ? value : {};
  const balances = wallet.currencyBalances || wallet.balances || {};
  const read = (...keys) => {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(wallet, key)) return currencyAmount(wallet[key]);
      if (Object.prototype.hasOwnProperty.call(balances, key)) return currencyAmount(balances[key]);
    }
    return 0;
  };
  return {
    rp: read('RP', 'rp', 'lol_riot_points', 'riotPoints'),
    blueEssence: read('lol_blue_essence', 'BE', 'be', 'IP', 'ip', 'blueEssence'),
  };
}

const RESULT_SHAPE = (riotId, items, tierOrder = ['Standard'], options = {}) => {
  const byType = {}, byTier = {}, valueByType = {};
  let totalValue = 0;
  for (const it of items) {
    byType[it.type] = (byType[it.type] || 0) + 1;
    byTier[it.tier] = (byTier[it.tier] || 0) + 1;
    const value = Number(it.value || 0);
    if (value > 0) {
      totalValue += value;
      valueByType[it.type] = (valueByType[it.type] || 0) + value;
    }
  }
  const unknownIds = [...new Set((options.unknownIds || []).filter(Boolean).map(String))];
  return {
    riotId,
    items,
    tierOrder,
    summary: {
      total: items.length,
      unknown: unknownIds.length,
      unknownIds,
      byType,
      byTier,
      totalValue,
      totalRP: options.currency === 'RP' ? totalValue : 0,
      valueByType,
      currency: options.currency || null,
      priced: items.some((item) => Number(item.value) > 0),
    },
    wallet: options.wallet || { vp: 0, radianite: 0, kingdom: 0 },
  };
};

/** League inventory: champions, skins, chromas, emotes, profile icons, and wards. */
async function buildLeague(configuredPath) {
  const lock = await resolveLcu(configuredPath);
  const summoner = await lcu(lock, '/lol-summoner/v1/current-summoner').catch(() => ({}));
  const riotId = summoner.gameName && summoner.tagLine ? `${summoner.gameName}#${summoner.tagLine}` : (summoner.displayName || 'League account');
  const sid = summoner.summonerId;
  const [champs, emotes, icons, wards, extraChromas, wallet, catalog, skinsMeta, emotesMeta, iconsMeta, wardsMeta] = await Promise.all([
    lcu(lock, `/lol-champions/v1/inventories/${sid}/champions`).catch(() => []),
    inventoryType(lock, 'SUMMONER_EMOTE', 'EMOTE'),
    inventoryType(lock, 'SUMMONER_ICON', 'PROFILE_ICON'),
    inventoryType(lock, 'WARD_SKIN'),
    inventoryType(lock, 'CHAMPION_SKIN_CHROMA', 'CHROMA'),
    lcu(lock, `/lol-inventory/v1/wallet?currencyTypes=${encodeURIComponent(JSON.stringify(['RP', 'IP']))}`).catch(() => ({})),
    storeCatalog(lock),
    cdragonJson('skins.json').catch(() => []),
    cdragonJson('emotes.json').catch(() => []),
    cdragonJson('profile-icons.json').catch(() => []),
    cdragonJson('ward-skins.json').catch(() => []),
  ]);
  if (!Array.isArray(champs) || !champs.length) throw new Error('Could not read League champion inventory.');

  const skinIndex = metadataIndex(skinsMeta, true);
  const storeIndex = metadataIndex(catalog, true);
  const indexes = {
    Emote: metadataIndex(emotesMeta),
    ProfileIcon: metadataIndex(iconsMeta),
    WardSkin: metadataIndex(wardsMeta),
    Chroma: skinIndex,
  };
  const items = [];
  const seenChromas = new Set();
  const unknownIds = [];
  for (const champion of champs) {
    if (champion.id <= 0) continue;
    if (champion.ownership && champion.ownership.owned) {
      items.push(genericItem('Champion', champion, champion, {
        category: 'Champions',
        fit: 'contain',
        rarity: { name: 'Standard', color: '#5a6b7a' },
      }));
      if (!items[items.length - 1].image) items[items.length - 1].image = `${CDRAGON}/v1/champion-icons/${champion.id}.png`;
    }
    for (const skin of champion.skins || []) {
      if (skin.isBase || !skin.ownership || !skin.ownership.owned) continue;
      const meta = metadataFor(skinIndex, skin);
      const store = metadataFor(storeIndex, skin) || (meta && metadataFor(storeIndex, meta));
      const rarity = rarityOf(skin.rarity || meta && meta.rarity);
      const chromas = (skin.chromas || []).filter((chroma) => chroma.ownership && chroma.ownership.owned);
      items.push(genericItem('Skin', skin, meta || skin, {
        category: champion.name,
        fit: 'cover',
        rarity,
        value: rpPrice(store, skin, meta),
        currency: 'RP',
        variants: chromas.length,
        source: store ? 'lcu-store+communitydragon' : meta ? 'lcu+communitydragon' : 'lcu',
      }));
      if (!meta) unknownIds.push(recordId(skin));
      for (const chroma of chromas) {
        const chromaMeta = metadataFor(skinIndex, chroma);
        const chromaStore = metadataFor(storeIndex, chroma) || (chromaMeta && metadataFor(storeIndex, chromaMeta));
        const key = recordId(chromaMeta || chroma).toLowerCase();
        if (key) seenChromas.add(key);
        items.push(genericItem('Chroma', chroma, chromaMeta, {
          category: champion.name,
          parent: skin.name,
          fit: 'cover',
          rarity,
          value: rpPrice(chromaStore, chroma, chromaMeta),
          currency: 'RP',
          source: chromaStore ? 'lcu-store+communitydragon' : chromaMeta ? 'lcu+communitydragon' : 'lcu',
        }));
        if (!chromaMeta) unknownIds.push(recordId(chroma));
      }
    }
  }

  for (const record of extraChromas) {
    const meta = metadataFor(indexes.Chroma, record);
    const store = metadataFor(storeIndex, record) || (meta && metadataFor(storeIndex, meta));
    const key = recordId(meta || record).toLowerCase();
    if (key && seenChromas.has(key)) continue;
    items.push(genericItem('Chroma', record, meta, {
      category: 'Chromas',
      fit: 'cover',
      value: rpPrice(store, record, meta),
      currency: 'RP',
      source: store ? 'lcu-store+communitydragon' : meta ? 'lcu+communitydragon' : 'lcu',
    }));
    if (!meta) unknownIds.push(recordId(record));
  }

  for (const [type, records] of Object.entries({ Emote: emotes, ProfileIcon: icons, WardSkin: wards })) {
    for (const record of records) {
      const meta = metadataFor(indexes[type], record);
      items.push(genericItem(type, record, meta, {
        category: type === 'ProfileIcon' ? 'Profile Icons' : type === 'WardSkin' ? 'Ward Skins' : 'Emotes',
        source: meta ? 'lcu+communitydragon' : 'lcu',
      }));
      if (!meta) unknownIds.push(recordId(record));
    }
  }

  items.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.name.localeCompare(b.name));
  return RESULT_SHAPE(riotId, items, LOL_TIER_ORDER, { currency: 'RP', wallet: leagueWallet(wallet), unknownIds });
}

/** Teamfight Tactics inventory: companions, arenas, and finishers/booms. */
async function buildTft(configuredPath) {
  const lock = await resolveLcu(configuredPath);
  const summoner = await lcu(lock, '/lol-summoner/v1/current-summoner').catch(() => ({}));
  const riotId = summoner.gameName && summoner.tagLine ? `${summoner.gameName}#${summoner.tagLine}` : (summoner.displayName || 'TFT account');
  const responses = await Promise.all([
    lcu(lock, '/lol-cosmetics/v1/inventories/tft/companions').catch(() => null),
    lcu(lock, '/lol-cosmetics/v1/inventories/tft/mapskins').catch(() => null),
    lcu(lock, '/lol-cosmetics/v1/inventories/tft/damageskins').catch(() => null),
  ]);
  const definitions = [
    { type: 'Companion', keys: ['companions'], category: 'Little Legends', color: '#7d5a9c' },
    { type: 'Arena', keys: ['mapSkins', 'mapskins'], category: 'Arenas', color: '#277da1' },
    { type: 'Finisher', keys: ['damageSkins', 'damageskins'], category: 'Finishers', color: '#b4536b' },
  ];
  const items = [];
  for (let i = 0; i < responses.length; i += 1) {
    const response = responses[i];
    const definition = definitions[i];
    const nested = definition.keys.map((key) => response && response[key]).find(Array.isArray);
    const list = Array.isArray(response) ? response : nested || response && (response.items || response.data) || [];
    for (const record of list) {
      items.push(genericItem(definition.type, record, record, {
        category: definition.category,
        rarity: { name: 'Standard', color: definition.color },
      }));
    }
  }
  if (!items.length) throw new Error('No TFT companions, arenas, or finishers were returned by the League client.');
  items.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return RESULT_SHAPE(riotId, items);
}

/** Normalize one ranked LCU queue without fabricating zero/NA fields. */
function normalizeRankedQueue(row) {
  if (!row || typeof row !== 'object') return null;
  const rawTier = row.tier ?? row.tierName;
  if (rawTier === undefined || rawTier === null || !String(rawTier).trim()) return null;
  const tier = String(rawTier).trim().toUpperCase();
  const unranked = tier === 'UNRANKED' || tier === 'NONE' || tier === 'NA' || tier === 'N/A';
  const rawDivision = String(row.division || row.rank || '').trim().toUpperCase();
  const division = unranked || ['NA', 'N/A', 'NONE', '0'].includes(rawDivision) ? '' : rawDivision;
  const optionalNumber = (...values) => {
    const value = values.find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    queue: row.queueType || row.queue || row.queueId,
    tier: unranked ? 'UNRANKED' : tier,
    division,
    lp: unranked ? null : optionalNumber(row.leaguePoints, row.lp),
    wins: optionalNumber(row.wins),
    losses: optionalNumber(row.losses),
  };
}

/** Normalize ranked LCU queues once for the combined account workspace. */
async function buildStats(configuredPath) {
  const lock = await resolveLcu(configuredPath);
  const [summoner, ranked, loginData, regionLocale] = await Promise.all([
    lcu(lock, '/lol-summoner/v1/current-summoner'),
    lcu(lock, '/lol-ranked/v1/current-ranked-stats'),
    lcu(lock, '/lol-platform-config/v1/namespaces/LoginDataPacket').catch(() => null),
    lcu(lock, '/riotclient/region-locale').catch(() => null),
  ]);
  const wanted = new Set(['RANKED_SOLO_5x5', 'RANKED_FLEX_SR', 'RANKED_TFT', 'RANKED_TFT_DOUBLE_UP']);
  const source = Array.isArray(ranked)
    ? ranked
    : (ranked && (ranked.queues || ranked.queueMap || ranked.queueStats || ranked.rankedQueueStats)) || [];
  const rows = Array.isArray(source) ? source : Object.entries(source || {}).map(([queueType, value]) => ({ queueType, ...value }));
  const queues = dedupeCurrentQueues(rows.map(normalizeRankedQueue).filter(Boolean).filter((row) => wanted.has(row.queue)));
  const riotId = summoner.gameName && summoner.tagLine
    ? `${summoner.gameName}#${summoner.tagLine}`
    : (summoner.displayName || null);
  const platform = selectLeaguePlatform(loginData, regionLocale);
  return {
    puuid: summoner.puuid || null,
    riotId,
    platformId: platform.platformId,
    platformSource: platform.platformSource,
    summonerLevel: Number(summoner.summonerLevel || 0),
    profileIconId: Number(summoner.profileIconId || 0) || null,
    league: queues.filter((row) => row.queue === 'RANKED_SOLO_5x5' || row.queue === 'RANKED_FLEX_SR'),
    tft: queues.filter((row) => row.queue === 'RANKED_TFT' || row.queue === 'RANKED_TFT_DOUBLE_UP'),
  };
}

module.exports = {
  buildLeague, buildTft, buildStats,
  fetchOpggStats, fetchOpggTftStats, discoverOpggStats, discoverOpggTftStats,
  opggProfileUrl, uggProfileUrl, deeplolProfileUrl, dpmProfileUrl, profileLinks,
  opggRegion, uggRegion, deeplolRegion,
  LEAGUE_PLATFORMS, normalizeLeaguePlatform, canonicalLeaguePlatform, selectLeaguePlatform,
  leagueWallet, normalizeRankedQueue, priceLeagueRecord,
};
