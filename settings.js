export const DEFAULTS = {
  catchExternal: true,   // route links opened from other apps into Little windows
  showOverlay: true,     // floating "Open in Helium" pill inside Little windows
  clickModifier: 'alt',  // 'alt' | 'shift' | 'alt-shift' | 'off' — modifier-click links into a Little window
  position: 'center',    // 'center' | 'top-right'
  sizePercent: 67,       // share of the screen's area the Little window covers
};

export async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}
