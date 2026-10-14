/*
 * App windows never navigate away from the app. A file dropped where the
 * renderer did not take it (src/utils/fileDropGuard.js is the first line),
 * a stray link or a compromised page would otherwise replace the UI with a
 * file:// page that still has the preload bridge. will-navigate is denied
 * for anything but the app's own page; window.open only ever hands
 * http(s)/mailto to the OS browser, never file:// or anything else.
 */
const { URL } = require('url');

/** Same document as the app (ignores the hash), e.g. the dev server or dist/index.html. */
function isAppUrl(target, appUrl) {
  try {
    const a = new URL(target);
    const b = new URL(appUrl);
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
  } catch (_) {
    return false;
  }
}

const EXTERNAL = new Set(['http:', 'https:', 'mailto:']);
function isExternalOk(target) {
  try { return EXTERNAL.has(new URL(target).protocol); } catch (_) { return false; }
}

function guardNavigation(win, { openExternal } = {}) {
  const wc = win.webContents;
  wc.on('will-navigate', (event, url) => {
    const current = wc.getURL();
    if (current && isAppUrl(url, current)) return;
    event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isExternalOk(url)) {
      const open = openExternal || require('electron').shell.openExternal;
      Promise.resolve().then(() => open(url)).catch(() => {});
    }
    return { action: 'deny' };
  });
}

module.exports = { guardNavigation, isAppUrl, isExternalOk };
