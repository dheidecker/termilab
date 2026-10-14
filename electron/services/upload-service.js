const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sftpService = require('./sftp-service');

/**
 * Images handed to a terminal (drag & drop, clipboard), so an agent CLI
 * running there (Claude Code, Codex) can read them by path.
 *
 *  - Local terminal: a dropped file with a path on disk is typed as is (the
 *    renderer does that, nothing reaches here). Bytes without a path (a
 *    clipboard image, an image dragged out of a browser) are saved to
 *    `~/.termilab/uploads/<name>-<yyyymmdd-HHMMSS>.<ext>` (dir 0700, file 0600).
 *  - SSH terminal: uploaded over an SFTP channel on that tab's OWN ssh2
 *    client (sftpService.getSFTP: never a new connection) to the same folder
 *    under the remote home, with progress pushed to the window that asked.
 *
 * Only images (sniffed from the bytes, not trusted from the name), at most
 * MAX_ITEMS per call and MAX_BYTES each. Every save/upload first deletes
 * files older than MAX_AGE_MS in that uploads folder (bounded, best effort).
 * The folders are refused when they are symlinks, not directories or not
 * owned by the user, like the keeper's.
 */

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ITEMS = 10;
const MAX_AGE_MS = 3 * 24 * 3600 * 1000;
const CLEAN_MAX = 200;          // entries deleted per cleanup, at most
const CLEAN_BUDGET_MS = 4000;   // and never longer than this
const STEP_TIMEOUT_MS = 20000;
const CHUNK = 32 * 1024;
const IN_FLIGHT = 8;

const ONLY_IMAGES = 'Only images can be attached';

/** The image type of `buf` from its magic bytes: 'png' | 'jpg' | 'gif' | 'webp' | null */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * A file name that is safe to type into any shell and any agent's path
 * parser: last segment of `name` (both separators), extension dropped,
 * everything outside [A-Za-z0-9._-] turned into '-', no leading dot/dash,
 * at most 60 chars; then -<timestamp>[-n].<ext>.
 */
function safeName(name, ext, when = new Date(), n = 0) {
  let base = String(name || '').split(/[\\/]/).pop() || '';
  base = base.replace(/(.)\.[^.]*$/, '$1');
  base = base.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  base = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/\.{2,}/g, '.');
  base = base.replace(/^[-.]+/, '').replace(/[-.]+$/, '').slice(0, 60).replace(/[-.]+$/, '');
  if (!base) base = 'image';
  return `${base}-${stamp(when)}${n ? `-${n + 1}` : ''}.${ext}`;
}

class UploadError extends Error {}

/**
 * Items from the renderer → [{ name, data: Buffer, ext }], or throws with a
 * message the pane can show as is. item = { path } | { data, name }.
 */
async function loadItems(items) {
  if (!Array.isArray(items) || !items.length) throw new UploadError('Nothing to attach');
  if (items.length > MAX_ITEMS) throw new UploadError(`At most ${MAX_ITEMS} images at a time`);
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') throw new UploadError(ONLY_IMAGES);
    let data; let name;
    if (typeof it.path === 'string' && it.path) {
      if (!path.isAbsolute(it.path) || it.path.includes('\0')) throw new UploadError(ONLY_IMAGES);
      name = path.basename(it.path);
      const st = await fsp.stat(it.path).catch(() => null);
      if (!st || !st.isFile()) throw new UploadError(`${name} is not a file`);
      if (st.size > MAX_BYTES) throw new UploadError(`${name} is larger than 20 MB`);
      data = await fsp.readFile(it.path);
    } else if (it.data != null) {
      name = typeof it.name === 'string' && it.name ? it.name : 'image';
      data = Buffer.isBuffer(it.data) ? it.data : Buffer.from(it.data.buffer ? new Uint8Array(it.data.buffer, it.data.byteOffset, it.data.byteLength) : it.data);
    } else {
      throw new UploadError(ONLY_IMAGES);
    }
    if (data.length > MAX_BYTES) throw new UploadError(`${name} is larger than 20 MB`);
    const ext = sniff(data);
    if (!ext) throw new UploadError(ONLY_IMAGES);
    out.push({ name, data, ext });
  }
  return out;
}

const pcall = (fn) => new Promise((resolve, reject) => fn((err, r) => (err ? reject(err) : resolve(r))));
function withTimeout(p, what) {
  let t;
  return Promise.race([
    p,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out`)), STEP_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(t));
}

class UploadService {
  constructor() {
    /** Overridable by the harness: the local home that holds .termilab/uploads */
    this.localHome = null;
    this.progressMs = 100;
  }

  _home() { return this.localHome || os.homedir(); }

  /* ── Local ─────────────────────────────────────────────── */

  async _localDir() {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const home = this._home();
    let dir = home;
    for (const seg of ['.termilab', 'uploads']) {
      dir = path.join(dir, seg);
      const what = `~/.termilab${seg === 'uploads' ? '/uploads' : ''}`;
      let st = await fsp.lstat(dir).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
      if (!st) {
        await fsp.mkdir(dir, { mode: 0o700 }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
        st = await fsp.lstat(dir);
      }
      if (st.isSymbolicLink()) throw new UploadError(`${what} is a symlink: refusing to use it`);
      if (!st.isDirectory()) throw new UploadError(`${what} is not a directory`);
      if (uid != null && st.uid !== uid) throw new UploadError(`${what} is not owned by you`);
      if (seg === 'uploads' && process.platform !== 'win32' && (st.mode & 0o077)) await fsp.chmod(dir, 0o700);
    }
    return dir;
  }

  async cleanLocal(dir, now = Date.now()) {
    const t0 = Date.now();
    let removed = 0;
    let names = [];
    try { names = await fsp.readdir(dir); } catch (_) { return 0; }
    for (const n of names) {
      if (removed >= CLEAN_MAX || Date.now() - t0 > CLEAN_BUDGET_MS) break;
      const p = path.join(dir, n);
      try {
        const st = await fsp.lstat(p);
        if (st.isDirectory()) continue;
        if (now - st.mtimeMs <= MAX_AGE_MS) continue;
        await fsp.unlink(p);   // a symlink is removed, never followed
        removed++;
      } catch (_) { /* best effort */ }
    }
    return removed;
  }

  /** Saves bytes (clipboard, path-less drops) locally → absolute paths, in order. */
  async saveLocal(items) {
    const loaded = await loadItems(items);
    const dir = await this._localDir();
    await this.cleanLocal(dir);
    const when = new Date();
    const out = [];
    for (const it of loaded) {
      for (let n = 0; ; n++) {
        const p = path.join(dir, safeName(it.name, it.ext, when, n));
        let fh;
        try {
          fh = await fsp.open(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
        } catch (e) {
          if (e.code === 'EEXIST' && n < 50) continue;
          throw e;
        }
        try {
          await fh.writeFile(it.data);
          await fh.chmod(0o600).catch(() => {});
        } catch (e) {
          await fh.close().catch(() => {});
          await fsp.unlink(p).catch(() => {});
          throw e;
        }
        await fh.close();
        out.push(p);
        break;
      }
    }
    return out;
  }

  /* ── Remote (SFTP on the tab's own connection) ─────────── */

  async _remoteDir(sftp) {
    const lstat = (p) => withTimeout(pcall(cb => sftp.lstat(p, cb)), 'lstat');
    const home = (await withTimeout(pcall(cb => sftp.realpath('.', cb)), 'realpath')).replace(/\/+$/, '') || '/';
    const homeSt = await withTimeout(pcall(cb => sftp.stat(home, cb)), 'stat');
    const uid = homeSt.uid;
    let dir = home === '/' ? '' : home;
    for (const seg of ['.termilab', 'uploads']) {
      dir = `${dir}/${seg}`;
      const what = `~/.termilab${seg === 'uploads' ? '/uploads' : ''} on the server`;
      let st;
      try { st = await lstat(dir); } catch (err) {
        if (err.code !== 2) throw new UploadError(`cannot access ${what} (${err.code === 3 ? 'permission denied' : err.message})`);
        try { await withTimeout(pcall(cb => sftp.mkdir(dir, { mode: 0o700 }, cb)), 'mkdir'); } catch (_) { /* raced, or refused: checked below */ }
        try { await withTimeout(pcall(cb => sftp.chmod(dir, 0o700, cb)), 'chmod'); } catch (_) { /* checked below */ }
        try { st = await lstat(dir); } catch (e2) { throw new UploadError(`cannot create ${what}`); }
      }
      if (st.isSymbolicLink()) throw new UploadError(`${what} is a symlink: refusing to use it`);
      if (!st.isDirectory()) throw new UploadError(`${what} is not a directory`);
      if (typeof st.uid === 'number' && typeof uid === 'number' && st.uid !== uid) throw new UploadError(`${what} is not owned by you`);
      if (seg === 'uploads' && (st.mode & 0o077)) {
        await withTimeout(pcall(cb => sftp.chmod(dir, 0o700, cb)), 'chmod');
      }
    }
    return dir;
  }

  async cleanRemote(sftp, dir, now = Date.now()) {
    const t0 = Date.now();
    let removed = 0;
    let list = [];
    try { list = await withTimeout(pcall(cb => sftp.readdir(dir, cb)), 'readdir'); } catch (_) { return 0; }
    for (const e of list) {
      if (removed >= CLEAN_MAX || Date.now() - t0 > CLEAN_BUDGET_MS) break;
      const n = e.filename;
      if (!n || n === '.' || n === '..' || n.includes('/')) continue;
      const p = `${dir}/${n}`;
      try {
        /* The attrs of a listing are whatever the server says: lstat it */
        const st = await withTimeout(pcall(cb => sftp.lstat(p, cb)), 'lstat');
        if (st.isDirectory()) continue;
        if (now - st.mtime * 1000 <= MAX_AGE_MS) continue;
        await withTimeout(pcall(cb => sftp.unlink(p, cb)), 'unlink');
        removed++;
      } catch (_) { /* best effort */ }
    }
    return removed;
  }

  async _writeRemote(sftp, file, data, onBytes) {
    const handle = await withTimeout(pcall(cb => sftp.open(file, 'wx', { mode: 0o600 }, cb)), 'open');
    let failed = null;
    try {
      let next = 0; let sent = 0;
      await new Promise((resolve, reject) => {
        let inflight = 0;
        const pump = () => {
          if (failed) return;
          if (next >= data.length && inflight === 0) return resolve();
          while (inflight < IN_FLIGHT && next < data.length) {
            const off = next;
            const n = Math.min(CHUNK, data.length - off);
            next += n;
            inflight++;
            withTimeout(pcall(cb => sftp.write(handle, data, off, n, off, cb)), 'write').then(() => {
              inflight--;
              sent += n;
              onBytes(sent);
              pump();
            }, (err) => { if (!failed) { failed = err; reject(err); } });
          }
        };
        pump();
      });
      await withTimeout(pcall(cb => sftp.fchmod(handle, 0o600, cb)), 'chmod').catch(() => {});
    } finally {
      await pcall(cb => sftp.close(handle, cb)).catch(() => {});
    }
  }

  /**
   * Uploads to ~/.termilab/uploads on the server of `sessionId` → the absolute
   * remote paths, in order. `send(payload)` gets progress:
   * { uploadId, index, count, name, sent, total, done? }.
   */
  async uploadRemote(sessionId, uploadId, items, send = () => {}) {
    const loaded = await loadItems(items);
    const sftp = await sftpService.getSFTP(sessionId);
    const dir = await this._remoteDir(sftp);
    await this.cleanRemote(sftp, dir);
    const when = new Date();
    const out = [];
    for (let i = 0; i < loaded.length; i++) {
      const it = loaded[i];
      let file = null;
      for (let n = 0; n < 50; n++) {
        const cand = `${dir}/${safeName(it.name, it.ext, when, n)}`;
        const exists = await withTimeout(pcall(cb => sftp.lstat(cand, cb)), 'lstat').then(() => true, (e) => (e.code === 2 ? false : Promise.reject(e)));
        if (!exists) { file = cand; break; }
      }
      if (!file) throw new UploadError(`could not find a free name for ${it.name}`);
      let last = 0;
      const push = (sent, done = false) => {
        const t = Date.now();
        if (!done && t - last < this.progressMs) return;
        last = t;
        send({ uploadId, index: i, count: loaded.length, name: it.name, sent, total: it.data.length, done });
      };
      push(0);
      try {
        await this._writeRemote(sftp, file, it.data, (s) => push(s));
      } catch (err) {
        await pcall(cb => sftp.unlink(file, cb)).catch(() => {});
        throw new UploadError(`Upload of ${it.name} failed: ${err.message}`);
      }
      push(it.data.length, true);
      out.push(file);
    }
    return out;
  }
}

const uploadService = new UploadService();
uploadService.sniff = sniff;
uploadService.safeName = safeName;
uploadService.limits = { MAX_BYTES, MAX_ITEMS, MAX_AGE_MS };
module.exports = uploadService;
