/*
 * Paths, names and formatting for the SFTP screen.
 *
 * Remote paths are always POSIX. Local ones follow this computer: '\' and a
 * drive root on Windows, '/' elsewhere. `kind` is 'local' | 'remote'.
 */

const IS_WIN_LOCAL = typeof window !== 'undefined' && window.electronAPI?.platform === 'win32';

export const sepFor = (kind) => (kind === 'local' && IS_WIN_LOCAL ? '\\' : '/');

export function isRoot(kind, p) {
  if (kind === 'local' && IS_WIN_LOCAL) return /^[A-Za-z]:\\?$/.test(p) || p === '\\';
  return p === '/';
}

export function joinPath(kind, dir, name) {
  const sep = sepFor(kind);
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export function parentPath(kind, p) {
  if (isRoot(kind, p)) return p;
  const sep = sepFor(kind);
  const trimmed = p.endsWith(sep) ? p.slice(0, -1) : p;
  const i = trimmed.lastIndexOf(sep);
  if (kind === 'local' && IS_WIN_LOCAL) {
    const parent = trimmed.slice(0, i);
    return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent || trimmed;
  }
  return i <= 0 ? '/' : trimmed.slice(0, i);
}

export function baseName(kind, p) {
  const sep = sepFor(kind);
  const trimmed = p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
  return trimmed.slice(trimmed.lastIndexOf(sep) + 1) || trimmed;
}

/** Breadcrumb segments: [{label, path}], root first. */
export function segments(kind, p) {
  if (!p) return [];
  const sep = sepFor(kind);
  if (kind === 'local' && IS_WIN_LOCAL) {
    const m = p.match(/^([A-Za-z]:)\\?/);
    const root = m ? `${m[1]}\\` : '\\';
    const rest = p.slice(m ? m[0].length : 1).split(sep).filter(Boolean);
    const out = [{ label: m ? m[1] : '\\', path: root }];
    let acc = root;
    for (const part of rest) { acc = joinPath(kind, acc, part); out.push({ label: part, path: acc }); }
    return out;
  }
  const out = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of p.split('/').filter(Boolean)) {
    acc = `${acc}/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

/** What a user typed in the path box → absolute path, or null. `~` = home. */
export function normalizeTyped(kind, text, home) {
  let t = (text || '').trim();
  if (!t) return null;
  if (t === '~' && home) return home;
  if (t.startsWith('~/') && home) t = joinPath(kind, home, t.slice(2));
  if (kind === 'local' && IS_WIN_LOCAL) return /^[A-Za-z]:/.test(t) || t.startsWith('\\') ? t : null;
  if (!t.startsWith('/')) return null;
  // collapse "//", "/./" and resolve ".." textually
  const parts = [];
  for (const seg of t.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

/** One path segment, the same rule main applies. '' when fine, else why not. */
export function nameProblem(kind, name) {
  if (!name || !name.trim()) return 'A name is required.';
  if (name === '.' || name === '..') return `"${name}" is not a valid name.`;
  if (name.includes('/') || (kind === 'local' && IS_WIN_LOCAL && name.includes('\\'))) return 'A name cannot contain "/".';
  if (name.includes('\0')) return 'Invalid character.';
  return '';
}

export const isDirLike = (e) => e && (e.type === 'directory' || (e.type === 'symlink' && e.linkType === 'directory'));

// ─── Formatting ────────────────────────────────────────────

export function formatSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString(undefined, {
    year: sameYear ? undefined : 'numeric',
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 1) return '<1s';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

// ─── Kinds and icons ───────────────────────────────────────

const GROUPS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'heic'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'deb', 'rpm', 'iso', 'dmg', 'jar'],
  code: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'php', 'sh', 'bash', 'zsh', 'fish', 'lua', 'pl', 'swift', 'cs', 'sql', 'html', 'css', 'scss', 'vue', 'json', 'yml', 'yaml', 'toml', 'xml', 'ini', 'conf', 'cfg', 'env', 'dockerfile', 'makefile'],
  text: ['txt', 'md', 'log', 'csv', 'tsv', 'rst', 'pem', 'pub', 'key', 'crt'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'webm'],
  pdf: ['pdf'],
};
const BY_EXT = {};
for (const [group, exts] of Object.entries(GROUPS)) for (const e of exts) BY_EXT[e] = group;

const KIND_LABEL = {
  image: 'Image', archive: 'Archive', code: 'Source code', text: 'Text document',
  audio: 'Audio', video: 'Video', pdf: 'PDF document',
};

export function extOf(name) {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile') return lower;
  const i = lower.lastIndexOf('.');
  return i > 0 ? lower.slice(i + 1) : '';
}

/** 'folder' | 'folder-link' | 'link' | 'image' | 'archive' | 'code' | 'text' | 'exec' | 'file' … */
export function iconKind(e) {
  if (e.type === 'directory') return 'folder';
  if (e.type === 'symlink') return e.linkType === 'directory' ? 'folder-link' : 'link';
  const group = BY_EXT[extOf(e.name)];
  if (group) return group;
  if (e.type === 'file' && (e.mode & 0o111)) return 'exec';
  return 'file';
}

export function kindLabel(e) {
  if (e.type === 'directory') return 'Folder';
  if (e.type === 'symlink') return e.linkType === 'directory' ? 'Link to folder' : e.linkType === 'broken' ? 'Broken link' : 'Link';
  if (e.type === 'other') return 'Special file';
  const ext = extOf(e.name);
  const group = BY_EXT[ext];
  if (group) return ext && group !== 'text' && group !== 'code' ? `${ext.toUpperCase()} ${KIND_LABEL[group].toLowerCase()}` : KIND_LABEL[group];
  if (e.mode & 0o111) return 'Executable';
  return ext ? `${ext.toUpperCase()} file` : 'File';
}

/** Files that "Edit" makes sense for: text-ish by extension, or no extension and small. */
export function isEditable(e) {
  if (!e || e.type === 'directory' || isDirLike(e)) return false;
  const group = BY_EXT[extOf(e.name)];
  if (group === 'code' || group === 'text') return true;
  return !extOf(e.name) && (e.size == null || e.size < 5 * 1024 * 1024);
}

// ─── Permissions ───────────────────────────────────────────

export const modeToOctal = (mode) => ((mode ?? 0) & 0o777).toString(8).padStart(3, '0');

export function permString(mode) {
  const bits = 'rwxrwxrwx';
  let out = '';
  for (let i = 0; i < 9; i++) out += (mode & (0o400 >> i)) ? bits[i] : '-';
  return out;
}

// ─── Sorting ───────────────────────────────────────────────

const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;
const cmpName = (a, b) => (collator ? collator.compare(a.name, b.name) : a.name.localeCompare(b.name));

/** Folders first always; then by key; ties by name. */
export function sortEntries(list, key, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => {
    const da = isDirLike(a) ? 0 : 1;
    const db = isDirLike(b) ? 0 : 1;
    if (da !== db) return da - db;
    let r = 0;
    if (key === 'modifyTime') r = (a.modifyTime || 0) - (b.modifyTime || 0);
    else if (key === 'size') r = (a.size || 0) - (b.size || 0);
    else if (key === 'kind') r = kindLabel(a).localeCompare(kindLabel(b));
    if (r === 0) r = cmpName(a, b);
    return r * sign;
  });
}
