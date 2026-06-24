const { Client } = require('ssh2');
const crypto = require('crypto');

class SSHService {
  constructor() {
    /** @type {Map<string, { client: Client, stream: any, config: object }>} */
    this.sessions = new Map();
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
      console.error(`[SSHService] Failed to send to renderer on ${channel}:`, err.message);
    }
  }

  async connect(config) {
    const sessionId = crypto.randomUUID();
    const client = new Client();

    return new Promise((resolve, reject) => {
      const connectionTimeout = setTimeout(() => {
        client.end();
        reject(new Error('Connection timed out after 30 seconds'));
      }, config.timeout || 30000);

      client.on('ready', () => {
        clearTimeout(connectionTimeout);

        const shellOpts = {
          term: config.term || 'xterm-256color',
          cols: config.cols || 80,
          rows: config.rows || 24,
          env: config.env || {},
        };

        client.shell(shellOpts, (err, stream) => {
          if (err) {
            client.end();
            return reject(new Error(`Failed to open shell: ${err.message}`));
          }

          this.sessions.set(sessionId, { client, stream, config });

          stream.on('data', (data) => {
            this._send('ssh:data', sessionId, data.toString('utf-8'));
          });

          stream.stderr.on('data', (data) => {
            this._send('ssh:data', sessionId, data.toString('utf-8'));
          });

          stream.on('close', () => {
            this._send('ssh:close', sessionId);
            this._cleanup(sessionId);
          });

          stream.on('error', (err) => {
            this._send('ssh:error', sessionId, err.message);
          });

          resolve(sessionId);
        });
      });

      client.on('error', (err) => {
        clearTimeout(connectionTimeout);
        this._send('ssh:error', sessionId, err.message);
        this._cleanup(sessionId);
        reject(new Error(`SSH connection error: ${err.message}`));
      });

      client.on('close', () => {
        clearTimeout(connectionTimeout);
        if (this.sessions.has(sessionId)) {
          this._send('ssh:close', sessionId);
          this._cleanup(sessionId);
        }
      });

      client.on('end', () => {
        if (this.sessions.has(sessionId)) {
          this._send('ssh:close', sessionId);
          this._cleanup(sessionId);
        }
      });

      client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        // For keyboard-interactive auth, send the password
        const responses = prompts.map(() => config.password || '');
        finish(responses);
      });

      // Build ssh2 connection config
      const sshConfig = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        readyTimeout: config.timeout || 30000,
        keepaliveInterval: config.keepAliveInterval || 30000,
        keepaliveCountMax: config.keepAliveCountMax || 3,
        tryKeyboard: true,
      };

      // Authentication: private key takes priority over password
      if (config.privateKey) {
        sshConfig.privateKey = config.privateKey;
        if (config.passphrase) {
          sshConfig.passphrase = config.passphrase;
        }
      } else if (config.password) {
        sshConfig.password = config.password;
      }

      // Agent forwarding
      if (config.agent) {
        sshConfig.agent = config.agent;
      } else if (process.env.SSH_AUTH_SOCK) {
        sshConfig.agent = process.env.SSH_AUTH_SOCK;
      }

      // Compression
      if (config.compress !== undefined) {
        sshConfig.algorithms = {
          compress: config.compress ? ['zlib@openssh.com', 'zlib', 'none'] : ['none'],
        };
      }

      // Host key verification - we accept all for now (TODO: known_hosts support)
      sshConfig.hostVerifier = () => true;

      try {
        client.connect(sshConfig);
      } catch (err) {
        clearTimeout(connectionTimeout);
        reject(new Error(`Failed to initiate SSH connection: ${err.message}`));
      }
    });
  }

  async disconnect(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    try {
      if (session.stream) {
        session.stream.close();
      }
      session.client.end();
    } catch (err) {
      console.error(`[SSHService] Error disconnecting session ${sessionId}:`, err.message);
    } finally {
      this._cleanup(sessionId);
    }
  }

  sendData(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.stream) {
      console.warn(`[SSHService] No active stream for session ${sessionId}`);
      return;
    }
    try {
      session.stream.write(data);
    } catch (err) {
      console.error(`[SSHService] Error writing to session ${sessionId}:`, err.message);
      this._send('ssh:error', sessionId, `Write error: ${err.message}`);
    }
  }

  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.stream) {
      return;
    }
    try {
      session.stream.setWindow(rows, cols, 0, 0);
    } catch (err) {
      console.error(`[SSHService] Error resizing session ${sessionId}:`, err.message);
    }
  }

  getClient(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? session.client : null;
  }

  isConnected(sessionId) {
    return this.sessions.has(sessionId);
  }

  _cleanup(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        if (session.stream) {
          session.stream.removeAllListeners();
        }
        session.client.removeAllListeners();
      } catch (_) { /* ignore cleanup errors */ }
      this.sessions.delete(sessionId);
    }
  }

  async disconnectAll() {
    const sessionIds = Array.from(this.sessions.keys());
    for (const id of sessionIds) {
      await this.disconnect(id);
    }
  }
}

module.exports = new SSHService();
