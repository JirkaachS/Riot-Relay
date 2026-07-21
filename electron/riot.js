'use strict';

/**
 * riot.js — Talks to the local Riot Client and the VALORANT edge services.
 *
 * Auth chain (all local, all read-only):
 *   lockfile  ->  local Basic auth  ->  /entitlements/v1/token (bearer + JWT)
 *             ->  /chat/v1/session  (puuid, gameName, tagLine)
 *             ->  region/shard resolve
 * Those tokens are then used against the public edge:
 *   pd.{shard}.a.pvp.net    -> MMR (rank) + entitlements (inventory)
 *   glz-{region}-1.{shard}  -> live match/party (optional)
 *
 * Local lockfile credentials remain in this main-process module. Most operations
 * are read-only; the narrowly scoped player-preferences methods also support a
 * user-triggered PUT with caller identity, backup, and read-back verification.
 * No secret (password, token, puuid) is ever written to disk by this module.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

// Accept the Riot Client's self-signed localhost certificate.
const localAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

const RANK_TIERS = [
  'Unranked', 'Unused1', 'Unused2',
  'Iron 1', 'Iron 2', 'Iron 3',
  'Bronze 1', 'Bronze 2', 'Bronze 3',
  'Silver 1', 'Silver 2', 'Silver 3',
  'Gold 1', 'Gold 2', 'Gold 3',
  'Platinum 1', 'Platinum 2', 'Platinum 3',
  'Diamond 1', 'Diamond 2', 'Diamond 3',
  'Ascendant 1', 'Ascendant 2', 'Ascendant 3',
  'Immortal 1', 'Immortal 2', 'Immortal 3',
  'Radiant',
];

// VALORANT Points currency UUID (used for store costs + wallet).
const VP_UUID = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';

const PLATFORM = Buffer.from(JSON.stringify({
  platformType: 'PC',
  platformOS: 'Windows',
  platformOSVersion: '10.0.19042.1.256.64bit',
  platformChipset: 'Unknown',
})).toString('base64');

const MAX_PLAYER_SETTINGS_BYTES = 8 * 1024 * 1024;
const PLAYER_PREFERENCES_TIMEOUT_MS = 3000;
const UX_PROCESS_MAX_BYTES = 256 * 1024;
const UX_PROCESS_SCRIPT = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'RiotClientUx.exe' -or $_.Name -eq 'Riot Client.exe' } | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress`;

function processFlag(commandLine, name) {
  const pattern = new RegExp(`(?:^|\\s)"?--${name}(?:=|\\s+)"?([^"\\s]+)"?(?=\\s|$)`, 'g');
  const matches = [...String(commandLine || '').matchAll(pattern)];
  return matches.length === 1 ? matches[0][1] : '';
}

/** Parse one trusted Riot UX process row without retaining its command line. */
function parseRiotClientUxProcessRows(stdout) {
  const text = String(stdout || '').trim();
  if (!text || Buffer.byteLength(text, 'utf8') > UX_PROCESS_MAX_BYTES) {
    throw new Error('Riot Client UX endpoint discovery failed.');
  }
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error('Riot Client UX endpoint discovery failed.'); }
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  if (rows.length > 64) throw new Error('Riot Client UX endpoint discovery failed.');
  const endpoints = [];
  for (const row of rows) {
    const executable = String(row && row.ExecutablePath || '');
    const commandLine = String(row && row.CommandLine || '');
    if (!executable || executable.length > 1024 || commandLine.length > 8192
      || /[\x00-\x1f\x7f]/.test(executable) || /[\x00\r\n]/.test(commandLine)) continue;
    const basename = path.win32.basename(executable).toLowerCase();
    const parent = path.win32.basename(path.win32.dirname(executable)).toLowerCase();
    const root = path.win32.basename(path.win32.dirname(path.win32.dirname(executable))).toLowerCase();
    const trustedLayout = root === 'riot client'
      && ((basename === 'riotclientux.exe' && parent === 'ux')
        || (basename === 'riot client.exe' && parent === 'riotclientelectron'));
    const portText = processFlag(commandLine, 'app-port');
    const token = processFlag(commandLine, 'remoting-auth-token');
    const port = Number(portText);
    const pid = Number(row && row.ProcessId);
    if (!trustedLayout || !/^\d{1,5}$/.test(portText) || port < 1 || port > 65535
      || !/^[A-Za-z0-9_-]{8,512}$/.test(token) || !Number.isInteger(pid) || pid < 1) continue;
    endpoints.push({ port, token, pid });
  }
  if (endpoints.length !== 1) {
    const error = new Error(endpoints.length
      ? 'Multiple Riot Client UX endpoints were found. Close duplicate Riot Client windows and retry.'
      : 'Riot Client UX is not ready. Open Riot Client and VALORANT to the main menu, then retry.');
    error.code = 'RIOT_UX_ENDPOINT_UNAVAILABLE';
    throw error;
  }
  return endpoints[0];
}

function resolveRiotClientUxEndpoint(run = execFile) {
  return new Promise((resolve, reject) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', UX_PROCESS_SCRIPT], {
      windowsHide: true, timeout: 6000, maxBuffer: UX_PROCESS_MAX_BYTES,
    }, (error, stdout) => {
      if (error) {
        const unavailable = new Error('Riot Client UX endpoint discovery failed. Open Riot Client and VALORANT to the main menu, then retry.');
        unavailable.code = 'RIOT_UX_ENDPOINT_UNAVAILABLE';
        reject(unavailable);
        return;
      }
      try { resolve(parseRiotClientUxProcessRows(stdout)); }
      catch (parseError) { reject(parseError); }
    });
  });
}

function request(url, {
  method = 'GET', headers = {}, agent = null, body = null, maxResponseBytes = 0, timeoutMs = 8000,
} = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers,
      agent,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      let size = 0;
      let rejectedForSize = false;
      const rejectOversized = () => {
        if (rejectedForSize) return;
        rejectedForSize = true;
        const error = new Error('The response exceeded the allowed size.');
        error.code = 'RESPONSE_TOO_LARGE';
        res.destroy();
        reject(error);
      };
      const declaredLength = Number(res.headers && res.headers['content-length']);
      if (maxResponseBytes > 0 && Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        rejectOversized();
        return;
      }
      res.on('data', (c) => {
        if (rejectedForSize) return;
        size += c.length;
        if (maxResponseBytes > 0 && size > maxResponseBytes) {
          rejectOversized();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (rejectedForSize) return;
        const text = Buffer.concat(chunks, size).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const hostLabel = u.hostname === '127.0.0.1'
            ? 'the local Riot Client'
            : u.hostname.endsWith('.a.pvp.net') ? 'the Riot game service' : 'the remote service';
          const error = new Error(`HTTP ${res.statusCode} from ${hostLabel}.`);
          error.statusCode = res.statusCode;
          error.pathname = u.pathname;
          error.body = text.slice(0, 400);
          return reject(error);
        }
        try { resolve(JSON.parse(text)); }
        catch { resolve(text); }
      });
    });
    req.on('error', reject);
    const boundedTimeout = Math.max(250, Math.min(30000, Number(timeoutMs) || 8000));
    req.setTimeout(boundedTimeout, () => req.destroy(new Error('Request timed out.')));
    if (body) req.write(body);
    req.end();
  });
}

function normalizedIdentity(value) {
  return String(value || '').trim().toLowerCase().split('/', 1)[0].split('@', 1)[0];
}

const VALORANT_MAPS = {
  ascent: 'Ascent', bonsai: 'Split', canyon: 'Fracture', duality: 'Bind', foxtrot: 'Breeze',
  infinity: 'Abyss', jam: 'Lotus', pitt: 'Pearl', port: 'Icebox', triad: 'Haven', range: 'The Range',
  corrode: 'Corrode',
};
const VALORANT_QUEUES = {
  competitive: 'Competitive', unrated: 'Unrated', swiftplay: 'Swiftplay', spikerush: 'Spike Rush',
  deathmatch: 'Deathmatch', ggteam: 'Team Deathmatch', onefa: 'Replication', escalation: 'Escalation',
  premier: 'Premier', hurm: 'Escalation', newmap: 'New Map', custom: 'Custom Game',
};

function boundedRankInteger(value, max = 1000000) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= max ? number : null;
}

function rankUnavailable(message) {
  const error = new Error(message);
  error.code = 'VALORANT_RANK_UNAVAILABLE';
  return error;
}

function rankFromMmr(data) {
  const seasons = data?.QueueSkills?.competitive?.SeasonalInfoBySeasonID || {};
  const tierOf = (info) => {
    const tier = boundedRankInteger(info && (info.CompetitiveTier ?? info.Rank), RANK_TIERS.length - 1);
    return tier !== null && RANK_TIERS[tier] ? tier : null;
  };
  const seasonEvidence = (info) => {
    if (!info || typeof info !== 'object' || Array.isArray(info)) return false;
    const games = boundedRankInteger(info.NumberOfGames, 100000);
    const tier = tierOf(info);
    const winsByTier = info.WinsByTier && typeof info.WinsByTier === 'object' ? Object.keys(info.WinsByTier) : [];
    return (games !== null && games > 0) || (tier !== null && tier > 0)
      || winsByTier.some((key) => (boundedRankInteger(key, RANK_TIERS.length - 1) || 0) > 0);
  };
  const seasonEntries = Object.entries(seasons)
    .filter(([, info]) => info && typeof info === 'object' && !Array.isArray(info))
    .slice(-100);
  const latest = data && data.LatestCompetitiveUpdate && typeof data.LatestCompetitiveUpdate === 'object'
    ? data.LatestCompetitiveUpdate : null;
  const latestSeasonId = String(latest && (latest.SeasonID || latest.SeasonId || latest.seasonId) || '').slice(0, 128);
  const latestSeasonInfo = latestSeasonId && seasons[latestSeasonId] && typeof seasons[latestSeasonId] === 'object'
    ? seasons[latestSeasonId] : null;
  const latestTier = boundedRankInteger(latest && latest.TierAfterUpdate, RANK_TIERS.length - 1);
  let activeEntry = latestSeasonInfo && seasonEvidence(latestSeasonInfo)
    ? [latestSeasonId, latestSeasonInfo]
    : [...seasonEntries].reverse().find(([, info]) => seasonEvidence(info)) || null;
  if (!activeEntry && latestSeasonId && latestTier !== null && latestTier > 0) activeEntry = [latestSeasonId, {}];
  if (!activeEntry) throw rankUnavailable('VALORANT competitive rank is temporarily unavailable; the last verified rank was kept.');

  const activeSeasonId = String(activeEntry[0]).slice(0, 128);
  const activeInfo = activeEntry[1];
  const activeGames = boundedRankInteger(activeInfo.NumberOfGames, 100000);
  const latestApplies = latest && (!latestSeasonId || latestSeasonId === activeSeasonId);
  const seasonalTier = tierOf(activeInfo);
  const currentTier = latestApplies && latestTier !== null && (latestTier > 0 || (activeGames !== null && activeGames > 0))
    ? latestTier : seasonalTier;
  if (currentTier === null || (currentTier === 0 && !(activeGames !== null && activeGames > 0))) {
    throw rankUnavailable('VALORANT competitive rank response had no authoritative tier; the last verified rank was kept.');
  }
  const latestRr = boundedRankInteger(latest && latest.RankedRatingAfterUpdate, 1000);
  const seasonalRr = boundedRankInteger(activeInfo.RankedRating, 1000);
  const rr = latestApplies && latestRr !== null ? latestRr : seasonalRr;

  let peakTier = currentTier;
  for (const [, info] of seasonEntries) {
    const seasonTier = tierOf(info);
    if (seasonTier !== null) peakTier = Math.max(peakTier, seasonTier);
    const winsByTier = info.WinsByTier && typeof info.WinsByTier === 'object' ? Object.keys(info.WinsByTier) : [];
    for (const tierKey of winsByTier.slice(0, RANK_TIERS.length)) {
      const wonTier = boundedRankInteger(tierKey, RANK_TIERS.length - 1);
      if (wonTier !== null) peakTier = Math.max(peakTier, wonTier);
    }
  }

  const pastSeasons = seasonEntries
    .filter(([seasonId, info]) => seasonId !== activeSeasonId && seasonEvidence(info))
    .slice(-20)
    .map(([seasonId, info]) => {
      const tier = tierOf(info);
      const games = boundedRankInteger(info.NumberOfGames, 100000);
      if (tier === null || (tier === 0 && !(games !== null && games > 0))) return null;
      return {
        seasonId: String(seasonId).slice(0, 128), tier, tierName: RANK_TIERS[tier] || 'Unranked',
        rr: boundedRankInteger(info.RankedRating, 1000), games, wins: boundedRankInteger(info.NumberOfWins, 100000),
      };
    })
    .filter(Boolean);

  return {
    tier: currentTier, tierName: RANK_TIERS[currentTier] || 'Unranked', rr,
    peakTier, peakTierName: RANK_TIERS[peakTier] || 'Unranked', activeSeasonId,
    authoritative: true, authoritativeUnranked: currentTier === 0, pastSeasons, source: 'mmr',
  };
}

function rankFromCompetitiveUpdates(data) {
  const rows = Array.isArray(data && data.Matches) ? data.Matches
    : Array.isArray(data && data.matches) ? data.matches : [];
  const candidates = rows.slice(0, 20).map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const queue = String(row.QueueID || row.Queue || row.queue || '').trim().toLowerCase();
    if (queue && queue !== 'competitive') return null;
    const tier = boundedRankInteger(row.TierAfterUpdate, RANK_TIERS.length - 1);
    const seasonId = String(row.SeasonID || row.SeasonId || row.seasonId || '').trim().slice(0, 128);
    if (tier === null || !seasonId || !RANK_TIERS[tier]) return null;
    const rawTime = row.MatchStartTime ?? row.StartTime ?? row.Timestamp;
    const numericTime = Number(rawTime);
    const parsedTime = Number.isFinite(numericTime) && numericTime > 0 ? numericTime : Date.parse(String(rawTime || ''));
    return {
      index, timestamp: Number.isFinite(parsedTime) ? parsedTime : 0, tier, seasonId,
      rr: boundedRankInteger(row.RankedRatingAfterUpdate, 1000),
    };
  }).filter(Boolean).sort((a, b) => b.timestamp - a.timestamp || a.index - b.index);
  const latest = candidates[0];
  if (!latest) throw rankUnavailable('VALORANT competitive history had no authoritative tier; the last verified rank was kept.');
  return {
    tier: latest.tier, tierName: RANK_TIERS[latest.tier] || 'Unranked', rr: latest.rr,
    peakTier: latest.tier, peakTierName: RANK_TIERS[latest.tier] || 'Unranked', activeSeasonId: latest.seasonId,
    authoritative: true, authoritativeUnranked: latest.tier === 0, pastSeasons: [],
    source: 'competitive-updates-fallback', limitedHistory: true,
  };
}

class RiotClient {
  constructor() {
    this.lockPath = path.join(os.homedir(), 'AppData', 'Local', 'Riot Games', 'Riot Client', 'Config', 'lockfile');
  }

  isRunning() {
    return fs.existsSync(this.lockPath);
  }

  readLockfile() {
    if (!this.isRunning()) throw new Error('Riot Client is not running. Launch it and sign in first.');
    const parts = fs.readFileSync(this.lockPath, 'utf8').trim().split(':');
    if (parts.length < 5) throw new Error('Unexpected lockfile format.');
    return { name: parts[0], pid: parts[1], port: parts[2], password: parts[3], protocol: parts[4] };
  }

  localHeaders(lock) {
    const basic = Buffer.from(`riot:${lock.password}`).toString('base64');
    return { Authorization: `Basic ${basic}`, Accept: 'application/json' };
  }

  async local(pathname, {
    method = 'GET', body = null, maxResponseBytes = 0, timeoutMs = 8000,
  } = {}) {
    const verb = String(method).toUpperCase();
    if (!['GET', 'POST', 'PUT'].includes(verb)) throw new Error('Unsupported local Riot request method.');
    const pathValue = String(pathname || '');
    if (!pathValue.startsWith('/')) throw new Error('Invalid local Riot request path.');
    const lock = this.readLockfile();
    const serialized = body == null ? null : JSON.stringify(body);
    const headers = this.localHeaders(lock);
    if (serialized != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(serialized);
    }
    return request(`https://127.0.0.1:${lock.port}${pathValue}`, {
      method: verb,
      headers,
      agent: localAgent,
      body: serialized,
      maxResponseBytes,
      timeoutMs,
    });
  }

  /** Read the current Riot account's social roster without exposing local auth. */
  async fetchChatFriends() {
    return this.local('/chat/v4/friends');
  }

  /** Read local chat presence rows; decoding and sanitization stay in the main process. */
  async fetchChatPresences() {
    return this.local('/chat/v4/presences');
  }

  /** Read one conversation, or all recent conversations when cid is omitted. */
  async fetchChatMessages(cid = '') {
    const suffix = cid ? `?cid=${encodeURIComponent(cid)}` : '';
    return this.local(`/chat/v6/messages${suffix}`);
  }

  /** Send through the authenticated local Riot Client session only. */
  async sendChatMessage(cid, message) {
    return this.local('/chat/v6/messages', {
      method: 'POST',
      body: { cid, message, type: 'chat' },
    });
  }

  /** Resolve only display-safe identity from the currently authenticated chat session. */
  async resolveChatSession() {
    let chat;
    try { chat = await this.local('/chat/v1/session'); }
    catch (error) {
      if (error && (error.statusCode === 401 || error.statusCode === 404)) {
        throw new Error('No active Riot chat session. Open Riot Client and sign in first.');
      }
      throw error;
    }
    const puuid = chat && (chat.puuid || chat.subject);
    if (!puuid) throw new Error('Riot chat is not ready yet. Wait for the friends list, then retry.');
    return {
      puuid,
      gameName: chat.game_name || chat.gameName || null,
      tagLine: chat.game_tag || chat.gameTag || null,
    };
  }

  /** Resolve tokens + identity + shard for the currently signed-in account. */
  async resolveSession() {
    const lock = this.readLockfile();
    const H = this.localHeaders(lock);
    const base = `https://127.0.0.1:${lock.port}`;

    let ent;
    try {
      ent = await request(`${base}/entitlements/v1/token`, { headers: H, agent: localAgent });
    } catch (error) {
      if (error && (error.statusCode === 401 || error.statusCode === 404)) {
        const unavailable = new Error('No active Riot session. Open Riot Client and sign in, then try again.');
        unavailable.code = 'RIOT_NOT_AUTHENTICATED';
        unavailable.statusCode = error.statusCode;
        throw unavailable;
      }
      throw error;
    }
    let chat = {};
    try { chat = await request(`${base}/chat/v1/session`, { headers: H, agent: localAgent }); } catch { /* not ready */ }
    if (chat.puuid && ent.subject && normalizedIdentity(chat.puuid) !== normalizedIdentity(ent.subject)) {
      throw new Error('Riot session identity sources disagreed; live data was rejected.');
    }
    const region = await request(`${base}/riotclient/region-locale`, { headers: H, agent: localAgent }).catch(() => ({}));

    // Client version for edge headers.
    let clientVersion = null;
    try {
      const sessions = await request(`${base}/product-session/v1/external-sessions`, { headers: H, agent: localAgent });
      const val = Object.values(sessions).find((s) => s && s.productId === 'valorant');
      if (val && val.version) clientVersion = val.version;
    } catch { /* fall through */ }
    if (!clientVersion) {
      try { clientVersion = (await request('https://valorant-api.com/v1/version')).data.riotClientVersion; } catch { /* ignore */ }
    }

    const shard = this._resolveShard(region);

    return {
      accessToken: ent.accessToken,
      entitlementsToken: ent.token,
      subject: ent.subject,
      puuid: chat.puuid || ent.subject,
      gameName: chat.game_name || null,
      tagLine: chat.game_tag || null,
      region: (region.region || '').toLowerCase(),
      shard,
      clientVersion,
    };
  }

  _resolveShard(region) {
    const key = `${region.webRegion || ''} ${region.region || ''}`.toLowerCase();
    if (/pbe/.test(key)) return 'pbe';
    if (/\bkr\b/.test(key)) return 'kr';
    if (/eu|euw|eune|tr|ru/.test(key)) return 'eu';
    if (/ap|jp|oce|sg/.test(key)) return 'ap';
    if (/na|latam|lan|las|br/.test(key)) return 'na';
    return 'na';
  }

  edgeHeaders(session) {
    return {
      Authorization: `Bearer ${session.accessToken}`,
      'X-Riot-Entitlements-JWT': session.entitlementsToken,
      'X-Riot-ClientVersion': session.clientVersion || '',
      'X-Riot-ClientPlatform': PLATFORM,
      Accept: 'application/json',
    };
  }

  /** Current competitive rank + RR, peak, and bounded act history for the signed-in account. */
  async fetchRank(session) {
    const baseUrl = `https://pd.${session.shard}.a.pvp.net/mmr/v1/players/${session.puuid}`;
    try {
      return rankFromMmr(await request(baseUrl, { headers: this.edgeHeaders(session) }));
    } catch (error) {
      if (!error || error.statusCode < 500 || error.statusCode > 599) throw error;
      const fallbackUrl = `${baseUrl}/competitiveupdates?startIndex=0&endIndex=20&queue=competitive`;
      try {
        return rankFromCompetitiveUpdates(await request(fallbackUrl, { headers: this.edgeHeaders(session) }));
      } catch (fallbackError) {
        if (fallbackError && fallbackError.code === 'VALORANT_RANK_UNAVAILABLE') throw fallbackError;
        throw rankUnavailable('VALORANT rank services are temporarily unavailable; the last verified rank was kept.');
      }
    }
  }

  async fetchPlayerCard(session) {
    try {
      const loadout = await request(
        `https://pd.${session.shard}.a.pvp.net/personalization/v2/players/${session.puuid}/playerloadout`,
        { headers: this.edgeHeaders(session) },
      );
      const id = loadout?.Identity?.PlayerCardID;
      if (!id) return null;
      const card = await request(`https://valorant-api.com/v1/playercards/${id}`);
      return {
        id,
        smallArt: card?.data?.smallArt || null,
        wideArt: card?.data?.wideArt || null,
        largeArt: card?.data?.largeArt || null,
      };
    } catch { return null; }
  }

  /** Account level + title from the local API + edge. */
  async fetchAccountXP(session) {
    try {
      const url = `https://pd.${session.shard}.a.pvp.net/account-xp/v1/players/${session.puuid}`;
      const data = await request(url, { headers: this.edgeHeaders(session) });
      return { level: data?.Progress?.Level || 0 };
    } catch {
      return { level: 0 };
    }
  }

  /**
   * Full owned-entitlements pull across every cosmetic category.
   * Returns a map { categoryKey: [uuid,...] }.
   */
  async fetchEntitlements(session) {
    const categories = {
      Agents: '01bb38e1-da47-4e6a-9b3d-945fe4655707',
      Contracts: 'f85cb6f7-33e5-4dc8-b609-ec7212301948',
      Sprays: 'd5f120f8-ff8c-4aac-92ea-f2b5acbe9475',
      Buddies: 'dd3bf334-87f3-40bd-b043-682a57a8dc3a',
      Cards: '3f296c07-64c3-494c-923b-fe692a4fa1bd',
      Skins: 'e7c63390-eda7-46e0-bb7a-a6abdacd2433',
      SkinVariants: '3ad1b2b2-acdb-4524-852f-954a76ddae0a',
      Titles: 'de7caa6b-adf7-4588-bbd1-143831e786c6',
    };
    const H = this.edgeHeaders(session);
    const out = {};
    for (const [name, typeId] of Object.entries(categories)) {
      try {
        const url = `https://pd.${session.shard}.a.pvp.net/store/v1/entitlements/${session.puuid}/${typeId}`;
        const res = await request(url, { headers: H });
        const groups = res.EntitlementsByTypes ? res.EntitlementsByTypes : [res];
        const ids = [];
        for (const g of groups) for (const it of g.Entitlements || []) ids.push(it.ItemID);
        out[name] = ids;
      } catch {
        out[name] = [];
      }
    }
    return out;
  }

  // Routes and body types confirmed by the Riot Client OpenAPI. The data-json
  // routes accept an object; the /data route accepts the same decoded JSON as a
  // JSON string (it is not base64). Key/type is "Ares.PlayerSettings".
  _prefPaths() {
    return [
      '/player-preferences/v1/data-json/productId/valorant/type/Ares.PlayerSettings',
      '/player-preferences/v1/data-json/Ares.PlayerSettings',
      '/player-preferences/v1/data/Ares.PlayerSettings',
    ];
  }

  _prefReason(error) {
    const status = error && Number.isInteger(error.statusCode) ? `HTTP ${error.statusCode}` : '';
    if (error && error.statusCode === 404) return 'HTTP 404: this player-preferences route is unavailable in the running Riot Client';
    if (error && (error.statusCode === 401 || error.statusCode === 403)) return `${status}: local Riot Client authorization was rejected`;
    if (error && error.statusCode >= 500) return `${status}: the player-preferences plugin returned a server error`;
    if (status) return `${status}: the player-preferences request was rejected`;
    if (error && error.code === 'RESPONSE_TOO_LARGE') return 'the response exceeded the allowed size';
    if (error && error.code === 'RIOT_UX_ENDPOINT_UNAVAILABLE') return 'the Riot Client UX endpoint is unavailable';
    return 'local player-preferences request failed';
  }

  async _resolvePlayerPreferencesEndpoint() {
    return resolveRiotClientUxEndpoint();
  }

  /** Use UX remoting only for the tightly allowlisted player-preferences API. */
  async playerPreferencesLocal(endpoint, pathname, {
    method = 'GET', body = null,
  } = {}) {
    const allowedPaths = new Set(['/player-preferences/v1/ready', ...this._prefPaths()]);
    const pathValue = String(pathname || '');
    const verb = String(method || 'GET').toUpperCase();
    const port = Number(endpoint && endpoint.port);
    const token = String(endpoint && endpoint.token || '');
    if (!allowedPaths.has(pathValue)) throw new Error('Unsupported player-preferences request path.');
    if (!['GET', 'PUT'].includes(verb)) throw new Error('Unsupported player-preferences request method.');
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{8,512}$/.test(token)) {
      const error = new Error('The Riot Client UX endpoint is unavailable.');
      error.code = 'RIOT_UX_ENDPOINT_UNAVAILABLE';
      throw error;
    }
    let serialized = null;
    if (body != null) {
      serialized = JSON.stringify(body);
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_PLAYER_SETTINGS_BYTES) {
        throw new Error('The VALORANT settings payload was unexpectedly large.');
      }
    }
    const basic = Buffer.from(`riot:${token}`).toString('base64');
    const headers = { Authorization: `Basic ${basic}`, Accept: 'application/json' };
    if (serialized != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(serialized);
    }
    try {
      return await request(`https://127.0.0.1:${port}${pathValue}`, {
        method: verb,
        headers,
        agent: localAgent,
        body: serialized,
        maxResponseBytes: MAX_PLAYER_SETTINGS_BYTES,
        timeoutMs: PLAYER_PREFERENCES_TIMEOUT_MS,
      });
    } catch (error) {
      const sanitized = new Error('The Riot Client UX player-preferences request failed.');
      if (error && Number.isInteger(error.statusCode)) sanitized.statusCode = error.statusCode;
      if (error && error.code === 'RESPONSE_TOO_LARGE') sanitized.code = error.code;
      throw sanitized;
    }
  }

  async _ensurePlayerPreferencesReady(endpoint) {
    try {
      const ready = await this.playerPreferencesLocal(endpoint, '/player-preferences/v1/ready');
      if (ready !== true && ready !== 'true') throw new Error('PLAYER_PREFERENCES_NOT_READY');
    } catch (error) {
      if (error && error.message === 'PLAYER_PREFERENCES_NOT_READY') {
        throw new Error('The Riot Client player-preferences plugin is still starting. Open VALORANT, wait for the main menu, then retry.');
      }
      if (error && error.statusCode === 404) {
        const unavailable = new Error('Riot’s player-preferences plugin is not loaded. Open VALORANT, wait at the main menu, then retry Capture.');
        unavailable.code = 'PLAYER_PREFERENCES_PLUGIN_UNAVAILABLE';
        throw unavailable;
      }
      throw new Error(`The Riot Client player-preferences plugin readiness check failed (${this._prefReason(error)}).`);
    }
  }

  async _callPlayerPreferences(endpoint, pathname, options = {}) {
    return this.playerPreferencesLocal(endpoint, pathname, options);
  }

  _decodePlayerSettings(value) {
    if (value == null || value === '') return { json: null, parsed: null, envelope: false };
    let serialized;
    try { serialized = typeof value === 'string' ? value : JSON.stringify(value); }
    catch { throw new Error('The Riot Client returned malformed VALORANT settings JSON.'); }
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_PLAYER_SETTINGS_BYTES) {
      throw new Error('The VALORANT settings payload was unexpectedly large.');
    }
    let parsed;
    try { parsed = JSON.parse(serialized); }
    catch { throw new Error('The Riot Client returned malformed VALORANT settings JSON.'); }

    // Both player-preferences routes return the same three-field envelope. The
    // data-json route exposes data as an object; /data exposes it as a JSON
    // string. Persist and write only the Ares.PlayerSettings data document.
    const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
    const envelope = keys.length === 3
      && keys.every((key) => ['data', 'type', 'modified'].includes(key))
      && keys.includes('data') && keys.includes('type') && keys.includes('modified')
      && parsed.type === 'Ares.PlayerSettings';
    if (envelope) {
      try { parsed = typeof parsed.data === 'string' ? JSON.parse(parsed.data) : parsed.data; }
      catch { throw new Error('The Riot Client returned malformed VALORANT settings data.'); }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('The Riot Client returned an invalid VALORANT settings document.');
    }
    const json = JSON.stringify(parsed);
    if (Buffer.byteLength(json, 'utf8') > MAX_PLAYER_SETTINGS_BYTES) {
      throw new Error('The VALORANT settings payload was unexpectedly large.');
    }
    return { json, parsed, envelope };
  }

  async _readPlayerSettings(endpoint, { skipReady = false } = {}) {
    if (!skipReady) await this._ensurePlayerPreferencesReady(endpoint);
    const routeErrors = [];
    for (const pathname of this._prefPaths()) {
      try {
        const decoded = this._decodePlayerSettings(await this._callPlayerPreferences(endpoint, pathname));
        return { json: decoded.json, path: pathname };
      } catch (error) { routeErrors.push(error); }
    }
    if (routeErrors.length && routeErrors.every((error) => error && error.statusCode === 404)) {
      throw new Error('No compatible VALORANT player-preferences route is exposed by this Riot Client build. Open VALORANT to the main menu and retry.');
    }
    throw new Error(`VALORANT settings could not be read from the local Riot Client (${this._prefReason(routeErrors[routeErrors.length - 1])}).`);
  }

  /** Read the signed-in account's complete Ares.PlayerSettings document. */
  async getPlayerSettings() {
    const endpoint = await this._resolvePlayerPreferencesEndpoint();
    return this._readPlayerSettings(endpoint);
  }

  /**
   * Overwrite Ares.PlayerSettings, then read the same route back and require an
   * exact JSON value match. The caller must verify the target PUUID immediately
   * before this live account-state mutation.
   */
  async savePlayerSettings(json, preferredPath = '', options = {}) {
    const reportStage = typeof options.onStage === 'function'
      ? (stage) => { try { options.onStage(stage); } catch { /* diagnostics must not change writes */ } }
      : () => {};
    if (typeof json !== 'string' || !json.trim()) throw new Error('Refusing to write empty VALORANT settings.');
    if (Buffer.byteLength(json, 'utf8') > MAX_PLAYER_SETTINGS_BYTES) {
      throw new Error('The stored VALORANT settings payload was unexpectedly large.');
    }
    let decoded;
    try { decoded = this._decodePlayerSettings(json); }
    catch { throw new Error('The stored VALORANT settings were not a valid settings document.'); }
    const { parsed } = decoded;
    const normalizedJson = decoded.json;

    // Resolve once and pin this endpoint for route proof, the one PUT, and
    // exact-route read-back. A UX restart therefore fails closed.
    const endpoint = await this._resolvePlayerPreferencesEndpoint();
    await this._ensurePlayerPreferencesReady(endpoint);
    reportStage('endpoint-ready');
    const knownPaths = this._prefPaths();
    let pathname = preferredPath && knownPaths.includes(preferredPath) ? preferredPath : '';
    if (pathname) {
      try { this._decodePlayerSettings(await this._callPlayerPreferences(endpoint, pathname)); }
      catch { pathname = ''; }
    }
    if (!pathname) pathname = (await this._readPlayerSettings(endpoint, { skipReady: true })).path;
    reportStage('route-proven');

    const body = pathname.includes('/data-json/') ? parsed : normalizedJson;
    try {
      await this._callPlayerPreferences(endpoint, pathname, { method: 'PUT', body });
      reportStage('put-accepted');
    } catch (error) {
      throw new Error(`The local Riot Client rejected the VALORANT settings write (${this._prefReason(error)}).`);
    }

    // Never try a second mutation route after a PUT is accepted. Read the exact
    // same route back through the pinned endpoint and require structural equality.
    let readBack;
    try {
      readBack = this._decodePlayerSettings(await this._callPlayerPreferences(endpoint, pathname));
      reportStage('readback-fetched');
    } catch (error) {
      throw new Error(`The Riot Client accepted the VALORANT settings write, but read-back verification failed (${this._prefReason(error)}).`);
    }
    if (!readBack.json || !require('node:util').isDeepStrictEqual(readBack.parsed, parsed)) {
      reportStage('readback-mismatch');
      throw new Error('The Riot Client accepted the VALORANT settings write, but the read-back value did not match. Restore the retained backup before retrying.');
    }
    reportStage('write-verified');
    return { saved: true, verified: true, path: pathname };
  }

  /** Wallet: VP / Radianite / Kingdom credits. */
  async fetchWallet(session) {
    try {
      const url = `https://pd.${session.shard}.a.pvp.net/store/v1/wallet/${session.puuid}`;
      const data = await request(url, { headers: this.edgeHeaders(session) });
      const b = data.Balances || {};
      return {
        vp: b[VP_UUID] || 0,
        radianite: b['e59aa87c-4cbf-517a-5983-6e81511be9b7'] || 0,
        kingdom: b['85ca954a-41f2-ce94-9b45-8ca3dd39a00d'] || 0,
      };
    } catch {
      return { vp: 0, radianite: 0, kingdom: 0 };
    }
  }

  /**
   * Store offers -> a { itemId(lowercased): vpCost } map.
   * Used to estimate the VP value of an owned inventory. Only items that are
   * (or were) purchasable from the store carry a price here.
   */
  async fetchOffers(session) {
    try {
      const url = `https://pd.${session.shard}.a.pvp.net/store/v1/offers/`;
      const data = await request(url, { headers: this.edgeHeaders(session) });
      const map = {};
      for (const offer of data.Offers || []) {
        const cost = (offer.Cost && offer.Cost[VP_UUID]) || 0;
        if (!cost) continue;
        if (offer.OfferID) map[String(offer.OfferID).toLowerCase()] = cost;
        for (const r of offer.Rewards || []) {
          if (r.ItemID) map[String(r.ItemID).toLowerCase()] = cost;
        }
      }
      return map;
    } catch {
      return {};
    }
  }
}

module.exports = {
  RiotClient,
  RANK_TIERS,
  VP_UUID,
  VALORANT_MAPS,
  VALORANT_QUEUES,
  parseRiotClientUxProcessRows,
  resolveRiotClientUxEndpoint,
  rankFromMmr,
  rankFromCompetitiveUpdates,
};
