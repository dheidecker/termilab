/**
 * Seccion W del arnes del main (scripts/check-main.js): varias ventanas.
 *
 *  W1  un evento de sesion va SOLO a la ventana duena (registro + ssh-service
 *      de verdad contra el sshd de juguete; el aviso de host key incluido).
 *  W2  mover una sesion a mitad de flujo con el bufer: 10 000 trozos con la
 *      mudanza en medio, la concatenacion de las dos ventanas = lo emitido,
 *      sin perder ni repetir nada. Tambien abortar (a mano y por tiempo).
 *  W3  lo mismo con una sesion SSH real (`seq` grande) y mudanza al primer trozo.
 *  W4  cerrar una ventana cierra SOLO sus sesiones.
 *  W5  los eventos globales (sync:status, store-changed) llegan a todas.
 *  W6  los canales window:* comprueban quien llama (mover desde otra ventana falla).
 *  W7  cerrar una ventana con un ssh:connect a medio camino: no queda sesion
 *      sin dueno, el registro se cierra, nada (ni el aviso de host key) va a
 *      otra ventana.
 *  W8  una pestana cuya sesion presta a un panel SFTP de su ventana no se
 *      mueve (cannotMove, el modulo del renderer de verdad via esbuild).
 *  W9  abortar quita la adopcion encolada; takeAdoptions descarta las muertas.
 *  W10 una pestana partida se muda entera o nada (abortar tras un panel listo).
 *  W11 un aviso de host key compartido entre ventanas: cerrar la que lo
 *      muestra lo pasa a la otra, no rechaza su conexion.
 *  W12 las llamadas por sesion (ssh/local/sftp, move-abort) desde una ventana
 *      que no es la duena se rechazan; durante la mudanza, origen y destino si.
 *  W13 window:attention ("un agente termino" fuera de la ventana): flashFrame
 *      solo si la ventana no tiene el foco, se apaga al enfocarla; el badge
 *      es el total de paneles sin ver de TODAS las ventanas, baja al verlos y
 *      al cerrar una ventana.
 *
 * Usa el singleton del registro, que ya tiene la ventana falsa del arnes
 * (registerIpcHandlers): por eso las ventanas de aqui nunca son la primaria.
 */
const assert = require('assert');
const path = require('path');
const { startSshTestServer } = require('./ssh-test-server');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Una ventana falsa: lo que recibe, eventos on()/emit(), y bounds. */
function ventanaFalsa(nombre, { focused = false } = {}) {
  const recibido = [];
  const oyentes = new Map();
  let vivo = true;
  const wc = {
    nombre,
    send: (canal, ...args) => recibido.push([canal, ...args]),
    isDestroyed: () => !vivo,
  };
  const win = {
    webContents: wc,
    isDestroyed: () => !vivo,
    isFocused: () => focused,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    on: (ev, fn) => { if (!oyentes.has(ev)) oyentes.set(ev, []); oyentes.get(ev).push(fn); return win; },
    once: (ev, fn) => win.on(ev, fn),
    cerrar: () => { vivo = false; for (const fn of oyentes.get('closed') || []) fn(); },
    setFocused: (v) => { focused = v; },
    emitir: (ev) => { for (const fn of oyentes.get(ev) || []) fn(); },
    flashFrame: (v) => { destellos.push(v); },
  };
  const destellos = [];
  return { win, wc, recibido, destellos, de: (canal) => recibido.filter(([c]) => c === canal) };
}

/** windowMove.js del renderer (ESM) empaquetado a CJS para node */
function cargaWindowMove(ROOT) {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'components', 'SplitPane', 'windowMove.js')],
    bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  });
  const Module = require('module');
  const m = new Module('windowMove-arnes');
  m._compile(out.outputFiles[0].text, 'windowMove-arnes.js');
  return m.exports;
}

async function seccionVentanas({ check, ROOT, handlers, onHandlers }) {
  const E = (...p) => require(path.join(ROOT, 'electron', ...p));
  const registry = E('window-registry.js');
  const ipc = E('ipc-handlers.js');
  const sshService = E('services', 'ssh-service.js');
  const hostKeyService = E('services', 'host-key-service.js');
  const syncService = E('services', 'sync-service.js');
  const localShellService = E('services', 'local-shell-service.js');
  const connectionLogService = E('services', 'connection-log-service.js');

  /* Las secciones anteriores dejan ventanas propias en los servicios */
  sshService.setMainWindow(registry.sessionSink);
  syncService.setMainWindow(registry.broadcastSink);
  hostKeyService.setRouter(registry);

  // ── W13 window:attention (badge + destello) ──────────────
  await check('W13 window:attention: destella solo sin foco, se apaga al enfocar; badge = total sin ver de todas las ventanas', async () => {
    const electron = require('electron');
    const badges = [];
    const rebotes = [];
    const antes = { setBadgeCount: electron.app.setBadgeCount, dock: electron.app.dock };
    electron.app.setBadgeCount = (n) => { badges.push(n); return true; };
    electron.app.dock = { bounce: (t) => { rebotes.push(t); return 1; } };
    const mac = process.platform === 'darwin';
    const A = ventanaFalsa('A13', { focused: false });
    const B = ventanaFalsa('B13', { focused: true });
    const att = (V, spec) => handlers.get('window:attention')({ sender: V.wc }, spec).then(r => {
      assert.ok(r.success, `window:attention fallo: ${r.error}`);
      return r.data;
    });
    try {
      ipc.attachWindow(A.win);
      ipc.attachWindow(B.win);
      /* A sin foco, un panel nuevo: destella (macOS: rebota el dock) */
      let r = await att(A, { unseen: 2, flash: true });
      assert.strictEqual(r.flashed, true, 'A sin foco no destello');
      if (mac) assert.deepStrictEqual(rebotes, ['informational'], 'macOS: el dock no reboto');
      else assert.deepStrictEqual(A.destellos, [true], 'A sin foco: flashFrame(true) no se llamo');
      assert.strictEqual(r.total, 2);
      /* B con foco: nunca destella, pero suma al badge */
      r = await att(B, { unseen: 1, flash: true });
      assert.strictEqual(r.flashed, false, 'B con el foco destello');
      assert.deepStrictEqual(B.destellos, [], 'B con el foco: flashFrame llamado');
      assert.strictEqual(r.total, 3, 'el badge no es el total de las dos ventanas');
      assert.strictEqual(badges[badges.length - 1], 3, 'setBadgeCount no recibio el total');
      /* Recuento sin panel nuevo (flash:false): no destella aunque no tenga foco */
      r = await att(A, { unseen: 2, flash: false });
      assert.strictEqual(r.flashed, false, 'sin flash pedido, destello');
      /* Enfocar A apaga su destello */
      A.win.setFocused(true);
      A.win.emitir('focus');
      if (!mac) assert.deepStrictEqual(A.destellos, [true, false], 'al enfocar A no se llamo flashFrame(false)');
      /* Paneles vistos: el badge baja */
      r = await att(A, { unseen: 0 });
      assert.strictEqual(r.total, 1, 'al ver los paneles de A el badge no bajo');
      assert.strictEqual(badges[badges.length - 1], 1);
      /* Basura: no cuenta */
      r = await att(A, { unseen: -4 });
      assert.strictEqual(r.total, 1, 'un recuento negativo conto');
      /* Cerrar B: sus paneles sin ver se van del badge */
      B.win.cerrar();
      assert.strictEqual(badges[badges.length - 1], 0, 'cerrar B no quito sus paneles del badge');
      assert.strictEqual(registry.totalUnseen(), 0);
    } finally {
      if (!A.win.isDestroyed()) A.win.cerrar();
      if (!B.win.isDestroyed()) B.win.cerrar();
      electron.app.setBadgeCount = antes.setBadgeCount;
      electron.app.dock = antes.dock;
    }
  });

  // ── W2 (registro puro, determinista) ─────────────────────
  await check('W2a mudanza a mitad de 10 000 trozos: A + B = todo, en orden, sin repetir', async () => {
    const A = ventanaFalsa('A');
    const B = ventanaFalsa('B');
    registry.addWindow(A.win);
    registry.addWindow(B.win);
    const sid = 'w2-sesion';
    registry.claim(sid, A.wc);
    registry.takeAdoptions(B.wc);   // B ya escucha: la adopcion le llega en vivo
    const emitido = [];
    let moveId = null;
    for (let i = 0; i < 10000; i++) {
      const trozo = `c${String(i).padStart(5, '0')}|`;
      emitido.push(trozo);
      registry.sessionSink.webContents.send('ssh:data', sid, trozo);
      if (i === 4999) moveId = registry.beginMove([sid], A.wc);
      if (i === 6000) registry.setTarget(moveId, B.wc, { tabs: [] });
      if (i === 7000) { registry.adopted(moveId, B.wc); registry.commit(moveId, sid, B.wc); }
    }
    const enA = A.de('ssh:data').map(([, , d]) => d);
    const enB = B.de('ssh:data').map(([, , d]) => d);
    assert.strictEqual(enA.join('') + enB.join(''), emitido.join(''), 'la concatenacion no coincide');
    assert.strictEqual(enA.length, 5000, `A recibio ${enA.length} trozos (5000 esperados)`);
    assert.strictEqual(enB.length, 5000, `B recibio ${enB.length}`);
    assert.strictEqual(new Set([...enA, ...enB]).size, 10000, 'hay trozos repetidos');
    assert.strictEqual(registry.ownerOf(sid), B.wc, 'el dueno no paso a B');
    assert.strictEqual(B.de('window:adopt').length, 1, 'B no recibio la adopcion');
    assert.deepStrictEqual(A.de('window:move-done').map(([, p]) => p.sessionIds), [[sid]], 'A no supo que termino');
    /* La marca va por el mismo canal ordenado que los datos, justo detras del
       ultimo trozo que A recibio antes de la mudanza (la respuesta del invoke
       no esta ordenada con los push: no sirve de marca) */
    const iMarca = A.recibido.findIndex(([c]) => c === 'window:move-mark');
    assert.ok(iMarca >= 0 && A.recibido[iMarca][1].moveId === moveId, 'A no recibio la marca de la mudanza');
    assert.strictEqual(A.recibido.slice(0, iMarca).filter(([c]) => c === 'ssh:data').length, 5000, 'la marca no va detras de lo ya enviado');
    assert.strictEqual(A.recibido.slice(iMarca).filter(([c]) => c === 'ssh:data').length, 0, 'A recibio datos despues de la marca');
    registry.release(sid);
    registry.removeWindow(A.wc);
    registry.removeWindow(B.wc);
  });

  await check('W2b abortar (a mano y por tiempo) devuelve el bufer al origen, sin perder nada', async () => {
    const A = ventanaFalsa('A');
    const B = ventanaFalsa('B');
    registry.addWindow(A.win);
    registry.addWindow(B.win);
    const sid = 'w2b-sesion';
    registry.claim(sid, A.wc);
    const emitido = [];
    const manda = (n) => { for (let i = 0; i < n; i++) { const t = `x${emitido.length};`; emitido.push(t); registry.sessionSink.webContents.send('ssh:data', sid, t); } };
    manda(10);
    const m1 = registry.beginMove([sid], A.wc);
    manda(10);
    registry.setTarget(m1, B.wc, {});
    manda(10);
    registry.abort(m1, 'cancelled');
    manda(10);
    const viejo = registry.moveTimeoutMs;
    registry.moveTimeoutMs = 30;
    try {
      const m2 = registry.beginMove([sid], A.wc);
      manda(10);
      await sleep(80);
      assert.strictEqual(registry.getMove(m2), null, 'la mudanza colgada no se aborto sola');
    } finally {
      registry.moveTimeoutMs = viejo;
    }
    manda(10);
    const enA = A.de('ssh:data').map(([, , d]) => d).join('');
    assert.strictEqual(enA, emitido.join(''), 'A no recibio todo tras abortar');
    assert.strictEqual(B.de('ssh:data').length, 0, 'B recibio datos de una mudanza abortada');
    assert.strictEqual(A.de('window:move-aborted').length, 2, 'A no supo de los dos abortos');
    assert.strictEqual(registry.ownerOf(sid), A.wc);
    registry.release(sid);
    registry.removeWindow(A.wc);
    registry.removeWindow(B.wc);
  });

  await check('W2c una sesion que termina durante la mudanza: su cierre llega al destino y luego se suelta', async () => {
    const A = ventanaFalsa('A');
    const B = ventanaFalsa('B');
    registry.addWindow(A.win);
    registry.addWindow(B.win);
    const sid = 'w2c-sesion';
    registry.claim(sid, A.wc);
    const m = registry.beginMove([sid], A.wc);
    registry.sessionSink.webContents.send('ssh:data', sid, 'ultimo');
    registry.sessionSink.webContents.send('ssh:close', sid);
    registry.release(sid);
    registry.setTarget(m, B.wc, {});
    registry.adopted(m, B.wc);
    registry.commit(m, sid, B.wc);
    assert.deepStrictEqual(B.recibido.filter(([c]) => c.startsWith('ssh:')).map(([c]) => c), ['ssh:data', 'ssh:close']);
    assert.strictEqual(registry.ownerOf(sid), null, 'la sesion cerrada quedo con dueno');
    registry.removeWindow(A.wc);
    registry.removeWindow(B.wc);
  });

  await check('W8 una pestana con su sesion prestada a un panel SFTP no se muda', async () => {
    const wm = cargaWindowMove(ROOT);
    /* Pestana partida: t1 (grupo) + t2 oculta; la prestada es la del panel t2 */
    const state = {
      tabs: [{ id: 't1', type: 'terminal', sessionId: 'w8-s0' }, { id: 't2', type: 'terminal', sessionId: 'w8-s1', hidden: true }],
      layouts: { t1: { type: 'split', direction: 'horizontal', ratio: 0.5, children: [{ type: 'terminal', tabId: 't1' }, { type: 'terminal', tabId: 't2' }] } },
    };
    assert.strictEqual(wm.cannotMove(state, 't1'), null, 'sin prestamo ya no se podia mover');
    const suelta = wm.borrowSession('w8-s1');
    const otra = wm.borrowSession('w8-s1');
    assert.match(String(wm.cannotMove(state, 't1')), /SFTP/, 'una pestana con la sesion prestada se puede mover');
    suelta();
    suelta();   // idempotente: no descuenta el otro prestamo
    assert.match(String(wm.cannotMove(state, 't1')), /SFTP/, 'soltar dos veces libero el prestamo de otro panel');
    otra();
    assert.strictEqual(wm.cannotMove(state, 't1'), null, 'soltado el prestamo sigue sin poder moverse');
    /* El panel SFTP de verdad presta solo lo que no es suyo */
    const fp = require('fs').readFileSync(path.join(ROOT, 'src', 'components', 'SFTP', 'FilePane.jsx'), 'utf-8');
    assert.ok(/conn\.owned[^\n]*return undefined;\s*\n\s*return borrowSession\(conn\.sessionId\)/.test(fp),
      'FilePane no registra la sesion que toma prestada');
  });

  await check('W9 abortar quita la adopcion encolada; takeAdoptions descarta mudanzas muertas', async () => {
    const A = ventanaFalsa('A');
    const T = ventanaFalsa('T');   // ventana nueva que aun carga: no escucha
    registry.addWindow(A.win);
    registry.addWindow(T.win);
    registry.claim('w9-s', A.wc);
    const m = registry.beginMove(['w9-s'], A.wc);
    registry.setTarget(m, T.wc, { tabs: [1] });
    assert.strictEqual(registry.entryOf(T.wc).adoptions.length, 1, 'la adopcion no se encolo');
    registry.abort(m, 'cancelled');
    assert.strictEqual(registry.entryOf(T.wc).adoptions.length, 0, 'abortar dejo la adopcion encolada en el destino');
    /* Una que quedo de una mudanza ya terminada */
    registry.entryOf(T.wc).adoptions.push({ moveId: 'muerta', tabs: [1] });
    assert.deepStrictEqual(registry.takeAdoptions(T.wc), [], 'takeAdoptions entrego una mudanza que ya no existe');
    assert.strictEqual(registry.ownerOf('w9-s'), A.wc);
    registry.release('w9-s');
    registry.removeWindow(A.wc);
    registry.removeWindow(T.wc);
  });

  await check('W10 una pestana partida se muda entera o nada', async () => {
    const A = ventanaFalsa('A');
    const B = ventanaFalsa('B');
    registry.addWindow(A.win);
    registry.addWindow(B.win);
    registry.takeAdoptions(B.wc);
    registry.claim('w10-1', A.wc);
    registry.claim('w10-2', A.wc);
    const m = registry.beginMove(['w10-1', 'w10-2'], A.wc);
    registry.setTarget(m, B.wc, { tabs: [] });
    registry.adopted(m, B.wc);
    assert.ok(registry.commit(m, 'w10-1', B.wc), 'commit del primer panel rechazado');
    registry.sessionSink.webContents.send('ssh:data', 'w10-1', 'tras-listo');
    assert.strictEqual(registry.ownerOf('w10-1'), A.wc, 'un panel cambio de dueno antes que el resto de la pestana');
    assert.strictEqual(B.de('ssh:data').length, 0, 'el destino recibio datos de una mudanza a medias');
    registry.abort(m, 'timeout');
    assert.deepStrictEqual([registry.ownerOf('w10-1'), registry.ownerOf('w10-2')], [A.wc, A.wc], 'tras abortar, el destino se quedo con un panel');
    assert.deepStrictEqual(A.de('ssh:data').map(([, s, d]) => `${s}:${d}`), ['w10-1:tras-listo'], 'el bufer no volvio al origen');
    /* Y entera: los dos listos -> los dos al destino a la vez */
    const m2 = registry.beginMove(['w10-1', 'w10-2'], A.wc);
    registry.setTarget(m2, B.wc, { tabs: [] });
    registry.adopted(m2, B.wc);
    registry.commit(m2, 'w10-2', B.wc);
    registry.commit(m2, 'w10-1', B.wc);
    assert.deepStrictEqual([registry.ownerOf('w10-1'), registry.ownerOf('w10-2')], [B.wc, B.wc]);
    assert.strictEqual(A.de('window:move-done').length, 1);
    const src = require('fs').readFileSync(path.join(ROOT, 'src', 'components', 'SplitPane', 'windowMove.js'), 'utf-8');
    assert.ok(!/cannot\s+happen/.test(src), 'windowMove.js sigue diciendo que un commit parcial no puede pasar');
    registry.release('w10-1');
    registry.release('w10-2');
    registry.removeWindow(A.wc);
    registry.removeWindow(B.wc);
  });

  // ── W1/W3/W4: sesiones SSH reales contra el sshd de juguete ──
  const agente = process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AUTH_SOCK;
  const sshd = await startSshTestServer({ user: 'arnes', password: 'clave' });
  const config = { host: '127.0.0.1', port: sshd.port, username: 'arnes', password: 'clave', timeout: 10000 };
  const A = ventanaFalsa('A', { focused: true });
  const B = ventanaFalsa('B');
  ipc.attachWindow(A.win);
  ipc.attachWindow(B.win);
  const texto = (v, sid) => v.de('ssh:data').filter(([, s]) => s === sid).map(([, , d]) => d).join('');
  const espera = async (fn, ms = 5000) => {
    const fin = Date.now() + ms;
    while (Date.now() < fin) { if (fn()) return true; await sleep(10); }
    return false;
  };
  /* La primera conexion pregunta por la clave del host: se acepta desde la
     ventana a la que llego (y solo a esa). */
  const abiertas = [];   // todas, para cerrarlas al final pase lo que pase
  const conecta = async (ventana) => {
    const p = sshService.connect({ ...config }, ventana.wc);
    p.then(s => abiertas.push(s), () => {});
    const aviso = await Promise.race([
      espera(() => ventana.de('ssh:host-key-prompt').length > 0, 3000).then(() => ventana.de('ssh:host-key-prompt').slice(-1)[0]),
      p.then(() => null),
    ]);
    if (aviso && aviso[1] && hostKeyService._pending.has(aviso[1].requestId)) {
      await hostKeyService.respond(aviso[1].requestId, true);
    }
    return p;
  };
  let sA = null;
  let sB = null;
  try {
    await check('W1 una sesion SSH real: datos, cierre y aviso de host key solo a su ventana', async () => {
      sA = await conecta(A);
      assert.ok(A.de('ssh:host-key-prompt').length === 1 && B.de('ssh:host-key-prompt').length === 0,
        `aviso de host key: A=${A.de('ssh:host-key-prompt').length} B=${B.de('ssh:host-key-prompt').length}`);
      sB = await conecta(B);
      assert.strictEqual(registry.ownerOf(sA), A.wc);
      assert.strictEqual(registry.ownerOf(sB), B.wc);
      sshService.sendData(sA, 'echo de-A\r');
      sshService.sendData(sB, 'echo de-B\r');
      assert.ok(await espera(() => texto(A, sA).includes('de-A') && texto(B, sB).includes('de-B')), 'no llego el eco');
      assert.strictEqual(A.de('ssh:data').filter(([, s]) => s === sB).length, 0, 'A recibio datos de la sesion de B');
      assert.strictEqual(B.de('ssh:data').filter(([, s]) => s === sA).length, 0, 'B recibio datos de la sesion de A');
      const primaria = registry.primary();
      assert.ok(primaria && primaria.wc !== A.wc && primaria.wc !== B.wc, 'el arnes cambio de ventana primaria');
    });

    await check('W3 mudanza de una sesion SSH real a mitad de `seq 1 30000`: A + B = la salida exacta', async () => {
      const esperado = Array.from({ length: 30000 }, (_, i) => String(i + 1)).join('\r\n') + '\r\n';
      const antes = texto(A, sA).length;
      let moveId = null;
      /* Mudanza en cuanto llega el primer trozo de la salida a A */
      const sendReal = A.wc.send;
      A.wc.send = (canal, ...args) => {
        sendReal(canal, ...args);
        if (!moveId && canal === 'ssh:data' && args[0] === sA && /\d/.test(args[1])) {
          moveId = registry.beginMove([sA], A.wc);
          setTimeout(() => {
            registry.setTarget(moveId, B.wc, { tabs: [] });
            registry.adopted(moveId, B.wc);
            registry.commit(moveId, sA, B.wc);
          }, 5);
        }
      };
      try {
        sshService.sendData(sA, 'seq 1 30000\r');
        assert.ok(await espera(() => (texto(A, sA).slice(antes) + texto(B, sA)).includes('30000\r\n$ '), 8000), 'la salida no termino');
      } finally {
        A.wc.send = sendReal;
      }
      const total = texto(A, sA).slice(antes) + texto(B, sA);
      const ini = total.indexOf('1\r\n2\r\n3\r\n');
      assert.ok(ini >= 0, 'no se ve el principio de seq');
      assert.strictEqual(total.slice(ini, ini + esperado.length), esperado, 'la salida se perdio o se repitio en la mudanza');
      assert.ok(texto(B, sA).length > 0 && texto(A, sA).slice(antes).length > 0, 'la mudanza no partio el flujo en dos');
      assert.strictEqual(registry.ownerOf(sA), B.wc, 'la sesion no paso a B');
      /* Lo nuevo va directo a B */
      sshService.sendData(sA, 'echo ya-en-B\r');
      assert.ok(await espera(() => texto(B, sA).includes('ya-en-B')), 'despues de la mudanza no llega a B');
      assert.ok(!texto(A, sA).includes('ya-en-B'), 'despues de la mudanza sigue llegando a A');
    });

    await check('W4 cerrar una ventana cierra solo sus sesiones', async () => {
      /* sA ahora es de B; A se queda con una nueva */
      const sA2 = await conecta(A);
      assert.deepStrictEqual(registry.sessionsOf(A.wc), [sA2]);
      A.win.cerrar();
      assert.ok(await espera(() => !sshService.isConnected(sA2)), 'la sesion de la ventana cerrada sigue abierta');
      assert.ok(sshService.isConnected(sA) && sshService.isConnected(sB), 'cerrar A cerro sesiones de B');
      assert.strictEqual(registry.entryOf(A.wc), null, 'A sigue registrada');
    });

    await check('W5 los eventos globales llegan a todas las ventanas; store-changed a todas menos la que guarda', async () => {
      const C = ventanaFalsa('C');
      ipc.attachWindow(C.win);
      syncService._emitStatus();
      assert.ok(await espera(() => B.de('sync:status').length > 0 && C.de('sync:status').length > 0), 'sync:status no llego a todas');
      registry.broadcastSink.webContents.send('port-forward:status', { ruleId: 'x', state: 'stopped' });
      assert.ok(B.de('port-forward:status').length === 1 && C.de('port-forward:status').length === 1);
      const guarda = handlers.get('store:save-snippet');
      const r = await guarda({ sender: C.wc }, { name: 'w5', command: 'true' });
      assert.ok(r && r.success, `save-snippet fallo: ${r && r.error}`);
      assert.deepStrictEqual(B.de('window:store-changed').map(([, p]) => p.collection), ['snippets'], 'B no se entero');
      assert.strictEqual(C.de('window:store-changed').length, 0, 'la ventana que guardo recibio su propio aviso');
      await handlers.get('store:delete-snippet')({ sender: C.wc }, r.data.id);
      C.win.cerrar();
    });

    await check('W6 los canales window:* comprueban quien llama', async () => {
      const C = ventanaFalsa('C');
      ipc.attachWindow(C.win);
      const begin = await handlers.get('window:move-begin')({ sender: B.wc }, [sB]);
      assert.ok(begin.success, begin.error);
      const ajena = await handlers.get('window:move-transfer')({ sender: C.wc }, begin.data, { target: registry.entryOf(C.wc).id });
      assert.ok(!ajena.success, 'otra ventana pudo completar una mudanza que no es suya');
      const robo = await handlers.get('window:move-begin')({ sender: C.wc }, [sA]);
      assert.ok(!robo.success, 'una ventana empezo a mover una sesion de otra');
      const t = await handlers.get('window:move-transfer')({ sender: B.wc }, begin.data, { target: registry.entryOf(C.wc).id, adoption: { tabs: [1] } });
      assert.ok(t.success, t.error);
      const ad = await handlers.get('window:take-adoptions')({ sender: C.wc });
      assert.ok(ad.success && ad.data.length === 1 && ad.data[0].moveId === begin.data, 'la adopcion no espero a que C escuchara');
      const intruso = await handlers.get('window:move-ready')({ sender: B.wc }, begin.data, sB);
      assert.ok(intruso.success && intruso.data === false, 'el origen pudo confirmar en nombre del destino');
      await handlers.get('window:move-adopted')({ sender: C.wc }, begin.data);
      await handlers.get('window:move-ready')({ sender: C.wc }, begin.data, sB);
      assert.strictEqual(registry.ownerOf(sB), C.wc);
      const req = await handlers.get('window:request-move')({ sender: C.wc }, { fromWindowId: registry.entryOf(B.wc).id, tabId: 't1', index: 0 });
      assert.ok(req.success && B.de('window:move-request').length === 1, 'la peticion de mudanza no llego al origen');
      assert.strictEqual(B.de('window:move-request')[0][1].targetId, registry.entryOf(C.wc).id);
      C.win.cerrar();
      assert.ok(await espera(() => !sshService.isConnected(sB)), 'cerrar C no cerro la sesion que se le mudo');
    });

    /* Lo que llega a cualquier OTRA ventana viva mientras corre fn (la
       primaria del arnes incluida) */
    const espiaOtras = (salvo) => {
      const vistos = [];
      const restaurar = [];
      for (const e of registry.liveWindows()) {
        if (e.wc === salvo) continue;
        const orig = e.wc.send;
        e.wc.send = (canal, ...args) => { vistos.push([canal, ...args]); return orig.call(e.wc, canal, ...args); };
        restaurar.push(() => { e.wc.send = orig; });
      }
      return { vistos, fin: () => restaurar.forEach(f => f()) };
    };
    const deSesion = (vistos, sid) => vistos.filter(([c, a]) => c.startsWith('ssh:') && (a === sid || (a && a.sessionId === sid) || c === 'ssh:host-key-prompt'));

    await check('W7 cerrar una ventana con un ssh:connect pendiente: nada queda vivo ni va a otra ventana', async () => {
      /* (a) esperando el aviso de host key (sshd nuevo = clave desconocida) */
      const sshd2 = await startSshTestServer({ user: 'arnes', password: 'clave' });
      try {
        const D = ventanaFalsa('D');
        ipc.attachWindow(D.win);
        const logsAntes = new Set(connectionLogService._open);
        const p = sshService.connect({ ...config, port: sshd2.port }, D.wc);
        let error = null;
        const fin = p.then(() => null, (e) => { error = e; return e; });
        assert.ok(await espera(() => D.de('ssh:host-key-prompt').length > 0, 3000), 'D no recibio el aviso de host key');
        const [sid] = registry.sessionsOf(D.wc);
        assert.ok(sid && sshService.isPending(sid), 'la conexion de D no figura como pendiente');
        const espia = espiaOtras(D.wc);
        try {
          D.win.cerrar();
          await Promise.race([fin, sleep(3000)]);
          await sleep(50);
        } finally { espia.fin(); }
        assert.ok(error, 'la conexion de la ventana cerrada no fallo');
        assert.strictEqual(hostKeyService._pending.size, 0, 'el aviso de host key quedo abierto');
        assert.deepStrictEqual(deSesion(espia.vistos, sid).map(([c]) => c), [], 'algo de la conexion de D llego a otra ventana');
        assert.ok(!sshService.isConnected(sid) && !sshService.isPending(sid), 'la conexion sigue viva');
        assert.strictEqual(registry.ownerOf(sid), null);
        assert.deepStrictEqual([...connectionLogService._open].filter(id => !logsAntes.has(id)), [], 'quedo un registro de conexion abierto');
      } finally {
        await Promise.race([sshd2.close(), sleep(3000)]);
      }
      /* (b) la conexion se completa justo cuando la ventana ya se cerro */
      const D2 = ventanaFalsa('D2');
      ipc.attachWindow(D2.win);
      const logsAntes = new Set(connectionLogService._open);
      const set = sshService.sessions.set;
      let sid2 = null;
      sshService.sessions.set = function (k, v) {
        if (!sid2 && registry.ownerOf(k) === D2.wc) { sid2 = k; D2.win.cerrar(); }
        return set.call(this, k, v);
      };
      const espia = espiaOtras(D2.wc);
      let error = null;
      try {
        await sshService.connect({ ...config }, D2.wc).catch((e) => { error = e; });
        await sleep(50);
      } finally {
        sshService.sessions.set = set;
        espia.fin();
      }
      assert.ok(sid2, 'la conexion de D2 no llego a establecerse');
      assert.ok(error && /closed/.test(error.message), `connect no fallo tras cerrarse su ventana: ${error && error.message}`);
      assert.ok(!sshService.isConnected(sid2), 'la sesion de la ventana cerrada quedo conectada');
      assert.deepStrictEqual(deSesion(espia.vistos, sid2).map(([c]) => c), [], 'algo de la sesion de D2 llego a otra ventana');
      assert.deepStrictEqual([...connectionLogService._open].filter(id => !logsAntes.has(id)), [], 'quedo un registro de conexion abierto');
    });

    await check('W11 un aviso de host key compartido: cerrar la ventana que lo muestra lo pasa a la otra', async () => {
      const sshd3 = await startSshTestServer({ user: 'arnes', password: 'clave' });
      const cfg = { ...config, port: sshd3.port };
      let sidB = null;
      try {
        const A3 = ventanaFalsa('A3');
        ipc.attachWindow(A3.win);
        const pA = sshService.connect({ ...cfg }, A3.wc);
        let errA = null;
        pA.then((s) => abiertas.push(s), (e) => { errA = e; });
        assert.ok(await espera(() => A3.de('ssh:host-key-prompt').length > 0, 3000), 'A3 no recibio el aviso');
        const reqId = A3.de('ssh:host-key-prompt')[0][1].requestId;
        const antesB = B.de('ssh:host-key-prompt').length;
        const pB = sshService.connect({ ...cfg }, B.wc);
        let errB = null;
        const finB = pB.then((s) => { sidB = s; abiertas.push(s); }, (e) => { errB = e; });
        assert.ok(await espera(() => hostKeyService._pending.get(reqId)?.waiters.size === 2, 3000), 'la conexion de B no se unio al aviso');
        assert.strictEqual(B.de('ssh:host-key-prompt').length, antesB, 'B ya tenia su propio aviso');
        A3.win.cerrar();
        assert.ok(await espera(() => B.de('ssh:host-key-prompt').length > antesB, 2000), 'cerrar A3 no paso el aviso a B');
        const aviso = B.de('ssh:host-key-prompt').slice(-1)[0][1];
        assert.strictEqual(aviso.requestId, reqId, 'B recibio otro aviso, no el compartido');
        assert.ok(!errB, `la conexion de B fallo al cerrarse A3: ${errB && errB.message}`);
        await hostKeyService.respond(reqId, true);
        await Promise.race([finB, sleep(5000)]);
        assert.ok(sidB && sshService.isConnected(sidB), `B no conecto tras aceptar: ${errB && errB.message}`);
        assert.strictEqual(registry.ownerOf(sidB), B.wc);
        assert.ok(await espera(() => !!errA), 'la conexion de A3 (ventana cerrada) no fallo');
      } finally {
        if (sidB) await sshService.disconnect(sidB).catch(() => {});
        await Promise.race([sshd3.close(), sleep(3000)]);
      }
    });

    await check('W12 las llamadas por sesion solo desde la ventana duena (o la mudanza en curso)', async () => {
      /* sA es de B desde W3 */
      assert.strictEqual(registry.ownerOf(sA), B.wc);
      const C = ventanaFalsa('C');
      ipc.attachWindow(C.win);
      const escrito = [];
      const red = { write: localShellService.write, resize: localShellService.resize, kill: localShellService.kill, sresize: sshService.resize };
      localShellService.write = (sid, d) => escrito.push(['local:write', sid, d]);
      localShellService.resize = (sid) => escrito.push(['local:resize', sid]);
      localShellService.kill = async (sid) => { escrito.push(['local:kill', sid]); };
      sshService.resize = (sid) => escrito.push(['ssh:resize', sid]);
      try {
        const ajeno = /another window/;
        onHandlers.get('ssh:send-data')({ sender: C.wc }, sA, 'echo intruso-C\r');
        onHandlers.get('ssh:resize')({ sender: C.wc }, sA, 100, 30);
        const dis = await handlers.get('ssh:disconnect')({ sender: C.wc }, sA);
        assert.ok(!dis.success && ajeno.test(dis.error), 'otra ventana desconecto una sesion ajena');
        assert.ok(sshService.isConnected(sA));
        for (const canal of ['sftp:list', 'sftp:realpath', 'sftp:stat', 'sftp:mkdir', 'sftp:create-file', 'sftp:rename', 'sftp:delete', 'sftp:chmod', 'sftp:open-remote', 'sftp:edit-start']) {
          const r = await handlers.get(canal)({ sender: C.wc }, sA, '/tmp', 'x');
          assert.ok(!r.success && ajeno.test(r.error), `${canal} desde otra ventana no se rechazo`);
        }
        const tr = await handlers.get('sftp:transfer-start')({ sender: C.wc }, 'w12-t', { src: { kind: 'local' }, dst: { kind: 'remote', sessionId: sA }, srcPath: '/tmp', dstDir: '/tmp' });
        assert.ok(!tr.success && ajeno.test(tr.error), 'sftp:transfer-start hacia una sesion ajena no se rechazo');
        /* La duena si */
        onHandlers.get('ssh:send-data')({ sender: B.wc }, sA, 'echo propio-B\r');
        onHandlers.get('ssh:resize')({ sender: B.wc }, sA, 100, 30);
        assert.ok(await espera(() => texto(B, sA).includes('propio-B')), 'la duena no pudo escribir');
        assert.ok(!texto(B, sA).includes('intruso-C'), 'otra ventana escribio en una sesion ajena');
        const realB = await handlers.get('sftp:realpath')({ sender: B.wc }, sA, '/');
        assert.ok(realB.success || !ajeno.test(realB.error), 'la duena fue rechazada en sftp');
        /* Shell local de B */
        registry.claim('w12-pty', B.wc);
        onHandlers.get('local:write')({ sender: C.wc }, 'w12-pty', 'x');
        onHandlers.get('local:resize')({ sender: C.wc }, 'w12-pty', 80, 24);
        const k = await handlers.get('local:kill')({ sender: C.wc }, 'w12-pty');
        assert.ok(!k.success && ajeno.test(k.error), 'otra ventana mato un shell ajeno');
        onHandlers.get('local:write')({ sender: B.wc }, 'w12-pty', 'y');
        /* Mudanza en curso B -> C: los dos extremos si, un tercero no */
        const D = ventanaFalsa('D');
        ipc.attachWindow(D.win);
        const m = registry.beginMove(['w12-pty'], B.wc);
        registry.setTarget(m, C.wc, { tabs: [] });
        onHandlers.get('local:write')({ sender: B.wc }, 'w12-pty', 'origen');
        onHandlers.get('local:write')({ sender: C.wc }, 'w12-pty', 'destino');
        onHandlers.get('local:write')({ sender: D.wc }, 'w12-pty', 'tercero');
        const abD = await handlers.get('window:move-abort')({ sender: D.wc }, m);
        assert.ok(!abD.success && registry.getMove(m), 'una ventana ajena aborto la mudanza');
        const abB = await handlers.get('window:move-abort')({ sender: B.wc }, m);
        assert.ok(abB.success && !registry.getMove(m), 'el origen no pudo abortar su mudanza');
        /* Una sola ventana / sesion sin dueno (Android, arnes): se deja pasar */
        onHandlers.get('local:write')({ sender: D.wc }, 'w12-sin-dueno', 'libre');
        assert.deepStrictEqual(escrito.filter(([c]) => c !== 'ssh:resize' || true).map(([c, s2, d]) => `${c}:${s2}${d ? ':' + d : ''}`), [
          `ssh:resize:${sA}`,
          'local:write:w12-pty:y',
          'local:write:w12-pty:origen',
          'local:write:w12-pty:destino',
          'local:write:w12-sin-dueno:libre',
        ], 'las llamadas que pasaron no son las esperadas');
        registry.release('w12-pty');
        D.win.cerrar();
      } finally {
        Object.assign(localShellService, { write: red.write, resize: red.resize, kill: red.kill });
        sshService.resize = red.sresize;
        C.win.cerrar();
      }
    });
  } finally {
    for (const s of abiertas) await sshService.disconnect(s).catch(() => {});
    if (!B.win.isDestroyed()) B.win.cerrar();
    if (!A.win.isDestroyed()) A.win.cerrar();
    /* server.close() espera a que se vaya cada conexion: con un tope, para
       que una sesion que se quedo abierta ponga rojo y no cuelgue el arnes */
    await Promise.race([sshd.close(), sleep(3000)]);
    if (agente !== undefined) process.env.SSH_AUTH_SOCK = agente;
  }
}

module.exports = { seccionVentanas };
