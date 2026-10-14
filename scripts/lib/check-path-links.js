/**
 * Seccion PL del arnes del main (scripts/check-main.js): rutas impresas en la
 * terminal que se abren con Ctrl+clic (src/components/Terminal/pathLinks.js,
 * pathLinkProvider.js; electron/services/open-path-service.js).
 *
 *  PL1  detector sobre un corpus de lineas reales (Claude Code, tsc, eslint,
 *       grep -n, git status, tracebacks de Python, rustc, go, java, node).
 *  PL2  negativas: URLs, versiones, fechas, prosa, /comandos, host:puerto,
 *       scp, $VAR.
 *  PL3  OSC 7, linea logica (filas envueltas, caracteres anchos) y rangos.
 *  PL4  local: relativa contra OSC 7, contra /proc/<pid>/cwd de un proceso
 *       real, contra el MainPID de la unidad systemd, y contra HOME; ~/.
 *  PL5  local, seguridad: carpeta → gestor de archivos; ejecutable, .desktop,
 *       enlace a .desktop → su carpeta (showItemInFolder), NUNCA openPath;
 *       fifo se niega; inexistente → {status:'missing'}; VS Code --goto.
 *  PL6  canales paths:* (envoltorio, sesion de otra ventana, ssh sin sesion).
 *  PL7  remoto (sshd real, HOME temporal): relativa contra HOME y contra
 *       OSC 7, carpeta → 'dir', inexistente, .desktop se niega, edicion con
 *       subida al guardar; cwd por exec acotado con el pid del keeper.
 *  PL8  renderer: el proveedor de enlaces con un xterm falso: sin Ctrl no
 *       abre, con Ctrl abre con el cwd de OSC 7, inexistente → toast; menu
 *       contextual en captura que corta el pegar; TerminalView lo conecta y
 *       lo suelta; navigation-guard sigue sin dejar file://.
 *
 * TERMILAB_CHECK_ONLY=PL: solo esto (~5 s).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { startRealSshd } = require('./real-sshd');

const SFTP_SERVERS = ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server', '/usr/libexec/sftp-server'];

/* [linea, [[texto subrayado, ruta, linea, col], ...]] */
const CORPUS = [
  ['⏺ Update(src/components/Terminal/TerminalView.jsx)', [['src/components/Terminal/TerminalView.jsx', 'src/components/Terminal/TerminalView.jsx', null, null]]],
  ['⏺ Read(README.md)', [['README.md', 'README.md', null, null]]],
  ['● Write(/home/derek/x/notas.md)', [['/home/derek/x/notas.md', '/home/derek/x/notas.md', null, null]]],
  ['⏺ Read(file_path: "/etc/hosts")', [['/etc/hosts', '/etc/hosts', null, null]]],
  ['  ⎿  Updated src/a.js with 3 additions and 1 removal', [['src/a.js', 'src/a.js', null, null]]],
  ['  ⎿  Read 120 lines (ctrl+o to expand)', []],
  ["src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.", [['src/app.ts(12,5)', 'src/app.ts', 12, 5]]],
  ['/home/derek/p/src/index.js', [['/home/derek/p/src/index.js', '/home/derek/p/src/index.js', null, null]]],
  ['  12:5  error  Unexpected console statement  no-console', []],
  ['src/utils/fmt.js:42:  const x = 1; // https://example.com/a/b.js', [['src/utils/fmt.js:42', 'src/utils/fmt.js', 42, null]]],
  ['electron/main.js:7:const { app } = require(\'electron\');', [['electron/main.js:7', 'electron/main.js', 7, null]]],
  ['\tmodified:   README.md', [['README.md', 'README.md', null, null]]],
  ['\tmodified:   src/contexts/AppContext.jsx', [['src/contexts/AppContext.jsx', 'src/contexts/AppContext.jsx', null, null]]],
  ['\tnew file:   .gitignore', [['.gitignore', '.gitignore', null, null]]],
  ['\trenamed:    old/name.js -> new/name.js', [['old/name.js', 'old/name.js', null, null], ['new/name.js', 'new/name.js', null, null]]],
  [' M electron/main.js', [['electron/main.js', 'electron/main.js', null, null]]],
  ['?? package.json', [['package.json', 'package.json', null, null]]],
  ['  File "/usr/lib/python3.12/json/__init__.py", line 293, in load', [['/usr/lib/python3.12/json/__init__.py', '/usr/lib/python3.12/json/__init__.py', 293, null]]],
  ['  File "app.py", line 10, in <module>', [['app.py', 'app.py', 10, null]]],
  ['  --> src/main.rs:10:5', [['src/main.rs:10:5', 'src/main.rs', 10, 5]]],
  ['./main.go:10:5: undefined: foo', [['./main.go:10:5', './main.go', 10, 5]]],
  ['main.c:10:5: error: expected \';\' before \'}\' token', [['main.c:10:5', 'main.c', 10, 5]]],
  ['    at Object.<anonymous> (/home/u/a.js:10:5)', [['/home/u/a.js:10:5', '/home/u/a.js', 10, 5]]],
  ['    at com.foo.Bar.baz(Bar.java:12)', [['Bar.java:12', 'Bar.java', 12, null]]],
  ['see ~/notes/todo.md (line 12) and ./x/y.ts:42', [['~/notes/todo.md', '~/notes/todo.md', 12, null], ['./x/y.ts:42', './x/y.ts', 42, null]]],
  ['a/b.c (line 12)', [['a/b.c', 'a/b.c', 12, null]]],
  ['Edited docs/configuración.md.', [['docs/configuración.md', 'docs/configuración.md', null, null]]],
  ['app/[slug]/page.tsx compiled in 120ms', [['app/[slug]/page.tsx', 'app/[slug]/page.tsx', null, null]]],
  ['(see ../shared/types.d.ts)', [['../shared/types.d.ts', '../shared/types.d.ts', null, null]]],
  ['grep: src/missing.txt: No such file or directory', [['src/missing.txt', 'src/missing.txt', null, null]]],
  ['ls /usr/local/lib/node_modules', [['/usr/local/lib/node_modules', '/usr/local/lib/node_modules', null, null]]],
];
const NEGATIVES = [
  'Visit https://github.com/foo/bar/blob/main/src/x.js for details',
  'file:///home/u/a.js and http://localhost:5173/src/main.jsx',
  'released v1.2.3 (node 18.2.0, electron 32.1.2)',
  'on 2026/10/14 and 14/10/2026 at 10:30:00',
  'The client/server and/or TCP/IP model, w/o I/O, 50/50.',
  'Run /help or /clear to start; /model to switch.',
  'git@github.com:org/repo.git',
  'connecting to example.com:443 and 192.168.1.1:22 and localhost:3000',
  'Node.js and e.g. the file, i.e. nothing.',
  '$HOME/bin/x.sh',
  '1.2.3:45',
  'Ctrl+Shift+N opens a window',
  'It costs 3.50/month',
  '@xterm/addon-web-links@0.11.0',
];

/** A fake xterm IBuffer from rows: [{text, wrapped}], wide chars = 2 cells */
function fakeBuffer(rows, cols) {
  const wide = (ch) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1f300}-\u{1faff}]/u.test(ch);
  const lines = rows.map(({ text, wrapped }) => {
    const cells = [];
    for (const ch of Array.from(text)) {
      if (wide(ch)) { cells.push({ c: ch, w: 2 }); cells.push({ c: '', w: 0 }); } else cells.push({ c: ch, w: 1 });
    }
    while (cells.length < cols) cells.push({ c: '', w: 1 });
    return {
      isWrapped: !!wrapped,
      getCell: (x) => (cells[x] ? { getChars: () => cells[x].c, getWidth: () => cells[x].w } : undefined),
    };
  });
  return { getLine: (y) => lines[y] };
}

async function seccionPathLinks({ check, ROOT, handlers }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-pl-'));
  const esb = (entry, out, extra = []) => execFileSync(path.join(ROOT, 'node_modules', '.bin', 'esbuild'), [
    entry, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error', ...extra,
  ], { stdio: 'pipe' });
  const plOut = path.join(tmp, 'pl.cjs');
  esb(path.join(ROOT, 'src', 'components', 'Terminal', 'pathLinks.js'), plOut);
  const pl = require(plOut);
  const svc = (n) => require(path.join(ROOT, 'electron', 'services', n));
  const ops = svc('open-path-service.js');
  const sftpEditService = svc('sftp-edit-service.js');

  const prev = { shell: ops._shell, spawn: ops._spawn, exec: ops._exec, home: ops.homeDir, ls: ops.localShell, path: process.env.PATH, editShell: sftpEditService._shell };
  const seen = (line) => pl.findPaths(line).map(f => [line.slice(f.start, f.end), f.path, f.line, f.col]);

  try {
    await check('PL1 detector: corpus de lineas reales (Claude Code, tsc, grep -n, git status, Python, rustc, go, java, node)', () => {
      for (const [line, want] of CORPUS) assert.deepStrictEqual(seen(line), want, JSON.stringify(line));
    });

    await check('PL2 detector: negativas (URLs, versiones, fechas, prosa, /comandos, host:puerto, scp, $VAR)', () => {
      for (const line of NEGATIVES) assert.deepStrictEqual(seen(line), [], JSON.stringify(line));
      // Un URL con una ruta dentro no deja ningun trozo suelto
      assert.deepStrictEqual(seen('error at https://x.dev/src/a.ts:12:5 (src/b.ts:3)'), [['src/b.ts:3', 'src/b.ts', 3, null]]);
    });

    await check('PL3 OSC 7, linea logica con filas envueltas y caracteres anchos, rangos de celdas', () => {
      assert.deepStrictEqual(pl.parseOsc7('file://box/home/u/my%20dir'), { host: 'box', path: '/home/u/my dir' });
      assert.deepStrictEqual(pl.parseOsc7('file:///tmp'), { host: '', path: '/tmp' });
      assert.deepStrictEqual(pl.parseOsc7('kitty-shell-cwd://h/srv'), { host: 'h', path: '/srv' });
      assert.strictEqual(pl.parseOsc7('http://x/y'), null);
      assert.strictEqual(pl.parseOsc7('file://h/%E0%A4%A'), null);
      const cols = 10;
      // "⏺ src/abc/" + "def.js:7" envuelta; ⏺ ocupa 1 celda, 日 dos
      const buf = fakeBuffer([{ text: 'x 日 src/a' }, { text: 'bc/d.js:7', wrapped: true }, { text: 'otra' }], cols);
      const ll = pl.logicalLine(buf, 1, cols);
      assert.strictEqual(ll.text.trimEnd(), 'x 日 src/abc/d.js:7');
      const [f] = pl.findPaths(ll.text);
      assert.deepStrictEqual([f.path, f.line], ['src/abc/d.js', 7]);
      const r = pl.spanRange(ll.cells, f.start, f.end);
      // 'x',' ','日'(2 celdas),' ' → la ruta empieza en la celda 6 de la fila 1 y acaba en la 9 de la 2
      assert.deepStrictEqual(r, { start: { x: 6, y: 1 }, end: { x: 9, y: 2 } });
      assert.deepStrictEqual(pl.logicalLine(buf, 0, cols).text, ll.text, 'desde la primera fila da la misma linea');
    });

    /* ── local ── */
    const home = path.join(tmp, 'home');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(home, 'notes', 'todo.md'), '# todo\n');
    fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'x\n');
    fs.writeFileSync(path.join(home, 'src-app.js'), 'x\n');
    const calls = [];
    const fakeShell = {
      openPath: async (p) => { calls.push(['openPath', p]); return ''; },
      showItemInFolder: (p) => { calls.push(['showItemInFolder', p]); },
      openExternal: async (u) => { calls.push(['openExternal', u]); },
    };
    const spawned = [];
    ops._shell = fakeShell;
    ops._spawn = (cmd, args) => { spawned.push([cmd, ...args]); };
    ops.homeDir = home;
    ops._which = (name) => { const p = path.join(binDir, name); return fs.existsSync(p) ? p : null; };
    // Sin `code` en PATH salvo cuando la prueba lo pone
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    process.env.PATH = `${binDir}:/usr/bin:/bin`;
    const sleeper = spawn('sleep', ['60'], { cwd: proj, stdio: 'ignore' });
    const fakeLs = { shells: new Map(), ents: new Map(), units: new Map() };
    ops.localShell = fakeLs;
    const openL = (p, extra = {}) => ops.open({ kind: 'local', sessionId: 's1', path: p, ...extra });
    const last = () => calls[calls.length - 1];

    try {
      await check('PL4 local: relativa contra OSC 7, /proc/<pid>/cwd real, MainPID de la unidad y HOME; ~/', async () => {
        // OSC 7 de este equipo
        calls.length = 0;
        let r = await openL('src/app.js', { osc: { host: os.hostname(), path: proj } });
        assert.deepStrictEqual([r.status, last()], ['opened', ['openPath', fs.realpathSync(path.join(proj, 'src', 'app.js'))]]);
        // OSC 7 de OTRO equipo (un ssh tecleado en una terminal local) no cuenta → HOME
        r = await openL('src/app.js', { osc: { host: 'otra-maquina-xyz', path: proj } });
        assert.strictEqual(r.status, 'missing');
        assert.strictEqual(r.path, path.join(home, 'src/app.js'));
        // /proc/<pid>/cwd del shell (un proceso real con cwd = proj)
        fakeLs.shells.set('s1', { pid: sleeper.pid });
        r = await openL('./src/app.js', { line: 3 });
        assert.deepStrictEqual(last(), ['openPath', fs.realpathSync(path.join(proj, 'src', 'app.js'))]);
        // Escapado de no_new_privs: el pid de node-pty es systemd-run; manda el MainPID de la unidad
        fakeLs.shells.set('s1', { pid: process.pid });
        fakeLs.units.set('s1', 'termilab-shell-s1');
        ops._exec = async (cmd, args) => {
          if (cmd === 'systemctl') { assert.deepStrictEqual(args.slice(-1), ['termilab-shell-s1.service']); return `${sleeper.pid}\n`; }
          throw new Error('nope');
        };
        calls.length = 0;
        await openL('src/app.js');
        assert.deepStrictEqual(last(), ['openPath', fs.realpathSync(path.join(proj, 'src', 'app.js'))]);
        fakeLs.units.clear();
        ops._exec = async () => { throw new Error('nope'); };
        // Sin cwd conocido → HOME; ~/ siempre HOME
        fakeLs.shells.clear();
        calls.length = 0;
        r = await openL('src-app.js');
        assert.deepStrictEqual(last(), ['openPath', fs.realpathSync(path.join(home, 'src-app.js'))]);
        await openL('~/notes/todo.md', { osc: { host: '', path: proj } });
        assert.deepStrictEqual(last(), ['openPath', fs.realpathSync(path.join(home, 'notes', 'todo.md'))]);
        const res = await ops.resolve({ kind: 'local', sessionId: 's1', path: 'notes/todo.md' });
        assert.deepStrictEqual(res, { path: path.join(home, 'notes/todo.md'), exists: true, isDir: false, dir: path.join(home, 'notes') });
      });

      await check('PL5 local, seguridad: carpeta abre carpeta, ejecutables y .desktop solo se muestran, fifo se niega, inexistente → missing, VS Code --goto', async () => {
        const exe = path.join(proj, 'run.sh');
        fs.writeFileSync(exe, '#!/bin/sh\ntouch PWNED\n', { mode: 0o755 });
        const desk = path.join(proj, 'evil.desktop');
        fs.writeFileSync(desk, '[Desktop Entry]\nExec=touch PWNED\n', { mode: 0o644 });
        const link = path.join(proj, 'notes.txt');
        fs.symlinkSync(desk, link);
        const fifo = path.join(proj, 'pipe');
        execFileSync('mkfifo', [fifo]);
        const abs = { osc: { host: '', path: proj } };
        calls.length = 0;
        let r = await openL('src', abs);
        assert.deepStrictEqual([r.status, last()], ['folder', ['openPath', fs.realpathSync(path.join(proj, 'src'))]]);
        calls.length = 0;
        for (const p of ['run.sh', 'evil.desktop', 'notes.txt']) {
          r = await openL(p, abs);
          assert.strictEqual(r.status, 'revealed', p);
        }
        assert.ok(calls.every(c => c[0] === 'showItemInFolder'), `algo fue a openPath: ${JSON.stringify(calls)}`);
        assert.deepStrictEqual(calls.map(c => path.basename(c[1])), ['run.sh', 'evil.desktop', 'evil.desktop']);
        await assert.rejects(openL('pipe', abs), /Not a regular file/);
        calls.length = 0;
        r = await openL('nope/missing.js', abs);
        assert.deepStrictEqual(r, { status: 'missing', path: path.join(proj, 'nope/missing.js') });
        assert.strictEqual(calls.length, 0, 'abrio algo que no existe');
        assert.ok(!fs.existsSync(path.join(proj, 'PWNED')) && !fs.existsSync(path.join(home, 'PWNED')));
        // VS Code: `code` en PATH y xdg-mime dice que es el editor → --goto archivo:linea:col
        fs.writeFileSync(path.join(binDir, 'code'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        ops._exec = async (cmd, args) => {
          if (cmd === 'xdg-mime' && args[1] === 'filetype') return 'application/javascript\n';
          if (cmd === 'xdg-mime' && args[1] === 'default') return 'code.desktop\n';
          throw new Error('nope');
        };
        calls.length = 0;
        spawned.length = 0;
        r = await openL('src/app.js', { ...abs, line: 12, col: 5 });
        const appJs = fs.realpathSync(path.join(proj, 'src', 'app.js'));
        assert.deepStrictEqual(spawned, [[path.join(binDir, 'code'), '--goto', `${appJs}:12:5`]]);
        assert.strictEqual(calls.length, 0);
        // Sin linea → la app por defecto, aunque sea code
        await openL('src/app.js', abs);
        assert.deepStrictEqual(last(), ['openPath', appJs]);
        // El ejecutable con code de editor: se edita en code (no ejecuta), no va a openPath
        spawned.length = 0;
        r = await openL('run.sh', abs);
        assert.strictEqual(r.editor, 'code');
        assert.strictEqual(spawned.length, 1);
        // Otro editor por defecto → nada de code
        ops._exec = async (cmd, args) => (args[1] === 'filetype' ? 'text/plain\n' : 'org.gnome.TextEditor.desktop\n');
        spawned.length = 0;
        await openL('src/app.js', { ...abs, line: 3 });
        assert.deepStrictEqual([spawned.length, last()], [0, ['openPath', appJs]]);
        fs.unlinkSync(path.join(binDir, 'code'));
        ops._exec = async () => { throw new Error('nope'); };
      });

      await check('PL6 canales paths:open/paths:resolve: envoltorio, sesion de otra ventana se niega, ssh sin sesion se niega', async () => {
        assert.ok(handlers.has('paths:open') && handlers.has('paths:resolve'));
        const sender = { isDestroyed: () => false, send: () => {} };
        let r = await handlers.get('paths:open')({ sender }, { kind: 'local', sessionId: null, path: 'nope/x.js' });
        assert.strictEqual(r.success, true);
        assert.strictEqual(r.data.status, 'missing');
        r = await handlers.get('paths:open')({ sender }, { kind: 'ssh', path: 'a/b.js' });
        assert.strictEqual(r.success, false);
        r = await handlers.get('paths:open')({ sender }, { kind: 'local', path: 'a\0b' });
        assert.strictEqual(r.success, false);
        const windowRegistry = require(path.join(ROOT, 'electron', 'window-registry.js'));
        const otra = { id: 991, isDestroyed: () => false, send: () => {}, once: () => {}, on: () => {} };
        windowRegistry.claim('sesion-ajena', otra);
        r = await handlers.get('paths:open')({ sender }, { kind: 'local', sessionId: 'sesion-ajena', path: 'x.js' });
        assert.strictEqual(r.success, false);
        assert.match(r.error, /another window/);
      });
    } finally {
      sleeper.kill();
    }

    /* ── remoto: sshd de verdad con HOME en un temporal ── */
    const rhome = path.join(tmp, 'remote-home');
    fs.mkdirSync(path.join(rhome, 'proj', 'src'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(rhome, 'proj', 'src', 'app.js'), 'remote v1\n');
    fs.writeFileSync(path.join(rhome, 'top.txt'), 'top\n');
    fs.writeFileSync(path.join(rhome, 'proj', 'evil.desktop'), '[Desktop Entry]\n');
    const sftpServer = SFTP_SERVERS.find(p => fs.existsSync(p)) || '/usr/lib/openssh/sftp-server';
    const wrapper = path.join(tmp, 'wrap.sh');
    fs.writeFileSync(wrapper, [
      '#!/bin/sh',
      `HOME='${rhome}'; export HOME`,
      'cd "$HOME" || exit 1',
      'case "$SSH_ORIGINAL_COMMAND" in',
      `  *sftp*) exec '${sftpServer}' ;;`,
      '  "") exec /bin/sh ;;',
      'esac',
      'exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"',
      '',
    ].join('\n'), { mode: 0o755 });
    let sshd = null; let sinSshd = null;
    try { sshd = await startRealSshd({ forceCommand: wrapper }); } catch (err) { sinSshd = err.message; }
    if (!sshd) {
      await check(`PL7 OMITIDA: no se pudo arrancar sshd (${sinSshd})`, () => {});
    } else {
      const sshService = svc('ssh-service.js');
      const hostKeyService = svc('host-key-service.js');
      const storeService = svc('store-service.js');
      const keeperService = svc('keeper-service.js');
      const ventanaHk = hostKeyService.mainWindow;
      hostKeyService.setMainWindow({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: (canal, d) => { if (canal === 'ssh:host-key-prompt') setTimeout(() => hostKeyService.respond(d.requestId, true), 5); } },
      });
      const agente = process.env.SSH_AUTH_SOCK;
      delete process.env.SSH_AUTH_SOCK;
      let sid = null;
      const sleeper2 = spawn('sleep', ['60'], { cwd: path.join(rhome, 'proj'), stdio: 'ignore' });
      const editCalls = [];
      /* El abridor del remoto es el de open-path-service (VS Code o openPath) */
      ops._shell = { openPath: async (p) => { editCalls.push(p); return ''; }, showItemInFolder: () => { throw new Error('remoto: showItemInFolder'); } };
      try {
        await storeService.writeRaw('known-hosts', []);
        sid = await sshService.connect({
          host: '127.0.0.1', port: sshd.port, username: sshd.user, privateKey: sshd.privateKey,
          label: 'sshd del arnes', hostId: 'h-pl', purpose: 'sftp', timeout: 8000,
        });
        await check('PL7 remoto: HOME/OSC 7, carpeta → dir, inexistente, .desktop se niega, edicion y subida, cwd por exec con el pid del keeper', async () => {
          const openR = (p, extra = {}) => ops.open({ kind: 'ssh', sessionId: sid, path: p, owner: 'term-pl7', ...extra });
          const realHome = fs.realpathSync(rhome);
          // Relativa sin cwd → HOME del servidor
          let r = await openR('top.txt');
          assert.strictEqual(r.status, 'editing', JSON.stringify(r));
          assert.strictEqual(r.path, path.posix.join(realHome, 'top.txt'));
          assert.strictEqual(editCalls.length, 1);
          assert.strictEqual(fs.readFileSync(editCalls[0], 'utf-8'), 'top\n');
          assert.strictEqual(fs.statSync(editCalls[0]).mode & 0o777, 0o600);
          // Contra OSC 7, y guardar → subir
          r = await openR('src/app.js', { osc: { host: 'srv', path: path.join(rhome, 'proj') } });
          assert.strictEqual(r.status, 'editing');
          const local = editCalls[editCalls.length - 1];
          fs.writeFileSync(local, 'remote v2\n');
          await sftpEditService.upload(r.editId);
          assert.strictEqual(fs.readFileSync(path.join(rhome, 'proj', 'src', 'app.js'), 'utf-8'), 'remote v2\n');
          sftpEditService.stop(r.editId);
          // Carpeta / inexistente / ejecutable
          r = await openR('proj/src');
          assert.deepStrictEqual(r, { status: 'dir', path: path.posix.join(realHome, 'proj/src') });
          r = await openR('proj/nope.js');
          assert.deepStrictEqual(r, { status: 'missing', path: path.posix.join(realHome, 'proj/nope.js') });
          const antes = editCalls.length;
          await assert.rejects(openR('proj/evil.desktop'), /Refusing to open/);
          assert.strictEqual(editCalls.length, antes);
          // resolve: ~/ y carpeta
          const res = await ops.resolve({ kind: 'ssh', sessionId: sid, path: '~/proj/src/app.js' });
          assert.deepStrictEqual(res, { path: path.posix.join(realHome, 'proj/src/app.js'), exists: true, isDir: false, dir: path.posix.join(realHome, 'proj/src') });
          // Con keeper: el pid del shell → UN exec acotado lee /proc/<tpgid|pid>/cwd en el servidor
          const s = sshService.sessions.get(sid);
          const prevFg = keeperService.foreground;
          s.keeper = { bin: '/x', session: { id: 'abc' } };
          keeperService.foreground = async () => ({ fgCommand: 'bash', isShell: true, shellPid: sleeper2.pid });
          try {
            assert.strictEqual(await ops.remoteCwd({ sessionId: sid, osc: null }), fs.realpathSync(path.join(rhome, 'proj')));
            r = await openR('src/app.js');
            assert.strictEqual(r.status, 'editing');
            sftpEditService.stop(r.editId);
          } finally {
            keeperService.foreground = prevFg;
            delete s.keeper;
          }
        });
      } finally {
        sleeper2.kill();
        await sftpEditService.cleanup('term-pl7').catch(() => {});
        if (sid) await sshService.disconnect(sid).catch(() => {});
        await sshd.stop();
        hostKeyService.setMainWindow(ventanaHk);
        if (agente) process.env.SSH_AUTH_SOCK = agente;
        await storeService.writeRaw('known-hosts', []);
        await storeService.writeRaw('connection-logs', []);
      }
    }

    await check('PL8 renderer: Ctrl+clic abre con el cwd de OSC 7, clic solo no; inexistente → toast; menu contextual corta el pegar; TerminalView lo conecta', async () => {
      const out = path.join(tmp, 'plp.cjs');
      esb(path.join(ROOT, 'src', 'components', 'Terminal', 'pathLinkProvider.js'), out, ['--loader:.css=empty']);
      const toasts = [];
      const listeners = {};
      const el = () => {
        const node = {
          children: [], style: {}, className: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} },
          setAttribute() {}, append(...k) { node.children.push(...k); }, appendChild(k) { node.children.push(k); return k; },
          remove() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 100, height: 60 }),
          contains: () => false, closest: () => null, focus() {},
        };
        return node;
      };
      const prevG = { window: global.window, document: global.document };
      const opened = [];
      let respuesta = { status: 'opened', path: '/x' };
      global.document = {
        body: { appendChild: (n) => { if (n.className === 'termilab-toast') toasts.push(n.textContent); } },
        createElement: el, addEventListener() {}, removeEventListener() {}, activeElement: null,
      };
      global.window = {
        innerWidth: 800, innerHeight: 600,
        addEventListener() {}, removeEventListener() {},
        electronAPI: { paths: { open: async (spec) => { opened.push(spec); return respuesta; }, resolve: async () => ({}) }, sftp: {} },
      };
      try {
        const mod = require(out);
        let provider = null; let osc7 = null;
        const rows = [{ text: 'Edited src/app.js:12 ok' }];
        const term = {
          cols: 40,
          modes: { mouseTrackingMode: 'none' },
          hasSelection: () => false,
          textarea: null,
          buffer: { active: fakeBuffer(rows, 40) },
          parser: { registerOscHandler: (n, fn) => { assert.strictEqual(n, 7); osc7 = fn; return { dispose() {} }; } },
          registerLinkProvider: (p) => { provider = p; return { dispose() {} }; },
        };
        const wrapper = el();
        wrapper.addEventListener = (t, fn, cap) => { listeners[t] = { fn, cap }; };
        wrapper.removeEventListener = () => {};
        const dispose = mod.attachPathLinks(term, wrapper, { target: () => ({ kind: 'local', sessionId: 'sid-1', owner: 'term-x' }), openSftpAt: () => {} });
        assert.strictEqual(osc7('file:///home/u/proj'), false, 'OSC 7 no debe consumirse');
        const links = await new Promise((res) => provider.provideLinks(1, res));
        assert.strictEqual(links.length, 1);
        assert.deepStrictEqual(links[0].range, { start: { x: 8, y: 1 }, end: { x: 20, y: 1 } });
        assert.strictEqual(links[0].decorations.underline, false, 'subrayado sin Ctrl');
        links[0].activate({ ctrlKey: false, metaKey: false });
        await new Promise(r => setTimeout(r, 5));
        assert.strictEqual(opened.length, 0, 'un clic sin Ctrl abrio');
        respuesta = { status: 'missing', path: '/home/u/proj/src/app.js' };
        links[0].activate({ ctrlKey: true });
        await new Promise(r => setTimeout(r, 5));
        assert.deepStrictEqual(opened, [{ kind: 'local', sessionId: 'sid-1', owner: 'term-x', path: 'src/app.js', line: 12, col: null, osc: { host: '', path: '/home/u/proj' } }]);
        assert.deepStrictEqual(toasts, ['File not found: /home/u/proj/src/app.js']);
        // Menu contextual: escucha en CAPTURA y corta la propagacion (no pega)
        assert.ok(listeners.contextmenu && listeners.contextmenu.cap === true, 'contextmenu no esta en captura');
        let cortado = false; let prevenido = false;
        const ev = { clientX: 5, clientY: 5, shiftKey: false, preventDefault: () => { prevenido = true; }, stopImmediatePropagation: () => { cortado = true; } };
        listeners.contextmenu.fn(ev);
        assert.ok(!cortado, 'sin raton encima de una ruta no debe cortar');
        links[0].hover({ ctrlKey: false });
        listeners.contextmenu.fn(ev);
        assert.ok(cortado && prevenido, 'sobre una ruta el menu tiene que cortar el pegar');
        dispose();
      } finally {
        global.window = prevG.window;
        global.document = prevG.document;
      }
      const tv = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Terminal', 'TerminalView.jsx'), 'utf-8');
      assert.ok(/const detachPaths = [^\n]*attachPathLinks\(term, containerRef\.current/.test(tv), 'TerminalView no conecta attachPathLinks');
      assert.ok(/disposed = true;\s*\n\s*detachPaths\(\);/.test(tv), 'TerminalView no suelta attachPathLinks');
      const guard = require(path.join(ROOT, 'electron', 'navigation-guard.js'));
      assert.strictEqual(guard.isExternalOk('file:///etc/passwd'), false);
      assert.strictEqual(guard.isExternalOk('https://x.dev'), true);
    });
  } finally {
    ops._shell = prev.shell; ops._spawn = prev.spawn; ops._exec = prev.exec; ops._which = null; ops.homeDir = prev.home; ops.localShell = prev.ls;
    sftpEditService._shell = prev.editShell;
    process.env.PATH = prev.path;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { seccionPathLinks, CORPUS, NEGATIVES };
