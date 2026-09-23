const { contextBridge, ipcRenderer } = require('electron');

/**
 * Unwrap the { success, data, error } envelope produced by wrapHandler()
 * in ipc-handlers.js so renderer code receives raw data.
 */
async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result && typeof result === 'object' && 'success' in result) {
    if (!result.success) throw new Error(result.error || 'Unknown error');
    return result.data;
  }
  return result;
}

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Exposed synchronously so the renderer can branch on the platform during its
   * first paint. The `system:info` channel also reports this, but it is async:
   * using it for layout makes the window controls flash on the wrong side.
   */
  platform: process.platform,

  // ─── SSH ──────────────────────────────────────────────
  ssh: {
    connect: (config) => invoke('ssh:connect', config),
    disconnect: (sessionId) => invoke('ssh:disconnect', sessionId),
    sendData: (sessionId, data) => ipcRenderer.send('ssh:send-data', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    onData: (callback) => {
      const listener = (event, sessionId, data) => callback(sessionId, data);
      ipcRenderer.on('ssh:data', listener);
      return listener;
    },
    onClose: (callback) => {
      const listener = (event, sessionId) => callback(sessionId);
      ipcRenderer.on('ssh:close', listener);
      return listener;
    },
    onError: (callback) => {
      const listener = (event, sessionId, error) => callback(sessionId, error);
      ipcRenderer.on('ssh:error', listener);
      return listener;
    },
    /* { sessionId, os } once per SSH session, when the remote OS could be
       identified. Deliberately not in removeAllListeners below: its only
       subscriber is AppContext, and a terminal tab clearing it would leave the
       whole app deaf. */
    onOsDetected: (callback) => {
      const listener = (event, payload) => callback(payload);
      ipcRenderer.on('ssh:os-detected', listener);
      return listener;
    },
    removeOsDetectedListener: (listener) => {
      if (listener) ipcRenderer.removeListener('ssh:os-detected', listener);
    },
    /* Host key verification. Main pushes
         {requestId, host, port, keyType, fingerprint,
          reason: 'unknown'|'changed'|'new-key-type',
          previousFingerprint?, knownTypes?, knownFingerprints?: [{keyType, fingerprint}]}
       and waits (120 s max) for respondHostKey. 'ssh:host-key-prompt-cancel'
       {requestId} means main gave up (timeout, connection gone): close the
       dialog. Same rule as onOsDetected: one subscriber (HostKeyPrompt), not
       cleared by removeAllListeners below. */
    onHostKeyPrompt: (callback) => {
      const listener = (event, payload) => callback(payload);
      ipcRenderer.on('ssh:host-key-prompt', listener);
      return listener;
    },
    onHostKeyPromptCancel: (callback) => {
      const listener = (event, payload) => callback(payload);
      ipcRenderer.on('ssh:host-key-prompt-cancel', listener);
      return listener;
    },
    removeHostKeyPromptListener: (listener) => {
      if (!listener) return;
      ipcRenderer.removeListener('ssh:host-key-prompt', listener);
      ipcRenderer.removeListener('ssh:host-key-prompt-cancel', listener);
    },
    respondHostKey: (requestId, accept) => invoke('ssh:host-key-response', { requestId, accept: accept === true }),
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('ssh:data');
      ipcRenderer.removeAllListeners('ssh:close');
      ipcRenderer.removeAllListeners('ssh:error');
    },
  },

  // ─── SFTP ─────────────────────────────────────────────
  sftp: {
    list: (sessionId, path) => invoke('sftp:list', sessionId, path),
    download: (sessionId, remotePath) => invoke('sftp:download', sessionId, remotePath),
    upload: (sessionId, remotePath) => invoke('sftp:upload', sessionId, remotePath),
    mkdir: (sessionId, path) => invoke('sftp:mkdir', sessionId, path),
    delete: (sessionId, path, isDirectory) => invoke('sftp:delete', sessionId, path, isDirectory),
    rename: (sessionId, oldPath, newPath) => invoke('sftp:rename', sessionId, oldPath, newPath),
    stat: (sessionId, path) => invoke('sftp:stat', sessionId, path),
    onTransferProgress: (callback) => {
      const listener = (event, progress) => callback(progress);
      ipcRenderer.on('sftp:transfer-progress', listener);
      return listener;
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('sftp:transfer-progress');
    },
  },

  // ─── Store ────────────────────────────────────────────
  store: {
    // Hosts
    getHosts: () => invoke('store:get-hosts'),
    saveHost: (host) => invoke('store:save-host', host),
    // Only `os`, read-modify-write in main; resolves the host or null (no-op)
    setHostOs: (hostId, os) => invoke('store:set-host-os', hostId, os),
    deleteHost: (id) => invoke('store:delete-host', id),

    // Groups
    getGroups: () => invoke('store:get-groups'),
    saveGroup: (group) => invoke('store:save-group', group),
    deleteGroup: (id) => invoke('store:delete-group', id),

    // Snippets
    getSnippets: () => invoke('store:get-snippets'),
    saveSnippet: (snippet) => invoke('store:save-snippet', snippet),
    deleteSnippet: (id) => invoke('store:delete-snippet', id),

    // Keys
    getKeys: () => invoke('store:get-keys'),
    saveKey: (key) => invoke('store:save-key', key),
    deleteKey: (id) => invoke('store:delete-key', id),
    importKey: () => invoke('store:import-key'),
    generateKey: (options) => invoke('store:generate-key', options),
    pasteKey: (data) => invoke('store:paste-key', data),

    // Port Forwards (stored configs)
    getPortForwards: () => invoke('store:get-port-forwards'),
    savePortForward: (forward) => invoke('store:save-port-forward', forward),
    deletePortForward: (id) => invoke('store:delete-port-forward', id),

    // Settings
    getSettings: () => invoke('app:get-settings'),
    saveSettings: (settings) => invoke('app:save-settings', settings),
  },

  // ─── Known Hosts (local only) ──────────────────────────
  knownHosts: {
    list: () => invoke('known-hosts:list'),
    delete: (id) => invoke('known-hosts:delete', id),
    /* Reads ~/.ssh/known_hosts in main. Resolves
       {file, imported, duplicates, skipped, reasons: {hashed, unsupported, malformed}} */
    importFromSsh: () => invoke('known-hosts:import'),
  },

  // ─── Connection Logs (local only) ─────────────────────
  logs: {
    list: () => invoke('logs:list'),
    clear: () => invoke('logs:clear'),
  },

  // ─── Port Forwarding (Active Tunnels) ─────────────────
  portForward: {
    /* Rule ids only: main resolves the host and its credentials itself.
       start() resolves {ruleId, state:'running', boundPort, activeConnections}
       (a no-op if it is already running) and rejects with a readable message. */
    start: (ruleId) => invoke('port-forward:start', ruleId),
    stop: (ruleId) => invoke('port-forward:stop', ruleId),
    /* [{ruleId, state, error?, boundPort?, activeConnections}] — rules not stopped */
    status: () => invoke('port-forward:status'),
    /* {ruleId, state: 'starting'|'running'|'error'|'stopped', error?} */
    onStatus: (callback) => {
      const listener = (event, payload) => callback(payload);
      ipcRenderer.on('port-forward:status', listener);
      return listener;
    },
    removeStatusListener: (listener) => {
      if (listener) ipcRenderer.removeListener('port-forward:status', listener);
      else ipcRenderer.removeAllListeners('port-forward:status');
    },
  },

  // ─── Local Shell ───────────────────────────────────────
  localShell: {
    spawn: (options) => invoke('local:spawn', options),
    write: (sessionId, data) => ipcRenderer.send('local:write', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('local:resize', sessionId, cols, rows),
    kill: (sessionId) => invoke('local:kill', sessionId),
    onData: (callback) => {
      const listener = (event, sessionId, data) => callback(sessionId, data);
      ipcRenderer.on('local:data', listener);
      return listener;
    },
    onClose: (callback) => {
      const listener = (event, sessionId, exitCode, signal) => callback(sessionId, exitCode, signal);
      ipcRenderer.on('local:close', listener);
      return listener;
    },
    onError: (callback) => {
      const listener = (event, sessionId, error) => callback(sessionId, error);
      ipcRenderer.on('local:error', listener);
      return listener;
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('local:data');
      ipcRenderer.removeAllListeners('local:close');
      ipcRenderer.removeAllListeners('local:error');
    },
  },

  // ─── Dialog ───────────────────────────────────────────
  dialog: {
    openFile: (options) => invoke('dialog:open-file', options),
    saveFile: (options) => invoke('dialog:save-file', options),
  },

  // ─── Window Controls ─────────────────────────────────
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => invoke('window:is-maximized'),
    onMaximizeChange: (callback) => {
      const listener = (event, isMaximized) => callback(isMaximized);
      ipcRenderer.on('window:maximize-change', listener);
      return listener;
    },
    removeMaximizeListener: () => {
      ipcRenderer.removeAllListeners('window:maximize-change');
    },
  },

  // ─── Auto-Updater ───────────────────────────────────────
  updater: {
    check: () => invoke('updater:check'),
    download: () => invoke('updater:download'),
    install: () => invoke('updater:install'),
    getVersion: () => invoke('updater:version'),
    /* Returns the listener so each caller can detach only its own.
       Two components subscribe (UpdateNotification and Settings); a blanket
       removeAllListeners() left the other one deaf until the app restarted. */
    onStatus: (callback) => {
      const listener = (_, data) => callback(data);
      ipcRenderer.on('updater:status', listener);
      return listener;
    },
    removeStatusListener: (listener) => {
      if (listener) ipcRenderer.removeListener('updater:status', listener);
      else ipcRenderer.removeAllListeners('updater:status');
    },
  },

  // ─── Sync ─────────────────────────────────────────────
  sync: {
    status: () => invoke('sync:status'),
    login: () => invoke('sync:login'),
    logout: () => invoke('sync:logout'),
    syncNow: () => invoke('sync:now'),
    // Boveda de la cuenta: crear el passphrase (solo si la cuenta no tiene) o
    // desbloquear este equipo con el que ya existe. Ver status().unlocked.
    setupPassphrase: (passphrase) => invoke('sync:setup-passphrase', passphrase),
    unlock: (passphrase) => invoke('sync:unlock', passphrase),
    devices: () => invoke('sync:devices'),
    revokeDevice: (id) => invoke('sync:revoke-device', id),
    onStatus: (callback) => {
      const listener = (event, status) => callback(status);
      ipcRenderer.on('sync:status', listener);
      return listener;
    },
    removeStatusListener: (listener) => {
      if (listener) ipcRenderer.removeListener('sync:status', listener);
      else ipcRenderer.removeAllListeners('sync:status');
    },
    pairing: {
      request: () => invoke('sync:pair-request'),
      pending: () => invoke('sync:pair-pending'),
      // Dos pasos: approve() manda solo la clave publica (a partir de ahi los
      // dos lados ven los seis digitos) y confirm() es el que entrega la clave
      // maestra, cuando el usuario dice que los digitos coinciden.
      approve: (id) => invoke('sync:pair-approve', id),
      confirm: (id) => invoke('sync:pair-confirm', id),
      reject: (id) => invoke('sync:pair-reject', id),
      claim: (id) => invoke('sync:pair-claim', id),
    },
  },

  // ─── System Info ──────────────────────────────────────────
  system: {
    getInfo: () => invoke('system:info'),
  },
});
