/**
 * Session keeper for LOCAL terminals (Linux desktop only): the same static
 * termilab-keeper binary the servers get (keeper-service.js), so a local shell
 * (an agent mid-task) survives closing the tab's window, quitting Termilab and
 * restarting it, and comes back with its screen replayed.
 *
 *   prepare()        → { bin, kv, arch, home, systemdRun } | { fallback, reason }
 *   open(opts)       → { bin, id, args, adopted, unit } | { fallback, reason }
 *                      args = what node-pty runs instead of the shell:
 *                      `<bin> attach <id> --cols C --rows R [--create]`
 *
 * Install: the bundled binary for process.arch (read whole with readFileSync:
 * inside app.asar it cannot be exec'd) is copied to
 * ~/.termilab/bin/termilab-keeper-<KV>-<arch>, under the same rules as on a
 * server: ~/.termilab{,/bin,/run} owned by us, 0700, never symlinks; written
 * to `.tmp-<rand>` (O_EXCL), read back and sha256-checked, then renamed.
 *
 * Survival: the daemon must not live in a cgroup that dies with Termilab. A
 * desktop launcher may run Termilab as a transient `run-*.service` or
 * `app-*.service` (seen on the owner's machine): when its main process exits,
 * systemd kills the whole cgroup, double-forked daemons included. And with
 * no_new_privs the escape (local-shell-escape.js) runs each shell inside a
 * `termilab-shell-<sid>.service` that is stopped with its tab. So, whenever
 * the user manager is reachable, the session is CREATED by the manager in a
 * unit of its own:
 *
 *   systemd-run --user --collect --unit=termilab-keep-<id> -p Type=forking
 *     -- /bin/sh -c '<bin> attach <id> --create </dev/null; [ $? -eq 77 ]'
 *
 * The attach forks the daemon and, its stdin being /dev/null, detaches at
 * once (77); the daemon (reparented to the manager, a subreaper) becomes the
 * unit's main pid, the unit lives as long as the session and is collected
 * after. Started by the manager, the daemon and its shell have NNP=0 even
 * when Termilab has NNP=1 (snap, sudo work). The tab's pty then runs only an
 * attach client, directly under node-pty: no per-tab unit at all, so closing
 * the tab or quitting just detaches (SIGHUP → 77).
 * No systemd: the attach creates the daemon itself (`--create`), as before.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const keeper = require('./keeper-service');
const ptyEscape = require('./local-shell-escape');

const UNIT_PREFIX = 'termilab-keep-';
const ARCH = { x64: 'x86_64', arm64: 'aarch64', arm: 'armv7l', riscv64: 'riscv64' };
const CAP = 20;
const RUN_TIMEOUT_MS = 5000;
const CREATE_TIMEOUT_MS = 15000;
/* $0 = bin, $1 = id, $2/$3 = size. Exit 0 only when the attach detached (77):
   the session exists and nobody holds it. */
const CREATE_SCRIPT = '"$0" attach "$1" --create --cols "$2" --rows "$3" </dev/null >/dev/null; [ $? -eq 77 ]';

class Fallback extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

/* ── Pure helpers (the harness tests them) ───────────────── */

const archFor = (nodeArch) => ARCH[nodeArch] || null;
const keepUnitName = (id) => `${UNIT_PREFIX}${String(id).replace(/[^a-z0-9]/g, '')}`;
const clampSize = (n, d) => Math.max(1, Math.min(9999, Number(n) || d));

/** The keeper session a local tab attaches to: `keeper:<id>` names one (adopted, never created) */
function sessionFor(sessionKey) {
  const key = String(sessionKey || '');
  if (!key) return null;
  const m = keeper.ADOPTED_KEY_RE.exec(key);
  if (m) return { id: m[1], adopted: true };
  return { id: keeper.keeperIdFor(key), adopted: false };
}

/** argv of `attach` for node-pty */
function attachArgs(id, cols, rows, create) {
  if (!keeper.ID_RE.test(id)) throw new Error('bad keeper id');
  const a = ['attach', id, '--cols', String(clampSize(cols, 80)), '--rows', String(clampSize(rows, 24))];
  if (create) a.push('--create');
  return a;
}

/** argv of systemd-run that creates session `id` in its own long-lived unit */
function buildCreateArgs({ bin, id, cols, rows, setenv = {} }) {
  if (!keeper.ID_RE.test(id)) throw new Error('bad keeper id');
  const args = ['--user', '--quiet', '--collect', '--same-dir', `--unit=${keepUnitName(id)}`,
    '-p', 'Type=forking', '--description=Termilab kept local session'];
  for (const [k, v] of Object.entries(setenv)) args.push(`--setenv=${k}=${v}`);
  args.push('--', '/bin/sh', '-c', CREATE_SCRIPT, bin, id, String(clampSize(cols, 80)), String(clampSize(rows, 24)));
  return args;
}

/* ── Impure ──────────────────────────────────────────────── */

function run(file, args, { timeout = RUN_TIMEOUT_MS, env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout, env, cwd, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        let code = 0;
        if (err) code = typeof err.code === 'number' ? err.code : (err.code === 'EACCES' ? 126 : (err.code === 'ENOENT' ? 127 : null));
        resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err || null });
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', error: err });
    }
  });
}

function checkDir(p, what, uid) {
  let st;
  try { st = fs.lstatSync(p); } catch (err) {
    if (err.code !== 'ENOENT') throw new Fallback(`cannot access ${what} (${err.code})`);
    try { fs.mkdirSync(p, { mode: 0o700 }); fs.chmodSync(p, 0o700); } catch (e2) {
      throw new Fallback(`cannot create ${what} (${e2.code || e2.message})`);
    }
    st = fs.lstatSync(p);
  }
  if (st.isSymbolicLink()) throw new Fallback(`${what} is a symlink`);
  if (!st.isDirectory()) throw new Fallback(`${what} is not a directory`);
  if (st.uid !== uid) throw new Fallback(`${what} is not owned by you`);
  if ((st.mode & 0o077) !== 0) throw new Fallback(`${what} is not private (mode ${(st.mode & 0o777).toString(8)})`);
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* The installed copy, if it is exactly ours (regular file, same bytes) */
function installedOk(target, bin) {
  try {
    const st = fs.lstatSync(target);
    if (!st.isFile() || st.size !== bin.size) return false;
    return sha(fs.readFileSync(target)) === bin.sha256;
  } catch (_) { return false; }
}

function install(target, bin) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(6).toString('hex')}`);
  try {
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o700);
    try {
      fs.writeSync(fd, bin.data, 0, bin.data.length, 0);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.chmodSync(tmp, 0o700);
    if (sha(fs.readFileSync(tmp)) !== bin.sha256) throw new Error('the copied keeper does not verify');
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never made */ }
    throw new Fallback(`could not install the keeper in ~/.termilab (${err.code || err.message})`);
  }
}

class LocalKeeper {
  constructor() {
    /** `${home}|${kv}` -> Promise<prepare result> (successes only) */
    this._prepared = new Map();
    /* null = Settings → Terminal → Keep sessions alive; the harness sets a boolean */
    this.keepOverride = null;
    /* The harness can force 'direct' (no systemd) creation */
    this.forceDirect = false;
  }

  clearCache() { this._prepared.clear(); }

  /** Is the option on? (global setting: local terminals have no host override) */
  async wanted() {
    if (process.platform !== 'linux') return false;
    if (typeof this.keepOverride === 'boolean') return this.keepOverride;
    try {
      const settings = await require('./store-service').getSettings();
      return settings?.terminal?.keepSessions !== false;
    } catch (_) { return false; }
  }

  async prepare() {
    if (process.platform !== 'linux') return { fallback: true, reason: 'not Linux' };
    const local = keeper.localBinaries();
    if (!local) return { fallback: true, reason: 'keeper binaries are missing from this build' };
    const home = os.homedir();
    const key = `${home}|${local.kv}`;
    let p = this._prepared.get(key);
    if (!p) {
      p = this._prepare(home);
      this._prepared.set(key, p);
      p.then((r) => { if (r.fallback) this._prepared.delete(key); }, () => this._prepared.delete(key));
    }
    return p;
  }

  async _prepare(home) {
    try {
      const arch = archFor(process.arch);
      if (!arch) throw new Fallback(`unsupported architecture ${process.arch}`);
      let bin;
      try { bin = keeper.localBinary(arch); } catch (err) { throw new Fallback(err.message); }
      if (!bin) throw new Fallback(`no keeper binary for ${arch} in this build`);
      if (!home || !home.startsWith('/')) throw new Fallback('no usable home directory');
      const uid = process.getuid();
      for (const rel of ['.termilab', '.termilab/bin', '.termilab/run']) checkDir(path.join(home, rel), `~/${rel}`, uid);
      const target = path.join(home, '.termilab', 'bin', bin.file);
      let installed = false;
      if (!installedOk(target, bin)) { install(target, bin); installed = true; }
      else if ((fs.statSync(target).mode & 0o777) !== 0o700) fs.chmodSync(target, 0o700);
      const ver = await run(target, ['version']);
      if (ver.code === 126) throw new Fallback('the home directory does not allow running programs (noexec)');
      if (ver.code !== 0) throw new Fallback(`the keeper did not run (exit ${ver.code})`);
      let info = null;
      try { info = JSON.parse(ver.stdout.trim().split('\n')[0]); } catch (_) { info = null; }
      if (!info || info.keeperVersion !== bin.kv) throw new Fallback('the installed keeper reports another version');
      /* Who creates sessions: the user manager when it answers, else the attach itself */
      let systemdRun = null;
      if (!this.forceDirect && process.env.TERMILAB_DIRECT_PTY !== '1') {
        const sr = ptyEscape.findInPath('systemd-run');
        if (sr && (process.env.DBUS_SESSION_BUS_ADDRESS || process.env.XDG_RUNTIME_DIR) && await ptyEscape.probeManager(process.env)) systemdRun = sr;
      }
      return { bin: target, kv: bin.kv, arch, home, installed, systemdRun };
    } catch (err) {
      return { fallback: true, reason: err instanceof Fallback ? err.reason : (err.message || String(err)) };
    }
  }

  /** The installed keeper, without installing anything (Background sessions) → path or null */
  locate() {
    const local = keeper.localBinaries();
    const arch = archFor(process.arch);
    if (process.platform !== 'linux' || !local || !arch || !local.binaries[arch]) return null;
    const target = path.join(os.homedir(), '.termilab', 'bin', local.binaries[arch].file);
    try { fs.accessSync(target, fs.constants.X_OK); return target; } catch (_) { return null; }
  }

  async list(bin) {
    const r = await run(bin, ['list'], { timeout: 2000 });
    if (r.code !== 0) throw new Error(`keeper list failed (exit ${r.code})`);
    return keeper.parseList(r.stdout);
  }

  async kill(bin, id) {
    if (!keeper.ID_RE.test(String(id))) throw new Error('bad keeper id');
    const r = await run(bin, ['kill', id], { timeout: 6000 });
    if (r.code !== 0 && r.code !== 102) throw new Error(`could not end the session (exit ${r.code}${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''})`);
    return true;
  }

  /** {fgCommand, isShell, shellPid} of session id, or null */
  async foreground(bin, id) {
    const row = (await this.list(bin)).find(x => x.id === id);
    if (!row) return null;
    const fg = typeof row.fgCommand === 'string' ? row.fgCommand : '';
    const shellPid = Number.isInteger(row.shellPid) && row.shellPid > 1 ? row.shellPid : null;
    return { fgCommand: fg || null, isShell: keeper.isShellCommand(fg), shellPid };
  }

  /** Names of pid's children (a shell's `cmd &` jobs), from /proc */
  children(pid) {
    if (!Number.isInteger(pid) || pid <= 1) return [];
    let kids = '';
    try { kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf-8'); } catch (_) { return null; }
    const out = [];
    for (const c of kids.split(/\s+/).filter(Boolean)) {
      try { out.push(fs.readFileSync(`/proc/${c}/comm`, 'utf-8').trim()); } catch (_) { /* gone */ }
    }
    return out;
  }

  /**
   * Get session `sessionKey` ready for a tab: → what node-pty runs, or a fallback.
   * opts: { sessionKey, cols, rows, cwd, shell, env } (env = what the shell gets)
   */
  async open({ sessionKey, cols, rows, cwd, shell, env = {} }) {
    const sess = sessionFor(sessionKey);
    if (!sess) return { fallback: true, reason: 'no session key' };
    const prep = await this.prepare();
    if (prep.fallback) return prep;
    let rowsList = [];
    try { rowsList = await this.list(prep.bin); } catch (_) { rowsList = []; }
    const exists = rowsList.some(r => r.id === sess.id);
    let create = false;
    let unit = null;
    if (!exists && !sess.adopted) {
      if (rowsList.length >= CAP) return { fallback: true, reason: `too many background sessions on this computer (${CAP}): end some in Hosts → Background` };
      if (prep.systemdRun) {
        unit = keepUnitName(sess.id);
        const setenv = ptyEscape.filterEnv(process.env, { ...env, SHELL: shell });
        const made = await this._createInUnit(prep, sess.id, cols, rows, setenv, cwd);
        if (!made.ok) return { fallback: true, reason: made.reason };
      } else {
        create = true;
      }
    }
    return { bin: prep.bin, id: sess.id, adopted: sess.adopted, unit, args: attachArgs(sess.id, cols, rows, create) };
  }

  async _createInUnit(prep, id, cols, rows, setenv, cwd) {
    const args = buildCreateArgs({ bin: prep.bin, id, cols, rows, setenv });
    let r = await run(prep.systemdRun, args, { timeout: CREATE_TIMEOUT_MS, cwd });
    if (r.code !== 0 && /already (loaded|exists)|fragment/i.test(r.stderr)) {
      /* A unit of that name left over (session gone, unit not collected yet) */
      await run('systemctl', ['--user', 'stop', `${keepUnitName(id)}.service`], { timeout: 5000 });
      await run('systemctl', ['--user', 'reset-failed', `${keepUnitName(id)}.service`], { timeout: 5000 });
      r = await run(prep.systemdRun, args, { timeout: CREATE_TIMEOUT_MS, cwd });
    }
    if (r.code === 0) return { ok: true };
    /* Another tab may have created it in between: fine if it is there now */
    try { if ((await this.list(prep.bin)).some(x => x.id === id)) return { ok: true }; } catch (_) { /* no */ }
    const why = r.stderr.trim().split('\n').pop() || `exit ${r.code}`;
    return { ok: false, reason: `the session could not be started (${why.slice(0, 200)})` };
  }
}

const service = new LocalKeeper();
module.exports = service;
module.exports.LocalKeeper = LocalKeeper;
module.exports.UNIT_PREFIX = UNIT_PREFIX;
module.exports.archFor = archFor;
module.exports.keepUnitName = keepUnitName;
module.exports.sessionFor = sessionFor;
module.exports.attachArgs = attachArgs;
module.exports.buildCreateArgs = buildCreateArgs;
