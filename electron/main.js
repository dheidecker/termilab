const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');

const { registerIpcHandlers, removeIpcHandlers, attachWindow, setQuitting } = require('./ipc-handlers');
const windowRegistry = require('./window-registry');
const sshService = require('./services/ssh-service');
const sftpService = require('./services/sftp-service');
const transferService = require('./services/transfer-service');
const sftpEditService = require('./services/sftp-edit-service');
const portForwardService = require('./services/port-forward-service');
const localShellService = require('./services/local-shell-service');
const syncService = require('./services/sync-service');
const hostKeyService = require('./services/host-key-service');
const connectionLogService = require('./services/connection-log-service');
const workspaceService = require('./services/workspace-service');

// Every open window (keeps them from being garbage collected). Several since
// multi-window; what goes to which one is electron/window-registry.js.
const windows = new Set();
let handlersRegistered = false;
// before-quit holds the first quit until the history is written (see below)
let quitCleanupDone = false;
let installingUpdate = false;
const QUIT_LOG_TIMEOUT_MS = 2000;
// Windows closed by the user after saying yes to "close its sessions?"
const closeConfirmed = new WeakSet();

/**
 * A full Termilab window (tab bar, Hosts, sidebar). `bounds` places it: a tab
 * dropped outside a window opens one where it was dropped.
 */
function createWindow(bounds = {}, { maximized = false } = {}) {
  const preloadPath = path.join(__dirname, 'preload.js');
  const first = windows.size === 0;

  const place = {};
  for (const k of ['x', 'y', 'width', 'height']) {
    if (Number.isFinite(bounds[k])) place[k] = Math.round(bounds[k]);
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...place,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : undefined,
    backgroundColor: '#0d1117',
    show: false,
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
      webviewTag: false,
    },
  });
  windows.add(win);

  // IPC handlers once, with the first window; every window joins the registry
  if (!handlersRegistered) {
    handlersRegistered = true;
    registerIpcHandlers(win);
  } else {
    attachWindow(win);
  }

  // Show window once content is ready to avoid white flash
  win.once('ready-to-show', () => {
    if (maximized) win.maximize();
    win.show();
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    // DevTools in development, for the first window only (they steal focus)
    if (first && !process.env.TERMILAB_NO_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Handle external links - open in default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    const { shell } = require('electron');
    shell.openExternal(url);
    return { action: 'deny' };
  });

  /* Closing one of several windows ends its sessions (like closing its tabs):
     ask first if it has any. The last window closes as it always did. */
  win.on('close', (event) => {
    if (quitCleanupDone || closeConfirmed.has(win)) return;
    const others = [...windows].filter(w => w !== win && !w.isDestroyed());
    if (others.length === 0) return;
    const open = windowRegistry.sessionsOf(win.webContents).length;
    if (open === 0) return;
    event.preventDefault();
    dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Close Window', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: open === 1 ? 'Close this window and its open session?' : `Close this window and its ${open} open sessions?`,
      detail: 'Any running process in them will be terminated.',
    }).then(({ response }) => {
      if (response !== 0 || win.isDestroyed()) return;
      closeConfirmed.add(win);
      win.close();
    }).catch(() => {});
  });

  win.on('closed', () => {
    windows.delete(win);
  });

  return win;
}

windowRegistry.setWindowFactory((bounds) => createWindow(bounds));

/* macOS has a visible app menu: give it New Window (Cmd+Shift+N). Elsewhere
   the window is frameless with no menu bar; the renderer handles Ctrl+Shift+N. */
function setupMenu() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow(nextToFocused()) },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

function nextToFocused() {
  const w = BrowserWindow.getFocusedWindow() || [...windows][0];
  if (!w || w.isDestroyed()) return {};
  const b = w.getBounds();
  return { x: b.x + 32, y: b.y + 32, width: b.width, height: b.height };
}

// ─── Auto-Updater ───────────────────────────────────────

function setupAutoUpdater() {
  // Always register IPC handlers so Settings UI doesn't crash
  const isDev = !!process.env.VITE_DEV_SERVER_URL;

  if (isDev) {
    // Dev mode: register stub handlers
    ipcMain.handle('updater:version', () => app.getVersion());
    ipcMain.handle('updater:check', async () => ({ success: false, error: 'Updates not available in dev mode' }));
    ipcMain.handle('updater:download', async () => ({ success: false, error: 'Updates not available in dev mode' }));
    ipcMain.handle('updater:install', () => {});
    return;
  }

  try {
    const { autoUpdater } = require('electron-updater');

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      sendUpdateStatus('checking');
    });

    autoUpdater.on('update-available', (info) => {
      sendUpdateStatus('available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes,
      });
    });

    autoUpdater.on('update-not-available', () => {
      sendUpdateStatus('up-to-date');
    });

    autoUpdater.on('download-progress', (progress) => {
      sendUpdateStatus('downloading', {
        percent: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      sendUpdateStatus('ready', { version: info.version });
    });

    autoUpdater.on('error', (err) => {
      sendUpdateStatus('error', { message: err.message });
    });

    // IPC: Check for updates
    ipcMain.handle('updater:check', async () => {
      try {
        const result = await autoUpdater.checkForUpdates();
        return { success: true, data: result };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // IPC: Download update
    ipcMain.handle('updater:download', async () => {
      try {
        await autoUpdater.downloadUpdate();
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // IPC: Install update (quit and install)
    ipcMain.handle('updater:install', () => {
      // The updater drives its own quit; before-quit must not hold it.
      installingUpdate = true;
      autoUpdater.quitAndInstall(false, true);
    });

    // IPC: Get current version
    ipcMain.handle('updater:version', () => {
      return app.getVersion();
    });

    // Check for updates after a short delay.
    // Log the failure: swallowing it meant a broken update feed looked
    // identical to "you are up to date", with nothing in the console.
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('[Updater] Startup check failed:', err.message);
      });
    }, 5000);

  } catch (err) {
    console.log('[Updater] electron-updater not available:', err.message);
  }
}

function sendUpdateStatus(status, data = {}) {
  // Every window: each has its own Settings → About and update banner
  windowRegistry.broadcast('updater:status', { status, ...data });
}

// ─── App Lifecycle ──────────────────────────────────────

app.whenReady().then(async () => {
  setupMenu();
  /* The windows of the last run (workspace-service.js), each where it was and
     with its tabs to recreate; or one fresh window. Never blocks the launch. */
  let plan = null;
  try {
    plan = await workspaceService.begin();
  } catch (err) {
    console.error('[Main] Could not read the saved workspace:', err.message);
  }
  if (plan && plan.windows.length) {
    for (const w of plan.windows) {
      const win = createWindow(w.bounds || {}, { maximized: w.maximized });
      workspaceService.assign(win, w);
    }
  } else {
    createWindow();
  }
  setupAutoUpdater();

  // Back to the window: pick up what other devices changed meanwhile.
  app.on('browser-window-focus', () => syncService.onFocus());

  // macOS: re-create window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup on quit.
// Electron does not await this handler, so the FIRST quit is held with
// preventDefault() until the open history entries are stamped under the store
// lock (a synchronous write here could overlap an in-flight async one and
// drop its entry). Then app.quit() again; the flag lets that second pass
// through, so there is no quit loop. closeAllForQuit has its own hard timeout
// and the race below is the backstop: quitting can never hang on it.
// An update install drives its own quit: no hold, synchronous stamp.
app.on('before-quit', async (event) => {
  if (quitCleanupDone) return;
  quitCleanupDone = true;
  // Windows closing from here on end nothing themselves: this handler does
  setQuitting(true);
  if (installingUpdate) {
    connectionLogService.closeAllSync();
    try { workspaceService.quitFlushSync(); } catch (err) { console.error('[Main] Could not save the workspace:', err.message); }
  } else {
    event.preventDefault();
    let timer;
    Promise.race([
      Promise.all([
        connectionLogService.closeAllForQuit(QUIT_LOG_TIMEOUT_MS),
        /* Windows, tabs and splits for the next launch, before anything closes */
        workspaceService.quitFlush().catch(err => console.error('[Main] Could not save the workspace:', err.message)),
      ]),
      new Promise(r => { timer = setTimeout(r, QUIT_LOG_TIMEOUT_MS + 500); }),
    ]).catch(err => console.error('[Main] Could not close history on quit:', err.message))
      .finally(() => { clearTimeout(timer); app.quit(); });
  }
  hostKeyService.rejectAll();
  // Transfers first (each deletes its .termilab-part), then the temp copies
  // of opened/edited remote files: nothing of SFTP may stay in /tmp.
  transferService.cancelAll();
  sftpEditService.closeAllSync();
  try {
    await sshService.disconnectAll();
    sftpService.closeAll();
    await portForwardService.stopAll();
    await localShellService.killAll();
    syncService.stop();
    removeIpcHandlers();
  } catch (err) {
    console.error('[Main] Cleanup error during quit:', err.message);
  }
});

// Prevent the app from crashing on unhandled errors
process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
});
