/*
 * The SFTP screen's view of a filesystem: this computer (`localFs` in
 * preload) or a remote session (`sftp`). Both expose the same shape here, so
 * a pane does not care which one it shows.
 *
 * Without Electron (plain browser, screenshots) everything runs against an
 * in-memory mock: a home folder here, one per mock host, transfers that
 * advance on a timer, and an edit that "changes" a moment after opening.
 */

import { joinPath, parentPath, baseName, permString } from './paths';

const api = () => (typeof window !== 'undefined' ? window.electronAPI : null);
export const hasApi = () => !!api()?.sftp && !!api()?.localFs;

/** Endpoint as the transfer engine in main wants it. */
export const endpointOf = (conn) => (conn.kind === 'local' ? { kind: 'local' } : { kind: 'remote', sessionId: conn.sessionId });

// ─── Real ──────────────────────────────────────────────────

function realFs(endpoint) {
  const a = api();
  if (endpoint.kind === 'local') {
    const l = a.localFs;
    return {
      kind: 'local',
      home: () => l.home(),
      list: (dir) => l.list(dir),
      stat: (p) => l.stat(p),
      mkdir: (dir, name) => l.mkdir(dir, name),
      createFile: (dir, name) => l.createFile(dir, name),
      rename: (p, name) => l.rename(p, name),
      remove: (p) => l.trash(p),
      chmod: (p, mode) => l.chmod(p, mode),
      open: (p) => l.open(p),
    };
  }
  const s = a.sftp;
  const id = endpoint.sessionId;
  return {
    kind: 'remote',
    home: () => s.realpath(id, '.'),
    list: (dir) => s.list(id, dir),
    stat: (p) => s.stat(id, p),
    mkdir: (dir, name) => s.mkdir(id, dir, name),
    createFile: (dir, name) => s.createFile(id, dir, name),
    rename: (p, name) => s.rename(id, p, name),
    remove: (p) => s.delete(id, p),
    chmod: (p, mode) => s.chmod(id, p, mode),
    open: (p, owner) => s.openRemote(id, p, owner),
    edit: (p, owner) => s.editStart(id, p, owner),
  };
}

// ─── Mock ──────────────────────────────────────────────────

const NOW = Date.now();
const ago = (h) => NOW - h * 3600 * 1000;
const MB = 1024 * 1024;

const d = (children, h = 30, mode = 0o40755) => ({ type: 'directory', mode, mtime: ago(h), children });
const f = (size, h = 5, mode = 0o100644) => ({ type: 'file', size, mode, mtime: ago(h) });

function localTree() {
  return d({
    home: d({
      derek: d({
        Documents: d({ 'invoice-0931.pdf': f(182000, 90), 'contract draft.docx': f(48200, 300) }, 20),
        Downloads: d({ 'ubuntu-24.04-live-server-amd64.iso': f(2.6 * 1024 * MB, 400), 'photo.jpg': f(3.1 * MB, 60) }, 3),
        Projects: d({ termilab: d({ 'package.json': f(4100, 2), src: d({}, 2) }, 2), website: d({}, 800), 'README.md': f(2300, 48) }, 2),
        '.ssh': d({ id_ed25519: f(411, 2000, 0o100600), 'id_ed25519.pub': f(99, 2000), known_hosts: f(3210, 12) }, 12, 0o40700),
        '.bashrc': f(3771, 2000),
        'backup-2026-09.tar.gz': f(52 * MB, 26),
        'docker-compose.yml': f(896, 7),
        'deploy.sh': f(4521, 30, 0o100755),
        'screenshot 2026-09-20.png': f(812000, 90),
        'notes.txt': f(1540, 1),
      }, 1),
    }),
  });
}

function remoteTree(user) {
  const home = d({
    app: d({ 'server.js': f(12400, 20), 'package.json': f(1900, 20), node_modules: d({}, 20), public: d({ 'index.html': f(5400, 44) }, 44) }, 20),
    logs: d({ 'access.log': f(18.4 * MB, 0.2), 'error.log': f(220000, 0.4) }, 0.2),
    releases: d({ 'v1.11.2': d({}, 60), 'v1.11.1': d({}, 200) }, 60),
    '.config': d({}, 900),
    '.profile': f(807, 2000),
    'backup-2026-09.tar.gz': f(51 * MB, 120),
    'docker-compose.yml': f(1204, 3),
    'nginx.conf': f(2890, 70),
    'notes.txt': f(620, 10),
    'restart.sh': f(310, 70, 0o100750),
  }, 1);
  const root = d({ etc: d({ 'hostname': f(12, 3000) }, 200), var: d({ log: d({}, 1) }, 200), home: d({}, 200), root: d({}, 200, 0o40700) });
  if (user === 'root') root.children.root = home;
  else root.children.home.children[user] = home;
  return { root, home: user === 'root' ? '/root' : `/home/${user}` };
}

class MockFs {
  constructor(root, home, kind) {
    this.root = root;
    this.homeDir = home;
    this.kind = kind;
  }

  _node(p) {
    if (p === '/') return this.root;
    let n = this.root;
    for (const seg of p.split('/').filter(Boolean)) {
      if (!n || n.type !== 'directory') return null;
      n = n.children[seg];
    }
    return n || null;
  }

  _entry(dir, name, n) {
    return {
      name,
      path: joinPath(this.kind, dir, name),
      type: n.type,
      size: n.type === 'directory' ? null : n.size,
      modifyTime: n.mtime,
      mode: n.mode,
      permissions: permString(n.mode),
      isHidden: name.startsWith('.'),
    };
  }

  _fail(msg) { return Promise.reject(new Error(msg)); }
  _delay(v) { return new Promise(r => setTimeout(() => r(v), 60)); }

  home() { return this._delay(this.homeDir); }

  list(dir) {
    const n = this._node(dir);
    if (!n) return this._fail(`No such file or folder: ${dir}`);
    if (n.type !== 'directory') return this._fail(`Not a folder: ${dir}`);
    if (dir === '/root' && this.kind === 'remote' && this.homeDir !== '/root') return this._fail(`Permission denied: ${dir}`);
    return this._delay(Object.entries(n.children).map(([name, c]) => this._entry(dir, name, c)));
  }

  stat(p) {
    const n = this._node(p);
    return this._delay(n ? this._entry(parentPath(this.kind, p), baseName(this.kind, p), n) : null);
  }

  _create(dir, name, node) {
    const n = this._node(dir);
    if (!n || n.type !== 'directory') return this._fail(`No such folder: ${dir}`);
    if (n.children[name]) return this._fail(`"${name}" already exists here.`);
    n.children[name] = node;
    n.mtime = Date.now();
    return this._delay({ path: joinPath(this.kind, dir, name) });
  }

  mkdir(dir, name) { return this._create(dir, name, d({}, 0)); }
  createFile(dir, name) { return this._create(dir, name, f(0, 0)); }

  rename(p, name) {
    const dir = parentPath(this.kind, p);
    const parent = this._node(dir);
    const old = baseName(this.kind, p);
    if (!parent || !parent.children[old]) return this._fail(`No such file or folder: ${p}`);
    if (parent.children[name]) return this._fail(`"${name}" already exists here.`);
    parent.children[name] = parent.children[old];
    delete parent.children[old];
    return this._delay({ path: joinPath(this.kind, dir, name) });
  }

  remove(p) {
    const parent = this._node(parentPath(this.kind, p));
    const name = baseName(this.kind, p);
    if (!parent || !parent.children[name]) return this._fail(`No such file or folder: ${p}`);
    delete parent.children[name];
    return this._delay({ path: p });
  }

  chmod(p, mode) {
    const n = this._node(p);
    if (!n) return this._fail(`No such file or folder: ${p}`);
    n.mode = (n.mode & ~0o7777) | mode;
    return this._delay({ path: p, mode });
  }

  open(p) { return this._delay({ localPath: `/tmp/termilab-sftp-mock/${baseName(this.kind, p)}` }); }

  edit(p, owner) {
    const editId = `mock-edit-${Math.random().toString(36).slice(2)}`;
    const name = baseName(this.kind, p);
    setTimeout(() => emit(editListeners, { editId, owner, type: 'changed', name, remotePath: p }), 1800);
    return this._delay({ editId, localPath: `/tmp/termilab-sftp-mock/${name}`, name });
  }
}

let mockLocal = null;
const mockRemotes = new Map();   // sessionId -> MockFs
const mockHostTrees = new Map(); // hostId -> MockFs (reconnecting shows the same files)

function getMockLocal() {
  if (!mockLocal) mockLocal = new MockFs(localTree(), '/home/derek', 'local');
  return mockLocal;
}

/** A fake connection for a mock host. */
export function mockConnect(host) {
  if (!mockHostTrees.has(host.id)) {
    const { root, home } = remoteTree(host.username || 'root');
    mockHostTrees.set(host.id, new MockFs(root, home, 'remote'));
  }
  const sessionId = `mock-sftp-${host.id}-${Math.random().toString(36).slice(2, 8)}`;
  mockRemotes.set(sessionId, mockHostTrees.get(host.id));
  return sessionId;
}

function mockFsFor(endpoint) {
  if (endpoint.kind === 'local') return getMockLocal();
  const fs = mockRemotes.get(endpoint.sessionId);
  if (!fs) throw new Error('The SSH connection for this pane is closed. Reconnect to continue.');
  return fs;
}

// ─── Public facade ─────────────────────────────────────────

export function fsFor(endpoint) {
  if (hasApi()) return realFs(endpoint);
  const m = mockFsFor(endpoint);
  return {
    kind: m.kind,
    home: () => m.home(),
    list: (p) => m.list(p),
    stat: (p) => m.stat(p),
    mkdir: (dir, name) => m.mkdir(dir, name),
    createFile: (dir, name) => m.createFile(dir, name),
    rename: (p, name) => m.rename(p, name),
    remove: (p) => m.remove(p),
    chmod: (p, mode) => m.chmod(p, mode),
    open: (p, owner) => m.open(p, owner),
    edit: m.kind === 'remote' ? (p, owner) => m.edit(p, owner) : undefined,
  };
}

const progressListeners = new Set();
const editListeners = new Set();
const closeListeners = new Set();
function emit(set, payload) { for (const cb of Array.from(set)) cb(payload); }

// Mock transfers: 6 MB/s so a screenshot can catch them mid-way.
const mockJobs = new Map();
function mockTransferStart(id, spec) {
  return new Promise((resolve, reject) => {
    const src = mockFsFor(spec.src);
    const dst = mockFsFor(spec.dst);
    const node = src._node(spec.srcPath);
    if (!node) return reject(new Error(`Nothing at ${spec.srcPath} any more.`));
    const sizeOf = (n) => (n.type === 'directory' ? Object.values(n.children).reduce((s, c) => s + sizeOf(c), 0) : n.size);
    const total = sizeOf(node);
    let name = spec.name || baseName(src.kind, spec.srcPath);
    const dir = dst._node(spec.dstDir);
    if (dir.children[name]) {
      if (spec.conflict === 'rename') {
        const tar = name.match(/^(.+?)(\.tar\.[A-Za-z0-9]{1,5})$/);
        const dot = name.lastIndexOf('.');
        const stem = tar ? tar[1] : dot > 0 ? name.slice(0, dot) : name;
        const ext = tar ? tar[2] : dot > 0 ? name.slice(dot) : '';
        let i = 1;
        while (dir.children[`${stem} (${i})${ext}`]) i++;
        name = `${stem} (${i})${ext}`;
      } else if (spec.conflict !== 'overwrite') {
        return reject(new Error(`"${name}" already exists in ${spec.dstDir}.`));
      }
    }
    const job = { transferred: 0, timer: null, reject };
    mockJobs.set(id, job);
    const rate = 6 * MB / 10;
    job.timer = setInterval(() => {
      job.transferred = Math.min(total, job.transferred + rate);
      emit(progressListeners, { id, transferred: job.transferred, total, files: 1, filesDone: 0, current: name });
      if (job.transferred >= total) {
        clearInterval(job.timer);
        mockJobs.delete(id);
        dir.children[name] = JSON.parse(JSON.stringify(node));
        dir.children[name].mtime = Date.now();
        resolve({ id, bytes: total, files: 1, skipped: [], target: joinPath(dst.kind, spec.dstDir, name) });
      }
    }, 100);
  });
}

export const transfers = {
  start: (id, spec) => (hasApi() ? api().sftp.transferStart(id, spec) : mockTransferStart(id, spec)),
  cancel: (id) => {
    if (hasApi()) return api().sftp.transferCancel(id);
    const job = mockJobs.get(id);
    if (job) { clearInterval(job.timer); mockJobs.delete(id); job.reject(new Error('Cancelled')); }
    return Promise.resolve(!!job);
  },
  onProgress: (cb) => {
    if (hasApi()) {
      const l = api().sftp.onTransferProgress(cb);
      return () => api().sftp.offTransferProgress(l);
    }
    progressListeners.add(cb);
    return () => progressListeners.delete(cb);
  },
};

export const edits = {
  upload: (editId) => (hasApi() ? api().sftp.editUpload(editId) : new Promise(r => setTimeout(() => r({ bytes: 1 }), 400))),
  stop: (editId) => (hasApi() ? api().sftp.editStop(editId) : Promise.resolve(true)),
  cleanup: (owner) => (hasApi() ? api().sftp.cleanup(owner) : Promise.resolve(true)),
  onEvent: (cb) => {
    if (hasApi()) {
      const l = api().sftp.onEditEvent(cb);
      return () => api().sftp.offEditEvent(l);
    }
    editListeners.add(cb);
    return () => editListeners.delete(cb);
  },
};

/** The pane's ssh session closed (remote end, or its terminal tab closed). */
export function onSessionClose(cb) {
  if (hasApi()) {
    const l = api().sftp.onSessionClose(cb);
    return () => api().sftp.offSessionClose(l);
  }
  closeListeners.add(cb);
  return () => closeListeners.delete(cb);
}

/** Absolute path of a File dropped from the OS file manager, or null. */
export function pathForFile(file) {
  if (hasApi()) return api().sftp.pathForFile(file);
  return null;
}
