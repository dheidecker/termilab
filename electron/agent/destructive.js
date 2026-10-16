/**
 * Which agent commands are destructive for projects and databases. Owner's
 * rule (option B): an AI agent may run anything through Termilab, EXCEPT
 * these, which wait for the user's explicit "Run once" in Termilab.
 *
 *   classify(command, { host }) -> null | { category, label, reason, match }
 *   classifyDbText(text)        -> same, for text typed into a REPL (send_input)
 *
 * Pure: no I/O, no electron, nothing about the remote side is looked up. It
 * is a shell-aware lexer, not a regex over the line, so it sees through
 * sudo/env/nice/timeout prefixes, `sh -c '…'` / `bash -lc "…"`, `ssh host
 * 'cmd'`, `docker exec` / `kubectl exec`, `eval`, `su -c`, `xargs`, `;` `&&`
 * `||` `|` `&`, newlines, ( ) { } groups, $( ) and backticks, quoting,
 * heredocs and here-strings — and SQL / Mongo / Redis text that reaches a
 * database client through -e/-c/--eval/--execute/--query, a pipe, a heredoc
 * or a here-string.
 *
 * False positives: read-only lookalikes stay quiet (`grep -i drop`, `cat
 * migration.sql`, SQL written to a FILE with a heredoc). When a target cannot
 * be known offline (a variable, a glob, `.`), it counts as destructive: the
 * cost is one click for the user.
 *
 * Known limits (by construction): a script file the agent wrote and then
 * runs (`bash cleanup.sh`, `psql -f drop.sql`, `mysql < drop.sql`), commands
 * built at run time (`$(echo cm0gLXJm | base64 -d)`), aliases/functions, and
 * programs that delete by themselves (a Python one-liner) are not seen.
 */

const CATEGORIES = {
  projects: 'project files or git history',
  databases: 'database drop or wipe',
  'db-reset': 'database reset',
  'data-volumes': 'data volume removal',
};

/* Recursive deletes under these are fine: regenerable or scratch */
const SAFE_NAMES = new Set([
  'node_modules', '.cache', 'dist', 'build', '__pycache__', 'vendor',
  '.next', '.nuxt', '.turbo', '.parcel-cache', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.svelte-kit', 'coverage', '.nyc_output',
]);
const SAFE_FIND_NAMES = /^(__pycache__|node_modules|\.cache|\*\.py[co]|\*\.tmp|\*\.swp|\*~|\.DS_Store)$/;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox']);
const SQL_CLIENTS = new Set(['mysql', 'mariadb', 'psql', 'sqlite3', 'sqlite', 'clickhouse-client', 'clickhouse', 'cockroach', 'duckdb', 'sqlcmd', 'usql', 'pgcli', 'mycli', 'litecli']);
const MONGO_CLIENTS = new Set(['mongosh', 'mongo']);
const REDIS_CLIENTS = new Set(['redis-cli', 'valkey-cli', 'keydb-cli']);
const isDbClient = (c) => SQL_CLIENTS.has(c) || MONGO_CLIENTS.has(c) || REDIS_CLIENTS.has(c);

const base = (w) => {
  const s = String(w || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
};
const hit = (category, reason, match) => ({ category, label: CATEGORIES[category], reason, match: String(match || '').slice(0, 500) });
const isAssign = (w) => /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(w);
const MAX_DEPTH = 8;

// ─── Lexer ────────────────────────────────────────────────

/** End index (exclusive) of a balanced `$( … )` / `( … )` starting at the `(` at i. */
function scanParen(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === "'") { const k = src.indexOf("'", j + 1); if (k < 0) return src.length; j = k; continue; }
    if (c === '"') {
      for (j++; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\') j++;
        else if (src[j] === '$' && src[j + 1] === '(') j = scanParen(src, j + 1) - 1;
      }
      continue;
    }
    if (c === '`') { const k = src.indexOf('`', j + 1); if (k < 0) return src.length; j = k; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return j + 1; }
  }
  return src.length;
}

function ansiC(s) {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, e) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: '\n', t: '\t', r: '\r', e: '\x1b', a: '\x07', '\\': '\\', "'": "'", '"': '"' }[e] ?? e;
  });
}

/**
 * Shell source -> tokens: {t:'w', v} words (quotes removed, $VAR kept as
 * text), {t:'op', v} for ; & && || | |& ( ) newline, {t:'redir'} with its
 * target swallowed, {t:'hd', body} heredocs (body filled at the newline),
 * {t:'hs', v} here-strings. Command substitutions go to `subs` (classified
 * on their own). `incomplete` = an open quote or a trailing backslash.
 */
function lex(src) {
  const tokens = [];
  const subs = [];
  const pendingHd = [];
  let incomplete = false;
  let i = 0;
  const n = src.length;
  let word = null;   // string being built, or null
  let wordStart = true;
  const flush = () => { if (word !== null) { tokens.push({ t: 'w', v: word }); word = null; } };
  const add = (s) => { word = (word || '') + s; };

  const readHeredocs = () => {
    /* i is right after a newline: each pending heredoc takes lines up to its delimiter */
    while (pendingHd.length) {
      const hd = pendingHd.shift();
      const lines = [];
      while (i < n) {
        let e = src.indexOf('\n', i);
        if (e < 0) e = n;
        let line = src.slice(i, e);
        i = e + 1;
        if (hd.strip) line = line.replace(/^\t+/, '');
        if (line.replace(/\r$/, '') === hd.delim) { hd.closed = true; break; }
        lines.push(line);
      }
      hd.body = lines.join('\n');
      if (!hd.quoted) collectSubs(hd.body, subs);
      if (!hd.closed) incomplete = true;
    }
  };

  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      if (i + 1 >= n) { incomplete = true; i++; continue; }
      if (src[i + 1] === '\n') { i += 2; continue; }
      add(src[i + 1]); i += 2; continue;
    }
    if (c === "'") {
      const k = src.indexOf("'", i + 1);
      if (k < 0) { incomplete = true; add(src.slice(i + 1)); i = n; continue; }
      add(src.slice(i + 1, k)); i = k + 1; continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      let k = i + 2;
      while (k < n && src[k] !== "'") { if (src[k] === '\\') k++; k++; }
      if (k >= n) incomplete = true;
      add(ansiC(src.slice(i + 2, Math.min(k, n)))); i = k + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      for (; j < n && src[j] !== '"'; j++) {
        if (src[j] === '\\' && j + 1 < n && '"\\$`\n'.includes(src[j + 1])) { if (src[j + 1] !== '\n') s += src[j + 1]; j++; continue; }
        if (src[j] === '$' && src[j + 1] === '(') {
          const e = scanParen(src, j + 1);
          subs.push(src.slice(j + 2, e - 1));
          s += src.slice(j, e); j = e - 1; continue;
        }
        if (src[j] === '`') {
          let k = src.indexOf('`', j + 1); if (k < 0) k = n;
          subs.push(src.slice(j + 1, k));
          s += src.slice(j, k + 1); j = k; continue;
        }
        s += src[j];
      }
      if (j >= n) incomplete = true;
      add(s); i = j + 1; continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const e = scanParen(src, i + 1);
      subs.push(src.slice(i + 2, e - 1));
      add(src.slice(i, e)); i = e; continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      const k = src.indexOf('}', i + 2);
      const e = k < 0 ? n : k + 1;
      add(src.slice(i, e)); i = e; continue;
    }
    if (c === '`') {
      let k = src.indexOf('`', i + 1);
      if (k < 0) { k = n; incomplete = true; }
      subs.push(src.slice(i + 1, k));
      add(src.slice(i, k + 1)); i = k + 1; continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {   // process substitution
      const e = scanParen(src, i + 1);
      subs.push(src.slice(i + 2, e - 1));
      add(src.slice(i, e)); i = e; continue;
    }
    if (c === '#' && word === null) {
      const e = src.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '\n') {
      flush();
      tokens.push({ t: 'op', v: '\n' });
      i++;
      readHeredocs();
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      /* fd redirections like 2>&1 or >&2 are handled with '>' below */
      flush();
      const two = src.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '|&' || two === ';;') { tokens.push({ t: 'op', v: two === ';;' ? ';' : two }); i += 2; continue; }
      if (two === '&>') { i += 2; if (src[i] === '>') i++; tokens.push({ t: 'redir' }); swallowTarget(); continue; }
      tokens.push({ t: 'op', v: c }); i++; continue;
    }
    if (c === '<' || c === '>') {
      /* a digit-only word right before is the fd number: drop it */
      if (word !== null && /^\d+$/.test(word)) word = null;
      flush();
      if (src.startsWith('<<<', i)) {
        i += 3;
        const v = readWordAt();
        tokens.push({ t: 'hs', v });
        continue;
      }
      if (src.startsWith('<<', i)) {
        i += 2;
        let strip = false;
        if (src[i] === '-') { strip = true; i++; }
        const raw = readRawWordAt();
        const quoted = /['"\\]/.test(raw);
        const delim = raw.replace(/['"\\]/g, '');
        const hd = { t: 'hd', delim, strip, quoted, body: '', closed: false };
        tokens.push(hd);
        pendingHd.push(hd);
        continue;
      }
      i++;
      if (src[i] === '>' || src[i] === '|' || src[i] === '&' || src[i] === '<') i++;
      tokens.push({ t: 'redir' });
      swallowTarget();
      continue;
    }
    add(c); i++;
  }
  flush();
  if (pendingHd.length) { incomplete = true; for (const hd of pendingHd) hd.body = ''; }
  return { tokens, subs, incomplete };

  function skipBlanks() { while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; }
  function readRawWordAt() {
    skipBlanks();
    const s = i;
    while (i < n && !/[\s;&|()<>]/.test(src[i])) {
      if (src[i] === "'" || src[i] === '"') { const k = src.indexOf(src[i], i + 1); i = k < 0 ? n : k + 1; } else i++;
    }
    return src.slice(s, i);
  }
  /* A redirection / here-string operand: lexed like a word, kept apart */
  function readWordAt() {
    skipBlanks();
    const s = i;
    const raw = readRawWordAt();
    i = s + raw.length;
    const sub = lex(raw);
    for (const x of sub.subs) subs.push(x);
    return sub.tokens.filter(t => t.t === 'w').map(t => t.v).join(' ');
  }
  function swallowTarget() { readWordAt(); }
}

function collectSubs(text, out) {
  for (let j = 0; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (text[j] === '$' && text[j + 1] === '(') { const e = scanParen(text, j + 1); out.push(text.slice(j + 2, e - 1)); j = e - 1; } else if (text[j] === '`') {
      const k = text.indexOf('`', j + 1); if (k < 0) break;
      out.push(text.slice(j + 1, k)); j = k;
    }
  }
}

// ─── Parser: list of pipelines of stages ──────────────────

const KEYWORD_PREFIX = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', 'time']);
const KEYWORD_END = new Set(['fi', 'done', 'esac', '}']);

/** tokens -> [{ stages: [{ kind:'simple', words, hds, hss } | { kind:'group', pipelines }] }] */
function parse(tokens) {
  let pos = 0;
  const parseList = (inGroup) => {
    const pipelines = [];
    let stages = [];
    let cur = null;
    const endStage = () => { if (cur && (cur.words.length || cur.hds.length || cur.hss.length)) stages.push(cur); cur = null; };
    const endPipe = () => { endStage(); if (stages.length) pipelines.push({ stages }); stages = []; };
    const stage = () => { if (!cur) cur = { kind: 'simple', words: [], hds: [], hss: [] }; return cur; };
    while (pos < tokens.length) {
      const tk = tokens[pos++];
      if (tk.t === 'w') {
        const s = stage();
        if (!s.words.length && KEYWORD_PREFIX.has(tk.v)) continue;
        if (!s.words.length && KEYWORD_END.has(tk.v)) { endPipe(); continue; }
        s.words.push(tk.v);
      } else if (tk.t === 'hd') stage().hds.push(tk);
      else if (tk.t === 'hs') stage().hss.push(tk.v);
      else if (tk.t === 'redir') stage();
      else if (tk.v === '(') {
        endStage();
        stages.push({ kind: 'group', pipelines: parseList(true) });
      } else if (tk.v === ')') {
        if (inGroup) { endPipe(); return pipelines; }
        endPipe();
      } else if (tk.v === '|' || tk.v === '|&') endStage();
      else endPipe();   // ; & && || newline
    }
    endPipe();
    return pipelines;
  };
  return parseList(false);
}

// ─── Unwrapping prefixes and wrappers ─────────────────────

/* Options of the prefix commands that take a separate value */
const PREFIX_ARGS = {
  sudo: new Set(['-u', '-g', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '-h', '--user', '--group', '--prompt', '--chdir', '--role', '--type', '--host', '--close-from', '--other-user', '--command-timeout']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
  chrt: new Set([]),
  taskset: new Set([]),
  nohup: new Set([]),
  exec: new Set(['-a']),
  command: new Set([]),
  builtin: new Set([]),
  setsid: new Set([]),
  unbuffer: new Set([]),
  flock: new Set(['-w', '-E', '--timeout', '--conflict-exit-code']),
  npx: new Set(['-p', '--package', '-c', '--call']),
  bunx: new Set(['-p', '--package']),
  pnpx: new Set([]),
  xargs: new Set(['-I', '-i', '-n', '-P', '-d', '-L', '-l', '-s', '-E', '-e', '-a', '--delimiter', '--max-args', '--max-procs', '--arg-file', '--max-lines', '--replace', '--eof']),
};

/**
 * Strip prefixes off argv. Returns { words, xargs } where words starts at
 * the real command. Wrappers that take a script (sh -c, ssh, eval, su -c)
 * are left in place for classifyWords to recurse into.
 */
function unwrap(words) {
  let w = words.slice();
  let xargs = false;
  for (let guard = 0; guard < 20 && w.length; guard++) {
    while (w.length && isAssign(w[0])) w.shift();
    if (!w.length) break;
    const cmd = base(w[0]);
    const takes = PREFIX_ARGS[cmd];
    if (!takes) break;
    if (cmd === 'xargs') xargs = true;
    let k = 1;
    /* timeout DURATION, nice -10, chrt PRIO, taskset MASK: one positional before the command */
    const positional = cmd === 'timeout' || cmd === 'chrt' || cmd === 'taskset' || cmd === 'flock';
    let gotPositional = false;
    while (k < w.length) {
      const a = w[k];
      if (a === '--') { k++; break; }
      if (cmd === 'env' && isAssign(a)) { k++; continue; }
      if (a.startsWith('-') && a.length > 1) {
        if (takes.has(a)) { k += 2; continue; }
        if (cmd === 'sudo' && /^-[a-zA-Z]*[ugpCDrtTUh]$/.test(a) && a.length > 2 && !a.startsWith('--')) { k += 2; continue; }
        k++;
        continue;
      }
      if (positional && !gotPositional) { gotPositional = true; k++; continue; }
      break;
    }
    w = w.slice(k);
  }
  while (w.length && isAssign(w[0])) w.shift();
  return { words: w, xargs };
}

/* bash -lc 'script' args… -> the script, or null (no -c: a script file or stdin) */
function shellScript(words) {
  let c = false;
  for (let k = 1; k < words.length; k++) {
    const a = words[k];
    if (a === '--' || a === '-') { k++; if (c && k < words.length) return words[k]; return null; }
    if (/^[-+]o$/.test(a) || a === '--rcfile' || a === '--init-file') { k++; continue; }
    if (/^-[a-zA-Z]+$/.test(a) || /^\+[a-zA-Z]+$/.test(a)) { if (a.startsWith('-') && a.includes('c')) c = true; continue; }
    if (a.startsWith('--')) { if (a === '--command') c = true; continue; }
    return c ? a : null;
  }
  return null;
}

/* ssh [opts] host [command…] -> the remote command line ('' = none) */
const SSH_ARGS = new Set('bcDEeFIiJLlmOoPpQRSWw'.split(''));
function sshRemote(words) {
  let k = 1;
  while (k < words.length) {
    const a = words[k];
    if (a === '--') { k++; break; }
    if (a.startsWith('-') && a.length > 1) {
      const last = a[a.length - 1];
      /* -p 22, -oX=y, -i key; flags like -tt, -A, -vvv */
      if (a.length === 2 && SSH_ARGS.has(last)) { k += 2; continue; }
      if (a.length > 2 && SSH_ARGS.has(a[1]) && !/^-[AaCfGgKkMNnqsTtVvXxYy]+$/.test(a)) { k++; continue; }
      if (/^-[AaCfGgKkMNnqsTtVvXxYy]+$/.test(a) && SSH_ARGS.has(last)) { k += 2; continue; }
      k++;
      continue;
    }
    break;
  }
  if (k >= words.length) return null;   // no host: nothing runs
  const rest = words.slice(k + 1);
  if (rest[0] === '--') rest.shift();
  return rest.join(' ');
}

/* su [opts] [user] -c 'cmd' */
function suCommand(words) {
  for (let k = 1; k < words.length; k++) {
    if (words[k] === '-c' || words[k] === '--command') return words[k + 1] || null;
    if (words[k].startsWith('--command=')) return words[k].slice(10);
  }
  return null;
}

/* The container-runners: docker/podman/nerdctl exec|run, compose exec|run, kubectl exec|run|debug */
const RUNNERS = new Set(['docker', 'podman', 'nerdctl', 'kubectl', 'oc', 'docker-compose', 'podman-compose', 'lxc', 'incus', 'toolbox', 'distrobox']);
function runnerTail(words) {
  const cmd = base(words[0]);
  if (!RUNNERS.has(cmd)) return null;
  const sub = words.findIndex((x, k) => k > 0 && ['exec', 'run', 'debug', 'enter', 'shell'].includes(x));
  if (sub < 0) return null;
  const dd = words.indexOf('--', sub);
  if (dd >= 0) return { from: dd + 1, all: false };
  return { from: sub + 1, all: true };
}

// ─── Rules ────────────────────────────────────────────────

function normalizePath(p) {
  const abs = p.startsWith('/');
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') { out.pop(); continue; }
    if (part === '..' && abs) continue;
    out.push(part);
  }
  return { abs, parts: out };
}

/* null if a recursive delete of `target` is fine, else why not */
function pathRisk(target) {
  const t = String(target || '');
  if (!t.trim()) return 'an empty path';
  const { abs, parts } = normalizePath(t);
  if (!parts.length) return abs ? 'the root directory' : 'the current directory';
  const literal = (s) => !/[*?[\]$`{}~]/.test(s);
  if (abs && (parts[0] === 'tmp' || (parts[0] === 'var' && parts[1] === 'tmp'))) {
    const depth = parts[0] === 'tmp' ? 1 : 2;
    if (parts.length > depth && parts.slice(0, depth).every(literal)) return null;
  }
  if (parts.some(x => literal(x) && SAFE_NAMES.has(x))) return null;
  return `"${t}"`;
}

function gitSub(words) {
  let k = 1;
  while (k < words.length) {
    const a = words[k];
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace' || a === '--exec-path' || a === '--config-env') { k += 2; continue; }
    if (a.startsWith('-')) { k++; continue; }
    break;
  }
  return { sub: words[k], args: words.slice(k + 1) };
}

function shortFlags(args) {
  let s = '';
  for (const a of args) {
    if (a === '--') break;
    if (/^-[a-zA-Z]+$/.test(a)) s += a.slice(1);
  }
  return s;
}

function gitRule(words, line) {
  const { sub, args } = gitSub(words);
  if (sub === 'reset' && args.includes('--hard')) return hit('projects', 'git reset --hard discards uncommitted work', line);
  if (sub === 'clean') {
    const f = shortFlags(args);
    const force = f.includes('f') || args.includes('--force');
    const dry = f.includes('n') || args.includes('--dry-run');
    if (force && !dry && /[xX]/.test(f)) return hit('projects', 'git clean -x deletes untracked and ignored files (.env, data, uploads)', line);
  }
  if (sub === 'push') {
    const f = shortFlags(args);
    const force = f.includes('f') || args.some(a => a === '--force' || a.startsWith('--force-with-lease'));
    const del = f.includes('d') || args.includes('--delete');
    const pos = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '--repo' || a === '-o' || a === '--push-option' || a === '--receive-pack' || a === '--exec') { k++; continue; }
      if (a.startsWith('-')) continue;
      pos.push(a);
    }
    const refs = pos.slice(1);
    const plusRef = refs.some(r => r.startsWith('+'));
    const dstOf = (r) => {
      const x = r.replace(/^\+/, '');
      const d = x.includes(':') ? x.slice(x.indexOf(':') + 1) : x;
      return d.replace(/^refs\/heads\//, '');
    };
    const protectedRef = (r) => ['main', 'master'].includes(dstOf(r)) || (!r.includes(':') && /^\+?(HEAD|@)$/.test(r));
    if (del || refs.some(r => r.startsWith(':'))) {
      if (refs.some(r => ['main', 'master'].includes(dstOf(r)))) return hit('projects', 'deletes the main/master branch on the remote', line);
    }
    if (force || plusRef) {
      if (args.includes('--mirror') || args.includes('--all')) return hit('projects', 'force push of every branch, main/master included', line);
      if (!refs.length && !args.includes('--tags')) return hit('projects', 'force push without naming the branch (it may be main/master)', line);
      const bad = refs.filter(r => (force || r.startsWith('+')) && protectedRef(r));
      if (bad.length) return hit('projects', `force push to ${dstOf(bad[0]) === 'HEAD' || dstOf(bad[0]) === '@' ? 'the current branch (it may be main/master)' : dstOf(bad[0])} rewrites its history`, line);
    }
  }
  return null;
}

function rmRule(words, line, xargs) {
  const cmd = base(words[0]);
  const args = words.slice(1);
  let recursive = cmd === 'rimraf';
  const targets = [];
  let opts = true;
  for (const a of args) {
    if (opts && a === '--') { opts = false; continue; }
    if (opts && a.startsWith('--')) {
      if (a === '--recursive') recursive = true;
      if (a === '--no-preserve-root') return hit('projects', 'rm --no-preserve-root', line);
      continue;
    }
    if (opts && /^-[a-zA-Z]+$/.test(a)) { if (/[rR]/.test(a)) recursive = true; continue; }
    targets.push(a);
  }
  if (!recursive) return null;
  if (!targets.length) return xargs ? hit('projects', 'recursive delete of paths read from input', line) : null;
  for (const tg of targets) {
    const why = pathRisk(tg);
    if (why) return hit('projects', `recursive delete of ${why}`, line);
  }
  return null;
}

function findRule(words, line) {
  const args = words.slice(1);
  let k = 0;
  const starts = [];
  while (k < args.length && !/^[-!(),]/.test(args[k])) starts.push(args[k++]);
  const expr = args.slice(k);
  let deletes = expr.includes('-delete');
  for (let j = 0; j < expr.length; j++) {
    if (['-exec', '-execdir', '-ok', '-okdir'].includes(expr[j])) {
      const c = base(expr[j + 1]);
      if (c === 'rm' || c === 'rimraf' || c === 'unlink' || c === 'shred') deletes = true;
      else if (c === 'sudo' && base(expr[j + 2]) === 'rm') deletes = true;
    }
  }
  if (!deletes) return null;
  for (let j = 0; j < expr.length; j++) {
    if (['-name', '-iname'].includes(expr[j]) && SAFE_FIND_NAMES.test(expr[j + 1] || '') && !expr.includes('-o') && !expr.includes('-or')) return null;
  }
  for (const s of starts.length ? starts : ['.']) {
    const why = pathRisk(s);
    if (why) return hit('projects', `find … deleting under ${why}`, line);
  }
  return null;
}

/* SQL statements: DROP DATABASE|SCHEMA|TABLE, TRUNCATE, DELETE FROM without a real WHERE */
function splitSql(text) {
  const s = String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)--[^\n]*/g, '$1');
  const out = [];
  let cur = '';
  let q = null;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (q) { cur += c; if (c === q) { if (s[j + 1] === q) { cur += s[++j]; } else q = null; } continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === ';') { out.push(cur); cur = ''; continue; }
    if (c === '\n' && /^\s*\\/.test(s.slice(j + 1))) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(x => x.replace(/^\s*\\\S+[^\n]*\n?/, '').trim()).filter(Boolean);
}

function sqlHit(text) {
  for (const st of splitSql(text)) {
    /* At the start of the statement or of one of its lines (printf '%s\n' 'DROP …' feeds a format first) */
    const m = st.match(/(?:^|\n)\s*(DROP\s+(?:DATABASE|SCHEMA|TABLES?)\b|TRUNCATE\b|DELETE\s+FROM\b)/i);
    if (!m) continue;
    const kw = m[1].toUpperCase().replace(/\s+/g, ' ');
    if (kw.startsWith('DELETE')) {
      const w = st.slice(m.index).match(/\bWHERE\b([\s\S]*)$/i);
      if (w && !/^\s*(1\s*=\s*1|true|1|'1'\s*=\s*'1')\s*$/i.test(w[1])) continue;
      return { reason: w ? 'DELETE FROM with an always-true WHERE' : 'DELETE FROM without WHERE', stmt: st };
    }
    return { reason: `SQL ${kw.startsWith('DROP') ? kw.replace(/S$/, '') : 'TRUNCATE'}`, stmt: st };
  }
  return null;
}

function mongoHit(text) {
  const s = String(text);
  const m = s.match(/\.dropDatabase\s*\(|\.drop\s*\(\s*\)|\.(deleteMany|remove)\s*\(\s*\{\s*\}\s*\)/);
  return m ? { reason: `Mongo ${m[0].replace(/\s+/g, '')}`, stmt: s.slice(Math.max(0, m.index - 60), m.index + m[0].length + 10).trim() } : null;
}

function redisHit(text) {
  const m = String(text).match(/(^|[\s;"'])(FLUSHALL|FLUSHDB)\b/i);
  return m ? { reason: `Redis ${m[2].toUpperCase()}`, stmt: m[2] } : null;
}

/** Text that reaches a database (an -e/-c argument, a heredoc, a pipe, a REPL line) */
function classifyDbText(text) {
  if (!text || !String(text).trim()) return null;
  const h = sqlHit(text) || mongoHit(text) || redisHit(text);
  return h ? hit('databases', h.reason, h.stmt) : null;
}

function dbClientRule(words, line) {
  const cmd = base(words[0]);
  const args = words.slice(1);
  if (REDIS_CLIENTS.has(cmd)) {
    /* The first positional argument is the Redis command */
    const withValue = new Set(['-h', '-p', '-s', '-a', '-u', '-r', '-i', '-n', '-d', '-D', '--user', '--pass', '--cacert', '--cacertdir', '--cert', '--key', '--sni', '--tls-ciphers', '--tls-ciphersuites']);
    for (let k = 0; k < args.length; k++) {
      if (withValue.has(args[k])) { k++; continue; }
      if (args[k].startsWith('-')) continue;
      return /^(FLUSHALL|FLUSHDB)$/i.test(args[k]) ? hit('databases', `Redis ${args[k].toUpperCase()}`, line) : null;
    }
    return null;
  }
  for (const a of args) {
    const v = a.includes('=') && a.startsWith('--') ? a.slice(a.indexOf('=') + 1) : a.replace(/^-[ecq](?=\S)/, '');
    const h = MONGO_CLIENTS.has(cmd) ? (mongoHit(v) || sqlHit(v)) : sqlHit(v);
    if (h) return hit('databases', h.reason, line);
  }
  return null;
}

const FRAMEWORK = [
  { tool: (c) => c === 'artisan', subs: /^(migrate:fresh|migrate:refresh|migrate:reset|db:wipe)$/, name: 'Laravel' },
  { tool: (c) => c === 'rails' || c === 'rake', subs: /^db:(drop(:all|:_unsafe)?|reset|schema:load|structure:load|purge(:all)?|migrate:reset|truncate_all|seed:replant)$/, name: 'Rails' },
  { tool: (c) => c === 'manage.py' || c === 'django-admin' || c === 'django-admin.py', subs: /^(flush|reset_db)$/, name: 'Django' },
  { tool: (c) => c === 'sequelize' || c === 'sequelize-cli', subs: /^(db:drop|db:migrate:undo:all)$/, name: 'Sequelize' },
  { tool: (c) => /^typeorm/.test(c), subs: /^schema:drop$/, name: 'TypeORM' },
];

function frameworkRule(words, line) {
  const names = words.map(base);
  for (const f of FRAMEWORK) {
    const at = names.findIndex(f.tool);
    if (at < 0) continue;
    const sub = words.slice(at + 1).find(x => f.subs.test(x));
    if (sub) return hit('db-reset', `${f.name} ${sub} wipes the database`, line);
  }
  const pr = names.indexOf('prisma');
  if (pr >= 0) {
    const rest = words.slice(pr + 1);
    if (rest[0] === 'migrate' && rest[1] === 'reset') return hit('db-reset', 'prisma migrate reset wipes the database', line);
    if (rest[0] === 'db' && rest[1] === 'push' && rest.includes('--force-reset')) return hit('db-reset', 'prisma db push --force-reset wipes the database', line);
  }
  const kx = names.indexOf('knex');
  if (kx >= 0 && words.slice(kx + 1).includes('migrate:rollback') && words.includes('--all')) return hit('db-reset', 'knex migrate:rollback --all undoes every migration', line);
  return null;
}

function volumeRule(words, line) {
  const cmd = base(words[0]);
  const isEngine = cmd === 'docker' || cmd === 'podman' || cmd === 'nerdctl';
  const isCompose = cmd === 'docker-compose' || cmd === 'podman-compose' || (isEngine && words.includes('compose'));
  if (isEngine) {
    const v = words.indexOf('volume');
    if (v > 0 && !words.includes('compose')) {
      const sub = words.slice(v + 1).find(x => !x.startsWith('-'));
      if (['rm', 'remove', 'prune'].includes(sub)) return hit('data-volumes', `${cmd} volume ${sub} deletes the data in those volumes`, line);
    }
    const s = words.indexOf('system');
    if (s > 0 && words[s + 1] === 'prune' && words.includes('--volumes')) return hit('data-volumes', `${cmd} system prune --volumes deletes unused volumes and their data`, line);
  }
  if (isCompose) {
    const d = words.indexOf('down');
    if (d > 0) {
      const after = words.slice(d + 1);
      if (after.includes('--volumes') || after.some(a => /^-[a-zA-Z]*v[a-zA-Z]*$/.test(a))) return hit('data-volumes', 'compose down -v deletes the project\'s volumes and their data', line);
    }
  }
  return null;
}

// ─── Walking the tree ─────────────────────────────────────

/* What a stage does with its stdin: 'shell' (runs it), 'db' (sends it to a database) or null */
function stdinKind(words, depth) {
  if (depth > MAX_DEPTH) return null;
  const { words: w } = unwrap(words);
  if (!w.length) return null;
  const cmd = base(w[0]);
  if (SHELLS.has(cmd)) {
    if (shellScript(w) !== null) return null;
    const file = w.slice(1).find(a => !a.startsWith('-') && !a.startsWith('+'));
    return file ? null : 'shell';
  }
  if (isDbClient(cmd)) return 'db';
  if (cmd === 'ssh') {
    const remote = sshRemote(w);
    if (remote === null) return null;
    if (!remote.trim()) return 'shell';
    const tree = parse(lex(remote).tokens);
    const first = tree[0] && tree[0].stages[0];
    return first && first.kind === 'simple' ? stdinKind(first.words, depth + 1) : null;
  }
  if (cmd === 'su' || cmd === 'sudo' || cmd === 'doas') return suCommand(w) === null && w.length <= 3 ? 'shell' : null;
  const tail = runnerTail(w);
  if (tail) {
    for (let k = tail.from; k < w.length; k++) {
      const c = base(w[k]);
      if (isDbClient(c)) return 'db';
      if (SHELLS.has(c)) return shellScript(w.slice(k)) === null ? 'shell' : null;
    }
  }
  return null;
}

/* The text a stage writes to stdout that we can see: echo/printf arguments, heredocs, here-strings */
function feedOf(stage) {
  if (stage.kind === 'group') return stage.pipelines.map(p => p.stages.map(feedOf).join('\n')).join('\n');
  const parts = [...stage.hds.map(h => h.body), ...stage.hss];
  const { words } = unwrap(stage.words);
  const cmd = base(words[0]);
  if (cmd === 'echo' || cmd === 'printf') {
    const args = words.slice(1).filter((a, k) => !(k === 0 && /^-[neE]+$/.test(a)));
    parts.push(args.join(' ').replace(/\\n/g, '\n'));
  }
  return parts.join('\n');
}

function classifyWords(words, ctx, depth) {
  if (depth > MAX_DEPTH) return null;
  const line = words.join(' ');
  const { words: w, xargs } = unwrap(words);
  if (!w.length) return null;
  const cmd = base(w[0]);
  const isX = xargs || ctx.xargs;

  if (SHELLS.has(cmd)) {
    const script = shellScript(w);
    return script === null ? null : classifyScript(script, depth + 1);
  }
  if (cmd === 'eval') return classifyScript(w.slice(1).join(' '), depth + 1);
  if (cmd === 'watch') {
    let k = 1;
    while (k < w.length && w[k].startsWith('-')) k += (w[k] === '-n' || w[k] === '--interval') ? 2 : 1;
    return classifyScript(w.slice(k).join(' '), depth + 1);
  }
  if (cmd === 'su') {
    const c = suCommand(w);
    return c === null ? null : classifyScript(c, depth + 1);
  }
  if (cmd === 'ssh') {
    const remote = sshRemote(w);
    return remote ? classifyScript(remote, depth + 1) : null;
  }
  const tail = runnerTail(w);
  if (tail) {
    const own = volumeRule(w, line);
    if (own) return own;
    for (let k = tail.from; k < w.length; k++) {
      if (w[k].startsWith('-')) continue;
      const r = classifyWords(w.slice(k), ctx, depth + 1);
      if (r) return r;
      if (!tail.all) break;
    }
    return null;
  }

  if (cmd === 'rm' || cmd === 'rimraf') return rmRule(w, line, isX);
  if (cmd === 'find') return findRule(w, line);
  if (cmd === 'git') return gitRule(w, line);
  if (cmd === 'dropdb') {
    if (w.slice(1).some(a => a === '--help' || a === '-?' || a === '--version' || a === '-V')) return null;
    return hit('databases', 'dropdb deletes a PostgreSQL database', line);
  }
  if (cmd === 'mysqladmin') {
    if (w.slice(1).some(a => /^drop$/i.test(a))) return hit('databases', 'mysqladmin drop deletes a database', line);
    return null;
  }
  if (isDbClient(cmd)) {
    const r = dbClientRule(w, line);
    if (r) return r;
  }
  if (cmd === 'docker' || cmd === 'podman' || cmd === 'nerdctl' || cmd === 'docker-compose' || cmd === 'podman-compose') return volumeRule(w, line);
  return frameworkRule(w, line);
}

function classifyTree(pipelines, depth) {
  for (const p of pipelines) {
    for (let s = 0; s < p.stages.length; s++) {
      const st = p.stages[s];
      if (st.kind === 'group') {
        const r = classifyTree(st.pipelines, depth + 1);
        if (r) return r;
        continue;
      }
      const r = classifyWords(st.words, { xargs: false }, depth);
      if (r) return r;
      /* What this stage reads: its own heredocs / here-strings, plus what earlier stages print into the pipe */
      const kind = st.words.length ? stdinKind(st.words, depth) : null;
      if (kind) {
        const own = [...st.hds.map(h => h.body), ...st.hss];
        const piped = p.stages.slice(0, s).map(feedOf);
        const text = [...piped, ...own].join('\n');
        const r2 = kind === 'db' ? classifyDbText(text) : classifyScript(text, depth + 1);
        if (r2) return { ...r2, match: r2.match || st.words.join(' ') };
      }
    }
  }
  return null;
}

function classifyScript(src, depth = 0) {
  if (depth > MAX_DEPTH || typeof src !== 'string' || !src.trim()) return null;
  const { tokens, subs } = lex(src);
  for (const sub of subs) {
    const r = classifyScript(sub, depth + 1);
    if (r) return r;
  }
  return classifyTree(parse(tokens), depth);
}

/**
 * Is this command line destructive for projects or databases?
 * null, or { category, label, reason, match }.
 */
// eslint-disable-next-line no-unused-vars
function classify(command, { host } = {}) {
  try {
    return classifyScript(String(command || ''), 0);
  } catch (_) {
    /* A lexer bug must never let a command through unseen, nor crash the call */
    return hit('projects', 'Termilab could not analyse this command', command);
  }
}

/** True while `src` ends inside an open quote, heredoc or line continuation (send_input buffering). */
function isIncomplete(src) {
  try { return lex(String(src || '')).incomplete; } catch (_) { return false; }
}

module.exports = { classify, classifyDbText, isIncomplete, CATEGORIES, SAFE_NAMES };
