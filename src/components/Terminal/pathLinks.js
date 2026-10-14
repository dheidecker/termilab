/*
 * File paths in terminal output (pure: no xterm, no DOM, no React).
 *
 * findPaths(text) → [{ start, end, path, line, col }] over ONE logical line
 * (wrapped rows already joined). `start`/`end` are string offsets of what
 * gets underlined (the `:12:5` / `(12,5)` suffix is part of it, like VS
 * Code); `path` is the path as printed (relative, ~/, or absolute); line and
 * col are numbers or null.
 *
 * What counts, and why it is this strict: a false positive costs a
 * "File not found" toast on a Ctrl+click, but an underline on half the words
 * of every line is noise. So:
 *  - URLs are masked first (WebLinksAddon's job), and so is `host:path`.
 *  - A path with a slash: absolute needs two segments or an extension
 *    (`/help`, Claude Code's slash commands, are not files); a bare relative
 *    one needs an extension, a :line, or two slashes (`and/or`, `TCP/IP`,
 *    `w/o`, `src/x` are prose).
 *  - A name without a slash only with a :line (`main.c:10:5`, Java's
 *    `Foo.java:12`) or in a context that says it is a file: Claude Code's
 *    tool lines (`⏺ Update(README.md)`), git status, Python tracebacks.
 *  - Something must be a letter: dates (2026/10/14), versions (1.2.3),
 *    fractions and IPs never match; an "extension" must contain a letter.
 */

const PATH_CH = '[\\p{L}\\p{M}\\p{N}_.\\/~@%+\\-\\[\\]]';
const TOKEN_RE = new RegExp(`${PATH_CH}+`, 'gu');
const LETTER_RE = /\p{L}/u;
const EXT_RE = /\.([\p{L}\p{N}_+-]{1,12})$/u;
const URL_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>`]*|\bwww\.[^\s"'<>`]*/g;
/* A slash-less "name.ext:12" that is really host:port */
const TLDS = new Set(['com', 'net', 'org', 'edu', 'gov', 'io', 'co', 'cl', 'uk', 'de', 'fr', 'es', 'me', 'ai',
  'info', 'biz', 'us', 'ar', 'mx', 'br', 'local', 'lan', 'internal', 'localdomain']);

const TOOL_RE = /(?<![\w.$])(Read|Write|Edit|Update|MultiEdit|NotebookEdit|NotebookRead|Create|View)\(([^()\n]{1,400})\)/gu;
const PY_RE = /\bFile "([^"\n]{1,1000})", line (\d+)/gu;
const GIT_LONG_RE = /^(\s*(?:modified|new file|deleted|renamed|copied|typechange|both modified|both added|both deleted|deleted by us|deleted by them|added by us|added by them):\s+)(.+?)\s*$/u;
const GIT_SHORT_RE = /^([ MADRCUT?!]{2}) (\S.*)$/u;

/** Extension of the last segment, if it has one with a letter in it. */
function extOf(p) {
  const base = p.replace(/\/+$/, '').split('/').pop() || '';
  const m = EXT_RE.exec(base);
  if (!m || !LETTER_RE.test(m[1])) return null;
  return m[1].toLowerCase();
}

/** Line/column right after the path: `:12`, `:12:5`, `(12,5)`, ` (line 12)`, `, line 12`. */
function suffixAt(text, i) {
  const rest = text.slice(i, i + 40);
  let m = /^:(\d{1,7})(?::(\d{1,5}))?/.exec(rest);
  if (m) return { len: m[0].length, line: +m[1], col: m[2] ? +m[2] : null, inLink: true };
  m = /^\((\d{1,7})(?:,\s?(\d{1,5}))?\)/.exec(rest);
  if (m) return { len: m[0].length, line: +m[1], col: m[2] ? +m[2] : null, inLink: true };
  m = /^,? \(?(?:line|on line|at line) (\d{1,7})(?:,? col(?:umn)? (\d{1,5}))?\)?/i.exec(rest);
  if (m) return { len: m[0].length, line: +m[1], col: m[2] ? +m[2] : null, inLink: false };
  return null;
}

/** Is `p` (as printed, already trimmed) a path we underline? */
function looksLikePath(p, hasLine) {
  if (!p || p.length > 1024 || !LETTER_RE.test(p)) return false;
  if (p.includes('//') || /\s/.test(p)) return false;
  const ext = extOf(p);
  if (p.startsWith('~')) return p.startsWith('~/') && p.length > 2;
  if (/^\.\.?\//.test(p)) return p.replace(/^(\.\.?\/)+/, '').length > 0;
  const segs = p.split('/').filter(Boolean);
  if (p.startsWith('/')) return segs.length >= 2 || !!ext || hasLine;
  if (p.includes('/')) {
    if (ext || hasLine) return true;
    const slashes = (p.replace(/\/+$/, '').match(/\//g) || []).length;
    return slashes >= 2 && segs.every(s => /^[\p{L}_.@]/u.test(s));
  }
  /* No slash: only with a line number, a real extension, and not host:port */
  return hasLine && !!ext && !TLDS.has(ext) && /^[\p{L}_.]/u.test(p);
}

/** Trim what a sentence or a bracket put around a token. */
function trimToken(tok, start) {
  let s = tok;
  let off = start;
  while (/^[-+]/.test(s)) { s = s.slice(1); off += 1; }
  for (;;) {
    const before = s;
    if (/[.]$/.test(s) && !/(^|\/)\.\.?$/.test(s)) s = s.slice(0, -1);
    const opens = (s.match(/\[/g) || []).length;
    const closes = (s.match(/\]/g) || []).length;
    if (closes > opens && s.endsWith(']')) s = s.slice(0, -1);
    if (opens > closes && s.startsWith('[')) { s = s.slice(1); off += 1; }
    if (s === before) break;
  }
  return { s, off };
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

function pushSpecial(out, text, start, rawPath, line = null, col = null) {
  let p = rawPath;
  let off = start;
  const lead = p.length - p.trimStart().length;
  p = p.trim();
  off += lead;
  if (!p || p.length > 1024 || /[\n"<>|*?{}$`;=]/.test(p) || !LETTER_RE.test(p)) return;
  if (p.startsWith('~') && !p.startsWith('~/')) return;
  let end = off + p.length;
  let l = line;
  let c = col;
  if (l == null) {
    const suf = suffixAt(text, end);
    if (suf) { l = suf.line; c = suf.col; if (suf.inLink) end += suf.len; }
  }
  out.push({ start: off, end, path: p, line: l, col: c });
}

function specials(text) {
  const out = [];
  for (const m of text.matchAll(TOOL_RE)) {
    let inner = m[2];
    let base = m.index + m[1].length + 1;
    const fp = /file_path:\s*"([^"]+)"/.exec(inner);
    if (fp) { base += fp.index + fp[0].indexOf('"') + 1; inner = fp[1]; }
    else {
      /* "src/x.js · lines 1-40", "x.md, offset: 20" → the path part */
      const cut = inner.search(/ · |, |\s+\(/);
      if (cut > 0) inner = inner.slice(0, cut);
      if (/^\s*-/.test(inner) || /:\s/.test(inner)) continue;
    }
    pushSpecial(out, text, base, inner);
  }
  for (const m of text.matchAll(PY_RE)) {
    pushSpecial(out, text, m.index + 6, m[1], +m[2], null);
  }
  let m = GIT_LONG_RE.exec(text);
  if (m) {
    const body = m[2].replace(/\s+\((?:new commits|modified content|untracked content)[^)]*\)$/, '');
    let at = m[1].length;
    for (const part of body.split(' -> ')) {
      if (looksLikeFileName(part)) pushSpecial(out, text, at, part);
      at += part.length + 4;
    }
  } else if ((m = GIT_SHORT_RE.exec(text)) && /[MADRCUT?!]/.test(m[1])) {
    let at = 3;
    for (const part of m[2].split(' -> ')) {
      if (!/\s/.test(part) && looksLikeFileName(part)) pushSpecial(out, text, at, part);
      at += part.length + 4;
    }
  }
  return out;
}

/** A git-status entry: a slash, an extension, or a dotfile. */
function looksLikeFileName(p) {
  const s = p.trim();
  if (!s || !LETTER_RE.test(s)) return false;
  return s.includes('/') || !!extOf(s) || /^\.[\p{L}\p{N}_-]/u.test(s);
}

/**
 * Paths in one logical terminal line.
 * @param {string} text
 * @returns {{start:number,end:number,path:string,line:number|null,col:number|null}[]}
 */
export function findPaths(text) {
  if (!text || typeof text !== 'string') return [];
  const masked = [];
  for (const m of text.matchAll(URL_RE)) masked.push({ start: m.index, end: m.index + m[0].length });
  const found = specials(text).filter(f => !masked.some(u => overlaps(u, f)));
  for (const m of text.matchAll(TOKEN_RE)) {
    const { s, off } = trimToken(m[0], m.index);
    if (!s) continue;
    const prev = text[off - 1] || '';
    const prev2 = text[off - 2] || '';
    /* host:path (scp, git@github.com:org/repo.git), $VAR/x, and a path glued
       to a word by ':' are not ours. A drive letter is (C:\ is not handled). */
    if (prev === '$' || prev === '\\') continue;
    if (prev === ':' && prev2 && !/\s/.test(prev2)) continue;
    let end = off + s.length;
    const suf = suffixAt(text, end);
    if (!looksLikePath(s, !!suf)) continue;
    if (suf && suf.inLink) end += suf.len;
    const item = { start: off, end, path: s, line: suf ? suf.line : null, col: suf ? suf.col : null };
    if (masked.some(u => overlaps(u, item))) continue;
    if (found.some(f => overlaps(f, item))) continue;
    found.push(item);
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * The directory in an OSC 7 report (`file://host/path`, percent-encoded;
 * kitty's `kitty-shell-cwd://host/path` too) → { host, path } or null.
 */
export function parseOsc7(data) {
  const m = /^(?:file|kitty-shell-cwd):\/\/([^/]*)(\/.*)$/.exec(String(data || ''));
  if (!m) return null;
  let p;
  try { p = decodeURIComponent(m[2]); } catch (_) { return null; }
  if (!p.startsWith('/') || p.includes('\0')) return null;
  return { host: m[1] || '', path: p };
}

/**
 * Text of one logical line around buffer row `y` (0-based) and, for each
 * string index, the 1-based cell {x, y} it starts at. Wrapped rows are
 * joined; wide characters take two cells and map to the first.
 * `buffer` is xterm's IBuffer (only getLine / isWrapped / getCell / getChars
 * / getWidth are used), `cols` the terminal width.
 */
export function logicalLine(buffer, y, cols) {
  let top = y;
  while (top > 0 && buffer.getLine(top)?.isWrapped) top--;
  let bottom = y;
  while (buffer.getLine(bottom + 1)?.isWrapped && bottom - top < 50) bottom++;
  let text = '';
  const cells = [];
  for (let row = top; row <= bottom; row++) {
    const line = buffer.getLine(row);
    if (!line) break;
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      const w = cell.getWidth();
      if (w === 0) continue;
      const ch = cell.getChars() || ' ';
      for (let k = 0; k < ch.length; k++) cells.push({ x: x + 1, y: row + 1, w });
      text += ch;
    }
  }
  return { text, cells, top, bottom };
}

/** {start, end} buffer range (1-based, inclusive) of string span [s, e). */
export function spanRange(cells, s, e) {
  const a = cells[s];
  const b = cells[e - 1];
  if (!a || !b) return null;
  return { start: { x: a.x, y: a.y }, end: { x: b.x + b.w - 1, y: b.y } };
}
