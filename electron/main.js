const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');

const { registerIpcHandlers, removeIpcHandlers, attachWindow, setQuitting, keptSessionsOf, endKeptWhenClosed } = require('./ipc-handlers');
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
/* deb/pacman: relaunch ourselves after the install (see updater:install).
   Armed only once the updater says it is really quitting for the update. */
let relaunchAfterUpdate = false;   // asked for: a deb/pacman install was clicked
let relaunchArmed = false;         // the install succeeded and the app is quitting for it
let relaunchScheduled = false;     // one waiter, however many will-quit passes
let quittingForUpdate = false;     // before-quit-for-update came: the install went through
// Windows exist (or the restore is creating them): second-instance may act
let launched = false;
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

  win.on('close', (event) => confirmClose(win, event));

  win.on('closed', () => {
    windows.delete(win);
  });

  return win;
}

/* Closing one of several windows ends its sessions (like closing its tabs):
   ask first if it has any. The last window closes as it always did.
   Kept sessions (session keeper) are the exception: closing only detaches
   them, so the question is whether to leave them running in the background
   (Background sessions lists them) or end them on the server too. */
function confirmClose(win, event) {
  if (quitCleanupDone || closeConfirmed.has(win)) return;
  const others = [...windows].filter(w => w !== win && !w.isDestroyed());
  if (others.length === 0) return;
  const open = windowRegistry.sessionsOf(win.webContents).length;
  if (open === 0) return;
  event.preventDefault();
  const kept = keptSessionsOf(win).length;
  const plural = (n, one, many) => (n === 1 ? one : many.replace('#', n));
  const ask = kept === 0
    ? {
      buttons: ['Close Window', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: plural(open, 'Close this window and its open session?', 'Close this window and its # open sessions?'),
      detail: 'Any running process in them will be terminated.',
    }
    : {
      buttons: ['Keep Running in Background', 'End Sessions', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: plural(kept, 'This window has a session kept alive in the background.', 'This window has # sessions kept alive in the background.'),
      detail: 'Keep them running to reopen them later from Background sessions, or end them and every process in them.'
        + (open > kept ? ` ${plural(open - kept, 'The other open session', `The other ${open - kept} open sessions`)} will be terminated either way.` : ''),
    };
  dialog.showMessageBox(win, { type: 'question', ...ask }).then(({ response }) => {
    if (response === ask.cancelId || win.isDestroyed()) return;
    if (kept > 0 && response === 1) endKeptWhenClosed(win);
    closeConfirmed.add(win);
    win.close();
  }).catch(() => {});
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

    /* Emitted only when the update really is being installed (electron's
       native autoUpdater; electron-updater's BaseUpdater emits it on it after a
       successful install, right before app.quit()). */
    try {
      require('electron').autoUpdater.on('before-quit-for-update', () => {
        quittingForUpdate = true;
        installingUpdate = true;
        if (relaunchAfterUpdate) relaunchArmed = true;
      });
    } catch (err) {
      console.error('[Updater] before-quit-for-update unavailable:', err.message);
    }

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
      /* deb/pacman: electron-updater would relaunch through app.relaunch(),
         and Chromium's relauncher starts the new Termilab with
         no_new_privs set, which breaks snap/sudo in local terminals until
         the user reopens the app by hand. Relaunch it ourselves instead,
         from a detached waiter (through systemd --user when there is one, so
         it never inherits our own no_new_privs either). */
      const pkgType = linuxPackageType();
      relaunchAfterUpdate = pkgType === 'deb' || pkgType === 'pacman';
      if (relaunchAfterUpdate) autoUpdater.autoRunAppAfterInstall = false;
      autoUpdater.quitAndInstall(false, true);
      /* The deb/pacman/NSIS/AppImage install runs synchronously inside
         quitAndInstall; on success electron-updater queues
         before-quit-for-update + app.quit() with setImmediate (queued before
         this one). Still not quitting here = it failed (pkexec cancelled,
         dpkg/pacman error, already running): undo, so the next ordinary
         quit is ordinary. macOS installs asynchronously (Squirrel): left as is. */
      if (process.platform !== 'darwin') {
        setImmediate(() => {
          if (quittingForUpdate || quitCleanupDone) return;
          installingUpdate = false;
          relaunchAfterUpdate = false;
          autoUpdater.autoRunAppAfterInstall = true;
        });
      }
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

// ─── Relaunch after a Linux package update ─────────────────

/* `resources/package-type` decides electron-updater's Linux updater class:
   'deb' / 'pacman'; the AppImage has none (and relaunches by spawning itself). */
function linuxPackageType() {
  if (process.platform !== 'linux') return null;
  try {
    return require('fs').readFileSync(require('path').join(process.resourcesPath, 'package-type'), 'utf-8').trim();
  } catch (_) {
    return null;
  }
}

/* Waits for this process to exit, then starts Termilab again. */
function relaunchDetached() {
  try {
    const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; '
      + 'state=$(systemctl --user is-system-running 2>/dev/null); '
      + 'if command -v systemd-run >/dev/null 2>&1 && { [ "$state" = running ] || [ "$state" = degraded ]; }; then '
      + 'exec systemd-run --user --collect --quiet -- "$0"; fi; exec "$0"';
    const child = require('child_process').spawn('/bin/sh', ['-c', script, process.execPath, String(process.pid)], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    console.error('[Updater] Could not schedule the relaunch:', err.message);
  }
}

// ─── App Lifecycle ──────────────────────────────────────

/* The single will-quit listener for the deb/pacman relaunch: it acts only
   once the install succeeded (relaunchArmed), and schedules one waiter. */
app.on('will-quit', () => {
  if (!relaunchArmed || relaunchScheduled) return;
  relaunchScheduled = true;
  relaunchDetached();
});

/* One Termilab per user (per userData): a second launch would restore the
   same workspace, re-attach the same kept sessions (kicking the first
   instance's tabs) and both would overwrite workspace.json. The second one
   hands over to the first and quits. Dev runs are exempt: they share the
   installed app's userData and must start while it is open.
   The updater relaunch is unaffected: its waiter starts the new instance
   only after this process has exited (and released the lock). */
const isDevRun = !!process.env.VITE_DEV_SERVER_URL;
const primaryInstance = isDevRun || app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => onSecondInstance());
}

/** Another launch: bring this instance forward (a fresh window if none is open). */
function onSecondInstance() {
  if (!launched) return;   // still restoring: its windows are on their way
  const live = [...windows].filter(w => !w.isDestroyed());
  if (live.length === 0) { createWindow(); return; }
  const win = live.find(w => w.isFocused && w.isFocused()) || live[live.length - 1];
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

app.whenReady().then(async () => {
  if (!primaryInstance) return;
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
  launched = true;
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
  // The second instance quitting at once owns nothing: it must not write the workspace
  if (!primaryInstance) return;
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

/* scripts/lib/check-main-lifecycle.js loads this file with a stubbed electron */
module.exports = {
  _test: {
    windows,
    confirmClose,
    setupAutoUpdater,
    onSecondInstance,
    markLaunched: () => { launched = true; },
    state: () => ({ installingUpdate, relaunchAfterUpdate, relaunchArmed, relaunchScheduled, primaryInstance }),
  },
};
