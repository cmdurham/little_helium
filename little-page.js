// Injected into every page (and frame) shown in a Little window, whether or
// not the floating bar is on:
// - links that would open a new tab (target=_blank, ⌘/⇧/middle-click) open in
//   this Little window instead of popping the main window to the front;
// - ⌘O opens the page in a main window, ⌘⇧C copies its link.
// ⌥-click is left alone: it opens another Little window (link-click.js).
(() => {
  if (window.__littleHeliumPage) return;
  window.__littleHeliumPage = true;

  const isMac = /Mac/.test(navigator.platform);
  const isTop = window.top === window;
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

  const opensNewTab = (e, link) => {
    const target = (link.getAttribute('target') || '').toLowerCase();
    const named = target && !['_self', '_top', '_parent'].includes(target);
    return named || e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1;
  };

  const handle = (e) => {
    if (e.defaultPrevented || e.altKey || (e.button !== 0 && e.button !== 1)) return;
    if (!chrome.runtime?.id) return;
    const link = e.composedPath().find((el) => el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement);
    if (!link || link.hasAttribute('download') || !/^https?:/i.test(link.href)) return;
    if (!opensNewTab(e, link)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // A frame can't navigate a cross-origin top page, so let the extension do it.
    if (isTop) location.href = link.href;
    else send({ type: 'navigate-little', url: link.href });
  };
  window.addEventListener('click', handle, true);
  window.addEventListener('auxclick', handle, true);

  if (!isTop) return;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = location.href;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.documentElement.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    window.dispatchEvent(new CustomEvent('little-helium:copied'));
  };
  window.__littleHeliumCopyLink = copyLink;

  window.addEventListener('keydown', (e) => {
    const primary = isMac ? e.metaKey : e.ctrlKey;
    if (!primary || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'o' && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      send({ type: 'promote' });
    } else if (key === 'c' && e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      copyLink();
    }
  }, true);
})();
