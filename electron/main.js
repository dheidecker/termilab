const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const { registerIpcHandlers, removeIpcHandlers } = require('./ipc-handlers');
const sshService = require('./services/ssh-service');
const sftpService = require('./services/sftp-service');
const portForwardService = require('./services/port-forward-service');
const localShellService = require('./services/local-shell-service');

// Prevent garbage collection of mainWindow
let mainWindow = null;

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
      webviewTag: true,
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
      autoUpdater.quitAndInstall(false, true);
    });

    // IPC: Get current version
    ipcMain.handle('updater:version', () => {
      return app.getVersion();
    });

    // Check for updates after a short delay
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
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

// Cleanup on quit
app.on('before-quit', async () => {
  try {
    await sshService.disconnectAll();
    sftpService.closeAll();
    await portForwardService.stopAll();
    await localShellService.killAll();
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
