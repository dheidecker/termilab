/**
 * Secciones R y A del arnes del main (scripts/check-main.js).
 *
 * R. Restaurar el espacio de trabajo al arrancar (workspace-service.js +
 *    src/components/SplitPane/workspace.js empaquetado con esbuild):
 *  R1  ida y vuelta por disco; archivo corrupto = arrancar limpio sin lanzar;
 *      escribir el workspace NO avisa a sync (onLocalChange).
 *  R2  lo que reporta un renderer se limpia: ni contrasenas ni campos raros
 *      llegan a disco; arboles invalidos fuera.
 *  R3  guarda contra el bucle: un arranque que encuentra 'restoring' arranca
 *      limpio UNA vez; 'ok' solo cuando TODAS las ventanas restauradas
 *      avisan; salir ordenadamente a mitad tampoco cuenta como caida.
 *  R4  bounds sobre las pantallas que hay ahora (fuera de toda pantalla →
 *      centrada en la principal; mas grande que la pantalla → encoge).
 *  R5  plan de restauracion: host borrado → pestana fuera y su split se cura;
 *      quick connect → nota sin reconectar (sin secretos); local → shell
 *      nuevo; orden de reconexion = pestana activa primero, luego la barra;
 *      snapshot → disco → plan conserva alias, color, mute y layout.
 *  R6  reconexiones escalonadas: 150 ms entre una y otra, en orden, y una que
 *      lanza no para las demas.
 *  R7  ventanas: cerrar una de dos la quita; el cierre que sale de la app la
 *      conserva; take() una sola vez; tras congelar no entra nada.
 *
 * A. Reconexion automatica (ssh-service.js) contra el sshd de juguete:
 *  A1  compresion: una terminal negocia zlib@openssh.com; SFTP-only, none.
 *  A2  corte del socket desde el servidor: mismo sessionId, misma ventana,
 *      "Reconnecting… (attempt 1)", 'reconnected', y el shell nuevo responde.
 *  A3  calendario de espera (1,2,4,8,16,30… ~2 min) y, con el servidor caido,
 *      los intentos respetan las esperas, luego 'failed' + ssh:close.
 *  A4  el servidor vuelve a mitad del calendario: reconecta en un intento > 1.
 *  A5  sin reconexion: el usuario cierra, el shell hace `exit` (tambien si el
 *      socket se va justo detras), o se cierra durante la espera.
 *  A6  un error permanente (autenticacion) corta el calendario en el acto.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startSshTestServer } = require('./ssh-test-server');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const espera = async (fn, ms = 5000) => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (fn()) return true; await sleep(10); }
  return false;
};

function ventana(nombre) {
  const recibido = [];
  const oyentes = new Map();
  let vivo = true;
  let bounds = { x: 100, y: 80, width: 1000, height: 700 };
  const wc = { nombre, send: (c, ...a) => recibido.push([c, Date.now(), ...a]), isDestroyed: () => !vivo };
  const win = {
    webContents: wc,
    isDestroyed: () => !vivo,
    isFocused: () => false,
    isMaximized: () => false,
    getBounds: () => ({ ...bounds }),
    getNormalBounds: () => ({ ...bounds }),
    on: (ev, fn) => { if (!oyentes.has(ev)) oyentes.set(ev, []); oyentes.get(ev).push(fn); return win; },
    once: (ev, fn) => win.on(ev, fn),
    emitir: (ev) => { for (const fn of oyentes.get(ev) || []) fn(); },
    mover: (b) => { bounds = { ...bounds, ...b }; win.emitir('move'); },
    cerrar: () => { win.emitir('close'); vivo = false; win.emitir('closed'); },
  };
  return { win, wc, recibido, de: (c) => recibido.filter(([x]) => x === c) };
}

function cargaWorkspaceRenderer(ROOT) {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'components', 'SplitPane', 'workspace.js')],
    bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  });
  const Module = require('module');
  const m = new Module('workspace-arnes');
  m._compile(out.outputFiles[0].text, 'workspace-arnes.js');
  return m.exports;
}

async function seccionWorkspace({ check, ROOT }) {
  const E = (...p) => require(path.join(ROOT, 'electron', ...p));
  const ws = E('services', 'workspace-service.js');
  const { WorkspaceService, sanitizeWindow, clampBounds, planLaunch } = ws;
  const store = E('services', 'store-service.js');
  const R = cargaWorkspaceRenderer(ROOT);
  const file = () => path.join(store.dataDir, 'workspace.json');
  /* The singleton tracked the W section's fake windows: no late write of its
     may land between a save and a read here */
  clearTimeout(ws._timer);
  ws._timer = null;
  ws.freeze();
  const leer = () => JSON.parse(fs.readFileSync(file(), 'utf-8'));
  const nuevo = () => { const s = new WorkspaceService(); s.writeDelayMs = 20; s.screenInfo = () => ({ displays: [], primaryId: null }); return s; };

  const SECRETO = 'contrasena-que-no-va-al-workspace';
  const hosts = [
    { id: 'h1', label: 'Bastion', hostname: 'bastion', username: 'derek', password: SECRETO },
    { id: 'h2', label: 'DB', hostname: 'db', username: 'root' },
  ];
  /* Ventana: pestana A = split [h1 | local], pestana B = h2, pestana C = quick connect */
  const estado = {
    hosts,
    tabs: [
      { id: 'a', type: 'terminal', label: 'Bastion', hostId: 'h1', sessionId: 's1', alias: 'logs', color: '#ff0000', hostConfig: hosts[0] },
      { id: 'b', type: 'terminal', label: 'DB', hostId: 'h2', sessionId: 's2', muted: true },
      { id: 'q', type: 'terminal', label: 'ops@1.2.3.4', hostId: 'tirado', sessionId: 's3', hostConfig: { hostname: '1.2.3.4', username: 'ops', port: 2222, password: SECRETO } },
      { id: 'l', type: 'local-terminal', label: 'Terminal', sessionId: 'local-l', ptySessionId: 'pty9', hidden: true },
      { id: 'f', type: 'sftp', label: 'SFTP', panes: {} },
    ],
    layouts: { a: { type: 'split', direction: 'horizontal', ratio: 0.4, children: [{ type: 'terminal', tabId: 'a' }, { type: 'terminal', tabId: 'l' }] } },
    activeTabId: 'b',
    focusedPane: { a: 'l' },
  };

  await check('R1 workspace: ida y vuelta por disco, corrupto = limpio sin lanzar, y no despierta a sync', async () => {
    let avisos = 0;
    /* Only workspace writes count: the W section's sessions still stamp their logs */
    const off = store.onLocalChange((c) => { if (c === 'workspace') avisos++; });
    try {
      const datos = { v: 1, launch: { state: 'ok', at: 1 }, windows: [{ bounds: { x: 1, y: 2, width: 900, height: 600 }, tabs: [] }] };
      await store.saveWorkspace(datos);
      assert.deepStrictEqual(await store.getWorkspace(), datos, 'no vuelve lo mismo');
      assert.strictEqual(avisos, 0, 'guardar el workspace aviso a onLocalChange (dispararia un sync)');
      fs.writeFileSync(file(), '{"v":1, "windows": [ roto');
      assert.strictEqual(await store.getWorkspace(), null, 'un archivo corrupto no da null');
      const s = nuevo();
      const plan = await s.begin();
      assert.deepStrictEqual([plan.windows.length, plan.reason], [0, 'none'], `corrupto: ${JSON.stringify(plan)}`);
      fs.writeFileSync(file(), '[1,2,3]');
      assert.strictEqual(await store.getWorkspace(), null, 'un array no es un workspace');
      fs.unlinkSync(file());
      assert.strictEqual(await store.getWorkspace(), null, 'sin archivo no da null');
      assert.strictEqual(planLaunch(null).windows.length, 0);
    } finally { off(); }
  });

  await check('R2 lo que reporta el renderer se limpia: sin contrasenas ni campos ajenos; arboles invalidos fuera', async () => {
    const snap = R.snapshotWindow(estado);
    assert.ok(!JSON.stringify(snap).includes(SECRETO), 'el snapshot del renderer lleva una contrasena');
    assert.deepStrictEqual(snap.tabs.map(t => [t.id, t.kind]), [['a', 'host'], ['b', 'host'], ['q', 'quick'], ['l', 'local']], 'tipos o SFTP mal');
    const s = nuevo();
    const V = ventana('R2');
    s.attach(V.win);
    const sucio = {
      ...snap,
      tabs: [...snap.tabs.map(t => ({ ...t, password: SECRETO, hostConfig: { password: SECRETO } })),
        { id: 'x', kind: 'raro' }, { id: 'a', kind: 'local' }, { id: 'y', kind: 'host' }],
      layouts: { ...snap.layouts, b: { type: 'split', children: [{ type: 'terminal', tabId: 'b' }, { type: 'terminal', tabId: 'no-existe' }] } },
    };
    assert.ok(s.report(V.wc, sucio));
    await s.flush();
    const disco = fs.readFileSync(file(), 'utf-8');
    assert.ok(!disco.includes(SECRETO), 'una contrasena llego a workspace.json');
    const w = JSON.parse(disco).windows[0];
    assert.deepStrictEqual(w.tabs.map(t => t.id), ['a', 'b', 'q', 'l'], 'pestanas basura o duplicadas pasaron');
    assert.deepStrictEqual(Object.keys(w.layouts), ['a'], 'un arbol con una hoja inexistente paso');
    assert.deepStrictEqual(w.bounds, { x: 100, y: 80, width: 1000, height: 700 }, 'sin bounds de la ventana');
    assert.deepStrictEqual(sanitizeWindow({ tabs: 'no' }).tabs, []);
  });

  await check('R3 guarda contra el bucle: tras un arranque que no termino de restaurar se arranca limpio una vez', async () => {
    const guardado = { v: 1, launch: { state: 'ok', at: 1 }, windows: [
      { bounds: { x: 0, y: 0, width: 900, height: 600 }, ...R.snapshotWindow(estado) },
      { bounds: { x: 50, y: 50, width: 900, height: 600 }, tabs: [{ id: 'z', kind: 'local', label: 'T' }], layouts: {} },
    ] };
    await store.saveWorkspace(guardado);
    /* Arranque 1: restaura y lo dice en disco ANTES de abrir nada */
    let s = nuevo();
    let plan = await s.begin();
    assert.strictEqual(plan.windows.length, 2, `no restaura: ${plan.reason}`);
    assert.strictEqual(leer().launch.state, 'restoring', 'el estado restoring no esta en disco al empezar');
    const A = ventana('R3a'); const B = ventana('R3b');
    s.assign(A.win, plan.windows[0]);
    s.assign(B.win, plan.windows[1]);
    s.restored(A.wc);
    await s.flush();
    assert.strictEqual(leer().launch.state, 'restoring', 'ok con una ventana aun sin restaurar');
    /* ... y se cae aqui. Arranque 2: limpio, y lo deja limpio en disco */
    s = nuevo();
    plan = await s.begin();
    assert.deepStrictEqual([plan.windows.length, plan.crashed], [0, true], `tras la caida restauro otra vez: ${plan.reason}`);
    assert.deepStrictEqual([leer().launch.state, leer().windows.length], ['ok', 0], 'tras la caida el disco no quedo limpio');
    /* Arranque 3 normal: las dos ventanas avisan → ok */
    await store.saveWorkspace(guardado);
    s = nuevo();
    plan = await s.begin();
    const C = ventana('R3c'); const D = ventana('R3d');
    s.assign(C.win, plan.windows[0]); s.assign(D.win, plan.windows[1]);
    s.restored(C.wc); s.restored(D.wc);
    await sleep(60);
    await s._writing;
    assert.strictEqual(leer().launch.state, 'ok', 'las dos avisaron y sigue restoring');
    /* Salir ordenadamente a mitad de una restauracion no es una caida */
    await store.saveWorkspace(guardado);
    s = nuevo();
    plan = await s.begin();
    s.assign(ventana('R3e').win, plan.windows[0]);
    await s.quitFlush();
    assert.strictEqual(leer().launch.state, 'ok', 'salir a mitad dejo restoring (el siguiente arranque saldria limpio)');
    /* Ajuste apagado: no restaura */
    await store.saveWorkspace(guardado);
    const antes = await store.getSettings();
    await store.saveSettings({ general: { restoreTabs: false } });
    try {
      s = nuevo();
      plan = await s.begin();
      assert.deepStrictEqual([plan.windows.length, plan.reason], [0, 'disabled']);
    } finally { await store.saveSettings({ general: { restoreTabs: antes.general.restoreTabs !== false } }); }
  });

  await check('R4 bounds sobre las pantallas de ahora: fuera de todas → centrada en la principal; grande → encoge', () => {
    const displays = [
      { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
      { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 1000 } },
    ];
    const op = { primaryId: 1 };
    assert.deepStrictEqual(clampBounds({ x: 100, y: 100, width: 1200, height: 800 }, displays, op), { x: 100, y: 100, width: 1200, height: 800 }, 'una ventana visible se movio');
    /* La pantalla 3 ya no esta */
    assert.deepStrictEqual(clampBounds({ x: 5000, y: 3000, width: 1200, height: 800 }, displays, { ...op, displayId: 3 }),
      { x: 360, y: 120, width: 1200, height: 800 }, 'fuera de toda pantalla no se centra en la principal');
    assert.deepStrictEqual(clampBounds({ x: 1900, y: 10, width: 2000, height: 1400 }, displays, { ...op, displayId: 2 }),
      { x: 1920, y: 0, width: 1280, height: 1000 }, 'mas grande que su pantalla no encoge/entra');
    assert.deepStrictEqual(clampBounds({ x: 1800, y: 900, width: 800, height: 600 }, displays, op),
      { x: 1920, y: 400, width: 800, height: 600 }, 'medio fuera no entra entera en la pantalla con mas solape');
    const plan = planLaunch({ windows: [{ bounds: { x: -4000, y: 0, width: 800, height: 600 }, tabs: [] }] }, { displays, primaryId: 1 });
    assert.deepStrictEqual(plan.windows[0].bounds, { x: 560, y: 220, width: 800, height: 600 });
  });

  await check('R5 plan: host borrado fuera (el split se cura), quick connect = nota, local = shell nuevo, orden de reconexion', () => {
    const snap = sanitizeWindow(R.snapshotWindow(estado));
    /* Todo sigue: orden = pestana activa (b), luego la barra: a (y su panel local no cuenta) */
    let plan = R.restorePlan(snap, hosts);
    assert.deepStrictEqual(plan.connect, ['b', 'a'], `orden: ${plan.connect}`);
    assert.strictEqual(plan.activeTabId, 'b');
    const a = plan.tabs.find(t => t.id === 'a');
    assert.deepStrictEqual([a.alias, a.color, a.connecting, a.hostId], ['logs', '#ff0000', true, 'h1'], 'alias/color/estado de la pestana a');
    assert.strictEqual(plan.tabs.find(t => t.id === 'b').muted, true, 'mute perdido');
    assert.deepStrictEqual(plan.layouts.a, estado.layouts.a, 'el split no volvio igual');
    assert.strictEqual(plan.focusedPane.a, 'l', 'panel enfocado perdido');
    const l = plan.tabs.find(t => t.id === 'l');
    assert.deepStrictEqual([l.type, l.sessionId, l.hidden, l.ptySessionId], ['local-terminal', 'local-l', true, undefined], 'local: no es un shell nuevo');
    const q = plan.tabs.find(t => t.id === 'q');
    assert.ok(q.skipped && !q.connecting && /not reconnected/.test(q.error) && q.error.includes('ops@1.2.3.4:2222'), `quick: ${JSON.stringify(q)}`);
    /* (A saved host's tab carries hostConfig in memory, as connectToHost does; never on disk, R2) */
    assert.ok(!JSON.stringify(q).includes(SECRETO), 'la nota del quick connect lleva su contrasena');
    /* La nota no se vuelve a guardar */
    assert.ok(!R.snapshotWindow({ ...plan, hosts }).tabs.some(t => t.id === 'q'), 'la nota del quick connect se guardaria otra vez');
    /* h1 borrado: la pestana a sale, el panel local hereda el grupo y la posicion */
    plan = R.restorePlan(snap, [hosts[1]]);
    assert.deepStrictEqual(plan.dropped, ['a']);
    assert.deepStrictEqual(plan.tabs.filter(t => !t.hidden).map(t => t.id), ['l', 'b', 'q'], `barra tras borrar el host: ${plan.tabs.map(t => t.id + (t.hidden ? '*' : ''))}`);
    assert.deepStrictEqual(plan.layouts, {}, 'el split de un solo panel sigue');
    assert.deepStrictEqual(plan.connect, ['b']);
    /* Activa borrada → la primera; ninguna activa (Home) → sigue en Home */
    assert.strictEqual(R.restorePlan({ ...snap, activeTabId: 'a' }, [hosts[1]]).activeTabId, 'l');
    assert.strictEqual(R.restorePlan({ ...snap, activeTabId: null }, hosts).activeTabId, null);
    assert.deepStrictEqual(R.restorePlan({ ...snap, activeTabId: null }, hosts).connect, ['a', 'b'], 'sin activa: orden de la barra');
    /* Panel oculto sin arbol que lo contenga → pestana visible */
    const huerfano = R.restorePlan({ tabs: [{ id: 'o', kind: 'local', hidden: true }], layouts: {} }, []);
    assert.strictEqual(huerfano.tabs[0].hidden, undefined, 'un panel oculto sin grupo quedo invisible');
  });

  await check('R6 reconexiones escalonadas 150 ms, en orden, y una que lanza no para las demas', async () => {
    assert.strictEqual(R.RECONNECT_STAGGER_MS, 150);
    const llamadas = [];
    const t0 = Date.now();
    const n = await R.runStaggered(['x', 'y', 'z', 'w'], (id) => {
      llamadas.push([id, Date.now() - t0]);
      if (id === 'y') throw new Error('falla');
      if (id === 'z') return Promise.reject(new Error('rechaza'));
      return null;
    });
    assert.strictEqual(n, 4);
    assert.deepStrictEqual(llamadas.map(([id]) => id), ['x', 'y', 'z', 'w'], 'orden');
    for (let i = 1; i < llamadas.length; i++) {
      const gap = llamadas[i][1] - llamadas[i - 1][1];
      assert.ok(gap >= 140, `entre ${llamadas[i - 1][0]} y ${llamadas[i][0]} solo ${gap} ms`);
    }
    assert.strictEqual(await R.runStaggered([], () => {}), 0);
  });

  await check('R7 ventanas: cerrar una de dos la quita, el cierre que sale la conserva, take una vez, congelado no entra nada', async () => {
    const s = nuevo();
    const A = ventana('R7a'); const B = ventana('R7b');
    s.assign(A.win, { payload: sanitizeWindow(R.snapshotWindow(estado)) });
    s.attach(B.win);
    assert.ok(s.take(A.wc) && s.take(A.wc) === null, 'take no es de una sola vez');
    assert.strictEqual(s.take(B.wc), null, 'una ventana nueva recibio algo que restaurar');
    s.report(B.wc, { tabs: [{ id: 'k', kind: 'local' }] });
    B.win.mover({ x: 400 });
    await s.flush();
    assert.deepStrictEqual(leer().windows.map(w => w.tabs.length), [4, 1]);
    assert.strictEqual(leer().windows[1].bounds.x, 400, 'mover la ventana no llego al disco');
    /* Cerrar B con A abierta: B sale */
    B.win.cerrar();
    s.windowClosed(B.wc, { keep: false });
    await s.flush();
    assert.strictEqual(leer().windows.length, 1, 'la ventana cerrada sigue en el workspace');
    /* El cierre de la ultima (Linux/Windows: sale de la app) la conserva, con sus bounds */
    A.win.mover({ x: 222 });
    A.win.cerrar();
    s.windowClosed(A.wc, { keep: true });
    assert.strictEqual(s.report(A.wc, { tabs: [] }), false, 'tras congelar entro un reporte');
    await s.quitFlush();
    const w = leer().windows;
    assert.deepStrictEqual([w.length, w[0].tabs.length, w[0].bounds.x], [1, 4, 222], `al salir: ${JSON.stringify(w.map(x => [x.tabs.length, x.bounds]))}`);
    fs.unlinkSync(file());
  });
}

async function seccionReconexion({ check, ROOT }) {
  const E = (...p) => require(path.join(ROOT, 'electron', ...p));
  const registry = E('window-registry.js');
  const ipc = E('ipc-handlers.js');
  const sshService = E('services', 'ssh-service.js');
  const hostKeyService = E('services', 'host-key-service.js');
  sshService.setMainWindow(registry.sessionSink);
  hostKeyService.setRouter(registry);

  const delaysReales = sshService.reconnectDelays.slice();
  const agente = process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AUTH_SOCK;
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-rc-')), 'host_ed25519');
  let sshd = await startSshTestServer({ user: 'arnes', password: 'clave', hostKeyFile: keyFile });
  const port = sshd.port;
  let conns = [];
  const vigila = (srv) => srv.server.on('connection', (c) => { conns.push(c); c.on('error', () => {}); });
  vigila(sshd);
  const config = { host: '127.0.0.1', port, username: 'arnes', password: 'clave', timeout: 5000 };
  const V = ventana('A');
  ipc.attachWindow(V.win);
  const texto = (sid) => V.de('ssh:data').filter(([, , s]) => s === sid).map(([, , , d]) => d).join('');
  const pushes = (sid) => V.de('ssh:reconnect').filter(([, , p]) => p.sessionId === sid).map(([, t, p]) => ({ ...p, t }));
  const abiertas = [];
  const conecta = async (extra = {}) => {
    const p = sshService.connect({ ...config, ...extra }, V.wc);
    p.then(s => abiertas.push(s), () => {});
    const aviso = await Promise.race([
      espera(() => V.de('ssh:host-key-prompt').length > 0, 3000).then(() => V.de('ssh:host-key-prompt').slice(-1)[0]),
      p.then(() => null),
    ]);
    if (aviso && aviso[2] && hostKeyService._pending.has(aviso[2].requestId)) await hostKeyService.respond(aviso[2].requestId, true);
    return p;
  };
  const corta = () => { for (const c of conns.splice(0)) { try { c._sock.destroy(); } catch (_) { /* ya */ } } };
  const apaga = async () => { const p = sshd.close(); corta(); await Promise.race([p, sleep(2000)]); };
  const enciende = async (password = 'clave') => {
    sshd = await startSshTestServer({ port, user: 'arnes', password, hostKeyFile: keyFile });
    vigila(sshd);
  };

  try {
    await check('A1 compresion: una terminal negocia zlib@openssh.com; una conexion solo SFTP, none', async () => {
      const s = await conecta();
      const sf = await conecta({ purpose: 'sftp' });
      try {
        const c1 = sshService.sessions.get(s).negotiated?.cs?.compress;
        const c2 = sshService.sessions.get(sf).negotiated?.cs?.compress;
        assert.strictEqual(c1, 'zlib@openssh.com', `terminal: ${c1}`);
        assert.strictEqual(c2, 'none', `sftp: ${c2}`);
        sshService.sendData(s, 'echo comprimido\r');
        assert.ok(await espera(() => texto(s).includes('comprimido\r\n')), 'con compresion el eco no llega');
      } finally { await sshService.disconnect(s); await sshService.disconnect(sf); }
    });

    await check('A3 calendario: 1,2,4,8,16 s y luego 30 s, ~2 min en total', () => {
      assert.deepStrictEqual(delaysReales.slice(0, 5), [1000, 2000, 4000, 8000, 16000]);
      assert.ok(delaysReales.slice(5).every(d => d === 30000), `tope: ${delaysReales}`);
      const total = delaysReales.reduce((a, b) => a + b, 0);
      assert.ok(total >= 110000 && total <= 130000, `total ${total} ms`);
    });

    sshService.reconnectDelays = [40, 80, 160, 320];

    await check('A2 corte del socket: mismo sessionId y ventana, "Reconnecting… (attempt 1)", y el shell nuevo responde', async () => {
      const s = await conecta();
      sshService.sendData(s, 'echo antes-del-corte\r');
      assert.ok(await espera(() => texto(s).includes('antes-del-corte\r\n')));
      corta();
      assert.ok(await espera(() => pushes(s).some(p => p.state === 'reconnected'), 5000), `no reconecto: ${JSON.stringify(pushes(s))}`);
      assert.deepStrictEqual(pushes(s).map(p => p.state), ['lost', 'reconnecting', 'reconnected']);
      assert.ok(texto(s).includes('Reconnecting… (attempt 1)'), 'sin la linea de reintento en la terminal');
      assert.ok(texto(s).includes('[Reconnected]'));
      assert.strictEqual(V.de('ssh:close').filter(([, , x]) => x === s).length, 0, 'mando ssh:close en un corte que reconecto');
      assert.ok(sshService.isConnected(s) && registry.ownerOf(s) === V.wc, 'la sesion o su dueno cambiaron');
      sshService.sendData(s, 'echo despues-del-corte\r');
      assert.ok(await espera(() => texto(s).includes('despues-del-corte\r\n')), 'el shell nuevo no responde');
      await sshService.disconnect(s);
    });

    await check('A3b servidor caido: los intentos respetan las esperas, luego "failed" + ssh:close y la sesion se va', async () => {
      const s = await conecta();
      await apaga();
      assert.ok(await espera(() => pushes(s).some(p => p.state === 'failed'), 8000), `no se rindio: ${JSON.stringify(pushes(s).map(p => p.state))}`);
      const intentos = pushes(s).filter(p => p.state === 'reconnecting');
      assert.deepStrictEqual(intentos.map(p => [p.attempt, p.delayMs]), [[1, 40], [2, 80], [3, 160], [4, 320]]);
      for (let i = 1; i < intentos.length; i++) {
        assert.ok(intentos[i].t - intentos[i - 1].t >= intentos[i].delayMs - 5, `intento ${i + 1} llego a los ${intentos[i].t - intentos[i - 1].t} ms`);
      }
      assert.ok(await espera(() => V.de('ssh:close').some(([, , x]) => x === s), 1000), 'sin ssh:close tras rendirse');
      assert.ok(!sshService.isConnected(s) && registry.ownerOf(s) == null, 'la sesion sigue tras rendirse');
      assert.ok(texto(s).includes('Could not reconnect'), 'no dice que se rindio');
      await enciende();
    });

    await check('A4 el servidor vuelve a mitad del calendario: reconecta en un intento posterior', async () => {
      sshService.reconnectDelays = [40, 300, 600, 800];
      const s = await conecta();
      await apaga();
      assert.ok(await espera(() => pushes(s).some(p => p.state === 'reconnecting' && p.attempt === 1), 3000));
      await sleep(80);
      await enciende();
      assert.ok(await espera(() => pushes(s).some(p => p.state === 'reconnected'), 4000), `no volvio: ${JSON.stringify(pushes(s).map(p => [p.state, p.attempt]))}`);
      const ok = pushes(s).find(p => p.state === 'reconnected');
      assert.ok(ok.attempt >= 2, `reconecto en el intento ${ok.attempt}`);
      sshService.sendData(s, 'echo volvio\r');
      assert.ok(await espera(() => texto(s).includes('volvio\r\n')));
      await sshService.disconnect(s);
      sshService.reconnectDelays = [40, 80, 160, 320];
    });

    await check('A5 sin reconexion: cerrar la pestana, `exit` del shell, o cerrar durante la espera', async () => {
      /* El usuario cierra */
      let s = await conecta();
      await sshService.disconnect(s);
      await sleep(150);
      assert.deepStrictEqual(pushes(s), [], 'cerrar a mano reconecto');
      /* exit */
      s = await conecta();
      sshService.sendData(s, 'exit\r');
      assert.ok(await espera(() => V.de('ssh:close').some(([, , x]) => x === s), 3000), 'exit no cerro');
      await sleep(150);
      assert.deepStrictEqual(pushes(s), [], '`exit` reconecto');
      /* El shell sale y el enlace se va con el (exit-status, luego fin del socket sin cerrar el canal) */
      s = await conecta();
      sshService.sendData(s, 'exit-drop\r');
      assert.ok(await espera(() => V.de('ssh:close').some(([, , x]) => x === s), 3000), 'exit-drop no cerro');
      await sleep(150);
      assert.deepStrictEqual(pushes(s), [], 'un shell que salio se reconecto porque el socket se fue a la vez');
      /* Cerrar durante la espera */
      sshService.reconnectDelays = [300, 300];
      s = await conecta();
      corta();
      assert.ok(await espera(() => pushes(s).some(p => p.state === 'lost'), 3000));
      await sshService.disconnect(s);
      await sleep(450);
      assert.deepStrictEqual(pushes(s).map(p => p.state), ['lost'], 'siguio intentando tras cerrar');
      assert.ok(!sshService.isConnected(s));
      sshService.reconnectDelays = [40, 80, 160, 320];
    });

    await check('A6 un error permanente (la contrasena ya no vale) corta el calendario en el primer intento', async () => {
      sshService.reconnectDelays = [300, 300, 300];
      const s = await conecta();
      await apaga();
      await enciende('otra-clave');
      assert.ok(await espera(() => pushes(s).some(p => p.state === 'failed'), 4000), `no se rindio: ${JSON.stringify(pushes(s).map(p => p.state))}`);
      const intentos = pushes(s).filter(p => p.state === 'reconnecting');
      assert.strictEqual(intentos.length, 1, `siguio intentando con una contrasena rechazada: ${intentos.length}`);
      assert.ok(/authentication/i.test(pushes(s).find(p => p.state === 'failed').error || ''), 'el error no es el de autenticacion');
    });
  } finally {
    sshService.reconnectDelays = delaysReales;
    for (const s of abiertas) { try { await sshService.disconnect(s); } catch (_) { /* ya */ } }
    corta();
    await Promise.race([sshd.close(), sleep(3000)]);
    if (agente !== undefined) process.env.SSH_AUTH_SOCK = agente;
  }
}

module.exports = { seccionWorkspace, seccionReconexion };
