/**
 * Session keeper: Termilab's own helper on the server (electron/keeper/, a
 * static binary per arch) that holds the shell's pty, so a session outlives
 * SSH disconnects and app quits and comes back with its screen replayed. No
 * tmux/screen/dtach on the server.
 *
 *   prepare(client, config) -> { bin, kv, arch, installed, notices[] }
 *                            | { fallback: true, reason, notices[] }
 *
 * Never throws and never fails a connect: anything unexpected is a fallback
 * to a plain shell (ssh-service prints one dim line saying why).
 *
 * Files on the server, all owned by the user and 0700 (never symlinks):
 *   ~/.termilab/            ~/.termilab/bin/termilab-keeper-<KV>-<arch>
 *   ~/.termilab/run/        (the keeper's sockets; it checks them itself too)
 *
 * The local binaries are found by a resolver (binDir) because they live in
 * different places: electron/keeper/bin on desktop (inside app.asar when
 * packaged: read with fs.readFileSync only, never streamed or exec'd), and
 * <bundle dir>/keeper on Android (scripts/build-mobile-node.js copies them).
 * manifest.json, when present beside or above them, must agree with the
 * files' own sha256; without it the files' names give KV and arch.
 *
 * Local state (this computer only, not a sync collection):
 *   <userData>/data/keeper-state.json
 *   { deviceId, owned: [keeperId…], hosts: { "<user>@<host>:<port>": {installedNotice, lingerNotice} } }
 * `owned` = the keeper ids THIS device created (auto-restore only reattaches
 * those; a session adopted from "Background sessions" is not in it).
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PROBE_COMMAND = 'uname -sm; echo "$HOME"; id -u';
const PROBE_TIMEOUT_MS = 5000;
const STEP_TIMEOUT_MS = 15000;
const LIST_TIMEOUT_MS = 2000;
const KILL_TIMEOUT_MS = 6000;
const ID_RE = /^[a-z0-9]{8,40}$/;
const ADOPTED_KEY_RE = /^keeper:([a-z0-9]{8,40})$/;
const BIN_NAME_RE = /^termilab-keeper-(\d+)-([a-z0-9_]+)$/;
const OWNED_CAP = 1000;
/* What `list` reports as fgCommand when only the shell is in the foreground */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'fish', 'ksh', 'mksh', 'pdksh', 'tcsh', 'csh', 'yash', 'busybox', 'nu', 'elvish', 'xonsh']);

/* ── Local binaries ───────────────────────────────────────── */

function binDirCandidates() {
  const out = [
    path.join(__dirname, '../keeper/bin'),   // desktop: electron/services -> electron/keeper/bin
    path.join(__dirname, 'keeper'),          // Android bundle: <nodejs>/keeper
    path.join(__dirname, 'keeper/bin'),
  ];
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, 'keeper', 'bin'), path.join(process.resourcesPath, 'keeper'));
  return out;
}

let localCache = null;

/** {dir, kv, binaries: {arch: {file, path, sha256, size}}} or null */
function localBinaries() {
  if (localCache) return localCache;
  for (const dir of binDirCandidates()) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    const found = {};
    let kv = 0;
    for (const n of names) {
      const m = BIN_NAME_RE.exec(n);
      if (!m) continue;
      const v = Number(m[1]);
      if (v > kv) { kv = v; }
    }
    if (!kv) continue;
    for (const n of names) {
      const m = BIN_NAME_RE.exec(n);
      if (m && Number(m[1]) === kv) found[m[2]] = { file: n, path: path.join(dir, n) };
    }
    let manifest = null;
    for (const mf of [path.join(dir, 'manifest.json'), path.join(dir, '..', 'manifest.json')]) {
      try { manifest = JSON.parse(fs.readFileSync(mf, 'utf-8')); break; } catch (_) { /* next */ }
    }
    if (manifest && manifest.kv === kv && manifest.binaries) {
      for (const arch of Object.keys(found)) {
        if (!manifest.binaries[arch]) delete found[arch];
        else found[arch].manifestSha = manifest.binaries[arch].sha256;
      }
    }
    localCache = { dir, kv, binaries: found };
    return localCache;
  }
  return null;
}

/* Bytes + sha256 of one local binary (read whole: asar-safe), checked against the manifest */
const bytesCache = new Map();
function localBinary(arch) {
  const local = localBinaries();
  const b = local && local.binaries[arch];
  if (!b) return null;
  if (bytesCache.has(arch)) return bytesCache.get(arch);
  const data = fs.readFileSync(b.path);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  if (b.manifestSha && b.manifestSha !== sha256) throw new Error(`local ${b.file} does not match its manifest`);
  const out = { ...b, data, sha256, size: data.length, kv: local.kv };
  bytesCache.set(arch, out);
  return out;
}

/* ── Ids ──────────────────────────────────────────────────── */

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The keeper id for a tab's sessionKey: base32(sha256) cut to 26, or the id an adopted key names */
function keeperIdFor(sessionKey) {
  const m = ADOPTED_KEY_RE.exec(String(sessionKey || ''));
  if (m) return m[1];
  return base32(crypto.createHash('sha256').update(String(sessionKey)).digest()).slice(0, 26);
}

/** Single-quoted for sh */
function sq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/* ── Remote helpers ───────────────────────────────────────── */

/**
 * One exec on `client`: { code, signal, stdout: Buffer, stderr } or throws
 * ('timeout', channel refused). `stdin` (Buffer) is written then ended.
 */
function run(client, command, { timeout = STEP_TIMEOUT_MS, stdin = null, maxOut = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let channel = null;
    const out = []; let outLen = 0; let err = '';
    let code = null; let signal = null;
    const finish = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (e && channel) { try { channel.close(); } catch (_) { /* gone */ } }
      if (e) reject(e);
      else resolve({ code, signal, stdout: Buffer.concat(out), stderr: err });
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeout);
    try {
      client.exec(command, (e, stream) => {
        if (e) return finish(e);
        if (done) { try { stream.close(); } catch (_) { /* ignore */ } return; }
        channel = stream;
        /* With zlib, a channel that dies with its transport is destroyed by
           ssh2 after the compressor is gone, and that close() THROWS
           ("Invalid Zlib instance") from a nextTick: uncaught, it takes main
           down. Our ended exec channels are the ones that hit it. */
        const destroy = stream.destroy;
        stream.destroy = function guardedDestroy(...a) {
          try { return destroy.apply(this, a); } catch (_) { return this; }
        };
        stream.on('data', (d) => {
          if (outLen < maxOut) { out.push(d); outLen += d.length; }
        });
        if (stream.stderr) stream.stderr.on('data', (d) => { if (err.length < 8192) err += d.toString('utf-8'); });
        stream.on('exit', (c, s) => { code = typeof c === 'number' ? c : null; signal = s || null; });
        stream.on('error', (e2) => finish(e2));
        stream.on('close', () => finish(null));
        if (stdin) stream.end(stdin);
        else { try { stream.end(); } catch (_) { /* ignore */ } }
      });
    } catch (e) {
      finish(e);
    }
  });
}

function sftpOf(client, timeout = STEP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { done = true; resolve(null); }, timeout);
    try {
      client.sftp((err, sftp) => {
        if (done) { try { if (sftp) sftp.end(); } catch (_) { /* ignore */ } return; }
        done = true;
        clearTimeout(timer);
        resolve(err ? null : sftp);
      });
    } catch (_) {
      clearTimeout(timer);
      done = true;
      resolve(null);
    }
  });
}

const pcall = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
const withTimeout = (p, ms, what) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: timeout`)), ms).unref?.()),
]);

class Fallback extends Error {
  constructor(reason, { cache = true } = {}) { super(reason); this.reason = reason; this.cache = cache; }
}

/* ── The service ──────────────────────────────────────────── */

class KeeperService {
  constructor() {
    /** hostKey|KV -> Promise<result> (successes and permanent fallbacks) */
    this._prepared = new Map();
    this._state = null;
    this._stateWrite = Promise.resolve();
    /* The harness points this somewhere else */
    this.stateFile = null;
  }

  /* Local state */
  _stateFilePath() {
    if (this.stateFile) return this.stateFile;
    const storeService = require('./store-service');
    return path.join(storeService.dataDir, 'keeper-state.json');
  }

  _load() {
    if (this._state) return this._state;
    let s = null;
    try { s = JSON.parse(fs.readFileSync(this._stateFilePath(), 'utf-8')); } catch (_) { s = null; }
    if (!s || typeof s !== 'object') s = {};
    if (typeof s.deviceId !== 'string' || !s.deviceId) s.deviceId = crypto.randomBytes(12).toString('hex');
    if (!Array.isArray(s.owned)) s.owned = [];
    s.owned = s.owned.filter(id => ID_RE.test(id));
    if (!s.hosts || typeof s.hosts !== 'object') s.hosts = {};
    this._state = s;
    return s;
  }

  _save() {
    const s = this._load();
    const file = this._stateFilePath();
    const body = JSON.stringify(s, null, 2);
    this._stateWrite = this._stateWrite.then(async () => {
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
        await fsp.writeFile(tmp, body, 'utf-8');
        await fsp.rename(tmp, file);
      } catch (err) {
        console.error('[Keeper] Could not save keeper-state.json:', err.message);
      }
    });
    return this._stateWrite;
  }

  isOwned(id) { return this._load().owned.includes(id); }

  markOwned(id) {
    const s = this._load();
    if (s.owned.includes(id)) return;
    s.owned.push(id);
    if (s.owned.length > OWNED_CAP) s.owned.splice(0, s.owned.length - OWNED_CAP);
    this._save();
  }

  forget(id) {
    const s = this._load();
    const i = s.owned.indexOf(id);
    if (i === -1) return;
    s.owned.splice(i, 1);
    this._save();
  }

  /**
   * Which keeper session a terminal attaches to, and how.
   *  - adopted ("Attach here"): the id it names, never created, never owned
   *  - restored and not created by this device: a fresh session of its own
   *    (an id derived from sessionKey + this device), so a restore never
   *    steals a session another device or an adoption is using
   *  - otherwise: keeperIdFor(sessionKey), created if missing, owned
   */
  sessionFor(config) {
    const key = config.sessionKey || null;
    if (!key) return null;
    if (config.adopted) {
      const m = ADOPTED_KEY_RE.exec(key);
      return { id: m ? m[1] : keeperIdFor(key), create: false, adopted: true };
    }
    let id = keeperIdFor(key);
    if (config.restored && !this.isOwned(id)) {
      id = keeperIdFor(`${key}#${this._load().deviceId}`);
    }
    return { id, create: true, adopted: false };
  }

  /** Is the option on for this connection? host override, else Settings → Terminal */
  async wanted(config) {
    if (!config || config.purpose === 'sftp' || !config.sessionKey) return false;
    if (typeof config.keepSessions === 'boolean') return config.keepSessions;
    try {
      const storeService = require('./store-service');
      if (config.hostId) {
        const host = (await storeService.getHosts()).find(h => h.id === config.hostId);
        if (host && host.keepSessions === 'on') return true;
        if (host && host.keepSessions === 'off') return false;
      }
      const settings = await storeService.getSettings();
      return settings?.terminal?.keepSessions !== false;
    } catch (_) {
      return false;
    }
  }

  hostKey(config) {
    return `${config.username || ''}@${config.host}:${config.port || 22}`;
  }

  clearCache() {
    this._prepared.clear();
  }

  invalidate(config) {
    const local = localBinaries();
    this._prepared.delete(`${this.hostKey(config)}|${local ? local.kv : 0}`);
  }

  /** One-shot notices for this host (persisted: each is printed once per host, ever) */
  _noticeOnce(hostKey, kind) {
    const s = this._load();
    const h = s.hosts[hostKey] || (s.hosts[hostKey] = {});
    if (h[kind]) return false;
    h[kind] = Date.now();
    this._save();
    return true;
  }

  /**
   * Make the keeper usable on this client's server. Cached per (host, KV)
   * for the app run; notices are produced once.
   */
  async prepare(client, config) {
    const local = localBinaries();
    if (!local) return { fallback: true, reason: 'keeper binaries are missing from this build', notices: [] };
    const hostKey = this.hostKey(config);
    const cacheKey = `${hostKey}|${local.kv}`;
    let p = this._prepared.get(cacheKey);
    if (!p) {
      p = this._prepare(client, config, local, hostKey);
      this._prepared.set(cacheKey, p);
      p.then((r) => { if (r.fallback && !r.cache) this._prepared.delete(cacheKey); }, () => this._prepared.delete(cacheKey));
    }
    const r = await p;
    /* Notices go to the first terminal that asked, never twice */
    const notices = r._notices ? r._notices.splice(0) : [];
    return r.fallback
      ? { fallback: true, reason: r.reason, notices }
      : { bin: r.bin, kv: r.kv, arch: r.arch, home: r.home, installed: r.installed, notices };
  }

  async _prepare(client, config, local, hostKey) {
    const notices = [];
    try {
      const probe = await this.probe(client);
      const bin = localBinary(probe.arch);
      if (!bin) throw new Fallback(`unsupported architecture ${probe.arch}`);
      const remote = `${probe.home}/.termilab/bin/${bin.file}`;
      const sftp = await sftpOf(client);
      let installed = false;
      let firstInstall = false;
      try {
        const io = sftp ? sftpIo(sftp) : execIo(client);
        await io.ensureDirs(probe.home, probe.uid);
        const have = await io.readFile(remote, bin.size + 1).catch(() => null);
        const ok = have && have.length === bin.size
          && crypto.createHash('sha256').update(have).digest('hex') === bin.sha256;
        if (!ok) {
          const others = await io.listBin(`${probe.home}/.termilab/bin`).catch(() => []);
          firstInstall = !others.some(n => BIN_NAME_RE.test(n));
          await io.install(remote, bin, `${probe.home}/.termilab/bin`);
          installed = true;
        } else {
          await io.ensureMode(remote).catch(() => {});
        }
      } finally {
        if (sftp) { try { sftp.end(); } catch (_) { /* ignore */ } }
      }

      /* Can it run? 126 = found but not executable: a noexec home */
      let ver;
      try { ver = await run(client, `${sq(remote)} version`, { timeout: PROBE_TIMEOUT_MS, maxOut: 4096 }); } catch (e) {
        throw new Fallback(`the keeper did not answer (${e.message})`, { cache: false });
      }
      if (ver.code === 126) throw new Fallback('the home directory does not allow running programs (noexec)');
      if (ver.code !== 0) throw new Fallback(`the keeper did not run (exit ${ver.code === null ? ver.signal : ver.code})`);
      let info = null;
      try { info = JSON.parse(ver.stdout.toString('utf-8').trim().split('\n')[0]); } catch (_) { info = null; }
      if (!info || info.keeperVersion !== bin.kv) throw new Fallback('the keeper on the server reports another version');

      if (installed && firstInstall && this._noticeOnce(hostKey, 'installedNotice')) {
        notices.push(`Termilab installed its session keeper in ~/.termilab on this server (${bin.file}, ${Math.round(bin.size / 1024)} KB), so sessions survive disconnects. Turn it off in this host's settings: "Keep sessions alive".`);
      }
      if (installed) this._gc(client, remote, probe.home).catch(() => {});
      const linger = await this._lingerRisk(client).catch(() => false);
      if (linger && this._noticeOnce(hostKey, 'lingerNotice')) {
        notices.push('This server kills your processes when you log out (systemd-logind KillUserProcesses) and lingering is off for you: kept sessions will end at logout. Run `loginctl enable-linger` on the server to keep them.');
      }
      return { bin: remote, kv: bin.kv, arch: probe.arch, home: probe.home, installed, _notices: notices };
    } catch (err) {
      if (err instanceof Fallback) return { fallback: true, reason: err.reason, cache: err.cache, _notices: notices };
      return { fallback: true, reason: err.message || String(err), cache: false, _notices: notices };
    }
  }

  /** `uname -sm; echo $HOME; id -u` → {sysname, arch, home, uid} or a Fallback */
  async probe(client) {
    let r;
    try { r = await run(client, PROBE_COMMAND, { timeout: PROBE_TIMEOUT_MS, maxOut: 4096 }); } catch (e) {
      throw new Fallback(`could not probe the server (${e.message})`, { cache: false });
    }
    const lines = r.stdout.toString('utf-8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const [sysname, arch] = (lines[0] || '').split(/\s+/);
    const home = lines[1] || '';
    const uid = Number(lines[2]);
    if (sysname !== 'Linux') throw new Fallback(`not a Linux server (${sysname || 'unknown'})`);
    const local = localBinaries();
    if (!arch || !local.binaries[arch]) throw new Fallback(`unsupported architecture ${arch || 'unknown'}`);
    if (!home.startsWith('/') || /[\0\n]/.test(home)) throw new Fallback('the server reports no usable $HOME');
    if (!Number.isInteger(uid) || uid < 0) throw new Fallback('the server reports no usable uid');
    return { sysname, arch, home: home.replace(/\/+$/, '') || '/', uid };
  }

  /* KillUserProcesses=yes and Linger=no → kept sessions die at logout */
  async _lingerRisk(client) {
    const cmd = [
      'L=$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null)',
      'K=$(busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses 2>/dev/null)',
      'C=$(cat /etc/systemd/logind.conf /etc/systemd/logind.conf.d/*.conf 2>/dev/null | grep -E "^[[:space:]]*KillUserProcesses=" | tail -n 1)',
      'echo "L:$L"; echo "K:$K"; echo "C:$C"',
    ].join('; ');
    const r = await run(client, cmd, { timeout: PROBE_TIMEOUT_MS, maxOut: 4096 });
    return lingerRiskFrom(r.stdout.toString('utf-8'));
  }

  /* Delete other keeper versions no live daemon uses, and stale temp uploads */
  async _gc(client, remote, home) {
    const dir = `${home}/.termilab/bin`;
    const listed = await run(client, `${sq(remote)} list`, { timeout: PROBE_TIMEOUT_MS, maxOut: 256 * 1024 });
    if (listed.code !== 0) return;
    const inUse = new Set(parseList(listed.stdout.toString('utf-8')).map(r => Number(r.keeperVersion)).filter(Boolean));
    const names = await run(client, `ls -1A ${sq(dir)}`, { timeout: PROBE_TIMEOUT_MS, maxOut: 64 * 1024 });
    const current = path.posix.basename(remote);
    const drop = [];
    for (const n of names.stdout.toString('utf-8').split('\n').map(s => s.trim()).filter(Boolean)) {
      if (n === current) continue;
      const m = BIN_NAME_RE.exec(n);
      if (m && !inUse.has(Number(m[1]))) drop.push(n);
      else if (/^\.tmp-[a-f0-9]+$/.test(n)) drop.push(n);
    }
    if (!drop.length) return;
    await run(client, `cd ${sq(dir)} && rm -f -- ${drop.map(sq).join(' ')}`, { timeout: PROBE_TIMEOUT_MS });
  }

  /* ── Commands for a live session ── */

  attachCommand(bin, sess, cols, rows) {
    if (!ID_RE.test(sess.id)) throw new Error('bad keeper id');
    const c = Math.max(1, Math.min(9999, Number(cols) || 80));
    const r = Math.max(1, Math.min(9999, Number(rows) || 24));
    return `${sq(bin)} attach ${sess.id} --cols ${c} --rows ${r}${sess.create ? ' --create' : ''}`;
  }

  /** Rows of `<bin> list` (2 s cap) */
  async list(client, bin) {
    const r = await run(client, `${sq(bin)} list`, { timeout: LIST_TIMEOUT_MS, maxOut: 256 * 1024 });
    if (r.code !== 0) throw new Error(`keeper list failed (exit ${r.code})`);
    return parseList(r.stdout.toString('utf-8'));
  }

  /** {fgCommand, isShell} of session `id`, or null when it is not listed */
  async foreground(client, bin, id) {
    const rows = await this.list(client, bin);
    const row = rows.find(x => x.id === id);
    if (!row) return null;
    const fg = typeof row.fgCommand === 'string' ? row.fgCommand : '';
    return { fgCommand: fg || null, isShell: isShellCommand(fg) };
  }

  async kill(client, bin, id) {
    if (!ID_RE.test(String(id))) throw new Error('bad keeper id');
    const r = await run(client, `${sq(bin)} kill ${id}`, { timeout: KILL_TIMEOUT_MS, maxOut: 4096 });
    if (r.code !== 0 && r.code !== 102) throw new Error(`could not end the session (exit ${r.code}${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''})`);
    this.forget(id);
    return true;
  }

  /**
   * The installed keeper of THIS KV on a server, without installing anything
   * (Background sessions must not install on a host that has it off).
   * → bin path, or null when it is not there.
   */
  async locate(client) {
    const local = localBinaries();
    if (!local) return null;
    let probe;
    try { probe = await this.probe(client); } catch (_) { return null; }
    const bin = localBinary(probe.arch);
    if (!bin) return null;
    const remote = `${probe.home}/.termilab/bin/${bin.file}`;
    const r = await run(client, `test -x ${sq(remote)} && echo yes`, { timeout: PROBE_TIMEOUT_MS, maxOut: 64 }).catch(() => null);
    return r && r.stdout.toString().trim() === 'yes' ? remote : null;
  }
}

/* ── Pure helpers (the harness tests them directly) ─────────── */

function parseList(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o.id === 'string' && ID_RE.test(o.id)) out.push(o);
    } catch (_) { /* not ours */ }
  }
  return out;
}

function isShellCommand(fg) {
  const n = String(fg || '').replace(/^-/, '').trim();
  return !n || SHELLS.has(n);
}

function lingerRiskFrom(text) {
  const get = (k) => (String(text).split('\n').find(l => l.startsWith(`${k}:`)) || '').slice(k.length + 1).trim();
  const linger = /Linger=yes/i.test(get('L'));
  if (linger) return false;
  const k = get('K');
  if (/^b\s+true$/i.test(k)) return true;
  if (/^b\s+false$/i.test(k)) return false;
  return /KillUserProcesses=\s*(yes|true|1|on)\s*$/i.test(get('C'));
}

/* ── Remote file access: SFTP, or plain exec when there is no SFTP subsystem ── */

function checkStat(st, what, uid) {
  if (st.isSymbolicLink()) throw new Fallback(`${what} is a symlink`);
  if (!st.isDirectory()) throw new Fallback(`${what} is not a directory`);
  if (typeof st.uid === 'number' && st.uid !== uid) throw new Fallback(`${what} is not owned by you`);
  if ((st.mode & 0o077) !== 0) throw new Fallback(`${what} is not private (mode ${(st.mode & 0o777).toString(8)})`);
}

function sftpIo(sftp) {
  const lstat = (p) => withTimeout(pcall(cb => sftp.lstat(p, cb)), STEP_TIMEOUT_MS, 'lstat');
  return {
    async ensureDirs(home, uid) {
      for (const rel of ['.termilab', '.termilab/bin', '.termilab/run']) {
        const p = `${home}/${rel}`;
        const what = `~/${rel}`;
        let st;
        try { st = await lstat(p); } catch (err) {
          if (err.code === 3) throw new Fallback(`cannot access ${what} (permission denied)`);
          if (err.code !== 2) throw new Fallback(`cannot access ${what} (${err.message})`);
          try { await withTimeout(pcall(cb => sftp.mkdir(p, { mode: 0o700 }, cb)), STEP_TIMEOUT_MS, 'mkdir'); } catch (e2) {
            throw new Fallback(`cannot create ${what} (${e2.code === 3 ? 'permission denied' : e2.message})`);
          }
          try { await withTimeout(pcall(cb => sftp.chmod(p, 0o700, cb)), STEP_TIMEOUT_MS, 'chmod'); } catch (_) { /* checked below */ }
          st = await lstat(p);
        }
        checkStat(st, what, uid);
      }
    },
    async readFile(p, max) {
      const st = await lstat(p);
      if (!st.isFile() || st.size > max) return null;
      return withTimeout(pcall(cb => sftp.readFile(p, cb)), STEP_TIMEOUT_MS, 'read');
    },
    async listBin(dir) {
      const items = await withTimeout(pcall(cb => sftp.readdir(dir, cb)), STEP_TIMEOUT_MS, 'readdir');
      return items.map(i => i.filename);
    },
    async ensureMode(p) {
      const st = await lstat(p);
      if ((st.mode & 0o777) !== 0o700) await withTimeout(pcall(cb => sftp.chmod(p, 0o700, cb)), STEP_TIMEOUT_MS, 'chmod');
    },
    async install(remote, bin, dir) {
      const tmp = `${dir}/.tmp-${crypto.randomBytes(6).toString('hex')}`;
      try {
        const handle = await withTimeout(pcall(cb => sftp.open(tmp, 'wx', { mode: 0o700 }, cb)), STEP_TIMEOUT_MS, 'open');
        try {
          let off = 0;
          while (off < bin.data.length) {
            const n = Math.min(32768, bin.data.length - off);
            await withTimeout(pcall(cb => sftp.write(handle, bin.data, off, n, off, cb)), STEP_TIMEOUT_MS, 'write');
            off += n;
          }
        } finally {
          await pcall(cb => sftp.close(handle, cb)).catch(() => {});
        }
        await withTimeout(pcall(cb => sftp.chmod(tmp, 0o700, cb)), STEP_TIMEOUT_MS, 'chmod');
        const back = await withTimeout(pcall(cb => sftp.readFile(tmp, cb)), STEP_TIMEOUT_MS, 'read');
        if (crypto.createHash('sha256').update(back).digest('hex') !== bin.sha256) throw new Error('the uploaded keeper does not verify');
        const posix = sftp._extensions && sftp._extensions['posix-rename@openssh.com'];
        if (posix && typeof sftp.ext_openssh_rename === 'function') {
          await withTimeout(pcall(cb => sftp.ext_openssh_rename(tmp, remote, cb)), STEP_TIMEOUT_MS, 'rename');
        } else {
          await pcall(cb => sftp.unlink(remote, cb)).catch(() => {});
          await withTimeout(pcall(cb => sftp.rename(tmp, remote, cb)), STEP_TIMEOUT_MS, 'rename');
        }
      } catch (err) {
        await pcall(cb => sftp.unlink(tmp, cb)).catch(() => {});
        if (err instanceof Fallback) throw err;
        throw new Fallback(`could not install the keeper (${err.message})`, { cache: false });
      }
    },
  };
}

function execIo(client) {
  return {
    async ensureDirs(home) {
      const script = [
        'umask 077',
        `for x in ${sq(`${home}/.termilab`)} ${sq(`${home}/.termilab/bin`)} ${sq(`${home}/.termilab/run`)}; do`,
        '  if [ -L "$x" ]; then echo "BAD symlink $x"; exit 3; fi',
        '  if [ ! -e "$x" ]; then mkdir -m 700 "$x" 2>/dev/null || { echo "BAD create $x"; exit 3; }; fi',
        '  if [ ! -d "$x" ]; then echo "BAD notdir $x"; exit 3; fi',
        '  if [ ! -O "$x" ]; then echo "BAD owner $x"; exit 3; fi',
        '  if [ ! -x "$x" ] || [ ! -r "$x" ] || [ ! -w "$x" ]; then echo "BAD access $x"; exit 3; fi',
        '  case "$(ls -ld "$x")" in d???------*) ;; *) echo "BAD mode $x"; exit 3;; esac',
        'done',
        'echo OK',
      ].join('\n');
      let r;
      try { r = await run(client, script, { timeout: STEP_TIMEOUT_MS, maxOut: 4096 }); } catch (e) {
        throw new Fallback(`cannot check ~/.termilab (${e.message})`, { cache: false });
      }
      const out = r.stdout.toString('utf-8').trim();
      if (out.endsWith('OK')) return;
      const m = /BAD (\w+) (.*)$/m.exec(out);
      const what = m ? `~${m[2].slice(home.length)}` : '~/.termilab';
      const why = { symlink: 'is a symlink', create: 'cannot be created', notdir: 'is not a directory', owner: 'is not owned by you', access: 'is not accessible (permission denied)', mode: 'is not private' }[m && m[1]] || 'is not usable';
      throw new Fallback(`${what} ${why}`);
    },
    async readFile(p, max) {
      const r = await run(client, `cat ${sq(p)}`, { timeout: STEP_TIMEOUT_MS, maxOut: max + 1 });
      return r.code === 0 ? r.stdout : null;
    },
    async listBin(dir) {
      const r = await run(client, `ls -1A ${sq(dir)}`, { timeout: STEP_TIMEOUT_MS, maxOut: 64 * 1024 });
      return r.stdout.toString('utf-8').split('\n').map(s => s.trim()).filter(Boolean);
    },
    async ensureMode(p) {
      await run(client, `chmod 700 ${sq(p)}`, { timeout: STEP_TIMEOUT_MS });
    },
    async install(remote, bin, dir) {
      const tmp = `${dir}/.tmp-${crypto.randomBytes(6).toString('hex')}`;
      try {
        const w = await run(client, `umask 077; set -C; cat > ${sq(tmp)} && chmod 700 ${sq(tmp)}`, { timeout: STEP_TIMEOUT_MS * 2, stdin: bin.data });
        if (w.code !== 0) throw new Error(`upload exit ${w.code}`);
        const back = await run(client, `cat ${sq(tmp)}`, { timeout: STEP_TIMEOUT_MS, maxOut: bin.size + 1 });
        if (crypto.createHash('sha256').update(back.stdout).digest('hex') !== bin.sha256) throw new Error('the uploaded keeper does not verify');
        const mv = await run(client, `mv -f ${sq(tmp)} ${sq(remote)}`, { timeout: STEP_TIMEOUT_MS });
        if (mv.code !== 0) throw new Error(`rename exit ${mv.code}`);
      } catch (err) {
        await run(client, `rm -f ${sq(tmp)}`, { timeout: STEP_TIMEOUT_MS }).catch(() => {});
        throw new Fallback(`could not install the keeper (${err.message})`, { cache: false });
      }
    },
  };
}

const service = new KeeperService();
module.exports = service;
module.exports.KeeperService = KeeperService;
module.exports.keeperIdFor = keeperIdFor;
module.exports.parseList = parseList;
module.exports.isShellCommand = isShellCommand;
module.exports.lingerRiskFrom = lingerRiskFrom;
module.exports.localBinaries = localBinaries;
module.exports.binDirCandidates = binDirCandidates;
module.exports.EXIT = { OK: 0, REPLACED: 75, KILLED: 76, GONE: 77, ERR: 101, NOSESSION: 102, CAP: 103, PROTO: 104 };
