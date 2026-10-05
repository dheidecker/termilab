const os = require('os');
const crypto = require('crypto');
const connectionLogService = require('./connection-log-service');
const windowRegistry = require('../window-registry');
const ptyEscape = require('./local-shell-escape');
const localKeeper = require('./local-keeper');
const backgroundSessions = require('./background-sessions');

/* What a kept session's attach exit means (keeper README), said in the tab */
const KEPT_EXIT_LINES = {
  75: '\r\n\x1b[33m[Session opened in another tab]\x1b[0m\r\n',
  76: '\r\n\x1b[33m[Session ended (killed or expired)]\x1b[0m\r\n',
  101: '\r\n\x1b[31m[Session keeper error (exit 101)]\x1b[0m\r\n',
  102: '\r\n\x1b[33m[That background session no longer exists]\x1b[0m\r\n',
  103: '\r\n\x1b[31m[Too many background sessions on this computer (20)]\x1b[0m\r\n',
  104: '\r\n\x1b[31m[Session keeper error: protocol mismatch (exit 104)]\x1b[0m\r\n',
};

let pty;
try {
  pty = require('node-pty');
} catch (err) {
  console.warn('[LocalShellService] node-pty not available. Local terminal will not work.');
  console.warn('[LocalShellService] Install it with: npm install node-pty');
  pty = null;
}

class LocalShellService {
  constructor() {
    /** @type {Map<string, import('node-pty').IPty>} */
    this.shells = new Map();
    /** sessionId -> systemd unit name, only for shells started via systemd-run */
    this.units = new Map();
    /** sessionId -> connection-log entry id */
    this.logIds = new Map();
    /** sessionId -> { pty, kept, closing } (the pty now behind that id) */
    this.ents = new Map();
    /** sessionId -> { kept, notice } of its spawn */
    this.infos = new Map();
    /* Local session keeper (local-keeper.js); the harness can turn it off */
    this.keeperEnabled = true;
    /** @type {import('electron').BrowserWindow | null} */
    this.mainWindow = null;
  }

  setMainWindow(win) {
    this.mainWindow = win;
  }

  _send(channel, ...args) {
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(channel, ...args);
      }
    } catch (err) {
      console.error(`[LocalShellService] Failed to send to renderer on ${channel}:`, err.message);
    }
  }

  _getDefaultShell() {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }

  /**
   * Spawn a new local shell process.
   * @param {object} [options]
   * @param {string} [options.shell] - Shell executable path
   * @param {number} [options.cols=80] - Initial columns
   * @param {number} [options.rows=24] - Initial rows
   * @param {string} [options.cwd] - Working directory
   * @param {object} [options.env] - Additional environment variables
   * @returns {Promise<string>} - Session ID
   */
  async spawn(options = {}, owner = null) {
    if (!pty) {
      throw new Error('node-pty is not installed. Run: npm install node-pty');
    }

    const sessionId = crypto.randomUUID();
    /* `owner`: the window whose renderer asked; its events go only there */
    if (owner) windowRegistry.claim(sessionId, owner);
    const shell = options.shell || this._getDefaultShell();
    const cols = options.cols || 80;
    const rows = options.rows || 24;
    const cwd = options.cwd || os.homedir();

    // Merge environment: inherit process.env, add custom vars
    const env = {
      ...process.env,
      ...(options.env || {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };

    // Remove Electron-specific env vars that can confuse child processes
    // Electron pollutes the env with paths pointing to its own bundled libs,
    // which breaks snap-confine and other system tools
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ASAR;
    delete env.NODE_OPTIONS;
    // Electron's LD_LIBRARY_PATH points to its own libs and breaks snap-confine
    delete env.LD_LIBRARY_PATH;
    delete env.LD_PRELOAD;
    // GTK/GDK vars from Electron can also cause issues
    delete env.GDK_BACKEND;
    delete env.GTK_IM_MODULE;
    delete env.CHROME_DESKTOP;
    delete env.ORIGINAL_XDG_CURRENT_DESKTOP;

    /* Session keeper (local-keeper.js), Linux: the tab's pty runs an attach
       client of a kept session instead of the shell, so the shell outlives
       the tab, the window and Termilab. Anything that keeps it from working
       is a plain shell plus one dim line, as today. */
    let kept = null;
    let notice = null;
    if (options.sessionKey && process.platform === 'linux' && this.keeperEnabled && await localKeeper.wanted()) {
      try {
        const k = await localKeeper.open({ sessionKey: options.sessionKey, cols, rows, cwd, shell, env: { ...(options.env || {}), TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
        if (k.fallback) notice = `Session keeping unavailable for local terminals (${k.reason}): using a plain shell`;
        else kept = k;
      } catch (err) {
        notice = `Session keeping unavailable for local terminals (${err.message}): using a plain shell`;
      }
    }

    try {
      const shellArgs = process.platform === 'win32' ? [] : ['--login'];
      let file = shell;
      let args = shellArgs;
      let spawnEnv = env;
      let unit = null;
      if (kept) {
        /* The attach client needs no escape: the shell is the daemon's child
           (started by the user manager when there is one, see local-keeper) */
        file = kept.bin;
        args = kept.args;
        spawnEnv = { ...env, SHELL: shell };
      } else {
        /* Linux with no_new_privs (Termilab relaunched by the updater): the
           shell is started by the user's systemd instead, so snap, sudo and
           friends work. See local-shell-escape.js. */
        const decision = process.platform === 'linux'
          ? await ptyEscape.launchDecision()
          : { mode: 'direct' };
        if (decision.mode === 'systemd-run') {
          unit = ptyEscape.unitName(sessionId);
          spawnEnv = ptyEscape.filterEnv(process.env, { ...(options.env || {}), TERM: 'xterm-256color', COLORTERM: 'truecolor' });
          file = decision.systemdRun;
          args = ptyEscape.buildSystemdRunArgs({ unit, shell, shellArgs, setenv: spawnEnv });
        }
      }

      const spec = { file, args, cwd, env: spawnEnv, cols, rows };
      this._launch(sessionId, spec, kept ? { ...kept, spec, reattaches: [], sessionKey: String(options.sessionKey) } : null);
      if (unit) this.units.set(sessionId, unit);
      this.infos.set(sessionId, { kept: !!kept, notice });
      /* Logs section: start/end only, never what was typed or printed */
      const logId = connectionLogService.start({ type: 'local' });
      this.logIds.set(sessionId, logId);
      return sessionId;
    } catch (err) {
      windowRegistry.release(sessionId);
      throw new Error(`Failed to spawn local shell "${shell}": ${err.message}`);
    }
  }

  /** {kept, notice} of a spawn (local:spawn returns it with the id) */
  spawnInfo(sessionId) {
    return this.infos.get(sessionId) || { kept: false, notice: null };
  }

  /* One pty for session `sessionId` (a reattach replaces it under the same id) */
  _launch(sessionId, spec, kept) {
    const ptyProcess = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
      useConpty: process.platform === 'win32',
    });
    const ent = { pty: ptyProcess, kept, closing: false };
    this.ents.set(sessionId, ent);
    /* Attached into a tab again: no longer a Background session */
    if (kept) backgroundSessions.remove(kept.id);
    this.shells.set(sessionId, ptyProcess);

    ptyProcess.onData((data) => {
      if (this.ents.get(sessionId) !== ent) return;
      this._send('local:data', sessionId, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      if (this.ents.get(sessionId) !== ent) return;
      if (kept && !ent.closing && this._reattach(sessionId, ent, exitCode, signal)) return;
      if (kept && !ent.closing) {
        /* 0 the shell exited, 76 killed/expired, 102 no such session: it is over */
        if (exitCode === 0 || exitCode === 76 || exitCode === 102) backgroundSessions.remove(kept.id);
        const line = KEPT_EXIT_LINES[exitCode];
        if (line) this._send('local:data', sessionId, line);
      }
      this._send('local:close', sessionId, exitCode, signal);
      this.ents.delete(sessionId);
      this.shells.delete(sessionId);
      this.units.delete(sessionId);
      this.infos.delete(sessionId);
      this._endLog(sessionId);
      windowRegistry.release(sessionId);
    });
    return ent;
  }

  /*
   * The attach client went away on its own (77: SIGHUP/SIGTERM from someone
   * else, or killed by a signal) while the tab is open: the session lives on,
   * so attach again in the same pty slot (the replay repaints the screen).
   * At most 3 times a minute. → true when it reattached.
   */
  _reattach(sessionId, ent, exitCode, signal) {
    if (!(exitCode === 77 || signal > 0)) return false;
    const k = ent.kept;
    const now = Date.now();
    k.reattaches = k.reattaches.filter(t => now - t < 60000);
    if (k.reattaches.length >= 3) return false;
    k.reattaches.push(now);
    const size = ent.size || { cols: k.spec.cols, rows: k.spec.rows };
    const spec = { ...k.spec, ...size, args: localKeeper.attachArgs(k.id, size.cols, size.rows, false) };
    try {
      const next = this._launch(sessionId, spec, k);
      next.size = size;
      return true;
    } catch (err) {
      console.error(`[LocalShellService] reattach of ${sessionId} failed:`, err.message);
      return false;
    }
  }

  /**
   * Write data to a local shell.
   * @param {string} sessionId
   * @param {string} data
   */
  write(sessionId, data) {
    const shell = this.shells.get(sessionId);
    if (!shell) {
      console.warn(`[LocalShellService] No active shell for session ${sessionId}`);
      return;
    }
    try {
      shell.write(data);
    } catch (err) {
      console.error(`[LocalShellService] Error writing to session ${sessionId}:`, err.message);
      this._send('local:error', sessionId, `Write error: ${err.message}`);
    }
  }

  /**
   * Resize a local shell's PTY.
   * @param {string} sessionId
   * @param {number} cols
   * @param {number} rows
   */
  resize(sessionId, cols, rows) {
    const shell = this.shells.get(sessionId);
    if (!shell) return;
    const ent = this.ents.get(sessionId);
    if (ent) ent.size = { cols, rows };
    try {
      shell.resize(cols, rows);
    } catch (err) {
      console.error(`[LocalShellService] Error resizing session ${sessionId}:`, err.message);
    }
  }

  /**
   * Kill a local shell process.
   * @param {string} sessionId
   */
  async kill(sessionId) {
    const shell = this.shells.get(sessionId);
    if (!shell) return;
    /* A kept session's attach gets SIGHUP and detaches (77): the session lives on */
    const ent = this.ents.get(sessionId);
    if (ent) ent.closing = true;
    try {
      shell.kill();
    } catch (err) {
      console.error(`[LocalShellService] Error killing session ${sessionId}:`, err.message);
    } finally {
      this.shells.delete(sessionId);
      /* SIGHUP to systemd-run already ends the unit; this is the safety net */
      const unit = this.units.get(sessionId);
      if (unit) { this.units.delete(sessionId); ptyEscape.stopUnit(unit); }
      this._endLog(sessionId);
    }
  }

  _endLog(sessionId) {
    const logId = this.logIds.get(sessionId);
    if (!logId) return;
    this.logIds.delete(sessionId);
    connectionLogService.end(logId);
  }

  /**
   * Kill all active local shells.
   */
  async killAll() {
    const sessionIds = Array.from(this.shells.keys());
    for (const id of sessionIds) {
      await this.kill(id);
    }
  }

  /**
   * Check if a session is active.
   */
  isActive(sessionId) {
    return this.shells.has(sessionId);
  }

  /* ── Session keeper, for local terminals (local-keeper.js) ── */

  /** {id, sessionKey} of the kept session behind this tab's pty, or null */
  keptInfo(sessionId) {
    if (!this.isKept(sessionId)) return null;
    const k = this.ents.get(sessionId).kept;
    return { id: k.id, sessionKey: k.sessionKey || null };
  }

  /** Is this tab's pty an attach client of a kept session? */
  isKept(sessionId) {
    const ent = this.ents.get(sessionId);
    return !!(ent && ent.kept && this.shells.has(sessionId));
  }

  /**
   * What closing this tab would interrupt, same shape as ssh:keeper-foreground:
   * {keeper:false} | {keeper:true, fgCommand, isShell, jobs, missing?}
   */
  async keeperForeground(sessionId) {
    const ent = this.ents.get(sessionId);
    if (!ent || !ent.kept || !this.shells.has(sessionId)) return { keeper: false };
    try {
      const fg = await localKeeper.foreground(ent.kept.bin, ent.kept.id);
      if (!fg) return { keeper: true, fgCommand: null, isShell: false, missing: true };
      const jobs = fg.isShell && fg.shellPid ? localKeeper.children(fg.shellPid) : [];
      return { keeper: true, fgCommand: fg.fgCommand, isShell: fg.isShell, jobs };
    } catch (_) {
      return { keeper: true, fgCommand: null, isShell: false };
    }
  }

  /** End the kept session itself (KILL), then close the tab's pty */
  async keeperEnd(sessionId) {
    const ent = this.ents.get(sessionId);
    if (ent && ent.kept) {
      ent.closing = true;
      try { await localKeeper.kill(ent.kept.bin, ent.kept.id); } catch (err) {
        console.error(`[LocalShellService] keeper kill for ${sessionId} failed:`, err.message);
      }
    }
    await this.kill(sessionId);
    return true;
  }

  /** Local background sessions: {supported, installed, rows}. Never installs. */
  async keeperList() {
    if (process.platform !== 'linux') return { supported: false, installed: false, rows: [] };
    const bin = localKeeper.locate();
    if (!bin) return { supported: true, installed: false, rows: [] };
    const rows = await localKeeper.list(bin);
    return {
      supported: true,
      installed: true,
      rows: rows.map(r => ({
        id: r.id,
        fgCommand: r.fgCommand || null,
        created: r.created || null,
        lastAttach: r.lastAttach || null,
        attached: !!r.attached,
        keeperVersion: r.keeperVersion || null,
      })),
    };
  }

  async keeperKill(id) {
    const bin = localKeeper.locate();
    if (!bin) throw new Error('The session keeper is not installed on this computer');
    return localKeeper.kill(bin, id);
  }
}

module.exports = new LocalShellService();
