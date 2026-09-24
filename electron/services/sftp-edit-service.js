const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const transferService = require('./transfer-service');
const { checkRemotePath } = require('./sftp-service');

/**
 * "Open" and "Edit" of remote files: download to a private temp folder, hand
 * it to the OS default app, and (for Edit) watch it so the pane can offer to
 * upload each save.
 *
 * Temp folders belong to an OWNER (the SFTP tab id) and are removed when the
 * tab closes (`cleanup(owner)`) or the app quits (`closeAllSync`). Each file
 * gets its own subfolder so two files with the same name never collide, and
 * the folder is created by mkdtemp (0700).
 *
 * The watcher is on the file's FOLDER, not the file: most editors save by
 * writing a new file and renaming it over the old one, and a watch on the old
 * inode goes silent after the first save. Events are debounced and compared by
 * size + mtime, so one save is one 'changed' push:
 *   'sftp:edit-event' { editId, owner, type: 'changed', name, remotePath }
 */

const OWNER_RE = /^[A-Za-z0-9_-]{1,100}$/;

function checkOwner(owner) {
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) throw new Error('Invalid owner.');
  return owner;
}

class SftpEditService {
  constructor() {
    /** @type {Map<string, object>} editId -> edit */
    this.edits = new Map();
    /** @type {Map<string, string>} owner -> temp folder */
    this.ownerDirs = new Map();
    this.mainWindow = null;
    this._shell = null;     // the harness injects a fake
    this.debounceMs = 300;
  }

  setMainWindow(win) {
    this.mainWindow = win;
  }

  _getShell() {
    return this._shell || require('electron').shell;
  }

  _send(payload) {
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('sftp:edit-event', payload);
      }
    } catch (_) { /* window gone */ }
  }

  async _ownerDir(owner) {
    let dir = this.ownerDirs.get(owner);
    if (dir) return dir;
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'termilab-sftp-'));
    this.ownerDirs.set(owner, dir);
    return dir;
  }

  async _download(sessionId, remotePath, owner) {
    checkOwner(owner);
    const p = checkRemotePath(remotePath);
    const base = await this._ownerDir(owner);
    const dir = await fsp.mkdtemp(path.join(base, 'f-'));
    const res = await transferService.start(`temp-${crypto.randomUUID()}`, {
      src: { kind: 'remote', sessionId },
      srcPath: p,
      dst: { kind: 'local' },
      dstDir: dir,
    });
    return { localPath: res.target, dir };
  }

  /** Download to temp and open with the default app. */
  async open(sessionId, remotePath, owner) {
    const { localPath } = await this._download(sessionId, remotePath, owner);
    const error = await this._getShell().openPath(localPath);
    if (error) throw new Error(error);
    return { localPath };
  }

  /** Download, open, and watch for saves. */
  async start(sessionId, remotePath, owner) {
    const { localPath, dir } = await this._download(sessionId, remotePath, owner);
    const editId = crypto.randomUUID();
    const edit = {
      editId, owner, sessionId, remotePath: checkRemotePath(remotePath), localPath, dir,
      name: path.basename(localPath), sig: await this._sig(localPath), timer: null, watcher: null,
    };
    edit.watcher = fs.watch(dir, () => {
      clearTimeout(edit.timer);
      edit.timer = setTimeout(() => this._check(edit), this.debounceMs);
    });
    edit.watcher.on('error', () => { /* folder gone: cleanup */ });
    this.edits.set(editId, edit);
    const error = await this._getShell().openPath(localPath);
    if (error) {
      this.stop(editId);
      throw new Error(error);
    }
    return { editId, localPath, name: edit.name };
  }

  async _sig(p) {
    try {
      const st = await fsp.stat(p);
      return `${st.size}:${st.mtimeMs}`;
    } catch (_) {
      return null;
    }
  }

  async _check(edit) {
    if (!this.edits.has(edit.editId)) return;
    const sig = await this._sig(edit.localPath);
    if (!sig || sig === edit.sig) return;
    edit.sig = sig;
    this._send({ editId: edit.editId, owner: edit.owner, type: 'changed', name: edit.name, remotePath: edit.remotePath });
  }

  /** Upload the temp copy over the remote file. */
  async upload(editId) {
    const edit = this.edits.get(editId);
    if (!edit) throw new Error('This edit is no longer open.');
    const res = await transferService.start(`edit-${crypto.randomUUID()}`, {
      src: { kind: 'local' },
      srcPath: edit.localPath,
      dst: { kind: 'remote', sessionId: edit.sessionId },
      dstDir: path.posix.dirname(edit.remotePath),
      name: path.posix.basename(edit.remotePath),
      conflict: 'overwrite',
    });
    edit.sig = await this._sig(edit.localPath);
    return { bytes: res.bytes, remotePath: edit.remotePath };
  }

  /** Stop watching (the temp file stays until the owner's cleanup). */
  stop(editId) {
    const edit = this.edits.get(editId);
    if (!edit) return false;
    clearTimeout(edit.timer);
    try { edit.watcher && edit.watcher.close(); } catch (_) { /* ignore */ }
    this.edits.delete(editId);
    return true;
  }

  /** Everything of one tab: watchers and its temp folder. */
  async cleanup(owner) {
    checkOwner(owner);
    for (const edit of Array.from(this.edits.values())) {
      if (edit.owner === owner) this.stop(edit.editId);
    }
    const dir = this.ownerDirs.get(owner);
    this.ownerDirs.delete(owner);
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
    return true;
  }

  /** before-quit: synchronous, nothing may be left in /tmp. */
  closeAllSync() {
    for (const id of Array.from(this.edits.keys())) this.stop(id);
    for (const dir of this.ownerDirs.values()) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
    this.ownerDirs.clear();
  }
}

module.exports = new SftpEditService();
