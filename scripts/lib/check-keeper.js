/**
 * Seccion KP del arnes del main (scripts/check-main.js): el session keeper
 * (electron/services/keeper-service.js + la costura _openShell de ssh-service)
 * contra un sshd de OpenSSH DE VERDAD, como este usuario y sin root.
 *
 * El sshd lleva ForceCommand a un envoltorio que pone HOME en una carpeta
 * temporal (nada se instala en el ~ real) y, segun ficheros de control,
 * falsea `uname` o hace que el keeper salga con 126 (noexec). Un segundo sshd
 * no tiene subsistema SFTP.
 *
 *  KP1  puro: id = base32(sha256(sessionKey))[:26], "keeper:<id>" se respeta;
 *       parseList, isShellCommand, lingerRiskFrom; el resolvedor encuentra los
 *       binarios en electron/keeper/bin (con manifest) y en <bundle>/keeper
 *       (Android, sin manifest).
 *  KP2  primera conexion sube el binario (0700, sha del manifest, aviso de
 *       instalacion una vez); la segunda no sube nada.
 *  KP3  binario corrompido en el servidor → se vuelve a subir.
 *  KP4  chmod 000 ~/.termilab → shell normal + linea "unavailable".
 *  KP5  uname desconocido → shell normal + "unsupported architecture".
 *  KP6  exit 126 (home noexec) → shell normal + "noexec".
 *  KP7  sin subsistema SFTP → sube por exec (cat) y funciona.
 *  KP8  matar el hijo de sshd (corte) → reconecta y re-engancha: mismo pid,
 *       lo que salio durante el corte esta en la repeticion, y Termilab no
 *       pinta nada encima de ella.
 *  KP9  otro cliente engancha la misma sesion → el primero recibe "opened
 *       elsewhere" (reason replaced) y NO reconecta.
 *  KP10 cerrar pestana: fgCommand = shell / "sleep"; End mata la sesion.
 *  KP11 desconectar = soltar (la sesion sigue); restaurar con clave propia
 *       re-engancha; restaurar una clave no creada aqui abre otra; adoptar
 *       ("Attach here") engancha la existente sin marcarla como propia.
 *  KP12 Background sessions por una conexion purpose:'sftp': lista y End.
 *  KP13 `exit` en el shell → ssh:close 'exited', sin reconexion.
 *  KP14 GC: tras instalar se borran otras versiones que ningun demonio usa.
 *  KP15 opcion apagada (host) o purpose:'sftp' → nunca keeper.
 *  KP16 tope de 20 sesiones (attach sale 103) → shell normal en la misma
 *       pestana con la linea "Too many background sessions", sin cerrar.
 *  KP17 binario borrado tras un prepare cacheado (attach sale 127) → shell
 *       normal; la cache se invalida y la siguiente conexion reinstala.
 *  KP18 el attach muere justo tras cada re-enganche → 3 ciclos y para con
 *       "Connection keeps dropping", en vez de reconectar para siempre.
 *  KP19 auto-reconexion / restauracion con la sesion enganchada en OTRO
 *       dispositivo → no la roba (reason 'elsewhere', error al restaurar);
 *       takeover manual si (newest wins). Nuestro propio attach viejo aun
 *       enganchado (sshd congelado) NO cuenta como "otro dispositivo".
 *  KP20 cerrar con solo el shell delante pero `sleep &` debajo → jobs
 *       ['sleep'] y closePlan pregunta; sin trabajos, cierre silencioso.
 *  KP21 Sessions → Background con sesiones de verdad: soltar por
 *       ssh:disconnect la lista (sin la clave privada en el archivo);
 *       adoptarla la quita; matarla en el servidor y listar el host
 *       (ssh:keeper-list) la reconcilia; End (ssh:keeper-end) no la lista.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { startRealSshd } = require('./real-sshd');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const espera = async (fn, ms = 8000) => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (fn()) return true; await sleep(20); }
  return false;
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const SFTP_SERVERS = ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server', '/usr/libexec/sftp-server'];

/* Hijos directos de un pid (por /proc) */
function hijosDe(pid) {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf-8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === pid) out.push(Number(d));
    } catch (_) { /* se fue */ }
  }
  return out;
}
/* El hijo de sshd de una conexion y sus descendientes sshd (en 9.x el que
   tiene el socket es un nieto: matar solo al hijo no corta nada) */
function sshdDeConexion(pids) {
  const out = [];
  const cola = [...pids];
  while (cola.length) {
    const p = cola.shift();
    let comm = '';
    try { comm = fs.readFileSync(`/proc/${p}/comm`, 'utf-8').trim(); } catch (_) { continue; }
    if (!/^sshd/.test(comm)) continue;
    out.push(p);
    cola.push(...hijosDe(p));
  }
  return out;
}
const vive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

async function seccionKeeper({ check, ROOT, handlers = null }) {
  const E = (...p) => require(path.join(ROOT, 'electron', ...p));
  const keeper = E('services', 'keeper-service.js');
  const sshService = E('services', 'ssh-service.js');
  const hostKeyService = E('services', 'host-key-service.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron', 'keeper', 'manifest.json'), 'utf-8'));

  await check('KP1 puro: ids, list, shell, linger y el resolvedor de binarios (escritorio y bundle Android)', () => {
    const a = keeper.keeperIdFor('tab-1');
    assert.match(a, /^[a-z2-7]{26}$/);
    assert.strictEqual(a, keeper.keeperIdFor('tab-1'));
    assert.notStrictEqual(a, keeper.keeperIdFor('tab-2'));
    assert.strictEqual(keeper.keeperIdFor('keeper:abcdef1234'), 'abcdef1234');
    assert.deepStrictEqual(keeper.parseList('{"id":"abcdefgh12","fgCommand":"vim"}\nbasura\n{"id":"../x"}\n').map(r => r.id), ['abcdefgh12']);
    assert.ok(keeper.isShellCommand('bash') && keeper.isShellCommand('-zsh') && keeper.isShellCommand(''));
    assert.ok(!keeper.isShellCommand('sleep') && !keeper.isShellCommand('claude'));
    assert.strictEqual(keeper.lingerRiskFrom('L:Linger=no\nK:b true\nC:'), true);
    assert.strictEqual(keeper.lingerRiskFrom('L:Linger=yes\nK:b true\nC:'), false);
    assert.strictEqual(keeper.lingerRiskFrom('L:Linger=no\nK:b false\nC:KillUserProcesses=yes'), false);
    assert.strictEqual(keeper.lingerRiskFrom('L:\nK:\nC:KillUserProcesses=yes'), true);
    assert.strictEqual(keeper.lingerRiskFrom('L:\nK:\nC:'), false);
    const local = keeper.localBinaries();
    assert.strictEqual(local.dir, path.join(ROOT, 'electron', 'keeper', 'bin'));
    assert.strictEqual(local.kv, manifest.kv);
    assert.deepStrictEqual(Object.keys(local.binaries).sort(), Object.keys(manifest.binaries).sort());
    /* Android: el bundle esta en <nodejs>/main.js y los binarios en <nodejs>/keeper, sin manifest */
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-kp-bundle-'));
    try {
      fs.mkdirSync(path.join(bundle, 'keeper'));
      for (const b of Object.values(manifest.binaries)) fs.copyFileSync(path.join(local.dir, b.file), path.join(bundle, 'keeper', b.file));
      const file = path.join(bundle, 'main.js');
      const m = new Module(file);
      m.filename = file;
      m.paths = Module._nodeModulePaths(bundle);
      m._compile(fs.readFileSync(path.join(ROOT, 'electron', 'services', 'keeper-service.js'), 'utf-8'), file);
      const l2 = m.exports.localBinaries();
      assert.strictEqual(l2.dir, path.join(bundle, 'keeper'), `Android: ${l2 && l2.dir}`);
      assert.strictEqual(l2.kv, manifest.kv);
      assert.deepStrictEqual(Object.keys(l2.binaries).sort(), Object.keys(manifest.binaries).sort());
    } finally { fs.rmSync(bundle, { recursive: true, force: true }); }
  });

  await check('KP1b la opcion: host on/off manda; sin override, Settings → Terminal (por defecto on); nunca para sftp', async () => {
    const store = E('services', 'store-service.js');
    const realHosts = store.getHosts; const realSettings = store.getSettings;
    let terminal = {};
    store.getHosts = async () => [{ id: 'h-on', keepSessions: 'on' }, { id: 'h-off', keepSessions: 'off' }, { id: 'h-def', keepSessions: null }];
    store.getSettings = async () => ({ terminal });
    try {
      const w = (extra) => keeper.wanted({ sessionKey: 'k', ...extra });
      assert.strictEqual(await w({ hostId: 'h-def' }), true, 'por defecto deberia estar encendido');
      terminal = { keepSessions: false };
      assert.strictEqual(await w({ hostId: 'h-def' }), false);
      assert.strictEqual(await w({ hostId: 'h-on' }), true, 'el override on del host no manda');
      assert.strictEqual(await w({ hostId: 'quick-uuid' }), false, 'quick connect: deberia seguir el ajuste global');
      terminal = {};
      assert.strictEqual(await w({ hostId: 'h-off' }), false, 'el override off del host no manda');
      assert.strictEqual(await w({ hostId: 'h-on', purpose: 'sftp' }), false, 'sftp');
      assert.strictEqual(await keeper.wanted({ hostId: 'h-on' }), false, 'sin sessionKey');
    } finally { store.getHosts = realHosts; store.getSettings = realSettings; }
  });

  /* ── sshd de verdad ── */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-kp-'));
  const home = path.join(tmp, 'home');
  const ctl = path.join(tmp, 'ctl');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(path.join(ctl, 'fakebin'), { recursive: true });
  fs.writeFileSync(path.join(ctl, 'fakebin', 'uname'), '#!/bin/sh\necho "Linux sparc64"\n', { mode: 0o755 });
  const sftpServer = SFTP_SERVERS.find(p => fs.existsSync(p)) || '/usr/lib/openssh/sftp-server';
  const wrapper = path.join(tmp, 'wrap.sh');
  fs.writeFileSync(wrapper, [
    '#!/bin/sh',
    `CTL='${ctl}'`,
    `HOME='${home}'; export HOME`,
    'SHELL=/bin/bash; export SHELL',
    'cd "$HOME" 2>/dev/null',
    'if [ -f "$CTL/fake-uname" ]; then PATH="$CTL/fakebin:$PATH"; export PATH; fi',
    'case "$SSH_ORIGINAL_COMMAND" in',
    `  *sftp*) exec '${sftpServer}' ;;`,
    '  "") exec /bin/bash -l ;;',
    'esac',
    'if [ -f "$CTL/attach-exit" ]; then case "$SSH_ORIGINAL_COMMAND" in *termilab-keeper-*" attach "*) exit "$(cat "$CTL/attach-exit")";; esac; fi',
    'if [ -f "$CTL/noexec" ]; then case "$SSH_ORIGINAL_COMMAND" in *termilab-keeper-*) echo "Permission denied" >&2; exit 126;; esac; fi',
    'exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"',
    '',
  ].join('\n'), { mode: 0o755 });

  let sshd = null; let sshdNoSftp = null; let sinSshd = null;
  try {
    sshd = await startRealSshd({ forceCommand: wrapper });
    sshdNoSftp = await startRealSshd({ forceCommand: wrapper, noSftp: true });
  } catch (err) { sinSshd = err.message; }
  if (sinSshd) {
    await check(`KP2-KP15 OMITIDAS: no se pudo arrancar sshd (${sinSshd})`, () => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    return;
  }

  const arch = os.arch() === 'x64' ? 'x86_64' : os.arch() === 'arm64' ? 'aarch64' : os.arch();
  const binInfo = manifest.binaries[arch];
  const binDir = path.join(home, '.termilab', 'bin');
  const binPath = path.join(binDir, binInfo.file);

  const recibido = [];
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (c, ...a) => recibido.push([c, ...a]) } };
  const prevWin = sshService.mainWindow;
  const prevHkWin = hostKeyService.mainWindow;
  const prevState = { stateFile: keeper.stateFile, state: keeper._state };
  sshService.setMainWindow(win);
  hostKeyService.setMainWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (canal, d) => { if (canal === 'ssh:host-key-prompt') setTimeout(() => hostKeyService.respond(d.requestId, true), 5); } },
  });
  keeper.stateFile = path.join(tmp, 'keeper-state.json');
  keeper._state = null;
  keeper.clearCache();
  const delays = sshService.reconnectDelays;
  sshService.reconnectDelays = [100, 200, 400, 800];
  const agente = process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AUTH_SOCK;

  const texto = (sid) => recibido.filter(([c, s]) => c === 'ssh:data' && s === sid).map(([, , d]) => d).join('');
  const cierres = (sid) => recibido.filter(([c, s]) => c === 'ssh:close' && s === sid).map(([, , info]) => info || {});
  const pushes = (sid) => recibido.filter(([c, p]) => c === 'ssh:reconnect' && p.sessionId === sid).map(([, p]) => p.state);
  const abiertas = [];
  const base = (srv) => ({ host: '127.0.0.1', port: srv.port, username: srv.user, privateKey: srv.privateKey, timeout: 15000, keepSessions: true });
  const conecta = async (extra = {}, srv = sshd) => {
    const s = await sshService.connect({ ...base(srv), ...extra });
    abiertas.push(s);
    /* What TerminalView does once its listeners exist: releases held output */
    sshService.resize(s, 100, 30);
    return s;
  };
  const pidDe = async (s, tag) => {
    sshService.sendData(s, `echo ${tag}:$$\r`);
    let pid = null;
    const re = new RegExp(`${tag}:(\\d+)`);
    await espera(() => { const m = re.exec(texto(s)); if (m) pid = Number(m[1]); return !!m; }, 8000);
    return pid;
  };
  const clave = (n) => `kp-${n}-${crypto.randomBytes(4).toString('hex')}`;
  const listaLocal = () => {
    try {
      return keeper.parseList(execFileSync(binPath, ['list'], { env: { ...process.env, HOME: home }, encoding: 'utf-8', timeout: 5000 }));
    } catch (_) { return []; }
  };

  try {
    await check('KP2 primera conexion sube el binario (0700, sha del manifest, aviso una vez); la segunda no sube', async () => {
      const s = await conecta({ sessionKey: clave(2) });
      const k = sshService.sessions.get(s).keeper;
      assert.ok(k && k.installed === true, `no se instalo: ${JSON.stringify(k)} / ${texto(s).slice(0, 300)}`);
      assert.strictEqual(sha(fs.readFileSync(binPath)), binInfo.sha256);
      for (const d of [path.join(home, '.termilab'), binDir, path.join(home, '.termilab', 'run')]) {
        const st = fs.lstatSync(d);
        assert.strictEqual(st.mode & 0o777, 0o700, `${d} ${(st.mode & 0o777).toString(8)}`);
      }
      assert.strictEqual(fs.statSync(binPath).mode & 0o777, 0o700);
      assert.ok(await pidDe(s, 'PID'), `el shell del keeper no responde: ${JSON.stringify(texto(s).slice(-300))}`);
      assert.ok(/installed its session keeper in ~\/\.termilab/.test(texto(s)), 'sin el aviso de instalacion');
      assert.ok(texto(s).indexOf('installed its session keeper') > texto(s).indexOf('\x1bc'), 'el aviso va antes del ESC c (se borraria)');
      assert.ok(!fs.readdirSync(binDir).some(n => n.startsWith('.tmp-')), 'quedo un temporal');
      keeper.clearCache();
      const s2 = await conecta({ sessionKey: clave(2) });
      const k2 = sshService.sessions.get(s2).keeper;
      assert.ok(k2 && k2.installed === false, `volvio a subir: ${JSON.stringify(k2)}`);
      assert.ok(await pidDe(s2, 'PID'));
      assert.ok(!/installed its session keeper/.test(texto(s2)), 'el aviso salio dos veces');
      await sshService.keeperEnd(s); await sshService.keeperEnd(s2);
    });

    await check('KP2b la salida de una sesion keeper se retiene hasta el primer resize (el renderer aun no escucha) y luego sale entera, en orden', async () => {
      const s = await sshService.connect({ ...base(sshd), sessionKey: clave('2b') });
      abiertas.push(s);
      await sleep(700);
      assert.strictEqual(texto(s), '', 'salio salida antes de que la terminal escuchara');
      sshService.resize(s, 100, 30);
      assert.ok(await espera(() => texto(s).startsWith('\x1bc') || texto(s).includes('\x1bc')), `no llego la repeticion: ${JSON.stringify(texto(s).slice(0, 80))}`);
      assert.ok(await pidDe(s, 'PID'));
      await sshService.keeperEnd(s);
    });

    await check('KP3 binario corrompido en el servidor → se vuelve a subir', async () => {
      fs.writeFileSync(binPath, 'no soy un keeper');
      keeper.clearCache();
      const s = await conecta({ sessionKey: clave(3) });
      assert.ok(sshService.sessions.get(s).keeper?.installed === true, 'no lo resubio');
      assert.strictEqual(sha(fs.readFileSync(binPath)), binInfo.sha256);
      assert.ok(await pidDe(s, 'PID'));
      await sshService.keeperEnd(s);
    });

    await check('KP4 chmod 000 ~/.termilab → shell normal con la linea "unavailable"', async () => {
      fs.chmodSync(path.join(home, '.termilab'), 0o000);
      keeper.clearCache();
      try {
        const s = await conecta({ sessionKey: clave(4) });
        assert.ok(!sshService.sessions.get(s).keeper, 'uso el keeper');
        assert.ok(await espera(() => /Session keeping unavailable on this host \(.*permission denied.*\): using a plain shell/.test(texto(s))), `sin la linea: ${JSON.stringify(texto(s).slice(0, 300))}`);
        assert.ok(await pidDe(s, 'PLAIN'), 'el shell normal no responde');
        await sshService.disconnect(s);
      } finally { fs.chmodSync(path.join(home, '.termilab'), 0o700); }
    });

    await check('KP5 uname desconocido (sparc64) → shell normal con "unsupported architecture"', async () => {
      fs.writeFileSync(path.join(ctl, 'fake-uname'), '');
      keeper.clearCache();
      try {
        const s = await conecta({ sessionKey: clave(5) });
        assert.ok(!sshService.sessions.get(s).keeper);
        assert.ok(await espera(() => texto(s).includes('Session keeping unavailable on this host (unsupported architecture sparc64)')), JSON.stringify(texto(s).slice(0, 300)));
        assert.ok(await pidDe(s, 'PLAIN'));
        await sshService.disconnect(s);
      } finally { fs.unlinkSync(path.join(ctl, 'fake-uname')); }
    });

    await check('KP6 el keeper sale con 126 (home noexec) → shell normal con "noexec"', async () => {
      fs.writeFileSync(path.join(ctl, 'noexec'), '');
      keeper.clearCache();
      try {
        const s = await conecta({ sessionKey: clave(6) });
        assert.ok(!sshService.sessions.get(s).keeper);
        assert.ok(await espera(() => /unavailable on this host \(.*noexec.*\)/.test(texto(s))), JSON.stringify(texto(s).slice(0, 300)));
        await sshService.disconnect(s);
      } finally { fs.unlinkSync(path.join(ctl, 'noexec')); }
    });

    await check('KP7 sin subsistema SFTP → sube por exec (cat) y el keeper funciona', async () => {
      /* De verdad no hay SFTP en ese sshd */
      const sf = await sshService.connect({ ...base(sshdNoSftp), purpose: 'sftp' });
      const err = await new Promise(r => sshService.getClient(sf).sftp((e) => r(e)));
      await sshService.disconnect(sf);
      assert.ok(err, 'el sshd sin Subsystem acepto SFTP');
      fs.unlinkSync(binPath);
      keeper.clearCache();
      const s = await conecta({ sessionKey: clave(7) }, sshdNoSftp);
      assert.ok(sshService.sessions.get(s).keeper?.installed === true, `no se instalo por exec: ${JSON.stringify(texto(s).slice(0, 300))}`);
      assert.strictEqual(sha(fs.readFileSync(binPath)), binInfo.sha256);
      assert.strictEqual(fs.statSync(binPath).mode & 0o777, 0o700);
      assert.ok(await pidDe(s, 'PID'));
      await sshService.keeperEnd(s);
    });

    await check('KP8 matar el hijo de sshd → reconecta y re-engancha: mismo pid, la salida del corte esta, nada pintado encima', async () => {
      keeper.clearCache();
      const antes = new Set(hijosDe(sshd.pid));
      const s = await conecta({ sessionKey: clave(8) });
      const pid1 = await pidDe(s, 'PID');
      assert.ok(pid1);
      const nuevos = hijosDe(sshd.pid).filter(p => !antes.has(p));
      assert.ok(nuevos.length >= 1, 'no encuentro el hijo de sshd de esta conexion');
      sshService.sendData(s, 'for i in $(seq 1 30); do echo N$i; sleep 0.05; done\r');
      assert.ok(await espera(() => /\bN2\r\n/.test(texto(s)), 5000), 'el bucle no arranco');
      for (const p of sshdDeConexion(nuevos)) { try { process.kill(p, 'SIGKILL'); } catch (_) { /* ya */ } }
      assert.ok(await espera(() => pushes(s).includes('reconnected'), 10000), `no reconecto: ${pushes(s)}`);
      assert.strictEqual(cierres(s).length, 0, 'mando ssh:close en un corte');
      sshService.resize(s, 100, 30);
      /* La repeticion empieza con ESC c: todo lo que va detras es del keeper */
      assert.ok(await espera(() => { const t = texto(s); return t.slice(t.lastIndexOf('\x1bc')).includes('N30'); }, 8000), 'la repeticion no trae N30');
      const t = texto(s);
      const replay = t.slice(t.lastIndexOf('\x1bc'));
      for (let i = 1; i <= 30; i++) assert.ok(new RegExp(`\\bN${i}\\r\\n`).test(replay), `falta N${i} en la repeticion`);
      assert.ok(!replay.includes('[Reconnected]') && !replay.includes('Reconnecting'), 'Termilab pinto encima de la repeticion');
      assert.strictEqual(await pidDe(s, 'PIDB'), pid1, 'otro shell tras reconectar');
      await sshService.keeperEnd(s);
    });

    await check('KP9 otro cliente engancha la misma sesion → el primero: "opened elsewhere", reason replaced, sin reconexion', async () => {
      const k = clave(9);
      const s1 = await conecta({ sessionKey: k });
      const pid1 = await pidDe(s1, 'PID');
      const s2 = await conecta({ sessionKey: k });
      assert.ok(await espera(() => cierres(s1).length > 0, 8000), 's1 no se cerro');
      assert.strictEqual(cierres(s1)[0].reason, 'replaced');
      assert.ok(texto(s1).includes('Session opened elsewhere'));
      await sleep(400);
      assert.deepStrictEqual(pushes(s1), [], 's1 intento reconectar');
      assert.ok(!sshService.isConnected(s1));
      assert.strictEqual(await pidDe(s2, 'PIDB'), pid1, 's2 no engancho el mismo shell');
      await sshService.keeperEnd(s2);
    });

    await check('KP10 cerrar pestana: en reposo fg = shell; con `sleep 600` fg = "sleep"; End mata la sesion', async () => {
      const k = clave(10);
      const s = await conecta({ sessionKey: k });
      const pid = await pidDe(s, 'PID');
      const fg0 = await sshService.keeperForeground(s);
      assert.ok(fg0.keeper && fg0.isShell, `en reposo: ${JSON.stringify(fg0)}`);
      sshService.sendData(s, 'sleep 600\r');
      let fg = null;
      assert.ok(await espera(() => false, 300) || true);
      for (let i = 0; i < 20 && !(fg && fg.fgCommand === 'sleep'); i++) { fg = await sshService.keeperForeground(s); await sleep(100); }
      assert.deepStrictEqual({ fg: fg.fgCommand, shell: fg.isShell }, { fg: 'sleep', shell: false });
      const t0 = Date.now();
      await sshService.keeperForeground(s);
      assert.ok(Date.now() - t0 < 2500, 'la consulta no respeta el tope de 2 s');
      await sshService.keeperEnd(s);
      assert.ok(await espera(() => !vive(pid), 6000), 'el shell sigue vivo tras End');
      assert.ok(!listaLocal().some(r => r.id === keeper.keeperIdFor(k)), 'la sesion sigue listada tras End');
      assert.ok(!keeper.isOwned(keeper.keeperIdFor(k)), 'End no la olvido');
    });

    await check('KP11 desconectar = soltar; restaurar propia re-engancha; restaurar ajena abre otra; adoptar engancha sin ser propia', async () => {
      const k = clave(11);
      const id = keeper.keeperIdFor(k);
      let s = await conecta({ sessionKey: k });
      const pid = await pidDe(s, 'PID');
      assert.ok(keeper.isOwned(id), 'una sesion creada aqui no quedo como propia');
      await sshService.disconnect(s);
      assert.ok(await espera(() => listaLocal().some(r => r.id === id && !r.attached), 4000), 'la sesion no sigue suelta en el servidor');
      assert.ok(vive(pid), 'desconectar mato el shell');
      s = await conecta({ sessionKey: k, restored: true });
      assert.strictEqual(await pidDe(s, 'PIDR'), pid, 'restaurar no re-engancho');
      await sshService.disconnect(s);
      /* Una clave que este equipo no creo: no se roba, se abre otra */
      const ajena = clave('ajena');
      const s3 = await conecta({ sessionKey: ajena, restored: true });
      const pid3 = await pidDe(s3, 'PIDA');
      assert.ok(pid3 && pid3 !== pid);
      assert.notStrictEqual(sshService.sessions.get(s3).keeper.session.id, keeper.keeperIdFor(ajena));
      await sshService.keeperEnd(s3);
      /* Adoptar */
      const s4 = await conecta({ sessionKey: `keeper:${id}`, adopted: true });
      assert.strictEqual(await pidDe(s4, 'PIDD'), pid, 'adoptar no engancho la existente');
      keeper.forget(id);
      await sshService.disconnect(s4);
      assert.ok(!keeper.isOwned(id), 'adoptar la marco como propia');
      /* Adoptar una que ya no existe: no se crea */
      const s5 = await conecta({ sessionKey: 'keeper:zzzzzzzzzzzz', adopted: true });
      assert.ok(await espera(() => cierres(s5).length > 0, 6000));
      assert.strictEqual(cierres(s5)[0].reason, 'gone');
      assert.ok(!listaLocal().some(r => r.id === 'zzzzzzzzzzzz'));
      const sk = await conecta({ sessionKey: `keeper:${id}`, adopted: true });
      await sshService.keeperEnd(sk);
    });

    await check('KP12 Background sessions por una conexion purpose:sftp: lista con campos y End', async () => {
      const k = clave(12);
      const s = await conecta({ sessionKey: k });
      sshService.sendData(s, 'sleep 500\r');
      await sleep(300);
      await sshService.disconnect(s);
      const sf = await sshService.connect({ ...base(sshd), purpose: 'sftp' });
      abiertas.push(sf);
      const r = await sshService.keeperList(sf);
      const row = r.rows.find(x => x.id === keeper.keeperIdFor(k));
      assert.ok(r.installed && row, JSON.stringify(r));
      assert.strictEqual(row.fgCommand, 'sleep');
      assert.ok(row.created > 0 && row.lastAttach > 0 && row.attached === false && row.keeperVersion === manifest.kv, JSON.stringify(row));
      await sshService.keeperKill(sf, row.id);
      const r2 = await sshService.keeperList(sf);
      assert.ok(!r2.rows.some(x => x.id === row.id), 'End no la quito');
      await sshService.disconnect(sf);
    });

    await check('KP21 Background con sshd real: soltar la lista; adoptar la quita; matarla y listar reconcilia; End no la lista', async () => {
      if (!handlers) throw new Error('falta handlers (check-main los pasa)');
      const bg = E('services', 'background-sessions.js');
      const call = async (canal, ...args) => {
        const r = await handlers.get(canal)({ sender: null }, ...args);
        assert.ok(r && r.success, `${canal}: ${r && r.error}`);
        return r.data;
      };
      const prevFile = bg.file;
      bg.file = path.join(tmp, 'background-sessions.json');
      bg._reset();
      const env = { ...process.env, HOME: home };
      try {
        const k = clave(21);
        const id = keeper.keeperIdFor(k);
        const s = await conecta({ sessionKey: k, hostId: 'kp-host', label: 'KP host' });
        const pid = await pidDe(s, 'P21');
        await call('ssh:disconnect', s);
        const r = bg.list().find(x => x.keeperId === id);
        assert.ok(r && r.kind === 'ssh' && r.hostId === 'kp-host' && r.label === 'KP host' && r.sessionKey === k, JSON.stringify(bg.list()));
        assert.ok(await espera(() => listaLocal().some(x => x.id === id && !x.attached), 4000), 'la sesion no sigue suelta en el servidor');
        const disco = fs.readFileSync(bg.file, 'utf-8');
        const pk = String(sshd.privateKey || '');
        assert.ok(pk.length > 40 && !disco.includes(pk.split('\n')[1] || pk.slice(30, 70)), 'la clave privada llego al archivo');
        /* Reabrirla (Attach here / el dock): adoptada → fuera de la lista */
        const s2 = await conecta({ sessionKey: `keeper:${id}`, adopted: true, hostId: 'kp-host', label: 'KP host' });
        assert.strictEqual(await pidDe(s2, 'P21B'), pid, 'adoptar no engancho la misma');
        assert.ok(!bg.has(id), 're-engancharla no la quito de Background');
        await call('ssh:disconnect', s2);
        assert.ok(bg.has(id), 'soltarla otra vez no la volvio a listar');
        /* Muere en el servidor (otro equipo la acabo); listar ese host reconcilia */
        try { execFileSync(binPath, ['kill', id], { env, timeout: 5000, stdio: 'ignore' }); } catch (_) { /* 102 */ }
        const sf = await sshService.connect({ ...base(sshd), purpose: 'sftp', hostId: 'kp-host' });
        abiertas.push(sf);
        const lista = await call('ssh:keeper-list', sf);
        assert.ok(lista.installed && !lista.rows.some(x => x.id === id));
        assert.ok(!bg.has(id), 'ssh:keeper-list no la quito');
        await sshService.disconnect(sf);
        /* End desde la pestana: se acaba, nunca a Background */
        const k3 = clave('21e');
        const s3 = await conecta({ sessionKey: k3, hostId: 'kp-host' });
        await pidDe(s3, 'P21E');
        await call('ssh:keeper-end', s3);
        assert.ok(!bg.has(keeper.keeperIdFor(k3)), 'End la dejo en Background');
        assert.deepStrictEqual(bg.list(), []);
      } finally {
        bg._reset();
        bg.file = prevFile;
      }
    });

    await check('KP13 `exit` en el shell → ssh:close "exited", sin reconexion, olvidada', async () => {
      const k = clave(13);
      const s = await conecta({ sessionKey: k });
      await pidDe(s, 'PID');
      sshService.sendData(s, 'exit\r');
      assert.ok(await espera(() => cierres(s).length > 0, 6000), 'exit no cerro');
      assert.strictEqual(cierres(s)[0].reason, 'exited');
      await sleep(300);
      assert.deepStrictEqual(pushes(s), []);
      assert.ok(!keeper.isOwned(keeper.keeperIdFor(k)));
    });

    await check('KP14 GC: tras instalar se borran otras versiones sin demonio y los temporales', async () => {
      fs.writeFileSync(path.join(binDir, `termilab-keeper-0-${arch}`), 'viejo', { mode: 0o700 });
      fs.writeFileSync(path.join(binDir, '.tmp-abcdef'), 'resto', { mode: 0o600 });
      fs.unlinkSync(binPath);
      keeper.clearCache();
      const s = await conecta({ sessionKey: clave(14) });
      assert.ok(sshService.sessions.get(s).keeper?.installed);
      assert.ok(await espera(() => !fs.existsSync(path.join(binDir, `termilab-keeper-0-${arch}`)) && !fs.existsSync(path.join(binDir, '.tmp-abcdef')), 5000),
        `quedan: ${fs.readdirSync(binDir)}`);
      assert.ok(fs.existsSync(binPath));
      await sshService.keeperEnd(s);
    });

    await check('KP15 opcion apagada o purpose:sftp → nunca keeper, sin avisos', async () => {
      const s = await conecta({ sessionKey: clave(15), keepSessions: false });
      assert.ok(!sshService.sessions.get(s).keeper);
      assert.ok(await pidDe(s, 'PLAIN'));
      assert.ok(!/Session keeping|session keeper/.test(texto(s)));
      await sshService.disconnect(s);
      const sf = await sshService.connect({ ...base(sshd), purpose: 'sftp', sessionKey: clave(15) });
      assert.ok(!sshService.sessions.get(sf).keeper && !sshService.sessions.get(sf).stream);
      await sshService.disconnect(sf);
    });
    await check('KP16 tope de 20 sesiones (exit 103) → shell normal en la misma pestana, linea "Too many background sessions", no se cierra', async () => {
      const env = { ...process.env, HOME: home };
      const creadas = [];
      try {
        for (let i = listaLocal().length; i < 20; i++) {
          const id = `kpcap${String(i).padStart(4, '0')}${crypto.randomBytes(2).toString('hex')}`;
          try { execFileSync(binPath, ['attach', id, '--create'], { env, input: '', timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'] }); } catch (e) { if (e.status !== 77) throw e; }
          creadas.push(id);
        }
        assert.ok(listaLocal().length >= 20, `solo hay ${listaLocal().length} sesiones`);
        const k = clave(16);
        const s = await conecta({ sessionKey: k });
        assert.ok(await espera(() => texto(s).includes('Too many background sessions on this server (20): close some in Host → Background sessions; using a plain shell'), 8000),
          `sin la linea: ${JSON.stringify(texto(s).slice(-300))}`);
        assert.ok(await pidDe(s, 'PLAIN'), 'el shell normal no responde');
        assert.strictEqual(cierres(s).length, 0, 'cerro la pestana');
        assert.ok(!sshService.sessions.get(s).keeper, 'sigue marcada como keeper');
        assert.ok(!keeper.isOwned(keeper.keeperIdFor(k)), 'quedo como propia una sesion que no se creo');
        await sshService.disconnect(s);
      } finally {
        for (const id of creadas) { try { execFileSync(binPath, ['kill', id], { env, timeout: 5000 }); } catch (_) { /* ya */ } }
      }
    });

    await check('KP17 binario borrado con el prepare en cache (exit 127) → shell normal; la siguiente conexion reinstala', async () => {
      keeper.clearCache();
      const s0 = await conecta({ sessionKey: clave(17) });
      assert.ok(sshService.sessions.get(s0).keeper);
      await sshService.keeperEnd(s0);
      fs.unlinkSync(binPath);
      const s = await conecta({ sessionKey: clave(17) });
      assert.ok(await espera(() => /Session keeper not found on the server \(exit 127\): using a plain shell/.test(texto(s)), 8000), `sin la linea: ${JSON.stringify(texto(s).slice(-300))}`);
      assert.ok(await pidDe(s, 'PLAIN'), 'el shell normal no responde');
      assert.strictEqual(cierres(s).length, 0, 'cerro la pestana');
      await sshService.disconnect(s);
      const s2 = await conecta({ sessionKey: clave(17) });
      assert.ok(sshService.sessions.get(s2).keeper?.installed === true, 'la cache no se invalido: no reinstalo');
      assert.ok(await pidDe(s2, 'PID'));
      await sshService.keeperEnd(s2);
    });

    await check('KP18 el attach muere tras cada re-enganche → 3 ciclos y para ("Connection keeps dropping"), sin bucle', async () => {
      const marca = path.join(ctl, 'attach-exit');
      fs.writeFileSync(marca, '77');
      try {
        const s = await conecta({ sessionKey: clave(18) });
        assert.ok(await espera(() => cierres(s).length > 0, 15000), `no paro: ${pushes(s).join(',')}`);
        assert.strictEqual(cierres(s)[0].reason, 'lost');
        assert.ok(texto(s).includes('Connection keeps dropping: reconnect manually'), JSON.stringify(texto(s).slice(-300)));
        assert.strictEqual(pushes(s).filter(x => x === 'reconnected').length, 3, `ciclos: ${pushes(s).join(',')}`);
        const n = pushes(s).length;
        await sleep(1200);
        assert.strictEqual(pushes(s).length, n, 'siguio reconectando tras parar');
        assert.ok(!sshService.isConnected(s));
      } finally { fs.unlinkSync(marca); }
    });

    await check('KP19 auto-reconexion/restauracion no roban una sesion enganchada en otro dispositivo; takeover si; nuestro attach viejo no cuenta', async () => {
      const { spawn } = require('child_process');
      const env = { ...process.env, HOME: home };
      const k = clave(19);
      const id = keeper.keeperIdFor(k);
      /* a) nuestro propio attach viejo sigue enganchado (sshd congelado): re-engancha */
      const antes = new Set(hijosDe(sshd.pid));
      let s = await conecta({ sessionKey: k });
      const pid = await pidDe(s, 'PID');
      assert.ok(await espera(() => typeof sshService.sessions.get(s).keeper?.lastAttach === 'number', 4000), 'no leyo lastAttach tras enganchar');
      const congelados = sshdDeConexion(hijosDe(sshd.pid).filter(p => !antes.has(p)));
      assert.ok(congelados.length, 'no encuentro el sshd de la conexion');
      for (const p of congelados) process.kill(p, 'SIGSTOP');
      try {
        sshService.sessions.get(s).client._sock.destroy();
        assert.ok(await espera(() => pushes(s).includes('reconnected') || cierres(s).length > 0, 10000), `no reconecto: ${pushes(s)}`);
        assert.deepStrictEqual(cierres(s), [], 'tomo nuestro attach viejo por otro dispositivo');
        assert.strictEqual(await pidDe(s, 'PIDB'), pid);
      } finally { for (const p of congelados) { try { process.kill(p, 'SIGKILL'); } catch (_) { /* ya */ } } }
      /* b) corte, y mientras tanto otro dispositivo engancha: la reconexion no lo echa */
      await sleep(1100);   // lastAttach va en segundos
      const delays0 = sshService.reconnectDelays;
      sshService.reconnectDelays = [1500, 200];
      let otro = null;
      try {
        const antes2 = new Set(hijosDe(sshd.pid));
        const s0 = s;
        s = await conecta({ sessionKey: k });   // engancha la misma (el anterior sale con 75)
        assert.ok(await espera(() => cierres(s0).length > 0, 6000));
        assert.strictEqual(await pidDe(s, 'PIDC'), pid);
        assert.ok(await espera(() => typeof sshService.sessions.get(s).keeper?.lastAttach === 'number', 4000));
        await sleep(1100);
        for (const p of sshdDeConexion(hijosDe(sshd.pid).filter(p2 => !antes2.has(p2)))) { try { process.kill(p, 'SIGKILL'); } catch (_) { /* ya */ } }
        assert.ok(await espera(() => pushes(s).includes('lost'), 5000), 'no noto el corte');
        assert.ok(await espera(() => listaLocal().some(r => r.id === id && !r.attached), 3000), 'el attach viejo sigue enganchado');
        otro = spawn(binPath, ['attach', id], { env, stdio: ['pipe', 'ignore', 'ignore'] });
        assert.ok(await espera(() => listaLocal().some(r => r.id === id && r.attached), 3000), 'el otro dispositivo no engancho');
        assert.ok(await espera(() => cierres(s).length > 0, 8000), `no paro: ${pushes(s)}`);
        assert.strictEqual(cierres(s)[0].reason, 'elsewhere');
        assert.ok(texto(s).includes('This session is open on another device'));
        assert.ok(recibido.some(([c, p]) => c === 'ssh:reconnect' && p.sessionId === s && p.state === 'failed' && p.elsewhere === true), 'sin push failed/elsewhere');
        assert.strictEqual(otro.exitCode, null, 'la reconexion echo al otro dispositivo');
        /* c) restaurar tampoco la toma */
        await assert.rejects(conecta({ sessionKey: k, restored: true }), /open on another device/);
        assert.strictEqual(otro.exitCode, null, 'restaurar echo al otro dispositivo');
        /* d) takeover manual (Attach here): newest wins */
        const s3 = await conecta({ sessionKey: k, restored: true, takeover: true });
        assert.strictEqual(await pidDe(s3, 'PIDT'), pid, 'takeover no engancho la misma');
        assert.ok(await espera(() => otro.exitCode !== null, 4000), 'el otro no fue reemplazado');
        assert.strictEqual(otro.exitCode, 75);
        await sshService.keeperEnd(s3);
      } finally {
        sshService.reconnectDelays = delays0;
        if (otro && otro.exitCode === null) otro.kill('SIGKILL');
      }
    });

    await check('KP20 solo el shell delante pero `sleep &` debajo → jobs y closePlan pregunta; sin trabajos, silencioso', async () => {
      const s = await conecta({ sessionKey: clave(20) });
      await pidDe(s, 'PID');
      const fg0 = await sshService.keeperForeground(s);
      assert.ok(fg0.isShell && Array.isArray(fg0.jobs) && fg0.jobs.length === 0, `sin trabajos: ${JSON.stringify(fg0)}`);
      sshService.sendData(s, 'sleep 700 &\r');
      let fg = null;
      for (let i = 0; i < 20 && !(fg && fg.jobs && fg.jobs.includes('sleep')); i++) { await sleep(100); fg = await sshService.keeperForeground(s); }
      assert.ok(fg.isShell && fg.jobs.includes('sleep'), JSON.stringify(fg));
      await sshService.keeperEnd(s);
      /* closePlan (renderer) con esbuild y el dialogo stubeado */
      const esbuild = require('esbuild');
      const out = await esbuild.build({
        entryPoints: [path.join(ROOT, 'src', 'components', 'Keeper', 'closePlan.js')],
        bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
        plugins: [{ name: 'stub-dialog', setup(b) {
          b.onResolve({ filter: /KeeperCloseDialog/ }, () => ({ path: 'dialog', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const askKeeperClose = (r) => globalThis.__kpAsk(r);', loader: 'js' }));
        } }],
      });
      const m = new Module('closePlan-arnes');
      m._compile(out.outputFiles[0].text, 'closePlan-arnes.js');
      const infos = { a: { keeper: true, fgCommand: 'bash', isShell: true, jobs: [] }, b: { keeper: true, fgCommand: 'bash', isShell: true, jobs: ['sleep'] }, c: { keeper: true, fgCommand: 'bash', isShell: true, jobs: null } };
      const prevWindow = global.window;
      const preguntas = [];
      global.window = { electronAPI: { ssh: { keeperForeground: async (sid) => infos[sid] } } };
      global.__kpAsk = async (r) => { preguntas.push(r); return 'keep'; };
      try {
        const tabs = ['a', 'b', 'c'].map(x => ({ id: `t${x}`, type: 'terminal', sessionId: x, label: x }));
        const plan = await m.exports.planKeeperClose(tabs);
        assert.deepStrictEqual([...plan.end].sort(), ['ta', 'tc'], `end: ${[...plan.end]}`);
        assert.strictEqual(preguntas.length, 1);
        assert.deepStrictEqual(preguntas[0].map(r => [r.tab.id, r.fgCommand, r.background]), [['tb', 'sleep', true]]);
      } finally { global.window = prevWindow; delete global.__kpAsk; }
    });
  } finally {
    for (const s of abiertas) { try { await sshService.disconnect(s); } catch (_) { /* ya */ } }
    /* Ningun demonio de la prueba sobrevive */
    for (const r of listaLocal()) {
      try { execFileSync(binPath, ['kill', r.id], { env: { ...process.env, HOME: home }, timeout: 5000 }); } catch (_) { /* ya */ }
    }
    for (const r of listaLocal()) { try { process.kill(r.pid, 'SIGKILL'); } catch (_) { /* ya */ } }
    sshService.reconnectDelays = delays;
    sshService.setMainWindow(prevWin);
    hostKeyService.setMainWindow(prevHkWin);
    keeper.stateFile = prevState.stateFile;
    keeper._state = prevState.state;
    keeper.clearCache();
    if (agente !== undefined) process.env.SSH_AUTH_SOCK = agente;
    await Promise.all([sshd.stop(), sshdNoSftp.stop()]);
    try { fs.chmodSync(path.join(home, '.termilab'), 0o700); } catch (_) { /* ya */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { seccionKeeper };
