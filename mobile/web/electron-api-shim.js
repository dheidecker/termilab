/**
 * window.electronAPI for Android: the same shape as electron/preload.js, over
 * the Capacitor-NodeJS bridge instead of Electron IPC. src/ cannot tell the
 * difference, which is the whole point: the renderer is not forked.
 *
 * The Node end is mobile/node/main.js; the wire protocol is documented there.
 *
 * Deliberately NOT here (not in Android v1): the namespaces in
 * OMITTED_NAMESPACES. They are absent rather than stubbed, so a desktop-only
 * code path that slips through fails loudly (`undefined.list`) instead of
 * pretending to work. scripts/check-mobile.js fails if preload.js grows a
 * channel that is neither here nor in the omit list.
 *
 * Keep this file free of browser globals at import time: the check imports it
 * under Node with a fake transport.
 */

export const OMITTED_NAMESPACES = ['sftp', 'portForward', 'localShell', 'window', 'dialog'];
/** Channel prefixes that belong to the omitted namespaces. */
export const OMITTED_CHANNEL_PREFIXES = ['sftp:', 'port-forward:', 'local:', 'window:', 'dialog:'];

const HELLO_EVERY_MS = 250;

/**
 * A stand-in for Electron's ipcRenderer on top of a bridge transport:
 *   transport.whenReady(): Promise       the plugin's engine is up
 *   transport.send(eventName, payload)   one JSON payload per message
 *   transport.addListener(eventName, cb) cb(payload)
 */
function createIpc(transport, { onOpenUrl, onSessions, onInstallApk, onFatal } = {}) {
  const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const pending = new Map();   // id -> {resolve, reject}
  const queue = [];            // [eventName, payload] waiting for 'bridge:ready'
  const listeners = new Map(); // channel -> [listener(event, ...args)]
  let seq = 0;
  let ready = false;
  let fatal = null;
  let helloTimer = null;

  // Capacitor registers native listeners asynchronously: hello goes out only
  // once all of them exist, or Node's first flush could land before they do.
  const registered = [];
  const listen = (eventName, cb) => { registered.push(Promise.resolve(transport.addListener(eventName, cb))); };

  const rawSend = (eventName, payload) => {
    Promise.resolve()
      .then(() => transport.send(eventName, payload))
      .catch(err => console.error(`[electronAPI] bridge send failed (${eventName}):`, err && err.message));
  };
  const post = (eventName, payload) => {
    if (ready) rawSend(eventName, payload);
    else queue.push([eventName, payload]);
  };

  listen('bridge:ready', (msg) => {
    if (!msg || msg.session !== session || ready) return;
    ready = true;
    if (helloTimer) { clearInterval(helloTimer); helloTimer = null; }
    if (!msg.ok) {
      fatal = new Error(`Termilab's Node side failed to start: ${msg.error || 'unknown error'}`);
      for (const { reject } of pending.values()) reject(fatal);
      pending.clear();
      queue.length = 0;
      if (onFatal) onFatal(fatal);
      return;
    }
    for (const [eventName, payload] of queue.splice(0)) rawSend(eventName, payload);
  });

  listen('ipc:reply', (msg) => {
    const entry = msg && pending.get(msg.id);
    if (!entry) return;   // a reply for a page that has since reloaded
    pending.delete(msg.id);
    if (msg.error != null) entry.reject(new Error(msg.error));
    else entry.resolve(msg.result);
  });

  listen('ipc:event', (msg) => {
    if (!msg || typeof msg.channel !== 'string') return;
    const args = Array.isArray(msg.args) ? msg.args : [];
    for (const listener of (listeners.get(msg.channel) || []).slice()) {
      try { listener({}, ...args); } catch (err) { console.error(`[electronAPI] ${msg.channel} listener threw:`, err); }
    }
  });

  listen('native:open-url', (msg) => {
    if (msg && typeof msg.url === 'string' && onOpenUrl) onOpenUrl(msg.url);
  });

  listen('native:sessions', (msg) => {
    if (msg && Number.isInteger(msg.count) && onSessions) onSessions(msg.count, msg.signingIn === true);
  });

  // updater:install: Node verified the APK; the native installer is the page's to call.
  listen('native:install-apk', (msg) => {
    if (!msg || msg.id == null || typeof msg.path !== 'string') return;
    const reply = (body) => post('native:install-result', { id: msg.id, ...body });
    if (!onInstallApk) { reply({ ok: false, error: 'No installer on this platform' }); return; }
    Promise.resolve()
      .then(() => onInstallApk({ path: msg.path, version: msg.version, versionCode: msg.versionCode }))
      .then(result => reply({ ok: true, result: result || null }))
      .catch(err => reply({ ok: false, error: (err && err.message) || String(err) }));
  });

  // Say hello until Node answers: a hello sent before its listener exists is lost.
  Promise.resolve()
    .then(() => transport.whenReady())
    .then(() => Promise.all(registered))
    .then(() => {
      const hello = () => rawSend('bridge:hello', { session });
      hello();
      helloTimer = setInterval(() => { if (!ready) hello(); }, HELLO_EVERY_MS);
    })
    .catch(err => {
      fatal = new Error(`Termilab's Node side did not start: ${err && err.message}`);
      for (const { reject } of pending.values()) reject(fatal);
      pending.clear();
      if (onFatal) onFatal(fatal);
    });

  return {
    invoke(channel, ...args) {
      if (fatal) return Promise.reject(fatal);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        post('ipc:invoke', { id, channel, args });
      });
    },
    send(channel, ...args) {
      if (!fatal) post('ipc:send', { channel, args });
    },
    on(channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(listener);
    },
    removeListener(channel, listener) {
      const list = listeners.get(channel) || [];
      const i = list.indexOf(listener);
      if (i >= 0) list.splice(i, 1);
    },
    removeAllListeners(channel) { listeners.set(channel, []); },
    get ready() { return ready; },
  };
}

/**
 * Builds the electronAPI object. Mirrors electron/preload.js member by member;
 * when preload changes, this changes in the same commit.
 */
export function createElectronAPI(transport, options = {}) {
  const ipc = createIpc(transport, options);

  /* Same envelope unwrapping as preload's invoke(): raw data, or a rejection. */
  async function invoke(channel, ...args) {
    const result = await ipc.invoke(channel, ...args);
    if (result && typeof result === 'object' && 'success' in result) {
      if (!result.success) throw new Error(result.error || 'Unknown error');
      return result.data;
    }
    return result;
  }

  return {
    platform: 'android',

    // ─── SSH ──────────────────────────────────────────────
    ssh: {
      connect: (config) => invoke('ssh:connect', config),
      disconnect: (sessionId) => invoke('ssh:disconnect', sessionId),
      sendData: (sessionId, data) => ipc.send('ssh:send-data', sessionId, data),
      resize: (sessionId, cols, rows) => ipc.send('ssh:resize', sessionId, cols, rows),
      onData: (callback) => {
        const listener = (event, sessionId, data) => callback(sessionId, data);
        ipc.on('ssh:data', listener);
        return listener;
      },
      onClose: (callback) => {
        const listener = (event, sessionId) => callback(sessionId);
        ipc.on('ssh:close', listener);
        return listener;
      },
      onError: (callback) => {
        const listener = (event, sessionId, error) => callback(sessionId, error);
        ipc.on('ssh:error', listener);
        return listener;
      },
      onOsDetected: (callback) => {
        const listener = (event, payload) => callback(payload);
        ipc.on('ssh:os-detected', listener);
        return listener;
      },
      removeOsDetectedListener: (listener) => {
        if (listener) ipc.removeListener('ssh:os-detected', listener);
      },
      onHostKeyPrompt: (callback) => {
        const listener = (event, payload) => callback(payload);
        ipc.on('ssh:host-key-prompt', listener);
        return listener;
      },
      onHostKeyPromptCancel: (callback) => {
        const listener = (event, payload) => callback(payload);
        ipc.on('ssh:host-key-prompt-cancel', listener);
        return listener;
      },
      removeHostKeyPromptListener: (listener) => {
        if (!listener) return;
        ipc.removeListener('ssh:host-key-prompt', listener);
        ipc.removeListener('ssh:host-key-prompt-cancel', listener);
      },
      respondHostKey: (requestId, accept) => invoke('ssh:host-key-response', { requestId, accept: accept === true }),
      removeAllListeners: () => {
        ipc.removeAllListeners('ssh:data');
        ipc.removeAllListeners('ssh:close');
        ipc.removeAllListeners('ssh:error');
      },
    },

    // ─── Store ────────────────────────────────────────────
    store: {
      getHosts: () => invoke('store:get-hosts'),
      saveHost: (host) => invoke('store:save-host', host),
      setHostOs: (hostId, os) => invoke('store:set-host-os', hostId, os),
      deleteHost: (id) => invoke('store:delete-host', id),

      getGroups: () => invoke('store:get-groups'),
      saveGroup: (group) => invoke('store:save-group', group),
      deleteGroup: (id) => invoke('store:delete-group', id),

      getSnippets: () => invoke('store:get-snippets'),
      saveSnippet: (snippet) => invoke('store:save-snippet', snippet),
      deleteSnippet: (id) => invoke('store:delete-snippet', id),

      getKeys: () => invoke('store:get-keys'),
      saveKey: (key) => invoke('store:save-key', key),
      deleteKey: (id) => invoke('store:delete-key', id),
      // Opens a file dialog in main: rejects on Android (the UI hides it).
      importKey: () => invoke('store:import-key'),
      generateKey: (options) => invoke('store:generate-key', options),
      pasteKey: (data) => invoke('store:paste-key', data),

      // Rules still sync through here even though Android cannot run tunnels.
      getPortForwards: () => invoke('store:get-port-forwards'),
      savePortForward: (forward) => invoke('store:save-port-forward', forward),
      deletePortForward: (id) => invoke('store:delete-port-forward', id),

      getSettings: () => invoke('app:get-settings'),
      saveSettings: (settings) => invoke('app:save-settings', settings),
    },

    // ─── Known Hosts ──────────────────────────────────────
    knownHosts: {
      list: () => invoke('known-hosts:list'),
      delete: (id) => invoke('known-hosts:delete', id),
      // Reads ~/.ssh/known_hosts, which does not exist on Android (the UI hides it).
      importFromSsh: () => invoke('known-hosts:import'),
    },

    // ─── Connection Logs ──────────────────────────────────
    logs: {
      list: () => invoke('logs:list'),
      clear: () => invoke('logs:clear'),
    },

    // ─── Auto-Updater ─────────────────────────────────────
    updater: {
      check: () => invoke('updater:check'),
      download: () => invoke('updater:download'),
      install: () => invoke('updater:install'),
      getVersion: () => invoke('updater:version'),
      onStatus: (callback) => {
        const listener = (_, data) => callback(data);
        ipc.on('updater:status', listener);
        return listener;
      },
      removeStatusListener: (listener) => {
        if (listener) ipc.removeListener('updater:status', listener);
        else ipc.removeAllListeners('updater:status');
      },
    },

    // ─── Sync ─────────────────────────────────────────────
    sync: {
      status: () => invoke('sync:status'),
      login: () => invoke('sync:login'),
      logout: () => invoke('sync:logout'),
      syncNow: () => invoke('sync:now'),
      setupPassphrase: (passphrase) => invoke('sync:setup-passphrase', passphrase),
      unlock: (passphrase) => invoke('sync:unlock', passphrase),
      devices: () => invoke('sync:devices'),
      revokeDevice: (id) => invoke('sync:revoke-device', id),
      onStatus: (callback) => {
        const listener = (event, status) => callback(status);
        ipc.on('sync:status', listener);
        return listener;
      },
      removeStatusListener: (listener) => {
        if (listener) ipc.removeListener('sync:status', listener);
        else ipc.removeAllListeners('sync:status');
      },
      pairing: {
        request: () => invoke('sync:pair-request'),
        pending: () => invoke('sync:pair-pending'),
        approve: (id) => invoke('sync:pair-approve', id),
        confirm: (id) => invoke('sync:pair-confirm', id),
        reject: (id) => invoke('sync:pair-reject', id),
        claim: (id) => invoke('sync:pair-claim', id),
      },
    },

    // ─── System Info ──────────────────────────────────────
    system: {
      getInfo: () => invoke('system:info'),
    },
  };
}

/** Transport over the vendored Capacitor-NodeJS plugin's JS API. */
export function capacitorTransport(NodeJS) {
  return {
    whenReady: () => NodeJS.whenReady(),
    send: (eventName, payload) => NodeJS.send({ eventName, args: [payload] }),
    addListener: (eventName, cb) => NodeJS.addListener(eventName, (e) => cb(e && Array.isArray(e.args) ? e.args[0] : undefined)),
  };
}
