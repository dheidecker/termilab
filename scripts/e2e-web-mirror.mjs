// El espejo web de punta a punta (F3): Termilab real bajo xvfb, con un
// tailscale FALSO (TERMILAB_TAILSCALE_BIN) que dice "listo" y deja `serve`
// en primer plano sin hacer nada; el acceso remoto viene encendido en los
// settings, asi que el arranque (remoteAccess.resume) levanta el servidor web
// en 127.0.0.1:<PORT+1>. Delante, un proxy de prueba hace de `tailscale serve`:
// TCP en 127.0.0.1 → ese puerto, inyectando Tailscale-User-Login y el Host /
// Origin del tailnet. El proxy no es root, asi que el PC corre con
// TERMILAB_TEST_WEB_PEER_ROOT=1 (ver main.js): el control de uid del peer lo
// da por tailscaled. Solo esa variable lo activa, y solo sin empaquetar. El navegador es un segundo Electron SIN preload (una
// pagina web cualquiera) contra ese proxy.
//
//   npm run build && node scripts/e2e-web-mirror.mjs
//
//  M1 una terminal local abierta en el PC se ve en la web, con su historial.
//  M2 lo escrito en la web sale en el PC, y lo escrito en el PC en la web.
//  M3 una pestana local abierta desde la web aparece en el PC (sin cambiarle
//     la pestana activa), con su shell vivo.
//  M4 el PC ve al navegador conectado (web:clients) y el aviso.
//  M5 cerrar el navegador no mata ninguna sesion; el PC lo ve irse.
// HOME y userData temporales: no toca tu ~/.config/termilab. Nunca corre el
// tailscale de verdad.
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

async function main() {
  delete process.env.SSH_AUTH_SOCK;
  const base = fs.mkdtempSync('/tmp/tlwm-');   // short: the keeper socket must fit in sun_path
  const home = path.join(base, 'h');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.bash_profile'), `PS1='e2e\\$ '\nexport LANG=C.UTF-8\n`);
  fs.writeFileSync(path.join(home, '.bashrc'), `PS1='e2e\\$ '\n`);
  const fakeJs = path.join(base, 'fake-tailscale.js');
  const tsBin = path.join(base, 'tailscale');
  fs.writeFileSync(fakeJs, FAKE_TS);
  fs.writeFileSync(tsBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`, { mode: 0o755 });
  const userData = path.join(base, 'ud');
  fs.mkdirSync(path.join(userData, 'data'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(userData, 'data', 'settings.json'), JSON.stringify({ remoteAccess: { enabled: true, port: PORT, hostName: 'e2e-pc' } }));
  const browserMain = path.join(base, 'browser-main.cjs');
  fs.writeFileSync(browserMain, `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 1300, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
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
    const served = await P.waitFor(() => listening(BACKEND), 15000);
    ok('the stored "remote access on" started the web server on 127.0.0.1:<port+1> (resume → syncWebServer)', !!served, served ? '' : pc.log().slice(-1500));
    if (!served) return;
    proxy = await startProxy(BACKEND);
    const url = `http://127.0.0.1:${proxy.address().port}/`;

    /* A local terminal on the PC, with some history */
    await sleep(800);
    await P.ctrlT();
    ok('PC: local terminal opened', !!(await P.waitFor(async () => /e2e\$\s*$/m.test(await P.visibleText()), 20000)));
    await P.typeLine('echo HIST-$((20+1))');
    ok('PC: history line printed', !!(await P.waitFor(async () => /HIST-21/.test(await P.visibleText()), 8000)));

    /* Watch for the PC's notice before the browser connects */
    await P.ev(`(() => { window.__toasts = []; new MutationObserver(() => { for (const el of document.querySelectorAll('.termilab-toast')) if (!window.__toasts.includes(el.textContent)) window.__toasts.push(el.textContent); }).observe(document.body, { childList: true, subtree: true }); return true; })()`);

    br = launch([browserMain, `--user-data-dir=${path.join(base, 'bud')}`, `--remote-debugging-port=${CDP2}`], { MIRROR_URL: url });
    B = await cdpTo(CDP2, u => u.startsWith(url), br.log);
    const app = await B.waitFor(() => B.ev('!!document.querySelector(".app") && !!window.electronAPI && window.__termilabWeb === true'), 20000);
    ok('web: the app loaded in a plain browser page (no preload), over the gateway', !!app, app ? '' : br.log().slice(-1500));

    /* M4: the PC sees it */
    const clients = await P.waitFor(async () => { const c = await P.ev('window.electronAPI.web.clients()'); return c && c.length ? c : null; }, 8000);
    ok('M4 PC: web:clients lists the browser with its login and user agent', !!clients && clients[0].login === LOGIN && /Chrome|Electron/.test(clients[0].userAgent || ''), JSON.stringify(clients));
    const toast = await P.waitFor(async () => (await P.ev('window.__toasts')).find(t => /A browser connected: owner@example.com/.test(t)), 6000);
    ok('M4 PC: "A browser connected: <login>" notice', !!toast, JSON.stringify(await P.ev('window.__toasts')));

    /* M1: the PC's tab is in the web's tab bar; open it, the history is there */
    const tabShown = await B.waitFor(() => B.ev(`[...document.querySelectorAll('.tab:not(.tab-home)')].length === 1`), 10000);
    ok('M1 web: the PC\'s tab is mirrored in the tab bar', !!tabShown);
    await B.click(`document.querySelector('.tab:not(.tab-home)')`);
    const hist = await B.waitFor(async () => /HIST-21/.test(await B.visibleText()), 10000);
    ok('M1 web: the terminal shows the PC\'s history (join-screen)', !!hist, (await B.visibleText()).slice(-400));

    /* M2: both ways */
    await B.typeLine('echo FROM-WEB-$((40+2))');
    ok('M2 web → PC: what the browser typed runs, and the PC shows it', !!(await P.waitFor(async () => /FROM-WEB-42/.test(await P.visibleText()), 8000)), (await P.visibleText()).slice(-300));
    ok('M2 web: and the browser shows its own output', !!(await B.waitFor(async () => /FROM-WEB-42/.test(await B.visibleText()), 8000)));
    await P.typeLine('echo FROM-PC-$((50+5))');
    ok('M2 PC → web: what the PC typed shows in the browser', !!(await B.waitFor(async () => /FROM-PC-55/.test(await B.visibleText()), 8000)), (await B.visibleText()).slice(-300));

    /* M3: a new local tab from the web */
    const pcActive = await P.ev(`document.querySelector('.tab.active .tab-label') && document.querySelector('.tab.active .tab-label').textContent`);
    await B.ctrlT();
    const two = await P.waitFor(() => P.ev(`[...document.querySelectorAll('.tab:not(.tab-home)')].length === 2`), 10000);
    ok('M3 PC: the tab opened from the web appears on the PC', !!two);
    const webNew = await B.waitFor(() => B.ev(`[...document.querySelectorAll('.tab:not(.tab-home)')].length === 2 && document.querySelectorAll('.tab:not(.tab-home)')[1].classList.contains('active')`), 10000);
    ok('M3 web: …and opens in the browser, active there', !!webNew);
    const pcActiveAfter = await P.ev(`document.querySelector('.tab.active .tab-label') && document.querySelector('.tab.active .tab-label').textContent`);
    ok('M3 PC: its own active tab did not change', pcActive === pcActiveAfter, `${pcActive} → ${pcActiveAfter}`);
    const prompt = await B.waitFor(async () => /e2e\$\s*$/m.test(await B.visibleText()), 15000);
    ok('M3 web: the new tab has a live shell (spawned on the PC)', !!prompt, (await B.visibleText()).slice(-300));
    await B.typeLine('echo NEW-TAB-$((60+6))');
    ok('M3 the new tab runs on the PC (its hidden pane there has the output)', !!(await P.waitFor(async () => /NEW-TAB-66/.test(await P.allText()), 8000)));

    /* M5: the browser goes away; nothing ends */
    B.close();
    await br.close();
    br = null;
    const gone = await P.waitFor(async () => (await P.ev('window.electronAPI.web.clients()')).length === 0, 8000);
    ok('M5 PC: the browser left web:clients', !!gone);
    await sleep(500);
    ok('M5 PC: both tabs still there', await P.ev(`[...document.querySelectorAll('.tab:not(.tab-home)')].length === 2`));
    await P.typeLine('echo STILL-$((7*6))');
    ok('M5 PC: the session is alive after the browser closed', !!(await P.waitFor(async () => /STILL-42/.test(await P.visibleText()), 8000)));
    const text = await P.allText();
    ok('M5 PC: no "[Session ended]" anywhere', !/Session ended|Connection closed/.test(text));
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
  console.log(failed ? `\ne2e-web-mirror: ${failed} fallo(s) de ${results.length}` : `\ne2e-web-mirror: todo en verde (${results.length})`);
  process.exit(failed ? 1 : 0);
}

main();
