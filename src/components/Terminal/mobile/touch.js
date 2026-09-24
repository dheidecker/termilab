/*
 * Touch on the terminal (Android): pinch to change the font size, long-press
 * to select (a word, then drag to extend). Plain one-finger drags are left to
 * xterm, which scrolls the viewport.
 *
 * The pinched size is per device (localStorage), shared by every open
 * terminal through a window event, and wins over Settings until Settings
 * changes the size again.
 */

export const FONT_KEY = 'termilab.terminal.fontSize.android';
export const FONT_EVENT = 'termilab:terminal-font';
const MIN_FONT = 8;
const MAX_FONT = 28;
const LONG_PRESS_MS = 450;
const MOVE_SLOP = 10;

export function readPinchedFont() {
  try {
    const v = Number(window.localStorage.getItem(FONT_KEY));
    return v >= MIN_FONT && v <= MAX_FONT ? v : null;
  } catch { return null; }
}

export function writePinchedFont(size) {
  try {
    if (size == null) window.localStorage.removeItem(FONT_KEY);
    else window.localStorage.setItem(FONT_KEY, String(size));
  } catch { /* storage blocked: the size lasts until the app restarts */ }
  window.dispatchEvent(new CustomEvent(FONT_EVENT, { detail: size }));
}

const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const isWordChar = (ch) => !!ch && /[^\s"'`()[\]{}<>|;,]/.test(ch);

/**
 * @param {import('@xterm/xterm').Terminal} term
 * @param {() => void} fit  refit (and so resize the remote pty)
 * @param {HTMLElement} el  the element xterm was opened in
 * @returns {() => void} cleanup
 */
export function attachTouch(term, fit, el) {
  let pinch = null;          // { d0, size0, size }
  let press = null;          // { x, y, timer, selecting, anchor }
  let raf = 0;

  const cellAt = (x, y) => {
    const screen = el.querySelector('.xterm-screen');
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    const col = Math.max(0, Math.min(term.cols - 1, Math.floor((x - r.left) / (r.width / term.cols))));
    const row = Math.max(0, Math.min(term.rows - 1, Math.floor((y - r.top) / (r.height / term.rows))));
    return { col, row: row + term.buffer.active.viewportY };
  };

  const selectWord = (cell) => {
    const line = term.buffer.active.getLine(cell.row);
    const text = line ? line.translateToString(false) : '';
    let start = cell.col;
    let end = cell.col;
    if (isWordChar(text[cell.col])) {
      while (start > 0 && isWordChar(text[start - 1])) start--;
      while (end < term.cols - 1 && isWordChar(text[end + 1])) end++;
    }
    term.select(start, cell.row, end - start + 1);
    return { start: { col: start, row: cell.row }, end: { col: end, row: cell.row } };
  };

  const extendTo = (cell) => {
    const { start, end } = press.anchor;
    const lin = (c) => c.row * term.cols + c.col;
    const from = Math.min(lin(start), lin(cell));
    const to = Math.max(lin(end), lin(cell));
    term.select(from % term.cols, Math.floor(from / term.cols), to - from + 1);
  };

  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };

  const onStart = (e) => {
    if (e.touches.length === 2) {
      cancelPress();
      pinch = { d0: dist(e.touches[0], e.touches[1]), size0: term.options.fontSize, size: term.options.fontSize };
      e.preventDefault();
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    cancelPress();
    /* Whether the soft keyboard was up: a selection must not close it, or the
       terminal shrinks back, xterm resizes and drops the selection. */
    const focused = !!document.activeElement?.classList?.contains('xterm-helper-textarea');
    press = { x: t.clientX, y: t.clientY, selecting: false, anchor: null, focused };
    press.timer = setTimeout(() => {
      if (!press) return;
      const cell = cellAt(press.x, press.y);
      if (!cell) return;
      press.selecting = true;
      press.anchor = selectWord(cell);
      if (press.focused) term.focus();
      try { navigator.vibrate?.(12); } catch { /* no vibration */ }
    }, LONG_PRESS_MS);
  };

  const onMove = (e) => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const scale = dist(e.touches[0], e.touches[1]) / pinch.d0;
      const size = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round(pinch.size0 * scale)));
      if (size !== pinch.size) {
        pinch.size = size;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          term.options.fontSize = size;
          try { fit(); } catch { /* not laid out */ }
        });
      }
      return;
    }
    if (!press || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (press.selecting) {
      e.preventDefault();
      e.stopPropagation();   // not a scroll for xterm
      const cell = cellAt(t.clientX, t.clientY);
      if (cell) extendTo(cell);
    } else if (Math.hypot(t.clientX - press.x, t.clientY - press.y) > MOVE_SLOP) {
      cancelPress();
    }
  };

  const onEnd = (e) => {
    if (pinch && e.touches.length < 2) {
      const { size, size0 } = pinch;
      pinch = null;
      if (size !== size0) writePinchedFont(size);
      return;
    }
    if (press && press.selecting) {
      // The finger comes up on a selection: not a tap for xterm.
      e.preventDefault();
      e.stopPropagation();
      if (press.focused) term.focus();
    }
    cancelPress();
  };

  /* Chrome's own long-press (text selection / context menu) would fight ours */
  const onContext = (e) => { e.preventDefault(); e.stopPropagation(); };

  const opts = { capture: true, passive: false };
  el.addEventListener('touchstart', onStart, opts);
  el.addEventListener('touchmove', onMove, opts);
  el.addEventListener('touchend', onEnd, opts);
  el.addEventListener('touchcancel', onEnd, opts);
  el.addEventListener('contextmenu', onContext, true);
  return () => {
    cancelPress();
    cancelAnimationFrame(raf);
    el.removeEventListener('touchstart', onStart, opts);
    el.removeEventListener('touchmove', onMove, opts);
    el.removeEventListener('touchend', onEnd, opts);
    el.removeEventListener('touchcancel', onEnd, opts);
    el.removeEventListener('contextmenu', onContext, true);
  };
}
