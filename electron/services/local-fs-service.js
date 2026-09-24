const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

/**
 * This computer's filesystem, for the SFTP screen's "Local" pane.
 *
 * Every path that crosses IPC is checked here: a string, absolute, no NUL
 * byte, normalised with path.resolve. Anything that CREATES a name (mkdir,
 * new file, rename, copy target) takes a directory plus a single name, and the
 * name must be one path segment: no separator, not "." or "..". That is what
 * stops a name typed by the user, or one that arrived from a remote listing,
 * from escaping the directory it was meant for.
 *
 * No shell is ever involved (no exec, no interpolation). Delete moves to the
 * OS trash with shell.trashItem instead of unlinking.
 */

const IS_WIN = process.platform === 'win32';

function badPath(msg) {
  const err = new Error(msg);
  err.code = 'EINVALIDPATH';
  return err;
}

/** An absolute, normalised local path, or a throw. */
function checkPath(p) {
  if (typeof p !== 'string' || !p) throw badPath('A path is required.');
  if (p.includes('\0')) throw badPath('The path contains a NUL byte.');
  if (!path.isAbsolute(p)) throw badPath(`Not an absolute path: ${p}`);
  return path.resolve(p);
}

/**
 * One path segment. Shared rule with the transfer engine, which applies it to
 * every name a remote server lists (a hostile server can send "../x").
 */
function checkName(name) {
  if (typeof name !== 'string' || !name) throw badPath('A name is required.');
  if (name === '.' || name === '..') throw badPath(`"${name}" is not a valid name.`);
  if (name.includes('\0')) throw badPath('The name contains a NUL byte.');
  if (name.includes('/') || (IS_WIN && name.includes('\\'))) {
    throw badPath(`"${name}" contains a path separator.`);
  }
  if (Buffer.byteLength(name, 'utf-8') > 255) throw badPath('The name is too long.');
  return name;
}

function childPath(dir, name) {
  const d = checkPath(dir);
  const full = path.join(d, checkName(name));
  // Belt and braces: after join, the result must still be directly inside d.
  if (path.dirname(full) !== d) throw badPath(`"${name}" escapes ${d}`);
  return full;
}

function formatPermissions(mode) {
  if (mode === undefined || mode === null) return '---------';
  const bits = 'rwxrwxrwx';
  let out = '';
  for (let i = 0; i < 9; i++) out += (mode & (0o400 >> i)) ? bits[i] : '-';
  return out;
}

function typeOf(st) {
  if (st.isDirectory()) return 'directory';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFile()) return 'file';
  return 'other';
}

async function describe(full, name) {
  const st = await fsp.lstat(full);
  const entry = {
    name,
    path: full,
    type: typeOf(st),
    size: st.isFile() ? st.size : (st.isDirectory() ? null : st.size),
    modifyTime: st.mtimeMs,
    mode: st.mode,
    permissions: formatPermissions(st.mode),
    isHidden: name.startsWith('.'),
  };
  if (entry.type === 'symlink') {
    try {
      const target = await fsp.stat(full);
      entry.linkType = target.isDirectory() ? 'directory' : 'file';
      if (target.isFile()) entry.size = target.size;
    } catch (_) {
      entry.linkType = 'broken';
    }
  }
  return entry;
}

class LocalFsService {
  constructor() {
    /** Injected so the harness can use a fake trash (electron.shell otherwise). */
    this._shell = null;
  }

  _getShell() {
    if (this._shell) return this._shell;
    return require('electron').shell;
  }

  home() {
    return os.homedir();
  }

  async list(dir) {
    const d = checkPath(dir);
    let names;
    try {
      names = await fsp.readdir(d);
    } catch (err) {
      throw this._readable(err, d);
    }
    const out = [];
    // lstat in small batches: a folder with 20k entries must not open 20k fds.
    for (let i = 0; i < names.length; i += 64) {
      const batch = names.slice(i, i + 64);
      const described = await Promise.all(batch.map(async (name) => {
        try {
          return await describe(path.join(d, name), name);
        } catch (_) {
          return null; // vanished between readdir and lstat
        }
      }));
      for (const e of described) if (e) out.push(e);
    }
    return out;
  }

  /** The entry, or null when nothing is there. */
  async stat(p) {
    const full = checkPath(p);
    try {
      return await describe(full, path.basename(full));
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      throw this._readable(err, full);
    }
  }

  async mkdir(dir, name) {
    const full = childPath(dir, name);
    try {
      await fsp.mkdir(full);
    } catch (err) {
      throw this._readable(err, full);
    }
    return { path: full };
  }

  async createFile(dir, name) {
    const full = childPath(dir, name);
    try {
      await fsp.writeFile(full, '', { flag: 'wx' });
    } catch (err) {
      throw this._readable(err, full);
    }
    return { path: full };
  }

  /** Same directory, new name. Refuses to replace something that is there. */
  async rename(p, newName) {
    const full = checkPath(p);
    const target = childPath(path.dirname(full), newName);
    if (target === full) return { path: full };
    // fs.rename replaces silently; a rename in a file manager must not.
    // (A case-only rename on a case-insensitive disk lstat's as "exists".)
    let there = null;
    try { there = await fsp.lstat(target); } catch (_) { /* free */ }
    if (there) {
      const self = await fsp.lstat(full);
      if (there.ino !== self.ino || there.dev !== self.dev) {
        throw new Error(`"${newName}" already exists here.`);
      }
    }
    try {
      await fsp.rename(full, target);
    } catch (err) {
      throw this._readable(err, full);
    }
    return { path: target };
  }

  /** Moves to the OS trash. Never unlinks. */
  async trash(p) {
    const full = checkPath(p);
    if (path.parse(full).root === full) throw new Error('Refusing to delete the root of the filesystem.');
    if (full === path.resolve(os.homedir())) throw new Error('Refusing to delete your home folder.');
    try {
      await fsp.lstat(full);
    } catch (err) {
      throw this._readable(err, full);
    }
    await this._getShell().trashItem(full);
    return { path: full };
  }

  /** Copy a file or folder into dstDir under `name` (default: same name). Never overwrites. */
  async copy(src, dstDir, name) {
    const from = checkPath(src);
    const to = childPath(dstDir, name === undefined ? path.basename(from) : name);
    if (to === from || to.startsWith(from + path.sep)) {
      throw new Error('Cannot copy a folder into itself.');
    }
    try {
      await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    } catch (err) {
      if (err.code === 'ERR_FS_CP_EEXIST' || err.code === 'EEXIST') throw new Error(`"${path.basename(to)}" already exists in ${dstDir}.`);
      throw this._readable(err, from);
    }
    return { path: to };
  }

  async chmod(p, mode) {
    const full = checkPath(p);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('Invalid permissions.');
    try {
      await fsp.chmod(full, mode);
    } catch (err) {
      throw this._readable(err, full);
    }
    return { path: full, mode };
  }

  /** Opens with the OS default app. Resolves '' on success (shell.openPath's contract). */
  async open(p) {
    const full = checkPath(p);
    const error = await this._getShell().openPath(full);
    if (error) throw new Error(error);
    return true;
  }

  _readable(err, p) {
    const map = {
      ENOENT: 'No such file or folder',
      EACCES: 'Permission denied',
      EPERM: 'Operation not permitted',
      EEXIST: 'Already exists',
      ENOTDIR: 'Not a folder',
      EISDIR: 'Is a folder',
      ENOTEMPTY: 'Folder is not empty',
      EBUSY: 'In use',
    };
    const msg = map[err && err.code];
    if (!msg) return err;
    const out = new Error(`${msg}: ${p}`);
    out.code = err.code;
    return out;
  }
}

const instance = new LocalFsService();
module.exports = instance;
module.exports.checkPath = checkPath;
module.exports.checkName = checkName;
module.exports.formatPermissions = formatPermissions;
