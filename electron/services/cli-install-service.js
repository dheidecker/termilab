/* termilab-cli / termilab-mcp on the user's PATH, macOS only.

   The .app carries two launcher scripts in Contents/Resources/bin (they
   resolve their own symlinks and run the CLI / MCP in node mode). This service
   links them into ~/.local/bin, without sudo and without editing any shell rc:
   if ~/.local/bin is not on the user's login PATH it only reports the line to
   add. Symlinks, not copies, so an update that replaces the app in place keeps
   them working.

   Linux packages already install /usr/bin/termilab-{cli,mcp}; Windows has no
   equivalent yet. On both, status() says supported:false and install /
   uninstall throw without touching the disk.

   Ownership rule: we only ever replace or delete a SYMLINK whose target is
   another Termilab bundle's launcher (".../X.app/Contents/Resources/bin/<same
   name>"). A regular file, a directory or a link to anything else in
   ~/.local/bin belongs to someone else: install refuses, uninstall skips it. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const NAMES = ['termilab-cli', 'termilab-mcp'];
const LOGIN_PATH_TIMEOUT_MS = 3000;
const MARK_START = '__TERMILAB_PATH_START__';
const MARK_END = '__TERMILAB_PATH_END__';

function electronApp() {
  try { return require('electron').app || null; } catch { return null; }
}

/** The user's login shell: $SHELL, else the account's (Finder may not set SHELL), else zsh. */
function userShell(env) {
  if (env.SHELL) return env.SHELL;
  try { const s = os.userInfo().shell; if (s) return s; } catch { /* no passwd entry */ }
  return '/bin/zsh';
}

/**
 * PATH as a login shell of the user sees it. The Electron process launched
 * from the Finder inherits launchd's minimal PATH, so process.env.PATH says
 * nothing about the user's terminal. Markers because a profile may print to
 * stdout. Resolves null on any failure (timeout, no shell, bad output).
 */
function readLoginPath({ shell, home, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(shell, ['-lc', `printf '%s%s%s' '${MARK_START}' "$PATH" '${MARK_END}'`], {
        timeout: LOGIN_PATH_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        env: { ...env, HOME: home },
        cwd: home,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }, (err, stdout) => {
        if (err) return resolve(null);
        const s = String(stdout);
        const a = s.lastIndexOf(MARK_START);
        const b = s.lastIndexOf(MARK_END);
        if (a < 0 || b < a) return resolve(null);
        resolve(s.slice(a + MARK_START.length, b));
      });
    } catch {
      return resolve(null);
    }
    child.stdin && child.stdin.end();
  });
}

/** Where the PATH line would go, and the line itself, for the user's shell. */
function shellAdvice(shell, home, binDir) {
  const base = path.basename(shell || '');
  const rel = binDir.startsWith(home + path.sep) ? binDir.slice(home.length + 1) : null;
  if (base === 'fish') {
    return {
      pathLine: `fish_add_path ${rel ? '$HOME/' + rel : JSON.stringify(binDir)}`,
      shellRc: path.join(home, '.config', 'fish', 'config.fish'),
    };
  }
  const dir = rel ? `$HOME/${rel}` : binDir;
  const rc = base === 'zsh' ? '.zprofile' : base === 'bash' ? '.bash_profile' : '.profile';
  return { pathLine: `export PATH="${dir}:$PATH"`, shellRc: path.join(home, rc) };
}

function samePath(a, b) {
  const norm = p => path.resolve(p).replace(/\/+$/, '');
  if (norm(a) === norm(b)) return true;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

/** Is `target` (absolute) the launcher `name` inside SOME Termilab-style bundle? */
function isTermilabLauncher(target, name) {
  const parts = path.resolve(target).split(path.sep);
  const n = parts.length;
  return n >= 5
    && parts[n - 1] === name
    && parts[n - 2] === 'bin'
    && parts[n - 3] === 'Resources'
    && parts[n - 4] === 'Contents'
    && /\.app$/i.test(parts[n - 5]);
}

class CliInstallService {
  /**
   * Everything environment-dependent can be injected (the harness does):
   * platform, home, resourcesPath, isPackaged, env, loginPath() -> string|null.
   * Defaults are read lazily, at call time.
   */
  constructor(opts = {}) {
    this.opts = opts;
  }

  _ctx() {
    const o = this.opts;
    const app = electronApp();
    const env = o.env || process.env;
    const home = o.home || os.homedir();
    return {
      platform: o.platform || process.platform,
      home,
      env,
      resourcesPath: o.resourcesPath !== undefined ? o.resourcesPath : process.resourcesPath,
      isPackaged: o.isPackaged !== undefined ? o.isPackaged : !!(app && app.isPackaged),
      shell: o.shell || userShell(env),
      binDir: path.join(home, '.local', 'bin'),
    };
  }

  /** null when supported, else the reason string of the contract. */
  _unsupportedReason(c) {
    if (c.platform === 'win32') return 'windows';
    if (c.platform !== 'darwin') return 'linux-packaged';
    if (!c.isPackaged || !c.resourcesPath) return 'dev-build';
    for (const name of NAMES) {
      try {
        if (!fs.statSync(path.join(c.resourcesPath, 'bin', name)).isFile()) return 'scripts-missing';
      } catch { return 'scripts-missing'; }
    }
    return null;
  }

  /** {name, linkPath, ours (path we would link to), kind, target}
      kind: 'missing' | 'ours' | 'stale' (link to another Termilab) | 'foreign' */
  _inspect(c, name) {
    const linkPath = path.join(c.binDir, name);
    const ours = path.join(c.resourcesPath, 'bin', name);
    let st;
    try { st = fs.lstatSync(linkPath); } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { name, linkPath, ours, kind: 'missing', target: null };
      throw err;
    }
    if (!st.isSymbolicLink()) return { name, linkPath, ours, kind: 'foreign', target: null };
    const raw = fs.readlinkSync(linkPath);
    const target = path.resolve(path.dirname(linkPath), raw);
    if (samePath(target, ours)) return { name, linkPath, ours, kind: 'ours', target };
    if (isTermilabLauncher(target, name)) return { name, linkPath, ours, kind: 'stale', target };
    return { name, linkPath, ours, kind: 'foreign', target };
  }

  async status() {
    const c = this._ctx();
    const reason = this._unsupportedReason(c);
    if (reason) {
      // Unsupported: no disk reads, no shell spawned.
      return {
        supported: false, reason, binDir: c.binDir,
        installed: false, stale: false, onPath: false, pathLine: null, shellRc: null,
        entries: NAMES.map(name => ({ name, linkPath: path.join(c.binDir, name), target: null })),
      };
    }
    const found = NAMES.map(name => this._inspect(c, name));
    const loginPath = this.opts.loginPath
      ? await this.opts.loginPath()
      : await readLoginPath({ shell: c.shell, home: c.home, env: c.env });
    const onPath = typeof loginPath === 'string'
      && loginPath.split(':').some(p => p && samePath(p.replace(/^~(?=\/|$)/, c.home), c.binDir));
    const advice = shellAdvice(c.shell, c.home, c.binDir);
    return {
      supported: true,
      reason: null,
      binDir: c.binDir,
      installed: found.every(f => f.kind === 'ours'),
      stale: found.some(f => f.kind === 'stale'),
      onPath,
      pathLine: onPath ? null : advice.pathLine,
      shellRc: onPath ? null : advice.shellRc,
      entries: found.map(f => ({ name: f.name, linkPath: f.linkPath, target: f.target })),
    };
  }

  _requireSupported(c) {
    const reason = this._unsupportedReason(c);
    if (!reason) return;
    const why = {
      'linux-packaged': 'On Linux the deb/pacman package already installs termilab-cli and termilab-mcp in /usr/bin.',
      windows: 'Installing the command line tools is not available on Windows yet.',
      'dev-build': 'This is a development build: the launcher scripts only exist in the packaged app.',
      'scripts-missing': 'The launcher scripts are missing from this Termilab.app (Contents/Resources/bin).',
    }[reason];
    const err = new Error(why);
    err.code = reason;
    throw err;
  }

  async install() {
    const c = this._ctx();
    this._requireSupported(c);
    // Decide for both before creating either: never leave half an install
    // because the second name belongs to someone else.
    const found = NAMES.map(name => this._inspect(c, name));
    const foreign = found.filter(f => f.kind === 'foreign');
    if (foreign.length) {
      throw new Error(`${foreign.map(f => f.linkPath).join(' and ')} already exist${foreign.length > 1 ? '' : 's'} and ${foreign.length > 1 ? 'are' : 'is'} not a Termilab link. Termilab will not overwrite ${foreign.length > 1 ? 'them' : 'it'}: rename or remove ${foreign.length > 1 ? 'them' : 'it'} and try again.`);
    }
    fs.mkdirSync(c.binDir, { recursive: true, mode: 0o755 });
    for (const f of found) {
      if (f.kind === 'ours') continue;
      // New link under a unique name, then rename over: replacing a stale link
      // is atomic and never leaves the name missing.
      const tmp = path.join(c.binDir, `.${f.name}.termilab-${process.pid}-${Date.now()}.tmp`);
      fs.symlinkSync(f.ours, tmp);
      try {
        // Re-check right before replacing: something may have appeared since.
        const now = this._inspect(c, f.name);
        if (now.kind === 'foreign') throw new Error(`${f.linkPath} appeared while installing and is not a Termilab link; left untouched.`);
        fs.renameSync(tmp, f.linkPath);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        throw err;
      }
    }
    return this.status();
  }

  async uninstall() {
    const c = this._ctx();
    this._requireSupported(c);
    for (const name of NAMES) {
      const f = this._inspect(c, name);
      // Only links into a Termilab bundle (this one or a stale copy). Never a
      // regular file, never someone else's link.
      if (f.kind === 'ours' || f.kind === 'stale') fs.unlinkSync(f.linkPath);
    }
    return this.status();
  }
}

const cliInstallService = new CliInstallService();
cliInstallService.CliInstallService = CliInstallService;
cliInstallService.NAMES = NAMES;
cliInstallService.isTermilabLauncher = isTermilabLauncher;
cliInstallService.readLoginPath = readLoginPath;
module.exports = cliInstallService;
