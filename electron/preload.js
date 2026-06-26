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

  // ─── Port Forwarding (Active Tunnels) ─────────────────
  portForward: {
    start: (config) => invoke('port-forward:start', config),
    stop: (forwardId) => invoke('port-forward:stop', forwardId),
    onError: (callback) => {
      const listener = (event, forwardId, error) => callback(forwardId, error);
      ipcRenderer.on('port-forward:error', listener);
      return listener;
    },
    onClosed: (callback) => {
      const listener = (event, forwardId) => callback(forwardId);
      ipcRenderer.on('port-forward:closed', listener);
      return listener;
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('port-forward:error');
      ipcRenderer.removeAllListeners('port-forward:closed');
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
    onStatus: (callback) => {
      ipcRenderer.on('updater:status', (_, data) => callback(data));
    },
    removeStatusListener: () => {
      ipcRenderer.removeAllListeners('updater:status');
    },
  },

  // ─── AI Assistant ───────────────────────────────────────
  ai: {
    chat: (params) => invoke('ai:chat', params),
    chatStream: (config) => invoke('ai:chat-stream', config),
    onStreamChunk: (callback) => ipcRenderer.on('ai:stream-chunk', (_, text) => callback(text)),
    removeStreamListeners: () => ipcRenderer.removeAllListeners('ai:stream-chunk'),
    clear: (conversationId) => invoke('ai:clear', conversationId),
  },

  // ─── System Info ──────────────────────────────────────────
  system: {
    getInfo: () => invoke('system:info'),
  },
});
