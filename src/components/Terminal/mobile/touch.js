/*
 * Touch on the terminal (Android): pinch to change the font size, long-press
 * to select (a word, then drag to extend), one-finger vertical drag to scroll
 * (with inertia). xterm's own touch scrolling barely works in the Android
 * WebView and does nothing in full-screen programs, so the drag is ours:
 * - normal buffer: scrolls the scrollback (`term.scrollLines`);
 * - full-screen program that tracks the mouse (tmux, htop, vim with mouse,
 *   Claude CLI...): sends mouse-wheel events, as a desktop wheel would;
 * - full-screen program without mouse (less, man): sends arrow up/down.
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
const FRICTION = 0.94;       // per frame, for the fling after the finger lifts
const MIN_FLING = 0.02;      // lines per ms below which the fling stops

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
  let drag = null;           // { y, carry, t, v }  one-finger scroll in progress
  let fling = 0;             // rAF id of the inertia after a drag

  const lineHeight = () => {
    const screen = el.querySelector('.xterm-screen');
    const h = screen ? screen.getBoundingClientRect().height / term.rows : 0;
    return h > 0 ? h : 16;
  };

  /* Scroll by `lines` (positive = towards older output, i.e. finger down). */
  const scrollBy = (lines) => {
    if (!lines) return;
    const buf = term.buffer.active;
    if (buf.type === 'normal') {
      term.scrollLines(-lines);
      return;
    }
    const n = Math.min(Math.abs(lines), 10);
    const up = lines > 0;
    let seq;
    if (term.modes.mouseTrackingMode !== 'none') {
      // SGR wheel report at the middle of the screen: 64 = wheel up, 65 = down
      const col = Math.ceil(term.cols / 2);
      const row = Math.ceil(term.rows / 2);
      seq = `\x1b[<${up ? 64 : 65};${col};${row}M`;
    } else {
      seq = term.modes.applicationCursorKeysMode ? (up ? '\x1bOA' : '\x1bOB') : (up ? '\x1b[A' : '\x1b[B');
    }
    term.input(seq.repeat(n), true);
  };

  const stopFling = () => { cancelAnimationFrame(fling); fling = 0; };

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
    stopFling();
    drag = null;
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
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (drag) {
      e.preventDefault();
      e.stopPropagation();   // ours, not xterm's
      const now = e.timeStamp;
      const moved = (t.clientY - drag.y) / lineHeight();
      const lines = moved + drag.carry;
      const whole = Math.trunc(lines);
      drag.carry = lines - whole;
      drag.y = t.clientY;
      const dt = Math.max(1, now - drag.t);
      drag.v = 0.8 * (moved / dt) + 0.2 * drag.v;   // lines per ms, smoothed
      drag.t = now;
      scrollBy(whole);
      return;
    }
    if (!press) return;
    if (press.selecting) {
      e.preventDefault();
      e.stopPropagation();   // not a scroll for xterm
      const cell = cellAt(t.clientX, t.clientY);
      if (cell) extendTo(cell);
    } else if (Math.hypot(t.clientX - press.x, t.clientY - press.y) > MOVE_SLOP) {
      const vertical = Math.abs(t.clientY - press.y) > Math.abs(t.clientX - press.x);
      cancelPress();
      if (vertical) {
        e.preventDefault();
        e.stopPropagation();
        drag = { y: t.clientY, carry: 0, t: e.timeStamp, v: 0 };
      }
    }
  };

  const startFling = (v) => {
    let vel = v;             // lines per ms
    let last = performance.now();
    let carry = 0;
    const step = (now) => {
      const dt = Math.max(1, now - last);
      last = now;
      const lines = vel * dt + carry;
      const whole = Math.trunc(lines);
      carry = lines - whole;
      scrollBy(whole);
      vel *= FRICTION ** (dt / 16);
      fling = Math.abs(vel) > MIN_FLING ? requestAnimationFrame(step) : 0;
    };
    fling = requestAnimationFrame(step);
  };

  const onEnd = (e) => {
    if (pinch && e.touches.length < 2) {
      const { size, size0 } = pinch;
      pinch = null;
      if (size !== size0) writePinchedFont(size);
      return;
    }
    if (drag) {
      // The end of a scroll is not a tap: no keyboard, no cursor move.
      e.preventDefault();
      e.stopPropagation();
      const { v } = drag;
      drag = null;
      // Full-screen programs get the drag only; no fling of keystrokes.
      if (Math.abs(v) > MIN_FLING * 4 && term.buffer.active.type === 'normal') startFling(v);
      cancelPress();
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
    stopFling();
    cancelAnimationFrame(raf);
    el.removeEventListener('touchstart', onStart, opts);
    el.removeEventListener('touchmove', onMove, opts);
    el.removeEventListener('touchend', onEnd, opts);
    el.removeEventListener('touchcancel', onEnd, opts);
    el.removeEventListener('contextmenu', onContext, true);
  };
}
