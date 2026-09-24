/*
 * The extra-keys row (Android): what each key sends, and the sticky Ctrl/Alt
 * that apply to the next key typed on the soft keyboard. Pure functions, no
 * DOM, so they can be checked from Node.
 *
 * Sequences follow xterm: arrows and Home/End use SS3 (ESC O x) when the
 * application has switched on application cursor keys (vim, less, tmux...)
 * and CSI (ESC [ x) otherwise; with a modifier they become CSI 1;m x.
 */

const ESC = '\x1b';

/* The row, in order. `label` is what the button shows. */
export const EXTRA_KEYS = [
  { id: 'esc', label: 'Esc' },
  { id: 'tab', label: 'Tab' },
  { id: 'ctrl', label: 'Ctrl', modifier: true },
  { id: 'alt', label: 'Alt', modifier: true },
  { id: 'left', label: '←', aria: 'Left' },
  { id: 'up', label: '↑', aria: 'Up' },
  { id: 'down', label: '↓', aria: 'Down' },
  { id: 'right', label: '→', aria: 'Right' },
  { id: '|', label: '|' },
  { id: '~', label: '~' },
  { id: '/', label: '/' },
  { id: '-', label: '-' },
  { id: 'home', label: 'Home' },
  { id: 'end', label: 'End' },
  { id: 'pgup', label: 'PgUp' },
  { id: 'pgdn', label: 'PgDn' },
];

const CURSOR = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
const TILDE = { pgup: '5', pgdn: '6' };

/* xterm's modifier parameter: 1 + shift(1) + alt(2) + ctrl(4) */
const modParam = ({ ctrl, alt }) => 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0);

/** Ctrl applied to one character, as a terminal sends it. Unchanged if none. */
export function ctrlChar(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return ch;
  const c = ch.charCodeAt(0);
  if ((c >= 0x61 && c <= 0x7a) || (c >= 0x40 && c <= 0x5f)) return String.fromCharCode(c & 0x1f); // a-z, @A-Z[\]^_
  if (ch === ' ' || ch === '2') return '\x00';
  if (ch === '?' || ch === '8') return '\x7f';
  if (ch >= '3' && ch <= '7') return String.fromCharCode(0x1b + (c - 0x33)); // 3..7 -> ESC..US
  if (ch === '/') return '\x1f';
  return ch;
}

/**
 * Sticky modifiers applied to what the soft keyboard typed. Only a single
 * character is modified; anything longer (a paste, an escape sequence from a
 * hardware key) passes through, and then the modifier stays armed.
 * @returns {{ data: string, used: boolean }}
 */
export function applyModifiers(data, { ctrl = false, alt = false } = {}) {
  if ((!ctrl && !alt) || typeof data !== 'string' || [...data].length !== 1) return { data, used: false };
  let out = data;
  if (ctrl) out = ctrlChar(out);
  if (alt) out = ESC + out;
  return { data: out, used: true };
}

/** What a key of the row sends, given the terminal mode and the modifiers. */
export function keySequence(id, { appCursor = false, ctrl = false, alt = false } = {}) {
  const mods = ctrl || alt;
  if (CURSOR[id]) {
    const final = CURSOR[id];
    if (mods) return `${ESC}[1;${modParam({ ctrl, alt })}${final}`;
    return appCursor ? `${ESC}O${final}` : `${ESC}[${final}`;
  }
  if (TILDE[id]) return mods ? `${ESC}[${TILDE[id]};${modParam({ ctrl, alt })}~` : `${ESC}[${TILDE[id]}~`;
  if (id === 'esc') return alt ? ESC + ESC : ESC;
  if (id === 'tab') return alt ? ESC + '\t' : '\t';
  return applyModifiers(id, { ctrl, alt }).data;
}

/*
 * Sticky modifier state: 'off' -> tap -> 'once' (applies to the next key) ->
 * a second tap within DOUBLE_TAP_MS -> 'locked' (applies until tapped again).
 * A slower second tap turns it off.
 */
export const DOUBLE_TAP_MS = 400;

export function tapModifier(current, lastTapAt, now) {
  if (current === 'off') return 'once';
  if (current === 'once') return now - lastTapAt <= DOUBLE_TAP_MS ? 'locked' : 'off';
  return 'off';
}

/** After a key used the modifiers: 'once' is spent, 'locked' stays. */
export const afterUse = (state) => (state === 'once' ? 'off' : state);
