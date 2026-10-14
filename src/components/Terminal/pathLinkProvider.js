import { findPaths, parseOsc7, logicalLine, spanRange } from './pathLinks';
import { showToast } from '../Keeper/toast';
import './pathLinks.css';

/*
 * Clickable file paths in an xterm (desktop). pathLinks.js decides what is a
 * path; this wires it to the terminal:
 *  - an xterm link provider: hovering a path does nothing visible until
 *    Ctrl (Cmd on macOS) is held, then it is underlined with a pointer, like
 *    VS Code; Ctrl/Cmd+click opens it. A plain click stays a click (select).
 *  - OSC 7 (`file://host/dir`) from the shell is remembered as the cwd.
 *  - right-click on a path (no selection, program not grabbing the mouse):
 *    Open / Open folder in SFTP / Copy path, instead of copy/paste. The
 *    listener is CAPTURE on the same element TerminalView's contextmenu
 *    listens on (bubble), so stopImmediatePropagation keeps paste out.
 *  - main (open-path-service.js) resolves and opens; a remote file comes
 *    back as an edit (sftp-edit-service) and gets a banner here with
 *    Upload / Auto-upload, like the SFTP pane's.
 *
 * attachPathLinks(term, wrapperEl, ctx) → dispose
 *   ctx.target()      → { kind: 'local'|'ssh', sessionId, owner, label }
 *   ctx.openSftpAt(d) → open an SFTP tab at directory d (optional)
 */

const api = () => (typeof window !== 'undefined' ? window.electronAPI : null);
export const canOpenPaths = () => !!(api() && api().paths);

const baseName = (p) => String(p).replace(/\/+$/, '').split('/').pop() || p;
const errText = (err) => String((err && err.message) || err || 'Could not open it')
  .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function attachPathLinks(term, wrapperEl, ctx) {
  const electron = api();
  if (!electron || !electron.paths || !term || !wrapperEl) return () => {};
  const host = wrapperEl.closest('.terminal-container') || wrapperEl;
  let disposed = false;

  /* ─── cwd reported by the shell ─── */
  let osc = null;
  const oscHandler = term.parser.registerOscHandler(7, (data) => {
    const r = parseOsc7(data);
    if (r) osc = r;
    return false;   // not consumed: anyone else may look at it too
  });

  /* ─── Ctrl/Cmd held → the hovered link is underlined ─── */
  let mod = false;
  let hovered = null;   // { link, item }
  const setDeco = () => {
    if (!hovered) return;
    try {
      hovered.link.decorations.underline = mod;
      hovered.link.decorations.pointerCursor = mod;
    } catch (_) { /* link gone */ }
  };
  const track = (e) => {
    const m = !!(e && (e.ctrlKey || e.metaKey));
    if (m !== mod) { mod = m; setDeco(); }
  };
  const onBlur = () => { mod = false; setDeco(); };
  window.addEventListener('keydown', track, true);
  window.addEventListener('keyup', track, true);
  window.addEventListener('blur', onBlur);
  wrapperEl.addEventListener('mousemove', track, true);

  const target = () => {
    const t = (ctx && ctx.target && ctx.target()) || {};
    return { kind: t.kind === 'ssh' ? 'ssh' : 'local', sessionId: t.sessionId || null, owner: t.owner || null, label: t.label || '' };
  };
  const specOf = (item) => {
    const t = target();
    return { kind: t.kind, sessionId: t.sessionId, owner: t.owner, path: item.path, line: item.line, col: item.col, osc };
  };

  /* ─── Open ─── */
  const open = async (item) => {
    const spec = specOf(item);
    if (!spec.sessionId) { showToast('This terminal is not connected'); return; }
    try {
      const r = await electron.paths.open(spec);
      if (disposed || !r) return;
      if (r.status === 'missing') showToast(`File not found: ${r.path}`, 4500);
      else if (r.status === 'revealed') showToast(`${baseName(r.path)} could run as a program: showing it in its folder`, 4500);
      else if (r.status === 'dir') {
        if (ctx.openSftpAt) ctx.openSftpAt(r.path);
        else showToast(`${r.path} is a folder`);
      } else if (r.status === 'editing') addEdit(r, target().label);
    } catch (err) {
      const msg = errText(err);
      showToast(/Refusing to open/.test(msg) ? `${baseName(item.path)} could run as a program, so Termilab will not open it` : msg, 5000);
    }
  };

  /* ─── Link provider ─── */
  const provider = term.registerLinkProvider({
    provideLinks(y, callback) {
      let links;
      try {
        const buf = term.buffer.active;
        const { text, cells } = logicalLine(buf, y - 1, term.cols);
        links = [];
        for (const item of findPaths(text)) {
          const range = spanRange(cells, item.start, item.end);
          if (!range || range.start.y > y || range.end.y < y) continue;
          const link = {
            range,
            text: text.slice(item.start, item.end),
            decorations: { underline: mod, pointerCursor: mod },
            activate: (e) => { if (e && (e.ctrlKey || e.metaKey)) open(item); },
            /* xterm swaps in its own decorations object right AFTER hover():
               set them a tick later or the change lands on the old one */
            hover: (e) => { hovered = { link, item }; track(e); Promise.resolve().then(setDeco); },
            leave: () => { if (hovered && hovered.link === link) hovered = null; },
          };
          links.push(link);
        }
      } catch (_) {
        links = [];
      }
      callback(links.length ? links : undefined);
    },
  });

  /* ─── Context menu on a path ─── */
  let menu = null;
  const closeMenu = (refocus = true) => {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', menuKey, true);
    window.removeEventListener('blur', closeMenuNoFocus);
    if (refocus && term.textarea) term.textarea.focus({ preventScroll: true });
  };
  const closeMenuNoFocus = () => closeMenu(false);
  const outside = (e) => { if (menu && !menu.contains(e.target)) closeMenu(false); };
  const menuKey = (e) => {
    if (!menu) return;
    const items = Array.from(menu.querySelectorAll('button'));
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      const n = items.length;
      items[(i + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n]?.focus();
    }
  };
  const showMenu = (x, y, item) => {
    closeMenu(false);
    const el = document.createElement('div');
    el.className = 'path-link-menu';
    el.setAttribute('role', 'menu');
    const add = (label, run) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'path-link-menu-item';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      b.addEventListener('click', () => { closeMenu(); run(); });
      el.appendChild(b);
    };
    const head = document.createElement('div');
    head.className = 'path-link-menu-head';
    head.textContent = item.path;
    head.title = item.path;
    el.appendChild(head);
    add('Open', () => open(item));
    if (ctx.openSftpAt) add('Open folder in SFTP', () => openFolder(item));
    add('Copy path', () => copyPath(item));
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
    menu = el;
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', menuKey, true);
    window.addEventListener('blur', closeMenuNoFocus);
    el.querySelector('button')?.focus();
  };
  const resolve = async (item) => {
    const spec = specOf(item);
    if (!spec.sessionId) throw new Error('This terminal is not connected');
    return electron.paths.resolve(spec);
  };
  const openFolder = async (item) => {
    try {
      const r = await resolve(item);
      if (!r.exists) showToast(`File not found: ${r.path}`, 4500);
      else ctx.openSftpAt(r.dir);
    } catch (err) { showToast(errText(err), 5000); }
  };
  const copyPath = async (item) => {
    let text = item.path;
    try { const r = await resolve(item); if (r && r.path) text = r.path; } catch (_) { /* as printed */ }
    try {
      if (electron.clipboard) await electron.clipboard.writeText(text);
      showToast(`Copied ${text}`);
    } catch (err) { showToast(errText(err)); }
  };
  const onContextMenu = (e) => {
    if (!hovered) return;
    const mouseIsApps = term.modes && term.modes.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none' && !e.shiftKey;
    if (mouseIsApps || term.hasSelection()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    showMenu(e.clientX, e.clientY, hovered.item);
  };
  wrapperEl.addEventListener('contextmenu', onContextMenu, true);

  /* ─── Remote edits: upload on save ─── */
  const edits = new Map();   // editId -> { el, name, label, changed, auto, busy, error, uploadedAt, again }
  let editBox = null;
  let editListener = null;
  const ensureBox = () => {
    if (editBox) return editBox;
    editBox = document.createElement('div');
    editBox.className = 'path-edits';
    host.appendChild(editBox);
    editListener = electron.sftp && electron.sftp.onEditEvent ? electron.sftp.onEditEvent((ev) => {
      const ed = ev && ev.type === 'changed' ? edits.get(ev.editId) : null;
      if (!ed) return;
      if (ed.auto) upload(ev.editId);
      else { ed.changed = true; ed.error = null; render(ev.editId); }
    }) : null;
    return editBox;
  };
  const render = (editId) => {
    const ed = edits.get(editId);
    if (!ed) return;
    const el = ed.el;
    el.className = `path-edit-banner${ed.changed ? ' changed' : ''}${ed.error ? ' error' : ''}`;
    el.textContent = '';
    const txt = document.createElement('span');
    txt.className = 'path-edit-text';
    const strong = document.createElement('strong');
    strong.textContent = ed.name;
    const where = ed.label || 'the server';
    const say = (before, after) => { txt.append(before, strong, after); };
    if (ed.error) say('', `: upload failed — ${ed.error}`);
    else if (ed.busy) say('Uploading ', '…');
    else if (ed.changed) say('', ` changed on this computer. Upload it to ${where}?`);
    else if (ed.uploadedAt) say('', ` uploaded at ${new Date(ed.uploadedAt).toLocaleTimeString()}. ${ed.auto ? 'Saving again uploads it.' : 'Save again to update it.'}`);
    else say('Editing ', ` from ${where} in your default app. Save it there and you can upload the changes.`);
    el.appendChild(txt);
    const actions = document.createElement('span');
    actions.className = 'path-edit-actions';
    if ((ed.changed || ed.error) && !ed.busy) {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'path-edit-btn primary';
      up.textContent = 'Upload';
      up.addEventListener('click', () => upload(editId));
      actions.appendChild(up);
    }
    const lab = document.createElement('label');
    lab.className = 'path-edit-check';
    lab.title = 'Upload every save without asking';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!ed.auto;
    cb.addEventListener('change', () => { ed.auto = cb.checked; });
    lab.append(cb, ' Auto-upload');
    actions.appendChild(lab);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'path-edit-btn close';
    x.setAttribute('aria-label', `Stop editing ${ed.name}`);
    x.title = 'Stop watching';
    x.textContent = '×';
    x.addEventListener('click', () => stopEdit(editId));
    actions.appendChild(x);
    el.appendChild(actions);
  };
  const addEdit = (r, label) => {
    ensureBox();
    const el = document.createElement('div');
    el.setAttribute('role', 'status');
    editBox.appendChild(el);
    edits.set(r.editId, { el, name: r.name || baseName(r.path), label, changed: false, auto: false, busy: false, error: null, uploadedAt: 0, again: false });
    render(r.editId);
  };
  /* One upload per edit at a time; a save during one asks for exactly one more */
  const upload = async (editId) => {
    const ed = edits.get(editId);
    if (!ed) return;
    if (ed.busy) { ed.again = true; return; }
    ed.busy = true; ed.error = null; render(editId);
    try {
      do {
        ed.again = false;
        await electron.sftp.editUpload(editId);
      } while (ed.again && edits.has(editId));
      ed.changed = false; ed.uploadedAt = Date.now();
    } catch (err) {
      ed.error = errText(err);
    } finally {
      ed.busy = false;
      if (edits.has(editId)) render(editId);
    }
  };
  const stopEdit = (editId) => {
    const ed = edits.get(editId);
    if (!ed) return;
    electron.sftp?.editStop?.(editId)?.catch?.(() => {});
    ed.el.remove();
    edits.delete(editId);
  };

  return () => {
    disposed = true;
    closeMenu(false);
    try { provider.dispose(); } catch (_) { /* gone */ }
    try { oscHandler.dispose(); } catch (_) { /* gone */ }
    window.removeEventListener('keydown', track, true);
    window.removeEventListener('keyup', track, true);
    window.removeEventListener('blur', onBlur);
    wrapperEl.removeEventListener('mousemove', track, true);
    wrapperEl.removeEventListener('contextmenu', onContextMenu, true);
    /* Watchers stop; the temp copies go when the window closes or the app quits */
    for (const id of Array.from(edits.keys())) stopEdit(id);
    if (editListener && electron.sftp?.offEditEvent) electron.sftp.offEditEvent(editListener);
    if (editBox) editBox.remove();
  };
}
