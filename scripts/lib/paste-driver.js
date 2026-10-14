/**
 * Driver de C6 (scripts/lib/check-clipboard.js). Corre bajo Electron-como-node
 * (ELECTRON_RUN_AS_NODE=1): node-pty esta compilado para el ABI de Electron.
 *
 * Pega N lineas (con multibyte y emoji, terminadas en CR como las manda xterm)
 * en un `wc -lc` dentro de un pty real, por el writer troceado de
 * electron/services/chunked-writer.js, y despues las mismas de un golpe con
 * pty.write directo. Imprime una linea JSON con lo que conto wc en cada caso.
 */
const path = require('path');

const ROOT = process.argv[2];
const pty = require(path.join(ROOT, 'node_modules', 'node-pty'));
const { createChunkedWriter } = require(path.join(ROOT, 'electron', 'services', 'chunked-writer.js'));

const LINES = 200;
const lines = [];
for (let i = 0; i < LINES; i++) lines.push(`linea ${String(i).padStart(3, '0')} ñandú 😀 ${'x'.repeat(200 + (i % 37))}`);
const payload = lines.join('\r') + '\r';
const expectedBytes = Buffer.byteLength(lines.join('\n') + '\n');

function run(mode) {
  return new Promise((resolve) => {
    const p = pty.spawn('/bin/sh', ['-c', 'stty -echo; printf READY; wc -lc; printf DONE'], { cols: 80, rows: 24, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' } });
    let out = '';
    let sent = false;
    const timer = setTimeout(() => { try { p.kill(); } catch (_) {} resolve({ mode, error: 'timeout', out: out.slice(-300) }); }, 20000);
    p.onData((d) => {
      out += d;
      if (!sent && out.includes('READY')) {
        sent = true;
        if (mode === 'chunked') {
          const w = createChunkedWriter((c) => { p.write(c); return true; });
          w.write(payload);
          w.write('\x04');   // ^D tras la pegada: va en cola detras de ella, como una tecla
        } else {
          p.write(payload + '\x04');
        }
      }
      const m = out.match(/READY[\s\S]*?(\d+)\s+(\d+)\s*DONE/);
      if (m) {
        clearTimeout(timer);
        try { p.kill(); } catch (_) {}
        resolve({ mode, lines: Number(m[1]), bytes: Number(m[2]) });
      }
    });
  });
}

(async () => {
  const chunked = await run('chunked');
  const direct = await run('direct');
  console.log(JSON.stringify({ expectedLines: LINES, expectedBytes, chunked, direct }));
  process.exit(0);
})();
