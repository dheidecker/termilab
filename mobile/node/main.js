/**
 * Termilab's Node side on Android (nodejs-mobile, via the vendored
 * Capacitor-NodeJS bridge). It runs the REAL electron/ipc-handlers.js and
 * services, unchanged, behind the `electron` shim in ./electron-shim.js.
 *
 * Bundled by scripts/build-mobile-node.js into dist-mobile/nodejs/index.js.
 *
 * Wire protocol on the bridge's event channel (all payloads JSON):
 *   web -> node  'bridge:hello'  {session}              every 250 ms until answered
 *   node -> web  'bridge:ready'  {session, ok, error?, version, platform}
 *   web -> node  'ipc:invoke'    {id, channel, args}    ipcRenderer.invoke
 *   node -> web  'ipc:reply'     {id, result} | {id, error}
 *   web -> node  'ipc:send'      {channel, args}        ipcRenderer.send
 *   node -> web  'ipc:event'     {channel, args}        webContents.send
 *   node -> web  'native:open-url' {url}                shell.openExternal
 *   node -> web  'native:sessions' {count, signingIn}   open SSH sessions / sync
 *                                                       login in flight changed
 *                                                       (the page drives the
 *                                                       foreground service)
 *
 * Why the handshake: the plugin drops a message whose listener is not
 * registered yet, in both directions (spike finding #2). Node queues what it
 * sends until the page has said hello; the page queues invokes until it gets
 * 'bridge:ready'.
 */

// The bridge first, and our listeners on it in this same tick: the plugin
// signals "ready" to the page as soon as the bridge module loads.
const bridge = require('bridge');
const { channel } = bridge;

// Read the device key and take it out of the environment before loading
// anything else: nothing in the graph may see it in process.env.
const DSK = process.env.TERMILAB_DSK || '';
delete process.env.TERMILAB_DSK;

const VERSION = typeof __TERMILAB_VERSION__ !== 'undefined' ? __TERMILAB_VERSION__ : '0.0.0-dev';
const OUTBOX_MAX = 5000;
const DATA_BATCH_MS = 8;

let webSession = null;     // set by the first hello
let boot = { ok: false, error: 'still starting' };
const outbox = [];

function post(eventName, payload) {
  if (webSession === null) {
    if (outbox.length >= OUTBOX_MAX) outbox.shift();
    outbox.push([eventName, payload]);
    return;
  }
  try {
    channel.send(eventName, payload);
  } catch (err) {
    console.error(`[mobile] bridge send failed (${eventName}):`, err.message);
  }
}

// ─── ssh:data batching ─────────────────────────────────────
// ssh2 hands over many small chunks; one bridge message per chunk means one
// JSON round through Java per chunk. ~8 ms per session is invisible to typing
// and collapses `cat bigfile` into a few hundred messages. Any other event
// flushes first, so ssh:close can never overtake the last output.

const pendingData = new Map();   // sessionId -> string
let dataTimer = null;

function flushData() {
  if (dataTimer) { clearTimeout(dataTimer); dataTimer = null; }
  for (const [sessionId, data] of pendingData) post('ipc:event', { channel: 'ssh:data', args: [sessionId, data] });
  pendingData.clear();
}

function postEvent(eventChannel, ...args) {
  if (eventChannel === 'ssh:data' && typeof args[1] === 'string') {
    pendingData.set(args[0], (pendingData.get(args[0]) || '') + args[1]);
    if (!dataTimer) dataTimer = setTimeout(flushData, DATA_BATCH_MS);
    return;
  }
  if (pendingData.size) flushData();
  post('ipc:event', { channel: eventChannel, args });
  // ssh-service sends ssh:close/ssh:error and only then drops the session.
  if (eventChannel === 'ssh:close' || eventChannel === 'ssh:error') setImmediate(reportSessions);
}

// ─── Open sessions -> foreground service ───────────────────
// Counted from ssh-service's own map, the only place that knows when a session
// really ends (remote exit, network drop, disconnect). The page turns the count
// into TermilabNative.setSessionCount; Node cannot reach Java directly.
//
// A sync login in flight needs it too: the Custom Tab puts Termilab in the
// background, Android 15+ cuts the network of a cached process ("network
// access blocked" in resolv), and the /auth/poll loop dies with "fetch failed".

let sshService = null;
let loginsInFlight = 0;
let lastSessions = null;

function reportSessions(force = false) {
  const count = sshService ? sshService.sessions.size : 0;
  const signingIn = loginsInFlight > 0;
  const key = `${count}/${signingIn}`;
  if (!force && key === lastSessions) return;
  lastSessions = key;
  post('native:sessions', { count, signingIn });
}

// ─── Inbound ───────────────────────────────────────────────

let shim = null;

channel.addListener('bridge:hello', (msg) => {
  const session = msg && msg.session != null ? String(msg.session) : 'unknown';
  const first = webSession === null;
  webSession = session;
  try {
    channel.send('bridge:ready', { session, ok: boot.ok, error: boot.error || null, version: VERSION, platform: process.platform });
  } catch (err) {
    console.error('[mobile] could not answer hello:', err.message);
  }
  if (first) {
    const queued = outbox.splice(0);
    for (const [eventName, payload] of queued) post(eventName, payload);
  }
  // A recreated page starts at zero: tell it what is still open.
  if (shim && !first) reportSessions(true);
});

channel.addListener('ipc:invoke', async (msg) => {
  const id = msg && msg.id;
  if (id == null) return;
  if (!shim) return post('ipc:reply', { id, error: `Node side failed to start: ${boot.error}` });
  try {
    const result = await shim.invoke(msg.channel, msg.args);
    post('ipc:reply', { id, result: result === undefined ? null : result });
  } catch (err) {
    post('ipc:reply', { id, error: (err && err.message) || String(err) });
  }
});

channel.addListener('ipc:send', (msg) => {
  if (shim && msg && typeof msg.channel === 'string') shim.send(msg.channel, msg.args);
});

// ─── Boot ──────────────────────────────────────────────────

function deviceName() {
  return (process.env.TERMILAB_DEVICE_NAME || process.env.TERMILAB_DEVICE_MODEL || 'Android').trim() || 'Android';
}

function start() {
  const electron = require('./electron-shim');
  electron.__mobile.configure({
    dataPath: bridge.getDataPath(),
    postEvent,
    openUrl: (url) => { if (pendingData.size) flushData(); post('native:open-url', { url }); },
    dsk: DSK,
    deviceName: deviceName(),
    version: VERSION,
  });
  shim = electron.__mobile;

  // After configure(): store-service resolves its data dir when it is loaded.
  const { registerIpcHandlers } = require('../../electron/ipc-handlers');
  registerIpcHandlers(shim.mainWindow);

  sshService = require('../../electron/services/ssh-service');
  for (const ch of ['ssh:connect', 'ssh:disconnect']) {
    const original = shim.handlers.get(ch);
    shim.handlers.set(ch, async (...a) => {
      try { return await original(...a); } finally { reportSessions(); }
    });
  }
  const login = shim.handlers.get('sync:login');
  shim.handlers.set('sync:login', async (...a) => {
    loginsInFlight++;
    reportSessions();   // before openExternal: the service starts while we are still in front
    try { return await login(...a); } finally { loginsInFlight--; reportSessions(); }
  });

  // What electron/main.js registers itself. The Android updater is phase 5;
  // until then these answer like desktop's dev-mode stubs.
  const { ipcMain } = electron;
  ipcMain.handle('updater:version', () => VERSION);
  ipcMain.handle('updater:check', async () => ({ success: false, error: 'Updates are not available on Android yet' }));
  ipcMain.handle('updater:download', async () => ({ success: false, error: 'Updates are not available on Android yet' }));
  ipcMain.handle('updater:install', () => {});

  // Back in the foreground: what desktop does on browser-window-focus.
  const syncService = require('../../electron/services/sync-service');
  bridge.onResume(() => syncService.onFocus());
}

try {
  start();
  boot = { ok: true };
} catch (err) {
  boot = { ok: false, error: (err && err.message) || String(err) };
  console.error('[mobile] Node side failed to start:', err && err.stack ? err.stack : err);
}

process.on('uncaughtException', (error) => {
  console.error('[mobile] Uncaught exception:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[mobile] Unhandled rejection:', reason);
});
