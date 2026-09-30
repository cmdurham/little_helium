const input = document.getElementById('q');
const form = document.getElementById('go');

// Show the user's actual shortcut (they may have rebound it).
chrome.commands.getAll().then((cmds) => {
  const key = cmds.find((c) => c.name === 'promote-little-window')?.shortcut;
  const el = document.getElementById('promote-key');
  if (key) el.textContent = key;
  else el.parentElement.remove();
});

function toUrl(text) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|view-source):/i.test(text)) return text;
  if (/\s/.test(text)) return null;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(text)) return `http://${text}`;
  if (/^[^./]+(\.[^./]+)+(:\d+)?(\/.*)?$/.test(text) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(text)) return `https://${text}`;
  return null;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  const tab = await chrome.tabs.getCurrent();
  const url = toUrl(text);
  if (url) {
    chrome.tabs.update(tab.id, { url });
    return;
  }
  try {
    // Uses the browser's default search engine.
    await chrome.search.query({ text, tabId: tab.id });
  } catch {
    chrome.tabs.update(tab.id, { url: `https://duckduckgo.com/?q=${encodeURIComponent(text)}` });
  }
});

document.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    const win = await chrome.windows.getCurrent();
    chrome.windows.remove(win.id);
  }
});
