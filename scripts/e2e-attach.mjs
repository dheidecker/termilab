// Imagenes a una terminal, de punta a punta: Electron real bajo xvfb, CDP
// Input.dispatchDragEvent suelta ficheros de verdad (webUtils.getPathForFile da
// la ruta real). Linux.
//
//   npm run build && node scripts/e2e-attach.mjs
//
// Prueba: soltar un PNG teclea su ruta (entre comillas, sin Enter); un .txt se
// rechaza; una imagen del portapapeles (Ctrl+Shift+V -> pasteInto -> onImage)
// se guarda en ~/.termilab/uploads y se teclea; con Broadcast encendido la ruta
// va SOLO a la terminal donde se solto/pego; soltar un fichero fuera de un panel
// no navega la ventana, ni location.href = file:// (will-navigate en main), ni
// window.open; y el panel Local del SFTP sigue recibiendo ficheros del SO.
// HOME/XDG_CONFIG_HOME temporales: no toca tu userData.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const W = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(import.meta.url);
const { png } = require(`${W}/scripts/lib/check-attach.js`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-drop-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, '.config'), { recursive: true });
const shot = path.join(tmp, "my shot's.png");
fs.writeFileSync(shot, png(6, 6));
const txt = path.join(tmp, 'notes.txt');
fs.writeFileSync(txt, 'hello');
const shot2 = path.join(tmp, 'bcast-shot.png');
fs.writeFileSync(shot2, png(4, 4));
const sftpFile = path.join(tmp, 'sftp-drop-me.txt');
fs.writeFileSync(sftpFile, 'to the local pane');
const HTTP = 18000 + Math.floor(Math.random() * 1000);
const CDP = HTTP + 1000;

/* Default: dist/ over file://, like a packaged build (that is where a dropped
   file:// navigation would succeed). E2E_HTTP=1 serves it over http instead. */
const OVER_HTTP = process.env.E2E_HTTP === '1';
const srv = OVER_HTTP ? spawn('python3', ['-m', 'http.server', String(HTTP), '--bind', '127.0.0.1', '--directory', `${W}/dist`], { stdio: 'ignore' }) : null;
const env = {
  ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
  ...(OVER_HTTP ? { VITE_DEV_SERVER_URL: `http://127.0.0.1:${HTTP}/` } : {}), TERMILAB_NO_DEVTOOLS: '1', TERMILAB_DIRECT_PTY: '1',
  SHELL: '/bin/bash',
};
delete env.ELECTRON_RUN_AS_NODE;
if (!OVER_HTTP) delete env.VITE_DEV_SERVER_URL;
const app = spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', `${W}/node_modules/.bin/electron`, W, `--remote-debugging-port=${CDP}`, '--no-sandbox'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let log = '';
app.stdout.on('data', d => { log += d; });
app.stderr.on('data', d => { log += d; });

const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); };

let ws; let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id; pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};
const screen = () => evaluate(`(() => [...document.querySelectorAll('.split-terminal-overlay')].filter(o => o.style.display !== 'none').map(o => o.querySelector('.xterm-rows')?.innerText || '').join('\\n'))()`);
/* text of every terminal's xterm buffer (hidden tabs too): [{ visible, text }] */
const terms = () => evaluate(`(() => [...document.querySelectorAll('.terminal-wrapper')].map((el) => {
  let f = el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]; let t = null;
  while (f && !t) { let h = f.memoizedState; while (h && typeof h === 'object' && 'next' in h) { const c = h.memoizedState && h.memoizedState.current; if (c && c.buffer && c.buffer.active) { t = c; break; } h = h.next; } f = f.return; }
  const out = []; if (t) { const b = t.buffer.active; for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); }
  return { visible: !!el.offsetParent, text: out.join('\\n') };
}))()`);
const key = async (k, code, vk, modifiers = 0, text) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk });
};
const putClipboardImage = () => evaluate(`(async () => { try { const b = new Blob([Uint8Array.from(atob('${png(5, 5).toString('base64')}'), c => c.charCodeAt(0))], { type: 'image/png' }); await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); return 'ok'; } catch (e) { return String(e); } })()`);
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(150); } };

try {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
      target = list.find(t => t.type === 'page' && (OVER_HTTP ? t.url.startsWith(`http://127.0.0.1:${HTTP}`) : t.url.startsWith('file://') && t.url.endsWith('/dist/index.html')));
    } catch (_) { /* not yet */ }
  }
  if (!target) throw new Error(`no page target\n${log.slice(-2000)}`);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await send('Runtime.enable');
  await waitFor(() => evaluate('!!document.querySelector(".app, #root > *")'));
  await sleep(1500);
  // Ctrl+T: new local terminal
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 't', code: 'KeyT', modifiers: 2, windowsVirtualKeyCode: 84 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't', code: 'KeyT', modifiers: 2, windowsVirtualKeyCode: 84 });
  const prompt = await waitFor(async () => /\$\s*$/m.test(await screen()), 15000);
  ok('local terminal opened with a prompt', !!prompt);
  await sleep(700);
  const rect = await evaluate(`(() => { const o = [...document.querySelectorAll('.split-terminal-overlay')].find(o => o.style.display !== 'none'); const r = o.querySelector('.terminal-wrapper').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  await send('Input.insertText', { text: 'ls -l ' });
  await sleep(300);

  const drag = (type, files) => send('Input.dispatchDragEvent', { type, x: rect.x, y: rect.y, data: { items: [], files, dragOperationsMask: 1 } });
  await drag('dragEnter', [shot]);
  await drag('dragOver', [shot]);
  const hl = await evaluate(`!!document.querySelector('.terminal-container.file-drop-over')`);
  ok('pane highlighted on dragover', hl);
  await drag('drop', [shot]);
  const quoted = `'${shot.replace(/'/g, `'\\''`)}'`;
  const typed = await waitFor(async () => (await screen()).includes("my shot'\\''s.png"), 5000);
  ok('dropped PNG path typed, single-quoted, no Enter', !!typed, (await screen()).split('\n').filter(Boolean).slice(-2).join(' | '));
  const hlGone = await evaluate(`!document.querySelector('.terminal-container.file-drop-over')`);
  ok('highlight cleared after drop', hlGone);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const listed = await waitFor(async () => /-rw.*my shot's\.png/.test(await screen()), 5000);
  ok('the shell accepts the typed path (ls -l lists the file)', !!listed);

  // Non-image: refused with a status line, nothing typed
  await drag('dragEnter', [txt]);
  await drag('dragOver', [txt]);
  await drag('drop', [txt]);
  const refused = await waitFor(() => evaluate(`document.querySelector('.terminal-attach-status.error')?.textContent || ''`), 3000);
  ok('non-image refused with "Only images can be attached"', refused === 'Only images can be attached', refused);
  ok('nothing typed for the refused file', !(await screen()).includes('notes.txt'));

  // Clipboard image: Ctrl+Shift+V -> pasteInto -> onImage (pasteImageRef) -> attachImages
  const wrote = await putClipboardImage();
  if (wrote === 'ok') {
    await send('Input.insertText', { text: 'file ' });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'V', code: 'KeyV', modifiers: 2 | 8, windowsVirtualKeyCode: 86 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'V', code: 'KeyV', modifiers: 2 | 8, windowsVirtualKeyCode: 86 });
    const clip = await waitFor(async () => /\.termilab\/uploads\/clip-\d{8}-\d{6}\.png/.test(await screen()), 5000);
    ok('clipboard image saved to ~/.termilab/uploads/clip-*.png and its path typed', !!clip);
    const dir = path.join(home, '.termilab', 'uploads');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const f = files.find(n => /^clip-\d{8}-\d{6}\.png$/.test(n));
    ok('saved file is 0600 in a 0700 dir', !!f && (fs.statSync(path.join(dir, f)).mode & 0o777) === 0o600 && (fs.statSync(dir).mode & 0o777) === 0o700, files.join(','));
  } else {
    ok('clipboard image (could not write the clipboard here)', false, wrote);
  }
  await key('c', 'KeyC', 67, 2);

  // ── Broadcast: attached paths go only to the terminal they were dropped/pasted on ──
  await evaluate('document.activeElement && document.activeElement.blur()');
  await key('t', 'KeyT', 84, 2);
  const two = await waitFor(async () => { const t = await terms(); return t.length === 2 && t.every(x => /\$\s*$/m.test(x.text)); }, 15000);
  ok('second local terminal opened', !!two, JSON.stringify((await terms()).map(x => [x.visible, x.text.trim().split('\n').slice(-1)[0]])) + ' tabs=' + await evaluate(`document.querySelectorAll('.tab-bar .tab, [role=tab]').length + '/' + document.querySelectorAll('.split-terminal-overlay').length + '/' + document.activeElement?.className`));
  await sleep(700);
  /* Broadcast is turned on from the tab's context menu (the title bar button is gone) */
  await evaluate(`(() => { const t = document.querySelector('.tab.active:not(.tab-home)'); const r = t.getBoundingClientRect(); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.bottom })); })()`);
  await sleep(200);
  await evaluate(`[...document.querySelectorAll('.tab-context-menu-item')].find(b => /Broadcast Input/.test(b.textContent)).click()`);
  await sleep(300);
  ok('broadcast on', await evaluate(`!!document.querySelector('.broadcast-indicator')`));
  await send('Input.insertText', { text: 'echo BCAST-ON' });
  const hidden = async () => (await terms()).find(x => !x.visible)?.text || '';
  const shown = async () => (await terms()).find(x => x.visible)?.text || '';
  const bc = await waitFor(async () => (await hidden()).includes('echo BCAST-ON'), 4000);
  ok('control: typed text IS broadcast to the other terminal', !!bc);
  await key('c', 'KeyC', 67, 2);
  await sleep(500);
  const rect2 = await evaluate(`(() => { const o = [...document.querySelectorAll('.split-terminal-overlay')].find(o => o.style.display !== 'none'); const r = o.querySelector('.terminal-wrapper').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const drag2 = (type, files, at = rect2) => send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data: { items: [], files, dragOperationsMask: 1 } });
  await drag2('dragEnter', [shot2]); await drag2('dragOver', [shot2]); await drag2('drop', [shot2]);
  const here = await waitFor(async () => (await shown()).includes(shot2), 5000);
  ok('broadcast on: dropped path typed in the pane it was dropped on', !!here);
  await sleep(1200);
  ok('broadcast on: ... and NOT in the other terminal', !(await hidden()).includes('bcast-shot'), (await hidden()).split('\n').filter(Boolean).slice(-1)[0]);
  await key('c', 'KeyC', 67, 2);
  await sleep(400);
  if ((await putClipboardImage()) === 'ok') {
    const clipsElsewhere = async () => ((await hidden()).match(/uploads\/clip-/g) || []).length;
    const before = await clipsElsewhere();
    await key('V', 'KeyV', 86, 2 | 8);
    const clip2 = await waitFor(async () => ((await shown()).match(/\.termilab\/uploads\/clip-\d{8}-\d{6}(-\d+)?\.png/g) || []).length >= 1, 5000);
    ok('broadcast on: pasted clipboard image typed in this pane', !!clip2);
    await sleep(1200);
    ok('broadcast on: ... and NOT in the other terminal', (await clipsElsewhere()) === before);
  }
  await key('c', 'KeyC', 67, 2);
  await evaluate(`document.querySelector('.broadcast-indicator').click()`);

  // ── Navigation guard ──
  const href0 = await evaluate('location.href');
  /* a terminal tab's label: a real drop target for nothing (tabs only hover-open) */
  const bar = await evaluate(`(() => { window.__overs = []; window.addEventListener('dragover', (e) => window.__overs.push(e.defaultPrevented && e.dataTransfer.dropEffect === 'none')); const r = [...document.querySelectorAll('.tab:not(.tab-home) .tab-label')][0].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  await drag2('dragEnter', [shot], bar); await drag2('dragOver', [shot], bar); await drag2('drop', [shot], bar);
  await sleep(1500);
  /* Chromium only navigates when dragover was NOT cancelled; the guard cancels
     it with dropEffect 'none' (no-drop cursor, the drag just ends) */
  const overs = await evaluate('window.__overs');
  ok('file dropped on a tab: dragover refused by the window guard (none) and the window does not navigate', overs.length > 0 && overs.every(Boolean) && (await evaluate('location.href')) === href0 && (await evaluate(`!!document.querySelector('.terminal-wrapper')`)), JSON.stringify(overs));
  await evaluate(`(() => { location.href = 'file:///etc/hostname'; return 1; })()`).catch(() => {});
  await sleep(1500);
  ok('location.href = file://... is denied (will-navigate in main)', (await evaluate('location.href')) === href0);
  ok('window.open(file://...) is denied', (await evaluate(`window.open('file:///etc/hostname') === null`)) && (await evaluate('location.href')) === href0);

  // ── SFTP Local pane still takes files from the OS ──
  await evaluate(`[...document.querySelectorAll('.tab-label')].find(l => l.textContent === 'Hosts').click()`);
  await sleep(500);
  await evaluate(`document.querySelector('button.sidebar-item[aria-label="SFTP"]').click()`);
  const lw = await waitFor(() => evaluate(`(() => { const el = document.querySelector('.sftp-list-wrap'); if (!el || !el.offsetParent) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`), 8000);
  ok('SFTP screen opened with the Local pane', !!lw);
  if (lw) {
    await sleep(1200);
    await drag2('dragEnter', [sftpFile], lw); await drag2('dragOver', [sftpFile], lw); await drag2('drop', [sftpFile], lw);
    const copied = await waitFor(async () => fs.existsSync(path.join(home, 'sftp-drop-me.txt')), 8000);
    ok('SFTP Local pane: OS file dropped is copied into its folder (guard does not eat it)', !!copied);
  }
} catch (err) {
  results.push(`FAIL exception: ${err.message}`);
} finally {
  try { ws && ws.close(); } catch (_) { /* */ }
  try { process.kill(-app.pid, 'SIGTERM'); } catch (_) { /* */ }
  if (srv) srv.kill();
  await sleep(1500);
  try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { /* */ }
  console.log(results.join('\n'));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
}
