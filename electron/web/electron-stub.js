/**
 * The browser's `require('electron')` for the web mirror.
 *
 * server.js serves /termilab-preload.js = this file + electron/preload.js
 * wrapped in a function whose `require` returns this stub. So the browser runs
 * the desktop preload as is (same API, same envelope unwrapping), over a
 * WebSocket instead of Electron IPC:
 *
 *   contextBridge.exposeInMainWorld(name, api) -> window[name] = api minus WEB_OMITTED
 *   ipcRenderer.invoke/send/on/removeListener/removeAllListeners -> /ws (gateway.js)
 *   webUtils -> null (preload's getPathForFile calls are already try/catch: null)
 *
 * WEB_OMITTED: namespaces that make no sense from a browser (or that the
 * gateway refuses wholesale). Absent rather than stubbed, like the Android
 * shim, so a desktop-only path fails loudly instead of pretending.
 *
 * Plain ES2018 script, no modules: it runs before the app bundle. Under Node
 * (scripts/check-web.js) it exports its pieces instead of installing itself.
 */
(function (root) {
  'use strict';

  var WEB_OMITTED = ['sftp', 'localFs', 'portForward', 'dialog', 'clipboard', 'claudeHistory', 'paths', 'cli', 'sync', 'knownHosts', 'logs', 'updater', 'lifecycle'];

  // ─── Binary values on the wire: {"$b": base64} ───────────

  function bytesToB64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return root.btoa(s);
  }
  function b64ToBytes(b64) {
    var s = root.atob(b64);
    var u8 = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }
  function encode(v, depth) {
    depth = depth || 0;
    if (v === null || typeof v !== 'object' || depth > 64) return v;
    if (v instanceof ArrayBuffer) return { $b: bytesToB64(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v)) return { $b: bytesToB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (Array.isArray(v)) return v.map(function (x) { return encode(x, depth + 1); });
    if (typeof v.toJSON === 'function') return v;
    var out = {};
    Object.keys(v).forEach(function (k) { out[k] = encode(v[k], depth + 1); });
    return out;
  }
  function decode(v, depth) {
    depth = depth || 0;
    if (v === null || typeof v !== 'object' || depth > 64) return v;
    if (Array.isArray(v)) return v.map(function (x) { return decode(x, depth + 1); });
    var keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$b' && typeof v.$b === 'string') return b64ToBytes(v.$b);
    var out = {};
    keys.forEach(function (k) { out[k] = decode(v[k], depth + 1); });
    return out;
  }

  // ─── ipcRenderer over a WebSocket ────────────────────────

  /**
   * @param {object} opts
   * @param {string} opts.url              ws(s)://…/ws
   * @param {Function} opts.WebSocket      constructor (the browser's)
   * @param {number} [opts.retryMs]
   */
  var HELD = {
    'agent:approval-prompt': true,
    'agent:approval-cancel': true,
    'ssh:host-key-prompt': true,
    'ssh:host-key-prompt-cancel': true,
  };
  var HELD_MAX = 50;

  function createIpcRenderer(opts) {
    var WS = opts.WebSocket;
    var pending = new Map();    // id -> {resolve, reject}
    var listeners = new Map();  // channel -> [fn(event, ...args)]
    var queue = [];             // frames waiting for the socket to open
    /* Questions main asks a client the moment it connects (an approval or a
       host key already waiting, ipc-handlers attachWebClient) arrive before
       the app has mounted its listeners: held until one registers. */
    var held = [];              // [channel, args] with no listener yet, HELD channels only
    var seq = 0;
    var ws = null;
    var retry = opts.retryMs || 1000;
    var stopped = false;
    var opened = false;

    function connect() {
      if (stopped) return;
      ws = new WS(opts.url);
      ws.onopen = function () {
        retry = opts.retryMs || 1000;
        /* Back after a drop: main sees a new client (the renderer re-pulls
           its state and rejoins its sessions, AppContext MIRROR_RECONNECTED) */
        if (opened && root && typeof root.dispatchEvent === 'function' && typeof root.Event === 'function') {
          setTimeout(function () { try { root.dispatchEvent(new root.Event('termilab-web-reconnect')); } catch (_) { /* no DOM */ } }, 0);
        }
        opened = true;
        var q = queue; queue = [];
        q.forEach(function (f) { ws.send(f); });
      };
      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'res') {
          var p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          if (msg.ok) p.resolve(decode(msg.v)); else p.reject(new Error(msg.e || 'Error'));
        } else if (msg.t === 'ev' && typeof msg.ch === 'string') {
          var args = decode(Array.isArray(msg.args) ? msg.args : []);
          var list = listeners.get(msg.ch) || [];
          if (!list.length && HELD[msg.ch]) {
            if (held.length < HELD_MAX) held.push([msg.ch, args]);
            return;
          }
          dispatch(list, msg.ch, args);
        }
      };
      ws.onclose = function () {
        ws = null;
        // Replies that will never come: reject now, not hang.
        pending.forEach(function (p) { p.reject(new Error('Disconnected from Termilab')); });
        pending.clear();
        if (stopped) return;
        var wait = retry;
        retry = Math.min(retry * 2, 15000);
        setTimeout(connect, wait);
      };
      ws.onerror = function () { /* onclose follows */ };
    }

    function dispatch(list, channel, args) {
      var event = { sender: null };
      list.slice().forEach(function (fn) {
        try { fn.apply(null, [event].concat(args)); } catch (err) {
          if (root.console) root.console.error('[termilab-web] listener for ' + channel + ' threw:', err);
        }
      });
    }

    /* The first listener of a held channel gets what waited for it, in order */
    function release(channel, fn) {
      var mine = [];
      held = held.filter(function (h) { if (h[0] !== channel) return true; mine.push(h); return false; });
      if (!mine.length) return;
      setTimeout(function () {
        mine.forEach(function (h) { if ((listeners.get(channel) || []).indexOf(fn) >= 0) dispatch([fn], channel, h[1]); });
      }, 0);
    }

    function post(frame) {
      var s = JSON.stringify(frame);
      if (ws && ws.readyState === 1) ws.send(s); else queue.push(s);
    }

    var ipc = {
      invoke: function (channel) {
        var args = Array.prototype.slice.call(arguments, 1);
        var id = ++seq;
        return new Promise(function (resolve, reject) {
          pending.set(id, { resolve: resolve, reject: reject });
          post({ t: 'invoke', id: id, ch: String(channel), args: encode(args) });
        });
      },
      send: function (channel) {
        var args = Array.prototype.slice.call(arguments, 1);
        post({ t: 'send', ch: String(channel), args: encode(args) });
      },
      on: function (channel, fn) {
        if (!listeners.has(channel)) listeners.set(channel, []);
        listeners.get(channel).push(fn);
        if (HELD[channel]) release(channel, fn);
        return ipc;
      },
      removeListener: function (channel, fn) {
        var list = listeners.get(channel) || [];
        var i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
        return ipc;
      },
      removeAllListeners: function (channel) {
        if (channel === undefined) listeners.clear(); else listeners.delete(channel);
        return ipc;
      },
      /* Not Electron API: for tests and for F3's reconnect handling. */
      _stop: function () { stopped = true; if (ws) ws.close(); },
      _listeners: listeners,
    };
    connect();
    return ipc;
  }

  /** What `require('electron')` returns in the browser. */
  function createElectronStub(opts) {
    var target = opts.target || root;
    return {
      contextBridge: {
        exposeInMainWorld: function (name, api) {
          var copy = {};
          Object.keys(api).forEach(function (k) { if (WEB_OMITTED.indexOf(k) < 0) copy[k] = api[k]; });
          target[name] = Object.freeze(copy);
        },
      },
      ipcRenderer: createIpcRenderer(opts),
      webUtils: null,
    };
  }

  /** ws(s) URL of the gateway, next to the page (works under a path prefix). */
  function gatewayUrl(loc) {
    var dir = loc.pathname.replace(/[^/]*$/, '');
    return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + dir + 'ws';
  }

  var exported = { WEB_OMITTED: WEB_OMITTED, createElectronStub: createElectronStub, createIpcRenderer: createIpcRenderer, gatewayUrl: gatewayUrl, encode: encode, decode: decode };

  if (typeof module === 'object' && module && module.exports) {
    module.exports = exported;
  } else if (root && root.location && root.WebSocket) {
    var stub = createElectronStub({ url: gatewayUrl(root.location), WebSocket: root.WebSocket, target: root });
    root.__termilabWeb = true;
    root.__termilabWebRequire = function (name) {
      if (name === 'electron') return stub;
      throw new Error('Cannot find module \'' + name + '\'');
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
