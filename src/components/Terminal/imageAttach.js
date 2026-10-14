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
        saved = await a.saveLocal(await Promise.all(toSave.map(async it => ({ data: await bytesOf(it), name: it.name }))));
      }
      let k = 0;
      paths = items.map(it => it.path || saved[k++]);
    } else {
      const sid = liveSessionId(tab);
      if (!sid) throw new Error('This terminal is not connected');
      const uploadId = `up-${Date.now()}-${++seq}`;
      const label = (p) => (p.count > 1 ? `${p.name} (${p.index + 1}/${p.count})` : p.name);
      const listener = a.onProgress((p) => {
        if (!p || p.uploadId !== uploadId) return;
        const pct = p.total ? Math.floor((p.sent / p.total) * 100) : 0;
        onStatus({ text: `Uploading ${label(p)}… ${pct}%`, kind: 'progress' });
      });
      onStatus({ text: `Uploading ${items.length === 1 ? items[0].name : `${items.length} images`}…`, kind: 'progress' });
      try {
        const payload = await Promise.all(items.map(async it => (it.path ? { path: it.path } : { data: await bytesOf(it), name: it.name })));
        paths = await a.upload(sid, uploadId, payload);
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
