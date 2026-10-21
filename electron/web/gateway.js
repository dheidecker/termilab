/**
 * The web mirror's IPC gateway: one WebSocket = one "window".
 *
 * Each socket gets a virtual webContents (an EventEmitter with a unique
 * numeric `id`, `send()`, `isDestroyed()`, and a 'destroyed' event when the
 * socket goes). Calls from the browser reach the SAME handler functions the
 * desktop windows reach (recorded by ipc-tap.js), with an event whose
 * `sender` is that virtual webContents, so ipc-handlers, the services and the
 * window registry treat it as one more window. Pushes the registry sends to it
 * go back down the socket.
 *
 * Two walls, both here and nowhere else:
 *  - WEB_CHANNELS, an allow-list. Anything not in it is refused, whatever the
 *    browser asks. Kept out on purpose: sync:*, saves and deletes in the store,
 *    backups, keys material, clipboard:*, dialog:*, sftp:*, port-forward:*,
 *    local-fs:*, paths:*, cli:*, updater actions, window moves and window
 *    chrome, and any web:* channel but web:peers (the PC switcher's list).
 *  - SECRET_FIELDS, stripped (at any depth) from everything that goes down
 *    the socket: replies and pushes. store:get-hosts returns passwords and
 *    passphrases to the desktop renderer; the browser never sees them.
 *
 * Wire format (JSON text frames; binary values travel as {"$b": base64}):
 *   browser -> main  {t:'invoke', id, ch, args}   {t:'send', ch, args}
 *   main -> browser  {t:'res', id, ok:true, v}     {t:'res', id, ok:false, e}
 *                    {t:'ev', ch, args}
 * `v` is the handler's return value as is (wrapHandler's {success, data}
 * envelope included): electron/preload.js, served to the browser unchanged,
 * unwraps it exactly as it does on the desktop.
 */
const { EventEmitter } = require('events');

/**
 * Channels the browser may call (ipcRenderer.invoke and ipcRenderer.send).
 *
 * The browser is a MIRROR (F3, electron/web/mirror.js): it never owns a
 * session. It does not open, close or end any (ssh:connect/disconnect,
 * local:spawn/kill, keeper end/kill are out): it joins the PC's sessions as a
 * viewer (session:*), types and resizes in them, and asks the PC window to
 * open, close, rename… (mirror:command), which does it the normal way.
 * Not here either: mirror:report (only a PC window reports its tabs) and
 * web:clients / web:kick (the PC's list of browsers).
 */
const WEB_CHANNELS = new Set([
  // SSH terminals (input and size of the sessions it joined)
  'ssh:send-data', 'ssh:resize', 'ssh:host-key-response',
  'ssh:keeper-foreground', 'ssh:keeper-list',
  // Local terminals
  'local:write', 'local:resize',
  'local:keeper-foreground', 'local:keeper-list',
  // Viewer of the PC's sessions (window-registry.js)
  'session:join', 'session:leave', 'session:snapshot',
  // The PC window's tabs, and orders for it
  'mirror:state', 'mirror:command', 'mirror:select',
  // Hosts, groups, snippets, settings: read. Keys and stored forwards are read
  // too (AppContext loads them with everything else, all or nothing); keys come
  // without any private material, forwards cannot be started from here.
  'store:get-hosts', 'store:get-groups', 'store:get-snippets', 'store:get-keys',
  'store:get-port-forwards', 'app:get-settings',
  // The one write: the OS a connection detected (AppContext does it by itself)
  'store:set-host-os',
  // Sessions panel and Background
  'window:info', 'window:list', 'window:attention',
  'window:agents-report', 'window:agents', 'window:focus-agent', 'window:session-action',
  'window:background-sessions', 'window:background-forget', 'window:background-rename',
  // Workspace and tabs
  'window:workspace-take', 'window:workspace-report', 'window:workspace-restored',
  // AI agents and their approvals
  'agent:status', 'agent:logs', 'agent:approval-response',
  // Images into a terminal (bytes only, never a path on this PC: see INBOUND)
  'attach:save-local', 'attach:upload',
  // Read-only odds and ends
  'updater:version', 'system:info',
  // The PC switcher: the ONLY web:* allowed (enable/disable/set-name stay out)
  'web:peers',
]);

/** Pushes never forwarded to a browser, even when the registry broadcasts them. */
const BLOCKED_EVENT_PREFIXES = ['sync:', 'web:', 'clipboard:', 'dialog:'];

/**
 * Field names removed from every value sent to a browser, at any depth.
 * Compared lowercased. Explicit on purpose: a pattern would either miss one or
 * eat a harmless field (`hasPrivateKey` must survive, the UI shows it).
 */
const SECRET_FIELDS = new Set([
  'password', 'passwords', 'passphrase', 'keypassphrase',
  'privatekey', 'privatekeycontent', 'privatekeypath',
  'keys', 'masterkey', 'secret', 'secrets', 'clientsecret', 'apikey',
  'token', 'tokens', 'accesstoken', 'refreshtoken', 'devicetoken', 'synctoken', 'idtoken',
].map(s => s.toLowerCase()));

const MAX_DEPTH = 64;
const MAX_ARGS = 16;
const BASE_WC_ID = 1000000;   // far above BrowserWindow / webContents ids

const isBinary = (v) => Buffer.isBuffer(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer;

/**
 * A copy of `value` fit for the browser: secrets dropped, binaries as {$b},
 * functions and cycles gone, Dates as ISO strings, Errors as {message}.
 */
function toWire(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value === undefined ? undefined : null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (t === 'bigint') return String(value);
  if (t === 'function' || t === 'symbol') return undefined;
  if (depth > MAX_DEPTH) return null;
  if (isBinary(value)) {
    const buf = Buffer.isBuffer(value) ? value
      : value instanceof ArrayBuffer ? Buffer.from(value)
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return { $b: buf.toString('base64') };
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return { message: String(value.message || '') };
  if (seen.has(value)) return null;
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map(v => { const w = toWire(v, depth + 1, seen); return w === undefined ? null : w; });
  } else if (value instanceof Map || value instanceof Set) {
    out = [...value].map(v => toWire(v, depth + 1, seen));
  } else {
    out = {};
    for (const key of Object.keys(value)) {
      if (SECRET_FIELDS.has(key.toLowerCase())) continue;
      const w = toWire(value[key], depth + 1, seen);
      if (w !== undefined) out[key] = w;
    }
  }
  seen.delete(value);
  return out;
}

/** Browser values back to Node: {$b} -> Buffer. Everything else is plain JSON already. */
function fromWire(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map(v => fromWire(v, depth + 1));
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$b' && typeof value.$b === 'string') return Buffer.from(value.$b, 'base64');
  const out = {};
  for (const k of keys) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = fromWire(value[k], depth + 1);
  }
  return out;
}

/* Per-channel argument rules for what comes FROM the browser. */
function attachItemsOnlyBytes(items) {
  if (!Array.isArray(items)) throw new Error('Invalid items');
  for (const it of items) {
    if (!it || typeof it !== 'object' || it.path != null || !Buffer.isBuffer(it.data)) {
      throw new Error('Only file contents can be sent from the web');
    }
  }
}

/**
 * @param {object} deps
 * @param {object} [deps.tap]        ipc-tap (default: the module); needs invoke() and emit()
 * @param {(hostId: string) => Promise<object|null>} [deps.getHost]
 *        a saved host WITH its secrets, read in main. Lets ssh:connect from the
 *        browser (which never has the password) use the saved credentials.
 * @param {(wc) => void} [deps.onConnect]     a virtual webContents was born
 * @param {(wc) => void} [deps.onDisconnect]  …and is gone (after 'destroyed')
 * @param {Set<string>} [deps.channels]  allow-list (default WEB_CHANNELS)
 */
function createGateway(deps = {}) {
  const tap = deps.tap || require('./ipc-tap');
  const channels = deps.channels || WEB_CHANNELS;
  const getHost = deps.getHost || null;
  const live = new Map();   // wc -> ws
  let seq = 0;

  const INBOUND = {
    'ssh:connect': async ([config, ...rest]) => {
      if (!config || typeof config !== 'object') throw new Error('Invalid connection');
      const cfg = { ...config };
      // A path on this PC is never the browser's to name.
      delete cfg.privateKeyPath;
      if (getHost && typeof cfg.hostId === 'string' && !cfg.password && !cfg.keyId && !cfg.privateKey) {
        const host = await getHost(cfg.hostId);
        if (host) {
          if (host.authType === 'password' && host.password) cfg.password = host.password;
          if (host.authType === 'key' && host.keyId) cfg.keyId = host.keyId;
          if (host.authType === 'key' && host.privateKey) cfg.privateKey = host.privateKey;
          if (host.passphrase && !cfg.passphrase) cfg.passphrase = host.passphrase;
        }
      }
      return [cfg, ...rest];
    },
    'attach:save-local': async (args) => { attachItemsOnlyBytes(args[0]); return args; },
    'attach:upload': async (args) => { attachItemsOnlyBytes(args[2]); return args; },
  };

  function makeWebContents(ws, meta) {
    const wc = new EventEmitter();
    let destroyed = false;
    wc.id = BASE_WC_ID + (++seq);
    wc.isWeb = true;
    wc.login = meta.login || null;
    wc.userAgent = typeof meta.userAgent === 'string' ? meta.userAgent.slice(0, 300) : null;
    wc.connectedAt = Date.now();
    /* web:kick: the PC closes this browser's socket */
    wc.disconnect = (code = 4001, reason = 'disconnected from the PC') => {
      try { ws.close(code, reason); } catch (_) { /* gone */ }
      try { ws.socket.end(); } catch (_) { /* gone */ }
    };
    wc.getType = () => 'web';
    wc.isDestroyed = () => destroyed;
    wc.isLoading = () => false;
    wc.getURL = () => 'termilab-web://mirror';
    wc.send = (channel, ...args) => {
      if (destroyed || typeof channel !== 'string') return;
      if (BLOCKED_EVENT_PREFIXES.some(p => channel.startsWith(p))) return;
      let frame;
      try { frame = JSON.stringify({ t: 'ev', ch: channel, args: toWire(args) }); } catch (err) {
        console.error(`[web] could not encode ${channel}:`, err.message);
        return;
      }
      ws.send(frame);
    };
    wc._destroy = () => {
      if (destroyed) return;
      destroyed = true;
      wc.emit('destroyed');
    };
    return wc;
  }

  function reply(ws, id, ok, payload) {
    if (ws.readyState !== 'open') return;
    const msg = ok ? { t: 'res', id, ok: true, v: toWire(payload) } : { t: 'res', id, ok: false, e: String(payload || 'Error') };
    if (msg.v === undefined) delete msg.v;
    try { ws.send(JSON.stringify(msg)); } catch (err) {
      ws.send(JSON.stringify({ t: 'res', id, ok: false, e: 'Reply could not be encoded' }));
    }
  }

  async function onMessage(ws, wc, data, isBinaryFrame) {
    if (isBinaryFrame) { ws.fail(1003, 'text only'); return; }
    let msg;
    try { msg = JSON.parse(data); } catch (_) { ws.fail(1007, 'bad json'); return; }
    if (!msg || typeof msg !== 'object' || typeof msg.ch !== 'string') { ws.fail(1008, 'bad message'); return; }
    const { t, ch } = msg;
    const id = msg.id;
    if (t === 'invoke' && !(Number.isSafeInteger(id) || typeof id === 'string')) { ws.fail(1008, 'bad id'); return; }
    let args = Array.isArray(msg.args) ? msg.args : [];
    if (args.length > MAX_ARGS) args = args.slice(0, MAX_ARGS);

    if (!channels.has(ch)) {
      console.warn(`[web] refused ${t} ${ch.slice(0, 80)}`);
      if (t === 'invoke') reply(ws, id, false, 'Not available from the web');
      return;
    }
    const event = { sender: wc, senderFrame: null, web: true };
    try {
      args = fromWire(args);
      if (INBOUND[ch]) args = await INBOUND[ch](args);
    } catch (err) {
      if (t === 'invoke') reply(ws, id, false, err.message);
      return;
    }
    if (t === 'send') { tap.emit(ch, event, args); return; }
    if (t !== 'invoke') return;
    try {
      const result = await tap.invoke(ch, event, args);
      reply(ws, id, true, result);
    } catch (err) {
      reply(ws, id, false, err && err.message);
    }
  }

  /** Takes an accepted ws-lite socket; returns its virtual webContents. */
  function attach(ws, meta = {}) {
    const wc = makeWebContents(ws, meta);
    live.set(wc, ws);
    ws.on('message', (data, bin) => {
      onMessage(ws, wc, data, bin).catch(err => console.error('[web] message failed:', err.message));
    });
    ws.on('close', () => {
      live.delete(wc);
      wc._destroy();
      if (deps.onDisconnect) { try { deps.onDisconnect(wc); } catch (err) { console.error('[web] onDisconnect:', err.message); } }
    });
    if (deps.onConnect) { try { deps.onConnect(wc); } catch (err) { console.error('[web] onConnect:', err.message); } }
    return wc;
  }

  function closeAll(code = 1001, reason = 'server stopping') {
    for (const ws of [...live.values()]) { try { ws.close(code, reason); ws.socket.end(); } catch (_) { /* gone */ } }
  }

  return { attach, closeAll, connections: () => [...live.keys()] };
}

module.exports = { createGateway, toWire, fromWire, WEB_CHANNELS, SECRET_FIELDS, BLOCKED_EVENT_PREFIXES };
