/**
 * Seccion ML del arnes del main (scripts/check-main.js): el ciclo de vida de
 * electron/main.js, cargado de verdad con un `electron` falso propio.
 *
 *  ML1 reinicio tras actualizar (deb/pacman): el relanzado se arma SOLO cuando
 *      electron-updater emite before-quit-for-update (instalacion correcta);
 *      pkexec cancelado / dpkg fallido no deja nada armado (el siguiente
 *      cierre normal no relanza, installingUpdate vuelve a false), dos clics
 *      no apilan dos relanzados, un unico oyente de will-quit. AppImage: nunca.
 *      Y el evento existe en el electron-updater instalado.
 *  ML2 una sola instancia: sin el candado la segunda sale sin crear ventanas
 *      ni tocar el workspace; con el candado, second-instance trae al frente
 *      la ventana existente (restaura si esta minimizada), nada antes de
 *      terminar el arranque; en dev no se pide el candado.
 *  ML3 cerrar una de varias ventanas con sesiones del keeper: el dialogo
 *      ofrece [Keep Running in Background] [End Sessions] [Cancel]; Cancel no
 *      cierra; Keep solo desconecta (siguen en Background sessions); End
 *      llama a keeperEnd para las guardadas y desconecta las normales. Sin
 *      sesiones guardadas, el texto de siempre.
 *
 * main.js tiene efectos al cargarse: whenReady no se resuelve (salvo ML2 sin
 * candado), app.quit no emite nada, y todo lo que toca del arnes compartido
 * (fabrica de ventanas del registro, oyentes de process, sesiones de
 * ssh-service, child_process.spawn) se restaura al terminar.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');
const childProcess = require('child_process');

const tick = () => new Promise(r => setImmediate(r));
const ticks = async (n = 3) => { for (let i = 0; i < n; i++) await tick(); };

function ventana(nombre, { minimizada = false, focused = false } = {}) {
  const em = new EventEmitter();
  const llamadas = [];
  let vivo = true;
  const wc = { nombre, send: () => {}, isDestroyed: () => !vivo, on: () => {} };
  const win = {
    webContents: wc,
    isDestroyed: () => !vivo,
    isFocused: () => focused,
    isMinimized: () => minimizada,
    isMaximized: () => false,
    isFullScreen: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 900, height: 600 }),
    on: (ev, fn) => { em.on(ev, fn); return win; },
    once: (ev, fn) => { em.once(ev, fn); return win; },
    restore: () => { minimizada = false; llamadas.push('restore'); },
    show: () => llamadas.push('show'),
    focus: () => llamadas.push('focus'),
    close: () => { llamadas.push('close'); vivo = false; em.emit('closed'); },
    flashFrame: () => {},
  };
  return { win, wc, llamadas };
}

/** Carga electron/main.js con un electron falso. Devuelve el falso y los _test. */
function cargaMain(ROOT, { lock = true, dev = false, ready = false, respuesta = null } = {}) {
  const mainPath = path.join(ROOT, 'electron', 'main.js');
  const app = new EventEmitter();
  Object.assign(app, {
    quitCalls: 0,
    lockAsked: 0,
    quit: () => { app.quitCalls++; },
    requestSingleInstanceLock: () => { app.lockAsked++; return lock; },
    whenReady: () => (ready ? Promise.resolve() : new Promise(() => {})),
    getVersion: () => '0.0.0-ml',
    getPath: () => os.tmpdir(),
  });
  const nativeUpdater = new EventEmitter();
  const updater = new EventEmitter();
  updater.checkForUpdates = () => Promise.resolve(null);
  updater.downloadUpdate = () => Promise.resolve();
  updater.quitAndInstall = () => {};
  const ipc = new Map();
  const dialogos = [];
  let ventanasCreadas = 0;
  const fake = {
    app,
    autoUpdater: nativeUpdater,
    ipcMain: { handle: (c, fn) => ipc.set(c, fn), on: () => {}, removeHandler: (c) => ipc.delete(c) },
    dialog: {
      showMessageBox: (_win, opts) => {
        dialogos.push(opts);
        return Promise.resolve({ response: typeof respuesta === 'function' ? respuesta(opts) : 0 });
      },
    },
    BrowserWindow: class { constructor() { ventanasCreadas++; throw new Error('ML: main.js creo una ventana'); } },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
  };
  fake.BrowserWindow.getFocusedWindow = () => null;
  fake.BrowserWindow.getAllWindows = () => [];

  const registry = require(path.join(ROOT, 'electron', 'window-registry.js'));
  const factoryAntes = registry._factory;
  const devAntes = process.env.VITE_DEV_SERVER_URL;
  if (dev) process.env.VITE_DEV_SERVER_URL = 'http://127.0.0.1:1'; else delete process.env.VITE_DEV_SERVER_URL;
  const oyentesAntes = {
    uncaughtException: process.listeners('uncaughtException'),
    unhandledRejection: process.listeners('unhandledRejection'),
  };
  /* main.js pide electron / electron-updater tambien despues de cargar
     (setupAutoUpdater): `dentro` reinstala el gancho para esas llamadas */
  const dentro = (fn) => {
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
      if (parent && parent.filename === mainPath) {
        if (request === 'electron') return fake;
        if (request === 'electron-updater') return { autoUpdater: updater };
      }
      return load.call(this, request, parent, isMain);
    };
    try { return fn(); } finally { Module._load = load; }
  };
  let m;
  try {
    delete require.cache[mainPath];
    m = dentro(() => require(mainPath));
  } finally {
    delete require.cache[mainPath];
    registry.setWindowFactory(factoryAntes);
    if (devAntes === undefined) delete process.env.VITE_DEV_SERVER_URL; else process.env.VITE_DEV_SERVER_URL = devAntes;
    for (const ev of Object.keys(oyentesAntes)) {
      for (const fn of process.listeners(ev)) if (!oyentesAntes[ev].includes(fn)) process.removeListener(ev, fn);
    }
  }
  return { T: m._test, dentro, app, nativeUpdater, updater, ipc, dialogos, creadas: () => ventanasCreadas };
}

async function seccionCicloVida({ check, ROOT }) {
  // ── ML1 reinicio tras una actualizacion deb/pacman ──
  await check('ML1 updater: el relanzado se arma solo si la instalacion salio (before-quit-for-update); fallo/cancelar no deja nada, dos clics = un relanzado', async () => {
    /* El evento del que depende todo existe en el electron-updater instalado */
    const base = path.join(path.dirname(require.resolve('electron-updater', { paths: [ROOT] })), 'BaseUpdater.js');
    assert.ok(/emit\("before-quit-for-update"\)/.test(fs.readFileSync(base, 'utf-8')),
      'electron-updater ya no emite before-quit-for-update en BaseUpdater: revisar main.js');
    if (process.platform !== 'linux') return;

    const res = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-ml-'));
    const resAntes = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    const spawnAntes = childProcess.spawn;
    const spawns = [];
    Object.defineProperty(process, 'resourcesPath', { value: res, configurable: true, writable: true });
    childProcess.spawn = (...a) => { spawns.push(a); return { unref: () => {} }; };
    try {
      const sale = (L) => () => setImmediate(() => { L.nativeUpdater.emit('before-quit-for-update'); L.app.quit(); });
      for (const tipo of ['deb', 'pacman']) {
        fs.writeFileSync(path.join(res, 'package-type'), tipo);
        spawns.length = 0;
        const L = cargaMain(ROOT);
        L.dentro(() => L.T.setupAutoUpdater());
        const install = L.ipc.get('updater:install');
        assert.ok(install, 'updater:install sin registrar');
        const oyentes = L.app.listenerCount('will-quit');
        assert.strictEqual(oyentes, 1, `${tipo}: se esperaba un unico oyente de will-quit al cargar`);

        /* pkexec cancelado / dpkg falla: quitAndInstall vuelve sin emitir nada */
        install(); install();
        await ticks();
        let st = L.T.state();
        assert.strictEqual(st.relaunchArmed, false, `${tipo}: fallo de instalacion y el relanzado quedo armado`);
        assert.strictEqual(st.installingUpdate, false, `${tipo}: fallo de instalacion e installingUpdate sigue en true`);
        assert.strictEqual(st.relaunchAfterUpdate, false, `${tipo}: fallo y relaunchAfterUpdate sigue pedido`);
        assert.strictEqual(L.updater.autoRunAppAfterInstall, true, `${tipo}: autoRunAppAfterInstall no se restauro`);
        assert.strictEqual(L.app.listenerCount('will-quit'), oyentes, `${tipo}: cada clic anade un oyente de will-quit`);
        L.app.emit('will-quit');   // el siguiente cierre normal
        assert.strictEqual(spawns.length, 0, `${tipo}: un cierre normal tras un fallo relanzo Termilab`);

        /* Ahora si: instalacion correcta, dos clics, dos pasadas de will-quit */
        L.updater.quitAndInstall = sale(L);
        install(); install();
        await ticks();
        st = L.T.state();
        assert.strictEqual(st.relaunchArmed, true, `${tipo}: instalacion correcta y el relanzado no se armo`);
        assert.strictEqual(st.installingUpdate, true, `${tipo}: instalacion correcta e installingUpdate en false`);
        assert.strictEqual(L.updater.autoRunAppAfterInstall, false, `${tipo}: autoRunAppAfterInstall no quedo en false`);
        L.app.emit('will-quit'); L.app.emit('will-quit');
        assert.strictEqual(spawns.length, 1, `${tipo}: se esperaba exactamente un relanzado, hubo ${spawns.length}`);
        assert.strictEqual(L.app.listenerCount('will-quit'), oyentes);
      }
      /* AppImage (sin package-type): electron-updater relanza solo, nosotros nunca */
      fs.rmSync(path.join(res, 'package-type'));
      spawns.length = 0;
      const L = cargaMain(ROOT);
      L.dentro(() => L.T.setupAutoUpdater());
      L.updater.quitAndInstall = sale(L);
      L.ipc.get('updater:install')();
      await ticks();
      L.app.emit('will-quit');
      assert.strictEqual(spawns.length, 0, 'AppImage: relanzamos nosotros ademas de electron-updater');
      assert.strictEqual(L.T.state().installingUpdate, true);
    } finally {
      childProcess.spawn = spawnAntes;
      if (resAntes) Object.defineProperty(process, 'resourcesPath', resAntes); else delete process.resourcesPath;
      fs.rmSync(res, { recursive: true, force: true });
    }
  });

  // ── ML2 una sola instancia ──
  await check('ML2 una instancia: la segunda sale sin ventanas ni workspace; second-instance enfoca la existente; dev sin candado', async () => {
    /* Segunda instancia: sin candado */
    const S = cargaMain(ROOT, { lock: false, ready: true });
    await ticks(5);
    assert.strictEqual(S.app.lockAsked, 1, 'no se pidio el candado de instancia unica');
    assert.strictEqual(S.app.quitCalls, 1, 'la segunda instancia no salio');
    assert.strictEqual(S.creadas(), 0, 'la segunda instancia creo ventanas');
    assert.strictEqual(S.app.listenerCount('second-instance'), 0, 'la segunda instancia escucha second-instance');
    let prevenido = false;
    for (const fn of S.app.listeners('before-quit')) await fn({ preventDefault: () => { prevenido = true; } });
    assert.strictEqual(prevenido, false, 'el before-quit de la segunda instancia retuvo la salida (guardaria el workspace)');

    /* Primera instancia: con candado */
    const P = cargaMain(ROOT, { lock: true });
    assert.strictEqual(P.app.quitCalls, 0, 'la primera instancia salio');
    assert.strictEqual(P.app.listenerCount('second-instance'), 1, 'sin oyente de second-instance');
    const muerta = ventana('muerta'); muerta.win.close();
    const A = ventana('A', { minimizada: true });
    P.T.windows.add(muerta.win); P.T.windows.add(A.win);
    P.app.emit('second-instance', {}, ['termilab'], '/');
    assert.deepStrictEqual(A.llamadas, [], 'second-instance actuo antes de terminar el arranque');
    P.T.markLaunched();
    P.app.emit('second-instance', {}, ['termilab'], '/');
    assert.deepStrictEqual(A.llamadas, ['restore', 'show', 'focus'], `second-instance no trajo la ventana: ${A.llamadas}`);
    assert.strictEqual(P.creadas(), 0, 'second-instance creo una ventana habiendo una abierta');

    /* Dev: no se pide el candado (comparte userData con la app instalada) */
    const D = cargaMain(ROOT, { lock: false, dev: true });
    assert.strictEqual(D.app.lockAsked, 0, 'en dev se pidio el candado');
    assert.strictEqual(D.app.quitCalls, 0, 'en dev la app salio');
    assert.strictEqual(D.T.state().primaryInstance, true);
  });

  // ── ML3 cerrar una ventana con sesiones del keeper ──
  await check('ML3 cerrar una de varias ventanas con sesiones guardadas: Keep/End/Cancel; End = keeperEnd, Keep = solo desconectar', async () => {
    const E = (...p) => require(path.join(ROOT, 'electron', ...p));
    const ipc = E('ipc-handlers.js');
    const registry = E('window-registry.js');
    const sshService = E('services', 'ssh-service.js');
    const antes = { keeperEnd: sshService.keeperEnd, disconnect: sshService.disconnect };
    const llamadas = [];
    const sids = [];
    sshService.keeperEnd = async (sid) => { llamadas.push(['end', sid]); sshService.sessions.delete(sid); };
    sshService.disconnect = async (sid) => { llamadas.push(['disc', sid]); sshService.sessions.delete(sid); };
    const sesion = (sid, wc, kept) => {
      sids.push(sid);
      sshService.sessions.set(sid, kept ? { keeper: { bin: '/x', session: { id: sid } }, config: {} } : { config: {} });
      registry.claim(sid, wc);
    };
    /* Una ventana de varias con una sesion guardada y una normal */
    const prueba = async (nombre, respuesta) => {
      const L = cargaMain(ROOT, { respuesta: () => respuesta });
      const V = ventana(nombre);
      const otra = ventana(`${nombre}-otra`);
      ipc.attachWindow(V.win);
      L.T.windows.add(V.win); L.T.windows.add(otra.win);
      sesion(`ml-${nombre}-k`, V.wc, true);
      sesion(`ml-${nombre}-p`, V.wc, false);
      let prevenido = false;
      L.T.confirmClose(V.win, { preventDefault: () => { prevenido = true; } });
      await ticks(5);
      await new Promise(r => setTimeout(r, 20));
      return { L, V, prevenido };
    };
    try {
      llamadas.length = 0;
      let r = await prueba('cancel', 2);
      assert.ok(r.prevenido, 'no se pregunto antes de cerrar');
      const d = r.L.dialogos[0];
      assert.deepStrictEqual(d.buttons, ['Keep Running in Background', 'End Sessions', 'Cancel'], `botones: ${d.buttons}`);
      assert.strictEqual(d.cancelId, 2);
      assert.ok(/Background sessions/.test(d.detail), 'el detalle no dice donde quedan');
      assert.ok(/other open session/.test(d.detail), 'el detalle no avisa de la sesion normal');
      assert.deepStrictEqual(r.V.llamadas, [], 'Cancel cerro la ventana');
      assert.deepStrictEqual(llamadas, [], 'Cancel termino sesiones');
      r.V.win.close(); await ticks(5);   // limpieza: sin respuesta End, solo desconecta

      llamadas.length = 0;
      r = await prueba('keep', 0);
      assert.ok(r.V.llamadas.includes('close'), 'Keep no cerro la ventana');
      assert.deepStrictEqual(llamadas.sort(), [['disc', 'ml-keep-k'], ['disc', 'ml-keep-p']],
        `Keep: se esperaba solo desconectar: ${JSON.stringify(llamadas)}`);

      llamadas.length = 0;
      r = await prueba('end', 1);
      assert.ok(r.V.llamadas.includes('close'), 'End no cerro la ventana');
      assert.deepStrictEqual(llamadas.sort(), [['disc', 'ml-end-p'], ['end', 'ml-end-k']],
        `End: keeperEnd para la guardada, desconectar la normal: ${JSON.stringify(llamadas)}`);

      /* Sin sesiones guardadas: el dialogo de siempre */
      const L = cargaMain(ROOT, { respuesta: () => 1 });
      const V = ventana('plain');
      ipc.attachWindow(V.win);
      L.T.windows.add(V.win); L.T.windows.add(ventana('plain-otra').win);
      sesion('ml-plain-p', V.wc, false);
      L.T.confirmClose(V.win, { preventDefault: () => {} });
      await ticks(5);
      assert.deepStrictEqual(L.dialogos[0].buttons, ['Close Window', 'Cancel']);
      assert.ok(/terminated/.test(L.dialogos[0].detail));
      V.win.close(); await ticks(5);
    } finally {
      for (const k of Object.keys(antes)) {
        if (Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(sshService), k)) delete sshService[k];
        else sshService[k] = antes[k];
      }
      for (const sid of sids) { sshService.sessions.delete(sid); try { registry.release(sid); } catch (_) { /* ya */ } }
    }
  });
}

module.exports = { seccionCicloVida };
