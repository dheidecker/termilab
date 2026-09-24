const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sftpService = require('./sftp-service');
const { checkPath, checkName } = require('./local-fs-service');

const posix = path.posix;
const { STATUS, checkRemotePath, checkRemoteName, isSafeRemoteName } = sftpService;

/**
 * Copies between any two "endpoints": this computer, or an SFTP session.
 * local→remote (upload), remote→local (download), remote→remote (two hosts,
 * or two places on one) and local→local all go through the same code: the
 * file is streamed in CHUNK-sized pieces with at most CONCURRENCY reads/writes
 * in flight (≈1 MB), never read whole into memory. Both `fs` and ssh2's SFTP
 * have the same open/read/write/close shape, which is what makes one loop
 * serve all four directions. (Piping ssh2's Read/WriteStream keeps ONE
 * request in flight and ran at ~2 MB/s on localhost; this is what fastGet
 * does internally, but fastGet cannot be cancelled nor go remote→remote.)
 *
 * Each file is written to a hidden sibling `.<name>.<rand>.termilab-part` and
 * renamed onto its real name only once every byte is acknowledged. So:
 *  - a cancelled or failed transfer deletes its part file and leaves the
 *    target untouched (an existing file that was being overwritten survives);
 *  - if even that delete fails (the connection died), the leftover is clearly
 *    marked by its name.
 * Files of a folder copied before the cancel stay where they are.
 *
 * Conflicts are decided by the caller BEFORE start, for the top-level item:
 *   conflict: undefined → fail if the target exists
 *             'overwrite' → replace a file / merge into a folder
 *             'rename'    → "name (1).ext", the first free one
 * Inside a merged folder, files are replaced. A file never replaces a folder
 * (or vice versa): that is an error, not a silent rm -r.
 *
 * Progress is pushed on 'sftp:transfer-progress' as
 *   { id, transferred, total, files, filesDone, current }
 * at most every `progressMs` (120), plus once at the end.
 */

const CHUNK = 64 * 1024;
const CONCURRENCY = 16;
const PART_SUFFIX = '.termilab-part';

function cancelError() {
  const err = new Error('Cancelled');
  err.code = 'CANCELLED';
  return err;
}

/** "a.tar.gz" -> {stem:'a', ext:'.tar.gz'}; ".bashrc" has no extension. */
function splitExt(name) {
  const tar = name.match(/^(.+?)(\.tar\.[A-Za-z0-9]{1,5})$/);
  if (tar) return { stem: tar[1], ext: tar[2] };
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return { stem: name.slice(0, dot), ext: name.slice(dot) };
  return { stem: name, ext: '' };
}

// ─── Endpoints ──────────────────────────────────────────────

class LocalEndpoint {
  constructor() { this.kind = 'local'; }
  checkDir(p) { return checkPath(p); }
  checkName(n) { return checkName(n); }
  join(dir, name) {
    const full = path.join(dir, checkName(name));
    if (path.dirname(full) !== path.resolve(dir)) throw new Error(`"${name}" escapes ${dir}`);
    return full;
  }
  dirname(p) { return path.dirname(p); }
  basename(p) { return path.basename(p); }
  async lstat(p) {
    try {
      const st = await fsp.lstat(p);
      return { type: st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other', size: st.size, mode: st.mode };
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }
  async follow(p) {
    try {
      const st = await fsp.stat(p);
      return { type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other', size: st.size, mode: st.mode };
    } catch (_) {
      return null;
    }
  }
  async readdir(p) { return fsp.readdir(p); }
  async mkdir(p) { await fsp.mkdir(p); }
  open(p, flags, mode) {
    return new Promise((resolve, reject) => fs.open(p, flags, (mode & 0o777) || 0o644, (e, fd) => (e ? reject(e) : resolve(fd))));
  }
  read(fd, buf, off, len, pos) {
    return new Promise((resolve, reject) => fs.read(fd, buf, off, len, pos, (e, n) => (e ? reject(e) : resolve(n))));
  }
  write(fd, buf, off, len, pos) {
    return new Promise((resolve, reject) => fs.write(fd, buf, off, len, pos, (e, n) => (e ? reject(e) : resolve(n))));
  }
  close(fd) {
    return new Promise((resolve, reject) => fs.close(fd, (e) => (e ? reject(e) : resolve())));
  }
  async unlink(p) { await fsp.unlink(p); }
  /** Replaces `to` if it is a file (fs.rename does, atomically). */
  async replace(from, to) { await fsp.rename(from, to); }
}

class RemoteEndpoint {
  constructor(sessionId, sftp) {
    this.kind = 'remote';
    this.sessionId = sessionId;
    this.sftp = sftp;
  }
  _call(method, ...args) {
    return new Promise((resolve, reject) => {
      this.sftp[method](...args, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }
  checkDir(p) { return checkRemotePath(p); }
  checkName(n) { return checkRemoteName(n); }
  join(dir, name) { return posix.join(dir, checkRemoteName(name)); }
  dirname(p) { return posix.dirname(p); }
  basename(p) { return posix.basename(p); }
  _type(a) { return a.isDirectory() ? 'directory' : a.isSymbolicLink() ? 'symlink' : a.isFile() ? 'file' : 'other'; }
  async lstat(p) {
    try {
      const a = await this._call('lstat', p);
      return { type: this._type(a), size: a.size, mode: a.mode };
    } catch (err) {
      if (err.code === STATUS.NO_SUCH_FILE) return null;
      throw sftpService.readable(err, p);
    }
  }
  async follow(p) {
    try {
      const a = await this._call('stat', p);
      return { type: this._type(a), size: a.size, mode: a.mode };
    } catch (_) {
      return null;
    }
  }
  async readdir(p) {
    let list;
    try { list = await this._call('readdir', p); } catch (err) { throw sftpService.readable(err, p); }
    const names = [];
    for (const item of list) {
      if (item.filename === '.' || item.filename === '..') continue;
      /* A hostile server can list "../../.bashrc". Refuse the whole folder
         rather than copy a subset the user did not ask for. */
      if (!isSafeRemoteName(item.filename)) {
        throw new Error(`The server listed an unsafe name in ${p} ("${String(item.filename).slice(0, 60)}"). Transfer stopped.`);
      }
      names.push(item.filename);
    }
    return names;
  }
  async mkdir(p) {
    try { await this._call('mkdir', p); } catch (err) { throw sftpService.readable(err, p); }
  }
  async open(p, flags, mode) {
    try { return await this._call('open', p, flags, { mode: (mode & 0o777) || 0o644 }); } catch (err) { throw sftpService.readable(err, p); }
  }
  read(handle, buf, off, len, pos) {
    return new Promise((resolve, reject) => this.sftp.read(handle, buf, off, len, pos, (e, n) => (e ? reject(e) : resolve(n))));
  }
  /* ssh2 acks the whole request (it splits past the server's max itself) */
  write(handle, buf, off, len, pos) {
    return new Promise((resolve, reject) => this.sftp.write(handle, buf, off, len, pos, (e) => (e ? reject(e) : resolve(len))));
  }
  close(handle) { return this._call('close', handle); }
  async unlink(p) { await this._call('unlink', p); }
  async replace(from, to) {
    const there = await this.lstat(to);
    if (!there) {
      try { await this._call('rename', from, to); return; } catch (err) { throw sftpService.readable(err, to); }
    }
    /* SFTP v3 rename refuses an existing target. OpenSSH's posix-rename
       replaces atomically; without it, unlink then rename (a short window
       with no file, never a half-written one). */
    if (this.sftp._extensions && this.sftp._extensions['posix-rename@openssh.com']) {
      try { await this._call('ext_openssh_rename', from, to); return; } catch (_) { /* fall through */ }
    }
    await this._call('unlink', to).catch((err) => { throw sftpService.readable(err, to); });
    try { await this._call('rename', from, to); } catch (err) { throw sftpService.readable(err, to); }
  }
}

// ─── The engine ─────────────────────────────────────────────

class TransferService {
  constructor() {
    /** @type {Map<string, object>} id -> running job */
    this.jobs = new Map();
    this.mainWindow = null;
    /* Progress throttle. The harness sets 0 to cancel at an exact byte
       count: at localhost speed a 50 MB file is done between two ticks. */
    this.progressMs = 120;
  }

  setMainWindow(win) {
    this.mainWindow = win;
  }

  _send(payload) {
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('sftp:transfer-progress', payload);
      }
    } catch (_) { /* window gone */ }
  }

  async _endpoint(spec) {
    if (!spec || typeof spec !== 'object') throw new Error('Transfer endpoint missing.');
    if (spec.kind === 'local') return new LocalEndpoint();
    if (spec.kind === 'remote') {
      if (typeof spec.sessionId !== 'string' || !spec.sessionId) throw new Error('Remote endpoint without a session.');
      return new RemoteEndpoint(spec.sessionId, await sftpService.getSFTP(spec.sessionId));
    }
    throw new Error(`Unknown endpoint kind: ${spec.kind}`);
  }

  /**
   * Run one transfer to completion.
   * @param {string} id  chosen by the renderer (queue item id)
   * @param {{src, srcPath, dst, dstDir, name?, conflict?}} spec
   * @returns {Promise<{id, bytes, files, skipped, target}>}
   */
  async start(id, spec) {
    if (typeof id !== 'string' || !id) throw new Error('Transfer id missing.');
    if (this.jobs.has(id)) throw new Error('A transfer with this id is already running.');
    const job = { id, cancelled: false, transferred: 0, total: 0, files: 0, filesDone: 0, current: '', lastSent: 0 };
    this.jobs.set(id, job);
    try {
      const src = await this._endpoint(spec.src);
      const dst = await this._endpoint(spec.dst);
      const srcPath = src.checkDir(spec.srcPath);
      const dstDir = dst.checkDir(spec.dstDir);
      const name = dst.checkName(spec.name === undefined ? src.basename(srcPath) : spec.name);

      const top = await src.lstat(srcPath);
      if (!top) throw new Error(`Nothing at ${srcPath} any more.`);
      let topType = top.type;
      let topSize = top.size;
      if (topType === 'symlink') {
        const t = await src.follow(srcPath);
        if (!t || t.type !== 'file') throw new Error('Links to folders are not copied.');
        topType = 'file';
        topSize = t.size;
      }
      if (topType !== 'file' && topType !== 'directory') throw new Error('Only files and folders can be copied.');

      // Same place on the same endpoint: nothing to do, and a folder into itself loops.
      const sameSide = src.kind === dst.kind && (src.kind === 'local' || src.sessionId === dst.sessionId);
      if (sameSide) {
        const target = dst.join(dstDir, name);
        if (target === srcPath) throw new Error('Source and destination are the same.');
        const sep = src.kind === 'local' ? path.sep : '/';
        if (topType === 'directory' && (dstDir === srcPath || dstDir.startsWith(srcPath + sep))) {
          throw new Error('Cannot copy a folder into itself.');
        }
      }

      let finalName = name;
      const existing = await dst.lstat(dst.join(dstDir, name));
      if (existing) {
        if (spec.conflict === 'rename') {
          finalName = await this._freeName(dst, dstDir, name);
        } else if (spec.conflict === 'overwrite') {
          const existingDir = existing.type === 'directory';
          if (existingDir !== (topType === 'directory')) {
            throw new Error(existingDir
              ? `A folder named "${name}" is already there; a file cannot replace it.`
              : `A file named "${name}" is already there; a folder cannot replace it.`);
          }
        } else {
          const err = new Error(`"${name}" already exists in ${dstDir}.`);
          err.code = 'EEXIST';
          throw err;
        }
      }

      // Plan: every file and folder, so progress has a real total.
      const plan = [];
      const skipped = [];
      await this._plan(src, srcPath, '', topType, topSize, top.mode, plan, skipped, job);
      job.total = plan.reduce((n, p) => n + (p.type === 'file' ? p.size : 0), 0);
      job.files = plan.filter(p => p.type === 'file').length;
      this._progress(job, true);

      const target = dst.join(dstDir, finalName);
      for (const item of plan) {
        if (job.cancelled) throw cancelError();
        const to = item.rel ? this._joinRel(dst, target, item.rel) : target;
        const from = item.rel ? this._joinRel(src, srcPath, item.rel) : srcPath;
        if (item.type === 'directory') {
          const there = await dst.lstat(to);
          if (!there) await dst.mkdir(to);
          else if (there.type !== 'directory') throw new Error(`A file named "${dst.basename(to)}" is in the way of a folder.`);
          continue;
        }
        const there = await dst.lstat(to);
        if (there && there.type === 'directory') throw new Error(`A folder named "${dst.basename(to)}" is in the way of a file.`);
        job.current = item.rel || finalName;
        await this._copyFile(job, src, from, dst, to, item.mode, item.size);
        job.filesDone++;
        this._progress(job);
      }
      this._progress(job, true);
      return { id, bytes: job.transferred, files: job.filesDone, skipped, target };
    } finally {
      this.jobs.delete(id);
    }
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.cancelled = true;   // every worker stops at its next chunk
    return true;
  }

  cancelAll() {
    for (const id of this.jobs.keys()) this.cancel(id);
  }

  _joinRel(ep, base, rel) {
    let out = base;
    for (const seg of rel.split('/')) out = ep.join(out, seg);
    return out;
  }

  async _plan(src, p, rel, type, size, mode, plan, skipped, job) {
    if (job.cancelled) throw cancelError();
    if (type === 'file') {
      plan.push({ rel, type: 'file', size: size || 0, mode });
      return;
    }
    plan.push({ rel, type: 'directory' });
    const names = await src.readdir(p);
    names.sort();
    for (const n of names) {
      const child = src.join(p, n);
      const childRel = rel ? `${rel}/${n}` : n;
      let st = await src.lstat(child);
      if (!st) continue;
      if (st.type === 'symlink') {
        const t = await src.follow(child);
        if (!t || t.type !== 'file') { skipped.push(childRel); continue; }
        st = t;
      }
      if (st.type === 'file' || st.type === 'directory') {
        await this._plan(src, child, childRel, st.type, st.size, st.mode, plan, skipped, job);
      } else {
        skipped.push(childRel);
      }
    }
  }

  async _freeName(dst, dir, name) {
    const { stem, ext } = splitExt(name);
    for (let i = 1; i < 1000; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!(await dst.lstat(dst.join(dir, candidate)))) return candidate;
    }
    throw new Error(`No free name for "${name}" in ${dir}.`);
  }

  _partName(dst, to) {
    const base = dst.basename(to);
    const rand = crypto.randomBytes(4).toString('hex');
    // Keep under 255 bytes: long names get their stem cut, never the marker.
    const stem = Buffer.from(base).length > 200 ? base.slice(0, 100) : base;
    return dst.join(dst.dirname(to), `.${stem}.${rand}${PART_SUFFIX}`);
  }

  async _copyFile(job, src, from, dst, to, mode, size) {
    if (job.cancelled) throw cancelError();
    const part = this._partName(dst, to);
    let wrote = 0;
    const rh = await src.open(from, 'r');
    let wh = null;
    try {
      wh = await dst.open(part, 'wx', mode);
      await this._pump(job, src, rh, dst, wh, size, (n) => {
        wrote += n;
        job.transferred += n;
        this._progress(job);
      });
      const h = wh;
      wh = null;
      await dst.close(h);
      if (job.cancelled) throw cancelError();
      await dst.replace(part, to);
    } catch (err) {
      if (wh !== null) await dst.close(wh).catch(() => {});
      job.transferred -= wrote;
      await dst.unlink(part).catch(() => { /* marked by its name if it survives */ });
      throw err;
    } finally {
      await src.close(rh).catch(() => {});
    }
  }

  /**
   * CONCURRENCY workers, each with its own CHUNK buffer: take the next
   * offset, read it fully (short reads are retried), write it at the same
   * offset. The first error or a cancel stops every worker at its next step.
   */
  async _pump(job, src, rh, dst, wh, size, onBytes) {
    let next = 0;
    let stop = null;
    const worker = async () => {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        if (stop) return;
        if (job.cancelled) { stop = stop || cancelError(); return; }
        if (next >= size) return;
        const pos = next;
        const len = Math.min(CHUNK, size - pos);
        next += len;
        try {
          let got = 0;
          while (got < len) {
            const n = await src.read(rh, buf, got, len - got, pos + got);
            if (!n) throw new Error('The source file got shorter while it was being copied.');
            got += n;
          }
          let put = 0;
          while (put < len) put += await dst.write(wh, buf, put, len - put, pos + put);
        } catch (err) {
          stop = stop || err;
          return;
        }
        onBytes(len);
      }
    };
    const n = Math.max(1, Math.min(CONCURRENCY, Math.ceil(size / CHUNK)));
    await Promise.all(Array.from({ length: n }, worker));
    if (stop) throw stop;
  }

  _progress(job, force = false) {
    const now = Date.now();
    if (!force && now - job.lastSent < this.progressMs) return;
    job.lastSent = now;
    this._send({
      id: job.id,
      transferred: job.transferred,
      total: job.total,
      files: job.files,
      filesDone: job.filesDone,
      current: job.current,
    });
  }
}

module.exports = new TransferService();
module.exports.PART_SUFFIX = PART_SUFFIX;
module.exports.splitExt = splitExt;
