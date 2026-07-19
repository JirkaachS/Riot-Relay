'use strict';

/* ============================================================
   Riot Relay renderer controller (Volt-style shell).
   Talks to the main process exclusively through window.api.
   ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ic = (name, size, opts = {}) => window.Icons.svg(name, size, opts);

// Display order + labels across all games (VALORANT, League, TFT).
const SECTION_ORDER = ['Skin', 'Chroma', 'Champion', 'Emote', 'ProfileIcon', 'WardSkin', 'Companion', 'Arena', 'Finisher', 'Buddy', 'Spray', 'Card', 'Title', 'Agent'];
const TYPE_LABELS = {
  Skin: 'Skins', Chroma: 'Chromas', Champion: 'Champions', Emote: 'Emotes',
  ProfileIcon: 'Profile Icons', WardSkin: 'Ward Skins', Companion: 'Little Legends',
  Arena: 'Arenas', Finisher: 'Finishers', Buddy: 'Gun Buddies', Spray: 'Sprays',
  Card: 'Player Cards', Title: 'Titles', Agent: 'Agents',
};
const sectionLabel = (t) => TYPE_LABELS[t] || t;
function orderedTypes(byType) {
  return Object.keys(byType || {}).sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a), ib = SECTION_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

const state = {
  accounts: [],
  selectedAccountId: null,
  currentSession: null,
  stats: null,
  activeView: 'accounts',
  activity: [],
  rankIcons: {},
  settings: {},
  updates: { status: 'idle', currentVersion: '1.3.2', availableVersion: null, progress: 0 },
  inventory: null,
  games: [{ id: 'valorant', label: 'VALORANT' }],
  inv: { section: 'Skin', exportSel: new Set(['Skin']), search: '', tier: '', accSearch: '', game: 'valorant' },
  chat: { identity: null, friends: [], selectedId: null, messages: [], search: '', timer: null, loading: false, generation: 0 },
};

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const displayLogin = (value) => state.settings.hideLoginNames ? '••••••••' : String(value || '—');
const displayRiotId = (value) => state.settings.hideDisplayNames ? 'Hidden Riot ID' : String(value || '');
const ownIdentity = (value, fallback = 'the verified account') => displayRiotId(value) || fallback;

/* ---------------- Toasts ---------------- */
function toast(message, kind = '') {
  const msg = String(message || '');
  const short = msg.length > 220 ? msg.slice(0, 217) + '…' : msg;
  const el = document.createElement('div');
  el.className = `toast ${kind ? 'toast--' + kind : ''}`;
  const iconName = kind === 'good' ? 'check' : kind === 'bad' ? 'x' : kind === 'warn' ? 'alert-triangle' : 'info';
  el.innerHTML = `<span class="toast__icon">${ic(iconName, 15)}</span><span class="toast__msg"></span>`;
  el.querySelector('.toast__msg').textContent = short;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; }, 4200);
  setTimeout(() => el.remove(), 4600);
}
function logActivity(message, kind = 'info') {
  state.activity.unshift({ at: new Date(), message: String(message || ''), kind });
  state.activity = state.activity.slice(0, 100);
  const lines = $('#activity-lines');
  if (!lines) return;
  $('#activity-count').textContent = String(state.activity.length);
  lines.innerHTML = state.activity.map((entry) => `
    <div class="activity-line activity-line--${escapeHtml(entry.kind)}">
      <time>${entry.at.toLocaleTimeString([], { hour12: false })}</time>
      <span>${escapeHtml(entry.message)}</span>
    </div>`).join('') || '<div class="activity-empty">No activity yet.</div>';
}
$('#activity-clear').addEventListener('click', () => {
  state.activity = [];
  $('#activity-count').textContent = '0';
  $('#activity-lines').innerHTML = '<div class="activity-empty">No activity yet.</div>';
});
function unwrap(res) { if (!res || !res.ok) throw new Error(res ? res.error : 'Unknown error.'); return res.data; }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function initials(label) { return String(label || '?').trim().slice(0, 2).toUpperCase(); }

/* ---------------- Window controls ---------------- */
$('#wc-min').addEventListener('click', () => api.window.minimize());
$('#wc-max').addEventListener('click', () => api.window.maximize());
$('#wc-close').addEventListener('click', () => api.window.close());

/* ---------------- View switching ---------------- */
const SIDES = { accounts: '#side-accounts', inventory: '#side-inventory', chat: '#side-chat', settings: '#side-settings' };
const TB = { accounts: '#tb-accounts', inventory: '#tb-inventory', chat: '#tb-chat', settings: '#tb-settings' };
const TITLES = { accounts: 'Accounts', inventory: 'Inventory', chat: 'Chat', settings: 'Settings' };
function showView(name) {
  state.activeView = name;
  $$('.railbtn[data-view]').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
  $$('.tab[data-view], .workspace-tab[data-view]').forEach((b) => {
    const active = b.dataset.view === name;
    b.classList.toggle('is-active', active);
    if (b.matches('.workspace-tab')) b.setAttribute('aria-selected', String(active));
  });
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
  Object.entries(SIDES).forEach(([k, sel]) => { $(sel).hidden = k !== name; });
  Object.entries(TB).forEach(([k, sel]) => { $(sel).hidden = k !== name; });
  $('#toolbar-title').textContent = TITLES[name];
  if (name === 'chat') startChatPolling(); else stopChatPolling();
}
$$('.railbtn[data-view], .tab[data-view], .workspace-tab[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

/* ---------------- Current-session Riot chat ---------------- */
function stopChatPolling() {
  if (state.chat.timer) clearInterval(state.chat.timer);
  state.chat.timer = null;
}
function clearChatState() {
  stopChatPolling();
  state.chat.generation += 1;
  state.chat.loading = false;
  state.chat.identity = null;
  state.chat.friends = [];
  state.chat.selectedId = null;
  state.chat.messages = [];
  $('#chat-identity').textContent = 'Riot Client not connected';
  $('#chat-friends').innerHTML = '';
  $('#chat-workspace').hidden = true;
  $('#chat-empty').hidden = false;
  $('#chat-messages').innerHTML = '';
}
function chatAvailability(value) {
  const availability = String(value || 'offline').toLowerCase();
  return ['chat', 'online', 'away', 'mobile', 'dnd'].includes(availability) ? availability : 'offline';
}
function renderChatFriends() {
  const search = state.chat.search.toLowerCase();
  const friends = state.chat.friends.filter((friend) => !search || friend.riotId.toLowerCase().includes(search));
  $('#chat-friends').innerHTML = friends.map((friend) => {
    const active = friend.id === state.chat.selectedId ? ' is-active' : '';
    const availability = chatAvailability(friend.availability);
    return `<button class="chat-friend${active}" type="button" data-chat-friend="${escapeHtml(friend.id)}">
      <span class="chat-friend__avatar">${escapeHtml(initials(friend.displayName))}<i class="chat-presence chat-presence--${escapeHtml(availability)}"></i></span>
      <span class="chat-friend__meta"><strong>${escapeHtml(friend.riotId)}</strong><small>${escapeHtml(friend.game || availability)}</small></span>
    </button>`;
  }).join('') || '<div class="chat-list-empty">No friends match this view.</div>';
  $$('#chat-friends [data-chat-friend]').forEach((button) => button.addEventListener('click', async () => {
    state.chat.selectedId = button.dataset.chatFriend;
    state.chat.messages = [];
    renderChatFriends();
    const friend = state.chat.friends.find((item) => item.id === state.chat.selectedId);
    $('#chat-title').textContent = friend ? friend.riotId : 'Conversation';
    $('#chat-presence').textContent = friend ? `${friend.availability}${friend.game ? ` · ${friend.game}` : ''}` : 'Current Riot session';
    $('#chat-empty').hidden = true;
    $('#chat-workspace').hidden = false;
    await loadChatHistory(false);
    $('#chat-message').focus();
  }));
}
function renderChatMessages() {
  const pane = $('#chat-messages');
  const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 60;
  pane.innerHTML = state.chat.messages.map((message) => {
    const time = message.timestamp ? new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    return `<article class="chat-message${message.isSelf ? ' is-self' : ''}">
      <header><strong>${escapeHtml(message.isSelf ? 'You' : (message.authorName || 'Friend'))}</strong><time>${escapeHtml(time)}</time></header>
      <p>${escapeHtml(message.body).replace(/\n/g, '<br>')}</p>
    </article>`;
  }).join('') || '<div class="chat-history-empty">No recent messages in this conversation.</div>';
  if (nearBottom) pane.scrollTop = pane.scrollHeight;
}
async function loadChatHistory(showErrors = true) {
  const requestedId = state.chat.selectedId;
  const generation = state.chat.generation;
  if (!requestedId || state.activeView !== 'chat') return;
  try {
    const messages = unwrap(await api.chat.history(requestedId));
    if (state.chat.generation !== generation || state.chat.selectedId !== requestedId || state.activeView !== 'chat') return;
    state.chat.messages = messages;
    renderChatMessages();
  } catch (error) {
    if (showErrors && state.chat.generation === generation) toast(error.message, 'warn');
  }
}
async function refreshChatFriends(showErrors = true) {
  if (state.chat.loading || state.activeView !== 'chat') return;
  const generation = state.chat.generation;
  state.chat.loading = true;
  try {
    const result = unwrap(await api.chat.friends());
    if (state.chat.generation !== generation || state.activeView !== 'chat') return;
    state.chat.identity = result.identity;
    state.chat.friends = result.friends || [];
    $('#chat-identity').textContent = result.identity && result.identity.riotId ? `Active · ${displayRiotId(result.identity.riotId)}` : 'Current Riot account';
    if (state.chat.selectedId && !state.chat.friends.some((friend) => friend.id === state.chat.selectedId)) {
      state.chat.selectedId = null;
      state.chat.messages = [];
      $('#chat-workspace').hidden = true;
      $('#chat-empty').hidden = false;
    }
    renderChatFriends();
    if (state.chat.selectedId) await loadChatHistory(false);
  } catch (error) {
    if (showErrors && state.chat.generation === generation) toast(error.message, 'warn');
    if (state.chat.generation === generation) $('#chat-identity').textContent = 'Riot chat unavailable';
  } finally {
    if (state.chat.generation === generation) state.chat.loading = false;
  }
}
function startChatPolling() {
  if (state.chat.timer) return;
  refreshChatFriends(false);
  state.chat.timer = setInterval(() => refreshChatFriends(false), 5000);
}
$('#chat-search').addEventListener('input', (event) => { state.chat.search = event.target.value; renderChatFriends(); });
['#btn-chat-refresh', '#btn-chat-refresh-side', '#btn-chat-connect'].forEach((selector) => $(selector).addEventListener('click', () => refreshChatFriends(true)));
$('#chat-composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.chat.selectedId) return;
  const input = $('#chat-message');
  const message = input.value.trim();
  if (!message) return;
  const button = $('#btn-chat-send');
  button.disabled = true;
  try {
    unwrap(await api.chat.send(state.chat.selectedId, message));
    input.value = '';
    await loadChatHistory(true);
  } catch (error) { toast(error.message, 'bad'); }
  finally { button.disabled = false; }
});
$('#chat-message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#chat-composer').requestSubmit();
  }
});

/* ---------------- Rank icons ---------------- */
async function loadRankIcons() {
  try {
    const res = await fetch('https://valorant-api.com/v1/competitivetiers');
    const body = await res.json();
    const latest = body.data[body.data.length - 1];
    const map = {};
    for (const t of latest.tiers) if (t.smallIcon) map[t.tier] = t.smallIcon;
    state.rankIcons = map;
  } catch { state.rankIcons = {}; }
}
function rankIcon(tier, cls) {
  const url = state.rankIcons[tier];
  return url ? `<img class="${cls}" src="${url}" alt="" />` : `<div class="${cls} ${cls}--ph">—</div>`;
}

/* ---------------- Lock / unlock / onboarding ---------------- */
function bytesFromBase64Url(value) {
  const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function base64UrlFromBytes(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function windowsHelloAvailable() {
  return !!(window.PublicKeyCredential && navigator.credentials
    && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false));
}
async function registerWindowsHello() {
  if (!await windowsHelloAvailable()) throw new Error('Windows Hello is not configured or unavailable.');
  const options = unwrap(await api.vault.helloOptions('register'));
  const credential = await navigator.credentials.create({ publicKey: {
    challenge: bytesFromBase64Url(options.challenge), rp: options.rp,
    user: { ...options.user, id: bytesFromBase64Url(options.user.id) },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'discouraged', userVerification: 'required' },
    timeout: options.timeout, attestation: 'none',
  } });
  const response = credential && credential.response;
  const publicKey = response && response.getPublicKey && response.getPublicKey();
  const authenticatorData = response && response.getAuthenticatorData && response.getAuthenticatorData();
  if (!credential || !publicKey || !authenticatorData) throw new Error('Windows Hello did not return a usable credential.');
  return { id: base64UrlFromBytes(credential.rawId), clientDataJSON: base64UrlFromBytes(response.clientDataJSON), authenticatorData: base64UrlFromBytes(authenticatorData), publicKey: base64UrlFromBytes(publicKey), algorithm: response.getPublicKeyAlgorithm() };
}
async function authenticateWindowsHello() {
  if (!await windowsHelloAvailable()) throw new Error('Windows Hello is not configured or unavailable.');
  const options = unwrap(await api.vault.helloOptions('authenticate'));
  const credential = await navigator.credentials.get({ publicKey: {
    challenge: bytesFromBase64Url(options.challenge), rpId: options.rpId,
    allowCredentials: [{ type: 'public-key', id: bytesFromBase64Url(options.credentialId), transports: ['internal'] }],
    userVerification: 'required', timeout: options.timeout,
  } });
  const response = credential && credential.response;
  if (!credential || !response) throw new Error('Windows Hello verification was canceled.');
  return { id: base64UrlFromBytes(credential.rawId), clientDataJSON: base64UrlFromBytes(response.clientDataJSON), authenticatorData: base64UrlFromBytes(response.authenticatorData), signature: base64UrlFromBytes(response.signature) };
}

const lockOverlay = $('#lock-overlay');
async function bootVault() {
  const status = unwrap(await api.vault.status());
  if (status.unlocked) { await afterUnlock(); return; }
  if (!status.exists) { startOnboarding(); return; }   // first launch → walkthrough
  lockOverlay.hidden = false;
  $('#lock-title').textContent = 'Unlock Riot Relay';
  $('#lock-sub').textContent = status.parkedKeyMode === 'hello'
    ? 'Enter your master password, or verify with Windows Hello.'
    : 'Enter your master password to decrypt the vault.';
  $('#lock-submit').textContent = 'Unlock';
  const parkedButton = $('#lock-parked');
  parkedButton.hidden = !status.hasParkedKey;
  parkedButton.textContent = status.parkedKeyMode === 'hello' ? 'Verify with Windows Hello' : 'Use OS-stored key';
  $('#lock-password').focus();
}

/* ---------------- Onboarding walkthrough (first launch) ---------------- */
const onboard = { step: 0, count: 4, password: '' };
function startOnboarding() {
  const dots = $('#onboard-dots');
  dots.innerHTML = Array.from({ length: onboard.count }, () => '<div class="onboard__dot"></div>').join('');
  $('#onboard').hidden = false;
  gotoStep(0);
}
function gotoStep(n) {
  onboard.step = Math.max(0, Math.min(onboard.count - 1, n));
  $$('#onboard .onboard__step').forEach((s) => s.classList.toggle('is-active', Number(s.dataset.step) === onboard.step));
  $$('#onboard-dots .onboard__dot').forEach((d, i) => d.classList.toggle('is-active', i === onboard.step));
  if (onboard.step === 1) setTimeout(() => $('#ob-pass').focus(), 60);
  if (onboard.step === 2) loadClientForOnboarding();
}
async function loadClientForOnboarding() {
  try {
    const s = unwrap(await api.settings.get());
    $('#ob-client-path').value = s.clientPath || s.detectedClient || '';
    $('#ob-client-msg').textContent = s.detectedClient
      ? `Detected: ${s.detectedClient}`
      : 'Not auto-detected — set the path to RiotClientServices.exe (or skip and set it later).';
  } catch { /* ignore */ }
}
$$('#onboard [data-next]').forEach((b) => b.addEventListener('click', () => {
  if (onboard.step === 1) {
    const p1 = $('#ob-pass').value, p2 = $('#ob-pass2').value;
    const err = $('#ob-error');
    if (!p1 || p1.length < 4) { err.textContent = 'Master password must be at least 4 characters.'; err.hidden = false; return; }
    if (p1 !== p2) { err.textContent = 'Passwords do not match.'; err.hidden = false; return; }
    err.hidden = true;
    onboard.password = p1;
  }
  gotoStep(onboard.step + 1);
}));
$$('#onboard [data-back]').forEach((b) => b.addEventListener('click', () => gotoStep(onboard.step - 1)));
$('#ob-browse').addEventListener('click', async () => {
  try { const res = unwrap(await api.settings.pickClient()); if (res.picked) { $('#ob-client-path').value = res.clientPath; $('#ob-client-msg').textContent = `Set: ${res.clientPath}`; } }
  catch (e) { toast(e.message, 'bad'); }
});
$('#ob-finish').addEventListener('click', async () => {
  const err = $('#ob-finish-error'); err.hidden = true;
  try {
    unwrap(await api.vault.create(onboard.password));
    const clientPath = $('#ob-client-path').value.trim();
    if (clientPath) await api.settings.set({ clientPath });
    onboard.password = '';
    $('#onboard').hidden = true;
    await afterUnlock();
    toast('Vault created. Add your first account to get started.', 'good');
  } catch (e) { err.textContent = e.message; err.hidden = false; }
});

const FEATURE_TUTORIAL_VERSION = 2;
const featureTour = { step: 0, count: 5 };
function showTourStep(step) {
  featureTour.step = Math.max(0, Math.min(featureTour.count - 1, step));
  $$('#feature-tour [data-tour-step]').forEach((el) => el.classList.toggle('is-active', Number(el.dataset.tourStep) === featureTour.step));
  $$('#tour-dots .onboard__dot').forEach((dot, index) => dot.classList.toggle('is-active', index === featureTour.step));
  $('#tour-back').disabled = featureTour.step === 0;
  $('#tour-next').hidden = featureTour.step === featureTour.count - 1;
  $('#tour-finish').hidden = featureTour.step !== featureTour.count - 1;
}
function startFeatureTour() {
  $('#tour-dots').innerHTML = Array.from({ length: featureTour.count }, () => '<div class="onboard__dot"></div>').join('');
  $('#feature-tour').hidden = false;
  showTourStep(0);
}
async function closeFeatureTour() {
  $('#feature-tour').hidden = true;
  try {
    await setSetting({ featureTutorialVersion: FEATURE_TUTORIAL_VERSION });
  } catch { /* tutorial completion is non-critical */ }
}
$('#tour-back').addEventListener('click', () => showTourStep(featureTour.step - 1));
$('#tour-next').addEventListener('click', () => showTourStep(featureTour.step + 1));
$('#tour-finish').addEventListener('click', closeFeatureTour);
$('#tour-skip').addEventListener('click', closeFeatureTour);

async function submitLock() {
  const pw = $('#lock-password').value;
  const errEl = $('#lock-error');
  errEl.hidden = true;
  if (!pw) return;
  const status = unwrap(await api.vault.status());
  try {
    if (status.exists) unwrap(await api.vault.unlock(pw));
    else unwrap(await api.vault.create(pw));
    $('#lock-password').value = '';
    lockOverlay.hidden = true;
    await afterUnlock();
    toast(status.exists ? 'Vault unlocked.' : 'Vault created.', 'good');
  } catch (e) { errEl.textContent = e.message; errEl.hidden = false; }
}
$('#lock-submit').addEventListener('click', submitLock);
$('#lock-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLock(); });
$('#lock-parked').addEventListener('click', async () => {
  try {
    const status = unwrap(await api.vault.status());
    const assertion = status.parkedKeyMode === 'hello' ? await authenticateWindowsHello() : null;
    unwrap(await api.vault.unlockParked(assertion));
    lockOverlay.hidden = true; await afterUnlock(); toast('Vault unlocked.', 'good');
  } catch (e) { const el = $('#lock-error'); el.textContent = e.name === 'NotAllowedError' ? 'Windows Hello verification was canceled.' : e.message; el.hidden = false; }
});
$('#btn-lock').addEventListener('click', async () => {
  await api.vault.lock();
  state.accounts = []; state.selectedAccountId = null;
  clearChatState();
  renderAccounts(); renderDetail();
  await bootVault();
});
async function afterUnlock() {
  await loadSettings();
  await loadGames();
  await refreshAccounts();
  await loadRankIcons();
  renderAccounts(); renderDetail();
  checkClientStatus();
  if (Number(state.settings.featureTutorialVersion || 0) < FEATURE_TUTORIAL_VERSION) {
    setTimeout(startFeatureTour, 180);
  }
}

/* ---------------- Games ---------------- */
// Games with inventory support (Legends of Runeterra has no readable owned-cards API).
const INVENTORY_GAMES = new Set(['valorant', 'lol', 'tft']);
async function loadGames() {
  try { state.games = unwrap(await api.riot.games()); } catch { state.games = [{ id: 'valorant', label: 'VALORANT' }]; }
  const invSel = $('#inv-game');
  if (invSel) {
    invSel.innerHTML = state.games.filter((g) => INVENTORY_GAMES.has(g.id))
      .map((g) => `<option value="${g.id}">${escapeHtml(g.label)}</option>`).join('');
    if (![...invSel.options].some((o) => o.value === state.inv.game)) state.inv.game = 'valorant';
    invSel.value = state.inv.game;
    resetInventoryView(state.inv.game);
  }
}
function gameLabel(id) { const g = state.games.find((x) => x.id === id); return g ? g.label : (id || 'VALORANT'); }
function gameOptions(selected) {
  return state.games.map((g) => `<option value="${g.id}" ${g.id === selected ? 'selected' : ''}>${escapeHtml(g.label)}</option>`).join('');
}
function statsFor(account) {
  const isCurrent = state.currentSession && (state.currentSession.matchingAccountIds || []).includes(account.id);
  return (isCurrent && state.stats) || account.stats || {
    valorant: { available: !!account.rankName, rank: { tier: account.rankTier, tierName: account.rankName, rr: account.rr }, level: account.level },
    league: { available: false, queues: [], error: 'Sync while League is open.' },
    tft: { available: false, queues: [], error: 'Sync while League is open.' },
  };
}
function queueName(queue) {
  return ({ RANKED_SOLO_5x5: 'Solo / Duo', RANKED_FLEX_SR: 'Flex', RANKED_TFT: 'Ranked', RANKED_TFT_DOUBLE_UP: 'Double Up' })[queue] || queue;
}
const LEAGUE_RANK_COLORS = {
  IRON: '#7d706b', BRONZE: '#a96f4b', SILVER: '#8796a5', GOLD: '#c69a43', PLATINUM: '#4aa99b',
  EMERALD: '#3fbb78', DIAMOND: '#6b82d8', MASTER: '#9a62c7', GRANDMASTER: '#d4545b', CHALLENGER: '#d1ad5c',
  UNRANKED: '#555762',
};
function gameErrorMessage(game) {
  const message = String(game && game.error || 'Unavailable').trim();
  return /^(?:ReferenceError:\s*)?path is not defined$/i.test(message)
    ? 'Previous sync failed before data could be read. Sync again to retry.'
    : message;
}
function rankedRows(game) {
  if (!game || !game.available) return `<div class="game-stat__empty">${escapeHtml(gameErrorMessage(game))}</div>`;
  if (!game.queues || !game.queues.length) return '<div class="game-stat__empty">No ranked placements found</div>';
  return `<div class="rank-cards">${game.queues.map((q) => {
    const tier = String(q.tier || 'UNRANKED').toUpperCase();
    const unranked = tier === 'UNRANKED';
    const division = unranked ? '' : String(q.division || '').toUpperCase();
    const wins = q.wins == null ? null : Number(q.wins);
    const losses = q.losses == null ? null : Number(q.losses);
    const games = Number.isFinite(wins) && Number.isFinite(losses) ? wins + losses : 0;
    const winRate = games > 0 ? Math.round((wins / games) * 100) : null;
    const metrics = [
      q.lp != null ? `<b>${fmt(q.lp)} LP</b>` : null,
      wins != null ? `<span><i>W</i>${fmt(wins)}</span>` : null,
      losses != null ? `<span><i>L</i>${fmt(losses)}</span>` : null,
      winRate != null ? `<span><i>WR</i>${winRate}%</span>` : null,
    ].filter(Boolean).join('');
    const mark = unranked ? '—' : tier.slice(0, 1);
    return `<div class="rank-card" style="--rank-accent:${LEAGUE_RANK_COLORS[tier] || LEAGUE_RANK_COLORS.UNRANKED}">
      <div class="rank-card__mark" aria-hidden="true"><span>${mark}</span></div>
      <div class="rank-card__body">
        <span class="rank-card__queue">${escapeHtml(queueName(q.queue))}</span>
        <strong>${escapeHtml(unranked ? 'Unranked' : `${tier} ${division}`.trim())}</strong>
        <div class="rank-card__metrics">${metrics || '<em>No ranked record</em>'}</div>
      </div>
    </div>`;
  }).join('')}</div>`;
}
function renderGameStats(account) {
  const stats = statsFor(account);
  const val = stats.valorant || {};
  const rank = val.rank || {};
  const leagueStats = stats.league || {};
  const leagueSource = leagueStats.available ? (leagueStats.source === 'opgg' ? 'OP.GG' : 'LCU') : 'UNAVAILABLE';
  const leagueStatus = leagueStats.platformId ? `${leagueSource} · ${leagueStats.platformId}` : leagueSource;
  const tftStats = stats.tft || {};
  const tftSource = tftStats.available ? (tftStats.source === 'opgg' ? 'OP.GG' : 'LCU') : 'UNAVAILABLE';
  return `<div class="stats-grid">
    <section class="game-stat game-stat--valorant"><header><span>VALORANT</span><i class="game-stat__source">${val.available ? 'LIVE' : 'OFFLINE'}</i></header><div class="val-rank">${rankIcon(rank.tier || 0, 'game-stat__rank')}<div><strong>${escapeHtml(rank.tierName || 'Unranked')}</strong><span>${rank.rr != null ? `${fmt(rank.rr)} RR` : 'No rank data'} · Level ${fmt(val.level)}</span></div></div></section>
    <section class="game-stat game-stat--league"><header><span>LEAGUE</span><i class="game-stat__source">${escapeHtml(leagueStatus)}</i></header>${rankedRows(leagueStats)}</section>
    <section class="game-stat game-stat--tft"><header><span>TFT</span><i class="game-stat__source">${tftSource}</i></header>${rankedRows(tftStats)}</section>
  </div>`;
}

/* ---------------- Accounts: sidebar list ---------------- */
const DEFAULT_ACCOUNT_PORTRAIT = '../images.jfif';
function portraitUrl(account) {
  const identityBound = account.puuid && account.portraitPuuid
    && String(account.puuid).toLowerCase() === String(account.portraitPuuid).toLowerCase();
  return identityBound && safeImageUrl(account.portraitUrl) ? safeImageUrl(account.portraitUrl) : DEFAULT_ACCOUNT_PORTRAIT;
}
function portraitMarkup(account, className) {
  const label = account.label || (state.settings.hideDisplayNames ? '' : account.riotId)
    || (state.settings.hideLoginNames ? '' : account.username) || 'Account';
  return `<div class="${className}"><span>${escapeHtml(initials(label))}</span><img src="${escapeHtml(portraitUrl(account))}" alt="${escapeHtml(label)} portrait" loading="lazy" decoding="async" /></div>`;
}
function bindPortraits(root = document) {
  $$('[class$="__av"] img', root).forEach((image) => image.addEventListener('error', () => {
    if (!image.dataset.usedDefault && image.getAttribute('src') !== DEFAULT_ACCOUNT_PORTRAIT) {
      image.dataset.usedDefault = 'true';
      image.src = DEFAULT_ACCOUNT_PORTRAIT;
      return;
    }
    image.remove();
  }));
}
async function refreshAccounts() {
  try { state.accounts = unwrap(await api.accounts.list()); } catch { state.accounts = []; }
}
function accountRow(a, signedIn = false) {
  const sub = a.rankName && a.rankName !== 'Unranked'
    ? `${a.rankName}${a.rr != null ? ` · ${a.rr} RR` : ''}`
    : (a.riotId ? displayRiotId(a.riotId) : a.username ? displayLogin(a.username) : 'Not synced');
  const active = a.id === state.selectedAccountId ? ' is-active' : '';
  const favorite = a.favorite ? ' is-favorite' : '';
  const current = signedIn ? ' is-signed-in' : '';
  return `
    <div class="arow${active}${favorite}${current}" data-select="${a.id}">
      ${portraitMarkup(a, 'arow__av')}
      <div class="arow__meta">
        <div class="arow__label"><span>${escapeHtml(a.label || 'Unnamed')}</span>${signedIn ? '<span class="arow__live" title="Currently signed in" aria-label="Currently signed in">SIGNED IN</span>' : ''}${a.hasSession ? `<span class="arow__bolt" title="Identity-verified saved session">${ic('zap', 11)}</span>` : ''}</div>
        <div class="arow__sub">${escapeHtml(sub)}</div>
      </div>
      <button class="arow__favorite${a.favorite ? ' is-active' : ''}" data-row-fav="${a.id}" title="${a.favorite ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${a.favorite ? 'Remove from favorites' : 'Add to favorites'}">${ic('star', 14, { fill: !!a.favorite })}</button>
      <div class="arow__rankslot">${a.rankName && a.rankName !== 'Unranked' ? rankIcon(a.rankTier, 'arow__rank') : ''}</div>
    </div>`;
}
function renderAccounts() {
  const list = $('#account-list');
  const q = state.inv.accSearch;
  const currentIds = new Set(state.currentSession?.matchingAccountIds || []);
  const filtered = state.accounts.filter((a) => !q || [a.label,
    state.settings.hideLoginNames ? '' : a.username,
    state.settings.hideDisplayNames ? '' : a.riotId,
    a.leaguePlatformId].some((v) => String(v || '').toLowerCase().includes(q)));
  const sorted = [...filtered].sort((a, b) => Number(currentIds.has(b.id)) - Number(currentIds.has(a.id))
    || Number(Boolean(b.favorite)) - Number(Boolean(a.favorite))
    || String(a.label || '').localeCompare(String(b.label || '')));
  list.innerHTML = sorted.length
    ? sorted.map((account) => accountRow(account, currentIds.has(account.id))).join('')
    : `<p class="muted" style="padding:16px;text-align:center;font-size:12px">${state.accounts.length ? 'No matches.' : 'No accounts yet.'}</p>`;
  $$('[data-select]', list).forEach((el) => el.addEventListener('click', () => selectAccount(el.dataset.select)));
  $$('[data-row-fav]', list).forEach((button) => button.addEventListener('click', async (event) => {
    event.stopPropagation();
    state.accounts = unwrap(await api.accounts.toggleFavorite(button.dataset.rowFav));
    renderAccounts(); renderDetail();
  }));
  bindPortraits(list);
}
$('#account-search').addEventListener('input', (e) => { state.inv.accSearch = e.target.value.toLowerCase(); renderAccounts(); });
function selectAccount(id) { state.selectedAccountId = id; renderAccounts(); renderDetail(); }

async function openAccountProfile(account, provider) {
  if (!account || !account.puuid || !String(account.riotId || '').includes('#')) {
    toast('Sync this account first so its Riot ID is bound to the correct PUUID.', 'warn');
    return;
  }
  try {
    const links = unwrap(await api.profiles.links(account.id));
    const url = links[provider];
    if (!url) {
      throw new Error(provider === 'vtl'
        ? 'VTL.LOL is unavailable for this account.'
        : 'Sync the account to verify its actual League platform before opening League profiles.');
    }
    await api.openExternal(url);
  } catch (error) { toast(error.message, 'bad'); }
}

/* ---------------- Accounts: detail hero ---------------- */
function renderDetail() {
  const detail = $('#account-detail');
  const empty = $('#accounts-empty');
  const a = state.accounts.find((x) => x.id === state.selectedAccountId);
  if (!a) {
    detail.hidden = true; empty.hidden = false;
    $('#accounts-empty-title').textContent = state.accounts.length ? 'No account selected' : 'No accounts yet';
    $('#accounts-empty-sub').textContent = state.accounts.length ? 'Pick an account from the roster on the left.' : 'Add your first account to start switching in one click.';
    return;
  }
  empty.hidden = true; detail.hidden = false;
  const hasRank = a.rankName && a.rankName !== 'Unranked';
  const badges = [];
  if (a.level) badges.push(`<span class="badge badge--lvl">Level ${a.level}</span>`);
  badges.push(a.leaguePlatformId
    ? `<span class="badge badge--region" title="PUUID-verified League platform">League · ${escapeHtml(a.leaguePlatformId)}</span>`
    : '<span class="badge badge--region badge--muted" title="Sync to verify the actual League platform">League · sync required</span>');
  if (a.peakName && a.peakName !== 'Unranked') badges.push(`<span class="badge badge--peak">Peak ${escapeHtml(a.peakName)}</span>`);
  if (a.hasSession) badges.push(`<span class="badge badge--accent">${ic('zap', 11)} Verified snapshot</span>`);
  badges.push(`<span class="badge">${a.hasPassword ? 'credential stored' : 'no password'}</span>`);
  const rr = Math.max(0, Math.min(100, a.rr || 0));
  const synced = a.lastSynced ? `Last synced ${new Date(a.lastSynced).toLocaleString()}` : 'Never synced — sync while signed in to load rank.';

  detail.innerHTML = `
    <div class="detail__hero">
      ${portraitMarkup(a, 'detail__av')}
      <div class="detail__id">
        <div class="detail__label">${escapeHtml(a.label || 'Unnamed')} ${a.favorite ? `<span class="star on" title="Favorite">${ic('star', 17, { fill: true })}</span>` : ''}</div>
        ${a.riotId ? `<div class="detail__riot">${escapeHtml(displayRiotId(a.riotId))}</div>` : ''}
        <div class="detail__user">Login: ${escapeHtml(displayLogin(a.username))}</div>
        <div class="detail__badges">${badges.join('')}</div>
      </div>
    </div>
    ${renderGameStats(a)}
    <div class="profile-actions" aria-label="Third-party account profiles">
      <div class="profile-actions__group">
        <span class="profile-actions__label">VALORANT</span>
        <div class="profile-actions__buttons">
          <button class="btn btn--ghost" type="button" data-account-profile="vtl">${ic('external-link', 13)} VTL.LOL</button>
          <button class="btn btn--ghost" type="button" data-account-profile="tracker">${ic('external-link', 13)} Tracker.gg</button>
        </div>
      </div>
      <div class="profile-actions__group">
        <span class="profile-actions__label">LEAGUE / TFT</span>
        <div class="profile-actions__buttons">
          <button class="btn btn--ghost" type="button" data-account-profile="opgg">${ic('external-link', 13)} OP.GG</button>
          <button class="btn btn--ghost" type="button" data-account-profile="ugg">${ic('external-link', 13)} U.GG</button>
          <button class="btn btn--ghost" type="button" data-account-profile="deeplol">${ic('external-link', 13)} DeepLoL</button>
          <button class="btn btn--ghost" type="button" data-account-profile="dpm">${ic('external-link', 13)} DPM.LOL</button>
        </div>
      </div>
    </div>
    <div class="detail-command-grid" aria-label="Account actions">
      <section class="detail-command detail-command--play">
        <header><span>PLAY</span><small>Switch only, or switch and launch</small></header>
        <div class="detail-command__buttons">
          <button class="btn btn--primary" data-switch="${a.id}">${ic('repeat-2', 16)} Switch session</button>
          <div class="launch-actions" aria-label="Switch session and launch a game">
            <button class="btn btn--ghost" data-launch-game="valorant">VALORANT</button>
            <button class="btn btn--ghost" data-launch-game="lol">League</button>
            <button class="btn btn--ghost" data-launch-game="tft">TFT</button>
          </div>
        </div>
      </section>
      <section class="detail-command">
        <header><span>SESSION DATA</span><small>Snapshot and rank tools</small></header>
        <div class="detail-command__buttons">
          <button class="btn btn--ghost" data-capture="${a.id}" title="Save an identity-bound Riot session snapshot">${ic('download', 15)} ${a.hasSession ? 'Update snapshot' : 'Save snapshot'}</button>
          ${a.hasSession ? `<button class="btn btn--ghost" data-clearsession="${a.id}">Clear snapshot</button>` : ''}
          <button class="btn btn--ghost" data-refresh="${a.id}">${ic('refresh-cw', 15)} Sync rank</button>
        </div>
      </section>
      <section class="detail-command detail-command--account">
        <header><span>ACCOUNT</span><small>Roster controls</small></header>
        <div class="detail-command__buttons">
          <button class="btn btn--ghost" data-fav="${a.id}">${ic('star', 15)} ${a.favorite ? 'Unfavorite' : 'Favorite'}</button>
          <button class="iconbtn" data-edit="${a.id}" title="Edit account" aria-label="Edit account">${ic('pencil', 15)}</button>
          <button class="iconbtn iconbtn--danger" data-del="${a.id}" title="Delete account" aria-label="Delete account">${ic('trash-2', 15)}</button>
        </div>
      </section>
    </div>
    <div class="detail__synced">${a.hasSession ? 'Saved session is intact and bound to this PUUID; Riot will be verified after launch.' : (a.session && a.session.reason === 'legacy' ? 'Legacy session found — save it again to add identity and integrity checks.' : 'Sign into this account once, then “Save session” for faster switching.')} · ${escapeHtml(synced)}</div>`;

  bindPortraits(detail);
  $$('[data-account-profile]', detail).forEach((button) => button.addEventListener('click', () => openAccountProfile(a, button.dataset.accountProfile)));
  $('[data-switch]', detail).addEventListener('click', () => doSwitch(a.id));
  $$('[data-launch-game]', detail).forEach((button) => button.addEventListener('click', () => doSwitch(a.id, button.dataset.launchGame)));
  $('[data-capture]', detail).addEventListener('click', async () => {
    try {
      let accounts;
      try { accounts = unwrap(await api.session.capture(a.id, false)); }
      catch (error) {
        if (!error.message.includes('LINK_REQUIRED:')) throw error;
        const question = error.message.split('LINK_REQUIRED:').slice(1).join('LINK_REQUIRED:').trim();
        if (!confirm(question)) return;
        accounts = unwrap(await api.session.capture(a.id, true));
      }
      state.accounts = accounts;
      renderAccounts(); renderDetail();
      toast('Session saved and bound to this Riot identity.', 'good');
    } catch (e) { toast(e.message, 'bad'); }
  });
  const clearBtn = $('[data-clearsession]', detail);
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    try { state.accounts = unwrap(await api.session.clear(a.id)); renderAccounts(); renderDetail(); toast('Saved session cleared.', 'good'); }
    catch (e) { toast(e.message, 'bad'); }
  });
  $('[data-refresh]', detail).addEventListener('click', () => syncAccount(a.id));
  $('[data-edit]', detail).addEventListener('click', () => openModal(a.id));
  $('[data-del]', detail).addEventListener('click', () => deleteAccount(a.id));
  $('[data-fav]', detail).addEventListener('click', async () => {
    state.accounts = unwrap(await api.accounts.toggleFavorite(a.id));
    renderAccounts(); renderDetail();
  });
}

/* ---------------- Account modal ---------------- */
const modal = $('#account-modal');
function openModal(id = null) {
  const acc = id ? state.accounts.find((a) => a.id === id) : null;
  $('#modal-title').textContent = acc ? 'Edit account' : 'Add account';
  $('#acc-id').value = acc ? acc.id : '';
  $('#acc-label').value = acc ? acc.label || '' : '';
  $('#acc-username').value = acc ? acc.username || '' : '';
  $('#acc-username').type = state.settings.hideLoginNames ? 'password' : 'text';
  $('#acc-password').value = '';
  $('#acc-password').placeholder = acc && acc.hasPassword ? '•••••••• (unchanged)' : 'Stored encrypted (AES-256-GCM)';
  $('#acc-league-platform').value = acc ? acc.leaguePlatformId || '' : '';
  modal.hidden = false;
  $('#acc-label').focus();
}
function closeModal() { modal.hidden = true; }
$$('[data-close]', modal).forEach((el) => el.addEventListener('click', closeModal));
$('#btn-add').addEventListener('click', () => openModal());
$('#btn-add-2').addEventListener('click', () => openModal());
$('#btn-add-empty').addEventListener('click', () => openModal());
$('#acc-reveal').addEventListener('click', () => { const i = $('#acc-password'); i.type = i.type === 'password' ? 'text' : 'password'; });
$('#acc-save').addEventListener('click', async () => {
  const account = {
    id: $('#acc-id').value || undefined,
    label: $('#acc-label').value.trim(),
    username: $('#acc-username').value.trim(),
    password: $('#acc-password').value,
  };
  if (!account.label && !account.username) { toast('Add a label or username.', 'warn'); return; }
  try {
    state.accounts = unwrap(await api.accounts.upsert(account));
    if (!state.selectedAccountId) state.selectedAccountId = state.accounts[state.accounts.length - 1].id;
    renderAccounts(); renderDetail(); closeModal();
    toast('Account saved.', 'good');
  } catch (e) { toast(e.message, 'bad'); }
});
async function deleteAccount(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!confirm(`Delete "${acc ? acc.label || acc.username : 'this account'}"? This cannot be undone.`)) return;
  try {
    state.accounts = unwrap(await api.accounts.remove(id));
    if (state.selectedAccountId === id) state.selectedAccountId = null;
    renderAccounts(); renderDetail(); toast('Account removed.', 'good');
  } catch (e) { toast(e.message, 'bad'); }
}

/* ---------------- Sync / current session ---------------- */
async function syncAccount(id, allowLink = false) {
  toast('Reading signed-in account…');
  try {
    let data;
    try { data = unwrap(await api.riot.refreshAccount(id, allowLink)); }
    catch (error) {
      if (allowLink || !error.message.includes('LINK_REQUIRED:')) throw error;
      const question = error.message.split('LINK_REQUIRED:').slice(1).join('LINK_REQUIRED:').trim();
      if (!confirm(question)) return false;
      data = unwrap(await api.riot.refreshAccount(id, true));
    }
    if (data.accounts && data.accounts.length) state.accounts = data.accounts;
    if (data.currentSession) state.currentSession = data.currentSession;
    state.stats = data.stats || (data.currentSession && data.currentSession.stats) || state.stats;
    updateStatusBar();
    renderAccounts(); renderDetail();
    logActivity(`Stats synced for ${ownIdentity(data.riotId)}.`, 'good');
    toast('Identity and VALORANT, League, and TFT stats synced.', 'good');
    return true;
  } catch (e) { toast(e.message, 'bad'); return false; }
}
$('#btn-sync-current').addEventListener('click', async () => {
  toast('Reading signed-in account…');
  try {
    const current = unwrap(await api.riot.currentSession());
    state.currentSession = current;
    state.stats = current.stats || null;
    updateStatusBar();
    renderAccounts();
    renderDetail();
    const visibleCurrent = ownIdentity(current.riotId, state.settings.hideDisplayNames ? 'the active account' : current.puuid.slice(0, 8));
    logActivity(`Current Riot identity resolved as ${visibleCurrent}.`, 'good');
    const ids = current.matchingAccountIds || [];
    if (ids.length === 1) {
      state.selectedAccountId = ids[0];
      await syncAccount(ids[0]);
    } else if (ids.length > 1) {
      toast(`Signed in: ${visibleCurrent} — multiple roster entries share this identity. Remove the duplicate link.`, 'warn');
    } else if (state.selectedAccountId) {
      const selected = state.accounts.find((account) => account.id === state.selectedAccountId);
      const name = selected ? selected.label || selected.username : 'selected account';
      if (confirm(`The signed-in Riot account is ${visibleCurrent}. Link it to "${name}"?`)) {
        await syncAccount(state.selectedAccountId, true);
      }
    } else {
      toast(`Signed in: ${visibleCurrent} — select a roster entry to link it explicitly.`, 'warn');
    }
  } catch (e) {
    state.currentSession = null;
    state.stats = null;
    clearChatState();
    updateStatusBar();
    renderAccounts();
    renderDetail();
    toast(e.message, 'bad');
  }
});

/* ---------------- Switching ---------------- */
const switchOverlay = $('#switch-overlay');
api.riot.onSwitchProgress((p) => {
  $('#switch-step').textContent = p.label;
  logActivity(p.label, /verified|captured|active/i.test(p.label) ? 'good' : 'info');
});
async function doSwitch(id, launchGame = null) {
  const acc = state.accounts.find((a) => a.id === id);
  const launchLabel = launchGame ? gameLabel(launchGame) : null;
  $('#switch-title').textContent = launchLabel
    ? `Switching to ${acc ? acc.label || acc.username : 'account'} + ${launchLabel}…`
    : `Switching to ${acc ? acc.label || acc.username : 'account'}…`;
  $('#switch-step').textContent = 'Preparing…';
  state.currentSession = null;
  state.stats = null;
  clearChatState();
  updateStatusBar();
  renderAccounts();
  renderDetail();
  switchOverlay.hidden = false;
  logActivity(`Switch requested for ${acc ? acc.label || acc.username : id}${launchLabel ? ` with ${launchLabel}` : ''}.`);
  try {
    const res = unwrap(await api.riot.switch(id, launchGame));
    if (res.accounts) state.accounts = res.accounts;
    if (res.verified === true && res.currentSession) {
      state.currentSession = res.currentSession;
      state.stats = res.currentSession.stats || null;
      updateStatusBar();
      renderAccounts(); renderDetail();
      const captureNote = res.sessionCapture && res.sessionCapture.captured ? ' Persistent session captured.' : '';
      const gameNote = res.launchedGame ? ` ${gameLabel(res.launchedGame)} launched.` : '';
      logActivity(`PUUID verified for ${ownIdentity(res.currentSession.riotId, 'the requested account')}.${gameNote}${captureNote}`, 'good');
      toast(`${res.mode === 'already-active' ? 'Account was already active' : 'Requested Riot account verified'}.${gameNote}${captureNote}`, 'good');
      if (state.activeView === 'chat') startChatPolling();
    } else if (res.manualRequired) {
      logActivity(`Native login needs attention: ${res.reason || 'input unavailable'}.`, 'bad');
      toast(`Automatic login could not complete: ${res.reason || 'unknown input error'}`, 'bad');
    } else if (res.verification && res.verification.status === 'mismatched') {
      logActivity('Riot exposed a different PUUID; switch rejected.', 'bad');
      toast('Riot signed into a different account. The switch was rejected and no account data was attached.', 'bad');
    } else if (res.awaitingUserVerification) {
      logActivity('Riot verification is still pending; the client was left open for 2FA.', 'warn');
      toast('Complete 2FA or the verification challenge in Riot Client. Riot Relay left the session open and did not restart it.', 'warn');
    } else if (res.recoverable) {
      logActivity('Verification timed out; Riot was left open for recovery.', 'warn');
      toast('Riot is still starting or awaiting sign-in. It was left open and was not restarted.', 'warn');
    } else if (res.inputDelivered) {
      toast('Credentials were submitted, but the requested PUUID has not been verified.', 'warn');
    } else {
      toast('The requested Riot account was not verified.', 'warn');
    }
    if (!res.accounts) {
      try { state.accounts = unwrap(await api.accounts.list()); } catch { /* locked */ }
    }
    renderAccounts(); renderDetail();
  } catch (e) {
    logActivity(e.message, 'bad');
    toast(e.message, 'bad');
  } finally { switchOverlay.hidden = true; }
}

/* ---------------- Status bar ---------------- */
async function checkClientStatus() {
  try {
    const running = unwrap(await api.riot.isRunning());
    $('#status-client').innerHTML = `<i class="dot ${running ? 'dot--on' : 'dot--off'}"></i><span>Riot Client · ${running ? 'running' : 'stopped'}</span>`;
    if (!running) {
      state.currentSession = null;
      state.stats = null;
      clearChatState();
      updateStatusBar();
      renderAccounts();
      renderDetail();
      return;
    }
    try {
      const current = unwrap(await api.riot.currentSession());
      const previousIds = new Set(state.currentSession?.matchingAccountIds || []);
      const currentIds = new Set(current.matchingAccountIds || []);
      const changed = !state.currentSession
        || state.currentSession.puuid !== current.puuid
        || previousIds.size !== currentIds.size
        || [...previousIds].some((id) => !currentIds.has(id));
      state.currentSession = current;
      state.stats = current.stats || null;
      updateStatusBar();
      if (changed) renderAccounts();
      renderDetail();
      if (state.activeView === 'chat' && !state.chat.timer) startChatPolling();
    } catch {
      // A running client on its sign-in screen is not an authenticated session.
      state.currentSession = null;
      state.stats = null;
      clearChatState();
      updateStatusBar();
      renderAccounts();
      renderDetail();
    }
  } catch { /* status polling is best-effort */ }
}
function updateStatusBar() {
  const s = state.currentSession;
  $('#status-account').textContent = s && s.riotId ? `Signed in: ${displayRiotId(s.riotId)}${s.rank ? ` (${s.rank.tierName})` : ''}` : 'No account signed in';
}
setInterval(checkClientStatus, 15000);
setInterval(refreshDeceiveState, 15000);

/* ---------------- Inventory ---------------- */
let inventoryRequestId = 0;
function setInventoryLoading(loading) {
  state.inv.loading = loading;
  for (const button of [$('#btn-load-inventory'), $('#btn-load-inventory-empty')]) {
    if (!button) continue;
    button.disabled = loading;
    button.classList.toggle('is-loading', loading);
    button.setAttribute('aria-busy', String(loading));
  }
  // Keep the game selector available so changing it can cancel a stale load.
}
function resetInventoryView(game, message = '') {
  inventoryRequestId += 1;
  state.inventory = null;
  state.inv.game = game;
  state.inv.section = '';
  state.inv.search = '';
  state.inv.tier = '';
  state.inv.exportSel = new Set();
  $('#section-list').innerHTML = '';
  $('#section-list').previousElementSibling.hidden = true;
  $('#inv-grid').innerHTML = '';
  $('#invbar').hidden = true;
  $('#export-foot').hidden = true;
  $('#value-header-wrap').hidden = true;
  $('#inv-search').value = '';
  $('#inv-tier').innerHTML = '<option value="">All tiers</option>';
  $('#inv-value').innerHTML = `<div class="valuecard__empty muted">Load ${escapeHtml(gameLabel(game))} to inspect this collection.</div>`;
  const empty = $('#inventory-empty');
  empty.hidden = false;
  empty.querySelector('h3').textContent = `${gameLabel(game)} inventory`;
  empty.querySelector('p').textContent = message || 'Open the matching Riot client, sign in, then load this inventory.';
}
function inventorySkeletons() {
  return Array.from({ length: 8 }, () => '<div class="item item--skeleton"><div class="item__img"></div><div class="item__meta"><i></i><i></i></div></div>').join('');
}
async function loadInventory() {
  const game = $('#inv-game').value || 'valorant';
  resetInventoryView(game);
  const requestId = ++inventoryRequestId;
  showView('inventory');
  setInventoryLoading(true);
  $('#inventory-empty').hidden = true;
  $('#inv-grid').setAttribute('aria-busy', 'true');
  $('#inv-grid').innerHTML = inventorySkeletons();
  try {
    const inv = unwrap(await api.inventory.buildCurrent(game));
    if (requestId !== inventoryRequestId || state.inv.game !== game) return;
    state.inventory = inv;
    logActivity(`${gameLabel(game)} inventory loaded (${fmt(inv.summary.total)} items).`, 'good');
    const present = orderedTypes(inv.summary.byType);
    state.inv.section = present.includes('Skin') ? 'Skin' : (present[0] || '');
    state.inv.exportSel = new Set(present.includes('Skin') ? ['Skin'] : present);
    renderValueCard(); renderSectionList(); renderTierFilter(); renderInventory();
    $('#section-list').previousElementSibling.hidden = present.length === 0;
    $('#export-foot').hidden = present.length === 0;
    $('#invbar').hidden = present.length === 0;
    $('#value-header-wrap').hidden = !['valorant', 'lol'].includes(game);
    const currency = game === 'valorant' ? 'VP' : game === 'lol' ? 'RP' : '';
    const valueMessage = currency && inv.summary.totalValue ? ` · ${fmt(inv.summary.totalValue)} ${currency} estimated value` : '';
    toast(`Loaded ${fmt(inv.summary.total)} items${valueMessage}.`, 'good');
  } catch (error) {
    if (requestId !== inventoryRequestId) return;
    const noSession = /no active .*session/i.test(error.message);
    resetInventoryView(game, noSession
      ? `There is no active ${game === 'valorant' ? 'Riot' : gameLabel(game)} session. Sign in, then try again.`
      : error.message);
    $('#inv-grid').removeAttribute('aria-busy');
    setInventoryLoading(false);
    const empty = $('#inventory-empty');
    empty.querySelector('h3').textContent = noSession ? 'No active session' : `${gameLabel(game)} inventory unavailable`;
    toast(noSession ? 'No active session detected.' : error.message, 'warn');
  } finally {
    if (requestId === inventoryRequestId) {
      $('#inv-grid').removeAttribute('aria-busy');
      setInventoryLoading(false);
    }
  }
}
$('#btn-load-inventory').addEventListener('click', loadInventory);
$('#btn-load-inventory-empty').addEventListener('click', loadInventory);
$('#inv-game').addEventListener('change', (event) => {
  setInventoryLoading(false);
  resetInventoryView(event.target.value);
});

function selectedItems() {
  const sel = state.inv.exportSel;
  return state.inventory.items.filter((it) => sel.has(it.type));
}

function renderValueCard() {
  const inv = state.inventory;
  if (state.inv.game === 'tft') {
    $('#inv-value').innerHTML = `
      <div class="valuecard__lbl">TFT collection</div>
      <div class="valuecard__vp">${fmt(inv.summary.total)} <small>items</small></div>
      <div class="valuecard__row"><span>${escapeHtml(displayRiotId(inv.riotId))}</span></div>
      <div class="valuecard__row" style="color:var(--muted-2)">Companions, arenas, and finishers</div>`;
    return;
  }
  const currency = state.inv.game === 'lol' ? 'RP' : 'VP';
  const skinValue = inv.summary.valueByType.Skin || 0;
  const skinCount = inv.summary.byType.Skin || 0;
  const priced = inv.items.filter((item) => item.value > 0).length;
  const wallet = inv.wallet || {};
  $('#inv-value').innerHTML = `
    <div class="valuecard__lbl">Priced skin + chroma value (estimated)</div>
    <div class="valuecard__vp">${fmt(inv.summary.totalValue || skinValue)} <small>${currency}</small></div>
    <div class="valuecard__row"><span>${fmt(skinCount)} skins · ${fmt(skinValue)} ${currency}</span><span>${fmt(priced)} priced</span></div>
    <div class="valuecard__wallet">
      ${state.inv.game === 'lol'
        ? `<span><span class="ic">${ic('wallet', 13)}</span>${fmt(wallet.rp)} RP</span><span><span class="ic">${ic('gem', 13)}</span>${fmt(wallet.blueEssence)} BE</span>`
        : `<span><span class="ic">${ic('wallet', 13)}</span>${fmt(wallet.vp)} VP</span><span><span class="ic">${ic('gem', 13)}</span>${fmt(wallet.radianite)} RP</span>`}
    </div>`;
}

function renderSectionList() {
  const inv = state.inventory;
  const rows = orderedTypes(inv.summary.byType).map((t) => {
    const checked = state.inv.exportSel.has(t) ? 'checked' : '';
    const active = state.inv.section === t ? ' is-active' : '';
    const value = Number(inv.summary.valueByType[t] || 0);
    const currency = state.inv.game === 'valorant' ? 'VP' : state.inv.game === 'lol' ? 'RP' : '';
    const valueLabel = value && currency ? `${fmt(value)} ${currency}` : '—';
    return `
      <div class="srow${active}" data-section="${t}">
        <input type="checkbox" class="srow__check" data-export="${t}" ${checked} />
        <span class="srow__name">${escapeHtml(sectionLabel(t))}</span>
        <span class="srow__meta">
          <div class="srow__count">${fmt(inv.summary.byType[t])}</div>
          <div class="srow__vp ${value ? '' : 'dim'}">${valueLabel}</div>
        </span>
      </div>`;
  }).join('');
  $('#section-list').innerHTML = rows;
  $$('#section-list [data-section]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.matches('[data-export]')) return;
    state.inv.section = el.dataset.section;
    state.inv.tier = '';
    renderSectionList(); renderTierFilter(); renderInventory();
  }));
  $$('#section-list [data-export]').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) state.inv.exportSel.add(cb.dataset.export); else state.inv.exportSel.delete(cb.dataset.export);
  }));
}

function renderTierFilter() {
  const inv = state.inventory;
  const present = {};
  inv.items.forEach((it) => { if (it.type === state.inv.section) present[it.tier] = (present[it.tier] || 0) + 1; });
  const tiers = inv.tierOrder.filter((t) => present[t]);
  const sel = $('#inv-tier');
  const hasTiers = tiers.length > 1;
  sel.hidden = !hasTiers;
  if (!hasTiers) { state.inv.tier = ''; return; }
  if (!tiers.includes(state.inv.tier)) state.inv.tier = '';
  sel.innerHTML = '<option value="">All tiers</option>' + tiers.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)} (${present[t]})</option>`).join('');
  sel.value = state.inv.tier;
}
$('#inv-tier').addEventListener('change', (e) => { state.inv.tier = e.target.value; renderInventory(); });
$('#inv-search').addEventListener('input', (e) => { state.inv.search = e.target.value.toLowerCase(); renderInventory(); });

function safeImageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const allowed = url.protocol === 'https:' && (
      url.hostname === 'media.valorant-api.com'
      || url.hostname.endsWith('.valorant-api.com')
      || url.hostname === 'raw.communitydragon.org'
    );
    return allowed ? url.href : '';
  } catch { return ''; }
}
function itemCard(it) {
  const name = String(it.name || 'Unnamed item');
  const category = String(it.category || it.type || 'Collection');
  const type = String(it.type || 'item').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const cls = `item item--${type}${it.fit === 'cover' ? ' item--cover' : ''}`;
  const image = safeImageUrl(it.image);
  const fallback = `<div class="item__fallback"><span>${ic('image', 20)}</span><b>${escapeHtml(initials(name))}</b></div>`;
  const badges = [];
  if (it.tier && it.tier !== 'Standard') badges.push(`<span class="badge badge--tier" style="background:${escapeHtml(it.tierColor || '#5a6b7a')}">${escapeHtml(String(it.tier).replace(' Edition', ''))}</span>`);
  if (it.value) badges.push(`<span class="badge badge--vp">${fmt(it.value)} ${escapeHtml(it.currency || (state.inv.game === 'lol' ? 'RP' : 'VP'))}</span>`);
  if (it.variants) badges.push(`<span class="badge">+${fmt(it.variants)}</span>`);
  return `
    <article class="${cls}" style="--tier:${escapeHtml(it.tierColor || '#4a4a55')}">
      <div class="item__img ${image ? 'is-loading' : 'has-error'}">
        ${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async" />` : ''}
        ${fallback}
      </div>
      <div class="item__meta">
        <div class="item__name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
        <div class="item__sub">
          <span class="item__category" title="${escapeHtml(category)}">${escapeHtml(category)}</span>
          <div class="item__badges">${badges.join('')}</div>
        </div>
      </div>
    </article>`;
}
function bindInventoryImages(root) {
  $$('img', root).forEach((image) => {
    const frame = image.closest('.item__img');
    const loaded = () => { frame.classList.remove('is-loading', 'has-error'); frame.classList.add('has-image'); };
    const failed = () => { frame.classList.remove('is-loading', 'has-image'); frame.classList.add('has-error'); image.remove(); };
    image.addEventListener('load', loaded, { once: true });
    image.addEventListener('error', failed, { once: true });
    if (image.complete) image.naturalWidth ? loaded() : failed();
  });
}
function renderInventory() {
  if (!state.inventory) return;
  const { section, search, tier } = state.inv;
  const items = state.inventory.items.filter((it) => {
    const name = String(it.name || '').toLowerCase();
    const category = String(it.category || '').toLowerCase();
    return it.type === section && (!tier || it.tier === tier) && (!search || name.includes(search) || category.includes(search));
  });
  $('#inv-section-name').textContent = sectionLabel(section || 'Collection');
  $('#inv-section-count').textContent = fmt(items.length);
  const grid = $('#inv-grid');
  grid.innerHTML = items.length ? items.map(itemCard).join('') : '<div class="empty inventory-no-results"><p class="muted">No items in this section match your filters.</p></div>';
  bindInventoryImages(grid);
}

/* ---------------- Export: JSON / CSV ---------------- */
async function doExport(format) {
  if (!state.inventory) return;
  const items = selectedItems();
  if (!items.length) { toast('Select at least one inventory section to export.', 'warn'); return; }
  try {
    const res = unwrap(await api.inventory.export({ riotId: state.inventory.riotId, items, summary: { ...state.inventory.summary, exported: items.length }, format }));
    if (res.saved) toast(`Exported ${items.length} items.`, 'good');
  } catch (e) { toast(e.message, 'bad'); }
}
$('#btn-export-json').addEventListener('click', () => doExport('json'));
$('#btn-export-csv').addEventListener('click', () => doExport('csv'));

/* ---------------- Export: image (skins grid + optional value header) ---------------- */
function loadImg(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
    setTimeout(() => resolve(img.complete && img.naturalWidth ? img : null), 9000);
  });
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawHeader(ctx, W, includeValue, items) {
  const totalValue = items.reduce((sum, item) => sum + (item.value || 0), 0);
  const currency = state.inv.game === 'lol' ? 'RP' : 'VP';
  ctx.fillStyle = '#e8e8ec'; ctx.font = '700 16px Segoe UI, sans-serif';
  ctx.fillText('RIOT RELAY', 40, 40);
  ctx.fillStyle = '#8a8a95'; ctx.font = '12px Segoe UI, sans-serif';
  ctx.fillText(`${gameLabel(state.inv.game)} collection`, 40, 60);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#b9b9c6'; ctx.fillText(displayRiotId(state.inventory.riotId), W - 40, 40);
  ctx.fillStyle = '#565660'; ctx.fillText(new Date().toLocaleDateString(), W - 40, 60);
  ctx.textAlign = 'left';
  if (includeValue) {
    ctx.fillStyle = '#565660'; ctx.font = '600 11px Segoe UI, sans-serif';
    ctx.fillText('COLLECTION VALUE', 40, 100);
    ctx.fillStyle = '#fff'; ctx.font = '800 40px Segoe UI, sans-serif';
    ctx.fillText(fmt(totalValue), 40, 138);
    const tw = ctx.measureText(fmt(totalValue)).width;
    ctx.fillStyle = '#d8d8e0'; ctx.font = '700 16px Segoe UI, sans-serif';
    ctx.fillText(` ${currency}`, 40 + tw + 6, 138);
    ctx.fillStyle = '#8a8a95'; ctx.font = '13px Segoe UI, sans-serif';
    ctx.textAlign = 'right'; ctx.fillText(`${fmt(items.length)} items`, W - 40, 138); ctx.textAlign = 'left';
  }
  ctx.strokeStyle = '#24242c'; ctx.beginPath();
  const y = includeValue ? 160 : 78;
  ctx.moveTo(40, y); ctx.lineTo(W - 40, y); ctx.stroke();
}
async function buildSkinsCanvas(includeValue) {
  // Export whichever inventory sections are checked; values use each game's currency.
  const items = selectedItems();
  const cols = 5, cellW = 176, imgH = 100, labelH = 44, gap = 14, pad = 40;
  const headerH = includeValue ? 172 : 92;
  const W = pad * 2 + cols * cellW + (cols - 1) * gap;
  const rows = Math.max(1, Math.ceil(items.length / cols));
  const H = headerH + rows * (imgH + labelH + gap) + 40;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0b0b0e'; ctx.fillRect(0, 0, W, H);
  drawHeader(ctx, W, includeValue, items);

  const imgs = await Promise.all(items.map((s) => loadImg(s.image)));
  items.forEach((s, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = pad + col * (cellW + gap);
    const y = headerH + row * (imgH + labelH + gap);
    ctx.fillStyle = '#121216'; roundRect(ctx, x, y, cellW, imgH + labelH, 10); ctx.fill();
    ctx.fillStyle = s.tierColor || '#4a4a55'; roundRect(ctx, x, y, cellW, 3, 2); ctx.fill();
    const img = imgs[i];
    if (img && img.naturalWidth) {
      const maxW = cellW - 24, maxH = imgH - 16;
      const sc = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
      const dw = img.naturalWidth * sc, dh = img.naturalHeight * sc;
      ctx.drawImage(img, x + (cellW - dw) / 2, y + 10 + (maxH - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = '#8a8a95'; ctx.font = '600 12px Segoe UI, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(fitText(ctx, s.name, cellW - 20), x + cellW / 2, y + imgH / 2); ctx.textAlign = 'left';
    }
    ctx.fillStyle = '#e8e8ec'; ctx.font = '600 12px Segoe UI, sans-serif';
    ctx.fillText(fitText(ctx, s.name, cellW - 24), x + 12, y + imgH + 18);
    if (includeValue && s.value) { ctx.fillStyle = '#b9b9c6'; ctx.font = '700 11px Segoe UI, sans-serif'; ctx.fillText(`${fmt(s.value)} ${s.currency || (state.inv.game === 'lol' ? 'RP' : 'VP')}`, x + 12, y + imgH + 34); }
  });
  ctx.fillStyle = '#565660'; ctx.font = '11px Segoe UI, sans-serif';
  const currency = state.inv.game === 'lol' ? 'RP' : 'VP';
  const note = includeValue ? `Generated by Riot Relay · ${currency} values are store-price estimates` : 'Generated by Riot Relay';
  ctx.fillText(note, pad, H - 16);
  return c;
}
function fitText(ctx, text, maxW) {
  let t = String(text || '');
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
async function exportImage(format = 'png') {
  if (!state.inventory) return;
  // Value headers are available for VALORANT VP and League RP collections.
  const includeValue = ['valorant', 'lol'].includes(state.inv.game) && $('#export-include-value').checked;
  toast('Rendering image…');
  try {
    const canvas = await buildSkinsCanvas(includeValue);
    const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    let dataUrl;
    try { dataUrl = canvas.toDataURL(mime, 0.92); }
    catch (_) {
      const fb = buildValueCanvas();
      dataUrl = fb.toDataURL(mime, 0.92);
      toast('Skin art blocked by CORS — exported a value summary instead.', 'warn');
    }
    const res = unwrap(await api.inventory.exportImage({ riotId: state.inventory.riotId, dataUrl, format }));
    if (res.saved) toast('Image saved.', 'good');
  } catch (e) { toast(e.message, 'bad'); }
}
$('#btn-export-png').addEventListener('click', () => exportImage('png'));

/* Fallback: text-only value card (used if skin art can't be embedded). */
function buildValueCanvas() {
  const inv = state.inventory;
  const items = inv.items.filter((item) => item.value > 0);
  const currency = state.inv.game === 'lol' ? 'RP' : 'VP';
  const W = 620, H = 260;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0b0b0e'; ctx.fillRect(0, 0, W, H);
  drawHeader(ctx, W, true, items);
  ctx.fillStyle = '#8a8a95'; ctx.font = '13px Segoe UI, sans-serif';
  ctx.fillText(`${fmt(items.length)} priced collection items`, 40, 210);
  ctx.fillStyle = '#565660'; ctx.font = '11px Segoe UI, sans-serif';
  ctx.fillText(`Generated by Riot Relay · ${currency} values are store-price estimates`, 40, H - 20);
  return c;
}

/* ---------------- Settings ---------------- */
$$('.settingnav').forEach((b) => b.addEventListener('click', () => {
  $$('.settingnav').forEach((x) => x.classList.toggle('is-active', x === b));
  $$('.setting-group').forEach((g) => g.classList.toggle('is-active', g.dataset.group === b.dataset.group));
}));
async function loadSettings() {
  const [s, vaultStatus, helloAvailable] = await Promise.all([
    api.settings.get().then(unwrap),
    api.vault.status().then(unwrap),
    windowsHelloAvailable(),
  ]);
  state.settings = s;
  $('#set-client-path').value = s.clientPath || '';
  $('#set-autofill').checked = !!s.autoFill;
  $('#set-minimize').checked = !!s.minimizeOnSwitch;
  $('#set-minimize-tray').checked = s.minimizeToTray !== false;
  const keyStorageMode = vaultStatus.keyStorageMode || 'disabled';
  $$('input[name="key-storage-mode"]').forEach((input) => {
    input.checked = input.value === keyStorageMode;
    input.disabled = !vaultStatus.unlocked
      || (input.value !== 'disabled' && !s.encryptionAvailable)
      || (input.value === 'hello' && !helloAvailable);
  });
  $('#set-deceive').checked = !!s.useDeceive;
  $('#set-deceive-party').checked = s.deceivePreserveParty !== false;
  $('#deceive-activity-mode').value = s.deceiveActivityMode || 'hide';
  $('#deceive-custom-status').value = s.deceiveCustomStatus || '';
  $('#set-deceive-helper').checked = s.deceiveLeagueHelper !== false;
  $('#set-hide-login').checked = !!s.hideLoginNames;
  $('#set-hide-display').checked = !!s.hideDisplayNames;
  $('#client-detected').textContent = s.detectedClient ? `Detected: ${s.detectedClient}` : 'Riot Client not auto-detected. Set the path manually.';
  $('#enc-status').textContent = s.encryptionAvailable
    ? 'Windows OS key protection is available. Choose how this vault may use it below.'
    : 'OS key protection is unavailable. This vault can only be unlocked with its master password.';
  $('#hello-status').textContent = helloAvailable
    ? 'Windows Hello is available through Chromium WebAuthn. Hello mode requires verified Windows consent every time the stored key is used.'
    : 'Windows Hello is not configured or unavailable; standard OS-stored mode can still be used.';
  updateDeceiveUI();
  refreshDeceiveState();
  refreshCatalogStatus();
}
function updateDeceiveUI(runtime = null) {
  const on = !!state.settings.useDeceive;
  const status = (runtime && runtime.status) || state.settings.deceiveStatus || 'offline';
  const label = status === 'chat' ? 'online' : status;
  const running = !!(runtime && runtime.running);
  const connected = !!(runtime && runtime.chatConnected);
  const helperAvailable = !!(runtime && runtime.helperAvailable);
  $('#rail-deceive').classList.toggle('on', running || on);
  $('#rail-deceive').title = running ? `Deceive active (${label})` : (on ? `Deceive enabled for next switch (${label})` : 'Deceive disabled');
  const runtimeEl = $('#deceive-runtime');
  runtimeEl.className = `deceive-runtime ${connected ? 'is-connected' : running ? 'is-running' : ''}`;
  runtimeEl.innerHTML = `<i class="dot ${connected ? 'dot--on' : running ? 'dot--wait' : 'dot--off'}"></i><span>${connected ? 'Chat connected' : running ? 'Proxy waiting for chat' : on ? 'Enabled for next switch' : 'Disabled'}</span>`;
  $('#deceive-proxy-state').textContent = running ? `Running · ${runtime.activeConnections || 0} connection${runtime.activeConnections === 1 ? '' : 's'}` : 'Not running';
  $('#deceive-proxy-detail').textContent = connected
    ? `Presence is actively being rewritten as ${label}.`
    : running ? 'Riot chat has not connected to the local proxy yet.' : on ? 'Switch an account to start the local proxy.' : 'Enable Deceive to use it on your next switch.';
  $('#deceive-chat-state').textContent = helperAvailable
    ? `League helper online · appearing ${label}`
    : connected && runtime.clientProduct === 'valorant'
      ? 'VALORANT connected · use controls here'
      : connected ? 'Presence connected · helper unavailable' : 'Waiting for Riot chat';
  const error = runtime && runtime.lastError;
  $('#deceive-last-error').hidden = !error;
  $('#deceive-last-error').textContent = error || '';
  $('#status-deceive').textContent = connected ? `Deceive · ${label}` : running ? 'Deceive · waiting' : on ? 'Deceive · armed' : 'Deceive · off';
  $$('#deceive-status button').forEach((button) => {
    const active = button.dataset.status === status;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = !on && !running;
  });
  $('#deceive-custom-wrap').hidden = (runtime && runtime.activityMode || state.settings.deceiveActivityMode || 'hide') !== 'generic';
}
async function refreshDeceiveState() {
  try {
    const runtime = unwrap(await api.deceive.getState());
    updateDeceiveUI(runtime);
    return runtime;
  } catch {
    updateDeceiveUI();
    return null;
  }
}
async function refreshCatalogStatus() {
  try {
    const st = unwrap(await api.inventory.catalogStatus());
    $('#catalog-status').textContent = st.total ? `${st.total} cosmetics indexed. Used to enrich and appraise inventory exports.` : 'Catalog not loaded yet — it fetches automatically on first inventory load.';
    $('#status-catalog').textContent = `Catalog: ${st.total || 0}`;
  } catch { /* ignore */ }
}
async function setSetting(patch) { state.settings = unwrap(await api.settings.set(patch)); }
$('#set-client-path').addEventListener('change', (e) => setSetting({ clientPath: e.target.value.trim() }));
$('#set-autofill').addEventListener('change', (e) => setSetting({ autoFill: e.target.checked }));
$('#set-minimize').addEventListener('change', (e) => setSetting({ minimizeOnSwitch: e.target.checked }));
$('#set-minimize-tray').addEventListener('change', async (event) => {
  await setSetting({ minimizeToTray: event.target.checked });
  toast(event.target.checked
    ? 'Minimize to tray enabled. Use the Windows notification area to restore or quit Riot Relay.'
    : 'Minimize to tray disabled. The minimize button will keep Riot Relay on the taskbar.', 'good');
});
async function applyPrivacySetting(key, checked) {
  await setSetting({ [key]: checked });
  renderAccounts(); renderDetail(); updateStatusBar();
  if (state.inventory) renderValueCard();
  if (state.chat.identity && state.chat.identity.riotId) $('#chat-identity').textContent = `Active · ${displayRiotId(state.chat.identity.riotId)}`;
}
$('#set-hide-login').addEventListener('change', (event) => applyPrivacySetting('hideLoginNames', event.target.checked));
$('#set-hide-display').addEventListener('change', (event) => applyPrivacySetting('hideDisplayNames', event.target.checked));
$('#set-deceive').addEventListener('change', async (event) => {
  await setSetting({ useDeceive: event.target.checked });
  updateDeceiveUI();
  await refreshDeceiveState();
  toast(event.target.checked ? 'Deceive is armed for the next account switch.' : 'Deceive is disabled for the next Riot launch.', 'good');
});
async function applyDeceiveOptions() {
  const options = {
    preserveParty: $('#set-deceive-party').checked,
    activityMode: $('#deceive-activity-mode').value,
    customStatus: $('#deceive-custom-status').value,
    leagueHelper: $('#set-deceive-helper').checked,
  };
  await setSetting({
    deceivePreserveParty: options.preserveParty,
    deceiveActivityMode: options.activityMode,
    deceiveCustomStatus: options.customStatus,
    deceiveLeagueHelper: options.leagueHelper,
  });
  unwrap(await api.deceive.setOptions(options));
  $('#deceive-custom-wrap').hidden = options.activityMode !== 'generic';
  await refreshDeceiveState();
  toast('Deceive activity options updated.', 'good');
}
['#set-deceive-party', '#set-deceive-helper', '#deceive-activity-mode']
  .forEach((selector) => $(selector).addEventListener('change', applyDeceiveOptions));
$('#deceive-custom-status').addEventListener('change', applyDeceiveOptions);
$$('#deceive-status button').forEach((button) => button.addEventListener('click', async () => {
  await setSetting({ deceiveStatus: button.dataset.status });
  const result = unwrap(await api.deceive.setStatus(button.dataset.status));
  const runtime = await refreshDeceiveState();
  const label = button.dataset.status === 'chat' ? 'online' : button.dataset.status;
  toast(result.applied
    ? `Presence changed to ${label}; Riot Relay confirmed it in League chat when the helper is available.`
    : `Presence set to ${label}${runtime && runtime.running ? '; it will apply on the next presence update.' : ' for the next switch.'}`, 'good');
}));
$('#btn-deceive-refresh').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.classList.add('is-loading'); button.disabled = true;
  await refreshDeceiveState();
  button.classList.remove('is-loading'); button.disabled = false;
});
$$('input[name="key-storage-mode"]').forEach((input) => input.addEventListener('change', async (event) => {
  if (!event.target.checked) return;
  const requested = event.target.value;
  $$('input[name="key-storage-mode"]').forEach((option) => (option.disabled = true));
  try {
    const registration = requested === 'hello' ? await registerWindowsHello() : null;
    const result = unwrap(await api.vault.setKeyStorageMode(requested, registration));
    const message = result.mode === 'hello'
      ? 'Windows Hello–gated stored-key unlock enabled for this vault.'
      : result.mode === 'os'
        ? 'Standard OS-stored key enabled without a Windows Hello prompt.'
        : 'OS-stored key disabled and removed for this vault.';
    toast(message, result.mode === 'disabled' ? 'good' : 'warn');
  } catch (error) {
    toast(error.message, 'bad');
  } finally {
    await loadSettings();
  }
}));
$('#btn-pick-client').addEventListener('click', async () => {
  const res = unwrap(await api.settings.pickClient());
  if (res.picked) { $('#set-client-path').value = res.clientPath; $('#client-detected').textContent = `Detected: ${res.clientPath}`; toast('Client path set.', 'good'); }
});
$('#btn-change-master').addEventListener('click', async () => {
  const np = $('#set-new-master').value;
  if (!np) { toast('Enter a new master password.', 'warn'); return; }
  try { unwrap(await api.vault.changeMaster(np)); $('#set-new-master').value = ''; toast('Master password updated.', 'good'); }
  catch (e) { toast(e.message, 'bad'); }
});
$('#btn-refresh-catalog').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.classList.add('is-loading'); button.disabled = true; button.setAttribute('aria-busy', 'true');
  try {
    const st = unwrap(await api.inventory.loadCatalog(true));
    toast(`Catalog refreshed (${st.total} items).`, 'good');
    refreshCatalogStatus();
  } catch (error) { toast(error.message, 'bad'); }
  finally { button.classList.remove('is-loading'); button.disabled = false; button.removeAttribute('aria-busy'); }
});
$('#btn-run-tour').addEventListener('click', startFeatureTour);
$('#rail-deceive').addEventListener('click', async () => {
  const next = !state.settings.useDeceive;
  await setSetting({ useDeceive: next });
  $('#set-deceive').checked = next;
  updateDeceiveUI();
  await refreshDeceiveState();
  toast(next ? 'Deceive armed for the next account switch.' : 'Deceive disabled for the next Riot launch.', 'good');
});

/* ---------------- Application updates ---------------- */
let lastUpdateStatus = '';
function renderUpdateState(updateState) {
  if (!updateState || typeof updateState !== 'object') return;
  const previousStatus = lastUpdateStatus;
  state.updates = { ...state.updates, ...updateState };
  lastUpdateStatus = state.updates.status;
  const version = String(state.updates.currentVersion || '1.3.2');
  const available = String(state.updates.availableVersion || '');
  const progress = Math.max(0, Math.min(100, Number(state.updates.progress) || 0));
  $('#app-version-title').textContent = version;
  $('#app-version-status').textContent = `Riot Relay ${version}`;
  $('#update-current-version').textContent = `Riot Relay ${version}`;

  const labels = {
    idle: 'Update service ready', checking: 'Checking GitHub Releases…', current: 'Riot Relay is up to date',
    available: `Version ${available || 'new'} is available`, downloading: `Downloading ${Math.round(progress)}%`,
    downloaded: `Version ${available || 'new'} is ready`, installing: 'Restarting to install…',
    unsupported: 'Manual updates for this build', error: 'Update check failed',
  };
  $('#update-status').textContent = labels[state.updates.status] || 'Update status unavailable';
  const checked = state.updates.lastCheckedAt
    ? ` Last checked ${new Date(state.updates.lastCheckedAt).toLocaleString()}.`
    : '';
  const details = {
    idle: 'Automatic checks begin shortly after startup.',
    checking: 'Only release/version metadata is requested from GitHub.',
    current: `No newer stable release was found.${checked}`,
    available: 'The verified release package will download automatically.',
    downloading: 'You can keep using Riot Relay while the update downloads.',
    downloaded: 'Restart now, or quit normally later to install the downloaded update.',
    installing: 'Riot Relay will reopen after the installer completes.',
    unsupported: state.updates.error || 'Use GitHub Releases to update this package.',
    error: state.updates.error || 'GitHub Releases could not be reached. Try again later.',
  };
  $('#update-detail').textContent = details[state.updates.status] || checked.trim() || 'Waiting for update service.';
  $('#update-progress').hidden = state.updates.status !== 'downloading';
  $('#update-progress-bar').style.width = `${progress}%`;
  $('#btn-update-install').hidden = state.updates.status !== 'downloaded';
  $('#btn-update-check').disabled = !state.updates.supported
    || ['checking', 'downloading', 'installing'].includes(state.updates.status);

  if (previousStatus && previousStatus !== state.updates.status) {
    if (state.updates.status === 'downloaded') toast(`Riot Relay ${available} is ready to install.`, 'good');
    else if (state.updates.status === 'error') toast(state.updates.error || 'Update check failed.', 'warn');
  }
}
async function initUpdates() {
  api.updates.onState(renderUpdateState);
  try { renderUpdateState(unwrap(await api.updates.getState())); }
  catch (error) { renderUpdateState({ supported: false, status: 'error', error: error.message }); }
}
$('#btn-update-check').addEventListener('click', async () => {
  try {
    renderUpdateState(unwrap(await api.updates.check()));
    if (state.updates.status === 'current') toast('Riot Relay is up to date.', 'good');
  } catch (error) { toast(error.message, 'bad'); }
});
$('#btn-update-install').addEventListener('click', async () => {
  try { renderUpdateState(unwrap(await api.updates.install())); }
  catch (error) { toast(error.message, 'bad'); }
});
$('#btn-open-releases').addEventListener('click', () => api.project.open('releases'));
$('#btn-open-docs').addEventListener('click', () => api.project.open('docs'));

/* ---------------- Boot ---------------- */
initUpdates();
bootVault();
