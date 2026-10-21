/*
 * Web mirror entry (Termilab served from the desktop app over tailscale serve).
 * window.electronAPI is already there: ./termilab-preload.js, a classic script
 * in index.html, runs electron/preload.js against a WebSocket before this
 * module. src/ is the desktop renderer, unchanged; it is imported dynamically
 * so nothing in it is evaluated before the check below.
 */
document.documentElement.dataset.platform = 'web';

if (!window.electronAPI) {
  document.getElementById('root').textContent = 'Termilab could not start: the connection script did not load.';
} else {
  import('../src/main.jsx');
}
