const net = require('net');
const { Client } = require('ssh2');
const hostKeyService = require('./host-key-service');
const storeService = require('./store-service');
const { ruleProblem } = require('./port-forward-rules');

/**
 * Running port forwards, keyed by RULE id (the `port-forwards` collection).
 *
 * The renderer only ever sends a rule id. Everything else — the rule, the host
 * it points at, the password or private key — is read here from the store, so
 * no credential crosses IPC for this.
 *
 * Each rule gets its own SSH connection. State is in memory only: nothing
 * auto-starts on launch and nothing about "running" is persisted.
 *
 * Status pushes on 'port-forward:status': { ruleId, state, error? } with state
 * 'starting' | 'running' | 'error' | 'stopped'. `status()` returns the same
 * for every rule that is not stopped (errors stay listed until the next start
 * or stop, so a reloaded renderer still sees them).
 */
class PortForwardService {
  constructor() {
    /** @type {Map<string, object>} ruleId -> entry */
    this.forwards = new Map();
    /** @type {import('electron').BrowserWindow | null} */
    this.mainWindow = null;
  }

  setMainWindow(win) {
    this.mainWindow = win;
  }

  _emit(ruleId, state, error) {
    const payload = { ruleId, state };
    if (error) payload.error = error;
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('port-forward:status', payload);
      }
    } catch (err) {
      console.error('[PortForwardService] Failed to send status to renderer:', err.message);
    }
  }

  _summary(entry) {
    const out = { ruleId: entry.ruleId, state: entry.state };
    if (entry.error) out.error = entry.error;
    if (entry.boundPort) out.boundPort = entry.boundPort;
    out.activeConnections = entry.connections ? entry.connections.size : 0;
    return out;
  }

  // ─── Public API ────────────────────────────────────────

  /**
   * Start the rule. Resolves with its status once it is running. Starting a
   * rule that is already running (or starting) is a no-op that resolves the
   * same way. Rejects with a readable message on failure; the failure is also
   * pushed as state 'error'.
   */
  start(ruleId) {
    if (typeof ruleId !== 'string' || !ruleId) {
      return Promise.reject(new Error('Port forwarding: a rule id is required'));
    }
    const existing = this.forwards.get(ruleId);
    if (existing && existing.state === 'running') return Promise.resolve(this._summary(existing));
    if (existing && existing.state === 'starting') return existing.promise;

    const entry = {
      ruleId,
      state: 'starting',
      error: null,
      client: null,
      server: null,
      connections: new Set(),
      cancelled: false,
      tornDown: false,
    };
    this.forwards.set(ruleId, entry);
    this._emit(ruleId, 'starting');

    entry.promise = this._run(entry).then(
      () => {
        if (entry.cancelled) return { ruleId, state: 'stopped', activeConnections: 0 };
        entry.state = 'running';
        this._emit(ruleId, 'running');
        return this._summary(entry);
      },
      async (err) => {
        await this._teardown(entry);
        if (entry.cancelled) return { ruleId, state: 'stopped', activeConnections: 0 };
        entry.state = 'error';
        entry.error = err.message;
        this._emit(ruleId, 'error', err.message);
        throw err;
      }
    );
    return entry.promise;
  }

  /** Stop the rule (running, starting or in error). Unknown ids are a no-op. */
  async stop(ruleId) {
    const entry = this.forwards.get(ruleId);
    if (!entry) return false;
    entry.cancelled = true;
    this.forwards.delete(ruleId);
    await this._teardown(entry);
    this._emit(ruleId, 'stopped');
    return true;
  }

  async stopAll() {
    for (const id of Array.from(this.forwards.keys())) {
      await this.stop(id);
    }
  }

  /** Every rule that is not stopped. */
  status() {
    return Array.from(this.forwards.values()).map(e => this._summary(e));
  }

  /** Kept for callers of the old name. */
  getStatus() {
    return this.status();
  }

  // ─── Resolving the rule and its credentials ────────────

  /** `hosts/<id>` / `keys/<id>` that sync could not decrypt on this computer. */
  async _sealedIds() {
    try {
      const syncService = require('./sync-service');
      const s = await syncService.status();
      return new Set(Array.isArray(s && s.undecryptableIds) ? s.undecryptableIds : []);
    } catch (_) {
      // No sync state: nothing sealed. A missing secret still fails below.
      return new Set();
    }
  }

  async _resolveConnection(rule) {
    const hosts = await storeService.getHosts();
    const host = hosts.find(h => h && h.id === rule.hostId);
    if (!host) throw new Error('The host this rule uses no longer exists. Choose another host.');

    const name = host.label || host.hostname || host.host || 'this host';
    const hostname = host.hostname || host.host;
    if (!hostname || !host.username) throw new Error(`"${name}" has no hostname or username.`);

    const sealed = await this._sealedIds();
    const unlockHint = 'Unlock sync on this computer (Settings → Sync), or enter it again in the host editor.';
    const conn = { host: hostname, port: Number(host.port) || 22, username: host.username, label: name };

    if (host.authType === 'key') {
      if (!host.keyId) throw new Error(`"${name}" uses key authentication but has no key selected.`);
      if (sealed.has(`keys/${host.keyId}`)) {
        throw new Error(`The SSH key of "${name}" was saved on another computer and cannot be decrypted here. ${unlockHint}`);
      }
      if (sealed.has(`hosts/${host.id}`)) {
        throw new Error(`The key passphrase of "${name}" was saved on another computer and cannot be decrypted here. ${unlockHint}`);
      }
      const key = await storeService.getKeyWithPrivateData(host.keyId);
      if (!key || !key.privateKey) throw new Error(`The SSH key of "${name}" is not on this computer.`);
      conn.privateKey = key.privateKey;
      if (host.passphrase) conn.passphrase = host.passphrase;
    } else {
      if (sealed.has(`hosts/${host.id}`)) {
        throw new Error(`The password of "${name}" was saved on another computer and cannot be decrypted here. ${unlockHint}`);
      }
      if (!host.password) throw new Error(`"${name}" has no saved password. Add one in the host editor.`);
      conn.password = host.password;
    }
    return conn;
  }

  // ─── Lifecycle ─────────────────────────────────────────

  async _run(entry) {
    const rule = await storeService.getPortForward(entry.ruleId);
    const problem = ruleProblem(rule);
    if (problem) throw new Error(problem);
    entry.rule = rule;

    const conn = await this._resolveConnection(rule);
    if (entry.cancelled) return;

    const client = await this._createSSHClient(conn);
    entry.client = client;
    if (entry.cancelled) {
      try { client.end(); } catch (_) { /* ignore */ }
      return;
    }

    // Connection lost while the forward is up: that is an error, not a stop.
    // Lost while still starting (after 'ready', before the listener is up):
    // remembered here and thrown below, or the rule would go 'running' on a
    // dead client.
    const lost = (message) => {
      if (entry.cancelled || this.forwards.get(entry.ruleId) !== entry) return;
      if (entry.state === 'starting') {
        if (!entry.lostWhileStarting) entry.lostWhileStarting = message;
        return;
      }
      if (entry.state !== 'running') return;
      entry.state = 'error';
      entry.error = message;
      this._teardown(entry);
      this._emit(entry.ruleId, 'error', message);
    };
    client.on('error', (err) => lost(`SSH connection error: ${err.message}`));
    client.on('close', () => lost(`The SSH connection to ${conn.label} closed.`));

    if (rule.type === 'remote') await this._startRemote(entry, client, rule);
    else await this._listenLocal(entry, client, rule);

    // The SSH client died while the listener was being set up. start() tears
    // down (listener included) and reports the error.
    if (!entry.cancelled && entry.lostWhileStarting) throw new Error(entry.lostWhileStarting);

    // stop() ran while we were still listening: its teardown saw a server that
    // was not listening yet (or no binding), so close again now that it is.
    if (entry.cancelled) {
      entry.tornDown = false;
      await this._teardown(entry);
    }
  }

  async _teardown(entry) {
    if (entry.tornDown) return;
    entry.tornDown = true;
    for (const socket of entry.connections) {
      try { socket.destroy(); } catch (_) { /* ignore */ }
    }
    entry.connections.clear();

    if (entry.server) {
      const server = entry.server;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 2000);
        try {
          server.close(() => { clearTimeout(t); resolve(); });
        } catch (_) {
          clearTimeout(t);
          resolve();
        }
      });
    }

    if (entry.client) {
      if (entry.remoteBinding) {
        try { entry.client.unforwardIn(entry.remoteBinding.address, entry.remoteBinding.port, () => {}); } catch (_) { /* ignore */ }
      }
      try { entry.client.end(); } catch (_) { /* ignore */ }
    }
  }

  async _createSSHClient(config) {
    const client = new Client();
    /* Known key types first, as in ssh-service (known-hosts hostKeyAlgorithms). */
    const serverHostKey = await hostKeyService.algorithmsFor(config.host, config.port || 22);

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout = null;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { client.end(); } catch (_) { /* ignore */ }
        reject(err);
      };
      const armTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fail(new Error(`Timed out connecting to ${config.label}.`)), config.timeout || 30000);
      };
      armTimeout();

      /* Same known-hosts check as terminal sessions (host-key-service.js).
         Timeouts pause while the user decides. */
      const verifier = hostKeyService.createVerifier(config.host, config.port || 22, {
        onPrompt: () => {
          clearTimeout(timeout);
          clearTimeout(client._readyTimeout);
        },
        onSettled: () => { if (!settled) armTimeout(); },
      });

      client.on('ready', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(client);
      });

      client.on('error', (err) => {
        verifier.cancel();
        if (verifier.wasRejected()) {
          fail(new Error(`Host key rejected: the key presented by ${config.host}:${config.port || 22} was not accepted.`));
        } else if (err.level === 'client-authentication') {
          fail(new Error(`Authentication to ${config.label} failed. Check the saved credentials.`));
        } else {
          fail(new Error(`SSH connection error: ${err.message}`));
        }
      });

      client.on('close', () => {
        verifier.cancel();
        fail(new Error(`The SSH connection to ${config.label} closed before it was ready.`));
      });

      const sshConfig = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        readyTimeout: config.timeout || 30000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostVerifier: verifier.hostVerifier,
      };
      if (serverHostKey) sshConfig.algorithms = { serverHostKey };

      if (config.privateKey) {
        sshConfig.privateKey = config.privateKey;
        if (config.passphrase) sshConfig.passphrase = config.passphrase;
      } else if (config.password) {
        sshConfig.password = config.password;
      }

      if (process.env.SSH_AUTH_SOCK) {
        sshConfig.agent = process.env.SSH_AUTH_SOCK;
      }

      try {
        client.connect(sshConfig);
      } catch (err) {
        // Bad private key format and the like throw synchronously
        fail(new Error(`SSH connection error: ${err.message}`));
      }
    });
  }

  _listenError(err, address, port) {
    if (err.code === 'EADDRINUSE') return new Error(`Port ${port} on ${address} is already in use on this computer.`);
    if (err.code === 'EACCES') return new Error(`Port ${port} needs administrator privileges on this computer. Use a port above 1023.`);
    if (err.code === 'EADDRNOTAVAIL') return new Error(`${address} is not an address of this computer.`);
    return new Error(`Could not listen on ${address}:${port}: ${err.message}`);
  }

  _track(entry, socket) {
    entry.connections.add(socket);
    socket.on('close', () => entry.connections.delete(socket));
    socket.on('error', () => entry.connections.delete(socket));
  }

  // ─── Local (-L) and dynamic (-D): a listener on this computer ─

  _listenLocal(entry, client, rule) {
    const server = net.createServer((socket) => {
      this._track(entry, socket);
      if (rule.type === 'dynamic') this._handleSOCKS5(socket, client);
      else this._pipeLocal(socket, client, rule);
    });
    entry.server = server;

    return new Promise((resolve, reject) => {
      const onStartError = (err) => reject(this._listenError(err, rule.bindAddress, rule.localPort));
      server.once('error', onStartError);
      server.listen(rule.localPort, rule.bindAddress, () => {
        server.removeListener('error', onStartError);
        server.on('error', (err) => console.error(`[PortForward] listener error on ${rule.localPort}: ${err.message}`));
        entry.boundPort = server.address().port;
        resolve();
      });
    });
  }

  /* ssh2 throws synchronously ("Not connected") when a connection arrives
     after the SSH client died but before the listener was closed. */
  _forwardOut(client, socket, host, port, cb) {
    try {
      client.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, host, port, cb);
    } catch (err) {
      cb(err);
    }
  }

  _pipeLocal(socket, client, rule) {
    socket.pause();
    this._forwardOut(client, socket,
      rule.destHost,
      rule.destPort,
      (err, stream) => {
        if (err) {
          socket.destroy();
          return;
        }
        socket.pipe(stream).pipe(socket);
        stream.on('error', () => socket.destroy());
        stream.on('close', () => socket.end());
        socket.on('close', () => stream.end());
        socket.resume();
      }
    );
  }

  // ─── Remote (-R): the server listens, we connect out from here ─

  _startRemote(entry, client, rule) {
    return new Promise((resolve, reject) => {
      client.forwardIn(rule.bindAddress, rule.localPort, (err, actualPort) => {
        if (err) {
          return reject(new Error(
            `The server refused to open port ${rule.localPort} on ${rule.bindAddress} (it may be in use, or the server does not allow remote forwarding).`
          ));
        }
        const boundPort = actualPort || rule.localPort;
        entry.boundPort = boundPort;
        entry.remoteBinding = { address: rule.bindAddress, port: boundPort };

        client.on('tcp connection', (info, accept, rejectConn) => {
          if (entry.cancelled) return rejectConn();
          const stream = accept();
          stream.pause();
          const socket = net.createConnection(rule.destPort, rule.destHost, () => {
            stream.pipe(socket).pipe(stream);
            stream.resume();
          });
          this._track(entry, socket);
          socket.on('error', () => stream.end());
          socket.on('close', () => stream.end());
          stream.on('close', () => socket.end());
          stream.on('error', () => socket.destroy());
        });
        resolve();
      });
    });
  }

  // ─── SOCKS5 (CONNECT only, no auth) ────────────────────

  _handleSOCKS5(socket, sshClient) {
    let buf = Buffer.alloc(0);
    let stage = 'greeting';

    const fail = (code) => {
      if (code !== undefined) {
        try { socket.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch (_) { /* ignore */ }
      }
      socket.end();
    };

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return socket.destroy();
        const n = buf[1];
        if (buf.length < 2 + n) return;
        const methods = buf.subarray(2, 2 + n);
        buf = buf.subarray(2 + n);
        if (!methods.includes(0x00)) {
          socket.write(Buffer.from([0x05, 0xff]));
          return socket.end();
        }
        socket.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
      }

      if (stage === 'request') {
        if (buf.length < 5) return;
        if (buf[0] !== 0x05) return socket.destroy();
        if (buf[1] !== 0x01) return fail(0x07);   // command not supported
        const atyp = buf[3];
        let destHost;
        let offset;
        if (atyp === 0x01) {
          if (buf.length < 10) return;
          destHost = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
          offset = 8;
        } else if (atyp === 0x03) {
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          destHost = buf.subarray(5, 5 + len).toString('utf8');
          offset = 5 + len;
        } else if (atyp === 0x04) {
          if (buf.length < 22) return;
          const parts = [];
          for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
          destHost = parts.join(':');
          offset = 20;
        } else {
          return fail(0x08);                      // address type not supported
        }
        const destPort = buf.readUInt16BE(offset);
        const rest = buf.subarray(offset + 2);
        stage = 'connecting';
        socket.removeListener('data', onData);
        socket.pause();

        this._forwardOut(sshClient, socket, destHost, destPort, (err, stream) => {
          if (err) return fail(0x05);             // connection refused
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (rest.length) stream.write(rest);
          stream.pipe(socket);
          socket.pipe(stream);
          stream.on('close', () => socket.end());
          stream.on('error', () => socket.destroy());
          socket.on('close', () => stream.end());
          socket.resume();
        });
      }
    };
    socket.on('data', onData);
  }
}

module.exports = new PortForwardService();
