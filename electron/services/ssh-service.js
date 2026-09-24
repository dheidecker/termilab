const { Client } = require('ssh2');
const crypto = require('crypto');
const { detectOs } = require('./os-detect');
const hostKeyService = require('./host-key-service');
const connectionLogService = require('./connection-log-service');

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
    /* Known key types for this host:port first, so a server with several host
       keys presents one we already trust (see known-hosts hostKeyAlgorithms). */
    const serverHostKey = await hostKeyService.algorithmsFor(config.host, config.port || 22);

    return new Promise((resolve, reject) => {
      const timeoutMs = config.timeout || 30000;
      let connectionTimeout = null;
      /* Socket gone: nothing may re-arm the timeout after this (the dialog
         settling late would otherwise report "timed out" 30 s later). */
      let closed = false;
      const armTimeout = () => {
        clearTimeout(connectionTimeout);
        if (closed) return;
        connectionTimeout = setTimeout(() => {
          client.end();
          reject(new Error(`Connection timed out after ${Math.round(timeoutMs / 1000)} seconds`));
        }, timeoutMs);
      };
      armTimeout();

      /* Host key check. While the user reads the dialog (up to 2 min) neither
         our timeout nor ssh2's readyTimeout may fire; ours is re-armed once
         they answer and covers the rest of the handshake. */
      const verifier = hostKeyService.createVerifier(config.host, config.port || 22, {
        onPrompt: () => {
          clearTimeout(connectionTimeout);
          clearTimeout(client._readyTimeout);
        },
        onSettled: () => armTimeout(),
      });
      const hostKeyError = () => new Error(
        `Host key rejected: the key presented by ${config.host}:${config.port || 22} was not accepted, so the connection was closed.`
      );

      /* History for the Logs section: who, where, when. Nothing else. */
      const startLog = () => connectionLogService.start({
        type: config.purpose === 'sftp' ? 'sftp' : 'ssh',
        hostId: config.hostId,
        label: config.label,
        hostname: config.host,
        port: config.port || 22,
        username: config.username,
      });

      /* Best effort, after the session is already handed back: one exec on
         the same client to learn the distro for the host card. Any failure
         is swallowed inside detectOs. */
      const detectAfterReady = (logId) => setImmediate(() => {
        if (this.sessions.get(sessionId)?.client !== client) return;
        detectOs(client, (os) => {
          connectionLogService.setOs(logId, os);
          if (this.sessions.get(sessionId)?.client !== client) return;
          this._send('ssh:os-detected', { sessionId, os });
        });
      });

      client.on('ready', () => {
        clearTimeout(connectionTimeout);

        /* An SFTP pane's own connection: no shell, no pty. The SFTP channel
           is opened on this client by sftp-service; 'ssh:close' still comes
           from client 'close'/'end' below. */
        if (config.purpose === 'sftp') {
          const logId = startLog();
          this.sessions.set(sessionId, { client, stream: null, config, logId });
          resolve(sessionId);
          detectAfterReady(logId);
          return;
        }

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

          const logId = startLog();

          this.sessions.set(sessionId, { client, stream, config, logId });

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
          detectAfterReady(logId);
        });
      });

      client.on('error', (err) => {
        clearTimeout(connectionTimeout);
        verifier.cancel();
        const error = verifier.wasRejected() ? hostKeyError() : null;
        this._send('ssh:error', sessionId, error ? error.message : err.message);
        this._cleanup(sessionId);
        reject(error || new Error(`SSH connection error: ${err.message}`));
      });

      client.on('close', () => {
        closed = true;
        clearTimeout(connectionTimeout);
        /* Read before cancel(): cancelling resolves the pending decision. */
        const waitingOnUser = verifier.isPending();
        verifier.cancel();
        if (verifier.wasRejected()) reject(hostKeyError());
        else if (waitingOnUser) {
          reject(new Error(`${config.host}:${config.port || 22} closed the connection while the host key was waiting for confirmation.`));
        } else if (!this.sessions.has(sessionId)) {
          /* Closed before the shell was up, with no 'error': say so now
             instead of waiting for the timeout. No-op once resolved. */
          reject(new Error(`The connection to ${config.host}:${config.port || 22} closed before it was ready.`));
        }
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
      if (serverHostKey) {
        sshConfig.algorithms = { ...(sshConfig.algorithms || {}), serverHostKey };
      }

      // Host key verification: known_hosts-style TOFU, see host-key-service.js
      sshConfig.hostVerifier = verifier.hostVerifier;

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
      connectionLogService.end(session.logId);
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
