/*
 * The CSS font-family xterm gets: the font chosen in Settings, then always a
 * chain of monospace fonts. A bare name that is not installed ("Consolas" on
 * macOS, "Monaco" on Linux) would otherwise fall back to the browser's
 * PROPORTIONAL default font: xterm measures one cell from it and every
 * narrower or wider glyph then sits off the grid. JetBrains Mono is bundled
 * with the app (src/index.css), so the chain normally stops there.
 */
const FALLBACK = ['JetBrains Mono', 'Menlo', 'Monaco', 'Consolas', 'DejaVu Sans Mono', 'Liberation Mono', 'monospace'];
const GENERIC = new Set(['monospace', 'ui-monospace', 'serif', 'sans-serif', 'system-ui']);

export function terminalFontFamily(setting) {
  const names = String(setting || '')
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
  /* A generic family always resolves: what comes after it is never used
     ("System Mono" = 'monospace' stays exactly that) */
  const g = names.findIndex(n => GENERIC.has(n.toLowerCase()));
  if (g === 0) return names[0];
  const named = g < 0 ? names : names.slice(0, g);
  const seen = new Set(named.map(n => n.toLowerCase()));
  for (const f of FALLBACK) if (!seen.has(f.toLowerCase()) && !GENERIC.has(f)) named.push(f);
  const quote = (n) => (/^[\w-]+$/.test(n) ? n : `'${n.replace(/'/g, '')}'`);
  return [...named.map(quote), g < 0 ? 'monospace' : names[g]].join(', ');
}
