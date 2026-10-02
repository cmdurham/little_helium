// Injected into pages shown in a Little window (after little-page.js): a small
// floating bar in the top-right corner with "Open in Helium", copy link and hide.
(() => {
  if (window.top !== window || window.__littleHelium) return;
  window.__littleHelium = true;

  const isMac = /Mac/.test(navigator.platform);
  const mod = isMac ? '⌘' : 'Ctrl+';
  const send = (type) => chrome.runtime.sendMessage({ type }).catch(() => {});
  const copyLink = () => window.__littleHeliumCopyLink?.();

  const host = document.createElement('little-helium-bar');
  host.style.cssText = 'all:initial;position:fixed;inset:0 0 auto 0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { display: flex; justify-content: flex-end; padding: 10px 12px 0 0; }
      .bar {
        pointer-events: auto;
        display: flex; align-items: center; gap: 2px;
        padding: 4px;
        font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        color: #f4f4f5;
        background: rgba(24, 24, 27, 0.78);
        backdrop-filter: blur(18px) saturate(1.6);
        -webkit-backdrop-filter: blur(18px) saturate(1.6);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
        transition: opacity .25s ease, transform .25s ease;
      }
      .bar.hidden { opacity: 0; transform: translateY(-14px); pointer-events: none; }
      .host {
        padding: 0 8px 0 6px; max-width: 220px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: rgba(244, 244, 245, 0.7);
        display: flex; align-items: center; gap: 6px;
      }
      .host img { width: 14px; height: 14px; border-radius: 3px; }
      button {
        all: unset; cursor: default;
        display: flex; align-items: center; gap: 6px;
        height: 26px; padding: 0 9px; border-radius: 8px;
        color: inherit;
      }
      button:hover { background: rgba(255, 255, 255, 0.12); }
      button:active { background: rgba(255, 255, 255, 0.18); }
      button.primary { background: rgba(255, 255, 255, 0.14); }
      button.primary:hover { background: rgba(255, 255, 255, 0.22); }
      button.icon { padding: 0 7px; }
      kbd { font: inherit; opacity: .55; }
      svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
      .sep { width: 1px; height: 16px; background: rgba(255, 255, 255, 0.14); margin: 0 2px; }
      @media (prefers-color-scheme: light) {
        .bar { color: #18181b; background: rgba(250, 250, 250, 0.82); border-color: rgba(0, 0, 0, 0.1); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.14); }
        .host { color: rgba(24, 24, 27, 0.6); }
        button:hover { background: rgba(0, 0, 0, 0.07); }
        button:active { background: rgba(0, 0, 0, 0.12); }
        button.primary { background: rgba(0, 0, 0, 0.07); }
        button.primary:hover { background: rgba(0, 0, 0, 0.12); }
        .sep { background: rgba(0, 0, 0, 0.12); }
      }
    </style>
    <div class="wrap">
      <div class="bar" role="toolbar" aria-label="Little window">
        <span class="host"><img alt=""><span class="name"></span></span>
        <button class="primary" data-act="promote" title="Open in a main Helium window">
          <svg viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 10v2.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1H6"/></svg>
          Open in Helium <kbd>${mod}O</kbd>
        </button>
        <button class="icon" data-act="copy" title="Copy link (${mod}${isMac ? '⇧' : 'Shift+'}C)">
          <svg viewBox="0 0 16 16"><path d="M6.5 9.5 9.5 6.5M7 4.5l1.2-1.2a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.2 1.2a2.5 2.5 0 0 1-3.5-3.5L5.5 8"/></svg>
        </button>
        <span class="sep"></span>
        <button class="icon" data-act="hide" title="Hide this bar (${mod}O still opens in Helium)">
          <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
    </div>`;

  const bar = root.querySelector('.bar');
  const name = root.querySelector('.name');
  const favicon = root.querySelector('.host img');
  const copyBtn = root.querySelector('[data-act="copy"]');

  const refreshHost = () => {
    name.textContent = location.hostname.replace(/^www\./, '') || location.href;
    const icon = document.querySelector('link[rel~="icon"]')?.href;
    favicon.style.display = '';
    favicon.src = icon || `${location.origin}/favicon.ico`;
  };
  favicon.onerror = () => { favicon.style.display = 'none'; };
  refreshHost();

  // little-page.js does the copying (button or ⌘⇧C); show a check mark here.
  window.addEventListener('little-helium:copied', () => {
    const original = copyBtn.innerHTML;
    copyBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>';
    setTimeout(() => { copyBtn.innerHTML = original; }, 1200);
    show();
  });

  root.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'copy') copyLink();
    else if (act === 'hide') hideBar();
    else if (act) send(act);
  });

  // Auto-hide: visible on load, then only while the pointer is near the top.
  let hideTimer;
  const show = () => {
    bar.classList.remove('hidden');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!bar.matches(':hover')) bar.classList.add('hidden');
    }, 2200);
  };
  bar.addEventListener('mouseleave', show);
  const revealNearTop = (e) => { if (e.clientY < 56) show(); };
  document.addEventListener('mousemove', revealNearTop, { passive: true });
  show();

  // ✕ dismisses the bar for this Little window (the background stops
  // re-injecting it); the window itself stays open.
  function hideBar() {
    document.removeEventListener('mousemove', revealNearTop);
    clearTimeout(hideTimer);
    host.remove();
    send('hide-bar');
  }

  // SPA navigations change the URL without reloading the page.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      refreshHost();
    }
  }, 1000);

  (document.body ?? document.documentElement).appendChild(host);
})();
