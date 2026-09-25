const { ipcMain, dialog, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');

const sshService = require('./services/ssh-service');
const sftpService = require('./services/sftp-service');
const transferService = require('./services/transfer-service');
const sftpEditService = require('./services/sftp-edit-service');
const localFsService = require('./services/local-fs-service');
const storeService = require('./services/store-service');
const keyService = require('./services/key-service');
const portForwardService = require('./services/port-forward-service');
const localShellService = require('./services/local-shell-service');
const syncService = require('./services/sync-service');
const hostKeyService = require('./services/host-key-service');
const connectionLogService = require('./services/connection-log-service');
const { parseKnownHosts } = require('./services/known-hosts');

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
  transferService.setMainWindow(mainWindow);
  sftpEditService.setMainWindow(mainWindow);
  portForwardService.setMainWindow(mainWindow);
  localShellService.setMainWindow(mainWindow);
  syncService.setMainWindow(mainWindow);
  hostKeyService.setMainWindow(mainWindow);
  syncService.start();

  // A prompt nobody can answer any more is a rejection, not a 2-minute hang.
  mainWindow.on('closed', () => hostKeyService.rejectAll());

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

  // Answer to an 'ssh:host-key-prompt' push. Unknown/expired ids are ignored.
  ipcMain.handle('ssh:host-key-response', wrapHandler(async (event, payload) => {
    const { requestId, accept } = payload || {};
    if (typeof requestId !== 'string') throw new Error('requestId missing');
    return await hostKeyService.respond(requestId, accept === true);
  }));

  // ─── Known Hosts (local only, never synced) ───────────

  ipcMain.handle('known-hosts:list', wrapHandler(async () => {
    return await storeService.getKnownHosts();
  }));

  ipcMain.handle('known-hosts:delete', wrapHandler(async (event, id) => {
    return await storeService.deleteKnownHost(id);
  }));

  // Reads ~/.ssh/known_hosts. Plain entries only: hashed (|1|), @cert-authority,
  // @revoked, wildcard patterns and malformed lines are counted as skipped.
  ipcMain.handle('known-hosts:import', wrapHandler(async () => {
    const file = path.join(os.homedir(), '.ssh', 'known_hosts');
    let text;
    try {
      text = await require('fs/promises').readFile(file, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`No known_hosts file at ${file}`);
      throw err;
    }
    const parsed = parseKnownHosts(text);
    const { added, duplicates } = await storeService.addKnownHosts(parsed.entries);
    return { file, imported: added, duplicates, skipped: parsed.skipped, reasons: parsed.reasons };
  }));

  // ─── Connection Logs (local only, never synced) ───────

  ipcMain.handle('logs:list', wrapHandler(async () => {
    return await connectionLogService.list();
  }));

  ipcMain.handle('logs:clear', wrapHandler(async () => {
    return await connectionLogService.clear();
  }));

  ipcMain.on('ssh:send-data', (event, sessionId, data) => {
    sshService.sendData(sessionId, data);
  });

  ipcMain.on('ssh:resize', (event, sessionId, cols, rows) => {
    sshService.resize(sessionId, cols, rows);
  });

  // ─── SFTP Handlers ────────────────────────────────────
  // Remote side of the SFTP screen. sessionId is an ssh-service session: a
  // terminal's (reused) or one opened with ssh:connect purpose:'sftp'.
  // Paths are absolute POSIX; names that create something are one segment
  // (validated in sftp-service, not here).

  ipcMain.handle('sftp:list', wrapHandler(async (event, sessionId, remotePath) => {
    return await sftpService.list(sessionId, remotePath);
  }));

  ipcMain.handle('sftp:realpath', wrapHandler(async (event, sessionId, remotePath) => {
    return await sftpService.realpath(sessionId, remotePath);
  }));

  ipcMain.handle('sftp:stat', wrapHandler(async (event, sessionId, remotePath) => {
    return await sftpService.stat(sessionId, remotePath);
  }));

  ipcMain.handle('sftp:mkdir', wrapHandler(async (event, sessionId, dir, name) => {
    return await sftpService.mkdir(sessionId, dir, name);
  }));

  ipcMain.handle('sftp:create-file', wrapHandler(async (event, sessionId, dir, name) => {
    return await sftpService.createFile(sessionId, dir, name);
  }));

  ipcMain.handle('sftp:rename', wrapHandler(async (event, sessionId, remotePath, newName) => {
    return await sftpService.rename(sessionId, remotePath, newName);
  }));

  // Permanent (there is no remote trash); the renderer's confirm says so.
  ipcMain.handle('sftp:delete', wrapHandler(async (event, sessionId, remotePath) => {
    return await sftpService.delete(sessionId, remotePath);
  }));

  ipcMain.handle('sftp:chmod', wrapHandler(async (event, sessionId, remotePath, mode) => {
    return await sftpService.chmod(sessionId, remotePath, mode);
  }));

  // Transfers between any two endpoints ({kind:'local'} | {kind:'remote', sessionId}).
  // Progress on 'sftp:transfer-progress'; cancel deletes the part file.
  ipcMain.handle('sftp:transfer-start', wrapHandler(async (event, id, spec) => {
    return await transferService.start(id, spec || {});
  }));

  ipcMain.handle('sftp:transfer-cancel', wrapHandler(async (event, id) => {
    return transferService.cancel(id);
  }));

  // Remote files opened/edited through a temp copy owned by an SFTP tab.
  ipcMain.handle('sftp:open-remote', wrapHandler(async (event, sessionId, remotePath, owner) => {
    return await sftpEditService.open(sessionId, remotePath, owner);
  }));

  ipcMain.handle('sftp:edit-start', wrapHandler(async (event, sessionId, remotePath, owner) => {
    return await sftpEditService.start(sessionId, remotePath, owner);
  }));

  ipcMain.handle('sftp:edit-upload', wrapHandler(async (event, editId) => {
    return await sftpEditService.upload(editId);
  }));

  ipcMain.handle('sftp:edit-stop', wrapHandler(async (event, editId) => {
    return sftpEditService.stop(editId);
  }));

  ipcMain.handle('sftp:cleanup', wrapHandler(async (event, owner) => {
    return await sftpEditService.cleanup(owner);
  }));

  // ─── Local filesystem (SFTP screen's Local pane) ───────
  // Absolute paths only, names are one segment, delete goes to the OS trash.

  ipcMain.handle('local-fs:home', wrapHandler(async () => localFsService.home()));

  ipcMain.handle('local-fs:list', wrapHandler(async (event, dir) => {
    return await localFsService.list(dir);
  }));

  ipcMain.handle('local-fs:stat', wrapHandler(async (event, p) => {
    return await localFsService.stat(p);
  }));

  ipcMain.handle('local-fs:mkdir', wrapHandler(async (event, dir, name) => {
    return await localFsService.mkdir(dir, name);
  }));

  ipcMain.handle('local-fs:create-file', wrapHandler(async (event, dir, name) => {
    return await localFsService.createFile(dir, name);
  }));

  ipcMain.handle('local-fs:rename', wrapHandler(async (event, p, newName) => {
    return await localFsService.rename(p, newName);
  }));

  ipcMain.handle('local-fs:trash', wrapHandler(async (event, p) => {
    return await localFsService.trash(p);
  }));

  ipcMain.handle('local-fs:copy', wrapHandler(async (event, src, dstDir, name) => {
    return await localFsService.copy(src, dstDir, name);
  }));

  ipcMain.handle('local-fs:chmod', wrapHandler(async (event, p, mode) => {
    return await localFsService.chmod(p, mode);
  }));

  ipcMain.handle('local-fs:open', wrapHandler(async (event, p) => {
    return await localFsService.open(p);
  }));

  // ─── Store: Hosts ─────────────────────────────────────

  ipcMain.handle('store:get-hosts', wrapHandler(async () => {
    return await storeService.getHosts();
  }));

  /* A host whose password sync could not open here arrives with no password,
     and saving it would replace the sealed remote copy — the only readable one,
     on the computer that sealed it — on every device. Refused unless the save
     brings a password of its own (the user typed it again). Unlike the OS and
     colour writes below, an unknown sync state does not block: signed-out
     users must be able to edit their hosts. */
  const ERR_SEALED_SAVE = 'The password for this host is sealed by another computer. '
    + 'Type it again here to replace it, or unlock that computer with the account passphrase first.';
  const hostIsListedSealed = async (id) => {
    try {
      const s = await syncService.status();
      return !!(s && Array.isArray(s.undecryptableIds) && s.undecryptableIds.includes(`hosts/${id}`));
    } catch (_) {
      return false;
    }
  };
  ipcMain.handle('store:save-host', wrapHandler(async (event, host) => {
    if (host && host.id && !host.password && await hostIsListedSealed(host.id)) {
      throw new Error(ERR_SEALED_SAVE);
    }
    return await storeService.saveHost(host);
  }));

  /* The detected OS, written field-level in main (see storeService.setHostOs).
     Hosts sync could not open here are never written: that would replace the
     sealed remote copy. Unknown sync state counts as sealed. */
  const hostIsSealed = async (id) => {
    try {
      const s = await syncService.status();
      if (!s || !Array.isArray(s.undecryptableIds)) return true;
      return s.undecryptableIds.includes(`hosts/${id}`);
    } catch (_) {
      return true;
    }
  };
  ipcMain.handle('store:set-host-os', wrapHandler(async (event, hostId, os) => {
    return await storeService.setHostOs(hostId, os, { isSealed: hostIsSealed });
  }));

  /* The swatch pickers: only `color` (null | #rrggbb), same field-level write
     and same sealed check as the OS; a sealed host rejects with a message
     the popover shows. Resolves the host, or null when nothing changed. */
  ipcMain.handle('store:set-host-color', wrapHandler(async (event, hostId, color) => {
    return await storeService.setHostColor(hostId, color, { isSealed: hostIsSealed });
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
    // A deleted rule has no card left to stop it from: stop it first.
    await portForwardService.stop(id);
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

  // Only a rule id crosses IPC. Main reads the rule, its host and the host's
  // credentials from the store itself (port-forward-service._resolveConnection).
  // Status is pushed on 'port-forward:status' as { ruleId, state, error? }.
  ipcMain.handle('port-forward:start', wrapHandler(async (event, ruleId) => {
    return await portForwardService.start(ruleId);
  }));

  ipcMain.handle('port-forward:stop', wrapHandler(async (event, ruleId) => {
    return await portForwardService.stop(ruleId);
  }));

  ipcMain.handle('port-forward:status', wrapHandler(async () => {
    return portForwardService.status();
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

  // ─── Sync ─────────────────────────────────────────────

  ipcMain.handle('sync:status', wrapHandler(async () => {
    return await syncService.status();
  }));

  ipcMain.handle('sync:login', wrapHandler(async () => {
    return await syncService.login();
  }));

  ipcMain.handle('sync:logout', wrapHandler(async () => {
    await syncService.logout();
  }));

  ipcMain.handle('sync:now', wrapHandler(async () => {
    return await syncService.syncNow();
  }));

  // Boveda: la clave maestra sale del passphrase de la cuenta. El passphrase
  // llega aqui y va directo al servicio; no se registra ni vuelve en el sobre.
  ipcMain.handle('sync:setup-passphrase', wrapHandler(async (event, passphrase) => {
    return await syncService.setupPassphrase(passphrase);
  }));

  ipcMain.handle('sync:unlock', wrapHandler(async (event, passphrase) => {
    return await syncService.unlock(passphrase);
  }));

  ipcMain.handle('sync:devices', wrapHandler(async () => {
    return await syncService.devices();
  }));

  ipcMain.handle('sync:revoke-device', wrapHandler(async (event, id) => {
    await syncService.revokeDevice(id);
  }));

  ipcMain.handle('sync:pair-request', wrapHandler(async () => {
    return await syncService.pairingRequest();
  }));

  ipcMain.handle('sync:pair-pending', wrapHandler(async () => {
    return await syncService.pairingPending();
  }));

  // Emparejamiento en dos pasos: 'approve' manda solo la publica y 'confirm'
  // es lo unico que entrega la clave maestra, cuando el usuario ha comparado
  // los seis digitos. Ver el bloque de estados en sync-service.js.
  ipcMain.handle('sync:pair-approve', wrapHandler(async (event, id) => {
    return await syncService.pairingApprove(id);
  }));

  ipcMain.handle('sync:pair-confirm', wrapHandler(async (event, id) => {
    return await syncService.pairingConfirm(id);
  }));

  ipcMain.handle('sync:pair-reject', wrapHandler(async (event, id) => {
    await syncService.pairingReject(id);
  }));

  ipcMain.handle('sync:pair-claim', wrapHandler(async (event, id) => {
    return await syncService.pairingClaim(id);
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
    'ssh:connect', 'ssh:disconnect', 'ssh:host-key-response',
    'known-hosts:list', 'known-hosts:delete', 'known-hosts:import',
    'logs:list', 'logs:clear',
    'sftp:list', 'sftp:realpath', 'sftp:stat', 'sftp:mkdir', 'sftp:create-file',
    'sftp:rename', 'sftp:delete', 'sftp:chmod',
    'sftp:transfer-start', 'sftp:transfer-cancel',
    'sftp:open-remote', 'sftp:edit-start', 'sftp:edit-upload', 'sftp:edit-stop', 'sftp:cleanup',
    'local-fs:home', 'local-fs:list', 'local-fs:stat', 'local-fs:mkdir', 'local-fs:create-file',
    'local-fs:rename', 'local-fs:trash', 'local-fs:copy', 'local-fs:chmod', 'local-fs:open',
    'store:get-hosts', 'store:save-host', 'store:set-host-os', 'store:set-host-color', 'store:delete-host',
    'store:get-groups', 'store:save-group', 'store:delete-group',
    'store:get-snippets', 'store:save-snippet', 'store:delete-snippet',
    'store:get-keys', 'store:save-key', 'store:delete-key',
    'store:import-key', 'store:generate-key', 'store:paste-key',
    'store:get-port-forwards', 'store:save-port-forward', 'store:delete-port-forward',
    'app:get-settings', 'app:save-settings',
    'port-forward:start', 'port-forward:stop', 'port-forward:status',
    'local:spawn', 'local:kill',
    'dialog:open-file', 'dialog:save-file',
    'window:is-maximized',
    'system:info',
    'sync:status', 'sync:login', 'sync:logout', 'sync:now',
    'sync:devices', 'sync:revoke-device',
    'sync:pair-request', 'sync:pair-pending', 'sync:pair-approve',
    'sync:pair-confirm', 'sync:pair-reject', 'sync:pair-claim',
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
