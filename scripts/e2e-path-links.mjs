// Rutas clicables en la terminal, de punta a punta: Electron real bajo xvfb,
// CDP manda raton y teclado de verdad. Linux.
//
//   npm run build && node scripts/e2e-path-links.mjs
//
// Lo que se observa es el SO, no el codigo: un `xdg-open` y un `code` falsos
// en PATH apuntan sus argumentos en un fichero (shell.openPath de Electron en
// Linux lanza xdg-open; showItemInFolder, sin D-Bus de gestor de archivos,
// tambien acaba en xdg-open de la CARPETA). `xdg-mime` falso decide si VS Code
// es el editor. La terminal local hace `cd` a un proyecto temporal e imprime
// rutas relativas: el cwd sale de /proc (bash sin OSC 7 aqui).
//
// Prueba: sin Ctrl no hay subrayado ni se abre; Ctrl+clic abre con la ruta
// ABSOLUTA correcta; :linea con VS Code de editor → code --goto; un script
// ejecutable nunca va a xdg-open (solo su carpeta); inexistente → toast;
// clic derecho sobre una ruta → menu (Copy path copia la absoluta) y fuera de
// una ruta el clic derecho sigue pegando.
// HOME/XDG_CONFIG_HOME temporales: no toca tu userData.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const W = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-paths-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, '.config'), { recursive: true });
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'console.log(1)\n');
fs.writeFileSync(path.join(proj, 'run.sh'), '#!/bin/sh\ntouch "$HOME/PWNED"\n', { mode: 0o755 });
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const opened = path.join(tmp, 'opened.log');
/* "." (Electron's showItemInFolder fallback runs `xdg-open .` IN the folder) is logged as its real cwd */
const logger = (name) => `#!/bin/sh\nprintf '%s' "${name}" >> '${opened}'; for a in "$@"; do [ "$a" = . ] && a="$(pwd -P)"; printf ' %s' "$a" >> '${opened}'; done; printf '\\n' >> '${opened}'\n`;
fs.writeFileSync(path.join(bin, 'xdg-open'), logger('xdg-open'), { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'code'), logger('code'), { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'xdg-mime'), '#!/bin/sh\n[ "$2" = filetype ] && echo text/plain || echo code.desktop\n', { mode: 0o755 });
const openedLines = () => (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf-8').split('\n').filter(Boolean) : []);

const CDP = 19000 + Math.floor(Math.random() * 1000);
const env = {
  ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: `${bin}:${process.env.PATH}`,
  TERMILAB_NO_DEVTOOLS: '1', TERMILAB_DIRECT_PTY: '1', SHELL: '/bin/bash',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
delete env.DBUS_SESSION_BUS_ADDRESS;   // showItemInFolder → xdg-open of the folder
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
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(150); } };
/* The visible xterm (fiber walk from .terminal-wrapper, see dev-frontend role notes) */
const TERM = `(() => { const el = [...document.querySelectorAll('.terminal-wrapper')].find(e => e.offsetParent);
  let f = el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]; let t = null;
  while (f && !t) { let h = f.memoizedState; while (h && typeof h === 'object' && 'next' in h) { const c = h.memoizedState && h.memoizedState.current; if (c && c.buffer && c.buffer.active) { t = c; break; } h = h.next; } f = f.return; }
  return t; })()`;
const screenText = () => evaluate(`(() => { const t = ${TERM}; const b = t.buffer.active; const out = []; for (let i = 0; i < t.rows; i++) out.push(b.getLine(b.viewportY + i).translateToString(true)); return out.join('\\n'); })()`);
/* Pixel centre of the `nth` character of `needle` on the screen (last occurrence) */
const where = (needle, nth = 2) => evaluate(`(() => { const t = ${TERM}; const b = t.buffer.active; let row = -1, col = -1;
  for (let i = 0; i < t.rows; i++) { const s = b.getLine(b.viewportY + i).translateToString(true); const c = s.lastIndexOf(${JSON.stringify(needle)}); if (c >= 0 && !s.includes('printf')) { row = i; col = c; } }
  if (row < 0) return null; const scr = t.element.querySelector('.xterm-screen').getBoundingClientRect();
  const cw = scr.width / t.cols, ch = scr.height / t.rows;
  return { x: Math.round(scr.left + (col + ${nth} + 0.5) * cw), y: Math.round(scr.top + (row + 0.5) * ch) }; })()`);
const mouse = (type, p, modifiers = 0, button = 'none', clickCount = 0) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, modifiers, button, clickCount });
const click = async (p, modifiers = 0, button = 'left') => {
  await mouse('mouseMoved', { x: p.x + 1, y: p.y }, modifiers);
  await mouse('mouseMoved', p, modifiers);
  await sleep(120);
  await mouse('mousePressed', p, modifiers, button, 1);
  await mouse('mouseReleased', p, modifiers, button, 1);
};
const ctrlKey = (type) => send('Input.dispatchKeyEvent', { type, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: type === 'keyDown' ? 2 : 0 });
const run = async (cmd) => {
  await send('Input.insertText', { text: cmd });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};

try {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
      target = list.find(t => t.type === 'page' && t.url.startsWith('file://') && t.url.endsWith('/dist/index.html'));
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
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 't', code: 'KeyT', modifiers: 2, windowsVirtualKeyCode: 84 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't', code: 'KeyT', modifiers: 2, windowsVirtualKeyCode: 84 });
  const prompt = await waitFor(async () => /\$\s*$/m.test(await screenText()), 15000);
  ok('local terminal opened with a prompt', !!prompt);
  await sleep(500);
  await run(`cd '${proj}' && clear && printf '⏺ Update(src/app.js)\\nsrc/app.js:12:3: warning\\n  ⎿  Read(run.sh)\\nmissing/nope.ts\\nplain words here\\n'`);
  await waitFor(async () => (await screenText()).includes('plain words here'), 5000);
  await sleep(300);

  // Hover without Ctrl: no pointer, a plain click opens nothing
  const p1 = await where('src/app.js)');
  ok('the printed path is on screen', !!p1);
  await mouse('mouseMoved', p1);
  await sleep(200);
  const pointerNoCtrl = await evaluate(`(${TERM}).element.querySelector('.xterm-screen').classList.contains('xterm-cursor-pointer')`);
  ok('hovering without Ctrl: no pointer/underline', !pointerNoCtrl);
  await click(p1);
  await sleep(600);
  ok('a plain click opens nothing', openedLines().length === 0, openedLines().join(' | '));

  // Ctrl held: pointer; Ctrl+click → xdg-open <absolute path>
  await ctrlKey('keyDown');
  await mouse('mouseMoved', { x: p1.x + 2, y: p1.y }, 2);
  await sleep(200);
  const pointerCtrl = await evaluate(`(${TERM}).element.querySelector('.xterm-screen').classList.contains('xterm-cursor-pointer')`);
  ok('hovering with Ctrl: pointer + underline', pointerCtrl);
  await click(p1, 2);
  const appJs = fs.realpathSync(path.join(proj, 'src', 'app.js'));
  const got1 = await waitFor(() => openedLines().find(l => l.startsWith('xdg-open')), 5000);
  ok('Ctrl+click → shell.openPath → xdg-open with the absolute path (cwd from /proc)', got1 === `xdg-open ${appJs}`, got1 || 'nothing');

  // :line with VS Code as the editor → code --goto
  const p2 = await where('src/app.js:12:3');
  await click(p2, 2);
  const got2 = await waitFor(() => openedLines().find(l => l.startsWith('code')), 5000);
  ok('Ctrl+click on file:line:col → code --goto file:12:3', got2 === `code --goto ${appJs}:12:3`, got2 || 'nothing');

  // An executable script: never handed to xdg-open (VS Code is the editor here → code; folder otherwise)
  fs.writeFileSync(path.join(bin, 'xdg-mime'), '#!/bin/sh\n[ "$2" = filetype ] && echo text/plain || echo org.gnome.TextEditor.desktop\n', { mode: 0o755 });
  const before = openedLines().length;
  const p3 = await where('run.sh)', 1);
  await click(p3, 2);
  await sleep(1500);
  const after = openedLines().slice(before);
  const runSh = fs.realpathSync(path.join(proj, 'run.sh'));
  ok('Ctrl+click on an executable script never opens the script itself', !after.some(l => l.endsWith(runSh)), after.join(' | ') || '(nothing opened)');
  /* showItemInFolder: with a FileManager1 on D-Bus the file manager selects it;
     without (here) Electron falls back to `xdg-open .` in a folder ABOVE it
     (measured: the project's parent, not the project). Either way a folder. */
  ok('…a folder above it is shown instead (showItemInFolder)', after.some(l => { const d = l.replace(/^xdg-open /, ''); return l.startsWith('xdg-open /') && runSh.startsWith(`${d}/`); }), after.join(' | ') || '(nothing)');
  ok('the script did not run', !fs.existsSync(path.join(home, 'PWNED')));
  const toastRun = await evaluate(`document.querySelector('.termilab-toast')?.textContent || ''`);
  ok('…and a toast says why', /could run as a program/.test(toastRun), toastRun);

  // Missing → toast
  await sleep(3500);
  const p4 = await where('missing/nope.ts');
  await click(p4, 2);
  const toast = await waitFor(() => evaluate(`document.querySelector('.termilab-toast')?.textContent || ''`), 4000);
  ok('missing file → "File not found: <absolute>" toast', toast === `File not found: ${path.join(fs.realpathSync(proj), 'missing/nope.ts')}`, toast);
  await ctrlKey('keyUp');

  // Right-click on a path → menu; Copy path copies the absolute path
  await evaluate(`window.electronAPI.clipboard.writeText('sentinel')`);
  await click(p1, 0, 'right');
  const menu = await waitFor(() => evaluate(`[...document.querySelectorAll('.path-link-menu .path-link-menu-item')].map(b => b.textContent).join('|')`), 3000);
  ok('right-click on a path shows Open / Open folder in SFTP / Copy path', menu === 'Open|Open folder in SFTP|Copy path', menu);
  await evaluate(`[...document.querySelectorAll('.path-link-menu-item')].find(b => b.textContent === 'Copy path').click()`);
  const clip = await waitFor(async () => { const c = await evaluate(`window.electronAPI.clipboard.readText()`); return c !== 'sentinel' ? c : ''; }, 3000);
  ok('Copy path → the absolute path in the clipboard', clip === appJs, clip);
  ok('nothing was pasted into the shell by that right-click', !(await screenText()).includes('sentinel'));

  // Open folder in SFTP → an SFTP tab whose local pane is at proj/src
  await click(p1, 0, 'right');
  await waitFor(() => evaluate(`!!document.querySelector('.path-link-menu')`), 3000);
  await evaluate(`[...document.querySelectorAll('.path-link-menu-item')].find(b => b.textContent === 'Open folder in SFTP').click()`);
  const sftpAt = await waitFor(() => evaluate(`(() => { const t = [...document.querySelectorAll('.sftp-list, [aria-label^="Files in "]')].map(e => e.getAttribute('aria-label')).filter(Boolean); return t.join('|'); })()`), 6000);
  ok('Open folder in SFTP opens the local pane at that folder', (sftpAt || '').includes(`Files in ${fs.realpathSync(path.join(proj, 'src'))}`), sftpAt);
} catch (err) {
  results.push(`FAIL exception: ${err.message}`);
} finally {
  try { ws && ws.close(); } catch (_) { /* */ }
  try { process.kill(-app.pid, 'SIGTERM'); } catch (_) { /* */ }
  await sleep(1500);
  try { process.kill(-app.pid, 'SIGKILL'); } catch (_) { /* */ }
  console.log(results.join('\n'));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
}
