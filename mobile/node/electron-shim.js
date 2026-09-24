/**
 * Stand-in for the `electron` module under nodejs-mobile.
 *
 * The esbuild bundle aliases `electron` to this file, so every
 * `require('electron')` in electron/ (ipc-handlers.js, services/*) gets this
 * object. electron/ itself is never edited for Android.
 *
 * `configure()` MUST run before anything in electron/ is required:
 * store-service computes its data dir in its constructor, and the singleton is
 * created the moment the module is loaded.
 */
const crypto = require('crypto');
const os = require('os');

let dataPath = null;
let postEvent = () => {};   // (channel, ...args) -> bridge 'ipc:event'
let openUrl = () => {};     // url -> bridge 'native:open-url'
let deviceKey = null;       // Buffer(32): AES-256-GCM key behind safeStorage
let appVersion = '0.0.0';

// ─── ipcMain ────────────────────────────────────────────────

const handlers = new Map();   // channel -> handler(event, ...args), from ipcMain.handle
const listeners = new Map();  // channel -> [listener(event, ...args)], from ipcMain.on

const ipcMain = {
  handle(channel, fn) {
    if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    handlers.set(channel, fn);
  },
  removeHandler(channel) { handlers.delete(channel); },
  on(channel, fn) {
    if (!listeners.has(channel)) listeners.set(channel, []);
    listeners.get(channel).push(fn);
    return ipcMain;
  },
  removeAllListeners(channel) {
    if (channel) listeners.delete(channel); else listeners.clear();
    return ipcMain;
  },
  removeListener(channel, fn) {
    const list = listeners.get(channel) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return ipcMain;
  },
};

/** The IpcMainInvokeEvent handlers receive. Nothing in electron/ reads it. */
const fakeEvent = () => ({ sender: mainWindow.webContents, senderFrame: null });

/**
 * ipcRenderer.invoke(channel, ...args), as Electron resolves it: whatever the
 * handler returns (wrapHandler's {success, data|error} envelope for nearly all
 * of them), and a rejection when the handler itself throws or does not exist.
 */
async function invoke(channel, args) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for '${channel}'`);
  return await fn(fakeEvent(), ...(args || []));
}

/** ipcRenderer.send(channel, ...args): fire-and-forget to ipcMain.on listeners. */
function send(channel, args) {
  for (const fn of (listeners.get(channel) || []).slice()) {
    try { fn(fakeEvent(), ...(args || [])); } catch (err) {
      console.error(`[electron-shim] listener for ${channel} threw:`, err.message);
    }
  }
}

// ─── The one window ─────────────────────────────────────────
//
// Services hold it through setMainWindow(); they only call isDestroyed() and
// webContents.send(). ipc-handlers also hooks 'closed'/'maximize'/'unmaximize'
// and the window:* channels call minimize()/maximize()/close(): all no-ops on
// Android, where the activity owns the window.

const mainWindow = {
  webContents: {
    send: (channel, ...args) => postEvent(channel, ...args),
    isDestroyed: () => false,
    on: () => {},
    setWindowOpenHandler: () => {},
  },
  on() { return mainWindow; },
  once() { return mainWindow; },
  isDestroyed: () => false,
  isMaximized: () => true,
  minimize() {},
  maximize() {},
  unmaximize() {},
  close() {},
  show() {},
};

// ─── safeStorage ────────────────────────────────────────────
//
// AES-256-GCM with the device key (DSK). Format: 0x01 | nonce(12) | tag(16) | ciphertext.
// crypto-service wraps the sync token and the master key with this, exactly
// where desktop uses the OS keychain.

const SEAL_VERSION = 1;

const safeStorage = {
  isEncryptionAvailable: () => !!deviceKey,
  encryptString(value) {
    if (!deviceKey) throw new Error('Device key not available');
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deviceKey, nonce);
    const ct = Buffer.concat([cipher.update(String(value), 'utf-8'), cipher.final()]);
    return Buffer.concat([Buffer.from([SEAL_VERSION]), nonce, cipher.getAuthTag(), ct]);
  },
  decryptString(buf) {
    if (!deviceKey) throw new Error('Device key not available');
    if (!Buffer.isBuffer(buf) || buf.length < 29 || buf[0] !== SEAL_VERSION) {
      throw new Error('Not a value sealed by this device');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', deviceKey, buf.subarray(1, 13));
    decipher.setAuthTag(buf.subarray(13, 29));
    return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString('utf-8');
  },
};

/**
 * The DSK comes only from env TERMILAB_DSK: the app unwraps it with its Android
 * Keystore key (mobile/plugins/termilab-native, DeviceKey.java) and hands it to
 * the Node thread at start. There is no file fallback any more: phase 1's
 * `<DATADIR>/device-key.json` is migrated into the Keystore wrap and deleted by
 * the Java side before Node starts, and nothing here may recreate it.
 *
 * Without a DSK safeStorage reports "not available": crypto-service then keeps
 * no secrets (login refuses to proceed) instead of storing them unprotected.
 */
function loadDeviceKey(fromEnv) {
  if (!fromEnv) {
    console.error('[electron-shim] no TERMILAB_DSK: secure storage unavailable (sync login is disabled)');
    return null;
  }
  const key = Buffer.from(fromEnv, 'base64');
  if (key.length !== 32) throw new Error('TERMILAB_DSK must be 32 bytes, base64');
  return key;
}

// ─── os ─────────────────────────────────────────────────────
//
// On Android os.hostname() is "localhost" and os.userInfo() is an app uid
// (u0_a123) with no home. Both leak into what other devices see: the sync
// device name, the comment of a generated key, the connection history.

function patchOs(deviceName) {
  os.hostname = () => deviceName;
  const realUserInfo = os.userInfo;
  os.userInfo = (options) => {
    let base = {};
    try { base = realUserInfo.call(os, options); } catch (_) { /* no passwd entry on Android */ }
    return { uid: base.uid ?? -1, gid: base.gid ?? -1, username: 'termilab', homedir: dataPath, shell: null };
  };
  os.homedir = () => dataPath;
  process.env.HOME = dataPath;
}

// ─── Setup ──────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.dataPath   bridge.getDataPath(): app-private, survives updates
 * @param {(channel: string, ...args: any[]) => void} opts.postEvent
 * @param {(url: string) => void} opts.openUrl
 * @param {string} [opts.dsk]      base64 device key (env TERMILAB_DSK); see loadDeviceKey
 * @param {string} opts.deviceName
 * @param {string} [opts.version]
 */
function configure(opts) {
  dataPath = opts.dataPath;
  postEvent = opts.postEvent;
  openUrl = opts.openUrl;
  appVersion = opts.version || appVersion;
  deviceKey = loadDeviceKey(opts.dsk);
  patchOs(opts.deviceName);
}

const unsupported = what => () => Promise.reject(new Error(`${what} is not available on Android`));

module.exports = {
  app: {
    getPath: () => {
      if (!dataPath) throw new Error('electron-shim: configure() was not called before app.getPath()');
      return dataPath;
    },
    getVersion: () => appVersion,
    getName: () => 'Termilab',
    isPackaged: true,
    on: () => {},
    once: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
  },
  ipcMain,
  safeStorage,
  shell: {
    openExternal: async (url) => { openUrl(String(url)); },
  },
  // Rejecting (not "canceled") so a desktop-only path that slips through shows
  // an error instead of silently doing nothing.
  dialog: {
    showOpenDialog: unsupported('File dialogs'),
    showSaveDialog: unsupported('File dialogs'),
    showMessageBox: unsupported('Dialogs'),
    showErrorBox: () => {},
  },
  BrowserWindow: { getAllWindows: () => [mainWindow], fromWebContents: () => mainWindow },
  nativeTheme: { on: () => {}, shouldUseDarkColors: true },
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },

  // Not Electron API: the adapter's side of the shim (mobile/node/main.js).
  __mobile: { configure, invoke, send, mainWindow, handlers },
};
