const os = require('os');
const crypto = require('crypto');

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
  async spawn(options = {}) {
    if (!pty) {
      throw new Error('node-pty is not installed. Run: npm install node-pty');
    }

    const sessionId = crypto.randomUUID();
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
    delete env.ELECTRON_RUN_AS_NODE;

    try {
      const shellArgs = process.platform === 'win32' ? [] : ['--login'];

      const ptyProcess = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
        useConpty: process.platform === 'win32',
      });

      this.shells.set(sessionId, ptyProcess);

      ptyProcess.onData((data) => {
        this._send('local:data', sessionId, data);
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        this._send('local:close', sessionId, exitCode, signal);
        this.shells.delete(sessionId);
      });

      return sessionId;
    } catch (err) {
      throw new Error(`Failed to spawn local shell "${shell}": ${err.message}`);
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
    try {
      shell.kill();
    } catch (err) {
      console.error(`[LocalShellService] Error killing session ${sessionId}:`, err.message);
    } finally {
      this.shells.delete(sessionId);
    }
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
}

module.exports = new LocalShellService();
