export const DEFAULTS = {
  catchExternal: true,   // route links opened from other apps into Little windows
  showOverlay: true,     // floating "Open in Helium" pill inside Little windows
  clickModifier: 'alt',  // 'alt' | 'shift' | 'alt-shift' | 'off' — modifier-click links into a Little window
  position: 'center',    // 'center' | 'top-right'
  width: 960,
  height: 680,
};

export async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}
