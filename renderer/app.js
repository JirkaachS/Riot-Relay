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
  rosterSections: [],
  selectedAccountId: null,
  currentSession: null,
  stats: null,
  activeView: 'accounts',
  activity: [],
  rankIcons: {},
  settings: {},
  updates: { status: 'idle', currentVersion: '1.3.8', availableVersion: null, progress: 0 },
  startup: { supported: false, enabled: false, reason: 'Checking Windows startup registration…' },
  configProfiles: [],
  configProfilesError: null,
  configRoles: { intentional: false },
  motion: { seenAccountIds: new Set() },
  rosterDrag: { accountId: null, sectionId: null, suppressClickUntil: 0 },
  inventory: null,
  games: [{ id: 'valorant', label: 'VALORANT' }],
  inv: { section: 'Skin', exportSel: new Set(['Skin']), search: '', tier: '', accSearch: '', game: 'valorant', entranceSeen: new Set() },
  chat: {
    identity: null, friends: [], selectedId: null, messages: [], search: '', filter: 'all', sort: 'unread', drafts: new Map(), timer: null, loading: false, generation: 0,
    inboxIdentityHash: null, inboxBaseline: false, seenIncomingIds: new Set(), unreadByConversation: new Map(),
  },
};

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const displayLogin = (value) => state.settings.hideLoginNames ? '••••••••' : String(value || '—');
const displayRiotId = (value) => state.settings.hideDisplayNames ? 'Hidden Riot ID' : String(value || '');
const ownIdentity = (value, fallback = 'the verified account') => displayRiotId(value) || fallback;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function showBootScreen(message = 'Loading secure workspace…') {
  const screen = $('#boot-screen');
  if (!screen) return;
  screen.hidden = false;
  screen.classList.remove('is-leaving');
  const status = $('#boot-status');
  if (status) status.textContent = message;
}
function dismissBootScreen() {
  const screen = $('#boot-screen');
  if (!screen || screen.hidden || screen.classList.contains('is-leaving')) return;
  screen.classList.add('is-leaving');
  const finish = () => { screen.hidden = true; };
  screen.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, reducedMotion.matches ? 0 : 240);
}
const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function finishBootScreen() {
  await nextPaint();
  dismissBootScreen();
}

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
  setTimeout(() => el.classList.add('is-leaving'), 4200);
  setTimeout(() => el.remove(), reducedMotion.matches ? 4210 : 4440);
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
const CONFIG_ACTIVITY_LABELS = Object.freeze({
  started: 'started',
  'identity-verified': 'exact signed-in identity verified',
  'identity-verified-before-write': 'exact target identity reverified before write',
  'identity-reverified': 'exact signed-in identity reverified after read-back',
  'settings-read': 'settings document read',
  'target-identified': 'signed-in target identified',
  'target-settings-read': 'target settings read for backup',
  'backup-retained': 'target backup saved and retained',
  'backup-loaded': 'retained backup loaded',
  'capture-saved': 'captured settings saved',
  'endpoint-ready': 'Riot Client UX endpoint ready',
  'route-proven': 'player-preferences route proven by GET',
  'put-accepted': 'Riot Client accepted the settings write',
  'readback-fetched': 'same-route read-back received',
  'readback-mismatch': 'read-back did not match; backup remains retained',
  'write-verified': 'same-route read-back verified',
  completed: 'completed',
  failed: 'failed',
});
api.configs.onActivity((activity) => {
  if (!activity || !['capture', 'apply', 'restore'].includes(activity.operation)) return;
  const label = CONFIG_ACTIVITY_LABELS[activity.stage];
  if (!label) return;
  const operation = activity.operation[0].toUpperCase() + activity.operation.slice(1);
  const message = activity.stage === 'failed' ? `${operation} failed${activity.detail ? `: ${activity.detail}` : '.'}` : `${operation}: ${label}.`;
  logActivity(message, activity.outcome === 'bad' ? 'bad' : activity.outcome === 'good' ? 'good' : 'info');
});
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
  const changed = state.activeView !== name;
  const apply = () => {
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
    if (name === 'chat') {
      if (state.chat.selectedId) {
        clearConversationUnread(state.chat.selectedId);
        renderChatFriends();
      }
      startChatPolling();
    }
  };
  if (changed && typeof document.startViewTransition === 'function' && !reducedMotion.matches) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}
$$('.railbtn[data-view], .tab[data-view], .workspace-tab[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

/* ---------------- Current-session Riot chat ---------------- */
function stopChatPolling() {
  if (state.chat.timer) clearInterval(state.chat.timer);
  state.chat.timer = null;
}
function resetChatInbox(identityHash = null) {
  state.chat.inboxIdentityHash = identityHash;
  state.chat.inboxBaseline = false;
  state.chat.seenIncomingIds = new Set();
  state.chat.unreadByConversation = new Map();
  state.chat.drafts = new Map();
  updateChatUnreadBadges();
}
function clearChatState() {
  stopChatPolling();
  state.chat.generation += 1;
  state.chat.loading = false;
  state.chat.identity = null;
  state.chat.friends = [];
  state.chat.selectedId = null;
  state.chat.messages = [];
  state.chat.drafts = new Map();
  resetChatInbox();
  $('#chat-identity').textContent = 'Riot Client not connected';
  $('#chat-friends').innerHTML = '';
  $('#chat-workspace').hidden = true;
  $('#chat-empty').hidden = false;
  $('#chat-messages').innerHTML = '';
  $('#chat-title').textContent = 'Conversation';
  $('#chat-presence').textContent = 'Current Riot session';
  $('#chat-head-avatar').innerHTML = '?';
}
function chatAvailability(value) {
  const availability = String(value || 'offline').toLowerCase();
  return ['chat', 'online', 'away', 'mobile', 'dnd'].includes(availability) ? availability : 'offline';
}
function chatAvailabilityLabel(value) {
  return { chat: 'Online', online: 'Online', away: 'Away', mobile: 'Mobile', dnd: 'Do not disturb', offline: 'Offline' }[chatAvailability(value)];
}
function resizeChatComposer() {
  const input = $('#chat-message');
  input.style.height = 'auto';
  input.style.height = `${Math.min(120, Math.max(31, input.scrollHeight))}px`;
  $('#chat-message-count').textContent = `${input.value.length} / 1000`;
}
function saveChatDraft() {
  if (!state.chat.selectedId) return;
  const value = $('#chat-message').value;
  if (value) state.chat.drafts.set(state.chat.selectedId, value);
  else state.chat.drafts.delete(state.chat.selectedId);
}
function restoreChatDraft() {
  $('#chat-message').value = state.chat.selectedId ? state.chat.drafts.get(state.chat.selectedId) || '' : '';
  resizeChatComposer();
}
function boundedBadge(count) { return count > 99 ? '99+' : String(count); }
function updateChatUnreadBadges() {
  const total = [...state.chat.unreadByConversation.values()].reduce((sum, count) => sum + count, 0);
  const accessible = total ? `Chat, ${total} unread message${total === 1 ? '' : 's'}` : 'Chat';
  [$('#rail-chat-badge'), $('#workspace-chat-badge')].forEach((badge) => {
    badge.hidden = !total;
    badge.textContent = total ? boundedBadge(total) : '';
  });
  const railButton = $('#rail-chat');
  const workspaceButton = $('#workspace-chat');
  railButton.title = accessible;
  railButton.setAttribute('aria-label', accessible);
  workspaceButton.title = accessible;
  workspaceButton.setAttribute('aria-label', accessible);
}
function rememberIncomingId(id) {
  if (state.chat.seenIncomingIds.has(id)) return false;
  state.chat.seenIncomingIds.add(id);
  while (state.chat.seenIncomingIds.size > 1000) {
    state.chat.seenIncomingIds.delete(state.chat.seenIncomingIds.values().next().value);
  }
  return true;
}
function applyChatInboxSnapshot(result) {
  const identityHash = String(result.identity && result.identity.puuidHash || '');
  if (identityHash !== state.chat.inboxIdentityHash) resetChatInbox(identityHash);
  if (!result.inboxAvailable) return;
  const markers = Array.isArray(result.incomingMessages) ? result.incomingMessages : [];
  if (!state.chat.inboxBaseline) {
    markers.forEach((marker) => {
      if (/^[A-Za-z0-9_-]{32}$/.test(String(marker && marker.id || ''))) rememberIncomingId(marker.id);
    });
    state.chat.inboxBaseline = true;
    return;
  }
  for (const marker of markers) {
    const id = String(marker && marker.id || '');
    const conversationId = String(marker && marker.conversationId || '');
    if (!/^[A-Za-z0-9_-]{32}$/.test(id) || !/^[A-Za-z0-9_-]{32}$/.test(conversationId) || !rememberIncomingId(id)) continue;
    const isOpen = state.activeView === 'chat' && state.chat.selectedId === conversationId;
    if (!isOpen) state.chat.unreadByConversation.set(conversationId, (state.chat.unreadByConversation.get(conversationId) || 0) + 1);
  }
  updateChatUnreadBadges();
}
function clearConversationUnread(conversationId) {
  if (state.chat.unreadByConversation.delete(conversationId)) updateChatUnreadBadges();
}
function chatFriendLabel(friend) {
  return state.settings.hideDisplayNames ? 'Hidden Riot ID' : String(friend && friend.riotId || 'Friend');
}
function safeChatAvatarUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.search || url.hash) return '';
    if (url.hostname === 'media.valorant-api.com'
      && /^\/playercards\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/smallart\.png$/i.test(url.pathname)) return url.href;
    if (url.hostname === 'raw.communitydragon.org'
      && /^\/latest\/plugins\/rcp-be-lol-game-data\/global\/default\/v1\/profile-icons\/\d{1,9}\.jpg$/.test(url.pathname)) return url.href;
    return '';
  } catch { return ''; }
}
function chatAvatarContent(friend) {
  const label = chatFriendLabel(friend);
  const imageUrl = safeChatAvatarUrl(friend && friend.avatarUrl);
  const image = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(state.settings.hideDisplayNames ? 'Friend avatar' : `${label} avatar`)}" loading="lazy" decoding="async" />`
    : '';
  return `<span>${escapeHtml(initials(label))}</span>${image}`;
}
function bindChatAvatars(root = document) {
  $$('.chat-avatar img', root).forEach((image) => image.addEventListener('error', () => { image.hidden = true; }, { once: true }));
}
function chatActivityLine(friend) {
  const activity = friend && friend.activity;
  if (!activity || typeof activity !== 'object') return String(friend && friend.game || '');
  const parts = [activity.game];
  if (activity.phase) parts.push(activity.phase);
  if (activity.product === 'league' && activity.champion) parts.push(activity.champion);
  if (activity.product === 'valorant' && activity.map) parts.push(activity.map);
  if (activity.mode) parts.push(activity.mode);
  return parts.filter((value, index, values) => value && values.indexOf(value) === index).join(' · ');
}
function renderChatHeader(friend) {
  $('#chat-title').textContent = friend ? chatFriendLabel(friend) : 'Conversation';
  $('#chat-presence').textContent = friend ? (chatActivityLine(friend) || 'No game activity') : 'Current Riot session';
  $('#chat-availability').textContent = friend ? chatAvailabilityLabel(friend.availability) : '';
  $('#chat-availability').hidden = !friend;
  $('#chat-head-avatar').innerHTML = friend ? chatAvatarContent(friend) : '?';
  const actions = $('#chat-profile-actions');
  const labels = { tracker: 'Tracker', vtl: 'VTL', dpm: 'DPM', opgg: 'OP.GG', ugg: 'U.GG', deeplol: 'DeepLoL' };
  const links = friend && friend.links && typeof friend.links === 'object' ? friend.links : {};
  actions.innerHTML = Object.keys(labels).filter((provider) => typeof links[provider] === 'string')
    .map((provider) => `<button type="button" data-chat-profile="${provider}" title="Open ${labels[provider]} profile">${labels[provider]}</button>`).join('');
  actions.hidden = !actions.childElementCount;
  bindChatAvatars($('#chat-head-avatar'));
}
$('#chat-profile-actions').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-chat-profile]');
  if (!button || !state.chat.selectedId) return;
  const friend = state.chat.friends.find((item) => item.id === state.chat.selectedId);
  const target = friend && friend.links && friend.links[button.dataset.chatProfile];
  if (!target) return;
  button.disabled = true;
  try { unwrap(await api.openExternal(target)); }
  catch (error) { toast(error.message, 'warn'); }
  finally { button.disabled = false; }
});
function renderChatFriends() {
  const search = state.chat.search.toLowerCase();
  const visible = state.chat.friends.filter((friend) => {
    if (search && !friend.riotId.toLowerCase().includes(search)) return false;
    const unread = state.chat.unreadByConversation.get(friend.id) || 0;
    if (state.chat.filter === 'online' && chatAvailability(friend.availability) === 'offline') return false;
    if (state.chat.filter === 'unread' && !unread) return false;
    return true;
  });
  const presenceOrder = { chat: 0, online: 0, dnd: 1, away: 2, mobile: 3, offline: 4 };
  visible.sort((a, b) => {
    const unreadA = state.chat.unreadByConversation.get(a.id) || 0;
    const unreadB = state.chat.unreadByConversation.get(b.id) || 0;
    if (state.chat.sort === 'unread' && unreadA !== unreadB) return unreadB - unreadA;
    if (state.chat.sort !== 'name') {
      const presence = (presenceOrder[chatAvailability(a.availability)] || 0) - (presenceOrder[chatAvailability(b.availability)] || 0);
      if (presence) return presence;
    }
    return a.riotId.localeCompare(b.riotId) || a.id.localeCompare(b.id);
  });
  $('#chat-friends').innerHTML = visible.map((friend) => {
    const active = friend.id === state.chat.selectedId ? ' is-active' : '';
    const availability = chatAvailability(friend.availability);
    const unread = state.chat.unreadByConversation.get(friend.id) || 0;
    const hasDraft = !!state.chat.drafts.get(friend.id);
    const label = chatFriendLabel(friend);
    const accessible = `Open chat with ${label}${unread ? `, ${unread} unread message${unread === 1 ? '' : 's'}` : ''}${hasDraft ? ', draft saved' : ''}`;
    return `<button class="chat-friend${active}" type="button" data-chat-friend="${escapeHtml(friend.id)}" aria-label="${escapeHtml(accessible)}" title="${escapeHtml(accessible)}">
      <span class="chat-friend__avatar chat-avatar">${chatAvatarContent(friend)}<i class="chat-presence chat-presence--${escapeHtml(availability)}"></i></span>
      <span class="chat-friend__meta"><strong>${escapeHtml(label)}</strong><small><span>${escapeHtml(chatActivityLine(friend) || 'No game activity')}</span><em>${escapeHtml(chatAvailabilityLabel(availability))}</em></small></span>
      ${hasDraft ? '<span class="chat-draft" aria-hidden="true">Draft</span>' : ''}
      ${unread ? `<span class="chat-unread chat-unread--friend" aria-hidden="true">${escapeHtml(boundedBadge(unread))}</span>` : ''}
    </button>`;
  }).join('') || '<div class="chat-list-empty">No friends match this view.</div>';
  bindChatAvatars($('#chat-friends'));
  $$('#chat-friends [data-chat-friend]').forEach((button) => button.addEventListener('click', async () => {
    saveChatDraft();
    state.chat.selectedId = button.dataset.chatFriend;
    state.chat.messages = [];
    clearConversationUnread(state.chat.selectedId);
    renderChatFriends();
    const friend = state.chat.friends.find((item) => item.id === state.chat.selectedId);
    renderChatHeader(friend);
    restoreChatDraft();
    $('#chat-empty').hidden = true;
    $('#chat-workspace').hidden = false;
    await loadChatHistory(false);
    $('#chat-message').focus();
  }));
}
function chatDateKey(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
function chatDateLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recent';
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (chatDateKey(date) === chatDateKey(today)) return 'Today';
  if (chatDateKey(date) === chatDateKey(yesterday)) return 'Yesterday';
  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
function renderChatMessages() {
  const pane = $('#chat-messages');
  const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 60;
  const messages = [...state.chat.messages].sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
  let previous = null;
  const rows = [];
  for (const message of messages) {
    const currentDate = chatDateKey(message.timestamp);
    if (!previous || currentDate !== chatDateKey(previous.timestamp)) rows.push(`<div class="chat-date"><span>${escapeHtml(chatDateLabel(message.timestamp))}</span></div>`);
    const currentTime = new Date(message.timestamp || 0).getTime();
    const previousTime = previous ? new Date(previous.timestamp || 0).getTime() : 0;
    const grouped = previous && previous.isSelf === message.isSelf
      && String(previous.authorId || previous.authorName) === String(message.authorId || message.authorName)
      && currentDate === chatDateKey(previous.timestamp) && currentTime - previousTime >= 0 && currentTime - previousTime < 5 * 60 * 1000;
    const time = message.timestamp ? new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    rows.push(`<article class="chat-message${message.isSelf ? ' is-self' : ''}${grouped ? ' is-grouped' : ''}">
      <header><strong>${escapeHtml(message.isSelf ? 'You' : displayRiotId(message.authorName || 'Friend'))}</strong><time>${escapeHtml(time)}</time></header>
      <p>${escapeHtml(message.body).replace(/\n/g, '<br>')}</p>
    </article>`);
    previous = message;
  }
  pane.innerHTML = rows.join('') || '<div class="chat-history-empty">No recent messages in this conversation.</div>';
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
  if (state.chat.loading) return;
  const generation = state.chat.generation;
  state.chat.loading = true;
  try {
    const result = unwrap(await api.chat.friends());
    if (state.chat.generation !== generation) return;
    state.chat.identity = result.identity;
    state.chat.friends = result.friends || [];
    applyChatInboxSnapshot(result);
    const friendIds = new Set(state.chat.friends.map((friend) => friend.id));
    for (const conversationId of state.chat.unreadByConversation.keys()) {
      if (!friendIds.has(conversationId)) state.chat.unreadByConversation.delete(conversationId);
    }
    updateChatUnreadBadges();
    $('#chat-identity').textContent = result.identity && result.identity.riotId ? `Active · ${displayRiotId(result.identity.riotId)}` : 'Current Riot account';
    if (state.chat.selectedId && !friendIds.has(state.chat.selectedId)) {
      state.chat.selectedId = null;
      state.chat.messages = [];
      $('#chat-workspace').hidden = true;
      $('#chat-empty').hidden = false;
      renderChatHeader(null);
    }
    renderChatFriends();
    if (state.chat.selectedId) {
      renderChatHeader(state.chat.friends.find((friend) => friend.id === state.chat.selectedId));
      if (state.activeView === 'chat') await loadChatHistory(false);
    }
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
$$('[data-chat-filter]').forEach((button) => button.addEventListener('click', () => {
  state.chat.filter = button.dataset.chatFilter;
  $$('[data-chat-filter]').forEach((item) => item.classList.toggle('is-active', item === button));
  renderChatFriends();
}));
$('#chat-sort').addEventListener('change', (event) => { state.chat.sort = event.target.value; renderChatFriends(); });
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
    state.chat.drafts.delete(state.chat.selectedId);
    resizeChatComposer();
    renderChatFriends();
    await loadChatHistory(true);
  } catch (error) { toast(error.message, 'bad'); }
  finally { button.disabled = false; }
});
$('#chat-message').addEventListener('input', () => { saveChatDraft(); resizeChatComposer(); renderChatFriends(); });
$('#chat-message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#chat-composer').requestSubmit();
  }
});
resizeChatComposer();

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
  try {
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
  } catch (error) {
    lockOverlay.hidden = false;
    $('#lock-title').textContent = 'Riot Relay could not start';
    $('#lock-sub').textContent = 'The secure vault could not be initialized. Restart Riot Relay and try again.';
    $('#lock-error').textContent = error.message || 'Startup failed.';
    $('#lock-error').hidden = false;
    $('#lock-submit').disabled = true;
    $('#lock-parked').hidden = true;
  } finally {
    requestAnimationFrame(() => dismissBootScreen());
  }
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

const FEATURE_TUTORIAL_VERSION = 3;
const FEATURE_TOUR_STEPS = [
  {
    view: 'accounts', target: '.railbtn[data-view="accounts"]',
    eyebrow: '1 · Accounts', title: 'Keep every Riot identity separate',
    body: 'Use Accounts to add credentials, sync the active Riot session, inspect all three ranked profiles, and choose switch-only or an explicit switch-and-launch action.',
    callout: 'PUUID verification remains authoritative before private data is attached.',
  },
  {
    view: 'inventory', target: '.railbtn[data-view="inventory"]',
    eyebrow: '2 · Inventory', title: 'Browse, value, and export collections',
    body: 'Open Inventory to load supported VALORANT, League, and TFT collections, filter items, review real available prices, and create data or image exports.',
  },
  {
    view: 'chat', target: '#rail-chat',
    eyebrow: '3 · Chat', title: 'Chat follows only the active session',
    body: 'The Chat workspace shows friends, activity, unread messages, drafts, and history for the currently authenticated Riot account. Inactive roster accounts are never mixed in.',
  },
  {
    view: 'settings', settingGroup: 'configs', target: '.settingnav[data-group="configs"]',
    eyebrow: '4 · Config migration', title: 'Move settings through a guided route',
    body: 'Capture a verified source, capture a different target baseline, then review and enable the persistent source-to-target binding before an explicit game launch.',
    callout: 'Credentials, sessions, logs, and arbitrary folders are never copied.',
  },
  {
    view: 'settings', settingGroup: 'privacy', target: '.settingnav[data-group="privacy"]',
    eyebrow: '5 · Privacy', title: 'Control what the interface reveals',
    body: 'Login usernames and Riot display names can be masked independently without changing stored identity links, PUUID checks, or switch verification.',
  },
  {
    view: 'settings', settingGroup: 'deceive', target: '#deceive-status', fallback: '.settingnav[data-group="deceive"]',
    eyebrow: '6 · Deceive', title: 'Choose how friends see your presence',
    body: 'Select Offline, Mobile, Away, or Online and decide whether game activity and parties are preserved. The helper contact is League-only; VALORANT uses these in-app controls.',
    callout: 'Enable Deceive before the next Riot launch so the local proxy starts with the client.',
  },
];
const featureTour = { step: 0, target: null, previousFocus: null };
function setTourRect(element, left, top, width, height) {
  Object.assign(element.style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(0, width)}px`, height: `${Math.max(0, height)}px` });
}
function positionFeatureTour() {
  const tour = $('#feature-tour');
  const target = featureTour.target;
  if (tour.hidden || !target) return;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const raw = target.getBoundingClientRect();
  const padding = 6;
  const left = Math.max(0, raw.left - padding);
  const top = Math.max(0, raw.top - padding);
  const right = Math.min(viewportWidth, raw.right + padding);
  const bottom = Math.min(viewportHeight, raw.bottom + padding);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  setTourRect($('[data-tour-scrim="top"]'), 0, 0, viewportWidth, top);
  setTourRect($('[data-tour-scrim="left"]'), 0, top, left, height);
  setTourRect($('[data-tour-scrim="right"]'), right, top, viewportWidth - right, height);
  setTourRect($('[data-tour-scrim="bottom"]'), 0, bottom, viewportWidth, viewportHeight - bottom);
  setTourRect($('#tour-spotlight'), left, top, width, height);

  const card = $('#tour-card');
  const cardRect = card.getBoundingClientRect();
  const margin = 12;
  const gap = 16;
  let cardLeft;
  let cardTop;
  if (viewportWidth <= 760) {
    cardLeft = margin;
    cardTop = viewportHeight - cardRect.height - margin;
  } else if (right + gap + cardRect.width <= viewportWidth - margin) {
    cardLeft = right + gap;
    cardTop = top;
  } else if (left - gap - cardRect.width >= margin) {
    cardLeft = left - gap - cardRect.width;
    cardTop = top;
  } else if (bottom + gap + cardRect.height <= viewportHeight - margin) {
    cardLeft = Math.min(left, viewportWidth - cardRect.width - margin);
    cardTop = bottom + gap;
  } else {
    cardLeft = Math.min(left, viewportWidth - cardRect.width - margin);
    cardTop = top - gap - cardRect.height;
  }
  card.style.left = `${Math.max(margin, Math.min(cardLeft, viewportWidth - cardRect.width - margin))}px`;
  card.style.top = `${Math.max(margin, Math.min(cardTop, viewportHeight - cardRect.height - margin))}px`;
}
function setTourAppInert(inert) {
  ['.titlebar', '.body', '.statusbar'].forEach((selector) => {
    const element = $(selector);
    if (element) element.inert = inert;
  });
}
async function showTourStep(step) {
  featureTour.step = Math.max(0, Math.min(FEATURE_TOUR_STEPS.length - 1, step));
  const current = FEATURE_TOUR_STEPS[featureTour.step];
  showView(current.view);
  if (current.settingGroup) showSettingGroup(current.settingGroup);
  await nextPaint();
  let target = $(current.target);
  if (!target || target.hidden || !target.getClientRects().length) target = $(current.fallback || `.railbtn[data-view="${current.view}"]`);
  if (!target) return;
  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  await nextPaint();
  featureTour.target = target;
  $('#tour-eyebrow').textContent = current.eyebrow;
  $('#tour-title').textContent = current.title;
  $('#tour-body').textContent = current.body;
  const callout = $('#tour-callout');
  callout.textContent = current.callout || '';
  callout.hidden = !current.callout;
  $('#tour-counter').textContent = `${featureTour.step + 1} / ${FEATURE_TOUR_STEPS.length}`;
  $$('#tour-dots .onboard__dot').forEach((dot, index) => {
    const active = index === featureTour.step;
    dot.classList.toggle('is-active', active);
    if (active) dot.setAttribute('aria-current', 'step'); else dot.removeAttribute('aria-current');
  });
  $('#tour-back').disabled = featureTour.step === 0;
  $('#tour-next').hidden = featureTour.step === FEATURE_TOUR_STEPS.length - 1;
  $('#tour-finish').hidden = featureTour.step !== FEATURE_TOUR_STEPS.length - 1;
  positionFeatureTour();
  $('#tour-title').focus({ preventScroll: true });
}
async function startFeatureTour() {
  const tour = $('#feature-tour');
  if (!tour.hidden) return;
  featureTour.previousFocus = document.activeElement;
  $('#tour-dots').innerHTML = FEATURE_TOUR_STEPS.map((item, index) => `<button class="onboard__dot" type="button" data-tour-go="${index}" aria-label="Go to step ${index + 1}: ${escapeHtml(item.title)}"></button>`).join('');
  tour.hidden = false;
  setTourAppInert(true);
  await showTourStep(0);
}
async function closeFeatureTour() {
  const tour = $('#feature-tour');
  if (tour.hidden) return;
  tour.hidden = true;
  featureTour.target = null;
  setTourAppInert(false);
  if (featureTour.previousFocus && featureTour.previousFocus.isConnected) featureTour.previousFocus.focus();
  try {
    await setSetting({ featureTutorialVersion: FEATURE_TUTORIAL_VERSION });
  } catch { /* tutorial completion is non-critical */ }
}
$('#tour-dots').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tour-go]');
  if (button) showTourStep(Number(button.dataset.tourGo));
});
$('#tour-back').addEventListener('click', () => showTourStep(featureTour.step - 1));
$('#tour-next').addEventListener('click', () => showTourStep(featureTour.step + 1));
$('#tour-finish').addEventListener('click', closeFeatureTour);
$('#tour-skip').addEventListener('click', closeFeatureTour);
window.addEventListener('resize', positionFeatureTour);
document.addEventListener('scroll', positionFeatureTour, true);
document.addEventListener('keydown', (event) => {
  const tour = $('#feature-tour');
  if (tour.hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closeFeatureTour(); return; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); showTourStep(featureTour.step - 1); return; }
  if (event.key === 'ArrowRight') { event.preventDefault(); showTourStep(featureTour.step + 1); return; }
  if (event.key !== 'Tab') return;
  const focusable = $$('button:not([hidden]):not(:disabled), [tabindex="0"]', $('#tour-card'));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

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
  state.accounts = []; state.rosterSections = []; state.selectedAccountId = null;
  clearChatState();
  renderAccounts(); renderDetail();
  await bootVault();
});
async function afterUnlock() {
  showBootScreen('Loading settings…');
  try {
    await loadSettings();
    $('#boot-status').textContent = 'Loading game workspaces…';
    await loadGames();
    $('#boot-status').textContent = 'Loading encrypted account roster…';
    await refreshAccounts();
    renderAccounts(); renderDetail();
    $('#boot-status').textContent = 'Preparing Riot Relay…';
  } finally {
    await finishBootScreen();
  }
  startChatPolling();
  checkClientStatus();
  loadRankIcons().then(() => { renderAccounts(); renderDetail(); });
  if (Number(state.settings.featureTutorialVersion || 0) < FEATURE_TUTORIAL_VERSION) {
    setTimeout(startFeatureTour, 240);
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
function hasRankedValorantEvidence(rank) {
  if (!rank || typeof rank !== 'object') return false;
  const tier = Number(rank.tier);
  const name = String(rank.tierName || rank.name || '').trim();
  return (Number.isInteger(tier) && tier > 0) || (!!name && !/^unranked$/i.test(name));
}
function statsFor(account) {
  const isCurrent = state.currentSession && (state.currentSession.matchingAccountIds || []).includes(account.id);
  if (isCurrent && state.stats) {
    const current = state.stats;
    const liveRank = current.valorant && current.valorant.rank;
    const storedRank = account.stats && account.stats.valorant && account.stats.valorant.rank;
    const liveIsAuthoritativeUnranked = liveRank && liveRank.authoritativeUnranked === true;
    if ((!liveRank || (!hasRankedValorantEvidence(liveRank) && !liveIsAuthoritativeUnranked)) && hasRankedValorantEvidence(storedRank)) {
      return {
        ...current,
        valorant: {
          ...(current.valorant || {}),
          available: true,
          rank: {
            ...storedRank,
            stale: true,
            staleReason: 'Live VALORANT rank was unavailable; showing the last verified rank.',
            authoritative: false,
            authoritativeUnranked: false,
          },
        },
      };
    }
    return current;
  }
  return account.stats || {
    valorant: { available: !!account.rankName, rank: { tier: account.rankTier, tierName: account.rankName, rr: account.rr }, level: account.level },
    league: { available: false, queues: [], error: 'Sync while League is open.' },
    tft: { available: false, queues: [], error: 'Sync while League is open.' },
  };
}
function queueName(queue) {
  return ({ RANKED_SOLO_5x5: 'Solo / Duo', RANKED_FLEX_SR: 'Ranked Flex', RANKED_TFT: 'Ranked', RANKED_TFT_DOUBLE_UP: 'Double Up' })[queue] || queue || 'Ranked';
}
const LEAGUE_RANK_COLORS = {
  IRON: '#7d706b', BRONZE: '#a96f4b', SILVER: '#8796a5', GOLD: '#c69a43', PLATINUM: '#4aa99b',
  EMERALD: '#3fbb78', DIAMOND: '#6b82d8', MASTER: '#9a62c7', GRANDMASTER: '#d4545b', CHALLENGER: '#d1ad5c',
  UNRANKED: '#555762',
};
const LEAGUE_EMBLEM_TIERS = new Set(['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'grandmaster', 'challenger']);
const COMMUNITYDRAGON_RANK_BASE = 'https://raw.communitydragon.org/16.14/plugins/rcp-fe-lol-static-assets/global/default';
const LEAGUE_EMBLEM_BASE = `${COMMUNITYDRAGON_RANK_BASE}/ranked-emblem`;
const LEAGUE_EMERALD_ASSET = '/renderer/emerald-rank.png';
function gameMark(game) {
  const paths = {
    valorant: '<path d="M3 4l10.2 18h5.1l-4.6-7.9L8.4 6.8 3 4Zm26 0L18.7 22h5.2l5.1-8.2V4Z"/>',
    league: '<circle cx="16" cy="16" r="12"/><path d="M12 8v15h10l2-4h-7V8h-5Z"/>',
    tft: '<path d="M4 8l5 4 7-7 7 7 5-4-3 14H7L4 8Zm5 17h14v3H9v-3Z"/>',
  };
  return `<span class="game-mark game-mark--${game}" aria-hidden="true"><svg viewBox="0 0 32 32">${paths[game] || ''}</svg></span>`;
}
function rankEmblem(tier, game, className = 'rank-emblem') {
  const normalized = String(tier || 'UNRANKED').trim().toUpperCase();
  const assetTier = normalized.toLowerCase();
  const supported = LEAGUE_EMBLEM_TIERS.has(assetTier);
  const fallback = normalized === 'UNRANKED' ? '—' : normalized.slice(0, 2);
  const source = assetTier === 'emerald' ? LEAGUE_EMERALD_ASSET : `${LEAGUE_EMBLEM_BASE}/emblem-${assetTier}.png`;
  return `<span class="${className} ${className}--${game}" style="--rank-accent:${LEAGUE_RANK_COLORS[normalized] || LEAGUE_RANK_COLORS.UNRANKED}" aria-hidden="true">
    <span class="rank-emblem__fallback">${escapeHtml(fallback)}</span>
    ${supported ? `<img data-rank-asset src="${source}" alt="" loading="lazy" decoding="async" />` : ''}
  </span>`;
}
function bindRankAssets(root = document) {
  $$('[data-rank-asset]', root).forEach((image) => {
    const hide = () => { image.hidden = true; };
    image.addEventListener('error', hide, { once: true });
    if (image.complete && !image.naturalWidth) hide();
  });
}
function gameErrorMessage(game) {
  const message = String(game && game.error || 'Unavailable').trim();
  return /^(?:ReferenceError:\s*)?path is not defined$/i.test(message)
    ? 'Previous sync failed before data could be read. Sync again to retry.'
    : message;
}
function rankMetrics(row) {
  const wins = row.wins == null ? null : Number(row.wins);
  const losses = row.losses == null ? null : Number(row.losses);
  const recordedGames = row.games == null ? null : Number(row.games);
  const games = Number.isFinite(wins) && Number.isFinite(losses)
    ? wins + losses
    : Number.isFinite(recordedGames) && recordedGames >= 0 ? recordedGames : 0;
  const winRate = games > 0 && Number.isFinite(wins) ? Math.round((wins / games) * 100) : null;
  return [
    row.lp != null ? `<b>${fmt(row.lp)} LP</b>` : row.rr != null ? `<b>${fmt(row.rr)} RR</b>` : null,
    wins != null ? `<span><i>W</i>${fmt(wins)}</span>` : null,
    losses != null ? `<span><i>L</i>${fmt(losses)}</span>` : null,
    games ? `<span><i>G</i>${fmt(games)}</span>` : null,
    winRate != null ? `<span><i>WR</i>${winRate}%</span>` : null,
  ].filter(Boolean).join('');
}
function rankedRows(game, gameId) {
  if (!game || !game.available) return `<div class="game-stat__empty">${escapeHtml(gameErrorMessage(game))}</div>`;
  const queuePriority = ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR', 'RANKED_TFT', 'RANKED_TFT_DOUBLE_UP'];
  const queues = Array.isArray(game.queues)
    ? game.queues.filter((queue) => queue && String(queue.tier || queue.tierName || '').trim())
      .sort((left, right) => queuePriority.indexOf(left.queue) - queuePriority.indexOf(right.queue))
    : [];
  if (!queues.length) return '<div class="game-stat__empty">No ranked placements found for the current season.</div>';
  return `<div class="rank-cards rank-cards--${gameId}">${queues.map((q, index) => {
    const tier = String(q.tier || 'UNRANKED').toUpperCase();
    const unranked = tier === 'UNRANKED';
    const division = unranked ? '' : String(q.division || '').toUpperCase();
    const metrics = rankMetrics(q);
    const hierarchy = gameId === 'league' ? (index === 0 ? ' rank-card--primary' : ' rank-card--secondary') : '';
    return `<article class="rank-card${hierarchy}" style="--rank-accent:${LEAGUE_RANK_COLORS[tier] || LEAGUE_RANK_COLORS.UNRANKED}">
      ${rankEmblem(tier, gameId, 'rank-card__emblem')}
      <div class="rank-card__body">
        <span class="rank-card__queue">${escapeHtml(queueName(q.queue))}</span>
        <strong>${escapeHtml(unranked ? 'Unranked' : `${tier} ${division}`.trim())}</strong>
        <div class="rank-card__metrics">${metrics || '<em>No ranked record</em>'}</div>
      </div>
    </article>`;
  }).join('')}</div>`;
}
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function trustedRankSeason(value) {
  const season = String(value || '').trim();
  // A bare UUID (Riot's raw internal season/act key) is never a presentable
  // label on its own; it must have been translated to a human name upstream.
  if (UUID_SHAPE.test(season)) return false;
  return /^(?=.{1,64}$)(?=.*\d)[a-z0-9][a-z0-9 ._-]*$/i.test(season);
}
function seasonLabel(value, index, gameId) {
  const season = String(value || '').trim();
  if (/^s?20\d{2}$/i.test(season)) return season.toUpperCase().replace(/^S?/, 'S');
  const yearSplit = season.match(/^s?(20\d{2})[-_. ](?:split|season)[-_. ]?(\d{1,2})$/i);
  if (yearSplit) return `S${yearSplit[1]} Split ${yearSplit[2]}`;
  const recognized = season.match(/^(season|set|act)[\s._-]*([a-z0-9][a-z0-9 ._-]{0,59})$/i);
  if (recognized) return `${recognized[1].charAt(0).toUpperCase()}${recognized[1].slice(1).toLowerCase()} ${recognized[2].replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()}`;
  if (trustedRankSeason(season)) return season.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return gameId === 'valorant' ? `Previous act ${index + 1}` : 'Past rank';
}
function rankHistory(history, gameId) {
  const source = Array.isArray(history) ? history : [];
  // Old provider fragments without a recognizable season identity were once
  // persisted as numbered League/TFT history. Filter them at render time too,
  // so false seasons disappear immediately without requiring another sync.
  // VALORANT rows must have an already-resolved human act `label`; a bare
  // UUID seasonId is never shown directly (see seasonLabel/UUID_SHAPE).
  const verifiedSource = gameId === 'valorant'
    ? source.filter((row) => row && row.label && !UUID_SHAPE.test(String(row.label).trim()))
    : source.filter((row) => row && trustedRankSeason(row.label || row.seasonId));
  const rows = (gameId === 'valorant' ? [...verifiedSource].reverse() : [...verifiedSource]).slice(0, 8);
  const verifiedCopy = gameId === 'valorant' ? '' : 'verified ';
  if (!rows.length) return `<div class="rank-history rank-history--empty"><span>Past ranks</span><small>No ${verifiedCopy}historical rank data returned by this source.</small></div>`;
  return `<details class="rank-history">
    <summary><span>Past ranks</span><small>${rows.length} ${verifiedCopy}record${rows.length === 1 ? '' : 's'}</small></summary>
    <div class="rank-history__rows">${rows.map((row, index) => {
      const tierName = String(row.tierName || row.tier || 'UNRANKED').toUpperCase();
      const division = tierName === 'UNRANKED' ? '' : String(row.division || '').toUpperCase();
      return `<div class="rank-history__row">
        ${gameId === 'valorant'
    ? rankIcon(row.tier || 0, 'rank-history__icon')
    : rankEmblem(tierName, gameId, 'rank-history__icon')}
        <div><span>${escapeHtml(seasonLabel(row.label || row.seasonId, index, gameId))}${row.queue ? ` · ${escapeHtml(queueName(row.queue))}` : ''}</span><strong>${escapeHtml(tierName === 'UNRANKED' ? 'Unranked' : `${tierName} ${division}`.trim())}</strong></div>
        <div class="rank-history__metrics">${rankMetrics(row) || (row.games != null ? `${fmt(row.games)} games` : '')}</div>
      </div>`;
    }).join('')}</div>
  </details>`;
}
function providerLabel(game) {
  if (game && game.refreshNeeded) return 'REFRESH NEEDED';
  if (!game || !game.available) return 'UNAVAILABLE';
  if (game.source === 'opgg') return 'OP.GG';
  if (game.source === 'lcu+opgg') return 'LCU + OP.GG';
  return 'LCU';
}
function gameStatHeader(gameId, title, subtitle, source) {
  return `<header class="game-stat__head"><div class="game-stat__identity">${gameMark(gameId)}<div><span>${title}</span><small>${subtitle}</small></div></div><i class="game-stat__source">${escapeHtml(source)}</i></header>`;
}
function renderGameStats(account) {
  const stats = statsFor(account);
  const val = stats.valorant || {};
  const rank = val.rank || {};
  const leagueStats = stats.league || {};
  const leagueSource = providerLabel(leagueStats);
  const leagueStatus = leagueStats.platformId ? `${leagueSource} · ${leagueStats.platformId}` : leagueSource;
  const tftStats = stats.tft || {};
  const tftSource = providerLabel(tftStats);
  const tftStatus = tftStats.platformId ? `${tftSource} · ${tftStats.platformId}` : tftSource;
  const rr = Math.max(0, Math.min(100, Number(rank.rr) || 0));
  const peak = rank.peakTierName && rank.peakTierName !== 'Unranked' ? rank.peakTierName : 'No peak recorded';
  const valorantSource = rank.stale ? 'LAST VERIFIED' : val.available ? 'RIOT LIVE' : 'UNAVAILABLE';
  const valorantRank = rank.tierName
    ? `<div class="val-rank">
        ${rankIcon(rank.tier || 0, 'game-stat__rank')}
        <div class="val-rank__body"><strong>${escapeHtml(rank.tierName)}</strong><span>${rank.rr != null ? `${fmt(rank.rr)} RR` : 'No RR returned'}${rank.stale ? ' · stale' : ''}</span><div class="val-rank__progress"><i style="width:${rr}%"></i></div></div>
      </div>`
    : `<div class="game-stat__empty">${escapeHtml(gameErrorMessage(val))}</div>`;
  return `<div class="stats-grid">
    <section class="game-stat game-stat--valorant">
      ${gameStatHeader('valorant', 'VALORANT', 'Competitive', valorantSource)}
      ${valorantRank}
      <div class="game-stat__facts"><span><i>LEVEL</i>${fmt(val.level)}</span><span><i>PEAK</i>${escapeHtml(peak)}</span></div>
      ${rankHistory(rank.pastSeasons, 'valorant')}
    </section>
    <section class="game-stat game-stat--league">
      ${gameStatHeader('league', 'LEAGUE OF LEGENDS', 'Summoner’s Rift', leagueStatus)}
      ${rankedRows(leagueStats, 'league')}
      ${rankHistory(leagueStats.pastSeasons, 'league')}
    </section>
    <section class="game-stat game-stat--tft">
      ${gameStatHeader('tft', 'TEAMFIGHT TACTICS', 'Convergence', tftStatus)}
      ${rankedRows(tftStats, 'tft')}
      ${rankHistory(tftStats.pastSeasons, 'tft')}
    </section>
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
  try {
    const roster = unwrap(await api.roster.get());
    state.accounts = Array.isArray(roster.accounts) ? roster.accounts : [];
    state.rosterSections = Array.isArray(roster.sections) ? roster.sections : [];
  } catch {
    state.accounts = [];
    state.rosterSections = [];
  }
  await refreshConfigProfiles();
}
const ROSTER_RANK_SCORES = {
  league: { IRON: 100, BRONZE: 200, SILVER: 300, GOLD: 400, PLATINUM: 500, EMERALD: 600, DIAMOND: 700, MASTER: 800, GRANDMASTER: 950, CHALLENGER: 1000 },
  valorant: { IRON: 100, BRONZE: 200, SILVER: 300, GOLD: 400, PLATINUM: 500, DIAMOND: 650, ASCENDANT: 725, IMMORTAL: 825, RADIANT: 925 },
};
const VALORANT_RANK_COLORS = {
  IRON: '#7f7774', BRONZE: '#a86e4b', SILVER: '#9aa8b7', GOLD: '#d4ac56', PLATINUM: '#57c4bd',
  DIAMOND: '#9c76d8', ASCENDANT: '#4db06d', IMMORTAL: '#d35b70', RADIANT: '#e6c36d',
};
function normalizedRosterTier(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+[123]$/, '');
}
function bestQueueRank(game, gameId) {
  const candidates = [];
  for (const queue of Array.isArray(game && game.queues) ? game.queues : []) {
    const tierName = normalizedRosterTier(queue && (queue.tier || queue.tierName));
    if (!queue || !ROSTER_RANK_SCORES.league[tierName]) continue;
    const division = String(queue.division || '').toUpperCase();
    const divisionScore = { IV: 1, III: 2, II: 3, I: 4 }[division] || 0;
    candidates.push({
      game: gameId,
      score: ROSTER_RANK_SCORES.league[tierName] * 10000 + divisionScore * 100 + (Number(queue.lp) || 0),
      tierName,
      division,
      queue: queue.queue,
      accent: LEAGUE_RANK_COLORS[tierName] || LEAGUE_RANK_COLORS.UNRANKED,
      label: `${tierName} ${division}${queue.lp != null ? ` · ${fmt(queue.lp)} LP` : ''}`.replace(/\s+/g, ' ').trim(),
    });
  }
  return candidates.sort((left, right) => right.score - left.score)[0] || null;
}
function bestRosterRank(account) {
  const stats = statsFor(account);
  const valorant = stats.valorant && stats.valorant.rank;
  const valorantTier = normalizedRosterTier(valorant && (valorant.tierName || valorant.name));
  if (valorant && ROSTER_RANK_SCORES.valorant[valorantTier] && hasRankedValorantEvidence(valorant)) {
    return {
      game: 'valorant',
      tier: valorant.tier,
      tierName: String(valorant.tierName || valorant.name),
      accent: VALORANT_RANK_COLORS[valorantTier] || '#a7a7b2',
      label: `${valorant.tierName || valorant.name}${valorant.rr != null ? ` · ${fmt(valorant.rr)} RR` : ''}`,
    };
  }
  // Product priority is deliberate: any current League rank wins over TFT,
  // regardless of tier. TFT is used only when the other two have no rank.
  return bestQueueRank(stats.league, 'league') || bestQueueRank(stats.tft, 'tft');
}
function rosterGameLabel(game) {
  return game === 'valorant' ? 'VALORANT' : game === 'league' ? 'League of Legends' : 'Teamfight Tactics';
}
function rosterArtworkTier(rank) {
  const tier = normalizedRosterTier(rank && rank.tierName).toLowerCase();
  const mapped = { ascendant: 'emerald', immortal: 'grandmaster', radiant: 'challenger' }[tier] || tier;
  return LEAGUE_EMBLEM_TIERS.has(mapped) ? mapped : null;
}
function rosterRankFrame(rank) {
  const tier = rosterArtworkTier(rank);
  if (!tier) return '';
  const crestSource = tier === 'emerald' ? LEAGUE_EMERALD_ASSET : `${LEAGUE_EMBLEM_BASE}/emblem-${tier}.png`;
  // The plain classic per-tier crest only. Layered wing-plate splash art and
  // border-accent overlays were removed: at roster-row size they rendered as
  // oversized, distorted artwork rather than a clean badge.
  return `<span class="arow__rank-frame" aria-hidden="true">
    <img class="arow__rank-crest" data-rank-asset src="${crestSource}" alt="" loading="lazy" decoding="async" />
  </span>`;
}
function accountRow(a, signedIn = false) {
  const bestRank = bestRosterRank(a);
  const sub = bestRank ? bestRank.label
    : (a.riotId ? displayRiotId(a.riotId) : a.username ? displayLogin(a.username) : 'Not synced');
  const active = a.id === state.selectedAccountId ? ' is-active' : '';
  const favorite = a.favorite ? ' is-favorite' : '';
  const current = signedIn ? ' is-signed-in' : '';
  const border = bestRank && state.settings.showRosterRankBorders === true ? ' has-rank-border' : '';
  const rankArtwork = bestRank
    ? (bestRank.game === 'valorant'
      ? rankIcon(bestRank.tier, 'arow__rank')
      : rankEmblem(bestRank.tierName, bestRank.game, 'arow__rank'))
    : '';
  const rankStyle = border ? ` style="--roster-rank-accent:${escapeHtml(bestRank.accent)}"` : '';
  const accessible = `${a.label || a.username || 'Account'}${bestRank ? `, ${rosterGameLabel(bestRank.game)} ${bestRank.label}` : ''}. Drag to move between roster sections.`;
  return `
    <div class="arow${active}${favorite}${current}${border}" data-select="${a.id}" data-account-drag="${a.id}" draggable="true" role="group" tabindex="0" title="${escapeHtml(accessible)}" aria-label="${escapeHtml(accessible)}"${rankStyle}>
      ${border ? rosterRankFrame(bestRank) : ''}
      ${portraitMarkup(a, 'arow__av')}
      <div class="arow__meta">
        <div class="arow__label"><span>${escapeHtml(a.label || 'Unnamed')}</span>${signedIn ? '<span class="arow__live" title="Currently signed in" aria-label="Currently signed in">SIGNED IN</span>' : ''}${a.hasSession ? `<span class="arow__bolt" title="Identity-verified saved session">${ic('zap', 11)}</span>` : ''}</div>
        <div class="arow__sub">${escapeHtml(sub)}</div>
      </div>
      <button class="arow__favorite${a.favorite ? ' is-active' : ''}" data-row-fav="${a.id}" title="${a.favorite ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${a.favorite ? 'Remove from favorites' : 'Add to favorites'}">${ic('star', 14, { fill: !!a.favorite })}</button>
      <div class="arow__rankslot" title="${bestRank ? escapeHtml(`${rosterGameLabel(bestRank.game)} · ${bestRank.label}`) : ''}">${rankArtwork}</div>
    </div>`;
}
function applyRosterState(snapshot) {
  state.accounts = Array.isArray(snapshot && snapshot.accounts) ? snapshot.accounts : [];
  state.rosterSections = Array.isArray(snapshot && snapshot.sections) ? snapshot.sections : [];
  const selected = state.accounts.find((account) => account.id === state.selectedAccountId);
  const hiddenSections = new Set(state.rosterSections.filter((section) => section.rosterHidden).map((section) => section.id));
  if (selected && (selected.rosterHidden || hiddenSections.has(selected.sectionId))) state.selectedAccountId = null;
}
async function changeRoster(request, success) {
  try {
    applyRosterState(unwrap(await request));
    renderAccounts();
    renderDetail();
    if (success) toast(success, 'good');
  } catch (error) { toast(error.message, 'bad'); }
}
function sortedRosterAccounts(accounts, currentIds = null) {
  return [...accounts].sort((a, b) => {
    if (currentIds) {
      const currentDiff = Number(currentIds.has(b.id)) - Number(currentIds.has(a.id));
      if (currentDiff) return currentDiff;
    }
    return Number(a.rosterOrder) - Number(b.rosterOrder)
      || String(a.label || a.username || '').localeCompare(String(b.label || b.username || ''))
      || String(a.id || '').localeCompare(String(b.id || ''));
  });
}
function clearRosterDropIndicators(root) {
  $$('.is-drag-over, .is-drop-before, .is-drop-after', root).forEach((element) => {
    element.classList.remove('is-drag-over', 'is-drop-before', 'is-drop-after');
  });
}
function accountDropPlacement(container, accountId, clientY) {
  const sectionId = container.dataset.accountDrop || null;
  const visibleRows = $$('[data-account-drag]', container)
    .filter((row) => row.dataset.accountDrag !== accountId);
  const beforeRow = visibleRows.find((row) => {
    const bounds = row.getBoundingClientRect();
    return clientY < bounds.top + bounds.height / 2;
  });
  const anchor = beforeRow || visibleRows[visibleRows.length - 1] || null;
  const bucket = sortedRosterAccounts(state.accounts.filter((account) => {
    const accountSectionId = account.sectionId || null;
    return account.id !== accountId && accountSectionId === sectionId;
  }));
  let targetIndex = bucket.length;
  if (anchor) {
    const anchorIndex = bucket.findIndex((account) => account.id === anchor.dataset.accountDrag);
    if (anchorIndex >= 0) targetIndex = beforeRow ? anchorIndex : anchorIndex + 1;
  }
  return { anchor, before: !!beforeRow, targetIndex };
}
function rosterSectionMarkup(section, accounts, currentIds) {
  const persisted = !!section;
  const name = persisted ? section.name : 'No section';
  const dragHandle = persisted
    ? `<button type="button" class="roster-section__drag" data-section-drag="${section.id}" draggable="true" title="Drag to reorder ${escapeHtml(name)}" aria-label="Drag to reorder section ${escapeHtml(name)}"><span aria-hidden="true">⠿</span></button>`
    : '';
  const actions = persisted ? `<div class="roster-section__actions">
    <button type="button" data-section-rename="${section.id}" title="Rename section">${ic('pencil', 11)}</button>
    <button type="button" data-section-hide="${section.id}" title="Hide section">${ic('eye-off', 11)}</button>
    <button type="button" data-section-remove="${section.id}" title="Delete section">${ic('trash-2', 11)}</button>
  </div>` : '';
  return `<section class="roster-section" data-roster-section="${persisted ? section.id : ''}">
    <header class="roster-section__head" data-section-drop="${persisted ? section.id : ''}">${dragHandle}<strong>${escapeHtml(name)}</strong><span>${accounts.length}</span>${actions}</header>
    <div class="roster-section__accounts" data-account-drop="${persisted ? section.id : ''}" title="Drop an account into ${escapeHtml(name)}" aria-label="${escapeHtml(name)} account drop target">${accounts.map((account) => accountRow(account, currentIds.has(account.id))).join('')}</div>
  </section>`;
}
function renderHiddenRoster() {
  const hiddenSections = state.rosterSections.filter((section) => section.rosterHidden);
  const hiddenAccounts = state.accounts.filter((account) => account.rosterHidden);
  const total = hiddenSections.length + hiddenAccounts.length;
  const trigger = $('#btn-hidden-roster');
  const panel = $('#roster-hidden');
  trigger.hidden = total === 0;
  $('#hidden-roster-count').textContent = String(total);
  if (!total) {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
  $('#roster-hidden-list').innerHTML = [
    ...hiddenSections.map((section) => `<div class="roster-hidden__item"><span>${ic('eye-off', 11)} Section · ${escapeHtml(section.name)}</span><button type="button" data-show-section="${section.id}">Show</button></div>`),
    ...hiddenAccounts.map((account) => `<div class="roster-hidden__item"><span>${ic('eye-off', 11)} ${escapeHtml(account.label || account.username || 'Account')}</span><button type="button" data-show-account="${account.id}">Show</button></div>`),
  ].join('');
  $$('[data-show-section]', panel).forEach((button) => button.addEventListener('click', () => changeRoster(api.roster.setSectionHidden(button.dataset.showSection, false), 'Section restored.')));
  $$('[data-show-account]', panel).forEach((button) => button.addEventListener('click', () => changeRoster(api.roster.setAccountHidden(button.dataset.showAccount, false), 'Account restored.')));
}
function renderAccounts() {
  renderConfigAccounts();
  renderHiddenRoster();
  const list = $('#account-list');
  const q = state.inv.accSearch;
  const currentIds = new Set(state.currentSession?.matchingAccountIds || []);
  const visibleSectionIds = new Set(state.rosterSections.filter((section) => !section.rosterHidden).map((section) => section.id));
  const filtered = state.accounts.filter((a) => !a.rosterHidden && (!a.sectionId || visibleSectionIds.has(a.sectionId)))
    .filter((a) => !q || [a.label,
      state.settings.hideLoginNames ? '' : a.username,
      state.settings.hideDisplayNames ? '' : a.riotId,
      a.leaguePlatformId].some((v) => String(v || '').toLowerCase().includes(q)));
  const groups = state.rosterSections.filter((section) => !section.rosterHidden)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    .map((section) => ({ section, accounts: sortedRosterAccounts(filtered.filter((account) => account.sectionId === section.id), currentIds) }));
  const unsectioned = sortedRosterAccounts(filtered.filter((account) => !account.sectionId), currentIds);
  const renderedGroups = groups.filter((group) => group.accounts.length || !q);
  if (!q || unsectioned.length) renderedGroups.push({ section: null, accounts: unsectioned });
  const visibleCount = renderedGroups.reduce((sum, group) => sum + group.accounts.length, 0);
  list.innerHTML = renderedGroups.length && (visibleCount || !q)
    ? renderedGroups.map((group) => rosterSectionMarkup(group.section, group.accounts, currentIds)).join('')
    : `<p class="muted roster-empty">${q ? 'No visible matches.' : 'All accounts are hidden.'}</p>`;
  let entranceIndex = 0;
  $$('[data-select]', list).forEach((el) => {
    const id = el.dataset.select;
    const isNew = !state.motion.seenAccountIds.has(id);
    state.motion.seenAccountIds.add(id);
    if (isNew && entranceIndex < 10 && !reducedMotion.matches) {
      el.classList.add('enter-item');
      el.style.setProperty('--enter-index', String(entranceIndex++));
    }
    el.addEventListener('click', () => {
      if (Date.now() < state.rosterDrag.suppressClickUntil) return;
      selectAccount(id);
    });
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectAccount(id); }
    });
    el.addEventListener('dragstart', (event) => {
      state.rosterDrag.accountId = id;
      state.rosterDrag.sectionId = null;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `account:${id}`);
      el.classList.add('is-dragging');
    });
    el.addEventListener('dragend', () => {
      state.rosterDrag.suppressClickUntil = Date.now() + 300;
      state.rosterDrag.accountId = null;
      el.classList.remove('is-dragging');
      clearRosterDropIndicators(list);
    });
  });
  $$('[data-row-fav]', list).forEach((button) => button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (Date.now() < state.rosterDrag.suppressClickUntil) return;
    state.accounts = unwrap(await api.accounts.toggleFavorite(button.dataset.rowFav));
    renderAccounts(); renderDetail();
  }));
  $$('[data-account-drop]', list).forEach((container) => {
    container.addEventListener('dragover', (event) => {
      const accountId = state.rosterDrag.accountId;
      if (!accountId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      clearRosterDropIndicators(list);
      container.classList.add('is-drag-over');
      const placement = accountDropPlacement(container, accountId, event.clientY);
      if (placement.anchor) placement.anchor.classList.add(placement.before ? 'is-drop-before' : 'is-drop-after');
    });
    container.addEventListener('dragleave', (event) => {
      if (!container.contains(event.relatedTarget)) clearRosterDropIndicators(list);
    });
    container.addEventListener('drop', (event) => {
      const accountId = state.rosterDrag.accountId;
      if (!accountId) return;
      event.preventDefault();
      const sectionId = container.dataset.accountDrop || null;
      const { targetIndex } = accountDropPlacement(container, accountId, event.clientY);
      state.rosterDrag.suppressClickUntil = Date.now() + 300;
      state.rosterDrag.accountId = null;
      clearRosterDropIndicators(list);
      changeRoster(api.roster.moveAccount(accountId, sectionId, targetIndex), 'Account moved.');
    });
  });
  $$('[data-section-drag]', list).forEach((handle) => {
    handle.addEventListener('click', (event) => event.stopPropagation());
    handle.addEventListener('dragstart', (event) => {
      state.rosterDrag.sectionId = handle.dataset.sectionDrag;
      state.rosterDrag.accountId = null;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `section:${state.rosterDrag.sectionId}`);
      handle.closest('.roster-section').classList.add('is-dragging');
    });
    handle.addEventListener('dragend', () => {
      state.rosterDrag.sectionId = null;
      handle.closest('.roster-section').classList.remove('is-dragging');
      clearRosterDropIndicators(list);
    });
  });
  $$('[data-section-drop]', list).forEach((header) => {
    const targetId = header.dataset.sectionDrop;
    if (!targetId) return;
    header.addEventListener('dragover', (event) => {
      if (!state.rosterDrag.sectionId || state.rosterDrag.sectionId === targetId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      clearRosterDropIndicators(list);
      header.classList.add('is-drag-over');
      const bounds = header.getBoundingClientRect();
      header.classList.add(event.clientY < bounds.top + bounds.height / 2 ? 'is-drop-before' : 'is-drop-after');
    });
    header.addEventListener('dragleave', (event) => {
      if (!header.contains(event.relatedTarget)) clearRosterDropIndicators(list);
    });
    header.addEventListener('drop', (event) => {
      const sourceId = state.rosterDrag.sectionId;
      if (!sourceId || sourceId === targetId) return;
      event.preventDefault();
      const bounds = header.getBoundingClientRect();
      const insertAfter = event.clientY >= bounds.top + bounds.height / 2;
      const orderedIds = [...state.rosterSections]
        .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
        .map((section) => section.id);
      const sourceIndex = orderedIds.indexOf(sourceId);
      if (sourceIndex < 0) return;
      orderedIds.splice(sourceIndex, 1);
      const targetIndex = orderedIds.indexOf(targetId);
      orderedIds.splice(targetIndex + (insertAfter ? 1 : 0), 0, sourceId);
      state.rosterDrag.sectionId = null;
      clearRosterDropIndicators(list);
      changeRoster(api.roster.reorderSections(orderedIds), 'Sections reordered.');
    });
  });
  $$('[data-section-rename]', list).forEach((button) => button.addEventListener('click', () => openSectionModal('rename', button.dataset.sectionRename)));
  $$('[data-section-hide]', list).forEach((button) => button.addEventListener('click', () => changeRoster(api.roster.setSectionHidden(button.dataset.sectionHide, true), 'Section hidden. Use Hidden to bring it back.')));
  $$('[data-section-remove]', list).forEach((button) => button.addEventListener('click', () => openSectionModal('delete', button.dataset.sectionRemove)));
  bindPortraits(list);
  bindRankAssets(list);
}
$('#account-search').addEventListener('input', (e) => { state.inv.accSearch = e.target.value.toLowerCase(); renderAccounts(); });
$('#btn-section-add').addEventListener('click', () => openSectionModal('create'));
$('#btn-hidden-roster').addEventListener('click', (event) => {
  const panel = $('#roster-hidden');
  panel.hidden = !panel.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
});
$('#btn-show-all-roster').addEventListener('click', () => changeRoster(api.roster.showAll(), 'All roster items restored.'));
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
  const rosterSection = state.rosterSections.find((section) => section.id === a.sectionId);
  if (rosterSection) badges.push(`<span class="badge">Section · ${escapeHtml(rosterSection.name)}</span>`);
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
          <button class="btn btn--ghost" data-hide-account="${a.id}">${ic('eye-off', 15)} Hide</button>
          <button class="iconbtn" data-edit="${a.id}" title="Edit account" aria-label="Edit account">${ic('pencil', 15)}</button>
          <button class="iconbtn iconbtn--danger" data-del="${a.id}" title="Delete account" aria-label="Delete account">${ic('trash-2', 15)}</button>
        </div>
      </section>
    </div>
    <div class="detail__synced">${a.hasSession ? 'Saved session is intact and bound to this PUUID; Riot will be verified after launch.' : (a.session && a.session.reason === 'legacy' ? 'Legacy session found — save it again to add identity and integrity checks.' : 'Sign into this account once, then “Save session” for faster switching.')} · ${escapeHtml(synced)}</div>`;

  bindPortraits(detail);
  bindRankAssets(detail);
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
  $('[data-hide-account]', detail).addEventListener('click', () => changeRoster(
    api.roster.setAccountHidden(a.id, true),
    'Account hidden. Use Hidden in the roster header to bring it back.',
  ));
  $('[data-fav]', detail).addEventListener('click', async () => {
    state.accounts = unwrap(await api.accounts.toggleFavorite(a.id));
    renderAccounts(); renderDetail();
  });
}

/* ---------------- Roster section modal ---------------- */
const sectionModal = $('#section-modal');
let sectionModalMode = 'create';
let sectionModalCloseTimer = null;
let sectionModalPreviousFocus = null;
function openSectionModal(mode, id = null) {
  const section = id ? state.rosterSections.find((item) => item.id === id) : null;
  if (mode !== 'create' && !section) { toast('Roster section not found.', 'bad'); return; }
  if (sectionModalCloseTimer) clearTimeout(sectionModalCloseTimer);
  sectionModalCloseTimer = null;
  sectionModalMode = mode;
  sectionModalPreviousFocus = document.activeElement;
  sectionModal.classList.remove('is-leaving');
  $('#section-modal-id').value = section ? section.id : '';
  $('#section-modal-name').value = section ? section.name : '';
  const deleting = mode === 'delete';
  $('#section-name-field').hidden = deleting;
  $('#section-modal-name').disabled = deleting;
  $('#section-delete-warning').hidden = !deleting;
  $('#section-delete-warning').innerHTML = deleting
    ? `<strong>Delete “${escapeHtml(section.name)}”?</strong> Its accounts will be kept and moved to No section.`
    : '';
  $('#section-modal-title').textContent = deleting ? 'Delete roster section' : mode === 'rename' ? 'Rename roster section' : 'Create roster section';
  $('#section-modal-submit').textContent = deleting ? 'Delete section' : mode === 'rename' ? 'Save name' : 'Create section';
  $('#section-modal-submit').classList.toggle('btn--danger', deleting);
  $('#section-modal-submit').disabled = false;
  if (deleting) sectionModal.setAttribute('aria-describedby', 'section-delete-warning');
  else sectionModal.removeAttribute('aria-describedby');
  sectionModal.hidden = false;
  if (deleting) $('#section-modal-submit').focus();
  else $('#section-modal-name').focus();
}
function closeSectionModal() {
  if (sectionModal.hidden || sectionModal.classList.contains('is-leaving')) return;
  sectionModal.classList.add('is-leaving');
  sectionModalCloseTimer = setTimeout(() => {
    sectionModal.hidden = true;
    sectionModal.classList.remove('is-leaving');
    sectionModalCloseTimer = null;
    if (sectionModalPreviousFocus && document.contains(sectionModalPreviousFocus)) sectionModalPreviousFocus.focus();
    sectionModalPreviousFocus = null;
  }, reducedMotion.matches ? 0 : 190);
}
$$('[data-section-close]', sectionModal).forEach((element) => element.addEventListener('click', closeSectionModal));
$('#section-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#section-modal-id').value;
  const name = $('#section-modal-name').value.trim();
  const submit = $('#section-modal-submit');
  submit.disabled = true;
  try {
    let snapshot;
    let success;
    if (sectionModalMode === 'delete') {
      snapshot = unwrap(await api.roster.removeSection(id));
      success = 'Section deleted; its accounts were kept.';
    } else if (sectionModalMode === 'rename') {
      snapshot = unwrap(await api.roster.renameSection(id, name));
      success = 'Section renamed.';
    } else {
      snapshot = unwrap(await api.roster.createSection(name));
      success = 'Section created.';
    }
    applyRosterState(snapshot);
    renderAccounts();
    renderDetail();
    closeSectionModal();
    toast(success, 'good');
  } catch (error) { toast(error.message, 'bad'); }
  finally { submit.disabled = false; }
});
document.addEventListener('keydown', (event) => {
  if (sectionModal.hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closeSectionModal(); return; }
  if (event.key !== 'Tab') return;
  const focusable = $$('button:not([disabled]), input:not([disabled]):not([type="hidden"])', sectionModal)
    .filter((element) => element.getClientRects().length > 0 && !element.closest('[hidden]'));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

/* ---------------- Account modal ---------------- */
const modal = $('#account-modal');
let modalCloseTimer = null;
function openModal(id = null) {
  if (modalCloseTimer) clearTimeout(modalCloseTimer);
  modalCloseTimer = null;
  modal.classList.remove('is-leaving');
  const acc = id ? state.accounts.find((a) => a.id === id) : null;
  $('#modal-title').textContent = acc ? 'Edit account' : 'Add account';
  $('#acc-id').value = acc ? acc.id : '';
  $('#acc-label').value = acc ? acc.label || '' : '';
  $('#acc-section').innerHTML = `<option value="">No section</option>${state.rosterSections
    .filter((section) => !section.rosterHidden || section.id === (acc && acc.sectionId))
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    .map((section) => `<option value="${section.id}">${escapeHtml(section.name)}${section.rosterHidden ? ' (hidden)' : ''}</option>`).join('')}`;
  $('#acc-section').value = acc && acc.sectionId || '';
  $('#acc-username').value = acc ? acc.username || '' : '';
  $('#acc-username').type = state.settings.hideLoginNames ? 'password' : 'text';
  $('#acc-password').value = '';
  $('#acc-password').placeholder = acc && acc.hasPassword ? '•••••••• (unchanged)' : 'Stored encrypted (AES-256-GCM)';
  $('#acc-league-platform').value = acc ? acc.leaguePlatformId || '' : '';
  modal.hidden = false;
  $('#acc-label').focus();
}
function closeModal() {
  if (modal.hidden || modal.classList.contains('is-leaving')) return;
  modal.classList.add('is-leaving');
  modalCloseTimer = setTimeout(() => {
    modal.hidden = true;
    modal.classList.remove('is-leaving');
    modalCloseTimer = null;
  }, reducedMotion.matches ? 0 : 190);
}
$$('[data-close]', modal).forEach((el) => el.addEventListener('click', closeModal));
$('#btn-add').addEventListener('click', () => openModal());
$('#btn-add-2').addEventListener('click', () => openModal());
$('#btn-add-empty').addEventListener('click', () => openModal());
$('#acc-reveal').addEventListener('click', () => { const i = $('#acc-password'); i.type = i.type === 'password' ? 'text' : 'password'; });
$('#acc-save').addEventListener('click', async () => {
  const account = {
    id: $('#acc-id').value || undefined,
    label: $('#acc-label').value.trim(),
    sectionId: $('#acc-section').value || null,
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
    await refreshConfigProfiles();
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
    const visibleCurrent = ownIdentity(current.riotId, 'the active account');
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
      const gameNote = res.launchVerified === true && res.launchedGame
        ? ` ${gameLabel(res.launchedGame)} process confirmed running.`
        : '';
      const migration = res.configMigration;
      const changed = Number(migration && migration.changed || 0);
      const unchanged = Number(migration && migration.unchanged || 0);
      const configNote = migration && migration.contentVerifiedAfterProductStart
        ? (changed > 0
          ? ` Config contents verified after game start: ${changed} rewritten, ${unchanged} already matched.`
          : ` Config contents verified after game start: no files rewritten; ${unchanged} already matched.`)
        : '';
      logActivity(`PUUID verified for ${ownIdentity(res.currentSession.riotId, 'the requested account')}.${gameNote}${configNote}${captureNote}`, 'good');
      toast(`${res.mode === 'already-active' ? 'Account was already active' : 'Requested Riot account verified'}.${gameNote}${configNote}${captureNote}`, 'good');
      startChatPolling();
    } else if (res.manualRequired) {
      logActivity(`Native login needs attention: ${res.reason || 'input unavailable'}.`, 'bad');
      toast(`Automatic login could not complete: ${res.reason || 'unknown input error'}`, 'bad');
    } else if (res.verification && res.verification.status === 'mismatched') {
      logActivity('Riot exposed a different PUUID; switch rejected.', 'bad');
      toast('Riot signed into a different account. The switch was rejected and no account data was attached.', 'bad');
    } else if (res.credentialAttention || res.authenticationNotConfirmed) {
      logActivity('Riot did not confirm authentication; saved credentials or a verification challenge need attention.', 'warn');
      toast('Riot did not authenticate this account. Verify the saved login username/password, or complete any Riot verification challenge.', 'bad');
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
    return res;
  } catch (e) {
    logActivity(e.message, 'bad');
    toast(e.message, 'bad');
    return null;
  } finally {
    await refreshConfigProfiles();
    switchOverlay.hidden = true;
  }
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
      if (!state.chat.timer) startChatPolling();
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
    state.inv.entranceSeen = new Set();
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
function itemCard(it, entranceIndex = -1) {
  const name = String(it.name || 'Unnamed item');
  const category = String(it.category || it.type || 'Collection');
  const type = String(it.type || 'item').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const cls = `item item--${type}${it.fit === 'cover' ? ' item--cover' : ''}${entranceIndex >= 0 ? ' enter-item' : ''}`;
  const image = safeImageUrl(it.image);
  const fallback = `<div class="item__fallback"><span>${ic('image', 20)}</span><b>${escapeHtml(initials(name))}</b></div>`;
  const badges = [];
  if (it.tier && it.tier !== 'Standard') badges.push(`<span class="badge badge--tier" style="background:${escapeHtml(it.tierColor || '#5a6b7a')}">${escapeHtml(String(it.tier).replace(' Edition', ''))}</span>`);
  if (it.value) badges.push(`<span class="badge badge--vp">${fmt(it.value)} ${escapeHtml(it.currency || (state.inv.game === 'lol' ? 'RP' : 'VP'))}</span>`);
  if (it.variants) badges.push(`<span class="badge">+${fmt(it.variants)}</span>`);
  const motionStyle = entranceIndex >= 0 ? `;--enter-index:${entranceIndex}` : '';
  return `
    <article class="${cls}" style="--tier:${escapeHtml(it.tierColor || '#4a4a55')}${motionStyle}">
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
  let entranceIndex = 0;
  const cards = items.map((item) => {
    const key = `${item.type || ''}:${item.id || item.uuid || item.name || ''}:${item.category || ''}`;
    const isNew = !state.inv.entranceSeen.has(key);
    state.inv.entranceSeen.add(key);
    const animateAt = isNew && entranceIndex < 10 && !reducedMotion.matches ? entranceIndex++ : -1;
    return itemCard(item, animateAt);
  });
  grid.innerHTML = items.length ? cards.join('') : '<div class="empty inventory-no-results"><p class="muted">No items in this section match your filters.</p></div>';
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
function showSettingGroup(group) {
  $$('.settingnav').forEach((item) => item.classList.toggle('is-active', item.dataset.group === group));
  $$('.setting-group').forEach((item) => item.classList.toggle('is-active', item.dataset.group === group));
}
$$('.settingnav').forEach((button) => button.addEventListener('click', () => showSettingGroup(button.dataset.group)));
function renderStartupState(startup) {
  const actual = startup && typeof startup === 'object'
    ? startup
    : { supported: false, enabled: false, reason: 'Windows startup state is unavailable.' };
  state.startup = actual;
  const input = $('#set-startup');
  input.checked = actual.supported && actual.enabled === true;
  input.disabled = !actual.supported;
  const control = input.closest('.startup-control');
  control.classList.toggle('is-disabled', !actual.supported);
  $('#startup-status').textContent = actual.supported
    ? (actual.enabled
      ? 'Enabled. Riot Relay will start after you sign in to Windows.'
      : 'Disabled. Riot Relay will not start automatically.')
    : (actual.reason || 'Available in installed Windows builds.');
}
async function loadSettings() {
  const startupRequest = api.startup.get().then(unwrap).catch((error) => ({
    supported: false,
    enabled: false,
    reason: error && error.message ? error.message : 'Windows startup state is unavailable.',
  }));
  const [s, vaultStatus, helloAvailable, startup] = await Promise.all([
    api.settings.get().then(unwrap),
    api.vault.status().then(unwrap),
    windowsHelloAvailable(),
    startupRequest,
  ]);
  state.settings = s;
  state.startup = startup;
  $('#set-client-path').value = s.clientPath || '';
  $('#set-autofill').checked = !!s.autoFill;
  $('#set-auto-sync').checked = s.autoSyncAfterLogin !== false;
  $('#set-minimize').checked = !!s.minimizeOnSwitch;
  $('#set-minimize-tray').checked = s.minimizeToTray !== false;
  renderStartupState(startup);
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
  $('#set-rank-borders').checked = s.showRosterRankBorders === true;
  $('#client-detected').textContent = s.detectedClient ? `Detected: ${s.detectedClient}` : 'Riot Client not auto-detected. Set the path manually.';
  $('#enc-status').textContent = s.encryptionAvailable
    ? 'Windows OS key protection is available. Choose how this vault may use it below.'
    : 'OS key protection is unavailable. This vault can only be unlocked with its master password.';
  $('#hello-status').textContent = helloAvailable
    ? 'Windows Hello is available through Chromium WebAuthn. Hello mode requires verified Windows consent every time the stored key is used.'
    : 'Windows Hello is not configured or unavailable; standard OS-stored mode can still be used.';
  updateDeceiveUI();
  refreshDeceiveState();
  refreshConfigProfiles();
  renderConfigAccounts();
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

function configNamespace() { return $('#config-game').value; }
function configLaunchGame() { return configNamespace() === 'league' ? $('#config-league-launch').value : configNamespace(); }
function linkedConfigAccounts() {
  const linkedIds = new Set(state.configProfiles.filter((item) => item && item.linked === true).map((item) => item.accountId));
  return state.accounts.filter((account) => linkedIds.has(account.id));
}
function activeConfigAccountId() {
  if (state.configProfilesError) return null;
  const rosterIds = new Set(state.accounts.map((account) => account.id));
  const linkedIds = new Set(state.configProfiles
    .filter((item) => item && item.linked === true && rosterIds.has(item.accountId))
    .map((item) => item.accountId));
  const matches = [...new Set(state.currentSession?.matchingAccountIds || [])]
    .filter((accountId) => rosterIds.has(accountId) && linkedIds.has(accountId));
  return matches.length === 1 ? matches[0] : null;
}
function orderedConfigAccounts() {
  const linkedIds = new Set(linkedConfigAccounts().map((account) => account.id));
  return [...state.accounts].sort((a, b) => Number(linkedIds.has(b.id)) - Number(linkedIds.has(a.id)));
}
function differentLinkedConfigAccountId(accountId) {
  return linkedConfigAccounts().find((account) => account.id !== accountId)?.id || '';
}
function normalizeConfigRoles(sourceValue, targetValue) {
  const accountIds = new Set(state.accounts.map((account) => account.id));
  const validPair = accountIds.has(sourceValue) && accountIds.has(targetValue) && sourceValue !== targetValue;
  if (validPair && state.configRoles.intentional) return { sourceId: sourceValue, targetId: targetValue };
  if (!validPair) state.configRoles.intentional = false;
  const sourceId = activeConfigAccountId() || linkedConfigAccounts()[0]?.id || '';
  return { sourceId, targetId: differentLinkedConfigAccountId(sourceId) };
}
function updateConfigSignedInControls() {
  const activeId = activeConfigAccountId();
  for (const button of $$('.config-use-current')) {
    button.disabled = !activeId;
    button.title = activeId ? `Use signed-in account: ${configAccountLabel(activeId)}` : 'No unique signed-in linked account is available.';
  }
}
function renderConfigAccounts() {
  if (!$('#config-source') || !$('#config-target')) return;
  const selection = normalizeConfigRoles($('#config-source').value, $('#config-target').value);
  const activeId = activeConfigAccountId();
  const statusById = new Map(state.configProfiles.map((item) => [item.accountId, item]));
  const options = orderedConfigAccounts().map((account) => {
    const linked = statusById.get(account.id)?.linked === true;
    const suffix = account.id === activeId ? ' · signed in' : linked ? '' : ' · sync required';
    return `<option value="${escapeHtml(account.id)}">${escapeHtml(account.label || 'Unnamed account')}${suffix}</option>`;
  }).join('');
  const placeholder = `<option value="">${state.accounts.length ? 'Select an account' : 'No accounts'}</option>`;
  $('#config-source').innerHTML = placeholder + options;
  $('#config-target').innerHTML = placeholder + options;
  $('#config-source').value = selection.sourceId;
  $('#config-target').value = selection.targetId;
  updateConfigSignedInControls();
  renderConfigProfileStatus();
}
function enforceDistinctConfigRoles(changedRole) {
  const changed = $(`#config-${changedRole}`);
  const oppositeRole = changedRole === 'source' ? 'target' : 'source';
  const opposite = $(`#config-${oppositeRole}`);
  const linkedIds = new Set(linkedConfigAccounts().map((account) => account.id));
  if (opposite.value !== changed.value && linkedIds.has(opposite.value)) return;
  opposite.value = differentLinkedConfigAccountId(changed.value);
}
function useActiveConfigAccount(role) {
  const activeId = activeConfigAccountId();
  if (!activeId) return;
  $(`#config-${role}`).value = activeId;
  enforceDistinctConfigRoles(role);
  state.configRoles.intentional = true;
  renderConfigProfileStatus();
}

function formatConfigCaptureTime(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
function configAccountLabel(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  return account ? account.label || 'Unnamed account' : 'Select an account';
}
function latestCloudSourceStatus() {
  return state.configProfiles
    .filter((item) => item && item.cloudCaptured === true)
    .slice()
    .sort((a, b) => String(b.cloudCapturedAt || '').localeCompare(String(a.cloudCapturedAt || '')))[0] || null;
}
function setConfigStepState(element, stateName) {
  element.classList.toggle('is-complete', stateName === 'complete');
  element.classList.toggle('is-blocked', stateName === 'blocked');
  element.classList.toggle('is-active', stateName === 'active');
  element.classList.toggle('is-error', stateName === 'error');
  element.classList.toggle('is-unknown', stateName === 'unknown');
}
function renderConfigProfileStatus() {
  const namespace = configNamespace();
  const isCloud = namespace === 'valorant';
  const cloud = $('#config-cloud');
  $('#config-workflow').hidden = isCloud;
  if (cloud) cloud.hidden = !isCloud;
  $('#config-league-launch-wrap').hidden = namespace !== 'league';
  const sourceId = $('#config-source').value;
  const targetId = $('#config-target').value;
  const source = state.configProfiles.find((item) => item.accountId === sourceId);
  const target = state.configProfiles.find((item) => item.accountId === targetId);
  const linkedCount = linkedConfigAccounts().length;
  const enoughLinkedAccounts = linkedCount >= 2;
  const activeId = activeConfigAccountId();
  const differentAccounts = !!sourceId && !!targetId && sourceId !== targetId;
  const sourceLinked = source?.linked === true;
  const targetLinked = target?.linked === true;
  const sourceReady = isCloud ? source?.cloudCaptured === true : !!(source && source.profiles && source.profiles[namespace]);
  const targetReady = isCloud ? targetLinked : !!(target && target.profiles && target.profiles[namespace]);
  const sourceInvalid = !isCloud && !!(source && source.profileErrors && source.profileErrors[namespace]);
  const targetInvalid = !isCloud && !!(target && target.profileErrors && target.profileErrors[namespace]);
  const sourceCaptureAllowed = enoughLinkedAccounts && sourceLinked && activeId === sourceId;
  const targetCaptureAllowed = !isCloud && enoughLinkedAccounts && targetLinked && activeId === targetId;
  const bound = isCloud ? sourceReady && differentAccounts : !!(target && target.bindings && target.bindings[namespace]);
  const applicable = isCloud ? bound && targetLinked : !!(target && target.bindingApplicable && target.bindingApplicable[namespace]);
  const boundSourceId = isCloud ? sourceId : target && target.bindingSources && target.bindingSources[namespace];
  const selectedRouteBound = bound && boundSourceId === sourceId;
  const sourceTime = sourceReady ? formatConfigCaptureTime(source.profileCapturedAt && source.profileCapturedAt[namespace]) : '';
  const targetTime = targetReady ? formatConfigCaptureTime(target.profileCapturedAt && target.profileCapturedAt[namespace]) : '';
  const lastApplied = target && target.lastAppliedAt && target.lastAppliedAt[namespace];
  const lastResult = target && target.lastResult && target.lastResult[namespace];
  const gameName = $('#config-game').selectedOptions[0]?.textContent || 'Game';
  const unavailable = !!state.configProfilesError;

  const sourceCapturePrompt = activeId === sourceId ? 'Signed-in account ready to capture' : 'Sign into this account to capture';
  const targetCapturePrompt = activeId === targetId ? 'Signed-in account ready to capture' : 'Sign into this account to capture';
  $('#config-source-status').textContent = unavailable ? 'Status unavailable — controls paused'
    : !enoughLinkedAccounts ? 'Link at least two roster accounts'
      : !sourceLinked ? 'Sync this account first'
        : sourceInvalid ? 'Captured profile failed integrity validation'
          : sourceReady ? `Captured for verified PUUID${sourceTime ? ` · ${sourceTime}` : ''}` : sourceCapturePrompt;
  $('#config-target-status').textContent = unavailable ? 'Status unavailable — controls paused'
    : !enoughLinkedAccounts ? 'Link at least two roster accounts'
      : !sourceReady ? 'Waiting for step 1'
        : !differentAccounts ? 'Choose a different target'
          : !targetLinked ? 'Sync this account first'
            : targetInvalid ? 'Captured profile failed integrity validation'
              : targetReady ? `Captured for verified PUUID${targetTime ? ` · ${targetTime}` : ''}` : targetCapturePrompt;
  $('#config-review-status').textContent = unavailable ? 'Application state unavailable'
    : !enoughLinkedAccounts ? 'Two distinct linked accounts required'
      : selectedRouteBound && !applicable ? 'Bound — profile is no longer applicable'
        : selectedRouteBound && (!lastResult || lastResult.status === 'failed')
          ? lastResult && lastResult.status === 'failed' ? 'Bound — last application failed' : 'Bound — not yet applied'
          : selectedRouteBound ? 'Bound — local application verified'
            : bound ? 'Target is bound to another source'
              : sourceReady && targetReady && differentAccounts ? 'Ready to bind' : 'Complete steps 1 and 2';
  $('#config-profile-status').textContent = `${configAccountLabel(sourceId)} → ${configAccountLabel(targetId)} · ${gameName}`;
  $('#config-application-status').textContent = lastResult
    ? `${lastResult.status === 'failed' ? 'Last attempt failed' : 'Last local verification'}${lastApplied ? ` · ${formatConfigCaptureTime(lastApplied)}` : ''} · ${lastResult.changed} changed, ${lastResult.unchanged} unchanged, ${lastResult.skipped} skipped. Riot cloud acceptance is not claimed.`
    : 'No local application attempt recorded. Manual game launches are not intercepted.';

  setConfigStepState($('#config-step-source'), unavailable ? 'unknown' : !enoughLinkedAccounts ? 'blocked' : sourceInvalid ? 'error' : sourceReady ? 'complete' : 'active');
  setConfigStepState($('#config-step-target'), unavailable ? 'unknown' : !enoughLinkedAccounts ? 'blocked' : targetInvalid ? 'error'
    : targetReady && differentAccounts ? 'complete' : sourceReady ? 'active' : 'blocked');
  setConfigStepState($('#config-step-review'), unavailable ? 'unknown' : !enoughLinkedAccounts ? 'blocked' : selectedRouteBound && !applicable ? 'error'
    : selectedRouteBound ? 'complete' : sourceReady && targetReady && differentAccounts ? 'active' : 'blocked');

  $('#btn-config-capture-source').disabled = unavailable || !sourceCaptureAllowed;
  $('#btn-config-capture-target').hidden = isCloud;
  $('#btn-config-capture-target').disabled = isCloud || unavailable || !sourceReady || !differentAccounts || !targetCaptureAllowed;
  $('#btn-config-migrate').hidden = isCloud;
  $('#btn-config-migrate').disabled = isCloud || unavailable || !enoughLinkedAccounts || !sourceLinked || !targetLinked || !sourceReady || !targetReady || !differentAccounts;
  $('#btn-config-migrate').textContent = selectedRouteBound ? 'Update binding' : 'Save binding';
  $('#btn-config-apply').disabled = unavailable || !enoughLinkedAccounts || !differentAccounts || !sourceLinked || !targetLinked || !sourceReady || (isCloud ? activeId !== targetId : !selectedRouteBound || !applicable);
  $('#btn-config-apply').textContent = isCloud ? 'Apply cloud settings to target' : 'Apply and launch target';
  $('#btn-config-auto').disabled = unavailable || !enoughLinkedAccounts || !differentAccounts || !sourceLinked || !targetLinked;
  $('#btn-config-remove').hidden = isCloud || !bound;
  $('#btn-config-remove').disabled = unavailable;
  if (cloud) {
    const activeId = activeConfigAccountId();
    // The captured source is whichever validated account blob is newest.
    const source = latestCloudSourceStatus();
    const sourceId = source ? source.accountId : null;
    const sourceIsActive = !!activeId && sourceId === activeId;
    const activeStatus = activeId && state.configProfiles.find((item) => item.accountId === activeId);
    const activeBackup = !!(activeStatus && activeStatus.cloudBackupAvailable);
    // Capture whoever is signed in right now (the only account you can read).
    if ($('#btn-cloud-capture')) $('#btn-cloud-capture').disabled = unavailable || !activeId;
    // Apply the captured source to a DIFFERENT signed-in target.
    if ($('#btn-cloud-apply')) $('#btn-cloud-apply').disabled = unavailable || !sourceId || !activeId || sourceIsActive;
    // Restore only when the signed-in account actually has a backup.
    if ($('#btn-cloud-restore')) $('#btn-cloud-restore').disabled = unavailable || !activeId || !activeBackup;
    const statusEl = $('#config-cloud-status');
    if (statusEl) {
      statusEl.textContent = source
        ? `Source captured: ${configAccountLabel(sourceId)}. Sign into a target account, then Apply.`
        : 'No source captured yet. Sign into the source account and Capture.';
    }
  }
  updateConfigSignedInControls();
}

async function refreshConfigProfiles() {
  try {
    state.configProfiles = unwrap(await api.configs.status());
    state.configProfilesError = null;
  } catch (error) {
    state.configProfilesError = error && error.message ? error.message : 'Configuration status is unavailable.';
  }
  renderConfigAccounts();
}

async function runConfigAction(button, action, success) {
  button.disabled = true; button.classList.add('is-loading');
  try { await action(); await refreshConfigProfiles(); toast(success, 'good'); }
  catch (error) { logActivity(error.message, 'bad'); toast(error.message, 'bad'); }
  finally { button.classList.remove('is-loading'); renderConfigProfileStatus(); }
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
$('#set-auto-sync').addEventListener('change', (e) => setSetting({ autoSyncAfterLogin: e.target.checked }));
$('#set-minimize').addEventListener('change', (e) => setSetting({ minimizeOnSwitch: e.target.checked }));
$('#set-minimize-tray').addEventListener('change', async (event) => {
  await setSetting({ minimizeToTray: event.target.checked });
  toast(event.target.checked
    ? 'Minimize to tray enabled. Use the Windows notification area to restore or quit Riot Relay.'
    : 'Minimize to tray disabled. The minimize button will keep Riot Relay on the taskbar.', 'good');
});
$('#set-startup').addEventListener('change', async (event) => {
  const input = event.target;
  const requested = input.checked;
  input.disabled = true;
  input.closest('.startup-control').classList.add('is-disabled');
  $('#startup-status').textContent = requested ? 'Enabling Windows startup…' : 'Disabling Windows startup…';
  try {
    const actual = unwrap(await api.startup.set(requested));
    renderStartupState(actual);
    toast(actual.enabled ? 'Auto-launch with Windows enabled.' : 'Auto-launch with Windows disabled.', 'good');
  } catch (error) {
    try { renderStartupState(unwrap(await api.startup.get())); }
    catch { renderStartupState(state.startup); }
    toast(error.message, 'bad');
  }
});

$('#config-source').addEventListener('change', () => { enforceDistinctConfigRoles('source'); state.configRoles.intentional = true; renderConfigProfileStatus(); });
$('#config-target').addEventListener('change', () => { enforceDistinctConfigRoles('target'); state.configRoles.intentional = true; renderConfigProfileStatus(); });
$('#config-game').addEventListener('change', renderConfigProfileStatus);
$('#config-league-launch').addEventListener('change', renderConfigProfileStatus);
$('#btn-config-source-current').addEventListener('click', () => useActiveConfigAccount('source'));
$('#btn-config-target-current').addEventListener('click', () => useActiveConfigAccount('target'));
$('#btn-config-capture-source').addEventListener('click', (event) => runConfigAction(event.currentTarget,
  () => api.configs.capture($('#config-source').value, configNamespace()).then(unwrap),
  'Source preferences captured while the selected PUUID was verified.'));
$('#btn-config-capture-target').addEventListener('click', (event) => runConfigAction(event.currentTarget,
  () => api.configs.capture($('#config-target').value, $('#config-game').value).then(unwrap),
  'Target baseline captured while the selected PUUID was verified.'));
$('#btn-config-migrate').addEventListener('click', (event) => runConfigAction(event.currentTarget,
  () => api.configs.migrate($('#config-source').value, $('#config-target').value, $('#config-game').value).then(unwrap),
  'Binding saved. No files were changed; use Apply and launch target.'));
$('#btn-config-apply').addEventListener('click', () => doSwitch($('#config-target').value, configLaunchGame()));
$('#btn-config-auto').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const sourceId = $('#config-source').value;
  const targetId = $('#config-target').value;
  const namespace = configNamespace();
  button.disabled = true; button.classList.add('is-loading');
  try {
    let result = await doSwitch(sourceId);
    if (!result || result.verified !== true) throw new Error('Source account could not be verified.');
    unwrap(await api.configs.capture(sourceId, namespace));
    result = await doSwitch(targetId);
    if (!result || result.verified !== true) throw new Error('Target account could not be verified.');
    unwrap(await api.configs.capture(targetId, namespace));
    unwrap(await api.configs.migrate(sourceId, targetId, namespace));
    result = await doSwitch(targetId, configLaunchGame());
    if (!result || result.verified !== true) throw new Error('Target configuration was prepared, but launch verification did not complete.');
    toast('Seamless migration completed.', 'good');
  } catch (error) { logActivity(error.message, 'bad'); toast(error.message, 'bad'); }
  finally { button.classList.remove('is-loading'); await refreshConfigProfiles(); }
});
$('#btn-cloud-capture').addEventListener('click', (event) => runConfigAction(event.currentTarget,
  async () => {
    // You can only capture whoever is signed in right now; that becomes the source.
    const activeId = activeConfigAccountId();
    if (!activeId) throw new Error('Sign in to the account you want to use as the source in the Riot Client first.');
    unwrap(await api.configs.captureCloud(activeId));
    logActivity('Captured VALORANT settings from the signed-in account (set as source). Switch to a target account, then Apply.', 'good');
  },
  'Source settings captured.'));
$('#btn-cloud-apply').addEventListener('click', (event) => runConfigAction(event.currentTarget,
  async () => {
    const sourceId = latestCloudSourceStatus()?.accountId;
    if (!sourceId) throw new Error('Capture a source account’s settings first.');
    const result = unwrap(await api.configs.applyCloud(sourceId));
    logActivity(`Applied source settings to the signed-in account${result.hadBackup ? ' (previous settings backed up)' : ''}. Restart VALORANT to load them.`, 'good');
  },
  'Settings applied to the signed-in account.'));
$('#btn-cloud-restore').addEventListener('click', (event) => runConfigAction(event.currentTarget,
  async () => {
    const targetId = activeConfigAccountId();
    if (!targetId) throw new Error('Sign in to the account you want to restore first.');
    unwrap(await api.configs.restoreCloud(targetId));
    logActivity('Restored the signed-in account’s pre-migration settings from backup. Restart VALORANT to load them.', 'good');
  },
  'Settings backup restored.'));
$('#btn-config-remove').addEventListener('click', (event) => runConfigAction(event.currentTarget,
  () => api.configs.removeBinding($('#config-target').value, $('#config-game').value).then(unwrap),
  'Binding removed; captured profiles and backups were kept.'));
async function applyPrivacySetting(key, checked) {
  await setSetting({ [key]: checked });
  renderAccounts(); renderDetail(); updateStatusBar();
  if (state.inventory) renderValueCard();
  if (state.chat.identity && state.chat.identity.riotId) $('#chat-identity').textContent = `Active · ${displayRiotId(state.chat.identity.riotId)}`;
  renderChatFriends();
  renderChatHeader(state.chat.friends.find((friend) => friend.id === state.chat.selectedId));
  if (state.chat.selectedId) renderChatMessages();
}
$('#set-hide-login').addEventListener('change', (event) => applyPrivacySetting('hideLoginNames', event.target.checked));
$('#set-hide-display').addEventListener('change', (event) => applyPrivacySetting('hideDisplayNames', event.target.checked));
$('#set-rank-borders').addEventListener('change', async (event) => {
  await setSetting({ showRosterRankBorders: event.target.checked });
  renderAccounts();
});
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
  const version = String(state.updates.currentVersion || '1.3.8');
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
