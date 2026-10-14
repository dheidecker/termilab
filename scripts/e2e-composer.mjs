// Prompt composer de punta a punta: Electron real + teclas X reales (xdotool,
// distribución latam, tecla muerta ´ por el IME de GTK). Linux. Corre DENTRO de
// xvfb-run:
//
//   npm run build
//   XDOTOOL=/ruta/xdotool XDO_LIB=/ruta/lib [CLAUDE=1] [SHOTS=/dir] \
//     xvfb-run -a -s '-screen 0 1600x1000x24' node scripts/e2e-composer.mjs
//
// Sin root: `apt-get download xdotool libxdo3`, `dpkg-deb -x` y
// XDO_LIB=<dir>/usr/lib/x86_64-linux-gnu. Usa un --user-data-dir temporal y TU
// $HOME (con CLAUDE=1 lanza el `claude` real en un directorio temporal: gasta
// una respuesta corta del modelo y apunta ese directorio como "de confianza").
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const SP = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-composer-out-'));
fs.mkdirSync(SP, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); log(results[results.length - 1]); };

const XDO_LIB = process.env.XDO_LIB || '';
const xdo = (...args) => execFileSync(process.env.XDOTOOL || 'xdotool', args, { env: { ...process.env, LD_LIBRARY_PATH: XDO_LIB } }).toString();
try { execFileSync('setxkbmap', ['latam']); } catch (e) { log('setxkbmap latam failed:', e.message); }

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

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-composer-e2e-'));
fs.mkdirSync(path.join(userData, 'data'), { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-composer-work-'));
const OUT = path.join(work, 'cat-out.txt');

const env = { ...process.env, VITE_DEV_SERVER_URL: URL_, TERMILAB_NO_DEVTOOLS: '1', SHELL: '/bin/bash' };
delete env.ELECTRON_RUN_AS_NODE;
/* run from inside Claude Code: its child-session markers would turn off the transcript K3 reads */
for (const k of Object.keys(env)) if (/^CLAUDE_?CODE/.test(k)) delete env[k];
const elog = fs.openSync(path.join(SP, 'e2e-electron.log'), 'w');
log('logs and screenshots in', SP);
const PORT = 9437;
const child = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'],
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
  const center = (sel) => { const r = document.querySelector(sel).getBoundingClientRect();
    return { x: Math.round(window.screenX + r.left + r.width / 2), y: Math.round(window.screenY + r.top + r.height / 2) }; };
  window.__T = { ctx, term, lines, until, center };
  return true;
})()`;

const readOut = () => { try { return fs.readFileSync(OUT, 'utf8'); } catch (_) { return null; } };
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(100); } return null; };

let c;
try {
  const targets = await (async () => {
    for (let i = 0; i < 150; i++) {
      const l = (await json(`http://127.0.0.1:${PORT}/json/list`)).filter((t) => t.type === 'page' && t.url.startsWith(URL_));
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
  /* no keeper: nothing outlives this run */
  await c.ev(`(() => { const v = window.__T.ctx(); return v.actions.saveSettings({ ...v.state.settings, terminal: { ...v.state.settings.terminal, keepSessions: false } }).then(() => true); })()`);
  await c.ev(`window.__T.ctx().actions.openLocalTerminal(), true`);
  await c.ev(`window.__T.until(() => window.__T.term() && window.__T.lines().some(l => l.trim()), 20000)`);
  await sleep(1500);

  const screenText = () => c.ev(`window.__T.lines().join('\\n')`);
  const waitScreen = (re, ms = 8000) => c.ev(`window.__T.until(() => new RegExp(${JSON.stringify(re)}).test(window.__T.lines().join('\\n')), ${ms})`);
  const click = async (sel) => { const p = await c.ev(`window.__T.center(${JSON.stringify(sel)})`); xdo('mousemove', String(p.x), String(p.y)); xdo('click', '1'); await sleep(200); };
  const active = () => c.ev(`document.activeElement && document.activeElement.className`);
  const composerValue = () => c.ev(`(document.querySelector('.composer-input') || {}).value ?? null`);
  const shot = async (name) => {
    const png = await c.send('Page.captureScreenshot', { format: 'png' });
    if (png.result?.data) fs.writeFileSync(path.join(SP, name), Buffer.from(png.result.data, 'base64'));
  };
  const setTheme = (t) => c.ev(`(() => { const v = window.__T.ctx(); return v.actions.saveSettings({ ...v.state.settings, appearance: { ...(v.state.settings.appearance || {}), theme: '${t}' } }).then(() => true); })()`);

  await click('.terminal-wrapper');
  xdo('type', '--delay', '15', "PS1='PROMPT$ '");
  xdo('key', 'Return');
  ok('shell prompt', !!(await waitScreen('PROMPT\\$\\s*$')));

  /* C1 a program with bracketed paste on, reading into a file */
  xdo('type', '--delay', '10', `printf '\\033[?2004h'; cat -v > ${OUT}`);
  xdo('key', 'Return');
  await sleep(600);
  ok('C1 cat -v running with bracketed paste mode on', await c.ev(`window.__T.term().modes.bracketedPasteMode`));

  /* C2 Ctrl+Shift+E opens the composer with the keyboard; xterm gets nothing */
  xdo('key', 'ctrl+shift+e');
  await sleep(400);
  ok('C2 Ctrl+Shift+E opens the composer and focuses it', /composer-input/.test(await active() || ''), await active());

  /* C3 three lines, with a dead-key accent and ñ, through the real IME */
  xdo('type', '--delay', '20', 'uno');
  xdo('key', 'Return');
  xdo('type', '--delay', '20', 'dos ');
  xdo('key', 'dead_acute');
  xdo('key', 'a');
  xdo('key', 'ntilde');
  xdo('key', 'Return');
  xdo('type', '--delay', '20', 'tres');
  await sleep(300);
  const v3 = await composerValue();
  ok('C3 composer got 3 lines incl. dead-key á and ñ', v3 === 'uno\ndos áñ\ntres', JSON.stringify(v3));
  ok('C3 ... and the terminal got nothing', readOut() === '' && !/uno/.test(await screenText()), JSON.stringify(readOut()));

  /* C4 editing: Ctrl+A selects all, Ctrl+Z undoes */
  xdo('key', 'ctrl+a');
  const selAll = await c.ev(`(() => { const t = document.querySelector('.composer-input'); return t.selectionStart === 0 && t.selectionEnd === t.value.length; })()`);
  xdo('key', 'End');
  xdo('type', 'X');
  xdo('key', 'ctrl+z');
  await sleep(200);
  ok('C4 Ctrl+A selects all, Ctrl+Z undoes', selAll && (await composerValue()) === 'uno\ndos áñ\ntres', JSON.stringify(await composerValue()));

  /* C5 Ctrl+Shift+E → keyboard back to xterm, composer stays; again → composer */
  xdo('key', 'ctrl+shift+e');
  await sleep(200);
  const inTerm = /xterm-helper-textarea/.test(await active() || '');
  xdo('key', 'ctrl+shift+e');
  await sleep(200);
  ok('C5 Ctrl+Shift+E toggles the keyboard terminal ↔ composer', inTerm && /composer-input/.test(await active() || ''));

  await shot('composer-dark.png');
  await setTheme('light');
  await sleep(500);
  await shot('composer-light.png');
  await setTheme('dark');
  await sleep(300);

  /* C6 Ctrl+Enter: one bracketed block, then Enter */
  xdo('key', 'ctrl+Return');
  const out = await waitFor(() => { const o = readOut(); return o && o.includes('201~') ? o : null; }, 4000);
  const want = '^[[200~uno\ndos M-CM-!M-CM-1\ntres^[[201~\n';
  ok('C6 program got ONE bracketed block + Enter', out === want, JSON.stringify(readOut()));
  ok('C6 ... composer closed, draft cleared, keyboard back in xterm', !(await c.ev(`!!document.querySelector('.composer')`))
    && /xterm-helper-textarea/.test(await active() || '') && (await c.ev(`Object.keys(localStorage).filter(k => k.startsWith('termilab.composer.draft.')).length`)) === 0);

  /* C7 Esc keeps the draft (memory + localStorage), the button reopens it */
  xdo('key', 'ctrl+shift+e');
  await sleep(300);
  xdo('type', '--delay', '15', 'borrador');
  xdo('key', 'Escape');
  await sleep(300);
  const closed = !(await c.ev(`!!document.querySelector('.composer')`));
  const stored = await c.ev(`Object.entries(localStorage).filter(([k]) => k.startsWith('termilab.composer.draft.')).map(([, v]) => v).join('|')`);
  await click('.composer-toggle');
  await sleep(300);
  ok('C7 Esc closes keeping the draft; the Compose button reopens it', closed && stored === 'borrador' && (await composerValue()) === 'borrador', JSON.stringify({ closed, stored }));
  xdo('key', 'ctrl+a');
  xdo('key', 'BackSpace');
  xdo('key', 'Escape');
  await sleep(200);
  ok('C7 ... nothing reached the program meanwhile', readOut() === want, JSON.stringify(readOut()));

  /* C8 Send Enter off: text only, no Enter */
  await click('.terminal-wrapper');
  xdo('key', 'ctrl+shift+e');
  await sleep(300);
  await click('.composer-enter input');
  xdo('type', '--delay', '15', 'sin-enter');
  await click('.composer-btn.primary');
  await sleep(800);
  ok('C8 Send Enter off: pasted, no Enter yet', readOut() === want, JSON.stringify(readOut()));
  xdo('key', 'Return');
  await waitFor(() => readOut() !== want, 2000);
  ok('C8 ... the line was waiting in the program', readOut() === `${want}^[[200~sin-enter^[[201~\n`, JSON.stringify(readOut()));
  /* back to the default */
  await c.ev(`localStorage.removeItem('termilab.composer.sendEnter'), true`);
  xdo('key', 'ctrl+d');
  await waitScreen('PROMPT\\$\\s*$');

  /* C9 an image pasted into the composer: saved, its path at the caret, in the composer only */
  await click('.terminal-wrapper');
  xdo('key', 'ctrl+shift+e');
  await sleep(300);
  xdo('type', '--delay', '15', 'mira ');
  const before = await screenText();
  await c.ev(`(() => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    document.querySelector('.composer-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  const withPath = await c.ev(`window.__T.until(() => { const v = document.querySelector('.composer-input').value; return /^mira \\/\\S+\\.png $/.test(v) && v; }, 6000)`);
  const p9 = withPath ? withPath.slice(5).trim() : '';
  ok('C9 pasted image → saved, path inserted in the composer', !!withPath && fs.existsSync(p9), JSON.stringify(withPath));
  ok('C9 ... the terminal got nothing', (await screenText()) === before);
  xdo('key', 'ctrl+a');
  xdo('key', 'BackSpace');
  xdo('key', 'Escape');
  await sleep(200);
  if (p9) try { fs.unlinkSync(p9); } catch (_) {}

  if (process.env.CLAUDE === '1') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-composer-claude-'));
    await click('.terminal-wrapper');
    xdo('type', '--delay', '10', `clear; cd ${dir} && claude`);
    xdo('key', 'Return');
    const trust = await waitScreen('(trust|Trust)', 30000);
    if (trust) { await sleep(800); xdo('key', 'Down'); await sleep(300); xdo('key', 'Return'); }
    ok('K1 claude started', !!(await waitScreen('Claude Code v[\\s\\S]*\\n❯', 40000)));
    await sleep(3000);
    xdo('key', 'ctrl+shift+e');
    await sleep(300);
    xdo('type', '--delay', '10', 'This is a test of a multi-line prompt.');
    xdo('key', 'Return');
    xdo('type', '--delay', '10', 'Do not use any tool.');
    xdo('key', 'Return');
    xdo('type', '--delay', '10', 'Reply with only the word OK');
    await shot('composer-claude-dark.png');
    await setTheme('light');
    await sleep(500);
    await shot('composer-claude-light.png');
    await setTheme('dark');
    await sleep(300);
    xdo('key', 'ctrl+Return');
    const answered = await waitScreen('\\n[⏺●] OK\\s*\\n', 90000);
    await sleep(1500);
    await shot('claude-answered.png');
    fs.writeFileSync(path.join(SP, 'claude-screen.txt'), await screenText());
    /* Claude's own transcript of this directory: exactly one user message, all 3 lines */
    const proj = path.join(os.homedir(), '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'));
    const files = fs.existsSync(proj) ? fs.readdirSync(proj).filter(f => f.endsWith('.jsonl')) : [];
    const users = [];
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(proj, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.type !== 'user' || !m.message) continue;
        const cont = m.message.content;
        const txt = typeof cont === 'string' ? cont : (Array.isArray(cont) ? cont.filter(p => p.type === 'text').map(p => p.text).join('') : '');
        if (txt && !/^<|Caveat:/.test(txt)) users.push(txt);
      }
    }
    fs.writeFileSync(path.join(SP, 'claude-user-messages.json'), JSON.stringify(users, null, 2));
    ok('K2 Claude answered OK', !!answered);
    const scr = await screenText();
    const count = (re) => (scr.match(re) || []).length;
    ok('K2 ... on screen: the 3 lines as one prompt, one answer', count(/^❯ This is a test of a multi-line prompt\.\s*\n {2}Do not use any tool\.\s*\n {2}Reply with only the word OK\s*$/mg) === 1 && count(/^[⏺●] OK\s*$/mg) === 1);
    ok('K3 Claude got ONE user message with the 3 lines', users.length === 1
      && users[0] === 'This is a test of a multi-line prompt.\nDo not use any tool.\nReply with only the word OK', JSON.stringify(users));
    xdo('key', 'ctrl+c'); await sleep(300); xdo('key', 'ctrl+c');
  }
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
