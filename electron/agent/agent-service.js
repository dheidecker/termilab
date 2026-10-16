/**
 * Local agent API: lets AI agents (through the `termilab-mcp` stdio server,
 * electron/agent/mcp.js) run commands on the user's hosts with the
 * credentials Termilab already holds. The agent names a host and a command;
 * passwords, keys and passphrases never leave this process.
 *
 * Transport: a unix socket <userData>/agent.sock (0600, folder 0700) or, on
 * Windows, the named pipe \\.\pipe\termilab-agent-<user>. Only while Termilab
 * runs; never TCP. Every request carries the token from <userData>/agent-token
 * (0600), so only this user's processes get in.
 *
 * Wire: one JSON object per line.
 *   -> { id, token, method, params }
 *   <- { id, result } | { id, error: { code, message } }
 *
 * Host keys: TOFU like the rest of Termilab, but an agent NEVER accepts a key.
 * Unknown, changed or new-type keys fail with a message telling the user to
 * connect once from Termilab.
 *
 * Every action goes to agent-log.js (Logs), never the output.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const storeService = require('../services/store-service');
const hostKeyService = require('../services/host-key-service');
const { decide } = require('../services/known-hosts');
const { agentPaths } = require('./paths');
const { AgentLog } = require('./agent-log');
const localExec = require('./local-exec');
const { ConnPool, fingerprint } = require('./conn-pool');

const LIMITS = {
  output: 256 * 1024,          // run_command, each of stdout / stderr
  shellBuffer: 1024 * 1024,    // unread shell output kept per session
  readDefault: 256 * 1024,
  readMax: 4 * 1024 * 1024,
  writeMax: 4 * 1024 * 1024,
  command: 64 * 1024,
  input: 64 * 1024,
  line: 16 * 1024 * 1024,      // one request on the socket
  timeoutDefaultS: 60,
  timeoutMaxS: 3600,
  waitMaxMs: 30000,
  connectMs: 20000,
};
const IDLE_MS = 15 * 60 * 1000;
const LOCAL_ID = 'local';

/**
 * The one place that decides whether an agent may use a host. Allow-all for
 * now (owner's call); a master switch or per-host opt-out goes here.
 */
// eslint-disable-next-line no-unused-vars
function agentMayUse(_target) { return { ok: true }; }

class AgentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (message, code = 'error') => { throw new AgentError(code, message); };

function sq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/* `cd` prefix for a remote command: ~ and ~/x expand on the server. */
function remoteCd(cwd) {
  if (!cwd) return '';
  if (cwd === '~') return 'cd "$HOME" && ';
  if (cwd.startsWith('~/')) return `cd "$HOME"/${sq(cwd.slice(2))} && `;
  return `cd ${sq(cwd)} && `;
}

function parseMode(mode) {
  if (mode === undefined || mode === null || mode === '') return null;
  const n = typeof mode === 'number' ? mode : parseInt(String(mode), 8);
  if (!Number.isInteger(n) || n < 0 || n > 0o7777) fail(`Invalid mode "${mode}": use an octal string like "644".`, 'invalid');
  return n;
}

function decodeText(buf) {
  try {
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch (_) {
    return { content: buf.toString('base64'), encoding: 'base64' };
  }
}

class AgentService {
  constructor() {
    this.server = null;
    this.paths = null;
    this.token = null;
    this.userDataDir = null;
    /** session_id -> shell entry */
    this.shells = new Map();
    this.broadcast = null;      // (channel, data) => void, set by ipc-handlers
    this.idleMs = IDLE_MS;
    this.limits = { ...LIMITS };
    this._sweep = null;
    this._conns = new Set();
    this.log = new AgentLog(() => path.join(this._userData(), 'data'));
    /* One SSH connection per host, shared by every agent call (conn-pool.js) */
    this.pool = new ConnPool({ connect: conn => this._connect(conn) });
  }

  _userData() {
    if (this.userDataDir) return this.userDataDir;
    return require('electron').app.getPath('userData');
  }

  // ─── Socket ─────────────────────────────────────────────

  _ensureToken(file) {
    try {
      const t = fs.readFileSync(file, 'utf-8').trim();
      if (/^[0-9a-f]{64}$/.test(t)) {
        if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
        return t;
      }
    } catch (_) { /* create below */ }
    const token = crypto.randomBytes(32).toString('hex');
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    return token;
  }

  /* Another Termilab (an installed one while `npm run dev` starts) already answers here. */
  _socketAlive(socket) {
    return new Promise((resolve) => {
      const c = net.connect(socket);
      const t = setTimeout(() => { c.destroy(); resolve(false); }, 1000);
      c.once('connect', () => { clearTimeout(t); c.destroy(); resolve(true); });
      c.once('error', () => { clearTimeout(t); resolve(false); });
    });
  }

  /**
   * Listen. Resolves { listening, socket, reason? }; never throws for "someone
   * else has it" (that Termilab serves the agents).
   */
  async start({ userDataDir } = {}) {
    if (this.server) return { listening: true, socket: this.paths.socket };
    if (userDataDir) this.userDataDir = userDataDir;
    this.pool.stopped = false;
    const dir = this._userData();
    this.paths = agentPaths(dir);
    const posix = process.platform !== 'win32';
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (posix) {
      /* userData holds plaintext keys too: never group/world readable */
      const st = fs.statSync(dir);
      if (st.mode & 0o077) fs.chmodSync(dir, st.mode & 0o700);
    }
    this.token = this._ensureToken(this.paths.token);

    if (await this._socketAlive(this.paths.socket)) {
      console.log(`[Agent] ${this.paths.socket} is served by another Termilab; not listening here`);
      return { listening: false, socket: this.paths.socket, reason: 'in-use' };
    }
    if (posix) { try { fs.unlinkSync(this.paths.socket); } catch (_) { /* none */ } }

    const server = net.createServer((conn) => this._onConnection(conn));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      /* bind() happens inside listen(): the socket is born 0600 */
      const old = posix ? process.umask(0o177) : null;
      try {
        server.listen(this.paths.socket, () => { server.removeListener('error', reject); resolve(); });
      } finally {
        if (posix) process.umask(old);
      }
    });
    if (posix) fs.chmodSync(this.paths.socket, 0o600);
    server.on('error', (err) => console.error('[Agent] socket error:', err.message));
    this.server = server;
    this._sweep = setInterval(() => this._closeIdle(), 60 * 1000);
    this._sweep.unref();
    console.log(`[Agent] listening on ${this.paths.socket}`);
    return { listening: true, socket: this.paths.socket };
  }

  async stop() {
    clearInterval(this._sweep);
    this._sweep = null;
    for (const id of [...this.shells.keys()]) this._closeShell(id, 'quit');
    this.pool.closeAll();
    for (const c of this._conns) { try { c.destroy(); } catch (_) { /* gone */ } }
    this._conns.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise(r => server.close(() => r()));
    if (this.paths && process.platform !== 'win32') {
      try { fs.unlinkSync(this.paths.socket); } catch (_) { /* gone */ }
    }
    await this.log.flush();
  }

  _tokenOk(given) {
    if (typeof given !== 'string' || !this.token) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  _onConnection(conn) {
    this._conns.add(conn);
    conn.on('close', () => this._conns.delete(conn));
    conn.on('error', () => {});
    let buf = '';
    conn.setEncoding('utf-8');
    conn.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > this.limits.line) {
        conn.end(`${JSON.stringify({ id: null, error: { code: 'too-large', message: 'Request too large' } })}\n`);
        buf = '';
        return;
      }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this._onRequest(conn, line);
      }
    });
  }

  async _onRequest(conn, line) {
    let req;
    try { req = JSON.parse(line); } catch (_) {
      conn.write(`${JSON.stringify({ id: null, error: { code: 'parse', message: 'Invalid JSON' } })}\n`);
      return;
    }
    const id = req && req.id !== undefined ? req.id : null;
    const reply = (obj) => { if (!conn.destroyed) conn.write(`${JSON.stringify({ id, ...obj })}\n`); };
    if (!this._tokenOk(req && req.token)) {
      reply({ error: { code: 'unauthorized', message: 'Wrong or missing agent token.' } });
      conn.end();
      return;
    }
    try {
      const result = await this.call(req.method, req.params || {});
      reply({ result });
    } catch (err) {
      reply({ error: { code: err.code || 'error', message: err.message || String(err) } });
    }
  }

  // ─── Dispatch ───────────────────────────────────────────

  /** Same entry the socket uses; the harness calls it directly too. */
  async call(method, params) {
    if (!params || typeof params !== 'object') params = {};
    switch (method) {
      case 'hello': return { app: 'termilab', pid: process.pid, platform: process.platform };
      case 'list_hosts': return this.listHosts();
      case 'run_command': return this.runCommand(params);
      case 'open_shell': return this.openShell(params);
      case 'send_input': return this.sendInput(params);
      case 'read_output': return this.readOutput(params);
      case 'close_shell': return this.closeShellTool(params);
      case 'read_file': return this.readFile(params);
      case 'write_file': return this.writeFile(params);
      default: return fail(`Unknown method ${method}`, 'unknown-method');
    }
  }

  // ─── Hosts ──────────────────────────────────────────────

  async _sealedIds() {
    try {
      const s = await require('../services/sync-service').status();
      return new Set(Array.isArray(s && s.undecryptableIds) ? s.undecryptableIds : []);
    } catch (_) {
      return new Set();
    }
  }

  _localTarget() {
    let user = '';
    try { user = os.userInfo().username; } catch (_) { /* none */ }
    return { kind: 'local', id: LOCAL_ID, name: LOCAL_ID, user, hostname: os.hostname() };
  }

  async listHosts() {
    const [hosts, groups, sealed] = await Promise.all([storeService.getHosts(), storeService.getGroups(), this._sealedIds()]);
    const groupName = new Map((groups || []).map(g => [g.id, g.name || g.label || '']));
    const local = this._localTarget();
    const out = [{
      id: LOCAL_ID, name: LOCAL_ID, group: null, tags: [], os: process.platform,
      user: local.user, hostname: local.hostname, port: null, available: true,
      note: 'This computer (runs in your login shell).',
    }];
    for (const h of hosts || []) {
      if (!h || !h.id) continue;
      /* Whitelist: nothing from the host object is copied wholesale */
      const row = {
        id: String(h.id),
        name: String(h.label || h.hostname || h.host || ''),
        group: h.groupId ? (groupName.get(h.groupId) || null) : null,
        tags: Array.isArray(h.tags) ? h.tags.filter(t => typeof t === 'string') : [],
        os: typeof h.os === 'string' ? h.os : null,
        user: typeof h.username === 'string' ? h.username : null,
        hostname: String(h.hostname || h.host || ''),
        port: Number(h.port) || 22,
        auth: h.authType === 'key' ? 'key' : 'password',
        available: true,
      };
      const why = this._unusable(h, sealed);
      if (why) { row.available = false; row.note = why; }
      out.push(row);
    }
    return { hosts: out };
  }

  /* Why this host cannot be used right now (sealed secret, no credential), or null. */
  _unusable(host, sealed) {
    const name = host.label || host.hostname || 'this host';
    const hint = 'Unlock sync on this computer (Settings → Sync), or enter it again in the host editor.';
    if (!(host.hostname || host.host) || !host.username) return `"${name}" has no hostname or username.`;
    if (host.authType === 'key') {
      if (!host.keyId) return `"${name}" uses key authentication but has no key selected.`;
      if (sealed.has(`keys/${host.keyId}`)) return `The SSH key of "${name}" was saved on another computer and cannot be decrypted here. ${hint}`;
      if (sealed.has(`hosts/${host.id}`)) return `The key passphrase of "${name}" was saved on another computer and cannot be decrypted here. ${hint}`;
    } else if (sealed.has(`hosts/${host.id}`)) {
      return `The password of "${name}" was saved on another computer and cannot be decrypted here. ${hint}`;
    }
    return null;
  }

  /** host name / id -> { kind:'local' } | { kind:'ssh', host } */
  async _resolve(spec) {
    if (typeof spec !== 'string' || !spec.trim()) fail('Missing "host": a host name or id from list_hosts.', 'invalid');
    const want = spec.trim();
    const lower = want.toLowerCase();
    if (lower === LOCAL_ID) return this._localTarget();
    const hosts = (await storeService.getHosts()) || [];
    const byId = hosts.find(h => h && h.id === want);
    let matches = byId ? [byId] : hosts.filter(h => h && String(h.label || '').toLowerCase() === lower);
    if (!matches.length) matches = hosts.filter(h => h && String(h.hostname || h.host || '').toLowerCase() === lower);
    if (!matches.length) fail(`No host named "${want}" in Termilab. Call list_hosts for the names.`, 'not-found');
    if (matches.length > 1) {
      const list = matches.map(h => `"${h.label || h.hostname}" (id ${h.id}, ${h.username}@${h.hostname}:${h.port || 22})`).join(', ');
      fail(`"${want}" matches ${matches.length} hosts: ${list}. Use the id.`, 'ambiguous');
    }
    const h = matches[0];
    return { kind: 'ssh', id: h.id, name: h.label || h.hostname, host: h };
  }

  async _target(spec) {
    const t = await this._resolve(spec);
    const policy = agentMayUse(t);
    if (!policy.ok) fail(policy.message || `Agents may not use "${t.name}".`, 'refused');
    return t;
  }

  /* The connection config, credentials included. Stays in this process. */
  async _credentials(t) {
    const host = t.host;
    const why = this._unusable(host, await this._sealedIds());
    if (why) fail(why, 'unavailable');
    const conn = {
      host: host.hostname || host.host,
      port: Number(host.port) || 22,
      username: host.username,
      label: t.name,
    };
    if (host.authType === 'key') {
      const key = await storeService.getKeyWithPrivateData(host.keyId);
      if (!key || !key.privateKey) fail(`The SSH key of "${t.name}" is not on this computer.`, 'unavailable');
      conn.privateKey = key.privateKey;
      if (host.passphrase) conn.passphrase = host.passphrase;
    } else if (host.password) {
      conn.password = host.password;
    } else if (!process.env.SSH_AUTH_SOCK) {
      fail(`"${t.name}" has no saved password. Add one in the host editor.`, 'unavailable');
    }
    return conn;
  }

  _logInfo(t) {
    if (t.kind === 'local') return { host: LOCAL_ID, hostId: null };
    return { host: t.name, hostId: t.id, hostname: t.host.hostname || t.host.host, port: Number(t.host.port) || 22, username: t.host.username };
  }

  // ─── SSH ────────────────────────────────────────────────

  /* Host key refusal, worded for the agent to relay to the user. */
  _hostKeyMessage(conn, d) {
    const where = `${conn.label} (${conn.host}:${conn.port})`;
    const tail = 'Open Termilab, connect to it once and check the key there. Agents never accept host keys.';
    if (!d || d.reason === 'unreadable') return `Could not read Termilab's known hosts to check ${where}. ${tail}`;
    if (d.reason === 'changed') {
      return `The host key of ${where} has CHANGED since Termilab trusted it (now ${d.fingerprint}, was ${d.previousFingerprint}). `
        + `This can mean a man-in-the-middle attack. ${tail}`;
    }
    if (d.reason === 'new-key-type') {
      return `${where} presented a ${d.keyType} host key Termilab has not trusted yet (${d.fingerprint}). ${tail}`;
    }
    return `Termilab has not trusted the host key of ${where} yet (${d.fingerprint}). ${tail}`;
  }

  async _connect(conn) {
    const { Client } = require('ssh2');
    const client = new Client();
    const serverHostKey = await hostKeyService.algorithmsFor(conn.host, conn.port);
    return new Promise((resolve, reject) => {
      let settled = false;
      let refusal = null;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { try { client.end(); } catch (_) { /* ignore */ } reject(err); } else resolve(client);
      };
      const timer = setTimeout(() => done(new AgentError('timeout', `Timed out connecting to ${conn.label}.`)), this.limits.connectMs);
      /* Strict: only a key already in Termilab's known hosts passes. Never a prompt, never a write. */
      const hostVerifier = (key, verify) => {
        const blob = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'hex');
        storeService.getKnownHosts().then((entries) => {
          const d = decide(entries || [], conn.host, conn.port, blob);
          if (d.action === 'accept') return verify(true);
          refusal = d;
          return verify(false);
        }).catch(() => { refusal = { reason: 'unreadable' }; verify(false); });
      };
      client.on('ready', () => done(null));
      client.on('error', (err) => {
        if (refusal) done(new AgentError('host-key', this._hostKeyMessage(conn, refusal)));
        else if (err.level === 'client-authentication') done(new AgentError('auth', `Authentication to ${conn.label} failed with the credentials saved in Termilab.`));
        else done(new AgentError('ssh', `SSH connection to ${conn.label} failed: ${err.message}`));
      });
      client.on('close', () => {
        if (refusal) done(new AgentError('host-key', this._hostKeyMessage(conn, refusal)));
        else done(new AgentError('ssh', `The SSH connection to ${conn.label} closed before it was ready.`));
      });
      client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => conn.password || '')));
      const cfg = {
        host: conn.host,
        port: conn.port,
        username: conn.username,
        readyTimeout: this.limits.connectMs,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        tryKeyboard: !!conn.password,
        hostVerifier,
      };
      if (serverHostKey) cfg.algorithms = { serverHostKey };
      if (conn.privateKey) {
        cfg.privateKey = conn.privateKey;
        if (conn.passphrase) cfg.passphrase = conn.passphrase;
      } else if (conn.password) {
        cfg.password = conn.password;
      }
      if (process.env.SSH_AUTH_SOCK) cfg.agent = process.env.SSH_AUTH_SOCK;
      try {
        client.connect(cfg);
      } catch (err) {
        /* Never echo ssh2's message here: a key parse error is about the key */
        done(new AgentError('ssh', `Could not use the credentials saved for ${conn.label} (${err.message.replace(/\s+/g, ' ').slice(0, 80)}).`));
      }
    });
  }

  /* What the pool needs to find (or open) this host's connection. Credentials stay in this process. */
  async _poolSpec(t) {
    const conn = await this._credentials(t);
    return { key: t.id, fp: fingerprint(t.host, conn), label: t.name, conn };
  }

  _lostError(t, what) {
    return new AgentError('connection-lost', `Connection to ${t.name} was lost while ${what}; it may or may not have completed.`);
  }

  /* A channel on the pooled connection; `what` words the "could not start" error. */
  async _channel(t, open, deadline, what) {
    const spec = await this._poolSpec(t);
    try {
      return await this.pool.channel(spec, open, deadline);
    } catch (err) {
      if (err instanceof AgentError || err.code === 'timeout') throw new AgentError(err.code, err.message);
      throw new AgentError('ssh', `${what}: ${err.message}`);
    }
  }

  /* ch = a pooled exec channel. In flight when the connection drops = error, never a retry. */
  _exec(ch, t, timeoutMs) {
    const max = this.limits.output;
    const stream = ch.stream;
    return new Promise((resolve, reject) => {
      /* zlib/transport teardown can throw from close() (see keeper-service.run) */
      const destroy = stream.destroy;
      stream.destroy = function guarded(...a) { try { return destroy.apply(this, a); } catch (_) { return this; } };
      const out = { stdout: [], stderr: [] };
      const len = { stdout: 0, stderr: 0 };
      const total = { stdout: 0, stderr: 0 };
      let code = null; let signal = null; let timedOut = false; let settled = false;
      let stuck = null;
      const take = (name) => (d) => {
        total[name] += d.length;
        const room = max - len[name];
        if (room <= 0) return;
        const part = d.length > room ? d.subarray(0, room) : d;
        out[name].push(part);
        len[name] += part.length;
      };
      stream.on('data', take('stdout'));
      stream.stderr.on('data', take('stderr'));
      stream.on('exit', (c, s) => { code = typeof c === 'number' ? c : null; signal = s || null; });
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(stuck);
        if (!timedOut && code === null && signal === null && ch.lost()) {
          reject(this._lostError(t, 'the command was running'));
          return;
        }
        resolve({
          exit_code: code,
          signal,
          stdout: Buffer.concat(out.stdout).toString('utf-8'),
          stderr: Buffer.concat(out.stderr).toString('utf-8'),
          truncated: total.stdout > max || total.stderr > max,
          stdout_bytes: total.stdout,
          stderr_bytes: total.stderr,
          timed_out: timedOut,
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try { stream.signal('KILL'); } catch (_) { /* not supported */ }
        try { stream.close(); } catch (_) { /* gone */ }
        /* The server keeps the channel while something still holds its pipes:
           answer now, and stop giving this connection new channels (it closes
           once that channel finally does). */
        stuck = setTimeout(() => { ch.retire(); finish(); }, 1500);
        if (stuck.unref) stuck.unref();
      }, timeoutMs);
      stream.on('close', finish);
      try { stream.end(); } catch (_) { /* ignore */ }
    });
  }

  async _logged(tool, t, extra, fn) {
    const t0 = Date.now();
    const startedAt = new Date(t0).toISOString();
    try {
      const r = await fn();
      await this.log.add({ tool, ...this._logInfo(t), ...extra(r), ok: true, durationMs: Date.now() - t0, startedAt });
      return r;
    } catch (err) {
      await this.log.add({ tool, ...this._logInfo(t), ...extra(null), ok: false, error: err.message, durationMs: Date.now() - t0, startedAt });
      throw err;
    }
  }

  // ─── Tools ──────────────────────────────────────────────

  async runCommand(p) {
    if (typeof p.command !== 'string' || !p.command.trim()) fail('Missing "command".', 'invalid');
    if (p.command.length > this.limits.command) fail(`"command" is longer than ${this.limits.command} characters.`, 'invalid');
    if (p.cwd !== undefined && p.cwd !== null && typeof p.cwd !== 'string') fail('"cwd" must be a string.', 'invalid');
    let secs = p.timeout_s === undefined || p.timeout_s === null ? this.limits.timeoutDefaultS : Number(p.timeout_s);
    if (!Number.isFinite(secs) || secs <= 0) fail('"timeout_s" must be a positive number of seconds.', 'invalid');
    secs = Math.min(secs, this.limits.timeoutMaxS);
    const t = await this._target(p.host);
    const t0 = Date.now();
    return this._logged('run_command', t, (r) => ({ command: p.command, exitCode: r ? r.exit_code : undefined }), async () => {
      let r;
      if (t.kind === 'local') {
        r = await localExec.runLocal({ command: p.command, cwd: p.cwd || undefined, timeoutMs: secs * 1000, maxBytes: this.limits.output });
      } else {
        const cmd = `${remoteCd(p.cwd)}${p.command}`;
        /* The timeout covers waiting for a free channel too, not the login */
        const ch = await this._channel(t, (c, cb) => c.exec(cmd, cb), t0 + secs * 1000, 'Could not start the command');
        r = await this._exec(ch, t, Math.max(1, secs * 1000 - ch.waitedMs));
      }
      return { host: t.name, ...r, duration_ms: Date.now() - t0 };
    });
  }

  _newShellId() { return `sh_${crypto.randomBytes(9).toString('hex')}`; }

  async openShell(p) {
    const t = await this._target(p.host);
    const cols = Math.min(500, Math.max(20, Number(p.cols) || 120));
    const rows = Math.min(200, Math.max(5, Number(p.rows) || 40));
    return this._logged('open_shell', t, () => ({}), async () => {
      const id = this._newShellId();
      const entry = {
        id, name: t.name, kind: t.kind, chunks: [], len: 0, dropped: 0, closed: false, exitCode: null,
        waiters: new Set(), lastActive: Date.now(), startedAt: new Date().toISOString(), target: t,
        decoder: new StringDecoder('utf-8'),
      };
      const onData = (d) => this._shellData(entry, typeof d === 'string' ? d : entry.decoder.write(d));
      if (t.kind === 'local') {
        const { pty, unit } = await localExec.spawnLocalShell({ cols, rows, cwd: p.cwd });
        entry.pty = pty;
        entry.unit = unit;
        pty.onData(onData);
        pty.onExit(({ exitCode }) => this._shellClosed(entry, exitCode));
      } else {
        /* A channel on the pooled connection: while it is open the connection stays in use */
        const ch = await this._channel(t, (c, cb) => c.shell({ term: 'xterm-256color', cols, rows }, cb),
          Date.now() + this.limits.timeoutDefaultS * 1000, 'Could not open a shell');
        const stream = ch.stream;
        entry.channel = ch;
        entry.stream = stream;
        stream.on('data', onData);
        stream.stderr.on('data', onData);
        stream.on('exit', (c) => { entry.exitCode = typeof c === 'number' ? c : null; });
        /* ssh2 closes every channel when the socket goes: this covers a dropped connection too */
        stream.on('close', () => this._shellClosed(entry, entry.exitCode));
      }
      this.shells.set(id, entry);
      this._emitStatus();
      return { session_id: id, host: t.name, idle_timeout_s: Math.round(this.idleMs / 1000) };
    });
  }

  _shellData(entry, text) {
    if (!text) return;
    entry.chunks.push(text);
    entry.len += text.length;
    while (entry.len > this.limits.shellBuffer && entry.chunks.length > 1) {
      const gone = entry.chunks.shift();
      entry.len -= gone.length;
      entry.dropped += gone.length;
    }
    for (const w of [...entry.waiters]) w();
  }

  _shellClosed(entry, exitCode) {
    if (entry.closed) return;
    entry.closed = true;
    if (exitCode !== undefined && exitCode !== null) entry.exitCode = exitCode;
    const tail = entry.decoder.end();
    if (tail) this._shellData(entry, tail);
    for (const w of [...entry.waiters]) w();
    /* The connection is shared: only this shell's channel goes */
    try { if (entry.stream) entry.stream.close(); } catch (_) { /* gone */ }
    this._emitStatus();
  }

  _shell(id) {
    const entry = typeof id === 'string' ? this.shells.get(id) : null;
    if (!entry) fail(`No open shell "${id}" (closed, or idle for ${Math.round(this.idleMs / 60000)} min). Open a new one with open_shell.`, 'not-found');
    entry.lastActive = Date.now();
    return entry;
  }

  async sendInput(p) {
    const entry = this._shell(p.session_id);
    if (typeof p.data !== 'string') fail('"data" must be a string (use "\\r" for Enter).', 'invalid');
    if (p.data.length > this.limits.input) fail(`"data" is longer than ${this.limits.input} characters.`, 'invalid');
    if (entry.closed) fail('That shell has exited. Read its last output with read_output, or open a new one.', 'closed');
    if (entry.pty) entry.pty.write(p.data);
    else entry.stream.write(p.data);
    await this.log.add({ tool: 'send_input', ...this._logInfo(entry.target), command: p.data, ok: true, durationMs: 0 });
    return { ok: true, bytes: Buffer.byteLength(p.data) };
  }

  async readOutput(p) {
    const entry = this._shell(p.session_id);
    const waitMs = Math.min(this.limits.waitMaxMs, Math.max(0, p.wait_ms === undefined ? 1000 : Number(p.wait_ms) || 0));
    const deadline = Date.now() + waitMs;
    const waitFor = (ms) => new Promise((resolve) => {
      if (ms <= 0) { resolve(); return; }
      const w = () => { clearTimeout(timer); entry.waiters.delete(w); resolve(); };
      const timer = setTimeout(w, ms);
      entry.waiters.add(w);
    });
    if (!entry.len && !entry.closed) await waitFor(deadline - Date.now());
    /* Something arrived: let the rest of the burst land (150 ms of quiet) */
    while (entry.len && !entry.closed && Date.now() < deadline) {
      const before = entry.len;
      await new Promise(r => setTimeout(r, 150));
      if (entry.len === before) break;
    }
    const output = entry.chunks.join('');
    const dropped = entry.dropped;
    entry.chunks = [];
    entry.len = 0;
    entry.dropped = 0;
    const res = { session_id: entry.id, output, closed: entry.closed, exit_code: entry.closed ? entry.exitCode : null };
    if (dropped) res.dropped_chars = dropped;
    if (entry.closed) this.shells.delete(entry.id);
    return res;
  }

  _closeShell(id, why) {
    const entry = this.shells.get(id);
    if (!entry) return false;
    this.shells.delete(id);
    try {
      if (entry.pty) {
        entry.pty.kill();
        if (entry.unit) localExec.stopUnit(entry.unit);
      } else {
        /* Only this channel: the connection is shared with other agent calls */
        try { entry.stream.end('exit\n'); } catch (_) { /* gone */ }
        try { entry.stream.close(); } catch (_) { /* gone */ }
      }
    } catch (_) { /* gone */ }
    if (!entry.closed) {
      entry.closed = true;
      for (const w of [...entry.waiters]) w();
    }
    if (why !== 'quit') this.log.add({ tool: why === 'idle' ? 'close_shell (idle)' : 'close_shell', ...this._logInfo(entry.target), ok: true, durationMs: Date.now() - Date.parse(entry.startedAt) });
    this._emitStatus();
    return true;
  }

  async closeShellTool(p) {
    this._shell(p.session_id);
    this._closeShell(p.session_id, 'agent');
    return { ok: true };
  }

  _closeIdle() {
    const now = Date.now();
    for (const [id, e] of this.shells) {
      if (now - e.lastActive > this.idleMs) this._closeShell(id, 'idle');
    }
  }

  status() {
    return {
      listening: !!this.server,
      shells: [...this.shells.values()].filter(e => !e.closed).map(e => ({ session_id: e.id, host: e.name, kind: e.kind, startedAt: e.startedAt })),
    };
  }

  _emitStatus() {
    if (typeof this.broadcast !== 'function') return;
    try { this.broadcast('agent:status', this.status()); } catch (_) { /* no windows */ }
  }

  // ─── Files ──────────────────────────────────────────────

  /*
   * fn(sftp) on the host's shared SFTP channel. A drop while it runs is an
   * error (not retried); an SFTP failure that is not a file status (no
   * numeric code) discards the channel so the next call opens a fresh one.
   */
  async _withSftp(t, what, fn) {
    const spec = await this._poolSpec(t);
    let s;
    try {
      s = await this.pool.sftp(spec, Date.now() + this.limits.timeoutDefaultS * 1000);
    } catch (err) {
      if (err instanceof AgentError || err.code === 'timeout') throw new AgentError(err.code, err.message);
      throw new AgentError('sftp', `SFTP is not available on this host: ${err.message}`);
    }
    try {
      return await fn(s.sftp);
    } catch (err) {
      if (s.lost()) throw this._lostError(t, what);
      if (!(err instanceof AgentError) && typeof err.code !== 'number') s.discard();
      throw err;
    } finally {
      s.done();
    }
  }

  async _remotePath(sftp, p) {
    if (typeof p !== 'string' || !p) fail('Missing "path".', 'invalid');
    if (p.startsWith('/')) return p;
    const home = await new Promise((resolve, reject) => sftp.realpath('.', (e, r) => (e ? reject(e) : resolve(r))));
    if (p === '~') return home;
    return path.posix.join(home, p.startsWith('~/') ? p.slice(2) : p);
  }

  async readFile(p) {
    const max = Math.min(this.limits.readMax, Math.max(1, Number(p.max_bytes) || this.limits.readDefault));
    const t = await this._target(p.host);
    return this._logged('read_file', t, () => ({ command: String(p.path || '') }), async () => {
      if (t.kind === 'local') {
        const file = localExec.resolveLocalPath(p.path);
        const st = await fsp.stat(file).catch((e) => fail(`${file}: ${e.code || e.message}`, 'not-found'));
        if (!st.isFile()) fail(`${file} is not a regular file.`, 'invalid');
        const fh = await fsp.open(file, 'r');
        try {
          const buf = Buffer.alloc(Math.min(max, st.size));
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          return { host: t.name, path: file, size: st.size, truncated: st.size > bytesRead, ...decodeText(buf.subarray(0, bytesRead)) };
        } finally { await fh.close(); }
      }
      return this._withSftp(t, `reading ${p.path}`, async (sftp) => {
        const file = await this._remotePath(sftp, p.path);
        const call = (fn, ...a) => new Promise((resolve, reject) => sftp[fn](...a, (e, ...r) => (e ? reject(e) : resolve(r))));
        const [st] = await call('stat', file).catch(e => fail(`${file}: ${e.message}`, 'not-found'));
        if (!st.isFile()) fail(`${file} is not a regular file.`, 'invalid');
        const [handle] = await call('open', file, 'r');
        const want = Math.min(max, st.size);
        const buf = Buffer.alloc(want);
        let off = 0;
        try {
          while (off < want) {
            const [n] = await call('read', handle, buf, off, Math.min(32768, want - off), off);
            if (!n) break;
            off += n;
          }
        } finally { await call('close', handle).catch(() => {}); }
        return { host: t.name, path: file, size: st.size, truncated: st.size > off, ...decodeText(buf.subarray(0, off)) };
      });
    });
  }

  async writeFile(p) {
    if (typeof p.content !== 'string') fail('"content" must be a string.', 'invalid');
    const encoding = p.encoding === 'base64' ? 'base64' : 'utf-8';
    const data = Buffer.from(p.content, encoding === 'base64' ? 'base64' : 'utf-8');
    if (data.length > this.limits.writeMax) fail(`"content" is larger than ${this.limits.writeMax} bytes.`, 'invalid');
    const mode = parseMode(p.mode);
    const t = await this._target(p.host);
    return this._logged('write_file', t, () => ({ command: `${p.path || ''} (${data.length} bytes)` }), async () => {
      if (t.kind === 'local') {
        const file = localExec.resolveLocalPath(p.path);
        await fsp.writeFile(file, data, mode === null ? undefined : { mode });
        if (mode !== null) await fsp.chmod(file, mode);
        return { host: t.name, path: file, bytes_written: data.length };
      }
      return this._withSftp(t, `writing ${p.path}`, async (sftp) => {
        const file = await this._remotePath(sftp, p.path);
        await new Promise((resolve, reject) => sftp.writeFile(file, data, mode === null ? {} : { mode }, e => (e ? reject(new AgentError('sftp', `${file}: ${e.message}`)) : resolve())));
        if (mode !== null) await new Promise((resolve, reject) => sftp.chmod(file, mode, e => (e ? reject(new AgentError('sftp', `chmod ${file}: ${e.message}`)) : resolve())));
        return { host: t.name, path: file, bytes_written: data.length };
      });
    });
  }
}

module.exports = new AgentService();
module.exports.AgentService = AgentService;
module.exports.agentMayUse = agentMayUse;
module.exports.LIMITS = LIMITS;
