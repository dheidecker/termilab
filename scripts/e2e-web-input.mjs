// Teclado, portapapeles y Compose en el espejo web (F4b). El mismo montaje que
// e2e-web-mirror.mjs: Termilab real bajo xvfb, tailscale falso, un proxy de
// prueba haciendo de `tailscale serve` y un segundo Electron SIN preload como
// navegador, cada uno en su display X (dos portapapeles distintos).
//
//   npm run build && node scripts/e2e-web-input.mjs
//
//  W1 Alt+Shift+T en la web abre una pestana local, que aparece en el PC.
//  W2 Ctrl+W en la web no cierra la pestana: llega a la shell (borra palabra).
//  W3 copiar una seleccion en la web la deja en navigator.clipboard (no en el PC).
//  W4 pegar (Ctrl+Shift+V) escribe en la terminal y el PC lo ve.
//  W5 adjuntar una imagen en Compose (boton, pegar) escribe una ruta que existe
//     en el PC; soltarla en el panel la escribe en la terminal.
//  W6 OSC 52 solo lo aplica el cliente que escribio por ultimo (el conductor).
//  W7 cerrar la pestana del navegador con terminales abiertas pide confirmar.
// HOME y userData temporales: no toca tu ~/.config/termilab.
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
  return { cdp, ev, key, waitFor, allText, visibleText, typeLine, click, ctrlT, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
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
  const base = fs.mkdtempSync('/tmp/tlwi-');   // short: the keeper socket must fit in sun_path
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
  /* The "browser": a plain page. Clipboard permissions granted (what the
     user's "Allow" does in Chrome); a beforeunload prompt is logged. */
  fs.writeFileSync(browserMain, `const { app, BrowserWindow, session } = require('electron');
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);
  const w = new BrowserWindow({ width: 1300, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  w.webContents.on('will-prevent-unload', () => { console.log('E2E-WILL-PREVENT-UNLOAD'); });
  w.loadURL(process.env.MIRROR_URL);
});
app.on('window-all-closed', () => app.quit());
`);
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const pngFile = path.join(base, 'tiny.png');
  fs.writeFileSync(pngFile, Buffer.from(PNG_B64, 'base64'));
  const osc52 = (text) => `printf '\\033]52;c;%s\\007' $(printf ${text} | base64)`;

  let pc = null; let br = null; let proxy = null; let P = null; let B = null;
  try {
    const CDP1 = 21000 + Math.floor(Math.random() * 500);
    const CDP2 = CDP1 + 500;
    pc = launch([ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${CDP1}`], { HOME: home, SHELL: '/bin/bash', LANG: 'C.UTF-8', TERMILAB_TAILSCALE_BIN: tsBin, TERMILAB_TEST_WEB_PEER_ROOT: '1' });
    P = await cdpTo(CDP1, u => u.endsWith('/dist/index.html'), pc.log);
    await P.waitFor(() => P.ev('!!document.querySelector(".app")'));
    const served = await P.waitFor(() => listening(BACKEND), 15000);
    ok('the web server is up on 127.0.0.1:<port+1>', !!served, served ? '' : pc.log().slice(-1500));
    if (!served) return;
    proxy = await startProxy(BACKEND);
    const url = `http://127.0.0.1:${proxy.address().port}/`;

    await sleep(800);
    await P.ctrlT();
    ok('PC: local terminal opened', !!(await P.waitFor(async () => /e2e\$\s*$/m.test(await P.visibleText()), 20000)));

    br = launch([browserMain, `--user-data-dir=${path.join(base, 'bud')}`, `--remote-debugging-port=${CDP2}`], { MIRROR_URL: url });
    B = await cdpTo(CDP2, u => u.startsWith(url), br.log);
    const app = await B.waitFor(() => B.ev('!!document.querySelector(".app") && window.__termilabWeb === true'), 20000);
    ok('web: the app loaded over the gateway', !!app, app ? '' : br.log().slice(-1500));
    const pcTabs = () => P.ev(`[...document.querySelectorAll('.tab:not(.tab-home)')].length`);
    const webTabs = () => B.ev(`[...document.querySelectorAll('.tab:not(.tab-home)')].length`);
    const focusWeb = () => B.ev(`(() => { const t = ${VISIBLE}; t.focus(); return true; })()`);
    const webClip = () => B.ev(`navigator.clipboard.readText().catch(e => 'ERR ' + e.message)`);
    const pcClip = () => P.ev(`window.electronAPI.clipboard.readText('clipboard')`);
    await B.waitFor(async () => (await webTabs()) === 1, 10000);
    ok('web: the full screen button is in the title bar', await B.ev(`!!document.querySelector('.titlebar .web-fullscreen-btn')`));
    ok('PC: no full screen button on the desktop', await P.ev(`!document.querySelector('.web-fullscreen-btn')`));

    /* W1 Alt+Shift+T (Alt=1 + Shift=8) from the terminal of the mirrored tab */
    await B.click(`document.querySelector('.tab:not(.tab-home)')`);
    await B.waitFor(async () => /e2e\$\s*$/m.test(await B.visibleText()), 10000);
    await focusWeb();
    const beforeT = await B.visibleText();
    await B.key('T', 'KeyT', 84, 9);
    const two = await P.waitFor(async () => (await pcTabs()) === 2, 10000);
    ok('W1 Alt+Shift+T in the web opens a local tab, and it appears on the PC', !!two);
    ok('W1 ... and in the web, active there', !!(await B.waitFor(() => B.ev(`[...document.querySelectorAll('.tab:not(.tab-home)')].length === 2 && document.querySelectorAll('.tab:not(.tab-home)')[1].classList.contains('active')`), 10000)));
    ok('W1 ... with a live shell', !!(await B.waitFor(async () => /e2e\$\s*$/m.test(await B.visibleText()), 15000)));
    await B.click(`document.querySelectorAll('.tab:not(.tab-home)')[0]`);
    await sleep(500);
    ok('W1 the first tab\'s shell did not get the key (no ESC T typed)', (await B.visibleText()).trimEnd() === beforeT.trimEnd(), JSON.stringify((await B.visibleText()).slice(-120)));
    await B.click(`document.querySelectorAll('.tab:not(.tab-home)')[1]`);
    await sleep(300);

    /* W2 Ctrl+W: never closes the app tab in the web; the shell gets ^W */
    await focusWeb();
    await B.cdp('Input.insertText', { text: 'echo KEEP-W2 dropme' });
    await sleep(300);
    await B.key('w', 'KeyW', 87, 2);
    await sleep(300);
    await B.key('Enter', 'Enter', 13, 0, '\r');
    await sleep(1200);
    ok('W2 Ctrl+W in the web does not close the tab (web and PC keep 2)', (await webTabs()) === 2 && (await pcTabs()) === 2, `${await webTabs()} / ${await pcTabs()}`);
    const w2 = await P.waitFor(async () => /^KEEP-W2\s*$/m.test(await P.allText()), 6000);
    ok('W2 ... it reached the shell as delete-word (KEEP-W2 printed, "dropme" erased)', !!w2, (await B.visibleText()).slice(-200));

    /* W3 copy a selection in the web: Ctrl+Shift+C → navigator.clipboard */
    await B.typeLine('echo SEL-$((6*7))-OK');
    await B.waitFor(async () => /^SEL-42-OK$/m.test(await B.visibleText()), 6000);
    const pcClipBefore = await pcClip();
    const selected = await B.ev(`(() => { const t = ${VISIBLE}; const b = t.buffer.active; for (let i = b.length - 1; i >= 0; i--) { const s = b.getLine(i).translateToString(true); if (s === 'SEL-42-OK') { t.select(0, i, 9); return t.getSelection(); } } return null; })()`);
    await B.key('C', 'KeyC', 67, 2 + 8);
    const clip = await B.waitFor(async () => (await webClip()) === 'SEL-42-OK', 5000);
    ok('W3 copying a selection in the web puts it in navigator.clipboard', !!clip && selected === 'SEL-42-OK', `${selected} → ${await webClip()}`);
    ok('W3 ... not in the PC\'s clipboard', (await pcClip()) === pcClipBefore);

    /* W4 paste: Ctrl+Shift+V types the browser's clipboard, the PC sees it */
    await B.ev(`navigator.clipboard.writeText('echo PASTED-$((3*3))-WEB').then(() => true)`);
    await focusWeb();
    await B.key('V', 'KeyV', 86, 2 + 8);
    await sleep(500);
    await B.key('Enter', 'Enter', 13, 0, '\r');
    ok('W4 pasting in the web types into the terminal, and the PC sees it', !!(await P.waitFor(async () => /^PASTED-9-WEB$/m.test(await P.allText()), 8000)), (await B.visibleText()).slice(-200));

    /* W5 Compose: the attach button (a File without a path → bytes → attach:save-local) */
    await focusWeb();
    await B.key('E', 'KeyE', 69, 2 + 8);
    const composer = await B.waitFor(() => B.ev(`!!document.querySelector('.composer-input') && !!document.querySelector('.composer input[type=file]')`), 5000);
    ok('W5 web: Ctrl+Shift+E opens the composer', !!composer);
    const doc = await B.cdp('DOM.getDocument', { depth: -1 });
    const { nodeId } = await B.cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.composer input[type=file]' });
    await B.cdp('DOM.setFileInputFiles', { nodeId, files: [pngFile] });
    const v1 = await B.waitFor(async () => { const v = await B.ev(`document.querySelector('.composer-input').value`); return /\/\S+\.png\s*$/.test(v) ? v : null; }, 8000);
    const p1 = v1 ? v1.trim().split(/\s+/).pop() : '';
    ok('W5 attach button: a path that exists on the PC goes into the composer', !!v1 && p1.startsWith(home) && fs.existsSync(p1), JSON.stringify(v1));
    ok('W5 ... with the image\'s bytes', !!p1 && fs.existsSync(p1) && fs.readFileSync(p1).equals(fs.readFileSync(pngFile)));

    /* …pasting an image into the composer */
    await B.ev(`(() => {
      const bytes = Uint8Array.from(atob('${PNG_B64}'), ch => ch.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      document.querySelector('.composer-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    const v2 = await B.waitFor(async () => { const v = await B.ev(`document.querySelector('.composer-input').value`); const m = v.match(/\/\S+\.png/g); return m && m.length >= 2 ? m : null; }, 8000);
    ok('W5 pasting an image into the composer: its path on the PC goes in too', !!v2 && fs.existsSync(v2[1]), JSON.stringify(v2));
    await B.key('Escape', 'Escape', 27);
    await sleep(300);

    /* …dropping an image file on the pane types its path in the terminal */
    await B.ev(`(() => {
      const bytes = Uint8Array.from(atob('${PNG_B64}'), ch => ch.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
      const el = [...document.querySelectorAll('.terminal-container')].find(e => e.offsetParent);
      for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    const dropped = await P.waitFor(async () => { const m = (await P.allText()).match(/\/\S*dropped\S*\.png/); return m ? m[0] : null; }, 8000);
    ok('W5 dropping an image on the web pane types a path the PC has (seen on the PC)', !!dropped && fs.existsSync(dropped), String(dropped));
    await focusWeb();
    await B.key('u', 'KeyU', 85, 2);   // ^U: clear the line
    await sleep(300);

    /* W6 OSC 52: only the client that typed last applies it */
    await B.typeLine(osc52('OSC-FROM-WEB'));
    const webGot = await B.waitFor(async () => (await webClip()) === 'OSC-FROM-WEB', 6000);
    ok('W6 OSC 52 after the browser typed: the browser\'s clipboard has it', !!webGot, await webClip());
    await sleep(500);
    ok('W6 ... the PC did not take it', (await pcClip()) !== 'OSC-FROM-WEB', await pcClip());
    /* the PC types in the same session (its second tab) */
    await P.click(`document.querySelectorAll('.tab:not(.tab-home)')[1]`);
    await sleep(600);
    await P.typeLine(osc52('OSC-FROM-PC'));
    const pcGot = await P.waitFor(async () => (await pcClip()) === 'OSC-FROM-PC', 6000);
    ok('W6 OSC 52 after the PC typed: the PC\'s clipboard has it', !!pcGot, await pcClip());
    await sleep(500);
    ok('W6 ... and the browser kept its own', (await webClip()) === 'OSC-FROM-WEB', await webClip());

    /* W7 closing the browser tab with terminals open asks first */
    await focusWeb();
    await B.key('a', 'KeyA', 65, 0, 'a');   // Chromium asks only after a user gesture
    await B.key('Backspace', 'Backspace', 8);
    await B.ev(`(setTimeout(() => window.close(), 0), true)`);
    const asked = await B.waitFor(() => /E2E-WILL-PREVENT-UNLOAD/.test(br.log()), 5000);
    ok('W7 closing the browser tab with terminals open asks to confirm (beforeunload)', !!asked);
    ok('W7 ... both tabs still on the PC', (await pcTabs()) === 2);
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
  console.log(failed ? `\ne2e-web-input: ${failed} fallo(s) de ${results.length}` : `\ne2e-web-input: todo en verde (${results.length})`);
  process.exit(failed ? 1 : 0);
}

main();
