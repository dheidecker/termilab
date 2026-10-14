// Copiar y pegar de punta a punta: Electron real + eventos X reales (xdotool,
// XTEST) + selecciones X reales (xclip). Linux. Corre DENTRO de xvfb-run:
//
//   npm run build
//   XDOTOOL=/ruta/xdotool XCLIP=/ruta/xclip [XDO_LIB=/ruta/lib] \
//     xvfb-run -a -s '-screen 0 1600x1000x24' node scripts/e2e-clipboard.mjs
//
// Sin root: `apt-get download xdotool libxdo3 xclip`, `dpkg-deb -x` de cada uno
// en un directorio y XDO_LIB=<dir>/usr/lib/x86_64-linux-gnu. Abre una terminal
// local con tu shell; no toca tu userData (usa un --user-data-dir temporal).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const SP = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-clip-out-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); log(results[results.length - 1]); };

const XDO_LIB = process.env.XDO_LIB || '';
const xdo = (...args) => execFileSync(process.env.XDOTOOL || 'xdotool', args, { env: { ...process.env, LD_LIBRARY_PATH: XDO_LIB } }).toString();
const XCLIP = process.env.XCLIP || 'xclip';
const clipSet = (sel, text) => {
  /* xclip forks a child that owns the selection until someone else takes it */
  const p = spawn(XCLIP, ['-selection', sel, '-i'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  p.stdin.end(text);
  p.unref();
  return sleep(300);
};
const clipGet = (sel) => { try { return execFileSync(XCLIP, ['-selection', sel, '-o'], { timeout: 3000 }).toString(); } catch (_) { return null; } };

/* dist over http */
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const web = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, 'dist', p);
  if (!f.startsWith(path.join(ROOT, 'dist')) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${web.address().port}/`;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-clip-e2e-'));
fs.mkdirSync(path.join(userData, 'data'), { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-clip-home-'));
fs.writeFileSync(path.join(home, '.bashrc'), "PS1='PROMPT$ '\n");

const env = { ...process.env, VITE_DEV_SERVER_URL: URL_, TERMILAB_NO_DEVTOOLS: '1', SHELL: '/bin/bash', HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const elog = fs.openSync(path.join(SP, 'e2e-electron.log'), 'w');
log('logs and screenshot in', SP);
const child = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), ['.', `--user-data-dir=${userData}`, '--remote-debugging-port=9433', '--no-sandbox'],
  { cwd: ROOT, env, stdio: ['ignore', elog, elog] });

async function json(url) {
  for (let i = 0; i < 150; i++) { try { return await (await fetch(url)).json(); } catch (_) { await sleep(200); } }
  throw new Error(`no ${url}`);
}
class CDP {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.wait = new Map(); }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && this.wait.has(d.id)) { this.wait.get(d.id)(d); this.wait.delete(d.id); } };
    return this;
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => this.wait.set(id, r)); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  }
}

const HELPERS = `(() => {
  const ctx = () => {
    const root = document.getElementById('root');
    const key = Object.keys(root).find(k => k.startsWith('__reactContainer$'));
    const stack = [root[key].stateNode.current];
    while (stack.length) {
      const n = stack.pop(); if (!n) continue;
      const v = n.memoizedProps && n.memoizedProps.value;
      if (v && v.actions && v.dispatch && v.state) return v;
      if (n.sibling) stack.push(n.sibling); if (n.child) stack.push(n.child);
    }
    return null;
  };
  /* the xterm of the (only) terminal: TerminalView's first hook is termRef */
  const term = () => {
    const el = document.querySelector('.terminal-wrapper');
    if (!el) return null;
    let f = el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))];
    while (f) {
      let h = f.memoizedState;
      while (h && typeof h === 'object' && 'next' in h) {
        const c = h.memoizedState && h.memoizedState.current;
        if (c && c.buffer && c.buffer.active) return c;
        h = h.next;
      }
      f = f.return;
    }
    return null;
  };
  const lines = () => { const t = term(); const b = t.buffer.active; const out = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out; };
  const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch (_) {} await new Promise(r => setTimeout(r, 50)); } return null; };
  /* screen coordinates of cell (col,row-in-buffer), center */
  const cell = (col, bufRow) => { const t = term(); const s = document.querySelector('.xterm-screen').getBoundingClientRect();
    const cw = s.width / t.cols, ch = s.height / t.rows; const vr = bufRow - t.buffer.active.viewportY;
    return { x: Math.round(window.screenX + s.left + (col + 0.5) * cw), y: Math.round(window.screenY + s.top + (vr + 0.5) * ch) }; };
  window.__T = { ctx, term, lines, until, cell };
  return true;
})()`;

let c;
try {
  const targets = await (async () => {
    for (let i = 0; i < 150; i++) {
      const l = (await json('http://127.0.0.1:9433/json/list')).filter((t) => t.type === 'page' && t.url.startsWith(URL_));
      if (l.length) return l;
      await sleep(200);
    }
    throw new Error('no window');
  })();
  c = await new CDP(targets[0].webSocketDebuggerUrl).open();
  await c.send('Runtime.enable');
  for (let i = 0; i < 100; i++) { try { if (await c.ev(`!!document.getElementById('root') && document.readyState === 'complete'`)) break; } catch (_) {} await sleep(100); }
  await c.ev(HELPERS);
  await c.ev(`window.__T.until(() => { const v = window.__T.ctx(); return v && !v.state.loading; })`);
  await c.ev(`window.__T.ctx().actions.openLocalTerminal(), true`);
  const ready = await c.ev(`window.__T.until(() => window.__T.term() && window.__T.lines().some(l => /\\$ ?$/.test(l)), 20000)`);
  ok('local terminal opened with a shell prompt', !!ready);

  const screenText = () => c.ev(`window.__T.lines().join('\\n')`);
  const waitScreen = (re, ms = 8000) => c.ev(`window.__T.until(() => new RegExp(${JSON.stringify(re)}).test(window.__T.lines().join('\\n')), ${ms})`);
  const focusTerm = async () => {
    const p = await c.ev(`(() => { const t = window.__T.term(); return window.__T.cell(Math.floor(t.cols/2), t.buffer.active.viewportY + t.rows - 2); })()`);
    xdo('mousemove', String(p.x), String(p.y));
    xdo('click', '1');
    await sleep(150);
  };
  /* Evidence for the old path: navigator.clipboard vs Electron's clipboard, with and without focus */
  await clipSet('clipboard', 'probe-text');
  const probe = async (tag) => log('PROBE', tag, await c.ev(`(async () => {
    const nav = await navigator.clipboard.readText().then(t => 'ok:' + t, e => 'REJECT:' + e.name + ': ' + e.message);
    const ele = await window.electronAPI.clipboard.readText().then(t => 'ok:' + t, e => 'REJECT:' + e.message);
    return JSON.stringify({ hasFocus: document.hasFocus(), navigatorClipboard: nav, electronClipboard: ele });
  })()`));
  await probe('before any click');
  await focusTerm();
  await probe('after clicking the terminal');
  log('window', await c.ev(`JSON.stringify({sx: window.screenX, sy: window.screenY, cols: window.__T.term().cols, rows: window.__T.term().rows, focus: document.hasFocus(), active: document.activeElement && document.activeElement.className})`));

  /* T1 typing through the printable-key bypass (real key events) */
  xdo('type', '--delay', '20', 'echo tecleo-ok AbC');
  xdo('key', 'Return');
  ok('T1 typing (printable keys, Shift) reaches bash', !!(await waitScreen('\\ntecleo-ok AbC')));

  /* T2 copy-on-select (default on): real drag selection -> CLIPBOARD and PRIMARY + hint */
  xdo('type', '--delay', '10', "printf 'COPIA-%s   \\n' 4242");
  xdo('key', 'Return');
  await waitScreen('\\nCOPIA-4242');
  const row = await c.ev(`window.__T.lines().findIndex(l => l.startsWith('COPIA-4242'))`);
  const a = await c.ev(`window.__T.cell(0, ${row})`);
  const b = await c.ev(`window.__T.cell(15, ${row})`);
  await clipSet('clipboard', 'viejo');
  xdo('mousemove', String(a.x - 3), String(a.y));
  xdo('mousedown', '1');
  for (let x = a.x; x <= b.x; x += 12) xdo('mousemove', String(x), String(a.y));
  xdo('mousemove', String(b.x), String(b.y));
  xdo('mouseup', '1');
  await sleep(400);
  const hint = await c.ev(`!!document.querySelector('.terminal-copied-hint')`);
  ok('T2 drag-select copies on select: CLIPBOARD, trailing spaces trimmed', clipGet('clipboard') === 'COPIA-4242', JSON.stringify(clipGet('clipboard')));
  ok('T2 ... and Linux PRIMARY', clipGet('primary') === 'COPIA-4242', JSON.stringify(clipGet('primary')));
  ok('T2 ... and the "Copied" hint shows', hint);

  /* T3 middle-click pastes PRIMARY at the prompt */
  await focusTerm();
  await clipSet('primary', 'echo desde-primary');
  await focusTerm();   // a left click clears xterm's selection; PRIMARY stays xclip's
  const mid = await c.ev(`(() => { const t = window.__T.term(); return window.__T.cell(5, t.buffer.active.viewportY + 2); })()`);
  xdo('mousemove', String(mid.x), String(mid.y));
  xdo('click', '2');
  await sleep(300);
  xdo('key', 'Return');
  ok('T3 middle-click pastes PRIMARY (once)', !!(await waitScreen('\\ndesde-primary')) && !/desde-primarydesde/.test(await screenText()));

  /* Copy on select off: selecting only takes PRIMARY; Ctrl+Shift+C / Ctrl+Insert copy */
  await c.ev(`(() => { const v = window.__T.ctx(); return v.actions.saveSettings({ ...v.state.settings, terminal: { ...v.state.settings.terminal, copyOnSelect: false } }).then(() => true); })()`);
  await focusTerm();
  xdo('type', '--delay', '10', "echo SELECCION-77");
  xdo('key', 'Return');
  await waitScreen('\\nSELECCION-77');
  const row2 = await c.ev(`window.__T.lines().findIndex(l => l === 'SELECCION-77')`);
  const dbl = await c.ev(`window.__T.cell(3, ${row2})`);
  await clipSet('clipboard', 'sin-tocar');
  xdo('mousemove', String(dbl.x), String(dbl.y));
  xdo('click', '--repeat', '2', '--delay', '60', '1');   // double-click: word selection
  await sleep(400);
  ok('T4 copyOnSelect off: selecting leaves CLIPBOARD alone', clipGet('clipboard') === 'sin-tocar', JSON.stringify(clipGet('clipboard')));
  ok('T4 ... but PRIMARY gets it (X11 convention)', clipGet('primary') === 'SELECCION-77', JSON.stringify(clipGet('primary')));
  xdo('key', 'ctrl+shift+c');
  await sleep(300);
  ok('T5 Ctrl+Shift+C copies the selection', clipGet('clipboard') === 'SELECCION-77', JSON.stringify(clipGet('clipboard')));
  await clipSet('clipboard', 'otra-vez');
  xdo('mousemove', String(dbl.x), String(dbl.y));
  xdo('click', '--repeat', '2', '--delay', '60', '1');
  await sleep(300);
  xdo('key', 'ctrl+Insert');
  await sleep(300);
  ok('T6 Ctrl+Insert copies the selection', clipGet('clipboard') === 'SELECCION-77', JSON.stringify(clipGet('clipboard')));

  /* Pastes */
  await clipSet('clipboard', 'echo pegado-csv');
  await focusTerm();
  xdo('key', 'ctrl+shift+v');
  await sleep(300);
  xdo('key', 'Return');
  ok('T7 Ctrl+Shift+V pastes CLIPBOARD', !!(await waitScreen('\\npegado-csv')));
  await clipSet('clipboard', 'echo pegado-shift-insert');
  xdo('key', 'shift+Insert');
  await sleep(300);
  xdo('key', 'Return');
  ok('T8 Shift+Insert pastes CLIPBOARD', !!(await waitScreen('\\npegado-shift-insert')));
  await clipSet('clipboard', 'echo clic-derecho');
  const rc = await c.ev(`(() => { const t = window.__T.term(); return window.__T.cell(10, t.buffer.active.viewportY + 1); })()`);
  xdo('mousemove', String(rc.x), String(rc.y));
  xdo('click', '3');
  await sleep(300);
  xdo('key', 'Return');
  ok('T9 right-click without selection pastes', !!(await waitScreen('\\nclic-derecho')));

  /* Multi-line at the bash prompt: bracketed paste is on -> no question */
  await clipSet('clipboard', 'echo multi-uno\necho multi-dos\n');
  xdo('key', 'ctrl+shift+v');
  await sleep(500);
  const askedAtPrompt = await c.ev(`!!document.querySelector('.terminal-paste-confirm')`);
  ok('T10 multi-line paste into bash (bracketed paste on): no confirm', !askedAtPrompt);
  xdo('key', 'Return');
  ok('T10 ... both lines ran', !!(await waitScreen('\\nmulti-uno\\nmulti-dos\\n')));

  /* 200 lines into `wc -l` (no bracketed paste while it runs): confirm, then all lines arrive */
  const many = Array.from({ length: 200 }, (_, i) => `linea ${i} ñandú 😀 ${'z'.repeat(120 + (i % 40))}`).join('\n') + '\n';
  await clipSet('clipboard', many);
  xdo('type', '--delay', '10', 'wc -l -c');
  xdo('key', 'Return');
  await sleep(400);
  xdo('key', 'ctrl+shift+v');
  const ask = await c.ev(`window.__T.until(() => { const d = document.querySelector('.terminal-paste-confirm'); return d && d.innerText; }, 4000)`);
  ok('T11 "Paste 200 lines?" asked (wc has no bracketed paste)', !!ask && /Paste 200 lines\?/.test(ask), JSON.stringify(ask));
  const focusedBtn = await c.ev(`document.activeElement && document.activeElement.textContent`);
  xdo('key', 'Return');   // the Paste button has focus
  await sleep(1500);
  xdo('key', 'ctrl+d');
  const wcRe = `\\n\\s*200\\s+${Buffer.byteLength(many)}\\s*\\n`;
  ok(`T11 ... Enter pastes (focus on "${focusedBtn}"); wc -l -c = 200 ${Buffer.byteLength(many)}`, !!(await waitScreen(wcRe, 15000)),
    (await screenText()).split('\n').filter((l) => /^\s*\d+\s+\d+\s*$/.test(l)).join(' | '));

  /* Esc cancels */
  xdo('type', '--delay', '10', 'cat');
  xdo('key', 'Return');
  await sleep(300);
  await clipSet('clipboard', 'NO-DEBE-LLEGAR\nX\n');
  xdo('key', 'ctrl+shift+v');
  await c.ev(`window.__T.until(() => document.querySelector('.terminal-paste-confirm'), 4000)`);
  xdo('key', 'Escape');
  await sleep(500);
  const gone = await c.ev(`!document.querySelector('.terminal-paste-confirm')`);
  xdo('key', 'ctrl+d');
  await sleep(300);
  ok('T12 Esc cancels: nothing pasted', gone && !/NO-DEBE-LLEGAR/.test(await screenText()));

  /* Ctrl+C: with no selection it is ^C */
  await focusTerm();
  xdo('type', '--delay', '10', 'sleep 30');
  xdo('key', 'Return');
  await sleep(500);
  xdo('key', 'ctrl+c');
  await sleep(300);
  xdo('type', '--delay', '10', 'echo rc=$?');
  xdo('key', 'Return');
  ok('T13 Ctrl+C without selection interrupts (rc=130)', !!(await waitScreen('\\nrc=130')));

  /* Wrapped line: a real space in the last column survives copying */
  const cols = await c.ev(`window.__T.term().cols`);
  const longLine = 'A'.repeat(cols - 1) + ' ' + 'B'.repeat(10);
  xdo('type', '--delay', '2', `printf '%s\\n' '${longLine}'`);
  xdo('key', 'Return');
  await waitScreen('\\nB{10}\\n');
  const wrow = await c.ev(`window.__T.lines().findIndex(l => l.startsWith(${JSON.stringify('A'.repeat(cols - 1))}))`);
  const w = await c.ev(`window.__T.cell(4, ${wrow})`);
  xdo('mousemove', String(w.x), String(w.y));
  xdo('click', '--repeat', '3', '--delay', '60', '1');   // triple-click: the whole (wrapped) line
  await sleep(300);
  xdo('key', 'ctrl+shift+c');
  await sleep(300);
  ok('T14 triple-click a wrapped line + Ctrl+Shift+C = one line, space at the wrap kept', clipGet('clipboard') === longLine,
    JSON.stringify((clipGet('clipboard') || '').slice(cols - 4, cols + 4)));

  /* typing still works at the end */
  await focusTerm();
  xdo('type', '--delay', '20', 'echo fin ñ');
  xdo('key', 'Return');
  ok('T15 typing still works after everything', !!(await waitScreen('\\nfin')));

  fs.writeFileSync(path.join(SP, 'e2e-screen.txt'), await screenText());

  /* Another Termilab window takes the focus (Ctrl+Shift+N): the first one's
     document is no longer focused. Old path vs new path, in the first window. */
  await clipSet('clipboard', 'probe-text');
  xdo('key', 'ctrl+shift+n');
  for (let i = 0; i < 50; i++) {
    const l = (await json('http://127.0.0.1:9433/json/list')).filter((t) => t.type === 'page' && t.url.startsWith(URL_));
    if (l.length >= 2) break;
    await sleep(200);
  }
  await sleep(2000);
  await probe('first window, after a second window took the focus');
  const unf = await c.ev(`(async () => {
    const t = window.__T.term(); const before = window.__T.lines().join('\\n').length;
    /* the right-click path, run while unfocused */
    document.querySelector('.terminal-wrapper').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    await new Promise(r => setTimeout(r, 800));
    return window.__T.lines().some(l => l.includes('probe-text'));
  })()`);
  ok('T16 right-click paste works while the window is NOT focused (Electron clipboard)', unf);
  const png = await c.send('Page.captureScreenshot', { format: 'png' });
  if (png.result?.data) fs.writeFileSync(path.join(SP, 'e2e-final.png'), Buffer.from(png.result.data, 'base64'));
} catch (err) {
  ok('e2e ran', false, err.stack);
} finally {
  try { child.kill('SIGTERM'); } catch (_) {}
  await sleep(1000);
  try { child.kill('SIGKILL'); } catch (_) {}
  web.close();
  log('\n' + results.join('\n'));
  log(results.some((r) => r.startsWith('FAIL')) ? '\nFAILED' : '\nALL OK');
  process.exit(0);
}
