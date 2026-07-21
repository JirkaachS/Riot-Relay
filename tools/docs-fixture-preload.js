'use strict';

const { contextBridge } = require('electron');

const ok = (data) => Promise.resolve({ ok: true, data });
const noop = () => {};
const configActivityListeners = new Set();
const emitConfigActivity = (operation, stage, outcome = 'info') => {
  const activity = { time: new Date().toISOString(), operation, stage, outcome };
  for (const listener of configActivityListeners) listener(activity);
};

const stats = {
  valorant: {
    available: true,
    level: 247,
    rank: {
      tier: 21, tierName: 'Ascendant 2', rr: 64, peakTier: 22, peakTierName: 'Immortal 1',
      pastSeasons: [
        { seasonId: 'synthetic-act-1', tier: 18, tierName: 'Diamond 2', rr: 71, games: 42, wins: 24 },
        { seasonId: 'synthetic-act-2', tier: 20, tierName: 'Ascendant 1', rr: 33, games: 56, wins: 31 },
      ],
    },
  },
  league: {
    available: true, source: 'opgg', platformId: 'EUW1',
    queues: [
      { queue: 'RANKED_SOLO_5x5', tier: 'EMERALD', division: 'II', lp: 54, wins: 68, losses: 51 },
      { queue: 'RANKED_FLEX_SR', tier: 'PLATINUM', division: 'I', lp: 22, wins: 31, losses: 27 },
    ],
    pastSeasons: [
      { seasonId: 'S2024', queue: 'RANKED_SOLO_5x5', tier: 'PLATINUM', division: 'I', lp: 62, wins: 59, losses: 48 },
      { seasonId: 'S2025', queue: 'RANKED_SOLO_5x5', tier: 'EMERALD', division: 'IV', lp: 18, wins: 72, losses: 63 },
    ],
  },
  tft: {
    available: true, source: 'opgg', platformId: 'EUW1',
    queues: [{ queue: 'RANKED_TFT', tier: 'DIAMOND', division: 'IV', lp: 38, wins: 9, losses: 17 }],
    pastSeasons: [
      { seasonId: 'Set 13', queue: 'RANKED_TFT', tier: 'EMERALD', division: 'II', lp: 44, wins: 7, losses: 18 },
      { seasonId: 'Set 14', queue: 'RANKED_TFT', tier: 'DIAMOND', division: 'IV', lp: 12, wins: 11, losses: 21 },
    ],
  },
};

const accounts = [
  {
    id: 'demo-primary', label: 'Primary', username: 'synthetic.login', riotId: 'RelayDemo#001',
    puuid: 'synthetic-puuid-primary', leaguePlatformId: 'EUW1', favorite: true, hasPassword: true, hasSession: true,
    level: 247, rankTier: 21, rankName: 'Ascendant 2', rr: 64, peakTier: 22, peakName: 'Immortal 1', stats,
    lastSynced: '2026-07-20T12:00:00.000Z',
  },
  {
    id: 'demo-ranked', label: 'Ranked practice', username: 'practice.login', riotId: 'Practice#EUW',
    puuid: 'synthetic-puuid-ranked', leaguePlatformId: 'EUW1', favorite: false, hasPassword: true, hasSession: true,
    level: 116, rankTier: 17, rankName: 'Diamond 1', rr: 38, peakTier: 18, peakName: 'Diamond 2', stats,
    lastSynced: '2026-07-19T19:30:00.000Z',
  },
  {
    id: 'demo-alt', label: 'Alternate', username: 'alternate.login', riotId: 'Alternate#TFT',
    puuid: 'synthetic-puuid-alt', leaguePlatformId: 'EUN1', favorite: false, hasPassword: true, hasSession: false,
    level: 73, rankTier: 12, rankName: 'Gold 3', rr: 77, stats,
    lastSynced: '2026-07-18T08:15:00.000Z',
  },
];
const skinRows = [
  ['Arcade Ahri', 'Ahri skin', 'Epic', '#6d72c8', 1350, 'ahri', 'skin04', 4],
  ['Spirit Blossom Ahri', 'Ahri skin', 'Legendary', '#c48b48', 1820, 'ahri', 'skin27', 27],
  ['PROJECT: Yasuo', 'Yasuo skin', 'Epic', '#6d72c8', 1350, 'yasuo', 'skin09', 9],
  ['High Noon Lucian', 'Lucian skin', 'Legendary', '#c48b48', 1820, 'lucian', 'skin08', 8],
  ['Star Guardian Jinx', 'Jinx skin', 'Legendary', '#c48b48', 1820, 'jinx', 'skin04', 4],
  ['K/DA Kai’Sa', 'Kai’Sa skin', 'Epic', '#6d72c8', 1350, 'kaisa', 'skin01', 1],
  ['Coven Evelynn', 'Evelynn skin', 'Epic', '#6d72c8', 1350, 'evelynn', 'skin08', 8],
  ['Winterblessed Diana', 'Diana skin', 'Legendary', '#c48b48', 1820, 'diana', 'skin47', 47],
];

const inventoryItems = skinRows.map(([name, category, tier, tierColor, value, champion, folder, number], index) => ({
  id: `synthetic-skin-${index + 1}`,
  name,
  category,
  type: 'Skin',
  tier,
  tierColor,
  value,
  currency: 'RP',
  variants: index % 3,
  fit: 'cover',
  image: `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/characters/${champion}/skins/${folder}/images/${champion}_splash_centered_${number}.jpg`,
}));

const totalValue = inventoryItems.reduce((sum, item) => sum + item.value, 0);
const inventory = {
  game: 'lol',
  riotId: 'RelayDemo#001',
  wallet: { rp: 2475, blueEssence: 48320 },
  tierOrder: ['Ultimate', 'Mythic', 'Legendary', 'Epic', 'Standard'],
  items: inventoryItems,
  summary: {
    total: inventoryItems.length,
    totalValue,
    byType: { Skin: inventoryItems.length },
    valueByType: { Skin: totalValue },
  },
};

const currentSession = {
  puuid: 'synthetic-puuid-primary', riotId: 'RelayDemo#001', shard: 'eu',
  matchingAccountIds: ['demo-primary'], rank: stats.valorant.rank, stats,
};
let settings = {
  clientPath: 'C:\\Program Files\\Riot Games\\Riot Client\\RiotClientServices.exe',
  detectedClient: 'C:\\Program Files\\Riot Games\\Riot Client\\RiotClientServices.exe',
  encryptionAvailable: true,
  autoFill: true,
  minimizeOnSwitch: true,
  minimizeToTray: true,
  useDeceive: false,
  deceiveStatus: 'offline',
  deceivePreserveParty: true,
  deceiveActivityMode: 'hide',
  deceiveCustomStatus: '',
  deceiveLeagueHelper: true,
  discordPresenceEnabled: false,
  discordClientId: '',
  discordShowGame: true,
  discordShowRank: false,
  discordShowRiotId: false,
  discordShowStatus: false,
  discordShowElapsed: true,
  discordShowLiveMatch: false,
  discordShowMatchMode: false,
  discordShowMatchMap: false,
  discordShowMatchPhase: false,
  discordShowMatchScore: false,
  discordShowMatchElapsed: false,
  discordCustomDetails: '',
  discordCustomState: '',
  discordLargeImage: '',
  hideLoginNames: false,
  hideDisplayNames: false,
  featureTutorialVersion: 3,
};

let configStatus = accounts.map((account, index) => ({
  accountId: account.id,
  linked: true,
  profiles: { valorant: index === 0, league: index < 2, lor: false },
  profileCapturedAt: {
    valorant: index === 0 ? '2026-07-20T11:45:00.000Z' : null,
    league: index < 2 ? `2026-07-${20 - index}T11:30:00.000Z` : null,
    lor: null,
  },
  profileErrors: { valorant: null, league: null, lor: null },
  bindings: { valorant: false, league: index === 1, lor: false },
  bindingApplicable: { valorant: false, league: index === 1, lor: false },
  bindingSources: { valorant: null, league: index === 1 ? accounts[0].id : null, lor: null },
  bindingUpdatedAt: { valorant: null, league: index === 1 ? '2026-07-20T11:50:00.000Z' : null, lor: null },
  lastAttemptAt: { valorant: null, league: null, lor: null },
  lastAppliedAt: { valorant: null, league: null, lor: null },
  lastResult: { valorant: null, league: null, lor: null },
  cloudCaptured: index === 0,
  cloudCapturedAt: index === 0 ? '2026-07-21T12:10:00.000Z' : null,
  cloudBackupAvailable: index === 1,
  cloudBackedUpAt: index === 1 ? '2026-07-21T12:15:00.000Z' : null,
}));
const fixtureNamespace = (game) => game === 'lol' || game === 'tft' ? 'league' : game;

const api = {
  window: { minimize: noop, maximize: noop, close: noop, onState: noop },
  vault: {
    status: () => ok({ exists: true, unlocked: true, keyStorageMode: 'hello', hasParkedKey: true, parkedKeyMode: 'hello' }),
    create: () => ok(true), unlock: () => ok(true), unlockParked: () => ok(true), helloOptions: () => ok({}),
    lock: () => ok(true), setKeyStorageMode: (mode) => ok({ mode }), changeMaster: () => ok(true),
  },
  accounts: {
    list: () => ok(accounts), upsert: () => ok(accounts), remove: () => ok(accounts),
    toggleFavorite: () => ok(accounts),
  },
  riot: {
    isRunning: () => ok(true), currentSession: () => ok(currentSession), allStats: () => ok(stats),
    refreshAccount: () => ok({ accounts, currentSession, stats }), switch: () => ok({}), onSwitchProgress: noop,
    rankTiers: () => ok([]),
    games: () => ok([
      { id: 'valorant', label: 'VALORANT' }, { id: 'lol', label: 'League of Legends' },
      { id: 'tft', label: 'Teamfight Tactics' }, { id: 'lor', label: 'Legends of Runeterra' },
    ]),
  },
  chat: {
    friends: () => ok({
      identity: { riotId: 'RelayDemo#001', puuidHash: 'synthetic0001' }, inboxAvailable: true, incomingMessages: [],
      friends: [
        {
          id: 'syntheticfriend00000000000000001', riotId: 'QueuePartner#EUW', availability: 'chat', game: 'League of Legends',
          avatarUrl: 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/29.jpg',
          links: { tracker: 'https://tracker.gg/valorant/profile/riot/QueuePartner%23EUW/overview', vtl: 'https://vtl.lol/id/QueuePartner_EUW', dpm: 'https://dpm.lol/QueuePartner-EUW', opgg: 'https://www.op.gg/summoners/euw/QueuePartner-EUW' },
        },
        {
          id: 'syntheticfriend00000000000000002', riotId: 'PracticeBuddy#001', availability: 'away', game: 'VALORANT',
          avatarUrl: 'https://media.valorant-api.com/playercards/9fb348bc-41a0-91ad-8a3e-818035c4e561/smallart.png',
          links: { tracker: 'https://tracker.gg/valorant/profile/riot/PracticeBuddy%23001/overview', vtl: 'https://vtl.lol/id/PracticeBuddy_001', dpm: 'https://dpm.lol/PracticeBuddy-001' },
        },
      ],
    }),
    history: () => ok([]), send: () => ok({ sent: true }),
  },
  inventory: {
    catalogStatus: () => ok({ total: 1734 }), loadCatalog: () => ok({ total: 1734 }),
    buildCurrent: () => ok(inventory), export: () => ok({ saved: false }), exportImage: () => ok({ saved: false }),
  },
  deceive: {
    getState: () => ok({
      enabled: false, running: false, chatConnected: false, status: 'offline', activeConnections: 0,
      connectionProducts: { league: 0, valorant: 0, unknown: 0 }, helperConnections: 0,
      helperAvailable: false, launchProduct: 'unknown', clientProduct: 'unknown', preserveParty: true,
      activityMode: 'hide', customStatus: '', leagueHelper: true, lastError: null,
    }),
    setStatus: (status) => ok({ status, applied: false, notifiedChats: 0 }),
    setOptions: (options) => ok({ applied: false, ...options }),
  },
  discord: {
    getState: () => ok({ enabled: false, connected: false, configured: false, published: false, status: 'disabled', preview: null, lastError: null }),
    refresh: () => ok({ enabled: false, connected: false, configured: false, published: false, status: 'disabled', preview: null, lastError: null }),
    test: () => ok({ enabled: true, connected: true, configured: true, published: true, status: 'published', pipe: 0, preview: { details: 'Riot Relay', state: 'Discord connection test' }, lastError: null }),
    onState: () => noop,
  },
  configs: {
    status: () => ok(configStatus),
    capture: (accountId, game) => {
      const namespace = fixtureNamespace(game);
      const row = configStatus.find((item) => item.accountId === accountId);
      if (row) {
        row.profiles[namespace] = true;
        row.profileCapturedAt[namespace] = new Date().toISOString();
        row.profileErrors[namespace] = null;
      }
      return ok({ captured: !!row, game: namespace });
    },
    migrate: (sourceAccountId, targetAccountId, game) => {
      const namespace = fixtureNamespace(game);
      const source = configStatus.find((item) => item.accountId === sourceAccountId);
      const target = configStatus.find((item) => item.accountId === targetAccountId);
      if (source && target) {
        target.bindings[namespace] = true;
        target.bindingApplicable[namespace] = !!(source.profiles[namespace] && target.profiles[namespace]);
        target.bindingSources[namespace] = sourceAccountId;
        target.bindingUpdatedAt[namespace] = new Date().toISOString();
        target.lastAttemptAt[namespace] = null;
        target.lastAppliedAt[namespace] = null;
        target.lastResult[namespace] = null;
      }
      return ok({ bound: !!(source && target), game: namespace });
    },
    setActiveTarget: () => {
      Object.assign(currentSession, {
        puuid: 'synthetic-puuid-secondary', riotId: 'RelayDemo#002',
        matchingAccountIds: ['demo-secondary'],
      });
      return ok(currentSession);
    },
    captureCloud: (accountId) => {
      const row = configStatus.find((item) => item.accountId === accountId);
      emitConfigActivity('capture', 'started');
      if (row) { row.cloudCaptured = true; row.cloudCapturedAt = new Date().toISOString(); }
      emitConfigActivity('capture', 'write-verified');
      emitConfigActivity('capture', 'completed', 'good');
      return ok({ captured: !!row });
    },
    applyCloud: () => {
      const row = configStatus.find((item) => item.accountId === currentSession.matchingAccountIds[0]);
      for (const stage of ['started', 'target-identified', 'target-settings-read', 'backup-retained', 'identity-verified-before-write', 'endpoint-ready', 'route-proven', 'put-accepted', 'readback-fetched', 'write-verified', 'identity-reverified']) emitConfigActivity('apply', stage);
      if (row) { row.cloudBackupAvailable = true; row.cloudBackedUpAt = new Date().toISOString(); }
      emitConfigActivity('apply', 'completed', 'good');
      return ok({ applied: true, verified: true, hadBackup: true });
    },
    restoreCloud: () => {
      for (const stage of ['started', 'backup-loaded', 'identity-verified', 'endpoint-ready', 'route-proven', 'put-accepted', 'readback-fetched', 'write-verified', 'identity-reverified']) emitConfigActivity('restore', stage);
      emitConfigActivity('restore', 'completed', 'good');
      return ok({ restored: true });
    },
    onActivity: (callback) => {
      if (typeof callback !== 'function') return noop;
      configActivityListeners.add(callback);
      return () => configActivityListeners.delete(callback);
    },
    removeBinding: (targetAccountId, game) => {
      const namespace = fixtureNamespace(game);
      const target = configStatus.find((item) => item.accountId === targetAccountId);
      if (target) {
        target.bindings[namespace] = false;
        target.bindingApplicable[namespace] = false;
        target.bindingSources[namespace] = null;
        target.bindingUpdatedAt[namespace] = null;
      }
      return ok({ removed: !!target, game: namespace });
    },
  },
  profiles: { links: () => ok({}) },
  session: { capture: () => ok(accounts), clear: () => ok(accounts) },
  startup: {
    get: () => ok({ supported: true, enabled: true, reason: '' }),
    set: (enabled) => ok({ supported: true, enabled: !!enabled, reason: '' }),
  },
  settings: {
    get: () => ok({ ...settings }),
    set: (patch) => { settings = { ...settings, ...(patch || {}) }; return ok({ ...settings }); },
    pickClient: () => ok({ picked: false }),
  },
  updates: {
    getState: () => ok({
      supported: true, installerFlavor: 'nsis', status: 'current', currentVersion: '1.3.3',
      availableVersion: null, progress: 0, lastCheckedAt: '2026-07-21T12:00:00.000Z', error: null,
    }),
    check: () => ok({ supported: true, status: 'current', currentVersion: '1.3.3' }),
    install: () => ok({ status: 'idle' }), onState: noop,
  },
  project: { open: () => ok(true) },
  openExternal: () => ok(true),
};

contextBridge.exposeInMainWorld('api', api);