// El espejo web en pantallas de otro tamano (fix/web-responsive): Termilab
// real bajo xvfb como en e2e-web-mirror.mjs (tailscale FALSO, proxy de prueba
// haciendo de `tailscale serve`, TERMILAB_TEST_WEB_PEER_ROOT=1 solo sin
// empaquetar). El PC a 1600 px con una pestana de 4 paneles; el navegador
// (un segundo Electron SIN preload) a 1000 px y despues a 390x844.
//
//   npm run build && node scripts/e2e-web-responsive.mjs [carpeta-de-capturas]
//
//  R1 tras un clic (sin teclear) en un panel desde la web, el pty toma el
//     tamano del navegador: el PC lo sigue y `stty size` lo dice.
//  R2 sin clic, el xterm de la web cabe entero en su panel (escalado: su
//     rect no desborda el contenedor), con los cols/rows del PC.
//  R3 arrastrar un divisor en la web cambia el ancho local y no el layout
//     del PC; un mirror:state posterior sin cambio de estructura no lo revierte.
//  R4 Arrange panes en la web reparte en partes iguales solo localmente.
//  R5 a 390x844: un panel a la vez y el selector cambia entre los 4; nada
//     se desborda a lo ancho.
//  R6 un agente (falso) trabajando en un panel del PC: en la web ese panel
//     tiene el barrido activo ([data-agent-line="working"]) y, en el
//     telefono, su chip el punto de "trabajando".
// HOME y userData temporales. Nunca corre el tailscale de verdad, ni un
// Claude Code o Codex de verdad (el agente es un guion que dibuja su pantalla).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const ELECTRON = require('electron');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const LOGIN = 'owner@example.com';
const DNS = 'e2e-pc.tail1234.ts.net';
/* Not 7443: a real Termilab with remote access on would hold 7444 */
const PORT = 17443 + 2 * Math.floor(Math.random() * 500);
const BACKEND = PORT + 1;   // where the web server listens (tailscale.backendPort)

const results = [];
const ok = (name, cond, extra = '') => {
  results.push(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  console.log(results[results.length - 1]);
};

for (const f of ['dist/index.html', 'dist-web/index.html']) {
  if (!fs.existsSync(path.join(ROOT, f))) { console.error(`falta ${f}: npm run build`); process.exit(1); }
}

/* Every xterm of the page (hidden tabs included), via the React fiber of each .terminal-wrapper */
const TERMS = `(() => [...document.querySelectorAll('.terminal-wrapper')].map((el) => {
  let f = el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]; let t = null;
  while (f && !t) { let h = f.memoizedState; while (h && typeof h === 'object' && 'next' in h) { const c = h.memoizedState && h.memoizedState.current; if (c && c.buffer && c.buffer.active) { t = c; break; } h = h.next; } f = f.return; }
  return { t, visible: !!el.offsetParent };
}).filter(x => x.t))()`;
const TEXT_ALL = `${TERMS}.map(({ t }) => { const b = t.buffer.active; const o = []; for (let i = 0; i < b.length; i++) o.push(b.getLine(i).translateToString(true)); return o.join('\\n'); })`;
const VISIBLE = `(${TERMS}.find(x => x.visible) || {}).t`;

async function cdpTo(port, match, log) {
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    await sleep(300);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && match(t.url)); } catch (_) { /* not yet */ }
  }
  if (!target) throw new Error(`no page target on ${port}\n${log().slice(-2000)}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let cid = 0; const wait = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); const w = wait.get(d.id); if (w) { wait.delete(d.id); d.error ? w.reject(new Error(d.error.message)) : w.resolve(d.result); } });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const i = ++cid; wait.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
  /* A page still loading (or reloading) has no context yet: that is "not yet", not a failure */
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { let v = null; try { v = await fn(); } catch (_) { v = null; } if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(150); } };
  const allText = async () => ((await ev(TEXT_ALL)) || []).join('\n----\n');
  const visibleText = () => ev(`(() => { const t = ${VISIBLE}; if (!t) return ''; const b = t.buffer.active; const o = []; for (let i = 0; i < b.length; i++) o.push(b.getLine(i).translateToString(true)); return o.join('\\n'); })()`);
  const key = (k, code, vk, modifiers = 0, text) => cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) })
    .then(() => cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }));
  const typeLine = async (text) => {
    await ev(`(() => { const t = ${VISIBLE}; t.focus(); return true; })()`);
    await cdp('Input.insertText', { text });
    await key('Enter', 'Enter', 13, 0, '\r');
  };
  const click = async (selectorJs) => {
    const p = await ev(`(() => { const el = ${selectorJs}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!p) return false;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
    return true;
  };
  const ctrlT = async () => {
    await click(`document.querySelector('.tab.tab-home')`);
    await sleep(300);
    await ev('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
    await key('t', 'KeyT', 84, 2);
  };
  return { cdp, ev, waitFor, allText, visibleText, typeLine, click, ctrlT, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}

function launch(args, env) {
  const e = { ...process.env, TERMILAB_NO_DEVTOOLS: '1', ...env };
  delete e.VITE_DEV_SERVER_URL; delete e.ELECTRON_RUN_AS_NODE;
  const p = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', ELECTRON, ...args, '--no-sandbox'], { env: e, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = ''; p.stdout.on('data', d => { log += d; }); p.stderr.on('data', d => { log += d; });
  return {
    p,
    log: () => log,
    close: async () => {
      try { process.kill(-p.pid, 'SIGTERM'); } catch (_) { /* gone */ }
      for (let i = 0; i < 80 && p.exitCode === null; i++) await sleep(100);
      try { process.kill(-p.pid, 'SIGKILL'); } catch (_) { /* gone */ }
    },
  };
}

/* What `tailscale serve` does for the mirror: HTTPS on the tailnet →
   127.0.0.1:<PORT+1>, with the caller's identity. Here plain HTTP on loopback. */
function startProxy(backendPort) {
  const fix = (headers) => {
    const h = { ...headers, host: `${DNS}:${PORT}`, 'tailscale-user-login': LOGIN, 'tailscale-user-name': 'Owner' };
    if (h.origin) h.origin = `https://${DNS}:${PORT}`;
    return h;
  };
  const srv = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers: fix(req.headers) }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  srv.on('upgrade', (req, sock, head) => {
    const up = net.connect(backendPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(fix(req.headers))) lines.push(`${k}: ${v}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      sock.pipe(up); up.pipe(sock);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/** Does something accept TCP connections on 127.0.0.1:port? */
function listening(port) {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1');
    const done = (v) => { c.removeAllListeners(); c.on('error', () => {}); c.destroy(); resolve(v); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
  });
}

const FAKE_TS = String.raw`
const args = process.argv.slice(2);
const DNS = ${JSON.stringify(DNS)};
const out = (o) => process.stdout.write(JSON.stringify(o));
if (args[0] === 'status') {
  out({ BackendState: 'Running', Self: { UserID: 7, DNSName: DNS + '.', Tags: null }, User: { '7': { ID: 7, LoginName: ${JSON.stringify(LOGIN)} } }, CertDomains: [DNS] });
  process.exit(0);
}
if (args[0] === 'serve' && args[1] === 'status') { out({}); process.exit(0); }
if (args[0] === 'serve' && args.includes('off')) process.exit(0);
if (args[0] === 'serve') {
  process.stdout.write('Available within your tailnet:\n\nhttps://' + DNS + ':${PORT}/\n\nPress Ctrl+C to exit.\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else process.exit(0);
`;

/* One pane's overlay / xterm, by its tab id (the same on the PC and in the web) */
const PANE = (id) => `document.querySelector('.split-terminal-overlay[data-pane-id=${JSON.stringify(id)}]')`;
const TERM_OF = (id) => `(() => { const o = ${PANE(id)}; const el = o && o.querySelector('.terminal-wrapper'); if (!el) return null;
  let f = el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]; let t = null;
  while (f && !t) { let h = f.memoizedState; while (h && typeof h === 'object' && 'next' in h) { const c = h.memoizedState && h.memoizedState.current; if (c && c.buffer && c.buffer.active) { t = c; break; } h = h.next; } f = f.return; }
  return t; })()`;
const SHOWN = `[...document.querySelectorAll('.split-terminal-overlay')].filter(e => e.style.display !== 'none').sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left || a.getBoundingClientRect().top - b.getBoundingClientRect().top)`;

/* Draws a Claude Code-like screen with its spinner, forever: the agent scan
   reads "working". Not Claude Code: nothing is installed or run. */
const FAKE_AGENT = String.raw`
const ESC = '\x1b'; let n = 0;
const draw = () => {
  n++;
  const rule = '─'.repeat(Math.max(20, (process.stdout.columns || 80) - 1));
  process.stdout.write(ESC + '[2J' + ESC + '[H ▐▛███▛█   Claude Code v2.1.300\r\n\r\n✻ Choreographing… (' + n + 's · esc to interrupt)\r\n\r\n' + rule + '\r\n❯ \r\n' + rule + '\r\n  ⏸ manual mode on\r\n');
};
draw(); setInterval(draw, 400);
`;

async function main() {
  delete process.env.SSH_AUTH_SOCK;
  const shots = process.argv[2] || null;
  const base = fs.mkdtempSync('/tmp/tlwr-');
  const home = path.join(base, 'h');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.bash_profile'), `PS1='e2e\\$ '\nexport LANG=C.UTF-8\n`);
  fs.writeFileSync(path.join(home, '.bashrc'), `PS1='e2e\\$ '\n`);
  const fakeJs = path.join(base, 'fake-tailscale.js');
  const tsBin = path.join(base, 'tailscale');
  fs.writeFileSync(fakeJs, FAKE_TS);
  fs.writeFileSync(tsBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`, { mode: 0o755 });
  const agentJs = path.join(base, 'agent.cjs');
  fs.writeFileSync(agentJs, FAKE_AGENT);
  const userData = path.join(base, 'ud');
  fs.mkdirSync(path.join(userData, 'data'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(userData, 'data', 'settings.json'), JSON.stringify({ remoteAccess: { enabled: true, port: PORT, hostName: 'e2e-pc' } }));
  const browserMain = path.join(base, 'browser-main.cjs');
  fs.writeFileSync(browserMain, `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 1000, height: 800, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  w.loadURL(process.env.MIRROR_URL);
});
app.on('window-all-closed', () => app.quit());
`);

  let pc = null; let br = null; let proxy = null; let P = null; let B = null;
  try {
    const CDP1 = 19000 + Math.floor(Math.random() * 500);
    const CDP2 = CDP1 + 500;
    pc = launch([ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${CDP1}`], { HOME: home, SHELL: '/bin/bash', LANG: 'C.UTF-8', TERMILAB_TAILSCALE_BIN: tsBin, TERMILAB_TEST_WEB_PEER_ROOT: '1' });
    P = await cdpTo(CDP1, u => u.endsWith('/dist/index.html'), pc.log);
    await P.waitFor(() => P.ev('!!document.querySelector(".app")'));
    /* The PC: a 1600 px wide window */
    await P.cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
    const served = await P.waitFor(() => listening(BACKEND), 15000);
    ok('the web server is up (remote access on in settings)', !!served, served ? '' : pc.log().slice(-1500));
    if (!served) return;
    proxy = await startProxy(BACKEND);
    const url = `http://127.0.0.1:${proxy.address().port}/`;

    /* A tab with 4 panes side by side, equal, each with its own colour */
    await sleep(800);
    await P.ctrlT();
    ok('PC: local terminal opened', !!(await P.waitFor(async () => /e2e\$\s*$/m.test(await P.visibleText()), 20000)));
    for (let i = 0; i < 3; i++) {
      const done = await P.ev(`(() => { const o = ${SHOWN}.pop(); const b = o && o.querySelector('button[title="Split Right"]'); if (!b) return false; b.click(); return true; })()`);
      if (!done) throw new Error('no Split Right button');
      await P.waitFor(() => P.ev(`${SHOWN}.length === ${i + 2}`), 8000);
    }
    await P.ev(`document.querySelector('.arrange-btn').click()`);
    await sleep(500);
    const ids = await P.ev(`${SHOWN}.map(e => e.dataset.paneId)`);
    ok('PC: 4 panes side by side', ids.length === 4, JSON.stringify(ids));
    const COLORS = [1, 3, 5, 7];
    for (let i = 0; i < ids.length; i++) {
      await P.ev(`${PANE(ids[i])}.querySelector('.pane-color-btn').click()`);
      await P.waitFor(() => P.ev(`!!document.querySelector('.color-popover .color-swatch')`), 3000);
      await P.ev(`(() => { const s = [...document.querySelectorAll('.color-popover .color-swatch:not(.none)')]; s[${COLORS[i]} % s.length].click(); return true; })()`);
      await P.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(200);
    }
    const prompts = await P.waitFor(async () => {
      const t = await P.ev(`[${ids.map(id => `(${TERM_OF(id)})`).join(',')}].map(t => { const b = t.buffer.active; const o = []; for (let i = 0; i < b.length; i++) o.push(b.getLine(i).translateToString(true)); return o.join('\\n'); })`);
      return t.every(x => /e2e\$/.test(x));
    }, 20000);
    ok('PC: every pane has its shell', !!prompts);
    const pcCols0 = await P.ev(`[${ids.map(id => `(${TERM_OF(id)}).cols`).join(',')}]`);
    const pcRects0 = await P.ev(`${SHOWN}.map(e => Math.round(e.getBoundingClientRect().width))`);

    /* The fake agent in pane 4, typed on the PC (nobody is watching yet) */
    await P.ev(`(${TERM_OF(ids[3])}).focus()`);
    await P.cdp('Input.insertText', { text: `${process.execPath} ${agentJs}` });
    await P.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await P.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const pcWorking = await P.waitFor(() => P.ev(`!!${PANE(ids[3])}.querySelector('[data-agent-line="working"]')`), 15000);
    ok('PC: the fake agent shows as working on its pane', !!pcWorking);

    /* The browser, 1000 px */
    br = launch([browserMain, `--user-data-dir=${path.join(base, 'bud')}`, `--remote-debugging-port=${CDP2}`], { MIRROR_URL: url });
    B = await cdpTo(CDP2, u => u.startsWith(url), br.log);
    const app = await B.waitFor(() => B.ev('!!document.querySelector(".app") && window.__termilabWeb === true'), 20000);
    ok('web: the app loaded', !!app, app ? '' : br.log().slice(-1500));
    await B.cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    await B.waitFor(() => B.ev(`!!document.querySelector('.tab:not(.tab-home)')`), 10000);
    await B.ev(`document.querySelector('.tab:not(.tab-home)').click()`);
    const four = await B.waitFor(() => B.ev(`${SHOWN}.length === 4`), 10000);
    ok('web: the tab shows its 4 panes', !!four, String(await B.ev(`${SHOWN}.length`)));
    await sleep(1500);

    /* R2: nobody clicked: each web xterm keeps the PC's cols/rows, scaled into its pane */
    const fit = await B.waitFor(async () => {
      const r = await B.ev(`[${ids.map(id => `(() => { const o = ${PANE(id)}; const w = o.querySelector('.terminal-wrapper'); const x = w.querySelector('.xterm'); const a = w.getBoundingClientRect(); const b = x.getBoundingClientRect(); const t = ${TERM_OF(id)};
        const sc = x.querySelector('.xterm-screen');
        return { fits: b.right <= a.right + 1 && b.bottom <= a.bottom + 1 && b.left >= a.left - 1 && b.top >= a.top - 1, transform: x.style.transform, cols: t.cols, rows: t.rows, w: Math.round(b.width), h: Math.round(b.height), box: Math.round(a.width), boxH: Math.round(a.height), sw: sc.offsetWidth, sh: sc.offsetHeight }; })()`).join(',')}]`);
      return r.every((p, i) => p.fits && p.cols === pcCols0[i]) ? r : null;
    }, 8000);
    const fitNow = fit || await B.ev(`[${ids.map(id => `(() => { const o = ${PANE(id)}; const w = o.querySelector('.terminal-wrapper'); const x = w.querySelector('.xterm'); const a = w.getBoundingClientRect(); const b = x.getBoundingClientRect(); const t = ${TERM_OF(id)}; return { cols: t.cols, transform: x.style.transform, xr: Math.round(b.right), wr: Math.round(a.right) }; })()`).join(',')}]`);
    ok('R2 without a click every web xterm fits whole in its pane, at the PC\'s cols (scaled)', !!fit && fit.every(p => /scale\(/.test(p.transform)), JSON.stringify(fitNow));

    /* R6 at 1000 px: the agent's sweep on pane 4's header, from the PC's state */
    const webWorking = await B.waitFor(() => B.ev(`!!${PANE(ids[3])}.querySelector('[data-agent-line="working"]')`), 15000);
    ok('R6 web: the agent working on the PC sweeps pane 4\'s title ([data-agent-line="working"])', !!webWorking);

    /* R1: one click (no key) in pane 2 from the web: the pty takes the browser's size */
    const p2 = await B.ev(`(() => { const r = ${PANE(ids[1])}.querySelector('.terminal-wrapper').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await B.cdp('Input.dispatchMouseEvent', { type, x: p2.x, y: p2.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
    const followed = await B.waitFor(async () => {
      const w = await B.ev(`(() => { const t = ${TERM_OF(ids[1])}; const x = ${PANE(ids[1])}.querySelector('.xterm'); return { cols: t.cols, rows: t.rows, transform: x.style.transform }; })()`);
      const pcT = await P.ev(`(() => { const t = ${TERM_OF(ids[1])}; return { cols: t.cols, rows: t.rows }; })()`);
      return w.cols !== pcCols0[1] && !w.transform && pcT.cols === w.cols && pcT.rows === w.rows ? w : null;
    }, 8000);
    ok('R1 a click in a web pane makes it conduct: unscaled, its own size, and the PC follows it', !!followed,
      JSON.stringify({ before: pcCols0[1], web: await B.ev(`(${TERM_OF(ids[1])}).cols`), pc: await P.ev(`(${TERM_OF(ids[1])}).cols`) }));
    const pcScaled = await P.ev(`${PANE(ids[1])}.querySelector('.xterm').style.transform`);
    ok('R1 PC: its pane now follows the browser and is scaled to fit too (or fits as is)', followed ? (/scale\(/.test(pcScaled) || followed.cols <= pcCols0[1]) : false, pcScaled);
    const focused = await B.ev(`(() => { const o = document.activeElement && document.activeElement.closest('.split-terminal-overlay'); return o ? o.dataset.paneId : null; })()`);
    ok('R1 the click also gave that pane the keyboard', focused === ids[1], String(focused));
    if (followed) {
      await B.ev(`(${TERM_OF(ids[1])}).focus()`);
      await B.cdp('Input.insertText', { text: 'stty size' });
      await B.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await B.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      const want = `${followed.rows} ${followed.cols}`;
      const stty = await B.waitFor(async () => (await B.ev(`(() => { const b = (${TERM_OF(ids[1])}).buffer.active; const o = []; for (let i = 0; i < b.length; i++) o.push(b.getLine(i).translateToString(true)); return o.join('\\n'); })()`)).split('\n').some(l => l.trim() === want), 8000);
      ok(`R1 stty size in that pty says the browser's size (${want})`, !!stty, stty ? '' : (await B.ev(`(() => { const b = (${TERM_OF(ids[1])}).buffer.active; const o = []; for (let i = 0; i < b.length; i++) o.push(b.getLine(i).translateToString(true)); return o.join('|'); })()`)).replace(/\|+/g, '|').slice(-300));
    }

    /* R3: drag the middle divider in the web */
    const widths = (C) => C.ev(`${SHOWN}.map(e => Math.round(e.getBoundingClientRect().width))`);
    const web0 = await widths(B);
    const div = await B.ev(`(() => { const d = document.querySelector('.split-skeleton > .split-container > .split-divider'); const r = d.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await B.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: div.x, y: div.y, button: 'none' });
    await B.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: div.x, y: div.y, button: 'left', clickCount: 1 });
    for (let k = 1; k <= 5; k++) await B.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: div.x + 30 * k, y: div.y, button: 'left' });
    await B.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: div.x + 150, y: div.y, button: 'left', clickCount: 1 });
    await sleep(600);
    const web1 = await widths(B);
    const pc1 = await widths(P);
    ok('R3 dragging a divider in the web changes the local widths', web1[0] > web0[0] + 40, `${web0} → ${web1}`);
    ok('R3 …and not the PC\'s layout', JSON.stringify(pc1) === JSON.stringify(pcRects0), `${pcRects0} → ${pc1}`);
    /* A new mirror:state with the same structure (a mute toggled on the PC) */
    await B.ev(`window.electronAPI.mirror.command({ type: 'mute', tabId: ${JSON.stringify(ids[0])}, muted: true })`);
    const muted = await B.waitFor(async () => (await B.ev('window.electronAPI.mirror.state()')).tabs.find(t => t.id === ids[0]).muted, 5000);
    await sleep(800);
    const web2 = await widths(B);
    ok('R3 a later mirror:state without a structure change keeps the local widths', !!muted && JSON.stringify(web2) === JSON.stringify(web1), `${web1} → ${web2}`);
    await B.ev(`window.electronAPI.mirror.command({ type: 'mute', tabId: ${JSON.stringify(ids[0])}, muted: false })`);

    /* R4: Arrange panes in the web: equal, locally only */
    const shownBtn = await B.ev(`!!document.querySelector('.arrange-btn') && !document.querySelector('.arrange-btn').disabled`);
    ok('R4 the Arrange panes button is there in the web', shownBtn);
    await B.ev(`document.querySelector('.arrange-btn').click()`);
    await sleep(600);
    const web3 = await widths(B);
    ok('R4 Arrange panes in the web: 4 equal widths', Math.max(...web3) - Math.min(...web3) <= 3, String(web3));
    await sleep(500);
    const pc3 = await widths(P);
    ok('R4 …and the PC\'s layout did not move', JSON.stringify(pc3) === JSON.stringify(pcRects0), `${pcRects0} → ${pc3}`);
    if (shots) await shot(B, path.join(shots, 'web-1000.png'));

    /* R5: a phone, 390x844 */
    await B.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const chips = await B.waitFor(() => B.ev(`document.querySelectorAll('.pane-picker .pane-chip').length === 4 && ${SHOWN}.length === 1`), 6000);
    ok('R5 390 px: one pane at a time, and a selector with the 4 panes', !!chips, JSON.stringify(await B.ev(`({ chips: document.querySelectorAll('.pane-chip').length, shown: ${SHOWN}.length })`)));
    await B.ev(`document.querySelector('.pane-chip[data-pane-chip=${JSON.stringify(ids[2])}]').click()`);
    const third = await B.waitFor(() => B.ev(`${SHOWN}.length === 1 && ${SHOWN}[0].dataset.paneId === ${JSON.stringify(ids[2])}`), 4000);
    ok('R5 picking the 3rd chip shows the 3rd pane, alone', !!third);
    await B.ev(`document.querySelector('.pane-chip[data-pane-chip=${JSON.stringify(ids[0])}]').click()`);
    const first = await B.waitFor(() => B.ev(`${SHOWN}.length === 1 && ${SHOWN}[0].dataset.paneId === ${JSON.stringify(ids[0])}`), 4000);
    ok('R5 …and back to the 1st', !!first);
    const full = await B.ev(`(() => { const r = ${SHOWN}[0].getBoundingClientRect(); return Math.round(r.width); })()`);
    ok('R5 the pane takes the whole width', full >= 380, String(full));
    const chipAgent = await B.waitFor(() => B.ev(`!!document.querySelector('.pane-chip[data-pane-chip=${JSON.stringify(ids[3])}] [data-chip-agent="working"]')`), 5000);
    ok('R6 390 px: pane 4\'s chip shows its agent working (hidden pane)', !!chipAgent);
    const over = await B.ev(`(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, wide: [...document.querySelectorAll('.titlebar, .tab-bar, .pc-switcher, .compose-btn, .pane-picker, .app > *')].filter(e => e.offsetParent !== null && e.getBoundingClientRect().right > innerWidth + 1).map(e => e.className) }))()`);
    ok('R5 nothing overflows sideways at 390 px (top bar, PC selector, Compose)', over.doc <= 390 && over.body <= 390 && !over.wide.length, JSON.stringify(over));
    /* Tapping the shown pane: it conducts at the phone's size */
    const p1 = await B.ev(`(() => { const r = ${SHOWN}[0].querySelector('.terminal-wrapper').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await B.cdp('Input.dispatchMouseEvent', { type, x: p1.x, y: p1.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
    const phone = await B.waitFor(async () => {
      const w = await B.ev(`(${TERM_OF(ids[0])}).cols`);
      const pcT = await P.ev(`(${TERM_OF(ids[0])}).cols`);
      return w === pcT && w < pcCols0[0] ? w : null;
    }, 6000);
    ok('R5 a tap on the phone\'s pane gives the pty the phone\'s width', !!phone, String(phone));
    await sleep(400);
    if (shots) await shot(B, path.join(shots, 'web-390.png'));
  } catch (err) {
    ok('e2e ran without throwing', false, err && err.stack);
    if (pc) console.log(pc.log().slice(-2000));
  } finally {
    if (B) B.close();
    if (P) P.close();
    if (br) await br.close();
    if (pc) await pc.close();
    if (proxy) proxy.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(failed ? `\ne2e-web-responsive: ${failed} fallo(s) de ${results.length}` : `\ne2e-web-responsive: todo en verde (${results.length})`);
  process.exit(failed ? 1 : 0);
}

async function shot(C, file) {
  const r = await C.cdp('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
}

main();
