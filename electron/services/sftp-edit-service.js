const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const transferService = require('./transfer-service');
const sftpService = require('./sftp-service');

const { checkRemotePath, STATUS } = sftpService;

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
 *
 * A remote file is attacker-controlled: its name and mode come from the
 * server. So the temp copy is always 0600 (no exec bit survives), and types
 * the OS would RUN instead of show are never handed to shell.openPath:
 * "Open" refuses everything on OPEN_BLOCKED (any platform: a double click
 * must never run a program), "Edit" refuses what runs on THIS platform even
 * as text (EDIT_BLOCKED; .js/.bat on Windows, .command on macOS…). The error
 * starts with "Refusing to open", which the pane turns into a Download offer.
 *
 * Re-uploading an edit writes IN PLACE into the resolved target (realpath
 * first, so a symlink's target is what changes; see transfer-service
 * `inPlace`): the inode, owner, group, mode, hard links and ACLs stay.
 * Uploads of one edit are serialized: one in flight, and at most one more
 * queued, which reads the temp file when it starts (so it sends the latest).
 */

const OWNER_RE = /^[A-Za-z0-9_-]{1,100}$/;

const WIN_RUNS = ['exe', 'bat', 'cmd', 'com', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ws', 'hta', 'scr', 'pif',
  'msi', 'msp', 'mst', 'lnk', 'cpl', 'reg', 'inf', 'scf', 'url', 'jar', 'py', 'pyw', 'sh', 'application', 'appref-ms',
  'msc', 'gadget', 'library-ms', 'settingcontent-ms', 'appx', 'msix', 'appinstaller', 'xll', 'diagcab'];
const MAC_RUNS = ['app', 'command', 'tool', 'terminal', 'pkg', 'mpkg', 'jar', 'workflow', 'action', 'scpt', 'applescript', 'webloc', 'inetloc'];
const LINUX_RUNS = ['desktop', 'appimage', 'jar', 'run', 'flatpakref'];
const EDIT_BLOCKED = { win32: new Set(WIN_RUNS), darwin: new Set(MAC_RUNS), linux: new Set(LINUX_RUNS) };
const OPEN_BLOCKED = new Set([...WIN_RUNS, ...MAC_RUNS, ...LINUX_RUNS, 'ps1', 'psm1', 'psd1', 'ps1xml',
  'bash', 'zsh', 'csh', 'ksh', 'fish', 'pl', 'rb', 'deb', 'rpm', 'elf', 'out', 'so', 'dll', 'sys', 'drv', 'ocx']);

/** The reason `name` must not go to shell.openPath, or null. */
function openRefusal(name, purpose = 'open', platform = process.platform) {
  // Windows drops trailing dots/spaces: "evil.exe. " opens as evil.exe.
  const clean = String(name).replace(/[. ]+$/, '').toLowerCase();
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 ? clean.slice(dot + 1) : '';
  if (!ext) return null;
  const blocked = purpose === 'edit' ? (EDIT_BLOCKED[platform] || EDIT_BLOCKED.linux) : OPEN_BLOCKED;
  if (!blocked.has(ext)) return null;
  return `Refusing to open "${name}": .${ext} files can run as programs on this computer. Download it instead.`;
}

function assertOpenable(name, purpose) {
  const why = openRefusal(name, purpose);
  if (why) {
    const err = new Error(why);
    err.code = 'EUNSAFEOPEN';
    throw err;
  }
}

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
    }, { fileMode: 0o600 });   // never keep the server's exec bits
    return { localPath: res.target, dir };
  }

  /** Download to temp and open with the default app. */
  async open(sessionId, remotePath, owner) {
    assertOpenable(path.posix.basename(checkRemotePath(remotePath)), 'open');
    const { localPath } = await this._download(sessionId, remotePath, owner);
    assertOpenable(path.basename(localPath), 'open');
    const error = await this._getShell().openPath(localPath);
    if (error) throw new Error(error);
    return { localPath };
  }

  /** Download, open, and watch for saves. */
  async start(sessionId, remotePath, owner) {
    assertOpenable(path.posix.basename(checkRemotePath(remotePath)), 'edit');
    const { localPath, dir } = await this._download(sessionId, remotePath, owner);
    assertOpenable(path.basename(localPath), 'edit');
    const editId = crypto.randomUUID();
    const edit = {
      editId, owner, sessionId, remotePath: checkRemotePath(remotePath), localPath, dir,
      name: path.basename(localPath), sig: await this._sig(localPath), timer: null, watcher: null,
      inflight: null, queued: null,
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

  /**
   * Upload the temp copy over the remote file. One upload per edit at a
   * time: a call while one runs waits for it and then sends the file as it
   * is THEN; calls while that one waits share it (the latest content wins,
   * never an older upload finishing last).
   */
  upload(editId) {
    const edit = this.edits.get(editId);
    if (!edit) return Promise.reject(new Error('This edit is no longer open.'));
    if (!edit.inflight) {
      edit.inflight = this._uploadOnce(edit).finally(() => { edit.inflight = null; });
      return edit.inflight;
    }
    if (!edit.queued) {
      edit.queued = edit.inflight.catch(() => {}).then(() => {
        edit.queued = null;
        return this.upload(editId);
      });
    }
    return edit.queued;
  }

  async _uploadOnce(edit) {
    /* Write into what the path RESOLVES to: a symlink stays a symlink and
       its target gets the content. If nothing is there any more, the file
       is recreated at its path the normal way (part + rename). */
    let target = null;
    try {
      target = checkRemotePath(await sftpService.realpath(edit.sessionId, edit.remotePath));
    } catch (err) {
      if (err.code !== STATUS.NO_SUCH_FILE) throw err;
    }
    const where = target || edit.remotePath;
    const res = await transferService.start(`edit-${crypto.randomUUID()}`, {
      src: { kind: 'local' },
      srcPath: edit.localPath,
      dst: { kind: 'remote', sessionId: edit.sessionId },
      dstDir: path.posix.dirname(where),
      name: path.posix.basename(where),
      conflict: 'overwrite',
    }, target ? { inPlace: true } : {});
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
module.exports.openRefusal = openRefusal;
