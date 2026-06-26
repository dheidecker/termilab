const { ipcMain, dialog, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');

const sshService = require('./services/ssh-service');
const sftpService = require('./services/sftp-service');
const storeService = require('./services/store-service');
const keyService = require('./services/key-service');
const portForwardService = require('./services/port-forward-service');
const localShellService = require('./services/local-shell-service');
const aiService = require('./services/ai-service');

/**
 * Wraps an async handler with standardized error handling.
 * Returns { success: true, data } on success, { success: false, error } on failure.
 */
function wrapHandler(fn) {
  return async (event, ...args) => {
    try {
      const result = await fn(event, ...args);
      return { success: true, data: result };
    } catch (err) {
      console.error(`[IPC] Handler error:`, err.message);
      return { success: false, error: err.message };
    }
  };
}

/**
 * Register all IPC handlers.
 * @param {BrowserWindow} mainWindow
 */
function registerIpcHandlers(mainWindow) {
  // Inject mainWindow into services that need to push events to the renderer
  sshService.setMainWindow(mainWindow);
  sftpService.setMainWindow(mainWindow);
  portForwardService.setMainWindow(mainWindow);
  localShellService.setMainWindow(mainWindow);

  // ─── SSH Handlers ─────────────────────────────────────

  ipcMain.handle('ssh:connect', wrapHandler(async (event, config) => {
    // If a keyId is provided, resolve the private key from the store
    if (config.keyId) {
      const privateKey = await keyService.getPrivateKey(config.keyId);
      config.privateKey = privateKey;
    }
    const sessionId = await sshService.connect(config);
    return { sessionId };
  }));

  ipcMain.handle('ssh:disconnect', wrapHandler(async (event, sessionId) => {
    await sshService.disconnect(sessionId);
    // Also close any associated SFTP session
    sftpService.closeSFTP(sessionId);
    return true;
  }));

  ipcMain.on('ssh:send-data', (event, sessionId, data) => {
    sshService.sendData(sessionId, data);
  });

  ipcMain.on('ssh:resize', (event, sessionId, cols, rows) => {
    sshService.resize(sessionId, cols, rows);
  });

  // ─── SFTP Handlers ────────────────────────────────────

  ipcMain.handle('sftp:list', wrapHandler(async (event, sessionId, remotePath) => {
    return await sftpService.list(sessionId, remotePath);
  }));

  ipcMain.handle('sftp:download', wrapHandler(async (event, sessionId, remotePath) => {
    const fileName = path.basename(remotePath);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save File',
      defaultPath: fileName,
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    return await sftpService.download(sessionId, remotePath, result.filePath);
  }));

  ipcMain.handle('sftp:upload', wrapHandler(async (event, sessionId, remotePath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select File to Upload',
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const localPath = result.filePaths[0];
    const fileName = path.basename(localPath);
    const remoteFilePath = remotePath.endsWith('/')
      ? `${remotePath}${fileName}`
      : `${remotePath}/${fileName}`;

    return await sftpService.upload(sessionId, localPath, remoteFilePath);
  }));

  ipcMain.handle('sftp:mkdir', wrapHandler(async (event, sessionId, remotePath) => {
    return await sftpService.mkdir(sessionId, remotePath);
  }));

  ipcMain.handle('sftp:delete', wrapHandler(async (event, sessionId, remotePath, isDirectory) => {
    return await sftpService.delete(sessionId, remotePath, isDirectory);
  }));

  ipcMain.handle('sftp:rename', wrapHandler(async (event, sessionId, oldPath, newPath) => {
    return await sftpService.rename(sessionId, oldPath, newPath);
  }));

  ipcMain.handle('sftp:stat', wrapHandler(async (event, sessionId, remotePath) => {
    return await sftpService.stat(sessionId, remotePath);
  }));

  // ─── Store: Hosts ─────────────────────────────────────

  ipcMain.handle('store:get-hosts', wrapHandler(async () => {
    return await storeService.getHosts();
  }));

  ipcMain.handle('store:save-host', wrapHandler(async (event, host) => {
    return await storeService.saveHost(host);
  }));

  ipcMain.handle('store:delete-host', wrapHandler(async (event, id) => {
    return await storeService.deleteHost(id);
  }));

  // ─── Store: Groups ────────────────────────────────────

  ipcMain.handle('store:get-groups', wrapHandler(async () => {
    return await storeService.getGroups();
  }));

  ipcMain.handle('store:save-group', wrapHandler(async (event, group) => {
    return await storeService.saveGroup(group);
  }));

  ipcMain.handle('store:delete-group', wrapHandler(async (event, id) => {
    return await storeService.deleteGroup(id);
  }));

  // ─── Store: Snippets ──────────────────────────────────

  ipcMain.handle('store:get-snippets', wrapHandler(async () => {
    return await storeService.getSnippets();
  }));

  ipcMain.handle('store:save-snippet', wrapHandler(async (event, snippet) => {
    return await storeService.saveSnippet(snippet);
  }));

  ipcMain.handle('store:delete-snippet', wrapHandler(async (event, id) => {
    return await storeService.deleteSnippet(id);
  }));

  // ─── Store: Keys ──────────────────────────────────────

  ipcMain.handle('store:get-keys', wrapHandler(async () => {
    return await storeService.getKeys();
  }));

  ipcMain.handle('store:save-key', wrapHandler(async (event, key) => {
    return await storeService.saveKey(key);
  }));

  ipcMain.handle('store:delete-key', wrapHandler(async (event, id) => {
    return await storeService.deleteKey(id);
  }));

  ipcMain.handle('store:import-key', wrapHandler(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select SSH Private Key',
      defaultPath: keyService.getDefaultKeyPath(),
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'PEM Files', extensions: ['pem'] },
        { name: 'Key Files', extensions: ['key'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const key = await keyService.importKey(result.filePaths[0]);
    return { key };
  }));

  ipcMain.handle('store:generate-key', wrapHandler(async (event, options) => {
    const key = await keyService.generateKey(options);
    return { key };
  }));

  ipcMain.handle('store:paste-key', wrapHandler(async (event, { name, privateKeyContent }) => {
    if (!privateKeyContent || !privateKeyContent.trim()) throw new Error('No key content provided');
    const key = await keyService.importFromContent(name, privateKeyContent);
    return { key };
  }));

  // ─── Store: Port Forwards ─────────────────────────────

  ipcMain.handle('store:get-port-forwards', wrapHandler(async () => {
    return await storeService.getPortForwards();
  }));

  ipcMain.handle('store:save-port-forward', wrapHandler(async (event, forward) => {
    return await storeService.savePortForward(forward);
  }));

  ipcMain.handle('store:delete-port-forward', wrapHandler(async (event, id) => {
    return await storeService.deletePortForward(id);
  }));

  // ─── Settings ─────────────────────────────────────────

  ipcMain.handle('app:get-settings', wrapHandler(async () => {
    return await storeService.getSettings();
  }));

  ipcMain.handle('app:save-settings', wrapHandler(async (event, settings) => {
    return await storeService.saveSettings(settings);
  }));

  // ─── Port Forwarding (Active Tunnels) ─────────────────

  ipcMain.handle('port-forward:start', wrapHandler(async (event, config) => {
    // If a keyId is provided, resolve the private key
    if (config.keyId) {
      const privateKey = await keyService.getPrivateKey(config.keyId);
      config.privateKey = privateKey;
    }
    return await portForwardService.start(config);
  }));

  ipcMain.handle('port-forward:stop', wrapHandler(async (event, forwardId) => {
    await portForwardService.stop(forwardId);
    return true;
  }));

  // ─── Local Shell Handlers ──────────────────────────────

  ipcMain.handle('local:spawn', wrapHandler(async (event, options) => {
    const sessionId = await localShellService.spawn(options);
    return { sessionId };
  }));

  ipcMain.handle('local:kill', wrapHandler(async (event, sessionId) => {
    await localShellService.kill(sessionId);
    return true;
  }));

  ipcMain.on('local:write', (event, sessionId, data) => {
    localShellService.write(sessionId, data);
  });

  ipcMain.on('local:resize', (event, sessionId, cols, rows) => {
    localShellService.resize(sessionId, cols, rows);
  });

  // ─── Dialog Handlers ──────────────────────────────────

  ipcMain.handle('dialog:open-file', wrapHandler(async (event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Open File',
      defaultPath: options.defaultPath,
      properties: options.properties || ['openFile'],
      filters: options.filters || [{ name: 'All Files', extensions: ['*'] }],
    });

    if (result.canceled) return null;
    return result.filePaths;
  }));

  ipcMain.handle('dialog:save-file', wrapHandler(async (event, options = {}) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || 'Save File',
      defaultPath: options.defaultPath,
      filters: options.filters || [{ name: 'All Files', extensions: ['*'] }],
    });

    if (result.canceled) return null;
    return result.filePath;
  }));

  // ─── Window Controls ──────────────────────────────────

  ipcMain.on('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  });

  ipcMain.on('window:maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.on('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  ipcMain.handle('window:is-maximized', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return mainWindow.isMaximized();
    }
    return false;
  });

  // Notify renderer on maximize/unmaximize state changes
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximize-change', true);
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximize-change', false);
  });

  // ─── AI Assistant ─────────────────────────────────────────

  ipcMain.handle('ai:chat', wrapHandler(async (event, { messages, terminalContext, apiKey, model, provider }) => {
    const result = await aiService.chat({ apiKey, messages, terminalContext, model, provider });
    return result;
  }));

  ipcMain.handle('ai:chat-stream', wrapHandler(async (event, { messages, terminalContext, apiKey, model, provider }) => {
    const result = await aiService.chatStream({
      apiKey, messages, terminalContext, model, provider,
      onChunk: (text) => {
        event.sender.send('ai:stream-chunk', text);
      },
    });
    return result;
  }));

  ipcMain.handle('ai:clear', wrapHandler(async (event, conversationId) => {
    aiService.clearConversation(conversationId);
    return { cleared: true };
  }));

  // ─── System Info ──────────────────────────────────────────

  ipcMain.handle('system:info', wrapHandler(async () => {
    return {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      username: os.userInfo().username,
      shell: process.env.SHELL || 'unknown',
    };
  }));
}

/**
 * Remove all IPC handlers. Called on app shutdown.
 */
function removeIpcHandlers() {
  const channels = [
    'ssh:connect', 'ssh:disconnect',
    'sftp:list', 'sftp:download', 'sftp:upload', 'sftp:mkdir',
    'sftp:delete', 'sftp:rename', 'sftp:stat',
    'store:get-hosts', 'store:save-host', 'store:delete-host',
    'store:get-groups', 'store:save-group', 'store:delete-group',
    'store:get-snippets', 'store:save-snippet', 'store:delete-snippet',
    'store:get-keys', 'store:save-key', 'store:delete-key',
    'store:import-key', 'store:generate-key', 'store:paste-key',
    'store:get-port-forwards', 'store:save-port-forward', 'store:delete-port-forward',
    'app:get-settings', 'app:save-settings',
    'port-forward:start', 'port-forward:stop',
    'local:spawn', 'local:kill',
    'dialog:open-file', 'dialog:save-file',
    'window:is-maximized',
    'ai:chat', 'ai:chat-stream', 'ai:clear',
    'system:info',
  ];

  for (const channel of channels) {
    ipcMain.removeHandler(channel);
  }

  ipcMain.removeAllListeners('ssh:send-data');
  ipcMain.removeAllListeners('ssh:resize');
  ipcMain.removeAllListeners('local:write');
  ipcMain.removeAllListeners('local:resize');
  ipcMain.removeAllListeners('window:minimize');
  ipcMain.removeAllListeners('window:maximize');
  ipcMain.removeAllListeners('window:close');
}

module.exports = { registerIpcHandlers, removeIpcHandlers };
