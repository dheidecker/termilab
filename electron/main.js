const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const { registerIpcHandlers, removeIpcHandlers } = require('./ipc-handlers');
const sshService = require('./services/ssh-service');
const sftpService = require('./services/sftp-service');
const transferService = require('./services/transfer-service');
const sftpEditService = require('./services/sftp-edit-service');
const portForwardService = require('./services/port-forward-service');
const localShellService = require('./services/local-shell-service');
const syncService = require('./services/sync-service');
const hostKeyService = require('./services/host-key-service');
const connectionLogService = require('./services/connection-log-service');

// Prevent garbage collection of mainWindow
let mainWindow = null;
// before-quit holds the first quit until the history is written (see below)
let quitCleanupDone = false;
let installingUpdate = false;
const QUIT_LOG_TIMEOUT_MS = 2000;

function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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

  // Register all IPC handlers with the window reference
  registerIpcHandlers(mainWindow);

  // Show window once content is ready to avoid white flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    // Open DevTools in development
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Handle external links - open in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const { shell } = require('electron');
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', { status, ...data });
  }
}

// ─── App Lifecycle ──────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
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
  if (installingUpdate) {
    connectionLogService.closeAllSync();
  } else {
    event.preventDefault();
    let timer;
    Promise.race([
      connectionLogService.closeAllForQuit(QUIT_LOG_TIMEOUT_MS),
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
