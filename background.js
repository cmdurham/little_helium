// Little Helium — Arc's "Little Arc" for Helium / Chromium.
//
// A Little window is a popup-type window (no tab strip, minimal chrome) that we
// track by id. Links arriving from other apps are caught and moved into one;
// "promote" moves the page into the most recently used main window.
//
// Macs can't float a window over a full-screen Space from an extension: Helium
// forces every new window full screen while the active one is. So when the
// relevant main window is full screen we can open a tab next to the current one
// instead (the `fullscreenMode` setting).

import { DEFAULTS, getSettings } from './settings.js';

const START_PAGE = chrome.runtime.getURL('little.html');
const STARTUP_GRACE_MS = 5000;   // ignore startup pages right after launch
const NEW_WINDOW_MS = 3000;      // a window this young was opened just for the incoming link
const CASCADE_PX = 28;

// ---------------------------------------------------------------------------
// State (mirrored to storage.session so it survives service-worker restarts)

const state = {
  little: new Set(),   // ids of Little windows
  mru: [],             // normal window ids, most recently focused first
  startupAt: 0,
  suppressUntil: 0,    // ignore tab creation we caused ourselves
};

const ready = chrome.storage.session.get('state').then(({ state: saved }) => {
  if (!saved) return;
  state.little = new Set(saved.little);
  state.mru = saved.mru ?? [];
  state.startupAt = saved.startupAt ?? 0;
  state.suppressUntil = saved.suppressUntil ?? 0;
});

function persist() {
  chrome.storage.session.set({ state: { ...state, little: [...state.little] } });
}

// When each window appeared, to tell a window Helium opened for an incoming link
// from one the user already had.
const windowBornAt = new Map();

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
// Focus tracking (which main window to promote into)

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  await ready;
  if (state.little.has(windowId)) return;
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (win?.type !== 'normal') return;
  state.mru = [windowId, ...state.mru.filter((id) => id !== windowId)];
  persist();
});

chrome.windows.onCreated.addListener((win) => windowBornAt.set(win.id, Date.now()));

chrome.windows.onRemoved.addListener(async (windowId) => {
  windowBornAt.delete(windowId);
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

// Links handed to Helium by another app (Raycast, Mail, `open URL`…) commit with
// the AUTO_TOPLEVEL transition, which the API reports as "start_page". Helium
// sets the previously active tab as their opener, so the opener can't be used.
// Startup pages share the transition, hence the grace period after launch.
chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url, transitionType }) => {
  if (frameId !== 0 || transitionType !== 'start_page' || !isWebUrl(url)) return;
  await ready;
  const now = Date.now();
  if (now - state.startupAt < STARTUP_GRACE_MS || now < state.suppressUntil) return;
  const { catchExternal } = await getSettings();
  if (!catchExternal) return;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || state.little.has(tab.windowId)) return;
  // Already a tab in the full-screen window, which is where tab mode wants it.
  if (await useTabInstead(tab.windowId)) return;
  catchTab(tab, url);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  await ready;
  if (state.little.has(tab.windowId)) injectOverlay(tabId);
});

async function catchTab(tab, url) {
  const bounds = await littleBounds();
  const siblings = await chrome.tabs.query({ windowId: tab.windowId });
  // Helium replaces a lone new-tab page with the link. Moving that tab out would
  // close the user's window, so copy the URL and put a new-tab page back.
  // If the service worker was asleep, the link's navigation can reach us before
  // the window's onCreated does. Chromium numbers windows and tabs from one
  // counter, so a window's very first tab has the id right after the window's.
  const bornAt = windowBornAt.get(tab.windowId);
  const openedForLink = (bornAt !== undefined && Date.now() - bornAt < NEW_WINDOW_MS)
    || tab.id === tab.windowId + 1;
  const wouldEmptyWindow = siblings.length === 1 && !openedForLink;
  let win;
  try {
    if (wouldEmptyWindow) throw new Error('keep the window');
    // Moving the tab keeps it loading instead of starting over. If the tab was
    // alone in a window Helium just opened for it, that window closes itself.
    win = await chrome.windows.create({ tabId: tab.id, type: 'popup', focused: true, ...bounds });
  } catch {
    win = await chrome.windows.create({ url, type: 'popup', focused: true, ...bounds });
    if (wouldEmptyWindow) chrome.tabs.update(tab.id, { url: 'chrome://newtab/' }).catch(() => {});
    else chrome.tabs.remove(tab.id).catch(() => {});
  }
  await registerLittle(win);
}

async function useTabInstead(windowId) {
  const { fullscreenMode } = await getSettings();
  if (fullscreenMode !== 'tab') return false;
  const win = await chrome.windows.get(windowId).catch(() => null);
  return win?.type === 'normal' && win.state === 'fullscreen';
}

// ---------------------------------------------------------------------------
// Opening, popping out, promoting

async function registerLittle(win) {
  state.little.add(win.id);
  persist();
  for (const t of win.tabs ?? []) injectOverlay(t.id);
}

async function openLittle(url = START_PAGE, source) {
  const incognito = source?.incognito ?? false;
  const anchor = source?.windowId ?? (await chrome.windows.getLastFocused().catch(() => null))?.id;
  if (anchor !== undefined && await useTabInstead(anchor)) {
    // Opener set so closing the tab returns to the one you came from.
    return chrome.tabs.create({
      windowId: anchor,
      url: url === START_PAGE ? undefined : url,
      index: source?.index !== undefined ? source.index + 1 : undefined,
      openerTabId: source?.id,
    });
  }

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
        if (isWebUrl(msg.url)) await openLittle(msg.url, sender.tab);
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
    openLittle(START_PAGE, tab);
  } else if (command === 'promote-little-window') {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active) promote(active.id);
  } else if (command === 'pop-out-tab') {
    popOut(tab);
  }
});

chrome.action.onClicked.addListener((tab) => openLittle(START_PAGE, tab));

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await ready;
  if (info.menuItemId === 'open-link') openLittle(info.linkUrl, tab);
  else if (info.menuItemId === 'pop-out') popOut(tab);
  else if (info.menuItemId === 'settings') chrome.runtime.openOptionsPage();
});

// Handy from the service worker's DevTools console.
globalThis.littleHelium = { state, openLittle, popOut, promote, littleBounds };
