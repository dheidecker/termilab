/*
 * Images into a terminal, for an agent CLI running there (Claude Code,
 * Codex) that reads images by path: drop image files on a pane, or paste an
 * image from the clipboard, and its path is typed at the prompt.
 *
 *  - Local tab: a file with a path on disk is typed as is; bytes without a
 *    path (clipboard, an image dragged out of a browser) are saved first to
 *    ~/.termilab/uploads by main (attach:save-local).
 *  - SSH tab: uploaded over SFTP on that tab's own connection to
 *    ~/.termilab/uploads on the server (attach:upload), then the absolute
 *    remote path is typed. Nothing is typed when an upload fails.
 *
 * Typing is term.paste() (bracketed paste where the program asked for it),
 * never with Enter. Desktop only: Android has no drag & drop here and its
 * shim leaves `electronAPI.attach` out.
 */
import { DRAG_MIME } from '../SplitPane/dragState';
import { liveSessionId } from '../SplitPane/sessions';
import { IS_WEB } from '../../platform';

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_ITEMS = 10;
export const ONLY_IMAGES = 'Only images can be attached';

const api = () => (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.attach) || null;
export const canAttach = () => !!api();

/** A drag from the OS (files), not one of ours (panes, tabs, SFTP rows). */
export function isFilesDrag(e) {
  const types = [...((e && e.dataTransfer && e.dataTransfer.types) || [])];
  return types.includes('Files') && !types.includes(DRAG_MIME);
}

/** POSIX shell word: as is when plain, else single-quoted. */
export function shellQuote(p) {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(p) && !p.startsWith('~')) return p;
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

const extOf = (name) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
};

/** File | {png, mime, name} → {name, size, mime, path|null, file|null, data|null} */
function normalize(item) {
  if (typeof File !== 'undefined' && item instanceof File) {
    let p = null;
    try { p = api()?.pathForFile(item) || null; } catch (_) { p = null; }
    return { name: item.name || 'image', size: item.size, mime: item.type || '', path: p, file: item, data: null };
  }
  const data = item.png || item.data || null;
  const mime = item.mime || 'image/png';
  const name = item.name || `clip.${mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] || 'png')}`;
  return { name, size: data ? data.byteLength ?? data.length : 0, mime, path: null, file: null, data };
}

const isImage = (it) => IMAGE_EXTS.includes(extOf(it.name)) || IMAGE_MIMES.includes(it.mime);

/** The reason these items cannot be attached, or null. */
export function refusal(items) {
  if (!items.length) return null;
  if (items.length > MAX_ITEMS) return `At most ${MAX_ITEMS} images at a time`;
  if (!items.every(isImage)) return ONLY_IMAGES;
  const big = items.find(it => it.size > MAX_BYTES);
  if (big) return `${big.name} is larger than 20 MB`;
  return null;
}

let seq = 0;

/* Web mirror: every call is one WebSocket message, base64'd (4/3 the
   bytes), and the PC refuses one over 32 MB (electron/web/server.js
   MAX_MESSAGE). A browser File has no path on the PC, so all of it travels
   as bytes: the items go in groups that stay under the frame, a 20 MB image
   (MAX_BYTES) alone. On the desktop IPC has no such limit: one call. */
export const WEB_BATCH_BYTES = 22 * 1024 * 1024;
export function batches(items, sizeOf, limit = WEB_BATCH_BYTES) {
  const out = [];
  let cur = [];
  let total = 0;
  for (const it of items) {
    const n = sizeOf(it);
    if (cur.length && total + n > limit) { out.push(cur); cur = []; total = 0; }
    cur.push(it);
    total += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
const groups = (items) => (IS_WEB ? batches(items, it => it.size || 0) : [items]);

/**
 * Attach `items` (File objects, or {png, mime, name} from the clipboard) to
 * the terminal of `tab`: save/upload as needed, then type their paths in
 * order, space-separated. onStatus({ text, kind: 'progress'|'error' } | null)
 * drives the pane's status line. Resolves to the typed paths ([] if none).
 * paste(text) types them (default term.paste): TerminalView passes one that
 * skips broadcast, so the paths reach only THIS terminal's session.
 */
export async function attachImages(term, tab, rawItems, { onStatus = () => {}, paste } = {}) {
  const a = api();
  if (!a || !term || !tab) return [];
  const items = [...(rawItems || [])].map(normalize);
  const why = refusal(items);
  if (why) { onStatus({ text: why, kind: 'error' }); return []; }
  if (!items.length) return [];
  const isLocal = tab.type === 'local-terminal';

  /* Bytes for whatever has no path on this computer */
  const bytesOf = async (it) => (it.data ? it.data : new Uint8Array(await it.file.arrayBuffer()));

  let paths;
  try {
    if (isLocal) {
      const toSave = items.filter(it => !it.path);
      let saved = [];
      if (toSave.length) {
        onStatus({ text: `Saving ${toSave.length === 1 ? toSave[0].name : `${toSave.length} images`}…`, kind: 'progress' });
        for (const group of groups(toSave)) {
          const got = await a.saveLocal(await Promise.all(group.map(async it => ({ data: await bytesOf(it), name: it.name }))));
          if (!Array.isArray(got) || got.length !== group.length) throw new Error('Could not attach the image');
          saved = saved.concat(got);
        }
      }
      let k = 0;
      paths = items.map(it => it.path || saved[k++]);
    } else {
      const sid = liveSessionId(tab);
      if (!sid) throw new Error('This terminal is not connected');
      /* One upload id per call; `before` = images already sent by earlier
         calls, so the label counts over the whole set */
      const ids = new Map();   // uploadId -> before
      const label = (p, before) => (items.length > 1 ? `${p.name} (${before + p.index + 1}/${items.length})` : p.name);
      const listener = a.onProgress((p) => {
        if (!p || !ids.has(p.uploadId)) return;
        const pct = p.total ? Math.floor((p.sent / p.total) * 100) : 0;
        onStatus({ text: `Uploading ${label(p, ids.get(p.uploadId))}… ${pct}%`, kind: 'progress' });
      });
      onStatus({ text: `Uploading ${items.length === 1 ? items[0].name : `${items.length} images`}…`, kind: 'progress' });
      try {
        paths = [];
        for (const group of groups(items)) {
          const uploadId = `up-${Date.now()}-${++seq}`;
          ids.set(uploadId, paths.length);
          const payload = await Promise.all(group.map(async it => (it.path ? { path: it.path } : { data: await bytesOf(it), name: it.name })));
          const got = await a.upload(sid, uploadId, payload);
          if (!Array.isArray(got) || got.length !== group.length) throw new Error('Could not attach the image');
          paths = paths.concat(got);
        }
      } finally {
        a.offProgress(listener);
      }
    }
  } catch (err) {
    onStatus({ text: (err && err.message) || 'Could not attach the image', kind: 'error' });
    return [];
  }
  if (!paths || paths.length !== items.length || paths.some(p => !p)) {
    onStatus({ text: 'Could not attach the image', kind: 'error' });
    return [];
  }
  onStatus(null);
  const text = `${paths.map(shellQuote).join(' ')} `;
  if (typeof paste === 'function') paste(text); else term.paste(text);
  return paths;
}
