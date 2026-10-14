/*
 * Files (or a link) dropped anywhere that does not take them must not make
 * Chromium navigate the window to that file: the app would be replaced by
 * the file's contents. Window-level, bubble phase, so it runs AFTER every
 * real drop target (terminal panes, SFTP lists): those call preventDefault
 * when they accept, and this one then leaves the event alone. Our own
 * drags (panes/tabs, SFTP rows) carry only custom types and text/plain,
 * never Files, so they are untouched. main.js denies the navigation too.
 */
import { DRAG_MIME } from '../components/SplitPane/dragState';

/** A drag Chromium would navigate to on an unhandled drop. */
export function isForeignDrag(e) {
  const types = [...((e && e.dataTransfer && e.dataTransfer.types) || [])];
  if (types.includes(DRAG_MIME)) return false;
  return types.includes('Files') || types.includes('text/uri-list');
}

export function installFileDropGuard(win = typeof window !== 'undefined' ? window : null) {
  if (!win || !win.addEventListener) return () => {};
  const over = (e) => {
    if (e.defaultPrevented || !isForeignDrag(e)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'none'; } catch (_) { /* read-only in some events */ }
  };
  const drop = (e) => {
    if (e.defaultPrevented || !isForeignDrag(e)) return;
    e.preventDefault();
  };
  win.addEventListener('dragover', over);
  win.addEventListener('drop', drop);
  return () => {
    win.removeEventListener('dragover', over);
    win.removeEventListener('drop', drop);
  };
}
