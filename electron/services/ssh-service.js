const { Client } = require('ssh2');
const crypto = require('crypto');
const { detectOs } = require('./os-detect');
const hostKeyService = require('./host-key-service');
const connectionLogService = require('./connection-log-service');
const windowRegistry = require('../window-registry');

/*
 * Auto-reconnect: when a terminal's connection drops without the user asking
 * (socket reset, server rebooted, keepalive gave up), the session keeps its id,
 * its window and its tab; the transport is redialled with these waits between
 * attempts (doubling, capped at 30 s: about 2 minutes in all) and a fresh shell
 * is opened on it. The user's own close, a shell that exited (`exit`, a
 * signal) and SFTP-only connections never reconnect.
 */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
/* Errors no retry can fix: stop at once instead of burning the schedule */
const PERMANENT_ERROR = /Host key rejected|authentication methods failed|closed the connection while the host key|window that opened this connection was closed/i;
/* Offered to every terminal connection, best first; the server picks the
   first it also has, so 'none' keeps any server working. SFTP-only
   connections skip it: zlib costs more CPU than it saves on bulk copies. */
const SHELL_COMPRESSION = ['zlib@openssh.com', 'zlib', 'none'];

class SSHService {
  constructor() {
    /** @type {Map<string, { client: Client, stream: any, config: object }>} */
    this.sessions = new Map();
    /** connects in flight: sessionId -> { cancelled, client } */
    this._connecting = new Map();
    /** @type {import('electron').BrowserWindow | null} */
    this.mainWindow = null;
    /* Auto-reconnect after an unexpected drop (see _lost). The waits before
       each attempt, in ms; the harness shrinks them. */
    this.reconnectDelays = RECONNECT_DELAYS_MS.slice();
    /* Per-attempt handshake timeout: an attempt must not eat the whole budget */
    this.reconnectAttemptTimeoutMs = 20000;
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

  /**
   * `owner` (the IPC event's sender) is the window this session's events go
   * to. Claimed before any listener exists: ssh2 can emit the first 'data'
   * synchronously, in the same tick that opens the shell.
   */
  async connect(config, owner) {
    const sessionId = crypto.randomUUID();
    if (owner) windowRegistry.claim(sessionId, owner);
    const pend = { cancelled: false, client: null };
    this._connecting.set(sessionId, pend);
    try {
      await this._connect(sessionId, config, pend);
      if (pend.cancelled) {
        /* Its window closed while it connected: nobody will ever show it */
        await this.disconnect(sessionId);
        throw new Error('The window that opened this connection was closed.');
      }
      return sessionId;
    } catch (err) {
      if (!this.sessions.has(sessionId)) windowRegistry.release(sessionId);
      throw err;
    } finally {
      this._connecting.delete(sessionId);
    }
  }

  /** A connect still in flight (claimed, not in `sessions` yet)? */
  isPending(sessionId) {
    return this._connecting.has(sessionId);
  }

  /**
   * Its window closed: drop the socket now (a host-key prompt it waits on is
   * left, so it rejects), and if it still resolves, connect() disconnects it.
   */
  cancelPending(sessionId) {
    const pend = this._connecting.get(sessionId);
    if (!pend) return false;
    pend.cancelled = true;
    try { if (pend.client) pend.client.end(); } catch (_) { /* already down */ }
    return true;
  }

  /**
   * Dial `config`, verify the host key, authenticate and (unless SFTP-only)
   * open the shell. `opts.reconnect`: this dials a NEW transport for a session
   * that already exists in `sessions` (it dropped); on success the entry gets
   * the new client and stream, on failure nothing about it changes.
   */
  async _connect(sessionId, config, pend = null, opts = {}) {
    const reconnect = !!opts.reconnect;
    const client = new Client();
    if (pend) pend.client = client;
    /* Known key types for this host:port first, so a server with several host
       keys presents one we already trust (see known-hosts hostKeyAlgorithms). */
    const serverHostKey = await hostKeyService.algorithmsFor(config.host, config.port || 22);
    if (pend && pend.cancelled) throw new Error('The window that opened this connection was closed.');

    return new Promise((resolve, reject) => {
      const timeoutMs = opts.timeout || config.timeout || 30000;
      let connectionTimeout = null;
      /* Socket gone: nothing may re-arm the timeout after this (the dialog
         settling late would otherwise report "timed out" 30 s later). */
      let closed = false;
      /* This client carries the session (shell open, or SFTP-only ready).
         From then on its close/end/error is the session being LOST, not a
         failed connect. */
      let established = false;
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
        /* The dialog opens in the window this session belongs to */
        sessionId,
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

      /* What the handshake agreed on (compression is what the tests read) */
      let negotiated = null;
      client.on('handshake', (n) => { negotiated = n || null; });

      client.on('ready', () => {
        clearTimeout(connectionTimeout);

        /* An SFTP pane's own connection: no shell, no pty. The SFTP channel
           is opened on this client by sftp-service; 'ssh:close' still comes
           from client 'close'/'end' below. */
        if (config.purpose === 'sftp') {
          const logId = startLog();
          established = true;
          this.sessions.set(sessionId, { client, stream: null, config, logId, negotiated });
          resolve(sessionId);
          detectAfterReady(logId);
          return;
        }

        this._openShell(sessionId, client, config, (err, stream) => {
          if (err) {
            client.end();
            return reject(new Error(`Failed to open shell: ${err.message}`));
          }
          const existing = this.sessions.get(sessionId);
          if (reconnect && (!existing || existing.userClosed)) {
            /* Closed by the user while this attempt was in flight */
            try { stream.close(); } catch (_) { /* gone */ }
            client.end();
            return reject(new Error('The session was closed.'));
          }

          const logId = startLog();
          established = true;
          if (reconnect) {
            Object.assign(existing, { client, stream, logId, negotiated, lost: false, exited: false });
          } else {
            this.sessions.set(sessionId, { client, stream, config, logId, negotiated, cols: config.cols || 80, rows: config.rows || 24 });
          }
          this._wireStream(sessionId, client, stream);
          resolve(sessionId);
          if (!reconnect) detectAfterReady(logId);
        });
      });

      client.on('error', (err) => {
        clearTimeout(connectionTimeout);
        verifier.cancel();
        /* After the session is up an error is the connection dropping
           (keepalive gave up, socket reset): 'close' follows, but say it now */
        if (established) { this._lost(sessionId, client, err.message); return; }
        const error = verifier.wasRejected() ? hostKeyError() : null;
        if (!reconnect) {
          this._send('ssh:error', sessionId, error ? error.message : err.message);
          this._cleanup(sessionId);
        }
        reject(error || new Error(`SSH connection error: ${err.message}`));
      });

      client.on('close', () => {
        closed = true;
        clearTimeout(connectionTimeout);
        if (established) { this._lost(sessionId, client, 'connection closed'); return; }
        /* Read before cancel(): cancelling resolves the pending decision. */
        const waitingOnUser = verifier.isPending();
        verifier.cancel();
        if (verifier.wasRejected()) reject(hostKeyError());
        else if (waitingOnUser) {
          reject(new Error(`${config.host}:${config.port || 22} closed the connection while the host key was waiting for confirmation.`));
        } else {
          /* Closed before the shell was up, with no 'error': say so now
             instead of waiting for the timeout. No-op once resolved. */
          reject(new Error(`The connection to ${config.host}:${config.port || 22} closed before it was ready.`));
        }
      });

      client.on('end', () => {
        if (established) this._lost(sessionId, client, 'the server ended the connection');
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
        readyTimeout: timeoutMs,
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

      /* Compression: an explicit config.compress wins; otherwise terminals
         offer zlib (ssh2 1.17 supports zlib@openssh.com and zlib), SFTP-only
         connections do not. */
      if (config.compress !== undefined) {
        sshConfig.algorithms = {
          compress: config.compress ? SHELL_COMPRESSION.slice() : ['none'],
        };
      } else if (config.purpose !== 'sftp') {
        sshConfig.algorithms = { compress: SHELL_COMPRESSION.slice() };
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

  /**
   * THE place a terminal's shell is opened: the first connect and every
   * reconnect go through here. `config.sessionKey` (stable per tab, kept in the
   * workspace across restarts) is passed through untouched. It is the seam for
   * a future session keeper (a Termilab-owned helper on the server that holds
   * the pty): this function would attach to it by sessionKey instead of
   * asking for a fresh shell. Nothing of that exists yet.
   */
  _openShell(sessionId, client, config, cb) {
    const entry = this.sessions.get(sessionId);
    const shellOpts = {
      term: config.term || 'xterm-256color',
      /* A reconnect opens at the size the terminal has now */
      cols: (entry && entry.cols) || config.cols || 80,
      rows: (entry && entry.rows) || config.rows || 24,
      env: config.env || {},
    };
    client.shell(shellOpts, cb);
  }

  /* Stream -> renderer, for the stream the session carries right now */
  _wireStream(sessionId, client, stream) {
    const current = () => this.sessions.get(sessionId)?.stream === stream;
    stream.on('data', (data) => {
      if (current()) this._send('ssh:data', sessionId, data.toString('utf-8'));
    });
    stream.stderr.on('data', (data) => {
      if (current()) this._send('ssh:data', sessionId, data.toString('utf-8'));
    });
    /* exit-status / exit-signal: the shell ended (`exit`, killed). That close
       is the session's normal end, never a reason to reconnect. */
    stream.on('exit', () => {
      const s = this.sessions.get(sessionId);
      if (s && s.stream === stream) s.exited = true;
    });
    stream.on('close', () => {
      const s = this.sessions.get(sessionId);
      if (!s || s.stream !== stream || s.lost) return;
      /* ssh2 emits the client's 'close' BEFORE closing its channels, so a
         dropped socket has already marked the session lost by now. A channel
         closed with the transport still up is the server ending the shell. */
      this._send('ssh:close', sessionId);
      this._cleanup(sessionId);
      try { client.end(); } catch (_) { /* gone */ }
    });
    stream.on('error', (err) => {
      if (current()) this._send('ssh:error', sessionId, err.message);
    });
  }

  /**
   * The transport under an established session went away (once per client).
   * A terminal whose shell did not exit and that the user did not close is
   * reconnected; anything else ends here, as before.
   */
  _lost(sessionId, client, reason) {
    const s = this.sessions.get(sessionId);
    if (!s || s.client !== client || s.lost) return;
    s.lost = true;
    const reconnectable = !s.userClosed && !s.exited && s.config.purpose !== 'sftp'
      && s.config.autoReconnect !== false && this.reconnectDelays.length > 0;
    if (!reconnectable) {
      this._send('ssh:close', sessionId);
      this._cleanup(sessionId);
      return;
    }
    this._reconnect(sessionId, reason).catch((err) => {
      console.error(`[SSHService] Reconnect of ${sessionId} failed:`, err.message);
    });
  }

  /* Drop the dead transport (listeners, log entry) but keep the session */
  _detachTransport(s) {
    connectionLogService.end(s.logId);
    s.logId = null;
    try { if (s.stream) s.stream.removeAllListeners(); } catch (_) { /* ignore */ }
    try {
      s.client.removeAllListeners();
      s.client.on('error', () => {});   // a late socket error must not go unhandled
      s.client.end();
    } catch (_) { /* already down */ }
    s.stream = null;
  }

  /**
   * Redial with backoff. The session keeps its id, owner window and listeners;
   * the terminal is told what happens through ordinary ssh:data lines plus an
   * 'ssh:reconnect' push {sessionId, state: lost|reconnecting|reconnected|failed,
   * attempt}. disconnect() during any of it cancels it.
   */
  async _reconnect(sessionId, reason) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this._detachTransport(s);
    const rc = { attempt: 0, timer: null, wake: null, pend: null, schedule: [] };
    s.reconnecting = rc;
    const say = (text) => this._send('ssh:data', sessionId, `\r\n\x1b[33m[${text}]\x1b[0m\r\n`);
    const push = (state, extra = {}) => this._send('ssh:reconnect', { sessionId, state, attempt: rc.attempt, ...extra });
    const gone = () => this.sessions.get(sessionId) !== s || s.userClosed;

    say(`Connection lost${reason ? ` (${reason})` : ''}`);
    push('lost');
    let lastError = null;
    for (const delay of this.reconnectDelays) {
      await new Promise((resolve) => {
        rc.wake = resolve;
        rc.timer = setTimeout(resolve, delay);
      });
      rc.timer = null;
      rc.wake = null;
      if (gone()) return;
      rc.attempt++;
      rc.schedule.push(delay);
      say(`Reconnecting… (attempt ${rc.attempt})`);
      push('reconnecting', { delayMs: delay });
      const pend = { cancelled: false, client: null };
      rc.pend = pend;
      try {
        await this._connect(sessionId, s.config, pend, { reconnect: true, timeout: Math.min(s.config.timeout || 30000, this.reconnectAttemptTimeoutMs) });
        rc.pend = null;
        /* Gone, or the new link already dropped and a newer loop owns it */
        if (gone() || s.reconnecting !== rc) return;
        s.reconnecting = null;
        s.reconnects = (s.reconnects || 0) + 1;
        say('Reconnected');
        push('reconnected');
        return;
      } catch (err) {
        rc.pend = null;
        if (gone()) return;
        lastError = err;
        if (PERMANENT_ERROR.test(err.message || '')) break;
      }
    }
    if (gone()) return;
    say(`Could not reconnect${lastError ? `: ${lastError.message}` : ''}`);
    push('failed', { error: lastError ? lastError.message : null });
    this._send('ssh:close', sessionId);
    this._cleanup(sessionId);
  }

  /** Is this session between a drop and its next transport? */
  isReconnecting(sessionId) {
    return !!this.sessions.get(sessionId)?.reconnecting;
  }

  async disconnect(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    /* The user closed it: no reconnect, now or later */
    session.userClosed = true;
    const rc = session.reconnecting;
    if (rc) {
      clearTimeout(rc.timer);
      if (rc.wake) rc.wake();
      if (rc.pend) {
        rc.pend.cancelled = true;
        try { if (rc.pend.client) rc.pend.client.end(); } catch (_) { /* gone */ }
      }
    }
    try {
      if (session.stream) {
        session.stream.close();
      }
      if (session.client) session.client.end();
    } catch (err) {
      console.error(`[SSHService] Error disconnecting session ${sessionId}:`, err.message);
    } finally {
      this._cleanup(sessionId);
    }
  }

  sendData(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (session && session.reconnecting) return;   // typed into a dead link: dropped
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
    if (!session) return;
    /* Remembered for the shell a reconnect opens */
    if (cols > 0 && rows > 0) { session.cols = cols; session.rows = rows; }
    if (!session.stream) return;
    try {
      session.stream.setWindow(rows, cols, 0, 0);
    } catch (err) {
      console.error(`[SSHService] Error resizing session ${sessionId}:`, err.message);
    }
  }

  getClient(sessionId) {
    const session = this.sessions.get(sessionId);
    /* Mid-reconnect there is no usable client (an SFTP pane says "closed") */
    return session && !session.reconnecting ? session.client : null;
  }

  isConnected(sessionId) {
    return this.sessions.has(sessionId);
  }

  _cleanup(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.reconnecting) clearTimeout(session.reconnecting.timer);
      connectionLogService.end(session.logId);
      try {
        if (session.stream) {
          session.stream.removeAllListeners();
        }
        if (session.client) session.client.removeAllListeners();
      } catch (_) { /* ignore cleanup errors */ }
      this.sessions.delete(sessionId);
    }
    windowRegistry.release(sessionId);
  }

  async disconnectAll() {
    const sessionIds = Array.from(this.sessions.keys());
    for (const id of sessionIds) {
      await this.disconnect(id);
    }
  }
}

module.exports = new SSHService();
