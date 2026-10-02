import { DEFAULTS, getSettings } from './settings.js';

const status = document.getElementById('status');
let statusTimer;

const settings = await getSettings();
for (const [key, value] of Object.entries(settings)) {
  const el = document.querySelector(`[name="${key}"]`);
  if (!el) continue;
  if (el.type === 'checkbox') el.checked = value;
  else el.value = value;
}

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (!(el.name in DEFAULTS)) return;
  let value = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'number') {
    value = Math.min(Number(el.max), Math.max(Number(el.min), Number(value) || DEFAULTS[el.name]));
    el.value = value;
  }
  await chrome.storage.sync.set({ [el.name]: value });
  status.textContent = 'Saved';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { status.textContent = ''; }, 1500);
});

document.getElementById('shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

const helperStatus = document.getElementById('helper-status');
chrome.runtime.sendNativeMessage('com.cmdurham.little_helium', { type: 'ping' })
  .then(() => {
    helperStatus.textContent = 'Helper installed. Links from other apps open on the display of the app you clicked them in.';
  })
  .catch(() => {
    helperStatus.textContent = 'Helper not installed, so links open on the display of your last Helium window. To install it, run ./install-helper.sh in the extension folder, then reload the extension.';
  });

const list = document.getElementById('commands');
for (const cmd of await chrome.commands.getAll()) {
  if (!cmd.description) continue;
  const li = document.createElement('li');
  const label = document.createElement('span');
  label.textContent = cmd.description;
  const key = document.createElement('kbd');
  key.textContent = cmd.shortcut || 'Not set';
  li.append(label, key);
  list.append(li);
}
