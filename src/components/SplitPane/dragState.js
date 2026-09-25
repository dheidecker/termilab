import { useSyncExternalStore } from 'react';

/*
 * The one tab/pane drag in flight, shared by TabBar (in the title bar) and
 * SessionStage (the terminals). HTML5 drag and drop: the payload also rides in
 * dataTransfer, but dragover handlers cannot read it, so this is the source.
 *   { kind: 'tab', tabId } | { kind: 'pane', paneId }
 */
export const DRAG_MIME = 'application/x-termilab-pane';

let current = null;
const subs = new Set();

export const getDrag = () => current;
export function setDrag(d) {
  if (current === d) return;
  current = d;
  subs.forEach(fn => fn());
}
const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const useDrag = () => useSyncExternalStore(subscribe, getDrag);

/* dragstart handler body. The store is set on the next tick: changing the DOM
   during dragstart (the drop layer appears) makes Chromium cancel the drag. */
export function beginDrag(e, d, label) {
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData(DRAG_MIME, JSON.stringify(d)); } catch (_) { /* synthetic events */ }
  try { e.dataTransfer.setData('text/plain', label || ''); } catch (_) { /* idem */ }
  setTimeout(() => setDrag(d), 0);
}

/* dragend does not fire when the source element left the DOM mid-drag (a
   pane header disappears once its tab is down to one pane): the first mouse
   move after any drag clears what is left. */
if (typeof window !== 'undefined') {
  window.addEventListener('dragend', () => setDrag(null), true);
  window.addEventListener('mousemove', (e) => { if (current && e.buttons === 0) setDrag(null); }, true);
}
