const { Client } = require('ssh2');
const crypto = require('crypto');
const { detectOs } = require('./os-detect');
const hostKeyService = require('./host-key-service');
const connectionLogService = require('./connection-log-service');
const windowRegistry = require('../window-registry');
const keeperService = require('./keeper-service');

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
/* Attach exits that mean "the keeper cannot hold this tab": 103 per-user cap
   (20), 104 protocol mismatch, 126/127 the binary is not runnable / gone (a
   server reinstall under a cached prepare). The tab gets a plain shell on the
   same transport instead of closing. */
const KEEPER_FALLBACK_EXITS = new Set([103, 104, 126, 127]);
/* An automatic reattach (restore, auto-reconnect) found the session held by
   another client: it is not taken (the user can, with Attach here) */
const KEEPER_ELSEWHERE = 'KEEPER_ELSEWHERE';
const ELSEWHERE_MESSAGE = 'This session is open on another device';

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
    /* The session keeper (keeper-service). The harness turns it off for the
       suites that test plain shells against the toy ssh2 server. */
    this.keeperEnabled = true;
    this.keeperPrepareCapMs = 25000;
    /* A link that drops again within flapWindowMs of every reconnect, flapMax
       times in a row, stops reconnecting (the harness shrinks the window) */
    this.flapWindowMs = 10000;
    this.flapMax = 3;
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
            if (err.code === KEEPER_ELSEWHERE) return reject(err);
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
   * reconnect go through here.
   *
   * Session keeper (keeper-service): when "Keep sessions alive" is on for
   * this host and the keeper could be prepared on the server, the "shell" is
   * `<bin> attach <id> --create` run with a pty (exec, not shell): same
   * stream, same sendData/resize (the attach client turns the pty's SIGWINCH
   * into the keeper's RESIZE). <id> comes from config.sessionKey (stable per
   * tab, kept in the workspace). Anything that keeps it from working is a
   * plain shell plus one dim line: the connect never fails because of it.
   * Never for purpose:'sftp' (no shell at all) or port forwards (own client).
   */
  _shellOpts(config, entry) {
    return {
      term: config.term || 'xterm-256color',
      /* A reconnect opens at the size the terminal has now */
      cols: (entry && entry.cols) || config.cols || 80,
      rows: (entry && entry.rows) || config.rows || 24,
      env: config.env || {},
    };
  }

  _plainShell(client, shellOpts, lines, cb) {
    client.shell(shellOpts, (err, stream) => {
      if (!err && stream) stream._termilabPreface = lines;
      cb(err, stream);
    });
  }

  _openShell(sessionId, client, config, cb) {
    /* Only a reconnect finds its entry here: a first connect adds it later */
    const entry = this.sessions.get(sessionId);
    const shellOpts = this._shellOpts(config, entry);
    const plain = (lines) => this._plainShell(client, shellOpts, lines, cb);
    (async () => {
      if (!this.keeperEnabled || !(await keeperService.wanted(config))) return plain(null);
      /* A slow server delays the shell, it never blocks it: past the cap the
         terminal gets a plain shell (the prepare may still finish and cache) */
      let capTimer = null;
      const prep = await Promise.race([
        keeperService.prepare(client, config),
        new Promise((resolve) => {
          capTimer = setTimeout(() => resolve({ fallback: true, reason: 'the server took too long to set it up', notices: [] }), this.keeperPrepareCapMs);
        }),
      ]);
      clearTimeout(capTimer);
      const notices = prep.notices || [];
      if (prep.fallback) {
        return plain([...notices, `Session keeping unavailable on this host (${prep.reason}): using a plain shell`]);
      }
      /* A reconnect reattaches the session this terminal already had */
      const sess = (entry && entry.keeper && entry.keeper.session) || keeperService.sessionFor(config);
      if (!sess) return plain(notices.length ? notices : null);
      /* Automatic reattach (auto-reconnect, restore): never take a session
         another client holds. A manual Attach here (takeover / adopted on a
         first connect) keeps newest-wins. */
      const automatic = entry ? true : !!(config.restored && !config.takeover);
      if (automatic && await this._keeperElsewhere(client, prep.bin, sess, entry)) {
        const e = new Error(ELSEWHERE_MESSAGE);
        e.code = KEEPER_ELSEWHERE;
        return cb(e);
      }
      const command = keeperService.attachCommand(prep.bin, sess, shellOpts.cols, shellOpts.rows);
      client.exec(command, { pty: { term: shellOpts.term, cols: shellOpts.cols, rows: shellOpts.rows }, env: shellOpts.env }, (err, stream) => {
        if (err) {
          return plain([...notices, `Session keeping unavailable on this host (${err.message}): using a plain shell`]);
        }
        if (sess.create && !sess.adopted) keeperService.markOwned(sess.id);
        stream._termilabKeeper = { bin: prep.bin, session: { ...sess, create: true }, installed: prep.installed, kv: prep.kv };
        /* An adopted session that is gone must not be recreated by a reconnect */
        if (sess.adopted) stream._termilabKeeper.session.create = false;
        stream._termilabNotices = notices;
        cb(null, stream);
      });
    })().catch((err) => {
      console.error('[SSHService] keeper prepare failed:', err && err.message);
      plain([`Session keeping unavailable on this host (${err && err.message}): using a plain shell`]);
    });
  }

  /**
   * Is keeper session `sess` attached by a client that is not this tab? On a
   * reconnect our own old attach may still be listed as attached (the server
   * has not noticed the drop yet): it is ours when nobody attached after it,
   * i.e. lastAttach is not newer than the one we read after our attach.
   * Best effort: a failed list is "not elsewhere".
   */
  async _keeperElsewhere(client, bin, sess, entry) {
    let rows;
    try { rows = await keeperService.list(client, bin); } catch (_) { return false; }
    const row = rows.find(r => r.id === sess.id);
    if (!row || !row.attached) return false;
    const k = entry && entry.keeper;
    const mine = k && k.session && k.session.id === sess.id ? k.lastAttach : null;
    if (typeof mine === 'number' && Number(row.lastAttach) <= mine) return false;
    return true;
  }

  /* The keeper's lastAttach for the attach this stream carries (server clock),
     read once its first output arrived (the daemon has stamped it by then) */
  _noteAttach(client, keeper) {
    keeperService.list(client, keeper.bin).then((rows) => {
      const r = rows.find(x => x.id === keeper.session.id);
      if (r && typeof r.lastAttach === 'number') keeper.lastAttach = r.lastAttach;
    }).catch(() => { /* unknown: a later auto-reattach treats "attached" as elsewhere */ });
  }

  /**
   * The attach exited with a KEEPER_FALLBACK_EXITS code: same tab, same
   * transport, a plain shell plus one dim line saying why.
   */
  _keeperFallback(sessionId, client, s) {
    const code = s.exitCode;
    const sess = s.keeper && s.keeper.session;
    let line;
    if (code === 103) {
      /* Nothing was created */
      if (sess && !sess.adopted) keeperService.forget(sess.id);
      line = 'Too many background sessions on this server (20): close some in Host → Background sessions; using a plain shell';
    } else if (code === 104) {
      line = 'Session keeping unavailable for this session (the keeper on the server speaks another protocol, exit 104): using a plain shell';
    } else {
      /* The binary the cached prepare points at is gone / not runnable: the
         next connect prepares the host again */
      keeperService.invalidate(s.config);
      line = `Session keeper not found on the server (exit ${code}): using a plain shell; it is set up again on the next connect`;
    }
    try { if (s.stream) s.stream.removeAllListeners(); } catch (_) { /* gone */ }
    s.stream = null;
    s.keeper = null;
    s.exited = false;
    s.exitCode = null;
    const giveUp = (msg) => {
      this._release(sessionId);
      this._send('ssh:data', sessionId, `\r\n\x1b[31m[${msg}]\x1b[0m\r\n`);
      this._send('ssh:close', sessionId, { reason: 'error' });
      this._cleanup(sessionId);
      try { client.end(); } catch (_) { /* gone */ }
    };
    try {
      this._plainShell(client, this._shellOpts(s.config, s), [line], (err, stream) => {
        if (this.sessions.get(sessionId) !== s || s.userClosed || s.client !== client) {
          try { if (stream) stream.close(); } catch (_) { /* gone */ }
          return;
        }
        if (err) return giveUp(`Failed to open shell: ${err.message}`);
        s.stream = stream;
        this._wireStream(sessionId, client, stream);
      });
    } catch (err) {
      giveUp(`Failed to open shell: ${err.message}`);
    }
  }

  /* One dim line per notice, as terminal output */
  _dim(lines) {
    return lines.map(l => `\x1b[2m[${l}]\x1b[0m\r\n`).join('');
  }

  /* Stream -> renderer, for the stream the session carries right now */
  _wireStream(sessionId, client, stream) {
    const current = () => this.sessions.get(sessionId)?.stream === stream;
    const s0 = this.sessions.get(sessionId);
    const keeper = stream._termilabKeeper || null;
    if (s0) {
      s0.keeper = keeper;
      s0.exitCode = null;
      s0.keeperStderr = '';
    }
    /* Out to the renderer. The very first terminal of a session may not be
       listening yet (the invoke reply is not ordered with these pushes), so a
       keeper session's output is held until its first resize (TerminalView
       sends one once its listeners exist), 3 s at most: losing the start of a
       replay would lose the screen. */
    const out = (text) => {
      const s = this.sessions.get(sessionId);
      if (s && s.hold) { s.hold.push(text); return; }
      this._send('ssh:data', sessionId, text);
    };
    if (keeper && s0 && !s0.everWired) {
      s0.hold = [];
      s0.holdTimer = setTimeout(() => this._release(sessionId), 3000);
    }
    if (s0) s0.everWired = true;
    if (stream._termilabPreface && stream._termilabPreface.length) out(this._dim(stream._termilabPreface));
    /* Keeper notices go right after the replay's ESC c (which would wipe
       anything printed before it) */
    let notices = stream._termilabNotices && stream._termilabNotices.length ? this._dim(stream._termilabNotices) : null;
    let noted = !keeper;
    stream.on('data', (data) => {
      if (!current()) return;
      if (!noted) { noted = true; this._noteAttach(client, keeper); }
      let text = data.toString('utf-8');
      if (notices) {
        const i = text.indexOf('\x1bc');
        text = i === -1 ? notices + text : text.slice(0, i + 2) + notices + text.slice(i + 2);
        notices = null;
      }
      out(text);
    });
    stream.stderr.on('data', (data) => {
      if (!current()) return;
      const s = this.sessions.get(sessionId);
      /* The attach client's own messages: kept, and said in our words at exit */
      if (keeper && s) { if (s.keeperStderr.length < 4096) s.keeperStderr += data.toString('utf-8'); return; }
      out(data.toString('utf-8'));
    });
    /* exit-status / exit-signal: the shell ended (`exit`, killed). That close
       is the session's normal end, never a reason to reconnect. For the
       keeper's attach client the code says what happened (README):
       0 shell exited, 75 replaced, 76 killed/expired, 77 this client went
       away (the session lives: reconnect reattaches), 101-104 errors. */
    stream.on('exit', (code) => {
      const s = this.sessions.get(sessionId);
      if (!s || s.stream !== stream) return;
      s.exitCode = typeof code === 'number' ? code : null;
      if (!keeper || (s.exitCode !== null && s.exitCode !== 77)) s.exited = true;
    });
    stream.on('close', () => {
      const s = this.sessions.get(sessionId);
      if (!s || s.stream !== stream || s.lost) return;
      if (keeper && !s.userClosed && KEEPER_FALLBACK_EXITS.has(s.exitCode)) {
        this._keeperFallback(sessionId, client, s);
        return;
      }
      if (keeper && !s.exited && !s.userClosed) {
        /* 77 / killed by a signal with the transport up: the session lives
           on the server. Same path as a drop: a fresh transport reattaches. */
        this._lost(sessionId, client, 'the session keeper client went away');
        return;
      }
      /* ssh2 emits the client's 'close' BEFORE closing its channels, so a
         dropped socket has already marked the session lost by now. A channel
         closed with the transport still up is the server ending the shell. */
      this._release(sessionId);
      const reason = keeper ? this._keeperEnd(sessionId, s) : 'exited';
      this._send('ssh:close', sessionId, { reason });
      this._cleanup(sessionId);
      /* keeperEnd still waits on its `kill` exec on this client: it ends it */
      if (!s.ending) { try { client.end(); } catch (_) { /* gone */ } }
    });
    stream.on('error', (err) => {
      if (current()) this._send('ssh:error', sessionId, err.message);
    });
  }

  /* Say why a keeper session's attach ended; → the ssh:close reason */
  _keeperEnd(sessionId, s) {
    const code = s.exitCode;
    const id = s.keeper && s.keeper.session && s.keeper.session.id;
    const say = (t) => this._send('ssh:data', sessionId, t);
    if (code === 0) { if (id) keeperService.forget(id); return 'exited'; }
    if (code === 75) { say('\r\n\x1b[33m[Session opened elsewhere]\x1b[0m\r\n'); return 'replaced'; }
    if (code === 76) {
      if (id) keeperService.forget(id);
      if (!s.ending) say('\r\n\x1b[33m[Session ended on the server (killed or expired)]\x1b[0m\r\n');
      return 'killed';
    }
    if (code === 102) {
      if (id) keeperService.forget(id);
      say('\r\n\x1b[33m[That background session no longer exists]\x1b[0m\r\n');
      return 'gone';
    }
    const why = (s.keeperStderr || '').replace(/\[termilab-keeper: |\]/g, '').trim().slice(0, 400);
    say(`\r\n\x1b[31m[Session keeper error (exit ${code === null ? 'unknown' : code})${why ? `: ${why}` : ''}]\x1b[0m\r\n`);
    return 'error';
  }

  /* Flush output held for a terminal that was not listening yet */
  _release(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.hold) return;
    clearTimeout(s.holdTimer);
    const held = s.hold;
    s.hold = null;
    if (held.length) this._send('ssh:data', sessionId, held.join(''));
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
      this._send('ssh:close', sessionId, { reason: s.userClosed ? 'closed' : 'lost' });
      this._cleanup(sessionId);
      return;
    }
    /* Dropped again soon after the last reconnect: flapMax of those in a row
       and it stops, instead of reconnecting forever */
    if (s.reconnectedAt) {
      s.flaps = Date.now() - s.reconnectedAt < this.flapWindowMs ? (s.flaps || 0) + 1 : 0;
      if (s.flaps >= this.flapMax) {
        this._detachTransport(s);
        const msg = 'Connection keeps dropping: reconnect manually';
        this._send('ssh:data', sessionId, `\r\n\x1b[33m[${msg}]\x1b[0m\r\n`);
        this._send('ssh:reconnect', { sessionId, state: 'failed', attempt: 0, error: msg });
        this._send('ssh:close', sessionId, { reason: 'lost' });
        this._cleanup(sessionId);
        return;
      }
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
    let elsewhere = false;
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
        s.reconnectedAt = Date.now();
        /* A keeper reattach replays the screen (it starts with ESC c): a line
           printed now would land in the middle of it */
        if (!s.keeper) say('Reconnected');
        push('reconnected');
        return;
      } catch (err) {
        rc.pend = null;
        if (gone()) return;
        lastError = err;
        if (err.code === KEEPER_ELSEWHERE) { elsewhere = true; break; }
        if (PERMANENT_ERROR.test(err.message || '')) break;
      }
    }
    if (gone()) return;
    if (elsewhere) {
      /* The renderer offers Attach here (a manual takeover) */
      say(ELSEWHERE_MESSAGE);
      push('failed', { error: ELSEWHERE_MESSAGE, elsewhere: true });
      this._send('ssh:close', sessionId, { reason: 'elsewhere' });
      this._cleanup(sessionId);
      return;
    }
    say(`Could not reconnect${lastError ? `: ${lastError.message}` : ''}`);
    push('failed', { error: lastError ? lastError.message : null });
    this._send('ssh:close', sessionId, { reason: 'lost' });
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
    /* The terminal is listening now (it resizes once its listeners exist) */
    if (session.hold) this._release(sessionId);
    if (!session.stream) return;
    try {
      session.stream.setWindow(rows, cols, 0, 0);
    } catch (err) {
      console.error(`[SSHService] Error resizing session ${sessionId}:`, err.message);
    }
  }

  /* ── Session keeper, for a live terminal ── */

  /**
   * What closing this tab would interrupt: {keeper:false} for a plain shell;
   * else {keeper:true, fgCommand, isShell, jobs} (fgCommand null when the
   * keeper could not say within 2 s; jobs = names of the shell's background
   * children when the shell is in front, [] none, null unknown).
   */
  async keeperForeground(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.keeper || !s.client || s.reconnecting) return { keeper: false };
    try {
      const fg = await keeperService.foreground(s.client, s.keeper.bin, s.keeper.session.id);
      if (!fg) return { keeper: true, fgCommand: null, isShell: false, missing: true };
      /* Only the shell in front: `cmd &` / nohup jobs are its children and
         End would take them down too. jobs = their names (null: unknown). */
      let jobs = [];
      if (fg.isShell && fg.shellPid) jobs = await keeperService.children(s.client, fg.shellPid).catch(() => null);
      return { keeper: true, fgCommand: fg.fgCommand, isShell: fg.isShell, jobs };
    } catch (_) {
      return { keeper: true, fgCommand: null, isShell: false };
    }
  }

  /** End the kept session itself (KILL), not just this attach. Then disconnect. */
  async keeperEnd(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s && s.keeper && s.client && !s.reconnecting) {
      /* The attach exits 76 while `kill` still runs on the same client: its
         close must not end the client under us (see _wireStream) */
      s.ending = true;
      const client = s.client;
      try { await keeperService.kill(client, s.keeper.bin, s.keeper.session.id); } catch (err) {
        console.error(`[SSHService] keeper kill for ${sessionId} failed:`, err.message);
      }
      await this.disconnect(sessionId);
      try { client.end(); } catch (_) { /* gone */ }
      return true;
    }
    await this.disconnect(sessionId);
    return true;
  }

  /**
   * Background sessions on the server behind `sessionId` (any connection,
   * usually an SFTP-purpose one): {installed:false} or {installed:true, rows}.
   * Never installs anything.
   */
  async keeperList(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.client) throw new Error('Not connected');
    const bin = await keeperService.locate(s.client);
    if (!bin) return { installed: false, rows: [] };
    const rows = await keeperService.list(s.client, bin);
    return {
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

  async keeperKill(sessionId, id) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.client) throw new Error('Not connected');
    const bin = await keeperService.locate(s.client);
    if (!bin) throw new Error('The session keeper is not installed on this server');
    return keeperService.kill(s.client, bin, id);
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
      clearTimeout(session.holdTimer);
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
