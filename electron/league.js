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

function exactRiotId(row, gameName, tagLine) {
  return row && String(row.game_name || '').trim().toLowerCase() === gameName.toLowerCase()
    && String(row.tagline || '').trim().toLowerCase() === tagLine.toLowerCase();
}

/** Identity-verified League rank lookup through OP.GG's undocumented JSON service. */
async function fetchOpggStats(riotId, platform, expectedPuuid) {
  const platformId = canonicalLeaguePlatform(platform);
  if (!platformId) throw new Error('A canonical League platform is required before contacting OP.GG.');
  const wantedPuuid = String(expectedPuuid || '').trim().toLowerCase();
  if (!wantedPuuid) throw new Error('An expected PUUID is required for an identity-verified OP.GG lookup.');
  const { gameName, tagLine } = splitRiotId(riotId);
  const regionSlug = OPGG_REGIONS[platformId];
  const searchUrl = new URL(`https://${OPGG_API_HOST}/api/v3/${regionSlug}/summoners`);
  searchUrl.searchParams.set('riot_id', `${gameName}#${tagLine}`);
  searchUrl.searchParams.set('hl', 'en_US');
  const search = await remoteJson(searchUrl, new Set([OPGG_API_HOST]), 'OP.GG');
  const exactMatches = Array.isArray(search && search.data)
    ? search.data.filter((row) => exactRiotId(row, gameName, tagLine) && row.summoner_id)
    : [];
  const match = exactMatches.find((row) => String(row.puuid || '').trim().toLowerCase() === wantedPuuid)
    || exactMatches.find((row) => !String(row.puuid || '').trim());
  if (!match) {
    if (exactMatches.length) throw new Error('OP.GG exact Riot ID matches did not contain the requested PUUID in this platform.');
    throw new Error('OP.GG did not return an exact match for the requested Riot ID.');
  }

  const summaryUrl = new URL(`https://${OPGG_API_HOST}/api/${regionSlug}/summoners/${encodeURIComponent(match.summoner_id)}/summary`);
  summaryUrl.searchParams.set('hl', 'en_US');
  const summary = await remoteJson(summaryUrl, new Set([OPGG_API_HOST]), 'OP.GG');
  const summoner = summary && summary.data && summary.data.summoner;
  if (!exactRiotId(summoner, gameName, tagLine)) throw new Error('OP.GG summary identity did not match the requested Riot ID.');
  if (summoner.puuid && String(summoner.puuid).trim().toLowerCase() !== wantedPuuid) {
    throw new Error('OP.GG search and summary PUUIDs did not match the requested identity.');
  }
  const puuid = summoner.puuid || match.puuid;
  if (!puuid || String(puuid).trim().toLowerCase() !== wantedPuuid) {
    throw new Error('OP.GG returned a different or missing requested PUUID for this platform.');
  }
  const queueTypes = { SOLORANKED: 'RANKED_SOLO_5x5', FLEXRANKED: 'RANKED_FLEX_SR' };
  const queues = (Array.isArray(summoner.league_stats) ? summoner.league_stats : [])
    .filter((row) => queueTypes[row.game_type])
    .map((row) => {
      const tier = row.tier_info || {};
      const division = Number(tier.division);
      return {
        queue: queueTypes[row.game_type],
        tier: tier.tier ? String(tier.tier).toUpperCase() : 'UNRANKED',
        division: ROMAN_DIVISION[division] || '',
        lp: tier.lp == null || tier.lp === '' ? null : (Number.isFinite(Number(tier.lp)) ? Number(tier.lp) : null),
        wins: row.win == null || row.win === '' ? null : (Number.isFinite(Number(row.win)) ? Number(row.win) : null),
        losses: row.lose == null || row.lose === '' ? null : (Number.isFinite(Number(row.lose)) ? Number(row.lose) : null),
      };
    });
  return {
    available: true,
    puuid,
    riotId: `${summoner.game_name}#${summoner.tagline}`,
    platformId,
    level: Number(summoner.level || match.level || 0),
    profileIconId: null,
    queues,
    source: 'opgg',
    profileUrl: opggProfileUrl(riotId, platformId),
    approximate: false,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchOpggTftStats(riotId, platform, expectedPuuid) {
  const platformId = canonicalLeaguePlatform(platform);
  if (!platformId) throw new Error('A canonical League platform is required before contacting OP.GG TFT.');
  const wantedPuuid = String(expectedPuuid || '').trim().toLowerCase();
  if (!wantedPuuid) throw new Error('An expected PUUID is required for an identity-verified TFT lookup.');
  const { gameName, tagLine } = splitRiotId(riotId);
  const regionSlug = OPGG_REGIONS[platformId];
  const html = await remoteText(`https://op.gg/tft/summoners/${regionSlug}/${profileSlug(riotId)}`, new Set(['op.gg']), 'OP.GG TFT');
  const decoded = html.replace(/\\"/g, '"');
  const identities = [...decoded.matchAll(/"gameName":"([^"]+)","tagLine":"([^"]+)"/g)];
  if (!identities.some((match) => match[1].toLowerCase() === gameName.toLowerCase() && match[2].toLowerCase() === tagLine.toLowerCase())) {
    throw new Error('OP.GG TFT profile identity did not match the requested Riot ID.');
  }
  const queues = [];
  for (const queue of ['RANKED_TFT', 'RANKED_TFT_DOUBLE_UP']) {
    const matches = [...decoded.matchAll(new RegExp(`"${queue}":\\{([^{}]{1,3000})\\}`, 'g'))];
    const readFrom = (block, key) => { const found = block.match(new RegExp(`"${key}":"([^"]*)"`)); return found ? found[1] : ''; };
    const match = matches.find((candidate) => readFrom(candidate[1], 'puuid').toLowerCase() === wantedPuuid);
    if (!match) {
      if (matches.length && queue === 'RANKED_TFT') throw new Error('OP.GG TFT returned a different or missing requested PUUID.');
      continue;
    }
    const readString = (key) => readFrom(match[1], key);
    const readNumber = (key) => { const found = match[1].match(new RegExp(`"${key}":(-?\\d+(?:\\.\\d+)?)`)); return found ? Number(found[1]) : null; };
    queues.push(normalizeRankedQueue({ queueType: queue, tier: readString('tier'), rank: readString('rank'), leaguePoints: readNumber('leaguePoints'), wins: readNumber('wins'), losses: readNumber('losses') }));
  }
  return { available: true, puuid: expectedPuuid, riotId, platformId, queues, source: 'opgg', updatedAt: new Date().toISOString() };
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

/** Discover a League platform only through an exact Riot ID + exact expected PUUID. */
async function discoverOpggStats(riotId, expectedPuuid, preferredPlatformId = '', options = {}) {
  splitRiotId(riotId);
  const wantedPuuid = String(expectedPuuid || '').trim();
  if (!wantedPuuid) throw new Error('An expected PUUID is required for League platform discovery.');
  const preferred = canonicalLeaguePlatform(preferredPlatformId);
  const platforms = preferred
    ? [preferred, ...LEAGUE_PLATFORMS.filter((platformId) => platformId !== preferred)]
    : [...LEAGUE_PLATFORMS];
  const concurrency = Math.max(1, Math.min(3, Number(options.concurrency) || 3));
  const deadlineAt = Date.now() + Math.max(100, Math.min(15000, Number(options.timeoutMs) || 15000));

  for (let index = 0; index < platforms.length; index += concurrency) {
    if (Date.now() >= deadlineAt) throw new Error('League platform discovery timed out.');
    const batch = platforms.slice(index, index + concurrency);
    const results = await Promise.allSettled(batch.map((platformId) => beforeDeadline(
      fetchOpggStats(riotId, platformId, wantedPuuid),
      deadlineAt,
    )));
    for (let offset = 0; offset < results.length; offset += 1) {
      if (results[offset].status === 'fulfilled') {
        return { ...results[offset].value, platformId: batch[offset], platformSource: 'opgg-discovery' };
      }
    }
  }
  throw new Error('No League platform matched both the requested Riot ID and PUUID.');
}

/** Discover a TFT platform independently through an exact Riot ID + exact expected PUUID. */
async function discoverOpggTftStats(riotId, expectedPuuid, preferredPlatformId = '', options = {}) {
  splitRiotId(riotId);
  const wantedPuuid = String(expectedPuuid || '').trim();
  if (!wantedPuuid) throw new Error('An expected PUUID is required for TFT platform discovery.');
  const preferred = canonicalLeaguePlatform(preferredPlatformId);
  const platforms = preferred
    ? [preferred, ...LEAGUE_PLATFORMS.filter((platformId) => platformId !== preferred)]
    : [...LEAGUE_PLATFORMS];
  const concurrency = Math.max(1, Math.min(3, Number(options.concurrency) || 3));
  const deadlineAt = Date.now() + Math.max(100, Math.min(15000, Number(options.timeoutMs) || 15000));

  for (let index = 0; index < platforms.length; index += concurrency) {
    if (Date.now() >= deadlineAt) throw new Error('TFT platform discovery timed out.');
    const batch = platforms.slice(index, index + concurrency);
    const results = await Promise.allSettled(batch.map((platformId) => beforeDeadline(
      fetchOpggTftStats(riotId, platformId, wantedPuuid),
      deadlineAt,
    )));
    for (let offset = 0; offset < results.length; offset += 1) {
      if (results[offset].status === 'fulfilled') {
        return { ...results[offset].value, platformId: batch[offset], platformSource: 'opgg-tft-discovery' };
      }
    }
  }
  throw new Error('No TFT platform matched both the requested Riot ID and PUUID.');
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
  const tier = String(row.tier || row.tierName || 'UNRANKED').trim().toUpperCase() || 'UNRANKED';
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
  const queues = rows.map(normalizeRankedQueue).filter((row) => wanted.has(row.queue));
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
  buildLeague, buildTft, buildStats, fetchOpggStats, fetchOpggTftStats, discoverOpggStats, discoverOpggTftStats,
  opggProfileUrl, uggProfileUrl, deeplolProfileUrl, dpmProfileUrl, profileLinks,
  opggRegion, uggRegion, deeplolRegion,
  LEAGUE_PLATFORMS, normalizeLeaguePlatform, canonicalLeaguePlatform, selectLeaguePlatform,
  leagueWallet, normalizeRankedQueue, priceLeagueRecord,
};
