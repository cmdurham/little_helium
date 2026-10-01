// Modifier-click a link (Option-click by default) to open it in a Little window.
// Also records when the page was last shown or hidden, which the service worker
// reads to tell whether you were in Helium when a link from another app arrived.
(() => {
  const noteVisibility = () => {
    globalThis.__littleHeliumVisibility = { state: document.visibilityState, since: Date.now() };
  };
  noteVisibility();
  document.addEventListener('visibilitychange', noteVisibility);

  let modifier = 'alt';
  chrome.storage.sync.get('clickModifier').then(({ clickModifier }) => {
    if (clickModifier) modifier = clickModifier;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.clickModifier) modifier = changes.clickModifier.newValue;
  });

  const matches = (e) => {
    if (e.metaKey || e.ctrlKey) return false;
    switch (modifier) {
      case 'alt': return e.altKey && !e.shiftKey;
      case 'shift': return e.shiftKey && !e.altKey;
      case 'alt-shift': return e.altKey && e.shiftKey;
      default: return false;
    }
  };

  window.addEventListener('click', (e) => {
    if (e.button !== 0 || !matches(e)) return;
    // Extension was reloaded/removed since this page loaded — leave the click alone.
    if (!chrome.runtime?.id) return;
    const link = e.composedPath().find((el) => el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement);
    if (!link || !/^https?:/i.test(link.href)) return;

    // Cancels the default action too (Option-click would otherwise download the link).
    e.preventDefault();
    e.stopImmediatePropagation();
    chrome.runtime.sendMessage({ type: 'open-little', url: link.href }).catch(() => {});
  }, true);
})();
