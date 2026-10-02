/**
 * Seccion LK del arnes del main (scripts/check-main.js): session keeper para
 * terminales LOCALES (Linux), electron/services/local-keeper.js.
 *
 *  LK1  puras: arch, id = el mismo que en remoto, keeper:<id> = adoptada,
 *       argv del attach y del systemd-run que crea la sesion en su unidad.
 *  LK2  renderer: closePlan pregunta/termina tambien pestanas locales
 *       guardadas; endSessions usa keeperEnd solo con End; confirmClose no
 *       pregunta por una local guardada; TerminalView pasa el sessionKey.
 *  LK3  restorePlan conserva el sessionKey de las pestanas locales.
 *  LK4  de verdad (systemd --user + Electron-como-node, HOME temporal): el
 *       driver corre DENTRO de una unidad transitoria con NoNewPrivileges=yes
 *       (como un Termilab relanzado por el actualizador, y como un lanzador
 *       que lo pone en app.slice/run-*.service): instala, crea, NNP=0 dentro,
 *       sin unidad por pestana, plan de cierre, continuidad de `seq` tras
 *       soltar, mismo pid al reenganchar, attach matado → se reengancha solo,
 *       End, adoptada inexistente, modo directo, fallback sin binario,
 *       ajuste apagado. Luego se PARA esa unidad entera (mata todo el arbol
 *       del "Termilab") y el demonio sigue vivo; un segundo driver reengancha
 *       la misma clave, ve la pantalla repetida y el mismo pid, y la termina.
 *       Al final no queda ni un demonio ni una unidad de esta prueba.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawn, execFile, execFileSync } = require('child_process');

async function seccionLocalKeeper({ check, ROOT }) {
  const lk = require(path.join(ROOT, 'electron', 'services', 'local-keeper.js'));
  const keeper = require(path.join(ROOT, 'electron', 'services', 'keeper-service.js'));

  await check('LK1 local-keeper puro: arch, id como en remoto, adoptada, argv de attach y de la unidad', () => {
    assert.strictEqual(lk.archFor('x64'), 'x86_64');
    assert.strictEqual(lk.archFor('arm64'), 'aarch64');
    assert.strictEqual(lk.archFor('ia32'), null);
    const s = lk.sessionFor('tab-123');
    assert.deepStrictEqual(s, { id: keeper.keeperIdFor('tab-123'), adopted: false });
    assert.deepStrictEqual(lk.sessionFor('keeper:abcdefgh12'), { id: 'abcdefgh12', adopted: true });
    assert.strictEqual(lk.sessionFor(''), null);
    assert.deepStrictEqual(lk.attachArgs('abcdefgh12', 132, 40, false), ['attach', 'abcdefgh12', '--cols', '132', '--rows', '40']);
    assert.deepStrictEqual(lk.attachArgs('abcdefgh12', 0, 99999, true), ['attach', 'abcdefgh12', '--cols', '80', '--rows', '9999', '--create']);
    assert.throws(() => lk.attachArgs('MAL;rm', 80, 24, false));
    const a = lk.buildCreateArgs({ bin: '/h/.termilab/bin/k', id: 'abcdefgh12', cols: 80, rows: 24, setenv: { HOME: '/h', SHELL: '/bin/bash' } });
    assert.deepStrictEqual(a.slice(0, 7), ['--user', '--quiet', '--collect', '--same-dir', '--unit=termilab-keep-abcdefgh12', '-p', 'Type=forking']);
    assert.ok(!a.includes('--pty') && !a.includes('--wait') && !a.includes('--scope'), 'la unidad de la sesion no es la de la pestana');
    assert.ok(a.includes('--setenv=HOME=/h') && a.includes('--setenv=SHELL=/bin/bash'));
    const dd = a.indexOf('--');
    assert.deepStrictEqual(a.slice(dd + 1, dd + 3), ['/bin/sh', '-c']);
    assert.ok(/attach "\$1" --create .*<\/dev\/null.*\[ \$\? -eq 77 \]/.test(a[dd + 3]), a[dd + 3]);
    assert.deepStrictEqual(a.slice(dd + 4), ['/h/.termilab/bin/k', 'abcdefgh12', '80', '24']);
  });

  await check('LK2 renderer: closePlan y endSessions con pestanas locales guardadas; TerminalView pasa el sessionKey', async () => {
    const esbuild = require('esbuild');
    const bundle = async (entry, name) => {
      const out = await esbuild.build({
        entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
        plugins: [{ name: 'stub-dialog', setup(b) {
          b.onResolve({ filter: /KeeperCloseDialog/ }, () => ({ path: 'dialog', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const askKeeperClose = (r) => globalThis.__lkAsk(r);', loader: 'js' }));
        } }],
      });
      const m = new Module(name);
      m._compile(out.outputFiles[0].text, `${name}.js`);
      return m.exports;
    };
    const plan = await bundle(path.join(ROOT, 'src', 'components', 'Keeper', 'closePlan.js'), 'lk-closePlan');
    const sess = await bundle(path.join(ROOT, 'src', 'components', 'SplitPane', 'sessions.js'), 'lk-sessions');
    const infos = { pa: { keeper: true, fgCommand: 'bash', isShell: true, jobs: [] }, pb: { keeper: true, fgCommand: 'claude', isShell: false } };
    const calls = [];
    const prevWindow = global.window;
    const asked = [];
    global.window = {
      confirm: () => { calls.push('confirm'); return true; },
      electronAPI: {
        ssh: { keeperForeground: async () => { throw new Error('ssh no debe preguntarse por una local'); } },
        localShell: {
          keeperForeground: async (sid) => { calls.push(`fg:${sid}`); return infos[sid]; },
          keeperEnd: async (sid) => { calls.push(`end:${sid}`); },
          kill: async (sid) => { calls.push(`kill:${sid}`); },
        },
      },
    };
    global.__lkAsk = async (r) => { asked.push(r); return 'keep'; };
    try {
      const tabs = [
        { id: 'ta', type: 'local-terminal', sessionId: 'local-ta', ptySessionId: 'pa', kept: true, label: 'a' },
        { id: 'tb', type: 'local-terminal', sessionId: 'local-tb', ptySessionId: 'pb', kept: true, label: 'b' },
        { id: 'tc', type: 'local-terminal', sessionId: 'local-tc', ptySessionId: 'pc', label: 'c' },
      ];
      const p = await plan.planKeeperClose(tabs);
      assert.deepStrictEqual([...p.end], ['ta'], 'solo el shell delante → terminar sin preguntar');
      assert.deepStrictEqual(asked.map(r => r.map(x => [x.tab.id, x.fgCommand])), [[['tb', 'claude']]], 'claude delante → preguntar');
      assert.ok(!calls.includes('fg:pc'), 'una local sin keeper no se pregunta');
      calls.length = 0;
      await sess.endSessions(tabs, async () => {}, p);
      assert.deepStrictEqual(calls.sort(), ['end:pa', 'kill:pb', 'kill:pc'], `endSessions: ${calls}`);
      calls.length = 0;
      assert.strictEqual(sess.confirmCloseSessions([tabs[0]], 'a'), true);
      assert.deepStrictEqual(calls, [], 'una local guardada no pasa por window.confirm');
      sess.confirmCloseSessions([tabs[2]], 'c');
      assert.deepStrictEqual(calls, ['confirm'], 'una local normal sigue preguntando');
    } finally { global.window = prevWindow; delete global.__lkAsk; }
    const tv = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Terminal', 'TerminalView.jsx'), 'utf-8');
    assert.ok(/localShell\.spawn\(\{ cols, rows, sessionKey: tab\.sessionKey \|\| tab\.id \}\)/.test(tv), 'TerminalView no pasa el sessionKey al spawn local');
    assert.ok(/if \(fresh && !info\.kept\) term\.clear\(\)/.test(tv), 'TerminalView borra encima de la repeticion del keeper');
  });

  await check('LK3 restorePlan: una pestana local vuelve con su sessionKey (la que reengancha)', () => {
    const esbuild = require('esbuild');
    const out = esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src', 'components', 'SplitPane', 'workspace.js')], bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent' });
    const m = new Module('lk-workspace');
    m._compile(out.outputFiles[0].text, 'lk-workspace.js');
    const snap = m.exports.snapshotWindow({ tabs: [{ id: 'L1', type: 'local-terminal', label: 'Local', sessionId: 'local-L1', ptySessionId: 'p', kept: true }], layouts: {}, activeTabId: 'L1', focusedPane: {}, hosts: [] });
    assert.strictEqual(snap.tabs[0].sessionKey, 'L1');
    const plan = m.exports.restorePlan({ tabs: [{ id: 'L1', kind: 'local', sessionKey: 'clave-estable' }, { id: 'L2', kind: 'local', sessionKey: 'keeper:abcdefgh12' }] }, []);
    assert.deepStrictEqual(plan.tabs.map(t => [t.type, t.sessionKey]), [['local-terminal', 'clave-estable'], ['local-terminal', 'keeper:abcdefgh12']]);
    assert.deepStrictEqual(plan.connect, [], 'las locales no van a la cola de reconexion SSH');
  });

  // ── LK4: de verdad ──
  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
  let motivo = null;
  if (process.platform !== 'linux') motivo = 'no es Linux';
  else if (!fs.existsSync(electronBin)) motivo = 'sin node_modules/electron';
  else if (!lk.archFor(process.arch)) motivo = `arquitectura ${process.arch}`;
  else {
    try { execFileSync('sh', ['-c', 'command -v systemd-run']); } catch (_) { motivo = 'sin systemd-run'; }
    if (!motivo) {
      let estado = '';
      try { estado = execFileSync('systemctl', ['--user', 'is-system-running']).toString().trim(); } catch (e) { estado = String(e.stdout || '').trim(); }
      if (!['running', 'degraded'].includes(estado)) motivo = `systemd --user no responde (${estado || 'nada'})`;
    }
  }
  if (motivo) {
    await check(`LK4 keeper local de verdad -- OMITIDA: ${motivo}`, () => {});
    return;
  }

  /* HOME corto: el socket (~/.termilab/run/<id>.sock) tiene que caber en sun_path */
  const home = fs.mkdtempSync('/tmp/tlk-');
  const bin = path.join(home, '.termilab', 'bin', keeper.localBinaries().binaries[lk.archFor(process.arch)].file);
  const env = { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: '1' };
  const appUnit = `termilab-checkapp-${process.pid}`;
  const lista = () => {
    try { return keeper.parseList(execFileSync(bin, ['list'], { env: { ...process.env, HOME: home } }).toString()); } catch (_) { return []; }
  };
  const unidades = (p) => {
    try {
      return execFileSync('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', p]).toString()
        .split('\n').map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
    } catch (_) { return []; }
  };
  const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
  const nuestras = new Set();
  let r1 = null; let r2 = null; let tras = null;
  try {
    /* Fase 1: el driver es "Termilab", dentro de una unidad con NNP=1 */
    const pass = ['PATH', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'LANG', 'USER', 'LOGNAME'].filter(k => process.env[k]);
    const args = ['--user', '--quiet', '--pipe', '--wait', '--collect', `--unit=${appUnit}`, '-p', 'NoNewPrivileges=yes',
      `--setenv=HOME=${home}`, '--setenv=ELECTRON_RUN_AS_NODE=1', '--setenv=SHELL=/bin/bash',
      ...pass.map(k => `--setenv=${k}=${process.env[k]}`),
      '--', electronBin, path.join(__dirname, 'local-keeper-driver.js'), ROOT, 'main'];
    r1 = await new Promise((resolve) => {
      const child = spawn('systemd-run', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = ''; let err = '';
      const timer = setTimeout(() => resolve({ error: `fase 1 sin respuesta en 150 s: ${err.slice(-400)}` }), 150000);
      child.stdout.on('data', (d) => {
        buf += d;
        const line = buf.split('\n').find(l => l.startsWith('{'));
        if (line) { clearTimeout(timer); try { resolve(JSON.parse(line)); } catch (e) { resolve({ error: e.message }); } }
      });
      child.stderr.on('data', (d) => { err += d; });
      child.on('exit', () => setTimeout(() => resolve({ error: `fase 1 salio sin JSON: ${err.slice(-400)}` }), 200));
    });
    for (const r of lista()) nuestras.add(r.id);
    /* Matar el arbol entero del "Termilab": parar su unidad (KillMode=control-group) */
    const antes = r1 && r1.survivor ? { attach: vivo(r1.survivor.attachPid), daemon: vivo(r1.survivor.daemonPid) } : null;
    try { execFileSync('systemctl', ['--user', 'stop', `${appUnit}.service`], { timeout: 15000 }); } catch (_) { /* ya */ }
    await new Promise(r => setTimeout(r, 1000));
    if (r1 && r1.survivor) {
      tras = {
        antes,
        appUnit: unidades(`${appUnit}*`),
        attach: vivo(r1.survivor.attachPid),
        daemon: vivo(r1.survivor.daemonPid),
        shell: vivo(r1.survivor.shellPid),
        listed: lista().some(x => x.id === r1.survivor.id),
      };
      /* Fase 2: Termilab abierto otra vez, la misma pestana restaurada */
      r2 = await new Promise((resolve) => {
        execFile(electronBin, [path.join(__dirname, 'local-keeper-driver.js'), ROOT, 'reattach', r1.survivor.key, r1.survivor.marker],
          { env, timeout: 60000 }, (err, stdout, stderr) => {
            const line = String(stdout).trim().split('\n').filter(l => l.startsWith('{')).pop();
            resolve(line ? JSON.parse(line) : { error: `fase 2 sin JSON: ${err && err.message} ${String(stderr).slice(-400)}` });
          });
      });
    }
  } finally {
    try { execFileSync('systemctl', ['--user', 'stop', `${appUnit}.service`], { stdio: 'ignore', timeout: 15000 }); } catch (_) { /* ya */ }
    for (const r of lista()) {
      nuestras.add(r.id);
      try { execFileSync(bin, ['kill', r.id], { env: { ...process.env, HOME: home }, timeout: 6000 }); } catch (_) { /* ya */ }
    }
    await new Promise(r => setTimeout(r, 800));
    for (const id of nuestras) {
      try { execFileSync('systemctl', ['--user', 'stop', `${lk.keepUnitName(id)}.service`], { stdio: 'ignore', timeout: 10000 }); } catch (_) { /* ya */ }
    }
  }
  const restos = [...nuestras].flatMap(id => unidades(`${lk.keepUnitName(id)}*`)).concat(unidades(`${appUnit}*`));
  const demonios = lista();
  fs.rmSync(home, { recursive: true, force: true });

  await check('LK4a instalacion local: ~/.termilab{,/bin,/run} 0700 sin symlinks, binario 0700 con el sha del manifest, sin .tmp', () => {
    assert.ok(r1 && !r1.error, r1 && r1.error);
    const s = r1.steps;
    assert.ok(!s.prepare.fallback && s.prepare.systemdRun, JSON.stringify(s.prepare));
    for (const k of ['dir', 'bin', 'run']) assert.deepStrictEqual(s.files[k], { mode: '700', link: false, file: false }, k);
    assert.deepStrictEqual(s.files.exe, { mode: '700', link: false, file: true });
    assert.strictEqual(s.files.sha, s.files.manifestSha);
    assert.deepStrictEqual(s.files.tmpLeft, []);
  });

  await check('LK4b con Termilab en NNP=1: el shell guardado tiene NNP=0, vive en termilab-keep-<id>, no hay unidad por pestana', () => {
    assert.ok(r1 && !r1.error, r1 && r1.error);
    const s = r1.steps;
    assert.strictEqual(r1.nnpSelf, '1', 'el driver no corrio con NoNewPrivs=1: la prueba no prueba nada');
    assert.ok(s.infoA.kept && !s.infoA.notice, JSON.stringify(s.infoA));
    assert.strictEqual(s.idMatchesRemote, true);
    assert.strictEqual(s.nnpInside, '0', `NoNewPrivs dentro del shell guardado = ${s.nnpInside}`);
    assert.ok(/\/termilab-keep-[a-z0-9]+\.service$/.test(s.cgroupInside || ''), `cgroup del shell: ${s.cgroupInside}`);
    assert.strictEqual(s.keepUnit.length, 1, `unidad de la sesion: ${s.keepUnit}`);
    assert.deepStrictEqual(s.perTabUnit, [], 'una pestana guardada abrio una unidad termilab-shell-*');
    assert.ok(s.cwdOk, 'el shell no arranco en el cwd pedido');
    assert.ok(/^[a-z0-9]{26}$/.test(s.kid || ''), `TERMILAB_KEEPER_ID=${s.kid}`);
  });

  await check('LK4c plan de cierre local: shell solo / `sleep &` / comando delante', () => {
    const s = r1.steps;
    assert.deepStrictEqual(s.fgShell, { keeper: true, fgCommand: 'bash', isShell: true, jobs: [] });
    assert.ok(s.fgJobs && s.fgJobs.isShell && s.fgJobs.jobs.includes('sleep'), JSON.stringify(s.fgJobs));
    assert.ok(s.fgCmd && s.fgCmd.fgCommand === 'sleep' && !s.fgCmd.isShell, JSON.stringify(s.fgCmd));
  });

  await check('LK4d cerrar la pestana suelta (no mata): `seq` sigue sin nadie y la repeticion trae L1..L60 en orden; mismo pid', () => {
    const s = r1.steps;
    assert.ok(s.closedA, 'kill no emitio local:close');
    assert.deepStrictEqual(s.afterDetach.map(x => x.attached), [false], `tras cerrar: ${JSON.stringify(s.afterDetach)}`);
    assert.ok(s.infoB.kept);
    assert.deepStrictEqual(s.seq, { count: 60, inOrder: true, done: true }, JSON.stringify(s.seq));
    assert.strictEqual(s.pidSame, true, 'reenganchar abrio otro shell');
  });

  await check('LK4e attach matado con SIGKILL → la pestana se reengancha sola al mismo shell; parar unidades de pestana no toca la sesion', () => {
    const s = r1.steps;
    assert.ok(s.reattachedPty && s.pidAfterKill && s.daemonAlive, JSON.stringify({ r: s.reattachedPty, p: s.pidAfterKill, d: s.daemonAlive }));
    assert.ok(s.aliveAfterUnitStop);
  });

  await check('LK4f End mata la sesion y su unidad; keeper:<id> inexistente → 102 sin crear; modo directo; fallback sin binario; ajuste apagado', () => {
    const s = r1.steps;
    assert.ok(s.endGone && s.closedB, 'End no termino la sesion');
    assert.deepStrictEqual(s.endUnit, [], 'la unidad sobrevivio a End');
    assert.deepStrictEqual(s.ghost, { code: 102, created: false, said: true }, JSON.stringify(s.ghost));
    assert.ok(s.direct.kept && s.direct.same, `modo directo: ${JSON.stringify(s.direct)}`);
    assert.deepStrictEqual(s.direct.unit, [], 'modo directo no debe crear unidad');
    assert.strictEqual(s.fallbackInfo.kept, false);
    assert.ok(/Session keeping unavailable for local terminals \(no keeper binary/.test(s.fallbackInfo.notice || ''), s.fallbackInfo.notice);
    assert.ok(s.fallbackShell, 'el shell normal del fallback no respondio');
    assert.deepStrictEqual(s.offInfo, { kept: false, notice: null });
  });

  await check('LK4g matar TODO el arbol de Termilab (parar su unidad): el demonio sigue; al volver reengancha la clave, repite la pantalla, mismo pid; End limpia', () => {
    assert.ok(tras, 'no hubo superviviente');
    assert.deepStrictEqual(tras.antes, { attach: true, daemon: true }, `antes de parar: ${JSON.stringify(tras.antes)}`);
    assert.deepStrictEqual(tras.appUnit, [], 'la unidad del "Termilab" no paro');
    assert.strictEqual(tras.attach, false, 'el attach (arbol de Termilab) siguio vivo: la prueba no mato nada');
    assert.ok(tras.daemon && tras.shell && tras.listed, `tras matar Termilab: ${JSON.stringify(tras)}`);
    assert.ok(r2 && !r2.error, r2 && r2.error);
    assert.ok(r2.steps.info.kept, JSON.stringify(r2.steps.info));
    assert.strictEqual(r2.steps.replayed, true, 'la repeticion no trajo la pantalla de antes');
    assert.strictEqual(r2.steps.shellPid, r1.survivor.shellPid, 'reenganchar tras reiniciar abrio otro shell');
    assert.ok(r2.steps.gone, 'End no termino la sesion');
    assert.deepStrictEqual(r2.steps.unit, []);
  });

  await check('LK4h limpieza: ningun demonio ni unidad termilab-keep-*/checkapp de esta prueba', () => {
    assert.deepStrictEqual(demonios, [], `demonios vivos: ${JSON.stringify(demonios)}`);
    assert.deepStrictEqual(restos, [], `unidades: ${restos}`);
  });
}

module.exports = { seccionLocalKeeper };
