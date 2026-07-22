'use strict';

/**
 * valorant.js — Cosmetic metadata catalog + inventory enrichment.
 *
 * Pulls public, non-authenticated cosmetic metadata from valorant-api.com,
 * caches it on disk (24h TTL), and joins it against a set of owned UUIDs to
 * produce a rich, display-ready inventory model.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ENDPOINTS = {
  weapons: 'https://valorant-api.com/v1/weapons',
  tiers: 'https://valorant-api.com/v1/contenttiers',
  sprays: 'https://valorant-api.com/v1/sprays',
  buddies: 'https://valorant-api.com/v1/buddies',
  cards: 'https://valorant-api.com/v1/playercards',
  titles: 'https://valorant-api.com/v1/playertitles',
  agents: 'https://valorant-api.com/v1/agents?isPlayableCharacter=true',
};
// /v1/seasons/competitive only carries season *windows* (start/end time,
// competitive tier set) and has no displayName/parentUuid at all. The actual
// human-readable act/episode names only exist on the plain /v1/seasons list.
const SEASONS_ENDPOINT = 'https://valorant-api.com/v1/seasons';
const SEASON_CACHE_TTL = 24 * 60 * 60 * 1000;
let seasonNameCache = null; // Map<uuid, displayName>
let seasonNameCacheAt = 0;
let seasonNamePromise = null;

/**
 * Map a competitive act/episode UUID (the raw key Riot uses for
 * SeasonalInfoBySeasonID) to a human act name via valorant-api.com. Falls
 * back to an empty map on any failure so callers can degrade gracefully
 * instead of ever displaying the raw UUID as a "season".
 */
async function seasonActNames() {
  if (seasonNameCache && Date.now() - seasonNameCacheAt < SEASON_CACHE_TTL) return seasonNameCache;
  if (seasonNamePromise) return seasonNamePromise;
  seasonNamePromise = (async () => {
    try {
      const seasons = await getJSON(SEASONS_ENDPOINT);
      const map = new Map();
      for (const season of Array.isArray(seasons) ? seasons : []) {
        const uuid = String(season && season.uuid || '').toLowerCase();
        if (!uuid) continue;
        map.set(uuid, season);
      }
      // Resolve each act's human label by walking up to its parent episode,
      // since act entries alone are just "ACT I"/"ACT II"/"ACT III".
      const names = new Map();
      for (const [uuid, season] of map) {
        const parent = season.parentUuid ? map.get(String(season.parentUuid).toLowerCase()) : null;
        const episodeLabel = parent && parent.displayName ? parent.displayName : '';
        const actLabel = season.displayName || '';
        names.set(uuid, [episodeLabel, actLabel].filter(Boolean).join(' ').trim() || null);
      }
      seasonNameCache = names;
      seasonNameCacheAt = Date.now();
      return names;
    } catch {
      return seasonNameCache || new Map();
    } finally {
      seasonNamePromise = null;
    }
  })();
  return seasonNamePromise;
}

const TIER_ORDER = ['Ultra Edition', 'Exclusive Edition', 'Premium Edition', 'Deluxe Edition', 'Select Edition', 'Standard'];
const CACHE_TTL = 24 * 60 * 60 * 1000;

// Standard VP prices per VALORANT content tier. Used when a live store offer
// isn't available (e.g. the skin isn't currently purchasable), so every skin
// still shows an accurate, expected price rather than 0.
const TIER_PRICES = {
  'Select Edition': 875,
  'Deluxe Edition': 1275,
  'Premium Edition': 1775,
  'Ultra Edition': 2475,
  'Exclusive Edition': 2675,
};

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(body.data);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const norm = (v) => String(v || '').trim().toLowerCase();
const safeColor = (v) => (/^#?[0-9a-f]{6,8}$/i.test(v || '') ? '#' + String(v).replace('#', '').slice(0, 6) : '#5a6b7a');

function vtlProfileUrl(riotId) {
  const value = String(riotId || '').trim();
  const separator = value.lastIndexOf('#');
  const gameName = separator > 0 ? value.slice(0, separator).trim() : '';
  const tagLine = separator > 0 ? value.slice(separator + 1).trim() : '';
  if (!gameName || !tagLine) throw new Error('A complete Riot ID is required for a VTL.LOL profile.');
  const encode = (part) => encodeURIComponent(part).replace(/%20/g, '+');
  return `https://vtl.lol/id/${encode(gameName)}_${encode(tagLine)}`;
}

function trackerProfileUrl(riotId) {
  const value = String(riotId || '').trim();
  const separator = value.lastIndexOf('#');
  const gameName = separator > 0 ? value.slice(0, separator).trim() : '';
  const tagLine = separator > 0 ? value.slice(separator + 1).trim() : '';
  if (!gameName || !tagLine) throw new Error('A complete Riot ID is required for a Tracker.gg profile.');
  return `https://tracker.gg/valorant/profile/riot/${encodeURIComponent(`${gameName}#${tagLine}`)}/overview`;
}

class Catalog {
  constructor(dir) {
    this.cacheFile = path.join(dir, 'catalog-cache.json');
    this.raw = null;      // { weapons, tiers, sprays, buddies, cards, titles, agents }
    this.index = null;    // Map<uuid, entry>
    this.tierRank = (name) => { const i = TIER_ORDER.indexOf(name); return i < 0 ? 99 : i; };
  }

  _loadCache() {
    if (!fs.existsSync(this.cacheFile)) return null;
    try {
      const c = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (Date.now() - c.ts < CACHE_TTL) return c.data;
    } catch { /* fall through */ }
    return null;
  }

  async load(force = false) {
    if (!force) {
      const cached = this._loadCache();
      if (cached) { this.raw = cached; this._buildIndex(); return { source: 'cache' }; }
    }
    const [weapons, tiers, sprays, buddies, cards, titles, agents] = await Promise.all([
      getJSON(ENDPOINTS.weapons), getJSON(ENDPOINTS.tiers), getJSON(ENDPOINTS.sprays),
      getJSON(ENDPOINTS.buddies), getJSON(ENDPOINTS.cards), getJSON(ENDPOINTS.titles),
      getJSON(ENDPOINTS.agents),
    ]);
    this.raw = { weapons, tiers, sprays, buddies, cards, titles, agents };
    fs.writeFileSync(this.cacheFile, JSON.stringify({ ts: Date.now(), data: this.raw }));
    this._buildIndex();
    return { source: 'network' };
  }

  _buildIndex() {
    const idx = new Map();
    const tierMap = new Map();
    (this.raw.tiers || []).forEach((t) =>
      tierMap.set(norm(t.uuid), { name: t.displayName || 'Standard', color: safeColor(t.highlightColor) }));

    // Weapon skins (+ levels + chromas map back to the parent skin).
    (this.raw.weapons || []).forEach((weapon) =>
      (weapon.skins || []).forEach((skin) => {
        const tier = tierMap.get(norm(skin.contentTierUuid)) || { name: 'Standard', color: '#5a6b7a' };
        const levelIds = (skin.levels || []).map((l) => norm(l.uuid)).filter(Boolean);
        const chromaIds = (skin.chromas || []).map((c) => norm(c.uuid)).filter(Boolean);
        const entry = {
          type: 'Skin',
          uuid: norm(skin.uuid),
          name: skin.displayName || 'Unnamed',
          category: weapon.displayName || 'Weapon',
          tier: tier.name,
          tierColor: tier.color,
          image: skin.displayIcon || skin.chromas?.[0]?.fullRender || skin.levels?.[0]?.displayIcon || '',
          // Keys used to look up a VP price in the store-offers map.
          priceKeys: [norm(skin.uuid), ...levelIds, ...chromaIds],
        };
        idx.set(entry.uuid, entry);
        (skin.levels || []).forEach((lv) => lv.uuid && idx.set(norm(lv.uuid), { ...entry, variantOf: entry.uuid }));
        (skin.chromas || []).forEach((ch) => ch.uuid && idx.set(norm(ch.uuid), {
          ...entry, variantOf: entry.uuid, image: ch.fullRender || ch.displayIcon || entry.image,
        }));
      }));

    const simple = (arr, type, category, imgKey = 'displayIcon') =>
      (arr || []).forEach((x) => idx.set(norm(x.uuid), {
        type, uuid: norm(x.uuid), name: x.displayName || x.titleText || 'Unnamed',
        category, tier: 'Standard', tierColor: '#5a6b7a', image: x[imgKey] || '',
        priceKeys: [norm(x.uuid)],
      }));

    simple(this.raw.sprays, 'Spray', 'Sprays', 'fullTransparentIcon');
    simple(this.raw.buddies, 'Buddy', 'Gun Buddies');
    simple(this.raw.cards, 'Card', 'Player Cards', 'largeArt');
    simple(this.raw.titles, 'Title', 'Titles');
    simple(this.raw.agents, 'Agent', 'Agents');
    // Titles have no icon; keep a text placeholder handled in the UI.

    this.index = idx;
  }

  stats() {
    if (!this.index) return { total: 0 };
    return { total: this.index.size };
  }

  /**
   * Best-known VP price for a skin: prefer the live store offer, otherwise fall
   * back to the standard price for its content tier. Non-tiered / battlepass /
   * exclusive-only skins with no offer resolve to their tier price (or 0).
   */
  _priceFor(item, offers) {
    if (offers) {
      for (const k of item.priceKeys || [item.uuid]) {
        if (offers[k]) return offers[k];
      }
    }
    return TIER_PRICES[item.tier] || 0;
  }

  /**
   * Join owned entitlement UUIDs -> rich items.
   * @param {object} entitlements { Skins:[...], Sprays:[...], ... }
   * @param {object} offers       optional { itemId: vpCost } store-price map
   */
  build(entitlements, offers = null) {
    if (!this.index) throw new Error('Catalog not loaded.');
    const owned = new Map(); // parent uuid -> item (dedupe skin variants)
    const unknown = [];
    const allIds = Object.values(entitlements || {}).flat();

    for (const id of allIds) {
      const key = norm(id);
      const meta = this.index.get(key);
      if (!meta) { unknown.push(key); continue; }
      const parent = meta.variantOf || meta.uuid;
      if (!owned.has(parent)) {
        const base = this.index.get(parent) || meta;
        // Valuation is skins-only: other cosmetics aren't meaningfully priced.
        const value = base.type === 'Skin' ? this._priceFor(base, offers) : 0;
        owned.set(parent, { ...base, variants: 0, value });
      }
      if (meta.variantOf) owned.get(parent).variants += 1;
    }

    const items = [...owned.values()].sort((a, b) =>
      this.tierRank(a.tier) - this.tierRank(b.tier) || (b.value || 0) - (a.value || 0) || a.name.localeCompare(b.name));

    const byType = {};
    const byTier = {};
    const valueByType = {};
    let totalValue = 0;
    for (const it of items) {
      byType[it.type] = (byType[it.type] || 0) + 1;
      byTier[it.tier] = (byTier[it.tier] || 0) + 1;
      if (it.type === 'Skin') {
        const v = it.value || 0;
        valueByType.Skin = (valueByType.Skin || 0) + v;
        totalValue += v;
      }
    }

    return {
      items,
      summary: {
        total: items.length,
        unknown: unknown.length,
        byType,
        byTier,
        totalValue,
        valueByType,
        priced: !!offers,
      },
      tierOrder: TIER_ORDER,
    };
  }
}

module.exports = { Catalog, TIER_ORDER, vtlProfileUrl, trackerProfileUrl, seasonActNames };
