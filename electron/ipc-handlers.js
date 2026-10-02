const { ipcMain, dialog, BrowserWindow, app } = require('electron');
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
const windowRegistry = require('./window-registry');

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

/* ─── Windows ─────────────────────────────────────────────
   Every window is a full Termilab window. What goes where is the window
   registry's job (electron/window-registry.js): per-session events to the
   window that owns the session, the rest to all of them. */

let quitting = false;
/** main.js: from before-quit on, closing windows ends nothing (quit tears down). */
function setQuitting(v) { quitting = !!v; }

/* Per window: the SFTP temp folders (owner = tab id) and transfers its
   renderer started, so closing the window leaves nothing behind. */
const editOwnersByWindow = new Map();   // webContents -> Set(owner)
const transfersByWindow = new Map();    // webContents -> Set(transfer id)
const remember = (map, wc, value) => {
  if (!wc || value == null) return;
  if (!map.has(wc)) map.set(wc, new Set());
  map.get(wc).add(value);
};

/** End sessions whose window is gone (closing a window = closing its tabs). */
async function endWindowSessions(sessionIds) {
  for (const sid of sessionIds) {
    try {
      if (sshService.isConnected(sid)) {
        await sshService.disconnect(sid);
        sftpService.closeSFTP(sid);
      } else if (localShellService.isActive(sid)) {
        await localShellService.kill(sid);
      } else if (sshService.isPending(sid)) {
        /* Still connecting (or on its host-key prompt): it must not come up
           ownerless once the window is gone */
        sshService.cancelPending(sid);
      }
    } catch (err) {
      console.error('[IPC] Could not end a session of a closed window:', err.message);
    }
  }
}
windowRegistry.onOrphaned = (ids) => { endWindowSessions(ids); };

/** Hook a window into the registry and its per-window events. Every window, the first included. */
function attachWindow(win) {
  const entry = windowRegistry.addWindow(win);
  const wc = entry.wc;
  win.on('maximize', () => windowRegistry.sendTo(wc, 'window:maximize-change', true));
  win.on('unmaximize', () => windowRegistry.sendTo(wc, 'window:maximize-change', false));
  /* Looking at it again: the taskbar stops asking for attention */
  win.on('focus', () => stopFlash(win));
  win.on('closed', () => {
    const owned = windowRegistry.removeWindow(wc);
    setBadge();
    // A prompt nobody can answer any more is a rejection, not a 2-minute hang.
    hostKeyService.rejectFor(wc);
    const edits = editOwnersByWindow.get(wc) || new Set();
    const transfers = transfersByWindow.get(wc) || new Set();
    editOwnersByWindow.delete(wc);
    transfersByWindow.delete(wc);
    /* Quitting, or the last window going on Linux/Windows (quit follows):
       before-quit tears everything down, as it always did. */
    const lastAndQuitting = windowRegistry.liveWindows().length === 0 && process.platform !== 'darwin';
    if (quitting || lastAndQuitting) return;
    for (const id of transfers) { try { transferService.cancel(id); } catch (_) { /* done already */ } }
    for (const owner of edits) sftpEditService.cleanup(owner).catch(() => {});
    endWindowSessions(owned);
  });
  return entry;
}

/* ─── "An agent finished" outside the window (window:attention) ───
   The badge (dock on macOS, launcher on Linux with libunity; elsewhere
   setBadgeCount is a no-op that returns false) is the app-wide total of
   unseen panes. A flash is per window and only when it is not focused:
   flashFrame (taskbar/urgency hint) on Windows/Linux until it is focused,
   one informational dock bounce on macOS. */
function setBadge() {
  const total = windowRegistry.totalUnseen();
  try { if (app && typeof app.setBadgeCount === 'function') app.setBadgeCount(total); } catch (_) { /* unsupported */ }
  return total;
}
function stopFlash(win) {
  if (process.platform === 'darwin') return;
  try { if (win && !win.isDestroyed() && typeof win.flashFrame === 'function') win.flashFrame(false); } catch (_) { /* gone */ }
}
function attention(event, spec) {
  const entry = windowRegistry.entryOf(event && event.sender);
  if (!entry) return { total: windowRegistry.totalUnseen(), flashed: false };
  const unseen = spec && Number.isInteger(spec.unseen) ? spec.unseen : 0;
  windowRegistry.setUnseen(entry.wc, unseen);
  const win = entry.win;
  let flashed = false;
  const alive = !!win && !(typeof win.isDestroyed === 'function' && win.isDestroyed());
  if (spec && spec.flash && unseen > 0 && alive && typeof win.isFocused === 'function' && !win.isFocused()) {
    try {
      if (process.platform === 'darwin') {
        if (app && app.dock && typeof app.dock.bounce === 'function') app.dock.bounce('informational');
      } else if (typeof win.flashFrame === 'function') {
        win.flashFrame(true);
      }
      flashed = true;
    } catch (_) { /* not supported here */ }
  }
  return { total: setBadge(), flashed };
}

/**
 * Session-scoped calls: only from the window that owns the session (or, while
 * it moves, either end of the move). See windowRegistry.mayUse. One window
 * (Android shim, the single-window app) owns everything it opened.
 */
function mayUse(event, sessionId, channel) {
  if (windowRegistry.mayUse(sessionId, event && event.sender)) return true;
  console.warn(`[IPC] ${channel}: refused, session ${sessionId} belongs to another window`);
  return false;
}
function ensureMayUse(event, sessionId, channel) {
  if (!mayUse(event, sessionId, channel)) throw new Error('That session belongs to another window');
}
/* Transfer endpoints: {kind:'remote', sessionId} on either side */
function ensureMayUseSpec(event, spec, channel) {
  for (const side of ['src', 'dst']) {
    const ep = spec && spec[side];
    if (ep && typeof ep === 'object' && ep.sessionId) ensureMayUse(event, ep.sessionId, channel);
  }
}

/** The BrowserWindow an IPC event came from. */
const winOf = (event) => windowRegistry.entryOf(event && event.sender)?.win || null;

/* hosts/groups/… changed in one window: the others reload them */
const storeChanged = (event, collection) => {
  windowRegistry.broadcastExcept(event && event.sender, 'window:store-changed', { collection });
};
/* Saves that change the store from a handler: same result, then broadcast */
const changing = (collection, fn) => async (event, ...args) => {
  const result = await fn(event, ...args);
  storeChanged(event, collection);
  return result;
};

/**
 * Register all IPC handlers.
 * @param {BrowserWindow} mainWindow the first window (more come through attachWindow)
 */
function registerIpcHandlers(mainWindow) {
  /* Services push through the registry's sinks: per-session events go to the
     owning window, the rest to every window. (The harness may still point a
     service at a window of its own with setMainWindow.) */
  sshService.setMainWindow(windowRegistry.sessionSink);
  localShellService.setMainWindow(windowRegistry.sessionSink);
  sftpService.setMainWindow(windowRegistry.broadcastSink);
  transferService.setMainWindow(windowRegistry.broadcastSink);
  sftpEditService.setMainWindow(windowRegistry.broadcastSink);
  portForwardService.setMainWindow(windowRegistry.broadcastSink);
  syncService.setMainWindow(windowRegistry.broadcastSink);
  hostKeyService.setRouter(windowRegistry);
  if (mainWindow) attachWindow(mainWindow);
  syncService.start();

  // ─── SSH Handlers ─────────────────────────────────────

  ipcMain.handle('ssh:connect', wrapHandler(async (event, config) => {
    // If a keyId is provided, resolve the private key from the store
    if (config.keyId) {
      const privateKey = await keyService.getPrivateKey(config.keyId);
      config.privateKey = privateKey;
    }
    // Its events go to the window that asked (event.sender)
    const sessionId = await sshService.connect(config, event.sender);
    return { sessionId };
  }));

  ipcMain.handle('ssh:disconnect', wrapHandler(async (event, sessionId) => {
    ensureMayUse(event, sessionId, 'ssh:disconnect');
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
    if (!mayUse(event, sessionId, 'ssh:send-data')) return;
    sshService.sendData(sessionId, data);
  });

  ipcMain.on('ssh:resize', (event, sessionId, cols, rows) => {
    if (!mayUse(event, sessionId, 'ssh:resize')) return;
    sshService.resize(sessionId, cols, rows);
  });

  // ─── SFTP Handlers ────────────────────────────────────
  // Remote side of the SFTP screen. sessionId is an ssh-service session: a
  // terminal's (reused) or one opened with ssh:connect purpose:'sftp'.
  // Paths are absolute POSIX; names that create something are one segment
  // (validated in sftp-service, not here).

  ipcMain.handle('sftp:list', wrapHandler(async (event, sessionId, remotePath) => {
    ensureMayUse(event, sessionId, 'sftp:list');
    return await sftpService.list(sessionId, remotePath);
  }));

  ipcMain.handle('sftp:realpath', wrapHandler(async (event, sessionId, remotePath) => {
    ensureMayUse(event, sessionId, 'sftp:realpath');
    return await sftpService.realpath(sessionId, remotePath);
  }));

  ipcMain.handle('sftp:stat', wrapHandler(async (event, sessionId, remotePath) => {
    ensureMayUse(event, sessionId, 'sftp:stat');
    return await sftpService.stat(sessionId, remotePath);
  }));

  ipcMain.handle('sftp:mkdir', wrapHandler(async (event, sessionId, dir, name) => {
    ensureMayUse(event, sessionId, 'sftp:mkdir');
    return await sftpService.mkdir(sessionId, dir, name);
  }));

  ipcMain.handle('sftp:create-file', wrapHandler(async (event, sessionId, dir, name) => {
    ensureMayUse(event, sessionId, 'sftp:create-file');
    return await sftpService.createFile(sessionId, dir, name);
  }));

  ipcMain.handle('sftp:rename', wrapHandler(async (event, sessionId, remotePath, newName) => {
    ensureMayUse(event, sessionId, 'sftp:rename');
    return await sftpService.rename(sessionId, remotePath, newName);
  }));

  // Permanent (there is no remote trash); the renderer's confirm says so.
  ipcMain.handle('sftp:delete', wrapHandler(async (event, sessionId, remotePath) => {
    ensureMayUse(event, sessionId, 'sftp:delete');
    return await sftpService.delete(sessionId, remotePath);
  }));

  ipcMain.handle('sftp:chmod', wrapHandler(async (event, sessionId, remotePath, mode) => {
    ensureMayUse(event, sessionId, 'sftp:chmod');
    return await sftpService.chmod(sessionId, remotePath, mode);
  }));

  // Transfers between any two endpoints ({kind:'local'} | {kind:'remote', sessionId}).
  // Progress on 'sftp:transfer-progress'; cancel deletes the part file.
  ipcMain.handle('sftp:transfer-start', wrapHandler(async (event, id, spec) => {
    ensureMayUseSpec(event, spec, 'sftp:transfer-start');
    const set = event && event.sender;
    remember(transfersByWindow, set, id);
    try {
      return await transferService.start(id, spec || {});
    } finally {
      transfersByWindow.get(set)?.delete(id);
    }
  }));

  ipcMain.handle('sftp:transfer-cancel', wrapHandler(async (event, id) => {
    return transferService.cancel(id);
  }));

  // Remote files opened/edited through a temp copy owned by an SFTP tab.
  ipcMain.handle('sftp:open-remote', wrapHandler(async (event, sessionId, remotePath, owner) => {
    ensureMayUse(event, sessionId, 'sftp:open-remote');
    remember(editOwnersByWindow, event && event.sender, owner);
    return await sftpEditService.open(sessionId, remotePath, owner);
  }));

  ipcMain.handle('sftp:edit-start', wrapHandler(async (event, sessionId, remotePath, owner) => {
    ensureMayUse(event, sessionId, 'sftp:edit-start');
    remember(editOwnersByWindow, event && event.sender, owner);
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
  ipcMain.handle('store:save-host', wrapHandler(changing('hosts', async (event, host) => {
    if (host && host.id && !host.password && await hostIsListedSealed(host.id)) {
      throw new Error(ERR_SEALED_SAVE);
    }
    return await storeService.saveHost(host);
  })));

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
  ipcMain.handle('store:set-host-os', wrapHandler(changing('hosts', async (event, hostId, os) => {
    return await storeService.setHostOs(hostId, os, { isSealed: hostIsSealed });
  })));

  /* The swatch pickers: only `color` (null | #rrggbb), same field-level write
     and same sealed check as the OS; a sealed host rejects with a message
     the popover shows. Resolves the host, or null when nothing changed. */
  ipcMain.handle('store:set-host-color', wrapHandler(changing('hosts', async (event, hostId, color) => {
    return await storeService.setHostColor(hostId, color, { isSealed: hostIsSealed });
  })));

  ipcMain.handle('store:delete-host', wrapHandler(changing('hosts', async (event, id) => {
    return await storeService.deleteHost(id);
  })));

  // ─── Store: Groups ────────────────────────────────────

  ipcMain.handle('store:get-groups', wrapHandler(async () => {
    return await storeService.getGroups();
  }));

  ipcMain.handle('store:save-group', wrapHandler(changing('groups', async (event, group) => {
    return await storeService.saveGroup(group);
  })));

  ipcMain.handle('store:delete-group', wrapHandler(changing('groups', async (event, id) => {
    return await storeService.deleteGroup(id);
  })));

  // ─── Store: Snippets ──────────────────────────────────

  ipcMain.handle('store:get-snippets', wrapHandler(async () => {
    return await storeService.getSnippets();
  }));

  ipcMain.handle('store:save-snippet', wrapHandler(changing('snippets', async (event, snippet) => {
    return await storeService.saveSnippet(snippet);
  })));

  ipcMain.handle('store:delete-snippet', wrapHandler(changing('snippets', async (event, id) => {
    return await storeService.deleteSnippet(id);
  })));

  // ─── Store: Keys ──────────────────────────────────────

  ipcMain.handle('store:get-keys', wrapHandler(async () => {
    return await storeService.getKeys();
  }));

  ipcMain.handle('store:save-key', wrapHandler(changing('keys', async (event, key) => {
    return await storeService.saveKey(key);
  })));

  ipcMain.handle('store:delete-key', wrapHandler(changing('keys', async (event, id) => {
    return await storeService.deleteKey(id);
  })));

  ipcMain.handle('store:import-key', wrapHandler(changing('keys', async (event) => {
    const result = await dialog.showOpenDialog(winOf(event) || mainWindow, {
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
  })));

  ipcMain.handle('store:generate-key', wrapHandler(changing('keys', async (event, options) => {
    const key = await keyService.generateKey(options);
    return { key };
  })));

  ipcMain.handle('store:paste-key', wrapHandler(changing('keys', async (event, { name, privateKeyContent }) => {
    if (!privateKeyContent || !privateKeyContent.trim()) throw new Error('No key content provided');
    const key = await keyService.importFromContent(name, privateKeyContent);
    return { key };
  })));

  // ─── Store: Port Forwards ─────────────────────────────

  ipcMain.handle('store:get-port-forwards', wrapHandler(async () => {
    return await storeService.getPortForwards();
  }));

  ipcMain.handle('store:save-port-forward', wrapHandler(changing('portForwards', async (event, forward) => {
    return await storeService.savePortForward(forward);
  })));

  ipcMain.handle('store:delete-port-forward', wrapHandler(changing('portForwards', async (event, id) => {
    // A deleted rule has no card left to stop it from: stop it first.
    await portForwardService.stop(id);
    return await storeService.deletePortForward(id);
  })));

  // ─── Settings ─────────────────────────────────────────

  ipcMain.handle('app:get-settings', wrapHandler(async () => {
    return await storeService.getSettings();
  }));

  ipcMain.handle('app:save-settings', wrapHandler(changing('settings', async (event, settings) => {
    return await storeService.saveSettings(settings);
  })));

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
    const sessionId = await localShellService.spawn(options, event.sender);
    return { sessionId };
  }));

  ipcMain.handle('local:kill', wrapHandler(async (event, sessionId) => {
    ensureMayUse(event, sessionId, 'local:kill');
    await localShellService.kill(sessionId);
    return true;
  }));

  ipcMain.on('local:write', (event, sessionId, data) => {
    if (!mayUse(event, sessionId, 'local:write')) return;
    localShellService.write(sessionId, data);
  });

  ipcMain.on('local:resize', (event, sessionId, cols, rows) => {
    if (!mayUse(event, sessionId, 'local:resize')) return;
    localShellService.resize(sessionId, cols, rows);
  });

  // ─── Dialog Handlers ──────────────────────────────────

  ipcMain.handle('dialog:open-file', wrapHandler(async (event, options = {}) => {
    const result = await dialog.showOpenDialog(winOf(event) || mainWindow, {
      title: options.title || 'Open File',
      defaultPath: options.defaultPath,
      properties: options.properties || ['openFile'],
      filters: options.filters || [{ name: 'All Files', extensions: ['*'] }],
    });

    if (result.canceled) return null;
    return result.filePaths;
  }));

  ipcMain.handle('dialog:save-file', wrapHandler(async (event, options = {}) => {
    const result = await dialog.showSaveDialog(winOf(event) || mainWindow, {
      title: options.title || 'Save File',
      defaultPath: options.defaultPath,
      filters: options.filters || [{ name: 'All Files', extensions: ['*'] }],
    });

    if (result.canceled) return null;
    return result.filePath;
  }));

  // ─── Window Controls ──────────────────────────────────
  // Each acts on the window that sent it.

  const live = (w) => !!w && !(w.isDestroyed && w.isDestroyed());

  ipcMain.on('window:minimize', (event) => {
    const w = winOf(event);
    if (live(w)) w.minimize();
  });

  ipcMain.on('window:maximize', (event) => {
    const w = winOf(event);
    if (!live(w)) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });

  ipcMain.on('window:close', (event) => {
    const w = winOf(event);
    if (live(w)) w.close();
  });

  ipcMain.handle('window:is-maximized', (event) => {
    const w = winOf(event);
    return live(w) ? w.isMaximized() : false;
  });

  // ─── Windows: several, tabs move between them ─────────
  // See electron/window-registry.js for the hand-off and why it loses nothing.

  ipcMain.handle('window:info', wrapHandler(async (event) => {
    const e = windowRegistry.entryOf(event.sender);
    return e ? { id: e.id, number: e.number } : null;
  }));

  ipcMain.handle('window:list', wrapHandler(async (event) => windowRegistry.list(event.sender)));

  /* {unseen, flash}: this window's done-but-unseen panes; flash = a new one */
  ipcMain.handle('window:attention', wrapHandler(async (event, spec = {}) => attention(event, spec)));

  /* A new empty window: offset from the one asking, or at {x, y} */
  ipcMain.handle('window:new', wrapHandler(async (event, opts) => {
    const e = windowRegistry.createWindow(placeNear(event, opts));
    return { id: e.id, number: e.number };
  }));

  /* Step 1 (source): main buffers these sessions' output from now on */
  ipcMain.handle('window:move-begin', wrapHandler(async (event, sessionIds) => {
    return windowRegistry.beginMove(Array.isArray(sessionIds) ? sessionIds : [], event.sender);
  }));

  /* Step 2 (source): the serialized tab, and where it goes: {target: id|'new', x?, y?, adoption} */
  ipcMain.handle('window:move-transfer', wrapHandler(async (event, moveId, spec = {}) => {
    const move = windowRegistry.getMove(moveId);
    if (!move || move.from !== event.sender) throw new Error('That move is no longer in progress');
    let target;
    try {
      target = spec.target === 'new' || spec.target == null
        ? windowRegistry.createWindow(placeNear(event, spec))
        : windowRegistry.byId(spec.target);
      if (!target) throw new Error('That window is gone');
      windowRegistry.setTarget(moveId, target.wc, spec.adoption || {});
    } catch (err) {
      windowRegistry.abort(moveId, 'failed');
      throw err;
    }
    return { id: target.id, number: target.number };
  }));

  /* Target: what was handed to it before its renderer listened */
  ipcMain.handle('window:take-adoptions', wrapHandler(async (event) => windowRegistry.takeAdoptions(event.sender)));

  /* Step 3 (target): tabs created; then per session, screen restored */
  ipcMain.handle('window:move-adopted', wrapHandler(async (event, moveId) => windowRegistry.adopted(moveId, event.sender)));
  ipcMain.handle('window:move-ready', wrapHandler(async (event, moveId, sessionId) => {
    return windowRegistry.commit(moveId, sessionId, event.sender);
  }));
  /* Only the two windows of the move may call it off */
  ipcMain.handle('window:move-abort', wrapHandler(async (event, moveId) => {
    const move = windowRegistry.getMove(moveId);
    if (!move) return false;
    if (move.from !== event.sender && move.to !== event.sender) {
      console.warn('[IPC] window:move-abort: refused, not a window of that move');
      throw new Error('That move belongs to another window');
    }
    return windowRegistry.abort(moveId, 'cancelled');
  }));

  /* A tab of window `fromWindowId` dropped on this window's tab bar: ask the
     source to move it here (only the source can serialize its terminals). */
  ipcMain.handle('window:request-move', wrapHandler(async (event, spec = {}) => {
    const from = windowRegistry.byId(spec.fromWindowId);
    const to = windowRegistry.entryOf(event.sender);
    if (!from || !to || from.wc === to.wc) return false;
    return windowRegistry.sendTo(from.wc, 'window:move-request', {
      tabId: spec.tabId, targetId: to.id, index: Number.isInteger(spec.index) ? spec.index : null,
    });
  }));

  /* A tab drag ended without a drop target: where is the pointer? Over
     another Termilab window (move there), outside every window (new window
     there), or over this one (nothing). */
  ipcMain.handle('window:drop-target', wrapHandler(async (event) => {
    const { screen } = require('electron');
    const p = screen.getCursorScreenPoint();
    const self = windowRegistry.entryOf(event.sender);
    const inside = (e) => {
      try {
        const b = e.win.getBounds();
        return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      } catch (_) { return false; }
    };
    if (self && self.win && inside(self)) return { kind: 'self', x: p.x, y: p.y };
    const other = windowRegistry.liveWindows().find(e => e.win && e !== self && inside(e));
    if (other) return { kind: 'window', id: other.id, x: p.x, y: p.y };
    return { kind: 'outside', x: p.x, y: p.y };
  }));

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

  /* A pull rewrites the store under every window. The one that asked
     reloads itself (as before); the others are told. */
  ipcMain.handle('sync:now', wrapHandler(changing('all', async () => {
    return await syncService.syncNow();
  })));

  // Boveda: la clave maestra sale del passphrase de la cuenta. El passphrase
  // llega aqui y va directo al servicio; no se registra ni vuelve en el sobre.
  ipcMain.handle('sync:setup-passphrase', wrapHandler(changing('all', async (event, passphrase) => {
    return await syncService.setupPassphrase(passphrase);
  })));

  ipcMain.handle('sync:unlock', wrapHandler(changing('all', async (event, passphrase) => {
    return await syncService.unlock(passphrase);
  })));

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

/* Where a new window opens: centred-ish on {x, y} (a drop point), else
   offset from the window that asked. Same size as that window. */
function placeNear(event, opts = {}) {
  const src = winOf(event);
  let bounds = null;
  try { bounds = src && src.getBounds ? src.getBounds() : null; } catch (_) { bounds = null; }
  const width = bounds ? bounds.width : 1200;
  const height = bounds ? bounds.height : 800;
  if (Number.isFinite(opts.x) && Number.isFinite(opts.y)) {
    return { x: Math.round(opts.x - Math.min(200, width / 4)), y: Math.round(opts.y - 20), width, height };
  }
  if (bounds) return { x: bounds.x + 32, y: bounds.y + 32, width, height };
  return { width, height };
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
    'window:info', 'window:list', 'window:attention', 'window:new', 'window:move-begin', 'window:move-transfer',
    'window:take-adoptions', 'window:move-adopted', 'window:move-ready', 'window:move-abort',
    'window:request-move', 'window:drop-target',
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

module.exports = { registerIpcHandlers, removeIpcHandlers, attachWindow, setQuitting, endWindowSessions, attention };
