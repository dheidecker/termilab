const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const sftpService = require('./sftp-service');
const sftpEditService = require('./sftp-edit-service');

const { openRefusal } = sftpEditService;
const { checkRemotePath } = sftpService;

/**
 * A path printed in a terminal, Ctrl+clicked (src/components/Terminal/
 * pathLinkProvider.js finds it, pathLinks.js decides what is a path).
 *
 * WHERE a relative path is relative to, in this order:
 *  1. The directory the shell reported with OSC 7 (the renderer passes it;
 *     for a local tab only if its host is this computer: an `ssh` typed in a
 *     local terminal reports the server's directories).
 *  2. Local: the cwd of the terminal's FOREGROUND process (tpgid of the
 *     shell in /proc/<shell>/stat → /proc/<tpgid>/cwd, falling back to the
 *     shell's own). The shell pid is node-pty's, or the keeper's `shellPid`
 *     for a kept session, or the systemd unit's MainPID when the shell was
 *     escaped from no_new_privs (node-pty's pid is then systemd-run's).
 *     macOS: ps + lsof. Windows: none.
 *  3. SSH with the session keeper (it knows the shell pid): ONE exec,
 *     bounded, reading the same /proc links on the server.
 *  4. Home (local os.homedir(), remote the SFTP server's start directory).
 *
 * OPENING never runs anything:
 *  - local: stat (following links) and realpath first. A directory opens in
 *    the file manager, unless the OS would LAUNCH it (a macOS .app bundle):
 *    then its parent is shown. A file the OS would run instead of showing
 *    (exec bit, or a type on sftp-edit-service's list for this platform,
 *    e.g. .desktop, .AppImage; .js/.py/.bat on Windows) is shown in its folder
 *    (or opened in VS Code when that is the editor: it never executes).
 *    Not a regular file (fifo, device, socket): refused.
 *  - remote: through sftp-edit-service (temp copy 0600, its refusal list,
 *    watch + upload on save), owned by the terminal tab; a directory is
 *    returned as {status:'dir'} and the renderer opens SFTP there.
 *  - a :line with VS Code as the editor (`code` on PATH and, where xdg-mime
 *    can say, the default app for that file) → `code --goto file:line:col`.
 *  - missing → {status:'missing', path} (the renderer shows a toast).
 */

const MAX_PATH = 4096;
const CWD_EXEC_TIMEOUT_MS = 3000;
/* What macOS launches when "opened": bundles are directories */
const MAC_BUNDLE_RE = /\.(app|bundle|framework|plugin|kext|prefPane|saver|workflow|action|qlgenerator|mdimporter|xpc)$/i;

function cleanSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Invalid path request.');
  const p = spec.path;
  if (typeof p !== 'string' || !p || p.length > MAX_PATH || p.includes('\0')) throw new Error('Invalid path.');
  const int = (v) => (Number.isInteger(v) && v > 0 && v < 1e7 ? v : null);
  const osc = spec.osc && typeof spec.osc === 'object' && typeof spec.osc.path === 'string'
    && spec.osc.path.startsWith('/') && spec.osc.path.length <= MAX_PATH && !spec.osc.path.includes('\0')
    ? { host: typeof spec.osc.host === 'string' ? spec.osc.host : '', path: spec.osc.path } : null;
  return { kind: spec.kind === 'ssh' ? 'ssh' : 'local', sessionId: typeof spec.sessionId === 'string' ? spec.sessionId : null,
    path: p, line: int(spec.line), col: int(spec.col), osc, owner: typeof spec.owner === 'string' ? spec.owner : null };
}

/** Strip Electron's own variables before starting another program */
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(ELECTRON_|CHROME_|GOOGLE_API|NODE_OPTIONS$|LD_PRELOAD$|LD_LIBRARY_PATH$)/.test(k)) delete env[k];
  }
  return env;
}

class OpenPathService {
  constructor() {
    this._shell = null;          // the harness injects a fake
    this._spawn = null;          // (cmd, args) → void; the harness records
    this._exec = null;           // (cmd, args, opts) → Promise<string>; the harness fakes xdg-mime/systemctl
    this._which = null;          // (name) → path|null; the harness hides the real `code`
    this.platform = process.platform;
    this.homeDir = null;         // the harness points it at a temp folder
    this.localShell = null;      // local-shell-service, lazily (it needs node-pty)
    this.ssh = null;             // ssh-service, lazily
  }

  _getShell() { return this._shell || require('electron').shell; }
  _home() { return this.homeDir || os.homedir(); }
  _localShell() { return this.localShell || require('./local-shell-service'); }
  _sshService() { return this.ssh || require('./ssh-service'); }

  _run(cmd, args, timeout = CWD_EXEC_TIMEOUT_MS) {
    if (this._exec) return this._exec(cmd, args, { timeout });
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout, maxBuffer: 64 * 1024, env: childEnv() }, (err, stdout) => {
        if (err) reject(err); else resolve(String(stdout));
      });
    });
  }

  /* ─── Where relative paths start ─── */

  /** Shell pid behind a local tab's pty (see the class comment), or null */
  async _localShellPid(sessionId) {
    const ls = this._localShell();
    const ent = ls.ents && ls.ents.get(sessionId);
    const proc = ls.shells && ls.shells.get(sessionId);
    if (!proc) return null;
    if (ent && ent.kept) {
      try {
        const fg = await require('./local-keeper').foreground(ent.kept.bin, ent.kept.id);
        return fg && fg.shellPid ? fg.shellPid : null;
      } catch (_) { return null; }
    }
    const unit = ls.units && ls.units.get(sessionId);
    if (unit) {
      try {
        const out = await this._run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', `${unit}.service`]);
        const pid = parseInt(out.trim(), 10);
        return pid > 1 ? pid : null;
      } catch (_) { return null; }
    }
    return Number.isInteger(proc.pid) && proc.pid > 1 ? proc.pid : null;
  }

  /** cwd of the foreground process on the terminal of `pid` (Linux /proc, macOS ps+lsof) */
  async _cwdOfPid(pid) {
    if (!pid) return null;
    if (this.platform === 'linux') {
      const candidates = [];
      try {
        const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf-8');
        // after "(comm) ": state ppid pgrp session tty_nr tpgid …
        const tpgid = parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[5], 10);
        if (tpgid > 1) candidates.push(tpgid);
      } catch (_) { /* gone */ }
      candidates.push(pid);
      for (const p of candidates) {
        try { return await fsp.readlink(`/proc/${p}/cwd`); } catch (_) { /* not ours, or gone */ }
      }
      return null;
    }
    if (this.platform === 'darwin') {
      const candidates = [];
      try {
        const tp = parseInt((await this._run('ps', ['-o', 'tpgid=', '-p', String(pid)])).trim(), 10);
        if (tp > 1) candidates.push(tp);
      } catch (_) { /* ignore */ }
      candidates.push(pid);
      for (const p of candidates) {
        try {
          const out = await this._run('lsof', ['-a', '-p', String(p), '-d', 'cwd', '-Fn']);
          const line = out.split('\n').find(l => l.startsWith('n/'));
          if (line) return line.slice(1);
        } catch (_) { /* ignore */ }
      }
    }
    return null;
  }

  async localCwd(spec) {
    if (spec.osc && this._oscIsLocal(spec.osc.host)) return spec.osc.path;
    if (!spec.sessionId) return null;
    return this._cwdOfPid(await this._localShellPid(spec.sessionId));
  }

  _oscIsLocal(host) {
    if (!host) return true;
    const h = host.toLowerCase();
    const me = os.hostname().toLowerCase();
    return h === 'localhost' || h === me || h === me.split('.')[0] || me === h.split('.')[0];
  }

  /** The server's cwd of the terminal: OSC 7, else one bounded exec when the keeper knows the shell pid */
  async remoteCwd(spec) {
    if (spec.osc) return spec.osc.path;
    const s = this._sshService().sessions.get(spec.sessionId);
    if (!s || !s.keeper || !s.client || s.reconnecting) return null;
    try {
      const keeperService = require('./keeper-service');
      const fg = await keeperService.foreground(s.client, s.keeper.bin, s.keeper.session.id);
      const pid = fg && fg.shellPid;
      if (!Number.isInteger(pid) || pid <= 1) return null;
      const cmd = `t=$(sed 's/.*) //' /proc/${pid}/stat 2>/dev/null | cut -d' ' -f6); `
        + `{ [ -n "$t" ] && readlink /proc/$t/cwd; } 2>/dev/null || readlink /proc/${pid}/cwd`;
      const r = await keeperService.run(s.client, cmd, { timeout: CWD_EXEC_TIMEOUT_MS, maxOut: 8192 });
      const out = r.stdout.toString('utf-8').split('\n')[0].trim();
      return out.startsWith('/') ? out : null;
    } catch (_) {
      return null;
    }
  }

  /* ─── Resolution ─── */

  resolveLocal(raw, cwd) {
    const home = this._home();
    if (raw === '~') return home;
    if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
    if (path.isAbsolute(raw)) return path.normalize(raw);
    return path.resolve(cwd || home, raw);
  }

  async _remoteHome(sessionId) {
    try { return checkRemotePath(await sftpService.realpath(sessionId, '.')); } catch (_) { return '/'; }
  }

  async resolveRemote(sessionId, raw, cwd) {
    if (raw.startsWith('/')) return path.posix.normalize(raw);
    if (raw === '~' || raw.startsWith('~/')) return path.posix.join(await this._remoteHome(sessionId), raw.slice(2));
    return path.posix.resolve(cwd || await this._remoteHome(sessionId), raw);
  }

  /** {path, exists, isDir, dir} — for "Copy path" and "Open folder in SFTP" */
  async resolve(rawSpec) {
    const spec = cleanSpec(rawSpec);
    if (spec.kind === 'ssh') {
      const abs = await this.resolveRemote(spec.sessionId, spec.path, await this.remoteCwd(spec));
      let st = null;
      try {
        const real = checkRemotePath(await sftpService.realpath(spec.sessionId, abs));
        st = await sftpService.stat(spec.sessionId, real);
      } catch (_) { st = null; }
      const isDir = !!st && st.type === 'directory';
      return { path: abs, exists: !!st, isDir, dir: isDir ? abs : path.posix.dirname(abs) };
    }
    const abs = this.resolveLocal(spec.path, await this.localCwd(spec));
    let st = null;
    try { st = await fsp.stat(abs); } catch (_) { st = null; }
    const isDir = !!st && st.isDirectory();
    return { path: abs, exists: !!st, isDir, dir: isDir ? abs : path.dirname(abs) };
  }

  /* ─── VS Code ─── */

  /** Absolute path of `code` on PATH, or null */
  _findOnPath(name) {
    if (this._which) return this._which(name);
    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const exts = this.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
    for (const d of dirs) {
      for (const e of exts) {
        const full = path.join(d, name + e);
        try { fs.accessSync(full, fs.constants.X_OK); if (fs.statSync(full).isFile()) return full; } catch (_) { /* next */ }
      }
    }
    return null;
  }

  /** `code` when VS Code is the editor for this file, else null */
  async _vscodeFor(file) {
    const code = this._findOnPath('code');
    if (!code) return null;
    if (this.platform !== 'linux') return code;
    try {
      const mime = (await this._run('xdg-mime', ['query', 'filetype', file])).trim();
      if (!mime) return code;
      const app = (await this._run('xdg-mime', ['query', 'default', mime])).trim();
      /* No default for that type: code is as good a guess as any */
      if (!app) return code;
      return /(^|[-.])code(-url-handler|-insiders)?\.desktop$|visual-studio-code|vscode/i.test(app) ? code : null;
    } catch (_) {
      return code;   // no xdg-mime: `code` on PATH is the signal
    }
  }

  _launchDetached(cmd, args) {
    if (this._spawn) return this._spawn(cmd, args);
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: childEnv(), shell: this.platform === 'win32' && /\.cmd$/i.test(cmd) });
    child.on('error', () => {});
    child.unref();
    return undefined;
  }

  /** Opener for a file at a :line: VS Code --goto, else the default app */
  async _openFile(file, line, col) {
    if (line) {
      const code = await this._vscodeFor(file);
      if (code) {
        this._launchDetached(code, ['--goto', `${file}:${line}${col ? `:${col}` : ''}`]);
        return 'code';
      }
    }
    const error = await this._getShell().openPath(file);
    if (error) throw new Error(error);
    return 'default';
  }

  /* ─── Open ─── */

  async open(rawSpec) {
    const spec = cleanSpec(rawSpec);
    return spec.kind === 'ssh' ? this._openRemote(spec) : this._openLocal(spec);
  }

  async _openLocal(spec) {
    const abs = this.resolveLocal(spec.path, await this.localCwd(spec));
    let st;
    try { st = await fsp.stat(abs); } catch (_) { return { status: 'missing', path: abs }; }
    const real = await fsp.realpath(abs).catch(() => abs);
    const shell = this._getShell();
    if (st.isDirectory()) {
      if (openRefusal(path.basename(real), 'edit', this.platform) || (this.platform === 'darwin' && MAC_BUNDLE_RE.test(real))) {
        shell.showItemInFolder(real);
        return { status: 'revealed', path: real };
      }
      const error = await shell.openPath(real);
      if (error) throw new Error(error);
      return { status: 'folder', path: real };
    }
    if (!st.isFile()) throw new Error(`Not a regular file: ${abs}`);
    const runs = openRefusal(path.basename(abs), 'edit', this.platform)
      || openRefusal(path.basename(real), 'edit', this.platform)
      || (this.platform !== 'win32' && (st.mode & 0o111) !== 0);
    if (runs) {
      /* Never handed to the OS opener: it could run it. VS Code only edits. */
      const code = await this._vscodeFor(real);
      if (code) {
        this._launchDetached(code, ['--goto', `${real}:${spec.line || 1}${spec.col ? `:${spec.col}` : ''}`]);
        return { status: 'opened', path: real, editor: 'code' };
      }
      shell.showItemInFolder(real);
      return { status: 'revealed', path: real };
    }
    const editor = await this._openFile(real, spec.line, spec.col);
    return { status: 'opened', path: real, editor };
  }

  async _openRemote(spec) {
    if (!spec.sessionId) throw new Error('No session.');
    const abs = await this.resolveRemote(spec.sessionId, spec.path, await this.remoteCwd(spec));
    let st = null;
    try {
      const real = checkRemotePath(await sftpService.realpath(spec.sessionId, abs));
      st = await sftpService.stat(spec.sessionId, real);
    } catch (_) { st = null; }
    if (!st) return { status: 'missing', path: abs };
    if (st.type === 'directory') return { status: 'dir', path: abs };
    if (st.type !== 'file') throw new Error(`Not a regular file: ${abs}`);
    const r = await sftpEditService.start(spec.sessionId, abs, spec.owner, {
      opener: (local) => this._openFile(local, spec.line, spec.col).then(() => '', (e) => e.message || 'Could not open'),
    });
    return { status: 'editing', path: abs, editId: r.editId, name: r.name };
  }
}

module.exports = new OpenPathService();
module.exports.OpenPathService = OpenPathService;
module.exports.cleanSpec = cleanSpec;
