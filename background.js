// Little Helium — Arc's "Little Arc" for Helium / Chromium.
//
// A Little window is a popup-type window (no tab strip, minimal chrome) that we
// track by id. Links arriving from other apps are caught and moved into one;
// "promote" moves the page into the most recently used main window.

import { DEFAULTS, getSettings } from './settings.js';

const START_PAGE = chrome.runtime.getURL('little.html');
const STARTUP_GRACE_MS = 5000;   // ignore session-restore tabs right after launch
const REFOCUS_WINDOW_MS = 1500;  // browser regained focus this recently => link likely came from another app
const MIN_AWAY_MS = 250;         // shorter blur/focus blips are window switches inside the browser
const CANDIDATE_TTL_MS = 3000;   // how long to wait for a URL on a tab created without one
const CASCADE_PX = 28;

// ---------------------------------------------------------------------------
// State (mirrored to storage.session so it survives service-worker restarts)

const state = {
  little: new Set(),   // ids of Little windows
  mru: [],             // normal window ids, most recently focused first
  focused: true,       // does any browser window have OS focus?
  blurAt: 0,
  focusAt: 0,
  startupAt: 0,
  suppressUntil: 0,    // ignore tab creation we caused ourselves
};

const ready = chrome.storage.session.get('state').then(({ state: saved }) => {
  if (!saved) return;
  Object.assign(state, saved, { little: new Set(saved.little) });
});

function persist() {
  chrome.storage.session.set({ state: { ...state, little: [...state.little] } });
}

// Tabs created with no URL yet that looked external when they were created.
const candidates = new Map(); // tabId -> createdAt

// ---------------------------------------------------------------------------
// Lifecycle

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set({ ...DEFAULTS, ...current });
  createMenus();
});

chrome.runtime.onStartup.addListener(async () => {
  await ready;
  state.little.clear();
  state.mru = [];
  state.startupAt = Date.now();
  persist();
  createMenus();
});

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'open-link', title: 'Open Link in Little Window', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'pop-out', title: 'Pop Out Tab into Little Window', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'settings', title: 'Little Helium Settings', contexts: ['action'] });
  });
}

// ---------------------------------------------------------------------------
// Focus tracking

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await ready;
  const now = Date.now();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    if (state.focused) {
      state.focused = false;
      state.blurAt = now;
    }
  } else {
    if (!state.focused) {
      state.focused = true;
      state.focusAt = now;
    }
    if (!state.little.has(windowId)) {
      const win = await chrome.windows.get(windowId).catch(() => null);
      if (win?.type === 'normal') {
        state.mru = [windowId, ...state.mru.filter((id) => id !== windowId)];
      }
    }
  }
  persist();
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await ready;
  state.little.delete(windowId);
  state.mru = state.mru.filter((id) => id !== windowId);
  persist();
});

// ---------------------------------------------------------------------------
// Catching links from other apps

function isWebUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

function looksExternal(tab) {
  const now = Date.now();
  if (tab.openerTabId !== undefined) return false;
  if (state.little.has(tab.windowId)) return false;
  if (now < state.suppressUntil) return false;
  if (now - state.startupAt < STARTUP_GRACE_MS) return false;
  if (!state.focused) return true;
  return now - state.focusAt < REFOCUS_WINDOW_MS && state.focusAt - state.blurAt > MIN_AWAY_MS;
}

chrome.tabs.onCreated.addListener(async (tab) => {
  await ready;
  if (!looksExternal(tab)) return;
  const { catchExternal } = await getSettings();
  if (!catchExternal) return;

  const url = tab.pendingUrl || tab.url;
  if (isWebUrl(url)) {
    catchTab(tab, url);
  } else if (!url) {
    candidates.set(tab.id, Date.now());
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ready;

  if (changeInfo.url && candidates.has(tabId)) {
    const fresh = Date.now() - candidates.get(tabId) < CANDIDATE_TTL_MS;
    candidates.delete(tabId);
    if (fresh && isWebUrl(changeInfo.url)) catchTab(tab, changeInfo.url);
  }

  if (changeInfo.status === 'complete' && state.little.has(tab.windowId)) {
    injectOverlay(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => candidates.delete(tabId));

async function catchTab(tab, url) {
  const bounds = await littleBounds();
  let win;
  try {
    // Moving the tab keeps it loading instead of starting over. If the tab was
    // alone in a window Helium just opened for it, that window closes itself.
    win = await chrome.windows.create({ tabId: tab.id, type: 'popup', focused: true, ...bounds });
  } catch {
    win = await chrome.windows.create({ url, type: 'popup', focused: true, ...bounds });
    chrome.tabs.remove(tab.id).catch(() => {});
  }
  await registerLittle(win);
}

// ---------------------------------------------------------------------------
// Opening, popping out, promoting

async function registerLittle(win) {
  state.little.add(win.id);
  persist();
  for (const t of win.tabs ?? []) injectOverlay(t.id);
}

async function openLittle(url = START_PAGE, incognito = false) {
  const bounds = await littleBounds();
  const opts = { url, type: 'popup', focused: true, ...bounds };
  // Incognito only works if the user allowed the extension there.
  const win = await chrome.windows.create({ ...opts, incognito })
    .catch(() => chrome.windows.create(opts));
  await registerLittle(win);
  return win;
}

async function popOut(tab) {
  if (!tab || state.little.has(tab.windowId)) return;
  const bounds = await littleBounds();
  const win = await chrome.windows.create({ tabId: tab.id, type: 'popup', focused: true, ...bounds });
  await registerLittle(win);
}

async function mainWindowFor(incognito) {
  const normals = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const eligible = normals.filter((w) => w.incognito === incognito);
  const rank = (w) => {
    const i = state.mru.indexOf(w.id);
    return i === -1 ? Infinity : i;
  };
  eligible.sort((a, b) => rank(a) - rank(b));
  return eligible[0] ?? null;
}

async function promote(tabId) {
  await ready;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !state.little.has(tab.windowId)) return;

  const url = tab.url || tab.pendingUrl;
  const onStartPage = url?.startsWith(START_PAGE);
  const target = await mainWindowFor(tab.incognito);
  state.suppressUntil = Date.now() + 2000;
  persist();

  if (target) {
    try {
      if (onStartPage) throw new Error('open a fresh tab instead');
      await chrome.tabs.move(tabId, { windowId: target.id, index: -1 });
      await chrome.tabs.update(tabId, { active: true });
    } catch {
      // Chromium only moves tabs between normal windows; re-open the URL instead.
      await chrome.tabs.create({ windowId: target.id, url: onStartPage ? undefined : url, active: true });
      await chrome.windows.remove(tab.windowId).catch(() => {});
    }
    await chrome.windows.update(target.id, { focused: true });
  } else {
    try {
      if (onStartPage) throw new Error('open a fresh window instead');
      await chrome.windows.create({ tabId, type: 'normal', focused: true });
    } catch {
      await chrome.windows.create({ url: onStartPage ? undefined : url, type: 'normal', focused: true });
      await chrome.windows.remove(tab.windowId).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Geometry

async function littleBounds() {
  await ready;
  const { width, height, position } = await getSettings();
  let area;
  try {
    const displays = await chrome.system.display.getInfo();
    const anchor = await chrome.windows.getLastFocused().catch(() => null);
    const cx = anchor ? anchor.left + anchor.width / 2 : null;
    const cy = anchor ? anchor.top + anchor.height / 2 : null;
    const containing = displays.find(({ bounds: b }) =>
      cx !== null && cx >= b.left && cx < b.left + b.width && cy >= b.top && cy < b.top + b.height);
    area = (containing ?? displays.find((d) => d.isPrimary) ?? displays[0])?.workArea;
  } catch {
    // system.display unavailable — let the browser place the window.
  }
  if (!area) return { width, height };

  const margin = 24;
  const w = Math.min(width, area.width - margin * 2);
  const h = Math.min(height, area.height - margin * 2);
  const shift = (state.little.size % 6) * CASCADE_PX;

  let left, top;
  if (position === 'top-right') {
    left = area.left + area.width - w - margin - shift;
    top = area.top + margin + shift;
  } else {
    left = area.left + (area.width - w) / 2 + shift;
    top = area.top + (area.height - h) / 2.4 + shift;
  }
  return { width: Math.round(w), height: Math.round(h), left: Math.round(left), top: Math.round(top) };
}

// ---------------------------------------------------------------------------
// Overlay injected into pages shown in Little windows

async function injectOverlay(tabId) {
  const { showOverlay } = await getSettings();
  if (!showOverlay) return;
  chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] }).catch(() => {
    // Restricted page (chrome://, web store, PDF viewer…) or not yet committed.
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ready;
    const tabId = msg.tabId ?? sender.tab?.id;
    switch (msg.type) {
      case 'open-little':
        if (isWebUrl(msg.url)) await openLittle(msg.url, sender.tab?.incognito ?? false);
        break;
      case 'promote':
        await promote(tabId);
        break;
      case 'close': {
        const tab = await chrome.tabs.get(tabId);
        if (state.little.has(tab.windowId)) await chrome.windows.remove(tab.windowId);
        break;
      }
    }
    sendResponse({ ok: true });
  })();
  return true;
});

// ---------------------------------------------------------------------------
// Entry points: shortcuts, toolbar button, context menus

chrome.commands.onCommand.addListener(async (command, tab) => {
  await ready;
  if (command === 'open-little-window') {
    openLittle(START_PAGE, tab?.incognito ?? false);
  } else if (command === 'promote-little-window') {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active) promote(active.id);
  } else if (command === 'pop-out-tab') {
    popOut(tab);
  }
});

chrome.action.onClicked.addListener((tab) => openLittle(START_PAGE, tab?.incognito ?? false));

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await ready;
  if (info.menuItemId === 'open-link') openLittle(info.linkUrl, tab?.incognito ?? false);
  else if (info.menuItemId === 'pop-out') popOut(tab);
  else if (info.menuItemId === 'settings') chrome.runtime.openOptionsPage();
});

// Handy from the service worker's DevTools console.
globalThis.littleHelium = { state, openLittle, popOut, promote, littleBounds };
