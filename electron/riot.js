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
 * No secret (password, token, puuid) is ever written to disk by this module.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

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

function request(url, { method = 'GET', headers = {}, agent = null, body = null } = {}) {
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
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`HTTP ${res.statusCode} for ${u.pathname}`);
          error.statusCode = res.statusCode;
          error.pathname = u.pathname;
          return reject(error);
        }
        try { resolve(JSON.parse(text)); }
        catch { resolve(text); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Request timed out.')));
    if (body) req.write(body);
    req.end();
  });
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

  async local(pathname, { method = 'GET', body = null } = {}) {
    const verb = String(method).toUpperCase();
    if (!['GET', 'POST'].includes(verb)) throw new Error('Unsupported local Riot request method.');
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
    });
  }

  /** Read the current Riot account's social roster without exposing local auth. */
  async fetchChatFriends() {
    return this.local('/chat/v4/friends');
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
        throw new Error('No active Riot session. Open Riot Client and sign in, then try again.');
      }
      throw error;
    }
    let chat = {};
    try { chat = await request(`${base}/chat/v1/session`, { headers: H, agent: localAgent }); } catch { /* not ready */ }
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

  /** Current competitive rank + RR + peak for the signed-in account. */
  async fetchRank(session) {
    const url = `https://pd.${session.shard}.a.pvp.net/mmr/v1/players/${session.puuid}`;
    const data = await request(url, { headers: this.edgeHeaders(session) });
    const seasons = data?.QueueSkills?.competitive?.SeasonalInfoBySeasonID || {};
    let currentTier = 0, rr = 0, activeSeasonId = null;
    // Latest season = one with the most games or the last key.
    const seasonEntries = Object.entries(seasons);
    if (data?.LatestCompetitiveUpdate) {
      currentTier = data.LatestCompetitiveUpdate.TierAfterUpdate || 0;
      rr = data.LatestCompetitiveUpdate.RankedRatingAfterUpdate || 0;
    }
    let peakTier = 0;
    for (const [sid, info] of seasonEntries) {
      if (info.Rank && info.Rank > peakTier) peakTier = info.Rank;
      if (info.NumberOfGames && info.CompetitiveTier > currentTier && !data?.LatestCompetitiveUpdate) {
        currentTier = info.CompetitiveTier;
      }
      if (info.NumberOfGames) activeSeasonId = sid;
    }
    return {
      tier: currentTier,
      tierName: RANK_TIERS[currentTier] || 'Unranked',
      rr,
      peakTier,
      peakTierName: RANK_TIERS[peakTier] || 'Unranked',
      activeSeasonId,
    };
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

module.exports = { RiotClient, RANK_TIERS, VP_UUID };
