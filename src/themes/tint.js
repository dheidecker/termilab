/*
 * Colour maths for a terminal's own colour (HostList/hostColor.js tabColor):
 * the tinted xterm background and the solid pane / session header. Pure (no
 * React, no DOM) so a node script can measure exactly what the app paints.
 *
 * Only '#rrggbb' goes in: tabColor() already filters through validColor(), and
 * every colour of terminal-themes.js except selectionBackground is '#rrggbb'.
 */

const rgb = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const hex = (c) => `#${c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/** `amount` (0..1) of `top` painted over `base`, in sRGB like CSS color-mix */
export function mix(base, top, amount) {
  const a = rgb(base);
  const b = rgb(top);
  return hex(a.map((v, i) => v + (b[i] - v) * amount));
}

/** WCAG 2 relative luminance */
export function luminance(c) {
  const [r, g, b] = rgb(c).map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1..21 */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

/* How much of the colour goes into the background. Chosen by measuring every
   scheme against every HOST_COLORS entry (scratchpad contrast script); a light
   scheme shows a tint much sooner than a dark one, so it gets less. */
export const TINT_DARK = 0.34;
export const TINT_LIGHT = 0.2;

/* What the tint must not break. The foreground keeps >= 4.5:1 (or, in a
   scheme that never had it, all it had), and every ANSI colour that had
   >= 3:1 keeps it. Two kinds may only lose up to 10% of what they had: the
   ones that never reached 3:1, and the ones a scheme means as a background
   and makes nearly its own colour (black on a dark scheme; white and
   brightWhite on a light one, which in github-light sits at 3.04:1 and would
   otherwise forbid any tint at all). */
const FG_MIN = 4.5;
const ANSI_MIN = 2.2;
const WEAK_KEEP = 0.7;

export const isLightScheme = (theme) => luminance(theme.background) > 0.4;

const bgRole = (theme) => (isLightScheme(theme) ? ['white', 'brightWhite'] : ['black']);

function tintHolds(theme, bg) {
  const fg0 = contrast(theme.foreground, theme.background);
  if (contrast(theme.foreground, bg) < Math.min(FG_MIN, fg0)) return false;
  const soft = bgRole(theme);
  for (const k of ANSI_KEYS) {
    const c0 = contrast(theme[k], theme.background);
    const c = contrast(theme[k], bg);
    if (c0 >= ANSI_MIN && !soft.includes(k) ? c < ANSI_MIN : c < c0 * WEAK_KEEP) return false;
  }
  return true;
}

const toLin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const toSrgb = (l) => 255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
const W = [0.2126, 0.7152, 0.0722];

/** The same hue at luminance `target` (scaled in linear light, so the
    chromaticity stays). Contrast only depends on luminance, so a background
    moved back to the scheme's own luminance keeps every ratio it had. A
    channel that would pass 255 is clipped and the rest take up the slack;
    near white the target may be out of reach, and this returns the closest. */
export function atLuminance(c, target) {
  let lin = rgb(c).map(toLin);
  for (let i = 0; i < 8; i++) {
    const L = lin.reduce((a, v, j) => a + v * W[j], 0);
    if (L <= 0 || Math.abs(L - target) < 1e-5) break;
    const free = lin.map(v => v < 1);
    const fixed = lin.reduce((a, v, j) => a + (free[j] ? 0 : W[j]), 0);
    const movable = L - fixed;
    if (movable <= 0) break;
    const k = (target - fixed) / movable;
    lin = lin.map((v, j) => (free[j] ? Math.min(1, Math.max(0, v * k)) : v));
  }
  return hex(lin.map(toSrgb));
}

/** This scheme's background with `color` in it, or null for "no tint".
    The colour goes in at the scheme's level; when that breaks a contrast rule
    (a scheme with an ANSI colour right at 3:1 breaks with almost any tint), the
    tinted background is first pulled back toward the scheme's own luminance
    (hue kept), and only if even that cannot hold is the level lowered. So a
    synced host with an odd colour (near-white, say) gets a fainter tint, never
    an unreadable terminal. Returns { bg, level, held } (held = luminance was
    pulled back). */
export function tintFor(theme, color) {
  if (!color) return null;
  const L0 = luminance(theme.background);
  const top = Math.round((isLightScheme(theme) ? TINT_LIGHT : TINT_DARK) * 100);
  for (let p = top; p > 0; p--) {
    const cand = mix(theme.background, color, p / 100);
    if (tintHolds(theme, cand)) return { bg: cand, level: p / 100, held: false };
    const Lc = luminance(cand);
    for (const f of [0.25, 0.5, 0.75, 1]) {
      const bg = atLuminance(cand, Lc + (L0 - Lc) * f);
      if (tintHolds(theme, bg)) return { bg, level: p / 100, held: true };
    }
  }
  return null;
}

const cache = new Map();

/** The xterm theme for a terminal with `color` (null = the scheme as is).
    Only the background moves (and cursorAccent, the text under a block
    cursor, which every scheme sets to its background). Memoised per
    (scheme object, colour), so it is cheap on every render. */
export function tintTheme(theme, color) {
  if (!color) return theme;
  let byColor = cache.get(theme);
  if (!byColor) { byColor = new Map(); cache.set(theme, byColor); }
  let out = byColor.get(color);
  if (!out) {
    const t = tintFor(theme, color);
    const background = t ? t.bg : theme.background;
    out = {
      ...theme,
      background,
      cursorAccent: theme.cursorAccent === theme.background ? background : theme.cursorAccent,
    };
    byColor.set(color, out);
  }
  return out;
}

/* Text on a coloured surface: white or near-black, whichever reads better */
export const INK_LIGHT = '#ffffff';
export const INK_DARK = '#101318';

export function inkOn(bg) {
  return contrast(INK_LIGHT, bg) >= contrast(INK_DARK, bg) ? INK_LIGHT : INK_DARK;
}

/** A header painted in the terminal's colour: { bg, ink } with ink >= 4.5:1.
    A mid-tone that reaches neither with white nor near-black is pushed a few
    points away from its ink (darker under white, lighter under black). */
export function solidHeader(color) {
  let bg = color;
  let ink = inkOn(bg);
  for (let i = 1; contrast(ink, bg) < 4.5 && i <= 10; i++) {
    bg = mix(color, ink === INK_LIGHT ? '#000000' : '#ffffff', i * 0.05);
    ink = inkOn(bg);
  }
  return { bg, ink };
}
