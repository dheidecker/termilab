/**
 * Claude Code conversations on this computer or on an SSH host, for the
 * Sessions dock's "Conversations" list (resume one with `claude --resume`).
 *
 * Claude Code keeps each conversation as JSONL in
 *   ~/.claude/projects/<encoded launch dir>/<session id>.jsonl
 * where the encoding turns every non [A-Za-z0-9] character into '-' (lossy).
 * Only the head (HEAD_BYTES) and the tail (TAIL_BYTES) of each file are read:
 * files reach tens of MB, and a huge first prompt pushes the cwd out of the head.
 * From it: the cwd values (the one whose encoding matches the folder is the
 * project; `claude --resume` must run there), the first real user message
 * (no meta, sidechain or tool result), and a title line when there is one.
 *
 * Remote: ONE exec of a POSIX sh + awk script on the tab's existing ssh2
 * client (no jq, no python, no new connection), 5 s, output capped.
 *
 * Privacy: nothing here is written anywhere. The cache is in memory only
 * (60 s per host) and holds trimmed previews, never file contents.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HEAD_BYTES = 32 * 1024;
const TAIL_BYTES = 8 * 1024;
const PREVIEW_CHARS = 80;
const RAW_CAP = 400;            // bytes of an escaped JSON string we keep
const LOCAL_LIMIT = 200;
const LOCAL_MAX_FILES = 20000;  // stat at most this many
const REMOTE_LIMIT = 100;
const REMOTE_TIMEOUT_MS = 5000;
const REMOTE_MAX_OUT = 256 * 1024;
const CACHE_MS = 60 * 1000;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const DIR_RE = /^[A-Za-z0-9-]{1,255}$/;

const encodeProject = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-');

/* ── Head scanning (identical rules locally and in the awk script) ── */

/* The escaped JSON string starting at s[0] (after the opening quote), up to
   its closing quote or `cap` chars, still escaped */
function rawString(s, cap = RAW_CAP) {
  let out = '';
  for (let j = 0; j < s.length && out.length < cap; j++) {
    const c = s[j];
    if (c === '\\') { out += c + (s[j + 1] || ''); j++; continue; }
    if (c === '"') break;
    out += c;
  }
  return out;
}

const USER_KEYS = ['"role":"user","content":"', '"type":"text","text":"'];

/** {cwds[], user, title, aiTitle} as escaped strings, from the first bytes of a file */
function scanHead(text) {
  const r = { cwds: [], user: '', title: '', aiTitle: '' };
  for (const line of text.split('\n')) {
    let i = line.indexOf('"cwd":"');
    if (i >= 0 && r.cwds.length < 6) {
      const v = rawString(line.slice(i + 7));
      if (v && !r.cwds.includes(v)) r.cwds.push(v);
    }
    i = line.indexOf('"customTitle":"');
    if (!r.title && i >= 0) r.title = rawString(line.slice(i + 15));
    i = line.indexOf('"aiTitle":"');
    if (!r.aiTitle && i >= 0) r.aiTitle = rawString(line.slice(i + 11));
    if (!r.user && line.includes('"type":"user"') && !line.includes('"isMeta":true')
      && !line.includes('"isSidechain":true') && !line.includes('"tool_use_id"')) {
      for (const k of USER_KEYS) {
        i = line.indexOf(k);
        if (i >= 0) { r.user = rawString(line.slice(i + k.length)); break; }
      }
    }
  }
  return r;
}

/* An escaped (and maybe cut) JSON string → text. A cut escape or UTF-8
   sequence at the end is dropped, not shown as garbage. */
function unescapeRaw(raw) {
  let s = String(raw || '');
  for (let k = 0; k < 8 && s; k++) {
    try { return JSON.parse(`"${s}"`).replace(/�+$/, ''); } catch (_) { /* cut */ }
    const cut = s.replace(/\\(u[0-9a-fA-F]{0,3})?$/, '');
    s = cut !== s ? cut : s.slice(0, -1);
  }
  return '';
}

/* One line for the row: a slash command's name, tags out, whitespace folded */
function preview(text) {
  let t = String(text || '');
  const cmd = /<command-name>\s*([^<]*)<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(t);
    t = `${cmd[1].trim()} ${args ? args[1] : ''}`;
  }
  t = t.replace(/<[^>]{1,80}>/g, ' ').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  return t.length > PREVIEW_CHARS ? `${t.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : t;
}

/* The folder name decoded by guessing: '-' → '/' (wrong for names with -, _ or .) */
const naiveDecode = (dir) => dir.replace(/-/g, '/');

/* Locally: walk the folder name against the disk to undo the lossy encoding */
function diskDecode(dir, root = '/') {
  const parts = dir.replace(/^-/, '').split('-');
  const walk = (base, i) => {
    if (i >= parts.length) return base;
    let entries;
    try { entries = fs.readdirSync(base); } catch (_) { return null; }
    /* Longest names first: "a-b" beats "a" when both exist */
    for (let j = parts.length; j > i; j--) {
      const want = parts.slice(i, j).join('-');
      for (const e of entries) {
        if (encodeProject(e) !== want) continue;
        const r = walk(path.join(base, e), j);
        if (r) return r;
      }
    }
    return null;
  };
  try { return walk(root, 0); } catch (_) { return null; }
}

/** One row, or null (no user message: an empty or bridge-only session) */
function makeRow({ dir, file, mtimeMs, size, head }, { decode = null } = {}) {
  if (!DIR_RE.test(dir) || !file.endsWith('.jsonl')) return null;
  const id = file.slice(0, -'.jsonl'.length);
  if (!ID_RE.test(id)) return null;
  const user = preview(unescapeRaw(head.user));
  if (!user) return null;
  const cwds = head.cwds.map(unescapeRaw).filter(c => c.startsWith('/') || /^[A-Za-z]:\\/.test(c));
  let project = cwds.find(c => encodeProject(c) === dir) || null;
  let guessed = false;
  if (!project) {
    project = (decode && decode(dir)) || cwds[0] || naiveDecode(dir);
    guessed = true;
  }
  const title = preview(unescapeRaw(head.title)) || preview(unescapeRaw(head.aiTitle)) || null;
  return {
    id,
    project,
    projectName: project.split(/[\\/]/).filter(Boolean).pop() || project,
    guessed,
    mtime: Math.round(mtimeMs),
    size,
    preview: user,
    title,
    command: resumeCommand(project, id),
  };
}

/* ── The command ── */

/** Single-quoted for sh */
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** `cd '<project>' && claude --resume <id>`; null for an id or path we would not type */
function resumeCommand(project, id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const resume = `claude --resume ${id}`;
  if (!project) return resume;
  /* A control character in a path would be typed as keys (Enter, Ctrl-C…) */
  if (/[\u0000-\u001f\u007f]/.test(project)) return null;
  return `cd ${sq(project)} && ${resume}`;
}

/* ── Local ── */

async function listLocal({ home = os.homedir(), limit = LOCAL_LIMIT, decodeRoot = '/' } = {}) {
  const root = path.join(home, '.claude', 'projects');
  let dirs;
  try { dirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch (_) { return { rows: [], found: false }; }
  const files = [];
  outer:
  for (const d of dirs) {
    if (!d.isDirectory() || !DIR_RE.test(d.name)) continue;
    let ents;
    try { ents = await fs.promises.readdir(path.join(root, d.name), { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      files.push({ dir: d.name, file: e.name });
      if (files.length >= LOCAL_MAX_FILES) break outer;
    }
  }
  await Promise.all(files.map(async (f) => {
    try { const st = await fs.promises.stat(path.join(root, f.dir, f.file)); f.mtimeMs = st.mtimeMs; f.size = st.size; } catch (_) { f.mtimeMs = -1; }
  }));
  const newest = files.filter(f => f.mtimeMs >= 0).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
  const decoded = new Map();
  const decode = (dir) => {
    if (!decoded.has(dir)) decoded.set(dir, diskDecode(dir, decodeRoot));
    return decoded.get(dir);
  };
  const rows = [];
  for (const f of newest) {
    let text = '';
    let fh = null;
    try {
      fh = await fs.promises.open(path.join(root, f.dir, f.file), 'r');
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      /* + the last TAIL_BYTES, like the remote `tail -c` (whole file if smaller) */
      const tail = Buffer.alloc(Math.min(TAIL_BYTES, f.size));
      const t = await fh.read(tail, 0, tail.length, Math.max(0, f.size - TAIL_BYTES));
      text = `${buf.subarray(0, bytesRead).toString('utf-8')}\n${tail.subarray(0, t.bytesRead).toString('utf-8')}`;
    } catch (_) { continue; } finally { if (fh) await fh.close().catch(() => {}); }
    const row = makeRow({ ...f, head: scanHead(text) }, { decode });
    if (row) rows.push(row);
  }
  return { rows, found: true };
}

/* ── Remote ── */

/*
 * $1 = how many files. Prints, per file (newest first):
 *   F<TAB>mtime<TAB>size<TAB>./<dir>/<file>
 *   C<TAB>cwd   (up to 4)   T<TAB>title   A<TAB>ai title   U<TAB>first user message
 * values still JSON-escaped (so never a raw tab or newline). "NODIR" when
 * there is no ~/.claude/projects. LC_ALL=C: awk counts bytes and never trips
 * on a UTF-8 sequence the head cut in two.
 */
const AWK = `
function rs(s,  o,j,c,n){o="";n=length(s);for(j=1;j<=n&&length(o)<${RAW_CAP};j++){c=substr(s,j,1);if(c=="\\\\"){o=o c substr(s,j+1,1);j++;continue}if(c=="\\"")break;o=o c}return o}
{l=$0
 if(nc<6&&(i=index(l,"\\"cwd\\":\\""))>0){v=rs(substr(l,i+7));if(v!=""&&!(v in seen)){seen[v]=1;nc++;print "C\\t" v}}
 if(t==""&&(i=index(l,"\\"customTitle\\":\\""))>0){t=rs(substr(l,i+15));if(t!="")print "T\\t" t}
 if(a==""&&(i=index(l,"\\"aiTitle\\":\\""))>0){a=rs(substr(l,i+11));if(a!="")print "A\\t" a}
 if(u==""&&index(l,"\\"type\\":\\"user\\"")>0&&index(l,"\\"isMeta\\":true")==0&&index(l,"\\"isSidechain\\":true")==0&&index(l,"\\"tool_use_id\\"")==0){
  if((i=index(l,"\\"role\\":\\"user\\",\\"content\\":\\""))>0)u=rs(substr(l,i+25))
  else if((i=index(l,"\\"type\\":\\"text\\",\\"text\\":\\""))>0)u=rs(substr(l,i+22))
  if(u!="")print "U\\t" u}}`;

const REMOTE_SCRIPT = [
  'LC_ALL=C; export LC_ALL',
  'n=$1',
  'd="$HOME/.claude/projects"',
  '[ -d "$d" ] || { echo NODIR; exit 0; }',
  'cd "$d" 2>/dev/null || { echo NODIR; exit 0; }',
  'if stat -c %Y . >/dev/null 2>&1; then gnu=1; else gnu=0; fi',
  `ls -1t ./*/*.jsonl 2>/dev/null | head -n "$n" | while IFS= read -r f; do`,
  '  [ -f "$f" ] || continue',
  '  if [ $gnu = 1 ]; then m=$(stat -c "%Y %s" -- "$f" 2>/dev/null); else m=$(stat -f "%m %z" -- "$f" 2>/dev/null); fi',
  '  set -- $m',
  '  printf "F\\t%s\\t%s\\t%s\\n" "${1:-0}" "${2:-0}" "$f"',
  /* The folder name with every '-' as '/': if that directory exists it is
     the project (when no cwd in the head matches the folder) */
  '  p=${f#./}; p=${p%%/*}; p=$(printf %s "$p" | tr - /)',
  '  [ -d "$p" ] && printf "X\\t1\\n"',
  `  { dd if="$f" bs=${HEAD_BYTES} count=1 2>/dev/null; echo; tail -c ${TAIL_BYTES} "$f" 2>/dev/null; } | awk '${AWK.replace(/'/g, `'\\''`)}'`,
  'done',
].join('\n');

/** The command one exec runs (`sh -c`: the login shell may be fish or csh) */
function remoteCommand(limit = REMOTE_LIMIT) {
  return `sh -c ${sq(REMOTE_SCRIPT)} termilab-claude ${Number(limit) | 0}`;
}

/** Parse the script's output into rows (a record cut by the output cap is dropped) */
function parseRemote(stdout, { truncated = false } = {}) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf-8') : String(stdout || '');
  if (/^NODIR\s*$/m.test(text) && !/^F\t/m.test(text)) return { rows: [], found: false };
  const recs = [];
  let cur = null;
  const lines = text.split('\n');
  /* The last line is complete only if the output ended with \n and was not cut */
  if (truncated || !text.endsWith('\n')) lines.pop();
  for (const line of lines) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const k = line.slice(0, tab);
    const v = line.slice(tab + 1);
    if (k === 'F') {
      const m = /^(\d+)\t(\d+)\t\.\/([^/\t]+)\/([^/\t]+)$/.exec(v);
      cur = m ? { dir: m[3], file: m[4], mtimeMs: Number(m[1]) * 1000, size: Number(m[2]), head: { cwds: [], user: '', title: '', aiTitle: '' } } : null;
      if (cur) recs.push(cur);
    } else if (cur) {
      if (k === 'C' && cur.head.cwds.length < 6) cur.head.cwds.push(v);
      else if (k === 'T' && !cur.head.title) cur.head.title = v;
      else if (k === 'A' && !cur.head.aiTitle) cur.head.aiTitle = v;
      else if (k === 'U' && !cur.head.user) cur.head.user = v;
      else if (k === 'X') cur.naiveExists = true;
    }
  }
  /* With a cut, the last record may be missing its U line: drop it */
  if (truncated && recs.length) recs.pop();
  const rows = recs.map(r => makeRow(r, { decode: (dir) => (r.naiveExists ? naiveDecode(dir) : null) })).filter(Boolean);
  return { rows, found: true };
}

async function listRemote(client, { limit = REMOTE_LIMIT, timeout = REMOTE_TIMEOUT_MS, maxOut = REMOTE_MAX_OUT } = {}) {
  const { run } = require('./keeper-service');
  const r = await run(client, remoteCommand(limit), { timeout, maxOut });
  return parseRemote(r.stdout, { truncated: r.stdout.length >= maxOut });
}

/* ── The service: what the IPC handler calls ── */

class ClaudeHistoryService {
  constructor() {
    this.cache = new Map(); // key → { at, value }
    this.inflight = new Map();
    this.cacheMs = CACHE_MS;
    this.localHome = null;  // the harness points this at a fake HOME
  }

  async _cached(key, fresh, fn) {
    const hit = this.cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < this.cacheMs) return { ...hit.value, cached: true };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const value = await fn();
        this.cache.set(key, { at: Date.now(), value });
        return value;
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, p);
    return p;
  }

  /**
   * target: {kind:'local'} | {kind:'ssh', sessionId}; fresh: skip the cache.
   * → {rows, found, at}. SSH uses that session's client; no connection is made.
   */
  async list(target, { fresh = false } = {}) {
    if (!target || target.kind === 'local') {
      const home = this.localHome || os.homedir();
      return this._cached(`local:${home}`, fresh, async () => ({ ...(await listLocal({ home })), at: Date.now() }));
    }
    if (target.kind !== 'ssh' || typeof target.sessionId !== 'string') throw new Error('Unknown target');
    const sshService = require('./ssh-service');
    const s = sshService.sessions.get(target.sessionId);
    const client = sshService.getClient(target.sessionId);
    if (!s || !client) throw new Error('That terminal is not connected');
    const c = s.config || {};
    const key = `ssh:${c.username || ''}@${c.host || ''}:${c.port || 22}`;
    return this._cached(key, fresh, async () => ({ ...(await listRemote(client)), at: Date.now() }));
  }

  clear() { this.cache.clear(); }
}

const service = new ClaudeHistoryService();
module.exports = service;
module.exports.ClaudeHistoryService = ClaudeHistoryService;
module.exports.scanHead = scanHead;
module.exports.unescapeRaw = unescapeRaw;
module.exports.preview = preview;
module.exports.makeRow = makeRow;
module.exports.resumeCommand = resumeCommand;
module.exports.encodeProject = encodeProject;
module.exports.diskDecode = diskDecode;
module.exports.listLocal = listLocal;
module.exports.listRemote = listRemote;
module.exports.remoteCommand = remoteCommand;
module.exports.parseRemote = parseRemote;
module.exports.REMOTE_SCRIPT = REMOTE_SCRIPT;
