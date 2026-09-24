const path = require('path');
const sshService = require('./ssh-service');
const { formatPermissions } = require('./local-fs-service');

const posix = path.posix;

/**
 * SFTP over an SSH session that ssh-service already holds.
 *
 * The session can be a terminal's (the SFTP pane reuses it when one is open
 * for that host) or one opened just for SFTP (`ssh:connect` with
 * purpose:'sftp', which skips the shell). Either way the SFTP channel is
 * opened lazily here and cached per sessionId; several panes on the same
 * session share it (the protocol is request/response with ids).
 *
 * Remote paths are POSIX, absolute, NUL-free. Names that create something
 * are one segment. Names in a listing that are not a single safe segment are
 * dropped: an SFTP server decides what readdir returns, and "../x" from a
 * hostile one must never reach a local path.join (see transfer-service).
 */

const STATUS = { NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4 };

/** One POSIX path segment: what a remote listing may contain and a create may use. */
function isSafeRemoteName(name) {
  return typeof name === 'string' && !!name && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\0');
}

function checkRemotePath(p) {
  if (typeof p !== 'string' || !p) throw new Error('A remote path is required.');
  if (p.includes('\0')) throw new Error('The path contains a NUL byte.');
  if (!p.startsWith('/')) throw new Error(`Not an absolute remote path: ${p}`);
  const n = posix.normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

function checkRemoteName(name) {
  if (!isSafeRemoteName(name)) throw new Error(`"${name}" is not a valid name.`);
  return name;
}

function typeOfAttrs(attrs) {
  if (attrs.isDirectory()) return 'directory';
  if (attrs.isSymbolicLink()) return 'symlink';
  if (attrs.isFile()) return 'file';
  return 'other';
}

function readable(err, what) {
  if (!err) return err;
  let msg = err.message;
  if (err.code === STATUS.NO_SUCH_FILE) msg = 'No such file or folder';
  else if (err.code === STATUS.PERMISSION_DENIED) msg = 'Permission denied';
  const out = new Error(`${msg}: ${what}`);
  out.code = err.code;
  return out;
}

class SFTPService {
  constructor() {
    /** @type {Map<string, any>} sessionId -> ssh2 SFTP */
    this.sftpSessions = new Map();
    /** @type {Map<string, Promise>} sessionId -> channel being opened */
    this._opening = new Map();
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
      console.error(`[SFTPService] Failed to send to renderer on ${channel}:`, err.message);
    }
  }

  /** The SFTP channel for a session, opened once even under concurrent calls. */
  async getSFTP(sessionId) {
    if (this.sftpSessions.has(sessionId)) return this.sftpSessions.get(sessionId);
    if (this._opening.has(sessionId)) return this._opening.get(sessionId);

    const client = sshService.getClient(sessionId);
    if (!client) throw new Error('The SSH connection for this pane is closed. Reconnect to continue.');

    const p = new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(new Error(`Could not start SFTP on this server: ${err.message}`));
        const drop = () => {
          if (this.sftpSessions.get(sessionId) === sftp) this.sftpSessions.delete(sessionId);
        };
        sftp.on('end', drop);
        sftp.on('close', drop);
        sftp.on('error', (e) => {
          console.error(`[SFTPService] SFTP session error for ${sessionId}:`, e.message);
          drop();
        });
        this.sftpSessions.set(sessionId, sftp);
        resolve(sftp);
      });
    });
    this._opening.set(sessionId, p);
    try {
      return await p;
    } finally {
      this._opening.delete(sessionId);
    }
  }

  _call(sftp, method, ...args) {
    return new Promise((resolve, reject) => {
      sftp[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
    });
  }

  _entry(dir, name, attrs) {
    const full = dir === '/' ? `/${name}` : `${dir}/${name}`;
    const type = typeOfAttrs(attrs);
    return {
      name,
      path: full,
      type,
      size: type === 'directory' ? null : attrs.size,
      modifyTime: attrs.mtime * 1000,
      mode: attrs.mode,
      uid: attrs.uid,
      gid: attrs.gid,
      permissions: formatPermissions(attrs.mode),
      isHidden: name.startsWith('.'),
    };
  }

  async list(sessionId, remotePath) {
    const dir = checkRemotePath(remotePath);
    const sftp = await this.getSFTP(sessionId);
    let list;
    try {
      list = await this._call(sftp, 'readdir', dir);
    } catch (err) {
      throw readable(err, dir);
    }
    const entries = [];
    for (const item of list) {
      if (!isSafeRemoteName(item.filename)) continue;
      entries.push(this._entry(dir, item.filename, item.attrs));
    }
    // Symlinks: is it a folder we can enter? A few at a time.
    const links = entries.filter(e => e.type === 'symlink');
    for (let i = 0; i < links.length; i += 16) {
      await Promise.all(links.slice(i, i + 16).map(async (e) => {
        try {
          const st = await this._call(sftp, 'stat', e.path);
          e.linkType = st.isDirectory() ? 'directory' : 'file';
          if (!st.isDirectory()) e.size = st.size;
        } catch (_) {
          e.linkType = 'broken';
        }
      }));
    }
    return entries;
  }

  /** Absolute form of a path; realpath('.') is the login directory. */
  async realpath(sessionId, remotePath = '.') {
    if (typeof remotePath !== 'string' || remotePath.includes('\0')) throw new Error('Invalid path.');
    const sftp = await this.getSFTP(sessionId);
    try {
      return await this._call(sftp, 'realpath', remotePath || '.');
    } catch (err) {
      throw readable(err, remotePath);
    }
  }

  /** The entry (lstat), or null when nothing is there. */
  async stat(sessionId, remotePath) {
    const p = checkRemotePath(remotePath);
    const sftp = await this.getSFTP(sessionId);
    try {
      const attrs = await this._call(sftp, 'lstat', p);
      return this._entry(posix.dirname(p), posix.basename(p) || '/', attrs);
    } catch (err) {
      if (err.code === STATUS.NO_SUCH_FILE) return null;
      throw readable(err, p);
    }
  }

  async mkdir(sessionId, dir, name) {
    const p = posix.join(checkRemotePath(dir), checkRemoteName(name));
    const sftp = await this.getSFTP(sessionId);
    if (await this._exists(sftp, p)) throw new Error(`"${name}" already exists here.`);
    try {
      await this._call(sftp, 'mkdir', p);
    } catch (err) {
      throw readable(err, p);
    }
    return { path: p };
  }

  async createFile(sessionId, dir, name) {
    const p = posix.join(checkRemotePath(dir), checkRemoteName(name));
    const sftp = await this.getSFTP(sessionId);
    let handle;
    try {
      handle = await this._call(sftp, 'open', p, 'wx');
    } catch (err) {
      if (err.code === STATUS.FAILURE && await this._exists(sftp, p)) throw new Error(`"${name}" already exists here.`);
      throw readable(err, p);
    }
    await this._call(sftp, 'close', handle).catch(() => {});
    return { path: p };
  }

  /** Same directory, new name. Refuses to replace something that is there. */
  async rename(sessionId, remotePath, newName) {
    const from = checkRemotePath(remotePath);
    const to = posix.join(posix.dirname(from), checkRemoteName(newName));
    if (to === from) return { path: to };
    const sftp = await this.getSFTP(sessionId);
    if (await this._exists(sftp, to)) throw new Error(`"${newName}" already exists here.`);
    try {
      await this._call(sftp, 'rename', from, to);
    } catch (err) {
      throw readable(err, from);
    }
    return { path: to };
  }

  /** Permanent. Folders recursively; symlinks are unlinked, never followed. */
  async delete(sessionId, remotePath) {
    const p = checkRemotePath(remotePath);
    if (p === '/') throw new Error('Refusing to delete the root of the server.');
    const sftp = await this.getSFTP(sessionId);
    let attrs;
    try {
      attrs = await this._call(sftp, 'lstat', p);
    } catch (err) {
      throw readable(err, p);
    }
    await this._deleteTree(sftp, p, attrs);
    return { path: p };
  }

  async _deleteTree(sftp, p, attrs) {
    if (!attrs.isDirectory()) {
      try { await this._call(sftp, 'unlink', p); } catch (err) { throw readable(err, p); }
      return;
    }
    let list;
    try { list = await this._call(sftp, 'readdir', p); } catch (err) { throw readable(err, p); }
    for (const item of list) {
      if (item.filename === '.' || item.filename === '..') continue;
      if (!isSafeRemoteName(item.filename)) {
        throw new Error(`The server listed an unsafe name in ${p}; nothing more was deleted.`);
      }
      await this._deleteTree(sftp, `${p}/${item.filename}`, item.attrs);
    }
    try { await this._call(sftp, 'rmdir', p); } catch (err) { throw readable(err, p); }
  }

  async chmod(sessionId, remotePath, mode) {
    const p = checkRemotePath(remotePath);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('Invalid permissions.');
    const sftp = await this.getSFTP(sessionId);
    try {
      await this._call(sftp, 'chmod', p, mode);
    } catch (err) {
      throw readable(err, p);
    }
    return { path: p, mode };
  }

  async _exists(sftp, p) {
    try {
      await this._call(sftp, 'lstat', p);
      return true;
    } catch (err) {
      if (err.code === STATUS.NO_SUCH_FILE) return false;
      throw readable(err, p);
    }
  }

  closeSFTP(sessionId) {
    const sftp = this.sftpSessions.get(sessionId);
    if (sftp) {
      try { sftp.end(); } catch (_) { /* ignore */ }
      this.sftpSessions.delete(sessionId);
    }
  }

  closeAll() {
    for (const [sessionId] of this.sftpSessions) this.closeSFTP(sessionId);
  }
}

module.exports = new SFTPService();
module.exports.checkRemotePath = checkRemotePath;
module.exports.checkRemoteName = checkRemoteName;
module.exports.isSafeRemoteName = isSafeRemoteName;
module.exports.readable = readable;
module.exports.STATUS = STATUS;
