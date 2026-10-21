// La terminal alineada, de punta a punta: Electron real bajo xvfb, sesiones
// guardadas por el session keeper (SSH contra un sshd de OpenSSH de verdad y
// terminal local), redimensionadas de todas las formas que tiene la app.
//
//   npm run build && node scripts/e2e-terminal-size.mjs [ssh|local|all]
//
// Lo que se mira es lo que ve el SHELL, no el xterm: un perfil de bash apunta
// en ~/winch.log el tamano con el que arranca y cada SIGWINCH que recibe.
//
//  T1 cada resize (ventana, rafaga de 12, sidebar, dock de Sessions, split,
//     composer abierto/cerrado) → `stty size` == cols x rows del xterm, y
//     `printf '%*s|'` a $(tput cols)-1 cae en la ultima columna sin partirse.
//  T2 el shell nace al tamano del panel: nunca ve 80x24 si el xterm no lo es.
//  T3 emoji (🚀 ✅ ⚡ 🦀) ocupan lo que dice wcwidth del sistema, y lo escrito
//     tras un prompt con emoji, con Ctrl+A, cae donde readline lo pone.
//  T4 (ssh) 2000 lineas multibyte: ningun U+FFFD (UTF-8 partido entre paquetes).
//  T5 reiniciar Termilab: la pestana visible se restaura sin perder la linea
//     de encima del prompt (el redibujo a 80 columnas la borraba) y la oculta
//     no arranca hasta mostrarse, y entonces a su tamano real.
// HOME temporales (local y remoto): no toca tu userData ni tu ~/.termilab.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const { startRealSshd } = require('./lib/real-sshd.js');
const { parseKnownHosts } = require('../electron/services/known-hosts.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MODES = (process.argv[2] || 'all') === 'all' ? ['ssh', 'local'] : [process.argv[2]];

const results = [];
const ok = (name, cond, extra = '') => {
  results.push(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  console.log(results[results.length - 1]);
};

/* The visible xterm (fiber walk from .terminal-wrapper, see dev-frontend role notes) */
const TERM = `(() => { const el = [...document.querySelectorAll('.terminal-wrapper')].find(e => e.offsetParent);
  if (!el) return null; let f = el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]; let t = null;
  while (f && !t) { let h = f.memoizedState; while (h && typeof h === 'object' && 'next' in h) { const c = h.memoizedState && h.memoizedState.current; if (c && c.buffer && c.buffer.active) { t = c; break; } h = h.next; } f = f.return; }
  return t; })()`;

async function launch(userData, env) {
  const CDP = 19000 + Math.floor(Math.random() * 1000);
  const e = { ...process.env, TERMILAB_NO_DEVTOOLS: '1', ...env };
  delete e.VITE_DEV_SERVER_URL; delete e.ELECTRON_RUN_AS_NODE;
  const app = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', require('electron'), ROOT, '--no-sandbox', `--user-data-dir=${userData}`, `--remote-debugging-port=${CDP}`], { env: e, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let appLog = ''; app.stdout.on('data', d => { appLog += d; }); app.stderr.on('data', d => { appLog += d; });
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(300);
    try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find(t => t.type === 'page' && t.url.endsWith('/dist/index.html')); } catch (_) { /* not yet */ }
  }
  if (!target) throw new Error(`no page target (did you npm run build?)\n${appLog.slice(-1500)}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let cid = 0; const wait = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); const w = wait.get(d.id); if (w) { wait.delete(d.id); d.error ? w.reject(new Error(d.error.message)) : w.resolve(d.result); } });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const i = ++cid; wait.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(150); } };
  await waitFor(() => ev('!!document.querySelector(".app")'));
  const lines = () => ev(`(() => { const t = ${TERM}; if (!t) return []; const b = t.buffer.active; const o = []; for (let i = 0; i < b.length; i++) o.push(b.getLine(i).translateToString(true)); return o; })()`);
  const screen = async () => (await lines()).join('\n');
  const key = (k, code, vk, modifiers = 0, text) => cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) })
    .then(() => cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }));
  const type = async (text) => { await ev(`(${TERM}).focus()`); await cdp('Input.insertText', { text }); };
  const typeLine = async (text) => { await type(text); await key('Enter', 'Enter', 13, 0, '\r'); };
  let seq = 0;
  const stty = async () => {
    const n = ++seq;
    await typeLine(`echo Q${n}Q:$(stty size):$(tput cols)`);
    const re = new RegExp(`Q${n}Q:(\\d+) (\\d+):(\\d+)`);
    const m = await waitFor(async () => (await screen()).match(re), 8000);
    return m ? `${m[2]}x${m[1]}` : null;
  };
  const xsize = () => ev(`(() => { const t = ${TERM}; return t ? t.cols + 'x' + t.rows : null; })()`);
  const click = async (selectorJs) => {
    const p = await ev(`(() => { const el = ${selectorJs}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!p) return false;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
    return true;
  };
  const close = async () => {
    try { ws.close(); } catch (_) { /* gone */ }
    try { process.kill(-app.pid, 'SIGTERM'); } catch (_) { /* gone */ }
    for (let i = 0; i < 80 && app.exitCode === null; i++) await sleep(100);
  };
  return { cdp, ev, waitFor, lines, screen, key, type, typeLine, stty, xsize, click, close, log: () => appLog };
}

async function runMode(MODE) {
  delete process.env.SSH_AUTH_SOCK;
  const base = fs.mkdtempSync('/tmp/tlts-');   // short: the keeper socket must fit in sun_path
  const rhome = path.join(base, 'r'); const lhome = path.join(base, 'l');
  const PS1 = 'derek@a-rather-long-hostname-for-testing:/some/long/working/directory/path/that-is-long\\$ ';
  for (const h of [rhome, lhome]) {
    fs.mkdirSync(h, { recursive: true });
    fs.writeFileSync(path.join(h, '.bash_profile'), [
      `PS1='${PS1}'`,
      'export LANG=C.UTF-8',
      'echo "$$ START $(stty size)" >> ~/winch.log',
      `trap 'echo "$$ WINCH $(stty size)" >> ~/winch.log' WINCH`,
      '',
    ].join('\n'));
  }
  const home = MODE === 'ssh' ? rhome : lhome;
  const wrapper = path.join(base, 'session.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexport HOME=${rhome} SHELL=/bin/bash LANG=C.UTF-8\ncd "$HOME"\nif [ -n "$SSH_ORIGINAL_COMMAND" ]; then exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"; fi\nexec /bin/bash -l\n`, { mode: 0o755 });
  /* "<pid> START|WINCH rows cols" → { pid: [cols...] } */
  const seen = () => {
    const f = path.join(home, 'winch.log');
    const by = {};
    if (!fs.existsSync(f)) return by;
    for (const l of fs.readFileSync(f, 'utf-8').trim().split('\n')) {
      const m = l.match(/^(\d+) (START|WINCH) (\d+) (\d+)$/);
      if (m) (by[m[1]] = by[m[1]] || []).push(Number(m[4]));
    }
    return by;
  };
  const userData = path.join(base, 'ud');
  const data = path.join(userData, 'data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  let sshd = null; let a = null;
  const tag = (s) => `[${MODE}] ${s}`;
  try {
    if (MODE === 'ssh') {
      sshd = await startRealSshd({ forceCommand: wrapper });
      const now = new Date().toISOString();
      fs.writeFileSync(path.join(data, 'keys.json'), JSON.stringify([{ id: 'k', name: 'e2e', privateKey: sshd.privateKey, createdAt: now, updatedAt: now }]));
      fs.writeFileSync(path.join(data, 'hosts.json'), JSON.stringify([{ id: 'h', label: 'sizehost', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'key', keyId: 'k', groupId: null, tags: [], createdAt: now, updatedAt: now }]));
      const kh = parseKnownHosts(`[127.0.0.1]:${sshd.port} ${sshd.hostPublicKey}\n`).entries[0];
      fs.writeFileSync(path.join(data, 'known-hosts.json'), JSON.stringify([{ id: 'kh', ...kh, addedAt: now }]));
    }
    const env = { HOME: lhome, SHELL: '/bin/bash', LANG: 'C.UTF-8' };
    a = await launch(userData, env);
    await sleep(1200);
    const open = async () => {
      if (MODE === 'ssh') {
        await a.ev(`(() => { const i = document.querySelector('input[placeholder^="Find a host"]'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(i, 'sizehost'); i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); return true; })()`);
        await sleep(300);
        await a.ev(`document.querySelector('input[placeholder^="Find a host"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      } else {
        /* From the Hosts tab: in a terminal Ctrl+T is the program's */
        await a.click(`document.querySelector('.tab.tab-home')`);
        await sleep(400);
        await a.ev('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
        await a.key('t', 'KeyT', 84, 2);
      }
      return a.waitFor(async () => /that-is-long\$\s*$/m.test(await a.screen()), 30000);
    };
    /* Tab 1 (hidden at quit), then tab 2 (visible at quit) */
    ok(tag('first terminal opened, kept by the keeper'), !!(await open()));
    await a.typeLine('echo "KID=$TERMILAB_KEEPER_ID"');
    ok(tag('it runs inside the session keeper'), !!(await a.waitFor(async () => /KID=[a-z0-9]{26}/.test(await a.screen()), 8000)));
    await sleep(400);

    /* T2: born at the pane's size */
    const x0 = await a.xsize();
    const s0 = await a.stty();
    ok(tag('T2 stty size == xterm at start'), s0 === x0, `${s0} vs ${x0}`);
    const firstPid = Object.keys(seen())[0];
    const firstCols = seen()[firstPid] || [];
    ok(tag('T2 the shell never saw another width than the pane (no 80x24 placeholder)'), firstCols.length > 0 && firstCols.every(c => c === Number(x0.split('x')[0])), `widths seen: ${firstCols.join(',')} xterm ${x0}`);

    /* T1: every resize path */
    const checkSize = async (label, align = false) => {
      await sleep(700);
      const x = await a.xsize(); const s = await a.stty();
      ok(tag(`T1 ${label}: stty size == xterm`), !!x && s === x, `xterm ${x} pty ${s}`);
      if (align) {
        await a.typeLine(`clear; printf '%*s|\\n' $(($(tput cols)-1)) ''`);
        await sleep(700);
        const al = await a.ev(`(() => { const t = ${TERM}; const b = t.buffer.active; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); const s = l.translateToString(false); if (s.trimEnd().endsWith('|') && !s.includes('printf')) return { col: s.trimEnd().length - 1, cols: t.cols, wrapped: !!(b.getLine(i + 1) && b.getLine(i + 1).isWrapped) || l.isWrapped }; } return null; })()`);
        ok(tag(`T1 ${label}: tput cols output ends on the last column`), !!al && al.col === al.cols - 1 && !al.wrapped, JSON.stringify(al));
      }
    };
    const resizeTo = (w, h) => a.ev(`window.resizeTo(${w}, ${h}); true`);
    for (const [w, h] of [[1000, 700], [700, 500], [1400, 900]]) { await resizeTo(w, h); await checkSize(`window ${w}x${h}`, w === 700); }
    for (let i = 0; i < 12; i++) { await resizeTo(800 + i * 37, 600 + (i % 3) * 41); await sleep(i % 2 ? 5 : 40); }
    await checkSize('burst of 12 window resizes');
    await resizeTo(1300, 850);
    await checkSize('window 1300x850');
    ok(tag('sidebar shown'), await a.click(`document.querySelector('.titlebar-menu-btn')`));
    await checkSize('sidebar shown');
    ok(tag('Sessions dock opened'), await a.click(`[...document.querySelectorAll('.sidebar-item')].find(b => /Sessions/.test(b.textContent + (b.title || '')))`));
    await checkSize('Sessions dock open');
    await a.click(`[...document.querySelectorAll('.sidebar-item')].find(b => /Sessions/.test(b.textContent + (b.title || '')))`);
    await checkSize('Sessions dock closed');
    await a.click(`document.querySelector('.titlebar-menu-btn')`);
    await checkSize('sidebar hidden');
    ok(tag('composer opened'), await a.click(`[...document.querySelectorAll('.composer-toggle')].find(b => b.offsetParent)`));
    await checkSize('composer open');
    await a.click(`[...document.querySelectorAll('.composer-toggle')].find(b => b.offsetParent)`);
    await checkSize('composer closed');

    /* T3: wide characters as the shell counts them */
    const emoji = '🚀✅⚡🦀日';
    const glibc = Number(execSync(`python3 -c "import ctypes,locale,sys; locale.setlocale(locale.LC_ALL,'C.UTF-8'); l=ctypes.CDLL('libc.so.6'); print(sum(l.wcwidth(ord(c)) for c in sys.argv[1]))" '${emoji}'`).toString().trim());
    await a.typeLine(`clear; printf 'A${emoji}Z\\n'`);
    await sleep(700);
    const zAt = await a.ev(`(() => { const t = ${TERM}; const b = t.buffer.active; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); const s = l.translateToString(true); if (s.startsWith('A') && s.endsWith('Z') && !s.includes('printf')) { for (let x = 0; x < t.cols; x++) if (l.getCell(x).getChars() === 'Z') return x; } } return null; })()`);
    ok(tag('T3 emoji take the cells wcwidth says (Z lands after them)'), zAt === 1 + glibc, `Z at ${zAt}, wcwidth sum ${glibc}`);
    await a.typeLine(`PS1='🚀 ✅ ⚡ \\$ '`);
    await sleep(500);
    await a.typeLine('clear');
    await sleep(500);
    await a.type('echo hi');
    await a.key('a', 'KeyA', 65, 2);   // Ctrl+A: readline puts the cursor after the prompt by its own width count
    await a.type('X');
    await sleep(500);
    const promptLine = (await a.lines()).find(l => l.includes('echo hi') || l.includes('cho hi')) || '';
    ok(tag('T3 typed text after an emoji prompt lands where readline puts it (Ctrl+A, X)'), /\$ Xecho hi\s*$/.test(promptLine), JSON.stringify(promptLine));
    await a.key('u', 'KeyU', 85, 2);
    await a.key('k', 'KeyK', 75, 2);
    await a.typeLine(`PS1='${PS1}'`);
    await sleep(500);

    if (MODE === 'ssh') {
      await a.typeLine(`clear; python3 -c "import sys; [sys.stdout.write(('─é✓日🚀' * 40)[:150] + '\\n') for _ in range(2000)]"; echo FIN$((40+2))`);
      await a.waitFor(async () => /^FIN42/m.test(await a.screen()), 20000);
      const bad = await a.ev(`(() => { const t = ${TERM}; const b = t.buffer.active; let n = 0; for (let i = 0; i < b.length; i++) n += (b.getLine(i).translateToString(true).match(/\\uFFFD/g) || []).length; return n; })()`);
      ok(tag('T4 2000 lines of multibyte output over SSH: no U+FFFD'), bad === 0, `${bad} replacement characters`);
    }

    /* Split: the focused pane shrinks; its pty follows */
    ok(tag('split right'), await a.click(`[...document.querySelectorAll('button[title="Split Right"]')].find(b => b.offsetParent)`));
    await sleep(2500);
    await checkSize('after a split (half width)', true);
    /* Back to one pane: close the new one */
    await a.click(`[...document.querySelectorAll('.split-terminal-overlay.multi')].filter(e => e.offsetParent).sort((x, y) => y.getBoundingClientRect().left - x.getBoundingClientRect().left)[0].querySelector('button[title="Close Pane"]')`);
    await sleep(1500);
    await checkSize('split closed');

    /* T5 prep: a second tab, visible at quit; the first stays hidden */
    ok(tag('second terminal opened'), !!(await open()));
    await sleep(500);
    await a.typeLine('for i in 1 2 3 4 5 6 7 8; do echo LINE$i; done');
    await a.waitFor(async () => /^LINE8$/m.test(await a.screen()), 8000);
    await sleep(2000);   // the workspace is written debounced (1 s)
    const before = seen();
    await a.close();

    a = await launch(userData, env);
    const restored = await a.waitFor(async () => /^LINE8$/m.test(await a.screen()), 30000);
    await sleep(2500);
    const vis = (await a.lines()).filter(l => l.trim());
    const i8 = vis.lastIndexOf('LINE8');
    ok(tag('T5 restore: the visible tab comes back with the line above its prompt intact'), !!restored && i8 >= 0 && vis[i8 + 1] && vis[i8 + 1].trimEnd().endsWith('that-is-long$'), JSON.stringify(vis.slice(-3)));
    const xr = await a.xsize();
    const afterRestore = seen();
    const pids = Object.keys(afterRestore);
    const newOnes = (pid) => (afterRestore[pid] || []).slice((before[pid] || []).length);
    const wcols = Number(xr.split('x')[0]);
    const visiblePid = pids.find(p => newOnes(p).length);
    ok(tag('T5 restore: the shell redrew only at the pane width (no 80-column redraw)'), !!visiblePid && newOnes(visiblePid).every(c => c === wcols), `widths seen after restore: ${JSON.stringify(Object.fromEntries(pids.map(p => [p, newOnes(p)])))} xterm ${xr}`);
    ok(tag('T5 restore: stty size == xterm'), (await a.stty()) === xr);
    const others = pids.filter(p => p !== visiblePid);
    ok(tag('T5 restore: the hidden tab has not attached yet (no SIGWINCH while hidden)'), others.length > 0 && others.every(p => newOnes(p).length === 0), JSON.stringify(others.map(p => newOnes(p))));
    /* Show the hidden tab */
    ok(tag('hidden tab clicked'), await a.click(`[...document.querySelectorAll('.tab:not(.tab-home)')][0]`));
    await sleep(2500);
    const xh = await a.xsize();
    const sh = await a.stty();
    ok(tag('T5 the hidden tab, once shown: stty size == xterm'), sh === xh, `${sh} vs ${xh}`);
    /* The shell that heard something only now is the one that was hidden */
    const shown = seen();
    const hiddenPid = others.find(p => (shown[p] || []).length > (afterRestore[p] || []).length);
    const hcols = hiddenPid ? shown[hiddenPid].slice((before[hiddenPid] || []).length) : [];
    ok(tag('T5 the hidden tab, once shown: its shell only ever saw the pane width'), hcols.length > 0 && hcols.every(c => c === Number(xh.split('x')[0])), JSON.stringify(hcols));
  } catch (e) {
    ok(tag(`no exception (${e.message.split('\n')[0]})`), false, a ? a.log().slice(-800) : '');
  } finally {
    if (a) await a.close();
    /* Kill this run's keeper daemons (their binary lives under base) */
    try { execSync(`pkill -f '${base}/'`); } catch (_) { /* none */ }
    if (sshd) await sshd.stop();
    await sleep(500);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

for (const m of MODES) await runMode(m);
const failed = results.filter(r => r.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} ok`);
process.exit(failed.length ? 1 : 0);
