// Little Helium — Arc's "Little Arc" for Helium / Chromium.
//
// A Little window is a popup-type window (no tab strip, minimal chrome) that we
// track by id. Links arriving from other apps are caught and moved into one;
// "promote" moves the page into the most recently used main window.
//
// Full screen: while its active window is full screen, Helium forces every new
// window full screen too. Created minimized and then restored, a window instead
// floats over the full-screen window on its Space, like Little Arc. (A link from
// another app lands you on Helium's Space before we see it, so the same applies.)

import { DEFAULTS, getSettings } from './settings.js';

const START_PAGE = chrome.runtime.getURL('little.html');
const STARTUP_GRACE_MS = 5000;   // ignore startup pages right after launch
const NEW_WINDOW_MS = 3000;      // a window this young was opened just for the incoming link
const CASCADE_PX = 28;
const HELPER = 'com.cmdurham.little_helium'; // optional native helper (install-helper.sh)
const HELPER_TIMEOUT_MS = 600;

// ---------------------------------------------------------------------------
// State (mirrored to storage.session so it survives service-worker restarts)

const state = {
  little: new Set(),   // ids of Little windows
  mru: [],             // normal window ids, most recently focused first
  startupAt: 0,
  suppressUntil: 0,    // ignore tab creation we caused ourselves
  barHidden: new Set(), // Little windows whose floating bar the user dismissed
};

const ready = chrome.storage.session.get('state').then(({ state: saved }) => {
  if (!saved) return;
  state.little = new Set(saved.little);
  state.barHidden = new Set(saved.barHidden ?? []);
  state.mru = saved.mru ?? [];
  state.startupAt = saved.startupAt ?? 0;
  state.suppressUntil = saved.suppressUntil ?? 0;
});

function persist() {
  chrome.storage.session.set({ state: { ...state, little: [...state.little], barHidden: [...state.barHidden] } });
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
  state.barHidden.clear();
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
  state.barHidden.delete(windowId);
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
  catchTab(tab, url);
});

// ---------------------------------------------------------------------------
// Keeping links inside Little windows

// Add the page script as soon as each document (or frame) in a Little window
// or an installed web app commits, so new-tab links are caught early.
chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId }) => {
  await ready;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const mode = tab && await pageMode(tab);
  if (mode) injectPageScript({ tabId, frameIds: [frameId] }, mode);
});

// 'little' for Little windows, 'app' for installed web apps (PWAs), else null.
async function pageMode(tab) {
  if (state.little.has(tab.windowId)) return 'little';
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  return win?.type === 'app' ? 'app' : null;
}

async function injectPageScript(target, mode) {
  await chrome.scripting.executeScript({
    target, injectImmediately: true, args: [mode],
    func: (m) => { window.__littleHeliumMode = m; },
  }).catch(() => {});
  await chrome.scripting.executeScript({ target, injectImmediately: true, files: ['little-page.js'] })
    .catch(() => {});
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ready;
  if (changeInfo.url && strays.has(tabId)) {
    const opener = strays.get(tabId);
    strays.delete(tabId);
    if (isWebUrl(changeInfo.url)) bringBack(tab, opener, changeInfo.url);
  }
  if (changeInfo.status === 'complete' && state.little.has(tab.windowId)) injectLittle(tabId);
});

// Fallback for new tabs a Little window's or web app's page opens some other
// way (script window.open, forms): Chromium puts them in a main window and
// brings it to the front. From a Little window, load the URL there instead;
// from a web app, move the tab into a new Little window on the app's Space.
// Popup windows (sign-in flows that need window.opener) are left alone.
const strays = new Map(); // new tab id -> opener tab, while waiting for its URL

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId === undefined) return;
  await ready;
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
  if (!opener || state.little.has(tab.windowId)) return;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (win?.type !== 'normal') return;
  if (await pageMode(opener) === 'app') {
    const little = await createLittleWindow({ tabId: tab.id }, { anchorWindowId: opener.windowId });
    keepInFront(little.id);
    return;
  }
  if (!state.little.has(opener.windowId)) return;
  const url = tab.pendingUrl || tab.url;
  if (isWebUrl(url)) {
    bringBack(tab, opener, url);
  } else {
    strays.set(tab.id, opener);
    setTimeout(() => strays.delete(tab.id), 3000);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => strays.delete(tabId));

async function bringBack(tab, opener, url) {
  await chrome.tabs.update(opener.id, { url }).catch(() => {});
  await chrome.tabs.remove(tab.id).catch(() => {});
  keepInFront(opener.windowId);
}

// Helium may bring its main window forward just after a Little window opens
// (and macOS then switches you to the main window's Space). Re-focusing the
// Little window a few times as that settles takes you back to it; when you're
// already there, focusing it again does nothing visible.
const REFOCUS_AT_MS = [0, 350, 900, 1800];

function keepInFront(windowId) {
  let last = 0;
  for (const at of REFOCUS_AT_MS) {
    setTimeout(() => chrome.windows.update(windowId, { focused: true }).catch(() => {}), at);
    last = at;
  }
  return sleep(last);
}

async function catchTab(tab, url) {
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
  const context = { anchorWindowId: tab.windowId, display: await sourceDisplay() };
  try {
    if (wouldEmptyWindow) throw new Error('keep the window');
    // Moving the tab keeps it loading instead of starting over. If the tab was
    // alone in a window Helium just opened for it, that window closes itself.
    keepInFront((await createLittleWindow({ tabId: tab.id }, context)).id);
  } catch {
    keepInFront((await createLittleWindow({ url }, context)).id);
    if (wouldEmptyWindow) chrome.tabs.update(tab.id, { url: 'chrome://newtab/' }).catch(() => {});
    else chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Opening, popping out, promoting

async function registerLittle(win) {
  state.little.add(win.id);
  persist();
  for (const t of win.tabs ?? []) injectLittle(t.id);
}

async function openLittle(url = START_PAGE, source) {
  const anchorWindowId = source?.windowId ?? (await chrome.windows.getLastFocused().catch(() => null))?.id;
  const context = { anchorWindowId };
  // Incognito only works if the user allowed the extension there.
  return createLittleWindow({ url, incognito: source?.incognito ?? false }, context)
    .catch(() => createLittleWindow({ url }, context));
}

async function popOut(tab) {
  if (!tab || state.little.has(tab.windowId)) return;
  await createLittleWindow({ tabId: tab.id }, { anchorWindowId: tab.windowId });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The main window you're working in (or the one a Little window sits over).
async function mainWindowUnder(anchorWindowId) {
  let id = anchorWindowId;
  if (id === undefined || state.little.has(id)) id = state.mru[0];
  return id === undefined ? null : chrome.windows.get(id).catch(() => null);
}

// `display`: where to put the window (the source app's display, from the
// helper); otherwise the display of the window you last used.
async function createLittleWindow(opts, { anchorWindowId, display }) {
  const main = await mainWindowUnder(anchorWindowId);
  const displays = await chrome.system.display.getInfo().catch(() => []);
  const mainDisplay = main ? displayAt(displays, center(main)) : null;
  const target = display ?? mainDisplay;
  const bounds = await littleBounds(target);
  const overFullscreen = main?.state === 'fullscreen' && (!display || display.id === mainDisplay?.id);

  if (!overFullscreen) {
    const win = await chrome.windows.create({ ...opts, type: 'popup', focused: true, ...bounds });
    await registerLittle(win);
    // On another display, Helium may still force it full screen; undo that.
    if (win.state === 'fullscreen') await restoreToNormal(win.id, bounds);
    return win;
  }
  // See the note at the top: create it minimized, then restore it over full screen.
  const win = await chrome.windows.create({ ...opts, type: 'popup', state: 'minimized' });
  await registerLittle(win);
  await restoreToNormal(win.id, bounds);
  return win;
}

// A restore requested too early is ignored (measured ~0.7 s for a new minimized
// window). Wait, ask, and re-ask if needed.
const RESTORE_AFTER_MS = 900;

async function restoreToNormal(windowId, bounds) {
  await sleep(RESTORE_AFTER_MS);
  for (let attempt = 0; attempt < 4; attempt++) {
    const win = await chrome.windows.get(windowId).catch(() => null);
    if (!win) return;
    if (win.state === 'normal') {
      // Bounds only stick once the window is normal.
      await chrome.windows.update(windowId, { ...bounds, focused: true }).catch(() => {});
      return;
    }
    await chrome.windows.update(windowId, { state: 'normal', focused: true }).catch(() => {});
    await sleep(700);
  }
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

const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

function displayAt(displays, { x, y }) {
  return displays.find(({ bounds: b }) =>
    x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height) ?? null;
}

// Which display is the app a link came from on? Asks the optional native
// helper for the frontmost non-Helium window (or the cursor if there is none).
// Returns null when the helper isn't installed or doesn't answer in time.
async function sourceDisplay() {
  const reply = await Promise.race([
    chrome.runtime.sendNativeMessage(HELPER, { type: 'source-window' }).catch(() => null),
    sleep(HELPER_TIMEOUT_MS).then(() => null),
  ]);
  if (!reply) return null;
  const displays = await chrome.system.display.getInfo().catch(() => []);
  return displayAt(displays, reply.window ? center(reply.window) : reply.cursor);
}

async function littleBounds(display) {
  await ready;
  const { sizePercent, position } = await getSettings();
  let area = display?.workArea;
  if (!area) {
    try {
      const displays = await chrome.system.display.getInfo();
      const anchor = await chrome.windows.getLastFocused().catch(() => null);
      const containing = anchor ? displayAt(displays, center(anchor)) : null;
      area = (containing ?? displays.find((d) => d.isPrimary) ?? displays[0])?.workArea;
    } catch {
      // system.display unavailable — let the browser place the window.
    }
  }
  if (!area) return {};

  // sizePercent is a share of the screen's area, so scale both sides by its
  // square root to keep the screen's proportions.
  const margin = 24;
  const scale = Math.sqrt(Math.min(100, Math.max(20, sizePercent)) / 100);
  const w = Math.min(area.width * scale, area.width - margin * 2);
  const h = Math.min(area.height * scale, area.height - margin * 2);
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

// little-page.js always (links + shortcuts); the floating bar only if wanted.
// Both guard against running twice. Failures mean a restricted page
// (helium://, web store, PDF viewer…) or one that hasn't committed yet.
async function injectLittle(tabId) {
  await injectPageScript({ tabId, allFrames: true }, 'little');
  const { showOverlay } = await getSettings();
  if (!showOverlay) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || state.barHidden.has(tab.windowId)) return;
  chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ready;
    const tabId = msg.tabId ?? sender.tab?.id;
    switch (msg.type) {
      case 'open-little':
        if (isWebUrl(msg.url)) keepInFront((await openLittle(msg.url, sender.tab)).id);
        break;
      case 'promote':
        await promote(tabId);
        break;
      case 'navigate-little': {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab && state.little.has(tab.windowId) && isWebUrl(msg.url)) await chrome.tabs.update(tabId, { url: msg.url });
        break;
      }
      case 'hide-bar': {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab && state.little.has(tab.windowId)) {
          state.barHidden.add(tab.windowId);
          persist();
        }
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
globalThis.littleHelium = { state, openLittle, popOut, promote, littleBounds, sourceDisplay, displayAt };
