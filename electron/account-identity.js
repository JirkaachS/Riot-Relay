'use strict';

const LINK_REQUIRED = 'LINK_REQUIRED:';

function fullRiotId(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const hash = trimmed.lastIndexOf('#');
    return hash > 0 && hash < trimmed.length - 1 ? trimmed : null;
  }
  return value.gameName && value.tagLine ? `${value.gameName}#${value.tagLine}` : null;
}

function same(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function identityPatch(live) {
  const riotId = fullRiotId(live);
  return { puuid: live.puuid, ...(riotId ? { riotId } : {}) };
}

function assertAccountIdentity(account, live, { allowLink = false } = {}) {
  if (!account) throw new Error('Account not found.');
  if (!live || !live.puuid) throw new Error('Riot Client did not expose a signed-in account identity.');
  const liveRiotId = fullRiotId(live);
  const label = account.label || account.riotId || account.username || 'selected account';

  if (account.puuid) {
    if (!same(account.puuid, live.puuid)) throw new Error(`Signed-in account (${liveRiotId || 'unknown'}) does not match "${label}".`);
    return { linked: true, firstLink: false, patch: identityPatch(live) };
  }

  const storedRiotId = fullRiotId(account.riotId);
  if (storedRiotId) {
    if (!liveRiotId || !same(storedRiotId, liveRiotId)) throw new Error(`Signed-in account (${liveRiotId || 'unknown'}) does not match "${label}".`);
    return { linked: true, firstLink: true, patch: identityPatch(live) };
  }

  if (!allowLink) throw new Error(`${LINK_REQUIRED} Link "${label}" to the currently signed-in Riot account ${liveRiotId || live.puuid.slice(0, 8)}?`);
  if (!liveRiotId) throw new Error('Wait for Riot friends/chat services to connect, then try linking again.');
  return { linked: true, firstLink: true, patch: identityPatch(live) };
}

function findRosterMatches(accounts, live) {
  if (!live || !live.puuid) return [];
  const byPuuid = (accounts || []).filter((a) => a.puuid && same(a.puuid, live.puuid));
  if (byPuuid.length) return byPuuid;
  const riotId = fullRiotId(live);
  if (!riotId) return [];
  return (accounts || []).filter((a) => !a.puuid && fullRiotId(a.riotId) && same(a.riotId, riotId));
}

module.exports = { LINK_REQUIRED, fullRiotId, assertAccountIdentity, findRosterMatches };