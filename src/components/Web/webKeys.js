/*
 * Keyboard in the web mirror (a browser showing the PC's Termilab).
 *
 * The browser keeps Ctrl+W, Ctrl+T, Ctrl+N and Ctrl+Tab for itself (they
 * never reach the page), so the app's actions on them get Alt+Shift twins
 * there (WEB_SHORTCUTS, App.jsx). In full screen, navigator.keyboard.lock()
 * (Chromium only) hands those keys to the page: Ctrl+T / Ctrl+Tab work as on
 * the desktop again, and Ctrl+W reaches the shell (delete word) instead of
 * closing anything — in the browser Ctrl+W never closes an app tab.
 *
 * `electronAPI.platform` is the PC's OS (the preload runs against the PC's
 * main), not the browser's: anything that depends on the keyboard in front
 * of the user asks browserIsMac() instead. Desktop never imports this.
 */

/** The browser's own OS is macOS (Cmd is the modifier there). */
export function browserIsMac() {
  if (typeof navigator === 'undefined') return false;
  const uad = navigator.userAgentData && navigator.userAgentData.platform;
  if (uad) return /mac/i.test(uad);
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
}

/* code -> action, all with Alt+Shift and nothing else */
const ALT_SHIFT = {
  KeyT: 'newTab',
  KeyW: 'closeTab',
  PageDown: 'nextTab',
  BracketRight: 'nextTab',
  PageUp: 'prevTab',
  BracketLeft: 'prevTab',
};

/** For tooltips: the keys as the user's own keyboard labels them */
export function webShortcuts() {
  const alt = browserIsMac() ? '⌥' : 'Alt';
  return [
    [`${alt}+Shift+T`, 'New local terminal'],
    [`${alt}+Shift+W`, 'Close tab'],
    [`${alt}+Shift+] / PgDn`, 'Next tab'],
    [`${alt}+Shift+[ / PgUp`, 'Previous tab'],
  ];
}

/** The app action an Alt+Shift key stands for in the browser, or null */
export function webShortcutAction(e) {
  if (!e || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return null;
  return ALT_SHIFT[e.code] || null;
}

export const isWebAppShortcut = (e) => !!webShortcutAction(e);

// ─── Full screen + keyboard lock ─────────────────────────

const KEYS_TO_LOCK = ['KeyW', 'KeyT', 'KeyN', 'Tab', 'Escape'];

export const canFullscreen = () => typeof document !== 'undefined'
  && !!document.documentElement && typeof document.documentElement.requestFullscreen === 'function';

export const keyboardLockSupported = () => typeof navigator !== 'undefined'
  && !!navigator.keyboard && typeof navigator.keyboard.lock === 'function';

let locked = false;
/** Whether the browser's shortcuts are handed to the page right now */
export const keyboardLocked = () => locked && typeof document !== 'undefined' && !!document.fullscreenElement;

/* Escape is in the list: with it locked, Esc reaches the shell / vim, and
   leaving full screen is "hold Esc" (Chromium's rule for locked Esc). */
async function lock() {
  if (!keyboardLockSupported()) return false;
  try {
    await navigator.keyboard.lock(KEYS_TO_LOCK);
    locked = true;
  } catch (_) { locked = false; }
  return locked;
}

function unlock() {
  locked = false;
  try { if (keyboardLockSupported() && navigator.keyboard.unlock) navigator.keyboard.unlock(); } catch (_) { /* gone */ }
}

/** Toggle full screen; entering it also locks the keyboard where possible. */
export async function toggleFullscreen() {
  if (typeof document === 'undefined') return false;
  if (document.fullscreenElement) {
    unlock();
    try { await document.exitFullscreen(); } catch (_) { /* already out */ }
    return false;
  }
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch (_) { return false; }
  await lock();
  return true;
}

/* Leaving full screen any other way (Esc held, F11) drops the lock */
if (typeof document !== 'undefined') {
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) unlock(); });
}
