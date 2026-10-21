/**
 * Keeps a copy of every IPC handler as it is registered, so the web gateway
 * (gateway.js) can call the very same functions the desktop windows reach.
 *
 * install(ipcMain) wraps ipcMain.handle / ipcMain.on / removeHandler /
 * removeListener / removeAllListeners. Each wrapper records into the maps and
 * then calls the original: Electron's behaviour does not change at all. It
 * must run BEFORE registerIpcHandlers (main.js does it right after requiring
 * electron). Same idea as mobile/node/electron-shim.js, which replaces ipcMain
 * outright; here the real one stays.
 */

const TAPPED = Symbol.for('termilab.ipcTap');

const handlers = new Map();    // channel -> handler(event, ...args), from ipcMain.handle
const listeners = new Map();   // channel -> [listener(event, ...args)], from ipcMain.on

function install(ipcMain) {
  if (!ipcMain || ipcMain[TAPPED]) return api;
  const orig = {
    handle: ipcMain.handle,
    on: ipcMain.on,
    removeHandler: ipcMain.removeHandler,
    removeListener: ipcMain.removeListener,
    removeAllListeners: ipcMain.removeAllListeners,
  };
  if (typeof orig.handle === 'function') {
    ipcMain.handle = function (channel, fn) {
      const r = orig.handle.call(this, channel, fn);
      handlers.set(channel, fn);   // after: a duplicate registration throws first, as it always did
      return r;
    };
  }
  if (typeof orig.on === 'function') {
    ipcMain.on = function (channel, fn) {
      const r = orig.on.call(this, channel, fn);
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(fn);
      return r;
    };
  }
  if (typeof orig.removeHandler === 'function') {
    ipcMain.removeHandler = function (channel) {
      handlers.delete(channel);
      return orig.removeHandler.call(this, channel);
    };
  }
  if (typeof orig.removeListener === 'function') {
    ipcMain.removeListener = function (channel, fn) {
      const list = listeners.get(channel) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
      return orig.removeListener.call(this, channel, fn);
    };
  }
  if (typeof orig.removeAllListeners === 'function') {
    ipcMain.removeAllListeners = function (channel) {
      if (channel === undefined) listeners.clear(); else listeners.delete(channel);
      return orig.removeAllListeners.apply(this, arguments);
    };
  }
  Object.defineProperty(ipcMain, TAPPED, { value: true });
  return api;
}

/** ipcRenderer.invoke as Electron resolves it: the handler's return value, a rejection if none. */
async function invoke(channel, event, args) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for '${channel}'`);
  return await fn(event, ...(args || []));
}

/** ipcRenderer.send: fire-and-forget to every ipcMain.on listener of the channel. */
function emit(channel, event, args) {
  for (const fn of (listeners.get(channel) || []).slice()) {
    try { fn(event, ...(args || [])); } catch (err) {
      console.error(`[ipc-tap] listener for ${channel} threw:`, err.message);
    }
  }
}

const api = { install, invoke, emit, handlers, listeners };
module.exports = api;
